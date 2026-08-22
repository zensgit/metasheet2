/**
 * SPIKE 2 — Mirror Publication : unit tests (no DB).
 * Exercises the pure logic in spike2-mirror-prototype.ts.
 *
 * Run (illustrative — spike is not wired into the suite):
 *   npx vitest run docs/development/spikes/p0d-20260820/spike2-mirror.test.ts
 */

import { describe, expect, it } from 'vitest'
import {
  DuplicateKeyError,
  MutexError,
  PublishStateError,
  acquireLock,
  diffGenerations,
  initialPublishContext,
  publishReducer,
  runPublish,
  stableDataEqual,
  type CandidateRow,
  type MirrorRow,
  type PublishEvent,
} from './spike2-mirror-prototype'

const keyOf = (data: Record<string, unknown>) => String(data.sku)

describe('diffGenerations — keyed diff with id preservation', () => {
  const prev: MirrorRow[] = [
    { id: 'rec_A', data: { sku: 'A', qty: 1 } },
    { id: 'rec_B', data: { sku: 'B', qty: 2 } },
    { id: 'rec_C', data: { sku: 'C', qty: 3 } },
  ]

  it('preserves meta_records.id for surviving rows (acceptance #2)', () => {
    const next: CandidateRow[] = [
      { data: { sku: 'A', qty: 1 } }, // unchanged
      { data: { sku: 'B', qty: 99 } }, // changed
      { data: { sku: 'D', qty: 4 } }, // new
    ]
    const diff = diffGenerations(prev, next, keyOf)

    expect(diff.updates).toEqual([{ id: 'rec_B', key: 'B', data: { sku: 'B', qty: 99 } }])
    expect(diff.creates).toEqual([{ key: 'D', data: { sku: 'D', qty: 4 } }])
    expect(diff.inactivates).toEqual([{ id: 'rec_C', key: 'C' }])
    expect(diff.unchanged).toEqual([{ id: 'rec_A', key: 'A' }])

    // The surviving row keeps its exact id — no delete+rebuild, links stay resolvable.
    expect(diff.updates[0].id).toBe('rec_B')
  })

  it('unchanged rows produce no update and no event (acceptance #4)', () => {
    const next: CandidateRow[] = prev.map((r) => ({ data: { ...r.data } }))
    const diff = diffGenerations(prev, next, keyOf)
    expect(diff.updates).toHaveLength(0)
    expect(diff.creates).toHaveLength(0)
    expect(diff.inactivates).toHaveLength(0)
    expect(diff.unchanged.map((u) => u.id).sort()).toEqual(['rec_A', 'rec_B', 'rec_C'])
  })

  it('field-order differences are not treated as changes', () => {
    const next: CandidateRow[] = [{ data: { qty: 1, sku: 'A' } }] // reordered keys
    const diff = diffGenerations([prev[0]], next, keyOf)
    expect(diff.unchanged).toHaveLength(1)
    expect(diff.updates).toHaveLength(0)
  })

  it('full inactivation when next generation is empty', () => {
    const diff = diffGenerations(prev, [], keyOf)
    expect(diff.inactivates.map((i) => i.id)).toEqual(['rec_A', 'rec_B', 'rec_C'])
    expect(diff.creates).toHaveLength(0)
  })

  it('rejects duplicate business keys (ambiguous id assignment)', () => {
    const dupPrev: MirrorRow[] = [
      { id: 'rec_A', data: { sku: 'A' } },
      { id: 'rec_A2', data: { sku: 'A' } },
    ]
    expect(() => diffGenerations(dupPrev, [], keyOf)).toThrow(DuplicateKeyError)

    const dupNext: CandidateRow[] = [{ data: { sku: 'X' } }, { data: { sku: 'X' } }]
    expect(() => diffGenerations([], dupNext, keyOf)).toThrow(DuplicateKeyError)
  })

  it('is a pure function — inputs are not mutated', () => {
    const p = [{ id: 'rec_A', data: { sku: 'A', qty: 1 } }]
    const n = [{ data: { sku: 'A', qty: 2 } }]
    const snapP = JSON.stringify(p)
    const snapN = JSON.stringify(n)
    diffGenerations(p, n, keyOf)
    expect(JSON.stringify(p)).toBe(snapP)
    expect(JSON.stringify(n)).toBe(snapN)
  })
})

