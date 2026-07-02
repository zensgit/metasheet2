# Approval scoped admins + bulk handover — dev and verification

Date: 2026-07-02
Status: REVIEWABLE
PR: #3490

## Scope

This slice implements the T2-1+2 defaults from the second-batch ballot:

- split approval administration capabilities:
  - `approvals:admin` for process recovery operations,
  - `approvals:admin-templates` for template/delegation authoring,
  - `approvals:admin-data` reserved for data-recovery scoped work;
- bulk handover for active platform approval instances from one user assignee to another;
- per-instance best-effort manifest `{ succeeded, skipped }`;
- `reassign` audit action and version bump on successful handover;
- realtime/count refresh fan-out for actor, source user, target user, and affected requesters.

Non-goals:

- no data-scoped admin model;
- no role/dynamic assignment rewrite;
- no cross-base or source-system handover;
- no version-conflict skip, because the API does not accept a version precondition.

## Implementation

- Added migration `zzzz20260702110000_add_approval_reassign_and_admin_scopes`.
  - Extends `approval_records.action` CHECK with `reassign`.
  - Registers the three scoped permission codes and grants them to the admin role.
  - Restores the old CHECK as `NOT VALID` on down.
  - Down removes only the two newly-introduced split codes (`approvals:admin-templates`, `approvals:admin-data`); it preserves the pre-existing `approvals:admin` seeded by the admin-jump migration.
- Added `ApprovalProductService.bulkReassignApprovals`.
  - Validates active target user.
  - Enumerates active user assignments for `fromUserId` only when `instanceIds` is omitted.
  - Treats an explicit empty `instanceIds: []` as an empty handover, never as "enumerate all".
  - Locks each instance with `FOR UPDATE`.
  - Skips non-pending, missing, not-assigned, target-is-requester, target-already-assignee, invalid-target, and unexpected per-instance errors.
  - Deactivates source active user assignments and inserts static user assignments for the target with `metadata.reassignedFrom` and `metadata.adminReassign`.
  - Writes a `reassign` audit record per affected node and bumps `approval_instances.version`.
- Added `POST /api/approvals/admin/reassign`.
  - Gated by `approvals:admin`.
  - Does not admit `approvals:admin-templates`.
- Replaced template/delegation authoring gates with the shared template-admin guard:
  - `approval-templates:manage` or `approvals:admin-templates`.
  - Visibility-manager checks also recognize `approvals:*` and `approvals:admin-templates`.
- Updated the approval schema bootstrap marker so stale integration DBs rebuild the `approval_records_action_check` constraint.

## Verification

Local verification:

- `pnpm --filter @metasheet/core-backend exec tsc --noEmit` — PASS.
- `DATABASE_URL=... pnpm --filter @metasheet/core-backend db:migrate` — PASS; migration executed.
- `DATABASE_URL=... pnpm --filter @metasheet/core-backend db:rollback && DATABASE_URL=... pnpm --filter @metasheet/core-backend db:migrate` — PASS; down/up round-trip executed, with `approvals:admin` preserved after rollback and the two split codes restored after migrate.
- DB readback: `approval_records_action_check` includes `reassign`.
- `DATABASE_URL=... pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/approval-bulk-reassign.api.test.ts --reporter=dot` — PASS, 3/3.
- `DATABASE_URL=... pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/approval-node-timeout-effects.test.ts tests/integration/approval-nofm-threshold.test.ts --reporter=dot` — PASS, 18/18.
- `DATABASE_URL=... pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/approval-directory-endpoints.api.test.ts tests/integration/approval-delegation-api.db.test.ts --reporter=dot` — PASS, 16/16.
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.config.ts run tests/unit/approvals-routes.test.ts tests/unit/approval-rbac-boundary.test.ts --reporter=dot` — PASS, 45/45.
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.config.ts run tests/unit/approval-rbac-boundary.test.ts tests/unit/automation-v1.test.ts --reporter=dot` — PASS, 246/246.

New fail-first / boundary coverage:

- `approvals:admin-templates` can create approval templates but receives 403 on process handover.
- Successful user handover deactivates the source assignment, inserts the target assignment, bumps version, writes `reassign` audit, and reruns as `not-assigned`.
- Explicit empty `instanceIds: []` is a no-op and does not enumerate all active assignments.
- Invalid target user fails at request boundary.
- Target requester is skipped fail-closed.
- Role-typed source assignments are skipped; only active user assignments are rewritten.
- The integration test is excluded from the no-DB Vitest config and included in the approval real-DB CI lane.

## Follow-ups

- `approvals:admin-data` is registered but has no runtime route yet; it is reserved for a future data-recovery scoped surface.
- The current `approval_assignments` active-unique index is instance-wide, so a target already active elsewhere in the same instance is skipped to avoid violating the existing schema. A narrower per-node duplicate model would require a schema change and is out of scope.
