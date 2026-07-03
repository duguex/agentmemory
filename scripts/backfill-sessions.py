#!/usr/bin/env python3
"""
Backfill old OMP sessions into agentmemory — v2.

Reads session JSONL files from ~/.omp/agent/sessions/ and sends each
conversation turn as an observation to agentmemory's observe API.

Improvements over v1:
  - Real timestamps from original JSONL entries (not utcnow)
  - Real cwd from session metadata (not hardcoded)
  - Full original session ID for traceability (not truncated)
  - Better project detection from cwd
  - Larger/more appropriate truncation limits
  - Proper handling of toolCalls in assistant messages
  - Proper matching of toolResults to toolCalls by toolCallId
  - Correct role detection (toolResult, not tool_result)
  - Faster batch processing
  - Progress reporting with times

Usage:
  export AGENTMEMORY_SECRET=omp-memory-local
  python3 backfill-sessions.py [--dry-run] [--project FILTER] [--limit N]
"""

import json
import os
import sys
import time
import glob
from datetime import datetime, timezone
from pathlib import Path

import requests
_http_session: requests.Session | None = None

AGENTMEMORY_URL = os.environ.get("AGENTMEMORY_URL", "http://localhost:3111")
AGENTMEMORY_SECRET = os.environ.get("AGENTMEMORY_SECRET", "")
SESSIONS_DIR = os.path.expanduser("~/.omp/agent/sessions")

# Per-observation content limits (these go through MiniMax compression;
# longer text → more accurate summaries, but larger payloads)
MAX_TOOL_INPUT = 3000       # user prompt text
MAX_TOOL_OUTPUT = 12000     # combined tool calls + assistant text
MAX_TOOL_CALL_INPUT = 1000  # individual tool call input
MAX_TOOL_CALL_OUTPUT = 4000 # individual tool call output/results


def auth_headers():
    h = {"Content-Type": "application/json"}
    if AGENTMEMORY_SECRET:
        h["Authorization"] = f"Bearer {AGENTMEMORY_SECRET}"
    return h


def api_post(path, body):
    global _http_session
    if _http_session is None:
        _http_session = requests.Session()
    url = f"{AGENTMEMORY_URL.rstrip('/')}/agentmemory/{path}"
    try:
        r = _http_session.post(url, headers=auth_headers(), json=body, timeout=15)
        return r.ok
    except Exception as e:
        print(f"  [error] {e}")
        return False


def truncate(s, max_len):
    """Truncate string to max_len bytes without breaking UTF-8."""
    if not s or len(s) <= max_len:
        return s
    encoded = s.encode("utf-8")[:max_len]
    # Decode back, dropping any partial multi-byte character
    return encoded.decode("utf-8", errors="ignore")


def get_text_from_content(content_parts):
    """Extract text from a content array (text/thinking/toolCall/toolResult parts)."""
    if isinstance(content_parts, str):
        return content_parts
    texts = []
    for part in content_parts if isinstance(content_parts, list) else []:
        if isinstance(part, dict) and part.get("text"):
            texts.append(part["text"])
    return "\n".join(texts)


def project_from_cwd(cwd):
    """Derive a meaningful project name from the session cwd path.
    
    Heuristic:
      - Look for known project roots in the path
      - Fall back to the deepest meaningful directory name
    """
    if not cwd:
        return "unknown"
    
    parts = cwd.strip("/").split("/")
    
    # Detect project root keywords (case-insensitive)
    known_roots = {"vasp", "vasp_sop", "calc", "paper", "crisp", "omp", "agentmemory", "memory"}
    for p in reversed(parts):
        if p.lower() in known_roots:
            return p
    
    # Fallback: find a reasonable project name
    # Skip common machine path prefixes
    skip = {"home", "mnt", "shared", "2sidesniddle", "root", "tmp", "var"}
    for p in reversed(parts):
        if p.lower() not in skip:
            return p
    
    # Last resort: use the last path component
    return parts[-1] if parts else "unknown"


