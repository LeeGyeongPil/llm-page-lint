// The refine loop: judge sections, let a fixer patch the worst ones, keep a patch only if
// the deterministic measurement agrees. The measurement has the veto; the judge only suggests.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { InputError } from '../errors.js';
import { lintDetailed } from '../lint.js';
import type { Finding, Fixer, Judge, Judgement, RefineOptions, RefineReport, SectionOutcome, SectionScore } from '../types.js';
import { MockFixer } from './fixer-mock.js';
import { MockJudge } from './judge-mock.js';
import { checkPatch, parsePage, type Section } from './sections.js';

export const MOCK_NOTE =
  'mock mode: practice mock judge and fixer. Scores are rule scores computed from the deterministic findings, not a model opinion.';

const key = (f: Finding) => f.kind + '|' + f.selector;
const toScore = (j: Judgement, findings: number): SectionScore => ({ overall: j.overall, scores: j.scores, findings });

/** Findings added by a patch, as "kind +n" text; empty when nothing new appeared and the total did not grow. */
function increase(before: Finding[], after: Finding[]): string {
  const old = new Set(before.map(key));
  const added = after.filter((f) => !old.has(key(f)));
  if (!added.length && after.length <= before.length) return '';
  const by = new Map<string, number>();
  for (const f of added) by.set(f.kind, (by.get(f.kind) ?? 0) + 1);
  const parts = [...by].map(([k, n]) => k + ' +' + n);
  return parts.length ? parts.join(', ') : 'total ' + before.length + '→' + after.length;
}

/**
 * Refine one HTML file. The input file is never modified; the result is in `refinedHtml`.
 *
 * @throws InputError when the file cannot be read, has no sections, or options are invalid.
 */
export async function refine(file: string, opts: RefineOptions = {}): Promise<RefineReport> {
  const started = Date.now();
  const minGain = opts.minGain ?? 0.5;
  const maxSections = opts.maxSections ?? 3;
  const budgetMs = (opts.budgetSeconds ?? 120) * 1000;
  const viewports = opts.viewports?.length ? opts.viewports : [1280];
  if (!Number.isFinite(minGain) || minGain < 0) throw new InputError('min-gain must be a number >= 0', { code: 'min_gain' });
  if (!Number.isInteger(maxSections) || maxSections < 1) throw new InputError('max-sections must be a whole number >= 1', { code: 'max_sections' });
  const log = opts.log ?? (() => undefined);
  const judge: Judge = opts.judge ?? new MockJudge();
  const fixer: Fixer = opts.fixer ?? new MockFixer();
  const mock = judge instanceof MockJudge && fixer instanceof MockFixer;

  let original: string;
  try {
    original = readFileSync(resolve(file), 'utf8');
  } catch {
    throw new InputError('cannot read "' + file + '": check the path', { code: 'refine_cannot_read', params: { file } });
  }
  const baseDir = dirname(resolve(file));
  const render = async (html: string): Promise<Finding[]> =>
    (await lintDetailed([{ html, baseDir }], { viewports, timeoutMs: opts.timeoutMs, changingText: false })).report.findings;

  let html = original;
  let parsed = parsePage(html);
  if (!parsed.sections.length) {
    throw new InputError('no sections found: mark sections with data-section="name" or use top-level <section>/<header>/<footer> elements', { code: 'no_sections' });
  }

  let current = await render(html);
  const findingsBefore = current.length;
  const mine = (id: string, list: Finding[]) => list.filter((f) => f.section === id);

  // judge every section once, worst first
  const first = new Map<string, { judgement: Judgement | null; score: SectionScore | null }>();
  for (const s of parsed.sections) {
    const fs = mine(s.id, current);
    const judgement = await judge.judge({ sectionId: s.id, sectionHtml: html.slice(s.start, s.end), findings: fs });
    first.set(s.id, { judgement, score: judgement ? toScore(judgement, fs.length) : null });
  }
  const order = parsed.sections.map((s) => s.id).sort((a, b) => (first.get(a)!.score?.overall ?? 11) - (first.get(b)!.score?.overall ?? 11));

  const outcomes = new Map<string, SectionOutcome>();
  let attempted = 0;
  for (const id of order) {
    const f = first.get(id)!;
    const out: SectionOutcome = { id, before: f.score, after: null, accepted: false, reason: '', note: '', instructions: f.judgement?.instructions ?? [] };
    outcomes.set(id, out);
    const fs = mine(id, current);
    if (!f.judgement) { out.reason = 'skipped (judge reply unusable)'; continue; }
    if (!fs.length) { out.reason = 'not attempted (no defects measured)'; continue; }
    if (attempted >= maxSections) { out.reason = 'not attempted (max-sections reached)'; continue; }
    if (Date.now() - started > budgetMs) { out.reason = 'not attempted (budget exhausted)'; continue; }
    attempted++;

    // section ranges move after earlier accepted patches: look it up again
    const sec: Section | undefined = parsed.sections.find((s) => s.id === id);
    if (!sec) { out.reason = 'skipped (section not found)'; continue; }
    const scope = sec.scope;
    log('fixing ' + id + ' (' + fs.length + ' defect(s))');
    const patch = await fixer.fix({ sectionId: id, sectionHtml: html.slice(sec.start, sec.end), findings: fs, pageHtml: html, range: [sec.start, sec.end], scope, instructions: out.instructions });
    if (!patch) { out.reason = 'skipped (fixer returned nothing)'; continue; }
    if (patch.pageHtml === html) { out.reason = 'skipped (patch changed nothing)'; continue; }

    const check = checkPatch(html, patch.pageHtml, sec, parsed);
    if (!check.ok) { out.reason = 'reverted (' + check.reason + ')'; continue; }

    const after = await render(patch.pageHtml);
    const grew = increase(current, after);
    if (grew) { out.reason = 'reverted (detections increased)'; out.note = grew; out.after = { overall: f.score!.overall, scores: f.score!.scores, findings: mine(id, after).length }; continue; }

    const afterFs = mine(id, after);
    const j2 = await judge.judge({ sectionId: id, sectionHtml: check.newSection, findings: afterFs });
    if (!j2) { out.reason = 'skipped (judge reply unusable after patch)'; continue; }
    out.after = toScore(j2, afterFs.length);
    const gain = Math.round((j2.overall - f.score!.overall) * 100) / 100;
    if (gain < minGain) { out.reason = 'reverted (gain ' + gain + ' below min-gain ' + minGain + ')'; continue; }

    out.accepted = true;
    out.reason = 'accepted';
    out.note = 'findings ' + fs.length + '→' + afterFs.length + ', score ' + f.score!.overall + '→' + j2.overall;
    html = patch.pageHtml;
    parsed = parsePage(html);
    current = after;
  }

  return {
    schemaVersion: 1,
    input: file,
    mode: { judge: judge.name, fixer: fixer.name, mock, note: mock ? MOCK_NOTE : 'real mode: judge ' + judge.name + ', fixer ' + fixer.name },
    viewports,
    minGain,
    seconds: Math.round(((Date.now() - started) / 1000) * 100) / 100,
    findingsBefore,
    findingsAfter: current.length,
    sections: [...outcomes.values()],
    refinedHtml: html,
  };
}
