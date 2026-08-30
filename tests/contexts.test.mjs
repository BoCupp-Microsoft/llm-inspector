// Unit test for the store-driven context grouping in server/db.js.
//
// A single Copilot main agent rotates its x-agent-task-id on every new prompt (after the agent goes
// idle) and on every compaction, so the tracer captures one main conversation as many "contexts".
// The only authoritative sub-agent signal is the Copilot store's non-null assistant_usage_events.agent_id.
// These tests assert that:
//   - with no real sub-agents, all conversational threads collapse into one "Main agent" context
//     (background title/summary stays separate) and listTurns returns one merged chronological timeline;
//   - a rotating task id never fabricates a "Sub-agent";
//   - when the store is unavailable we still never invent sub-agents;
//   - when the store DOES report a sub-agent, we surface exactly that many.
//
// Run:  node --test tests/contexts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../server/db.js';

const SID = 'sess-test-0001';

function seedStore(storePath, agentIds) {
  // Minimal stand-in for Copilot's session-store.db. agentIds is one entry per billed usage event
  // (null = main agent, a string = a real sub-agent).
  const s = new DatabaseSync(storePath);
  s.exec(`CREATE TABLE assistant_usage_events (
            session_id TEXT, turn_index INTEGER, agent_id TEXT, parent_tool_call_id TEXT,
            input_tokens INTEGER, output_tokens INTEGER, total_nano_aiu INTEGER);
          CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT, repository TEXT, branch TEXT);`);
  const ins = s.prepare('INSERT INTO assistant_usage_events (session_id, agent_id) VALUES (?, ?)');
  agentIds.forEach((a) => ins.run(SID, a));
  s.prepare('INSERT INTO sessions (id, summary) VALUES (?, ?)').run(SID, 'test session');
  s.close();
}

function seedTracer(db, contexts) {
  // contexts: [{ id, turns: [{ it, at, prompt }] }]  (it = x-interaction-type)
  const insCtx = db.prepare(
    'INSERT INTO contexts (context_id, session_id, thread_key, first_seen_at) VALUES (?, ?, ?, ?)'
  );
  const insTurn = db.prepare(
    `INSERT INTO turns (session_id, context_id, turn_index, captured_at, request_headers_json,
                        canonical_prompt_text)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const c of contexts) {
    insCtx.run(c.id, SID, `task-${c.id}`, c.turns[0].at);
    c.turns.forEach((t, i) => {
      insTurn.run(SID, c.id, i, t.at, JSON.stringify({ 'x-interaction-type': t.it }), t.prompt || `p${c.id}.${i}`);
    });
  }
}

// One background (title) context + three conversational threads (successive prompts to the same main
// agent). This mirrors the real over-split session that motivated the fix.
function sampleContexts() {
  return [
    { id: 10, turns: [{ it: 'conversation-background', at: '2026-08-30T02:18:40' }] },
    { id: 11, turns: [
      { it: 'conversation-user', at: '2026-08-30T02:18:46' },
      { it: 'conversation-agent', at: '2026-08-30T02:24:29' },
    ] },
    { id: 12, turns: [
      { it: 'conversation-user', at: '2026-08-30T02:33:00' },
      { it: 'conversation-agent', at: '2026-08-30T02:34:48' },
    ] },
    { id: 13, turns: [
      { it: 'conversation-user', at: '2026-08-30T12:01:05' },
      { it: 'conversation-agent', at: '2026-08-30T12:27:26' },
    ] },
  ];
}

function withDb(storeAgentIds, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'llm-inspector-ctx-'));
  const tracerPath = join(dir, 'tracer.db');
  const storePath = join(dir, 'session-store.db');
  if (storeAgentIds !== null) seedStore(storePath, storeAgentIds);
  const db = new Db(tracerPath, storePath);
  try {
    seedTracer(db.db, sampleContexts());
    fn(db);
  } finally {
    db.db.close();
    if (db.store) db.store.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup; Windows may hold the file briefly */
    }
  }
}

test('no real sub-agents: conversational threads merge into one Main agent', () => {
  withDb([null, null, null, null, null, null], (db) => {
    const ctx = db.listContexts(SID);
    const kinds = ctx.map((c) => c.kind).sort();
    assert.deepStrictEqual(kinds, ['background', 'main'], 'exactly one background + one main');
    assert.strictEqual(ctx.filter((c) => c.kind === 'sub').length, 0, 'never fabricate a sub-agent');

    const main = ctx.find((c) => c.kind === 'main');
    assert.strictEqual(main.label, 'Main agent');
    assert.deepStrictEqual(main.member_ids, [11, 12, 13], 'all conversational threads are members');
    assert.strictEqual(main.turn_count, 6, 'turn_count is the sum across merged threads');

    const bg = ctx.find((c) => c.kind === 'background');
    assert.strictEqual(bg.label, 'Background (title/summary)');
    assert.strictEqual(bg.turn_count, 1);
  });
});

test('merged Main agent returns one chronological, sequentially re-indexed timeline', () => {
  withDb([null, null], (db) => {
    const main = db.listContexts(SID).find((c) => c.kind === 'main');
    const turns = db.listTurns(main.context_id);
    assert.strictEqual(turns.length, 6, 'all six conversational turns are unioned');
    assert.deepStrictEqual(turns.map((t) => t.turn_index), [0, 1, 2, 3, 4, 5], 'sequential re-index');
    for (let i = 1; i < turns.length; i++) {
      assert.ok(turns[i].captured_at >= turns[i - 1].captured_at, 'ordered by captured_at');
    }
  });
});

test('store unavailable: still never invent sub-agents', () => {
  withDb(null, (db) => {
    const ctx = db.listContexts(SID);
    assert.strictEqual(ctx.filter((c) => c.kind === 'sub').length, 0);
    const main = ctx.find((c) => c.kind === 'main');
    assert.deepStrictEqual(main.member_ids, [11, 12, 13], 'threads still merge when store is absent');
  });
});

test('store-reported sub-agent does not fabricate sub-agent contexts (count via verification)', () => {
  // The wire cannot attribute a captured thread to a specific sub-agent, so context grouping never
  // splits them out. The real count is exposed separately via verification().subAgents.
  withDb([null, null, null, null, null, 'agent-xyz'], (db) => {
    const ctx = db.listContexts(SID);
    assert.strictEqual(ctx.filter((c) => c.kind === 'sub').length, 0, 'no fabricated sub-agent contexts');
    assert.strictEqual(ctx.filter((c) => c.kind === 'main').length, 1, 'still one merged main agent');
    assert.strictEqual(db.verification(SID).subAgents, 1, 'sub-agent count surfaced via verification');
  });
});
