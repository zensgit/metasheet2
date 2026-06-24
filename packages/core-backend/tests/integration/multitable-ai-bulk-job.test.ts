/**
 * B-4 Slice 1 — AI bulk-fill ASYNC JOB — REAL-DB suite.
 *
 * Design lock:
 * docs/development/multitable-ai-bulk-fill-b4-async-job-designlock-20260622.md
 * (BJ-1…BJ-10).
 *
 * Locks the Slice-1 acceptance subjects:
 *  - Job lifecycle: queued → running → suspended(manual_task) → running(commit) → resolved.
 *  - Charge-on-generation at scale: the ledger token-sum delta == provider usage-sum (== fetch calls).
 *  - QUOTA-PAUSE (BJ-2): generation stops at the quota wall → suspended + quota_paused;
 *    generated rows are charged + committable; the remainder rows are
 *    `pending_not_generated` (UNCHARGED, no proposal, NOT committable).
 *  - CANCEL (BJ-4): generated rows stay charged + committable; ungenerated →
 *    pending_not_generated; job → rejected. No release.
 *  - job-rows DURABILITY (BJ-9, THE keystone): per-row state / skipped / failure /
 *    current_value survive a simulated worker stop / cancel / quota-pause — re-read
 *    straight from the DB, truthful and ordered by ordinal.
 *  - Paginated …/rows returns truthful per-row state ordered by ordinal.
 *  - BJ-7: a different-scope start → 409 ACTIVE_JOB_EXISTS; a SAME-scope start →
 *    the SAME jobId (idempotent, no double generating run); per-actor one-job concurrency.
 *  - Async cap → 400 BULK_SCOPE_TOO_LARGE.
 *  - Commit chunk invariants (owner gate / stale-drop / re-gate) + the durable aggregate.
 *  - ZERO real provider calls (fetchFn is the injected construction seam).
 *
 * The worker (`runJob`) is driven DIRECTLY (no queue registered) for determinism;
 * the same code runs out-of-band via QueueService in production. Provider HTTP is
 * NEVER real — fetchFn is injected at construction and returns a canned
 * anthropic-shaped response; the outbound body is captured for the mask assertion.
 *
 * Wired into .github/workflows/plugin-tests.yml multitable real-DB explicit list.
 */
import express, { type Express, type Request } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { createMultitableAiRoutes } from '../../src/routes/multitable-ai'
import { AI_USAGE_LEDGER_TABLE, type AiUsageQueryFn } from '../../src/services/ai-usage-ledger'
import {
  BulkFillJobService,
  AI_BULK_JOB_TABLE,
  AI_BULK_JOB_ROWS_TABLE,
  cancelBulkJob,
  setHeaderRunning,
  insertBulkJobHeader,
  reconcileOrphanedBulkJobs,
} from '../../src/services/ai-bulk-job-service'
import { QueueServiceImpl } from '../../src/services/QueueService'
import type { PoolLike } from '../../src/services/ai-bulk-shared'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_b4_${TS}`
const SHEET_ID = `sheet_b4_${TS}`
const VIEW_ID = `view_b4_${TS}`
const FLD_SRC = `fld_b4_src_${TS}`
const FLD_TARGET = `fld_b4_target_${TS}`
const FLD_FLAG = `fld_b4_flag_${TS}`

const ACTOR = `u_b4_actor_${TS}`
const OTHER = `u_b4_other_${TS}`

const API_KEY_SENTINEL = `sk-${'b4leak00000'.repeat(3)}`

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
  'MULTITABLE_AI_BULK_JOB_MAX_ROWS',
] as const

let app: Express
let jobService: BulkFillJobService
let currentUser: { id: string; roles: string[]; perms: string[] } = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
let stubUsage = { input_tokens: 20, output_tokens: 10 }
let stubText = 'AI OUT'
let fetchCallCount = 0
/**
 * Test seam: invoked inside fetchStub on every provider call (arg = the call number),
 * letting a test inject an out-of-band event (e.g. a cancel) at a PRECISE row so the
 * worker's per-row cooperation can be exercised deterministically. Reset between tests.
 */
let onFetchCall: ((callNumber: number) => void | Promise<void>) | null = null
const capturedBodies: string[] = []
const savedEnv = new Map<string, string | undefined>()

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const fetchStub = (async (_url: unknown, init?: unknown) => {
  fetchCallCount += 1
  const body = (init as { body?: unknown } | undefined)?.body
  if (typeof body === 'string') capturedBodies.push(body)
  if (onFetchCall) await onFetchCall(fetchCallCount)
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text: stubText }], usage: { ...stubUsage } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}) as typeof fetch

const bulkPreview = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-preview`).send(body)
const pollJob = (jobId: string) =>
  request(app).get(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-job/${jobId}`)
const jobRows = (jobId: string, cursor?: number) =>
  request(app).get(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-job/${jobId}/rows${cursor !== undefined ? `?cursor=${cursor}` : ''}`)
const cancelJob = (jobId: string) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-job/${jobId}/cancel`).send({})
const commitJob = (jobId: string, recordIds: string[]) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-job/${jobId}/commit`).send({ recordIds })

