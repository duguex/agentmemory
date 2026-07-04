#!/usr/bin/env python3
"""Backfill catch-up: enqueue mem::compress for all synthetic observations.

Phases:
  1. Snapshot: GET all sessions → GET observations → record {obsId, compressionKind, confidence}
  2. Enqueue: POST /agentmemory/compress for each synthetic/legacy observation (concurrency 32, 429 backoff)
  3. Verify: poll every 60s; progress gate = all compressionKind=llm; report = confidence/concepts stats
  4. Catch-up: POST /agentmemory/graph/build + /agentmemory/consolidate-pipeline
"""
import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx

PROGRESS_FILE = Path.home() / ".agentmemory" / ".refine_progress.json"
DEFAULT_URL = os.environ.get("AGENTMEMORY_URL", "http://localhost:3111")
DEFAULT_SECRET = os.environ.get("AGENTMEMORY_SECRET", "agentmemory-local")


def auth_headers(secret: str) -> dict:
    return {"Authorization": f"Bearer {secret}", "Content-Type": "application/json"}


async def list_sessions(client: httpx.AsyncClient, secret: str) -> list[dict]:
    r = await client.get(f"{DEFAULT_URL}/agentmemory/sessions", headers=auth_headers(secret))
    r.raise_for_status()
    # Unwrap the {sessions: [...]} envelope returned by api::sessions; fall
    # back to a bare list shape so older daemon revisions still work.
    body = r.json()
    sessions = body.get("sessions", body) if isinstance(body, dict) else body
    return [s for s in sessions if s.get("id", "").startswith("backfill-") or s.get("project", "").startswith("backfill-")]


async def list_observations(client: httpx.AsyncClient, secret: str, session_id: str) -> list[dict]:
    r = await client.get(f"{DEFAULT_URL}/agentmemory/observations", params={"sessionId": session_id}, headers=auth_headers(secret))
    r.raise_for_status()
    # Unwrap the {observations: [...]} envelope returned by api::observations.
    body = r.json()
    return body.get("observations", body) if isinstance(body, dict) else body


async def post_compress(client: httpx.AsyncClient, secret: str, session_id: str, obs_id: str, sem: asyncio.Semaphore) -> str:
    async with sem:
        for attempt in range(5):
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
                elif e.response.status_code == 400:
                    return "bad_request"
                else:
                    raise
        return "rate_limited"


def load_progress() -> set:
    if PROGRESS_FILE.exists():
        return set(json.loads(PROGRESS_FILE.read_text()).get("done", []))
    return set()


def save_progress(done: set) -> None:
    PROGRESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS_FILE.write_text(json.dumps({"done": list(done)}, indent=2))


async def phase1_snapshot(client: httpx.AsyncClient, secret: str) -> list[dict]:
    sessions = await list_sessions(client, secret)
    pending = []
    for sess in sessions:
        obs_list = await list_observations(client, secret, sess["id"])
        for obs in obs_list:
            kind = obs.get("compressionKind")
            conf = obs.get("confidence")
            # Pending if synthetic or legacy low-confidence (not LLM)
            if kind == "llm":
                continue
            if kind is None and isinstance(conf, (int, float)) and conf >= 0.7:
                continue
            pending.append({"sessionId": sess["id"], "observationId": obs["id"], "kind": kind, "confidence": conf})
    return pending


async def phase2_enqueue(client: httpx.AsyncClient, secret: str, pending: list[dict], concurrency: int, progress: set) -> None:
    sem = asyncio.Semaphore(concurrency)
    todo = [p for p in pending if p["observationId"] not in progress]
    print(f"Enqueueing {len(todo)} observations (concurrency={concurrency})...")
    tasks = [post_compress(client, secret, p["sessionId"], p["observationId"], sem) for p in todo]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for p, r in zip(todo, results):
        if r == "ok":
            progress.add(p["observationId"])
    save_progress(progress)
    print(f"Enqueued: {sum(1 for r in results if r == 'ok')}/{len(todo)}")


async def phase3_verify(client: httpx.AsyncClient, secret: str, pending: list[dict], timeout_min: int = 60) -> None:
    deadline = time.time() + timeout_min * 60
    while time.time() < deadline:
        await asyncio.sleep(60)
        llm_count = 0
        for p in pending[::10]:  # sample 10%
            obs_list = await list_observations(client, secret, p["sessionId"])
            for obs in obs_list:
                if obs["id"] == p["observationId"] and obs.get("compressionKind") == "llm":
                    llm_count += 1
        total = len(pending) // 10
        print(f"Progress sample: {llm_count}/{total} LLM-compressed")
        if llm_count == total:
            print("All sampled observations are LLM-compressed. Done.")
            return
    print(f"Timed out after {timeout_min}min. Check progress manually.")


async def phase4_catchup(client: httpx.AsyncClient, secret: str) -> None:
    for endpoint in ["/agentmemory/graph/build", "/agentmemory/consolidate-pipeline"]:
        r = await client.post(f"{DEFAULT_URL}{endpoint}", headers=auth_headers(secret))
        print(f"POST {endpoint}: {r.status_code}")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--concurrency", type=int, default=32)
    parser.add_argument("--limit", type=int, default=None, help="Limit pending observations")
    parser.add_argument("--timeout-min", type=int, default=60)
    parser.add_argument("--secret", default=DEFAULT_SECRET)
    args = parser.parse_args()

    async with httpx.AsyncClient() as client:
        pending = await phase1_snapshot(client, args.secret)
        if args.limit:
            pending = pending[: args.limit]
        print(f"Pending: {len(pending)} observations")
        if args.dry_run:
            print("(dry-run: not enqueueing)")
            return
        progress = load_progress()
        await phase2_enqueue(client, args.secret, pending, args.concurrency, progress)
        await phase3_verify(client, args.secret, pending, args.timeout_min)
        await phase4_catchup(client, args.secret)


if __name__ == "__main__":
    asyncio.run(main())