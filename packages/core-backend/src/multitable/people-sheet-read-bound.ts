/**
 * #5807 first cut — the ONE read-side QUANTITY bound for the People system sheet.
 *
 * ── What this is (and is not) ─────────────────────────────────────────────────
 * The People directory sheet materializes one row per ACTIVE user (`POST /person-fields/prepare`,
 * gate `canManageFields`) into an ordinary multitable sheet. Reading it is gated ONLY by `canRead`,
 * and with no sheet-level assignment a GLOBAL `multitable:read` (or an API token with
 * `records:read`) passes straight through — so any such account could page the whole roster
 * (name + user id; legacy rows still carry an email) out of `/view`, `/records`,
 * `/records-summary`, `link-options`, `export-xlsx|csv` and `view-aggregate`.
 *
 * This module is a BOUND ON QUANTITY, not a gate change. It NEVER grants anything: `bounded` can
 * only shrink a page or refuse a bulk surface, and a caller that could not read the sheet before
 * is refused by the unchanged `canRead` check LONG before anything here runs. Raising the People
 * sheet's `canRead` was rejected deliberately (the triage of #5807): it empties the legacy person
 * chip (`resolveReadableSheetIds` → `buildLinkSummaries`) and 403s the link picker — a functional
 * regression, not a tightening.
 *
 * ── The ruler (one number, one window) ────────────────────────────────────────
 * Same ceiling as the candidate interfaces (#5781/#5795 `PERSON_DIRECTORY_MAX_ITEMS` = 50): an
 * enumerating read of this sheet answers AT MOST the FIRST `PEOPLE_SHEET_READ_MAX_ITEMS` rows in
 * the route's own order, and there is NO paging past that window — `offset`/`cursor` beyond it
 * yields an EMPTY page with `hasMore: false`, never row 51.
 *
 * WHY an empty page and not a 4xx: the bound is a truncation, not an authority failure, and the
 * two clients that page these routes (the grid's infinite scroll and `MetaLinkPicker`) treat
 * `hasMore: false` as "stop" but surface a 4xx as a broken sheet. An empty page also says nothing
 * a full page does not already say, so it leaks no more than the window itself. The refusal is
 * reserved for the surfaces that CANNOT be truncated without lying: an export (a truncated
 * spreadsheet silently claims to be the whole sheet) and an aggregate (a truncated COUNT/SUM is a
 * wrong number) — both answer the shared values-free `sendForbidden`.
 *
 * `page.total` is clamped to the window as well: an honest `total` would re-publish exactly the
 * cardinality (how many active users the deployment has) that the window is there to withhold.
 * `displayMap` is clamped to the RETURNED records: `loadRecordSummaries` builds it from EVERY
 * matched record regardless of `limit` (a self-note at `routes/univer-meta.ts` says so, and the
 * code does it), so clamping only `records` would have left the whole roster on the wire.
 *
 * ── Which sheets ─────────────────────────────────────────────────────────────
 * `isHiddenSystemSheet` — `system_kind = 'people_directory'` OR the description sentinel. The
 * sentinel disjunct is what covers People sheets provisioned BEFORE `system_kind` existed (the L5
 * migration deliberately performed no backfill). Using a user-writable signal is safe HERE and
 * ONLY here because it can only ever SHRINK an answer: forging the sentinel on your own sheet
 * bounds your own sheet's reads. It must never re-enter the TRUST predicate (`isSystemSheet`).
 *
 * ── Not closed by this cut, PRICED ───────────────────────────────────────────
 * This is a PER-REQUEST ceiling, not a cumulative one (#5795's lesson), and the cost of walking it is
 * small: the window clamps the COUNT and the cursor, never the ORDER, so `sortDir=asc` and
 * `sortDir=desc` are two disjoint 50-row pages — 100 distinct people in two requests — and
 * `filter.<fieldId>` / `search` partition the remainder into further disjoint ≤50 pages, i.e. the whole
 * roster in O(headcount / 50) requests. This cut lowers the RATE and the convenience (one request no
 * longer yields the sheet, and `displayMap`/`total`/`hasMore` stop handing over the shape of the rest);
 * it does NOT close enumeration. Closing it needs the read GATE — which is #5807's second cut, not a
 * quantity bound. The tenant predicate on the roster sync (#5788) and the legacy email scrub stay open
 * too.
 */
import type { Response } from 'express'

import { isHiddenSystemSheet } from './system-sheet-predicate'
import { sendForbidden } from './sheet-refusals'

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

