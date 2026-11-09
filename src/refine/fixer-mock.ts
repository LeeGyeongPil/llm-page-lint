// Practice fixer: appends a scoped <style> with the "usual prescription" for each defect kind.
// The patch is real CSS and is judged by a real re-render, so a bad prescription really does
// create a new defect and the gate has to catch it.

import type { FindingKind, Fixer, FixerInput } from '../types.js';

/** Selectors come from the (re-validated) findings; still refuse anything with CSS-breaking characters. */
const CSS_SAFE = /^[A-Za-z0-9_#.:>\s()+~=-]{1,200}$/;

/** One CSS rule for a finding, or null when the kind has no usual prescription. */
function rule(scope: string, kind: FindingKind, selector: string, detail: Record<string, string | number | boolean>): string | null {
  // every rule is limited to descendants of the section, whatever the finding's selector is rooted at
  const only = (sel: string) => scope + ' :is(' + sel + ')';
  const other = typeof detail.other === 'string' && CSS_SAFE.test(detail.other) ? detail.other : '';
  const clipper = typeof detail.clipper === 'string' && CSS_SAFE.test(detail.clipper) ? detail.clipper : '';
  switch (kind) {
    case 'clipped_text':
      return only(selector) + '{height:auto !important;max-height:none !important;overflow:visible !important}';
    case 'overlap_text': {
      // the usual prescription: push the lower block down by the overlap height
      const px = typeof detail.overlapHeight === 'number' ? detail.overlapHeight + 8 : 24;
      return other ? only(other) + '{transform:translateY(' + px + 'px) !important}' : null;
    }
    case 'offscreen_text':
      return only(selector) + '{position:static !important;max-width:100% !important}';
    case 'empty_box':
      return only(selector) + '{display:none !important}';
    case 'cut_image':
      return clipper ? only(clipper) + '{height:auto !important;overflow:visible !important}' : null;
    case 'low_contrast_over_image':
      return only(selector) + '{color:#111 !important}';
    case 'orphan_punct':
      return only(selector) + '{text-wrap:balance !important}';
    default:
      return null;
  }
}

export class MockFixer implements Fixer {
  readonly name = 'mock-css';

  async fix(input: FixerInput): Promise<{ pageHtml: string } | null> {
    const rules: string[] = [];
    for (const f of input.findings) {
      const css = CSS_SAFE.test(f.selector) ? rule(input.scope, f.kind, f.selector, f.detail) : null;
      if (css && !rules.includes(css)) rules.push(css);
    }
    if (!rules.length) return null;
    // put the style just before the section's closing tag, so it stays inside the section range
    const close = input.sectionHtml.lastIndexOf('</');
    if (close < 0) return null;
    const style = '<style data-llm-page-lint="mock">' + rules.join('') + '</style>';
    const sectionHtml = input.sectionHtml.slice(0, close) + style + input.sectionHtml.slice(close);
    return { pageHtml: input.pageHtml.slice(0, input.range[0]) + sectionHtml + input.pageHtml.slice(input.range[1]) };
  }
}
