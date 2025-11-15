#!/usr/bin/env bash
set -euo pipefail

echo "=== Testing Server Stability ==="

# Configuration
API_ORIGIN=${API_ORIGIN:-http://127.0.0.1:8900}
HEALTH_URL="$API_ORIGIN/health"
METRICS_URL="$API_ORIGIN/metrics/prom"

echo "API Origin: $API_ORIGIN"
echo ""

# 1. Test server startup and health check
echo "1. Testing health endpoint..."
if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
  echo "   ✅ Health check passed"
  curl -s "$HEALTH_URL" | head -5
else
  echo "   ❌ Health check failed"
  exit 1
fi
echo ""

# 2. Test metrics endpoint
echo "2. Testing metrics endpoint..."
if curl -sf "$METRICS_URL" > /dev/null 2>&1; then
  echo "   ✅ Metrics endpoint accessible"
  echo "   Sample metrics:"
  curl -s "$METRICS_URL" | grep -E "(process_cpu|process_resident_memory)" | head -3 || true
else
  echo "   ❌ Metrics endpoint failed"
  exit 1
fi
echo ""

# 3. Concurrent health checks (simulating load)
echo "3. Testing concurrent requests (10 parallel health checks)..."
for i in {1..10}; do
  curl -sf "$HEALTH_URL" > /dev/null 2>&1 &
done
wait
echo "   ✅ All concurrent requests completed"
echo ""

# 4. Rapid sequential requests
echo "4. Testing rapid sequential requests (20 requests)..."
SUCCESS=0
FAILED=0
for i in {1..20}; do
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    ((SUCCESS++))
  else
    ((FAILED++))
  fi
done
echo "   Success: $SUCCESS / 20"
echo "   Failed:  $FAILED / 20"
if [ "$SUCCESS" -ge 18 ]; then
  echo "   ✅ Stability test passed (>90% success rate)"
else
  echo "   ❌ Stability test failed (success rate too low)"
  exit 1
fi
echo ""

echo "=== All Stability Tests Passed ✅ ==="
