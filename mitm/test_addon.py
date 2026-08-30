"""Unit tests for capture_addon parsing, threading, and redaction.

Run: python mitm/test_addon.py   (mitmproxy must be importable)
"""

import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(__file__))

import capture_addon as addon  # noqa: E402


def check(name, cond):
    print(("PASS" if cond else "FAIL") + " - " + name)
    if not cond:
        check.failed += 1


check.failed = 0


def test_sse():
    body = (
        'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1",'
        '"function":{"name":"foo","arguments":"{\\"a\\":"}}]}}]}\n\n'
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
        '"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n'
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'
        "data: [DONE]\n\n"
    )
    r = addon.parse_sse(body)
    check("sse content reassembled", r["content"] == "Hello")
    check("sse tool_call name", r["tool_calls"][0]["name"] == "foo")
    check("sse tool_call args merged", r["tool_calls"][0]["arguments"] == '{"a":1}')
    check("sse finish_reason", r["finish_reason"] == "tool_calls")
    check("sse usage", r["usage"]["total_tokens"] == 15)


def test_json():
    obj = {
        "choices": [{"message": {"content": "hi there"}, "finish_reason": "stop"}],
        "usage": {"total_tokens": 42},
    }
    r = addon.parse_json_response(obj)
    check("json content", r["content"] == "hi there")
    check("json finish_reason", r["finish_reason"] == "stop")
    check("json usage", r["usage"]["total_tokens"] == 42)


def test_redaction():
    check("redacts Authorization", bool(addon.REDACT_RE.search("Authorization")))
    check("redacts x-api-key", bool(addon.REDACT_RE.search("x-api-key")))
    check("redacts Cookie", bool(addon.REDACT_RE.search("Cookie")))
    check("keeps content-type", not addon.REDACT_RE.search("content-type"))


def test_payload_scrub():
    raw = json.dumps({
        "model": "gpt-5.4",
        "token": "top-secret",
        "nested": {"session-id": "abc123"},
        "messages": [{"role": "user", "content": "hello"}],
    })
    scrubbed = addon.scrub_payload_text(raw)
    check("payload scrub removes token value", "top-secret" not in scrubbed)
    check("payload scrub removes session id value", "abc123" not in scrubbed)
    check("payload scrub keeps benign content", "hello" in scrubbed)


def test_threading():
    conn = sqlite3.connect(":memory:")
    conn.executescript(addon.SCHEMA)
    sid = "s1"

    def turn(msgs):
        keys = [addon.message_key(m) for m in msgs]
        return addon._assign_context(conn, sid, keys)

    sys_m = {"role": "system", "content": "MAIN SYSTEM PROMPT"}
    u1 = {"role": "user", "content": "first"}
    a1 = {"role": "assistant", "content": "answer1"}
    u2 = {"role": "user", "content": "second"}

    c0, t0 = turn([sys_m, u1])                    # main turn 0
    c1, t1 = turn([sys_m, u1, a1, u2])            # main turn 1 (extends)
    # Sub-agent: different system prompt -> new context
    sub_sys = {"role": "system", "content": "SUBAGENT SYSTEM PROMPT"}
    sub_u = {"role": "user", "content": "do subtask"}
    c2, t2 = turn([sub_sys, sub_u])               # sub-agent turn 0
    c3, t3 = turn([sys_m, u1, a1, u2, {"role": "assistant", "content": "a2"},
                   {"role": "user", "content": "third"}])  # main turn 2

    check("main stays one context", c0 == c1 == c3)
    check("main turn indices increment", (t0, t1, t3) == (0, 1, 2))
    check("sub-agent is a new context", c2 != c0)
    check("sub-agent turn index resets", t2 == 0)

    labels = dict(conn.execute("SELECT context_id, label FROM contexts").fetchall())
    check("first context labeled Main agent", labels[c0] == "Main agent")
    check("second context labeled Sub-agent", labels[c2].startswith("Sub-agent"))


def test_canonical():
    text = addon.canonical_prompt([{"role": "system", "content": "a\nb"}])
    check("canonical has role header", "### [0] system" in text)
    check("canonical keeps lines", "a" in text and "b" in text)


