#!/usr/bin/env node
// llm-page-lint command line.
// Exit codes: 0 no findings, 1 findings, 2 usage/run error, 3 timeout.

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BrowserMissingError, InputError, LintTimeoutError, xdgApplies } from './errors.js';
import { isLang, MESSAGES, resolveLang, t, translateRefineText, type Lang, type MessageKey } from './i18n.js';
import { VERSION, lintDetailed } from './lint.js';
import { resolveOutDir, writeOutFiles } from './output.js';
import { configFromEnv, OpenAIFixer, OpenAIJudge } from './refine/openai.js';
import { refine } from './refine/loop.js';
import { reportToHtml } from './report/html.js';
import { reportToJson } from './report/json.js';
import { FINDING_KINDS, type Finding, type FindingKind, type LintInput, type LintReport } from './types.js';
import { isFindingKind } from './validate.js';

/** Build an InputError for a CLI-side problem; `code` is a key of the message table ("err.<code>"). */
function cliError(code: string, params: Record<string, string | number> = {}): InputError {
  return new InputError(t('en', `err.${code}` as MessageKey, params), { code, params });
}

/** Convert "375,1280" to numbers, quoting the user's original text when an item is not a number. */
function parseViewports(raw: string): number[] {
  return parseList(raw).map((x) => {
    const n = Number(x);
    if (x === '' || !Number.isFinite(n)) {
      throw cliError('viewportsList', { item: x, raw });
    }
    return n;
  });
}

function parseList(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/** Expand a folder into its .html files (recursive, sorted); files and URLs pass through. */
function expandInputs(args: string[]): LintInput[] {
  const out: LintInput[] = [];
  for (const a of args) {
    if (/^https?:\/\//i.test(a)) {
      out.push({ url: a });
      continue;
    }
    let st;
    try {
      st = statSync(resolve(a));
    } catch {
      throw cliError('inputMissing', { path: a });
    }
    if (st.isDirectory()) {
      const files = (readdirSync(resolve(a), { recursive: true }) as string[])
        .filter((f) => /\.html?$/i.test(f))
        .sort()
        .map((f) => join(a, f));
      if (!files.length) throw cliError('folderEmpty', { path: a });
      for (const f of files) out.push({ file: f });
    } else {
      out.push({ file: a });
    }
  }
  return out;
}

/** Terminal columns of a string (Hangul and other wide characters take two). */
function cols(s: string): number {
  let n = 0;
  for (const ch of s) n += /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/.test(ch) ? 2 : 1;
  return n;
}
const padEndCols = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - cols(s)));
const padStartCols = (s: string, w: number): string => ' '.repeat(Math.max(0, w - cols(s))) + s;

