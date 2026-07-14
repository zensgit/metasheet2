/**
 * W0-1 (corrected) — generation-aware `HISTORY_INCOMPLETE` contiguity + comprehensive lock/unlock markers
 * + reconstructor marker-safety + system-sheet exclusion (real DB, real routes).
 *
 * Design-lock: docs/development/multitable-w0-1-generation-aware-history-incomplete-design-lock-20260713.md
 * (PR #4262). Corrects #4250/#4252 §3 (withdrawn global `UNIQUE(sheet_id,record_id,version)`).
 *
 * §8 golden matrix covered here (the C8/C4 concurrency goldens live in the sibling
 * `multitable-w01-reset-c8-c4-realdb.test.ts` — they need a raw-client lock-held harness):
 *   - healed-gap (per-generation): v1+v3, missing v2, live matches v3 ⇒ 409 flag-on / 200 flag-off.
 *   - delete→restore→delete (generation boundary): NOT a gap.
 *   - deleted-gap (C3): a now-deleted record's mid-chain gap ⇒ 409 flag-on / 200 flag-off.
 *   - dup-version-within-generation: last-update + delete share the terminal integer ⇒ NOT flagged
 *     (exercised inside the delete→restore→delete generation itself).
 *   - lock/automation-lock NOT refused (markers load-bearing) — driven through the REAL HTTP lock route
 *     and the REAL AutomationExecutor `lock_record` action, plus a same-shape "marker never written"
 *     construction proving the marker is what makes the positive case pass (see the file's own
 *     docstring on mutation-proof methodology below).
 *   - reconstructor marker-safety: a locked record's PIT state still EXISTS with real `data` (not `null`).
 *   - system-sheet exclusion: an approval-projection-base sheet with the EXACT version-bump-no-revision
 *     shape passes; the SAME shape on a regular sheet (the mutation-proof control) refuses.
 *   - formula-not-refused: the exact write shape `formula-engine.ts`/relation-aggregation/auto-number
 *     verifiably produce (version untouched — see the PR body for the source-line citations).
 *   - positive control + flag-off parity for every refusing case.
 *   - C2 nonmonotonic_history.
 *
 * MUTATION-PROOF METHODOLOGY (matches this file family's established convention — see
 * `multitable-history-incomplete-precheck-realdb.test.ts`'s G-HI-4/HI-5): rather than literally deleting
 * source code at test time (no such CI mechanism exists here), each "X is load-bearing" claim is proven
 * by constructing the EXACT byte-for-byte data shape X's ABSENCE would produce (e.g. "lock/unlock never
 * emitted a marker" ⇒ a record whose only captured revision is its `create`, with a live `version` that
 * has since moved on) and showing the check behaves oppositely from the shape WITH X present. This was
 * additionally verified by hand — temporarily commenting out each marker-emission call and re-running the
 * corresponding positive-control test to confirm it reds, then restoring — see the PR body.
 *
 * Runs only with DATABASE_URL (two-point wiring: plugin-tests.yml real-DB run list + vitest.config.ts
 * no-DB exclude — same convention as every other `*-realdb.test.ts` in this directory).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'
import { APPROVAL_PROJECTION_BASE_ID } from '../../src/multitable/approval-projection-constants'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { db } from '../../src/db/db'
import type { AutomationRule } from '../../src/multitable/automation-executor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_w01_${TS}`
const SHEET = `sheet_w01_plain_${TS}`
const SHEET_F = `sheet_w01_formula_${TS}`
const SHEET_SYS = `sheet_w01_sys_${TS}` // base_id = APPROVAL_PROJECTION_BASE_ID
const SHEET_CTRL = `sheet_w01_ctrl_${TS}` // regular sheet, same broken shape as SHEET_SYS — the control

const NAME = `fld_w01_name_${TS}`, SALARY = `fld_w01_salary_${TS}`
const FNAME = `fld_w01_fname_${TS}`, FORMULA = `fld_w01_formula_${TS}`, AUTON = `fld_w01_auton_${TS}`
const CNAME_SYS = `fld_w01_cname_sys_${TS}`, CNAME_CTRL = `fld_w01_cname_ctrl_${TS}`

const H = `rec_w01_h_${TS}` // baseline healthy record shared by every test (keeps recordCount > 0)
const ACTOR = `user_w01_${TS}`
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-02T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z', T3 = '2026-01-04T00:00:00.000Z'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express

const STRICT_ENV = 'MULTITABLE_HISTORY_CONTIGUITY_STRICT'
const setStrict = (on: boolean) => { if (on) process.env[STRICT_ENV] = 'true'; else delete process.env[STRICT_ENV] }

const revertPreview = (sheet: string, asOf = T3) => request(app).post(`/api/multitable/sheets/${sheet}/revert-preview`).send({ asOf })
const resetPreview = (sheet: string, asOf = T3) => request(app).post(`/api/multitable/sheets/${sheet}/reset-preview`).send({ asOf })
const lockRecord = (id: string, locked: boolean, sheetId?: string) => request(app).post(`/api/multitable/records/${id}/lock`).send({ locked, ...(sheetId ? { sheetId } : {}) })

/** Raw content-bearing revision (create/update/delete). */
const rev = (sheet: string, id: string, version: number, action: string, snap: Record<string, unknown>, at: string) =>
  q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6)`,
    [sheet, id, version, action, JSON.stringify(snap), at])

/** Raw MARKER revision (lock/unlock) — snapshot NULL, exactly the shape the same-txn marker emitters write. */
const markerRev = (sheet: string, id: string, version: number, action: 'lock' | 'unlock', at: string) =>
  q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,NULL,$5)`,
    [sheet, id, version, action, at])

