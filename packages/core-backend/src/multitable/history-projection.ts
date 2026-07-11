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
 *
 * T1b before-image hydration (`loadHistoryBatchDetail`): `before` is populated per action — null for
 * `create` (no prior state), the immediately-previous revision's snapshot for `update` (ONE extra batched
 * query for the whole detail, never per-change), and the revision's own snapshot column for `delete` (it
 * already captures the pre-delete state — see `loadPreviousSnapshots` for the full schema evidence).
 * `before` is masked through the EXACT SAME allow-set as `after` (masking parity).
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
  /** Candidate-row cap for search (default SEARCH_CANDIDATE_ROW_CAP). Injectable so a test can exercise the
   *  truncation path without seeding 20k rows; the route never sets it. */
  searchRowCap?: number
  /** T2b cursor pagination: opaque (createdAt, batchId) of the last batch of the previous page. When present,
   *  it takes precedence over `offset` (which is left working for any legacy caller). */
  cursor?: string
  limit?: number
  offset?: number
  /**
   * T2b-perf count mode (opt-in; default `exact`). `exact` (and any unset/unknown value) computes the EXACT
   * post-LOCK-3 `total` by materializing + sorting the WHOLE filtered batch set — byte-for-byte the legacy
   * behaviour. `estimate` skips the exact total and answers only the cheap question "are there MORE than
   * `offset+limit` VISIBLE batches?" via `estimateHistoryHasMore`, early-stopping the scan once it has confirmed
   * one batch past the page boundary. It is the route's job to dispatch on this; `loadHistoryBatchSummaries`
   * itself ignores it (the exact path is unchanged). Estimate is scoped to the plain newest-first list: a
   * `search`/`fieldId`/`cursor` request is NOT served by estimate (the route falls back to exact for those).
   */
  countMode?: 'exact' | 'estimate'
  /** Estimate-path keyset-scan chunk size (rows per round-trip; default ESTIMATE_SCAN_CHUNK). Injectable ONLY so
   *  a test can force multi-chunk pagination over a tiny seed (exercising the keyset cursor); the route never
   *  sets it. A non-finite/<1 value falls back to the default. */
  estimateScanChunk?: number
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
): Promise<{ batches: HistoryBatchSummary[]; total: number; nextCursor: string | null; searchTruncated: boolean }> {
  const sheetIds = params.sheetIds
  if (sheetIds.length === 0) return { batches: [], total: 0, nextCursor: null, searchTruncated: false }
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
  // Finite positive integer only. Resolve the default FIRST (`??` catches null + undefined — `Number(null)` is
  // 0, which would otherwise clamp to LIMIT 1 instead of the default), then guard: a non-finite value falls
  // back to the default (never `LIMIT NaN`), a fractional value is floored (never `LIMIT 2.5`). SQL-interpolated.
  const numericRowCap = Number(params.searchRowCap ?? SEARCH_CANDIDATE_ROW_CAP)
  const searchRowCap = Number.isFinite(numericRowCap) ? Math.max(Math.floor(numericRowCap), 1) : SEARCH_CANDIDATE_ROW_CAP
  const res = await query(
    `SELECT id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, batch_id, created_at${searchQuery ? ', snapshot' : ''}
     FROM meta_record_revisions
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, version DESC, id DESC${searchQuery ? `\n     LIMIT ${searchRowCap}` : ''}`,
    args,
  )
  const rows = normalizeRevRows(res.rows)
  // When a search hits the candidate cap, older revisions were NOT searched: a visible match beyond the cap is
  // absent. We surface that to the caller (searchTruncated) AND server-log it — never silently, so the UI can
  // tell the user to narrow filters rather than read incomplete results as "nothing matched".
  const searchTruncated = searchQuery !== null && rows.length >= searchRowCap
  if (searchTruncated) {
    console.warn(`[history-projection] search candidate rows hit the ${searchRowCap} cap; older revisions were not searched (results + total are bounded)`)
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
  return { batches, total, nextCursor, searchTruncated }
}

/** Keyset-scan chunk size for the estimate path (rows fetched per round-trip; bounds memory, not correctness). */
const ESTIMATE_SCAN_CHUNK = 500
/** Hard ceiling on chunks scanned so a pathological history can't loop unboundedly; reaching it returns the
 *  scan's verdict so far (which is safe-direction — see the function doc). The route never hits this in practice. */
const ESTIMATE_MAX_CHUNKS = 10000

/**
 * T2b-perf: the `?countMode=estimate` alternative to the exact post-LOCK-3 `total` (the long-deferred follow-up
 * the line ~143 comment marks). Instead of materializing + sorting the WHOLE filtered batch set to count it, it
 * answers only `hasMore` = "are there MORE than `offset+limit` VISIBLE batches?" and builds JUST the requested
 * page. It is SCOPED to the plain newest-first list — no `search`/`fieldId`/`cursor` (those keep the exact path);
 * the route enforces that scoping. `total` is intentionally omitted (the whole point is not to compute it).
 *
 * LOCK-3 (the load-bearing contract) is preserved IDENTICALLY to the exact path:
 *   - Phase 1 (cheap scan) decides batch VISIBILITY using `loadDeniedBySheet` + `isDenied` — the SAME row-level
 *     deny seam, gated the same way (flag-on + non-admin; admin bypass). A batch counts toward `hasMore` ONLY
 *     after at least one of its rows survives `isDenied` (`visibleKeys.add` is gated by the deny check), exactly
 *     mirroring the exact path's `visibleRecords.size === 0 ⇒ skip` rule. So a row-denied record can NEVER flip
 *     `hasMore` for an actor who can't see it (the leak the goldens guard). The FIELD layer is deliberately NOT
 *     consulted in Phase 1 because field-mask never removes a batch from the set — it only shrinks counts (the
 *     exact path drops a batch solely on row-visibility) — so batch CARDINALITY (all `hasMore` needs) depends
 *     only on row-deny. Counting fewer columns/no field-mask here changes no visibility decision.
 *   - `hasMore` is an order-FREE cardinality question, and visibility is monotonic-up + deduped by batch key, so
 *     encounter order, batch row-contiguity across chunks, and created_at ties are all irrelevant to it. A chunk
 *     boundary can at worst leave a batch partially seen → it is still counted the moment any visible row of it
 *     appears, and an early stop only ever UNDERCOUNTS not-yet-confirmed batches → it can flip `hasMore` to FALSE
 *     (safe), never spuriously TRUE.
 *   - Phase 2 (page build) re-applies BOTH LOCK-3 layers (row-deny AND the field mask) over ONLY the page's
 *     batches, reusing the exact path's per-batch construction, so the returned summaries carry the same
 *     post-mask `visibleAffectedRecordCount` / `visibleAffectedFieldCount` as the exact path would.
 *
 * Ordering caveat (page CONTENTS only — never `hasMore`, never security): the head order-key is the batch's
 * FIRST-seen (newest) row, denied or not, so estimate's batch order matches the exact path's `head = g[0]`. The
 * one residual divergence — a batch whose NEWEST row is denied but an OLDER row is visible, straddling the
 * early-stop boundary — requires WITHIN-batch created_at spread, which the write path precludes: one bulk action
 * is one transaction, and Postgres `now()` is transaction-stable, so all rows of a batch share one created_at.
 * (A page boundary landing on a createdAt TIE across DISTINCT batches has the same "first N, hasMore if an
 * (N+1)th exists" semantics the record cursor pagination already uses.) Callers needing tie-exact page stability
 * use `countMode=exact`.
 */
export async function estimateHistoryHasMore(
  query: QueryFn,
  params: HistoryEventsParams,
  access: HistoryAccess,
): Promise<{ batches: HistoryBatchSummary[]; hasMore: boolean; nextCursor: string | null }> {
  const sheetIds = params.sheetIds
  const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 100)
  const offset = params.offset ? Math.max(Number(params.offset), 0) : 0
  if (sheetIds.length === 0) return { batches: [], hasMore: false, nextCursor: null }
  const deniedBySheet = await loadDeniedBySheet(query, sheetIds, access)

  // Filters that the exact path pushes to SQL are pushed here too, so the estimate set == the exact set. Estimate
  // is scoped (route-enforced) to the plain list: search/fieldId/cursor are absent, so no snapshot is loaded.
  const baseWhere: string[] = ['sheet_id = ANY($1::text[])']
  const baseArgs: unknown[] = [sheetIds]
  const addFilter = (clause: string, val: unknown) => { baseArgs.push(val); baseWhere.push(clause.replace('$N', `$${baseArgs.length}`)) }
  if (params.actorId) addFilter('actor_id = $N', params.actorId)
  if (params.source) addFilter('source = $N', params.source)
  if (params.action) addFilter('action = $N', params.action)
  if (params.from) addFilter('created_at >= $N', params.from)
  if (params.to) addFilter('created_at <= $N', params.to)

  // We only need ONE batch past the page to know hasMore; once we have confirmed that many VISIBLE batches we
  // stop fetching. `heads` records each batch's HEAD order-key from its FIRST-seen row (denied OR visible) so the
  // ordering matches the exact path EXACTLY (there `head = g[0]` = the newest row of the batch regardless of
  // denial). `visibleKeys` is the set of batches with ≥1 row surviving LOCK-3 row-deny — these are the ONLY ones
  // that count toward hasMore (parity with the exact path's `visibleRecords.size === 0 ⇒ skip`).
  const stopAfter = offset + limit + 1 // confirm one batch beyond the requested page → hasMore=true
  // Resolve the chunk size (default-first so `??` catches null+undefined; non-finite/<1 → default), mirroring the
  // searchRowCap guard. SQL-interpolated, so it MUST be a finite positive integer (never `LIMIT NaN`).
  const numericChunk = Number(params.estimateScanChunk ?? ESTIMATE_SCAN_CHUNK)
  const scanChunk = Number.isFinite(numericChunk) ? Math.max(Math.floor(numericChunk), 1) : ESTIMATE_SCAN_CHUNK
  const heads = new Map<string, { createdAt: string; batchId: string }>()
  const visibleKeys = new Set<string>()
  // The keyset cursor carries the RAW column text of created_at (microsecond precision) — NOT the JS-Date-derived
  // ISO, which node-pg truncates to milliseconds. Binding the truncated ms value back as the boundary would skip
  // any unprocessed row whose created_at lies in the truncated sub-millisecond gap (silent row loss → undercount).
  let cursorKey: { createdAtRaw: string; version: number; id: string } | null = null
  let exhausted = false
  // Cluster-complete early-stop (same-ms parity): once `stopAfter` VISIBLE batches are confirmed, `enoughMs` pins the
  // boundary row's ms; collection then continues only to the end of that same-millisecond cluster (a STRICTLY-older ms
  // → `done`). Sorting the COMPLETE cluster by the exact-path comparator (below) yields exactly the exact path's page,
  // so the estimate matches shipped ordering WITHOUT changing the exact path. Stopping mid-cluster (the old unconditional
  // break) sliced the wrong same-ms batches into the page.
  let enoughMs: string | null = null
  let done = false
  for (let chunk = 0; chunk < ESTIMATE_MAX_CHUNKS && !exhausted && !done; chunk++) {
    const where = [...baseWhere]
    const args = [...baseArgs]
    if (cursorKey) {
      // Keyset "strictly after" in the LOCK-11 DESC order (created_at DESC, version DESC, id DESC): the row tuple
      // is lexicographically LESS than the last row's tuple. `createdAtRaw` is the full-precision column text, so
      // `::timestamptz` re-parses the EXACT stored value (no ms truncation). Casts match the column types.
      args.push(cursorKey.createdAtRaw, cursorKey.version, cursorKey.id)
      where.push(`(created_at, version, id) < ($${args.length - 2}::timestamptz, $${args.length - 1}::int, $${args.length}::uuid)`)
    }
    // No snapshot column — visibility (row-deny) is all Phase 1 needs; the field layer is applied in Phase 2.
    // created_at::text aliased as created_at_iso gives the EXACT stored value for the keyset cursor (microsecond
    // precision); the JS-Date `created_at` is kept only for head order-key/display (parity with the exact path).
    const res = await query(
      `SELECT id, sheet_id, record_id, version, batch_id, created_at, created_at::text AS created_at_iso
       FROM meta_record_revisions
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, version DESC, id DESC
       LIMIT ${scanChunk}`,
      args,
    )
    const rows = res.rows as Array<Record<string, unknown>>
    if (rows.length < scanChunk) exhausted = true
    for (const r of rows) {
      const sheetId = String(r.sheet_id)
      const recordId = String(r.record_id)
      const id = String(r.id)
      const version = Number(r.version ?? 0)
      const createdAt = r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? '')
      if (enoughMs !== null && createdAt < enoughMs) { done = true; break } // crossed past the boundary ms-cluster → stop (the whole cluster is collected)
      const createdAtRaw = String(r.created_at_iso ?? createdAt) // full-precision column text for the keyset cursor
      cursorKey = { createdAtRaw, version, id } // advance the keyset cursor to this (last-processed) row
      const key = typeof r.batch_id === 'string' ? r.batch_id : id
      // The head order-key is the FIRST-seen row of the batch (newest, denied or not) — matches exact's `g[0]`.
      if (!heads.has(key)) heads.set(key, { createdAt, batchId: key })
      if (isDenied(deniedBySheet, sheetId, recordId)) continue // LOCK-3 row layer: a denied row never confirms a batch
      if (!visibleKeys.has(key)) {
        visibleKeys.add(key)
        if (enoughMs === null && visibleKeys.size >= stopAfter) enoughMs = createdAt // enough → pin the boundary ms; finish its cluster, then `done`
      }
    }
  }

  const hasMore = visibleKeys.size > offset + limit
  // Phase 2: the page's batch keys = the VISIBLE heads sorted by the SAME total order the exact path/cursor use,
  // sliced to the requested window. (We may have collected up to stopAfter visible batches; slice keeps the page.)
  const sortedHeads = [...visibleKeys].map((k) => heads.get(k)!).sort(compareBatchKeyDesc)
  const pageHeads = sortedHeads.slice(offset, offset + limit)
  if (pageHeads.length === 0) return { batches: [], hasMore, nextCursor: null }
  const pageKeys = pageHeads.map((h) => h.batchId)

  // Fetch the FULL rows of ONLY the page's batches (complete batches, regardless of where Phase 1 stopped), then
  // build summaries reusing the exact path's per-batch construction WITH the LOCK-3 field layer (mask counts).
  const detailRes = await query(
    `SELECT id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, batch_id, created_at
     FROM meta_record_revisions
     WHERE sheet_id = ANY($1::text[]) AND COALESCE(batch_id, id::text) = ANY($2::text[])
     ORDER BY created_at DESC, version DESC, id DESC`,
    [sheetIds, pageKeys],
  )
  const detailRows = normalizeRevRows(detailRes.rows)
  const groups = new Map<string, RevRow[]>()
  for (const row of detailRows) {
    const key = row.batch_id ?? row.id
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }
  const batches: HistoryBatchSummary[] = []
  for (const head of pageHeads) {
    const g = groups.get(head.batchId)
    if (!g || g.length === 0) continue // a batch that vanished between scan and detail (concurrent delete) is skipped
    const visibleRecords = new Set<string>()
    const visibleFields = new Set<string>()
    for (const row of g) {
      if (isDenied(deniedBySheet, row.sheet_id, row.record_id)) continue // LOCK-3 row layer (same as exact path)
      visibleRecords.add(row.record_id)
      const allowed = allowedFieldsFor(params.allowedFieldsBySheet, row.sheet_id) // LOCK-3 field layer (mask counts)
      for (const f of row.changed_field_ids) if (allowed.has(f)) visibleFields.add(f)
    }
    if (visibleRecords.size === 0) continue // fully-denied batch is invisible (parity with the exact path)
    const headRow = g[0]
    const actions = new Set(g.map((r) => r.action))
    batches.push({
      batchId: head.batchId,
      sheetId: headRow.sheet_id,
      actorId: headRow.actor_id,
      source: headRow.source,
      action: actions.size === 1 ? headRow.action : 'bulk_update',
      createdAt: headRow.created_at,
      visibleAffectedRecordCount: visibleRecords.size,
      visibleAffectedFieldCount: visibleFields.size,
      provenanceQuality: g.some((r) => r.batch_id) ? 'stamped' : 'legacy',
    })
  }
  // A next cursor when MORE visible batches exist beyond this page (mirrors the exact path's nextCursor semantics).
  const nextCursor = hasMore && batches.length > 0 ? encodeHistoryCursor(batches[batches.length - 1]) : null
  return { batches, hasMore, nextCursor }
}

