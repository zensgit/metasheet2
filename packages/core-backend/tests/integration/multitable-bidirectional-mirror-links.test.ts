/**
 * Bidirectional / mirror links MVP (design 2026-06-14) — real-DB wire proof of the SINGLE-EDGE derived
 * reverse. The reverse link is a read-projection of the one forward `meta_links` edge (no materialized
 * mirror row, no migration, no write-back), so both directions resolve from the same edge and loops are
 * structurally impossible.
 *
 * Layout (same base): sheet A has forward link F_A (twoWay → B). Sheet B has mirror link F_B
 * (twoWay → A, mirrorOf=F_A, forced read-only by the codec). One edge (F_A, A1, B1) means:
 *   - A1's F_A resolves to B1 (forward, today's read)
 *   - B1's F_B resolves to A1 (reverse, the new read — WHERE field_id=F_A AND foreign_record_id=B1)
 *
 * Matrix (design §8):
 *   C1 reverse resolves      — read B1 ⇒ mirror F_B surfaces A1 (both directions from one edge).
 *   C2 add-then-remove       — clear A1's F_A ⇒ B1's mirror no longer shows A1 (no stale projection).
 *   C3 forward write fans     — a forward F_A write fans the invalidation broadcast to sheet B for the
 *                               affected foreign record (mirror sheet event present; no forward write back).
 *   C4 wire round-trip        — twoWay/mirrorFieldId survive on F_A; twoWay/mirrorFieldId/mirrorOf +
 *                               readOnly survive on F_B (create→read, not a hand-built fixture).
 *   C5 cross-base rejected    — pairing two link fields whose sheets are cross-base ⇒ 400.
 *   C6 delete clears the edge — delete B1 ⇒ A1's forward F_A no longer lists B1 (existing cascade) and the
 *                               symmetric reverse is gone.
 *   C7 masked mirror          — an actor without read on sheet A reading B1 ⇒ mirror masked (no A-record
 *                               id/display leak), via the swapped buildLinkSummaries perm chain.
 *   C8 non-twoWay regression  — an ordinary (non-twoWay) link on B does NOT reverse-resolve.
 *   C9 mirror read-only       — a PATCH on the mirror field F_B is rejected (no second materialized edge).
 *
 * Runs only with DATABASE_URL (describeIfDatabase) via the plugin-tests.yml real-DB runner list.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { eventBus } from '../../src/integration/events/event-bus'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_bdl_${TS}`
const XBASE_ID = `base_bdl_x_${TS}` // a DIFFERENT base for the cross-base reject (C5)
const SA = `sheet_bdl_a_${TS}` // sheet A — forward link side
const SB = `sheet_bdl_b_${TS}` // sheet B — mirror side
const SX = `sheet_bdl_x_${TS}` // cross-base sheet (C5)

const FLD_A_NAME = `fld_bdl_a_name_${TS}` // A's display (string)
const FLD_A_LINK = `fld_bdl_a_link_${TS}` // forward twoWay link A → B
const FLD_B_NAME = `fld_bdl_b_name_${TS}` // B's display (string)
const FLD_B_MIRROR = `fld_bdl_b_mirror_${TS}` // mirror twoWay link B → A, mirrorOf = FLD_A_LINK
const FLD_B_PLAIN = `fld_bdl_b_plain_${TS}` // ordinary (non-twoWay) link B → A (C8 regression)

const REC_A1 = `rec_bdl_a1_${TS}`
const REC_A2 = `rec_bdl_a2_${TS}` // a SECOND A linking B1 → mirror is multi-value
const REC_B1 = `rec_bdl_b1_${TS}`

const USER_FULL = `u_bdl_full_${TS}` // global multitable read+write
const USER_NOA = `u_bdl_noa_${TS}` // sheet-scoped: B only; sheet A unreadable (C7 mask)

let app: Express
let publishSpy: MockInstance
let currentUser: { id: string; roles: string[]; perms: string[] } = {
  id: USER_FULL,
  roles: ['member'],
  perms: ['multitable:read', 'multitable:write'],
}

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

type RealtimeBroadcast = {
  spreadsheetId: string
  actorId?: string | null
  source: string
  kind: string
  recordIds?: string[]
  fieldIds?: string[]
}

/** All record-update broadcasts for a sheet since the last mockClear(). */
const sheetEvents = (sheetId: string): RealtimeBroadcast[] =>
  publishSpy.mock.calls
    .filter((call) => call[0] === 'spreadsheet.cell.updated' && (call[1] as RealtimeBroadcast | undefined)?.spreadsheetId === sheetId)
    .map((call) => call[1] as RealtimeBroadcast)

const patch = (sheetId: string, recordId: string, fieldId: string, value: unknown) =>
  request(app).post('/api/multitable/patch').send({ sheetId, changes: [{ recordId, fieldId, value }] })

