import { describe, expect, it } from 'vitest'

import {
  ELEARNING_CREDIT_RULE_REQUEST_HASH_VERSION,
  ElearningCreditSurfaceError,
  getElearningCreditWallet,
  hashElearningCreditRuleRequest,
  listElearningCreditRules,
  publishElearningCreditRule,
  type ElearningCreditSurfaceDb,
} from '../../src/services/elearning-credit-surface'

const ORG = 'org-credit-surface'
const ACTOR = 'admin-credit-surface'
const USER = 'user-credit-surface'
const RULE_ID = '11111111-1111-4111-8111-111111111111'
const DECISION_1 = '22222222-2222-4222-8222-222222222222'
const DECISION_2 = '33333333-3333-4333-8333-333333333333'
const DECISION_3 = '44444444-4444-4444-8444-444444444444'

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number | null }

function dbWith(
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>,
): ElearningCreditSurfaceDb {
  return {
    query,
    transaction: async (run) => run({ query }),
  }
}

function basePublish(over: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    requestId: 'request-pass-exam-v1',
    behavior: 'pass_exam',
    points: 10,
    dailyCap: 20,
    timeZone: 'Asia/Shanghai',
    ...over,
  }
}

describe('e-learning credit rules and wallet surface', () => {
  it('canonicalizes the rule command and excludes request identity and actor', () => {
    const a = hashElearningCreditRuleRequest({
      behavior: 'pass_exam',
      points: 10,
      dailyCap: 20,
      timeZone: 'Asia/Shanghai',
    })
    const b = hashElearningCreditRuleRequest({
      timeZone: 'Asia/Shanghai',
      dailyCap: 20,
      points: 10,
      behavior: 'pass_exam',
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('publishes one new active version inside the serialized command path', async () => {
    const calls: string[] = []
    const db = dbWith(async (sql, params) => {
      calls.push(sql)
      if (sql.includes('request-lock')) {
        expect(sql).toContain('pg_advisory_xact_lock')
        expect(params).toEqual([
          'elearning-credit-rule-request',
          `${ORG}:request:request-pass-exam-v1`,
        ])
      }
      if (sql.includes('behavior-lock')) {
        expect(sql).toContain('pg_advisory_xact_lock')
        expect(params).toEqual([
          'elearning-credit-rule-behavior',
          `${ORG}:behavior:pass_exam`,
        ])
      }
      if (sql.includes('load-request')) return { rows: [], rowCount: 0 }
      if (sql.includes('load-latest')) return { rows: [], rowCount: 0 }
      if (sql.includes('insert-version')) {
        expect(params?.slice(2)).toEqual([1, 'pass_exam', 10, 20, 'Asia/Shanghai'])
        return { rows: [{ created_at: new Date('2026-08-29T00:00:00.000Z') }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })

    const result = await publishElearningCreditRule(db, basePublish())

    expect(result).toEqual({
      behavior: 'pass_exam',
      ruleId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      version: 1,
      points: 10,
      dailyCap: 20,
      timeZone: 'Asia/Shanghai',
      createdAt: '2026-08-29T00:00:00.000Z',
      duplicate: false,
    })
    expect(calls.map((sql) => /elearning-credit-rule:([^*]+)/.exec(sql)?.[1]?.trim()))
      .toEqual([
        'request-lock',
        'load-request',
        'behavior-lock',
        'load-latest',
        'retire-active',
        'insert-version',
        'record-request',
      ])
  })

  it('replays the same request without changing rules and rejects changed payload values-free', async () => {
    const hash = hashElearningCreditRuleRequest({
      behavior: 'pass_exam',
      points: 10,
      dailyCap: 20,
      timeZone: 'Asia/Shanghai',
    })
    const queries: string[] = []
    const db = dbWith(async (sql) => {
      queries.push(sql)
      if (sql.includes('load-request')) {
        return {
          rows: [{
            request_hash: hash,
            request_hash_version: ELEARNING_CREDIT_RULE_REQUEST_HASH_VERSION,
            rule_id: RULE_ID,
            rule_version: 4,
            behavior: 'pass_exam',
            points: 10,
            daily_cap: 20,
            time_zone: 'Asia/Shanghai',
            created_at: new Date('2026-08-29T01:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 1 }
    })

    await expect(publishElearningCreditRule(db, basePublish())).resolves.toEqual({
      behavior: 'pass_exam',
      ruleId: RULE_ID,
      version: 4,
      points: 10,
      dailyCap: 20,
      timeZone: 'Asia/Shanghai',
      createdAt: '2026-08-29T01:00:00.000Z',
      duplicate: true,
    })
    expect(queries.some((sql) => sql.includes('retire-active'))).toBe(false)

    const changed = basePublish({ points: 11 })
    await expect(publishElearningCreditRule(db, changed)).rejects.toMatchObject({
      code: 'conflict',
      message: 'conflict',
    })
  })

  it.each([
    { behavior: 'manual_adjust' },
    { behavior: 'unknown' },
    { points: 0 },
    { points: 1.5 },
    { dailyCap: 0 },
    { dailyCap: undefined },
    { timeZone: 'Not/AZone' },
    { requestId: '' },
  ])('fails closed on invalid publish input %#', async (over) => {
    const db = dbWith(async () => ({ rows: [], rowCount: 0 }))
    await expect(publishElearningCreditRule(db, basePublish(over)))
      .rejects.toBeInstanceOf(ElearningCreditSurfaceError)
  })

  it('lists only the exact active-rule shape returned by persistence', async () => {
    const db = dbWith(async () => ({
      rows: [{
        id: RULE_ID,
        version: 2,
        behavior: 'complete_course',
        points: 5,
        daily_cap: null,
        time_zone: 'UTC',
        created_at: '2026-08-29T02:00:00.000Z',
      }],
      rowCount: 1,
    }))
    await expect(listElearningCreditRules(db, ORG)).resolves.toEqual([{
      behavior: 'complete_course',
      ruleId: RULE_ID,
      version: 2,
      points: 5,
      dailyCap: null,
      timeZone: 'UTC',
      createdAt: '2026-08-29T02:00:00.000Z',
    }])
  })

  it('returns a closed wallet DTO and uses a stable keyset cursor on the next page', async () => {
    let historyCall = 0
    const historyParams: unknown[][] = []
    const rows = [
      {
        id: DECISION_1,
        behavior: 'pass_exam',
        awarded_points: 10,
        status: 'awarded',
        occurred_at: '2026-08-29T03:00:00.000Z',
        created_at: '2026-08-29T03:00:01.000Z',
        cursor_created_at: '2026-08-29T03:00:01.000999Z',
        request_hash: 'secret-hash',
        effect_key: 'secret-effect',
      },
      {
        id: DECISION_2,
        behavior: 'complete_course',
        awarded_points: 5,
        status: 'capped',
        occurred_at: '2026-08-29T02:00:00.000Z',
        created_at: '2026-08-29T02:00:01.000Z',
        cursor_created_at: '2026-08-29T02:00:01.000456Z',
      },
      {
        id: DECISION_3,
        behavior: 'login',
        awarded_points: 1,
        status: 'awarded',
        occurred_at: '2026-08-29T01:00:00.000Z',
        created_at: '2026-08-29T01:00:01.000Z',
        cursor_created_at: '2026-08-29T01:00:01.000123Z',
      },
    ]
    const db = dbWith(async (sql, params) => {
      if (sql.includes(':membership')) return { rows: [{ ok: 1 }], rowCount: 1 }
      if (sql.includes(':balance')) return { rows: [{ balance_points: 16 }], rowCount: 1 }
      if (sql.includes(':history')) {
        historyParams.push(params ?? [])
        historyCall += 1
        return { rows: historyCall === 1 ? rows : [rows[2]!], rowCount: historyCall === 1 ? 3 : 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    const first = await getElearningCreditWallet(db, { orgId: ORG, userId: USER, limit: 2 })
    expect(first).toEqual({
      userId: USER,
      balancePoints: 16,
      items: [
        {
          decisionId: DECISION_1,
          behavior: 'pass_exam',
          awardedPoints: 10,
          status: 'awarded',
          occurredAt: '2026-08-29T03:00:00.000Z',
          createdAt: '2026-08-29T03:00:01.000Z',
        },
        {
          decisionId: DECISION_2,
          behavior: 'complete_course',
          awardedPoints: 5,
          status: 'capped',
          occurredAt: '2026-08-29T02:00:00.000Z',
          createdAt: '2026-08-29T02:00:01.000Z',
        },
      ],
      nextCursor: expect.any(String),
    })
    expect(JSON.stringify(first)).not.toMatch(/request_hash|effect_key|secret/)

    const second = await getElearningCreditWallet(db, {
      orgId: ORG,
      userId: USER,
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.items.map((item) => item.decisionId)).toEqual([DECISION_3])
    expect(historyParams[1]).toEqual([
      ORG,
      USER,
      '2026-08-29T02:00:01.000456Z',
      DECISION_2,
      3,
    ])
    expect(historyParams[0]).toEqual([ORG, USER, 3])
  })

  it('fails closed for malformed cursors and users outside the authenticated org', async () => {
    const db = dbWith(async (sql) => ({
      rows: sql.includes(':membership') ? [] : [],
      rowCount: 0,
    }))
    await expect(getElearningCreditWallet(db, {
      orgId: ORG,
      userId: USER,
      cursor: 'not+base64url',
    })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(getElearningCreditWallet(db, { orgId: ORG, userId: USER }))
      .rejects.toMatchObject({ code: 'not_found' })
  })

  it('unions manual adjustments into the closed stable wallet timeline', async () => {
    const db = dbWith(async (sql) => {
      if (sql.includes(':membership')) return { rows: [{ ok: 1 }], rowCount: 1 }
      if (sql.includes(':balance')) return { rows: [{ balance_points: 7 }], rowCount: 1 }
      if (sql.includes(':history')) {
        expect(sql).toContain('UNION ALL')
        expect(sql).toContain('FROM elearning_credit_adjustments')
        return {
          rows: [{
            id: DECISION_1,
            behavior: 'manual_adjust',
            awarded_points: -3,
            status: 'adjusted',
            occurred_at: '2026-08-29T04:00:00.000Z',
            created_at: '2026-08-29T04:00:00.000Z',
            cursor_created_at: '2026-08-29T04:00:00.000123Z',
            reason: 'must-not-leak',
            actor_id: 'must-not-leak',
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const wallet = await getElearningCreditWallet(db, { orgId: ORG, userId: USER })
    expect(wallet).toEqual({
      userId: USER,
      balancePoints: 7,
      items: [{
        decisionId: DECISION_1,
        behavior: 'manual_adjust',
        awardedPoints: -3,
        status: 'adjusted',
        occurredAt: '2026-08-29T04:00:00.000Z',
        createdAt: '2026-08-29T04:00:00.000Z',
      }],
      nextCursor: null,
    })
    expect(JSON.stringify(wallet)).not.toMatch(/reason|actor_id|must-not-leak/)
  })

  it.each([
    { behavior: 'manual_adjust', awarded_points: 0, status: 'adjusted' },
    { behavior: 'manual_adjust', awarded_points: -1, status: 'awarded' },
    { behavior: 'manual_adjust', awarded_points: -2_147_483_648, status: 'adjusted' },
    { behavior: 'manual_adjust', awarded_points: 2_147_483_648, status: 'adjusted' },
    { behavior: 'pass_exam', awarded_points: -1, status: 'awarded' },
    { behavior: 'pass_exam', awarded_points: 2_147_483_648, status: 'awarded' },
    { behavior: 'pass_exam', awarded_points: 1, status: 'adjusted' },
  ])('fails closed on an impossible union wallet row %#', async (invalid) => {
    const db = dbWith(async (sql) => {
      if (sql.includes(':membership')) return { rows: [{ ok: 1 }], rowCount: 1 }
      if (sql.includes(':balance')) return { rows: [{ balance_points: 1 }], rowCount: 1 }
      return {
        rows: [{
          id: DECISION_1,
          occurred_at: '2026-08-29T04:00:00.000Z',
          created_at: '2026-08-29T04:00:00.000Z',
          cursor_created_at: '2026-08-29T04:00:00.000123Z',
          ...invalid,
        }],
        rowCount: 1,
      }
    })
    await expect(getElearningCreditWallet(db, { orgId: ORG, userId: USER }))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it.each([
    { behavior: 'manual_adjust', awarded_points: -2_147_483_647, status: 'adjusted' },
    { behavior: 'manual_adjust', awarded_points: 2_147_483_647, status: 'adjusted' },
    { behavior: 'pass_exam', awarded_points: 0, status: 'exhausted' },
    { behavior: 'pass_exam', awarded_points: 2_147_483_647, status: 'awarded' },
  ])('accepts an inclusive int4 wallet boundary %#', async (boundary) => {
    const db = dbWith(async (sql) => {
      if (sql.includes(':membership')) return { rows: [{ ok: 1 }], rowCount: 1 }
      if (sql.includes(':balance')) {
        return { rows: [{ balance_points: 2_147_483_647 }], rowCount: 1 }
      }
      if (sql.includes(':history')) {
        return {
          rows: [{
            id: DECISION_1,
            occurred_at: '2026-08-29T04:00:00.000Z',
            created_at: '2026-08-29T04:00:00.000Z',
            cursor_created_at: '2026-08-29T04:00:00.000123Z',
            ...boundary,
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    await expect(getElearningCreditWallet(db, { orgId: ORG, userId: USER }))
      .resolves.toMatchObject({
        balancePoints: 2_147_483_647,
        items: [{ awardedPoints: boundary.awarded_points }],
      })
  })

  it('fails closed when the stored wallet balance exceeds int4', async () => {
    let historyQueried = false
    const db = dbWith(async (sql) => {
      if (sql.includes(':snapshot')) return { rows: [], rowCount: 0 }
      if (sql.includes(':membership')) return { rows: [{ ok: 1 }], rowCount: 1 }
      if (sql.includes(':balance')) {
        return { rows: [{ balance_points: 2_147_483_648 }], rowCount: 1 }
      }
      if (sql.includes(':history')) {
        historyQueried = true
        return {
          rows: [{
            id: DECISION_1,
            behavior: 'pass_exam',
            awarded_points: 1,
            status: 'awarded',
            occurred_at: '2026-08-29T04:00:00.000Z',
            created_at: '2026-08-29T04:00:00.000Z',
            cursor_created_at: '2026-08-29T04:00:00.000123Z',
          }],
          rowCount: 1,
        }
      }
      throw new Error('unexpected wallet query')
    })

    await expect(getElearningCreditWallet(db, { orgId: ORG, userId: USER }))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(historyQueried).toBe(false)
  })
})
