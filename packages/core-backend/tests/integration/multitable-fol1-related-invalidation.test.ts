/**
 * FOL-1 (formula-over-lookup followups design 2026-06-10 §2) — related-record downstream
 * invalidation, real-DB wire proof at the realtime broadcast layer.
 *
 * A-full (#2450) materializes formulas onto RELATED records, but Step 6 only published for
 * the edited source sheet — related-table watchers got zero signal. FOL-1 adds a pure
 * invalidation fan-out (no new event kind, no values, no recordPatches) gated on the
 * AFFECTED set (the #2450 F1 dependency-gate result), NOT on echo presence:
 *  - R1: foreign target edit → ONE `record-updated` on the related sheet; recordIds = only
 *    the affected related records (echo-only linked records excluded); fieldIds = UNMASKED
 *    affected lookup + recomputed formula ids — proven with a field_permissions-denied
 *    actor: the denied formula id is absent from the echo but PRESENT in fieldIds; the
 *    cross-sheet event omits actorId and the broadcast carries no recordPatches/values.
 *  - R2: same-sheet self-link → a SECOND event on the source sheet for the related record,
 *    WITH actorId (the editor's tab already merged the response echo; no redundant GET).
 *  - R3: a related sheet the actor cannot read is skipped by the helper → zero events.
 *  - R4: unrelated-field edit (AF3 scenario) → related sheets get ZERO events even though
 *    the helper still echoes the linked records (publish gate = affected gate).
 *  - R5: main-event regression — the source-sheet publish keeps its exact pre-FOL-1 shape.
 *
 * R6/R7 (Yjs bridge no-op + read-side invalidator plumbing) are unit-level in
 * tests/unit/record-write-service.test.ts. Assertion layer here = eventBus spy on the
 * shared singleton (same channel as multitable-sheet-realtime.api.test.ts — CollabService
 * forwards verbatim, covered elsewhere) + AF-suite-style DB-level materialization asserts.
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
const BASE_ID = `base_fol1_${TS}`
const FS = `sheet_fol1_foreign_${TS}` // foreign/source sheet (edited throughout R1/R3/R4/R5)
const MS = `sheet_fol1_main_${TS}` // related: link + lookup + formula (deny-masked field for R1)
const NS = `sheet_fol1_noread_${TS}` // related: unreadable to USER_LIMITED (R3)
const SS = `sheet_fol1_self_${TS}` // self-link sheet (R2)

const FLD_FTARGET = `fld_fol1_ftarget_${TS}`
const FLD_FNOISE = `fld_fol1_fnoise_${TS}`
const FLD_M_LINK = `fld_fol1_m_link_${TS}`
const FLD_M_LINKB = `fld_fol1_m_linkb_${TS}` // second link -> FS with NO lookup over it (echo-only lane)
const FLD_M_LU = `fld_fol1_m_lu_${TS}`
const FLD_M_F = `fld_fol1_m_f_${TS}` // deny-masked for USER_DENY — must STILL appear in fieldIds
const FLD_N_LINK = `fld_fol1_n_link_${TS}`
const FLD_N_LU = `fld_fol1_n_lu_${TS}`
const FLD_N_F = `fld_fol1_n_f_${TS}`
const FLD_S_TARGET = `fld_fol1_s_target_${TS}`
const FLD_S_LINK = `fld_fol1_s_link_${TS}`
const FLD_S_LU = `fld_fol1_s_lu_${TS}`
const FLD_S_F = `fld_fol1_s_f_${TS}`

const REC_F1 = `rec_fol1_f1_${TS}` // target = 9, the record edited throughout
const REC_M1 = `rec_fol1_m1_${TS}` // linked to F1 via FLD_M_LINK → affected on target edits
const REC_M2 = `rec_fol1_m2_${TS}` // linked to F1 ONLY via FLD_M_LINKB → echoed but never affected
const REC_N1 = `rec_fol1_n1_${TS}`
const REC_S1 = `rec_fol1_s1_${TS}` // self-link source (edited in R2)
const REC_S2 = `rec_fol1_s2_${TS}` // links to S1 → the same-sheet related record

const USER_FULL = `u_fol1_full_${TS}` // global multitable read+write
const USER_DENY = `u_fol1_deny_${TS}` // global perms, but M's formula field is deny-masked (R1)
const USER_LIMITED = `u_fol1_limited_${TS}` // sheet-scoped: F + M only (N unreadable, R3)

let app: Express
let publishSpy: MockInstance
let currentUser: { id: string; roles: string[]; perms: string[] } = {
  id: USER_FULL,
  roles: ['member'],
  perms: ['multitable:read', 'multitable:write'],
}

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const readField = async (recordId: string, sheetId: string, fieldId: string) => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, sheetId])
  const data = (r.rows as Array<{ data: unknown }>)[0]?.data
  const parsed = typeof data === 'string' ? JSON.parse(data) : data
  return (parsed as Record<string, unknown> | undefined)?.[fieldId]
}

type RealtimeBroadcast = {
  spreadsheetId: string
  actorId?: string | null
  source: string
  kind: string
  recordId?: string
  recordIds?: string[]
  fieldIds?: string[]
}

/** All `spreadsheet.cell.updated` broadcasts for a sheet since the last mockClear(). */
const sheetEvents = (sheetId: string): RealtimeBroadcast[] =>
  publishSpy.mock.calls
    .filter((call) => call[0] === 'spreadsheet.cell.updated' && (call[1] as RealtimeBroadcast | undefined)?.spreadsheetId === sheetId)
    .map((call) => call[1] as RealtimeBroadcast)

