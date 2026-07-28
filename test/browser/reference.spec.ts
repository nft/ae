import { test, expect, type Page } from '@playwright/test';

// The reference pages share one hand-written sidebar, so a renamed section id
// breaks navigation on four pages that never changed. These tests are the
// deploy gate for that contract: every page loads clean, every anchor
// resolves, every internal link points at something that exists, and the live
// demos survive being pressed.

const PAGES = ['reference', 'reactivity', 'bindings', 'forms', 'lists'] as const;
const ALL = [...PAGES, 'index'] as const;

const url = (name: string): string => `/site/${name}.html`;

/** Console errors and uncaught exceptions collected for the whole page life. */
function watchFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') failures.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => failures.push(`pageerror: ${err.message}`));
  return failures;
}

for (const name of PAGES) {
  test(`${name}.html loads, highlights and wires its demos without errors`, async ({ page }) => {
    const failures = watchFailures(page);
    await page.goto(url(name));

    await expect(page.locator('main h1')).toBeVisible();
    // hl.js ran: it stamps data-hl on every sample it rewrites.
    await expect(page.locator('code.hl[data-hl="done"]').first()).toBeAttached();
    // Each page carries live demos, not just prose.
    expect(await page.locator('main [data-ae]').count()).toBeGreaterThan(0);

    expect(failures).toEqual([]);
  });

  test(`${name}.html resolves every sidebar anchor that targets it`, async ({ page }) => {
    await page.goto(url(name));
    const missing = await page.evaluate((file) => {
      const gaps: string[] = [];
      for (const anchor of document.querySelectorAll('aside a[href*="#"]')) {
        const [target, id] = anchor.getAttribute('href')!.split('#');
        if (target && target !== file) continue;
        if (!document.getElementById(id)) gaps.push(id);
      }
      return gaps;
    }, `${name}.html`);
    expect(missing).toEqual([]);
  });

  test(`${name}.html demos survive a press`, async ({ page }) => {
    const failures = watchFailures(page);
    await page.goto(url(name));
    const buttons = page.locator('main .doc-card button[data-ae]:not([disabled])');
    for (let i = 0; i < (await buttons.count()); i++) {
      await buttons.nth(i).click();
    }
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    expect(failures).toEqual([]);
  });
}

test('the sidebar is the same on every reference page', async ({ page }) => {
  let expected: string[] | undefined;
  for (const name of PAGES) {
    await page.goto(url(name));
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('aside a[href]')].map((a) => a.getAttribute('href')!),
    );
    if (expected === undefined) expected = links;
    else expect(links, `${name}.html sidebar`).toEqual(expected);
  }
});

test('every internal link on the site resolves', async ({ page, request }) => {
  const bodies = new Map<string, string>();
  const fetchOnce = async (path: string): Promise<string> => {
    let body = bodies.get(path);
    if (body === undefined) {
      const response = await request.get(path);
      expect(response.status(), `${path} should be served`).toBe(200);
      body = await response.text();
      bodies.set(path, body);
    }
    return body;
  };

  for (const name of ALL) {
    await page.goto(url(name));
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href')!)
        .filter((href) => !/^(https?:|mailto:)/.test(href)),
    );
    const seenHere = new Set<string>();

    for (const href of links) {
      if (seenHere.has(href)) continue;
      seenHere.add(href);

      if (href.startsWith('#')) {
        if (href === '#') continue; // back-to-top
        await expect(page.locator(href), `${name}.html → ${href}`).toBeAttached();
        continue;
      }
      const [path, hash] = href.split('#');
      const resolved = new URL(path, `http://localhost/site/${name}.html`).pathname;
      const body = await fetchOnce(resolved);
      if (hash) {
        expect(body, `${name}.html → ${href}`).toContain(`id="${hash}"`);
      }
    }
  }
});
