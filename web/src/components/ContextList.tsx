import type { ContextRow } from '../types';

export function ContextList({
  contexts,
  selectedId,
  onSelect,
}: {
  contexts: ContextRow[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="pane contexts">
      <div className="pane-header">Contexts <span className="count">{contexts.length}</span></div>
      <div className="pane-body">
        {contexts.length === 0 && <div className="empty">Select a session.</div>}
        {contexts.map((c) => (
          <button
            key={c.context_id}
            className={`row context-row ctx-${c.kind || 'main'} ${c.context_id === selectedId ? 'active' : ''}`}
            onClick={() => onSelect(c.context_id)}
          >
            <div className="row-top">
              <span className="title">{c.label || `Context ${c.context_id}`}</span>
              <span className="count">{c.turn_count}</span>
            </div>
            {c.kind === 'background' && (
              <div className="row-sub" title="Auxiliary calls (title/summary) Copilot does not bill; excluded from completeness check">
                aux · not billed
              </div>
            )}
            {c.agent_id && <div className="row-sub">{c.agent_id}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}
