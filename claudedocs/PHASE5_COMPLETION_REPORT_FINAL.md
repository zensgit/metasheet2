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

- Start backend (dev):
  - `ALLOW_UNSAFE_ADMIN=true FEATURE_CACHE=true ENABLE_FALLBACK_TEST=true COUNT_CACHE_MISS_AS_FALLBACK=false pnpm --filter @metasheet/core-backend dev`
- One-shot validation:
  - `npm run phase5:run-all`
- Outputs:
  - JSON: `/tmp/phase5.json`
  - Report: `/tmp/phase5.md`

## CI & Monitoring

- CI nightly validation: `.github/workflows/phase5-nightly-validation.yml` runs on cron and dispatch; fails when `overall_status != pass`.
- Prometheus alerts: `ops/prometheus/phase5-alerts.yml` covers HTTP success, cache hit rate, fallback ratio, plugin/snapshot latencies, memory.
- Grafana dashboard: `ops/grafana/dashboards/phase5-slo.json` panels for all 11 checks.

### CI Nightly Usage

- Manual dispatch: override `metrics_url` if not using default.
- Artifacts: `/tmp/phase5.json`, `/tmp/phase5.md` uploaded for trend tracking.
- Ensure metrics endpoint accessible from GitHub runners (allowlist if needed).

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
