// Lightweight performance.measure instrumentation for the viewer's hot paths.
//
// These wrappers let tests read real timings via `performance.getEntriesByName(name, 'measure')`
// and let us confirm virtualization actually reduces work (fewer/cheaper window computations,
// smaller diff builds) rather than guessing. Everything degrades to a plain function call when
// the Performance API is unavailable, so the same code runs under Node's test runner.

export const PERF = {
  // Building the flat row model (per-turn diffs + chunking) for a context.
  BUILD: 'evolution:build',
  // Computing the visible window (offsets + range) inside the virtual list.
  WINDOW: 'evolution:window',
  // Full render-to-first-paint of a freshly mounted evolution pane (measured by the perf lab).
  RENDER: 'evolution:render',
} as const;

type PerfName = (typeof PERF)[keyof typeof PERF] | string;

const hasPerf = (): boolean =>
  typeof performance !== 'undefined' && typeof performance.mark === 'function' && typeof performance.measure === 'function';

let seq = 0;

/** Time a synchronous operation and record it as a `performance.measure(name)`. Returns fn's result. */
export function measure<T>(name: PerfName, fn: () => T): T {
  if (!hasPerf()) return fn();
  const startMark = `${name}:start:${++seq}`;
  performance.mark(startMark);
  try {
    return fn();
  } finally {
    try {
      performance.measure(name, { start: startMark });
    } catch {
      // Some engines reject the options form; fall back to a plain measure.
      try {
        performance.measure(name);
      } catch {
        /* ignore */
      }
    }
    try {
      performance.clearMarks(startMark);
    } catch {
      /* ignore */
    }
  }
}

/** Record a single named mark (used to bracket render-to-paint from outside a component). */
export function mark(name: string): void {
  if (hasPerf()) {
    try {
      performance.mark(name);
    } catch {
      /* ignore */
    }
  }
}

/** Record a measure between two previously-recorded marks. */
export function measureMarks(name: PerfName, startMark: string, endMark?: string): void {
  if (!hasPerf()) return;
  try {
    performance.measure(name, endMark ? { start: startMark, end: endMark } : { start: startMark });
  } catch {
    /* ignore missing marks */
  }
}

/** Sum + count of every `performance.measure` recorded under `name` (handy for tests). */
export function summarize(name: PerfName): { count: number; totalMs: number; lastMs: number } {
  if (!hasPerf() || typeof performance.getEntriesByName !== 'function') {
    return { count: 0, totalMs: 0, lastMs: 0 };
  }
  const entries = performance.getEntriesByName(name, 'measure');
  let total = 0;
  for (const e of entries) total += e.duration;
  return { count: entries.length, totalMs: total, lastMs: entries.length ? entries[entries.length - 1].duration : 0 };
}

/** Clear all recorded measures/marks — tests call this between A/B runs. */
export function clearPerf(): void {
  if (!hasPerf()) return;
  try {
    performance.clearMeasures?.();
    performance.clearMarks?.();
  } catch {
    /* ignore */
  }
}
