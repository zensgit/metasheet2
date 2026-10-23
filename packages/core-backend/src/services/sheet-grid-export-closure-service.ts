/**
 * 备料分批拉取第一期 — step 3, PR A (core): THE WRITE (and read) HALF of the sheet-level grid-export closure.
 * Read multitable/sheet-grid-export-closure.ts first: it holds what the stamp means and who enforces it.
 *
 * THE LOAD-BEARING PROPERTIES
 *   * ONE UPDATE, SET-ONCE. The only mutating statement in this file sets `grid_export_closure` to the LITERAL
 *     `'stock_prep_pilot'` with `WHERE grid_export_closure IS NULL`. The reason is not a parameter of any function
 *     here, and no statement in the host writes the column back to NULL — there is no reopen / unset verb. The unit
 *     suite pins this file's statement census and scans src/ for any other writer of the column.
 *   * IDEMPOTENT. A second call on a stamped sheet writes nothing and reports `alreadyClosed: true` with the
 *     ORIGINAL time and actor (a re-POST from the plugin repairs a missing stamp; it never moves an existing one).
 *   * ONE TRANSACTION, the same order every other sheet-config writer uses: the canonical writer fence first
 *     (`fenceWriterEntry`, flag-gated exactly as everywhere else), then the `meta_sheets` row lock + liveness
 *     (`assertSheetLiveForUpdate`, the lock copy-sheet takes on its source after its fences), then the UPDATE. So a
 *     copy-with-data that already holds the source row either commits before the stamp or re-reads it after.
 *   * DERIVED IDS ONLY. Refused before any statement unless the id has the host-derived shape — the shape the
 *     resolver lookup prefilters on, so a stamp can never land where the resolvers would not look.
 *   * MISSING COLUMN → 503 `MULTITABLE_GRID_EXPORT_CLOSURE_UNAVAILABLE` (SQLSTATE 42703 only), never a silent no-op:
 *     the plugin must not believe a sheet is closed when the server cannot close it.
 *
 * WHAT THE WRAPPER ALREADY PROVED (multitable/plugin-scope.ts `closeSheetGridExport`): the caller is
 * `plugin-integration-core`, the project namespace is its own, the objectId has the project-sheet shape, the sheet
 * id is the one derived for (projectId, objectId), and the registry records the sheet as this plugin's and this
 * project's. This file adds only what the database can answer: the sheet is live, and the stamp itself.
 */
import { fenceWriterEntry } from '../multitable/canonical-sheet-fence'
import {
  GRID_EXPORT_CLOSURE_REASON_STOCK_PREP_PILOT,
  SheetGridExportClosureError,
  isGridExportClosureSheetIdCandidate,
  type GridExportClosureReason,
} from '../multitable/sheet-grid-export-closure'
import { assertSheetLiveForUpdate } from '../multitable/sheet-liveness'

export type SheetGridExportClosureQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export interface SheetGridExportClosureState {
  sheetId: string
  /** False when no `meta_sheets` row has this id (the read port only; the close port refuses instead). */
  present: boolean
  closure: GridExportClosureReason | null
  closedAt: string | null
  closedBy: string | null
}

export interface CloseSheetGridExportResult extends SheetGridExportClosureState {
  closure: GridExportClosureReason
  /** True when the sheet already carried the stamp; nothing was written. */
  alreadyClosed: boolean
}

/** The ONE mutating statement. The reason is bound from the module literal, never from input. */
export const CLOSE_SHEET_GRID_EXPORT_SQL =
  `UPDATE meta_sheets
      SET grid_export_closure = $2, grid_export_closed_at = now(), grid_export_closed_by = $3
    WHERE id = $1 AND grid_export_closure IS NULL
    RETURNING grid_export_closure, grid_export_closed_at, grid_export_closed_by`

/** Column-tolerant read (to_jsonb): a database without the columns answers "not closed". */
export const READ_SHEET_GRID_EXPORT_CLOSURE_SQL =
  `SELECT (to_jsonb(meta_sheets) ->> 'grid_export_closure') AS grid_export_closure,
          (to_jsonb(meta_sheets) ->> 'grid_export_closed_at') AS grid_export_closed_at,
          (to_jsonb(meta_sheets) ->> 'grid_export_closed_by') AS grid_export_closed_by
     FROM meta_sheets
    WHERE id = $1`

