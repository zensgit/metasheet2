/**
 * Extracted permission derivation functions for testability.
 *
 * These pure functions compute field and view permissions from
 * base capabilities + optional scoped permission maps.
 */

export type MultitableCapabilities = {
  canRead: boolean
  canEditRecord: boolean
  canCreateRecord: boolean
  canManageViews: boolean
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

export type ViewPermissionScope = {
  hasAssignments: boolean
  canRead: boolean
  canWrite: boolean
  canAdmin: boolean
}

export type FieldPermissionScope = {
  visible: boolean
  readOnly: boolean
}

export type RecordPermissionScope = {
  recordId: string
  accessLevel: 'read' | 'write' | 'admin'
}

export type MultitableRecordPermission = {
  canRead: boolean
  canEdit: boolean
  canDelete: boolean
}

export type FieldLike = {
  id: string
  type: string
  property?: Record<string, unknown>
}

export function isFieldAlwaysReadOnly(field: Pick<FieldLike, 'type' | 'property'>): boolean {
  if (field.type === 'formula' || field.type === 'lookup' || field.type === 'rollup') return true
  const property = field.property ?? {}
  return property.readonly === true || property.readOnly === true
}

export function isFieldPermissionHidden(field: Pick<FieldLike, 'property'>): boolean {
  const property = field.property ?? {}
  if (property.hidden === true) return true
  if (typeof property.visible === 'boolean' && !property.visible) return true
  return false
}

export function deriveFieldPermissions(
  fields: FieldLike[],
  capabilities: Pick<MultitableCapabilities, 'canEditRecord' | 'canCreateRecord'>,
  opts?: { hiddenFieldIds?: string[]; allowCreateOnly?: boolean; fieldScopeMap?: Map<string, FieldPermissionScope> },
): Record<string, MultitableFieldPermission> {
  const hiddenFieldIds = new Set(opts?.hiddenFieldIds ?? [])
  const readOnly = opts?.allowCreateOnly ? !capabilities.canCreateRecord : !capabilities.canEditRecord
  const fieldScopeMap = opts?.fieldScopeMap
  return Object.fromEntries(
    fields.map((field) => {
      const baseVisible = !hiddenFieldIds.has(field.id) && !isFieldPermissionHidden(field)
      const baseReadOnly = readOnly || isFieldAlwaysReadOnly(field)
      const scope = fieldScopeMap?.get(field.id)
      return [
        field.id,
        {
          visible: baseVisible && (scope?.visible ?? true),
          readOnly: baseReadOnly || (scope?.readOnly ?? false),
        },
      ]
    }),
  )
}

export function deriveViewPermissions(
  views: Array<{ id: string }>,
  capabilities: Pick<MultitableCapabilities, 'canRead' | 'canManageViews'>,
  viewScopeMap?: Map<string, ViewPermissionScope>,
): Record<string, MultitableViewPermission> {
  return Object.fromEntries(
    views.map((view) => {
      const scope = viewScopeMap?.get(view.id)
      if (scope?.hasAssignments) {
        return [
          view.id,
          {
            canAccess: capabilities.canRead && scope.canRead,
            canConfigure: capabilities.canManageViews && scope.canWrite,
            canDelete: capabilities.canManageViews && scope.canAdmin,
          },
        ]
      }
      return [
        view.id,
        {
          canAccess: capabilities.canRead,
          canConfigure: capabilities.canManageViews,
          canDelete: capabilities.canManageViews,
        },
      ]
    }),
  )
}

export function deriveRecordPermissions(
  recordId: string,
  capabilities: Pick<MultitableCapabilities, 'canRead' | 'canEditRecord'>,
  recordScopeMap?: Map<string, RecordPermissionScope>,
): MultitableRecordPermission {
  const scope = recordScopeMap?.get(recordId)
  if (!scope) {
    return {
      canRead: capabilities.canRead,
      canEdit: capabilities.canEditRecord,
      canDelete: capabilities.canEditRecord,
    }
  }
  return {
    canRead: capabilities.canRead && (scope.accessLevel === 'read' || scope.accessLevel === 'write' || scope.accessLevel === 'admin'),
    canEdit: capabilities.canEditRecord && (scope.accessLevel === 'write' || scope.accessLevel === 'admin'),
    canDelete: capabilities.canEditRecord && scope.accessLevel === 'admin',
  }
}
