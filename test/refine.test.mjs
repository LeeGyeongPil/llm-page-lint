// AC-7, AC-8: the refine loop (mock judge/fixer) and its safety gate.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, runCli, tmp } from './helpers.mjs';
import { OpenAIFixer, OpenAIJudge, lint, refine } from '../dist/index.js';
import { buildRequest, parseJudgement } from '../dist/refine/openai.js';

const DEMO = fixture('refine-demo.html');
const outcome = (report, id) => report.sections.find((s) => s.id === id);

/** A fixer that edits the clip section with a caller-provided function (page-level string in, page-level string out). */
const fixerFor = (edit) => ({
  name: 'test-fixer',
  async fix(input) {
    const section = input.pageHtml.slice(input.range[0], input.range[1]);
    return { pageHtml: edit(input.pageHtml, section, input) };
  },
});

test('mock loop keeps improvements and reverts regressions', async () => {
  const before = readFileSync(DEMO);
  const out = tmp('ac7');
  const r = runCli(['refine', DEMO, '--viewports', '1024', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.split('\n')[0], /mock/i, 'first line says this is mock mode');
  assert.match(r.stdout, /clip\s+accepted/);
  assert.match(r.stdout, /overlap\s+reverted \(detections increased\)/);
  assert.match(r.stdout, /good\s+not attempted/);

  assert.ok(readFileSync(DEMO).equals(before), 'input file is byte-identical');

  const meta = JSON.parse(readFileSync(join(out, 'refine.json'), 'utf8'));
  assert.equal(meta.mode.mock, true);
  assert.ok(meta.findingsAfter < meta.findingsBefore, `${meta.findingsAfter} < ${meta.findingsBefore}`);

  // the refined file really measures better when linted from scratch
  const refined = await lint({ file: join(out, 'refined.html') }, { viewports: [1024], changingText: false });
  const original = await lint({ file: DEMO }, { viewports: [1024], changingText: false });
  assert.ok(refined.findings.length < original.findings.length);
  const html = readFileSync(join(out, 'refined.html'), 'utf8');
  assert.match(html, /data-llm-page-lint="mock"/);
  // the reverted overlap section is back to the original text
  assert.ok(html.includes('<h3>Subtitle drawn on top</h3>\n</section>'));
});

test('rejects patches outside the section, unsafe or below min-gain', async () => {
  const opts = { viewports: [1024] };
  const reasonOf = async (edit) => outcome(await refine(DEMO, { ...opts, fixer: fixerFor(edit), maxSections: 1 }), 'clip');

  // 1. outside the section
  const outside = await reasonOf((page) => page.replace('<title>', '<title>X '));
  assert.equal(outside.accepted, false);
  assert.match(outside.reason, /changed outside the section/);

  // 2. unsafe additions inside the section
  const script = await reasonOf((page, section) => page.replace(section, section.replace('</section>', '<script>1</script></section>')));
  assert.match(script.reason, /unsafe content added: <script>/);
  const handler = await reasonOf((page, section) => page.replace(section, section.replace('<div class="card"', '<div onclick="x()" class="card"')));
  assert.match(handler.reason, /unsafe content added: event attribute/);
  const url = await reasonOf((page, section) => page.replace(section, section.replace('</section>', '<img src="https://example.com/a.png"></section>')));
  assert.match(url.reason, /new external URL/);

  // 3. leaving the section boundary
  const escape = await reasonOf((page, section) => page.replace(section, section.replace('</section>', '</section><p>escaped</p><section>')));
  assert.equal(escape.accepted, false);

  // 4. harmless change that does not improve anything: below min-gain
  const same = await reasonOf((page, section) => page.replace(section, section.replace('</section>', '<style>/* nothing */</style></section>')));
  assert.match(same.reason, /below min-gain/);

  // 5. no change at all
  const noop = await reasonOf((page) => page);
  assert.match(noop.reason, /changed nothing/);
});

test('refine input errors are reported with a fix hint', async () => {
  await assert.rejects(refine(fixture('missing.html')), /cannot read/);
  const dir = tmp('nosec');
  const f = join(dir, 'plain.html');
  writeFileSync(f, '<p>no sections here</p>');
  await assert.rejects(refine(f), /no sections found/);
  await assert.rejects(refine(DEMO, { minGain: -1 }), /min-gain/);
});

test('openai adapter builds request and skips malformed judge json', async () => {
  const calls = [];
  const reply = (content) => async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const goodScores = { layout: 5, readability: 4, hierarchy: 6, spacing: 7, responsive: 8, completeness: 9 };
  const input = { sectionId: 'clip', sectionHtml: '<section>x</section>', findings: [] };

  const judge = new OpenAIJudge({ baseUrl: 'http://localhost:11434/v1/', model: 'm1', apiKey: 'k', fetch: reply(JSON.stringify({ scores: goodScores, instructions: [{ text: 'fix it', kind: 'clipped_text' }, { nope: 1 }] })) });
  const j = await judge.judge(input);
  assert.equal(j.overall, 6.5);
  assert.deepEqual(j.instructions, [{ text: 'fix it', kind: 'clipped_text' }]);
  assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'm1');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
  assert.deepEqual(body, buildRequest('m1', body.messages[0].content, body.messages[1].content));

  // broken JSON, out-of-range score, HTTP error: all become null (section skipped)
  assert.equal(parseJudgement('not json'), null);
  assert.equal(parseJudgement(JSON.stringify({ scores: { ...goodScores, layout: 99 } })), null);
  assert.equal(await new OpenAIJudge({ baseUrl: 'http://x', model: 'm', fetch: reply('{broken') }).judge(input), null);
  assert.equal(await new OpenAIJudge({ baseUrl: 'http://x', model: 'm', fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) }).judge(input), null);
  assert.equal(await new OpenAIJudge({ baseUrl: 'http://x', model: 'm', fetch: async () => { throw new Error('offline'); } }).judge(input), null);

  // a skipped judge keeps the original: refine leaves the page untouched
  const broken = new OpenAIJudge({ baseUrl: 'http://x', model: 'm', fetch: reply('{broken') });
  const report = await refine(DEMO, { viewports: [1024], judge: broken });
  assert.ok(report.sections.every((s) => !s.accepted && /skipped/.test(s.reason)));
  assert.equal(report.refinedHtml, readFileSync(DEMO, 'utf8'));

  // the fixer splices the returned section into the page and ignores replies without sectionHtml
  const fx = new OpenAIFixer({ baseUrl: 'http://x', model: 'm', fetch: reply(JSON.stringify({ sectionHtml: '<section>new</section>' })) });
  const patched = await fx.fix({ ...input, pageHtml: 'AAA<section>x</section>BBB', range: [3, 23], scope: 's', instructions: [] });
  assert.equal(patched.pageHtml, 'AAA<section>new</section>BBB');
  const none = new OpenAIFixer({ baseUrl: 'http://x', model: 'm', fetch: reply(JSON.stringify({ other: 1 })) });
  assert.equal(await none.fix({ ...input, pageHtml: 'AAA', range: [0, 1], scope: 's', instructions: [] }), null);
});

test('openai mode without configuration fails with a fix hint', () => {
  const r = runCli(['refine', DEMO, '--judge', 'openai', '--out', tmp('noenv')], { LLM_PAGE_LINT_BASE_URL: '' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /LLM_PAGE_LINT_BASE_URL/);
});