def test_anthropic_sse():
    body = (
        'event: message_start\n'
        'data: {"type":"message_start","message":{"model":"claude-opus-4-8",'
        '"usage":{"input_tokens":10,"output_tokens":1}}}\n\n'
        'event: content_block_start\n'
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
        'event: content_block_delta\n'
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"4"}}\n\n'
        'event: content_block_delta\n'
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"2"}}\n\n'
        'event: content_block_start\n'
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"calc"}}\n\n'
        'event: content_block_delta\n'
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":"}}\n\n'
        'event: content_block_delta\n'
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"5}"}}\n\n'
        'event: message_delta\n'
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n'
        'event: message_stop\n'
        'data: {"type":"message_stop"}\n\n'
    )
    r = addon.parse_anthropic_sse(body)
    check("anthropic sse text", r["content"] == "42")
    check("anthropic sse tool name", r["tool_calls"][0]["name"] == "calc")
    check("anthropic sse tool args merged", r["tool_calls"][0]["arguments"] == '{"x":5}')
    check("anthropic sse finish_reason", r["finish_reason"] == "tool_use")
    check("anthropic sse usage merged", r["usage"]["input_tokens"] == 10 and r["usage"]["output_tokens"] == 7)


def test_anthropic_request_normalize():
    obj = {
        "model": "claude-opus-4.8",
        "system": [{"type": "text", "text": "SYS"}],
        "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": [
                {"type": "text", "text": "let me check"},
                {"type": "tool_use", "id": "tu1", "name": "ls", "input": {"path": "."}},
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "tu1", "content": "a.txt"},
            ]},
        ],
        "tools": [{"name": "ls"}],
    }
    req = addon.normalize_anthropic_request(obj)
    roles = [m["role"] for m in req["messages"]]
    check("anthropic req has system first", roles[0] == "system" and req["messages"][0]["content"] == "SYS")
    check("anthropic req roles", roles == ["system", "user", "assistant", "user"])
    check("anthropic req tool_call extracted", req["messages"][2]["tool_calls"][0]["function"]["name"] == "ls")
    check("anthropic req tool_result id", req["messages"][3]["tool_call_id"] == "tu1")
    check("anthropic req model preserved", req["model"] == "claude-opus-4.8")


def test_responses_request_normalize():
    obj = {
        "type": "response.create",
        "model": "gpt-5.4",
        "instructions": "INSTR",
        "agent_task_id": "task-abc",
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
            {"type": "function_call", "name": "sh", "arguments": "{}", "call_id": "fc1"},
            {"type": "function_call_output", "call_id": "fc1", "output": "done"},
        ],
        "tools": [{"type": "function", "name": "sh"}],
    }
    req = addon.normalize_responses_request(obj)
    roles = [m["role"] for m in req["messages"]]
    check("responses req system first", roles[0] == "system" and req["messages"][0]["content"] == "INSTR")
    check("responses req roles", roles == ["system", "user", "assistant", "tool"])
    check("responses req function_call", req["messages"][2]["tool_calls"][0]["function"]["name"] == "sh")
    check("responses req tool result id", req["messages"][3]["tool_call_id"] == "fc1")
    check("responses req keeps agent_task_id", req["agent_task_id"] == "task-abc")


def test_responses_frames():
    events = [
        {"type": "response.created", "response": {"status": "in_progress"}},
        {"type": "response.output_text.delta", "delta": "4"},
        {"type": "response.output_text.delta", "delta": "2"},
        {"type": "response.output_item.done", "item": {"type": "function_call", "call_id": "fc1", "name": "sh", "arguments": "{\"c\":1}"}},
        {"type": "response.completed", "response": {"status": "completed"}, "copilot_usage": {"total_nano_aiu": 123}},
    ]
    r = addon.parse_responses_frames(events)
    check("responses frames text", r["content"] == "42")
    check("responses frames tool_call", r["tool_calls"][0]["name"] == "sh")
    check("responses frames finish", r["finish_reason"] == "completed")
    check("responses frames usage", r["usage"]["total_nano_aiu"] == 123)


def test_responses_completed_output():
    """A function_call delivered only inside response.completed.response.output (never as a
    standalone response.output_item.done) must still be captured — this is the blank-turn bug."""
    events = [
        {"type": "response.created", "response": {"status": "in_progress"}},
        {"type": "response.reasoning_summary_text.delta", "delta": "thinking..."},
        {"type": "response.completed", "response": {
            "status": "completed",
            "output": [
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": " done"}]},
                {"type": "function_call", "call_id": "cc9", "name": "sql", "arguments": "{\"q\":1}"},
            ],
        }, "copilot_usage": {"total_nano_aiu": 5}},
    ]
    r = addon.parse_responses_frames(events)
    check("completed-output tool_call captured", len(r["tool_calls"]) == 1 and r["tool_calls"][0]["name"] == "sql")
    check("completed-output tool_call id", r["tool_calls"][0]["id"] == "cc9")
    check("completed-output reasoning captured", r["reasoning"] == "thinking... done")


