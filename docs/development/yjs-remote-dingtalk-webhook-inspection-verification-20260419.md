# Yjs Remote DingTalk Webhook Inspection Verification

Date: 2026-04-19

## Verification Method

Verification focused on confirming whether a usable DingTalk outbound webhook
was actually present on the remote rollout host.

## Commands Run

```bash
ssh metasheet-142 'cd ~/metasheet2 && git rev-parse HEAD && git branch --show-current && git status --short'
ssh metasheet-142 'cd ~/metasheet2 && docker compose -f docker-compose.app.yml ps --format json'
ssh metasheet-142 "cd ~/metasheet2 && (grep -nE 'DINGTALK|WEBHOOK|ALERT' .env docker/app.env docker-compose.app.yml docker-compose.yml 2>/dev/null || true)"
ssh metasheet-142 "cd ~/metasheet2 && docker compose -f docker-compose.app.yml exec -T backend /bin/sh -lc 'printenv | grep -E \"DINGTALK|WEBHOOK|ALERT\" || true'"
ssh metasheet-142 "cd ~/metasheet2 && docker compose -f docker-compose.app.yml exec -T postgres psql -U metasheet -d metasheet -Atc \"SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name ILIKE '%notification%' OR table_name ILIKE '%dingtalk%' OR table_name ILIKE '%webhook%') ORDER BY table_name;\""
ssh metasheet-142 "cd ~/metasheet2 && docker compose -f docker-compose.app.yml exec -T postgres psql -U metasheet -d metasheet -Atc \"SELECT 'plugin_notification_history=' || count(*) FROM plugin_notification_history; SELECT 'plugin_notification_subscriptions=' || count(*) FROM plugin_notification_subscriptions;\""
ssh metasheet-142 "cd ~/metasheet2 && docker compose -f docker-compose.app.yml logs --since 168h backend | grep -iE 'dingtalk|notification.*send|webhook/group recipients|DingTalk notification' | tail -n 100 || true"
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh --print-status
sed -n '320,380p' packages/core-backend/src/services/NotificationService.ts
rg -n "groupRecipients|webhookRecipients|channel: 'dingtalk'|DingTalk notification requires" packages/core-backend -g '!**/node_modules/**'
```

## Results

- remote git checkout:
  - branch: `main`
  - head: `30604239b1a09864909893625e5cd2c407987c10`
- running containers:
  - backend image tag matches `30604239b1a09864909893625e5cd2c407987c10`
  - web image tag matches `30604239b1a09864909893625e5cd2c407987c10`
- remote env:
  - DingTalk OAuth/login settings are present
  - no dedicated outbound DingTalk webhook variable was found
- PostgreSQL tables present:
  - `plugin_notification_history`
  - `plugin_notification_subscriptions`
  - `multitable_webhooks`
  - `multitable_webhook_deliveries`
- PostgreSQL counts:
  - `plugin_notification_history=0`
  - `plugin_notification_subscriptions=0`
- backend log signal:
  - DingTalk notification channel registration is present
  - no evidence of real DingTalk notification delivery was found
- source code signal:
  - DingTalk send path requires `webhook` or `group` recipients
  - OAuth/login configuration alone is not used as a delivery target
- Alertmanager webhook status:
  - `configured=false`

## Conclusion

The remote host is synchronized and Yjs-ready, but it does not currently have a
usable DingTalk robot webhook / group recipient binding for sending the human
trial message automatically.
