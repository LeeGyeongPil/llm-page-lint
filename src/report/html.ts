// report.html — one static file that opens from disk (file://), no server, no external requests.
// Screenshots are embedded as data URIs; numbered boxes are positioned in percentages over them.

import type { Finding, LintReport, PageShot } from '../types.js';

function esc(s: string | number): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CSS = `
body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#1b1b1b;background:#fafafa}
h1{font-size:20px;margin:0 0 4px} h2{font-size:16px;margin:28px 0 8px}
.meta{color:#555;margin-bottom:16px}
.ok{color:#176f2c;font-weight:600} .bad{color:#b3261e;font-weight:600}
table{border-collapse:collapse;width:100%;background:#fff} th,td{border:1px solid #d8d8d8;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f0f0f0} code{font:12px ui-monospace,monospace}
.shot{position:relative;max-width:100%;border:1px solid #bbb;background:#fff;margin:8px 0}
.shot img{display:block;width:100%;height:auto}
.box{position:absolute;border:2px solid #e5322d;background:rgba(229,50,45,.12);box-sizing:border-box}
.box b{position:absolute;left:-2px;top:-18px;background:#e5322d;color:#fff;font:11px/16px sans-serif;padding:0 5px;border-radius:3px}
`;

function detailText(f: Finding): string {
  return Object.entries(f.detail)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

export function reportToHtml(report: LintReport, shots: PageShot[]): string {
  const total = report.findings.length;
  const parts: string[] = [];
  parts.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>llm-page-lint report</title><style>${CSS}</style></head><body>`);
  parts.push(`<h1>llm-page-lint report</h1>`);
  parts.push(
    `<div class="meta">${esc(report.inputs.join(', '))} &middot; viewports ${esc(report.viewports.join(', '))} &middot; ${esc(report.seconds)} s &middot; ` +
      (total ? `<span class="bad">${total} findings</span>` : `<span class="ok">0 findings</span>`) +
      ` &middot; rejected from browser: ${report.rejectedFromBrowser}</div>`,
  );

  // Findings are numbered globally; the numbers match the boxes on the screenshots.
  const numbered = report.findings.map((f, i) => ({ f, n: i + 1 }));
  // Findings are stored in page order (input, then viewport), so each page owns a slice of them.
  const slices = new Map<string, typeof numbered>();
  let offset = 0;
  for (const p of report.pages) {
    slices.set(`${p.input}|${p.viewport}`, numbered.slice(offset, offset + p.findings));
    offset += p.findings;
  }

  for (const shot of shots) {
    const items = slices.get(`${shot.input}|${shot.viewport}`) ?? [];
    parts.push(`<h2>${esc(shot.input)} &middot; ${shot.viewport}px</h2>`);
    parts.push(`<div class="shot" style="width:${shot.width}px"><img alt="screenshot ${shot.viewport}px" src="data:image/jpeg;base64,${shot.jpeg.toString('base64')}">`);
    for (const { f, n } of items) {
      const { x, y, w, h } = f.rect;
      if (y > shot.height || x > shot.width) continue;
      const pct = (v: number, total: number) => ((v / total) * 100).toFixed(3) + '%';
      parts.push(
        `<div class="box" style="left:${pct(x, shot.width)};top:${pct(y, shot.height)};width:${pct(Math.max(w, 4), shot.width)};height:${pct(Math.max(h, 4), shot.height)}"><b>${n}</b></div>`,
      );
    }
    parts.push(`</div>`);
  }

  parts.push(`<h2>Findings</h2>`);
  if (!total) {
    parts.push(`<p class="ok">No findings.</p>`);
  } else {
    parts.push(`<table><tr><th>#</th><th>kind</th><th>viewport</th><th>section</th><th>selector</th><th>detail</th></tr>`);
    for (const { f, n } of numbered) {
      parts.push(
        `<tr><td>${n}</td><td>${esc(f.kind)}</td><td>${f.viewport}</td><td>${esc(f.section ?? '-')}</td><td><code>${esc(f.selector)}</code></td><td><code>${esc(detailText(f))}</code></td></tr>`,
      );
    }
    parts.push(`</table>`);
  }

  if (report.contrast.length) {
    parts.push(`<h2>Contrast over images (measured from pixels)</h2><table><tr><th>selector</th><th>viewport</th><th>ratio</th><th>need</th><th>result</th></tr>`);
    for (const c of report.contrast) {
      parts.push(
        `<tr><td><code>${esc(c.selector)}</code></td><td>${c.viewport}</td><td>${c.ratio}</td><td>${c.need}</td><td class="${c.pass ? 'ok' : 'bad'}">${c.pass ? 'pass' : 'fail'}</td></tr>`,
      );
    }
    parts.push(`</table>`);
  }
  parts.push(`<p class="meta">llm-page-lint ${esc(report.tool.version)} &middot; schemaVersion ${report.schemaVersion}</p></body></html>\n`);
  return parts.join('\n');
}
