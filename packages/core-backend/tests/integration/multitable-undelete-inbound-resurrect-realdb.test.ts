/**
 * 4c-3 §7 — PIT-resurrect multi-vintage / first-delete-after-T heuristic → exact-anchor fail-closed (real DB).
 *
 * Historical goldens (A–F) exercised the obsolete wall-clock resurrect path whose anchor was the FIRST
 * 'delete' revision strictly AFTER free `asOf` T (R11 A′ / vintage-EXACT). That heuristic is no longer
 * authoritative: destructive recovery accepts exact `historyBatchId` / `anchorOperationId` only, and
 * exact-anchor resurrection is categorically fail-closed (INBOUND_UNPROVABLE) because at-anchor inbound
 * link state is unprovable.
 *
 * This suite retires the multi-vintage success matrix in favour of a small honest contract:
 *   - free wall-clock is refused EXACT_ANCHOR_REQUIRED (zero writes);
 *   - multi-vintage history under an exact anchor still discloses a resurrect candidate but never mints
 *     an executable token (`executable=false`, `previewIdentity=null`, `undeleteSupported=false`,
 *     `undeleteBlockedReason=INBOUND_UNPROVABLE`);
 *   - execute cannot obtain a token; zero record / link / tombstone side-effects.
 *
 * Lower-level inbound replay, Option A neighbour consent, uncaptured-delete silent-zero, and
 * same-millisecond anchor tiebreaks that are NOT route-specific live in:
 *   - `multitable-undelete-inbound-replay-realdb.test.ts` (direct trash-restore RB matrix)
 *   - shared `inbound-link-replay` unit coverage
 * The first-delete-after-T vintage selection itself has no remaining production caller and is not
 * re-proven as a success path.
 *
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import { randomUUID } from 'node:crypto'
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
const BASE = `base_rvi_${TS}`
const SHEET_A = `sheet_rvi_a_${TS}` // resurrect target's sheet
const SHEET_B = `sheet_rvi_b_${TS}` // neighbours' sheet (owns link field F)
const NAME = `fld_rvi_name_${TS}`
const ACTOR = `user_rvi_${TS}`
const UNDELETE_FLAG = 'MULTITABLE_ENABLE_PIT_UNDELETE'
const INBOUND_FLAG = 'MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND'
const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-02T00:00:00.000Z'
const T1_5 = '2026-01-02T12:00:00.000Z'
const T2 = '2026-01-03T00:00:00.000Z'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let fixture: ExactAnchorHistoryFixture
let seq = 0
const mkFieldId = (tag: string) => `fld_rvi_${tag}_${TS}_${seq++}`
const mkRecordId = (tag: string) => `rec_rvi_${tag}_${TS}_${seq++}`

const enableTrust = () => {
  process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
  process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
  process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
}

const previewWallClock = (asOf: string) =>
  request(app).post(`/api/multitable/sheets/${SHEET_A}/revert-preview`).send({ asOf })
const previewExact = () =>
  request(app).post(`/api/multitable/sheets/${SHEET_A}/revert-preview`).send({
    anchorOperationId: fixture.anchorOperationId(),
  })
const execute = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_A}/revert-execute`).send(body)

const liveRow = async (id: string) =>
  (await q('SELECT data, version FROM meta_records WHERE id = $1', [id])).rows[0] as
    | { data: Record<string, unknown>; version: number }
    | undefined
const edgeCount = async (fieldId: string, recordId: string, foreignId: string): Promise<number> =>
  (await q('SELECT 1 FROM meta_links WHERE field_id=$1 AND record_id=$2 AND foreign_record_id=$3', [fieldId, recordId, foreignId])).rows.length

async function insertField(sheetId: string, fieldId: string, type = 'link', property = '{}'): Promise<void> {
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
    fieldId, sheetId, fieldId, type, property, seq,
  ])
}
async function insertRecord(sheetId: string, recordId: string, data: Record<string, unknown>): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recordId, sheetId, JSON.stringify(data)])
}

/** Insert a sealed revision; when `anchor` is true, this becomes the sheet's exact recovery anchor. */
async function rev(
  sheetId: string,
  id: string,
  version: number,
  action: 'create' | 'update' | 'delete',
  snap: Record<string, unknown>,
  at: string,
  options?: { anchor?: boolean; phase?: 'before' | 'anchor' | 'after' },
): Promise<string> {
  if (sheetId === SHEET_A) {
    return fixture.insertRevision({
      recordId: id,
      version,
      action,
      snapshot: snap,
      createdAt: at,
      phase: options?.phase ?? (options?.anchor ? 'anchor' : at === T0 ? 'before' : 'after'),
      changedFieldIds: [NAME],
    })
  }
  // Neighbour sheet is not under the exact-anchor fixture; seed a capture-complete revision only.
  const revId = randomUUID()
  await q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES ($1,$2,$3,$4,$5,'rest',ARRAY[$6]::text[],'{}'::jsonb,$7::jsonb,$8)`,
    [revId, sheetId, id, version, action, NAME, JSON.stringify(snap), at],
  )
  return revId
}

async function insertTombstone(
  sheetId: string,
  fieldId: string,
  neighborId: string,
  foreignId: string,
  sourceRevisionId: string,
): Promise<void> {
  await q(
    `INSERT INTO meta_link_tombstones (id, sheet_id, field_id, record_id, foreign_record_id, reason, source_revision_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'record_delete', $5::uuid, now())`,
    [sheetId, fieldId, neighborId, foreignId, sourceRevisionId],
  )
}

async function sheetAWriteState() {
  const records = (await q('SELECT id, data, version FROM meta_records WHERE sheet_id = $1 ORDER BY id', [SHEET_A])).rows
  const revisionCount = Number(((await q('SELECT count(*)::int AS c FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_A])).rows[0] as { c: number }).c)
  const tombstoneCount = Number(((await q('SELECT count(*)::int AS c FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET_A])).rows[0] as { c: number }).c)
  const linkCount = Number(((await q(
    `SELECT count(*)::int AS c FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = ANY($1::text[]))`,
    [[SHEET_A, SHEET_B]],
  )).rows[0] as { c: number }).c)
  return { records, revisionCount, tombstoneCount, linkCount }
}

describeIfDatabase('4c-3 §7 — multi-vintage PIT-resurrect heuristic retired; exact-anchor fail-closed (real DB)', () => {
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
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'RVI Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_A, BASE, 'RVI A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B, BASE, 'RVI B'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET_A, 'Name', 'string', '{}', 0])
    await q(
      "INSERT INTO users (id, password_hash, permissions) VALUES ($1,'x',$2::jsonb) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions, is_active = TRUE",
      [ACTOR, JSON.stringify(['multitable:read', 'multitable:write', 'multitable:share'])],
    )
  })

  afterAll(async () => {
    delete process.env[UNDELETE_FLAG]
    delete process.env[INBOUND_FLAG]
    delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    for (const sheet of [SHEET_A, SHEET_B]) {
      await pruneSealedHistoryOperations(sheet).catch(() => {})
      await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [sheet]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      for (const t of [
        'meta_history_baselines',
        'meta_history_trust_checkpoints',
        'meta_recovery_token_burns',
        'meta_record_version_markers',
        'meta_records_trash',
      ]) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  beforeEach(async () => {
    enableTrust()
    process.env[UNDELETE_FLAG] = 'true'
    process.env[INBOUND_FLAG] = 'true'
    for (const sheet of [SHEET_A, SHEET_B]) {
      await pruneSealedHistoryOperations(sheet).catch(() => {})
      await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [sheet]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet]).catch(() => {})
      // Drop dynamic neighbour link fields (NAME on SHEET_A is permanent).
      if (sheet === SHEET_B) {
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      } else {
        await q('DELETE FROM meta_fields WHERE sheet_id = $1 AND id <> $2', [sheet, NAME]).catch(() => {})
      }
      for (const t of [
        'meta_history_baselines',
        'meta_history_trust_checkpoints',
        'meta_recovery_token_burns',
        'meta_record_version_markers',
        'meta_records_trash',
      ]) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [sheet]).catch(() => {})
    }
    fixture = await prepareExactAnchorHistoryFixture(SHEET_A)
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('wall-clock asOf is refused EXACT_ANCHOR_REQUIRED (first-delete-after-T path is dead)', async () => {
    const F = mkFieldId('wall')
    await insertField(SHEET_B, F)
    const R = mkRecordId('wall_r')
    const N = mkRecordId('wall_n')
    await insertRecord(SHEET_B, N, { [F]: [R] })
    const SNAP = { [NAME]: 'vintage' }
    await rev(SHEET_A, R, 1, 'create', SNAP, T0)
    // Need a sealed anchor on the sheet — a second record that remains live.
    const H = mkRecordId('wall_h')
    await rev(SHEET_A, H, 1, 'create', { [NAME]: 'healthy' }, T0, { anchor: true })
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      H, SHEET_A, JSON.stringify({ [NAME]: 'healthy' }),
    ])
    const del = await rev(SHEET_A, R, 1, 'delete', SNAP, T2) // delete-reuse last live version
    await insertTombstone(SHEET_A, F, N, R, del)

    const before = await sheetAWriteState()
    const pv = await previewWallClock(T1)
    expect(pv.status).toBe(400)
    expect(pv.body?.error?.code).toBe('EXACT_ANCHOR_REQUIRED')
    const ex = await execute({
      asOf: T1,
      previewIdentity: 'dummy-never-minted',
      confirm: 'undelete',
    })
    expect(ex.status).toBe(400)
    expect(ex.body?.error?.code).toBe('EXACT_ANCHOR_REQUIRED')
    expect(await sheetAWriteState()).toEqual(before)
    expect(await liveRow(R)).toBeUndefined()
    expect(await edgeCount(F, N, R)).toBe(0)
  })

  test('multi-vintage history under exact anchor: resurrects disclosed, never executable; zero inbound replay', async () => {
    const F = mkFieldId('mv')
    await insertField(SHEET_B, F)
    const R = mkRecordId('mv_r')
    const N1 = mkRecordId('mv_n1') // vintage-1 neighbour
    const N2 = mkRecordId('mv_n2') // vintage-2 neighbour
    await insertRecord(SHEET_B, N1, { [F]: [R] })
    await insertRecord(SHEET_B, N2, { [F]: [R] })

    const SNAP_V1 = { [NAME]: 'vintage-1' }
    const SNAP_V2 = { [NAME]: 'vintage-2' }
    // Two delete vintages (historical first-delete-after-T would have chosen del1 for an early T).
    // Strict contiguity: each generation is create@v1 + delete@v1 (delete-reuse); versions restart per gen.
    await rev(SHEET_A, R, 1, 'create', SNAP_V1, T0)
    const del1 = await rev(SHEET_A, R, 1, 'delete', SNAP_V1, T1)
    await insertTombstone(SHEET_A, F, N1, R, del1)
    await rev(SHEET_A, R, 1, 'create', SNAP_V2, T1_5)
    const del2 = await rev(SHEET_A, R, 1, 'delete', SNAP_V2, T2)
    await insertTombstone(SHEET_A, F, N2, R, del2)

    // Healthy live anchor row (R itself is fully deleted).
    const H = mkRecordId('mv_h')
    await rev(SHEET_A, H, 1, 'create', { [NAME]: 'healthy-anchor' }, T0, { anchor: true })
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      H, SHEET_A, JSON.stringify({ [NAME]: 'healthy-anchor' }),
    ])

    const before = await sheetAWriteState()
    const pv = await previewExact()
    expect(pv.status).toBe(200)
    // R is absent live and present at the sealed anchor → resurrect candidate (enumeration only).
    expect(pv.body?.data?.undeleteRecordIds).toEqual(expect.arrayContaining([R]))
    expect(pv.body?.data?.undeleteSupported).toBe(false)
    expect(pv.body?.data?.undeleteBlockedReason).toBe('INBOUND_UNPROVABLE')
    expect(pv.body?.data?.executable).toBe(false)
    expect(pv.body?.data?.previewIdentity).toBeNull()

    const noToken = await execute({ confirm: 'undelete' })
    expect(noToken.status).toBe(400)
    expect(noToken.body?.error?.code).toBe('VALIDATION_ERROR')
    const forged = await execute({ previewIdentity: 'forged.token.value', confirm: 'undelete' })
    expect(forged.status).toBe(409)
    expect(forged.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID')

    expect(await sheetAWriteState()).toEqual(before)
    expect(await liveRow(R)).toBeUndefined()
    // Neither vintage's neighbour edge is replayed — route never reaches inbound replay.
    expect(await edgeCount(F, N1, R)).toBe(0)
    expect(await edgeCount(F, N2, R)).toBe(0)
  })
})
