#!/bin/bash
#
# Phase 5 Full Validation Orchestrator
#
# Integrates all Phase 5 components:
# - Thresholds configuration (phase5-thresholds.json)
# - Percentile calculation (phase5-metrics-percentiles.ts)
# - Fallback taxonomy validation
# - Effective fallback calculation
# - SLO threshold assertions
# - Comprehensive JSON output
#
# Usage:
#   ./phase5-full-validate.sh <metrics-url> [output-json-path]
#
# Example:
#   ./phase5-full-validate.sh http://localhost:8900/metrics/prom
#   ./phase5-full-validate.sh http://localhost:8900/metrics/prom /tmp/phase5-validation.json
#

set -euo pipefail

# Color codes
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

# Script directory
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Configuration files
readonly THRESHOLDS_FILE="${SCRIPT_DIR}/phase5-thresholds.json"
readonly PERCENTILES_SCRIPT="${SCRIPT_DIR}/phase5-metrics-percentiles.ts"

# Environment configuration
readonly COUNT_CACHE_MISS_AS_FALLBACK="${COUNT_CACHE_MISS_AS_FALLBACK:-false}"

# Usage
usage() {
    echo "Usage: $0 <metrics-url> [output-json-path]"
    echo ""
    echo "Examples:"
    echo "  $0 http://localhost:8900/metrics/prom"
    echo "  $0 http://localhost:8900/metrics/prom /tmp/validation.json"
    exit 1
}

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $*" >&2
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*" >&2
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $*" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

# Validate prerequisites
validate_prerequisites() {
    log_info "Validating prerequisites..."

    # Check thresholds file
    if [ ! -f "$THRESHOLDS_FILE" ]; then
        log_error "Thresholds file not found: $THRESHOLDS_FILE"
        exit 1
    fi

    # Check percentiles script
    if [ ! -f "$PERCENTILES_SCRIPT" ]; then
        log_error "Percentiles script not found: $PERCENTILES_SCRIPT"
        exit 1
    fi

    # Check required commands
    for cmd in jq curl npx bc; do
        if ! command -v $cmd &> /dev/null; then
            log_error "Required command not found: $cmd"
            exit 1
        fi
    done

    log_success "Prerequisites validated"
}

# Fetch raw metrics from Prometheus
fetch_raw_metrics() {
    local metrics_url="$1"
    local temp_file="$2"

    log_info "Fetching raw metrics from $metrics_url..."

    if ! curl -fsS "$metrics_url" > "$temp_file"; then
        log_error "Failed to fetch metrics from $metrics_url"
        exit 1
    fi

    log_success "Raw metrics fetched ($(wc -l < "$temp_file") lines)"
}

# Calculate percentiles using Node.js script
calculate_percentiles() {
    local metrics_url="$1"
    local output_file="$2"

    log_info "Calculating percentiles..."

    if ! npx tsx "$PERCENTILES_SCRIPT" "$metrics_url" "$output_file" 2>&1 | grep -E '\[INFO\]|\[SUCCESS\]|\[ERROR\]' >&2; then
        log_error "Failed to calculate percentiles"
        exit 1
    fi

    log_success "Percentiles calculated"
}

# Extract counter/gauge metrics from raw Prometheus data
extract_metric() {
    local raw_file="$1"
    local metric_name="$2"

    grep "^${metric_name}[{ ]" "$raw_file" | grep -v "^#" | awk '{print $2}' | head -1 || echo "0"
}

# Calculate cache hit rate
calculate_cache_hit_rate() {
    local raw_file="$1"

    local cache_hits=$(extract_metric "$raw_file" "cache_hits_total")
    local cache_misses=$(extract_metric "$raw_file" "cache_misses_total")
    local total=$((cache_hits + cache_misses))

    if [ "$total" -gt 0 ]; then
        echo "scale=2; $cache_hits * 100 / $total" | bc
    else
        echo "0"
    fi
}

# Extract fallback metrics by reason
extract_fallback_by_reason() {
    local raw_file="$1"

    local result="{"

    # Valid fallback reasons from thresholds.json
    local reasons=("http_timeout" "http_error" "message_timeout" "message_error" "cache_miss" "circuit_breaker")

    for reason in "${reasons[@]}"; do
        local count=$(grep "metasheet_fallback_total.*reason=\"${reason}\"" "$raw_file" | awk '{print $2}' | head -1 || echo "0")
        result+="\"${reason}\":${count},"
    done

    # Remove trailing comma and close brace
    result="${result%,}}"

    echo "$result"
}