const ledgerTokenSum = async () => {
  const res = await q(
    `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`,
    [SHEET_ID],
  )
  return Number((res.rows[0] as { total: string }).total)
}
const dbJobRows = async (jobId: string) => {
  const res = await q(
    `SELECT record_id, ordinal, state, current_value, preview_version, proposed_value, masked, reason, usage_tokens, cost_usd
       FROM ${AI_BULK_JOB_ROWS_TABLE} WHERE job_id = $1 ORDER BY ordinal ASC`,
    [jobId],
  )
  return res.rows as Array<Record<string, unknown>>
}
const dbJobHeader = async (jobId: string) => {
  const res = await q(`SELECT * FROM ${AI_BULK_JOB_TABLE} WHERE job_id = $1`, [jobId])
  return res.rows[0] as Record<string, unknown> | undefined
}
const recordValue = async (recordId: string, fieldId: string) => {
  const res = await q('SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, SHEET_ID])
  const data = (res.rows[0] as { data?: Record<string, unknown> } | undefined)?.data ?? {}
  return data[fieldId] ?? null
}

async function seedRecord(recordId: string, data: Record<string, unknown>, createdBy: string) {
  await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [
    recordId,
    SHEET_ID,
    JSON.stringify(data),
    createdBy,
  ])
}

/** Drive the queued job's generate phase to its suspend (deterministic; no queue registered). */
async function runJob(jobId: string) {
  await jobService.runJob(jobId)
}

