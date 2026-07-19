import { defineConfig, devices } from '@playwright/test';

const PORT = 4242;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'test/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
  },
  webServer: {
    command: 'bun run build && bun scripts/serve.ts',
    url: `${BASE_URL}/`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
