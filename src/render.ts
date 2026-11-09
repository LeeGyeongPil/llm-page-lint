// Browser lifecycle and per-page measurement.

import { chromium, type Browser, type BrowserServer, type BrowserContext, type Page } from 'playwright';
import { detectInPage, type DetectOptions, type RawDetectResult } from './browser/detect.js';
import { installGuards } from './browser/init.js';
import { diffSnapshots, CHANGING_TEXT_INTERVAL_MS } from './changing.js';
import { measureContrast } from './contrast.js';
import { BrowserMissingError } from './errors.js';
import { FINDING_KINDS, type ContrastCheck, type Finding } from './types.js';
import { validateFindings } from './validate.js';

export const DEFAULT_MAX_CHARS_PER_BLOCK = 2000;
export const DEFAULT_MAX_CHARS_TOTAL = 40000;

/**
 * Extra Chromium flags for restricted environments, e.g. LLM_PAGE_LINT_BROWSER_ARGS="--no-sandbox".
 * Space-separated; applied to every launch.
 */
function envArgs(): string[] {
  return (process.env.LLM_PAGE_LINT_BROWSER_ARGS ?? '').split(/\s+/).filter(Boolean);
}

/** Flags for OS sandboxes that forbid Chromium's helper processes (macOS Seatbelt, some containers). */
const RESTRICTED_FALLBACK_ARGS = ['--single-process', '--no-sandbox'];

/** Browsers launched with the restricted fallback flags (single process). */
const restrictedBrowsers = new WeakSet<Browser>();

/**
 * In single-process mode closing a page tears down the whole browser, so callers must keep pages
 * open until the end of the run and close only the browser.
 */
export function isRestricted(browser: Browser): boolean {
  return restrictedBrowsers.has(browser);
}

/**
 * Launch headless Chromium. A missing browser becomes a BrowserMissingError with the install command.
 * If the normal launch is killed (typical inside an OS sandbox), one retry uses single-process mode.
 */
export async function launchBrowser(): Promise<Browser> {
  const base = envArgs();
  try {
    return await start(base, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Executable doesn't exist|playwright install/i.test(msg)) throw new BrowserMissingError(e);
    if (!/has been closed|crash|exited|did exit|SIGTRAP|Target closed/i.test(msg)) throw e;
    try {
      return await start([...base, ...RESTRICTED_FALLBACK_ARGS], true);
    } catch {
      throw e; // report the original failure, not the fallback's
    }
  }
}

/** The server handle behind each browser, so a frozen browser can be killed for real. */
const servers = new WeakMap<Browser, BrowserServer>();

/**
 * Start Chromium through launchServer() + connect() instead of launch().
 * Reason: a page stuck in a script loop can make browser.close() hang; the server handle lets us
 * kill the browser process itself, which is the only reliable way to honour the time limit.
 */
async function start(args: string[], restricted: boolean): Promise<Browser> {
  const server = await chromium.launchServer({ args });
  let browser: Browser;
  try {
    browser = await chromium.connect(server.wsEndpoint());
  } catch (e) {
    await server.kill().catch(() => undefined);
    throw e;
  }
  servers.set(browser, server);
  if (restricted) restrictedBrowsers.add(browser);
  return browser;
}

/** One context per run: reduced motion, guards installed before any page script. Viewport is set per page. */
export async function newContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await ctx.addInitScript(installGuards);
  return ctx;
}

/** Wait until fonts are ready and images finished (lazy images are forced to load eagerly). */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const imgs = Array.from(document.images);
    for (const img of imgs) if (img.loading === 'lazy') img.loading = 'eager';
    await Promise.race([
      Promise.all(
        imgs.map((img) =>
          img.complete ? undefined : new Promise<void>((res) => { img.addEventListener('load', () => res(), { once: true }); img.addEventListener('error', () => res(), { once: true }); }),
        ),
      ),
      new Promise<void>((res) => setTimeout(res, 5000)),
    ]);
  });
}

export interface MeasureOptions {
  viewport: number;
  ignore: string[];
  changingText: boolean;
}

