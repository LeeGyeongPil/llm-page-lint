// AC-5, AC-6, AC-9 (demo) and error paths.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ROOT, fixture, playwrightBrowsersPath, runCli, tmp } from './helpers.mjs';
import { LintTimeoutError, lint } from '../dist/index.js';

// Regression (CI on Linux): runCli moves XDG_CACHE_HOME to a temp folder, and on Linux Playwright looks for
// browsers under $XDG_CACHE_HOME/ms-playwright — every CLI run then said "Chromium is not installed" (exit 2).
test('CLI tests see the same Playwright browser folder as an install', () => {
  // the helper's path must be exactly where `playwright install` puts the headless shell in this environment
  const dry = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'playwright', 'cli.js'), 'install', '--dry-run', '--only-shell', 'chromium'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(dry.status, 0, dry.stderr);
  const location = /Install location:\s+(\S.*)/.exec(dry.stdout);
  assert.ok(location, dry.stdout);
  assert.equal(playwrightBrowsersPath(), dirname(location[1].trim()));

  // the Linux rule the helper copies (it cannot be observed on macOS/Windows, so it is pinned here)
  assert.equal(playwrightBrowsersPath({ XDG_CACHE_HOME: '/x' }, 'linux'), join('/x', 'ms-playwright'));
  assert.equal(playwrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: '/pw', XDG_CACHE_HOME: '/x' }, 'linux'), '/pw');

  // and a CLI run with a moved XDG cache still finds Chromium
  const r = runCli(['check', fixture('clean.html'), '--viewports', '1024', '--out', tmp('xdgbrowser')], { XDG_CACHE_HOME: tmp('xdgmoved') });
  assert.equal(r.status, 0, r.stderr);
});

test('timeout exits with code 3 and closes the browser', async () => {
  const started = Date.now();
  const r = runCli(['check', fixture('hang.html'), '--timeout', '2000', '--out', tmp('hang')]);
  assert.equal(r.status, 3, r.stderr);
  assert.ok(Date.now() - started < 10_000, 'must stop within 10 s');
  assert.match(r.stderr, /timed out/);

  // API level: the browser handed to onBrowser is disconnected after the error.
  let browser;
  await assert.rejects(
    lint({ file: fixture('hang.html') }, { viewports: [1024], timeoutMs: 2000, onBrowser: (b) => (browser = b) }),
    LintTimeoutError,
  );
  assert.ok(browser, 'onBrowser was called');
  assert.equal(browser.isConnected(), false);
});

test('default output goes to XDG cache and report.html is self-contained', () => {
  const cache = tmp('xdg');
  const cwd = tmp('cwd');
  const input = tmp('input');
  const html = join(input, 'page.html');
  const src = readFileSync(fixture('defects.html'));
  // copy the input to its own folder so we can check nothing is created next to it
  writeFileSync(html, src);
  const before = readdirSync(input);
  const r = runCli(['check', html, '--viewports', '1024'], { XDG_CACHE_HOME: cache, __cwd: cwd });
  assert.equal(r.status, 1, r.stderr);

  assert.deepEqual(readdirSync(cwd), [], 'nothing written to the current folder');
  assert.deepEqual(readdirSync(input), before, 'nothing written next to the input');

  const runs = join(cache, 'llm-page-lint', 'runs');
  const dirs = readdirSync(runs);
  assert.equal(dirs.length, 1);
  assert.deepEqual(readdirSync(join(runs, dirs[0])).sort(), ['report.html', 'report.json']);
  assert.ok(r.stdout.trimEnd().split('\n').at(-1).includes(join(runs, dirs[0], 'report.html')), 'last line shows the report path');

  const json = JSON.parse(readFileSync(join(runs, dirs[0], 'report.json'), 'utf8'));
  assert.equal(json.schemaVersion, 1);
  for (const key of ['findings', 'rejectedFromBrowser', 'viewports', 'seconds']) assert.ok(key in json, key);
  assert.equal(json.findings.length, 8);

  const page = readFileSync(join(runs, dirs[0], 'report.html'), 'utf8');
  const refs = [...page.matchAll(/(?:src|href)="([^"]*)"|url\(([^)]*)\)/g)].map((m) => m[1] ?? m[2]);
  for (const ref of refs) {
    assert.ok(ref.startsWith('data:') || ref.startsWith('#'), `external reference in report.html: ${ref.slice(0, 60)}`);
  }
  assert.ok(!/<script/i.test(page), 'no scripts in report.html');
  assert.ok(page.includes('data:image/jpeg;base64,'), 'screenshot embedded');
});

