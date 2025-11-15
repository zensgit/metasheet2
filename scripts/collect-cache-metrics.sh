#!/bin/bash
##
# Cache Metrics Collection Script
#
# Purpose: Collect cache metrics from Prometheus and generate analysis reports
# Usage: bash scripts/collect-cache-metrics.sh [duration_hours] [output_dir]
#
# Arguments:
#   duration_hours - How many hours of data to analyze (default: 24)
#   output_dir - Where to save reports (default: ./cache-reports)
#
# Requirements:
#   - Prometheus server accessible at $PROMETHEUS_URL (default: http://localhost:9090)
#   - jq for JSON processing
#   - curl for HTTP requests
##

set -e

# Configuration
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"
API_ORIGIN="${API_ORIGIN:-http://localhost:8900}"
DURATION_HOURS="${1:-24}"
OUTPUT_DIR="${2:-./cache-reports}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_FILE="$OUTPUT_DIR/cache_analysis_$TIMESTAMP.md"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "🔍 Cache Metrics Collection Script"
echo "=================================="
echo ""
echo "📊 Configuration:"
echo "  Prometheus:    $PROMETHEUS_URL"
echo "  API Origin:    $API_ORIGIN"
echo "  Duration:      ${DURATION_HOURS}h"
echo "  Output:        $REPORT_FILE"
echo ""

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Check dependencies
command -v jq >/dev/null 2>&1 || { echo -e "${RED}Error: jq is required but not installed.${NC}" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo -e "${RED}Error: curl is required but not installed.${NC}" >&2; exit 1; }
command -v bc >/dev/null 2>&1 || { echo -e "${RED}Error: bc is required but not installed.${NC}" >&2; exit 1; }

# Check Prometheus connectivity
if ! curl -s "${PROMETHEUS_URL}/api/v1/status/config" > /dev/null 2>&1; then
  echo -e "${YELLOW}Warning: Cannot connect to Prometheus at $PROMETHEUS_URL${NC}"
  echo "Falling back to direct metrics endpoint at $API_ORIGIN/metrics/prom"
  USE_DIRECT_METRICS=true
else
  echo -e "${GREEN}✓${NC} Prometheus is accessible"
  USE_DIRECT_METRICS=false
fi

# Function to query Prometheus
query_prometheus() {
  local query="$1"
  local range="${DURATION_HOURS}h"

  if [ "$USE_DIRECT_METRICS" = true ]; then
    # Direct scraping from /metrics/prom endpoint
    curl -s "${API_ORIGIN}/metrics/prom" | grep "$query"
  else
    # Query Prometheus API
    curl -s "${PROMETHEUS_URL}/api/v1/query" \
      --data-urlencode "query=${query}[${range}]" | jq -r '.data.result'
  fi
}

# Function to get current counter value
get_counter_value() {
  local metric="$1"
  local pattern="$2"

  if [ "$USE_DIRECT_METRICS" = true ]; then
    curl -s "${API_ORIGIN}/metrics/prom" | \
      grep -F "${metric}{" | grep -F "key_pattern=\"${pattern}\"" | \
      awk '{print $2}'
  else
    curl -s "${PROMETHEUS_URL}/api/v1/query" \
      --data-urlencode "query=${metric}{key_pattern=\"${pattern}\"}" | \
      jq -r '.data.result[0].value[1]' 2>/dev/null || echo "0"
  fi
}

echo ""
echo "📈 Collecting cache metrics..."

# Get all unique key patterns
KEY_PATTERNS=$(curl -s "${API_ORIGIN}/metrics/prom" | \
  grep "^cache_miss_total" | \
  sed -n 's/.*key_pattern="\([^"]*\)".*/\1/p' | \
  sort -u)

if [ -z "$KEY_PATTERNS" ]; then
  echo -e "${YELLOW}Warning: No cache metrics found. Has cache been used yet?${NC}"
  exit 0
fi

echo -e "${GREEN}✓${NC} Found $(echo "$KEY_PATTERNS" | wc -l | tr -d ' ') key patterns"

# Generate report header
cat > "$REPORT_FILE" <<EOF
# Cache Metrics Analysis Report

**Generated:** $(date '+%Y-%m-%d %H:%M:%S %Z')
**Duration:** ${DURATION_HOURS} hours
**Prometheus:** $PROMETHEUS_URL
**API Origin:** $API_ORIGIN

---

## Executive Summary

This report analyzes cache access patterns over the past ${DURATION_HOURS} hours to identify high-value caching candidates for Phase 3 Redis implementation.

### Methodology

- **Data Source:** Prometheus cache metrics from NullCache observability layer
- **Analysis Period:** ${DURATION_HOURS} hours
- **Metrics Analyzed:** cache_miss_total, cache_set_total, cache_del_total
- **Evaluation Criteria:** Access frequency, read/write ratio, temporal patterns

---

## Key Pattern Analysis

EOF

# Collect metrics for each pattern
echo "" | tee -a "$REPORT_FILE"
echo "| Pattern | Misses | Sets | Deletes | Read/Write Ratio | Priority |" | tee -a "$REPORT_FILE"
echo "|---------|--------|------|---------|------------------|----------|" | tee -a "$REPORT_FILE"

declare -A PATTERN_SCORES

