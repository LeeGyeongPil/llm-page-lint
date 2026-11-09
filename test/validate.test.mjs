// AC-3 (part 1): forged or malformed browser results are rejected by the parent. No browser needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateFindings } from '../dist/index.js';

const good = (over = {}) => ({
  kind: 'clipped_text',
  selector: 'div.card',
  section: 'clip',
  rect: { x: 1.4, y: 2.6, w: 10, h: 20 },
  detail: { hiddenPx: 5 },
  ...over,
});

test('rejects forged findings and counts them', () => {
  const raw = [
    good(),
    good({ kind: 'evil' }), // unknown kind
    good({ rect: { x: NaN, y: 0, w: 1, h: 1 } }), // non-finite coordinate
    good({ selector: 'a'.repeat(201) }), // selector too long
    good({ selector: 123 }), // selector not a string
    good({ rect: { x: 0, y: 0, w: -1, h: 5 } }), // negative size
    good({ rect: null }),
    good({ section: { forged: true } }), // section not a string
    'not an object',
    null,
  ];
  const { ok, rejected } = validateFindings(raw, 1024);
  assert.equal(ok.length, 1);
  assert.equal(rejected, 9);
  assert.deepEqual(ok[0].rect, { x: 1, y: 3, w: 10, h: 20 }); // rounded
  assert.equal(ok[0].viewport, 1024);
});

test('sanitizes detail values and trims nothing else', () => {
  const { ok } = validateFindings(
    [good({ detail: { a: 'x'.repeat(500), b: { nested: 1 }, c: Infinity, d: true, e: 3 } })],
    375,
  );
  assert.equal(ok[0].detail.a.length, 200);
  assert.deepEqual(Object.keys(ok[0].detail).sort(), ['a', 'd', 'e']);
});

test('more than 5000 findings is a run error', () => {
  const many = Array.from({ length: 5001 }, () => good());
  assert.throws(() => validateFindings(many, 1024), /5000/);
});

test('non-array results are a run error', () => {
  assert.throws(() => validateFindings({ findings: [] }, 1024), /non-array/);
});
