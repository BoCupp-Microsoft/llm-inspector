"""mitmproxy addon: capture Copilot LLM completion turns into sessions/tracer.db.

Responsibilities:
  * Match only model-completion flows (host contains githubcopilot.com, path .../chat/completions
    or .../responses).
  * Redact auth-bearing request headers before anything is stored.
  * Reassemble both non-streaming JSON and streaming SSE responses.
  * Thread each captured turn into an agent "context" via message-prefix lineage so sub-agents
    (which share a session id but have their own prompt thread) diff independently.

This addon is the SOLE writer to tracer.db. The Node viewer server only reads.

Config via environment (set by the launcher):
  TRACER_DB            path to the SQLite tracer DB (default: <cwd>/sessions/tracer.db)
  CAPTURE_SESSION_ID   Copilot session id for this run (default: "unknown")
  CAPTURE_MATCH_HOST   host substring to match (default: "githubcopilot.com")
"""

import hashlib
import json
import os
import re
import sqlite3
import time

from mitmproxy import http

REDACT_RE = re.compile(r"authorization|api[-_]?key|cookie|token|secret|session-id", re.I)
DB_PATH = os.environ.get("TRACER_DB") or os.path.join(os.getcwd(), "sessions", "tracer.db")
SESSION_ID = os.environ.get("CAPTURE_SESSION_ID") or ""
SESSION_ID_FILE = os.environ.get("CAPTURE_SESSION_ID_FILE") or ""
MATCH_HOST = os.environ.get("CAPTURE_MATCH_HOST") or "githubcopilot.com"
DEBUG_LOG = os.environ.get("CAPTURE_DEBUG_LOG") or ""


