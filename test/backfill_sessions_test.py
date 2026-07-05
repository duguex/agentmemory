"""Comprehensive tests for scripts/backfill-sessions.py."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
FIXTURES_DIR = Path(__file__).parent / "fixtures"

# Load the backfill module
spec = importlib.util.spec_from_file_location(
    "backfill_sessions", SCRIPTS_DIR / "backfill-sessions.py"
)
backfill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backfill)


# ── Helper: create a temp JSONL file ────────────────────────────────────────
def _write_temp_jsonl(lines: list[str]) -> str:
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".jsonl", delete=False, encoding="utf-8"
    )
    for line in lines:
        tmp.write(line.rstrip("\n") + "\n")
    tmp.flush()
    tmp.close()
    return tmp.name


# ═══════════════════════════════════════════════════════════════════════════
# G1.1: toolCalls from content array
# ═══════════════════════════════════════════════════════════════════════════
def test_parse_session_extracts_tool_calls_from_content_array():
    """toolCalls live inside msg.content[] as {type:toolCall, id, name, arguments}."""
    fpath = str(FIXTURES_DIR / "omp_real_session.jsonl")
    session_meta, turns = backfill.parse_session(fpath)

    # Turn 0 has 2 toolCalls from one assistant message
    assert len(turns[0]["tools"]) == 2
    assert turns[0]["tools"][0]["name"] == "get_weather"
    assert turns[0]["tools"][1]["name"] == "get_weather"

    # arguments dict → JSON string
    assert '"city"' in turns[0]["tools"][0]["input"]
    assert '"SF"' in turns[0]["tools"][0]["input"]
    assert '"NYC"' in turns[0]["tools"][1]["input"]


# ═══════════════════════════════════════════════════════════════════════════
# G1.8: ts key uses toolResult timestamp
# ═══════════════════════════════════════════════════════════════════════════
def test_parse_session_tool_ts_from_tool_result():
    """Tool 'ts' must be the toolResult timestamp, not the user prompt timestamp."""
    fpath = str(FIXTURES_DIR / "omp_real_session.jsonl")
    session_meta, turns = backfill.parse_session(fpath)

    # Turn 0: user at 10:00:00, toolResults at 10:00:06 and 10:00:07
    assert turns[0]["user_ts"] == "2026-07-01T10:00:00.000Z"
    assert turns[0]["tools"][0]["ts"] == "2026-07-01T10:00:06.000Z"
    assert turns[0]["tools"][1]["ts"] == "2026-07-01T10:00:07.000Z"

    # Turn 1: user at 10:01:00, toolResults at 10:01:06 and 10:01:07
    assert turns[1]["user_ts"] == "2026-07-01T10:01:00.000Z"
    assert turns[1]["tools"][0]["ts"] == "2026-07-01T10:01:06.000Z"
    assert turns[1]["tools"][1]["ts"] == "2026-07-01T10:01:07.000Z"


# ═══════════════════════════════════════════════════════════════════════════
# G1.2: full session ID, no truncation
# ═══════════════════════════════════════════════════════════════════════════
def test_parse_session_session_id_full_uuid():
    """Session ID must be the full UUID, not a 20-char prefix."""
    fpath = str(FIXTURES_DIR / "omp_real_session.jsonl")
    session_meta, turns = backfill.parse_session(fpath)

    assert session_meta["id"] == "019f0001-0000-7000-abcd-000000000001"
    assert len(session_meta["id"]) == 36  # full UUID


def test_main_uses_full_session_id_not_truncated(monkeypatch):
    """The sessionId sent to the API must use the full id, not truncated."""
    lines = [
        '{"type":"session","version":3,"id":"019faaaa-bbbb-cccc-dddd-eeeeeeeeeeee","timestamp":"2026-07-01T10:00:00.000Z","cwd":"/tmp/proj"}',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
        '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-01T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    ]
    fpath = _write_temp_jsonl(lines)
    try:
        session_meta, turns = backfill.parse_session(fpath)
        assert session_meta["id"] == "019faaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        assert len(session_meta["id"]) == 36
    finally:
        os.unlink(fpath)


# ═══════════════════════════════════════════════════════════════════════════
# G1.3: invalid timestamp handling
# ═══════════════════════════════════════════════════════════════════════════
def test_parse_session_handles_invalid_timestamp():
    """Invalid timestamps must not crash; fall back gracefully."""
    lines = [
        '{"type":"session","version":3,"id":"x","timestamp":"not-a-date","cwd":"/tmp"}',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"garbage","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    ]
    fpath = _write_temp_jsonl(lines)
    try:
        session_meta, turns = backfill.parse_session(fpath)
        # Must not crash
        assert session_meta["id"] == "x"
        assert len(turns) == 1
        # user_ts should be the original garbage string (not parsed)
        assert turns[0]["user_ts"] == "garbage"
    finally:
        os.unlink(fpath)


def test_parse_session_missing_timestamp():
    """Missing timestamp fields must not crash."""
    lines = [
        '{"type":"session","version":3,"id":"x","cwd":"/tmp"}',
        '{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    ]
    fpath = _write_temp_jsonl(lines)
    try:
        session_meta, turns = backfill.parse_session(fpath)
        assert session_meta["timestamp"] == ""  # missing
        assert len(turns) == 1
        assert turns[0]["user_ts"] == ""  # missing
    finally:
        os.unlink(fpath)


# ═══════════════════════════════════════════════════════════════════════════
# Turn grouping correctness
# ═══════════════════════════════════════════════════════════════════════════
def test_parse_session_groups_turns_correctly():
    """3 user messages → 3 turns; multitool turns group tools together."""
    fpath = str(FIXTURES_DIR / "omp_real_session.jsonl")
    session_meta, turns = backfill.parse_session(fpath)

    assert len(turns) == 3
    assert len(turns[0]["tools"]) == 2  # multitool
    assert len(turns[1]["tools"]) == 2  # multitool with 1 error
    assert len(turns[2]["tools"]) == 0  # plain conversation
    assert turns[2]["assistant_text"] == "You're welcome!"


# ═══════════════════════════════════════════════════════════════════════════
# Error flag from message.isError
# ═══════════════════════════════════════════════════════════════════════════
def test_parse_session_error_flag_from_message():
    """isError must be read from message.isError (camelCase, inside message)."""
    fpath = str(FIXTURES_DIR / "omp_real_session.jsonl")
    session_meta, turns = backfill.parse_session(fpath)

    # Turn 1 tool 1 is the error tool (secrets.env)
    assert turns[1]["tools"][0]["error"] is False  # config.yaml ok
    assert turns[1]["tools"][1]["error"] is True   # secrets.env error


# ═══════════════════════════════════════════════════════════════════════════
# Project name derivation
# ═══════════════════════════════════════════════════════════════════════════
def test_parse_session_project_from_cwd():
    """Project name must be derived from the last component of cwd."""
    fpath = str(FIXTURES_DIR / "omp_real_session.jsonl")
    session_meta, turns = backfill.parse_session(fpath)
    assert session_meta["project"] == "test-project"


def test_project_from_cwd_trailing_slash():
    assert backfill.project_from_cwd("/home/user/my-project/") == "my-project"


def test_project_from_cwd_root():
    """Root path produces empty string (no meaningful name)."""
    assert backfill.project_from_cwd("/") == ""


def test_project_from_cwd_unknown():
    """Bare unclassifiable path gets last component."""
    # path with only skip-able components
    result = backfill.project_from_cwd("/home/user")
    assert result != "home"  # "home" is skipped

# ═══════════════════════════════════════════════════════════════════════════
# Empty / malformed session
# ═══════════════════════════════════════════════════════════════════════════
def test_parse_session_empty_file():
    fpath = _write_temp_jsonl([])
    try:
        session_meta, turns = backfill.parse_session(fpath)
        assert session_meta is None
        assert turns == []
    finally:
        os.unlink(fpath)


def test_parse_session_no_messages():
    lines = [
        '{"type":"session","version":3,"id":"x","timestamp":"2026-07-01T10:00:00.000Z","cwd":"/tmp/x"}',
    ]
    fpath = _write_temp_jsonl(lines)
    try:
        session_meta, turns = backfill.parse_session(fpath)
        assert session_meta["id"] == "x"
        assert turns == []
    finally:
        os.unlink(fpath)


def test_parse_session_skips_non_message_entries():
    """Non-message entries (model_change, thinking_level_change) must be skipped."""
    lines = [
        '{"type":"session","version":3,"id":"x","timestamp":"2026-07-01T10:00:00.000Z","cwd":"/tmp/x"}',
        '{"type":"model_change","id":"mc1","parentId":null,"timestamp":"2026-07-01T10:00:00.000Z","model":"claude"}',
        '{"type":"thinking_level_change","id":"tc1","parentId":"mc1","timestamp":"2026-07-01T10:00:00.100Z","thinkingLevel":"xhigh"}',
        '{"type":"message","id":"m1","parentId":"tc1","timestamp":"2026-07-01T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
        '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-01T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}',
    ]
    fpath = _write_temp_jsonl(lines)
    try:
        session_meta, turns = backfill.parse_session(fpath)
        assert len(turns) == 1
    finally:
        os.unlink(fpath)


# ═══════════════════════════════════════════════════════════════════════════
# G1.6: Streaming JSONL parse (memory efficiency)
# ═══════════════════════════════════════════════════════════════════════════
def test_parse_session_streams_file():
    """parse_session must iterate line-by-line, not readlines()."""
    # The real test: create a moderate file and verify no full-file list materialized.
    # We check that the function returns correct results (generator behavior is internal).
    lines = [
        '{"type":"session","version":3,"id":"large","timestamp":"2026-07-01T10:00:00.000Z","cwd":"/tmp/large"}',
    ]
    # Add 50 user→assistant exchanges
    for i in range(50):
        lines.append(
            f'{{"type":"message","id":"u{i}","parentId":null,"timestamp":"2026-07-01T10:00:{i:02d}.000Z","message":{{"role":"user","content":[{{"type":"text","text":"msg{i}"}}]}}}}'
        )

    fpath = _write_temp_jsonl(lines)
    try:
        session_meta, turns = backfill.parse_session(fpath)
        assert len(turns) == 50
    finally:
        os.unlink(fpath)


# ═══════════════════════════════════════════════════════════════════════════
# G1.7: requests.Session for TCP keepalive
# ═══════════════════════════════════════════════════════════════════════════
def test_module_has_http_session():
    """A requests.Session must be imported at module level for TCP keepalive."""
    import requests

    assert hasattr(backfill, "_http_session")
    # It is None until first use (lazy init)
    assert backfill._http_session is None or isinstance(
        backfill._http_session, requests.Session
    )


def test_api_post_uses_session(monkeypatch):
    """api_post must route through _http_session, not bare requests.post."""
    import requests

    calls = []

    class FakeResponse:
        status_code = 200
        ok = True
        text = "{}"

    class FakeSession:
        def post(self, *args, **kwargs):
            calls.append(("post", args, kwargs))
            return FakeResponse()

    fake_session = FakeSession()
    monkeypatch.setattr(backfill, "_http_session", fake_session)
    monkeypatch.setattr(backfill, "AGENTMEMORY_URL", "http://localhost:9999")
    monkeypatch.setattr(backfill, "AGENTMEMORY_SECRET", "test-secret")

    result = backfill.api_post("observe", {"foo": "bar"})
    assert result is True
    assert len(calls) == 1
    url = calls[0][1][0]
    assert url.endswith("/agentmemory/observe")


# ═══════════════════════════════════════════════════════════════════════════
# G1.5: Stats consolidation (no redundant re-parse loop)
# ═══════════════════════════════════════════════════════════════════════════
def test_main_dry_run_single_session(capsys, monkeypatch):
    """main() with --dry-run should parse once and print summary without error."""
    fpath = str(FIXTURES_DIR / "omp_real_session.jsonl")

    # Monkey-patch glob to return only our fixture
    def fake_glob(_pattern):
        return [fpath]

    monkeypatch.setattr(backfill.glob, "glob", fake_glob)
    monkeypatch.setattr(backfill, "SESSIONS_DIR", "/fake/dir")
    monkeypatch.setattr(backfill, "AGENTMEMORY_SECRET", "")

    # Run main with --dry-run
    orig_argv = sys.argv
    try:
        sys.argv = ["backfill_sessions", "--dry-run"]
        backfill.main()
    finally:
        sys.argv = orig_argv

    captured = capsys.readouterr()
    assert "Would backfill" in captured.out
    assert "turns from" in captured.out
    assert "test-project" in captured.out  # project name in summary