# Phase 5 Completion Report (Final)

## Summary

- Result: PASS (11/11)
- Metrics URL: configurable (`METRICS_URL`)
- Sample sources: HTTP warm-up, plugin reloads, snapshot create/restore, cache simulate, fallback triggers

## Metrics Table

- plugin_reload_latency_p95: PASS (≤2s)
- plugin_reload_latency_p99: PASS (≤5s)
- snapshot_restore_latency_p95: PASS (≤5s)
- snapshot_restore_latency_p99: PASS (≤8s)
- snapshot_create_latency_p95: PASS (≤5s)
- snapshot_create_latency_p99: PASS (≤8s)
- cache_hit_rate: PASS (≥80%)
- fallback_effective_ratio: PASS (≤0.6)
- memory_rss: PASS (≤500MB)
- http_success_rate: PASS (≥98%)
- error_rate: PASS (≤1%)

## Operational Runbook

- Environment flags (dev validation):
  - `FEATURE_CACHE=true`
  - `ENABLE_FALLBACK_TEST=true` (dev only)
  - `COUNT_CACHE_MISS_AS_FALLBACK=false`
  - `ALLOW_UNSAFE_ADMIN=true` (dev only)
- Traffic volumes (defaults; override via env):
  - `HTTP_REQS=200`
  - `RELOAD_COUNT=12`
  - `SNAPSHOT_COUNT=10`
  - `CACHE_WARM_COUNT=200`
- Start backend (dev):
  - `ALLOW_UNSAFE_ADMIN=true FEATURE_CACHE=true ENABLE_FALLBACK_TEST=true COUNT_CACHE_MISS_AS_FALLBACK=false pnpm --filter @metasheet/core-backend dev`
- One-shot validation:
  - `npm run phase5:run-all`
  - or `scripts/phase5-full-validate.sh http://localhost:8900/metrics/prom /tmp/phase5.json && scripts/phase5-generate-report.sh /tmp/phase5.json /tmp/phase5.md`
- Outputs:
  - JSON: `/tmp/phase5.json`
  - Report: `/tmp/phase5.md`
  - Server log: `/tmp/server.log` (CI)

## Parameters

- HTTP requests: `HTTP_REQS=${HTTP_REQS:-200}`
- Plugin reloads: `RELOAD_COUNT=${RELOAD_COUNT:-12}`
- Snapshot ops: `SNAPSHOT_COUNT=${SNAPSHOT_COUNT:-10}`
- Cache warm count: `CACHE_WARM_COUNT=${CACHE_WARM_COUNT:-200}`

Export these before running the orchestrator to control load volume.

## CI & Monitoring

- CI nightly validation: `.github/workflows/phase5-nightly-validation.yml` runs on cron and dispatch; fails when `overall_status != pass`.
- Prometheus alerts: `ops/prometheus/phase5-alerts.yml` covers HTTP success, cache hit rate, fallback ratio, plugin/snapshot latencies, memory.
- Grafana dashboard: `ops/grafana/dashboards/phase5-slo.json` panels for all 11 checks.

### CI Nightly Usage

- Manual dispatch: override `metrics_url` if not using default.
- Artifacts: `/tmp/phase5.json`, `/tmp/phase5.md` uploaded for trend tracking.
- Ensure metrics endpoint accessible from GitHub runners (allowlist if needed).

### Weekly Trend

- Nightly workflow 会将每天的 JSON 保存到 `results/nightly/phase5-YYYYMMDD.json` 并自动生成 `claudedocs/PHASE5_WEEKLY_TREND.md`。
- 查看近 7 天 SLO 趋势（含 Redis 指标）: 见 `claudedocs/PHASE5_WEEKLY_TREND.md`。
- 收紧建议文件：`claudedocs/PHASE5_SLO_SUGGESTIONS.json`（基于最近 30 天中位数 p95，对比现有阈值 <90% 时提出新阈值建议）。

### Internal Routes Security