async function resetSideEffects() {
  await q(`DELETE FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
  await q(`DELETE FROM ${AI_BULK_JOB_ROWS_TABLE} WHERE job_id IN (SELECT job_id FROM ${AI_BULK_JOB_TABLE} WHERE sheet_id = $1)`, [SHEET_ID]).catch(() => {})
  await q(`DELETE FROM ${AI_BULK_JOB_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
  fetchCallCount = 0
  capturedBodies.length = 0
  onFetchCall = null
}

/** Grant the actor own-write scope (writes records they created). */
async function grantOwnWrite() {
  await q(
    `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
    [SHEET_ID, ACTOR, 'multitable:write-own'],
  )
}

describeIfDatabase('B-4 AI bulk-fill async job (real DB)', () => {
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
    // Force the inline cap LOW so every multi-row request routes to a JOB.
    process.env.MULTITABLE_AI_BULK_MAX_ROWS = '1'

    // The job service shares the route's pool + fetchFn; NO queue (we drive runJob).
    jobService = new BulkFillJobService({ pool: poolManager.get() as unknown as PoolLike, fetchFn: fetchStub })

    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = currentUser
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    app.use('/api/multitable', createMultitableAiRoutes({ fetchFn: fetchStub, bulkJobService: jobService }))

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'B4 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'B4 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SRC, SHEET_ID, 'Notes', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      FLD_TARGET,
      SHEET_ID,
      'Summary',
      'string',
      JSON.stringify({ aiShortcut: { kind: 'summarize', sourceFieldIds: [FLD_SRC] } }),
      2,
    ])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_FLAG, SHEET_ID, 'Flag', 'string', '{}', 3])
  })

  afterAll(async () => {
    await resetSideEffects()
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
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
    stubText = 'AI OUT'
    process.env.MULTITABLE_AI_BULK_MAX_ROWS = '1'
    delete process.env.MULTITABLE_AI_BULK_JOB_MAX_ROWS
    delete process.env.MULTITABLE_AI_MAX_OUTPUT_TOKENS
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = savedEnv.get('MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP') ?? ''
    process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP = savedEnv.get('MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP') ?? ''
    if (!process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP) delete process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP
    if (!process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP) delete process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await resetSideEffects()
    await grantOwnWrite()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── Lifecycle + charge-on-generation at scale + commit ─────────────────────
  test('lifecycle queued→running→suspended→running(commit)→resolved + charge == provider calls', async () => {
    stubUsage = { input_tokens: 30, output_tokens: 12 } // 42 tokens/charged row
    const R1 = `rec_b4_l1_${TS}`
    const R2 = `rec_b4_l2_${TS}`
    const R3 = `rec_b4_l3_${TS}`
    await seedRecord(R1, { [FLD_SRC]: 'one' }, ACTOR)
    await seedRecord(R2, { [FLD_SRC]: 'two' }, ACTOR)
    await seedRecord(R3, { [FLD_SRC]: 'three' }, ACTOR)

    // Start → a job (3 rows > inline cap 1). NO inline generation yet.
    const start = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(start.status).toBe(200)
    const jobId = start.body.jobId as string
    expect(jobId).toMatch(/^aibulkjob_/)
    expect(fetchCallCount).toBe(0)

    // queued, total = 3 provider-bound rows.
    const queued = await pollJob(jobId)
    expect(queued.body.state).toBe('queued')
    expect(queued.body.total).toBe(3)
    expect(queued.body.generated).toBe(0)

    // Run the generate phase → suspended(manual_task), 3 generated, charge booked.
    await runJob(jobId)
    const suspended = await pollJob(jobId)
    expect(suspended.body.state).toBe('suspended')
    expect(suspended.body.suspendReason).toBe('manual_task')
    expect(suspended.body.generated).toBe(3)
    expect(suspended.body.quotaPaused).toBe(false)
    expect(suspended.body.settledCost).toBeGreaterThan(0)

    // Charge-on-generation at scale: ledger token-sum == provider usage (== 3 calls × 42).
    expect(fetchCallCount).toBe(3)
    expect(await ledgerTokenSum()).toBe(3 * (30 + 12))

    // Commit a confirmed subset (R1 + R2) → backend chunks + writes; R3 left generated.
    const commit = await commitJob(jobId, [R1, R2])
    expect(commit.status).toBe(200)
    expect(commit.body.state).toBe('resolved')
    expect(commit.body.counts.committed).toBe(2)
    expect(commit.body.attempted).toBe(2)

    // The committed rows hold the AI output; R3 (not confirmed) is untouched.
    expect(await recordValue(R1, FLD_TARGET)).toBe('AI OUT')
    expect(await recordValue(R2, FLD_TARGET)).toBe('AI OUT')
    expect(await recordValue(R3, FLD_TARGET)).toBeNull()

    // Terminal: resolved + durable aggregate on the header.
    const resolved = await pollJob(jobId)
    expect(resolved.body.state).toBe('resolved')
    expect(resolved.body.aggregate.counts.committed).toBe(2)
    expect(resolved.body.committedCount).toBe(2)

    // NO commit ledger writes — the token-sum is unchanged by the commit (charge settled at generation).
    expect(await ledgerTokenSum()).toBe(3 * (30 + 12))
  })

  // ── QUOTA-PAUSE (BJ-2) ─────────────────────────────────────────────────────
  test('quota-pause: stops at the wall → suspended + quota_paused; generated charged+committable; remainder pending_not_generated uncharged', async () => {
    // The worker SETTLES each row to actuals BEFORE the next reserve, so the cap must
    // bind against settled actuals + the next row's estimate. With a small
    // maxOutputTokens (10) the per-row RESERVE estimate ≈ prompt_chars + 10; SETTLED
    // actuals = 510/row. Cap 600 admits rows 0,1 (sum 0/510 + est ≤ 600) and refuses
    // row 2 (settled 1020 + est > 600) → generation pauses at 2 of 5.
    process.env.MULTITABLE_AI_MAX_OUTPUT_TOKENS = '10'
    stubUsage = { input_tokens: 500, output_tokens: 10 } // 510 tokens settled/charged row
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = '600'

    const ids = [0, 1, 2, 3, 4].map((i) => `rec_b4_q${i}_${TS}`)
    for (const id of ids) await seedRecord(id, { [FLD_SRC]: `row ${id}` }, ACTOR)

    const start = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(start.status).toBe(200)
    const jobId = start.body.jobId as string

    await runJob(jobId)
    const header = await pollJob(jobId)
    expect(header.body.state).toBe('suspended')
    expect(header.body.quotaPaused).toBe(true)

    const rows = await dbJobRows(jobId)
    const generated = rows.filter((r) => r.state === 'generated')
    const notGenerated = rows.filter((r) => r.state === 'pending_not_generated')
    // Some (but not all) rows generated; the rest are pending_not_generated.
    expect(generated.length).toBeGreaterThan(0)
    expect(generated.length).toBeLessThan(5)
    expect(generated.length + notGenerated.length).toBe(5)
    expect(header.body.generated).toBe(generated.length)

    // Generated rows are CHARGED + committable (have a proposal); remainder UNCHARGED + no proposal.
    for (const r of generated) {
      expect(r.proposed_value).toBe('AI OUT')
      expect(Number(r.usage_tokens)).toBe(510)
    }
    for (const r of notGenerated) {
      expect(r.proposed_value).toBeNull()
      expect(Number(r.usage_tokens)).toBe(0)
    }

    // Charge invariant: ledger token-sum == ONLY the generated rows (the remainder is uncharged).
    expect(await ledgerTokenSum()).toBe(generated.length * 510)

    // The generated rows ARE committable even after a quota pause.
    const generatedIds = generated.map((r) => String(r.record_id))
    const commit = await commitJob(jobId, generatedIds)
    expect(commit.status).toBe(200)
    expect(commit.body.counts.committed).toBe(generated.length)
  })

  // ── CANCEL (BJ-4) ──────────────────────────────────────────────────────────
  test('cancel: generated rows stay charged+committable; ungenerated → pending_not_generated; job → rejected', async () => {
    stubUsage = { input_tokens: 22, output_tokens: 8 } // 30 tokens/charged row
    const ids = [0, 1, 2].map((i) => `rec_b4_c${i}_${TS}`)
    for (const id of ids) await seedRecord(id, { [FLD_SRC]: `c ${id}` }, ACTOR)

    const start = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    const jobId = start.body.jobId as string

    // Cancel BEFORE the worker runs → all rows ungenerated → pending_not_generated; rejected.
    const cancel = await cancelJob(jobId)
    expect(cancel.status).toBe(200)
    expect(cancel.body.cancelled).toBe(true)
    expect(cancel.body.state).toBe('rejected')

    const header = await dbJobHeader(jobId)
    expect(header!.status).toBe('rejected')
    const rows = await dbJobRows(jobId)
    expect(rows.every((r) => r.state === 'pending_not_generated')).toBe(true)
    // Nothing generated → nothing charged.
    expect(await ledgerTokenSum()).toBe(0)

    // The claim guard: a cancelled (non-queued) job is NOT run by a late worker tick.
    await runJob(jobId)
    expect(fetchCallCount).toBe(0)
    const after = await dbJobHeader(jobId)
    expect(after!.status).toBe('rejected') // unchanged

    // A second scenario: cancel AFTER a partial generation keeps generated rows committable.
    await resetSideEffects()
    const ids2 = [0, 1, 2].map((i) => `rec_b4_c2_${i}_${TS}`)
    for (const id of ids2) await seedRecord(id, { [FLD_SRC]: `c2 ${id}` }, ACTOR)
    // Cap 600 + maxOutput 10 + 510 actuals → partial generation (2 of 3), then quota-pause suspends.
    process.env.MULTITABLE_AI_MAX_OUTPUT_TOKENS = '10'
    stubUsage = { input_tokens: 500, output_tokens: 10 }
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = '600'
    const start2 = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    const jobId2 = start2.body.jobId as string
    await runJob(jobId2)
    const rows2 = await dbJobRows(jobId2)
    const gen2 = rows2.filter((r) => r.state === 'generated')
    expect(gen2.length).toBeGreaterThan(0)
    // Cancel a suspended job → still committable generated rows; remainder already pending_not_generated.
    const cancel2 = await cancelJob(jobId2)
    expect(cancel2.body.cancelled).toBe(true)
    const commit2 = await commitJob(jobId2, gen2.map((r) => String(r.record_id)))
    expect(commit2.status).toBe(200)
    expect(commit2.body.counts.committed).toBe(gen2.length)
  })

  // ── CANCEL MID-RUN (BJ-4: the worker stops at the next row; charge stays truthful) ──
  test('cancel MID-RUN: the worker stops at the next row boundary; a row charged as the cancel lands reads `generated` (never pending_not_generated); header stays rejected', async () => {
    // stubUsage default = 20+10 = 30 tokens / charged row.
    const ids = [0, 1, 2, 3].map((i) => `rec_b4_mrc${i}_${TS}`)
    for (const id of ids) await seedRecord(id, { [FLD_SRC]: `mrc ${id}` }, ACTOR)

    const start = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    const jobId = start.body.jobId as string

    // A cancel arrives DURING the 2nd row's generation — the worst-case race: the worker
    // has reserved+charged row 2 but not yet recorded it `generated`, and the cancel flips
    // every still-`pending` row (including row 2 at that instant) to pending_not_generated.
    onFetchCall = async (n) => {
      if (n === 2) await cancelBulkJob(q as unknown as AiUsageQueryFn, jobId)
    }
    await runJob(jobId)

    const rows = await dbJobRows(jobId)
    const generated = rows.filter((r) => r.state === 'generated')
    const notGenerated = rows.filter((r) => r.state === 'pending_not_generated')

    // Rows 1+2 were charged before the worker observed the cancel → BOTH read `generated`.
    // markRowGenerated is UNCONDITIONAL, so row 2 (which the cancel momentarily flipped to
    // pending_not_generated) is re-recorded as generated — never charged-but-shown-uncharged.
    expect(generated.length).toBe(2)
    expect(notGenerated.length).toBe(2)
    // KEYSTONE invariant: no row is charged (usage_tokens > 0) yet shown pending_not_generated.
    expect(rows.every((r) => r.state !== 'pending_not_generated' || Number(r.usage_tokens) === 0)).toBe(true)
    for (const r of generated) expect(Number(r.usage_tokens)).toBe(30)
    // Ledger token-sum == generated count × 30 — row 2's charge is counted as generated, not lost.
    // (Were row 2 wrongly left pending_not_generated, the ledger would hold 60 while generated == 1.)
    expect(await ledgerTokenSum()).toBe(generated.length * 30)

    // The worker STOPPED at row 3 (the next boundary): exactly 2 provider calls, and it did
    // NOT overwrite the cancel — the header stays `rejected` (BJ-4), not `suspended`.
    expect(fetchCallCount).toBe(2)
    const header = await dbJobHeader(jobId)
    expect(header!.status).toBe('rejected')
    expect(Number(header!.generated)).toBe(2)
  })

  // ── COMMIT STATE GUARD (BJ-4 / BJ-5) ────────────────────────────────────────
  test('commit STATE GUARD: a queued/running (worker-active) job → 409 BULK_JOB_NOT_COMMITTABLE (no write, header unchanged, still runnable); a resolved job → 409 (no double-commit)', async () => {
    const ids = [0, 1].map((i) => `rec_b4_csg${i}_${TS}`)
    for (const id of ids) await seedRecord(id, { [FLD_SRC]: `csg ${id}` }, ACTOR)

    const start = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    const jobId = start.body.jobId as string

    // QUEUED — the worker has not generated yet → commit refused; header NOT flipped to running.
    expect((await dbJobHeader(jobId))!.status).toBe('queued')
    const onQueued = await commitJob(jobId, ids)
    expect(onQueued.status).toBe(409)
    expect(onQueued.body.error.code).toBe('BULK_JOB_NOT_COMMITTABLE')
    expect((await dbJobHeader(jobId))!.status).toBe('queued') // unchanged — not corrupted to running

    // RUNNING — the worker is mid-generate → commit refused (committing now would race it).
    await q(`UPDATE ${AI_BULK_JOB_TABLE} SET status = 'running' WHERE job_id = $1`, [jobId])
    const onRunning = await commitJob(jobId, ids)
    expect(onRunning.status).toBe(409)
    expect(onRunning.body.error.code).toBe('BULK_JOB_NOT_COMMITTABLE')

    // Neither refused commit wrote anything.
    for (const id of ids) expect(await recordValue(id, FLD_TARGET)).toBeNull()

    // Not corrupted: restore queued → the worker runs → suspends → commit now succeeds.
    await q(`UPDATE ${AI_BULK_JOB_TABLE} SET status = 'queued' WHERE job_id = $1`, [jobId])
    await runJob(jobId)
    expect((await dbJobHeader(jobId))!.status).toBe('suspended')
    const ok = await commitJob(jobId, ids)
    expect(ok.status).toBe(200)
    expect(ok.body.state).toBe('resolved')
    for (const id of ids) expect(await recordValue(id, FLD_TARGET)).toBe('AI OUT')

    // RESOLVED — a second commit is refused (no double-commit).
    const again = await commitJob(jobId, ids)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('BULK_JOB_NOT_COMMITTABLE')
  })

  // ── COMMITTABLE-SET MATRIX (the guarded commit-phase claim) ──────────────────
  test('setHeaderRunning committable-set: {suspended,errored,rejected} claim (true → running); {queued,running,resolved} refuse (false, status unchanged)', async () => {
    const queryFn = q as unknown as AiUsageQueryFn
    const make = async (suffix: string, status: string) => {
      const jid = `aibulkjob_csm_${suffix}_${TS}`
      // Distinct field_id per header: the BJ-7 active-job unique index is on
      // (actor_id, sheet_id, field_id), so several ACTIVE headers (suspended/queued/
      // running) for one target would collide — the matrix needs independent rows.
      await insertBulkJobHeader(queryFn, {
        jobId: jid,
        actorId: ACTOR,
        sheetId: SHEET_ID,
        fieldId: `${FLD_TARGET}_${suffix}`,
        scopeFingerprint: `fp_${suffix}`,
        total: 0,
      })
      await q(`UPDATE ${AI_BULK_JOB_TABLE} SET status = $2 WHERE job_id = $1`, [jid, status])
      return jid
    }

    // Committable (the worker is no longer mutating) → claims, returns true, → running.
    for (const s of ['suspended', 'errored', 'rejected']) {
      const jid = await make(`ok_${s}`, s)
      expect(await setHeaderRunning(queryFn, jid)).toBe(true)
      expect((await dbJobHeader(jid))!.status).toBe('running')
    }
    // Non-committable (worker active, or already committed) → refuses, returns false, unchanged.
    for (const s of ['queued', 'running', 'resolved']) {
      const jid = await make(`no_${s}`, s)
      expect(await setHeaderRunning(queryFn, jid)).toBe(false)
      expect((await dbJobHeader(jid))!.status).toBe(s)
    }
  })

  // ── PRODUCTION WIRING (finding #1): the injected queue drives the worker out-of-band ──
  test('production wiring: an injected queue runs the generate worker via enqueue (NO bulkJobService, runJob NEVER called directly) → suspended', async () => {
    // An app wired EXACTLY like index.ts: a real QueueServiceImpl injected as `queue`,
    // and NO bulkJobService. The lazily-built service registers its generate processor
    // on this queue, so enqueue() must drain to runJob out-of-band — the exact path that
    // finding #1 reported never executes in production. (Every other golden injects a
    // queue-less bulkJobService and drives runJob by hand, so none exercise this.)
    const queue = new QueueServiceImpl()
    const app2 = express()
    app2.use(express.json())
    app2.use((req, _res, next) => {
      ;(req as Request & { user?: unknown }).user = currentUser
      next()
    })
    app2.use('/api/multitable', univerMetaRouter())
    app2.use('/api/multitable', createMultitableAiRoutes({ fetchFn: fetchStub, queue }))

    const ids = [0, 1, 2].map((i) => `rec_b4_wire${i}_${TS}`)
    for (const id of ids) await seedRecord(id, { [FLD_SRC]: `wire ${id}` }, ACTOR)

    const start = await request(app2)
      .post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-preview`)
      .send({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(start.status).toBe(200)
    const jobId = start.body.jobId as string
    expect(jobId).toMatch(/^aibulkjob_/)

    // Do NOT call runJob — the queue alone must drive the generate phase. Poll the header
    // until the out-of-band worker suspends it for review (proves enqueue→processor→runJob).
    let state = ''
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      state = String((await dbJobHeader(jobId))?.status ?? '')
      if (state === 'suspended' || state === 'errored' || state === 'rejected') break
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(state).toBe('suspended')
    const header = await dbJobHeader(jobId)
    expect(Number(header!.generated)).toBe(3)
    expect(fetchCallCount).toBe(3)
  })

  // ── CRASH → ERRORED (BJ-5: an unexpected worker exception does not strand the partial) ──
  test('BJ-5 crash → errored: an unexpected worker exception after row 1 marks the header errored (NOT stuck running); row 1 stays generated+charged and COMMITS; the rest stay ungenerated', async () => {
    const ids = [0, 1, 2].map((i) => `rec_b4_crash${i}_${TS}`)
    for (const id of ids) await seedRecord(id, { [FLD_SRC]: `crash ${id}` }, ACTOR)

    // A pool that throws on the 2nd per-row status read (readJobStatus) — i.e. at the TOP of
    // row 2, AFTER row 1 is generated+charged but BEFORE row 2 is charged. Simulates an
    // unexpected DB exception mid-generate; everything else delegates to the real pool.
    const realPool = poolManager.get()
    let statusReads = 0
    const flakyPool = new Proxy(realPool as object, {
      get(target, prop) {
        if (prop === 'query') {
          return (sql: string, params?: unknown[]) => {
            if (typeof sql === 'string' && sql.includes(`SELECT status FROM ${AI_BULK_JOB_TABLE}`)) {
              statusReads += 1
              if (statusReads === 2) throw new Error('injected: worker crashed mid-generate')
            }
            return (target as { query: (s: string, p?: unknown[]) => unknown }).query(sql, params)
          }
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const crashService = new BulkFillJobService({ pool: flakyPool as unknown as PoolLike, fetchFn: fetchStub })

    const app2 = express()
    app2.use(express.json())
    app2.use((req, _res, next) => {
      ;(req as Request & { user?: unknown }).user = currentUser
      next()
    })
    app2.use('/api/multitable', univerMetaRouter())
    app2.use('/api/multitable', createMultitableAiRoutes({ fetchFn: fetchStub, bulkJobService: crashService }))

    const start = await request(app2)
      .post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-preview`)
      .send({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(start.status).toBe(200)
    const jobId = start.body.jobId as string

    // Drive the worker on the flaky pool — row 2's status read throws. runJob must NOT
    // propagate; its outer catch marks the header errored (guarded on running).
    await crashService.runJob(jobId)

    // Header is `errored`, NOT stuck `running` — the design's crash outcome (BJ-5).
    expect((await dbJobHeader(jobId))!.status).toBe('errored')

    // Row 1 stayed generated + charged; rows 2 & 3 are visibly ungenerated (still pending, uncharged).
    const rows = await dbJobRows(jobId)
    const generated = rows.filter((r) => r.state === 'generated')
    const pending = rows.filter((r) => r.state === 'pending')
    expect(generated.length).toBe(1)
    expect(Number(generated[0].usage_tokens)).toBe(30)
    expect(pending.length).toBe(2)
    expect(await ledgerTokenSum()).toBe(30) // only row 1 charged — the crash was before row 2's charge

    // The crashed job's generated partial is COMMITTABLE (errored ∈ committable set): committing
    // row 1 succeeds and writes the value, so the charged work is NOT stranded.
    const commit = await commitJob(jobId, [String(generated[0].record_id)])
    expect(commit.status).toBe(200)
    expect(commit.body.state).toBe('resolved')
    expect(commit.body.counts.committed).toBe(1)
    expect(await recordValue(String(generated[0].record_id), FLD_TARGET)).toBe('AI OUT')
  })

  // ── HARD-RESTART RECONCILE (B-4 follow-up to BJ-5) ─────────────────────────
  test('hard-restart reconcile: a stale orphaned queued/running job → errored; recent + suspended jobs untouched', async () => {
    // markErroredIfRunning covers only the IN-PROCESS crash path. A HARD restart
    // drops the in-process worker + queue, so a job left queued/running has no live
    // worker and can never progress — it must be reconciled at boot. Seed four
    // headers on DISTINCT fields (the BJ-7 active-job unique index is
    // (actor, sheet, field), so several active headers for one target collide):
    // a stale-running orphan, a stale-queued orphan, a just-updated running job (a
    // live worker on another instance), and a suspended job (intentionally paused).
    const queryFn = q as unknown as AiUsageQueryFn
    const mk = async (suffix: string, status: string, ageMinutes: number) => {
      const jid = `aibulkjob_recon_${suffix}_${TS}`
      await insertBulkJobHeader(queryFn, {
        jobId: jid,
        actorId: ACTOR,
        sheetId: SHEET_ID,
        fieldId: `${FLD_TARGET}_recon_${suffix}`,
        scopeFingerprint: `fp_recon_${suffix}`,
        total: 3,
      })
      await q(
        `UPDATE ${AI_BULK_JOB_TABLE} SET status = $2, updated_at = NOW() - ($3::int * INTERVAL '1 minute') WHERE job_id = $1`,
        [jid, status, ageMinutes],
      )
      return jid
    }
    const staleRunning = await mk('stale_running', 'running', 5)
    const staleQueued = await mk('stale_queued', 'queued', 5)
    const recentRunning = await mk('recent_running', 'running', 0)
    const suspendedOld = await mk('suspended_old', 'suspended', 5)

    // Quiet window 60s: the 5-min-stale active jobs are orphaned; the just-updated
    // one is a live worker; the suspended one is excluded by STATUS regardless of age.
    const reconciled = await reconcileOrphanedBulkJobs(queryFn, { staleAfterMs: 60_000 })

    expect((await dbJobHeader(staleRunning))!.status).toBe('errored')
    expect((await dbJobHeader(staleQueued))!.status).toBe('errored')
    expect((await dbJobHeader(recentRunning))!.status).toBe('running')
    expect((await dbJobHeader(suspendedOld))!.status).toBe('suspended')
    expect(reconciled).toBeGreaterThanOrEqual(2)
  })

  // ── DURABILITY KEYSTONE (BJ-9) ─────────────────────────────────────────────
  test('DURABILITY keystone: per-row state / skipped / current_value survive (re-read straight from DB), ordered by ordinal', async () => {
    // Quota pause partway (same math as the quota-pause test): maxOutput 10 → per-row
    // estimate ≈ prompt + 10; settled actuals 510/row; cap 600 admits 2, refuses the 3rd.
    process.env.MULTITABLE_AI_MAX_OUTPUT_TOKENS = '10'
    stubUsage = { input_tokens: 500, output_tokens: 10 } // 510 tokens settled/charged row
    // A writable generatable row WITH an existing target value (truthful currentValue),
    // a not-writable row (skipped_no_perm → state skipped), and rows that quota-pause.
    const W1 = `rec_b4_d_w1_${TS}`
    const W2 = `rec_b4_d_w2_${TS}`
    const W3 = `rec_b4_d_w3_${TS}`
    const NOWRITE = `rec_b4_d_nowrite_${TS}`
    await seedRecord(W1, { [FLD_SRC]: 'w1', [FLD_TARGET]: 'EXISTING-1' }, ACTOR)
    await seedRecord(W2, { [FLD_SRC]: 'w2' }, ACTOR) // empty target → currentValue null
    await seedRecord(W3, { [FLD_SRC]: 'w3' }, ACTOR)
    await seedRecord(NOWRITE, { [FLD_SRC]: 'theirs' }, OTHER) // not writable → skipped

    // Cap 600 admits 2 reservations → W1/W2 generate, W3 pauses (pending_not_generated).
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = '600'
    const start = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    const jobId = start.body.jobId as string
    // total = 3 provider-bound (W1/W2/W3); NOWRITE seeded as skipped, NOT counted.
    expect((await pollJob(jobId)).body.total).toBe(3)

    await runJob(jobId)

    // Re-read the rows STRAIGHT FROM THE DB (durability — not an in-memory view).
    const rows = await dbJobRows(jobId)
    const byId = new Map(rows.map((r) => [String(r.record_id), r]))

    // Ordered by ordinal (the stable review cursor).
    const ordinals = rows.map((r) => Number(r.ordinal))
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b))

    // W1: generated, with the TRUTHFUL current_value persisted at generation (server-read).
    expect(byId.get(W1)!.state).toBe('generated')
    expect(byId.get(W1)!.current_value).toBe('EXISTING-1')
    expect(byId.get(W1)!.proposed_value).toBe('AI OUT')
    // W2: generated, current_value null (genuinely empty — distinct from a value).
    expect(byId.get(W2)!.state).toBe('generated')
    expect(byId.get(W2)!.current_value).toBeNull()
    // W3: quota-paused remainder → pending_not_generated, NO proposal, uncharged.
    expect(byId.get(W3)!.state).toBe('pending_not_generated')
    expect(byId.get(W3)!.proposed_value).toBeNull()
    expect(Number(byId.get(W3)!.usage_tokens)).toBe(0)
    // NOWRITE: skipped (not writable) — durable, with reason; never generated.
    expect(byId.get(NOWRITE)!.state).toBe('skipped')
    expect(byId.get(NOWRITE)!.reason).toBe('skipped_no_perm')
    expect(byId.get(NOWRITE)!.proposed_value).toBeNull()

    // The charge equals only the generated rows (durable usage matches the ledger).
    const generatedCount = rows.filter((r) => r.state === 'generated').length
    expect(await ledgerTokenSum()).toBe(generatedCount * 510)
  })

  // ── Paginated …/rows (BJ-9) ────────────────────────────────────────────────
  test('paginated …/rows returns truthful per-row state ordered by ordinal', async () => {
    const ids = [0, 1, 2, 3].map((i) => `rec_b4_p${i}_${TS}`)
    for (const id of ids) await seedRecord(id, { [FLD_SRC]: `p ${id}` }, ACTOR)
    const start = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    const jobId = start.body.jobId as string
    await runJob(jobId)

    // Page 1 (limit 2) ordered by ordinal.
    const page1 = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-job/${jobId}/rows?limit=2`)
    expect(page1.status).toBe(200)
    expect(page1.body.rows.length).toBe(2)
    expect(page1.body.rows[0].ordinal).toBe(0)
    expect(page1.body.rows[1].ordinal).toBe(1)
    expect(page1.body.nextCursor).toBe(1)
    // Each row carries a truthful state + diff (generated → proposed present).
    for (const r of page1.body.rows) {
      expect(r.state).toBe('generated')
      expect(r.proposed).toBe('AI OUT')
    }

    // Page 2 via the cursor.
    const page2 = await jobRows(jobId, page1.body.nextCursor)
    expect(page2.body.rows.length).toBe(2)
    expect(page2.body.rows[0].ordinal).toBe(2)
    expect(page2.body.rows[1].ordinal).toBe(3)
  })

  // ── BJ-7 concurrency: same scope idempotent, different scope 409 ───────────
  test('BJ-7: same-scope start returns the SAME jobId (idempotent); a different-scope start → 409 ACTIVE_JOB_EXISTS', async () => {
    // A filterable view-scope batch (FLD_FLAG == 'keep').
    await q(
      `INSERT INTO meta_views (id, sheet_id, name, type, filter_info) VALUES ($1,$2,$3,'grid',$4::jsonb)`,
      [VIEW_ID, SHEET_ID, 'Keep view', JSON.stringify({ conjunction: 'and', conditions: [{ fieldId: FLD_FLAG, operator: 'is', value: 'keep' }] })],
    )
    const ids = [0, 1].map((i) => `rec_b4_cc${i}_${TS}`)
    for (const id of ids) await seedRecord(id, { [FLD_SRC]: `cc ${id}`, [FLD_FLAG]: 'keep' }, ACTOR)

    const first = await bulkPreview({ fieldId: FLD_TARGET, scope: 'view', viewId: VIEW_ID })
    expect(first.status).toBe(200)
    const jobId = first.body.jobId as string

    // SAME scope (same view) → the SAME jobId (idempotent resume — no second generating run).
    const same = await bulkPreview({ fieldId: FLD_TARGET, scope: 'view', viewId: VIEW_ID })
    expect(same.status).toBe(200)
    expect(same.body.jobId).toBe(jobId)

    // DIFFERENT scope (sheet, not the view) for the SAME field → 409 with the existing job metadata.
    const different = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(different.status).toBe(409)
    expect(different.body.error.code).toBe('ACTIVE_JOB_EXISTS')
    expect(different.body.error.job.jobId).toBe(jobId)

    // Exactly ONE active job exists for (actor, sheet, field).
    const activeCount = await q(
      `SELECT COUNT(*)::int AS n FROM ${AI_BULK_JOB_TABLE} WHERE actor_id = $1 AND sheet_id = $2 AND field_id = $3 AND status IN ('queued','running','suspended')`,
      [ACTOR, SHEET_ID, FLD_TARGET],
    )
    expect(Number((activeCount.rows[0] as { n: number }).n)).toBe(1)

    await q('DELETE FROM meta_views WHERE id = $1', [VIEW_ID]).catch(() => {})
  })

  // ── Async cap → 400 ────────────────────────────────────────────────────────
  test('over async JOB cap → 400 BULK_SCOPE_TOO_LARGE, no job created', async () => {
    process.env.MULTITABLE_AI_BULK_JOB_MAX_ROWS = '2'
    for (let i = 0; i < 3; i += 1) await seedRecord(`rec_b4_cap${i}_${TS}`, { [FLD_SRC]: `r${i}` }, ACTOR)

    const res = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BULK_SCOPE_TOO_LARGE')
    expect(res.body.error.total).toBe(3)
    expect(res.body.error.cap).toBe(2)
    expect(fetchCallCount).toBe(0)
    // No job header was created.
    const count = await q(`SELECT COUNT(*)::int AS n FROM ${AI_BULK_JOB_TABLE} WHERE sheet_id = $1`, [SHEET_ID])
    expect(Number((count.rows[0] as { n: number }).n)).toBe(0)
  })

  // ── Commit chunk invariants (re-gate / stale-drop / owner gate) ────────────
  test('commit re-gate: a row that goes stale (version bumped after generation) → NOT committed (stale_reprev), value preserved', async () => {
    const R = `rec_b4_stale_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'will go stale', [FLD_TARGET]: 'ORIGINAL' }, ACTOR)
    const OTHER_ROW = `rec_b4_clean_${TS}`
    await seedRecord(OTHER_ROW, { [FLD_SRC]: 'clean' }, ACTOR)

    const start = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    const jobId = start.body.jobId as string
    await runJob(jobId)

    // Bump R's version AFTER generation (a concurrent edit) → its cached previewVersion is stale.
    await q('UPDATE meta_records SET version = version + 1, data = $2::jsonb WHERE id = $1', [R, JSON.stringify({ [FLD_SRC]: 'edited', [FLD_TARGET]: 'EDITED-CONCURRENTLY' })])

    const commit = await commitJob(jobId, [R, OTHER_ROW])
    expect(commit.status).toBe(200)
    expect(commit.body.counts.stale_reprev).toBe(1)
    expect(commit.body.counts.committed).toBe(1)
    // The stale row was NOT overwritten with the AI value (its concurrent edit is preserved).
    expect(await recordValue(R, FLD_TARGET)).toBe('EDITED-CONCURRENTLY')
    // The clean row was committed.
    expect(await recordValue(OTHER_ROW, FLD_TARGET)).toBe('AI OUT')
  })

  test('commit owner gate + cross-sheet gate: another actor cannot poll/commit the job', async () => {
    const ids = [0, 1].map((i) => `rec_b4_owner${i}_${TS}`)
    for (const id of ids) await seedRecord(id, { [FLD_SRC]: `o ${id}` }, ACTOR)
    const start = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    const jobId = start.body.jobId as string
    await runJob(jobId)

    // A DIFFERENT actor (even on the same sheet) gets 404 — never another actor's job.
    currentUser = { id: OTHER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const poll = await pollJob(jobId)
    expect(poll.status).toBe(404)
    const commit = await commitJob(jobId, ids)
    expect(commit.status).toBe(404)

    // A WRONG sheet in the URL → 404 (cross-sheet jobId guard).
    currentUser = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const wrongSheet = await request(app).get(`/api/multitable/sheets/sheet_does_not_exist_${TS}/ai/shortcut/bulk-job/${jobId}`)
    expect(wrongSheet.status).toBe(404)
  })

  test('claim guard: running the same queued job twice does not double-charge', async () => {
    const ids = [0, 1].map((i) => `rec_b4_claim${i}_${TS}`)
    for (const id of ids) await seedRecord(id, { [FLD_SRC]: `cl ${id}` }, ACTOR)
    const start = await bulkPreview({ fieldId: FLD_TARGET, scope: 'sheet' })
    const jobId = start.body.jobId as string

    // Run the job to completion (queued→running→suspended), then run AGAIN.
    await runJob(jobId)
    const callsAfterFirst = fetchCallCount
    await runJob(jobId) // the claim guard sees status != 'queued' → no-op
    expect(fetchCallCount).toBe(callsAfterFirst) // no extra provider calls
    expect(await ledgerTokenSum()).toBe(callsAfterFirst * (20 + 10))
  })
})
