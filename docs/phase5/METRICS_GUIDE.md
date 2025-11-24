# Phase 5 Metrics Guide

**Purpose**: Comprehensive guide to all metrics collected during Phase 5 production baseline
**Audience**: Engineers, DevOps, SRE
**Last Updated**: 2025-11-24

---

## Core Metrics Overview

Phase 5 collects **6 core metric categories** from production Prometheus endpoints:

| Category | Metrics | Purpose | SLO Target |
|----------|---------|---------|------------|
| **Latency** | P50, P95, P99 | API response time distribution | P95 < 150ms |
| **Memory** | RSS MB | Process memory consumption | < 500MB |
| **Cache** | Hit rate, Miss rate, Fallback % | Cache effectiveness | Hit rate > 80% |
| **Success Rate** | Plugin reload, Snapshot success | System reliability | > 95% |
| **Error Rate** | 4xx, 5xx, Total errors | System stability | < 1% |
| **Throughput** | Requests/sec | System capacity | Measured baseline |

---

## 1. Latency Metrics

### Data Source
**Prometheus Metric**: `http_request_duration_seconds` (histogram)

**Aggregation**: Collected every 10 minutes over 2-hour baseline

### P95 Latency

**Definition**: 95th percentile response time - 95% of requests complete faster than this value

**Calculation Method**:
```promql
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket[10m])) by (le)
)
```

**SLO Target**: < 150ms

**Judgment Logic**:
- ✅ **PASS**: P95 ≤ 150ms
- ⚠️  **WARNING**: 150ms < P95 ≤ 200ms
- ❌ **FAIL**: P95 > 200ms

**Interpretation**:
- **Good** (< 100ms): Excellent performance, well-optimized
- **Acceptable** (100-150ms): Meeting SLO, no action needed
- **At Risk** (150-200ms): Monitor closely, consider optimization
- **Critical** (> 200ms): Requires immediate investigation

### P99 Latency

**Definition**: 99th percentile response time - captures worst-case scenarios

**SLO Target**: < 250ms

**Use Case**: Detect tail latency issues affecting user experience

---

## 2. Memory Metrics

### Data Source
**Prometheus Metric**: `process_resident_memory_bytes`

**Unit**: Converted to MB for readability

### RSS Memory (Resident Set Size)

**Definition**: Physical memory (RAM) actually used by the process

**Calculation**:
```promql
process_resident_memory_bytes / (1024 * 1024)
```

**SLO Target**: < 500MB average

**Judgment Logic**:
- ✅ **PASS**: Avg ≤ 500MB AND Max ≤ 600MB
- ⚠️  **WARNING**: 500MB < Avg ≤ 700MB OR 600MB < Max ≤ 800MB
- ❌ **FAIL**: Avg > 700MB OR Max > 800MB

**Memory Growth Check**:
- Monitor for steady increase (memory leak indicator)
- Acceptable: < 10% growth over 2-hour baseline
- Investigate: > 20% growth

---

## 3. Cache Metrics

### Overview

Cache performance directly impacts fallback query frequency and system load.

### Cache Hit Rate

**Definition**: Percentage of requests served from cache without database query

**Calculation**:
```
Cache Hit Rate = (Cache Hits / Total Requests) × 100%
```

**Data Sources**:
- Cache hits: `cache_hits_total` counter
- Cache misses: `cache_misses_total` counter
- Total requests: Sum of hits + misses

**SLO Target**: > 80%

**Judgment Logic**:
- ✅ **EXCELLENT**: ≥ 90%
- ✅ **PASS**: 80% - 89%
- ⚠️  **WARNING**: 70% - 79%
- ❌ **FAIL**: < 70%

**Impact Assessment**:
- **90%+**: Optimal cache efficiency
- **80-89%**: Good performance, meets SLO
- **70-79%**: Review cache strategy, TTL settings
- **< 70%**: Critical - investigate cache misses, consider cache warming

### Raw vs Effective Fallback

**Important Distinction**:

**Raw Fallback Count** (`metasheet_snapshot_fallback_total`):
- Counts every fallback query execution
- Includes cache misses even when intentional
- Higher number, less useful for SLO judgment

