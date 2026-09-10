import {
  deriveElearningProjectionBaseId,
  deriveElearningProjectionSheetId,
  ELEARNING_PROJECTION_SYSTEM_KIND,
  ELEARNING_STATS_MULTITABLE_SHEETS_TABLE,
  hasElearningProjectionAdminAuthority,
  isElearningProjectionBaseIdCandidate,
  isElearningProjectionSheetIdCandidate,
} from './elearning-projection-constants'

export type ElearningProjectionQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export interface ElearningProjectionAccess {
  authenticatedTenantId?: string
  isAdminRole: boolean
  permissions: readonly string[]
}

function isUndefinedTable(error: unknown, tableName: string): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null
  return candidate?.code === '42P01'
    && typeof candidate.message === 'string'
    && candidate.message.includes(tableName)
}

function canonicalText(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) return null
  return value
}

export async function loadElearningProjectionSheetOrgMap(
  query: ElearningProjectionQuery,
  sheetIds: readonly string[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(sheetIds
    .map((id) => id.trim())
    .filter(isElearningProjectionSheetIdCandidate))]
  if (ids.length === 0) return new Map()
  const map = new Map<string, string | null>(ids.map((id) => [id, null]))
  try {
    const mappings = await query(
      `SELECT sheet_id, org_id
         FROM ${ELEARNING_STATS_MULTITABLE_SHEETS_TABLE}
        WHERE sheet_id = ANY($1::text[])`,
      [ids],
    )
    for (const row of mappings.rows as Array<{ sheet_id?: unknown; org_id?: unknown }>) {
      const sheetId = canonicalText(row.sheet_id)
      const orgId = canonicalText(row.org_id)
      if (sheetId && ids.includes(sheetId)) map.set(sheetId, orgId)
    }
    const mappedIds = [...map]
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([sheetId]) => sheetId)
    if (mappedIds.length === 0) return map
    const systemSheets = await query(
      `SELECT id
         FROM meta_sheets sheet
        WHERE sheet.id = ANY($1::text[])
          AND to_jsonb(sheet) ->> 'system_kind' = $2`,
      [mappedIds, ELEARNING_PROJECTION_SYSTEM_KIND],
    )
    const validIds = new Set(
      (systemSheets.rows as Array<{ id?: unknown }>)
        .map((row) => canonicalText(row.id))
        .filter((id): id is string => id !== null),
    )
    for (const id of map.keys()) {
      if (!validIds.has(id)) map.set(id, null)
    }
    return map
  } catch (error) {
    if (isUndefinedTable(error, ELEARNING_STATS_MULTITABLE_SHEETS_TABLE)) return map
    throw error
  }
}

export async function loadElearningProjectionBaseOrg(
  query: ElearningProjectionQuery,
  baseId: string,
): Promise<{ isProjection: boolean; orgId: string | null }> {
  const normalized = baseId.trim()
  if (!normalized) return { isProjection: false, orgId: null }
  if (!isElearningProjectionBaseIdCandidate(normalized)) {
    return { isProjection: false, orgId: null }
  }
  try {
    const mapping = await query(
      `SELECT org_id, sheet_id
         FROM ${ELEARNING_STATS_MULTITABLE_SHEETS_TABLE}
        WHERE base_id = $1`,
      [normalized],
    )
    if (mapping.rows.length === 0) return { isProjection: true, orgId: null }
    if (mapping.rows.length !== 1) return { isProjection: true, orgId: null }
    const orgId = canonicalText((mapping.rows[0] as { org_id?: unknown }).org_id)
    const sheetId = canonicalText((mapping.rows[0] as { sheet_id?: unknown }).sheet_id)
    if (!orgId || !sheetId) return { isProjection: true, orgId: null }
    const systemSheet = await query(
      `SELECT id
         FROM meta_sheets sheet
        WHERE sheet.id = $1
          AND sheet.base_id = $2
          AND to_jsonb(sheet) ->> 'system_kind' = $3`,
      [sheetId, normalized, ELEARNING_PROJECTION_SYSTEM_KIND],
    )
    return {
      isProjection: true,
      orgId: systemSheet.rows.length === 1 ? orgId : null,
    }
  } catch (error) {
    if (isUndefinedTable(error, ELEARNING_STATS_MULTITABLE_SHEETS_TABLE)) {
      return { isProjection: true, orgId: null }
    }
    throw error
  }
}

export function canAccessElearningProjectionSheet(
  access: ElearningProjectionAccess,
  sheetId: string,
  mappedOrgId: string | null,
): boolean {
  if (!mappedOrgId || !hasElearningProjectionAdminAuthority(
    access.permissions,
    access.isAdminRole,
  )) return false
  if (access.isAdminRole) return sheetId === deriveElearningProjectionSheetId(mappedOrgId)
  const tenantId = canonicalText(access.authenticatedTenantId)
  return tenantId === mappedOrgId
    && sheetId === deriveElearningProjectionSheetId(mappedOrgId)
}

export function canAccessElearningProjectionBase(
  access: ElearningProjectionAccess,
  baseId: string,
  mappedOrgId: string | null,
): boolean {
  if (!mappedOrgId || !hasElearningProjectionAdminAuthority(
    access.permissions,
    access.isAdminRole,
  )) return false
  if (access.isAdminRole) return baseId === deriveElearningProjectionBaseId(mappedOrgId)
  const tenantId = canonicalText(access.authenticatedTenantId)
  return tenantId === mappedOrgId
    && baseId === deriveElearningProjectionBaseId(mappedOrgId)
}
