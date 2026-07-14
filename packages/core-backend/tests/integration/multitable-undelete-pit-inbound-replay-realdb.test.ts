/**
 * 4c-3 §7 — PIT-resurrect INBOUND replay goldens (review P3-2 / O-2 precondition, real DB).
 *
 * PR #3975's adversarial review approved the line but flagged one uncovered seam: the resurrect
 * surface reuses the SHARED replay helper (tested by the RB matrix), yet its resurrect-specific
 * ANCHOR-SELECTION query (latest delete revision for the record, univer-meta revert-execute path)
 * had no golden — it could be neutered with all 12 RB goldens staying green. These three goldens +
 * the recorded mutation close that hole, and are a named precondition for enabling
 * MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND in the O-2 operator ladder.
 *
 * Harness mirrors multitable-undelete-pit-realdb.test.ts (revision-seeded PIT undelete via
 * revert-preview → revert-execute confirm:'undelete'), with one addition: the delete revision id is
 * FIXED so inbound tombstones can be seeded anchored to it — exactly the shape
 * record-service.deleteRecord's capture writes (reason='record_delete', source_revision_id = the
 * delete revision's own id).
 */
import express, { type Express } from 'express'
import { randomUUID } from 'crypto'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_uir_${TS}`, SHEET = `sheet_uir_${TS}`
const NAME = `fld_uir_name_${TS}`, LINK = `fld_uir_link_${TS}`
const U = `rec_uir_u_${TS}` // deleted record → undelete target
const L = `rec_uir_l_${TS}` // LIVE neighbour whose data still declares U (inbound edge holder)
const ACTOR = `user_uir_${TS}`
const UNDELETE_FLAG = 'MULTITABLE_ENABLE_PIT_UNDELETE'
const INBOUND_FLAG = 'MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND'
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-02T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'
const SNAP = { [NAME]: 'u-at-T1' } // no outbound links — this suite is about INBOUND only

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let deleteRevisionId = ''

const preview = (asOf: string) => request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({ asOf })
const execute = (asOf: string, previewIdentity: string) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/revert-execute`).send({ asOf, previewIdentity, confirm: 'undelete' })
const inboundEdge = async () =>
  (await q('SELECT 1 FROM meta_links WHERE field_id=$1 AND record_id=$2 AND foreign_record_id=$3', [LINK, L, U])).rows.length

async function runUndelete(): Promise<{ status: number; body: Record<string, any> }> {
  const pv = await preview(T1)
  expect(pv.status).toBe(200)
  const res = await execute(T1, pv.body?.data?.previewIdentity)
  return { status: res.status, body: res.body }
}

