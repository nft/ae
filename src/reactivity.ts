// Reactivity core: signals, computeds, effects, and the batched flush loop.
// Dependency-free — everything else in ae builds on top of this.

export type Cleanup = () => void;

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
// Hot computeds invalidated since the last flush cycle, awaiting re-evaluation.
let dirty: Computed<unknown>[] = [];
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
    while (queue.size > 0 || dirty.length > 0) {
      if (++cycles > MAX_FLUSH_CYCLES) {
        // Aborted computeds stay _dirty with _queued reset — stale until the
        // next invalidation or read, same recovery contract as a throw.
        queue.clear();
        dirty.length = 0;
        console.error(
          '[ae] update flush aborted after ' + MAX_FLUSH_CYCLES +
          ' cycles — an effect is probably writing a signal it also reads',
        );
        return;
      }
      // Re-evaluate invalidated computeds before running effects, so effects
      // are only scheduled for computeds whose FINAL value actually changed
      // (a diamond otherwise causes a spurious effect run). Pull recursion
      // through the getters resolves dependency order — no sort needed.
      const dc = dirty;
      dirty = [];
      for (const c of dc) {
        c._queued = false;
        if (!c._dirty || c._subs.size === 0) continue; // pulled already, or unobserved stays lazy
        try {
          c._update();
        } catch (err) {
          console.error('[ae] computed threw:', err);
        }
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

function scheduleFlush(): void {
  if (!scheduled && !flushing) {
    scheduled = true;
    queueMicrotask(flush);
  }
}

function schedule(run: Runner): void {
  if (!run.active) return;
  queue.add(run);
  scheduleFlush();
}

/**
 * Resolves once pending signal writes — and everything they cascade into
 * (list stamping, the mount pipeline, effects scheduled by mounts) — have
 * drained and the DOM is fully settled. Each hop is a macrotask, so
 * MutationObserver deliveries land in between hops.
 */
export function settled(): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (scheduled || flushing) setTimeout(check, 0);
      else resolve();
    };
    setTimeout(check, 0);
  });
}

interface ViewTransitionLike {
  finished: Promise<unknown>;
  ready: Promise<unknown>;
  updateCallbackDone: Promise<unknown>;
  skipTransition(): void;
}

/**
 * Run `fn` inside a View Transition, so every DOM change its signal writes
 * cause — list stamps, removals, reorders, text — is animated by the
 * browser (style with `::view-transition-*`; give elements a
 * `view-transition-name` to make them morph). The "new" snapshot is taken
 * only after ae has settled. Falls back to a plain `fn()` call where
 * `document.startViewTransition` is unsupported.
 */
export function transition(fn: () => void): ViewTransitionLike | undefined {
  const doc = document as unknown as {
    startViewTransition?: (cb: () => Promise<void>) => ViewTransitionLike;
  };
  if (!doc.startViewTransition) {
    fn();
    return undefined;
  }
  return doc.startViewTransition(async () => {
    fn();
    await settled();
  });
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
  /** Value is stale; born dirty = born lazy. @internal */
  _dirty = true;
  /** Sitting in the pending `dirty` drain array. Separate from _dirty so a
   * computed whose evaluation threw at flush time is re-queued by the next
   * dependency write instead of being orphaned forever. @internal */
  _queued = false;
  private _value!: T;
  private readonly _runner: Runner;
  private readonly _fn: () => T;

  constructor(fn: () => T) {
    this._fn = fn;
    // Invalidation only — no user code runs here, so a dependency write can
    // never throw at the writer and never starves sibling subscribers.
    const runner = (() => {
      const wasDirty = this._dirty;
      this._dirty = true;
      if (!this._queued) {
        this._queued = true;
        dirty.push(this as Computed<unknown>);
        scheduleFlush();
      }
      // Invariant: dirty ⇒ every downstream computed is dirty, so a repeat
      // mark has nothing left to propagate.
      if (!wasDirty) for (const r of [...this._subs]) if (r.sync) r();
    }) as Runner;
    runner.deps = new Set();
    runner.sync = true;
    runner.active = true; // computed runners are never disposed
    this._runner = runner;
  }

  /** Recompute now. Clears _dirty only on success, so a throwing fn retries
   * on the next read instead of poisoning the cached value. @internal */
  _update(): void {
    const next = runTracked(this._runner, this._fn);
    this._dirty = false;
    if (!Object.is(next, this._value)) {
      this._value = next;
      for (const r of [...this._subs]) {
        if (r === activeRunner) continue; // the reader consuming us right now
        // Sync subs re-queue downstream computeds left dirty-but-unqueued by
        // an earlier throw; their runner guards make repeats cheap no-ops.
        if (r.sync) r();
        else schedule(r);
      }
    }
  }

  get value(): T {
    track(this._subs);
    if (this._dirty) this._update();
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

export function bindReactive<T>(
  v: Reactive<T>,
  el: HTMLElement,
  apply: (el: HTMLElement, value: T) => void,
): Cleanup | void {
  if (isSignal(v)) return effect(() => apply(el, (v as ReadableSignal<T>).value));
  if (typeof v === 'function') return effect(() => apply(el, (v as (el: HTMLElement) => T)(el)));
  apply(el, v);
}
