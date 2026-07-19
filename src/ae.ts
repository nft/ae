// ae — tiny attribute-based behavior + reactivity lib.
// HTML is the source of truth (data-ae markers); ae attaches behavior to it.
// No virtual DOM, no hydration, no templates.

import { Computed, effect, isSignal, settled, Signal, transition } from './reactivity.js';
import './lifecycle.js'; // starts the document observer on import
import { Handle } from './handle.js';
import { handles, listRecords, markScoped, scopeCreated, scopedHandles } from './registry.js';

export { Computed, effect, isSignal, settled, Signal, transition } from './reactivity.js';
export type { Cleanup, Reactive, ReadableSignal } from './reactivity.js';
export { Handle } from './handle.js';
export type { PressEvent } from './handle.js';

/**
 * The current item of the .list-stamped node containing el — walks up to the
 * nearest stamped node, so nested lists resolve to the innermost. Returns
 * undefined outside any stamped node (or after the item was removed).
 * Reading it inside an effect/render tracks the item: replacement by key
 * re-runs the effect.
 */
export function itemOf<T = unknown>(el: HTMLElement): T | undefined {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const rec = listRecords.get(n);
    if (rec) return rec.item.value as T;
  }
  return undefined;
}

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

/**
 * ae('name') → cached live Handle for [data-ae="name"].
 * ae('name', root) → cached live Handle scoped to descendants of root.
 * ae.signal / ae.computed / ae.effect / ae.isSignal — reactivity primitives.
 *
 * Handles are cached per (name) and per (root, name); binding methods
 * append. Set a scoped handle up once per root — re-running the same setup
 * (e.g. in a mount callback of a root that gets removed and re-added) stacks
 * duplicate bindings.
 */
export const ae = Object.assign(
  (name: string, root?: HTMLElement): Handle => {
    if (root !== undefined) {
      markScoped();
      let map = scopedHandles.get(root);
      if (!map) {
        map = new Map();
        scopedHandles.set(root, map);
        if (scopeCreated) scopeCreated.add(root);
      }
      let handle = map.get(name);
      if (!handle) {
        handle = new Handle(name, root);
        map.set(name, handle);
      }
      return handle;
    }
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
    itemOf,
    settled,
    transition,
  },
);
