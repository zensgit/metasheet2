/**
 * D-2 side-door delete RECOVERABILITY (design-lock 2026-07-09 / #4004, owner-ratified).
 *
 * The two "side-door" record hard-delete paths — plugin-SDK `records.deleteRecord` (path 3) and the
 * automation executor's `delete_record` step (path 4) — emit a delete revision since D-1 (#3969), but
 * wrote NO `meta_records_trash` row and captured NO inbound-edge tombstones. A record they destroyed was
 * therefore invisible to trash-restore and outside 4c-3's inbound-replay reach: **irrecoverable**, while
 * the same record deleted through the UI (path 1, `record-service.deleteRecord`) was fully recoverable.
 * This module is the shared seam that closes that gap for BOTH side-door lanes.
 *
 * ## Why this is NOT a copy of the reference implementation (record-service.ts:806-898)
 *
 * Two deliberate divergences, both normative in the lock — do not "fix" them toward the reference:
 *
 * 1. **Capture is nested under the D-2 flag (§1.5).** The UI path gates tombstone capture on
 *    `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` ALONE, which is correct there. Copying that here would break
 *    the D-2 flag's byte-identity promise (§1.9): an operator who has capture on today but has NOT opted
 *    into D-2 would silently start getting side-door tombstones the moment this code deploys. So capture
 *    on paths 3+4 requires BOTH `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED` AND
 *    `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` — see `isSideDoorTombstoneCaptureEnabled`, the single place
 *    the nesting rule lives (un-nesting it is what golden G6a catches).
 *
 * 2. **The trash INSERT is FAIL-CLOSED on a missing schema (§1.8/§1.11).** The reference wraps its trash
 *    INSERT in `isUndefinedTableError`/`isUndefinedColumnError` guards that SWALLOW 42P01/42703 and delete
 *    the record anyway (never-fail degradation — correct for a path that predates the flag and must not
 *    start failing on deploy ordering). Here the opposite is required: an operator who explicitly opted
 *    into recoverability must NEVER get a silently-unrecoverable delete. A 42P01 (no `meta_records_trash`)
 *    or 42703 (no `delete_revision_id` column) PROPAGATES and refuses the delete — record, links and
 *    revisions all roll back intact. This is why `insertSideDoorTrashRow` carries no try/catch: the
 *    absence of the guard IS the feature. With the D-2 flag off, no trash write is attempted at all, so
 *    the pre-migration deploy window is inert by construction (§1.9).
 *
 * ## Anchor contract (§1.2 — shared with 4c-3)
 *
 * ONE pre-generated uuid is the delete revision's id, the trash row's `delete_revision_id`, and the
 * tombstone rows' `source_revision_id` (`reason='record_delete'`). Callers MUST generate it before the
 * capture call and pass the SAME value to all three consumers; letting `recordRecordRevision`
 * self-generate its id breaks restore's ability to NAME this deletion's tombstones (goldens G2/G4).
 *
 * ## Transaction contract (§1.1, OD-7)
 *
 * Every caller MUST run inside a real transaction: capture → `DELETE FROM meta_links` → revision →
 * trash INSERT → `DELETE FROM meta_records` all commit or all roll back. Production satisfies this on
 * both lanes (plugin: `poolManager.get().transaction`, index.ts:634-653; automation: `withTransaction`
 * with the `transaction` dep supplied at automation-service.ts:840). Golden G3 is the CI guard: it
 * injects a failure at the record DELETE and at the trash INSERT and proves the whole unit rolls back.
 */
import {
  assertWithinCaptureCap,
  countInboundLinkCaptureRows,
  insertInboundLinkTombstones,
  isTombstoneCaptureEnabled,
  type TombstoneQueryFn,
} from './tombstone-capture'

/**
 * Thrown when the flag-on reordered delete is handed a NON-transactional `query`. See
 * `assertTransactionalQuery` — this is the runtime half of the OD-7 contract, and it is fail-closed:
 * the delete is refused rather than allowed to run in a shape where a mid-sequence failure would leave
 * the record alive, both link directions destroyed, and a delete revision claiming it is dead.
 */
