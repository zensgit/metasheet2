# Phase 5 Script Enhancement Guide

**Purpose**: Detailed guide for implementing Phase 5 metric improvements on existing scripts
**Target Scripts**: `phase5-observe.sh`, `phase5-fill-production-report.sh`
**Status**: Implementation Guide (Not Yet Applied)
**Date**: 2025-11-24

---

## Overview

The current Phase 5 scripts (`phase5-observe.sh` and `phase5-fill-production-report.sh`) are **comprehensive implementations from Phase 8-9**. They already include:
- ✅ Plugin reload metrics
- ✅ Snapshot operation metrics
- ✅ Fallback tracking with effective vs raw distinction
- ✅ HTTP/Message/Cache adapter breakdown
- ✅ Success rate calculations

**This guide documents recommended enhancements** to align with the new SLO targets and metrics defined in:
- `.env.phase5.template` (enhanced version)
- `docs/phase5/METRICS_GUIDE.md`

---

## Current State Analysis

### phase5-observe.sh (231 lines)

**Existing Features**:
- Prometheus connectivity testing
- Phase 8-9 metrics validation
- 10-minute interval sampling (configurable)
- CSV output with 31+ columns
- Real-time SLO judgment (P99, fallback ratio)
- Non-interactive mode support

**CSV Schema (Current)**:
```csv
timestamp,http_success_rate,p50_latency,p90_latency,p95_latency,p99_latency,fallback_ratio,error_rate,error_rate_4xx,error_rate_5xx,cpu_percent,rss_mb,request_rate,fallback_total,effective_fallback_total,fallback_http,fallback_message,fallback_cache,http_adapter_ops,message_bus_rpc_attempts,cache_get_attempts,fb_http_ratio,fb_message_ratio,fb_cache_ratio,plugin_reload_success,plugin_reload_failure,snapshot_create_success,snapshot_create_failure,snapshot_restore_success,snapshot_restore_failure,effective_fallback_ratio,sample_num
```

**Observations**:
- ✅ Already has P95 latency column
- ✅ Already has RSS MB memory column
- ✅ Already has plugin reload success/failure
- ✅ Already has snapshot operation success/failure
- ❌ Missing: explicit cache_hit_rate_pct column
- ❌ Missing: P95 SLO judgment output
- ❌ Missing: Memory SLO judgment output

### phase5-fill-production-report.sh (200+ lines)

**Existing Features**:
- AWK-based CSV parsing
- SLO target overrides via environment variables
- Statistical analysis (min/max/avg/stddev)
- Go/No-Go verdict calculation
- Adapter-specific fallback breakdown
- Success rate verdicts

**Current SLO Targets** (hardcoded defaults):
```bash
SLO_SUCCESS=98        # HTTP success rate (%)
SLO_P99=2             # P99 latency (seconds)
SLO_FALLBACK=9.23     # Raw fallback ratio (%)
SLO_EFF_FALLBACK=5    # Effective fallback ratio (%)
SLO_ERROR=1           # Error rate (%)
SLO_CPU=30            # CPU usage (%)
SLO_MEM=30            # Memory RSS (MB)
```

**Observations**:
- ✅ Already uses SLO_MEM for memory judgment
- ❌ No SLO_P95 target defined
- ❌ No explicit cache hit rate SLO
- ❌ No plugin/snapshot success rate SLOs

---

## Recommended Enhancements

### Enhancement 1: Add P95 SLO Judgment to phase5-observe.sh

**Location**: After P99 judgment logic (around line 180-190)

**Code to Add**:
```bash
# P95 Latency SLO Judgment (add after P99 check)
P95_TARGET=${P95_LATENCY_TARGET:-150}  # ms
P95_MS=$(echo "$P95 * 1000" | bc)  # Convert seconds to ms

echo -n "  📊 P95延迟 (Latency): ${P95}s (${P95_MS}ms) - "
if (( $(echo "$P95_MS > $P95_TARGET" | bc -l) )); then
    echo -e "${RED}❌ 超过目标 (> ${P95_TARGET}ms)${NC}"
else
    echo -e "${GREEN}✅ 符合目标 (≤ ${P95_TARGET}ms)${NC}"
fi
```

**Expected Output**:
```
  📊 P95延迟 (Latency): 0.043s (43ms) - ✅ 符合目标 (≤ 150ms)
```

### Enhancement 2: Add Memory SLO Judgment to phase5-observe.sh

**Location**: After RSS memory extraction (around line 170-175)

