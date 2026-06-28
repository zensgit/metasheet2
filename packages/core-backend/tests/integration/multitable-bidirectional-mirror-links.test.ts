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
 *   C5 cross-base allow (v1)  — ②b read-only cross-base mirror (2026-06-27): a cross-base twoWay pairing is
 *                               now ALLOWED with a valid foreignBaseId claim (claim == truth). C5b/C5c/C5d
 *                               lock the still-fail-closed cases (no-claim / wrong-claim / one-way-no-claim);
 *                               C5-CREATE proves BOTH sides create end-to-end (the mirror side comes back
 *                               codec read-only — a reverse READ projection, never a cross-base write path).
 *   C6 delete clears the edge — delete B1 ⇒ A1's forward F_A no longer lists B1 (existing cascade) and the
 *                               symmetric reverse is gone.
 *   C7 masked mirror          — an actor without read on sheet A reading B1 ⇒ mirror masked (no A-record
 *                               id/display leak), via the swapped buildLinkSummaries perm chain.
 *   C8 non-twoWay regression  — an ordinary (non-twoWay) link on B does NOT reverse-resolve.
 *   C9 mirror read-only       — a PATCH on the mirror field F_B is rejected (no second materialized edge).
 *   C-XB-MASK (security)      — cross-base mirror (SX→SA): both readers hold global multitable:read so the
 *                               SHEET gate passes; base-read is the sole decider — denied ⇒ [] (raw /view,
 *                               raw single-GET, AND linkSummaries), permitted ⇒ [REC_A1]. (raw wire = site 2
 *                               maskDerivedMirrorFieldIds; summary wire = buildLinkSummaries Sink B-1.)
 *   C-XB-RO                   — a PATCH on the cross-base mirror field is rejected (read-only, no edge).
 *   C-XB-NOFANOUT             — a cross-base forward write does NOT fan a mirror invalidation to the foreign
 *                               base sheet (site 3 v1 defer; read recomputes + masks on next fetch).
 *   C-SB-TRUTHFUL-CLAIM       — a SAME-base twoWay write whose forward field carries a TRUTHFUL own-base
 *                               foreignBaseId STILL fans the mirror invalidation (claim presence != cross-base;
 *                               site 3 compares real sheet bases, not claim presence). [P2 regression guard]
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

// ②b read-only cross-base mirror v1 (2026-06-27): forward SA(BASE) → SX(XBASE) twoWay + cross-base claim;
// mirror on SX → SA (mirrorOf, codec-forced read-only). Reading SX/REC_X1's mirror reverse-projects a BASE
// record (REC_A1) → base-read gated. SA/SX already exist (SA=BASE, SX=XBASE) from the C5 layout above.
const FLD_A_XLINK = `fld_bdl_a_xlink_${TS}` // forward twoWay link SA → SX, foreignBaseId=XBASE_ID
const FLD_X_MIRROR = `fld_bdl_x_mirror_${TS}` // mirror twoWay link SX → SA, mirrorOf=FLD_A_XLINK, foreignBaseId=BASE_ID

// P2 regression guard (2026-06-27): a SAME-base twoWay link carrying a TRUTHFUL own-base foreignBaseId — a
// legal config (cross-base-link-optin XB-3b) whose mirror push must NOT be deferred (claim presence is NOT
// cross-base). SA and SB are both in BASE_ID, so this pairing is same-base despite the explicit claim.
const FLD_A_LINK2 = `fld_bdl_a_link2_${TS}` // same-base twoWay link SA → SB, foreignBaseId=BASE_ID (truthful own-base)
const FLD_B_MIRROR2 = `fld_bdl_b_mirror2_${TS}` // its mirror on SB → SA, mirrorOf=FLD_A_LINK2

