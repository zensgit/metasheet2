import { describe, expect, it } from 'vitest'

import {
  claimElearningCredit,
  ElearningCreditLedgerError,
  type ClaimElearningCreditInput,
} from '../../src/services/elearning-credit-ledger'
import {
  type ElearningCreditPgQuery,
  PostgresElearningCreditLedgerStore,
} from '../../src/services/elearning-credit-postgres'
import {
  ELEARNING_CREDIT_EFFECT_HASH_VERSION,
  hashElearningCreditEffect,
} from '../../src/services/elearning-credit-policy'

const ENABLED: NodeJS.ProcessEnv = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_INCENTIVE_ENABLED: 'true',
}

const input = (over: Partial<ClaimElearningCreditInput> = {}): ClaimElearningCreditInput => ({
  behavior: 'pass_exam',
  effectKey: 'attempt:postgres-a',
  occurredAt: '2026-01-01T15:59:59.000Z',
  orgId: 'org-postgres-a',
  reference: { attemptId: 'postgres-a' },
  userId: 'user-postgres-a',
  ...over,
})

function result<Row extends Record<string, unknown>>(rows: Row[]) {
  return Promise.resolve({ rowCount: rows.length, rows })
}

function valuesFree(error: unknown): void {
  expect(error).toBeInstanceOf(ElearningCreditLedgerError)
  const text = `${String(error)}\n${error instanceof Error ? error.stack ?? '' : ''}`
  expect(text).not.toContain('org-postgres-a')
  expect(text).not.toContain('user-postgres-a')
  expect(text).not.toContain('attempt:postgres-a')
}

describe('Postgres elearning credit ledger adapter', () => {
  it('claims the global effect before reading a rule or locking a local-day bucket', async () => {
    const statements: string[] = []
    const query: ElearningCreditPgQuery = async (text, values = []) => {
      statements.push(text)
      if (text.startsWith('SET TRANSACTION ISOLATION LEVEL')) return result([])
      if (text.startsWith('INSERT INTO elearning_credit_effect_claims')) {
        return result([{ decision_id: String(values[6]) }])
      }
      if (text.includes('FROM elearning_credit_rules')) {
        return result([{
          daily_cap: 10,
          id: 'rule-postgres-a',
          points: 10,
          time_zone: 'Asia/Shanghai',
          version: 1,
        }])
      }
      if (text.startsWith('INSERT INTO elearning_credit_daily_buckets')) return result([])
      if (text.includes('FROM elearning_credit_daily_buckets')) return result([{ locked: 1 }])
      if (text.includes('SUM(awarded_points)')) return result([{ total: '0' }])
      if (text.startsWith('INSERT INTO elearning_credit_decisions')) {
        return result([{ id: String(values[0]) }])
      }
      if (text.startsWith('INSERT INTO elearning_credit_balances')) {
        return result([{ balance_points: 10 }])
      }
      throw new Error('unexpected statement')
    }
    const store = new PostgresElearningCreditLedgerStore((handler) => handler(query))

    const claimed = await claimElearningCredit(store, input(), ENABLED)

    expect(claimed).toMatchObject({ awardedPoints: 10, duplicate: false, status: 'awarded' })
    expect(statements[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(statements[1]).toContain('INSERT INTO elearning_credit_effect_claims')
    expect(statements.findIndex((statement) => statement.includes('FROM elearning_credit_rules')))
      .toBeGreaterThan(0)
    expect(statements.findIndex((statement) => statement.includes('FROM elearning_credit_daily_buckets')))
      .toBeGreaterThan(0)
  })

  it('uses a DB-fresh joined read after a losing claim and replays the persisted decision', async () => {
    const original = input()
    const statements: string[] = []
    const query: ElearningCreditPgQuery = async (text) => {
      statements.push(text)
      if (text.startsWith('SET TRANSACTION ISOLATION LEVEL')) return result([])
      if (text.startsWith('INSERT INTO elearning_credit_effect_claims')) return result([])
      if (text.includes('JOIN elearning_credit_decisions')) {
        return result([{
          awarded_points: 10,
          id: '11111111-1111-4111-8111-111111111111',
          request_hash: hashElearningCreditEffect(original),
          request_hash_version: ELEARNING_CREDIT_EFFECT_HASH_VERSION,
          status: 'awarded',
        }])
      }
      throw new Error('unexpected statement')
    }
    const store = new PostgresElearningCreditLedgerStore((handler) => handler(query))

    await expect(claimElearningCredit(store, original, ENABLED)).resolves.toEqual({
      awardedPoints: 10,
      decisionId: '11111111-1111-4111-8111-111111111111',
      duplicate: true,
      status: 'awarded',
    })
    expect(statements).toHaveLength(3)
    expect(statements[2]).toContain('JOIN elearning_credit_decisions')
    expect(statements.some((statement) => statement.includes('FROM elearning_credit_rules'))).toBe(false)
  })

  it('returns a values-free conflict when the DB-fresh winner hash differs', async () => {
    const original = input()
    const changed = input({ occurredAt: '2026-01-01T16:00:00.000Z' })
    const query: ElearningCreditPgQuery = async (text) => {
      if (text.startsWith('SET TRANSACTION ISOLATION LEVEL')) return result([])
      if (text.startsWith('INSERT INTO elearning_credit_effect_claims')) return result([])
      return result([{
        awarded_points: 10,
        id: '11111111-1111-4111-8111-111111111111',
        request_hash: hashElearningCreditEffect(original),
        request_hash_version: ELEARNING_CREDIT_EFFECT_HASH_VERSION,
        status: 'awarded',
      }])
    }
    const store = new PostgresElearningCreditLedgerStore((handler) => handler(query))

    try {
      await claimElearningCredit(store, changed, ENABLED)
      throw new Error('expected conflict')
    } catch (error) {
      if (error instanceof Error && error.message === 'expected conflict') throw error
      valuesFree(error)
      expect((error as ElearningCreditLedgerError).code).toBe('conflict')
    }
  })
})
