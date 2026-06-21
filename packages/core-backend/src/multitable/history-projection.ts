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
  /**
   * LOCK-3 FIELD layer. Per-sheet readable field-id sets = (visible property fields ∧ field_permissions
   * scope ∧ formula-taint drop), resolved by the caller (route) via the SAME chain the per-record history
   * route uses (`loadAllowedFieldIds` → `maskStoredRecordFieldIds`). A changed field id / snapshot value /
   * field count for a field NOT in this set is dropped, so a row-readable-but-field-denied actor never sees
   * the hidden field's id, value, or count. A sheet missing from the map → empty set → every field masked
   * (FAIL CLOSED). Field-permissions are NOT admin-bypassed (parity with the per-record route); only
   * row-level deny is (see `loadDeniedBySheet`).
   */
  allowedFieldsBySheet: Map<string, Set<string>>
  actorId?: string
  source?: string
  action?: string
  from?: string
  to?: string
  /**
   * T2b field filter — keep only batches that touched this field, applied POST-mask: a batch matches iff the
   * field is in its VISIBLE field set. A field the actor cannot read is never visible, so filtering by it
   * yields no batches (no "which batches touched the hidden field" probe) — the LOCK-3 boundary holds.
   */
  fieldId?: string
  /**
   * T2b search — substring (lowercase-contains) over a batch's VISIBLE snapshot values. Applied POST-mask
   * (`filterDataByAllowedFields(snapshot, allowed)`): only the actor's readable fields of non-row-denied
   * records are searched, so a denied record's data and a hidden field's value can NEVER produce a hit (the
   * same leak-free construction as the field filter). Value-search only — no operators / regex / query
   * language; numbers/dates are matched by their stringified form. `total` is post-search.
   */
  search?: string
  /** T2b cursor pagination: opaque (createdAt, batchId) of the last batch of the previous page. When present,
   *  it takes precedence over `offset` (which is left working for any legacy caller). */
  cursor?: string
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
  /** Loaded ONLY when a search query is present (the SELECT omits it otherwise). Searched post-mask. */
  snapshot: Record<string, unknown> | null
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
    snapshot: r.snapshot && typeof r.snapshot === 'object' && !Array.isArray(r.snapshot) ? (r.snapshot as Record<string, unknown>) : null,
  }))
}

function isDenied(deniedBySheet: Map<string, Set<string>>, sheetId: string, recordId: string): boolean {
  return deniedBySheet.get(sheetId)?.has(recordId) === true
}

const EMPTY_FIELD_SET: ReadonlySet<string> = new Set()

/** T2b search candidate-row cap (bound the snapshot load over a huge history; hitting it logs + truncates, never fails). */
const SEARCH_CANDIDATE_ROW_CAP = 20000

/**
 * T2b cursor pagination (Option A — a stable key-cursor over the post-filter batch list; `total` stays exact).
 * The cursor is the opaque (createdAt, batchId) of the last batch on a page. Pagination is over `all` AFTER it
 * is sorted by the SAME total order the cursor compares on — (createdAt DESC, batchId DESC) — so a page
 * boundary that lands on a createdAt tie cannot skip or duplicate (batchId is globally unique, the tiebreak).
 * This buys page-reachability + stability under concurrent top-inserts; it does NOT reduce DB load (every page
 * still loads + filters all rows — an exact post-filter `total` requires that). True SQL-level efficiency would
 * trade the exact total for a `hasMore` estimate; that is a deferred follow-up, not this slice.
 */
function encodeHistoryCursor(b: { createdAt: string; batchId: string }): string {
  return Buffer.from(`${b.createdAt}|${b.batchId}`, 'utf8').toString('base64')
}
function decodeHistoryCursor(cursor: string): { createdAt: string; batchId: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8')
    const sep = raw.lastIndexOf('|') // batchId is opaque but never contains '|' in our id space; split on the last
    if (sep <= 0) return null
    return { createdAt: raw.slice(0, sep), batchId: raw.slice(sep + 1) }
  } catch {
    return null // malformed cursor → treated as no cursor (first page); never throws
  }
}
/** Total DESC order over (createdAt, batchId); batchId breaks createdAt ties. <0 → a sorts before b. */
function compareBatchKeyDesc(a: { createdAt: string; batchId: string }, b: { createdAt: string; batchId: string }): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  if (a.batchId !== b.batchId) return a.batchId < b.batchId ? 1 : -1
  return 0
}

/** LOCK-3 field layer: per-sheet allowed field-id set; a sheet missing from the map masks every field (fail-closed). */
function allowedFieldsFor(map: Map<string, Set<string>>, sheetId: string): ReadonlySet<string> {
  return map.get(sheetId) ?? EMPTY_FIELD_SET
}

/**
 * Keep only the allowed field-id keys of a stored snapshot/patch object (mirrors univer-meta's
 * `filterRecordDataByFieldIds`; kept local to avoid a routes→projection import cycle). A null/non-object
 * snapshot stays null (matching the prior `after` semantics); an all-masked object becomes `{}` so no
 * denied value leaks.
 */
function filterDataByAllowedFields(data: unknown, allowed: ReadonlySet<string>): Record<string, unknown> | null {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) return null
  return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([fieldId]) => allowed.has(fieldId)))
}

