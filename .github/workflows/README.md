# Phase 5 Validation Workflows

This folder contains GitHub Actions that validate Phase 5 SLOs against a Prometheus‑style metrics endpoint.

## Workflows

- `comments-nightly.yml`
  - Runs nightly (02:30 UTC) and on manual dispatch.
  - Spins up Postgres, runs migrations + RBAC seed, then starts backend/web.
  - Executes `pnpm verify:comments` (summary + UI smoke) and `pnpm verify:editable-demo`.
  - Set `RUN_EDITABLE_DEMO_SMOKE=false` to skip the editable demo smoke step.
  - Uploads artifacts (retention 14 days): `artifacts/comments-ui-grid.png`, `artifacts/comments-ui-kanban.png`,
    `artifacts/editable-demo-grid.png`, `artifacts/editable-demo-kanban.png`,
    `artifacts/editable-demo-ui-verification.json`, `/tmp/metasheet-core-backend.log`, `/tmp/metasheet-web.log`.

- `smoke-verify.yml`
  - Manual dispatch only (lightweight smoke).
  - Runs `pnpm verify:smoke:all` with `SMOKE_DATABASE_URL` and `PLAYWRIGHT_CHANNEL=chromium`.
  - Uploads artifacts (retention 14 days): `artifacts/comments-ui-grid.png`, `artifacts/comments-ui-kanban.png`,
    `artifacts/editable-demo-grid.png`, `artifacts/editable-demo-kanban.png`,
    `artifacts/editable-demo-ui-verification.json`, `artifacts/smoke/backend.log`, `artifacts/smoke/web.log`.

- `phase5-nightly-validation-regression.yml`
  - Triggers nightly at 02:00 UTC and via manual dispatch.
  - Pre‑checks metrics endpoint reachability; skips gracefully if unreachable.
  - Runs validation (`scripts/phase5-full-validate.sh`) + report generation.
  - Uploads artifacts: `/tmp/phase5.json`, `/tmp/phase5.md`, `/tmp/regression.txt`.
  - Stages nightly JSON → `results/nightly/phase5-YYYYMMDD.json` and regenerates `claudedocs/PHASE5_WEEKLY_TREND.md`.
  - Opens PR with nightly JSON + weekly trend (supports baseline rotation after 14 PASS days).
  - Slack success message: baseline deltas, Redis p95 values, cache audit top misses.
  - Slack failure message: regression diff, Redis GET/SET p95, last failure age, recovery attempts.

- `phase5-validate.yml`
  - Runs on pull requests (opened/updated/reopened).
  - Gated by metrics endpoint reachability; skips gracefully if `METRICS_URL` not set or unreachable.
  - Fails PR if `overall_status != pass`.

## Required Secrets

 - `METRICS_URL`: e.g., `https://staging.example.com/metrics/prom`.
 - `METRICS_AUTH_HEADER` (optional): e.g., `Authorization: Bearer <token>`.
 - `SLACK_WEBHOOK_URL` (optional for nightly failures / success enrichment).
 - `SLACK_CHANNEL` (optional): e.g., `alerts`.
 - `GRAFANA_API_TOKEN` (ops deploy only, for dashboard upload).
 - `REDIS_URL` (optional: enables Redis-backed cache validation).

## Manual Dispatch (Nightly)

1. Actions → Phase 5 Nightly Validation (Regression) → Run workflow.
2. Optionally set `metrics_url` input to override secret.
3. Artifacts: `/tmp/phase5.json`, `/tmp/phase5.md`, `/tmp/regression.txt`.
4. Success: PR `chore/phase5-nightly-YYYYMMDD` contains JSON & weekly trend.

## Weekly Trend & Baseline Rotation
- Weekly trend: `claudedocs/PHASE5_WEEKLY_TREND.md` (last 7 nightly runs; includes Redis GET/SET p95 & recent failure flag).
- Baseline rotation workflow (`phase5-baseline-rotation.yml`) triggers after ≥14 consecutive PASS nightly JSONs.
- Manual baseline refresh (after enabling Redis or performance shift):
  ```bash
  API_BASE=https://env METRICS_URL=https://env/metrics/prom CACHE_IMPL=redis REDIS_URL=redis://host:6379 bash scripts/phase5-run-all.sh
  bash scripts/phase5-save-baseline.sh /tmp/phase5.json baseline
  ```

## Redis Observability & Regression
- Metrics: `redis_operation_duration_seconds{op}`, `redis_recovery_attempts_total{result}`, `redis_last_failure_timestamp`.
- Recording rules: `metasheet:redis_get_p95:5m`, `metasheet:redis_set_p95:5m` (p99 optional).
- Regression script absolute thresholds (override via env):
  - `REDIS_GET_P95_MAX` (0.05s), `REDIS_GET_P99_MAX` (0.10s), `REDIS_SET_P95_MAX` (0.05s), `REDIS_SET_P99_MAX` (0.10s)
- Slack enrichment includes Redis latency & failure details.

## Internal Routes Security
- `/internal/*` hidden in production; returns 404.
- Non-prod optional token: set `INTERNAL_API_TOKEN` (require `x-internal-token` or `?token=`).
- Rate limit: `INTERNAL_RATE_LIMIT_MAX` (default 120), `INTERNAL_RATE_LIMIT_WINDOW_MS` (default 60000); disable by setting MAX ≤0.

## Cache Audit & SLO Suggestions (Optional)
- Cache audit (`scripts/phase5-cache-audit.sh`) adds top miss patterns to nightly success Slack message.
- Future SLO tightening script (`scripts/phase5-slo-tighten-suggestions.sh`) will propose reduced latency thresholds after sustained improvement.

## Quick Command Reference
```bash
# Full local validation (memory)
API_BASE=http://127.0.0.1:8901 METRICS_URL=http://127.0.0.1:8901/metrics/prom bash scripts/phase5-run-all.sh

# Redis local run
PORT=8901 FEATURE_CACHE=true CACHE_IMPL=redis REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @metasheet/core-backend dev

# Save baseline after successful validation
bash scripts/phase5-save-baseline.sh /tmp/phase5.json baseline

# Regression check (override absolute Redis thresholds)
REDIS_GET_P95_MAX=0.08 REDIS_SET_P95_MAX=0.08 bash scripts/phase5-regression-check.sh baseline/phase5-baseline.json /tmp/phase5.json
```

## Notes

- If the metrics endpoint is unreachable or not configured, runs are marked as skipped and do not block PRs.
- If the endpoint requires auth, set `METRICS_AUTH_HEADER` (full header string).
- Validation scripts expect a Prometheus exposition at the given URL.
- `phase5-ops-deploy.yml`
  - Manual dispatch for Prometheus rule + Grafana dashboard deployment.
  - Restricted to `main` branch.
  - Input `dry_run=true` cannot be combined with deploy flags (hard fail guard).
