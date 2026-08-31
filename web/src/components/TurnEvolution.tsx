import { useMemo } from 'react';
import type { TurnLite } from '../types';
import { buildRows, estimateRowHeight, type EvoRow } from '../evolution-model';
import { VirtualList, type VirtualListHandle } from './VirtualList';

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

function TurnHeaderRow({ row, onOpen }: { row: Extract<EvoRow, { kind: 'turn' }>; onOpen: (id: number) => void }) {
  const { stats, prefix } = row;
  return (
    <section className="turn-block">
      <header className="turn-head">
        <span className="turn-label">Turn {row.turnIndex}</span>
        {row.model && <span className="pill">{row.model}</span>}
        {row.finishReason && <span className="pill subtle">{row.finishReason}</span>}
        <span className="stats">
          <span className="add">+{stats.added}</span>
          <span className="del">-{stats.removed}</span>
          {row.turnIndex > 0 && <span className="eq">{stats.common} common</span>}
          {row.turnIndex > 0 && (
            <span
              className="bytes"
              title={`Leading canonical-prompt content identical to the previous turn in this context: ${prefix.lines} lines / ${formatBytes(prefix.bytes)} — the prefix-cache candidate. Measured on the ordered, normalized prompt, not raw wire bytes.`}
            >
              prefix {(prefix.ratio * 100).toFixed(1)}%
            </span>
          )}
          {row.requestPayloadBytes != null && (
            <span
              className="bytes subtle"
              title="Total raw request-payload bytes on the wire for this turn (JSON envelope, tool schemas, escaping) — larger than the canonical prompt the prefix % is measured against."
            >
              payload {formatBytes(row.requestPayloadBytes)}
            </span>
          )}
        </span>
        <button className="link" onClick={() => onOpen(row.turnId)}>
          detail
        </button>
      </header>
    </section>
  );
}

function DiffRow({ row }: { row: EvoRow }) {
  if (row.kind === 'common') {
    return (
      <div className="dl dl-common">
        <span className="gutter" />
        <span className="gutter" />
        <span className="sign" />
        <span className="ln-common">
          {row.count} common line{row.count > 1 ? 's' : ''} (old {formatRange(row.firstOld, row.lastOld)} · new{' '}
          {formatRange(row.firstNew, row.lastNew)})
        </span>
      </div>
    );
  }
  if (row.kind === 'hunk') {
    return (
      <div className="dl dl-hunk">
        <span className="gutter" />
        <span className="gutter" />
        <span className="sign" />
        <span className="code">
          @@ -{row.oldStart},{row.oldCount} +{row.newStart},{row.newCount} @@
        </span>
      </div>
    );
  }
  // line
  if (row.kind !== 'line') return null;
  const op = row.op;
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

function renderRow(row: EvoRow, onOpen: (id: number) => void) {
  if (row.kind === 'turn') return <TurnHeaderRow row={row} onOpen={onOpen} />;
  return <DiffRow row={row} />;
}

export function TurnEvolution({
  turns,
  onOpen,
  virtualize = true,
  handleRef,
}: {
  turns: TurnLite[];
  onOpen: (id: number) => void;
  /** When false, render every row directly (used to A/B against virtualization in the perf lab). */
  virtualize?: boolean;
  handleRef?: (h: VirtualListHandle | null) => void;
}) {
  const rows = useMemo(() => buildRows(turns), [turns]);

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
        {!virtualize && <span className="count warn-badge">no-virt</span>}
      </div>
      {virtualize ? (
        <VirtualList
          items={rows}
          className="evolution-scroll"
          getKey={(r) => r.key}
          estimateHeight={(r) => estimateRowHeight(r)}
          renderItem={(r) => renderRow(r, onOpen)}
          handleRef={handleRef}
        />
      ) : (
        <div className="vlist evolution-scroll">
          {rows.map((r) => (
            <div className="vrow" key={r.key}>
              {renderRow(r, onOpen)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
