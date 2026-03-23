# Attendance Workflow Step Sync Design

Date: 2026-03-23
Branch: `codex/attendance-postrelease-next-20260322`
Scope: leave approval admin, attendance workflow reverse binding follow-up

## Goal

Make the linked workflow draft actually useful to attendance admins after handoff and reverse binding:

1. Read the linked workflow draft.
2. Preview the approval steps that can be derived from it.
3. Let admins apply the derived steps back into the attendance approval-flow builder.
4. Keep live execution on `attendance_approval_flows.steps` for now.

This is intentionally not a runtime-engine cutover to the system workflow engine.

## Why This Slice

The previous handoff work already solved:

- approval-flow builder -> workflow designer starter handoff
- workflow draft creation and reverse binding through `workflow_id`

The missing piece was operational sync in the opposite direction. Without it, admins could design a linked draft but still had to manually re-enter equivalent approval steps in attendance admin.

## Constraints Found In Code

### 1. Live attendance approval still runs on approval-flow steps

The attendance request engine copies and executes `attendance_approval_flows.steps`, not the linked workflow draft directly. This means sync must end in the approval-flow builder/form, not in a direct runtime handoff.

### 2. Frontend-only parsing is not safe enough

The workflow designer frontend persists BPMN XML via `saveWorkflowDraft(...)`. Existing drafts may therefore have newer BPMN than saved `visual` metadata. Preview logic must treat BPMN as the primary source of truth.

### 3. Candidate groups were being lost in BPMN

Attendance-native starter templates encode approvers as `candidateGroups`, but BPMN export only preserved `candidateUsers`. This prevented reliable role-based sync preview from linked drafts.

## Implemented Design

## 1. Preserve attendance approver roles in BPMN

File:

- `packages/core-backend/src/workflow/WorkflowDesigner.ts`

Changes:

- Added `xmlns:metasheet="http://metasheet.com/bpmn/extensions"` to generated BPMN definitions.
- Serialized `candidateGroups` on `userTask` as `metasheet:candidateGroups="manager,hr"`.
- Kept existing `candidateUsers` output through `potentialOwner/formalExpression`.

Result:

- Attendance-native starter templates now round-trip their role gates into BPMN metadata.

## 2. Add attendance-side workflow sync preview API

File:

- `plugins/plugin-attendance/index.cjs`

New route:

- `GET /api/attendance/approval-flows/:id/workflow-sync-preview`

Behavior:

- Validates approval-flow id and admin permission.
- Requires the approval flow to be linked to a workflow draft.
- Requires editable access to the linked workflow draft.
- Loads linked draft BPMN from `workflow_definitions.definition`.
- Parses BPMN with `xml2js`.
- Walks the primary approval path from `startEvent` forward.
- Converts supported `userTask` nodes into attendance approval steps.

Supported extraction:

- `userTask.name -> step.name`
- `userTask.assignee -> approverUserIds`
- `potentialOwner/formalExpression -> approverUserIds`
- `metasheet:candidateGroups -> approverRoleIds`

Fallback behavior:

- If BPMN is missing `candidateGroups`, preview can recover them from saved visual metadata for the same node id.
- Preview marks that fallback in `sourceMode = bpmn+visual-fallback` and emits warnings telling the admin to re-save the workflow draft.

Unsupported/limited structures:

- `parallelGateway`
- `serviceTask`
- `scriptTask`
- `intermediateCatchEvent`
- loops
- ambiguous multi-branch paths

For those, preview returns warnings and follows the first safe branch where possible.

Response contract:

- `workflowId`
- `workflowName`
- `sourceMode`
- `steps`
- `warnings`
- `summary.currentStepCount`
- `summary.userTaskCount`
- `summary.derivedStepCount`
- `summary.unsupportedNodeCount`

## 3. Keep apply local to the attendance admin UI

Files:

- `apps/web/src/views/attendance/useAttendanceAdminLeavePolicies.ts`
- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`

Design choice:

- Preview happens on the backend.
- Apply happens locally in the leave admin page.
- Persistence still goes through the existing `Update flow` save path.

Why:

- Keeps the first sync slice reversible and low-risk.
- Avoids a second backend write API before admins can inspect the derived result.
- Matches the current page model where the builder/JSON editor is the authoritative admin editing surface.

UI behavior:

- New `Preview sync from linked draft` action.
- Shows linked draft id/name, source mode, counts, derived steps, and warnings.
- New `Apply synced steps` action replaces current builder steps with preview steps.
- Existing builder -> JSON sync then updates `approvalFlowForm.steps`.
- Admin must still click `Update flow` to persist the change.

## 4. OpenAPI contract update

Files:

- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/attendance.yml`

Added:

- `AttendanceApprovalWorkflowSyncPreviewSummary`
- `AttendanceApprovalWorkflowSyncPreview`
- route documentation for `GET /api/attendance/approval-flows/{id}/workflow-sync-preview`

## Safety Model

This implementation does not change live approval execution.

Safe boundaries:

- No automatic rewrite of `attendance_approval_flows.steps`
- No automatic save from preview/apply
- No runtime switch from attendance approval engine to workflow engine
- Unsupported workflow nodes degrade into warnings, not silent conversion

## Follow-up

Next useful slice after this one:

1. Add explicit diff view between current approval steps and derived workflow steps.
2. Add one-click `apply + save` once admins have proven the preview path stable.
3. Add designer-side prompt/banner when BPMN role metadata is stale and needs re-save.
4. Evaluate when linked workflow drafts can become an optional execution source instead of only a design companion.
