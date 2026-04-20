# DingTalk Group Rule Deliveries Deploy Development

## Date
- 2026-04-20

## Summary
- Deployed the `#922` DingTalk rule-level group delivery viewer mainline to the remote host.
- The remote runtime was already on `700358ead790daa55cbcfb3e55c2a4bda4fe64f7`, but the host `.env` still pointed `IMAGE_TAG` at the older `8060c596...` hotfix tag.
- This deploy pass aligned the host configuration with the actual running image and re-ran the standard backend startup/migration path.

## Baseline
- Local deploy worktree:
  - `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-notify-deploy-20260420`
- Local branch:
  - `codex/dingtalk-notify-deploy-20260420`
- Local HEAD:
  - `700358ead790daa55cbcfb3e55c2a4bda4fe64f7`
- Remote repo:
  - `~/metasheet2`
  - branch `main`
  - HEAD `700358ead790daa55cbcfb3e55c2a4bda4fe64f7`

## Remote Findings Before Change
- `.env` still had:
  - `IMAGE_TAG=8060c596970b59b0e2b6360297af1332b63db7f6`
- Running containers were already on:
  - `ghcr.io/zensgit/metasheet2-backend:700358ead790daa55cbcfb3e55c2a4bda4fe64f7`
  - `ghcr.io/zensgit/metasheet2-web:700358ead790daa55cbcfb3e55c2a4bda4fe64f7`
- `docker compose config` still resolved backend/web images from the stale `.env` tag, so the host config and runtime had drifted.

## Remote Actions
1. Updated remote `.env`:
   - from `IMAGE_TAG=8060c596970b59b0e2b6360297af1332b63db7f6`
   - to `IMAGE_TAG=700358ead790daa55cbcfb3e55c2a4bda4fe64f7`
2. Pulled backend/web images through compose.
3. Ran:
   - `docker compose -f docker-compose.app.yml up -d backend web`
4. Re-ran backend migration entrypoint:
   - `node packages/core-backend/dist/src/db/migrate.js`
5. Verified backend health.
6. Verified deployed backend dist contains:
   - `packages/core-backend/dist/src/multitable/dingtalk-group-delivery-service.js`
   - `GET /sheets/:sheetId/automations/:ruleId/dingtalk-group-deliveries`
7. Verified deployed web bundle contains the new group-delivery viewer strings.

## Scope Confirmed On Remote
- DingTalk group destination management
- `send_dingtalk_group_message`
- DingTalk group delivery history
- `send_dingtalk_person_message`
- DingTalk person delivery history
- rule-level DingTalk group delivery viewer from `#922`

## Notes
- No new migration was introduced by `#922`.
- This deploy was an alignment pass, not a schema-changing rollout.
- The repeated compose warning about `version` being obsolete is existing repo noise and not a blocker for this deploy.
