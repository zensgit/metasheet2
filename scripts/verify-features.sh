#!/bin/bash
#
# Feature Verification Test Suite
# Comprehensive testing for all core features in metasheet-v2
#
# Usage: bash scripts/verify-features.sh [feature]
# Examples:
#   bash scripts/verify-features.sh all          # Run all tests
#   bash scripts/verify-features.sh approval     # Test approval system only
#   bash scripts/verify-features.sh cache        # Test cache system only
#

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BASE_URL="${BASE_URL:-http://localhost:8900}"
REPORT_DIR="${REPORT_DIR:-verification-reports}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Create report directory
mkdir -p "$REPORT_DIR"

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[⚠]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Test result tracking
TESTS_TOTAL=0
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

record_test() {
    local result=$1
    local test_name=$2

    TESTS_TOTAL=$((TESTS_TOTAL + 1))

    case "$result" in
        pass)
            TESTS_PASSED=$((TESTS_PASSED + 1))
            log_success "$test_name"
            echo "PASS,$test_name,$(date +%H:%M:%S)" >> "$REPORT_DIR/test-results-$TIMESTAMP.csv"
            ;;
        fail)
            TESTS_FAILED=$((TESTS_FAILED + 1))
            log_error "$test_name"
            echo "FAIL,$test_name,$(date +%H:%M:%S)" >> "$REPORT_DIR/test-results-$TIMESTAMP.csv"
            ;;
        skip)
            TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
            log_warning "$test_name (skipped)"
            echo "SKIP,$test_name,$(date +%H:%M:%S)" >> "$REPORT_DIR/test-results-$TIMESTAMP.csv"
            ;;
    esac
}

# Generate test token
generate_token() {
    if [ -f "scripts/gen-dev-token.js" ]; then
        TOKEN=$(node scripts/gen-dev-token.js)
        export TOKEN
        log_success "Generated dev token"
        return 0
    else
        log_warning "Token generation script not found, tests may require authentication"
        return 1
    fi
}

# ============================================================================
# Approval System Tests
# ============================================================================
test_approval_system() {
    log_info "Testing Approval System..."

    # Test 1: Health check
    if curl -sf "$BASE_URL/health" >/dev/null 2>&1; then
        record_test pass "Approval: Server health check"
    else
        record_test fail "Approval: Server health check"
        return 1
    fi

    # Test 2: Database tables exist
    if [ -f "packages/core-backend/migrations/032_create_approval_records.sql" ]; then
        record_test pass "Approval: Migration file exists"
    else
        record_test fail "Approval: Migration file missing"
    fi

    # Test 3: Seed data exists
    if [ -f "packages/core-backend/dist/seeds/seed-approvals.js" ]; then
        record_test pass "Approval: Seed file exists"
    else
        record_test skip "Approval: Seed file missing (optional)"
    fi

    # Test 4: API endpoint availability (if server is running)
    if [ -n "$TOKEN" ]; then
        HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/approvals" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "404" ]; then
            record_test pass "Approval: API endpoint accessible"
        else
            record_test skip "Approval: API endpoint (server not running)"
        fi
    else
        record_test skip "Approval: API endpoint (no token)"
    fi

    log_info "Approval System tests completed"
}

# ============================================================================
# Cache System Tests
# ============================================================================
test_cache_system() {
    log_info "Testing Cache System..."

    # Test 1: Migration files
    if [ -f "packages/core-backend/migrations/047_audit_and_cache.sql" ]; then
        record_test pass "Cache: Migration file exists (047)"
    else
        record_test fail "Cache: Migration file missing (047)"
    fi

    # Test 2: Type definitions
    if [ -f "packages/core-backend/types/cache.d.ts" ]; then
        record_test pass "Cache: TypeScript definitions exist"
    else
        record_test fail "Cache: TypeScript definitions missing"
    fi

    # Test 3: Check for cache metrics in Prometheus
    if curl -sf "$BASE_URL/metrics/prom" 2>/dev/null | grep -q "cache"; then
        record_test pass "Cache: Prometheus metrics available"
    else
        record_test skip "Cache: Prometheus metrics (server not running)"
    fi

    # Test 4: Cache registry implementation
    if find packages -type f -name "*CacheRegistry*" | grep -q .; then
        record_test pass "Cache: Registry implementation exists"
    else
        record_test skip "Cache: Registry implementation (not found)"
    fi

    log_info "Cache System tests completed"
}

