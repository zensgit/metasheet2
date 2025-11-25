# Phase 5 Full Validation & Observability Expansion Design

## 1. Objective

Deliver a complete Phase 5 SLO validation pass (11 checks) by:

1. Populating all latency histograms (plugin reload, snapshot operations)
2. Enabling real cache metrics (hit/miss rate) via unified cache subsystem
3. Implementing fallback raw vs effective counters (if retained in SLO scope)
4. Removing NA states (NA = 0) and eliminating failed checks (except documented exclusions)
5. Producing a stable validation report with consistent sample counts and warnings

## 2. Current State Summary

| Area | Status | Notes |
|------|--------|-------|
| Plugin Reload Metrics | Implemented | `plugin-loader.ts` records success/failure counters + duration histogram |
| Snapshot Metrics | Implemented | Create/restore counters & duration histogram populated after migration |
| Cache Implementation | NullCache only | No real hits/misses; hit rate = 0% |
| Cache Metrics (Prometheus) | Partially divergent | Two metric systems: `metrics.ts` vs `src/cache/metrics.ts` |
| Fallback Metrics | Missing | Threshold expects `fallback_effective_ratio`, counters not implemented |
| Thresholds File | Present | `scripts/phase5-thresholds.json` (11 checks) |
| Validation Tooling | Enhanced | NA logic, dynamic latency loading, snapshot sections |

## 3. Gap Analysis

| Gap | Impact | Resolution |
|-----|--------|------------|
| Dual cache systems (`core/cache/CacheRegistry` vs `src/cache/registry.ts`) | Metrics confusion; no unified hit/miss export | Consolidate on `src/cache/registry.ts`; expose its metrics through Prometheus registry |
| Cache metrics naming inconsistency (`cache_misses_total` vs `cache_miss_total`) | Validation script may not match | Standardize on singular: `cache_miss_total` |
| Fallback counters absent | Fallback ratio always trivially 0; logic untested | Add raw + effective counters + taxonomy reasons |
| Cache disabled (NullCache) | `cache_hit_rate` fails threshold (0%) | Implement MemoryCache (in‑process) or Redis-backed \[preferred later] |
| Low sample counts for latency | Percentiles unstable / NA possibility | Increase sample generation counts (≥10 reloads, ≥6 snapshot ops) |
| Validation script not aware of new fallback counters | Incomplete ratio logic | Extend parsing for new counters |

## 4. Scope & Non‑Goals

In Scope:
- Unify cache metrics, implement MemoryCache, enable hit/miss counters
- Add fallback raw/effective counters with reason taxonomy
- Adjust scripts to populate plugin reload & cache metrics
- Update validation/reporting scripts for fallback & warnings

Out of Scope (Phase 5):
- Production Redis deployment hardening
- Advanced cache tag invalidation metrics
- Long duration soak (>10 minutes)
- Circuit breaker fallback simulation beyond basic HTTP error

## 5. Architecture Changes

### 5.1 Cache Subsystem Unification

Current: Prometheus metrics defined in `metrics.ts` (counters with labels) AND internal operational counters in `src/cache/metrics.ts`.

Design:
- Keep operational metrics (`cache_operations_total`, `cache_operation_duration_milliseconds`) for future perf analysis.
- Align top-level SLO counters to names consumed by validation script:
  - `cache_hits_total{impl}`
  - `cache_miss_total{impl}`
  - `cache_set_total{impl}`
  - `cache_del_total{impl}`
  - `cache_errors_total{impl,error_type}` (optional for diagnostics)
- Introduce MemoryCache implementing interface `Cache` with TTL Map.
- Registry chooses implementation based on env `FEATURE_CACHE=true` (MemoryCache default; `FEATURE_CACHE_REDIS=true` future branch).

### 5.2 Fallback Metrics

Counters:
1. `metasheet_fallback_total{reason}` – raw degraded events (includes cache miss if counted)
2. `metasheet_fallback_effective_total{reason}` – effective degradations excluding benign causes (e.g. pure cache misses) when `COUNT_CACHE_MISS_AS_FALLBACK=false`.

