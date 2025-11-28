#!/usr/bin/env bash
set -euo pipefail

# Trigger a non-cache fallback scenario to populate raw fallback counters.
# This assumes there is an internal route able to simulate a fallback.
# If no such route exists, the script exits with a guidance message.

API_BASE="${API_BASE:-http://localhost:8900}"
# The route is mounted by fallback-test.ts under '/fallback' (guarded in code),
# not '/internal/test/fallback'. Allow override by env.
ROUTE="${FALLBACK_ROUTE:-/fallback}" # configurable

if [ ! -x scripts/phase5-dev-jwt.sh ]; then
  echo "Missing scripts/phase5-dev-jwt.sh" >&2; exit 1
fi

TOKEN=$(./scripts/phase5-dev-jwt.sh)

echo "[fallback] Attempting fallback trigger via $ROUTE (posting multiple reasons)"

# Trigger a few events to populate both raw and effective counters
for mode in http_error http_timeout upstream_error cache_miss; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -X POST \
    -d "{\"mode\":\"$mode\"}" \
    "$API_BASE$ROUTE" || true)
  echo "[fallback] mode=$mode -> HTTP $code"
  resp=$code
done

if [ "$resp" = "404" ]; then
  echo "[fallback] Route $ROUTE not found. Please implement a test route that records a fallback reason != cache_miss." >&2
  exit 2
fi

echo "[fallback] Fetching metrics excerpt (grep metasheet_fallback_total / effective_total):"
curl -s "$API_BASE/metrics/prom" | grep -E 'metasheet_fallback_(total|effective_total)' || echo "[fallback] WARNING: fallback metrics not found"
echo "[fallback] Done."
