/**
 * A2 usage ledger — unit legs of §2.5 (ledger insert redaction, quota
 * decision, advisory-lock serialization shape, reserve-then-settle SQL
 * contract — review-fix F1). The aggregation/locking REAL-DB behavior is
 * covered by tests/integration/multitable-ai-shortcut-run.test.ts (A2-T6);
 * here we lock the SQL contract with a captured fake query.
 */
import { describe, expect, it } from 'vitest'

import {
  AI_USAGE_INSTANCE_SUBJECT_KEY,
  AI_USAGE_LEDGER_TABLE,
  aiUsageSubjectLockKey,
  checkAiUsageQuota,
  conservativePromptTokenEstimate,
  insertAiUsageLedgerEntry,
  reserveAiUsage,
  settleAiUsageReservation,
  sumAiUsageWindows,
  withAiUsageQuotaLock,
  type AiUsageReservationInput,
} from '../../src/services/ai-usage-ledger'

const KEY_SENTINEL = `sk-${'ledgerleak'.repeat(3)}`

type Captured = { sql: string; params: unknown[] }

function captureQuery(rows: unknown[] = []) {
  const calls: Captured[] = []
  const query = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] })
    return { rows }
  }
  return { calls, query }
}

describe('insertAiUsageLedgerEntry', () => {
  it('inserts into the ledger table with redacted error text (A2-T10)', async () => {
    const { calls, query } = captureQuery()
    await insertAiUsageLedgerEntry(query, {
      subjectKey: 'user-1',
      userId: 'user-1',
      sheetId: 'sheet-1',
      fieldId: 'fld-1',
      recordId: 'rec-1',
      action: 'run',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      promptTokens: 10,
      completionTokens: 5,
      estimatedCostUsd: 0.001,
      status: 'provider_error',
      durationMs: 42,
      error: `HTTP 500 with ${KEY_SENTINEL}`,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain(`INSERT INTO ${AI_USAGE_LEDGER_TABLE}`)
    const serialized = JSON.stringify(calls[0].params)
    expect(serialized).not.toContain(KEY_SENTINEL)
    expect(serialized).toContain('sk-<redacted>')
  })

  it('records zero-token rows for never-sent attempts (blocked/quota/unsafe)', async () => {
    const { calls, query } = captureQuery()
    await insertAiUsageLedgerEntry(query, {
      subjectKey: 'user-1',
      userId: 'user-1',
      sheetId: 'sheet-1',
      action: 'preview',
      promptTokens: 0,
      completionTokens: 0,
      estimatedCostUsd: 0,
      status: 'blocked',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].params).toContain('blocked')
  })

  it('M4-T10: a sheet-scoped suggest row inserts action=suggest with NULL field_id/record_id', async () => {
    const { calls, query } = captureQuery()
    await insertAiUsageLedgerEntry(query, {
      subjectKey: 'user-1',
      userId: 'user-1',
      sheetId: 'sheet-1',
      // No fieldId/recordId — the NL→formula suggest is sheet-scoped (§1.1).
      action: 'suggest',
      promptTokens: 14,
      completionTokens: 9,
      estimatedCostUsd: 0.0005,
      status: 'succeeded',
    })
    expect(calls).toHaveLength(1)
    // INSERT param order: (id,subject_key,user_id,sheet_id,field_id,record_id,action,…)
    const params = calls[0].params
    expect(params[4]).toBeNull() // field_id NULL
    expect(params[5]).toBeNull() // record_id NULL
    expect(params[6]).toBe('suggest') // action
  })
})

describe('checkAiUsageQuota', () => {
  const caps = { tenantDailyTokenCap: 1000, tenantWeeklyTokenCap: 5000, accountDailyUsdCap: 10 }

  it('aggregates without filtering by status (tokens count whatever the downstream outcome)', async () => {
    const { calls, query } = captureQuery([
      { user_daily_tokens: '0', user_weekly_tokens: '0', instance_daily_usd: '0' },
    ])
    const decision = await checkAiUsageQuota(query, 'user-1', caps, { tokens: 1, costUsd: 0 })
    expect(decision.allowed).toBe(true)
    expect(calls[0].sql).toContain(AI_USAGE_LEDGER_TABLE)
    expect(calls[0].sql.toLowerCase()).not.toContain('status')
  })

  it('user daily token cap exhausted → quota_exhausted reason', async () => {
    const { query } = captureQuery([
      { user_daily_tokens: '1000', user_weekly_tokens: '1000', instance_daily_usd: '0' },
    ])
    const decision = await checkAiUsageQuota(query, 'user-1', caps, { tokens: 1, costUsd: 0 })
    expect(decision).toEqual({ allowed: false, reason: 'user_daily_tokens' })
  })

  it('user weekly token cap exhausted → quota_exhausted reason', async () => {
    const { query } = captureQuery([
      { user_daily_tokens: '10', user_weekly_tokens: '5000', instance_daily_usd: '0' },
    ])
    const decision = await checkAiUsageQuota(query, 'user-1', caps, { tokens: 1, costUsd: 0 })
    expect(decision).toEqual({ allowed: false, reason: 'user_weekly_tokens' })
  })

  it('instance daily USD cap (Q-4, "__instance__") exhausted → quota_exhausted reason', async () => {
    const { query } = captureQuery([
      { user_daily_tokens: '10', user_weekly_tokens: '10', instance_daily_usd: '10.01' },
    ])
    const decision = await checkAiUsageQuota(query, 'user-1', caps, { tokens: 1, costUsd: 0 })
    expect(decision).toEqual({ allowed: false, reason: 'instance_daily_usd' })
  })

  // NO-OVERSHOOT keystone: a single request must be rejected BEFORE it crosses the cap from under it.
  // RED on pre-fix HEAD (admission compared the prior SUM only: 990 >= 1000 is false → ALLOWED, and the
  // request overshot to 1010; only the NEXT request was blocked). GREEN now that the request's own
  // estimate counts at admission.
  it('NO-OVERSHOOT: an estimate that would cross the daily token cap is blocked under-cap (990 + 20 > 1000)', async () => {
    const { query } = captureQuery([
      { user_daily_tokens: '990', user_weekly_tokens: '990', instance_daily_usd: '0' },
    ])
    const decision = await checkAiUsageQuota(query, 'user-1', caps, { tokens: 20, costUsd: 0 })
    expect(decision).toEqual({ allowed: false, reason: 'user_daily_tokens' })
  })

  it('NO-OVERSHOOT: an exactly-fitting request is still allowed (990 + 10 == 1000)', async () => {
    const { query } = captureQuery([
      { user_daily_tokens: '990', user_weekly_tokens: '990', instance_daily_usd: '0' },
    ])
    const decision = await checkAiUsageQuota(query, 'user-1', caps, { tokens: 10, costUsd: 0 })
    expect(decision.allowed).toBe(true)
  })

  it('NO-OVERSHOOT (cost cap — real money): an estimate that would cross the USD cap is blocked under-cap (9.99 + 0.02 > 10)', async () => {
    const { query } = captureQuery([
      { user_daily_tokens: '0', user_weekly_tokens: '0', instance_daily_usd: '9.99' },
    ])
    const decision = await checkAiUsageQuota(query, 'user-1', caps, { tokens: 1, costUsd: 0.02 })
    expect(decision).toEqual({ allowed: false, reason: 'instance_daily_usd' })
  })
})

describe('sumAiUsageWindows (A3 §2.4 — shared SUM source for quota + summary)', () => {
  it('returns the numeric window sums from ONE query (the same SQL the quota check uses)', async () => {
    const { calls, query } = captureQuery([
      { user_daily_tokens: '123', user_weekly_tokens: '456', instance_daily_usd: '7.89' },
    ])
    const sums = await sumAiUsageWindows(query, 'user-1')
    expect(sums).toEqual({ userDailyTokens: 123, userWeeklyTokens: 456, instanceDailyUsd: 7.89 })
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain(AI_USAGE_LEDGER_TABLE)
    expect(calls[0].sql.toLowerCase()).not.toContain('status')
    expect(calls[0].params).toEqual(['user-1'])
  })

  it('checkAiUsageQuota consumes the SAME shared sums (no duplicated SQL path)', async () => {
    const { calls, query } = captureQuery([
      { user_daily_tokens: '0', user_weekly_tokens: '0', instance_daily_usd: '0' },
    ])
    await checkAiUsageQuota(query, 'user-1', { tenantDailyTokenCap: 1, tenantWeeklyTokenCap: 1, accountDailyUsdCap: 1 }, { tokens: 0, costUsd: 0 })
    const sumsCalls = calls.filter((call) => call.sql.includes('user_daily_tokens'))
    expect(sumsCalls).toHaveLength(1)
  })
})

describe('withAiUsageQuotaLock', () => {
  it('serializes via pg_advisory_xact_lock on the instance key then the subject key (fixed order)', async () => {
    const { calls, query } = captureQuery()
    const pool = {
      transaction: async <T>(handler: (client: { query: typeof query }) => Promise<T>): Promise<T> => handler({ query }),
    }
    const result = await withAiUsageQuotaLock(pool, 'user-1', async () => 'done')
    expect(result).toBe('done')
    const lockCalls = calls.filter((call) => call.sql.includes('pg_advisory_xact_lock'))
    expect(lockCalls).toHaveLength(2)
    expect(lockCalls[0].params[0]).toBe(aiUsageSubjectLockKey(AI_USAGE_INSTANCE_SUBJECT_KEY))
    expect(lockCalls[1].params[0]).toBe(aiUsageSubjectLockKey('user-1'))
  })
})

describe('reserveAiUsage (review-fix F1 — reserve-then-settle)', () => {
  // Daily cap is set comfortably ABOVE one conservative single-request estimate (25 + 1024 = 1049)
  // so the happy-path reserve fits under it; estimate-aware admission would otherwise reject a
  // single request whose conservative estimate exceeds the remaining budget (the no-overshoot fix).
  const caps = { tenantDailyTokenCap: 5000, tenantWeeklyTokenCap: 50000, accountDailyUsdCap: 10 }
  const input: AiUsageReservationInput = {
    subjectKey: 'user-1',
    userId: 'user-1',
    sheetId: 'sheet-1',
    fieldId: 'fld-1',
    recordId: 'rec-1',
    action: 'run',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    estimatedPromptTokens: 25,
    estimatedCompletionTokens: 1024,
    estimatedCostUsd: 0.0154,
    caps,
    staleAfterMs: 75_000,
  }

  function reservePool(rows: unknown[]) {
    const { calls, query } = captureQuery(rows)
    const pool = {
      transaction: async <T>(handler: (client: { query: typeof query }) => Promise<T>): Promise<T> => handler({ query }),
    }
    return { calls, pool }
  }

  it('one SHORT tx: locks (instance→subject) → stale sweep → SUM check → INSERT in_flight reservation', async () => {
    const { calls, pool } = reservePool([
      { user_daily_tokens: '0', user_weekly_tokens: '0', instance_daily_usd: '0' },
    ])
    const result = await reserveAiUsage(pool, input)
    expect('reservationId' in result && result.reservationId).toMatch(/^aiu_/)

    expect(calls).toHaveLength(5)
    expect(calls[0].sql).toContain('pg_advisory_xact_lock')
    expect(calls[1].sql).toContain('pg_advisory_xact_lock')
    // Stale sweep runs INSIDE the locked tx, before the SUM check, so a
    // crash-orphaned reservation never blocks a fresh request.
    expect(calls[2].sql).toContain(`'abandoned'`)
    expect(calls[2].sql).toContain(`'in_flight'`)
    expect(calls[2].params[0]).toBe(75_000)
    expect(calls[3].sql).toContain('SUM')
    expect(calls[3].sql.toLowerCase()).not.toContain('status') // in_flight estimates count
    expect(calls[4].sql).toContain(`INSERT INTO ${AI_USAGE_LEDGER_TABLE}`)
    expect(calls[4].params).toContain('in_flight')
    expect(calls[4].params).toContain(25) // conservative prompt estimate
    expect(calls[4].params).toContain(1024) // maxOutputTokens cap
  })

  it('quota exhausted → zero-usage quota_exhausted row in the SAME tx, no reservation', async () => {
    const { calls, pool } = reservePool([
      // window already AT the daily cap → any further request's estimate pushes it over → blocked.
      { user_daily_tokens: '5000', user_weekly_tokens: '1000', instance_daily_usd: '0' },
    ])
    const result = await reserveAiUsage(pool, input)
    expect(result).toEqual({ reserved: false, reason: 'user_daily_tokens' })

    const insert = calls.find((call) => call.sql.includes('INSERT INTO'))
    expect(insert).toBeDefined()
    expect(insert!.params).toContain('quota_exhausted')
    expect(insert!.params).not.toContain('in_flight')
    // zero-usage row: prompt + completion token params are both 0
    expect(insert!.params.filter((param) => param === 0).length).toBeGreaterThanOrEqual(2)
  })
})

describe('settleAiUsageReservation (review-fix F1)', () => {
  it('UPDATEs the reservation row to actual usage + final status with redacted error', async () => {
    const { calls, query } = captureQuery()
    await settleAiUsageReservation(query, 'aiu_reservation_1', {
      promptTokens: 21,
      completionTokens: 13,
      estimatedCostUsd: 0.000258,
      status: 'provider_error',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      durationMs: 42,
      error: `upstream broke ${KEY_SENTINEL}`,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain(`UPDATE ${AI_USAGE_LEDGER_TABLE}`)
    expect(calls[0].params[0]).toBe('aiu_reservation_1')
    expect(calls[0].params).toContain(21)
    expect(calls[0].params).toContain(13)
    expect(calls[0].params).toContain('provider_error')
    const serialized = JSON.stringify(calls[0].params)
    expect(serialized).not.toContain(KEY_SENTINEL)
    expect(serialized).toContain('sk-<redacted>')
  })
})

describe('conservativePromptTokenEstimate', () => {
  it('reserves 1 token per char (pessimistic CJK bound, delta review NF-1) with a floor of 1', () => {
    expect(conservativePromptTokenEstimate('')).toBe(1)
    expect(conservativePromptTokenEstimate('abc')).toBe(3)
    expect(conservativePromptTokenEstimate('多维表格测试')).toBe(6)
    expect(conservativePromptTokenEstimate('a'.repeat(401))).toBe(401)
  })
})
