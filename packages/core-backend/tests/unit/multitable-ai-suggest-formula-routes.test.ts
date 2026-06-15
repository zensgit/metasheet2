/**
 * M4 / Lane B2 — NL→formula suggest route matrix legs with the REAL router and
 * a mock pool (design §3: M4-T1 / T2 / T3 / T5 / T6 / T7 / T10). The real-DB
 * ledger row + quota non-interference (M4-T8) live in
 * tests/integration/multitable-ai-suggest-formula.test.ts.
 *
 * HARD RULES exercised here:
 *   - fetchFn is injected at CONSTRUCTION — blocked/unsafe/rate-limited requests
 *     make ZERO outbound provider calls.
 *   - RECORD VALUES NEVER enter the prompt (M4-T7 leak sentinel): the spy
 *     captures the outbound request body and asserts it carries field
 *     names+types but NO record data values.
 *   - canManageFields gate (NOT requireRecordReadable/canEditRecord).
 *   - suggest rows are SHEET-SCOPED — record_id/field_id NULL, action=suggest.
 *   - the API key never appears in responses or ledger params.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

const SHEET_ID = 'sheet_ai_suggest'
const FLD_PRICE = 'fld_price'
const FLD_TAX = 'fld_tax'
const FLD_NAME = 'fld_name'

const API_KEY_SENTINEL = `sk-${'suggestleak1'.repeat(3)}`
const RECORD_VALUE_SENTINEL = 'do-not-leak-record-value-9173'
const UNSAFE_INSTRUCTION = `use Bearer ${'b'.repeat(24)} to fetch the total`

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

type QueryResult = { rows: any[]; rowCount?: number }

// Records that DO exist on the sheet — used only to prove their VALUES never
// reach the prompt (the suggest path must not read any record).
const FIELDS = [
  { id: FLD_PRICE, name: 'Unit Price', type: 'number', property: {}, order: 1 },
  { id: FLD_TAX, name: 'Tax Rate', type: 'percent', property: {}, order: 2 },
  { id: FLD_NAME, name: 'Product', type: 'string', property: {}, order: 3 },
]

let currentUser: { id: string; roles: string[]; perms: string[] } | undefined
let ledgerInserts: unknown[][]
let ledgerSettles: unknown[][]
let metaRecordsQueried: boolean

function createMockPool() {
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> => {
    if (sql.includes('INSERT INTO multitable_ai_usage_ledger')) {
      ledgerInserts.push(params ?? [])
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE multitable_ai_usage_ledger')) {
      if (sql.includes(`'in_flight'`)) return { rows: [], rowCount: 0 }
      ledgerSettles.push(params ?? [])
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('FROM multitable_ai_usage_ledger')) {
      return { rows: [{ user_daily_tokens: '0', user_weekly_tokens: '0', instance_daily_usd: '0' }] }
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      return { rows: [] }
    }
    if (sql.includes('FROM meta_records')) {
      // The suggest path must NEVER read records — this is a leak tripwire.
      metaRecordsQueried = true
      return { rows: [{ id: 'rec_x', sheet_id: SHEET_ID, data: { [FLD_PRICE]: RECORD_VALUE_SENTINEL } }] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id')) {
      return { rows: FIELDS.map((f) => ({ ...f })) }
    }
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ id: SHEET_ID }] }
    }
    // sheet_permissions / record_permissions / anything else → empty
    return { rows: [], rowCount: 0 }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

let fetchSpy: ReturnType<typeof vi.fn>
let app: Express

function anthropicSuccess(text = '={fld_price}*(1+{fld_tax})'): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      usage: { input_tokens: 14, output_tokens: 9 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

async function buildApp() {
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { createMultitableAiRoutes } = await import('../../src/routes/multitable-ai')
  vi.spyOn(poolManager, 'get').mockReturnValue(createMockPool() as any)

  const built = express()
  built.use(express.json())
  built.use((req, _res, next) => {
    if (currentUser) (req as any).user = currentUser
    next()
  })
  built.use('/api/multitable', createMultitableAiRoutes({ fetchFn: fetchSpy as unknown as typeof fetch }))
  return built
}

const savedEnv = new Map<string, string | undefined>()
const suggestUrl = `/api/multitable/sheets/${SHEET_ID}/ai/suggest-formula`

describe('M4 suggest-formula routes (mock pool)', () => {
  beforeEach(async () => {
    for (const key of AI_ENV_KEYS) {
      savedEnv.set(key, process.env[key])
      delete process.env[key]
    }
    process.env.MULTITABLE_AI_ENABLED = '1'
    process.env.MULTITABLE_AI_PROVIDER = 'anthropic'
    process.env.MULTITABLE_AI_API_KEY = API_KEY_SENTINEL
    process.env.MULTITABLE_AI_MODEL = 'claude-sonnet-4-6'
    process.env.MULTITABLE_AI_CONFIRM_LIVE_REQUESTS = '1'

    currentUser = { id: 'u_ai_author', roles: ['member'], perms: ['multitable:write'] }
    ledgerInserts = []
    ledgerSettles = []
    metaRecordsQueried = false
    fetchSpy = vi.fn(async () => anthropicSuccess())
    app = await buildApp()
  })

  afterEach(() => {
    for (const key of AI_ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.restoreAllMocks()
  })

  it('M4-T1: readiness ≠ ready → blocked, zero outbound, zero-token suggest ledger row (record/field NULL)', async () => {
    delete process.env.MULTITABLE_AI_API_KEY // breaks readiness → blocked

    const res = await request(app).post(suggestUrl).send({ instruction: 'price times tax' })
    expect(res.status).toBe(503)
    expect(res.body.status).toBe('blocked')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ledgerInserts).toHaveLength(1)
    const params = ledgerInserts[0] as unknown[]
    expect(JSON.stringify(params)).toContain('blocked')
    expect(JSON.stringify(params)).toContain('suggest') // action=suggest
    expect(params).toContain(0) // zero-token row
    // record_id ($6) and field_id ($5) are NULL (sheet-scoped). The INSERT param
    // order is (id,subject_key,user_id,sheet_id,field_id,record_id,action,…).
    expect(params[4]).toBeNull() // field_id
    expect(params[5]).toBeNull() // record_id
  })

  it('M4-T1: E-12 unset → blocked, zero outbound', async () => {
    delete process.env.MULTITABLE_AI_CONFIRM_LIVE_REQUESTS

    const res = await request(app).post(suggestUrl).send({ instruction: 'price times tax' })
    expect(res.status).toBe(503)
    expect(res.body.status).toBe('blocked')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('M4-T2: no canManageFields → 403; unauthenticated → 401; zero outbound', async () => {
    currentUser = { id: 'u_ai_reader', roles: ['member'], perms: ['multitable:read'] }
    const reader = await request(app).post(suggestUrl).send({ instruction: 'price times tax' })
    expect(reader.status).toBe(403)

    currentUser = undefined
    const anon = await request(app).post(suggestUrl).send({ instruction: 'price times tax' })
    expect(anon.status).toBe(401)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ledgerInserts).toHaveLength(0)
  })

  it('M4-T3: success path — returns candidate + usage; settled suggest row tokens>0; no record read', async () => {
    const res = await request(app).post(suggestUrl).send({ instruction: 'unit price times one plus tax' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.status).toBe('succeeded')
    expect(res.body.data.action).toBe('suggest')
    expect(res.body.data.candidate).toBe('={fld_price}*(1+{fld_tax})')
    expect(res.body.data.usage).toEqual({ promptTokens: 14, completionTokens: 9 })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // The suggest path must NOT read any record — field-authoring only.
    expect(metaRecordsQueried).toBe(false)

    // reserve-then-settle: in_flight INSERT then a settle UPDATE to actual usage.
    expect(ledgerInserts).toHaveLength(1)
    expect(JSON.stringify(ledgerInserts[0])).toContain('in_flight')
    expect(ledgerInserts[0]).toContain('suggest')
    expect(ledgerSettles).toHaveLength(1)
    expect(JSON.stringify(ledgerSettles[0])).toContain('succeeded')
  })

  it('M4-T7: leak sentinel — prompt carries field names+types, NEVER record values', async () => {
    const res = await request(app).post(suggestUrl).send({ instruction: 'compute the grand total' })
    expect(res.status).toBe(200)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const outbound = String(init.body)
    // Field NAMES + TYPES present (positive control)…
    expect(outbound).toContain('Unit Price')
    expect(outbound).toContain('Tax Rate')
    expect(outbound).toContain('number')
    expect(outbound).toContain('percent')
    // …but NO record VALUE ever enters the prompt.
    expect(outbound).not.toContain(RECORD_VALUE_SENTINEL)
    // And the suggest path read no records to begin with.
    expect(metaRecordsQueried).toBe(false)
  })

  it('M4-T6: unsafe_input — secret-shaped instruction → 422, refused before any outbound call', async () => {
    const res = await request(app).post(suggestUrl).send({ instruction: UNSAFE_INSTRUCTION })
    expect(res.status).toBe(422)
    expect(res.body.status).toBe('unsafe_input')
    expect(fetchSpy).not.toHaveBeenCalled()

    expect(ledgerInserts).toHaveLength(1)
    expect(JSON.stringify(ledgerInserts[0])).toContain('unsafe_input')
    expect(JSON.stringify(ledgerInserts[0])).not.toContain('bbbbbbbb')
  })

  it('M4-T5: burst rate limit → 429 rate_limited and NO ledger row', async () => {
    process.env.MULTITABLE_AI_TENANT_BURST_RPM = '1'
    app = await buildApp() // limiter caps resolve at router construction

    const first = await request(app).post(suggestUrl).send({ instruction: 'price times tax' })
    expect(first.status).toBe(200)
    const ledgerAfterFirst = ledgerInserts.length

    const second = await request(app).post(suggestUrl).send({ instruction: 'price times tax' })
    expect(second.status).toBe(429)
    expect(second.body.status).toBe('rate_limited')
    expect(ledgerInserts.length).toBe(ledgerAfterFirst) // rate_limited never inserts
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('M4-T5: quota exhausted → 429 quota_exhausted, zero outbound', async () => {
    // Force the window SUM over the cap so the reserve refuses.
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    const pool = createMockPool()
    pool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM multitable_ai_usage_ledger')) {
        return { rows: [{ user_daily_tokens: '999999', user_weekly_tokens: '999999', instance_daily_usd: '0' }] }
      }
      if (sql.includes('INSERT INTO multitable_ai_usage_ledger')) {
        ledgerInserts.push(params ?? [])
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (sql.includes('UPDATE multitable_ai_usage_ledger')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM meta_fields WHERE sheet_id')) return { rows: FIELDS.map((f) => ({ ...f })) }
      if (sql.includes('FROM meta_sheets WHERE id = $1')) return { rows: [{ id: SHEET_ID }] }
      return { rows: [], rowCount: 0 }
    })
    vi.spyOn(poolManager, 'get').mockReturnValue(pool as any)

    const res = await request(app).post(suggestUrl).send({ instruction: 'price times tax' })
    expect(res.status).toBe(429)
    expect(res.body.status).toBe('quota_exhausted')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('M4-T5b: NO-OVERSHOOT — window UNDER the cap whose request estimate would cross it → 429, zero outbound', async () => {
    // cap=1000, window=999 (UNDER the cap). Pre-fix, admission compared the prior SUM only
    // (999 >= 1000 is false → ADMITTED) and the request overshot the cap; only the NEXT request was
    // blocked. With estimate-aware admission, this request's own estimate (prompt + completion ≥ 2)
    // is counted, so 999 + estimate > 1000 → rejected BEFORE any provider call.
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = '1000'
    process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP = '1000000'
    process.env.MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP = '1000'
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    const pool = createMockPool()
    pool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM multitable_ai_usage_ledger')) {
        return { rows: [{ user_daily_tokens: '999', user_weekly_tokens: '0', instance_daily_usd: '0' }] }
      }
      if (sql.includes('INSERT INTO multitable_ai_usage_ledger')) {
        ledgerInserts.push(params ?? [])
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (sql.includes('UPDATE multitable_ai_usage_ledger')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM meta_fields WHERE sheet_id')) return { rows: FIELDS.map((f) => ({ ...f })) }
      if (sql.includes('FROM meta_sheets WHERE id = $1')) return { rows: [{ id: SHEET_ID }] }
      return { rows: [], rowCount: 0 }
    })
    vi.spyOn(poolManager, 'get').mockReturnValue(pool as any)

    const res = await request(app).post(suggestUrl).send({ instruction: 'price times tax' })
    expect(res.status).toBe(429)
    expect(res.body.status).toBe('quota_exhausted')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('M4-T6: validation — empty instruction → 400; over-cap instruction → 400; no outbound', async () => {
    const empty = await request(app).post(suggestUrl).send({ instruction: '   ' })
    expect(empty.status).toBe(400)

    const tooLong = await request(app).post(suggestUrl).send({ instruction: 'x'.repeat(501) })
    expect(tooLong.status).toBe(400)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('M4-T10: the API key never appears in any response or ledger params', async () => {
    const ok = await request(app).post(suggestUrl).send({ instruction: 'price times tax' })
    expect(ok.status).toBe(200)
    expect(JSON.stringify(ok.body)).not.toContain(API_KEY_SENTINEL)

    fetchSpy.mockImplementation(async () => {
      throw new Error(`socket reset, key was ${API_KEY_SENTINEL}`)
    })
    const failed = await request(app).post(suggestUrl).send({ instruction: 'price times tax' })
    expect(failed.status).toBe(502)
    expect(JSON.stringify(failed.body)).not.toContain(API_KEY_SENTINEL)
    expect(JSON.stringify(ledgerInserts)).not.toContain(API_KEY_SENTINEL)
    expect(JSON.stringify(ledgerSettles)).not.toContain(API_KEY_SENTINEL)
  })
})
