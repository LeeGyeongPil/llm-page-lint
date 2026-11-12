// Screen language for the CLI and report.html: English and Korean, chosen by the user.
//
// Order: --lang en|ko > LLM_PAGE_LINT_LANG > LC_ALL > LC_MESSAGES > LANG. Anything that is not Korean is English.
// All user-visible text lives in the two tables below (same keys, checked by test/i18n.test.mjs).
// Not translated on purpose: finding kind IDs, selectors, detail key=value pairs, input paths,
// and everything written to report.json / refine.json / --json (machine output is language-independent).

export type Lang = 'en' | 'ko';
export const LANGS: readonly Lang[] = ['en', 'ko'];

export function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'ko';
}

/** Value of LLM_PAGE_LINT_LANG: only "en" or "ko" (optionally with a locale suffix) is accepted, anything else is skipped. */
function parseToolLang(v: string | undefined): Lang | undefined {
  const m = /^(en|ko)(?![A-Za-z])/i.exec((v ?? '').trim());
  return m ? (m[1].toLowerCase() as Lang) : undefined;
}

/** Value of LC_ALL / LC_MESSAGES / LANG: "ko", "ko_KR.UTF-8", "ko-KR" are Korean; anything else (fr_FR, C, POSIX) is English. */
function parseLocale(v: string): Lang {
  return /^ko(?![A-Za-z])/i.test(v.trim()) ? 'ko' : 'en';
}

/** Pick the screen language. `argLang` is the already validated --lang value (or undefined). */
export function resolveLang(opts: { argLang?: string; env?: NodeJS.ProcessEnv } = {}): Lang {
  const env = opts.env ?? process.env;
  if (isLang(opts.argLang)) return opts.argLang;
  const tool = parseToolLang(env.LLM_PAGE_LINT_LANG);
  if (tool) return tool;
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = env[name];
    if (v && v.trim()) return parseLocale(v); // an empty value counts as unset
  }
  return 'en';
}

