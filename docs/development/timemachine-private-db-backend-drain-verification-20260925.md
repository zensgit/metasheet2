# Private-database backend drain — verification (2026-09-25)

Design: `docs/development/timemachine-private-db-backend-drain-design-20260925.md`.

## What was checked

| Check | Result |
|---|---|
| The clean path calls `assertPrivateDatabaseBackendsExited` instead of one immediate count | source test `waits for asynchronous backend exit and still fails a real leak with identity columns` |
| Deadline is 10 seconds | `PRIVATE_DB_BACKEND_DRAIN_MS = 10_000` in that test |
| A non-zero census after the deadline still throws, and the message lists pid, usename, application_name, backend_type, state, query, backend_start | same source test; `assert.equal(rows.length, 0, ...)` |
| The previous one-shot `count(*)` assertion is gone | same source test |

The full manual checkpoint cluster is the existing `test (20.x)` step (`Run isolated manual checkpoint acceptance`). This change does not start that cluster locally.

## Command

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/timemachine-private-db-backend-drain.test.ts --watch=false
# Test Files  1 passed (1)
# Tests  1 passed (1)
```
