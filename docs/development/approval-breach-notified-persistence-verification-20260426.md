# Approval Breach Notification Persistence · Verification

> Pairs with `approval-breach-notified-persistence-design-20260426.md`.

## Commands run

```bash
cd packages/core-backend

# Run both touched test files
pnpm vitest run \
  tests/unit/approval-metrics-service.test.ts \
  tests/unit/approval-breach-notifier.test.ts \
  --reporter=dot

# Type check
pnpm exec tsc --noEmit

# Whitespace
git diff --check
```

## Results

```
✔ approval-metrics-service.test.ts  21 tests pass (was 15; +6 new)
✔ approval-breach-notifier.test.ts  14 tests pass (was 8; +6 new)
✔ tsc --noEmit                      no errors
✔ git diff --check                  clean
```

Total: **35/35** unit tests pass across the two touched test files. **+12 new tests, 0 regressions.**

## New test coverage breakdown

### `tests/unit/approval-metrics-service.test.ts` (+6)

`describe('markBreachNotified', ...)`:

1. **issues a guarded UPDATE that no-ops when breach_notified_at is already set** — verifies the SQL contains `SET breach_notified_at = $1`, `WHERE instance_id = $2`, `AND breach_notified_at IS NULL`, and the params list is `[ISO timestamp, id]`.
2. **skips silently when given an empty or whitespace instance id (defensive)** — empty string and whitespace-only id should not issue a query at all.
3. **defaults `now` to current time when omitted** — calling without explicit `now` uses `new Date()`.

`describe('findUnnotifiedBreaches', ...)`:

4. **returns instance ids ordered by sla_breached_at, capped at default 500** — verifies the WHERE clause filters `sla_breached = TRUE AND breach_notified_at IS NULL`, ORDER BY oldest-first, default LIMIT 500.
5. **clamps the limit to a sane upper bound (5000)** — passing `99_999` produces `LIMIT 5000`.
6. **falls back to default when limit is non-positive or non-finite** — passing `-1` produces `LIMIT 500`.

### `tests/unit/approval-breach-notifier.test.ts` (+6)

`// migration 058 / persistent breach_notified_at`:

1. **persists breach_notified_at via metrics.markBreachNotified after a successful dispatch** — for two instance ids, both result in `markBreachNotified(id, now)` being invoked with the injected fixed `now` Date.
2. **does not persist breach_notified_at when every channel fails** — failing channel returns `{ ok: false }`, `notified` stays 0, `markBreachNotified` is never called.
3. **treats markBreachNotified failures as non-fatal (in-memory dedupe still applies)** — DB UPDATE rejects once, dispatch is still reported `notified: 1`; second call within the same process is correctly skipped via the in-memory Set.

`// notifyMissedBreaches (startup retry path)`:

4. **notifyMissedBreaches replays unnotified breaches from the previous epoch** — `findUnnotifiedBreaches` returns 2 ids, channel.send is invoked twice, `markBreachNotified` is invoked twice.
5. **notifyMissedBreaches is a no-op when no unnotified breaches exist** — `findUnnotifiedBreaches` returns empty, channel.send is never called.
6. **notifyMissedBreaches survives a findUnnotifiedBreaches DB failure** — DB query rejects, method returns an empty result, channel.send is never called, no exception bubbles.

## Existing test regression check

All 8 existing `approval-breach-notifier.test.ts` tests + all 15 existing `approval-metrics-service.test.ts` tests still pass without modification (the only test-file change in service is the addition of `markBreachNotified` and `findUnnotifiedBreaches` mocks to `makeMetrics()`, with the existing tests still receiving an undefined `unnotified` option that defaults to `[]`).

## Manual code review checklist

- [x] Migration 058 uses the next safe number after main's tip 057 (no collision)
- [x] Migration uses `IF NOT EXISTS` for both column add and partial index — safe to re-run
- [x] `markBreachNotified` UPDATE is guarded with `AND breach_notified_at IS NULL` — duplicate calls are no-ops, not timestamp overwrites
- [x] `findUnnotifiedBreaches` LIMIT is clamped (`Math.min(Math.floor(...), 5000)`) — cannot be coerced into an unbounded scan
- [x] `notifier.markNotified` made async; the only call site `await this.markNotified(id)` was updated; no other callers existed in the repo
- [x] `notifier.notifyMissedBreaches` does NOT throw on DB failure — wrapped in try/catch with logging and empty-result return
- [x] `index.ts` startup retry uses `void breachNotifier.notifyMissedBreaches().then(...).catch(...)` — fire-and-forget pattern, scheduler init never awaits it
- [x] No changes to public types or method signatures other than the additions; `notifyBreaches`, `dispatch`, `composeMessage`, `buildLink` all unchanged
- [x] No changes to `breach-channels/*.ts` (channel implementations unaffected)

## Outstanding (not in this PR)

- **Per-channel persistence** — currently we record "at least one channel succeeded" via the boolean `anySent`. If operations needs per-channel ack tracking (e.g. DingTalk delivered but email failed), that requires a separate join table and is out of scope.
- **Re-notification on context update** — if requester / template metadata changes after notification, we don't re-dispatch. Out of scope for the original SLA breach feature.
- **Backfill of pre-existing breached rows** — intentionally not done. First post-deploy leader startup will trigger a one-time replay burst capped at 5000; expected and documented.
- **Pagination beyond 5000** — caller can re-invoke `notifyMissedBreaches()` in a loop if the backlog exceeds the cap. Not exposed via REST today.

## Cross-references

- PR #1171 (the predecessor): merged 2026-04-25 as commit `58862b394`. Code comment at `ApprovalBreachNotifier.ts` lines 17-24 explicitly named this follow-up.
- Migration sequence: most recent on `origin/main` was `057_create_integration_core_tables.sql` (#1140); this PR claims `058_*`.
