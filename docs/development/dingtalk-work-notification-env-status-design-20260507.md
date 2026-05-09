# DingTalk Work Notification Env Status Design

Date: 2026-05-07

## Background

The 142 closeout proved that DingTalk group robot failures are audited and that
creator failure alerts are attempted by default. The remaining blocker was
environmental: backend work-notification envs were missing, so the creator alert
was correctly audited as `failed` instead of being delivered as a DingTalk work
notification.

Before this change, operators had to SSH into 142 and inspect env state manually.
That was too fragile for handoff because the admin UI only showed DingTalk OAuth
login readiness, not work-notification readiness.

## Goals

- Show whether DingTalk work notifications are configured without exposing
  secret values.
- Reuse the same env precedence as the backend runtime:
  - `DINGTALK_APP_KEY` or `DINGTALK_CLIENT_ID`
  - `DINGTALK_APP_SECRET` or `DINGTALK_CLIENT_SECRET`
  - `DINGTALK_AGENT_ID` or `DINGTALK_NOTIFY_AGENT_ID`
- Make the state visible in the existing user management DingTalk panel.
- Provide a repeatable CLI helper for 142/server-side checks.
- Update env validation so partial DingTalk work-notification config fails fast.

## Implemented Design

### Backend Runtime Status

`packages/core-backend/src/integrations/dingtalk/client.ts` now exports
`getDingTalkWorkNotificationRuntimeStatus()`.

The function returns only redaction-safe booleans and selected key names:

- `configured`
- `available`
- `unavailableReason`
- `requirements.appKey.configured`
- `requirements.appSecret.configured`
- `requirements.agentId.configured`
- selected key names such as `DINGTALK_APP_KEY`, never values

`packages/core-backend/src/routes/admin-users.ts` adds that status into the
existing `/api/admin/users/:userId/dingtalk-access` payload as
`workNotification`. This avoids adding another frontend request and keeps
diagnostics near the user DingTalk controls.

### Frontend Admin UI

`apps/web/src/views/UserManagementView.vue` now shows a work-notification badge
group in the DingTalk panel:

- overall `工作通知已配置` / `工作通知未配置完整`
- `App Key`
- `App Secret`
- `Agent ID`
- a human-readable missing-env hint

The copy is deliberately operational: it tells admins which env family is
missing without ever showing credential values.

### CLI Helper

`scripts/ops/dingtalk-work-notification-env-status.mjs` checks env readiness
from one or more `--env-file` inputs plus `process.env`.

It writes:

- redaction-safe JSON summary
- redaction-safe Markdown summary
- `ready` / `blocked` status
- next actions for rerunning the creator-alert probe with
  `--expect-person-status success`

It also supports `--write-env-template <file>` to create a safe fill-in template.

### Env Validation

`scripts/validate-env.sh` now treats DingTalk app key/secret/agent id as one
work-notification group. If any DingTalk app/work-notification env is present,
it requires all three required families.

`.env.example` now documents `DINGTALK_NOTIFY_AGENT_ID` as the legacy alias for
`DINGTALK_AGENT_ID`.

## Security Notes

- No endpoint returns app key, app secret, agent id, webhook URL, robot token, SEC
  secret, or JWT.
- The helper outputs only presence, selected key name, source path, and value
  length.
- The frontend displays only status and missing key families.
- Filled env templates should remain outside Git.

## Operational Flow

1. Put real DingTalk work-notification values in the backend env on 142.
2. Restart `metasheet-backend`.
3. Run:

```bash
node scripts/ops/dingtalk-work-notification-env-status.mjs \
  --env-file docker/app.env \
  --allow-blocked
```

4. Confirm the summary status is `ready`.
5. Trigger a fresh controlled group robot failure.
6. Rerun the failure-alert probe with `--expect-person-status success`.
