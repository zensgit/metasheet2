# Private-database backend drain — verification (2026-09-25)

Design: `docs/development/timemachine-private-db-backend-drain-design-20260925.md`.

## What was checked

| Check | Result |
|---|---|
| Checkpoint calls `assertPrivateDatabaseBackendsExited` and no longer uses the one-shot count | unit guard `guards the checkpoint call site and the values-free census columns` |
| Census SQL is `pid, application_name, backend_type, state, backend_start` and does not name `query` or `usename` | same guard, imported `PRIVATE_DB_BACKEND_CENSUS_SQL` |
| Default unit Vitest excludes the DB proof, and plugin-tests.yml step `Run private-db backend drain proof` runs the file | same guard |
| Positive. Explicit `drainTimeoutMs: 8000`, `pollIntervalMs: 100`. A backend closed after 1500 ms. The helper returns before that 8 s limit. This is not the default timeout. | integration `positive: waits for a backend that exits after a short delay and returns clean` |
| Negative, short limit. Explicit `drainTimeoutMs: 400`, `pollIntervalMs: 50`. A backend is still held. The helper throws with pid, backend_type, state, application_name, backend_start, and without the statement marker. This is not the default timeout. | integration `negative: fails when a backend is still held, with values-free identifiers and no query text` |
| Negative, default limit. No options argument, so `drainTimeoutMs` is `PRIVATE_DB_BACKEND_DRAIN_MS` (10000) and `pollIntervalMs` is `PRIVATE_DB_BACKEND_POLL_MS` (200). A backend is held past that 10 s deadline. The helper throws at about 10 s with the same values-free identifiers and without the statement marker. | integration `negative: default timeout fails when a backend is held past 10s, with values-free identifiers and no query text` |

The integration file runs in CI on job `test` (`test (18.x)` and `test (20.x)`), step `Run private-db backend drain proof`.

The checkpoint imports `packages/core-backend/scripts/private-db-backend-drain.js`. That file assigns `exports.assertPrivateDatabaseBackendsExited`, which Node can link from the ESM script. A `.ts` helper compiled by tsx does not, and the checkpoint exits at startup before any census.

Local re-run after the load-path change, before the default-timeout case existed: the 8 s positive took 1607 ms and the 400 ms negative took 446 ms (2 passed). Those two calls pass an explicit `drainTimeoutMs`. They do not exercise the 10 s default. `tsc -p scripts/tsconfig.recovery-archive-acceptance.json --noEmit` exited 0. Starting the checkpoint script under tsx gets past the helper import.

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/timemachine-private-db-backend-drain.test.ts --watch=false
# Test Files  1 passed (1)
# Tests  1 passed (1)

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/timemachine-private-db-backend-drain.db.test.ts --reporter=verbose
# Test Files  1 passed (1)
# Tests  3 passed (3)
# positive (explicit 8000 ms limit) 1618ms
# negative (explicit 400 ms limit) 453ms
# negative default (PRIVATE_DB_BACKEND_DRAIN_MS = 10000, no options) 10062ms
# against a local throwaway database
```
