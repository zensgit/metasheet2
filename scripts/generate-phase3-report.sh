#!/bin/bash
# Generate Phase 3: 24-Hour Observation Report
# 从采集数据生成Phase 3完整报告

set -e

ARTIFACTS_DIR="artifacts"
CSV_FILE="$ARTIFACTS_DIR/observability-24h.csv"
SUMMARY_FILE="$ARTIFACTS_DIR/observability-24h-summary.json"
REPORT_DIR="claudedocs"
REPORT_FILE="$REPORT_DIR/PHASE3_24H_OBSERVATION_REPORT_$(date +%Y%m%d_%H%M%S).md"

echo "📊 Generating Phase 3 24-Hour Observation Report..."
echo "📂 Source CSV: $CSV_FILE"
echo "📂 Source summary: $SUMMARY_FILE"
echo "📄 Output report: $REPORT_FILE"
echo ""

# Check if data files exist
if [ ! -f "$CSV_FILE" ]; then
  echo "❌ ERROR: CSV file not found: $CSV_FILE"
  echo "   Please run: bash scripts/observe-24h.sh first"
  exit 1
fi

if [ ! -f "$SUMMARY_FILE" ]; then
  echo "❌ ERROR: Summary file not found: $SUMMARY_FILE"
  exit 1
fi

# Extract metadata from summary
OBSERVATION_START=$(jq -r '.observation_start' "$SUMMARY_FILE")
OBSERVATION_END=$(jq -r '.observation_end // "ongoing"' "$SUMMARY_FILE")
SAMPLES_COLLECTED=$(jq -r '.samples_collected' "$SUMMARY_FILE")
INTERVAL_SECONDS=$(jq -r '.interval_seconds' "$SUMMARY_FILE")

echo "🕐 Observation period: $OBSERVATION_START → $OBSERVATION_END"
echo "📈 Samples collected: $SAMPLES_COLLECTED"
echo ""

# Analyze CSV data with awk
echo "🔍 Analyzing collected data..."

STATS=$(awk -F',' 'NR > 1 {
  success += $4
  conflict += $5
  fallback += $6
  if ($7 != "" && $7 != "0") {
    p99_sum += $7
    p99_count++
    if (p99_max == "" || $7 > p99_max) p99_max = $7
    if (p99_min == "" || $7 < p99_min) p99_min = $7
  }
  if ($9 != "" && $9 != "0") {
    rate_sum += $9
    rate_count++
    if ($9 < rate_min || rate_min == "") rate_min = $9
  }
  if ($10 != "" && $10 != "0") {
    fallback_ratio_sum += $10
    fallback_ratio_count++
    if ($10 > fallback_ratio_max || fallback_ratio_max == "") fallback_ratio_max = $10
  }
  if ($11 == "WARN") warn_count++
  if ($11 == "CRIT") crit_count++
  if ($12 != "" && $12 != "\"\"") alert_count++
}
END {
  print "total_success=" success
  print "total_conflict=" conflict
  print "total_fallback=" fallback
  print "avg_p99=" (p99_count > 0 ? p99_sum/p99_count : 0)
  print "max_p99=" (p99_max != "" ? p99_max : 0)
  print "min_p99=" (p99_min != "" ? p99_min : 0)
  print "avg_rate=" (rate_count > 0 ? rate_sum/rate_count : 0)
  print "min_rate=" (rate_min != "" ? rate_min : 1)
  print "avg_fallback_ratio=" (fallback_ratio_count > 0 ? fallback_ratio_sum/fallback_ratio_count : 0)
  print "max_fallback_ratio=" (fallback_ratio_max != "" ? fallback_ratio_max : 0)
  print "warn_count=" warn_count
  print "crit_count=" crit_count
  print "alert_count=" alert_count
}' "$CSV_FILE")

# Parse stats into variables
eval "$STATS"

echo "✅ Analysis complete"
echo "   Total success: $total_success"
echo "   Total conflict: $total_conflict"
echo "   Average P99: $avg_p99"
echo "   Warnings: $warn_count, Critical: $crit_count"
echo ""

# Extract anomalous events
echo "🔍 Extracting anomalous events..."
ANOMALIES=$(awk -F',' 'NR > 1 && ($11 == "WARN" || $11 == "CRIT" || $12 != "" && $12 != "\"\"") {
  print "| " $1 " | Sample " $2 " | " $11 " | " $12 " | Success: " $4 ", Conflicts: " $5 ", P99: " $7 " |"
}' "$CSV_FILE")

if [ -z "$ANOMALIES" ]; then
  ANOMALIES="| - | - | - | - | No anomalies detected |"
  ANOMALIES_COUNT=0
else
  ANOMALIES_COUNT=$(echo "$ANOMALIES" | wc -l)
fi

echo "   Anomalies found: $ANOMALIES_COUNT"
echo ""

# Determine overall assessment
OVERALL_STATUS="✅ PASS"
PROCEED_PHASE4="true"
ROLLBACK_REQUIRED="false"

