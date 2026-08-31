import { defineConfig } from '@playwright/test';

// Two projects:
//  - `e2e`  : drives a real traced Copilot session in headed Edge (slow, billable, needs copilot).
//  - `perf` : headless micro-benchmark of the diff view's virtualization (no Copilot needed).
//             Launches Edge with precise memory info + exposed GC so the test can read
//             performance.memory and stabilize the heap between A/B runs.
export default defineConfig({
  timeout: 300000,
  expect: { timeout: 30000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  projects: [
    {
      name: 'e2e',
      testDir: './tests/e2e',
      use: {
        channel: 'msedge',
        headless: false,
        viewport: { width: 1400, height: 900 },
        screenshot: 'only-on-failure',
        trace: 'off',
      },
    },
    {
      name: 'perf',
      testDir: './tests/perf',
      use: {
        channel: 'msedge',
        headless: true,
        viewport: { width: 1400, height: 900 },
        screenshot: 'off',
        trace: 'off',
        launchOptions: {
          args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
        },
      },
    },
  ],
});