const insertLive = (sheet: string, id: string, data: Record<string, unknown>, version: number) =>
  q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [id, sheet, JSON.stringify(data), version])

function ruleFor(sheetId: string, action: { type: 'lock_record'; config: Record<string, unknown> }): AutomationRule {
  return {
    id: `atr_w01_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'W0-1 rule', sheetId, trigger: { type: 'record.created', config: {} },
    actions: [action as never], enabled: true, createdBy: ACTOR, createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
}
function realAutomationService(): AutomationService {
  const pool = poolManager.get()
  return new AutomationService(new EventBus(), db as never, pool.query.bind(pool))
}

describeIfDatabase('W0-1 (corrected) generation-aware contiguity + markers (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    // isAdmin so the system-sheet exclusion goldens (SHEET_SYS is base_id=APPROVAL_PROJECTION_BASE_ID)
    // aren't ALSO blocked by the unrelated admin-only projection-base capability fence
    // (`restrictApprovalProjectionCapabilities`) — this suite tests isSystemSheet's contiguity exclusion,
    // not the projection base's separate read/write access-control gate.
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['member', 'admin'], perms: ['multitable:read', 'multitable:write', 'multitable:share'], isAdmin: true }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'W0-1 Base'])
    await q(`INSERT INTO meta_bases (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [APPROVAL_PROJECTION_BASE_ID, 'Approval Records (system)'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3),($4,$2,$5)', [SHEET, BASE, 'W0-1 Plain', SHEET_F, 'W0-1 Formula'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_SYS, APPROVAL_PROJECTION_BASE_ID, 'W0-1 Sys'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_CTRL, BASE, 'W0-1 Ctrl'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FNAME, SHEET_F, 'FName', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FORMULA, SHEET_F, 'Computed', 'formula', JSON.stringify({ expression: `{${FNAME}}` }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [AUTON, SHEET_F, 'Seq', 'autoNumber', '{}', 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [CNAME_SYS, SHEET_SYS, 'CName', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [CNAME_CTRL, SHEET_CTRL, 'CName', 'string', '{}', 1])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    setStrict(false)
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    for (const sheet of [SHEET, SHEET_F, SHEET_SYS, SHEET_CTRL]) {
      for (const t of ['meta_records_trash', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })
  beforeEach(async () => {
    setStrict(false)
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    for (const sheet of [SHEET, SHEET_F, SHEET_SYS, SHEET_CTRL]) {
      await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheet])
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet])
    }
    // H: shared healthy baseline on SHEET so computeSheetRevert/Reset always has SOME live work + fields.
    await insertLive(SHEET, H, { [NAME]: 'new', [SALARY]: 200 }, 2)
    await rev(SHEET, H, 1, 'create', { [NAME]: 'old', [SALARY]: 100 }, T0)
    await rev(SHEET, H, 2, 'update', { [NAME]: 'new', [SALARY]: 200 }, T2)
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('POSITIVE CONTROL: a healthy dense chain passes flag-on AND flag-off', async () => {
    setStrict(true)
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200)
    const pvr = await resetPreview(SHEET)
    expect(pvr.status).toBe(200)
    setStrict(false)
    expect((await revertPreview(SHEET)).status).toBe(200)
  })

  test('healed-gap (per-generation): v1+v3 (missing v2), live matches v3 content ⇒ 409 flag-on, 200 flag-off (content-diff cannot see it)', async () => {
    const GAP = `rec_w01_gap_${TS}`
    await insertLive(SHEET, GAP, { [NAME]: 'v3-value', [SALARY]: 300 }, 3)
    await rev(SHEET, GAP, 1, 'create', { [NAME]: 'v1-value', [SALARY]: 100 }, T0)
    // v2 UNCAPTURED — the healed part: v3's snapshot already matches live, so a naive content-diff passes.
    await rev(SHEET, GAP, 3, 'update', { [NAME]: 'v3-value', [SALARY]: 300 }, T2)

    setStrict(false)
    expect((await revertPreview(SHEET)).status).toBe(200) // flag-off parity: content-diff alone can't see it
    expect((await resetPreview(SHEET)).status).toBe(200)

    setStrict(true)
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(409)
    expect(pv.body.error.code).toBe('HISTORY_INCOMPLETE')
    const pvr = await resetPreview(SHEET)
    expect(pvr.status).toBe(409)
    expect(pvr.body.error.code).toBe('HISTORY_INCOMPLETE')
  })

  test('delete→restore→delete (generation boundary): a NEW generation create is NOT a gap/regression', async () => {
    const DRD = `rec_w01_drd_${TS}`
    // Generation 1 (closed): v1 create, v2 update, v2 delete (dup-version-within-generation — the terminal
    // update+delete pair sharing the same integer, pinned by the model, not flagged).
    await rev(SHEET, DRD, 1, 'create', { [NAME]: 'g1-a' }, T0)
    await rev(SHEET, DRD, 2, 'update', { [NAME]: 'g1-b' }, T1)
    await rev(SHEET, DRD, 2, 'delete', { [NAME]: 'g1-b' }, T1)
    // Generation 2 (open, live): a fresh v1 create (trash-restore/resurrect shape) — version resets to 1.
    await insertLive(SHEET, DRD, { [NAME]: 'g2-a' }, 1)
    await rev(SHEET, DRD, 1, 'create', { [NAME]: 'g2-a' }, T2)

    setStrict(true)
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200)
    const pvr = await resetPreview(SHEET)
    expect(pvr.status).toBe(200)
  })

  test('deleted-gap (C3): a now-deleted record with a mid-chain gap ⇒ 409 flag-on, 200 flag-off', async () => {
    const DGAP = `rec_w01_dgap_${TS}`
    // NEVER inserted into meta_records — fully deleted, exists only in revisions.
    await rev(SHEET, DGAP, 1, 'create', { [NAME]: 'x' }, T0)
    // v2 uncaptured
    await rev(SHEET, DGAP, 3, 'delete', { [NAME]: 'x' }, T2)

    setStrict(false)
    expect((await revertPreview(SHEET)).status).toBe(200)
    expect((await resetPreview(SHEET)).status).toBe(200)

    setStrict(true)
    expect((await revertPreview(SHEET)).status).toBe(409)
    expect((await resetPreview(SHEET)).status).toBe(409)
  })

  test('C2 nonmonotonic_history: a later-version revision has an EARLIER created_at than its predecessor (concurrent-write race artifact) ⇒ 409 flag-on, 200 flag-off', async () => {
    const NM = `rec_w01_nm_${TS}`
    // The race the design-lock names (§6): txn "B" starts LATER but wins the row lock FIRST (gets the
    // LOWER version, v2, committed at the LATER wall-clock T2); txn "A" started EARLIER but was blocked,
    // so it reads post-B state and gets the HIGHER version (v3) — yet `created_at` (transaction START
    // time, not commit time) still reflects ITS OWN earlier start (T_A, between T0 and T2). In VERSION
    // order the walk sees created_at go T2 (v2) → T_A (v3): a DECREASE.
    // v2 and v3 share IDENTICAL content so the PRE-EXISTING content-diff (rule 2, "latest by created_at
    // DESC") stays healthy regardless of WHICH of the two it happens to pick as "latest" — this isolates
    // the monotonicity concern from content-diff's own unrelated latest-by-time pick.
    const T_A = '2026-01-02T12:00:00.000Z' // between T1(update v2) and T2 — v3's created_at
    await insertLive(SHEET, NM, { [NAME]: 'race-final' }, 3)
    await rev(SHEET, NM, 1, 'create', { [NAME]: 'v1' }, T0)
    await rev(SHEET, NM, 2, 'update', { [NAME]: 'race-final' }, T2) // "B": later created_at, lower version
    await rev(SHEET, NM, 3, 'update', { [NAME]: 'race-final' }, T_A) // "A": earlier created_at, higher version

    setStrict(false)
    expect((await revertPreview(SHEET)).status).toBe(200) // content-diff: latest-by-time snapshot matches live either way
    setStrict(true)
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(409)
    expect(pv.body.error.code).toBe('HISTORY_INCOMPLETE')
  })

  test('lock/unlock markers (HTTP route, REAL): v1 create → v2 lock → v3 unlock passes flag-on; reconstructor marker-safety holds mid-chain', async () => {
    const LK = `rec_w01_lk_${TS}`
    await insertLive(SHEET, LK, { [NAME]: 'locked-content' }, 1)
    await rev(SHEET, LK, 1, 'create', { [NAME]: 'locked-content' }, T0)

    expect((await lockRecord(LK, true, SHEET)).status).toBe(200)
    expect((await lockRecord(LK, false, SHEET)).status).toBe(200)

    const after = (await q('SELECT version, locked FROM meta_records WHERE id = $1', [LK])).rows[0] as { version: number; locked: boolean }
    expect(after.version).toBe(3) // version moved WITHOUT touching data
    expect(after.locked).toBe(false)

    const revs = (await q(`SELECT version, action, snapshot FROM meta_record_revisions WHERE record_id = $1 ORDER BY version ASC`, [LK])).rows as Array<{ version: number; action: string; snapshot: unknown }>
    expect(revs.map((r) => r.action)).toEqual(['create', 'lock', 'unlock']) // markers ARE captured
    expect(revs[1]!.snapshot).toBeNull()
    expect(revs[2]!.snapshot).toBeNull()

    setStrict(true)
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200) // markers keep the chain dense — NOT refused

    // Reconstructor marker-safety: PIT state AS OF the lock marker's own timestamp (its latest <= T
    // revision is the LOCK marker itself, strictly before the later unlock) must still show the record as
    // EXISTING with its REAL content — never `data: null` (the vanish-on-lock bug this PR fixes).
    const lockRevRow = (await q(`SELECT created_at FROM meta_record_revisions WHERE record_id = $1 AND action = 'lock'`, [LK])).rows[0] as { created_at: Date }
    const asOfAtLock = lockRevRow.created_at.toISOString()
    const stateMap = await reconstructRecordsAtT(q, SHEET, asOfAtLock)
    const state = stateMap.get(LK)
    expect(state?.exists).toBe(true)
    expect(state?.data).toEqual({ [NAME]: 'locked-content' }) // NOT null — marker-safe
  })

  test('lock/unlock markers (AUTOMATION, REAL AutomationExecutor lock_record action): dense chain, not refused', async () => {
    const LKA = `rec_w01_lka_${TS}`
    await insertLive(SHEET, LKA, { [NAME]: 'auto-locked' }, 1)
    await rev(SHEET, LKA, 1, 'create', { [NAME]: 'auto-locked' }, T0)

    const svc = realAutomationService()
    const lockRule = ruleFor(SHEET, { type: 'lock_record', config: { locked: true } })
    const lockExec = await svc.executeRule(lockRule, { recordId: LKA, actorId: ACTOR, data: {} })
    expect(lockExec.steps[0]?.status).toBe('success')
    const unlockRule = ruleFor(SHEET, { type: 'lock_record', config: { locked: false } })
    const unlockExec = await svc.executeRule(unlockRule, { recordId: LKA, actorId: ACTOR, data: {} })
    expect(unlockExec.steps[0]?.status).toBe('success')

    const revs = (await q(`SELECT version, action, source FROM meta_record_revisions WHERE record_id = $1 ORDER BY version ASC`, [LKA])).rows as Array<{ version: number; action: string; source: string }>
    expect(revs.map((r) => r.action)).toEqual(['create', 'lock', 'unlock'])
    expect(revs[1]!.source).toBe('automation')
    expect(revs[2]!.source).toBe('automation')

    setStrict(true)
    expect((await revertPreview(SHEET)).status).toBe(200)
  })

  test('MUTATION-PROOF: the SAME final shape WITHOUT a marker ever written ⇒ 409 (proves the marker is load-bearing)', async () => {
    const NOMARK = `rec_w01_nomark_${TS}`
    // Simulates exactly what lock/unlock would leave behind if recordRecordRevision were NEVER called:
    // live version has moved (2 content-neutral bumps) but only the v1 create was ever captured.
    await insertLive(SHEET, NOMARK, { [NAME]: 'x' }, 3)
    await rev(SHEET, NOMARK, 1, 'create', { [NAME]: 'x' }, T0)

    setStrict(false)
    expect((await revertPreview(SHEET)).status).toBe(200) // content-diff alone tolerates this (by design, rule 2)
    setStrict(true)
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(409) // strict mode's trailing-version check catches the uncaptured tip
    expect(pv.body.error.code).toBe('HISTORY_INCOMPLETE')
  })

  test('formula-not-refused: the write shape formula/rollup/auto-number materialization actually produces (version untouched) passes strict mode', async () => {
    const F1 = `rec_w01_f1_${TS}`, F2 = `rec_w01_f2_${TS}`
    // F1: healthy CREATE shape — the in-txn revision snapshots the USER patch only; formula + autoNumber
    // keys materialize into live `data` post-commit via `UPDATE ... SET data = data || $patch` with NO
    // version touch (verified: formula-engine.ts recalculateRecordFromData, univer-meta.ts relation-
    // aggregation same-record/foreign-fan-out, auto-number-service.ts backfill — none bump `version`).
    await insertLive(SHEET_F, F1, { [FNAME]: 'n1', [FORMULA]: 'n1', [AUTON]: 7 }, 1)
    await rev(SHEET_F, F1, 1, 'create', { [FNAME]: 'n1' }, T0)
    // F2: healthy UPDATE shape — v2's snapshot carries a STALE derived value vs a fresher live recompute,
    // still with version untouched by the recompute itself (only the user edit bumped it to 2).
    await insertLive(SHEET_F, F2, { [FNAME]: 'new', [FORMULA]: 'fresh-recompute', [AUTON]: 8 }, 2)
    await rev(SHEET_F, F2, 1, 'create', { [FNAME]: 'old' }, T0)
    await rev(SHEET_F, F2, 2, 'update', { [FNAME]: 'new', [FORMULA]: 'stale-materialized', [AUTON]: 8 }, T2)

    setStrict(true)
    const pv = await revertPreview(SHEET_F)
    expect(pv.status).toBe(200)
    const pvr = await resetPreview(SHEET_F)
    expect(pvr.status).toBe(200)
  })

  test('system-sheet exclusion: an approval-projection-base sheet with version-bump-no-revision passes strict mode (isSystemSheet gate)', async () => {
    const SYS1 = `rec_w01_sys1_${TS}`
    // Mirrors approval-record-projection-service.ts's exact shape: INSERT ... ON CONFLICT DO UPDATE SET
    // version = version + 1 — a version bump with ZERO matching revision, by design (revision-exempt).
    await insertLive(SHEET_SYS, SYS1, { [CNAME_SYS]: 'v2' }, 2)
    await rev(SHEET_SYS, SYS1, 1, 'create', { [CNAME_SYS]: 'v1' }, T0)
    // v2 has NO revision at all (system sync bumped version silently) — would be a gap on a regular sheet.

    setStrict(true)
    const pv = await revertPreview(SHEET_SYS)
    expect(pv.status).toBe(200) // isSystemSheet(base_id === APPROVAL_PROJECTION_BASE_ID) excludes it
  })

  test('MUTATION-PROOF (control): the IDENTICAL broken shape on a REGULAR sheet is refused — proves the system-sheet gate is real, not "nothing is ever refused"', async () => {
    const CTRL1 = `rec_w01_ctrl1_${TS}`
    await insertLive(SHEET_CTRL, CTRL1, { [CNAME_CTRL]: 'v2' }, 2)
    await rev(SHEET_CTRL, CTRL1, 1, 'create', { [CNAME_CTRL]: 'v1' }, T0)

    setStrict(true)
    const pv = await revertPreview(SHEET_CTRL)
    expect(pv.status).toBe(409) // SAME shape, non-system sheet ⇒ refused — the exclusion is base_id-specific
    expect(pv.body.error.code).toBe('HISTORY_INCOMPLETE')
  })
})
