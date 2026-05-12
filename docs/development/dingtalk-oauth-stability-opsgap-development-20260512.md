# DingTalk OAuth Stability Ops Gap - Development

- Date: 2026-05-12
- Scope: scheduled `DingTalk OAuth Stability Recording (Lite)` health monitor.
- Current main SHA inspected: `3ce51240190ba7e6b6af72e851b9b527f2b1f79e`
- Latest failed run analyzed: `25719530101`
- Run URL: `https://github.com/zensgit/metasheet2/actions/runs/25719530101`

## Purpose

Record the post-merge status of the scheduled DingTalk OAuth stability monitor and separate it from product/runtime delivery state.

The K3 WISE package docs PR #1480 merged cleanly and the normal deploy gates passed. The remaining red workflow is the scheduled `DingTalk OAuth Stability Recording (Lite)` job. Its failure is an ops configuration gap, not a code regression from #1480, #1478, or the DingTalk runtime closeout.

## Current Finding

The workflow reached the remote host and completed the stability command:

```text
STABILITY_RC=0
HEALTHY=false
```

The downloaded summary artifact reported:

```text
Health: status=ok plugins=13 ok=True
Webhook: configured=False
Alertmanager: activeAlerts=0 notifyErrors=0
Storage: rootUse=91% maxUse=95%
Failure reason: Alertmanager webhook is not configured
Failure reason: No supported GitHub webhook secret was available for Alertmanager self-heal
```

The last 10 scheduled `DingTalk OAuth Stability Recording (Lite)` runs were all failures, across multiple SHAs. That makes this a persistent monitor configuration issue rather than a newly introduced runtime failure.

## Required Ops Inputs

One of the supported GitHub Actions secrets must be configured:

- `ALERTMANAGER_WEBHOOK_URL`
- `ALERT_WEBHOOK_URL`
- `SLACK_WEBHOOK_URL`
- `ATTENDANCE_ALERT_SLACK_WEBHOOK_URL`

Current repo secret-name inspection found all four missing. Secret values are not readable from GitHub and were not printed or recorded.

## Closure Procedure

1. Prepare the Alertmanager webhook URL in a local environment variable or stdin. Do not paste it into chat or tracked files.
2. Validate or set one supported GitHub Actions secret with:

```bash
printf '%s' "$ALERTMANAGER_WEBHOOK_URL" | \
  node scripts/ops/set-dingtalk-alertmanager-webhook-secret.mjs \
    --repo zensgit/metasheet2 \
    --name ALERTMANAGER_WEBHOOK_URL \
    --stdin
```

3. Re-run the scheduled monitor manually:

```bash
gh workflow run "DingTalk OAuth Stability Recording (Lite)" \
  --repo zensgit/metasheet2 \
  --ref main
```

4. Confirm the new run reports:

```text
STABILITY_RC=0
HEALTHY=true
Webhook: configured=True
```

5. If `HEALTHY=false` remains after the secret is present, inspect Alertmanager and bridge logs before changing application code.

## Security Notes

- This document records only secret names and redacted status.
- It does not include webhook values, JWTs, bearer tokens, app secrets, temporary passwords, or DingTalk robot secrets.
- The helper script validates supported secret names and webhook shape before writing to GitHub secrets.

## Non-Goals

- No runtime code changes.
- No deployment change.
- No attempt to bypass the hard `HEALTHY=true` workflow gate.
- No replacement of the existing monitor workflow.
