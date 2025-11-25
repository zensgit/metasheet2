#!/usr/bin/env bash
set -euo pipefail

# Populate plugin reload histogram with multiple samples.
# Requires server running on localhost:8900 and JWT script available.

PLUGIN_NAME="${PLUGIN_NAME:-example-plugin}"
RELOAD_COUNT="${RELOAD_COUNT:-7}"
API_BASE="${API_BASE:-http://localhost:8900}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if [ ! -x scripts/phase5-dev-jwt.sh ]; then
  echo "Missing executable scripts/phase5-dev-jwt.sh" >&2
  exit 1
fi

TOKEN=$(./scripts/phase5-dev-jwt.sh)

echo "[plugin-reload] Target plugin: $PLUGIN_NAME, attempts: $RELOAD_COUNT"

for i in $(seq 1 "$RELOAD_COUNT"); do
  CONFIRM=$(curl -s -H "Authorization: Bearer $TOKEN" -X POST "$API_BASE/api/admin/safety/confirm" | jq -r '.token')
  if [ -z "$CONFIRM" ] || [ "$CONFIRM" = "null" ]; then
    echo "[plugin-reload] Failed to get confirm token (iteration $i)" >&2
    exit 1
  fi
  RESP=$(curl -s -H "Authorization: Bearer $TOKEN" -X POST "$API_BASE/api/admin/plugins/reload?name=$PLUGIN_NAME&confirm_token=$CONFIRM")
  STATUS=$(echo "$RESP" | jq -r '.status // .result // "unknown"')
  echo "[plugin-reload] $i/$RELOAD_COUNT status=$STATUS"
  sleep 0.6
done

echo "[plugin-reload] Checking metrics for histogram/count..."
curl -s "$API_BASE/metrics/prom" | grep -E 'metasheet_plugin_reload_duration_seconds_(bucket|count|sum)' || {
  echo "[plugin-reload] Histogram not found in metrics output" >&2
  exit 2
}

curl -s "$API_BASE/metrics/prom" | grep -E 'metasheet_plugin_reload_total{.*result="success"}' | head -n1

echo "[plugin-reload] Done."
