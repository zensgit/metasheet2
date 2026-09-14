#!/usr/bin/env bash
set -euo pipefail

# Simple smoke for Kanban MVP (backend + optional frontend)
# Usage:
#   API=http://localhost:8900 bash scripts/smoke-kanban.sh

API="${API:-${VITE_API_URL:-http://localhost:8900}}"
USER="${USER_ID:-dev}"
ROLES="${ROLES:-admin}"

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
echo "[4a] Fetching dev token from $API/api/auth/dev-token (non-production only; token not printed)"
DEV_TOKEN_JSON=$(curl -fsS -G "$API/api/auth/dev-token" \
  --data-urlencode "userId=$USER" \
  --data-urlencode "roles=$ROLES") \
  || { echo "[4a] Failed to obtain dev token from $API/api/auth/dev-token (dev-only endpoint; unavailable when NODE_ENV=production)"; exit 1; }
DEV_TOKEN=$(printf '%s' "$DEV_TOKEN_JSON" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [[ -z "$DEV_TOKEN" ]]; then
  echo "[4a] dev-token response did not contain a token field"
  exit 1
fi

PAYLOAD='{"state":{"columns":[{"id":"todo","cards":["1","2"]}]}}'
STATE_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/api/kanban/$VIEW_ID/state" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DEV_TOKEN" \
  -d "$PAYLOAD") || STATE_STATUS="000"
if [[ "$STATE_STATUS" -lt 200 || "$STATE_STATUS" -ge 300 ]]; then
  echo "[4/5] POST state failed: HTTP $STATE_STATUS (expected 2xx)"
  exit 1
fi
echo "[4/5] POST state succeeded: HTTP $STATE_STATUS"

echo "\n[5/5] GET after POST"
curl -fsS "$API/api/kanban/$VIEW_ID" || true

echo "\n[i] Smoke complete"

