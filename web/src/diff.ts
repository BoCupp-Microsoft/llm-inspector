// Line-based diff tuned for prompt evolution:
// 1) anchor on unique common lines (patience-style) so insertions align more naturally,
// 2) fall back to LCS inside ambiguous regions,
// 3) expose hunk grouping with a little unchanged context around each change.

export type DiffTag = 'eq' | 'del' | 'ins';

export interface DiffOp {
  tag: DiffTag;
  text: string;
  ano: number | null; // 1-based line number in the "old" turn
  bno: number | null; // 1-based line number in the "new" turn
}

const MAX_CELLS = 4_000_000;
const DEFAULT_CONTEXT_LINES = 3;

function pushEq(ops: DiffOp[], text: string, ano: number, bno: number) {
  ops.push({ tag: 'eq', text, ano, bno });
}

function pushDel(ops: DiffOp[], text: string, ano: number) {
  ops.push({ tag: 'del', text, ano, bno: null });
}

function pushIns(ops: DiffOp[], text: string, bno: number) {
  ops.push({ tag: 'ins', text, ano: null, bno });
}

function lcsMiddle(a: string[], b: string[], aOffset: number, bOffset: number): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const ops: DiffOp[] = [];
  if (n === 0) {
    for (let j = 0; j < m; j++) pushIns(ops, b[j], bOffset + j + 1);
    return ops;
  }
  if (m === 0) {
    for (let i = 0; i < n; i++) pushDel(ops, a[i], aOffset + i + 1);
    return ops;
  }
  if (n * m > MAX_CELLS) {
    for (let i = 0; i < n; i++) pushDel(ops, a[i], aOffset + i + 1);
    for (let j = 0; j < m; j++) pushIns(ops, b[j], bOffset + j + 1);
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
      pushEq(ops, a[i], aOffset + i + 1, bOffset + j + 1);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushDel(ops, a[i], aOffset + i + 1);
      i++;
    } else {
      pushIns(ops, b[j], bOffset + j + 1);
      j++;
    }
  }
  while (i < n) pushDel(ops, a[i], aOffset + i + 1), i++;
  while (j < m) pushIns(ops, b[j], bOffset + j + 1), j++;
  return ops;
}

interface Anchor {
  ai: number;
  bi: number;
}

function uniqueAnchors(a: string[], b: string[]): Anchor[] {
  const aCount = new Map<string, number>();
  const bCount = new Map<string, number>();
  const aIndex = new Map<string, number>();
  const bIndex = new Map<string, number>();

  a.forEach((line, idx) => {
    aCount.set(line, (aCount.get(line) || 0) + 1);
    if (!aIndex.has(line)) aIndex.set(line, idx);
  });
  b.forEach((line, idx) => {
    bCount.set(line, (bCount.get(line) || 0) + 1);
    if (!bIndex.has(line)) bIndex.set(line, idx);
  });

  const pairs: Anchor[] = [];
  for (const [line, count] of aCount.entries()) {
    if (count === 1 && bCount.get(line) === 1) {
      pairs.push({ ai: aIndex.get(line)!, bi: bIndex.get(line)! });
    }
  }
  pairs.sort((x, y) => x.ai - y.ai);
  if (pairs.length <= 1) return pairs;

  const parents = new Array<number>(pairs.length).fill(-1);
  const tails: number[] = [];

  for (let i = 0; i < pairs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]].bi < pairs[i].bi) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) parents[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }

  const seq: Anchor[] = [];
  let cur = tails.length ? tails[tails.length - 1] : -1;
  while (cur >= 0) {
    seq.push(pairs[cur]);
    cur = parents[cur];
  }
  seq.reverse();
  return seq;
}

function diffRange(a: string[], b: string[], aOffset: number, bOffset: number): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) pushEq(ops, a[i], aOffset + i + 1, bOffset + i + 1);

  const aMid = a.slice(start, aEnd);
  const bMid = b.slice(start, bEnd);
  if (aMid.length === 0 || bMid.length === 0) {
    ops.push(...lcsMiddle(aMid, bMid, aOffset + start, bOffset + start));
  } else {
    const anchors = uniqueAnchors(aMid, bMid);
    if (anchors.length === 0) {
      ops.push(...lcsMiddle(aMid, bMid, aOffset + start, bOffset + start));
    } else {
      let aPos = 0;
      let bPos = 0;
      for (const anchor of anchors) {
        ops.push(
          ...diffRange(
            aMid.slice(aPos, anchor.ai),
            bMid.slice(bPos, anchor.bi),
            aOffset + start + aPos,
            bOffset + start + bPos
          )
        );
        pushEq(
          ops,
          aMid[anchor.ai],
          aOffset + start + anchor.ai + 1,
          bOffset + start + anchor.bi + 1
        );
        aPos = anchor.ai + 1;
        bPos = anchor.bi + 1;
      }
      ops.push(
        ...diffRange(
          aMid.slice(aPos),
          bMid.slice(bPos),
          aOffset + start + aPos,
          bOffset + start + bPos
        )
      );
    }
  }

  for (let k = 0; aEnd + k < a.length; k++) {
    pushEq(ops, a[aEnd + k], aOffset + aEnd + k + 1, bOffset + bEnd + k + 1);
  }
  return ops;
}

