# Attendance Calendar Policy Extra-Rest Admin Design

Date: 2026-05-23
Branch: `docs/attendance-calendar-extra-rest-admin-design-20260523`
Base: `origin/main@9dab5784e` (`#1785` quick-add shipped)

## 1. Purpose

`#1785` added the Admin/HR quick-add path for the common shorter-holiday case:

> Base holiday is 5 rest days; Group A rests only 3 days.

That path correctly generates a group-scoped workday exception for holiday
`dayIndex` 4-5. The remaining admin-side gap is the opposite case:

> Base holiday is 3 rest days; Group B rests 5 days.

This design defines a narrow follow-up that lets the same quick-add panel handle
longer-than-base rest lengths without changing the backend resolver, employee
calendar rendering, payroll semantics, database schema, or effective-calendar
API contract.

## 2. Current Code Anchors

| Area | File / lines | Current behavior |
| --- | --- | --- |
| Quick-add design | `docs/development/attendance-calendar-policy-admin-ux-design-20260523.md` | Explicitly deferred longer-than-base holiday quick-add generation. |
| Quick-add verification | `docs/development/attendance-calendar-policy-admin-quick-add-verification-20260523.md` | Documents `targetRestDays > baseRestDays` as unsupported in `#1785`. |
| Quick-add helper | `apps/web/src/views/attendance/attendanceCalendarPolicyOverrides.ts` | `buildHolidayLengthCalendarPolicyOverride()` emits day-index workday rows for shorter rest spans and returns `target_longer_than_base` otherwise. |
| Quick-add UI | `apps/web/src/views/attendance/AttendanceCalendarPolicyQuickAdd.vue` | Renders holiday name, attendance group, base days, target days, label, and append button. No date anchor exists. |
| Production admin host | `apps/web/src/views/AttendanceView.vue` | Mounts the shared quick-add component above the advanced calendar-policy table. |
| Extracted host | `apps/web/src/views/attendance/AttendanceHolidayRuleSection.vue` | Mounts the same shared quick-add component for parity. |
| Backend matcher | `plugins/plugin-attendance/index.cjs` `matchCalendarOverride()` | If an override has `name`, a holiday row must exist and match; day-index filters also require holiday `dayIndex`. |

## 3. Critical Constraint

Longer-than-base extra rest dates usually do **not** have holiday rows.

Example:

- Base holiday row range: `2026-10-01` to `2026-10-03`
- Group target rest length: 5 days
- Extra rest dates: `2026-10-04` to `2026-10-05`

On `2026-10-04` and `2026-10-05`, `dayContext.holiday` may be `null`. Therefore a
calendar-policy row like this will **not** match:

```json
{
  "name": "国庆",
  "dayIndexStart": 4,
  "dayIndexEnd": 5,
  "filters": { "attendanceGroups": ["长假班组"] },
  "effective": { "isWorkingDay": false, "source": "group" }
}
```

It fails for two independent reasons:

- `name` requires an existing holiday row and matching `holiday.name`;
- `dayIndexStart/dayIndexEnd` require `holiday.dayIndex`.

So the longer-than-base helper must generate a **pure date-range + group filter**
rest override:

```json
{
  "from": "2026-10-04",
  "to": "2026-10-05",
  "filters": { "attendanceGroups": ["长假班组"] },
  "effective": {
    "source": "group",
    "isWorkingDay": false,
    "label": "国庆延休"
  }
}
```

Do not set `name`, `dayIndexStart`, `dayIndexEnd`, or any non-empty
`dayIndexList` on the longer-than-base generated row.

## 4. Design Decisions

### D1. Extend the existing quick-add panel

Do not add a second panel. The current panel already models "base rest length"
and "target rest length"; it should handle both directions:

- `targetRestDays < baseRestDays`: existing shorter-rest behavior, emit workday
  exception for holiday day indexes after the target length.
- `targetRestDays === baseRestDays`: no-op.
- `targetRestDays > baseRestDays`: new longer-rest behavior, emit rest-day
  exception for concrete dates after the base range.

### D2. Add one date anchor field

Add one optional field to the quick-add panel:

| Field | Type | Required | Purpose |
| --- | --- | --- | --- |
| Base rest start date | date | only when `targetRestDays > baseRestDays` | The first date of the base rest range, not necessarily the festival anchor date. |

Copy must be explicit:

- EN: `Required only when target rest days is greater than base rest days. Use the first date in the base rest range, not necessarily the festival date.`
- ZH: `仅当目标休息天数大于基础休息天数时必填。请填写基础休息范围的第一天，不一定是节日本身日期。`

This avoids confusing cases like National Day where the festival anchor may be
`10-01`, while the actual rest range may start earlier.

### D3. Compute extra rest range with UTC date arithmetic

For `targetRestDays > baseRestDays`:

```ts
extraStart = addDays(baseRestStartDate, baseRestDays)
extraEnd = addDays(baseRestStartDate, targetRestDays - 1)
```

Example:

