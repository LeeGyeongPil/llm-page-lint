// Where reports are written.
//
// Default: the XDG cache (`$XDG_CACHE_HOME` or `~/.cache`) under `llm-page-lint/runs/<time>-<name>/`.
// Nothing is written next to the input or into the current folder unless `--out` is given.
// Input files are never modified.

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { InputError } from './errors.js';

/** Base cache folder for runs. */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CACHE_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.cache'), 'llm-page-lint', 'runs');
}

function safeName(name: string): string {
  const cleaned = basename(name).replace(/\.html?$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || 'page').slice(0, 40);
}

/**
 * Create and return the output directory for one run.
 *
 * @param inputs human-readable input names (used for the default folder name)
 * @param out    explicit `--out` folder, or undefined for the XDG cache default
 * @throws InputError when `out` exists but is a file
 */
export function prepareOutDir(inputs: string[], out?: string, env: NodeJS.ProcessEnv = process.env): string {
  let dir: string;
  if (out !== undefined) {
    dir = resolve(out);
    if (existsSync(dir) && !statSync(dir).isDirectory()) {
      throw new InputError(`--out "${out}" exists and is not a folder; pass a folder path such as --out lint-report`);
    }
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = inputs.length === 1 ? safeName(inputs[0]) : `${inputs.length}-pages`;
    dir = join(cacheRoot(env), `${stamp}-${name}`);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
