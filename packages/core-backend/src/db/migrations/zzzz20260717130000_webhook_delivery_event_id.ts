/**
 * Migration: `multitable_webhook_deliveries` — P2 durable-delivery closure item 3 (owner 2026-07-17).
 *
 * Problem: the DURABLE webhook consumer (`webhook-event-bridge`) discarded the outbox `eventId`, so an
 * at-least-once redelivery (a crash between the fire-and-forget send and the consumer-row done-CAS, or a
 * `busy` retry) called `createDeliveryRecord` again → a SECOND delivery row + a SECOND HTTP send. This adds a
 * per-(webhook, event) identity so the durable path can CLAIM instead of blindly INSERT.
 *
 * `event_id` is NULLABLE and defaults to NULL. Every LEGACY path (the bus bridge's fire-and-forget deliver,
 * the retry tick) passes no event_id → NULL → byte-identical behavior (no dedup there, unchanged; the
 * partial index below does not constrain NULL rows). ONLY the durable consumer passes the outbox eventId.
 *
 * The claim is a PARTIAL UNIQUE index on `(webhook_id, event_id) WHERE event_id IS NOT NULL`: the durable
 * insert becomes `INSERT ... ON CONFLICT DO NOTHING RETURNING id`; zero rows ⇒ this (webhook, event) was
 * already claimed ⇒ the redelivery skips the send. The partial predicate keeps NULL (legacy) rows entirely
 * unconstrained, so many legacy deliveries for the same webhook coexist exactly as today.
 *
 * `multitable_webhook_deliveries` is a `zzzz`-prefixed table (created in
 * `zzzz20260414100002_create_multitable_api_tokens_and_webhooks`); a new column on it must ALSO be a `zzzz`
 * migration so it sorts AFTER the create (migration zzzz-ordering trap).
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // NULL for every existing row and every legacy path — the durable consumer is the only writer of a non-NULL
  // value. Additive + nullable, so no backfill and no behavior change for existing rows.
  await sql`ALTER TABLE multitable_webhook_deliveries ADD COLUMN IF NOT EXISTS event_id text`.execute(db)
  // Per-(webhook, event) claim. PARTIAL so NULL (legacy) rows are unconstrained — the durable path's identity
  // dedup never touches legacy fan-out. This is the arbiter under concurrency: two racing durable delivers of
  // the same (webhook, event) → exactly one INSERT wins, the loser's ON CONFLICT DO NOTHING returns 0 rows.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_delivery_event_claim
      ON multitable_webhook_deliveries (webhook_id, event_id)
      WHERE event_id IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_webhook_delivery_event_claim`.execute(db)
  await sql`ALTER TABLE multitable_webhook_deliveries DROP COLUMN IF EXISTS event_id`.execute(db)
}
