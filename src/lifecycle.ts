// DOM lifecycle: per-element binding metadata, mount/unmount, and the
// MutationObserver that keeps handles live as the document changes.

import type { Cleanup } from './reactivity.js';
import { anyScoped, handles, scopedHandles } from './registry.js';

/**
 * A binding attaches one behavior to one element and may return a cleanup.
 * Everything — mount, render, events, helpers — is a binding, attached when
 * the element is (or becomes) connected and cleaned up when it is removed.
 */
export type Binding = (el: HTMLElement) => Cleanup | void;

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

export function attach(el: HTMLElement, binding: Binding): void {
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
  if (handle) for (const binding of handle._bindings) attach(el, binding);
  if (anyScoped) {
    // Scoped handles: every ancestor that is a scope root for this name
    // contributes its bindings (innermost first).
    for (let anc = el.parentElement; anc; anc = anc.parentElement) {
      const scoped = scopedHandles.get(anc)?.get(name);
      if (scoped) for (const binding of scoped._bindings) attach(el, binding);
    }
  }
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
export function forEachMarked(root: Node, fn: (el: HTMLElement) => void): void {
  // Snapshot before invoking: a cleanup run by fn may detach descendants
  // (e.g. a .list container's cleanup removes its stamped nodes), and a
  // live walk would then silently skip their unmounts.
  const marked: HTMLElement[] = [];
  if (root.nodeType === 1 /* ELEMENT_NODE */) {
    const el = root as HTMLElement;
    if (el.dataset?.ae !== undefined) marked.push(el);
  } else if (root.nodeType !== 11 /* DOCUMENT_FRAGMENT (ShadowRoot) */) {
    return; // text/comment nodes from mutation records
  }
  (root as ParentNode).querySelectorAll<HTMLElement>('[data-ae]').forEach((el) => marked.push(el));
  for (const el of marked) fn(el);
}

export function selectorFor(name: string): string {
  // Quotes/backslashes get backslash-escaped; CSS string control characters
  // (an unescaped newline is a CSS parse error) become hex escapes, whose
  // trailing space is the escape terminator.
  const escaped = name
    .replace(/[\\"]/g, '\\$&')
    .replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
  return `[data-ae="${escaped}"]`;
}

const OBSERVER_OPTS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['data-ae'],
  attributeOldValue: true,
};

interface ObservedRoot {
  mo: MutationObserver;
  /** observe() calls minus disposals; the observer lives while refs > 0. */
  refs: number;
  /** Last known effective connectivity of the host, for the lifecycle sweep. */
  hostConnected: boolean;
}

/** Shadow roots opted in via ae.observe, exported for Handle.els. */
export const observedRoots = new Map<ShadowRoot, ObservedRoot>();

/** Is node inside space some active observer watches (document tree, or a
 * registered shadow root whose host chain is itself observed)? */
function isObserved(node: Node): boolean {
  for (let n: Node = node; ; ) {
    const root = n.getRootNode();
    if (root === n.ownerDocument) return true;
    const entry = observedRoots.get(root as ShadowRoot);
    if (!entry) return false;
    n = (root as ShadowRoot).host;
  }
}

// A ShadowRoot observer does NOT fire when its host leaves the document, and
// the document observer cannot see into shadow trees — so every mutation
// batch ends by re-checking each registered root's host connectivity and
// mounting/unmounting its subtree on transitions.
function sweepObservedRoots(): void {
  for (const [root, entry] of observedRoots) {
    const connected = root.host.isConnected && isObserved(root.host);
    if (connected === entry.hostConnected) continue;
    entry.hostConnected = connected;
    if (connected) forEachMarked(root, (el) => mountElement(el));
    else forEachMarked(root, unmountElement);
  }
}

/**
 * Watch a ShadowRoot for data-ae lifecycle — the document observer cannot
 * pierce shadow boundaries, and neither can this (nested shadow roots each
 * need their own observe call). Marked content already inside is mounted
 * immediately if the host is connected; host removal/re-insertion unmounts
 * and remounts the subtree. Observation is refcounted per root: the returned
 * cleanup (idempotent per call) disconnects and unmounts once the last
 * caller disposes.
 */
export function observe(root: ShadowRoot): Cleanup {
  let entry = observedRoots.get(root);
  if (entry) {
    entry.refs++;
  } else {
    const mo = new MutationObserver(onMutations);
    mo.observe(root, OBSERVER_OPTS);
    entry = { mo, refs: 1, hostConnected: false };
    observedRoots.set(root, entry);
    entry.hostConnected = root.host.isConnected && isObserved(root.host);
    if (entry.hostConnected) forEachMarked(root, (el) => mountElement(el));
  }
  const e = entry;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--e.refs > 0) return;
    e.mo.disconnect();
    observedRoots.delete(root);
    forEachMarked(root, unmountElement);
  };
}

function onMutations(records: MutationRecord[]): void {
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
        // reparented ≠ removed — but composed-tree isConnected stays true for
        // an element moved into an UNOBSERVED shadow root, where no observer
        // covers it anymore, so that move must unmount too.
        if (!el.isConnected || (observedRoots.size > 0 && !isObserved(el))) unmountElement(el);
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
  if (observedRoots.size > 0) sweepObservedRoots();
}

function initObserver(): void {
  const observer = new MutationObserver(onMutations);
  observer.observe(document.body, OBSERVER_OPTS);
  forEachMarked(document.body, mountElement);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObserver);
  } else {
    initObserver();
  }
}
