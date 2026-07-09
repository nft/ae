// ae.js - Tiny attribute-based behavior + reactivity lib.
// Source of truth is HTML (via data-ae), behavior is attached reactively.

let activeEffect = null;
const effectStack = [];
const queue = new Set();
let pending = false;

// 1. Reactive queue flushing
function flushQueue() {
  pending = false;
  // Loop until queue is empty in case effects trigger more effects
  while (queue.size > 0) {
    const currentQueue = Array.from(queue);
    queue.clear();
    for (const execute of currentQueue) {
      execute();
    }
  }
}

function queueEffect(execute) {
  queue.add(execute);
  if (!pending) {
    pending = true;
    queueMicrotask(flushQueue);
  }
}

// 2. Effect cleanups
function cleanupEffect(execute) {
  for (const dep of execute.deps) {
    dep.delete(execute);
  }
  execute.deps.clear();
}

// 3. Reactivity Core
export function effect(fn) {
  const execute = () => {
    cleanupEffect(execute);
    effectStack.push(activeEffect);
    activeEffect = execute;
    try {
      return fn();
    } finally {
      activeEffect = effectStack.pop();
    }
  };
  execute.deps = new Set();
  execute();
  return () => cleanupEffect(execute);
}

class Signal {
  constructor(value) {
    this._value = value;
    this.subscribers = new Set();
  }

  get value() {
    if (activeEffect) {
      this.subscribers.add(activeEffect);
      activeEffect.deps.add(this.subscribers);
    }
    return this._value;
  }

  set value(newValue) {
    if (!Object.is(this._value, newValue)) {
      this._value = newValue;
      for (const sub of this.subscribers) {
        if (sub._isComputedRunner) {
          sub(); // Propagate dirtiness immediately
        } else {
          queueEffect(sub);
        }
      }
    }
  }
}

class ComputedSignal {
  constructor(fn) {
    this._fn = fn;
    this._dirty = true;
    this._value = undefined;
    this.subscribers = new Set();

    this._runner = () => {
      if (!this._dirty) {
        this._dirty = true;
        for (const sub of this.subscribers) {
          if (sub._isComputedRunner) {
            sub();
          } else {
            queueEffect(sub);
          }
        }
      }
    };
    this._runner._isComputedRunner = true;
    this._runner.deps = new Set();
  }

  get value() {
    if (activeEffect) {
      this.subscribers.add(activeEffect);
      activeEffect.deps.add(this.subscribers);
    }

    if (this._dirty) {
      cleanupEffect(this._runner);
      const prevActive = activeEffect;
      activeEffect = this._runner;
      try {
        this._value = this._fn();
        this._dirty = false;
      } finally {
        activeEffect = prevActive;
      }
    }
    return this._value;
  }
}

// 4. Element Metadata Map for lifecycle cleanups
const elementMetadata = new WeakMap();

function getMetadata(el) {
  if (!elementMetadata.has(el)) {
    elementMetadata.set(el, {
      mounted: new Set(),
      cleanups: [],
      helpersRun: false,
      rendersRun: false
    });
  }
  return elementMetadata.get(el);
}

// 5. Mount/Unmount hooks
function mountElement(el, name, handle) {
  const meta = getMetadata(el);

  // Run mounts
  for (const fn of handle._mounts) {
    if (!meta.mounted.has(fn)) {
      meta.mounted.add(fn);
      const cleanup = fn(el);
      if (typeof cleanup === 'function') {
        meta.cleanups.push(cleanup);
      }
    }
  }

  // Run helpers once per element
  if (!meta.helpersRun) {
    meta.helpersRun = true;
    for (const helper of handle._helpers) {
      helper(el);
    }
  }

  // Run renders once per element (wrapped in effects)
  if (!meta.rendersRun) {
    meta.rendersRun = true;
    for (const fn of handle._renders) {
      const dispose = effect(() => fn(el));
      meta.cleanups.push(dispose);
    }
  }
}

function unmountElement(el) {
  const meta = elementMetadata.get(el);
  if (meta) {
    for (const cleanup of meta.cleanups) {
      try {
        cleanup();
      } catch (err) {
        console.error('Error during cleanup:', err);
      }
    }
    meta.cleanups = [];
    meta.mounted.clear();
    meta.helpersRun = false;
    meta.rendersRun = false;
  }
}