Reasons taxonomy (labels): `http_error`, `http_timeout`, `message_error`, `message_timeout`, `cache_miss`, `circuit_breaker`.

Ratio Calculation:
`fallback_effective_ratio = effective_total / raw_total` (0 if raw_total == 0).

Instrumentation Points:
- HTTP global error path (5xx) → `http_error`
- RPC timeout handling → `message_timeout`
- Cache miss decisions (optional raw only) → `cache_miss`
- Forced test route `/internal/test/fallback` → triggers `http_error`.

### 5.3 Validation & Reporting Adjustments

Scripts affected:
- `scripts/phase5-full-validate.sh` → parse fallback raw/effective counters; compute ratio; apply threshold.
- `scripts/phase5-generate-report.sh` → add Fallback section with raw/effective totals + ratio + reasons breakdown.
- Add warnings: latency histogram sample count < 5.

## 6. Data Flow (Cache Example)

1. API endpoint `/api/cache-test/simulate` calls `registry.get(key)`.
2. `registry.get()` delegates to active cache implementation.
3. Implementation returns value or null.
4. Registry records `hits` or `misses` and `operations` + duration.
5. Prometheus registry exports cumulative counters.
6. Validation script queries `/metrics/prom` and computes `cache_hit_rate = hits / (hits + misses)`.

## 7. Implementation Steps

| Step | Action | Detail | Output |
|------|--------|--------|--------|
| 1 | Introduce MemoryCache | TTL Map, methods get/set/del | `src/cache/memory-cache.ts` |
| 2 | Unify metrics export | Bridge `cacheMetrics` + SLO counters | Updated `metrics.ts` |
| 3 | Registry integration | Switch to new registry instance in `index.ts` | Cache enabled when env set |
| 4 | Fallback counters | Add counters + export + helper | Updated `metrics.ts`, `fallback-recorder.ts` |
| 5 | Instrument fallback points | HTTP error + test route | Modified `index.ts`, new route |
| 6 | Update validation script | Parse new counters & warnings | `phase5-full-validate.sh` patch |
| 7 | Update report script | New Fallback section + warnings | `phase5-generate-report.sh` patch |
| 8 | Populate metrics | Run plugin reload, snapshot ops, cache simulate | Metrics non-NA |
| 9 | Final validation | Generate JSON + MD | `/tmp/phase5-final.json/.md` |
| 10 | Documentation | Update completion report | `PHASE5_COMPLETION_REPORT.md` |

## 8. Fallback Strategy Decision Matrix

| Cause | Raw Count | Effective Count Rule | Justification |
|-------|-----------|----------------------|--------------|
| cache_miss | Increment | Exclude if `COUNT_CACHE_MISS_AS_FALLBACK=false` | Miss is normal; not a degradation if quickly served from origin |
| http_error | Increment | Include | User-visible failure |
| http_timeout | Increment | Include | Latency-based degradation |
| message_error | Increment | Include | Processing failure |
| message_timeout | Increment | Include | RPC latency impact |
| circuit_breaker | Increment | Include | System protection event |

## 9. Thresholds Alignment

| Metric | Kind | Source | Threshold | Notes |
|--------|------|--------|-----------|-------|
| metasheet_plugin_reload_duration_seconds p95 | latency | reload histogram | e.g. <= 2s | Ensure ≥10 samples |
| metasheet_plugin_reload_duration_seconds p99 | latency | reload histogram | e.g. <= 5s | Long tail check |
| metasheet_snapshot_operation_duration_seconds p95 create | latency | snapshot histogram(label) | <= Xs | Label selector operation=create |
| metasheet_snapshot_operation_duration_seconds p99 restore | latency | snapshot histogram(label) | <= Ys | Label selector operation=restore |
| http_success_rate | percentage | derived counters | >= 98% | Already passing |
| error_rate | percentage | HTTP counters | <= 2% | Should remain low |
| cache_hit_rate | percentage | cache counters | >= 80% | Requires warm hits |
| fallback_effective_ratio | ratio | raw/effective counters | <= 0.6 | Usually 0–0.2 |
| memory_rss | memory | process RSS | <= threshold | Observed ~65MB |

