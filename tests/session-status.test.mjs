// Unit test for read-time effective session status in server/db.js.
//
// The stored capture_sessions.status only becomes 'ended' when the launcher observes the copilot
// process exit; a force-close or a killed launcher leaves it stuck on 'live'. effectiveStatus()
// recovers the true state from the launched PID's liveness and, failing that, Copilot store activity.
//
// Run:  node --test tests/session-status.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../server/db.js';

const DEAD_PID = 0x7ffffffe; // astronomically unlikely to be a real running process
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'llm-inspector-status-'));
  const db = new Db(join(dir, 'tracer.db'), join(dir, 'no-store.db'));
  try {
    fn(db);
  } finally {
    db.db.close();
    if (db.store) db.store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

test('launcher-marked ended row stays ended', () => {
  withDb((db) => {
    const s = db.effectiveStatus({ status: 'ended', ended_at: iso(60), copilot_pid: DEAD_PID }, iso(1));
    assert.strictEqual(s.status, 'ended');
    assert.strictEqual(s.live, false);
    assert.strictEqual(s.stale, false);
  });
});

test('live row with a running PID is live', () => {
  withDb((db) => {
    // The test process itself is guaranteed to be running.
    const s = db.effectiveStatus({ status: 'live', ended_at: null, copilot_pid: process.pid }, iso(1));
    assert.strictEqual(s.status, 'live');
    assert.strictEqual(s.live, true);
  });
});

test('live row whose PID has exited is reported ended (stale)', () => {
  withDb((db) => {
    const s = db.effectiveStatus({ status: 'live', ended_at: null, copilot_pid: DEAD_PID }, iso(5));
    assert.strictEqual(s.status, 'ended');
    assert.strictEqual(s.stale, true, 'flagged as an inferred override of a stuck live row');
    assert.match(s.reason, /exited/);
  });
});

test('running PID but very stale store activity is treated as PID reuse', () => {
  withDb((db) => {
    const s = db.effectiveStatus({ status: 'live', ended_at: null, copilot_pid: process.pid }, iso(721));
    assert.strictEqual(s.status, 'ended');
    assert.strictEqual(s.stale, true);
    assert.match(s.reason, /reused/i);
  });
});

test('no PID: fall back to store activity staleness', () => {
  withDb((db) => {
    const stale = db.effectiveStatus({ status: 'live', ended_at: null, copilot_pid: null }, iso(30));
    assert.strictEqual(stale.status, 'ended', 'stale store => ended');
    assert.strictEqual(stale.stale, true);

    const fresh = db.effectiveStatus({ status: 'live', ended_at: null, copilot_pid: null }, iso(2));
    assert.strictEqual(fresh.status, 'live', 'fresh store => live');
    assert.strictEqual(fresh.live, true);
  });
});

test('no PID and no store signal: preserve the stored status', () => {
  withDb((db) => {
    const s = db.effectiveStatus({ status: 'live', ended_at: null, copilot_pid: null }, null);
    assert.strictEqual(s.status, 'live');
    assert.strictEqual(s.live, true);
    assert.strictEqual(s.stale, false);
  });
});
