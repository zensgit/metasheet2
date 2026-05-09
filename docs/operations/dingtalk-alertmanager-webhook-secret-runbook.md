# DingTalk Alertmanager Webhook Secret Runbook

Date: 2026-05-05

## Current Gate

`DingTalk OAuth Stability Recording (Lite)` is healthy only when:

- the backend health endpoint is ok;
- the on-prem Alertmanager webhook config is present;
- the webhook host is `hooks.slack.com`;
- Alertmanager has no notify errors in the current log window;
- the remote root filesystem is below the configured usage gate.

If the workflow reports `No supported GitHub webhook secret was available for
Alertmanager self-heal`, code cannot infer or recreate the webhook URL. A real
Slack incoming webhook URL must be provided as a GitHub Actions repository
secret.

## Supported Secret Names

Preferred:

```text
ALERTMANAGER_WEBHOOK_URL
```

Compatible fallback names:

```text
ALERT_WEBHOOK_URL
SLACK_WEBHOOK_URL
ATTENDANCE_ALERT_SLACK_WEBHOOK_URL
```

`ATTENDANCE_ALERT_DINGTALK_WEBHOOK_URL` is not used by this stability workflow
because the current Alertmanager health gate expects `hooks.slack.com`.

## Safe CLI Setup

Do not paste webhook URLs into shell history or tracked docs.

Preferred stdin flow:

```bash
printf '%s' "$ALERTMANAGER_WEBHOOK_URL" \
  | node scripts/ops/set-dingtalk-alertmanager-webhook-secret.mjs \
      --repo zensgit/metasheet2 \
      --stdin
```

Environment-variable flow:

```bash
node scripts/ops/set-dingtalk-alertmanager-webhook-secret.mjs \
  --repo zensgit/metasheet2 \
  --from-env ALERTMANAGER_WEBHOOK_URL
```

Validation-only rehearsal:

```bash
printf '%s' "$ALERTMANAGER_WEBHOOK_URL" \
  | node scripts/ops/set-dingtalk-alertmanager-webhook-secret.mjs \
      --repo zensgit/metasheet2 \
      --stdin \
      --dry-run
```

The script prints only the secret name, repository, host, and path length. It
does not print the webhook path or full URL.

## After Setting the Secret

1. Verify repository configuration:

   ```bash
   node scripts/ops/github-actions-runtime-readiness.mjs \
     --repo zensgit/metasheet2 \
     --strict
   ```

2. Trigger the recording workflow:

   ```bash
   gh workflow run dingtalk-oauth-stability-recording-lite.yml \
     --repo zensgit/metasheet2 \
     --ref main
   ```

3. Check the artifact summary. Expected transition:

   ```text
   Webhook self-heal secret available: true
   Webhook: configured=True host=hooks.slack.com
   Overall: PASS
   ```

If the secret is present but the workflow still fails, inspect the artifact
failure reasons before retrying. Do not rotate the secret unless the artifact
indicates host drift or notify errors after self-heal.
