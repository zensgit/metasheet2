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

# Resolve a TS runner (prefer pnpm workspace tsx, fallback to npx tsx)
resolve_tsx_runner() {
    if command -v pnpm >/dev/null 2>&1; then
        echo "pnpm -F @metasheet/core-backend exec tsx"
        return
    fi
    echo "npx tsx"
}

# Calculate percentiles using Node.js script
calculate_percentiles() {
    local metrics_url="$1"
    local output_file="$2"

    log_info "Calculating percentiles..."

    local TSX_CMD
    TSX_CMD=$(resolve_tsx_runner)

    # Ensure thresholds path is available to the TS script regardless of cwd (use non-readonly env var)
    export THRESHOLDS_PATH="$THRESHOLDS_FILE"

    if ! eval "$TSX_CMD \"$PERCENTILES_SCRIPT\" \"$metrics_url\" \"$output_file\"" 2>&1 | grep -E '\[INFO\]|\[SUCCESS\]|\[ERROR\]' >&2; then
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
# Note: Uses cache_miss_total (singular) which is the actual metric name
calculate_cache_hit_rate() {
    local raw_file="$1"

    # Sum all cache_hits_total entries (may have labels)
    local cache_hits=$(grep "^cache_hits_total" "$raw_file" | grep -v "^#" | awk '{sum+=$2} END {print sum+0}')
    # Sum all cache_miss_total entries (singular, not misses)
    local cache_misses=$(grep "^cache_miss_total" "$raw_file" | grep -v "^#" | awk '{sum+=$2} END {print sum+0}')

    local total=$((cache_hits + cache_misses))

    if [ "$total" -gt 0 ]; then
        echo "scale=2; $cache_hits * 100 / $total" | bc
    else
        echo "0"
    fi
}

# Calculate HTTP metrics (success rate and error rate)
calculate_http_metrics() {
    local raw_file="$1"

    log_info "Calculating HTTP metrics..."

    # Parse all http_requests_total lines and extract status codes
    local total_2xx=0 total_3xx=0 total_4xx=0 total_5xx=0

    # Use awk to extract status from labels and aggregate counts
    while IFS= read -r line; do
        # Extract status code and count
        local status=$(echo "$line" | grep -oE 'status="[0-9]+"' | cut -d'"' -f2)
        local count=$(echo "$line" | awk '{print $NF}')

        # Aggregate by status class
        case "$status" in
            2*) total_2xx=$(echo "$total_2xx + $count" | bc);;
            3*) total_3xx=$(echo "$total_3xx + $count" | bc);;
            4*) total_4xx=$(echo "$total_4xx + $count" | bc);;
            5*) total_5xx=$(echo "$total_5xx + $count" | bc);;
        esac
    done < <(grep '^http_requests_total{' "$raw_file" | grep -v '^#')

    # Calculate rates
    local total_requests=$(echo "$total_2xx + $total_3xx + $total_4xx + $total_5xx" | bc)

    local http_success_rate=0
    local error_rate=0

    if (( $(echo "$total_requests > 0" | bc -l) )); then
        http_success_rate=$(echo "scale=2; ($total_2xx + $total_3xx) * 100 / $total_requests" | bc)
        error_rate=$(echo "scale=2; ($total_4xx + $total_5xx) * 100 / $total_requests" | bc)
    fi

    # Return as JSON
    cat <<EOF
{
  "success_rate": $http_success_rate,
  "error_rate": $error_rate,
  "counts": {
    "2xx": $total_2xx,
    "3xx": $total_3xx,
    "4xx": $total_4xx,
    "5xx": $total_5xx,
    "total": $total_requests
  }
}
EOF
}

# Extract fallback metrics by reason
extract_fallback_by_reason() {
    local raw_file="$1"

    local result="{"

    # Load valid fallback reasons from thresholds.json (canonical source)
    local reasons_json=$(jq -r '.validation_rules.fallback_taxonomy.valid_reasons[]' "$THRESHOLDS_FILE")

    local first=true
    while IFS= read -r reason; do
        local count=$(grep "metasheet_fallback_total.*reason=\"${reason}\"" "$raw_file" | awk '{print $2}' | head -1 || echo "0")

        if [ "$first" = true ]; then
            result+="\"${reason}\":${count}"
            first=false
        else
            result+=",\"${reason}\":${count}"
        fi
    done <<< "$reasons_json"

    result+="}"

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
        # Guard against negative values (defensive programming)
        if [ "$effective" -lt 0 ]; then
            effective=0
        fi
        echo "$effective"
    else
        echo "$raw_total"
    fi
}

