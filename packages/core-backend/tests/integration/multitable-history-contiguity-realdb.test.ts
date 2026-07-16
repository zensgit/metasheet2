/**
 * W0-1 — generation-aware history contiguity (real DB, real routes). The owner-directed correction of §0.6:
 * the precheck's PRIMARY integrity proof is now CONTIGUITY (every version in the current generation is
 * accounted for by exactly one chain event or a lock/unlock marker), replacing #4234's live-vs-latest
 * comparator. Design lock: multitable-global-history-w0-1-...-design-lock-20260713.md (§6 owner ruling).
 *
 * Goldens (owner rubric; each mutation-proven — see the PR for the mutation matrix):
 *   HEALED-GAP (fail-first, #4252 §6.1)  v3 record, revisions {v1,v3}, live==v3 → revert/reset preview AND
 *       execute ALL 409, zero writes. A live-vs-latest comparator PASSES this; contiguity refuses it.
 *   LOCK-MARKERS (positive control)      a healthy record version-bumped by EACH of the FOUR lock/unlock
 *       sites (HTTP lock, HTTP unlock, automation lock, automation unlock) writes a marker → precheck PASSES.
 *       Without this leg a refuse-everything impl would pass HEALED-GAP.
 *   SYSTEM-SHEET EXCLUDED                a non-contiguous record on an approval-projection base sheet AND on a
 *       people-directory sheet is NOT refused (isSystemSheet skip).
 *   DELETE-REUSE                         a record created→updated→deleted (delete revision REUSES the last live
 *       version) leaves a healthy sibling revert/reset-able (delete-reuse is not a false hole).
 *   PHANTOM-INSERT RACE (C4/C8)          a constructed two-connection race: a phantom uncaptured record inserted
 *       while reset-execute is blocked on the per-sheet advisory fence is caught by the in-txn re-check → 409,
 *       zero destructive writes. Proves the advisory lock is on the destructive path AND the check/write are atomic.
 *   POSITIVE CONTROL                     a full healthy chain reverts/executes at any T.
 *
 * Two-point wiring: plugin-tests.yml real-DB run list + vitest.integration.config.ts. Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { AutomationExecutor, type AutomationDeps, type AutomationRule } from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'
import { APPROVAL_PROJECTION_BASE_ID } from '../../src/multitable/approval-projection-constants'
import { SYSTEM_PEOPLE_SHEET_DESCRIPTION } from '../../src/multitable/system-sheet-predicate'
import { precheckSheetHistoryIntegrity } from '../../src/multitable/history-integrity-precheck'
import { PIT_RECOVERY_LOCK_NS } from '../../src/multitable/canonical-sheet-fence'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_hc_${TS}`
const SHEET = `sheet_hc_${TS}`
const SHEET_PROJ = `sheet_hc_proj_${TS}`   // system sheet: base_id = approval projection base
const SHEET_PEOPLE = `sheet_hc_people_${TS}` // system sheet: description = people sentinel
const NAME = `fld_hc_name_${TS}`, SALARY = `fld_hc_salary_${TS}`
const PNAME = `fld_hc_pname_${TS}`
const ACTOR = `user_hc_${TS}`
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-02T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'
const NS = PIT_RECOVERY_LOCK_NS // single source of truth (canonical-sheet-fence.ts) — was a hand-copied literal

const HISTORY_INCOMPLETE_BODY = {
  ok: false,
  error: {
    code: 'HISTORY_INCOMPLETE',
    message: 'Record history for this sheet is incomplete or inconsistent with its live data; destructive recovery is refused and nothing was written. History must be trustworthy before revert/reset can run.',
  },
}

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
const revertPreview = (sheet: string, asOf = T1) => request(app).post(`/api/multitable/sheets/${sheet}/revert-preview`).send({ asOf })
const revertExecute = (sheet: string, previewIdentity: string, asOf = T1) => request(app).post(`/api/multitable/sheets/${sheet}/revert-execute`).send({ asOf, previewIdentity })
const resetPreview = (sheet: string, asOf = T1) => request(app).post(`/api/multitable/sheets/${sheet}/reset-preview`).send({ asOf })
const resetExecute = (sheet: string, previewIdentity: string, asOf = T1) => request(app).post(`/api/multitable/sheets/${sheet}/reset-execute`).send({ asOf, previewIdentity, confirm: 'reset' })
const lockRecord = (id: string, locked: boolean) => request(app).post(`/api/multitable/records/${id}/lock`).send({ locked })

const rev = (sheet: string, id: string, version: number, action: string, snap: Record<string, unknown>, at: string) =>
  q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6)`, [sheet, id, version, action, JSON.stringify(snap), at])
const insertLive = (sheet: string, id: string, data: Record<string, unknown>, version: number) =>
  q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [id, sheet, JSON.stringify(data), version])
const markerCount = async (sheet: string, id: string, version: number): Promise<number> =>
  Number(((await q('SELECT count(*)::int c FROM meta_record_version_markers WHERE sheet_id=$1 AND record_id=$2 AND version=$3', [sheet, id, version])).rows[0] as { c: number }).c)
const recordRow = async (id: string) => (await q('SELECT data, version FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function sheetWriteState(sheet: string) {
  const records = (await q('SELECT id, data, version FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheet])).rows
  const revisionCount = Number(((await q('SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1', [sheet])).rows[0] as { c: number }).c)
  const trashCount = Number(((await q('SELECT count(*)::int c FROM meta_records_trash WHERE sheet_id = $1', [sheet])).rows[0] as { c: number }).c)
  return { records, revisionCount, trashCount }
}

async function expectAllFourRefuseWithZeroWrites(sheet: string): Promise<void> {
  const before = await sheetWriteState(sheet)
  const pvRevert = await revertPreview(sheet)
  expect(pvRevert.status).toBe(409); expect(pvRevert.body).toEqual(HISTORY_INCOMPLETE_BODY)
  const exRevert = await revertExecute(sheet, 'dummy-never-minted')
  expect(exRevert.status).toBe(409); expect(exRevert.body).toEqual(HISTORY_INCOMPLETE_BODY)
  const pvReset = await resetPreview(sheet)
  expect(pvReset.status).toBe(409); expect(pvReset.body).toEqual(HISTORY_INCOMPLETE_BODY)
  const exReset = await resetExecute(sheet, 'dummy-never-minted')
  expect(exReset.status).toBe(409); expect(exReset.body).toEqual(HISTORY_INCOMPLETE_BODY)
  expect(await sheetWriteState(sheet)).toEqual(before)
}

function makeAutomationExecutor(): AutomationExecutor {
  const deps: AutomationDeps = { eventBus: new EventBus(), queryFn: (sql: string, params?: unknown[]) => q(sql, params ?? []) }
  return new AutomationExecutor(deps)
}
const lockRule = (locked: boolean): AutomationRule => ({
  id: `axr_hc_${TS}_${Math.random().toString(36).slice(2, 8)}`,
  name: 'hc-lock', sheetId: SHEET, enabled: true, trigger: { type: 'record.updated', config: {} },
  actions: [{ type: 'lock_record', config: { locked } } as never],
  createdBy: ACTOR, createdAt: new Date().toISOString(),
} as unknown as AutomationRule)

describeIfDatabase('W0-1 generation-aware history contiguity (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'HC Base'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [APPROVAL_PROJECTION_BASE_ID, 'Approval Projection']) // shared system base
    // plain sheet + a projection-base sheet + a people-sentinel sheet
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3),($4,$5,$6)', [SHEET, BASE, 'HC', SHEET_PROJ, APPROVAL_PROJECTION_BASE_ID, 'HC Proj'])
    await q('INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,$3,$4)', [SHEET_PEOPLE, BASE, 'People', SYSTEM_PEOPLE_SHEET_DESCRIPTION])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    for (const s of [SHEET_PROJ, SHEET_PEOPLE]) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [`${NAME}_${s}`, s, 'Name', 'string', '{}', 1])
    }
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
    for (const sheet of [SHEET, SHEET_PROJ, SHEET_PEOPLE]) {
      for (const t of ['meta_record_version_markers', 'meta_records_trash', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })
  beforeEach(async () => {
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    // #4261 (landed mid-flight on main) closes revert-execute by default behind this master gate;
    // these goldens assert the CONTIGUITY precheck's verdicts, so the interim gate must be open.
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    for (const sheet of [SHEET, SHEET_PROJ, SHEET_PEOPLE]) {
      await q('DELETE FROM meta_record_version_markers WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheet])
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet])
    }
    // H — the healthy captured record shared by scenarios (old@T0 → new@T2), contiguous chain.
    await insertLive(SHEET, `rec_h_${TS}`, { [NAME]: 'new', [SALARY]: 200 }, 2)
    await rev(SHEET, `rec_h_${TS}`, 1, 'create', { [NAME]: 'old', [SALARY]: 100 }, T0)
    await rev(SHEET, `rec_h_${TS}`, 2, 'update', { [NAME]: 'new', [SALARY]: 200 }, T2)
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── HEALED-GAP (fail-first, ported verbatim from #4252 §6.1) ──────────────────────────────────────────────
  test('HEALED-GAP: v3 record with revisions {v1,v3} (v2 uncaptured) → all four surfaces refuse, zero writes', async () => {
    const HG = `rec_hi_healedgap_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,3)', [HG, SHEET, JSON.stringify({ [NAME]: 'hg-v3-healed', [SALARY]: 300 })])
    await rev(SHEET, HG, 1, 'create', { [NAME]: 'hg-v1', [SALARY]: 100 }, T0)
    await rev(SHEET, HG, 3, 'update', { [NAME]: 'hg-v3-healed', [SALARY]: 300 }, T2) // NO v2 — uncaptured mid-chain write
    expect((await recordRow(HG))?.version).toBe(3)
    expect(Number(((await q('SELECT count(*)::int c FROM meta_record_revisions WHERE record_id=$1', [HG])).rows[0] as { c: number }).c)).toBe(2)
    // T1 ∈ (v1@T0, v3@T2) — the gap window. Contiguity refuses; a live-vs-latest comparator alone does not.
    await expectAllFourRefuseWithZeroWrites(SHEET)
  })

  // ── LOCK-MARKERS positive control (all FOUR lock/unlock sites) ────────────────────────────────────────────
  test('LOCK-MARKERS: a healthy record bumped by ALL FOUR lock/unlock sites writes markers → precheck PASSES', async () => {
    const L = `rec_hc_lock_${TS}`
    await insertLive(SHEET, L, { [NAME]: 'lk' }, 1)
    await rev(SHEET, L, 1, 'create', { [NAME]: 'lk' }, T0)
    // HTTP lock (1→2) + HTTP unlock (2→3)
    expect((await lockRecord(L, true)).status).toBe(200)
    expect((await lockRecord(L, false)).status).toBe(200)
    // automation lock (3→4) + automation unlock (4→5) — REAL AutomationExecutor, same-base lock_record.
    const exec = makeAutomationExecutor()
    expect((await exec.execute(lockRule(true), { recordId: L, sheetId: SHEET, actorId: ACTOR, data: {} })).steps[0]?.status).toBe('success')
    expect((await exec.execute(lockRule(false), { recordId: L, sheetId: SHEET, actorId: ACTOR, data: {} })).steps[0]?.status).toBe('success')
    const after = await recordRow(L)
    expect(after?.version).toBe(5) // four legitimate non-data version bumps
    // Each bump wrote its marker (2,3 = HTTP; 4,5 = automation). This is what makes them not-a-hole.
    for (const v of [2, 3, 4, 5]) expect(await markerCount(SHEET, L, v)).toBe(1)
    // precheck PASSES: markers fill v2..v5, create fills v1 → contiguous. Revert previews + executes.
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.previewIdentity).toBeTruthy()
    const ex = await revertExecute(SHEET, pv.body?.data?.previewIdentity)
    expect(ex.status).toBe(200)
    const l = await recordRow(L)
    expect(l?.data?.[NAME]).toBe('lk') // L untouched by the revert (already at its T1 state)
  })

  test('LOCK-MARKERS mutation surface: a lock bump with the marker DELETED becomes a hole → refused', async () => {
    // Simulates the mutation "remove the lock-marker write": the version bumped but no marker exists ⇒ hole.
    const L = `rec_hc_lockmut_${TS}`
    await insertLive(SHEET, L, { [NAME]: 'lk' }, 1)
    await rev(SHEET, L, 1, 'create', { [NAME]: 'lk' }, T0)
    expect((await lockRecord(L, true)).status).toBe(200) // 1→2, marker@2 written
    await q('DELETE FROM meta_record_version_markers WHERE sheet_id=$1 AND record_id=$2', [SHEET, L]) // neuter the marker
    await expectAllFourRefuseWithZeroWrites(SHEET) // v2 is now an unexplained hole
  })

  // ── SYSTEM-SHEET EXCLUSION ───────────────────────────────────────────────────────────────────────────────
  test('SYSTEM-SHEET (approval projection base): a non-contiguous record is EXCLUDED by the precheck (direct call — the base ALSO capability-fences non-admins at the route)', async () => {
    // The approval-projection base denies canManageSheetAccess to non-admins (403 at the route BEFORE the
    // precheck), so the isSystemSheet SKIP is proven at the precheck itself: the same non-contiguous shape
    // that refuses on a plain sheet passes on the projection-base sheet.
    const R = `rec_hc_proj_${TS}`
    const f = `${NAME}_${SHEET_PROJ}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,3)', [R, SHEET_PROJ, JSON.stringify({ [f]: 'v3' })])
    await rev(SHEET_PROJ, R, 1, 'create', { [f]: 'v1' }, T0)
    await rev(SHEET_PROJ, R, 3, 'update', { [f]: 'v3' }, T2) // hole at v2
    const pool = poolManager.get()
    expect(await precheckSheetHistoryIntegrity(pool.query.bind(pool), SHEET_PROJ)).toEqual({ ok: true }) // excluded
    // Discriminator: the SAME non-contiguous shape on the plain (non-system) SHEET refuses.
    const R2 = `rec_hc_proj_ctrl_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,3)', [R2, SHEET, JSON.stringify({ [NAME]: 'v3' })])
    await rev(SHEET, R2, 1, 'create', { [NAME]: 'v1' }, T0)
    await rev(SHEET, R2, 3, 'update', { [NAME]: 'v3' }, T2)
    expect(await precheckSheetHistoryIntegrity(pool.query.bind(pool), SHEET)).toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('SYSTEM-SHEET (people directory): a non-contiguous record is NOT refused (isSystemSheet skip)', async () => {
    const R = `rec_hc_people_${TS}`
    const f = `${NAME}_${SHEET_PEOPLE}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,3)', [R, SHEET_PEOPLE, JSON.stringify({ [f]: 'v3' })])
    await rev(SHEET_PEOPLE, R, 1, 'create', { [f]: 'v1' }, T0)
    await rev(SHEET_PEOPLE, R, 3, 'update', { [f]: 'v3' }, T2)
    const pv = await revertPreview(SHEET_PEOPLE)
    expect(pv.status).toBe(200)
  })

  // ── DELETE-REUSE ─────────────────────────────────────────────────────────────────────────────────────────
  test('DELETE-REUSE: a deleted record whose delete revision REUSES the last live version is not a false hole', async () => {
    // DR: create@1, update@2, then a DELETE that reuses v2 (the record-service delete shape). DR is gone
    // (in trash), NOT live — its delete-reuse revision must not false-refuse the healthy live sibling H.
    const DR = `rec_hc_delreuse_${TS}`
    await rev(SHEET, DR, 1, 'create', { [NAME]: 'dr1', [SALARY]: 1 }, T0)
    await rev(SHEET, DR, 2, 'update', { [NAME]: 'dr2', [SALARY]: 2 }, T2)
    await rev(SHEET, DR, 2, 'delete', { [NAME]: 'dr2', [SALARY]: 2 }, T2) // delete REUSES version 2 (not v3)
    // DR is deleted (no live row); only the healthy H is live. Contiguity is per-record + live-only.
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200) // H is contiguous; DR's delete-reuse revision is not enumerated (not live)
    expect(pv.body?.data?.summary?.visibleRevertCount).toBe(1) // H → old
  })

  // ── PHANTOM-INSERT RACE (C4/C8, constructed two-connection race) ─────────────────────────────────────────
  test('PHANTOM-INSERT RACE: a phantom uncaptured record landing while reset-execute holds the fence is caught in-txn → 409, zero destructive writes', async () => {
    // A healthy delete-candidate D (created AFTER T1 ⇒ reset-to-T1 would DELETE it). History complete at preview.
    const D = `rec_hc_delcand_${TS}`
    await insertLive(SHEET, D, { [NAME]: 'delme' }, 1)
    await rev(SHEET, D, 1, 'create', { [NAME]: 'delme' }, T2) // created after T1
    const pv = await resetPreview(SHEET)
    expect(pv.status).toBe(200)
    const identity = pv.body?.data?.previewIdentity as string
    expect(identity).toBeTruthy()
    expect(pv.body?.data?.deleteRecordIds).toContain(D)

    // Connection B holds the sheet's advisory fence open until we release it.
    let release: () => void = () => {}
    const held = new Promise<void>((r) => { release = r })
    const bDone = poolManager.get().transaction(async ({ query }) => {
      await query('SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)', [NS, SHEET])
      await held
    })
    const advisory = async (granted: boolean): Promise<number> =>
      Number(((await q(`SELECT count(*)::int c FROM pg_locks WHERE locktype='advisory' AND classid=$1 AND granted=$2`, [NS, granted])).rows[0] as { c: number }).c)
    const waitFor = async (pred: () => Promise<boolean>, label: string) => {
      for (let i = 0; i < 300; i++) { if (await pred()) return; await sleep(15) }
      throw new Error(`timeout waiting for ${label}`)
    }
    let res: request.Response | undefined
    try {
      await waitFor(async () => (await advisory(true)) >= 1, 'B holds the advisory lock')
      // Fire reset-execute: it passes the OUTER precheck (history complete, no phantom yet), enters the
      // destructive txn, and BLOCKS acquiring the advisory fence B holds. `.then((r) => r)` DISPATCHES the
      // (lazy) supertest request immediately and returns a real Promise we can race/await.
      const resetP: Promise<request.Response> = resetExecute(SHEET, identity).then((r) => r)
      await waitFor(async () => (await advisory(false)) >= 1, 'reset-execute blocked on the fence')
      // PROVE the fence is on the destructive path: reset has NOT completed while B holds the lock.
      const pending = await Promise.race([resetP.then(() => 'done'), sleep(150).then(() => 'pending')])
      expect(pending).toBe('pending')
      // The phantom uncaptured write lands NOW (after the outer precheck already passed) and commits.
      const PH = `rec_hc_phantom_${TS}`
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,3)', [PH, SHEET, JSON.stringify({ [NAME]: 'phantom' })])
      await rev(SHEET, PH, 1, 'create', { [NAME]: 'ph1' }, T0)
      await rev(SHEET, PH, 3, 'update', { [NAME]: 'phantom' }, T2) // hole at v2
      release() // reset acquires the fence → runs the in-txn re-check → sees the phantom → refuses
      res = await resetP
    } finally {
      release()
      await bDone.catch(() => {})
    }
    expect(res!.status).toBe(409)
    expect(res!.body).toEqual(HISTORY_INCOMPLETE_BODY)
    expect(await recordRow(D)).toBeTruthy() // D was NOT deleted — the in-txn re-check rolled the whole reset back
  })

  // ── GLOBAL POSITIVE CONTROL ──────────────────────────────────────────────────────────────────────────────
  test('POSITIVE CONTROL: a full healthy chain reverts and executes at T (guards against refuse-everything)', async () => {
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.summary?.visibleRevertCount).toBe(1)
    const ex = await revertExecute(SHEET, pv.body?.data?.previewIdentity)
    expect(ex.status).toBe(200)
    const h = await recordRow(`rec_h_${TS}`)
    expect(h?.data?.[NAME]).toBe('old')
    expect(h?.version).toBe(3)
  })
})