- `/internal/*` 仅在非生产环境开放，且可通过设置 `INTERNAL_API_TOKEN` 要求请求头 `x-internal-token` 或 `?token=...`。
- 生产环境强制返回 404；不要暴露到公共网络。

## Production Hardening

- Disable dev-only features in prod: `ENABLE_FALLBACK_TEST=false`, `ALLOW_UNSAFE_ADMIN=false`.
- Keep cache enabled: `FEATURE_CACHE=true` (MemoryCache or Redis adapter).

## Staging Ops

- Flags: `FEATURE_CACHE=true ENABLE_FALLBACK_TEST=true COUNT_CACHE_MISS_AS_FALLBACK=false ALLOW_UNSAFE_ADMIN=true`
- Metrics URL: set `METRICS_URL` secret for CI nightly validation.
- Warm-up volumes:
  - HTTP: 200 requests across 4 endpoints
  - Plugin reloads: 12
  - Snapshots: 3 creates + 3 restores (min), recommend 10 total
  - Cache simulate: ≥5 keys (miss→set→hit cycles)
  - Fallback triggers: mixed reasons; ensure effective excludes cache_miss
- Artifacts: CI uploads `/tmp/phase5.json` and `/tmp/phase5.md` with 7-day retention.

## Notes

- Metrics source unified in `packages/core-backend/src/metrics/metrics.ts`.
- Cache labels kept low-cardinality (`impl`, `key_pattern`).
- Fallback effective excludes `cache_miss` when `COUNT_CACHE_MISS_AS_FALLBACK=false`.
\n## Run Artifact (2025-11-26 14:43:26)\n
Source: /tmp/phase5.md\n
# Phase 5 SLO Validation Report

**Status**: ✅ **PASS**
**Timestamp**: 2025-11-26T06:43:26Z
**Metrics Source**: `http://localhost:8900/metrics/prom`

---

## Summary

| Metric | Value |
|--------|-------|
| Total Checks | 11 |
| Passed | ✅ 7 |
| Failed | ❌ 0 |
| N/A | ⚪ 4 |
| Overall Status | ✅ PASS |

---

## SLO Assertions

| Metric | Actual | Threshold | Comparison | Status |
|--------|--------|-----------|------------|--------|
| plugin_reload_latency_p95 | 0.095s | 2.0s | ≤ | ✅ pass |
| plugin_reload_latency_p99 | 0.09900000000000002s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p95 | 0s | 5.0s | N/A | ❌ na |
| snapshot_restore_latency_p99 | 0s | 8.0s | N/A | ❌ na |
| snapshot_create_latency_p95 | 0s | 5.0s | N/A | ❌ na |
| snapshot_create_latency_p99 | 0s | 8.0s | N/A | ❌ na |
| cache_hit_rate | 97.00% | 80.0% | ≥ | ✅ pass |
| fallback_effective_ratio | 0 | 0.6 | ≤ | ✅ pass |
| memory_rss | 146.31MB | 500.0MB | ≤ | ✅ pass |
| http_success_rate | 100.00% | 98.0% | ≥ | ✅ pass |
| error_rate | 0% | 1.0% | ≤ | ✅ pass |

---

## Detailed Metrics

### Percentile Latencies

**Plugin Reload Duration** (example-plugin):
- P50: 0.05s
- P95: 0.095s
- P99: 0.09900000000000002s
- Sample Count: 11

**Snapshot Restore Duration**:
- P50: 0s
- P95: 0s
- P99: 0s
- Sample Count: 0

**Snapshot Create Duration**:
- P50: 0s
- P95: 0s
- P99: 0s
- Sample Count: 0

### Counter Metrics

- **Cache Hit Rate**: 97.00%
- **HTTP Success Rate**: 100.00%
- **Error Rate**: 0%
- **Raw Fallback Count**: 1
- **Effective Fallback Count**: 0
- **Fallback Effective Ratio**: 0
- **Memory RSS**: 146.31MB

### Fallback Metrics

