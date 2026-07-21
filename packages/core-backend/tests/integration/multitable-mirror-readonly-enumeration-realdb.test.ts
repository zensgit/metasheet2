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
 * Exact-anchor migration (W0 L8): free wall-clock `asOf` is refused. PIT undelete/resurrection is
 * categorically fail-closed (`INBOUND_UNPROVABLE`, no executable token, no write). Reset still runs on
 * exact anchors; restorable projection EXCLUDES mirror-owned link fields, so a reset whose at-anchor
 * snapshot carried a bogus mirror value restores only restorable scalars and never writes a mirror edge.
 *
 * FAIL-FIRST (verified manually, see dev-verification MD): revert the records.ts guard → SD-1a/1b RED (a row
 * appears); revert the index.ts guard → the SD-2 derivation flips; revert the restoreRecord skip → SNAP RED.
 * Runs only with DATABASE_URL (describeIfDatabase) via the plugin-tests.yml real-DB runner list.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { createRecord, patchRecord } from '../../src/multitable/records'
import { isFieldAlwaysReadOnly } from '../../src/multitable/permission-derivation'
import {
  prepareExactAnchorHistoryFixture,
  pruneSealedHistoryOperations,
  type ExactAnchorHistoryFixture,
} from '../utils/exact-anchor-history-fixture'

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
const T0 = '2026-01-01T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const pool = () => poolManager.get()
let app: Express
// share → canManageSheetAccess (PIT reset floor); write → canDeleteRecord (PIT undelete floor).
let currentUser = { id: USER, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }
let fixtureB: ExactAnchorHistoryFixture

/** Spine assertion: how many canonical edges are keyed by the MIRROR field (must always be 0). */
const mirrorRows = async (): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1', [FLD_B_MIRROR])).rows[0] as { n: number }).n)

async function resetSheetBHistory(): Promise<void> {
  await pruneSealedHistoryOperations(SB).catch(() => {})
  await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [SB]).catch(() => {})
  await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [SB]).catch(() => {})
  await q('DELETE FROM meta_recovery_token_burns WHERE sheet_id = $1', [SB]).catch(() => {})
  await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SB]).catch(() => {})
  await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SB]).catch(() => {})
  // Keep the baseline live REC_B1 (and REC_A1 on SA); wipe only transient records used by SNAP tests.
  await q('DELETE FROM meta_records WHERE sheet_id = $1 AND id <> $2', [SB, REC_B1]).catch(() => {})
  await q('UPDATE meta_records SET data = $1::jsonb, version = 1 WHERE id = $2', [JSON.stringify({ [FLD_B_NAME]: 'b1' }), REC_B1]).catch(() => {})
  fixtureB = await prepareExactAnchorHistoryFixture(SB)
  // Stable survivor so the sheet always has a covering checkpoint + a sealed endpoint for exact-anchor
  // recovery tests that layer additional records on top.
  await fixtureB.insertRevision({
    recordId: REC_B1,
    version: 1,
    action: 'create',
    snapshot: { [FLD_B_NAME]: 'b1' },
    createdAt: T0,
    phase: 'anchor',
    changedFieldIds: [FLD_B_NAME],
  })
}

