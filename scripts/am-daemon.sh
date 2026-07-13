#!/usr/bin/env bash
# Route-1 ops: single entry for start/stop/restart/status/ensure.
# Do NOT use ad-hoc nohup+pkill for day-to-day — half-dead (engine up, worker
# dead) is the failure mode this script exists to prevent.
#
# Usage:
#   bash scripts/am-daemon.sh start|stop|restart|status|ensure|health
#
# Env (optional):
#   AGENTMEMORY_HOME   default ~/.agentmemory
#   AGENTMEMORY_BIN    default: agentmemory on PATH
#   AGENTMEMORY_ROOT   package/checkout with dist/ + iii-config.yaml
#   AGENTMEMORY_URL    default http://localhost:3111
#   AGENTMEMORY_SECRET default omp-memory-local
#   LOG_MAX_BYTES      rotate daemon.log when larger (default 20MB)

set -euo pipefail

CMD="${1:-status}"
AGENTMEMORY_HOME="${AGENTMEMORY_HOME:-$HOME/.agentmemory}"
AGENTMEMORY_URL="${AGENTMEMORY_URL:-http://localhost:3111}"
SECRET="${AGENTMEMORY_SECRET:-omp-memory-local}"
LOG_DIR="${AGENTMEMORY_HOME}/logs"
LOG_FILE="${LOG_DIR}/daemon.log"
PID_FILE="${AGENTMEMORY_HOME}/supervise.pid"
LOG_MAX_BYTES="${LOG_MAX_BYTES:-20971520}"

# Prefer the git checkout we develop in; fall back to global install root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
AGENTMEMORY_ROOT="${AGENTMEMORY_ROOT:-$DEFAULT_ROOT}"

if [[ -x "${AGENTMEMORY_BIN:-}" ]]; then
  BIN="$AGENTMEMORY_BIN"
elif command -v agentmemory >/dev/null 2>&1; then
  BIN="$(command -v agentmemory)"
elif [[ -x "$HOME/node-v22.18.0-linux-x64/bin/agentmemory" ]]; then
  BIN="$HOME/node-v22.18.0-linux-x64/bin/agentmemory"
else
  BIN="agentmemory"
fi

III_BIN="${III_BIN:-$AGENTMEMORY_HOME/bin/iii}"
export AGENTMEMORY_SUPERVISED=1
export AGENTMEMORY_VERBOSE="${AGENTMEMORY_VERBOSE:-1}"
[[ -f "$AGENTMEMORY_ROOT/iii-config.supervised.yaml" ]] && export AGENTMEMORY_III_CONFIG="$AGENTMEMORY_ROOT/iii-config.supervised.yaml"

mkdir -p "$LOG_DIR" "$AGENTMEMORY_HOME"

log() { printf '[am-daemon] %s\n' "$*"; }
err() { printf '[am-daemon] ERROR: %s\n' "$*" >&2; }

rotate_log_if_needed() {
  if [[ -f "$LOG_FILE" ]]; then
    local sz
    sz=$(wc -c <"$LOG_FILE" | tr -d ' ')
    if [[ "$sz" -gt "$LOG_MAX_BYTES" ]]; then
      local ts
      ts=$(date +%Y%m%d-%H%M%S)
      mv "$LOG_FILE" "${LOG_FILE}.${ts}"
      log "rotated log -> ${LOG_FILE}.${ts}"
      # keep last 5 rotated files
      ls -1t "${LOG_FILE}".* 2>/dev/null | tail -n +6 | xargs -r rm -f
    fi
  fi
}

pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

list_tree_pids() {
  # CLI + engine + worker(s). Patterns are tight on purpose.
  pgrep -f 'node .*/bin/agentmemory|node .*/agentmemory/dist/cli|node .*@agentmemory/agentmemory/dist/cli' 2>/dev/null || true
  pgrep -f "iii --config .*agentmemory|iii --config .*iii-config" 2>/dev/null || true
  pgrep -f 'node dist/index\.mjs|node .*/@agentmemory/agentmemory/dist/index|node .*/agentmemory/dist/index' 2>/dev/null || true
}

