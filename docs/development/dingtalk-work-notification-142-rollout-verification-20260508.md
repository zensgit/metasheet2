# DingTalk Work Notification 142 Rollout Verification (2026-05-08)

## Summary

142 has been updated from GHCR tag `77b4439ca00b4fa7ee0fee2512f6694693bb1d0f` to `8f5bd7f4bbac3a2fe6298b3293f476628e224065` for backend/web. Health, frontend entry, admin auth, and the new DingTalk work-notification runtime status endpoint were verified.

Work-notification real delivery remains blocked by missing `DINGTALK_AGENT_ID` or `DINGTALK_NOTIFY_AGENT_ID`; the deployed API/UI/helper now expose that exact blocker without leaking credential values.

## Build Evidence

Command:

```bash
gh workflow run docker-build.yml \
  --ref codex/dingtalk-directory-return-banner-tests-20260505 \
  -f drill_fail_stage=none
gh run watch 25529057281 --exit-status --interval 20
```

Result:

- Run ID: `25529057281`
- Status: `completed`
- Conclusion: `success`
- Head SHA: `8f5bd7f4bbac3a2fe6298b3293f476628e224065`
- URL: `https://github.com/zensgit/metasheet2/actions/runs/25529057281`
- Note: GitHub Actions emitted a Node.js 20 deprecation warning for actions runtime; it did not fail the build.

## Deployment Evidence

Command:

```bash
ssh metasheet-142 'cd /home/mainuser/metasheet2 && \
  docker compose -f docker-compose.app.yml pull backend web && \
  docker compose -f docker-compose.app.yml up -d --no-deps --force-recreate backend web'
```

Result:

- `metasheet-backend`: running `ghcr.io/zensgit/metasheet2-backend:8f5bd7f4bbac3a2fe6298b3293f476628e224065`
- `metasheet-web`: running `ghcr.io/zensgit/metasheet2-web:8f5bd7f4bbac3a2fe6298b3293f476628e224065`
- `metasheet-postgres`: unchanged, running healthy.
- `metasheet-redis`: unchanged, running healthy.
- Pre-deploy env backup: `.env.backup-before-8f5bd7f4-20260508T001205Z`

Migration gate:

```bash
ssh metasheet-142 'cd /home/mainuser/metasheet2 && \
  docker compose -f docker-compose.app.yml exec -T backend \
  node packages/core-backend/dist/src/db/migrate.js'
```

Result: command exited `0`; no schema-changing output was produced.

## Runtime Verification

Health and frontend:

```bash
ssh metasheet-142 'curl -fsS -o /tmp/metasheet-health.json -w "%{http_code}" \
  http://127.0.0.1:8900/api/health'
ssh metasheet-142 'curl -fsS -o /dev/null -w "%{http_code}" \
  http://127.0.0.1:8081/'
```

Result:

- Backend health: `200`
- Web entry: `200`
- Health body includes `status=ok`, `success=true`, `plugins=13`, `active=13`, `failed=0`.

Admin API:

```bash
cat /tmp/metasheet-142-admin-2h-20260508.jwt | ssh metasheet-142 \
  'TOKEN=$(cat); curl -fsS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8900/api/auth/me'
```

Result:

- `success=true`
- `email=zhouhua@china-yaguang.com`
- `role=admin`

## DingTalk Work Notification Status

Admin endpoint:

```bash
cat /tmp/metasheet-142-admin-2h-20260508.jwt | ssh metasheet-142 \
  'TOKEN=$(cat); curl -fsS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8900/api/admin/users/b928b8d9-8881-43d7-a712-842b28870494/dingtalk-access'
```

Redacted result:

```json
{
  "workNotification": {
    "configured": false,
    "available": false,
    "unavailableReason": "missing_agent_id",
    "requirements": {
      "appKey": {
        "configured": true,
        "selectedKey": "DINGTALK_CLIENT_ID"
      },
      "appSecret": {
        "configured": true,
        "selectedKey": "DINGTALK_CLIENT_SECRET"
      },
      "agentId": {
        "configured": false,
        "selectedKey": null
      },
      "baseUrl": {
        "configured": false,
        "selectedKey": null
      }
    }
  }
}
```

Remote helper:

```bash
ssh metasheet-142 'node /tmp/dingtalk-work-notification-env-status.mjs \
  --env-file /home/mainuser/metasheet2/docker/app.env \
  --env-file /home/mainuser/metasheet2/.env \
  --allow-blocked \
  --output-json /tmp/dingtalk-work-notification-env-status/summary.json \
  --output-md /tmp/dingtalk-work-notification-env-status/summary.md'
```

Result:

- Overall status: `blocked`
- App key: present via `DINGTALK_CLIENT_ID`
- App secret: present via `DINGTALK_CLIENT_SECRET`
- Agent id: missing
- No credential values printed or written to this markdown.

## Log Verification

Backend logs since restart show:

- Plugin loading completed.
- HTTP server listening on `0.0.0.0:8900`.
- `GET /api/health` returned through the app.
- `GET /api/admin/users/:userId/dingtalk-access` reached the deployed backend.
- `GET /api/auth/me` reached the deployed backend.

No backend startup crash or plugin activation failure was observed in the checked window.

## Remaining Action

To enable real DingTalk work-notification delivery for failure alerts to rule creators, set `DINGTALK_AGENT_ID` or `DINGTALK_NOTIFY_AGENT_ID` on 142, restart `metasheet-backend`, then rerun:

```bash
node /tmp/dingtalk-work-notification-env-status.mjs \
  --env-file /home/mainuser/metasheet2/docker/app.env \
  --env-file /home/mainuser/metasheet2/.env
```

Expected post-config state: `Overall Status: ready`, and the admin endpoint should report `workNotification.available=true`.

