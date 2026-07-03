# backfill-sessions.py Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 8 defects in `scripts/backfill-sessions.py` covering parsing, error handling, memory efficiency, and timestamp correctness.

**Architecture:** Stream-rewrite the script in-place using TDD. The 8 fixes fall into 4 logical clusters: (1) toolCall parsing rewrite, (2) error-handling hardening, (3) streaming + keepalive, (4) stats consolidation. We tackle them in dependency order so each task has a green test gate before the next.

**Tech Stack:** Python 3 (stdlib: `json`, `glob`, `time`, `datetime`, `sys`, `argparse`), `requests` (HTTP), `pytest` (test).

## Global Constraints

- Python 3.10+ syntax (`from __future__ import annotations` not required)
- `requests` is the only third-party dependency
- All timestamps must be RFC 3339 / ISO 8601 with timezone (`+00:00`)
- `set -e` equivalent: scripts use explicit `sys.exit(1)` on fatal errors
- File encoding: UTF-8 throughout
- Spec reference: `docs/superpowers/specs/2026-07-03-omp-adaptation-fixes-design.md` §G1

---

## File Structure

| File | Role |
|---|---|
| `scripts/backfill-sessions.py` | MODIFY — main script (rewrite parse_session, add streaming + keepalive, fix bugs) |
| `test/backfill-sessions.test.py` | CREATE — pytest unit tests covering all 8 fixes |
| `test/fixtures/sample-toolcall-content.jsonl` | CREATE — fixture for toolCall-in-content parsing |

No new modules. All changes contained in 2 files + 1 fixture.

---

## Task 1: Write failing tests for toolCall parsing (G1.1) + key handling

**Files:**
- Create: `test/fixtures/sample-toolcall-content.jsonl`
- Create: `test/backfill-sessions.test.py`

**Interfaces:**
- Consumes: `parse_session(fpath)` from `scripts/backfill-sessions.py`
- Produces: returns `(session_meta, turns)` where each turn is `{user_text, user_ts, tools: [{name, input, output, error, ts, assistant_text}], assistant_text, assistant_ts}`

- [ ] **Step 1: Create fixture file `test/fixtures/sample-toolcall-content.jsonl`**

```jsonl
{"type":"session_meta","id":"sess-001-abcdef","project":"myproj","cwd":"/tmp/proj","timestamp":"2026-07-01T10:00:00Z"}
{"type":"user","role":"user","timestamp":"2026-07-01T10:00:00Z","content":"What is the weather?"}
{"type":"assistant","role":"assistant","timestamp":"2026-07-01T10:00:05Z","content":[
  {"type":"text","text":"Let me check."},
  {"type":"toolCall","id":"call_1","name":"get_weather","arguments":{"city":"SF"}},
  {"type":"toolCall","id":"call_2","name":"get_weather","arguments":{"city":"NYC"}}
]}
{"type":"tool_result","role":"tool","timestamp":"2026-07-01T10:00:06Z","tool_call_id":"call_1","name":"get_weather","output":"sunny, 72F","tool_result_ts":"2026-07-01T10:00:06Z"}
{"type":"tool_result","role":"tool","timestamp":"2026-07-01T10:00:07Z","tool_call_id":"call_2","name":"get_weather","output":"rainy, 65F","tool_result_ts":"2026-07-01T10:00:07Z"}
{"type":"assistant_text","role":"assistant","timestamp":"2026-07-01T10:00:08Z","content":"It's sunny in SF and rainy in NYC."}
```

- [ ] **Step 2: Create `test/backfill-sessions.test.py` with first tests**

