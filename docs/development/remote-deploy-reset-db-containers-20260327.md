# Remote Deploy Reset DB Containers

Date: 2026-03-27

## Problem

After resolving path, non-git host, compose-command, image-coordinate, backend/web fixed-container, and db-dependency sequencing blockers,
mainline run `23597784889` still failed at deploy start with:

- `Cannot create container for service redis: Conflict`
- `Cannot create container for service postgres: Conflict`

The deploy path already reset `metasheet-backend` and `metasheet-web`, but the stateful services still kept
their fixed-name legacy containers around.

## Design

Extend the existing stale-container reset loop to include:

- `metasheet-postgres`
- `metasheet-redis`

Keep the same guarded behavior:

1. Check container existence first.
2. Remove only the known fixed-name containers.
3. Continue with the existing deploy sequence.

Apply this in:

- the remote deploy workflow
- the manual production deploy helper

## Scope

Updated files:

- `.github/workflows/docker-build.yml`
- `scripts/ops/deploy-attendance-prod.sh`

## Expected Effect

Deploy should move beyond:

- `postgres` container-name conflict
- `redis` container-name conflict

If a later failure still occurs, it should now be a real runtime readiness or migrate/smoke issue rather than stale fixed-name DB containers.
