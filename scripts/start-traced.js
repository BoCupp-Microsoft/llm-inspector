// One-command launcher: starts the capture proxy + viewer server, then runs the Copilot CLI
// with the repo-local CA and proxy env. Detects the Copilot session id for this run and tears
// everything down on exit. All state stays under the repo.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function loadEnv() {
  const envPath = join(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const PROXY_PORT = process.env.PROXY_PORT || '8080';
const VIEWER_PORT = process.env.VIEWER_PORT || '8090';
const COPILOT_CMD = process.env.COPILOT_CMD || 'copilot';
const CONFDIR = join(REPO_ROOT, '.mitmproxy');
const CA_PEM = join(CONFDIR, 'mitmproxy-ca-cert.pem');
const SESSIONS_DIR = join(REPO_ROOT, 'sessions');
const TRACER_DB = process.env.TRACER_DB || join(SESSIONS_DIR, 'tracer.db');
const SID_FILE = join(SESSIONS_DIR, 'current_session.txt');
const ADDON = join(REPO_ROOT, 'mitm', 'capture_addon.py');
const SERVER = join(REPO_ROOT, 'server', 'index.js');
const STATE_DIR = join(homedir(), '.copilot', 'session-state');
const SESSION_STORE =
  process.env.COPILOT_SESSION_STORE || join(homedir(), '.copilot', 'session-store.db');

for (const d of [CONFDIR, SESSIONS_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

function resolveExe(name, envVar) {
  if (process.env[envVar] && existsSync(process.env[envVar])) return process.env[envVar];
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf-8' });
  if (r.status === 0) return r.stdout.split(/\r?\n/)[0].trim();
  return name; // fall back to PATH resolution at spawn time
}
const MITMDUMP = resolveExe('mitmdump', 'MITMDUMP');

function ensureCA() {
  if (existsSync(CA_PEM)) return;
  console.log('[trace] generating repo-local mitmproxy CA...');
  const gen = spawn(MITMDUMP, ['--set', `confdir=${CONFDIR}`, '--listen-port', '0', '-q'], {
    stdio: 'ignore',
  });
  const start = Date.now();
  while (!existsSync(CA_PEM) && Date.now() - start < 15000) {
    spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', 'timeout', '/t', '1', '/nobreak'] : ['-c', 'sleep 1'], { stdio: 'ignore' });
  }
  try { gen.kill(); } catch { /* ignore */ }
  if (!existsSync(CA_PEM)) {
    console.error('[trace] failed to generate CA. Is mitmproxy installed? Run: npm run setup');
    process.exit(1);
  }
}

// --- start proxy (capture addon) ---
ensureCA();
writeFileSync(SID_FILE, ''); // cleared until we detect this run's session id
const proxyEnv = {
  ...process.env,
  TRACER_DB,
  CAPTURE_SESSION_ID_FILE: SID_FILE,
  CAPTURE_SESSION_ID: '',
};
// Route proxy + viewer output to log files so their stdout/stderr can never bleed into (and
// corrupt) the Copilot TUI, which owns this terminal. mitmproxy on Windows/Python 3.9 emits a
// benign ConnectionResetError [WinError 10054] traceback when a client drops a TLS connection;
// keeping it out of the shared console is what stops it from appearing over the Copilot UI.
const PROXY_LOG = join(SESSIONS_DIR, 'proxy.log');
const VIEWER_LOG = join(SESSIONS_DIR, 'viewer.log');
const proxyLogFd = openSync(PROXY_LOG, 'a');
const viewerLogFd = openSync(VIEWER_LOG, 'a');

const proxy = spawn(
  MITMDUMP,
  ['-s', ADDON, '--set', `confdir=${CONFDIR}`, '--listen-port', String(PROXY_PORT), '-q'],
  { stdio: ['ignore', proxyLogFd, proxyLogFd], env: proxyEnv }
);
proxy.on('error', (e) => {
  console.error('[trace] failed to start mitmdump:', e.message, '\nRun: npm run setup');
  process.exit(1);
});

// --- start viewer server ---
const server = spawn(process.execPath, [SERVER], {
  stdio: ['ignore', viewerLogFd, viewerLogFd],
  env: { ...process.env, VIEWER_PORT, TRACER_DB, COPILOT_SESSION_STORE: SESSION_STORE },
});

// --- detect the Copilot session id created during this run ---
const preexisting = new Set(existsSync(STATE_DIR) ? readdirSync(STATE_DIR) : []);
let detectedSid = null;
function markSession(status, extra = {}) {
  if (!detectedSid) return;
  try {
    const db = new DatabaseSync(TRACER_DB);
    db.exec('PRAGMA busy_timeout=5000');
    db.prepare(
      `INSERT INTO capture_sessions (session_id, started_at, status, cwd, copilot_pid)
       VALUES (?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET status=excluded.status,
         cwd=COALESCE(excluded.cwd, capture_sessions.cwd),
         copilot_pid=COALESCE(excluded.copilot_pid, capture_sessions.copilot_pid)`
    ).run(detectedSid, new Date().toISOString(), status, extra.cwd ?? process.cwd(), extra.pid ?? null);
    if (status === 'ended') {
      db.prepare('UPDATE capture_sessions SET ended_at=? WHERE session_id=?').run(new Date().toISOString(), detectedSid);
    }
    db.close();
  } catch (e) {
    // best-effort; the addon still records turns under the detected id
  }
}
const poll = setInterval(() => {
  if (detectedSid || !existsSync(STATE_DIR)) return;
  const fresh = readdirSync(STATE_DIR).filter((d) => !preexisting.has(d));
  if (fresh.length > 0) {
    detectedSid = fresh.sort().pop();
    writeFileSync(SID_FILE, detectedSid);
    console.log(`[trace] Copilot session: ${detectedSid}`);
    markSession('live', { pid: copilot?.pid });
    clearInterval(poll);
  }
}, 500);

console.log(`\n[trace] proxy    : http://127.0.0.1:${PROXY_PORT}  (log: ${PROXY_LOG})`);
console.log(`[trace] viewer   : http://127.0.0.1:${VIEWER_PORT}  (log: ${VIEWER_LOG})`);
console.log(`[trace] launching: ${COPILOT_CMD} ${process.argv.slice(2).join(' ')}\n`);

// --- launch copilot through the proxy ---
// Resolve copilot to a concrete path. Spawn a real .exe WITHOUT a shell so multi-word args
// (e.g. -p "a prompt with spaces") are passed through intact; only fall back to a shell for
// .cmd/.bat shims that can't be spawned directly on Windows.
const COPILOT_EXE = resolveExe(COPILOT_CMD, 'COPILOT_EXE');
const copilotViaShell = /\.(cmd|bat)$/i.test(COPILOT_EXE);
const copilot = spawn(COPILOT_EXE, process.argv.slice(2), {
  stdio: 'inherit',
  shell: copilotViaShell,
  env: {
    ...process.env,
    HTTPS_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
    HTTP_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
    NODE_EXTRA_CA_CERTS: CA_PEM,
  },
});

let tearingDown = false;
const KEEP_ALIVE = /^(1|true|yes)$/i.test(process.env.TRACE_KEEP_ALIVE || '');
function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
}
function teardown(code) {
  if (tearingDown) return;
  tearingDown = true;
  clearInterval(poll);
  markSession('ended');
  killTree(proxy);
  killTree(server);
  // prune stale mitmproxy dumps if any
  process.exit(code ?? 0);
}

copilot.on('exit', (code) => {
  if (KEEP_ALIVE) {
    markSession('ended');
    console.log(`[trace] copilot exited (code ${code ?? 0}); viewer kept alive on port ${VIEWER_PORT} — press Ctrl+C to stop`);
    return;
  }
  teardown(code ?? 0);
});
copilot.on('error', (e) => {
  console.error(`[trace] failed to launch "${COPILOT_CMD}":`, e.message);
  teardown(1);
});
process.on('SIGINT', () => teardown(0));
process.on('SIGTERM', () => teardown(0));
