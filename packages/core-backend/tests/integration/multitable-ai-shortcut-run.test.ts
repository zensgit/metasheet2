/**
 * A2 shortcut run — REAL-DB suite (design §3: A2-T5 / A2-T6 / A2-T12 / A2-T13,
 * docs/development/multitable-ai-shortcut-backend-a2-design-20260611.md).
 *
 * RWS real path is NOT mocked: the run round-trip must land through
 * RecordWriteService.patchRecords (version increment + formula-recalc side
 * effect + the SAME post-commit Yjs invalidation seam as POST /patch).
 * Provider HTTP is NEVER real — fetchFn is injected at router construction
 * (the production seam) and returns canned anthropic-shaped responses.
 *
 * Wired into .github/workflows/plugin-tests.yml multitable real-DB explicit list.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { setYjsInvalidatorForRoutes, univerMetaRouter } from '../../src/routes/univer-meta'
import { createMultitableAiRoutes } from '../../src/routes/multitable-ai'
import { AI_USAGE_LEDGER_TABLE } from '../../src/services/ai-usage-ledger'
import { down as ledgerMigrationDown, up as ledgerMigrationUp } from '../../src/db/migrations/zzzz20260611090000_create_multitable_ai_usage_ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_a2_${TS}`
const SHEET_ID = `sheet_a2_${TS}`
const FLD_SRC = `fld_a2_src_${TS}`
const FLD_TARGET = `fld_a2_target_${TS}`
const FLD_FMT = `fld_a2_fmt_${TS}`
const REC_MAIN = `rec_a2_main_${TS}`
const REC_Q1 = `rec_a2_q1_${TS}`
const REC_Q2 = `rec_a2_q2_${TS}`
const REC_W1 = `rec_a2_w1_${TS}`
const REC_W2 = `rec_a2_w2_${TS}`
const REC_U1 = `rec_a2_u1_${TS}`
const REC_U2 = `rec_a2_u2_${TS}`
const REC_C = [1, 2, 3, 4].map((i) => `rec_a2_c${i}_${TS}`)
const REC_X = `rec_a2_x_${TS}`
const REC_S = `rec_a2_stale_${TS}`

const USER_RUN = `u_a2_run_${TS}`
const USER_QUOTA_D = `u_a2_qd_${TS}`
const USER_QUOTA_W = `u_a2_qw_${TS}`
const USER_USD_A = `u_a2_ua_${TS}`
const USER_USD_B = `u_a2_ub_${TS}`
const USER_CONC = `u_a2_conc_${TS}`
const USER_CONF = `u_a2_conf_${TS}`
const USER_STALE = `u_a2_stale_${TS}`

const API_KEY_SENTINEL = `sk-${'realdbleak0'.repeat(3)}`

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
let currentUser: { id: string; roles: string[]; perms: string[] } = { id: USER_RUN, roles: ['member'], perms: ['multitable:write'] }
let stubUsage = { input_tokens: 21, output_tokens: 13 }
let beforeRespond: (() => Promise<void>) | null = null
let fetchCallCount = 0
const invalidatedBatches: string[][] = []
const savedEnv = new Map<string, string | undefined>()

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const fetchStub = (async (_url: unknown, _init?: unknown) => {
  fetchCallCount += 1
  if (beforeRespond) await beforeRespond()
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text: 'AI OUT' }], usage: { ...stubUsage } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}) as typeof fetch

const runReq = (recordId: string) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/run`).send({ recordId, fieldId: FLD_TARGET })

const ledgerRows = async (userId: string) => {
  const res = await q(
    `SELECT action, status, prompt_tokens, completion_tokens, estimated_cost_usd, error FROM ${AI_USAGE_LEDGER_TABLE} WHERE user_id = $1 ORDER BY occurred_at ASC`,
    [userId],
  )
  return res.rows as Array<{ action: string; status: string; prompt_tokens: number; completion_tokens: number; estimated_cost_usd: string; error: string | null }>
}

const recordRow = async (recordId: string) => {
  const res = await q('SELECT version, data FROM meta_records WHERE id = $1', [recordId])
  return res.rows[0] as { version: number; data: Record<string, unknown> }
}

async function seedRecord(recordId: string, srcValue: string) {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
    recordId,
    SHEET_ID,
    JSON.stringify({ [FLD_SRC]: srcValue }),
  ])
}

describeIfDatabase('A2 shortcut run (real DB)', () => {
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

    setYjsInvalidatorForRoutes(async (recordIds) => {
      invalidatedBatches.push([...recordIds])
    })

    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = currentUser
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    app.use('/api/multitable', createMultitableAiRoutes({ fetchFn: fetchStub }))

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'A2 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'A2 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SRC, SHEET_ID, 'Notes', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      FLD_TARGET,
      SHEET_ID,
      'Summary',
      'string',
      JSON.stringify({ aiShortcut: { kind: 'summarize', sourceFieldIds: [FLD_SRC] } }),
      2,
    ])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      FLD_FMT,
      SHEET_ID,
      'Decorated',
      'formula',
      JSON.stringify({ expression: `={${FLD_TARGET}}&"!"` }),
      3,
    ])
    // Direct-SQL field seed bypasses the create-field dependency tracking (F3 precedent) —
    // recalculateFormulaFields gates on formula_dependencies, so seed the edge explicitly.
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)', [SHEET_ID, FLD_FMT, FLD_TARGET, SHEET_ID])

    await seedRecord(REC_MAIN, 'quarterly numbers look strong')
    await seedRecord(REC_Q1, 'q1')
    await seedRecord(REC_Q2, 'q2')
    await seedRecord(REC_W1, 'w1')
    await seedRecord(REC_W2, 'w2')
    await seedRecord(REC_U1, 'u1')
    await seedRecord(REC_U2, 'u2')
    for (const recId of REC_C) await seedRecord(recId, 'concurrent')
    await seedRecord(REC_X, 'conflict source')
    await seedRecord(REC_S, 'stale sweep source')
  })

  afterAll(async () => {
    setYjsInvalidatorForRoutes(null)
    await q(`DELETE FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
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

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('A2-T5: run lands through patchRecords — version increment, formula recalc, Yjs hook, ledger', async () => {
    currentUser = { id: USER_RUN, roles: ['member'], perms: ['multitable:write'] }
    stubUsage = { input_tokens: 21, output_tokens: 13 }
    invalidatedBatches.length = 0

    const res = await runReq(REC_MAIN)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.status).toBe('succeeded')
    expect(res.body.data.output).toBe('AI OUT')
    expect(res.body.data.usage).toEqual({ promptTokens: 21, completionTokens: 13 })
    expect(res.body.data.version).toBe(2) // optimistic-lock increment through RWS

    const row = await recordRow(REC_MAIN)
    expect(row.data[FLD_TARGET]).toBe('AI OUT') // value landed via the authoritative write path
    expect(row.data[FLD_FMT]).toBe('AI OUT!') // formula recalc side effect (RWS Step 4c)
    expect(Number(row.version)).toBeGreaterThanOrEqual(2)

    // SAME post-commit Yjs invalidation seam as POST /patch
    expect(invalidatedBatches.some((batch) => batch.includes(REC_MAIN))).toBe(true)

    const rows = await ledgerRows(USER_RUN)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('run')
    expect(rows[0].status).toBe('succeeded')
    expect(Number(rows[0].prompt_tokens)).toBe(21)
    expect(Number(rows[0].completion_tokens)).toBe(13)
    expect(Number(rows[0].estimated_cost_usd)).toBeGreaterThan(0)

    expect(JSON.stringify(res.body)).not.toContain(API_KEY_SENTINEL)
  })

  test('A2-T6: user DAILY token cap — second run quota_exhausted with zero provider calls', async () => {
    currentUser = { id: USER_QUOTA_D, roles: ['member'], perms: ['multitable:write'] }
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = '1000'
    stubUsage = { input_tokens: 600, output_tokens: 400 } // exactly the cap

    const first = await runReq(REC_Q1)
    expect(first.status).toBe(200)
    const callsAfterFirst = fetchCallCount

    const second = await runReq(REC_Q2)
    expect(second.status).toBe(429)
    expect(second.body.status).toBe('quota_exhausted')
    expect(fetchCallCount).toBe(callsAfterFirst) // never reached the provider

    const rows = await ledgerRows(USER_QUOTA_D)
    expect(rows.map((row) => row.status)).toEqual(['succeeded', 'quota_exhausted'])
    expect(Number(rows[1].prompt_tokens) + Number(rows[1].completion_tokens)).toBe(0) // zero-token row

    delete process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP
  })

  test('A2-T6: user WEEKLY token cap — second run quota_exhausted', async () => {
    currentUser = { id: USER_QUOTA_W, roles: ['member'], perms: ['multitable:write'] }
    process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP = '1000'
    stubUsage = { input_tokens: 1000, output_tokens: 0 }

    const first = await runReq(REC_W1)
    expect(first.status).toBe(200)

    const second = await runReq(REC_W2)
    expect(second.status).toBe(429)
    expect(second.body.status).toBe('quota_exhausted')

    delete process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP
  })

  test('A2-T6: INSTANCE daily USD cap (Q-4 "__instance__") — blocks ACROSS users', async () => {
    // Scope the instance-wide aggregate to this run: clear today's rows first
    // (this suite is the only ledger writer; local reruns would otherwise accumulate).
    await q(`DELETE FROM ${AI_USAGE_LEDGER_TABLE} WHERE occurred_at >= date_trunc('day', now())`)
    process.env.MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP = '1'
    // claude-sonnet-4-6 估算 pricing: 300k input + 10k output ≈ $1.05 ≥ cap after one call
    stubUsage = { input_tokens: 300_000, output_tokens: 10_000 }

    currentUser = { id: USER_USD_A, roles: ['member'], perms: ['multitable:write'] }
    const first = await runReq(REC_U1)
    expect(first.status).toBe(200)

    currentUser = { id: USER_USD_B, roles: ['member'], perms: ['multitable:write'] }
    const second = await runReq(REC_U2)
    expect(second.status).toBe(429)
    expect(second.body.status).toBe('quota_exhausted')

    delete process.env.MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP
  })

  test('A2-T6: concurrency probe — reserve-then-settle (F1), N parallel runs cannot overshoot', async () => {
    currentUser = { id: USER_CONC, roles: ['member'], perms: ['multitable:write'] }
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = '1000'
    stubUsage = { input_tokens: 1000, output_tokens: 0 }
    const callsBefore = fetchCallCount

    const results = await Promise.all(REC_C.map((recId) => runReq(recId)))
    const statuses = results.map((res) => res.status).sort()
    expect(statuses).toEqual([200, 429, 429, 429]) // exactly ONE winner

    // Losers fail at the RESERVE (the winner's in_flight estimate exhausts the
    // cap) — quota_exhausted, NOT the burst limiter's rate_limited.
    for (const lost of results.filter((res) => res.status === 429)) {
      expect(lost.body.status).toBe('quota_exhausted')
    }

    expect(fetchCallCount).toBe(callsBefore + 1) // losers never reached the provider

    // Settle path: the winner's reservation row was UPDATEd from the
    // conservative estimate (ceil(promptChars/4) + maxOutputTokens) to the
    // ACTUAL provider usage; nothing stays in_flight.
    const rows = await ledgerRows(USER_CONC)
    const succeeded = rows.filter((row) => row.status === 'succeeded')
    expect(succeeded).toHaveLength(1)
    expect(Number(succeeded[0].prompt_tokens)).toBe(1000)
    expect(Number(succeeded[0].completion_tokens)).toBe(0)
    expect(rows.filter((row) => row.status === 'quota_exhausted')).toHaveLength(3)
    expect(rows.some((row) => row.status === 'in_flight')).toBe(false)

    const sumRes = await q(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total FROM ${AI_USAGE_LEDGER_TABLE} WHERE subject_key = $1`,
      [USER_CONC],
    )
    expect(Number((sumRes.rows[0] as { total: string }).total)).toBe(1000) // SUM(tokens) cap-bounded with ACTUALS after settle

    delete process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP
  })

  test('A2-T6: crash-orphaned in_flight reservation — swept to zero-usage abandoned by the next reserve', async () => {
    currentUser = { id: USER_STALE, roles: ['member'], perms: ['multitable:write'] }
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = '1000'
    stubUsage = { input_tokens: 10, output_tokens: 5 }

    // Simulate a crash between reserve and settle: an in_flight reservation old
    // enough to exceed the grace window (requestTimeoutMs default 15s + 60s),
    // large enough that it would exhaust the cap if it kept counting.
    const staleId = `aiu_stale_${TS}`
    await q(
      `INSERT INTO ${AI_USAGE_LEDGER_TABLE}
         (id, occurred_at, subject_key, user_id, sheet_id, field_id, record_id, action,
          prompt_tokens, completion_tokens, estimated_cost_usd, status)
       VALUES ($1, now() - interval '10 minutes', $2, $2, $3, $4, $5, 'run', 999999, 1024, 3.5, 'in_flight')`,
      [staleId, USER_STALE, SHEET_ID, FLD_TARGET, REC_S],
    )

    const res = await runReq(REC_S)
    // NOT quota_exhausted: the reserve's in-tx sweep zeroes the stale row BEFORE the SUM check.
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('succeeded')

    const staleRow = await q(
      `SELECT status, prompt_tokens, completion_tokens, estimated_cost_usd FROM ${AI_USAGE_LEDGER_TABLE} WHERE id = $1`,
      [staleId],
    )
    const swept = staleRow.rows[0] as { status: string; prompt_tokens: number; completion_tokens: number; estimated_cost_usd: string }
    expect(swept.status).toBe('abandoned')
    expect(Number(swept.prompt_tokens)).toBe(0)
    expect(Number(swept.completion_tokens)).toBe(0)
    expect(Number(swept.estimated_cost_usd)).toBe(0)

    delete process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP
  })

  test('A2-T12: version conflict — 409 passthrough, NO value landed, provider usage STILL ledgered', async () => {
    currentUser = { id: USER_CONF, roles: ['member'], perms: ['multitable:write'] }
    stubUsage = { input_tokens: 17, output_tokens: 5 }
    beforeRespond = async () => {
      // Concurrent edit between the captured read and patchRecords
      await q('UPDATE meta_records SET version = version + 1 WHERE id = $1', [REC_X])
    }

    const res = await runReq(REC_X)
    beforeRespond = null

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('VERSION_CONFLICT')
    expect(typeof res.body.error.serverVersion).toBe('number')

    const row = await recordRow(REC_X)
    expect(row.data[FLD_TARGET]).toBeUndefined() // no silent overwrite

    const rows = await ledgerRows(USER_CONF)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('version_conflict')
    expect(Number(rows[0].prompt_tokens)).toBe(17) // money was spent — tokens recorded regardless of downstream
  })

  test('A2-T13: migration — table + indexes exist; down() removes cleanly; up() restores', async () => {
    const kysely = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }) }),
    })
    try {
      const tableExists = async () => {
        const res = await q('SELECT to_regclass($1) AS reg', [AI_USAGE_LEDGER_TABLE])
        return (res.rows[0] as { reg: string | null }).reg !== null
      }
      const indexNames = async () => {
        const res = await q('SELECT indexname FROM pg_indexes WHERE tablename = $1', [AI_USAGE_LEDGER_TABLE])
        return (res.rows as Array<{ indexname: string }>).map((row) => row.indexname)
      }

      expect(await tableExists()).toBe(true)
      const names = await indexNames()
      expect(names).toContain('idx_mt_ai_usage_subject_occurred')
      expect(names).toContain('idx_mt_ai_usage_occurred_desc')

      await ledgerMigrationDown(kysely)
      expect(await tableExists()).toBe(false)

      await ledgerMigrationUp(kysely)
      expect(await tableExists()).toBe(true)
      expect(await indexNames()).toContain('idx_mt_ai_usage_subject_occurred')
    } finally {
      await kysely.destroy()
    }
  })
})
