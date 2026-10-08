/**
 * #4196 §6.1: persist the ledger namespace across wait/approval continuations.
 *
 * A real-fire test run can suspend at wait_for_callback or start_approval. Its resumed tail must keep
 * the server-derived root and kind='test_run'; falling back to the execution id/kind='execution' would
 * re-enter the production claim namespace. Existing rows remain execution-kind. Suspension roots stay
 * nullable so pre-migration rows retain the existing lineage re-derivation fallback on resume.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, 'multitable_automation_suspensions')) {
    await sql`ALTER TABLE multitable_automation_suspensions ADD COLUMN IF NOT EXISTS root_execution_id text`.execute(db)
    await sql`ALTER TABLE multitable_automation_suspensions ADD COLUMN IF NOT EXISTS ledger_kind text NOT NULL DEFAULT 'execution'`.execute(db)
    await sql`ALTER TABLE multitable_automation_suspensions DROP CONSTRAINT IF EXISTS chk_mt_auto_suspension_root_nonblank`.execute(db)
    await sql`ALTER TABLE multitable_automation_suspensions ADD CONSTRAINT chk_mt_auto_suspension_root_nonblank CHECK (root_execution_id IS NULL OR root_execution_id ~ '[!-~]')`.execute(db)
    await sql`ALTER TABLE multitable_automation_suspensions DROP CONSTRAINT IF EXISTS chk_mt_auto_suspension_ledger_kind`.execute(db)
    await sql`ALTER TABLE multitable_automation_suspensions ADD CONSTRAINT chk_mt_auto_suspension_ledger_kind CHECK (ledger_kind IN ('execution','test_run'))`.execute(db)
  }

  if (await checkTableExists(db, 'multitable_automation_approval_bridges')) {
    await sql`ALTER TABLE multitable_automation_approval_bridges ADD COLUMN IF NOT EXISTS ledger_kind text NOT NULL DEFAULT 'execution'`.execute(db)
    await sql`ALTER TABLE multitable_automation_approval_bridges DROP CONSTRAINT IF EXISTS chk_mt_auto_approval_bridge_ledger_kind`.execute(db)
    await sql`ALTER TABLE multitable_automation_approval_bridges ADD CONSTRAINT chk_mt_auto_approval_bridge_ledger_kind CHECK (ledger_kind IN ('execution','test_run'))`.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, 'multitable_automation_approval_bridges')) {
    await sql`ALTER TABLE multitable_automation_approval_bridges DROP CONSTRAINT IF EXISTS chk_mt_auto_approval_bridge_ledger_kind`.execute(db)
    await sql`ALTER TABLE multitable_automation_approval_bridges DROP COLUMN IF EXISTS ledger_kind`.execute(db)
  }
  if (await checkTableExists(db, 'multitable_automation_suspensions')) {
    await sql`ALTER TABLE multitable_automation_suspensions DROP CONSTRAINT IF EXISTS chk_mt_auto_suspension_ledger_kind`.execute(db)
    await sql`ALTER TABLE multitable_automation_suspensions DROP CONSTRAINT IF EXISTS chk_mt_auto_suspension_root_nonblank`.execute(db)
    await sql`ALTER TABLE multitable_automation_suspensions DROP COLUMN IF EXISTS ledger_kind`.execute(db)
    await sql`ALTER TABLE multitable_automation_suspensions DROP COLUMN IF EXISTS root_execution_id`.execute(db)
  }
}
