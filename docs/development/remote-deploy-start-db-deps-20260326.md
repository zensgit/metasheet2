# Remote Deploy Start DB Dependencies

Date: 2026-03-26

## Problem

After resolving path, non-git host, compose-command, image-coordinate, and fixed-container blockers,
mainline run `23597386632` advanced through deploy and then failed during migration with:

- `getaddrinfo ENOTFOUND postgres`

That means the backend container was up, but the compose network did not currently provide a running
`postgres` service for DNS resolution during the migration step.

## Design

Before pulling/recreating `backend` and `web`, explicitly start the stateful dependencies:

- `postgres`
- `redis`

Do this in:

- the remote deploy workflow
- the manual production deploy helper

This is a narrow sequencing fix. It does not alter compose topology, service names, migration commands, or smoke logic.

## Scope

Updated files:

- `.github/workflows/docker-build.yml`
- `scripts/ops/deploy-attendance-prod.sh`

## Expected Effect

Deploy should move past:

- backend/web recreate
- migration hostname resolution

If a later failure still occurs, it should now be a real DB readiness/auth/runtime issue rather than missing compose dependencies.
