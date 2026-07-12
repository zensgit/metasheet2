import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'
import { supersedeLegacyDingTalkApprovalCardDeliveries } from '../../integrations/dingtalk/approval-card-deliveries'

/**
 * P1-1 (stale-card node/epoch binding): record the node-entry epoch a card was sent for.
 *
 * The card-delivery action wrapper AND the engine's in-txn dispatch guard gate actionability on a
 * LIVE active `approval_assignments` row matching the delivery's node + recipient. That live-state
 * match closes FORWARD advance (node-1's assignment flips is_active=FALSE once the node is approved),
 * but SAME-NODE re-entry (a loop-back to the same node_key mints a FRESH entry_epoch on a NEW active
 * assignment) would still match on node_key + recipient alone. Persisting the epoch the card was sent
 * for lets both guards additionally require the delivery's epoch to equal the active assignment's
 * epoch, so a stale card from a prior round of the SAME node is no longer actionable.
 *
 * STRICT binding (P1-1 re-review): the epoch match carries NO null-pass arm — an actionable card MUST
 * carry a NON-NULL epoch equal to a NON-NULL live-seat epoch. The column is still nullable+additive so
 * the ADD COLUMN is safe, but legacy `sent` rows that predate the column (entry_epoch NULL) can no
 * longer act permissively, so `up()` reconciles them ONCE at migrate time:
 * `supersedeLegacyDingTalkApprovalCardDeliveries` SUPERSEDES every pre-column `sent`/NULL-epoch card
 * fail-closed. It does NOT recover an epoch — a pre-column card has no provable original-round anchor,
 * and inferring one from a currently-unique live seat would re-authorize an old card into a fresh
 * same-node round (re-review P1). Idempotent (only `sent` + NULL-epoch rows are touched) and
 * reversible-safe (`down()` drops the column; superseded stays superseded — fail-closed remains
 * closed). Retires all in-flight legacy cards; recipients re-approve via web (near-zero pre-GA).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const hasTable = await checkTableExists(db, 'dingtalk_approval_card_deliveries')
  if (hasTable) {
    await sql`ALTER TABLE dingtalk_approval_card_deliveries ADD COLUMN IF NOT EXISTS entry_epoch INTEGER`.execute(db)
    // One-time legacy reconciliation (UNSCOPED → no bound params, so sql.raw is safe): supersede every
    // pre-column `sent`/NULL-epoch card fail-closed (no epoch inference — see the fn doc for why).
    await supersedeLegacyDingTalkApprovalCardDeliveries(async (text) => {
      const res = await sql.raw(text).execute(db)
      return { rows: (res.rows ?? []) as unknown[] }
    })
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const hasTable = await checkTableExists(db, 'dingtalk_approval_card_deliveries')
  if (hasTable) {
    await sql`ALTER TABLE dingtalk_approval_card_deliveries DROP COLUMN IF EXISTS entry_epoch`.execute(db)
  }
}