async function seed(): Promise<void> {
  deleteRevisionId = randomUUID()
  await q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,1,'create','rest',ARRAY[$3]::text[],'{}'::jsonb,$4::jsonb,$5)`,
    [SHEET, U, NAME, JSON.stringify(SNAP), T0],
  )
  // The delete revision with a KNOWN id — the resurrect anchor query must find THIS row.
  await q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES ($6::uuid,$1,$2,2,'delete','rest',ARRAY[$3]::text[],'{}'::jsonb,$4::jsonb,$5)`,
    [SHEET, U, NAME, JSON.stringify(SNAP), T2, deleteRevisionId],
  )
  // Live neighbour still declaring U in its link cell (Option A consent holds).
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
    L, SHEET, JSON.stringify({ [NAME]: 'L', [LINK]: [U] }),
  ])
  // D-1c §0.6 fixture repair: L must be CAPTURE-COMPLETE (a create revision matching its live row) —
  // otherwise the sheet-wide precheck sees a live record with zero revisions (the uncaptured-CREATE
  // fingerprint) and correctly refuses every preview/execute in this suite before the resurrect-inbound
  // logic under test ever runs. Fixture fix, not a §0.6 weakening.
  await q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,1,'create','rest',ARRAY[$3,$4]::text[],'{}'::jsonb,$5::jsonb,$6)`,
    [SHEET, L, NAME, LINK, JSON.stringify({ [NAME]: 'L', [LINK]: [U] }), T0],
  )
  // The inbound tombstone exactly as record-service.deleteRecord's capture writes it.
  await q(
    `INSERT INTO meta_link_tombstones (id, sheet_id, field_id, record_id, foreign_record_id, reason, source_revision_id, created_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'record_delete',$5::uuid,$6)`,
    [SHEET, LINK, L, U, deleteRevisionId, T2],
  )
}

describeIfDatabase('4c-3 §7 — PIT-resurrect inbound replay (real DB, P3-2 goldens)', () => {
  beforeAll(async () => {
    process.env.MULTITABLE_ENABLE_PIT_REVERT = 'true' // W0 step-1: this file drives revert-execute; the gate is default-OFF, set per-file here and FORCED BACK to the default OFF (delete) in afterAll — never a saved/original value, and NEVER enabled globally.
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'UIR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'UIR Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [LINK, SHEET, 'Link', 'link', JSON.stringify({ foreignSheetId: SHEET }), 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_PIT_REVERT // W0 step-1: restore — never leak the revert gate into sibling files' negative controls.
    await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [SHEET]).catch(() => {})
    for (const t of ['meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })
  beforeEach(async () => {
    process.env[UNDELETE_FLAG] = 'true'
    await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [SHEET])
    for (const t of ['meta_record_revisions', 'meta_records']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET])
    await seed()
  })
  afterEach(() => {
    delete process.env[UNDELETE_FLAG]
    delete process.env[INBOUND_FLAG]
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('P3-2a flag OFF: resurrect does NOT replay inbound and the response carries no undeleteInbound (byte-identical)', async () => {
    const { status, body } = await runUndelete()
    expect(status).toBe(200)
    expect(body?.data?.undeleteRecordIds).toEqual([U])
    expect(body?.data?.undeleteInbound).toBeUndefined()
    expect(await inboundEdge()).toBe(0) // pre-4c-3 behavior preserved
  })

  test('P3-2b flag ON: resurrect anchors to the record\'s latest delete revision and replays the inbound edge', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const { status, body } = await runUndelete()
    expect(status).toBe(200)
    expect(body?.data?.undeleteRecordIds).toEqual([U])
    // The anchor-selection query (the P3-2 uncovered seam) found the delete revision, and the
    // shared helper replayed the tombstoned edge.
    expect(body?.data?.undeleteInbound).toMatchObject({ replayed: 1, total: 1 })
    expect(await inboundEdge()).toBe(1)
  })

  test('P3-2c flag ON + neighbour declined: Option A consent holds on the resurrect surface too', async () => {
    process.env[INBOUND_FLAG] = 'true'
    // D-1c §0.6 fixture repair: the decline must be CAPTURED (version bump + a matching update revision,
    // timestamped BEFORE the revert's asOf so it is L's T1-target too) — otherwise the sheet-wide precheck
    // would refuse the whole revert/undelete for the WRONG reason (content-mismatch) before this test's own
    // mechanism (Option A consent — the neighbour's live data no longer references U) is ever exercised.
    await q(`UPDATE meta_records SET data = jsonb_set(data, $2, '[]'::jsonb), version = version + 1 WHERE id = $1`, [L, `{${LINK}}`])
    await q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
       VALUES (gen_random_uuid(),$1,$2,2,'update','rest',ARRAY[$3]::text[],'{}'::jsonb,$4::jsonb,$5)`,
      [SHEET, L, LINK, JSON.stringify({ [NAME]: 'L', [LINK]: [] }), '2026-01-01T12:00:00.000Z'],
    )
    const { status, body } = await runUndelete()
    expect(status).toBe(200)
    expect(body?.data?.undeleteInbound).toMatchObject({ replayed: 0, total: 1 })
    expect(await inboundEdge()).toBe(0)
  })
})
