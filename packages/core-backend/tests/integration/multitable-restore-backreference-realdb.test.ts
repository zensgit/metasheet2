/**
 * R11 restore back-reference (OD-0=(a)) — `meta_record_revisions.restored_from_version` (real DB).
 *
 * A `source='restore'` record-version restore now records the SOURCE version it restored from, so the
 * History Center can render "restored from version N". Only the THREE record-version restore routes
 * (record-restore-execute, restore-batch-execute, legacy /restore) populate it — every OTHER write, INCLUDING
 * the non-version-restore `source='restore'` emitters (PIT-resurrect action='create', PIT-reset,
 * lossy-retype-revert), leaves it NULL. The FE badge keys on NON-NULL, never on `source='restore'`.
 *
 * Goldens:
 *   G1  legacy /restore (one of the three routes) end-to-end: the restore revision carries
 *       restored_from_version = targetVersion. Mutation: dropping the route/patchRecords threading ⇒ NULL ⇒ red.
 *   G1b recordRecordRevision write primitive (the seam all three routes share): restoredFromVersion=N ⇒ column=N.
 *   G2  NULL by design: a plain update; a `source='restore' action='create'` write (PIT-resurrect shape) with
 *       no restoredFromVersion; a `source='restore' action='delete'` write (PIT-reset shape) — all NULL.
 *   G3  projection: batch detail surfaces `restoredFromVersion` for the restore batch, null for others.
 *
 * Runs only with DATABASE_URL. (plugin-tests.yml whitelist.)
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { recordRecordRevision } from '../../src/multitable/record-history-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_rbr_${TS}`
const SHEET_ID = `sheet_rbr_${TS}`
const FLD = `fld_rbr_${TS}`
const USER_ID = `user_rbr_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express

const restoreReq = (recordId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/records/${recordId}/restore`).send(body)
const batchDetail = (batchId: string) => request(app).get(`/api/multitable/bases/${BASE_ID}/history/events/${batchId}`)

const restoredFromOf = async (recordId: string, version: number): Promise<number | null> => {
  const r = (await q('SELECT restored_from_version FROM meta_record_revisions WHERE record_id=$1 AND version=$2', [recordId, version])).rows[0] as { restored_from_version: number | null } | undefined
  return r ? r.restored_from_version : null
}
const seedRev = (recordId: string, version: number, action: string, snapshot: Record<string, unknown>) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'rest', $5, ARRAY[$6]::text[], '{}'::jsonb, $7::jsonb)`,
    [SHEET_ID, recordId, version, action, USER_ID, FLD, JSON.stringify(snapshot)],
  )

describeIfDatabase('R11 restore back-reference — restored_from_version (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: USER_ID, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [USER_ID])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'RBR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'RBR Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD, SHEET_ID, 'Val', 'string', '{}', 1])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [USER_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('G1 legacy /restore end-to-end: the restore revision carries restored_from_version = targetVersion', async () => {
    const rid = `rec_rbr_g1_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [rid, SHEET_ID, JSON.stringify({ [FLD]: 'v2' })])
    await seedRev(rid, 1, 'create', { [FLD]: 'v1' })
    await seedRev(rid, 2, 'update', { [FLD]: 'v2' })

    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    const newVersion = res.body?.data?.newVersion as number
    expect(newVersion).toBeGreaterThan(2)
    // the new restore revision points back at the source version 1
    expect(await restoredFromOf(rid, newVersion)).toBe(1)
    // the pre-existing non-restore revisions stay NULL
    expect(await restoredFromOf(rid, 1)).toBeNull()
    expect(await restoredFromOf(rid, 2)).toBeNull()
  })

  test('G1b recordRecordRevision seam: restoredFromVersion=N writes the column; the three routes all share this primitive', async () => {
    const rid = `rec_rbr_g1b_${TS}`
    await recordRecordRevision(poolManager.get().query.bind(poolManager.get()), {
      sheetId: SHEET_ID, recordId: rid, version: 9, action: 'update', source: 'restore', restoredFromVersion: 7, actorId: USER_ID, changedFieldIds: [FLD], patch: { [FLD]: 'x' }, snapshot: { [FLD]: 'x' },
    })
    expect(await restoredFromOf(rid, 9)).toBe(7)
  })

  test('G2 NULL by design: plain update, PIT-resurrect (create/source=restore/no version), PIT-reset (delete/source=restore) all NULL', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    const rid = `rec_rbr_g2_${TS}`
    // plain (non-restore) update
    await recordRecordRevision(query, { sheetId: SHEET_ID, recordId: rid, version: 1, action: 'update', source: 'rest', actorId: USER_ID, changedFieldIds: [FLD], patch: { [FLD]: 'a' }, snapshot: { [FLD]: 'a' } })
    // PIT-resurrect shape: source='restore', action='create', NO restoredFromVersion (T-snapshot, no source version)
    await recordRecordRevision(query, { sheetId: SHEET_ID, recordId: rid, version: 2, action: 'create', source: 'restore', actorId: USER_ID, changedFieldIds: [FLD], patch: { [FLD]: 'r' }, snapshot: { [FLD]: 'r' } })
    // PIT-reset shape: source='restore', action='delete', NO restoredFromVersion (time-based reset)
    await recordRecordRevision(query, { sheetId: SHEET_ID, recordId: rid, version: 3, action: 'delete', source: 'restore', actorId: USER_ID, changedFieldIds: [], patch: {}, snapshot: { [FLD]: 'r' } })
    expect(await restoredFromOf(rid, 1)).toBeNull() // plain
    expect(await restoredFromOf(rid, 2)).toBeNull() // resurrect create — NULL by design (badge renders nothing)
    expect(await restoredFromOf(rid, 3)).toBeNull() // reset delete — NULL by design
  })

  test('G3 projection: batch detail surfaces restoredFromVersion on the restore change, null elsewhere', async () => {
    const rid = `rec_rbr_g3_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [rid, SHEET_ID, JSON.stringify({ [FLD]: 'v2' })])
    await seedRev(rid, 1, 'create', { [FLD]: 'v1' })
    await seedRev(rid, 2, 'update', { [FLD]: 'v2' })
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    const newVersion = res.body?.data?.newVersion as number
    const batchId = (await q('SELECT batch_id FROM meta_record_revisions WHERE record_id=$1 AND version=$2', [rid, newVersion])).rows[0]?.batch_id as string
    expect(batchId).toBeTruthy()

    const detail = await batchDetail(batchId)
    expect(detail.status).toBe(200)
    const change = (detail.body?.data?.changes ?? []).find((c: any) => c.recordId === rid)
    expect(change).toBeTruthy()
    expect(change.restoredFromVersion).toBe(1)
  })
})
