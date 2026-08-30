// Line-based diff optimized for append-heavy prompts: trim common prefix/suffix,
// then run LCS only on the differing middle (with a size-guard fallback).

export type DiffTag = 'eq' | 'del' | 'ins';

export interface DiffOp {
  tag: DiffTag;
  text: string;
  ano: number | null; // 1-based line number in the "old" turn
  bno: number | null; // 1-based line number in the "new" turn
}

const MAX_CELLS = 4_000_000;

function diffMiddle(a: string[], b: string[], offset: number): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const ops: DiffOp[] = [];
  if (n === 0) {
    for (let j = 0; j < m; j++) ops.push({ tag: 'ins', text: b[j], ano: null, bno: offset + j + 1 });
    return ops;
  }
  if (m === 0) {
    for (let i = 0; i < n; i++) ops.push({ tag: 'del', text: a[i], ano: offset + i + 1, bno: null });
    return ops;
  }
  if (n * m > MAX_CELLS) {
    for (let i = 0; i < n; i++) ops.push({ tag: 'del', text: a[i], ano: offset + i + 1, bno: null });
    for (let j = 0; j < m; j++) ops.push({ tag: 'ins', text: b[j], ano: null, bno: offset + j + 1 });
    return ops;
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: 'eq', text: a[i], ano: offset + i + 1, bno: offset + j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ tag: 'del', text: a[i], ano: offset + i + 1, bno: null });
      i++;
    } else {
      ops.push({ tag: 'ins', text: b[j], ano: null, bno: offset + j + 1 });
      j++;
    }
  }
  while (i < n) ops.push({ tag: 'del', text: a[i], ano: offset + i + 1, bno: null }), i++;
  while (j < m) ops.push({ tag: 'ins', text: b[j], ano: null, bno: offset + j + 1 }), j++;
  return ops;
}

export function lineDiff(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ tag: 'eq', text: a[i], ano: i + 1, bno: i + 1 });
  ops.push(...diffMiddle(a.slice(start, aEnd), b.slice(start, bEnd), start));
  for (let k = 0; aEnd + k < a.length; k++) {
    ops.push({ tag: 'eq', text: a[aEnd + k], ano: aEnd + k + 1, bno: bEnd + k + 1 });
  }
  return ops;
}

export function splitLines(text: string | null | undefined): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface DiffStats {
  added: number;
  removed: number;
  common: number;
}

export function diffStats(ops: DiffOp[]): DiffStats {
  let added = 0;
  let removed = 0;
  let common = 0;
  for (const op of ops) {
    if (op.tag === 'ins') added++;
    else if (op.tag === 'del') removed++;
    else common++;
  }
  return { added, removed, common };
}
