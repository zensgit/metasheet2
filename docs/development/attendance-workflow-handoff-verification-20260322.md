# Attendance Workflow Handoff Verification

Date: 2026-03-22
Branch: `codex/attendance-postrelease-next-20260322`
Published baseline release: `attendance-onprem-run21-20260322`

## Purpose

Verify that the attendance approval -> workflow designer handoff now works as a route-query-driven bridge with an executable starter contract on top of the already-published attendance baseline.

## Targeted Handoff Validation

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/WorkflowDesigner.attendanceHandoff.spec.ts tests/attendanceWorkflowHandoff.spec.ts tests/AttendanceLeavePoliciesSection.spec.ts tests/useAttendanceAdminLeavePolicies.spec.ts tests/attendance-workflow-designer-zh.spec.ts tests/attendance-experience-zh-tabs.spec.ts --watch=false
```

Result:

- `6 files`
- `19 tests passed`

Covered behaviors:

- attendance handoff query generation now includes `templateId`
- handoff query parsing preserves executable starter state
- leave approval builder CTA navigation carries the executable starter contract
- workflow wrapper handoff copy and actions remain intact
- attendance shell still lands on `tab=workflow` when handoff query is present
- `WorkflowDesigner.vue` auto-instantiates the starter template, forwards `description/category`, and lands on the standalone `workflow-designer` route
- existing leave approval visual builder tests remain green

## Wider Attendance Admin Regression

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/WorkflowDesigner.attendanceHandoff.spec.ts tests/attendanceWorkflowHandoff.spec.ts tests/attendance-workflow-designer-zh.spec.ts tests/attendance-experience-zh-tabs.spec.ts tests/useAttendanceAdminLeavePolicies.spec.ts tests/AttendanceLeavePoliciesSection.spec.ts tests/useAttendanceAdminImportBatches.spec.ts tests/AttendanceImportBatchesSection.spec.ts tests/useAttendanceAdminRulesAndGroups.spec.ts tests/AttendanceRulesAndGroupsSection.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/AttendanceImportWorkflowSection.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts tests/AttendanceHolidayDataSection.spec.ts --watch=false
```

Result:

- `15 files`
- `89 tests passed`

This confirms the repaired workflow handoff did not regress the previously delivered attendance admin capabilities:

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
- the existing Vite large-chunk warning remains
- Vite also warns that `WorkflowDesigner.vue` is now both dynamically imported from `main.ts` and statically imported by `AttendanceWorkflowDesigner.vue`; this is expected after route repair and does not block the build

## Verified Files

- `apps/web/src/views/attendance/attendanceWorkflowHandoff.ts`
- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`
- `apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue`
- `apps/web/src/views/WorkflowDesigner.vue`
- `apps/web/src/main.ts`
- `apps/web/tests/WorkflowDesigner.attendanceHandoff.spec.ts`
- `apps/web/tests/attendanceWorkflowHandoff.spec.ts`
- `apps/web/tests/AttendanceLeavePoliciesSection.spec.ts`
- `apps/web/tests/attendance-workflow-designer-zh.spec.ts`
- `apps/web/tests/attendance-experience-zh-tabs.spec.ts`

## Residual Risks

The following are still intentionally open after this slice:

- no verification of reverse binding from workflow draft back to attendance approval flow
- no live synchronization from approval-builder steps into BPMN nodes
- no end-to-end browser test against a live workflow backend in this slice
- no attendance-specific starter template catalog yet

## Conclusion

As of 2026-03-22:

1. Attendance approval builder can hand off into the system workflow designer surface through the attendance workflow tab.
2. The handoff now carries an executable starter contract instead of only an advisory recommendation.
3. The standalone `workflow-designer` route is repaired well enough for template-instantiation takeover.
4. Handoff tests, wider admin regressions, type checks, and the web production build all pass.
