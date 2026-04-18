/**
 * Shared sheet capability resolution — used by both REST routes and Yjs bridge.
 *
 * Extracted from univer-meta.ts to avoid duplicating permission logic.
 */

import { listUserPermissions, isAdmin } from '../rbac/service'

// ── Permission code sets ────────────────────────────────────────────

export const SHEET_READ_PERMISSION_CODES = new Set([
  'spreadsheet:read', 'spreadsheet:write', 'spreadsheet:write-own', 'spreadsheet:admin',
  'spreadsheets:read', 'spreadsheets:write', 'spreadsheets:write-own', 'spreadsheets:admin',
  'multitable:read', 'multitable:write', 'multitable:write-own', 'multitable:admin',
])

export const SHEET_WRITE_PERMISSION_CODES = new Set([
  'spreadsheet:write', 'spreadsheet:admin',
  'spreadsheets:write', 'spreadsheets:admin',
  'multitable:write', 'multitable:admin',
])

export const SHEET_OWN_WRITE_PERMISSION_CODES = new Set([
  'spreadsheet:write-own', 'spreadsheets:write-own', 'multitable:write-own',
])

export const SHEET_ADMIN_PERMISSION_CODES = new Set([
  'spreadsheet:admin', 'spreadsheets:admin', 'multitable:admin',
])

// ── Types ───────────────────────────────────────────────────────────

export type MultitableCapabilities = {
  canRead: boolean
  canCreateRecord: boolean
  canEditRecord: boolean
  canDeleteRecord: boolean
  canManageFields: boolean
  canManageSheetAccess: boolean
  canManageViews: boolean
  canComment: boolean
  canManageAutomation: boolean
  canExport: boolean
}

export type SheetPermissionScope = {
  hasAssignments: boolean
  canRead: boolean
  canWrite: boolean
  canWriteOwn: boolean
  canAdmin: boolean
}

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

function isUndefinedTableError(err: unknown, tableName: string): boolean {
  const code = typeof (err as any)?.code === 'string' ? (err as any).code : null
  const message = typeof (err as any)?.message === 'string' ? (err as any).message : ''
  if (code === '42P01') return message.includes(tableName)
  return message.includes(`relation "${tableName}" does not exist`)
}

// ── Functions ───────────────────────────────────────────────────────

export function hasPermission(permissions: string[], code: string): boolean {
  if (permissions.includes(code)) return true
  const [resource] = code.split(':')
  return permissions.includes(`${resource}:*`) || permissions.includes('*:*')
}

export function deriveCapabilities(permissions: string[], isAdminRole: boolean): MultitableCapabilities {
  const canRead = isAdminRole || hasPermission(permissions, 'multitable:read') || hasPermission(permissions, 'multitable:write')
  const canWrite = isAdminRole || hasPermission(permissions, 'multitable:write')
  const canManageSheetAccess = isAdminRole || hasPermission(permissions, 'multitable:share')
  const canComment = isAdminRole || hasPermission(permissions, 'comments:write') || hasPermission(permissions, 'comments:read')
  const canManageAutomation =
    isAdminRole ||
    hasPermission(permissions, 'workflow:all') ||
    hasPermission(permissions, 'workflow:write') ||
    hasPermission(permissions, 'workflow:create') ||
    hasPermission(permissions, 'workflow:execute')

  return {
    canRead,
    canCreateRecord: canWrite,
    canEditRecord: canWrite,
    canDeleteRecord: canWrite,
    canManageFields: canWrite,
    canManageSheetAccess,
    canManageViews: canWrite,
    canComment,
    canManageAutomation,
    canExport: canRead,
  }
}

export function summarizeSheetPermissionCodes(codes: string[]): SheetPermissionScope {
  return {
    hasAssignments: codes.length > 0,
    canRead: codes.some((code) => SHEET_READ_PERMISSION_CODES.has(code)),
    canWrite: codes.some((code) => SHEET_WRITE_PERMISSION_CODES.has(code)),
    canWriteOwn: codes.some((code) => SHEET_OWN_WRITE_PERMISSION_CODES.has(code)),
    canAdmin: codes.some((code) => SHEET_ADMIN_PERMISSION_CODES.has(code)),
  }
}

