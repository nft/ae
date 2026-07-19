import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    ae: any;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/test/browser/fixture.html');
  await page.waitForFunction(() => window.ae !== undefined);
});

test('native View Transition wraps a signal write', async ({ page }) => {
  const supported = await page.evaluate(() => 'startViewTransition' in document);
  test.skip(!supported, 'no View Transition support in this browser');
  const returned = await page.evaluate(async () => {
    const ae = window.ae;
    const sig = ae.signal('before');
    ae('out').text(sig);
    await ae.settled();
    const vt = ae.transition(() => {
      sig.value = 'after';
    });
    await vt.finished;
    return typeof vt.skipTransition === 'function';
  });
  expect(returned).toBe(true);
  await expect(page.locator('[data-ae="out"]')).toHaveText('after');
});

test('fallback path runs synchronously without startViewTransition', async ({ page }) => {
  const result = await page.evaluate(async () => {
    Object.defineProperty(document, 'startViewTransition', { value: undefined });
    const ae = window.ae;
    const sig = ae.signal('before');
    ae('out').text(sig);
    await ae.settled();
    let ran = false;
    const ret = ae.transition(() => {
      ran = true;
      sig.value = 'after';
    });
    await ae.settled();
    return { ran, retIsUndefined: ret === undefined };
  });
  expect(result.ran).toBe(true);
  expect(result.retIsUndefined).toBe(true);
  await expect(page.locator('[data-ae="out"]')).toHaveText('after');
});

test('keyed reorder inside a transition preserves node identity', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const ae = window.ae;
    const items = ae.signal([{ id: 1 }, { id: 2 }, { id: 3 }]);
    ae('items').list(
      items,
      (li: HTMLElement, it: { id: number }) => {
        li.textContent = String(it.id);
      },
      (it: { id: number }) => it.id,
    );
    await ae.settled();
    const before = [...document.querySelectorAll('[data-ae="items"] li')];
    before.forEach((li, i) => ((li as any)._tag = i));
    const vt = ae.transition(() => {
      items.value = [{ id: 3 }, { id: 2 }, { id: 1 }];
    });
    if (vt) await vt.finished;
    else await ae.settled();
    const after = [...document.querySelectorAll('[data-ae="items"] li')];
    return {
      order: after.map((li) => li.textContent).join(','),
      tags: after.map((li) => (li as any)._tag).join(','),
    };
  });
  expect(result.order).toBe('3,2,1');
  expect(result.tags).toBe('2,1,0'); // same nodes, moved — not restamped
});
