import type { RoleFieldPolicy, RolePermissionMatrix, RolePermissionMatrixRole } from '../types/plugin'

export type RbacProvisioningQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export interface ApplyRoleMatrixInput {
  pluginId: string
  appId: string
  tenantId: string
  projectId: string
  matrix: RolePermissionMatrix
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`)
  }
  return value.trim()
}

function normalizeRole(role: RolePermissionMatrixRole): RolePermissionMatrixRole {
  const slug = requiredString(role?.slug, 'role.slug')
  const label = requiredString(role?.label, `role(${slug}).label`)
  const permissions = Array.from(
    new Set((Array.isArray(role?.permissions) ? role.permissions : [])
      .filter((permission): permission is string => typeof permission === 'string' && permission.trim().length > 0)
      .map((permission) => permission.trim())),
  )
  if (permissions.length === 0) {
    throw new Error(`role(${slug}).permissions must be a non-empty array`)
  }
  return { slug, label, permissions }
}

function normalizeFieldPolicy(policy: RoleFieldPolicy): RoleFieldPolicy {
  const objectId = requiredString(policy?.objectId, 'fieldPolicy.objectId')
  const field = requiredString(policy?.field, 'fieldPolicy.field')
  const roleSlug = requiredString(policy?.roleSlug, 'fieldPolicy.roleSlug')
  const visibility = policy?.visibility === 'hidden' ? 'hidden' : policy?.visibility === 'visible' ? 'visible' : null
  const editability = policy?.editability === 'readonly'
    ? 'readonly'
    : policy?.editability === 'editable'
      ? 'editable'
      : null

  if (!visibility) {
    throw new Error(`fieldPolicy(${objectId}.${field}/${roleSlug}).visibility is invalid`)
  }
  if (!editability) {
    throw new Error(`fieldPolicy(${objectId}.${field}/${roleSlug}).editability is invalid`)
  }

  return {
    objectId,
    field,
    roleSlug,
    visibility,
    editability,
  }
}

function buildPermissionDescription(permissionCode: string, pluginId: string): string {
  return `Provisioned by ${pluginId}: ${permissionCode}`
}

function buildPermissionName(permissionCode: string): string {
  return permissionCode
    .split(':')
    .flatMap((part) => part.split(/[_-]+/))
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function buildProvisionedRoleId(pluginId: string, appId: string, roleSlug: string): string {
  return `${pluginId}:${appId}:${roleSlug}`
}

export async function applyRoleMatrix(
  query: RbacProvisioningQueryFn,
  input: ApplyRoleMatrixInput,
): Promise<{ rolesApplied: string[]; fieldPoliciesApplied: number }> {
  const pluginId = requiredString(input?.pluginId, 'pluginId')
  const appId = requiredString(input?.appId, 'appId')
  const tenantId = requiredString(input?.tenantId, 'tenantId')
  const projectId = requiredString(input?.projectId, 'projectId')
  const matrix = input?.matrix && typeof input.matrix === 'object' ? input.matrix : { roles: [] }
  const roles = Array.isArray(matrix.roles) ? matrix.roles.map(normalizeRole) : []
  const fieldPolicies = Array.isArray(matrix.fieldPolicies)
    ? matrix.fieldPolicies.map(normalizeFieldPolicy)
    : []

  const permissionCodes = Array.from(new Set(roles.flatMap((role) => role.permissions)))
  for (const permissionCode of permissionCodes) {
    await query(
      `INSERT INTO permissions (code, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [
        permissionCode,
        buildPermissionName(permissionCode),
        buildPermissionDescription(permissionCode, pluginId),
      ],
    )
  }

  for (const role of roles) {
    const provisionedRoleId = buildProvisionedRoleId(pluginId, appId, role.slug)
    await query(
      `INSERT INTO roles (id, name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         updated_at = now()`,
      [provisionedRoleId, role.label],
    )

    for (const permissionCode of role.permissions) {
      await query(
        `INSERT INTO role_permissions (role_id, permission_code)
         VALUES ($1, $2)
         ON CONFLICT (role_id, permission_code) DO NOTHING`,
        [provisionedRoleId, permissionCode],
      )
    }
  }

  for (const policy of fieldPolicies) {
    await query(
      `INSERT INTO plugin_field_policy_registry (
         tenant_id, plugin_id, app_id, project_id, object_id, field_name, role_slug,
         visibility, editability
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9
       )
       ON CONFLICT (tenant_id, plugin_id, app_id, project_id, object_id, field_name, role_slug)
       DO UPDATE SET
         visibility = EXCLUDED.visibility,
         editability = EXCLUDED.editability,
         updated_at = now()`,
      [
        tenantId,
        pluginId,
        appId,
        projectId,
        policy.objectId,
        policy.field,
        policy.roleSlug,
        policy.visibility,
        policy.editability,
      ],
    )
  }

  return {
    rolesApplied: roles.map((role) => role.slug),
    fieldPoliciesApplied: fieldPolicies.length,
  }
}
