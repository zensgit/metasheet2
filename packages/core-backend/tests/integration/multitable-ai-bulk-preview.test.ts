/**
 * B-1 AI bulk-PREVIEW — REAL-DB suite.
 *
 * Design lock:
 * docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md
 *
 * Locks the five B-1 acceptance subjects:
 *  1. Mixed-permission LEAK gate (D5, fail-first): a row-level READ-denied row
 *     is OMITTED entirely; a readable-but-not-writable row is `skipped_no_perm`
 *     with NO generation; a readable row whose SOURCE field is denied generates
 *     with the masked source NEVER in the prompt (captured fetch body) NOR the
 *     diff, flagged `masked`.
 *  2. Charge-on-generation GOLDEN (D1-A): provider-called rows are booked into
 *     the existing usage ledger; skipped / no-usage rows book nothing; the
 *     ledger token-sum delta == the provider usage-sum (== fetch calls).
 *  3. D3-A cap → 400 BULK_SCOPE_TOO_LARGE + D4 quota-insufficient → refuse-zero.
 *  4. Run-cache rows persisted with the full shape (one per generated output).
 *  5. ZERO real provider calls (fetch is the injected construction seam).
 *
 * Provider HTTP is NEVER real — fetchFn is injected at router construction (the
 * production seam) and returns a canned anthropic-shaped response. The outbound
 * request BODY is captured so the mask assertion is over the REAL prompt, not a
 * fixture (wire-vs-fixture-drift discipline).
 *
 * Wired into .github/workflows/plugin-tests.yml multitable real-DB explicit list.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { createMultitableAiRoutes } from '../../src/routes/multitable-ai'
import { AI_USAGE_LEDGER_TABLE } from '../../src/services/ai-usage-ledger'
import { AI_BULK_PREVIEW_CACHE_TABLE } from '../../src/services/ai-bulk-preview-cache'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_b1_${TS}`
const SHEET_ID = `sheet_b1_${TS}`
const VIEW_ID = `view_b1_${TS}`
const FLD_SRC = `fld_b1_src_${TS}`
const FLD_SECRET = `fld_b1_secret_${TS}` // a SOURCE field denied to the actor (layer-3)
const FLD_TARGET = `fld_b1_target_${TS}`
const FLD_FLAG = `fld_b1_flag_${TS}` // a filterable string field for the view-scope test

// The actor under test (member with write — own-write scope added per test).
const ACTOR = `u_b1_actor_${TS}`
const OTHER = `u_b1_other_${TS}` // creator of the not-writable row

// A distinctive sentinel placed in the DENIED source field — must never appear
// in any outbound prompt body nor any response (the real leak assertion).
const SECRET_SENTINEL = `SECRET-${'leakcanary'.repeat(2)}-${TS}`
const API_KEY_SENTINEL = `sk-${'bulkleak000'.repeat(3)}`

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
  'MULTITABLE_AI_BULK_MAX_ROWS',
] as const

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
let stubUsage = { input_tokens: 20, output_tokens: 10 }
let fetchCallCount = 0
/** When true the provider stub returns a NON-200 with no usage = the genuine generation_failed_before_usage path. */
let providerErrorMode = false
/** When true the stub returns NON-200 but WITH usage = provider_error-WITH-usage → core 'charged' + !ok (charged-failure). */
let providerErrorWithUsageMode = false
const capturedBodies: string[] = []
const savedEnv = new Map<string, string | undefined>()

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const fetchStub = (async (_url: unknown, init?: unknown) => {
  fetchCallCount += 1
  const body = (init as { body?: unknown } | undefined)?.body
  if (typeof body === 'string') capturedBodies.push(body)
  if (providerErrorMode) {
    // Provider FAILURE with NO usage → AiCompletionResult.status='provider_error',
    // usage=null → the core's generation_failed_before_usage (UNCHARGED) path.
    return new Response(JSON.stringify({ error: 'upstream boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
  if (providerErrorWithUsageMode) {
    // NON-200 but the body carries usage → extractUsageFromBody finds it + !response.ok
    // → providerError(usage) → core 'charged' + !result.ok (a CHARGED failure, not a success).
    return new Response(JSON.stringify({ error: 'billed but failed', usage: { ...stubUsage } }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text: 'AI OUT' }], usage: { ...stubUsage } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}) as typeof fetch

const bulkReq = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-preview`).send(body)

const ledgerRows = async () => {
  const res = await q(
    `SELECT action, status, prompt_tokens, completion_tokens FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1 ORDER BY occurred_at ASC`,
    [SHEET_ID],
  )
  return res.rows as Array<{ action: string; status: string; prompt_tokens: number; completion_tokens: number }>
}
const ledgerTokenSum = async () => {
  const res = await q(
    `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`,
    [SHEET_ID],
  )
  return Number((res.rows[0] as { total: string }).total)
}
const cacheRows = async (runId: string) => {
  const res = await q(
    `SELECT run_id, record_id, actor_id, sheet_id, field_id, preview_version, proposed_value, usage_tokens, cost_usd, expires_at
       FROM ${AI_BULK_PREVIEW_CACHE_TABLE} WHERE run_id = $1 ORDER BY record_id ASC`,
    [runId],
  )
  return res.rows as Array<Record<string, unknown>>
}

async function seedRecord(recordId: string, data: Record<string, unknown>, createdBy: string) {
  await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [
    recordId,
    SHEET_ID,
    JSON.stringify(data),
    createdBy,
  ])
}

/** Wipe the per-run side effects so each test starts from a clean ledger/cache. */
async function resetLedgerAndCache() {
  await q(`DELETE FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
  await q(`DELETE FROM ${AI_BULK_PREVIEW_CACHE_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
  fetchCallCount = 0
  capturedBodies.length = 0
}

describeIfDatabase('B-1 AI bulk-preview (real DB)', () => {
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

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'B1 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'B1 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SRC, SHEET_ID, 'Notes', 'string', '{}', 1])
    // FLD_SECRET is a SOURCE field of the shortcut, but layer-3 denied to the actor.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'string', '{}', 2])
    // Target: persisted aiShortcut summarizing BOTH sources (so a denied source is detectable as masked).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      FLD_TARGET,
      SHEET_ID,
      'Summary',
      'string',
      JSON.stringify({ aiShortcut: { kind: 'summarize', sourceFieldIds: [FLD_SRC, FLD_SECRET] } }),
      3,
    ])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_FLAG, SHEET_ID, 'Flag', 'string', '{}', 4])

    // Layer-3 deny FLD_SECRET to the actor (field_permissions: visible=false → denied read).
    await q(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
       VALUES ($1,$2,'user',$3,false,false)`,
      [SHEET_ID, FLD_SECRET, ACTOR],
    )
    // Enable row-level read-deny enforcement so an access_level='none' grant
    // actually denies read on the per-record path (#18 is flag-gated).
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = true WHERE id = $1', [SHEET_ID])
  })

  afterAll(async () => {
    await q(`DELETE FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
    await q(`DELETE FROM ${AI_BULK_PREVIEW_CACHE_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    for (const key of AI_ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  beforeEach(async () => {
    currentUser = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    stubUsage = { input_tokens: 20, output_tokens: 10 }
    providerErrorMode = false
    providerErrorWithUsageMode = false
    // Reset per-test caps (a low cap leaking forward would turn later tests red).
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = savedEnv.get('MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP') ?? ''
    process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP = savedEnv.get('MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP') ?? ''
    if (!process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP) delete process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP
    if (!process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP) delete process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP
    delete process.env.MULTITABLE_AI_BULK_MAX_ROWS
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await resetLedgerAndCache()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── Test 1: mixed-permission LEAK gate (fail-first) ───────────────────────
  test('LEAK gate: read-deny omitted, unwritable skipped, masked-source never in prompt/diff', async () => {
    // Own-write scope: actor may write only records they CREATED.
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
      [SHEET_ID, ACTOR, 'multitable:write-own'],
    )

    // R_OK: actor-created, fully readable → GENERATED (masked because FLD_SECRET denied).
    const R_OK = `rec_b1_ok_${TS}`
    await seedRecord(R_OK, { [FLD_SRC]: 'public notes', [FLD_SECRET]: SECRET_SENTINEL }, ACTOR)
    // R_READDENY: actor-created (so removing the read gate would GENERATE it — fail-first) but
    // record-level read-DENIED → must be OMITTED from the response entirely.
    const R_READDENY = `rec_b1_readdeny_${TS}`
    await seedRecord(R_READDENY, { [FLD_SRC]: 'hidden row', [FLD_SECRET]: SECRET_SENTINEL }, ACTOR)
    await q(
      `INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,'user',$3,'none')`,
      [SHEET_ID, R_READDENY, ACTOR],
    )
    // R_NOWRITE: created by SOMEONE ELSE → readable but own-write policy denies → skipped_no_perm.
    const R_NOWRITE = `rec_b1_nowrite_${TS}`
    await seedRecord(R_NOWRITE, { [FLD_SRC]: 'others row', [FLD_SECRET]: SECRET_SENTINEL }, OTHER)

    const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(res.status).toBe(200)

    const rowIds = (res.body.rows as Array<{ recordId: string }>).map((r) => r.recordId)
    const skippedIds = (res.body.skipped as Array<{ recordId: string; reason: string }>)

    // R_OK generated + flagged masked (FLD_SECRET dropped from its prompt).
    expect(rowIds).toContain(R_OK)
    const okRow = (res.body.rows as Array<{ recordId: string; masked: boolean; writable: boolean; proposed: string }>).find((r) => r.recordId === R_OK)!
    expect(okRow.masked).toBe(true)
    expect(okRow.writable).toBe(true)
    expect(okRow.proposed).toBe('AI OUT')

    // R_READDENY omitted from BOTH rows and skipped (never confirms existence).
    expect(rowIds).not.toContain(R_READDENY)
    expect(skippedIds.map((s) => s.recordId)).not.toContain(R_READDENY)

    // R_NOWRITE skipped_no_perm, NOT generated.
    expect(rowIds).not.toContain(R_NOWRITE)
    expect(skippedIds).toContainEqual({ recordId: R_NOWRITE, reason: 'skipped_no_perm' })

    // THE REAL LEAK ASSERTION (over the captured outbound prompt, not a fixture):
    // the denied source sentinel appears in NO prompt body and NO response.
    expect(capturedBodies.length).toBe(1) // only R_OK reached the provider
    for (const body of capturedBodies) expect(body).not.toContain(SECRET_SENTINEL)
    expect(JSON.stringify(res.body)).not.toContain(SECRET_SENTINEL)
    // But the READABLE source DID enter the prompt (proves we didn't just drop everything).
    expect(capturedBodies[0]).toContain('public notes')

    expect(JSON.stringify(res.body)).not.toContain(API_KEY_SENTINEL)
  })

  // ── Test 2: charge-on-generation golden ───────────────────────────────────
  test('charge-on-generation: provider-called rows booked; skipped books nothing; token-sum delta == provider usage', async () => {
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
      [SHEET_ID, ACTOR, 'multitable:write-own'],
    )
    stubUsage = { input_tokens: 30, output_tokens: 12 } // 42 tokens/charged row

    // 2 writable (actor) → charged; 1 not-writable (other) → skipped, no charge.
    const C1 = `rec_b1_c1_${TS}`
    const C2 = `rec_b1_c2_${TS}`
    const C_SKIP = `rec_b1_cskip_${TS}`
    await seedRecord(C1, { [FLD_SRC]: 'one' }, ACTOR)
    await seedRecord(C2, { [FLD_SRC]: 'two' }, ACTOR)
    await seedRecord(C_SKIP, { [FLD_SRC]: 'three' }, OTHER)

    const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(res.status).toBe(200)
    expect((res.body.rows as unknown[]).length).toBe(2)
    expect(res.body.skipped).toContainEqual({ recordId: C_SKIP, reason: 'skipped_no_perm' })

    // Provider was called exactly once per charged row.
    expect(fetchCallCount).toBe(2)

    // Ledger: exactly the 2 charged preview rows, each at the ACTUAL usage; skipped books NOTHING.
    const rows = await ledgerRows()
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.action === 'preview' && r.status === 'succeeded')).toBe(true)

    // THE CHARGE INVARIANT: ledger token-sum == provider usage-sum (== calls × 42).
    expect(await ledgerTokenSum()).toBe(2 * (30 + 12))
    // settledCost is positive and only over charged rows.
    expect(res.body.settledCost).toBeGreaterThan(0)
  })

  test('charge-on-generation: a provider failure with NO output books NOTHING (generation_failed_before_usage)', async () => {
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
      [SHEET_ID, ACTOR, 'multitable:write-own'],
    )
    // Provider FAILS (non-200, no usage) → generation_failed_before_usage → UNCHARGED + pauses batch.
    providerErrorMode = true

    const N1 = `rec_b1_n1_${TS}`
    await seedRecord(N1, { [FLD_SRC]: 'will fail' }, ACTOR)

    const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(res.status).toBe(200)
    expect((res.body.rows as unknown[]).length).toBe(0)
    expect(res.body.skipped).toContainEqual({ recordId: N1, reason: 'generation_failed_before_usage' })

    // Provider WAS reached, but produced no output / no usage → ledger token-sum stays 0 (booked nothing).
    expect(fetchCallCount).toBe(1)
    expect(await ledgerTokenSum()).toBe(0)
  })

  test('charge: provider_error WITH usage → CHARGED, NO cache row, NO writable row (charged-failure)', async () => {
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
      [SHEET_ID, ACTOR, 'multitable:write-own'],
    )
    stubUsage = { input_tokens: 30, output_tokens: 12 }
    providerErrorWithUsageMode = true // provider billed usage but returned an error → charged + !ok

    const E1 = `rec_b1_e1_${TS}`
    await seedRecord(E1, { [FLD_SRC]: 'billed but failed' }, ACTOR)

    const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(res.status).toBe(200)
    // NOT a confirmable/writable row, and NOT in `skipped` (it WAS charged).
    expect((res.body.rows as unknown[]).length).toBe(0)
    expect(res.body.failures).toContainEqual({ recordId: E1, reason: 'provider_error_charged' })

    // CHARGED: provider spend is real — the ledger booked the usage even with no output.
    expect(fetchCallCount).toBe(1)
    expect(await ledgerTokenSum()).toBe(30 + 12)
    // NO cached output → B-2 can never confirm it.
    expect((await cacheRows(res.body.runId as string)).length).toBe(0)
  })

  test('cache insert failure → CHARGED but fail-closed (cache_failed_after_generation), NO confirmable row', async () => {
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
      [SHEET_ID, ACTOR, 'multitable:write-own'],
    )
    stubUsage = { input_tokens: 25, output_tokens: 11 }

    const F1 = `rec_b1_cachefail_${TS}`
    await seedRecord(F1, { [FLD_SRC]: 'generates ok but the cache write breaks' }, ACTOR)

    // Force a GENUINE cache INSERT failure: rename the cache table away for the run.
    await q(`ALTER TABLE ${AI_BULK_PREVIEW_CACHE_TABLE} RENAME TO ${AI_BULK_PREVIEW_CACHE_TABLE}_bak`)
    try {
      const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'sheet' })
      expect(res.status).toBe(200)
      // Provider succeeded + billed, but the cache write failed → FAIL-CLOSED:
      // NOT a writable/confirmable row; recorded as a CHARGED failure.
      expect((res.body.rows as unknown[]).length).toBe(0)
      expect(res.body.failures).toContainEqual({ recordId: F1, reason: 'cache_failed_after_generation' })
      // CHARGED: the provider was called + billed despite the cache failure (ledger table is NOT renamed).
      expect(fetchCallCount).toBe(1)
      expect(await ledgerTokenSum()).toBe(25 + 11)
    } finally {
      // ALWAYS restore the table so subsequent tests + reset hooks work.
      await q(`ALTER TABLE ${AI_BULK_PREVIEW_CACHE_TABLE}_bak RENAME TO ${AI_BULK_PREVIEW_CACHE_TABLE}`)
    }
  })

  // ── Test 3: cap → 400 + quota-insufficient → refuse-zero ──────────────────
  test('D3-A over-cap → 400 BULK_SCOPE_TOO_LARGE, nothing generated', async () => {
    process.env.MULTITABLE_AI_BULK_MAX_ROWS = '2'
    for (let i = 0; i < 3; i += 1) await seedRecord(`rec_b1_cap${i}_${TS}`, { [FLD_SRC]: `r${i}` }, ACTOR)

    const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BULK_SCOPE_TOO_LARGE')
    expect(res.body.error.total).toBe(3)
    expect(res.body.error.cap).toBe(2)
    expect(fetchCallCount).toBe(0) // generated nothing
    expect(await ledgerTokenSum()).toBe(0)
  })

  test('D4 quota-insufficient → AI_BULK_QUOTA_INSUFFICIENT, generates nothing', async () => {
    // Per-row estimate ≈ conservativePromptTokenEstimate('') + maxOutputTokens(1024) ≈ 1024.
    // Cap 1500 fits ONE row but not TWO → the whole 2-row run is refused up front.
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = '1500'
    await seedRecord(`rec_b1_q1_${TS}`, { [FLD_SRC]: 'a' }, ACTOR)
    await seedRecord(`rec_b1_q2_${TS}`, { [FLD_SRC]: 'b' }, ACTOR)

    const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('AI_BULK_QUOTA_INSUFFICIENT')
    expect(fetchCallCount).toBe(0) // generate NOTHING
    expect(await ledgerTokenSum()).toBe(0)
  })

  test('cap counts ONLY provider-bound rows: read-denied rows over the cap do NOT 400 (no hidden-row oracle)', async () => {
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
      [SHEET_ID, ACTOR, 'multitable:write-own'],
    )
    process.env.MULTITABLE_AI_BULK_MAX_ROWS = '1' // cap = 1 GENERATABLE row

    const G1 = `rec_b1_capok_${TS}`
    await seedRecord(G1, { [FLD_SRC]: 'generate me' }, ACTOR)
    // 3 read-denied rows (actor-created so WRITE would pass; the READ gate omits them) →
    // raw candidates = 4 > cap, but generatable = 1. Pre-fix this 400'd AND leaked total=4.
    for (let i = 0; i < 3; i += 1) {
      const H = `rec_b1_caphidden${i}_${TS}`
      await seedRecord(H, { [FLD_SRC]: 'hidden' }, ACTOR)
      await q(
        `INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,'user',$3,'none')`,
        [SHEET_ID, H, ACTOR],
      )
    }

    const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(res.status).toBe(200) // NOT 400 — hidden rows are never counted toward the cap
    expect((res.body.rows as unknown[]).length).toBe(1)
    expect(fetchCallCount).toBe(1)
  })

  test('quota counts ONLY provider-bound rows: many unwritable rows do NOT trip AI_BULK_QUOTA_INSUFFICIENT', async () => {
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
      [SHEET_ID, ACTOR, 'multitable:write-own'],
    )
    // Cap 1500 fits ONE generatable row (~1024) but not two (same math as the Test 3 quota case).
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = '1500'

    await seedRecord(`rec_b1_qok_${TS}`, { [FLD_SRC]: 'mine' }, ACTOR) // 1 writable
    // 5 NOT-writable rows (created by OTHER) → skipped_no_perm, NOT counted toward quota.
    // Pre-fix, the estimate over 6 rows (~6144) would have 429'd the whole run.
    for (let i = 0; i < 5; i += 1) await seedRecord(`rec_b1_qother${i}_${TS}`, { [FLD_SRC]: 'theirs' }, OTHER)

    const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(res.status).toBe(200) // NOT 429 — unwritable rows are never counted toward the quota
    expect((res.body.rows as unknown[]).length).toBe(1)
    expect((res.body.skipped as Array<{ reason: string }>).filter((s) => s.reason === 'skipped_no_perm').length).toBe(5)
  })

  test('view filter on a COMPUTED (formula) field → 422 AI_BULK_VIEW_FILTER_UNSUPPORTED, generates NOTHING (no out-of-view rows)', async () => {
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
      [SHEET_ID, ACTOR, 'multitable:write-own'],
    )
    const FLD_FORMULA = `fld_b1_formula_${TS}`
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_FORMULA, SHEET_ID, 'Calc', 'formula', '{}', 9])
    const CVIEW = `view_b1_computed_${TS}`
    await q(
      `INSERT INTO meta_views (id, sheet_id, name, type, filter_info) VALUES ($1,$2,$3,'grid',$4::jsonb)`,
      [CVIEW, SHEET_ID, 'Computed view', JSON.stringify({ conjunction: 'and', conditions: [{ fieldId: FLD_FORMULA, operator: 'is', value: 'x' }] })],
    )
    // Rows the formula filter would exclude in the grid — they must NOT be generated.
    await seedRecord(`rec_b1_cf1_${TS}`, { [FLD_SRC]: 'a' }, ACTOR)
    await seedRecord(`rec_b1_cf2_${TS}`, { [FLD_SRC]: 'b' }, ACTOR)

    try {
      const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'view', viewId: CVIEW })
      expect(res.status).toBe(422) // refused — never match-all, never out-of-view generation
      expect(res.body.error.code).toBe('AI_BULK_VIEW_FILTER_UNSUPPORTED')
      expect(fetchCallCount).toBe(0)
    } finally {
      // meta_fields isn't reset between tests — drop the formula field so it can't perturb others.
      await q('DELETE FROM meta_fields WHERE id = $1', [FLD_FORMULA]).catch(() => {})
    }
  })

  // ── Test 4: run-cache rows persisted with the full shape ──────────────────
  test('run-cache: one persisted row per generated output with the full shape', async () => {
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
      [SHEET_ID, ACTOR, 'multitable:write-own'],
    )
    stubUsage = { input_tokens: 7, output_tokens: 3 }
    const K1 = `rec_b1_k1_${TS}`
    const K2 = `rec_b1_k2_${TS}`
    await seedRecord(K1, { [FLD_SRC]: 'kache one' }, ACTOR)
    await seedRecord(K2, { [FLD_SRC]: 'kache two' }, ACTOR)

    const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(res.status).toBe(200)
    const runId = res.body.runId as string
    expect(runId).toMatch(/^aibulk_/)

    const cached = await cacheRows(runId)
    expect(cached.length).toBe(2)
    for (const row of cached) {
      expect(row.run_id).toBe(runId)
      expect(row.actor_id).toBe(ACTOR)
      expect(row.sheet_id).toBe(SHEET_ID)
      expect(row.field_id).toBe(FLD_TARGET)
      expect([K1, K2]).toContain(row.record_id)
      expect(Number(row.preview_version)).toBe(1)
      expect(row.proposed_value).toBe('AI OUT')
      expect(Number(row.usage_tokens)).toBe(7 + 3)
      expect(Number(row.cost_usd)).toBeGreaterThan(0)
      expect(row.expires_at).toBeTruthy()
    }
    // The response rows carry the version that rides into B-2 as expectedVersion.
    for (const r of res.body.rows as Array<{ version: number }>) expect(r.version).toBe(1)
  })

  // ── D2-A: server-resolved FULL filtered set (view scope) ──────────────────
  test('D2-A view scope: only filter-matching rows generate (full filtered set, not a page)', async () => {
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
      [SHEET_ID, ACTOR, 'multitable:write-own'],
    )
    // View filters FLD_FLAG == 'keep'.
    await q(
      `INSERT INTO meta_views (id, sheet_id, name, type, filter_info) VALUES ($1,$2,$3,'grid',$4::jsonb)`,
      [VIEW_ID, SHEET_ID, 'Keep view', JSON.stringify({ conjunction: 'and', conditions: [{ fieldId: FLD_FLAG, operator: 'is', value: 'keep' }] })],
    )
    const M1 = `rec_b1_m1_${TS}`
    const M2 = `rec_b1_m2_${TS}`
    const DROP = `rec_b1_drop_${TS}`
    await seedRecord(M1, { [FLD_SRC]: 'm1', [FLD_FLAG]: 'keep' }, ACTOR)
    await seedRecord(M2, { [FLD_SRC]: 'm2', [FLD_FLAG]: 'keep' }, ACTOR)
    await seedRecord(DROP, { [FLD_SRC]: 'drop', [FLD_FLAG]: 'skip' }, ACTOR)

    const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'view', viewId: VIEW_ID })
    expect(res.status).toBe(200)
    const rowIds = (res.body.rows as Array<{ recordId: string }>).map((r) => r.recordId).sort()
    expect(rowIds).toEqual([M1, M2].sort())
    expect(rowIds).not.toContain(DROP)
    expect(fetchCallCount).toBe(2) // only the filtered set generated
  })

  // ── Contract guards: inline config rejected; response shape pinned ────────
  test('inline config is rejected (run parity)', async () => {
    const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'sheet', config: { kind: 'summarize', sourceFieldIds: [FLD_SRC] } })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('AI_INLINE_CONFIG_REJECTED')
    expect(fetchCallCount).toBe(0)
  })

  test('response top-level shape is pinned (fixture-drift discipline)', async () => {
    await seedRecord(`rec_b1_shape_${TS}`, { [FLD_SRC]: 'x' }, ACTOR)
    const res = await bulkReq({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['capped', 'failures', 'rows', 'runId', 'settledCost', 'skipped'])
  })
})
