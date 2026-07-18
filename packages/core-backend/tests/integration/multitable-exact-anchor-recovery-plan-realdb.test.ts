/**
 * W0-1 v3.7 Lane L7 — exact-anchor recovery PLAN classification (real DB).
 *
 * Module under test: `exact-anchor-recovery-plan.ts` `buildExactAnchorRecoveryPlan` — the §5 target-set
 * recomputation on top of L6-b's causal reconstructor. Goldens (each mutation-proven in the PR matrix):
 *   REVERT           live differs from at-anchor ⇒ revert candidate carrying the AT-ANCHOR data.
 *   RESURRECT-AFTER  deleted AFTER the anchor (delete seq > anchor), no live row ⇒ resurrect candidate with
 *                    the at-anchor snapshot (from the revision chain — NOT the trash row's terminal vintage).
 *   STAYS-DELETED    deleted BEFORE/AT the anchor, no live row ⇒ NOT resurrected (LOCK-9; no candidate).
 *   DELETED-AT-ANCHOR-LIVE-NOW  deleted as of the anchor but resurrected later (live now) ⇒ exposed in the
 *                    caller-picks list, NEVER auto-classified as a revert/resurrect.
 *   CREATED-AFTER    live row with no revision ≤ anchor ⇒ createdAfterAnchor, NOT a revert.
 *   MULTI-GEN        anchor inside generation 1 of a delete→recreate ⇒ target = GEN-1 state (the live gen-2
 *                    row becomes a revert candidate whose targetData is g1's, target-generation A).
 *   DRIFT            at-anchor snapshot carries a field id absent from the CURRENT schema ⇒ excluded +
 *                    driftCount (both the revert and resurrect branches).
 *   UNCHANGED        live equals at-anchor ⇒ unchangedCount, no candidate.
 *   EXACT-BIGINT     the 2^53/2^53+1 anchor boundary classifies exactly (bigint, never float).
 *
 * P2-C hygiene: explicit synthetic seq literals on isolated fixture rows; NEVER `setval` on the shared
 * sequence; cleanup deletes only this suite's rows. Two-point wiring: plugin-tests.yml real-DB run list +
 * vitest glob. Runs only with DATABASE_URL; the top-level sentinel fails-not-skips in the allowlist step.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { buildExactAnchorRecoveryPlan } from '../../src/multitable/exact-anchor-recovery-plan'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_earp_${TS}`
const SHEET = `sheet_earp_${TS}`
const F_STR = `fld_earp_note_${TS}`
const ACTOR = `user_earp_${TS}`

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)

const revSeq = (
  recordId: string,
  version: number,
  action: 'create' | 'update' | 'delete',
  snap: Record<string, unknown> | null,
  seq: string,
) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6::bigint)`,
    [SHEET, recordId, version, action, snap === null ? null : JSON.stringify(snap), seq],
  )
const live = (id: string, data: Record<string, unknown>, version = 1) =>
  q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [id, SHEET, JSON.stringify(data), version])

async function wipe(): Promise<void> {
  for (const t of ['meta_records_trash', 'meta_record_revisions', 'meta_records'])
    await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
}

test('sentinel: the real-DB allowlist step must have DATABASE_URL (fail-not-skip, scoped to that step)', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('real-DB allowlist step is missing DATABASE_URL — the harness is broken, not legitimately skippable')
  }
  expect(true).toBe(true)
})

describeIfDatabase('W0-1 v3.7 L7 — exact-anchor recovery plan (real DB)', () => {
  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'EARP Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'EARP'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET, 'Note', 'string', '{}', 1])
  })
  beforeEach(wipe)
  afterAll(async () => {
    await wipe()
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('REVERT: live differs from at-anchor ⇒ candidate carries the AT-ANCHOR data + both versions', async () => {
    const R = `rec_rev_${TS}`
    await revSeq(R, 1, 'create', { [F_STR]: 'old' }, '100')
    await revSeq(R, 2, 'update', { [F_STR]: 'new' }, '200')
    await live(R, { [F_STR]: 'new' }, 2)
    const plan = await buildExactAnchorRecoveryPlan(q, SHEET, '150')
    expect(plan.reverts).toEqual([{ recordId: R, targetData: { [F_STR]: 'old' }, targetVersion: 1, liveVersion: 2 }])
    expect(plan.resurrects).toEqual([])
    expect(plan.createdAfterAnchor).toEqual([])
    expect(plan.deletedAtAnchorLiveNow).toEqual([])
  })

  test('RESURRECT-AFTER vs STAYS-DELETED: delete AFTER the anchor resurrects to the AT-ANCHOR state; delete AT/BEFORE the anchor stays deleted', async () => {
    const AFTER = `rec_after_${TS}`
    const BEFORE = `rec_before_${TS}`
    // AFTER: create@100 (v1 'keep-me'), update@200 (v2 'newer'), delete@300. Anchor 250 ⇒ existed at v2.
    await revSeq(AFTER, 1, 'create', { [F_STR]: 'keep-me' }, '100')
    await revSeq(AFTER, 2, 'update', { [F_STR]: 'newer' }, '200')
    await revSeq(AFTER, 2, 'delete', { [F_STR]: 'newer' }, '300')
    // BEFORE: create@110, delete@120 — deleted before the anchor ⇒ stays deleted.
    await revSeq(BEFORE, 1, 'create', { [F_STR]: 'gone' }, '110')
    await revSeq(BEFORE, 1, 'delete', { [F_STR]: 'gone' }, '120')

    const plan = await buildExactAnchorRecoveryPlan(q, SHEET, '250')
    // AFTER resurrects with its AT-ANCHOR (v2 'newer') snapshot — from the revision chain, not any trash vintage.
    expect(plan.resurrects).toEqual([{ recordId: AFTER, snapshot: { [F_STR]: 'newer' }, targetVersion: 2 }])
    // BEFORE appears NOWHERE (stays deleted — LOCK-9).
    expect(plan.reverts.map((r) => r.recordId)).not.toContain(BEFORE)
    expect(plan.deletedAtAnchorLiveNow).toEqual([])
    expect(plan.createdAfterAnchor).toEqual([])
  })

  test('DELETED-AT-ANCHOR-LIVE-NOW + CREATED-AFTER: exposed in the caller-picks lists, never auto-destructed', async () => {
    const RESURRECTED = `rec_resu_${TS}` // deleted before anchor, re-created after ⇒ live now
    const NEWBIE = `rec_new_${TS}` // created after the anchor
    await revSeq(RESURRECTED, 1, 'create', { [F_STR]: 'g1' }, '100')
    await revSeq(RESURRECTED, 1, 'delete', { [F_STR]: 'g1' }, '150')
    await revSeq(RESURRECTED, 1, 'create', { [F_STR]: 'g2' }, '400') // after the anchor
    await live(RESURRECTED, { [F_STR]: 'g2' }, 1)
    await revSeq(NEWBIE, 1, 'create', { [F_STR]: 'brand-new' }, '500')
    await live(NEWBIE, { [F_STR]: 'brand-new' }, 1)

    const plan = await buildExactAnchorRecoveryPlan(q, SHEET, '200')
    expect(plan.deletedAtAnchorLiveNow).toEqual([RESURRECTED]) // deleted as of anchor 200, live now
    expect(plan.createdAfterAnchor).toEqual([NEWBIE]) // no revision ≤ 200
    // Neither is a revert or resurrect — the plan never chooses destruction.
    expect(plan.reverts).toEqual([])
    expect(plan.resurrects).toEqual([])
  })

  test('MULTI-GEN target-generation A: an anchor inside generation 1 makes the live gen-2 row a revert to the G1 state', async () => {
    const R = `rec_gen_${TS}`
    // gen1: create v1@10 ('g1v1'), update v2@20 ('g1v2'), delete v2@30. gen2: create v1@40 ('g2v1') — live.
    await revSeq(R, 1, 'create', { [F_STR]: 'g1v1' }, '10')
    await revSeq(R, 2, 'update', { [F_STR]: 'g1v2' }, '20')
    await revSeq(R, 2, 'delete', { [F_STR]: 'g1v2' }, '30')
    await revSeq(R, 1, 'create', { [F_STR]: 'g2v1' }, '40')
    await live(R, { [F_STR]: 'g2v1' }, 1)

    // anchor 25: inside GEN 1, at its v2 state — the plan must target g1v2 (target-generation A), not the
    // terminal generation's state and not "stays deleted".
    const plan = await buildExactAnchorRecoveryPlan(q, SHEET, '25')
    expect(plan.reverts).toEqual([{ recordId: R, targetData: { [F_STR]: 'g1v2' }, targetVersion: 2, liveVersion: 1 }])

    // anchor 35 (inside the deletion window): deleted as of the anchor but live now ⇒ caller-picks list.
    const plan35 = await buildExactAnchorRecoveryPlan(q, SHEET, '35')
    expect(plan35.deletedAtAnchorLiveNow).toEqual([R])
    expect(plan35.reverts).toEqual([])
  })

  test('DRIFT: a stale field id in the at-anchor snapshot excludes the record (both branches) and counts drift', async () => {
    const GHOST_FIELD = `fld_ghost_${TS}` // never inserted into meta_fields
    const R_LIVE = `rec_drift_live_${TS}`
    const R_GONE = `rec_drift_gone_${TS}`
    await revSeq(R_LIVE, 1, 'create', { [GHOST_FIELD]: 'stale' }, '100')
    await revSeq(R_LIVE, 2, 'update', { [F_STR]: 'now' }, '300')
    await live(R_LIVE, { [F_STR]: 'now' }, 2)
    await revSeq(R_GONE, 1, 'create', { [GHOST_FIELD]: 'stale' }, '110')
    await revSeq(R_GONE, 1, 'delete', { [GHOST_FIELD]: 'stale' }, '400')

    const plan = await buildExactAnchorRecoveryPlan(q, SHEET, '200')
    expect(plan.driftCount).toBe(2) // one revert-branch drift + one resurrect-branch drift
    expect(plan.reverts).toEqual([])
    expect(plan.resurrects).toEqual([])
  })

  test('UNCHANGED: live equals at-anchor ⇒ counted, no candidate', async () => {
    const R = `rec_same_${TS}`
    await revSeq(R, 1, 'create', { [F_STR]: 'same' }, '100')
    await live(R, { [F_STR]: 'same' }, 1)
    const plan = await buildExactAnchorRecoveryPlan(q, SHEET, '200')
    expect(plan.unchangedCount).toBe(1)
    expect(plan.reverts).toEqual([])
  })

  test('EXACT-BIGINT: the 2^53 anchor boundary classifies exactly (a float compare would include the +1 write)', async () => {
    const R = `rec_big_${TS}`
    const LO = '9007199254740992' // 2^53
    const HI = '9007199254740993' // 2^53+1 — Number() collapses onto LO
    expect(Number(LO) === Number(HI)).toBe(true)
    await revSeq(R, 1, 'create', { [F_STR]: 'lo' }, LO)
    await revSeq(R, 2, 'update', { [F_STR]: 'hi' }, HI)
    await live(R, { [F_STR]: 'hi' }, 2)
    // anchor = LO exactly: the HI write has NOT happened yet ⇒ the plan reverts live('hi') → target('lo').
    const plan = await buildExactAnchorRecoveryPlan(q, SHEET, LO)
    expect(plan.reverts).toEqual([{ recordId: R, targetData: { [F_STR]: 'lo' }, targetVersion: 1, liveVersion: 2 }])
  })

  test('garbage anchor fails closed (assertSeqString throws before any SQL)', async () => {
    const throwQ = (() => { throw new Error('plan touched the DB on a garbage anchor') }) as never
    await expect(buildExactAnchorRecoveryPlan(throwQ, SHEET, 'not-a-seq')).rejects.toThrow(/seq/i)
  })
})
