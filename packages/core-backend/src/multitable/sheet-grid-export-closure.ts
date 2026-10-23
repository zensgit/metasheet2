/**
 * 备料分批拉取第一期 — step 3, PR A (core): THE SHEET-LEVEL GRID-EXPORT CLOSURE, contract half.
 * Plan: docs/development/takeover-beiliao-20260821 batch-refresh plan §5.3, §7 G7, U09, §12.2 item 1.
 *
 * WHAT IT GUARANTEES. A sheet the host stamped `meta_sheets.grid_export_closure` (today only
 * `stock_prep_pilot`, a stock-preparation pilot project sheet) has NO generic grid export for anyone,
 * administrators and API tokens included:
 *   1. every capability resolver that derives sheet capabilities for a person runs
 *      {@link restrictGridExportCapabilities} — `canExport` is forced false and nothing else changes
 *      (REST `resolveSheetCapabilitiesForAccess`, the Yjs / collab / api-token `resolveSheetCapabilitiesForUser`,
 *      the transaction-bound `resolveSheetCapabilitiesForUserOnQuery`, and so the `/context` composition);
 *   2. the whole-sheet export route (`GET /sheets/:sheetId/export-xlsx`, both `xlsx` and `?format=csv`)
 *      answers 403 {@link GRID_EXPORT_CLOSED_REFUSAL} to a caller who can READ the sheet (a non-reader keeps the
 *      plain values-free 403 and learns nothing);
 *   3. copy-sheet WITH DATA refuses a closed source (structure-only copy stays open);
 *   4. `/context` carries `capabilities.gridExportClosure = { reason }` on a closed sheet ONLY, so the workbench
 *      can render its export buttons disabled with the reason and re-check before it generates a selected-rows
 *      CSV / XLSX in the browser. Every other sheet's `/context` is byte-identical to before.
 *
 * THE BOUNDARY — WHAT IT DOES NOT CLOSE (stated, not hidden; review round 1 boundary decision, T layer,
 * Ratified-by-default-2026-10-23, owner may veto within 24h). The closure covers ONLY the pilot sheet's OWN generic
 * file exports: its whole-sheet and selected-row CSV / Excel. These stay open and are NOT a formal hand-off basis —
 * the same class as print (`window.print`) and copy-selection:
 *   - values DERIVED INTO OTHER, ORDINARY sheets through link / lookup / formula. A formula over a lookup into the
 *     pilot sheet is materialized into the other sheet's records and that sheet's export carries it (confirmed by
 *     execution); a plain lookup column may hydrate on some export branches. Not closed on purpose: the owner's
 *     decision reads 「其他普通表不受影响」, and blanking derived values elsewhere would silently break legitimate
 *     summary / dashboard sheets. There is deliberately NO taint drop for it in maskStoredRecordFieldIds;
 *   - automation egress from the pilot sheet (send_webhook and the other outbound actions);
 *   - API JSON reads and the other reads (`/view`, record reads, OAPI token reads, collaboration).
 * The project-material export (plugin side) is the formal hand-off and is untouched.
 *
 * THE STAMP CAN ONLY TAKE EXPORT AWAY. Nothing reads it to grant anything, and core-backend/src has no verb that
 * clears it (no reopen / unset port, service or route). The only writer in core-backend/src is
 * services/sheet-grid-export-closure-service.ts, reached through the plugin-only port
 * `provisioning.closeSheetGridExport` (plugin-scope.ts). KNOWN BYPASS, same posture as `system_kind`: every plugin's
 * raw `database.query` handle could UPDATE the column directly; the one-writer census
 * (tests/unit/multitable-grid-export-closure.test.ts S-07) scans core-backend/src AND plugins/, so a plugin that
 * writes the column instead of calling the port reds there.
 *
 * THE LOOKUP ({@link loadGridExportClosedSheetIds}):
 *   - COLUMN-TOLERANT (`to_jsonb(meta_sheets) ->> 'grid_export_closure'`): a database where the migration has not
 *     run answers "not closed" for every sheet instead of 42703 — a missing column can never block an unrelated
 *     sheet. (It cannot open anything either: without the column no sheet can carry a stamp.)
 *   - ID-PREFILTERED: a closed sheet is a plugin-provisioned project sheet, whose id is ALWAYS the host-derived
 *     `getObjectSheetId(project, object)` = `sheet_` + 24 lowercase hex; the close service refuses any other id,
 *     and `POST /sheets` / `GET /view?seed=true` refuse to mint that shape. So an id outside the pattern cannot be
 *     closed and the lookup issues NO statement for it. NOT every derived-shape sheet is a project sheet:
 *     template-installed sheets (template-library stableChildId), plugin sheets, People and the projections share
 *     the shape. For them the capability resolvers pay NO extra statement either, because they read both host
 *     stamps (overview kind + closure) in ONE statement (`loadStockPreparationSheetStamps`, review round 1 fix 2):
 *     derived-id sheets stay at the one statement the overview lookup already cost, client-id sheets at zero.
 *     The lookup runs before `canRead` is decided, as the overview lookup always has.
 *   - No `deleted_at` filter: a soft-deleted closed sheet stays closed (it can only refuse more).
 *   - Errors other than the tolerated missing column PROPAGATE (fail closed, the overview lookup's posture).
 *
 * No heavy imports: required by the capability resolvers, the export route, copy-sheet and the scope wrapper.
 */
