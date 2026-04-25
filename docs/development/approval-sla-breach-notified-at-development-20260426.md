# Approval SLA Breach Notified-At Development - 2026-04-26

Stacked follow-up on the breach-notify slice (PR #1171, merged onto branch
`codex/approval-sla-breach-notify-20260425`). Elevates notifier semantics
from **best-effort once** to **at-least-once** by persisting per-instance
notify dedupe in the database.

## Context

The merged breach-notify slice deferred persistent dedupe to a follow-up
(see the parent dev MD `approval-sla-breach-notify-development-20260425.md`,
"Idempotency" section, lines 96-130, and "Follow-ups", lines 218-220).
The known limitation: when every configured channel fails to dispatch, the
breach is never re-notified because `ApprovalMetricsService.checkSlaBreaches`
flips `sla_breached = FALSE → TRUE` inside the same `UPDATE … RETURNING`,
so a row that was missed once never re-enters the notifier pipeline.
The in-memory `Set<instanceId>` dedupe also resets on every leader
restart / takeover.

This slice closes the loop by decoupling "marked as breached" from
"successfully notified", using a new `breach_notified_at` column.

## Summary of Changes

- Migration `zzzz20260426100000_add_breach_notified_at.ts` adds
  `breach_notified_at TIMESTAMPTZ` plus a partial index on
  `(sla_breached_at NULLS FIRST, started_at) WHERE sla_breached = TRUE
  AND breach_notified_at IS NULL`. Both statements are `IF NOT EXISTS`
  → idempotent.
- `ApprovalMetricsService` gains two methods:
  - `listBreachesPendingNotification(limit?)` — returns ids of breached
    rows with no notify timestamp, oldest first.
  - `markBreachNotified(ids, when?)` — stamps successful notifies. The
    UPDATE is guarded by `breach_notified_at IS NULL` so a re-run can
    never overwrite an earlier notify time.
- `ApprovalSlaScheduler.tick` now dispatches the union of newly-breached
  ids (from `checkSlaBreaches`) and retry-pending ids (from
  `listBreachesPendingNotification`). The pending lookup is gated on
  `onBreach` being configured — if no notifier is wired, the tick still
  flips the breach flag but skips the lookup entirely.
- `ApprovalBreachNotifier` drops the in-memory `Set<instanceId>` FIFO and
  calls `metrics.markBreachNotified(successfulInstanceIds)` after each
  per-instance fan-out. Only instances where at least one channel
  reported `ok: true` are stamped — total-failure instances stay
  unmarked so the next tick retries them.

## Schema bootstrap helper

