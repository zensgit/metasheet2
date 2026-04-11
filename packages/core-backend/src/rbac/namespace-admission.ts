import { Logger } from '../core/logger'
import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'

const logger = new Logger('NamespaceAdmission')

const PLATFORM_ADMIN_ROLE_ID = 'admin'
const DELEGATED_ADMIN_ROLE_SUFFIX = '_admin'
const allowDegradation = process.env.RBAC_OPTIONAL === '1'

const NON_NAMESPACED_PERMISSION_RESOURCES = new Set([
  'admin',
  'approvals',
  'audit',
  'auth',
  'cache',
  'comments',
  'demo',
  'events',
  'files',
  'health',
  'meta',
  'metrics',
  'multitable',
  'notification',
  'notifications',
  'permission',
  'permissions',
  'role',
  'roles',
  'session',
  'sessions',
  'snapshot',
  'snapshots',
  'spreadsheet',
  'spreadsheets',
  'workflow',
])

type UserRolePermissionRow = {
  role_id: string
  permission_code: string | null
}

type NamespaceAdmissionRow = {
  namespace: string
  enabled: boolean
  source: string | null
  granted_by: string | null
  updated_by: string | null
  created_at: string | null
  updated_at: string | null
}

export type NamespaceAdmissionSnapshot = {
  namespace: string
  enabled: boolean
  effective: boolean
  hasRole: boolean
  source: string | null
  grantedBy: string | null
  updatedBy: string | null
  createdAt: string | null
  updatedAt: string | null
}

type UserNamespaceRoleContext = {
  isAdmin: boolean
  roleIds: string[]
  controlledNamespaces: string[]
}

let readDegraded = false
let admissionsTableUnavailable = false

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function logReadDegradation(message: string): void {
  if (readDegraded) return
  readDegraded = true
  logger.warn(message)
}

function handleReadFailure(error: unknown, message: string): boolean {
  if (isDatabaseSchemaError(error) && allowDegradation) {
    logReadDegradation(message)
    return true
  }
  return false
}

export function normalizeNamespace(value: unknown): string {
  return normalizeString(value)
}

export function deriveDelegatedAdminNamespace(roleId: string): string | null {
  const normalizedRoleId = normalizeString(roleId)
  if (!normalizedRoleId || normalizedRoleId === PLATFORM_ADMIN_ROLE_ID) return null
  if (!normalizedRoleId.endsWith(DELEGATED_ADMIN_ROLE_SUFFIX)) return null
  const namespace = normalizedRoleId.slice(0, -DELEGATED_ADMIN_ROLE_SUFFIX.length).trim()
  return namespace || null
}

export function roleIdMatchesNamespace(roleId: string, namespace: string): boolean {
  const normalizedRoleId = normalizeString(roleId)
  const normalizedNamespace = normalizeNamespace(namespace)
  if (!normalizedRoleId || !normalizedNamespace) return false
  return normalizedRoleId === normalizedNamespace || normalizedRoleId.startsWith(`${normalizedNamespace}_`)
}

export function roleIdMatchesNamespaces(roleId: string, namespaces: string[]): boolean {
  return namespaces.some((namespace) => roleIdMatchesNamespace(roleId, namespace))
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter(Boolean))).sort()
}

function derivePermissionResource(permissionCode: string): string | null {
  const normalizedCode = normalizeString(permissionCode)
  if (!normalizedCode || normalizedCode === '*:*') return null
  const separatorIndex = normalizedCode.indexOf(':')
  if (separatorIndex <= 0) return null
  return normalizedCode.slice(0, separatorIndex).trim() || null
}

export function isNamespaceAdmissionControlledResource(resource: string | null | undefined): boolean {
  const normalizedResource = normalizeString(resource)
  if (!normalizedResource || normalizedResource === '*') return false
  return !NON_NAMESPACED_PERMISSION_RESOURCES.has(normalizedResource)
}

export function derivePermissionNamespace(permissionCode: string): string | null {
  const resource = derivePermissionResource(permissionCode)
  return isNamespaceAdmissionControlledResource(resource) ? resource : null
}

