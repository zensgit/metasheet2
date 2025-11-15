#!/usr/bin/env bash
set -euo pipefail

# Simple smoke for Kanban MVP (backend + optional frontend)
# Usage:
#   API=http://localhost:8900 bash scripts/smoke-kanban.sh

API="${API:-${VITE_API_URL:-http://localhost:8900}}"
USER="${USER_ID:-dev}"

echo "[i] Using API: $API"

echo "\n[1/5] Health"
curl -fsS "$API/health" || { echo "Health check failed"; exit 1; }

echo "\n[2/5] Plugins"
curl -fsS "$API/api/plugins" || { echo "Plugins endpoint failed"; exit 1; }

VIEW_ID="${VIEW_ID:-board1}"
echo "\n[3/5] GET Kanban view ($VIEW_ID)"
ETAG=$(curl -fsSI "$API/api/kanban/$VIEW_ID" | awk -F': ' '/^ETag/{gsub(/\r/,"",$2); print $2}') || true
curl -fsS "$API/api/kanban/$VIEW_ID" || echo "(info) GET may return 404 if view not provisioned"

if [[ -n "$ETAG" ]]; then
  echo "\n[3b] ETag check (If-None-Match)"
  curl -fsSI -H "If-None-Match: $ETAG" "$API/api/kanban/$VIEW_ID" | head -n 1 || true
fi

echo "\n[4/5] POST state (persist minimal columns state)"
PAYLOAD='{"state":{"columns":[{"id":"todo","cards":["1","2"]}]}}'
curl -fsS -X POST "$API/api/kanban/$VIEW_ID/state" \
  -H 'Content-Type: application/json' \
  -H "x-user-id: $USER" \
  -d "$PAYLOAD" -i | head -n 1 || true

echo "\n[5/5] GET after POST"
curl -fsS "$API/api/kanban/$VIEW_ID" || true

echo "\n[i] Smoke complete"