# Validate fallback taxonomy
validate_fallback_taxonomy() {
    local raw_file="$1"

    log_info "Validating fallback taxonomy..."

    # Extract all reason labels (using grep -oE for macOS compatibility)
    local reasons=$(grep "metasheet_fallback_total.*reason=" "$raw_file" | grep -oE 'reason="[^"]*"' | cut -d'"' -f2 | sort -u)

    # Load valid reasons from thresholds.json (canonical source)
    local valid_reasons_json=$(jq -r '.validation_rules.fallback_taxonomy.valid_reasons[]' "$THRESHOLDS_FILE")

    # Convert to array
    local valid_reasons=()
    while IFS= read -r vr; do
        valid_reasons+=("$vr")
    done <<< "$valid_reasons_json"

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

# Detect histogram sample issues and generate warnings
# Checks for:
# - Empty histograms (count = 0)
# - Low sample counts (count < 5) - may cause unstable percentiles
detect_histogram_warnings() {
    local percentiles_json="$1"
    local raw_fallback="$2"

    local warnings="["
    local first=true

    # Check each histogram metric
    for metric in $(echo "$percentiles_json" | jq -r '.metrics | keys[]'); do
        local count=$(echo "$percentiles_json" | jq -r --arg key "$metric" '.metrics[$key].count // 0')

        if [ "$count" -eq 0 ]; then
            if [ "$first" = false ]; then
                warnings+=","
            fi

            # Escape metric name safely for JSON (handles embedded quotes/braces)
            local esc_metric=$(printf '%s' "$metric" | jq -R '@json')
            warnings+=$(cat <<EOF
{
  "metric": $esc_metric,
  "issue": "no_samples",
  "message": "Histogram has 0 samples - cannot validate latency SLO reliably"
}
EOF
)
            first=false
        elif [ "$count" -lt 5 ]; then
            if [ "$first" = false ]; then
                warnings+=","
            fi

            local esc_metric=$(printf '%s' "$metric" | jq -R '@json')
            warnings+=$(cat <<EOF
{
  "metric": $esc_metric,
  "issue": "low_sample_count",
  "count": $count,
  "message": "Histogram has only $count samples - percentiles may be unstable (recommend >= 5)"
}
EOF
)
            first=false
        fi
    done

    # Add warning for zero fallback events (acceptable baseline)
    if [ "$raw_fallback" -eq 0 ]; then
        if [ "$first" = false ]; then
            warnings+=","
        fi

        warnings+=$(cat <<EOF
{
  "metric": "metasheet_fallback_total",
  "issue": "no_fallback_events",
  "message": "No fallback events observed - acceptable baseline (ratio trivially 0)"
}
EOF
)
        first=false
    fi

    warnings+="]"

    echo "$warnings"
}

# Assert threshold and generate violation
assert_threshold() {
    local metric_name="$1"
    local actual_value="$2"
    local threshold_type="$3"  # upper_bound or lower_bound
    local threshold_value="$4"
    local unit="$5"
    local sample_count="${6:-1}"  # optional 6th parameter, default to 1

    local pass=false
    local comparison=""
    local status=""

    # Check for NA status: latency metrics with zero samples
    if [ "$unit" = "seconds" ] && [ "$sample_count" -eq 0 ]; then
        status="na"
        comparison="N/A"
    else
        # Normal pass/fail logic
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

        status=$([ "$pass" = true ] && echo "pass" || echo "fail")
    fi

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

    # Redis recent failures (15m): derive from last_failure_timestamp if present
    local redis_recent_failures=0
    local last_fail_ts=$(grep '^redis_last_failure_timestamp ' "$temp_raw" | awk '{print $2}' | head -1 || true)
    if [ -n "$last_fail_ts" ]; then
        # consider a failure "recent" if within last 900s (15m)
        local now_ts=$(date +%s)
        # last_fail_ts may be float; cast to int seconds
        local last_int=${last_fail_ts%.*}
        if [ $(( now_ts - last_int )) -le 900 ]; then
            redis_recent_failures=1
        fi
    fi

    # Extract and validate fallback data
    local fallback_taxonomy_valid=$(validate_fallback_taxonomy "$temp_raw")
    local fallback_by_reason=$(extract_fallback_by_reason "$temp_raw")
    local raw_fallback=$(extract_metric "$temp_raw" "metasheet_fallback_total")
    local effective_fallback=$(calculate_effective_fallback "$temp_raw" "$fallback_by_reason")

    # Calculate fallback_effective_ratio
    local fallback_effective_ratio=0
    if [ "$raw_fallback" -gt 0 ]; then
        fallback_effective_ratio=$(echo "scale=4; $effective_fallback / $raw_fallback" | bc)
    fi

    log_info "Raw fallback: $raw_fallback, Effective fallback: $effective_fallback, Ratio: $fallback_effective_ratio"

    # Calculate HTTP metrics (success rate and error rate)
    local http_metrics_json=$(calculate_http_metrics "$temp_raw")
    local http_success_rate=$(echo "$http_metrics_json" | jq -r '.success_rate')
    local error_rate=$(echo "$http_metrics_json" | jq -r '.error_rate')

    log_info "HTTP success rate: ${http_success_rate}%, Error rate: ${error_rate}%"

    # Extract memory RSS (gauge metric, not histogram)
    local memory_rss_bytes=$(extract_metric "$temp_raw" "process_resident_memory_bytes")
    local memory_rss_mb=$(echo "scale=2; $memory_rss_bytes / 1024 / 1024" | bc)

    # Detect histogram warnings (empty + low sample counts + fallback baseline)
    local warnings=$(detect_histogram_warnings "$percentiles_json" "$raw_fallback")

    # Generate assertions dynamically from thresholds.json
    log_info "Generating dynamic assertions from thresholds..."

    local assertions="["
    local first_assertion=true

    # Iterate through thresholds and generate assertions
    while IFS= read -r threshold_obj; do
        local metric=$(echo "$threshold_obj" | jq -r '.metric')
        local kind=$(echo "$threshold_obj" | jq -r '.kind')
        local threshold_val=$(echo "$threshold_obj" | jq -r '.threshold')
        local unit=$(echo "$threshold_obj" | jq -r '.unit')
        local type=$(echo "$threshold_obj" | jq -r '.type')
        local prom_metric=$(echo "$threshold_obj" | jq -r '.prometheus_metric // empty')

        local actual_value=0
        local sample_count=1  # default for non-latency metrics

        # Determine actual value based on metric kind and name
        case "$kind" in
            latency)
                # Extract percentile from metric name (e.g., plugin_reload_latency_p95 → p95)
                local percentile_type=$(echo "$metric" | grep -oE 'p[0-9]+' | tail -1)

                if [ -n "$prom_metric" ] && [ -n "$percentile_type" ]; then
                    # Check if metric has label selector (for labeled histograms)
                    local label_selector=$(echo "$threshold_obj" | jq -r '.label_selector // empty')

                    if [ -n "$label_selector" ]; then
                        # Build metric key with labels: metric{label1="value1",label2="value2"}
                        local label_str=$(echo "$label_selector" | jq -r 'to_entries | map("\(.key)=\"\(.value)\"") | join(",")')
                        local metric_key="${prom_metric}{${label_str}}"
                        # Use jq --arg to pass metric_key safely (avoids quote escaping issues)
                        actual_value=$(echo "$percentiles_json" | jq -r --arg key "$metric_key" --arg ptype "$percentile_type" '.metrics[$key][$ptype] // 0')
                        sample_count=$(echo "$percentiles_json" | jq -r --arg key "$metric_key" '.metrics[$key].count // 0')
                    else
                        # No labels, use metric name directly
                        actual_value=$(echo "$percentiles_json" | jq -r --arg key "$prom_metric" --arg ptype "$percentile_type" '.metrics[$key][$ptype] // 0')
                        sample_count=$(echo "$percentiles_json" | jq -r --arg key "$prom_metric" '.metrics[$key].count // 0')
                    fi
                fi
                ;;
            percentage)
                # Map metric names to calculated values
                case "$metric" in
                    cache_hit_rate) actual_value=$cache_hit_rate;;
                    http_success_rate) actual_value=$http_success_rate;;
                    error_rate) actual_value=$error_rate;;
                esac
                ;;
            ratio)
                # Handle fallback_effective_ratio
                case "$metric" in
                    fallback_effective_ratio) actual_value=$fallback_effective_ratio;;
                esac
                ;;
            memory)
                # Memory RSS
                case "$metric" in
                    memory_rss) actual_value=$memory_rss_mb;;
                esac
                ;;
        esac

        # Add assertion
        if [ "$first_assertion" = false ]; then
            assertions+=","
        fi

        assertions+=$(assert_threshold "$metric" "$actual_value" "$type" "$threshold_val" "$unit" "$sample_count")

        first_assertion=false

    done < <(jq -c '.thresholds[]' "$THRESHOLDS_FILE")

    assertions+="]"

    log_success "Dynamic assertions generated ($(echo "$assertions" | jq 'length') checks)"

    # Calculate overall pass/fail
    local pass_count=$(echo "$assertions" | jq '[.[] | select(.status == "pass")] | length')
    local fail_count=$(echo "$assertions" | jq '[.[] | select(.status == "fail")] | length')
    local na_count=$(echo "$assertions" | jq '[.[] | select(.status == "na")] | length')
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
    "fallback_effective_ratio": $fallback_effective_ratio,
    "http_success_rate": $http_success_rate,
    "error_rate": $error_rate,
    "memory_rss_mb": $memory_rss_mb,
    "redis_recent_failures": $redis_recent_failures,
    "fallback_by_reason": $fallback_by_reason
  },
  "validation": {
    "fallback_taxonomy_valid": $fallback_taxonomy_valid
  },
  "warnings": $warnings,
  "assertions": $assertions,
  "summary": {
    "total_checks": $((pass_count + fail_count + na_count)),
    "passed": $pass_count,
    "failed": $fail_count,
    "na": $na_count,
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
    log_info "Total checks: $((pass_count + fail_count + na_count))"
    log_info "Passed: ${GREEN}$pass_count${NC}"
    log_info "Failed: ${RED}$fail_count${NC}"
    log_info "N/A: ${YELLOW}$na_count${NC}"
    log_info "Overall status: $([ "$overall_status" = "pass" ] && echo -e "${GREEN}PASS${NC}" || echo -e "${RED}FAIL${NC}")"

    # Exit code based on overall status
    [ "$overall_status" = "pass" ] && exit 0 || exit 1
}

# Run main
main "$@"
