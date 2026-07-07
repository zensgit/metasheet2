/**
 * LOCK-12 — partial-success bulk `/patch` shares ONE History Center batch (real DB).
 *
 * Finding: /tmp/finding-lock12-partialsuccess-per-record-batch-20260706.md
 *
 * The bulk `POST /patch` route (`packages/core-backend/src/routes/univer-meta.ts`) has two branches:
 *  - all-or-nothing: one `RecordWriteService.patchRecords` call for the whole request → already shared
 *    one batch (covered by `multitable-patch-batchid-echo-realdb.test.ts`'s multi-record case).
 *  - `partialSuccess`: calls `patchRecords` ONCE PER RECORD (so a per-record failure doesn't abort the
 *    others). Before the LOCK-12 fix, each of those per-record calls minted its OWN fresh batch_id, so a
 *    single bulk paste/fill with some rows skipped/denied shattered into N separate History Center
 *    batches instead of one. The fix threads ONE server-minted batchId into every per-record call in
 *    this branch, so every record the request actually APPLIES shares one batch_id — a record that fails
 *    (locked, in this suite) simply never gets a revision at all, so it can never appear in the batch.
 *
 * This suite:
 *  - drives a partial-success `/patch` over 3 records, one of which (REC_LOCKED) is locked by a
 *    different actor so its per-record `patchRecords` call throws (FORBIDDEN) while the other two apply;
 *  - asserts the two APPLIED records' `meta_record_revisions` rows share ONE batch_id;
 *  - asserts the locked record got NO revision at all (non-vacuous: it is not merely excluded from the
 *    batch id comparison, it never wrote anything);
 *  - asserts `loadHistoryBatchDetail` (via `GET /bases/:baseId/history/events/:batchId`) returns exactly
 *    the 2 applied records as one batch, and does NOT include the locked/skipped record;
 *  - asserts the partialSuccess response shape is otherwise untouched (still `updated`/`failed`, no new
 *    `batchId` field leaking into that branch's response — LOCK-12 changes batch ATTRIBUTION only).
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI, matching this repo's real-DB suites).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_l12_${TS}`
const SHEET_ID = `sheet_l12_${TS}`
const FLD = `fld_l12_${TS}`
const REC_A = `rec_l12_a_${TS}`
const REC_B = `rec_l12_b_${TS}`
const REC_LOCKED = `rec_l12_locked_${TS}`
const ACTOR_ID = `u_l12_actor_${TS}`
const LOCKER_ID = `u_l12_locker_${TS}` // locks REC_LOCKED; distinct from ACTOR (not the locker, not the owner)

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express

const patchPartial = (changes: Array<{ recordId: string; fieldId: string; value: unknown }>) =>
  request(app).post('/api/multitable/patch').send({ sheetId: SHEET_ID, partialSuccess: true, changes })

const historyDetailReq = (batchId: string) =>
  request(app).get(`/api/multitable/bases/${BASE_ID}/history/events/${batchId}`)

type RevisionRow = { batch_id: string | null }
async function revisionFor(recordId: string): Promise<RevisionRow | undefined> {
  const res = await q(
    'SELECT batch_id FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 ORDER BY created_at DESC LIMIT 1',
    [SHEET_ID, recordId],
  )
  return res.rows[0] as RevisionRow | undefined
}

async function lockRow(recordId: string, lockedBy: string) {
  await q('UPDATE meta_records SET locked = true, locked_by = $2, locked_at = now() WHERE id = $1', [recordId, lockedBy])
}

describeIfDatabase('LOCK-12 — partial-success bulk /patch shared batch grouping (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = { id: ACTOR_ID, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'LOCK-12 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'LOCK-12 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD, SHEET_ID, 'Val', 'string', '{}', 1])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  beforeEach(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_A, SHEET_ID, JSON.stringify({ [FLD]: 'a-orig' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_B, SHEET_ID, JSON.stringify({ [FLD]: 'b-orig' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_LOCKED, SHEET_ID, JSON.stringify({ [FLD]: 'locked-orig' })])
    await lockRow(REC_LOCKED, LOCKER_ID) // locked by neither ACTOR (the caller) nor its own creator
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('a partial-success bulk /patch shares ONE batch_id across every APPLIED record; the skipped (locked) record is excluded entirely', async () => {
    const res = await patchPartial([
      { recordId: REC_A, fieldId: FLD, value: 'a-new' },
      { recordId: REC_B, fieldId: FLD, value: 'b-new' },
      { recordId: REC_LOCKED, fieldId: FLD, value: 'locked-new' },
    ])
    expect(res.status).toBe(200)

    // Applied/skipped split is unchanged by this fix — still exactly A and B applied, LOCKED failed.
    const updatedIds = new Set((res.body.data.updated as Array<{ recordId: string }>).map((u) => u.recordId))
    expect(updatedIds).toEqual(new Set([REC_A, REC_B]))
    expect(res.body.data.failed).toHaveLength(1)
    expect(res.body.data.failed[0]).toMatchObject({ recordId: REC_LOCKED, code: 'FORBIDDEN' })
    // Response shape untouched: partialSuccess never echoes a top-level batchId (LOCK-12 is attribution-only).
    expect(res.body.data.batchId).toBeUndefined()

    // The locked record never wrote anything at all — not merely "excluded from the batch", genuinely absent.
    expect(await revisionFor(REC_LOCKED)).toBeUndefined()
    const lockedRow = await q('SELECT data FROM meta_records WHERE id = $1', [REC_LOCKED])
    expect((lockedRow.rows[0]?.data as Record<string, unknown>)?.[FLD]).toBe('locked-orig')

    // The two APPLIED records share ONE batch_id.
    const [revA, revB] = await Promise.all([revisionFor(REC_A), revisionFor(REC_B)])
    expect(revA?.batch_id).toBeTruthy()
    expect(revB?.batch_id).toBe(revA?.batch_id)
    const batchId = revA!.batch_id as string

    // READ side: loadHistoryBatchDetail (via the history detail route) surfaces exactly the 2 applied
    // records as ONE batch — the locked/skipped record contributes NOTHING to it.
    const detail = await historyDetailReq(batchId)
    expect(detail.status).toBe(200)
    const detailRecordIds = new Set((detail.body.data.changes as Array<{ recordId: string }>).map((c) => c.recordId))
    expect(detailRecordIds).toEqual(new Set([REC_A, REC_B]))
    expect(detailRecordIds.has(REC_LOCKED)).toBe(false)
    expect(detail.body.data.changes).toHaveLength(2)
  })
})
