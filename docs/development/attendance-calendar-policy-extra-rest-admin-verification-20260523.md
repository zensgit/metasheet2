# Attendance Calendar Policy Extra-Rest Admin Verification

Date: 2026-05-23
Branch: `frontend/attendance-calendar-extra-rest-quick-add-20260523`
Base: `origin/main@dc24a793d` (`#1786` design)

## 1. DoD

- Existing shorter-rest quick-add path remains unchanged: base 5 / target 3
  still emits a group-scoped workday override for holiday day indexes 4-5.
- New longer-rest path works: base 3 / target 5 plus base rest start date
  emits a group-scoped rest override for `from=2026-10-04` to
  `to=2026-10-05`.
- Longer-rest generated rows do not set `name`, `dayIndexStart`, or
  `dayIndexEnd`; `dayIndexList` stays empty so backend normalization treats it
  as no day-index filter.
- Production `AttendanceView.vue` and extracted
  `AttendanceHolidayRuleSection.vue` both consume the shared quick-add
  component and can append the longer-rest row.
- No backend route, migration, resolver, effective-calendar API contract,
  payroll, employee badge rendering, pending-leave, or team-availability code
  changed.

## 2. Changed Files

Implementation:

- `apps/web/src/views/attendance/attendanceCalendarPolicyOverrides.ts`
- `apps/web/src/views/attendance/AttendanceCalendarPolicyQuickAdd.vue`
- `apps/web/src/views/attendance/AttendanceHolidayRuleSection.vue`
- `apps/web/src/views/AttendanceView.vue`

Tests:

- `apps/web/tests/attendanceCalendarPolicyOverrides.spec.ts`
- `apps/web/tests/useAttendanceHolidayRuleSection.spec.ts`
- `apps/web/tests/attendance-admin-regressions.spec.ts`

Docs:

- `docs/development/attendance-calendar-policy-extra-rest-admin-verification-20260523.md`

## 3. Implementation Evidence

Helper contract:

- `CalendarPolicyHolidayLengthQuickAddInput` now accepts
  `baseRestStartDate?: string` and `localizedExtraRestLabel?: string`.
- `target_longer_than_base` was retired from the active result union. The no-date
  longer-rest path returns `missing_base_rest_start_date`.
- `parseDateOnly()` validates strict `YYYY-MM-DD` calendar dates using UTC
  component round-trip checks. `2026-02-30` is rejected.
- `addCalendarDays()` uses UTC date-only arithmetic and formats back to
  `YYYY-MM-DD`.

Generated longer-rest row:

```ts
{
  name: '',
  match: 'contains',
  date: '',
  from: '2026-10-04',
  to: '2026-10-05',
  dayIndexStart: null,
  dayIndexEnd: null,
  dayIndexList: '',
  source: 'group',
  isWorkingDay: false,
  label: '国庆延休',
  attendanceGroups: '长假班组',
}
```

Wire shape after `calendarPolicyOverridesFromForm()`:

- `from='2026-10-04'`
- `to='2026-10-05'`
- `filters.attendanceGroups=['长假班组']`
- `effective.source='group'`
- `effective.isWorkingDay=false`
- `name === undefined`
- `match === undefined`
- `dayIndexStart === undefined`
- `dayIndexEnd === undefined`
- `dayIndexList === []`

The empty `dayIndexList` is intentional with the current serializer. Backend
normalization drops empty arrays and `matchDayIndexFilter()` treats empty lists
as no filter, so this is not an effective day-index filter.

UI evidence:

- `AttendanceCalendarPolicyQuickAdd.vue` adds
  `data-calendar-policy-quick-base-start-date`.
- The base rest start date field is always visible, with copy saying it is only
  required when target rest days exceed base rest days.
- Status copy now distinguishes:
  - shorter path: `Will add a group workday exception for holiday day X-Y.`
  - longer path: `Will add a group rest exception from YYYY-MM-DD to YYYY-MM-DD.`
  - missing date: `Enter the base rest start date to generate extra rest days.`
- `AttendanceView.vue` and `AttendanceHolidayRuleSection.vue` now expose stable
  date-range selectors:
  - `data-calendar-policy-override-date`
  - `data-calendar-policy-override-from`
  - `data-calendar-policy-override-to`

## 4. Test Evidence

Focused vitest:

```text
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/attendanceCalendarPolicyOverrides.spec.ts tests/useAttendanceHolidayRuleSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false

✓ tests/attendanceCalendarPolicyOverrides.spec.ts  (10 tests)
✓ tests/useAttendanceHolidayRuleSection.spec.ts  (8 tests)
✓ tests/attendance-admin-regressions.spec.ts  (15 tests)

Test Files  3 passed (3)
Tests       33 passed (33)
```

Type-check:

```text
pnpm --filter @metasheet/web exec vue-tsc --noEmit
EXIT 0
```

Build:

```text
pnpm --filter @metasheet/web build

✓ 2426 modules transformed.
✓ built in 6.09s
EXIT 0
```

Diff check:

```text
git diff --check origin/main..HEAD
EXIT 0
```

## 5. Regression Matrix

| Surface | Assertion |
| --- | --- |
| Helper shorter path | Base 5 / target 3 still emits `name='国庆'`, `dayIndexStart=4`, `dayIndexEnd=5`, `isWorkingDay=true`. |
| Helper same-length path | Base 5 / target 5 remains `noop: same_length`. |
| Helper longer path without date | Base 3 / target 5 returns `unsupported: missing_base_rest_start_date`. |
| Helper longer path with date | Base 3 / target 5 / `2026-10-01` emits `from=2026-10-04`, `to=2026-10-05`, `isWorkingDay=false`. |
| Helper invalid date | `2026-02-30` returns `unsupported: invalid_input`. |
| Serializer | Longer-rest wire row has no `name`, no `match`, no start/end day-index filters, and an empty `dayIndexList`. |
| Diagnostics | Generated shorter and longer rows do not trigger missing-scope; manually bare group rows still do. |
| Extracted section | `AttendanceHolidayRuleSection.vue` appends the longer-rest row and expands the advanced accordion. |
| Production admin | `AttendanceView.vue` appends the longer-rest row through stable `data-calendar-policy-*` selectors. |

## 6. Scope Boundaries

Not changed:

- `plugins/plugin-attendance/index.cjs`
- backend migrations
- backend route validation
- effective-calendar resolver matching
- employee calendar badge rendering
- payroll/comprehensive-hours logic
- pending leave or team availability surfaces

Optional backend smoke from the design was not run in this implementation pass
because no backend/schema/resolver code changed. Existing real-route coverage for
group-specific holiday lengths remains the backend confidence anchor.

## 7. Worktree Notes

The implementation worktree uses dependency symlinks:

- `node_modules -> /Users/chouhua/Downloads/Github/metasheet2/node_modules`
- `apps/web/node_modules -> /Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules`
- `packages/core-backend/node_modules -> /Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/node_modules`

`apps/web/dist/` was generated by the build. These paths are not part of the PR
diff and must not be staged.