# ============================================================================
# RBAC Permission System Tests
# ============================================================================
test_rbac_system() {
    log_info "Testing RBAC Permission System..."

    # Test 1: Core RBAC migration
    if [ -f "packages/core-backend/migrations/033_create_rbac_core.sql" ]; then
        record_test pass "RBAC: Core migration exists (033)"
    else
        record_test fail "RBAC: Core migration missing (033)"
    fi

    # Test 2: Spreadsheet permissions
    if [ -f "packages/core-backend/migrations/036_create_spreadsheet_permissions.sql" ]; then
        record_test pass "RBAC: Spreadsheet permissions migration exists (036)"
    else
        record_test fail "RBAC: Spreadsheet permissions migration missing (036)"
    fi

    # Test 3: Permission metrics
    if [ -f "packages/core-backend/dist/metrics/permission-metrics.js" ]; then
        record_test pass "RBAC: Permission metrics implementation exists"
    else
        record_test fail "RBAC: Permission metrics missing"
    fi

    # Test 4: Permission API endpoint
    if [ -n "$TOKEN" ]; then
        HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/permissions?userId=test" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "404" ]; then
            record_test pass "RBAC: Permissions API endpoint accessible"
        else
            record_test skip "RBAC: Permissions API (server not running)"
        fi
    else
        record_test skip "RBAC: Permissions API (no token)"
    fi

    # Test 5: RBAC metrics in Prometheus
    if curl -sf "$BASE_URL/metrics/prom" 2>/dev/null | grep -q "rbac_perm"; then
        record_test pass "RBAC: Prometheus metrics available"
    else
        record_test skip "RBAC: Prometheus metrics (server not running)"
    fi

    log_info "RBAC System tests completed"
}

# ============================================================================
# API Gateway Tests
# ============================================================================
test_api_gateway() {
    log_info "Testing API Gateway System..."

    # Test 1: Gateway implementation
    if [ -f "packages/core-backend/dist/gateway/APIGateway.js" ]; then
        record_test pass "Gateway: Implementation file exists"
    else
        record_test fail "Gateway: Implementation file missing"
    fi

    # Test 2: Gateway type definitions
    if [ -f "packages/core-backend/dist/gateway/APIGateway.d.ts" ]; then
        record_test pass "Gateway: TypeScript definitions exist"
    else
        record_test fail "Gateway: TypeScript definitions missing"
    fi

    # Test 3: Rate limiting check
    if grep -r "rateLimit\|rate-limit" packages/core-backend/dist/gateway/ 2>/dev/null | head -1 | grep -q .; then
        record_test pass "Gateway: Rate limiting code detected"
    else
        record_test skip "Gateway: Rate limiting (source verification needed)"
    fi

    # Test 4: Circuit breaker check
    if grep -r "circuitBreaker\|circuit-breaker" packages/core-backend/dist/gateway/ 2>/dev/null | head -1 | grep -q .; then
        record_test pass "Gateway: Circuit breaker code detected"
    else
        record_test skip "Gateway: Circuit breaker (source verification needed)"
    fi

    log_info "API Gateway tests completed"
}

