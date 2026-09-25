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
 * The verdict, written ONCE. Every arity and every lock mode below maps the SAME row shape to the SAME
 * three outcomes through this function, so a new caller cannot arrive with a second, subtly different
 * idea of what "live" means (a `!row.deleted_at` that also swallows the empty string, say).
 */
function livenessOfRow(row: { deleted_at?: unknown } | undefined): SheetLiveness {
  if (!row) return 'absent'
  return row.deleted_at === null || typeof row.deleted_at === 'undefined' ? 'live' : 'deleted'
}

/**
 * One query, three outcomes. `deleted_at` is read rather than filtered so `deleted` and `absent` stay
 * distinguishable — a filtered `WHERE deleted_at IS NULL` collapses them and loses the actionable half.
 */
export async function loadSheetLiveness(query: LivenessQuery, sheetId: string): Promise<SheetLiveness> {
  if (typeof sheetId !== 'string' || sheetId.length === 0) return 'absent'
  const res = await query('SELECT deleted_at FROM meta_sheets WHERE id = $1', [sheetId])
  return livenessOfRow((res.rows as Array<{ deleted_at?: unknown } | undefined>)[0])
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
    result.set(row.id, livenessOfRow(row))
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
 * The ONE statement text every sheet-row lock in a permission write transaction issues (#5938).
 *
 * EXPORTED because it is observable: a real-DB test that proves a writer is PARKED on this row reads
 * `pg_stat_activity.query` and matches it by TEXT (the pool passes `text: sql` through verbatim —
 * integration/db/connection-pool.ts `buildQueryConfig`). A hard-coded copy of this string in such a
 * probe goes silently BLIND the day the statement is reworded: the probe matches nothing, the waiter
 * count never reaches its floor, and the property "the writer parks on its sheet row" stops being
 * verified rather than failing loudly. Probes therefore DERIVE their `LIKE` pattern from this constant
 * — see tests/integration/multitable-exact-anchor-route-wiring-realdb.test.ts (waiter contract) and the
 * structural guard that pins the derivation.
 */
export const SHEET_ROW_LOCK_LIVENESS_SQL = 'SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE'

/**
 * The SAME question, asked UNDER the row lock — the ONE statement that both LOCKS the `meta_sheets` row
 * and reads its `deleted_at` (#5938).
 *
 * ── Why a pre-transaction gate is not enough ──────────────────────────────────
 * The sheet-addressed write paths gate on {@link loadSheetLiveness} through `resolveSheetCapabilities`,
 * OUTSIDE the transaction, and then open a transaction that takes `meta_sheets … FOR UPDATE` before
 * writing. Both halves are correct and the pair still leaves a TOCTOU window, because the lock is not a
 * time machine: if the soft delete COMMITS between the gate's read and the lock request, the lock is
 * already free — the writer neither waits for it nor sees the pre-delete row version. It acquires the
 * lock on a row whose `deleted_at` is now set and writes anyway. Soft delete is a plain UPDATE in its
 * own transaction, so this is an ordinary interleaving, not a rare one.
 *
 * Locking and re-reading in ONE statement is what closes it: after `FOR UPDATE` returns, no concurrent
 * soft delete can commit until this transaction ends, and the `deleted_at` this statement returns is the
 * value at that moment. A caller that refuses on anything but `live` therefore cannot write to a sheet
 * that is dead at write time — and a caller cannot take the lock while forgetting the re-read, because
 * there is no longer a lock-only statement to take.
 *
 * ── How to refuse ─────────────────────────────────────────────────────────────
 * Use {@link assertSheetLiveForUpdate} unless the caller genuinely needs the three-way verdict: throwing
 * out of the transaction callback is what rolls it back, so the refusal cannot leave a partial write
 * behind. Route callers map the thrown {@link SheetNotLiveError} to `sendSheetNotLive(res, err.liveness)`
 * — the SAME values-free 404 bodies their pre-transaction gate answers, so the two refusals are
 * indistinguishable to a client and the window cannot be probed for existence either.
 *
 * `query` MUST be the transaction client's own query (the one holding the lock), never the pool-level
 * `query`: a pool-level re-read runs on a DIFFERENT connection, takes a SECOND, independent lock, and
 * proves nothing about the row this transaction is about to write.
 */
export async function loadSheetLivenessForUpdate(query: LivenessQuery, sheetId: string): Promise<SheetLiveness> {
  if (typeof sheetId !== 'string' || sheetId.length === 0) return 'absent'
  const res = await query(SHEET_ROW_LOCK_LIVENESS_SQL, [sheetId])
  return livenessOfRow((res.rows as Array<{ deleted_at?: unknown } | undefined>)[0])
}

/**
 * Lock the sheet row and REFUSE unless it is still live — the single call a write transaction makes
 * where it used to take a lock-only `SELECT 1 … FOR UPDATE` (#5938).
 *
 * Throwing (rather than returning a verdict) is deliberate: it rolls the transaction back and makes
 * "took the lock but forgot to act on the answer" unwritable at this seam.
 */
export async function assertSheetLiveForUpdate(query: LivenessQuery, sheetId: string): Promise<void> {
  const liveness = await loadSheetLivenessForUpdate(query, sheetId)
  if (liveness === 'live') return
  throw new SheetNotLiveError(sheetId, liveness)
}

/**
 * The MULTI-sheet form of {@link SHEET_ROW_LOCK_LIVENESS_SQL}: ONE statement that locks every named
 * `meta_sheets` row AND reads each one's `deleted_at` under that lock (#5954).
 *
 * `ORDER BY id COLLATE "C"` is what makes the ACQUISITION order deterministic. `FOR UPDATE` locks rows in
 * the order the plan emits them, and the lock step sits above the sort, so without an ORDER BY the order
 * is whatever the scan happens to produce (index order, or heap order for a seq/bitmap scan) — sorting the
 * parameter array alone never governed it. `"C"` is byte order, which for the ASCII ids sheets carry is
 * exactly JS `Array#sort` order — the order every other ordered sheet locker already uses
 * (`acquireCanonicalSheetFencesInOrder`, `lockRecordLinkTargetSheetsOnQuery`). The database's default
 * collation would NOT be: under a non-C locale it can order two ids differently from those lockers, which
 * is how two transactions come to wait on each other.
 *
 * EXPORTED for the same reason as the single-id constant: the real-DB race test proves the caller PARKS on
 * this statement by matching `pg_stat_activity.query`, and derives that pattern from here rather than from
 * a copy that could go blind.
 */
export const SHEETS_ROW_LOCK_LIVENESS_SQL = 'SELECT id, deleted_at FROM meta_sheets WHERE id = ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE'

/**
 * Lock SEVERAL sheet rows and REFUSE unless every one of them is still live — the multi-sheet counterpart
 * of {@link assertSheetLiveForUpdate}, for a write transaction that gates on more than one sheet (#5954:
 * `POST /crossbase/mirror-link` writes an edge between two sheets and used to lock both with a lock-only
 * `SELECT id … FOR UPDATE` that never looked at `deleted_at`).
 *
 * Same window, same closure: a soft delete that commits between the caller's pre-transaction gate and this
 * lock leaves the lock FREE, so only a read made UNDER the lock can see it. Same verdict function, so
 * "live" means exactly what it means for one sheet. Same refusal ({@link SheetNotLiveError}), so a route
 * maps it to the SAME values-free 404 bodies via `sendSheetNotLive(res, err.liveness)`.
 *
 * - Ids are de-duplicated and sorted before they are sent, and the statement locks in that same order.
 * - An id with no row is `absent`; a row with `deleted_at` set is `deleted`. A row for an id that was NOT
 *   asked about cannot vouch for one that was: verdicts are looked up by the requested id only.
 * - A non-string or empty id is `absent` — refused, never skipped. Skipping it would lock fewer sheets than
 *   the caller named and report success.
 * - When more than one sheet is dead, the refusal names the FIRST dead one in the CALLER'S order, so a
 *   caller that passes its ids in the order its own pre-transaction gates ran gets the same verdict under
 *   the lock that those gates would have given at that moment.
 * - An empty list is a caller bug, not a request: it throws a values-free TypeError rather than locking
 *   nothing and passing.
 *
 * `query` MUST be the transaction client's own query — see {@link loadSheetLivenessForUpdate}.
 */
export async function assertSheetsLiveForUpdate(query: LivenessQuery, sheetIds: readonly string[]): Promise<void> {
  if (!Array.isArray(sheetIds) || sheetIds.length === 0) throw new TypeError('SHEET_LIVENESS_NO_SHEET_IDS')
  const verdicts = new Map<string, SheetLiveness>()
  const callerOrder: Array<{ sheetId: string; valid: boolean }> = []
  for (const sheetId of sheetIds) {
    const valid = typeof sheetId === 'string' && sheetId.length > 0
    callerOrder.push({ sheetId: typeof sheetId === 'string' ? sheetId : '', valid })
    if (valid && !verdicts.has(sheetId)) verdicts.set(sheetId, 'absent')
  }
  const lookups = [...verdicts.keys()].sort()
  if (lookups.length > 0) {
    const res = await query(SHEETS_ROW_LOCK_LIVENESS_SQL, [lookups])
    for (const row of res.rows as Array<{ id?: unknown; deleted_at?: unknown } | undefined>) {
      if (!row || typeof row.id !== 'string' || !verdicts.has(row.id)) continue
      verdicts.set(row.id, livenessOfRow(row))
    }
  }
  for (const { sheetId, valid } of callerOrder) {
    const liveness: SheetLiveness = valid ? (verdicts.get(sheetId) ?? 'absent') : 'absent'
    if (liveness !== 'live') throw new SheetNotLiveError(sheetId, liveness)
  }
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
