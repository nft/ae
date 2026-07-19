import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    ae: any;
    count: number;
    focused: boolean;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/test/browser/fixture.html');
  await page.waitForFunction(() => window.ae !== undefined);
});

test('Tab lands focus on the button and Enter activates it', async ({ page, browserName }) => {
  await page.evaluate(() => {
    window.count = 0;
    window.ae('btn').press(() => window.count++);
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // The button is the first tabbable element; WebKit mirrors Safari, where
  // plain Tab skips buttons and Option+Tab cycles every focusable.
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-ae'))).toBe('btn');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.count)).toBe(1);
});

test('.on(focus) fires via the per-element listener (focus does not bubble)', async ({ page }) => {
  await page.evaluate(() => {
    window.focused = false;
    window.ae('field').on('focus', () => (window.focused = true));
  });
  await page.locator('[data-ae="field"]').focus();
  expect(await page.evaluate(() => window.focused)).toBe(true);
});
