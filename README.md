<p align="center">
  <img src="site/logo.svg" alt="ae logo" width="180" />
</p>

# ae

[![npm](https://img.shields.io/npm/v/%40aeroapp%2Fae?label=npm&color=b45309)](https://www.npmjs.com/package/@aeroapp/ae)
[![CI](https://github.com/nft/ae/actions/workflows/ci.yml/badge.svg)](https://github.com/nft/ae/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-stone)](LICENSE)

Tiny attribute-based behavior + reactivity library. **HTML is the source of
truth** — you write real markup, `ae` attaches behavior to it. No virtual DOM,
no hydration, no template syntax, no build step required.

**3.2 KB** min+gzip · zero dependencies · TypeScript · one `data-ae` attribute

## Install

```sh
npm install @aeroapp/ae
yarn add @aeroapp/ae
pnpm add @aeroapp/ae
bun add @aeroapp/ae
```

Or straight from a CDN, no tooling at all — esm.sh, unpkg, and jsDelivr all
serve it the moment you need it:

```html
<script type="module">
  import { ae } from 'https://esm.sh/@aeroapp/ae';
  // or: 'https://unpkg.com/@aeroapp/ae'                  (minified build)
  // or: 'https://cdn.jsdelivr.net/npm/@aeroapp/ae/+esm'
</script>
```

Pin an exact version in production — `https://esm.sh/@aeroapp/ae@X.Y.Z` (see
the npm badge above for the current release).

```html
<button data-ae="save">Save</button>
<span data-ae="status"></span>
```

```js
import { ae } from '@aeroapp/ae';

const count = ae.signal(0);

ae('status').render(el => el.textContent = `${count.value} items`);

ae('save')
  .press(() => count.value++)
  .hover(el => el.classList.add('hot'), el => el.classList.remove('hot'));
```

Handles are **live**: elements added to the DOM later — by you, by `.list()`,
by anything — get bound automatically via one shared `MutationObserver`, and
cleaned up completely when they leave. No manual unbinding, no leaks.

## Feature tour

**Signals** — `ae.signal(v)`, `ae.computed(fn)`, `ae.effect(fn)`. Writes are
batched per microtask; computeds are lazy and only notify when their value
actually changes.

**Rendering** — `.render(fn)` auto-tracks every signal read inside and re-runs
on change. Sugar helpers `.text()` / `.cls()` / `.attr()` / `.show()` accept a
plain value (applied once), a signal, or a function (both reactive).

**Events** — `.press(fn)` is semantic activation: click everywhere, plus
synthesized Enter/Space only for elements the browser doesn't natively
activate (keyboard-accessible `div[tabindex]`, `[role=button]` for free, no
double-fire on real buttons). `.hover(enter, leave)` and the `.on(type, fn,
opts)` escape hatch round it out — all listeners per element, so non-bubbling
events just work.

**Keyed lists** — `.list(items, render, key)` stamps a native `<template>`
per item with keyed reconciliation: reorders move nodes without remounting,
unchanged items don't re-render, removed items are disposed.

```html
<ul data-ae="todos">
  <template><li><b data-ae="title"></b></li></template>
</ul>
```

```js
ae('todos').list(todos, (li, todo, i) => {
  ae.parts(li).title.textContent = `${i + 1}. ${todo.text}`;
}, todo => todo.id);

ae('remove').press(btn => {                 // which item was clicked?
  const todo = ae.itemOf(btn);              // ae knows — no key stamping
  todos.value = todos.value.filter(t => t.id !== todo.id);
});
```

**Two-way forms** — `.input(signal)` wires by field type: strings for
text/select, booleans for checkboxes, real numbers for number/range. Writes
are equality-guarded so echoes never move the caret.

**Scoped roots** — `ae(name, root)` limits a handle to descendants of `root`:
per-list behavior without global name collisions.

**Animation** — `ae.transition(fn)` runs your signal writes inside a browser
View Transition: list enters, exits, and reorders animate in pure CSS, and
elements with a `view-transition-name` morph — even across lists. Falls back
to a plain call where unsupported.

Full API and semantics: **[API.md](API.md)**. Compact API reference for AI
agents: **[llms.txt](llms.txt)**. Live demos: `bun run serve` →
http://localhost:4242.

Real app: **[examples/kanban.html](examples/kanban.html)** — a kanban with
drag & drop, dynamic columns, inline editing, undo, filtering, and
localStorage persistence in ~170 lines of JS. One-pager with live demos:
**[site/index.html](site/index.html)** (deployed to GitHub Pages).

## Performance

Keyed-list stress numbers, measured **end-to-end** — signal write through
reconciliation, mount pipeline, layout, and paint (headless Chrome, Apple
M4 Max; median of 3 runs). Each row carries three live `data-ae` bindings,
two of them event listeners.

| operation | time |
|---|---|
| create 1,000 rows | 34 ms |
| create 10,000 rows | 257 ms |
| append 1,000 to 10,000 | 72 ms |
| update every 10th of 11,000 | 142 ms |
| swap 2 rows of 11,000 | 76 ms |
| clear 11,000 rows | 50 ms |

Reproduce: `bun run serve` → `examples/bench.html` (add `?auto` for the
full suite).

## Development

```sh
bun install
bun run build   # tsc → dist/ae.js + dist/ae.d.ts
bun run test    # jsdom smoke suite (build first)
bun run serve   # demo at http://localhost:4242
bun run min     # dist/ae.min.js
```

## Guarantees (the short version)

- **Batching** — signal writes coalesce; each effect runs at most once per flush.
- **Absolute disposal** — a disposed effect never runs again, even if already queued.
- **Net-state lifecycle** — mount/cleanup reflect the *net* DOM change per task:
  moves don't remount, `a→b→a` renames are no-ops.
- **Fault isolation** — one throwing effect/binding/cleanup never takes down the rest.
- **Runaway guard** — a self-triggering effect trips a circuit breaker instead of hanging the tab.

## License

[MIT](LICENSE)