if [ "$crit_count" -gt 0 ]; then
  OVERALL_STATUS="🔴 CRITICAL ISSUES DETECTED"
  PROCEED_PHASE4="false"
  ROLLBACK_REQUIRED="true"
elif [ "$warn_count" -gt 5 ]; then
  OVERALL_STATUS="⚠️ MULTIPLE WARNINGS"
  PROCEED_PHASE4="review_required"
fi

# Calculate overall success rate
if [ "$total_success" -gt 0 ] || [ "$total_conflict" -gt 0 ]; then
  TOTAL_ATTEMPTS=$((total_success + total_conflict))
  OVERALL_SUCCESS_RATE=$(echo "scale=4; $total_success / $TOTAL_ATTEMPTS" | bc)
else
  OVERALL_SUCCESS_RATE="N/A"
fi

# Generate report
cat > "$REPORT_FILE" << EOF
# Phase 3: 24-Hour Observation Report

**Generated**: $(date)
**Observation Period**: $OBSERVATION_START → $OBSERVATION_END
**Duration**: $(echo "$INTERVAL_SECONDS * $SAMPLES_COLLECTED / 3600" | bc) hours (approx)
**Sampling Interval**: $(echo "$INTERVAL_SECONDS / 60" | bc) minutes
**Samples Collected**: $SAMPLES_COLLECTED

---

## Executive Summary

**Overall Status**: $OVERALL_STATUS

**Key Metrics Summary**:
- **Total Approval Attempts**: $TOTAL_ATTEMPTS ($total_success successes, $total_conflict conflicts)
- **Overall Success Rate**: $OVERALL_SUCCESS_RATE (target: ≥0.98)
- **Total Fallback Invocations**: $total_fallback
- **Average P99 Latency**: ${avg_p99}s (target: <0.30s)
- **Warnings Triggered**: $warn_count
- **Critical Alerts**: $crit_count

**Recommendation**: $(
  if [ "$PROCEED_PHASE4" = "true" ]; then
    echo "✅ Proceed to Phase 4 (documentation and cleanup)"
  elif [ "$PROCEED_PHASE4" = "review_required" ]; then
    echo "⚠️ Review warnings before proceeding to Phase 4"
  else
    echo "🔴 DO NOT proceed - consider rollback (see OBSERVABILITY_ROLLBACK_SOP.md)"
  fi
)

---

## Detailed Metrics

### 1. Approval Success Rate

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| **Average Success Rate** | $avg_rate | ≥ 0.98 | $([ $(echo "$avg_rate >= 0.98" | bc -l) -eq 1 ] 2>/dev/null && echo "✅ PASS" || echo "⚠️ BELOW TARGET") |
| **Minimum Success Rate** | $min_rate | ≥ 0.98 | $([ $(echo "$min_rate >= 0.98" | bc -l) -eq 1 ] 2>/dev/null && echo "✅ PASS" || echo "⚠️ BELOW TARGET") |
| **Total Successes** | $total_success | - | - |
| **Total Conflicts** | $total_conflict | 0 | $([ "$total_conflict" -eq 0 ] && echo "✅ ZERO" || echo "⚠️ NON-ZERO") |

### 2. Performance Metrics

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| **Average P99 Latency** | ${avg_p99}s | < 0.30s | $([ $(echo "$avg_p99 < 0.30" | bc -l) -eq 1 ] 2>/dev/null && echo "✅ PASS" || echo "⚠️ ABOVE TARGET") |
| **Maximum P99 Latency** | ${max_p99}s | < 0.40s | $([ $(echo "$max_p99 < 0.40" | bc -l) -eq 1 ] 2>/dev/null && echo "✅ PASS" || echo "⚠️ ABOVE TARGET") |
| **Minimum P99 Latency** | ${min_p99}s | - | - |

### 3. Fallback Usage

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| **Total Fallback Invocations** | $total_fallback | - | - |
| **Average Fallback Ratio** | $avg_fallback_ratio | < 0.10 | $([ $(echo "$avg_fallback_ratio < 0.10" | bc -l) -eq 1 ] 2>/dev/null && echo "✅ PASS" || echo "⚠️ ABOVE TARGET") |
| **Maximum Fallback Ratio** | $max_fallback_ratio | < 0.25 | $([ $(echo "$max_fallback_ratio < 0.25" | bc -l) -eq 1 ] 2>/dev/null && echo "✅ PASS" || echo "🔴 CRITICAL") |

---

## Anomalous Events

**Total Anomalies**: $ANOMALIES_COUNT

| Timestamp | Sample | Severity | Alert Flags | Metrics |
|-----------|--------|----------|-------------|---------|
$ANOMALIES

$([ "$ANOMALIES_COUNT" -eq 0 ] && echo "**Analysis**: No anomalies detected during the observation period. System performance is stable and within all thresholds." || echo "**Analysis**: Anomalies were detected during observation. Review individual events above for details.")

---

## Alert Summary

**Alert Breakdown**:
- **WARNING Status**: $warn_count samples
- **CRITICAL Status**: $crit_count samples
- **Total Alerts Triggered**: $alert_count samples

