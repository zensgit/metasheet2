# Attendance Timezone Status Hints Design 2026-03-23

## Background

The attendance admin timezone rollout already completed two steps:

1. raw timezone text inputs were replaced with native selectors
2. the selectors were upgraded to grouped `<optgroup>` lists with UTC offset labels

That removed validation problems, but a usability gap remained: once an operator finished selecting a timezone, many forms no longer made the effective timezone obvious without reopening the selector.

The gap was biggest in two places:

1. import group sync, where the group timezone can inherit the import timezone
2. payroll actions, where status feedback did not carry the selected template timezone context

## Goal

Make timezone intent visible in-place and in action feedback, without changing stored payloads or backend timezone semantics.

## Scope

This update adds status hints to:

1. structured rule builder timezone
2. attendance group timezone
3. default rule timezone
4. rotation rule timezone
5. shift timezone
6. holiday sync auto timezone
7. import timezone
8. import group timezone
9. payroll template timezone
10. payroll cycle template context
11. payroll batch-generate template context

It also appends timezone context to:

1. import preview success feedback
2. import run success feedback
3. local import validation feedback
4. payroll summary success feedback
5. payroll cycle save / generate feedback

## Shared Design

The shared attendance timezone helper now exposes a second display format:

1. selector labels stay as `Asia/Shanghai (UTC+08:00)`
2. status labels use `UTC+08:00 · Asia/Shanghai`

Reason:

1. selector labels optimize for scanning by timezone name
2. status lines optimize for “what offset is actually in effect right now”

## UX Decisions

Form-level hints use two patterns:

1. `Current: UTC+08:00 · Asia/Shanghai`
2. `Current effective timezone: Use import timezone (UTC+08:00 · Asia/Shanghai)`

The second pattern is reserved for fields with inheritance/fallback behavior.

Status feedback keeps the existing primary message and appends timezone context as a secondary hint instead of rewriting the main message.

Default / inherited selector options also surface effective timezone context inline where that context is knowable:

1. import group timezone blank option now renders `Use import timezone (UTC+08:00 · Asia/Shanghai)`
2. payroll cycle template options now render template timezone context inline
3. payroll batch-generate blank option now renders the current default template and its timezone context

This reduces the need to scan down to the hint line just to understand what a blank/default selection actually means.

## Implementation

Core helper:

- [attendanceTimezones.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-run20-field-compat-20260320/apps/web/src/views/attendance/attendanceTimezones.ts)

Form sections:

- [AttendanceRulesAndGroupsSection.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-run20-field-compat-20260320/apps/web/src/views/attendance/AttendanceRulesAndGroupsSection.vue)
- [AttendanceSchedulingAdminSection.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-run20-field-compat-20260320/apps/web/src/views/attendance/AttendanceSchedulingAdminSection.vue)
- [AttendanceHolidayRuleSection.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-run20-field-compat-20260320/apps/web/src/views/attendance/AttendanceHolidayRuleSection.vue)
- [AttendanceImportWorkflowSection.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-run20-field-compat-20260320/apps/web/src/views/attendance/AttendanceImportWorkflowSection.vue)
- [AttendancePayrollAdminSection.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-run20-field-compat-20260320/apps/web/src/views/attendance/AttendancePayrollAdminSection.vue)

Status feedback:

- [AttendanceView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-run20-field-compat-20260320/apps/web/src/views/AttendanceView.vue)
- [useAttendanceAdminImportWorkflow.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-run20-field-compat-20260320/apps/web/src/views/attendance/useAttendanceAdminImportWorkflow.ts)
- [useAttendanceAdminPayroll.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-run20-field-compat-20260320/apps/web/src/views/attendance/useAttendanceAdminPayroll.ts)

## Compatibility

This change is UI-only and backward compatible:

1. stored timezone values remain raw IANA strings
2. request payloads remain unchanged
3. grouped selector behavior stays intact
4. backend timezone validation and fallback chains do not change

## Out of Scope

This update does not:

1. add fuzzy timezone search
2. infer timezone from org metadata
3. change backend import/payroll timezone resolution rules
4. replace native `<select>` with a custom combobox
