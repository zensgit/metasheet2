# DingTalk OAuth Stability Webhook Self-Heal Design

## Context

The scheduled `DingTalk OAuth Stability Recording (Lite)` workflow failed on
`main@5ddd8ebbe` even though the remote stability command returned `rc=0`.
The uploaded summary reported:

- backend health was ok;
- Alertmanager had no active alerts and no notify errors;
- root disk usage was below the gate;
- the only blocking reason was `Alertmanager webhook is not configured`.

The repository already has
`scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh`, which writes
the on-prem Alertmanager webhook env file through the deploy SSH key without
printing the secret. The workflow was only observing drift; it was not
attempting to reapply the persisted configuration before running the gate.

## Change

Add a pre-check self-heal step to
`.github/workflows/dingtalk-oauth-stability-recording-lite.yml`:

1. Restore the deploy SSH key as before.
2. If any supported webhook secret is available, call
   `scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh set` with:
   - `ALERTMANAGER_WEBHOOK_URL=${{ secrets.ALERTMANAGER_WEBHOOK_URL || secrets.ALERT_WEBHOOK_URL || secrets.SLACK_WEBHOOK_URL || secrets.ATTENDANCE_ALERT_SLACK_WEBHOOK_URL }}`
   - `SSH_USER_HOST=${DEPLOY_USER}@${DEPLOY_HOST}`
   - `SSH_KEY=${HOME}/.ssh/deploy_key`
3. If the secret is absent, emit a GitHub notice and continue to the existing
   health check.
4. Keep the final hard gate unchanged: the workflow still fails when the remote
   health report says `healthy=false`.

This turns the workflow from a passive drift detector into a safe drift repair
attempt, while keeping misconfiguration visible when the repository secret is
missing or invalid.

## Safety

- The webhook URL comes only from GitHub secrets. The workflow checks
  `ALERTMANAGER_WEBHOOK_URL`, `ALERT_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`, then
  `ATTENDANCE_ALERT_SLACK_WEBHOOK_URL`.
- The helper script validates that the value is an HTTP/HTTPS URL.
- The helper writes the remote env file via base64 and `install -m 600`.
- The workflow does not print the webhook URL.
- The failure gate is not weakened. If self-heal cannot make the deployment
  healthy, the run still fails and uploads the same artifacts.

## Non-Goals

- Does not create or rotate Slack webhooks.
- Does not commit any webhook value.
- Does not change the DingTalk OAuth health criteria.
- Does not make missing webhook secrets appear healthy.