async function fetchUserNamespaceRoleContext(userId: string): Promise<UserNamespaceRoleContext> {
  try {
    const result = await query<UserRolePermissionRow>(
      `SELECT ur.role_id, rp.permission_code
       FROM user_roles ur
       LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = $1`,
      [userId],
    )

    const roleIds = new Set<string>()
    const namespaces = new Set<string>()
    for (const row of result.rows) {
      const roleId = normalizeString(row.role_id)
      if (!roleId) continue
      roleIds.add(roleId)

      const delegatedAdminNamespace = deriveDelegatedAdminNamespace(roleId)
      if (delegatedAdminNamespace && isNamespaceAdmissionControlledResource(delegatedAdminNamespace)) {
        namespaces.add(delegatedAdminNamespace)
      }

      const permissionNamespace = derivePermissionNamespace(row.permission_code ?? '')
      if (permissionNamespace) {
        namespaces.add(permissionNamespace)
      }
    }

    return {
      isAdmin: roleIds.has(PLATFORM_ADMIN_ROLE_ID),
      roleIds: uniqueSorted(roleIds),
      controlledNamespaces: uniqueSorted(namespaces),
    }
  } catch (error) {
    if (handleReadFailure(error, 'Namespace admission degraded: user_roles/role_permissions unavailable')) {
      return {
        isAdmin: false,
        roleIds: [],
        controlledNamespaces: [],
      }
    }
    throw error
  }
}

async function fetchNamespaceAdmissions(userId: string): Promise<Map<string, NamespaceAdmissionRow>> {
  try {
    const result = await query<NamespaceAdmissionRow>(
      `SELECT namespace, enabled, source, granted_by, updated_by, created_at, updated_at
       FROM user_namespace_admissions
       WHERE user_id = $1`,
      [userId],
    )
    admissionsTableUnavailable = false
    return new Map(
      result.rows
        .map((row) => [normalizeNamespace(row.namespace), row] as const)
        .filter(([namespace]) => Boolean(namespace)),
    )
  } catch (error) {
    if (handleReadFailure(error, 'Namespace admission degraded: user_namespace_admissions unavailable')) {
      admissionsTableUnavailable = true
      return new Map()
    }
    throw error
  }
}

export async function listRoleNamespaces(roleId: string): Promise<string[]> {
  const namespaces = new Set<string>()
  const delegatedAdminNamespace = deriveDelegatedAdminNamespace(roleId)
  if (delegatedAdminNamespace && isNamespaceAdmissionControlledResource(delegatedAdminNamespace)) {
    namespaces.add(delegatedAdminNamespace)
  }

  try {
    const result = await query<{ permission_code: string | null }>(
      'SELECT permission_code FROM role_permissions WHERE role_id = $1',
      [roleId],
    )
    for (const row of result.rows) {
      const permissionNamespace = derivePermissionNamespace(row.permission_code ?? '')
      if (permissionNamespace) {
        namespaces.add(permissionNamespace)
      }
    }
  } catch (error) {
    if (!handleReadFailure(error, 'Namespace admission degraded: role_permissions unavailable')) {
      throw error
    }
  }

  return uniqueSorted(namespaces)
}

export async function userHasNamespaceRole(userId: string, namespace: string): Promise<boolean> {
  const normalizedNamespace = normalizeNamespace(namespace)
  if (!normalizedNamespace) return false

  try {
    const result = await query<{ allowed: boolean }>(
      `SELECT TRUE AS allowed
       FROM user_roles ur
       LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = $1
         AND (
           ur.role_id = $2
           OR ur.role_id LIKE $3 ESCAPE '\\'
           OR rp.permission_code LIKE $4
         )
       LIMIT 1`,
      [
        userId,
        normalizedNamespace,
        `${escapeLikePattern(normalizedNamespace)}\\_%`,
        `${normalizedNamespace}:%`,
      ],
    )
    return result.rows.length > 0
  } catch (error) {
    if (handleReadFailure(error, 'Namespace admission degraded: namespace role lookup unavailable')) {
      return false
    }
    throw error
  }
}

