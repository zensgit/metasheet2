import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import {
  buildPluginPermissionCode,
  buildPluginRoleId,
  type PluginRoleKind,
} from '../../rbac/plugin-role-template'
import { checkTableExists } from './_patterns'

type ElearningRoleTemplate = {
  id: string
  name: string
  permissions: string[]
}

const ROLE_NAMESPACE = 'plugin-elearning'
const PERMISSION_NAMESPACE = 'elearning'

function permission(action: string): string {
  return buildPluginPermissionCode(PERMISSION_NAMESPACE, action)
}

function role(
  kind: PluginRoleKind,
  name: string,
  actions: string[],
): ElearningRoleTemplate {
  return {
    id: buildPluginRoleId(ROLE_NAMESPACE, kind),
    name,
    permissions: actions.map(permission),
  }
}

export const ELEARNING_ROLE_TEMPLATES: ElearningRoleTemplate[] = [
  role('viewer', 'E-learning Viewer', ['read']),
  role('operator', 'E-learning Operator', ['read', 'write', 'grade', 'stats']),
  role('admin', 'E-learning Admin', ['read', 'write', 'grade', 'stats', 'admin']),
]

export const ELEARNING_ROLE_IDS = ELEARNING_ROLE_TEMPLATES.map((template) => template.id)
export const ELEARNING_ROLE_PERMISSION_CODES = Array.from(
  new Set(ELEARNING_ROLE_TEMPLATES.flatMap((template) => template.permissions)),
)
export const ELEARNING_ROLE_DOWN_ASSIGNED =
  'cannot remove e-learning role templates while assignments exist'

async function requireRbacTables(db: Kysely<unknown>): Promise<void> {
  const tableChecks = await Promise.all(
    ['roles', 'permissions', 'role_permissions', 'user_roles'].map((table) =>
      checkTableExists(db, table),
    ),
  )
  if (tableChecks.some((exists) => !exists)) {
    throw new Error('e-learning role templates require RBAC tables')
  }
}

async function requireCanonicalPermissions(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ code: string }>`
    SELECT code
      FROM permissions
     WHERE code IN (${sql.join(ELEARNING_ROLE_PERMISSION_CODES.map((code) => sql`${code}`))})
  `.execute(db)
  if (result.rows.length !== ELEARNING_ROLE_PERMISSION_CODES.length) {
    throw new Error('e-learning role templates require all canonical permissions')
  }
}

async function lockCanonicalRoles(db: Kysely<unknown>): Promise<void> {
  for (const template of ELEARNING_ROLE_TEMPLATES) {
    const result = await sql<{ id: string; name: string }>`
      INSERT INTO roles (id, name)
      VALUES (${template.id}, ${template.name})
      ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name
        WHERE roles.name = EXCLUDED.name
           OR roles.name = roles.id
      RETURNING id, name
    `.execute(db)
    if (
      result.rows.length !== 1
      || result.rows[0]?.id !== template.id
      || result.rows[0]?.name !== template.name
    ) {
      throw new Error('e-learning role template identifier conflict')
    }
  }

  const locked = await sql<{ id: string; name: string }>`
    SELECT id, name
      FROM roles
     WHERE id IN (${sql.join(ELEARNING_ROLE_IDS.map((id) => sql`${id}`))})
     ORDER BY id
     FOR UPDATE
  `.execute(db)
  const expected = ELEARNING_ROLE_TEMPLATES
    .map((template) => ({ id: template.id, name: template.name }))
    .sort((left, right) => left.id.localeCompare(right.id))
  if (JSON.stringify(locked.rows) !== JSON.stringify(expected)) {
    throw new Error('e-learning role template identifier conflict')
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await requireRbacTables(db)
  await requireCanonicalPermissions(db)
  await lockCanonicalRoles(db)

  for (const template of ELEARNING_ROLE_TEMPLATES) {
    await sql`
      DELETE FROM role_permissions
       WHERE role_id = ${template.id}
         AND permission_code NOT IN (
           ${sql.join(template.permissions.map((code) => sql`${code}`))}
         )
    `.execute(db)

    for (const permissionCode of template.permissions) {
      await sql`
        INSERT INTO role_permissions (role_id, permission_code)
        VALUES (${template.id}, ${permissionCode})
        ON CONFLICT (role_id, permission_code) DO NOTHING
      `.execute(db)
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await requireRbacTables(db)

  const assigned = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM user_roles
       WHERE role_id IN (${sql.join(ELEARNING_ROLE_IDS.map((id) => sql`${id}`))})
    ) AS exists
  `.execute(db)
  if (assigned.rows[0]?.exists === true) {
    throw new Error(ELEARNING_ROLE_DOWN_ASSIGNED)
  }

  // Matching the core role-table precedent, rollback is deliberately inert:
  // role ids and grants may already be referenced by runtime or external data.
  // Re-applying up() converges the exact canonical matrix idempotently.
}