test('--json prints only the JSON report', () => {
  const r = runCli(['check', fixture('clean.html'), '--viewports', '1024', '--json', '--out', tmp('json')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).findings.length, 0);
});

test('demo prints summary, hint and report path, and exits 0', () => {
  const r = runCli(['demo'], { XDG_CACHE_HOME: tmp('demo') });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /8 findings/);
  assert.match(r.stdout, /would exit with code 1/);
  assert.match(r.stdout.trimEnd().split('\n').at(-1), /report\.html$/);
});

test('usage and input errors exit 2 with a fix hint', () => {
  const none = runCli(['check']);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /at least one input/);
  const missing = runCli(['check', join(tmp('x'), 'nope.html')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /does not exist/);
  const badKind = runCli(['check', fixture('clean.html'), '--fail-on', 'nope']);
  assert.equal(badKind.status, 2);
  assert.match(badKind.stderr, /valid: orphan_punct/);
  const badVp = runCli(['check', fixture('clean.html'), '--viewports', '5']);
  assert.equal(badVp.status, 2);
  assert.match(badVp.stderr, /viewport/);
  assert.equal(runCli(['--version']).status, 0);
  assert.equal(runCli(['bogus']).status, 2);
  assert.ok(!existsSync(join(tmp('y'), 'report.json')));

  // a run that fails (here: viewport out of range, checked inside lint) leaves no empty folder behind
  const cache = tmp('failcache');
  const out = join(tmp('failout'), 'never');
  assert.equal(runCli(['check', fixture('clean.html'), '--viewports', '5'], { XDG_CACHE_HOME: cache }).status, 2);
  assert.equal(runCli(['check', fixture('clean.html'), '--viewports', '5', '--out', out]).status, 2);
  assert.equal(runCli(['refine', fixture('refine-demo.html'), '--min-gain', '-1'], { XDG_CACHE_HOME: cache }).status, 2);
  assert.deepEqual(readdirSync(cache), [], 'no run folder for failed runs');
  assert.ok(!existsSync(out), '--out folder is not created for a failed run');
});

// Regression: an invalid --ignore selector used to reach the page and print a Playwright stack trace.
test('invalid --ignore selector is a one-line usage error (exit 2), valid ones still work', () => {
  const bad = runCli(['check', fixture('defects.html'), '--viewports', '1024', '--ignore', '[[bad', '--out', tmp('badsel')]);
  assert.equal(bad.status, 2);
  assert.equal(bad.stderr.trim(), `error: invalid CSS selector "[[bad" in --ignore: use a selector such as --ignore '.ad-slot'`);
  const ok = runCli(['check', fixture('defects.html'), '--viewports', '1024', '--ignore', '.ad-slot', '--ignore', '#nothing', '--json', '--out', tmp('oksel')]);
  assert.ok(ok.status === 0 || ok.status === 1, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).findings.length, 8);
});

test('--timeout above 2147483647 is a usage error (exit 2) without an overflow warning; the boundary values behave', () => {
  const big = runCli(['check', fixture('clean.html'), '--viewports', '1024', '--timeout', '3000000000', '--out', tmp('tobig')]);
  assert.equal(big.status, 2, big.stderr);
  assert.match(big.stderr, /1000/);
  assert.match(big.stderr, /2147483647/);
  assert.doesNotMatch(big.stderr, /TimeoutOverflowWarning/);
  const low = runCli(['check', fixture('clean.html'), '--viewports', '1024', '--timeout', '999', '--out', tmp('tolow')]);
  assert.equal(low.status, 2, low.stderr);
  const max = runCli(['check', fixture('clean.html'), '--viewports', '1024', '--timeout', '2147483647', '--out', tmp('tomax')]);
  assert.equal(max.status, 0, max.stderr);
  assert.doesNotMatch(max.stderr, /TimeoutOverflowWarning/);
});
