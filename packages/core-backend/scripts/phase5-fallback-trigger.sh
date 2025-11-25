#!/usr/bin/env bash
# Phase 5: Fallback trigger script
# Forces degraded responses to increment metasheet_fallback_total.
# Requires server started with ENABLE_FALLBACK_TEST=true
# Usage:
#   ENABLE_FALLBACK_TEST=true SERVER_URL=http://localhost:8900 \
#   ./packages/core-backend/scripts/phase5-fallback-trigger.sh

set -euo pipefail

SERVER_URL="${SERVER_URL:-http://localhost:8900}"
ROUTE="/api/v2/fallback-test"
METRICS="/metrics/prom"

echo "[Phase5] Triggering fallback route $ROUTE at $SERVER_URL"

for i in $(seq 1 3); do
  echo "[Phase5] Request #$i"
  curl -fsS "${SERVER_URL}${ROUTE}" || echo "[Phase5] WARN: request failed (expected if adapter errors)"
  sleep 0.5
done

echo "[Phase5] Fetching fallback metric snapshot"
curl -fsS "${SERVER_URL}${METRICS}" | grep -E 'metasheet_fallback_total' || echo "[Phase5] WARN: fallback metric not found"

echo "[Phase5] Done. Re-run to increase counters."

