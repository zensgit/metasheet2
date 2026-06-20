/**
 * Global History & Point-in-Time Restore — T1b/T4 read-model projection (PROJECT-ON-READ).
 *
 * A queryable batch/change projection over the EXISTING append-only `meta_record_revisions` log
 * (LOCK-1: read model, not a parallel write store). Revisions group into batches by `COALESCE(batch_id, id)`
 * — a new revision carries the `batch_id` stamped at write time (single action = its own id; a bulk action
 * shares one id), and a legacy row (pre-migration, batch_id NULL) falls back to its own revision id (its
 * own batch; never falsely merged), marked provenanceQuality='legacy'.
 *
 * LOCK-3 (the load-bearing security contract): permission filtering happens BEFORE list, count, and detail.
 * A row-level rule/grant-denied record is removed from the batch entirely; a batch whose every record is
 * denied is invisible and not counted; affected counts are the VISIBLE counts (post-filter), never raw.
 * Admin bypass + flag-off inertness mirror the existing read surfaces (loadDeniedRecordIds machinery).
 *
 * LOCK-11: deterministic ordering `created_at DESC, version DESC, id DESC` (the existing table has a uuid
 * PK and no sequence).
 */
import type { QueryFn } from './permission-service'
import { loadDeniedRecordIds, loadRowLevelReadDenyEnabled } from './permission-service'

export interface HistoryAccess {
  userId: string
  isAdminRole: boolean
}

export interface HistoryEventsParams {
  /**
   * The sheet ids the actor may read = (base sheets ∩ readable), resolved by the caller (route) via the
   * canonical `filterReadableSheetRowsForAccess` gate. The projection trusts this as the sheet-level
   * boundary and applies record-level LOCK-3 deny on top of it.
   */
  sheetIds: string[]
  actorId?: string
  source?: string
  action?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export interface HistoryBatchSummary {
  batchId: string
  sheetId: string
  actorId: string | null
  source: string
  action: string
  createdAt: string
  visibleAffectedRecordCount: number
  visibleAffectedFieldCount: number
  provenanceQuality: 'stamped' | 'legacy'
}

interface RevRow {
  id: string
  sheet_id: string
  record_id: string
  version: number
  action: string
  source: string
  actor_id: string | null
  changed_field_ids: string[]
  batch_id: string | null
  created_at: string
}

/** Per-sheet denied-record set, gated exactly like the live read surfaces (flag-on + non-admin). */
async function loadDeniedBySheet(query: QueryFn, sheetIds: string[], access: HistoryAccess): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>()
  if (access.isAdminRole) return map // admin bypass — mirrors loadDeniedRecordIds callers
  for (const sheetId of sheetIds) {
    if (await loadRowLevelReadDenyEnabled(query, sheetId)) {
      map.set(sheetId, await loadDeniedRecordIds(query, sheetId, access.userId))
    }
  }
  return map
}

function normalizeRevRows(rows: unknown[]): RevRow[] {
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    sheet_id: String(r.sheet_id),
    record_id: String(r.record_id),
    version: Number(r.version ?? 0),
    action: typeof r.action === 'string' ? r.action : 'update',
    source: typeof r.source === 'string' ? r.source : 'rest',
    actor_id: typeof r.actor_id === 'string' ? r.actor_id : null,
    changed_field_ids: Array.isArray(r.changed_field_ids) ? r.changed_field_ids.map(String) : [],
    batch_id: typeof r.batch_id === 'string' ? r.batch_id : null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ''),
  }))
}

function isDenied(deniedBySheet: Map<string, Set<string>>, sheetId: string, recordId: string): boolean {
  return deniedBySheet.get(sheetId)?.has(recordId) === true
}

/**
 * List permission-filtered batch summaries for a base, newest first. Totals + pagination are computed
 * AFTER permission filtering (LOCK-3): a fully-denied batch never appears and never counts.
 */