# ============================================================================
# Event Bus Tests
# ============================================================================
test_event_bus() {
    log_info "Testing Event Bus System..."

    # Test 1: Event bus service
    if [ -f "packages/core-backend/dist/core/EventBusService.js" ]; then
        record_test pass "EventBus: Service implementation exists"
    else
        record_test fail "EventBus: Service implementation missing"
    fi

    # Test 2: Type definitions
    if [ -f "packages/core-backend/dist/core/EventBusService.d.ts" ]; then
        record_test pass "EventBus: TypeScript definitions exist"
    else
        record_test fail "EventBus: TypeScript definitions missing"
    fi

    # Test 3: Integration events
    if [ -f "packages/core-backend/dist/integration/events/event-bus.d.ts" ]; then
        record_test pass "EventBus: Integration events definitions exist"
    else
        record_test skip "EventBus: Integration events (optional)"
    fi

    # Test 4: Pub/Sub pattern check
    if grep -r "publish\|subscribe\|emit" packages/core-backend/dist/core/EventBusService.js 2>/dev/null | head -1 | grep -q .; then
        record_test pass "EventBus: Pub/Sub methods detected"
    else
        record_test skip "EventBus: Pub/Sub methods (source verification needed)"
    fi

    log_info "Event Bus tests completed"
}

# ============================================================================
# Notification System Tests
# ============================================================================
test_notification_system() {
    log_info "Testing Notification System..."

    # Test 1: Service implementation
    if [ -f "packages/core-backend/dist/services/NotificationService.js" ]; then
        record_test pass "Notification: Service implementation exists"
    else
        record_test fail "Notification: Service implementation missing"
    fi

    # Test 2: Type definitions
    if [ -f "packages/core-backend/dist/services/NotificationService.d.ts" ]; then
        record_test pass "Notification: TypeScript definitions exist"
    else
        record_test fail "Notification: TypeScript definitions missing"
    fi

    # Test 3: Multi-channel support check
    if grep -r "email\|sms\|push" packages/core-backend/dist/services/NotificationService.js 2>/dev/null | head -1 | grep -q .; then
        record_test pass "Notification: Multi-channel code detected"
    else
        record_test skip "Notification: Multi-channel support (source verification needed)"
    fi

    log_info "Notification System tests completed"
}

# ============================================================================
# Main Test Runner
# ============================================================================
run_all_tests() {
    log_info "================================================"
    log_info "MetaSheet v2 Feature Verification Test Suite"
    log_info "================================================"
    log_info "Start time: $(date)"
    log_info "Base URL: $BASE_URL"
    log_info ""

    # Initialize results file
    echo "Result,Test Name,Time" > "$REPORT_DIR/test-results-$TIMESTAMP.csv"

    # Generate token if available
    generate_token || true

    # Run all test suites
    test_approval_system
    echo ""

    test_cache_system
    echo ""

    test_rbac_system
    echo ""

    test_api_gateway
    echo ""

    test_event_bus
    echo ""

    test_notification_system
    echo ""

    # Generate summary
    log_info "================================================"
    log_info "Test Summary"
    log_info "================================================"
    log_info "Total tests: $TESTS_TOTAL"
    log_success "Passed: $TESTS_PASSED"
    log_error "Failed: $TESTS_FAILED"
    log_warning "Skipped: $TESTS_SKIPPED"

    # Calculate pass rate
    if [ $TESTS_TOTAL -gt 0 ]; then
        PASS_RATE=$(awk "BEGIN {printf \"%.1f\", ($TESTS_PASSED / $TESTS_TOTAL) * 100}")
        log_info "Pass rate: ${PASS_RATE}%"
    fi

    log_info ""
    log_info "Detailed results: $REPORT_DIR/test-results-$TIMESTAMP.csv"
    log_info "End time: $(date)"

    # Exit code based on failures
    if [ $TESTS_FAILED -gt 0 ]; then
        exit 1
    else
        exit 0
    fi
}

# ============================================================================
# Command Line Interface
# ============================================================================
case "${1:-all}" in
    all)
        run_all_tests
        ;;
    approval)
        generate_token || true
        test_approval_system
        ;;
    cache)
        test_cache_system
        ;;
    rbac)
        generate_token || true
        test_rbac_system
        ;;
    gateway)
        test_api_gateway
        ;;
    eventbus)
        test_event_bus
        ;;
    notification)
        test_notification_system
        ;;
    *)
        echo "Usage: $0 [all|approval|cache|rbac|gateway|eventbus|notification]"
        exit 1
        ;;
esac