export interface HistoryChange {
  sheetId: string
  recordId: string
  action: string
  version: number
  changedFieldIds: string[]
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  /**
   * R11 restore back-reference (OD-0=(a)): the SOURCE record-version a `source='restore'` record-version
   * restore wrote from, else null. LOCK-3: a version number is metadata (same tier as changedFieldIds/version),
   * carries no field value, needs no mask increment. Non-null only for the three record-version restore routes;
   * every other write (incl. non-version-restore source='restore' emitters) is null. The FE badge keys on non-null.
   */
  restoredFromVersion?: number | null
}

export interface HistoryBatchDetail {
  batchId: string
  actorId: string | null
  source: string
  createdAt: string
  visibleAffectedRecordCount: number
  visibleAffectedFieldCount: number
  changes: HistoryChange[]
  /**
   * all-tables-B (R11): masked field-id → display-name map, per sheet, for the fields that actually appear
   * in this batch's (post-mask) changes. Reuses the SAME per-sheet allow-set (`allowedFieldsBySheet`) the
   * value masking uses — layer-2 property-hidden ∩ layer-3 field_permissions ∩ taint-mask — so a field name
   * here is, by construction, a field whose VALUE the projection already emits: no new information. Lets the
   * History Center label cross-table (all-tables mode) diff rows by name instead of raw id without the FE
   * re-deriving the two-layer mask client-side (the #4007 footgun). Hidden/denied field names NEVER appear.
   */
  fieldNames: Record<string, Record<string, string>>
}

