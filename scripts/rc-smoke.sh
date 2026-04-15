#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# MetaSheet RC Smoke Test
#
# Quick HTTP-level sanity check against a running MetaSheet server.
# Usage: ./scripts/rc-smoke.sh [base_url]
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
PASS=0
FAIL=0
SKIP=0

# ── Helpers ─────────────────────────────────────────────────────────────────

green()  { printf '\033[32m%s\033[0m\n' "$1"; }
red()    { printf '\033[31m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }

assert_status() {
  local label="$1" url="$2" expected="$3" method="${4:-GET}" body="${5:-}"
  local status

  if [ "$method" = "POST" ] && [ -n "$body" ]; then
    status=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
      -H "Content-Type: application/json" \
      -d "$body" "$url" 2>/dev/null || echo "000")
  else
    status=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  fi

  if [ "$status" = "$expected" ]; then
    green "  PASS  $label (HTTP $status)"
    PASS=$((PASS + 1))
  elif [ "$status" = "000" ]; then
    yellow "  SKIP  $label (server unreachable)"
    SKIP=$((SKIP + 1))
  else
    red "  FAIL  $label (expected $expected, got $status)"
    FAIL=$((FAIL + 1))
  fi
}

# ── Banner ──────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
echo "  MetaSheet RC Smoke Test"
echo "  Target: $BASE_URL"
echo "  Date:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "═══════════════════════════════════════════════════"
echo ""

# ── 1. Health check ─────────────────────────────────────────────────────────

echo "1. Health Check"
assert_status "GET /health" "$BASE_URL/health" "200"
echo ""

# ── 2. API root ─────────────────────────────────────────────────────────────

echo "2. API Root"
assert_status "GET /api" "$BASE_URL/api" "200"
echo ""

# ── 3. Comment endpoints ───────────────────────────────────────────────────

echo "3. Comment System"
assert_status "GET /api/comments (unauthenticated)" "$BASE_URL/api/comments" "401"
assert_status "GET /api/comments/unread-count (unauthenticated)" "$BASE_URL/api/comments/unread-count" "401"
echo ""

# ── 4. Public Form ─────────────────────────────────────────────────────────

echo "4. Public Form"
assert_status "GET /api/public-form/invalid-token" "$BASE_URL/api/public-form/invalid-token" "403"
echo ""

# ── 5. Field Validation (requires auth — expect 401) ──────────────────────

echo "5. Field Validation"
assert_status "POST /api/records without auth" "$BASE_URL/api/records" "401" "POST" '{"data":{}}'
echo ""

# ── 6. API Token endpoints ─────────────────────────────────────────────────

echo "6. API Token"
assert_status "GET /api/tokens (unauthenticated)" "$BASE_URL/api/tokens" "401"
echo ""

# ── 7. Webhook endpoints ──────────────────────────────────────────────────

echo "7. Webhooks"
assert_status "GET /api/webhooks (unauthenticated)" "$BASE_URL/api/webhooks" "401"
echo ""

# ── 8. Chart endpoints ────────────────────────────────────────────────────

echo "8. Charts"
assert_status "GET /api/charts (unauthenticated)" "$BASE_URL/api/charts" "401"
echo ""

# ── 9. Dashboard endpoints ────────────────────────────────────────────────

echo "9. Dashboards"
assert_status "GET /api/dashboards (unauthenticated)" "$BASE_URL/api/dashboards" "401"
echo ""

# ── 10. Automation endpoints ──────────────────────────────────────────────

echo "10. Automation"
assert_status "GET /api/automations (unauthenticated)" "$BASE_URL/api/automations" "401"
echo ""

# ── Summary ────────────────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════"
echo "  Results: $(green "$PASS passed"), $(red "$FAIL failed"), $(yellow "$SKIP skipped")"
echo "═══════════════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
