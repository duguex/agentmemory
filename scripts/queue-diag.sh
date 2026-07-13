#!/bin/bash
# queue-diag.sh — P0 one-shot queue + compress diagnostics for agentmemory.
#
# Usage:
#   bash scripts/queue-diag.sh
#   bash scripts/queue-diag.sh --json
#   bash scripts/queue-diag.sh --log /tmp/daemon-restart.log
#   LOG=... SECRET=... bash scripts/queue-diag.sh
#
# Collects: topic_stats (compress/graph), DLQ sample, /health metrics,
# Ollama process list, and recent compress.diag / error lines from logs.

set -uo pipefail

AGENTMEMORY_URL="${AGENTMEMORY_URL:-http://localhost:3111}"
SECRET="${AGENTMEMORY_SECRET:-omp-memory-local}"
III_BIN="${III_BIN:-$HOME/.agentmemory/bin/iii}"
AGENTMEMORY_HOME="${AGENTMEMORY_HOME:-$HOME/.agentmemory}"
JSON=0
LOG_HINT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --log) LOG_HINT="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Prefer explicit log, then common redirects, then nothing.
pick_log() {
  if [ -n "$LOG_HINT" ] && [ -f "$LOG_HINT" ]; then
    echo "$LOG_HINT"
    return
  fi
  for c in \
    "${AGENTMEMORY_HOME}/logs/daemon.log" \
    /tmp/daemon-restart.log \
    /tmp/daemon-repro.log \
    /tmp/daemon.log
  do
    if [ -f "$c" ]; then
      echo "$c"
      return
    fi
  done
  echo ""
}

LOG_FILE="$(pick_log)"

iii_json() {
  local fn="$1"
  local payload="$2"
  if [ ! -x "$III_BIN" ]; then
    echo "{\"error\":\"iii binary missing: $III_BIN\"}"
    return 1
  fi
  "$III_BIN" trigger --function-id "$fn" --payload "$payload" 2>/dev/null || echo "{\"error\":\"iii trigger failed: $fn\"}"
}

if [ "$JSON" = "1" ]; then
  tmpdir="$(mktemp -d)"
  iii_json engine::queue::topic_stats '{"topic":"mem::compress"}' >"$tmpdir/compress.json"
  iii_json engine::queue::topic_stats '{"topic":"mem::graph-extract"}' >"$tmpdir/graph.json"
  iii_json engine::queue::dlq_messages '{"topic":"mem::compress","limit":15}' >"$tmpdir/dlq.json"
  curl -sS -m 8 -H "Authorization: Bearer ${SECRET}" \
    "${AGENTMEMORY_URL}/agentmemory/health" >"$tmpdir/health.json" 2>/dev/null || echo '{}' >"$tmpdir/health.json"
  curl -sS -m 3 http://localhost:11434/api/ps >"$tmpdir/ollama.json" 2>/dev/null || echo '{}' >"$tmpdir/ollama.json"
  if [ -n "$LOG_FILE" ] && [ -f "$LOG_FILE" ]; then
    rg -n "compress\.diag|Compression failed|parse_failed|llm_unavailable|orphan" "$LOG_FILE" 2>/dev/null \
      | tail -40 >"$tmpdir/log.txt" || true
  else
    : >"$tmpdir/log.txt"
  fi
  python3 - <<PY
import json
from pathlib import Path
td = Path(r"""$tmpdir""")
def load(name, default):
    p = td / name
    try:
        return json.loads(p.read_text() or "null")
    except Exception:
        return default
lines = (td / "log.txt").read_text(errors="replace").splitlines()
out = {
  "compress": load("compress.json", {}),
  "graph_extract": load("graph.json", {}),
  "dlq_sample": load("dlq.json", []),
  "health": load("health.json", {}),
  "ollama": load("ollama.json", {}),
  "log_file": r"""$LOG_FILE""",
  "recent_log_lines": lines,
}
print(json.dumps(out, indent=2, ensure_ascii=False))
PY
  rm -rf "$tmpdir"
  exit 0
fi

# ── human-readable ──────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YEL=$'\033[33m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; RST=""
fi

echo "${BOLD}═══ agentmemory queue-diag ═══${RST}"
echo "  url:    $AGENTMEMORY_URL"
echo "  iii:    $III_BIN"
echo "  log:    ${LOG_FILE:-"(none found — pass --log PATH)"}"
echo "  time:   $(date -Iseconds)"

echo
echo "${BOLD}── Queue: mem::compress ──${RST}"
iii_json engine::queue::topic_stats '{"topic":"mem::compress"}' | python3 -c '
import sys, json
d=json.load(sys.stdin)
if "error" in d and len(d)==1:
  print("  ERROR:", d["error"]); raise SystemExit
depth=d.get("depth", "?"); dlq=d.get("dlq_depth", "?"); c=d.get("consumer_count", "?")
icon="OK" if depth==0 and dlq==0 else ("DLQ" if (isinstance(dlq,int) and dlq>0) else "BUSY")
print(f"  [{icon}] depth={depth}  dlq={dlq}  consumers={c}")
print(f"  raw: {json.dumps(d, ensure_ascii=False)}")
'

echo
echo "${BOLD}── Queue: mem::graph-extract ──${RST}"
iii_json engine::queue::topic_stats '{"topic":"mem::graph-extract"}' | python3 -c '
import sys, json
d=json.load(sys.stdin)
if "error" in d and len(d)==1:
  print("  ERROR:", d["error"]); raise SystemExit
