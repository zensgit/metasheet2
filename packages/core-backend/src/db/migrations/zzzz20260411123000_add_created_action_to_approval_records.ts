import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (action IN ('created', 'approve', 'reject', 'return', 'revoke', 'transfer', 'sign', 'comment', 'cc'))`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (action IN ('approve', 'reject', 'return', 'revoke', 'transfer', 'sign', 'comment', 'cc'))`.execute(db)
}
