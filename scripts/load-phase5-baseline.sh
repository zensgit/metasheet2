#!/usr/bin/env bash
# Phase 5 baseline load generator (non-invasive)
# Generates light, mixed API traffic during the 2h observation window so metrics (success rate, P99, fallback) reflect activity.
# Writes incremental stats to load-stats.csv inside the active Phase 5 results directory.
# Usage (from repo root):
#   bash scripts/load-phase5-baseline.sh results/phase5-20251122-150047 &

set -euo pipefail

RESULT_DIR="${1:-results/phase5-20251122-150047}"
METRICS_URL="${METRICS_URL:-http://localhost:8900/metrics/prom}"
API_BASE="${API_BASE:-http://localhost:8900}"
OUT_CSV="$RESULT_DIR/load-stats.csv"

# Acquire dev token (once) for protected endpoints if not provided
# Generate dev token using configured JWT secret (fallback dev-secret-key)
if [ -z "${TOKEN:-}" ]; then
  export JWT_SECRET=${JWT_SECRET:-dev-secret-key}
  if [ -f scripts/gen-dev-token.js ]; then
    TOKEN=$(node scripts/gen-dev-token.js 2>/dev/null || true)
  fi
fi
AUTH_HEADER=""
if [ -n "$TOKEN" ]; then AUTH_HEADER="-H Authorization: Bearer $TOKEN"; fi

mkdir -p "$RESULT_DIR"

if [ ! -f "$OUT_CSV" ]; then
  echo "timestamp,action,http_status,ms,ok" > "$OUT_CSV"
fi

log_row() {
  local ts action status ms ok
  ts="$(date -Iseconds)"
  action="$1"; status="$2"; ms="$3"; ok="$4"
  echo "$ts,$action,$status,$ms,$ok" >> "$OUT_CSV"
}

random_sleep() { sleep "0.$(( (RANDOM % 5) + 2 ))"; }

echo "[load-phase5] Starting whitelist traffic -> $OUT_CSV" >&2

end_time=$(( $(date +%s) + 3600 )) # run up to 1 hour
counter=0
declare -a ENDPOINTS=("/health" "/api/plugins" "/api/v2/hello" "/internal/metrics" "/metrics/prom")

while [ $(date +%s) -lt $end_time ]; do
  for ep in "${ENDPOINTS[@]}"; do
    start_ms=$(( $(date +%s) * 1000 ))
    resp=$(curl -s -o /dev/null -w '%{http_code}' "$API_BASE$ep") || resp=000
    end_ms=$(( $(date +%s) * 1000 ))
    ms=$(( end_ms - start_ms ))
    ok=0; [ "$resp" = "200" ] && ok=1
    log_row "get_${ep//\//_}" "$resp" "$ms" "$ok"
    # Inject light artificial latency (40-60ms) to create measurable P99 distribution
    sleep 0.$(( (RANDOM % 2) + 4 ))
    random_sleep
  done
  counter=$((counter+1))
  if (( counter % 20 == 0 )); then sleep 1; fi
done

echo "[load-phase5] Completed (1h runtime limit reached)" >&2