const REC_A1 = `rec_bdl_a1_${TS}`
const REC_A2 = `rec_bdl_a2_${TS}` // a SECOND A linking B1 → mirror is multi-value
const REC_B1 = `rec_bdl_b1_${TS}`
const REC_X1 = `rec_bdl_x1_${TS}` // a record in SX (XBASE_ID) — its mirror reverse-projects REC_A1 (cross-base)

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

    // ②b cross-base fixtures: forward FLD_A_XLINK on SA (BASE) → SX (XBASE) twoWay + cross-base claim; mirror
    // FLD_X_MIRROR on SX → SA, mirrorOf=forward (codec forces readOnly). One edge (FLD_A_XLINK, REC_A1, REC_X1)
    // ⇒ reading SX/REC_X1's mirror reverse-projects REC_A1 (a BASE record) — the base-read gate decides.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_A_XLINK, SA, 'AXLink', 'link', JSON.stringify({ foreignSheetId: SX, foreignBaseId: XBASE_ID, twoWay: true, mirrorFieldId: FLD_X_MIRROR }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_X_MIRROR, SX, 'XMirror', 'link', JSON.stringify({ foreignSheetId: SA, foreignBaseId: BASE_ID, twoWay: true, mirrorFieldId: FLD_A_XLINK, mirrorOf: FLD_A_XLINK }), 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_X1, SX, JSON.stringify({})])
    await seedEdge(FLD_A_XLINK, REC_A1, REC_X1)

    // P2 guard fixtures: a SAME-base twoWay pairing (SA↔SB, both BASE_ID) where the forward field carries a
    // truthful own-base foreignBaseId. No edge seeded — the golden writes the forward edge and asserts the
    // mirror invalidation still fans (it must NOT be deferred just because foreignBaseId is present).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_A_LINK2, SA, 'ALink2', 'link', JSON.stringify({ foreignSheetId: SB, foreignBaseId: BASE_ID, twoWay: true, mirrorFieldId: FLD_B_MIRROR2 }), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_B_MIRROR2, SB, 'BMirror2', 'link', JSON.stringify({ foreignSheetId: SA, foreignBaseId: BASE_ID, twoWay: true, mirrorFieldId: FLD_A_LINK2, mirrorOf: FLD_A_LINK2 }), 4])
  })

  beforeEach(() => {
    publishSpy.mockClear()
    currentUser = { id: USER_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
  })

  afterAll(async () => {
    publishSpy.mockRestore()
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_A_LINK, FLD_B_MIRROR, FLD_B_PLAIN, FLD_A_XLINK, FLD_X_MIRROR, FLD_A_LINK2, FLD_B_MIRROR2]]).catch(() => {})
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

  // C5 — ②b read-only cross-base mirror v1 (2026-06-27): the OLD blanket reject is REPLACED by allow-on-claim.
  // A cross-base twoWay link is now ALLOWED iff it carries an EXPLICIT foreignBaseId == the foreign sheet's
  // real base (claim == truth); no-claim / wrong-claim / one-way-no-claim all still fail closed.
  test('C5: cross-base twoWay pairing is now ALLOWED with a valid foreignBaseId claim (lift of the §7.2 reject)', async () => {
    const res = await request(app).post('/api/multitable/fields').send({
      sheetId: SA,
      name: `XLinkOk_${TS}`,
      type: 'link',
      property: { foreignSheetId: SX, foreignBaseId: XBASE_ID, twoWay: true, mirrorFieldId: `mfxok_${TS}` },
    })
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
  })

  test('C5b: cross-base twoWay with NO foreignBaseId claim still fails closed (400)', async () => {
    const res = await request(app).post('/api/multitable/fields').send({
      sheetId: SA,
      name: `XLinkNoClaim_${TS}`,
      type: 'link',
      property: { foreignSheetId: SX, twoWay: true, mirrorFieldId: `mfxnc_${TS}` }, // no foreignBaseId
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('C5c: cross-base twoWay with a WRONG foreignBaseId claim still fails closed (claim != truth → 400)', async () => {
    const res = await request(app).post('/api/multitable/fields').send({
      sheetId: SA,
      name: `XLinkWrong_${TS}`,
      type: 'link',
      property: { foreignSheetId: SX, foreignBaseId: BASE_ID, twoWay: true, mirrorFieldId: `mfxwr_${TS}` }, // claims SA's own base, not SX's
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('C5d: a ONE-WAY cross-base link STILL requires the foreignBaseId claim (no-claim → 400, original ②b gate intact)', async () => {
    const res = await request(app).post('/api/multitable/fields').send({
      sheetId: SA,
      name: `XLinkOnewayNoClaim_${TS}`,
      type: 'link',
      property: { foreignSheetId: SX }, // one-way, no claim → original cross-base gate still rejects
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  // Advisor item 2 — the read goldens SQL-seed the cross-base mirror, so this is the ONLY proof the CREATE
  // PATH (validateLinkFieldConfig at field-create) accepts BOTH sides end-to-end. The MIRROR side (a
  // cross-base link carrying mirrorOf + a back-claim to BASE) hits the SAME lifted branch and is the side
  // most likely to break; assert it creates AND returns codec-forced read-only (no cross-base WRITE path).
  test('C5-CREATE: forward (SA→SX) AND mirror (SX→SA) cross-base twoWay fields both create end-to-end; mirror is read-only', async () => {
    const fwdId = `fld_bdl_a_xcr_${TS}`
    const mirId = `fld_bdl_x_xcr_${TS}`
    const fwd = await request(app).post('/api/multitable/fields').send({
      sheetId: SA,
      id: fwdId,
      name: `XCreateFwd_${TS}`,
      type: 'link',
      property: { foreignSheetId: SX, foreignBaseId: XBASE_ID, twoWay: true, mirrorFieldId: mirId },
    })
    expect(fwd.status).toBeGreaterThanOrEqual(200)
    expect(fwd.status).toBeLessThan(300)
    const mir = await request(app).post('/api/multitable/fields').send({
      sheetId: SX,
      id: mirId,
      name: `XCreateMir_${TS}`,
      type: 'link',
      property: { foreignSheetId: SA, foreignBaseId: BASE_ID, twoWay: true, mirrorFieldId: fwdId, mirrorOf: fwdId },
    })
    expect(mir.status).toBeGreaterThanOrEqual(200)
    expect(mir.status).toBeLessThan(300)
    // the derived side comes back read-only (codec mirrorOf ⇒ readOnly) — a reverse READ projection only.
    const mirror = (await viewFields(SX)).find((f) => f.id === mirId)
    expect(mirror?.property?.mirrorOf).toBe(fwdId)
    expect(mirror?.property?.readOnly).toBe(true)
    // tidy the throwaway created fields (afterAll also cleans by sheet, but keep later reads byte-clean).
    await q('DELETE FROM meta_fields WHERE id = ANY($1::text[])', [[fwdId, mirId]]).catch(() => {})
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

  // ②b cross-base mirror — SECURITY GOLDEN. Reading SX/REC_X1's mirror reverse-projects REC_A1 (a BASE
  // record). BOTH readers carry global multitable:read (so the SHEET gate on SA passes for both) — the ONLY
  // difference is multitable:base:read, so the cross-base BASE-READ gate is the sole decider:
  //   denied (no base:read) → mirror emptied (no foreign-record id/count leak); permitted (+base:read) →
  //   mirror shows [REC_A1]. The RAW data[mirror] wire is gated by maskDerivedMirrorFieldIds (site 2, the
  //   change under test); the linkSummaries wire is gated independently by buildLinkSummaries (Sink B-1).
  const XB_DENIED = { id: `u_xb_no_${TS}`, roles: ['member'], perms: ['multitable:read'] }
  const XB_OK = { id: `u_xb_ok_${TS}`, roles: ['member'], perms: ['multitable:read', 'multitable:base:read'] }

  test('C-XB-MASK (/view raw): cross-base mirror data is [] for a base-denied reader, [REC_A1] for a base-permitted reader', async () => {
    currentUser = XB_DENIED
    expect(((await viewRawRecordData(SX, REC_X1))[FLD_X_MIRROR] as string[]) ?? []).toEqual([])
    currentUser = XB_OK
    expect(((await viewRawRecordData(SX, REC_X1))[FLD_X_MIRROR] as string[]) ?? []).toEqual([REC_A1])
  })

  test('C-XB-MASK (single-GET raw): cross-base mirror data is [] for a base-denied reader, [REC_A1] for a base-permitted reader', async () => {
    currentUser = XB_DENIED
    expect(((await getRecordRawData(SX, REC_X1))[FLD_X_MIRROR] as string[]) ?? []).toEqual([])
    currentUser = XB_OK
    expect(((await getRecordRawData(SX, REC_X1))[FLD_X_MIRROR] as string[]) ?? []).toEqual([REC_A1])
  })

  test('C-XB-MASK (linkSummaries): the inline summary wire is base-read gated too ([] for denied, [REC_A1] for permitted)', async () => {
    currentUser = XB_DENIED
    expect(((await viewLinkSummaries(SX))[REC_X1]?.[FLD_X_MIRROR] ?? []).map((s) => s.id)).toEqual([])
    currentUser = XB_OK
    expect(((await viewLinkSummaries(SX))[REC_X1]?.[FLD_X_MIRROR] ?? []).map((s) => s.id)).toEqual([REC_A1])
  })

  test('C-XB-RO: a PATCH on the cross-base mirror field is rejected (read-only; no edge written under the mirror id)', async () => {
    const before = await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1', [FLD_X_MIRROR])
    const res = await patch(SX, REC_X1, FLD_X_MIRROR, [REC_A1])
    expect(res.status).toBeGreaterThanOrEqual(400)
    const after = await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1', [FLD_X_MIRROR])
    expect((after.rows as Array<{ n: number }>)[0].n).toBe((before.rows as Array<{ n: number }>)[0].n)
    expect((after.rows as Array<{ n: number }>)[0].n).toBe(0)
  })

  test('C-XB-NOFANOUT: a CROSS-BASE forward write does NOT fan a mirror invalidation to the foreign-base sheet (site 3 v1 defer; parity with C3)', async () => {
    // Full-perms writer so the cross-base forward write can never be perm-blocked — the defer under test is
    // based on the actual source/foreign sheet base comparison (crossBaseMirrorForeignSheetIds), independent
    // of the actor's permissions.
    currentUser = { id: `u_xb_writer_${TS}`, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:base:admin'] }
    publishSpy.mockClear()
    const newX = `rec_bdl_xnew_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [newX, SX, JSON.stringify({})])
    // the forward cross-base write SUCCEEDS (the write path RAN — so an absent fan-out is a real defer, not a failed write)
    const res = await patch(SA, REC_A1, FLD_A_XLINK, [REC_X1, newX])
    expect(res.status).toBe(200)
    const fwd = await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1 AND foreign_record_id = $2', [FLD_A_XLINK, newX])
    expect((fwd.rows as Array<{ n: number }>)[0].n).toBe(1)
    // … but NO mirror-invalidation event was fanned to SX (cross-base realtime push is deferred in v1).
    const xMirrorEvents = sheetEvents(SX).filter((e) => (e.fieldIds ?? []).includes(FLD_X_MIRROR))
    expect(xMirrorEvents).toEqual([])
    // restore the shared fixture (drop the throwaway edge + record; reset REC_A1's forward to just REC_X1)
    await q('DELETE FROM meta_links WHERE field_id = $1 AND foreign_record_id = $2', [FLD_A_XLINK, newX]).catch(() => {})
    await q('DELETE FROM meta_records WHERE id = $1', [newX]).catch(() => {})
    await q('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [JSON.stringify({ [FLD_A_XLINK]: [REC_X1] }), REC_A1]).catch(() => {})
  })

  // [P2 regression] claim presence is NOT cross-base. FLD_A_LINK2 is SAME-base (SA & SB both BASE_ID) but
  // carries a truthful own-base foreignBaseId — a legal config (XB-3b). The old `cfg.foreignBaseId != null`
  // discriminator would wrongly DEFER its mirror push; the fix resolves the real bases, sees same-base, and
  // keeps the fan-out. Writing the forward edge must still emit the SB mirror invalidation event. (RED under
  // the old predicate, GREEN under the actual-base resolution.)
  test('C-SB-TRUTHFUL-CLAIM: a SAME-base twoWay write with a truthful own-base foreignBaseId STILL fans the mirror invalidation', async () => {
    currentUser = { id: `u_sb_writer_${TS}`, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    publishSpy.mockClear()
    const res = await patch(SA, REC_A1, FLD_A_LINK2, [REC_B1])
    expect(res.status).toBe(200)
    const mirrorEvents = sheetEvents(SB).filter(
      (e) => (e.fieldIds ?? []).includes(FLD_B_MIRROR2) && (e.recordIds ?? []).includes(REC_B1),
    )
    expect(mirrorEvents.length).toBeGreaterThan(0)
    // restore: drop the throwaway edge + remove the key from REC_A1 (it never carried FLD_A_LINK2)
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_A_LINK2]).catch(() => {})
    await q('UPDATE meta_records SET data = data - $1::text WHERE id = $2', [FLD_A_LINK2, REC_A1]).catch(() => {})
  })
})