# Calculate effective fallback
calculate_effective_fallback() {
    local raw_file="$1"
    local fallback_by_reason="$2"

    local raw_total=$(extract_metric "$raw_file" "metasheet_fallback_total")
    local cache_miss=$(echo "$fallback_by_reason" | jq -r '.cache_miss // 0')

    if [ "$COUNT_CACHE_MISS_AS_FALLBACK" = "false" ]; then
        local effective=$((raw_total - cache_miss))
        echo "$effective"
    else
        echo "$raw_total"
    fi
}

# Validate fallback taxonomy
validate_fallback_taxonomy() {
    local raw_file="$1"

    log_info "Validating fallback taxonomy..."

    # Extract all reason labels
    local reasons=$(grep "metasheet_fallback_total.*reason=" "$raw_file" | grep -oP 'reason="[^"]*"' | cut -d'"' -f2 | sort -u)

    # Valid reasons from thresholds.json
    local valid_reasons=("http_timeout" "http_error" "message_timeout" "message_error" "cache_miss" "circuit_breaker")

    local invalid_found=false

    while IFS= read -r reason; do
        if [ -z "$reason" ]; then
            continue
        fi

        local is_valid=false
        for valid in "${valid_reasons[@]}"; do
            if [ "$reason" = "$valid" ]; then
                is_valid=true
                break
            fi
        done

        if [ "$is_valid" = false ]; then
            log_warning "Invalid fallback reason found: $reason"
            invalid_found=true
        fi
    done <<< "$reasons"

    if [ "$invalid_found" = false ]; then
        log_success "Fallback taxonomy validated"
        echo "true"
    else
        echo "false"
    fi
}

# Assert threshold and generate violation
assert_threshold() {
    local metric_name="$1"
    local actual_value="$2"
    local threshold_type="$3"  # upper_bound or lower_bound
    local threshold_value="$4"
    local unit="$5"

    local pass=false
    local comparison=""

    if [ "$threshold_type" = "upper_bound" ]; then
        comparison="≤"
        if (( $(echo "$actual_value <= $threshold_value" | bc -l) )); then
            pass=true
        fi
    else  # lower_bound
        comparison="≥"
        if (( $(echo "$actual_value >= $threshold_value" | bc -l) )); then
            pass=true
        fi
    fi

    local status=$([ "$pass" = true ] && echo "pass" || echo "fail")

    # JSON output
    cat <<EOF
{
  "metric": "$metric_name",
  "actual": $actual_value,
  "threshold": $threshold_value,
  "unit": "$unit",
  "type": "$threshold_type",
  "comparison": "$comparison",
  "status": "$status"
}
EOF
}

