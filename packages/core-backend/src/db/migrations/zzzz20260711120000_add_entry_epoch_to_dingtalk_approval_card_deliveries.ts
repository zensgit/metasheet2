import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * P1-1 (stale-card node/epoch binding): record the node-entry epoch a card was sent for.
 *
 * The card-delivery action wrapper gates actionability on a LIVE active `approval_assignments`
 * row matching the delivery's node + recipient. That live-state match already closes FORWARD
 * advance (node-1's assignment flips is_active=FALSE once the node is approved), but SAME-NODE
 * re-entry (a loop-back to the same node_key mints a FRESH entry_epoch on a NEW active assignment)
 * would still match on node_key + recipient alone. Persisting the epoch the card was sent for lets
 * the wrapper additionally require the delivery's epoch to equal the active assignment's epoch, so
 * a stale card from a prior round of the SAME node is no longer actionable.
 *
 * Nullable + additive: legacy rows predate the column and carry NULL. A NULL delivery epoch skips
 * the epoch clause entirely (dual-read, mirroring approval_assignments.entry_epoch §6) — forward
 * advance stays closed via the node/assignee match, so in-flight legacy cards are never broken. A
 * non-null delivery epoch enforces the exact-round match. No backfill (the dual-read removes the
 * risk).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const hasTable = await checkTableExists(db, 'dingtalk_approval_card_deliveries')
  if (hasTable) {
    await sql`ALTER TABLE dingtalk_approval_card_deliveries ADD COLUMN IF NOT EXISTS entry_epoch INTEGER`.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const hasTable = await checkTableExists(db, 'dingtalk_approval_card_deliveries')
  if (hasTable) {
    await sql`ALTER TABLE dingtalk_approval_card_deliveries DROP COLUMN IF EXISTS entry_epoch`.execute(db)
  }
}
