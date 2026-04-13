# Platform Shell Wave 1 Runtime Model Design

Date: 2026-04-13
Branch: `feat/platform-shell-wave1`
Rebased head: `9328cc8e2`

## Summary

This slice turns the platform shell from a catalog-only surface into a runtime-aware app launcher.

The core change is to model platform apps in two runtime classes:

- `instance`: the app requires a tenant-scoped runtime instance before normal entry
- `direct`: the app runs directly from its canonical route and does not require tenant installation

This removes the previous false assumption that every app behaves like after-sales.

## Problem

Before this slice:

- the platform shell could discover apps, but it could not represent different runtime shapes correctly
- `after-sales` needed install/current state, while `attendance` was already a direct-entry app
- the shell treated non-installed apps generically and could not drive an existing plugin install contract
- direct apps risked being mislabeled as `not-installed`

## Scope

Included:

- platform app catalog and shell runtime model
- tenant app instance registry
- after-sales registry-first install/current integration
- attendance as a second reference app using direct runtime
- manifest-driven install/reinstall actions in the shell

Excluded:

- generic cross-plugin install protocol
- after-sales installer state-machine redesign
- after-sales page restructuring
- attendance installer/current lifecycle
- unified inbox/notification aggregation

## Key Decisions

### 1. Runtime model is explicit

`app.manifest.json` now declares:

- `runtimeModel: "instance" | "direct"`

Rationale:

- `after-sales` is an installable tenant app
- `attendance` is already a stable direct-entry app
- forcing both into one lifecycle would produce wrong UI and brittle contracts

Relevant files:

- `packages/core-backend/src/platform/app-manifest.ts`
- `packages/core-backend/src/platform/app-registry.ts`
- `apps/web/src/composables/usePlatformApps.ts`

### 2. Install actions are plugin-declared, not platform-invented

`instance` apps may additionally declare:

- `runtimeBindings.currentPath`
- `runtimeBindings.installPath`
- `runtimeBindings.installPayload`

The platform shell uses these bindings to trigger install/reinstall without changing plugin API contracts.

Rationale:

- avoids inventing a fake generic install API
- keeps install semantics owned by the app plugin
- lets the shell remain operationally useful immediately

Relevant files:

- `plugins/plugin-after-sales/app.manifest.json`
- `apps/web/src/composables/usePlatformApps.ts`
- `apps/web/src/views/PlatformAppShellView.vue`

### 3. after-sales remains the reference app for installable runtime

after-sales now anchors the `instance` path:

- install writes into `platform_app_instances`
- current state reads registry first, then falls back to legacy ledger
- shell can call existing `/api/after-sales/projects/install`

Relevant files:

- `plugins/plugin-after-sales/lib/installer.cjs`
- `packages/core-backend/src/services/PlatformAppInstanceRegistryService.ts`
- `packages/core-backend/tests/unit/after-sales-plugin-routes.test.ts`

### 4. attendance proves direct-runtime support

attendance receives an app manifest but no installer coupling.

Rationale:

- it already has canonical entry `/attendance`
- it already behaves like a direct runtime app
- adding fake install/current endpoints would distort the model

Relevant files:

- `plugins/plugin-attendance/app.manifest.json`
- `apps/web/src/router/appRoutes.ts`

## Architecture

### Backend

1. App manifests are parsed from plugin roots.
2. Platform app summaries are collected from loaded plugins.
3. For tenant-aware requests, instance records are attached from `platform_app_instances`.
4. The platform apps router exposes:
   - `GET /api/platform/apps`
   - `GET /api/platform/apps/:appId`

Relevant files:

- `packages/core-backend/src/platform/app-manifest.ts`
- `packages/core-backend/src/platform/app-registry.ts`
- `packages/core-backend/src/routes/platform-apps.ts`
- `packages/core-backend/src/index.ts`

### Instance registry

The new table stores the tenant-scoped install state for installable apps.

Schema intent:

- one primary runtime instance per `workspace_id + app_id + instance_key`
- status tracks `active | inactive | failed`
- config and metadata remain JSON so plugins can evolve without schema churn

Relevant files:

- `packages/core-backend/src/db/migrations/zzzz20260413130000_create_platform_app_instances.ts`
- `packages/core-backend/src/services/PlatformAppInstanceRegistryService.ts`

### Frontend

The frontend shell uses one composable to normalize app state and primary action selection.

Primary action rules:

- plugin failed -> `Inspect shell`
- direct app -> `Open app`
- instance app with install binding and no instance -> `Install app`
- failed instance with install binding -> `Reinstall app`
- otherwise -> `Open onboarding`, `Open recovery`, `Review shell`, or `Open app`

Relevant files:

- `apps/web/src/composables/usePlatformApps.ts`
- `apps/web/src/views/PlatformAppLauncherView.vue`
- `apps/web/src/views/PlatformAppShellView.vue`
- `apps/web/tests/platform-app-actions.spec.ts`

## User-Facing Result

After this slice:

- `/apps` lists platform apps with correct runtime semantics
- `/apps/after-sales` can install or reinstall using the app-declared binding
- `/apps/attendance` opens as a direct runtime app and is not mislabeled as missing installation
- after-sales current state no longer depends only on legacy install ledger

## Risks and Constraints

- the shell currently trusts plugin-declared install bindings; bad manifest data will surface as runtime action failure
- install success feedback is shell-local and does not yet include rich plugin-specific progress or error rendering
- direct apps still do not expose a platform-level current-state contract, which is intentional for this slice

## Out of Scope for Next Slice

- generic plugin installation protocol
- progress streaming for install/reinstall
- richer recovery history in the shell
- aggregated platform app admin surfaces