const en = {
  // ---- CLI general
  'error.prefix': 'error:',
  help: `llm-page-lint {version} — find visual defects in LLM-generated HTML without reference images

Usage:
  llm-page-lint check <input...> [options]   input = .html file, folder of .html files, or http(s) URL
  llm-page-lint refine <file.html> [options] fix the worst sections with a judge + fixer, keep only what measures better
  llm-page-lint demo                         check the bundled defect fixture (always exits 0)
  llm-page-lint --version | --help

global options:
  --lang <en|ko>         screen language (default: LLM_PAGE_LINT_LANG, then LC_ALL, LC_MESSAGES, LANG; Korean if it starts with ko, else English)

check options:
  --viewports <list>     comma-separated widths in px (default 375,768,1280)
  --out <dir>            write report.json and report.html here (default: XDG cache, see last output line)
  --json                 print the JSON report to stdout instead of the summary
  --fail-on <kinds>      only these finding kinds cause exit code 1 (comma-separated); others are warnings
  --ignore <selector>    skip elements matching this CSS selector (repeatable)
  --timeout <ms>         whole-run time limit (default 60000); exceeded => exit code 3
  --no-changing-text     skip the 1.2 s double-read for self-changing text

refine options:
  --judge mock|openai    default mock (practice rule scorer, no model); openai needs LLM_PAGE_LINT_BASE_URL
  --fixer mock|openai    default mock (practice CSS prescriptions)
  --max-sections <n>     sections to try (default 3)
  --min-gain <x>         minimum score gain to keep a patch (default 0.5)
  --budget-seconds <n>   total budget (default 120); remaining sections stay as they are
  --viewports <list>     widths to measure (default 1280)
  --out <dir>            write refine.json and refined.html here (default: XDG cache)
  --write                also overwrite the input file with the refined HTML

finding kinds: {kinds}
exit codes: 0 no findings, 1 findings, 2 usage or run error, 3 timeout
`,
  // ---- CLI summary
  'summary.checked': 'checked {pages} page render(s) at {viewports}px in {seconds}s',
  'summary.kind': 'kind',
  'summary.count': 'count',
  'summary.none': '(none)',
  'summary.findings': '{n} findings',
  'summary.counted': ' ({n} count toward the exit code)',
  'summary.rejected': 'rejected from browser: {n} item(s) failed parent-side validation',
  'summary.demo': 'demo only: a real "check" on this page would exit with code {code}',
  'summary.report': 'report: {path}',
  // ---- CLI refine screen
  'refine.mockMode': '[{note}]',
  'refine.realMode': '[{note}] (experimental)',
  'refine.result': 'refined {file}: {before} -> {after} findings in {seconds}s',
  'refine.section': 'section',
  'refine.outcome': 'result',
  'refine.report': 'report: {path} (input file {state})',
  'refine.overwritten': 'overwritten (--write)',
  'refine.unchanged': 'unchanged',
  'refine.fixing': 'fixing {id} ({n} defect(s))',
  // ---- refine reasons (fixed phrases of refine.json, shown translated only on screen)
  'reason.judgeUnusable': 'skipped (judge reply unusable)',
  'reason.noDefects': 'not attempted (no defects measured)',
  'reason.maxSections': 'not attempted (max-sections reached)',
  'reason.budget': 'not attempted (budget exhausted)',
  'reason.sectionNotFound': 'skipped (section not found)',
  'reason.fixerNothing': 'skipped (fixer returned nothing)',
  'reason.noChange': 'skipped (patch changed nothing)',
  'reason.detectionsIncreased': 'reverted (detections increased)',
  'reason.judgeUnusableAfter': 'skipped (judge reply unusable after patch)',
  'reason.accepted': 'accepted',
  'reason.gain': 'reverted (gain {gain} below min-gain {min})',
  'reason.reverted': 'reverted ({why})',
  'check.outside': 'changed outside the section',
  'check.structure': 'section structure changed (the patch left the section boundary)',
  'check.parse': 'parse errors increased',
  'check.unsafe': 'unsafe content added: {what}',
  'check.newUrl': 'new external URL',
  'note.total': 'total {a}→{b}',
  'note.accepted': 'findings {a}→{b}, score {x}→{y}',
  'note.mock': 'mock mode: practice mock judge and fixer. Scores are rule scores computed from the deterministic findings, not a model opinion.',
  'note.real': 'real mode: judge {judge}, fixer {fixer}',
  // ---- errors raised by the CLI itself
  'err.unknownCommand': 'unknown command "{cmd}": use check, refine, demo, --help',
  'err.langInvalid': '--lang must be en or ko, got "{value}"',
  'err.langMissing': '--lang needs a value: en or ko, e.g. --lang ko',
  'err.unknownOption': 'unknown option {option}: run llm-page-lint --help to see the options',
  'err.optionValueMissing': 'option {option} needs a value: run llm-page-lint --help to see the options',
  'err.optionNoValue': 'option {option} does not take a value: run llm-page-lint --help to see the options',
  'err.detectorLimit': 'detector returned {count} findings (limit {limit}); the page is probably hostile or broken — refusing to continue. Exclude repeated elements with --ignore <selector>, or split the page and check the parts separately',
  'err.viewportsList': 'invalid viewport width "{item}" in --viewports "{raw}": use whole numbers between 200 and 4000, e.g. --viewports 375,1280',
  'err.inputMissing': '"{path}" does not exist: pass an .html file, a folder, or an http(s) URL',
  'err.folderEmpty': 'folder "{path}" contains no .html files',
  'err.refineOneFile': 'refine needs exactly one .html file, e.g. llm-page-lint refine page.html',
  'err.number': '--{name} must be a number, got "{value}"',
  'err.mockOrOpenai': '--{name} must be mock or openai, got "{value}"',
  'err.checkNeedsInput': 'check needs at least one input, e.g. llm-page-lint check page.html',
  'err.failOn': 'unknown finding kind(s) in --fail-on: {bad}. valid: {valid}',
  'err.timeoutNumber': '--timeout must be a number of milliseconds, got "{value}"',
  'err.timeoutCli': '--timeout must be between 1000 and 2147483647 ms, got "{value}"',
  // ---- errors that come from library exceptions (InputError.code)
  'err.viewport': 'invalid viewport width "{value}": use whole numbers between 200 and 4000, e.g. --viewports 375,1280',
  'err.url_scheme': 'url "{url}" must start with http:// or https://',
  'err.no_input': 'no input: pass an HTML file, a folder of .html files, or a URL',
  'err.cannot_read': 'cannot read "{file}": check the path (relative paths are resolved from {cwd})',
  'err.timeout_range': 'timeoutMs must be between 1000 and {max} ms (CLI: --timeout <ms>), got {value}',
  'err.bad_selector': 'invalid CSS selector "{selector}" in --ignore: use a selector such as --ignore \'.ad-slot\'',
  'err.out_not_folder': '--out "{out}" exists and is not a folder; pass a folder path such as --out lint-report',
  'err.min_gain': 'min-gain must be a number >= 0',
  'err.max_sections': 'max-sections must be a whole number >= 1',
  'err.refine_cannot_read': 'cannot read "{file}": check the path',
  'err.no_sections': 'no sections found: mark sections with data-section="name" or use top-level <section>/<header>/<footer> elements',
  'err.openai_base_url': '--{role} openai needs LLM_PAGE_LINT_BASE_URL, e.g. export LLM_PAGE_LINT_BASE_URL=http://localhost:11434/v1',
  'err.openai_model_judge': '--judge openai needs LLM_PAGE_LINT_JUDGE_MODEL to name the model',
  'err.openai_model_fixer': '--fixer openai needs LLM_PAGE_LINT_FIXER_MODEL (or LLM_PAGE_LINT_JUDGE_MODEL) to name the model',
  'err.timeout': 'timed out after {ms} ms — the page may be stuck in a script loop (browser was closed)',
  'err.browserMissing':
    'headless Chromium for Playwright is not installed.\n' +
    '  run: npx playwright install chromium --only-shell\n' +
    '  (or set PLAYWRIGHT_BROWSERS_PATH to where it is installed)',
  'err.browserXdg':
    '\n  note: on Linux Playwright looks in $XDG_CACHE_HOME/ms-playwright ({xdg}/ms-playwright).' +
    '\n  if Chromium was installed without that XDG_CACHE_HOME, set PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright' +
    ' or use --out instead of changing XDG_CACHE_HOME',
  // ---- report.html
  'html.title': 'llm-page-lint report',
  'html.viewports': 'viewports',
  'html.findings': '{n} findings',
  'html.rejected': 'rejected from browser: {n}',
  'html.alt': 'screenshot {viewport}px',
  'html.h2Findings': 'Findings',
  'html.noFindings': 'No findings.',
  'html.thKind': 'kind',
  'html.thViewport': 'viewport',
  'html.thSection': 'section',
  'html.thSelector': 'selector',
  'html.thDetail': 'detail',
  'html.h2Contrast': 'Contrast over images (measured from pixels)',
  'html.thRatio': 'ratio',
  'html.thNeed': 'need',
  'html.thResult': 'result',
  'html.pass': 'pass',
  'html.fail': 'fail',
  'html.footer': 'llm-page-lint {version}',
} as const;