print("  depth=%s  dlq=%s  consumers=%s" % (
  d.get("depth"), d.get("dlq_depth"), d.get("consumer_count")))
'

echo
echo "${BOLD}── Health / compress metrics ──${RST}"
curl -sS -m 8 -H "Authorization: Bearer ${SECRET}" \
  "${AGENTMEMORY_URL}/agentmemory/health" 2>/dev/null | python3 -c '
import sys, json
try:
  d=json.load(sys.stdin)
except Exception as e:
  print("  ERROR: health fetch failed:", e); raise SystemExit
cb = (d.get("circuitBreaker") or {})
print("  status=%s  circuit=%s" % (d.get("status"), cb.get("state")))
for m in d.get("functionMetrics") or []:
  fid = m.get("functionId")
  if fid not in ("mem::compress", "mem::summarize"):
    continue
  sc=m.get("successCount",0); fc=m.get("failureCount",0); tc=m.get("totalCalls",0)
  rate=(100*sc/tc) if tc else 0
  print("  %s: %s/%s (%.1f%%) fail=%s avgLat=%.0fms" % (
    fid, sc, tc, rate, fc, m.get("avgLatencyMs",0)))
' || echo "  ERROR: cannot reach health endpoint"

echo
echo "${BOLD}── DLQ sample (mem::compress, up to 10) ──${RST}"
iii_json engine::queue::dlq_messages '{"topic":"mem::compress","limit":10}' | python3 -c '
import sys, json
from datetime import datetime, timezone
raw=sys.stdin.read()
try:
  d=json.loads(raw)
except Exception as e:
  print("  ERROR: bad dlq json", e); raise SystemExit
if isinstance(d, dict) and d.get("error"):
  print("  ERROR:", d["error"]); raise SystemExit
if not d:
  print("  (empty)")
  raise SystemExit
for i,m in enumerate(d[:10], 1):
  p=m.get("payload") or {}
  ts=m.get("failed_at")
  try:
    ts_s=datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if isinstance(ts,(int,float)) else str(ts)
  except Exception:
    ts_s=str(ts)
  mid = str(m.get("id") or "?")
  print("  [%d] id=%s… retries=%s failed_at=%s" % (i, mid[:12], m.get("retries"), ts_s))
  print("      sessionId=%s observationId=%s" % (p.get("sessionId"), p.get("observationId")))
  print("      error=%s" % (m.get("error"),))
  err = str(m.get("error") or "")
  if "function call failed" in err:
    print("      hint: grep compress.diag + observationId in daemon log for reason/detail")
'

echo
echo "${BOLD}── Ollama ──${RST}"
curl -sS -m 3 http://localhost:11434/api/ps 2>/dev/null | python3 -c '
import sys, json
try:
  d=json.load(sys.stdin)
except Exception:
  print("  (ollama unreachable)"); raise SystemExit
ms=d.get("models") or []
if not ms:
  print("  (no models loaded)")
for m in ms:
  name = m.get("name")
  size = (m.get("size") or 0)//10**9
  print("  · %s size≈%sGB" % (name, size))
' || echo "  (ollama unreachable)"


echo
echo "${BOLD}── Zombie compress jobs on disk (#72) ──${RST}"
RECONCILE="$(cd "$(dirname "$0")" && pwd)/queue-reconcile.py"
ROOT_GUESS="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$RECONCILE" ]; then
  if python3 "$RECONCILE" --check --root "${AGENTMEMORY_ROOT:-$ROOT_GUESS}" 2>/dev/null; then
    :
  else
    rc=$?
    echo "  (check exit=$rc — repair: stop daemon, python3 scripts/queue-reconcile.py --repair, start, --reenqueue)"
  fi
else
  echo "  (queue-reconcile.py missing)"
fi

echo
echo "${BOLD}── Recent compress.diag / errors (log) ──${RST}"
if [ -z "$LOG_FILE" ]; then
  echo "  (no log file — start with: agentmemory --verbose > ~/.agentmemory/logs/daemon.log 2>&1)"
  echo "  or: bash scripts/queue-diag.sh --log /path/to/daemon.log"
else
  # Prefer structured compress.diag lines; fall back to legacy messages.
  if ! rg -n "compress\.diag|event.: .compress\.diag" "$LOG_FILE" 2>/dev/null | tail -25; then
    rg -n "Compression failed|parse_failed|llm_unavailable|orphan observation|Observation compressed" \
      "$LOG_FILE" 2>/dev/null | tail -25 || echo "  (no matching lines in $LOG_FILE)"
  fi
fi

echo
echo "${BOLD}── Grep cheatsheet ──${RST}"
echo "  rg 'compress.diag' ${LOG_FILE:-LOG}"
echo "  rg '\"reason\":' ${LOG_FILE:-LOG}   # orphan_observation|parse_failed|llm_unavailable|..."
echo "  bash scripts/trace-obs.sh <sessionId> <observationId>"
echo "  python3 scripts/queue-reconcile.py --check     # zombie already_llm/orphan on disk (#72)"
echo "  python3 scripts/queue-reconcile.py --repair    # offline purge dead + stash needs_work"
echo "  python3 scripts/drain-dlq.py          # snapshot then discard DLQ"
echo
echo "${DIM}done.${RST}"
