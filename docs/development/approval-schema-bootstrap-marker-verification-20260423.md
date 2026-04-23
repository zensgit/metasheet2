# Approval Schema Bootstrap Marker Verification - 2026-04-23

## Baseline Failure

Before the marker change, this command reproduced the existing fixture race:

```bash
DATABASE_URL=postgresql://chouhua@127.0.0.1:5432/postgres \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/approval-wp1-any-mode.api.test.ts \
  tests/integration/approval-pack1a-lifecycle.api.test.ts \
  tests/integration/approval-wp2-source-filter.api.test.ts \
  tests/integration/approval-wp1-parallel-gateway.api.test.ts \
  --reporter=dot
```

Result:

```text
Test Files  1 failed | 3 passed (4)
Tests       14 passed (15)
Failure     deadlock detected in ensureApprovalSchemaReady()
Exit        1
```

Postgres detail:

```text
Process waits for AccessExclusiveLock on approval_assignments while another process waits for RowShareLock.
```

## Commands Run

Backend typecheck:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result:

```text
Exit 0
```

Multi-file approval integration, first run after fix:

```bash
DATABASE_URL=postgresql://chouhua@127.0.0.1:5432/postgres \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/approval-wp1-any-mode.api.test.ts \
  tests/integration/approval-pack1a-lifecycle.api.test.ts \
  tests/integration/approval-wp2-source-filter.api.test.ts \
  tests/integration/approval-wp1-parallel-gateway.api.test.ts \
  --reporter=dot
```

Result:

```text
Test Files  4 passed (4)
Tests       15 passed (15)
Exit        0
```

Multi-file approval integration, repeat run with marker present:

```bash
DATABASE_URL=postgresql://chouhua@127.0.0.1:5432/postgres \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/approval-wp1-any-mode.api.test.ts \
  tests/integration/approval-pack1a-lifecycle.api.test.ts \
  tests/integration/approval-wp2-source-filter.api.test.ts \
  tests/integration/approval-wp1-parallel-gateway.api.test.ts \
  --reporter=dot
```

Result:

```text
Test Files  4 passed (4)
Tests       15 passed (15)
Exit        0
```

Marker check:

```bash
psql postgresql://chouhua@127.0.0.1:5432/postgres -Atqc \
  "SELECT key || '=' || version FROM approval_test_schema_bootstrap_state WHERE key = 'approval-schema-bootstrap'"
```

Result:

```text
approval-schema-bootstrap=20260423-once-per-db
```

Diff hygiene:

```bash
git diff --check
```

Result:

```text
Exit 0
```

## Notes

The local test database still logs degraded-mode startup errors for unrelated missing BPMN/EventBus/Automation tables. Those messages pre-existed this change and did not fail the approval integration tests.

