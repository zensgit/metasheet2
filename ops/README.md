# Ops Setup for Phase 5 SLOs

## Prometheus
- Include rule files in `prometheus.yml`:
  - `ops/prometheus/phase5-alerts.yml`
  - `ops/prometheus/phase5-recording-rules.yml`
- Reload Prometheus (SIGHUP or API) after changes.

## Grafana
- Import dashboard JSON: `ops/grafana/dashboards/phase5-slo.json`.
- Verify threshold lines and sample count panels.
- Optionally provision via IaC (Terraform/Ansible).

## GitHub Actions
- CI workflows:
  - `.github/workflows/phase5-validate.yml` (PR gate)
  - `.github/workflows/phase5-nightly.yml` (scheduled)
- Secrets required:
  - `METRICS_URL` (staging/prod Prometheus endpoint)
  - `METRICS_AUTH_HEADER` (optional auth header, e.g., `Authorization: Bearer <token>`)
  - `SLACK_WEBHOOK_URL` (optional: nightly failure notifications)
  - `SLACK_CHANNEL` (optional: e.g., `alerts`)

### Manual Dispatch (Nightly)
- Actions → Phase 5 Nightly Validation → Run workflow
- Provide `metrics_url` input if not using the secret.

## Server Flags
- Production safety:
  - `ENABLE_FALLBACK_TEST=false`
  - `ALLOW_UNSAFE_ADMIN=false`
- Keep cache enabled:
  - `FEATURE_CACHE=true`

## Validation Runbook
- Start backend (dev):
  - `ALLOW_UNSAFE_ADMIN=true FEATURE_CACHE=true ENABLE_FALLBACK_TEST=true COUNT_CACHE_MISS_AS_FALLBACK=false pnpm --filter @metasheet/core-backend dev`
- One-shot validation:
  - `npm run phase5:run-all`
- Outputs:
  - `/tmp/phase5.json`, `/tmp/phase5.md`

## Guard Integration Test
- Run `scripts/phase5-guard-integration-test.sh` under production-like flags.
- Ensures unsafe routes blocked, fallback test hidden, and no sensitive config leakage.

## Notes
- Metrics source unified in `packages/core-backend/src/metrics/metrics.ts`.
- Cache labels kept low-cardinality (`impl`, `key_pattern`).
- Fallback effective excludes `cache_miss` when `COUNT_CACHE_MISS_AS_FALLBACK=false`.
