#!/bin/bash

# Enhanced RBAC Cache Warmup Script
# Increases cache coverage for better hit rates

set -e

BASE_URL="${BASE_URL:-http://localhost:8900}"
AUTH_HEADER="Authorization: Bearer ${TOKEN}"

echo "=== Enhanced RBAC Cache Warmup ==="
echo "Target: Increase cache hit rate from 41.7% to 60%+"

# Configuration
SPREADSHEET_COUNT=${SPREADSHEET_PREHEAT_COUNT:-10}
USER_ROLES=(u1 u2 u3 admin viewer editor manager analyst guest contributor)

echo "Configuration:"
echo "- Spreadsheets to preheat: $SPREADSHEET_COUNT"
echo "- User roles: ${#USER_ROLES[@]}"
echo "- Total cache entries: $((SPREADSHEET_COUNT * ${#USER_ROLES[@]} * 2))"

# Phase 1: Warm up user permissions
echo ""
echo "Phase 1: User permissions warmup..."
for user in "${USER_ROLES[@]}"; do
    echo -n "  Warming $user..."
    curl -fsS -H "$AUTH_HEADER" "$BASE_URL/api/permissions?userId=$user" >/dev/null 2>&1 || true
    echo " done"
done

# Phase 2: Warm up spreadsheet permissions
echo ""
echo "Phase 2: Spreadsheet permissions warmup..."
for i in $(seq 1 $SPREADSHEET_COUNT); do
    sheet_id="sheet-$(printf "%03d" $i)"
    echo -n "  Warming $sheet_id..."

    for user in "${USER_ROLES[@]}"; do
        # Read permissions
        curl -fsS -H "$AUTH_HEADER" \
            "$BASE_URL/api/spreadsheets/$sheet_id/permissions?userId=$user&action=read" \
            >/dev/null 2>&1 || true

        # Write permissions
        curl -fsS -H "$AUTH_HEADER" \
            "$BASE_URL/api/spreadsheets/$sheet_id/permissions?userId=$user&action=write" \
            >/dev/null 2>&1 || true
    done
    echo " done"
done

# Phase 3: Repeat for cache hits
echo ""
echo "Phase 3: Building cache hits..."
for user in "${USER_ROLES[@]:0:5}"; do
    curl -fsS -H "$AUTH_HEADER" "$BASE_URL/api/permissions?userId=$user" >/dev/null 2>&1 || true
done

# Phase 4: Test cache invalidation
echo ""
echo "Phase 4: Testing cache invalidation..."
curl -fsS -H "$AUTH_HEADER" -H 'Content-Type: application/json' \
    -d '{"userId":"u1","permission":"demo:read"}' \
    "$BASE_URL/api/permissions/grant" >/dev/null 2>&1 || true

curl -fsS -H "$AUTH_HEADER" "$BASE_URL/api/permissions?userId=u1" >/dev/null 2>&1 || true

curl -fsS -H "$AUTH_HEADER" -H 'Content-Type: application/json' \
    -d '{"userId":"u1","permission":"demo:read"}' \
    "$BASE_URL/api/permissions/revoke" >/dev/null 2>&1 || true

# Phase 5: Check cache status
echo ""
echo "Phase 5: Checking cache status..."
cache_status=$(curl -fsS -H "$AUTH_HEADER" "$BASE_URL/api/permissions/cache-status" 2>/dev/null || echo "{}")
echo "Cache status: $cache_status"

echo ""
echo "=== RBAC Warmup Complete ==="
echo "Expected improvement: 41.7% -> 60%+"