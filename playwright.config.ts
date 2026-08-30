import { defineConfig } from '@playwright/test';

// Headed Edge so the run can be watched. The e2e test drives a real traced Copilot session,
// so it is slow and must run serially with a single worker.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 300000,
  expect: { timeout: 30000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1400, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'off',
  },
});