/**
 * The window — the ONE literal. `PERSON_DIRECTORY_MAX_ITEMS` (the person-directory /
 * permission-candidates / form-share-candidates ceiling) is now an ALIAS of this constant rather than
 * a second literal that happens to agree, so "one ruler for roster-shaped reads" holds by
 * construction. Consequence, and it cuts the other way too: that UX-facing name is now a SECURITY
 * bound — raising it widens the People sheet's read window. `routes/univer-meta.ts` says so at the
 * alias. (A test asserting the alias equals this constant would compare a value with itself and could
 * never fail, so the suite pins the NUMBER instead.)
 */
export const PEOPLE_SHEET_READ_MAX_ITEMS = 50

export type PeopleSheetReadBound = {
  /** True iff the addressed sheet is the hidden People system sheet (kind OR sentinel). */
  readonly bounded: boolean
  /** The window size; meaningless when `bounded` is false. */
  readonly maxItems: number
}

/**
 * The neutral bound — every ordinary sheet. Nothing downstream changes behaviour for it.
 *
 * NOT exported, and neither is the row-shaped classifier below: an exported surface whose only caller
 * is this module is a promise nobody keeps. Today every call site reaches the bound through
 * `resolvePeopleSheetReadBound` (one indexed primary-key read) because none of them holds the sheet
 * row — `resolveSheetReadableCapabilities` hands back capabilities and liveness, not the row. If a
 * caller ever does carry it down, export the classifier THEN and drop that call site's query.
 */
const UNBOUNDED_PEOPLE_SHEET_READ: PeopleSheetReadBound = Object.freeze({
  bounded: false,
  maxItems: PEOPLE_SHEET_READ_MAX_ITEMS,
})

const BOUNDED_PEOPLE_SHEET_READ: PeopleSheetReadBound = Object.freeze({
  bounded: true,
  maxItems: PEOPLE_SHEET_READ_MAX_ITEMS,
})

/** Row-shaped classifier — the single decision, shared by the resolver below. */
function peopleSheetReadBoundForRow(
  row: { system_kind?: unknown; description?: unknown } | null | undefined,
): PeopleSheetReadBound {
  return isHiddenSystemSheet(row) ? BOUNDED_PEOPLE_SHEET_READ : UNBOUNDED_PEOPLE_SHEET_READ
}

/**
 * Resolve the bound for a sheet id. ONE indexed primary-key read.
 *
 * `system_kind` is read COLUMN-TOLERANTLY (`to_jsonb(s) ->> 'system_kind'`, the same form as
 * `selectPeopleSheetRow` / `history-integrity-precheck`): on a database where the L5 migration has
 * not run the column is absent, the expression yields NULL, and the sentinel disjunct alone
 * applies — instead of a 42703 on every read.
 *
 * Fail-CLOSED on a read error is NOT what happens here and that is deliberate: this resolver runs
 * on the hottest read path for EVERY sheet, so an infrastructure error must surface as the route's
 * own 5xx/503 (it propagates) rather than silently bounding every sheet in the deployment. A
 * MISSING row yields `unbounded`, which is not a widening either: the route's own liveness check
 * has already refused a sheet that is not live.
 */
export async function resolvePeopleSheetReadBound(query: QueryFn, sheetId: string): Promise<PeopleSheetReadBound> {
  if (!sheetId) return UNBOUNDED_PEOPLE_SHEET_READ
  const res = await query(
    "SELECT description, (to_jsonb(s) ->> 'system_kind') AS system_kind FROM meta_sheets s WHERE id = $1",
    [sheetId],
  )
  const row = (res.rows as Array<{ description?: unknown; system_kind?: unknown }>)[0]
  if (!row) return UNBOUNDED_PEOPLE_SHEET_READ
  return peopleSheetReadBoundForRow(row)
}

/**
 * PRE-QUERY clamp: how many rows may this request ask the database for, and from where.
 *
 * `limit: undefined` means "no limit" on `GET /view` — i.e. the WHOLE sheet — so a bounded sheet
 * must be given an explicit one. The returned `limit` is never 0 (`0` is falsy and several call
 * sites branch on `if (limit)`, where 0 would read as "unlimited"): a request that starts beyond
 * the window keeps a positive limit and is emptied by `boundEnumeratedRows` after the read.
 *
 * `beyondWindow` is that "starts past the window" fact, exposed so a caller whose loader has no
 * useful LIMIT can skip the read entirely — `loadRecordSummaries` reads and summarizes EVERY row of
 * the sheet before slicing, so `/records-summary` and `link-options` short-circuit to the empty page
 * on it instead of doing that work for an answer that is discarded. `GET /view` deliberately does not:
 * its branches push the clamp into their own SQL, and its post-read chokepoint empties the page anyway.
 */
