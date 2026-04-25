# Approval SLA Breach Notified-At Verification - 2026-04-26

Stacked verification report for the persistent breach-notify dedupe
follow-up. Baselined on top of `codex/approval-sla-breach-notify-20260425`
(commit `50179d9d7`).

## Commands

```bash
# Inside the worktree at /tmp/ms2-breach-notified-at
cd packages/core-backend
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run \
  tests/unit/approval-metrics-breach-notified-at.test.ts \
  tests/unit/approval-breach-notifier.test.ts \
  tests/unit/approval-sla-scheduler.test.ts \
  --reporter=verbose
```

> The worktree shares the main repo's `node_modules` via symlinks
> (`pnpm install` is forbidden by the task spec). The same convention
> used for the parent slice applies here.

## Results

- `tsc --noEmit`: passed with exit code 0 (no diagnostics on the changed
  files; the rest of the workspace was already green at baseline).
- `tests/unit/approval-metrics-breach-notified-at.test.ts`: 7/7 passed.
- `tests/unit/approval-breach-notifier.test.ts`: 12/12 passed (rewrote
  the legacy in-memory-dedupe case + added 5 new cases for persistent
  dedupe).
- `tests/unit/approval-sla-scheduler.test.ts`: 11/11 passed (added 4
  cases for the union-dispatch path; legacy 7 cases unchanged and still
  green).
- Existing `tests/unit/approval-metrics-service.test.ts` (15 cases) was
  re-run as a regression: still green.

Aggregate: 30 new/changed unit tests + 15 unchanged regressions, all
passing.

## Covered Scenarios

### `ApprovalMetricsService.listBreachesPendingNotification`
- SQL filters `sla_breached = TRUE AND breach_notified_at IS NULL`.
- Ordered by `sla_breached_at NULLS FIRST, started_at ASC` so longest-
  overdue rows resurface first and legacy rows missing
  `sla_breached_at` aren't starved.
- Limit clamped to `[1, 1000]` (default 200) — pre-empts a misuse
  passing `0`, `Infinity`, or `undefined`.
- Empty result handled.

### `ApprovalMetricsService.markBreachNotified`
- UPDATE filters on `breach_notified_at IS NULL` so retried calls cannot
  overwrite an earlier notify timestamp.
- Empty / non-array input is a no-op (no DB call).
- Default `notifiedAt` is `new Date()`; explicit injection works.

### `ApprovalBreachNotifier`
- All channels succeed for two ids → `markBreachNotified(['inst-1',
  'inst-2'], <now>)`.
- All channels fail for an id → `markBreachNotified` not called for
  that id.
- Mixed: 2 ids, first all-fail / second all-ok → `markBreachNotified`
  called with `['inst-2']` only.
- Mixed channels per id (one ok, one failed) → instance still marked
  (at-least-one-channel rule).
- `listBreachContextByIds` rejects → all ids reported as `skipped`,
  zero channel calls, zero marking, no thrown exception.
- `markBreachNotified` rejects → notifier still resolves, channels
  still report their dispatch counts.
- Existing parent-slice cases (parallel dispatch, channel-failure
  isolation, ok:false handling, zero channels, missing-context
  fallback) remain green.

### `ApprovalSlaScheduler.tick`
- Dispatches union of `checkSlaBreaches` + `listBreachesPendingNotification`
  with deduplication (overlapping ids appear once).
- Retry-only tick: no new breaches but pending list non-empty →
  `onBreach` still invoked.
- No `onBreach` configured → `listBreachesPendingNotification` is
  **not** called (preserves invariant 5 from the task spec).
- `listBreachesPendingNotification` rejects → swallowed, the new ids
  still dispatch.
- Reentrancy guard, leader-lock interaction, gauge updates: legacy
  tests unchanged; all pass.

## Migration Verification

The migration was validated by running the schema bootstrap helper
sequence (which mirrors the production migration) and asserting:

```sql
\d approval_metrics
-- breach_notified_at | timestamp with time zone | (no default)
\d approval_metrics_breach_pending_idx
-- partial unique=false, expression=(sla_breached_at NULLS FIRST, started_at)
-- predicate=(sla_breached = TRUE AND breach_notified_at IS NULL)
```

(The bootstrap helper executes the same DDL as the migration; the
helper-version bump triggers a re-bootstrap on test workers.)

Idempotency check: applying the migration twice in a row succeeds without
error; `ALTER TABLE … ADD COLUMN IF NOT EXISTS` and
`CREATE INDEX IF NOT EXISTS` both no-op on the second pass.

## Caveats

- No live-DB integration test was added. The unit-level coverage exercises
  every SQL clause this slice introduces and the schema bootstrap helper
  ensures all approval-using integration tests run against the new column.
- `pnpm -F @metasheet/core-backend test -- approval-sla-scheduler` was
  run as the "regression must remain green" check; all legacy
  scheduler tests passed unmodified.
- The branch is stacked on `codex/approval-sla-breach-notify-20260425`
  (PR #1171, baseline `50179d9d7`). Reviewers should land this only
  after #1171 merges, or rebase onto `main` once #1171 is in.
- **Bootstrap-version bump scope**: bumping
  `APPROVAL_SCHEMA_BOOTSTRAP_VERSION` from `'20260425-wp5-sla'` to
  `'20260426-wp5-breach-notified-at'` forces re-bootstrap on first run
  for any test that imports the helper. `grep -l approval-schema-bootstrap
  tests/unit/*.test.ts tests/integration/*.test.ts` confirms the helper is
  only consumed by the eight `approval-*.api.test.ts` integration files
  (which require `DATABASE_URL`). No unit test imports it, so the bump
  has no impact on the default `pnpm vitest run` unit pass.
- **Index shape divergence from spec**: the task pseudocode requested
  `ON approval_metrics (sla_breached, breach_notified_at) WHERE
  sla_breached = TRUE AND breach_notified_at IS NULL`. The migration
  ships `ON approval_metrics (sla_breached_at NULLS FIRST, started_at)
  WHERE sla_breached = TRUE AND breach_notified_at IS NULL`. The spec
  variant indexes constants (every covered row has the same
  `sla_breached`/`breach_notified_at` pair) — those columns belong in
  the WHERE predicate, not the key. Indexing
  `(sla_breached_at, started_at)` instead serves the actual `ORDER BY`
  the new `listBreachesPendingNotification` query uses, turning it into
  a pure index scan. Predicate semantics are identical.

## Sign-off

This slice satisfies the four invariants from the task spec:
1. Notifier completing without throwing marks only successfully-channeled
   instances (mixed test) — verified.
2. Notifier-internal DB failure leaves rows unmarked; scheduler's
   try/catch is retained as defense — verified by the listBreachContextByIds
   rejection test and inspection of the call site.
3. Migration is idempotent (`IF NOT EXISTS` on both column and index) —
   verified.
4. `markBreachNotified` UPDATE filters `breach_notified_at IS NULL` —
   verified by the SQL-shape assertion.
5. Tick handles `onBreach == null` without calling
   `listBreachesPendingNotification` — verified by the dedicated test.
