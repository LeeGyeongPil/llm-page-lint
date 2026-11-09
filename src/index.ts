// Public API of llm-page-lint. Everything not exported here is internal and may change.

export { lint, detectPage, VERSION, DEFAULT_VIEWPORTS } from './lint.js';
export { refine } from './refine/loop.js';
export { MockJudge } from './refine/judge-mock.js';
export { MockFixer } from './refine/fixer-mock.js';
export { OpenAIJudge, OpenAIFixer, configFromEnv } from './refine/openai.js';
export { validateFindings, MAX_FINDINGS } from './validate.js';
export { contrastRatio, luminance } from './contrast.js';
export type { RGB } from './contrast.js';
export { installGuards } from './browser/init.js';
export { BrowserMissingError, InputError, LintTimeoutError } from './errors.js';
export { FINDING_KINDS } from './types.js';
export type {
  ContrastCheck,
  Finding,
  Fixer,
  Judge,
  Judgement,
  RefineOptions,
  RefineReport,
  SectionOutcome,
  FindingKind,
  LintInput,
  LintOptions,
  LintReport,
  PageResult,
  Rect,
} from './types.js';
