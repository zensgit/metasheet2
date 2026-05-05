# GitHub Actions Runtime Readiness Verification

Date: 2026-05-05
Branch: `codex/dingtalk-alertmanager-readiness-20260505`

## Static and Unit Verification

```bash
node --test scripts/ops/github-actions-runtime-readiness.test.mjs
```

Result:

```text
pass 4
fail 0
```

Coverage:

- readiness passes when deploy secrets, a supported webhook secret, and K3
  variables are configured.
- readiness fails with a direct next action when no webhook self-heal secret is
  configured.
- readiness fails when `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH` is missing or false.
- fixture mode does not leak accidental secret values into JSON output.

## Live GitHub Configuration Readiness

Command:

```bash
node scripts/ops/github-actions-runtime-readiness.mjs \
  --repo zensgit/metasheet2 \
  --format markdown \
  --output /private/tmp/ms2-github-actions-runtime-readiness-20260505.md
```

Observed summary:

```text
Overall: FAIL
dingtalkDeploySecrets: PASS
dingtalkWebhookSelfHeal: FAIL
k3DeployAuthGate: PASS
```

Meaning:

- `DEPLOY_HOST`, `DEPLOY_USER`, and `DEPLOY_SSH_KEY_B64` are present.
- `METASHEET_TENANT_ID` is present.
- `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true` is present.
- None of the supported Alertmanager webhook secrets are present:
  `ALERTMANAGER_WEBHOOK_URL`, `ALERT_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`, or
  `ATTENDANCE_ALERT_SLACK_WEBHOOK_URL`.

## Latest Failing DingTalk Artifact

Downloaded artifact:

```text
run: 25347288854
workflow: DingTalk OAuth Stability Recording (Lite)
summary: /private/tmp/ms2-dingtalk-stability-25347288854/dingtalk-oauth-stability-recording-lite-25347288854-1/summary.md
```

Relevant artifact facts:

```text
Overall: FAIL
Stability rc: 0
Healthy: false
Webhook self-heal secret available: false
Health: status=ok plugins=13 ok=True
Webhook: configured=False host=
Alertmanager: activeAlerts=0 notifyErrors=0
Storage: rootUse=50% maxUse=95%
```

Failure reasons:

```text
Alertmanager webhook is not configured
No supported GitHub webhook secret was available for Alertmanager self-heal
```

## K3 Deploy Gate Configuration

Command:

```bash
gh variable set K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH \
  --repo zensgit/metasheet2 \
  --body true
```

Verification:

```text
K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH true 2026-05-05T00:16:44Z
METASHEET_TENANT_ID default 2026-04-30T09:11:56Z
```

## Remaining Live Action

Configure one GitHub Actions secret for DingTalk Alertmanager self-heal:

```text
ALERTMANAGER_WEBHOOK_URL
```

The compatible fallback names are:

```text
ALERT_WEBHOOK_URL
SLACK_WEBHOOK_URL
ATTENDANCE_ALERT_SLACK_WEBHOOK_URL
```

Do not put the webhook URL into tracked docs or chat output.
