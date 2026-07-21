/**
 * D-1c §0.6 `HISTORY_INCOMPLETE` — fail-closed integrity precheck for destructive recovery (owner hard-lock,
 * RATIFIED 2026-07-13; lands FIRST, before the five A1–A8 write-path slices). Real DB, real routes.
 *
 * Goldens (all four owner-mandated, each mutation-proven — see the PR for the mutation matrix):
 *   G-HI-1  polluted record (live user-field data ≠ latest revision snapshot) → revert/reset preview AND
 *           execute ALL return 409 HISTORY_INCOMPLETE; post-assertion proves ZERO rows written, no revision
 *           added, no trash row, and NO previewIdentity token minted (error body carries no data).
 *   G-HI-2  version-only change (record lock/unlock via the REAL lock route bumps `version`, data untouched)
 *           → precheck PASSES and revert/reset proceed normally (content-not-version pinned).
 *   G-HI-3  formula-sheet healthy record — live `data` carries materialized formula/autoNumber keys the
 *           snapshot lacks (the record-service create shape: snapshot = user patch in-txn, derived keys
 *           materialize post-commit), and a snapshot whose STALE derived value differs from live — →
 *           precheck PASSES (pins the user-authored-field projection; without it a refuse-everything
 *           implementation would pass G-HI-1/2/4).
 *   G-HI-4  live record with ZERO revisions (the uncaptured-CREATE fingerprint) → revert/reset preview AND
 *           execute refuse with zero writes — pins that the precheck enumerates the LIVE row set, not the
 *           reconstruction (computeSheetReset pushes live rows absent from the reconstruction into its
 *           delete-set: this golden closes the silent-delete-on-reset hole).
 *   HI-5    (fail-closed extension, same doctrine) a LIVE row whose LATEST revision is a `delete` — history
 *           claims the record is dead, so reset would push it into the delete-set even though the content
 *           projection matches the pre-delete snapshot → refused. No captured path produces this state
 *           (trash-restore and PIT-resurrect both write a fresh 'create' revision in-txn).
 *   P3-1    hardening (post-ratification, same doctrine): the projection excludes the four SYSTEM field
 *           types (createdTime/modifiedTime/createdBy/modifiedBy — `field-codecs`'s canonical
 *           `SYSTEM_FIELD_TYPES`) exactly like the four derived-value types. Not a live false-positive today
 *           (no writer puts a value under a system field id in `data` — it is derived at READ time from
 *           `created_at`/`updated_at`/`created_by`/`modified_by`), but a stray/legacy value under a system
 *           field id must never be able to pollute-refuse a healthy record.
 *
 * The refusal body is asserted EXACTLY (deepEqual) — it is values-free by contract: no record ids, no counts
 * (no denied-record existence oracle), and no data/previewIdentity.
 *
 * Runs only with DATABASE_URL (two-point wiring: plugin-tests.yml real-DB run list + vitest.config.ts no-DB
 * exclude — same convention as multitable-reset-pit-realdb.test.ts).
 */
import express, { type Express } from 'express'
import request from 'supertest'
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
const BASE = `base_hi_${TS}`
const SHEET = `sheet_hi_plain_${TS}`      // plain sheet: string + number fields
const SHEET_F = `sheet_hi_formula_${TS}`  // formula sheet: string + formula + autoNumber fields
const SHEET_S = `sheet_hi_system_${TS}`   // P3-1: string + a system-computed (modifiedTime) field
const NAME = `fld_hi_name_${TS}`, SALARY = `fld_hi_salary_${TS}`
const FNAME = `fld_hi_fname_${TS}`, FORMULA = `fld_hi_formula_${TS}`, AUTON = `fld_hi_auton_${TS}`
const SNAME = `fld_hi_sname_${TS}`, SMOD = `fld_hi_smod_${TS}` // P3-1 system-field sheet
const H = `rec_hi_h_${TS}`   // healthy revert candidate (old@T0 → new@T2) — gives every op real work at T1
const P = `rec_hi_p_${TS}`   // polluted: live data ≠ latest snapshot (G-HI-1)
const X = `rec_hi_x_${TS}`   // version-only drift via real lock/unlock (G-HI-2)
const Z = `rec_hi_z_${TS}`   // zero-revision live row (G-HI-4)
const ZD = `rec_hi_zd_${TS}` // live row whose latest revision is a delete (HI-5)
const F1 = `rec_hi_f1_${TS}`, F2 = `rec_hi_f2_${TS}` // formula-sheet records (G-HI-3)
const SYS1 = `rec_hi_sys1_${TS}` // system-field-sheet record (P3-1)
const ACTOR = `user_hi_${TS}`
const T0 = '2026-01-01T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'

