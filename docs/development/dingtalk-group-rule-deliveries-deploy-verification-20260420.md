# DingTalk Group Rule Deliveries Deploy Verification

## Date
- 2026-04-20

## Environment
- Remote host: `metasheet-142`
- Remote repo path: `~/metasheet2`
- Local deploy worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-notify-deploy-20260420`

## Commands

```bash
ssh metasheet-142 "cd ~/metasheet2 && grep -E '^IMAGE_TAG=' .env && docker ps --format '{{.Image}} {{.Names}}'"
ssh metasheet-142 "cd ~/metasheet2 && git branch --show-current && git rev-parse HEAD && git log --oneline -1"
ssh metasheet-142 'cd ~/metasheet2 && ... update IMAGE_TAG to 700358ead790daa55cbcfb3e55c2a4bda4fe64f7 ...'
ssh metasheet-142 'cd ~/metasheet2 && docker compose -f docker-compose.app.yml pull backend web'
ssh metasheet-142 'cd ~/metasheet2 && docker compose -f docker-compose.app.yml up -d backend web'
ssh metasheet-142 'cd ~/metasheet2 && docker compose -f docker-compose.app.yml exec -T backend node packages/core-backend/dist/src/db/migrate.js'
ssh metasheet-142 'cd ~/metasheet2 && curl -fsS http://127.0.0.1:8900/health'
ssh metasheet-142 'cd ~/metasheet2 && docker compose -f docker-compose.app.yml exec -T backend sh -lc "ls packages/core-backend/dist/src/multitable/dingtalk-group-delivery-service.js && grep -n \"dingtalk-group-deliveries\\|listAutomationDingTalkGroupDeliveries\" packages/core-backend/dist/src/routes/univer-meta.js | head"'
ssh metasheet-142 'docker exec metasheet-web sh -lc "grep -R -n \"DingTalk Group Deliveries\\|data-automation-group-deliveries\" /usr/share/nginx/html/assets | head -n 20"'
```

## Results

### Remote state before alignment
- remote repo branch: `main`
- remote repo HEAD: `700358ead790daa55cbcfb3e55c2a4bda4fe64f7`
- `.env IMAGE_TAG`: `8060c596970b59b0e2b6360297af1332b63db7f6`
- running containers:
  - backend: `ghcr.io/zensgit/metasheet2-backend:700358ead790daa55cbcfb3e55c2a4bda4fe64f7`
  - web: `ghcr.io/zensgit/metasheet2-web:700358ead790daa55cbcfb3e55c2a4bda4fe64f7`

### Remote state after alignment
- `.env IMAGE_TAG`: `700358ead790daa55cbcfb3e55c2a4bda4fe64f7`
- running containers:
  - backend: `ghcr.io/zensgit/metasheet2-backend:700358ead790daa55cbcfb3e55c2a4bda4fe64f7`
  - web: `ghcr.io/zensgit/metasheet2-web:700358ead790daa55cbcfb3e55c2a4bda4fe64f7`

### Health
- `GET /health`
  - returned `200`
  - payload included:
    - `"status":"ok"`
    - `"ok":true`
    - `"plugins":12`

### Backend runtime verification
- `packages/core-backend/dist/src/multitable/dingtalk-group-delivery-service.js`
  - present in running backend container
- `packages/core-backend/dist/src/routes/univer-meta.js`
  - contains:
    - `dingtalk-group-deliveries`
    - `listAutomationDingTalkGroupDeliveries`

### Frontend runtime verification
- deployed web bundle contains:
  - `DingTalk Group Deliveries`
  - `data-automation-group-deliveries`

## Verification Summary
- Remote source, compose config, and running DingTalk notify runtime are now aligned to `main@700358ead`.
- The `#922` rule-level group delivery viewer code is present in both deployed backend and deployed frontend artifacts.
- No schema migration was required beyond re-running the normal migrate entrypoint.
