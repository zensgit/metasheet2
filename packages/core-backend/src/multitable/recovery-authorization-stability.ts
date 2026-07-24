import type { Request } from 'express'

import {
  normalizePermissionCodes,
  resolveRequestAccess,
  type MultitableCapabilities,
  type ResolvedRequestAccess,
} from './access'
import {
  resolveSheetCapabilitiesForAccess,
  type MultitableCapabilityOrigin,
  type QueryFn,
  type SheetPermissionScope,
} from './permission-service'

const AUTHORITY_LOCK_FUNCTION = 'metasheet_lock_recovery_authority_user'
const AUTHORITY_ROLE_LOCK_FUNCTION = 'metasheet_lock_recovery_authority_role'
const AUTHORITY_GROUP_LOCK_FUNCTION = 'metasheet_lock_recovery_authority_group'

export class RecoveryAuthorityUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryAuthorityUnavailableError'
  }
}

function isUndefinedFunctionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42883'
}

function intersectCapabilities(
  requestCapabilities: MultitableCapabilities,
  databaseCapabilities: MultitableCapabilities,
): MultitableCapabilities {
  return {
    canRead: requestCapabilities.canRead && databaseCapabilities.canRead,
    canCreateRecord: requestCapabilities.canCreateRecord && databaseCapabilities.canCreateRecord,
    canEditRecord: requestCapabilities.canEditRecord && databaseCapabilities.canEditRecord,
    canDeleteRecord: requestCapabilities.canDeleteRecord && databaseCapabilities.canDeleteRecord,
    canManageFields: requestCapabilities.canManageFields && databaseCapabilities.canManageFields,
    canManageSheetAccess: requestCapabilities.canManageSheetAccess && databaseCapabilities.canManageSheetAccess,
    canManageViews: requestCapabilities.canManageViews && databaseCapabilities.canManageViews,
    canComment: requestCapabilities.canComment && databaseCapabilities.canComment,
    canManageAutomation: requestCapabilities.canManageAutomation && databaseCapabilities.canManageAutomation,
    canExport: requestCapabilities.canExport && databaseCapabilities.canExport,
    canSendNotification: requestCapabilities.canSendNotification && databaseCapabilities.canSendNotification,
  }
}

const DENIED_CAPABILITIES: MultitableCapabilities = {
  canRead: false,
  canCreateRecord: false,
  canEditRecord: false,
  canDeleteRecord: false,
  canManageFields: false,
  canManageSheetAccess: false,
  canManageViews: false,
  canComment: false,
  canManageAutomation: false,
  canExport: false,
  canSendNotification: false,
}

/**
 * Acquire the DB-enforced per-user authority locks used by RBAC and member-directory writers, then
 * lock every role and member group currently assigned to those users. This covers both the recovery
 * actor and person values whose sheet-member eligibility can be inherited from role or group grants.
 * Assignments are frozen by the user locks before either list is read; sorted keys give multi-person
 * recovery one global user-then-role-then-group order.
 */
export async function lockRecoveryAuthorityUsers(query: QueryFn, userIds: Iterable<string>): Promise<void> {
  const ids = Array.from(
    new Set(Array.from(userIds).map((id) => id.trim()).filter(Boolean)),
  ).sort()
  if (ids.length === 0) return
  try {
    await query(
      `SELECT ${AUTHORITY_LOCK_FUNCTION}(user_id)
         FROM unnest($1::text[]) AS users(user_id)
        ORDER BY user_id`,
      [ids],
    )
  } catch (error) {
    if (isUndefinedFunctionError(error)) {
      throw new RecoveryAuthorityUnavailableError('recovery authority lock migration is missing')
    }
    throw error
  }

  const assignedRoles = await query(
    `SELECT DISTINCT role_id
       FROM user_roles
      WHERE user_id = ANY($1::text[])
      ORDER BY role_id`,
    [ids],
  )
  await lockRecoveryAuthorityRoles(
    query,
    (assignedRoles.rows as Array<{ role_id?: unknown }>)
      .map((row) => (typeof row.role_id === 'string' ? row.role_id : ''))
      .filter(Boolean),
  )

  const assignedGroups = await query(
    `SELECT DISTINCT group_id::text AS group_id
       FROM platform_member_group_members
      WHERE user_id = ANY($1::text[])
      ORDER BY group_id::text`,
    [ids],
  )
  await lockRecoveryAuthorityGroups(
    query,
    (assignedGroups.rows as Array<{ group_id?: unknown }>)
      .map((row) => (typeof row.group_id === 'string' ? row.group_id : ''))
      .filter(Boolean),
  )
}

async function lockRecoveryAuthorityRoles(query: QueryFn, roleIds: Iterable<string>): Promise<void> {
  const ids = Array.from(
    new Set(Array.from(roleIds).map((id) => id.trim()).filter(Boolean)),
  ).sort()
  if (ids.length === 0) return
  try {
    await query(
      `SELECT ${AUTHORITY_ROLE_LOCK_FUNCTION}(role_id)
         FROM unnest($1::text[]) AS roles(role_id)
        ORDER BY role_id`,
      [ids],
    )
  } catch (error) {
    if (isUndefinedFunctionError(error)) {
      throw new RecoveryAuthorityUnavailableError('recovery authority role lock migration is missing')
    }
    throw error
  }
}

