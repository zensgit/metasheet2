/** #4196 §5: support the fixed-window applied-ledger retention sweep without a full-table scan. */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_action_applied_applied_at
    ON meta_automation_action_applied (applied_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_automation_action_applied_applied_at`.execute(db)
}