// 6. Handle Definition
class Handle {
  constructor(name) {
    this.name = name;
    this._mounts = new Set();
    this._renders = new Set();
    this._events = [];
    this._presses = new Set();
    this._hovers = new Set();
    this._helpers = [];
  }

  mount(fn) {
    this._mounts.add(fn);
    const els = document.querySelectorAll(`[data-ae="${this.name}"]`);
    for (const el of els) {
      if (document.body.contains(el)) {
        const meta = getMetadata(el);
        if (!meta.mounted.has(fn)) {
          meta.mounted.add(fn);
          const cleanup = fn(el);
          if (typeof cleanup === 'function') {
            meta.cleanups.push(cleanup);
          }
        }
      }
    }
    return this;
  }

  render(fn) {
    this._renders.add(fn);
    const els = document.querySelectorAll(`[data-ae="${this.name}"]`);
    for (const el of els) {
      if (document.body.contains(el)) {
        const meta = getMetadata(el);
        const dispose = effect(() => fn(el));
        meta.cleanups.push(dispose);
      }
    }
    return this;
  }

  press(fn) {
    this._presses.add(fn);
    registerDelegatedEvent('click');
    registerDelegatedEvent('keydown');
    return this;
  }

  hover(enter, leave) {
    this._hovers.add({ enter, leave });
    registerHoverDelegation();
    return this;
  }

  on(type, fn, opts) {
    registerDelegatedEvent(type);
    this._events.push({ type, fn, opts });
    return this;
  }

  // Imperative helpers
  text(v) {
    return this._addHelper((el) => {
      if (v && typeof v === 'object' && 'value' in v) {
        const dispose = effect(() => { el.textContent = v.value; });
        getMetadata(el).cleanups.push(dispose);
      } else if (typeof v === 'function') {
        const dispose = effect(() => { el.textContent = v(el); });
        getMetadata(el).cleanups.push(dispose);
      } else {
        el.textContent = v;
      }
    });
  }

  cls(name, on) {
    return this._addHelper((el) => {
      if (on && typeof on === 'object' && 'value' in on) {
        const dispose = effect(() => { el.classList.toggle(name, !!on.value); });
        getMetadata(el).cleanups.push(dispose);
      } else if (typeof on === 'function') {
        const dispose = effect(() => { el.classList.toggle(name, !!on(el)); });
        getMetadata(el).cleanups.push(dispose);
      } else {
        el.classList.toggle(name, on !== undefined ? !!on : undefined);
      }
    });
  }

  attr(name, v) {
    return this._addHelper((el) => {
      const update = (val) => {
        if (val === null || val === false || val === undefined) {
          el.removeAttribute(name);
        } else {
          el.setAttribute(name, val === true ? '' : val);
        }
      };
      if (v && typeof v === 'object' && 'value' in v) {
        const dispose = effect(() => update(v.value));
        getMetadata(el).cleanups.push(dispose);
      } else if (typeof v === 'function') {
        const dispose = effect(() => update(v(el)));
        getMetadata(el).cleanups.push(dispose);
      } else {
        update(v);
      }
    });
  }

  show(on) {
    return this._addHelper((el) => {
      const update = (val) => { el.hidden = !val; };
      if (on && typeof on === 'object' && 'value' in on) {
        const dispose = effect(() => update(on.value));
        getMetadata(el).cleanups.push(dispose);
      } else if (typeof on === 'function') {
        const dispose = effect(() => update(on(el)));
        getMetadata(el).cleanups.push(dispose);
      } else {
        update(on);
      }
    });
  }

  _addHelper(fn) {
    this._helpers.push(fn);
    const els = document.querySelectorAll(`[data-ae="${this.name}"]`);
    for (const el of els) {
      if (document.body.contains(el)) {
        fn(el);
      }
    }
    return this;
  }

  get els() {
    return Array.from(document.querySelectorAll(`[data-ae="${this.name}"]`));
  }

  each(fn) {
    for (const el of this.els) {
      fn(el);
    }
    return this;
  }
}

// 7. Global Handle Cache
const handleCache = new Map();

function getHandle(name) {
  if (!handleCache.has(name)) {
    handleCache.set(name, new Handle(name));
  }
  return handleCache.get(name);
}

// 8. Event Delegation Core
const registeredEvents = new Set();

