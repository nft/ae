// ae — tiny attribute-based behavior + reactivity lib.
// HTML is the source of truth (data-ae markers); ae attaches behavior to it.
// No virtual DOM, no hydration, no templates.

export type Cleanup = () => void;

// ---------------------------------------------------------------------------
// Reactivity core
// ---------------------------------------------------------------------------

interface Runner {
  (): void;
  /** Dependency sets this runner is subscribed to, for O(1) unsubscribe. */
  deps: Set<Set<Runner>>;
  /** Computed runners re-run synchronously to propagate invalidation. */
  sync?: boolean;
  /** Flipped off by disposal; inactive runners never run again. */
  active: boolean;
}

let activeRunner: Runner | null = null;

const queue = new Set<Runner>();
let flushing = false;
let scheduled = false;

// Circuit breaker: an effect that writes a signal it also reads would
// otherwise loop synchronously forever inside flush().
const MAX_FLUSH_CYCLES = 100;

function flush(): void {
  scheduled = false;
  if (flushing) return;
  flushing = true;
  try {
    let cycles = 0;
    while (queue.size > 0) {
      if (++cycles > MAX_FLUSH_CYCLES) {
        queue.clear();
        console.error(
          '[ae] update flush aborted after ' + MAX_FLUSH_CYCLES +
          ' cycles — an effect is probably writing a signal it also reads',
        );
        return;
      }
      const batch = [...queue];
      queue.clear();
      for (const run of batch) {
        // A cleanup earlier in this batch may have disposed a later runner
        // after it was already copied out of the queue.
        if (!run.active) continue;
        try {
          run();
        } catch (err) {
          console.error('[ae] effect threw:', err);
        }
      }
    }
  } finally {
    flushing = false;
  }
}

function schedule(run: Runner): void {
  if (!run.active) return;
  queue.add(run);
  if (!scheduled && !flushing) {
    scheduled = true;
    queueMicrotask(flush);
  }
}

function track(subs: Set<Runner>): void {
  if (activeRunner) {
    subs.add(activeRunner);
    activeRunner.deps.add(subs);
  }
}

function notify(subs: Set<Runner>): void {
  // Copy: sync runners re-track themselves mid-iteration.
  for (const run of [...subs]) {
    if (run.sync) run();
    else schedule(run);
  }
}

function untrackAll(run: Runner): void {
  for (const subs of run.deps) subs.delete(run);
  run.deps.clear();
}

/** Run fn with `run` as the active subscriber, re-tracking deps from scratch. */
function runTracked<T>(run: Runner, fn: () => T): T {
  untrackAll(run);
  const prev = activeRunner;
  activeRunner = run;
  try {
    return fn();
  } finally {
    activeRunner = prev;
  }
}

/**
 * Auto-tracked side effect. Runs immediately; re-runs (batched on a
 * microtask) whenever a signal it read changes. Returns a disposer.
 *
 * If the INITIAL run throws, the error propagates to the caller and the
 * effect leaves no trace (nothing subscribed, nothing queued). Errors in
 * later runs are logged and isolated by the flush loop.
 */
export function effect(fn: () => void): Cleanup {
  const runner = (() => runTracked(runner, fn)) as Runner;
  runner.deps = new Set();
  runner.active = true;
  const dispose = () => {
    runner.active = false;
    queue.delete(runner);
    untrackAll(runner);
  };
  try {
    runner();
  } catch (err) {
    dispose();
    throw err;
  }
  return dispose;
}

/** Writable reactive value. Reads are tracked inside effect/render/computed. */
export class Signal<T> {
  /** @internal */
  readonly _subs = new Set<Runner>();
  private _value: T;

  constructor(initial: T) {
    this._value = initial;
  }

  get value(): T {
    track(this._subs);
    return this._value;
  }

  set value(next: T) {
    if (Object.is(this._value, next)) return;
    this._value = next;
    notify(this._subs);
  }
}

