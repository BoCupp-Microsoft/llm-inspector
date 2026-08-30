import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContextRow, SessionRow, TurnFull, TurnLite } from './types';

type SqlResult = { rows?: unknown[]; error?: string };

export interface Tracer {
  connected: boolean;
  sessions: SessionRow[];
  contexts: ContextRow[];
  turns: TurnLite[];
  selectedSessionId: string | null;
  selectedContextId: number | null;
  turnDetail: TurnFull | null;
  selectSession: (id: string) => void;
  selectContext: (id: number) => void;
  openTurn: (id: number) => void;
  closeTurn: () => void;
  runSql: (sql: string) => Promise<SqlResult>;
}

export function useTracer(): Tracer {
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [contexts, setContexts] = useState<ContextRow[]>([]);
  const [turns, setTurns] = useState<TurnLite[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedContextId, setSelectedContextId] = useState<number | null>(null);
  const [turnDetail, setTurnDetail] = useState<TurnFull | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string | null>(null);
  const contextRef = useRef<number | null>(null);
  const sqlWaiters = useRef(new Map<number, (r: SqlResult) => void>());
  const sqlSeq = useRef(0);

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api-ws`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        switch (msg.type) {
          case 'sessions':
            setSessions(msg.sessions);
            break;
          case 'contexts':
            if (msg.sessionId === sessionRef.current) setContexts(msg.contexts);
            break;
          case 'turns':
            if (msg.contextId === contextRef.current) setTurns(msg.turns);
            break;
          case 'turn':
            setTurnDetail(msg.turn);
            break;
          case 'changed':
            send({ type: 'getSessions' });
            if (sessionRef.current) send({ type: 'getContexts', sessionId: sessionRef.current });
            if (contextRef.current != null) send({ type: 'getTurns', contextId: contextRef.current });
            break;
          case 'result': {
            const w = sqlWaiters.current.get(msg.id);
            if (w) {
              w({ rows: msg.rows, error: msg.error });
              sqlWaiters.current.delete(msg.id);
            }
            break;
          }
          default:
            break;
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [send]);

  const selectSession = useCallback(
    (id: string) => {
      sessionRef.current = id;
      contextRef.current = null;
      setSelectedSessionId(id);
      setSelectedContextId(null);
      setContexts([]);
      setTurns([]);
      send({ type: 'getContexts', sessionId: id });
    },
    [send]
  );

  const selectContext = useCallback(
    (id: number) => {
      contextRef.current = id;
      setSelectedContextId(id);
      setTurns([]);
      send({ type: 'getTurns', contextId: id });
    },
    [send]
  );

  const openTurn = useCallback((id: number) => send({ type: 'getTurn', id }), [send]);
  const closeTurn = useCallback(() => setTurnDetail(null), []);

  const runSql = useCallback(
    (sql: string) =>
      new Promise<SqlResult>((resolve) => {
        const id = ++sqlSeq.current;
        sqlWaiters.current.set(id, resolve);
        send({ type: 'sql', id, sql });
      }),
    [send]
  );

  return {
    connected,
    sessions,
    contexts,
    turns,
    selectedSessionId,
    selectedContextId,
    turnDetail,
    selectSession,
    selectContext,
    openTurn,
    closeTurn,
    runSql,
  };
}
