# Date-reminder ledger retention — dev & verification (2026-06-29)

> Status: built; local pure/typecheck verification complete, real-DB verification wired for CI. Design lock:
> `docs/design/multitable-date-reminder-ledger-retention-design-lock-20260629.md`.

## 1. What changed

The date-reminder claim ledger now has bounded retention:

- `DATE_REMINDER_LEDGER_RETENTION_DAYS = 365`.
- `dateReminderLedgerRetentionCutoffIso(nowMs)` computes the fixed cutoff.
- `AutomationService.sweepDateReminderLedger(nowMs)` deletes
  `meta_automation_date_reminder_fires` rows whose `fired_at` is older than the cutoff and returns the deleted
  count.
- `evaluateDateReminders` calls a best-effort once-per-day guard before scanning candidates, so any active
  date-reminder rule keeps the ledger aged without adding another scheduler.
- `zzzz20260628120200_add_date_reminder_fires_fired_at_index` adds an index on `fired_at`, so the retention
  sweep's only predicate is indexed on existing deployments too.

## 2. Safety properties

- The dedup key remains `(rule_id, record_id, occurrence_ts)`.
- At-most-once delivery is unchanged.
- Rule deletion still cascades immediately through the existing FK.
- Retention is based on `fired_at`, not occurrence time.
- The retention predicate is indexed by a new migration, not by editing the already-shipped table migration.
- Cleanup failure logs a warning and does not block reminder delivery.

## 3. Verification

- Pure unit: `automation-date-reminder.test.ts` 23/23. New cases pin exactly 365 days and deterministic cutoff.
- Backend typecheck: `pnpm --filter @metasheet/core-backend type-check` clean.
- Real-DB integration is wired in `multitable-date-reminder-trigger.test.ts`: DR-RET inserts an old and recent
  ledger row, runs `sweepDateReminderLedger`, and proves only the old `fired_at` row is removed. Local execution
  could not complete because the local dev Postgres schema is not migrated to `meta_bases`; CI's DB lane is the
  required proof for this case.

## 4. Still deferred

- Configurable retention.
- Archival before deletion.
- Timezone-aware day bucketing and sub-day offsets remain the separate date-reminder forks named in the prior
  design records.