/**
 * Derived read-only value. Lazy until first read; after that it re-computes
 * when a dependency changes and only notifies subscribers when the computed
 * value actually changed (Object.is), so unchanged results cause no renders.
 */
export class Computed<T> {
  /** @internal */
  readonly _subs = new Set<Runner>();
  private _value!: T;
  private _hot = false;
  private readonly _runner: Runner;
  private readonly _fn: () => T;

  constructor(fn: () => T) {
    this._fn = fn;
    const runner = (() => {
      const next = runTracked(runner, this._fn);
      if (!Object.is(next, this._value)) {
        this._value = next;
        notify(this._subs);
      }
    }) as Runner;
    runner.deps = new Set();
    runner.sync = true;
    runner.active = true; // computed runners are never disposed
    this._runner = runner;
  }

  get value(): T {
    track(this._subs);
    if (!this._hot) {
      this._hot = true;
      this._value = runTracked(this._runner, this._fn);
    }
    return this._value;
  }
}

export type ReadableSignal<T> = Signal<T> | Computed<T>;

export function isSignal(v: unknown): v is ReadableSignal<unknown> {
  return v instanceof Signal || v instanceof Computed;
}

/**
 * Value accepted by the imperative helpers: a plain value (applied once),
 * a signal (applied reactively), or a function of the element (applied
 * reactively, auto-tracked).
 */
export type Reactive<T> = T | ReadableSignal<T> | ((el: HTMLElement) => T);

function bindReactive<T>(
  v: Reactive<T>,
  el: HTMLElement,
  apply: (el: HTMLElement, value: T) => void,
): Cleanup | void {
  if (isSignal(v)) return effect(() => apply(el, (v as ReadableSignal<T>).value));
  if (typeof v === 'function') return effect(() => apply(el, (v as (el: HTMLElement) => T)(el)));
  apply(el, v);
}

// ---------------------------------------------------------------------------
// DOM lifecycle
// ---------------------------------------------------------------------------

/**
 * A binding attaches one behavior to one element and may return a cleanup.
 * Everything — mount, render, events, helpers — is a binding, attached when
 * the element is (or becomes) connected and cleaned up when it is removed.
 */
type Binding = (el: HTMLElement) => Cleanup | void;

interface Meta {
  /** The data-ae name the element is currently mounted under. Invariant:
   * `attached`/`cleanups` always belong to this name. */
  name?: string;
  attached: Set<Binding>;
  cleanups: Cleanup[];
}

const metadata = new WeakMap<HTMLElement, Meta>();

function getMeta(el: HTMLElement): Meta {
  let meta = metadata.get(el);
  if (!meta) {
    meta = { attached: new Set(), cleanups: [] };
    metadata.set(el, meta);
  }
  return meta;
}

function attach(el: HTMLElement, binding: Binding): void {
  const meta = getMeta(el);
  if (meta.attached.has(binding)) return;
  meta.attached.add(binding);
  let cleanup: Cleanup | void;
  try {
    cleanup = binding(el);
  } catch (err) {
    console.error('[ae] binding threw:', err);
    return;
  }
  if (typeof cleanup === 'function') meta.cleanups.push(cleanup);
}

function mountElement(el: HTMLElement): void {
  const name = el.dataset.ae;
  if (name === undefined) return;
  const meta = getMeta(el);
  // I3: attached bindings always belong to meta.name. Mounting under a
  // different name (e.g. moved AND renamed in one task) rebinds cleanly.
  if (meta.name !== undefined && meta.name !== name) unmountElement(el);
  meta.name = name;
  const handle = handles.get(name);
  if (!handle) return;
  for (const binding of handle._bindings) attach(el, binding);
}

function unmountElement(el: HTMLElement): void {
  const meta = metadata.get(el);
  if (!meta) return;
  for (const cleanup of meta.cleanups) {
    try {
      cleanup();
    } catch (err) {
      console.error('[ae] cleanup threw:', err);
    }
  }
  meta.cleanups.length = 0;
  meta.attached.clear();
  meta.name = undefined;
}