export type MessageKey = keyof typeof en;

const ko: Record<MessageKey, string> = {
  'error.prefix': '오류:',
  help: `llm-page-lint {version} — 기준 이미지 없이 LLM이 만든 HTML의 시각적 결함을 찾습니다

사용법:
  llm-page-lint check <입력...> [옵션]       입력 = .html 파일, .html 파일이 든 폴더, 또는 http(s) URL
  llm-page-lint refine <file.html> [옵션]    판정기와 수정기로 가장 나쁜 섹션을 고치고, 측정이 나아진 것만 남깁니다
  llm-page-lint demo                         포함된 결함 예제를 검사합니다(항상 종료코드 0)
  llm-page-lint --version | --help

공통 옵션:
  --lang <en|ko>         화면 언어(기본: LLM_PAGE_LINT_LANG, 그다음 LC_ALL, LC_MESSAGES, LANG 순. ko 로 시작하면 한국어, 아니면 영어)

check 옵션:
  --viewports <목록>     쉼표로 구분한 너비(px) (기본 375,768,1280)
  --out <폴더>           report.json 과 report.html 을 이 폴더에 씁니다(기본: XDG 캐시, 마지막 출력 줄 참고)
  --json                 요약 대신 JSON 보고서를 표준 출력으로 냅니다
  --fail-on <종류>       이 결함 종류만 종료코드 1 을 일으킵니다(쉼표로 구분). 나머지는 경고입니다
  --ignore <선택자>      이 CSS 선택자와 맞는 요소를 건너뜁니다(여러 번 지정 가능)
  --timeout <ms>         전체 실행 시간 제한(기본 60000). 넘으면 종료코드 3
  --no-changing-text     스스로 바뀌는 텍스트를 찾는 1.2초 재읽기를 건너뜁니다

refine 옵션:
  --judge mock|openai    기본 mock(연습용 규칙 채점기, 모델 없음). openai 는 LLM_PAGE_LINT_BASE_URL 설정이 필요합니다
  --fixer mock|openai    기본 mock(연습용 CSS 처방)
  --max-sections <n>     시도할 섹션 수(기본 3)
  --min-gain <x>         패치를 남기는 최소 점수 향상(기본 0.5)
  --budget-seconds <n>   전체 예산(기본 120). 남은 섹션은 그대로 둡니다
  --viewports <목록>     측정할 너비(기본 1280)
  --out <폴더>           refine.json 과 refined.html 을 이 폴더에 씁니다(기본: XDG 캐시)
  --write                입력 파일도 개선된 HTML 로 덮어씁니다

결함 종류: {kinds}
종료코드: 0 결함 없음, 1 결함 있음, 2 사용법 또는 실행 오류, 3 시간 초과
`,
  'summary.checked': '페이지 렌더 {pages}개를 {viewports}px 너비로 {seconds}초 동안 검사했습니다',
  'summary.kind': '종류',
  'summary.count': '개수',
  'summary.none': '(없음)',
  'summary.findings': '결함 {n}개',
  'summary.counted': ' (종료코드에 반영되는 결함 {n}개)',
  'summary.rejected': '브라우저에서 거부됨: 항목 {n}개가 부모 쪽 검증에 실패했습니다',
  'summary.demo': '데모 전용: 이 페이지에 실제 "check"를 실행하면 종료코드는 {code}입니다',
  'summary.report': '보고서: {path}',
  'refine.mockMode': '[{note}]',
  'refine.realMode': '[{note}] (실험적)',
  'refine.result': '{file} 개선 결과: 결함 {before}개 -> {after}개, {seconds}초',
  'refine.section': '섹션',
  'refine.outcome': '결과',
  'refine.report': '보고서: {path} (입력 파일 상태: {state})',
  'refine.overwritten': '덮어씀 (--write)',
  'refine.unchanged': '그대로',
  'refine.fixing': '{id} 수정 중 (결함 {n}개)',
  'reason.judgeUnusable': '건너뜀 (판정기 응답을 쓸 수 없음)',
  'reason.noDefects': '시도 안 함 (측정된 결함 없음)',
  'reason.maxSections': '시도 안 함 (max-sections 도달)',
  'reason.budget': '시도 안 함 (예산 소진)',
  'reason.sectionNotFound': '건너뜀 (섹션을 찾지 못함)',
  'reason.fixerNothing': '건너뜀 (수정기가 아무것도 돌려주지 않음)',
  'reason.noChange': '건너뜀 (패치가 아무것도 바꾸지 않음)',
  'reason.detectionsIncreased': '되돌림 (검출 증가)',
  'reason.judgeUnusableAfter': '건너뜀 (패치 후 판정기 응답을 쓸 수 없음)',
  'reason.accepted': '채택',
  'reason.gain': '되돌림 (향상 {gain}, min-gain {min} 미만)',
  'reason.reverted': '되돌림 ({why})',
  'check.outside': '섹션 밖이 바뀜',
  'check.structure': '섹션 구조가 바뀜 (패치가 섹션 경계를 벗어남)',
  'check.parse': '파싱 오류 증가',
  'check.unsafe': '안전하지 않은 내용 추가: {what}',
  'check.newUrl': '새 외부 URL',
  'note.total': '전체 {a}→{b}',
  'note.accepted': '결함 {a}→{b}, 점수 {x}→{y}',
  'note.mock': '목 모드: 연습용 목 판정기와 수정기입니다. 점수는 결정적 측정 결과로 계산한 규칙 점수이며 모델 의견이 아닙니다.',
  'note.real': '실제 모드: 판정기 {judge}, 수정기 {fixer}',
  'err.unknownCommand': '알 수 없는 명령: "{cmd}". check, refine, demo, --help 중에서 고르십시오',
  'err.langInvalid': '--lang 값은 en 또는 ko 여야 합니다: "{value}"',
  'err.langMissing': '--lang 에 값이 필요합니다: en 또는 ko. 예: --lang ko',
  'err.unknownOption': '알 수 없는 옵션: {option}. llm-page-lint --help 로 옵션을 확인하십시오',
  'err.optionValueMissing': '옵션 값이 없습니다: {option}. llm-page-lint --help 로 옵션을 확인하십시오',
  'err.optionNoValue': '옵션 {option} 에는 값을 붙이지 않습니다. llm-page-lint --help 로 옵션을 확인하십시오',
  'err.detectorLimit': '검출기가 결함 {count}개를 돌려줬습니다(상한 {limit}개). 페이지가 비정상일 가능성이 큽니다. 반복되는 요소는 --ignore <선택자> 로 제외하거나 페이지를 나눠 검사하십시오',
  'err.viewportsList': '--viewports "{raw}" 에 잘못된 뷰포트 너비가 있습니다: "{item}". 200에서 4000 사이의 정수를 쓰십시오. 예: --viewports 375,1280',
  'err.inputMissing': '"{path}" 경로가 없습니다. .html 파일, 폴더, 또는 http(s) URL을 지정하십시오',
  'err.folderEmpty': '폴더 "{path}" 안에 .html 파일이 없습니다',
  'err.refineOneFile': 'refine 에는 .html 파일이 정확히 하나 필요합니다. 예: llm-page-lint refine page.html',
  'err.number': '--{name} 값은 숫자여야 합니다: "{value}"',
  'err.mockOrOpenai': '--{name} 값은 mock 또는 openai 여야 합니다: "{value}"',
  'err.checkNeedsInput': 'check 에는 입력이 하나 이상 필요합니다. 예: llm-page-lint check page.html',
  'err.failOn': '--fail-on 에 알 수 없는 결함 종류가 있습니다: {bad}. 사용 가능한 종류: {valid}',
  'err.timeoutNumber': '--timeout 값은 밀리초 단위의 숫자여야 합니다: "{value}"',
  'err.timeoutCli': '--timeout 값은 1000에서 2147483647 ms 사이여야 합니다: "{value}"',
  'err.viewport': '잘못된 뷰포트 너비: "{value}". 200에서 4000 사이의 정수를 쓰십시오. 예: --viewports 375,1280',
  'err.url_scheme': 'URL은 http:// 또는 https:// 로 시작해야 합니다: "{url}"',
  'err.no_input': '입력이 없습니다. HTML 파일, .html 파일이 든 폴더, 또는 URL을 지정하십시오',
  'err.cannot_read': '"{file}" 파일을 읽을 수 없습니다. 경로를 확인하십시오(상대 경로는 {cwd} 기준으로 해석합니다)',
  'err.timeout_range': 'timeoutMs 는 1000에서 {max} ms 사이여야 합니다(CLI: --timeout <ms>): {value}',
  'err.bad_selector': '--ignore 에 잘못된 CSS 선택자가 있습니다: "{selector}". 예: --ignore \'.ad-slot\'',
  'err.out_not_folder': '--out 경로가 이미 있고 폴더가 아닙니다: "{out}". --out lint-report 처럼 폴더 경로를 지정하십시오',
  'err.min_gain': '--min-gain 값은 0 이상의 숫자여야 합니다',
  'err.max_sections': '--max-sections 값은 1 이상의 정수여야 합니다',
  'err.refine_cannot_read': '"{file}" 파일을 읽을 수 없습니다. 경로를 확인하십시오',
  'err.no_sections': '섹션을 찾지 못했습니다. data-section="이름" 으로 섹션을 표시하거나 최상위 <section>/<header>/<footer> 요소를 사용하십시오',
  'err.openai_base_url': '--{role} openai 를 쓰려면 환경변수 LLM_PAGE_LINT_BASE_URL 설정이 필요합니다. 예: export LLM_PAGE_LINT_BASE_URL=http://localhost:11434/v1',
  'err.openai_model_judge': '--judge openai 를 쓰려면 모델 이름을 정하는 환경변수 LLM_PAGE_LINT_JUDGE_MODEL 설정이 필요합니다',
  'err.openai_model_fixer': '--fixer openai 를 쓰려면 모델 이름을 정하는 환경변수 LLM_PAGE_LINT_FIXER_MODEL(또는 LLM_PAGE_LINT_JUDGE_MODEL) 설정이 필요합니다',
  'err.timeout': '{ms} ms 후 시간 초과: 페이지가 스크립트 루프에 갇혔을 수 있습니다(브라우저는 닫았습니다)',
  'err.browserMissing':
    'Playwright용 헤드리스 Chromium이 설치되어 있지 않습니다.\n' +
    '  실행: npx playwright install chromium --only-shell\n' +
    '  (또는 PLAYWRIGHT_BROWSERS_PATH 를 설치된 위치로 지정하십시오)',
  'err.browserXdg':
    '\n  참고: Linux 에서 Playwright 는 $XDG_CACHE_HOME/ms-playwright ({xdg}/ms-playwright) 에서 브라우저를 찾습니다.' +
    '\n  그 설정 없이 Chromium을 설치했다면 PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright 로 지정하거나,' +
    ' XDG_CACHE_HOME 을 바꾸는 대신 --out 을 사용하십시오',
  'html.title': 'llm-page-lint 보고서',
  'html.viewports': '뷰포트',
  'html.findings': '결함 {n}개',
  'html.rejected': '브라우저에서 거부됨: {n}',
  'html.alt': '{viewport}px 스크린샷',
  'html.h2Findings': '결함 목록',
  'html.noFindings': '결함이 없습니다.',
  'html.thKind': '종류',
  'html.thViewport': '뷰포트',
  'html.thSection': '섹션',
  'html.thSelector': '선택자',
  'html.thDetail': '상세',
  'html.h2Contrast': '이미지 위 대비 (픽셀에서 측정)',
  'html.thRatio': '비율',
  'html.thNeed': '기준',
  'html.thResult': '결과',
  'html.pass': '통과',
  'html.fail': '실패',
  'html.footer': 'llm-page-lint {version}',
};

