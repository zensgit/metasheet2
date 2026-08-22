/**
 * SPIKE 2 — Mirror Publication : pure-logic prototype (Option A).
 *
 * DESIGN SPIKE. No DB, no I/O, no imports from the app. Every function here is
 * pure so it can be unit-tested without Postgres (see spike2-mirror.test.ts).
 *
 * Two cores:
 *   1. diffGenerations(prev, next, keyOf) -> keyed diff that PRESERVES meta_records.id
 *      for surviving rows (the id-stability guarantee — records have random uuid PKs,
 *      repair_meta_core_schema.ts:20-29, so ids can only be reused, never recomputed).
 *   2. publishReducer — the refresh -> publish -> propose -> approve -> apply state
 *      machine, with a mutex guard and failure/restart transitions.
 *
 * Ground truth cited in spike2-mirror-adr.md.
 */

// ---------------------------------------------------------------------------
// 1) diffGenerations
// ---------------------------------------------------------------------------

/** A row already living in meta_records: has a stable id + its data payload. */
export interface MirrorRow {
  id: string
  data: Record<string, unknown>
}

/** A candidate row from the next generation: no id yet (id is assigned/preserved by the diff). */
export interface CandidateRow {
  data: Record<string, unknown>
}

export type KeyOf<T> = (row: T) => string

export interface CreateOp {
  /** business key (for provenance / mirror_generation_row) */
  key: string
  data: Record<string, unknown>
}

export interface UpdateOp {
  /** PRESERVED meta_records.id — matched from the previous generation by key. */
  id: string
  key: string
  data: Record<string, unknown>
}

export interface InactivateOp {
  /** PRESERVED meta_records.id of a row whose key disappeared in the next generation. */
  id: string
  key: string
}

export interface UnchangedOp {
  id: string
  key: string
}

export interface GenerationDiff {
  creates: CreateOp[]
  updates: UpdateOp[]
  inactivates: InactivateOp[]
  /** Rows present + identical in both generations: emit NO automation event (acceptance #4). */
  unchanged: UnchangedOp[]
}

export class DuplicateKeyError extends Error {
  constructor(
    public readonly key: string,
    public readonly side: 'prev' | 'next',
  ) {
    super(`duplicate business key "${key}" in ${side} generation`)
    this.name = 'DuplicateKeyError'
  }
}

/** Order-independent structural equality for JSON-ish record data. */
export function stableDataEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

function indexByKey<T>(rows: readonly T[], keyOf: KeyOf<T>, side: 'prev' | 'next'): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows) {
    const key = keyOf(row)
    if (map.has(key)) throw new DuplicateKeyError(key, side)
    map.set(key, row)
  }
  return map
}

/**
 * Diff the previous (live) generation against the next (candidate) generation.
 *
 * - present in both, data changed  -> update (meta_records.id PRESERVED)
 * - present in both, data equal     -> unchanged (no write, no event)
 * - present only in next            -> create (new uuid minted at apply)
 * - present only in prev            -> inactivate (id preserved; soft-inactivate)
 *
 * keyOf must be a total, deterministic business key. Duplicate keys on either
 * side are a hard error (a mirror key must be unique — otherwise id assignment
 * is ambiguous). This is a pure function: it computes the plan, it does not apply it.
 */
export function diffGenerations(
  prevRows: readonly MirrorRow[],
  nextRows: readonly CandidateRow[],
  keyOf: KeyOf<Record<string, unknown>>,
): GenerationDiff {
  const prev = indexByKey(prevRows, (r) => keyOf(r.data), 'prev')
  const next = indexByKey(nextRows, (r) => keyOf(r.data), 'next')

  const diff: GenerationDiff = { creates: [], updates: [], inactivates: [], unchanged: [] }

  for (const [key, cand] of next) {
    const existing = prev.get(key)
    if (!existing) {
      diff.creates.push({ key, data: cand.data })
    } else if (stableDataEqual(existing.data, cand.data)) {
      diff.unchanged.push({ id: existing.id, key })
    } else {
      diff.updates.push({ id: existing.id, key, data: cand.data })
    }
  }

  for (const [key, existing] of prev) {
    if (!next.has(key)) diff.inactivates.push({ id: existing.id, key })
  }

  // Deterministic ordering for reproducible plans / tests.
  diff.creates.sort((a, b) => a.key.localeCompare(b.key))
  diff.updates.sort((a, b) => a.key.localeCompare(b.key))
  diff.inactivates.sort((a, b) => a.key.localeCompare(b.key))
  diff.unchanged.sort((a, b) => a.key.localeCompare(b.key))
  return diff
}

// ---------------------------------------------------------------------------
// 2) publish state machine :  refresh -> publish -> propose -> approve -> apply
// ---------------------------------------------------------------------------

export type PublishStatus =
  | 'idle'
  | 'refreshing'
  | 'staged'
  | 'proposed'
  | 'approved'
  | 'applied'
  | 'failed'

export interface Lock {
  token: string
  holder: string
}

export interface PublishContext {
  status: PublishStatus
  /** mutex (acceptance #10): non-null => a worker holds the binding. */
  lock: Lock | null
  /** current in-flight refresh batch (staging). A plan must NOT bind this. */
  stagingBatchId: string | null
  /** sealed generation produced by 'publish'. */
  sealedGenerationId: string | null
  /** the generation a proposed plan is bound to (acceptance #9: === sealed, !== staging). */
  planGenerationId: string | null
  /** last published/active generation (mirror_binding.active_generation_id). */
  activeGenerationId: string | null
  lastError: string | null
}

