/**
 * §2a.3 ANTI-ORACLE — POST /dashboard/query saved-view filterInfo over a denied/tainted field.
 *
 * The dashboard handler masks the per-row OUTPUT by the post-chokepoint allow-set
 * (maskStoredRecordFieldIds → visibleFieldIds), but the saved view's filterInfo.conditions were
 * pruned only by the PRE-chokepoint fieldTypeById (built from visibleFields). A formula-over-denied-
 * foreign-lookup field survives field_permissions VISIBILITY (so it is in visibleFields/fieldTypeById)
 * yet is dropped by the taint chokepoint (so it is NOT in visibleFieldIds). Its filterInfo condition
 * was therefore still applied to RAW meta_records.data — turning the surviving row set / aggregate
 * (totalRecords, points) into an ORACLE for the masked formula value: a sheet reader denied the
 * foreign field could probe its value by reading dashboard aggregates back, never touching the column.
 *
 * Contract (mirrors the records-list authz path filteredConditions: fieldTypeById.has &&
 * allowedFieldIds.has): a filterInfo condition over a field NOT in the post-chokepoint allow-set is
 * SILENTLY dropped (no warning/error), behaving IDENTICALLY to a condition over a non-existent field —
 * so denied vs non-existent is itself not distinguishable (anti-oracle). A readable-field condition
 * still filters normally.
 *
 * Fixture mirrors multitable-lookup-foreign-field-mask-sibling-reads.test.ts (cross-base foreign sheet
 * → link → lookup → formula materialized into data → field_permissions deny on the foreign target).
 *
 * Real DB (describeIfDatabase). Drives the actual wire.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const DENY_USER = `u_dfo_d_${TS}` // denied on the cross-base foreign target → formula is TAINTED
const ALLOW_USER = `u_dfo_a_${TS}` // no field denial → formula readable, filter applies

const BASE_A = `base_dfo_a_${TS}`
const BASE_B = `base_dfo_b_${TS}`
const FS_X = `sheet_dfo_fx_${TS}` // cross-base foreign sheet (BASE_B)
const MS = `sheet_dfo_main_${TS}` // main source sheet (BASE_A)

const FLD_XTARGET = `fld_dfo_xt_${TS}` // cross-base foreign target (denied for DENY_USER)
const FLD_LINK = `fld_dfo_lk_${TS}`
const FLD_LU = `fld_dfo_lu_${TS}` // lookup over the cross-base target
const FLD_F = `fld_dfo_f_${TS}` // formula = {lookup}+1, materialized = FORMULA_VALUE
const FLD_GROUP = `fld_dfo_g_${TS}` // plain readable groupable column (group-by axis)

const REC_FX = `rec_dfo_fx_${TS}` // XTARGET = 7
const REC_M1 = `rec_dfo_m1_${TS}` // group='alpha', formula = 8
const REC_M2 = `rec_dfo_m2_${TS}` // group='beta',  formula = 8
const REC_M3 = `rec_dfo_m3_${TS}` // group='alpha', formula = 8

const FORMULA_VALUE = 8 // = lookup 7 + 1, pre-materialized into data
const TOTAL_ROWS = 3
const NONEXISTENT_FIELD = `fld_dfo_ghost_${TS}` // never created → non-existent control

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = {
      id: userId,
      roles: ['member'],
      perms: ['multitable:read', 'multitable:write', 'multitable:base:read'],
      permissions: ['multitable:read', 'multitable:write', 'multitable:base:read'],
    }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

async function seedMainRecord(recordId: string, group: string) {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
    recordId,
    MS,
    JSON.stringify({ [FLD_LINK]: [REC_FX], [FLD_F]: FORMULA_VALUE, [FLD_GROUP]: group }),
  ])
  await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [
    `lnk_dfo_${recordId}`,
    FLD_LINK,
    recordId,
    REC_FX,
  ])
}

let viewSeq = 0

/**
 * Persist a NEW saved view carrying the given filterInfo conditions and run a count widget grouped by
 * the readable group field. A fresh viewId per call sidesteps the route's per-viewId view-config cache
 * (tryResolveView memoizes filter_info by viewId), so each scenario resolves its own filter cleanly.
 * Returns the first widget result.
 */
