/**
 * Migration: `meta_automation_event_fires` — event-driven automation idempotency ledger.
 *
 * Event-driven triggers (record.created/updated/deleted, form.submitted, and field.value_changed via
 * record.updated) receive a transport `_eventId` at every emit site. Each matching rule claims
 * (rule_id, dedup_key) before executing, where dedup_key = `${eventType}:${_eventId}`. The primary key
 * gives at-most-once side effects for redelivered events without hashing record contents or reading a
 * deleted record. Missing `_eventId` stays fail-open during rollout; this table only gates stamped events.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_automation_event_fires (
      rule_id text NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
      dedup_key text NOT NULL,
      fired_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (rule_id, dedup_key)
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_event_fires_fired_at
    ON meta_automation_event_fires (fired_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_automation_event_fires`.execute(db)
}