/**
 * T1b before-image lookup key: `${sheetId}::${recordId}::${version}` (the CURRENT change's own version,
 * not the previous one) so the hydration result maps back onto the exact row it was fetched for.
 */
function beforeLookupKey(sheetId: string, recordId: string, version: number): string {
  return `${sheetId}::${recordId}::${version}`
}

/**
 * T1b: batched previous-revision-snapshot lookup, ONE extra query for the whole batch (never N+1).
 *
 * Schema evidence for the source of the before-image (read from the capture writer, not guessed):
 *   - `update` (record-service.ts patchRecord / record-write-service.ts bulk patch): the revision's OWN
 *     `patch` column carries only the NEW values of changed fields (old values are never written), and its
 *     `snapshot` column is `{ ...previousData, ...patch }` — the POST-update full state (`after`). Neither
 *     column on the row itself carries a pre-update value, so the only place the prior state exists is the
 *     immediately-preceding revision's `snapshot` for the SAME record — hence this lookup.
 *   - `create` needs no lookup (no prior state; the caller leaves `before` null).
 *   - `delete` (record-service.ts deleteRecord) needs no lookup either: its own `snapshot` column is
 *     `normalizeJson(currentRow.data)` captured BEFORE the DELETE — i.e. the delete revision's own snapshot
 *     column already IS the pre-delete state, so the caller reads it directly (no join needed).
 *
 * `targets` is deliberately restricted by the caller to `update` rows only. For each target we want the
 * revision with the LARGEST version strictly less than the target's version for the same (sheet_id,
 * record_id) — the nearest surviving prior revision, not `version - 1` (a `meta_revision_retention` sweep
 * can thin the middle of the log, leaving gaps — LOCK-11/retention doc). A `JOIN LATERAL ... LIMIT 1` per
 * target, batched via `unnest`, does this in one round trip using the existing
 * `(sheet_id, record_id, version DESC)` index — no per-change N+1 query.
 */
