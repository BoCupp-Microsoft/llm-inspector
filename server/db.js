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
    request_payload_text  TEXT,
    request_payload_bytes INTEGER,
    common_prefix_bytes   INTEGER,
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

const TURN_COLUMN_MIGRATIONS = {
  request_payload_text: 'TEXT',
  request_payload_bytes: 'INTEGER',
  common_prefix_bytes: 'INTEGER',
};

function ensureColumns(db, table, columns) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  const existing = new Set(rows.map((row) => row.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

// Is a process still running? signal 0 performs an existence/permission check without delivering a
// signal. ESRCH => gone; EPERM => exists but owned by another user (still alive). Returns null when
// there is no pid to check.
function pidAlive(pid) {
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export class Db {
  constructor(tracerPath, sessionStorePath) {
    this.tracerPath = tracerPath;
    this.sessionStorePath = sessionStorePath;
    if (!existsSync(dirname(tracerPath))) mkdirSync(dirname(tracerPath), { recursive: true });
    this.db = new DatabaseSync(tracerPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA busy_timeout=30000');
    this.db.exec(SCHEMA);
    ensureColumns(this.db, 'turns', TURN_COLUMN_MIGRATIONS);
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
    const empty = { aic: null, inputTokens: null, outputTokens: null, summary: null, repository: null, branch: null, updatedAt: null };
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
        .prepare('SELECT summary, repository, branch, updated_at FROM sessions WHERE id = ?')
        .get(sessionId) || {};
      return {
        aic: usage ? Number(usage.nano) / 1e9 : null,
        inputTokens: usage ? Number(usage.inp) : null,
        outputTokens: usage ? Number(usage.outp) : null,
        summary: meta.summary ?? null,
        repository: meta.repository ?? null,
        branch: meta.branch ?? null,
        updatedAt: meta.updated_at ?? null,
      };
    } catch (err) {
      return empty;
    }
  }

  // A capture row's stored status only reaches 'ended' if the launcher saw the copilot process exit;
  // a force-close or a killed launcher leaves a row stuck on 'live' forever. Derive the *effective*
  // status at read time from ground truth: (1) is the launched copilot PID still alive, and
  // (2) how recently did Copilot's own session store record activity. Returns the display status plus
  // a `live` flag, a `stale` flag (true when we overrode a 'live' row we believe is actually over),
  // and a human-readable reason for the tooltip.
  effectiveStatus(row, updatedAt) {
    if (row.ended_at || row.status === 'ended') {
      return { status: 'ended', live: false, stale: false, reason: 'closed (marked by launcher)' };
    }
    const ageMin = updatedAt ? (Date.now() - Date.parse(updatedAt)) / 60000 : null;
    const alive = pidAlive(row.copilot_pid);
    if (alive === true) {
      // Guard against PID reuse: a genuinely live session keeps its store fresh; a very stale store
      // with a "live" PID means the original copilot exited and the PID was recycled.
      if (ageMin != null && ageMin > 720) {
        return {
          status: 'ended', live: false, stale: true,
          reason: `PID ${row.copilot_pid} is alive but Copilot recorded no activity for ${Math.round(ageMin)}m (PID likely reused)`,
        };
      }
      return { status: 'live', live: true, stale: false, reason: 'copilot process running' };
    }
    if (alive === false) {
      return {
        status: 'ended', live: false, stale: true,
        reason: `copilot PID ${row.copilot_pid} has exited (never marked ended)`,
      };
    }
    // No PID recorded (e.g. session seen only by the addon): fall back to store activity staleness.
    if (ageMin != null) {
      if (ageMin > 10) {
        return { status: 'ended', live: false, stale: true, reason: `no Copilot activity for ${Math.round(ageMin)}m` };
      }
      return { status: 'live', live: true, stale: false, reason: 'recent Copilot activity' };
    }
    return { status: row.status || 'unknown', live: row.status === 'live', stale: false, reason: 'no liveness signal available' };
  }

  // Distinct *real* sub-agent ids for a session, straight from the Copilot store. The store's
  // assistant_usage_events.agent_id is null for the main agent and non-null only for sub-agents
  // spawned via the Task tool, so this is the authoritative count. Returns null when the store is
  // unavailable (caller treats unknown as "no sub-agents" rather than inventing any).
  storeSubAgentIds(sessionId) {
    this.openStore();
    if (!this.store) return null;
    try {
      const rows = this.store
        .prepare(
          `SELECT DISTINCT agent_id FROM assistant_usage_events
           WHERE session_id = ? AND agent_id IS NOT NULL`
        )
        .all(sessionId);
      return rows.map((r) => r.agent_id);
    } catch {
      return null;
    }
  }

  // Group captured contexts into display units driven by the store's ground truth. The x-agent-task-id
  // header (our thread_key) rotates within a single main agent -- each new user prompt after the agent
  // goes idle, and each compaction, starts a fresh task id -- so distinct capture "contexts" are NOT
  // distinct agents. The only authoritative sub-agent signal is a non-null store agent_id. When there
  // are no real sub-agents we merge every conversational thread into one "Main agent" unit so the
  // viewer matches what actually ran in the CLI (one continuous main context), keeping background
  // title/summary calls separate.
  contextGroups(sessionId) {
    const rows = this.db
      .prepare(
        `SELECT c.context_id, c.agent_id, c.first_seen_at,
                (SELECT COUNT(*) FROM turns t WHERE t.context_id = c.context_id) AS turn_count,
                (SELECT COUNT(*) FROM turns t WHERE t.context_id = c.context_id
                   AND IFNULL(json_extract(t.request_headers_json,'$."x-interaction-type"'),'')
                       LIKE '%background%') AS background_turns,
                (SELECT MIN(t.captured_at) FROM turns t WHERE t.context_id = c.context_id) AS min_at,
                (SELECT json_extract(t.request_headers_json,'$."x-interaction-type"')
                   FROM turns t WHERE t.context_id = c.context_id
                   ORDER BY t.turn_index DESC LIMIT 1) AS interaction_type
         FROM contexts c WHERE c.session_id = ?
         ORDER BY c.context_id ASC`
      )
      .all(sessionId);

    const backgrounds = [];
    const conversational = [];
    for (const r of rows) {
      const isBackground = r.turn_count > 0 && r.background_turns === r.turn_count;
      (isBackground ? backgrounds : conversational).push(r);
    }

    const subIds = this.storeSubAgentIds(sessionId); // count surfaced via verification(); see below

    const groups = [];

    for (const b of backgrounds) {
      groups.push({
        synthetic_id: b.context_id,
        kind: 'background',
        label: 'Background (title/summary)',
        member_ids: [b.context_id],
        turn_count: b.turn_count,
        first_seen_at: b.first_seen_at,
        min_at: b.min_at,
        interaction_type: b.interaction_type,
        agent_id: b.agent_id,
      });
    }

    const convSorted = conversational.slice().sort(
      (a, b) => String(a.min_at || '').localeCompare(String(b.min_at || '')) || a.context_id - b.context_id
    );

    // Merge every conversational thread into one "Main agent" unit. We deliberately do NOT split out
    // sub-agents here: the wire carries no signal that attributes a captured thread to a specific
    // sub-agent (x-agent-task-id rotates for the main agent too), so any split would be a guess and
    // reintroduce the mislabeling this fix removes. The authoritative sub-agent *count* (store
    // agent_id) is surfaced separately via verification().subAgents. When real sub-agent capture and a
    // reliable mapping exist, split them here using subIds.
    void subIds;
    if (convSorted.length > 0) {
      const memberIds = convSorted.map((c) => c.context_id);
      groups.push({
        synthetic_id: Math.min(...memberIds),
        kind: 'main',
        label: 'Main agent',
        member_ids: memberIds,
        turn_count: convSorted.reduce((s, c) => s + c.turn_count, 0),
        first_seen_at: convSorted[0].first_seen_at,
        min_at: convSorted[0].min_at,
        interaction_type: convSorted[convSorted.length - 1].interaction_type,
        agent_id: null,
      });
    }

    groups.sort(
      (a, b) => String(a.min_at || '').localeCompare(String(b.min_at || '')) || a.synthetic_id - b.synthetic_id
    );
    return groups;
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
        `SELECT cs.session_id, cs.status, cs.started_at, cs.ended_at, cs.cwd, cs.copilot_pid,
                COUNT(DISTINCT c.context_id) AS context_count,
                (SELECT COUNT(*) FROM turns t WHERE t.session_id = cs.session_id) AS turn_count
         FROM capture_sessions cs
         LEFT JOIN contexts c ON c.session_id = cs.session_id
         GROUP BY cs.session_id
         ORDER BY cs.started_at DESC`
      )
      .all();
    return rows.map((r) => {
      const enr = this.enrichment(r.session_id);
      const eff = this.effectiveStatus(r, enr.updatedAt);
      return {
        ...r,
        // Report the display-context count (merged main + backgrounds), matching what listContexts
        // returns, rather than the raw captured-thread count.
        context_count: this.contextGroups(r.session_id).length,
        ...enr,
        verification: this.verification(r.session_id),
        // Effective (read-time) liveness overrides the stored status, which can be stuck on 'live'.
        status: eff.status,
        stored_status: r.status,
        live: eff.live,
        stale: eff.stale,
        status_reason: eff.reason,
      };
    });
  }

  listContexts(sessionId) {
    // Display units are driven by the store's sub-agent ground truth (see contextGroups). A rotating
    // x-agent-task-id never fabricates a "Sub-agent"; conversational main-agent threads collapse into
    // a single "Main agent" context when the store reports no real sub-agents.
    return this.contextGroups(sessionId).map((g) => ({
      context_id: g.synthetic_id,
      session_id: sessionId,
      label: g.label,
      kind: g.kind,
      interaction_type: g.interaction_type,
      agent_id: g.agent_id,
      first_seen_at: g.first_seen_at,
      turn_count: g.turn_count,
      member_ids: g.member_ids,
    }));
  }

  // Lightweight list for diffing: canonical prompt text + a little metadata per turn. The contextId is
  // a synthetic group id from listContexts; a merged "Main agent" unit spans several captured contexts,
  // so we union their turns into one chronological, sequentially re-indexed timeline.
  listTurns(contextId) {
    const ctx = this.db.prepare('SELECT session_id FROM contexts WHERE context_id = ?').get(contextId);
    let memberIds = [contextId];
    if (ctx) {
      const group = this.contextGroups(ctx.session_id).find(
        (g) => g.synthetic_id === contextId || g.member_ids.includes(contextId)
      );
      if (group) memberIds = group.member_ids;
    }
    const placeholders = memberIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id, turn_index, model, finish_reason, captured_at, duration_ms,
                status_code, canonical_prompt_text, usage_json,
                request_payload_bytes, common_prefix_bytes
         FROM turns WHERE context_id IN (${placeholders})
         ORDER BY captured_at ASC, id ASC`
      )
      .all(...memberIds);
    return rows.map((r, i) => ({ ...r, turn_index: i }));
  }

  getTurn(id) {
    return this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id);
  }

  // A cheap fingerprint of DB state used to detect changes for WS push. Includes the liveness of any
  // session still stored as 'live' so that a copilot process simply exiting (with no further DB write)
  // still flips the fingerprint and pushes the live -> ended transition to open viewers.
  state() {
    const t = this.db.prepare('SELECT COALESCE(MAX(id),0) AS m, COUNT(*) AS n FROM turns').get();
    const c = this.db.prepare('SELECT COALESCE(MAX(context_id),0) AS m FROM contexts').get();
    const s = this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(GROUP_CONCAT(status),'') AS st FROM capture_sessions")
      .get();
    const liveRows = this.db
      .prepare("SELECT session_id, copilot_pid FROM capture_sessions WHERE status = 'live'")
      .all();
    const liveness = liveRows
      .map((r) => `${r.session_id.slice(0, 8)}=${pidAlive(r.copilot_pid) ? 1 : 0}`)
      .join(',');
    return `${t.m}:${t.n}:${c.m}:${s.n}:${s.st}:${liveness}`;
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
