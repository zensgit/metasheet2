/**
 * 4c-3 §7 (D-3) — PIT-reset inline delete gains inbound-link tombstone capture (real DB).
 *
 * R8 absorption-audit hardening (P3-2, post-hoc — no product behaviour changed). PR #3975 wired
 * `univer-meta.ts`'s reset-execute delete loop to pre-generate a `resetDeleteRevisionId`, capture
 * inbound-link tombstones BEFORE destroying the edges (same shape as `record-service.deleteRecord`),
 * write it into `meta_records_trash.delete_revision_id`, and map a cap breach to the same 422
 * `TOMBSTONE_CAPTURE_CAP_EXCEEDED` the DELETE-record route uses — but shipped with no dedicated
 * golden. Design-lock: `docs/development/multitable-global-history-4c3-record-undelete-2b-inbound-
 * edge-replay-design-lock-20260708.md` §7. Audit: `/tmp/pr3975-4c3-absorption-audit-claude-20260709.md`.
 *
 * Cross-sheet fixture: the reset TARGET D lives on SHEET_A; its neighbour N (which owns the link
 * field F pointing at D) lives on SHEET_B — same trap as the RB matrix (tombstone's sheet_id stores
 * D's sheet, field_id/record_id belong to N's).
 *
 * Migrated to exact-anchor authority (W0 L8): free wall-clock `asOf` is refused; destructive reset
 * is driven by a sealed `anchorOperationId` + token-only execute. Capture/restore contracts are
 * unchanged.
 *
 * (a) happy path: reset-execute captures the inbound tombstone anchored to the SAME delete revision
 *     id it writes into the trash row; a subsequent restore (record-service.restoreRecord, flag on)
 *     replays the edge — full round trip through the D-3 capture point.
 * (b) cap breach: MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS forced to 1 with capture ON → reset-execute
 *     returns the stable 422 TOMBSTONE_CAPTURE_CAP_EXCEEDED contract and the WHOLE reset rolls back —
 *     the delete target stays live, the unrelated revert candidate stays unreverted, and the
 *     neighbour's edge is untouched (fail-closed, never a half-captured destruction).
 *
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import {
  prepareExactAnchorHistoryFixture,
  pruneSealedHistoryOperations,
  type ExactAnchorHistoryFixture,
} from '../utils/exact-anchor-history-fixture'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_ric_${TS}`
const SHEET_A = `sheet_ric_a_${TS}` // reset target's sheet
const SHEET_B = `sheet_ric_b_${TS}` // neighbour's sheet (owns link field F)
const NAME = `fld_ric_name_${TS}`
const ACTOR = `user_ric_${TS}`
const RESET_FLAG = 'MULTITABLE_ENABLE_PIT_RESET'
const CAPTURE_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'
const INBOUND_FLAG = 'MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND'
const CAP_ROWS_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS'
const T0 = '2026-01-01T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let fixture: ExactAnchorHistoryFixture
let seq = 0
const mkFieldId = (tag: string) => `fld_ric_${tag}_${TS}_${seq++}`
const mkRecordId = (tag: string) => `rec_ric_${tag}_${TS}_${seq++}`

const resetPreview = () =>
  request(app).post(`/api/multitable/sheets/${SHEET_A}/reset-preview`).send({ anchorOperationId: fixture.anchorOperationId() })
const resetExecute = (previewIdentity: string) =>
  request(app).post(`/api/multitable/sheets/${SHEET_A}/reset-execute`).send({ previewIdentity, confirm: 'reset' })
const httpRestore = (recordId: string) => request(app).post(`/api/multitable/records/${recordId}/restore`)
const recordRow = async (id: string) => (await q('SELECT data, version FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
const edgeCount = async (fieldId: string, recordId: string, foreignId: string): Promise<number> =>
  (await q('SELECT 1 FROM meta_links WHERE field_id=$1 AND record_id=$2 AND foreign_record_id=$3', [fieldId, recordId, foreignId])).rows.length

async function insertField(sheetId: string, fieldId: string, type = 'link', property = '{}'): Promise<void> {
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
    fieldId, sheetId, fieldId, type, property, seq,
  ])
}
async function insertRecord(sheetId: string, recordId: string, data: Record<string, unknown>, version = 1): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [recordId, sheetId, JSON.stringify(data), version])
}
async function insertLink(fieldId: string, recordId: string, foreignRecordId: string): Promise<void> {
  await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [fieldId, recordId, foreignRecordId])
}

/**
 * D is a delete-candidate under reset-to-anchor (created after the sealed anchor): live row + a lone
 * create after the anchor. N (on SHEET_B) points at D through link field F. A stable survivor S owns
 * the sealed anchor operation (no restorable delta — present only to pin the exact causal endpoint).
 */