export function boundReadWindow(
  bound: PeopleSheetReadBound,
  args: { limit?: number | undefined; offset?: number | undefined },
): { limit: number | undefined; offset: number; beyondWindow: boolean } {
  const offset = Number.isFinite(args.offset) ? Math.max(Number(args.offset), 0) : 0
  if (!bound.bounded) return { limit: args.limit, offset, beyondWindow: false }
  const beyondWindow = offset >= bound.maxItems
  const room = beyondWindow ? bound.maxItems : bound.maxItems - offset
  const requested = Number.isFinite(args.limit) ? Number(args.limit) : bound.maxItems
  return { limit: Math.max(1, Math.min(requested, room)), offset, beyondWindow }
}

/**
 * POST-QUERY truncation — the authoritative chokepoint. Every enumerating reader passes its rows
 * through this, so a branch that forgot the pre-clamp (or a future one) still cannot answer past
 * the window. `offset` is the offset the rows were read at.
 */
export function boundEnumeratedRows<T>(bound: PeopleSheetReadBound, rows: T[], offset = 0): T[] {
  if (!bound.bounded) return rows
  const start = Number.isFinite(offset) ? Math.max(Number(offset), 0) : 0
  if (start >= bound.maxItems) return []
  return rows.slice(0, bound.maxItems - start)
}

export type BoundedPageMeta = { offset: number; limit: number; total: number; hasMore: boolean }

/**
 * The page envelope for a bounded read: the window never advertises itself as continuable
 * (`hasMore: false`) and never re-publishes the true row count (`total` clamped to the window).
 */
export function boundPageMeta(
  bound: PeopleSheetReadBound,
  page: BoundedPageMeta,
): BoundedPageMeta {
  if (!bound.bounded) return page
  const offset = Math.max(page.offset, 0)
  return {
    offset,
    limit: Math.max(1, Math.min(page.limit, bound.maxItems)),
    total: Math.max(0, Math.min(page.total, bound.maxItems)),
    hasMore: false,
  }
}

type RecordSummaryLike<TRecord extends { id: string }> = {
  records: TRecord[]
  displayMap: Record<string, string>
  page: BoundedPageMeta
  displayFieldId?: string | null
}

/**
 * `/records-summary` + `link-options` share this. Beyond truncating `records` it REBUILDS
 * `displayMap` from the surviving records: the loader fills it from every matched record whatever
 * `limit` says, which is the whole roster's display values in one response — the single biggest
 * leak this cut closes.
 */
export function boundRecordSummaryPage<TRecord extends { id: string }>(
  bound: PeopleSheetReadBound,
  summary: RecordSummaryLike<TRecord>,
): RecordSummaryLike<TRecord> {
  if (!bound.bounded) return summary
  const records = boundEnumeratedRows(bound, summary.records, summary.page?.offset ?? 0)
  const displayMap: Record<string, string> = {}
  for (const record of records) {
    const display = summary.displayMap?.[record.id]
    if (typeof display === 'string') displayMap[record.id] = display
  }
  return {
    ...summary,
    records,
    displayMap,
    page: boundPageMeta(bound, summary.page ?? { offset: 0, limit: bound.maxItems, total: records.length, hasMore: false }),
  }
}

/**
 * CURSOR readers (`GET /records`). The window is the FIRST page; any cursor is a request to walk
 * past it, and the cursor is opaque here (it encodes the loader's sort key, not a row index), so
 * "is this cursor still inside the window" is not decidable at this layer. Fail-CLOSED: a cursor
 * on a bounded sheet answers an EMPTY page. That is strictly a tightening — every caller that
 * supplies one has already received the window.
 */
export function boundCursorRead(
  bound: PeopleSheetReadBound,
  args: { limit: number; cursor?: string | undefined },
): { limit: number; skip: boolean } {
  if (!bound.bounded) return { limit: args.limit, skip: false }
  return {
    limit: Math.max(1, Math.min(args.limit, bound.maxItems)),
    skip: typeof args.cursor === 'string' && args.cursor.length > 0,
  }
}

/**
 * The BULK surfaces that cannot be truncated honestly (export xlsx/csv, view-aggregate). Returns
 * true when it has answered; the caller must return immediately.
 *
 * MUST be placed AFTER the route's own 401 / `canRead` (+ `canExport`) / liveness checks so it adds
 * no oracle: a caller who could not read the sheet already got the byte-identical 403, and an
 * absent/soft-deleted sheet already got its 404.
 */
export function refuseBoundedSheetBulkRead(res: Response, bound: PeopleSheetReadBound): boolean {
  if (!bound.bounded) return false
  sendForbidden(res)
  return true
}
