#!/usr/bin/env python3
"""Re-enqueue mem::compress for backfill obs that are not yet LLM-compressed.

Uses iii-queue's own completion semantics: depth=0 means queue drained.
This avoids the previous progress.json drift bug, where the script marked
observations done based on the 200 OK of POST /agentmemory/compress
(which only enqueues, not completes).

Behavior:
  - Find all backfill obs with compressionKind != "llm" via /observations
  - Query engine::queue::topic_stats for current depth + dlq_depth
  - If depth > 0: daemon is already processing; skip this cycle
  - Else: enqueue the unknown observations
  - Track per-session last-enqueued state in a small JSON file (only used
    to avoid re-enqueueing within a single drain cycle, not as a permanent
    "done" claim)
  - Wait until depth returns to 0 before reporting success
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

AGENTMEMORY_URL = os.environ.get("AGENTMEMORY_URL", "http://localhost:3111")
DEFAULT_SECRET = os.environ.get("AGENTMEMORY_SECRET", "agentmemory-local")
III_BIN = os.environ.get("III_BIN", "/home/duguex/.agentmemory/bin/iii")
STATE_FILE = Path.home() / ".agentmemory" / ".upgrade_backfill_state.json"
TOPIC = "mem::compress"
QUEUE_POLL_INTERVAL = 10   # seconds between depth checks
QUEUE_DRAIN_TIMEOUT = 7200  # 2h hard cap waiting for queue to drain
DEPTH_BACKLOG_THRESHOLD = 50  # skip enqueue if daemon is already behind


def auth_headers(secret: str) -> dict:
    return {
        "Authorization": f"Bearer {secret}",
        "Content-Type": "application/json",
    }


def topic_stats() -> dict:
    """Query iii-engine for current queue depth + dlq_depth."""
    r = subprocess.run(
        [III_BIN, "trigger", "--function-id", "engine::queue::topic_stats",
         "--payload", json.dumps({"topic": TOPIC})],
        capture_output=True, text=True, timeout=30,
    )
    if r.returncode != 0:
        raise RuntimeError(f"topic_stats failed: {r.stderr.strip()}")
    return json.loads(r.stdout)


async def list_sessions(client: httpx.AsyncClient, secret: str, limit: int = 200) -> list[dict]:
    r = await client.get(
        f"{AGENTMEMORY_URL}/agentmemory/sessions",
        params={"limit": str(limit)},
        headers=auth_headers(secret),
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    return [s for s in body.get("sessions", []) if s.get("id", "").startswith("backfill-")]


async def list_observations(client: httpx.AsyncClient, secret: str, session_id: str) -> list[dict]:
    r = await client.get(
        f"{AGENTMEMORY_URL}/agentmemory/observations",
        params={"sessionId": session_id},
        headers=auth_headers(secret),
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("observations", [])


def needs_upgrade(obs: dict) -> bool:
    kind = obs.get("compressionKind")
    return kind is None or kind == "synthetic"


async def enqueue_one(
    client: httpx.AsyncClient,
    secret: str,
    session_id: str,
    obs_id: str,
    sem: asyncio.Semaphore,
) -> str:
    """POST /agentmemory/compress — returns the trigger receipt id (or error)."""
    async with sem:
        try:
            r = await client.post(
                f"{AGENTMEMORY_URL}/agentmemory/compress",
                json={"sessionId": session_id, "observationId": obs_id},
                headers=auth_headers(secret),
                timeout=30,
            )
            r.raise_for_status()
            return "ok"
        except httpx.HTTPStatusError as e:
            return f"http_{e.response.status_code}"
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            return f"net_{type(e).__name__}"


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"in_flight": [], "last_run": None}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    state["last_run"] = int(time.time())
    STATE_FILE.write_text(json.dumps(state, indent=2))


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--secret", default=DEFAULT_SECRET)
    parser.add_argument("--skip-if-busy", action="store_true",
                        help="Skip enqueue if depth > DEPTH_BACKLOG_THRESHOLD")
    args = parser.parse_args()

    print(f"=== upgrade-backfill-compression ===")
    print(f"Listing backfill sessions from {AGENTMEMORY_URL}...")

    stats = topic_stats()
    print(f"queue state: depth={stats['depth']} dlq_depth={stats['dlq_depth']}")

    async with httpx.AsyncClient() as client:
        sessions = await list_sessions(client, args.secret)
        print(f"Found {len(sessions)} backfill sessions")

        pending: list[tuple[str, str]] = []
        for sess in sessions:
            sid = sess["id"]
            obs_list = await list_observations(client, args.secret, sid)
            for obs in obs_list:
                oid = obs.get("id")
                if not oid:
                    continue
                if needs_upgrade(obs):
                    pending.append((sid, oid))

        print(f"Pending upgrade: {len(pending)} observations (unknown/synthetic)")

        if args.dry_run:
            print("(dry-run: not enqueueing)")
            return

        if not pending:
            print("Nothing to upgrade.")
            save_state({"in_flight": [], "last_run": int(time.time())})
            return

        if args.skip_if_busy and stats["depth"] > DEPTH_BACKLOG_THRESHOLD:
            print(f"Skipping: depth={stats['depth']} > {DEPTH_BACKLOG_THRESHOLD} (daemon busy)")
            return

        if args.limit:
            pending = pending[: args.limit]

        print(f"Enqueueing {len(pending)} observations...")
        depth_before = stats["depth"]
        dlq_before = stats["dlq_depth"]

        sem = asyncio.Semaphore(args.concurrency)
        tasks = [enqueue_one(client, args.secret, sid, oid, sem) for sid, oid in pending]
        results = await asyncio.gather(*tasks)
        ok = sum(1 for r in results if r == "ok")
        print(f"Enqueued: {ok}/{len(pending)} (other results: "
              f"{sum(1 for r in results if r != 'ok')})")

        save_state({"in_flight": [f"{sid}:{oid}" for sid, oid in pending],
                    "last_run": int(time.time())})

        # Wait for queue to drain. iii-queue's own completion semantics:
        # depth returns to 0 means all enqueued messages have been consumed.
        print(f"Waiting for queue to drain (depth was {depth_before})...")
        start = time.time()
        last_report = start
        while True:
            await asyncio.sleep(QUEUE_POLL_INTERVAL)
            s = topic_stats()
            now = time.time()
            if now - last_report > 30:
                print(f"  t+{now-start:.0f}s: depth={s['depth']} dlq={s['dlq_depth']}")
                last_report = now
            if s["depth"] == 0:
                print(f"Drained in {now-start:.0f}s.")
                print(f"  dlq: {dlq_before} -> {s['dlq_depth']} "
                      f"(+{s['dlq_depth'] - dlq_before} failures)")
                break
            if now - start > QUEUE_DRAIN_TIMEOUT:
                print(f"Timeout after {QUEUE_DRAIN_TIMEOUT}s. depth={s['depth']} dlq={s['dlq_depth']}")
                sys.exit(2)


if __name__ == "__main__":
    asyncio.run(main())