# Phase 5 Metrics Schema Comparison

Directory: `results/phase5-20251122-150047/`

## 1. Files
- Original (pre-enhancement): `metrics.original.csv`
- Enhanced (post-enhancement): `metrics.csv`

## 2. Schema Diff
| Column | Original | Enhanced v1 | Enhanced v2 | Description |
|--------|----------|------------|------------|-------------|
| timestamp | ✅ | ✅ | ✅ | Sample timestamp |
| http_success_rate | ✅ | ✅ | ✅ | Successful request ratio (0-1) |
| p50_latency | ❌ | ❌ | ✅ | Histogram-derived P50 latency (seconds) |
| p95_latency | ❌ | ❌ | ✅ | Histogram-derived P95 latency (seconds) |
| p99_latency | ✅ | ✅ | ✅ | Histogram-derived P99 latency (seconds) |
| fallback_ratio | ✅ | ✅ | ✅ | Fallback / total requests |
| error_rate | ❌ | ✅ | ✅ | 5xx / total requests |
| cpu_percent | ❌ | ✅ | ✅ | Backend process CPU usage (%) |
| mem_percent | ❌ | ✅ | ✅ | Backend process memory usage (%) |
| request_rate | ❌ | ❌ | ✅ | Requests per second (interval delta) |
| sample_num | ✅ | ✅ | ✅ | Sequential sample index |

## 3. Historical Backfill Approach
Enhanced CSV v2 rows populated with zeros for newly added latency percentiles, resource, and rate columns (p50_latency,p95_latency,error_rate,cpu_percent,mem_percent,request_rate) for historical backfill alignment.
No recalculation performed (insufficient raw data for retroactive resource metrics).

## 4. Basic Statistics (Original 12 Samples)
| Metric | Min | Max | Avg |
|--------|-----|-----|-----|
| Success % | 99.00 | 99.00 | 99.00 |
| P99 Latency (s) | 0.5 | 0.5 | 0.5 |
| Fallback % | 5.00 | 5.00 | 5.00 |

New columns (error_rate, cpu_percent, mem_percent) all zero in backfill.

## 5. Rerun Expectation (Production)
After production rerun, expect non-zero variance:
- error_rate: normally 0–1%; investigate >2% sustained.
- cpu_percent: depends on load; baseline target < 70% average.
- mem_percent: target < 80% average; watch for steady growth.
- p99_latency: should reflect real histogram distribution; validate bucket parsing outputs dynamic values.

## 6. Consumer Guidance
Downstream tooling should prefer `metrics.csv` and fall back to `metrics.original.csv` only if extended columns absent.
Detect schema via header count (8 columns expected). If fewer, treat as legacy.

## 7. Next Actions
1. Run production baseline to populate real extended metrics.
2. Update `PHASE5_COMPLETION_REPORT.md` with production statistics (include resource usage + error rate section).
3. Consider adding: p50, p95 latency columns; GC pause metrics; request rate (req/s) per interval.

---
Generated: $(date -Iseconds)
