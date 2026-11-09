// Text contrast over images and gradients, measured from pixels.
//
// Style-based tools (axe-core, Lighthouse) cannot know what colour sits behind text on a photo or a
// gradient, so they report "incomplete". Here we make all text transparent, take one full-page
// screenshot, and compare the real text colour to the real background pixels under each text line.

import { PNG } from 'pngjs';
import type { Page } from 'playwright';
import type { ContrastCandidate } from './browser/detect.js';
import type { ContrastCheck, Finding, Rect } from './types.js';

export type RGB = readonly [number, number, number];

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of an sRGB colour (0-255 channels). */
export function luminance(c: RGB): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}

/** WCAG 2.x contrast ratio between two colours, 1 (identical) to 21 (black on white). */
export function contrastRatio(fg: RGB, bg: RGB): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** Parse `rgb()`/`rgba()` as returned by getComputedStyle. Returns null when unparseable. */
export function parseCssColor(css: string): { rgb: RGB; alpha: number } | null {
  const m = /^rgba?\(([^)]+)\)$/.exec(css.trim());
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  const alpha = p.length >= 4 && Number.isFinite(p[3]) ? p[3] : 1;
  return { rgb: [p[0], p[1], p[2]], alpha };
}

const HIDE_TEXT_CSS =
  '*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;' +
  'text-shadow:none!important;-webkit-text-stroke:0!important;text-decoration-color:transparent!important}';
const MAX_SHOT_HEIGHT = 20000;

/** Large text (WCAG): 24px+, or 18.66px+ bold. */
export function requiredRatio(fontSize: number, fontWeight: number): number {
  return fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
}

/** Lowest-10% ratio of `fg` against the pixels of `png` inside `r` (page coordinates). */
export function percentileRatio(png: PNG, r: Rect, fg: RGB, alpha: number): number | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(png.width, Math.ceil(r.x + r.w));
  const y1 = Math.min(png.height, Math.ceil(r.y + r.h));
  if (x1 <= x0 || y1 <= y0) return null;
  const stepX = Math.max(1, Math.floor((x1 - x0) / 60));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 12));
  const ratios: number[] = [];
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (png.width * y + x) * 4;
      const bg: RGB = [png.data[i], png.data[i + 1], png.data[i + 2]];
      // Semi-transparent text colour is blended over each background pixel before comparing.
      const eff: RGB =
        alpha >= 1
          ? fg
          : [fg[0] * alpha + bg[0] * (1 - alpha), fg[1] * alpha + bg[1] * (1 - alpha), fg[2] * alpha + bg[2] * (1 - alpha)];
      ratios.push(contrastRatio(eff, bg));
    }
  }
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length * 0.1)];
}

/**
 * Measure every candidate (text on an image/gradient background) and return all checks plus
 * a `low_contrast_over_image` finding for each failing one. The page is restored afterwards.
 */
export async function measureContrast(
  page: Page,
  candidates: ContrastCandidate[],
  viewport: number,
): Promise<{ checks: ContrastCheck[]; findings: Finding[] }> {
  if (!candidates.length) return { checks: [], findings: [] };
  await page.evaluate((css) => {
    const s = document.createElement('style');
    s.id = '__llm_page_lint_hide_text';
    s.textContent = css;
    document.head.appendChild(s);
  }, HIDE_TEXT_CSS);
  let png: PNG;
  try {
    const size = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));
    const buf = await page.screenshot({
      fullPage: true,
      type: 'png',
      animations: 'disabled',
      clip: { x: 0, y: 0, width: Math.max(1, Math.min(size.w, 8000)), height: Math.max(1, Math.min(size.h, MAX_SHOT_HEIGHT)) },
    });
    png = PNG.sync.read(buf);
  } finally {
    await page.evaluate(() => document.getElementById('__llm_page_lint_hide_text')?.remove());
  }

  const checks: ContrastCheck[] = [];
  const findings: Finding[] = [];
  for (const c of candidates) {
    const color = parseCssColor(c.color);
    if (!color || color.alpha === 0) continue;
    let worst: number | null = null;
    let worstRect: Rect | null = null;
    for (const l of c.lines) {
      const ratio = percentileRatio(png, l, color.rgb, color.alpha);
      if (ratio !== null && (worst === null || ratio < worst)) {
        worst = ratio;
        worstRect = { x: l.x, y: l.y, w: l.w, h: l.h };
      }
    }
    if (worst === null || !worstRect) continue;
    const need = requiredRatio(c.fontSize, c.fontWeight);
    const ratio = Math.round(worst * 100) / 100;
    const pass = ratio >= need;
    checks.push({ selector: c.selector, viewport, color: c.color, ratio, need, pass });
    if (!pass) {
      findings.push({
        kind: 'low_contrast_over_image',
        selector: c.selector,
        section: c.section,
        viewport,
        rect: {
          x: Math.round(worstRect.x),
          y: Math.round(worstRect.y),
          w: Math.round(worstRect.w),
          h: Math.round(worstRect.h),
        },
        detail: { ratio, need, color: c.color },
      });
    }
  }
  return { checks, findings };
}