export function lineDiff(a: string[], b: string[]): DiffOp[] {
  return diffRange(a, b, 0, 0);
}

export function splitLines(text: string | null | undefined): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface CommonPrefix {
  lines: number; // number of identical leading lines
  bytes: number; // UTF-8 bytes of the identical leading run (incl. newline separators)
  ratio: number; // prefixBytes / current-turn canonical bytes (0..1)
}

function utf8Bytes(s: string): number {
  // Browser + Node both expose TextEncoder.
  return new TextEncoder().encode(s).length;
}

// Longest common *line* prefix between the previous and current canonical prompt text.
// This is the honest "how much of this turn's prompt is byte-identical to the previous turn"
// metric — the leading run the model's prefix cache can reuse. Measured on canonical prompt
// text (ordered, normalized), NOT raw wire bytes, so it matches the diff view's "N common".
export function commonPrefix(prev: string | null | undefined, next: string | null | undefined): CommonPrefix {
  const a = splitLines(prev);
  const b = splitLines(next);
  const nextBytes = utf8Bytes(next || '');
  let lines = 0;
  let bytes = 0;
  const max = Math.min(a.length, b.length);
  while (lines < max && a[lines] === b[lines]) {
    bytes += utf8Bytes(b[lines]) + 1; // +1 for the '\n' that joins each line
    lines++;
  }
  const ratio = nextBytes > 0 ? Math.min(1, bytes / nextBytes) : 0;
  return { lines, bytes, ratio };
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

export interface DiffCommonChunk {
  kind: 'common';
  count: number;
  firstOld: number | null;
  lastOld: number | null;
  firstNew: number | null;
  lastNew: number | null;
}

export interface DiffHunk {
  kind: 'hunk';
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  ops: DiffOp[];
}

export type DiffChunk = DiffCommonChunk | DiffHunk;

function firstNonNull(nums: Array<number | null>): number | null {
  for (const num of nums) {
    if (num != null) return num;
  }
  return null;
}

function lastNonNull(nums: Array<number | null>): number | null {
  for (let i = nums.length - 1; i >= 0; i--) {
    if (nums[i] != null) return nums[i];
  }
  return null;
}

function makeCommonChunk(ops: DiffOp[]): DiffCommonChunk {
  return {
    kind: 'common',
    count: ops.length,
    firstOld: firstNonNull(ops.map((op) => op.ano)),
    lastOld: lastNonNull(ops.map((op) => op.ano)),
    firstNew: firstNonNull(ops.map((op) => op.bno)),
    lastNew: lastNonNull(ops.map((op) => op.bno)),
  };
}

function makeHunk(ops: DiffOp[]): DiffHunk {
  const oldLines = ops.map((op) => op.ano).filter((n): n is number => n != null);
  const newLines = ops.map((op) => op.bno).filter((n): n is number => n != null);
  return {
    kind: 'hunk',
    oldStart: oldLines[0] ?? 0,
    oldCount: oldLines.length,
    newStart: newLines[0] ?? 0,
    newCount: newLines.length,
    ops,
  };
}

export function buildDiffChunks(ops: DiffOp[], contextLines = DEFAULT_CONTEXT_LINES): DiffChunk[] {
  if (ops.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].tag === 'eq') {
      i++;
      continue;
    }
    let start = i;
    let end = i;
    while (end + 1 < ops.length && ops[end + 1].tag !== 'eq') end++;
    start = Math.max(0, start - contextLines);
    end = Math.min(ops.length - 1, end + contextLines);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev.end + 1) prev.end = Math.max(prev.end, end);
    else ranges.push({ start, end });
    i = end + 1;
  }

  if (ranges.length === 0) return [makeCommonChunk(ops)];

  const chunks: DiffChunk[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) chunks.push(makeCommonChunk(ops.slice(cursor, range.start)));
    chunks.push(makeHunk(ops.slice(range.start, range.end + 1)));
    cursor = range.end + 1;
  }
  if (cursor < ops.length) chunks.push(makeCommonChunk(ops.slice(cursor)));
  return chunks;
}
