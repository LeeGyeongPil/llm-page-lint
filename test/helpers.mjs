// Shared test helpers (not a test file: node --test only runs *.test.mjs).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const fixture = (name) => join(ROOT, 'fixtures', name);

/** A fresh temporary folder under the OS temp dir (tests never write into the repo). */
export const tmp = (name) => mkdtempSync(join(tmpdir(), `lpl-${name}-`));

/** Run the built CLI; returns { status, stdout, stderr }. */
export function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, 'dist', 'cli.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: env.__cwd ?? ROOT,
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