**Summary**:
- Raw Total: 1
- Effective Total: 0
- Ratio (effective/raw): 0

**Breakdown by Reason** (raw counts):

| Reason | Count | Counts as Effective |
|--------|-------|---------------------|
| cache_miss | 1 | No (excluded) |
| circuit_breaker | 0 | Yes |
| http_error | 1 | Yes |
| http_timeout | 1 | Yes |
| message_error | 0 | Yes |
| message_timeout | 0 | Yes |
| unknown | 0 | Yes |
| upstream_error | 1 | Yes |

---

## Validation Status

- **Fallback Taxonomy**: ✅ Valid

---

## Configuration

- **COUNT_CACHE_MISS_AS_FALLBACK**: false
- **Thresholds File**: `/Users/huazhou/Insync/hua.chau@outlook.com/OneDrive/应用/GitHub/smartsheet/metasheet-v2/scripts/phase5-thresholds.json`

---

**Generated at**: 2025-11-26 06:43:26 UTC

\n---\n
\n## Run Artifact (2025-11-26 14:51:09)\n
Source: /tmp/phase5.md\n
# Phase 5 SLO Validation Report

**Status**: ✅ **PASS**
**Timestamp**: 2025-11-26T06:51:09Z
**Metrics Source**: `http://localhost:8900/metrics/prom`

---

## Summary

| Metric | Value |
|--------|-------|
| Total Checks | 11 |
| Passed | ✅ 9 |
| Failed | ❌ 0 |
| N/A | ⚪ 2 |
| Overall Status | ✅ PASS |

---

## SLO Assertions

| Metric | Actual | Threshold | Comparison | Status |
|--------|--------|-----------|------------|--------|
| plugin_reload_latency_p95 | 0.095s | 2.0s | ≤ | ✅ pass |
| plugin_reload_latency_p99 | 0.099s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p95 | 0.095s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p99 | 0.099s | 8.0s | ≤ | ✅ pass |
| snapshot_create_latency_p95 | 0s | 5.0s | N/A | ❌ na |
| snapshot_create_latency_p99 | 0s | 8.0s | N/A | ❌ na |
| cache_hit_rate | 97.00% | 80.0% | ≥ | ✅ pass |
| fallback_effective_ratio | 0 | 0.6 | ≤ | ✅ pass |
| memory_rss | 105.45MB | 500.0MB | ≤ | ✅ pass |
| http_success_rate | 100.00% | 98.0% | ≥ | ✅ pass |
| error_rate | 0% | 1.0% | ≤ | ✅ pass |

---

## Detailed Metrics

### Percentile Latencies

**Plugin Reload Duration** (example-plugin):
- P50: 0.05s
- P95: 0.095s
- P99: 0.099s
- Sample Count: 61

**Snapshot Restore Duration**:
- P50: 0.05s
- P95: 0.095s
- P99: 0.099s
- Sample Count: 5

**Snapshot Create Duration**:
- P50: 0s
- P95: 0s
- P99: 0s
- Sample Count: 0

### Counter Metrics

- **Cache Hit Rate**: 97.00%
- **HTTP Success Rate**: 100.00%
- **Error Rate**: 0%
- **Raw Fallback Count**: 1
- **Effective Fallback Count**: 0
- **Fallback Effective Ratio**: 0
- **Memory RSS**: 105.45MB

### Fallback Metrics

**Summary**:
- Raw Total: 1
- Effective Total: 0
- Ratio (effective/raw): 0

**Breakdown by Reason** (raw counts):

| Reason | Count | Counts as Effective |
|--------|-------|---------------------|
| cache_miss | 1 | No (excluded) |
| circuit_breaker | 0 | Yes |
| http_error | 1 | Yes |
| http_timeout | 1 | Yes |
| message_error | 0 | Yes |
| message_timeout | 0 | Yes |
| unknown | 0 | Yes |
| upstream_error | 1 | Yes |

---

## Validation Status

- **Fallback Taxonomy**: ✅ Valid

---

## Configuration