/** The two message tables (exported for the key-parity test). */
export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, ko };

/** Look up a message and fill its {name} placeholders. */
export function t(lang: Lang, key: MessageKey, params: Record<string, string | number> = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Map an English refine.json phrase (reason / note / progress line) to the screen language; unknown text stays as it is. */
export function translateRefineText(lang: Lang, text: string): string {
  if (lang === 'en' || !text) return text;
  const fixed: [string, MessageKey][] = [
    ['skipped (judge reply unusable)', 'reason.judgeUnusable'],
    ['not attempted (no defects measured)', 'reason.noDefects'],
    ['not attempted (max-sections reached)', 'reason.maxSections'],
    ['not attempted (budget exhausted)', 'reason.budget'],
    ['skipped (section not found)', 'reason.sectionNotFound'],
    ['skipped (fixer returned nothing)', 'reason.fixerNothing'],
    ['skipped (patch changed nothing)', 'reason.noChange'],
    ['reverted (detections increased)', 'reason.detectionsIncreased'],
    ['skipped (judge reply unusable after patch)', 'reason.judgeUnusableAfter'],
    ['accepted', 'reason.accepted'],
    [en['note.mock'], 'note.mock'],
  ];
  for (const [phrase, key] of fixed) if (text === phrase) return t(lang, key);

  let m = /^reverted \(gain (\S+) below min-gain (\S+)\)$/.exec(text);
  if (m) return t(lang, 'reason.gain', { gain: m[1], min: m[2] });
  m = /^reverted \((.+)\)$/.exec(text);
  if (m) {
    const why = m[1];
    const plain: [string, MessageKey][] = [
      ['changed outside the section', 'check.outside'],
      ['section structure changed (the patch left the section boundary)', 'check.structure'],
      ['parse errors increased', 'check.parse'],
    ];
    for (const [phrase, key] of plain) if (why === phrase) return t(lang, 'reason.reverted', { why: t(lang, key) });
    const u = /^unsafe content added: (.+)$/.exec(why);
    if (u) {
      const what = u[1] === 'new external URL' ? t(lang, 'check.newUrl') : u[1];
      return t(lang, 'reason.reverted', { why: t(lang, 'check.unsafe', { what }) });
    }
    return t(lang, 'reason.reverted', { why });
  }
  m = /^total (\d+)→(\d+)$/.exec(text);
  if (m) return t(lang, 'note.total', { a: m[1], b: m[2] });
  m = /^findings (\d+)→(\d+), score (\S+)→(\S+)$/.exec(text);
  if (m) return t(lang, 'note.accepted', { a: m[1], b: m[2], x: m[3], y: m[4] });
  m = /^real mode: judge (.+), fixer (.+)$/.exec(text);
  if (m) return t(lang, 'note.real', { judge: m[1], fixer: m[2] });
  m = /^fixing (.+) \((\d+) defect\(s\)\)$/.exec(text);
  if (m) return t(lang, 'refine.fixing', { id: m[1], n: m[2] });
  return text;
}
