// Smoke test for ae.js — runs the compiled lib inside jsdom.
// Usage: npm test  (builds first, then runs this)

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const key of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'Node']) {
  globalThis[key] = key === 'window' ? dom.window : dom.window[key];
}

const { ae, effect } = await import('../dist/ae.js');
const { document } = dom.window;

// MutationObserver callbacks and the ae flush queue are both microtasks;
// a macrotask boundary drains everything.
const tick = () => new Promise((r) => setTimeout(r, 0));

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  const node = tpl.content.firstElementChild;
  document.body.appendChild(node);
  return node;
}

// --- handle caching -------------------------------------------------------
assert(ae('same') === ae('same'), 'handles are cached singletons');

// --- signal + render, element added AFTER render registered ---------------
{
  const count = ae.signal(0);
  let renders = 0;
  ae('t-late').render((n) => { renders++; n.textContent = `${count.value}`; });
  const node = el('<span data-ae="t-late"></span>');
  await tick();
  assert(node.textContent === '0', 'render runs for element added after registration');
  const before = renders;
  count.value = 7;
  await tick();
  assert(node.textContent === '7', 'render re-runs on signal change');
  assert(renders === before + 1, 'exactly one re-render per change');
}

// --- render on element that already exists --------------------------------
{
  const node = el('<span data-ae="t-early"></span>');
  await tick();
  const label = ae.signal('hi');
  ae('t-early').render((n) => { n.textContent = label.value; });
  assert(node.textContent === 'hi', 'render runs immediately for existing element');
}

// --- batching: N writes → 1 render ----------------------------------------
{
  const n = ae.signal(0);
  let runs = 0;
  el('<i data-ae="t-batch"></i>');
  await tick();
  ae('t-batch').render(() => { runs++; void n.value; });
  const before = runs;
  n.value++; n.value++; n.value++;
  await tick();
  assert(runs === before + 1, `3 writes cause exactly 1 render (got ${runs - before})`);
}

// --- computed: laziness, chaining, and equality cut-off (bug #6) ----------
{
  const a = ae.signal(1);
  let computes = 0;
  const positive = ae.computed(() => { computes++; return a.value > 0; });
  assert(computes === 0, 'computed is lazy before first read');
  let effectRuns = 0;
  const dispose = effect(() => { effectRuns++; void positive.value; });
  assert(computes === 1 && effectRuns === 1, 'computed evaluates on first read');
  a.value = 2; // recomputes to true — unchanged
  await tick();
  assert(effectRuns === 1, 'unchanged computed value does NOT re-run dependents');
  a.value = -5; // recomputes to false — changed
  await tick();
  assert(effectRuns === 2, 'changed computed value re-runs dependents');
  dispose();
}

// --- press: no double-fire on native button (bug #1) -----------------------
{
  const btn = el('<button data-ae="t-btn">go</button>');
  await tick();
  let fires = 0;
  ae('t-btn').press(() => fires++);
  // Simulate what a browser does for Enter on a focused button:
  // keydown, then the native synthesized click.
  btn.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  btn.click();
  assert(fires === 1, `Enter on native button fires press once (got ${fires})`);
}

// --- press: keyboard synthesis for non-native elements ---------------------
{
  const div = el('<div data-ae="t-div" tabindex="0">go</div>');
  await tick();
  let fires = 0;
  ae('t-div').press(() => fires++);
  const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  div.dispatchEvent(enter);
  assert(fires === 1, 'Enter on div[tabindex] fires press');
  const space = new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  div.dispatchEvent(space);
  assert(fires === 2, 'Space on div[tabindex] fires press');
  assert(space.defaultPrevented, 'Space keydown is preventDefault-ed (no page scroll)');
  div.click();
  assert(fires === 3, 'click on div fires press');
}

// --- press: text inputs are never hijacked (bug #2) ------------------------
{
  const input = el('<input data-ae="t-input">');
  await tick();
  let fires = 0;
  ae('t-input').press(() => fires++);
  const space = new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  input.dispatchEvent(space);
  assert(fires === 0, 'Space in input does not fire press');
  assert(!space.defaultPrevented, 'Space in input is not preventDefault-ed (typing works)');
}

// --- hover: per-element listeners, nested data-ae is safe (bug #3) ---------
{
  const outer = el('<div data-ae="t-hover"><span data-ae="t-hover-inner">x</span></div>');
  await tick();
  let enters = 0;
  let leaves = 0;
  ae('t-hover').hover(() => enters++, () => leaves++);
  outer.dispatchEvent(new dom.window.Event('pointerenter'));
  outer.dispatchEvent(new dom.window.Event('pointerleave'));
  assert(enters === 1 && leaves === 1, 'hover enter/leave fire on the element itself');
}

