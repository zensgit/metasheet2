import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Wave 2 WP3 slice 1 (审批催办): accept `action = 'remind'` in approval_records
 * so requesters can record a nudge without changing the approval's status.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (action IN ('created', 'approve', 'reject', 'return', 'revoke', 'transfer', 'sign', 'comment', 'cc', 'remind'))`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (action IN ('created', 'approve', 'reject', 'return', 'revoke', 'transfer', 'sign', 'comment', 'cc'))`.execute(db)
}