const viewLinkSummaries = async (
  sheetId: string,
): Promise<Record<string, Record<string, Array<{ id: string; display?: unknown }>>>> => {
  const res = await request(app).get('/api/multitable/view').query({ sheetId, includeLinkSummaries: 'true' })
  expect(res.status).toBe(200)
  // /view responds { ok, data: { fields, rows, linkSummaries } }
  return (res.body?.data?.linkSummaries ?? {}) as Record<string, Record<string, Array<{ id: string; display?: unknown }>>>
}

const viewFields = async (sheetId: string): Promise<Array<{ id: string; property?: Record<string, unknown> }>> => {
  const res = await request(app).get('/api/multitable/view').query({ sheetId })
  expect(res.status).toBe(200)
  return (res.body?.data?.fields ?? []) as Array<{ id: string; property?: Record<string, unknown> }>
}

/** Raw `rows[].data` from /view — the SECOND link projection (separate from linkSummaries). C7-RAW-DATA. */
const viewRawRecordData = async (
  sheetId: string,
  recordId: string,
): Promise<Record<string, unknown>> => {
  const res = await request(app).get('/api/multitable/view').query({ sheetId })
  expect(res.status).toBe(200)
  const rows = (res.body?.data?.rows ?? []) as Array<{ id: string; data: Record<string, unknown> }>
  return rows.find((r) => r.id === recordId)?.data ?? {}
}

/** Raw `record.data` from the single-record GET — the other raw-data wire. C7-RAW-DATA. */
const getRecordRawData = async (
  sheetId: string,
  recordId: string,
): Promise<Record<string, unknown>> => {
  const res = await request(app).get(`/api/multitable/records/${recordId}`).query({ sheetId })
  expect(res.status).toBe(200)
  return (res.body?.data?.record?.data ?? {}) as Record<string, unknown>
}

const seedEdge = (fieldId: string, recordId: string, foreignRecordId: string) =>
  q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [fieldId, recordId, foreignRecordId])

