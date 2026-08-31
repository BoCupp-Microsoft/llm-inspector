import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { measure, PERF } from '../perf';

export interface VirtualListHandle {
  scrollTo: (top: number) => void;
  scrollToFraction: (fraction: number) => void;
  metrics: () => { scrollTop: number; total: number; viewport: number; rendered: number };
}

interface VirtualListProps<T> {
  items: T[];
  getKey: (item: T, index: number) => string | number;
  estimateHeight: (item: T, index: number) => number;
  renderItem: (item: T, index: number) => ReactNode;
  overscan?: number;
  className?: string;
  handleRef?: (h: VirtualListHandle | null) => void;
}

/** Largest index i such that offsets[i] <= value (offsets is monotonically non-decreasing). */
function lastAtOrBelow(offsets: Float64Array, value: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= value) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Variable-height windowing list. Only the rows intersecting the viewport (plus an overscan
 * buffer) are mounted; everything else is represented by top/bottom spacer padding so the
 * scrollbar stays accurate. Real row heights are measured after render and cached, so wrapped
 * lines and mixed row types size correctly. The window computation is wrapped in
 * performance.measure(PERF.WINDOW) so tests can confirm it stays cheap.
 */
export function VirtualList<T>({
  items,
  getKey,
  estimateHeight,
  renderItem,
  overscan = 8,
  className,
  handleRef,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const heights = useRef<Map<string | number, number>>(new Map());
  const rafScroll = useRef<number | null>(null);
  const rafMeasure = useRef<number | null>(null);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // Cumulative offsets using measured heights where known, estimates otherwise.
  const layout = useMemo(
    () =>
      measure(PERF.WINDOW, () => {
        const n = items.length;
        const offsets = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) {
          const key = getKey(items[i], i);
          const h = heights.current.get(key) ?? estimateHeight(items[i], i);
          offsets[i + 1] = offsets[i] + h;
        }
        return { offsets, total: offsets[n] };
      }),
    // measureVersion forces a recompute after new measurements land.
    [items, getKey, estimateHeight, measureVersion]
  );

  const range = useMemo(() => {
    const { offsets, total } = layout;
    const n = items.length;
    if (n === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
    const vh = viewportH || 600;
    const start = Math.max(0, lastAtOrBelow(offsets, scrollTop) - overscan);
    let end = lastAtOrBelow(offsets, scrollTop + vh) + 1 + overscan;
    if (end > n) end = n;
    const padTop = offsets[start];
    const padBottom = Math.max(0, total - offsets[end]);
    return { start, end, padTop, padBottom };
  }, [layout, scrollTop, viewportH, items.length, overscan]);

  const flushMeasure = useCallback(() => {
    rafMeasure.current = null;
    setMeasureVersion((v) => v + 1);
  }, []);

  const recordHeight = useCallback(
    (key: string | number, h: number) => {
      const prev = heights.current.get(key);
      if (prev == null || Math.abs(prev - h) > 0.5) {
        heights.current.set(key, h);
        if (rafMeasure.current == null) {
          rafMeasure.current =
            typeof requestAnimationFrame === 'function'
              ? requestAnimationFrame(flushMeasure)
              : (setTimeout(flushMeasure, 0) as unknown as number);
        }
      }
    },
    [flushMeasure]
  );

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (rafScroll.current != null) return;
    rafScroll.current =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => {
            rafScroll.current = null;
            setScrollTop(el.scrollTop);
          })
        : (setTimeout(() => {
            rafScroll.current = null;
            setScrollTop(el.scrollTop);
          }, 0) as unknown as number);
  }, []);

  // Track viewport height.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    setScrollTop(el.scrollTop);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Expose an imperative handle for programmatic scrolling (used by the perf lab + tests).
  useEffect(() => {
    if (!handleRef) return;
    const h: VirtualListHandle = {
      scrollTo: (top) => {
        const el = scrollRef.current;
        if (el) el.scrollTop = top;
      },
      scrollToFraction: (fraction) => {
        const el = scrollRef.current;
        if (el) el.scrollTop = Math.max(0, layout.total - el.clientHeight) * Math.min(1, Math.max(0, fraction));
      },
      metrics: () => ({
        scrollTop: scrollRef.current?.scrollTop ?? 0,
        total: layout.total,
        viewport: scrollRef.current?.clientHeight ?? 0,
        rendered: range.end - range.start,
      }),
    };
    handleRef(h);
    return () => handleRef(null);
  }, [handleRef, layout.total, range.end, range.start]);

  const visible: ReactNode[] = [];
  for (let i = range.start; i < range.end; i++) {
    const item = items[i];
    const key = getKey(item, i);
    visible.push(
      <Measured key={key} rowKey={key} onMeasure={recordHeight}>
        {renderItem(item, i)}
      </Measured>
    );
  }

  return (
    <div ref={scrollRef} className={`vlist${className ? ' ' + className : ''}`} onScroll={onScroll}>
      <div className="vlist-pad" style={{ height: range.padTop }} aria-hidden />
      {visible}
      <div className="vlist-pad" style={{ height: range.padBottom }} aria-hidden />
    </div>
  );
}

function Measured({
  rowKey,
  onMeasure,
  children,
}: {
  rowKey: string | number;
  onMeasure: (key: string | number, h: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    onMeasure(rowKey, el.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (ref.current) onMeasure(rowKey, ref.current.offsetHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowKey, onMeasure]);

  return (
    <div className="vrow" ref={ref}>
      {children}
    </div>
  );
}
