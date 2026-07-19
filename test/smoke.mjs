// Smoke test for ae.js — runs the compiled lib inside jsdom.
// Usage: npm test  (builds first, then runs this)

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const key of ['window', 'document', 'MutationObserver', 'HTMLElement', 'HTMLTemplateElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'Node']) {
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

// ===========================================================================
// .list()
// ===========================================================================

const listContainer = (name) =>
  el(`<ul data-ae="${name}"><template><li><span class="t"></span></li></template></ul>`);

// --- basic stamp + keyed in-place update ------------------------------------
{
  const ul = listContainer('l-basic');
  await tick();
  const todos = ae.signal([
    { id: 1, text: 'one' },
    { id: 2, text: 'two' },
  ]);
  let renders = 0;
  ae('l-basic').list(
    todos,
    (node, todo) => { renders++; node.querySelector('.t').textContent = todo.text; },
    (todo) => todo.id,
  );
  const lis = () => [...ul.querySelectorAll('li')];
  assert(lis().length === 2, 'list stamps one node per item');
  assert(lis()[0].textContent === 'one' && lis()[1].textContent === 'two', 'list renders item content');

  const nodeBefore = lis()[1];
  const rendersBefore = renders;
  todos.value = [{ id: 1, text: 'one' }, { id: 2, text: 'TWO' }];
  await tick();
  assert(lis()[1] === nodeBefore, 'keyed update reuses the same DOM node');
  assert(lis()[1].textContent === 'TWO', 'keyed update re-renders changed item');
  assert(renders === rendersBefore + 2, `only the changed item re-renders (got ${renders - rendersBefore} extra)`);
  // note: +2 because id:1's item object is also new by reference → its signal changes
}

// --- Object.is cut-off: identical item references do not re-render -----------
{
  listContainer('l-cutoff');
  await tick();
  const a = { id: 'a', text: 'A' };
  const b = { id: 'b', text: 'B' };
  const items = ae.signal([a, b]);
  let renders = 0;
  ae('l-cutoff').list(items, () => { renders++; }, (x) => x.id);
  const before = renders;
  items.value = [a, b]; // new array, same refs, same order
  await tick();
  assert(renders === before, 'unchanged items (same ref, same index) do not re-render');
}

// --- removal ------------------------------------------------------------------
{
  const ul = listContainer('l-remove');
  await tick();
  const items = ae.signal(['x', 'y', 'z']);
  ae('l-remove').list(items, (node, item) => { node.querySelector('.t').textContent = item; });
  assert(ul.querySelectorAll('li').length === 3, 'three items stamped');
  items.value = ['x', 'z'];
  await tick();
  const texts = [...ul.querySelectorAll('li')].map((n) => n.textContent);
  assert(texts.join(',') === 'x,z', `vanished key removes its node (got ${texts.join(',')})`);
}

// --- reorder preserves node identity and inner data-ae bindings ---------------
{
  const ul = el(`<ul data-ae="l-order"><template><li data-ae="l-order-item"><span class="t"></span></li></template></ul>`);
  await tick();
  let mounts = 0;
  let cleanups = 0;
  ae('l-order-item').mount(() => { mounts++; return () => cleanups++; });
  const items = ae.signal([{ k: 1 }, { k: 2 }, { k: 3 }]);
  ae('l-order').list(items, (node, it) => { node.querySelector('.t').textContent = `${it.k}`; }, (it) => it.k);
  await tick(); // let observer mount the stamped nodes
  const before = [...ul.querySelectorAll('li')];
  assert(mounts === 3, `inner data-ae bindings mount per stamped node (got ${mounts})`);
  items.value = [items.value[2], items.value[1], items.value[0]]; // reverse
  await tick();
  const after = [...ul.querySelectorAll('li')];
  assert(after[0] === before[2] && after[2] === before[0], 'reorder moves existing nodes');
  assert(after.map((n) => n.textContent).join(',') === '3,2,1', 'reorder reflects new order');
  assert(mounts === 3 && cleanups === 0, `reorder does not remount inner bindings (mounts=${mounts}, cleanups=${cleanups})`);
}

// --- duplicate keys: logged, both render --------------------------------------
{
  const ul = listContainer('l-dup');
  await tick();
  const origError = console.error;
  let warned = false;
  console.error = (...args) => { if (String(args[0]).includes('duplicate key')) warned = true; };
  ae('l-dup').list([{ id: 1, t: 'a' }, { id: 1, t: 'b' }], (node, it) => {
    node.querySelector('.t').textContent = it.t;
  }, (it) => it.id);
  console.error = origError;
  const texts = [...ul.querySelectorAll('li')].map((n) => n.textContent);
  assert(warned, 'duplicate key logs a console.error');
  assert(texts.join(',') === 'a,b', `both duplicate-key items still render (got ${texts.join(',')})`);
}

// --- plain array stamps once ---------------------------------------------------
{
  const ul = listContainer('l-static');
  await tick();
  ae('l-static').list(['a', 'b'], (node, item) => { node.querySelector('.t').textContent = item; });
  assert(ul.querySelectorAll('li').length === 2, 'plain array stamps once');
}

// --- container unmount disposes reconciler and item effects --------------------
{
  const ul = listContainer('l-dispose');
  await tick();
  const items = ae.signal(['a']);
  const dep = ae.signal(0);
  let renders = 0;
  ae('l-dispose').list(items, () => { renders++; void dep.value; });
  assert(renders === 1, 'item effect ran');
  ul.remove();
  await tick();
  dep.value = 1;      // must not re-run item render
  items.value = ['a', 'b']; // must not re-run reconciler
  await tick();
  assert(renders === 1, `unmounted list is fully disposed (got ${renders} renders)`);
}

// --- missing template: logged, no crash ----------------------------------------
{
  el('<div data-ae="l-noTpl"></div>');
  await tick();
  const origError = console.error;
  let warned = false;
  console.error = (...args) => { if (String(args[0]).includes('no <template>')) warned = true; };
  ae('l-noTpl').list(['x'], () => {});
  console.error = origError;
  assert(warned, 'missing <template> logs a console.error and no-ops');
}

// --- ae.parts(): named lookup of data-ae descendants ---------------------------
{
  const ul = el(`<ul data-ae="p-list"><template><li>
    <b data-ae="p-title"></b><i data-ae="p-due"></i>
  </li></template></ul>`);
  await tick();
  const items = ae.signal([{ id: 1, text: 'ship', due: 'fri' }]);
  ae('p-list').list(items, (node, it) => {
    const p = ae.parts(node);
    p['p-title'].textContent = it.text;
    p['p-due'].textContent = it.due;
  }, (it) => it.id);
  const li = ul.querySelector('li');
  assert(li.querySelector('[data-ae="p-title"]').textContent === 'ship', 'parts lookup renders into named part');
  assert(li.querySelector('[data-ae="p-due"]').textContent === 'fri', 'multiple parts resolve');
  assert(ae.parts(li) === ae.parts(li), 'parts map is cached per root');
  await tick();
  assert(ae('p-title').els.length === 1, 'part elements still participate in global handles');
}

// --- ae.parts(): first match wins on duplicates, root excluded ------------------
{
  const root = el(`<div data-ae="p-root"><span data-ae="p-dup">first</span><span data-ae="p-dup">second</span></div>`);
  await tick();
  const p = ae.parts(root);
  assert(p['p-dup'].textContent === 'first', 'duplicate part names: first match wins');
  assert(p['p-root'] === undefined, 'the root itself is not one of its parts');
}

// ===========================================================================
// .input()
// ===========================================================================

const fireInput = (node) => node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

// --- text input: string signal, both directions --------------------------------
{
  const field = el('<input data-ae="i-text">');
  await tick();
  const name = ae.signal('ada');
  ae('i-text').input(name);
  assert(field.value === 'ada', 'input(): signal → value on bind');
  name.value = 'grace';
  await tick();
  assert(field.value === 'grace', 'input(): signal change updates the field');
  field.value = 'linus';
  fireInput(field);
  assert(name.value === 'linus', 'input(): typing updates the signal');
}

// --- checkbox: boolean signal ---------------------------------------------------
{
  const box = el('<input type="checkbox" data-ae="i-check">');
  await tick();
  const on = ae.signal(true);
  ae('i-check').input(on);
  assert(box.checked === true, 'checkbox: signal → checked on bind');
  on.value = false;
  await tick();
  assert(box.checked === false, 'checkbox: signal change updates checked');
  box.checked = true;
  fireInput(box);
  assert(on.value === true, 'checkbox: toggling updates the signal');
}

// --- number input: number signal ------------------------------------------------
{
  const num = el('<input type="number" data-ae="i-num">');
  await tick();
  const qty = ae.signal(3);
  ae('i-num').input(qty);
  assert(num.value === '3', 'number: signal → valueAsNumber on bind');
  qty.value = 7;
  await tick();
  assert(num.value === '7', 'number: signal change updates the field');
  num.value = '42';
  fireInput(num);
  assert(qty.value === 42, 'number: typing yields a number, not a string');
  num.value = '';
  fireInput(num);
  assert(Number.isNaN(qty.value), 'number: empty field reads as NaN');
}

// --- textarea and select ---------------------------------------------------------
{
  const area = el('<textarea data-ae="i-area"></textarea>');
  const sel = el('<select data-ae="i-sel"><option value="a">A</option><option value="b">B</option></select>');
  await tick();
  const note = ae.signal('hello');
  const pick = ae.signal('b');
  ae('i-area').input(note);
  ae('i-sel').input(pick);
  assert(area.value === 'hello', 'textarea binds value');
  assert(sel.value === 'b', 'select binds value');
  sel.value = 'a';
  fireInput(sel);
  assert(pick.value === 'a', 'select change updates the signal');
}

// --- echo guard: user edit does not get clobbered by the flush -------------------
{
  const field = el('<input data-ae="i-echo">');
  await tick();
  const s = ae.signal('start');
  ae('i-echo').input(s);
  field.value = 'typed';
  fireInput(field);
  await tick(); // flush would echo the write back
  assert(field.value === 'typed', 'echo write is suppressed when values already match');
  assert(s.value === 'typed', 'signal holds the typed value after flush');
}

// --- two fields, one signal: mirrored --------------------------------------------
{
  const f1 = el('<input data-ae="i-mirror">');
  const f2 = el('<input data-ae="i-mirror">');
  await tick();
  const s = ae.signal('');
  ae('i-mirror').input(s);
  f1.value = 'sync';
  fireInput(f1);
  await tick();
  assert(f2.value === 'sync', 'two fields bound to one signal mirror each other');
}

// --- non-form element: logged, no crash -------------------------------------------
{
  el('<div data-ae="i-bad"></div>');
  await tick();
  const origError = console.error;
  let warned = false;
  console.error = (...args) => { if (String(args[0]).includes('not a form field')) warned = true; };
  ae('i-bad').input(ae.signal(''));
  console.error = origError;
  assert(warned, '.input on a non-form element logs and no-ops');
}

// --- unmount detaches the binding ---------------------------------------------------
{
  const field = el('<input data-ae="i-gone">');
  await tick();
  const s = ae.signal('a');
  ae('i-gone').input(s);
  field.remove();
  await tick();
  s.value = 'b';
  await tick();
  assert(field.value === 'a', 'removed field no longer receives signal writes');
  field.value = 'c';
  fireInput(field);
  assert(s.value === 'b', 'removed field no longer writes to the signal');
}

// ===========================================================================
// scoped roots: ae(name, root)
// ===========================================================================

// --- caching: per (root, name), distinct from global -----------------------------
{
  const r1 = el('<div></div>');
  const r2 = el('<div></div>');
  assert(ae('s-cache', r1) === ae('s-cache', r1), 'scoped handles are cached per (root, name)');
  assert(ae('s-cache', r1) !== ae('s-cache', r2), 'different roots get different handles');
  assert(ae('s-cache', r1) !== ae('s-cache'), 'scoped and global handles are distinct');
}

// --- scoping: bindings reach descendants of root and nothing else -----------------
{
  const a = el('<div><span data-ae="s-item">a</span></div>');
  const b = el('<div><span data-ae="s-item">b</span></div>');
  await tick();
  ae('s-item', a).render((n) => { n.dataset.scoped = 'yes'; });
  assert(a.querySelector('span').dataset.scoped === 'yes', 'scoped binding reaches descendants of root');
  assert(b.querySelector('span').dataset.scoped === undefined, 'scoped binding does not leak outside root');
}

// --- the root itself is not a match (mirrors ae.parts) -----------------------------
{
  const root = el('<div data-ae="s-self"><span data-ae="s-self"></span></div>');
  await tick();
  const h = ae('s-self', root);
  assert(h.els.length === 1 && h.els[0].tagName === 'SPAN', 'scoped .els excludes the root itself');
  let mounts = 0;
  h.mount(() => { mounts++; });
  assert(mounts === 1, 'scoped mount skips the root element even when its name matches');
}

// --- late elements: mounted under root, ignored outside ---------------------------
{
  const root = el('<div></div>');
  const outside = el('<div></div>');
  let mounts = 0;
  ae('s-late', root).mount(() => { mounts++; });
  root.insertAdjacentHTML('beforeend', '<i data-ae="s-late"></i>');
  outside.insertAdjacentHTML('beforeend', '<i data-ae="s-late"></i>');
  await tick();
  assert(mounts === 1, 'late element under root mounts; same name outside root does not');
}

// --- global + scoped compose on the same element -----------------------------------
{
  const root = el('<div><em data-ae="s-both"></em></div>');
  await tick();
  let global = 0, scoped = 0;
  ae('s-both').mount(() => { global++; });
  ae('s-both', root).mount(() => { scoped++; });
  assert(global === 1 && scoped === 1, 'global and scoped bindings compose on the same element');
}

// --- nested scopes: inner elements get both, outer-only elements just the outer ----
{
  const outer = el('<div><section><u data-ae="s-nest"></u></section><u data-ae="s-nest"></u></div>');
  const inner = outer.querySelector('section');
  await tick();
  const seenOuter = [], seenInner = [];
  ae('s-nest', outer).mount((n) => { seenOuter.push(n); });
  ae('s-nest', inner).mount((n) => { seenInner.push(n); });
  assert(seenOuter.length === 2, 'outer scope sees elements in nested scopes too');
  assert(seenInner.length === 1 && seenInner[0].parentElement === inner, 'inner scope sees only its own subtree');
}

// --- lifecycle: cleanup on removal, re-attach on re-add ----------------------------
{
  const root = el('<div><b data-ae="s-cycle"></b></div>');
  const node = root.querySelector('b');
  await tick();
  let mounts = 0, cleanups = 0;
  ae('s-cycle', root).mount(() => { mounts++; return () => cleanups++; });
  assert(mounts === 1, 'scoped mount ran for the existing element');
  node.remove();
  await tick();
  assert(cleanups === 1, 'scoped cleanup runs when the element is removed');
  root.append(node);
  await tick();
  assert(mounts === 2, 're-added element re-attaches scoped bindings');
}

// --- renaming an element inside the scope binds the scoped name --------------------
{
  const root = el('<div><i data-ae="s-before"></i></div>');
  const node = root.querySelector('i');
  await tick();
  let mounts = 0;
  ae('s-after', root).mount(() => { mounts++; });
  node.dataset.ae = 's-after';
  await tick();
  assert(mounts === 1, 'rename inside the scope attaches scoped bindings');
}

// --- the list idiom: container-scoped press, key stamped in render ------------------
{
  const root = el(`<ul data-ae="s-todos"><template><li><span data-ae="s-title"></span><button data-ae="s-del"></button></li></template></ul>`);
  const decoy = el('<div><button data-ae="s-del"></button></div>');
  await tick();
  const todos = ae.signal([
    { id: 1, t: 'one' },
    { id: 2, t: 'two' },
    { id: 3, t: 'three' },
  ]);
  ae('s-todos').list(todos, (li, todo) => {
    ae.parts(li)['s-title'].textContent = todo.t;
    li.dataset.key = todo.id;
  }, (todo) => todo.id);
  let presses = 0;
  ae('s-del', root).press((btn) => {
    presses++;
    const key = btn.closest('[data-key]').dataset.key;
    todos.value = todos.value.filter((t) => String(t.id) !== key);
  });
  await tick();
  assert(root.querySelectorAll('li').length === 3, 'list stamped 3 items');
  root.querySelectorAll('li')[1].querySelector('button')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick();
  const titles = [...root.querySelectorAll('li')].map((li) => li.firstElementChild.textContent);
  assert(titles.join(',') === 'one,three', 'container-scoped press removes exactly the right item');
  decoy.querySelector('button')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick();
  assert(presses === 1, 'same-name button outside the container never fires the scoped handler');
}

// ===========================================================================
// .scope(): per-root setup with teardown
// ===========================================================================

// --- the core regression: remount re-runs setup WITHOUT stacking bindings ----------
{
  const root = el('<div data-ae="sc-root"><button data-ae="sc-btn"></button></div>');
  const btn = root.querySelector('button');
  await tick();
  let setups = 0, presses = 0, cleanups = 0;
  ae('sc-root').scope((r) => {
    setups++;
    ae('sc-btn', r).press(() => presses++);
    return () => cleanups++;
  });
  assert(setups === 1, 'scope fn ran once for the existing root');
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert(presses === 1, 'scoped press wired by scope fn works');
  root.remove();
  await tick();
  assert(cleanups === 1, 'scope teardown runs when the root unmounts');
  document.body.append(root);
  await tick();
  assert(setups === 2, 'remount re-runs the scope fn');
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert(presses === 2, 'exactly one press after remount — no duplicate bindings');
}

// --- dynamic roots stamped by .list ------------------------------------------------
{
  const board = el(`<div data-ae="sc-board"><template><section data-ae="sc-col"><h3 data-ae="sc-title"></h3><button data-ae="sc-add"></button></section></template></div>`);
  await tick();
  const cols = ae.signal([{ id: 'a' }, { id: 'b' }]);
  const clicks = [];
  let setups = 0;
  ae('sc-col').scope((colEl) => {
    setups++;
    ae('sc-add', colEl).press(() => clicks.push(colEl.dataset.id));
  });
  ae('sc-board').list(cols, (colEl, c) => {
    colEl.dataset.id = c.id;
    ae.parts(colEl)['sc-title'].textContent = c.id;
  }, (c) => c.id);
  await tick();
  assert(setups === 2, 'scope fn ran once per stamped column');
  const btnOf = (id) => board.querySelector(`[data-id="${id}"] [data-ae="sc-add"]`);
  btnOf('a').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  btnOf('b').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert(clicks.join(',') === 'a,b', 'each column wired independently');
  cols.value = [{ id: 'b' }, { id: 'a' }]; // reorder → render re-runs, nodes move
  await tick();
  assert(setups === 2, 'reorder (render re-run) does NOT re-run scope');
  btnOf('a').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert(clicks.join(',') === 'a,b,a', 'still exactly one binding per button after reorder');
  cols.value = [{ id: 'a' }];
  await tick();
  assert(board.querySelectorAll('[data-ae="sc-col"]').length === 1, 'removed column is gone');
}

// --- handles scoped to a DESCENDANT inside the fn are retired too -------------------
{
  const root = el('<div data-ae="sc-deep"><section><i data-ae="sc-leaf"></i></section></div>');
  const section = root.querySelector('section');
  await tick();
  let runs = 0;
  ae('sc-deep').scope(() => {
    ae('sc-leaf', section).mount(() => { runs++; });
  });
  assert(runs === 1, 'descendant-scoped binding ran');
  root.remove();
  await tick();
  document.body.append(root);
  await tick();
  assert(runs === 2, 'descendant-scoped map retired with the scope (no stacked duplicate)');
}

// --- pre-existing scoped maps survive an unrelated scope teardown -------------------
{
  const keeper = el('<div><b data-ae="sc-keep"></b></div>');
  const other = el('<div data-ae="sc-other"></div>');
  await tick();
  const keepHandle = ae('sc-keep', keeper); // created OUTSIDE any scope
  ae('sc-other').scope(() => {
    ae('sc-keep', keeper); // touches the existing map from inside a scope
  });
  other.remove();
  await tick();
  assert(ae('sc-keep', keeper) === keepHandle, 'map created outside the scope is not retired by it');
}

// ===========================================================================
// ae.itemOf(): list item recovery
// ===========================================================================

// --- resolution, currency, tracking, removal ----------------------------------------
{
  const root = el(`<ul data-ae="io-list"><template><li><button data-ae="io-btn"></button></li></template></ul>`);
  await tick();
  const items = ae.signal([{ id: 1, t: 'a' }, { id: 2, t: 'b' }]);
  ae('io-list').list(items, (li, it) => {
    ae.parts(li)['io-btn'].textContent = it.t;
  }, (it) => it.id);
  const lis = () => [...root.querySelectorAll('li')];
  assert(ae.itemOf(lis()[0].querySelector('button')).t === 'a', 'itemOf resolves from a descendant of the stamped node');
  assert(ae.itemOf(lis()[1]).t === 'b', 'itemOf resolves from the stamped node itself');
  assert(ae.itemOf(root) === undefined, 'itemOf on the container (outside any stamped node) is undefined');

  items.value = [{ id: 1, t: 'a2' }, { id: 2, t: 'b' }];
  await tick();
  assert(ae.itemOf(lis()[0]).t === 'a2', 'itemOf returns the CURRENT item after replacement by key');

  const seen = [];
  const disposeEff = effect(() => { seen.push(ae.itemOf(lis()[0]).t); });
  items.value = [{ id: 1, t: 'a3' }, { id: 2, t: 'b' }];
  await tick();
  assert(seen.join(',') === 'a2,a3', 'itemOf tracks inside an effect (re-runs on replacement)');
  disposeEff();

  const firstNode = lis()[0];
  items.value = [{ id: 2, t: 'b' }];
  await tick();
  assert(ae.itemOf(firstNode) === undefined, 'itemOf is undefined once the item is removed');
}

// --- nested lists: nearest stamped node wins ----------------------------------------
{
  const root = el(`<div data-ae="io-outer"><template><section><ul data-ae="io-inner"><template><li></li></template></ul></section></template></div>`);
  await tick();
  ae('io-inner').list(ae.signal(['x', 'y']), () => {});
  ae('io-outer').list(ae.signal(['A']), () => {});
  await tick();
  const leaf = root.querySelector('li');
  const section = root.querySelector('section');
  assert(ae.itemOf(leaf) === 'x', 'nested: innermost list item wins');
  assert(ae.itemOf(section) === 'A', 'nested: outer stamped node yields the outer item');
}

// ============================================================================
// ae.settled + ae.transition (v4)
// ============================================================================

// --- settled: resolves only after flush AND mount pipeline are done ---------
{
  const host = el(`<div data-ae="st-list"><template><p><span data-ae="st-part"></span></p></template></div>`);
  ae('st-part').mount((n) => { n.textContent = 'mounted'; });
  const items = ae.signal([{ id: 1 }]);
  ae('st-list').list(items, () => {}, (x) => x.id);
  await ae.settled();
  assert(host.querySelectorAll('p').length === 1, 'settled waits for list stamping');
  assert(host.querySelector('[data-ae="st-part"]').textContent === 'mounted', 'settled waits past MutationObserver mount delivery');
  items.value = [{ id: 1 }, { id: 2 }];
  await ae.settled();
  assert(host.querySelectorAll('p').length === 2, 'settled after a later write sees the new DOM');
  host.remove();
  await tick();
}

// --- transition: fallback path (no startViewTransition, as in jsdom) --------
{
  const target = el(`<b data-ae="tr-txt"></b>`);
  const msg = ae.signal('a');
  ae('tr-txt').text(msg);
  await tick();
  let ran = false;
  const ret = ae.transition(() => { ran = true; msg.value = 'b'; });
  assert(ran === true, 'transition fallback runs fn synchronously');
  assert(ret === undefined, 'transition fallback returns undefined');
  await tick();
  assert(target.textContent === 'b', 'fallback mutation still applies');
  target.remove();
  await tick();
}

// --- transition: with (mocked) document.startViewTransition ------------------
{
  const target = el(`<div data-ae="vt-list"><template><q data-ae="vt-part"></q></template></div>`);
  ae('vt-part').mount((n) => { n.textContent = 'ok'; });
  const items = ae.signal([]);
  ae('vt-list').list(items, () => {}, (x) => x);
  await tick();

  let calls = 0;
  document.startViewTransition = (cb) => {
    calls++;
    const done = cb();
    return { updateCallbackDone: done, finished: done, ready: done, skipTransition() {} };
  };

  const t = ae.transition(() => { items.value = ['x', 'y']; });
  assert(calls === 1, 'transition uses document.startViewTransition when available');
  assert(typeof t.skipTransition === 'function', 'transition returns the ViewTransition object');
  assert(target.querySelectorAll('q').length === 0, 'writes stay batched — DOM unchanged synchronously');
  await t.updateCallbackDone;
  assert(target.querySelectorAll('q').length === 2, 'updateCallbackDone resolves only after the DOM applied');
  assert([...target.querySelectorAll('q')].every((n) => n.textContent === 'ok'), 'updateCallbackDone resolves after the mount pipeline too');
  delete document.startViewTransition;
  target.remove();
  await tick();
}

// --- transition: cascading writes from mounts settle before the snapshot ----
{
  document.startViewTransition = (cb) => {
    const done = cb();
    return { updateCallbackDone: done, finished: done, ready: done, skipTransition() {} };
  };
  const host = el(`<div data-ae="vt2-list"><template><i></i></template></div>`);
  const shown = el(`<u data-ae="vt2-count"></u>`);
  const cascade = ae.signal(0);
  ae('vt2-count').text(cascade);
  const items2 = ae.signal([]);
  ae('vt2-list').list(items2, (n) => { n.dataset.ae = 'vt2-part'; }, (x) => x);
  ae('vt2-part').mount(() => { cascade.value++; });
  await tick();
  const t2 = ae.transition(() => { items2.value = ['a']; });
  await t2.updateCallbackDone;
  assert(shown.textContent === '1', 'cascading writes from mount bindings settle before the new snapshot');
  delete document.startViewTransition;
  host.remove();
  shown.remove();
  await tick();
}

// ===========================================================================
// Regressions from the 2026-07-19 external review
// ===========================================================================

// --- R1: removing a .list container unmounts its stamped descendants --------
{
  const dep = ae.signal(0);
  let mounts = 0;
  let cleanups = 0;
  let renders = 0;
  ae('r1-row')
    .mount(() => { mounts++; return () => cleanups++; })
    .render(() => { renders++; void dep.value; });
  const ul = el('<ul data-ae="r1-list"><template><li data-ae="r1-row"></li></template></ul>');
  await tick();
  ae('r1-list').list(ae.signal(['a', 'b', 'c']), () => {});
  await tick();
  assert(mounts === 3 && renders === 3, `rows mounted (mounts=${mounts}, renders=${renders})`);
  ul.remove(); // the container itself carries data-ae — its own cleanup
  await tick(); // detaches the rows before descendants are visited
  assert(cleanups === 3, `container removal unmounts stamped rows (cleanups=${cleanups})`);
  dep.value = 1;
  await tick();
  assert(renders === 3, `removed rows' renders are disposed, not just counted (renders=${renders})`);
}

// --- R2: a throwing .scope() cleanup still retires scoped handles ------------
{
  const root = el('<div data-ae="r2-root"><button data-ae="r2-btn"></button></div>');
  const btn = root.querySelector('button');
  await tick();
  let presses = 0;
  ae('r2-root').scope((r) => {
    ae('r2-btn', r).press(() => presses++);
    return () => { throw new Error('cleanup boom'); };
  });
  const origError = console.error;
  console.error = () => {};
  root.remove();
  await tick();
  console.error = origError;
  document.body.append(root);
  await tick();
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert(presses === 1, `throwing scope cleanup does not stack bindings on remount (presses=${presses})`);
}

// --- R3: diamond dependency — no glitch, single recompute --------------------
{
  const s = ae.signal(1);
  let cComputes = 0;
  const a = ae.computed(() => s.value > 0);
  const b = ae.computed(() => s.value < 10);
  const c = ae.computed(() => { cComputes++; return a.value && b.value; });
  let effectRuns = 0;
  const dispose = effect(() => { effectRuns++; void c.value; });
  assert(cComputes === 1 && effectRuns === 1, 'diamond primes once');
  s.value = 2; // a, b, c all recompute to unchanged values
  await tick();
  assert(effectRuns === 1, 'diamond: unchanged final value causes ZERO extra effect runs');
  assert(cComputes === 2, `diamond: C recomputes exactly once per write (got ${cComputes - 1} for one write)`);
  s.value = -1; // a flips → c flips
  await tick();
  assert(effectRuns === 2 && cComputes === 3, 'diamond: changed value → exactly one effect run, one recompute');
  dispose();
}

// --- R4: first-read throw does not poison the computed -----------------------
{
  let shouldThrow = true;
  const c = ae.computed(() => { if (shouldThrow) throw new Error('boom'); return 42; });
  let threw = false;
  try { void c.value; } catch { threw = true; }
  assert(threw, 'first read of a throwing computed throws to the reader');
  shouldThrow = false;
  assert(c.value === 42, 'a later read retries instead of returning undefined forever');
}

// --- R5: computed throw during propagation is isolated -----------------------
{
  const s = ae.signal(0);
  const bad = ae.computed(() => { if (s.value > 0) throw new Error('boom'); return 'ok'; });
  const good = ae.computed(() => s.value * 2);
  let badRuns = 0;
  let goodRuns = 0;
  let plainRuns = 0;
  const d1 = effect(() => { badRuns++; void bad.value; });
  const d2 = effect(() => { goodRuns++; void good.value; });
  const d3 = effect(() => { plainRuns++; void s.value; });
  const origError = console.error;
  let logged = false;
  console.error = (...args) => { if (String(args[0]).includes('computed threw')) logged = true; };
  let writeThrew = false;
  try { s.value = 1; } catch { writeThrew = true; }
  await tick();
  console.error = origError;
  assert(!writeThrew, 'a throwing computed never throws at the signal writer');
  assert(logged, 'flush-time computed error is logged');
  assert(goodRuns === 2 && plainRuns === 2, 'sibling computed and plain effects still run');
  assert(badRuns === 1, 'the throwing computed does not run its own subscribers');
  d1(); d2(); d3();
}

// --- R6: automatic recovery after a flush-time throw --------------------------
{
  const s = ae.signal(1);
  const c = ae.computed(() => { if (s.value === 2) throw new Error('boom'); return s.value * 10; });
  const seen = [];
  const d = effect(() => { seen.push(c.value); });
  const origError = console.error;
  console.error = () => {};
  s.value = 2; // evaluation throws at flush; subscriber keeps 10
  await tick();
  s.value = 3; // the next dependency write must re-queue the computed
  await tick();
  console.error = origError;
  assert(seen.join(',') === '10,30', `subscribers recover with no imperative read (got ${seen.join(',')})`);
  d();
}

// --- R7: recovery after the dependency set changed, then threw ----------------
{
  const useB = ae.signal(false);
  const aSig = ae.signal(1);
  const bSig = ae.signal(-1);
  const c = ae.computed(() => {
    const v = useB.value ? bSig.value : aSig.value;
    if (v < 0) throw new Error('neg');
    return v;
  });
  const seen = [];
  const d = effect(() => { seen.push(c.value); });
  const origError = console.error;
  console.error = () => {};
  useB.value = true; // switches the dep set to bSig, then throws (-1)
  await tick();
  bSig.value = 5; // a write to the NEW dep must recover it
  await tick();
  console.error = origError;
  assert(seen.join(',') === '1,5', `computed recovers after dep-set switch + throw (got ${seen.join(',')})`);
  d();
}

// --- R8: unobserved computed goes cold ----------------------------------------
{
  const s = ae.signal(1);
  let computes = 0;
  const c = ae.computed(() => { computes++; return s.value + 1; });
  const d = effect(() => { void c.value; });
  assert(computes === 1, 'computed primed by its effect');
  d();
  s.value = 2;
  await tick();
  assert(computes === 1, 'computed with no subscribers does not recompute on writes');
  assert(c.value === 3 && computes === 2, 'a later read pulls a fresh value on demand');
}

// --- R9: synchronous fresh read right after a write ---------------------------
{
  const s = ae.signal(1);
  const c = ae.computed(() => s.value * 2);
  assert(c.value === 2, 'initial computed read');
  s.value = 5;
  assert(c.value === 10, 'computed read immediately after a write is fresh (no tick)');
  await tick();
}

// --- R10: deep chain equality cutoff ------------------------------------------
{
  const s = ae.signal(5);
  const clamped = ae.computed(() => Math.min(s.value, 10));
  const doubled = ae.computed(() => clamped.value * 2);
  let runs = 0;
  const d = effect(() => { runs++; void doubled.value; });
  s.value = 7;
  await tick();
  assert(runs === 2, 'changed chain value re-runs the effect');
  s.value = 20; // clamps to 10 — changed
  await tick();
  assert(runs === 3, 'clamp boundary change propagates');
  s.value = 30; // still clamped to 10 — unchanged
  await tick();
  assert(runs === 3, 'unchanged clamped value does not re-run the effect');
  d();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