| Input | Output |
| --- | --- |
| `baseRestStartDate=2026-10-01`, `baseRestDays=3`, `targetRestDays=5` | `from=2026-10-04`, `to=2026-10-05` |
| `baseRestStartDate=2026-09-29`, `baseRestDays=7`, `targetRestDays=9` | `from=2026-10-06`, `to=2026-10-07` |

Use date-only UTC helpers to avoid local timezone DST drift:

```ts
function parseDateOnly(value: string): Date | null
function addCalendarDays(date: Date, days: number): string
```

No browser-local `new Date('YYYY-MM-DD')` arithmetic in component code.

### D4. Keep shorter-rest behavior unchanged

For `targetRestDays < baseRestDays`, the helper must continue emitting the
existing day-index workday override:

```ts
{
  name: holidayName,
  match: 'contains',
  dayIndexStart: targetRestDays + 1,
  dayIndexEnd: baseRestDays,
  source: 'group',
  isWorkingDay: true,
  label: label || localizedDefaultLabel || `${holidayName}调班`,
  attendanceGroups: attendanceGroup,
}
```

The new date field is ignored in this path.

### D5. Longer-rest generated row contract

For `targetRestDays > baseRestDays`, and with a valid `baseRestStartDate`, emit:

```ts
{
  name: '',
  match: 'contains',
  date: '',
  from: extraStart,
  to: extraEnd,
  dayIndexStart: null,
  dayIndexEnd: null,
  dayIndexList: '',
  source: 'group',
  isWorkingDay: false,
  label: label || localizedExtraRestLabel || `${holidayName}延休`,
  attendanceGroups: attendanceGroup,
}
```

Important: `name` must be empty. A non-empty `name` would make
`matchCalendarOverride()` require a holiday row on the extra rest date and would
silently prevent the rule from matching.

### D6. Persisted schema stays unchanged

This is still a frontend helper over the existing `calendarPolicy.overrides[]`
shape. No backend route, migration, resolver, or zod schema change is required.

Preview and saved behavior remain backend-owned:

- draft preview: existing effective-calendar preview endpoint;
- saved behavior: existing `PUT /api/attendance/settings`;
- employee calendar: existing `GET /api/attendance/effective-calendar`.

### D7. Existing advanced editor remains available

The quick-add still only handles the group holiday-length use case. Admins can
use the advanced table for:

- exact single-day rest/work overrides;
- non-contiguous extra rest dates;
- org/user/role source rows;
- excludes;
- manually authored labels.

## 5. Helper Contract

Extend the existing helper input:

```ts
export interface CalendarPolicyHolidayLengthQuickAddInput {
  holidayName: string
  attendanceGroup: string
  baseRestDays: number
  targetRestDays: number
  baseRestStartDate?: string
  label?: string
  localizedDefaultLabel?: string
  localizedExtraRestLabel?: string
}
```

Extend the unsupported reasons:

```ts
export type CalendarPolicyHolidayLengthQuickAddResult =
  | { kind: 'append'; form: CalendarPolicyOverrideFormState }
  | { kind: 'noop'; reason: 'same_length' }
  | {
      kind: 'unsupported'
      reason: 'invalid_input' | 'missing_base_rest_start_date'
    }
```

`target_longer_than_base` is retired because longer-than-base is now supported
when a valid start date is supplied. Tests must explicitly preserve the old
no-date behavior as `missing_base_rest_start_date`.

Validation rules:

- `holidayName` and `attendanceGroup` still required for both directions.
- `baseRestDays` and `targetRestDays` must be finite integers >= 1.
- `baseRestStartDate` must be `YYYY-MM-DD` and calendar-valid when
  `targetRestDays > baseRestDays`.
- `baseRestStartDate` is optional and ignored for shorter/no-op paths.

## 6. UX Copy

Quick-add explanation should be broadened:

- EN: `Use this for "Group A rests 3 days while the base holiday is 5 days" or "Group B rests 5 days while the base holiday is 3 days." The helper creates a group-scoped calendar policy row.`
- ZH: `用于“某个考勤组在 5 天假期里只休 3 天”或“某个考勤组在 3 天基础假期上多休到 5 天”这类场景。系统会生成班组级日历规则。`

Status messages:

| Result | EN | ZH |
| --- | --- | --- |
| Shorter append | `Will add a group workday exception for holiday day X-Y.` | `将新增班组调班规则：节假日第 X-Y 天改为工作日。` |
| Longer append | `Will add a group rest exception from YYYY-MM-DD to YYYY-MM-DD.` | `将新增班组延休规则：YYYY-MM-DD 至 YYYY-MM-DD 改为休息日。` |
| Missing date | `Enter the base rest start date to generate extra rest days.` | `请填写基础休息起始日期，才能生成额外休息日规则。` |
| Same length | existing no-op copy | existing no-op copy |
| Invalid | existing invalid copy, expanded to mention date if target > base | existing invalid copy, expanded to mention date if target > base |

Button text can stay:

- EN: `Add group holiday rule`
- ZH: `添加班组节假日规则`

## 7. Tests

### Helper unit tests

Extend `apps/web/tests/attendanceCalendarPolicyOverrides.spec.ts`:

