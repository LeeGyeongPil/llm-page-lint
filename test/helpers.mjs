// Shared test helpers (not a test file: node --test only runs *.test.mjs).
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const fixture = (name) => join(ROOT, 'fixtures', name);

// Every temp folder made by tmp() is removed when this test file's process exits,
// so repeated `npm test` runs do not pile up folders (set LPL_KEEP_TMP=1 to keep them for debugging).
const made = [];
process.on('exit', () => {
  if (process.env.LPL_KEEP_TMP) return;
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary folder under the OS temp dir (tests never write into the repo or the user cache). */
export const tmp = (name) => {
  const dir = mkdtempSync(join(tmpdir(), `lpl-${name}-`));
  made.push(dir);
  return dir;
};

let sharedCache;
/** XDG cache used by runCli unless a test passes its own, so runs without --out stay out of ~/.cache. */
export const testCache = () => (sharedCache ??= tmp('cache'));

/**
 * Where Playwright looks for its browsers in *this* (parent) process, computed the same way Playwright does.
 * On Linux Playwright uses $XDG_CACHE_HOME/ms-playwright, so a test that points XDG_CACHE_HOME at a temp
 * folder would also hide the installed Chromium from the CLI (macOS and Windows ignore XDG_CACHE_HOME,
 * which is why this only failed in Linux CI). runCli therefore pins PLAYWRIGHT_BROWSERS_PATH to this path.
 * test/cli.test.mjs checks the value against `playwright install --dry-run`.
 */
export function playwrightBrowsersPath(env = process.env, platform = process.platform) {
  const set = env.PLAYWRIGHT_BROWSERS_PATH;
  if (set === '0') return join(ROOT, 'node_modules', 'playwright-core', '.local-browsers');
  if (set) return resolve(env.INIT_CWD || process.cwd(), set);
  if (platform === 'linux') return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ms-playwright');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ms-playwright');
}
const BROWSERS = playwrightBrowsersPath(); // 부모 환경 기준 — XDG_CACHE_HOME 을 바꾸기 전에 정한다

/** Run the built CLI; returns { status, stdout, stderr }. */
export function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, 'dist', 'cli.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS, XDG_CACHE_HOME: testCache(), ...env },
    cwd: env.__cwd ?? ROOT,
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