import {
  STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND,
  isStockPreparationOverviewSheetIdCandidate,
} from './stock-preparation-overview-contract'

/** The closed set of closure reasons (the migration's CHECK holds the same list). */
export const GRID_EXPORT_CLOSURE_REASON_STOCK_PREP_PILOT = 'stock_prep_pilot' as const
export type GridExportClosureReason = typeof GRID_EXPORT_CLOSURE_REASON_STOCK_PREP_PILOT

/** The refusal code of every closed generic export path. */
export const MULTITABLE_GRID_EXPORT_CLOSED_CODE = 'MULTITABLE_GRID_EXPORT_CLOSED'

/** The user-facing copy (plan U09; design "Code/copy"). Also rendered by the workbench (apps/web). */
export const MULTITABLE_GRID_EXPORT_CLOSED_MESSAGE =
  '这是试点备料表，通用导出（整表、选中行、CSV、Excel）已关闭。正式交接请用「项目物料导出」；打印和复制选区不能作为交接依据。'

/** Values-free 403 body of the closed whole-sheet export (xlsx and csv). */
export const GRID_EXPORT_CLOSED_REFUSAL = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    code: MULTITABLE_GRID_EXPORT_CLOSED_CODE,
    message: MULTITABLE_GRID_EXPORT_CLOSED_MESSAGE,
    details: Object.freeze({ reason: GRID_EXPORT_CLOSURE_REASON_STOCK_PREP_PILOT }),
  }),
})

/** The `/context` marker, sent inside `capabilities` on a closed sheet only. */
export const GRID_EXPORT_CLOSURE_CONTEXT_MARKER = Object.freeze({ reason: GRID_EXPORT_CLOSURE_REASON_STOCK_PREP_PILOT })

/** True iff `sheetId` has the only shape a closed sheet can have (the host-derived id). Pure, no IO. */
export function isGridExportClosureSheetIdCandidate(sheetId: unknown): sheetId is string {
  return isStockPreparationOverviewSheetIdCandidate(sheetId)
}

/**
 * Pure. On a closed sheet force `canExport` false and leave every other key exactly as resolved; off a closed
 * sheet return the input unchanged (same object). Takes no admin parameter: the closure applies to everyone.
 */
export function restrictGridExportCapabilities<T extends { canExport: boolean }>(caps: T, isClosed: boolean): T {
  if (!isClosed) return caps
  return { ...caps, canExport: false }
}

export type GridExportClosureQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/** The lookup statement, exported so tests and fakes match it exactly. */
export const GRID_EXPORT_CLOSED_SHEET_IDS_SQL =
  `SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND (to_jsonb(meta_sheets) ->> 'grid_export_closure') IS NOT NULL`

/**
 * Of the given sheet ids, which carry a grid-export closure. Ids outside the derived-id shape are dropped BEFORE
 * the statement; no candidate left → empty set, no query.
 */