## 10. Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Low latency samples | Unstable p95/p99 | Increase operation counts (≥10 reloads, ≥6 snapshots) |
| Duplicate metric names | Prometheus registration error | Remove old unused counters before adding new ones |
| Cache still NullCache | Hit rate stays 0% | Ensure env flag toggles MemoryCache activation |
| Fallback ratio stuck NA | Report incomplete | Trigger controlled fallback test route |
| Over-counting cache_miss as effective | Ratio artificially high | Conditional logic exclude cache_miss when flag false |

## 11. Validation Procedure

1. Restart backend with `FEATURE_CACHE=true`.
2. Run `RELOAD_COUNT=12 bash scripts/phase5-populate-plugin-reload.sh`.
3. Execute snapshot create/restore loop (≥3 each).
4. Run cache simulation 5 times.
5. Trigger fallback route (3–5 times) if implemented.
6. `scripts/phase5-full-validate.sh -o /tmp/phase5-final.json http://localhost:8900/metrics/prom`.
7. `scripts/phase5-generate-report.sh /tmp/phase5-final.json /tmp/phase5-final.md`.
8. Confirm: NA=0, failed=0, warnings acceptable.
9. Update `PHASE5_COMPLETION_REPORT.md` with final metrics table + sample counts.

## 12. Success Criteria

| Criterion | Target |
|----------|--------|
| NA count | 0 |
| Failed count | 0 (or 1 with documented remediation plan) |
| cache_hit_rate | ≥ 80% |
| plugin reload samples | ≥ 10 |
| snapshot create+restore samples | ≥ 3 each |
| fallback effective ratio | ≤ 0.6 |
| Report sections | All present (Snapshot latency, Fallback, Warnings) |

## 13. Post-Phase Roadmap (Optional)

- Phase 6: Introduce RedisCache with pooling & network resiliency metrics
- Phase 7: Add cache tag invalidation counters & histogram
- Phase 8: Integrate circuit breaker fallback reason taxonomy & thresholds
- Phase 9: Add sustained soak test automation (24h) & variance analysis

## 14. Open Questions

| Question | Decision Needed By | Notes |
|----------|--------------------|-------|
| Keep MemoryCache vs implement Redis now? | Before enablement | Environment constraints may block Redis
| Count cache_miss as raw-only or exclude entirely? | Before fallback instrumentation | Affects effective ratio baseline
| Add additional latency metrics (cache operation p95)? | Next phase | Possibly Phase 6
| Warning threshold (samples <5 vs <10)? | Pre-report finalization | Impacts noise level

## 15. Implementation Checklist

```
[ ] Add MemoryCache implementation
[ ] Bridge cache metrics to Prometheus registry
[ ] Standardize cache counter names
[ ] Remove/disable legacy CacheRegistry metrics (if conflicting)
[ ] Add fallback counters (raw/effective) + taxonomy
[ ] Instrument HTTP error path & test fallback route
[ ] Patch validation script for fallback & sample warnings
[ ] Patch report script for new Fallback section
[ ] Populate metrics (reload/snapshot/cache/fallback)
[ ] Run final validation & report generation
[ ] Update completion report
```

## 16. Rollback Plan

If new cache/fallback instrumentation causes instability:
1. Disable via env: `FEATURE_CACHE=false`, `ENABLE_FALLBACK_METRICS=false`
2. Revert commits adding fallback counters
3. Maintain prior Phase 5 partial pass state (8 passed, 1 failed, 2 NA) while investigating

## 17. References

- `packages/core-backend/src/metrics/metrics.ts` (existing metrics definitions)
- `packages/core-backend/src/core/plugin-loader.ts` (plugin reload instrumentation)
- `packages/core-backend/src/routes/cache-test.ts` (cache simulation endpoint)
- `scripts/phase5-full-validate.sh` (validation logic)
- `scripts/phase5-generate-report.sh` (report generation)
- `scripts/phase5-thresholds.json` (SLO thresholds configuration)

---
**End of Document**