export async function listUserNamespaceAdmissionSnapshots(userId: string): Promise<NamespaceAdmissionSnapshot[]> {
  const [roleContext, admissions] = await Promise.all([
    fetchUserNamespaceRoleContext(userId),
    fetchNamespaceAdmissions(userId),
  ])

  const namespaces = new Set<string>([
    ...roleContext.controlledNamespaces,
    ...admissions.keys(),
  ])

  return uniqueSorted(namespaces).map((namespace) => {
    const record = admissions.get(namespace)
    const enabled = admissionsTableUnavailable ? roleContext.isAdmin || roleContext.controlledNamespaces.includes(namespace) : record?.enabled === true
    const hasRole = roleContext.controlledNamespaces.includes(namespace)
    return {
      namespace,
      enabled,
      effective: roleContext.isAdmin || (enabled && hasRole),
      hasRole,
      source: record?.source ?? null,
      grantedBy: record?.granted_by ?? null,
      updatedBy: record?.updated_by ?? null,
      createdAt: record?.created_at ?? null,
      updatedAt: record?.updated_at ?? null,
    }
  })
}

export async function userHasEffectiveNamespaceAccess(userId: string, namespace: string): Promise<boolean> {
  const normalizedNamespace = normalizeNamespace(namespace)
  if (!normalizedNamespace) return false

  const [roleContext, admissions] = await Promise.all([
    fetchUserNamespaceRoleContext(userId),
    fetchNamespaceAdmissions(userId),
  ])

  if (roleContext.isAdmin) return true
  if (!roleContext.controlledNamespaces.includes(normalizedNamespace)) return false
  if (admissionsTableUnavailable) return true
  return admissions.get(normalizedNamespace)?.enabled === true
}

export async function isPermissionAllowedByNamespaceAdmission(userId: string, permissionCode: string): Promise<boolean> {
  const namespace = derivePermissionNamespace(permissionCode)
  if (!namespace) return true
  return userHasEffectiveNamespaceAccess(userId, namespace)
}

export async function filterPermissionCodesByNamespaceAdmission(userId: string, permissionCodes: string[]): Promise<string[]> {
  const normalizedCodes = Array.from(new Set(
    permissionCodes
      .map((code) => normalizeString(code))
      .filter(Boolean),
  ))
  if (normalizedCodes.length === 0) return []

  const [roleContext, admissions] = await Promise.all([
    fetchUserNamespaceRoleContext(userId),
    fetchNamespaceAdmissions(userId),
  ])

  if (roleContext.isAdmin) return normalizedCodes
  if (admissionsTableUnavailable) return normalizedCodes

  return normalizedCodes.filter((permissionCode) => {
    const namespace = derivePermissionNamespace(permissionCode)
    if (!namespace) return true
    return roleContext.controlledNamespaces.includes(namespace) && admissions.get(namespace)?.enabled === true
  })
}

export async function setUserNamespaceAdmission(options: {
  userId: string
  namespace: string
  enabled: boolean
  actorId?: string | null
  source?: string | null
}): Promise<NamespaceAdmissionSnapshot[]> {
  const userId = normalizeString(options.userId)
  const namespace = normalizeNamespace(options.namespace)
  if (!userId) throw new Error('userId is required')
  if (!namespace) throw new Error('namespace is required')

  await query(
    `INSERT INTO user_namespace_admissions
       (user_id, namespace, enabled, source, granted_by, updated_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (user_id, namespace)
     DO UPDATE SET
       enabled = EXCLUDED.enabled,
       source = EXCLUDED.source,
       granted_by = CASE
         WHEN EXCLUDED.enabled THEN EXCLUDED.granted_by
         ELSE user_namespace_admissions.granted_by
       END,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [
      userId,
      namespace,
      options.enabled,
      options.source ?? 'platform_admin',
      options.enabled ? options.actorId ?? null : null,
      options.actorId ?? null,
    ],
  )

  return listUserNamespaceAdmissionSnapshots(userId)
}

export async function disableNamespaceAdmissionsWithoutRoles(options: {
  userId: string
  namespaces: string[]
  actorId?: string | null
  source?: string | null
}): Promise<string[]> {
  const userId = normalizeString(options.userId)
  if (!userId) return []

  const disabledNamespaces: string[] = []
  for (const namespace of uniqueSorted(options.namespaces.map((item) => normalizeNamespace(item)))) {
    if (!namespace) continue
    if (await userHasNamespaceRole(userId, namespace)) continue

    await query(
      `UPDATE user_namespace_admissions
       SET enabled = FALSE,
           source = $3,
           updated_by = $4,
           updated_at = NOW()
       WHERE user_id = $1
         AND namespace = $2
         AND enabled = TRUE`,
      [userId, namespace, options.source ?? 'role_unassigned', options.actorId ?? null],
    )
    disabledNamespaces.push(namespace)
  }

  return disabledNamespaces
}