**Code to Add**:
```bash
# Memory SLO Judgment (add after RSS extraction)
MEMORY_TARGET=${MEMORY_SLO_TARGET:-500}  # MB

echo -n "  💾 内存使用 (Memory): ${RSS_MB}MB - "
if (( $(echo "$RSS_MB > $MEMORY_TARGET" | bc -l) )); then
    echo -e "${YELLOW}⚠️  超过目标 (> ${MEMORY_TARGET}MB)${NC}"
else
    echo -e "${GREEN}✅ 符合目标 (≤ ${MEMORY_TARGET}MB)${NC}"
fi
```

**Expected Output**:
```
  💾 内存使用 (Memory): 385MB - ✅ 符合目标 (≤ 500MB)
```

### Enhancement 3: Add Cache Hit Rate Column to CSV

**Current Calculation** (already exists in observe script):
```bash
# Cache operations are already tracked:
# - cache_get_attempts (column 21)
# - cache hits/misses can be derived

# Cache hit rate calculation (add after cache metrics extraction)
CACHE_HITS=$(echo "$METRICS" | grep "cache_hits_total" | awk '{print $2}' | head -1 || echo "0")
CACHE_MISSES=$(echo "$METRICS" | grep "cache_misses_total" | awk '{print $2}' | head -1 || echo "0")
TOTAL_CACHE_OPS=$((CACHE_HITS + CACHE_MISSES))

if [ $TOTAL_CACHE_OPS -gt 0 ]; then
    CACHE_HIT_RATE=$(echo "scale=2; $CACHE_HITS * 100 / $TOTAL_CACHE_OPS" | bc)
else
    CACHE_HIT_RATE=0
fi
```

**CSV Schema Enhancement**:
```csv
# Add cache_hit_rate_pct as new column (position 32)
# Updated schema:
...,effective_fallback_ratio,sample_num,cache_hit_rate_pct
```

**Output Line Update**:
```bash
# Current CSV output (around line 220):
echo "$TIMESTAMP,$HTTP_SUCCESS_RATE,..." >> "$OUT_DIR/metrics.csv"

# Enhanced CSV output:
echo "$TIMESTAMP,$HTTP_SUCCESS_RATE,...,$EFFECTIVE_FB_RATIO,$SAMPLE_NUM,$CACHE_HIT_RATE" >> "$OUT_DIR/metrics.csv"
```

### Enhancement 4: Add Cache Hit Rate SLO to phase5-fill-production-report.sh

**Location**: SLO targets section (lines 16-23)

**Code to Add**:
```bash
# Add after SLO_MEM definition:
SLO_CACHE_HIT=${SLO_CACHE_HIT:-80}  # Minimum cache hit rate (%)
SLO_PLUGIN_SUCCESS=${SLO_PLUGIN_SUCCESS:-95}  # Plugin reload success rate (%)
SLO_SNAPSHOT_SUCCESS=${SLO_SNAPSHOT_SUCCESS:-99}  # Snapshot operation success rate (%)
```

**AWK Processing Update** (around line 25-28):
```awk
# Add cache_hit_rate_pct to field extraction:
# Old: ...,effective_fallback_ratio,sample_num
# New: ...,effective_fallback_ratio,sample_num,cache_hit_rate_pct

# Field extraction (add to line 28):
...; eff_fb_ratio=$31*100; cache_hit=$32;

# Statistics aggregation (add around line 41):
if (cache_hit<min_cache) min_cache=cache_hit;
if (cache_hit>max_cache) max_cache=cache_hit;
sum_cache+=cache_hit;

# Average calculation (add to line 49):
avg_cache=sum_cache/count;

# Verdict calculation (add to line 57):
verdict_cache=(avg_cache >= slo_cache_hit ? "Pass" : "Fail");

# Go/No-Go update (line 58):
go=(verdict_success=="Pass" && verdict_p99=="Pass" && verdict_fb=="Pass" && verdict_eff_fb=="Pass" && verdict_err=="Pass" && verdict_cpu=="Pass" && verdict_mem=="Pass" && verdict_cache=="Pass" ? "Go" : "No-Go");
```

### Enhancement 5: Add Plugin/Snapshot Success Rate Judgments

**Location**: Report summary table (around line 80-120)

