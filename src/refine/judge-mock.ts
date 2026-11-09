// Practice judge: a rule-based scorer computed from the deterministic findings (no model involved).

import { CRITERIA, type Criterion, type FindingKind, type Instruction, type Judge, type JudgeInput, type Judgement } from '../types.js';

/** Which criterion a defect hurts most (4 points) and next (2 points). */
const IMPACT: Record<FindingKind, [Criterion, Criterion]> = {
  orphan_punct: ['readability', 'spacing'],
  overlap_text: ['layout', 'readability'],
  clipped_text: ['readability', 'completeness'],
  offscreen_text: ['responsive', 'completeness'],
  empty_box: ['completeness', 'hierarchy'],
  cut_image: ['layout', 'completeness'],
  low_contrast_over_image: ['readability', 'hierarchy'],
  changing_text: ['completeness', 'readability'],
};

const TEXT: Record<FindingKind, string> = {
  orphan_punct: 'Keep the trailing punctuation on the same line as its word',
  overlap_text: 'Separate the overlapping text blocks',
  clipped_text: 'Let the text box grow so no line is cut off',
  offscreen_text: 'Bring the off-screen text back into the visible area',
  empty_box: 'Remove the empty decorated box or fill it',
  cut_image: 'Stop the container from cutting the image',
  low_contrast_over_image: 'Use a text colour with enough contrast over the image',
  changing_text: 'Make the text stable between two reads',
};

export class MockJudge implements Judge {
  readonly name = 'mock-rules';

  async judge(input: JudgeInput): Promise<Judgement> {
    const scores = Object.fromEntries(CRITERIA.map((c) => [c, 10])) as Record<Criterion, number>;
    for (const f of input.findings) {
      const [main, side] = IMPACT[f.kind];
      scores[main] = Math.max(0, scores[main] - 4);
      scores[side] = Math.max(0, scores[side] - 2);
    }
    const overall = Math.round((CRITERIA.reduce((s, c) => s + scores[c], 0) / CRITERIA.length) * 100) / 100;
    const instructions: Instruction[] = input.findings.slice(0, 3).map((f) => ({ text: TEXT[f.kind], kind: f.kind, selector: f.selector }));
    return { scores, overall, instructions };
  }
}
