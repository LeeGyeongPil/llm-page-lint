// AC-4: WCAG ratio values (no browser) and pixel-measured contrast over gradients (browser).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './helpers.mjs';
import { contrastRatio, lint } from '../dist/index.js';

test('wcag ratio known values', () => {
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), 21);
  assert.equal(contrastRatio([255, 255, 255], [0, 0, 0]), 21);
  assert.equal(contrastRatio([120, 30, 200], [120, 30, 200]), 1);
  // #777 on white is the classic "just under 4.5" case
  const r = contrastRatio([119, 119, 119], [255, 255, 255]);
  assert.ok(r > 4.4 && r < 4.6, String(r));
});

test('light gradient fails and dark gradient passes', async () => {
  const report = await lint({ file: fixture('defects.html') }, { viewports: [1024], changingText: false });
  const byId = (id) => report.contrast.find((c) => c.selector.includes(id));
  const light = byId('#s-hero >');
  const dark = byId('#s-hero2 >');
  assert.ok(light && dark, JSON.stringify(report.contrast));
  assert.ok(light.ratio < 3, `light ratio ${light.ratio}`);
  assert.equal(light.pass, false);
  assert.ok(dark.ratio > 10, `dark ratio ${dark.ratio}`);
  assert.equal(dark.pass, true);
  assert.equal(report.findings.filter((f) => f.kind === 'low_contrast_over_image').length, 1);
});
