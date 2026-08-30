# agent-loop

Trace exactly what the **GitHub Copilot CLI** sends to and receives from the model, and
inspect it in a live web viewer.

The Copilot CLI is launched behind a local [mitmproxy](https://mitmproxy.org/) that decrypts its
HTTPS traffic, captures each **LLM completion turn** (auth headers redacted), and writes a
normalized row into a local SQLite DB. A small Node server owns that DB and pushes changes over a
WebSocket to a React viewer, so turns appear in near real time. The viewer groups turns by
**session → context (main agent / sub-agents) → turn-evolution**, rendering a git-diff-style view
of how each context's prompt grows turn over turn.

All runtime state (CA + private key, captured sessions, secrets, `.env`) stays **under the repo**
and is **gitignored** — nothing sensitive is ever committed.

## Architecture

```
Copilot CLI ──HTTPS_PROXY──▶ mitmdump (+ mitm/capture_addon.py) ──writes──▶ sessions/tracer.db
                                                                                    │
                              server/ (Node) ── watches DB + reads session-store.db ┤
                                                                                    │
                                     WebSocket push (init + append + read-only SQL) │
                                                                                    ▼
                                                        web/ (React, built by Vite)
```

- The **mitmproxy addon is the only writer** to `sessions/tracer.db`. It matches only
  model-completion flows (`githubcopilot.com` host, path `…/chat/completions` or `…/responses`),
  redacts `authorization`/`api-key`/`cookie`/`token`/`secret` headers **before** storing,
  stores only a scrubbed request-payload view (never auth-bearing payload fields), and
  reassembles streamed SSE responses.
- The **Node server** (`server/`) reads the tracer DB, enriches sessions from the Copilot
  `session-store.db` (read-only: repo/branch/summary/AIC/tokens), detects DB changes, and pushes
  updates. It also runs ad-hoc **read-only** `SELECT` queries from the UI.
- The **React viewer** (`web/`) renders the drill-down UI and live updates.

## Prerequisites

- **Node ≥ 22** (uses the built-in `node:sqlite` — no native build needed).
- **Python 3.9+** with `pip` (for mitmproxy). On Windows the mitmproxy executables land in your
  Python `Scripts` dir; the `.ps1` wrappers add it to `PATH` automatically.
- The **GitHub Copilot CLI** installed and authenticated (`copilot` on `PATH`, or set
  `COPILOT_CMD`).

## Quick start

```powershell
git clone <this-repo> agent-loop
cd agent-loop

# 1) One-time bootstrap: installs mitmproxy, generates the repo-local CA,
#    installs npm deps, builds the viewer, creates sessions/ secrets/ .env.
npm run setup            # or: .\scripts\setup.ps1

# 2) Start tracing — launches copilot through the proxy + viewer.
npm run trace            # or: .\scripts\start-traced.ps1

# 3) Open the viewer
start http://127.0.0.1:8090
```

Anything after `trace` is forwarded to `copilot`:

```powershell
.\scripts\start-traced.ps1 --help      # forwards --help to copilot
```

> **Non-Windows / bare Node:** `npm run setup` then `npm run trace` work anywhere; the `.ps1`
> wrappers only add the Python `Scripts` dir to `PATH`. Set `PYTHON`, `MITMDUMP`, or `COPILOT_CMD`
> env vars if those tools aren't on `PATH`.

### Trusting the CA (optional)

The launcher points the Copilot CLI at the repo-local CA via `NODE_EXTRA_CA_CERTS`, so **you do
not need to trust the CA system-wide** just to trace the CLI. If you also want to inspect
non-Node traffic (e.g. curl/browser) through the same proxy, trust
`.mitmproxy/mitmproxy-ca-cert.cer` in your OS Trusted Root store.

## How to view the turns

1. **Sessions** (left): every session actually captured by the tracer, with **status**
   (`live` while its `copilot` is running, else `ended`), **turn count**, **AIC**
   (Σ `total_nano_aiu` / 1e9), a visible **session id** for investigations, and
   repo/branch/summary from the Copilot session store.
2. **Contexts** (for a selected session): the **main agent** plus any **sub-agents**. Sub-agents
   share the session id but each has its own growing prompt thread; contexts are separated by
   **content-lineage** (a turn joins the context whose latest prompt is a prefix of the new one).
3. **Turn-evolution** (for a selected context): a scrollable, git-diff-style sequence of
   `Turn 0..N` blocks. Runs of identical lines collapse to a single **"N common lines"** marker,
   each change shows a few surrounding common lines for orientation, and hunk headers make it read
   like `git diff`. Turn headers also show `common prefix bytes` and `total bytes` for the
   intercepted **request payload** so you can compare the canonical-message diff with what the
   client actually transmitted.
4. **Turn detail** (drill in): the exact **messages**, **tool schemas**, reassembled **response**
   + tool calls, **usage/params**, the scrubbed **request payload**, and normalized **raw JSON**.

Updates arrive over the WebSocket — no page refresh. You can also run read-only `SELECT`
queries against the tracer DB from the UI for deeper digging.

## Supported model endpoints

The Copilot CLI talks to `*.githubcopilot.com` using different protocols depending on the model.
The capture addon dispatches on the endpoint and normalizes all of them into the same turn schema:

| Model family | Endpoint | Transport |
| --- | --- | --- |
| Claude Opus / Sonnet (4.8, 5, …) | `POST /v1/messages` (Anthropic Messages API) | HTTP + SSE |
| OpenAI `chat/completions` models | `POST /chat/completions` | HTTP + SSE |
| GPT-5.x / Sol (latest OpenAI) | `GET /responses` (OpenAI Responses API) | WebSocket |

**Context threading** adapts to the API: stateless APIs (Anthropic, chat/completions) resend the
full history each turn, so contexts are separated by prompt-prefix lineage. The Responses API is
stateful (only new input items are sent per turn), so those turns are threaded by their stable
`agent_task_id`; sub-agents get a distinct `agent_task_id` and land in their own context. This is
why a canonical-message diff can show a new `### [1] tool` block on GPT/Responses turns even when
the model still has older conversation state server-side: the diff is showing the next transmitted
delta request, not reconstructing the full hidden server-side context.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run setup` | Idempotent bootstrap: mitmproxy install, repo-local CA, deps, build, folders, `.env`. |
| `npm run trace` | Launch `copilot` through the proxy + viewer (the main workflow). |
| `npm run build` | Vite production build of `web/` → `web/dist/`. |
| `npm run dev`   | Vite dev server for viewer development. |
| `npm run server`| Run just the viewer server against an existing `sessions/tracer.db`. |
| `npm run test:diff` | Line-diff unit tests for hunking/alignment behavior. |
| `npm test` / `npm run test:capture` | Integration test: trace a real `copilot` run and assert turns land in the DB. |
| `npm run test:addon` | Addon parsing/redaction/threading unit tests (fast, no network). |
| `npm run test:e2e` | Headed Playwright (Edge) test: watch turns stream into the viewer live. |

## Configuration (`.env`)

`npm run setup` copies `.env.example` → `.env` (gitignored). All values are optional:

| Var | Default | Purpose |
| --- | --- | --- |
| `PROXY_PORT` | `8080` | mitmproxy listen port (also injected as `HTTPS_PROXY`). |
| `VIEWER_PORT` | `8090` | Viewer HTTP + WebSocket port. |
| `COPILOT_CMD` | `copilot` | Command used to launch the Copilot CLI. |
| `COPILOT_SESSION_STORE` | `%USERPROFILE%\.copilot\session-store.db` | Session store used for AIC/enrichment. |

## Layout

```
agent-loop/
  scripts/     setup.js / setup.ps1, start-traced.js / start-traced.ps1
  mitm/        capture_addon.py (the sole DB writer) + test_addon.py
  server/      index.js (HTTP + WS), db.js (queries, read-only SELECT guard)
  web/         React + Vite viewer (src/, built to web/dist/)
  sessions/    tracer.db + captures            (gitignored)
  .mitmproxy/  CA cert + private key           (gitignored)
  secrets/     personal keys/tokens            (gitignored)
  .env         local config                    (gitignored)
```

## Testing

```powershell
npm run test:addon              # addon parsing/redaction/threading unit tests (fast, no network)
npm run test:capture            # integration: trace a real copilot run, assert turns land in the DB
npm run test:e2e                # headed Playwright (Edge): watch turns stream into the viewer live
node scripts\ws_smoke.mjs       # server + WebSocket live-push end-to-end
python scripts\seed_synthetic.py  # seed main + sub-agent turns to explore the UI
```

`test:capture` and `test:e2e` launch a real, authenticated `copilot` through the proxy (a real,
billable model request). Set `TEST_MODEL` to exercise a specific endpoint, e.g.
`$env:TEST_MODEL='gpt-5.4'; npm run test:e2e` for the OpenAI Responses (WebSocket) path.

## Notes / troubleshooting

- **Port already in use:** a stray `mitmdump`/`mitmweb` may hold `8080`. Find it with
  `Get-NetTCPConnection -LocalPort 8080 -State Listen` and `Stop-Process -Id <PID>`, or set a
  different `PROXY_PORT`.
- **`typing-extensions` conflict:** installing mitmproxy may pin `typing-extensions==4.4.0`, which
  can conflict with `azure-core`/`python-pptx`. The addon doesn't need it; if those break, run
  `pip install "typing-extensions>=4.9.0"`.
- **Corporate npm mirrors** may block esbuild's install script (a Vite dependency). If the build
  fails, approve it (e.g. `npm approve-scripts esbuild`) and re-run `npm run setup`.
- **curl on Windows (schannel)** needs `--ssl-no-revoke` to use the mitmproxy CA; Node/OpenSSL is
  unaffected.
- Captures contain your prompts and code (auth redacted). `sessions/` is gitignored and local-only.
