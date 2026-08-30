import type { SessionRow } from '../types';

function fmtAic(aic: number | null): string {
  if (aic == null) return '—';
  return aic.toFixed(2);
}

export function SessionList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: SessionRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="pane sessions">
      <div className="pane-header">Sessions <span className="count">{sessions.length}</span></div>
      <div className="pane-body">
        {sessions.length === 0 && <div className="empty">No captured sessions yet.</div>}
        {sessions.map((s) => {
          const title = s.summary || s.repository || s.session_id.slice(0, 8);
          return (
            <button
              key={s.session_id}
              className={`row session-row ${s.session_id === selectedId ? 'active' : ''}`}
              onClick={() => onSelect(s.session_id)}
            >
              <div className="row-top">
                <span className="title" title={s.session_id}>{title}</span>
                <span className={`status status-${s.status || 'unknown'}`}>{s.status || '—'}</span>
              </div>
              <div className="row-meta">
                <span title="captured LLM turns">{s.turn_count} turns</span>
                <span title="contexts (agents)">{s.context_count} ctx</span>
                <span title="AIC = sum(total_nano_aiu)/1e9">AIC {fmtAic(s.aic)}</span>
              </div>
              {(s.repository || s.branch) && (
                <div className="row-sub">{s.repository}{s.branch ? ` · ${s.branch}` : ''}</div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