# Main validation logic
main() {
    # Parse arguments
    if [ $# -lt 1 ]; then
        usage
    fi

    local metrics_url="$1"
    local output_path="${2:-}"

    validate_prerequisites

    # Temporary files
    local temp_raw=$(mktemp)
    local temp_percentiles=$(mktemp)
    trap "rm -f $temp_raw $temp_percentiles" EXIT

    # Fetch raw metrics
    fetch_raw_metrics "$metrics_url" "$temp_raw"

    # Calculate percentiles
    calculate_percentiles "$metrics_url" "$temp_percentiles"

    # Load percentiles data
    local percentiles_json=$(cat "$temp_percentiles")

    # Extract cache hit rate
    local cache_hit_rate=$(calculate_cache_hit_rate "$temp_raw")
    log_info "Cache hit rate: ${cache_hit_rate}%"

    # Extract and validate fallback data
    local fallback_taxonomy_valid=$(validate_fallback_taxonomy "$temp_raw")
    local fallback_by_reason=$(extract_fallback_by_reason "$temp_raw")
    local raw_fallback=$(extract_metric "$temp_raw" "metasheet_fallback_total")
    local effective_fallback=$(calculate_effective_fallback "$temp_raw" "$fallback_by_reason")

    log_info "Raw fallback: $raw_fallback, Effective fallback: $effective_fallback"

    # Extract HTTP success rate and error rate
    local http_2xx=$(extract_metric "$temp_raw" "http_requests_total.*status=\"2")
    local http_3xx=$(extract_metric "$temp_raw" "http_requests_total.*status=\"3")
    local http_4xx=$(extract_metric "$temp_raw" "http_requests_total.*status=\"4")
    local http_5xx=$(extract_metric "$temp_raw" "http_requests_total.*status=\"5")
    local http_total=$((http_2xx + http_3xx + http_4xx + http_5xx))

    local http_success_rate=0
    local error_rate=0

    if [ "$http_total" -gt 0 ]; then
        http_success_rate=$(echo "scale=2; ($http_2xx + $http_3xx) * 100 / $http_total" | bc)
        error_rate=$(echo "scale=2; ($http_4xx + $http_5xx) * 100 / $http_total" | bc)
    fi

    # Extract memory RSS P95 (requires histogram parsing or direct gauge)
    local memory_rss_bytes=$(extract_metric "$temp_raw" "process_resident_memory_bytes")
    local memory_rss_mb=$(echo "scale=2; $memory_rss_bytes / 1024 / 1024" | bc)

    # Load thresholds
    local thresholds=$(jq -r '.thresholds' "$THRESHOLDS_FILE")

    # Generate assertions
    local assertions="["

    # Plugin reload P95/P99 (from percentiles)
    local plugin_p95=$(echo "$percentiles_json" | jq -r '.metrics.metasheet_plugin_reload_duration_seconds.p95 // 0')
    local plugin_p99=$(echo "$percentiles_json" | jq -r '.metrics.metasheet_plugin_reload_duration_seconds.p99 // 0')

    assertions+=$(assert_threshold "plugin_reload_latency_p95" "$plugin_p95" "upper_bound" "2.0" "seconds")","
    assertions+=$(assert_threshold "plugin_reload_latency_p99" "$plugin_p99" "upper_bound" "5.0" "seconds")","

    # Snapshot restore P95/P99
    local snapshot_p95=$(echo "$percentiles_json" | jq -r '.metrics.metasheet_snapshot_restore_duration_seconds.p95 // 0')
    local snapshot_p99=$(echo "$percentiles_json" | jq -r '.metrics.metasheet_snapshot_restore_duration_seconds.p99 // 0')

    assertions+=$(assert_threshold "snapshot_restore_latency_p95" "$snapshot_p95" "upper_bound" "5.0" "seconds")","
    assertions+=$(assert_threshold "snapshot_restore_latency_p99" "$snapshot_p99" "upper_bound" "8.0" "seconds")","

    # Cache hit rate
    assertions+=$(assert_threshold "cache_hit_rate" "$cache_hit_rate" "lower_bound" "80.0" "percent")","

    # HTTP success rate
    assertions+=$(assert_threshold "http_success_rate" "$http_success_rate" "lower_bound" "98.0" "percent")","

    # Error rate
    assertions+=$(assert_threshold "error_rate" "$error_rate" "upper_bound" "1.0" "percent")","

    # Memory RSS (using gauge, not P95 for now)
    assertions+=$(assert_threshold "memory_rss" "$memory_rss_mb" "upper_bound" "500.0" "megabytes")

    assertions+="]"

    # Calculate overall pass/fail
    local pass_count=$(echo "$assertions" | jq '[.[] | select(.status == "pass")] | length')
    local fail_count=$(echo "$assertions" | jq '[.[] | select(.status == "fail")] | length')
    local overall_status=$([ "$fail_count" -eq 0 ] && echo "pass" || echo "fail")

    # Construct final JSON
    local final_json=$(cat <<EOF
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "metrics_url": "$metrics_url",
  "configuration": {
    "count_cache_miss_as_fallback": $COUNT_CACHE_MISS_AS_FALLBACK,
    "thresholds_file": "$THRESHOLDS_FILE"
  },
  "percentiles": $(echo "$percentiles_json" | jq '.metrics'),
  "counters": {
    "cache_hit_rate": $cache_hit_rate,
    "raw_fallback": $raw_fallback,
    "effective_fallback": $effective_fallback,
    "http_success_rate": $http_success_rate,
    "error_rate": $error_rate,
    "memory_rss_mb": $memory_rss_mb,
    "fallback_by_reason": $fallback_by_reason
  },
  "validation": {
    "fallback_taxonomy_valid": $fallback_taxonomy_valid
  },
  "assertions": $assertions,
  "summary": {
    "total_checks": $((pass_count + fail_count)),
    "passed": $pass_count,
    "failed": $fail_count,
    "overall_status": "$overall_status"
  }
}
EOF
)

    # Output result
    if [ -n "$output_path" ]; then
        echo "$final_json" > "$output_path"
        log_success "Validation result written to $output_path"
    else
        echo "$final_json"
    fi

    # Print summary
    log_info "=== Validation Summary ==="
    log_info "Total checks: $((pass_count + fail_count))"
    log_info "Passed: ${GREEN}$pass_count${NC}"
    log_info "Failed: ${RED}$fail_count${NC}"
    log_info "Overall status: $([ "$overall_status" = "pass" ] && echo -e "${GREEN}PASS${NC}" || echo -e "${RED}FAIL${NC}")"

    # Exit code based on overall status
    [ "$overall_status" = "pass" ] && exit 0 || exit 1
}

# Run main
main "$@"
