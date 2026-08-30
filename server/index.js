// Viewer server: serves the built React app over HTTP and pushes DB updates over WebSocket.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, watch, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer } from 'ws';
import { Db } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const DIST = join(REPO_ROOT, 'web', 'dist');
const SESSIONS_DIR = join(REPO_ROOT, 'sessions');
const TRACER_DB = process.env.TRACER_DB || join(SESSIONS_DIR, 'tracer.db');
const SESSION_STORE =
  process.env.COPILOT_SESSION_STORE || join(homedir(), '.copilot', 'session-store.db');
const PORT = Number(process.env.VIEWER_PORT || 8090);

const db = new Db(TRACER_DB, SESSION_STORE);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  let filePath = normalize(join(DIST, urlPath));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(DIST, 'index.html'); // SPA fallback
  if (!existsSync(filePath)) {
    res.writeHead(404).end('Viewer not built. Run: npm run build');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(500).end('Internal error');
  }
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/api-ws' });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

wss.on('connection', (ws) => {
  send(ws, { type: 'sessions', sessions: db.listSessions() });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case 'getSessions':
          send(ws, { type: 'sessions', sessions: db.listSessions() });
          break;
        case 'getContexts':
          send(ws, {
            type: 'contexts',
            sessionId: msg.sessionId,
            contexts: db.listContexts(msg.sessionId),
          });
          break;
        case 'getTurns':
          send(ws, { type: 'turns', contextId: msg.contextId, turns: db.listTurns(msg.contextId) });
          break;
        case 'getTurn':
          send(ws, { type: 'turn', turn: db.getTurn(msg.id) });
          break;
        case 'sql':
          try {
            send(ws, { type: 'result', id: msg.id, rows: db.runReadOnly(msg.sql) });
          } catch (err) {
            send(ws, { type: 'result', id: msg.id, error: err.message });
          }
          break;
        default:
          break;
      }
    } catch (err) {
      send(ws, { type: 'error', message: err.message });
    }
  });
});

// Change detection: fs.watch on the sessions dir (WAL churn) + a 1s polling fallback.
let lastState = db.state();
let debounce = null;
function checkChange() {
  try {
    const s = db.state();
    if (s !== lastState) {
      lastState = s;
      broadcast({ type: 'changed' });
    }
  } catch {
    /* ignore transient locks */
  }
}
function scheduleCheck() {
  clearTimeout(debounce);
  debounce = setTimeout(checkChange, 150);
}
if (existsSync(SESSIONS_DIR)) {
  try {
    watch(SESSIONS_DIR, scheduleCheck);
  } catch {
    /* fall back to polling only */
  }
}
setInterval(checkChange, 1000);

server.listen(PORT, () => {
  console.log(`[viewer] http://127.0.0.1:${PORT}  (tracer: ${TRACER_DB})`);
  if (!existsSync(SESSION_STORE)) {
    console.log(`[viewer] note: session store not found at ${SESSION_STORE} (AIC/status enrichment disabled)`);
  }
  if (!existsSync(DIST)) {
    console.log('[viewer] note: web/dist missing — run "npm run build" to build the UI');
  }
});