**Code to Add to AWK**:
```awk
# Plugin reload success rate (already has data in sum_pr_ok, sum_pr_fail)
total_plugin_ops=sum_pr_ok+sum_pr_fail;
plugin_success_rate=(total_plugin_ops>0 ? (sum_pr_ok/total_plugin_ops*100) : 0);
verdict_plugin=(plugin_success_rate >= slo_plugin_success ? "Pass" : "Fail");

# Snapshot operation success rate
total_snapshot_ops=sum_sc_ok+sum_sc_fail+sum_sr_ok+sum_sr_fail;
snapshot_success_rate=(total_snapshot_ops>0 ? ((sum_sc_ok+sum_sr_ok)/total_snapshot_ops*100) : 0);
verdict_snapshot=(snapshot_success_rate >= slo_snapshot_success ? "Pass" : "Fail");

# Add to summary table output:
print "| Cache Hit Rate | " sprintf("%.2f%%", avg_cache) " | " slo_cache_hit "% | " verdict_cache " |";
print "| Plugin Reload Success | " sprintf("%.2f%%", plugin_success_rate) " | " slo_plugin_success "% | " verdict_plugin " |";
print "| Snapshot Op Success | " sprintf("%.2f%%", snapshot_success_rate) " | " slo_snapshot_success "% | " verdict_snapshot " |";
```

**Expected Output Enhancement**:
```markdown
| Metric | Average | SLO Target | Verdict |
|--------|---------|------------|---------|
| HTTP Success Rate | 99.85% | 98% | Pass |
| P99 Latency | 0.78s | 2s | Pass |
| Cache Hit Rate | 87.50% | 80% | Pass |  ← NEW
| Plugin Reload Success | 98.20% | 95% | Pass |  ← NEW
| Snapshot Op Success | 99.70% | 99% | Pass |  ← NEW
| Error Rate | 0.15% | 1% | Pass |
| Memory RSS | 385MB | 500MB | Pass |
```

### Enhancement 6: Add P95 Latency to Report

**Location**: Summary table (around line 85-95)

**Code to Add**:
```awk
# Add SLO target (line 25):
-v slo_p95="$SLO_P95"

# (SLO_P95 should be defined in bash section, line 18):
SLO_P95=${SLO_P95:-150}  # ms

# Add verdict calculation (around line 51):
verdict_p95=(avg_p95*1000 <= slo_p95 ? "Pass" : "Fail");

# Add to summary table:
print "| P95 Latency | " sprintf("%.0fms", avg_p95*1000) " | " slo_p95 "ms | " verdict_p95 " |";
```

---

## Implementation Priority

### Priority 1 (Critical for SLO Judgment)
1. ✅ Environment template enhancements (DONE)
2. ✅ Pre-flight validation script (DONE)
3. ⏳ P95 SLO judgment in observe.sh
4. ⏳ Memory SLO judgment in observe.sh
5. ⏳ Cache hit rate SLO in report.sh

### Priority 2 (Enhanced Reporting)
6. ⏳ Cache hit rate column in CSV
7. ⏳ Plugin/Snapshot success rate judgments
8. ⏳ P95 latency in summary report

### Priority 3 (Documentation)
9. ✅ Comprehensive metrics guide (DONE)
10. ⏳ Update preparation checklist with new criteria

---

## Testing Strategy

### Unit Testing (Local Environment)

**1. Test Pre-flight Validation**:
```bash
# Should fail (no credentials)
bash scripts/phase5-verify-preconditions.sh
# Expected: Exit 1, errors for METRICS_URL and PROD_JWT

# With minimal environment
export METRICS_URL="http://localhost:4000/metrics/prom"
export PROD_JWT="test-token"
bash scripts/phase5-verify-preconditions.sh
# Expected: Exit 0 with warnings (connectivity will fail)
```

**2. Test Enhanced observe.sh** (after modifications):
```bash
# Mock environment
export METRICS_URL="http://localhost:4000/metrics/prom"
export P95_LATENCY_TARGET=150
export MEMORY_SLO_TARGET=500
export INTERVAL_SECONDS=10
export MAX_SAMPLES=2

# Run observe script
bash scripts/phase5-observe.sh
# Expected: 2 samples collected with P95/Memory SLO judgments
```

**3. Test Enhanced report.sh** (after modifications):
```bash
# Generate sample CSV (use test data)
echo "timestamp,http_success_rate,...,cache_hit_rate_pct" > test-metrics.csv
echo "2025-11-24T14:00:00Z,0.9985,...,87.5" >> test-metrics.csv

# Generate report
export SLO_CACHE_HIT=80
export SLO_PLUGIN_SUCCESS=95
bash scripts/phase5-fill-production-report.sh test-metrics.csv
# Expected: Report with cache hit rate, plugin/snapshot success rates
```

### Integration Testing (Staging Environment)

