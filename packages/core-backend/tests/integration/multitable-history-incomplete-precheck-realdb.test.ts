/**
 * D-1c §0.6 — the `HISTORY_INCOMPLETE` fail-closed integrity precheck (owner hard-lock). Real DB.
 *
 * Design-lock: docs/development/multitable-global-history-d1c-form-submit-edit-uncaptured-revision-design-lock-20260712.md
 * §0.6. Both destructive PIT paths — sheet Revert-to-T (T8-1) and sheet Reset-to-T (T8-2) — share ONE precheck
 * (`checkSheetHistoryIntegrity`), called fresh from inside `computeSheetRevert`/`computeSheetReset`, which is
 * itself the SAME function both preview and execute invoke (execute always RE-ENUMERATES, never trusts a
 * cached preview) — so every golden below is run against BOTH strategies to prove all four wiring points
 * (revert-preview, revert-execute, reset-preview, reset-execute).
 *
 * Goldens (§0.6 item 5, all four mandatory):
 *  - G-HI-1 polluted (live user-authored data ≠ latest revision snapshot) → refused, zero writes.
 *  - G-HI-2 version-only drift (lock/unlock bumps version, data identical) → NOT refused, proceeds.
 *  - G-HI-3 formula-sheet healthy record (positive control for the projection) → NOT refused, proceeds.
 *  - G-HI-3-link healthy record whose LIVE link array and its latest-revision snapshot hold the SAME id set
 *    in a different order/representation (positive control for the link comparator — `link` fields stay IN
 *    the projection per OD-4, so they need their OWN order-insensitive comparator, the link-shaped analogue
 *    of G-HI-3's formula false-positive) → NOT refused, proceeds.
 *  - G-HI-4 zero-revision live record in scope → refused, zero writes (pins live-row enumeration).
 *  - TOCTOU: pollution landing strictly between preview and execute is caught because execute RE-RUNS the
 *    precheck — constructed so the diff/version the EXISTING previewIdentity signature binds are BOTH
 *    unperturbed (the old guard is proven structurally blind; only the new precheck catches it).
 *
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_hi_${TS}`, SHEET = `sheet_hi_${TS}`
const NAME = `fld_hi_name_${TS}`, SALARY = `fld_hi_salary_${TS}`, FORMULA = `fld_hi_formula_${TS}`, LINK = `fld_hi_link_${TS}`
const CTRL = `rec_hi_ctrl_${TS}`, ACTOR = `user_hi_${TS}`
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-02T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curRoles = ['member']
let curPerms = ['multitable:read', 'multitable:write', 'multitable:share'] // share → canManageSheetAccess (D2)

const revertPreview = (asOf: string) => request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({ asOf })
const revertExecute = (asOf: string, previewIdentity: string) => request(app).post(`/api/multitable/sheets/${SHEET}/revert-execute`).send({ asOf, previewIdentity })
const resetPreview = (asOf: string) => request(app).post(`/api/multitable/sheets/${SHEET}/reset-preview`).send({ asOf })
const resetExecute = (asOf: string, previewIdentity: string) => request(app).post(`/api/multitable/sheets/${SHEET}/reset-execute`).send({ asOf, previewIdentity, confirm: 'reset' })

const recordRow = async (id: string) => (await q('SELECT data, version FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
const revisionCount = async (id: string) => Number(((await q('SELECT count(*)::int AS c FROM meta_record_revisions WHERE record_id = $1', [id])).rows[0] as { c: number }).c)
const inTrash = async (id: string) => (await q('SELECT record_id FROM meta_records_trash WHERE record_id = $1', [id])).rows.length > 0

const rev = (id: string, version: number, action: string, snap: Record<string, unknown>, at: string) =>
  q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[$5,$6]::text[],'{}'::jsonb,$7::jsonb,$8)`, [SHEET, id, version, action, NAME, SALARY, JSON.stringify(snap), at])

// CTRL: a healthy 2-revision record. asOf=T1 sits strictly between v1 (T0) and v2 (T2), so a revert/reset to
// T1 legitimately wants to undo the v2 change. This is the one always-revertable baseline every golden below
// shares: when a sheet is refused HISTORY_INCOMPLETE, CTRL must stay completely untouched (proves the refusal
// is whole-sheet, not per-record); when the precheck passes, CTRL must actually revert (proves the operation
// genuinely proceeded past the precheck, not merely returned 200 with nothing to do).
async function seedCtrl(): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [CTRL, SHEET, JSON.stringify({ [NAME]: 'ctrl-mid', [SALARY]: 200 })])
  await rev(CTRL, 1, 'create', { [NAME]: 'ctrl-old', [SALARY]: 100 }, T0)
  await rev(CTRL, 2, 'update', { [NAME]: 'ctrl-mid', [SALARY]: 200 }, T2)
}

describeIfDatabase('D-1c §0.6 HISTORY_INCOMPLETE precheck (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: curRoles, perms: curPerms }; next() })
    process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS = '50'
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    delete process.env.MULTITABLE_META_REVISION_RETENTION_ENABLED
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'HI Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'HI Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    // A derived (formula) field on the SAME sheet — the positive control for §0.6 item 2's projection.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FORMULA, SHEET, 'Formula', 'formula', JSON.stringify({ expression: '1+1' }), 3])
    // A link field — the positive control for the link comparator (order/representation-insensitive).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [LINK, SHEET, 'Link', 'link', JSON.stringify({ foreignSheetId: SHEET }), 4])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    for (const t of ['meta_records_trash', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
    delete process.env.MULTITABLE_META_REVISION_RETENTION_ENABLED
  })
  beforeEach(async () => {
    curRoles = ['member']
    curPerms = ['multitable:read', 'multitable:write', 'multitable:share']
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = $1', [SHEET])
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    await seedCtrl()
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  describe.each(['revert', 'reset'] as const)('%s', (strategy) => {
    const preview = (asOf: string) => (strategy === 'revert' ? revertPreview(asOf) : resetPreview(asOf))
    const execute = (asOf: string, previewIdentity: string) => (strategy === 'revert' ? revertExecute(asOf, previewIdentity) : resetExecute(asOf, previewIdentity))

    test('G-HI-1: polluted record (live data ≠ latest revision snapshot) → preview+execute refuse HISTORY_INCOMPLETE, ZERO writes', async () => {
      const POL = `rec_hi_pol_${strategy}_${TS}`
      // The D-1c fingerprint itself: version bumped 1→2, `data` changed, NO second revision ever written.
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [POL, SHEET, JSON.stringify({ [NAME]: 'pol-uncaptured-edit', [SALARY]: 1 })])
      await rev(POL, 1, 'create', { [NAME]: 'pol-v1', [SALARY]: 1 }, T0)

      const pv = await preview(T1)
      expect(pv.status).toBe(409)
      expect(pv.body?.ok).toBe(false)
      expect(pv.body?.error?.code).toBe('HISTORY_INCOMPLETE')
      expect(pv.body?.data).toBeUndefined() // no previewIdentity minted

      const ex = await execute(T1, 'no-token-available') // proves the precheck fires before identity verification
      expect(ex.status).toBe(409)
      expect(ex.body?.error?.code).toBe('HISTORY_INCOMPLETE')
      expect(ex.body?.data).toBeUndefined()

      expect(await recordRow(POL)).toEqual({ data: { [NAME]: 'pol-uncaptured-edit', [SALARY]: 1 }, version: 2 })
      expect(await revisionCount(POL)).toBe(1)
      const ctrl = await recordRow(CTRL)
      expect(ctrl?.data?.[NAME]).toBe('ctrl-mid') // the healthy baseline was NOT touched either — whole-sheet refusal
      expect(ctrl?.version).toBe(2)
      expect(await revisionCount(CTRL)).toBe(2)
      expect(await inTrash(POL)).toBe(false)
    })

    test('G-HI-4: zero-revision live record in scope → preview+execute refuse HISTORY_INCOMPLETE, ZERO writes', async () => {
      const ZERO = `rec_hi_zero_${strategy}_${TS}`
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [ZERO, SHEET, JSON.stringify({ [NAME]: 'zero-rev' })]) // NO revision row — the uncaptured-CREATE fingerprint

      const pv = await preview(T1)
      expect(pv.status).toBe(409)
      expect(pv.body?.error?.code).toBe('HISTORY_INCOMPLETE')

      const ex = await execute(T1, 'no-token-available')
      expect(ex.status).toBe(409)
      expect(ex.body?.error?.code).toBe('HISTORY_INCOMPLETE')

      expect(await recordRow(ZERO)).toEqual({ data: { [NAME]: 'zero-rev' }, version: 1 })
      expect(await revisionCount(ZERO)).toBe(0)
      const ctrl = await recordRow(CTRL)
      expect(ctrl?.version).toBe(2) // whole-sheet refusal — CTRL untouched too
      expect(await inTrash(ZERO)).toBe(false)
    })

    test('G-HI-2: version-only drift (lock/unlock bumps version, data identical) → precheck PASSES, operation proceeds', async () => {
      const VER = `rec_hi_ver_${strategy}_${TS}`
      // version=4 simulates 3 lock/unlock bumps that (by design) write no revision; `data` never changed.
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,4)', [VER, SHEET, JSON.stringify({ [NAME]: 'ver-same', [SALARY]: 5 })])
      await rev(VER, 1, 'create', { [NAME]: 'ver-same', [SALARY]: 5 }, T0)

      const pv = await preview(T1)
      expect(pv.status).toBe(200)
      expect(pv.body?.data?.previewIdentity).toBeTruthy()
      const ex = await execute(T1, pv.body?.data?.previewIdentity)
      expect(ex.status).toBe(200)
      const ctrl = await recordRow(CTRL) // the operation genuinely proceeded: CTRL was reverted
      expect(ctrl?.data?.[NAME]).toBe('ctrl-old')
      expect(ctrl?.version).toBe(3)
      const ver = await recordRow(VER) // VER's version-only drift was never a revert target; untouched
      expect(ver?.data?.[NAME]).toBe('ver-same')
      expect(ver?.version).toBe(4)
    })

    test('G-HI-3: formula-sheet healthy record (live data carries a materialized formula key the snapshot lacks) → precheck PASSES (positive control)', async () => {
      const FRM = `rec_hi_frm_${strategy}_${TS}`
      // Healthy captured create: the revision snapshot is the user PATCH only (NAME+SALARY — mirrors
      // record-service.ts:706). Live `data` additionally carries the FORMULA key, materialized POST-COMMIT
      // by the formula engine with no version bump and no revision (formula-engine.ts:345). Without the
      // projection excluding derived types, this record would misreport as polluted.
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FRM, SHEET, JSON.stringify({ [NAME]: 'frm-old', [SALARY]: 9, [FORMULA]: 'materialized-value' })])
      await rev(FRM, 1, 'create', { [NAME]: 'frm-old', [SALARY]: 9 }, T0)

      const pv = await preview(T1)
      expect(pv.status).toBe(200)
      expect(pv.body?.data?.previewIdentity).toBeTruthy()
      const ex = await execute(T1, pv.body?.data?.previewIdentity)
      expect(ex.status).toBe(200)
      const ctrl = await recordRow(CTRL)
      expect(ctrl?.data?.[NAME]).toBe('ctrl-old') // proceeded
      const frm = await recordRow(FRM) // FRM was quiet (matches T1) — its materialized formula key survives
      expect(frm?.data?.[FORMULA]).toBe('materialized-value')
      expect(frm?.version).toBe(1)
    })

    test('G-HI-3-link: healthy record whose link array differs in ORDER/REPRESENTATION between live and snapshot → precheck PASSES (positive control)', async () => {
      const LK = `rec_hi_lk_${strategy}_${TS}`
      const LA = `lnktgt_a_${strategy}_${TS}`, LB = `lnktgt_b_${strategy}_${TS}`
      // `link` fields stay IN the projection (OD-4 — link ids are ordinary user-authored `data`), so they need
      // their OWN order-insensitive comparator. Snapshot holds the ids as an array in one order; live holds the
      // SAME id set as a comma-separated STRING in the OPPOSITE order — a representation/order difference only,
      // not a real edit. A raw value-equality comparator (JSON.stringify) would misreport this as polluted —
      // the link-shaped analogue of G-HI-3's formula false-positive.
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [LK, SHEET, JSON.stringify({ [NAME]: 'lk', [LINK]: `${LB},${LA}` })])
      await rev(LK, 1, 'create', { [NAME]: 'lk', [LINK]: [LA, LB] }, T0)

      const pv = await preview(T1)
      expect(pv.status).toBe(200)
      expect(pv.body?.data?.previewIdentity).toBeTruthy()
      const ex = await execute(T1, pv.body?.data?.previewIdentity)
      expect(ex.status).toBe(200)
      const ctrl = await recordRow(CTRL)
      expect(ctrl?.data?.[NAME]).toBe('ctrl-old') // proceeded
      const lk = await recordRow(LK) // LK was quiet (matches T1 under order-insensitive link comparison) — untouched
      expect(lk?.data?.[LINK]).toBe(`${LB},${LA}`)
      expect(lk?.version).toBe(1)
    })

    test('TOCTOU: an uncaptured write landing between preview and execute is caught because execute RE-RUNS the precheck', async () => {
      const pv = await preview(T1)
      expect(pv.status).toBe(200)
      const previewIdentity = pv.body?.data?.previewIdentity
      expect(previewIdentity).toBeTruthy()

      // Simulate the D-1c bug landing IN THE GAP: mutate CTRL's live `data` directly, with NO revision AND —
      // crucially — no version bump either. computeRecordRestoreDiff's diff entries are TARGET-keyed (the
      // value to revert TO), not live-keyed, so CTRL's diff-vs-T1 (still {NAME:'ctrl-old',...}) and its bound
      // `version` (still 2) are BOTH exactly what they were at preview time — the pre-existing
      // previewIdentity/scopeHash re-verification is therefore blind to this specific pollution (confirmed by
      // the mutation-proof below: with the precheck's execute call removed, this exact scenario's execute
      // returns 200 and writes). Only the fresh §0.6 re-check (item 4) catches it.
      await q('UPDATE meta_records SET data = data || $2::jsonb WHERE id = $1', [CTRL, JSON.stringify({ [NAME]: 'ctrl-uncaptured' })])

      const ex = await execute(T1, previewIdentity)
      expect(ex.status).toBe(409)
      expect(ex.body?.error?.code).toBe('HISTORY_INCOMPLETE') // NOT PREVIEW_IDENTITY_INVALID — this guard, specifically, caught it
      expect(ex.body?.data).toBeUndefined()

      const ctrl = await recordRow(CTRL)
      expect(ctrl?.data?.[NAME]).toBe('ctrl-uncaptured') // exactly the raw UPDATE above left it — execute wrote nothing more
      expect(ctrl?.data?.[SALARY]).toBe(200)
      expect(ctrl?.version).toBe(2)
      expect(await revisionCount(CTRL)).toBe(2) // no new 'restore' revision was appended
    })
  })
})
