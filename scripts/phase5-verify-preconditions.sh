#!/usr/bin/env bash
# Phase 5 Pre-flight Validation Script
# Purpose: Verify environment variables and feature flags before baseline execution
# Usage: bash scripts/phase5-verify-preconditions.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "========================================" echo "Phase 5 Pre-flight Validation"
echo "========================================"
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0
WARNINGS=0

# Helper functions
error() {
    echo -e "${RED}❌ ERROR${NC}: $1"
    ((ERRORS++))
}

warning() {
    echo -e "${YELLOW}⚠️  WARNING${NC}: $1"
    ((WARNINGS++))
}

success() {
    echo -e "${GREEN}✅ OK${NC}: $1"
}

info() {
    echo "ℹ️  $1"
}

# 1. Check required environment variables
echo "【1】Required Environment Variables"
echo "-----------------------------------"

if [ -z "${METRICS_URL:-}" ]; then
    error "METRICS_URL not set"
else
    success "METRICS_URL: $METRICS_URL"
fi

if [ -z "${PROD_JWT:-}" ]; then
    error "PROD_JWT not set"
else
    # Mask JWT in output
    success "PROD_JWT: ${PROD_JWT:0:20}... (length: ${#PROD_JWT})"

    # Validate JWT format (should start with eyJ)
    if [[ ! "$PROD_JWT" =~ ^eyJ ]]; then
        warning "PROD_JWT does not appear to be a valid JWT (should start with 'eyJ')"
    fi
fi

if [ -z "${LOAD_BASE_URL:-}" ]; then
    warning "LOAD_BASE_URL not set, will use default"
else
    success "LOAD_BASE_URL: $LOAD_BASE_URL"
fi

echo ""

# 2. Check feature flags (should be disabled for clean baseline)
echo "【2】Feature Flag Validation"
echo "-----------------------------------"

# COUNT_CACHE_MISS_AS_FALLBACK should be false
if [ "${COUNT_CACHE_MISS_AS_FALLBACK:-false}" = "true" ]; then
    warning "COUNT_CACHE_MISS_AS_FALLBACK=true (baseline should use false for consistency)"
else
    success "COUNT_CACHE_MISS_AS_FALLBACK=false (correct for baseline)"
fi

# ENABLE_PHASE5_INTERNAL should be false
if [ "${ENABLE_PHASE5_INTERNAL:-false}" = "true" ]; then
    error "ENABLE_PHASE5_INTERNAL=true (must be false for production baseline)"
else
    success "ENABLE_PHASE5_INTERNAL=false (correct)"
fi

# ENABLE_FALLBACK_TEST should be false
if [ "${ENABLE_FALLBACK_TEST:-false}" = "true" ]; then
    error "ENABLE_FALLBACK_TEST=true (must be false for production baseline)"
else
    success "ENABLE_FALLBACK_TEST=false (correct)"
fi

echo ""

# 3. Check SLO targets
echo "【3】SLO Target Configuration"
echo "-----------------------------------"

P95_TARGET="${P95_LATENCY_TARGET:-150}"
P99_TARGET="${P99_LATENCY_TARGET:-250}"
MEMORY_TARGET="${MEMORY_SLO_TARGET:-500}"
CACHE_TARGET="${CACHE_HIT_RATE_TARGET:-80}"

success "P95 Latency Target: ${P95_TARGET}ms"
success "P99 Latency Target: ${P99_TARGET}ms"
success "Memory Target: ${MEMORY_TARGET}MB"
success "Cache Hit Rate Target: ${CACHE_TARGET}%"

echo ""

# 4. Verify required scripts exist
echo "【4】Required Scripts Availability"
echo "-----------------------------------"

REQUIRED_SCRIPTS=(
    "scripts/phase5-run-production-baseline.sh"
    "scripts/phase5-load.sh"
    "scripts/phase5-observe.sh"
    "scripts/phase5-fill-production-report.sh"
    "scripts/phase5-append-production.sh"
)

for script in "${REQUIRED_SCRIPTS[@]}"; do
    if [ -f "$PROJECT_ROOT/$script" ]; then
        if [ -x "$PROJECT_ROOT/$script" ]; then
            success "$script (executable)"
        else
            warning "$script (exists but not executable)"
        fi
    else
        error "$script (not found)"
    fi
