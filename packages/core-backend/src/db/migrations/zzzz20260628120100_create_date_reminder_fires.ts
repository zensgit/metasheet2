/**
 * Migration: `meta_automation_date_reminder_fires` — the date-reminder idempotency ledger.
 *
 * A date-reminder scan computes, per record, a day-bucketed `occurrence_ts` (pure function of the record's
 * date value + the rule's offset/direction/timeOfDay). To fire AT-MOST-ONCE per (rule, record, occurrence)
 * across ticks AND replicas, the scan claims the occurrence here FIRST (INSERT ... ON CONFLICT DO NOTHING)
 * and only fires when the insert won. The composite PRIMARY KEY is the dedup key. occurrence_ts is the
 * day-bucketed reminder instant (NOT the wall-clock fire time — `fired_at` records that), so editing a
 * deadline to a NEW day produces a NEW occurrence (fires once) while same-day edits stay deduped.
 *
 * FK → automation_rules(id) ON DELETE CASCADE: deleting a rule reaps its ledger rows (the common churn). Long
 * lived active rules are aged by the service's fixed 365-day `fired_at` retention sweep. Pure DDL;
 * idempotent.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_automation_date_reminder_fires (
      rule_id text NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
      record_id text NOT NULL,
      occurrence_ts timestamptz NOT NULL,
      fired_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (rule_id, record_id, occurrence_ts)
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_date_reminder_fires_rule
    ON meta_automation_date_reminder_fires (rule_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_automation_date_reminder_fires`.execute(db)
}
