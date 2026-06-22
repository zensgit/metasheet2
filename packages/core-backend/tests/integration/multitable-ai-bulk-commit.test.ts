/**
 * B-2 AI bulk-COMMIT — REAL-DB suite.
 *
 * Design lock:
 * docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md
 *
 * Locks the six B-2 acceptance criteria (each → a golden here):
 *  1. Commit ONLY cached rows: a cached + confirmed row is WRITTEN with the EXACT
 *     cached value; a confirmed recordId with NO cache entry → `not_in_cache`,
 *     never written. The provider is NEVER called (fetch stub asserts 0 calls).
 *  2. Never commit a non-cached / B-1 `failures[]` row → `not_in_cache`.
 *  3. expectedVersion stale-drop: bump the record version AFTER seeding the cache
 *     → the write rides the cached previewVersion → VersionConflictError →
 *     `stale_reprev` (the stale value is never written over shifted data).
 *  4. Abandoned previews stay charged — release NOTHING: run a REAL bulk-preview
 *     (charges the ledger), then commit a SUBSET → the ledger token-sum is
 *     UNCHANGED by the commit (commit does zero ledger writes).
 *  5. Per-row partial outcomes: a mixed batch yields the right per-row outcome
 *     with NO all-or-nothing rollback (the writable rows land even alongside a
 *     stale/not-cached one).
 *  6. Re-gate at commit: revoke write (own-write scope, row created by another)
 *     AFTER seeding the cache → `skipped_no_perm`, never written. A locked record
 *     (record-lock guard) → `write_conflict`.
 *
 * Cache rows are seeded DIRECTLY via insertBulkPreviewCacheRow for the targeted
 * goldens (so the exact previewVersion / value is controlled); the
 * abandon-no-release golden drives the REAL bulk-preview route (with the injected
 * fetch stub) so the ledger is genuinely charged before the commit subset.
 *
 * Provider HTTP is NEVER real — fetchFn is injected at router construction; the
 * commit path must call it ZERO times (it writes cached values, never generates).
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
import {
  AI_BULK_PREVIEW_CACHE_TABLE,
  insertBulkPreviewCacheRow,
  type BulkPreviewCacheRow,
} from '../../src/services/ai-bulk-preview-cache'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_b2_${TS}`
const SHEET_ID = `sheet_b2_${TS}`
const FLD_SRC = `fld_b2_src_${TS}`
const FLD_TARGET = `fld_b2_target_${TS}`

// The actor under test (member with write — own-write scope added per test).
const ACTOR = `u_b2_actor_${TS}`
const OTHER = `u_b2_other_${TS}` // creator/locker of the not-writable / locked row

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
let stubText = 'AI OUT'
let fetchCallCount = 0

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// The provider stub — the COMMIT path must never call this (it writes cached
// values). It exists only so the abandon-no-release golden can drive a REAL
// bulk-PREVIEW (which DOES call it) to charge the ledger.
const fetchStub = (async () => {
  fetchCallCount += 1
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text: stubText }], usage: { ...stubUsage } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}) as typeof fetch

const commitReq = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-commit`).send(body)
const previewReq = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/ai/shortcut/bulk-preview`).send(body)

const ledgerTokenSum = async () => {
  const res = await q(
    `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`,
    [SHEET_ID],
  )
  return Number((res.rows[0] as { total: string }).total)
}
const recordValue = async (recordId: string): Promise<unknown> => {
  const res = await q('SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, SHEET_ID])
  const data = (res.rows[0] as { data?: Record<string, unknown> } | undefined)?.data ?? {}
  return data[FLD_TARGET]
}
const recordVersion = async (recordId: string): Promise<number> => {
  const res = await q('SELECT version FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, SHEET_ID])
  return Number((res.rows[0] as { version?: unknown } | undefined)?.version ?? 0)
}

async function seedRecord(recordId: string, data: Record<string, unknown>, createdBy: string) {
  await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [
    recordId,
    SHEET_ID,
    JSON.stringify(data),
    createdBy,
  ])
}

/** Seed one cache row directly (the B-2 commit's ONLY source of values). */
async function seedCacheRow(overrides: Partial<BulkPreviewCacheRow> & Pick<BulkPreviewCacheRow, 'runId' | 'recordId'>) {
  const row: BulkPreviewCacheRow = {
    actorId: ACTOR,
    sheetId: SHEET_ID,
    fieldId: FLD_TARGET,
    previewVersion: 1,
    proposedValue: 'CACHED VALUE',
    usageTokens: 30,
    costUsd: 0.001,
    ...overrides,
  }
  await insertBulkPreviewCacheRow((sql, params) => q(sql, params), row)
}

