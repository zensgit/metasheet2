# Approval WP1 Parallel Join-Any Verification - 2026-04-23

## Commands Run

Unit test:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-graph-executor.test.ts --reporter=dot
```

Result:

```text
Test Files  1 passed (1)
Tests       12 passed (12)
Exit        0
```

Backend typecheck:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result:

```text
Exit 0
```

Frontend typecheck:

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result:

```text
Exit 0
```

WP1 parallel integration:

```bash
DATABASE_URL=postgresql://chouhua@127.0.0.1:5432/postgres \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/approval-wp1-parallel-gateway.api.test.ts \
  --reporter=dot
```

Result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
Exit        0
```

Adjacent approval regression:

```bash
DATABASE_URL=postgresql://chouhua@127.0.0.1:5432/postgres \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/approval-wp1-any-mode.api.test.ts \
  --reporter=dot

DATABASE_URL=postgresql://chouhua@127.0.0.1:5432/postgres \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/approval-pack1a-lifecycle.api.test.ts \
  --reporter=dot

DATABASE_URL=postgresql://chouhua@127.0.0.1:5432/postgres \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/approval-wp2-source-filter.api.test.ts \
  --reporter=dot
```

Result:

```text
approval-wp1-any-mode.api.test.ts      1 passed (1), 1 test
approval-pack1a-lifecycle.api.test.ts  1 passed (1), 3 tests
approval-wp2-source-filter.api.test.ts 1 passed (1), 7 tests
Total adjacent regression              3 files, 11 tests
Exit        0
```

Diff hygiene:

```bash
git diff --check
```

Result:

```text
Exit 0
```

## Scenarios Covered

- Executor accepts a `joinMode='any'` parallel state and advances past the join after one branch reaches the join.
- Executor preserves pre-parallel CC events when a join-any branch auto-completes during initial fan-out.
- HTTP create/publish creates a join-any parallel approval with two active branches.
- First branch approval advances to the post-join `finance_review` node.
- Sibling branch assignment is cancelled before post-join assignment insertion.
- Cancelled sibling assignment metadata records the winning actor and parallel node.
- Late sibling approver receives `403` because their assignment is no longer active.
- Post-join approver completes the instance.
- `parallelBranchStates` is removed from instance metadata after leaving the parallel region.
- Approval audit metadata records `parallelJoinMode='any'` and cancelled assignees.
- A `sign` audit row records branch auto-cancellation for timeline consumers.

## Verification Notes

One attempted verification ran multiple approval integration files in the same Vitest invocation against the same local Postgres database. That caused a DDL/bootstrap deadlock in `ensureApprovalSchemaReady()`.

The stable pattern for these live-DB approval integration tests is one integration file per command against the shared local database. Single-file runs are green and are the results recorded above.
