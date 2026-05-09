# GitHub Actions Runtime Readiness Design

Date: 2026-05-05
Branch: `codex/dingtalk-alertmanager-readiness-20260505`

## Problem

Two runtime gates now matter for the current internal-trial path:

1. K3 WISE deploy smoke must be able to run authenticated checks automatically.
2. DingTalk OAuth Stability Recording must be able to self-heal the on-prem
   Alertmanager webhook before it runs the remote health check.

The implementation already supports both gates, but a missing GitHub
configuration value makes failures look like workflow or app regressions. The
latest DingTalk scheduled run showed that shape exactly:

- backend health: ok
- Alertmanager notify errors: 0
- root filesystem usage: below gate
- Alertmanager webhook: not configured
- GitHub webhook secret available to self-heal: false

## Change

Add `scripts/ops/github-actions-runtime-readiness.mjs`.

The script reads GitHub Actions configuration metadata and emits a redacted
readiness report. It never reads or prints secret values; it only consumes the
secret names returned by `gh secret list`.

It checks:

- DingTalk stability deploy secrets:
  - `DEPLOY_HOST`
  - `DEPLOY_USER`
  - `DEPLOY_SSH_KEY_B64`
- DingTalk Alertmanager webhook self-heal secret, accepting one of:
  - `ALERTMANAGER_WEBHOOK_URL`
  - `ALERT_WEBHOOK_URL`
  - `SLACK_WEBHOOK_URL`
  - `ATTENDANCE_ALERT_SLACK_WEBHOOK_URL`
- K3 WISE deploy auth gate variables:
  - `METASHEET_TENANT_ID`
  - `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true`

## CLI

```bash
node scripts/ops/github-actions-runtime-readiness.mjs --repo zensgit/metasheet2
node scripts/ops/github-actions-runtime-readiness.mjs --repo zensgit/metasheet2 --format markdown
node scripts/ops/github-actions-runtime-readiness.mjs --repo zensgit/metasheet2 --format json --strict
```

Fixture mode keeps the logic testable without calling GitHub:

```bash
node scripts/ops/github-actions-runtime-readiness.mjs \
  --secrets-json /path/to/secrets.json \
  --variables-json /path/to/variables.json \
  --format json \
  --strict
```

## Operational Decision

K3 WISE did not need another code change. The deploy workflow already supports
an authenticated hard gate. This round set the repository variable:

```text
K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true
```

That means future automatic deploys will require K3 authenticated smoke evidence
instead of silently accepting public-only evidence.

DingTalk still needs one supported webhook secret configured in GitHub Actions.
Until then the scheduled workflow should remain red because the on-prem
Alertmanager webhook cannot be self-healed from GitHub.