export interface Measured {
  findings: Finding[];
  rejected: number;
  contrast: ContrastCheck[];
  raw: RawDetectResult;
}

/** Run every detector on an already loaded page and re-validate the results in this process. */
export async function measurePage(page: Page, o: MeasureOptions): Promise<Measured> {
  const base: Omit<DetectOptions, 'mode'> = {
    ignore: o.ignore,
    maxCharsPerBlock: DEFAULT_MAX_CHARS_PER_BLOCK,
    maxCharsTotal: DEFAULT_MAX_CHARS_TOTAL,
  };
  const raw = await page.evaluate(detectInPage, { ...base, mode: 'full' } as DetectOptions);
  const rawFindings: unknown[] = Array.isArray(raw.findings) ? [...raw.findings] : [];

  if (o.changingText && Array.isArray(raw.snapshot)) {
    await page.waitForTimeout(CHANGING_TEXT_INTERVAL_MS);
    const second = await page.evaluate(detectInPage, { ...base, mode: 'snapshot' } as DetectOptions);
    if (Array.isArray(second.snapshot)) rawFindings.push(...diffSnapshots(raw.snapshot, second.snapshot));
  }

  const checked = validateFindings(rawFindings, o.viewport);
  const candidates = Array.isArray(raw.contrastCandidates) ? raw.contrastCandidates : [];
  const contrast = await measureContrast(page, sanitizeCandidates(candidates), o.viewport);
  const second = validateFindings(contrast.findings, o.viewport);
  const order = (k: string) => FINDING_KINDS.indexOf(k as (typeof FINDING_KINDS)[number]);
  const sorted = [...checked.ok, ...second.ok].sort((a, b) => order(a.kind) - order(b.kind) || a.rect.y - b.rect.y);
  return {
    findings: sorted,
    rejected: checked.rejected + second.rejected,
    contrast: contrast.checks,
    raw,
  };
}

/** Candidates come from the page too: drop anything with unusable numbers. */
function sanitizeCandidates(list: RawDetectResult['contrastCandidates']): RawDetectResult['contrastCandidates'] {
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  return list
    .filter(
      (c) =>
        c &&
        typeof c.color === 'string' &&
        typeof c.selector === 'string' &&
        c.selector.length <= 200 &&
        finite(c.fontSize) &&
        finite(c.fontWeight) &&
        Array.isArray(c.lines),
    )
    .map((c) => ({
      ...c,
      section: typeof c.section === 'string' ? c.section.slice(0, 80) : null,
      lines: c.lines
        .filter((l) => l && finite(l.x) && finite(l.y) && finite(l.w) && finite(l.h) && l.w >= 0 && l.h >= 0)
        .slice(0, 20),
    }));
}

/** Wait for `p` but never longer than `ms` (the timer does not keep node alive). */
function capped(p: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([p.then(() => undefined, () => undefined), new Promise<void>((res) => setTimeout(res, ms).unref())]);
}

/**
 * Close a browser without ever hanging the caller. A normal close gets a short grace period
 * (3 s); if the browser is frozen, its process is killed.
 * With `force` (used after a timeout, when a page is known to be stuck) the process is killed first,
 * so the time limit does not depend on how long a frozen browser takes to refuse a polite close.
 */
export async function closeBrowser(browser: Browser | undefined, opts: { force?: boolean } = {}): Promise<void> {
  if (!browser) return;
  const t0 = Date.now();
  const server = servers.get(browser);
  if (opts.force && server) {
    await capped(server.kill(), 5000); // 멈춘 페이지: 정중한 close 를 기다리지 않고 프로세스부터 끝낸다
    await capped(browser.close(), 1000); // 끊긴 연결을 정리해 isConnected() 가 false 가 되게 한다
  } else {
    await capped(browser.close(), 3000);
    if (server) await capped(server.kill(), 5000);
  }
  servers.delete(browser);
  if (process.env.LLM_PAGE_LINT_DEBUG) console.error(`closeBrowser: ${Date.now() - t0} ms, force=${!!opts.force}, connected=${browser.isConnected()}`);
}
