#!/usr/bin/env node
// llm-page-lint command line.
// Exit codes: 0 no findings, 1 findings, 2 usage/run error, 3 timeout.

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { InputError, LintTimeoutError } from './errors.js';
import { VERSION, lintDetailed } from './lint.js';
import { resolveOutDir, writeOutFiles } from './output.js';
import { configFromEnv, OpenAIFixer, OpenAIJudge } from './refine/openai.js';
import { refine } from './refine/loop.js';
import { reportToHtml } from './report/html.js';
import { reportToJson } from './report/json.js';
import { FINDING_KINDS, type Finding, type FindingKind, type LintInput, type LintReport } from './types.js';
import { isFindingKind } from './validate.js';

const HELP = `llm-page-lint ${VERSION} — find visual defects in LLM-generated HTML without reference images

Usage:
  llm-page-lint check <input...> [options]   input = .html file, folder of .html files, or http(s) URL
  llm-page-lint refine <file.html> [options] fix the worst sections with a judge + fixer, keep only what measures better
  llm-page-lint demo                         check the bundled defect fixture (always exits 0)
  llm-page-lint --version | --help

check options:
  --viewports <list>     comma-separated widths in px (default 375,768,1280)
  --out <dir>            write report.json and report.html here (default: XDG cache, see last output line)
  --json                 print the JSON report to stdout instead of the summary
  --fail-on <kinds>      only these finding kinds cause exit code 1 (comma-separated); others are warnings
  --ignore <selector>    skip elements matching this CSS selector (repeatable)
  --timeout <ms>         whole-run time limit (default 60000); exceeded => exit code 3
  --no-changing-text     skip the 1.2 s double-read for self-changing text

refine options:
  --judge mock|openai    default mock (practice rule scorer, no model); openai needs LLM_PAGE_LINT_BASE_URL
  --fixer mock|openai    default mock (practice CSS prescriptions)
  --max-sections <n>     sections to try (default 3)
  --min-gain <x>         minimum score gain to keep a patch (default 0.5)
  --budget-seconds <n>   total budget (default 120); remaining sections stay as they are
  --viewports <list>     widths to measure (default 1280)
  --out <dir>            write refine.json and refined.html here (default: XDG cache)
  --write                also overwrite the input file with the refined HTML

finding kinds: ${FINDING_KINDS.join(', ')}
exit codes: 0 no findings, 1 findings, 2 usage or run error, 3 timeout
`;