function summary(report: LintReport, failing: Finding[], lang: Lang): string {
  const lines: string[] = [];
  const counts = new Map<FindingKind, number>();
  for (const f of report.findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  lines.push(t(lang, 'summary.checked', { pages: report.pages.length, viewports: report.viewports.join(', '), seconds: report.seconds }));
  lines.push('');
  lines.push(`${padEndCols(t(lang, 'summary.kind'), 24)}  ${padStartCols(t(lang, 'summary.count'), 5)}`);
  lines.push('------------------------  -----');
  for (const k of FINDING_KINDS) {
    const n = counts.get(k) ?? 0;
    if (n) lines.push(`${k.padEnd(24)}  ${String(n).padStart(5)}`);
  }
  if (!report.findings.length) lines.push(t(lang, 'summary.none'));
  lines.push('');
  for (const f of report.findings) {
    const d = Object.entries(f.detail).map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push(`- ${f.kind} @${f.viewport}px ${f.selector}${f.section ? ` [${f.section}]` : ''} ${d}`.trimEnd());
  }
  if (report.findings.length) lines.push('');
  lines.push(
    t(lang, 'summary.findings', { n: report.findings.length }) +
      (failing.length !== report.findings.length ? t(lang, 'summary.counted', { n: failing.length }) : ''),
  );
  if (report.rejectedFromBrowser) lines.push(t(lang, 'summary.rejected', { n: report.rejectedFromBrowser }));
  return lines.join('\n');
}

async function runRefine(args: string[], lang: Lang): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      judge: { type: 'string' },
      fixer: { type: 'string' },
      'max-sections': { type: 'string' },
      'min-gain': { type: 'string' },
      'budget-seconds': { type: 'string' },
      viewports: { type: 'string' },
      out: { type: 'string' },
      write: { type: 'boolean' },
    },
  });
  if (positionals.length !== 1) throw cliError('refineOneFile');
  const file = positionals[0];
  const num = (name: string, v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw cliError('number', { name, value: v });
    return n;
  };
  const kind = (name: string, v: string | undefined): 'mock' | 'openai' => {
    if (v === undefined || v === 'mock') return 'mock';
    if (v === 'openai') return 'openai';
    throw cliError('mockOrOpenai', { name, value: v ?? '' });
  };
  const judgeKind = kind('judge', values.judge);
  const fixerKind = kind('fixer', values.fixer);
  const outDir = resolveOutDir([file], values.out);
  const report = await refine(file, {
    judge: judgeKind === 'openai' ? new OpenAIJudge(configFromEnv('judge')) : undefined,
    fixer: fixerKind === 'openai' ? new OpenAIFixer(configFromEnv('fixer')) : undefined,
    maxSections: num('max-sections', values['max-sections']),
    minGain: num('min-gain', values['min-gain']),
    budgetSeconds: num('budget-seconds', values['budget-seconds']),
    viewports: values.viewports !== undefined ? parseViewports(values.viewports) : undefined,
    log: (l) => console.error(translateRefineText(lang, l)),
  });
  const { refinedHtml, ...meta } = report;
  writeOutFiles(outDir, { 'refine.json': JSON.stringify(meta, null, 2) + '\n', 'refined.html': refinedHtml });
  if (values.write) writeFileSync(resolve(file), refinedHtml);

  const note = translateRefineText(lang, report.mode.note);
  console.log(t(lang, report.mode.mock ? 'refine.mockMode' : 'refine.realMode', { note }));
  console.log(t(lang, 'refine.result', { file, before: report.findingsBefore, after: report.findingsAfter, seconds: report.seconds }));
  console.log('');
  console.log(`${padEndCols(t(lang, 'refine.section'), 13)}  ${t(lang, 'refine.outcome')}`);
  console.log('-------------  ------------------------------------------');
  for (const sec of report.sections) {
    const extra = sec.note ? ` [${translateRefineText(lang, sec.note)}]` : '';
    console.log(`${sec.id.padEnd(13)}  ${translateRefineText(lang, sec.reason)}${extra}`);
  }
  console.log('');
  console.log(t(lang, 'refine.report', { path: join(outDir, 'refined.html'), state: t(lang, values.write ? 'refine.overwritten' : 'refine.unchanged') }));
  return 0;
}

async function runCheck(args: string[], demo: boolean, lang: Lang): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      viewports: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
      'fail-on': { type: 'string' },
      ignore: { type: 'string', multiple: true },
      timeout: { type: 'string' },
      'no-changing-text': { type: 'boolean' },
    },
  });

  let inputs: LintInput[];
  let viewports: number[] | undefined;
  if (demo) {
    inputs = [{ file: fileURLToPath(new URL('../fixtures/defects.html', import.meta.url)) }];
    viewports = [1024];
  } else {
    if (!positionals.length) throw cliError('checkNeedsInput');
    inputs = expandInputs(positionals);
    if (values.viewports !== undefined) {
      viewports = parseViewports(values.viewports);
    }
  }

  let failOn: Set<FindingKind> | null = null;
  if (values['fail-on'] !== undefined) {
    const kinds = parseList(values['fail-on']);
    const bad = kinds.filter((k) => !isFindingKind(k));
    if (bad.length) throw cliError('failOn', { bad: bad.join(', '), valid: FINDING_KINDS.join(', ') });
    failOn = new Set(kinds as FindingKind[]);
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = Number(values.timeout);
    if (!Number.isFinite(timeoutMs)) throw cliError('timeoutNumber', { value: values.timeout });
    if (timeoutMs < 1000 || timeoutMs > 2147483647) throw cliError('timeoutCli', { value: values.timeout });
  }

  // 경로만 정하고(--out 이 파일이면 여기서 오류), 폴더는 실행이 성공한 뒤에 만든다.
  const outDir = resolveOutDir(
    inputs.map((i) => ('file' in i ? i.file : 'url' in i ? i.url : 'page')),
    values.out,
  );
  const { report, shots } = await lintDetailed(inputs, {
    viewports,
    timeoutMs,
    ignore: values.ignore,
    changingText: !values['no-changing-text'],
    screenshots: true,
  });
  writeOutFiles(outDir, { 'report.json': reportToJson(report), 'report.html': reportToHtml(report, shots, lang) });

  const failing = failOn ? report.findings.filter((f) => failOn.has(f.kind)) : report.findings;
  if (values.json) {
    process.stdout.write(reportToJson(report));
  } else {
    console.log(summary(report, failing, lang));
    if (demo) {
      console.log('');
      console.log(t(lang, 'summary.demo', { code: failing.length ? 1 : 0 }));
    }
    console.log(t(lang, 'summary.report', { path: join(outDir, 'report.html') }));
  }
  if (demo) return 0;
  return failing.length ? 1 : 0;
}

