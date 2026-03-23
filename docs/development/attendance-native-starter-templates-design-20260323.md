# Attendance Native Starter Templates Design

Date: 2026-03-23
Branch: `codex/attendance-postrelease-next-20260322`
Baseline release: `attendance-onprem-run21-20260322`
Baseline handoff docs:

- `attendance-workflow-handoff-design-20260322.md`
- `attendance-workflow-handoff-verification-20260322.md`

## Goal

Upgrade the attendance approval handoff from generic workflow starters to attendance-native starter templates without changing the workflow-designer API shape or introducing a database migration.

This slice is intentionally about template identity, operator copy, and catalog quality. It is not the reverse-binding slice.

## Why This Slice First

Reverse binding from workflow drafts back into `attendance_approval_flows` is valuable, but it needs a formal link field and API expansion on the attendance side.

Attendance-native starter templates are the safer next step because:

- builtin workflow templates already exist in the workflow designer backend catalog
- builtin templates already flow through list/detail/instantiate routes
- the attendance handoff already chooses a `templateId`
- the current gap is that the chosen IDs are still generic (`simple-approval` / `parallel-review`)

So this slice upgrades the quality of the starter path without expanding DB or OpenAPI surface area.

## Implemented Design

### 1. Attendance-Native Builtin Templates

Files:

- `packages/core-backend/src/workflow/WorkflowDesigner.ts`

Added builtin approval templates:

- `attendance-leave-manager`
- `attendance-leave-manager-hr`
- `attendance-overtime-manager`
- `attendance-overtime-manager-payroll`
- `attendance-exception-manager`
- `attendance-exception-manager-ops`

Each template:

- stays under `category: 'approval'`
- carries attendance-specific `tags`
- is immediately available through the existing workflow template catalog
- can be instantiated through the existing `/api/workflow-designer/templates/:id/instantiate` route

### 2. Request-Type Starter Mapping

Files:

- `apps/web/src/views/attendance/attendanceWorkflowHandoff.ts`

`resolveAttendanceWorkflowStarterId()` now maps by `requestType + approvalStepCount`, not just `stepCount`:

- leave:
  - `1 step` -> `attendance-leave-manager`
  - `2+ steps` -> `attendance-leave-manager-hr`
- overtime:
  - `1 step` -> `attendance-overtime-manager`
  - `2+ steps` -> `attendance-overtime-manager-payroll`
- attendance exceptions:
  - `1 step` -> `attendance-exception-manager`
  - `2+ steps` -> `attendance-exception-manager-ops`

Generic `simple-approval` / `parallel-review` remain as fallback values for unknown request types.

### 3. Shared Starter Label Formatting

Files:

- `apps/web/src/views/attendance/attendanceWorkflowHandoff.ts`
- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`
- `apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue`

Added a shared starter-label formatter so both attendance admin and workflow handoff cards render the same request-type-aware starter label.

This avoids a common regression class where `templateId` changes but the UI still describes the starter with stale generic copy.

### 4. No API Shape Change

Files:

- `packages/core-backend/src/workflow/WorkflowDesigner.ts`
- `packages/core-backend/src/workflow/workflowDesignerRouteModels.ts`
- `packages/core-backend/src/routes/workflow-designer.ts`

This slice deliberately does not add:

- new workflow template endpoints
- new attendance approval-flow fields
- new migration or seed paths

Builtin templates are enough because the current workflow template catalog already merges builtin and database templates into one surface.

## Design Decisions

### Prefer Builtin Templates Over Database Templates For V1

Database templates would require seeding or per-tenant initialization strategy. Builtin templates avoid that and still surface in Workflow Hub immediately.

### Preserve Generic Fallbacks

The new attendance-native IDs are now the preferred path, but `simple-approval` and `parallel-review` stay valid so older links and non-attendance callers do not break.

### Defer Reverse Binding

Reverse binding was evaluated during this slice, but it requires:

- a formal workflow link field on `attendance_approval_flows`
- backend mapper and CRUD expansion
- likely a new narrow attach/clear action

That is a separate, heavier change set and should not be mixed into this template-quality upgrade.

## Files Changed

- `packages/core-backend/src/workflow/WorkflowDesigner.ts`
- `packages/core-backend/tests/unit/workflow-designer-templates.test.ts`
- `apps/web/src/views/attendance/attendanceWorkflowHandoff.ts`
- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`
- `apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue`
- `apps/web/tests/attendanceWorkflowHandoff.spec.ts`
- `apps/web/tests/AttendanceLeavePoliciesSection.spec.ts`
- `apps/web/tests/attendance-workflow-designer-zh.spec.ts`
- `apps/web/tests/WorkflowDesigner.attendanceHandoff.spec.ts`

## Non-Goals

This slice does not yet deliver:

- reverse binding from workflow drafts back to attendance approval flows
- attendance-specific templates for every multi-step builder permutation
- live synchronization between approval-builder steps and BPMN nodes
- new workflow template persistence in database tables

## Next Steps

1. Add reverse binding with a formal `workflowId` link on `attendance_approval_flows`.
2. Expand starter coverage from coarse `1-step / 2+-step` mapping to exact builder-template parity where useful.
3. Add live browser validation that an attendance handoff instantiates the intended attendance-native template in a running shell.
