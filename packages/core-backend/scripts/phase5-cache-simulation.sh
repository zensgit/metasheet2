#!/usr/bin/env bash
# Phase 5: Cache Hit/Miss Simulation Script
# Generates deterministic cache hit/miss patterns to validate metrics.
# Requires server running with FEATURE_CACHE=true and a non-null implementation.
# Usage:
#   FEATURE_CACHE=true CACHE_IMPL=memory (or redis) SERVER_URL=http://localhost:8900 \
#   ./packages/core-backend/scripts/phase5-cache-simulation.sh

set -euo pipefail

SERVER_URL="${SERVER_URL:-http://localhost:8900}"
METRICS_PATH="/metrics/prom"

echo "[Phase5] Cache simulation starting against $SERVER_URL"

# Quick status check
status_json=$(curl -fsS "$SERVER_URL/internal/cache" || echo '{}')
impl=$(echo "$status_json" | grep -E 'implName' || true)
echo "[Phase5] Cache status: $impl"

simulate() {
  local key="$1"; local loops="$2"
  for ((i=0;i<loops;i++)); do
    curl -fsS -o /dev/null -X POST "$SERVER_URL/api/cache-test/simulate" || true
  done
}

echo "[Phase5] Triggering built-in simulation endpoint once"
curl -fsS -X POST "$SERVER_URL/api/cache-test/simulate" -o /dev/null || echo "[Phase5] WARN simulation endpoint failed"

echo "[Phase5] Fetching metrics snapshot after simulation"
curl -fsS "$SERVER_URL$METRICS_PATH" | grep -E 'cache_(hits|misses|operations)_total' || echo "[Phase5] WARN: cache metrics not found"

echo "[Phase5] Done. Re-run multiple times to grow counters."

