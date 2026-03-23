# Attendance Timezone Selector Verification 2026-03-23

## Scope Verified

Verified that attendance admin timezone fields now use selectors with UTC offset labels and continue to write raw timezone identifiers into the bound form state.

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
2. `15` tests passed

### Type Check

`vue-tsc --noEmit` passed.

### Production Build

`pnpm --filter @metasheet/web build` passed.

The existing Vite chunk-size warning remains, but it is unrelated to this change.

## Behavior Verified

1. Rule builder timezone field is now a selector and renders labels like `Asia/Shanghai (UTC+08:00)`.
2. Attendance group timezone selector renders the same labeled options.
3. Scheduling admin timezone selectors for default rules, rotation rules, and shifts show `UTC±HH:MM`.
4. Holiday sync auto timezone is now a selector instead of a raw text input.
5. Import timezone and optional group timezone are selectors and the import plan summary shows the labeled timezone.
6. Stored values remain raw IANA timezone identifiers such as `Asia/Shanghai`.