1. Existing shorter-rest test remains unchanged: base 5 / target 3 -> dayIndex
   4-5 workday group row.
2. Existing same-length no-op remains unchanged.
3. Existing longer-than-base unsupported test changes:
   - remove the old assertion that returned
     `reason: 'target_longer_than_base'`;
   - without `baseRestStartDate` -> `missing_base_rest_start_date`;
   - with `baseRestStartDate` -> append rest date-range row.
4. New longer-rest row assertions:
   - `from = 2026-10-04`, `to = 2026-10-05` for base start `2026-10-01`,
     base 3, target 5;
   - `isWorkingDay=false`;
   - `source='group'`;
   - `attendanceGroups=<group>`;
   - `label='国庆延休'`;
   - `name=''`;
   - `dayIndexStart` / `dayIndexEnd` are null or undefined;
   - `dayIndexList=''`.
5. Round-trip through `calendarPolicyOverridesFromForm()` must produce a wire
   row with `from/to`, `filters.attendanceGroups`, and `effective.isWorkingDay=false`,
   but **no** `name` and no effective day-index filters. The current frontend
   serializer may emit `dayIndexList: []`; backend normalization drops the empty
   array and `matchDayIndexFilter()` treats empty lists as no filter.
6. Invalid date strings are rejected.
7. Diagnostics still accept the generated longer-rest row; a manually bare group
   row still produces `missing_scope`.

### Component tests

Extend `apps/web/tests/useAttendanceHolidayRuleSection.spec.ts`:

- Fill target days > base days plus base rest start date.
- Click quick-add.
- Assert one calendar-policy row is appended with `from/to`, group, rest status,
  and label.
- Assert the advanced accordion expands.
- Assert status copy says the generated extra rest date range.

Extend `apps/web/tests/attendance-admin-regressions.spec.ts`:

- Production `AttendanceView.vue` path can append the longer-rest row.
- Use stable `data-calendar-policy-override-*` selectors, not placeholder text.

### Optional backend smoke

No backend code changes are required, so do not add a backend test unless a
frontend implementation uncovers a real contract gap.

For release confidence, run the existing DB-backed route smoke manually against
a scratch PostgreSQL DB:

```bash
DATABASE_URL=<scratch> ATTENDANCE_TEST_DATABASE_URL=<scratch> \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/attendance-plugin.test.ts -t "group-specific holiday lengths" --run
```

This existing test covers saved settings plus real
`/api/attendance/effective-calendar` group-specific behavior. If a dedicated
longer-rest backend test is later desired, it should seed a date-range group
rest override and prove the extra dates return `effective.source='group'` and
`effective.isWorkingDay=false`.

## 8. Implementation Plan

1. Rebase to latest `origin/main`; confirm worktree is clean.
2. Extend `CalendarPolicyHolidayLengthQuickAddInput` and result reason union.
3. Add date-only parse/add helpers inside `attendanceCalendarPolicyOverrides.ts`.
4. Implement longer-than-base branch:
   - require valid `baseRestStartDate`;
   - compute extra `from/to`;
   - emit date-range group rest row with empty `name` and no day-index filters.
5. Update `AttendanceCalendarPolicyQuickAdd.vue`:
   - add `baseRestStartDate` date input;
   - show copy explaining it is required only for longer-than-base;
   - add `localizedExtraRestLabel`;
   - update status messages.
6. Keep production and extracted host wiring unchanged; they already consume the
   shared component.
7. Extend helper tests.
8. Extend extracted component test.
9. Extend production regression test.
10. Add verification MD with:
    - changed-file list;
    - shorter path regression;
    - longer path evidence;
    - explicit "name/dayIndex omitted for longer rows" evidence;
    - no backend/schema/payroll/employee rendering changes.
11. Run:
    - `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/attendanceCalendarPolicyOverrides.spec.ts tests/useAttendanceHolidayRuleSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false`
    - `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
    - `pnpm --filter @metasheet/web build`
    - `git diff --check origin/main..HEAD`
12. Commit and stop before push.

## 9. Acceptance Criteria

- Admin can generate the existing shorter-rest rule exactly as shipped in
  `#1785`.
- Admin can generate a longer-rest group row by entering base rest start date,
  base rest days, and target rest days.
- Longer-rest generated row serializes to existing `calendarPolicy.overrides[]`
  shape with `from/to`, group filter, `source='group'`, and
  `effective.isWorkingDay=false`.
- Longer-rest generated row does not include `name` or effective day-index
  filters (`dayIndexStart`/`dayIndexEnd` empty and `dayIndexList` empty or
  omitted).
- Existing diagnostics still catch missing scope and invalid ranges.
- Production admin page and extracted component remain in parity through the
  shared quick-add component.
- No backend route, migration, resolver, payroll, pending-leave, team availability,
  or employee badge rendering changes.

## 10. Deferred

- Non-contiguous extra rest periods.
- Role/roleTag longer-rest quick-add.
- Reading base holiday range from the backend automatically.
- Full calendar-policy override import/export.
- Refactoring the monolithic attendance admin settings section to exclusively
  use extracted subsection components.
