import { isSystemFieldType } from './field-codecs'

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
  // #18 read-deny FOUNDATION: 'none' is a read-deny grant (enforced only when the per-sheet flag is on).
  accessLevel: 'read' | 'write' | 'admin' | 'none'
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
  if (isSystemFieldType(field.type)) return true
  const property = field.property ?? {}
  // Bidirectional / mirror links (design 2026-06-14) — the DERIVED (mirror) side is always read-only,
  // independent of the property-load path (codec injects readOnly:true, but a raw / SQL-seeded field may
  // lack it). Keying directly on `mirrorOf` makes BOTH write services reject a PATCH on the mirror, so the
  // single canonical meta_links edge can never gain a second materialized row (the spine invariant).
  if (typeof property.mirrorOf === 'string' && property.mirrorOf.length > 0) return true
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

/**
 * W1-3 (multitable-per-subject-field-write-gate-w13-designlock-20260705, LOCK-F2): the ONE-LINE
 * invariant every layer-3 per-subject field-WRITE gate rejects on — extracted as a tiny pure helper so
 * the two W1-3 write paths (the Yjs bridge write-input builder in `index.ts`, and the single-record
 * `PATCH /records/:recordId` handler in `routes/univer-meta.ts`) and the pre-existing route-level gates
 * all reference the SAME predicate rather than re-typing it. `perm` comes from `deriveFieldPermissions`
 * (every VISIBLE field gets an entry, permissive by default absent a scope row) — so `!perm` means the
 * field is not in the visible-field set at all (hidden / unknown), never a false block of a normal field.
 *
 * Deliberately predicate-ONLY: the surrounding gate FLOW differs per call site (caller-submitted field
 * ids that may be echoed back vs. server-derived ids that must stay generalized to avoid an existence
 * oracle) and is intentionally NOT unified — only this invariant is shared.
 */
export function isFieldWriteForbidden(perm: MultitableFieldPermission | undefined): boolean {
  return !perm || perm.visible === false || perm.readOnly === true
}

/**
 * W1-3 F4: thrown by a write-input BUILDER (no HTTP response of its own — currently only the Yjs bridge)
 * when `isFieldWriteForbidden` rejects one or more changed fields. Deliberately coarse — values-free, no
 * field values, no field ids beyond this fixed message — because the only consumer is a generic
 * catch/log/metric handler (`YjsRecordBridge`'s `flushNow` `.catch`), not a route that reasons about
 * per-field-id leak safety the way `sendForbidden(...)` call sites do. MUST be thrown, never signaled by
 * returning null/false: a null-shaped "no write" return is indistinguishable from other benign no-op
 * reasons (e.g. a deleted record) and would make the denial invisible to both success and failure
 * metrics — see the design-lock's F4 rationale.
 */
export class FieldWritePermissionDeniedError extends Error {
  constructor(message = 'One or more changed fields are not writable for this user') {
    super(message)
    this.name = 'FieldWritePermissionDeniedError'
  }
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
  // #18 read-deny FOUNDATION: when true (caller passes the sheet's row_level_read_permissions_enabled),
  // a 'none' scope DENIES read. Default false → 'none' is inert (no read path passes this yet), so the
  // model stays grant-ADDITIVE (#2787) and behavior is byte-identical to today.
  rowLevelReadDenyEnabled = false,
): MultitableRecordPermission {
  const scope = recordScopeMap?.get(recordId)
  if (!scope) {
    return {
      canRead: capabilities.canRead,
      canEdit: capabilities.canEditRecord,
      canDelete: capabilities.canEditRecord,
    }
  }
  // Read stays grant-additive: a read/write/admin grant never reduces the sheet-level canRead. ONLY an
  // ACTIVE 'none' (flag on) subtracts read. Write/delete are unchanged (a 'none' grants neither).
  const readDeniedByNone = scope.accessLevel === 'none' && rowLevelReadDenyEnabled
  return {
    canRead: capabilities.canRead && !readDeniedByNone,
    canEdit: capabilities.canEditRecord && (scope.accessLevel === 'write' || scope.accessLevel === 'admin'),
    canDelete: capabilities.canEditRecord && scope.accessLevel === 'admin',
  }
}
