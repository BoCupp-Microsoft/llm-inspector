import { test, expect, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Micro-benchmark: prove the turn-evolution diff view virtualizes a large context — mounting only
// the visible window of rows — and that this reduces DOM size and JS heap versus rendering every
// row. Uses the hidden ?perf lab (synthetic data, no Copilot/server data), the real built bundle,
// and Edge launched with --enable-precise-memory-info + --expose-gc (see playwright.config.ts).

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DIST_INDEX = join(REPO_ROOT, 'web', 'dist', 'index.html');
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

// Large enough that the non-virtualized render is genuinely unwieldy (turn 0 alone is ~1200 rows).
const TURNS = 30;
const LINES = 1200;

declare global {
  interface Window {
    __perfLab?: {
      ready: boolean;
      metrics: () => {
        domNodes: number;
        diffRows: number;
        turnBlocks: number;
        build: { count: number; totalMs: number; lastMs: number };
        window: { count: number; totalMs: number; lastMs: number };
        render: { count: number; totalMs: number; lastMs: number };
      };
      memory: () => { usedJSHeapSize: number | null; totalJSHeapSize: number | null };
      peakDomNodes: () => number;
      scrollThrough: (steps?: number, dwellMs?: number) => Promise<{ samples: number; peakDom: number }>;
      gc: () => boolean;
    };
  }
}

let server: ChildProcess | null = null;

function buildBundle() {
  const vite = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const r = spawnSync(process.execPath, [vite, 'build', '--config', 'web/vite.config.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`vite build failed:\n${r.stdout}\n${r.stderr}`);
}

async function waitForHttp(url: string, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    const ok = await fetch(url).then((r) => r.ok).catch(() => false);
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

test.beforeAll(async () => {
  buildBundle();
  if (!existsSync(DIST_INDEX)) throw new Error('web/dist not built');
  server = spawn(process.execPath, [join(REPO_ROOT, 'server', 'index.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      VIEWER_PORT: String(PORT),
      // Point at throwaway paths so the server has no real sessions to enrich.
      TRACER_DB: join(REPO_ROOT, 'sessions', `perf-nonexistent-${Date.now()}.db`),
      COPILOT_SESSION_STORE: join(REPO_ROOT, 'sessions', 'perf-nonexistent-store.db'),
    },
    stdio: 'ignore',
  });
  await waitForHttp(`${BASE}/`);
});

test.afterAll(() => {
  if (server?.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill('SIGTERM');
  }
});

interface RunResult {
  diffRows: number;
  turnBlocks: number;
  peakDom: number;
  build: { count: number; totalMs: number };
  window: { count: number; totalMs: number };
  render: { count: number; totalMs: number };
  usedHeap: number | null;
}

async function stabilizeHeap(page: Page): Promise<number | null> {
  let best: number | null = null;
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__perfLab?.gc?.());
    await page.waitForTimeout(250);
    const used = await page.evaluate(() => window.__perfLab?.memory().usedJSHeapSize ?? null);
    if (used != null) best = best == null ? used : Math.min(best, used);
  }
  return best;
}

async function runConfig(browser: Browser, virtual: boolean): Promise<RunResult> {
  // Fresh context per run so each measurement starts from a clean document/heap.
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/?perf=1&turns=${TURNS}&lines=${LINES}&virtual=${virtual ? 1 : 0}`);
    await page.waitForFunction(() => window.__perfLab?.ready === true, null, { timeout: 60000 });
    // Let the first paint + render measure settle.
    await page.waitForTimeout(200);

    // Scroll top -> bottom so a virtualized list mounts/unmounts rows across the whole range and a
    // non-virtualized list is fully realized; this is where the memory difference shows up.
    await page.evaluate(() => window.__perfLab!.scrollThrough(24, 40));

    const usedHeap = await stabilizeHeap(page);
    const m = await page.evaluate(() => {
      const api = window.__perfLab!;
      const met = api.metrics();
      return {
        diffRows: met.diffRows,
        turnBlocks: met.turnBlocks,
        peakDom: api.peakDomNodes(),
        build: { count: met.build.count, totalMs: met.build.totalMs },
        window: { count: met.window.count, totalMs: met.window.totalMs },
        render: { count: met.render.count, totalMs: met.render.totalMs },
      };
    });
    return { ...m, usedHeap };
  } finally {
    await context.close();
  }
}

test('virtualized diff view mounts far fewer rows and uses less heap than the full render', async ({ browser }) => {
  // Run the heavier (non-virtual) config first and tear it down, then the virtual config, so any
  // shared renderer heap is reclaimed before the virtual measurement.
  const full = await runConfig(browser, false);
  const virt = await runConfig(browser, true);

  // eslint-disable-next-line no-console
  console.log('[perf] non-virtual:', JSON.stringify(full));
  // eslint-disable-next-line no-console
  console.log('[perf] virtual    :', JSON.stringify(virt));

  // performance.measure instrumentation is present and firing.
  expect(virt.build.count, 'evolution:build measure recorded').toBeGreaterThan(0);
  expect(virt.window.count, 'evolution:window measure recorded (virtualized only)').toBeGreaterThan(0);
  expect(full.window.count, 'no windowing work in the non-virtual path').toBe(0);
  expect(virt.render.count, 'evolution:render measure recorded').toBeGreaterThan(0);

  // Both paths render the same synthetic context.
  expect(full.turnBlocks).toBe(TURNS);

  // The non-virtual render realizes the whole context (turn 0 alone is ~LINES rows).
  expect(full.diffRows).toBeGreaterThan(LINES);
  // The virtual render only mounts a small window of diff rows regardless of context size.
  expect(virt.diffRows).toBeLessThan(600);
  expect(virt.diffRows * 5).toBeLessThan(full.diffRows);

  // Peak DOM node count during the whole scroll is dramatically lower when virtualized.
  expect(virt.peakDom * 3).toBeLessThan(full.peakDom);

  // Heap: only assert if the engine exposed precise memory (it should under the configured flags).
  if (full.usedHeap != null && virt.usedHeap != null) {
    // eslint-disable-next-line no-console
    console.log(`[perf] heap full=${full.usedHeap} virt=${virt.usedHeap} ratio=${(virt.usedHeap / full.usedHeap).toFixed(3)}`);
    expect(virt.usedHeap, 'virtualized heap should be smaller after stabilization').toBeLessThan(full.usedHeap);
  } else {
    test.info().annotations.push({ type: 'warning', description: 'performance.memory unavailable; skipped heap assertion' });
  }
});