describe('stableDataEqual', () => {
  it('is order-independent and deep', () => {
    expect(stableDataEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true)
    expect(stableDataEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(stableDataEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false) // array order is significant
  })
})

describe('publishReducer — refresh -> publish -> propose -> approve -> apply', () => {
  const lock = { token: 'tok-1', holder: 'worker-1' }

  function happyPath(): PublishEvent[] {
    return [
      { type: 'acquire', lock },
      { type: 'refresh', batchId: 'stg-1' },
      { type: 'publish', generationId: 'gen-1' },
      { type: 'propose', generationId: 'gen-1' },
      { type: 'approve' },
      { type: 'apply' },
    ]
  }

  it('drives the full lifecycle and activates the published generation', () => {
    const end = runPublish(initialPublishContext(null), happyPath())
    expect(end.status).toBe('applied')
    expect(end.activeGenerationId).toBe('gen-1')
    expect(end.stagingBatchId).toBeNull()
  })

  it('plan binds the published generation, NOT the staging batch (acceptance #9)', () => {
    let ctx = runPublish(initialPublishContext(), [
      { type: 'acquire', lock },
      { type: 'refresh', batchId: 'stg-1' },
      { type: 'publish', generationId: 'gen-1' },
    ])
    // proposing the staging batch id is rejected...
    expect(() => publishReducer(ctx, { type: 'propose', generationId: 'stg-1' })).toThrow(
      PublishStateError,
    )
    // ...only the sealed generation id is accepted.
    ctx = publishReducer(ctx, { type: 'propose', generationId: 'gen-1' })
    expect(ctx.planGenerationId).toBe('gen-1')
  })

  it('publish rejects reusing the staging batch id as the generation id', () => {
    const ctx = runPublish(initialPublishContext(), [
      { type: 'acquire', lock },
      { type: 'refresh', batchId: 'stg-1' },
    ])
    expect(() => publishReducer(ctx, { type: 'publish', generationId: 'stg-1' })).toThrow(
      PublishStateError,
    )
  })

  it('rejects out-of-order transitions', () => {
    const ctx = runPublish(initialPublishContext(), [{ type: 'acquire', lock }])
    expect(() => publishReducer(ctx, { type: 'apply' })).toThrow(PublishStateError)
    expect(() => publishReducer(ctx, { type: 'approve' })).toThrow(PublishStateError)
    expect(() => publishReducer(ctx, { type: 'propose', generationId: 'gen-1' })).toThrow(
      PublishStateError,
    )
  })

  it('failure is legal from any active state and leaves the active generation untouched (acceptance #5)', () => {
    const ctx = runPublish(initialPublishContext('gen-0'), [
      { type: 'acquire', lock },
      { type: 'refresh', batchId: 'stg-2' },
      { type: 'publish', generationId: 'gen-1' },
      { type: 'propose', generationId: 'gen-1' },
      { type: 'fail', reason: 'apply txn aborted' },
    ])
    expect(ctx.status).toBe('failed')
    expect(ctx.lastError).toBe('apply txn aborted')
    // Rollback semantics: the previously-active generation is still active.
    expect(ctx.activeGenerationId).toBe('gen-0')
  })

  it('restart recovery abandons an in-flight refresh back to idle (acceptance #6)', () => {
    const midRefresh = runPublish(initialPublishContext('gen-0'), [
      { type: 'acquire', lock },
      { type: 'refresh', batchId: 'stg-3' },
    ])
    const recovered = publishReducer(midRefresh, { type: 'resume' })
    expect(recovered.status).toBe('idle')
    expect(recovered.stagingBatchId).toBeNull()
    expect(recovered.activeGenerationId).toBe('gen-0')
  })

  it('restart recovery re-drives a proposed plan idempotently', () => {
    const proposed = runPublish(initialPublishContext(), [
      { type: 'acquire', lock },
      { type: 'refresh', batchId: 'stg-1' },
      { type: 'publish', generationId: 'gen-1' },
      { type: 'propose', generationId: 'gen-1' },
    ])
    const resumed = publishReducer(proposed, { type: 'resume' })
    expect(resumed.status).toBe('proposed')
    expect(resumed.planGenerationId).toBe('gen-1')
    // and can still proceed to approve/apply
    const applied = runPublish(resumed, [{ type: 'approve' }, { type: 'apply' }])
    expect(applied.status).toBe('applied')
    expect(applied.activeGenerationId).toBe('gen-1')
  })

  it('allows a fresh refresh after a completed cycle', () => {
    const applied = runPublish(initialPublishContext(), happyPath())
    const next = publishReducer(applied, { type: 'refresh', batchId: 'stg-2' })
    expect(next.status).toBe('refreshing')
    expect(next.stagingBatchId).toBe('stg-2')
  })
})

describe('mutex (acceptance #10)', () => {
  const lockA = { token: 'a', holder: 'worker-A' }
  const lockB = { token: 'b', holder: 'worker-B' }

  it('a second holder cannot acquire while locked', () => {
    const ctx = acquireLock(initialPublishContext(), lockA)
    expect(() => acquireLock(ctx, lockB)).toThrow(MutexError)
  })

  it('the same holder re-acquiring is idempotent', () => {
    const ctx = acquireLock(initialPublishContext(), lockA)
    expect(() => acquireLock(ctx, lockA)).not.toThrow()
  })

  it('state-mutating events require the mutex', () => {
    const ctx = initialPublishContext()
    expect(() => publishReducer(ctx, { type: 'refresh', batchId: 'stg-1' })).toThrow(MutexError)
  })

  it('release requires a matching token', () => {
    const ctx = acquireLock(initialPublishContext(), lockA)
    expect(() => publishReducer(ctx, { type: 'release', token: 'wrong' })).toThrow(MutexError)
    const released = publishReducer(ctx, { type: 'release', token: 'a' })
    expect(released.lock).toBeNull()
  })
})
