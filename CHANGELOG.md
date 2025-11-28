# Changelog

## v2.5.0 - Phase 5 Operationalization

### Added
- Nightly Phase 5 validation workflow (`phase5-nightly.yml`) with metrics pre-check, artifact upload, Slack failure notifications.
- PR gated Phase 5 validation workflow (`phase5-validate.yml`) to enforce SLO pass on reachable metrics endpoint.
- Ops deploy workflow (`phase5-ops-deploy.yml`) for Prometheus rules + Grafana dashboard (branch-restricted, dry-run safety guard).
- Prometheus recording + alert rule files (`ops/prometheus/phase5-recording-rules.yml`, `ops/prometheus/phase5-alerts.yml`).
- Grafana dashboard JSON (`ops/grafana/dashboards/phase5-slo.json`).
- Deployment scripts: `scripts/phase5-deploy-prometheus-rules.sh`, `scripts/phase5-deploy-grafana-dashboard.sh`.
- MemoryCache implementation with labeled metrics and `cache_enabled` gauge.
- Fallback metrics (raw/effective) + recorder + guarded dev route.

### Changed
- Unified metrics definitions under `packages/core-backend/src/metrics/metrics.ts` (removed duplicate cache counters).
- Validation scripts enhanced (NA handling, dynamic latency metric discovery, enriched reporting sections).
- README updated with nightly status badge; workflows documented in `.github/workflows/README.md` and `ops/README.md` extended.

### Security / Safety
- Production guards: block unsafe admin route and fallback test route when `NODE_ENV=production`.
- Dry-run safety for ops deploy prevents accidental non-deploy with deploy flags.

### Documentation
- Final Phase 5 completion report and runbook updated (`claudedocs/PHASE5_COMPLETION_REPORT_FINAL.md`).
- Added CI & ops workflow README clarifications.

### Validation Result
- Phase 5 SLOs: 11/11 PASS (latencies populated, cache hit rate ≥80%, HTTP success ≥98%, fallback effective ratio ≤0.6, memory within threshold).
