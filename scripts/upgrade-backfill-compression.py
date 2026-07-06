#!/usr/bin/env python3
"""Re-enqueue mem::compress for all backfill obs that have compressionKind=synthetic (or missing).

The original backfill pre-dated LLM-compression. After the schema-lock fix
(commit c5a0c84), mem::compress correctly writes compressionKind=llm.
This script invokes POST /agentmemory/compress for every backfill obs that
still has the synthetic marker (or no marker at all), forcing the LLM
upgrade to run on them now.

Concurrency-controlled, with progress file for resume.
"""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import httpx

PROGRESS_FILE = Path.home() / ".agentmemory" / ".upgrade_backfill_progress.json"
DEFAULT_URL = os.environ.get("AGENTMEMORY_URL", "http://localhost:3111")
DEFAULT_SECRET = os.environ.get("AGENTMEMORY_SECRET", "agentmemory-local")


def auth_headers(secret: str) -> dict:
    return {
        "Authorization": f"Bearer {secret}",
        "Content-Type": "application/json",
    }


async def list_sessions(client: httpx.AsyncClient, secret: str, limit: int = 200) -> list[dict]:
    """List all sessions, filter to backfill- prefix."""
    r = await client.get(
        f"{DEFAULT_URL}/agentmemory/sessions",
        params={"limit": str(limit)},
        headers=auth_headers(secret),
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    sessions = body.get("sessions", [])
    return [s for s in sessions if s.get("id", "").startswith("backfill-")]


async def list_observations(
    client: httpx.AsyncClient, secret: str, session_id: str
) -> list[dict]:
    """List all obs in a session."""
    r = await client.get(
        f"{DEFAULT_URL}/agentmemory/observations",
        params={"sessionId": session_id},
        headers=auth_headers(secret),
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("observations", [])


def needs_upgrade(obs: dict) -> bool:
    """An obs needs upgrade if it's synthetic OR has no compressionKind."""
    kind = obs.get("compressionKind")
    return kind is None or kind == "synthetic"


async def enqueue_one(
    client: httpx.AsyncClient,
    secret: str,
    session_id: str,
    obs_id: str,
    sem: asyncio.Semaphore,
) -> str:
    """POST /agentmemory/compress for a single obs."""
    async with sem:
        for attempt in range(3):
            try:
                r = await client.post(
                    f"{DEFAULT_URL}/agentmemory/compress",
                    json={"sessionId": session_id, "observationId": obs_id},
                    headers=auth_headers(secret),
                    timeout=30,
                )
                r.raise_for_status()
                return "ok"
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 429:
                    await asyncio.sleep(2 ** attempt)
                    continue
                return f"http_{e.response.status_code}"
            except (httpx.ConnectError, httpx.TimeoutException):
                await asyncio.sleep(2 ** attempt)
                continue
        return "rate_limited"


def load_progress() -> set:
    if PROGRESS_FILE.exists():
        return set(json.loads(PROGRESS_FILE.read_text()).get("done", []))
    return set()


def save_progress(done: set) -> None:
    PROGRESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS_FILE.write_text(json.dumps({"done": list(done)}, indent=2))


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--concurrency", type=int, default=16)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--secret", default=DEFAULT_SECRET)
    args = parser.parse_args()

    print(f"Listing backfill sessions from {DEFAULT_URL}...")
    async with httpx.AsyncClient() as client:
        sessions = await list_sessions(client, args.secret)
        print(f"Found {len(sessions)} backfill sessions")

        pending: list[tuple[str, str]] = []
        progress = load_progress()
        for sess in sessions:
            sid = sess["id"]
            obs_list = await list_observations(client, args.secret, sid)
            for obs in obs_list:
                oid = obs.get("id")
                if not oid:
                    continue
                if oid in progress:
                    continue
                if needs_upgrade(obs):
                    pending.append((sid, oid))

        if args.limit:
            pending = pending[: args.limit]
        print(f"Pending upgrade: {len(pending)} observations (already done: {len(progress)})")

        if args.dry_run:
            print("(dry-run: not enqueueing)")
            return

        sem = asyncio.Semaphore(args.concurrency)
        tasks = [enqueue_one(client, args.secret, sid, oid, sem) for sid, oid in pending]
        results = await asyncio.gather(*tasks)
        ok = 0
        for (sid, oid), r in zip(pending, results):
            if r == "ok":
                progress.add(oid)
                ok += 1
        save_progress(progress)
        print(f"Enqueued: {ok}/{len(pending)} (saved to {PROGRESS_FILE})")
        print(f"Next run will skip these. Run with --limit=N to process more.")


if __name__ == "__main__":
    asyncio.run(main())
