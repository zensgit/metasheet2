# Attendance Workflow Handoff Verification

Date: 2026-03-22
Branch: `codex/attendance-postrelease-next-20260322`
Published baseline release: `attendance-onprem-run21-20260322`

## Purpose

Verify that the new attendance approval -> workflow designer handoff works as a frontend-only, route-query-driven bridge on top of the already-published attendance baseline.

## Targeted Handoff Validation

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendanceWorkflowHandoff.spec.ts tests/AttendanceLeavePoliciesSection.spec.ts tests/useAttendanceAdminLeavePolicies.spec.ts tests/attendance-workflow-designer-zh.spec.ts tests/attendance-experience-zh-tabs.spec.ts --watch=false
```

Result:

- `5 files`
- `18 tests passed`

Covered behaviors:

- attendance handoff query generation
- handoff query parsing
- leave approval builder CTA navigation
- workflow wrapper handoff copy and actions
- attendance shell landing on `tab=workflow` when handoff query is present
- existing leave approval visual builder tests remain green

## Wider Attendance Admin Regression

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendanceWorkflowHandoff.spec.ts tests/attendance-workflow-designer-zh.spec.ts tests/attendance-experience-zh-tabs.spec.ts tests/useAttendanceAdminLeavePolicies.spec.ts tests/AttendanceLeavePoliciesSection.spec.ts tests/useAttendanceAdminImportBatches.spec.ts tests/AttendanceImportBatchesSection.spec.ts tests/useAttendanceAdminRulesAndGroups.spec.ts tests/AttendanceRulesAndGroupsSection.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/AttendanceImportWorkflowSection.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts tests/AttendanceHolidayDataSection.spec.ts --watch=false
```

Result:

- `14 files`
- `88 tests passed`

This confirms the new workflow handoff did not regress the previously delivered attendance admin capabilities:

- leave approval builder
- import workflow
- batch triage and rollback guidance
- rules and groups
- scheduling admin
- holiday data

## Type And Build Gates

Command:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

- passed

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

- passed
- the existing Vite large-chunk warning remains, but build output completed successfully

## Verified Files

- `apps/web/src/views/attendance/attendanceWorkflowHandoff.ts`
- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`
- `apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue`
- `apps/web/src/views/WorkflowDesigner.vue`
- `apps/web/tests/attendanceWorkflowHandoff.spec.ts`
- `apps/web/tests/AttendanceLeavePoliciesSection.spec.ts`
- `apps/web/tests/attendance-workflow-designer-zh.spec.ts`
- `apps/web/tests/attendance-experience-zh-tabs.spec.ts`

## Residual Risks

The following are still intentionally open after this slice:

- no auto-instantiated workflow starter yet
- no verification of reverse binding from workflow draft back to attendance approval flow
- no repair of the standalone `workflow-designer` route yet
- no end-to-end browser test against a live workflow backend in this slice

## Conclusion

As of 2026-03-22:

1. Attendance approval builder can hand off into the system workflow designer surface through the attendance workflow tab.
2. The handoff keeps enough context for the designer to act as a true continuation of the admin flow.
3. The live attendance approval engine remains unchanged.
4. Handoff tests, wider admin regressions, type checks, and the web production build all pass.
