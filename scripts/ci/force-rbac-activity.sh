#!/usr/bin/env bash
set -euo pipefail
API="${BASE_URL:-http://127.0.0.1:8900}"
TOKEN="${TOKEN:-}"

echo "[rbac-activity] Generating synthetic + real permission traffic"
echo "[rbac-activity] Using API endpoint: $API"

# Synthetic traffic (health endpoint) - 10 calls
echo "[rbac-activity] Generating synthetic traffic..."
SYN=0
for i in {1..10}; do
  # Use -s (silent) instead of -fsS to avoid failing on HTTP errors
  RESPONSE=$(curl -s -w "\n%{http_code}" "$API/api/permissions/health" 2>&1)
  HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "200" ]; then
    SYN=$((SYN+1))
    echo "[rbac-activity] Synthetic call $i succeeded (HTTP $HTTP_CODE)"
    # Check if response contains expected data
    if echo "$BODY" | grep -q '"source":"synthetic"'; then
      echo "[rbac-activity]   ✓ Response contains synthetic source marker"
    else
      echo "[rbac-activity]   ⚠ Warning: Response missing synthetic marker"
      echo "[rbac-activity]   Response body: $BODY"
    fi
  else
    echo "[rbac-activity] Synthetic call $i failed (HTTP $HTTP_CODE)"
    echo "[rbac-activity] Response: $BODY"
  fi
done

# Real traffic (authenticated permission queries) - 20 calls
echo "[rbac-activity] Generating real traffic..."
REAL=0
if [ -n "$TOKEN" ]; then
  AUTH="Authorization: Bearer $TOKEN"
  echo "[rbac-activity] Using authentication token"

  # Direct permission queries (real traffic)
  for i in {1..15}; do
    RESPONSE=$(curl -s -w "\n%{http_code}" -H "$AUTH" "$API/api/permissions?userId=u$i" 2>&1)
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    if [ "$HTTP_CODE" = "200" ]; then
      REAL=$((REAL+1))
    else
      echo "[rbac-activity] Real call $i failed (HTTP $HTTP_CODE)"
    fi
  done

  # Approval instance queries (also triggers RBAC checks)
  for i in {1..5}; do
    RESPONSE=$(curl -s -w "\n%{http_code}" -H "$AUTH" "$API/api/approvals/demo-$i" 2>&1)
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
      REAL=$((REAL+1))
    fi
  done
else
  echo "[rbac-activity] Warning: No auth token, skipping real traffic generation"
fi

echo "[rbac-activity] Traffic generation completed"
echo "RBAC_ACTIVITY real=$REAL synth=$SYN"
echo "[rbac-activity] Observed REAL=$REAL SYN=$SYN (expected synth≈10 real≈20)"

# Fetch and display current metrics
echo "[rbac-activity] Fetching current metrics to verify increment..."
METRICS=$(curl -s "$API/metrics/prom" | grep -E 'rbac_perm_queries_(real|synth)_total' || echo "Metrics not found")
echo "[rbac-activity] Current RBAC query metrics:"
echo "$METRICS"