// The EXACT unified refusal body (rule 1) — deepEqual everywhere so any leak of ids/counts/token reds the golden.
const HISTORY_INCOMPLETE_BODY = {
  ok: false,
  error: {
    code: 'HISTORY_INCOMPLETE',
    message: 'Record history for this sheet is incomplete or inconsistent with its live data; destructive recovery is refused and nothing was written. History must be trustworthy before revert/reset can run.',
  },
}

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
const fixtures = new Map<string, ExactAnchorHistoryFixture>()
const fixtureFor = (sheet: string): ExactAnchorHistoryFixture => {
  const fixture = fixtures.get(sheet)
  if (!fixture) throw new Error(`exact-anchor fixture missing for ${sheet}`)
  return fixture
}
const revertPreview = (sheet: string) => request(app).post(`/api/multitable/sheets/${sheet}/revert-preview`).send({ anchorOperationId: fixtureFor(sheet).anchorOperationId() })
const revertExecute = (sheet: string, previewIdentity: string) => request(app).post(`/api/multitable/sheets/${sheet}/revert-execute`).send({ previewIdentity })
const resetPreview = (sheet: string) => request(app).post(`/api/multitable/sheets/${sheet}/reset-preview`).send({ anchorOperationId: fixtureFor(sheet).anchorOperationId() })
const resetExecute = (sheet: string, previewIdentity: string) => request(app).post(`/api/multitable/sheets/${sheet}/reset-execute`).send({ previewIdentity, confirm: 'reset' })
const lockRecord = (id: string, locked: boolean) => request(app).post(`/api/multitable/records/${id}/lock`).send({ locked })

const rev = (
  sheet: string,
  id: string,
  version: number,
  action: 'create' | 'update' | 'delete',
  snap: Record<string, unknown>,
  at: string,
  options?: { anchor?: boolean },
) => fixtureFor(sheet).insertRevision({
  recordId: id,
  version,
  action,
  snapshot: snap,
  createdAt: at,
  phase: options?.anchor ? 'anchor' : at === T0 ? 'before' : 'after',
})
const insertLive = (sheet: string, id: string, data: Record<string, unknown>, version: number) =>
  q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [id, sheet, JSON.stringify(data), version])

