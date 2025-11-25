#!/usr/bin/env bash
set -euo pipefail

API_BASE=${API_BASE:-http://localhost:8900}

echo "[phase5] populating cache via POST /api/cache-test/simulate"
for i in $(seq 1 5); do
  curl -s -X POST "$API_BASE/api/cache-test/simulate" | sed -e 's/.*/[simulate] &/'
done

echo "[phase5] done. Check metrics at $API_BASE/metrics/prom for cache_hits_total and cache_miss_total"
