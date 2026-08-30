import { test, expect } from '@playwright/test';
import { startTracedSession, waitForHttp, readTurns } from '../lib/tracer-harness.mjs';

// End-to-end: launch a real traced Copilot session, open the React viewer in headed Edge, and
// watch captured turns stream in live. Requires an authenticated `copilot` on PATH and mitmproxy
// installed (run `npm run setup` first). Makes a real (billable) model request.
//
// Run:  npm run test:e2e
//       TEST_MODEL=gpt-5.4 npm run test:e2e   # exercise the OpenAI Responses (WebSocket) path
const MODEL = process.env.TEST_MODEL || null;
const PROMPT = 'List the files in the current directory, then tell me how many there are.';

test('observe live turns in the viewer (headed Edge)', async ({ page }) => {
  const session = startTracedSession({
    prompt: PROMPT,
    model: MODEL,
    proxyPort: 8786,
    viewerPort: 8796,
    onOutput: (s) => process.stdout.write(s),
  });

  try {
    await waitForHttp(session.viewerUrl, { timeout: 60000 });
    await page.goto(session.viewerUrl);

    // A captured session appears once the launcher detects the Copilot session id.
    const sessionRow = page.locator('button.session-row').first();
    await expect(sessionRow).toBeVisible({ timeout: 120000 });
    await sessionRow.click();

    // Contexts appear after the first turn is captured; select the first one.
    const contextRow = page.locator('button.context-row').first();
    await expect(contextRow).toBeVisible({ timeout: 240000 });
    await contextRow.click();

    // The turn-evolution view renders a git-diff-style block per captured turn.
    const turnBlock = page.locator('section.turn-block').first();
    await expect(turnBlock).toBeVisible({ timeout: 60000 });
    await expect(page.locator('.turn-label').first()).toContainText('Turn 0');

    // Cross-check the backing DB actually captured turns.
    const turns = readTurns(session.tracerDb);
    expect(turns.length).toBeGreaterThan(0);

    await page.screenshot({ path: 'test-results/turn-evolution.png', fullPage: true });
  } finally {
    session.stop();
  }
});
