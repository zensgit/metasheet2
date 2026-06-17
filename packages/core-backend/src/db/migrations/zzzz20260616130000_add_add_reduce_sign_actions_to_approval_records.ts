import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// P1-B 加签/减签 — add `add_sign` / `reduce_sign` to the
// `approval_records_action_check` CHECK constraint. Without this the audit-row
// INSERT for these actions fails at runtime (Postgres 23514). No new
// permission rows are needed: add_sign/reduce_sign are gated by the existing
// `approvals:act` RBAC + active-assignee check (see ApprovalProductService
// `actorCanAct`), not a new permission (unlike the jump migration which added
// `approvals:admin`).
const ACTIONS_WITH_ADD_REDUCE_SIGN = [
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
]
const ACTIONS_WITHOUT_ADD_REDUCE_SIGN = ACTIONS_WITH_ADD_REDUCE_SIGN.filter(
  (action) => action !== 'add_sign' && action !== 'reduce_sign',
)

function actionCheck(actions: string[]): string {
  return `action IN (${actions.map((action) => `'${action}'`).join(', ')})`
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql.raw(`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (${actionCheck(ACTIONS_WITH_ADD_REDUCE_SIGN)})`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql.raw(`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (${actionCheck(ACTIONS_WITHOUT_ADD_REDUCE_SIGN)}) NOT VALID`).execute(db)
}
