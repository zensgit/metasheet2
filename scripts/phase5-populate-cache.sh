#!/usr/bin/env bash
set -euo pipefail

API_BASE=${API_BASE:-http://localhost:8900}

echo "[cache] Step 1: Warming cache to ensure high hit rate..."
# Use /warm endpoint which pre-populates keys then does read-only hits
# count=200 gives 2000 hits (10 keys x 200 iterations)
curl -s -X POST "$API_BASE/api/cache-test/warm?count=200" | sed -e 's/.*/[warm] &/'

echo ""
echo "[cache] Step 2: Running additional warm cycles..."
for i in $(seq 1 3); do
  curl -s -X POST "$API_BASE/api/cache-test/warm?count=100" | sed -e 's/.*/[warm-$i] &/'
done

echo ""
echo "[cache] Step 3: Light simulate for realistic mix..."
curl -s -X POST "$API_BASE/api/cache-test/simulate" | sed -e 's/.*/[simulate] &/'

echo ""
echo "[cache] Done. Expected hit rate: >80%"
echo "[cache] Check metrics at $API_BASE/metrics/prom for cache_hits_total and cache_miss_total"
