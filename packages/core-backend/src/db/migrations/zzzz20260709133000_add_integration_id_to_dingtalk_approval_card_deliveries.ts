/**
 * Migration: pin the approval-card delivery to the corp it was sent through (DT-R2).
 *
 * The send path resolves the assignee's DingTalk integration (directory_account_links lateral)
 * and uses it for the outbound credentials, but the ledger row never recorded WHICH integration —
 * so the approve/reject callback path could only fall back to a global "one stored dingtalk
 * integration" pick (unstable under multi-corp). `integration_id` makes the delivery row the
 * authoritative anchor for credential/secret resolution on the callback side.
 *
 * Nullable by design: legacy rows predate the column, and env-only single-corp deploys can send
 * without a linked integration. ON DELETE SET NULL — deleting an integration must not delete the
 * approval audit trail; verify then falls back to the legacy resolver.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE dingtalk_approval_card_deliveries
    ADD COLUMN IF NOT EXISTS integration_id UUID NULL
      REFERENCES directory_integrations(id) ON DELETE SET NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE dingtalk_approval_card_deliveries
    DROP COLUMN IF EXISTS integration_id
  `.execute(db)
}
