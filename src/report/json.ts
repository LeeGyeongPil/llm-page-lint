// report.json — fixed schema (schemaVersion 1). Screenshots are never stored here.

import type { LintReport } from '../types.js';

export function reportToJson(report: LintReport): string {
  const ordered = {
    schemaVersion: report.schemaVersion,
    tool: report.tool,
    inputs: report.inputs,
    viewports: report.viewports,
    seconds: report.seconds,
    findings: report.findings,
    rejectedFromBrowser: report.rejectedFromBrowser,
    contrast: report.contrast,
    pages: report.pages,
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}