export class MultitableSideDoorDeleteNonTransactionalError extends Error {
  code = 'NON_TRANSACTIONAL_DELETE'

  constructor(lane: 'plugin' | 'automation') {
    super(
      `D-2 (MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED) refused a ${lane} delete: the reordered ` +
        `recoverability path requires a TRANSACTIONAL query (OD-7). It was called outside a transaction, ` +
        `where a failure after the links DELETE would destroy both edge directions and emit a delete ` +
        `revision for a row that still exists — irrecoverably. Wrap the call in a transaction ` +
        `(plugin: poolManager.get().transaction; automation: supply AutomationDeps.transaction).`,
    )
    this.name = 'MultitableSideDoorDeleteNonTransactionalError'
  }
}

/**
 * OD-7, ENFORCED AT RUNTIME (not merely documented). The flag-on path REORDERS the delete so the
 * revision + trash row are written BEFORE the record DELETE; that ordering is only safe inside a real
 * transaction. The type signature of `query` cannot express "must be transactional", and the original
 * D-2 goldens could not catch a wiring regression either — they wrapped the call in their OWN
 * transaction, so they pinned the FIXTURE's transactionality, not production's (independent review of
 * #4168, P2-1: unwrapping the production transaction on either lane left all 39 goldens green). A
 * *runtime* precondition cannot be refactored away silently, which is exactly what that finding asked for.
 *
 * Detection: `txid_current()` twice. Inside one transaction both calls return the SAME transaction id;
 * outside, each statement is its own implicit transaction (and may even land on a different pooled
 * connection), so the ids differ. This is a fact about the connection's state, not a timing heuristic —
 * there is no clock-resolution or statement-ordering assumption to get wrong.
 *
 * Cost: two trivial round-trips, ONLY on the flag-on destructive path (the flag is default-OFF, and the
 * flag-off branch never calls this). A destructive, opt-in, non-hot path is exactly where a fail-closed
 * precondition is worth two round-trips.
 */
export async function assertTransactionalQuery(
  query: TombstoneQueryFn,
  lane: 'plugin' | 'automation',
): Promise<void> {
  const first = await query('SELECT txid_current()::text AS xid')
  const second = await query('SELECT txid_current()::text AS xid')
  const a = (first.rows[0] as { xid?: unknown } | undefined)?.xid
  const b = (second.rows[0] as { xid?: unknown } | undefined)?.xid
  if (typeof a !== 'string' || typeof b !== 'string' || a !== b) {
    throw new MultitableSideDoorDeleteNonTransactionalError(lane)
  }
}

/** OD-2 flag — default OFF. Off ⇒ paths 3+4 behave byte-identically to their D-1 status quo (§1.9). */
export function isSideDoorDeleteTrashEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED === 'true'
}

/**
 * §1.5 nesting rule — THE single source of truth for it. Side-door tombstone capture requires BOTH the
 * D-2 flag and the capture flag. CAPTURE-on + SIDE_DOOR-off ⇒ zero side-door tombstones (byte-identity).
 */
export function isSideDoorTombstoneCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSideDoorDeleteTrashEnabled(env) && isTombstoneCaptureEnabled(env)
}

/**
 * Capture the record's INBOUND link edges before the caller's
 * `DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1` destroys both directions.
 * No-op unless BOTH flags are on (§1.5). Fail-closed on the cap (§1.4): over-cap ⇒
 * `TombstoneCaptureCapExceededError` propagates and the caller's delete is refused — never a
 * half-captured destruction. MUST be called BEFORE the links DELETE (moving it after captures zero rows —
 * golden G2's mutation).
 */
export async function captureSideDoorInboundTombstones(
  query: TombstoneQueryFn,
  ctx: { sheetId: string; recordId: string; sourceRevisionId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isSideDoorTombstoneCaptureEnabled(env)) return
  const totalToCapture = await countInboundLinkCaptureRows(query, ctx.recordId)
  assertWithinCaptureCap(totalToCapture, env)
  await insertInboundLinkTombstones(query, ctx)
}

