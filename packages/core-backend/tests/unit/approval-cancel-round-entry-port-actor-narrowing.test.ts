import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

/**
 * Cancel-round product entry (phase C gate r2, NIT) — what the port hands the service entry.
 *
 * The entry actor carries the caller's role claims (for the post-action count push only). Two
 * narrowings keep them away from the service entry: the DISPATCHED action gets `roles: []`, and
 * the creation path gets `{ userId, userName }` only. Neither is load-bearing today (a cancel round
 * seats users, and the creation signature has no roles), so the real-DB suite stays green with
 * either one removed; this pins both directly. The input actor carries roles, ip and user agent,
 * so a pass-through of the whole actor would show up here.
 */

const captured = vi.hoisted(() => ({
  dispatchActor: undefined as unknown,
  createActor: undefined as unknown,
}))

vi.mock('../../src/services/ApprovalProductService', () => ({
  ApprovalProductService: class {
    async dispatchAction(_id: string, _request: unknown, actor: unknown) {
      captured.dispatchActor = actor
      return {}
    }

    async createCancelRoundInstance(_documentId: string, actor: unknown) {
      captured.createActor = actor
      // A refusal ends `launch` before it reads the summary, so no database is needed.
      const { ServiceError } = await import('../../src/services/ApprovalBridgeService')
      throw new ServiceError('refused in this unit test', 409, 'CANCEL_ROUND_UNIT_TEST_REFUSAL')
    }
  },
}))

import {
  buildApprovalCancelRoundEntryPort,
  dispatchOnLatestCancelRound,
} from '../../src/approvals/approval-cancel-round-entry-port'

const actor = {
  userId: 'actor-1',
  userName: 'Actor One',
  roles: ['admin', 'attendance_approver'],
  ip: '10.0.0.1',
  userAgent: 'unit-test-agent',
}

/** The two reads `dispatchOnLatestCancelRound` issues without a publisher: the round, then its outcome. */
function roundQuery(): Queryable {
  return {
    async query(sql: string) {
      if (sql.includes('FROM approval_rounds r')) {
        return {
          rows: [{ round_id: 'round-1', engine_instance_id: 'engine-1', outcome: 'pending' }],
          rowCount: 1,
        }
      }
      if (sql.startsWith('SELECT outcome FROM approval_rounds')) {
        return { rows: [{ outcome: 'applied' }], rowCount: 1 }
      }
      throw new Error(`unexpected query in this unit test: ${sql.slice(0, 60)}`)
    },
  } as unknown as Queryable
}

describe('cancel-round entry port — the actor handed to the service entry', () => {
  beforeEach(() => {
    captured.dispatchActor = undefined
    captured.createActor = undefined
  })

  it.each(['approve', 'reject', 'revoke'] as const)(
    'the dispatched %s carries no role claims, whatever the entry actor carries',
    async (action) => {
      const result = await dispatchOnLatestCancelRound(roundQuery(), 'doc-1', actor, action, null)
      expect(result).toMatchObject({ ok: true, round: { roundId: 'round-1', outcome: 'applied' } })
      expect(captured.dispatchActor).toEqual({
        userId: 'actor-1',
        userName: 'Actor One',
        roles: [],
        ip: '10.0.0.1',
        userAgent: 'unit-test-agent',
      })
    },
  )

  it('the creation path receives exactly { userId, userName }', async () => {
    const port = buildApprovalCancelRoundEntryPort()
    const result = await port.launch('doc-1', actor, { reason: 'unit test' })
    expect(result).toEqual({
      ok: false,
      status: 409,
      code: 'CANCEL_ROUND_UNIT_TEST_REFUSAL',
      message: 'refused in this unit test',
    })
    expect(Object.keys(captured.createActor as object).sort()).toEqual(['userId', 'userName'])
    expect(captured.createActor).toEqual({ userId: 'actor-1', userName: 'Actor One' })
  })

  it('the creation path receives exactly { userId } when the actor has no display name', async () => {
    const port = buildApprovalCancelRoundEntryPort()
    const { userName: _omitted, ...withoutName } = actor
    await port.launch('doc-1', withoutName)
    expect(captured.createActor).toEqual({ userId: 'actor-1' })
    expect(Object.keys(captured.createActor as object)).toEqual(['userId'])
  })
})
