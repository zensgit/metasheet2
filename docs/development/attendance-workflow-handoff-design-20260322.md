# Attendance Workflow Handoff Design

Date: 2026-03-22
Branch: `codex/attendance-postrelease-next-20260322`
Baseline docs:

- `attendance-leave-approval-builder-design-20260322.md`
- `attendance-leave-approval-builder-verification-20260322.md`

## Goal

Add a safe, attendance-native handoff from the leave approval builder into the existing workflow designer surface without changing the live attendance approval execution model.

This slice is intentionally about navigation, context transfer, and operator guidance. It is not a workflow-engine migration.

## Current Constraint

The safest handoff target is not the global `workflow-designer` route.

Why:

- the attendance product already has a stable embedded workflow tab at `/attendance?tab=workflow`
- `AttendanceExperienceView` already uses `route.query.tab` as the shell state contract
- the standalone `workflow-designer` route is referenced in types and internal links, but is not currently registered in `apps/web/src/main.ts`
- `WorkflowDesigner.vue` still contains `router.replace({ name: 'workflow-designer', ... })` after template instantiation, so using `templateId` as the primary handoff contract would depend on a route that is not safely registered

Because of that, the handoff design in this slice stays inside the attendance shell.

## Implemented Design

### 1. Attendance-Native Handoff Query Contract

New helper:

- `apps/web/src/views/attendance/attendanceWorkflowHandoff.ts`

This helper defines the query payload used between the approval builder and the workflow tab.

Current query fields:

- `tab=workflow`
- `wfSource=attendance`
- `wfHandoff=approval-flow`
- `attendanceRequestType`
- `approvalFlowId`
- `approvalFlowName`
- `approvalStepCount`
- `approvalStepSummary`
- `workflowName`
- `workflowDescription`
- `workflowStarterId`

This keeps the handoff serializable, bookmarkable, and testable without pushing large JSON blobs into the URL.

### 2. Leave Approval Builder CTA

Files:

- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`

The leave policy admin now exposes a dedicated `Workflow designer handoff` panel under the approval builder.

It provides:

- the recommended starter type
- the current flow name
- an explicit CTA to open the workflow tab
- a clear warning that this is a starter brief, not a replacement for the live attendance approval engine

The CTA does not try to instantiate a workflow template automatically. It only transfers context into the attendance workflow tab.

### 3. Workflow Tab Handoff Card

Files:

- `apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue`

The workflow tab wrapper now reads the handoff query and shows a dedicated context card above the system workflow designer runtime.

The card includes:

- request type
- flow name
- step count
- suggested starter label
- step summary
- quick actions:
  - back to admin
  - clear handoff context

This makes the designer feel like a continuation of the attendance admin flow instead of a disconnected subsystem.

### 4. Workflow Draft Prefill

Files:

- `apps/web/src/views/WorkflowDesigner.vue`

When the workflow designer opens in create mode from attendance handoff, it now seeds the new draft with:

- `workflowName`
- `workflowDescription`

This avoids dropping the operator into an empty draft with no trace of the originating approval flow.

## Design Decisions

### Do Not Auto-Apply Templates In This Slice

The helper still computes a `workflowStarterId`, but this slice does not auto-apply it.

Reason:

- auto-instantiation currently routes through `workflow-designer`
- that route is not safely registered in the current shell
- auto-applying a template would make the handoff fragile for the wrong reason

So the starter is currently advisory, not executable.

### Keep Attendance Approval Execution Unchanged

This handoff does not alter:

- `approvalFlowId`
- attendance request creation
- approval step advancement
- final attendance record writeback

The live attendance approval engine remains attendance-owned.

### Prefer Query State Over Props

This handoff crosses admin and workflow tabs. Query state is the most stable contract because it:

- matches the current attendance shell architecture
- supports refresh/share/debug flows
- avoids threading one-off props through multiple shell layers

## Files Changed

- `apps/web/src/views/attendance/attendanceWorkflowHandoff.ts`
- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`
- `apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue`
- `apps/web/src/views/WorkflowDesigner.vue`
- `apps/web/tests/attendanceWorkflowHandoff.spec.ts`
- `apps/web/tests/AttendanceLeavePoliciesSection.spec.ts`
- `apps/web/tests/attendance-workflow-designer-zh.spec.ts`
- `apps/web/tests/attendance-experience-zh-tabs.spec.ts`

## Non-Goals

This slice does not yet deliver:

- automatic template instantiation from attendance handoff
- live synchronization between approval builder steps and BPMN nodes
- workflow publication back into attendance approval flows
- global standalone workflow-designer route repair

## Next Steps

1. Register or repair the standalone workflow designer route.
2. Make `workflowStarterId` executable once the standalone route is safe.
3. Add attendance-specific starter templates instead of generic `simple-approval` / `parallel-review` suggestions.
4. Add reverse handoff so a workflow draft can be attached back to an attendance approval flow.
