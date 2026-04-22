# Approval WP1 Parallel Gateway — Verification Log

> Date: 2026-04-22
> Branch: `codex/approval-wp1-parallel-gateway-20260422`
> Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/wp1-parallel`
> Base: `origin/main @ 27a9b9de1`

## Command log (all green)

```text
# Baseline before any changes (sanity that pack1a + any-mode + wp2 src-filter are green on this branch)
$ DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-any-mode.api.test.ts \
    tests/integration/approval-pack1a-lifecycle.api.test.ts \
    tests/integration/approval-wp2-source-filter.api.test.ts --reporter=dot
  Test Files  3 passed (3)
  Tests       8 passed (8)
  Duration    3.64s

# Backend TypeScript (both after data-model edits and after dispatch wiring; the second is recorded here)
$ pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
  (no output — clean)

# Web TypeScript
$ pnpm --filter @metasheet/web exec vue-tsc --noEmit
  (no output — clean)

# New parallel gateway integration test
$ DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-parallel-gateway.api.test.ts --reporter=dot
  Test Files  1 passed (1)
  Tests       3 passed (3)
  Duration    2.53s

# Regression (still green)
$ DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-any-mode.api.test.ts \
    tests/integration/approval-pack1a-lifecycle.api.test.ts \
    tests/integration/approval-wp2-source-filter.api.test.ts --reporter=dot
  Test Files  3 passed (3)
  Tests       8 passed (8)
  Duration    2.60s

# Combined integration sweep (parallel + regression)
$ DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-parallel-gateway.api.test.ts \
    tests/integration/approval-wp1-any-mode.api.test.ts \
    tests/integration/approval-pack1a-lifecycle.api.test.ts \
    tests/integration/approval-wp2-source-filter.api.test.ts --reporter=dot
  Test Files  4 passed (4)
  Tests       11 passed (11)
  Duration    2.64s

# Executor unit tests (existing + 2 new parallel cases)
$ pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-graph-executor.test.ts --reporter=dot
  Test Files  1 passed (1)
  Tests       10 passed (10)

# Full core-backend unit suite
$ pnpm --filter @metasheet/core-backend exec vitest run tests/unit --reporter=dot
  Test Files  123 passed (123)
  Tests       1590 passed (1590)
```

## Scenarios verified

| ID | Scenario | Entry point | Expected | Actual |
|----|----------|-------------|----------|--------|
| V1 | Template with parallel fork + join-all creates cleanly | `POST /api/approval-templates` | 201 | 201 |
| V2 | Publish of template with parallel nodes | `POST /api/approval-templates/:id/publish` | 200 | 200 |
| V3 | Create approval fans into two branches | `POST /api/approvals` | `currentNodeKey=parallel_fork`, `currentNodeKeys=[legal_review,compliance_review]`, two active assignments | Matches |
| V4 | First branch approver → instance stays pending with the other branch active | `POST /api/approvals/:id/actions` (legal-1 approves) | `status=pending`, `currentNodeKey=parallel_fork`, `currentNodeKeys=[compliance_review]` | Matches |
| V5 | Second branch approver → join-all triggers; instance advances past join | `POST /api/approvals/:id/actions` (compliance-1 approves) | `status=pending`, `currentNodeKey=finance_review`, `currentNodeKeys` absent | Matches |
| V6 | Post-join approver completes the instance | `POST /api/approvals/:id/actions` (finance-1 approves) | `status=approved`, `currentNodeKey=null` | Matches |
| V7 | Metadata strips `parallelBranchStates` once the region closes | SQL inspection | key absent | Matches |
| V8 | Return during parallel state | `POST /api/approvals/:id/actions` with `action=return` | 409 `APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED` | Matches |
| V9 | Duplicate approver across branches at template-creation time | `POST /api/approval-templates` | 400 `VALIDATION_ERROR` with "duplicate approver" | Matches |
| V10 | Pack 1A 会签 lifecycle unchanged | existing suite | 3/3 green | Matches |
| V11 | 或签 (any-mode) unchanged | existing suite | 1/1 green | Matches |
| V12 | WP2 sourceSystem filter unchanged | existing suite | 4/4 green | Matches |

## Baseline references

- Pack 1A: `packages/core-backend/tests/integration/approval-pack1a-lifecycle.api.test.ts`
- 或签 (any-mode): `packages/core-backend/tests/integration/approval-wp1-any-mode.api.test.ts`
- WP2 sourceSystem filter: `packages/core-backend/tests/integration/approval-wp2-source-filter.api.test.ts`

## Non-goals confirmed

- No DB migration introduced — parallel branch state is carried in
  pre-existing `approval_instances.metadata` JSONB.
- Pack 1A + or-mode integration suites pass unchanged on this branch;
  their test files are untouched.
- `listVisitedApprovalNodeKeysUntil` behavior on linear graphs is
  unchanged — only added a pass-through for parallel fork nodes so the
  walker can skip over them when computing return targets for a
  linearly-visited approval ahead of a later parallel region.

## Open follow-ups (documented in development MD)

- `joinMode: 'any'` first-branch-wins join.
- Return-to-node targeting a node inside a closed branch.
- Nested parallel regions.
- Branch-overlapping approvers (requires assignment-index rethink).
- Regression test combining 或签 aggregation inside a parallel branch.
