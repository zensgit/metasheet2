#!/usr/bin/env bash
# staging-latency-smoke.sh
# Quick latency smoke test for staging environment
# Usage: ./staging-latency-smoke.sh <JWT_TOKEN> <BASE_URL>

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
JWT="${1:-}"
BASE_URL="${2:-http://localhost:8900}"
THRESHOLD_WARNING=150  # ms
THRESHOLD_CRITICAL=250 # ms
SAMPLES=${SAMPLES:-5}
JSON_OUT="${SMOKE_JSON_OUT:-}"  # optional path to write JSON summary

# Validate inputs
if [[ -z "$JWT" ]]; then
  echo -e "${RED}Error: JWT token required${NC}"
  echo "Usage: $0 <JWT_TOKEN> <BASE_URL>"
  exit 1
fi

# Critical endpoints to monitor
# Bash 3 (macOS) lacks associative arrays; use a simple whitespace-delimited list
ENDPOINTS_LIST="health:/health snapshots_list:/api/snapshots snapshots_stats:/api/snapstats rules_list:/api/v2/admin/protection-rules plugins:/api/plugins"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║      Sprint 2 Staging Latency Smoke Test                  ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Base URL: $BASE_URL"
echo "Samples: $SAMPLES per endpoint"
echo "Thresholds: ⚠️  >${THRESHOLD_WARNING}ms | 🔴 >${THRESHOLD_CRITICAL}ms"
echo ""

# Function to measure latency (returns milliseconds or 999 on failure)
measure_latency() {
  local endpoint="$1"
  local url="${BASE_URL}${endpoint}"
  local auth_header=""

  # Add auth header for protected endpoints
  if [[ "$endpoint" != "/health" ]]; then
    auth_header="-H \"Authorization: Bearer $JWT\""
  fi

  # Measure response time
  local response_time
  if [[ "$endpoint" == "/health" ]]; then
    response_time=$(curl -o /dev/null -s -w '%{time_total}' \
      "$url" 2>/dev/null || echo "999")
  else
    response_time=$(curl -o /dev/null -s -w '%{time_total}' \
      -H "Authorization: Bearer $JWT" \
      "$url" 2>/dev/null || echo "999")
  fi

  # Convert to milliseconds
  echo "$response_time" | awk '{printf "%.0f", $1 * 1000}'
}

# Function to get status icon
get_status_icon() {
  local latency=$1

  if [[ $latency -ge $THRESHOLD_CRITICAL ]]; then
    echo "🔴"
  elif [[ $latency -ge $THRESHOLD_WARNING ]]; then
    echo "⚠️ "
  else
    echo "✅"
  fi
}

# Test all endpoints
results="" # lines: name|min|max|avg|errors

echo "Testing endpoints..."
echo ""

