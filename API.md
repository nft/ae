# ae — API v1 (draft)

Tiny attribute-based behavior + reactivity lib. No build step, no virtual DOM, no
hydration: HTML is the source of truth, `ae` attaches behavior to it.

```html
<button data-ae="save">Save</button>
<span data-ae="status"></span>
```

```js
import { ae } from './ae.js';

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

### `ae.computed(fn) → Signal (read-only)`
Derived value. Re-computes lazily when a signal it reads changes.

```js
const total = ae.computed(() => price.value * qty.value);
```

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

All events are delegated from `document` — elements added later need no
re-binding. Handlers get `(el, event)`.

| method | behavior |
|---|---|
| `.press(fn)` | Activation: `click`, plus `Enter`/`Space` keydown on focusable elements. One semantic for mouse, touch, and keyboard. |
| `.hover(enter, leave?)` | `pointerenter` / `pointerleave`. |
| `.on(type, fn, opts?)` | Escape hatch for any DOM event type. |

### Imperative helpers

Apply to every element in the handle. Sugar — everything is also doable inside
`.render()`/`.mount()`.

| method | behavior |
|---|---|
| `.text(v)` | `textContent = v` |
| `.cls(name, on?)` | `classList.toggle(name, on)` — boolean optional |
| `.attr(name, v)` | set attribute; `null`/`false` removes it |
| `.show(on)` | toggle `hidden` |

### Escape hatches

| member | behavior |
|---|---|
| `.els` | Plain array of currently matching elements. |
| `.each(fn)` | Run `fn(el)` over current elements once (not reactive, not for future ones). |

## Semantics & guarantees

- **Liveness**: one `MutationObserver` on `document.body` powers `mount`
  cleanup and late-element support for `mount`/`render`. No per-handle
  observers.
- **Batching**: signal writes coalesce per microtask; each affected `render`/
  `effect` runs at most once per flush.
- **Disposal**: when an element leaves the DOM, its mount cleanups run and its
  renders are dropped. No manual unbinding, no leaks.
- **No templating**: for repeated DOM, clone a native `<template>` inside
  `mount`/`render`. A `.list()` helper is deliberately deferred to v2 until
  real usage demands it.
