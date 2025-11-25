#!/bin/bash
#
# Phase 5 Report Generator
#
# Generates a human-readable markdown report from phase5-full-validate.sh JSON output
#
# Usage:
#   ./phase5-generate-report.sh <validation-json-path> [output-md-path]
#
# Example:
#   ./phase5-generate-report.sh /tmp/validation.json
#   ./phase5-generate-report.sh /tmp/validation.json /tmp/report.md
#

set -euo pipefail

# Colors
readonly GREEN='\033[0;32m'
readonly RED='\033[0;31m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m'

# Usage
usage() {
    echo "Usage: $0 <validation-json-path> [output-md-path]"
    exit 1
}

# Main
main() {
    if [ $# -lt 1 ]; then
        usage
    fi

    local json_path="$1"
    local output_path="${2:-}"

    if [ ! -f "$json_path" ]; then
        echo -e "${RED}[ERROR]${NC} Validation JSON not found: $json_path" >&2
        exit 1
    fi

    # Load JSON
    local json=$(cat "$json_path")

    # Extract fields
    local timestamp=$(echo "$json" | jq -r '.timestamp')
    local metrics_url=$(echo "$json" | jq -r '.metrics_url')
    local overall_status=$(echo "$json" | jq -r '.summary.overall_status')
    local passed=$(echo "$json" | jq -r '.summary.passed')
    local failed=$(echo "$json" | jq -r '.summary.failed')
    local na=$(echo "$json" | jq -r '.summary.na')
    local total=$(echo "$json" | jq -r '.summary.total_checks')

    # Status icon
    local status_icon=$([ "$overall_status" = "pass" ] && echo "✅" || echo "❌")
    local status_text=$([ "$overall_status" = "pass" ] && echo "PASS" || echo "FAIL")

    # Generate markdown report
    local report=$(cat <<EOF
# Phase 5 SLO Validation Report

**Status**: $status_icon **$status_text**
**Timestamp**: $timestamp
**Metrics Source**: \`$metrics_url\`

---

## Summary

| Metric | Value |
|--------|-------|
| Total Checks | $total |
| Passed | ✅ $passed |
| Failed | ❌ $failed |
| N/A | ⚪ $na |
| Overall Status | $status_icon $status_text |

---

## SLO Assertions

| Metric | Actual | Threshold | Comparison | Status |
|--------|--------|-----------|------------|--------|
EOF
)

    # Add assertion rows
    local assertions=$(echo "$json" | jq -r '.assertions')
    local assertion_count=$(echo "$assertions" | jq 'length')

    for ((i=0; i<assertion_count; i++)); do
        local metric=$(echo "$assertions" | jq -r ".[$i].metric")
        local actual=$(echo "$assertions" | jq -r ".[$i].actual")
        local threshold=$(echo "$assertions" | jq -r ".[$i].threshold")
        local unit=$(echo "$assertions" | jq -r ".[$i].unit")
        local comparison=$(echo "$assertions" | jq -r ".[$i].comparison")
        local status=$(echo "$assertions" | jq -r ".[$i].status")

        local status_icon=$([ "$status" = "pass" ] && echo "✅" || echo "❌")

        # Format actual and threshold based on unit
        local actual_str="$actual"
        local threshold_str="$threshold"

        case "$unit" in
            "seconds")
                actual_str="${actual}s"
                threshold_str="${threshold}s"
                ;;
            "percent")
                actual_str="${actual}%"
                threshold_str="${threshold}%"
                ;;
            "megabytes")
                actual_str="${actual}MB"
                threshold_str="${threshold}MB"
                ;;
            "ratio")
                actual_str="$actual"
                threshold_str="$threshold"
                ;;
        esac

        report+="
| $metric | $actual_str | $threshold_str | $comparison | $status_icon $status |"
    done

    # Add detailed metrics section
    report+="

---

## Detailed Metrics

### Percentile Latencies

"

    # Plugin reload latencies (using labeled histogram key)
    local plugin_key='metasheet_plugin_reload_duration_seconds{plugin_name="example-plugin"}'
    local plugin_p50=$(echo "$json" | jq -r --arg key "$plugin_key" '.percentiles[$key].p50 // 0')
    local plugin_p95=$(echo "$json" | jq -r --arg key "$plugin_key" '.percentiles[$key].p95 // 0')
    local plugin_p99=$(echo "$json" | jq -r --arg key "$plugin_key" '.percentiles[$key].p99 // 0')
    local plugin_count=$(echo "$json" | jq -r --arg key "$plugin_key" '.percentiles[$key].count // 0')

    report+="**Plugin Reload Duration** (example-plugin):
- P50: ${plugin_p50}s
- P95: ${plugin_p95}s
- P99: ${plugin_p99}s
- Sample Count: $plugin_count

"

    # Snapshot restore latencies (using labeled histogram key)
    local snapshot_restore_key='metasheet_snapshot_operation_duration_seconds{operation="restore"}'
    local snapshot_restore_p50=$(echo "$json" | jq -r --arg key "$snapshot_restore_key" '.percentiles[$key].p50 // 0')
    local snapshot_restore_p95=$(echo "$json" | jq -r --arg key "$snapshot_restore_key" '.percentiles[$key].p95 // 0')
    local snapshot_restore_p99=$(echo "$json" | jq -r --arg key "$snapshot_restore_key" '.percentiles[$key].p99 // 0')
    local snapshot_restore_count=$(echo "$json" | jq -r --arg key "$snapshot_restore_key" '.percentiles[$key].count // 0')

    report+="**Snapshot Restore Duration**:
- P50: ${snapshot_restore_p50}s
- P95: ${snapshot_restore_p95}s
- P99: ${snapshot_restore_p99}s
- Sample Count: $snapshot_restore_count

"

    # Snapshot create latencies (using labeled histogram key)
    local snapshot_create_key='metasheet_snapshot_operation_duration_seconds{operation="create"}'
    local snapshot_create_p50=$(echo "$json" | jq -r --arg key "$snapshot_create_key" '.percentiles[$key].p50 // 0')
    local snapshot_create_p95=$(echo "$json" | jq -r --arg key "$snapshot_create_key" '.percentiles[$key].p95 // 0')
    local snapshot_create_p99=$(echo "$json" | jq -r --arg key "$snapshot_create_key" '.percentiles[$key].p99 // 0')
    local snapshot_create_count=$(echo "$json" | jq -r --arg key "$snapshot_create_key" '.percentiles[$key].count // 0')

    report+="**Snapshot Create Duration**:
- P50: ${snapshot_create_p50}s
- P95: ${snapshot_create_p95}s
- P99: ${snapshot_create_p99}s
- Sample Count: $snapshot_create_count

"

    # Counter metrics
    report+="### Counter Metrics

"

    local cache_hit_rate=$(echo "$json" | jq -r '.counters.cache_hit_rate')
    local http_success_rate=$(echo "$json" | jq -r '.counters.http_success_rate')
    local error_rate=$(echo "$json" | jq -r '.counters.error_rate')
    local raw_fallback=$(echo "$json" | jq -r '.counters.raw_fallback')
    local effective_fallback=$(echo "$json" | jq -r '.counters.effective_fallback')
    local fallback_effective_ratio=$(echo "$json" | jq -r '.counters.fallback_effective_ratio')
    local memory_rss=$(echo "$json" | jq -r '.counters.memory_rss_mb')

    report+="- **Cache Hit Rate**: ${cache_hit_rate}%
- **HTTP Success Rate**: ${http_success_rate}%
- **Error Rate**: ${error_rate}%
- **Raw Fallback Count**: $raw_fallback
- **Effective Fallback Count**: $effective_fallback
- **Fallback Effective Ratio**: $fallback_effective_ratio
- **Memory RSS**: ${memory_rss}MB

"

    # Fallback breakdown
    report+="### Fallback Metrics

**Summary**:
- Raw Total: $raw_fallback
- Effective Total: $effective_fallback
- Ratio (effective/raw): $fallback_effective_ratio

**Breakdown by Reason** (raw counts):

"

    local fallback_by_reason=$(echo "$json" | jq -r '.counters.fallback_by_reason')
    local reasons=$(echo "$fallback_by_reason" | jq -r 'keys[]')

    report+="| Reason | Count | Counts as Effective |
|--------|-------|---------------------|
"

    for reason in $reasons; do
        local count=$(echo "$fallback_by_reason" | jq -r ".$reason")
        # cache_miss does not count as effective when COUNT_CACHE_MISS_AS_FALLBACK=false
        local effective_flag="Yes"
        if [ "$reason" = "cache_miss" ]; then
            effective_flag="No (excluded)"
        fi
        report+="| $reason | $count | $effective_flag |
"
    done

    # Validation status
    report+="
---

## Validation Status

"

    local taxonomy_valid=$(echo "$json" | jq -r '.validation.fallback_taxonomy_valid')
    local taxonomy_icon=$([ "$taxonomy_valid" = "true" ] && echo "✅" || echo "⚠️")

    report+="- **Fallback Taxonomy**: $taxonomy_icon $([ "$taxonomy_valid" = "true" ] && echo "Valid" || echo "Invalid reasons found")

"

    # Warnings section
    local warnings=$(echo "$json" | jq -r '.warnings')
    local warnings_count=$(echo "$warnings" | jq 'length')

    if [ "$warnings_count" -gt 0 ]; then
        report+="
### Warnings

| Metric | Issue | Message |
|--------|-------|---------|
"
        for ((i=0; i<warnings_count; i++)); do
            local warn_metric=$(echo "$warnings" | jq -r ".[$i].metric")
            local warn_issue=$(echo "$warnings" | jq -r ".[$i].issue")
            local warn_message=$(echo "$warnings" | jq -r ".[$i].message")
            report+="| $warn_metric | $warn_issue | $warn_message |
"
        done
        report+="
"
    fi

    # Configuration
    report+="---

## Configuration

- **COUNT_CACHE_MISS_AS_FALLBACK**: $(echo "$json" | jq -r '.configuration.count_cache_miss_as_fallback')
- **Thresholds File**: \`$(echo "$json" | jq -r '.configuration.thresholds_file')\`

---

**Generated at**: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
"

    # Output
    if [ -n "$output_path" ]; then
        echo "$report" > "$output_path"
        echo -e "${GREEN}[SUCCESS]${NC} Report written to $output_path" >&2
    else
        echo "$report"
    fi
}

main "$@"
