#!/usr/bin/env python3
"""Detect and repair stuck mem::compress queue (#72).

Observational finding: stale needs_work jobs (attempts_made=0) have been
observed outside the waiting/active lists after engine restart; the consumer
path for these aged jobs is under investigation (iii 0.11.2).

This tool reclaims stuck disk jobs while the engine is stopped (or with
--allow-live), and is invoked by default from `am-daemon start` when
--check fails (disable: AGENTMEMORY_QUEUE_REPAIR_ON_START=0).

Modes:
  --check      read-only classify; exit 1 when zombie ratio exceeds threshold
               or stale unlisted needs_work jobs are detected
  --repair     backup queue_store, drop confirmed-dead jobs,
               preserve needs_work/orphan in native format;
               does NOT write _queue_lists.bin
  --reenqueue  POST needs_work from manifest, then cleanup old
               job files after compression verified

Env:
  AGENTMEMORY_ROOT   package checkout (default: parent of scripts/)
  AGENTMEMORY_URL    default http://localhost:3111
  AGENTMEMORY_SECRET default omp-memory-local
  QUEUE_ZOMBIE_MIN_JOBS     default 10
  QUEUE_ZOMBIE_RATIO        default 0.4  (dead / total jobs)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ROOT = SCRIPT_DIR.parent

COMPRESS_ACTIVE_KEY = "queue:__fn_queue::mem::compress:active"
COMPRESS_WAITING_KEY = "queue:__fn_queue::mem::compress:waiting"
GRAPH_ACTIVE_KEY = "queue:__fn_queue::mem::graph-extract:active"
MANIFEST_NAME = ".reconcile-needs-work.json"
UNLISTED_NEEDS_WORK_GRACE_SECONDS = 300


@dataclass
class ClassifiedJob:
    path: str
    job_id: str
    observation_id: str
    session_id: str
    attempts_made: int
    status: str  # already_llm | orphan | needs_work | corrupt
    compression_kind: str | None
    age_hours: float | None
    trailing_garbage: bool
    process_at_ms: int | None = None


def parse_json_blob(raw: bytes) -> Any:
    """Parse JSON, tolerant of trailing garbage after the last '}'."""
    t = raw.decode("utf-8", errors="ignore")
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j < 0 or j <= i:
        raise ValueError("no json object")
    return json.loads(t[i : j + 1])


def trailing_garbage(raw: bytes) -> bool:
    j = raw.rfind(b"}")
    if j < 0:
        return True
    # Engine-native files may include rkyv framing bytes after the JSON.
    # We detect trailing non-whitespace bytes but do NOT automatically
    # classify them as corruption requiring repair — the engine's own
    # serialization format is unverified.  parse_json_blob already strips
    # them during classification.  Flagged for informational diagnostics only.
    return bool(raw[j + 1 :].strip(b" \t\r\n"))


def unwrap_job(doc: Any) -> dict[str, Any]:
    if isinstance(doc, dict) and isinstance(doc.get(""), dict):
        return doc[""]
    if isinstance(doc, dict):
        return doc
    raise ValueError("job not a dict")


def index_observation_kinds(state_dir: Path) -> dict[str, str]:
    """Map observationId -> compressionKind from file-based state store."""
    kinds: dict[str, str] = {}
    if not state_dir.is_dir():
        return kinds

    def walk(obj: Any) -> None:
        if isinstance(obj, dict):
            oid = obj.get("observationId") or obj.get("id")
            if isinstance(oid, str) and oid.startswith("obs_"):
                kinds[oid] = str(obj.get("compressionKind") or "none")
            for k, v in obj.items():
                if isinstance(k, str) and k.startswith("obs_") and isinstance(v, dict):
                    kinds[k] = str(v.get("compressionKind") or "none")
                else:
                    walk(v)
        elif isinstance(obj, list):
            for x in obj:
                walk(x)

    for p in state_dir.glob("mem%3Aobs%3A*.bin"):
        try:
            doc = parse_json_blob(p.read_bytes())
        except Exception:
            continue
        walk(doc)
    return kinds


def classify_job(
    path: Path,
    raw: bytes,
    kinds: dict[str, str],
    now_ms: int | None = None,
) -> ClassifiedJob:
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    garbage = trailing_garbage(raw)
    try:
        job = unwrap_job(parse_json_blob(raw))
    except Exception:
        return ClassifiedJob(
            path=str(path),
            job_id="",
            observation_id="",
            session_id="",
            attempts_made=0,
            status="corrupt",
            compression_kind=None,
            age_hours=None,
            trailing_garbage=True,
        )

    data = job.get("data") if isinstance(job.get("data"), dict) else {}
    oid = str(data.get("observationId") or "")
    sid = str(data.get("sessionId") or "")
    jid = str(job.get("id") or "")
    attempts = int(job.get("attempts_made") or 0)
    created = job.get("created_at")
    process_at = job.get("process_at")
    process_at_ms = int(process_at) if isinstance(process_at, (int, float)) else None
    age_h = None
    if isinstance(created, (int, float)) and created > 0:
        age_h = round((now_ms - float(created)) / 3.6e6, 3)

    if not oid:
        return ClassifiedJob(
            path=str(path),
            job_id=jid,
            observation_id=oid,
            session_id=sid,
            attempts_made=attempts,
            status="corrupt",
            compression_kind=None,
            age_hours=age_h,
            trailing_garbage=garbage,
        )

    kind = kinds.get(oid)
    if kind is None:
        status = "orphan"
        ck = None
    elif "llm" in kind.lower():
        status = "already_llm"
        ck = kind
    else:
        status = "needs_work"
        ck = kind

    return ClassifiedJob(
        path=str(path),
        job_id=jid,
        observation_id=oid,
        session_id=sid,
        attempts_made=attempts,
        status=status,
        compression_kind=ck,
        age_hours=age_h,
        trailing_garbage=garbage,
        process_at_ms=process_at_ms,
    )


def is_compress_job_file(name: str) -> bool:
    # URL-encoded: queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3A...
    n = unquote(name)
    return "mem::compress" in n and "jobs" in n


def is_graph_job_file(name: str) -> bool:
    n = unquote(name)
    return "mem::graph-extract" in n and "jobs" in n


def list_compress_jobs(queue_dir: Path) -> list[Path]:
    if not queue_dir.is_dir():
        return []
    return sorted(p for p in queue_dir.iterdir() if p.is_file() and is_compress_job_file(p.name))


def classify_queue(queue_dir: Path, state_dir: Path) -> list[ClassifiedJob]:
    kinds = index_observation_kinds(state_dir)
    out: list[ClassifiedJob] = []
    for p in list_compress_jobs(queue_dir):
        out.append(classify_job(p, p.read_bytes(), kinds))
    return out


def summarize(jobs: Iterable[ClassifiedJob]) -> dict[str, Any]:
    jobs = list(jobs)
    counts = Counter(j.status for j in jobs)
    dead = counts.get("already_llm", 0) + counts.get("orphan", 0) + counts.get("corrupt", 0)
    total = len(jobs)
    garbage_n = sum(1 for j in jobs if j.trailing_garbage)
    ages = [j.age_hours for j in jobs if j.age_hours is not None]
    return {
        "total": total,
        "counts": dict(counts),
        "dead": dead,
        "needs_work": counts.get("needs_work", 0),
        "zombie_ratio": (dead / total) if total else 0.0,
        "trailing_garbage": garbage_n,
        "age_hours": {
            "min": min(ages) if ages else None,
            "max": max(ages) if ages else None,
            "median": sorted(ages)[len(ages) // 2] if ages else None,
        },
    }


def threshold_fail(summary: dict[str, Any], min_jobs: int, zombie_ratio: float) -> bool:
    total = int(summary.get("total") or 0)
    if total < min_jobs:
        return False
    return float(summary.get("zombie_ratio") or 0) >= zombie_ratio


def load_lists(queue_dir: Path) -> dict[str, Any]:
    p = queue_dir / "_queue_lists.bin"
    if not p.is_file():
        return {}
    try:
        return parse_json_blob(p.read_bytes())
    except Exception:
        return {}


def write_lists(queue_dir: Path, lists: dict[str, Any]) -> None:
    (queue_dir / "_queue_lists.bin").write_bytes(
        json.dumps(lists, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )


def write_sorted_sets_clean(queue_dir: Path) -> None:
    p = queue_dir / "_queue_sorted_sets.bin"
    if not p.is_file():
        p.write_bytes(b"{}")
        return
    try:
        data = parse_json_blob(p.read_bytes())
    except Exception:
        return
    if not isinstance(data, dict):
        return
    p.write_bytes(json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def engine_up(url: str, secret: str, timeout: float = 3.0) -> bool:
    try:
        req = urllib.request.Request(
            url.rstrip("/") + "/agentmemory/livez",
            headers={"Authorization": f"Bearer {secret}"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", errors="replace")
        return "ok" in body.lower() or "true" in body.lower() or "status" in body.lower()
    except Exception:
        return False


def enqueue_compress(url: str, secret: str, session_id: str, observation_id: str) -> dict[str, Any]:
    body = json.dumps({"sessionId": session_id, "observationId": observation_id}).encode()
    req = urllib.request.Request(
        url.rstrip("/") + "/agentmemory/compress",
        data=body,
        headers={
            "Authorization": f"Bearer {secret}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}", "body": e.read().decode("utf-8", errors="replace")[:300]}
    except Exception as e:
        return {"error": str(e)[:200]}


def backup_queue(queue_dir: Path, root: Path) -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest_parent = root / "data" / "backups"
    dest_parent.mkdir(parents=True, exist_ok=True)
    dest = dest_parent / f"queue_store-{ts}"
    shutil.copytree(queue_dir, dest)
    return dest


def cmd_check(
    queue_dir: Path,
    state_dir: Path,
    min_jobs: int,
    zombie_ratio: float,
    as_json: bool,
) -> int:
    jobs = classify_queue(queue_dir, state_dir)
    summary = summarize(jobs)
    lists = load_lists(queue_dir)
    waiting = lists.get(COMPRESS_WAITING_KEY) or []
    active = lists.get(COMPRESS_ACTIVE_KEY) or []
    waiting_ids = set(waiting) if isinstance(waiting, list) else set()
    active_ids = set(active) if isinstance(active, list) else set()
    listed_ids = waiting_ids | active_ids
    waiting_len = len(waiting) if isinstance(waiting, list) else 0
    active_len = len(active) if isinstance(active, list) else 0
    now_ms = int(time.time() * 1000)
    grace_ms = UNLISTED_NEEDS_WORK_GRACE_SECONDS * 1000
    stale_unlisted = [
        j
        for j in jobs
        if j.status == "needs_work"
        and j.job_id
        and j.job_id not in listed_ids
        and (
            (
                j.process_at_ms is not None
                and j.process_at_ms <= now_ms - grace_ms
            )
            or (
                j.process_at_ms is None
                and j.age_hours > UNLISTED_NEEDS_WORK_GRACE_SECONDS / 3600
            )
        )
    ]
    report = {
        "ok": not threshold_fail(summary, min_jobs, zombie_ratio) and not stale_unlisted,
        "summary": summary,
        "waiting_list_len": waiting_len,
        "active_list_len": active_len,
        "unlisted_needs_work": len(stale_unlisted),
        "thresholds": {
            "min_jobs": min_jobs,
            "zombie_ratio": zombie_ratio,
            "unlisted_grace_seconds": UNLISTED_NEEDS_WORK_GRACE_SECONDS,
        },
        "sample_dead": [
            asdict(j)
            for j in jobs
            if j.status in ("already_llm", "orphan", "corrupt")
        ][:8],
        "sample_needs_work": [asdict(j) for j in jobs if j.status == "needs_work"][:8],
        "sample_unlisted_needs_work": [asdict(j) for j in stale_unlisted[:8]],
    }
    # sticky active with many dead is also a smell even if ratio edge
    if active_len >= min_jobs and summary["dead"] >= min_jobs * zombie_ratio:
        report["ok"] = False
        report["sticky_active"] = True

    if as_json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        s = summary
        print("═══ queue-reconcile --check (mem::compress) ═══")
        print(f"  jobs_on_disk:     {s['total']}")
        print(f"  counts:           {s['counts']}")
        print(f"  dead:             {s['dead']}  zombie_ratio={s['zombie_ratio']:.2f}")
        print(f"  needs_work:       {s['needs_work']}")
        print(f"  trailing_garbage: {s['trailing_garbage']}")
        print(f"  age_hours:        {s['age_hours']}")
        print(f"  waiting_list_len:  {waiting_len}")
        print(f"  active_list_len:   {active_len}")
        print(f"  unlisted_needs_work: {len(stale_unlisted)} (grace={UNLISTED_NEEDS_WORK_GRACE_SECONDS}s)")
        print(f"  thresholds:       min_jobs={min_jobs} zombie_ratio>={zombie_ratio}")
        print(f"  result:           {'OK' if report['ok'] else 'FAIL (queue persistence backlog)'}")
        if not report["ok"]:
            print("  hint: stop daemon if needed, then:")
            print("    python3 scripts/queue-reconcile.py --repair")
    return 0 if report["ok"] else 1


def write_clean_job(path: Path, job: dict[str, Any], now_ms: int) -> None:
    """Rewrite job JSON without trailing garbage; reset for redelivery."""
    job = dict(job)
    job["attempts_made"] = 0
    job["process_at"] = now_ms
    # keep data/id/function_id/message_id/etc.
    payload = {"": job}
    path.write_bytes(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def cmd_repair(
    queue_dir: Path,
    state_dir: Path,
    root: Path,
    url: str,
    secret: str,
    allow_live: bool,
    as_json: bool,
) -> int:
    """Safe reclaim (read-only audit of job files; only deletes confirmed-dead).

    Does NOT write _queue_lists.bin or rewrite job files — engine
    serialization format is unverified.  This tool:
    - already_llm: DELETE job file only (observation already in KV)
    - needs_work / orphan: KEEP untouched; record in manifest
    - corrupt: quarantine under .quarantine/

    needs_work recovery: POST /agentmemory/compress for each pair in
    manifest, then delete old job files after compression verified."""
    live = engine_up(url, secret)
    if live and not allow_live:
        msg = (
            "engine appears UP — refusing --repair without --allow-live "
            "(file rewrite races consumers). Prefer: am-daemon stop && "
            "--repair && am-daemon start"
        )
        if as_json:
            print(json.dumps({"ok": False, "error": msg}))
        else:
            print(f"ERROR: {msg}", file=sys.stderr)
        return 2

    if not queue_dir.is_dir():
        print(json.dumps({"ok": True, "note": "no queue_store"})) if as_json else print("no queue_store")
        return 0

    now_ms = int(time.time() * 1000)
    jobs = classify_queue(queue_dir, state_dir)
    summary = summarize(jobs)
    bak = backup_queue(queue_dir, root)

    quarantine = queue_dir / ".quarantine"
    quarantine.mkdir(exist_ok=True)

    dropped_llm = 0
    kept = 0
    quarantined = 0
    needs_manifest: list[dict[str, str]] = []
    unrecoverable = 0

    for cj in jobs:
        p = Path(cj.path)
        if not p.is_file():
            continue

        if cj.status == "corrupt":
            dest = quarantine / f"{p.name}.{now_ms}"
            shutil.move(str(p), str(dest))
            quarantined += 1
            continue

        if cj.status == "already_llm":
            # Request is a no-op: observation already compressed. Safe to drop job only.
            p.unlink(missing_ok=True)
            dropped_llm += 1
            continue

        # needs_work or orphan: KEEP as-is (engine-native format unverified).
        # Do NOT rewrite (would strip framing bytes).
        # Do NOT modify _queue_lists.bin.
        # Record in manifest for API-based recovery.
        kept += 1
        jid = str(cj.job_id or "")
        if cj.session_id and cj.observation_id:
            needs_manifest.append(
                {
                    "sessionId": cj.session_id,
                    "observationId": cj.observation_id,
                    "jobId": jid,
                    "status": cj.status,
                }
            )
        else:
            unrecoverable += 1

    # Do NOT write _queue_lists.bin or _queue_sorted_sets.bin —
    # engine serialization format is unverified.

    # Manifest is audit + optional reenqueue helper; jobs already on disk for kept work.
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "mode": "safe_reclaim",
        "backup": str(bak),
        "summary_before": summary,
        "dropped_already_llm": dropped_llm,
        "quarantined_corrupt": quarantined,
        "preserved_jobs": kept,
        "unrecoverable": unrecoverable,
        "needs_work": needs_manifest,
        "note": (
            "needs_work/orphan job files were KEPT in native format; "
            "only already_llm jobs removed; corrupt moved to .quarantine/; "
            "recover via --reenqueue (POSTs /agentmemory/compress; orphan entries safely skip-ACK)"
        ),
    }
    manifest_path = queue_dir / MANIFEST_NAME
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")

    # Audit manifest; needs_work preserved in native format for API recovery.
    out = {
        "ok": True,
        "mode": "safe_reclaim",
        "backup": str(bak),
        "summary_before": summary,
        "dropped_already_llm": dropped_llm,
        "quarantined_corrupt": quarantined,
        "preserved_jobs": kept,
        "unrecoverable": unrecoverable,
        "manifest": str(manifest_path),
        "silent_drop_risk": "unrecoverable" if unrecoverable > 0 else "none_for_needs_work",
        "next": "recover via --reenqueue (POSTs /agentmemory/compress per entry)",
    }
    if as_json:
        print(json.dumps(out, indent=2, ensure_ascii=False))
    else:
        print("═══ queue-reconcile --repair (safe reclaim) ═══")
        print(f"  backup:              {bak}")
        print(f"  before:              {summary}")
        print(f"  dropped_already_llm: {dropped_llm}")
        print(f"  quarantined_corrupt: {quarantined}")
        print(f"  preserved_jobs:     {kept}  (untouched native format)")
        if unrecoverable > 0:
            print(f"  unrecoverable:      {unrecoverable}  (missing sessionId/observationId in job payload)")
        print(f"  manifest:            {manifest_path}")
        print(f"  next:                {out['next']}")
    return 0


def cmd_reenqueue(queue_dir: Path, url: str, secret: str, as_json: bool) -> int:
    """POST needs_work from manifest for API-based recovery.

    Safe for all manifest modes including safe_reclaim.  Sends
    /agentmemory/compress for each entry; failed items stay in manifest
    for retry.  On full success, renames manifest to .done."""
    manifest_path = queue_dir / MANIFEST_NAME
    if not manifest_path.is_file():
        msg = f"no manifest at {manifest_path} (run --repair first)"
        if as_json:
            print(json.dumps({"ok": False, "error": msg}))
        else:
            print(f"ERROR: {msg}", file=sys.stderr)
        return 2
    if not engine_up(url, secret):
        msg = "engine not up — start am-daemon first"
        if as_json:
            print(json.dumps({"ok": False, "error": msg}))
        else:
            print(f"ERROR: {msg}", file=sys.stderr)
        return 2

    # Verify we can parse the engine's list format before proceeding.
    # load_lists returns {} on failure, so check the raw file first.
    lists_path = queue_dir / "_queue_lists.bin"
    if lists_path.is_file():
        try:
            parse_json_blob(lists_path.read_bytes())
        except Exception:
            msg = "cannot parse _queue_lists.bin — refuse to reenqueue without delivery-list filter"
            if as_json:
                print(json.dumps({"ok": False, "error": msg}))
            else:
                print(f"ERROR: {msg}", file=sys.stderr)
            return 2

    manifest = json.loads(manifest_path.read_text())
    # Filter: skip items whose jobId is currently in engine delivery lists
    delivery_ids: set[str] = set()
    lists = load_lists(queue_dir)
    for key_kind in (COMPRESS_WAITING_KEY, COMPRESS_ACTIVE_KEY):
        for jid in (lists.get(key_kind) or []):
            if isinstance(jid, str):
                delivery_ids.add(jid)

    items = list(manifest.get("needs_work") or [])
    to_enqueue: list[dict[str, str]] = []
    for item in items:
        if item.get("jobId") in delivery_ids:
            continue  # skip: already in engine delivery list
        to_enqueue.append(item)

    ok = fail = 0
    errors = []
    remaining: list[dict[str, str]] = []
    enqueued_ok_items: list[dict[str, str]] = []
    for item in to_enqueue:
        r = enqueue_compress(url, secret, item["sessionId"], item["observationId"])
        if isinstance(r, dict) and not r.get("error"):
            ok += 1
            enqueued_ok_items.append(item)
        else:
            fail += 1
            remaining.append(item)
            if len(errors) < 5:
                errors.append({"item": item, "error": r})
        time.sleep(0.02)

    # Items in delivery lists: keep in manifest (not reenqueued, not dropped)
    # Post-reenqueue: verify compression and clean up old job files.
    # Each successfully-enqueued item is checked once; confirmed llm
    # old files are deleted.  Unconfirmed items stay in manifest.
    def _clean_old_file(jid: str) -> bool:
        """Delete the old compress job file for the given jobId. Returns True if deleted."""
        if not jid or "/" in jid or ".." in jid or "\\" in jid:
            return False
        path = queue_dir / f"queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3A{jid}.bin"
        if path.is_file():
            path.unlink()
            return True
        return False

    pending = []
    cleaned = 0
    if ok > 0:
        for item in enqueued_ok_items:
            jid = item.get("jobId", "")
            is_orphan = item.get("status") == "orphan"

            if not jid:
                pending.append(item)
                continue

            if is_orphan:
                if _clean_old_file(jid):
                    cleaned += 1
                else:
                    pending.append(item)
                continue

            # needs_work: verify compressionKind=llm before deleting
            oid = item["observationId"]
            sid = item["sessionId"]
            try:
                req_url = f"{url.rstrip('/')}/agentmemory/observations?sessionId={sid}"
                req = urllib.request.Request(
                    req_url, headers={"Authorization": f"Bearer {secret}"}
                )
                with urllib.request.urlopen(req, timeout=10) as r:
                    obs_data = json.loads(r.read())
                    found_llm = False
                    for o in obs_data.get("observations", []):
                        if o.get("id") == oid:
                            found_llm = o.get("compressionKind") == "llm"
                            break
                    if found_llm and _clean_old_file(jid):
                        cleaned += 1
                    else:
                        pending.append(item)
            except Exception:
                pending.append(item)
    # Items in delivery lists: unchanged (not reenqueued, not cleaned)
    for item in items:
        if item.get("jobId") in delivery_ids:
            pending.append(item)

    if pending or remaining:
        manifest["needs_work"] = pending + remaining
        manifest["last_reenqueue_at"] = datetime.now(timezone.utc).isoformat()
        manifest["last_reenqueue_ok"] = ok
        manifest["last_reenqueue_fail"] = fail
        manifest["cleaned_old_files"] = cleaned
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        done = None
    else:
        done = queue_dir / f"{MANIFEST_NAME}.done.{int(time.time())}"
        manifest_path.rename(done)

    out = {
        "ok": fail == 0 and not pending and not remaining,
        "enqueued_ok": ok,
        "fail": fail,
        "cleaned_old_files": cleaned,
        "remaining": len(pending) + len(remaining),
        "manifest": str(manifest_path if not done else done),
        "errors": errors,
    }
    if as_json:
        print(json.dumps(out, indent=2, ensure_ascii=False))
    else:
        print("═══ queue-reconcile --reenqueue ═══")
        print(f"  ok={ok} fail={fail} cleaned={cleaned} remaining={out['remaining']}")
        print(f"  manifest→{out['manifest']}")
        for e in errors:
            print(f"  err: {e}")
    return 0 if out["ok"] else 1

def resolve_paths(root: Path) -> tuple[Path, Path]:
    return root / "data" / "queue_store", root / "data" / "state_store.db"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="classify; exit 1 on zombie ratio or stale unlisted")
    mode.add_argument("--repair", action="store_true", help="backup + drop already_llm; preserve rest (audit-only)")
    mode.add_argument("--reenqueue", action="store_true", help="POST manifest entries; verify+cleanup old files")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--allow-live", action="store_true", help="allow --repair while engine is up (risky)")
    ap.add_argument("--root", type=Path, default=Path(os.environ.get("AGENTMEMORY_ROOT", DEFAULT_ROOT)))
    ap.add_argument("--min-jobs", type=int, default=int(os.environ.get("QUEUE_ZOMBIE_MIN_JOBS", "10")))
    ap.add_argument(
        "--zombie-ratio",
        type=float,
        default=float(os.environ.get("QUEUE_ZOMBIE_RATIO", "0.4")),
    )
    ap.add_argument("--url", default=os.environ.get("AGENTMEMORY_URL", "http://localhost:3111"))
    ap.add_argument("--secret", default=os.environ.get("AGENTMEMORY_SECRET", "omp-memory-local"))
    args = ap.parse_args(argv)

    root = args.root.resolve()
    queue_dir, state_dir = resolve_paths(root)

    if args.check:
        return cmd_check(queue_dir, state_dir, args.min_jobs, args.zombie_ratio, args.json)
    if args.repair:
        return cmd_repair(queue_dir, state_dir, root, args.url, args.secret, args.allow_live, args.json)
    if args.reenqueue:
        return cmd_reenqueue(queue_dir, args.url, args.secret, args.json)
    return 2


if __name__ == "__main__":
    sys.exit(main())