**Effective Fallback Rate** (when `COUNT_CACHE_MISS_AS_FALLBACK=false`):
- Only counts "true" fallbacks (cache unavailable, stale data, etc.)
- Excludes normal cache misses
- More accurate indicator of cache health
- **Recommended for production baseline**

**Example**:
```
Scenario: 100 requests, 20 cache misses, 2 actual fallback errors

Raw Fallback Count: 22 (20 misses + 2 errors)
Effective Fallback Count: 2 (only errors)

Raw Fallback Rate: 22%
Effective Fallback Rate: 2%  ← More meaningful for SLO
```

**Configuration**:
```bash
# For production baseline (recommended)
COUNT_CACHE_MISS_AS_FALLBACK=false

# For cache performance analysis
COUNT_CACHE_MISS_AS_FALLBACK=true
```

---

## 4. Success Rate Metrics

### Plugin Reload Success Rate

**Definition**: Percentage of successful plugin (re)load operations

**Data Sources**:
- Success: `plugin_reload_success_total`
- Failure: `plugin_reload_failure_total`

**Calculation**:
```
Success Rate = (Success / (Success + Failure)) × 100%
```

**SLO Target**: > 95%

**Common Failure Causes**:
- Plugin syntax errors
- Missing dependencies
- Permission issues
- Timeout during initialization

### Snapshot Operation Success Rate

**Definition**: Percentage of successful snapshot query operations

**Data Sources**:
- Success: `snapshot_query_success_total`
- Failure: `snapshot_query_failure_total`

**SLO Target**: > 99%

**Lower Target Than Plugins**: Snapshot operations are more critical to core functionality

---

## 5. Error Rate Metrics

### Overall Error Rate

**Definition**: Percentage of requests resulting in errors (4xx, 5xx)

**Calculation**:
```
Error Rate = (Error Responses / Total Responses) × 100%
```

**SLO Target**: < 1%

**Breakdown**:
- **4xx Errors** (Client errors): Authentication, validation, not found
- **5xx Errors** (Server errors): Internal errors, service unavailable
- **Network Errors**: Timeouts, connection failures

**Severity Assessment**:
- < 0.1%: Excellent
- 0.1% - 1%: Acceptable, monitor
- 1% - 5%: Warning, investigate
- \> 5%: Critical, immediate action required

---

## 6. Throughput Metrics

### Requests Per Second

**Definition**: Average number of requests processed per second

**Purpose**: Establish baseline capacity, not an SLO target

**Calculation**:
```promql
rate(http_requests_total[10m])
```

**Use Cases**:
- Capacity planning
- Load testing validation
- Performance regression detection
- Scaling decisions

---

## Metric Collection Process

### Phase 5 Workflow

```
1. Pre-flight Check (verify-preconditions.sh)
   ├─ Validate environment variables
   ├─ Check feature flags
   └─ Test connectivity

2. Load Generation (phase5-load.sh)
   ├─ Sustained load: rate=80, concurrency=20
   └─ Duration: 2 hours (12 × 10-minute samples)

3. Metrics Collection (phase5-observe.sh)
   ├─ Every 10 minutes: Query Prometheus
   ├─ Calculate aggregations
   ├─ Write to metrics.csv
   └─ Real-time SLO judgment

4. Report Generation (phase5-fill-production-report.sh)
   ├─ Parse metrics.csv
   ├─ Calculate summary statistics
   ├─ Generate SLO Pass/Fail assessment
   └─ Output production-report.md
```

### Metrics CSV Schema

```csv
timestamp,p50_ms,p95_ms,p99_ms,memory_mb,cache_hit_rate_pct,fallback_count,error_rate_pct,req_per_sec,plugin_success_rate_pct,snapshot_success_rate_pct
2025-11-24T14:00:00Z,25.3,43.7,78.2,385,87.5,12,0.3,125.4,98.2,99.7
```

**New Columns Added** (v2.5.0):
- `cache_hit_rate_pct`: Cache hit percentage
- `plugin_success_rate_pct`: Plugin reload success rate
- `snapshot_success_rate_pct`: Snapshot operation success rate

---

## SLO Judgment Matrix

### Overall System Health Assessment

