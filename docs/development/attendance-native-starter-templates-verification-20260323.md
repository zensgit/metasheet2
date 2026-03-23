# Attendance Native Starter Templates Verification

Date: 2026-03-23
Branch: `codex/attendance-postrelease-next-20260322`
Baseline release: `attendance-onprem-run21-20260322`

## Purpose

Verify that attendance approval handoff now selects attendance-native starter templates instead of generic starter IDs, while keeping existing workflow handoff behavior, frontend type safety, backend type safety, and web production build intact.

## Targeted Frontend Validation

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendanceWorkflowHandoff.spec.ts tests/AttendanceLeavePoliciesSection.spec.ts tests/attendance-workflow-designer-zh.spec.ts tests/WorkflowDesigner.attendanceHandoff.spec.ts --watch=false
```

Result:

- `4 files`
- `8 tests passed`

Covered behaviors:

- attendance handoff query now emits attendance-native starter IDs
- attendance handoff parser preserves the new starter IDs
- leave approval admin shows attendance-native starter labels
- workflow handoff wrapper shows attendance-native starter labels
- workflow designer still instantiates the starter template selected by attendance handoff

## Targeted Backend Validation

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/workflow-designer-templates.test.ts tests/unit/workflow-designer-route-models.test.ts
```

Result:

- `2 files`
- `7 tests passed`

Covered behaviors:

- builtin attendance starter templates exist in the workflow designer catalog
- builtin template metadata remains compatible with the route-model projection layer
- builtin/database template merge logic still works

## Wider Web Regression

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/WorkflowDesigner.attendanceHandoff.spec.ts tests/attendanceWorkflowHandoff.spec.ts tests/attendance-workflow-designer-zh.spec.ts tests/attendance-experience-zh-tabs.spec.ts tests/useAttendanceAdminLeavePolicies.spec.ts tests/AttendanceLeavePoliciesSection.spec.ts tests/useAttendanceAdminImportBatches.spec.ts tests/AttendanceImportBatchesSection.spec.ts tests/useAttendanceAdminRulesAndGroups.spec.ts tests/AttendanceRulesAndGroupsSection.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/AttendanceImportWorkflowSection.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts tests/AttendanceHolidayDataSection.spec.ts tests/workflowDesignerPersistence.spec.ts --watch=false
```

Result:

- `16 files`
- `105 tests passed`

This confirms the attendance-native starter upgrade did not regress:

- executable workflow handoff
- leave approval builder
- import workflow and batch triage
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
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result:

- passed

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

- passed
- Vite still reports the existing `WorkflowDesigner.vue` static/dynamic import warning
- Vite still reports the existing large-chunk warning
- neither warning blocks build output

## Verified Files

- `packages/core-backend/src/workflow/WorkflowDesigner.ts`
- `packages/core-backend/tests/unit/workflow-designer-templates.test.ts`
- `packages/core-backend/tests/unit/workflow-designer-route-models.test.ts`
- `apps/web/src/views/attendance/attendanceWorkflowHandoff.ts`
- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`
- `apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue`
- `apps/web/tests/attendanceWorkflowHandoff.spec.ts`
- `apps/web/tests/AttendanceLeavePoliciesSection.spec.ts`
- `apps/web/tests/attendance-workflow-designer-zh.spec.ts`
- `apps/web/tests/WorkflowDesigner.attendanceHandoff.spec.ts`

## Residual Risks

The following are intentionally still open after this slice:

- attendance handoff still maps by coarse request-type bands, not exact builder-template parity
- reverse binding from workflow drafts back to approval flows is still not implemented
- no live browser or end-to-end test against a running workflow backend was added in this slice

## Conclusion

As of 2026-03-23:

1. Attendance handoff now selects attendance-native starter templates instead of generic starter IDs.
2. The workflow designer can still instantiate the starter selected by the attendance shell.
3. Backend builtin template catalog, frontend handoff UI, broader attendance admin regressions, and type/build gates all pass.
