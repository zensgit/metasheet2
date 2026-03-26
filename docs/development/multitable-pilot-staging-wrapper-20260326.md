# Multitable Pilot Staging Wrapper

Date: 2026-03-26
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Goal

Add a staging-safe execution entrypoint for multitable pilot smoke so future environment validation does not rely on the local wrapper's auto-start behavior.

New entrypoint:

- `pnpm verify:multitable-pilot:staging`
- `scripts/ops/multitable-pilot-staging.sh`

## Problem

`multitable-pilot-local.sh` is intentionally convenient for developer machines:

- it can migrate the database
- it can start backend dev
- it can start the web dev server

That is useful locally, but it is the wrong default for staging or a pre-deployed host. Using the local wrapper directly in those environments risks:

- accidental local-migrate logic against the wrong database
- accidental dev-server startup attempts when services should already be running
- confusion about whether the smoke result came from a reused environment or a locally bootstrapped one

## Design

### 1. Make auto-start optional in the shared wrapper

`scripts/ops/multitable-pilot-local.sh` now accepts:

- `AUTO_START_SERVICES`
- `REQUIRE_RUNNING_SERVICES`

Behavior:

- default remains local-friendly: `AUTO_START_SERVICES=true`
- if `AUTO_START_SERVICES=false` or `REQUIRE_RUNNING_SERVICES=true`, unreachable backend/web endpoints become hard failures instead of triggering migrate/start logic

This keeps one shared wrapper while making the staging policy explicit.

### 2. Add a dedicated staging entrypoint

`scripts/ops/multitable-pilot-staging.sh` is a thin wrapper over `multitable-pilot-local.sh` that hard-codes staging-safe behavior:

- `AUTO_START_SERVICES=false`
- `REQUIRE_RUNNING_SERVICES=true`
- `ENSURE_PLAYWRIGHT=false` by default

It still reuses the same artifact logic, including:

- raw runner `report.json`
- wrapper `local-report.json`
- wrapper `local-report.md`

So staging gets the same report shape as local runs, but without startup side effects.

### 3. Expose the wrapper through package scripts

New package scripts:

- `verify:multitable-pilot:staging`
- `verify:multitable-pilot:staging:test`

That gives the team a stable, documented command surface instead of relying on one-off env var combinations.

## Verification

I ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
bash -n scripts/ops/multitable-pilot-local.sh scripts/ops/multitable-pilot-staging.sh
node --test \
  scripts/ops/multitable-pilot-local.test.mjs \
  scripts/ops/multitable-pilot-staging.test.mjs
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web build
```

Results:

- shell syntax checks passed
- local wrapper tests passed
- staging wrapper tests passed
- frontend `tsc --noEmit` passed
- frontend build passed

## Outcome

The multitable pilot chain now has two explicit execution modes:

- local developer mode: `verify:multitable-pilot:local`
- running-services-only staging mode: `verify:multitable-pilot:staging`

That makes future deployment validation much safer and removes one of the last remaining ergonomics gaps before we actually run smoke on a real staging environment.
