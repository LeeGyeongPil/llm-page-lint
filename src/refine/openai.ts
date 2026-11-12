// OpenAI-compatible judge and fixer (experimental). Uses Node's built-in fetch, no SDK.
// The gate treats model output as untrusted: bad JSON means "skip this section".

import { InputError } from '../errors.js';
import { CRITERIA, FINDING_KINDS, type Criterion, type Fixer, type FixerInput, type Instruction, type Judge, type JudgeInput, type Judgement } from '../types.js';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface OpenAIConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** per-request time limit (ms, default 120000) */
  timeoutMs?: number;
  /** inject a fake fetch in tests */
  fetch?: FetchLike;
}

/** Read the LLM_PAGE_LINT_* variables. Throws InputError with a fix hint when the base URL or model is missing. */
export function configFromEnv(role: 'judge' | 'fixer', env: NodeJS.ProcessEnv = process.env): OpenAIConfig {
  const baseUrl = env.LLM_PAGE_LINT_BASE_URL;
  if (!baseUrl) {
    throw new InputError('--' + role + ' openai needs LLM_PAGE_LINT_BASE_URL, e.g. export LLM_PAGE_LINT_BASE_URL=http://localhost:11434/v1', { code: 'openai_base_url', params: { role } });
  }
  const judgeModel = env.LLM_PAGE_LINT_JUDGE_MODEL;
  const model = role === 'judge' ? judgeModel : (env.LLM_PAGE_LINT_FIXER_MODEL ?? judgeModel);
  if (!model) {
    throw new InputError('--' + role + ' openai needs ' + (role === 'judge' ? 'LLM_PAGE_LINT_JUDGE_MODEL' : 'LLM_PAGE_LINT_FIXER_MODEL (or LLM_PAGE_LINT_JUDGE_MODEL)') + ' to name the model', { code: role === 'judge' ? 'openai_model_judge' : 'openai_model_fixer' });
  }
  return { baseUrl, model, apiKey: env.LLM_PAGE_LINT_API_KEY };
}

/** POST /chat/completions and return the assistant text, or null on any transport or shape problem. */
export async function chat(cfg: OpenAIConfig, system: string, user: string): Promise<string | null> {
  const doFetch: FetchLike = cfg.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
  const body = JSON.stringify(buildRequest(cfg.model, system, user));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs ?? 120_000);
  try {
    const res = await doFetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', headers, body, signal: ctl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The request body (exported so tests can check it). */
export function buildRequest(model: string, system: string, user: string) {
  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

/** Parse a JSON object from model text (tolerates a ```json fence). Null when it is not a JSON object. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const v: unknown = JSON.parse(cleaned);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const JUDGE_SYSTEM =
  'You review one section of an HTML page. Reply with JSON only: {"scores":{"layout":0-10,"readability":0-10,"hierarchy":0-10,"spacing":0-10,"responsive":0-10,"completeness":0-10},' +
  '"instructions":[{"text":"one sentence","kind":"optional finding kind","selector":"optional css selector"}]} with at most 3 instructions. ' +
  'Measured defects are given; do not invent others.';

export class OpenAIJudge implements Judge {
  readonly name: string;
  constructor(private readonly cfg: OpenAIConfig) {
    this.name = 'openai:' + cfg.model;
  }

  async judge(input: JudgeInput): Promise<Judgement | null> {
    const user = JSON.stringify({ section: input.sectionId, html: input.sectionHtml, measuredDefects: input.findings.map((f) => ({ kind: f.kind, selector: f.selector, detail: f.detail })) });
    const text = await chat(this.cfg, JUDGE_SYSTEM, user);
    if (text === null) return null;
    return parseJudgement(text);
  }
}

/** Validate a judge reply. Null for anything that is not the expected shape (the section is then skipped). */
export function parseJudgement(text: string): Judgement | null {
  const obj = parseJsonObject(text);
  const raw = obj?.scores;
  if (!raw || typeof raw !== 'object') return null;
  const scores = {} as Record<Criterion, number>;
  for (const c of CRITERIA) {
    const v = (raw as Record<string, unknown>)[c];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10) return null;
    scores[c] = v;
  }
  const overall = Math.round((CRITERIA.reduce((s, c) => s + scores[c], 0) / CRITERIA.length) * 100) / 100;
  const instructions: Instruction[] = [];
  if (Array.isArray(obj?.instructions)) {
    for (const i of obj.instructions.slice(0, 3)) {
      if (!i || typeof i !== 'object' || typeof (i as { text?: unknown }).text !== 'string') continue;
      const r = i as { text: string; kind?: unknown; selector?: unknown };
      const ins: Instruction = { text: r.text.slice(0, 300) };
      if (typeof r.kind === 'string' && (FINDING_KINDS as readonly string[]).includes(r.kind)) ins.kind = r.kind as Instruction['kind'];
      if (typeof r.selector === 'string' && r.selector.length <= 200) ins.selector = r.selector;
      instructions.push(ins);
    }
  }
  return { scores, overall, instructions };
}

const FIXER_SYSTEM =
  'You fix ONE section of an HTML page. Reply with JSON only: {"sectionHtml":"<the complete corrected section element>"}. ' +
  'Change only this section. Prefer CSS fixes. Do not add scripts, event attributes, iframes, or external URLs.';

export class OpenAIFixer implements Fixer {
  readonly name: string;
  constructor(private readonly cfg: OpenAIConfig) {
    this.name = 'openai:' + cfg.model;
  }

  async fix(input: FixerInput): Promise<{ pageHtml: string } | null> {
    const user = JSON.stringify({ section: input.sectionId, html: input.sectionHtml, instructions: input.instructions, measuredDefects: input.findings.map((f) => ({ kind: f.kind, selector: f.selector, detail: f.detail })) });
    const text = await chat(this.cfg, FIXER_SYSTEM, user);
    if (text === null) return null;
    const obj = parseJsonObject(text);
    if (!obj || typeof obj.sectionHtml !== 'string' || !obj.sectionHtml.trim()) return null;
    return { pageHtml: input.pageHtml.slice(0, input.range[0]) + obj.sectionHtml + input.pageHtml.slice(input.range[1]) };
  }
}
