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
 * The MULTI-sheet row lock: ONE statement that locks every named `meta_sheets` row, in `id` order, AND reads
 * each row's `deleted_at` (#5954).
 *
 * EXPORTED for the same reason as {@link SHEET_ROW_LOCK_LIVENESS_SQL}: a real-DB probe that proves a writer is
 * PARKED on these rows can derive its pattern from this text instead of copying it.
 *
 * `ORDER BY id` is what makes the lock order deterministic. Passing a sorted array to `= ANY($1)` does not:
 * the row-lock order is the order the plan hands rows to the lock step, which for a sequential scan is the
 * physical order, not the array order. With `ORDER BY` the rows are sorted BEFORE they are locked, so every
 * caller of this statement acquires the same set of rows in the same order — two concurrent multi-sheet
 * writers on the same pair cannot each hold one row and wait for the other.
 *
 * `COLLATE "C"` makes that order the SAME order the JS-sorted sheet lockers use. A bare `ORDER BY id` sorts
 * by the column's collation, which is the database default — and on a non-C database (an ICU locale, or the
 * Chinese libc locale a deployment may run) `'sheet_a' < 'sheet_B'`, while JS code-unit order (`.sort()`,
 * `a < b`) puts `'sheet_B'` first. `lockRecordLinkTargetSheetsOnQuery` (services/approval-record-link-txn-auth.ts)
 * takes `meta_sheets … FOR SHARE` one id at a time in JS order; against it, a collation-ordered lock here
 * takes the rows in the OPPOSITE order and the two transactions deadlock (40P01) — measured on real Postgres
 * with an ICU en-US collation, and pinned by the real-DB suite
 * (tests/integration/multitable-crossbase-mirror-writethrough-concurrency-realdb.test.ts). `"C"` is byte order,
 * which for the ASCII ids sheets carry is exactly JS order — the order `acquireCanonicalSheetFencesInOrder`
 * (multitable/canonical-sheet-fence.ts) takes its fences in as well — whatever the database's locale is.
 */
export const SHEETS_ROW_LOCK_LIVENESS_SQL =
  'SELECT id, deleted_at FROM meta_sheets WHERE id = ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE'

/**
 * {@link loadSheetLivenessForUpdate} for SEVERAL sheets locked together — the verdict for each, read UNDER the
 * row locks this transaction now holds (#5954).
 *
 * Why a multi-id arity at all: a write that spans two sheets (the cross-base mirror op writes an edge whose
 * ends live on two sheets) must lock both rows in one deterministic order. Two single-id calls would lock
 * them in CALLER order, and two writers that name the pair in opposite orders would deadlock. This takes the
 * locks in ONE statement, in byte (JS) id order, and still reads every row's `deleted_at` under its lock — the
 * lock-only `SELECT id … = ANY($1) … FOR UPDATE` it replaces took the locks and never looked, which is the
 * #5938 TOCTOU window on two rows at once.
 *
 * Every id passed in gets an entry: ids with no `meta_sheets` row, and ids that are not usable strings
 * (matching {@link loadSheetLivenessForUpdate}'s own guard, and never sent to the database), map to
 * `absent`. Duplicates are locked once. The verdict per row comes from the SAME `livenessOfRow` every other
 * arity uses.
 *
 * `query` MUST be the transaction client's own query — see {@link loadSheetLivenessForUpdate}.
 */
export async function loadSheetsLivenessForUpdate(
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
  lookups.sort()
  const res = await query(SHEETS_ROW_LOCK_LIVENESS_SQL, [lookups])
  for (const row of res.rows as Array<{ id?: unknown; deleted_at?: unknown } | undefined>) {
    if (!row || typeof row.id !== 'string' || !result.has(row.id)) continue
    result.set(row.id, livenessOfRow(row))
  }
  return result
}

/**
 * Lock EVERY named sheet row and REFUSE unless ALL of them are still live — the multi-sheet counterpart of
 * {@link assertSheetLiveForUpdate} (#5954).
 *
 * Throws {@link SheetNotLiveError} for the FIRST non-live id in the CALLER's order. The lock order is not the
 * caller's order (it is byte `id` order, see {@link SHEETS_ROW_LOCK_LIVENESS_SQL}); the caller's order only
 * decides WHICH refusal is reported when more than one sheet died, so a route can keep the same precedence its
 * pre-transaction gate uses. Either way the refusal is the values-free one: the error message never carries
 * an id, and routes map it through `sendSheetNotLive(res, err.liveness)`.
 *
 * An EMPTY list is a caller bug, not a request: it would lock nothing and pass. It throws a values-free
 * `TypeError('SHEET_LIVENESS_NO_SHEET_IDS')` before any statement is issued, so the transaction rolls back
 * instead of writing under no lock at all.
 */
export async function assertSheetsLiveForUpdate(query: LivenessQuery, sheetIds: readonly string[]): Promise<void> {
  if (!Array.isArray(sheetIds) || sheetIds.length === 0) throw new TypeError('SHEET_LIVENESS_NO_SHEET_IDS')
  const verdicts = await loadSheetsLivenessForUpdate(query, sheetIds)
  for (const sheetId of sheetIds) {
    const liveness = verdicts.get(sheetId) ?? 'absent'
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
