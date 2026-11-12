// Screen language (English / Korean): message tables, language choice, CLI and report.html output.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, runCli, tmp } from './helpers.mjs';
import { InputError, LintTimeoutError, lint } from '../dist/index.js';
import { MESSAGES, resolveLang, t, translateRefineText } from '../dist/i18n.js';
import { MOCK_NOTE } from '../dist/refine/loop.js';

const HANGUL = /[가-힣]/;
const ONE = ['--viewports', '1024'];

test('en and ko message tables have the same keys and the same placeholders', () => {
  const en = Object.keys(MESSAGES.en).sort();
  const ko = Object.keys(MESSAGES.ko).sort();
  assert.deepEqual(ko, en);
  const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const key of en) {
    assert.ok(MESSAGES.en[key].trim() && MESSAGES.ko[key].trim(), `${key} is not empty`);
    assert.equal(holes(MESSAGES.ko[key]), holes(MESSAGES.en[key]), `${key} placeholders`);
  }
});

test('Korean sentences never use a placeholder-style particle', () => {
  for (const [key, text] of Object.entries(MESSAGES.ko)) {
    assert.doesNotMatch(text, /[이을는은가를]\(|\)[이을는은가를]/, key);
    assert.doesNotMatch(text, /\}(은|는|이|가|을|를|과|와)(?![가-힣])/, `${key}: particle right after a placeholder`);
  }
});

test('English table text matches the library exception messages', () => {
  const e = new InputError('x', { code: 'min_gain' });
  assert.equal(e.code, 'min_gain');
  assert.equal(new InputError('plain').code, undefined);
  assert.equal(t('en', 'err.timeout', { ms: 2000 }), new LintTimeoutError(2000).message);
  assert.equal(translateRefineText('en', 'accepted'), 'accepted');
  assert.equal(t('en', 'note.mock'), MOCK_NOTE);
});

test('resolveLang priority: --lang > LLM_PAGE_LINT_LANG > LC_ALL > LC_MESSAGES > LANG', () => {
  const env = { LLM_PAGE_LINT_LANG: 'en', LC_ALL: 'ko_KR.UTF-8', LC_MESSAGES: 'en_US', LANG: 'en_US' };
  assert.equal(resolveLang({ argLang: 'ko', env: { LLM_PAGE_LINT_LANG: 'en' } }), 'ko');
  assert.equal(resolveLang({ argLang: 'en', env: { LANG: 'ko_KR.UTF-8' } }), 'en');
  assert.equal(resolveLang({ env }), 'en'); // tool variable beats LC_ALL
  assert.equal(resolveLang({ env: { LC_ALL: 'ko_KR.UTF-8', LC_MESSAGES: 'en_US', LANG: 'en_US' } }), 'ko');
  assert.equal(resolveLang({ env: { LC_ALL: 'en_US', LC_MESSAGES: 'ko_KR', LANG: 'ko_KR' } }), 'en');
  assert.equal(resolveLang({ env: { LC_MESSAGES: 'ko_KR', LANG: 'en_US' } }), 'ko');
  assert.equal(resolveLang({ env: { LANG: 'ko_KR.UTF-8' } }), 'ko');
  assert.equal(resolveLang({ env: { LANG: 'ko-KR' } }), 'ko');
  assert.equal(resolveLang({ env: { LANG: 'ko' } }), 'ko');
  assert.equal(resolveLang({ env: { LANG: 'fr_FR.UTF-8' } }), 'en');
  assert.equal(resolveLang({ env: { LANG: 'C' } }), 'en');
  assert.equal(resolveLang({ env: { LC_ALL: 'POSIX', LANG: 'ko_KR' } }), 'en');
  assert.equal(resolveLang({ env: { LC_ALL: '', LANG: '' } }), 'en');
  assert.equal(resolveLang({ env: {} }), 'en');
  // an invalid tool variable is skipped, not an error
  assert.equal(resolveLang({ env: { LLM_PAGE_LINT_LANG: 'fr', LANG: 'ko_KR' } }), 'ko');
  assert.equal(resolveLang({ env: { LLM_PAGE_LINT_LANG: 'korean', LANG: 'en_US' } }), 'en');
  assert.equal(resolveLang({ env: { LLM_PAGE_LINT_LANG: 'ko_KR.UTF-8' } }), 'ko');
});

test('CLI --help switches language by flag, by environment, and --lang beats the environment', () => {
  const ko = runCli(['--help', '--lang', 'ko']);
  assert.equal(ko.status, 0);
  assert.match(ko.stdout, /사용법/);
  assert.match(ko.stdout, /--lang <en\|ko>/);
  const en = runCli(['--help']);
  assert.match(en.stdout, /Usage:/);
  assert.doesNotMatch(en.stdout, HANGUL);
  assert.match(en.stdout, /--lang <en\|ko>/);

  const envKo = runCli(['--help'], { LLM_PAGE_LINT_LANG: '', LANG: 'ko_KR.UTF-8' });
  assert.match(envKo.stdout, /사용법/);
  const flagWins = runCli(['--help', '--lang', 'en'], { LLM_PAGE_LINT_LANG: '', LANG: 'ko_KR.UTF-8' });
  assert.match(flagWins.stdout, /Usage:/);
  const eq = runCli(['--lang=ko', '--help']);
  assert.match(eq.stdout, /사용법/);
});

