# ae — API v1

Tiny attribute-based behavior + reactivity lib. No virtual DOM, no hydration:
HTML is the source of truth, `ae` attaches behavior to it.

Written in TypeScript (`src/ae.ts`), ships as an ES module with type
declarations. `npm run build` → `dist/ae.js` + `dist/ae.d.ts`, `npm test` runs
the jsdom smoke suite, `npm run serve` hosts the demo at `index.html`.

```html
<button data-ae="save">Save</button>
<span data-ae="status"></span>
```

```js
import { ae } from './dist/ae.js';

const count = ae.signal(0);

ae('status').render(el => el.textContent = `${count.value} items`);

ae('save')
  .press(() => count.value++)
  .hover(el => el.classList.add('hot'), el => el.classList.remove('hot'))
  .mount(el => console.log('save button appeared', el));
```

## Markup

One attribute: `data-ae="name"`. Names are free-form strings; the same name may
appear on any number of elements.

## Global API

### `ae(name) → Handle`
Returns a **live handle** for all elements with `data-ae="name"` — current ones
and any added to the DOM later. Handles are cached: `ae('x') === ae('x')`.

### `ae.signal(initial) → Signal`
Reactive value.

```js
const n = ae.signal(0);
n.value        // read (tracked inside render/effect/computed)
n.value = 5    // write — schedules dependents
n.value++      // works
```

Writes are **batched**: multiple writes in the same tick trigger one re-render,
on the next microtask. Setting an identical value (`Object.is`) is a no-op.

### `ae.computed(fn) → Computed (read-only)`
Derived value. Lazy until first read; after that it re-computes when a
dependency changes and notifies dependents **only when the computed value
actually changed** (`Object.is`) — unchanged results cause no re-renders.

```js
const total = ae.computed(() => price.value * qty.value);
```

### `ae.isSignal(v) → boolean`
True for `Signal` and `Computed` instances. The imperative helpers use this to
decide between one-shot and reactive application.

### `ae.effect(fn) → dispose`
Auto-tracked side effect not tied to an element (logging, storage, fetch
triggers). Runs immediately, re-runs when its signals change. Returns a
function that stops it.

## Handle API

All methods return the handle — everything chains. Callbacks receive the
element first: `fn(el, ...)` — so one handle with many elements just works.

### Lifecycle

| method | behavior |
|---|---|
| `.mount(fn)` | Runs `fn(el)` once per matching element — immediately for existing ones, and for any element added later (via one shared `MutationObserver`). If `fn` returns a function, it runs as cleanup when the element is removed from the DOM. |

### Rendering (reactive)

| method | behavior |
|---|---|
| `.render(fn)` | Runs `fn(el)` per element, **auto-tracking** every signal read inside. Re-runs (for every element) when any of them changes. Also runs for elements added later. Tracking is per-run: only signals read on the last run are dependencies. |

### Events

Listeners are attached **per element** through the mount pipeline (and removed
on unmount), so elements added later still need no manual re-binding — the
shared `MutationObserver` binds them. Per-element listeners mean non-bubbling
events (`focus`, `blur`, …) work, `stopPropagation` behaves normally, and
nested `data-ae` elements never shadow each other. Handlers get `(el, event)`.

| method | behavior |
|---|---|
| `.press(fn)` | Activation: `click` for every element. `Enter`/`Space` keydown is synthesized **only** for elements the browser does not natively activate (e.g. `div[tabindex]`, `[role=button]`) — native buttons/links already turn Enter/Space into `click` (adding our own would double-fire), and text fields are never hijacked. |
| `.hover(enter, leave?)` | `pointerenter` / `pointerleave` on the element itself — nesting-safe by construction. |
| `.on(type, fn, opts?)` | Escape hatch for any DOM event type. `opts` is a standard `AddEventListenerOptions` (`once`, `passive`, `capture`, …) and is passed through. |

### Imperative helpers

Apply to every element in the handle. Sugar — everything is also doable inside
`.render()`/`.mount()`. Each accepts a `Reactive<T>` value:

- **plain value** → applied once;
- **signal / computed** → applied reactively (`.text(msgSignal)`);
- **function `(el) => value`** → run inside an auto-tracked effect, so signals
  read inside make it reactive (`.cls('empty', () => count.value === 0)`).

| method | behavior |
|---|---|
| `.text(v)` | `textContent = String(v)` |
| `.cls(name, on?)` | `classList.toggle(name, on)`; omit `on` for a one-shot plain toggle |
| `.attr(name, v)` | set attribute; `null`/`undefined`/`false` removes it, `true` sets it empty |
| `.show(on)` | toggle `hidden` |

### Escape hatches

| member | behavior |
|---|---|
| `.els` | Plain array of currently matching elements. |
| `.each(fn)` | Run `fn(el)` over current elements once (not reactive, not for future ones). |

## Semantics & guarantees

- **Liveness**: one `MutationObserver` on `document.body` powers everything —
  mount/cleanup, late elements, and `data-ae` attributes that are added,
  removed, or renamed after insertion. No per-handle observers.
- **Batching**: signal writes coalesce per microtask; each affected `render`/
  `effect` runs at most once per flush.
- **Disposal**: when an element leaves the DOM, its mount cleanups run, its
  render effects are disposed, and its event listeners are removed. Re-adding
  the element re-binds everything. Disposal is absolute: a disposed effect
  never runs again, even if it was already queued for the current flush.
  No manual unbinding, no leaks.
- **Net-state lifecycle**: mount/cleanup reflect the *net* DOM change per
  task, not intermediate mutations. Moving a connected element to another
  parent does not remount it; renaming `data-ae` a→b→a is a no-op; multiple
  renames in one task bind the final name exactly once.
- **Fault isolation**: a throwing binding, cleanup, or effect *re-run* is
  logged via `console.error` and does not prevent the others from running.
  The one exception: an `ae.effect` whose **initial** run throws propagates
  the error synchronously to the caller and leaves no trace (nothing
  subscribed, nothing queued). Element bindings (`.render`/`.mount`) are
  always isolated, including their first run.
- **Runaway guard**: an effect that writes a signal it also reads trips a
  circuit breaker after 100 flush cycles (with a `console.error`) instead of
  hanging the tab.
- **No templating**: for repeated DOM, clone a native `<template>` inside
  `mount`/`render`. A `.list()` helper is deliberately deferred to v2 until
  real usage demands it.
