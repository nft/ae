import { test, expect } from '@playwright/test';

// Real MutationObserver timing and shadow DOM — jsdom approximates both.

declare global {
  interface Window {
    ae: any;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/test/browser/fixture.html');
  await page.waitForFunction(() => window.ae !== undefined);
});

test('an element added later is bound by the live observer', async ({ page }) => {
  await page.evaluate(async () => {
    const ae = window.ae;
    ae('late').text('bound');
    document.body.insertAdjacentHTML('beforeend', '<span data-ae="late"></span>');
    await ae.settled();
  });
  await expect(page.locator('[data-ae="late"]')).toHaveText('bound');
});

test('remove + re-append in one task is invisible to bindings', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const ae = window.ae;
    let mounts = 0;
    let cleanups = 0;
    ae('net').mount(() => {
      mounts++;
      return () => cleanups++;
    });
    const node = document.createElement('div');
    node.setAttribute('data-ae', 'net');
    document.body.append(node);
    await ae.settled();
    node.remove();
    document.body.append(node); // same task as the removal
    await ae.settled();
    return { mounts, cleanups };
  });
  expect(result).toEqual({ mounts: 1, cleanups: 0 });
});

test('.list stamps items and parts bind under the real observer', async ({ page }) => {
  await page.evaluate(async () => {
    const ae = window.ae;
    const items = ae.signal([
      { id: 1, t: 'one' },
      { id: 2, t: 'two' },
      { id: 3, t: 'three' },
    ]);
    ae('items').list(
      items,
      (li: HTMLElement, it: { t: string }) => {
        ae.parts(li)['title'].textContent = it.t;
      },
      (it: { id: number }) => it.id,
    );
    await ae.settled();
  });
  await expect(page.locator('[data-ae="items"] li')).toHaveCount(3);
  await expect(page.locator('[data-ae="items"] li b').nth(1)).toHaveText('two');
});

test('ae.observe extends liveness into a shadow root', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const ae = window.ae;
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span data-ae="sh"></span>';
    let cleanups = 0;
    ae('sh').mount((el: HTMLElement) => {
      el.textContent = 'shadow-bound';
      return () => cleanups++;
    });
    ae.observe(shadow);
    await ae.settled();
    const text = shadow.querySelector('span')?.textContent;
    host.remove();
    await ae.settled();
    return { text, cleanups };
  });
  expect(result.text).toBe('shadow-bound');
  expect(result.cleanups).toBe(1);
});
