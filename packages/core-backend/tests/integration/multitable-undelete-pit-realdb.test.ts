/**
 * T8-1 → W0 L8: PIT Revert UNDELETE (resurrection) route contract — exact-anchor fail-closed (real DB).
 *
 * The free wall-clock `asOf` route and the first-delete-after-T vintage heuristic are no longer
 * authoritative. Destructive recovery accepts exactly one of `historyBatchId` / `anchorOperationId`.
 * Exact-anchor resurrection is intentionally CATEGORICALLY fail-closed: at-anchor inbound link state is
 * unprovable, so a resurrect-bearing preview may enumerate `undeleteRecordIds` but must return
 * `executable=false`, `previewIdentity=null`, `undeleteSupported=false`, and
 * `undeleteBlockedReason: INBOUND_UNPROVABLE` (or `UNDELETE_DISABLED` when the legacy flag is off).
 * Execute cannot obtain a token and must make zero writes.
 *
 * Retired route-level success assertions (happy resurrect, outbound rebuild, confirm:'undelete' success,
 * all-or-nothing insert-trigger failures, schema-drift partial resurrect, etc.) no longer have an honest
 * success path on this surface. Lower-level inbound replay / Option A consent remains covered by the
 * direct trash-restore RB matrix in `multitable-undelete-inbound-replay-realdb.test.ts`. Kernel
 * inbound-unprovable apply refusal is covered by unit + L8 route-wiring goldens.
 *
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
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
const BASE = `base_un_${TS}`, SHEET = `sheet_un_${TS}`
const NAME = `fld_un_name_${TS}`, LINK = `fld_un_link_${TS}`
const U = `rec_un_u_${TS}` // existed at anchor, deleted after → resurrect candidate
const L = `rec_un_l_${TS}` // live neighbour (inbound edge holder baseline; not resurrected)
const ACTOR = `user_un_${TS}`
const FLAG = 'MULTITABLE_ENABLE_PIT_UNDELETE'
const T0 = '2026-01-01T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'
const SNAP = { [NAME]: 'u-at-anchor', [LINK]: [L] }

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
let app: Express
let fixture: ExactAnchorHistoryFixture
let curPerms = ['multitable:read', 'multitable:write', 'multitable:share']

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

const liveRow = async (id: string) =>
  (await q('SELECT data, version FROM meta_records WHERE id = $1', [id])).rows[0] as
    | { data: Record<string, unknown>; version: number }
    | undefined
const revCount = async (id: string) =>
  Number(((await q('SELECT count(*)::int AS c FROM meta_record_revisions WHERE record_id = $1', [id])).rows[0] as { c: number }).c)
const inboundEdges = async (id: string) =>
  Number(((await q('SELECT count(*)::int AS c FROM meta_links WHERE foreign_record_id = $1', [id])).rows[0] as { c: number }).c)
const outboundEdges = async (id: string) =>
  Number(((await q('SELECT count(*)::int AS c FROM meta_links WHERE record_id = $1', [id])).rows[0] as { c: number }).c)

async function sheetWriteState() {
  const records = (await q('SELECT id, data, version FROM meta_records WHERE sheet_id = $1 ORDER BY id', [SHEET])).rows
  const revisionCount = Number(((await q('SELECT count(*)::int AS c FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)
  const linkCount = Number(((await q(
    `SELECT count(*)::int AS c FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)`,
    [SHEET],
  )).rows[0] as { c: number }).c)
  const tokenBurnCount = Number(((await q('SELECT count(*)::int AS c FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)
  return { records, revisionCount, linkCount, tokenBurnCount }
}

async function seed(): Promise<void> {
  // U: create before anchor, delete after → present at anchor, gone now → resurrect candidate.
  await fixture.insertRevision({
    recordId: U, version: 1, action: 'create', snapshot: SNAP, createdAt: T0, phase: 'before',
    changedFieldIds: [NAME, LINK],
  })
  // Anchor on a LIVE neighbour so resolve has a real sealed endpoint (U itself is deleted).
  await fixture.insertRevision({
    recordId: L, version: 1, action: 'create', snapshot: { [NAME]: 'L', [LINK]: [U] }, createdAt: T0, phase: 'anchor',
    changedFieldIds: [NAME, LINK],
  })
  // Delete reuses the last live version (contiguity: delete never occupies a data version).
  await fixture.insertRevision({
    recordId: U, version: 1, action: 'delete', snapshot: SNAP, createdAt: T2, phase: 'after',
    changedFieldIds: [NAME, LINK],
  })
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
    L, SHEET, JSON.stringify({ [NAME]: 'L', [LINK]: [U] }),
  ])
}

describeIfDatabase('multitable T8-1 PIT undelete — exact-anchor fail-closed (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as { user?: unknown }).user = { id: ACTOR, roles: ['member'], perms: curPerms }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'UN Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'UN Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [LINK, SHEET, 'Link', 'link', JSON.stringify({ foreignSheetId: SHEET }), 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    delete process.env[FLAG]
    await pruneSealedHistoryOperations(SHEET).catch(() => {})
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
    curPerms = ['multitable:read', 'multitable:write', 'multitable:share']
    enableTrust()
    delete process.env[FLAG]
    await pruneSealedHistoryOperations(SHEET).catch(() => {})
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

  test('wall-clock asOf is refused EXACT_ANCHOR_REQUIRED with zero writes (preview + execute)', async () => {
    process.env[FLAG] = 'true'
    const before = await sheetWriteState()
    const pv = await previewWallClock('2026-01-02T00:00:00.000Z')
    expect(pv.status).toBe(400)
    expect(pv.body?.error?.code).toBe('EXACT_ANCHOR_REQUIRED')
    expect(pv.body?.data?.previewIdentity).toBeUndefined()

    const ex = await execute({
      asOf: '2026-01-02T00:00:00.000Z',
      previewIdentity: 'dummy-never-minted',
      confirm: 'undelete',
    })
    // The nonblank wall-clock authority is rejected before token verification.
    expect(ex.status).toBe(400)
    expect(ex.body?.error?.code).toBe('EXACT_ANCHOR_REQUIRED')
    expect(await sheetWriteState()).toEqual(before)
    expect(await liveRow(U)).toBeUndefined()
  })

  test('exact-anchor doomed resurrect preview: enumerates U, never promises undelete (flag OFF → UNDELETE_DISABLED)', async () => {
    delete process.env[FLAG]
    const pv = await previewExact()
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.undeleteRecordIds).toEqual([U])
    expect(pv.body?.data?.summary?.visibleUndeleteCount ?? pv.body?.data?.summary?.resurrectCount).toBe(1)
    expect(pv.body?.data?.undeleteSupported).toBe(false)
    expect(pv.body?.data?.undeleteBlockedReason).toBe('UNDELETE_DISABLED')
    expect(pv.body?.data?.executable).toBe(false)
    expect(pv.body?.data?.previewIdentity).toBeNull()
  })

  test('exact-anchor doomed resurrect preview: flag ON still fail-closed with INBOUND_UNPROVABLE', async () => {
    process.env[FLAG] = 'true'
    const pv = await previewExact()
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.undeleteRecordIds).toEqual([U])
    expect(pv.body?.data?.undeleteSupported).toBe(false)
    expect(pv.body?.data?.undeleteBlockedReason).toBe('INBOUND_UNPROVABLE')
    expect(pv.body?.data?.executable).toBe(false)
    expect(pv.body?.data?.previewIdentity).toBeNull()
  })

  test('execute cannot obtain a token and makes zero writes (missing identity + forged token + confirm:undelete)', async () => {
    process.env[FLAG] = 'true'
    const before = await sheetWriteState()
    const pv = await previewExact()
    expect(pv.body?.data?.previewIdentity).toBeNull()

    const noToken = await execute({ confirm: 'undelete' })
    expect(noToken.status).toBe(400)
    expect(noToken.body?.error?.code).toBe('VALIDATION_ERROR')

    const forged = await execute({
      previewIdentity: 'forged.token.value',
      confirm: 'undelete',
    })
    expect(forged.status).toBe(409)
    expect(forged.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID')

    expect(await sheetWriteState()).toEqual(before)
    expect(await liveRow(U)).toBeUndefined()
    expect(await revCount(U)).toBe(2) // create + delete only
    expect(await inboundEdges(U)).toBe(0)
    expect(await outboundEdges(U)).toBe(0)
  })
})
