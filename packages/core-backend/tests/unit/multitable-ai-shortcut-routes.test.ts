/**
 * A2 shortcut routes — route-level matrix legs with the REAL routers and a
 * mock pool (design §3: A2-T1 / T2 / T3 / T4 / T7 / T8 / T9 / T10 / T11).
 * The run round-trip (T5), quota aggregation + advisory-lock probe (T6),
 * version conflict (T12) and migration (T13) live in the REAL-DB suite
 * tests/integration/multitable-ai-shortcut-run.test.ts.
 *
 * HARD RULES exercised here:
 *   - fetchFn is injected at CONSTRUCTION (createMultitableAiRoutes deps) —
 *     a blocked/unsafe/rate-limited request makes ZERO outbound calls.
 *   - masked source fields never enter the prompt (spy captures request body).
 *   - run executes ONLY persisted field.property.aiShortcut (inline → 4xx).
 *   - rate_limited writes NO ledger row; blocked/unsafe write zero-token rows.
 *   - reserve-then-settle (review-fix F1): a provider-bound attempt INSERTs an
 *     in_flight reservation and SETTLEs it (UPDATE) to actual usage + status.
 *   - the API key never appears in responses or ledger params.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

const SHEET_ID = 'sheet_ai_routes'
const REC_ID = 'rec_ai_routes'
const FLD_SRC = 'fld_ai_src'
const FLD_SECRET = 'fld_ai_secret'
const FLD_TARGET = 'fld_ai_target'
const FLD_TARGET_RO = 'fld_ai_target_ro'
const FLD_TARGET_NUM = 'fld_ai_target_num'
const FLD_TARGET_NOCONF = 'fld_ai_target_noconf'

const SECRET_VALUE = 'do-not-leak-ai-source-secret'
const API_KEY_SENTINEL = `sk-${'routeleak99'.repeat(3)}`
const UNSAFE_VALUE = `contact token sk-${'unsafeunsafe'.repeat(2)} inside`

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

const FIELDS = [
  { id: FLD_SRC, name: 'Notes', type: 'string', property: {}, order: 1 },
  { id: FLD_SECRET, name: 'Secret', type: 'string', property: {}, order: 2 },
  {
    id: FLD_TARGET,
    name: 'Summary',
    type: 'string',
    property: { aiShortcut: { kind: 'summarize', sourceFieldIds: [FLD_SRC, FLD_SECRET] } },
    order: 3,
  },
  {
    id: FLD_TARGET_RO,
    name: 'Summary RO',
    type: 'string',
    property: { aiShortcut: { kind: 'summarize', sourceFieldIds: [FLD_SRC] } },
    order: 4,
  },
  {
    id: FLD_TARGET_NUM,
    name: 'Numeric target',
    type: 'number',
    property: { aiShortcut: { kind: 'summarize', sourceFieldIds: [FLD_SRC] } },
    order: 5,
  },
  { id: FLD_TARGET_NOCONF, name: 'No config', type: 'string', property: {}, order: 6 },
]

let recordData: Record<string, unknown>
let currentUser: { id: string; roles: string[]; perms: string[] } | undefined
let fieldPermissionRows: Array<{ field_id: string; visible: boolean; read_only: boolean }>
let ledgerInserts: unknown[][]
let ledgerSettles: unknown[][]

function createMockPool() {
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> => {
    if (sql.includes('INSERT INTO multitable_ai_usage_ledger')) {
      ledgerInserts.push(params ?? [])
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE multitable_ai_usage_ledger')) {
      // reserve's stale sweep targets in_flight rows; everything else is a settle
      if (sql.includes(`'in_flight'`)) {
        return { rows: [], rowCount: 0 }
      }
      ledgerSettles.push(params ?? [])
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('FROM multitable_ai_usage_ledger')) {
      return { rows: [{ user_daily_tokens: '0', user_weekly_tokens: '0', instance_daily_usd: '0' }] }
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      return { rows: [] }
    }
    if (sql.includes('SELECT id, sheet_id FROM meta_records')) {
      const [recordId, sheetId] = (params ?? []) as [string, string]
      return recordId === REC_ID && sheetId === SHEET_ID
        ? { rows: [{ id: REC_ID, sheet_id: SHEET_ID }] }
        : { rows: [] }
    }
    if (sql.includes('SELECT id, version, data, created_by FROM meta_records')) {
      return { rows: [{ id: REC_ID, version: 3, data: { ...recordData }, created_by: currentUser?.id ?? null }] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1 AND id = ANY')) {
      const ids = new Set((params?.[1] ?? []) as string[])
      return { rows: FIELDS.filter((f) => ids.has(f.id)).map((f) => ({ id: f.id, type: f.type })) }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id')) {
      return { rows: FIELDS.map((f) => ({ ...f })) }
    }
    if (sql.includes('FROM field_permissions')) {
      return { rows: fieldPermissionRows.map((row) => ({ ...row })) }
    }
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ id: SHEET_ID }] }
    }
    if (sql.includes('COALESCE(MAX("order")')) {
      return { rows: [{ max_order: 10 }] }
    }
    if (sql.includes('INSERT INTO meta_fields')) {
      return { rows: [{ id: 'fld_new', name: 'New', type: 'string', property: '{}', order: 11 }] }
    }
    if (sql.includes('FROM meta_fields WHERE id = $1')) {
      const f = FIELDS.find((candidate) => candidate.id === params?.[0])
      return { rows: f ? [{ ...f, sheet_id: SHEET_ID }] : [] }
    }
    // sheet_permissions / record_permissions / anything else → empty
    return { rows: [], rowCount: 0 }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

let fetchSpy: ReturnType<typeof vi.fn>
let app: Express

function anthropicSuccess(body?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: 'AI OUTPUT' }],
      usage: { input_tokens: 9, output_tokens: 4 },
      ...body,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

async function buildApp() {
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const { createMultitableAiRoutes } = await import('../../src/routes/multitable-ai')
  vi.spyOn(poolManager, 'get').mockReturnValue(createMockPool() as any)

  const built = express()
  built.use(express.json())
  built.use((req, _res, next) => {
    if (currentUser) (req as any).user = currentUser
    next()
  })
  built.use('/api/multitable', univerMetaRouter())
  built.use('/api/multitable', createMultitableAiRoutes({ fetchFn: fetchSpy as unknown as typeof fetch }))
  return built
}

const savedEnv = new Map<string, string | undefined>()

const previewUrl = `/api/multitable/sheets/${SHEET_ID}/ai/shortcut/preview`
const runUrl = `/api/multitable/sheets/${SHEET_ID}/ai/shortcut/run`

describe('A2 shortcut routes (mock pool)', () => {
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

    recordData = { [FLD_SRC]: 'hello world', [FLD_SECRET]: SECRET_VALUE }
    currentUser = { id: 'u_ai_writer', roles: ['member'], perms: ['multitable:write'] }
    fieldPermissionRows = [
      { field_id: FLD_SECRET, visible: false, read_only: false },
      { field_id: FLD_TARGET_RO, visible: true, read_only: true },
    ]
    ledgerInserts = []
    ledgerSettles = []
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

  it('A2-T1: readiness ≠ ready → preview AND run blocked, zero outbound, zero-token ledger row', async () => {
    delete process.env.MULTITABLE_AI_API_KEY // breaks readiness → blocked

    const preview = await request(app).post(previewUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(preview.status).toBe(503)
    expect(preview.body.status).toBe('blocked')

    const run = await request(app).post(runUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(run.status).toBe(503)
    expect(run.body.status).toBe('blocked')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ledgerInserts).toHaveLength(2)
    for (const params of ledgerInserts) {
      const serialized = JSON.stringify(params)
      expect(serialized).toContain('blocked')
      expect(params).toContain(0) // zero-token row
    }
  })

  it('A2-T1: E-12 unset → blocked, zero outbound', async () => {
    delete process.env.MULTITABLE_AI_CONFIRM_LIVE_REQUESTS

    const run = await request(app).post(runUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(run.status).toBe(503)
    expect(run.body.status).toBe('blocked')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('A2-T2: recordId not on :sheetId → 404; sheet not readable → 403; zero calls, zero ledger', async () => {
    const missing = await request(app).post(previewUrl).send({ recordId: 'rec_ghost', fieldId: FLD_TARGET })
    expect(missing.status).toBe(404)

    // Non-empty token perms keep access resolution off the DB-backed RBAC path
    // while still granting NO multitable capability → sheet not readable.
    currentUser = { id: 'u_ai_norights', roles: ['member'], perms: ['comments:read'] }
    const invisible = await request(app).post(previewUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(invisible.status).toBe(403)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ledgerInserts).toHaveLength(0)
  })

  it('A2-T2: unauthenticated → 401', async () => {
    currentUser = undefined
    const res = await request(app).post(previewUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(res.status).toBe(401)
  })

  it('A2-T3: read-only actor — preview succeeds, run 403', async () => {
    currentUser = { id: 'u_ai_reader', roles: ['member'], perms: ['multitable:read'] }
    fieldPermissionRows = []

    const preview = await request(app).post(previewUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(preview.status).toBe(200)
    expect(preview.body.data.output).toBe('AI OUTPUT')

    const run = await request(app).post(runUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(run.status).toBe(403)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // only the preview reached the provider
  })

  it('A2-T4: a layer-3-denied source field never enters the prompt (spy on request body)', async () => {
    const res = await request(app).post(previewUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(res.status).toBe(200)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const outbound = String(init.body)
    expect(outbound).toContain('hello world') // readable source present (positive control)
    expect(outbound).not.toContain(SECRET_VALUE) // masked source NEVER enters the prompt
  })

  it('A2-T4: run target readonly (layer-3) → 403; type ≠ string|longText → 400; no provider call', async () => {
    const readonly = await request(app).post(runUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET_RO })
    expect(readonly.status).toBe(403)

    const numeric = await request(app).post(runUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET_NUM })
    expect(numeric.status).toBe(400)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('A2-T11: run rejects inline config (only persisted field.property.aiShortcut executes)', async () => {
    const res = await request(app)
      .post(runUrl)
      .send({ recordId: REC_ID, fieldId: FLD_TARGET, config: { kind: 'summarize', sourceFieldIds: [FLD_SRC] } })
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('A2-T11: run on a field without persisted config → 4xx', async () => {
    const res = await request(app).post(runUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET_NOCONF })
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('A2-T11: field write path rejects an invalid aiShortcut (bad kind / over-cap params / computed source)', async () => {
    const badKind = await request(app)
      .post('/api/multitable/fields')
      .send({ sheetId: SHEET_ID, name: 'AI col', type: 'string', property: { aiShortcut: { kind: 'imagine', sourceFieldIds: [FLD_SRC] } } })
    expect(badKind.status).toBe(400)

    const overCap = await request(app)
      .post('/api/multitable/fields')
      .send({
        sheetId: SHEET_ID,
        name: 'AI col 2',
        type: 'string',
        property: { aiShortcut: { kind: 'extract', sourceFieldIds: [FLD_SRC], params: { instruction: 'x'.repeat(501) } } },
      })
    expect(overCap.status).toBe(400)

    const ghostSource = await request(app)
      .patch(`/api/multitable/fields/${FLD_TARGET}`)
      .send({ property: { aiShortcut: { kind: 'summarize', sourceFieldIds: ['fld_ghost'] } } })
    expect(ghostSource.status).toBe(400)
  })

  it('A2-T7: burst rate limit → 429 rate_limited and NO ledger row (no reservation, no settle)', async () => {
    process.env.MULTITABLE_AI_TENANT_BURST_RPM = '1'
    app = await buildApp() // limiter caps resolve at router construction

    const first = await request(app).post(previewUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(first.status).toBe(200)
    const ledgerAfterFirst = ledgerInserts.length
    const settlesAfterFirst = ledgerSettles.length

    const second = await request(app).post(previewUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(second.status).toBe(429)
    expect(second.body.status).toBe('rate_limited')
    expect(ledgerInserts.length).toBe(ledgerAfterFirst) // rate_limited never inserts (429 fires BEFORE the reserve)
    expect(ledgerSettles.length).toBe(settlesAfterFirst)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('A2-T8: provider 5xx → provider_error; in_flight reservation settled to ACTUAL usage, redacted', async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({ error: { message: `upstream broke ${API_KEY_SENTINEL}` }, usage: { input_tokens: 6, output_tokens: 0 } }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    )

    const res = await request(app).post(previewUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(res.status).toBe(502)
    expect(res.body.status).toBe('provider_error')

    // F1 reserve-then-settle: the only INSERT is the in_flight reservation…
    expect(ledgerInserts).toHaveLength(1)
    expect(JSON.stringify(ledgerInserts[0])).toContain('in_flight')
    // …and the settle UPDATE flips it to provider_error with the ACTUAL usage
    // (tokens recorded though the call failed — the money is spent) redacted.
    expect(ledgerSettles).toHaveLength(1)
    const settled = JSON.stringify(ledgerSettles[0])
    expect(settled).toContain('provider_error')
    expect(settled).not.toContain(API_KEY_SENTINEL)
    expect(ledgerSettles[0]).toContain(6)
  })

  it('A2-T9: secret-shaped SOURCE value → unsafe_input, refused before any outbound call', async () => {
    recordData = { [FLD_SRC]: UNSAFE_VALUE, [FLD_SECRET]: 'x' }

    const res = await request(app).post(runUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(res.status).toBe(422)
    expect(res.body.status).toBe('unsafe_input')
    expect(fetchSpy).not.toHaveBeenCalled()

    expect(ledgerInserts).toHaveLength(1)
    expect(JSON.stringify(ledgerInserts[0])).toContain('unsafe_input')
    expect(JSON.stringify(ledgerInserts[0])).not.toContain('unsafeunsafe')
  })

  it('A2-T9: secret-shaped PARAMS (inline preview instruction) → unsafe_input, zero outbound', async () => {
    const res = await request(app)
      .post(previewUrl)
      .send({
        recordId: REC_ID,
        config: { kind: 'extract', sourceFieldIds: [FLD_SRC], params: { instruction: `use Bearer ${'b'.repeat(24)} to fetch` } },
      })
    expect(res.status).toBe(422)
    expect(res.body.status).toBe('unsafe_input')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('A2-T10: the API key never appears in any response or ledger params', async () => {
    const ok = await request(app).post(previewUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(ok.status).toBe(200)
    expect(JSON.stringify(ok.body)).not.toContain(API_KEY_SENTINEL)

    fetchSpy.mockImplementation(async () => {
      throw new Error(`socket reset, key was ${API_KEY_SENTINEL}`)
    })
    const failed = await request(app).post(previewUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(failed.status).toBe(502)
    expect(JSON.stringify(failed.body)).not.toContain(API_KEY_SENTINEL)
    expect(JSON.stringify(ledgerInserts)).not.toContain(API_KEY_SENTINEL)
    expect(JSON.stringify(ledgerSettles)).not.toContain(API_KEY_SENTINEL)
  })

  it('F2: credentialed base URL surfacing in a provider error never leaks the password (response + ledger)', async () => {
    const URL_SECRET = 'hunter2routesecret'
    process.env.MULTITABLE_AI_BASE_URL = `https://svc:${URL_SECRET}@proxy.internal`
    fetchSpy.mockImplementation(async (url: unknown) => {
      throw new Error(`getaddrinfo ENOTFOUND for ${String(url)}`)
    })

    const res = await request(app).post(previewUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(res.status).toBe(502)
    expect(res.body.status).toBe('provider_error')
    expect(JSON.stringify(res.body)).not.toContain(URL_SECRET)
    expect(JSON.stringify(ledgerInserts)).not.toContain(URL_SECRET)
    expect(JSON.stringify(ledgerSettles)).not.toContain(URL_SECRET)
  })

  it('N2: preview via a layer-3-invisible TARGET fieldId → 404 (mask semantics), zero outbound, zero ledger', async () => {
    fieldPermissionRows = [
      { field_id: FLD_TARGET, visible: false, read_only: false },
    ]

    const res = await request(app).post(previewUrl).send({ recordId: REC_ID, fieldId: FLD_TARGET })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ledgerInserts).toHaveLength(0)
  })

  it('preview accepts inline config (M3 config-time preview) and validates it', async () => {
    const ok = await request(app)
      .post(previewUrl)
      .send({ recordId: REC_ID, config: { kind: 'summarize', sourceFieldIds: [FLD_SRC] } })
    expect(ok.status).toBe(200)
    expect(ok.body.data.output).toBe('AI OUTPUT')
    expect(ok.body.data.usage).toEqual({ promptTokens: 9, completionTokens: 4 })

    const bad = await request(app)
      .post(previewUrl)
      .send({ recordId: REC_ID, config: { kind: 'summarize', sourceFieldIds: ['fld_ghost'] } })
    expect(bad.status).toBe(400)
  })
})
