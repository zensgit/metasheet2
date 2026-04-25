# Approval SLA Leader Lock Verification - 2026-04-25

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-sla-scheduler.test.ts tests/unit/redis-leader-lock.test.ts --reporter=verbose
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

## Results

- `tests/unit/approval-sla-scheduler.test.ts` + `tests/unit/redis-leader-lock.test.ts`: 21/21 passed.
- Backend TypeScript check: passed with exit code 0.

## Covered Scenarios

- Legacy scheduler behavior still works without leader options.
- A leader can scan and produce SLA breach work.
- A follower skips scans and does not call the metrics service.
- `stop()` releases the lock so a replacement scheduler can acquire leadership.
- Existing `RedisLeaderLock` behavior remains covered by its focused unit tests.

## Not Run

- Live Redis integration. The slice reuses the existing Redis leader-lock adapter and validates scheduler integration with the in-memory lock client.
- Multi-process runtime smoke. The unit tests cover the critical election and release semantics without starting multiple Node processes.
