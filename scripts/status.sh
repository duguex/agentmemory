#!/bin/bash
# One-shot system status for agentmemory.
# Run from anywhere:  bash scripts/status.sh
#
# Shows: daemon health, processes, queues, observations, recent
# LLM activity, DLQ state, and open issues. Designed to be the first
# thing you run when something looks wrong.

set -uo pipefail

AGENTMEMORY_URL="${AGENTMEMORY_URL:-http://localhost:3111}"
SECRET="${AGENTMEMORY_SECRET:-omp-memory-local}"
III_BIN="${III_BIN:-/home/duguex/.agentmemory/bin/iii}"
AGENTMEMORY_HOME="${AGENTMEMORY_HOME:-$HOME/.agentmemory}"

# Colors (only if stdout is a terminal)
if [ -t 1 ]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RED=$'\033[31m'
  GRN=$'\033[32m'
  YEL=$'\033[33m'
  BLU=$'\033[34m'
  RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; BLU=""; RST=""
fi

section() {
  echo
  echo "${BOLD}═══ $* ═══${RST}"
}

kv() {
  # Print "key: value" with key dimmed
  printf "  ${DIM}%-22s${RST} %s\n" "$1" "$2"
}

ok()    { printf "  ${GRN}✓${RST} %s\n" "$*"; }
warn()  { printf "  ${YEL}!${RST} %s\n" "$*"; }
fail()  { printf "  ${RED}✗${RST} %s\n" "$*"; }

# ──────────────────────────────────────────────────────────────
section "Processes"
# ──────────────────────────────────────────────────────────────
ps aux | grep -E "node.*dist/index|iii --config" | grep -v grep | awk '{print $2, $11, $12, $13, $14}' | while read -r pid cmd1 cmd2 cmd3 cmd4; do
  if [ -n "$pid" ]; then
    printf "  pid=%-7s %s %s %s %s\n" "$pid" "$cmd1" "$cmd2" "$cmd3" "$cmd4"
  fi
done

WORKER_PID_FILE="$AGENTMEMORY_HOME/worker.pid"
if [ -f "$WORKER_PID_FILE" ]; then
  kv "worker.pid" "$(cat $WORKER_PID_FILE)"
fi
ENGINE_PID_FILE="$AGENTMEMORY_HOME/iii.pid"
if [ -f "$ENGINE_PID_FILE" ]; then
  kv "engine pid" "$(cat $ENGINE_PID_FILE)"
fi

# ──────────────────────────────────────────────────────────────
section "Daemon health"
# ──────────────────────────────────────────────────────────────
HEALTH=$(curl -s -m 5 "$AGENTMEMORY_URL/agentmemory/health" -H "Authorization: Bearer $SECRET" 2>/dev/null)
if [ -z "$HEALTH" ] || ! echo "$HEALTH" | python3 -c "import sys,json; json.loads(sys.stdin.read())" 2>/dev/null; then
  fail "daemon not responding at $AGENTMEMORY_URL"
  echo
  echo "  Hint: check if the worker.pid process is alive, or restart:"
  echo "    nohup agentmemory > /tmp/daemon.log 2>&1 &"
  exit 0
fi

echo "$HEALTH" | python3 -c "
import sys, json
d = json.load(sys.stdin)
h = d['health']
cb = d['circuitBreaker']
DIM = '\033[2m'
BOLD = '\033[1m'
RST = '\033[0m'
status = h['status']
icon = '\033[32m✓\033[0m' if status == 'healthy' else '\033[31m✗\033[0m'
print(f'  {icon} status:           {status}')
print(f'  {DIM}uptime:{RST}            {h[\"uptimeSeconds\"]/3600:.1f}h ({h[\"uptimeSeconds\"]/60:.0f}min)')
print(f'  {DIM}event loop lag:{RST}    {h[\"eventLoopLagMs\"]:.2f}ms')
print(f'  {DIM}memory:{RST}           {h[\"memory\"][\"heapUsed\"]/1024/1024:.0f}MB heap / {h[\"memory\"][\"rss\"]/1024/1024:.0f}MB RSS')
print(f'  {DIM}workers:{RST}          {len(h[\"workers\"])}')
for w in h['workers']:
    print(f'    pid={w[\"pid\"]} active={w[\"active_invocations\"]} funcs={w.get(\"function_count\", \"?\")}')
print(f'  {DIM}circuit:{RST}          {cb[\"state\"]} (failures={cb[\"failures\"]})')
print()
print(f'  {BOLD}function metrics:{RST}')
for m in d['functionMetrics']:
    rate = 100 * m['successCount'] / m['totalCalls'] if m['totalCalls'] else 0
    color = '\033[32m' if rate >= 80 else '\033[33m' if rate >= 50 else '\033[31m'
    print(f'    {m[\"functionId\"]:25s} {color}{m[\"successCount\"]:>5}/{m[\"totalCalls\"]:<5} ({rate:5.1f}%) avgLatency={m[\"avgLatencyMs\"]/1000:.1f}s{RST}')