/** Full observable write-state of a sheet — the ZERO-WRITES post-assertion compares this before/after. */
async function sheetWriteState(sheet: string): Promise<{
  records: Array<{ id: string; data: Record<string, unknown>; version: number }>
  revisionCount: number
  restoreRevisionCount: number
  trashCount: number
  operationCount: number
  tokenBurnCount: number
}> {
  const records = (await q('SELECT id, data, version FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheet])).rows as Array<{ id: string; data: Record<string, unknown>; version: number }>
  const revisionCount = Number(((await q('SELECT count(*)::int AS c FROM meta_record_revisions WHERE sheet_id = $1', [sheet])).rows[0] as { c: number }).c)
  const restoreRevisionCount = Number(((await q(`SELECT count(*)::int AS c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [sheet])).rows[0] as { c: number }).c)
  const trashCount = Number(((await q('SELECT count(*)::int AS c FROM meta_records_trash WHERE sheet_id = $1', [sheet])).rows[0] as { c: number }).c)
  const operationCount = Number(((await q('SELECT count(*)::int AS c FROM meta_record_history_operations WHERE sheet_id = $1', [sheet])).rows[0] as { c: number }).c)
  const tokenBurnCount = Number(((await q('SELECT count(*)::int AS c FROM meta_recovery_token_burns WHERE sheet_id = $1', [sheet])).rows[0] as { c: number }).c)
  return { records, revisionCount, restoreRevisionCount, trashCount, operationCount, tokenBurnCount }
}

/** Drives all FOUR gated surfaces against a sheet expected to refuse, asserting the exact unified body and
 *  that no execute token exists in either failing preview. Execute identities are minted while the fixture
 *  is healthy, then the supplied mutation creates the gap so the in-fence re-check is exercised. */
async function expectAllFourRefuseWithZeroWrites(sheet: string, mutate: () => Promise<void>): Promise<void> {
  const healthyRevert = await revertPreview(sheet)
  const healthyReset = await resetPreview(sheet)
  expect(healthyRevert.status).toBe(200)
  expect(healthyReset.status).toBe(200)
  expect(healthyRevert.body?.data?.previewIdentity).toBeTruthy()
  expect(healthyReset.body?.data?.previewIdentity).toBeTruthy()
  await mutate()
  const before = await sheetWriteState(sheet)
  const pvRevert = await revertPreview(sheet)
  expect(pvRevert.status).toBe(409)
  expect(pvRevert.body).toEqual(HISTORY_INCOMPLETE_BODY) // exact: no data, no previewIdentity → no token minted
  const exRevert = await revertExecute(sheet, healthyRevert.body.data.previewIdentity)
  expect(exRevert.status).toBe(409)
  expect(exRevert.body).toEqual(HISTORY_INCOMPLETE_BODY)
  const pvReset = await resetPreview(sheet)
  expect(pvReset.status).toBe(409)
  expect(pvReset.body).toEqual(HISTORY_INCOMPLETE_BODY)
  const exReset = await resetExecute(sheet, healthyReset.body.data.previewIdentity)
  expect(exReset.status).toBe(409)
  expect(exReset.body).toEqual(HISTORY_INCOMPLETE_BODY)
  // ZERO WRITES — assert the DB, not just the responses: identical rows/versions, no new revision (of any
  // source), no restore revision, no trash row.
  expect(await sheetWriteState(sheet)).toEqual(before)
}

describeIfDatabase('multitable D-1c §0.6 HISTORY_INCOMPLETE precheck (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'HI Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3),($4,$2,$5),($6,$2,$7)', [SHEET, BASE, 'HI Plain', SHEET_F, 'HI Formula', SHEET_S, 'HI System'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FNAME, SHEET_F, 'FName', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FORMULA, SHEET_F, 'Computed', 'formula', JSON.stringify({ expression: `{${FNAME}}` }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [AUTON, SHEET_F, 'Seq', 'autoNumber', '{}', 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SNAME, SHEET_S, 'SName', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SMOD, SHEET_S, 'Modified', 'modifiedTime', '{}', 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    for (const sheet of [SHEET, SHEET_F, SHEET_S]) {
      await pruneSealedHistoryOperations(sheet).catch(() => {})
      for (const t of ['meta_history_baselines', 'meta_history_trust_checkpoints', 'meta_recovery_token_burns', 'meta_record_version_markers', 'meta_records_trash', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })
  beforeEach(async () => {
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    // Interim revert-execute master gate (current-risk mitigation): the route is default-OFF now, so keep it
    // on for this suite's pre-existing goldens — unchanged behavior. See multitable-revert-pit-realdb.test.ts for
    // the dedicated flag-off/on gate goldens.
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
    fixtures.clear()
    for (const sheet of [SHEET, SHEET_F, SHEET_S]) {
      // W0-1 v3.7: `recordVersionMarker` no longer has `ON CONFLICT ... DO NOTHING` (the cross-generation
      // UNIQUE it targeted was dropped — "loud marker", see history-integrity-precheck.ts's module doc).
      // G-HI-2 reuses record id X across two tests in this file; a leftover marker from a PRIOR test at the
      // same (sheet, record, version) — previously silently swallowed by the now-removed ON CONFLICT — would
      // otherwise coexist with the marker THIS test's real lock/unlock writes, creating a genuine duplicate
      // occupant. Clear markers every test, exactly like multitable-history-contiguity-realdb.test.ts already does.
      await pruneSealedHistoryOperations(sheet)
      await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_recovery_token_burns WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_record_version_markers WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheet])
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet])
      fixtures.set(sheet, await prepareExactAnchorHistoryFixture(sheet))
    }
    // H: the healthy captured record every scenario shares — old@T0, new@T2, live == latest snapshot.
    await insertLive(SHEET, H, { [NAME]: 'new', [SALARY]: 200 }, 2)
    await rev(SHEET, H, 1, 'create', { [NAME]: 'old', [SALARY]: 100 }, T0, { anchor: true })
    await rev(SHEET, H, 2, 'update', { [NAME]: 'new', [SALARY]: 200 }, T2)
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('POSITIVE CONTROL: an all-healthy sheet passes the precheck — revert previews, mints a token, and executes', async () => {
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.summary?.visibleRevertCount).toBe(1)
    expect(pv.body?.data?.previewIdentity).toBeTruthy()
    const ex = await revertExecute(SHEET, pv.body?.data?.previewIdentity)
    expect(ex.status).toBe(200)
    expect(ex.body?.data?.revertedCount).toBe(1)
    const h = (await q('SELECT data, version FROM meta_records WHERE id = $1', [H])).rows[0] as { data: Record<string, unknown>; version: number }
    expect(h.data[NAME]).toBe('old')
    expect(h.version).toBe(3) // forward revision — and the revert's own write leaves live == latest snapshot
  })

  test('G-HI-1: polluted record (live user-field data ≠ latest snapshot) → all four surfaces refuse, zero writes, no token', async () => {
    // P was created captured (v1) then hit by an UNCAPTURED write (the A1–A8 fingerprint): live v2 data
    // disagrees with the latest (v1 create) snapshot on a user-authored field. Seeded with raw SQL exactly
    // like the reproduced defect leaves it (§3 of the lock: form-submit EDIT bumps version, rewrites data,
    // writes no revision).
    await expectAllFourRefuseWithZeroWrites(SHEET, async () => {
      await insertLive(SHEET, P, { [NAME]: 'v2-uncaptured', [SALARY]: 100 }, 2)
      await rev(SHEET, P, 1, 'create', { [NAME]: 'v1-original', [SALARY]: 100 }, T0)
    })
  })

  test('G-HI-2: version-only drift (real lock/unlock route bumps version, data untouched) → precheck passes, revert proceeds', async () => {
    await insertLive(SHEET, X, { [NAME]: 'x-val' }, 1)
    await rev(SHEET, X, 1, 'create', { [NAME]: 'x-val' }, T0)
    // Drive the REAL lock-disposition path — not raw SQL — so the version-only mutation is production-shaped:
    // lock bumps version 1→2, unlock 2→3; `data` is never touched and no revision is written (bucket C).
    expect((await lockRecord(X, true)).status).toBe(200)
    expect((await lockRecord(X, false)).status).toBe(200)
    const xAfterLock = (await q('SELECT data, version, locked FROM meta_records WHERE id = $1', [X])).rows[0] as { data: Record<string, unknown>; version: number; locked: boolean }
    expect(xAfterLock.version).toBe(3) // version moved WITHOUT a revision — the exact class rule 2 must not refuse
    expect(xAfterLock.locked).toBe(false)
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200) // NOT refused — content comparison, never version comparison
    expect(pv.body?.data?.summary?.visibleRevertCount).toBe(1) // H only; X already matches its T1 state
    const ex = await revertExecute(SHEET, pv.body?.data?.previewIdentity)
    expect(ex.status).toBe(200)
    expect(ex.body?.data?.revertedCount).toBe(1)
    const x = (await q('SELECT data, version FROM meta_records WHERE id = $1', [X])).rows[0] as { data: Record<string, unknown>; version: number }
    expect(x.data[NAME]).toBe('x-val') // X untouched
    expect(x.version).toBe(3)
  })

  test('G-HI-2 (reset leg): version-only drift → reset preview/execute proceed', async () => {
    await insertLive(SHEET, X, { [NAME]: 'x-val' }, 1)
    await rev(SHEET, X, 1, 'create', { [NAME]: 'x-val' }, T0)
    expect((await lockRecord(X, true)).status).toBe(200)
    expect((await lockRecord(X, false)).status).toBe(200)
    const pv = await resetPreview(SHEET)
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.summary?.visibleRevertCount).toBe(1) // H
    expect(pv.body?.data?.summary?.deleteCount).toBe(0) // X existed at T1 — nothing to delete
    const ex = await resetExecute(SHEET, pv.body?.data?.previewIdentity)
    expect(ex.status).toBe(200)
    expect(ex.body?.data?.revertedCount).toBe(1)
    expect(ex.body?.data?.deletedCount).toBe(0)
    const x = (await q('SELECT data, version FROM meta_records WHERE id = $1', [X])).rows[0] as { data: Record<string, unknown>; version: number }
    expect(x.data[NAME]).toBe('x-val')
    expect(x.version).toBe(3)
  })

  test('G-HI-3: formula-sheet healthy records (materialized derived keys absent from / stale in snapshots) → precheck passes, revert AND reset proceed', async () => {
    // F1 — the healthy CREATE shape (record-service.ts create): the in-txn revision snapshots the USER patch;
    // formula + autoNumber keys materialize into live `data` post-commit with no revision, BY DESIGN. A
    // full-data comparator would refuse every such record — the projection must not.
    await insertLive(SHEET_F, F1, { [FNAME]: 'n1', [FORMULA]: 'n1', [AUTON]: 7 }, 1)
    await rev(SHEET_F, F1, 1, 'create', { [FNAME]: 'n1' }, T0, { anchor: true })
    // F2 — the healthy UPDATE shape, harder: the v2 snapshot CARRIES a derived value that has since been
    // RECOMPUTED in live (stale-vs-fresh drift on a derived key) — still healthy, still must pass.
    await insertLive(SHEET_F, F2, { [FNAME]: 'new', [FORMULA]: 'fresh-recompute', [AUTON]: 8 }, 2)
    await rev(SHEET_F, F2, 1, 'create', { [FNAME]: 'old' }, T0)
    await rev(SHEET_F, F2, 2, 'update', { [FNAME]: 'new', [FORMULA]: 'stale-materialized', [AUTON]: 8 }, T2)
    const pv = await revertPreview(SHEET_F)
    expect(pv.status).toBe(200) // NOT refused — the projection excludes formula/rollup/lookup/autoNumber
    expect(pv.body?.data?.summary?.visibleRevertCount).toBe(1) // F2 → old; F1 has no user-field drift
    const ex = await revertExecute(SHEET_F, pv.body?.data?.previewIdentity)
    expect(ex.status).toBe(200)
    expect(ex.body?.data?.revertedCount).toBe(1)
    const f2 = (await q('SELECT data FROM meta_records WHERE id = $1', [F2])).rows[0] as { data: Record<string, unknown> }
    expect(f2.data[FNAME]).toBe('old')
    // Reset leg on the same (now revert-written) sheet — the revert's own captured write must leave the sheet
    // precheck-clean, and reset must also pass the projection.
    const pvReset = await resetPreview(SHEET_F)
    expect(pvReset.status).toBe(200)
    const exReset = await resetExecute(SHEET_F, pvReset.body?.data?.previewIdentity ?? 'no-op')
    // After the revert the sheet already matches T1 → reset preview may be a no-op (null identity, no token);
    // both shapes are healthy: either nothing to execute, or an execute that succeeds.
    if (pvReset.body?.data?.previewIdentity) {
      expect(exReset.status).toBe(200)
    } else {
      expect(pvReset.body?.data?.summary).toEqual({
          visibleRevertCount: 0,
          deleteCount: 0,
          visibleUndeleteCount: 0,
          conflictCount: 0,
          resurrectCount: 0,
          driftCount: 0,
          effectiveWriteCount: 0,
          keptCreatedAfterTCount: 0,
        })
    }
  })

  test('G-HI-4: live record with ZERO revisions (uncaptured CREATE) → all four surfaces refuse, zero writes — the reset silent-delete hole is closed', async () => {
    await expectAllFourRefuseWithZeroWrites(SHEET, async () => {
      await insertLive(SHEET, Z, { [NAME]: 'ghost' }, 1) // NO revision at all — invisible to reconstructRecordsAtSeq
    })
    // The load-bearing consequence, stated explicitly: Z is STILL LIVE — before §0.6, reset-execute would have
    // classified Z into the delete-set (absent from the reconstruction) and silently destroyed it.
    const z = (await q('SELECT data, version FROM meta_records WHERE id = $1', [Z])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
    expect(z?.data?.[NAME]).toBe('ghost')
    expect(z?.version).toBe(1)
  })

  test('HI-5 (fail-closed extension): a LIVE row whose latest revision is a DELETE → refused even though content matches the pre-delete snapshot', async () => {
    // History's most recent claim is "this record is dead" (reconstruct(now) ⇒ exists:false ⇒ reset delete-set),
    // yet the row is live with byte-identical content — an uncaptured resurrection. Content comparison alone
    // would pass it; the existence check must refuse.
    await expectAllFourRefuseWithZeroWrites(SHEET, async () => {
      await insertLive(SHEET, ZD, { [NAME]: 'zombie', [SALARY]: 1 }, 1)
      await rev(SHEET, ZD, 1, 'create', { [NAME]: 'zombie', [SALARY]: 1 }, T0)
      await rev(SHEET, ZD, 2, 'delete', { [NAME]: 'zombie', [SALARY]: 1 }, T2) // delete stores the PRE-delete snapshot
    })
  })

  test('P3-1: a system-computed field (modifiedTime) is excluded from the projection like a derived type', async () => {
    // The real write path never stores a value under a system field id in `data` at all — it is derived
    // fresh at READ time (`query-service.ts`'s `injectSystemFieldValues`) from `created_at`/`updated_at`/
    // `created_by`/`modified_by`. To prove the exclusion is a real type-based guard (not merely an accident
    // of "these keys are usually absent"), this seeds an ADVERSARIAL state: a STALE value sits under the
    // modifiedTime field id on BOTH sides, DIFFERING between live and the latest snapshot. Before the P3-1
    // fix (DERIVED_FIELD_TYPES alone, no SYSTEM_FIELD_TYPES) this field id was compared like any other user
    // field and this exact scenario would have content-mismatch-refused a healthy record.
    await insertLive(SHEET_S, SYS1, { [SNAME]: 'n1', [SMOD]: '2026-06-01T00:00:00.000Z' }, 1)
    await rev(SHEET_S, SYS1, 1, 'create', { [SNAME]: 'n1', [SMOD]: '2025-01-01T00:00:00.000Z' }, T0, { anchor: true })
    const pv = await revertPreview(SHEET_S)
    expect(pv.status).toBe(200) // NOT refused — modifiedTime is excluded from the user-authored projection
    // SNAME matches (live == snapshot); SMOD differs but is excluded from BOTH the precheck projection and
    // the restore-diff's own NON_RESTORABLE_TYPES — nothing to revert.
    expect(pv.body?.data?.summary?.visibleRevertCount).toBe(0)
  })
})
