# Attendance Calendar Policy Admin Quick-Add Verification

Date: 2026-05-23
Branch: `frontend/attendance-calendar-policy-admin-quick-add-20260523`
Base: `origin/main@2ef7f8046` (`#1783` design merged)

## 1. Scope

This slice implements the Admin/HR quick-add flow designed in
`docs/development/attendance-calendar-policy-admin-ux-design-20260523.md`.
It helps admins generate a group-scoped `calendarPolicy.overrides[]` row for
the common "base holiday is 5 days, this group rests 3 days" case.

No backend route, plugin resolver, migration, employee badge rendering, payroll
calculation, pending-leave, or team-availability behavior changed.

## 2. Changed Files

| File | Purpose |
| --- | --- |
| `apps/web/src/views/attendance/attendanceCalendarPolicyOverrides.ts` | Adds pure quick-add input/result types and `buildHolidayLengthCalendarPolicyOverride()`. |
| `apps/web/src/views/attendance/AttendanceCalendarPolicyQuickAdd.vue` | New shared quick-add panel used by both admin surfaces. |
| `apps/web/src/views/AttendanceView.vue` | Production admin settings surface mounts the shared quick-add panel. |
| `apps/web/src/views/attendance/AttendanceHolidayRuleSection.vue` | Extracted holiday-rule section mounts the same shared panel to prevent further drift. |
| `apps/web/tests/attendanceCalendarPolicyOverrides.spec.ts` | Helper and diagnostics regression coverage. |
| `apps/web/tests/useAttendanceHolidayRuleSection.spec.ts` | Extracted component render/append coverage. |
| `apps/web/tests/attendance-admin-regressions.spec.ts` | Production `AttendanceView.vue` render/append coverage. |

## 3. Implementation Evidence

- `baseRestDays=5`, `targetRestDays=3` generates one group-scoped workday
  exception:
  - `name = holidayName`
  - `match = contains`
  - `dayIndexStart = 4`
  - `dayIndexEnd = 5`
  - `source = group`
  - `isWorkingDay = true`
  - `attendanceGroups = <group>`
- `targetRestDays === baseRestDays` returns a no-op and does not append a row.
- `targetRestDays > baseRestDays` returns unsupported; v1 does not infer
  longer-than-base rest spans.
- Invalid holiday/group/day-count inputs return unsupported.
- Generated rows round-trip through `calendarPolicyOverridesFromForm()`.
- Existing diagnostics still catch incomplete manual group rows while accepting
  quick-add rows with a required group filter.
- The production surface and extracted component both mount the same
  `AttendanceCalendarPolicyQuickAdd.vue` component.

## 4. Test Evidence

Focused tests:

```text
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/attendanceCalendarPolicyOverrides.spec.ts tests/useAttendanceHolidayRuleSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false

✓ tests/attendanceCalendarPolicyOverrides.spec.ts  (9 tests)
✓ tests/useAttendanceHolidayRuleSection.spec.ts  (7 tests)
✓ tests/attendance-admin-regressions.spec.ts  (14 tests)

Test Files  3 passed (3)
Tests       30 passed (30)
```

Type check:

```text
pnpm --filter @metasheet/web exec vue-tsc --noEmit

PASS
```

Build:

```text
pnpm --filter @metasheet/web build

✓ built in 6.03s
```

Build emitted the existing Vite chunk-size and mixed dynamic/static import
warnings around `WorkflowDesigner.vue`; no new failure.

Diff check:

```text
git diff --check

PASS
```

## 5. Boundary Checks

- No files under `plugins/`, `packages/`, `migrations/`, or backend routes were
  changed.
- No employee-facing calendar badge logic changed.
- No `attendance_*` schema, payroll, auto-absence, or facts behavior changed.
- No role/roleTag quick-add was added; the helper only emits `source='group'`.
- `node_modules` symlinks were created only to reuse the main checkout test
  dependencies in the isolated worktree and are not part of the intended diff.

## 6. Follow-Up

Potential later work remains intentionally separate:

- longer-than-base holiday quick-add generation;
- role/roleTag quick-add after resolver context exists;
- refactoring the monolithic admin settings section to exclusively use extracted
  subsection components;
- team availability and pending leave calendar product designs.
