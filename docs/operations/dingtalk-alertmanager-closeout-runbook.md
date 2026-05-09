# DingTalk Alertmanager Closeout Runbook

Date: 2026-05-05

## Goal

Provide a single operator flow for closing the DingTalk Alertmanager stability
gate after a supported webhook secret is available.

The intended runner behavior is:

```text
readiness -> optional workflow trigger -> wait -> artifact download -> redacted summary
```

When no supported webhook secret is configured, the runner must stop at
readiness and print the next action. It must not trigger the workflow or poll
for an artifact that cannot become healthy.

## Prerequisites

- GitHub CLI is authenticated for `zensgit/metasheet2`.
- A supported Alertmanager webhook secret has been configured when closeout is
  expected to proceed past readiness.
- The webhook secret value is never pasted into tracked docs, command logs, or
  chat output.

Supported secret names:

```text
ALERTMANAGER_WEBHOOK_URL
ALERT_WEBHOOK_URL
SLACK_WEBHOOK_URL
ATTENDANCE_ALERT_SLACK_WEBHOOK_URL
```

Preferred secret name:

```text
ALERTMANAGER_WEBHOOK_URL
```

## One-Command Closeout

Closeout command after a supported webhook secret is configured:

```bash
node scripts/ops/dingtalk-alertmanager-closeout.mjs \
  --repo zensgit/metasheet2 \
  --workflow dingtalk-oauth-stability-recording-lite.yml \
  --ref main \
  --trigger \
  --wait \
  --timeout-seconds 900 \
  --format markdown \
  --output /private/tmp/ms2-dingtalk-alertmanager-closeout-summary.md
```

Expected phases:

1. Run GitHub Actions runtime readiness in strict mode.
2. If a supported webhook secret is missing, stop and print the exact action:
   configure `ALERTMANAGER_WEBHOOK_URL` or one compatible fallback secret.
3. If readiness passes, optionally trigger
   `dingtalk-oauth-stability-recording-lite.yml`.
4. Wait for the selected run to finish.
5. Download the DingTalk stability artifact.
6. Print and write a redacted closeout summary.

## No-Secret Behavior

If readiness reports no supported Alertmanager webhook secret, the runner should
exit without triggering a workflow.

Expected summary shape:

```text
Overall: BLOCKED
Readiness: FAIL
Webhook self-heal secret available: false
Action: configure ALERTMANAGER_WEBHOOK_URL for zensgit/metasheet2
Workflow triggered: false
Artifact downloaded: false
```

The summary may list supported secret names, but it must not contain secret
values or webhook paths.

## Secret-Present Behavior

If readiness passes, the runner may either use an existing run supplied by the
operator or trigger a new workflow run.

Expected summary shape:

```text
Overall: PASS|FAIL
Readiness: PASS
Workflow triggered: true|false
Workflow run: <run-id>
Artifact downloaded: true
Webhook self-heal secret available: true
Webhook: configured=<true|false> host=<redacted-or-safe-host>
Alertmanager: activeAlerts=<count> notifyErrors=<count>
Storage: rootUse=<percent> maxUse=<percent>
Failure reasons: <redacted list, if any>
```

Only safe metadata should be emitted. Do not print the webhook URL, secret
value, webhook path, authorization headers, cookies, or token-like fields.

## Operator Decision Points

- Use `--run-id <id>` when reviewing a known completed workflow artifact.
- Use `--trigger` when validating immediately after setting or rotating the
  webhook secret.
- Use a short wait timeout for interactive checks and a longer timeout for
  scheduled closeout runs.

## Completion Criteria

Closeout is complete when the redacted summary shows:

```text
Readiness: PASS
Webhook self-heal secret available: true
Artifact downloaded: true
Overall: PASS
```

If the artifact still fails after the secret is available, treat the artifact
failure reasons as the next diagnostic source. Do not rotate or expose the
secret unless the artifact specifically indicates webhook host drift or notify
delivery errors after self-heal.
