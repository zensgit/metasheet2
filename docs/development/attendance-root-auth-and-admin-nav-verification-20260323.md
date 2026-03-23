# Attendance Root Auth And Admin Nav Verification

Date: 2026-03-23

## Files touched

- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/AttendanceView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/attendance-admin-anchor-nav.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/attendance-import-batch-timezone-status.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/AuthService.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/rbac/rbac.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/attendance-admin.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/integration/attendance-plugin.test.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/setup.integration.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/plugins/plugin-attendance/index.cjs`

## Frontend verification

Commands:

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-anchor-nav.spec.ts tests/attendance-import-batch-timezone-status.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

Results:

- `attendance-admin-anchor-nav.spec.ts`: `2 passed`
- `attendance-import-batch-timezone-status.spec.ts`: `5 passed`
- combined run: `2 files / 7 tests passed`
- `vue-tsc --noEmit`: passed
- `apps/web build`: passed

Verified outcomes:

1. The import-batch snapshot panel no longer crashes when `previewSnapshot` exists without `context`.
2. Attendance admin mode now renders a left-side anchor navigation with one item per intended section.
3. Nested subsections such as `Holiday overrides` and `Template Versions` are not promoted into first-pass anchors.
4. Clicking `Import batches` scrolls to the correct anchor target and marks the nav item active.
5. `apps/web build` is green in the current attendance worktree verification pass.

## Backend integration verification

Command:

```bash
pnpm --filter @metasheet/core-backend test:integration:attendance
```

Result:

- `tests/integration/attendance-plugin.test.ts`: `18 passed`
- suite: `1 file / 18 tests passed`

Verified outcomes:

1. The earlier blanket auth/RBAC failures are gone.
2. Batch role operations no longer fall into the single-user route shadow.
3. Duplicate request and import normalization paths now pass inside the full attendance integration suite.
4. The suite is no longer stuck on the prior `401/403` baseline noise.

## Interpretation

This pass is now closed at verification level:

1. Frontend safety fix is locked.
2. Attendance admin anchor navigation is implemented and covered.
3. Root-repo attendance integration baseline is repaired.
4. Full attendance integration is green.
5. Frontend type-check and production build are green.

## Residual notes

- `apps/web build` still reports the existing Vite chunk-size warning on `index.js`, but that is a non-blocking build warning, not a failure.
