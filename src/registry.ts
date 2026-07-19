// Shared mutable state used by both the DOM lifecycle (mounting) and the
// public ae() factory. Lives in its own dependency-free module so lifecycle
// and handle never need to import each other at runtime.

import type { Handle } from './handle.js';
import type { Signal } from './reactivity.js';

/** Global handles, cached per name. */
export const handles = new Map<string, Handle>();

// Scoped handles, per root element. WeakMap: a scope root that leaves the DOM
// for good takes its handles with it. `anyScoped` keeps the ancestor walk in
// mountElement free until the feature is actually used.
export const scopedHandles = new WeakMap<HTMLElement, Map<string, Handle>>();
export let anyScoped = false;

export function markScoped(): void {
  anyScoped = true;
}

// While a .scope() callback runs, roots whose handle maps are first created
// get collected here, to be retired when that scope's root unmounts.
export let scopeCreated: Set<HTMLElement> | null = null;

/** Swap the collector; returns the previous one (for save/restore in .scope). */
export function swapScopeCreated(next: Set<HTMLElement> | null): Set<HTMLElement> | null {
  const prev = scopeCreated;
  scopeCreated = next;
  return prev;
}

// Stamped list node → its live record, for ae.itemOf recovery.
export interface ListRecord {
  item: Signal<unknown>;
  index: Signal<number>;
}
export const listRecords = new WeakMap<HTMLElement, ListRecord>();
