# Approval Wave 2 WP1 - Verification

- Date: 2026-04-20
- Branch: `codex/approval-wave2-wp1-runtime-202605`
- Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/wp1`

## Environment

- Node / pnpm: repo-standard (pnpm 10.33.0 reported by install).
- Postgres: local `postgresql@15` on 127.0.0.1:5432, db `postgres`, user `chouhua`.
- DATABASE_URL: `postgresql://chouhua@127.0.0.1:5432/postgres`

## Commands and results

### 1. Backend typecheck

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result: PASS (no output, exit 0).

### 2. New any-mode integration test

```bash
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/approval-wp1-any-mode.api.test.ts --reporter=dot
```

Result: PASS. `Test Files 1 passed (1) / Tests 1 passed (1)` - duration ~2.79s.

Note on log noise: pre-existing `bpmn_process_definitions`, `event_types`, and
`automation_rules` tables are not materialized by the lightweight integration
bootstrap and trigger expected "degraded mode" warnings. These are unrelated to
the approval runtime and do not affect the approval test outcome (the Pack 1A
test suite shows the same warnings).

### 3. Pack 1A regression

```bash
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot
```

Result: PASS. `Test Files 1 passed (1) / Tests 3 passed (3)` - duration ~2.49s.

### 4. Approval executor unit tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/approval-graph-executor.test.ts --reporter=dot
```

Result: PASS. `Test Files 1 passed (1) / Tests 8 passed (8)` (the new
`tags resolveAfterApprove resolutions with the resolved-away node aggregate mode`
case plus the 7 pre-existing ones).

### 5. Full core-backend unit suite

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit --reporter=dot
```

Result: PASS. `Test Files 113 passed (113) / Tests 1454 passed (1454)`.

### 6. Frontend typecheck

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result: PASS (no output, exit 0).

### 7. Frontend related-test smoke

```bash
cd apps/web && pnpm exec vitest run \
  tests/plmApprovalHistoryDisplay.spec.ts tests/approval-e2e-lifecycle.spec.ts \
  --reporter=dot
```

Result: PASS. `Test Files 2 passed (2) / Tests 46 passed (46)`.

The `apps/web/tests/approval-center.spec.ts` suite fails on both the WP1 branch
and `origin/main` with the same 5 errors - pre-existing baseline failure
unrelated to this PR's changes.

## Summary

| Step | Outcome | Counts |
| ---- | ------- | ------ |
| 1. Backend tsc | PASS | - |
| 2. New any-mode integration | PASS | 1/1 |
| 3. Pack 1A regression | PASS | 3/3 |
| 4. Executor unit tests | PASS | 8/8 |
| 5. Core-backend unit suite | PASS | 1454/1454 |
| 6. Frontend vue-tsc | PASS | - |
| 7. Frontend approval smoke | PASS | 46/46 |

All required verification commands pass. Pack 1A behavior is preserved.
