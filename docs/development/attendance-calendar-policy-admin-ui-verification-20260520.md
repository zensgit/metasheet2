# Attendance Calendar Policy Admin UI — Verification

Date: 2026-05-20
Branch: `codex/attendance-calendar-policy-admin-ui-20260520`
Base: `origin/main@37013f269`

## Test Matrix

| Check | Result |
| --- | --- |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminConfig.spec.ts tests/useAttendanceHolidayRuleSection.spec.ts --watch=false` | PASS — 2 files / 9 tests |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts --watch=false` | PASS — 1 file / 11 tests |
| `pnpm --filter @metasheet/web type-check` | PASS |
| `pnpm --filter @metasheet/web build` | PASS |
| `git diff --check` | PASS |

## Coverage Notes

- `useAttendanceAdminConfig.spec.ts` verifies:
  - API `settings.calendarPolicy.overrides[]` loads into the reactive form.
  - The save payload writes `calendarPolicy.overrides[]` with date/range,
    day-index constraints, filters, and `effective` metadata.
  - Existing holiday policy and holiday sync payload behavior remains intact.
- `useAttendanceHolidayRuleSection.spec.ts` verifies:
  - The effective-calendar accordion opens when a rule is added.
  - The auto-absence impact warning is visible.
  - The role source option is present but disabled/reserved.
  - Existing holiday override accordion behavior remains intact.
- `attendance-admin-regressions.spec.ts` verifies the mounted
  `AttendanceView.vue` admin surface still renders and exercises existing
  admin regressions after the monolithic settings section was updated.

## Boundaries Verified

- No backend code changes beyond syntax checking the existing plugin file.
- No `attendance_*` migration or fact-source move.
- No direct `meta_*` writes.
- Existing `PUT /api/attendance/settings` remains the only persistence path.
- `node_modules` symlink changes were produced by `pnpm install` in the
  isolated worktree and are intentionally excluded from the slice boundary.

## Deferred

- Inline preview inside the settings editor. The current safe path is:
  save settings, then inspect the existing effective-calendar surfaces. A
  future preview panel can call `GET /api/attendance/effective-calendar` with
  explicit org/group/user mode after UX for preview target selection is pinned.
- Role / roleTag resolver context. The UI keeps this source reserved until the
  backend loads role context for effective-calendar matching.
