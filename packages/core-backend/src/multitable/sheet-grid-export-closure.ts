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
 * WHAT IT DOES NOT CLOSE (stated, not hidden): reads (`/view`, record reads, API reads, collaboration), print
 * (`window.print`) and copy-selection. They are not file exports; the delivery note says they are not a formal
 * hand-off basis. The project-material export (plugin side) is untouched.
 *
 * THE STAMP CAN ONLY TAKE EXPORT AWAY. Nothing reads it to grant anything, and the host has no verb that clears
 * it (no reopen / unset port, service or route). The only writer is services/sheet-grid-export-closure-service.ts,
 * reached through the plugin-only port `provisioning.closeSheetGridExport` (plugin-scope.ts).
 *
 * THE LOOKUP ({@link loadGridExportClosedSheetIds}):
 *   - COLUMN-TOLERANT (`to_jsonb(meta_sheets) ->> 'grid_export_closure'`): a database where the migration has not
 *     run answers "not closed" for every sheet instead of 42703 — a missing column can never block an unrelated
 *     sheet. (It cannot open anything either: without the column no sheet can carry a stamp.)
 *   - ID-PREFILTERED: a closed sheet is a plugin-provisioned project sheet, whose id is ALWAYS the host-derived
 *     `getObjectSheetId(project, object)` = `sheet_` + 24 lowercase hex; the close service refuses any other id,
 *     and `POST /sheets` / `GET /view?seed=true` refuse to mint that shape. So an id outside the pattern cannot be
 *     closed and the lookup issues NO statement for it: an ordinary (client-id) sheet costs what it cost before.
 *   - No `deleted_at` filter: a soft-deleted closed sheet stays closed (it can only refuse more).
 *   - Errors other than the tolerated missing column PROPAGATE (fail closed, the overview lookup's posture).
 *
 * No heavy imports: required by the capability resolvers, the export route, copy-sheet and the scope wrapper.
 */
import { isStockPreparationOverviewSheetIdCandidate } from './stock-preparation-overview-contract'

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
