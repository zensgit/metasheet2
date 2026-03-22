# Attendance Workflow Handoff Design

Date: 2026-03-22
Branch: `codex/attendance-postrelease-next-20260322`
Baseline docs:

- `attendance-leave-approval-builder-design-20260322.md`
- `attendance-leave-approval-builder-verification-20260322.md`

## Goal

Add a safe, attendance-native handoff from the leave approval builder into the existing workflow designer surface, and make the recommended starter executable without changing the live attendance approval execution model.

This slice is intentionally about navigation, context transfer, executable template seeding, and operator guidance. It is not a workflow-engine migration.

## Routing Strategy

The entry point still starts inside the attendance shell at `/attendance?tab=workflow`, but the handoff is no longer limited to an advisory card.

Why this shape remains intentional:

- the attendance product already has a stable embedded workflow tab at `/attendance?tab=workflow`
- `AttendanceExperienceView` already uses `route.query.tab` as the shell state contract
- the attendance workflow tab provides the right operator context card before handing off into the standalone designer
- the standalone `workflow-designer` route is now registered in `apps/web/src/main.ts`
- attendance-focused mode now explicitly allows `/workflows` prefixes when the workflow feature is enabled, so route replacement after template instantiation no longer bounces the user back to `/attendance`

Because of that, the design now uses a two-step path:

1. enter through the attendance workflow tab with handoff context
2. let `WorkflowDesigner.vue` instantiate the starter and route into the standalone designer draft

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
- `templateId`

This keeps the handoff serializable, bookmarkable, and testable without pushing large JSON blobs into the URL.

### 2. Leave Approval Builder CTA

Files:

- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`

The leave policy admin exposes a dedicated `Workflow designer handoff` panel under the approval builder.

It provides:

- the recommended starter type
- the current flow name
- an explicit CTA to open the workflow tab
- a clear warning that workflow design is still a starter path, not a replacement for the live attendance approval engine

The CTA still opens the attendance workflow tab first, but it now carries an executable starter contract through `templateId`.

### 3. Workflow Tab Handoff Card

Files:

- `apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue`

The workflow tab wrapper reads the handoff query and shows a dedicated context card above the system workflow designer runtime.

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

### 4. Workflow Draft Prefill And Starter Execution

Files:

- `apps/web/src/views/WorkflowDesigner.vue`

When the workflow designer opens in create mode from attendance handoff, it now:

- seeds the new draft with `workflowName`
- seeds the new draft with `workflowDescription`
- reads `templateId`
- instantiates the recommended workflow template automatically
- forwards `description` and `category: approval` into template instantiation

This avoids dropping the operator into an empty draft with no trace of the originating approval flow, and turns the recommended starter into an actual draft bootstrap.

### 5. Standalone Workflow Route Repair

Files:

- `apps/web/src/main.ts`

The global designer route is now explicitly registered:

- `/workflows/designer/:id?`
- route name: `workflow-designer`

Attendance-focused mode also now allows `/workflows` prefixes when workflow capability is enabled. This makes the existing `router.replace({ name: 'workflow-designer', ... })` path safe after template instantiation.

## Design Decisions

### Enter Through Attendance, Finish In Workflow Designer

The handoff still enters through the attendance shell instead of deep-linking directly to the standalone designer.

Reason:

- the attendance shell is still the right place to show request-type and approval-flow context
- the system designer should remain a continuation, not a cold entry
- now that the standalone route is repaired, the designer can safely take over after template instantiation

The result is a safer hybrid: context first, executable starter second.

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
- `apps/web/src/main.ts`
- `apps/web/tests/attendanceWorkflowHandoff.spec.ts`
- `apps/web/tests/AttendanceLeavePoliciesSection.spec.ts`
- `apps/web/tests/WorkflowDesigner.attendanceHandoff.spec.ts`
- `apps/web/tests/attendance-workflow-designer-zh.spec.ts`
- `apps/web/tests/attendance-experience-zh-tabs.spec.ts`
- `apps/web/tests/workflowDesignerPersistence.spec.ts`

## Non-Goals

This slice does not yet deliver:

- live synchronization between approval builder steps and BPMN nodes
- workflow publication back into attendance approval flows
- attendance-specific starter templates beyond `simple-approval` / `parallel-review`
- a direct builder -> standalone workflow route jump that skips the attendance shell entirely

## Next Steps

1. Add attendance-specific starter templates instead of generic `simple-approval` / `parallel-review`.
2. Add reverse handoff so a workflow draft can be attached back to an attendance approval flow.
3. Add end-to-end browser validation against a live workflow backend.
4. Decide whether the leave builder should eventually support a direct standalone-designer deep link in addition to the current attendance-shell entry.
