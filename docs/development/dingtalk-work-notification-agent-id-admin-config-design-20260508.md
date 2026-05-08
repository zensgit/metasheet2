# DingTalk Work Notification Agent ID Admin Config Design (2026-05-08)

## Goal

Let a system administrator configure and validate the DingTalk work-notification Agent ID from the MetaSheet admin UI instead of editing deployment env files by hand.

This closes the remaining Agent ID gap for DingTalk work notifications:

- Group robot webhooks are still configured on notification rules.
- Enterprise work notifications still require app key, app secret, and Agent ID from the same DingTalk internal app.
- App key and app secret may come from env or the selected DingTalk directory integration.
- Agent ID may now come from env or encrypted `directory_integrations.config.workNotificationAgentId`.

## User Flow

1. Open the DingTalk directory management page as a system administrator.
2. Select the active DingTalk directory integration.
3. Fill "工作通知 Agent ID".
4. Optionally fill a DingTalk user id as the test recipient.
5. Click "测试工作通知".
6. Click "保存 Agent ID" after validation passes.

If no test recipient is supplied, the test verifies app credential access-token retrieval and local Agent ID shape only. If a test recipient is supplied, it also sends a real DingTalk work notification through the configured app.

## Backend Contract

Admin-only routes under `/api/admin/directory`:

- `GET /dingtalk/work-notification`: returns redaction-safe runtime readiness for the selected or latest DingTalk directory integration.
- `POST /dingtalk/work-notification/test`: validates a candidate Agent ID and optionally sends a real test work notification.
- `PUT /dingtalk/work-notification`: validates the candidate Agent ID and persists it encrypted into the selected integration config.

The persisted value is never returned in API responses. Responses expose only configured state, length, source, selected key name, and whether the value was persisted.

## Runtime Resolution

Runtime config resolution is intentionally conservative:

1. If env contains complete `DINGTALK_APP_KEY` or `DINGTALK_CLIENT_ID`, `DINGTALK_APP_SECRET` or `DINGTALK_CLIENT_SECRET`, and `DINGTALK_AGENT_ID` or `DINGTALK_NOTIFY_AGENT_ID`, the runtime uses env only and does not query the database.
2. If env is incomplete, the runtime falls back to the active/latest DingTalk directory integration config.
3. Mixed config is allowed, for example env app key/secret plus DB-stored Agent ID.
4. If any required part is still missing, work notification remains unavailable and surfaces a redaction-safe missing reason.

This preserves existing deployment behavior while allowing 142 to become ready without a backend env edit after the new image is deployed.

## Frontend Boundary

The Agent ID field is shown in the existing DingTalk directory management page:

- The input uses password mode and is never prefilled from stored config.
- The input is shown only after a DingTalk integration has been created and selected.
- The page shows only `Agent ID 已保存` or `Agent ID 未保存`.
- The normal directory integration save path does not accept, resend, overwrite, or clear the Agent ID.
- Dedicated test and save buttons call the new admin routes.

## Automation Impact

Automation delivery now reads DingTalk work-notification config from runtime resolution instead of env-only config. This affects:

- Person work-notification delivery.
- Group robot failure-alert fallback that notifies the rule creator by work notification.
- Admin user DingTalk access status, which now reflects DB-stored Agent ID readiness.

## Release Gate Impact

The DingTalk work-notification release gate remains read-only. It now accepts a pass when:

- The env status helper reports missing Agent ID, but
- The backend admin API reports work notification runtime is available from stored config.

The summary records `runtimeStatusOverridesEnvStatus=true` in that case. Credential values are still redacted.

## Security Notes

- No raw Agent ID, app secret, webhook, robot signing secret, JWT, or DingTalk access token is written to API responses, logs, docs, or summaries.
- Stored Agent ID uses the existing encrypted-secret normalization path.
- Save actions emit an audit event with only redacted metadata.
- Admin APIs require the existing admin auth middleware.

## 142 Deployment Notes

The frontend configuration page exists only after deploying a backend/web image that includes this change.

After deployment to 142:

1. Open the admin DingTalk directory management page.
2. Select the DingTalk integration.
3. Enter the real Agent ID from the DingTalk internal app that owns the configured app key/app secret.
4. Run the UI test. Use a recipient DingTalk user id if a real work-notification send must be proven.
5. Save the Agent ID.
6. Rerun the DingTalk work-notification release gate.

The older private-file env helper remains a fallback for operations teams that prefer env-only deployment, but it is no longer the only path.