export type PublishEvent =
  | { type: 'acquire'; lock: Lock }
  | { type: 'release'; token: string }
  | { type: 'refresh'; batchId: string }
  | { type: 'publish'; generationId: string } // seal staging -> generation
  | { type: 'propose'; generationId: string } // bind plan to a SEALED generation
  | { type: 'approve' }
  | { type: 'apply' } // atomic upsert txn commits -> new gen active
  | { type: 'fail'; reason: string }
  | { type: 'resume' } // restart recovery re-entry

export function initialPublishContext(activeGenerationId: string | null = null): PublishContext {
  return {
    status: 'idle',
    lock: null,
    stagingBatchId: null,
    sealedGenerationId: null,
    planGenerationId: null,
    activeGenerationId,
    lastError: null,
  }
}

export class PublishStateError extends Error {
  constructor(
    public readonly status: PublishStatus,
    public readonly event: PublishEvent['type'],
    detail = '',
  ) {
    super(`invalid publish transition: ${event} in state ${status}${detail ? ` — ${detail}` : ''}`)
    this.name = 'PublishStateError'
  }
}

export class MutexError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'MutexError'
  }
}

/** Pure mutex acquire: only one holder at a time (acceptance #10). */
export function acquireLock(ctx: PublishContext, lock: Lock): PublishContext {
  if (ctx.lock && ctx.lock.token !== lock.token) {
    throw new MutexError(`binding locked by ${ctx.lock.holder}`)
  }
  return { ...ctx, lock }
}

/** State-mutating events require the caller to hold the lock. */
function assertHoldsLock(ctx: PublishContext, event: PublishEvent): void {
  const mutating = event.type !== 'acquire'
  if (mutating && !ctx.lock) {
    throw new MutexError(`event "${event.type}" requires the binding mutex`)
  }
}

/**
 * Pure reducer for the publish lifecycle. Every transition returns a NEW context;
 * illegal transitions throw PublishStateError. `fail` is legal from any active
 * state; `resume` restores a safe entry point after a restart.
 */
export function publishReducer(ctx: PublishContext, event: PublishEvent): PublishContext {
  assertHoldsLock(ctx, event)

  switch (event.type) {
    case 'acquire':
      return acquireLock(ctx, event.lock)

    case 'release':
      if (ctx.lock && ctx.lock.token !== event.token) {
        throw new MutexError('release token mismatch')
      }
      return { ...ctx, lock: null }

    case 'refresh':
      // Start a new refresh from idle/failed/applied (a completed cycle can start the next).
      if (!['idle', 'failed', 'applied'].includes(ctx.status)) {
        throw new PublishStateError(ctx.status, 'refresh')
      }
      return {
        ...ctx,
        status: 'refreshing',
        stagingBatchId: event.batchId,
        sealedGenerationId: null,
        planGenerationId: null,
        lastError: null,
      }

    case 'publish':
      // Seal the staging batch into a sealed generation. gen id MUST differ from staging.
      if (ctx.status !== 'refreshing') throw new PublishStateError(ctx.status, 'publish')
      if (event.generationId === ctx.stagingBatchId) {
        throw new PublishStateError(ctx.status, 'publish', 'generation id must differ from staging batch')
      }
      return { ...ctx, status: 'staged', sealedGenerationId: event.generationId }

    case 'propose':
      // ACCEPTANCE #9: bind the SEALED generation, never the staging batch.
      if (ctx.status !== 'staged') throw new PublishStateError(ctx.status, 'propose')
      if (event.generationId !== ctx.sealedGenerationId) {
        throw new PublishStateError(ctx.status, 'propose', 'plan must bind the sealed generation')
      }
      if (event.generationId === ctx.stagingBatchId) {
        throw new PublishStateError(ctx.status, 'propose', 'plan must not bind the staging batch')
      }
      return { ...ctx, status: 'proposed', planGenerationId: event.generationId }

    case 'approve':
      if (ctx.status !== 'proposed') throw new PublishStateError(ctx.status, 'approve')
      return { ...ctx, status: 'approved' }

    case 'apply':
      // The single upsert transaction committed: the sealed generation is now active.
      if (ctx.status !== 'approved') throw new PublishStateError(ctx.status, 'apply')
      return {
        ...ctx,
        status: 'applied',
        activeGenerationId: ctx.planGenerationId,
        stagingBatchId: null,
      }

    case 'fail':
      // Failure is legal from any active state; nothing was published (txn abort).
      // active generation is unchanged -> readers still see the complete old generation.
      return { ...ctx, status: 'failed', lastError: event.reason }

    case 'resume': {
      // Restart recovery (acceptance #6): map a persisted status to a safe re-entry.
      // proposed/approved plans are re-drivable idempotently; anything mid-refresh
      // is abandoned back to idle (staging is discarded, active gen untouched).
      switch (ctx.status) {
        case 'proposed':
        case 'approved':
          return ctx // resume the plan as-is
        case 'applied':
        case 'idle':
        case 'failed':
          return ctx
        case 'refreshing':
        case 'staged':
        default:
          return { ...ctx, status: 'idle', stagingBatchId: null, sealedGenerationId: null }
      }
    }

    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

/** Convenience: fold a sequence of events (pure). */
export function runPublish(ctx: PublishContext, events: readonly PublishEvent[]): PublishContext {
  return events.reduce(publishReducer, ctx)
}
