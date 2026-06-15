/**
 * M4 / Lane B2 — NL→formula suggest, REAL-DB suite (design §3: M4-T3 ledger
 * round-trip, M4-T8 quota non-interference,
 * docs/development/multitable-ai-formula-assist-m4-design-20260611.md).
 *
 * The ledger insert/settle path is NOT mocked: a suggest attempt must land a
 * SHEET-SCOPED row (record_id/field_id NULL, action=suggest) and that row must
 * count in the SAME quota SUM as preview/run — i.e. it neither escapes the
 * window nor corrupts the existing accounting. Provider HTTP is NEVER real —
 * fetchFn is injected at router construction (the production seam).
 *
 * Wired into .github/workflows/plugin-tests.yml multitable real-DB explicit list.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { createMultitableAiRoutes } from '../../src/routes/multitable-ai'
import { AI_USAGE_LEDGER_TABLE, sumAiUsageWindows, type AiUsageQueryFn } from '../../src/services/ai-usage-ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_m4_${TS}`
const SHEET_ID = `sheet_m4_${TS}`
const FLD_PRICE = `fld_m4_price_${TS}`
const FLD_TAX = `fld_m4_tax_${TS}`

const USER_SUGGEST = `u_m4_suggest_${TS}`
const USER_QUOTA = `u_m4_quota_${TS}`

const API_KEY_SENTINEL = `sk-${'m4realdbleak'.repeat(2)}`
const RECORD_VALUE_SENTINEL = `record-value-must-not-leak-${TS}`

const AI_ENV_KEYS = [
  'MULTITABLE_AI_ENABLED',
  'MULTITABLE_AI_PROVIDER',
  'MULTITABLE_AI_API_KEY',
  'MULTITABLE_AI_BASE_URL',
  'MULTITABLE_AI_MODEL',
  'MULTITABLE_AI_REQUEST_TIMEOUT_MS',
  'MULTITABLE_AI_MAX_OUTPUT_TOKENS',
  'MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP',
  'MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP',
  'MULTITABLE_AI_TENANT_BURST_RPM',
  'MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP',
  'MULTITABLE_AI_CONFIRM_LIVE_REQUESTS',
] as const

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = { id: USER_SUGGEST, roles: ['member'], perms: ['multitable:write'] }
let stubUsage = { input_tokens: 18, output_tokens: 7 }
let lastOutboundBody = ''
let fetchCallCount = 0
const savedEnv = new Map<string, string | undefined>()

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const fetchStub = (async (_url: unknown, init?: { body?: unknown }) => {
  fetchCallCount += 1
  lastOutboundBody = String(init?.body ?? '')
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text: '={fld_price}*(1+{fld_tax})' }], usage: { ...stubUsage } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}) as typeof fetch

const suggestReq = (instruction: string) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/ai/suggest-formula`).send({ instruction })

const ledgerRows = async (userId: string) => {
  const res = await q(
    `SELECT action, status, field_id, record_id, prompt_tokens, completion_tokens FROM ${AI_USAGE_LEDGER_TABLE} WHERE user_id = $1 ORDER BY occurred_at ASC`,
    [userId],
  )
  return res.rows as Array<{ action: string; status: string; field_id: string | null; record_id: string | null; prompt_tokens: number; completion_tokens: number }>
}

describeIfDatabase('M4 suggest-formula (real DB)', () => {
  beforeAll(async () => {
    for (const key of AI_ENV_KEYS) {
      savedEnv.set(key, process.env[key])
      delete process.env[key]
    }
    process.env.MULTITABLE_AI_ENABLED = '1'
    process.env.MULTITABLE_AI_PROVIDER = 'anthropic'
    process.env.MULTITABLE_AI_API_KEY = API_KEY_SENTINEL
    process.env.MULTITABLE_AI_MODEL = 'claude-sonnet-4-6'
    process.env.MULTITABLE_AI_CONFIRM_LIVE_REQUESTS = '1'

    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = currentUser
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    app.use('/api/multitable', createMultitableAiRoutes({ fetchFn: fetchStub }))

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'M4 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'M4 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_PRICE, SHEET_ID, 'Unit Price', 'number', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_TAX, SHEET_ID, 'Tax Rate', 'percent', '{}', 2])
    // A record exists on the sheet with a sentinel value — proves the suggest
    // path never reads records (no value can reach the prompt).
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      `rec_m4_${TS}`,
      SHEET_ID,
      JSON.stringify({ [FLD_PRICE]: RECORD_VALUE_SENTINEL }),
    ])
  })

  afterAll(async () => {
    await q(`DELETE FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    for (const key of AI_ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  // Leak-proof cap reset: a test that throws mid-body (e.g. an estimate-aware
  // admission rejection on its FIRST assertion) would otherwise skip a trailing
  // inline `delete process.env.…CAP` and leak a low cap into later tests. Reset
  // ONLY the per-test cap keys after EACH test; the suite-level enabling vars
  // from beforeAll are left intact.
  const PER_TEST_CAP_KEYS = [
    'MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP',
    'MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP',
    'MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP',
  ] as const
  afterEach(() => {
    for (const key of PER_TEST_CAP_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('M4-T3: suggest lands a sheet-scoped ledger row (action=suggest, record/field NULL); prompt has names+types, no record values', async () => {
    currentUser = { id: USER_SUGGEST, roles: ['member'], perms: ['multitable:write'] }
    stubUsage = { input_tokens: 18, output_tokens: 7 }

    const res = await suggestReq('unit price times one plus tax')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.status).toBe('succeeded')
    expect(res.body.data.action).toBe('suggest')
    expect(res.body.data.candidate).toBe('={fld_price}*(1+{fld_tax})')
    expect(res.body.data.usage).toEqual({ promptTokens: 18, completionTokens: 7 })
    expect(JSON.stringify(res.body)).not.toContain(API_KEY_SENTINEL)

    // Prompt = field NAMES + TYPES only; record VALUES never enter it.
    expect(lastOutboundBody).toContain('Unit Price')
    expect(lastOutboundBody).toContain('Tax Rate')
    expect(lastOutboundBody).toContain('number')
    expect(lastOutboundBody).not.toContain(RECORD_VALUE_SENTINEL)

    const rows = await ledgerRows(USER_SUGGEST)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('suggest')
    expect(rows[0].status).toBe('succeeded')
    expect(rows[0].field_id).toBeNull() // sheet-scoped
    expect(rows[0].record_id).toBeNull()
    expect(Number(rows[0].prompt_tokens)).toBe(18)
    expect(Number(rows[0].completion_tokens)).toBe(7)
  })

  test('M4-T8: a suggest (NULL-scope) row counts in the SAME quota SUM as preview/run — no escape, no corruption', async () => {
    currentUser = { id: USER_QUOTA, roles: ['member'], perms: ['multitable:write'] }
    const query = poolManager.get().query.bind(poolManager.get()) as AiUsageQueryFn

    const before = await sumAiUsageWindows(query, USER_QUOTA)
    expect(before.userDailyTokens).toBe(0)
    expect(before.userWeeklyTokens).toBe(0)

    stubUsage = { input_tokens: 40, output_tokens: 10 }
    const res = await suggestReq('grand total across the sheet')
    expect(res.status).toBe(200)

    // The NULL-scope suggest row is aggregated into the user's daily/weekly
    // token windows EXACTLY like a preview/run row would be (SUM is not scope-filtered).
    const after = await sumAiUsageWindows(query, USER_QUOTA)
    expect(after.userDailyTokens).toBe(before.userDailyTokens + 50)
    expect(after.userWeeklyTokens).toBe(before.userWeeklyTokens + 50)

    // And the row really is the suggest, NULL-scope row.
    const rows = await ledgerRows(USER_QUOTA)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('suggest')
    expect(rows[0].field_id).toBeNull()
    expect(rows[0].record_id).toBeNull()
  })

  test('M4-T8: a daily token cap reached via a suggest row blocks the NEXT suggest (quota interference works both ways)', async () => {
    // Fresh subject so the window starts empty. Estimate-aware admission counts
    // each suggest's own conservative estimate (prompt.length + maxOutputTokens
    // ≈ 1.1k); cap 1500 admits the first suggest (window 0) but not the second
    // (window settles to the ~1000 ACTUAL below, +estimate > 1500).
    const capUser = `u_m4_cap_${TS}`
    currentUser = { id: capUser, roles: ['member'], perms: ['multitable:write'] }
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = '1500'
    stubUsage = { input_tokens: 600, output_tokens: 400 } // ACTUAL ≤ estimate (no overshoot)

    const first = await suggestReq('first formula')
    expect(first.status).toBe(200)
    const callsAfterFirst = fetchCallCount

    // The suggest row (NULL scope) is counted in the daily SUM → the next
    // suggest reserve sees the window exhausted and refuses BEFORE any call.
    const second = await suggestReq('another formula please')
    expect(second.status).toBe(429)
    expect(second.body.status).toBe('quota_exhausted')
    expect(fetchCallCount).toBe(callsAfterFirst) // never reached the provider

    const rows = await ledgerRows(capUser)
    expect(rows.map((row) => row.status)).toEqual(['succeeded', 'quota_exhausted'])
    expect(rows.every((row) => row.action === 'suggest')).toBe(true)
  })

  test('M4-T2: canManageFields gate — a read-only actor is 403', async () => {
    currentUser = { id: `u_m4_reader_${TS}`, roles: ['member'], perms: ['multitable:read'] }
    const res = await suggestReq('price times tax')
    expect(res.status).toBe(403)
  })
})
