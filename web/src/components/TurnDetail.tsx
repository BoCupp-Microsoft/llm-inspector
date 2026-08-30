import { useState } from 'react';
import type { TurnFull } from '../types';

type Tab = 'messages' | 'tools' | 'response' | 'usage' | 'raw';

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function contentToText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : JSON.stringify(p)))
      .join('\n');
  }
  return JSON.stringify(content, null, 2);
}

interface Msg {
  role?: string;
  name?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
}

export function TurnDetail({ turn, onClose }: { turn: TurnFull; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('messages');
  const messages = parse<Msg[]>(turn.messages_json, []);
  const tools = parse<unknown[]>(turn.tools_json, []);
  const params = parse<Record<string, unknown>>(turn.params_json, {});
  const usage = parse<Record<string, unknown>>(turn.usage_json, {});
  const toolCalls = parse<unknown[]>(turn.tool_calls_json, []);
  const headers = parse<Record<string, string>>(turn.request_headers_json, {});
  const rawParsed = parse<{ reasoning?: string }>(turn.raw_response_json, {});
  const reasoning = rawParsed.reasoning || '';
  const hasResponse = Boolean(turn.response_text) || toolCalls.length > 0 || Boolean(reasoning);
  const requestPayload = turn.request_payload_text || '';

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <strong>Turn {turn.turn_index}</strong>
            <span className="pill">{turn.model}</span>
            {turn.finish_reason && <span className="pill subtle">{turn.finish_reason}</span>}
          </div>
          <button className="link" onClick={onClose}>close</button>
        </header>
        <nav className="tabs">
          {(['messages', 'tools', 'response', 'usage', 'raw'] as Tab[]).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <div className="drawer-body">
          {tab === 'messages' && (
            <div className="messages">
              {messages.map((m, i) => (
                <div key={i} className={`msg role-${m.role || 'unknown'}`}>
                  <div className="msg-role">
                    [{i}] {m.role}
                    {m.name ? ` (${m.name})` : ''}
                    {m.tool_call_id ? ` · tool_call_id=${m.tool_call_id}` : ''}
                  </div>
                  {contentToText(m.content) && <pre className="msg-content">{contentToText(m.content)}</pre>}
                  {(m.tool_calls || []).map((tc, k) => (
                    <pre key={k} className="msg-toolcall">
                      → {tc.function?.name}({tc.function?.arguments})
                    </pre>
                  ))}
                </div>
              ))}
            </div>
          )}
          {tab === 'tools' && (
            <div className="tools">
              <div className="hint">{tools.length} tool schema(s) sent</div>
              <pre className="json">{JSON.stringify(tools, null, 2)}</pre>
            </div>
          )}
          {tab === 'response' && (
            <div className="response">
              {reasoning && (
                <>
                  <div className="hint">reasoning summary</div>
                  <pre className="response-text reasoning">{reasoning}</pre>
                </>
              )}
              {turn.response_text && (
                <>
                  <div className="hint">assistant text</div>
                  <pre className="response-text">{turn.response_text}</pre>
                </>
              )}
              {toolCalls.length > 0 && (
                <>
                  <div className="hint">tool calls requested ({toolCalls.length})</div>
                  <pre className="json">{JSON.stringify(toolCalls, null, 2)}</pre>
                </>
              )}
              {!hasResponse && (
                <pre className="response-text">(no assistant output captured for this turn)</pre>
              )}
            </div>
          )}
          {tab === 'usage' && (
            <div className="usage">
              <table className="kv">
                <tbody>
                  <tr><td>model</td><td>{turn.model}</td></tr>
                  <tr><td>stream</td><td>{turn.stream ? 'yes' : 'no'}</td></tr>
                  <tr><td>status</td><td>{turn.status_code}</td></tr>
                  <tr><td>duration_ms</td><td>{turn.duration_ms ?? '—'}</td></tr>
                  <tr><td>common_prefix_bytes</td><td>{turn.common_prefix_bytes ?? '—'}</td></tr>
                  <tr><td>total_bytes</td><td>{turn.request_payload_bytes ?? '—'}</td></tr>
                  {Object.entries(usage).map(([k, v]) => (
                    <tr key={k}><td>{k}</td><td>{String(v)}</td></tr>
                  ))}
                  {Object.entries(params)
                    .filter(([k]) => !['messages', 'tools'].includes(k))
                    .map(([k, v]) => (
                      <tr key={k}><td>{k}</td><td>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td></tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === 'raw' && (
            <div className="raw">
              <div className="hint">request headers (auth redacted)</div>
              <pre className="json">{JSON.stringify(headers, null, 2)}</pre>
              <div className="hint">request payload (scrubbed)</div>
              <pre className="json">{requestPayload || '(payload unavailable)'}</pre>
              <div className="hint">normalized response</div>
              <pre className="json">{turn.raw_response_json || '{}'}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
