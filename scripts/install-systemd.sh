#!/usr/bin/env bash
# Render and install the user systemd units for this checkout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${AGENTMEMORY_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
UNIT_DIR="${AGENTMEMORY_SYSTEMD_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
BIN="${AGENTMEMORY_BIN:-}"

if [[ -z "$BIN" ]]; then
  BIN="$(command -v agentmemory 2>/dev/null || true)"
fi
if [[ -z "$BIN" ]]; then
  printf '[install-systemd] ERROR: agentmemory binary not found; set AGENTMEMORY_BIN\n' >&2
  exit 1
fi
if [[ ! -f "$ROOT/iii-config.supervised.yaml" ]]; then
  printf '[install-systemd] ERROR: supervised config missing under %s\n' "$ROOT" >&2
  exit 1
fi

BIN_DIR="$(dirname "$BIN")"
TEMPLATE_DIR="$ROOT/deploy/systemd"
mkdir -p "$UNIT_DIR"

render_unit() {
  local template="$1"
  local destination="$2"
  local content
  content="$(cat "$template")"
  content="${content//@AGENTMEMORY_ROOT@/$ROOT}"
  content="${content//@AGENTMEMORY_BIN@/$BIN}"
  content="${content//@AGENTMEMORY_BIN_DIR@/$BIN_DIR}"
  printf '%s\n' "$content" > "$destination"
  chmod 0644 "$destination"
}

render_unit "$TEMPLATE_DIR/agentmemory.service.in" "$UNIT_DIR/agentmemory.service"
render_unit "$TEMPLATE_DIR/agentmemory-ensure.service.in" "$UNIT_DIR/agentmemory-ensure.service"
render_unit "$TEMPLATE_DIR/agentmemory-ensure.timer.in" "$UNIT_DIR/agentmemory-ensure.timer"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload
fi

printf '[install-systemd] installed units in %s\n' "$UNIT_DIR"
printf '[install-systemd] next: systemctl --user enable --now agentmemory.service agentmemory-ensure.timer\n'
