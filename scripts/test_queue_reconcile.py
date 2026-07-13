#!/usr/bin/env python3
"""Unit tests for scripts/queue-reconcile.py classification (no engine)."""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "queue-reconcile.py"


def load_mod():
    spec = importlib.util.spec_from_file_location("queue_reconcile", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["queue_reconcile"] = mod
    spec.loader.exec_module(mod)
    return mod


qr = load_mod()


def make_job_bytes(
    job_id: str,
    oid: str,
    sid: str,
    attempts: int = 0,
    created_at: int = 1_700_000_000_000,
    garbage: bool = False,
) -> bytes:
    job = {
        "": {
            "attempts_made": attempts,
            "created_at": created_at,
            "data": {"observationId": oid, "sessionId": sid},
            "function_id": "mem::compress",
            "id": job_id,
            "max_attempts": 3,
            "process_at": created_at,
            "queue": "__fn_queue::mem::compress",
        }
    }
    raw = json.dumps(job, separators=(",", ":")).encode()
    if garbage:
        raw = raw + b"\xff\xfe\x00trash"
    return raw


def write_obs(state: Path, session: str, observations: list[dict]) -> None:
    # shape used by file store: list or dict of obs
    payload = {o["observationId"]: o for o in observations}
    name = f"mem%3Aobs%3A{session}.bin"
    (state / name).write_bytes(json.dumps(payload).encode())


class ClassifyTests(unittest.TestCase):
    def test_trailing_garbage_detection(self):
        clean = b'{"a":1}'
        dirty = b'{"a":1}\xff\xff'
        self.assertFalse(qr.trailing_garbage(clean))
        self.assertTrue(qr.trailing_garbage(dirty))

    def test_parse_json_blob_strips_garbage(self):
        d = qr.parse_json_blob(b'{"x":1}\x00\xff')
        self.assertEqual(d, {"x": 1})

    def test_classify_already_llm_orphan_needs(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            q = root / "queue"
            s = root / "state"
            q.mkdir()
            s.mkdir()
            write_obs(
                s,
                "sess1",
                [
                    {"observationId": "obs_llm1", "compressionKind": "llm", "sessionId": "sess1"},
                    {"observationId": "obs_none1", "compressionKind": "none", "sessionId": "sess1"},
                ],
            )
            jobs = [
                ("j1", "obs_llm1", "sess1", False),
                ("j2", "obs_none1", "sess1", True),
                ("j3", "obs_missing", "sess1", False),
            ]
            for jid, oid, sid, garb in jobs:
                name = f"queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3A{jid}.bin"
                (q / name).write_bytes(make_job_bytes(jid, oid, sid, garbage=garb))

            classified = qr.classify_queue(q, s)
            by_oid = {c.observation_id: c for c in classified}
            self.assertEqual(by_oid["obs_llm1"].status, "already_llm")
            self.assertEqual(by_oid["obs_none1"].status, "needs_work")
            self.assertTrue(by_oid["obs_none1"].trailing_garbage)
            self.assertEqual(by_oid["obs_missing"].status, "orphan")

            summary = qr.summarize(classified)
            self.assertEqual(summary["total"], 3)
            self.assertEqual(summary["dead"], 2)
            self.assertAlmostEqual(summary["zombie_ratio"], 2 / 3, places=3)
            self.assertTrue(qr.threshold_fail(summary, min_jobs=2, zombie_ratio=0.4))
            self.assertFalse(qr.threshold_fail(summary, min_jobs=10, zombie_ratio=0.4))

    def test_corrupt_job(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "bad.bin"
            p.write_bytes(b"not-json\xff")
            c = qr.classify_job(p, p.read_bytes(), {})
            self.assertEqual(c.status, "corrupt")

    def test_repair_keeps_needs_work_drops_only_already_llm(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            q = root / "data" / "queue_store"
            s = root / "data" / "state_store.db"
            q.mkdir(parents=True)
            s.mkdir(parents=True)
            write_obs(
                s,
                "sess1",
                [
                    {"observationId": "obs_llm1", "compressionKind": "llm"},
                    {"observationId": "obs_none1", "compressionKind": "none"},
                ],
            )
            for jid, oid in [
                ("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "obs_llm1"),
                ("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "obs_none1"),
                ("cccccccc-cccc-cccc-cccc-cccccccccccc", "obs_missing"),
            ]:
                name = f"queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3A{jid}.bin"
                (q / name).write_bytes(make_job_bytes(jid, oid, "sess1", garbage=True))

            # unreadable corrupt
            bad = q / "queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3Adeadbeef-dead-dead-dead-deadbeefdead.bin"
            bad.write_bytes(b"\xff\xfe not json")

            (q / "_queue_lists.bin").write_bytes(
                json.dumps({qr.COMPRESS_ACTIVE_KEY: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]}).encode()
            )
            (q / "_queue_sorted_sets.bin").write_bytes(b"{}\xff\xff")

            rc = qr.cmd_repair(
                q,
                s,
                root,
                url="http://127.0.0.1:9",
                secret="x",
                allow_live=False,
                as_json=True,
            )
            self.assertEqual(rc, 0)
            remaining = list(q.glob("*compress*jobs*"))
            # llm dropped; needs_work + orphan kept; corrupt quarantined
            self.assertEqual(len(remaining), 2)
            oids = set()
            for p in remaining:
                job = qr.unwrap_job(qr.parse_json_blob(p.read_bytes()))
                oids.add(job["data"]["observationId"])
                self.assertEqual(job.get("attempts_made"), 0)
                self.assertFalse(qr.trailing_garbage(p.read_bytes()))
            self.assertEqual(oids, {"obs_none1", "obs_missing"})
            self.assertTrue(any((q / ".quarantine").iterdir()))
            lists = qr.load_lists(q)
            self.assertEqual(len(lists.get(qr.COMPRESS_ACTIVE_KEY) or []), 2)
            self.assertEqual((q / "_queue_sorted_sets.bin").read_bytes(), b"{}")
            manifest = json.loads((q / qr.MANIFEST_NAME).read_text())
            self.assertEqual(manifest.get("mode"), "safe_reclaim")
            self.assertEqual(manifest.get("dropped_already_llm"), 1)


if __name__ == "__main__":
    unittest.main()
