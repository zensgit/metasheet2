/**
 * 4c-3 §7 — PIT-resurrect (`POST /sheets/:id/revert-execute`, T8-1 undelete) inbound-edge replay (real
 * DB). R8 absorption-audit hardening (P3-1, post-hoc — no product behaviour changed). PR #3975 wired
 * resurrect to reuse the SAME `replayInboundLinks` helper restore uses (design-lock §7: "never a
 * parallel inbound semantic"), but shipped with no dedicated golden for its anchor derivation, which
 * — unlike restore's `meta_records_trash.delete_revision_id` column — is a HEURISTIC: resurrect has no
 * trash row, so it anchors to the record's MOST RECENT 'delete' revision (`ORDER BY created_at DESC`).
 *
 * This file pins the two honest consequences of that heuristic (see the reworded comment at
 * `univer-meta.ts` ~10165, which used to overclaim "deterministic"):
 *   (A) multi-vintage: resurrecting an OLDER vintage's snapshot still anchors to the LATEST delete
 *       revision — replaying only that vintage's captured edges, never stringing multiple anchors'
 *       tombstones together (no cross-vintage double-replay).
 *   (B) the most recent deletion happened while capture was off (zero tombstones for that anchor) →
 *       silent zero replay, honest, never an error and never fabricated.
 * Over-replay stays impossible in both cases regardless of which delete revision the heuristic picks,
 * because precondition 6 (neighbour consent — replay only what N's OWN live data still declares) gates
 * every edge independently of the anchor.
 *
 * Design-lock: `docs/development/multitable-global-history-4c3-record-undelete-2b-inbound-edge-replay-
 * design-lock-20260708.md` §7. Audit: `/tmp/pr3975-4c3-absorption-audit-claude-20260709.md` (P3-1).
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

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
const T0_5 = '2026-01-01T12:00:00.000Z'
const T1 = '2026-01-02T00:00:00.000Z'
const T1_5 = '2026-01-02T12:00:00.000Z'
const T2 = '2026-01-03T00:00:00.000Z'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let seq = 0
const mkFieldId = (tag: string) => `fld_rvi_${tag}_${TS}_${seq++}`
const mkRecordId = (tag: string) => `rec_rvi_${tag}_${TS}_${seq++}`

const preview = (asOf: string) => request(app).post(`/api/multitable/sheets/${SHEET_A}/revert-preview`).send({ asOf })
const execute = (asOf: string, previewIdentity: string) => request(app).post(`/api/multitable/sheets/${SHEET_A}/revert-execute`).send({ asOf, previewIdentity, confirm: 'undelete' })
const liveRow = async (id: string) => (await q('SELECT data, version FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
const edgeCount = async (fieldId: string, recordId: string, foreignId: string): Promise<number> =>
  (await q('SELECT 1 FROM meta_links WHERE field_id=$1 AND record_id=$2 AND foreign_record_id=$3', [fieldId, recordId, foreignId])).rows.length
async function insertField(sheetId: string, fieldId: string, type = 'link', property = '{}'): Promise<void> {
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fieldId, sheetId, fieldId, type, property, seq])
}
async function insertRecord(sheetId: string, recordId: string, data: Record<string, unknown>): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recordId, sheetId, JSON.stringify(data)])
}
/** Records a revision AND (optionally) returns its freshly-minted id so a tombstone can anchor to it. */
async function rev(sheetId: string, id: string, version: number, action: string, snap: Record<string, unknown>, at: string): Promise<string> {
  const revId = randomUUID()
  await q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES ($1,$2,$3,$4,$5,'rest',ARRAY[$6]::text[],'{}'::jsonb,$7::jsonb,$8)`,
    [revId, sheetId, id, version, action, NAME, JSON.stringify(snap), at],
  )
  return revId
}
async function insertTombstone(sheetId: string, fieldId: string, neighborId: string, foreignId: string, sourceRevisionId: string): Promise<void> {
  await q(
    `INSERT INTO meta_link_tombstones (id, sheet_id, field_id, record_id, foreign_record_id, reason, source_revision_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'record_delete', $5::uuid, now())`,
    [sheetId, fieldId, neighborId, foreignId, sourceRevisionId],
  )
}

describeIfDatabase('4c-3 §7 — PIT-resurrect inbound-edge replay heuristic anchor (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }; next() })
    process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS = '50'
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'RVI Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_A, BASE, 'RVI A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B, BASE, 'RVI B'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET_A, 'Name', 'string', '{}', 0])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    process.env[UNDELETE_FLAG] = 'true'
  })

  afterAll(async () => {
    delete process.env[UNDELETE_FLAG]
    delete process.env[INBOUND_FLAG]
    delete process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS
    for (const sheet of [SHEET_A, SHEET_B]) {
      await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [sheet]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  afterEach(() => { delete process.env[INBOUND_FLAG] })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('(A) multi-vintage: resurrecting an OLDER vintage anchors to the LATEST delete revision — replays ONLY that vintage, never strings anchors together', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const F = mkFieldId('a')
    await insertField(SHEET_B, F)
    const R = mkRecordId('a_r')
    const N1 = mkRecordId('a_n1') // vintage-1 neighbour
    const N2 = mkRecordId('a_n2') // vintage-2 neighbour
    await insertRecord(SHEET_B, N1, { [F]: [R] })
    await insertRecord(SHEET_B, N2, { [F]: [R] })

    const SNAP_V1 = { [NAME]: 'vintage-1' }
    const SNAP_V2 = { [NAME]: 'vintage-2' }
    await rev(SHEET_A, R, 1, 'create', SNAP_V1, T0)
    const del1 = await rev(SHEET_A, R, 2, 'delete', SNAP_V1, T1)
    await insertTombstone(SHEET_A, F, N1, R, del1) // vintage-1's captured edge
    await rev(SHEET_A, R, 3, 'create', SNAP_V2, T1_5) // "restore" — vintage 2 begins
    const del2 = await rev(SHEET_A, R, 4, 'delete', SNAP_V2, T2)
    await insertTombstone(SHEET_A, F, N2, R, del2) // vintage-2's captured edge

    // Resurrect at T0_5 (between vintage-1's create and delete) → the OLD vintage's snapshot.
    const pv = await preview(T0_5)
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.undeleteRecordIds).toEqual([R])
    const ex = await execute(T0_5, pv.body?.data?.previewIdentity)
    expect(ex.status).toBe(200)
    expect(ex.body?.data?.resurrectedCount).toBe(1)

    const live = await liveRow(R)
    expect(live?.data?.[NAME]).toBe('vintage-1') // the OLD vintage's snapshot was indeed resurrected

    // Anchor = latest delete revision (del2, vintage-2) — so vintage-2's neighbour replays...
    expect(await edgeCount(F, N2, R)).toBe(1)
    expect(ex.body?.data?.undeleteInbound).toMatchObject({ replayed: 1 })
    // ...but vintage-1's neighbour does NOT — its tombstone lives under a DIFFERENT anchor (del1) that
    // this resurrect never queries. This is the honest, pinned consequence of the heuristic: exactly
    // one vintage's edges replay, never a cross-vintage union.
    expect(await edgeCount(F, N1, R)).toBe(0)
  })

  test('(B) most recent deletion was uncaptured (zero tombstones for its anchor): silent zero replay, no error, resurrect still succeeds', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const F = mkFieldId('b')
    await insertField(SHEET_B, F)
    const R = mkRecordId('b_r')
    const N = mkRecordId('b_n')
    await insertRecord(SHEET_B, N, { [F]: [R] })

    const SNAP = { [NAME]: 'uncaptured' }
    await rev(SHEET_A, R, 1, 'create', SNAP, T0)
    await rev(SHEET_A, R, 2, 'delete', SNAP, T2) // delete revision exists (anchor resolves)...
    // ...but NO tombstone was ever inserted for it (simulates capture being OFF at delete time).

    const pv = await preview(T1)
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.undeleteRecordIds).toEqual([R])
    const ex = await execute(T1, pv.body?.data?.previewIdentity)
    expect(ex.status).toBe(200) // resurrect itself is NOT blocked by an uncaptured/absent tombstone set
    expect(ex.body?.data?.resurrectedCount).toBe(1)
    expect(ex.body?.data?.undeleteInbound).toEqual({ replayed: 0, total: 0 }) // honest zero, not fabricated

    const live = await liveRow(R)
    expect(live?.data?.[NAME]).toBe('uncaptured')
    expect(await edgeCount(F, N, R)).toBe(0) // nothing to replay — never invented
  })

  test('(C) flag OFF: resurrect succeeds but the response carries no undeleteInbound field at all (byte-identical to pre-4c-3)', async () => {
    delete process.env[INBOUND_FLAG]
    const F = mkFieldId('c')
    await insertField(SHEET_B, F)
    const R = mkRecordId('c_r')
    const N = mkRecordId('c_n')
    await insertRecord(SHEET_B, N, { [F]: [R] })
    const SNAP = { [NAME]: 'flagoff' }
    const del = await rev(SHEET_A, R, 1, 'create', SNAP, T0)
    const delRev = await rev(SHEET_A, R, 2, 'delete', SNAP, T2)
    await insertTombstone(SHEET_A, F, N, R, delRev)
    void del

    const pv = await preview(T1)
    const ex = await execute(T1, pv.body?.data?.previewIdentity)
    expect(ex.status).toBe(200)
    expect(ex.body?.data?.undeleteInbound).toBeUndefined()
    expect(await edgeCount(F, N, R)).toBe(0) // today's (pre-4c-3) behavior: inbound stays lost on resurrect
  })
})
