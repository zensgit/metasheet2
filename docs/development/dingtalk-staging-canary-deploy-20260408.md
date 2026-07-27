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

2. Fill the real DingTalk credentials and fresh secret set. Set `IMAGE_TAG` to the exact
   40-character lowercase Git commit SHA covered by the image provenance file.

3. Deploy a specific image tag:

```bash
DEPLOY_IMAGE_OWNER=zensgit \
DEPLOY_IMAGE_TAG=<full-40-character-git-sha> \
DEPLOY_EXPECTED_COMMIT=<same-full-40-character-git-sha> \
DEPLOY_IMAGE_PROVENANCE_FILE=/absolute/private/path/image-provenance.json \
bash scripts/ops/deploy-dingtalk-staging.sh
```

If `DEPLOY_IMAGE_OWNER` and `DEPLOY_IMAGE_TAG` are omitted, the script now falls back to `IMAGE_OWNER` and `IMAGE_TAG` from `docker/app.staging.env`. This keeps ad-hoc `docker compose --env-file docker/app.staging.env ...` and the deploy script aligned instead of silently pulling `latest`.

Mutable tags and abbreviated SHAs are rejected. The deploy also requires the build-generated
provenance JSON and verifies the running backend's configured image, immutable Docker image ID,
OCI revision label, and `/health` build commit before emitting a worker-drain PASS.
The provenance file must be a regular file owned by the deploy user with mode `0400` or `0600`.
It is controlled-host operator evidence, not a cryptographic signature or registry attestation.

The staging deploy script now also validates the env file format before Compose runs. A corrupted single-line file with literal `\n` sequences will fail fast instead of tearing down containers and then discovering the env file is unreadable.

If an operator needs to recover a corrupted env file on-host, use:

```bash
bash scripts/ops/repair-env-file.sh docker/app.env
```

or for staging:

```bash
bash scripts/ops/repair-env-file.sh docker/app.staging.env
```

## Building a PR stack before merge

GitHub Actions in this repository only build Docker images on `main` and `master`, so stacked DingTalk PR branches do not automatically publish a GHCR tag.

To test `#725/#723/#724` before merge:

1. Build the local backend image from the PR source tree:

```bash
IMAGE_OWNER=zensgit \
IMAGE_TAG=<full-40-character-pr-commit-sha> \
IMAGE_PROVENANCE_FILE=/absolute/private/path/image-provenance.json \
SOURCE_DIR=/path/to/pr3-export \
bash scripts/ops/build-dingtalk-staging-images.sh
```

The build refuses a dirty or mismatched checkout and builds from `git archive` of the exact SHA,
not from live ignored files. The default worker-drain scope writes the backend image ID to the
private provenance file. A release that also changes the staging web image must set
`STAGING_DEPLOY_SCOPE=full` for both build and deploy.

2. Set the same `IMAGE_OWNER` and `IMAGE_TAG` in `docker/app.staging.env`.

3. Deploy without pulling from GHCR:

```bash
SKIP_PULL=1 \
STAGING_DEPLOY_SCOPE=backend \
DEPLOY_EXPECTED_COMMIT=<same-full-40-character-pr-commit-sha> \
DEPLOY_IMAGE_PROVENANCE_FILE=/absolute/private/path/image-provenance.json \
bash scripts/ops/deploy-dingtalk-staging.sh
```

This uses the locally built backend image already present on the staging host and leaves the web
container unchanged. Use the explicit `full` scope only when the reviewed release includes web
runtime changes.

## Verification

After deploy:

- staging web should answer on `http://142.171.239.56:8082`
- staging backend health should answer on `http://127.0.0.1:18900/health`
- the deploy must emit exactly one values-free `WORKER_DRAIN_GATE_PASS` with
  `observed_project_workers=1`, `managed_project_old_workers=0`,
  `staging_ingress_workers=1`, `staging_ingress_unmanaged_workers=0`, and every match field
  equal to `1`
- verify there is no alternate staging backend upstream outside this Compose `backend` service
  and the fixed loopback publish
- then run the execution flow in `docs/development/dingtalk-staging-execution-checklist-20260408.md`

For the corp-scope Phase A to Phase B cutover, treat that PASS as point-in-time evidence only.
Hold an exclusive host change window through the Phase B migration. A privileged out-of-band
Docker/Compose mutation invalidates the PASS and requires a fresh deploy/gate run.

## Rollback

Re-run the same script with the previous good tag:

```bash
DEPLOY_IMAGE_OWNER=zensgit \
DEPLOY_IMAGE_TAG=111324815e83f066dabd47dec2e7cfa97a045b3e \
DEPLOY_EXPECTED_COMMIT=111324815e83f066dabd47dec2e7cfa97a045b3e \
DEPLOY_IMAGE_PROVENANCE_FILE=/absolute/private/path/rollback-image-provenance.json \
bash scripts/ops/deploy-dingtalk-staging.sh
```

## Notes

- Rotate the DingTalk `ClientSecret` before the first real staging login because the previous secret was exposed in chat history.
- Keep `DINGTALK_AUTH_AUTO_PROVISION=0` in staging until login and directory matching are verified.
