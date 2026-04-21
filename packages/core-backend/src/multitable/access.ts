import type { Request } from 'express'

import { isAdmin, listUserPermissions } from '../rbac/service'

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

export type MultitableFieldPermission = {
  visible: boolean
  readOnly: boolean
}

export type MultitableViewPermission = {
  canAccess: boolean
  canConfigure: boolean
  canDelete: boolean
}

export type MultitableRowActions = {
  canEdit: boolean
  canDelete: boolean
  canComment: boolean
}

export function normalizePermissionCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
}

export type ResolvedRequestAccess = {
  userId: string
  permissions: string[]
  isAdminRole: boolean
}

export async function resolveRequestAccess(
  req: Request,
): Promise<ResolvedRequestAccess> {
  const userId =
    req.user?.id?.toString() ??
    req.user?.sub?.toString() ??
    req.user?.userId?.toString() ??
    ''
  const tokenRoles = normalizePermissionCodes(req.user?.roles)
  const tokenPerms = normalizePermissionCodes(req.user?.perms)
  const resolvedPermissions = normalizePermissionCodes(
    (req.user as { permissions?: unknown } | undefined)?.permissions,
  )
  const role = typeof req.user?.role === 'string' ? req.user.role.trim() : ''
  const isAdminRole = role === 'admin' || tokenRoles.includes('admin')
  const directPermissions = tokenPerms.length > 0 ? tokenPerms : resolvedPermissions
  if (!userId) {
    return { userId, permissions: directPermissions, isAdminRole }
  }

  if (isAdminRole) {
    return { userId, permissions: directPermissions, isAdminRole: true }
  }

  if (directPermissions.length > 0) {
    return { userId, permissions: directPermissions, isAdminRole: false }
  }

  return {
    userId,
    permissions: await listUserPermissions(userId),
    isAdminRole: await isAdmin(userId),
  }
}

export function hasPermission(permissions: string[], code: string): boolean {
  if (permissions.includes(code)) return true
  const [resource] = code.split(':')
  return permissions.includes(`${resource}:*`) || permissions.includes('*:*')
}

export function deriveCapabilities(
  permissions: string[],
  isAdminRole: boolean,
): MultitableCapabilities {
  const canRead =
    isAdminRole ||
    hasPermission(permissions, 'multitable:read') ||
    hasPermission(permissions, 'multitable:write')
  const canWrite = isAdminRole || hasPermission(permissions, 'multitable:write')
  const canManageSheetAccess =
    isAdminRole || hasPermission(permissions, 'multitable:share')
  const canComment =
    isAdminRole ||
    hasPermission(permissions, 'comments:write') ||
    hasPermission(permissions, 'comments:read')
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

export function deriveFieldPermissions(
  fields: Array<{ id: string }>,
  capabilities: MultitableCapabilities,
  opts?: { hiddenFieldIds?: string[]; allowCreateOnly?: boolean },
): Record<string, MultitableFieldPermission> {
  const hiddenFieldIds = new Set(opts?.hiddenFieldIds ?? [])
  const readOnly = opts?.allowCreateOnly
    ? !capabilities.canCreateRecord
    : !capabilities.canEditRecord
  return Object.fromEntries(
    fields.map((field) => [
      field.id,
      {
        visible: !hiddenFieldIds.has(field.id),
        readOnly,
      },
    ]),
  )
}

export function deriveViewPermissions(
  views: Array<Pick<MultitableViewPermission & { id: string }, 'id'>>,
  capabilities: MultitableCapabilities,
): Record<string, MultitableViewPermission> {
  return Object.fromEntries(
    views.map((view) => [
      view.id,
      {
        canAccess: capabilities.canRead,
        canConfigure: capabilities.canManageViews,
        canDelete: capabilities.canManageViews,
      },
    ]),
  )
}

export function deriveRowActions(
  capabilities: MultitableCapabilities,
): MultitableRowActions {
  return {
    canEdit: capabilities.canEditRecord,
    canDelete: capabilities.canDeleteRecord,
    canComment: capabilities.canComment,
  }
}
