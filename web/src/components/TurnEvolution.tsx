import { useMemo } from 'react';
import type { TurnLite } from '../types';
import { diffStats, lineDiff, splitLines, type DiffOp } from '../diff';

function DiffRows({ ops }: { ops: DiffOp[] }) {
  const rows: React.ReactNode[] = [];
  let eqRun: DiffOp[] = [];

  const flushEq = (key: string) => {
    if (eqRun.length === 0) return;
    const first = eqRun[0];
    const last = eqRun[eqRun.length - 1];
    const range =
      eqRun.length > 1 ? `${first.bno}\u2013${last.bno}` : `${first.bno}`;
    rows.push(
      <div className="dl dl-common" key={`c-${key}`}>
        <span className="gutter" />
        <span className="gutter" />
        <span className="sign" />
        <span className="ln-common">{eqRun.length} common line{eqRun.length > 1 ? 's' : ''} ({range})</span>
      </div>
    );
    eqRun = [];
  };

  ops.forEach((op, idx) => {
    if (op.tag === 'eq') {
      eqRun.push(op);
      return;
    }
    flushEq(String(idx));
    rows.push(
      <div className={`dl dl-${op.tag}`} key={idx}>
        <span className="gutter">{op.ano ?? ''}</span>
        <span className="gutter">{op.bno ?? ''}</span>
        <span className="sign">{op.tag === 'del' ? '-' : '+'}</span>
        <span className="code">{op.text || '\u00a0'}</span>
      </div>
    );
  });
  flushEq('end');
  return <>{rows}</>;
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