$(jq -r '.alerts | if length > 0 then "**Alert History**:\n" + (map("- " + .) | join("\n")) else "No alerts triggered during observation." end' "$SUMMARY_FILE")

---

## Threshold Compliance

| Threshold | Target | Actual | Compliance |
|-----------|--------|--------|------------|
| Success Rate | ≥ 98% | $(echo "scale=2; $avg_rate * 100" | bc)% | $([ $(echo "$avg_rate >= 0.98" | bc -l) -eq 1 ] 2>/dev/null && echo "✅ COMPLIANT" || echo "❌ NON-COMPLIANT") |
| Conflicts | 0 | $total_conflict | $([ "$total_conflict" -eq 0 ] && echo "✅ COMPLIANT" || echo "❌ NON-COMPLIANT") |
| Fallback Ratio | < 10% | $(echo "scale=2; $avg_fallback_ratio * 100" | bc)% | $([ $(echo "$avg_fallback_ratio < 0.10" | bc -l) -eq 1 ] 2>/dev/null && echo "✅ COMPLIANT" || echo "❌ NON-COMPLIANT") |
| P99 Latency | < 0.30s | ${avg_p99}s | $([ $(echo "$avg_p99 < 0.30" | bc -l) -eq 1 ] 2>/dev/null && echo "✅ COMPLIANT" || echo "❌ NON-COMPLIANT") |

---

## Recommendations

EOF

# Add specific recommendations
if [ "$crit_count" -gt 0 ]; then
  cat >> "$REPORT_FILE" << 'EOF'
### 🔴 CRITICAL: Immediate Action Required

1. **DO NOT proceed to Phase 4**
2. **Review critical alerts** in the anomalous events section above
3. **Consider rollback**: See `claudedocs/OBSERVABILITY_ROLLBACK_SOP.md`
4. **Investigate root causes**:
   - Check server logs for errors during critical events
   - Review conflict resolution logic
   - Analyze fallback trigger conditions
5. **Re-run observation** after fixes are applied

EOF
elif [ "$warn_count" -gt 5 ]; then
  cat >> "$REPORT_FILE" << 'EOF'
### ⚠️ Multiple Warnings Detected

1. **Review warning events** before proceeding to Phase 4
2. **Analyze patterns**:
   - Are warnings clustered in time?
   - Are specific metrics consistently problematic?
   - Is there correlation with external factors?
3. **Consider extending observation**:
   - Run additional 12-24 hour observation cycle
   - Monitor during peak traffic periods
4. **Document findings** for future reference
5. **Proceed with caution** if patterns are understood and acceptable

EOF
else
  cat >> "$REPORT_FILE" << 'EOF'
### ✅ System Healthy - Proceed to Phase 4

1. **All thresholds met** - system performance is stable
2. **Ready for Phase 4**: Documentation and cleanup
3. **Next steps**:
   - Archive observation data: `artifacts/observability-24h.csv`
   - Generate completion report
   - Update main documentation with observation results
   - Clean up temporary files
4. **Maintain monitoring**: Continue tracking metrics in production
5. **Schedule review**: 30-day post-deployment review

EOF
fi

# Add data files reference
cat >> "$REPORT_FILE" << EOF

---

## Data Files

- **Raw CSV Data**: \`$CSV_FILE\`
- **Summary JSON**: \`$SUMMARY_FILE\`
- **This Report**: \`$REPORT_FILE\`

---

## Appendix: Observation Configuration

- **Sampling Interval**: ${INTERVAL_SECONDS}s ($(echo "$INTERVAL_SECONDS / 60" | bc) minutes)
- **Target Samples**: 48 (24 hours of 30-minute intervals)
- **Actual Samples**: $SAMPLES_COLLECTED
- **Thresholds**:
  - Success Rate: WARN <0.98, CRIT <0.95
  - Conflicts: WARN ≥1, CRIT ≥2
  - Fallback Ratio: WARN >0.10, CRIT >0.25
  - P99 Latency: WARN >0.30s, CRIT >0.40s

**Next Steps**: See [OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md](./OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md)
EOF

echo "✅ Report generated: $REPORT_FILE"
echo ""
echo "📄 Report summary:"
echo "   - Overall status: $OVERALL_STATUS"
echo "   - Samples analyzed: $SAMPLES_COLLECTED"
echo "   - Warnings: $warn_count, Critical: $crit_count"
echo "   - Proceed to Phase 4: $PROCEED_PHASE4"
echo ""

if [ "$PROCEED_PHASE4" = "true" ]; then
  echo "✅ Ready to proceed to Phase 4!"
  echo "   Run: bash scripts/phase4-completion.sh"
elif [ "$PROCEED_PHASE4" = "review_required" ]; then
  echo "⚠️  Review report before proceeding"
else
  echo "🔴 DO NOT proceed - review critical issues"
  echo "   See: claudedocs/OBSERVABILITY_ROLLBACK_SOP.md"
fi
