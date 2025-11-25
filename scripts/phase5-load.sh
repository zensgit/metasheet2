#!/bin/bash
# Phase 5 load generator (dev/production baseline support)
# Sends concurrent HTTP requests to representative endpoints to ensure
# sufficient request volume per observation sample for stable metrics.
#
# Usage examples:
#   ./scripts/phase5-load.sh --rate 80 --concurrency 20 --duration-seconds 7200 \
#       --base-url http://localhost:8999 --jwt dev-secret
#
# Options:
#   --rate RPS                Target aggregate requests per second (default 50)
#   --concurrency N           Parallel workers (default 10)
#   --duration-seconds SEC    Run time (default 600)
#   --base-url URL            Base URL (default http://localhost:8900)
#   --jwt TOKEN               JWT token for protected routes (optional)
#   --endpoints CSV           Comma list; overrides default set
#   --log-dir DIR             Output directory (default results/phase5-load-<timestamp>)
#   --quiet                   Minimal console output
#
# Output:
#   <log-dir>/load-stats.csv  (timestamp,success,fail,latency_ms)
#   <log-dir>/summary.json    (aggregate stats)
#
set -euo pipefail

RATE=50
CONCURRENCY=10
DURATION_SECONDS=600
BASE_URL="http://localhost:8900"
JWT=""
ENDPOINTS="/health,/api/v2/hello,/api/plugins"
LOG_DIR=""
QUIET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rate) RATE="$2"; shift 2;;
    --concurrency) CONCURRENCY="$2"; shift 2;;
    --duration-seconds) DURATION_SECONDS="$2"; shift 2;;
    --base-url) BASE_URL="$2"; shift 2;;
    --jwt) JWT="$2"; shift 2;;
    --endpoints) ENDPOINTS="$2"; shift 2;;
    --log-dir) LOG_DIR="$2"; shift 2;;
    --quiet) QUIET=1; shift;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

TS=$(date +%Y%m%d-%H%M%S)
if [ -z "$LOG_DIR" ]; then LOG_DIR="results/phase5-load-$TS"; fi
mkdir -p "$LOG_DIR"
CSV="$LOG_DIR/load-stats.csv"
echo "timestamp,success,fail,latency_ms,endpoint" > "$CSV"

ENDPOINT_ARRAY=()
IFS=',' read -r -a ENDPOINT_ARRAY <<< "$ENDPOINTS"

if [ $QUIET -eq 0 ]; then
  echo "Phase5 Load: rate=$RATE concurrency=$CONCURRENCY duration=${DURATION_SECONDS}s base_url=$BASE_URL"
  echo "Endpoints: ${ENDPOINT_ARRAY[*]}"
  echo "Output: $CSV"
fi

STOP_AT=$(date -d "+$DURATION_SECONDS seconds" +%s 2>/dev/null || echo $(( $(date +%s) + DURATION_SECONDS )) )
TARGET_INTERVAL_MS=$(python - <<PY 2>/dev/null || echo 20
rate=$RATE
print(int(1000/max(rate,1)))
PY
)
[ -z "$TARGET_INTERVAL_MS" ] && TARGET_INTERVAL_MS=20

SUCCESS=0; FAIL=0; LAT_SUM=0; LAT_COUNT=0

worker() {
  local wid=$1
  while [ $(date +%s) -lt $STOP_AT ]; do
    for ep in "${ENDPOINT_ARRAY[@]}"; do
      local start_ns=$(date +%s%N)
      local url="$BASE_URL$ep"
      local auth=()
      [ -n "$JWT" ] && auth=(-H "Authorization: Bearer $JWT")
      # Use --max-time 5 to avoid hanging
      local body
      if [ ${#auth[@]} -gt 0 ]; then
        body=$(curl -s -o /dev/null -w "%{http_code}" "${auth[@]}" "$url" --max-time 5 || echo "000")
      else
        body=$(curl -s -o /dev/null -w "%{http_code}" "$url" --max-time 5 || echo "000")
      fi
      local code=$body
      local end_ns=$(date +%s%N)
      local lat_ms=$(( (end_ns - start_ns)/1000000 ))
      local ts=$(date '+%Y-%m-%d %H:%M:%S')
      if [[ $code =~ ^2|3[0-9]{2}$ ]]; then
        echo "$ts,1,0,$lat_ms,$ep" >> "$CSV"
        SUCCESS=$((SUCCESS+1))
        LAT_SUM=$((LAT_SUM+lat_ms)); LAT_COUNT=$((LAT_COUNT+1))
      else
        echo "$ts,0,1,$lat_ms,$ep" >> "$CSV"
        FAIL=$((FAIL+1))
        LAT_SUM=$((LAT_SUM+lat_ms)); LAT_COUNT=$((LAT_COUNT+1))
      fi
      # Pace roughly to target rate (best effort)
      sleep "0.$(( TARGET_INTERVAL_MS ))" 2>/dev/null || true
    done
  done
}

for ((w=1; w<=CONCURRENCY; w++)); do
  worker $w &
done
wait

AVG_LAT=0
if [ $LAT_COUNT -gt 0 ]; then AVG_LAT=$(echo "scale=2; $LAT_SUM / $LAT_COUNT" | bc); fi

cat > "$LOG_DIR/summary.json" << EOF
{
  "rate": $RATE,
  "concurrency": $CONCURRENCY,
  "duration_seconds": $DURATION_SECONDS,
  "endpoints": "${ENDPOINTS}",
  "success": $SUCCESS,
  "fail": $FAIL,
  "avg_latency_ms": $AVG_LAT,
  "csv": "$CSV"
}
EOF

if [ $QUIET -eq 0 ]; then
  echo "Load complete: success=$SUCCESS fail=$FAIL avg_latency_ms=$AVG_LAT"
  echo "Summary: $LOG_DIR/summary.json"
fi

exit 0
