#!/usr/bin/env python3
"""
Backfill old OMP sessions into agentmemory.

Reads session JSONL files from ~/.omp/agent/sessions/ and sends each
conversation turn as an observation to agentmemory's REST API.

Usage:
  export AGENTMEMORY_SECRET=omp-memory-local
  python3 backfill-sessions.py [--dry-run] [--project FILTER] [--limit N]
"""

import json
import os
import re
import sys
import time
import glob
from datetime import datetime
from pathlib import Path

import requests

AGENTMEMORY_URL = os.environ.get("AGENTMEMORY_URL", "http://localhost:3111")
AGENTMEMORY_SECRET = os.environ.get("AGENTMEMORY_SECRET", "")
SESSIONS_DIR = os.path.expanduser("~/.omp/agent/sessions")
BATCH_DELAY = 0.5
BATCH_SIZE = 10


def auth_headers():
    h = {"Content-Type": "application/json"}
    if AGENTMEMORY_SECRET:
        h["Authorization"] = f"Bearer {AGENTMEMORY_SECRET}"
    return h


def api_post(path, body):
    url = f"{AGENTMEMORY_URL.rstrip('/')}/agentmemory/{path}"
    try:
        r = requests.post(url, headers=auth_headers(), json=body, timeout=10)
        return r.ok
    except Exception as e:
        print(f"  [error] {e}")
        return False


def extract_project(filepath):
    parent = Path(filepath).parent.parent.name
    return parent.lstrip("-")


def extract_session_id(filepath):
    name = Path(filepath).stem
    m = re.search(r"[a-f0-9]{8}-[a-f0-9]{4}-7000-[a-f0-9]{4}-[a-f0-9]{12}", name)
    return m.group() if m else name[:30]


def get_text_content(content_parts):
    """Extract text from a content array (text/thinking/toolCall/toolResult parts)."""
    if isinstance(content_parts, str):
        return content_parts
    texts = []
    for part in content_parts if isinstance(content_parts, list) else []:
        if isinstance(part, dict) and part.get("type") in ("text", "thinking") and part.get("text"):
            texts.append(part["text"])
    return "\n".join(texts)


def parse_session(filepath):
    """Parse session JSONL into conversation turns."""
    turns = []  # Each turn: {user, tools[{name,input,output}], assistant}

    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        messages = []
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Only process message-type entries
            if entry.get("type") != "message":
                continue

            msg = entry.get("message", {})
            if not msg:
                continue

            role = msg.get("role", "")
            content_parts = msg.get("content", [])
            text = get_text_content(content_parts)

            if role == "user":
                if text.strip():
                    messages.append({"role": "user", "text": text.strip()})

            elif role == "assistant":
                # Extract tool calls if any
                tool_calls = msg.get("toolCalls", [])
                messages.append({
                    "role": "assistant",
                    "text": text.strip(),
                    "toolCalls": [
                        {"name": tc.get("toolName", "unknown"),
                         "input": json.dumps(tc.get("input", {}), ensure_ascii=False)[:500]}
                        for tc in tool_calls
                    ] if tool_calls else [],
                })

            elif role == "toolResult":
                # Match to last tool call
                text = text.strip()
                tool_name = msg.get("toolName", "unknown")
                is_error = msg.get("isError", False)
                if messages and messages[-1]["role"] == "assistant":
                    last = messages[-1]
                    if last.get("toolCalls"):
                        # Attach result to the corresponding tool call
                        for tc in last["toolCalls"]:
                            if tc["name"] == tool_name and "output" not in tc:
                                tc["output"] = text[:2000]
                                tc["error"] = is_error
                                break

    # Group messages into turns
    current_turn = None
    for msg in messages:
        if msg["role"] == "user":
            if current_turn:
                turns.append(current_turn)
            current_turn = {"user": msg["text"], "tools": [], "assistant": ""}
        elif msg["role"] == "assistant":
            if current_turn is None:
                current_turn = {"user": "", "tools": [], "assistant": ""}
            current_turn["assistant"] = msg["text"]
            for tc in msg.get("toolCalls", []):
                current_turn["tools"].append(tc)
        elif msg["role"] == "toolResult":
            pass  # Already attached to toolCalls

    if current_turn:
        turns.append(current_turn)

    return turns


def main():
    dry_run = "--dry-run" in sys.argv
    limit = None
    project_filter = None

    for arg in sys.argv[1:]:
        if arg.startswith("--project="):
            project_filter = arg.split("=", 1)[1]
        elif arg.startswith("--limit="):
            limit = int(arg.split("=", 1)[1])

    if not AGENTMEMORY_SECRET:
        print("Warning: AGENTMEMORY_SECRET not set, server may reject requests")

    # Find session files
    session_files = []
    for session_dir in sorted(glob.glob(os.path.join(SESSIONS_DIR, "-*/"))):
        project = session_dir.rstrip("/").split("-", 1)[-1] if "-" in session_dir else ""
        if project_filter and project_filter.lower() not in project.lower():
            continue
        for f in sorted(glob.glob(os.path.join(session_dir, "*.jsonl"))):
            session_files.append(f)

    if limit:
        session_files = session_files[:limit]

    print(f"Found {len(session_files)} session files")
    if project_filter:
        print(f"Filter: {project_filter}")
    if dry_run:
        print("Dry run - no data sent")
    print()

    total_sent = 0
    total_turns = 0
    skipped = 0

    for i, fpath in enumerate(session_files):
        project = extract_project(fpath)
        turns = parse_session(fpath)

        if not turns:
            skipped += 1
            continue

        for turn in turns:
            if not turn["user"] and not turn["tools"]:
                continue

            total_turns += 1

            # Build observation content
            tool_summary = "; ".join(
                [f"{t['name']}({t.get('input','')[:40]})" for t in turn["tools"][:3]]
            )
            if turn["tools"]:
                content = f"[{project}] {turn['user'][:200]} -> {tool_summary}"
            else:
                content = f"[{project}] {turn['user'][:200]}"

            if dry_run:
                total_sent += 1
                continue

            # Build tool output payload
            tool_outputs = []
            for t in turn["tools"]:
                tool_outputs.append({
                    "name": t["name"],
                    "input": t.get("input", "")[:500],
                    "output": t.get("output", "")[:2000],
                    "error": t.get("error", False),
                })

            session_id = extract_session_id(fpath)
            ok = api_post("observe", {
                "hookType": "post_tool_use",
                "sessionId": f"backfill-{session_id[:12]}",
                "project": project,
                "cwd": f"/home/duguex/{project}",
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "data": {
                    "tool_name": "conversation",
                    "tool_input": turn["user"][:500],
                    "tool_output": json.dumps({
                        "tools": tool_outputs[:5],
                        "assistant": turn["assistant"][:2000],
                    }, ensure_ascii=False)[:4000],
                },
            })
            if ok:
                total_sent += 1

        if (i + 1) % 10 == 0 or i == len(session_files) - 1:
            action = "Would send" if dry_run else "Sent"
            pct = (i + 1) / len(session_files) * 100
            print(f"  [{pct:5.1f}%] {action} {total_sent} turns, {skipped} empty sessions")

        if total_turns > 0 and total_turns % BATCH_SIZE == 0:
            time.sleep(BATCH_DELAY)

    print()
    action = "Would backfill" if dry_run else "Backfilled"
    print(f"{action} {total_sent} turns from {len(session_files) - skipped} sessions ({skipped} empty)")


if __name__ == "__main__":
    main()
