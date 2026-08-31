import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, estimateRowHeight } from '../web/src/evolution-model.ts';

function turn(id, index, text) {
  return {
    id,
    turn_index: index,
    model: 'gpt-5.4',
    finish_reason: 'completed',
    captured_at: null,
    duration_ms: null,
    status_code: 200,
    canonical_prompt_text: text,
    usage_json: null,
    request_payload_bytes: text ? text.length * 4 : null,
    common_prefix_bytes: null,
  };
}

test('buildRows emits one turn header per turn plus its diff rows', () => {
  const base = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const next = base + '\nline 50\nline 51';
  const rows = buildRows([turn(1, 0, base), turn(2, 1, next)]);

  const headers = rows.filter((r) => r.kind === 'turn');
  assert.equal(headers.length, 2);
  assert.equal(headers[0].turnIndex, 0);
  assert.equal(headers[1].turnIndex, 1);
  // Turn 0 vs empty is an all-insert diff, so its stats.added equals the full line count.
  assert.equal(headers[0].stats.added, 50);
  assert.equal(headers[0].stats.removed, 0);
});

test('turn 0 explodes into many line rows (the case virtualization must window)', () => {
  const big = Array.from({ length: 4000 }, (_, i) => `${i}: some canonical prompt content here`).join('\n');
  const rows = buildRows([turn(1, 0, big)]);

  const lineRows = rows.filter((r) => r.kind === 'line');
  // Every source line becomes a diff line row for turn 0 — thousands of DOM rows if not windowed.
  assert.ok(lineRows.length >= 4000, `expected >= 4000 line rows, got ${lineRows.length}`);
  // Exactly one turn header regardless of size.
  assert.equal(rows.filter((r) => r.kind === 'turn').length, 1);
});

test('a mostly-shared turn collapses its shared prefix into common rows, keeping rows bounded', () => {
  const base = Array.from({ length: 2000 }, (_, i) => `shared ${i}`).join('\n');
  const next = base + '\nappended tail 1\nappended tail 2';
  const rows = buildRows([turn(1, 0, base), turn(2, 1, next)]);

  // Rows belonging to turn 2 (index 1): its 2000 shared lines collapse into a "common" chunk row,
  // so the number of rendered rows for turn 2 is tiny relative to its 2002 prompt lines.
  const turn2Start = rows.findIndex((r) => r.kind === 'turn' && r.turnIndex === 1);
  const turn2Rows = rows.slice(turn2Start);
  const turn2Lines = turn2Rows.filter((r) => r.kind === 'line').length;
  assert.ok(turn2Lines < 50, `expected turn 2 to collapse shared prefix, got ${turn2Lines} line rows`);
  assert.ok(turn2Rows.some((r) => r.kind === 'common'));
});

test('estimateRowHeight scales line height with wrapped length and is fixed for other kinds', () => {
  const shortLine = { kind: 'line', key: 'x', op: { tag: 'ins', text: 'short', ano: null, bno: 1 } };
  const longText = 'x'.repeat(700);
  const longLine = { kind: 'line', key: 'y', op: { tag: 'ins', text: longText, ano: null, bno: 2 } };
  const header = { kind: 'turn', key: 't', turnId: 1, turnIndex: 0, model: null, finishReason: null, requestPayloadBytes: null, stats: { added: 0, removed: 0, common: 0 }, prefix: { lines: 0, bytes: 0, ratio: 0 } };

  const shortH = estimateRowHeight(shortLine, 140);
  const longH = estimateRowHeight(longLine, 140);
  assert.ok(longH > shortH, 'a long wrapping line should estimate taller than a short one');
  assert.equal(estimateRowHeight(header), estimateRowHeight(header), 'header height is stable');
  assert.ok(estimateRowHeight(header) > 0);
});
