# Approval Pack 1A Follow-up Development And Verification

Date: `2026-04-13`

## Scope

This follow-up slice closes two Pack 1A gaps on top of `codex/approval-pack1a-runtime-20260413`:

1. Frontend consumption of Pack 1A semantics
   - return action affordance with `targetNodeKey`
   - richer timeline badges for `autoApproved`, `approvalMode`, `aggregateComplete`
   - template detail display for `approvalMode` and `emptyAssigneePolicy`
   - fixture and mock coverage for the new semantics
2. Backend regression coverage
   - end-to-end lifecycle test coverage for `approvalMode=all`
   - return-to-previous-node lifecycle coverage
   - empty-assignee `auto-approve` lifecycle coverage

## Branches

- Frontend: `codex/approval-pack1a-frontend-20260413`
- Backend integration: `codex/approval-pack1a-integration-20260413`

## Frontend Changes

Worktree: `/.worktrees/approval-pack1a-frontend-20260413`

Files changed:

- `apps/web/src/approvals/api.ts`
- `apps/web/src/views/approval/ApprovalDetailView.vue`
- `apps/web/src/views/approval/TemplateDetailView.vue`
- `apps/web/tests/helpers/approval-test-fixtures.ts`
- `apps/web/tests/approval-e2e-permissions.spec.ts`

Delivered behavior:

- `ApprovalDetailView` adds a return dialog and submits `targetNodeKey`
- return candidates are inferred from visited history `metadata.nodeKey`
- timeline badges now distinguish:
  - auto-approved system approvals
  - `approvalMode`
  - `aggregateComplete`
  - return target node
- `TemplateDetailView` renders approval mode and empty-assignee policy tags
- mock data and view tests cover return, auto-approve, and template mode display

## Backend Integration Changes

Worktree: `/.worktrees/approval-pack1a-integration-20260413`

Files changed:

- `packages/core-backend/tests/integration/approval-pack1a-lifecycle.api.test.ts`

Delivered coverage:

- create template -> publish -> create approval -> approve with `approvalMode=all`
- first approver keeps instance `pending` and leaves the remaining assignment active
- final approver completes the aggregate approval
- second approver can return to `approval_1` with `targetNodeKey`
- empty-assignee approval nodes auto-approve and record a system approval history row

## Verification

### Frontend

Passed:

```bash
cd .worktrees/approval-pack1a-frontend-20260413
pnpm --filter @metasheet/web exec vitest run tests/approval-e2e-permissions.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Observed result:

- `tests/approval-e2e-permissions.spec.ts`: `37 passed`
- `vue-tsc --noEmit`: passed

### Backend

Passed:

```bash
cd .worktrees/approval-pack1a-integration-20260413
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot

pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Observed result:

- `approval-pack1a-lifecycle.api.test.ts`: `3 passed`
- `tsc --noEmit --pretty false`: passed

Local environment note:

- PostgreSQL was provisioned locally via Homebrew service `postgresql@15`
- local connectivity was verified with `psql -h 127.0.0.1 -p 5432 -d postgres`
- the target integration suite now runs against `postgresql://chouhua@127.0.0.1:5432/postgres`
- server startup still logs degraded-mode warnings for unrelated BPMN / EventBus tables that are absent in this lightweight local DB, but the approval Pack 1A lifecycle suite passes

## Known Limits

- return target labels still render `nodeKey`; they do not yet map back to template node names
- the frontend return candidate list is history-driven, not graph-aware
- backend lifecycle verification has passed locally, but it still benefits from one CI run against a fuller migrated schema

## Recommended Next Verification

Keep the local PostgreSQL service running for any additional approval integration work:

```bash
/opt/homebrew/bin/brew services start postgresql@15
```
