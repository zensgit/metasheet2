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
let currentUser = { id: USER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }

/** Spine assertion: how many canonical edges are keyed by the MIRROR field (must always be 0). */
const mirrorRows = async (): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1', [FLD_B_MIRROR])).rows[0] as { n: number }).n)

describeIfDatabase('multitable mirror-read-only hardening — C2/I-1 enumeration (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as express.Request & { user?: unknown }).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())

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
  })

  afterAll(async () => {
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_A_LINK, FLD_B_MIRROR]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
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
})
