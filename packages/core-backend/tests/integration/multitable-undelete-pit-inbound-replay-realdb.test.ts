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
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-02T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z', T3 = '2026-01-04T00:00:00.000Z'
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
  // L needs a matching create revision — D-1c §0.6's HISTORY_INCOMPLETE precheck (shared by revert-preview/
  // execute) refuses the WHOLE sheet if any live record has zero revisions; L is scaffolding here, not the
  // record under test, so it must be a HEALTHY record like any real live row. Timestamped AFTER T1 (not T0)
  // so L stays OUTSIDE the T1 revert/undelete scope (created-after-T, per the ORIGINAL fixture's intent —
  // L is a bystander neighbour, not itself a revert target); a T0 timestamp would make L's T1-target =
  // {LINK:[U]} and a real field-revert would rewrite L's link back to [U] on execute, confounding P3-2c's
  // decline scenario below with an unrelated field-revert.
  await q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,1,'create','rest',ARRAY[$3,$4]::text[],'{}'::jsonb,$5::jsonb,$6)`,
    [SHEET, L, NAME, LINK, JSON.stringify({ [NAME]: 'L', [LINK]: [U] }), T2],
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
    // A HEALTHY captured edit (version bump + matching revision, timestamped after L's T2 create so it stays
    // OUTSIDE the T1 revert scope just like the create) — an uncaptured one here would instead trip D-1c
    // §0.6's HISTORY_INCOMPLETE precheck before this golden's actual Option A consent property ever runs.
    await q(`UPDATE meta_records SET data = jsonb_set(data, $2, '[]'::jsonb), version = version + 1 WHERE id = $1`, [L, `{${LINK}}`])
    await q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
       VALUES (gen_random_uuid(),$1,$2,2,'update','rest',ARRAY[$3]::text[],'{}'::jsonb,$4::jsonb,$5)`,
      [SHEET, L, LINK, JSON.stringify({ [NAME]: 'L', [LINK]: [] }), T3],
    )
    const { status, body } = await runUndelete()
    expect(status).toBe(200)
    expect(body?.data?.undeleteInbound).toMatchObject({ replayed: 0, total: 1 })
    expect(await inboundEdge()).toBe(0)
  })
})
