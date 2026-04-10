# DingTalk Production Rollout Design

Date: 2026-04-10

## Goal

Promote the merged DingTalk stack on `main` to production with the smallest safe cutover:

- keep production available while preparing artifacts
- fix production config drift before restart
- run database changes before switching live traffic
- preserve a direct rollback path to the old image tag

## Inputs

- merged main tag: `810f6639a`
- previous production runtime tag: `5e4b8ee487a3bca7e2390f46818f17a79c7d94b8`
- production deploy root: `/home/mainuser/metasheet2`
- production backend health endpoint: `http://127.0.0.1:8900/health`

## Problems Found Before Rollout

1. Production runtime drifted from deploy config.
   - running containers used `5e4b8ee...`
   - `/home/mainuser/metasheet2/.env` still pointed at `111324815e...`

2. Production `docker/app.env` was malformed.
   - file contained literal `\n` sequences instead of real newlines

3. Production source tree was stale.
   - merged DingTalk files from `main` were not present

4. Production database lagged behind staging.
   - missing the 2026-04-07 to 2026-04-09 migrations

5. Production migration history had older ordering gaps.
   - `kysely_migration` was missing earlier 2026-03 migrations that newer migrations depended on

## Rollout Strategy

### 1. Non-destructive preparation

- back up `.env` and `docker/app.env`
- take a compressed production database dump
- sync merged `main` source into `/home/mainuser/metasheet2`
- keep running production containers untouched during this phase

### 2. Config convergence

- rewrite `docker/app.env` into real multiline format
- move production to the merged DingTalk env shape:
  - `DINGTALK_CLIENT_ID`
  - `DINGTALK_CLIENT_SECRET`
  - `DINGTALK_CORP_ID`
  - `DINGTALK_ALLOWED_CORP_IDS`
  - `DINGTALK_REDIRECT_URI=http://142.171.239.56:8081/login/dingtalk/callback`
  - `DINGTALK_AUTH_AUTO_LINK_EMAIL=1`
  - `DINGTALK_AUTH_AUTO_PROVISION=0`
  - `DINGTALK_AUTH_REQUIRE_GRANT=1`
- align root `.env` tag to `810f6639a`
- validate with:
  - `scripts/ops/validate-env-file.sh`
  - `docker compose config`
  - `scripts/ops/attendance-preflight.sh`

### 3. Build before cutover

- build backend and web images locally on the production host for tag `810f6639a`
- avoid registry drift and avoid changing live services during image preparation

### 4. Database-first rollout

- dry-run DingTalk corpId backfill logic before enabling corp enforcement
- run the missing historical migration fixes first
- then execute the remaining pending migrations with the new backend image on the production docker network
- only switch live services after database state matches the merged application code

### 5. Two-phase service cutover

- switch `backend` first and wait for `8900/health`
- validate DingTalk launch on the live backend
- switch `web` second

## Rollback Strategy

- previous production images remain locally available:
  - backend `5e4b8ee...`
  - web `5e4b8ee...`
- backup files available:
  - `/home/mainuser/metasheet2/.env.prod-rollout-bak-20260410T065443Z`
  - `/home/mainuser/metasheet2/docker/app.env.prod-rollout-bak-20260410T065443Z`
- database dump available:
  - `/home/mainuser/metasheet2/artifacts/prod-db-pre-dingtalk-rollout-20260410T070733Z.sql.gz`

## Post-rollout Gate

The rollout is considered complete only if all of the following hold:

- production backend and web both run `810f6639a`
- `/health` returns success
- DingTalk launch returns HTTP `200`
- DingTalk credentials exchange for an access token successfully
- 2026-04 migrations are present in production
