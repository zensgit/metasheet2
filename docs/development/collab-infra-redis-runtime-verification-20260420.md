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

---

## Rebase verification — 2026-04-21

Branch rebased from base `0756ff61d` onto latest `origin/main@c4093dcb8` (+21 commits upstream, no business-file overlap with this branch). Rebase was pure fast-forward with no merge conflict; business diff unchanged (12 files, +2218 / −4).

Post-rebase HEAD: `4565e44a6`.

### Commands run (2026-04-21, .worktrees/redis)

```bash
git -C .worktrees/redis checkout -- plugins/ tools/   # clean dirty pnpm symlinks
git -C .worktrees/redis fetch origin main
git -C .worktrees/redis rebase origin/main             # no conflicts

pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/redis-token-bucket-store.test.ts \
  tests/unit/redis-circuit-breaker-store.test.ts \
  tests/unit/rate-limiter.test.ts --reporter=dot
```

### Results

| Step | Outcome | Counts |
| ---- | ------- | ------ |
| tsc --noEmit | PASS | zero diagnostics |
| redis-token-bucket-store | PASS | 11/11 |
| redis-circuit-breaker-store | PASS | 14/14 |
| rate-limiter (existing regression) | PASS | 15/15 |
| Total unit | PASS | 40/40 |

### Live-Redis smoke — PASS

```bash
docker run -d --name ms2-redis-smoke-<timestamp> -p 127.0.0.1:6389:6379 redis:7
REDIS_URL=redis://127.0.0.1:6389 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/redis-runtime-stores.integration.test.ts --reporter=dot
docker rm -f ms2-redis-smoke-<timestamp>
```

Result:

```text
Test Files  1 passed (1)
Tests       2 passed (2)
```

This is stronger than the originally proposed smoke command: the original command still executed mocked/fake Redis unit tests. The new integration suite connects to a real Redis 7 container, executes the Lua scripts through Redis `SCRIPT LOAD` / `EVALSHA`, validates TTL-backed state, and verifies `NOSCRIPT` recovery after `SCRIPT FLUSH`.

This PR exposes adapter seams only — APIGateway's internal `new CircuitBreaker(config)` wiring is NOT switched to Redis yet. That is an explicit follow-up.

### Baseline

| Field | Value |
| ----- | ----- |
| Original base commit | `0756ff61d` |
| Rebase target | `c4093dcb8` (origin/main, +21 commits) |
| New branch HEAD | `4565e44a6` |
| Upstream business-file overlap | none |
| Rebase conflicts | none |

---

## Latest-main verification — 2026-04-21

After the DingTalk/Yjs queue landed, this branch was advanced again from `origin/main@c4093dcb8` to `origin/main@81edca7d9`. Rebase used `git rebase --autostash origin/main`, preserved the verification MD changes, and completed with no conflicts.

Post-latest-main HEAD before the live-smoke test/doc addendum: `215d11c72`.

### Commands run (2026-04-21, .worktrees/redis)

```bash
git -C .worktrees/redis rebase --autostash origin/main

pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/redis-token-bucket-store.test.ts \
  tests/unit/redis-circuit-breaker-store.test.ts \
  tests/unit/rate-limiter.test.ts --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/redis-runtime-stores.integration.test.ts --reporter=dot

docker run -d --name ms2-redis-smoke-<timestamp> -p 127.0.0.1:6389:6379 redis:7
REDIS_URL=redis://127.0.0.1:6389 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/redis-runtime-stores.integration.test.ts --reporter=dot
docker rm -f ms2-redis-smoke-<timestamp>
```

### Results

| Step | Outcome | Counts |
| ---- | ------- | ------ |
| Rebase onto `81edca7d9` | PASS | zero conflicts |
| tsc --noEmit | PASS | zero diagnostics |
| redis-token-bucket-store | PASS | 11/11 |
| redis-circuit-breaker-store | PASS | 14/14 |
| rate-limiter (existing regression) | PASS | 15/15 |
| Redis runtime integration without `REDIS_URL` | PASS | 2 skipped |
| Live Redis 7 integration smoke | PASS | 2/2 |

Live Redis smoke validates real Lua execution for both Redis-backed stores, including `SCRIPT FLUSH` / `NOSCRIPT` recovery. This removes the previous "pending manual smoke" caveat.
