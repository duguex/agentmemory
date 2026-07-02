#!/usr/bin/env bash
# agentmemory 数据备份与恢复脚本
# 使用官方 REST API export/import 接口

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.agentmemory/backups}"
AGENTMEMORY_URL="${AGENTMEMORY_URL:-http://localhost:3111}"
AGENTMEMORY_SECRET="${AGENTMEMORY_SECRET:-}"
AUTH=()
[ -n "${AGENTMEMORY_SECRET:-}" ] && AUTH=(-H "Authorization: Bearer $AGENTMEMORY_SECRET")
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

case "${1:-help}" in
  export|backup)
    FILE="$BACKUP_DIR/agentmemory-export-$TIMESTAMP.json"
    echo "Exporting to $FILE ..."
    curl -s "$AGENTMEMORY_URL/agentmemory/export" "${AUTH[@]}" | python3 -m json.tool > "$FILE"
    SIZE=$(wc -c < "$FILE")
    echo "Done: $((SIZE / 1024)) KB"
    # Keep last 5 backups, remove older
    ls -t "$BACKUP_DIR"/agentmemory-export-*.json 2>/dev/null | tail -n +6 | xargs -r rm
    ;;

  import|restore)
    FILE="${2:-}"
    if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
      echo "Usage: $0 import <backup-file.json>"
      echo ""
      echo "Available backups:"
      ls -lh "$BACKUP_DIR"/agentmemory-export-*.json 2>/dev/null || echo "  (none)"
      exit 1
    fi
    echo "Importing $FILE ..."
    echo "Mode: replace"
    jq -c '{exportData: ., strategy: "replace"}' "$FILE" |
    curl -s -X POST "$AGENTMEMORY_URL/agentmemory/import" \
      -H "Content-Type: application/json" \
      "${AUTH[@]}" \
      --data-binary @-
    echo ""
    ;;

  list)
    echo "Available backups:"
    ls -lh "$BACKUP_DIR"/agentmemory-export-*.json 2>/dev/null | awk '{print "  " $NF " (" $5 ")"}' || echo "  (none)"
    ;;

  info)
    echo "AgentMemory Backup Tool"
    echo "  Server: $AGENTMEMORY_URL"
    echo "  Backup dir: $BACKUP_DIR"
    echo ""
    echo "Usage:"
    echo "  $0 export              # 导出全部数据"
    echo "  $0 import <file.json>  # 导入备份"
    echo "  $0 list                # 列出已备份文件"
    ;;

  *)
    echo "Usage: $0 {export|import|list|info}"
    exit 1
    ;;
esac