async function fixtureDeleteTarget(tag: string): Promise<{ F: string; D: string; N: string; S: string }> {
  const S = mkRecordId(`${tag}s`)
  await insertRecord(SHEET_A, S, { [NAME]: 'stable' }, 1)
  await fixture.insertRevision({
    recordId: S,
    version: 1,
    action: 'create',
    snapshot: { [NAME]: 'stable' },
    createdAt: T0,
    phase: 'anchor',
    changedFieldIds: [NAME],
  })

  const F = mkFieldId(tag)
  await insertField(SHEET_B, F)
  const D = mkRecordId(`${tag}d`)
  await insertRecord(SHEET_A, D, { [NAME]: 'newbie' })
  await fixture.insertRevision({
    recordId: D,
    version: 1,
    action: 'create',
    snapshot: { [NAME]: 'newbie' },
    createdAt: T2,
    phase: 'after',
    changedFieldIds: [NAME],
  })
  const N = mkRecordId(`${tag}n`)
  await insertRecord(SHEET_B, N, { [F]: [D] })
  await insertLink(F, N, D)
  return { F, D, N, S }
}

describeIfDatabase('4c-3 §7 (D-3) — PIT-reset inline delete inbound-link capture (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }; next() })
    process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS = '50'
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'RIC Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_A, BASE, 'RIC A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B, BASE, 'RIC B'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET_A, 'Name', 'string', '{}', 0])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    process.env[RESET_FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
  })

  afterAll(async () => {
    delete process.env[RESET_FLAG]
    delete process.env[CAPTURE_FLAG]
    delete process.env[INBOUND_FLAG]
    delete process.env[CAP_ROWS_FLAG]
    delete process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    for (const sheet of [SHEET_A, SHEET_B]) {
      await pruneSealedHistoryOperations(sheet).catch(() => {})
      await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_recovery_token_burns WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [sheet]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  beforeEach(async () => {
    process.env[RESET_FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
    await pruneSealedHistoryOperations(SHEET_A).catch(() => {})
    await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [SHEET_A]).catch(() => {})
    await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [SHEET_A]).catch(() => {})
    await q('DELETE FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET_A]).catch(() => {})
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SHEET_A]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_A]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_A]).catch(() => {})
    // Neighbour sheet B is not under exact-anchor recovery; only clear rows between cases.
    await q('DELETE FROM meta_link_tombstones WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [SHEET_B]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_B]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1 AND id <> $2', [SHEET_A, NAME]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_B]).catch(() => {})
    fixture = await prepareExactAnchorHistoryFixture(SHEET_A)
  })

  afterEach(() => {
    delete process.env[INBOUND_FLAG]
    delete process.env[CAP_ROWS_FLAG]
    process.env[CAPTURE_FLAG] = 'true'
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('(a) happy path: reset-execute captures the inbound tombstone anchored to the trash delete_revision_id; restore replays it', async () => {
    const { F, D, N } = await fixtureDeleteTarget('a')
    expect(await edgeCount(F, N, D)).toBe(1) // baseline: the edge exists before reset

    const pv = await resetPreview()
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.deleteRecordIds).toEqual([D])
    expect(pv.body?.data?.executable).toBe(true)
    const token = pv.body?.data?.previewIdentity as string
    expect(token).toBeTruthy()
    const ex = await resetExecute(token)
    expect(ex.status).toBe(200)
    expect(ex.body?.data?.deletedCount).toBe(1)

    // D is soft-deleted (recycle bin), edge destroyed, tombstone captured under the SAME anchor.
    expect(await recordRow(D)).toBeUndefined()
    expect(await edgeCount(F, N, D)).toBe(0)
    const trashRow = (await q('SELECT delete_revision_id FROM meta_records_trash WHERE record_id = $1', [D])).rows[0] as { delete_revision_id: string | null }
    expect(trashRow.delete_revision_id).toBeTruthy()
    const tombstone = await q(
      `SELECT field_id, record_id, foreign_record_id FROM meta_link_tombstones
        WHERE source_revision_id = $1::uuid AND reason = 'record_delete'`,
      [trashRow.delete_revision_id],
    )
    expect(tombstone.rows).toEqual([{ field_id: F, record_id: N, foreign_record_id: D }])

    // Full round trip: restore (flag on) replays the captured edge.
    process.env[INBOUND_FLAG] = 'true'
    const restore = await httpRestore(D)
    expect(restore.status).toBe(200)
    expect(restore.body?.data?.inbound).toMatchObject({ replayed: 1, recoverable: true })
    expect(await edgeCount(F, N, D)).toBe(1)
  })

  test('(b) cap breach: 2 inbound edges > MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS=1 → refuse + WHOLE reset rolled back (zero writes)', async () => {
    const { F, D, N } = await fixtureDeleteTarget('b')
    // A second neighbour pointing at D — 2 inbound edges total, exceeding the forced cap of 1.
    // (resolveTombstoneCaptureMaxRows treats a non-positive override as "unset" and falls back to the
    // 50000 default, so the cap must be crossed by row COUNT, not by a zero/negative override.)
    const N2 = mkRecordId('b_n2')
    await insertRecord(SHEET_B, N2, { [F]: [D] })
    await insertLink(F, N2, D)
    expect(await edgeCount(F, N, D)).toBe(1)
    expect(await edgeCount(F, N2, D)).toBe(1)

    // An unrelated revert candidate in the SAME sheet — proves the rollback is transaction-wide, not
    // just the failing delete's own row. Create@anchor + update@after on the same fixture.
    const A = mkRecordId('b_a')
    await insertRecord(SHEET_A, A, { [NAME]: 'new' }, 2)
    await fixture.insertRevision({
      recordId: A,
      version: 1,
      action: 'create',
      snapshot: { [NAME]: 'old' },
      createdAt: T0,
      phase: 'before',
      changedFieldIds: [NAME],
    })
    await fixture.insertRevision({
      recordId: A,
      version: 2,
      action: 'update',
      snapshot: { [NAME]: 'new' },
      createdAt: T2,
      phase: 'after',
      changedFieldIds: [NAME],
    })

    const pv = await resetPreview()
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.deleteRecordIds).toEqual(expect.arrayContaining([D]))
    const token = pv.body?.data?.previewIdentity as string
    expect(token).toBeTruthy()

    process.env[CAP_ROWS_FLAG] = '1' // D would capture 2 inbound rows > cap 1 → assertWithinCaptureCap throws
    const ex = await resetExecute(token)
    expect(ex.status).toBe(422)
    expect(ex.body).toMatchObject({ ok: false, error: { code: 'TOMBSTONE_CAPTURE_CAP_EXCEEDED' } })

    // Fail-closed, all-or-nothing: NOTHING written.
    expect(await recordRow(D)).toBeTruthy() // D still LIVE, never soft-deleted
    expect((await q('SELECT 1 FROM meta_records_trash WHERE record_id = $1', [D])).rows).toHaveLength(0)
    expect(await edgeCount(F, N, D)).toBe(1) // the edges the cap-check was protecting are UNTOUCHED
    expect(await edgeCount(F, N2, D)).toBe(1)
    expect((await q("SELECT 1 FROM meta_link_tombstones WHERE reason = 'record_delete' AND foreign_record_id = $1", [D])).rows).toHaveLength(0) // no half-capture
    const a = await recordRow(A)
    expect(a?.data?.[NAME]).toBe('new') // the unrelated revert candidate was NOT reverted either — whole-txn rollback
    expect(a?.version).toBe(2)
    // Token burn rolled back with the txn (at-most-once barrier is not durable on a refused apply).
    expect(Number(((await q('SELECT count(*)::int AS c FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET_A])).rows[0] as { c: number }).c)).toBe(0)
  })
})
