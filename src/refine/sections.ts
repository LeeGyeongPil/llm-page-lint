// Section boundaries and patch-safety checks, based on parse5 source locations.

import { parse } from 'parse5';

/** Minimal view of a parse5 tree node (only what we read). */
interface PNode {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: PNode[];
  content?: PNode;
  sourceCodeLocation?: { startOffset: number; endOffset: number } | null;
}

export interface Section {
  /** data-section value, else the element id, else the tag name (duplicates get "#2", "#3", ...). */
  id: string;
  tag: string;
  /** CSS selector that matches just this section (used to scope generated rules) */
  scope: string;
  /** [start, end) offsets of the whole element in the page source */
  start: number;
  end: number;
}

export interface ParsedPage {
  sections: Section[];
  parseErrors: number;
}

const attr = (n: PNode, name: string): string | undefined => n.attrs?.find((a) => a.name === name)?.value;
const kids = (n: PNode): PNode[] => n.childNodes ?? n.content?.childNodes ?? [];
const SECTION_TAGS = new Set(['header', 'section', 'footer']);

/** Parse a page and list its sections: [data-section] elements, else body-level header/section/footer (+ main > section). */
export function parsePage(html: string): ParsedPage {
  let parseErrors = 0;
  const doc = parse(html, {
    sourceCodeLocationInfo: true,
    onParseError: () => {
      parseErrors++;
    },
  }) as unknown as PNode;

  const found: PNode[] = [];
  const walkTagged = (n: PNode, insideTagged: boolean) => {
    for (const c of kids(n)) {
      if (!c.tagName) continue;
      const tagged = attr(c, 'data-section') !== undefined;
      if (tagged && !insideTagged) found.push(c);
      walkTagged(c, insideTagged || tagged);
    }
  };
  walkTagged(doc, false);

  if (!found.length) {
    const body = findTag(doc, 'body');
    if (body) {
      for (const c of kids(body)) {
        if (c.tagName && SECTION_TAGS.has(c.tagName)) found.push(c);
        else if (c.tagName === 'main') for (const m of kids(c)) if (m.tagName && SECTION_TAGS.has(m.tagName)) found.push(m);
      }
    }
  }

  const seen = new Map<string, number>();
  const sections: Section[] = [];
  for (const n of found) {
    const loc = n.sourceCodeLocation;
    if (!loc || !n.tagName) continue;
    const base = (attr(n, 'data-section') || attr(n, 'id') || n.tagName).slice(0, 80);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const ds = attr(n, 'data-section');
    const elId = attr(n, 'id');
    const scope = ds !== undefined && /^[^"\\]*$/.test(ds) ? `[data-section="${ds}"]` : elId && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(elId) ? `#${elId}` : n.tagName;
    sections.push({ id: count === 1 ? base : `${base}#${count}`, tag: n.tagName, scope, start: loc.startOffset, end: loc.endOffset });
  }
  return { sections, parseErrors };
}

function findTag(n: PNode, tag: string): PNode | undefined {
  for (const c of kids(n)) {
    if (c.tagName === tag) return c;
    const deeper = findTag(c, tag);
    if (deeper) return deeper;
  }
  return undefined;
}

export type PatchCheck = { ok: true; newSection: string } | { ok: false; reason: string };

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const urls = (s: string) => new Set(s.match(/https?:\/\/[^\s"'<>)]+/gi) ?? []);
const UNSAFE: [string, RegExp][] = [
  ['<script>', /<script\b/gi],
  ['event attribute', /[\s"'/]on[a-z]{3,}\s*=/gi],
  ['javascript: url', /javascript:/gi],
  ['<iframe>/<object>/<embed>', /<(iframe|object|embed)\b/gi],
  ['<link>/<meta refresh>', /<link\b|<meta\b[^>]*http-equiv/gi],
];

/**
 * Check that `patched` differs from `original` only inside `section`, and that the change adds
 * nothing active (scripts, event attributes, new external URLs, new parse errors).
 */
export function checkPatch(original: string, patched: string, section: Section, baseline: ParsedPage): PatchCheck {
  const prefix = original.slice(0, section.start);
  const suffix = original.slice(section.end);
  if (patched.length < prefix.length + suffix.length || !patched.startsWith(prefix) || !patched.endsWith(suffix)) {
    return { ok: false, reason: 'changed outside the section' };
  }
  const newSection = patched.slice(prefix.length, patched.length - suffix.length);
  const oldSection = original.slice(section.start, section.end);

  const again = parsePage(patched);
  const same = again.sections.find((s) => s.id === section.id);
  if (!same || same.start !== section.start || same.end !== section.start + newSection.length) {
    return { ok: false, reason: 'section structure changed (the patch left the section boundary)' };
  }
  if (again.parseErrors > baseline.parseErrors) return { ok: false, reason: 'parse errors increased' };

  for (const [name, re] of UNSAFE) {
    if (count(newSection, re) > count(oldSection, re)) return { ok: false, reason: `unsafe content added: ${name}` };
  }
  const before = urls(oldSection);
  for (const u of urls(newSection)) if (!before.has(u)) return { ok: false, reason: 'unsafe content added: new external URL' };
  return { ok: true, newSection };
}
