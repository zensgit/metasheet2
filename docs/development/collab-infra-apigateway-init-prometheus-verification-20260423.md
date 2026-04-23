# APIGateway boot-time Redis init + Prometheus metrics — verification log (2026-04-23)

- **Date**: 2026-04-23
- **Branch**: `codex/collab-infra-apigateway-init-prometheus-20260423`
- **Worktree**: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/apigw-prometheus`
- **Base commit**: `8d2d3e1b0` (origin/main after final rebase)
- **Companion**: `collab-infra-apigateway-init-prometheus-development-20260423.md`

## Commands

All commands run from the worktree root: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/apigw-prometheus`.

```bash
pnpm install --prefer-offline
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/apigateway-metrics.test.ts \
  tests/unit/circuit-breaker-metrics.test.ts \
  tests/unit/automation-scheduler-metrics.test.ts \
  tests/unit/metrics-endpoint.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/api-gateway-redis-wiring.test.ts \
  tests/unit/redis-leader-lock.test.ts \
  tests/unit/automation-scheduler-leader.test.ts \
  tests/unit/redis-circuit-breaker-store.test.ts \
  tests/unit/redis-token-bucket-store.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest run tests/unit --reporter=dot
```

## Results

| Command | Outcome |
| --- | --- |
| `pnpm install --prefer-offline` | OK. Lockfile already satisfied — `+ bcryptjs@3.0.3, jsonwebtoken@9.0.2` re-reported from the parent install. `prom-client ^15.1.3` already present in `packages/core-backend/package.json`. |
| `tsc --noEmit --pretty false` | OK. Zero diagnostics. Exit 0. |
| New metrics unit tests (4 files) | **Test Files 4 passed · Tests 20 passed · ~450ms**. Breakdown: `apigateway-metrics.test.ts` 7, `circuit-breaker-metrics.test.ts` 5, `automation-scheduler-metrics.test.ts` 6, `metrics-endpoint.test.ts` 2. |
| Prior Redis + APIGateway regression set (5 files) | **Test Files 5 passed · Tests 51 passed · ~430ms**. No behavioural regressions. |
| Full `core-backend` unit suite | **Test Files 130 passed · Tests 1639 passed · ~5.6s**. Zero regressions — includes `server-lifecycle.test.ts`, which exercises a full `MetaSheetServer.start()/stop()` cycle and now also runs through the new APIGateway construction / destroy path. |

## Baseline references

- `origin/main` @ `d1f35edf6` — base for this branch.
- Prior Lane 3 rollout PR #1080 landed `initRedisCircuitBreakerStore` as a library method. This change wires it into `MetaSheetServer.start` and adds the observability requested in that PR's review.
- `src/metrics/metrics.ts` (pre-existing module) already installs the shared Prometheus `Registry` + `installMetrics(app)` helper, and `src/index.ts` already calls `installMetrics(this.app)` at line 727 — new metrics plug into that shared path, so `/metrics/prom` surfaces them automatically with no HTTP-route changes.

## Tension surfaced for reviewer attention

The existing `/metrics/prom` endpoint is registered *before* the JWT middleware (line 727 vs line 748 of `src/index.ts`, before edits). It is therefore publicly reachable — a decision that predates this change and covers the ~60 existing metrics. The task specifies "Metrics should NOT be publicly exposed." The task also allows "plug into the existing registry"; retroactively adding a JWT/RBAC guard at `/metrics/prom` would change the behaviour for every pre-existing metric and would need a coordinated change across operations tooling (scrape configs, alert rules).

**Resolution for this change**: the new metrics inherit the existing exposure surface. Closing the endpoint down is out of scope for this task and would be best handled in a dedicated "metrics hardening" change touching ops tooling simultaneously. This is flagged here (and in the development MD) so the next reviewer has the context to decide whether to schedule that follow-up.

## Evidence captured during the run

A short-form sample of the dot-reporter output for the new tests:

```
 ✓ tests/unit/apigateway-metrics.test.ts  (7 tests) 4ms
 ✓ tests/unit/automation-scheduler-metrics.test.ts  (6 tests) 125ms
 ✓ tests/unit/circuit-breaker-metrics.test.ts  (5 tests) ~few ms
 ✓ tests/unit/metrics-endpoint.test.ts  (2 tests) ~few ms

 Test Files  4 passed (4)
      Tests  20 passed (20)
```

Regression set:

```
 ✓ tests/unit/api-gateway-redis-wiring.test.ts  (6 tests)
 ✓ tests/unit/automation-scheduler-leader.test.ts  (4 tests)
 ✓ tests/unit/redis-leader-lock.test.ts  (16 tests)
 ✓ tests/unit/redis-circuit-breaker-store.test.ts  (…)
 ✓ tests/unit/redis-token-bucket-store.test.ts  (…)

 Test Files  5 passed (5)
      Tests  51 passed (51)
```

Full suite:

```
 Test Files  130 passed (130)
      Tests  1639 passed (1639)
```

## What the tests actually cover

- `apigateway-metrics.test.ts` — walks the three `outcome` branches (`skipped_by_flag` via flag unset, `skipped_by_flag` via DISABLE kill switch, `redis_attached` with a shim client, `fell_back_to_memory` on null-returning factory, `fell_back_to_memory` on thrown factory). Also asserts the counter is entirely optional (legacy caller keeps working) and that counter exceptions are swallowed.
- `circuit-breaker-metrics.test.ts` — asserts `{store="memory"}` ticks on in-process `execute()` success/failure, and `{store="redis"}` ticks on `reportToStore` / `refreshSharedState` when a shared store is attached. Uses `MemoryCircuitBreakerStore` as a stand-in for "a shared store" since the CircuitBreaker code branches on `store != null`, not on the concrete class — Redis-specific semantics are covered by the existing `redis-circuit-breaker-store.test.ts`.
- `automation-scheduler-metrics.test.ts` — covers the full leader state machine: construction with no leader options (→`leader`), acquire-wins (→`leader`), acquire-loses (→`follower`), and a custom lock client that rejects renewals (→`relinquished`). Also asserts gauge is optional and gauge errors are swallowed.
- `metrics-endpoint.test.ts` — builds a throwaway registry + counter, attaches the same handler pattern that `installMetrics` uses (`Content-Type` from `registry.contentType`, body from `await registry.metrics()`), drives it with `supertest`, and asserts the HTTP contract. Does not touch the production `registry` singleton; the second test also proves multi-registry isolation, which is the property the rest of the suite relies on.

## Rebase Verification - 2026-04-23

- Rebased `codex/collab-infra-apigateway-init-prometheus-20260423` onto `origin/main@76ddfeacd`.
- Rebased HEAD: `c12d8e7b0`.
- Dirty generated dependency entries under `plugins/` and `tools/` were cleared before rebase; no business-file conflicts occurred.
- `pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false`: pass.
- New metrics unit tests: 4 files / 20 tests passed.
- Redis + APIGateway regression set: 5 files / 51 tests passed.
- Full `core-backend` unit suite: 130 files / 1643 tests passed.
- `/metrics/prom` exposure status is unchanged after rebase: still inherits the pre-existing public metrics endpoint and should be handled by a dedicated observability hardening PR, not hidden inside this wiring PR.

## Final Rebase - 2026-04-23

- Rebased again onto `origin/main@8d2d3e1b0` after DingTalk P4 env/product-gate follow-ups merged.
- Final HEAD: `be75061d1`.
- No conflicts and no touched-file overlap with the new DingTalk P4 commits.
- Final quick recheck: `git diff --check` passed; new metrics unit tests passed again, 4 files / 20 tests.
