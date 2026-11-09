// Public entry points: lint() for files/URLs/HTML strings, detectPage() for an existing Playwright page.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright';
import { InputError, LintTimeoutError } from './errors.js';
import { closeBrowser, isRestricted, launchBrowser, measurePage, newContext, settle } from './render.js';
import type { Finding, LintInput, LintOptions, LintReport, PageResult, PageShot } from './types.js';

export const DEFAULT_VIEWPORTS = [375, 768, 1280];
export const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_SHOT_HEIGHT = 12_000;

/** Package version, read once from package.json (works from dist/ and from a checkout). */
export const VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

function normalizeViewports(v: number[] | undefined): number[] {
  const list = v && v.length ? v : DEFAULT_VIEWPORTS;
  for (const w of list) {
    if (!Number.isInteger(w) || w < 200 || w > 4000) {
      throw new InputError(`invalid viewport width "${w}": use whole numbers between 200 and 4000, e.g. --viewports 375,1280`);
    }
  }
  return [...new Set(list)];
}

function describe(input: LintInput): string {
  if ('html' in input) return '<html>';
  if ('file' in input) return input.file;
  return input.url;
}

async function load(page: Page, input: LintInput): Promise<void> {
  if ('html' in input && input.baseDir) {
    // Serve the HTML string under a file:// URL in baseDir so relative images and CSS resolve (nothing is written to disk).
    const url = pathToFileURL(resolve(input.baseDir, '__llm-page-lint__.html')).href;
    await page.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: input.html }));
    await page.goto(url, { waitUntil: 'load' });
  } else if ('html' in input) {
    await page.setContent(input.html, { waitUntil: 'load' });
  } else if ('file' in input) {
    await page.goto(pathToFileURL(resolve(input.file)).href, { waitUntil: 'load' });
  } else {
    if (!/^https?:\/\//i.test(input.url)) throw new InputError(`url "${input.url}" must start with http:// or https://`);
    await page.goto(input.url, { waitUntil: 'load' });
  }
}

export interface LintDetailed {
  report: LintReport;
  shots: PageShot[];
}

/** Like {@link lint} but also returns full-page screenshots (used for report.html). */
export async function lintDetailed(inputs: LintInput[], opts: LintOptions = {}): Promise<LintDetailed> {
  if (!inputs.length) throw new InputError('no input: pass an HTML file, a folder of .html files, or a URL');
  for (const i of inputs) {
    if ('file' in i) {
      try {
        readFileSync(resolve(i.file));
      } catch {
        throw new InputError(`cannot read "${i.file}": check the path (relative paths are resolved from ${process.cwd()})`);
      }
    }
  }
  const viewports = normalizeViewports(opts.viewports);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new InputError(`timeoutMs must be at least 1000 (CLI: --timeout <ms>), got ${String(timeoutMs)}`);
  const started = Date.now();

  let browser: Browser | undefined;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  const work = async (): Promise<LintDetailed> => {
    browser = await launchBrowser();
    opts.onBrowser?.(browser);
    // The deadline may have fired while Chromium was still starting: close it now instead of leaking it.
    if (timedOut) {
      await closeBrowser(browser);
      throw new LintTimeoutError(timeoutMs);
    }
    const findings: Finding[] = [];
    const pages: PageResult[] = [];
    const contrast: LintReport['contrast'] = [];
    const shots: PageShot[] = [];
    let rejected = 0;
    const ctx = await newContext(browser);
    const keepPagesOpen = isRestricted(browser);
    for (const input of inputs) {
      for (let vi = 0; vi < viewports.length; vi++) {
        const width = viewports[vi];
        let page: Page | undefined;
        try {
          page = await ctx.newPage();
          await page.setViewportSize({ width, height: 800 });
          await load(page, input);
          await settle(page);
          const m = await measurePage(page, {
            viewport: width,
            ignore: opts.ignore ?? [],
            changingText: (opts.changingText ?? true) && vi === 0,
          });
          findings.push(...m.findings);
          contrast.push(...m.contrast);
          rejected += m.rejected;
          const pageHeight = Math.min(Math.max(0, Math.round(m.raw.pageHeight)), 1_000_000);
          pages.push({
            input: describe(input),
            viewport: width,
            pageWidth: Math.round(m.raw.pageWidth),
            pageHeight,
            findings: m.findings.length,
            truncated: m.raw.truncated === true,
          });
          if (opts.screenshots) {
            const w = Math.max(1, Math.min(Math.round(m.raw.pageWidth) || width, 4000));
            const h = Math.max(1, Math.min(pageHeight || 800, MAX_SHOT_HEIGHT));
            const jpeg = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true, clip: { x: 0, y: 0, width: w, height: h } });
            shots.push({ input: describe(input), viewport: width, width: w, height: h, jpeg });
          }
        } finally {
          if (page && !keepPagesOpen) await page.close().catch(() => undefined);
        }
      }
    }
    const report: LintReport = {
      schemaVersion: 1,
      tool: { name: 'llm-page-lint', version: VERSION },
      inputs: inputs.map(describe),
      viewports,
      seconds: Math.round(((Date.now() - started) / 1000) * 100) / 100,
      findings,
      rejectedFromBrowser: rejected,
      contrast,
      pages,
    };
    return { report, shots };
  };

  // The whole run has one deadline. A page stuck in a script loop cannot be interrupted from
  // inside, so on timeout we close the browser (killing the renderer) and throw.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new LintTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  const running = work();
  running.catch(() => undefined); // the loser of the race must not become an unhandled rejection
  try {
    return await Promise.race([running, deadline]);
  } catch (e) {
    if (timedOut) throw new LintTimeoutError(timeoutMs);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    await closeBrowser(browser);
    // If the browser was still launching at the deadline, give work() a moment to close it.
    if (timedOut) await Promise.race([running.catch(() => undefined), new Promise<void>((res) => setTimeout(res, 8000).unref())]);
  }
}

/**
 * Lint one or more pages.
 *
 * @example
 * const report = await lint({ file: 'page.html' }, { viewports: [375, 1280] });
 * if (report.findings.length) console.log(report.findings);
 *
 * @throws InputError for bad input or options, BrowserMissingError if Chromium is not installed,
 *         LintTimeoutError when `timeoutMs` is exceeded.
 */
export async function lint(input: LintInput | LintInput[], opts: LintOptions = {}): Promise<LintReport> {
  const list = Array.isArray(input) ? input : [input];
  return (await lintDetailed(list, opts)).report;
}

/**
 * Run the detectors on a page you already opened with Playwright.
 * The page's viewport width is used. Measurement guards are only installed when you add
 * `installGuards` yourself via `context.addInitScript` (see README); otherwise the page can tamper
 * with measurement functions, although results are still re-validated here.
 */
export async function detectPage(page: Page, opts: Pick<LintOptions, 'ignore' | 'changingText'> = {}): Promise<Finding[]> {
  const width = page.viewportSize()?.width ?? 1280;
  const m = await measurePage(page, { viewport: width, ignore: opts.ignore ?? [], changingText: opts.changingText ?? false });
  return m.findings;
}
