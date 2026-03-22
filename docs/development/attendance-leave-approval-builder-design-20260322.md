# Attendance Leave Approval Builder Design

Date: 2026-03-22
Branch: `codex/attendance-postrelease-next-20260322`
Published baseline main commit: `f81254d8cb3e88fd1fdfb5118287df044926dacd`
Published runtime release commit: `796be28e7de27bd07efed118e79e1fe25e09953e`
Attendance on-prem release: `attendance-onprem-run21-20260322`

## Context

The attendance release already shipped explainable rule simulation, import triage, rollback guidance, and admin hardening. The largest remaining low-code gap is policy authoring.

Leave and attendance approval flows were still authored through a raw `Steps (JSON)` field even though the current API contract is already simple:

- `name`
- `approverUserIds`
- `approverRoleIds`

This means the product did not need a new backend model to become more low-code. It needed a better authoring surface on top of the existing payload.

## Design Goal

Make approval-step authoring visual by default while preserving the current attendance-specific execution model and JSON payload shape.

This slice intentionally does not switch leave approval onto the generic system workflow engine. Current execution still depends on attendance-owned approval flows plus shared approval storage, so the safe path is:

1. improve authoring first
2. keep the same payload contract
3. leave workflow-engine handoff for the next slice

## Implemented Scope

### 1. Structured Approval Builder In The Leave Policy Admin

Files:

- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`
- `apps/web/src/views/attendance/useAttendanceAdminLeavePolicies.ts`

The approval-flow area now exposes:

- visual step cards instead of JSON-only authoring
- per-step fields for:
  - step name
  - approver role ids
  - approver user ids
- request-type-aware starter templates
- flow summary chips:
  - step count
  - role gate count
  - direct user count
- readable step summaries in the approval-flow list table

### 2. Builder To JSON Synchronization

The builder is authoritative for normal editing, but the advanced JSON field remains available for power users.

Synchronization rules:

- builder edits serialize back into the existing `steps` JSON payload
- valid JSON edits rehydrate the structured builder
- invalid JSON does not silently wipe builder state; it surfaces an explicit sync error
- deprecated snake_case keys (`approver_user_ids`, `approver_role_ids`) are normalized into the builder for compatibility

This preserves backward compatibility without letting JSON remain the primary interaction model.

### 3. Request-Type-Aware Templates

The builder now offers starter templates instead of forcing every org admin to author step arrays from scratch.

Current templates:

- leave:
  - `Manager only`
  - `Manager -> HR`
  - `Manager -> HR -> Ops`
- overtime:
  - `Manager only`
  - `Manager -> Payroll`
  - `Manager -> Ops -> Payroll`
- other attendance requests:
  - `Manager only`
  - `Manager -> Ops`
  - `Manager -> HR -> Ops`

These templates stay within the current payload contract and do not require new backend support.

## Important Design Decisions

### Keep Attendance Approval As The Execution Engine

This change does not move leave approval onto the generic workflow designer or BPMN runtime. The reason is straightforward:

- request creation still binds `approvalFlowId`, not `workflowId`
- current approval execution advances attendance-owned step state
- final approval writes back attendance domain data directly

Changing the execution engine here would have expanded the release risk without improving the immediate low-code gap.

### Keep JSON As Fallback, Not As Primary UX

The old JSON editor remains because:

- it is useful for bulk edits
- it is useful for debugging payload compatibility
- some admins will still want direct payload inspection

But the UI now clearly treats it as `Advanced JSON fallback`, not as the main entry point.

### Preserve Placeholder Drafts

The builder deliberately keeps blank step cards during authoring instead of immediately collapsing them away. This required an explicit sync lock so placeholder steps do not disappear when the synchronized JSON evaluates to `[]`.

## Non-Goals In This Slice

This slice does not yet provide:

- drag-and-drop step reordering
- duplicate-step actions
- workflow-designer handoff from the leave-policy page
- visual policy presets that bundle leave type, overtime rule, and approval flow together
- payroll template builder

## Files Changed

- `apps/web/src/views/AttendanceView.vue`
- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`
- `apps/web/src/views/attendance/useAttendanceAdminLeavePolicies.ts`
- `apps/web/tests/AttendanceLeavePoliciesSection.spec.ts`
- `apps/web/tests/useAttendanceAdminLeavePolicies.spec.ts`

## Next Steps

1. Add step reordering and duplicate actions.
2. Add workflow-designer handoff for attendance-native templates.
3. Lift leave type, overtime rule, and approval flow into reusable policy presets.
4. Apply the same builder pattern to payroll template authoring.
