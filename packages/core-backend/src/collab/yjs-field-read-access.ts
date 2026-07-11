import {
  deriveFieldPermissions,
  type MultitableCapabilities as FieldPermissionCapabilities,
} from '../multitable/permission-derivation'
import {
  loadFieldPermissionScopeMap,
  type QueryFn,
} from '../multitable/permission-service'

type YjsFieldRow = {
  id: string
  type: string
  property: unknown
}

function normalizeFieldRow(row: YjsFieldRow): {
  id: string
  type: string
  property: Record<string, unknown>
} {
  const property = row.property && typeof row.property === 'object' && !Array.isArray(row.property)
    ? row.property as Record<string, unknown>
    : {}
  return {
    id: String(row.id),
    type: String(row.type),
    property,
  }
}

/**
 * Yjs sync sends a whole record-level Y.Doc, not a field-scoped payload. If the
 * actor cannot read even one field on the sheet, serving that shared document
 * would let denied field values travel over the realtime channel. In that case
 * callers must fail closed and let the client fall back to REST reads, where
 * field-level masking is already applied per response.
 */
export async function canReadEveryYjsFieldForUser(
  query: QueryFn,
  sheetId: string,
  userId: string,
  capabilities: Pick<FieldPermissionCapabilities, 'canEditRecord' | 'canCreateRecord'>,
): Promise<boolean> {
  if (!sheetId || !userId) return false

  const fieldResult = await query(
    'SELECT id, type, property FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
    [sheetId],
  )
  const fields = (fieldResult.rows as YjsFieldRow[]).map(normalizeFieldRow)
  if (fields.length === 0) return true
  if (fields.some((field) => field.property.permissionHidden === true)) return false

  const fieldScopeMap = await loadFieldPermissionScopeMap(query, sheetId, userId)
  const fieldPermissions = deriveFieldPermissions(fields, capabilities, { fieldScopeMap })
  return fields.every((field) => fieldPermissions[field.id]?.visible !== false)
}