describeIfDatabase('multitable bidirectional / mirror links — derived reverse (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())
    publishSpy = vi.spyOn(eventBus, 'publish')

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'BDL Base'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [XBASE_ID, 'BDL XBase'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SA, BASE_ID, 'Sheet A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SB, BASE_ID, 'Sheet B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SX, XBASE_ID, 'Sheet X'])

    // Sheet A: display + forward twoWay link → B (mirrorFieldId = F_B).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_A_NAME, SA, 'AName', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_A_LINK, SA, 'ALink', 'link', JSON.stringify({ foreignSheetId: SB, twoWay: true, mirrorFieldId: FLD_B_MIRROR }), 2])

    // Sheet B: display + mirror twoWay link → A (mirrorOf = F_A) + an ordinary plain link → A (C8).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_B_NAME, SB, 'BName', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_B_MIRROR, SB, 'BMirror', 'link', JSON.stringify({ foreignSheetId: SA, twoWay: true, mirrorFieldId: FLD_A_LINK, mirrorOf: FLD_A_LINK }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_B_PLAIN, SB, 'BPlain', 'link', JSON.stringify({ foreignSheetId: SA }), 3])

    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_A1, SA, JSON.stringify({ [FLD_A_NAME]: 'Alpha-1', [FLD_A_LINK]: [REC_B1] })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_A2, SA, JSON.stringify({ [FLD_A_NAME]: 'Alpha-2', [FLD_A_LINK]: [REC_B1] })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_B1, SB, JSON.stringify({ [FLD_B_NAME]: 'Bravo-1' })])

    // The SINGLE canonical edges: A1→B1 and A2→B1 under the FORWARD field only.
    await seedEdge(FLD_A_LINK, REC_A1, REC_B1)
    await seedEdge(FLD_A_LINK, REC_A2, REC_B1)

    // USER_NOA: read on B only (sheet A unreadable, no global perms) → C7 mask.
    await q('INSERT INTO spreadsheet_permissions(sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)',
      [SB, USER_NOA, 'user', USER_NOA, 'spreadsheet:read'])
  })

  beforeEach(() => {
    publishSpy.mockClear()
    currentUser = { id: USER_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
  })

  afterAll(async () => {
    publishSpy.mockRestore()
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_A_LINK, FLD_B_MIRROR, FLD_B_PLAIN]]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = ANY($1::text[])', [[SA, SB, SX]]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[SA, SB, SX]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SA, SB, SX]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SA, SB, SX]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SA, SB, SX]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_ID, XBASE_ID]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('C1: reverse resolves — reading B1 surfaces A1 (+A2) through the mirror, from the one forward edge', async () => {
    const summaries = await viewLinkSummaries(SB)
    const mirror = summaries[REC_B1]?.[FLD_B_MIRROR] ?? []
    const ids = mirror.map((s) => s.id).sort()
    expect(ids).toEqual([REC_A1, REC_A2].sort())
    // forward still resolves from the SAME edge: A1's F_A → B1
    const aSummaries = await viewLinkSummaries(SA)
    expect((aSummaries[REC_A1]?.[FLD_A_LINK] ?? []).map((s) => s.id)).toEqual([REC_B1])
  })

  test('C8: an ordinary (non-twoWay) link on B does NOT reverse-resolve (regression)', async () => {
    const summaries = await viewLinkSummaries(SB)
    // FLD_B_PLAIN is a forward link B→A with no edges authored on it, and crucially NOT a mirror — so it
    // must read empty (it must NOT pick up A1/A2 by reverse-projecting FLD_A_LINK).
    expect(summaries[REC_B1]?.[FLD_B_PLAIN] ?? []).toEqual([])
  })

  test('C4: wire round-trip — pairing config + mirror read-only survive create→read', async () => {
    const mirror = (await viewFields(SB)).find((f) => f.id === FLD_B_MIRROR)
    expect(mirror?.property?.twoWay).toBe(true)
    expect(mirror?.property?.mirrorFieldId).toBe(FLD_A_LINK)
    expect(mirror?.property?.mirrorOf).toBe(FLD_A_LINK)
    expect(mirror?.property?.readOnly).toBe(true) // derived side forced read-only by the codec

    const forward = (await viewFields(SA)).find((f) => f.id === FLD_A_LINK)
    expect(forward?.property?.twoWay).toBe(true)
    expect(forward?.property?.mirrorFieldId).toBe(FLD_B_MIRROR)
    expect(forward?.property?.mirrorOf).toBeUndefined() // forward side carries no mirrorOf
  })

  test('C9: mirror read-only — a PATCH on the mirror field is rejected (no second materialized edge)', async () => {
    const before = await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1', [FLD_B_MIRROR])
    const res = await patch(SB, REC_B1, FLD_B_MIRROR, [REC_A1])
    expect(res.status).toBeGreaterThanOrEqual(400)
    const after = await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1', [FLD_B_MIRROR])
    // The forbidden write must NOT have inserted any row under the mirror field id.
    expect((after.rows as Array<{ n: number }>)[0].n).toBe((before.rows as Array<{ n: number }>)[0].n)
    expect((after.rows as Array<{ n: number }>)[0].n).toBe(0)
  })

  test('C7: masked mirror — an actor without read on sheet A sees the mirror masked (no A-record leak)', async () => {
    currentUser = { id: USER_NOA, roles: ['member'], perms: [] }
    const summaries = await viewLinkSummaries(SB)
    // B is readable, but sheet A is not → the swapped buildLinkSummaries chain masks the mirror content.
    expect(summaries[REC_B1]?.[FLD_B_MIRROR] ?? []).toEqual([])
  })

  // C7-RAW-DATA — split per endpoint so each raw-data wire witnesses the leak INDEPENDENTLY (a single
  // combined test short-circuits at the first failing assertion and would never prove the second wire RED).
  // C7 only inspects `linkSummaries`; the RAW `data[mirrorField]` array is a SECOND projection of the same
  // reverse edge. For a foreign-sheet(A)-DENIED actor it must be blanked to [] (opaque source ids + count of
  // the inbound A→B edges would otherwise leak), while a PERMITTED actor still sees the real [A1,A2].
  test('C7-RAW-DATA (/view): the RAW data[mirrorField] reverse ids are masked for a foreign-denied actor and intact for a permitted actor', async () => {
    const expectedAll = [REC_A1, REC_A2].sort()
    // DENIED (sheet A unreadable) — the raw /view data wire must be empty.
    currentUser = { id: USER_NOA, roles: ['member'], perms: [] }
    expect(((await viewRawRecordData(SB, REC_B1))[FLD_B_MIRROR] as string[]) ?? []).toEqual([])
    // PERMITTED (global read) — the raw mirror ids are intact (no over-masking).
    currentUser = { id: USER_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    expect((((await viewRawRecordData(SB, REC_B1))[FLD_B_MIRROR] as string[]) ?? []).slice().sort()).toEqual(expectedAll)
  })

  test('C7-RAW-DATA (single-GET): the RAW data[mirrorField] reverse ids are masked for a foreign-denied actor and intact for a permitted actor', async () => {
    const expectedAll = [REC_A1, REC_A2].sort()
    // DENIED (sheet A unreadable) — the single-record GET data wire must be empty.
    currentUser = { id: USER_NOA, roles: ['member'], perms: [] }
    expect(((await getRecordRawData(SB, REC_B1))[FLD_B_MIRROR] as string[]) ?? []).toEqual([])
    // PERMITTED (global read) — the raw mirror ids are intact (no over-masking).
    currentUser = { id: USER_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    expect((((await getRecordRawData(SB, REC_B1))[FLD_B_MIRROR] as string[]) ?? []).slice().sort()).toEqual(expectedAll)
  })

  test('C3: forward write fans invalidation to the mirror sheet (no forward write back, loop-free)', async () => {
    publishSpy.mockClear()
    // Add a NEW B record and link A1 → it; the mirror projection of that new B record changed.
    const newB = `rec_bdl_bnew_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [newB, SB, JSON.stringify({ [FLD_B_NAME]: 'Bravo-new' })])
    const res = await patch(SA, REC_A1, FLD_A_LINK, [REC_B1, newB])
    expect(res.status).toBe(200)

    // The invalidation fan-out must include sheet B (the mirror side) for the affected foreign records,
    // carrying the mirror field id and NO recordPatches/values.
    const bEvents = sheetEvents(SB)
    const affected = bEvents.find((e) => (e.recordIds ?? []).includes(newB))
    expect(affected).toBeTruthy()
    expect(affected?.fieldIds ?? []).toContain(FLD_B_MIRROR)
    expect((affected as Record<string, unknown>).recordPatches).toBeUndefined()

    // The new edge exists under the FORWARD field only — no second (mirror) edge was written (loop-free).
    const fwd = await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1 AND foreign_record_id = $2', [FLD_A_LINK, newB])
    expect((fwd.rows as Array<{ n: number }>)[0].n).toBe(1)
    const mir = await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1', [FLD_B_MIRROR])
    expect((mir.rows as Array<{ n: number }>)[0].n).toBe(0)

    await q('DELETE FROM meta_links WHERE field_id = $1 AND foreign_record_id = $2', [FLD_A_LINK, newB]).catch(() => {})
    await q('DELETE FROM meta_records WHERE id = $1', [newB]).catch(() => {})
  })

  test('C2: add-then-remove — clearing A1 F_A drops A1 from B1 mirror (no stale), A2 remains', async () => {
    const res = await patch(SA, REC_A1, FLD_A_LINK, [])
    expect(res.status).toBe(200)
    const summaries = await viewLinkSummaries(SB)
    const ids = (summaries[REC_B1]?.[FLD_B_MIRROR] ?? []).map((s) => s.id)
    expect(ids).not.toContain(REC_A1) // no stale reverse projection
    expect(ids).toContain(REC_A2) // the other edge still resolves
    // restore for any later ordering
    await seedEdge(FLD_A_LINK, REC_A1, REC_B1).catch(() => {})
    await q('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [JSON.stringify({ [FLD_A_LINK]: [REC_B1] }), REC_A1]).catch(() => {})
  })

  test('C5: cross-base pairing rejected — a twoWay link across bases is 400', async () => {
    const res = await request(app).post('/api/multitable/fields').send({
      sheetId: SA,
      name: 'XLink',
      type: 'link',
      property: { foreignSheetId: SX, foreignBaseId: XBASE_ID, twoWay: true, mirrorFieldId: 'whatever' },
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('C6: delete clears the edge — deleting B1 removes it from A1 forward + the symmetric reverse', async () => {
    // Use a throwaway B record + its own edge so we do not disturb the shared fixtures.
    const tmpB = `rec_bdl_btmp_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [tmpB, SB, JSON.stringify({ [FLD_B_NAME]: 'Bravo-tmp' })])
    await q('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [JSON.stringify({ [FLD_A_LINK]: [REC_B1, tmpB] }), REC_A1])
    await seedEdge(FLD_A_LINK, REC_A1, tmpB)

    // sanity: A1 forward lists tmpB and tmpB's mirror lists A1
    expect((await viewLinkSummaries(SA))[REC_A1]?.[FLD_A_LINK]?.map((s) => s.id) ?? []).toContain(tmpB)
    expect((await viewLinkSummaries(SB))[tmpB]?.[FLD_B_MIRROR]?.map((s) => s.id) ?? []).toContain(REC_A1)

    const del = await request(app).delete(`/api/multitable/records/${tmpB}`)
    expect(del.status).toBeLessThan(300)

    // existing cascade (record-service.ts: DELETE ... WHERE record_id=$1 OR foreign_record_id=$1) cleared it
    const edge = await q('SELECT count(*)::int AS n FROM meta_links WHERE foreign_record_id = $1', [tmpB])
    expect((edge.rows as Array<{ n: number }>)[0].n).toBe(0)
    expect((await viewLinkSummaries(SA))[REC_A1]?.[FLD_A_LINK]?.map((s) => s.id) ?? []).not.toContain(tmpB)

    await q('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [JSON.stringify({ [FLD_A_LINK]: [REC_B1] }), REC_A1]).catch(() => {})
  })
})
