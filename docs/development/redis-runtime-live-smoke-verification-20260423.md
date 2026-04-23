# Redis Runtime Live Smoke Verification - 2026-04-23

## Commands

Default skip gate:

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/redis-runtime-stores.integration.test.ts --reporter=dot
```

Live Redis gate:

```bash
docker run -d --name ms2-redis-smoke-20260423 -p 6379:6379 redis:7
REDIS_URL=redis://127.0.0.1:6379 \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/redis-runtime-stores.integration.test.ts --reporter=dot
docker rm -f ms2-redis-smoke-20260423
```

Typecheck:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Diff hygiene:

```bash
git diff --check
```

## Expected Result

- Without `REDIS_URL`: 1 integration file is skipped.
- With live Redis: 3 smoke tests pass:
  - token bucket Lua + `SCRIPT FLUSH` recovery
  - circuit breaker Lua + `SCRIPT FLUSH` recovery
  - leader lock acquire/renew/release owner semantics

## Notes

This smoke remains an opt-in manual gate. It proves Redis server Lua and lock semantics without forcing every CI job to provision Redis.

## Run Result - 2026-04-23

Default skip gate:

```text
Test Files  1 skipped (1)
Tests       3 skipped (3)
Exit        0
```

Live Redis gate (`docker run redis:7`, `REDIS_URL=redis://127.0.0.1:6379`):

```text
Test Files  1 passed (1)
Tests       3 passed (3)
Exit        0
```

Typecheck:

```text
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
Exit 0
```

Diff hygiene:

```text
git diff --check
Exit 0
```
