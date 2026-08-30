// Shared harness for the tracer's saved regression tests.
// Launches the real capture pipeline (mitmproxy addon + viewer server) and a real `copilot`
// process pointed at the proxy, then exposes helpers to wait for and inspect captured turns.
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..');
const LAUNCHER = join(REPO_ROOT, 'scripts', 'start-traced.js');

/** Directory where mitmproxy's executables live (so mitmdump is resolvable), best-effort. */
export function pythonScriptsDir() {
  const r = spawnSync('python', ['-c', "import sysconfig;print(sysconfig.get_path('scripts'))"], {
    encoding: 'utf-8',
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns truthy or the timeout elapses. Returns the truthy value. */
export async function waitFor(fn, { timeout = 180000, interval = 1000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await sleep(interval);
  }
}

/** Wait until an HTTP GET of `url` succeeds. */
export async function waitForHttp(url, opts = {}) {
  return waitFor(
    async () => {
      const res = await fetch(url).catch(() => null);
      return res && res.ok;
    },
    { label: `viewer at ${url}`, ...opts }
  );
}

/**
 * Launch a traced Copilot session.
 * @returns {{proc, viewerUrl, tracerDb, getOutput: () => string, stop: () => void}}
 */
export function startTracedSession({
  prompt,
  model = null,
  proxyPort = 8785,
  viewerPort = 8795,
  tracerDb = join(REPO_ROOT, 'sessions', `test-tracer-${Date.now()}.db`),
  keepAlive = true,
  onOutput = null,
} = {}) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(tracerDb + suffix)) rmSync(tracerDb + suffix, { force: true });
  }

  const args = [LAUNCHER];
  if (model) args.push('--model', model);
  args.push('-p', prompt, '--allow-all-tools');

  const scriptsDir = pythonScriptsDir();
  const PATH = (scriptsDir ? scriptsDir + ';' : '') + process.env.PATH;

  const proc = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH,
      TRACE_KEEP_ALIVE: keepAlive ? '1' : '',
      PROXY_PORT: String(proxyPort),
      VIEWER_PORT: String(viewerPort),
      TRACER_DB: tracerDb,
    },
  });
  let output = '';
  const collect = (buf) => {
    output += buf.toString();
    if (onOutput) onOutput(buf.toString());
  };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);

  const stop = () => {
    if (proc.pid && process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(tracerDb + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  };

  return {
    proc,
    viewerUrl: `http://127.0.0.1:${viewerPort}`,
    tracerDb,
    getOutput: () => output,
    stop,
  };
}

/** Read all captured turns (joined with context labels) from a tracer DB. */
export function readTurns(tracerDb) {
  if (!existsSync(tracerDb)) return [];
  const db = new DatabaseSync(tracerDb, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT t.id, t.session_id, t.context_id, c.label AS context_label, t.turn_index,
                t.model, t.finish_reason, t.method, t.path,
                length(t.canonical_prompt_text) AS prompt_len,
                length(t.response_text) AS response_len
         FROM turns t LEFT JOIN contexts c ON c.context_id = t.context_id
         ORDER BY t.id`
      )
      .all();
  } finally {
    db.close();
  }
}