test('--lang works after the sub-command too', () => {
  const out = tmp('i18n-after');
  const r = runCli(['check', fixture('clean.html'), ...ONE, '--out', out, '--lang', 'ko']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /검사했습니다/);
  assert.match(r.stdout, /결함 0개/);
  assert.match(r.stdout, /보고서:/);
});

test('same input gives the same exit code and byte-identical --json in en and ko', () => {
  const run = (lang) => runCli(['check', fixture('defects.html'), ...ONE, '--json', '--lang', lang, '--out', tmp(`i18n-json-${lang}`)]);
  const a = run('en');
  const b = run('ko');
  assert.equal(a.status, 1, a.stderr);
  assert.equal(b.status, a.status);
  const strip = (s) => JSON.parse(s).findings.length;
  assert.equal(strip(a.stdout), strip(b.stdout));
  assert.equal(b.stdout.replace(/"seconds": [\d.]+/g, ''), a.stdout.replace(/"seconds": [\d.]+/g, ''));
});

test('check summary and demo text are Korean, kind IDs stay as they are', () => {
  const r = runCli(['demo', '--lang', 'ko']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /종류\s+개수/);
  assert.match(r.stdout, /결함 \d+개/);
  assert.match(r.stdout, /데모 전용/);
  assert.match(r.stdout, /보고서: /);
  assert.match(r.stdout, /overlap|clipped|off-screen|low-contrast/, 'finding kind IDs are not translated');
  const en = runCli(['demo']);
  assert.match(en.stdout, /demo only/);
});

test('library errors are printed in Korean by the CLI and keep exit code 2', () => {
  const cases = [
    [['check', fixture('clean.html'), '--timeout', '5', '--lang', 'ko'], /timeout/, /1000/],
    [['check', join(tmp('i18n-missing'), 'nope.html'), '--lang', 'ko'], /경로가 없습니다/, null],
    [['check', fixture('clean.html'), ...ONE, '--ignore', '[', '--out', tmp('i18n-sel'), '--lang', 'ko'], /--ignore/, /선택자/],
    [['check', fixture('clean.html'), '--viewports', '12', '--lang', 'ko'], /뷰포트/, /200/],
    [['check', fixture('clean.html'), '--out', fixture('clean.html'), '--lang', 'ko'], /폴더/, null],
    [['refine', fixture('clean.html'), '--min-gain=-1', '--lang', 'ko'], /min-gain/, /0 이상/],
    [['refine', fixture('refine-demo.html'), '--judge', 'openai', '--lang', 'ko'], /LLM_PAGE_LINT_BASE_URL/, /설정이 필요합니다/],
  ];
  for (const [args, a, b] of cases) {
    const r = runCli(args, { LLM_PAGE_LINT_BASE_URL: '' });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^오류:/, r.stderr);
    assert.match(r.stderr, a, r.stderr);
    if (b) assert.match(r.stderr, b, r.stderr);
    assert.match(r.stderr, HANGUL, r.stderr);
    assert.equal(r.stderr.trim().split('\n').filter((l) => /^(오류|error):/.test(l)).length, 1);
  }
});

test('timeout and missing-browser errors are localized (exit codes 3 and 2 unchanged)', () => {
  const r = runCli(['check', fixture('hang.html'), '--timeout', '2000', '--out', tmp('i18n-hang'), '--lang', 'ko']);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /^오류: .*시간 초과/);

  const noBrowser = runCli(['check', fixture('clean.html'), ...ONE, '--out', tmp('i18n-nobrowser'), '--lang', 'ko'], {
    PLAYWRIGHT_BROWSERS_PATH: tmp('i18n-empty-browsers'),
  });
  assert.equal(noBrowser.status, 2, noBrowser.stderr);
  assert.match(noBrowser.stderr, /Chromium/);
  assert.match(noBrowser.stderr, /설치되어 있지 않습니다/);
  assert.match(noBrowser.stderr, /npx playwright install chromium --only-shell/);
});

test('invalid --lang exits 2 with one error line and no usage dump; env-picked language is used', () => {
  const r = runCli(['check', fixture('clean.html'), '--lang', 'fr']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^error: .*--lang.*"fr"/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.equal(r.stdout, '');

  const ko = runCli(['check', '--lang=xx'], { LLM_PAGE_LINT_LANG: 'ko' });
  assert.equal(ko.status, 2);
  assert.match(ko.stderr, /^오류: /);
  assert.equal(ko.stderr.trim().split('\n').length, 1);

  const missing = runCli(['--lang']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--lang/);
  assert.equal(missing.stderr.trim().split('\n').length, 1);

  // an invalid LLM_PAGE_LINT_LANG is skipped silently
  const skipped = runCli(['--help'], { LLM_PAGE_LINT_LANG: 'zz', LANG: 'ko_KR.UTF-8' });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /사용법/);
});

