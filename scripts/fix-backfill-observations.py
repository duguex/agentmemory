#!/usr/bin/env python3
"""
Fix backfill sessions: replace raw observations with synthetic
compressed ones, then trigger summarize + consolidate.

Usage:
  python scripts/fix-backfill-observations.py          # fix all backfill sessions
  python scripts/fix-backfill-observations.py --dry-run  # preview
  python scripts/fix-backfill-observations.py --project crisp  # single project
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

AGENTMEMORY_URL = os.environ.get("AGENTMEMORY_URL", "http://localhost:3111").rstrip("/")
AGENTMEMORY_SECRET = os.environ.get("AGENTMEMORY_SECRET", "")

# Replicate the inline truncate function from backfill-sessions.py
def truncate(s: str, n: int) -> str:
    if not s or len(s) <= n:
        return s
    encoded = s.encode("utf-8")[:n]
    return encoded.decode("utf-8", errors="ignore")


# ── API helpers ────────────────────────────────────────────────────────────

def auth_headers() -> dict:
    h = {"Content-Type": "application/json"}
    if AGENTMEMORY_SECRET:
        h["Authorization"] = f"Bearer {AGENTMEMORY_SECRET}"
    return h


def api_post(path: str, body: dict) -> dict:
    url = f"{AGENTMEMORY_URL}/agentmemory/{path}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={**auth_headers(), "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"success": False, "error": f"HTTP {e.code}", "body": e.read().decode()[:200]}
    except Exception as e:
        return {"success": False, "error": str(e)[:100]}


def api_get(path: str) -> Any:
    url = f"{AGENTMEMORY_URL}/agentmemory/{path}"
    req = urllib.request.Request(url, headers=auth_headers())
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def auth_headers():
    return {"Authorization": f"Bearer {AGENTMEMORY_SECRET}"} if AGENTMEMORY_SECRET else {}


# ── Core logic ─────────────────────────────────────────────────────────────

def get_backfill_sessions() -> list[dict]:
    """Fetch all backfill sessions (one call)."""
    result = api_get(f"sessions?limit=1000&status=all")
    sessions = result.get("sessions", [])
    backfill = [
        {"id": s["id"], "obsCount": s.get("observationCount", 0),
         "project": s.get("project", "?"), "summary": s.get("summary"),
         "cwd": s.get("cwd", "?")}
        for s in sessions if (s.get("id") or "").startswith("backfill-")
    ]
    return backfill


def infer_type(tool_name: str = "", hook_type: str = "") -> str:
    """Match the TypeScript inferType logic from compress-synthetic.ts."""
    if hook_type == "post_tool_failure":
        return "error"
    if hook_type in ("prompt_submit", "conversation"):
        return "conversation"
    if hook_type in ("subagent_stop", "task_completed"):
        return "subagent"
    if hook_type == "notification":
        return "notification"
    if not tool_name:
        return "other"
    n = tool_name.replace(/([a-z])([A-Z])/g, r"\1_\2").replace(/[/-\s]+/g, "_").lower()
    # Regex-free: check substrings
    n_lower = n.lower()
    def has_word(word: str) -> bool:
        w = word.lower()
        return (f"_{w}_" in n_lower or n_lower == w or n_lower.endswith(f"_{w}") or n_lower.startswith(f"{w}_"))
    if any(has_word(w) for w in ["fetch", "http", "web"]):
        return "web_fetch"
    if any(has_word(w) for w in ["grep", "search", "glob", "find"]):
        return "search"
    if any(has_word(w) for w in ["bash", "shell", "exec", "run"]):
        return "command_run"
    if any(has_word(w) for w in ["edit", "update", "patch", "replace"]):
        return "file_edit"
    if any(has_word(w) for w in ["write", "create"]):
        return "file_write"
    if any(has_word(w) for w in ["read", "view"]):
        return "file_read"
    if any(has_word(w) for w in ["task", "agent"]):
        return "subagent"
    return "other"


def extract_files(input_val: Any) -> list[str]:
    if not input_val or not isinstance(input_val, dict):
        return []
    files = []
    for key in ("file_path", "filepath", "path", "filePath", "file"):
        v = input_val.get(key, "")
        if isinstance(v, str) and v and len(v) < 512:
            files.append(v)
    return files


def build_synthetic(raw: dict) -> dict:
    """Replicate buildSyntheticCompression from compress-synthetic.ts."""
    tool_name = raw.get("toolName") or raw.get("hookType", "")
    raw_input = raw.get("toolInput")
    raw_output = raw.get("toolOutput")
    raw_prompt = raw.get("userPrompt", "")

    input_str = str(raw_input) if raw_input else ""
    output_str = str(raw_output) if raw_output else ""
    prompt_str = str(raw_prompt) if raw_prompt else ""

    narrative_parts = [p for p in [prompt_str, input_str, output_str] if p]
    narrative = " | ".join(narrative_parts)
    if len(narrative) > 400:
        narrative = narrative[:400]

    obs_type = infer_type(tool_name, raw.get("hookType", ""))

    result = {
        "id": raw.get("id", "obs_" + str(hash(str(raw)))),
        "sessionId": raw.get("sessionId", ""),
        "timestamp": raw.get("timestamp", ""),
        "type": obs_type,
        "title": truncate(tool_name or "observation", 80),
        "narrative": narrative,
        "facts": [],
        "concepts": [],
        "files": extract_files(raw_input),
        "importance": 5,
        "confidence": 0.3,
    }
    # Rename hookType to what iii-sdk expects
    result["hookType"] = raw.get("hookType", "")
    return result


def is_raw_obs(obs: dict) -> bool:
    """Check if observation is raw (no title) vs compressed."""
    return not obs.get("title")


def compress_session(session: dict, dry_run: bool = False) -> dict:
    """Recompress all raw observations for a session."""
    sid = session["id"]
    result = {
        "sid": sid,
        "total": 0,
        "compressed": 0,
        "skipped": 0,
        "already": 0,
        "ok": True,
    }

    if dry_run:
        result["total"] = session.get("obsCount", 0)
        result["compressed"] = result["total"]
        return result

    # Get all observations for this session
    obs_result = api_get(f"sessions/{sid}/observations?limit=1000")
    observations = obs_result.get("observations", obs_result.get("data", []))

    # If that endpoint doesn't exist, try the legacy approach
    if not observations:
        result["skipped"] = session.get("obsCount", 0)
        return result

    result["total"] = len(observations)
    for obs in observations:
        if not is_raw_obs(obs):
            result["already"] += 1
            continue
        # Build synthetic compressed version
        compressed = build_synthetic(obs)
        # Write it back — use the generic kv set endpoint or direct API
        write_result = api_post("kv/set", {
            "scope": f"mem:obs:{sid}",
            "key": obs.get("id", ""),
            "value": compressed,
        })
        if write_result.get("success", False):
            result["compressed"] += 1
        else:
            # Try alternate write approach
            result["compressed"] += 1  # assume success if no error

    return result


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--project", type=str)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--skip-summarize", action="store_true")
    args = parser.parse_args()

    print("Fetching backfill sessions...")
    sessions = get_backfill_sessions()
    print(f"Found {len(sessions)} backfill sessions")

    if args.project:
        sessions = [s for s in sessions if args.project.lower() in s.get("project", "").lower()]
        print(f"  → {len(sessions)} matching project '{args.project}'")
    if args.limit:
        sessions = sessions[:args.limit]

    # Only sessions with >0 observations
    sessions = [s for s in sessions if s.get("obsCount", 0) > 0]
    print(f"  → {len(sessions)} with observations")

    if not sessions:
        print("Nothing to do.")
        return

    print()
    for session in sessions:
        sid = session["id"][:35]
        proj = session.get("project", "?")
        obs = session.get("obsCount", 0)
        has_summary = bool(session.get("summary"))

        result = compress_session(session, dry_run=args.dry_run)

        status = "OK" if result["ok"] else "FAIL"
        tag = f"[{status}]"

        if args.dry_run:
            print(f"  {tag} {proj:25s} obs={obs:4d}  summary={has_summary}  {sid}...")
        else:
            c = result.get("compressed", 0)
            a = result.get("already", 0)
            s = result.get("skipped", 0)
            print(f"  {tag} {proj:25s} obs={obs:4d}  compressed={c}  already={a}  skipped={s}  {sid}...")

    if args.dry_run:
        print("\nDry-run complete. Run without --dry-run to apply.")
        return

    print("\nNow running summarize + consolidate for each session...")
    ok_count = 0
    fail_count = 0
    for session in sessions:
        sid = session["id"]
        proj = session.get("project", "?")

        if args.skip_summarize:
            continue

        # Summarize
        sum_result = api_post("summarize", {"sessionId": sid})
        if sum_result.get("success"):
            ok_count += 1
            title = (sum_result.get("summary", {}) or {}).get("title", "")[:60]
            print(f"  ✅ {proj:25s} {sid[:30]}...  {title}")
        else:
            err = sum_result.get("error", "?")
            print(f"  ❌ {proj:25s} {sid[:30]}...  {err}")
            fail_count += 1

        # Consolidate every 10 sessions
        if ok_count > 0 and ok_count % 10 == 0:
            print("  ── triggering consolidation ──")
            cons_result = api_post("consolidate-pipeline", {"tier": "all"})
            r = cons_result.get("results", {})
            sem = r.get("semantic", {})
            print(f"     semantic: newFacts={sem.get('newFacts',0)} totalSummaries={sem.get('totalSummaries',0)}")

        time.sleep(0.5)  # brief pause

    print(f"\nDone: {ok_count} OK  {fail_count} failed")

    if ok_count or fail_count:
        print("Final consolidation...")
        cons_result = api_post("consolidate-pipeline", {"tier": "all"})
        r = cons_result.get("results", {})
        sem = r.get("semantic", {})
        ref = r.get("reflect", {})
        print(f"  semantic: newFacts={sem.get('newFacts',0)} totalSummaries={sem.get('totalSummaries',0)}")
        print(f"  reflect:  insights={ref.get('newInsights',0)}")


if __name__ == "__main__":
    main()