#!/usr/bin/env python3
"""Unit tests for scripts/queue-reconcile.py classification (no engine)."""
from __future__ import annotations

import http.server
import socket
import threading
import io
import importlib.util
import json
import sys
import time
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
    process_at: int | None = None,
) -> bytes:
    job = {
        "": {
            "attempts_made": attempts,
            "created_at": created_at,
            "data": {"observationId": oid, "sessionId": sid},
            "function_id": "mem::compress",
            "id": job_id,
            "max_attempts": 3,
            "process_at": process_at if process_at is not None else created_at,
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
                json.dumps({
                    qr.COMPRESS_ACTIVE_KEY: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
                    "queue:__fn_queue::mem::graph-extract:waiting": ["graph-waiting"],
                    "queue:__fn_queue::mem::graph-extract:active": ["graph-active"],
                    "queue:unrelated": ["keep-me"],
                }).encode()
            )
            (q / "_queue_sorted_sets.bin").write_bytes(
                (json.dumps({
                    "queue:unrelated:schedule": {"score": 123},
                    "opaque:schedule": {"score": 456},
                }) + "\xff\xff").encode()
            )

            # Save pre-repair job file bytes
            job_none1_before = (q / "queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3Abbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.bin").read_bytes()
            job_missing_before = (q / "queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3Acccccccc-cccc-cccc-cccc-cccccccccccc.bin").read_bytes()

            # Save pre-repair bytes
            lists_before = (q / "_queue_lists.bin").read_bytes()
            sorted_before = (q / "_queue_sorted_sets.bin").read_bytes()

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
            self.assertEqual(oids, {"obs_none1", "obs_missing"})
            self.assertTrue(any((q / ".quarantine").iterdir()))

            # Repair must NOT write _queue_lists.bin or _queue_sorted_sets.bin
            self.assertEqual((q / "_queue_lists.bin").read_bytes(), lists_before)
            self.assertEqual((q / "_queue_sorted_sets.bin").read_bytes(), sorted_before)

            # Repair must NOT rewrite needs_work/orphan job files
            self.assertEqual(
                (q / "queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3Abbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.bin").read_bytes(),
                job_none1_before)
            self.assertEqual(
                (q / "queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3Acccccccc-cccc-cccc-cccc-cccccccccccc.bin").read_bytes(),
                job_missing_before)

            manifest = json.loads((q / qr.MANIFEST_NAME).read_text())
            self.assertEqual(manifest.get("mode"), "safe_reclaim")
            self.assertEqual(manifest.get("dropped_already_llm"), 1)
            self.assertEqual(manifest.get("preserved_jobs"), 2)
            self.assertEqual(manifest.get("unrecoverable", 0), 0)



    def test_repair_flags_unrecoverable_jobs_missing_metadata(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            q = root / "data" / "queue_store"
            s = root / "data" / "state_store.db"
            q.mkdir(parents=True)
            s.mkdir(parents=True)
            write_obs(s, "sess1", [{"observationId": "obs_good", "compressionKind": "none"}])
            # Job has observationId but empty sessionId — needs_work but unrecoverable
            raw_no_sid = json.dumps({
                "": {
                    "attempts_made": 0,
                    "created_at": 1_700_000_000_000,
                    "data": {"observationId": "obs_good", "sessionId": ""},
                    "function_id": "mem::compress",
                    "id": "no-sid-job",
                    "max_attempts": 3,
                    "process_at": 1_700_000_000_000,
                    "queue": "__fn_queue::mem::compress",
                }
            }).encode()
            (q / "queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3Ano-sid-job.bin").write_bytes(raw_no_sid)
            captured = io.StringIO()
            old_stdout = sys.stdout
            sys.stdout = captured
            rc = qr.cmd_repair(q, s, root, "http://127.0.0.1:1", "x", False, as_json=False)
            sys.stdout = old_stdout

            self.assertEqual(rc, 0)
            manifest = json.loads((q / qr.MANIFEST_NAME).read_text())
            self.assertEqual(manifest.get("preserved_jobs"), 1)
            self.assertEqual(manifest.get("unrecoverable"), 1)
            self.assertEqual(len(manifest.get("needs_work", [])), 0)
            self.assertTrue("unrecoverable" in captured.getvalue().lower())
    def test_check_flags_unlisted_needs_work_job(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            q = root / "data" / "queue_store"
            s = root / "data" / "state_store.db"
            q.mkdir(parents=True)
            s.mkdir(parents=True)
            write_obs(s, "sess1", [{"observationId": "obs_none1", "compressionKind": "none"}])
            job = q / "queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3Ajob1.bin"
            job.write_bytes(make_job_bytes("job1", "obs_none1", "sess1"))
            (q / "_queue_lists.bin").write_bytes(json.dumps({}).encode())

            self.assertEqual(qr.cmd_check(q, s, min_jobs=10, zombie_ratio=0.4, as_json=True), 1)

    def test_check_allows_fresh_unlisted_needs_work_job(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            q = root / "data" / "queue_store"
            s = root / "data" / "state_store.db"
            q.mkdir(parents=True)
            s.mkdir(parents=True)
            write_obs(s, "sess1", [{"observationId": "obs_none1", "compressionKind": "none"}])
            job = q / "queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3Ajob1.bin"
            now = int(time.time() * 1000)
            job.write_bytes(make_job_bytes("job1", "obs_none1", "sess1", created_at=now))
            (q / "_queue_lists.bin").write_bytes(json.dumps({}).encode())

            self.assertEqual(qr.cmd_check(q, s, min_jobs=10, zombie_ratio=0.4, as_json=True), 0)

    def test_check_allows_recently_rewritten_unlisted_job(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            q = root / "data" / "queue_store"
            s = root / "data" / "state_store.db"
            q.mkdir(parents=True)
            s.mkdir(parents=True)
            write_obs(s, "sess1", [{"observationId": "obs_none1", "compressionKind": "none"}])
            job = q / "queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3Ajob1.bin"
            now = int(time.time() * 1000)
            job.write_bytes(make_job_bytes(
                "job1",
                "obs_none1",
                "sess1",
                created_at=1_700_000_000_000,
                process_at=now,
            ))
            (q / "_queue_lists.bin").write_bytes(json.dumps({}).encode())

            self.assertEqual(qr.cmd_check(q, s, min_jobs=10, zombie_ratio=0.4, as_json=True), 0)

    def test_reenqueue_sends_for_safe_reclaim_manifest(self):
        """cmd_reenqueue must POST enqueue requests for safe_reclaim manifests."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            q = root / "data" / "queue_store"
            q.mkdir(parents=True)

            received = []

            class Handler(http.server.BaseHTTPRequestHandler):
                def do_POST(self):
                    length = int(self.headers.get("Content-Length", "0"))
                    body = json.loads(self.rfile.read(length))
                    received.append({"path": self.path, "body": body})
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": True}).encode())

                def do_GET(self):
                    if "/agentmemory/observations" in self.path:
                        # Return observation with compressionKind=llm
                        obs_id = "o1" if "s1" in self.path else "o2"
                        resp = {"observations": [{"id": obs_id, "compressionKind": "llm"}]}
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        self.wfile.write(json.dumps(resp).encode())
                    else:
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.write(b'{"status":"ok"}')

                def log_message(self, *args):
                    pass

            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            sock.close()

            server = http.server.HTTPServer(("127.0.0.1", port), Handler)
            t = threading.Thread(target=server.serve_forever, daemon=True)
            t.start()

            manifest = {
                "mode": "safe_reclaim",
                "preserved_jobs": 2,
                "needs_work": [
                    {"sessionId": "s1", "observationId": "o1", "jobId": "j1"},
                    {"sessionId": "s2", "observationId": "o2", "jobId": "j2"},
                ],
            }

            # Create old job files that cleanup should delete
            job1_path = q / "queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3Aj1.bin"
            job2_path = q / "queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3Aj2.bin"
            job1_path.write_bytes(b'{"":{}}')
            job2_path.write_bytes(b'{"":{}}')

            (q / qr.MANIFEST_NAME).write_text(json.dumps(manifest))

            url = f"http://127.0.0.1:{port}"
            rc = qr.cmd_reenqueue(q, url, "x", as_json=True)

            server.shutdown()

            # Old job files should be deleted after confirmed llm
            self.assertFalse(job1_path.is_file())
            self.assertFalse(job2_path.is_file())

            self.assertEqual(rc, 0)
            self.assertEqual(len(received), 2)
            self.assertEqual(received[0]["path"], "/agentmemory/compress")
            self.assertEqual(received[0]["body"]["observationId"], "o1")
            self.assertEqual(received[1]["body"]["observationId"], "o2")

    def test_reenqueue_keeps_manifest_on_partial_failure(self):
        """cmd_reenqueue must keep manifest with remaining items on failure."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            q = root / "data" / "queue_store"
            q.mkdir(parents=True)

            received = []
            call_count = {"n": 0}

            class Handler(http.server.BaseHTTPRequestHandler):
                def do_POST(self):
                    length = int(self.headers.get("Content-Length", "0"))
                    body = json.loads(self.rfile.read(length))
                    received.append({"path": self.path, "body": body})
                    call_count["n"] += 1
                    if call_count["n"] == 2:
                        self.send_response(500)
                        self.end_headers()
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": True}).encode())

                def do_GET(self):
                    if "/agentmemory/observations" in self.path:
                        sid = "s1" if "s1" in self.path else "s3"
                        oid = "o1" if "s1" in self.path else "o3"
                        resp = {"observations": [{"id": oid, "compressionKind": "llm"}]}
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        self.wfile.write(json.dumps(resp).encode())
                    else:
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.write(b'{"status":"ok"}')

                def log_message(self, *args):
                    pass

            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            sock.close()

            server = http.server.HTTPServer(("127.0.0.1", port), Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()

            manifest = {
                "mode": "safe_reclaim",
                "preserved_jobs": 3,
                "needs_work": [
                    {"sessionId": "s1", "observationId": "o1", "jobId": "j1"},
                    {"sessionId": "s2", "observationId": "o2", "jobId": "j2"},
                    {"sessionId": "s3", "observationId": "o3", "jobId": "j3"},
                ],
            }

            # Create job files for successful items (o1, o3)
            for jid in ("j1", "j3"):
                (q / f"queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3A{jid}.bin").write_bytes(b'{"":{}}')

            (q / qr.MANIFEST_NAME).write_text(json.dumps(manifest))

            url = f"http://127.0.0.1:{port}"
            rc = qr.cmd_reenqueue(q, url, "x", as_json=True)
            server.shutdown()

            self.assertEqual(rc, 1)
            self.assertEqual(len(received), 3)
            # Manifest still exists with remaining item
            self.assertTrue((q / qr.MANIFEST_NAME).is_file())
            remaining = json.loads((q / qr.MANIFEST_NAME).read_text())
            self.assertEqual(len(remaining.get("needs_work", [])), 1)
            self.assertEqual(remaining["needs_work"][0]["observationId"], "o2")
            self.assertEqual(remaining.get("last_reenqueue_ok"), 2)
            self.assertEqual(remaining.get("last_reenqueue_fail"), 1)

    def test_reenqueue_skips_jobs_in_delivery_lists(self):
        """cmd_reenqueue must not re-POST items whose jobId is in waiting/active."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            q = root / "data" / "queue_store"
            q.mkdir(parents=True)

            received = []

            class Handler(http.server.BaseHTTPRequestHandler):
                def do_POST(self):
                    length = int(self.headers.get("Content-Length", "0"))
                    body = json.loads(self.rfile.read(length))
                    received.append(body)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": True}).encode())
                def do_GET(self):
                    if "/agentmemory/observations" in self.path:
                        oid = "o1" if "s1" in self.path else "o3"
                        resp = {"observations": [{"id": oid, "compressionKind": "llm"}]}
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        self.wfile.write(json.dumps(resp).encode())
                    else:
                        self.send_response(200); self.end_headers()
                        self.wfile.write(b'{"status":"ok"}')
                def log_message(self, *args): pass

            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]; sock.close()
            server = http.server.HTTPServer(("127.0.0.1", port), Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()

            # Job j2 is in engine active list — must be skipped
            (q / "_queue_lists.bin").write_bytes(json.dumps({
                "queue:__fn_queue::mem::compress:active": ["j2"],
            }).encode())

            # Create job files for the items that should be enqueued + cleaned
            for jid in ("j1", "j3"):
                (q / f"queue%3A__fn_queue%3A%3Amem%3A%3Acompress%3Ajobs%3A{jid}.bin").write_bytes(b'{"":{}}')


            manifest = {
                "mode": "safe_reclaim",
                "preserved_jobs": 3,
                "needs_work": [
                    {"sessionId": "s1", "observationId": "o1", "jobId": "j1"},
                    {"sessionId": "s2", "observationId": "o2", "jobId": "j2"},
                    {"sessionId": "s3", "observationId": "o3", "jobId": "j3"},
                ],
            }
            (q / qr.MANIFEST_NAME).write_text(json.dumps(manifest))

            rc = qr.cmd_reenqueue(q, f"http://127.0.0.1:{port}", "x", as_json=True)
            server.shutdown()

            self.assertEqual(rc, 1)  # not 0 — j2 still in remaining
            self.assertEqual(len(received), 2)  # j1 and j3 only
            received_oids = {r["observationId"] for r in received}
            self.assertEqual(received_oids, {"o1", "o3"})

            # Manifest preserved with j2
            rem = json.loads((q / qr.MANIFEST_NAME).read_text())
            self.assertEqual(len(rem.get("needs_work", [])), 1)
            self.assertEqual(rem["needs_work"][0]["jobId"], "j2")

    def test_reenqueue_fails_on_unparseable_lists(self):
        """cmd_reenqueue must refuse if _queue_lists.bin cannot be parsed."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            q = root / "data" / "queue_store"
            q.mkdir(parents=True)

            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(200); self.end_headers()
                    self.wfile.write(b'{"status":"ok"}')
                def log_message(self, *args): pass

            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]; sock.close()
            server = http.server.HTTPServer(("127.0.0.1", port), Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()

            manifest = {
                "mode": "safe_reclaim",
                "needs_work": [{"sessionId": "s1", "observationId": "o1", "jobId": "j1"}],
            }
            (q / qr.MANIFEST_NAME).write_text(json.dumps(manifest))

            # Write unparseable garbage
            (q / "_queue_lists.bin").write_bytes(b"\xff\xfe\x00\xff not json at all")

            rc = qr.cmd_reenqueue(q, f"http://127.0.0.1:{port}", "x", as_json=True)
            server.shutdown()
            self.assertEqual(rc, 2)

if __name__ == "__main__":
    unittest.main()
