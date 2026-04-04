import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

const COMMENT_PERMISSIONS = [
  ['comments:read', 'Comments Read', 'Read comments and discussion threads'],
  ['comments:write', 'Comments Write', 'Create, update, resolve, and delete comments'],
] as const

const ROLE_PERMISSION_PAIRS = [
  ['admin', 'comments:read'],
  ['admin', 'comments:write'],
  ['user', 'comments:read'],
  ['user', 'comments:write'],
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  const permissionsExists = await checkTableExists(db, 'permissions')
  if (permissionsExists) {
    for (const [code, name, description] of COMMENT_PERMISSIONS) {
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
    for (const [code] of COMMENT_PERMISSIONS) {
      await sql`
        DELETE FROM permissions
        WHERE code = ${code}
      `.execute(db)
    }
  }
}
