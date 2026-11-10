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

test('BrowserMissingError explains the Linux XDG_CACHE_HOME trap', () => {
  const linux = new api.BrowserMissingError(undefined, { XDG_CACHE_HOME: '/tmp/xdg' }, 'linux');
  assert.match(linux.message, /npx playwright install chromium --only-shell/);
  assert.match(linux.message, /\/tmp\/xdg\/ms-playwright/);
  assert.match(linux.message, /PLAYWRIGHT_BROWSERS_PATH=~\/\.cache\/ms-playwright/);
  // no note where XDG_CACHE_HOME plays no part
  assert.doesNotMatch(new api.BrowserMissingError(undefined, { XDG_CACHE_HOME: '/tmp/xdg' }, 'darwin').message, /note:/);
  assert.doesNotMatch(new api.BrowserMissingError(undefined, { XDG_CACHE_HOME: '/x', PLAYWRIGHT_BROWSERS_PATH: '/pw' }, 'linux').message, /note:/);
  assert.doesNotMatch(new api.BrowserMissingError(undefined, {}, 'linux').message, /note:/);
  assert.equal(new api.BrowserMissingError().exitCode, 2);
});

test('invalid input raises InputError with a hint', async () => {
  await assert.rejects(api.lint({ file: '/nonexistent/page.html' }), api.InputError);
  await assert.rejects(api.lint({ html: '<p>x</p>' }, { viewports: [10] }), /viewport/);
  await assert.rejects(api.lint({ url: 'ftp://x' }, { viewports: [1024] }), api.InputError);
});

test('lint() rejects an invalid ignore selector with InputError, never opens the input page, and closes the browser', async () => {
  let browser;
  let opened = 0;
  await assert.rejects(
    api.lint({ file: fixture('defects.html') }, {
      viewports: [1024],
      ignore: ['.ok', '[[bad'],
      onBrowser: (b) => {
        browser = b;
        // count navigations: the invalid selector must be rejected before any input page is loaded
        const newContext = b.newContext.bind(b);
        b.newContext = async (...a) => {
          const ctx = await newContext(...a);
          const newPage = ctx.newPage.bind(ctx);
          ctx.newPage = async (...x) => {
            const page = await newPage(...x);
            for (const m of ['goto', 'setContent']) {
              const orig = page[m].bind(page);
              page[m] = (...y) => (opened++, orig(...y));
            }
            return page;
          };
          return ctx;
        };
      },
    }),
    (e) => e instanceof api.InputError && e.message.includes('"[[bad"'),
  );
  assert.ok(browser, 'browser was launched');
  assert.equal(browser.isConnected(), false);
  assert.equal(opened, 0);
});
