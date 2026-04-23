# APIGateway boot-time Redis init + Prometheus metrics — development log (2026-04-23)

- **Date**: 2026-04-23
- **Branch**: `codex/collab-infra-apigateway-init-prometheus-20260423`
- **Worktree**: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/apigw-prometheus`
- **Base commit**: `d1f35edf6` (origin/main)

## Scope

Closes two follow-ups from the 2026-04-22 Lane 3 parallel delivery:

1. **Boot-time wiring** — `APIGateway.initRedisCircuitBreakerStore()` landed in PR #1080 as a library helper that no production code path calls. `MetaSheetServer.start` now constructs the gateway and `await`s `initRedisCircuitBreakerStore()` during the normal startup sequence, so the flag-gated Redis path actually runs in production.
2. **Prometheus observability** — three new metrics cover the Redis-store opt-in, the per-breaker store usage, and the scheduler leader state, all wired through **dependency injection** so `CircuitBreaker`, `AutomationScheduler`, and `APIGateway` stay unit-testable without pulling `prom-client` into their module graphs.

This is additive: no public API on `CircuitBreaker`, `AutomationScheduler`, or `APIGateway` changed; every new option is optional with a safe default. Legacy callers (including every unit test that survives unchanged) keep working.

## Files added

| Path | Purpose |
| --- | --- |
| `packages/core-backend/tests/unit/apigateway-metrics.test.ts` | 7 tests. Drives `initRedisCircuitBreakerStore()` through each flag + reachability branch and asserts the injected counter is incremented with the matching `outcome` label. |
| `packages/core-backend/tests/unit/circuit-breaker-metrics.test.ts` | 5 tests. Uses a hand-rolled counter double to verify `apigw_cb_store_used_total{store="memory"}` ticks during `execute()` and `{store="redis"}` ticks during `reportToStore` / `refreshSharedState` when a shared store is attached. |
| `packages/core-backend/tests/unit/automation-scheduler-metrics.test.ts` | 6 tests. Exercises leader transitions (legacy-always-leader boot, acquire-wins, acquire-loses, renewal-failure relinquish) and asserts the gauge reports the matching state=1 / others=0. |
| `packages/core-backend/tests/unit/metrics-endpoint.test.ts` | 2 tests. Builds a throwaway `new Registry()` + `new Counter({ registers: [...] })` and asserts the `/metrics` route handler returns 200, `text/plain; version=0.0.4`, and the metric name/values in the body. Does **not** import the production `metrics.ts` module — that module has startup side-effects (`collectDefaultMetrics` + ~60 metric registrations) and a singleton registry we don't want polluted by unit runs. |

## Files modified

| Path | Change |
| --- | --- |
| `packages/core-backend/src/metrics/metrics.ts` | Adds `apigw_cb_store_used_total{store}`, `apigw_cb_init_total{outcome}`, and `automation_scheduler_leader{state}` to the shared `registry` and the exported `metrics` object. Registered alongside the existing ~60 metrics so the existing `/metrics/prom` endpoint (already mounted at line 727 via `installMetrics(this.app)`) exposes them automatically — **no new HTTP endpoint**. |
| `packages/core-backend/src/gateway/CircuitBreaker.ts` | New optional `storeUsedCounter` field on `CircuitBreakerRuntimeOptions`. A private `noteStoreUsage()` helper tags the `store` label with `'redis'` or `'memory'` based on whether a shared store is attached, and is called from `recordSuccess`, `recordFailure`, `refreshSharedState`, and `reportToStore`. Counter errors are `try/catch`-swallowed. No prom-client import. |
| `packages/core-backend/src/gateway/APIGateway.ts` | Two new optional fields on `GatewayConfig`: `initOutcomeCounter` and `circuitBreakerStoreUsedCounter`. `initRedisCircuitBreakerStore` calls `recordInitOutcome('skipped_by_flag' | 'fell_back_to_memory' | 'redis_attached')` on exactly one branch per invocation. `registerEndpoint` forwards the breaker counter to every `new CircuitBreaker(...)`. `config` type tightened to `Required<Omit<GatewayConfig, 'initOutcomeCounter' \| 'circuitBreakerStoreUsedCounter'>>` so the required-defaults table doesn't try to give these non-trivial defaults. |
| `packages/core-backend/src/multitable/automation-scheduler.ts` | New `AutomationSchedulerLeaderGauge` interface + `AutomationSchedulerRuntimeOptions` (`{ leaderStateGauge? }`) third constructor arg. `setLeaderGauge(state)` sets the target label to 1 and the other two to 0, called on construction, on `attemptLeadership` win/lose, and on `relinquishLeadership`. Gauge errors swallowed. No prom-client import. |
| `packages/core-backend/src/multitable/automation-service.ts` | Constructor gains a sixth optional arg `schedulerRuntime: AutomationSchedulerRuntimeOptions` that is forwarded to the `new AutomationScheduler(...)` call. Every existing caller omits it and retains legacy behaviour. |
| `packages/core-backend/src/index.ts` | 1) New `import { APIGateway } from './gateway/APIGateway'` + new `import { metrics as promMetrics, installMetrics, requestMetricsMiddleware }` (metrics was already imported, now the metrics object is too). 2) New `private apiGateway?: APIGateway` field. 3) In `start()`, after EventBus init and before AutomationService, constructs the gateway with `initOutcomeCounter: promMetrics.apigwCbInitTotal` + `circuitBreakerStoreUsedCounter: promMetrics.apigwCbStoreUsedTotal` and awaits `initRedisCircuitBreakerStore()`. 4) `AutomationService` now receives `{ leaderStateGauge: promMetrics.automationSchedulerLeaderGauge }` so scheduler transitions are observable. 5) `stop()` now uncommented: `this.apiGateway?.destroy()` is added to the shutdown task list. |

## New metrics

| Name | Kind | Labels | When incremented |
| --- | --- | --- | --- |
| `apigw_cb_init_total` | Counter | `outcome ∈ {redis_attached, fell_back_to_memory, skipped_by_flag}` | Once per `APIGateway.initRedisCircuitBreakerStore()` call. `skipped_by_flag` when `ENABLE_REDIS_CIRCUIT_BREAKER_STORE !== 'true'` or `DISABLE_REDIS_CIRCUIT_BREAKER_STORE === 'true'`; `redis_attached` when a Redis client is returned; `fell_back_to_memory` when the factory returns `null` or throws. |
| `apigw_cb_store_used_total` | Counter | `store ∈ {redis, memory}` | Every breaker op that touches a store — in-process `recordSuccess`/`recordFailure` (via `execute()`) tag `memory`; cluster-wide `reportToStore`/`refreshSharedState` tag `redis`. Operators get a live signal for how much traffic is flowing through the Redis path vs the memory fallback. |
| `automation_scheduler_leader` | Gauge | `state ∈ {leader, follower, relinquished}` | Reset on every leader transition: the current state gets `1`, the other two get `0`. `leader` when `acquire` wins or the scheduler is constructed in legacy-mode (no leader options); `follower` when `acquire` loses, or on the brief window before the first election resolves; `relinquished` when a renewal fails. |

## Design decisions

### DI over a global-registry import (applied uniformly)

The task explicitly requires `CircuitBreaker` and `AutomationScheduler` to stay free of `prom-client` imports so unit tests don't need a live registry. I extended the same discipline to `APIGateway`: the gateway file defines its own minimal `APIGatewayInitOutcomeCounter` interface and takes the counter through `GatewayConfig`. No prom-client types leak into `packages/core-backend/src/gateway/*.ts` or `packages/core-backend/src/multitable/automation-scheduler.ts`. The only file that actually imports `prom-client` is `src/metrics/metrics.ts` (as was already the case).

The wiring site — `MetaSheetServer.start` — resolves the concrete prom-client counters via the existing `metrics` export and hands them to the components' constructors. Unit tests hand-roll a counter double (a plain object with `labels(...).inc()`) so no prom-client mock is required.

### Single shared registry vs a new guarded `/metrics` endpoint

The task allows either plugging into the existing registry OR adding a new guarded endpoint. `src/metrics/metrics.ts` already exposes `registry`, a global `installMetrics(app)` helper, and a `/metrics/prom` route registered at line 727 of `src/index.ts`. The three new metrics are registered on that same registry so operators query one endpoint.

**Tension to call out**: the existing `/metrics/prom` is unguarded (registered before JWT middleware in the chain). Adding a guard retroactively is out of scope and would change behaviour for the existing ~60 metrics; the new metrics inherit the same exposure surface. If the ops team wants the metrics endpoint locked down, that's a separate change across every metric — a parallel guarded endpoint would split the observability surface and confuse Prometheus scrape config. I surfaced this in the verification MD alongside the test evidence so it's an informed tradeoff, not a silent one.

### APIGateway wiring site

At the start of this work the `start()` method had no `this.apiGateway` construction — only a commented-out `this.apiGateway.destroy()` in `stop()` (lines 1585–1593 of `src/index.ts`, before edits). The gateway instance is now constructed **after** `EventBusService` init and **before** `AutomationService`, matching how other subsystem wiring is sequenced. The gateway is configured with `enableCors: false`, `enableLogging: false`, `enableMetrics: false` because those concerns are already owned by the parent `MetaSheetServer` middleware chain — we don't want double-registration. `enableCircuitBreaker: true` stays on so the gateway's contract about registering breakers on opt-in endpoints still holds if future code paths call `registerEndpoint`.

The gateway is currently passive: no code in the running server registers endpoints on it. That's intentional for this change — the scope is strictly "run the boot-time init + expose metrics", not "migrate routes to the gateway". Future callers can look up `this.apiGateway` and attach endpoints without any further wiring.

### Not-touched APIs

- `AutomationScheduler` constructor: the new third argument is **opt-in with a default**, so every existing call (test fixtures, legacy prod caller) keeps its exact signature.
- `AutomationService` constructor: same — sixth argument is `AutomationSchedulerRuntimeOptions = {}`.
- `APIGateway` constructor: `GatewayConfig` is a plain `Partial`-like interface with optional fields; adding two more optional fields does not break any existing caller.
- `CircuitBreaker` constructor: new field lives on `CircuitBreakerRuntimeOptions` (the existing second arg), still defaulted to `{}`.

All 51 pre-existing tests in the verification set (and 1639 across the full unit suite) remain green.

## Feature flags

No new flags. The three counters respect the existing `ENABLE_REDIS_CIRCUIT_BREAKER_STORE` / `DISABLE_REDIS_CIRCUIT_BREAKER_STORE` / `ENABLE_SCHEDULER_LEADER_LOCK` flags via the components they instrument, so operators enable/disable the Redis paths exactly as before and the metrics reflect whatever path is taken.