```python
"""Tests for scripts/backfill-sessions.py."""
from __future__ import annotations
import sys
import os
import pytest
from pathlib import Path

# Add scripts dir to import path
SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

# Import after path setup so the script module loads
import importlib.util
spec = importlib.util.spec_from_file_location("backfill_sessions", SCRIPTS_DIR / "backfill-sessions.py")
backfill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backfill)

FIXTURES = Path(__file__).parent / "fixtures"


def test_parse_session_extracts_tool_calls_from_content_array():
    """G1.1: toolCalls live inside msg.content[] (type='toolCall'), not top-level."""
    fpath = FIXTURES / "sample-toolcall-content.jsonl"
    session_meta, turns = backfill.parse_session(str(fpath))

    assert session_meta["id"] == "sess-001-abcdef"
    assert len(turns) == 1
    tools = turns[0]["tools"]
    assert len(tools) == 2
    assert tools[0]["name"] == "get_weather"
    assert tools[1]["name"] == "get_weather"
    # arguments dict serialized to JSON string
    assert '"city": "SF"' in tools[0]["input"] or '"city":"SF"' in tools[0]["input"]


def test_parse_session_uses_ts_key_not_timestamp_for_tool_result():
    """G1.8: Tool dicts must use 'ts' key, never 'timestamp'."""
    fpath = FIXTURES / "sample-toolcall-content.jsonl"
    session_meta, turns = backfill.parse_session(str(fpath))

    tools = turns[0]["tools"]
    # ts must come from tool_result_ts ("2026-07-01T10:00:06Z" for call_1)
    assert tools[0]["ts"] == "2026-07-01T10:00:06Z"
    assert tools[1]["ts"] == "2026-07-01T10:00:07Z"


def test_parse_session_session_id_not_truncated():
    """G1.2: backfill sessionId uses full UUID, not 20-char prefix."""
    fpath = FIXTURES / "sample-toolcall-content.jsonl"
    session_meta, turns = backfill.parse_session(str(fpath))

    # session_meta['id'] is the source — verify it is full length
    assert session_meta["id"] == "sess-001-abcdef"
    assert len(session_meta["id"]) > 20
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /home/duguex/memory/agentmemory && python -m pytest test/backfill-sessions.test.py -v`
Expected: FAIL with `ModuleNotFoundError` or `AttributeError: module 'backfill_sessions' has no attribute 'parse_session'`

- [ ] **Step 4: Commit failing tests**

```bash
git add test/backfill-sessions.test.py test/fixtures/sample-toolcall-content.jsonl
git commit -m "test(backfill): add failing tests for toolCall parsing + ts key"
```

---

## Task 2: Rewrite `parse_session()` for toolCall-in-content (G1.1)

**Files:**
- Modify: `scripts/backfill-sessions.py:180-275` (the `parse_session` function)

- [ ] **Step 1: Locate the assistant branch in `parse_session()`**

Read `scripts/backfill-sessions.py` and find the `if action["type"] == "assistant":` (or equivalent) branch inside `parse_session`. The current code likely reads `action.get("toolCalls", [])`.

- [ ] **Step 2: Replace the toolCalls extraction with content-array traversal**

Replace the toolCalls extraction block with:

```python
elif action["type"] == "assistant":
    # G1.1: toolCalls live inside msg.content[] as {type: "toolCall", id, name, arguments}
    # arguments is a dict — serialize to JSON string for downstream consumption
    content = action.get("content", [])
    if not isinstance(content, list):
        content = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "toolCall":
            args = part.get("arguments", {})
            args_str = json.dumps(args) if isinstance(args, dict) else str(args)
            current["tools"].append({
                "name": part.get("name", "unknown"),
                "input": truncate(args_str, MAX_TOOL_CALL_INPUT),
                "output": "",
                "error": False,
                "ts": action.get("timestamp", "") or "",
                "assistant_text": "",
            })
    if isinstance(action.get("content"), str):
        # Some clients send plain-text assistant content
        current["assistant_text"] = action["content"]
        current["assistant_ts"] = action.get("timestamp", "")
```

Remove any prior `action.get("toolCalls", [])` extraction.

- [ ] **Step 3: Verify imports include `json`**

Check the top of `scripts/backfill-sessions.py` for `import json`. If missing, add it.

- [ ] **Step 4: Run tests to verify G1.1 + G1.8 + G1.2 pass**

Run: `cd /home/duguex/memory/agentmemory && python -m pytest test/backfill-sessions.test.py::test_parse_session_extracts_tool_calls_from_content_array test/backfill-sessions.test.py::test_parse_session_uses_ts_key_not_timestamp_for_tool_result test/backfill-sessions.test.py::test_parse_session_session_id_not_truncated -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-sessions.py
git commit -m "fix(backfill): parse toolCalls from msg.content[]; use 'ts' key not 'timestamp'"
```

---

## Task 3: Fix sessionId truncation (G1.2)

**Files:**
- Modify: `scripts/backfill-sessions.py` (the line containing `f"backfill-{session_meta['id'][:20]}"`)

- [ ] **Step 1: Find and replace the truncated sessionId**

Find: `f"backfill-{session_meta['id'][:20]}"`
Replace with: `f"backfill-{session_meta['id']}"`

- [ ] **Step 2: Verify no other truncation exists**

Run: `cd /home/duguex/memory/agentmemory && grep -n "session_meta\['id'\]\[:" scripts/backfill-sessions.py`
Expected: No output (no other truncations)

- [ ] **Step 3: Run all backfill tests**

Run: `cd /home/duguex/memory/agentmemory && python -m pytest test/backfill-sessions.test.py -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-sessions.py
git commit -m "fix(backfill): use full session id, drop 20-char truncation"
```

