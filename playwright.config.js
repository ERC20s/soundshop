// Browser tests for the static site: tests/e2e/*.spec.js against tools/serve.js.
// Run with `npm run test:e2e` (CI installs Chromium with
// `npx playwright install --with-deps chromium` first).
'use strict';

const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 5183);

// A machine whose Chromium was installed outside Playwright (a container image
// with a pinned browser) can point at it; CI uses Playwright's own download.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

module.exports = defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:' + PORT + '/',
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } }
    }
  ],
  webServer: {
    command: 'node tools/serve.js site ' + PORT,
    url: 'http://127.0.0.1:' + PORT + '/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