done

echo ""

# 5. Check connectivity to metrics endpoint
echo "【5】Metrics Endpoint Connectivity"
echo "-----------------------------------"

if [ -n "${METRICS_URL:-}" ]; then
    info "Testing connection to $METRICS_URL..."

    # Try to query Prometheus /api/v1/query endpoint
    if command -v curl &> /dev/null; then
        QUERY_URL="${METRICS_URL}/api/v1/query?query=up"
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$QUERY_URL" -m 10 || echo "000")

        if [ "$HTTP_CODE" = "200" ]; then
            success "Metrics endpoint reachable (HTTP $HTTP_CODE)"
        elif [ "$HTTP_CODE" = "000" ]; then
            error "Cannot reach metrics endpoint (timeout or connection failed)"
        else
            warning "Metrics endpoint returned HTTP $HTTP_CODE (expected 200)"
        fi
    else
        warning "curl not available, skipping connectivity test"
    fi
else
    warning "METRICS_URL not set, skipping connectivity test"
fi

echo ""

# 6. Check production API endpoint
echo "【6】Production API Endpoint Check"
echo "-----------------------------------"

if [ -n "${LOAD_BASE_URL:-}" ] && [ -n "${PROD_JWT:-}" ]; then
    info "Testing connection to $LOAD_BASE_URL/health..."

    if command -v curl &> /dev/null; then
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
            -H "Authorization: Bearer $PROD_JWT" \
            "${LOAD_BASE_URL}/health" -m 10 || echo "000")

        if [ "$HTTP_CODE" = "200" ]; then
            success "Production API reachable and JWT accepted (HTTP $HTTP_CODE)"
        elif [ "$HTTP_CODE" = "401" ]; then
            error "Production API returned 401 Unauthorized (JWT invalid or expired)"
        elif [ "$HTTP_CODE" = "000" ]; then
            error "Cannot reach production API (timeout or connection failed)"
        else
            warning "Production API returned HTTP $HTTP_CODE"
        fi
    else
        warning "curl not available, skipping API test"
    fi
else
    warning "LOAD_BASE_URL or PROD_JWT not set, skipping API test"
fi

echo ""

# 7. Check disk space for results
echo "【7】Disk Space Availability"
echo "-----------------------------------"

RESULTS_DIR="$PROJECT_ROOT/results"
if [ ! -d "$RESULTS_DIR" ]; then
    info "Creating results directory: $RESULTS_DIR"
    mkdir -p "$RESULTS_DIR"
fi

# Check available disk space
if command -v df &> /dev/null; then
    AVAILABLE_MB=$(df -m "$RESULTS_DIR" | tail -1 | awk '{print $4}')
    REQUIRED_MB=100  # Minimum 100MB required

    if [ "$AVAILABLE_MB" -gt "$REQUIRED_MB" ]; then
        success "Disk space available: ${AVAILABLE_MB}MB (> ${REQUIRED_MB}MB required)"
    else
        warning "Low disk space: ${AVAILABLE_MB}MB (< ${REQUIRED_MB}MB recommended)"
    fi
else
    info "df command not available, skipping disk space check"
fi

echo ""

# 8. Summary
echo "========================================"
echo "Pre-flight Validation Summary"
echo "========================================"

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✅ All checks passed!${NC}"
    echo ""
    echo "Ready to execute Phase 5 production baseline:"
    echo "  ./scripts/phase5-run-production-baseline.sh \\"
    echo "    --base-url \"\$LOAD_BASE_URL\" \\"
    echo "    --jwt \"\$PROD_JWT\" \\"
    echo "    --rate 80 --concurrency 20 --samples 12"
    echo ""
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}⚠️  ${WARNINGS} warning(s) found${NC}"
    echo ""
    echo "Warnings detected but Phase 5 can proceed."
    echo "Review warnings above and consider fixing them."
    echo ""
    exit 0
else
    echo -e "${RED}❌ ${ERRORS} error(s) and ${WARNINGS} warning(s) found${NC}"
    echo ""
    echo "Critical errors must be fixed before proceeding:"
    echo "1. Set missing required environment variables"
    echo "2. Disable test/internal feature flags"
    echo "3. Verify credentials and connectivity"
    echo ""
    echo "Run this script again after fixing issues."
    echo ""
    exit 1
fi
