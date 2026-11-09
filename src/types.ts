// 공개 타입 모음 — 보고서(report.json)의 모양도 여기서 정해진다.

/** 탐지기 8종. 순서는 보고서 요약표의 열 순서이기도 하다. */
export const FINDING_KINDS = [
  'orphan_punct',
  'overlap_text',
  'clipped_text',
  'offscreen_text',
  'empty_box',
  'cut_image',
  'low_contrast_over_image',
  'changing_text',
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 부모(Node) 측 재검증을 통과한 결함 1건. 좌표는 페이지(문서) 좌표, CSS px. */
export interface Finding {
  kind: FindingKind;
  /** 결함이 있는 요소를 가리키는 CSS 선택자(최대 200자) */
  selector: string;
  /** 속한 섹션 이름(data-section 값 또는 최상위 section/header/footer 의 id·태그), 없으면 null */
  section: string | null;
  /** 측정한 뷰포트 너비(px) */
  viewport: number;
  rect: Rect;
  /** 종류별 수치·설명(문자열·숫자·불리언만) */
  detail: Record<string, string | number | boolean>;
}

/** 이미지·그라디언트 위 글자 하나에 대해 픽셀로 잰 대비(통과·실패 모두 기록). */
export interface ContrastCheck {
  selector: string;
  viewport: number;
  color: string;
  /** 배경 픽셀 대비의 하위 10% 분위 값 */
  ratio: number;
  /** 필요한 비율(보통 글자 4.5, 큰 글자 3) */
  need: number;
  pass: boolean;
}

export type LintInput = { html: string; baseDir?: string } | { file: string } | { url: string };

export interface LintOptions {
  /** 뷰포트 너비 목록(기본 375, 768, 1280) */
  viewports?: number[];
  /** 전체 시간 상한(ms, 기본 60000). 넘으면 LintTimeoutError */
  timeoutMs?: number;
  /** 바뀌는 글자 탐지(1.2초 간격 두 번 읽기, 첫 뷰포트에서만). 기본 true */
  changingText?: boolean;
  /** 이 선택자에 걸리는 요소(와 그 안쪽)는 검사하지 않는다 */
  ignore?: string[];
  /** 보고서용 전체 페이지 스크린샷을 함께 찍는다(기본 false) */
  screenshots?: boolean;
  /** 브라우저가 실행되면 호출된다(시험에서 종료 후 닫혔는지 확인하는 용도) */
  onBrowser?: (browser: import('playwright').Browser) => void;
}

export interface PageResult {
  /** 사람이 읽는 입력 이름(파일 경로·URL·"<html>") */
  input: string;
  viewport: number;
  /** 문서 전체 크기(px) */
  pageWidth: number;
  pageHeight: number;
  findings: number;
  /** 블록당 글자 상한에 걸려 일부만 측정했으면 true */
  truncated: boolean;
}

export interface LintReport {
  schemaVersion: 1;
  tool: { name: 'llm-page-lint'; version: string };
  inputs: string[];
  viewports: number[];
  seconds: number;
  findings: Finding[];
  /** 브라우저가 돌려줬지만 부모 측 재검증에서 버린 항목 수 */
  rejectedFromBrowser: number;
  contrast: ContrastCheck[];
  pages: PageResult[];
}

/** 보고서 HTML 에 넣을 스크린샷(JPEG). report.json 에는 넣지 않는다. */
export interface PageShot {
  input: string;
  viewport: number;
  width: number;
  height: number;
  jpeg: Buffer;
}

// ---------- refine(다듬기 루프) ----------

export const CRITERIA = ['layout', 'readability', 'hierarchy', 'spacing', 'responsive', 'completeness'] as const;
export type Criterion = (typeof CRITERIA)[number];

export interface Instruction {
  /** 무엇을 고칠지 한 문장 */
  text: string;
  /** 관련 결함 종류(있으면) */
  kind?: FindingKind;
  /** 관련 요소 선택자(있으면) */
  selector?: string;
}

export interface Judgement {
  scores: Record<Criterion, number>;
  /** 6기준 평균(0~10) */
  overall: number;
  /** 수정 지시(최대 3개) */
  instructions: Instruction[];
}

export interface JudgeInput {
  sectionId: string;
  sectionHtml: string;
  /** 이 섹션이 담당하는 결정적 결함 */
  findings: Finding[];
}

export interface FixerInput extends JudgeInput {
  pageHtml: string;
  /** 섹션이 페이지 원본 안에서 차지하는 위치 [시작, 끝) */
  range: [number, number];
  /** 섹션을 가리키는 CSS 선택자(목 수정자가 스타일 범위를 한정할 때 쓴다) */
  scope: string;
  instructions: Instruction[];
}

/** 판정자: 섹션을 채점하고 수정 지시를 낸다. JSON 이 깨지면 null(그 섹션은 건너뛴다). */
export interface Judge {
  name: string;
  judge(input: JudgeInput): Promise<Judgement | null>;
}

/** 수정자: 고친 "페이지 전체" HTML 을 돌려준다. 섹션 밖을 바꾸면 게이트가 거부한다. 못 고치면 null. */
export interface Fixer {
  name: string;
  fix(input: FixerInput): Promise<{ pageHtml: string } | null>;
}

export interface RefineOptions {
  judge?: Judge;
  fixer?: Fixer;
  /** 손볼 섹션 수 상한(기본 3) */
  maxSections?: number;
  /** 섹션 점수 최소 상승폭(기본 0.5) */
  minGain?: number;
  /** 전체 예산(초, 기본 120). 넘으면 남은 섹션은 원본 유지 */
  budgetSeconds?: number;
  /** 뷰포트(기본 [1280]) */
  viewports?: number[];
  /** 렌더 1회의 시간 상한(ms, 기본 60000) */
  timeoutMs?: number;
  /** 섹션 before/after 스크린샷을 남긴다(기본 false) */
  screenshots?: boolean;
  /** 진행 상황 한 줄씩 */
  log?: (line: string) => void;
}

export interface SectionScore {
  overall: number;
  scores: Record<Criterion, number>;
  findings: number;
}

export interface SectionOutcome {
  id: string;
  before: SectionScore | null;
  after: SectionScore | null;
  accepted: boolean;
  /** accepted | reverted (…) | skipped (…) | not attempted (…) */
  reason: string;
  /** 사람이 읽는 보충 설명(예: "clipped_text 0→1") */
  note: string;
  instructions: Instruction[];
}

export interface RefineReport {
  schemaVersion: 1;
  input: string;
  mode: { judge: string; fixer: string; mock: boolean; note: string };
  viewports: number[];
  minGain: number;
  seconds: number;
  findingsBefore: number;
  findingsAfter: number;
  sections: SectionOutcome[];
  /** 최종(채택된 패치만 반영한) HTML */
  refinedHtml: string;
}

export interface SectionShot {
  id: string;
  before?: Buffer;
  after?: Buffer;
}