function registerDelegatedEvent(type) {
  if (registeredEvents.has(type)) return;
  registeredEvents.add(type);

  document.addEventListener(type, (event) => {
    let target = event.target;
    while (target && target !== document) {
      if (target.hasAttribute && target.hasAttribute('data-ae')) {
        const name = target.getAttribute('data-ae');
        const handle = handleCache.get(name);
        if (handle) {
          // Regular events
          for (const ev of handle._events) {
            if (ev.type === type) {
              ev.fn(target, event);
            }
          }

          // Press semantics: click, and Space/Enter on focusable elements
          if (type === 'click' || type === 'keydown') {
            let isPress = false;
            if (type === 'click') {
              isPress = true;
            } else if (type === 'keydown') {
              const isFocusable = target.tabIndex >= 0 || ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(target.tagName);
              if (isFocusable && (event.key === 'Enter' || event.key === ' ')) {
                isPress = true;
                if (event.key === ' ') {
                  event.preventDefault(); // Prevent page scroll
                }
              }
            }
            if (isPress) {
              for (const pressFn of handle._presses) {
                pressFn(target, event);
              }
            }
          }
        }
      }
      target = target.parentNode;
    }
  });
}

function registerHoverDelegation() {
  if (registeredEvents.has('hover')) return;
  registeredEvents.add('hover');

  document.addEventListener('pointerover', (event) => {
    let target = event.target;
    let related = event.relatedTarget;

    let targetAE = null;
    let curr = target;
    while (curr && curr !== document) {
      if (curr.hasAttribute && curr.hasAttribute('data-ae')) {
        targetAE = curr;
        break;
      }
      curr = curr.parentNode;
    }

    let relatedAE = null;
    curr = related;
    while (curr && curr !== document) {
      if (curr.hasAttribute && curr.hasAttribute('data-ae')) {
        relatedAE = curr;
        break;
      }
      curr = curr.parentNode;
    }

    if (targetAE && targetAE !== relatedAE) {
      const name = targetAE.getAttribute('data-ae');
      const handle = handleCache.get(name);
      if (handle) {
        for (const hover of handle._hovers) {
          if (hover.enter) {
            hover.enter(targetAE, event);
          }
        }
      }
    }
  });

  document.addEventListener('pointerout', (event) => {
    let target = event.target;
    let related = event.relatedTarget;

    let targetAE = null;
    let curr = target;
    while (curr && curr !== document) {
      if (curr.hasAttribute && curr.hasAttribute('data-ae')) {
        targetAE = curr;
        break;
      }
      curr = curr.parentNode;
    }

    let relatedAE = null;
    curr = related;
    while (curr && curr !== document) {
      if (curr.hasAttribute && curr.hasAttribute('data-ae')) {
        relatedAE = curr;
        break;
      }
      curr = curr.parentNode;
    }

    if (targetAE && targetAE !== relatedAE) {
      const name = targetAE.getAttribute('data-ae');
      const handle = handleCache.get(name);
      if (handle) {
        for (const hover of handle._hovers) {
          if (hover.leave) {
            hover.leave(targetAE, event);
          }
        }
      }
    }
  });
}

// 9. MutationObserver for DOM Lifecycle
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        checkAndMount(node);
      }
    }
    for (const node of mutation.removedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        checkAndUnmount(node);
      }
    }
  }
});

function checkAndMount(root) {
  if (root.hasAttribute && root.hasAttribute('data-ae')) {
    const name = root.getAttribute('data-ae');
    mountElement(root, name, getHandle(name));
  }
  if (root.querySelectorAll) {
    const els = root.querySelectorAll('[data-ae]');
    for (const el of els) {
      const name = el.getAttribute('data-ae');
      mountElement(el, name, getHandle(name));
    }
  }
}

function checkAndUnmount(root) {
  if (root.hasAttribute && root.hasAttribute('data-ae')) {
    unmountElement(root);
  }
  if (root.querySelectorAll) {
    const els = root.querySelectorAll('[data-ae]');
    for (const el of els) {
      unmountElement(el);
    }
  }
}

// Start observing when document is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, { childList: true, subtree: true });
    checkAndMount(document.body);
  });
} else {
  observer.observe(document.body, { childList: true, subtree: true });
  checkAndMount(document.body);
}

// 10. Core Wrapper
export function ae(name) {
  return getHandle(name);
}

ae.signal = (initial) => new Signal(initial);
ae.computed = (fn) => new ComputedSignal(fn);
ae.effect = (fn) => effect(fn);
