/**
 * 4c-3 §7 — PIT-resurrect INBOUND replay route contract → exact-anchor fail-closed (real DB).
 *
 * Historical P3-2 goldens proved that the obsolete wall-clock PIT-undelete path selected a delete
 * revision anchor and replayed `meta_link_tombstones` under MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND.
 * That route success path is gone: exact-anchor resurrection is categorically fail-closed
 * (INBOUND_UNPROVABLE) because at-anchor inbound link state is unprovable.
 *
 * This suite pins the ROUTE seam only:
 *   - with tombstones + inbound flag ON + PIT_UNDELETE ON, exact-anchor preview still discloses the
 *     resurrect set but mints no token (`executable=false`, `previewIdentity=null`,
 *     `undeleteSupported=false`, `undeleteBlockedReason=INBOUND_UNPROVABLE`);
 *   - execute cannot obtain a token and writes zero rows / zero inbound edges;
 *   - free wall-clock `asOf` is refused EXACT_ANCHOR_REQUIRED with zero writes.
 *
 * Lower-level tombstone capture, Option A neighbour consent, and inbound replay mechanics remain in the
 * direct trash-restore RB matrix: `multitable-undelete-inbound-replay-realdb.test.ts` (RB1–RB16) and the
 * shared helper unit coverage — NOT retired here.
 *
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import { randomUUID } from 'crypto'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import {
  prepareExactAnchorHistoryFixture,
  pruneSealedHistoryOperations,
  type ExactAnchorHistoryFixture,
} from '../utils/exact-anchor-history-fixture'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_uir_${TS}`, SHEET = `sheet_uir_${TS}`
const NAME = `fld_uir_name_${TS}`, LINK = `fld_uir_link_${TS}`
const U = `rec_uir_u_${TS}` // deleted record → undelete target
const L = `rec_uir_l_${TS}` // LIVE neighbour whose data still declares U (inbound edge holder)
const ACTOR = `user_uir_${TS}`
const UNDELETE_FLAG = 'MULTITABLE_ENABLE_PIT_UNDELETE'
const INBOUND_FLAG = 'MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND'
const T0 = '2026-01-01T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'
const SNAP = { [NAME]: 'u-at-anchor' } // no outbound links — this suite is about INBOUND only

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
let app: Express
let fixture: ExactAnchorHistoryFixture
let deleteRevisionId = ''

const enableTrust = () => {
  process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
  process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
  process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
}

const previewWallClock = (asOf: string) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({ asOf })
const previewExact = () =>
  request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({
    anchorOperationId: fixture.anchorOperationId(),
  })
const execute = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/revert-execute`).send(body)

const inboundEdge = async () =>
  (await q('SELECT 1 FROM meta_links WHERE field_id=$1 AND record_id=$2 AND foreign_record_id=$3', [LINK, L, U])).rows.length

async function sheetWriteState() {
  const records = (await q('SELECT id, data, version FROM meta_records WHERE sheet_id = $1 ORDER BY id', [SHEET])).rows
  const revisionCount = Number(((await q('SELECT count(*)::int AS c FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)
  const tombstoneCount = Number(((await q('SELECT count(*)::int AS c FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)
  const linkCount = Number(((await q(
    `SELECT count(*)::int AS c FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)`,
    [SHEET],
  )).rows[0] as { c: number }).c)
  return { records, revisionCount, tombstoneCount, linkCount, inbound: await inboundEdge() }
}

async function seed(): Promise<void> {
  deleteRevisionId = randomUUID()
  // U present before anchor, deleted after.
  await fixture.insertRevision({
    recordId: U, version: 1, action: 'create', snapshot: SNAP, createdAt: T0, phase: 'before',
    changedFieldIds: [NAME],
  })
  // Anchor on live neighbour L (U has no live row).
  await fixture.insertRevision({
    recordId: L, version: 1, action: 'create', snapshot: { [NAME]: 'L', [LINK]: [U] }, createdAt: T0, phase: 'anchor',
    changedFieldIds: [NAME, LINK],
  })
  // Delete revision with a KNOWN id so a tombstone can anchor to it (same shape record-service writes).
  // Version reuses the last live version (contiguity: delete never occupies a data version).
  // One transaction with the same order as prepareExactAnchorHistoryFixture (event then sealed
  // endpoint; fk_mrr_operation is DEFERRABLE so the pair only needs to commit cleanly).
  const delOpId = randomUUID()
  const delSeq = String((await q("SELECT nextval('meta_record_chain_seq')::text AS seq")).rows[0].seq)
  await poolManager.get().transaction(async ({ query: run }) => {
    await run(
      `INSERT INTO meta_record_revisions
         (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at, seq, operation_id, batch_id)
       VALUES ($1::uuid,$2,$3,1,'delete','rest',ARRAY[$4]::text[],'{}'::jsonb,$5::jsonb,$6,
               $7::bigint, $8::uuid, $9)`,
      [deleteRevisionId, SHEET, U, NAME, JSON.stringify(SNAP), T2, delSeq, delOpId, `batch_del_${TS}`],
    )
    await run(
      `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
       VALUES ($1,$2::uuid,$3::bigint,1)`,
      [SHEET, delOpId, delSeq],
    )
  })
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
    L, SHEET, JSON.stringify({ [NAME]: 'L', [LINK]: [U] }),
  ])
  // Inbound tombstone exactly as record-service.deleteRecord's capture writes it.
  await q(
    `INSERT INTO meta_link_tombstones (id, sheet_id, field_id, record_id, foreign_record_id, reason, source_revision_id, created_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'record_delete',$5::uuid,$6)`,
    [SHEET, LINK, L, U, deleteRevisionId, T2],
  )
}

describeIfDatabase('4c-3 §7 — PIT-resurrect inbound replay route is fail-closed (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as { user?: unknown }).user = {
        id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'],
      }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'UIR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'UIR Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [LINK, SHEET, 'Link', 'link', JSON.stringify({ foreignSheetId: SHEET }), 2])
    await q(
      "INSERT INTO users (id, password_hash, permissions) VALUES ($1,'x',$2::jsonb) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions, is_active = TRUE",
      [ACTOR, JSON.stringify(['multitable:read', 'multitable:write', 'multitable:share'])],
    )
  })
  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    delete process.env[UNDELETE_FLAG]
    delete process.env[INBOUND_FLAG]
    await pruneSealedHistoryOperations(SHEET).catch(() => {})
    await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [SHEET]).catch(() => {})
    for (const t of [
      'meta_history_baselines',
      'meta_history_trust_checkpoints',
      'meta_recovery_token_burns',
      'meta_record_version_markers',
      'meta_records_trash',
      'meta_record_revisions',
      'meta_records',
      'meta_fields',
    ]) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })
  beforeEach(async () => {
    enableTrust()
    process.env[UNDELETE_FLAG] = 'true'
    process.env[INBOUND_FLAG] = 'true'
    await pruneSealedHistoryOperations(SHEET).catch(() => {})
    await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [SHEET])
    for (const t of [
      'meta_history_baselines',
      'meta_history_trust_checkpoints',
      'meta_recovery_token_burns',
      'meta_record_version_markers',
      'meta_records_trash',
      'meta_record_revisions',
      'meta_records',
    ]) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    fixture = await prepareExactAnchorHistoryFixture(SHEET)
    await seed()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('tombstones + inbound flag ON: exact-anchor preview discloses resurrect set but is non-executable (INBOUND_UNPROVABLE)', async () => {
    const before = await sheetWriteState()
    expect(before.inbound).toBe(0)
    expect(before.tombstoneCount).toBe(1)

    const pv = await previewExact()
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.undeleteRecordIds).toEqual([U])
    expect(pv.body?.data?.undeleteSupported).toBe(false)
    expect(pv.body?.data?.undeleteBlockedReason).toBe('INBOUND_UNPROVABLE')
    expect(pv.body?.data?.executable).toBe(false)
    expect(pv.body?.data?.previewIdentity).toBeNull()
    // Preview is read-only — tombstones stay, inbound edge not materialised.
    expect(await sheetWriteState()).toEqual(before)
  })

  test('execute cannot mint/use a token; inbound edge stays unreplayed (zero writes)', async () => {
    const before = await sheetWriteState()
    const pv = await previewExact()
    expect(pv.body?.data?.previewIdentity).toBeNull()

    const noToken = await execute({ confirm: 'undelete' })
    expect(noToken.status).toBe(400)
    expect(noToken.body?.error?.code).toBe('VALIDATION_ERROR')

    const forged = await execute({ previewIdentity: 'forged.token.value', confirm: 'undelete' })
    expect(forged.status).toBe(409)
    expect(forged.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID')

    expect(await sheetWriteState()).toEqual(before)
    expect(await inboundEdge()).toBe(0)
  })

  test('wall-clock asOf is refused EXACT_ANCHOR_REQUIRED; tombstone path never runs', async () => {
    const before = await sheetWriteState()
    const pv = await previewWallClock('2026-01-02T00:00:00.000Z')
    expect(pv.status).toBe(400)
    expect(pv.body?.error?.code).toBe('EXACT_ANCHOR_REQUIRED')
    const ex = await execute({
      asOf: '2026-01-02T00:00:00.000Z',
      previewIdentity: 'dummy-never-minted',
      confirm: 'undelete',
    })
    expect(ex.status).toBe(400)
    expect(ex.body?.error?.code).toBe('EXACT_ANCHOR_REQUIRED')
    expect(await sheetWriteState()).toEqual(before)
    expect(await inboundEdge()).toBe(0)
  })
})