function applyContextSheetReadGrant(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilities {
  if (isAdminRole || !scope?.hasAssignments) return capabilities
  if (scope.canRead) return { ...capabilities, canRead: true, canExport: true }
  return capabilities
}

function applyContextSheetRecordWriteGrant(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilities {
  const scoped = applyContextSheetReadGrant(capabilities, scope, isAdminRole)
  if (isAdminRole || !scope?.hasAssignments) return scoped
  const canWriteAnyRecord = scope.canRead && (scope.canWrite || scope.canWriteOwn)
  if (!canWriteAnyRecord) return scoped
  return {
    ...scoped,
    canCreateRecord: true,
    canEditRecord: true,
    canDeleteRecord: true,
  }
}

export function applyContextSheetSchemaWriteGrant(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilities {
  const scoped = applyContextSheetRecordWriteGrant(capabilities, scope, isAdminRole)
  if (isAdminRole || !scope?.hasAssignments) return scoped
  const canManageSchema = scope.canRead && scope.canWrite
  if (!canManageSchema) return scoped
  return {
    ...scoped,
    canManageFields: true,
    canManageViews: true,
    ...(scope.canAdmin ? { canManageSheetAccess: true } : {}),
  }
}

export async function loadSheetPermissionScopeMap(
  query: QueryFn,
  sheetIds: string[],
  userId: string,
): Promise<Map<string, SheetPermissionScope>> {
  if (!userId || sheetIds.length === 0) return new Map()
  try {
    const result = await query(
      `SELECT sp.sheet_id, sp.perm_code, sp.subject_type
       FROM spreadsheet_permissions sp
       WHERE sp.sheet_id = ANY($2::text[])
         AND (
           (sp.subject_type = 'user' AND sp.subject_id = $1)
           OR (
             sp.subject_type = 'member-group'
             AND EXISTS (
               SELECT 1
               FROM platform_member_group_members pgm
               WHERE pgm.user_id = $1
                 AND pgm.group_id::text = sp.subject_id
             )
           )
           OR (
             sp.subject_type = 'role'
             AND EXISTS (
               SELECT 1
               FROM user_roles ur
               WHERE ur.user_id = $1
                 AND ur.role_id = sp.subject_id
             )
           )
         )`,
      [userId, sheetIds],
    )
    const grouped = new Map<string, { direct: string[]; memberGroup: string[]; role: string[] }>()
    for (const row of result.rows as Array<{ sheet_id: string; perm_code: string; subject_type?: string }>) {
      const sheetId = typeof row.sheet_id === 'string' ? row.sheet_id : ''
      const code = typeof row.perm_code === 'string' ? row.perm_code.trim() : ''
      if (!sheetId || !code) continue
      const current = grouped.get(sheetId) ?? { direct: [], memberGroup: [], role: [] }
      if (row.subject_type === 'user') current.direct.push(code)
      else if (row.subject_type === 'member-group') current.memberGroup.push(code)
      else current.role.push(code)
      grouped.set(sheetId, current)
    }
    return new Map(
      Array.from(grouped.entries()).map(([sheetId, codes]) => [
        sheetId,
        summarizeSheetPermissionCodes(
          codes.direct.length > 0 ? codes.direct
            : codes.memberGroup.length > 0 ? codes.memberGroup
              : codes.role,
        ),
      ]),
    )
  } catch (err) {
    if (
      isUndefinedTableError(err, 'spreadsheet_permissions')
      || isUndefinedTableError(err, 'user_roles')
      || isUndefinedTableError(err, 'platform_member_group_members')
    ) {
      return new Map()
    }
    throw err
  }
}

/**
 * Resolve full sheet capabilities for a userId without Express req.
 * This is the same logic as resolveSheetCapabilities in univer-meta.ts
 * but decoupled from the HTTP layer.
 */
export async function resolveSheetCapabilitiesForUser(
  query: QueryFn,
  sheetId: string,
  userId: string,
): Promise<{
  capabilities: MultitableCapabilities
  sheetScope?: SheetPermissionScope
  isAdminRole: boolean
  permissions: string[]
}> {
  const isAdminRole = await isAdmin(userId)
  const permissions = await listUserPermissions(userId)
  const baseCapabilities = deriveCapabilities(permissions, isAdminRole)
  const scopeMap = await loadSheetPermissionScopeMap(query, [sheetId], userId)
  const sheetScope = scopeMap.get(sheetId)
  const capabilities = applyContextSheetSchemaWriteGrant(baseCapabilities, sheetScope, isAdminRole)
  return {
    capabilities,
    ...(sheetScope ? { sheetScope } : {}),
    isAdminRole,
    permissions,
  }
}

// ── Record-level own-write enforcement ──────────────────────────────

export type AccessInfo = {
  userId: string
  permissions: string[]
  isAdminRole: boolean
}

/**
 * Whether the sheet scope requires per-record own-write enforcement.
 * True when user has write-own but NOT full write on the sheet.
 */
export function requiresOwnWriteRowPolicy(
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): boolean {
  return !isAdminRole && !!scope?.hasAssignments && scope.canWriteOwn && !scope.canWrite
}

/**
 * Check if a user can edit/delete a specific record, considering own-write policy.
 * This is the same logic as ensureRecordWriteAllowed in univer-meta.ts.
 */
export function ensureRecordWriteAllowed(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  access: AccessInfo,
  createdBy: string | null | undefined,
  action: 'edit' | 'delete',
): boolean {
  if (access.isAdminRole) return true

  if (!requiresOwnWriteRowPolicy(scope, access.isAdminRole)) {
    // No own-write restriction: just check capability
    return action === 'edit' ? capabilities.canEditRecord : capabilities.canDeleteRecord
  }

  // Own-write policy: must be the record creator
  const isCreator = !!createdBy && !!access.userId && createdBy === access.userId
  const capabilityCheck = action === 'edit' ? capabilities.canEditRecord : capabilities.canDeleteRecord
  return capabilityCheck && isCreator
}

/**
 * Check if a user can write to a specific record (for /yjs subscribe gate).
 * Needs the record's created_by to evaluate own-write policy.
 */
export function canWriteRecord(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
  userId: string,
  recordCreatedBy: string | null | undefined,
): boolean {
  if (isAdminRole) return true
  if (!requiresOwnWriteRowPolicy(scope, isAdminRole)) {
    return capabilities.canEditRecord
  }
  return capabilities.canEditRecord && !!recordCreatedBy && recordCreatedBy === userId
}
