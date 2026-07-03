"""Test that tool observations use tool_result_ts, not user prompt ts."""
from __future__ import annotations
import sys
import os
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import importlib.util
spec = importlib.util.spec_from_file_location("backfill_sessions", SCRIPTS_DIR / "backfill-sessions.py")
backfill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backfill)

FIXTURES = Path(__file__).parent / "fixtures"


def test_tool_obs_uses_tool_result_ts_not_user_prompt_ts():
    """G1.8: Tool dicts must use 'ts' key (built at line ~261), read at line ~383."""
    fpath = FIXTURES / "backfill-tool-ts.jsonl"
    session_meta, turns = backfill.parse_session(str(fpath))

    tools = turns[0]["tools"]
    assert len(tools) == 1, f"Expected 1 tool, got {len(tools)}"
    # The tool ran at 10:00:30Z, NOT 10:00:00Z (user prompt time)
    assert tools[0]["ts"] == "2026-07-01T10:00:30Z", \
        f"Expected tool ts '2026-07-01T10:00:30Z' (from tool_result_ts), got {tools[0]['ts']!r}"
    assert tools[0]["ts"] != "2026-07-01T10:00:00Z", \
        "Tool ts must NOT be the user prompt timestamp"
