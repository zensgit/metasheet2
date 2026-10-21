import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// Lock-5 §1.4 / OD-L5-9(a) — a member operation refused by the per-node operation policy writes one
// `action:'policy_denied'` audit row (the records-only commit at the §2.1 dispatch choke).
// `approval_records.action` carries `approval_records_action_check`, last widened to FIFTEEN members
// by zzzz20260817120000_add_handle_action_to_approval_records.ts (Lock-3's `handle`). A
// `policy_denied` INSERT would violate that CHECK, so this migration widens it.
//
// `policy_denied` is deliberately NOT a member of `APPROVAL_ACTION_TYPES` — it is never a
// dispatchable request action. The CHECK has always been a strict SUPERSET of that union (it also
// carries `created`/`sign`/`cc`/`remind`/`jump`/`reassign` for system-generated audit rows), and this
// value lives in that superset only. Adding it to the dispatch union would break Lock-5 gate A-1's
// exact-set partition and the attendance P26 pinned union (ATTENDANCE_P26_ACTION_UNION_DRIFT).
//
// Pure constraint widening — no data migration, no column change.
const ACTIONS_WITH_POLICY_DENIED = [
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
  'policy_denied',
]
const ACTIONS_WITHOUT_POLICY_DENIED = ACTIONS_WITH_POLICY_DENIED.filter(
  (action) => action !== 'policy_denied',
)

function actionCheck(actions: string[]): string {
  return `action IN (${actions.map((action) => `'${action}'`).join(', ')})`
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql.raw(`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (${actionCheck(ACTIONS_WITH_POLICY_DENIED)})`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reverting drops the widened CHECK and restores the fifteen-member form NOT VALID — any
  // `policy_denied` rows written while the widened constraint was live are left in place (mirrors the
  // add-action idiom used by every prior widening in this chain).
  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql.raw(`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (${actionCheck(ACTIONS_WITHOUT_POLICY_DENIED)}) NOT VALID`).execute(db)
}