- **COUNT_CACHE_MISS_AS_FALLBACK**: false
- **Thresholds File**: `/Users/huazhou/Insync/hua.chau@outlook.com/OneDrive/应用/GitHub/smartsheet/metasheet-v2/scripts/phase5-thresholds.json`

---

**Generated at**: 2025-11-26 06:51:09 UTC

\n---\n
\n## Run Artifact (2025-11-26 14:52:28)\n
Source: /tmp/phase5.md\n
# Phase 5 SLO Validation Report

**Status**: ✅ **PASS**
**Timestamp**: 2025-11-26T06:52:27Z
**Metrics Source**: `http://localhost:8900/metrics/prom`

---

## Summary

| Metric | Value |
|--------|-------|
| Total Checks | 11 |
| Passed | ✅ 9 |
| Failed | ❌ 0 |
| N/A | ⚪ 2 |
| Overall Status | ✅ PASS |

---

## SLO Assertions

| Metric | Actual | Threshold | Comparison | Status |
|--------|--------|-----------|------------|--------|
| plugin_reload_latency_p95 | 0.09499999999999999s | 2.0s | ≤ | ✅ pass |
| plugin_reload_latency_p99 | 0.099s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p95 | 0.095s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p99 | 0.099s | 8.0s | ≤ | ✅ pass |
| snapshot_create_latency_p95 | 0s | 5.0s | N/A | ❌ na |
| snapshot_create_latency_p99 | 0s | 8.0s | N/A | ❌ na |
| cache_hit_rate | 97.02% | 80.0% | ≥ | ✅ pass |
| fallback_effective_ratio | 0 | 0.6 | ≤ | ✅ pass |
| memory_rss | 84.85MB | 500.0MB | ≤ | ✅ pass |
| http_success_rate | 100.00% | 98.0% | ≥ | ✅ pass |
| error_rate | 0% | 1.0% | ≤ | ✅ pass |

---

## Detailed Metrics

### Percentile Latencies

**Plugin Reload Duration** (example-plugin):
- P50: 0.05s
- P95: 0.09499999999999999s
- P99: 0.099s
- Sample Count: 72

**Snapshot Restore Duration**:
- P50: 0.05s
- P95: 0.095s
- P99: 0.099s
- Sample Count: 5

**Snapshot Create Duration**:
- P50: 0s
- P95: 0s
- P99: 0s
- Sample Count: 0

### Counter Metrics

- **Cache Hit Rate**: 97.02%
- **HTTP Success Rate**: 100.00%
- **Error Rate**: 0%
- **Raw Fallback Count**: 2
- **Effective Fallback Count**: 0
- **Fallback Effective Ratio**: 0
- **Memory RSS**: 84.85MB

### Fallback Metrics

**Summary**:
- Raw Total: 2
- Effective Total: 0
- Ratio (effective/raw): 0

**Breakdown by Reason** (raw counts):

| Reason | Count | Counts as Effective |
|--------|-------|---------------------|
| cache_miss | 2 | No (excluded) |
| circuit_breaker | 0 | Yes |
| http_error | 2 | Yes |
| http_timeout | 2 | Yes |
| message_error | 0 | Yes |
| message_timeout | 0 | Yes |
| unknown | 0 | Yes |
| upstream_error | 2 | Yes |

---

## Validation Status

- **Fallback Taxonomy**: ✅ Valid

---

## Configuration

- **COUNT_CACHE_MISS_AS_FALLBACK**: false
- **Thresholds File**: `/Users/huazhou/Insync/hua.chau@outlook.com/OneDrive/应用/GitHub/smartsheet/metasheet-v2/scripts/phase5-thresholds.json`

---

**Generated at**: 2025-11-26 06:52:28 UTC

\n---\n
\n## Run Artifact (2025-11-26 14:53:40)\n
Source: /tmp/phase5.md\n
# Phase 5 SLO Validation Report

**Status**: ✅ **PASS**
**Timestamp**: 2025-11-26T06:53:40Z
**Metrics Source**: `http://localhost:8900/metrics/prom`

