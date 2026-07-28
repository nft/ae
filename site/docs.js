// Shared behavior for the reference pages: highlight the code samples and keep
// the sidebar entry for the member currently in view marked.

import './hl.js';

const HERE = 'doc-toc-here';
// Ignore the sticky nav band at the top, and only consider the upper third of
// the viewport so the marked entry tracks what you are actually reading.
const SPY_MARGIN = '-64px 0px -65% 0px';
const HOME = 'index.html';

const page = location.pathname.split('/').pop() || HOME;
const entries = new Map(); // section element -> sidebar anchor

for (const anchor of document.querySelectorAll('aside a[href*="#"]')) {
  const [file, id] = anchor.getAttribute('href').split('#');
  if (file && file !== page) continue;
  const section = document.getElementById(id);
  if (section) entries.set(section, anchor);
}

const order = [...entries.keys()];
const visible = new Set();

const spy = new IntersectionObserver(
  (records) => {
    for (const record of records) {
      if (record.isIntersecting) visible.add(record.target);
      else visible.delete(record.target);
    }
    const top = order.find((section) => visible.has(section));
    if (!top) return;
    for (const [section, anchor] of entries) anchor.classList.toggle(HERE, section === top);
  },
  { rootMargin: SPY_MARGIN },
);

for (const section of order) spy.observe(section);