export async function loadHistoryBatchSummaries(
  query: QueryFn,
  params: HistoryEventsParams,
  access: HistoryAccess,
): Promise<{ batches: HistoryBatchSummary[]; total: number }> {
  const sheetIds = params.sheetIds
  if (sheetIds.length === 0) return { batches: [], total: 0 }
  const deniedBySheet = await loadDeniedBySheet(query, sheetIds, access)

  // Filters are pushed to SQL; ordering is LOCK-11. Grouping by COALESCE(batch_id, id) is done in JS so
  // legacy rows (NULL batch_id) become their own batch (never falsely merged).
  const where: string[] = ['sheet_id = ANY($1::text[])']
  const args: unknown[] = [sheetIds]
  const add = (clause: string, val: unknown) => { args.push(val); where.push(clause.replace('$N', `$${args.length}`)) }
  if (params.actorId) add('actor_id = $N', params.actorId)
  if (params.source) add('source = $N', params.source)
  if (params.action) add('action = $N', params.action)
  if (params.from) add('created_at >= $N', params.from)
  if (params.to) add('created_at <= $N', params.to)
  const res = await query(
    `SELECT id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, batch_id, created_at
     FROM meta_record_revisions
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, version DESC, id DESC`,
    args,
  )
  const rows = normalizeRevRows(res.rows)

  // Group into batches in encounter order (rows are already newest-first → batches stay newest-first).
  const order: string[] = []
  const groups = new Map<string, RevRow[]>()
  for (const row of rows) {
    const key = row.batch_id ?? row.id
    if (!groups.has(key)) { groups.set(key, []); order.push(key) }
    groups.get(key)!.push(row)
  }

  const all: HistoryBatchSummary[] = []
  for (const key of order) {
    const g = groups.get(key)!
    const visibleRecords = new Set<string>()
    const visibleFields = new Set<string>()
    for (const row of g) {
      if (isDenied(deniedBySheet, row.sheet_id, row.record_id)) continue // LOCK-3: drop denied record's rows
      visibleRecords.add(row.record_id)
      for (const f of row.changed_field_ids) visibleFields.add(f)
    }
    if (visibleRecords.size === 0) continue // LOCK-3: fully-denied batch is invisible AND not counted
    const head = g[0]
    const actions = new Set(g.map((r) => r.action))
    all.push({
      batchId: key,
      sheetId: head.sheet_id,
      actorId: head.actor_id,
      source: head.source,
      action: actions.size === 1 ? head.action : 'bulk_update',
      createdAt: head.created_at,
      visibleAffectedRecordCount: visibleRecords.size,
      visibleAffectedFieldCount: visibleFields.size,
      provenanceQuality: g.some((r) => r.batch_id) ? 'stamped' : 'legacy',
    })
  }

  const total = all.length // post-permission-filter total (LOCK-3) — never the raw revision/batch count
  const offset = Math.max(Number(params.offset ?? 0), 0)
  const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 100)
  return { batches: all.slice(offset, offset + limit), total }
}

export interface HistoryChange {
  sheetId: string
  recordId: string
  action: string
  version: number
  changedFieldIds: string[]
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

export interface HistoryBatchDetail {
  batchId: string
  actorId: string | null
  source: string
  createdAt: string
  visibleAffectedRecordCount: number
  visibleAffectedFieldCount: number
  changes: HistoryChange[]
}

/**
 * Batch detail, permission-filtered. Returns null when the batch is unknown OR fully denied — the SAME
 * shape for missing and denied (LOCK-3: no existence oracle). The caller maps null → 404 not-found.
 */
export async function loadHistoryBatchDetail(
  query: QueryFn,
  sheetIds: string[],
  batchId: string,
  access: HistoryAccess,
): Promise<HistoryBatchDetail | null> {
  if (sheetIds.length === 0) return null
  const res = await query(
    `SELECT id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, batch_id, snapshot, patch, created_at
     FROM meta_record_revisions
     WHERE sheet_id = ANY($1::text[]) AND COALESCE(batch_id, id) = $2
     ORDER BY created_at DESC, version DESC, id DESC`,
    [sheetIds, batchId],
  )
  const rows = res.rows as Array<Record<string, unknown>>
  if (rows.length === 0) return null
  const deniedBySheet = await loadDeniedBySheet(query, [...new Set(rows.map((r) => String(r.sheet_id)))], access)

  const changes: HistoryChange[] = []
  const visibleRecords = new Set<string>()
  const visibleFields = new Set<string>()
  let head: Record<string, unknown> | null = null
  for (const r of rows) {
    const sheetId = String(r.sheet_id)
    const recordId = String(r.record_id)
    if (isDenied(deniedBySheet, sheetId, recordId)) continue // LOCK-3
    if (!head) head = r
    visibleRecords.add(recordId)
    const fields = Array.isArray(r.changed_field_ids) ? r.changed_field_ids.map(String) : []
    for (const f of fields) visibleFields.add(f)
    changes.push({
      sheetId,
      recordId,
      action: typeof r.action === 'string' ? r.action : 'update',
      version: Number(r.version ?? 0),
      changedFieldIds: fields,
      before: null, // T1b: before/after diff hydration is a detail refinement; after = snapshot
      after: r.snapshot && typeof r.snapshot === 'object' ? (r.snapshot as Record<string, unknown>) : null,
    })
  }
  if (!head || visibleRecords.size === 0) return null // fully denied → same as missing (LOCK-3, no oracle)
  return {
    batchId,
    actorId: typeof head.actor_id === 'string' ? head.actor_id : null,
    source: typeof head.source === 'string' ? head.source : 'rest',
    createdAt: head.created_at instanceof Date ? head.created_at.toISOString() : String(head.created_at ?? ''),
    visibleAffectedRecordCount: visibleRecords.size,
    visibleAffectedFieldCount: visibleFields.size,
    changes,
  }
}