/** Grant the actor own-write scope (may write only records they CREATED). */
async function grantOwnWrite() {
  await q(
    `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,$3)`,
    [SHEET_ID, ACTOR, 'multitable:write-own'],
  )
}

async function resetSideEffects() {
  await q(`DELETE FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
  await q(`DELETE FROM ${AI_BULK_PREVIEW_CACHE_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
  fetchCallCount = 0
}

describeIfDatabase('B-2 AI bulk-commit (real DB)', () => {
  beforeAll(async () => {
    for (const key of AI_ENV_KEYS) {
      savedEnvSet(key)
      delete process.env[key]
    }
    process.env.MULTITABLE_AI_ENABLED = '1'
    process.env.MULTITABLE_AI_PROVIDER = 'anthropic'
    process.env.MULTITABLE_AI_API_KEY = 'sk-b2commit-test-key'
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

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'B2 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'B2 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SRC, SHEET_ID, 'Notes', 'string', '{}', 1])
    // Target: persisted aiShortcut over FLD_SRC (so the REAL preview path works for the abandon golden).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      FLD_TARGET,
      SHEET_ID,
      'Summary',
      'string',
      JSON.stringify({ aiShortcut: { kind: 'summarize', sourceFieldIds: [FLD_SRC] } }),
      2,
    ])
    // Enable row-level read-deny enforcement (parity with B-1; some goldens rely on it).
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
    for (const key of AI_ENV_KEYS) savedEnvRestore(key)
  })

  beforeEach(async () => {
    currentUser = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    stubUsage = { input_tokens: 20, output_tokens: 10 }
    stubText = 'AI OUT'
    delete process.env.MULTITABLE_AI_BULK_MAX_ROWS
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = savedEnvGet('MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP') ?? ''
    process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP = savedEnvGet('MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP') ?? ''
    if (!process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP) delete process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP
    if (!process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP) delete process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await resetSideEffects()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── Criterion 1: commit ONLY cached rows ──────────────────────────────────
  test('commit-only-cached: cached+confirmed → written with EXACT value; confirmed-but-not-cached → not_in_cache', async () => {
    await grantOwnWrite()
    const runId = `aibulk_b2_only_${TS}`
    const R_CACHED = `rec_b2_cached_${TS}`
    const R_NOCACHE = `rec_b2_nocache_${TS}`
    await seedRecord(R_CACHED, { [FLD_SRC]: 'src' }, ACTOR)
    await seedRecord(R_NOCACHE, { [FLD_SRC]: 'src' }, ACTOR)
    // Only R_CACHED has a cache row; both are confirmed.
    await seedCacheRow({ runId, recordId: R_CACHED, proposedValue: 'EXACT CACHED OUTPUT', previewVersion: 1 })

    const res = await commitReq({ runId, recordIds: [R_CACHED, R_NOCACHE] })
    expect(res.status).toBe(200)

    const byId = new Map((res.body.outcomes as Array<{ recordId: string; outcome: string }>).map((o) => [o.recordId, o.outcome]))
    expect(byId.get(R_CACHED)).toBe('written')
    expect(byId.get(R_NOCACHE)).toBe('not_in_cache')

    // The EXACT cached value landed in the field; the not-cached record is untouched.
    expect(await recordValue(R_CACHED)).toBe('EXACT CACHED OUTPUT')
    expect(await recordValue(R_NOCACHE)).toBeUndefined()
    expect(await recordVersion(R_CACHED)).toBe(2) // version bumped by the write

    // The provider was NEVER called — commit writes cached values, it never generates.
    expect(fetchCallCount).toBe(0)
  })

  // ── Criterion 2: never commit a non-cached / failures[] row ────────────────
  test('never-commit-failures: a confirmed row that was a B-1 failure (no cache row) → not_in_cache, never written', async () => {
    await grantOwnWrite()
    const runId = `aibulk_b2_fail_${TS}`
    // R_FAIL stands for a B-1 `failures[]` row: it was charged but NEVER cached, so
    // there is no cache row for it. (The commit path can only ever see cache rows.)
    const R_FAIL = `rec_b2_fail_${TS}`
    await seedRecord(R_FAIL, { [FLD_SRC]: 'src' }, ACTOR)
    // Deliberately seed NO cache row for this run.

    const res = await commitReq({ runId, recordIds: [R_FAIL] })
    expect(res.status).toBe(200)
    expect(res.body.outcomes).toEqual([{ recordId: R_FAIL, outcome: 'not_in_cache' }])
    expect(await recordValue(R_FAIL)).toBeUndefined() // never written
    expect(fetchCallCount).toBe(0)
  })

  test('unknown runId → all not_in_cache at 200 (no 404)', async () => {
    await grantOwnWrite()
    const R = `rec_b2_unknownrun_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'src' }, ACTOR)
    const res = await commitReq({ runId: `aibulk_b2_doesnotexist_${TS}`, recordIds: [R] })
    expect(res.status).toBe(200)
    expect(res.body.outcomes).toEqual([{ recordId: R, outcome: 'not_in_cache' }])
    expect(await recordValue(R)).toBeUndefined()
  })

  test('expired TTL: a cache row past its expiresAt is treated as not_in_cache, never written', async () => {
    await grantOwnWrite()
    const runId = `aibulk_b2_expired_${TS}`
    const R = `rec_b2_expired_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'src', [FLD_TARGET]: 'UNCHANGED' }, ACTOR)
    // The cache row was generated, then the run was abandoned long enough that its
    // TTL lapsed (insertBulkPreviewCacheRow honors an explicit past expiresAt).
    await seedCacheRow({ runId, recordId: R, proposedValue: 'EXPIRED VALUE', expiresAt: new Date(Date.now() - 60_000) })

    const res = await commitReq({ runId, recordIds: [R] })
    expect(res.status).toBe(200)
    // An expired row has no live value to commit → not_in_cache, never written.
    expect(res.body.outcomes).toEqual([{ recordId: R, outcome: 'not_in_cache' }])
    expect(await recordValue(R)).toBe('UNCHANGED')
    expect(await recordVersion(R)).toBe(1)
    expect(fetchCallCount).toBe(0)
  })

  // ── Criterion 3: expectedVersion stale-drop ───────────────────────────────
  test('stale-drop: bump record version after seeding cache → stale_reprev (cached value never written over shifted data)', async () => {
    await grantOwnWrite()
    const runId = `aibulk_b2_stale_${TS}`
    const R_STALE = `rec_b2_stale_${TS}`
    await seedRecord(R_STALE, { [FLD_SRC]: 'src', [FLD_TARGET]: 'ORIGINAL' }, ACTOR) // version 1
    // Cache was generated against version 1.
    await seedCacheRow({ runId, recordId: R_STALE, proposedValue: 'STALE CACHED', previewVersion: 1 })
    // The record SHIFTS after the preview (a concurrent edit) → now version 2.
    await q('UPDATE meta_records SET version = 2, data = $2::jsonb WHERE id = $1', [
      R_STALE,
      JSON.stringify({ [FLD_SRC]: 'src', [FLD_TARGET]: 'CONCURRENTLY CHANGED' }),
    ])

    const res = await commitReq({ runId, recordIds: [R_STALE] })
    expect(res.status).toBe(200)
    expect(res.body.outcomes).toEqual([{ recordId: R_STALE, outcome: 'stale_reprev' }])

    // The stale cached value was NEVER written — the concurrent value stands, version unchanged.
    expect(await recordValue(R_STALE)).toBe('CONCURRENTLY CHANGED')
    expect(await recordVersion(R_STALE)).toBe(2)
    expect(fetchCallCount).toBe(0)
  })

  // ── Criterion 4: abandoned previews remain charged — release NOTHING ───────
  test('abandon-no-release: real preview charges the ledger; committing a SUBSET leaves the ledger token-sum UNCHANGED', async () => {
    await grantOwnWrite()
    stubUsage = { input_tokens: 30, output_tokens: 12 } // 42 tokens/charged row
    const P1 = `rec_b2_p1_${TS}`
    const P2 = `rec_b2_p2_${TS}`
    const P3 = `rec_b2_p3_${TS}`
    await seedRecord(P1, { [FLD_SRC]: 'one' }, ACTOR)
    await seedRecord(P2, { [FLD_SRC]: 'two' }, ACTOR)
    await seedRecord(P3, { [FLD_SRC]: 'three' }, ACTOR)

    // Drive the REAL bulk-preview → charges all 3 rows + caches them.
    const preview = await previewReq({ fieldId: FLD_TARGET, scope: 'sheet' })
    expect(preview.status).toBe(200)
    const runId = preview.body.runId as string
    expect((preview.body.rows as unknown[]).length).toBe(3)
    expect(fetchCallCount).toBe(3) // 3 provider calls at PREVIEW

    const ledgerBefore = await ledgerTokenSum()
    expect(ledgerBefore).toBe(3 * (30 + 12)) // charge settled at preview

    // Commit ONLY a subset (P1). P2/P3 are ABANDONED — they must release nothing.
    const fetchAtCommitStart = fetchCallCount
    const res = await commitReq({ runId, recordIds: [P1] })
    expect(res.status).toBe(200)
    expect(res.body.outcomes).toEqual([{ recordId: P1, outcome: 'written' }])

    // THE INVARIANT: the commit did ZERO ledger writes — the token-sum is UNCHANGED,
    // and abandoning P2/P3 released NOTHING (charge-on-generation, never released).
    expect(await ledgerTokenSum()).toBe(ledgerBefore)
    // And the commit made NO additional provider call.
    expect(fetchCallCount).toBe(fetchAtCommitStart)

    // P1 got the value it was previewed with; P2/P3 stay untouched.
    expect(await recordValue(P1)).toBe('AI OUT')
    expect(await recordValue(P2)).toBeUndefined()
    expect(await recordValue(P3)).toBeUndefined()
  })

  // ── Criterion 5: per-row partial outcomes (no all-or-nothing rollback) ─────
  test('partial-success: a mixed batch yields per-row outcomes; the writable rows land alongside a stale + a not-cached one', async () => {
    await grantOwnWrite()
    const runId = `aibulk_b2_mixed_${TS}`
    const W1 = `rec_b2_w1_${TS}` // cached + fresh → written
    const W2 = `rec_b2_w2_${TS}` // cached + fresh → written
    const S = `rec_b2_s_${TS}` // cached but version-shifted → stale_reprev
    const NC = `rec_b2_nc_${TS}` // confirmed but never cached → not_in_cache
    await seedRecord(W1, { [FLD_SRC]: 'a' }, ACTOR)
    await seedRecord(W2, { [FLD_SRC]: 'b' }, ACTOR)
    await seedRecord(S, { [FLD_SRC]: 'c', [FLD_TARGET]: 'KEEP' }, ACTOR)
    await seedRecord(NC, { [FLD_SRC]: 'd' }, ACTOR)
    await seedCacheRow({ runId, recordId: W1, proposedValue: 'OUT W1', previewVersion: 1 })
    await seedCacheRow({ runId, recordId: W2, proposedValue: 'OUT W2', previewVersion: 1 })
    await seedCacheRow({ runId, recordId: S, proposedValue: 'OUT S', previewVersion: 1 })
    await q('UPDATE meta_records SET version = 2 WHERE id = $1', [S]) // shift S → stale

    const res = await commitReq({ runId, recordIds: [W1, S, W2, NC] })
    expect(res.status).toBe(200)
    const byId = new Map((res.body.outcomes as Array<{ recordId: string; outcome: string }>).map((o) => [o.recordId, o.outcome]))
    expect(byId.get(W1)).toBe('written')
    expect(byId.get(W2)).toBe('written')
    expect(byId.get(S)).toBe('stale_reprev')
    expect(byId.get(NC)).toBe('not_in_cache')

    // NO all-or-nothing rollback: both writable rows landed despite the stale one.
    expect(await recordValue(W1)).toBe('OUT W1')
    expect(await recordValue(W2)).toBe('OUT W2')
    expect(await recordValue(S)).toBe('KEEP') // stale never overwrote

    // counts aggregate matches.
    expect(res.body.counts).toMatchObject({ written: 2, stale_reprev: 1, not_in_cache: 1, write_conflict: 0, skipped_no_perm: 0 })
  })

  // ── Criterion 6: re-gate at commit ────────────────────────────────────────
  test('re-gate: revoke write (own-write scope, row created by another) AFTER cache → skipped_no_perm, never written', async () => {
    await grantOwnWrite() // actor may write only OWN records
    const runId = `aibulk_b2_regate_${TS}`
    // The row was created by SOMEONE ELSE → at COMMIT the own-write policy denies it,
    // even though a cache row exists (e.g. it was generated when the actor still had broad write).
    const R_NOWRITE = `rec_b2_regate_${TS}`
    await seedRecord(R_NOWRITE, { [FLD_SRC]: 'src', [FLD_TARGET]: 'UNCHANGED' }, OTHER)
    await seedCacheRow({ runId, recordId: R_NOWRITE, proposedValue: 'SHOULD NOT LAND', previewVersion: 1 })

    const res = await commitReq({ runId, recordIds: [R_NOWRITE] })
    expect(res.status).toBe(200)
    expect(res.body.outcomes).toEqual([{ recordId: R_NOWRITE, outcome: 'skipped_no_perm' }])
    // Never written — the field keeps its original value, version unchanged.
    expect(await recordValue(R_NOWRITE)).toBe('UNCHANGED')
    expect(await recordVersion(R_NOWRITE)).toBe(1)
    expect(fetchCallCount).toBe(0)
  })

  test('re-gate: a record-level READ-deny AFTER cache → skipped_no_perm, never written', async () => {
    await grantOwnWrite()
    const runId = `aibulk_b2_readdeny_${TS}`
    const R = `rec_b2_readdeny_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'src', [FLD_TARGET]: 'UNCHANGED' }, ACTOR)
    await seedCacheRow({ runId, recordId: R, proposedValue: 'SHOULD NOT LAND', previewVersion: 1 })
    // Read access revoked after the preview was cached.
    await q(
      `INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,'user',$3,'none')`,
      [SHEET_ID, R, ACTOR],
    )

    const res = await commitReq({ runId, recordIds: [R] })
    expect(res.status).toBe(200)
    expect(res.body.outcomes).toEqual([{ recordId: R, outcome: 'skipped_no_perm' }])
    expect(await recordValue(R)).toBe('UNCHANGED')
    expect(fetchCallCount).toBe(0)
  })

  test('re-gate: a layer-3 field-permission revoke (target readOnly) AFTER cache → skipped_no_perm, never written', async () => {
    await grantOwnWrite()
    const runId = `aibulk_b2_fieldperm_${TS}`
    const R = `rec_b2_fieldperm_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'src', [FLD_TARGET]: 'UNCHANGED' }, ACTOR)
    await seedCacheRow({ runId, recordId: R, proposedValue: 'SHOULD NOT LAND', previewVersion: 1 })
    // The target field becomes read-only for the actor after the preview was cached.
    await q(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,true,true)`,
      [SHEET_ID, FLD_TARGET, ACTOR],
    )

    const res = await commitReq({ runId, recordIds: [R] })
    expect(res.status).toBe(200)
    expect(res.body.outcomes).toEqual([{ recordId: R, outcome: 'skipped_no_perm' }])
    expect(await recordValue(R)).toBe('UNCHANGED')
    expect(fetchCallCount).toBe(0)
  })

  test('re-gate: a LOCKED record (record-lock guard) → write_conflict, never written', async () => {
    // NB: NO own-write scope here — the actor keeps broad multitable:write so the
    // pre-gate ensureRecordWriteAllowed passes for a row created by ANOTHER user,
    // letting the request REACH patchRecords. The record-lock guard only exempts
    // the record's OWNER or LOCKER, so the row must be created AND locked by OTHER
    // for the lock to actually bite (a row the actor created would be lock-exempt).
    const runId = `aibulk_b2_locked_${TS}`
    const R = `rec_b2_locked_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'src', [FLD_TARGET]: 'UNCHANGED' }, OTHER)
    await seedCacheRow({ runId, recordId: R, proposedValue: 'SHOULD NOT LAND', previewVersion: 1 })
    // Locked by OTHER after the preview — the record-lock guard inside patchRecords
    // (which fires BEFORE the version check) rejects the write for the non-owner actor.
    await q('UPDATE meta_records SET locked = true, locked_by = $2, locked_at = now() WHERE id = $1', [R, OTHER])

    const res = await commitReq({ runId, recordIds: [R] })
    expect(res.status).toBe(200)
    expect(res.body.outcomes).toEqual([{ recordId: R, outcome: 'write_conflict' }])
    // The lock held — the cached value never landed, version unchanged.
    expect(await recordValue(R)).toBe('UNCHANGED')
    expect(await recordVersion(R)).toBe(1)
    expect(fetchCallCount).toBe(0)
  })

  // ── Owner gate: a cache row belongs to the actor who previewed it ──────────
  test('owner gate: ACTOR_B cannot commit ACTOR_A cached output (cross-actor) → not_in_cache, field unchanged', async () => {
    // ACTOR_A previewed record R and cached the output — generated under ACTOR_A's
    // source-field read permissions (it can encode source content ACTOR_B can't read).
    // ACTOR_B has BROAD write (canEditRecord on R, like the locked test) AND the runId,
    // so the ONLY thing that must stop the commit is the cache OWNER gate.
    const runId = `aibulk_b2_xactor_${TS}`
    const R = `rec_b2_xactor_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'src', [FLD_TARGET]: 'UNCHANGED' }, ACTOR)
    await seedCacheRow({ runId, recordId: R, actorId: ACTOR, proposedValue: 'ACTOR_A ONLY OUTPUT', previewVersion: 1 })

    // Switch to ACTOR_B (broad multitable:write → canEditRecord on R).
    currentUser = { id: OTHER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const res = await commitReq({ runId, recordIds: [R] })
    expect(res.status).toBe(200)
    // Owner gate drops ACTOR_A's cache for ACTOR_B → not_in_cache (NOT written; and NOT
    // skipped_no_perm, since the gate filters the cache BEFORE the per-row re-gate).
    expect(res.body.outcomes).toEqual([{ recordId: R, outcome: 'not_in_cache' }])
    expect(await recordValue(R)).toBe('UNCHANGED') // ACTOR_A's output never landed
    expect(await recordVersion(R)).toBe(1)
    expect(fetchCallCount).toBe(0)
  })

  // ── Cross-sheet runId guard + double-commit self-guard + shape pin ─────────
  test('cross-sheet guard: a cache row whose sheet_id differs from the URL sheet is NOT committed (not_in_cache)', async () => {
    await grantOwnWrite()
    const runId = `aibulk_b2_xsheet_${TS}`
    const R = `rec_b2_xsheet_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'src' }, ACTOR)
    // A cache row carrying a DIFFERENT sheet_id (a runId belonging to another sheet).
    await seedCacheRow({ runId, recordId: R, sheetId: `other_sheet_${TS}`, proposedValue: 'WRONG SHEET', previewVersion: 1 })

    const res = await commitReq({ runId, recordIds: [R] })
    expect(res.status).toBe(200)
    expect(res.body.outcomes).toEqual([{ recordId: R, outcome: 'not_in_cache' }])
    expect(await recordValue(R)).toBeUndefined()
  })

  test('double-commit is self-guarding: re-committing the same run drops the already-written row as stale_reprev', async () => {
    await grantOwnWrite()
    const runId = `aibulk_b2_double_${TS}`
    const R = `rec_b2_double_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'src' }, ACTOR)
    await seedCacheRow({ runId, recordId: R, proposedValue: 'ONCE', previewVersion: 1 })

    const first = await commitReq({ runId, recordIds: [R] })
    expect(first.body.outcomes).toEqual([{ recordId: R, outcome: 'written' }])
    expect(await recordValue(R)).toBe('ONCE')

    // The first write bumped the version to 2; the cache still rides previewVersion 1.
    const second = await commitReq({ runId, recordIds: [R] })
    expect(second.body.outcomes).toEqual([{ recordId: R, outcome: 'stale_reprev' }])
    expect(await recordValue(R)).toBe('ONCE') // unchanged by the second commit
  })

  test('validation: missing runId / empty recordIds → 400 VALIDATION_ERROR', async () => {
    const noRun = await commitReq({ recordIds: ['r1'] })
    expect(noRun.status).toBe(400)
    expect(noRun.body.error.code).toBe('VALIDATION_ERROR')
    const emptyIds = await commitReq({ runId: 'aibulk_x', recordIds: [] })
    expect(emptyIds.status).toBe(400)
    expect(emptyIds.body.error.code).toBe('VALIDATION_ERROR')
  })

  test('response shape is pinned (fixture-drift discipline): top-level { outcomes, counts } + count keys', async () => {
    await grantOwnWrite()
    const runId = `aibulk_b2_shape_${TS}`
    const R = `rec_b2_shape_${TS}`
    await seedRecord(R, { [FLD_SRC]: 'src' }, ACTOR)
    await seedCacheRow({ runId, recordId: R, proposedValue: 'V', previewVersion: 1 })

    const res = await commitReq({ runId, recordIds: [R] })
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['counts', 'outcomes'])
    expect(Object.keys(res.body.counts).sort()).toEqual(['not_in_cache', 'skipped_no_perm', 'stale_reprev', 'write_conflict', 'written'])
    expect(res.body.outcomes).toEqual([{ recordId: R, outcome: 'written' }])
  })
})

// ── env save/restore helpers (avoid a Map closure in the describe body) ──────
const _savedEnv = new Map<string, string | undefined>()
function savedEnvSet(key: string) {
  _savedEnv.set(key, process.env[key])
}
function savedEnvGet(key: string): string | undefined {
  return _savedEnv.get(key)
}
function savedEnvRestore(key: string) {
  const value = _savedEnv.get(key)
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
