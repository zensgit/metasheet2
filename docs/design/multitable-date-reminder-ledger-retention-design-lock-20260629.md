# Multitable date-reminder ledger retention — design lock (2026-06-29)

> Status: RATIFIED + BUILT in this slice. Owner chose the 365-day retention default for the
> `schedule.date_field` idempotency ledger.

## 1. Problem

`meta_automation_date_reminder_fires` is the claim ledger that gives date reminders their at-most-once
property. Each fired occurrence writes `(rule_id, record_id, occurrence_ts)` before executing the automation,
and later scans skip duplicates by the primary key. Rule deletion cascades ledger rows, but a long-lived active
rule can accumulate rows forever.

## 2. Decision

- Keep ledger rows for **365 days**.
- Age by `fired_at`, not `occurrence_ts`. Retention answers "how long do we keep the claim/audit row after it
  was written"; `occurrence_ts` is the record-relative reminder instant and can differ from actual firing time
  after catch-up.
- Retention is best-effort and must never block reminder delivery.
- No new global scheduler. An active date-reminder scan opportunistically sweeps at most once per process per
  day; explicit `sweepDateReminderLedger()` remains available as an ops/test seam.
- Rule deletion remains immediate through the existing FK cascade.

## 3. Non-goals

- Configurable retention (`180` vs `365`) is not built. The owner selected 365 days for v1.
- Archival/export of old ledger rows is not built.
- Changing the dedup key or delivery semantic is out of scope. At-most-once remains unchanged.

## 4. Verification gates

- Pure helper pins the 365-day cutoff.
- Real-DB test inserts old and recent ledger rows, runs the sweep, and proves only the old `fired_at` row is
  removed.
- Existing date-reminder scan/claim/fire tests remain green.