// --- on(): non-bubbling events + opts passed through (bug #4) --------------
{
  const field = el('<input data-ae="t-focus">');
  await tick();
  let focused = 0;
  ae('t-focus').on('focus', () => focused++); // focus does not bubble
  field.dispatchEvent(new dom.window.Event('focus'));
  assert(focused === 1, 'non-bubbling event (focus) fires via per-element listener');

  const once = el('<div data-ae="t-once"></div>');
  await tick();
  let onceFires = 0;
  ae('t-once').on('click', () => onceFires++, { once: true });
  once.click();
  once.click();
  assert(onceFires === 1, 'AddEventListenerOptions ({once}) is respected');
}

// --- mount cleanup + render disposal on removal ----------------------------
{
  const node = el('<div data-ae="t-life"></div>');
  await tick();
  const sig = ae.signal(0);
  let cleaned = 0;
  let renders = 0;
  ae('t-life')
    .mount(() => () => cleaned++)
    .render(() => { renders++; void sig.value; });
  assert(renders === 1, 'render ran on mount');
  node.remove();
  await tick();
  assert(cleaned === 1, 'mount cleanup runs on removal');
  sig.value = 99;
  await tick();
  assert(renders === 1, 'render effect is disposed after removal (no leak)');

  document.body.appendChild(node); // re-add → full re-bind
  await tick();
  assert(renders === 2, 'render re-attaches when element re-enters the DOM');
  sig.value = 100;
  await tick();
  assert(renders === 3, 're-attached render tracks signals again');
}

// --- data-ae attribute added/renamed later ---------------------------------
{
  const node = el('<div></div>');
  await tick();
  let mounts = 0;
  ae('t-attr').mount(() => { mounts++; });
  node.setAttribute('data-ae', 't-attr');
  await tick();
  assert(mounts === 1, 'element gaining data-ae later gets mounted');
  node.removeAttribute('data-ae');
  await tick();
  node.setAttribute('data-ae', 't-attr');
  await tick();
  assert(mounts === 2, 'rename/re-add of data-ae rebinds');
}

// --- reactive helpers: text/cls/attr/show with signals ---------------------
{
  const node = el('<div data-ae="t-sugar"></div>');
  await tick();
  const msg = ae.signal('a');
  const busy = ae.signal(false);
  const dis = ae.signal(false);
  const vis = ae.signal(true);
  ae('t-sugar').text(msg).cls('busy', busy).attr('disabled', dis).show(vis);
  assert(node.textContent === 'a', 'text(signal) applies');
  msg.value = 'b';
  busy.value = true;
  dis.value = true;
  vis.value = false;
  await tick();
  assert(node.textContent === 'b', 'text(signal) is reactive');
  assert(node.classList.contains('busy'), 'cls(signal) is reactive');
  assert(node.getAttribute('disabled') === '', 'attr(signal) true → empty attribute');
  assert(node.hidden === true, 'show(signal) is reactive');
  dis.value = false;
  await tick();
  assert(!node.hasAttribute('disabled'), 'attr(signal) false → attribute removed');
}

// --- flush circuit breaker (bug #5): must not hang --------------------------
{
  const s = ae.signal(0);
  const origError = console.error;
  let guardTripped = false;
  console.error = (...args) => {
    if (String(args[0]).includes('flush aborted')) guardTripped = true;
  };
  const dispose = effect(() => { s.value = s.value + 1; }); // reads AND writes s
  await tick();
  console.error = origError;
  dispose();
  assert(guardTripped, 'runaway effect loop trips the circuit breaker instead of hanging');
}

// --- one throwing effect does not kill the others ---------------------------
{
  const s = ae.signal(0);
  let goodRuns = 0;
  const origError = console.error;
  console.error = () => {};
  const d1 = effect(() => { void s.value; if (s.value > 0) throw new Error('boom'); });
  const d2 = effect(() => { void s.value; goodRuns++; });
  s.value = 1;
  await tick();
  console.error = origError;
  assert(goodRuns === 2, 'effects after a throwing effect still run');
  d1(); d2();
}

// ===========================================================================
// Regressions from the 2026-07-10 external review
// ===========================================================================

// --- F1: disposing an effect cancels its queued run --------------------------
{
  const s = ae.signal(0);
  let runs = 0;
  const dispose = effect(() => { runs++; void s.value; });
  s.value = 1;   // queues the runner
  dispose();     // must also cancel the queued run
  await tick();
  s.value = 2;   // must not resurrect it
  await tick();
  assert(runs === 1, `disposed effect never runs again (got ${runs} runs)`);
}