/**
 * List permission-filtered batch summaries for a base, newest first. Totals + pagination are computed
 * AFTER permission filtering (LOCK-3): a fully-denied batch never appears and never counts.
 */
export async function loadHistoryBatchSummaries(
  query: QueryFn,
  params: HistoryEventsParams,
  access: HistoryAccess,
): Promise<{ batches: HistoryBatchSummary[]; total: number; nextCursor: string | null }> {
  const sheetIds = params.sheetIds
  if (sheetIds.length === 0) return { batches: [], total: 0, nextCursor: null }
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
  // T2b search: load the snapshot ONLY when searching (it is heavier), and cap the candidate rows so a search
  // over a huge history is bounded. Capping a READ-ONLY search yields incomplete results, NOT a failure — do
  // NOT fail-closed here (unlike T5/PV-7, search has no execution-matches-preview invariant to protect).
  const searchQuery = params.search && params.search.trim() ? params.search.trim().toLowerCase() : null
  const res = await query(
    `SELECT id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, batch_id, created_at${searchQuery ? ', snapshot' : ''}
     FROM meta_record_revisions
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, version DESC, id DESC${searchQuery ? `\n     LIMIT ${SEARCH_CANDIDATE_ROW_CAP}` : ''}`,
    args,
  )
  const rows = normalizeRevRows(res.rows)
  if (searchQuery && rows.length >= SEARCH_CANDIDATE_ROW_CAP) {
    console.warn(`[history-projection] search candidate rows hit the ${SEARCH_CANDIDATE_ROW_CAP} cap; older revisions were not searched (results may be incomplete)`)
  }

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
    let searchMatched = !searchQuery // no search → trivially matched
    for (const row of g) {
      if (isDenied(deniedBySheet, row.sheet_id, row.record_id)) continue // LOCK-3: drop denied record's rows
      visibleRecords.add(row.record_id)
      const allowed = allowedFieldsFor(params.allowedFieldsBySheet, row.sheet_id) // LOCK-3 field layer
      for (const f of row.changed_field_ids) if (allowed.has(f)) visibleFields.add(f) // count only readable fields
      // T2b search: match the query against the POST-MASK snapshot values only — a denied record's rows are
      // already skipped above, and filterDataByAllowedFields drops hidden fields, so neither can ever match.
      if (searchQuery && !searchMatched) {
        const masked = filterDataByAllowedFields(row.snapshot, allowed)
        if (masked && Object.values(masked).some((v) => v != null && String(v).toLowerCase().includes(searchQuery))) {
          searchMatched = true
        }
      }
    }
    if (visibleRecords.size === 0) continue // LOCK-3: fully-denied batch is invisible AND not counted
    if (params.fieldId && !visibleFields.has(params.fieldId)) continue // T2b field filter (post-mask, leak-free)
    if (searchQuery && !searchMatched) continue // T2b search (post-mask, leak-free); total stays post-search
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
  const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 100)
  // Sort by the SAME total order the cursor compares on (createdAt DESC, batchId DESC) so a tie-straddling page
  // boundary can't skip/duplicate. (Encounter order already ~matches but disagrees at createdAt ties.)
  all.sort(compareBatchKeyDesc)
  // Pagination start: a cursor (if valid) wins over offset and points just past the previous page's last batch.
  let start = 0
  const cur = params.cursor ? decodeHistoryCursor(params.cursor) : null
  if (cur) {
    const idx = all.findIndex((b) => compareBatchKeyDesc(b, cur) > 0) // first batch strictly AFTER the cursor
    start = idx === -1 ? all.length : idx
  } else if (params.offset) {
    start = Math.max(Number(params.offset), 0)
  }
  const batches = all.slice(start, start + limit)
  const nextCursor = start + limit < all.length && batches.length > 0
    ? encodeHistoryCursor(batches[batches.length - 1])
    : null
  return { batches, total, nextCursor }
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
  allowedFieldsBySheet: Map<string, Set<string>>,
): Promise<HistoryBatchDetail | null> {
  if (sheetIds.length === 0) return null
  const res = await query(
    `SELECT id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, batch_id, snapshot, patch, created_at
     FROM meta_record_revisions
     WHERE sheet_id = ANY($1::text[]) AND COALESCE(batch_id, id::text) = $2
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
    if (isDenied(deniedBySheet, sheetId, recordId)) continue // LOCK-3: row layer
    if (!head) head = r
    visibleRecords.add(recordId)
    // LOCK-3 field layer: drop field ids / snapshot values / counts for fields this actor cannot read, so a
    // row-readable-but-field-denied actor never learns the hidden field's id, value, or that it changed.
    const allowed = allowedFieldsFor(allowedFieldsBySheet, sheetId)
    const fields = (Array.isArray(r.changed_field_ids) ? r.changed_field_ids.map(String) : []).filter((f) => allowed.has(f))
    for (const f of fields) visibleFields.add(f)
    changes.push({
      sheetId,
      recordId,
      action: typeof r.action === 'string' ? r.action : 'update',
      version: Number(r.version ?? 0),
      changedFieldIds: fields,
      before: null, // T1b: before/after diff hydration is a detail refinement; after = snapshot
      after: filterDataByAllowedFields(r.snapshot, allowed),
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
