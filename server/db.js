// SQLite access for the viewer server.
// - tracer.db (read/write open, but only the mitmproxy addon writes turns) is the capture store.
// - the Copilot session-store.db is opened read-only for AIC/status/repo enrichment.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS capture_sessions (
    session_id  TEXT PRIMARY KEY,
    started_at  TEXT,
    ended_at    TEXT,
    status      TEXT,
    cwd         TEXT,
    copilot_pid INTEGER
);
CREATE TABLE IF NOT EXISTS contexts (
    context_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          TEXT NOT NULL,
    label               TEXT,
    agent_id            TEXT,
    parent_tool_call_id TEXT,
    thread_key          TEXT,
    latest_keys_json    TEXT,
    turn_count          INTEGER DEFAULT 0,
    first_seen_at       TEXT
);
CREATE TABLE IF NOT EXISTS turns (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id            TEXT,
    context_id            INTEGER,
    turn_index            INTEGER,
    captured_at           TEXT,
    flow_id               TEXT,
    host                  TEXT,
    path                  TEXT,
    method                TEXT,
    status_code           INTEGER,
    duration_ms           INTEGER,
    model                 TEXT,
    stream                INTEGER,
    request_headers_json  TEXT,
    params_json           TEXT,
    messages_json         TEXT,
    tools_json            TEXT,
    msgkeys_json          TEXT,
    canonical_prompt_text TEXT,
    response_text         TEXT,
    tool_calls_json       TEXT,
    finish_reason         TEXT,
    usage_json            TEXT,
    raw_response_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_ctx ON turns(session_id, context_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
`;

export class Db {
  constructor(tracerPath, sessionStorePath) {
    this.tracerPath = tracerPath;
    this.sessionStorePath = sessionStorePath;
    if (!existsSync(dirname(tracerPath))) mkdirSync(dirname(tracerPath), { recursive: true });
    this.db = new DatabaseSync(tracerPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA busy_timeout=30000');
    this.db.exec(SCHEMA);
    this.store = null;
    this.openStore();
  }

  openStore() {
    if (this.store || !this.sessionStorePath || !existsSync(this.sessionStorePath)) return;
    try {
      this.store = new DatabaseSync(this.sessionStorePath, { readOnly: true });
    } catch (err) {
      console.warn('[db] could not open session store (enrichment disabled):', err.message);
      this.store = null;
    }
  }

  // Per-session AIC + token rollups from the Copilot session store (best-effort).
  enrichment(sessionId) {
    this.openStore();
    const empty = { aic: null, inputTokens: null, outputTokens: null, summary: null, repository: null, branch: null };
    if (!this.store) return empty;
    try {
      const usage = this.store
        .prepare(
          `SELECT COALESCE(SUM(total_nano_aiu),0) AS nano, COALESCE(SUM(input_tokens),0) AS inp,
                  COALESCE(SUM(output_tokens),0) AS outp
           FROM assistant_usage_events WHERE session_id = ?`
        )
        .get(sessionId);
      const meta = this.store
        .prepare('SELECT summary, repository, branch FROM sessions WHERE id = ?')
        .get(sessionId) || {};
      return {
        aic: usage ? Number(usage.nano) / 1e9 : null,
        inputTokens: usage ? Number(usage.inp) : null,
        outputTokens: usage ? Number(usage.outp) : null,
        summary: meta.summary ?? null,
        repository: meta.repository ?? null,
        branch: meta.branch ?? null,
      };
    } catch (err) {
      return empty;
    }
  }

  // Completeness check: compare our captured turns against Copilot's own ground-truth record of
  // billed model calls (assistant_usage_events in the session store). Every billed call should have
  // a corresponding captured "agent" turn; background calls (e.g. title/summary generation) that
  // Copilot does not bill are captured as a bonus and excluded from the expected count.
  verification(sessionId) {
    const captured = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN IFNULL(json_extract(request_headers_json,'$."x-interaction-type"'),'')
                    LIKE '%background%' THEN 1 ELSE 0 END) AS background,
           SUM(CASE WHEN IFNULL(json_extract(request_headers_json,'$."x-interaction-type"'),'')
                    LIKE '%background%' THEN 0 ELSE 1 END) AS agent
         FROM turns WHERE session_id = ?`
      )
      .get(sessionId) || { background: 0, agent: 0 };
    const capturedAgent = Number(captured.agent || 0);
    const capturedBackground = Number(captured.background || 0);

    this.openStore();
    if (!this.store) {
      return {
        available: false,
        expected: null,
        capturedAgent,
        capturedBackground,
        missing: 0,
        subAgents: null,
      };
    }
    try {
      const row = this.store
        .prepare('SELECT COUNT(*) AS n FROM assistant_usage_events WHERE session_id = ?')
        .get(sessionId);
      const subs = this.store
        .prepare(
          `SELECT COUNT(DISTINCT agent_id) AS n FROM assistant_usage_events
           WHERE session_id = ? AND agent_id IS NOT NULL`
        )
        .get(sessionId);
      const expected = Number(row ? row.n : 0);
      return {
        available: true,
        expected,
        capturedAgent,
        capturedBackground,
        missing: Math.max(0, expected - capturedAgent),
        extra: Math.max(0, capturedAgent - expected),
        subAgents: Number(subs ? subs.n : 0),
      };
    } catch {
      return {
        available: false,
        expected: null,
        capturedAgent,
        capturedBackground,
        missing: 0,
        subAgents: null,
      };
    }
  }

  listSessions() {
    const rows = this.db
      .prepare(
        `SELECT cs.session_id, cs.status, cs.started_at, cs.ended_at, cs.cwd,
                COUNT(DISTINCT c.context_id) AS context_count,
                (SELECT COUNT(*) FROM turns t WHERE t.session_id = cs.session_id) AS turn_count
         FROM capture_sessions cs
         LEFT JOIN contexts c ON c.session_id = cs.session_id
         GROUP BY cs.session_id
         ORDER BY cs.started_at DESC`
      )
      .all();
    return rows.map((r) => ({
      ...r,
      ...this.enrichment(r.session_id),
      verification: this.verification(r.session_id),
    }));
  }

  listContexts(sessionId) {
    // Derive display labels at read time from each context's interaction type so a background
    // title/summary call can never be mislabeled as the main agent. Ordering follows first capture.
    const rows = this.db
      .prepare(
        `SELECT c.context_id, c.session_id, c.agent_id, c.first_seen_at, c.thread_key,
                (SELECT COUNT(*) FROM turns t WHERE t.context_id = c.context_id) AS turn_count,
                (SELECT COUNT(*) FROM turns t WHERE t.context_id = c.context_id
                   AND IFNULL(json_extract(t.request_headers_json,'$."x-interaction-type"'),'')
                       LIKE '%background%') AS background_turns,
                (SELECT json_extract(t.request_headers_json,'$."x-interaction-type"')
                   FROM turns t WHERE t.context_id = c.context_id
                   ORDER BY t.turn_index DESC LIMIT 1) AS interaction_type
         FROM contexts c WHERE c.session_id = ?
         ORDER BY c.context_id ASC`
      )
      .all(sessionId);

    let agentIndex = 0;
    return rows.map((r) => {
      const isBackground = r.turn_count > 0 && r.background_turns === r.turn_count;
      let kind;
      let label;
      if (isBackground) {
        kind = 'background';
        label = 'Background (title/summary)';
      } else if (agentIndex === 0) {
        kind = 'main';
        label = 'Main agent';
        agentIndex += 1;
      } else {
        kind = 'sub';
        label = `Sub-agent ${agentIndex}`;
        agentIndex += 1;
      }
      return {
        context_id: r.context_id,
        session_id: r.session_id,
        label,
        kind,
        interaction_type: r.interaction_type,
        agent_id: r.agent_id,
        first_seen_at: r.first_seen_at,
        turn_count: r.turn_count,
      };
    });
  }

  // Lightweight list for diffing: canonical prompt text + a little metadata per turn.
  listTurns(contextId) {
    return this.db
      .prepare(
        `SELECT id, turn_index, model, finish_reason, captured_at, duration_ms,
                status_code, canonical_prompt_text, usage_json
         FROM turns WHERE context_id = ? ORDER BY turn_index ASC`
      )
      .all(contextId);
  }

  getTurn(id) {
    return this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id);
  }

  // A cheap fingerprint of DB state used to detect changes for WS push.
  state() {
    const t = this.db.prepare('SELECT COALESCE(MAX(id),0) AS m, COUNT(*) AS n FROM turns').get();
    const c = this.db.prepare('SELECT COALESCE(MAX(context_id),0) AS m FROM contexts').get();
    const s = this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(GROUP_CONCAT(status),'') AS st FROM capture_sessions")
      .get();
    return `${t.m}:${t.n}:${c.m}:${s.n}:${s.st}`;
  }

  runReadOnly(sql) {
    const trimmed = String(sql || '').trim().replace(/;+\s*$/, '');
    if (!/^(select|with)\b/i.test(trimmed)) {
      throw new Error('Only read-only SELECT/WITH queries are allowed.');
    }
    if (/;/.test(trimmed) || /\b(attach|pragma|insert|update|delete|drop|alter|create|replace)\b/i.test(trimmed)) {
      throw new Error('Query rejected by read-only guard.');
    }
    return this.db.prepare(trimmed).all();
  }
}