// --- F1b: no zombie render when removal precedes a write in the same task ---
{
  const s = ae.signal(0);
  let renders = 0;
  const node = el('<div data-ae="f1b"></div>');
  await tick();
  ae('f1b').render(() => { renders++; void s.value; });
  node.remove();  // observer cleanup microtask runs before...
  s.value = 1;    // ...the flush microtask for this write
  await tick();
  s.value = 2;
  await tick();
  assert(renders === 1, `render disposed by unmount cannot resurrect (got ${renders})`);
}

// --- F2: reparenting a connected element does not remount it -----------------
{
  let mounts = 0;
  let cleanups = 0;
  ae('f2').mount(() => { mounts++; return () => cleanups++; });
  const a = el('<div></div>');
  const b = el('<div></div>');
  const node = document.createElement('div');
  node.setAttribute('data-ae', 'f2');
  a.appendChild(node);
  await tick();
  b.appendChild(node); // move within the document
  await tick();
  assert(mounts === 1 && cleanups === 0, `move is invisible to bindings (mounts=${mounts}, cleanups=${cleanups})`);
  node.remove(); // real removal still cleans up
  await tick();
  assert(cleanups === 1, 'true removal after a move still runs cleanup');
}

// --- F3: multiple data-ae changes in one task bind the final name once -------
{
  let mounts = 0;
  let cleanups = 0;
  ae('f3-final').mount(() => { mounts++; return () => cleanups++; });
  const node = el('<div data-ae="f3-start"></div>');
  await tick();
  node.setAttribute('data-ae', 'f3-mid');
  node.setAttribute('data-ae', 'f3-final');
  await tick();
  assert(mounts === 1 && cleanups === 0, `a→b→c mounts final name once (mounts=${mounts}, cleanups=${cleanups})`);
}

// --- F3b: net no-op rename (a→b→a) leaves bindings untouched -----------------
{
  let mounts = 0;
  let cleanups = 0;
  ae('f3b').mount(() => { mounts++; return () => cleanups++; });
  const node = el('<div data-ae="f3b"></div>');
  await tick();
  node.setAttribute('data-ae', 'f3b-other');
  node.setAttribute('data-ae', 'f3b');
  await tick();
  assert(mounts === 1 && cleanups === 0, `a→b→a is a net no-op (mounts=${mounts}, cleanups=${cleanups})`);
}

// --- F3c: insert + rename in the same task mounts once -----------------------
{
  let mounts = 0;
  ae('f3c-final').mount(() => { mounts++; });
  const node = document.createElement('div');
  node.setAttribute('data-ae', 'f3c-start');
  document.body.appendChild(node);
  node.setAttribute('data-ae', 'f3c-final'); // same task as insertion
  await tick();
  assert(mounts === 1, `insert+rename in one task mounts once (got ${mounts})`);
}

// --- F2/F3 edge: move + rename in one task rebinds cleanly (invariant I3) ----
{
  let mounts = 0;
  let cleanups = 0;
  let otherCleanups = 0;
  ae('f23-old').mount(() => () => otherCleanups++);
  ae('f23-new').mount(() => { mounts++; return () => cleanups++; });
  const a = el('<div></div>');
  const b = el('<div></div>');
  const node = document.createElement('div');
  node.setAttribute('data-ae', 'f23-old');
  a.appendChild(node);
  await tick();
  b.appendChild(node);
  node.setAttribute('data-ae', 'f23-new'); // move AND rename, same task
  await tick();
  assert(otherCleanups === 1, 'old-name bindings are cleaned on rename-during-move');
  assert(mounts === 1 && cleanups === 0, `new name mounted exactly once (mounts=${mounts}, cleanups=${cleanups})`);
}

// --- F4: initial effect throw propagates AND leaves no subscriptions ---------
{
  const s = ae.signal(0);
  let threw = false;
  let runs = 0;
  try {
    effect(() => { runs++; void s.value; throw new Error('boom'); });
  } catch {
    threw = true;
  }
  assert(threw, 'initial effect throw propagates to the caller');
  s.value = 1;
  await tick();
  assert(runs === 1, `throwing initial run leaves no live subscription (got ${runs} runs)`);
}

// --- F5: control characters in handle names ----------------------------------
{
  const node = el('<div></div>');
  node.setAttribute('data-ae', 'a\nb');
  await tick();
  assert(ae('a\nb').els.length === 1, '.els finds names containing a newline');
  const msg = ae.signal('x');
  ae('a\nb').text(msg);
  assert(node.textContent === 'x', 'bindings work on control-character names');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
