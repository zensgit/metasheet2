# Attendance Workflow Reverse Binding Design

Date: 2026-03-23
Branch: `codex/attendance-postrelease-next-20260322`

## Goal

Close the loop between the attendance leave approval builder and the system workflow designer.

Before this slice:
- leave approval flows could hand off a draft into the workflow designer
- the resulting workflow draft had no formal backlink into `attendance_approval_flows`
- leave admin users could not see, clear, or reopen the linked draft from the approval-flow editor

After this slice:
- `attendance_approval_flows` owns a nullable `workflow_id`
- attendance admin gets a dedicated link API instead of overloading the normal save payload
- the workflow designer can bind the instantiated draft back to the approval flow
- leave admin shows the linked draft, can reopen it, and can clear the link

## Scope

Changed areas:
- backend migration and DB typing
- workflow designer ownership propagation
- attendance approval-flow link API
- attendance leave admin UI/composable
- workflow designer handoff binding UI
- OpenAPI contract
- targeted frontend and integration tests

Out of scope:
- replacing the attendance approval execution engine with system workflow execution
- auto-syncing workflow graph edits back into `steps`
- adding workflow picker/search inside leave admin
- adding `org_id` to `workflow_definitions`

## Data Model

Added nullable link:

- table: `attendance_approval_flows`
- column: `workflow_id uuid null references workflow_definitions(id) on delete set null`

Reason:
- the workflow designer persists drafts in `workflow_definitions`
- reverse binding must point at the saved draft, not template ids and not deployed workflow instances

## API Shape

Kept existing CRUD unchanged:
- `POST /api/attendance/approval-flows`
- `PUT /api/attendance/approval-flows/{id}`

Added a dedicated idempotent link endpoint:
- `PUT /api/attendance/approval-flows/{id}/workflow-link`

Request body:

```json
{
  "workflowId": "uuid-or-null"
}
```

Response:
- updated `AttendanceApprovalFlow`

Reason for dedicated endpoint:
- normal form save should not accidentally clear the workflow link
- the workflow designer owns the moment where the real draft id becomes known
- UI can clear link explicitly without re-saving approval steps

## Permission Model

Binding validation uses workflow-draft edit semantics, not just existence.

Checks:
1. approval flow id must be valid and belong to the current org
2. if `workflowId` is non-null, the draft must exist in `workflow_definitions`
3. current user must be allowed to edit that draft

Current implementation mirrors workflow draft edit access using:
- `created_by === requester`
- or `definition.shares[].canEdit === true`

Reason:
- `workflow_definitions` currently has no `org_id`
- existence-only validation would let admins bind arbitrary drafts they cannot edit

## Workflow Designer Changes

Two designer fixes were required.

### 1. Preserve draft ownership on creation

`saveWorkflow()` now accepts `createdBy`, and the workflow-designer routes pass the current user into:
- template instantiation
- visual workflow creation

Without this, newly instantiated drafts were stored with `created_by = 'system'`, which breaks later edit/bind authorization.

### 2. Bind after template instantiation

When attendance handoff instantiates a starter:
- the designer snapshots the attendance handoff context
- instantiates the template
- immediately calls the approval-flow link API with the returned draft id
- keeps a visible binding banner so the operator can retry manual bind if needed

## Leave Admin Changes

The leave approval-flow editor remains the source of approval semantics.

New admin capabilities:
- display current `workflowId`
- open the linked draft in `workflow-designer/:id`
- clear the formal link
- keep the existing “Open in workflow designer” handoff button

Important product boundary:
- linked workflow draft is advisory/system-design sidecar
- live attendance approvals still execute from `attendance_approval_flows.steps`

## Test Strategy

Frontend:
- composable test for loading and updating `workflowId`
- section test for open-linked-draft and clear-link actions
- workflow-designer handoff test for automatic reverse binding

Backend:
- integration test for create approval flow -> instantiate workflow draft -> bind -> list -> clear
- existing broad attendance integration also updated to create an explicit leave approval flow so approval is deterministic on persistent local DBs

## Follow-ups

Not done in this slice:
- reverse sync from workflow draft back into attendance approval steps
- workflow picker from leave admin
- `attendance_approval_flows.workflow_id` exposure in reports or admin tables beyond the editor
- workflow draft org scoping
- native attendance workflow template persistence beyond starter creation