"

# ──────────────────────────────────────────────────────────────
section "Queues"
# ──────────────────────────────────────────────────────────────
for TOPIC in "mem::compress" "mem::graph-extract"; do
  STATS=$($III_BIN trigger --function-id engine::queue::topic_stats --payload "{\"topic\":\"$TOPIC\"}" 2>/dev/null)
  if [ -n "$STATS" ]; then
    echo "$STATS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
depth = d['depth']
dlq = d['dlq_depth']
icon = '\033[32m✓\033[0m' if (depth == 0 and dlq == 0) else '\033[33m⚠\033[0m' if (dlq > 0) else '\033[34m•\033[0m'
print(f\"  {icon} $TOPIC: depth={depth} dlq={dlq} consumers={d['consumer_count']}\")
"
  fi
done

# ──────────────────────────────────────────────────────────────
section "Corpus quality"
# ──────────────────────────────────────────────────────────────
python3 << EOF
import json, urllib.request
secret = "$SECRET"
try:
    r = urllib.request.Request('$AGENTMEMORY_URL/agentmemory/sessions?limit=200', headers={'Authorization': f'Bearer {secret}'})
    sessions = json.loads(urllib.request.urlopen(r, timeout=10).read())['sessions']
except Exception as e:
    print(f"  ${RED}✗${RST} cannot list sessions: {e}")
    exit()

bf = [s for s in sessions if s['id'].startswith('backfill-')]
llm=syn=unk=0
total_sessions = len(sessions)
for s in bf:
    r2 = urllib.request.Request(f'$AGENTMEMORY_URL/agentmemory/observations?sessionId={s["id"]}', headers={'Authorization': f'Bearer {secret}'})
    obs = json.loads(urllib.request.urlopen(r2, timeout=5).read())['observations']
    for o in obs:
        k = o.get('compressionKind')
        if k == 'llm': llm += 1
        elif k == 'synthetic': syn += 1
        else: unk += 1
total = llm + syn + unk
if total:
    pct = 100*llm/total
    icon = '\033[32m✓\033[0m' if pct >= 99 else '\033[33m⚠\033[0m' if pct >= 90 else '\033[31m✗\033[0m'
    print(f"  {icon} backfill observations: {pct:.1f}% LLM-compressed ({llm}/{total})")
    print(f"      synthetic: {syn}, unknown: {unk}")
    print(f"  ${DIM}backfill sessions:${RST}    {len(bf)}/{total_sessions}")
else:
    print("  ${YEL}!${RST} no backfill obs found")
EOF

# ──────────────────────────────────────────────────────────────
section "Ollama"
# ──────────────────────────────────────────────────────────────
OLLAMA=$(curl -s -m 3 http://localhost:11434/api/ps 2>/dev/null)
if [ -n "$OLLAMA" ]; then
  echo "$OLLAMA" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for m in d.get('models', []):
    vram = m.get('size_vram', 0) / 1e9
    print(f\"  ${DIM}model:${RST}        {m['name']} ({vram:.1f}GB VRAM)\")
"
else
  warn "Ollama not responding at localhost:11434"
fi

# ──────────────────────────────────────────────────────────────
section "Recent daemon log"
# ──────────────────────────────────────────────────────────────
# Find the most recent daemon log (any /tmp/daemon-*.log or /tmp/daemon-*-*.log)
LOG=""
LATEST_MTIME=0
for f in /tmp/daemon-*.log; do
  if [ -f "$f" ]; then
    MTIME=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    if [ "$MTIME" -gt "$LATEST_MTIME" ]; then
      LATEST_MTIME=$MTIME
      LOG="$f"
    fi
  fi
done
if [ -n "$LOG" ] && [ -f "$LOG" ]; then
  echo "  ${DIM}from $LOG:${RST}"
  tail -5 "$LOG" | sed 's/^/    /'
fi

# ──────────────────────────────────────────────────────────────
section "Open issues"
# ──────────────────────────────────────────────────────────────
if command -v gh &> /dev/null; then
  COUNT=$(gh issue list --repo duguex/agentmemory --state open --limit 100 2>/dev/null | wc -l)
  printf "  ${BLU}%d${RST} open issues\n" "$COUNT"
  printf "  Run ${DIM}gh issue list --repo duguex/agentmemory --state open${RST} to see them\n"
else
  warn "gh CLI not installed"
fi

# ──────────────────────────────────────────────────────────────
section "Quick links"
# ──────────────────────────────────────────────────────────────
printf "  ${DIM}REST API:${RST}     %s\n" "$AGENTMEMORY_URL"
printf "  ${DIM}Engine WS:${RST}    ws://localhost:49134\n"
printf "  ${DIM}Viewer:${RST}       http://localhost:3113 (or 3114/3115 if 3113 in use)\n"
printf "  ${DIM}Docs:${RST}         docs/architecture.md, docs/IMPROVEMENTS.md\n"
printf "\n"
