# Attendance Timezone Selector Groups Verification 2026-03-23

## Scope Verified

Verified that attendance admin timezone selectors now render grouped options with a leading common-timezone bucket, while still persisting raw IANA timezone values.

## Commands

Executed in `/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-run20-field-compat-20260320`:

1. `pnpm --filter @metasheet/web exec vitest run tests/attendanceTimezones.spec.ts tests/AttendanceRulesAndGroupsSection.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts tests/useAttendanceHolidayRuleSection.spec.ts tests/AttendanceImportWorkflowSection.spec.ts --watch=false`
2. `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
3. `pnpm --filter @metasheet/web build`

## Results

### Vitest

Passed:

1. `tests/attendanceTimezones.spec.ts`
2. `tests/AttendanceRulesAndGroupsSection.spec.ts`
3. `tests/AttendanceSchedulingAdminSection.spec.ts`
4. `tests/useAttendanceHolidayRuleSection.spec.ts`
5. `tests/AttendanceImportWorkflowSection.spec.ts`

Summary:

1. `5` files passed
2. `16` tests passed

### Type Check

`vue-tsc --noEmit` passed.

### Production Build

`pnpm --filter @metasheet/web build` passed.

The existing Vite chunk-size warning remains unrelated to this selector grouping change.

## Behavior Verified

1. Shared timezone options are grouped into `Common timezones` plus regional buckets.
2. Rule set builder and attendance group selectors render grouped options.
3. Scheduling selectors for default rules, rotation rules, and shifts render grouped options.
4. Holiday sync auto timezone renders grouped options.
5. Import timezone and group timezone render grouped options.
6. The selected option labels still show `UTC±HH:MM`.
7. Stored values remain raw timezone strings such as `UTC` and `Asia/Shanghai`.
