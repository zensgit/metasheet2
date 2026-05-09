# DingTalk Alertmanager Webhook Secret Ops Verification

Date: 2026-05-05
Branch: `codex/dingtalk-webhook-secret-ops-20260505`

## Live Workflow Test

Manual run:

```text
run: 25352338855
workflow: DingTalk OAuth Stability Recording (Lite)
event: workflow_dispatch
head: 390a95ff16eb1b02cf3a5f938e7bbcba0e7e524c
url: https://github.com/zensgit/metasheet2/actions/runs/25352338855
```

Result:

```text
conclusion: failure
failed step: Fail if stability check is unhealthy
```

Artifact summary:

```text
Overall: FAIL
Stability rc: 0
Healthy: false
Webhook self-heal secret available: false
Health: status=ok plugins=13 ok=True
Webhook: configured=False host=
Alertmanager: activeAlerts=0 notifyErrors=0
Storage: rootUse=52% maxUse=95%
```

Failure reasons:

```text
Alertmanager webhook is not configured
No supported GitHub webhook secret was available for Alertmanager self-heal
```

## Current Runtime Readiness

Command:

```bash
node scripts/ops/github-actions-runtime-readiness.mjs \
  --repo zensgit/metasheet2 \
  --format markdown
```

Observed:

```text
dingtalkDeploySecrets: PASS
dingtalkWebhookSelfHeal: FAIL
k3DeployAuthGate: PASS
```

Meaning:

- deploy SSH configuration exists;
- K3 automatic deploy authenticated smoke gating is enabled;
- no supported webhook secret is present yet.

## Unit Verification

```bash
node --test \
  scripts/ops/set-dingtalk-alertmanager-webhook-secret.test.mjs \
  scripts/ops/github-actions-runtime-readiness.test.mjs
```

Expected coverage:

- supported secret names are accepted;
- unsupported DingTalk webhook secret name is rejected for this Slack-hosted
  Alertmanager gate;
- non-`hooks.slack.com` URLs are rejected;
- dry-run output does not leak the webhook path or secret suffix.

## Redaction Check

`scripts/observe-24h.sh` startup output now prints:

```text
Webhook: configured
```

or:

```text
Webhook: disabled
```

It no longer prints the actual `ALERT_WEBHOOK_URL`.
