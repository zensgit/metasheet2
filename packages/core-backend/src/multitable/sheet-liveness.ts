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

/** The absent-sheet refusal. Values-free by construction — no id, so it cannot become an oracle. */
export const SHEET_NOT_FOUND_MESSAGE = 'Sheet not found'

type LivenessQuery = (text: string, params: unknown[]) => Promise<{ rows: unknown[] }>

/** Thrown by {@link assertSheetLive} so service-layer callers (Yjs bridge, automations) can refuse too. */
export class SheetNotLiveError extends Error {
  readonly sheetId: string
  readonly liveness: Exclude<SheetLiveness, 'live'>
  readonly code: string

  constructor(sheetId: string, liveness: Exclude<SheetLiveness, 'live'>) {
    // VALUES-FREE: the message never echoes the requested id. `sheetId` is carried as a FIELD for
    // callers that need it (logging, metrics), never interpolated into anything a caller can observe.
    // The #L5-wire no-leak golden pins this: a refusal that pastes the id back is an existence oracle,
    // and an owner fix (2026-08-25) had already removed exactly that from the checkpoint route.
    super(liveness === 'deleted' ? SHEET_DELETED_MESSAGE : SHEET_NOT_FOUND_MESSAGE)
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

/**
 * The SAME question, asked about MANY sheets in ONE round trip.
 *
 * It lives next to {@link loadSheetLiveness} on purpose: the column read (`deleted_at`), the
 * comparison (`deleted_at IS NULL ⇒ live`, anything else ⇒ `deleted`) and the "no row ⇒ absent"
 * verdict are written ONCE here for both arities, so a batched caller cannot end up with a second,
 * subtly different definition of "live".
 *
 * Why it exists: the template-keyed approval rule loaders resolve liveness for every sheet a
 * template's rules sit on. Asking per sheet made the cost of ONE approval event scale with the
 * number of DISTINCT sheets (serially, each checkout able to wait out the pool timeout), on a path
 * whose caller holds a durable lease. One round trip makes that cost constant.
 *
 * Every id passed in gets an entry: ids with no `meta_sheets` row — and ids that are not usable
 * strings, matching {@link loadSheetLiveness}'s own guard — map to `absent`.
 */
export async function loadSheetLivenessBatch(
  query: LivenessQuery,
  sheetIds: readonly string[],
): Promise<Map<string, SheetLiveness>> {
  const result = new Map<string, SheetLiveness>()
  const lookups: string[] = []
  for (const sheetId of sheetIds) {
    if (typeof sheetId !== 'string' || sheetId.length === 0) {
      if (typeof sheetId === 'string') result.set(sheetId, 'absent')
      continue
    }
    if (!result.has(sheetId)) {
      result.set(sheetId, 'absent')
      lookups.push(sheetId)
    }
  }
  if (lookups.length === 0) return result
  const res = await query('SELECT id, deleted_at FROM meta_sheets WHERE id = ANY($1::text[])', [lookups])
  for (const row of res.rows as Array<{ id?: unknown; deleted_at?: unknown } | undefined>) {
    if (!row || typeof row.id !== 'string') continue
    result.set(row.id, row.deleted_at === null || typeof row.deleted_at === 'undefined' ? 'live' : 'deleted')
  }
  return result
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

/**
 * Shapes a driver error may take on the way into a log line, and nothing else: an identifier-shaped
 * constructor name, and an identifier-shaped `code` (a SQLSTATE such as `57014`, or an errno such as
 * `ECONNREFUSED`).
 */
const LOOKUP_ERROR_CLASS_SHAPE = /^[A-Za-z_$][\w$]{0,63}$/
const LOOKUP_ERROR_CODE_SHAPE = /^[0-9A-Z_]{2,32}$/

/**
 * Values-free description of a FAILED liveness lookup, for the log line of a caller that fails closed.
 *
 * It lives beside {@link loadSheetLiveness} because every fail-closed caller of that lookup needs the
 * same line and must not be tempted to log the error itself: `message` / `detail` / `hint` can carry
 * connection strings and row values, so only the constructor name and a code-shaped `code` come out.
 * Shared by the async bulk-fill worker (#5832, services/ai-bulk-job-service.ts `jobSheetIsLive`) and
 * the inline bulk-preview loop (#5838, routes/multitable-ai.ts), so the two lanes cannot drift into
 * two different ideas of what is safe to print.
 */
export function describeLivenessLookupError(err: unknown): { errorClass: string; errorCode?: string } {
  let errorClass: string = typeof err
  if (err instanceof Error) {
    const ctorName = (err as { constructor?: { name?: unknown } }).constructor?.name
    errorClass = typeof ctorName === 'string' && LOOKUP_ERROR_CLASS_SHAPE.test(ctorName)
      ? ctorName
      : LOOKUP_ERROR_CLASS_SHAPE.test(err.name) ? err.name : 'Error'
  }
  const code = err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' && LOOKUP_ERROR_CODE_SHAPE.test(code) ? { errorClass, errorCode: code } : { errorClass }
}
