# DingTalk Alertmanager Webhook Secret Ops Design

Date: 2026-05-05
Branch: `codex/dingtalk-webhook-secret-ops-20260505`

## Problem

The latest manual workflow run on `main` confirmed the runtime failure is not a
DingTalk OAuth app regression:

```text
run: 25352338855
head: 390a95ff16eb1b02cf3a5f938e7bbcba0e7e524c
backend health: ok
Alertmanager notify errors: 0
root filesystem: below gate
webhookConfig.configured: false
webhook self-heal secret available: false
```

Without a real Slack webhook URL, code cannot self-heal the remote
Alertmanager config. The remaining useful work is to make the operator path
safe and repeatable.

## Change

Add `scripts/ops/set-dingtalk-alertmanager-webhook-secret.mjs`.

Properties:

- accepts only the secret names consumed by
  `dingtalk-oauth-stability-recording-lite.yml`;
- reads the webhook URL from stdin or an environment variable;
- validates that the value is an HTTPS Slack incoming webhook under
  `hooks.slack.com`, matching the stability gate;
- writes the GitHub Actions repository secret through `gh secret set` via stdin;
- prints only redacted metadata: secret name, repo, host, and path length.

Also update `scripts/observe-24h.sh` so startup logs no longer print the
`ALERT_WEBHOOK_URL` value. It now prints only `configured` or `disabled`.

## Non-Goals

- Do not store webhook URLs in tracked docs.
- Do not make the stability workflow pass when the webhook is missing.
- Do not accept DingTalk webhook URLs for this Alertmanager gate; the current
  health check explicitly expects `hooks.slack.com`.

## Operator Flow

```bash
printf '%s' "$ALERTMANAGER_WEBHOOK_URL" \
  | node scripts/ops/set-dingtalk-alertmanager-webhook-secret.mjs \
      --repo zensgit/metasheet2 \
      --stdin

node scripts/ops/github-actions-runtime-readiness.mjs \
  --repo zensgit/metasheet2 \
  --strict

gh workflow run dingtalk-oauth-stability-recording-lite.yml \
  --repo zensgit/metasheet2 \
  --ref main
```

The first successful scheduled or manual workflow after the secret is configured
will reapply the remote `alertmanager.onprem.env` file and then run the same
stability checks.
