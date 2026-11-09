// AC-9: public API surface and the example script.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT, fixture } from './helpers.mjs';
import * as api from '../dist/index.js';

test('public api lints a file and example runs', async () => {
  for (const name of ['lint', 'detectPage', 'validateFindings', 'contrastRatio', 'LintTimeoutError', 'BrowserMissingError', 'InputError']) {
    assert.equal(typeof api[name], 'function', name);
  }
  const report = await api.lint({ file: fixture('defects.html') }, { viewports: [1024] });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.findings.length, 8);

  const r = spawnSync(process.execPath, [join(ROOT, 'examples', 'api.mjs')], { encoding: 'utf8', env: process.env, timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^8 findings/);
});

test('detectPage works on a page the caller opened', async () => {
  const { launchBrowser, closeBrowser } = await import('../dist/render.js'); // internal helpers, handle restricted sandboxes
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    await page.goto(new URL(`file://${fixture('defects.html')}`).href);
    const findings = await api.detectPage(page);
    assert.equal(findings.length, 7); // changing_text is off by default for detectPage
    assert.ok(findings.some((f) => f.kind === 'clipped_text'));
  } finally {
    await closeBrowser(browser); // also kills the browser server process so node can exit
  }
});

test('invalid input raises InputError with a hint', async () => {
  await assert.rejects(api.lint({ file: '/nonexistent/page.html' }), api.InputError);
  await assert.rejects(api.lint({ html: '<p>x</p>' }, { viewports: [10] }), /viewport/);
  await assert.rejects(api.lint({ url: 'ftp://x' }, { viewports: [1024] }), api.InputError);
});
