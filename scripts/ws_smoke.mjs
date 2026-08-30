// End-to-end smoke test: connect to the viewer WS, verify initial load, then confirm a
// live capture (synthetic seed) is pushed over the socket.
import WebSocket from 'ws';
import { spawnSync } from 'node:child_process';

const URL = 'ws://127.0.0.1:8090/api-ws';
const ws = new WebSocket(URL);
let failed = 0;
const ok = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!cond) failed++;
};

function once(type, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + type)), timeout);
    const h = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === type) {
        clearTimeout(timer);
        ws.off('message', h);
        resolve(m);
      }
    };
    ws.on('message', h);
  });
}
const req = (o) => ws.send(JSON.stringify(o));

ws.on('open', async () => {
  try {
    const first = await once('sessions');
    const before = first.sessions.length;
    ok('received initial sessions list', Array.isArray(first.sessions));

    // Trigger a live capture; server should detect DB change and broadcast 'changed'.
    const sid = 'smoke-' + Date.now();
    const changed = once('changed', 6000);
    spawnSync('python', ['scripts/seed_synthetic.py', sid], { stdio: 'inherit' });
    await changed;
    ok('received live "changed" push after seed', true);

    const after = await (req({ type: 'getSessions' }), once('sessions'));
    ok('session count grew after seed', after.sessions.length === before + 1);
    const seeded = after.sessions.find((s) => s.session_id === sid);
    ok('seeded session present', !!seeded);
    ok('seeded session has 5 turns', seeded && seeded.turn_count === 5);
    ok('seeded session has 2 contexts', seeded && seeded.context_count === 2);

    req({ type: 'getContexts', sessionId: sid });
    const ctx = await once('contexts');
    ok('two contexts returned', ctx.contexts.length === 2);
    ok('first context is Main agent', ctx.contexts[0].label === 'Main agent');
    ok('main context has 3 turns', ctx.contexts[0].turn_count === 3);

    req({ type: 'getTurns', contextId: ctx.contexts[0].context_id });
    const turns = await once('turns');
    ok('main context returns 3 turns', turns.turns.length === 3);
    ok('turns carry canonical prompt text', !!turns.turns[0].canonical_prompt_text);

    // read-only SQL guard
    const good = await (req({ type: 'sql', id: 1, sql: 'SELECT COUNT(*) AS n FROM turns' }), once('result'));
    ok('read-only SELECT works', good.rows && good.rows[0].n >= 5);
    const bad = await (req({ type: 'sql', id: 2, sql: 'DELETE FROM turns' }), once('result'));
    ok('write query rejected by guard', !!bad.error);

    console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
    ws.close();
    process.exit(failed ? 1 : 0);
  } catch (err) {
    console.error('ERROR', err.message);
    process.exit(1);
  }
});
ws.on('error', (e) => {
  console.error('WS error', e.message);
  process.exit(1);
});
