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


def _matches(flow: http.HTTPFlow) -> bool:
    host = flow.request.pretty_host or ""
    path = flow.request.path or ""
    if MATCH_HOST not in host:
        return False
    return "chat/completions" in path or path.rstrip("/").endswith("/responses")


def _redact_headers(flow):
    out = {}
    for name, value in flow.request.headers.items(multi=True):
        out[name] = "REDACTED" if REDACT_RE.search(name) else value
    return out


def _assign_context(conn, session_id, msgkeys):
    """Thread a turn into a context by longest full message-prefix match; create one if none."""
    rows = conn.execute(
        "SELECT context_id, latest_keys_json, turn_count FROM contexts WHERE session_id=?",
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
    # New context (main agent for the first, sub-agents thereafter).
    existing = conn.execute(
        "SELECT COUNT(*) FROM contexts WHERE session_id=?", (session_id,)
    ).fetchone()[0]
    label = "Main agent" if existing == 0 else f"Sub-agent {existing}"
    cur = conn.execute(
        "INSERT INTO contexts (session_id, label, latest_keys_json, turn_count, first_seen_at) "
        "VALUES (?,?,?,1,?)",
        (session_id, label, json.dumps(msgkeys), time.strftime("%Y-%m-%dT%H:%M:%S")),
    )
    return cur.lastrowid, 0


def store_turn(conn, session_id, req_obj, parsed, meta):
    """Thread + insert one turn. Shared by the live capture path and the test seeder."""
    messages = req_obj.get("messages", []) or []
    tools = req_obj.get("tools", []) or []
    params = {k: v for k, v in req_obj.items() if k not in ("messages", "tools")}
    msgkeys = [message_key(m) for m in messages]

    conn.execute(
        "INSERT OR IGNORE INTO capture_sessions (session_id, started_at, status) VALUES (?,?,?)",
        (session_id, time.strftime("%Y-%m-%dT%H:%M:%S"), "live"),
    )
    context_id, turn_index = _assign_context(conn, session_id, msgkeys)
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


def response(flow: http.HTTPFlow):
    if not _matches(flow):
        return
    try:
        req_obj = json.loads(flow.request.get_text() or "{}")
    except (json.JSONDecodeError, ValueError):
        req_obj = {}

    body_text = flow.response.get_text() or ""
    content_type = flow.response.headers.get("content-type", "")
    if "text/event-stream" in content_type or body_text.lstrip().startswith("data:"):
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
