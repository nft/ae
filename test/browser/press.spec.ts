import { test, expect, type Page } from '@playwright/test';

// Real keyboard activation — the jsdom suite can only dispatch synthetic
// events; here the browser itself synthesizes clicks, repeats keys, and
// scrolls, which is exactly what .press() must cooperate with.

declare global {
  interface Window {
    ae: any;
    count: number;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/test/browser/fixture.html');
  await page.waitForFunction(() => window.ae !== undefined);
});

async function bindPress(page: Page, name: string): Promise<void> {
  await page.evaluate((n) => {
    window.count = 0;
    window.ae(n).press(() => window.count++);
  }, name);
}

const count = (page: Page) => page.evaluate(() => window.count);

test('Enter on a native button fires exactly once', async ({ page }) => {
  await bindPress(page, 'btn');
  await page.locator('[data-ae="btn"]').focus();
  await page.keyboard.press('Enter');
  expect(await count(page)).toBe(1);
});

test('Space on a native button fires exactly once', async ({ page }) => {
  await bindPress(page, 'btn');
  await page.locator('[data-ae="btn"]').focus();
  await page.keyboard.press('Space');
  expect(await count(page)).toBe(1);
});

test('mouse click fires exactly once', async ({ page }) => {
  await bindPress(page, 'btn');
  await page.locator('[data-ae="btn"]').click();
  expect(await count(page)).toBe(1);
});

test('Enter on div[tabindex] fires exactly once', async ({ page }) => {
  await bindPress(page, 'divbtn');
  await page.locator('[data-ae="divbtn"]').focus();
  await page.keyboard.press('Enter');
  expect(await count(page)).toBe(1);
});

test('Space on div[tabindex] fires once and never scrolls the page', async ({ page }) => {
  await bindPress(page, 'divbtn');
  await page.locator('[data-ae="divbtn"]').focus();
  await page.keyboard.press('Space');
  expect(await count(page)).toBe(1);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('Space typed into a press-bound input is not hijacked', async ({ page }) => {
  await bindPress(page, 'field');
  const field = page.locator('[data-ae="field"]');
  await field.focus();
  await page.keyboard.type('a b');
  await expect(field).toHaveValue('a b');
  expect(await count(page)).toBe(0);
});

test('Space in an input nested inside a press target types normally', async ({ page }) => {
  await bindPress(page, 'card');
  const inner = page.locator('[data-ae="cardfield"]');
  await inner.focus();
  await page.keyboard.type('a b');
  await expect(inner).toHaveValue('a b');
  expect(await count(page)).toBe(0);
});