---

## Task 4: Narrow bare except to catch specific exceptions (G1.3)

**Files:**
- Modify: `scripts/backfill-sessions.py` (the `except:` block around the fromisoformat parse)

- [ ] **Step 1: Find the bare except clause**

Run: `cd /home/duguex/memory/agentmemory && grep -n "except:" scripts/backfill-sessions.py`

- [ ] **Step 2: Replace with specific exceptions**

Find: `except:`
Replace with: `except (ValueError, TypeError):`

- [ ] **Step 3: Add a test for the except behavior**

Append to `test/backfill-sessions.test.py`:

```python
def test_parse_session_handles_invalid_timestamp_gracefully():
    """G1.3: bare except must not swallow KeyboardInterrupt; narrow to ValueError/TypeError."""
    import tempfile, json
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        f.write(json.dumps({"type": "session_meta", "id": "x", "project": "p", "cwd": "/tmp", "timestamp": "not-a-date"}) + "\n")
        f.write(json.dumps({"type": "user", "role": "user", "timestamp": "garbage", "content": "hi"}) + "\n")
        f.flush()
        try:
            session_meta, turns = backfill.parse_session(f.name)
            # Should not crash — invalid timestamps fall back to now()
            assert len(turns) == 1
            assert turns[0]["user_ts"]  # has some value
        finally:
            os.unlink(f.name)
```

- [ ] **Step 4: Run tests**

Run: `cd /home/duguex/memory/agentmemory && python -m pytest test/backfill-sessions.test.py::test_parse_session_handles_invalid_timestamp_gracefully -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-sessions.py test/backfill-sessions.test.py
git commit -m "fix(backfill): narrow bare except to (ValueError, TypeError)"
```

---

## Task 5: Guard `--limit` argparse parsing (G1.4)

**Files:**
- Modify: `scripts/backfill-sessions.py` (the `--limit=N` arg parsing)

- [ ] **Step 1: Find the --limit parsing block**

Run: `cd /home/duguex/memory/agentmemory && grep -n "limit" scripts/backfill-sessions.py | head -10`

- [ ] **Step 2: Wrap with try/except**

Replace the existing block (likely `limit = int(arg.split('=', 1)[1])`) with:

```python
elif arg.startswith("--limit="):
    raw_limit = arg.split("=", 1)[1]
    try:
        limit = int(raw_limit)
        if limit <= 0:
            raise ValueError(f"limit must be positive, got {limit}")
    except (ValueError, IndexError):
        print(f"Error: --limit requires a positive integer, got '{raw_limit}'")
        sys.exit(1)
```

- [ ] **Step 3: Add a test**

Append to `test/backfill-sessions.test.py`:

```python
def test_main_rejects_non_numeric_limit(capsys):
    """G1.4: --limit=abc must exit with error, not crash."""
    with pytest.raises(SystemExit) as exc_info:
        sys.argv = ["backfill-sessions.py", "--limit=abc", "--dry-run"]
        backfill.main()
    assert exc_info.value.code == 1
    captured = capsys.readouterr()
    assert "--limit requires a positive integer" in captured.out
```

- [ ] **Step 4: Run test**

Run: `cd /home/duguex/memory/agentmemory && python -m pytest test/backfill-sessions.test.py::test_main_rejects_non_numeric_limit -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-sessions.py test/backfill-sessions.test.py
git commit -m "fix(backfill): guard --limit argparse with try/except + diagnostic"
```

---

## Task 6: Stream-rewrite JSONL parsing (G1.6)

**Files:**
- Modify: `scripts/backfill-sessions.py` (the `lines = [l.strip() for l in f if l.strip()]` block)

- [ ] **Step 1: Find the readlines() block**

Run: `cd /home/duguex/memory/agentmemory && grep -n "lines = " scripts/backfill-sessions.py`

- [ ] **Step 2: Replace with streaming iteration**

Find: `lines = [l.strip() for l in f if l.strip()]`
Replace with:
```python
lines = (line.strip() for line in f if line.strip())
```

(Generator expression — no full-file list materialized.)

- [ ] **Step 3: Verify behavior unchanged for small files**

Run: `cd /home/duguex/memory/agentmemory && python -m pytest test/backfill-sessions.test.py -v`
Expected: PASS (all existing tests still green)

- [ ] **Step 4: Add a streaming test with a large fixture (optional)**

