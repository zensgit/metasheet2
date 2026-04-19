# Yjs Remote DingTalk Webhook Inspection Development

Date: 2026-04-19

## Scope

This slice verifies whether the remote production-like host already has a
usable DingTalk webhook binding for sending the Yjs human trial notice.

Host inspected:

- `mainuser@142.171.239.56`

## Why This Inspection Was Needed

The rollout line is ready for human collaborative validation, and the next
operational step is notifying trial participants.

Before attempting to send a DingTalk group message directly, we needed to
separate three different possibilities:

1. DingTalk OAuth is configured for user login.
2. The application has a DingTalk notification channel registered.
3. A real DingTalk robot webhook / group recipient is already bound and usable
   for outbound notifications.

Only the third case is sufficient for sending the trial message.

## Inspection Performed

Checked on the remote host:

- app env / compose env for DingTalk and webhook-related variables
- backend container runtime env
- current git checkout and running image revision
- PostgreSQL notification-related tables
- plugin notification history / subscription counts
- backend logs for DingTalk notification sends
- on-prem Alertmanager webhook status
- local source code path that actually sends DingTalk notifications

## Findings

### 1. Remote code and runtime are already synced

- remote checkout is on `main`
- remote checkout `HEAD` is `30604239b1a09864909893625e5cd2c407987c10`
- running backend/web containers also use image tag
  `30604239b1a09864909893625e5cd2c407987c10`

So there is no remaining code-sync gap.

### 2. DingTalk OAuth is configured

The remote env clearly has DingTalk OAuth/login settings enabled.

This confirms:

- DingTalk login / directory integration is configured
- but this alone does not imply a robot webhook exists

### 3. The app-level DingTalk notification channel exists but is not bound

Observed:

- backend logs show `Registered notification channel: dingtalk`
- `NotificationService` supports DingTalk robot sends only when recipients are
  `webhook` or `group`
- there is no code path that converts DingTalk OAuth/login settings into a
  message recipient automatically

But the remote app data currently shows:

- `plugin_notification_history=0`
- `plugin_notification_subscriptions=0`
- `plugin_configs` row count = `0`

That means there is no evidence of:

- a saved DingTalk group recipient
- a stored DingTalk robot webhook config in app-managed plugin config
- any previously sent DingTalk notification from the current app runtime

### 4. On-prem Alertmanager webhook is also not configured

`scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh --print-status`
returned:

- `configured=false`

So there is also no separate ops-side Alertmanager webhook that could be reused
for this human trial notice.

## Outcome

The remote host currently has:

- DingTalk OAuth/login configuration: **yes**
- DingTalk notification channel registration: **yes**
- app-bound group/webhook recipient for outbound DingTalk messages: **no**
- Alertmanager-side webhook config: **no**

So the Yjs human trial notice cannot be sent automatically yet from the current
remote configuration without first providing a real DingTalk robot webhook or a
stored group recipient.
