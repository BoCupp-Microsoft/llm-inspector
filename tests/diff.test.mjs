import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiffChunks, commonPrefix, lineDiff, splitLines } from '../web/src/diff.ts';

test('lineDiff keeps shared tool output aligned after an inserted header line', () => {
  const before = splitLines(
    [
      '### [0] system',
      'SYS',
      '',
      'File too large to read at once (25.1 KB). Consider using the grep tool to search within the file, or view with view_range to read specific sections.',
      '  (tool_call_id=call_tzI4rkiX8cYcUveiPLR5eWHO)',
      '',
    ].join('\n')
  );
  const after = splitLines(
    [
      '### [0] system',
      'SYS',
      '',
      '### [1] tool',
      'File too large to read at once (25.1 KB). Consider using the grep tool to search within the file, or view with view_range to read specific sections.',
      '  (tool_call_id=call_tzI4rkiX8cYcUveiPLR5eWHO)',
      '',
    ].join('\n')
  );

  const ops = lineDiff(before, after);
  assert.equal(ops.filter((op) => op.tag === 'ins').length, 1);
  assert.equal(ops.filter((op) => op.tag === 'del').length, 0);
  assert.ok(ops.some((op) => op.tag === 'ins' && op.text === '### [1] tool'));
  assert.ok(
    ops.some(
      (op) =>
        op.tag === 'eq' &&
        op.text ===
          'File too large to read at once (25.1 KB). Consider using the grep tool to search within the file, or view with view_range to read specific sections.'
    )
  );
  assert.ok(ops.some((op) => op.tag === 'eq' && op.text === '  (tool_call_id=call_tzI4rkiX8cYcUveiPLR5eWHO)'));
});

test('buildDiffChunks keeps small orientation context around changes', () => {
  const ops = lineDiff(['1', '2', '3', '4', '5', '6', '7'], ['1', '2', 'X', '4', '5', '6', '7']);
  const chunks = buildDiffChunks(ops, 1);

  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((chunk) => chunk.kind),
    ['common', 'hunk', 'common']
  );

  assert.equal(chunks[0].kind, 'common');
  assert.equal(chunks[0].count, 1);

  assert.equal(chunks[1].kind, 'hunk');
  assert.deepEqual(
    chunks[1].ops.map((op) => `${op.tag}:${op.text}`),
    ['eq:2', 'del:3', 'ins:X', 'eq:4']
  );

  assert.equal(chunks[2].kind, 'common');
  assert.equal(chunks[2].count, 3);
});

test('commonPrefix measures shared leading lines as a ratio of the current canonical prompt', () => {
  const prev = ['### [0] system', 'SYS', 'shared', 'old-tail'].join('\n');
  const next = ['### [0] system', 'SYS', 'shared', 'new-a', 'new-b'].join('\n');
  const pfx = commonPrefix(prev, next);

  // First three lines are identical, then they diverge.
  assert.equal(pfx.lines, 3);
  const expectedBytes =
    new TextEncoder().encode('### [0] system').length + 1 +
    new TextEncoder().encode('SYS').length + 1 +
    new TextEncoder().encode('shared').length + 1;
  assert.equal(pfx.bytes, expectedBytes);

  const nextBytes = new TextEncoder().encode(next).length;
  assert.ok(Math.abs(pfx.ratio - pfx.bytes / nextBytes) < 1e-9);
  assert.ok(pfx.ratio > 0 && pfx.ratio < 1);
});

test('commonPrefix is 0 when the first line differs and full when identical', () => {
  assert.equal(commonPrefix('a\nb', 'x\nb').lines, 0);
  assert.equal(commonPrefix('a\nb', 'x\nb').bytes, 0);
  assert.equal(commonPrefix('a\nb', 'x\nb').ratio, 0);

  const same = 'same\ntext';
  const full = commonPrefix(same, same);
  assert.equal(full.lines, 2);
  assert.equal(full.ratio, 1);

  // No previous turn (turn 0) yields an empty prefix.
  assert.equal(commonPrefix(null, 'anything').lines, 0);
  assert.equal(commonPrefix('', '').ratio, 0);
});
