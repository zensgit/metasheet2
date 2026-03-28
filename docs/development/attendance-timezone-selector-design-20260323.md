# Attendance Timezone Selector Design 2026-03-23

## Background

Several attendance admin forms still required operators to type raw IANA timezones such as `Asia/Shanghai` or `Europe/London`.

That created two usability issues:

1. Operators had to remember exact timezone identifiers.
2. The UI did not show the effective UTC offset, so it was hard to confirm whether the selected timezone was `UTC+8`, `UTC+0`, or another offset.

## Goal

Replace raw timezone text inputs in the main attendance admin flows with shared selectors that:

1. Use existing IANA timezone values as the stored payload.
2. Show the current UTC offset in the option label.
3. Keep existing API payloads unchanged.

## Scope

This change updates the following attendance admin surfaces:

1. Rule set structured builder in `AttendanceRulesAndGroupsSection.vue`
2. Attendance group timezone selector in `AttendanceRulesAndGroupsSection.vue`
3. Default rule / rotation rule / shift timezone fields in `AttendanceSchedulingAdminSection.vue`
4. Holiday sync auto timezone in `AttendanceHolidayRuleSection.vue`
5. Import timezone and optional group timezone in `AttendanceImportWorkflowSection.vue`
6. Payroll template timezone labels in `AttendancePayrollAdminSection.vue`

## Shared Design

The shared timezone utility now exposes:

1. `formatTimezoneOffsetLabel(timezone)` to normalize the runtime offset into `UTC±HH:MM`
2. `formatTimezoneOptionLabel(timezone)` to render labels such as `Asia/Shanghai (UTC+08:00)`
3. `buildTimezoneOptionEntries(currentValue)` to produce `{ value, label }` option lists

The stored value remains the raw timezone identifier, for example `Asia/Shanghai`.
Only the rendered label changes.

## UX Decision

The selector is intentionally not grouped by region or filtered yet.

Reason:

1. The repository already has a shared timezone source based on `Intl.supportedValuesOf('timeZone')`.
2. Switching from free text to select already removes the main operator error.
3. Adding region grouping or search would be a second-step enhancement and should be done only if the current flat selector proves too large in production.

## Compatibility

This change is backward compatible:

1. Existing saved timezone strings still render correctly.
2. Unknown custom values still remain selectable because the current value is injected into the option list when needed.
3. API payloads and server-side validation do not change.

## Out of Scope

This change does not:

1. Rework backend timezone handling
2. Add fuzzy timezone search
3. Reorganize all settings screens outside the attendance admin flow

## Post-Merge Status

This design shipped to `main` on `2026-03-23`.

1. Pull request: `#542 feat(attendance-ui): add timezone selectors with offset labels`
2. Merge commit: `8fba63dcfe08490bb728f2f230079498072f2a8a`
3. The post-merge `main` workflow chain for this commit completed without red jobs.

That means the selector-based timezone UX described in this document is no longer a branch-only proposal. It is the current `main` behavior baseline.
