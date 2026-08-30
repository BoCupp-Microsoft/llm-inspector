"""Unit tests for capture_addon parsing, threading, and redaction.

Run: python mitm/test_addon.py   (mitmproxy must be importable)
"""

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


if __name__ == "__main__":
    test_sse()
    test_json()
    test_redaction()
    test_threading()
    test_canonical()
    test_anthropic_sse()
    test_anthropic_request_normalize()
    test_responses_request_normalize()
    test_responses_frames()
    test_responses_threading()
    print()
    if check.failed:
        print(f"{check.failed} check(s) FAILED")
        sys.exit(1)
    print("All checks passed")
