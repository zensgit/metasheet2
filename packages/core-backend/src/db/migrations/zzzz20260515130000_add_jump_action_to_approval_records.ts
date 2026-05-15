import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

const APPROVALS_ADMIN_PERMISSION = 'approvals:admin'
const ACTIONS_WITH_JUMP = [
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
]
const ACTIONS_WITHOUT_JUMP = ACTIONS_WITH_JUMP.filter((action) => action !== 'jump')

function actionCheck(actions: string[]): string {
  return `action IN (${actions.map((action) => `'${action}'`).join(', ')})`
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql.raw(`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (${actionCheck(ACTIONS_WITH_JUMP)})`).execute(db)

  const permissionsExists = await checkTableExists(db, 'permissions')
  if (permissionsExists) {
    await sql`
      INSERT INTO permissions (code, name, description)
      VALUES (${APPROVALS_ADMIN_PERMISSION}, 'Approvals Admin', 'Perform administrative approval recovery actions')
      ON CONFLICT (code) DO NOTHING
    `.execute(db)
  }

  const rolePermissionsExists = await checkTableExists(db, 'role_permissions')
  if (permissionsExists && rolePermissionsExists) {
    await sql`
      INSERT INTO role_permissions (role_id, permission_code)
      SELECT 'admin', p.code
      FROM permissions p
      WHERE p.code = ${APPROVALS_ADMIN_PERMISSION}
      ON CONFLICT DO NOTHING
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rolePermissionsExists = await checkTableExists(db, 'role_permissions')
  if (rolePermissionsExists) {
    await sql`
      DELETE FROM role_permissions
      WHERE permission_code = ${APPROVALS_ADMIN_PERMISSION}
    `.execute(db)
  }

  const permissionsExists = await checkTableExists(db, 'permissions')
  if (permissionsExists) {
    await sql`
      DELETE FROM permissions
      WHERE code = ${APPROVALS_ADMIN_PERMISSION}
    `.execute(db)
  }

  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql.raw(`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (${actionCheck(ACTIONS_WITHOUT_JUMP)}) NOT VALID`).execute(db)
}
