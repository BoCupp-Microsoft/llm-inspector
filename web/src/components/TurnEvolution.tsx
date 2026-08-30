import { useMemo } from 'react';
import type { TurnLite } from '../types';
import { buildDiffChunks, commonPrefix, diffStats, lineDiff, splitLines, type DiffChunk, type DiffOp } from '../diff';

function formatBytes(n: number | null): string {
  if (n == null) return '\u2014';
  return `${n.toLocaleString()} B`;
}

function formatRange(first: number | null, last: number | null): string {
  if (first == null && last == null) return '\u2014';
  if (first == null) return `${last}`;
  if (last == null || first === last) return `${first}`;
  return `${first}\u2013${last}`;
}

function DiffLine({ op }: { op: DiffOp }) {
  const kind = op.tag === 'eq' ? 'eq' : op.tag;
  const sign = op.tag === 'del' ? '-' : op.tag === 'ins' ? '+' : '';
  return (
    <div className={`dl dl-${kind}`}>
      <span className="gutter">{op.ano ?? ''}</span>
      <span className="gutter">{op.bno ?? ''}</span>
      <span className="sign">{sign}</span>
      <span className="code">{op.text || '\u00a0'}</span>
    </div>
  );
}

function DiffChunkView({ chunk, chunkKey }: { chunk: DiffChunk; chunkKey: string }) {
  if (chunk.kind === 'common') {
    return (
      <div className="dl dl-common" key={`c-${chunkKey}`}>
        <span className="gutter" />
        <span className="gutter" />
        <span className="sign" />
        <span className="ln-common">
          {chunk.count} common line{chunk.count > 1 ? 's' : ''} (old {formatRange(chunk.firstOld, chunk.lastOld)} · new {formatRange(chunk.firstNew, chunk.lastNew)})
        </span>
      </div>
    );
  }

  return (
    <div className="diff-hunk" key={`h-${chunkKey}`}>
      <div className="dl dl-hunk">
        <span className="gutter" />
        <span className="gutter" />
        <span className="sign" />
        <span className="code">@@ -{chunk.oldStart},{chunk.oldCount} +{chunk.newStart},{chunk.newCount} @@</span>
      </div>
      {chunk.ops.map((op, idx) => (
        <DiffLine key={`${chunkKey}-${idx}`} op={op} />
      ))}
    </div>
  );
}

function DiffRows({ ops }: { ops: DiffOp[] }) {
  const chunks = useMemo(() => buildDiffChunks(ops, 3), [ops]);
  return <>{chunks.map((chunk, idx) => <DiffChunkView key={idx} chunk={chunk} chunkKey={String(idx)} />)}</>;
}

function TurnBlock({
  turn,
  prevText,
  onOpen,
}: {
  turn: TurnLite;
  prevText: string;
  onOpen: (id: number) => void;
}) {
  const ops = useMemo(
    () => lineDiff(splitLines(prevText), splitLines(turn.canonical_prompt_text)),
    [prevText, turn.canonical_prompt_text]
  );
  const stats = useMemo(() => diffStats(ops), [ops]);
  const prefix = useMemo(
    () => commonPrefix(prevText, turn.canonical_prompt_text),
    [prevText, turn.canonical_prompt_text]
  );

  return (
    <section className="turn-block">
      <header className="turn-head">
        <span className="turn-label">Turn {turn.turn_index}</span>
        {turn.model && <span className="pill">{turn.model}</span>}
        {turn.finish_reason && <span className="pill subtle">{turn.finish_reason}</span>}
        <span className="stats">
          <span className="add">+{stats.added}</span>
          <span className="del">-{stats.removed}</span>
          {turn.turn_index > 0 && <span className="eq">{stats.common} common</span>}
          {turn.turn_index > 0 && (
            <span
              className="bytes"
              title={`Leading canonical-prompt content identical to the previous turn in this context: ${prefix.lines} lines / ${formatBytes(prefix.bytes)} — the prefix-cache candidate. Measured on the ordered, normalized prompt, not raw wire bytes.`}
            >
              prefix {(prefix.ratio * 100).toFixed(1)}%
            </span>
          )}
          {turn.request_payload_bytes != null && (
            <span
              className="bytes subtle"
              title="Total raw request-payload bytes on the wire for this turn (JSON envelope, tool schemas, escaping) — larger than the canonical prompt the prefix % is measured against."
            >
              payload {formatBytes(turn.request_payload_bytes)}
            </span>
          )}
        </span>
        <button className="link" onClick={() => onOpen(turn.id)}>
          detail
        </button>
      </header>
      <div className="diff">
        <DiffRows ops={ops} />
      </div>
    </section>
  );
}

export function TurnEvolution({
  turns,
  onOpen,
}: {
  turns: TurnLite[];
  onOpen: (id: number) => void;
}) {
  if (turns.length === 0) {
    return (
      <div className="pane evolution">
        <div className="pane-header">Turn evolution</div>
        <div className="pane-body empty">Select a context to see how its prompt evolves turn over turn.</div>
      </div>
    );
  }
  return (
    <div className="pane evolution">
      <div className="pane-header">
        Turn evolution <span className="count">{turns.length}</span>
      </div>
      <div className="pane-body evolution-scroll">
        {turns.map((t, i) => (
          <TurnBlock
            key={t.id}
            turn={t}
            prevText={i === 0 ? '' : turns[i - 1].canonical_prompt_text || ''}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}