def test_responses_toolcall_dedup():
    """The same tool call arriving via both output_item.done and completed.output is stored once."""
    events = [
        {"type": "response.output_item.done", "item": {"type": "function_call", "call_id": "d1", "name": "sh", "arguments": "{}"}},
        {"type": "response.completed", "response": {
            "status": "completed",
            "output": [{"type": "function_call", "call_id": "d1", "name": "sh", "arguments": "{}"}],
        }},
    ]
    r = addon.parse_responses_frames(events)
    check("tool_call deduped by id", len(r["tool_calls"]) == 1)


def test_responses_threading():
    """Stateful Responses turns (same agent_task_id) thread into one context even though the
    resent message history is not a growing prefix."""
    conn = sqlite3.connect(":memory:")
    conn.executescript(addon.SCHEMA)
    sid = "s-resp"
    meta = {"host": "h", "path": "/responses", "method": "WEBSOCKET"}

    req0 = {"model": "gpt-5.4", "agent_task_id": "T1",
            "messages": [{"role": "system", "content": "SYS"}, {"role": "user", "content": "go"}]}
    req1 = {"model": "gpt-5.4", "agent_task_id": "T1",
            "messages": [{"role": "system", "content": "SYS"}, {"role": "tool", "content": "result", "tool_call_id": "fc1"}]}
    reqSub = {"model": "gpt-5.4", "agent_task_id": "T2",
              "messages": [{"role": "system", "content": "SUB"}, {"role": "user", "content": "sub"}]}
    parsed = {"content": "", "tool_calls": [], "usage": None, "finish_reason": "completed"}

    c0, t0 = addon.store_turn(conn, sid, req0, parsed, dict(meta))
    c1, t1 = addon.store_turn(conn, sid, req1, parsed, dict(meta))
    c2, t2 = addon.store_turn(conn, sid, reqSub, parsed, dict(meta))

    check("responses same agent_task_id threads", c0 == c1)
    check("responses turn index increments", (t0, t1) == (0, 1))
    check("responses different agent_task_id new context", c2 != c0)
    check("responses sub turn index resets", t2 == 0)


def test_store_turn_payload_metrics():
    conn = sqlite3.connect(":memory:")
    conn.executescript(addon.SCHEMA)
    addon._ensure_columns(conn, "turns", addon.TURN_COLUMN_MIGRATIONS)
    addon._PREV_PAYLOAD_BYTES.clear()
    sid = "s-payload"
    meta = {"host": "h", "path": "/responses", "method": "WEBSOCKET"}
    parsed = {"content": "", "tool_calls": [], "usage": None, "finish_reason": "completed"}

    req0 = {"model": "gpt-5.4", "agent_task_id": "T1",
            "messages": [{"role": "system", "content": "SYS"}, {"role": "user", "content": "go"}]}
    req1 = {"model": "gpt-5.4", "agent_task_id": "T1",
            "messages": [{"role": "system", "content": "SYS"}, {"role": "tool", "content": "done", "tool_call_id": "fc1"}]}
    raw0 = b'{"type":"response.create","token":"secret","input":[{"role":"user","content":"go"}]}'
    raw1 = b'{"type":"response.create","token":"secret","input":[{"role":"tool","content":"done"}]}'

    addon.store_turn(conn, sid, req0, parsed, dict(meta), payload=addon.payload_capture(raw0))
    addon.store_turn(conn, sid, req1, parsed, dict(meta), payload=addon.payload_capture(raw1))

    rows = conn.execute(
        "SELECT turn_index, request_payload_text, request_payload_bytes, common_prefix_bytes "
        "FROM turns WHERE session_id=? ORDER BY id",
        (sid,),
    ).fetchall()
    check("first turn total bytes", rows[0][2] == len(raw0))
    check("second turn total bytes", rows[1][2] == len(raw1))
    check("first turn prefix bytes absent", rows[0][3] is None)
    check("second turn prefix bytes exact", rows[1][3] == addon.common_prefix_len(raw0, raw1))
    check("stored payload scrubbed", "secret" not in rows[0][1] and '"token":"REDACTED"' in rows[0][1])


class _FakeWsMsg:
    def __init__(self, from_client, obj):
        self.from_client = from_client
        self.content = json.dumps(obj).encode("utf-8")


class _FakeWs:
    def __init__(self):
        self.messages = []


class _FakeReq:
    pretty_host = "api.githubcopilot.com"
    path = "/responses"

    class headers:
        @staticmethod
        def items(multi=True):
            return []


class _FakeResp:
    status_code = 101


class _FakeWsFlow:
    def __init__(self):
        self.id = "flow-ws-1"
        self.request = _FakeReq()
        self.response = _FakeResp()
        self.websocket = _FakeWs()

    def push(self, from_client, obj):
        self.websocket.messages.append(_FakeWsMsg(from_client, obj))


