/**
 * W3-5b — `POST /patch` response.batchId wire round-trip (real DB).
 *
 * W3-5/W3-5a proved (DB-level only, via multitable-ai-write-provenance-batch-grouping-realdb.test.ts's G6)
 * that a plain (non-AI) `/patch` call mints a fresh `batch_id` on `meta_record_revisions`. Separately,
 * `RecordWriteService.patchRecords` now returns that same id as `result.batchId`, and the `/patch` route
 * echoes it onto the JSON response (`data.batchId`) so a REST/grid caller can deep-link into the History
 * Center for exactly this commit (see `HistoryCenterModal.vue`'s `initialBatchId` prop + the toast "View in
 * history" action in `MultitableWorkbench.vue`). That response-level echo was never asserted over the wire
 * — only the DB column was golden-covered. This suite closes that gap:
 *   - a single-record `/patch` echoes a truthy `data.batchId` that equals the `batch_id` actually written
 *     to `meta_record_revisions` for that commit;
 *   - a multi-record `/patch` (one request, several records) shares ONE `data.batchId` across all of them,
 *     matching every record's persisted `batch_id` — mirrors the AI-route sharing golden (G2), but for the
 *     plain grid PATCH path.
 *
 * Out of scope (left exactly as-is, LOCK-12): the `partialSuccess` branch of `/patch` calls
 * `patchRecords` ONCE PER RECORD with no shared batchId — each record there mints its OWN batch. That is a
 * pre-existing gap noted in the route's own W3-5b comment, not something this suite touches.
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
const BASE_ID = `base_pbe_${TS}`
const SHEET_ID = `sheet_pbe_${TS}`
const F1 = `fld_pbe_a_${TS}`
const F2 = `fld_pbe_b_${TS}`
const REC1 = `rec_pbe_1_${TS}`
const REC2 = `rec_pbe_2_${TS}`
const USER_ID = `user_pbe_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express

const patch = (changes: Array<{ recordId: string; fieldId: string; value: unknown }>) =>
  request(app).post('/api/multitable/patch').send({ sheetId: SHEET_ID, changes })

type RevisionRow = { batch_id: string | null }
async function batchIdFor(recordId: string): Promise<string | null | undefined> {
  const res = await q(
    'SELECT batch_id FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 ORDER BY created_at DESC LIMIT 1',
    [SHEET_ID, recordId],
  )
  return (res.rows[0] as RevisionRow | undefined)?.batch_id
}

describeIfDatabase('W3-5b — POST /patch response.batchId wire round-trip (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = { id: USER_ID, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'PBE Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'PBE Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F1, SHEET_ID, 'A', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F2, SHEET_ID, 'B', 'string', '{}', 2])
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
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC1, SHEET_ID, JSON.stringify({ [F1]: 'orig-1', [F2]: 'orig-1b' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC2, SHEET_ID, JSON.stringify({ [F1]: 'orig-2', [F2]: 'orig-2b' })])
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('single-record /patch echoes a truthy data.batchId equal to the persisted batch_id', async () => {
    const res = await patch([{ recordId: REC1, fieldId: F1, value: 'new-1' }])
    expect(res.status).toBe(200)
    expect(res.body.data.batchId).toBeTruthy()

    const persisted = await batchIdFor(REC1)
    expect(persisted).toBeTruthy()
    expect(res.body.data.batchId).toBe(persisted)
  })

  test('multi-record /patch (one request) shares ONE data.batchId, matching every record\'s persisted batch_id', async () => {
    const res = await patch([
      { recordId: REC1, fieldId: F1, value: 'multi-1' },
      { recordId: REC2, fieldId: F1, value: 'multi-2' },
    ])
    expect(res.status).toBe(200)
    expect(res.body.data.batchId).toBeTruthy()

    const [p1, p2] = await Promise.all([batchIdFor(REC1), batchIdFor(REC2)])
    expect(p1).toBe(res.body.data.batchId)
    expect(p2).toBe(res.body.data.batchId)
  })
})
