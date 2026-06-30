/**
 * Mirror-read-only hardening (C2 / I-1) — real-DB enumeration goldens.
 *
 * The mirror side of a twoWay link (`property.mirrorOf`) is forced read-only by the CANONICAL guard
 * `isFieldAlwaysReadOnly` (permission-derivation.ts). The spine invariant: a mirror field must NEVER own a
 * `meta_links` row (that would be a second canonical edge). The I-1 enumeration found two paths that did NOT
 * consult the canonical guard — the plugin SDK (`records.ts`) and the Yjs collab bridge (`index.ts`) — plus
 * snapshot-rebuild paths that were safe only by hygiene. These goldens lock that EVERY meta_links-writing path
 * rejects / does not create a mirror edge. Spine assertion per attempt: `meta_links WHERE field_id = mirror` === 0.
 *
 * FAIL-FIRST (verified manually, see dev-verification MD): revert the records.ts guard → SD-1a/1b RED (a row
 * appears); revert the index.ts guard → the SD-2 derivation flips; revert the restoreRecord skip → SNAP RED.
 * Runs only with DATABASE_URL (describeIfDatabase) via the plugin-tests.yml real-DB runner list.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { createRecord, patchRecord } from '../../src/multitable/records'
import { isFieldAlwaysReadOnly } from '../../src/multitable/permission-derivation'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_mro_${TS}`
const SA = `sheet_mro_a_${TS}` // forward side
const SB = `sheet_mro_b_${TS}` // mirror side
const FLD_A_LINK = `fld_mro_a_link_${TS}` // forward twoWay link A→B
const FLD_B_MIRROR = `fld_mro_b_mirror_${TS}` // mirror twoWay link B→A, mirrorOf=FLD_A_LINK (read-only)
const FLD_B_NAME = `fld_mro_b_name_${TS}` // a writable string on B (control)
const REC_A1 = `rec_mro_a1_${TS}`
const REC_B1 = `rec_mro_b1_${TS}`
const USER = `u_mro_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const pool = () => poolManager.get()
let app: Express
// share → canManageSheetAccess (PIT reset floor); write → canDeleteRecord (PIT undelete floor).
let currentUser = { id: USER, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-02T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'
const rev = (id: string, sheet: string, version: number, action: string, snap: Record<string, unknown>, at: string) =>
  q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[$5]::text[],'{}'::jsonb,$6::jsonb,$7)`, [sheet, id, version, action, FLD_B_NAME, JSON.stringify(snap), at])

/** Spine assertion: how many canonical edges are keyed by the MIRROR field (must always be 0). */
const mirrorRows = async (): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1', [FLD_B_MIRROR])).rows[0] as { n: number }).n)

