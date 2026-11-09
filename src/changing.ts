// Text that changes by itself (countdowns, tickers, random numbers) makes a generated page
// non-reproducible. We read every text block twice, ~1.2 s apart, and report blocks whose text differs.

import type { RawFinding, TextSnapshotItem } from './browser/detect.js';

export const CHANGING_TEXT_INTERVAL_MS = 1200;

/** Blocks are matched by selector plus the occurrence index of that selector. */
function keyed(items: TextSnapshotItem[]): Map<string, TextSnapshotItem> {
  const seen = new Map<string, number>();
  const out = new Map<string, TextSnapshotItem>();
  for (const it of items) {
    const n = (seen.get(it.selector) ?? 0) + 1;
    seen.set(it.selector, n);
    out.set(`${it.selector}#${n}`, it);
  }
  return out;
}

/** Compare two snapshots and return raw (unvalidated) `changing_text` findings. */
export function diffSnapshots(first: TextSnapshotItem[], second: TextSnapshotItem[]): RawFinding[] {
  const a = keyed(first);
  const b = keyed(second);
  const out: RawFinding[] = [];
  for (const [key, before] of a) {
    const after = b.get(key);
    if (!after || after.text === before.text) continue;
    out.push({
      kind: 'changing_text',
      selector: before.selector,
      section: before.section,
      rect: before.rect,
      detail: { before: before.text.slice(0, 80), after: after.text.slice(0, 80), intervalMs: CHANGING_TEXT_INTERVAL_MS },
    });
  }
  return out;
}
