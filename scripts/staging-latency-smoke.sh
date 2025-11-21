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
SAMPLES=5

# Validate inputs
if [[ -z "$JWT" ]]; then
  echo -e "${RED}Error: JWT token required${NC}"
  echo "Usage: $0 <JWT_TOKEN> <BASE_URL>"
  exit 1
fi

# Critical endpoints to monitor
declare -A ENDPOINTS=(
  ["health"]="/health"
  ["snapshots_list"]="/api/snapshots"
  ["snapshots_stats"]="/api/snapstats"
  ["rules_list"]="/api/v2/admin/protection-rules"
  ["plugins"]="/api/plugins"
)

echo "╔════════════════════════════════════════════════════════════╗"
echo "║      Sprint 2 Staging Latency Smoke Test                  ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Base URL: $BASE_URL"
echo "Samples: $SAMPLES per endpoint"
echo "Thresholds: ⚠️  >${THRESHOLD_WARNING}ms | 🔴 >${THRESHOLD_CRITICAL}ms"
echo ""

# Function to measure latency
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
  response_time=$(curl -o /dev/null -s -w '%{time_total}' \
    -H "Authorization: Bearer $JWT" \
    "$url" 2>/dev/null || echo "999")

  # Convert to milliseconds
  echo "$response_time" | awk '{printf "%.0f", $1 * 1000}'
}

# Function to calculate stats
calculate_stats() {
  local -n times=$1
  local count=${#times[@]}

  if [[ $count -eq 0 ]]; then
    echo "0 0 0"
    return
  fi

  # Sort times
  IFS=$'\n' sorted=($(sort -n <<<"${times[*]}"))
  unset IFS

  # Calculate min, max, avg
  local min=${sorted[0]}
  local max=${sorted[$((count-1))]}
  local sum=0
  for t in "${times[@]}"; do
    sum=$((sum + t))
  done
  local avg=$((sum / count))

  echo "$min $max $avg"
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
declare -A results
declare -A all_latencies

echo "Testing endpoints..."
echo ""

for name in "${!ENDPOINTS[@]}"; do
  endpoint="${ENDPOINTS[$name]}"
  echo -ne "${BLUE}Testing ${name}...${NC} "

  latencies=()
  errors=0

  for ((i=1; i<=SAMPLES; i++)); do
    latency=$(measure_latency "$endpoint")

    if [[ $latency -eq 999 ]]; then
      ((errors++))
    else
      latencies+=("$latency")
    fi

    echo -n "."
  done

  # Calculate stats
  if [[ ${#latencies[@]} -gt 0 ]]; then
    read -r min max avg <<< "$(calculate_stats latencies)"
    results["$name"]="$min $max $avg $errors"
    all_latencies["$name"]="${latencies[*]}"

    status_icon=$(get_status_icon "$avg")
    echo -e " ${status_icon} avg: ${avg}ms (min: ${min}ms, max: ${max}ms)"
  else
    results["$name"]="0 0 0 $SAMPLES"
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

total_avg=0
total_endpoints=0
failed_endpoints=0
warning_endpoints=0
critical_endpoints=0

for name in "${!results[@]}"; do
  read -r min max avg errors <<< "${results[$name]}"

  if [[ $errors -eq $SAMPLES ]]; then
    status="🔴 FAIL"
    ((failed_endpoints++))
  elif [[ $avg -ge $THRESHOLD_CRITICAL ]]; then
    status="🔴 CRIT"
    ((critical_endpoints++))
  elif [[ $avg -ge $THRESHOLD_WARNING ]]; then
    status="⚠️  WARN"
    ((warning_endpoints++))
  else
    status="✅ OK"
  fi

  printf "%-20s %6dms %6dms %6dms   %s   %d/%d\n" \
    "$name" "$min" "$max" "$avg" "$status" "$errors" "$SAMPLES"

  if [[ $errors -lt $SAMPLES ]]; then
    total_avg=$((total_avg + avg))
    ((total_endpoints++))
  fi
done

echo ""

# Overall stats
if [[ $total_endpoints -gt 0 ]]; then
  overall_avg=$((total_avg / total_endpoints))
  echo "Overall Average Latency: ${overall_avg}ms"
else
  overall_avg=999
  echo "Overall Average Latency: N/A (all endpoints failed)"
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
echo "  ✅ Healthy: $((${#ENDPOINTS[@]} - warning_endpoints - critical_endpoints - failed_endpoints))"
echo "  ⚠️  Warning: $warning_endpoints"
echo "  🔴 Critical: $critical_endpoints"
echo "  ❌ Failed: $failed_endpoints"

echo ""
echo "Performance Targets:"
echo "  Sprint 2 P95 Target: ≤150ms"
echo "  Sprint 2 P99 Target: ≤250ms"
if [[ $overall_avg -lt $THRESHOLD_WARNING ]]; then
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

exit $exit_code
