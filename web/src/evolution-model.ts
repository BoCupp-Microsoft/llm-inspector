// Flat, virtualization-friendly row model for the turn-evolution diff view.
//
// Instead of nesting turn -> chunk -> line React trees (which forces the whole context into the
// DOM at once), we flatten every context into a single ordered array of typed rows. A windowing
// list can then mount only the rows intersecting the viewport. Keeping this pure (no React) means
// it is unit-testable under Node and instrumentable with performance.measure.
import type { TurnLite } from './types.ts';
import {
  buildDiffChunks,
  commonPrefix,
  diffStats,
  lineDiff,
  splitLines,
  type CommonPrefix,
  type DiffOp,
  type DiffStats,
} from './diff.ts';
import { measure, PERF } from './perf.ts';

export interface TurnRow {
  kind: 'turn';
  key: string;
  turnId: number;
  turnIndex: number;
  model: string | null;
  finishReason: string | null;
  requestPayloadBytes: number | null;
  stats: DiffStats;
  prefix: CommonPrefix;
}

export interface CommonRow {
  kind: 'common';
  key: string;
  count: number;
  firstOld: number | null;
  lastOld: number | null;
  firstNew: number | null;
  lastNew: number | null;
}

export interface HunkRow {
  kind: 'hunk';
  key: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface LineRow {
  kind: 'line';
  key: string;
  op: DiffOp;
}

export type EvoRow = TurnRow | CommonRow | HunkRow | LineRow;

// Rough pixel heights used only to size the scrollbar for not-yet-measured rows; the virtual list
// replaces these with real measured heights once a row has been rendered once.
const H_TURN = 34;
const H_HUNK = 20;
const H_COMMON = 20;
const H_LINE = 18;

/** Estimated height (px) of a row, given an approximate characters-per-visual-line for wrapping. */
export function estimateRowHeight(row: EvoRow, charsPerRow = 140): number {
  switch (row.kind) {
    case 'turn':
      return H_TURN;
    case 'hunk':
      return H_HUNK;
    case 'common':
      return H_COMMON;
    case 'line': {
      const len = row.op.text.length || 1;
      const wraps = charsPerRow > 0 ? Math.max(1, Math.ceil(len / charsPerRow)) : 1;
      return wraps * H_LINE + 2;
    }
    default:
      return H_LINE;
  }
}

/**
 * Flatten an ordered list of turns into a single array of diff rows. Each turn contributes one
 * `turn` header row followed by the rows of its collapsed diff against the previous turn.
 */
export function buildRows(turns: TurnLite[], contextLines = 3): EvoRow[] {
  return measure(PERF.BUILD, () => {
    const rows: EvoRow[] = [];
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const prevText = i === 0 ? '' : turns[i - 1].canonical_prompt_text || '';
      const nextText = turn.canonical_prompt_text || '';
      const ops = lineDiff(splitLines(prevText), splitLines(nextText));
      rows.push({
        kind: 'turn',
        key: `t${turn.id}`,
        turnId: turn.id,
        turnIndex: turn.turn_index,
        model: turn.model,
        finishReason: turn.finish_reason,
        requestPayloadBytes: turn.request_payload_bytes,
        stats: diffStats(ops),
        prefix: commonPrefix(prevText, nextText),
      });

      const chunks = buildDiffChunks(ops, contextLines);
      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        if (chunk.kind === 'common') {
          rows.push({
            kind: 'common',
            key: `t${turn.id}-c${c}`,
            count: chunk.count,
            firstOld: chunk.firstOld,
            lastOld: chunk.lastOld,
            firstNew: chunk.firstNew,
            lastNew: chunk.lastNew,
          });
        } else {
          rows.push({
            kind: 'hunk',
            key: `t${turn.id}-h${c}`,
            oldStart: chunk.oldStart,
            oldCount: chunk.oldCount,
            newStart: chunk.newStart,
            newCount: chunk.newCount,
          });
          for (let k = 0; k < chunk.ops.length; k++) {
            rows.push({ kind: 'line', key: `t${turn.id}-h${c}-l${k}`, op: chunk.ops[k] });
          }
        }
      }
    }
    return rows;
  });
}