/** Convert "375,1280" to numbers, quoting the user's original text when an item is not a number. */
function parseViewports(raw: string): number[] {
  return parseList(raw).map((x) => {
    const n = Number(x);
    if (x === '' || !Number.isFinite(n)) {
      throw new InputError(`invalid viewport width "${x}" in --viewports "${raw}": use whole numbers between 200 and 4000, e.g. --viewports 375,1280`);
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
      throw new InputError(`"${a}" does not exist: pass an .html file, a folder, or an http(s) URL`);
    }
    if (st.isDirectory()) {
      const files = (readdirSync(resolve(a), { recursive: true }) as string[])
        .filter((f) => /\.html?$/i.test(f))
        .sort()
        .map((f) => join(a, f));
      if (!files.length) throw new InputError(`folder "${a}" contains no .html files`);
      for (const f of files) out.push({ file: f });
    } else {
      out.push({ file: a });
    }
  }
  return out;
}

function summary(report: LintReport, failing: Finding[]): string {
  const lines: string[] = [];
  const counts = new Map<FindingKind, number>();
  for (const f of report.findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  lines.push(`checked ${report.pages.length} page render(s) at ${report.viewports.join(', ')}px in ${report.seconds}s`);
  lines.push('');
  lines.push('kind                      count');
  lines.push('------------------------  -----');
  for (const k of FINDING_KINDS) {
    const n = counts.get(k) ?? 0;
    if (n) lines.push(`${k.padEnd(24)}  ${String(n).padStart(5)}`);
  }
  if (!report.findings.length) lines.push('(none)');
  lines.push('');
  for (const f of report.findings) {
    const d = Object.entries(f.detail).map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push(`- ${f.kind} @${f.viewport}px ${f.selector}${f.section ? ` [${f.section}]` : ''} ${d}`.trimEnd());
  }
  if (report.findings.length) lines.push('');
  lines.push(`${report.findings.length} findings` + (failing.length !== report.findings.length ? ` (${failing.length} count toward the exit code)` : ''));
  if (report.rejectedFromBrowser) lines.push(`rejected from browser: ${report.rejectedFromBrowser} item(s) failed parent-side validation`);
  return lines.join('\n');
}

async function runRefine(args: string[]): Promise<number> {
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
  if (positionals.length !== 1) throw new InputError('refine needs exactly one .html file, e.g. llm-page-lint refine page.html');
  const file = positionals[0];
  const num = (name: string, v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new InputError(`--${name} must be a number, got "${v}"`);
    return n;
  };
  const kind = (name: string, v: string | undefined): 'mock' | 'openai' => {
    if (v === undefined || v === 'mock') return 'mock';
    if (v === 'openai') return 'openai';
    throw new InputError(`--${name} must be mock or openai, got "${v}"`);
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
    log: (l) => console.error(l),
  });
  const { refinedHtml, ...meta } = report;
  writeOutFiles(outDir, { 'refine.json': JSON.stringify(meta, null, 2) + '\n', 'refined.html': refinedHtml });
  if (values.write) writeFileSync(resolve(file), refinedHtml);

  console.log(report.mode.mock ? `[${report.mode.note}]` : `[${report.mode.note}] (experimental)`);
  console.log(`refined ${file}: ${report.findingsBefore} -> ${report.findingsAfter} findings in ${report.seconds}s`);
  console.log('');
  console.log('section        result');
  console.log('-------------  ------------------------------------------');
  for (const s of report.sections) {
    console.log(`${s.id.padEnd(13)}  ${s.reason}${s.note ? ` [${s.note}]` : ''}`);
  }
  console.log('');
  console.log(`report: ${join(outDir, 'refined.html')} (input file ${values.write ? 'overwritten (--write)' : 'unchanged'})`);
  return 0;
}

async function runCheck(args: string[], demo: boolean): Promise<number> {
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
    if (!positionals.length) throw new InputError('check needs at least one input, e.g. llm-page-lint check page.html');
    inputs = expandInputs(positionals);
    if (values.viewports !== undefined) {
      viewports = parseViewports(values.viewports);
    }
  }

  let failOn: Set<FindingKind> | null = null;
  if (values['fail-on'] !== undefined) {
    const kinds = parseList(values['fail-on']);
    const bad = kinds.filter((k) => !isFindingKind(k));
    if (bad.length) throw new InputError(`unknown finding kind(s) in --fail-on: ${bad.join(', ')}. valid: ${FINDING_KINDS.join(', ')}`);
    failOn = new Set(kinds as FindingKind[]);
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = Number(values.timeout);
    if (!Number.isFinite(timeoutMs)) throw new InputError(`--timeout must be a number of milliseconds, got "${values.timeout}"`);
    if (timeoutMs < 1000) throw new InputError(`--timeout must be at least 1000 ms, got "${values.timeout}"`);
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
  writeOutFiles(outDir, { 'report.json': reportToJson(report), 'report.html': reportToHtml(report, shots) });

  const failing = failOn ? report.findings.filter((f) => failOn.has(f.kind)) : report.findings;
  if (values.json) {
    process.stdout.write(reportToJson(report));
  } else {
    console.log(summary(report, failing));
    if (demo) {
      console.log('');
      console.log(`demo only: a real "check" on this page would exit with code ${failing.length ? 1 : 0}`);
    }
    console.log(`report: ${join(outDir, 'report.html')}`);
  }
  if (demo) return 0;
  return failing.length ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP);
    return cmd ? 0 : 2;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return 0;
  }
  if (cmd === 'check') return runCheck(rest, false);
  if (cmd === 'demo') return runCheck(rest, true);
  if (cmd === 'refine') return runRefine(rest);
  throw new InputError(`unknown command "${cmd}": use check, refine, demo, --help`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof LintTimeoutError) {
      console.error(`error: ${e.message}`);
      process.exitCode = 3;
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`error: ${msg}`);
    process.exitCode = 2;
  },
);
