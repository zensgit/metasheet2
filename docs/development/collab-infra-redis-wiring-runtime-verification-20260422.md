# Redis wiring runtime — verification log (2026-04-22)

- **Branch**: `codex/collab-infra-redis-wiring-runtime-20260422`
- **Worktree**: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/redis-wiring`
- **Base commit**: `27a9b9de1`
- **Companion dev log**: `docs/development/collab-infra-redis-wiring-runtime-development-20260422.md`

## Commands run

```bash
cd /Users/chouhua/Downloads/Github/metasheet2/.worktrees/redis-wiring
pnpm install --prefer-offline

pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/api-gateway-redis-wiring.test.ts \
  tests/unit/redis-leader-lock.test.ts \
  tests/unit/automation-scheduler-leader.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/redis-token-bucket-store.test.ts \
  tests/unit/redis-circuit-breaker-store.test.ts \
  tests/unit/rate-limiter.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest run tests/unit --reporter=dot
```

## Results

| Command | Status | Notes |
| --- | --- | --- |
| `pnpm install --prefer-offline` | OK | 3.1 s, warnings about ignored build scripts only (bcrypt, core-js, esbuild, etc.) — unchanged from baseline. |
| `tsc --noEmit --pretty false` | OK | Zero errors. |
| New unit tests (3 files) | **26 passed / 0 failed** (3 files) | `api-gateway-redis-wiring`: 6. `redis-leader-lock`: 16. `automation-scheduler-leader`: 4. Duration ~460 ms. |
| #1016 regression (3 files) | **40 passed / 0 failed** (3 files) | `redis-token-bucket-store`: 11. `redis-circuit-breaker-store`: 14. `rate-limiter`: 15. Duration ~630 ms. |
| Full core-backend unit suite | **1614 passed / 0 failed** (126 files) | Duration ~6.3 s. One expected stderr log from `server-lifecycle.test.ts` about a missing DB — pre-existing, tests the degraded-mode startup path. |

## Baseline reference

- Base commit `27a9b9de1` on the target branch (codex/collab-infra-redis-wiring-runtime-20260422 was already set up off origin/main at `27a9b9de1`).
- PR #1016 adapters (`RedisCircuitBreakerStore`, `RedisTokenBucketStore`) continue to pass their original unit tests unchanged after the wiring work.
- Legacy `AutomationScheduler(callback)` single-argument constructor path is still exercised by `tests/unit/automation-v1.test.ts` — the suite shows 0 failures, confirming backwards compatibility.

## Wiring confirmed live

- `packages/core-backend/src/index.ts` (`MetaSheetServer.start`) now `await`s `resolveAutomationSchedulerLeaderOptions()` and passes the result to `new AutomationService(...)`. `ENABLE_SCHEDULER_LEADER_LOCK=true` therefore has effect on production startup (opt-in); with the flag unset the returned value is `null`, which matches the pre-change constructor signature.
- `APIGateway` has no current `MetaSheetServer.start` caller. The helper `gateway.initRedisCircuitBreakerStore()` is exposed so any integrator that builds an `APIGateway` instance can wire it in one line; ENABLE/DISABLE flag handling lives inside the helper.

## What the tests prove

1. **APIGateway wiring**
   - `ENABLE_REDIS_CIRCUIT_BREAKER_STORE` unset → breakers have `store === null` (memory path).
   - Flag `true` + healthy Redis → `gateway.getCircuitBreakerStoreForTest()` is a `RedisCircuitBreakerStore`, and every endpoint breaker's `getStoreForTest()` returns that same instance.
   - Flag `true` + Redis returns `null` → falls back to memory; startup does not block.
   - Flag `true` + factory throws → caught, warning logged, falls back to memory.
   - `DISABLE_REDIS_CIRCUIT_BREAKER_STORE=true` overrides ENABLE → forced memory path.

2. **RedisLeaderLock**
   - `acquire`: atomic SET NX PX semantics; returns `true` once, `false` until the owner changes.
   - `renew`: only owner-matching calls extend the TTL; expired keys cannot be renewed.
   - `release`: only owner-matching calls delete the key.
   - `isHeldBy`: reflects live state including TTL expiry.
   - All four methods swallow Redis connection errors and return `false`/`null` — no crash surface.

3. **AutomationScheduler leader election**
   - Two instances sharing the same memory-backed lock: only the first one registers timers; the second silently skips both interval and cron triggers.
   - Legacy single-arg constructor still produces a scheduler that acts as leader — no regression in `automation-v1.test.ts` scheduler tests.
   - Renewal returning `0` (simulating TTL expiry / owner mismatch) triggers `relinquishLeadership`: timers are cleared, `isLeader` flips to `false`, renewal loop stops.