export async function loadGridExportClosedSheetIds(
  query: GridExportClosureQueryFn,
  sheetIds: readonly unknown[],
): Promise<Set<string>> {
  if (!Array.isArray(sheetIds) || sheetIds.length === 0) return new Set()
  const candidates = [...new Set(sheetIds.filter(isGridExportClosureSheetIdCandidate))]
  if (candidates.length === 0) return new Set()
  const result = await query(GRID_EXPORT_CLOSED_SHEET_IDS_SQL, [candidates])
  const ids = new Set<string>()
  for (const row of result.rows as Array<{ id?: unknown }>) {
    if (typeof row?.id === 'string') ids.add(row.id)
  }
  return ids
}

/**
 * ONE statement for both host stamps a capability resolver needs: the stock-preparation overview kind and the
 * grid-export closure (review round 1, fix 2). The three resolvers used to ask the overview lookup and then this
 * module's lookup — two statements for every derived-id sheet (template-installed sheets, plugin sheets, People and
 * projections all share the `sheet_` + 24 hex shape). Folded, a derived-id sheet costs exactly the one statement it
 * cost before this feature, and a client-id sheet still costs none. Same table, same derived-id prefilter, same
 * column tolerance (`to_jsonb`) for both keys; only rows carrying at least one stamp come back.
 */
export const STOCK_PREPARATION_SHEET_STAMPS_SQL =
  `SELECT id, ((to_jsonb(meta_sheets) ->> 'system_kind') = $2) AS stock_prep_overview, ((to_jsonb(meta_sheets) ->> 'grid_export_closure') IS NOT NULL) AS grid_export_closed FROM meta_sheets WHERE id = ANY($1::text[]) AND ((to_jsonb(meta_sheets) ->> 'system_kind') = $2 OR (to_jsonb(meta_sheets) ->> 'grid_export_closure') IS NOT NULL)`

export interface StockPreparationSheetStamps {
  overviewSheetIds: Set<string>
  gridExportClosedSheetIds: Set<string>
}

/** The resolvers' lookup: which of these sheets is the overview, which is closed for grid export. */
export async function loadStockPreparationSheetStamps(
  query: GridExportClosureQueryFn,
  sheetIds: readonly unknown[],
): Promise<StockPreparationSheetStamps> {
  const stamps: StockPreparationSheetStamps = { overviewSheetIds: new Set(), gridExportClosedSheetIds: new Set() }
  if (!Array.isArray(sheetIds) || sheetIds.length === 0) return stamps
  const candidates = [...new Set(sheetIds.filter(isGridExportClosureSheetIdCandidate))]
  if (candidates.length === 0) return stamps
  const result = await query(STOCK_PREPARATION_SHEET_STAMPS_SQL, [candidates, STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND])
  for (const row of result.rows as Array<{ id?: unknown; stock_prep_overview?: unknown; grid_export_closed?: unknown }>) {
    if (typeof row?.id !== 'string') continue
    if (row.stock_prep_overview === true) stamps.overviewSheetIds.add(row.id)
    if (row.grid_export_closed === true) stamps.gridExportClosedSheetIds.add(row.id)
  }
  return stamps
}

/** Convenience: is this one sheet closed. Same lookup, same tolerance. */
export async function isSheetGridExportClosed(query: GridExportClosureQueryFn, sheetId: string): Promise<boolean> {
  return (await loadGridExportClosedSheetIds(query, [sheetId])).has(sheetId)
}

/**
 * Refusal raised by the host port / service. Values-free details: which rule refused.
 *   - `not_derived_sheet`: the sheet id is not of the host-derived shape (the port only stamps project sheets);
 *   - `unavailable`: the database has no closure column yet (migration not run) — 503, retry after migrating.
 */
export class SheetGridExportClosureError extends Error {
  readonly status: number
  readonly code: string
  readonly details: { reason: 'not_derived_sheet' | 'unavailable' }

  constructor(reason: 'not_derived_sheet' | 'unavailable') {
    super(reason === 'unavailable'
      ? 'The grid-export closure is not available on this server yet (migration pending)'
      : 'A grid-export closure may be stamped only on a host-provisioned project sheet')
    this.name = 'SheetGridExportClosureError'
    this.status = reason === 'unavailable' ? 503 : 422
    this.code = reason === 'unavailable' ? 'MULTITABLE_GRID_EXPORT_CLOSURE_UNAVAILABLE' : 'MULTITABLE_GRID_EXPORT_CLOSURE_SHEET_INVALID'
    this.details = { reason }
  }
}