for pair in $ENDPOINTS_LIST; do
  name="${pair%%:*}"
  endpoint="${pair#*:}"
  echo -ne "${BLUE}Testing ${name}...${NC} "

  latencies=""
  errors=0

  for i in $(seq 1 $SAMPLES); do
    latency=$(measure_latency "$endpoint")
    if [[ $latency -eq 999 ]]; then
      errors=$((errors+1))
    else
      latencies="$latencies $latency"
    fi
    echo -n "."
  done

  # Calculate stats
  latencies=${latencies# } # trim leading space
  if [[ -n "$latencies" ]]; then
    sorted=$(printf '%s\n' $latencies | sort -n)
    min=$(printf '%s\n' $sorted | head -n1)
    max=$(printf '%s\n' $sorted | tail -n1)
    count=$(printf '%s\n' $sorted | wc -l | tr -d ' ')
    sum=0
    for v in $sorted; do sum=$((sum+v)); done
    avg=$((sum/count))
    results+="$name|$min|$max|$avg|$errors\n"

    status_icon=$(get_status_icon "$avg")
    echo -e " ${status_icon} avg: ${avg}ms (min: ${min}ms, max: ${max}ms)"
  else
    results+="$name|0|0|0|$SAMPLES\n"
    echo -e " ${RED}FAILED${NC} (all requests failed)"
  fi
done

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                    Test Results                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Print results table
printf "%-20s %8s %8s %8s %8s %6s\n" "Endpoint" "Min" "Max" "Avg" "Status" "Errors"
echo "────────────────────────────────────────────────────────────────"

# Normalize embedded newlines in results for robust parsing
endpoint_text=$(printf '%b' "$results" | grep -v '^$' || true)

# Use awk for robust parsing/printing to avoid bash multiline pitfalls
stats_out=$(awk -v SAMPLES="$SAMPLES" -v WARN="$THRESHOLD_WARNING" -v CRIT="$THRESHOLD_CRITICAL" '
BEGIN {
  total_avg=0; total_ep=0; fail=0; warn=0; crit=0;
}
function status_icon(avg) {
  if (avg >= CRIT) return "🔴 CRIT";
  if (avg >= WARN) return "⚠️  WARN";
  return "✅ OK";
}
{
  # Expect lines like: name|min|max|avg|errors
  if ($0 ~ /^[[:space:]]*$/) next;
  n=split($0, f, "|");
  if (n != 5) next;
  name=f[1]; min=f[2]+0; max=f[3]+0; avg=f[4]+0; errs=f[5]+0;
  st = (errs==SAMPLES) ? "🔴 FAIL" : status_icon(avg);
  printf "%-20s %6dms %6dms %6dms   %s   %d/%d\n", name, min, max, avg, st, errs, SAMPLES;
  if (errs < SAMPLES) { total_avg += avg; total_ep += 1; }
  if (errs == SAMPLES) fail += 1; else if (avg >= CRIT) crit += 1; else if (avg >= WARN) warn += 1;
}
END {
  # CSV summary for robust parsing: __S__,total_avg,total_ep,fail,warn,crit
  printf "\n__S__,%d,%d,%d,%d,%d\n", total_avg, total_ep, fail, warn, crit;
}
' <<< "$endpoint_text")

summary_csv=$(printf '%s\n' "$stats_out" | awk -F',' '/^__S__/ {print $0}' | tail -n1)
table_out=$(printf '%s\n' "$stats_out" | sed '/^__S__,/d')
echo "$table_out"

# Parse CSV summary
IFS=',' read -r _ total_avg total_endpoints failed_endpoints warning_endpoints critical_endpoints <<< "$summary_csv"

echo ""

# Overall stats
if [[ ${total_endpoints:-0} -gt 0 ]]; then
  overall_avg=$((total_avg / total_endpoints))
  echo "Overall Average Latency: ${overall_avg}ms"
else
  overall_avg=999
  echo "Overall Average Latency: N/A (no successful samples)"
fi

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                    Health Summary                          ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Health assessment
if [[ $failed_endpoints -gt 0 ]]; then
  echo -e "${RED}❌ UNHEALTHY${NC}: $failed_endpoints endpoint(s) completely failed"
  exit_code=2
elif [[ $critical_endpoints -gt 0 ]]; then
  echo -e "${RED}🔴 CRITICAL${NC}: $critical_endpoints endpoint(s) exceeding ${THRESHOLD_CRITICAL}ms"
  exit_code=1
elif [[ $warning_endpoints -gt 0 ]]; then
  echo -e "${YELLOW}⚠️  WARNING${NC}: $warning_endpoints endpoint(s) exceeding ${THRESHOLD_WARNING}ms"
  exit_code=1
else
  echo -e "${GREEN}✅ HEALTHY${NC}: All endpoints responding within acceptable thresholds"
  exit_code=0
fi

echo ""
echo "Endpoint Status:"
total_defined=$(echo "$ENDPOINTS_LIST" | wc -w | tr -d ' ')
echo "  ✅ Healthy: $((total_defined - ${warning_endpoints:-0} - ${critical_endpoints:-0} - ${failed_endpoints:-0}))"
echo "  ⚠️  Warning: ${warning_endpoints:-0}"
echo "  🔴 Critical: ${critical_endpoints:-0}"
echo "  ❌ Failed: ${failed_endpoints:-0}"

echo ""
echo "Performance Targets:"
echo "  Sprint 2 P95 Target: ≤150ms"
echo "  Sprint 2 P99 Target: ≤250ms"
if [[ $total_endpoints -eq 0 ]]; then
  echo -e "  Current Avg: N/A ${RED}(FAIL)${NC}"
elif [[ $overall_avg -lt $THRESHOLD_WARNING ]]; then
  echo -e "  Current Avg: ${overall_avg}ms ${GREEN}(PASS)${NC}"
elif [[ $overall_avg -lt $THRESHOLD_CRITICAL ]]; then
  echo -e "  Current Avg: ${overall_avg}ms ${YELLOW}(WARNING)${NC}"
else
  echo -e "  Current Avg: ${overall_avg}ms ${RED}(FAIL)${NC}"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "Test completed at $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# Optional JSON export
if [[ -n "$JSON_OUT" ]]; then
  {
    echo '{'
    echo '  "base_url": '"\"$BASE_URL\""','
    echo '  "samples": '"$SAMPLES"','
    echo '  "threshold_warning_ms": '"$THRESHOLD_WARNING"','
    echo '  "threshold_critical_ms": '"$THRESHOLD_CRITICAL"','
    echo '  "overall_avg_ms": '"$overall_avg"','
    echo '  "endpoints": ['
    first=1
    while IFS='|' read -r name min max avg errors; do
      [ -z "$name" ] && continue
      if [[ $first -eq 0 ]]; then echo ','; fi
      first=0
      status_icon=$(get_status_icon "$avg")
      echo -n '    {"name": '"\"$name\""', "min_ms": '"$min"', "max_ms": '"$max"', "avg_ms": '"$avg"', "errors": '"$errors"', "status_icon": '"\"$status_icon\""'}'
    done <<< "$results"
    echo
    echo '  ]'
    echo '}'
  } > "$JSON_OUT" 2>/dev/null || echo "⚠️  Failed to write JSON summary to $JSON_OUT"
fi

exit $exit_code
