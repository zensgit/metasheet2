import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

const ADMIN_SCOPE_PERMISSIONS = [
  {
    code: 'approvals:admin',
    name: 'Approvals Admin',
    description: 'Perform administrative approval process recovery actions',
  },
  {
    code: 'approvals:admin-templates',
    name: 'Approval Template Admin',
    description: 'Manage approval templates without approval process recovery privileges',
  },
  {
    code: 'approvals:admin-data',
    name: 'Approval Data Recovery Admin',
    description: 'Perform approval data recovery operations without template administration privileges',
  },
] as const
const NEW_ADMIN_SCOPE_PERMISSION_CODES = ADMIN_SCOPE_PERMISSIONS
  .map((permission) => permission.code)
  .filter((code) => code !== 'approvals:admin')

const ACTIONS_WITH_REASSIGN = [
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
]
const ACTIONS_WITHOUT_REASSIGN = ACTIONS_WITH_REASSIGN.filter((action) => action !== 'reassign')

function actionCheck(actions: string[]): string {
  return `action IN (${actions.map((action) => `'${action}'`).join(', ')})`
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql.raw(`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (${actionCheck(ACTIONS_WITH_REASSIGN)})`).execute(db)

  const permissionsExists = await checkTableExists(db, 'permissions')
  if (permissionsExists) {
    for (const permission of ADMIN_SCOPE_PERMISSIONS) {
      await sql`
        INSERT INTO permissions (code, name, description)
        VALUES (${permission.code}, ${permission.name}, ${permission.description})
        ON CONFLICT (code) DO NOTHING
      `.execute(db)
    }
  }

  const rolePermissionsExists = await checkTableExists(db, 'role_permissions')
  if (permissionsExists && rolePermissionsExists) {
    for (const permission of ADMIN_SCOPE_PERMISSIONS) {
      await sql`
        INSERT INTO role_permissions (role_id, permission_code)
        SELECT 'admin', p.code
        FROM permissions p
        WHERE p.code = ${permission.code}
        ON CONFLICT DO NOTHING
      `.execute(db)
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rolePermissionsExists = await checkTableExists(db, 'role_permissions')
  if (rolePermissionsExists) {
    await sql`
      DELETE FROM role_permissions
      WHERE permission_code IN (${sql.join(NEW_ADMIN_SCOPE_PERMISSION_CODES)})
    `.execute(db)
  }

  const permissionsExists = await checkTableExists(db, 'permissions')
  if (permissionsExists) {
    await sql`
      DELETE FROM permissions
      WHERE code IN (${sql.join(NEW_ADMIN_SCOPE_PERMISSION_CODES)})
    `.execute(db)
  }

  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql.raw(`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (${actionCheck(ACTIONS_WITHOUT_REASSIGN)}) NOT VALID`).execute(db)
}
