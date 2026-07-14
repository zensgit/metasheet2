/**
 * 4c-3 §7 — PIT-resurrect (`POST /sheets/:id/revert-execute`, T8-1 undelete) inbound-edge replay (real
 * DB). R11 A′ (ratified 2026-07-11) — the anchor is now DERIVED from the revert's `asOf` T, replacing
 * the R8 `created_at DESC` latest-delete heuristic. Resurrect has no trash row (unlike restore's
 * `meta_records_trash.delete_revision_id`), but the revert carries T on the wire and the semantics are
 * "restore the record as it existed at T"; a record is in the resurrect set precisely because its
 * latest revision with `created_at <= T` is NOT a delete (reconstructRecordsAtT), so the removing
 * deletion is the FIRST 'delete' revision strictly AFTER T — a vintage-EXACT anchor:
 * `SELECT ... WHERE action='delete' AND created_at > T ORDER BY created_at ASC, version ASC, id ASC LIMIT 1`.
 *
 * Goldens:
 *   (A) multi-vintage: resurrecting an OLDER vintage's snapshot anchors to THAT vintage's deletion
 *       (first delete after T), replaying exactly that vintage's captured edges — never the LATEST
 *       deletion's, never a cross-vintage union. This assertion is the INVERSE of the R8 heuristic
 *       golden (which replayed the latest vintage's edges); reverting the query to `created_at DESC`
 *       flips it red.
 *   (B) the removing deletion happened while capture was off (zero tombstones for that anchor) →
 *       silent zero replay, honest, never an error and never fabricated.
 *   (C) flag OFF: byte-identical to pre-4c-3 (no undeleteInbound field).
 *   (D) same-millisecond tiebreak: two delete revisions share `created_at`; `version ASC, id ASC`
 *       selects a unique, stable anchor (mutation: `version DESC` flips which neighbour replays).
 *   (E) boundary — absent-at-T: a delete at exactly `created_at == T` is the record's latest revision ⇒
 *       absent at T ⇒ NOT resurrected. Pins reconstruct's `<= T` EXCLUSION (the record never reaches the
 *       anchor query), NOT the anchor's `> T` strictness.
 *   (F) boundary — strict `> T` is load-bearing: a re-create at exactly T makes the record PRESENT at T, so
 *       its removing delete is a LATER one; `>= T` would mis-anchor to the prior vintage's same-instant
 *       delete. This is the ONLY golden that reds under `> T` → `>= T`.
 * Over-replay stays impossible regardless of which delete revision anchors, because precondition 6
 * (neighbour consent — replay only what N's OWN live data still declares) gates every edge
 * independently of the anchor.
 *
 * Design-lock: `docs/development/multitable-global-history-4c3-record-undelete-2b-inbound-edge-replay-
 * design-lock-20260708.md` §7; A′ decision: `multitable-global-history-resurrect-anchor-exactness-
 * decision-20260710.md`. Runs only with DATABASE_URL.
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
const T3 = '2026-01-04T00:00:00.000Z'

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
    process.env.MULTITABLE_ENABLE_PIT_REVERT = 'true' // W0 step-1: this file drives revert-execute; the gate is default-OFF, set per-file here and FORCED BACK to the default OFF (delete) in afterAll — never a saved/original value, and NEVER enabled globally.
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
    delete process.env.MULTITABLE_ENABLE_PIT_REVERT // W0 step-1: restore — never leak the revert gate into sibling files' negative controls.
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

  test('(A) multi-vintage: resurrecting an OLDER vintage anchors to THAT vintage\'s deletion (first delete after T) — replays vintage-1, NOT the latest vintage', async () => {
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

    // A′: anchor = FIRST delete after T0_5 = del1 (vintage-1's own deletion). So vintage-1's neighbour
    // replays — the vintage-EXACT edge, matching the resurrected snapshot...
    expect(await edgeCount(F, N1, R)).toBe(1)
    expect(ex.body?.data?.undeleteInbound).toMatchObject({ replayed: 1 })
    // ...and vintage-2's neighbour does NOT — its tombstone lives under a LATER anchor (del2) that a
    // T0_5 revert never reaches. Reverting the anchor query to `created_at DESC` (the R8 heuristic)
    // inverts both assertions: N2 replays, N1 does not.
    expect(await edgeCount(F, N2, R)).toBe(0)
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

  test('(D) same-millisecond tiebreak: two delete revisions share created_at — version ASC, id ASC picks a unique, stable anchor', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const F = mkFieldId('d')
    await insertField(SHEET_B, F)
    const R = mkRecordId('d_r')
    const Na = mkRecordId('d_na') // edge captured under the LOWER-version delete (v2)
    const Nb = mkRecordId('d_nb') // edge captured under the HIGHER-version delete (v4)
    await insertRecord(SHEET_B, Na, { [F]: [R] })
    await insertRecord(SHEET_B, Nb, { [F]: [R] })

    const SNAP_V1 = { [NAME]: 'v1' }
    const SNAP_V2 = { [NAME]: 'v2' }
    await rev(SHEET_A, R, 1, 'create', SNAP_V1, T0)
    // delete v2, restore v3, delete v4 — ALL sharing the same created_at (T1). Rapid same-ms churn.
    const delLo = await rev(SHEET_A, R, 2, 'delete', SNAP_V1, T1)
    await insertTombstone(SHEET_A, F, Na, R, delLo)
    await rev(SHEET_A, R, 3, 'create', SNAP_V2, T1)
    const delHi = await rev(SHEET_A, R, 4, 'delete', SNAP_V2, T1)
    await insertTombstone(SHEET_A, F, Nb, R, delHi)

    // Resurrect at T0_5 (< T1) → the v1 snapshot. Anchor = first delete after T0_5, and with delLo/delHi
    // tied on created_at, `version ASC` picks delLo (v2). Na replays; Nb does not. Mutation: flipping the
    // anchor query to `version DESC` (or dropping the version tiebreak so id decides differently) selects
    // delHi and replays Nb instead ⇒ this golden goes red.
    const pv = await preview(T0_5)
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.undeleteRecordIds).toEqual([R])
    const ex = await execute(T0_5, pv.body?.data?.previewIdentity)
    expect(ex.status).toBe(200)
    expect(ex.body?.data?.resurrectedCount).toBe(1)
    expect(ex.body?.data?.undeleteInbound).toMatchObject({ replayed: 1 })
    expect(await edgeCount(F, Na, R)).toBe(1)
    expect(await edgeCount(F, Nb, R)).toBe(0)
  })

  test('(E) boundary: a delete at exactly created_at == T ⇒ record absent at T ⇒ NOT in the resurrect set (strict > T complements reconstruct\'s <= T)', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const F = mkFieldId('e')
    await insertField(SHEET_B, F)
    const R = mkRecordId('e_r')
    const N = mkRecordId('e_n')
    await insertRecord(SHEET_B, N, { [F]: [R] })

    const SNAP = { [NAME]: 'boundary' }
    await rev(SHEET_A, R, 1, 'create', SNAP, T0)
    const delAtT = await rev(SHEET_A, R, 2, 'delete', SNAP, T2) // deleted at exactly T2
    await insertTombstone(SHEET_A, F, N, R, delAtT)

    // Revert to exactly T2: reconstructRecordsAtT applies `created_at <= T2`, so the delete@T2 is the
    // latest revision ⇒ the record is ABSENT at T2 ⇒ it is never in the "existed at T but deleted now"
    // resurrect set. The strict `created_at > T` anchor query would also skip that delete, but the record
    // never reaches the anchor step because it is excluded upstream.
    const pv = await preview(T2)
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.undeleteRecordIds ?? []).not.toContain(R)
    expect(await edgeCount(F, N, R)).toBe(0) // never resurrected, so no inbound edge replayed
  })

  test('(F) strict > T is load-bearing: a re-create at exactly T means the removing delete is a LATER one — >= T would mis-anchor to the prior vintage\'s delete', async () => {
    // The one shape golden (E) does NOT cover: at exactly T the record EXISTS (a re-create landed at T with
    // a higher version than the same-instant delete of the previous vintage), so it IS in the resurrect set.
    // reconstruct (`created_at <= T`, DISTINCT ON ... version DESC) picks the v3 CREATE as the state at T.
    // The deletion that removed THAT vintage is v4 (T3), strictly after T. Shipped `created_at > T` anchors to
    // v4 (correct). Mutating the query to `created_at >= T` would anchor to v2 (the T2 delete of the OLD
    // vintage) and replay the wrong neighbour — this golden is the ONLY one that reds under `>=`.
    process.env[INBOUND_FLAG] = 'true'
    const F = mkFieldId('f')
    await insertField(SHEET_B, F)
    const R = mkRecordId('f_r')
    const Nv2 = mkRecordId('f_nv2') // edge captured under v2 (the T2 delete of the OLD, un-resurrected vintage)
    const Nv4 = mkRecordId('f_nv4') // edge captured under v4 (the T3 delete of the RESURRECTED vintage)
    await insertRecord(SHEET_B, Nv2, { [F]: [R] })
    await insertRecord(SHEET_B, Nv4, { [F]: [R] })

    const SNAP_V1 = { [NAME]: 'v1' }
    const SNAP_V3 = { [NAME]: 'v3' }
    await rev(SHEET_A, R, 1, 'create', SNAP_V1, T0)
    const dv2 = await rev(SHEET_A, R, 2, 'delete', SNAP_V1, T2) // delete of vintage-1, exactly at T2
    await insertTombstone(SHEET_A, F, Nv2, R, dv2)
    await rev(SHEET_A, R, 3, 'create', SNAP_V3, T2) // re-create at exactly T2 (higher version ⇒ latest <= T2)
    const dv4 = await rev(SHEET_A, R, 4, 'delete', SNAP_V3, T3) // delete of vintage-3, later
    await insertTombstone(SHEET_A, F, Nv4, R, dv4)

    const pv = await preview(T2)
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.undeleteRecordIds).toEqual([R])
    const ex = await execute(T2, pv.body?.data?.previewIdentity)
    expect(ex.status).toBe(200)
    expect(ex.body?.data?.resurrectedCount).toBe(1)
    const live = await liveRow(R)
    expect(live?.data?.[NAME]).toBe('v3') // the AT-T (re-created) vintage was resurrected, not vintage-1
    // strict `> T2` anchors to v4 (vintage-3's own delete) → Nv4 replays, Nv2 does not.
    expect(await edgeCount(F, Nv4, R)).toBe(1)
    expect(await edgeCount(F, Nv2, R)).toBe(0)
    expect(ex.body?.data?.undeleteInbound).toMatchObject({ replayed: 1 })
  })
})
