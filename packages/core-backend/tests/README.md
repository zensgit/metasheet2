# Core Backend Tests

`packages/core-backend` uses Vitest with separate entry points for unit, integration, and Phase 5 observability checks.

## Current Test Entry Points

From the repo root:

```bash
pnpm --filter @metasheet/core-backend test
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/core-backend test:integration
pnpm --filter @metasheet/core-backend test:integration:attendance
pnpm --filter @metasheet/core-backend test:phase5
pnpm --filter @metasheet/core-backend test:cache
```

From `packages/core-backend/`:

```bash
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:integration:attendance
pnpm test:phase5
pnpm test:cache
```

## Test Layout

```text
tests/
├── unit/                 Fast local tests for services, routes, utils, and server lifecycle
├── integration/          Server + database integration coverage
├── fixtures/             Test fixtures and generated plugin fixtures
├── utils/                Test helpers and mocks
├── setup.ts              Default unit-test setup
├── setup.integration.ts  Integration-test setup
└── globalTeardown.ts     Shared cleanup
```

There are also legacy tests under `src/tests/` and `src/routes/__tests__/`. They are still picked up by the default `vitest` run unless explicitly excluded by config.

## Config Split

- `vitest.config.mts`
  Runs the default backend suite in Node.
  Excludes `tests/integration/**`.
- `vitest.integration.config.mts`
  Runs only `tests/integration/**`.
- `vitest.phase5.config.mts`
  Runs a narrow Phase 5 production-hardening subset.
- `vitest.cache.config.mts`
  Runs cache tests against the compiled cache test build.

## Environment Notes

- `tests/setup.integration.ts` enables `RBAC_BYPASS=true` and `RBAC_TOKEN_TRUST=true` for integration runs.
- Several integration tests require a reachable Postgres database and expected tables. Some of them self-skip when prerequisites are missing.
- A few integration tests create or mutate supporting tables in the target database. Prefer an isolated local test database.

## Coverage

The default backend Vitest config currently enforces these minimum thresholds:

- `lines`: 50
- `statements`: 50
- `branches`: 40
- `functions`: 50

Treat those as the actual gate. Higher coverage goals may still appear in older docs, but they are not the current enforced thresholds.

## Recommended Local Workflow

For fast feedback:

```bash
pnpm --filter @metasheet/core-backend lint
pnpm --filter @metasheet/core-backend type-check
pnpm --filter @metasheet/core-backend test:unit
```

Before touching DB-backed flows:

```bash
pnpm --filter @metasheet/core-backend test:integration
```
