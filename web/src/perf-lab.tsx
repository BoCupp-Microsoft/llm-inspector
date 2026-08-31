// Perf lab: a hidden, self-contained harness for measuring the turn-evolution diff view under
// large, synthetic contexts. Activated via `?perf=1` (see main.tsx). It renders TurnEvolution with
// generated turns and exposes `window.__perfLab` so the Playwright perf test can drive scrolling
// and read DOM/timing/memory metrics. It never talks to the server, so it runs against the built
// static bundle alone.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TurnEvolution } from './components/TurnEvolution';
import type { VirtualListHandle } from './components/VirtualList';
import type { TurnLite } from './types';
import { mark, measureMarks, PERF, summarize } from './perf';

// Set the render-start mark once at module load — right before React first renders the lab — so the
// evolution:render measure spans build + mount + first paint.
mark('perf:render:start');

interface PerfConfig {
  turns: number;
  lines: number;
  virtualize: boolean;
}

function readConfig(): PerfConfig {
  const p = new URLSearchParams(location.search);
  const num = (k: string, d: number) => {
    const v = Number(p.get(k));
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    turns: Math.floor(num('turns', 40)),
    lines: Math.floor(num('lines', 1200)),
    virtualize: p.get('virtual') !== '0',
  };
}

// Deterministic-ish filler so gzip/JS-string interning doesn't collapse everything to nothing.
function fillerLine(seed: number): string {
  const words = [
    'const', 'return', 'value', 'handler', 'context', 'session', 'canonical', 'prompt', 'buffer',
    'tokenize', 'assistant', 'request', 'payload', 'diff', 'evolution', 'virtual', 'measure',
  ];
  let s = '';
  let x = seed * 2654435761;
  for (let i = 0; i < 12; i++) {
    x = (x ^ (x << 13)) >>> 0;
    s += words[x % words.length] + ' ';
  }
  return s.trim();
}

/**
 * Build `turns` synthetic turns. Turn 0 carries a full `lines`-line prompt (a giant all-insert
 * diff — the worst case). Each subsequent turn keeps a large shared prefix and appends/changes a
 * small tail, mirroring how real Copilot prompts grow turn over turn.
 */
function makeTurns(cfg: PerfConfig): TurnLite[] {
  const base: string[] = [];
  base.push('### [0] system');
  base.push('SYS');
  for (let i = 0; i < cfg.lines; i++) base.push(`${i}: ${fillerLine(i)}`);

  const turns: TurnLite[] = [];
  for (let t = 0; t < cfg.turns; t++) {
    const lines = base.slice(0, base.length); // copy shared prefix
    // Each turn appends a short, unique tail block so there is a real diff every turn.
    lines.push(`### [${t + 1}] tool`);
    for (let k = 0; k < 8; k++) lines.push(`turn ${t} tail ${k}: ${fillerLine(1000 + t * 8 + k)}`);
    const text = lines.join('\n');
    turns.push({
      id: t + 1,
      turn_index: t,
      model: 'gpt-5.4',
      finish_reason: 'completed',
      captured_at: null,
      duration_ms: null,
      status_code: 200,
      canonical_prompt_text: text,
      usage_json: null,
      request_payload_bytes: text.length * 4,
      common_prefix_bytes: null,
    });
  }
  return turns;
}

declare global {
  interface Window {
    __perfLab?: PerfLabApi;
  }
}

interface MemorySample {
  usedJSHeapSize: number | null;
  totalJSHeapSize: number | null;
}

interface PerfLabApi {
  ready: boolean;
  config: PerfConfig;
  metrics: () => {
    domNodes: number;
    diffRows: number;
    turnBlocks: number;
    build: ReturnType<typeof summarize>;
    window: ReturnType<typeof summarize>;
    render: ReturnType<typeof summarize>;
  };
  memory: () => MemorySample;
  peakDomNodes: () => number;
  scrollThrough: (steps?: number, dwellMs?: number) => Promise<{ samples: number; peakDom: number }>;
  gc: () => boolean;
}

function readMemory(): MemorySample {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  if (!mem) return { usedJSHeapSize: null, totalJSHeapSize: null };
  return { usedJSHeapSize: mem.usedJSHeapSize, totalJSHeapSize: mem.totalJSHeapSize };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () =>
  new Promise<void>((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));

export function PerfLab() {
  const cfg = useMemo(readConfig, []);
  const turns = useMemo(() => makeTurns(cfg), [cfg]);
  const handleRef = useRef<VirtualListHandle | null>(null);
  const peakDom = useRef(0);
  const [, setReady] = useState(false);

  // Bracket render-to-paint so tests can read a real evolution:render measure. The start mark is
  // set at module load (above); record the measure on the first painted frame after mount.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => {
      measureMarks(PERF.RENDER, 'perf:render:start');
      peakDom.current = Math.max(peakDom.current, document.querySelectorAll('*').length);
    });
    return () => cancelAnimationFrame(id);
  }, []);

  useLayoutEffect(() => {
    const api: PerfLabApi = {
      ready: true,
      config: cfg,
      metrics: () => ({
        domNodes: document.querySelectorAll('*').length,
        diffRows: document.querySelectorAll('.dl').length,
        turnBlocks: document.querySelectorAll('section.turn-block').length,
        build: summarize(PERF.BUILD),
        window: summarize(PERF.WINDOW),
        render: summarize(PERF.RENDER),
      }),
      memory: readMemory,
      peakDomNodes: () => peakDom.current,
      gc: () => {
        const g = (window as unknown as { gc?: () => void }).gc;
        if (typeof g === 'function') {
          g();
          return true;
        }
        return false;
      },
      scrollThrough: async (steps = 24, dwellMs = 60) => {
        const h = handleRef.current;
        const scroller = document.querySelector('.vlist') as HTMLElement | null;
        let samples = 0;
        for (let i = 0; i <= steps; i++) {
          const frac = i / steps;
          if (h) h.scrollToFraction(frac);
          else if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * frac;
          // Non-virtual path still needs a scroll event to feel realistic.
          scroller?.dispatchEvent(new Event('scroll'));
          await nextFrame();
          await sleep(dwellMs);
          await nextFrame();
          peakDom.current = Math.max(peakDom.current, document.querySelectorAll('*').length);
          samples++;
        }
        return { samples, peakDom: peakDom.current };
      },
    };
    window.__perfLab = api;
    setReady(true);
    return () => {
      if (window.__perfLab === api) delete window.__perfLab;
    };
  }, [cfg]);

  return (
    <div className="app perf-lab">
      <header className="topbar">
        <span className="brand">agent-loop</span>
        <span className="tagline">perf lab</span>
        <span className="conn on">
          {cfg.turns} turns · {cfg.lines} lines · {cfg.virtualize ? 'virtualized' : 'no-virt'}
        </span>
      </header>
      <div className="columns perf-columns">
        <TurnEvolution turns={turns} onOpen={() => {}} virtualize={cfg.virtualize} handleRef={(h) => (handleRef.current = h)} />
      </div>
    </div>
  );
}
