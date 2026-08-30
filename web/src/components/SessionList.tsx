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
          const v = s.verification;
          const missing = v?.missing ?? 0;
          const subAgents = v?.subAgents ?? 0;
          const warn =
            missing > 0
              ? `Copilot recorded ${v?.expected} model call(s); only ${v?.capturedAgent} captured — ${missing} not shown. Capture may be incomplete.`
              : '';
          const subInfo =
            subAgents > 0
              ? `Copilot spawned ${subAgents} sub-agent(s) this session. Their turns are included in the merged Main agent timeline (the wire has no signal to separate them).`
              : '';
          return (
            <button
              key={s.session_id}
              className={`row session-row ${s.session_id === selectedId ? 'active' : ''}`}
              onClick={() => onSelect(s.session_id)}
            >
              <div className="row-top">
                <span className="title" title={s.session_id}>{title}</span>
                {missing > 0 && (
                  <span className="warn-badge" title={warn}>⚠ {missing} missing</span>
                )}
                {subAgents > 0 && (
                  <span className="sub-badge" title={subInfo}>⛓ {subAgents} sub</span>
                )}
                <span className={`status status-${s.status || 'unknown'}`}>{s.status || '—'}</span>
              </div>
              <div className="row-sub session-id" title={s.session_id}>{s.session_id}</div>
              <div className="row-meta">
                <span title="captured LLM turns">{s.turn_count} turns</span>
                <span title="contexts (agents)">{s.context_count} ctx</span>
                <span title="AIC = sum(total_nano_aiu)/1e9">AIC {fmtAic(s.aic)}</span>
              </div>
              {warn && <div className="row-warn" title={warn}>{warn}</div>}
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