const patchRecord = (sheetId: string, recordId: string, fieldId: string, value: unknown) =>
  request(app).post('/api/multitable/patch').send({
    sheetId,
    changes: [{ recordId, fieldId, value }],
  })

const related = (body: { data?: { relatedRecords?: Array<{ sheetId: string; recordId: string; data: Record<string, unknown> }> } }, sheetId: string, recordId: string) =>
  body.data?.relatedRecords?.find((r) => r.sheetId === sheetId && r.recordId === recordId)

describeIfDatabase('multitable FOL-1 related-record downstream invalidation (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())

    // Spy on the shared singleton AFTER router setup; calls through so any real
    // subscriber behavior stays intact — we only observe the broadcast payloads.
    publishSpy = vi.spyOn(eventBus, 'publish')

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'FOL-1 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [FS, BASE_ID, 'Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [MS, BASE_ID, 'Main Lookup'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [NS, BASE_ID, 'No Read'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SS, BASE_ID, 'Self Link'])

    // foreign sheet: numeric target + an unrelated noise field
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_FTARGET, FS, 'FTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_FNOISE, FS, 'FNoise', 'string', '{}', 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_F1, FS, JSON.stringify({ [FLD_FTARGET]: 9, [FLD_FNOISE]: 'x' })])

    // M: link -> FS, lookup(FTarget), formula = {lookup}+1 — formula seeded STALE (6).
    // PLUS a second link field (NO lookup attached): M2 links to F1 only through it, so M2
    // is always part of the helper echo but never part of the affected set.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_M_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_M_LU, MS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_M_LINK, targetFieldId: FLD_FTARGET, foreignSheetId: FS }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_M_F, MS, 'Formula', 'formula', JSON.stringify({ expression: `={${FLD_M_LU}}+1` }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_M_LINKB, MS, 'Link B', 'link', JSON.stringify({ foreignSheetId: FS }), 4])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_M1, MS, JSON.stringify({ [FLD_M_F]: 6 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_M2, MS, JSON.stringify({})])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_M_LINK, REC_M1, REC_F1])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_M_LINKB, REC_M2, REC_F1])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [MS, FLD_M_F, FLD_M_LU, MS])

    // N: same shape — unreadable to USER_LIMITED (R3); formula seeded STALE (6)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_N_LINK, NS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_N_LU, NS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_N_LINK, targetFieldId: FLD_FTARGET, foreignSheetId: FS }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_N_F, NS, 'Formula', 'formula', JSON.stringify({ expression: `={${FLD_N_LU}}+1` }), 3])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_N1, NS, JSON.stringify({ [FLD_N_F]: 6 })])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_N_LINK, REC_N1, REC_F1])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [NS, FLD_N_F, FLD_N_LU, NS])

    // S: SELF-link sheet (R2) — S2 links to S1; lookup(S_TARGET) + formula seeded STALE (6)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_S_TARGET, SS, 'STarget', 'number', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_S_LINK, SS, 'SLink', 'link', JSON.stringify({ foreignSheetId: SS }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_S_LU, SS, 'SLookup', 'lookup', JSON.stringify({ linkFieldId: FLD_S_LINK, targetFieldId: FLD_S_TARGET, foreignSheetId: SS }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_S_F, SS, 'SFormula', 'formula', JSON.stringify({ expression: `={${FLD_S_LU}}+1` }), 4])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_S1, SS, JSON.stringify({ [FLD_S_TARGET]: 5 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_S2, SS, JSON.stringify({ [FLD_S_F]: 6 })])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_S_LINK, REC_S2, REC_S1])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [SS, FLD_S_F, FLD_S_LU, SS])

    // USER_LIMITED: sheet-scoped write on F (the edit) + M (readable related sheet); no grant
    // on N and no global multitable perms → N is an unreadable related sheet (R3).
    await q('INSERT INTO spreadsheet_permissions(sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)',
      [FS, USER_LIMITED, 'user', USER_LIMITED, 'spreadsheet:write'])
    await q('INSERT INTO spreadsheet_permissions(sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)',
      [MS, USER_LIMITED, 'user', USER_LIMITED, 'spreadsheet:write'])

    // USER_DENY: layer-3 field deny on M's formula field only (R1 unmasked-fieldIds proof).
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [MS, FLD_M_F, 'user', USER_DENY, false, false])
  })

  beforeEach(() => {
    publishSpy.mockClear()
  })

  afterAll(async () => {
    publishSpy.mockRestore()
    await q('DELETE FROM formula_dependencies WHERE sheet_id = ANY($1::text[])', [[MS, NS, SS]]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_M_LINK, FLD_M_LINKB, FLD_N_LINK, FLD_S_LINK]]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[FS, MS, NS, SS]]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = ANY($1::text[])', [[FS, MS, NS, SS]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[FS, MS, NS, SS]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[FS, MS, NS, SS]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[FS, MS, NS, SS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('R4: unrelated-field edit → zero related events despite the helper echo (publish gate = affected gate)', async () => {
    currentUser = { id: USER_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const res = await patchRecord(FS, REC_F1, FLD_FNOISE, 'y')
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    // The cross-sheet echo still carries the linked records for a full-perm actor…
    expect(related(res.body, MS, REC_M1)).toBeDefined()
    // …but no related sheet receives an event: echo presence is NOT the publish gate.
    expect(sheetEvents(MS)).toHaveLength(0)
    expect(sheetEvents(NS)).toHaveLength(0)
    expect(sheetEvents(SS)).toHaveLength(0)
    // The source-sheet main event is unaffected.
    const fsEvents = sheetEvents(FS)
    expect(fsEvents).toHaveLength(1)
    expect(fsEvents[0]).toMatchObject({ kind: 'record-updated', recordIds: [REC_F1], fieldIds: [FLD_FNOISE] })
    // Stale seeds survive (no recompute happened).
    expect(await readField(REC_M1, MS, FLD_M_F)).toBe(6)
    expect(await readField(REC_N1, NS, FLD_N_F)).toBe(6)
  })

  test('R3: a related sheet the actor cannot read gets zero events (readable one still publishes)', async () => {
    currentUser = { id: USER_LIMITED, roles: ['member'], perms: ['comments:write'] }
    const res = await patchRecord(FS, REC_F1, FLD_FTARGET, 50)
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    // N is unreadable to USER_LIMITED → helper skips it → no materialization, no event.
    expect(sheetEvents(NS)).toHaveLength(0)
    expect(await readField(REC_N1, NS, FLD_N_F)).toBe(6)

    // M is readable → recomputed ([50] → 51) and exactly one invalidation event fans out.
    expect(await readField(REC_M1, MS, FLD_M_F)).toBe(51)
    const msEvents = sheetEvents(MS)
    expect(msEvents).toHaveLength(1)
    expect(msEvents[0].recordIds).toEqual([REC_M1])
  })

  test('R1: cross-sheet fan-out — affected recordIds only, UNMASKED fieldIds, no actorId, no recordPatches/values', async () => {
    currentUser = { id: USER_DENY, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const res = await patchRecord(FS, REC_F1, FLD_FTARGET, 100)
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    // DB: related formulas materialized ([100] → 101) — reader-agnostic recompute.
    expect(await readField(REC_M1, MS, FLD_M_F)).toBe(101)
    expect(await readField(REC_N1, NS, FLD_N_F)).toBe(101)

    // Exactly ONE event on the related sheet M.
    const msEvents = sheetEvents(MS)
    expect(msEvents).toHaveLength(1)
    const msEvent = msEvents[0]
    expect(msEvent.kind).toBe('record-updated')
    expect(msEvent.source).toBe('multitable')
    // recordIds = the AFFECTED related records only: M2 is linked to F1 (and echoed) through
    // a link field with no lookup over it, so it must NOT be in the invalidation signal.
    expect(msEvent.recordIds).toEqual([REC_M1])
    // UNMASKED proof: USER_DENY cannot read FLD_M_F (echo masks it below), yet the
    // invalidation metadata still carries the affected lookup AND the recomputed formula id.
    expect([...(msEvent.fieldIds ?? [])].sort()).toEqual([FLD_M_F, FLD_M_LU].sort())
    // Cross-sheet events omit actorId (the editor has no local edit on M; their other tabs
    // must refetch too) and the broadcast never carries patches or values: pin the payload's
    // EXACT key set — metadata-only, no value-bearing key can exist. (A stringify-not-contains
    // value check would be flaky here: TS-stamped fixture ids can embed the patched number.)
    expect(Object.keys(msEvent).sort()).toEqual(['fieldIds', 'kind', 'recordIds', 'source', 'spreadsheetId'])
    // …while the HTTP echo for the same record stays masked (fieldIds ≠ echo keys) and the
    // wire echo carries no fan-out metadata (exact key set, wire-vs-fixture discipline).
    const m = related(res.body, MS, REC_M1)
    expect(m).toBeDefined()
    expect(Object.keys(m!).sort()).toEqual(['data', 'recordId', 'sheetId'])
    expect(m!.data[FLD_M_LU]).toEqual([100])
    expect(m!.data[FLD_M_F]).toBeUndefined()

    // N (readable to this actor, no deny) fans out too.
    const nsEvents = sheetEvents(NS)
    expect(nsEvents).toHaveLength(1)
    expect(nsEvents[0].recordIds).toEqual([REC_N1])
    expect([...(nsEvents[0].fieldIds ?? [])].sort()).toEqual([FLD_N_F, FLD_N_LU].sort())
    expect(nsEvents[0]).not.toHaveProperty('actorId')
  })

  test('R5: main-event regression — the source-sheet publish keeps its exact pre-FOL-1 shape', async () => {
    currentUser = { id: USER_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const res = await patchRecord(FS, REC_F1, FLD_FTARGET, 60)
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const fsEvents = sheetEvents(FS)
    expect(fsEvents).toHaveLength(1)
    // Exact shape: actorId carried, no recordPatches (publisher strips), no extra keys.
    expect(fsEvents[0]).toEqual({
      spreadsheetId: FS,
      actorId: USER_FULL,
      source: 'multitable',
      kind: 'record-updated',
      recordIds: [REC_F1],
      fieldIds: [FLD_FTARGET],
    })
  })

  test('R2: same-sheet self-link → a SECOND source-sheet event for the related record, WITH actorId', async () => {
    currentUser = { id: USER_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const res = await patchRecord(SS, REC_S1, FLD_S_TARGET, 10)
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    // The same-sheet related formula materialized: lookup [10] → 11.
    expect(await readField(REC_S2, SS, FLD_S_F)).toBe(11)

    const ssEvents = sheetEvents(SS)
    expect(ssEvents).toHaveLength(2)
    const mainEvent = ssEvents.find((e) => e.recordIds?.includes(REC_S1))
    const relatedEvent = ssEvents.find((e) => e.recordIds?.includes(REC_S2))
    expect(mainEvent).toEqual({
      spreadsheetId: SS,
      actorId: USER_FULL,
      source: 'multitable',
      kind: 'record-updated',
      recordIds: [REC_S1],
      fieldIds: [FLD_S_TARGET],
    })
    // The self-link fan-out CARRIES actorId: the editor's own tab already merged the fresh
    // values from the PATCH response echo, so it must self-skip instead of re-GETting.
    expect(relatedEvent).toBeDefined()
    expect(relatedEvent!.actorId).toBe(USER_FULL)
    expect(relatedEvent!.kind).toBe('record-updated')
    expect(relatedEvent!.recordIds).toEqual([REC_S2])
    expect([...(relatedEvent!.fieldIds ?? [])].sort()).toEqual([FLD_S_F, FLD_S_LU].sort())
    expect(relatedEvent).not.toHaveProperty('recordPatches')
  })
})
