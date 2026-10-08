import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// Lock-3 §2.1 — the handler node's completion verb is `handle`. `approval_records.action` carries
// `approval_records_action_check`, last rewritten to FOURTEEN members by
// zzzz20260702110000_add_approval_reassign_and_admin_scopes.ts. A `handle` audit INSERT would violate
// that CHECK, so this migration widens it to include `handle` (the third of the three sites the verb
// touches: the TS union, the route dispatch guard, and this DB CHECK). Pure constraint widening — no
// data migration, no column change.
const ACTIONS_WITH_HANDLE = [
  'created',
  'approve',
  'reject',
  'return',
  'revoke',
  'transfer',
  'sign',
  'comment',
  'cc',
  'remind',
  'jump',
  'add_sign',
  'reduce_sign',
  'reassign',
  'handle',
]
const ACTIONS_WITHOUT_HANDLE = ACTIONS_WITH_HANDLE.filter((action) => action !== 'handle')

function actionCheck(actions: string[]): string {
  return `action IN (${actions.map((action) => `'${action}'`).join(', ')})`
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql.raw(`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (${actionCheck(ACTIONS_WITH_HANDLE)})`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reverting drops the widened CHECK and restores the fourteen-member form NOT VALID — any `handle`
  // rows written while the widened constraint was live are left in place (mirrors the add-action idiom).
  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql.raw(`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (${actionCheck(ACTIONS_WITHOUT_HANDLE)}) NOT VALID`).execute(db)
}