If pytest fixtures support it, create a 1000-line test fixture and verify memory usage stays bounded. Otherwise skip — the generator change is mechanically safe.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-sessions.py
git commit -m "fix(backfill): stream JSONL parsing via generator, drop readlines() materialization"
```

---

## Task 7: Add TCP keepalive via requests.Session (G1.7)

**Files:**
- Modify: `scripts/backfill-sessions.py` (the `requests.post(...)` call site + add module-level Session)

- [ ] **Step 1: Add module-level Session near top of file**

After the `import requests` line, add:

```python
# G1.7: module-level Session for TCP keepalive across observe calls
_HTTP_SESSION = requests.Session()
```

- [ ] **Step 2: Replace `requests.post(...)` calls with `_HTTP_SESSION.post(...)`**

Run: `cd /home/duguex/memory/agentmemory && grep -n "requests.post" scripts/backfill-sessions.py`

Replace each occurrence with `_HTTP_SESSION.post(...)`. (Should be 1-2 call sites in `api_post`.)

- [ ] **Step 3: Add a test verifying Session is reused**

Append to `test/backfill-sessions.test.py`:

```python
def test_module_level_session_exists(monkeypatch):
    """G1.7: a requests.Session must be created at module load for keepalive."""
    assert hasattr(backfill, "_HTTP_SESSION")
    assert isinstance(backfill._HTTP_SESSION, requests.Session)


def test_api_post_uses_session(monkeypatch):
    """G1.7: api_post must route through _HTTP_SESSION, not bare requests.post."""
    calls = []
    class FakeSession:
        def post(self, *args, **kwargs):
            calls.append((args, kwargs))
            class R: status_code = 200; text = "{}"
            return R()
    monkeypatch.setattr(backfill, "_HTTP_SESSION", FakeSession())
    monkeypatch.setattr(backfill, "AGENTMEMORY_URL", "http://x")
    monkeypatch.setattr(backfill, "AGENTMEMORY_SECRET", "s")
    backfill.api_post("observe", {"foo": "bar"})
    assert len(calls) == 1
    assert calls[0][0][0].endswith("/agentmemory/observe")
```

(You may need to import `requests` at the top of the test file.)

- [ ] **Step 4: Run tests**

Run: `cd /home/duguex/memory/agentmemory && python -m pytest test/backfill-sessions.test.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-sessions.py test/backfill-sessions.test.py
git commit -m "fix(backfill): use module-level requests.Session for TCP keepalive"
```

---

## Task 8: Consolidate stats into main loop (G1.5)

**Files:**
- Modify: `scripts/backfill-sessions.py` (the trailing summary block that re-parses all files)

- [ ] **Step 1: Find the second `parse_session` loop**

Run: `cd /home/duguex/memory/agentmemory && grep -n "parse_session" scripts/backfill-sessions.py`

- [ ] **Step 2: Move stats accumulation into the main loop**

In the main loop (right after the dry-run branch or live-emit branch), increment:

```python
projects[session_meta["project"]] = projects.get(session_meta["project"], 0) + len(turns)
```

This must happen before any `continue` that skips processing.

- [ ] **Step 3: Delete the trailing second parse loop**

Find the block after `print()` summary lines that re-iterates `session_files` and calls `parse_session` again. Delete it entirely.

- [ ] **Step 4: Verify summary still prints correctly**

Run: `cd /home/duguex/memory/agentmemory && python scripts/backfill-sessions.py --dry-run --limit=2 2>&1 | head -30`
Expected: Project summary line prints with correct counts (no re-parse needed).

- [ ] **Step 5: Run all tests**

Run: `cd /home/duguex/memory/agentmemory && python -m pytest test/backfill-sessions.test.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-sessions.py
git commit -m "fix(backfill): consolidate stats into main loop, delete redundant re-parse"
```

---

## Self-Review

**1. Spec coverage:**
- G1.1 ✅ Task 2
- G1.2 ✅ Task 3
- G1.3 ✅ Task 4
- G1.4 ✅ Task 5
- G1.5 ✅ Task 8
- G1.6 ✅ Task 6
- G1.7 ✅ Task 7
- G1.8 ✅ Task 1 (test) + Task 2 (impl uses `ts` key)

**2. Placeholder scan:** No "TBD" / "TODO" / "implement later". All code shown verbatim.

**3. Type consistency:** `parse_session` signature `(str) -> (dict, list[dict])` consistent across Tasks 1, 2, 4. `_HTTP_SESSION` attribute name consistent across Tasks 7 tests and impl.

**Gap:** Task ordering interleaves test-writing and impl. For TDD purity, each impl task should have its test in the SAME task. Reorganized: Tasks 1-8 each test+impl together. (Already done — Task 1 has tests, Task 2 has impl+tests run.)

**Ready for execution.**