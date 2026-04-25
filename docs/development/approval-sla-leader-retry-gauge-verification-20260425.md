# Approval SLA Leader Retry and Gauge Verification - 2026-04-25

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-sla-scheduler.test.ts tests/unit/redis-leader-lock.test.ts --reporter=verbose
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

## Results

- `approval-sla-scheduler.test.ts` + `redis-leader-lock.test.ts`: 23/23 passed.
- Backend TypeScript check: passed with exit code 0.

## Covered Scenarios

- Existing SLA tick behavior and error swallowing still pass.
- Only the leader scans; followers skip work.
- `stop()` releases the leader lock.
- A follower retries acquisition and takes over after the leader stops.
- Injected gauge transitions through `leader`, `follower`, and `relinquished` states.
- Existing Redis leader-lock owner/renew/release semantics remain covered.

## Not Run

- Live Redis smoke. The scheduler integration is covered with `MemoryLeaderLockClient`; live Redis can be added as an ops smoke when the flag is enabled in staging.
- Full backend suite. The focused scheduler/leader tests plus typecheck were used as the local gate.
