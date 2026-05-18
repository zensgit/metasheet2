# Multitable Default Entry Post-Merge Verification - 2026-05-18

## Result

PASS.

This post-merge verification confirms that PR #1618 made `/multitable` the default table entry while keeping the legacy spreadsheet-style routes reachable by direct URL.

## Scope

- PR: https://github.com/zensgit/metasheet2/pull/1618
- Merge commit: `b53168cecc89a0bab2e1dff5f301f5e8ff1bbfdb`
- Merge time: `2026-05-18T05:10:12Z`
- Verification base: `origin/main@bda0cf899`
- Verification worktree: `/private/tmp/ms2-multitable-entry-postmerge-20260518`

This document is evidence-only. It does not change route behavior, product policy, permissions, migrations, OpenAPI, or the Phase 3 TODO state.

## User-Facing Contract Verified

| Contract | Evidence | Status |
| --- | --- | --- |
| Primary shell navigation exposes Multitable | `apps/web/src/App.vue` renders a top-level router link to `/multitable` | PASS |
| Primary shell navigation no longer promotes legacy Grid / Spreadsheets | `App.vue` no longer renders top-level `/grid` or `/spreadsheets` navigation links | PASS |
| `/multitable` has a first-class route | `apps/web/src/router/appRoutes.ts` registers `ROUTE_PATHS.MULTITABLE_HOME` before the parameterized multitable route | PASS |
| Legacy `/grid` route remains directly reachable | `appRoutes.ts` still registers `/grid` with `GridView` | PASS |
| Legacy `/spreadsheets` route remains directly reachable | `appRoutes.ts` still registers `/spreadsheets` and `/spreadsheets/:id` | PASS |
| Default frontend home resolution points to Multitable | `apps/web/src/stores/featureFlags.ts` returns `/multitable` for platform/default mode | PASS |
| Platform onboarding points to Multitable | `packages/core-backend/src/auth/access-presets.ts` sets platform preset `homePath` to `/multitable` and fallback home path to `/multitable` | PASS |

## Commands Run

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Result: PASS.

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-home-view.spec.ts \
  tests/platform-shell-nav.spec.ts \
  --watch=false
```

Result: PASS.

```text
Test Files  2 passed (2)
Tests       5 passed (5)
```

```bash
pnpm type-check
```

Result: PASS.

```text
apps/web type-check: Done
```

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: PASS.

## CI Status

PR #1618 completed CI after the type fix commit and was merged by admin squash.

Observed PR checks before merge:

- `contracts (strict)`: SUCCESS
- `contracts (dashboard)`: SUCCESS
- `contracts (openapi)`: SUCCESS
- `pr-validate`: SUCCESS
- `telemetry-plugin`: SUCCESS
- `migration-replay`: SUCCESS
- `core-backend-cache`: SUCCESS
- `K3 WISE offline PoC`: SUCCESS
- `DingTalk P4 ops regression gate`: SUCCESS
- `test (18.x)`: SUCCESS
- `test (20.x)`: SUCCESS
- `after-sales integration`: SUCCESS
- `coverage`: SUCCESS
- `e2e`: SUCCESS
- `Strict E2E with Enhanced Gates`: SKIPPED

The first CI run failed on `apps/web/src/router/types.ts` because the newly introduced `multitable-home` route name was missing from `AppRouteParams`. The follow-up commit added the no-param route entry, and the rerun passed.

## Staging Smoke

Not run in this verification pass.

Reason: this is a post-merge source-level and CI verification for a navigation/default-entry change. It does not require a backend migration, data mutation, or staging-only environment variable. A staging smoke is still useful before a user-facing release if 142 or another staging environment is available.

Recommended staging smoke when a staging URL and valid app session are available:

1. Open the staging app root or login redirect target.
2. Confirm the default platform landing path resolves to `/multitable`.
3. Confirm the top navigation contains the Multitable entry.
4. Confirm `/grid` still loads by direct URL.
5. Confirm `/spreadsheets` still loads by direct URL.
6. Confirm no user-facing link sends platform users to `/grid` as the primary table entry.

## Non-Goals

- Did not remove `/grid` or `/spreadsheets`.
- Did not migrate legacy spreadsheet data.
- Did not redirect old URLs.
- Did not change multitable record/grid semantics.
- Did not update OpenAPI.
- Did not touch K3, Data Factory, Attendance, DingTalk, or plugin-integration-core code.

## Final Verdict

`/multitable` is now the primary table entry on main. Legacy Grid and Spreadsheets remain direct-access compatibility surfaces, not primary product navigation.
