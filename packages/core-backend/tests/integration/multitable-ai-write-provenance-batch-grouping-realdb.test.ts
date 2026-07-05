/**
 * AI-fields S1 — write provenance + commit-action batch grouping (REAL-DB suite).
 *
 * Design lock: docs/development/multitable-ai-write-provenance-batch-grouping-s1-designlock-20260705.md
 *
 * Locks the §5 golden matrix, G1-G7 (G8 is a frontend render test, not here):
 *  G1.  inline shortcut run → revision source='ai-shortcut', single-row batch.
 *  G2.  bulk-commit N confirmed rows in ONE request → N revisions share ONE batch_id; the READ side
 *       (both the history events list AND batch detail) shows ONE batch with N changes.
 *  G3.  a MIXED-outcome bulk-commit batch (written / not_in_cache / skipped_no_perm / stale_reprev) →
 *       only WRITTEN rows ever get a revision, and every one of THOSE shares the batch — a non-written
 *       row contributes NOTHING to the batch (no phantom membership, no all-or-nothing rollback).
 *  G4.  two separate commit ACTIONS → two DISTINCT batches (see judgment-call note below for why this
 *       is proven via two independent actions rather than "two commits on one job").
 *  G5.  READ-side grouping across BJ-10 CHUNKING: a job-commit request whose confirmed set spans
 *       MULTIPLE internal patchRecords calls (multiple chunks) still surfaces as ONE batch containing
 *       every row's change.
 *  G5b. restoring a record an AI batch touched, via the EXISTING single-record restore route, writes
 *       source='restore' — attribution never bleeds through restore (A4/R3).
 *  G6.  a plain (non-AI) PATCH caller is UNAFFECTED: no batchId supplied → each call still mints its
 *       own fresh id, byte-identical to before this seam existed.
 *  G7.  a client-supplied `batchId` in an AI commit request body has NO effect — the request schema has
 *       no such field, so it never even reaches the handler (server-minted only, LOCK-B4).
 *
 * JUDGMENT CALL (recorded in the runtime PR description too): the design-lock's G3 outcome vocabulary
 * ("not_in_cache / skipped_no_perm / stale-drop / committed") is BULK-COMMIT's vocabulary
 * (RecordCommitOutcome = written|not_in_cache|stale_reprev|skipped_no_perm|write_conflict). Job-commit's
 * OWN vocabulary (JobCommitOutcome) has NO `not_in_cache` — a job row is either a generated-and-confirmed
 * row or a `pending_not_generated` one; "not in cache" isn't a concept there. So G3 here drives
 * bulk-commit (where "not_in_cache" is real), and G5 covers the job-commit-SPECIFIC claim (BJ-10
 * chunking spanning multiple patchRecords calls) instead, which is where a job-commit-specific real
 * proof adds unique value over G2/G3.
 * G4 is proven via two INDEPENDENT commit actions, not two calls on ONE job: a job's commit is
 * architecturally single-shot — `setHeaderRunning`'s committable set is {suspended, errored, rejected};
 * every commit call (whether it confirms all or a subset of generated rows) unconditionally transitions
 * the job to 'resolved' via setHeaderAggregate, and 'resolved' is never committable again (confirmed by
 * reading ai-bulk-job-service.ts / routes/multitable-ai.ts and the existing "committable-set MATRIX"
 * test in multitable-ai-bulk-job.test.ts). So "two commit requests on the same job" cannot mean two
 * successful commits on one job id. This suite proves the underlying LOCK-B3 claim two ways: two
 * bulk-commit calls, AND two separate jobs each committed once.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI, matching this repo's real-DB suites).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { createMultitableAiRoutes } from '../../src/routes/multitable-ai'
import { AI_USAGE_LEDGER_TABLE } from '../../src/services/ai-usage-ledger'
import {
  AI_BULK_PREVIEW_CACHE_TABLE,
  insertBulkPreviewCacheRow,
  type BulkPreviewCacheRow,
} from '../../src/services/ai-bulk-preview-cache'
import { AI_BULK_JOB_TABLE, AI_BULK_JOB_ROWS_TABLE, BulkFillJobService } from '../../src/services/ai-bulk-job-service'
import type { PoolLike } from '../../src/services/ai-bulk-shared'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_s1_${TS}`
const SHEET_ID = `sheet_s1_${TS}`
const FLD_SRC = `fld_s1_src_${TS}`
const FLD_TARGET = `fld_s1_target_${TS}`

const ACTOR = `u_s1_actor_${TS}`
const OTHER = `u_s1_other_${TS}`

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
let jobService: BulkFillJobService
let currentUser: { id: string; roles: string[]; perms: string[] } = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
let stubUsage = { input_tokens: 20, output_tokens: 10 }
let stubText = 'AI OUT'
let fetchCallCount = 0

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const fetchStub = (async () => {
  fetchCallCount += 1
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text: stubText }], usage: { ...stubUsage } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}) as typeof fetch

// ── HTTP helpers ─────────────────────────────────────────────────────────────
const runReq = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/run`).send(body)
const commitReq = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-commit`).send(body)
const bulkPreviewReq = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-preview`).send(body)
const pollJobReq = (jobId: string) =>
  request(app).get(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-job/${jobId}`)
const commitJobReq = (jobId: string, recordIds: string[]) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-job/${jobId}/commit`).send({ recordIds })
const patchReq = (body: Record<string, unknown>) =>
  request(app).post('/api/multitable/patch').send(body)
const restorePreviewReq = (recordId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/records/${recordId}/restore-preview`).send(body)
const restoreExecuteReq = (recordId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/records/${recordId}/restore-execute`).send(body)
const historyEventsReq = (query: Record<string, unknown> = {}) =>
  request(app).get(`/api/multitable/bases/${BASE_ID}/history/events`).query({ limit: 100, ...query })
const historyDetailReq = (batchId: string) =>
  request(app).get(`/api/multitable/bases/${BASE_ID}/history/events/${batchId}`)

async function runJob(jobId: string) {
  await jobService.runJob(jobId)
}

// ── DB helpers ───────────────────────────────────────────────────────────────
async function seedRecord(recordId: string, data: Record<string, unknown>, createdBy: string) {
  await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [
    recordId, SHEET_ID, JSON.stringify(data), createdBy,
  ])
}
async function seedCacheRow(overrides: Partial<BulkPreviewCacheRow> & Pick<BulkPreviewCacheRow, 'runId' | 'recordId'>) {
  const row: BulkPreviewCacheRow = {
    actorId: ACTOR, sheetId: SHEET_ID, fieldId: FLD_TARGET,
    previewVersion: 1, proposedValue: 'CACHED VALUE', usageTokens: 30, costUsd: 0.001,
    ...overrides,
  }
  await insertBulkPreviewCacheRow((sql, params) => q(sql, params), row)
}
async function grantOwnWrite() {
  await q(
    `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
    [SHEET_ID, ACTOR, 'multitable:write-own'],
  )
}
type RevisionRow = { id: string; source: string; batch_id: string | null; record_id: string; version: number }
async function revisionFor(recordId: string): Promise<RevisionRow | undefined> {
  const res = await q(
    'SELECT id, source, batch_id, record_id, version FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 ORDER BY created_at DESC LIMIT 1',
    [SHEET_ID, recordId],
  )
  return res.rows[0] as RevisionRow | undefined
}
async function revisionsInBatch(batchId: string): Promise<RevisionRow[]> {
  const res = await q(
    'SELECT id, source, batch_id, record_id, version FROM meta_record_revisions WHERE sheet_id = $1 AND batch_id = $2',
    [SHEET_ID, batchId],
  )
  return res.rows as RevisionRow[]
}
async function resetSideEffects() {
  await q(`DELETE FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
  await q(`DELETE FROM ${AI_BULK_PREVIEW_CACHE_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
  await q(`DELETE FROM ${AI_BULK_JOB_ROWS_TABLE} WHERE job_id IN (SELECT job_id FROM ${AI_BULK_JOB_TABLE} WHERE sheet_id = $1)`, [SHEET_ID]).catch(() => {})
  await q(`DELETE FROM ${AI_BULK_JOB_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
  fetchCallCount = 0
}

describeIfDatabase('AI-fields S1 — write provenance + commit-action batch grouping (real DB)', () => {
  beforeAll(async () => {
    for (const key of AI_ENV_KEYS) delete process.env[key]
    process.env.MULTITABLE_AI_ENABLED = '1'
    process.env.MULTITABLE_AI_PROVIDER = 'anthropic'
    process.env.MULTITABLE_AI_API_KEY = 'sk-s1-test-key'
    process.env.MULTITABLE_AI_MODEL = 'claude-sonnet-4-6'
    process.env.MULTITABLE_AI_CONFIRM_LIVE_REQUESTS = '1'

    jobService = new BulkFillJobService({ pool: poolManager.get() as unknown as PoolLike, fetchFn: fetchStub })

    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = currentUser
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    app.use('/api/multitable', createMultitableAiRoutes({ fetchFn: fetchStub, bulkJobService: jobService }))

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'S1 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'S1 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SRC, SHEET_ID, 'Notes', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      FLD_TARGET, SHEET_ID, 'Summary', 'string',
      JSON.stringify({ aiShortcut: { kind: 'summarize', sourceFieldIds: [FLD_SRC] } }), 2,
    ])
  })

  afterAll(async () => {
    await resetSideEffects()
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    for (const key of AI_ENV_KEYS) delete process.env[key]
  })

  beforeEach(async () => {
    currentUser = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    stubUsage = { input_tokens: 20, output_tokens: 10 }
    stubText = 'AI OUT'
    delete process.env.MULTITABLE_AI_BULK_MAX_ROWS
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await resetSideEffects()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── G1 ───────────────────────────────────────────────────────────────────
  test('G1: inline shortcut run writes source=ai-shortcut, a single-row batch', async () => {
    await grantOwnWrite()
    const R = `rec_s1_g1_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'hello' }, ACTOR)

    const res = await runReq({ recordId: R, fieldId: FLD_TARGET })
    expect(res.status).toBe(200)

    const rev = await revisionFor(R)
    expect(rev?.source).toBe('ai-shortcut')
    expect(rev?.batch_id).toBeTruthy()
    // Single-row action stays its own batch: exactly one revision shares this batch_id.
    const inBatch = await revisionsInBatch(rev!.batch_id!)
    expect(inBatch).toHaveLength(1)
  })

  // ── G2 ───────────────────────────────────────────────────────────────────
  test('G2: bulk-commit N confirmed rows in one request share ONE batch; history projection shows ONE batch with N changes', async () => {
    await grantOwnWrite()
    const runId = `aibulk_s1_g2_${TS}`
    const R1 = `rec_s1_g2a_${TS}`
    const R2 = `rec_s1_g2b_${TS}`
    const R3 = `rec_s1_g2c_${TS}`
    for (const r of [R1, R2, R3]) await seedRecord(r, { [FLD_SRC]: 'src' }, ACTOR)
    for (const r of [R1, R2, R3]) await seedCacheRow({ runId, recordId: r, proposedValue: `OUT-${r}`, previewVersion: 1 })

    const res = await commitReq({ runId, recordIds: [R1, R2, R3] })
    expect(res.status).toBe(200)
    expect(res.body.counts.written).toBe(3)

    const [rev1, rev2, rev3] = await Promise.all([revisionFor(R1), revisionFor(R2), revisionFor(R3)])
    expect(rev1?.source).toBe('ai-shortcut')
    expect(rev2?.source).toBe('ai-shortcut')
    expect(rev3?.source).toBe('ai-shortcut')
    const batchId = rev1?.batch_id
    expect(batchId).toBeTruthy()
    expect(rev2?.batch_id).toBe(batchId)
    expect(rev3?.batch_id).toBe(batchId)

    // LOCK-B6: the commit RESPONSE itself carries the same batch id (ephemeral run→batch mapping).
    expect(res.body.batchId).toBe(batchId)

    // READ side #1: the base-level history EVENTS list groups these 3 rows into ONE batch.
    const events = await historyEventsReq()
    expect(events.status).toBe(200)
    const batch = (events.body.data.batches as Array<{ batchId: string; source: string; visibleAffectedRecordCount: number }>)
      .find((b) => b.batchId === batchId)
    expect(batch).toBeTruthy()
    expect(batch?.source).toBe('ai-shortcut')
    expect(batch?.visibleAffectedRecordCount).toBe(3)

    // READ side #2: batch DETAIL lists all 3 changes.
    const detail = await historyDetailReq(batchId as string)
    expect(detail.status).toBe(200)
    expect(detail.body.data.changes).toHaveLength(3)
    const detailRecordIds = new Set((detail.body.data.changes as Array<{ recordId: string }>).map((c) => c.recordId))
    expect(detailRecordIds).toEqual(new Set([R1, R2, R3]))
  })

  // ── G3 ───────────────────────────────────────────────────────────────────
  test('G3: a MIXED-outcome bulk-commit batch — only WRITTEN rows join the batch; a non-written row contributes NOTHING', async () => {
    await grantOwnWrite() // actor may write only OWN records
    const runId = `aibulk_s1_g3_${TS}`
    const W1 = `rec_s1_g3w1_${TS}` // cached + fresh → written
    const W2 = `rec_s1_g3w2_${TS}` // cached + fresh → written
    const STALE = `rec_s1_g3stale_${TS}` // cached but version-shifted → stale_reprev
    const NOCACHE = `rec_s1_g3nc_${TS}` // confirmed but never cached → not_in_cache
    const NOPERM = `rec_s1_g3noperm_${TS}` // owned by OTHER → commit-time re-gate → skipped_no_perm
    await seedRecord(W1, { [FLD_SRC]: 'a' }, ACTOR)
    await seedRecord(W2, { [FLD_SRC]: 'b' }, ACTOR)
    await seedRecord(STALE, { [FLD_SRC]: 'c' }, ACTOR)
    await seedRecord(NOCACHE, { [FLD_SRC]: 'd' }, ACTOR)
    await seedRecord(NOPERM, { [FLD_SRC]: 'e' }, OTHER)
    await seedCacheRow({ runId, recordId: W1, proposedValue: 'OUT W1', previewVersion: 1 })
    await seedCacheRow({ runId, recordId: W2, proposedValue: 'OUT W2', previewVersion: 1 })
    await seedCacheRow({ runId, recordId: STALE, proposedValue: 'OUT STALE', previewVersion: 1 })
    await seedCacheRow({ runId, recordId: NOPERM, proposedValue: 'SHOULD NOT LAND', previewVersion: 1 })
    await q('UPDATE meta_records SET version = 2 WHERE id = $1', [STALE]) // shift → stale

    const res = await commitReq({ runId, recordIds: [W1, STALE, W2, NOCACHE, NOPERM] })
    expect(res.status).toBe(200)
    const byId = new Map((res.body.outcomes as Array<{ recordId: string; outcome: string }>).map((o) => [o.recordId, o.outcome]))
    expect(byId.get(W1)).toBe('written')
    expect(byId.get(W2)).toBe('written')
    expect(byId.get(STALE)).toBe('stale_reprev')
    expect(byId.get(NOCACHE)).toBe('not_in_cache')
    expect(byId.get(NOPERM)).toBe('skipped_no_perm')

    const [rev1, rev2] = await Promise.all([revisionFor(W1), revisionFor(W2)])
    const batchId = rev1?.batch_id
    expect(batchId).toBeTruthy()
    expect(rev2?.batch_id).toBe(batchId)

    // LOCK-B6: the commit RESPONSE carries the same batch id, even though this batch is mixed-outcome.
    expect(res.body.batchId).toBe(batchId)

    // Only the 2 WRITTEN rows are in the batch — STALE, NOCACHE, and NOPERM never got a revision at all.
    const inBatch = await revisionsInBatch(batchId as string)
    expect(inBatch).toHaveLength(2)
    expect(new Set(inBatch.map((r) => r.record_id))).toEqual(new Set([W1, W2]))
    expect(await revisionFor(STALE)).toBeUndefined()
    expect(await revisionFor(NOCACHE)).toBeUndefined()
    expect(await revisionFor(NOPERM)).toBeUndefined()
  })

  // ── G4 ───────────────────────────────────────────────────────────────────
  test('G4a: two SEPARATE bulk-commit requests → two DISTINCT batches', async () => {
    await grantOwnWrite()
    const runId = `aibulk_s1_g4a_${TS}`
    const RA = `rec_s1_g4a_a_${TS}`
    const RB = `rec_s1_g4a_b_${TS}`
    await seedRecord(RA, { [FLD_SRC]: 'a' }, ACTOR)
    await seedRecord(RB, { [FLD_SRC]: 'b' }, ACTOR)
    await seedCacheRow({ runId, recordId: RA, proposedValue: 'A', previewVersion: 1 })
    await seedCacheRow({ runId, recordId: RB, proposedValue: 'B', previewVersion: 1 })

    const r1 = await commitReq({ runId, recordIds: [RA] })
    expect(r1.status).toBe(200)
    const r2 = await commitReq({ runId, recordIds: [RB] })
    expect(r2.status).toBe(200)

    const [revA, revB] = await Promise.all([revisionFor(RA), revisionFor(RB)])
    expect(revA?.batch_id).toBeTruthy()
    expect(revB?.batch_id).toBeTruthy()
    expect(revA?.batch_id).not.toBe(revB?.batch_id)

    // LOCK-B6: each response carries ITS OWN batch id, matching its own revision.
    expect(r1.body.batchId).toBe(revA?.batch_id)
    expect(r2.body.batchId).toBe(revB?.batch_id)
  })

  test('G4b: two SEPARATE jobs, each committed once → two DISTINCT batches (job commit is single-shot per job)', async () => {
    await grantOwnWrite()
    // Cap=1: a request is job-routed only when its row count is OVER the cap, so each job below
    // needs 2 real rows (both committed) to actually go through the job path, not the inline one.
    process.env.MULTITABLE_AI_BULK_MAX_ROWS = '1'
    const R1A = `rec_s1_g4b_1a_${TS}`
    const R1B = `rec_s1_g4b_1b_${TS}`
    const R2A = `rec_s1_g4b_2a_${TS}`
    const R2B = `rec_s1_g4b_2b_${TS}`
    for (const r of [R1A, R1B, R2A, R2B]) await seedRecord(r, { [FLD_SRC]: 'x' }, ACTOR)

    const start1 = await bulkPreviewReq({ fieldId: FLD_TARGET, scope: 'sheet', recordIds: [R1A, R1B] })
    expect(start1.status).toBe(200)
    const jobId1 = start1.body.jobId as string
    expect(jobId1).toMatch(/^aibulkjob_/)
    await runJob(jobId1)
    const commit1 = await commitJobReq(jobId1, [R1A, R1B])
    expect(commit1.status).toBe(200)

    const start2 = await bulkPreviewReq({ fieldId: FLD_TARGET, scope: 'sheet', recordIds: [R2A, R2B] })
    expect(start2.status).toBe(200)
    const jobId2 = start2.body.jobId as string
    await runJob(jobId2)
    const commit2 = await commitJobReq(jobId2, [R2A, R2B])
    expect(commit2.status).toBe(200)

    const [rev1a, rev1b, rev2a, rev2b] = await Promise.all([revisionFor(R1A), revisionFor(R1B), revisionFor(R2A), revisionFor(R2B)])
    expect(rev1a?.batch_id).toBeTruthy()
    expect(rev1b?.batch_id).toBe(rev1a?.batch_id) // job1's two rows share ONE batch
    expect(rev2a?.batch_id).toBeTruthy()
    expect(rev2b?.batch_id).toBe(rev2a?.batch_id) // job2's two rows share a DIFFERENT batch
    expect(rev1a?.batch_id).not.toBe(rev2a?.batch_id)

    // LOCK-B6: each job-commit response carries ITS OWN batch id.
    expect(commit1.body.batchId).toBe(rev1a?.batch_id)
    expect(commit2.body.batchId).toBe(rev2a?.batch_id)

    // A THIRD successful commit call is impossible on either job (single-shot; confirms the premise
    // behind the G4 judgment call above, not just asserted in prose).
    const recommit1 = await commitJobReq(jobId1, [R1A])
    expect(recommit1.status).toBe(409)
    expect(recommit1.body.error.code).toBe('BULK_JOB_NOT_COMMITTABLE')
  })

  // ── G5 ───────────────────────────────────────────────────────────────────
  test('G5: job-commit spanning MULTIPLE BJ-10 chunks still shares ONE batch; READ side shows ONE batch with all N changes', async () => {
    await grantOwnWrite()
    process.env.MULTITABLE_AI_BULK_MAX_ROWS = '2' // forces job routing for 3 rows AND caps job-commit chunk size to 2
    const R1 = `rec_s1_g5_1_${TS}`
    const R2 = `rec_s1_g5_2_${TS}`
    const R3 = `rec_s1_g5_3_${TS}`
    for (const r of [R1, R2, R3]) await seedRecord(r, { [FLD_SRC]: 'src' }, ACTOR)

    const start = await bulkPreviewReq({ fieldId: FLD_TARGET, scope: 'sheet', recordIds: [R1, R2, R3] })
    expect(start.status).toBe(200)
    const jobId = start.body.jobId as string
    await runJob(jobId)
    const queued = await pollJobReq(jobId)
    expect(queued.body.generated).toBe(3) // all 3 generated before commit

    // ONE commit request confirming all 3 — internally this spans 2 chunks (chunkSize=2: [2,1]).
    const commit = await commitJobReq(jobId, [R1, R2, R3])
    expect(commit.status).toBe(200)
    expect(commit.body.counts.committed).toBe(3)

    const [rev1, rev2, rev3] = await Promise.all([revisionFor(R1), revisionFor(R2), revisionFor(R3)])
    const batchId = rev1?.batch_id
    expect(batchId).toBeTruthy()
    expect(rev2?.batch_id).toBe(batchId) // shared across the chunk boundary
    expect(rev3?.batch_id).toBe(batchId)
    expect([rev1, rev2, rev3].every((r) => r?.source === 'ai-shortcut')).toBe(true)

    // LOCK-B6: the job-commit RESPONSE carries the same batch id.
    expect(commit.body.batchId).toBe(batchId)

    const events = await historyEventsReq()
    const batch = (events.body.data.batches as Array<{ batchId: string; visibleAffectedRecordCount: number }>)
      .find((b) => b.batchId === batchId)
    expect(batch?.visibleAffectedRecordCount).toBe(3)
    const detail = await historyDetailReq(batchId as string)
    expect(detail.body.data.changes).toHaveLength(3)
  })

  // ── G5b ──────────────────────────────────────────────────────────────────
  test('G5b: restoring a record an AI batch touched writes source=restore, never ai-shortcut', async () => {
    await grantOwnWrite()
    const R = `rec_s1_g5b_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'src', [FLD_TARGET]: 'ORIGINAL' }, ACTOR) // version 1
    // restore-preview looks up an actual meta_record_revisions row AT the target version — a live
    // meta_records row alone isn't enough (matches the multitable-restore-execute-realdb.test.ts
    // fixture pattern: the "create" revision must exist for version 1 to be restorable to).
    await q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
       VALUES (gen_random_uuid(), $1, $2, 1, 'create', 'rest', ARRAY[$3,$4]::text[], '{}'::jsonb, $5::jsonb, now())`,
      [SHEET_ID, R, FLD_SRC, FLD_TARGET, JSON.stringify({ [FLD_SRC]: 'src', [FLD_TARGET]: 'ORIGINAL' })],
    )

    // An AI write lands version 2 with source=ai-shortcut.
    const run = await runReq({ recordId: R, fieldId: FLD_TARGET })
    expect(run.status).toBe(200)
    const afterAi = await revisionFor(R)
    expect(afterAi?.source).toBe('ai-shortcut')
    expect(afterAi?.version).toBe(2)

    // Restore back to version 1 via the EXISTING single-record restore route.
    const pv = await restorePreviewReq(R, { targetVersion: 1 })
    expect(pv.status).toBe(200)
    const identity = pv.body.data.previewIdentity as string
    const ex = await restoreExecuteReq(R, { targetVersion: 1, expectedVersion: 2, previewIdentity: identity })
    expect(ex.status).toBe(200)

    const afterRestore = await revisionFor(R)
    expect(afterRestore?.source).toBe('restore')
    expect(afterRestore?.source).not.toBe('ai-shortcut')
    expect(afterRestore?.version).toBe(3) // restore is forward-writing (LOCK A4 / R1/R3)
  })

  // ── G6 ───────────────────────────────────────────────────────────────────
  test('G6: a plain (non-AI) PATCH caller is unaffected — no batchId supplied, each call mints its own fresh id', async () => {
    const R1 = `rec_s1_g6a_${TS}`
    const R2 = `rec_s1_g6b_${TS}`
    await seedRecord(R1, { [FLD_SRC]: 'x' }, ACTOR)
    await seedRecord(R2, { [FLD_SRC]: 'y' }, ACTOR)

    const p1 = await patchReq({ sheetId: SHEET_ID, changes: [{ recordId: R1, fieldId: FLD_SRC, value: 'x2' }] })
    expect(p1.status).toBe(200)
    const p2 = await patchReq({ sheetId: SHEET_ID, changes: [{ recordId: R2, fieldId: FLD_SRC, value: 'y2' }] })
    expect(p2.status).toBe(200)

    const [rev1, rev2] = await Promise.all([revisionFor(R1), revisionFor(R2)])
    expect(rev1?.source).toBe('rest') // untouched default — this seam never changed non-AI behavior
    expect(rev2?.source).toBe('rest')
    expect(rev1?.batch_id).toBeTruthy()
    expect(rev2?.batch_id).toBeTruthy()
    expect(rev1?.batch_id).not.toBe(rev2?.batch_id) // still a fresh id per call, exactly as before
  })

  // ── G7 ───────────────────────────────────────────────────────────────────
  test('G7: a client-supplied batchId in a bulk-commit request body has NO effect (server-minted only)', async () => {
    await grantOwnWrite()
    const runId = `aibulk_s1_g7_${TS}`
    const R = `rec_s1_g7_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'src' }, ACTOR)
    await seedCacheRow({ runId, recordId: R, proposedValue: 'OUT', previewVersion: 1 })

    const evilBatchId = 'evil-client-supplied-batch-id'
    const res = await commitReq({ runId, recordIds: [R], batchId: evilBatchId })
    expect(res.status).toBe(200) // the extra field is silently dropped by the zod schema, not a 400
    expect(res.body.outcomes).toEqual([{ recordId: R, outcome: 'written' }])

    const rev = await revisionFor(R)
    expect(rev?.batch_id).toBeTruthy()
    expect(rev?.batch_id).not.toBe(evilBatchId) // the real batch_id is server-minted, never the client value

    // LOCK-B6/B4: the RESPONSE batchId is also the real server-minted one, never the client's value.
    expect(res.body.batchId).toBe(rev?.batch_id)
    expect(res.body.batchId).not.toBe(evilBatchId)
  })

  // ── G7b (job-commit parallel to G7) ────────────────────────────────────────
  test('G7b: a client-supplied batchId in a JOB-commit request body has NO effect (server-minted only, LOCK-B4)', async () => {
    await grantOwnWrite()
    // Over-cap row count → the request is job-routed (mirrors G4b), exercising the job-commit route.
    process.env.MULTITABLE_AI_BULK_MAX_ROWS = '1'
    const R1 = `rec_s1_g7b_1_${TS}`
    const R2 = `rec_s1_g7b_2_${TS}`
    for (const r of [R1, R2]) await seedRecord(r, { [FLD_SRC]: 'x' }, ACTOR)

    const start = await bulkPreviewReq({ fieldId: FLD_TARGET, scope: 'sheet', recordIds: [R1, R2] })
    expect(start.status).toBe(200)
    const jobId = start.body.jobId as string
    expect(jobId).toMatch(/^aibulkjob_/)
    await runJob(jobId)

    // Inject the forbidden field directly — the commitJobReq helper never sends it, and the job-commit
    // zod schema (routes/multitable-ai.ts) has no `batchId` key, so it is stripped before the handler.
    const evilBatchId = 'evil-client-supplied-batch-id'
    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-job/${jobId}/commit`)
      .send({ recordIds: [R1, R2], batchId: evilBatchId })
    expect(res.status).toBe(200) // extra field silently dropped by the schema, not a 400

    const [rev1, rev2] = await Promise.all([revisionFor(R1), revisionFor(R2)])
    expect(rev1?.batch_id).toBeTruthy()
    expect(rev2?.batch_id).toBe(rev1?.batch_id) // the job's rows share ONE server-minted batch
    expect(rev1?.batch_id).not.toBe(evilBatchId) // never the client-supplied value

    // LOCK-B6/B4: the RESPONSE batchId is the real server-minted one, never the client's value.
    expect(res.body.batchId).toBe(rev1?.batch_id)
    expect(res.body.batchId).not.toBe(evilBatchId)
  })
})
