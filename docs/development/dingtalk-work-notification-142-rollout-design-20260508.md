# DingTalk Work Notification 142 Rollout Design (2026-05-08)

## Goal

Deploy commit `8f5bd7f4bbac3a2fe6298b3293f476628e224065` to the 142 main environment through immutable GHCR images, so the DingTalk work-notification runtime status is visible from the admin user DingTalk panel and the supporting admin API.

## Scope

- Update only `metasheet-backend` and `metasheet-web`.
- Keep `postgres` and `redis` running unchanged.
- Run backend migration as a safe no-op gate after image restart.
- Do not use container hot patches as the final delivery mechanism.
- Do not write webhook, `SEC`, JWT, app secret, or access token values to Git, chat, or evidence markdown.

## Release Model

The deploy source is the manually triggered GHCR workflow run:

- Workflow: `Build and Push Docker Images`
- Run ID: `25529057281`
- Run URL: `https://github.com/zensgit/metasheet2/actions/runs/25529057281`
- Head SHA: `8f5bd7f4bbac3a2fe6298b3293f476628e224065`
- Backend image: `ghcr.io/zensgit/metasheet2-backend:8f5bd7f4bbac3a2fe6298b3293f476628e224065`
- Web image: `ghcr.io/zensgit/metasheet2-web:8f5bd7f4bbac3a2fe6298b3293f476628e224065`

Because this branch is not `main`, the workflow's deploy job is skipped by design. The 142 host is updated manually by changing `IMAGE_TAG` in `/home/mainuser/metasheet2/.env`, pulling the two images, and recreating only backend/web.

## Runtime Behavior

The deployed backend exposes DingTalk work-notification readiness through the existing admin DingTalk access endpoint:

`GET /api/admin/users/:userId/dingtalk-access`

The response contains `workNotification` with:

- `available`: whether work notifications can be sent.
- `unavailableReason`: normalized reason such as `missing_agent_id`.
- `requirements`: redaction-safe status for app key, app secret, agent id, and base URL.
- `selectedKey`: the env key selected by runtime resolution, never the value.

The web admin user panel reads this payload and shows the readiness chips in the DingTalk section. This keeps operators from guessing whether the failure-notification path is blocked by code, by user linkage, or by missing DingTalk app env.

## 142 Configuration Boundary

142 currently has DingTalk app key and app secret present through compatibility env names, but work notifications remain unavailable until one of these is configured:

- `DINGTALK_AGENT_ID`
- `DINGTALK_NOTIFY_AGENT_ID`

This is a deploy-visible configuration blocker, not a code deployment blocker. After setting the agent id, restart `metasheet-backend` and rerun the helper/API verification.

## Rollback

The pre-deploy env backup on 142 is:

`/home/mainuser/metasheet2/.env.backup-before-8f5bd7f4-20260508T001205Z`

Rollback procedure:

1. Restore the backup `.env` or set `IMAGE_TAG=77b4439ca00b4fa7ee0fee2512f6694693bb1d0f`.
2. Run `docker compose -f docker-compose.app.yml pull backend web`.
3. Run `docker compose -f docker-compose.app.yml up -d --no-deps --force-recreate backend web`.
4. Verify `/api/health`, `/api/auth/me`, and the form entry paths.