async function loadPreviousSnapshots(
  query: QueryFn,
  targets: Array<{ sheetId: string; recordId: string; version: number }>,
): Promise<Map<string, Record<string, unknown> | null>> {
  const result = new Map<string, Record<string, unknown> | null>()
  if (targets.length === 0) return result
  const res = await query(
    `SELECT t.sheet_id, t.record_id, t.version AS target_version, r.snapshot AS prev_snapshot
     FROM unnest($1::text[], $2::text[], $3::int[]) AS t(sheet_id, record_id, version)
     JOIN LATERAL (
       SELECT snapshot
       FROM meta_record_revisions
       WHERE sheet_id = t.sheet_id AND record_id = t.record_id AND version < t.version
       ORDER BY version DESC
       LIMIT 1
     ) r ON true`,
    [targets.map((t) => t.sheetId), targets.map((t) => t.recordId), targets.map((t) => t.version)],
  )
  for (const row of res.rows as Array<Record<string, unknown>>) {
    const sheetId = String(row.sheet_id)
    const recordId = String(row.record_id)
    const version = Number(row.target_version)
    const snap = row.prev_snapshot
    result.set(
      beforeLookupKey(sheetId, recordId, version),
      snap && typeof snap === 'object' && !Array.isArray(snap) ? (snap as Record<string, unknown>) : null,
    )
  }
  return result
}

