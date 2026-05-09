# DingTalk Work Notification Release Gate Design (2026-05-08)

## Goal

Add a read-only final gate for DingTalk work-notification delivery readiness. The gate should answer one question after deployment or Agent ID configuration:

Can this environment now support rule-creator DingTalk work notifications?

## Scope

- Add `scripts/ops/dingtalk-work-notification-release-gate.mjs`.
- Add Node tests for ready, blocked, redaction, and `--skip-admin-api` paths.
- Reuse the existing `dingtalk-work-notification-env-status.mjs` helper instead of reimplementing env parsing.
- Do not call DingTalk APIs and do not send messages.

## Checks

The gate runs four checks:

- Env readiness through `dingtalk-work-notification-env-status.mjs`.
- Backend health through `GET /api/health`.
- Admin auth through `GET /api/auth/me`.
- Admin runtime workNotification status through `GET /api/admin/users/:userId/dingtalk-access`.

The final status is `pass` only when:

- Env status is `ready`.
- Health endpoint is OK.
- Admin auth probe succeeds, unless `--skip-admin-api` is used.
- `workNotification.available=true`, unless `--skip-admin-api` is used.

Otherwise the status is `blocked` with failure codes.

## Security

- Bearer tokens can be read from `--auth-token-file`; the value is never printed.
- API response bodies are recursively redacted before summaries are written.
- The gate writes only status, paths, booleans, selected env key names, and failure codes.
- Webhooks, robot `SEC` secrets, JWTs, app secrets, and access tokens are redacted from JSON and Markdown evidence.

## 142 Usage

Current blocked check:

```bash
node /tmp/dingtalk-work-notification-release-gate.mjs \
  --env-file /home/mainuser/metasheet2/docker/app.env \
  --env-file /home/mainuser/metasheet2/.env \
  --status-helper /tmp/dingtalk-work-notification-env-status.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file /tmp/metasheet-142-admin-2h-20260508.jwt \
  --user-id b928b8d9-8881-43d7-a712-842b28870494 \
  --allow-blocked \
  --output-json /tmp/dingtalk-work-notification-release-gate/summary.json \
  --output-md /tmp/dingtalk-work-notification-release-gate/summary.md
```

After the real Agent ID is applied, rerun the same command without `--allow-blocked`. Expected status: `pass`.
