# PLM Approval Bridge Phase 1 Development

Date: 2026-04-04
Branch: `codex/approval-bridge-plm-phase1-20260404`
Scope: backend only

## Summary

Phase 1 bridges PLM approvals into the unified approval backend without changing PLM to be platform-owned state.

Implemented behaviors:

- Added bridge columns to `approval_instances`
- Added `approval_assignments` for source-owned queue assignments
- Added a PLM approval bridge service with read-through sync
- Added unified approval APIs for list, detail, history, action, and manual sync
- Kept legacy approval endpoints scoped to local `platform` approvals only

Out of scope and intentionally not implemented:

- Frontend `/approvals` pages
- BPMN integration
- Attendance approval bridge
- Background sync jobs / cursors
- True `assignee=me` support for PLM

## Schema Changes

Migration added in [zzzz20260404100000_extend_approval_tables_for_bridge.ts](packages/core-backend/src/db/migrations/zzzz20260404100000_extend_approval_tables_for_bridge.ts).

`approval_instances` additions:

- `source_system`
- `external_approval_id`
- `workflow_key`
- `business_key`
- `title`
- `requester_snapshot`
- `subject_snapshot`
- `policy_snapshot`
- `metadata`
- `current_step`
- `total_steps`
- `source_updated_at`
- `last_synced_at`
- `sync_status`
- `sync_error`

`approval_assignments` additions:

- UUID primary key
- `assignment_type` constrained to `user | role | source_queue`
- `assignee_id`
- `source_step`
- `is_active`
- `metadata`

Design choices:

- Existing approvals are backfilled to `source_system='platform'`
- PLM mirror rows use ID format `plm:<externalApprovalId>`
- Upsert identity uses unique index `(source_system, external_approval_id)` where `external_approval_id` is not null

## Backend Changes

### PLM Adapter

Updated [PLMAdapter.ts](packages/core-backend/src/data-adapters/PLMAdapter.ts) with:

- `getApprovalById(approvalId)`

This fixes detail read-through refresh. The earlier list-based fallback would not have been reliable for arbitrary approval IDs.

### Bridge Mapper

Updated [plm-approval-bridge.ts](packages/core-backend/src/federation/plm-approval-bridge.ts) with:

- exported `createPlmApprovalInstanceId`

Mapping rules:

- `workflowKey = 'plm-eco-review'`
- `businessKey = 'plm:product:<productId>'`, fallback to `plm:approval:<approvalId>`
- `policy.rejectCommentRequired = true`
- `policy.sourceOfTruth = 'plm'`

### Bridge Service

Added [ApprovalBridgeService.ts](packages/core-backend/src/services/ApprovalBridgeService.ts).

Main responsibilities:

- `syncPlmApprovals`
- `listApprovals`
- `getApproval`
- `getApprovalHistory`
- `dispatchAction`

Important runtime behavior:

- List/detail/history/action all support read-through sync for PLM
- PLM source failures return service errors and do not mutate local status
- Successful PLM actions write local `approval_records`
- Successful PLM actions deactivate current `approval_assignments`
- PLM mirrors always use a single `source_queue` assignment: `plm:source-owned`

### Unified API Routes

Updated [approvals.ts](packages/core-backend/src/routes/approvals.ts) and wired injector access in [index.ts](packages/core-backend/src/index.ts).

New/expanded endpoints:

- `GET /api/approvals`
- `GET /api/approvals/:id`
- `GET /api/approvals/:instanceId/history`
- `POST /api/approvals/:id/actions`
- `POST /api/approvals/sync/plm`

Compatibility rules kept:

- `GET /api/approvals/pending` remains local-only and excludes PLM mirrors
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/reject`

Phase 1 API constraints:

- `GET /api/approvals?sourceSystem=plm&assignee=...` returns `400`
- error code: `ASSIGNEE_FILTER_UNSUPPORTED`
- `reject` via unified action requires `comment`
- non-pending action returns `409`
- PLM source action failures return `502` with `SOURCE_ACTION_FAILED`

## Files

Primary implementation files:

- [zzzz20260404100000_extend_approval_tables_for_bridge.ts](packages/core-backend/src/db/migrations/zzzz20260404100000_extend_approval_tables_for_bridge.ts)
- [approval-bridge-types.ts](packages/core-backend/src/services/approval-bridge-types.ts)
- [ApprovalBridgeService.ts](packages/core-backend/src/services/ApprovalBridgeService.ts)
- [approvals.ts](packages/core-backend/src/routes/approvals.ts)
- [PLMAdapter.ts](packages/core-backend/src/data-adapters/PLMAdapter.ts)
- [plm-approval-bridge.ts](packages/core-backend/src/federation/plm-approval-bridge.ts)

## Known Limits

- PLM does not currently expose reliable current assignee data through the existing adapter model, so phase 1 cannot provide true personal queue filtering.
- Migration was authored but not applied to a real database in this run.
- No frontend work was added in this phase.
- No integration tests against a real PLM source were executed in this run.
