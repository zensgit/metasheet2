#!/usr/bin/env bash
set -euo pipefail

# Simple smoke for Kanban MVP (backend + optional frontend)
# Usage:
#   API=http://localhost:8900 bash scripts/smoke-kanban.sh

API="${API:-${VITE_API_URL:-http://localhost:8900}}"
USER="${USER_ID:-dev}"
ROLES="${ROLES:-admin}"

echo "[i] Using API: $API"

# Runs curl, discards the response body, and prints only the HTTP status code
# ("000" on a transport-level failure such as connection refused). Never prints
# response bodies, so it is safe to use for requests carrying a bearer token.
curl_status() {
  local status
  status=$(curl -sS -o /dev/null -w '%{http_code}' "$@") || true
  printf '%s' "${status:-000}"
}

# Fails the whole script (printing the step label + status code, no body/token)
# unless the given status code is 2xx.
assert_2xx() {
  local label="$1" status="$2"
  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    echo "$label failed: HTTP $status (expected 2xx)"
    exit 1
  fi
  echo "$label succeeded: HTTP $status"
}

echo "\n[1/5] Health"
HEALTH_STATUS=$(curl_status "$API/health")
assert_2xx "[1/5] Health check" "$HEALTH_STATUS"

echo "\n[2/5] Plugins"
PLUGINS_STATUS=$(curl_status "$API/api/plugins")
assert_2xx "[2/5] Plugins endpoint" "$PLUGINS_STATUS"

VIEW_ID="${VIEW_ID:-board1}"

# All /api/kanban/** calls below are behind the global JWT gate (routes/kanban.ts),
# so a token is fetched once, upfront, and reused for every kanban call.
echo "\n[i] Fetching dev token from $API/api/auth/dev-token (non-production only; token not printed)"
DEV_TOKEN_JSON=$(curl -fsS -G "$API/api/auth/dev-token" \
  --data-urlencode "userId=$USER" \
  --data-urlencode "roles=$ROLES") \
  || { echo "[i] Failed to obtain dev token from $API/api/auth/dev-token (dev-only endpoint; unavailable when NODE_ENV=production)"; exit 1; }
DEV_TOKEN=$(printf '%s' "$DEV_TOKEN_JSON" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [[ -z "$DEV_TOKEN" ]]; then
  echo "[i] dev-token response did not contain a token field"
  exit 1
fi

echo "\n[3/5] GET Kanban view ($VIEW_ID)"
# Single request: -D - dumps response headers (for ETag) to stdout, -o discards
# the body, and -w appends the status code on its own trailing line.
VIEW_RAW=$(curl -sS -D - -o /dev/null -w '\n%{http_code}' \
  -H "Authorization: Bearer $DEV_TOKEN" \
  "$API/api/kanban/$VIEW_ID") || true
VIEW_STATUS=$(printf '%s\n' "$VIEW_RAW" | tail -n 1)
VIEW_STATUS="${VIEW_STATUS:-000}"
assert_2xx "[3/5] GET view" "$VIEW_STATUS"
ETAG=$(printf '%s\n' "$VIEW_RAW" | awk -F': ' '/^ETag/{gsub(/\r/,"",$2); print $2}')

if [[ -n "$ETAG" ]]; then
  echo "\n[3b] ETag check (If-None-Match)"
  ETAG_STATUS=$(curl_status \
    -H "Authorization: Bearer $DEV_TOKEN" \
    -H "If-None-Match: $ETAG" \
    "$API/api/kanban/$VIEW_ID")
  if [[ "$ETAG_STATUS" != "304" ]]; then
    echo "[3b] ETag check failed: HTTP $ETAG_STATUS (expected 304)"
    exit 1
  fi
  echo "[3b] ETag check succeeded: HTTP $ETAG_STATUS"
else
  echo "\n[3b] Skipped: GET view did not return an ETag header"
fi

echo "\n[4/5] POST state (persist minimal columns state)"
PAYLOAD='{"state":{"columns":[{"id":"todo","cards":["1","2"]}]}}'
STATE_STATUS=$(curl_status -X POST "$API/api/kanban/$VIEW_ID/state" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DEV_TOKEN" \
  -d "$PAYLOAD")
assert_2xx "[4/5] POST state" "$STATE_STATUS"

echo "\n[5/5] GET after POST"
FINAL_STATUS=$(curl_status \
  -H "Authorization: Bearer $DEV_TOKEN" \
  "$API/api/kanban/$VIEW_ID")
assert_2xx "[5/5] GET after POST" "$FINAL_STATUS"

echo "\n[i] Smoke complete"
