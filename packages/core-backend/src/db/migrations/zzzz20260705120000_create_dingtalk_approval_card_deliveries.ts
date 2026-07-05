import { sql, type Kysely } from 'kysely'

/**
 * A-1 (one-tap design-lock §3): dedicated ledger binding a DingTalk approval card delivery to its
 * approval instance. One row = one actionable card sent to one recipient. Callbacks and the mobile
 * decision page resolve ONLY through this ledger (id → instance_id); payload-supplied instance ids
 * are never trusted. Deliberately NOT an extension of dingtalk_person_deliveries — that table is
 * generic notification telemetry with a different lifecycle.
 *
 * State machine (enforced by CHECK + the accessor's atomic claim):
 *   sent → acted | superseded | expired | revoked
 * `acted_*` audit columns are present exactly when card_state='acted' (CHECK dacd_acted_consistency).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS dingtalk_approval_card_deliveries (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      recipient_dingtalk_user_id TEXT NOT NULL,
      delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('work_notice_action_card', 'interactive_card')),
      task_id TEXT,
      card_state TEXT NOT NULL DEFAULT 'sent' CHECK (card_state IN ('sent', 'acted', 'superseded', 'expired', 'revoked')),
      acted_action TEXT,
      acted_by TEXT,
      acted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT dacd_acted_consistency CHECK (
        (card_state = 'acted') = (acted_action IS NOT NULL AND acted_by IS NOT NULL AND acted_at IS NOT NULL)
      )
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_dacd_instance
    ON dingtalk_approval_card_deliveries(instance_id, created_at DESC)
  `.execute(db)

  // Supersede sweeps + "open card?" checks touch only card_state='sent' rows.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_dacd_instance_sent
    ON dingtalk_approval_card_deliveries(instance_id)
    WHERE card_state = 'sent'
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_dacd_instance_sent`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_dacd_instance`.execute(db)
  await sql`DROP TABLE IF EXISTS dingtalk_approval_card_deliveries`.execute(db)
}