| Metric | Target | Weight | Pass Criteria |
|--------|--------|--------|---------------|
| P95 Latency | < 150ms | 30% | All samples pass |
| Memory | < 500MB avg | 15% | Avg + max within limits |
| Cache Hit Rate | > 80% | 20% | Average > 80% |
| Error Rate | < 1% | 20% | All samples < 1% |
| Plugin Success | > 95% | 7.5% | Average > 95% |
| Snapshot Success | > 99% | 7.5% | Average > 99% |

### Pass/Fail Logic

**PASS** (Green): All critical metrics meet SLO, < 2 warnings
**PASS WITH WARNINGS** (Yellow): All critical meet SLO, 2-4 warnings
**FAIL** (Red): Any critical metric fails SLO

**Critical Metrics**: P95 Latency, Memory, Error Rate
**Important Metrics**: Cache Hit Rate, Success Rates

---

## Troubleshooting Guide

### High P95 Latency

**Symptoms**: P95 > 150ms

**Investigation Steps**:
1. Check database query performance (slow queries)
2. Review cache hit rate (low = more DB queries)
3. Analyze concurrent request patterns
4. Check external service dependencies
5. Review resource contention (CPU, memory)

**Common Causes**:
- Cold cache (early in baseline)
- Database connection pool exhaustion
- Slow downstream services
- Insufficient resources

### Low Cache Hit Rate

**Symptoms**: < 80% hit rate

**Investigation Steps**:
1. Review cache TTL settings (too short?)
2. Analyze request patterns (cache-unfriendly?)
3. Check cache size limits (evictions?)
4. Monitor cache warm-up period
5. Validate cache key generation

**Common Causes**:
- Cache too small for working set
- Short TTL causing frequent invalidation
- High request variance (unique keys)
- Cache warming period not complete

### High Memory Usage

**Symptoms**: > 500MB average or growing trend

**Investigation Steps**:
1. Check for memory leaks (steady growth)
2. Review cache size configuration
3. Analyze connection pool sizes
4. Monitor GC frequency and duration
5. Profile memory allocations

**Common Causes**:
- Oversized cache
- Connection leaks
- Large response buffering
- Inefficient data structures

---

## Best Practices

### Before Baseline Collection

1. ✅ Run `phase5-verify-preconditions.sh`
2. ✅ Disable all test/internal features
3. ✅ Warm up cache (10-minute pre-load)
4. ✅ Verify Prometheus is scraping correctly
5. ✅ Set appropriate SLO targets

### During Collection

1. ⏱️ Monitor real-time progress via `observe.log`
2. 📊 Watch for anomalies in early samples
3. 🚨 Keep circuit breaker ready (error rate > 2%)
4. 📝 Document any incidents or interventions

### After Collection

1. 📈 Generate report immediately
2. 🔍 Review all SLO pass/fail assessments
3. 📊 Compare with historical baselines
4. 📝 Document deviations and root causes
5. 🎯 Update SLO targets if needed

---

## Appendix: Prometheus Queries

### Latency Histogram

```promql
# P95 over 10-minute window
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket{job="metasheet-api"}[10m])) by (le)
)

# P99 over 10-minute window
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket{job="metasheet-api"}[10m])) by (le)
)
```

### Cache Metrics

```promql
# Cache hit rate (%)
(
  rate(cache_hits_total{job="metasheet-api"}[10m]) /
  (
    rate(cache_hits_total{job="metasheet-api"}[10m]) +
    rate(cache_misses_total{job="metasheet-api"}[10m])
  )
) * 100

# Fallback count
increase(metasheet_snapshot_fallback_total{job="metasheet-api"}[10m])
```

### Success Rates

```promql
# Plugin reload success rate (%)
(
  rate(plugin_reload_success_total{job="metasheet-api"}[10m]) /
  (
    rate(plugin_reload_success_total{job="metasheet-api"}[10m]) +
    rate(plugin_reload_failure_total{job="metasheet-api"}[10m])
  )
) * 100

# Snapshot query success rate (%)
(
  rate(snapshot_query_success_total{job="metasheet-api"}[10m]) /
  (
    rate(snapshot_query_success_total{job="metasheet-api"}[10m]) +
    rate(snapshot_query_failure_total{job="metasheet-api"}[10m])
  )
) * 100
```

---

**Document Version**: 2.5.0
**Author**: Claude Code (Phase 5 Enhancement)
**Related**: `PHASE5_PREPARATION_CHECKLIST.md`, `READINESS_STATUS.md`
