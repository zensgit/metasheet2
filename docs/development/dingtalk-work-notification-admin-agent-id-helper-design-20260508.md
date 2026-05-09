# DingTalk Work Notification Admin Agent ID Helper Design

Date: 2026-05-08

## Goal

Close the remaining DingTalk work-notification Agent ID setup gap without exposing secrets in chat, Git, or generated reports.

The helper verifies and optionally saves the DingTalk work-notification Agent ID through the admin API:

- Read current runtime status from `GET /api/admin/directory/dingtalk/work-notification`.
- Validate an Agent ID from a private file through `POST /api/admin/directory/dingtalk/work-notification/test`.
- Persist a validated Agent ID through `PUT /api/admin/directory/dingtalk/work-notification` when `--save` is supplied.
- Optionally include a private DingTalk recipient user id for a real work-notification send test.
- Write JSON and Markdown reports with token, Agent ID, and recipient values redacted.

## New Helper

Script:

```bash
node scripts/ops/dingtalk-work-notification-admin-agent-id.mjs
```

Primary modes:

```bash
# Status only, no Agent ID required.
node scripts/ops/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file /tmp/admin.jwt \
  --status-only \
  --output-json /tmp/dingtalk-agent/status.json \
  --output-md /tmp/dingtalk-agent/status.md

# Validate and save Agent ID from a private file.
node scripts/ops/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file /tmp/admin.jwt \
  --agent-id-file /home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt \
  --save \
  --output-json /tmp/dingtalk-agent/save.json \
  --output-md /tmp/dingtalk-agent/save.md

# Validate with real DingTalk delivery to a private recipient.
node scripts/ops/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file /tmp/admin.jwt \
  --agent-id-file /home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt \
  --recipient-user-id-file /home/mainuser/metasheet2/.secrets/dingtalk-test-user-id.txt \
  --save \
  --output-json /tmp/dingtalk-agent/real-send.json \
  --output-md /tmp/dingtalk-agent/real-send.md
```

## Security Rules

- Admin JWT should be delivered by file only and removed after use.
- Agent ID should be stored in a server-private file or saved through the admin page, not printed in chat.
- DingTalk recipient user id is optional and treated as sensitive operational data.
- Reports only include booleans, status codes, failure codes, configured state, and Agent ID length.
- The helper redacts bearer tokens, JWT-like strings, DingTalk robot tokens, `SEC...` values, exact Agent ID, and exact recipient id values.

## 142 Operational Path

Private file already expected on 142:

```bash
/home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt
```

Expected closeout sequence:

1. Ensure the main 8081/8900 stack runs an image containing the Agent ID admin API.
2. Fill the private Agent ID file on 142, or save it from the frontend directory-management page.
3. Run helper with `--status-only`.
4. Run helper with `--agent-id-file ... --save`.
5. If a real recipient file is available, run helper again with `--recipient-user-id-file ...`.
6. Confirm `available=true`, `configured=true`, `source=database`, and `agentId.valuePrinted=false`.

## TODO

- [x] Add redaction-safe admin helper.
- [x] Add node-level tests for status, save, empty file, recipient redaction, and API error redaction.
- [x] Smoke 142 current main stack without printing token or Agent ID.
- [ ] Coordinate the 142 main image tag so the deployed runtime includes `/api/admin/directory/dingtalk/work-notification`.
- [ ] Fill the real Agent ID private file or save it from the frontend admin page.
- [ ] Run real save validation and optional real DingTalk recipient send validation.
- [ ] Record final production acceptance after current-image conflict is resolved.

## Rollback

If the Agent ID admin API image causes a regression:

1. Restore the previous `.env` from the timestamped backup under `/home/mainuser/metasheet2`.
2. Run `docker compose --env-file .env -f docker-compose.app.yml up -d backend web`.
3. Verify `http://127.0.0.1:8900/api/health` and `http://127.0.0.1:8081/`.
4. Do not remove the private Agent ID file; it is not served publicly and can be reused after redeploy.
