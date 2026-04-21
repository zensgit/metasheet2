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

---

## Rebase verification — 2026-04-21

Branch rebased from base `0756ff61d` onto latest `origin/main@c4093dcb8` (+21 commits upstream, no business-file overlap with this branch). Rebase was pure fast-forward with no merge conflict; business diff unchanged (9 files, +1032 / −22).

Post-rebase HEAD: `02dcceda2`.

### Commands run (2026-04-21, .worktrees/wp1)

```bash
git -C .worktrees/wp1 checkout -- plugins/ tools/   # clean dirty pnpm symlinks (26 entries)
git -C .worktrees/wp1 fetch origin main
git -C .worktrees/wp1 rebase origin/main             # no conflicts

pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vue-tsc --noEmit

# Run separately to avoid vitest file-parallel DDL race (see note below)
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-any-mode.api.test.ts --reporter=dot

DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-graph-executor.test.ts --reporter=dot
```

### Results

| Step | Outcome | Counts |
| ---- | ------- | ------ |
| tsc --noEmit | PASS | zero diagnostics |
| vue-tsc --noEmit | PASS | zero diagnostics |
| any-mode integration (alone) | PASS | 1/1 |
| Pack 1A regression (alone) | PASS | 3/3 |
| Executor unit | PASS | 8/8 |

### Concurrency note (follow-up)

When both `approval-wp1-any-mode.api.test.ts` and `approval-pack1a-lifecycle.api.test.ts` are passed to a single `vitest run` invocation, vitest runs the two files in parallel workers. Both fixtures call an `ensureApprovalTables()` that performs non-atomic `DROP ... IF EXISTS` + `ADD CONSTRAINT` / `CREATE UNIQUE INDEX IF NOT EXISTS` against the shared schema, creating a race window where the second file's `ADD CONSTRAINT` / `CREATE INDEX` fails with `42710` (duplicate_object) or `23505` (pg_class unique violation).

Workaround for this rebase verification: run the two integration files in separate `vitest run` invocations — both then pass (1/1 + 3/3).

Follow-up proposal (do NOT include in this PR, scope creep): wrap `ensureApprovalTables()` in a `pg_advisory_xact_lock(hashtext('ensureApprovalTables'))` via a dedicated `pool.connect()` client + explicit `BEGIN/COMMIT`, so concurrent test files serialize on DDL. Pack 1A also benefits — that test was merged to main with the same fixture shape.

### Baseline

| Field | Value |
| ----- | ----- |
| Original base commit | `0756ff61d` |
| Rebase target | `c4093dcb8` (origin/main, +21 commits) |
| New branch HEAD | `02dcceda2` |
| Upstream business-file overlap | none |
| Rebase conflicts | none |

---

## Latest-main verification — 2026-04-21

After the DingTalk/Yjs queue landed, this branch was advanced again from `origin/main@c4093dcb8` to `origin/main@81edca7d9`. Rebase used `git rebase --autostash origin/main`, preserved the verification MD changes, and completed with no conflicts.

Post-latest-main HEAD: `f2c030f33`.

### Commands run (2026-04-21, .worktrees/wp1)

```bash
git -C .worktrees/wp1 rebase --autostash origin/main

pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vue-tsc --noEmit

DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-any-mode.api.test.ts --reporter=dot

DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-graph-executor.test.ts --reporter=dot
```

### Results

| Step | Outcome | Counts |
| ---- | ------- | ------ |
| Rebase onto `81edca7d9` | PASS | zero conflicts |
| tsc --noEmit | PASS | zero diagnostics |
| vue-tsc --noEmit | PASS | zero diagnostics |
| any-mode integration (alone) | PASS | 1/1 |
| Pack 1A regression (alone) | PASS | 3/3 |
| Executor unit | PASS | 8/8 |

The BPMN/EventBus/Automation startup diagnostics in the integration logs are expected for this local partial-schema test database; the server continues in degraded mode and the targeted approval tests pass.
