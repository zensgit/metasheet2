import type { MultitableCapabilities } from './sheet-capabilities'

/**
 * Record locking (design #2278 follow-up — lock_record storage contract).
 *
 * A locked record is whole-record read-only: edits and deletes are rejected unless the
 * actor `canUnlock` it. Comments are a separate path and stay allowed (decision d).
 *
 * The three columns round-trip as RECORD-LEVEL METADATA (top-level on the wire), never as
 * `data` fields — so they are NOT subject to the §2a.3 `filterRecordDataByFieldIds` masking.
 */
export interface RecordLockState {
  locked: boolean
  lockedBy: string | null
  lockedAt: string | null
}

/** The subset of a persisted record row needed to evaluate `canUnlock`. */
export interface LockableRecord {
  lockedBy: string | null
  createdBy: string | null
}

/**
 * Decision b: an actor may perform the explicit UNLOCK action when they are any one of:
 *  - the locker            (`lockedBy === actorId`)
 *  - the record owner      (`createdBy === actorId`)
 *  - a sheet admin         (`capabilities.canManageSheetAccess`)
 *
 * This gates the unlock ACTION and its frontend visibility — NOT the per-mutation edit-while-locked
 * bypass. Built purely from existing capability/system fields — zero new primitives.
 */
export function canUnlock(
  actorId: string | null,
  record: LockableRecord,
  capabilities: Pick<MultitableCapabilities, 'canManageSheetAccess'>,
): boolean {
  if (capabilities.canManageSheetAccess) return true
  if (!actorId) return false
  if (record.lockedBy === actorId) return true
  if (record.createdBy === actorId) return true
  return false
}

/**
 * Decision e — NO silent admin bypass on the WRITE/DELETE path. While a record is locked, only the
 * locker or the record owner may edit/delete it WITHOUT first unlocking. An admin (sheet-admin) is a
 * `canUnlock` layer but must explicitly unlock first — they do NOT get an implicit edit-while-locked
 * pass. This keeps the mutation path free of per-mutation admin-bypass logic (the unlock is the one
 * explicit place admin authority applies).
 *
 * Write/delete guards reject when `locked && !canEditWhileLocked(...)`.
 */
export function canEditWhileLocked(actorId: string | null, record: LockableRecord): boolean {
  if (!actorId) return false
  if (record.lockedBy === actorId) return true
  if (record.createdBy === actorId) return true
  return false
}

/** The subset of a persisted record row this guard reads to decide whether a mutation is locked-out. */
export interface LockGuardRow {
  locked?: unknown
  locked_by?: unknown
  created_by?: unknown
}

/** Normalize a raw `meta_records` row's lock-relevant columns into a `LockableRecord`. */
export function lockableFromRow(row: LockGuardRow): LockableRecord {
  return {
    lockedBy: typeof row.locked_by === 'string' ? row.locked_by : null,
    createdBy: typeof row.created_by === 'string' ? row.created_by : null,
  }
}

/**
 * THE ONE record-lock mutation gate (decision d/e/f — centralized after the rank-8 review found the lock
 * was advisory on three un-enumerated write paths + the plugin SDK). EVERY path that edits or deletes an
 * existing `meta_records` row by user/rule/plugin intent MUST route through this helper instead of
 * re-deriving the `locked && !canEditWhileLocked(...)` check inline. A future mutation path that forgets
 * it trips the durable structural guard (`multitable-record-lock-guard.guard.test.ts`).
 *
 *  - `actorId` is the EFFECTIVE actor of the mutation: the request user, the automation's actor, etc.
 *    A trusted system recompute (formula/auto-number/lookup materialization) is lock-EXEMPT by design
 *    (the lock means "read-only to USERS"); those paths deliberately do NOT call this.
 *  - An ACTOR-LESS caller (e.g. the plugin SDK, which carries no per-record actor identity) passes
 *    `actorId = null`; `canEditWhileLocked(null, …)` is always false, so a locked record is hard
 *    read-only to it — the lock can only be lifted via the explicit unlock action.
 *
 * Throws the error produced by `makeError()` (so each surface keeps its native error type / HTTP shape)
 * when the row is locked and the actor is not the locker or owner. No-ops otherwise.
 */
export function ensureRecordNotLocked(
  actorId: string | null,
  row: LockGuardRow,
  makeError: () => Error,
): void {
  if (row.locked !== true) return
  if (canEditWhileLocked(actorId, lockableFromRow(row))) return
  throw makeError()
}

/** Normalize raw DB row lock columns into the wire-facing metadata shape. */
export function mapRecordLockState(row: {
  locked?: unknown
  locked_by?: unknown
  locked_at?: unknown
}): RecordLockState {
  return {
    locked: row.locked === true,
    lockedBy: typeof row.locked_by === 'string' ? row.locked_by : null,
    lockedAt: toIsoLockTimestamp(row.locked_at),
  }
}

function toIsoLockTimestamp(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  return null
}
