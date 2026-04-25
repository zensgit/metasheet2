# Approval Breach Notification Persistence · Design

> Date: 2026-04-26
> Follow-up to: PR #1171 (`feat(approval): add SLA breach notification channels`)
> Closes: the "persistent breach_notified_at column" follow-up acknowledged in PR #1171's commit message and code comment.

## Problem

PR #1171 ships `ApprovalBreachNotifier` with **in-memory only** dedupe — a `Set<instanceId>` of already-notified rows on the leader process. The commit message and class doc-comment both flag this as a known limitation:

> `A persistent breach_notified_at column is tracked as a follow-up.`

The concrete failure mode this gap leaves open:

1. SLA scheduler atomic flip (`UPDATE approval_metrics SET sla_breached = TRUE WHERE sla_breached = FALSE RETURNING instance_id`) returns row X.
2. Notifier dispatches X via channel.send (succeeds at the wire).
3. Leader process crashes **before** `markNotified(X)` runs.
4. Restart: in-memory `notifiedIds` is empty.
5. `checkSlaBreaches` will never return X again (its WHERE filters `sla_breached = FALSE` and X is already TRUE).
6. **X is now permanently un-notified-in-the-record but actually was notified**, producing an inconsistency — operations cannot answer "did we send for X?" without log archaeology.

A more concerning variant: dispatch failed, leader crashed before retry, X never gets retried — the notifier had no concept of "missed breach to retry" because the in-memory mark was the only state.

PR #1171's commit message correctly noted that this **does not produce duplicate notifications** (the `sla_breached = FALSE` WHERE atomically excludes already-flagged rows from re-entering the pipeline). The cost is **missed dispatches stay missed**, not duplicates — but for an SLA system, missed escalations are a real customer-impact issue.

## Solution

Add the persistent column the previous PR's comment promised, plus the matching machinery to use it:

1. **Migration `058_add_approval_breach_notified_at.sql`** — adds `breach_notified_at TIMESTAMPTZ NULL` to `approval_metrics`, plus a partial index `WHERE sla_breached = TRUE AND breach_notified_at IS NULL` to keep the recovery query cheap.
2. **`ApprovalMetricsService.markBreachNotified(id, now)`** — guarded UPDATE that writes the timestamp only if it was previously NULL (so a redundant retry call is a safe no-op).
3. **`ApprovalMetricsService.findUnnotifiedBreaches(limit = 500)`** — the recovery query, returning `sla_breached = TRUE AND breach_notified_at IS NULL` ordered by `sla_breached_at ASC` (oldest first), capped at 5000.
4. **`ApprovalBreachNotifier.markNotified` becomes async** — keeps the in-memory dedupe (cheap, intra-process) but ALSO calls `metrics.markBreachNotified` so the dispatch survives restart. DB failure is logged and treated as non-fatal — in-memory dedupe still prevents same-process re-send, and the next leader will pick up via the recovery path.
5. **`ApprovalBreachNotifier.notifyMissedBreaches()`** — new method that calls `metrics.findUnnotifiedBreaches()` then routes the result through the existing `notifyBreaches()` pipeline. Idempotent because `notifyBreaches` already deduplicates and `markBreachNotified` is a guarded UPDATE.
6. **`packages/core-backend/src/index.ts` startup wiring** — fires `breachNotifier.notifyMissedBreaches()` once when the SLA scheduler starts, in fire-and-forget mode (best-effort recovery; failure must not block scheduler initialization).

## Why this is the minimal viable fix

Per the original task spec ("~60 line patch — migration + notifier one line + scheduler WHERE one line + unit test"), the implementation is intentionally compact. The major design decisions:

- **No new database table.** A column on the existing `approval_metrics` row, plus one partial index. Zero new tables, zero new joins, zero new schema bootstrap version concerns.
- **Async markNotified does NOT change the public `notifyBreaches` contract.** It already returned `Promise<NotifyResult>`; the inner await is invisible to callers.
- **Persistent failure is not fatal.** If the DB UPDATE for `breach_notified_at` fails, we log and continue — the in-memory dedupe still prevents same-process re-send, and the next process will reconcile via `notifyMissedBreaches()`.
- **Startup retry is fire-and-forget.** A best-effort recovery cannot block scheduler init; if `findUnnotifiedBreaches` fails on startup, the system is no worse than before this PR (still has working onBreach hook for new breaches).
- **Cap on `findUnnotifiedBreaches(limit)`.** Hard upper bound of 5000 prevents a long-paused leader from triggering an unbounded query on restart. Future tooling can paginate if more is needed.

## Out of scope

- **Per-channel persistence** — we persist "at least one channel succeeded" (`anySent`). Per-channel ack would require a join table and is overkill for the current escalation use case.
- **Re-notification on update** — if the requester / template metadata changes after notification, we do not re-dispatch. Out of scope for the original SLA breach feature.
- **Multi-leader coordination** — assumes the leader-lock mechanism from PR #1160 still gates dispatch to a single process. The new column does not change that contract.
- **Schema migration runtime auto-apply** — this PR only ships the SQL file; it relies on the existing migration runner to apply 058 next time `pnpm migrate` runs. Operations note: should be applied during the same maintenance window as future `feat(integration): scaffold integration core plugin (#1140)` style upgrades.

## Files changed

- `packages/core-backend/migrations/058_add_approval_breach_notified_at.sql` — new (12 lines)
- `packages/core-backend/src/services/ApprovalMetricsService.ts` — `markBreachNotified` + `findUnnotifiedBreaches` (~40 lines added)
- `packages/core-backend/src/services/ApprovalBreachNotifier.ts` — `markNotified` made async + persistence call + `notifyMissedBreaches` method (~40 lines added)
- `packages/core-backend/src/index.ts` — startup retry wiring (~20 lines added)
- `packages/core-backend/tests/unit/approval-breach-notifier.test.ts` — 6 new tests (markNotified persistence, partial-failure non-fatal, missed-breach replay happy / empty / DB-failure paths)
- `packages/core-backend/tests/unit/approval-metrics-service.test.ts` — 6 new tests (markBreachNotified guards, findUnnotifiedBreaches ordering / cap / fallback)
- this design doc + matching verification doc

## Risks acknowledged

| Risk | Mitigation |
|---|---|
| Migration 058 collides with another in-flight branch | Latest origin/main migration is 057; this PR claims 058 cleanly. Future migrations need to use 059+. |
| Notifier persistence DB failure during high load | Logged and treated as non-fatal; in-memory dedupe still applies; next restart's `notifyMissedBreaches` reconciles. |
| Startup `notifyMissedBreaches` discovers a large backlog (e.g. weeks of unnotified rows after a long DB outage) | Capped at 5000 per call; operator can run additional manual flush via `notifyMissedBreaches()` in REPL if needed. Considered acceptable because long-paused systems already need manual triage. |
| `breach_notified_at` column appears as NULL on rows breached BEFORE this migration | Backfill is intentionally not done. Pre-existing breached rows will appear in `findUnnotifiedBreaches()` and trigger replay on next leader startup. Operations should expect a one-time replay burst on first deploy after this PR — bounded at 5000 per cycle. |
