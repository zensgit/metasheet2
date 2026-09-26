# Private-database backend drain — verification (2026-09-25)

Design: `docs/development/timemachine-private-db-backend-drain-design-20260925.md`.

## What was checked

| Check | Result |
|---|---|
| Checkpoint calls `assertPrivateDatabaseBackendsExited` and no longer reads `pg_stat_activity` itself | unit guard `guards the checkpoint call site and the values-free census columns` |
| Census SQL is `pid, application_name, backend_type, state, backend_start` and does not name `query` or `usename` | same guard, imported `PRIVATE_DB_BACKEND_CENSUS_SQL` |
| Default unit Vitest excludes the DB proof, and plugin-tests.yml step `Run private-db backend drain proof` runs the file | same guard |
| A backend closed after ~1.5 s: helper returns inside 8 s and the wait is visible in elapsed time | integration `positive: waits for a backend that exits after a short delay and returns clean` |
| A backend held past 400 ms: helper throws with pid, backend_type, state, application_name, backend_start, and without the statement marker | integration `negative: fails when a backend is still held, with values-free identifiers and no query text` |

The integration file runs in CI on job `test` (`test (18.x)` and `test (20.x)`), step `Run private-db backend drain proof`.

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/timemachine-private-db-backend-drain.test.ts --watch=false
# Test Files  1 passed (1)
# Tests  1 passed (1)

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/timemachine-private-db-backend-drain.db.test.ts --reporter=verbose
# Test Files  1 passed (1)
# Tests  2 passed (2)
# positive 1616ms, negative 454ms, against a local throwaway database
```
