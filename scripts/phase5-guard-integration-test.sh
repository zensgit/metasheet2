#!/usr/bin/env bash
set -euo pipefail

# Integration checks for production guards and fallback route gating.
# Run locally with a production-like env and a running backend.
# Example:
#   NODE_ENV=production ENABLE_FALLBACK_TEST=false ALLOW_UNSAFE_ADMIN=false FEATURE_CACHE=true \
#   pnpm --filter @metasheet/core-backend dev &
#   sleep 2
#   ./scripts/phase5-guard-integration-test.sh

API_BASE=${API_BASE:-http://localhost:8900}

echo "[1/3] Checking unsafe admin route is disabled in production..."
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_BASE/api/admin/plugins/example-plugin/reload-unsafe" || true)
if [ "$code" = "403" ] || [ "$code" = "404" ]; then
  echo "PASS: unsafe admin blocked (status=$code)"
else
  echo "FAIL: unsafe admin not blocked (status=$code)"; exit 1
fi

echo "[2/3] Checking fallback test route hidden when ENABLE_FALLBACK_TEST=false..."
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_BASE/internal/test/fallback" -H 'Content-Type: application/json' -d '{"mode":"http_error"}' || true)
if [ "$code" = "404" ] || [ "$code" = "403" ]; then
  echo "PASS: fallback test route hidden (status=$code)"
else
  echo "FAIL: fallback test route exposed (status=$code)"; exit 1
fi

echo "[3/3] Checking /internal/config does not leak secrets..."
resp=$(curl -s "$API_BASE/internal/config" || true)
if echo "$resp" | grep -qiE 'JWT_SECRET|DATABASE_URL|REDIS_URL'; then
  echo "FAIL: sensitive env leaked in /internal/config"; exit 1
else
  echo "PASS: no sensitive env in /internal/config"
fi

echo "All production guard checks passed."
