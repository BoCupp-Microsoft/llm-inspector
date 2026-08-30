// Integration test: launch the real capture pipeline + a real `copilot` process through the
// proxy, then assert that LLM turns were captured into the tracer DB.
//
// This exercises the whole backend (mitmproxy addon -> tracer.db) without a browser. It makes a
// real (billable) Copilot request, so it is slow (~1-2 min) and requires an authenticated
// `copilot` on PATH plus mitmproxy installed (run `npm run setup` first).
//
// Run:  npm run test:capture
//       TEST_MODEL=gpt-5.4 npm run test:capture   # exercise the OpenAI Responses (WebSocket) path
import { test } from 'node:test';
import assert from 'node:assert';
import { startTracedSession, waitForHttp, waitFor, readTurns } from './lib/tracer-harness.mjs';

const MODEL = process.env.TEST_MODEL || null; // null -> Copilot default (currently Claude/Anthropic)
const PROMPT = 'List the files in the current directory, then tell me how many there are.';

test('captures LLM turns from a real traced copilot session', { timeout: 300000 }, async (t) => {
  const session = startTracedSession({
    prompt: PROMPT,
    model: MODEL,
    proxyPort: 8785,
    viewerPort: 8795,
    onOutput: (s) => process.stdout.write(s),
  });
  t.after(() => session.stop());

  // Viewer server should come up quickly.
  await waitForHttp(session.viewerUrl, { timeout: 60000 });

  // Turns are written as the model responds; wait for at least one.
  const turns = await waitFor(
    () => {
      const ts = readTurns(session.tracerDb);
      return ts.length >= 1 ? ts : null;
    },
    { timeout: 240000, interval: 2000, label: 'captured turns' }
  );

  console.log(`\ncaptured ${turns.length} turn(s):`);
  for (const r of turns) {
    console.log(
      `  ctx="${r.context_label}" turn=${r.turn_index} model=${r.model} ` +
        `finish=${r.finish_reason} via=${r.method} promptLen=${r.prompt_len} respLen=${r.response_len}`
    );
  }

  assert.ok(turns.length >= 1, 'expected at least one captured turn');

  const first = turns[0];
  assert.ok(first.prompt_len > 0, 'canonical prompt text should be non-empty');
  assert.ok(first.model, 'turn should record which model was used');
  assert.strictEqual(first.turn_index, 0, 'first turn in a context should have index 0');

  // All turns of a given context must have strictly increasing, gap-free indices.
  const byCtx = new Map();
  for (const r of turns) {
    if (!byCtx.has(r.context_id)) byCtx.set(r.context_id, []);
    byCtx.get(r.context_id).push(r.turn_index);
  }
  for (const [ctx, indices] of byCtx) {
    const expected = indices.map((_, i) => i);
    assert.deepStrictEqual(indices, expected, `context ${ctx} turn indices should be 0..n-1`);
  }
});
