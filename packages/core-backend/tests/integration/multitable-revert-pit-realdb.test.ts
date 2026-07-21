/**
 * T8-1: Point-in-Time Revert-to-T (non-destructive sheet rollback) — real DB. Goldens: preview classifies
 * revert vs KEEP-post-anchor-created; preview is write-free; execute reverts to anchor-state with FORWARD revisions and
 * KEEPS post-anchor-created records; identity drift → 409 (PIT-1); atomicity (a forced revision-insert failure leaves
 * the record UNCHANGED); reveal never composes (PIT-7, source-grep). Undelete-execute is deferred (codebase-wide
 * undelete slice); LOCK-3 row-deny is enforced via the SAME loadDeniedRecordIds seam the batch-execute test pins.
 * Destructive authority is server-resolved exact anchor (token-only execute). Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import {
  prepareExactAnchorHistoryFixture,
  pruneSealedHistoryOperations,
  type ExactAnchorHistoryFixture,
} from '../utils/exact-anchor-history-fixture'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_rv_${TS}`, SHEET = `sheet_rv_${TS}`
const NAME = `fld_rv_name_${TS}`, SALARY = `fld_rv_salary_${TS}`
const A = `rec_rv_a_${TS}`, B = `rec_rv_b_${TS}`, D = `rec_rv_d_${TS}`, ACTOR = `user_rv_${TS}`
const T0 = '2026-01-01T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curRoles = ['member']
let curPerms = ['multitable:read', 'multitable:write', 'multitable:share'] // share → canManageSheetAccess (D2 sheet-admin gate)
let fixture: ExactAnchorHistoryFixture
const revertPreview = () => request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({ anchorOperationId: fixture.anchorOperationId() })
const revertExecute = (previewIdentity: string) => request(app).post(`/api/multitable/sheets/${SHEET}/revert-execute`).send({ previewIdentity })
const recordRow = async (id: string) => (await q('SELECT data, version FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
// GATE golden helper: sheet-scoped row counts, to prove the flag-off 403 performs literally ZERO writes (no new
// record row, no new revision row) — not just "the response the client sees looks unwritten".
const sheetRowCounts = async (): Promise<{ records: number; revisions: number }> => ({
  records: Number(((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [SHEET])).rows[0] as { n: number }).n),
  revisions: Number(((await q('SELECT count(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])).rows[0] as { n: number }).n),
})
const rev = (
  id: string,
  version: number,
  action: 'create' | 'update' | 'delete',
  snap: Record<string, unknown>,
  at: string,
  options?: { anchor?: boolean },
) => fixture.insertRevision({
  recordId: id,
  version,
  action,
  snapshot: snap,
  createdAt: at,
  phase: options?.anchor ? 'anchor' : at === T0 ? 'before' : 'after',
  changedFieldIds: [NAME, SALARY],
})

async function seed(): Promise<void> {
  for (const id of [A, B]) { // existed at anchor with old values; changed after → live=new. Revert to anchor = old.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [id, SHEET, JSON.stringify({ [NAME]: 'new', [SALARY]: 200 })])
    await rev(id, 1, 'create', { [NAME]: 'old', [SALARY]: 100 }, T0, id === A ? { anchor: true } : undefined)
    await rev(id, 2, 'update', { [NAME]: 'new', [SALARY]: 200 }, T2)
  }
  // D created AFTER the anchor (first revision after) → revert-to-anchor must KEEP it.
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [D, SHEET, JSON.stringify({ [NAME]: 'newbie', [SALARY]: 500 })])
  await rev(D, 1, 'create', { [NAME]: 'newbie', [SALARY]: 500 }, T2)
}

describeIfDatabase('multitable T8-1 Revert-to-T (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: curRoles, perms: curPerms }; next() })
    process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS = '10' // test ceiling: seed = 3 records; the ceiling golden adds 8 → 11 > 10
    // Interim revert-execute master gate (current-risk mitigation, owner-directed): default-OFF now — ON for
    // every pre-existing golden in this suite (unchanged behavior); the dedicated flag-off/on gate golden below
    // toggles it locally and restores this value in a finally block.
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'RV Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'RV Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    await pruneSealedHistoryOperations(SHEET).catch(() => {})
    for (const t of ['meta_history_baselines', 'meta_history_trust_checkpoints', 'meta_recovery_token_burns', 'meta_record_version_markers', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })
  beforeEach(async () => {
    curRoles = ['member']
    curPerms = ['multitable:read', 'multitable:write', 'multitable:share']
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = $1', [SHEET])
    await pruneSealedHistoryOperations(SHEET)
    await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_version_markers WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    fixture = await prepareExactAnchorHistoryFixture(SHEET)
    await seed()
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('preview classifies: revert A+B, KEEP D (created after anchor) — write-free', async () => {
    const before = await recordRow(A)
    const res = await revertPreview()
    expect(res.status).toBe(200)
    expect(res.body?.data?.summary?.visibleRevertCount).toBe(2)
    expect(res.body?.data?.summary?.keptCreatedAfterTCount).toBe(1) // D kept
    expect(res.body?.data?.previewIdentity).toBeTruthy()
    expect(await recordRow(A)).toEqual(before) // PIT-1: preview wrote nothing
  })

  test('execute reverts A+B to the anchor-state via FORWARD revisions; D (post-anchor-created) is KEPT untouched', async () => {
    const pv = await revertPreview()
    const res = await revertExecute(pv.body?.data?.previewIdentity)
    expect(res.status).toBe(200)
    expect(res.body?.data?.revertedCount).toBe(2)
    for (const id of [A, B]) {
      const r = await recordRow(id)
      expect(r?.data?.[NAME]).toBe('old') // reverted to the anchor value
      expect(r?.data?.[SALARY]).toBe(100)
      expect(r?.version).toBe(3) // forward (v2 → v3), never a destructive rewind
    }
    const d = await recordRow(D)
    expect(d?.data?.[NAME]).toBe('newbie') // KEPT — non-destructive
    expect(d?.version).toBe(1) // untouched
  })

  test('PIT-1 drift: a record edited between preview and execute → execute 409 (re-preview)', async () => {
    const pv = await revertPreview()
    await q('UPDATE meta_records SET data = $2::jsonb, version = 3 WHERE id = $1', [A, JSON.stringify({ [NAME]: 'drifted', [SALARY]: 999 })])
    const res = await revertExecute(pv.body?.data?.previewIdentity)
    expect(res.status).toBe(409) // the revert set re-hashes → identity rejected
  })

  test('atomicity: a forced revision-insert failure leaves the record UNCHANGED (no half-write)', async () => {
    const pv = await revertPreview()
    await q(`CREATE OR REPLACE FUNCTION _rv_fail() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION 'rv injected'; END; $f$ LANGUAGE plpgsql`, [])
    await q('CREATE TRIGGER _rv_fail_trg BEFORE INSERT ON meta_record_revisions FOR EACH ROW EXECUTE FUNCTION _rv_fail()', [])
    try { await revertExecute(pv.body?.data?.previewIdentity) } finally {
      await q('DROP TRIGGER IF EXISTS _rv_fail_trg ON meta_record_revisions', [])
      await q('DROP FUNCTION IF EXISTS _rv_fail()', [])
    }
    const r = await recordRow(A)
    expect(r?.data?.[NAME]).toBe('new') // UNCHANGED — the write + revision rolled back together
    expect(r?.version).toBe(2)
  })

  test('PIT-7: the revert path composes NO reveal grant (source-grep)', () => {
    const src = readFileSync(join(__dirname, '../../src/routes/univer-meta.ts'), 'utf8')
    const start = src.indexOf('const handleExactAnchorPreview')
    const end = src.indexOf("router.get('/sheets/:sheetId/records/:recordId/subscriptions'", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain('const handleExactAnchorExecute')
    expect(block).toContain("router.post('/sheets/:sheetId/revert-execute'")
    expect(block).not.toMatch(/resolveActiveRevealGrant|loadRevealedFieldIds|loadActiveReveal/) // reveal never composes into the write
  })

  test('[P1] D2: a normal record editor (write but NOT sheet-admin) is FORBIDDEN a sheet-wide revert', async () => {
    curPerms = ['multitable:read', 'multitable:write'] // no multitable:share → no canManageSheetAccess
    expect((await revertPreview()).status).toBe(403)
    expect((await revertExecute('whatever')).status).toBe(403)
  })

  test('[P1] D3/PIT-6: a sheet above the revert ceiling is REFUSED 413 fail-closed', async () => {
    for (let i = 0; i < 8; i++) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [`rec_rv_big_${TS}_${i}`, SHEET, JSON.stringify({ [NAME]: 'x' })])
    } // seed 3 + 8 = 11 > the test ceiling of 10
    const res = await revertPreview()
    expect(res.status).toBe(413)
    expect(res.body?.error?.code).toBe('SHEET_TOO_LARGE')
  })

  // ── Interim revert-execute master gate (current-risk mitigation, owner-directed) ──────────────────────────────
  // The merged §0.6 precheck (#4234) is live-vs-latest and still blind to the healed-gap + check→write race; until
  // the full W0-1 correctness fix lands, revert-execute is closed by DEFAULT via MULTITABLE_ENABLE_SHEET_REVERT
  // (mirrors reset-execute's PIT_RESET_ENABLED gate exactly). This suite runs with the flag ON throughout (set in
  // beforeAll) so every OTHER golden above is unaffected; this golden toggles the flag OFF locally and restores
  // it in a finally block so it never leaks into a later test in this file.
  test('[GATE] flag UNSET → revert-execute is 403 REVERT_DISABLED with ZERO writes; revert-preview stays ungated', async () => {
    const savedFlag = process.env.MULTITABLE_ENABLE_SHEET_REVERT
    try {
      delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
      // revert-preview is read-only and MUST remain reachable while execute is gated off — the FE preview
      // screen still needs to render even when the Revert button itself is hidden.
      const pv = await revertPreview()
      expect(pv.status).toBe(200)
      expect(pv.body?.data?.previewIdentity).toBeTruthy()

      const beforeA = await recordRow(A)
      const beforeCounts = await sheetRowCounts()
      const res = await revertExecute(pv.body.data.previewIdentity)
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'REVERT_DISABLED', message: 'Sheet revert is disabled (MULTITABLE_ENABLE_SHEET_REVERT is off).' } })
      // ZERO WRITES — assert the DB, not just the response shape: identical record row, identical
      // sheet-scoped record/revision counts (no new revision of any source, no partial per-record apply).
      expect(await recordRow(A)).toEqual(beforeA)
      expect(await sheetRowCounts()).toEqual(beforeCounts)
    } finally {
      if (savedFlag === undefined) delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
      else process.env.MULTITABLE_ENABLE_SHEET_REVERT = savedFlag
    }
  })

  test('[GATE] flag SET → revert-execute runs the normal path (unchanged from the pre-existing goldens above)', async () => {
    expect(process.env.MULTITABLE_ENABLE_SHEET_REVERT).toBe('true') // suite default, set in beforeAll
    const pv = await revertPreview()
    const res = await revertExecute(pv.body?.data?.previewIdentity)
    expect(res.status).toBe(200)
    expect(res.body?.data?.revertedCount).toBe(2)
  })
})
