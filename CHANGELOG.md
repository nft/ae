# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] — 2026-07-20

### Added

- `.input()` now binds radio groups (`Signal<string>` holding the group value;
  the signal enforces exclusivity across all bound radios, even without
  `name=`) and `<select multiple>` (`Signal<string[]>`, values in option
  order, set semantics for duplicate option values — write a new array).
- `ae.observe(shadowRoot)` extends liveness into shadow trees: existing
  marked content mounts immediately, host removal/re-insertion unmounts and
  remounts the subtree, moves into unobserved roots unmount, and observation
  is refcounted per root with idempotent disposers.
- Real-browser test suite (Playwright — Chromium, Firefox, WebKit) covering
  native keyboard activation, scroll prevention, focus traversal, View
  Transitions, MutationObserver timing, and shadow-root liveness; runs in CI
  alongside the jsdom suite.
- TypeScript declarations for the `@aeroapp/ae/min` subpath.

### Changed

- Computed propagation reworked to dirty-marking with lazy pull: a computed
  re-evaluates at most once per flush and dependents are notified only when
  the final value actually changed — diamond-shaped graphs no longer cause
  spurious effect runs. Unobserved computeds skip re-evaluation entirely
  until read. Computed functions should be pure: they may run when upstream
  values turn out unchanged.
- `.press()` keyboard activation is native-like: Enter fires on keydown (key
  repeats included), Space fires once on keyup (keydown only prevents page
  scroll; moving focus mid-press cancels), and keys originating in nested
  native controls or editable text are ignored instead of hijacked.
- Source split into focused modules (`reactivity`, `registry`, `lifecycle`,
  `handle`, with `src/ae.ts` as the public barrel); public API and the
  single-file minified build are unchanged.
- Published type declarations no longer expose internal members.
- The landing page ships a committed Tailwind stylesheet instead of the
  development-only Play CDN, and Pages deploys and npm releases are gated on
  the test suites.
- Bundle size: 3.9 KB min+gzip (was 3.2 KB).

### Fixed

- Removing a `.list` container now unmounts the bindings of its stamped
  rows — previously their cleanups never ran and their effects stayed
  subscribed to signals (memory leak, detached-DOM updates).
- A computed whose evaluation throws no longer caches `undefined` forever:
  the first-read throw propagates and the next read retries; a throw during
  a flush is logged, subscribers keep the last good value, and the computed
  recovers automatically on the next dependency write. Errors can no longer
  escape to whoever wrote the signal or starve sibling subscribers.
- A throwing `.scope()` cleanup no longer leaves stale scoped handles behind
  (which stacked duplicate bindings on remount).
- The GitHub release step no longer masks real failures.

### Security

- The dev server (`bun run serve`) binds to localhost, accepts only GET/HEAD,
  and serves an explicit allowlist with decoded-segment validation — it
  previously exposed every repository file (including `.git/`) on all
  interfaces.

## [0.5.0] — 2026-07-19

### Added

- Published to npm as `@aeroapp/ae` (trusted publishing with provenance),
  with CI, GitHub Pages deployment, and release workflows.
- Logo, README badges, and install/CDN documentation.

### Changed

- Site moved to `site/` with full-width layout and mobile overflow fixes.

## [0.4.0] — 2026-07-11

### Added

- `ae.transition(fn)` — run signal writes inside a View Transition, with the
  "new" snapshot taken only after ae has settled; plain-call fallback where
  unsupported.
- `ae.settled()` — promise that resolves once writes, list stamping, and the
  mount pipeline have drained.
- Kanban demo, keyed-list benchmark (`examples/`), and the one-page site.

## [0.3.0] — 2026-07-11

### Added

- Initial library: `data-ae` handles with live mount/cleanup via a shared
  MutationObserver; signals, computeds, effects; `.render`, `.mount`,
  `.press`, `.hover`, `.on`; reactive sugar (`.text`/`.cls`/`.attr`/`.show`);
  two-way `.input()` with echo guards; keyed `.list()` stamping from native
  templates; scoped handles and `.scope()`; `ae.parts` and `ae.itemOf`.

[Unreleased]: https://github.com/nft/ae/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/nft/ae/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/nft/ae/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/nft/ae/compare/6136f95...v0.4.0
[0.3.0]: https://github.com/nft/ae/commits/6136f95
