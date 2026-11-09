// Minimal library usage: lint one file and print what was found.
// Run from the repo root after `npm run build`:  node examples/api.mjs [file.html]
import { fileURLToPath } from 'node:url';
import { lint } from '../dist/index.js';

const file = process.argv[2] ?? fileURLToPath(new URL('../fixtures/defects.html', import.meta.url));
const report = await lint({ file }, { viewports: [1024] });

console.log(`${report.findings.length} findings in ${file}`);
for (const f of report.findings) console.log(`- ${f.kind} ${f.selector}`);
