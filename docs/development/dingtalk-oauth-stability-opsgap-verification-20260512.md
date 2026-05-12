# DingTalk OAuth Stability Ops Gap - Verification

- Date: 2026-05-12
- Scope: scheduled `DingTalk OAuth Stability Recording (Lite)` failure classification.
- Result: PASS for diagnosis; unresolved ops input remains.

## Commands

```bash
gh run view 25719530101 \
  --repo zensgit/metasheet2 \
  --json databaseId,headSha,event,workflowName,status,conclusion,createdAt,updatedAt,url,jobs

gh run view 25719530101 \
  --repo zensgit/metasheet2 \
  --log-failed

gh run list \
  --repo zensgit/metasheet2 \
  --workflow "DingTalk OAuth Stability Recording (Lite)" \
  --limit 10 \
  --json databaseId,headSha,event,status,conclusion,createdAt,url

gh secret list --repo zensgit/metasheet2 --json name,updatedAt

gh run download 25719530101 \
  --repo zensgit/metasheet2 \
  -D /tmp/dingtalk-oauth-lite-25719530101

node --test scripts/ops/dingtalk-oauth-stability-workflow-contract.test.mjs
node --test scripts/ops/github-dingtalk-oauth-stability-summary.test.mjs
node --test scripts/ops/set-dingtalk-alertmanager-webhook-secret.test.mjs
bash -n scripts/ops/dingtalk-oauth-stability-check.sh
bash -n scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh
python3 -m py_compile scripts/ops/github-dingtalk-oauth-stability-summary.py
git diff --check
```

## Observed Workflow Result

```text
workflow: DingTalk OAuth Stability Recording (Lite)
run: 25719530101
event: schedule
headSha: e1677fd4d84dbf8f81ff353a7191e082fa5ec31d
status: completed
conclusion: failure
job: stability-record
failed step: Fail if stability check is unhealthy
```

Failed-step log:

```text
STABILITY_RC: 0
HEALTHY: false
stability check completed but reported healthy=false
```

Downloaded artifact summary:

```text
Overall: FAIL
Stability rc: 0
Healthy: false
Webhook self-heal secret available: false
Health: status=ok plugins=13 ok=True
Webhook: configured=False host=
Alertmanager: activeAlerts=0 notifyErrors=0
Storage: rootUse=91% availKBlocks=7128380 maxUse=95%
Failure reason: Alertmanager webhook is not configured
Failure reason: No supported GitHub webhook secret was available for Alertmanager self-heal
```

## Secret Name Inspection

Supported webhook secret names checked:

| Secret name | Status |
| --- | --- |
| `ALERTMANAGER_WEBHOOK_URL` | missing |
| `ALERT_WEBHOOK_URL` | missing |
| `SLACK_WEBHOOK_URL` | missing |
| `ATTENDANCE_ALERT_SLACK_WEBHOOK_URL` | missing |

Only secret names were inspected. No secret values were read or printed.

## Trend

The last 10 scheduled `DingTalk OAuth Stability Recording (Lite)` runs were all failures. They span multiple main SHAs, including runs before and after the K3 package docs merge, so this is not attributable to the docs-only PR #1480.

## Local Contract Checks

| Check | Result |
| --- | --- |
| OAuth stability workflow contract test | PASS |
| OAuth stability summary renderer test | PASS |
| Alertmanager webhook secret setter test | PASS |
| `dingtalk-oauth-stability-check.sh` syntax | PASS |
| `set-dingtalk-onprem-alertmanager-webhook-config.sh` syntax | PASS |
| `github-dingtalk-oauth-stability-summary.py` compile | PASS |
| Whitespace diff check | PASS |

## Classification

This is a persistent ops configuration blocker for the scheduled monitor:

- application health is OK;
- Alertmanager has no active alerts and no notify errors;
- the stability command exits successfully;
- the hard gate fails because the webhook is unconfigured and no supported GitHub secret exists for self-heal.

## Remaining Action

Configure one supported GitHub Actions webhook secret, trigger `DingTalk OAuth Stability Recording (Lite)` manually, and require a new run with `HEALTHY=true`.

Until that is done, deploy gates can be treated as passing, but the scheduled OAuth stability monitor must remain explicitly listed as a non-blocking ops follow-up rather than described as green.