def parse_session(filepath):
    """Parse session JSONL into structured session metadata and conversation turns.
    
    Returns: (session_meta, turns)
      session_meta: {id, cwd, timestamp, project}
      turns: [{user_text, user_ts, assistant_text, assistant_ts, tools: [{name, input, output, error}]}]
    """
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        entries = []
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    
    if not entries:
        return None, []

    # Parse session metadata from first line. The first JSONL line is
    # sometimes a header that isn't a dict (e.g. an array preamble), so
    # walk past non-dict entries before treating one as metadata.
    meta_entry = next((e for e in entries if isinstance(e, dict)), None)
    if meta_entry is None:
        return None, []

    session_id = meta_entry.get("id", Path(filepath).stem[:36])
    session_cwd = meta_entry.get("cwd", "")
    session_ts = meta_entry.get("timestamp", "")
    project = project_from_cwd(session_cwd)
    
    session_meta = {
        "id": session_id,
        "cwd": session_cwd,
        "timestamp": session_ts,
        "project": project,
    }
    
    # Parse entries into a timeline of actions
    # Each action is either:
    #   - {"type": "user", "text", "timestamp"}
    #   - {"type": "tool_call", "name", "input", "id", "assistant_ts", "assistant_text"}
    #   - {"type": "tool_result", "name", "id", "output", "error", "timestamp"}
    timeline = []
    pending_tool_calls = {}  # id -> tool_call action

    for entry in entries[1:]:
        if not isinstance(entry, dict):
            continue
        
        if entry.get("type") != "message":
            continue
        
        msg = entry.get("message", {})
        role = msg.get("role", "")
        ts = entry.get("timestamp", "")
        
        if role == "user":
            text = get_text_from_content(msg.get("content", ""))
            if text.strip():
                timeline.append({"type": "user", "text": text.strip(), "timestamp": ts})
        
        elif role == "assistant":
            text = get_text_from_content(msg.get("content", ""))
            # Parse tool calls from content array (OMP JSONL schema)
            tool_calls = []
            for part in msg.get("content", []):
                if isinstance(part, dict) and part.get("type") == "toolCall":
                    inp = json.dumps(part.get("arguments", {}), ensure_ascii=False)
                    tool_calls.append({
                        "type": "tool_call",
                        "name": part.get("name", "unknown"),
                        "input": inp,
                        "id": part.get("id"),
                        "assistant_ts": ts,
                        "assistant_text": text,
                    })
            if tool_calls:
                for tc in tool_calls:
                    if tc["id"]:
                        pending_tool_calls[tc["id"]] = tc
            else:
                # Plain assistant message (no tools) — treat as the assistant response
                timeline.append({"type": "assistant_text", "text": text, "timestamp": ts})
        
        elif role == "tool_result" or role == "toolResult":
            text = get_text_from_content(msg.get("content", ""))
            tid = msg.get("toolCallId") or msg.get("id")
            tn = msg.get("toolName", "unknown")
            is_err = msg.get("isError", False)
            
            if tid and tid in pending_tool_calls:
                tc_action = pending_tool_calls.pop(tid)
                tc_action["output"] = text
                tc_action["error"] = is_err
                tc_action["tool_result_ts"] = ts
                timeline.append(tc_action)
            else:
                # Orphaned tool result — attach to any unmatched pending call
                timeline.append({
                    "type": "tool_result",
                    "name": tn,
                    "id": tid,
                    "output": text,
                    "error": is_err,
                    "timestamp": ts,
                })
        
        elif role == "tool_result_error":
            text = get_text_from_content(msg.get("content", ""))
            tid = msg.get("toolCallId") or msg.get("id")
            tn = msg.get("toolName", "unknown")
            if tid and tid in pending_tool_calls:
                tc_action = pending_tool_calls.pop(tid)
                tc_action["output"] = text
                tc_action["error"] = True
                tc_action["tool_result_ts"] = ts
                timeline.append(tc_action)
    
    # Any pending (unmatched) tool calls — add as-is
    for tid, tc_action in pending_tool_calls.items():
        timeline.append(tc_action)
    
    # Group timeline into conversation turns:
    # A turn = user message → tool calls → assistant response
    turns = []
    current = {"user_text": "", "user_ts": "", "tools": [], "assistant_text": "", "assistant_ts": ""}
    
    for action in timeline:
        if action["type"] == "user":
            # Save current turn and start new one
            if current["user_text"] or current["tools"] or current["assistant_text"]:
                turns.append(current)
            current = {"user_text": action["text"], "user_ts": action["timestamp"], 
                       "tools": [], "assistant_text": "", "assistant_ts": ""}
        
        elif action["type"] in ("tool_call", "tool_result"):
            current["tools"].append({
                "name": action.get("name", "unknown"),
                "input": truncate(action.get("input", ""), MAX_TOOL_CALL_INPUT),
                "output": truncate(action.get("output", ""), MAX_TOOL_CALL_OUTPUT),
                "error": action.get("error", False),
                "ts": action.get("tool_result_ts") or action.get("assistant_ts") or "",
                "assistant_text": action.get("assistant_text", ""),
            })
            if action.get("assistant_text"):
                current["assistant_text"] = action["assistant_text"]
            if action.get("assistant_ts"):
                current["assistant_ts"] = action["assistant_ts"]
        
        elif action["type"] == "assistant_text":
            current["assistant_text"] = action["text"]
            current["assistant_ts"] = action["timestamp"]
    
    if current["user_text"] or current["tools"] or current["assistant_text"]:
        turns.append(current)
    
    return session_meta, turns


