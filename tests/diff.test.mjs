import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiffChunks, lineDiff, splitLines } from '../web/src/diff.ts';

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