---

## Summary

| Metric | Value |
|--------|-------|
| Total Checks | 11 |
| Passed | ✅ 11 |
| Failed | ❌ 0 |
| N/A | ⚪ 0 |
| Overall Status | ✅ PASS |

---

## SLO Assertions

| Metric | Actual | Threshold | Comparison | Status |
|--------|--------|-----------|------------|--------|
| plugin_reload_latency_p95 | 0.095s | 2.0s | ≤ | ✅ pass |
| plugin_reload_latency_p99 | 0.099s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p95 | 0.095s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p99 | 0.099s | 8.0s | ≤ | ✅ pass |
| snapshot_create_latency_p95 | 0.095s | 5.0s | ≤ | ✅ pass |
| snapshot_create_latency_p99 | 0.099s | 8.0s | ≤ | ✅ pass |
| cache_hit_rate | 97.03% | 80.0% | ≥ | ✅ pass |
| fallback_effective_ratio | 0 | 0.6 | ≤ | ✅ pass |
| memory_rss | 89.73MB | 500.0MB | ≤ | ✅ pass |
| http_success_rate | 100.00% | 98.0% | ≥ | ✅ pass |
| error_rate | 0% | 1.0% | ≤ | ✅ pass |

---

## Detailed Metrics

### Percentile Latencies

**Plugin Reload Duration** (example-plugin):
- P50: 0.05s
- P95: 0.095s
- P99: 0.099s
- Sample Count: 83

**Snapshot Restore Duration**:
- P50: 0.05s
- P95: 0.095s
- P99: 0.099s
- Sample Count: 5

**Snapshot Create Duration**:
- P50: 0.05s
- P95: 0.095s
- P99: 0.099s
- Sample Count: 10

### Counter Metrics

- **Cache Hit Rate**: 97.03%
- **HTTP Success Rate**: 100.00%
- **Error Rate**: 0%
- **Raw Fallback Count**: 3
- **Effective Fallback Count**: 0
- **Fallback Effective Ratio**: 0
- **Memory RSS**: 89.73MB

### Fallback Metrics

**Summary**:
- Raw Total: 3
- Effective Total: 0
- Ratio (effective/raw): 0

**Breakdown by Reason** (raw counts):

| Reason | Count | Counts as Effective |
|--------|-------|---------------------|
| cache_miss | 3 | No (excluded) |
| circuit_breaker | 0 | Yes |
| http_error | 3 | Yes |
| http_timeout | 3 | Yes |
| message_error | 0 | Yes |
| message_timeout | 0 | Yes |
| unknown | 0 | Yes |
| upstream_error | 3 | Yes |

---

## Validation Status

- **Fallback Taxonomy**: ✅ Valid

---

## Configuration

- **COUNT_CACHE_MISS_AS_FALLBACK**: false
- **Thresholds File**: `/Users/huazhou/Insync/hua.chau@outlook.com/OneDrive/应用/GitHub/smartsheet/metasheet-v2/scripts/phase5-thresholds.json`

---

**Generated at**: 2025-11-26 06:53:40 UTC

\n---\n
\n## Run Artifact (2025-11-27 22:11:46)\n
Source: /tmp/phase5.md\n
# Phase 5 SLO Validation Report

**Status**: ❌ **FAIL**
**Timestamp**: 
**Metrics Source**: ``

---

## Summary

| Metric | Value |
|--------|-------|
| Total Checks |  |
| Passed | ✅  |
| Failed | ❌  |
| N/A | ⚪  |
| Overall Status | ❌ FAIL |

---

## SLO Assertions

| Metric | Actual | Threshold | Comparison | Status |
|--------|--------|-----------|------------|--------|

---

## Detailed Metrics

### Percentile Latencies

**Plugin Reload Duration** (example-plugin):
- P50: s
- P95: s
- P99: s
- Sample Count: 

**Snapshot Restore Duration**:
- P50: s
- P95: s
- P99: s
- Sample Count: 

