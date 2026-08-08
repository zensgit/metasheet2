import type { QueryFn } from './permission-service'

type LiveLinkRecord = { data: Record<string, unknown> }

export const LIVE_LINK_TARGET_CONSTRAINT = 'meta_links_foreign_record_id_fkey'

export function isLiveLinkTargetForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === '23503'
    && (error as { constraint?: unknown }).constraint === LIVE_LINK_TARGET_CONSTRAINT
}

export function isRetryableLiveLinkDatabaseConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === '40P01' || code === '40001'
}

export interface AuthoritativeLiveLinkEdge {
  fieldId: string
  recordId: string
  foreignRecordId: string
}

export class LiveLinkProjectionDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LiveLinkProjectionDataError'
  }
}

/**
 * Load the effective forward-link relation for one sheet. The joins intentionally match the normal
 * read projection: the source record and field must still belong to the sheet, and dangling targets
 * are omitted. Rows are not deduplicated; a duplicate edge is meaningful corrupt substrate and must
 * remain visible to the identity hash / hydration guard.
 */
export async function loadAuthoritativeLiveLinkEdgesForSheet(
  query: QueryFn,
  sheetId: string,
): Promise<AuthoritativeLiveLinkEdge[]> {
  const res = await query(
    `SELECT l.field_id, l.record_id, l.foreign_record_id
       FROM meta_links l
       JOIN meta_fields f ON f.id = l.field_id AND f.sheet_id = $1
       JOIN meta_records source ON source.id = l.record_id AND source.sheet_id = $1
      WHERE EXISTS (SELECT 1 FROM meta_records target WHERE target.id = l.foreign_record_id)
      ORDER BY l.field_id, l.record_id, l.foreign_record_id, l.id`,
    [sheetId],
  )
  return (res.rows as Array<{ field_id: unknown; record_id: unknown; foreign_record_id: unknown }>).map(
    (row) => ({
      fieldId: String(row.field_id),
      recordId: String(row.record_id),
      foreignRecordId: String(row.foreign_record_id),
    }),
  )
}

/**
 * Build the current live state used by recovery planning with writable forward-link values hydrated
 * from the authoritative `meta_links` relation. `meta_records.data` is not a second authority: normal
 * deletion/repair flows may leave its link-shaped JSON stale while every production read resolves the
 * effective relation from `meta_links`.
 *
 * Dangling targets are omitted exactly like the normal read path. Duplicate authoritative edges are
 * not a meaningful set projection and fail closed instead of being silently collapsed.
 */
export async function hydrateLiveLinkProjection<T extends LiveLinkRecord>(
  query: QueryFn,
  liveById: ReadonlyMap<string, T>,
  writableLinkFieldIds: ReadonlySet<string>,
): Promise<Map<string, T>> {
  const hydrated = new Map<string, T>()
  for (const [recordId, live] of liveById) {
    hydrated.set(recordId, { ...live, data: { ...live.data } })
  }
  if (liveById.size === 0 || writableLinkFieldIds.size === 0) return hydrated

  const recordIds = [...liveById.keys()].sort()
  const fieldIds = [...writableLinkFieldIds].sort()
  const rows = (await query(
    `SELECT record_id, field_id, foreign_record_id
       FROM meta_links
      WHERE record_id = ANY($1::text[])
        AND field_id = ANY($2::text[])
        AND EXISTS (SELECT 1 FROM meta_records target WHERE target.id = foreign_record_id)
      ORDER BY record_id, field_id, foreign_record_id`,
    [recordIds, fieldIds],
  )).rows as Array<{ record_id: unknown; field_id: unknown; foreign_record_id: unknown }>

  const edgeIdsByCell = new Map<string, string[]>()
  const edgeKeys = new Set<string>()
  for (const row of rows) {
    const recordId = String(row.record_id)
    const fieldId = String(row.field_id)
    const foreignRecordId = String(row.foreign_record_id)
    const edgeKey = `${recordId}\u0000${fieldId}\u0000${foreignRecordId}`
    if (edgeKeys.has(edgeKey)) {
      throw new LiveLinkProjectionDataError('duplicate authoritative link edge')
    }
    edgeKeys.add(edgeKey)
    const cellKey = `${recordId}\u0000${fieldId}`
    const ids = edgeIdsByCell.get(cellKey) ?? []
    ids.push(foreignRecordId)
    edgeIdsByCell.set(cellKey, ids)
  }

  for (const [recordId, live] of hydrated) {
    for (const fieldId of fieldIds) {
      const authoritativeIds = [...(edgeIdsByCell.get(`${recordId}\u0000${fieldId}`) ?? [])].sort()
      // Missing and [] are the same link-set value. Preserve the sparse canonical shape for an empty
      // relation so planning does not manufacture an unrelated empty field in a scalar-only write.
      if (authoritativeIds.length === 0) delete live.data[fieldId]
      else live.data[fieldId] = authoritativeIds
    }
  }
  return hydrated
}
