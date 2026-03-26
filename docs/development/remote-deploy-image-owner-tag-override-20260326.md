# Remote Deploy Image Owner/Tag Override

Date: 2026-03-26

## Problem

After merging the deploy path, non-git host, and compose-command fixes, mainline run `23594571570`
advanced into the actual `pull` step and failed with:

- `Head "https://ghcr.io/v2/local/metasheet2-backend/manifests/current": denied`
- `Head "https://ghcr.io/v2/local/metasheet2-web/manifests/current": denied`

The repository compose file defaults to:

- `IMAGE_OWNER=zensgit`
- `IMAGE_TAG=latest`

but the remote host environment was overriding those values to `local/current`.

## Design

Pin the deploy workflow to the images that the same workflow just built:

1. Set `DEPLOY_IMAGE_OWNER=zensgit`.
2. Set `DEPLOY_IMAGE_TAG=${GITHUB_SHA}`.
3. Export those values into the remote shell.
4. Prefix the compose `pull` / `up` commands with `IMAGE_OWNER=... IMAGE_TAG=...`.

Also align the manual production helper script with the same explicit owner/tag override mechanism.

## Scope

Updated files:

- `.github/workflows/docker-build.yml`
- `scripts/ops/deploy-attendance-prod.sh`

## Expected Effect

The remote host should stop inheriting stale `local/current` image coordinates and instead pull:

- `ghcr.io/zensgit/metasheet2-backend:${GITHUB_SHA}`
- `ghcr.io/zensgit/metasheet2-web:${GITHUB_SHA}`

If deploy still fails after this change, the next blocker will be registry authentication or some later pull/runtime step, not compose variable drift.