def test_responses_ws_incremental():
    """websocket_message flushes each Responses turn as it completes; websocket_end must not
    re-store turns already captured incrementally."""
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    def mk():
        c = sqlite3.connect(path, timeout=30)
        c.executescript(addon.SCHEMA)
        return c

    orig_connect, orig_sid = addon._connect, addon._current_session_id
    addon._connect = mk
    addon._current_session_id = lambda: "s-ws"
    addon._WS_STATE.clear()

    def sel():
        c = mk()
        try:
            return c.execute("SELECT COUNT(*) FROM turns WHERE session_id='s-ws'").fetchone()[0]
        finally:
            c.close()
    try:
        flow = _FakeWsFlow()

        flow.push(True, {"type": "response.create", "model": "gpt-5.4", "agent_task_id": "T1",
                         "input": [{"type": "message", "role": "user", "content": "hi"}]})
        addon.websocket_message(flow)
        after_create = sel()

        flow.push(False, {"type": "response.output_text.delta", "delta": "ok"})
        addon.websocket_message(flow)
        flow.push(False, {"type": "response.completed", "response": {"status": "completed"}})
        addon.websocket_message(flow)
        after_turn0 = sel()

        flow.push(True, {"type": "response.create", "model": "gpt-5.4", "agent_task_id": "T1",
                         "input": [{"type": "message", "role": "user", "content": "more"}]})
        addon.websocket_message(flow)
        flow.push(False, {"type": "response.completed", "response": {"status": "completed"}})
        addon.websocket_message(flow)
        after_turn1 = sel()

        addon.websocket_end(flow)
        after_end = sel()

        check("ws create alone stores nothing", after_create == 0)
        check("ws turn0 flushed on completed", after_turn0 == 1)
        check("ws turn1 flushed on completed", after_turn1 == 2)
        check("ws end does not duplicate", after_end == 2)
        c = mk()
        try:
            ctx = c.execute("SELECT COUNT(*) FROM contexts WHERE session_id='s-ws'").fetchone()[0]
            idx = [r[0] for r in c.execute(
                "SELECT turn_index FROM turns WHERE session_id='s-ws' ORDER BY id")]
            byte_rows = c.execute(
                "SELECT request_payload_bytes, common_prefix_bytes, request_payload_text "
                "FROM turns WHERE session_id='s-ws' ORDER BY id"
            ).fetchall()
        finally:
            c.close()
        check("ws same agent_task_id threads one context", ctx == 1)
        check("ws turn indices increment", idx == [0, 1])
        check("ws first turn total bytes stored", byte_rows[0][0] > 0)
        check("ws second turn prefix bytes stored", byte_rows[1][1] is not None and byte_rows[1][1] > 0)
        check("ws payload text stored", '"type":"response.create"' in byte_rows[0][2])
    finally:
        addon._connect, addon._current_session_id = orig_connect, orig_sid
        addon._WS_STATE.clear()
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(path + suffix)
            except OSError:
                pass


def test_responses_ws_end_fallback():
    """When websocket_message never ran (all frames only available at close), websocket_end still
    reconstructs every turn from the full frame history."""
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    def mk():
        c = sqlite3.connect(path, timeout=30)
        c.executescript(addon.SCHEMA)
        return c

    orig_connect, orig_sid = addon._connect, addon._current_session_id
    addon._connect = mk
    addon._current_session_id = lambda: "s-ws2"
    addon._WS_STATE.clear()
    try:
        flow = _FakeWsFlow()
        flow.id = "flow-ws-2"
        flow.push(True, {"type": "response.create", "model": "gpt-5.4", "agent_task_id": "T9",
                         "input": [{"type": "message", "role": "user", "content": "hi"}]})
        flow.push(False, {"type": "response.completed", "response": {"status": "completed"}})
        addon.websocket_end(flow)  # no prior websocket_message calls
        c = mk()
        try:
            n = c.execute("SELECT COUNT(*) FROM turns WHERE session_id='s-ws2'").fetchone()[0]
        finally:
            c.close()
        check("ws end fallback reconstructs turns", n == 1)
    finally:
        addon._connect, addon._current_session_id = orig_connect, orig_sid
        addon._WS_STATE.clear()
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(path + suffix)
            except OSError:
                pass


if __name__ == "__main__":
    test_sse()
    test_json()
    test_redaction()
    test_payload_scrub()
    test_threading()
    test_canonical()
    test_anthropic_sse()
    test_anthropic_request_normalize()
    test_responses_request_normalize()
    test_responses_frames()
    test_responses_completed_output()
    test_responses_toolcall_dedup()
    test_responses_threading()
    test_store_turn_payload_metrics()
    test_responses_ws_incremental()
    test_responses_ws_end_fallback()
    print()
    if check.failed:
        print(f"{check.failed} check(s) FAILED")
        sys.exit(1)
    print("All checks passed")
