# Platform Shell Wave 1 Tenant Isolation And Installer Consistency Design

Date: 2026-04-13

## Scope

This follow-up hardens two behavior gaps discovered during re-review of `feat/platform-shell-wave1`:

1. Authenticated requests without a resolved tenant scope must not silently collapse into a shared `default` workspace.
2. `plugin-after-sales` install state must stay coherent when `platform_app_instances` registration fails after the install ledger was already written.

The goal is to remove cross-tenant state leakage and eliminate the "install succeeded in ledger but no platform instance exists" split-brain.

## Problem 1: Implicit `default` Tenant Fallback

Before this change:

- `packages/core-backend/src/routes/platform-apps.ts` returned `'default'` for any authenticated request that had no `req.user.tenantId` and no `tenantContext`.
- `plugins/plugin-after-sales/index.cjs` used the same fallback for route handlers such as:
  - `GET /api/after-sales/projects/current`
  - `POST /api/after-sales/projects/install`

That behavior merged distinct authenticated users into the same workspace key:

- platform shell looked up `workspace_id = 'default'`
- after-sales install/current used `tenantId = 'default'`

This is not a safe default for a multi-tenant platform. Missing tenant scope must fail closed.

### Decision

- `platform-apps` routes now resolve tenant scope only from:
  - `req.user.tenantId`
  - `tenantContext.getTenantId()`
- If neither exists, platform shell returns `instance: null` and does not query `platform_app_instances`.
- `plugin-after-sales` route handlers now return `401 UNAUTHORIZED` with `tenantId not found` when user auth exists but tenant scope is absent.

### Why This Is Correct

- It preserves explicit tenant sources.
- It removes silent workspace sharing.
- It keeps read-only catalog behavior safe: `/api/platform/apps` still returns app metadata, but without tenant-bound instance state.
- It makes install/current behavior deterministic: if tenant scope is unavailable, the request is invalid.

## Problem 2: Installer Split-Brain On Registry Failure

Before this change, `plugins/plugin-after-sales/lib/installer.cjs` used this order:

1. Compute `status` from warnings.
2. Write install ledger.
3. Upsert `platform_app_instances`.
4. If registry write failed, append a warning only.

That allowed this inconsistent state:

- install API returned `status: installed`
- ledger row stored `status: installed`
- platform shell read `instance: null` because registry upsert failed

### Decision

Registry persistence is now treated as part of terminal install success.

New behavior:

1. Installer still writes the first terminal ledger row from current warnings.
2. If `platform_app_instances` upsert fails:
   - append a registry failure warning
   - downgrade terminal status to `failed`
   - rewrite the ledger row with the failed status and augmented warnings
   - throw `InstallerError('platform-instance-write-failed')`

### Why This Is Correct

- The install API no longer reports success when platform shell cannot observe an instance.
- Ledger state now captures the real operator-facing outcome: install orchestration could not complete into a usable platform runtime.
- Reinstall remains the recovery path because the ledger now records a terminal failed state.

## Non-Goals

- This change does not introduce a single-tenant compatibility flag.
- This change does not refactor plugin communication API methods that independently default tenant arguments.
- This change does not alter frontend launcher/shell logic.

## Files Changed

- `packages/core-backend/src/routes/platform-apps.ts`
- `plugins/plugin-after-sales/index.cjs`
- `plugins/plugin-after-sales/lib/installer.cjs`
- `packages/core-backend/tests/unit/platform-apps-router.test.ts`
- `packages/core-backend/tests/unit/after-sales-plugin-routes.test.ts`
