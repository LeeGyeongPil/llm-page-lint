// AC-1, AC-2, AC-3 (part 2): detectors on fixtures, controls and a hostile page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, runCli, tmp } from './helpers.mjs';
import { FINDING_KINDS, lint } from '../dist/index.js';

const OPTS = { viewports: [1024] };

test('defects fixture reports each of 8 kinds exactly once', async () => {
  const report = await lint({ file: fixture('defects.html') }, OPTS);
  const counts = Object.fromEntries(FINDING_KINDS.map((k) => [k, report.findings.filter((f) => f.kind === k).length]));
  assert.deepEqual(counts, Object.fromEntries(FINDING_KINDS.map((k) => [k, 1])), JSON.stringify(report.findings, null, 1));
  assert.equal(report.rejectedFromBrowser, 0);
});

test('cli exits 1 on the defects fixture and lists all 8 kinds', () => {
  const out = tmp('ac1');
  const r = runCli(['check', fixture('defects.html'), '--viewports', '1024', '--out', out]);
  assert.equal(r.status, 1, r.stderr);
  for (const k of FINDING_KINDS) assert.ok(r.stdout.includes(k), `${k} missing from summary`);
  assert.match(r.stdout, /8 findings/);
});

test('clean and false-positive fixtures report nothing', async () => {
  for (const name of ['clean.html', 'false-positives.html']) {
    const report = await lint({ file: fixture(name) }, OPTS);
    assert.deepEqual(report.findings, [], `${name}: ${JSON.stringify(report.findings)}`);
  }
  const out = tmp('ac2');
  const r = runCli(['check', fixture('clean.html'), fixture('false-positives.html'), '--viewports', '1024', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 findings/);
});

test('hostile page cannot forge or hide findings', async () => {
  const report = await lint({ file: fixture('hostile.html') }, { ...OPTS, changingText: false });
  // The page zeroed getBoundingClientRect and Array.prototype.push, yet the real defect is still found.
  assert.equal(report.findings.length, 1, JSON.stringify(report.findings));
  assert.equal(report.findings[0].kind, 'clipped_text');
  assert.equal(report.findings[0].selector, '#real');
  // The tampered section name was a non-string: that item was rejected in the parent.
  assert.ok(report.rejectedFromBrowser >= 1, `rejected=${report.rejectedFromBrowser}`);
});

test('inline html input works and --ignore skips matching elements', async () => {
  const html = '<div id="a" style="width:60px;height:14px;overflow:hidden">long long long long long text here</div>';
  const found = await lint({ html }, { ...OPTS, changingText: false });
  assert.equal(found.findings.length, 1);
  const ignored = await lint({ html }, { ...OPTS, changingText: false, ignore: ['#a'] });
  assert.equal(ignored.findings.length, 0);
});

test('--fail-on makes other kinds warnings', () => {
  const out = tmp('failon');
  const r = runCli(['check', fixture('defects.html'), '--viewports', '1024', '--out', out, '--fail-on', 'orphan_punct']);
  assert.equal(r.status, 1);
  const none = runCli(['check', fixture('hostile.html'), '--viewports', '1024', '--out', out, '--fail-on', 'cut_image']);
  assert.equal(none.status, 0, none.stderr);
});