def _debug(line):
    if not DEBUG_LOG:
        return
    try:
        with open(DEBUG_LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def _current_session_id():
    """Resolve the session id at capture time.

    The launcher can only learn the Copilot session id after `copilot` starts (once it
    creates its session-state dir), so prefer an explicit env value, then a file the
    launcher writes when it detects the id, then a placeholder.
    """
    if SESSION_ID:
        return SESSION_ID
    if SESSION_ID_FILE and os.path.exists(SESSION_ID_FILE):
        try:
            with open(SESSION_ID_FILE, "r", encoding="utf-8") as fh:
                val = fh.read().strip()
                if val:
                    return val
        except OSError:
            pass
    return "unknown"

SCHEMA = """
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
"""


def _connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.executescript(SCHEMA)
    return conn


def _content_to_text(content):
    """Normalize an OpenAI-style message content (str | list of parts | None) to text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict):
                if "text" in p:
                    parts.append(str(p["text"]))
                else:
                    parts.append(json.dumps(p, sort_keys=True))
            else:
                parts.append(str(p))
        return "\n".join(parts)
    return json.dumps(content, sort_keys=True)


def message_key(msg):
    """Stable identity for a single message, used for prefix-lineage threading."""
    role = msg.get("role", "")
    text = _content_to_text(msg.get("content"))
    extra = ""
    if msg.get("tool_calls"):
        extra = json.dumps(msg["tool_calls"], sort_keys=True)
    if msg.get("tool_call_id"):
        extra += "|" + str(msg["tool_call_id"])
    digest = hashlib.sha1((text + "\x00" + extra).encode("utf-8", "replace")).hexdigest()
    return role + ":" + digest


def canonical_prompt(messages):
    """Human-readable, line-based serialization of the prompt for diffing."""
    lines = []
    for i, msg in enumerate(messages):
        role = msg.get("role", "?")
        name = msg.get("name")
        header = f"### [{i}] {role}" + (f" ({name})" if name else "")
        lines.append(header)
        text = _content_to_text(msg.get("content"))
        if text:
            lines.extend(text.split("\n"))
        for tc in msg.get("tool_calls", []) or []:
            fn = (tc.get("function") or {})
            lines.append(f"  -> tool_call {fn.get('name', '?')} {fn.get('arguments', '')}")
        if msg.get("tool_call_id"):
            lines.append(f"  (tool_call_id={msg['tool_call_id']})")
        lines.append("")
    return "\n".join(lines)


def is_prefix(short, long_):
    """True if list `short` is a leading prefix of list `long_`."""
    if len(short) > len(long_):
        return False
    return long_[: len(short)] == short


def parse_sse(body_text):
    """Reassemble a streaming SSE completion body into content, tool_calls, usage, finish_reason."""
    content_parts = []
    tool_calls = {}
    usage = None
    finish_reason = None
    for raw_line in body_text.splitlines():
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        data = line[len("data:"):].strip()
        if not data or data == "[DONE]":
            continue
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            continue
        if obj.get("usage"):
            usage = obj["usage"]
        for choice in obj.get("choices", []) or []:
            if choice.get("finish_reason"):
                finish_reason = choice["finish_reason"]
            delta = choice.get("delta") or {}
            if delta.get("content"):
                content_parts.append(delta["content"])
            for tc in delta.get("tool_calls", []) or []:
                idx = tc.get("index", 0)
                slot = tool_calls.setdefault(idx, {"id": None, "name": None, "arguments": ""})
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]
                if fn.get("arguments"):
                    slot["arguments"] += fn["arguments"]
    ordered = [tool_calls[k] for k in sorted(tool_calls)]
    return {
        "content": "".join(content_parts),
        "tool_calls": ordered,
        "usage": usage,
        "finish_reason": finish_reason,
    }


def parse_json_response(obj):
    """Extract content/tool_calls/usage/finish_reason from a non-streaming completion body."""
    choices = obj.get("choices", []) or []
    content, tool_calls, finish_reason = "", [], None
    if choices:
        c0 = choices[0]
        finish_reason = c0.get("finish_reason")
        msg = c0.get("message") or {}
        content = _content_to_text(msg.get("content"))
        tool_calls = msg.get("tool_calls", []) or []
    return {
        "content": content,
        "tool_calls": tool_calls,
        "usage": obj.get("usage"),
        "finish_reason": finish_reason,
    }


# --- Anthropic Messages API (/v1/messages) ---------------------------------------------------

def _anthropic_blocks_to_text(content):
    """Normalize Anthropic message content (str | list of blocks) to (text, tool_calls, tool_ids)."""
    if isinstance(content, str):
        return content, [], []
    texts, tool_calls, tool_ids = [], [], []
    for b in content or []:
        if not isinstance(b, dict):
            texts.append(str(b))
            continue
        bt = b.get("type")
        if bt == "text":
            texts.append(b.get("text", ""))
        elif bt == "tool_use":
            tool_calls.append({
                "id": b.get("id"),
                "type": "function",
                "function": {"name": b.get("name"), "arguments": json.dumps(b.get("input", {}), sort_keys=True)},
            })
            texts.append(f"[tool_use {b.get('name')} #{b.get('id')}]")
        elif bt == "tool_result":
            rid = b.get("tool_use_id")
            tool_ids.append(rid)
            texts.append(f"[tool_result #{rid}] " + _content_to_text(b.get("content")))
        elif bt == "thinking":
            texts.append("[thinking] " + str(b.get("thinking", "")))
        elif bt == "image":
            texts.append("[image]")
        else:
            texts.append(json.dumps(b, sort_keys=True))
    return "\n".join(texts), tool_calls, tool_ids


def normalize_anthropic_request(obj):
    """Convert an Anthropic /v1/messages request into the internal OpenAI-like shape."""
    messages = []
    system = obj.get("system")
    if system:
        messages.append({"role": "system", "content": _content_to_text(system)})
    for m in obj.get("messages", []) or []:
        text, tcs, tids = _anthropic_blocks_to_text(m.get("content"))
        nm = {"role": m.get("role", "user"), "content": text}
        if tcs:
            nm["tool_calls"] = tcs
        if tids:
            nm["tool_call_id"] = tids[0] if len(tids) == 1 else json.dumps(tids)
        messages.append(nm)
    req = {"model": obj.get("model"), "messages": messages, "tools": obj.get("tools", []) or []}
    for k, v in obj.items():
        if k not in ("system", "messages", "tools"):
            req[k] = v
    return req


def parse_anthropic_sse(body_text):
    """Reassemble an Anthropic streaming (SSE) response into content/tool_calls/usage/finish_reason."""
    content_parts, blocks, usage, finish = [], {}, {}, None
    for raw_line in body_text.splitlines():
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        data = line[len("data:"):].strip()
        if not data or data == "[DONE]":
            continue
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            continue
        t = obj.get("type")
        if t == "message_start":
            usage.update((obj.get("message") or {}).get("usage", {}) or {})
        elif t == "content_block_start":
            idx = obj.get("index", 0)
            cb = obj.get("content_block", {}) or {}
            blocks[idx] = {
                "type": cb.get("type"),
                "text": cb.get("text", "") if cb.get("type") == "text" else "",
                "name": cb.get("name"),
                "id": cb.get("id"),
                "input": "",
            }
        elif t == "content_block_delta":
            idx = obj.get("index", 0)
            d = obj.get("delta", {}) or {}
            b = blocks.setdefault(idx, {"type": d.get("type"), "text": "", "input": ""})
            if d.get("type") == "text_delta":
                b["text"] += d.get("text", "")
                content_parts.append(d.get("text", ""))
            elif d.get("type") == "input_json_delta":
                b["input"] += d.get("partial_json", "")
        elif t == "message_delta":
            dd = obj.get("delta", {}) or {}
            if dd.get("stop_reason"):
                finish = dd["stop_reason"]
            if obj.get("usage"):
                usage.update(obj["usage"])
    tool_calls = []
    for idx in sorted(blocks):
        b = blocks[idx]
        if b.get("type") == "tool_use":
            tool_calls.append({"id": b.get("id"), "name": b.get("name"), "arguments": b.get("input", "")})
    return {"content": "".join(content_parts), "tool_calls": tool_calls, "usage": usage or None, "finish_reason": finish}


def parse_anthropic_json(obj):
    """Extract content/tool_calls/usage/finish from a non-streaming Anthropic response."""
    content, tool_calls = [], []
    for b in obj.get("content", []) or []:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            content.append(b.get("text", ""))
        elif b.get("type") == "tool_use":
            tool_calls.append({"id": b.get("id"), "name": b.get("name"), "arguments": json.dumps(b.get("input", {}), sort_keys=True)})
    return {"content": "".join(content), "tool_calls": tool_calls, "usage": obj.get("usage"), "finish_reason": obj.get("stop_reason")}


# --- OpenAI Responses API (/responses over WebSocket) ---------------------------------------

def _responses_content_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict):
                if p.get("type") in ("input_text", "output_text", "text", "summary_text"):
                    parts.append(p.get("text", ""))
                elif p.get("type") in ("input_image", "output_image"):
                    parts.append("[image]")
                else:
                    parts.append(json.dumps(p, sort_keys=True))
            else:
                parts.append(str(p))
        return "\n".join(parts)
    return _content_to_text(content)


def normalize_responses_request(obj):
    """Convert an OpenAI Responses (response.create) request into the internal shape."""
    messages = []
    instr = obj.get("instructions")
    if instr:
        messages.append({"role": "system", "content": _content_to_text(instr)})
    for it in obj.get("input", []) or []:
        if not isinstance(it, dict):
            messages.append({"role": "user", "content": str(it)})
            continue
        t = it.get("type")
        if t == "message" or (t is None and it.get("role")):
            messages.append({"role": it.get("role", "user"), "content": _responses_content_text(it.get("content"))})
        elif t == "function_call":
            messages.append({
                "role": "assistant",
                "content": f"[function_call {it.get('name')}]",
                "tool_calls": [{
                    "id": it.get("call_id") or it.get("id"),
                    "type": "function",
                    "function": {"name": it.get("name"), "arguments": it.get("arguments", "")},
                }],
            })
        elif t == "function_call_output":
            messages.append({"role": "tool", "content": _content_to_text(it.get("output")), "tool_call_id": it.get("call_id")})
        elif t == "reasoning":
            summ = it.get("summary") or []
            txt = "\n".join(s.get("text", "") for s in summ if isinstance(s, dict))
            messages.append({"role": "assistant", "content": "[reasoning] " + txt})
        else:
            messages.append({"role": "system", "content": json.dumps(it, sort_keys=True)})
    req = {"model": obj.get("model"), "messages": messages, "tools": obj.get("tools", []) or []}
    for k, v in obj.items():
        if k not in ("input", "instructions", "tools", "headers"):
            req[k] = v
    return req


def parse_responses_frames(events):
    """Reassemble OpenAI Responses server-side WS events into content/tool_calls/usage/finish."""
    content_parts, tool_calls, usage, finish = [], [], None, None
    for ev in events:
        if not isinstance(ev, dict):
            continue
        t = ev.get("type")
        if t == "response.output_text.delta":
            content_parts.append(ev.get("delta", ""))
        elif t == "response.output_item.done":
            item = ev.get("item", {}) or {}
            if item.get("type") == "function_call":
                tool_calls.append({
                    "id": item.get("call_id") or item.get("id"),
                    "name": item.get("name"),
                    "arguments": item.get("arguments", ""),
                })
        elif t == "response.completed":
            resp = ev.get("response", {}) or {}
            finish = resp.get("status") or finish
            usage = ev.get("copilot_usage") or resp.get("usage") or usage
            if not content_parts:
                for it in resp.get("output", []) or []:
                    if it.get("type") == "message":
                        for pt in it.get("content", []) or []:
                            if pt.get("type") == "output_text":
                                content_parts.append(pt.get("text", ""))
        elif t in ("response.failed", "response.incomplete", "error"):
            resp = ev.get("response", {}) or {}
            finish = resp.get("status") or "error"
    return {"content": "".join(content_parts), "tool_calls": tool_calls, "usage": usage, "finish_reason": finish}


def _endpoint_kind(host, path):
    """Classify a completion endpoint by host+path, or None if not a model turn.

    Copilot uses different model APIs depending on the selected model:
      * anthropic         -> POST .../v1/messages           (Claude Opus/Sonnet)  HTTP + SSE
      * openai_chat       -> POST .../chat/completions       (OpenAI chat)         HTTP + SSE
      * openai_responses  -> GET  .../responses (WebSocket)   (GPT-5.x / Sol)       WS frames
    """
    if MATCH_HOST not in (host or ""):
        return None
    p = path or ""
    if "/v1/messages" in p:
        return "anthropic"
    if "chat/completions" in p:
        return "openai_chat"
    if p.rstrip("/").endswith("/responses"):
        return "openai_responses"
    return None


def _http_kind(flow):
    """Endpoint kind capturable over plain HTTP (not the WebSocket /responses)."""
    kind = _endpoint_kind(flow.request.pretty_host, flow.request.path)
    return kind if kind in ("anthropic", "openai_chat") else None


def _matches(flow: http.HTTPFlow) -> bool:
    return _http_kind(flow) is not None


def _redact_headers(flow):
    out = {}
    for name, value in flow.request.headers.items(multi=True):
        out[name] = "REDACTED" if REDACT_RE.search(name) else value
    return out


def _assign_context(conn, session_id, msgkeys, thread_key=None):
    """Thread a turn into a context.

    Two strategies, depending on how the model API carries conversation state:
      * thread_key given (stateful APIs like OpenAI Responses, which resend only new input and
        identify the conversation by `agent_task_id`) -> match/create a context by exact key.
      * thread_key None (stateless APIs like Anthropic /v1/messages and OpenAI chat, which resend
        the full message history) -> match the context whose latest message-key list is a full
        prefix of this turn's; longest wins. Sub-agents diverge into their own context.
    """
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    if thread_key is not None:
        row = conn.execute(
            "SELECT context_id, turn_count FROM contexts WHERE session_id=? AND thread_key=?",
            (session_id, thread_key),
        ).fetchone()
        if row is not None:
            context_id, turn_count = row
            conn.execute(
                "UPDATE contexts SET latest_keys_json=?, turn_count=turn_count+1 WHERE context_id=?",
                (json.dumps(msgkeys), context_id),
            )
            return context_id, turn_count
        return _new_context(conn, session_id, msgkeys, thread_key, now)

    rows = conn.execute(
        "SELECT context_id, latest_keys_json, turn_count FROM contexts "
        "WHERE session_id=? AND thread_key IS NULL",
        (session_id,),
    ).fetchall()
    best = None
    best_len = -1
    for context_id, latest_keys_json, turn_count in rows:
        latest = json.loads(latest_keys_json) if latest_keys_json else []
        if is_prefix(latest, msgkeys) and len(latest) > best_len:
            best, best_len = (context_id, turn_count), len(latest)
    if best is not None:
        context_id, turn_count = best
        conn.execute(
            "UPDATE contexts SET latest_keys_json=?, turn_count=turn_count+1 WHERE context_id=?",
            (json.dumps(msgkeys), context_id),
        )
        return context_id, turn_count
    return _new_context(conn, session_id, msgkeys, None, now)


def _new_context(conn, session_id, msgkeys, thread_key, now):
    """Create a new context (first is the main agent, later ones are sub-agents)."""
    existing = conn.execute(
        "SELECT COUNT(*) FROM contexts WHERE session_id=?", (session_id,)
    ).fetchone()[0]
    label = "Main agent" if existing == 0 else f"Sub-agent {existing}"
    cur = conn.execute(
        "INSERT INTO contexts (session_id, label, thread_key, latest_keys_json, turn_count, first_seen_at) "
        "VALUES (?,?,?,?,1,?)",
        (session_id, label, thread_key, json.dumps(msgkeys), now),
    )
    return cur.lastrowid, 0


def store_turn(conn, session_id, req_obj, parsed, meta):
    """Thread + insert one turn. Shared by the live capture path and the test seeder."""
    messages = req_obj.get("messages", []) or []
    tools = req_obj.get("tools", []) or []
    params = {k: v for k, v in req_obj.items() if k not in ("messages", "tools")}
    msgkeys = [message_key(m) for m in messages]
    # Stateful APIs (OpenAI Responses) identify a conversation by agent_task_id; stateless ones
    # (Anthropic, OpenAI chat) leave this None and thread by resent-history prefix instead.
    thread_key = req_obj.get("agent_task_id")

    conn.execute(
        "INSERT OR IGNORE INTO capture_sessions (session_id, started_at, status) VALUES (?,?,?)",
        (session_id, time.strftime("%Y-%m-%dT%H:%M:%S"), "live"),
    )
    context_id, turn_index = _assign_context(conn, session_id, msgkeys, thread_key)
    conn.execute(
        """INSERT INTO turns (
            session_id, context_id, turn_index, captured_at, flow_id, host, path, method,
            status_code, duration_ms, model, stream, request_headers_json, params_json,
            messages_json, tools_json, msgkeys_json, canonical_prompt_text, response_text,
            tool_calls_json, finish_reason, usage_json, raw_response_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            session_id,
            context_id,
            turn_index,
            time.strftime("%Y-%m-%dT%H:%M:%S"),
            meta.get("flow_id"),
            meta.get("host"),
            meta.get("path"),
            meta.get("method"),
            meta.get("status_code"),
            meta.get("duration_ms"),
            req_obj.get("model"),
            1 if params.get("stream") else 0,
            json.dumps(meta.get("headers", {})),
            json.dumps(params),
            json.dumps(messages),
            json.dumps(tools),
            json.dumps(msgkeys),
            canonical_prompt(messages),
            parsed["content"],
            json.dumps(parsed["tool_calls"]),
            parsed["finish_reason"],
            json.dumps(parsed["usage"]) if parsed["usage"] else None,
            json.dumps(parsed),
        ),
    )
    conn.commit()
    return context_id, turn_index


