# Redis runtime adapters for TokenBucket and CircuitBreaker — development log

- **Date**: 2026-04-20
- **Branch**: `codex/collab-infra-redis-runtime-202605`
- **Worktree**: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/redis`
- **Base commit**: `0756ff61d` (`fix(collab): YjsRecordBridge re-registers observer when Y.Doc is recreated (P1)`)

## Scope

Add Redis-backed storage adapters for two pieces of gateway runtime state so multi-replica deployments can share it:

1. **TokenBucketRateLimiter** — per-key bucket balance.
2. **CircuitBreaker** — per-circuit state + rolling event window.

The work is strictly additive: every existing caller continues to run against the in-process defaults with no code changes. Callers that need cluster-wide coordination opt in by constructing the limiter / breaker with a `store` parameter.

Webhook deliveries are already Postgres-persisted (`multitable_webhook_deliveries`) so no Redis work was needed there. `AutomationScheduler` was deferred — it needs a richer leader-election story plus queue semantics, which justify a separate slice rather than bolting onto the current in-memory scheduler.

## Rationale

- **Multi-replica correctness.** The existing Map/field storage is per-process, so three API-gateway pods would each maintain their own rate-limit counter and their own CircuitBreaker state. Under load this amplifies allowed traffic by `Npods` and desynchronises circuit trips.
- **Graceful degradation.** Following the `packages/core-backend/src/middleware/rate-limiter.ts` precedent, Redis is opt-in and failures must not take the service down. The new interfaces are unreachable from default paths; a caller wanting Redis wires it explicitly and is expected to wrap store calls in its own fallback logic (mirror of `createRateLimiter`'s pattern).

## Files added

| Path | Purpose |
| --- | --- |
| `packages/core-backend/src/integration/rate-limiting/token-bucket-store.ts` | `TokenBucketStore` interface + `MemoryTokenBucketStore` default. |
| `packages/core-backend/src/integration/rate-limiting/redis-token-bucket-store.ts` | Lua-backed Redis implementation + pure-JS twin for tests. |
| `packages/core-backend/src/gateway/circuit-breaker-store.ts` | `CircuitBreakerStore` + `CircuitBreakerThresholds` + `MemoryCircuitBreakerStore`. |
| `packages/core-backend/src/gateway/redis-circuit-breaker-store.ts` | Four Lua scripts (success/failure/check/transition) + JS twins. |
| `packages/core-backend/tests/unit/redis-token-bucket-store.test.ts` | 11 unit tests (pure-JS transitions, dispatch path, NOSCRIPT recovery). |
| `packages/core-backend/tests/unit/redis-circuit-breaker-store.test.ts` | 13 unit tests (state-machine twins, memory store cycle, Redis dispatch). |

## Files modified (additive only)

- `packages/core-backend/src/integration/rate-limiting/token-bucket.ts`:
  - Accepts optional `store?: TokenBucketStore` as a second constructor argument.
  - Adds `consumeAsync(key, tokens)` which delegates to the store when one is attached. The original sync `consume()` is untouched.
- `packages/core-backend/src/gateway/CircuitBreaker.ts`:
  - Accepts optional `CircuitBreakerRuntimeOptions` (`{ store?, id? }`) as a second constructor argument. Default callers (`new CircuitBreaker(config)` and every `createXxxCircuitBreaker()` factory) continue to work unchanged.
  - Adds `refreshSharedState()` and `reportToStore(success)` hooks for callers who wish to synchronize with a shared store before/after `execute`.
- `packages/core-backend/src/integration/rate-limiting/index.ts` and `packages/core-backend/src/gateway/index.ts`:
  - Re-export the new types / Lua sources / JS twins.

## Interface definitions

### `TokenBucketStore`

```ts
export interface ConsumeResult {
  allowed: boolean
  tokensRemaining: number
  retryAfterMs: number
}

export interface TokenBucketStore {
  consume(
    key: string,
    capacity: number,
    refillRate: number,
    tokens: number,
  ): Promise<ConsumeResult>
}
```

### `CircuitBreakerStore`

```ts
export interface CircuitBreakerThresholds {
  errorThreshold: number
  volumeThreshold: number
  windowSizeMs: number
  resetTimeoutMs: number
}

export interface CircuitBreakerSnapshot {
  state: CircuitState
  windowRequests: number
  windowFailures: number
  lastTransitionAt: number
  nextAttemptAt: number
}

