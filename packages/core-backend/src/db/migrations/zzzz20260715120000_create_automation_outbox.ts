/**
 * Migration: `meta_automation_outbox` + `meta_automation_outbox_consumer` — P2 durable-delivery substrate.
 *
 * FWB-0 design lock (#4203, Layer 1) + approval-line plan (#4239): the automation completion→delivery
 * chain today has two crash-loss windows (commit-then-emit to an in-memory `eventemitter3` bus; a
 * terminal claim-before-execute tombstone). This migration lands the **additive, unused-until-wired**
 * substrate for the durable fix:
 *
 *   - `meta_automation_outbox`         — one row per producer event, written in the SAME transaction as
 *                                        the source state change (approval status write / record write).
 *                                        `manifest_version` stamps the routing manifest that expanded it
 *                                        (a v1 row is dispatched per v1 forever — never re-interpreted).
 *   - `meta_automation_outbox_consumer`— per-(outbox_id, consumer_key) delivery state. `status` is the
 *                                        four-state machine `pending|in_progress|done|dead_letter` plus a
 *                                        `failed` transient; `fence` is the monotonic epoch bumped on every
 *                                        claim/reclaim (a stale-fence "zombie" write hits 0 rows, §Layer-1
 *                                        fencing); `attempts` is incremented AT CLAIM (so an always-crash-
 *                                        after-claim poison still reaches `dead_letter`); `lease_expires_at`
 *                                        is the reclaim lease.
 *
 * NOTHING reads or writes these tables yet — the durable dispatcher (S2), the producer-side atomic enqueue
 * (S4), and the consumer adapters (S5) are separate, flag-gated slices. This migration is byte-for-byte
 * behavior-neutral: no existing table is altered, no code path touches these tables while
 * `AUTOMATION_DURABLE_DELIVERY_ENABLED` is OFF (the default). Additive `CREATE TABLE IF NOT EXISTS` only.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Producer event rows — co-committed with the source state change.
  await sql`
    CREATE TABLE IF NOT EXISTS meta_automation_outbox (
      id               text PRIMARY KEY,
      event_type       text NOT NULL,
      payload          jsonb NOT NULL,
      automation_depth int  NOT NULL DEFAULT 0,
      manifest_version int  NOT NULL,
      event_id         text,
      created_at       timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  // Dispatcher polls pending rows oldest-first.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_outbox_created_at
    ON meta_automation_outbox (created_at)
  `.execute(db)

  // Per-(outbox_id, consumer_key) delivery state — the reclaimable lease row (fence-bearing).
  await sql`
    CREATE TABLE IF NOT EXISTS meta_automation_outbox_consumer (
      outbox_id        text NOT NULL REFERENCES meta_automation_outbox(id) ON DELETE CASCADE,
      consumer_key     text NOT NULL,
      status           text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','in_progress','done','failed','dead_letter')),
      lease_expires_at timestamptz,
      fence            bigint NOT NULL DEFAULT 0,
      attempts         int    NOT NULL DEFAULT 0,
      last_error       text,
      updated_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (outbox_id, consumer_key)
    )
  `.execute(db)
  // Dispatcher claim scan: reclaimable rows are pending, or in_progress past a stale lease.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_outbox_consumer_claim
    ON meta_automation_outbox_consumer (status, lease_expires_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_automation_outbox_consumer`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_automation_outbox`.execute(db)
}