/** Take the global --lang option out of argv (before any sub-command parses its own options). */
function extractLang(argv: string[]): { rest: string[]; argLang?: string; missing: boolean } {
  const rest: string[] = [];
  let argLang: string | undefined;
  let missing = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (a.startsWith('--lang=')) {
      argLang = a.slice('--lang='.length);
    } else if (a === '--lang') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) missing = true;
      else {
        argLang = next;
        i++;
      }
    } else {
      rest.push(a);
    }
  }
  return { rest, argLang, missing };
}

/** The message of an error in the screen language; unknown errors keep their original text. */
function localizeError(e: unknown, lang: Lang): string {
  if (e instanceof LintTimeoutError) return t(lang, 'err.timeout', { ms: e.timeoutMs });
  if (e instanceof BrowserMissingError) {
    const xdg = process.env.XDG_CACHE_HOME ?? '';
    return t(lang, 'err.browserMissing') + (xdgApplies(process.env, process.platform) ? t(lang, 'err.browserXdg', { xdg }) : '');
  }
  if (e instanceof InputError) {
    const key = `err.${e.code ?? ''}` as MessageKey;
    return e.code && key in MESSAGES.en ? t(lang, key, e.params ?? {}) : e.message;
  }
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string } | null)?.code;
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const m = /Unknown option '([^']+)'/.exec(msg);
    if (m) return t(lang, 'err.unknownOption', { option: m[1] });
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    const m = /Option '([^']+)' argument (?:missing|is ambiguous)/.exec(msg);
    if (m) return t(lang, 'err.optionValueMissing', { option: m[1] });
    const n = /Option '([^']+)' does not take an argument/.exec(msg);
    if (n) return t(lang, 'err.optionNoValue', { option: n[1] });
  }
  const lim = /^detector returned (\d+) findings \(limit (\d+)\)/.exec(msg);
  if (lim) return t(lang, 'err.detectorLimit', { count: lim[1], limit: lim[2] });
  return msg;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let lang = resolveLang({ env }); // errors about --lang itself are printed in the language the environment picks
  try {
    const { rest, argLang, missing } = extractLang(argv);
    if (missing) throw cliError('langMissing');
    if (argLang !== undefined && !isLang(argLang)) throw cliError('langInvalid', { value: argLang });
    lang = resolveLang({ argLang, env });
    return await dispatch(rest, lang);
  } catch (e) {
    console.error(`${t(lang, 'error.prefix')} ${localizeError(e, lang)}`);
    return e instanceof LintTimeoutError ? 3 : 2;
  }
}

async function dispatch(argv: string[], lang: Lang): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(t(lang, 'help', { version: VERSION, kinds: FINDING_KINDS.join(', ') }));
    return cmd ? 0 : 2;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return 0;
  }
  if (cmd === 'check') return runCheck(rest, false, lang);
  if (cmd === 'demo') return runCheck(rest, true, lang);
  if (cmd === 'refine') return runRefine(rest, lang);
  throw cliError('unknownCommand', { cmd });
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
