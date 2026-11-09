// Optional comparison: what does axe-core say about the defect fixture vs. llm-page-lint?
// Run: npm run compare:axe   (needs the dev dependencies and an installed Chromium)
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { lint } from '../dist/index.js';
import { launchBrowser, closeBrowser } from '../dist/render.js'; // internal helper: handles restricted sandboxes

const file = process.argv[2] ?? fileURLToPath(new URL('../fixtures/defects.html', import.meta.url));
const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1024, height: 800 } }); // axe needs an explicit context
  const page = await context.newPage();
  await page.goto(pathToFileURL(file).href);
  const axe = await new AxeBuilder({ page }).analyze();
  console.log(`axe-core: ${axe.violations.length} violations, ${axe.incomplete.length} incomplete (needs manual review)`);
  for (const v of axe.violations) console.log(`  violation ${v.id}`);
  for (const v of axe.incomplete) console.log(`  incomplete ${v.id}`);
} finally {
  await closeBrowser(browser);
}
const report = await lint({ file }, { viewports: [1024] });
console.log(`llm-page-lint: ${report.findings.length} findings`);
for (const f of report.findings) console.log(`  ${f.kind} ${f.selector}`);
