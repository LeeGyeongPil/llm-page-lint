// Parent-side re-validation of whatever the page-side detector returned.
//
// The detector runs inside the page under test, so anything it returns may have been
// tampered with by the page's own scripts. Nothing from the browser is trusted:
// every item must pass the allow-list and shape checks below or it is counted and dropped.

import { FINDING_KINDS, type Finding, type FindingKind } from './types.js';

/** Hard cap: a page that reports more findings than this is treated as hostile or broken. */
export const MAX_FINDINGS = 5000;
const MAX_SELECTOR = 200;
const MAX_SECTION = 80;
const MAX_DETAIL_STRING = 200;
const MAX_DETAIL_KEYS = 12;
const MAX_COORD = 1_000_000;

const KIND_SET: ReadonlySet<string> = new Set(FINDING_KINDS);

export function isFindingKind(value: unknown): value is FindingKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sanitizeDetail(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!isRecord(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= MAX_DETAIL_KEYS) break;
    if (k.length > 40) continue;
    if (typeof v === 'string') out[k] = v.slice(0, MAX_DETAIL_STRING);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else continue;
    n++;
  }
  return out;
}

/**
 * Validate raw findings from the browser.
 *
 * @param raw      whatever the page-side detector returned (untrusted)
 * @param viewport viewport width in CSS px, recorded on every accepted finding
 * @returns accepted findings and the number of rejected items
 * @throws Error when `raw` is not an array or has more than {@link MAX_FINDINGS} items
 */
export function validateFindings(raw: unknown, viewport: number): { ok: Finding[]; rejected: number } {
  if (!Array.isArray(raw)) throw new Error('detector returned a non-array result; refusing to continue');
  if (raw.length > MAX_FINDINGS) {
    throw new Error(
      `detector returned ${raw.length} findings (limit ${MAX_FINDINGS}); the page is probably hostile or broken — refusing to continue. Exclude repeated elements with --ignore <selector>, or split the page and check the parts separately`,
    );
  }
  const ok: Finding[] = [];
  let rejected = 0;
  for (const item of raw as unknown[]) {
    const f = toFinding(item, viewport);
    if (f) ok.push(f);
    else rejected++;
  }
  return { ok, rejected };
}

function toFinding(item: unknown, viewport: number): Finding | null {
  if (!isRecord(item)) return null;
  if (!isFindingKind(item.kind)) return null;
  const selector = item.selector;
  if (typeof selector !== 'string' || selector.length === 0 || selector.length > MAX_SELECTOR) return null;
  const sectionRaw = item.section;
  if (sectionRaw !== null && sectionRaw !== undefined && (typeof sectionRaw !== 'string' || sectionRaw.length > MAX_SECTION)) {
    return null;
  }
  const r = item.rect;
  if (!isRecord(r)) return null;
  const { x, y, w, h } = r as Record<string, unknown>;
  for (const n of [x, y, w, h]) {
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > MAX_COORD) return null;
  }
  if ((w as number) < 0 || (h as number) < 0) return null;
  return {
    kind: item.kind,
    selector,
    section: typeof sectionRaw === 'string' ? sectionRaw : null,
    viewport,
    rect: { x: Math.round(x as number), y: Math.round(y as number), w: Math.round(w as number), h: Math.round(h as number) },
    detail: sanitizeDetail(item.detail),
  };
}