async function lockRecoveryAuthorityGroups(query: QueryFn, groupIds: Iterable<string>): Promise<void> {
  const ids = Array.from(
    new Set(Array.from(groupIds).map((id) => id.trim()).filter(Boolean)),
  ).sort()
  if (ids.length === 0) return
  try {
    await query(
      `SELECT ${AUTHORITY_GROUP_LOCK_FUNCTION}(group_id)
         FROM unnest($1::text[]) AS groups(group_id)
        ORDER BY group_id`,
      [ids],
    )
  } catch (error) {
    if (isUndefinedFunctionError(error)) {
      throw new RecoveryAuthorityUnavailableError('recovery authority group lock migration is missing')
    }
    throw error
  }
}

/**
 * Read the actor's current database authority without the process-wide RBAC cache or JWT claims.
 * `multitable`, `spreadsheet(s)`, and `workflow` are non-namespaced resources, so the namespace
 * admission filter cannot change any capability used by exact-anchor recovery.
 */
export async function loadDatabaseFreshRecoveryAccess(
  query: QueryFn,
  userId: string,
): Promise<ResolvedRequestAccess> {
  const normalizedUserId = userId.trim()
  if (!normalizedUserId) return { userId: '', permissions: [], isAdminRole: false }

  const userResult = await query(
    `SELECT role, permissions, COALESCE(is_active, TRUE) AS is_active,
            EXISTS (
              SELECT 1 FROM user_roles
               WHERE user_id = $1 AND role_id = 'admin'
            ) AS rbac_admin
       FROM users
      WHERE id = $1`,
    [normalizedUserId],
  )
  const user = userResult.rows[0] as {
    role?: unknown
    permissions?: unknown
    is_active?: unknown
    rbac_admin?: unknown
  } | undefined
  if (!user || user.is_active === false || user.role === 'disabled') {
    return { userId: normalizedUserId, permissions: [], isAdminRole: false }
  }

  // The user lock above freezes role assignment. Lock each assigned role before reading its grants;
  // role_permissions writers acquire the same role keys, so a revoke cannot cross this final read.
  const assignedRoleResult = await query(
    'SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id',
    [normalizedUserId],
  )
  const assignedRoleIds = (assignedRoleResult.rows as Array<{ role_id?: unknown }>)
    .map((row) => (typeof row.role_id === 'string' ? row.role_id : ''))
    .filter(Boolean)
  await lockRecoveryAuthorityRoles(query, assignedRoleIds)

  const permissionResult = await query(
    `SELECT DISTINCT permission_code AS code
       FROM (
         SELECT permission_code
           FROM user_permissions
          WHERE user_id = $1
         UNION ALL
         SELECT rp.permission_code
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
          WHERE ur.user_id = $1
       ) AS effective_permissions`,
    [normalizedUserId],
  )
  const rbacPermissions = (permissionResult.rows as Array<{ code?: unknown }>)
    .map((row) => (typeof row.code === 'string' ? row.code : ''))
    .filter(Boolean)
  const legacyPermissions = Array.isArray(user.permissions)
    ? normalizePermissionCodes(user.permissions)
    : []

  return {
    userId: normalizedUserId,
    permissions: Array.from(new Set([...rbacPermissions, ...legacyPermissions])),
    isAdminRole: user.role === 'admin' || user.rbac_admin === true,
  }
}

export type RecoverySheetAuthority = {
  access: ResolvedRequestAccess
  capabilities: MultitableCapabilities
  capabilityOrigin: MultitableCapabilityOrigin
  sheetScope?: SheetPermissionScope
}

/**
 * Resolve recovery authority as the intersection of request claims and transaction-fresh database
 * authority. Current sheet-scoped grants are evaluated by the shared policy resolver on both sides;
 * a fresh grant may therefore work normally, while a stale global/admin claim can never widen access.
 */
export async function resolveRecoverySheetAuthority(
  req: Request,
  query: QueryFn,
  sheetId: string,
): Promise<RecoverySheetAuthority> {
  const requestAccess = await resolveRequestAccess(req)
  if (!requestAccess.userId) {
    return {
      access: requestAccess,
      capabilities: DENIED_CAPABILITIES,
      capabilityOrigin: { source: 'global-rbac', hasSheetAssignments: false },
    }
  }

  await lockRecoveryAuthorityUsers(query, [requestAccess.userId])
  const databaseAccess = await loadDatabaseFreshRecoveryAccess(query, requestAccess.userId)
  const [requestResolved, databaseResolved] = await Promise.all([
    resolveSheetCapabilitiesForAccess(query, sheetId, requestAccess),
    resolveSheetCapabilitiesForAccess(query, sheetId, databaseAccess),
  ])
  const access: ResolvedRequestAccess = {
    userId: requestAccess.userId,
    permissions: databaseAccess.permissions,
    isAdminRole: requestAccess.isAdminRole && databaseAccess.isAdminRole,
  }
  return {
    access,
    capabilities: intersectCapabilities(requestResolved.capabilities, databaseResolved.capabilities),
    capabilityOrigin: databaseResolved.capabilityOrigin,
    ...(databaseResolved.sheetScope ? { sheetScope: databaseResolved.sheetScope } : {}),
  }
}
