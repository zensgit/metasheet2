/**
 * 4c-2 forward tombstone-capture — RECORD-DELETE capture point (real DB). Design-lock
 * `docs/development/multitable-global-history-4c2-forward-tombstone-capture-design-lock-20260707.md`
 * (#3809 + #3830 correction, owner-ratified 2026-07-08), §2 capture point 2.
 *
 * `deleteRecord` (record-service.ts) captures ONLY the record's INBOUND link edges
 * (`foreign_record_id = $1`) into `meta_link_tombstones` (reason='record_delete') — outbound edges are
 * already covered by `meta_records_trash` (the trashed row's `data` still carries the link-field arrays,
 * and `restoreRecord` replays them on restore). Covers:
 *   G2 (record-delete half) flag-off → zero tombstone rows, existing delete/restore behavior unchanged.
 *   G7 inbound captured, outbound NOT duplicated into meta_link_tombstones, and — 4c-3 (inbound-edge
 *      reconstruction on restore) is explicitly OUT OF SCOPE this round — restore does NOT auto-recreate
 *      the inbound edge.
 *   G10 concurrency: a version-conflicting delete attempt (capture ON) is refused BEFORE any capture runs
 *      — zero tombstones on a rejected delete, no half-state.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_tsrc_${TS}`
const SHEET = `sheet_tsrc_${TS}`
const WRITER = `u_tsrc_w_${TS}`
const CAPTURE_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'
const CAP_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let seq = 0
const mkFieldId = (tag: string) => `fld_tsrc_${tag}_${TS}_${seq++}`
const mkRecordId = (tag: string) => `rec_tsrc_${tag}_${TS}_${seq++}`

async function insertField(fieldId: string, name: string, type: string, order: number): Promise<void> {
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fieldId, SHEET, name, type, '{}', order])
}
async function insertRecord(recordId: string, data: Record<string, unknown>, version = 1): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [recordId, SHEET, JSON.stringify(data), version])
}
async function insertLink(fieldId: string, recordId: string, foreignRecordId: string): Promise<void> {
  await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [fieldId, recordId, foreignRecordId])
}
const deleteRecord = (recordId: string, expectedVersion?: number) =>
  request(app).delete(`/api/multitable/records/${recordId}${typeof expectedVersion === 'number' ? `?expectedVersion=${expectedVersion}` : ''}`)
const restoreRecord = (recordId: string) => request(app).post(`/api/multitable/records/${recordId}/restore`)
const rowCount = async (sql: string, params: unknown[]): Promise<number> => (await q(sql, params)).rows.length

async function lastRecordDeleteRevisionId(recordId: string): Promise<string | undefined> {
  const r = await q(
    `SELECT id FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND action = 'delete' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [SHEET, recordId],
  )
  return (r.rows[0] as { id: string } | undefined)?.id
}

describeIfDatabase('4c-2 tombstone capture — record delete (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: WRITER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'TSRC Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'TSRC Sheet'])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  afterEach(() => {
    delete process.env[CAPTURE_FLAG]
    delete process.env[CAP_FLAG]
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('G2 flag-off: record delete captures NOTHING, existing trash/link-delete behavior unchanged', async () => {
    delete process.env[CAPTURE_FLAG]
    const L = mkFieldId('g2')
    await insertField(L, 'G2Link', 'link', 1)
    const A = mkRecordId('g2a'); await insertRecord(A, {})
    const B = mkRecordId('g2b'); await insertRecord(B, {})
    await insertLink(L, B, A) // B -> A (A's inbound edge)

    const res = await deleteRecord(A)
    expect(res.status).toBe(200)
    expect(await rowCount('SELECT 1 FROM meta_link_tombstones WHERE sheet_id = $1 AND field_id = $2', [SHEET, L])).toBe(0)
    // existing behavior: BOTH directions gone from meta_links, A moved to trash.
    expect(await rowCount('SELECT 1 FROM meta_links WHERE foreign_record_id = $1', [A])).toBe(0)
    expect(await rowCount('SELECT 1 FROM meta_records_trash WHERE record_id = $1', [A])).toBe(1)
  })

  test('G7 flag-on: INBOUND edges captured, OUTBOUND not duplicated, restore does NOT auto-recreate the inbound edge (4c-3 out of scope)', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    const L = mkFieldId('g7')
    await insertField(L, 'G7Link', 'link', 1)
    const A = mkRecordId('g7a')
    const B = mkRecordId('g7b'); await insertRecord(B, {})
    const C = mkRecordId('g7c'); await insertRecord(C, {})
    // data mirrors the outbound link array, exactly as a real link write would (restoreRecord's outbound
    // replay reads THIS snapshot, not meta_links).
    await insertRecord(A, { [L]: [B] })
    await insertLink(L, A, B) // A -> B: A's OUTBOUND edge (must NOT be captured here)
    await insertLink(L, C, A) // C -> A: A's INBOUND edge (must BE captured)

    const res = await deleteRecord(A)
    expect(res.status).toBe(200)
    const delRevId = await lastRecordDeleteRevisionId(A)
    expect(delRevId).toBeTruthy()

    const tombstones = (await q(
      'SELECT record_id, foreign_record_id, field_id, reason, source_revision_id FROM meta_link_tombstones WHERE sheet_id = $1 AND field_id = $2',
      [SHEET, L],
    )).rows as Array<{ record_id: string; foreign_record_id: string; field_id: string; reason: string; source_revision_id: string }>
    expect(tombstones.length).toBe(1) // exactly the inbound edge — the outbound one is NOT duplicated here
    expect(tombstones[0]).toMatchObject({ record_id: C, foreign_record_id: A, field_id: L, reason: 'record_delete', source_revision_id: delRevId })

    // Restore A: existing outbound-replay mechanism (trash-backed) puts A -> B back...
    const restored = await restoreRecord(A)
    expect(restored.status).toBe(200)
    expect(await rowCount('SELECT 1 FROM meta_links WHERE record_id = $1 AND foreign_record_id = $2', [A, B])).toBe(1)
    // ...but the INBOUND edge (C -> A) is NOT auto-recreated — 4c-3 (record-undelete inbound reconstruction)
    // is an explicit, separate, owner-gated line; this PR only captures the inbound edge, it does not replay it.
    expect(await rowCount('SELECT 1 FROM meta_links WHERE record_id = $1 AND foreign_record_id = $2', [C, A])).toBe(0)
  })

  test('G7 self-link: a record linking to itself is captured once, harmlessly (no duplicate-row error)', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    const L = mkFieldId('g7self')
    await insertField(L, 'G7SelfLink', 'link', 1)
    const A = mkRecordId('g7self'); await insertRecord(A, {})
    await insertLink(L, A, A) // self-link: record_id = foreign_record_id = A

    const res = await deleteRecord(A)
    expect(res.status).toBe(200)
    const tombstones = (await q('SELECT record_id, foreign_record_id FROM meta_link_tombstones WHERE sheet_id = $1 AND field_id = $2', [SHEET, L])).rows
    expect(tombstones.length).toBe(1)
    expect(tombstones[0]).toMatchObject({ record_id: A, foreign_record_id: A })
  })

  test('G3 (record side) over-cap: 422, delete refused, record + its inbound edge untouched, zero tombstones', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    process.env[CAP_FLAG] = '1'
    const L = mkFieldId('g3rec')
    await insertField(L, 'G3RecLink', 'link', 1)
    const A = mkRecordId('g3reca'); await insertRecord(A, {})
    const B = mkRecordId('g3recb'); await insertRecord(B, {})
    const C = mkRecordId('g3recc'); await insertRecord(C, {})
    await insertLink(L, B, A) // inbound #1
    await insertLink(L, C, A) // inbound #2 — 2 inbound edges > cap of 1

    const res = await deleteRecord(A)
    expect(res.status).toBe(422)
    expect(res.body?.error?.code).toBe('TOMBSTONE_CAPTURE_CAP_EXCEEDED')
    expect(await rowCount('SELECT 1 FROM meta_records WHERE id = $1', [A])).toBe(1) // NOT deleted
    expect(await rowCount('SELECT 1 FROM meta_links WHERE foreign_record_id = $1', [A])).toBe(2) // untouched
    expect(await rowCount('SELECT 1 FROM meta_link_tombstones WHERE sheet_id = $1 AND field_id = $2', [SHEET, L])).toBe(0)
  })

  test('G10 concurrency: a version-conflicting delete (capture ON) is refused BEFORE any capture — zero tombstones, no half-state', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    const L = mkFieldId('g10')
    await insertField(L, 'G10Link', 'link', 1)
    const A = mkRecordId('g10a'); await insertRecord(A, {}, 1)
    const B = mkRecordId('g10b'); await insertRecord(B, {})
    await insertLink(L, B, A) // A has an inbound edge, would be captured if the delete proceeded

    const res = await deleteRecord(A, 999) // wrong expectedVersion → VERSION_CONFLICT, must never reach capture
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('VERSION_CONFLICT')
    expect(await rowCount('SELECT 1 FROM meta_records WHERE id = $1', [A])).toBe(1) // record untouched
    expect(await rowCount('SELECT 1 FROM meta_links WHERE foreign_record_id = $1', [A])).toBe(1) // link untouched
    expect(await rowCount('SELECT 1 FROM meta_link_tombstones WHERE sheet_id = $1 AND record_id = $2', [SHEET, B])).toBe(0)

    // the correct version now succeeds and DOES capture.
    const ok = await deleteRecord(A, 1)
    expect(ok.status).toBe(200)
    expect(await rowCount('SELECT 1 FROM meta_link_tombstones WHERE sheet_id = $1 AND record_id = $2 AND foreign_record_id = $3', [SHEET, B, A])).toBe(1)
  })
})
