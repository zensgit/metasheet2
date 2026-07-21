import type { QueryFn } from './permission-service'

type LiveLinkRecord = { data: Record<string, unknown> }

function canonicalProjectionLinkIds(value: unknown): string[] | null {
  if (value === null || value === undefined) return []
  const raw = Array.isArray(value) ? value : [value]
  if (raw.some((item) => typeof item !== 'string' || item.trim().length === 0)) return null
  const ids = raw.map((item) => (item as string).trim())
  if (new Set(ids).size !== ids.length) return null
  return ids.sort()
}

function canonicalEdgeIds(value: readonly string[]): string[] {
  return [...value].sort()
}

/**
 * Verify that writable forward-link cells agree with the authoritative meta_links relation.
 * Recovery must not plan from a stale JSON mirror: a mismatch is corrupt live substrate and the
 * caller fails closed before minting or spending a destructive token.
 */
export async function isLiveLinkProjectionConsistent(
  query: QueryFn,
  liveById: ReadonlyMap<string, LiveLinkRecord>,
  writableLinkFieldIds: ReadonlySet<string>,
): Promise<boolean> {
  if (liveById.size === 0 || writableLinkFieldIds.size === 0) return true

  const recordIds = [...liveById.keys()].sort()
  const fieldIds = [...writableLinkFieldIds].sort()
  const rows = (await query(
    `SELECT record_id, field_id, foreign_record_id
       FROM meta_links
      WHERE record_id = ANY($1::text[])
        AND field_id = ANY($2::text[])
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
    if (edgeKeys.has(edgeKey)) return false
    edgeKeys.add(edgeKey)
    const cellKey = `${recordId}\u0000${fieldId}`
    const ids = edgeIdsByCell.get(cellKey) ?? []
    ids.push(foreignRecordId)
    edgeIdsByCell.set(cellKey, ids)
  }

  for (const [recordId, live] of liveById) {
    for (const fieldId of fieldIds) {
      const fromData = canonicalProjectionLinkIds(live.data[fieldId])
      if (!fromData) return false
      const fromEdges = canonicalEdgeIds(edgeIdsByCell.get(`${recordId}\u0000${fieldId}`) ?? [])
      if (fromData.length !== fromEdges.length) return false
      for (let i = 0; i < fromData.length; i++) {
        if (fromData[i] !== fromEdges[i]) return false
      }
    }
  }
  return true
}
