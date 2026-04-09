# DingTalk Staging Canary Deploy

Date: 2026-04-08
Scope: reusable staging/canary deploy path for the DingTalk PR stack `#725`, `#723`, `#724`

## Why this exists

The production host drifted into two unsafe states:

- root `.env` still pointed Compose image resolution at `local/current`
- `docker/app.env` had been flattened into one line with literal `\n`

That combination made ad-hoc `docker compose up` unreliable and blocked safe staged rollout of the DingTalk stack.

## Current production correction

The server at `142.171.239.56` was corrected to:

- root `.env`
  - `IMAGE_OWNER=zensgit`
  - `IMAGE_TAG=111324815e83f066dabd47dec2e7cfa97a045b3e`
- `docker/app.env`
  - restored to a real multi-line env file

Production is now running again on:

- backend `ghcr.io/zensgit/metasheet2-backend:111324815e83f066dabd47dec2e7cfa97a045b3e`
- web `ghcr.io/zensgit/metasheet2-web:111324815e83f066dabd47dec2e7cfa97a045b3e`

## Staging topology on the same host

Use a separate compose file instead of sharing the production stack:

- compose file: `docker-compose.app.staging.yml`
- env file: `docker/app.staging.env`
- web port: `8082`
- backend port: `127.0.0.1:18900`
- separate container names:
  - `metasheet-staging-postgres`
  - `metasheet-staging-redis`
  - `metasheet-staging-backend`
  - `metasheet-staging-web`
- separate volumes:
  - `metasheet-staging-postgres-data`
  - `metasheet-staging-redis-data`
  - `metasheet-staging-attendance-import-data`

## DingTalk callback for staging

For the PR stack that uses the frontend callback page, register:

`http://142.171.239.56:8082/login/dingtalk/callback`

Do not reuse the old production callback path:

`http://142.171.239.56:8081/auth/dingtalk/callback`

## Deploy command

1. Copy the template:

```bash
cp docker/app.staging.env.example docker/app.staging.env
```

2. Fill the real DingTalk credentials, fresh secret set, and target image tag in `docker/app.staging.env`.

3. Deploy a specific image tag:

```bash
DEPLOY_IMAGE_OWNER=zensgit \
DEPLOY_IMAGE_TAG=<git-sha-or-release-tag> \
bash scripts/ops/deploy-dingtalk-staging.sh
```

If `DEPLOY_IMAGE_OWNER` and `DEPLOY_IMAGE_TAG` are omitted, the script now falls back to `IMAGE_OWNER` and `IMAGE_TAG` from `docker/app.staging.env`. This keeps ad-hoc `docker compose --env-file docker/app.staging.env ...` and the deploy script aligned instead of silently pulling `latest`.

## Building a PR stack before merge

GitHub Actions in this repository only build Docker images on `main` and `master`, so stacked DingTalk PR branches do not automatically publish a GHCR tag.

To test `#725/#723/#724` before merge:

1. Build local images from the PR source tree:

```bash
IMAGE_OWNER=zensgit \
IMAGE_TAG=<pr-commit-sha> \
SOURCE_DIR=/path/to/pr3-export \
bash scripts/ops/build-dingtalk-staging-images.sh
```

2. Set the same `IMAGE_OWNER` and `IMAGE_TAG` in `docker/app.staging.env`.

3. Deploy without pulling from GHCR:

```bash
SKIP_PULL=1 \
bash scripts/ops/deploy-dingtalk-staging.sh
```

This uses the locally built images already present on the staging host.

## Verification

After deploy:

- staging web should answer on `http://142.171.239.56:8082`
- staging backend health should answer on `http://127.0.0.1:18900/health`
- then run the execution flow in `docs/development/dingtalk-staging-execution-checklist-20260408.md`

## Rollback

Re-run the same script with the previous good tag:

```bash
DEPLOY_IMAGE_OWNER=zensgit \
DEPLOY_IMAGE_TAG=111324815e83f066dabd47dec2e7cfa97a045b3e \
bash scripts/ops/deploy-dingtalk-staging.sh
```

## Notes

- Rotate the DingTalk `ClientSecret` before the first real staging login because the previous secret was exposed in chat history.
- Keep `DINGTALK_AUTH_AUTO_PROVISION=0` in staging until login and directory matching are verified.
