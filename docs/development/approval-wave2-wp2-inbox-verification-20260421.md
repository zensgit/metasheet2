# Approval Wave 2 WP2 — Unified Inbox (Verification)

- Date: 2026-04-21
- Branch: `codex/approval-wave2-wp2-inbox-20260421`
- Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/wp2-inbox`
- Baseline: `origin/main@6c5c652d1`

## Environment

- macOS, Node via pnpm workspace at repo root.
- Postgres: `postgresql://chouhua@127.0.0.1:5432/postgres` (integration DB).
- PLM env vars: unset → adapter operates in mock mode after `connect()`.

## Commands executed

### 1. Typechecks

```
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
# exit 0, no errors

pnpm --filter @metasheet/web exec vue-tsc --noEmit
# exit 0, no errors
```

### 2a. Bridge write-path unit test

```
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/plm-approval-bridge.test.ts --reporter=dot
```

Result: `Test Files 1 passed (1)`, `Tests 4 passed (4)`. Includes the extended WP2 case pinning
`externalSystem='plm'` on every bridged record.

### 2. New integration test

```
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 \
PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-wp2-source-filter.api.test.ts --reporter=dot
```

Result: `Test Files 1 passed (1)`, `Tests 4 passed (4)`, duration ~2.5s.

Covered cases:
- `sourceSystem=all` → mixed feed includes both the seeded platform and PLM rows.
- `sourceSystem=platform` → exactly one row (platform) returned.
- `sourceSystem=plm` → exactly one row (PLM) returned.
- `sourceSystem=bogus` → HTTP 400 with code `APPROVAL_SOURCE_SYSTEM_INVALID`.

### 3. Backend neighbour regressions

```
DATABASE_URL=... pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/approval-wp1-any-mode.api.test.ts --reporter=dot
# Test Files 1 passed (1), Tests 1 passed (1)

DATABASE_URL=... pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot
# Test Files 1 passed (1), Tests 3 passed (3)
```

### 4. New frontend spec

```
pnpm --filter @metasheet/web exec vitest run \
  tests/approvalCenterSourceFilter.spec.ts --reporter=dot
```

Result: `Test Files 1 passed (1)`, `Tests 4 passed (4)`, duration ~0.4s. Non-fatal
`[Vue warn] Failed to resolve component: el-icon` appears (matches existing specs; the
icon component is intentionally not stubbed and does not affect behaviour).

Covered cases:
- Default mount call carries `sourceSystem: 'all'`.
- Dropdown exposes options for `all`, `platform`, `plm`.
- Switching to `plm` triggers a reload with `sourceSystem: 'plm'`.
- Switching to `platform` triggers a reload with `sourceSystem: 'platform'`.

### 5. Frontend neighbour regression

```
pnpm --filter @metasheet/web exec vitest run \
  tests/approval-e2e-permissions.spec.ts --reporter=dot
```

Result: `Test Files 1 passed (1)`, `Tests 37 passed (37)`, duration ~0.9s. No regression.

## Baseline notes

- The pre-existing `apps/web/tests/approval-center.spec.ts` fails on `origin/main@6c5c652d1`
  (verified with `git stash`) because `useApprovalPermissions` reads `localStorage` during setup
  and the jsdom environment isn't always primed in time. The new `approvalCenterSourceFilter.spec.ts`
  works around this by mocking `useApprovalPermissions`. Fixing the neighbour spec is out of scope
  for WP2 — documenting here for a subsequent DX ticket.

## Summary

All new tests pass (4 integration + 4 frontend = 8). All neighbour regressions pass
(1 + 3 backend integration, 37 frontend permissions spec). Typechecks clean on both
workspaces.

## Rebase verification - 2026-04-22

Rebased onto `origin/main@9f07a1a408faa761adc2e746b86ef5905c9f2735`.

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-approval-bridge.test.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run tests/approvalCenterSourceFilter.spec.ts tests/approval-e2e-permissions.spec.ts --reporter=dot
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/approval-wp2-source-filter.api.test.ts --reporter=dot
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/approval-wp1-any-mode.api.test.ts --reporter=dot
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend build
git diff --check origin/main...HEAD
```

Result:

- Core backend typecheck: passed.
- Web typecheck: passed.
- PLM bridge unit regression: passed, 1 file / 4 tests.
- Frontend source filter + permissions regression: passed, 2 files / 41 tests.
- WP2 source filter integration: passed, 1 file / 4 tests.
- WP1 neighbour integration: passed, 1 file / 1 test.
- Pack 1A neighbour integration: passed, 1 file / 3 tests.
- Backend build: passed.
- `git diff --check`: passed.
- Non-fatal existing Vue `el-icon` warning and degraded-mode backend startup logs appeared; assertions passed and exit code was 0.

## Post-fixture-lock rebase verification - 2026-04-22

After PRs #1066, #1067, and #1068 merged, this branch was rebased onto `origin/main@b2c3545e5246c8738d4b0b9c5ab945e63a4aa319`. The WP2 integration test was updated to reuse the shared `ensureApprovalSchemaReady()` helper introduced by #1067 instead of carrying a duplicate inline DDL bootstrap.

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp2-source-filter.api.test.ts \
    tests/integration/approval-wp1-any-mode.api.test.ts \
    tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-approval-bridge.test.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run tests/approvalCenterSourceFilter.spec.ts tests/approval-e2e-permissions.spec.ts --reporter=dot
pnpm --filter @metasheet/core-backend build
git diff --check origin/main...HEAD
```

Result:

- Core backend typecheck: passed.
- Web typecheck: passed.
- Combined approval integration run: passed, 3 files / 8 tests.
- PLM bridge unit regression: passed, 1 file / 4 tests.
- Frontend source filter + permissions regression: passed, 2 files / 41 tests.
- Backend build: passed.
- `git diff --check`: passed.
- Non-fatal existing Vue `el-icon` warning and degraded-mode backend startup logs appeared; assertions passed and exit code was 0.
