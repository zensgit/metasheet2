# Attendance Group Admin Extracted Component Reconcile Verification

Date: 2026-05-28
Branch: `codex/attendance-group-reconcile-20260528`
Issue: `#1954`

## 1. Purpose

Issue `#1954` required reconciling the stale extracted attendance rules/groups component before Slice C or any reused extracted-component path.

The production attendance group manager now lives in `apps/web/src/views/AttendanceView.vue` after Slice A and Slice B. The extracted `AttendanceRulesAndGroupsSection.vue` still represented the older form/table variant and was not rendered by the production admin surface.

Lineage note: the `#1946` design lock allowed either wiring `AttendanceRulesAndGroupsSection.vue` into `AttendanceView.vue` or porting the list-detail structure into the existing inline production section; Slice A chose the port path, so this follow-up retires the now-stale extracted component.

## 2. Decision

Retire the stale extracted component instead of updating it into a second full implementation.

Removed:

- `apps/web/src/views/attendance/AttendanceRulesAndGroupsSection.vue`
- `apps/web/tests/AttendanceRulesAndGroupsSection.spec.ts`

Kept:

- `apps/web/src/views/attendance/useAttendanceAdminRulesAndGroups.ts`
- `apps/web/tests/useAttendanceAdminRulesAndGroups.spec.ts`
- Production coverage in `apps/web/tests/attendance-admin-anchor-nav.spec.ts`
- Production regression coverage in `apps/web/tests/attendance-admin-regressions.spec.ts`

This leaves one attendance group admin UI path: the production `AttendanceView.vue` list-detail manager.

## 3. Boundary Check

This reconcile slice intentionally does not:

- add backend routes;
- add schema, migrations, or permissions;
- add attendance fact writes;
- start fixed-schedule modeling;
- start weekly matrix editing;
- start punch-method configuration;
- start export/copy behavior;
- start member enrichment;
- change the `#1954` Slice C boundary.

## 4. Verification Plan

Run the production and composable tests that now own the remaining supported behavior:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/useAttendanceAdminRulesAndGroups.spec.ts \
  tests/attendance-admin-anchor-nav.spec.ts \
  tests/attendance-admin-regressions.spec.ts \
  --watch=false
```

Run source checks:

```bash
rg -n "AttendanceRulesAndGroupsSection" apps/web/src apps/web/tests
git diff --check origin/main...HEAD
```

Expected:

- no runtime/test import of the retired component remains;
- production attendance group tests still pass;
- the rules/groups composable tests still pass;
- diff is limited to retiring the stale component/spec plus this verification note.

## 5. Result

Executed:

```bash
rg -n "AttendanceRulesAndGroupsSection" apps/web/src apps/web/tests
git diff --check
pnpm --filter @metasheet/web exec vitest run \
  tests/useAttendanceAdminRulesAndGroups.spec.ts \
  tests/attendance-admin-anchor-nav.spec.ts \
  tests/attendance-admin-regressions.spec.ts \
  --watch=false
```

Result:

- `AttendanceRulesAndGroupsSection` no longer appears under `apps/web/src` or `apps/web/tests`.
- `git diff --check` passed.
- Frontend targeted tests passed: 3 files, 66 tests.
