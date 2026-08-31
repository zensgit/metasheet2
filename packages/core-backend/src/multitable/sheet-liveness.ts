/**
 * Sheet LIVENESS — the guard that soft delete made necessary.
 *
 * ── Why this module exists ────────────────────────────────────────────────────
 * `DELETE /sheets/:sheetId` used to be a HARD delete: the `meta_sheets` row went away and the FK
 * cascade took every `meta_records` row with it. That made every consumer safe BY CONSTRUCTION —
 * a path that addressed records by `sheetId` and never looked at `meta_sheets` still found nothing,
 * because there was nothing to find.
 *
 * Making the delete SOFT (so a restore can be complete) removed that guarantee and replaced it with
 * NOTHING. `deleted_at` only filtered the LISTING queries. Dozens of read and write paths address
 * `meta_records` by `sheet_id` and never join `meta_sheets`, so a soft-deleted sheet stayed fully
 * live to anyone holding a sheet id: the OAPI record list served its complete record set, `POST
 * /patch` kept writing to it, and those writes fired the sheet's AUTOMATIONS — a "deleted" sheet
 * could still push data outbound.
 *
 * Recoverability must not be bought with a ghost. This module is the single assertion that every
 * such path now shares.
 *
 * ── The rule ──────────────────────────────────────────────────────────────────
 * A sheet is LIVE iff a `meta_sheets` row exists for it AND `deleted_at IS NULL`. Anything else is
 * a 404: `absent` (never existed) and `deleted` (soft-deleted) are both "there is no sheet here to
 * act on". They carry DIFFERENT coded reasons, because "restore it" is actionable advice for one of
 * them and nonsense for the other.
 *
 * ── Where it does NOT belong ──────────────────────────────────────────────────
 * The restore flow itself must be able to see a deleted sheet — that is its entire purpose. Those
 * paths are exempt BY NAME (never by omission) and gated on the restore authority instead. Any new
 * exemption belongs in the PR's guarded-path table with its reason, not in a silent absence.
 */

export type SheetLiveness = 'live' | 'deleted' | 'absent'

/** Coded reason for a soft-deleted sheet. Distinct from NOT_FOUND so clients can offer the restore. */
export const SHEET_DELETED_CODE = 'SHEET_DELETED'

/**
 * Values-free, and actionable: it names the recovery route rather than leaving the caller to guess
 * why a sheet they hold an id for stopped answering.
 */
export const SHEET_DELETED_MESSAGE =
  'This sheet has been deleted. It can be restored with POST /api/multitable/sheets/{sheetId}/restore by an actor with schema authority.'

type LivenessQuery = (text: string, params: unknown[]) => Promise<{ rows: unknown[] }>

/** Thrown by {@link assertSheetLive} so service-layer callers (Yjs bridge, automations) can refuse too. */
export class SheetNotLiveError extends Error {
  readonly sheetId: string
  readonly liveness: Exclude<SheetLiveness, 'live'>
  readonly code: string

  constructor(sheetId: string, liveness: Exclude<SheetLiveness, 'live'>) {
    super(liveness === 'deleted' ? SHEET_DELETED_MESSAGE : `Sheet not found: ${sheetId}`)
    this.name = 'SheetNotLiveError'
    this.sheetId = sheetId
    this.liveness = liveness
    this.code = liveness === 'deleted' ? SHEET_DELETED_CODE : 'NOT_FOUND'
  }
}

/**
 * One query, three outcomes. `deleted_at` is read rather than filtered so `deleted` and `absent` stay
 * distinguishable — a filtered `WHERE deleted_at IS NULL` collapses them and loses the actionable half.
 */
export async function loadSheetLiveness(query: LivenessQuery, sheetId: string): Promise<SheetLiveness> {
  if (typeof sheetId !== 'string' || sheetId.length === 0) return 'absent'
  const res = await query('SELECT deleted_at FROM meta_sheets WHERE id = $1', [sheetId])
  const row = (res.rows as Array<{ deleted_at?: unknown } | undefined>)[0]
  if (!row) return 'absent'
  return row.deleted_at === null || typeof row.deleted_at === 'undefined' ? 'live' : 'deleted'
}

export async function isSheetLive(query: LivenessQuery, sheetId: string): Promise<boolean> {
  return (await loadSheetLiveness(query, sheetId)) === 'live'
}

/** Throws {@link SheetNotLiveError} unless the sheet exists and is not soft-deleted. */
export async function assertSheetLive(query: LivenessQuery, sheetId: string): Promise<void> {
  const liveness = await loadSheetLiveness(query, sheetId)
  if (liveness === 'live') return
  throw new SheetNotLiveError(sheetId, liveness)
}
