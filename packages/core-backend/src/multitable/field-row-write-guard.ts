/**
 * `PATCH /fields/:fieldId` — the lost-update guard on the field row.
 *
 * The route validates a field change against a first, UNLOCKED read of the row and then writes every column (name,
 * type, property, order) from that read. Under READ COMMITTED, a change another transaction commits in between — the
 * plugin's manual-rows switch, the PLM column lock stamp, an option sync, another administrator's rename or retype —
 * is silently reverted by that UPDATE (it re-checks only its WHERE clause against the newest row version, then writes
 * the stale values on top). So the route re-reads the row WITH the row lock right before its UPDATE and compares it
 * with what it validated:
 *   - unchanged → write;
 *   - changed → the whole transaction rolls back and runs once more on fresh data (validation included);
 *   - changed again → 409 FIELD_CHANGED_CONCURRENTLY, values-free.
 *
 * Where the lock is taken matters. The re-read sits AFTER the sibling order shift, one statement before the UPDATE, so
 * the row is first locked where the UPDATE used to lock it: no new lock-order edge. Locking at the FIRST read instead
 * would hold the row through validation and the shift, and the web client's shared column drag (one PATCH per field,
 * all at once) would deadlock on it: PATCH(A) shifts B while PATCH(B) shifts A.
 *
 * `order` is deliberately NOT compared: a sibling's shift moves this row during such a drag, and comparing it would
 * turn every drag into a retry or a 409. Instead, a PATCH without `order` takes its order from the locked row, so a
 * concurrent reorder is not reverted either.
 *
 * `FOR NO KEY UPDATE`, not `FOR UPDATE`: three tables reference meta_fields(id) (meta_links, multitable_attachments,
 * meta_field_auto_number_sequences) and their inserts take FOR KEY SHARE on the parent row. FOR UPDATE would block
 * link-cell writes and attachment uploads on the column while it is held; FOR NO KEY UPDATE is exactly the lock the
 * route's own UPDATE takes (it never changes `id`), only taken one statement earlier.
 */
import { isDeepStrictEqual } from 'node:util'

/** The route's first read (unlocked). Exported so the real-DB race cases hold on the production text. */
export const PATCH_FIELD_READ_SQL = 'SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1'

/** The late re-read under the row lock. Same column list as the first read, so mocks that answer one answer both. */
export const PATCH_FIELD_LOCKED_REREAD_SQL = `${PATCH_FIELD_READ_SQL} FOR NO KEY UPDATE`

/** The first attempt plus one transparent retry on fresh data. */
export const PATCH_FIELD_MAX_ATTEMPTS = 2

export const FIELD_CHANGED_CONCURRENTLY_CODE = 'FIELD_CHANGED_CONCURRENTLY'
/** Values-free: no field id, no name, no value. */
export const FIELD_CHANGED_CONCURRENTLY_MESSAGE = '该字段刚被其他操作修改，请刷新后重试'

export class FieldChangedConcurrentlyError extends Error {
  readonly code = FIELD_CHANGED_CONCURRENTLY_CODE

  constructor() {
    super(FIELD_CHANGED_CONCURRENTLY_MESSAGE)
    this.name = 'FieldChangedConcurrentlyError'
  }
}

export interface FieldRowRecheckSnapshot {
  readonly name: string
  readonly type: string
  readonly property: unknown
}

type FieldRowLike = { name?: unknown; type?: unknown; property?: unknown }

/**
 * A deep copy of the compared columns, taken right after the first read and before any validation code can touch the
 * parsed `property` object — so an in-place change there can never look like a concurrent write.
 */
export function snapshotFieldRowForRecheck(row: FieldRowLike): FieldRowRecheckSnapshot {
  return {
    name: String(row.name ?? ''),
    type: String(row.type ?? ''),
    property: row.property === undefined ? null : structuredClone(row.property),
  }
}

/**
 * True when name, type or property differ between what the route validated and the locked re-read. `type` is the raw
 * stored string on both sides (no alias mapping). `property` is compared as the two values node-pg parsed from jsonb,
 * so key order and number formatting cannot cause a false mismatch. `order` is not compared (see the module header).
 */
export function fieldRowChangedSince(validated: FieldRowRecheckSnapshot, locked: FieldRowLike): boolean {
  if (validated.name !== String(locked.name ?? '')) return true
  if (validated.type !== String(locked.type ?? '')) return true
  return !isDeepStrictEqual(validated.property, locked.property === undefined ? null : locked.property)
}

/**
 * Run one whole PATCH transaction; when it rolls back with `FieldChangedConcurrentlyError`, run it once more (validation
 * included, on fresh data). A second conflict propagates (→ 409). Any other error propagates at once.
 */
export async function withFieldRowRecheckRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let n = 1; ; n += 1) {
    try {
      return await attempt()
    } catch (err) {
      if (!(err instanceof FieldChangedConcurrentlyError) || n >= PATCH_FIELD_MAX_ATTEMPTS) throw err
    }
  }
}