**1. End-to-End Baseline Collection**:
```bash
# Pre-flight check
bash scripts/phase5-verify-preconditions.sh

# Run 20-minute baseline (2 samples)
export MAX_SAMPLES=2
export INTERVAL_SECONDS=600
bash scripts/phase5-run-production-baseline.sh \
  --base-url "$STAGING_URL" \
  --jwt "$STAGING_JWT" \
  --rate 20 --concurrency 5

# Generate report
RESULT_DIR=$(ls -td results/phase5-prod-* | head -1)
bash scripts/phase5-fill-production-report.sh ${RESULT_DIR}/metrics.csv \
  > ${RESULT_DIR}/production-report.md

# Verify enhancements
grep -E "(Cache Hit Rate|Plugin Reload|Snapshot Op|P95 Latency)" \
  ${RESULT_DIR}/production-report.md
```

---

## Rollback Strategy

### If Enhancements Break Existing Functionality

**1. Git Restore**:
```bash
# Restore original scripts
git checkout HEAD -- scripts/phase5-observe.sh
git checkout HEAD -- scripts/phase5-fill-production-report.sh
```

**2. Use Original Workflow**:
```bash
# Original scripts still work with current CSV schema
# Enhancements are additive, not breaking changes
```

**3. Partial Enhancement**:
- Keep environment template changes (non-breaking)
- Keep pre-flight validation script (independent)
- Keep metrics guide documentation (informational)
- Defer script modifications until after production baseline

---

## Migration Path

### Phase A: Documentation & Tools (COMPLETED)
- ✅ Enhanced environment template
- ✅ Pre-flight validation script
- ✅ Comprehensive metrics guide
- ✅ This enhancement guide

### Phase B: Script Enhancements (RECOMMENDED BEFORE PRODUCTION BASELINE)
- ⏳ Implement Phase 1 enhancements (P95/Memory SLO judgments)
- ⏳ Test with local/staging environment
- ⏳ Validate CSV schema changes
- ⏳ Update preparation checklist

### Phase C: Production Execution (WHEN CREDENTIALS AVAILABLE)
- Execute enhanced baseline collection
- Generate enhanced reports
- Validate all SLO judgments
- Archive results

### Phase D: Post-Production Review (AFTER BASELINE)
- Review enhancement effectiveness
- Identify additional improvements
- Update SLO targets based on data
- Document lessons learned

---

## Alternative: Non-Invasive Enhancement

**If modifying existing scripts is too risky**, consider **wrapper scripts**:

**phase5-observe-enhanced.sh** (wrapper):
```bash
#!/bin/bash
# Enhanced wrapper for phase5-observe.sh
# Adds P95/Memory SLO judgments without modifying original

# Run original observe script
bash scripts/phase5-observe.sh "$@"

# Post-process metrics.csv to add cache_hit_rate column
RESULT_DIR=$(ls -td results/phase5-prod-* | head -1)
python3 scripts/enhance-metrics-csv.py ${RESULT_DIR}/metrics.csv
```

**phase5-report-enhanced.sh** (wrapper):
```bash
#!/bin/bash
# Enhanced wrapper for phase5-fill-production-report.sh
# Adds cache/plugin/snapshot SLO judgments

# Generate original report
bash scripts/phase5-fill-production-report.sh "$@" > /tmp/original-report.md

# Append enhanced sections
python3 scripts/append-enhanced-metrics.py \
  /tmp/original-report.md \
  "$1"  # metrics.csv path
```

**Advantages**:
- ✅ Zero risk to existing functionality
- ✅ Original scripts remain untouched
- ✅ Easy to disable enhancements
- ✅ Gradual rollout possible

**Disadvantages**:
- ❌ Requires Python for CSV processing
- ❌ More complex execution workflow
- ❌ May duplicate some logic

---

## Decision Recommendation

**For Production Baseline (High Stakes)**:
→ Use **Alternative: Non-Invasive Enhancement** approach
- Keep original scripts intact
- Add enhancements via wrappers
- Lower risk, faster to implement

**For Future Baselines (After Validation)**:
→ Integrate enhancements directly into scripts
- Clean up duplicate logic
- Simplify workflow
- Better long-term maintainability

---

**Next Steps**: Review this guide and decide:
1. Proceed with direct script modifications (higher reward, higher risk)
2. Implement wrapper approach (lower risk, faster deployment)
3. Defer enhancements until after first production baseline (safest)

**Document Status**: ✅ Complete - Ready for implementation decision
**Last Updated**: 2025-11-24 15:45 CST