test('option parser errors are localized', () => {
  const r = runCli(['check', '--bogus', '--lang', 'ko']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^오류: .*--bogus/);
  assert.match(r.stderr, HANGUL);
  for (const flag of ['--json=1', '--json=true']) {
    const ko = runCli(['check', fixture('clean.html'), flag, '--lang', 'ko']);
    assert.equal(ko.status, 2);
    assert.match(ko.stderr, HANGUL);
    assert.doesNotMatch(ko.stderr, /does not take an argument/);
    const en = runCli(['check', fixture('clean.html'), flag, '--lang', 'en']);
    assert.equal(en.status, 2);
    assert.match(en.stderr, /does not take a value: run llm-page-lint --help/);
  }
  const unknown = runCli(['frobnicate', '--lang', 'ko']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /frobnicate/);
  assert.match(unknown.stderr, HANGUL);
});

test('ko report.html has lang="ko" and Korean labels; en stays English; data is not translated', () => {
  const koDir = tmp('i18n-html-ko');
  const enDir = tmp('i18n-html-en');
  runCli(['check', fixture('defects.html'), ...ONE, '--out', koDir, '--lang', 'ko']);
  runCli(['check', fixture('defects.html'), ...ONE, '--out', enDir, '--lang', 'en']);
  const ko = readFileSync(join(koDir, 'report.html'), 'utf8');
  const en = readFileSync(join(enDir, 'report.html'), 'utf8');
  assert.match(ko, /<html lang="ko">/);
  assert.match(ko, /<th>종류<\/th><th>뷰포트<\/th><th>섹션<\/th><th>선택자<\/th><th>상세<\/th>/);
  assert.match(ko, /결함 \d+개/);
  assert.match(en, /<html lang="en">/);
  assert.match(en, /<th>kind<\/th><th>viewport<\/th>/);
  assert.doesNotMatch(en, HANGUL);
  // machine files do not depend on the language
  const koJson = JSON.parse(readFileSync(join(koDir, 'report.json'), 'utf8'));
  const enJson = JSON.parse(readFileSync(join(enDir, 'report.json'), 'utf8'));
  assert.deepEqual(koJson.findings, enJson.findings);
  assert.deepEqual(koJson.pages, enJson.pages);
});

test('refine screen is Korean on request while refine.json keeps English reasons', () => {
  const out = tmp('i18n-refine');
  const r = runCli(['refine', fixture('refine-demo.html'), '--viewports', '1024', '--out', out, '--lang', 'ko']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.split('\n')[0], /목 모드/);
  assert.match(r.stdout, /clip\s+채택/);
  assert.match(r.stdout, /overlap\s+되돌림 \(검출 증가\)/);
  assert.match(r.stdout, /입력 파일 상태: 그대로/);
  assert.match(r.stderr, /수정 중/);
  const meta = JSON.parse(readFileSync(join(out, 'refine.json'), 'utf8'));
  assert.ok(meta.sections.some((s) => s.reason === 'accepted'), 'refine.json stays English');
  assert.equal(meta.mode.note, MOCK_NOTE);
});

test('refine reason translation covers the known phrases and leaves unknown text alone', () => {
  const k = (s) => translateRefineText('ko', s);
  assert.match(k('reverted (gain 0.2 below min-gain 0.5)'), /0\.2.*0\.5/);
  assert.match(k('reverted (unsafe content added: <script>)'), /<script>/);
  assert.match(k('reverted (unsafe content added: new external URL)'), /외부/);
  assert.match(k('reverted (parse errors increased)'), HANGUL);
  assert.match(k('findings 3→1, score 4→7'), /3→1.*4→7/);
  assert.match(k('total 2→3'), /2→3/);
  assert.equal(k('a brand new reason'), 'a brand new reason');
  assert.equal(k(''), '');
  assert.equal(k('overlap +1'), 'overlap +1');
  // every fixed English phrase of the loop has a table entry
  const loop = readFileSync(new URL('../src/refine/loop.ts', import.meta.url), 'utf8');
  for (const m of loop.matchAll(/out\.reason = '([^']+)'/g)) {
    if (/[( ]$/.test(m[1])) continue; // "reverted (" + reason is built from the check reasons below
    assert.notEqual(k(m[1]), m[1], `no translation for: ${m[1]}`);
  }
});

test('library API stays English and language-independent', async () => {
  await assert.rejects(lint({ file: join(tmp('i18n-api'), 'nope.html') }, { viewports: [1024] }), (e) => {
    assert.ok(e instanceof InputError);
    assert.equal(e.code, 'cannot_read');
    assert.match(e.message, /^cannot read ".*nope\.html"/);
    assert.doesNotMatch(e.message, HANGUL);
    return true;
  });
});
