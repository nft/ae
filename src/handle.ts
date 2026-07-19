// Handle: the chainable per-name binding surface (mount/render/events/forms).

import {
  bindReactive,
  effect,
  isSignal,
  Signal,
  type Cleanup,
  type Reactive,
  type ReadableSignal,
} from './reactivity.js';
import { attach, selectorFor, type Binding } from './lifecycle.js';
import { listRecords, scopedHandles, swapScopeCreated, type ListRecord } from './registry.js';

// Elements the browser natively activates via keyboard (Enter/Space already
// synthesize a click) or where keys mean text entry. press() must not add its
// own keydown for these: it would double-fire or hijack typing.
const NATIVE_PRESS =
  'button, a[href], input, select, textarea, summary, ' +
  '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

export type PressEvent = MouseEvent | KeyboardEvent;

/**
 * Live handle for all elements carrying data-ae="name" — current ones and any
 * connected later (one shared MutationObserver). All methods chain.
 * Callbacks always receive the matching element first: fn(el, ...).
 *
 * A handle with a `root` is scoped: it only ever matches *descendants* of
 * root (the root itself is not a match, mirroring ae.parts).
 */
export class Handle {
  /** @internal */
  readonly _bindings: Binding[] = [];

  constructor(
    readonly name: string,
    readonly root?: HTMLElement,
  ) {}

  /** Plain array of currently matching elements (under root, if scoped). */
  get els(): HTMLElement[] {
    const scope = this.root ?? document;
    return Array.from(scope.querySelectorAll<HTMLElement>(selectorFor(this.name)));
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
   * One-time setup per matching root element, with real teardown — the safe
   * way to wire scoped handles for roots that come and go (e.g. nodes
   * stamped by .list). fn runs when the root mounts. Scoped handles FIRST
   * CREATED inside fn (synchronously) are retired when the root unmounts,
   * so a remount re-runs fn against fresh handles instead of stacking
   * duplicate bindings onto cached ones. A returned function runs first at
   * teardown.
   */
  scope(fn: (el: HTMLElement) => Cleanup | void): this {
    return this._bind((el) => {
      const created = new Set<HTMLElement>();
      const prev = swapScopeCreated(created);
      let cleanup: Cleanup | void;
      try {
        cleanup = fn(el);
      } finally {
        swapScopeCreated(prev);
      }
      return () => {
        try {
          if (typeof cleanup === 'function') cleanup();
        } finally {
          // Retire even when the user cleanup throws — a stale map would
          // stack duplicate bindings onto cached handles on remount.
          for (const root of created) scopedHandles.delete(root);
        }
      };
    });
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
   * Activation: click for everyone; Enter/Space keyboard activation only for
   * elements the browser does not natively activate (e.g. div[tabindex],
   * [role=button]). Native-like semantics: Enter fires on keydown (key
   * repeats included), Space fires once on keyup — its keydown only prevents
   * page scroll, and moving focus mid-press cancels the activation. Keys
   * originating in nested native controls or editable text are ignored.
   */
  press(fn: (el: HTMLElement, ev: PressEvent) => void): this {
    return this._bind((el) => {
      const onClick = (ev: MouseEvent) => fn(el, ev);
      el.addEventListener('click', onClick);

      if (el.matches(NATIVE_PRESS)) {
        return () => el.removeEventListener('click', onClick);
      }

      // isContentEditable also catches editability inherited from an
      // ancestor, which no selector can see.
      const fromNested = (ev: KeyboardEvent): boolean => {
        const t = ev.target as HTMLElement;
        return t !== el && (t.isContentEditable || !!t.closest?.(NATIVE_PRESS));
      };
      let spaceArmed = false;
      const onKeydown = (ev: KeyboardEvent) => {
        if (fromNested(ev)) return;
        if (ev.key === 'Enter') {
          ev.preventDefault();
          fn(el, ev);
        } else if (ev.key === ' ') {
          ev.preventDefault(); // no page scroll; activation waits for keyup
          spaceArmed = true;
        }
      };
      const onKeyup = (ev: KeyboardEvent) => {
        if (ev.key !== ' ' || !spaceArmed) return;
        spaceArmed = false;
        if (fromNested(ev)) return;
        ev.preventDefault();
        fn(el, ev);
      };
      const onBlur = () => {
        spaceArmed = false;
      };
      el.addEventListener('keydown', onKeydown);
      el.addEventListener('keyup', onKeyup);
      el.addEventListener('blur', onBlur);
      return () => {
        el.removeEventListener('click', onClick);
        el.removeEventListener('keydown', onKeydown);
        el.removeEventListener('keyup', onKeyup);
        el.removeEventListener('blur', onBlur);
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
   * Two-way form binding — sugar over `.render` + `.on('input')`.
   *
   * Field type decides the wiring per element:
   * - text-like inputs, <textarea>, <select>  → Signal<string>  ↔ value
   * - input[type=checkbox]                    → Signal<boolean> ↔ checked
   * - input[type=number|range]                → Signal<number>  ↔ valueAsNumber
   *   (an empty number field reads as NaN; writing NaN clears it)
   *
   * Signal → element is reactive; element → signal fires on input/change.
   * Writes are equality-guarded so echoes never move the caret. Radio groups
   * and multi-select are out of scope — use `.on` directly.
   */
  input<T extends string | number | boolean>(sig: Signal<T>): this {
    return this._bind((el) => {
      const tag = el.tagName;
      const type = tag === 'INPUT' ? (el as HTMLInputElement).type : '';
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        console.error('[ae] .input target is not a form field:', el);
        return;
      }
      const field = el as HTMLInputElement;
      const mode: 'checked' | 'number' | 'value' =
        type === 'checkbox' ? 'checked' : type === 'number' || type === 'range' ? 'number' : 'value';

      const read = (): unknown =>
        mode === 'checked' ? field.checked : mode === 'number' ? field.valueAsNumber : field.value;
      const write = (v: unknown): void => {
        if (Object.is(read(), v)) return; // echo guard: never disturb the caret
        if (mode === 'checked') field.checked = !!v;
        else if (mode === 'number') field.valueAsNumber = Number(v);
        else field.value = String(v);
      };

      const disposeRender = effect(() => write(sig.value));
      const onInput = () => {
        (sig as Signal<unknown>).value = read();
      };
      el.addEventListener('input', onInput);
      el.addEventListener('change', onInput);
      return () => {
        disposeRender();
        el.removeEventListener('input', onInput);
        el.removeEventListener('change', onInput);
      };
    });
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
        listRecords.delete(rec.node);
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
            listRecords.set(node, rec as ListRecord);
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
