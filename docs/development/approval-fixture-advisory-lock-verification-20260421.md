# Approval integration fixture — advisory-lock verification

- Branch: `codex/approval-fixture-advisory-lock-20260421`
- Worktree: `.worktrees/fixture-lock`
- Baseline: `origin/main@6c5c652d1` (`feat(infra): add Redis runtime stores for token bucket and circuit breaker (#1016)`)
- Date: 2026-04-21
- Local Postgres: `postgresql://chouhua@127.0.0.1:5432/postgres`

## 1. Commands executed

All commands run from the worktree (`/Users/chouhua/Downloads/Github/metasheet2/.worktrees/fixture-lock`).

### 1.1 Install (offline where possible)

```bash
pnpm install --prefer-offline
```

- Result: `Done in 3.1s using pnpm v10.33.0` — 844 packages resolved, lockfile
  untouched.

### 1.2 Typecheck

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

- Result: exit code `0`, no diagnostics.

### 1.3 Critical parallel run — both integration files in a SINGLE vitest invocation

```bash
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-any-mode.api.test.ts \
    tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot
```

- Test files: `2 passed (2)`
- Tests: `4 passed (4)`
  - `approval-wp1-any-mode.api.test.ts` — 1 test (any-mode approval with
    sibling-cancel audit metadata)
  - `approval-pack1a-lifecycle.api.test.ts` — 3 tests (all-mode pending,
    return-to-prior-node, auto-approve empty-assignee)
- Duration: `3.15s`
- No `42710 (duplicate_object)` or `23505 (unique_violation)` Postgres errors
  were emitted. (Unrelated `event_types` / `automation_rules` degraded-mode
  warnings appear for services these tests don't use; they are pre-existing
  and unaffected by this change.)

### 1.4 WP1 alone

```bash
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-any-mode.api.test.ts --reporter=dot
```

- Test files: `1 passed (1)`
- Tests: `1 passed (1)`
- Duration: `2.45s`

### 1.5 Pack 1A alone

```bash
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot
```

- Test files: `1 passed (1)`
- Tests: `3 passed (3)`
- Duration: `2.49s`

### 1.6 Unit regression spot-check — approval-graph-executor

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/approval-graph-executor.test.ts --reporter=dot
```

- Test files: `1 passed (1)`
- Tests: `8 passed (8)`
- Duration: `272ms`

## 2. Result summary

| Gate                                     | Files | Tests | Status |
| ---------------------------------------- | ----: | ----: | ------ |
| tsc --noEmit (core-backend)              | —     | —     | PASS   |
| WP1 + Pack 1A combined (single vitest)   | 2     | 4     | PASS   |
| WP1 alone                                | 1     | 1     | PASS   |
| Pack 1A alone                            | 1     | 3     | PASS   |
| approval-graph-executor unit             | 1     | 8     | PASS   |

The combined run is the critical proof that the advisory-lock serialization
removes the file-parallel race described in the WP1 or-mode rebase
verification notes for 2026-04-20 / 2026-04-21.

## 3. Baseline references

- Worktree HEAD at start: `6c5c652d1086674772ae78cc451f057563bb69b4`
- `origin/main` at start: same (`6c5c652d1`)
- Commit created by this PR adds: the helper + two refactored test files +
  this doc + the development note, as one single commit (no `--amend`).

## 4. Rebase verification - 2026-04-22

Rebased onto `origin/main@9f07a1a408faa761adc2e746b86ef5905c9f2735`.

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-any-mode.api.test.ts \
    tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-graph-executor.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend build
git diff --check origin/main...HEAD
```

Result:

- Typecheck: passed.
- Critical combined integration run: passed, 2 files / 4 tests.
- `approval-graph-executor` unit regression: passed, 1 file / 8 tests.
- Backend build: passed.
- `git diff --check`: passed.
- Pre-existing degraded-mode logs for missing optional `bpmn_process_definitions`, `event_types`, and `automation_rules` tables appeared during integration startup; assertions passed and exit code was 0.