describeIfDatabase('multitable mirror-read-only hardening — C2/I-1 enumeration (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as express.Request & { user?: unknown }).user = currentUser; next() })
    // PIT flags read per-request; SHEET_REVERT_MAX_RECORDS captured at ROUTER CREATION → set all four BEFORE univerMetaRouter().
    process.env.MULTITABLE_ENABLE_PIT_UNDELETE = 'true'
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    // Interim revert-execute master gate (current-risk mitigation): default-OFF now — keep it on for this
    // suite's SD-2/G5-style revert-route enumeration goldens, unchanged behavior.
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS = '50'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
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
    await resetSheetBHistory()
  })

  afterAll(async () => {
    await pruneSealedHistoryOperations(SB).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_A_LINK, FLD_B_MIRROR]]).catch(() => {})
    for (const t of ['meta_history_baselines', 'meta_history_trust_checkpoints', 'meta_recovery_token_burns', 'meta_records_trash', 'meta_record_revisions', 'meta_records']) {
      await q(`DELETE FROM ${t} WHERE sheet_id = ANY($1::text[])`, [[SA, SB]]).catch(() => {})
    }
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [USER]).catch(() => {})
    delete process.env.MULTITABLE_ENABLE_PIT_UNDELETE
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
    delete process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
  })

  beforeEach(async () => {
    process.env.MULTITABLE_ENABLE_PIT_UNDELETE = 'true'
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_A_LINK, FLD_B_MIRROR]]).catch(() => {})
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
    await q('DELETE FROM meta_records_trash WHERE record_id = $1', [RB2]).catch(() => {})
  })

  // ── Snapshot path — exact-anchor resurrect is FAIL-CLOSED. A DELETED record whose at-anchor snapshot
  //    carries a bogus mirror value must never become an executable undelete plan (and never write). ──
  test('SNAP-undelete (exact-anchor resurrect) of a record whose at-anchor snapshot carries a bogus mirror value → fail-closed, NO token, NO edge', async () => {
    await resetSheetBHistory()
    const RU = `rec_mro_undel_${TS}`
    const snap = { [FLD_B_NAME]: 'u-at-anchor', [FLD_B_MIRROR]: [REC_A1] } // bogus mirror value in the resurrect snapshot
    await fixtureB.insertRevision({
      recordId: RU,
      version: 1,
      action: 'create',
      snapshot: snap,
      createdAt: T0,
      phase: 'before',
      changedFieldIds: [FLD_B_NAME],
    })
    await fixtureB.insertRevision({
      recordId: RU,
      version: 1,
      action: 'delete',
      snapshot: snap,
      createdAt: T2,
      phase: 'after',
      changedFieldIds: [FLD_B_NAME],
    })
    const before = await mirrorRows()
    const beforeLive = (await q('SELECT 1 FROM meta_records WHERE id = $1', [RU])).rows.length
    const beforeTrash = (await q('SELECT 1 FROM meta_records_trash WHERE record_id = $1', [RU])).rows.length
    const beforeRevs = Number(((await q('SELECT count(*)::int AS c FROM meta_record_revisions WHERE sheet_id = $1', [SB])).rows[0] as { c: number }).c)

    const pv = await request(app).post(`/api/multitable/sheets/${SB}/revert-preview`).send({ anchorOperationId: fixtureB.anchorOperationId() })
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.undeleteRecordIds).toContain(RU)
    // Exact-anchor kernel categorically refuses resurrection: disclosed, but not executable.
    expect(pv.body?.data?.undeleteSupported).toBe(false)
    expect(pv.body?.data?.undeleteBlockedReason).toBe('INBOUND_UNPROVABLE')
    expect(pv.body?.data?.executable).toBe(false)
    expect(pv.body?.data?.previewIdentity).toBeNull()

    // No write surface exists without a token; spine + sheet state unchanged.
    expect(await mirrorRows()).toBe(before)
    expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [RU])).rows.length).toBe(beforeLive)
    expect((await q('SELECT 1 FROM meta_records_trash WHERE record_id = $1', [RU])).rows.length).toBe(beforeTrash)
    expect(Number(((await q('SELECT count(*)::int AS c FROM meta_record_revisions WHERE sheet_id = $1', [SB])).rows[0] as { c: number }).c)).toBe(beforeRevs)

    await q('DELETE FROM meta_record_revisions WHERE record_id = $1', [RU]).catch(() => {})
  })

  // ── Snapshot path — exact-anchor reset-to-anchor. A SURVIVOR whose at-anchor snapshot carried a bogus
  //    mirror value: restorable projection excludes the mirror field; only restorable scalars are restored.
  //    Spine: no mirror edge is ever written. ──
  test('SNAP-reset (exact-anchor reset) whose at-anchor snapshot carried a bogus mirror value → mirror NEVER written, NO edge', async () => {
    await resetSheetBHistory()
    const RR = `rec_mro_reset_${TS}`
    // live now = no mirror; the at-anchor (create) snapshot HAD a bogus mirror value → projection skips it.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [RR, SB, JSON.stringify({ [FLD_B_NAME]: 'now' })])
    await fixtureB.insertRevision({
      recordId: RR,
      version: 1,
      action: 'create',
      snapshot: { [FLD_B_NAME]: 'at-anchor', [FLD_B_MIRROR]: [REC_A1] },
      createdAt: T0,
      phase: 'before',
      changedFieldIds: [FLD_B_NAME],
    })
    await fixtureB.insertRevision({
      recordId: RR,
      version: 2,
      action: 'update',
      snapshot: { [FLD_B_NAME]: 'now' },
      createdAt: T2,
      phase: 'after',
      changedFieldIds: [FLD_B_NAME],
    })
    const before = await mirrorRows()
    const pv = await request(app).post(`/api/multitable/sheets/${SB}/reset-preview`).send({ anchorOperationId: fixtureB.anchorOperationId() })
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.executable).toBe(true)
    const token = pv.body?.data?.previewIdentity as string
    expect(token).toBeTruthy()
    const ex = await request(app).post(`/api/multitable/sheets/${SB}/reset-execute`).send({ previewIdentity: token, confirm: 'reset' })
    expect(ex.status).toBe(200)
    // Restorable name is restored; mirror field is excluded from projection → spine holds.
    const live = (await q('SELECT data FROM meta_records WHERE id = $1', [RR])).rows[0] as { data: Record<string, unknown> }
    expect(live.data[FLD_B_NAME]).toBe('at-anchor')
    expect(live.data[FLD_B_MIRROR]).toBeUndefined()
    expect(await mirrorRows()).toBe(before)
    await q('DELETE FROM meta_records WHERE id = $1', [RR]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE record_id = $1', [RR]).catch(() => {})
  })
})