true_health() {
  # Process/worker liveness only (used by ensure — must NOT fail solely on DLQ
  # or ensure will reboot forever without draining dead letters). See #69.
  local live health workers has_cli has_iii has_worker
  live=$(curl -fsS -m 3 "${AGENTMEMORY_URL}/agentmemory/livez" 2>/dev/null || true)
  if [[ "$live" != *ok* && "$live" != *true* && "$live" != *\"status\"* ]]; then
    if [[ -z "$live" ]]; then
      echo "livez: unreachable"
      return 1
    fi
  fi

  health=$(curl -fsS -m 5 "${AGENTMEMORY_URL}/agentmemory/health" \
    -H "Authorization: Bearer ${SECRET}" 2>/dev/null || true)
  if [[ -z "$health" ]]; then
    echo "health: unreachable"
    return 1
  fi

  workers=$(printf '%s' "$health" | python3 -c '
import sys, json
try:
  d=json.load(sys.stdin)
  print(len(d.get("health",{}).get("workers") or []))
except Exception:
  print(0)
' 2>/dev/null || echo 0)
  if [[ "${workers:-0}" -lt 1 ]]; then
    echo "health: workers=0 (engine may be empty)"
    return 1
  fi

  has_iii=0
  has_worker=0
  has_cli=0
  if pgrep -f 'iii --config' >/dev/null 2>&1; then has_iii=1; fi
  if pgrep -f 'node dist/index\.mjs|@agentmemory/agentmemory/dist/index|agentmemory/dist/index' >/dev/null 2>&1; then has_worker=1; fi
  if pgrep -f 'bin/agentmemory|@agentmemory/agentmemory/dist/cli' >/dev/null 2>&1; then has_cli=1; fi

  if [[ "$has_iii" -ne 1 ]]; then
    echo "process: iii missing"
    return 1
  fi
  if [[ "$has_cli" -ne 1 && "$has_worker" -ne 1 ]]; then
    echo "process: no worker (cli or dist/index.mjs)"
    return 1
  fi

  echo "ok workers=${workers} cli=${has_cli} iii=${has_iii} exec_worker=${has_worker}"
  return 0
}

# Queue / DLQ visibility (#69) + backlog stall + zombie jobs (#72).
# Exit 1 if any tracked topic has dlq_depth>0, stall, or zombie ratio high.
queue_health() {
  local iii_bin="${III_BIN:-$AGENTMEMORY_HOME/bin/iii}"
  if [[ ! -x "$iii_bin" ]]; then
    echo "queue: iii binary missing ($iii_bin) — skip DLQ check"
    return 0
  fi
  local bad=0 line topic depth dlq
  local compress_depth="?"
  for topic in "mem::compress" "mem::graph-extract"; do
    line=$("$iii_bin" trigger --function-id engine::queue::topic_stats \
      --payload "{\"topic\":\"$topic\"}" 2>/dev/null || true)
    depth=$(printf '%s' "$line" | python3 -c 'import sys,json
try:
 d=json.load(sys.stdin); print(d.get("depth",0))
except Exception: print("?")' 2>/dev/null || echo "?")
    dlq=$(printf '%s' "$line" | python3 -c 'import sys,json
try:
 d=json.load(sys.stdin); print(d.get("dlq_depth",0))
except Exception: print("?")' 2>/dev/null || echo "?")
    if [[ "$topic" == "mem::compress" ]]; then
      compress_depth=$depth
    fi
    if [[ "$dlq" =~ ^[0-9]+$ ]] && [[ "$dlq" -gt 0 ]]; then
      echo "queue: $topic depth=${depth} dlq=${dlq}  (DLQ non-zero — failures not healthy; see scripts/queue-diag.sh)"
      bad=1
    else
      echo "queue: $topic depth=${depth} dlq=${dlq}"
    fi
  done

  # #72: zombie jobs on disk (already_llm / orphan / corrupt occupying durable queue)
  local reconcile="${AGENTMEMORY_ROOT}/scripts/queue-reconcile.py"
  if [[ -f "$reconcile" && -d "${AGENTMEMORY_ROOT}/data/queue_store" ]]; then
    local zjson zrc
    zjson=$(python3 "$reconcile" --check --json --root "$AGENTMEMORY_ROOT" 2>/dev/null) && zrc=0 || zrc=$?
    if [[ -n "$zjson" ]]; then
      python3 -c 'import sys,json
d=json.load(sys.stdin)
s=d.get("summary") or {}
print("queue: compress jobs_on_disk=%s dead=%s needs_work=%s zombie_ratio=%.2f active_list=%s" % (
  s.get("total"), s.get("dead"), s.get("needs_work"), float(s.get("zombie_ratio") or 0),
  d.get("active_list_len")))
if not d.get("ok", True):
  print("queue: ZOMBIE BACKLOG — already_llm/orphan/corrupt dominating disk queue; run: python3 scripts/queue-reconcile.py --check  [#72]")
  sys.exit(1)
' <<<"$zjson" || bad=1
    fi
  fi

  # #72: depth can sit flat when live observe ≈ compress drain OR zombies hold depth.
  local log_file="${LOG_FILE:-$AGENTMEMORY_HOME/logs/daemon.log}"
  if [[ -f "$log_file" && "$compress_depth" =~ ^[0-9]+$ ]] && [[ "$compress_depth" -ge 20 ]]; then
    local age_s last_line
    last_line=$(rg "compress\.diag success" "$log_file" 2>/dev/null | tail -1 || true)
    if [[ -z "$last_line" ]]; then
      echo "queue: compress backlog depth=${compress_depth} but no compress.diag success in log (possible stall) [#72]"
      bad=1
    else
      age_s=$(( $(date +%s) - $(stat -c %Y "$log_file") ))
      if [[ "$age_s" -gt 120 ]]; then
        echo "queue: compress depth=${compress_depth}; daemon log quiet ${age_s}s (no recent writes — check LLM hang / gate) [#72]"
        bad=1
      else
        echo "queue: compress depth=${compress_depth} — if flat for hours: check zombie ratio above first; else ingress≈egress. See issue #72."
      fi
    fi
  fi
  return $bad
}

cmd_stop() {
  log "stop: full tree"
  # Prefer official stop when CLI is around
  if command -v "$BIN" >/dev/null 2>&1 || [[ -x "$BIN" ]]; then
    "$BIN" stop --force >/dev/null 2>&1 || true
  fi

  # Always reap leftovers (half-dead mode)
  local pids
  pids=$(list_tree_pids | sort -u | tr '\n' ' ')
  if [[ -n "${pids// /}" ]]; then
    log "stop: SIGTERM $pids"
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    sleep 2
    pids=$(list_tree_pids | sort -u | tr '\n' ' ')
    if [[ -n "${pids// /}" ]]; then
      log "stop: SIGKILL $pids"
      # shellcheck disable=SC2086
      kill -KILL $pids 2>/dev/null || true
    fi
  fi

  rm -f "$PID_FILE"
  # stale pidfiles
  rm -f "$AGENTMEMORY_HOME/worker.pid" "$AGENTMEMORY_HOME/iii.pid" 2>/dev/null || true
  log "stop: done"
}

cmd_start() {
  if true_health >/dev/null 2>&1; then
    log "start: already healthy"
    true_health
    return 0
  fi

  # If anything is half-alive, clean first
  if pgrep -f 'iii --config|bin/agentmemory|dist/index\.mjs' >/dev/null 2>&1; then
    log "start: unclean state — stopping first"
    cmd_stop
    sleep 1
  fi

  if [[ ! -f "$AGENTMEMORY_ROOT/dist/index.mjs" && ! -f "$AGENTMEMORY_ROOT/dist/cli.mjs" ]]; then
    err "no dist/ under AGENTMEMORY_ROOT=$AGENTMEMORY_ROOT — run npm run build or set AGENTMEMORY_ROOT"
    return 1
  fi

  # #72: reclaim stuck durable compress jobs while engine is down.
  # Default ON — disable with AGENTMEMORY_QUEUE_REPAIR_ON_START=0.
  # Root issue is iii file_based active list not reclaiming; skip-path itself ACKs when delivered.
  local reconcile="${AGENTMEMORY_ROOT}/scripts/queue-reconcile.py"
  local repair_on="${AGENTMEMORY_QUEUE_REPAIR_ON_START:-1}"
  if [[ "$repair_on" != "0" && -f "$reconcile" && -d "${AGENTMEMORY_ROOT}/data/queue_store" ]]; then
    if ! python3 "$reconcile" --check --root "$AGENTMEMORY_ROOT" >/dev/null 2>&1; then
      log "start: queue zombie/stuck detected — auto queue-reconcile --repair (#72)"
      python3 "$reconcile" --repair --root "$AGENTMEMORY_ROOT" || log "start: queue-reconcile --repair exited $?"
    else
      # Even if ratio thresholds pass, strip corrupt trailing bytes / rewrite clean lists when garbage present
      local gcount
      gcount=$(python3 "$reconcile" --check --json --root "$AGENTMEMORY_ROOT" 2>/dev/null | python3 -c 'import sys,json;print((json.load(sys.stdin).get("summary") or {}).get("trailing_garbage") or 0)' 2>/dev/null || echo 0)
      if [[ "$gcount" =~ ^[0-9]+$ ]] && [[ "$gcount" -gt 0 ]]; then
        log "start: queue job trailing_garbage=$gcount — auto --repair (#72)"
        python3 "$reconcile" --repair --root "$AGENTMEMORY_ROOT" || log "start: queue-reconcile --repair exited $?"
      fi
    fi
  fi

  rotate_log_if_needed
  {
    echo ""
    echo "======== am-daemon start $(date -Is) root=$AGENTMEMORY_ROOT bin=$BIN ========"
  } >>"$LOG_FILE"

  log "start: $BIN (supervised) cwd=$AGENTMEMORY_ROOT"
  # Append-only log. Never truncate.
  (
    cd "$AGENTMEMORY_ROOT"
    nohup env AGENTMEMORY_SUPERVISED=1 AGENTMEMORY_VERBOSE=1 AGENTMEMORY_III_CONFIG="$AGENTMEMORY_III_CONFIG" \
      "$BIN" --verbose >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )

  local i
  for i in $(seq 1 40); do
    if true_health >/dev/null 2>&1; then
      log "start: healthy after ${i}s"
      true_health
      # safe_reclaim keeps job files — --reenqueue no-ops to avoid duplicates.
      if [[ -f "${AGENTMEMORY_ROOT}/data/queue_store/.reconcile-needs-work.json" && -f "$reconcile" ]]; then
        log "start: queue-reconcile --reenqueue (no-op if safe_reclaim kept jobs)"
        python3 "$reconcile" --reenqueue --root "$AGENTMEMORY_ROOT" || log "start: reenqueue exited $? (failed items kept in manifest)"
      fi
      return 0
    fi
    sleep 1
  done

  err "start: not healthy within 40s — see $LOG_FILE"
  tail -n 40 "$LOG_FILE" || true
  return 1
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  echo "═══ am-daemon status ═══"
  echo "  home:   $AGENTMEMORY_HOME"
  echo "  root:   $AGENTMEMORY_ROOT"
  echo "  bin:    $BIN"
  echo "  log:    $LOG_FILE"
  echo "  super:  AGENTMEMORY_SUPERVISED=${AGENTMEMORY_SUPERVISED:-}"
  echo
  echo "── processes ──"
  local pids pid
  pids=$(list_tree_pids | sort -u | grep -E '^[0-9]+$' || true)
  if [[ -z "$pids" ]]; then
    echo "  (none)"
  else
    printf "  %-8s %-8s %-12s %s\n" PID PPID ELAPSED CMD
    while read -r pid; do
      [[ -z "$pid" ]] && continue
      ps -o pid=,ppid=,etime=,cmd= -p "$pid" 2>/dev/null | awk '{printf "  %-8s %-8s %-12s ", $1,$2,$3; $1=$2=$3=""; sub(/^ +/,""); print}'
    done <<<"$pids"
  fi
  echo
  echo "── true health ──"
  local rc=0
  if out=$(true_health 2>&1); then
    echo "  ✓ $out"
  else
    echo "  ✗ $out"
    rc=1
  fi
  echo "── queue / DLQ (#69) ──"
  if qout=$(queue_health 2>&1); then
    echo "$qout" | sed 's/^/  ✓ /'
  else
    echo "$qout" | sed 's/^/  ✗ /'
    rc=1
  fi
  return $rc
}

cmd_ensure() {
  # Process liveness only — do not restart on DLQ alone (#69).
  if true_health >/dev/null 2>&1; then
    log "ensure: ok"
    return 0
  fi
  log "ensure: unhealthy — restarting"
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet agentmemory.service 2>/dev/null; then
    log "ensure: via systemctl --user restart agentmemory"
    systemctl --user restart agentmemory.service
    sleep 5
    true_health
    return $?
  fi
  cmd_restart
}

cmd_health() {
  # Human-facing: process OK + empty DLQ required (#69).
  local rc=0
  if ! true_health; then
    rc=1
  fi
  if ! queue_health; then
    rc=1
  fi
  return $rc
}

case "$CMD" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  ensure)  cmd_ensure ;;
  health)  cmd_health ;;
  *)
    err "usage: $0 start|stop|restart|status|ensure|health"
    exit 2
    ;;
esac