async function dashboardWithSavedFilter(
  userId: string,
  conditions: Array<{ fieldId: string; operator: string; value?: unknown }>,
  conjunction: 'and' | 'or' = 'and',
) {
  const viewId = `v_dfo_${TS}_${viewSeq++}`
  await q(
    'INSERT INTO meta_views (id, sheet_id, name, type, filter_info, hidden_field_ids, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',
    [
      viewId,
      MS,
      'DFO Dash',
      'grid',
      JSON.stringify(conditions.length > 0 ? { conjunction, conditions } : {}),
      '[]',
      JSON.stringify({}),
    ],
  )
  const res = await request(buildApp(userId)).post('/api/multitable/dashboard/query').send({
    sheetId: MS,
    viewId,
    widgets: [{ title: 'By Group', chartType: 'bar', groupByFieldId: FLD_GROUP, metric: 'count' }],
  })
  expect(res.status).toBe(200)
  return res.body?.data?.widgets?.[0] as
    | { totalRecords?: number; points?: Array<{ key?: unknown; label?: unknown; value?: number; recordCount?: number }> }
    | undefined
}

describeIfDatabase('multitable dashboard filterInfo anti-oracle — denied/tainted saved-filter field (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'DFO Base A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_B, 'DFO Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS_X, BASE_B, 'DFO Cross Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE_A, 'DFO Main Sheet'])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_XTARGET, FS_X, 'XTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_FX, FS_X, JSON.stringify({ [FLD_XTARGET]: 7 })])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS_X }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU, MS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_XTARGET, foreignSheetId: FS_X }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_F, MS, 'FormulaCol', 'formula', JSON.stringify({ expression: `={${FLD_LU}}+1` }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_GROUP, MS, 'GroupCol', 'string', '{}', 4])

    await seedMainRecord(REC_M1, 'alpha')
    await seedMainRecord(REC_M2, 'beta')
    await seedMainRecord(REC_M3, 'alpha')

    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [MS, FLD_F, FLD_LU, MS])

    // DENY_USER is denied the cross-base foreign target → FLD_F (formula over it) is TAINTED for them.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [FS_X, FLD_XTARGET, 'user', DENY_USER, false, false])
    // Saved views (one per scenario, fresh viewId) are created on demand in dashboardWithSavedFilter().
  })

  afterAll(async () => {
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[FS_X, MS]]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── ORACLE CLOSED ──────────────────────────────────────────────────────────────────────────
  // A saved filterInfo condition over the TAINTED formula field, written to exclude every row when
  // applied (formula value is 8, condition demands 999), must NOT change the DENY actor's aggregate.
  // Without the fix the condition runs against raw data → 0 rows survive → totalRecords=0 (oracle:
  // probing `value` reveals when count flips, i.e. the masked formula value). With the fix the
  // tainted condition is dropped → all rows survive.
  test('oracle CLOSED: DENY tainted-field filter (excludes all rows) does NOT shrink the aggregate', async () => {
    const widget = await dashboardWithSavedFilter(DENY_USER, [{ fieldId: FLD_F, operator: 'is', value: '999' }])
    // Without the fix the tainted condition runs against raw data (8 != 999) → 0 rows → totalRecords=0,
    // and probing `value` reveals the masked formula value. With the fix it is dropped → all rows survive.
    expect(widget?.totalRecords).toBe(TOTAL_ROWS)
    expect((widget?.points ?? []).map((p) => String(p.key)).sort()).toEqual(['alpha', 'beta'])
  })

  test('oracle CLOSED: DENY tainted-field filter (matches formula value) ALSO does NOT change the aggregate', async () => {
    // The complementary probe: a condition that WOULD match (value=8 == formula) must yield the SAME
    // total as the exclude-all probe above. If the two probes differed, the difference is the oracle.
    const widget = await dashboardWithSavedFilter(DENY_USER, [{ fieldId: FLD_F, operator: 'is', value: String(FORMULA_VALUE) }])
    expect(widget?.totalRecords).toBe(TOTAL_ROWS)
  })

  // Expand-direction oracle (OR conjunction): the same vulnerability the other way. A tainted clause
  // OR'd in via `.some()` would WIDEN the surviving set. Here a non-matching readable clause is OR'd
  // with a matching tainted clause: without the fix the tainted `FLD_F is 8` clause matches every row
  // (3 survive); with the fix it is dropped, leaving only `FLD_GROUP is zzz` (no row) → 0 survive.
  test('oracle CLOSED: DENY tainted-field OR clause does NOT widen the surviving row set', async () => {
    const widget = await dashboardWithSavedFilter(
      DENY_USER,
      [
        { fieldId: FLD_GROUP, operator: 'is', value: 'zzz-no-row' },
        { fieldId: FLD_F, operator: 'is', value: String(FORMULA_VALUE) },
      ],
      'or',
    )
    // Only the readable `FLD_GROUP is zzz-no-row` clause survives pruning → matches nothing → 0 rows.
    // (Without the fix the tainted OR clause matches all rows → 3 — that delta is the expand oracle.)
    expect(widget?.totalRecords).toBe(0)
  })

  // ── ANTI-ORACLE: denied == non-existent == no-condition ─────────────────────────────────────
  test('anti-oracle: DENY tainted-field condition == non-existent-field condition == no condition', async () => {
    const noCondition = await dashboardWithSavedFilter(DENY_USER, [])
    const nonExistent = await dashboardWithSavedFilter(DENY_USER, [{ fieldId: NONEXISTENT_FIELD, operator: 'is', value: 'x' }])
    const deniedTainted = await dashboardWithSavedFilter(DENY_USER, [{ fieldId: FLD_F, operator: 'is', value: '999' }])

    // All three are indistinguishable: same surviving row set, same buckets — no field is dropped
    // with a distinguishable signal, so the denied field cannot be told apart from a non-existent one.
    expect(noCondition?.totalRecords).toBe(TOTAL_ROWS)
    expect(nonExistent?.totalRecords).toBe(noCondition?.totalRecords)
    expect(deniedTainted?.totalRecords).toBe(nonExistent?.totalRecords)

    const buckets = (w: typeof noCondition) =>
      JSON.stringify((w?.points ?? []).map((p) => [String(p.key), p.value, p.recordCount]).sort())
    expect(buckets(nonExistent)).toBe(buckets(noCondition))
    expect(buckets(deniedTainted)).toBe(buckets(noCondition))
  })

  // ── NON-VACUOUS: readable-field filter still works ──────────────────────────────────────────
  test('readable-field filter still narrows the aggregate (guard is field-scoped, not blanket)', async () => {
    const widget = await dashboardWithSavedFilter(DENY_USER, [{ fieldId: FLD_GROUP, operator: 'is', value: 'alpha' }])
    // REC_M1 + REC_M3 are 'alpha' → 2 rows survive; 'beta' (REC_M2) excluded.
    expect(widget?.totalRecords).toBe(2)
    expect((widget?.points ?? []).map((p) => String(p.key))).toEqual(['alpha'])
  })

  // ── NON-VACUOUS CONTROL: ALLOW actor (formula readable) — the same filter DOES apply ─────────
  // The fix is taint-scoped: an actor with NO foreign-field denial sees the formula readable, so its
  // filterInfo condition is honoured. This proves the DENY behaviour above is the MASK, not a blanket
  // disable of formula filters.
  test('control: ALLOW actor (no denial) — tainted-only-for-DENY formula filter DOES apply', async () => {
    const excludeAll = await dashboardWithSavedFilter(ALLOW_USER, [{ fieldId: FLD_F, operator: 'is', value: '999' }])
    const matchAll = await dashboardWithSavedFilter(ALLOW_USER, [{ fieldId: FLD_F, operator: 'is', value: String(FORMULA_VALUE) }])
    expect(excludeAll?.totalRecords).toBe(0) // 999 != 8 → all rows filtered out (filter is honoured)
    expect(matchAll?.totalRecords).toBe(TOTAL_ROWS) // 8 == 8 → all rows match
  })
})
