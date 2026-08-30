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


if __name__ == "__main__":
    test_sse()
    test_json()
    test_redaction()
    test_threading()
    test_canonical()
    print()
    if check.failed:
        print(f"{check.failed} check(s) FAILED")
        sys.exit(1)
    print("All checks passed")
