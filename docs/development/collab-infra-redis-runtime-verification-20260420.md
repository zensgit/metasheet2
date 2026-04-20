# Redis runtime adapters — verification log

- **Date**: 2026-04-20
- **Branch**: `codex/collab-infra-redis-runtime-202605`
- **Worktree**: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/redis`
- **Scope**: verify that the Redis-backed TokenBucketStore and CircuitBreakerStore adapters typecheck, pass their new unit tests, and do not regress the existing rate-limiter tests.

All commands were executed from the worktree root.

## 1. TypeScript typecheck (core-backend)

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result: **PASS** — zero diagnostics emitted.

## 2. New unit tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/redis-token-bucket-store.test.ts \
  tests/unit/redis-circuit-breaker-store.test.ts \
  --reporter=dot
```

```
 Test Files  2 passed (2)
      Tests  25 passed (25)
```

Breakdown:

| File | Tests | Coverage highlights |
| --- | --- | --- |
| `redis-token-bucket-store.test.ts` | 11 | initial consume, refill/clamp, reject with retryAfterMs, burst exhaustion, refillRate=0, parallel consume atomicity, SCRIPT LOAD + EVALSHA caching, NOSCRIPT recovery, EVAL fallback, prefix/TTL argument wiring, Lua source asserts. |
| `redis-circuit-breaker-store.test.ts` | 14 | CLOSED→OPEN threshold, CLOSED stays below volume, OPEN→HALF_OPEN via `checkAndUpdate`, HALF_OPEN success→CLOSED (window cleared), HALF_OPEN failure→OPEN, explicit transitions, `MemoryCircuitBreakerStore` full cycle, admin force open/close, Redis dispatch for failure flip, NOSCRIPT recovery, cooldown-driven transition via Redis, HALF_OPEN flip paths through Redis, `getSnapshot` is a pure HMGET read (no window trim). |

## 3. Regression — existing rate-limiter tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/rate-limiter.test.ts --reporter=dot
```

```
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

## 4. Regression — existing TokenBucket behaviour

```bash
pnpm --filter @metasheet/core-backend exec vitest run src/tests/rate-limiting.test.ts --reporter=dot
```

```
 Test Files  1 passed (1)
      Tests  36 passed (36)
```

Log output confirmed the new constructor seam is exercised — new logs include `"store":"memory-sync"` showing that unchanged callers continue to use the in-process path.

## Summary

- Typecheck: PASS
- New adapter tests: 25 / 25 PASS
- Existing rate-limiter tests: 15 / 15 PASS
- Existing TokenBucket rate-limiting tests: 36 / 36 PASS

No live Redis server was required or started. All Redis behaviour is exercised through (a) pure-JS twins of the Lua scripts, (b) an in-memory Redis shim that routes `eval` / `evalsha` / `script LOAD` through those twins.
