#!/usr/bin/env bash
set -euo pipefail

# Start core-backend with Phase 5 feature flags enabled
# - Enables in-memory cache + metrics
# - Enables dev fallback test route
# - Excludes cache_miss from effective fallback by default

export FEATURE_CACHE=${FEATURE_CACHE:-true}
export ENABLE_FALLBACK_TEST=${ENABLE_FALLBACK_TEST:-true}
export COUNT_CACHE_MISS_AS_FALLBACK=${COUNT_CACHE_MISS_AS_FALLBACK:-false}

echo "[Phase5] Starting @metasheet/core-backend with flags:"
echo "  FEATURE_CACHE=$FEATURE_CACHE"
echo "  ENABLE_FALLBACK_TEST=$ENABLE_FALLBACK_TEST"
echo "  COUNT_CACHE_MISS_AS_FALLBACK=$COUNT_CACHE_MISS_AS_FALLBACK"
echo "  Metrics: http://localhost:8900/metrics/prom"

exec pnpm --filter @metasheet/core-backend dev

