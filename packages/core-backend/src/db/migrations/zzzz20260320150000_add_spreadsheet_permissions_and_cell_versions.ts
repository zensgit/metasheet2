import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

const SPREADSHEET_PERMISSIONS = [
  ['spreadsheet:read', 'Spreadsheet Read', 'Read spreadsheet resources and cell data'],
  ['spreadsheet:write', 'Spreadsheet Write', 'Create and update spreadsheet resources and cell data'],
  ['spreadsheets:read', 'Spreadsheets Read', 'Read spreadsheet resources and cell data'],
  ['spreadsheets:write', 'Spreadsheets Write', 'Create and update spreadsheet resources and cell data'],
] as const

const ROLE_PERMISSION_PAIRS = [
  ['admin', 'spreadsheet:read'],
  ['admin', 'spreadsheet:write'],
  ['admin', 'spreadsheets:read'],
  ['admin', 'spreadsheets:write'],
  ['user', 'spreadsheet:read'],
  ['user', 'spreadsheet:write'],
  ['user', 'spreadsheets:read'],
  ['user', 'spreadsheets:write'],
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE cells
    ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1
  `.execute(db)

  const permissionsExists = await checkTableExists(db, 'permissions')
  if (permissionsExists) {
    for (const [code, name, description] of SPREADSHEET_PERMISSIONS) {
      await sql`
        INSERT INTO permissions (code, name, description)
        VALUES (${code}, ${name}, ${description})
        ON CONFLICT (code) DO NOTHING
      `.execute(db)
    }
  }

  const rolePermissionsExists = await checkTableExists(db, 'role_permissions')
  if (rolePermissionsExists && permissionsExists) {
    for (const [roleId, permissionCode] of ROLE_PERMISSION_PAIRS) {
      await sql`
        INSERT INTO role_permissions (role_id, permission_code)
        SELECT ${roleId}, p.code
        FROM permissions p
        WHERE p.code = ${permissionCode}
        ON CONFLICT DO NOTHING
      `.execute(db)
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rolePermissionsExists = await checkTableExists(db, 'role_permissions')
  if (rolePermissionsExists) {
    for (const [roleId, permissionCode] of ROLE_PERMISSION_PAIRS) {
      await sql`
        DELETE FROM role_permissions
        WHERE role_id = ${roleId} AND permission_code = ${permissionCode}
      `.execute(db)
    }
  }

  const permissionsExists = await checkTableExists(db, 'permissions')
  if (permissionsExists) {
    for (const [code] of SPREADSHEET_PERMISSIONS) {
      await sql`
        DELETE FROM permissions
        WHERE code = ${code}
      `.execute(db)
    }
  }

  await sql`
    ALTER TABLE cells
    DROP COLUMN IF EXISTS version
  `.execute(db)
}
