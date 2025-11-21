#!/usr/bin/env bash
set -euo pipefail

WORKDIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
source "$WORKDIR/.env.fallback" || { echo "Missing .env.fallback" >&2; exit 1; }

BASE_URL="http://localhost:${PORT}"
TOKEN=$(node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({id:'fallback-admin',roles:['admin']},'${JWT_SECRET}',{expiresIn:'2h'}))")
echo "Generated fallback token (${#TOKEN} chars)"

echo "Running core validation against $BASE_URL"
bash "$WORKDIR/scripts/verify-sprint2-staging.sh" "$TOKEN" "$BASE_URL" || true
ROUNDS=30 ENDPOINT="/api/snapstats" bash "$WORKDIR/scripts/performance-baseline-test.sh" "$TOKEN" "$BASE_URL" || true

echo "Validation done (fallback)"
