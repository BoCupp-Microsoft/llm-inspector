"""Seed sessions/tracer.db with a synthetic session (main agent + one sub-agent).

Used to verify the server queries, diff view, and live WebSocket push without a real
Copilot run. Reuses the real threading + insert path (store_turn), so it exercises the
same code as live capture.

Usage: python scripts/seed_synthetic.py [session_id]
"""

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "mitm"))
import capture_addon as addon  # noqa: E402


def parsed(text, finish="stop", usage=None):
    return {"content": text, "tool_calls": [], "usage": usage, "finish_reason": finish}


def meta(i):
    return {
        "flow_id": f"seed-{i}",
        "host": "api.githubcopilot.com",
        "path": "/chat/completions",
        "method": "POST",
        "status_code": 200,
        "duration_ms": 1200 + i * 100,
        "headers": {"authorization": "REDACTED", "content-type": "application/json"},
    }


def main():
    session_id = sys.argv[1] if len(sys.argv) > 1 else f"synthetic-{int(time.time())}"
    conn = addon._connect()
    i = 0

    main_sys = {"role": "system", "content": "You are the MAIN agent.\nBe concise."}
    history = [main_sys, {"role": "user", "content": "List files in the repo."}]
    for step in range(3):
        req = {"model": "claude-opus-4.8", "stream": True, "temperature": 0.2, "messages": list(history)}
        addon.store_turn(conn, session_id, req, parsed(f"main answer {step}"), meta(i))
        i += 1
        # grow the conversation (append-heavy, like a real agent loop)
        history.append({"role": "assistant", "content": f"main answer {step}"})
        history.append({"role": "user", "content": f"Now do follow-up {step + 1} with more detail."})

    # Sub-agent: different system prompt -> separate context/lineage.
    sub_sys = {"role": "system", "content": "You are a SUB-agent spawned to explore the codebase."}
    sub_hist = [sub_sys, {"role": "user", "content": "Find all TODO comments."}]
    for step in range(2):
        req = {"model": "claude-opus-4.8", "stream": True, "temperature": 0.0, "messages": list(sub_hist)}
        addon.store_turn(conn, session_id, req, parsed(f"sub result {step}", finish="tool_calls"), meta(i))
        i += 1
        sub_hist.append({"role": "assistant", "content": f"sub result {step}"})
        sub_hist.append({"role": "user", "content": f"Keep going, iteration {step + 1}."})

    conn.close()
    print(f"Seeded session {session_id}: 5 turns across 2 contexts into {addon.DB_PATH}")


if __name__ == "__main__":
    main()
