# Phase 5 Validation Workflows

This folder contains GitHub Actions that validate Phase 5 SLOs against a Prometheus‑style metrics endpoint.

## Workflows

- `phase5-nightly.yml`
  - Triggers nightly at 02:00 UTC and via manual dispatch.
  - Pre‑checks metrics endpoint reachability; skips gracefully if unreachable.
  - Runs `scripts/phase5-full-validate.sh` and `scripts/phase5-generate-report.sh`.
  - Uploads `/tmp/phase5.json` and `/tmp/phase5.md` as artifacts.
  - Fails if `overall_status != pass` and optionally sends Slack notification.

- `phase5-validate.yml`
  - Runs on pull requests (opened/updated/reopened).
  - Uses the same pre‑check; gates PRs only when endpoint is reachable.
  - Uploads artifacts and fails PR if `overall_status != pass`.

## Required Secrets

- `METRICS_URL`: e.g., `https://staging.example.com/metrics/prom`.
- `METRICS_AUTH_HEADER` (optional): e.g., `Authorization: Bearer <token>`.
- `SLACK_WEBHOOK_URL` (optional for nightly failures).
- `SLACK_CHANNEL` (optional): e.g., `alerts`.
- `GRAFANA_API_TOKEN` (ops deploy only, for dashboard upload).

## Manual Dispatch (Nightly)

1. Go to Actions → Phase 5 Nightly Validation → Run workflow.
2. Optionally set `metrics_url` input to override the secret.
3. Artifacts: `/tmp/phase5.json`, `/tmp/phase5.md`, or `unreachable.txt` if skipped.

## Notes

- If the metrics endpoint is unreachable or not configured, runs are marked as skipped and do not block PRs.
- If the endpoint requires auth, set `METRICS_AUTH_HEADER` (full header string).
- Validation scripts expect a Prometheus exposition at the given URL.
- `phase5-ops-deploy.yml`
  - Manual dispatch for Prometheus rule + Grafana dashboard deployment.
  - Restricted to `main` branch.
  - Input `dry_run=true` cannot be combined with deploy flags (hard fail guard).