export interface CircuitBreakerStore {
  getSnapshot(id): Promise<CircuitBreakerSnapshot>
  recordSuccess(id, thresholds): Promise<CircuitBreakerSnapshot>
  recordFailure(id, thresholds): Promise<CircuitBreakerSnapshot>
  transitionTo(id, newState, thresholds): Promise<CircuitBreakerSnapshot>
  checkAndUpdate(id, thresholds): Promise<CircuitBreakerSnapshot>
}
```

The store is intentionally *smart*: record-methods take the breaker's thresholds and atomically perform `record + maybe-transition` so replicas cannot disagree about when to open/close a circuit. The alternative (dumb storage with business logic outside Redis) reintroduces the cross-replica race we are trying to eliminate.

## Lua script excerpts

### Token bucket (`TOKEN_BUCKET_LUA`)

```lua
local data = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens = tonumber(data[1])
local lastRefill = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  lastRefill = nowMs
end

local elapsed = nowMs - lastRefill
if elapsed < 0 then elapsed = 0 end
local refill = (elapsed / 1000.0) * refillRate
if refill > 0 then
  tokens = math.min(capacity, tokens + refill)
  lastRefill = nowMs
end

local allowed = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', lastRefill)
redis.call('EXPIRE', key, ttlSeconds)

-- returns { allowed, tostring(tokens), tostring(retryAfterMs) }
```

### Circuit breaker — record-failure decision (`CIRCUIT_RECORD_FAILURE_LUA`, condensed)

```lua
if state == 'HALF_OPEN' then
  state = 'OPEN'; lastAt = nowMs; nextAt = nowMs + resetTimeoutMs
elseif state == 'CLOSED' then
  local total, failures = #kept, count_failures(kept)
  local rate = (failures / total) * 100
  if total >= volume and rate >= errorThreshold then
    state = 'OPEN'; lastAt = nowMs; nextAt = nowMs + resetTimeoutMs
  end
end
```

The four scripts (`SUCCESS`, `FAILURE`, `CHECK_AND_UPDATE`, `TRANSITION`) all share a small header that loads and saves the hash layout, so behavior stays consistent.

## Testing strategy

Unit tests exercise **pure-JS twins** (`applyTokenBucketScript`, `applyRecordFailureScript`, etc.) that mirror the Lua transformations one-for-one. The advantage:

1. No Redis server needed in CI.
2. No Lua interpreter shim to maintain.
3. The same JS function is used by the mock-Redis shim in the dispatch tests, so `evalsha` / `eval` / `NOSCRIPT` recovery is covered against realistic script output.

The `MemoryCircuitBreakerStore` also serves as an executable specification of the expected Redis behavior: the full `CLOSED → OPEN → HALF_OPEN → CLOSED` cycle is asserted there, and the Redis-backed test runs the same set of assertions through the shim, verifying the Lua twins produce identical results.

### Live Redis smoke addendum — 2026-04-21

Reviewer feedback correctly pointed out that the unit tests prove the JS twin and mocked dispatch semantics, but not a real Redis server's Lua execution path. This branch now includes `packages/core-backend/tests/integration/redis-runtime-stores.integration.test.ts`.

Design of the live smoke:

- The suite is gated by `REDIS_URL`; without a real Redis URL it is skipped, so normal CI remains infrastructure-neutral.
- The token bucket case runs real Redis `SCRIPT LOAD` + `EVALSHA`, validates burst exhaustion and TTL, then runs `SCRIPT FLUSH` and verifies `NOSCRIPT` recovery through the same store instance.
- The circuit breaker case runs real Redis Lua through `RedisCircuitBreakerStore`, drives `CLOSED -> OPEN`, validates persisted window counters and TTL, then runs `SCRIPT FLUSH` and verifies `NOSCRIPT` recovery via `checkAndUpdate`.
- The test uses a unique key prefix per case and deletes matching keys after each run, avoiding `FLUSHDB` against a shared Redis.

## Why `CircuitBreaker` + `TokenBucket` and not `AutomationScheduler`?

- Both TB and CB are **stateless** between requests (the only "state" is the counter/window itself) and **hot-path**: they are consulted on every gateway request. Moving them to Redis immediately benefits any horizontally-scaled deployment.
- `AutomationScheduler` has durable-queue semantics, leader election, retry/back-off and idempotency requirements that deserve a separate design (BullMQ or similar) rather than a thin store adapter. Rolling it into this slice would have balloon the surface area and muddled the review.

## Follow-ups (explicitly out of scope)

- Wire Redis store selection into `APIGateway`'s internal `CircuitBreaker` map (currently constructs `new CircuitBreaker(config)` without the runtime options).
- Admin UI to inspect global circuit state across replicas.
- Automation queue migration (separate ticket).
