#!/usr/bin/env bash
set -euo pipefail

# Capture filtered metrics snapshot for latency and snapshot/rule counters.
# Usage: STAGING_BASE_URL=... API_TOKEN=... ./scripts/capture-metrics-snapshot.sh [output-dir]

OUT_DIR=${1:-docs/sprint2/evidence}
mkdir -p "$OUT_DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT_FILE="$OUT_DIR/metrics-snapshot-$TS.prom.txt"

BASE="${STAGING_BASE_URL:-}"
TOKEN="${API_TOKEN:-}"
if [ -z "$BASE" ]; then echo "STAGING_BASE_URL not set" >&2; exit 1; fi

AUTH_HEADER=""
if [ -n "$TOKEN" ]; then AUTH_HEADER="-H Authorization:Bearer:$TOKEN"; fi

echo "[metrics-snapshot] Fetching $BASE/metrics/prom" >&2
if ! curl -fsS "$BASE/metrics/prom" | grep -E 'snapstats|snapshot|rule|latency|http_request_duration_seconds' > "$OUT_FILE"; then
  echo "[metrics-snapshot] Failed to capture metrics" >&2; exit 2
fi

echo "[metrics-snapshot] Written $OUT_FILE" >&2
echo "$OUT_FILE"

