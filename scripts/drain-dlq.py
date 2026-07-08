#!/usr/bin/env python3
"""Drain mem::compress DLQ by snapshotting then discarding messages.

Phase 1.3 of the agentmemory improvement plan. The DLQ accumulated
~5500 messages from the 7/4-7/7 schema-lock/timeout disaster. We:

1. Page through DLQ messages via engine::queue::dlq_messages
2. Snapshot each batch to ~/.agentmemory/dlq-snapshots/<ts>.jsonl
   (audit trail — recoverable if we ever need them back)
3. Call iii::queue::discard_message for each id

Idempotent: discard_message is a no-op for unknown ids, so re-runs
are safe. We snapshot BEFORE discarding, so even if the script
crashes mid-way we have a record.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

III_BIN = os.environ.get("III_BIN", "/home/duguex/.agentmemory/bin/iii")
QUEUE = "mem::compress"
SNAPSHOT_DIR = Path.home() / ".agentmemory" / "dlq-snapshots"
PAGE_SIZE = 200
DRAIN_CONCURRENCY = 4
RPS_BUDGET = 20  # discard_message calls per second


def call_iii(fn, payload, retries=3):
    for i in range(retries):
        try:
            r = subprocess.run(
                [III_BIN, "trigger", "--function-id", fn, "--payload", json.dumps(payload)],
                capture_output=True, text=True, timeout=30,
            )
            if r.returncode == 0 and "Timed out" not in r.stderr:
                return json.loads(r.stdout)
        except Exception as e:
            if i == retries - 1:
                return {"error": str(e)[:200]}
        time.sleep(0.5 * (i + 1))
    return {"error": "max_retries"}


def topic_stats():
    r = call_iii("engine::queue::topic_stats", {"topic": QUEUE})
    if not isinstance(r, dict):
        raise RuntimeError(f"topic_stats returned non-dict: {r}")
    return r


def page_dlq(offset, limit):
    r = call_iii("engine::queue::dlq_messages", {
        "topic": QUEUE,
        "limit": limit,
        "offset": offset,
    })
    return r if isinstance(r, list) else []


def discard(msg_id):
    r = call_iii("iii::queue::discard_message", {
        "queue": QUEUE,
        "message_id": msg_id,
    })
    return r.get("redriven", 0) if isinstance(r, dict) else 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true",
                        help="Snapshot only, do not discard")
    parser.add_argument("--limit", type=int, default=None,
                        help="Max messages to process (for testing)")
    parser.add_argument("--batch-size", type=int, default=PAGE_SIZE)
    args = parser.parse_args()

    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    snapshot_path = SNAPSHOT_DIR / f"{ts}.jsonl"
    print(f"=== drain-dlq ===")
    print(f"snapshot: {snapshot_path}")

    stats_before = topic_stats()
    target = stats_before["dlq_depth"]
    if args.limit:
        target = min(target, args.limit)
    print(f"queue state: depth={stats_before['depth']} dlq_depth={target}")

    if target == 0:
        print("DLQ already empty.")
        return

    discarded = 0
    snapshotted = 0
    errors = 0
    start = time.time()
    offset = 0
    last_report = start
    rps_window_start = start
    rps_window_count = 0

    while discarded + errors < target:
        page = page_dlq(offset, args.batch_size)
        if not page:
            break

        # 1. Snapshot first
        with open(snapshot_path, "a") as f:
            for m in page:
                f.write(json.dumps(m, ensure_ascii=False) + "\n")
                snapshotted += 1

        # 2. Discard (skip if dry-run)
        if args.dry_run:
            discarded += len(page)
            print(f"  [dry-run] skipped discard for {len(page)} ids")
        else:
            for m in page:
                n = discard(m["id"])
                discarded += n
                rps_window_count += 1
                # Rate limit
                if rps_window_count >= RPS_BUDGET:
                    elapsed = time.time() - rps_window_start
                    if elapsed < 1.0:
                        time.sleep(1.0 - elapsed)
                    rps_window_start = time.time()
                    rps_window_count = 0

        offset += len(page)
        now = time.time()
        if now - last_report > 5:
            rate = discarded / (now - start) if now > start else 0
            print(f"  progress: discarded={discarded}/{target} snapshotted={snapshotted} "
                  f"errors={errors} rate={rate:.1f}/s elapsed={now-start:.0f}s")
            last_report = now

        if args.limit and discarded >= args.limit:
            break

    elapsed = time.time() - start
    print(f"\nDone: discarded={discarded} snapshotted={snapshotted} errors={errors} "
          f"in {elapsed:.1f}s ({discarded/elapsed:.1f}/s)")

    if not args.dry_run:
        stats_after = topic_stats()
        print(f"queue state after: depth={stats_after['depth']} dlq_depth={stats_after['dlq_depth']}")


if __name__ == "__main__":
    main()
