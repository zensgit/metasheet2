# Redis Runtime Live Smoke Development - 2026-04-23

## Scope

This follow-up closes the remaining Redis runtime verification gap after the Redis wiring PR landed in `main`.

The existing live smoke already covered:

- `RedisTokenBucketStore`: Lua token consumption, TTL, and `SCRIPT FLUSH` / `NOSCRIPT` recovery.
- `RedisCircuitBreakerStore`: Lua failure window, `CLOSED -> OPEN`, TTL, and `SCRIPT FLUSH` / `NOSCRIPT` recovery.

This change adds the missing live coverage for:

- `RedisLeaderLock`: real Redis `SET NX PX`, owner-scoped renew, owner-scoped release, and takeover after release.

## Design

The smoke test stays opt-in:

- It runs only when `REDIS_URL` is set.
- It is skipped by default in local and CI environments without Redis.
- It uses a unique `ms2:*:<timestamp>:<random>:` prefix per test and deletes matching keys in `afterEach`.

The new test does not introduce new runtime code. It only exercises the existing `RedisLeaderLock` seam against an actual Redis server, which is the behavior that the memory twin cannot fully prove.

## Files

- `packages/core-backend/tests/integration/redis-runtime-stores.integration.test.ts`

## Verification Strategy

Two levels are expected:

- Default gate: no `REDIS_URL`; the live smoke file is discovered and skipped cleanly.
- Manual/live gate: `REDIS_URL=redis://127.0.0.1:6379`; all Redis runtime store smoke tests run against real Redis.

The live gate is intentionally not mandatory CI until the repo has a stable Redis service in CI.
