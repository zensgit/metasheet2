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
## Rebase verification — 2026-04-22

Rebased from the original delivery baseline onto `origin/main@d547d89fcfcfded72f2e78a16320111d6def4f54`.

Rebased head:

```text
a452b3517 feat(approval): ship WP1 parallel gateway (并行分支) with join-all semantics
```

Commands rerun after rebase:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vue-tsc --noEmit

DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-parallel-gateway.api.test.ts \
    tests/integration/approval-wp1-any-mode.api.test.ts \
    tests/integration/approval-pack1a-lifecycle.api.test.ts \
    tests/integration/approval-wp2-source-filter.api.test.ts --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest run tests/unit --reporter=dot

git diff --check
```

Results:

- Backend TypeScript: passed with zero diagnostics.
- Frontend `vue-tsc`: passed.
- Integration regression: 4 files passed, 14/14 tests passed.
- Backend full unit suite: 123 files passed, 1591/1591 tests passed.
- `git diff --check`: passed.

Note: the full-unit count is one higher than the original delivery summary because `origin/main` now includes the #1077 WP2 source filter regression test.

## CI follow-up verification — 2026-04-23

PR #1081 first CI run exposed two packaging gaps that were not covered by the
focused local commands:

- `pnpm type-check` runs web type checking and caught `TemplateDetailView.vue`
  maps that were typed as `Record<ApprovalNodeType, ...>` but did not include
  the new `parallel` node type.
- `contracts (openapi)` caught generated dist drift after
  `packages/openapi/src/base.yml` added the parallel schema fields.

Fixes applied:

- Added `parallel` label / timeline / icon / tag entries to
  `apps/web/src/views/approval/TemplateDetailView.vue`.
- Rebuilt and committed `packages/openapi/dist/openapi.json`,
  `packages/openapi/dist/openapi.yaml`, and
  `packages/openapi/dist/combined.openapi.yml`.

Commands rerun:

```bash
pnpm exec tsx packages/openapi/tools/build.ts
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Results:

- OpenAPI build: completed and regenerated the expected dist files.
- Frontend `vue-tsc -b --noEmit`: passed.
- Backend TypeScript: passed with zero diagnostics.

The OpenAPI contract gate checks for a clean committed dist after running the
build; it is rerun after this fix commit is created so `git diff --quiet` can
observe the regenerated files as baseline.

Post-commit commands rerun:

```bash
./scripts/ops/attendance-run-gate-contract-case.sh openapi

DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-parallel-gateway.api.test.ts --reporter=dot

DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-any-mode.api.test.ts \
    tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot

DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp2-source-filter.api.test.ts --reporter=dot
```

Post-commit results:

- OpenAPI contract gate: passed.
- WP1 parallel integration: 3/3 passed.
- Pack 1A + or-mode regression: 4/4 passed.
- WP2 source filter regression: 7/7 passed.

Note: one local attempt to run all four integration files in the same Vitest
process hit a PostgreSQL DDL deadlock in shared fixture setup. The split
commands above are the stable pattern already used for this family of tests;
CI runs these jobs in a clean database context.

## Final main rebase — 2026-04-23

After #1079 and #1080 were merged, PR #1081 became `BEHIND`. The branch was
rebased onto `origin/main@2aa78e8680eb9f2e71e52e226de710886acb0ded` before
final merge instead of bypassing the stale-branch gate.

Rebased head stack:

```text
ecba58023 docs(approval): record WP1 CI follow-up verification
ada6f3977 fix(approval): publish parallel node contract artifacts
f5a3cf631 docs(approval): record WP1 parallel rebase verification
3ae85fcee feat(approval): ship WP1 parallel gateway (并行分支) with join-all semantics
```

Commands rerun after final rebase:

```bash
./scripts/ops/attendance-run-gate-contract-case.sh openapi
pnpm type-check
git diff --check

DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-parallel-gateway.api.test.ts --reporter=dot

DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-any-mode.api.test.ts \
    tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot

DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp2-source-filter.api.test.ts --reporter=dot
```

Final rebase results:

- OpenAPI contract gate: passed.
- Workspace type-check: passed.
- `git diff --check`: passed.
- WP1 parallel integration: 3/3 passed.
- Pack 1A + or-mode regression: 4/4 passed.
- WP2 source filter regression: 7/7 passed.
