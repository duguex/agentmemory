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
import re
import sys
import time
import glob
from datetime import datetime, timezone
from pathlib import Path
from collections import OrderedDict

import requests

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
    url = f"{AGENTMEMORY_URL.rstrip('/')}/agentmemory/{path}"
    try:
        r = requests.post(url, headers=auth_headers(), json=body, timeout=15)
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
        lines = [l.strip() for l in f if l.strip()]
    
    if not lines:
        return None, []
    
    # Parse session metadata from first line
    try:
        meta_entry = json.loads(lines[0])
    except json.JSONDecodeError:
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
    current_assistant = None
    
    for line in lines[1:]:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
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
            tc = msg.get("toolCalls", [])
            if tc:
                # There are tool calls — queue them pending their results
                for t in tc:
                    tid = t.get("toolCallId") or t.get("id")
                    if tid:
                        inp = json.dumps(t.get("input", {}), ensure_ascii=False)
                        pending_tool_calls[tid] = {
                            "type": "tool_call",
                            "name": t.get("toolName", "unknown"),
                            "input": inp,
                            "id": tid,
                            "assistant_ts": ts,
                            "assistant_text": text,
                        }
                if not current_assistant:
                    current_assistant = {"text": text, "timestamp": ts}
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
            limit = int(arg.split("=", 1)[1])
    
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
    start_wall = time.time()
    
    for i, fpath in enumerate(session_files):
        session_meta, turns = parse_session(fpath)
        
        if not session_meta or not turns:
            skipped_sessions += 1
            continue
        
        # Apply project filter
        if project_filter and project_filter not in session_meta["project"].lower():
            skipped_sessions += 1
            continue
        
        if dry_run:
            total_turns += len(turns)
            total_sent += len(turns)
            elapsed = time.time() - start_wall
            print(f"  [{i+1:4d}/{len(session_files)}] {session_meta['project']:20s} "
                  f"{session_meta['id'][:12]}  {len(turns):3d} turns")
            continue
        
        for turn in turns:
            if not turn["user_text"] and not turn["tools"]:
                continue
            
            total_turns += 1
            
            # Build tool outputs for the observation
            tool_outputs = []
            for t in turn["tools"][:8]:  # limit to 8 tools per turn
                tool_outputs.append({
                    "name": t["name"],
                    "input": t.get("input", "")[:MAX_TOOL_CALL_INPUT],
                    "output": t.get("output", "")[:MAX_TOOL_CALL_OUTPUT],
                    "error": t.get("error", False),
                })
            
            # Use the original user message timestamp if available, else session start
            obs_ts = turn["user_ts"] or session_meta["timestamp"]
            # Normalize to RFC 3339
            if obs_ts:
                try:
                    obs_ts = datetime.fromisoformat(obs_ts.replace("Z", "+00:00")).isoformat()
                except:
                    obs_ts = datetime.now(timezone.utc).isoformat()
            else:
                obs_ts = datetime.now(timezone.utc).isoformat()
            
            tool_output_json = json.dumps({
                "tools": tool_outputs,
                "assistant": truncate(turn["assistant_text"], MAX_TOOL_OUTPUT // 2),
            }, ensure_ascii=False)
            
            ok = api_post("observe", {
                "hookType": "prompt_submit",
                "sessionId": f"backfill-{session_meta['id'][:20]}",
                "project": session_meta["project"],
                "cwd": session_meta["cwd"],
                "timestamp": obs_ts,
                "data": {
                    "tool_name": "user_prompt",
                    "tool_input": truncate(turn["user_text"], MAX_TOOL_INPUT),
                    "tool_output": truncate(tool_output_json, MAX_TOOL_OUTPUT),
                    "prompt": truncate(turn["user_text"], 500),
                },
            })
            if ok:
                total_sent += 1
        
        elapsed = time.time() - start_wall
        print(f"  [{i+1:4d}/{len(session_files)}] {session_meta['project']:20s} "
              f"turns={len(turns):3d} sent={total_sent}  ({elapsed:.0f}s)")
        
        # Small delay between sessions to avoid hammering the server
        if not dry_run and (i + 1) % 5 == 0:
            time.sleep(0.3)
    
    elapsed = time.time() - start_wall
    print()
    if dry_run:
        print(f"Would backfill {total_sent} turns from {len(session_files) - skipped_sessions} sessions "
              f"({skipped_sessions} skipped) — estimate {elapsed:.0f}s dry run")
    else:
        print(f"Backfilled {total_sent} turns from {len(session_files) - skipped_sessions} sessions "
              f"({skipped_sessions} skipped) in {elapsed:.0f}s")
        
        # Summary stats
        projects = {}
        for fpath in session_files:
            sm, turns = parse_session(fpath)
            if sm:
                p = sm["project"]
                projects[p] = projects.get(p, 0) + len(turns) if turns else projects.get(p, 0)
        print()
        print("Per-project summary:")
        for p, count in sorted(projects.items(), key=lambda x: -x[1]):
            print(f"  {p:20s} {count:5d} turns")


if __name__ == "__main__":
    main()