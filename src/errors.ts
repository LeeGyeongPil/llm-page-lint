// CLI 종료 코드와 연결되는 예외들. 0 결함 없음 / 1 결함 / 2 실행 오류 / 3 시간 초과.

/** 전체 시간 상한을 넘었다(종료 코드 3). 브라우저는 이미 닫힌 상태로 던진다. */
export class LintTimeoutError extends Error {
  readonly exitCode = 3;
  constructor(readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms — the page may be stuck in a script loop (browser was closed)`);
    this.name = 'LintTimeoutError';
  }
}

/**
 * 리눅스의 함정: Playwright 는 브라우저를 `$XDG_CACHE_HOME/ms-playwright` 에서 찾는다.
 * 보고서 위치를 옮기려고 XDG_CACHE_HOME 만 바꾸면 설치된 Chromium 이 "없는" 것처럼 보이므로 그 경우를 짚어 준다.
 */
function xdgHint(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'linux' || env.PLAYWRIGHT_BROWSERS_PATH || !env.XDG_CACHE_HOME) return '';
  return (
    `\n  note: on Linux Playwright looks in $XDG_CACHE_HOME/ms-playwright (${env.XDG_CACHE_HOME}/ms-playwright).` +
    '\n  if Chromium was installed without that XDG_CACHE_HOME, set PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright' +
    ' or use --out instead of changing XDG_CACHE_HOME'
  );
}

/** 헤드리스 Chromium 이 설치되어 있지 않다(종료 코드 2). */
export class BrowserMissingError extends Error {
  readonly exitCode = 2;
  constructor(cause?: unknown, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
    super(
      'headless Chromium for Playwright is not installed.\n' +
        '  run: npx playwright install chromium --only-shell\n' +
        '  (or set PLAYWRIGHT_BROWSERS_PATH to where it is installed)' +
        xdgHint(env, platform),
      { cause },
    );
    this.name = 'BrowserMissingError';
  }
}

/** 입력·옵션이 잘못됐다(종료 코드 2). */
export class InputError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}