describeIfDatabase('multitable mirror-read-only hardening — C2/I-1 enumeration (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as express.Request & { user?: unknown }).user = currentUser; next() })
    // PIT flags read per-request; SHEET_REVERT_MAX_RECORDS captured at ROUTER CREATION → set all three BEFORE univerMetaRouter().
    process.env.MULTITABLE_ENABLE_PIT_UNDELETE = 'true'
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS = '50'
    app.use('/api/multitable', univerMetaRouter())

    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [USER])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'MRO'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3),($4,$5,$6)', [SA, BASE, 'A', SB, BASE, 'B'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_A_LINK, SA, 'ALink', 'link', JSON.stringify({ foreignSheetId: SB, twoWay: true, mirrorFieldId: FLD_B_MIRROR }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_B_MIRROR, SB, 'BMirror', 'link', JSON.stringify({ foreignSheetId: SA, twoWay: true, mirrorFieldId: FLD_A_LINK, mirrorOf: FLD_A_LINK }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_B_NAME, SB, 'BName', 'string', JSON.stringify({}), 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1),($4,$5,$6::jsonb,1)',
      [REC_A1, SA, JSON.stringify({}), REC_B1, SB, JSON.stringify({ [FLD_B_NAME]: 'b1' })])
    // Give REC_B1 a clean create@T0 revision so it reconstructs as a plain survivor for the PIT preview/reset
    // below (a sheet-wide reset over a no-history live row is the one reconstruction edge worth avoiding here).
    await rev(REC_B1, SB, 1, 'create', { [FLD_B_NAME]: 'b1' }, T0)
  })

  afterAll(async () => {
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_A_LINK, FLD_B_MIRROR]]).catch(() => {})
    for (const t of ['meta_records_trash', 'meta_record_revisions', 'meta_records']) await q(`DELETE FROM ${t} WHERE sheet_id = ANY($1::text[])`, [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [USER]).catch(() => {})
    delete process.env.MULTITABLE_ENABLE_PIT_UNDELETE; delete process.env.MULTITABLE_ENABLE_PIT_RESET; delete process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── Side-door #1 — plugin-SDK records.ts (createRecord / patchRecord) ──
  test('SD-1a plugin-SDK createRecord with a mirror-field value → rejected, NO mirror edge', async () => {
    const before = await mirrorRows()
    await expect(
      createRecord({ query: pool().query.bind(pool()) as never, sheetId: SB, data: { [FLD_B_MIRROR]: [REC_A1] } } as never),
    ).rejects.toThrow(/read-only|readonly/i)
    expect(await mirrorRows()).toBe(before) // spine: no row created by the mirror field
  })

  test('SD-1b plugin-SDK patchRecord with a mirror-field value → rejected, NO mirror edge', async () => {
    const before = await mirrorRows()
    await expect(
      patchRecord({ query: pool().query.bind(pool()) as never, sheetId: SB, recordId: REC_B1, changes: { [FLD_B_MIRROR]: [REC_A1] } } as never),
    ).rejects.toThrow(/read-only|readonly/i)
    expect(await mirrorRows()).toBe(before)
  })

  // ── Conforming-path regression — bulk POST /patch (locks the baseline) ──
  test('CONF bulk /patch on the mirror field → rejected (403), NO mirror edge', async () => {
    const before = await mirrorRows()
    const res = await request(app).post('/api/multitable/patch').send({ sheetId: SB, changes: [{ recordId: REC_B1, fieldId: FLD_B_MIRROR, value: [REC_A1] }] })
    expect(res.status).toBe(403)
    expect(await mirrorRows()).toBe(before)
  })

  // ── Side-door #2 — Yjs collab-bridge guard derivation (the full realtime loop isn't drivable in-test;
  //    assert the CANONICAL guard the bridge now uses flags a mirror read-only where the OLD hand-rolled
  //    predicate did NOT — i.e. the convergence closes the gap). ──
  test('SD-2 a mirror field (mirrorOf, no raw readOnly) is read-only via isFieldAlwaysReadOnly; the OLD Yjs predicate missed it', async () => {
    const mirrorField = { type: 'link' as const, property: { foreignSheetId: SA, twoWay: true, mirrorOf: FLD_A_LINK } }
    // NEW (index.ts:2370 now) — canonical guard keys on mirrorOf:
    expect(isFieldAlwaysReadOnly(mirrorField)).toBe(true)
    // OLD hand-rolled predicate `readOnlyTypes.has(type) || prop.readOnly===true` — would have judged it WRITABLE:
    const oldPredicate = new Set(['lookup', 'rollup']).has(mirrorField.type) || (mirrorField.property as { readOnly?: boolean }).readOnly === true
    expect(oldPredicate).toBe(false)
  })

  // ── Snapshot-rebuild path — restore (drivable via the route). Inject a mirror value into data (simulating a
  //    hygiene failure), soft-delete, restore → the mirror must NOT be replayed as an edge (explicit Fix-3 skip). ──
  test('SNAP restore of a record whose snapshot carries a (bogus) mirror value → mirror NOT replayed, NO edge', async () => {
    const RB2 = `rec_mro_b2_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [RB2, SB, JSON.stringify({ [FLD_B_NAME]: 'b2' })])
    // Inject a mirror-field value directly (bypass all guards) → it lands in the delete snapshot.
    await q('UPDATE meta_records SET data = $1::jsonb WHERE id = $2', [JSON.stringify({ [FLD_B_NAME]: 'b2', [FLD_B_MIRROR]: [REC_A1] }), RB2])
    const del = await request(app).delete(`/api/multitable/records/${RB2}`)
    expect([200, 204]).toContain(del.status)
    const before = await mirrorRows()
    const res = await request(app).post(`/api/multitable/records/${RB2}/restore`)
    expect([200, 201]).toContain(res.status)
    // Fix-3 skip: the mirror field is excluded from the link replay → no edge for it.
    expect(await mirrorRows()).toBe(before)
    await q('DELETE FROM meta_records WHERE id = $1', [RB2]).catch(() => {})
  })

  // ── Snapshot path — PIT undelete/resurrect (univer-meta.ts:9427 skip). A DELETED record whose T-snapshot carries a
  //    bogus mirror value: the outbound-link rebuild on resurrect must NOT recreate the mirror edge. ──
  test('SNAP-undelete (PIT resurrect) of a record whose T-snapshot carries a bogus mirror value → mirror NOT rebuilt, NO edge', async () => {
    const RU = `rec_mro_undel_${TS}`
    const snap = { [FLD_B_NAME]: 'u-at-T1', [FLD_B_MIRROR]: [REC_A1] } // bogus mirror value in the resurrect snapshot
    await rev(RU, SB, 1, 'create', snap, T0)
    await rev(RU, SB, 2, 'delete', snap, T2) // deleted now, NO live row → an undelete target at T1
    const before = await mirrorRows()
    const pv = await request(app).post(`/api/multitable/sheets/${SB}/revert-preview`).send({ asOf: T1 })
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.undeleteRecordIds).toContain(RU)
    const x = await request(app).post(`/api/multitable/sheets/${SB}/revert-execute`)
      .send({ asOf: T1, previewIdentity: pv.body?.data?.previewIdentity, confirm: 'undelete' })
    expect(x.status).toBe(200)
    // Fix-3 (univer-meta.ts:9427): the read-only mirror field is excluded from the outbound-link rebuild → no mirror edge.
    expect(await mirrorRows()).toBe(before)
    await q('DELETE FROM meta_records WHERE id = $1', [RU]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE record_id = $1', [RU]).catch(() => {})
  })

  // ── Snapshot path — PIT reset-to-T (univer-meta.ts:9649 skip). A SURVIVOR whose revert-to-T diff would set a mirror
  //    link value: the reset replay must skip the read-only mirror field. ──
  test('SNAP-reset (PIT reset-to-T) whose revert diff would write the mirror field → REFUSED at the all-or-nothing preflight (RESET_BLOCKED), NO mirror edge', async () => {
    const RR = `rec_mro_reset_${TS}`
    // live now = no mirror; the T1 (create@T0) snapshot HAD a bogus mirror value → reset-to-T1's diff would set it.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [RR, SB, JSON.stringify({ [FLD_B_NAME]: 'now' })])
    await rev(RR, SB, 1, 'create', { [FLD_B_NAME]: 'at-T1', [FLD_B_MIRROR]: [REC_A1] }, T0)
    await rev(RR, SB, 2, 'update', { [FLD_B_NAME]: 'now' }, T2)
    const before = await mirrorRows()
    // The reset's all-or-nothing PREFLIGHT (univer-meta.ts:9322; readOnly via isFieldAlwaysReadOnly ⇒ mirrorOf) REFUSES
    // a revert that would write the read-only mirror field → nothing written. This pre-existing preflight, NOT the 9649
    // replay skip, is the reset path's reachable spine guard (the 9649 skip is defense-in-depth, unreachable while the
    // preflight holds). Either way the spine invariant holds: no mirror edge is ever written by a reset.
    const pv = await request(app).post(`/api/multitable/sheets/${SB}/reset-preview`).send({ asOf: T1 })
    expect(pv.status).toBe(409)
    expect(pv.body?.error?.code).toBe('RESET_BLOCKED')
    expect(await mirrorRows()).toBe(before) // 0 — spine holds, nothing written
    await q('DELETE FROM meta_records WHERE id = $1', [RR]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE record_id = $1', [RR]).catch(() => {})
  })
})