**Snapshot Create Duration**:
- P50: s
- P95: s
- P99: s
- Sample Count: 

### Counter Metrics

- **Cache Hit Rate**: %
- **HTTP Success Rate**: %
- **Error Rate**: %
- **Raw Fallback Count**: 
- **Effective Fallback Count**: 
- **Fallback Effective Ratio**: 
- **Memory RSS**: MB

### Fallback Metrics

**Summary**:
- Raw Total: 
- Effective Total: 
- Ratio (effective/raw): 

**Breakdown by Reason** (raw counts):

| Reason | Count | Counts as Effective |
|--------|-------|---------------------|

---

## Validation Status

- **Fallback Taxonomy**: ⚠️ Invalid reasons found

---

## Configuration

- **COUNT_CACHE_MISS_AS_FALLBACK**: 
- **Thresholds File**: ``

---

**Generated at**: 2025-11-27 14:11:46 UTC

\n---\n
\n## Run Artifact (2025-11-27 22:13:01)\n
Source: /tmp/phase5.md\n
# Phase 5 SLO Validation Report

**Status**: ✅ **PASS**
**Timestamp**: 2025-11-27T14:12:59Z
**Metrics Source**: `http://localhost:8900/metrics/prom`

---

## Summary

| Metric | Value |
|--------|-------|
| Total Checks | 11 |
| Passed | ✅ 11 |
| Failed | ❌ 0 |
| N/A | ⚪ 0 |
| Overall Status | ✅ PASS |

---

## SLO Assertions

| Metric | Actual | Threshold | Comparison | Status |
|--------|--------|-----------|------------|--------|
| plugin_reload_latency_p95 | 0.095s | 2.0s | ≤ | ✅ pass |
| plugin_reload_latency_p99 | 0.099s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p95 | 0.09499999999999999s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p99 | 0.09899999999999999s | 8.0s | ≤ | ✅ pass |
| snapshot_create_latency_p95 | 0.095s | 5.0s | ≤ | ✅ pass |
| snapshot_create_latency_p99 | 0.09900000000000002s | 8.0s | ≤ | ✅ pass |
| cache_hit_rate | 99.27% | 80.0% | ≥ | ✅ pass |
| fallback_effective_ratio | 0 | 0.6 | ≤ | ✅ pass |
| memory_rss | 50.35MB | 500.0MB | ≤ | ✅ pass |
| http_success_rate | 100.00% | 98.0% | ≥ | ✅ pass |
| error_rate | 0% | 1.0% | ≤ | ✅ pass |

---

## Detailed Metrics

### Percentile Latencies

**Plugin Reload Duration** (example-plugin):
- P50: 0.05s
- P95: 0.095s
- P99: 0.099s
- Sample Count: 67

**Snapshot Restore Duration**:
- P50: 0.05s
- P95: 0.09499999999999999s
- P99: 0.09899999999999999s
- Sample Count: 3

**Snapshot Create Duration**:
- P50: 0.05s
- P95: 0.095s
- P99: 0.09900000000000002s
- Sample Count: 44

### Counter Metrics

- **Cache Hit Rate**: 99.27%
- **HTTP Success Rate**: 100.00%
- **Error Rate**: 0%
- **Raw Fallback Count**: 6
- **Effective Fallback Count**: 0
- **Fallback Effective Ratio**: 0
- **Memory RSS**: 50.35MB

### Fallback Metrics

**Summary**:
- Raw Total: 6
- Effective Total: 0
- Ratio (effective/raw): 0

**Breakdown by Reason** (raw counts):

| Reason | Count | Counts as Effective |
|--------|-------|---------------------|
| cache_miss | 6 | No (excluded) |
| circuit_breaker | 0 | Yes |
| http_error | 6 | Yes |
| http_timeout | 5 | Yes |
| message_error | 0 | Yes |
| message_timeout | 0 | Yes |
| unknown | 0 | Yes |
| upstream_error | 5 | Yes |

