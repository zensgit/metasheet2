# Remote Deploy Container Name Conflict Reset

Date: 2026-03-26

## Problem

After fixing path resolution, non-git host fallback, compose-command fallback, and image owner/tag drift,
mainline run `23594905975` advanced into a real image pull and then failed with:

- `Cannot create container for service backend: Conflict`
- `The container name "/metasheet-backend" is already in use`

This means the remote host still has an existing container with the fixed `container_name`, and legacy
`docker-compose` is not removing it cleanly before recreate.

## Design

Before running compose `pull` / `up`, explicitly remove any existing fixed-name app containers:

- `metasheet-backend`
- `metasheet-web`

Do this in:

- the remote deploy workflow
- the manual production deploy helper

This is a narrow operational reset. It does not change compose topology, container names, images, or migration logic.

## Scope

Updated files:

- `.github/workflows/docker-build.yml`
- `scripts/ops/deploy-attendance-prod.sh`

## Expected Effect

Deploy should move past fixed-name container conflicts and continue into:

- compose up
- migration
- smoke

If deploy still fails after this slice, the next blocker will be later runtime/registry behavior, not stale fixed-name containers.