def main():
    dry_run = "--dry-run" in sys.argv
    limit = None
    project_filter = None
    
    for arg in sys.argv[1:]:
        if arg.startswith("--project="):
            project_filter = arg.split("=", 1)[1].lower()
        elif arg.startswith("--limit="):
            try:
                limit = int(arg.split("=", 1)[1])
            except (ValueError, IndexError):
                print(f"Error: --limit requires a positive integer, got '{arg.split('=', 1)[1] if '=' in arg else ''}'")
                sys.exit(1)
    
    if not AGENTMEMORY_SECRET:
        print("Warning: AGENTMEMORY_SECRET not set, server may reject requests")
    
    # Find session files
    session_files = []
    for session_dir in sorted(glob.glob(os.path.join(SESSIONS_DIR, "-*/"))):
        for f in sorted(glob.glob(os.path.join(session_dir, "*.jsonl"))):
            session_files.append(f)
    
    if limit:
        session_files = session_files[:limit]
    
    print(f"Found {len(session_files)} session files")
    if project_filter:
        print(f"Filter: project containing \"{project_filter}\"")
    if dry_run:
        print("Dry run - no data sent")
    print()
    
    total_sent = 0
    total_turns = 0
    skipped_sessions = 0
    start_wall = time.monotonic()
    
    projects = {}
    for i, fpath in enumerate(session_files):
        session_meta, turns = parse_session(fpath)
        
        if not session_meta or not turns:
            skipped_sessions += 1
            continue
        
        # Apply project filter
        if project_filter and project_filter not in session_meta["project"].lower():
            skipped_sessions += 1
            continue
        projects[session_meta["project"]] = projects.get(session_meta["project"], 0) + len(turns)
        
        if dry_run:
            total_turns += len(turns)
            total_sent += len(turns)
            elapsed = time.monotonic() - start_wall
            print(f"  [{i+1:4d}/{len(session_files)}] {session_meta['project']:20s} "
                  f"{session_meta['id'][:12]}  {len(turns):3d} turns")
            continue
        
        for turn in turns:
            if not turn["user_text"] and not turn["tools"]:
                continue
            
            total_turns += 1

            # Use the original user message timestamp if available, else session start
            obs_ts = turn["user_ts"] or session_meta["timestamp"]
            # Normalize to RFC 3339
            if obs_ts:
                try:
                    obs_ts = datetime.fromisoformat(obs_ts.replace("Z", "+00:00")).isoformat()
                except (ValueError, TypeError):
                    obs_ts = datetime.now(timezone.utc).isoformat()
            else:
                obs_ts = datetime.now(timezone.utc).isoformat()

            base_payload = {
                "sessionId": f"backfill-{session_meta['id']}",
                "project": session_meta["project"],
                "cwd": session_meta["cwd"],
            }

            # 1. Emit the user prompt as its own conversation observation so
            #    search hits the prompt text directly.
            if turn["user_text"]:
                ok = api_post("observe", {
                    **base_payload,
                    "hookType": "prompt_submit",
                    "timestamp": obs_ts,
                    "data": {
                        "prompt": truncate(turn["user_text"], MAX_TOOL_INPUT),
                    },
                })
                if ok:
                    total_sent += 1

            # 2. Emit ONE observation per tool call so each tool is
            #    individually compressed and indexed. Earlier this code
            #    flattened all tools into a single JSON-encoded tool_output
            #    blob, which made smart-search miss 7 of 8 tools in a turn
            #    (defeating the purpose of backfill).
            for idx, t in enumerate(turn["tools"][:8]):
                tool_ts = t.get("ts") or obs_ts
                if tool_ts:
                    try:
                        tool_ts = datetime.fromisoformat(tool_ts.replace("Z", "+00:00")).isoformat()
                    except (ValueError, TypeError):
                        tool_ts = obs_ts
                hook_type = "post_tool_failure" if t.get("error") else "post_tool_use"
                ok = api_post("observe", {
                    **base_payload,
                    "hookType": hook_type,
                    "timestamp": tool_ts,
                    "data": {
                        "tool_name": t["name"],
                        "tool_input": truncate(t.get("input", ""), MAX_TOOL_CALL_INPUT),
                        "tool_output": truncate(t.get("output", ""), MAX_TOOL_CALL_OUTPUT),
                        "assistant_text": truncate(turn["assistant_text"], MAX_TOOL_OUTPUT // 2),
                    },
                })
                if ok:
                    total_sent += 1

            # 3. Emit the trailing assistant message (no tools after it) as
            #    a prompt_submit observation tagged "conversation" so the
            #    observe handler routes it through the same path as live
            #    user prompts.
            if turn["assistant_text"] and not turn["tools"]:
                ok = api_post("observe", {
                    **base_payload,
                    "hookType": "prompt_submit",
                    "timestamp": obs_ts,
                    "data": {
                        "prompt": truncate(turn["assistant_text"], MAX_TOOL_OUTPUT),
                        "tool_name": "conversation",
                    },
                })
                if ok:
                    total_sent += 1
        
        elapsed = time.monotonic() - start_wall
        print(f"  [{i+1:4d}/{len(session_files)}] {session_meta['project']:20s} "
              f"turns={len(turns):3d} sent={total_sent}  ({elapsed:.0f}s)")
        
        # Small delay between sessions to avoid hammering the server
        if not dry_run and (i + 1) % 5 == 0:
            time.sleep(0.3)
    
    elapsed = time.monotonic() - start_wall
    print()
    if dry_run:
        print(f"Would backfill {total_sent} turns from {len(session_files) - skipped_sessions} sessions "
              f"({skipped_sessions} skipped) — estimate {elapsed:.0f}s dry run")
    else:
        print(f"Backfilled {total_sent} turns from {len(session_files) - skipped_sessions} sessions "
              f"({skipped_sessions} skipped) in {elapsed:.0f}s")
    
    print()
    print("Per-project summary:")
    for p, count in sorted(projects.items(), key=lambda x: -x[1]):
        print(f"  {p:20s} {count:5d} turns")
        


if __name__ == "__main__":
    main()