function isUndefinedColumnError(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === '42703'
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  const text = String(value)
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString()
}

function normalizeClosure(value: unknown): GridExportClosureReason | null {
  return value === GRID_EXPORT_CLOSURE_REASON_STOCK_PREP_PILOT ? GRID_EXPORT_CLOSURE_REASON_STOCK_PREP_PILOT : null
}

function rowToState(sheetId: string, row: Record<string, unknown> | undefined): SheetGridExportClosureState {
  if (!row) return { sheetId, present: false, closure: null, closedAt: null, closedBy: null }
  const raw = row.grid_export_closure
  // A non-null value the code does not know (the CHECK forbids it) still reads as CLOSED for the resolvers;
  // here it is reported as the only reason the host can stamp, never as open.
  const closure = raw === null || raw === undefined ? null : (normalizeClosure(raw) ?? GRID_EXPORT_CLOSURE_REASON_STOCK_PREP_PILOT)
  return {
    sheetId,
    present: true,
    closure,
    closedAt: closure ? toIso(row.grid_export_closed_at) : null,
    closedBy: closure && typeof row.grid_export_closed_by === 'string' ? row.grid_export_closed_by : null,
  }
}

/**
 * Stamp `sheetId` closed for generic grid export, inside the caller's transaction. Fail-closed and set-once; see
 * the module docblock. Throws `SheetNotLiveError` for an absent / deleted sheet, `SheetWriterBlockedError` while a
 * recovery holds the sheet (fence flag on), `SheetGridExportClosureError` for a non-derived id or a missing column.
 */
export async function closeSheetGridExport(
  query: SheetGridExportClosureQueryFn,
  input: { sheetId: string; actorId?: string | null },
): Promise<CloseSheetGridExportResult> {
  const sheetId = typeof input.sheetId === 'string' ? input.sheetId.trim() : ''
  if (!isGridExportClosureSheetIdCandidate(sheetId)) throw new SheetGridExportClosureError('not_derived_sheet')
  const actorId = typeof input.actorId === 'string' && input.actorId.trim() ? input.actorId.trim() : null

  await fenceWriterEntry(query, sheetId)
  await assertSheetLiveForUpdate(query as never, sheetId)

  let updated: { rows: unknown[] }
  try {
    updated = await query(CLOSE_SHEET_GRID_EXPORT_SQL, [sheetId, GRID_EXPORT_CLOSURE_REASON_STOCK_PREP_PILOT, actorId])
  } catch (err) {
    if (isUndefinedColumnError(err)) throw new SheetGridExportClosureError('unavailable')
    throw err
  }
  const landed = (updated.rows as Array<Record<string, unknown>>)[0]
  if (landed) {
    const state = rowToState(sheetId, landed)
    return { ...state, closure: GRID_EXPORT_CLOSURE_REASON_STOCK_PREP_PILOT, alreadyClosed: false }
  }
  // Nothing updated: the row is live and locked (asserted above), so it already carries a stamp. Report it.
  const existing = await query(READ_SHEET_GRID_EXPORT_CLOSURE_SQL, [sheetId])
  const state = rowToState(sheetId, (existing.rows as Array<Record<string, unknown>>)[0])
  return { ...state, present: true, closure: state.closure ?? GRID_EXPORT_CLOSURE_REASON_STOCK_PREP_PILOT, alreadyClosed: true }
}

/** Read the stamp of one sheet. No lock, no write; column-tolerant. */
export async function readSheetGridExportClosure(
  query: SheetGridExportClosureQueryFn,
  input: { sheetId: string },
): Promise<SheetGridExportClosureState> {
  const sheetId = typeof input.sheetId === 'string' ? input.sheetId.trim() : ''
  if (!isGridExportClosureSheetIdCandidate(sheetId)) throw new SheetGridExportClosureError('not_derived_sheet')
  const result = await query(READ_SHEET_GRID_EXPORT_CLOSURE_SQL, [sheetId])
  return rowToState(sheetId, (result.rows as Array<Record<string, unknown>>)[0])
}