export type SideDoorTrashRow = {
  recordId: string
  sheetId: string
  baseId: string | null
  snapshot: Record<string, unknown> | null
  originalVersion: number
  /** Row author. NULL for machine-created records — golden G10 pins the write-own visibility consequence. */
  createdBy: string | null
  /** OD-5: plugin lane = null (actor-less SDK); automation lane = `context.actorId ?? null`. */
  deletedBy: string | null
  originalCreatedAt: Date | string | null
  originalUpdatedAt: Date | string | null
  /** §1.2 anchor — the SAME uuid used as the delete revision's id and the tombstones' source_revision_id. */
  deleteRevisionId: string
}

/**
 * Write the trash row that makes a side-door delete recoverable. Callers invoke this ONLY when
 * `isSideDoorDeleteTrashEnabled()`, inside the delete's transaction, AFTER the delete revision (so the
 * anchor exists) and BEFORE `DELETE FROM meta_records`.
 *
 * FAIL-CLOSED BY OMISSION (§1.8): there is deliberately no 42P01/42703 try/catch here. On a DB whose
 * schema predates `meta_records_trash` / `delete_revision_id`, this INSERT throws, the transaction rolls
 * back, and the delete is REFUSED (automation step `failed` / plugin error propagated) — the operator who
 * opted into recoverability gets a loud failure instead of a silently-unrecoverable delete. Golden G11.
 *
 * PRECISION (review NIT-2) — know exactly how much work the missing catch is doing, so nobody later
 * "simplifies" the goldens believing it is the only barrier. Because this runs inside a transaction (and
 * the D-2 path now REFUSES to run outside one — see `assertTransactionalQuery`), Postgres has already
 * ABORTED the transaction by the time a swallowed error would return: the subsequent
 * `DELETE FROM meta_records` would fail with 25P02 (current transaction is aborted) regardless. So adding
 * a catch here could NOT actually complete a delete — it would only DEGRADE the failure into a confusing
 * 25P02 and destroy the honest 42P01/42703 signal. The no-catch design is therefore correct AND
 * belt-and-suspenders; the goldens' `/does not exist/` message assertions are what discriminate the two,
 * and that is why they assert on the message and not merely on "the delete failed".
 */
export async function insertSideDoorTrashRow(query: TombstoneQueryFn, row: SideDoorTrashRow): Promise<void> {
  await query(
    `INSERT INTO meta_records_trash
       (record_id, sheet_id, base_id, data, original_version, created_by, deleted_by, original_created_at, original_updated_at, delete_revision_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
    [
      row.recordId,
      row.sheetId,
      row.baseId,
      JSON.stringify(row.snapshot ?? {}),
      row.originalVersion,
      row.createdBy,
      row.deletedBy,
      row.originalCreatedAt,
      row.originalUpdatedAt,
      row.deleteRevisionId,
    ],
  )
}

/**
 * Resolve the sheet's base for the trash row. OD-8: callers pass the TARGET sheet (a cross-base delete
 * trashes into the base where the record actually LIVES, not the trigger's base).
 *
 * NAMED `…ForTrash` DELIBERATELY (review P3-3): `AutomationExecutor` already has a PRIVATE METHOD called
 * `resolveSheetBaseId` with DIFFERENT semantics (it additionally filters soft-deleted sheets via
 * `deleted_at`). A bare `resolveSheetBaseId(...)` call inside that class silently resolves to whichever
 * is in scope — an identical name with different behavior, one screen apart, inside a DESTRUCTIVE
 * method. The distinct name makes the intended one unmistakable and un-shadowable.
 */
export async function resolveSheetBaseIdForTrash(query: TombstoneQueryFn, sheetId: string): Promise<string | null> {
  const res = await query('SELECT base_id FROM meta_sheets WHERE id = $1', [sheetId])
  const row = res.rows[0] as { base_id?: unknown } | undefined
  return row && typeof row.base_id === 'string' ? row.base_id : null
}
