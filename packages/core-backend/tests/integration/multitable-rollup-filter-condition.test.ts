/**
 * Rollup filter condition (slice 3) — real DB.
 *
 * A rollup may carry an optional condition so it aggregates ONLY the linked foreign records that match
 * (e.g. SUM(amount) where status = "paid"). Two things are pinned:
 *  1. Behavior: the filter narrows count/countall/sum to the matched subset; no filter = aggregate all.
 *  2. SECURITY (owner gate): a condition that reads a foreign field the actor CANNOT read is a
 *     side-channel — the match-count would leak the masked field — so resolveLookupValues fails CLOSED
 *     and masks the WHOLE rollup to null. Crucially the fail-closed is SCOPED to the offending rollup:
 *     a sibling rollup whose condition reads a readable field still works for the same actor.
 *
 * Trigger: GET /records/:recordId computes applyLookupRollup unconditionally and returns the value at
 * res.body.data.record.data[rollupFieldId].
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const ALLOW_USER = `u_rf_allow_${TS}` // reads everything
const DENY_USER = `u_rf_deny_${TS}` // denied on the foreign SECRET field

const BASE = `base_rf_${TS}`
const FS = `sheet_rf_fs_${TS}`
const MS = `sheet_rf_main_${TS}`

const FLD_AMOUNT = `fld_rf_amt_${TS}` // number target
const FLD_STATUS = `fld_rf_status_${TS}` // string filter field (readable by all)
const FLD_SECRET = `fld_rf_secret_${TS}` // string filter field (DENIED for DENY_USER)
const FLD_NOTE = `fld_rf_note_${TS}` // string filter field, set on FR1 only (readable by all)
const FLD_LINK = `fld_rf_lk_${TS}`
const FLD_ALL = `fld_rf_all_${TS}` // countall, no filter -> 3
const FLD_PAID_COUNT = `fld_rf_pc_${TS}` // countall where status = paid -> 2
const FLD_PAID_SUM = `fld_rf_ps_${TS}` // sum amount where status = paid -> 30
const FLD_BY_SECRET = `fld_rf_bs_${TS}` // countall where secret = yes -> 2 (masks to null for DENY_USER)
const FLD_BY_SECRET_SKIP = `fld_rf_bsk_${TS}` // same + skipForeignFieldMasking:true — P1 bypass regression
const FLD_OR_UNION = `fld_rf_or_${TS}` // countall where status=unpaid OR amount=10 -> union FR3+FR1 = 2
const FLD_AND_EMPTY = `fld_rf_and_${TS}` // countall where status=unpaid AND amount=10 -> 0 (contrast for OR)
const FLD_AMT_GT8 = `fld_rf_gt8_${TS}` // countall where amount greater 8 -> FR1(10),FR2(20) = 2
const FLD_NOTE_SET = `fld_rf_ns_${TS}` // countall where note isNotEmpty -> FR1 only = 1
const FLD_NOTE_EMPTY = `fld_rf_ne_${TS}` // countall where note isEmpty -> FR2,FR3 = 2
const FLD_BAD_OP = `fld_rf_badop_${TS}` // PERSISTED incompatible op (number `contains`) — runtime no-match -> 0

const FR1 = `rec_rf_f1_${TS}` // amount 10, paid,   secret yes
const FR2 = `rec_rf_f2_${TS}` // amount 20, paid,   secret no
const FR3 = `rec_rf_f3_${TS}` // amount  5, unpaid, secret yes
const REC = `rec_rf_src_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = { id: userId, roles: ['member'], perms: ['multitable:read'], permissions: ['multitable:read'] }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

async function readRollup(userId: string, fieldId: string): Promise<unknown> {
  const res = await request(buildApp(userId)).get(`/api/multitable/records/${REC}`)
  expect(res.status).toBe(200)
  return res.body?.data?.record?.data?.[fieldId]
}

function rollup(aggregation: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_AMOUNT, foreignSheetId: FS, aggregation, ...extra })
}

describeIfDatabase('multitable rollup filter condition + fail-closed field-readability (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE, 'RF Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS, BASE, 'RF Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE, 'RF Main'])

    for (const [fid, name, type, order] of [
      [FLD_AMOUNT, 'Amount', 'number', 1],
      [FLD_STATUS, 'Status', 'string', 2],
      [FLD_SECRET, 'Secret', 'string', 3],
      [FLD_NOTE, 'Note', 'string', 4],
    ] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [fid, FS, name, type, '{}', order])
    }

    // FLD_NOTE is set on FR1 only (absent key on FR2/FR3) → isNotEmpty matches 1, isEmpty matches 2.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [FR1, FS, JSON.stringify({ [FLD_AMOUNT]: 10, [FLD_STATUS]: 'paid', [FLD_SECRET]: 'yes', [FLD_NOTE]: 'hi' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [FR2, FS, JSON.stringify({ [FLD_AMOUNT]: 20, [FLD_STATUS]: 'paid', [FLD_SECRET]: 'no' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [FR3, FS, JSON.stringify({ [FLD_AMOUNT]: 5, [FLD_STATUS]: 'unpaid', [FLD_SECRET]: 'yes' })])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_ALL, MS, 'All', 'rollup', rollup('countall'), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_PAID_COUNT, MS, 'PaidCount', 'rollup', rollup('countall', { filters: [{ fieldId: FLD_STATUS, operator: 'is', value: 'paid' }] }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_PAID_SUM, MS, 'PaidSum', 'rollup', rollup('sum', { filters: [{ fieldId: FLD_STATUS, operator: 'is', value: 'paid' }] }), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_BY_SECRET, MS, 'BySecret', 'rollup', rollup('countall', { filters: [{ fieldId: FLD_SECRET, operator: 'is', value: 'yes' }] }), 5])

    // OR over two disjoint singletons: status=unpaid (FR3) OR amount=10 (FR1) → union = 2.
    // Their AND is empty (no record is both) so OR=2 genuinely proves union, not coincidental all-3.
    const orConds = [
      { fieldId: FLD_STATUS, operator: 'is', value: 'unpaid' },
      { fieldId: FLD_AMOUNT, operator: 'is', value: 10 },
    ]
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_OR_UNION, MS, 'OrUnion', 'rollup', rollup('countall', { filters: orConds, filterConjunction: 'or' }), 6])
    // Same two conditions with default conjunction (and) → 0: proves conjunction is honored, not ignored.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_AND_EMPTY, MS, 'AndEmpty', 'rollup', rollup('countall', { filters: orConds }), 7])
    // Numeric operator: amount greater 8 → FR1(10), FR2(20) match, FR3(5) does not → 2.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_AMT_GT8, MS, 'AmtGt8', 'rollup', rollup('countall', { filters: [{ fieldId: FLD_AMOUNT, operator: 'greater', value: 8 }] }), 8])
    // isNotEmpty: note set on FR1 only → 1.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_NOTE_SET, MS, 'NoteSet', 'rollup', rollup('countall', { filters: [{ fieldId: FLD_NOTE, operator: 'isNotEmpty' }] }), 9])
    // isEmpty: note absent on FR2, FR3 → 2.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_NOTE_EMPTY, MS, 'NoteEmpty', 'rollup', rollup('countall', { filters: [{ fieldId: FLD_NOTE, operator: 'isEmpty' }] }), 10])
    // P1 regression: skipForeignFieldMasking is a same-base TARGET-projection opt-out; it must NOT let a
    // CONDITION read an unreadable field (side-channel). Same as FLD_BY_SECRET but with the opt-out set.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_BY_SECRET_SKIP, MS, 'BySecretSkip', 'rollup', rollup('countall', { filters: [{ fieldId: FLD_SECRET, operator: 'is', value: 'yes' }], skipForeignFieldMasking: true }), 11])
    // Persisted INCOMPATIBLE operator (number field + `contains`) inserted directly, bypassing save-time
    // validation — simulates a provisioning/plugin write or a config saved before the validator existed.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_BAD_OP, MS, 'BadOp', 'rollup', rollup('countall', { filters: [{ fieldId: FLD_AMOUNT, operator: 'contains', value: '1' }] }), 12])

    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC, MS, JSON.stringify({ [FLD_LINK]: [FR1, FR2, FR3] })])
    for (const fr of [FR1, FR2, FR3]) {
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
        [`lnk_rf_${fr}`, FLD_LINK, REC, fr])
    }

    // DENY_USER cannot read the foreign SECRET field → any rollup whose CONDITION reads it must fail closed.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [FS, FLD_SECRET, 'user', DENY_USER, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[FS, MS]]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('filter narrows the aggregate to matched linked records (countall/sum); no filter = all', async () => {
    expect(await readRollup(ALLOW_USER, FLD_ALL)).toBe(3) // no filter
    expect(await readRollup(ALLOW_USER, FLD_PAID_COUNT)).toBe(2) // status = paid -> FR1, FR2
    expect(await readRollup(ALLOW_USER, FLD_PAID_SUM)).toBe(30) // amount of paid -> 10 + 20
    expect(await readRollup(ALLOW_USER, FLD_BY_SECRET)).toBe(2) // secret = yes -> FR1, FR3
  })

  test('SECURITY fail-closed: a condition on a field the actor cannot read masks that rollup to null', async () => {
    expect(await readRollup(DENY_USER, FLD_BY_SECRET) ?? null).toBeNull() // condition reads denied FLD_SECRET
  })

  test('SECURITY: skipForeignFieldMasking does NOT bypass the condition fail-closed (it is a target-projection opt-out only)', async () => {
    // ALLOW_USER (can read FLD_SECRET) still gets the real count even with the opt-out set.
    expect(await readRollup(ALLOW_USER, FLD_BY_SECRET_SKIP)).toBe(2)
    // DENY_USER: the same-base opt-out must NOT leak — a CONDITION on the unreadable field still masks to null.
    expect(await readRollup(DENY_USER, FLD_BY_SECRET_SKIP) ?? null).toBeNull()
  })

  test('fail-closed is SCOPED: sibling rollups whose condition reads a readable field still work', async () => {
    expect(await readRollup(DENY_USER, FLD_ALL)).toBe(3) // no filter
    expect(await readRollup(DENY_USER, FLD_PAID_COUNT)).toBe(2) // condition reads FLD_STATUS (readable)
    expect(await readRollup(DENY_USER, FLD_PAID_SUM)).toBe(30)
  })

  test("conjunction 'or' returns the UNION of two disjoint conditions; default 'and' returns the intersection", async () => {
    // status=unpaid (FR3) OR amount=10 (FR1) → union of 2; AND of the same is empty.
    expect(await readRollup(ALLOW_USER, FLD_OR_UNION)).toBe(2)
    expect(await readRollup(ALLOW_USER, FLD_AND_EMPTY)).toBe(0)
  })

  test('numeric operator: amount greater 8 matches FR1(10), FR2(20) but not FR3(5)', async () => {
    expect(await readRollup(ALLOW_USER, FLD_AMT_GT8)).toBe(2)
  })

  test('runtime guard: a PERSISTED operator incompatible with the field type fails closed (no-match), not match-all', async () => {
    // `amount contains '1'` is incompatible (number + text op). Without the runtime guard,
    // evaluateMetaFilterCondition's numeric catch-all returns match-all → 3. The guard treats the
    // bad condition as no-match → 0. Locks defense for provisioning/plugin writes + pre-validator configs.
    expect(await readRollup(ALLOW_USER, FLD_BAD_OP)).toBe(0)
  })

  test('isNotEmpty / isEmpty on a foreign field set on a subset of linked records', async () => {
    expect(await readRollup(ALLOW_USER, FLD_NOTE_SET)).toBe(1) // note set on FR1 only
    expect(await readRollup(ALLOW_USER, FLD_NOTE_EMPTY)).toBe(2) // note absent on FR2, FR3
  })
})