/** Visit root and its descendants that carry data-ae. */
function forEachMarked(root: Node, fn: (el: HTMLElement) => void): void {
  if (root.nodeType !== 1 /* ELEMENT_NODE */) return;
  const el = root as HTMLElement;
  if (el.dataset?.ae !== undefined) fn(el);
  el.querySelectorAll<HTMLElement>('[data-ae]').forEach(fn);
}

function selectorFor(name: string): string {
  // Quotes/backslashes get backslash-escaped; CSS string control characters
  // (an unescaped newline is a CSS parse error) become hex escapes, whose
  // trailing space is the escape terminator.
  const escaped = name
    .replace(/[\\"]/g, '\\$&')
    .replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
  return `[data-ae="${escaped}"]`;
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

// Elements the browser natively activates via keyboard (Enter/Space already
// synthesize a click) or where keys mean text entry. press() must not add its
// own keydown for these: it would double-fire or hijack typing.
const NATIVE_PRESS =
  'button, a[href], input, select, textarea, summary, [contenteditable=""], [contenteditable="true"]';

export type PressEvent = MouseEvent | KeyboardEvent;

/**
 * Live handle for all elements carrying data-ae="name" — current ones and any
 * connected later (one shared MutationObserver). All methods chain.
 * Callbacks always receive the matching element first: fn(el, ...).
 */
export class Handle {
  /** @internal */
  readonly _bindings: Binding[] = [];

  constructor(readonly name: string) {}

  /** Plain array of currently matching elements. */
  get els(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(selectorFor(this.name)));
  }

  /** Run fn over current elements once. Not reactive, not for future ones. */
  each(fn: (el: HTMLElement) => void): this {
    for (const el of this.els) fn(el);
    return this;
  }

  private _bind(binding: Binding): this {
    this._bindings.push(binding);
    for (const el of this.els) {
      if (el.isConnected) attach(el, binding);
    }
    return this;
  }

  /**
   * Runs fn(el) once per matching element — immediately for connected ones,
   * and for any element connected later. A returned function runs as cleanup
   * when the element leaves the DOM.
   */
  mount(fn: (el: HTMLElement) => Cleanup | void): this {
    return this._bind(fn);
  }

  /**
   * Runs fn(el) per element, auto-tracking every signal read inside.
   * Re-runs when any of them changes. Disposed when the element is removed.
   */
  render(fn: (el: HTMLElement) => void): this {
    return this._bind((el) => effect(() => fn(el)));
  }

  /** Any DOM event, attached per element (non-bubbling events work). */
  on<K extends keyof HTMLElementEventMap>(
    type: K,
    fn: (el: HTMLElement, ev: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): this;
  on(type: string, fn: (el: HTMLElement, ev: Event) => void, opts?: AddEventListenerOptions): this;
  on(
    type: string,
    fn: (el: HTMLElement, ev: Event) => void,
    opts?: AddEventListenerOptions,
  ): this {
    return this._bind((el) => {
      const handler = (ev: Event) => fn(el, ev);
      el.addEventListener(type, handler, opts);
      return () => el.removeEventListener(type, handler, opts);
    });
  }

  /**
   * Activation: click for everyone; Enter/Space keydown only for elements the
   * browser does not natively activate (e.g. div[tabindex], [role=button]).
   * Native buttons/links rely on their built-in Enter/Space→click, and text
   * fields are never hijacked.
   */
  press(fn: (el: HTMLElement, ev: PressEvent) => void): this {
    return this._bind((el) => {
      const onClick = (ev: MouseEvent) => fn(el, ev);
      el.addEventListener('click', onClick);

      if (el.matches(NATIVE_PRESS)) {
        return () => el.removeEventListener('click', onClick);
      }

      const onKeydown = (ev: KeyboardEvent) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault(); // Space must not scroll the page
        fn(el, ev);
      };
      el.addEventListener('keydown', onKeydown);
      return () => {
        el.removeEventListener('click', onClick);
        el.removeEventListener('keydown', onKeydown);
      };
    });
  }

  /** pointerenter / pointerleave per element — nesting-safe by construction. */
  hover(
    enter?: (el: HTMLElement, ev: PointerEvent) => void,
    leave?: (el: HTMLElement, ev: PointerEvent) => void,
  ): this {
    return this._bind((el) => {
      const onEnter = (ev: Event) => enter?.(el, ev as PointerEvent);
      const onLeave = (ev: Event) => leave?.(el, ev as PointerEvent);
      el.addEventListener('pointerenter', onEnter);
      el.addEventListener('pointerleave', onLeave);
      return () => {
        el.removeEventListener('pointerenter', onEnter);
        el.removeEventListener('pointerleave', onLeave);
      };
    });
  }

  /** textContent. Plain value applies once; signal or function is reactive. */
  text(v: Reactive<string | number>): this {
    return this._bind((el) =>
      bindReactive(v, el, (target, value) => {
        target.textContent = String(value);
      }),
    );
  }

  /** classList.toggle(name, on). Omit `on` for a one-shot plain toggle. */
  cls(name: string, on?: Reactive<boolean>): this {
    return this._bind((el) => {
      if (on === undefined) {
        el.classList.toggle(name);
        return;
      }
      return bindReactive(on, el, (target, value) => {
        target.classList.toggle(name, !!value);
      });
    });
  }

  /** Set attribute; null/undefined/false removes it, true sets it empty. */
  attr(name: string, v: Reactive<string | number | boolean | null | undefined>): this {
    return this._bind((el) =>
      bindReactive(v, el, (target, value) => {
        if (value === null || value === undefined || value === false) {
          target.removeAttribute(name);
        } else {
          target.setAttribute(name, value === true ? '' : String(value));
        }
      }),
    );
  }

  /** Toggle the hidden property. */
  show(on: Reactive<boolean>): this {
    return this._bind((el) =>
      bindReactive(on, el, (target, value) => {
        target.hidden = !value;
      }),
    );
  }

  /**
   * Keyed list stamping. The container's <template> (one root element)
   * provides the item prototype; stamped nodes are kept at the end of the
   * container in item order.
   *
   * `render(el, item, index)` runs per stamped node inside its own effect —
   * it re-runs when the item is replaced (by key), when the index moves, or
   * when any signal read inside changes. Reused keys keep their DOM node;
   * reordering moves nodes without remounting their data-ae bindings.
   *
   * `key` defaults to item identity. Duplicate keys are logged and the
   * duplicate gets a fresh, non-reused node.
   */
  list<T>(
    items: Reactive<readonly T[]>,
    render: (el: HTMLElement, item: T, index: number) => void,
    key: (item: T, index: number) => unknown = (item) => item,
  ): this {
    interface Rec {
      node: HTMLElement;
      item: Signal<T>;
      index: Signal<number>;
      dispose: Cleanup;
    }
    return this._bind((container) => {
      const template =
        container.querySelector(':scope > template') ?? container.querySelector('template');
      if (!(template instanceof HTMLTemplateElement)) {
        console.error('[ae] .list container has no <template>:', container);
        return;
      }
      const proto = template.content.firstElementChild;
      if (!proto || proto !== template.content.lastElementChild) {
        console.error('[ae] .list <template> must have exactly one root element:', container);
        return;
      }

      let records = new Map<unknown, Rec>();

      const removeRec = (rec: Rec) => {
        rec.dispose();
        rec.node.remove();
      };

      const disposeReconcile = effect(() => {
        const arr = isSignal(items)
          ? (items as ReadableSignal<readonly T[]>).value
          : typeof items === 'function'
            ? (items as (el: HTMLElement) => readonly T[])(container)
            : items;

        const next = new Map<unknown, Rec>();
        const order: Rec[] = [];
        let warnedDup = false;

        for (let i = 0; i < arr.length; i++) {
          const item = arr[i];
          let k = key(item, i);
          if (next.has(k)) {
            if (!warnedDup) {
              warnedDup = true;
              console.error('[ae] .list duplicate key, falling back to unkeyed node:', k);
            }
            k = Symbol('ae.dup');
          }
          let rec = records.get(k);
          if (rec) {
            records.delete(k);
            rec.item.value = item;
            rec.index.value = i;
          } else {
            const node = proto.cloneNode(true) as HTMLElement;
            const itemSig = new Signal(item);
            const indexSig = new Signal(i);
            const dispose = effect(() => render(node, itemSig.value, indexSig.value));
            rec = { node, item: itemSig, index: indexSig, dispose };
          }
          next.set(k, rec);
          order.push(rec);
        }

        for (const rec of records.values()) removeRec(rec); // vanished keys
        records = next;

        // Position nodes back-to-front; only mispositioned ones move.
        let anchor: Node | null = null;
        for (let i = order.length - 1; i >= 0; i--) {
          const node = order[i].node;
          if (node.parentNode !== container || node.nextSibling !== anchor) {
            container.insertBefore(node, anchor);
          }
          anchor = node;
        }
      });

      return () => {
        disposeReconcile();
        for (const rec of records.values()) removeRec(rec);
        records.clear();
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Registry & observer
// ---------------------------------------------------------------------------

const handles = new Map<string, Handle>();

const partsCache = new WeakMap<HTMLElement, Record<string, HTMLElement>>();

/**
 * Named lookup of data-ae descendants: ae.parts(el).title instead of
 * el.querySelector('[data-ae="title"]'). First match wins on duplicate
 * names. Cached per root — intended for template-stamped nodes, whose
 * structure is static; don't use it on subtrees you restructure.
 */
export function parts(root: HTMLElement): Record<string, HTMLElement> {
  let map = partsCache.get(root);
  if (!map) {
    map = Object.create(null) as Record<string, HTMLElement>;
    for (const el of root.querySelectorAll<HTMLElement>('[data-ae]')) {
      const name = el.dataset.ae;
      if (name !== undefined && !(name in map)) map[name] = el;
    }
    partsCache.set(root, map);
  }
  return map;
}

function initObserver(): void {
  const observer = new MutationObserver((records) => {
    // The callback runs after ALL mutations settle, so element state
    // (isConnected, current attribute value) is final — act on net state,
    // not on intermediate records: moves and no-op renames must be
    // invisible to bindings.
    const attrChanges = new Map<HTMLElement, string | null>(); // el → oldest oldValue
    for (const record of records) {
      if (record.type === 'attributes') {
        const el = record.target as HTMLElement;
        if (!attrChanges.has(el)) attrChanges.set(el, record.oldValue);
        continue;
      }
      for (const node of record.removedNodes) {
        forEachMarked(node, (el) => {
          if (!el.isConnected) unmountElement(el); // reparented ≠ removed
        });
      }
      for (const node of record.addedNodes) {
        forEachMarked(node, (el) => {
          if (el.isConnected) mountElement(el);
        });
      }
    }
    for (const [el, oldestValue] of attrChanges) {
      const current = el.getAttribute('data-ae');
      if (oldestValue === current) continue; // net no-op rename (a→b→a)
      // Already mounted under the final name (e.g. inserted and renamed in
      // the same task — the addition record mounted the final name above).
      if (metadata.get(el)?.name === current) continue;
      unmountElement(el);
      if (el.isConnected && current !== null) mountElement(el);
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-ae'],
    attributeOldValue: true,
  });
  forEachMarked(document.body, mountElement);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObserver);
  } else {
    initObserver();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * ae('name') → cached live Handle for [data-ae="name"].
 * ae.signal / ae.computed / ae.effect / ae.isSignal — reactivity primitives.
 */
export const ae = Object.assign(
  (name: string): Handle => {
    let handle = handles.get(name);
    if (!handle) {
      handle = new Handle(name);
      handles.set(name, handle);
    }
    return handle;
  },
  {
    signal: <T>(initial: T): Signal<T> => new Signal(initial),
    computed: <T>(fn: () => T): Computed<T> => new Computed(fn),
    effect,
    isSignal,
    parts,
  },
);