`packages/core-backend/tests/helpers/approval-schema-bootstrap.ts` is the
test-side mirror of the migration. Both the inline `CREATE TABLE` and an
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` were updated so:

- Fresh databases get the column in the initial CREATE.
- Existing test schemas (already bootstrapped to the prior version) pick
  it up via the ALTER on next run.
- The partial index is created alongside the other `idx_approval_metrics_*`
  declarations.

Bumped `APPROVAL_SCHEMA_BOOTSTRAP_VERSION` from `'20260425-wp5-sla'` to
`'20260426-wp5-breach-notified-at'`. Worker pools sharing the bootstrap
will re-bootstrap on first run.

## Notifier Semantics: Best-Effort → At-Least-Once

| Aspect | Before (PR #1171) | After (this slice) |
| --- | --- | --- |
| Dedupe state | In-memory `Set<instanceId>` FIFO, capped at 5000 | DB column `approval_metrics.breach_notified_at` |
| Restart behaviour | All-time dedupe lost; future ticks of already-flagged rows would re-notify if they ever resurfaced (they don't, because `checkSlaBreaches` doesn't re-emit them) | Persisted; survives restarts and leader takeovers |
| Total-channel-failure | Row marked `sla_breached=TRUE` but never appeared in another `onBreach` batch → silently dropped | Row stays `breach_notified_at IS NULL`, scheduler picks it up next tick |
| Schedule cost | None | One extra `SELECT … LIMIT 200` per tick when `onBreach` is configured; the partial index keeps it O(log N) regardless of historical breach count |

Drop rationale for the in-memory FIFO: the persistent column makes it
strictly redundant. Within a single tick, the per-call `seen` set still
deduplicates the input id list. Across ticks, the next
`listBreachesPendingNotification` call already excludes anything stamped
in a prior dispatch. Keeping both layers would require either (a)
replicating the eviction policy on column reads or (b) accepting that the
FIFO can mask a genuine retry — both undesirable. Removed cleanly; no
defense-in-depth carve-out preserved.

## Failure Behaviour

The notifier's no-throw contract is preserved:

- `metrics.listBreachContextByIds` rejects → log warn, return `NotifyResult`
  with all ids in `skipped`, no channels invoked, no marking.
- A channel throws or returns `{ ok: false }` → bucketed into per-channel
  failure counts; instance is not added to `successfulIds`.
- `metrics.markBreachNotified` rejects → log warn, still resolve the
  result. Next tick will re-dispatch the same instance because the
  database state never changed.
- The scheduler's existing try/catch around the whole `onBreach` call is
  retained as defense in depth.

The "exception propagates up to scheduler's try/catch" wording in the
task spec was reconciled to: the notifier *itself* never throws (a
property the original implementation also held); when notifier-internal
DB calls fail the row stays unmarked and the scheduler's own try/catch
covers anything thrown by the user-supplied `onBreach` wrapper at
`index.ts`.

## Migration Safety

- `ALTER TABLE … ADD COLUMN IF NOT EXISTS` — safe to apply against a DB
  where the column already exists (e.g., partially bootstrapped test DBs
  that picked up the helper change before the migration).
- `CREATE INDEX IF NOT EXISTS … WHERE …` — partial index creation does
  not lock the table for writes (Postgres `CREATE INDEX` without
  `CONCURRENTLY` does take a brief AccessExclusive lock during catalog
  update, but the actual data scan runs on a snapshot; in production
  consider `CREATE INDEX CONCURRENTLY` if rolling out to a >100M-row
  table — this slice does not change the DDL because the WP5 baseline
  tables are still small).
- `down()` reverses cleanly: drop index, drop column. Existing rows
  retain their `sla_breached` / `sla_breached_at` state — only the
  notify history is lost.

## Files

### Backend
- `packages/core-backend/src/db/migrations/zzzz20260426100000_add_breach_notified_at.ts`
  — new Kysely migration.
- `packages/core-backend/src/services/ApprovalMetricsService.ts` — new
  `listBreachesPendingNotification` + `markBreachNotified`.
- `packages/core-backend/src/services/ApprovalSlaScheduler.ts` — tick
  dispatches the union; `mergeUnique` preserves new-first ordering.
- `packages/core-backend/src/services/ApprovalBreachNotifier.ts` — FIFO
  removed; calls `markBreachNotified` post-dispatch.

### Tests
- `packages/core-backend/tests/unit/approval-metrics-breach-notified-at.test.ts`
  — new file. 7 cases covering ordering, limit clamping, NULL guard,
  empty-input no-op.
- `packages/core-backend/tests/unit/approval-breach-notifier.test.ts` —
  existing FIFO-dedupe test rewritten to assert `markBreachNotified` is
  called with the right ids; added cases for mixed-channel partial
  success, listBreachContextByIds rejection, markBreachNotified
  rejection.
- `packages/core-backend/tests/unit/approval-sla-scheduler.test.ts` —
  added cases for the union dispatch, retry-only tick, no-onBreach
  short-circuit, and listBreachesPendingNotification failure isolation.
- `packages/core-backend/tests/helpers/approval-schema-bootstrap.ts` —
  inlined the new column + partial index, bumped version.

## Rollback

1. Revert this commit. The previous merged slice still works (in-memory
   FIFO returns; persistent dedupe is lost). Migration `down()` removes
   the column and partial index; existing rows are unaffected aside from
   the dropped column data.
2. If only the notifier behaviour needs to change (keep the column for
   later use), revert just the `ApprovalBreachNotifier.ts` and
   `ApprovalSlaScheduler.ts` changes — the column is benign when not
   read.

## Follow-ups

- Email transport: still a stub. Tracked from the parent slice.
- Optional: webhook retry with exponential backoff inside the channel
  itself, layered on top of the new tick-level retry.
- Optional: `breach_notified_at` could feed a "notification health"
  dashboard surfacing rows where breach age − notify lag exceeds a
  threshold.
