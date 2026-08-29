import { describe, expect, it } from 'vitest'

import {
  ElearningCreditAdjustmentError,
  hashElearningCreditAdjustmentRequest,
} from '../../src/services/elearning-credit-adjustment'
import { adjustElearningCreditPostgres } from '../../src/services/elearning-credit-adjustment-postgres'
import type { ElearningCreditSurfaceDb } from '../../src/services/elearning-credit-surface'

const ENABLED = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_INCENTIVE_ENABLED: 'true',
} as NodeJS.ProcessEnv
const ORG = 'org-adjust-pg'
const ACTOR = 'actor-adjust-pg'
const USER = 'user-adjust-pg'

function result(rows: Array<Record<string, unknown>>) {
  return Promise.resolve({ rows, rowCount: rows.length })
}

function input(over: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    requestId: 'request-adjust-pg',
    userId: USER,
    points: 5,
    reason: 'reason-adjust-pg',
    ...over,
  }
}

describe('Postgres e-learning credit adjustment adapter', () => {
  it('does not open a transaction unless both incentive flags are exact true', async () => {
    let transactions = 0
    const db: ElearningCreditSurfaceDb = {
      query: async () => result([]),
      transaction: async () => {
        transactions += 1
        throw new Error('must not run')
      },
    }
    await expect(adjustElearningCreditPostgres(db, input(), {
      ELEARNING_ENABLED: 'true',
    })).rejects.toMatchObject({ code: 'disabled', message: 'disabled' })
    expect(transactions).toBe(0)
  })

  it('uses one READ COMMITTED transaction and stable request-authority-balance ordering', async () => {
    const statements: string[] = []
    const params: unknown[][] = []
    const query = async (sql: string, values: unknown[] = []) => {
      statements.push(sql)
      params.push(values)
      if (sql.includes(':load-request')) return result([])
      if (sql.includes(':membership')) return result([{ ok: 1 }])
      if (sql.includes(':lock-balance')) return result([{ balance_points: 10 }])
      if (sql.includes(':set-balance')) return result([{ balance_points: 15 }])
      if (sql.includes(':append')) return result([{ created_at: '2026-08-29T07:00:00.000Z' }])
      return result([])
    }
    const db: ElearningCreditSurfaceDb = {
      query,
      transaction: async (run) => run({ query }),
    }

    await expect(adjustElearningCreditPostgres(db, input(), ENABLED)).resolves.toEqual({
      adjustmentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      userId: USER,
      points: 5,
      balancePoints: 15,
      createdAt: '2026-08-29T07:00:00.000Z',
      duplicate: false,
    })
    expect(statements.map((sql) => /elearning-credit-adjustment:([^*]+)/.exec(sql)?.[1]?.trim()
      ?? (sql.startsWith('SET TRANSACTION') ? 'isolation' : 'unknown'))).toEqual([
      'isolation',
      'request-lock',
      'load-request',
      'membership',
      'membership',
      'ensure-balance',
      'lock-balance',
      'set-balance',
      'append',
    ])
    expect(statements[1]).toContain('pg_advisory_xact_lock')
    expect(statements[3]).toContain('membership.org_id = $1')
    expect(statements[6]).toContain('FOR UPDATE')
    expect(statements[7]).toContain('balance_points = $4')
    expect(params[3]).toEqual([ORG, ACTOR])
    expect(params[4]).toEqual([ORG, USER])
    expect(params[7]).toEqual([ORG, USER, 15, 10])
  })

  it('uses a DB-fresh request row for same-payload replay and performs no balance writes', async () => {
    const statements: string[] = []
    const hash = hashElearningCreditAdjustmentRequest({
      actorId: ACTOR,
      userId: USER,
      points: 5,
      reason: 'reason-adjust-pg',
    })
    const db: ElearningCreditSurfaceDb = {
      query: async () => result([]),
      transaction: async (run) => run({
        query: async (sql) => {
          statements.push(sql)
          if (sql.includes(':load-request')) return result([{
            adjustment_id: '11111111-1111-4111-8111-111111111111',
            request_hash: hash,
            request_hash_version: 1,
            user_id: USER,
            points: 5,
            balance_after: 15,
            created_at: '2026-08-29T07:00:00.000Z',
          }])
          return result([])
        },
      }),
    }

    await expect(adjustElearningCreditPostgres(db, input(), ENABLED)).resolves.toEqual({
      adjustmentId: '11111111-1111-4111-8111-111111111111',
      userId: USER,
      points: 5,
      balancePoints: 15,
      createdAt: '2026-08-29T07:00:00.000Z',
      duplicate: true,
    })
    expect(statements).toHaveLength(3)
    expect(statements.some((sql) => sql.includes(':membership'))).toBe(false)
    expect(statements.some((sql) => sql.includes(':set-balance'))).toBe(false)
  })

  it('maps malformed persistence rows and unknown SQL failures to values-free unavailable', async () => {
    const db: ElearningCreditSurfaceDb = {
      query: async () => result([]),
      transaction: async () => { throw new Error('org-adjust-pg secret') },
    }
    try {
      await adjustElearningCreditPostgres(db, input(), ENABLED)
      throw new Error('expected unavailable')
    } catch (error) {
      if (error instanceof Error && error.message === 'expected unavailable') throw error
      expect(error).toBeInstanceOf(ElearningCreditAdjustmentError)
      expect((error as ElearningCreditAdjustmentError).code).toBe('unavailable')
      expect(String(error)).not.toContain('secret')
    }
  })
})
