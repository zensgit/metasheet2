#!/bin/bash
##
# Cache Access Simulation Script (Bash version)
#
# Purpose: Simulate cache access patterns by making a single HTTP request
# to the backend's simulation endpoint. This generates metrics visible in Prometheus.
##

set -e

API_URL="${API_URL:-http://localhost:8900}"
SIMULATE_URL="$API_URL/api/cache-test/simulate"

echo "🚀 Starting cache access simulation via POST to $SIMULATE_URL..."
echo ""

# Check for jq or python3 for pretty printing
if command -v jq >/dev/null 2>&1; then
  PRETTY_PRINT_CMD="jq ."
elif command -v python3 >/dev/null 2>&1; then
  PRETTY_PRINT_CMD="python3 -m json.tool"
else
  PRETTY_PRINT_CMD="cat"
fi

# Make a POST request to the simulation endpoint
response=$(curl -X POST -s -w "\n%{http_code}" "$SIMULATE_URL")
http_code=$(tail -n1 <<< "$response")
body=$(sed '$ d' <<< "$response")

if [ "$http_code" -ne 200 ]; then
  echo "❌ Simulation failed with HTTP status $http_code:"
  echo "$body" | $PRETTY_PRINT_CMD
  exit 1
fi

echo "✅ Simulation complete! Response:"
echo "$body" | $PRETTY_PRINT_CMD
echo ""

echo "📈 View metrics at: $API_URL/metrics/prom"
echo "📊 View cache status at: $API_URL/internal/cache"
echo ""
echo "💡 Tip: Use 'curl $API_URL/metrics/prom | grep cache_' to see cache metrics"