// R11 back-reference: local 42703 guard for the restored_from_version deploy window (read side).
function isUndefinedColumnError42703Projection(err: unknown, columnName: string): boolean {
  const code = (err as { code?: string } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  if (code === '42703') return message.includes(columnName)
  return message.includes(`column "${columnName}" does not exist`)
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
  // R11 back-reference: select restored_from_version too, with a deploy-window fallback — a rolling deploy
  // where this read ships before migration 067 degrades to the base column set (restoredFromVersion → null)
  // instead of 500ing the whole batch-detail endpoint (mirrors record-service's delete_revision_id read).
  const detailSelect = (withRestored: boolean) =>
    query(
      `SELECT id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, batch_id, snapshot, patch, created_at${withRestored ? ', restored_from_version' : ''}
       FROM meta_record_revisions
       WHERE sheet_id = ANY($1::text[]) AND COALESCE(batch_id, id::text) = $2
       ORDER BY created_at DESC, version DESC, id DESC`,
      [sheetIds, batchId],
    )
  let res
  try {
    res = await detailSelect(true)
  } catch (err) {
    if (!isUndefinedColumnError42703Projection(err, 'restored_from_version')) throw err
    res = await detailSelect(false)
  }
  const rows = res.rows as Array<Record<string, unknown>>
  if (rows.length === 0) return null
  const deniedBySheet = await loadDeniedBySheet(query, [...new Set(rows.map((r) => String(r.sheet_id)))], access)

  // Pass 1: drop denied rows (LOCK-3 row layer) BEFORE deciding which changes need a before-image lookup,
  // so a denied record's version never appears in the batched query (nothing to hide there, just no waste).
  const visible: Array<{ row: Record<string, unknown>; sheetId: string; recordId: string; action: string; version: number }> = []
  for (const r of rows) {
    const sheetId = String(r.sheet_id)
    const recordId = String(r.record_id)
    if (isDenied(deniedBySheet, sheetId, recordId)) continue // LOCK-3: row layer
    visible.push({
      row: r,
      sheetId,
      recordId,
      action: typeof r.action === 'string' ? r.action : 'update',
      version: Number(r.version ?? 0),
    })
  }
  if (visible.length === 0) return null // fully denied → same as missing (LOCK-3, no oracle)

  // ONE extra query for the whole batch (not per-change): only `update` rows need a previous-revision
  // lookup (see loadPreviousSnapshots doc for why `create`/`delete` don't).
  const prevSnapshotByKey = await loadPreviousSnapshots(
    query,
    visible.filter((v) => v.action === 'update').map((v) => ({ sheetId: v.sheetId, recordId: v.recordId, version: v.version })),
  )

  const changes: HistoryChange[] = []
  const visibleRecords = new Set<string>()
  const visibleFields = new Set<string>()
  // all-tables-B: per-sheet set of the (already post-mask) field ids that appear in this batch's changes —
  // exactly the ids we need display names for. Only these get named (minimal surface, "payload 实际涉及").
  const involvedFieldsBySheet = new Map<string, Set<string>>()
  let head: Record<string, unknown> | null = null
  for (const { row: r, sheetId, recordId, action, version } of visible) {
    if (!head) head = r
    visibleRecords.add(recordId)
    // LOCK-3 field layer: drop field ids / snapshot values / counts for fields this actor cannot read, so a
    // row-readable-but-field-denied actor never learns the hidden field's id, value, or that it changed.
    const allowed = allowedFieldsFor(allowedFieldsBySheet, sheetId)
    const fields = (Array.isArray(r.changed_field_ids) ? r.changed_field_ids.map(String) : []).filter((f) => allowed.has(f))
    for (const f of fields) visibleFields.add(f)
    if (fields.length > 0) {
      let inv = involvedFieldsBySheet.get(sheetId)
      if (!inv) { inv = new Set(); involvedFieldsBySheet.set(sheetId, inv) }
      for (const f of fields) inv.add(f)
    }
    // T1b before-image, sourced per action semantics (see loadPreviousSnapshots doc):
    //   create → null (no prior state); update → the immediately-previous revision's snapshot (looked up
    //   above); delete → this revision's OWN snapshot column (the pre-delete state it captured).
    // MASKING PARITY: `before` is filtered through the EXACT SAME `allowed` set as `after` — a field this
    // actor cannot read never appears on either side, and `changedFieldIds` stays post-mask (unwidened).
    const beforeSource = action === 'update'
      ? prevSnapshotByKey.get(beforeLookupKey(sheetId, recordId, version)) ?? null
      : action === 'delete'
        ? r.snapshot
        : null
    changes.push({
      sheetId,
      recordId,
      action,
      version,
      changedFieldIds: fields,
      before: filterDataByAllowedFields(beforeSource, allowed),
      after: filterDataByAllowedFields(r.snapshot, allowed),
      // R11 back-reference: pre-migration/absent → null; NULL → null; non-null int → the source version.
      restoredFromVersion: typeof r.restored_from_version === 'number' ? r.restored_from_version : null,
    })
  }
  if (!head || visibleRecords.size === 0) return null // fully denied → same as missing (LOCK-3, no oracle)

  // all-tables-B: resolve display names for the involved (already post-mask) fields, one query for the whole
  // batch (unnest-join, never N+1 — same shape as loadPreviousSnapshots). Every (sheet, field) pair is a
  // subset of the two-layer allow-set, so the query cannot return a hidden/denied field; the re-check below
  // is defense-in-depth (LOCK-3: a field name is as sensitive as its value, evaluated PER the field's sheet).
  const fieldNames: Record<string, Record<string, string>> = {}
  const nameSheetIds: string[] = []
  const nameFieldIds: string[] = []
  for (const [sheetId, ids] of involvedFieldsBySheet) for (const fieldId of ids) { nameSheetIds.push(sheetId); nameFieldIds.push(fieldId) }
  if (nameFieldIds.length > 0) {
    const nameRes = await query(
      `SELECT f.id, f.sheet_id, f.name FROM meta_fields f
       JOIN unnest($1::text[], $2::text[]) AS t(sheet_id, field_id) ON f.sheet_id = t.sheet_id AND f.id = t.field_id`,
      [nameSheetIds, nameFieldIds],
    )
    for (const row of nameRes.rows as Array<Record<string, unknown>>) {
      const sheetId = String(row.sheet_id)
      const fieldId = String(row.id)
      if (!allowedFieldsFor(allowedFieldsBySheet, sheetId).has(fieldId)) continue // defense-in-depth LOCK-3
      const name = typeof row.name === 'string' ? row.name : ''
      ;(fieldNames[sheetId] ??= {})[fieldId] = name
    }
  }

  return {
    batchId,
    actorId: typeof head.actor_id === 'string' ? head.actor_id : null,
    source: typeof head.source === 'string' ? head.source : 'rest',
    createdAt: head.created_at instanceof Date ? head.created_at.toISOString() : String(head.created_at ?? ''),
    visibleAffectedRecordCount: visibleRecords.size,
    visibleAffectedFieldCount: visibleFields.size,
    changes,
    fieldNames,
  }
}
