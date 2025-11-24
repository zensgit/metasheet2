#!/bin/bash
#
# Phase 5 CI Validation Script
#
# Runs SLO validation and fails CI if thresholds are violated
#
# Usage:
#   ./phase5-ci-validate.sh <metrics-url>
#
# Example:
#   ./phase5-ci-validate.sh http://localhost:8900/metrics/prom
#
# Exit Codes:
#   0 - All SLO checks passed
#   1 - One or more SLO checks failed
#   2 - Script error (missing dependencies, connection failure, etc.)
#

set -euo pipefail

# Color codes
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m'

# Script directory
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Usage
usage() {
    echo "Usage: $0 <metrics-url>"
    echo ""
    echo "Example:"
    echo "  $0 http://localhost:8900/metrics/prom"
    exit 2
}

# Logging functions
log_info() {
    echo -e "${GREEN}[CI-INFO]${NC} $*"
}

log_error() {
    echo -e "${RED}[CI-ERROR]${NC} $*" >&2
}

log_warning() {
    echo -e "${YELLOW}[CI-WARNING]${NC} $*" >&2
}

# Main validation
main() {
    if [ $# -lt 1 ]; then
        usage
    fi

    local metrics_url="$1"
    local validation_json="/tmp/ci-validation-$$.json"
    local report_md="/tmp/ci-report-$$.md"

    trap "rm -f $validation_json $report_md" EXIT

    log_info "Starting Phase 5 CI validation"
    log_info "Metrics URL: $metrics_url"

    # Run validation
    log_info "Running SLO validation..."

    if ! "${SCRIPT_DIR}/phase5-full-validate.sh" "$metrics_url" "$validation_json" 2>&1 | grep -E '\[INFO\]|\[SUCCESS\]|\[ERROR\]' >&2; then
        validation_exit_code=$?

        if [ $validation_exit_code -eq 1 ]; then
            # Validation ran but failed SLO checks (expected case)
            log_info "Validation completed with SLO violations"
        else
            # Validation script error
            log_error "Validation script failed with exit code $validation_exit_code"
            exit 2
        fi
    fi

    # Check if validation JSON exists
    if [ ! -f "$validation_json" ]; then
        log_error "Validation JSON not generated"
        exit 2
    fi

    # Parse results
    local overall_status=$(jq -r '.summary.overall_status' "$validation_json")
    local passed=$(jq -r '.summary.passed' "$validation_json")
    local failed=$(jq -r '.summary.failed' "$validation_json")
    local total=$(jq -r '.summary.total_checks' "$validation_json")

    log_info "=== Validation Results ==="
    log_info "Total checks: $total"
    log_info "Passed: $passed"
    log_info "Failed: $failed"
    log_info "Overall status: $overall_status"

    # Generate report
    if ! "${SCRIPT_DIR}/phase5-generate-report.sh" "$validation_json" "$report_md" 2>&1 | grep -E '\[SUCCESS\]|\[ERROR\]' >&2; then
        log_warning "Report generation failed (non-critical)"
    fi

    # Extract and display violations
    if [ "$failed" -gt 0 ]; then
        log_error "=== SLO Violations Detected ==="

        local violations=$(jq -r '.assertions[] | select(.status == "fail") | "\(.metric): \(.actual)\(.unit) (threshold: \(.comparison) \(.threshold)\(.unit))"' "$validation_json")

        while IFS= read -r violation; do
            log_error "  ❌ $violation"
        done <<< "$violations"

        # Display report location
        if [ -f "$report_md" ]; then
            log_info "Full report available at: $report_md"
            log_info "Report summary:"
            head -30 "$report_md" | sed 's/^/  /'
        fi

        log_error "CI validation FAILED: $failed/$total checks violated SLO thresholds"
        exit 1
    else
        log_info "=== All SLO Checks Passed ==="
        log_info "✅ CI validation PASSED: All $total checks met SLO requirements"

        # Display passing metrics
        log_info "Passing metrics:"
        jq -r '.assertions[] | "  ✅ \(.metric): \(.actual)\(.unit) \(.comparison) \(.threshold)\(.unit)"' "$validation_json"

        exit 0
    fi
}

# Run main
main "$@"
