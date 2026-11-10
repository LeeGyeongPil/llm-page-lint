# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.4] - 2026-11-11

### Fixed
- An invalid CSS selector in `--ignore` (or `lint({ ignore })`) is now rejected with a one-line `InputError` (exit code 2) before any input page is opened, instead of a Playwright stack trace.

### Known limitations
- The error message names the CLI option (`--ignore`) even when the check is triggered through the library call `lint({ ignore })`.
- `detectPage(page, { ignore })` does not pre-validate selectors; an invalid selector there still surfaces the browser's `SyntaxError`.

## [0.1.3] - 2026-11-10

### Changed
- README: replaced the tool comparison table with a short "when to use" section.

## [0.1.2] - 2026-11-10

### Fixed
- Tests now pass on Linux runners (Playwright looks for browsers in `$XDG_CACHE_HOME/ms-playwright` there); the test helper pins `PLAYWRIGHT_BROWSERS_PATH`, also handling `0` and relative values.
- "Chromium not installed" error now adds a note and the fix when Linux + `XDG_CACHE_HOME` is the likely cause.
- On timeout the browser is killed right away, so the whole run stays within the limit on slow runners.
- `fixtures/defects.html` yields all 8 defect kinds regardless of the installed font.

### Changed
- CI: diagnostic steps (runtime, browser and fonts, on-failure re-run) added to the workflow.

### Added
- `refine`: section-level judge + fixer loop that keeps a patch only if deterministic measurement improves (experimental, undocumented; mock judge/fixer by default).

## [0.1.1] - 2026-11-10

### Fixed
- `npm test` uses a glob (`node --test "test/*.test.mjs"`); passing a folder failed on Node 22/24.
- CI matrix now runs Node 22, 24 and 26 on ubuntu-24.04.
- Failed or timed-out runs no longer leave an empty `--out` / cache folder behind.

### Docs
- README: default report location, cache growth, `check fixtures` timing out on `hang.html`.

## [0.1.0] - 2026-11-10

### Added
- `check`: 8 reference-free render defect detectors (orphan punctuation, overlapping text, clipped text, off-screen text, empty box, cut image, low contrast over image, changing text).
- Parent-side re-validation of everything the page-side measurement returns.
- `report.json` and a self-contained `report.html`; exit codes 0/1/2/3; whole-run `--timeout`.
- `demo` command and `lint()` / `detectPage()` library API.
