import { useEffect } from 'react';
import { useTracer } from './useTracer';
import { SessionList } from './components/SessionList';
import { ContextList } from './components/ContextList';
import { TurnEvolution } from './components/TurnEvolution';
import { TurnDetail } from './components/TurnDetail';

export function App() {
  const t = useTracer();

  // Auto-select the first context when a session's contexts load.
  useEffect(() => {
    if (t.selectedSessionId && t.contexts.length > 0 && t.selectedContextId == null) {
      t.selectContext(t.contexts[0].context_id);
    }
  }, [t.contexts, t.selectedSessionId, t.selectedContextId, t]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">agent-loop</span>
        <span className="tagline">Copilot CLI turn viewer</span>
        <span className={`conn ${t.connected ? 'on' : 'off'}`}>
          {t.connected ? 'live' : 'reconnecting…'}
        </span>
      </header>
      <div className="columns">
        <SessionList sessions={t.sessions} selectedId={t.selectedSessionId} onSelect={t.selectSession} />
        <ContextList contexts={t.contexts} selectedId={t.selectedContextId} onSelect={t.selectContext} />
        <TurnEvolution turns={t.turns} onOpen={t.openTurn} />
      </div>
      {t.turnDetail && <TurnDetail turn={t.turnDetail} onClose={t.closeTurn} />}
    </div>
  );
}