---

## Validation Status

- **Fallback Taxonomy**: ✅ Valid


### Warnings

| Metric | Issue | Message |
|--------|-------|---------|
| "metasheet_snapshot_operation_duration_seconds{operation=\"restore\"}" | low_sample_count | Histogram has only 3 samples - percentiles may be unstable (recommend >= 5) |

---

## Configuration

- **COUNT_CACHE_MISS_AS_FALLBACK**: false
- **Thresholds File**: `/Users/huazhou/Insync/hua.chau@outlook.com/OneDrive/应用/GitHub/smartsheet/metasheet-v2/scripts/phase5-thresholds.json`

---

**Generated at**: 2025-11-27 14:13:01 UTC

\n---\n
\n## Run Artifact (2025-11-27 22:19:30)\n
Source: /tmp/phase5.md\n
# Phase 5 SLO Validation Report

**Status**: ✅ **PASS**
**Timestamp**: 2025-11-27T14:19:28Z
**Metrics Source**: `http://localhost:8900/metrics/prom`

---

## Summary

| Metric | Value |
|--------|-------|
| Total Checks | 11 |
| Passed | ✅ 11 |
| Failed | ❌ 0 |
| N/A | ⚪ 0 |
| Overall Status | ✅ PASS |

---

## SLO Assertions

| Metric | Actual | Threshold | Comparison | Status |
|--------|--------|-----------|------------|--------|
| plugin_reload_latency_p95 | 0.095s | 2.0s | ≤ | ✅ pass |
| plugin_reload_latency_p99 | 0.09900000000000002s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p95 | 0.09499999999999999s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p99 | 0.09899999999999999s | 8.0s | ≤ | ✅ pass |
| snapshot_create_latency_p95 | 0.095s | 5.0s | ≤ | ✅ pass |
| snapshot_create_latency_p99 | 0.099s | 8.0s | ≤ | ✅ pass |
| cache_hit_rate | 99.11% | 80.0% | ≥ | ✅ pass |
| fallback_effective_ratio | 0 | 0.6 | ≤ | ✅ pass |
| memory_rss | 78.18MB | 500.0MB | ≤ | ✅ pass |
| http_success_rate | 100.00% | 98.0% | ≥ | ✅ pass |
| error_rate | 0% | 1.0% | ≤ | ✅ pass |

---

## Detailed Metrics

### Percentile Latencies

**Plugin Reload Duration** (example-plugin):
- P50: 0.05s
- P95: 0.095s
- P99: 0.09900000000000002s
- Sample Count: 88

**Snapshot Restore Duration**:
- P50: 0.05s
- P95: 0.09499999999999999s
- P99: 0.09899999999999999s
- Sample Count: 3

**Snapshot Create Duration**:
- P50: 0.05s
- P95: 0.095s
- P99: 0.099s
- Sample Count: 54

### Counter Metrics

- **Cache Hit Rate**: 99.11%
- **HTTP Success Rate**: 100.00%
- **Error Rate**: 0%
- **Raw Fallback Count**: 7
- **Effective Fallback Count**: 0
- **Fallback Effective Ratio**: 0
- **Memory RSS**: 78.18MB

### Fallback Metrics

**Summary**:
- Raw Total: 7
- Effective Total: 0
- Ratio (effective/raw): 0

**Breakdown by Reason** (raw counts):

| Reason | Count | Counts as Effective |
|--------|-------|---------------------|
| cache_miss | 7 | No (excluded) |
| circuit_breaker | 0 | Yes |
| http_error | 7 | Yes |
| http_timeout | 6 | Yes |
| message_error | 0 | Yes |
| message_timeout | 0 | Yes |
| unknown | 0 | Yes |
| upstream_error | 6 | Yes |

---

## Validation Status

- **Fallback Taxonomy**: ✅ Valid


### Warnings

| Metric | Issue | Message |
|--------|-------|---------|
| "metasheet_snapshot_operation_duration_seconds{operation=\"restore\"}" | low_sample_count | Histogram has only 3 samples - percentiles may be unstable (recommend >= 5) |

