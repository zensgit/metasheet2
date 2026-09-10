import { describe, expect, it } from 'vitest'

import {
  adjustElearningCreditInTransaction,
  ELEARNING_CREDIT_ADJUSTMENT_REQUEST_HASH_VERSION,
  ELEARNING_CREDIT_INT4_MAX,
  ElearningCreditAdjustmentError,
  hashElearningCreditAdjustmentRequest,
  type AdjustElearningCreditInput,
  type ElearningCreditAdjustmentExisting,
  type ElearningCreditAdjustmentTx,
} from '../../src/services/elearning-credit-adjustment'

const ENABLED = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_INCENTIVE_ENABLED: 'true',
} as NodeJS.ProcessEnv
const ORG = 'org-adjust-secret'
const ACTOR = 'actor-adjust-secret'
const USER = 'user-adjust-secret'

function command(over: Partial<AdjustElearningCreditInput> = {}): AdjustElearningCreditInput {
  return {
    orgId: ORG,
    actorId: ACTOR,
    requestId: 'request-adjust-secret',
    userId: USER,
    points: 5,
    reason: 'reason-adjust-secret',
    ...over,
  }
}

function fakeTx(over: Partial<ElearningCreditAdjustmentTx> = {}) {
  const calls: string[] = []
  const tx: ElearningCreditAdjustmentTx = {
    lockRequest: async () => { calls.push('lockRequest') },
    loadRequest: async () => { calls.push('loadRequest'); return null },
    hasActiveMembership: async ({ userId }) => {
      calls.push(`membership:${userId}`)
      return true
    },
    lockBalance: async () => { calls.push('lockBalance'); return 10 },
    setBalance: async () => { calls.push('setBalance') },
    appendAdjustment: async () => {
      calls.push('appendAdjustment')
      return { createdAt: '2026-08-29T06:00:00.000Z' }
    },
    ...over,
  }
  return { calls, tx }
}

function existing(over: Partial<ElearningCreditAdjustmentExisting> = {}) {
  return {
    adjustmentId: '11111111-1111-4111-8111-111111111111',
    requestHash: hashElearningCreditAdjustmentRequest({
      actorId: ACTOR,
      userId: USER,
      points: 5,
      reason: 'reason-adjust-secret',
    }),
    requestHashVersion: ELEARNING_CREDIT_ADJUSTMENT_REQUEST_HASH_VERSION,
    userId: USER,
    points: 5,
    balancePoints: 15,
    createdAt: '2026-08-29T06:00:00.000Z',
    ...over,
  }
}

function expectValuesFree(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningCreditAdjustmentError)
  expect((error as ElearningCreditAdjustmentError).code).toBe(code)
  const rendered = `${String(error)}\n${error instanceof Error ? error.stack ?? '' : ''}`
  expect(rendered).not.toContain('secret')
}