def running():
    """Suppress benign Windows ProactorEventLoop disconnect noise.

    When a client (Copilot) abruptly drops a TLS connection, asyncio's ``_call_connection_lost``
    calls ``socket.shutdown(SHUT_RDWR)`` which raises ``ConnectionResetError [WinError 10054]``.
    On Python 3.9 this isn't guarded, so asyncio routes it to the loop exception handler and prints
    a full traceback. It's harmless — install a handler that drops these specific errors and chains
    everything else to the previous handler.
    """
    try:
        import asyncio

        loop = asyncio.get_event_loop()
    except Exception:  # pragma: no cover - defensive
        return

    prev = loop.get_exception_handler()

    def handler(loop, context):
        exc = context.get("exception")
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        if isinstance(exc, OSError) and getattr(exc, "winerror", None) in (10053, 10054, 64):
            return
        if prev is not None:
            prev(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(handler)


def request(flow: http.HTTPFlow):
    # Diagnostic only (enabled via CAPTURE_DEBUG_LOG): record every host+path the client hits.
    if DEBUG_LOG:
        _debug(f"REQ {flow.request.method} {flow.request.pretty_host} {flow.request.path}")


def response(flow: http.HTTPFlow):
    if DEBUG_LOG:
        _debug(
            f"RESP {flow.response.status_code} {flow.request.pretty_host} "
            f"{flow.request.path} kind={_endpoint_kind(flow.request.pretty_host, flow.request.path)} "
            f"ct={flow.response.headers.get('content-type','')}"
        )
        _maybe_dump_http(flow)

    kind = _http_kind(flow)
    if kind is None:
        return
    try:
        raw_req = json.loads(flow.request.get_text() or "{}")
    except (json.JSONDecodeError, ValueError):
        raw_req = {}

    body_text = flow.response.get_text() or ""
    content_type = flow.response.headers.get("content-type", "")
    is_sse = "text/event-stream" in content_type or body_text.lstrip().startswith(("data:", "event:"))

    if kind == "anthropic":
        req_obj = normalize_anthropic_request(raw_req)
        if is_sse:
            parsed = parse_anthropic_sse(body_text)
        else:
            try:
                parsed = parse_anthropic_json(json.loads(body_text))
            except (json.JSONDecodeError, ValueError):
                parsed = {"content": "", "tool_calls": [], "usage": None, "finish_reason": None}
    else:  # openai_chat
        req_obj = raw_req
        if is_sse:
            parsed = parse_sse(body_text)
        else:
            try:
                parsed = parse_json_response(json.loads(body_text))
            except (json.JSONDecodeError, ValueError):
                parsed = {"content": "", "tool_calls": [], "usage": None, "finish_reason": None}

    duration_ms = None
    if flow.response.timestamp_end and flow.request.timestamp_start:
        duration_ms = int((flow.response.timestamp_end - flow.request.timestamp_start) * 1000)

    meta = {
        "flow_id": flow.id,
        "host": flow.request.pretty_host,
        "path": flow.request.path,
        "method": flow.request.method,
        "status_code": flow.response.status_code,
        "duration_ms": duration_ms,
        "headers": _redact_headers(flow),
    }

    conn = _connect()
    try:
        store_turn(conn, _current_session_id(), req_obj, parsed, meta)
    finally:
        conn.close()


def _maybe_dump_http(flow):
    """Diagnostic: dump a matched HTTP request/response body pair when CAPTURE_DUMP_DIR is set."""
    d = os.environ.get("CAPTURE_DUMP_DIR")
    if not d or _http_kind(flow) is None:
        return
    try:
        os.makedirs(d, exist_ok=True)
        stamp = str(int(time.time() * 1000))
        with open(os.path.join(d, f"req_{stamp}.json"), "w", encoding="utf-8") as fh:
            fh.write(flow.request.get_text() or "")
        with open(os.path.join(d, f"resp_{stamp}.txt"), "w", encoding="utf-8") as fh:
            fh.write(flow.response.get_text() or "")
    except OSError:
        pass


def _ws_frames(flow):
    ws = getattr(flow, "websocket", None)
    frames = []
    for m in (ws.messages if ws else []):
        try:
            text = m.content.decode("utf-8", "replace")
        except AttributeError:
            text = str(m.content)
        frames.append((bool(m.from_client), text))
    return frames


# Incremental Responses-WS capture state, keyed by flow id. The main-agent conversation runs over
# a single long-lived WebSocket, so waiting for websocket_end would leave a live session empty.
# Instead we flush each turn the moment its terminal event arrives.
_WS_STATE = {}
_WS_TERMINAL = ("response.completed", "response.failed", "response.incomplete", "error")


def _ws_meta(flow):
    return {
        "flow_id": flow.id,
        "host": flow.request.pretty_host,
        "path": flow.request.path,
        "method": "WEBSOCKET",
        "status_code": flow.response.status_code if flow.response else 101,
        "headers": _redact_headers(flow),
    }


def _flush_ws_segment(seg, meta):
    """Store one completed Responses turn exactly once."""
    if not seg or seg.get("flushed") or seg.get("req") is None:
        return
    seg["flushed"] = True
    req_obj = normalize_responses_request(seg["req"])
    parsed = parse_responses_frames(seg["events"])
    conn = _connect()
    try:
        store_turn(conn, _current_session_id(), req_obj, parsed, dict(meta))
    finally:
        conn.close()


def websocket_message(flow: http.HTTPFlow):
    """Capture each Responses turn as soon as it completes so a live session populates immediately
    instead of only when the long-lived WebSocket finally closes.

    A socket carries many turns: a client `response.create` opens a turn; the server streams
    `response.*` events until a terminal event (`response.completed`/`failed`/`incomplete`/`error`)
    closes it. We flush on the terminal event, and fall back to flushing on the next `create` if a
    terminal event was somehow missed.
    """
    if _endpoint_kind(flow.request.pretty_host, flow.request.path) != "openai_responses":
        return
    ws = getattr(flow, "websocket", None)
    if not ws or not ws.messages:
        return
    m = ws.messages[-1]
    try:
        text = m.content.decode("utf-8", "replace")
    except AttributeError:
        text = str(m.content)
    try:
        obj = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return

    st = _WS_STATE.setdefault(flow.id, {"cur": None})
    meta = _ws_meta(flow)
    if m.from_client:
        if obj.get("type") == "response.create":
            _flush_ws_segment(st["cur"], meta)  # fallback flush of a turn with no terminal event
            st["cur"] = {"req": obj, "events": [], "flushed": False}
    else:
        cur = st["cur"]
        if cur is not None and not cur["flushed"]:
            cur["events"].append(obj)
            if obj.get("type") in _WS_TERMINAL:
                _flush_ws_segment(cur, meta)


def websocket_end(flow: http.HTTPFlow):
    """Finalize a Responses WebSocket. The incremental websocket_message hook has already stored
    each completed turn; here we only flush a trailing turn that never got a terminal event (socket
    closed mid-turn) and clean up state. If the incremental hook never ran (state absent), fall back
    to reconstructing every turn from the full frame history."""
    if _endpoint_kind(flow.request.pretty_host, flow.request.path) != "openai_responses":
        return

    st = _WS_STATE.pop(flow.id, None)
    if st is not None:
        _flush_ws_segment(st["cur"], _ws_meta(flow))
        return

    # Fallback: no incremental state (e.g. all frames delivered at close) — segment the full history.
    frames = _ws_frames(flow)
    if DEBUG_LOG:
        _debug(f"WS /responses frames={len(frames)}")
        if os.environ.get("CAPTURE_DUMP_DIR"):
            try:
                d = os.environ["CAPTURE_DUMP_DIR"]
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, f"ws_{int(time.time()*1000)}.ndjson"), "w", encoding="utf-8") as fh:
                    for fc, text in frames:
                        fh.write(json.dumps({"from_client": fc, "text": text}) + "\n")
            except OSError:
                pass

    # Segment frames into (create_request, [server_events]) turns.
    segments = []
    cur = None
    for from_client, text in frames:
        try:
            obj = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            continue
        if from_client:
            if obj.get("type") == "response.create":
                cur = {"req": obj, "events": []}
                segments.append(cur)
        elif cur is not None:
            cur["events"].append(obj)

    if not segments:
        return

    meta_base = {
        "flow_id": flow.id,
        "host": flow.request.pretty_host,
        "path": flow.request.path,
        "method": "WEBSOCKET",
        "status_code": flow.response.status_code if flow.response else 101,
        "headers": _redact_headers(flow),
    }
    conn = _connect()
    try:
        for seg in segments:
            req_obj = normalize_responses_request(seg["req"])
            parsed = parse_responses_frames(seg["events"])
            store_turn(conn, _current_session_id(), req_obj, parsed, dict(meta_base))
    finally:
        conn.close()

