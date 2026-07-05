#!/usr/bin/env python3
"""
Batch-summarize all backfill sessions with rate-limit awareness.

Usage:
  python scripts/batch-summarize-backfill.py          # full run
  python scripts/batch-summarize-backfill.py --dry-run  # preview only
  python scripts/batch-summarize-backfill.py --delay 3  # 3s between calls
  python scripts/batch-summarize-backfill.py --concurrency 5  # 5 parallel
  python scripts/batch-summarize-backfill.py --project crisp  # single project

Behavior:
- Skips sessions that already have a summary (idempotent)
- Respects AGENTMEMORY_URL / AGENTMEMORY_SECRET
- Handles 429 (rate limit) with exponential backoff
- Saves progress to ~/.agentmemory/.summarize_progress.json so Ctrl-C is safe
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
from pathlib import Path
from typing import Any

AGENTMEMORY_URL = os.environ.get("AGENTMEMORY_URL", "http://localhost:3111").rstrip("/")
AGENTMEMORY_SECRET = os.environ.get("AGENTMEMORY_SECRET", "")
PROGRESS_FILE = os.path.expanduser("~/.agentmemory/.summarize_progress.json")

# ── helpers ────────────────────────────────────────────────────────────────

def api_get(path: str) -> Any:
    url = f"{AGENTMEMORY_URL}/agentmemory/{path}"
    req = urllib.request.Request(url, headers=auth_headers())
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def api_post(path: str, body: dict) -> dict:
    url = f"{AGENTMEMORY_URL}/agentmemory/{path}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={**auth_headers(), "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())
def auth_headers() -> dict:
    h = {"Content-Type": "application/json"}
    if AGENTMEMORY_SECRET:
        h["Authorization"] = f"Bearer {AGENTMEMORY_SECRET}"
    return h


def get_all_backfill_sessions() -> list[dict]:
    """Fetch all backfill session IDs in a single request."""
    url = f"{AGENTMEMORY_URL}/agentmemory/sessions?limit=1000&status=all"
    req = urllib.request.Request(url, headers=auth_headers())
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    sessions = result.get("sessions", [])
    backfill = [
        {"id": s["id"], "observationCount": s.get("observationCount", 0),
         "project": s.get("project", "?"), "summary": s.get("summary")}
        for s in sessions if (s.get("id") or "").startswith("backfill-")
    ]
    return backfill
def summarize_one(session: dict, dry_run: bool = False) -> dict:
    """Summarize a single session. Returns {sid, ok, skipped, error, title}."""
    sid = session["id"]
    obs_count = session.get("observationCount", 0)

    # Skip sessions with too few observations
    if obs_count < 5:
        return {"sid": sid, "ok": False, "skipped": True, "reason": f"obs={obs_count} < 5"}

    # Skip sessions that already have a summary
    if session.get("summary"):
        return {"sid": sid, "ok": False, "skipped": True, "reason": "already summarized"}

    if dry_run:
        return {"sid": sid, "ok": True, "skipped": False, "title": "(dry-run)", "dry_run": True}

    # Retry with backoff on rate limits
    for attempt in range(3):
        try:
            result = api_post("summarize", {"sessionId": sid})
            if result.get("success"):
                summary = result.get("summary", {})
                return {
                    "sid": sid,
                    "ok": True,
                    "skipped": False,
                    "title": summary.get("title", ""),
                    "concepts": summary.get("concepts", [])[:3],
                    "qualityScore": result.get("qualityScore", 0),
                }
            else:
                err = result.get("error", "unknown")
                return {"sid": sid, "ok": False, "skipped": True, "reason": err}
        except urllib.error.HTTPError as e:
            if e.code == 429:  # rate limited
                wait = 2 ** attempt * 5
                print(f"  Rate limited, waiting {wait}s...", flush=True)
                time.sleep(wait)
                continue
            return {"sid": sid, "ok": False, "skipped": False, "error": f"HTTP {e.code}"}
        except Exception as e:
            if attempt < 2:
                time.sleep(2)
                continue
            return {"sid": sid, "ok": False, "skipped": False, "error": str(e)[:100]}
    return {"sid": sid, "ok": False, "skipped": False, "error": "max retries"}


def load_progress() -> set:
    try:
        with open(PROGRESS_FILE) as f:
            return set(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def save_progress(done: set) -> None:
    os.makedirs(os.path.dirname(PROGRESS_FILE), exist_ok=True)
    with open(PROGRESS_FILE, "w") as f:
        json.dump(sorted(done), f)


# ── main ───────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Batch-summarize backfill sessions")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, no API calls")
    parser.add_argument("--delay", type=float, default=2.0, help="Seconds between calls (default: 2.0)")
    parser.add_argument("--concurrency", type=int, default=1, help="Parallel workers (default: 1)")
    parser.add_argument("--project", type=str, help="Only process sessions for this project")
    parser.add_argument("--limit", type=int, help="Max sessions to process")
    parser.add_argument("--min-obs", type=int, default=5, help="Minimum observation count (default: 5)")
    args = parser.parse_args()

    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))

    print("Fetching backfill sessions...")
    sessions = get_all_backfill_sessions()
    print(f"Found {len(sessions)} backfill sessions")

    # Filter
    if args.project:
        sessions = [s for s in sessions if args.project.lower() in str(s.get("project", "")).lower()]
        print(f"  → {len(sessions)} matching project '{args.project}'")

    # Sort by observation count descending (prioritize rich sessions)
    sessions.sort(key=lambda s: s.get("observationCount", 0), reverse=True)

    done = load_progress()
    pending = [s for s in sessions if s["id"] not in done]
    if args.min_obs:
        pending = [s for s in pending if s.get("observationCount", 0) >= args.min_obs]

    already_done = len(sessions) - len(pending)
    if already_done:
        print(f"  → {already_done} already done, {len(pending)} pending")

    if args.limit:
        pending = pending[:args.limit]
        print(f"  → limited to {len(pending)}")

    if not pending:
        print("Nothing to do.")
        return

    # Estimate
    if args.concurrency > 1:
        est = len(pending) * args.delay / args.concurrency
    else:
        est = len(pending) * args.delay
    print(f"Estimated time: ~{est:.0f}s (~{est/60:.1f}m)")
    print()

    # Process
    ok_count = 0
    skip_count = 0
    fail_count = 0
    start_time = time.monotonic()

    def process_with_delay(session, index):
        nonlocal ok_count, skip_count, fail_count
        if index > 0 and args.concurrency == 1:
            time.sleep(args.delay)

        sid = session["id"]
        obs = session.get("observationCount", 0)
        project = session.get("project", "?")
        result = summarize_one(session, dry_run=args.dry_run)

        if result["ok"]:
            status = "OK"
            title = result.get("title", "")[:60]
            qs = result.get("qualityScore", 0)
            ok_count += 1
            print(f"  [{ok_count+skip_count+fail_count:4d}/{len(pending)}] {status}  {project:20s} obs={obs:4d}  qs={qs:3d}  {title}")
        elif result.get("skipped"):
            reason = result.get("reason", "")
            status = "SKIP"
            skip_count += 1
            if reason not in ("already summarized", "no_observations"):
                print(f"  [{ok_count+skip_count+fail_count:4d}/{len(pending)}] {status}  {project:20s} obs={obs:4d}  {reason}")
        else:
            error = result.get("error", "?")
            fail_count += 1
            print(f"  [{ok_count+skip_count+fail_count:4d}/{len(pending)}] FAIL  {project:20s} {sid[:30]}  {error}")

        done.add(sid)
        return result

    if args.concurrency > 1:
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            futures = {
                pool.submit(process_with_delay, s, i): s
                for i, s in enumerate(pending)
            }
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    print(f"  Worker error: {e}")
    else:
        for i, session in enumerate(pending):
            process_with_delay(session, i)

    elapsed = time.monotonic() - start_time
    save_progress(done)

    print()
    print(f"Done: {ok_count} OK  {skip_count} skipped  {fail_count} failed  ({elapsed:.0f}s)")
    print(f"Total summaries: {ok_count}")
    if ok_count > 0:
        print(f"Next: run consolidation → curl -X POST {AGENTMEMORY_URL}/agentmemory/consolidate-pipeline -d '{{\"tier\":\"all\"}}'")


if __name__ == "__main__":
    main()