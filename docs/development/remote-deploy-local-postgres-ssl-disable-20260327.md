# Remote Deploy Local Postgres SSL Disable

## Context

The latest mainline deploy failure moved past path resolution, compose selection, image override, stale container cleanup, and DB dependency startup. The new blocker is the migrate step:

- `Error: The server does not support SSL connections`

The remote deploy workflow uses `docker/app.env` with:

- `NODE_ENV=production`
- `DATABASE_URL=postgres://...@postgres:5432/metasheet`

The backend connection pool currently enables PostgreSQL SSL whenever `NODE_ENV=production`, which is correct for managed external databases but incorrect for the bundled single-node Docker Postgres used by the deploy workflow and on-prem templates.

## Goal

Unblock the remote deploy + migrate path against bundled local Postgres without weakening secure defaults for external production databases.

## Design

### 1. Add an explicit backend SSL opt-out

Update the backend connection pool so production SSL stays enabled by default, but can be explicitly disabled with:

- `DB_SSL=false`

Accepted falsey values:

- `false`
- `0`
- `off`
- `no`

This keeps existing production behavior unchanged unless the deploy/runtime environment explicitly opts out.

### 2. Force the opt-out only for bundled local Postgres deploys

Update the remote deploy workflow so it inspects `docker/app.env` on the host before `docker compose up`.

If `DATABASE_URL` points at a bundled/local target:

- `@postgres:`
- `@127.0.0.1:`
- `@localhost:`

then the workflow idempotently writes:

- `DB_SSL=false`

into `docker/app.env`.

This keeps the fix scoped to the single-node Docker deployment path instead of changing external DB semantics.

### 3. Align shipped env templates

Add `DB_SSL=false` to env templates that already target local non-SSL Postgres:

- `docker/app.env.example`
- `docker/app.env.attendance-onprem.template`
- `docker/app.env.attendance-onprem.ready.env`
- `docker/app.env.multitable-onprem.template`

## Why this is the smallest safe fix

- It does not change behavior for external managed databases unless `DB_SSL=false` is explicitly set.
- It fixes both migrate and steady-state backend runtime access, instead of only patching the migrate command.
- It makes the example and on-prem templates match the actual bundled Postgres capability.

## Claude Code review

Claude Code returned:

- `SAFE_MINIMAL_UNBLOCK`

Summary:

- Adding an opt-in `DB_SSL=false` toggle and only forcing it for local/loopback Postgres preserves secure defaults for external DBs while fixing the bundled-container SSL mismatch.