---

## Configuration

- **COUNT_CACHE_MISS_AS_FALLBACK**: false
- **Thresholds File**: `/Users/huazhou/Insync/hua.chau@outlook.com/OneDrive/应用/GitHub/smartsheet/metasheet-v2/scripts/phase5-thresholds.json`

---

**Generated at**: 2025-11-27 14:19:30 UTC

\n---\n
\n## Run Artifact (2025-11-28 21:50:24)\n
Source: /tmp/phase5.md\n
# Phase 5 SLO Validation Report

**Status**: ✅ **PASS**
**Timestamp**: 2025-11-28T13:50:24Z
**Metrics Source**: `http://127.0.0.1:8901/metrics/prom`

---

## Summary

| Metric | Value |
|--------|-------|
| Total Checks | 11 |
| Passed | ✅ 11 |
| Failed | ❌ 0 |
| N/A | ⚪ 0 |
| Overall Status | ✅ PASS |

---

## SLO Assertions

| Metric | Actual | Threshold | Comparison | Status |
|--------|--------|-----------|------------|--------|
| plugin_reload_latency_p95 | 0.095s | 2.0s | ≤ | ✅ pass |
| plugin_reload_latency_p99 | 0.09900000000000002s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p95 | 0.095s | 5.0s | ≤ | ✅ pass |
| snapshot_restore_latency_p99 | 0.099s | 8.0s | ≤ | ✅ pass |
| snapshot_create_latency_p95 | 0.095s | 5.0s | ≤ | ✅ pass |
| snapshot_create_latency_p99 | 0.099s | 8.0s | ≤ | ✅ pass |
| cache_hit_rate | 95.42% | 80.0% | ≥ | ✅ pass |
| fallback_effective_ratio | 0 | 0.6 | ≤ | ✅ pass |
| memory_rss | 68.37MB | 500.0MB | ≤ | ✅ pass |
| http_success_rate | 100.00% | 98.0% | ≥ | ✅ pass |
| error_rate | 0% | 1.0% | ≤ | ✅ pass |

---

## Detailed Metrics

### Percentile Latencies

**Plugin Reload Duration** (example-plugin):
- P50: 0.05s
- P95: 0.095s
- P99: 0.09900000000000002s
- Sample Count: 44

**Snapshot Restore Duration**:
- P50: 0.05s
- P95: 0.095s
- P99: 0.099s
- Sample Count: 10

**Snapshot Create Duration**:
- P50: 0.05s
- P95: 0.095s
- P99: 0.099s
- Sample Count: 40

### Counter Metrics

- **Cache Hit Rate**: 95.42%
- **HTTP Success Rate**: 100.00%
- **Error Rate**: 0%
- **Raw Fallback Count**: 4
- **Effective Fallback Count**: 0
- **Fallback Effective Ratio**: 0
- **Memory RSS**: 68.37MB

### Fallback Metrics

**Summary**:
- Raw Total: 4
- Effective Total: 0
- Ratio (effective/raw): 0

**Breakdown by Reason** (raw counts):

| Reason | Count | Counts as Effective |
|--------|-------|---------------------|
| cache_miss | 4 | No (excluded) |
| circuit_breaker | 0 | Yes |
| http_error | 4 | Yes |
| http_timeout | 4 | Yes |
| message_error | 0 | Yes |
| message_timeout | 0 | Yes |
| unknown | 0 | Yes |
| upstream_error | 4 | Yes |

---

## Validation Status

- **Fallback Taxonomy**: ✅ Valid

---

## Configuration

- **COUNT_CACHE_MISS_AS_FALLBACK**: false
- **Thresholds File**: `/Users/huazhou/Insync/hua.chau@outlook.com/OneDrive/应用/GitHub/smartsheet/metasheet-v2/scripts/phase5-thresholds.json`

---

**Generated at**: 2025-11-28 13:50:24 UTC

\n---\n
