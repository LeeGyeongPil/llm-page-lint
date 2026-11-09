# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
