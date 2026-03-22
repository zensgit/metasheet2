# Attendance Low-Code Superiority TODO

Date: 2026-03-21
Scope: Phase 1 release candidate on `codex/attendance-run20-followup-20260320`

## Completed In This Phase

- [x] Audit current attendance admin surfaces against low-code benchmarks.
- [x] Define a release-candidate scope that can be fully landed without backend API expansion.
- [x] Keep structured rule builder and JSON config synchronized.
- [x] Add one-click rule preview scenario presets.
- [x] Add preview scorecards for flagged rows, punches, workday status, and work minutes.
- [x] Generate rule preview recommendations from builder state and preview result.
- [x] Expose resolved preview config returned by the preview API.
- [x] Add resolved-config change summary for changed, added, and removed leaf fields.
- [x] Add row-level rule preview diagnosis with severity, metrics, hints, and source payload.
- [x] Add batch inbox search and filters for status, engine, and source.
- [x] Add batch issue chips and search-based triage.
- [x] Add batch-level operator notes derived from anomaly summary.
- [x] Expose batch mapping payload in a dedicated mapping viewer.
- [x] Add structured snapshot diagnostics for metrics, policy, and engine sections.
- [x] Add snapshot copy/raw-view actions.
- [x] Update targeted rule and import batch tests.
- [x] Pass `vue-tsc --noEmit`.

## Verification Checklist

- [x] `pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminRulesAndGroups.spec.ts tests/AttendanceRulesAndGroupsSection.spec.ts tests/useAttendanceAdminImportBatches.spec.ts tests/AttendanceImportBatchesSection.spec.ts --watch=false`
- [x] `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
- [x] `pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminImportBatches.spec.ts tests/AttendanceImportBatchesSection.spec.ts tests/useAttendanceAdminRulesAndGroups.spec.ts tests/AttendanceRulesAndGroupsSection.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/AttendanceImportWorkflowSection.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts tests/AttendanceHolidayDataSection.spec.ts --watch=false`
- [x] `pnpm --filter @metasheet/web build`

## Next Phase Candidates

- [ ] Add batch-list inbox filters for creator and time range.
- [ ] Add rollback impact estimation and targeted retry guidance.
- [ ] Convert leave policies from JSON editing to visual builder flows.
- [ ] Convert payroll templates from JSON editing to visual builder flows.
- [ ] Add attendance-native workflow nodes and templates.
- [ ] Add data-scope and field-scope permission controls.
