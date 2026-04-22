# Redis wiring runtime — development log (2026-04-22)

- **Date**: 2026-04-22
- **Branch**: `codex/collab-infra-redis-wiring-runtime-20260422`
- **Worktree**: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/redis-wiring`
- **Base commit**: `27a9b9de1` (`feat(approval): add sourceSystem filter for unified inbox`)

## Scope

Consume the Redis store adapters landed in PR #1016 from two production code paths, strictly behind feature flags so the default behaviour is unchanged:

1. `APIGateway` — route each internal `CircuitBreaker` through `RedisCircuitBreakerStore` when Redis is available.
2. `AutomationScheduler` — add Redis-backed single-leader election so only one replica runs the interval/cron timers for a given rule set.

This is **additive**. The public API of `CircuitBreaker`, `APIGateway`, and `AutomationScheduler` is unchanged; existing callers continue to run on the memory path without code changes.

## Files added

| Path | Purpose |
| --- | --- |
| `packages/core-backend/src/multitable/redis-leader-lock.ts` | `RedisLeaderLock` helper (SET NX PX + owner-scoped Lua renew/release) and `MemoryLeaderLockClient` pure-JS twin for tests. |
| `packages/core-backend/tests/unit/redis-leader-lock.test.ts` | 16 unit tests covering acquire/renew/release/isHeldBy, TTL expiry, owner checks, and multi-process simulation. |
| `packages/core-backend/tests/unit/automation-scheduler-leader.test.ts` | 4 unit tests: leader vs non-leader timer creation, legacy compat, relinquish-on-renewal-failure. |
| `packages/core-backend/tests/unit/api-gateway-redis-wiring.test.ts` | 6 unit tests: feature flag on/off, Redis available/unreachable, DISABLE kill switch, factory error recovery. |

## Files modified (additive only)

| Path | Change |
| --- | --- |
| `packages/core-backend/src/gateway/APIGateway.ts` | New private `circuitBreakerStore` field; new `async initRedisCircuitBreakerStore({ clientFactory?, keyPrefix? })` method; `registerEndpoint` passes the store to each `new CircuitBreaker(...)` when available; new `getCircuitBreakerStoreForTest()` introspection hook. |
| `packages/core-backend/src/gateway/CircuitBreaker.ts` | New `getStoreForTest()` method (read-only access to the `store` field that already landed in #1016). |
| `packages/core-backend/src/multitable/automation-scheduler.ts` | New optional `leaderOptions` constructor arg (`{ leaderLock, ownerId, ttlMs?, lockKey?, renewIntervalMs? }`), `public readonly ready: Promise<void>` for awaiting initial election verdict, `isLeader` flag, renewal loop, `relinquishLeadership` teardown path, `destroy` best-effort lock release. |
| `packages/core-backend/src/multitable/automation-service.ts` | Constructor accepts optional `schedulerLeaderOptions`; `loadAndRegisterAllScheduled` now `await`s `scheduler.ready` before touching the DB; new `resolveAutomationSchedulerLeaderOptions()` helper reads `ENABLE_SCHEDULER_LEADER_LOCK` + `SCHEDULER_LEADER_LOCK_TTL_MS`, calls `getRedisClient()`, returns `null` when either is missing. |
| `packages/core-backend/src/index.ts` (`MetaSheetServer.start`) | Production `AutomationService` construction now awaits `resolveAutomationSchedulerLeaderOptions()` and passes the result. With `ENABLE_SCHEDULER_LEADER_LOCK` unset (the default) the helper returns `null` and startup is byte-for-byte unchanged. |

## Feature flags

### `ENABLE_REDIS_CIRCUIT_BREAKER_STORE` (APIGateway)

- **Default**: `false` — every `new CircuitBreaker(...)` uses the in-process memory path (legacy behaviour).
- **When `true`**: callers that invoke `await gateway.initRedisCircuitBreakerStore()` before `registerEndpoint(...)` get a `RedisCircuitBreakerStore` wired into every breaker they register afterwards. Key prefix defaults to `apigw:cb:`.
- **Fallback**: if `getRedisClient()` returns `null` or throws, the gateway logs a warning and stays on the memory path — startup must never block on Redis.

> Note: at the time of this change `APIGateway` is exported as a library facility and is not instantiated from `MetaSheetServer.start`. Integrators (internal services or downstream consumers) that build their own `APIGateway` call `await gateway.initRedisCircuitBreakerStore()` before registering endpoints. When a production startup path materialises here, it should adopt the same sequence; the helper already guarantees graceful degradation.

### `DISABLE_REDIS_CIRCUIT_BREAKER_STORE` (kill switch)

- **Default**: unset.
- **When `true`**: overrides `ENABLE_REDIS_CIRCUIT_BREAKER_STORE` even when Redis is healthy. Designed for emergency rollback without redeploy — flip the env and restart the process.

### `ENABLE_SCHEDULER_LEADER_LOCK` (AutomationScheduler)

- **Default**: `false` — every scheduler instance acts as leader (legacy behaviour). With multiple replicas this produces duplicate timer execution, identical to today.
- **When `true`**: the scheduler attempts to `acquire` a Redis SET-NX-PX lock at `automation-scheduler:leader` with its process-unique `ownerId`. Only the holder registers timers; non-leaders silently skip timer creation for both `schedule.interval` and `schedule.cron` triggers.
- **Fallback**: when `getRedisClient()` returns `null` or the flag is off, `resolveAutomationSchedulerLeaderOptions()` returns `null` and the scheduler is constructed with no leader config, i.e. legacy behaviour.

### `SCHEDULER_LEADER_LOCK_TTL_MS`

- **Default**: `30000` (30 s).
- Purpose: how long the leader's key lives in Redis. Short enough to hand over quickly on crash, long enough that a brief network hiccup doesn't trigger a relinquish.

## Lock TTL and renewal interval

- **TTL**: 30 s default. Rationale — the scheduler's minimum trigger interval is 1 s, so a 30-s TTL gives three full renewal opportunities before expiration.
- **Renewal cadence**: `ttlMs / 3` (10 s at default). Two consecutive missed renewals are required before the TTL runs out, which absorbs one transient Redis failure without losing the lock.
- **Renew on failure**: a `renew` that returns `false` (or throws) triggers `relinquishLeadership('renewal rejected')` — see below.

## Leader-relinquish behaviour on renewal failure

Chosen behaviour: **relinquish**. When a renewal returns `false` or throws:

1. `isLeader` flips to `false` immediately.
2. All active timers are cleared (`clearInterval` + `Map.clear`).
3. The renewal loop itself is stopped.
4. The scheduler does **not** proactively try to re-acquire — it waits for TTL expiry and a fresh `attemptLeadership` on the next process restart (or for a sibling replica to pick up the lock).

Why relinquish over pause:
- Atomicity — no "paused but still counted" state to reconcile.
- Matches the shape of Kubernetes-style leader election primitives (Lease API): losing the lease means losing ownership, period.
- The brief gap (≤ TTL + renewInterval) during which no replica is executing timers is acceptable for automation workloads; next-tick catch-up logic already lives in the consumer layer.

If a pause/retry behaviour is needed later, `attemptLeadership` can be called periodically from outside — the public API is intentionally simple enough to add that without widening surface area.

## Tests added

- 16 tests in `redis-leader-lock.test.ts`: memory twin behaviour, all four RedisLeaderLock entry points, TTL expiry, error swallowing, and a two-process simulation.
- 6 tests in `api-gateway-redis-wiring.test.ts`: flag off, flag on + Redis up, flag on + Redis down, DISABLE override, factory error, circuitBreaker-flag-false endpoints.
- 4 tests in `automation-scheduler-leader.test.ts`: leader-vs-non-leader with shared store, non-leader silent skip for cron + interval, legacy constructor, renewal-failure → relinquish.

## Follow-ups (explicitly out of scope)

- **Webhook scheduler**: the webhook event bridge currently retries from Postgres state, so leader election is not needed there yet, but a similar pattern would apply if we move to a queue worker model.
- **Batch / attendance / other interval jobs**: each needs a dedicated `ownerId` (and probably a dedicated lock key) — rolling them into this PR would have muddled the scope.
- **Observability**: emit Prometheus counters for `apigw_cb_store_used{store="redis|memory"}` and `automation_scheduler_leader{state="leader|follower"}` so a single dashboard can confirm what each replica is doing.
- **Admin UI**: expose circuit state + leader identity in the admin panel so ops can see which replica owns the scheduler without tailing logs.
- **Integration smoke against a real Redis**: `collab-infra-redis-runtime` already has a `REDIS_URL`-gated integration test. A similar one for scheduler leader election would confirm the real ioredis `SET NX PX` + Lua eval paths.