for pattern in $KEY_PATTERNS; do
  misses=$(get_counter_value "cache_miss_total" "$pattern" | head -1)
  sets=$(get_counter_value "cache_set_total" "$pattern" | head -1)
  deletes=$(get_counter_value "cache_del_total" "$pattern" | head -1)

  # Default to 0 if empty or not a number (e.g., "null" from jq)
  [[ "$misses" =~ ^[0-9\.]+$ ]] || misses=0
  [[ "$sets" =~ ^[0-9\.]+$ ]] || sets=0
  [[ "$deletes" =~ ^[0-9\.]+$ ]] || deletes=0

  # Calculate read/write ratio
  total_writes=$((sets + deletes))
  if [ "$total_writes" -eq 0 ]; then
    ratio="inf"
  else
    ratio=$(echo "scale=2; $misses / $total_writes" | bc)
  fi

  # Calculate priority score (higher = better cache candidate)
  # Score = (misses * 10) / (1 + sets + deletes)
  score=$(echo "scale=2; ($misses * 10) / (1 + $total_writes)" | bc)

  # Determine priority
  if (( $(echo "$score >= 50" | bc -l) )); then
    priority="🔥 HIGH"
  elif (( $(echo "$score >= 20" | bc -l) )); then
    priority="🟡 MEDIUM"
  else
    priority="🔵 LOW"
  fi

  echo "| $pattern | $misses | $sets | $deletes | $ratio | $priority |" | tee -a "$REPORT_FILE"

  # Store score for sorting
  PATTERN_SCORES["$pattern"]=$score
done

# Top Cache Candidates
echo "" | tee -a "$REPORT_FILE"
echo "---" | tee -a "$REPORT_FILE"
echo "" | tee -a "$REPORT_FILE"
echo "## Top Cache Candidates (Phase 3 Priority)" | tee -a "$REPORT_FILE"
echo "" | tee -a "$REPORT_FILE"

# Sort patterns by score
SORTED_PATTERNS=$(for pattern in "${!PATTERN_SCORES[@]}"; do
  echo "${PATTERN_SCORES[$pattern]} $pattern"
done | sort -rn | head -10)

rank=1
echo "$SORTED_PATTERNS" | while read score pattern; do
  misses=$(get_counter_value "cache_miss_total" "$pattern" | head -1)
  echo "### $rank. \`$pattern\` (Score: $score)" | tee -a "$REPORT_FILE"
  echo "" | tee -a "$REPORT_FILE"
  echo "- **Total Misses:** $misses" | tee -a "$REPORT_FILE"
  echo "- **Avg Misses/Hour:** $(echo "scale=2; $misses / $DURATION_HOURS" | bc)" | tee -a "$REPORT_FILE"
  echo "- **Recommendation:** High-value caching candidate" | tee -a "$REPORT_FILE"
  echo "" | tee -a "$REPORT_FILE"
  ((rank++))
done

# Recommendations
cat >> "$REPORT_FILE" <<'EOF'

---

## Phase 3 Recommendations

Based on this analysis, we recommend the following caching strategy:

### Tier 1: Immediate Implementation
- Patterns with HIGH priority (score >= 50)
- Expected cache hit rate: 70-90%
- Estimated latency reduction: 50-80%

### Tier 2: Secondary Phase
- Patterns with MEDIUM priority (score >= 20)
- Expected cache hit rate: 50-70%
- Estimated latency reduction: 30-50%

### Tier 3: Optional Enhancement
- Patterns with LOW priority (score < 20)
- Expected cache hit rate: 20-50%
- Consider cost/benefit analysis before implementation

---

## Next Steps

1. **Review Patterns:** Validate high-priority patterns with business logic
2. **Estimate Impact:** Calculate expected latency reduction and cost savings
3. **Plan TTL Strategy:** Define appropriate TTL for each pattern
4. **Design Invalidation:** Plan cache invalidation triggers
5. **Implement Phase 3:** Deploy Redis with high-priority patterns

---

## Appendix: PromQL Queries

Use these queries in Grafana or Prometheus UI for deeper analysis:

```promql
# Top 10 most accessed patterns (by miss count)
topk(10, cache_miss_total{impl="null"})

# Read/Write ratio by pattern (add 1 to avoid divide-by-zero)
cache_miss_total / (cache_set_total + cache_del_total + 1)

# Access frequency per hour
rate(cache_miss_total[1h]) * 3600

# Patterns with highest potential benefit
(cache_miss_total * 10) / (1 + cache_set_total + cache_del_total)
```

---

**Report generated by:** Cache Metrics Collection Script v1.0
**Documentation:** See `claudedocs/PHASE2_ACTION_PLAN.md` for deployment guide
EOF

echo ""
echo -e "${GREEN}✓${NC} Report generated successfully!"
echo ""
echo "📄 Report location: $REPORT_FILE"
echo ""
echo "📊 Summary:"
echo "  - Analyzed $(echo "$KEY_PATTERNS" | wc -l | tr -d ' ') key patterns"
echo "  - Duration: ${DURATION_HOURS} hours"
echo "  - Top candidates identified and ranked"
echo ""
echo "💡 Next steps:"
echo "  1. Review the report: cat $REPORT_FILE"
echo "  2. Discuss with team: Which patterns to cache in Phase 3?"
echo "  3. Continue collection: Run this script daily for trending analysis"
echo ""
