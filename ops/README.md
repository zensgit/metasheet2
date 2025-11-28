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
  - `.github/workflows/phase5-nightly-validation.yml` (scheduled external metrics)
  - `.github/workflows/phase5-slo-validation.yml` (manual local spin-up)
- Unified runner script: `scripts/phase5-ci-run.sh` (local backend start + metric population + validation).
- Required secrets (set in repository settings → Secrets → Actions):
  - `METRICS_URL` – externally reachable Prometheus metrics endpoint (`https://<env>/metrics/prom`).
  - `METRICS_AUTH_HEADER` – optional auth header (e.g. `Authorization: Bearer <token>`).
  - `SLACK_WEBHOOK_URL` – optional: send Slack notify on nightly failure.
  - `SLACK_CHANNEL` – optional: channel/name for context.
- Branch protection recommendation:
  - Require successful status: “Phase 5 PR Validation (External Metrics Gate)”.
  - Disallow force pushes.
  - Enable “Require branches to be up to date” for accurate gating.

### Slack Failure Notifications (Nightly)
Add a step after gating in `phase5-nightly-validation.yml`:
```
- name: Notify Slack on failure
  if: failure()
  uses: slackapi/slack-github-action@v1.24.0
  with:
    payload: '{"text":"Phase 5 Nightly Validation FAILED for ${{ github.ref }}"}'
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
    SLACK_WEBHOOK_TYPE: INCOMING_WEBHOOK
```
Ensure `SLACK_WEBHOOK_URL` is configured. `SLACK_CHANNEL` only needed for certain webhook setups.

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

### CI Local Spin-Up (Manual)
Run GitHub Action “Phase 5 SLO Validation (Local CI)” which:
1. Checks out code
2. Installs dependencies (pnpm)
3. Starts backend & populates metrics via `scripts/phase5-ci-run.sh`
4. Uploads artifacts (phase5.json / phase5.md / server.log)

### External Metrics (Nightly / PR Gate)
If `METRICS_URL` is reachable:
1. Workflow queries endpoint
2. Runs validation scripts against remote metrics
3. Gates on `overall_status == pass`
4. Uploads artifacts for audit

If unreachable or not set → workflow exits early (marked skipped) to avoid false negatives.

## Guard Integration Test
- Run `scripts/phase5-guard-integration-test.sh` under production-like flags.
- Ensures unsafe routes blocked, fallback test hidden, and no sensitive config leakage.

## Notes
- Metrics source unified in `packages/core-backend/src/metrics/metrics.ts`.
- Cache labels kept low-cardinality (`impl`, `key_pattern`).
- Fallback effective excludes `cache_miss` when `COUNT_CACHE_MISS_AS_FALLBACK=false`.
- Recommended Prometheus alert examples (pseudo):
  - `metasheet:http_success_rate:5m < 0.98 for 5m`
  - `metasheet:cache_hit_rate:10m < 0.8 for 10m`
  - `metasheet_fallback_effective_total / metasheet_fallback_total > 0.6 for 10m`
  - `histogram_quantile(0.95, sum(rate(metasheet_plugin_reload_duration_seconds_bucket[5m])) by (le)) > 2`
  - Memory RSS > 500MB sustained 5m.
### Nightly Trend, Baseline Rotation & Retention
- Nightly workflow (`phase5-nightly-validation-regression.yml`) stages JSON → `results/nightly/phase5-YYYYMMDD.json`.
- Generates weekly trend file: `claudedocs/PHASE5_WEEKLY_TREND.md` (last 7 runs; includes Redis GET/SET p95 + recent failure flag).
- Baseline rotation workflow checks ≥14 consecutive PASS nightly JSONs; auto-PR updates `baseline/phase5-baseline.json`.
 - Retention cleanup: run `scripts/phase5-retention-cleanup.sh results/nightly 45` (remove files older than 45 days) – integrate into a weekly ops workflow.

### Redis Observability
- Metrics added:
  - `redis_operation_duration_seconds{op}` histogram (get/set/del)
  - `redis_recovery_attempts_total{result}` counter (success/error)
  - `redis_last_failure_timestamp` gauge (unix seconds)
- Recording rules:
  - `metasheet:redis_get_p95:5m`, `metasheet:redis_set_p95:5m` (p99 optional)
- Alerts (`phase5-alerts.yml`): Redis latency p95 (>50ms), recent failures.
- Absolute regression thresholds (env override):
  - `REDIS_GET_P95_MAX` (default 0.05s), `REDIS_SET_P95_MAX` (0.05s), `REDIS_GET_P99_MAX` (0.10s), `REDIS_SET_P99_MAX` (0.10s)

### Internal Routes Security & Rate Limit
- Internal routes path: `/internal/*` (cache/config/test)
- Production: automatically returns 404.
- Non-production security:
  - Optional token: set `INTERNAL_API_TOKEN` → require `x-internal-token` header or `?token=...` param.
  - Rate limit (in-memory): `INTERNAL_RATE_LIMIT_MAX` (default 120), `INTERNAL_RATE_LIMIT_WINDOW_MS` (default 60000). Set MAX <= 0 to disable.
  - Example: `INTERNAL_API_TOKEN=devtoken INTERNAL_RATE_LIMIT_MAX=60 INTERNAL_RATE_LIMIT_WINDOW_MS=30000`

### Slack Enrichment & Risk Pointers
- Failure payload includes: summary, regression diff, endpoint URL, Redis p95 & last failure age, recovery attempts.
- Success payload includes: summary, cache & HTTP rates, plugin/snapshot p95s, baseline deltas, Redis p95s, cache audit top misses.
 - Risk pointers added (e.g. HTTP success drop >0.3pp, cache hit <80%, fallback >5%, Redis latency >50ms, recent failures) to highlight emerging issues before regression.
- Add secrets: `SLACK_WEBHOOK_URL` (required), optionally `SLACK_CHANNEL`.

### Weekly Trend Generation Manual Run
```
bash scripts/phase5-weekly-trend.sh results/nightly claudedocs/PHASE5_WEEKLY_TREND.md 7
```
Outputs table with SLO metrics & Redis stats.

### Updating Baseline After Redis Enablement
1. Run full validation with Redis: `CACHE_IMPL=redis REDIS_URL=redis://host:6379 bash scripts/phase5-run-all.sh`.
2. Save baseline: `bash scripts/phase5-save-baseline.sh /tmp/phase5.json baseline`.
3. Commit new baseline and merge PR.

### Local Redis Setup (Degraded Option)
```
docker run -d --name ms-redis -p 6379:6379 redis:7-alpine
PORT=8901 FEATURE_CACHE=true CACHE_IMPL=redis REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @metasheet/core-backend dev

If schema/migrations unavailable but metrics needed:
DISABLE_EVENT_BUS=true PORT=8901 FEATURE_CACHE=true CACHE_IMPL=redis REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @metasheet/core-backend dev
```

### Regression Script Additions
- File: `scripts/phase5-regression-check.sh`
- Includes Redis latency delta checks + absolute thresholds.
- Recent failure flag sourced from validation JSON `redis_recent_failures` (1 if last failure <15m).

### SLO Tightening (Future)
- After stable improvements (p95 decreases >10% over 30 days), create suggestion JSON and PR with updated thresholds.
- Script placeholder: `scripts/phase5-slo-tighten-suggestions.sh` (to implement).
