# Multitable App Shell Route Mount

Date: 2026-03-26
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Goal

Mount the restored multitable frontend into the real Vue app shell so the direct pilot URLs already documented by the runbooks stop pointing at an unmapped route.

Target contract:

```text
/multitable/<sheetId>/<viewId>?baseId=<baseId>
/multitable/<sheetId>/<viewId>?baseId=<baseId>&mode=form&recordId=<recordId>
```

## Why This Slice

Recent multitable recovery work restored runtime, workbench, and pilot tooling, but `apps/web/src/main.ts` still had no `/multitable/...` route. That left:

- `scripts/verify-multitable-live-smoke.mjs`
- `docs/deployment/multitable-internal-pilot-runbook-20260319.md`
- `docs/deployment/multitable-pilot-quickstart-20260319.md`

all depending on a direct URL pattern that the app shell did not actually mount.

This is a higher-value unblocker than additional local widget polish because it turns the recovered multitable workbench into a reachable first-party route.

## Scope

Smallest safe route-mount slice:

- add typed `/multitable/:sheetId/:viewId`
- map `baseId`, `recordId`, `mode`, `embedded`, and `role` from query into `MultitableEmbedHost`
- keep existing auth/navigation guards unchanged
- do not add a top-nav entry yet
- do not add a new feature flag yet
- do not refactor `MultitableWorkbench` internals

## Implementation

### Route typing

Updated `apps/web/src/router/types.ts`:

- add `AppRouteNames.MULTITABLE`
- add `AppRouteParams['multitable']`
- add `AppRouteQuery['multitable']`
- add `ROUTE_PATHS.MULTITABLE`

### Route helper extraction

Added `apps/web/src/router/multitableRoute.ts`:

- `resolveMultitableRouteProps()`
- `buildMultitableRoute()`

Reason:

Claude Code's smallest-slice recommendation was directionally correct: land only the route mount and avoid touching workbench internals. In this tree, a direct test import of `main.ts` pulled app-shell CSS dependencies into Vitest and made the route contract hard to test cleanly. Extracting a route-local helper kept the change small while making the URL-to-props contract testable without importing the whole bootstrap module.

### App shell wiring

Updated `apps/web/src/router/appRoutes.ts` and `apps/web/src/main.ts`:

- route table now includes `buildMultitableRoute(() => import('../multitable/views/MultitableEmbedHost.vue'))`
- `main.ts` now consumes `appRoutes`
- existing auth/title/feature guards remain untouched

### Verification surface

Added `apps/web/tests/multitable-embed-route.spec.ts` to lock:

- `/multitable/<sheetId>/<viewId>?baseId=<baseId>`
- `/multitable/<sheetId>/<viewId>?baseId=<baseId>&mode=form&recordId=<recordId>`

against the actual route helper contract.

## Non-Goals

Not in this slice:

- top navigation entry for multitable
- embed-only `/multitable/embed/...` route
- new multitable-specific product flag
- workbench refactors
- additional import modal polish

## Files

- `apps/web/src/router/types.ts`
- `apps/web/src/router/multitableRoute.ts`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/main.ts`
- `apps/web/tests/multitable-embed-route.spec.ts`