describe('e-learning manual credit adjustment', () => {
  it('hashes the closed logical command without request identity', () => {
    const first = hashElearningCreditAdjustmentRequest({
      actorId: ACTOR,
      userId: USER,
      points: 5,
      reason: 'reason-adjust-secret',
    })
    const replay = hashElearningCreditAdjustmentRequest({
      reason: 'reason-adjust-secret',
      points: 5,
      userId: USER,
      actorId: ACTOR,
    })
    expect(first).toBe(replay)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it('serializes request then authority and balance before one append', async () => {
    const { calls, tx } = fakeTx({
      setBalance: async (input) => {
        calls.push('setBalance')
        expect(input).toEqual({
          orgId: ORG,
          userId: USER,
          previousBalance: 10,
          balancePoints: 15,
        })
      },
      appendAdjustment: async (input) => {
        calls.push('appendAdjustment')
        expect(input).toMatchObject({
          orgId: ORG,
          actorId: ACTOR,
          requestId: 'request-adjust-secret',
          userId: USER,
          points: 5,
          reason: 'reason-adjust-secret',
          balancePoints: 15,
          requestHashVersion: 1,
        })
        expect(input.requestHash).toMatch(/^[0-9a-f]{64}$/)
        return { createdAt: '2026-08-29T06:00:00.000Z' }
      },
    })

    await expect(adjustElearningCreditInTransaction(tx, command(), ENABLED))
      .resolves.toEqual({
        adjustmentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        userId: USER,
        points: 5,
        balancePoints: 15,
        createdAt: '2026-08-29T06:00:00.000Z',
        duplicate: false,
      })
    expect(calls).toEqual([
      'lockRequest',
      'loadRequest',
      `membership:${ACTOR}`,
      `membership:${USER}`,
      'lockBalance',
      'setBalance',
      'appendAdjustment',
    ])
  })

  it('replays the same request without rechecking membership or touching balance', async () => {
    const { calls, tx } = fakeTx({ loadRequest: async () => {
      calls.push('loadRequest')
      return existing()
    } })
    await expect(adjustElearningCreditInTransaction(tx, command(), ENABLED))
      .resolves.toEqual({
        adjustmentId: '11111111-1111-4111-8111-111111111111',
        userId: USER,
        points: 5,
        balancePoints: 15,
        createdAt: '2026-08-29T06:00:00.000Z',
        duplicate: true,
      })
    expect(calls).toEqual(['lockRequest', 'loadRequest'])
  })

  it('rejects a changed replay values-free before authority or balance work', async () => {
    const { calls, tx } = fakeTx({ loadRequest: async () => {
      calls.push('loadRequest')
      return existing()
    } })
    try {
      await adjustElearningCreditInTransaction(tx, command({ points: 6 }), ENABLED)
      throw new Error('expected conflict')
    } catch (error) {
      if (error instanceof Error && error.message === 'expected conflict') throw error
      expectValuesFree(error, 'conflict')
    }
    expect(calls).toEqual(['lockRequest', 'loadRequest'])
  })

  it('fails closed on a malformed persisted replay row', async () => {
    const { tx } = fakeTx({ loadRequest: async () => existing({
      adjustmentId: 'not-an-adjustment-id',
    }) })
    await expect(adjustElearningCreditInTransaction(tx, command(), ENABLED))
      .rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' })
  })

  it.each([ACTOR, USER])('fails closed when an authority member is outside the org', async (missing) => {
    const { calls, tx } = fakeTx({
      hasActiveMembership: async ({ userId }) => {
        calls.push(`membership:${userId}`)
        return userId !== missing
      },
    })
    await expect(adjustElearningCreditInTransaction(tx, command(), ENABLED))
      .rejects.toMatchObject({ code: 'not_found', message: 'not_found' })
    expect(calls).not.toContain('lockBalance')
  })

  it.each([
    { balance: 4, points: -5 },
    { balance: ELEARNING_CREDIT_INT4_MAX, points: 1 },
  ])('rejects an invalid resulting balance before either write %#', async ({ balance, points }) => {
    const { calls, tx } = fakeTx({
      lockBalance: async () => { calls.push('lockBalance'); return balance },
    })
    await expect(adjustElearningCreditInTransaction(tx, command({ points }), ENABLED))
      .rejects.toMatchObject({ code: 'conflict', message: 'conflict' })
    expect(calls).not.toContain('setBalance')
    expect(calls).not.toContain('appendAdjustment')
  })

  it.each([0, 1.5, ELEARNING_CREDIT_INT4_MAX + 1, -ELEARNING_CREDIT_INT4_MAX - 1])(
    'rejects an invalid int4 delta without touching the transaction: %s',
    async (points) => {
      const { calls, tx } = fakeTx()
      await expect(adjustElearningCreditInTransaction(tx, command({ points }), ENABLED))
        .rejects.toMatchObject({ code: 'invalid_input' })
      expect(calls).toEqual([])
    },
  )

  it.each([
    { reason: '' },
    { reason: 'x'.repeat(513) },
    { reason: 'bad\0reason' },
    { reason: 'bad\ud800reason' },
    { userId: 'bad\udc00user' },
  ])('rejects non-canonical text before touching the transaction %#', async (over) => {
    const { calls, tx } = fakeTx()
    await expect(adjustElearningCreditInTransaction(tx, command(over), ENABLED))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(calls).toEqual([])
  })

  it('is exact-true gated before transaction work and keeps errors values-free', async () => {
    const { calls, tx } = fakeTx()
    try {
      await adjustElearningCreditInTransaction(tx, command(), { ELEARNING_ENABLED: 'true' })
      throw new Error('expected disabled')
    } catch (error) {
      if (error instanceof Error && error.message === 'expected disabled') throw error
      expectValuesFree(error, 'disabled')
    }
    expect(calls).toEqual([])
  })
})
