/**
 * D3d-style real-DB integration test for the aggregation footer endpoint
 * GET /api/multitable/sheets/:sheetId/view-aggregate (benchmark v2 #4-3b-1).
 *
 * Backend-first: confirms security (hidden field omitted), correctness (full filtered set, not a page),
 * parity with /view's filtered total, fn semantics, and the max-rows hard-fail — BEFORE any frontend.
 * Runs only with DATABASE_URL (describeIfDatabase) via the dedicated plugin-tests.yml step.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_agg_${TS}`
const BASE_ID = `base_agg_${TS}`
const SHEET_ID = `sheet_agg_${TS}`
const FLD_QTY = `fld_qty_${TS}`
const FLD_CAT = `fld_cat_${TS}`
const FLD_SECRET = `fld_secret_${TS}`
const FLD_NOTE = `fld_note_${TS}`
const FLD_FORMULA = `fld_formula_${TS}`
const V_MAIN = `v_main_${TS}`
const V_FILTER = `v_filter_${TS}`
const V_SECRET = `v_secret_${TS}`
const V_BADFN = `v_badfn_${TS}`
const V_HIDFILTER = `v_hidfilter_${TS}` // hides + filters on the same field
const V_COMPUTED = `v_computed_${TS}` // filters on a computed (formula) field → must 422
const V_GROUP = `v_group_${TS}` // groups by cat (A/B)
const V_GROUP_SECRET = `v_group_secret_${TS}` // groups by cat, aggregates a hidden field → omitted per group
const V_GROUP_NOTE = `v_group_note_${TS}` // groups by note (has empty '' → null-key group)
const V_GROUP_DENIED = `v_group_denied_${TS}` // groups by a hidden field → 422
const V_GROUP_COMPUTED = `v_group_computed_${TS}` // groups by a computed (formula) field → 422
const V_GROUP_NESTED = `v_group_nested_${TS}` // groups by [cat, note] → 2-level subtotal tree
const V_GROUP_DENIED_L2 = `v_group_denied_l2_${TS}` // groups by [cat, hiddenField] → 422 at level 2
const V_GROUP_COMPUTED_L2 = `v_group_computed_l2_${TS}` // groups by [cat, formula] → 422 at level 2
const N = 60 // > default page size (50) → proves full-set, not page

let app: Express
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

async function aggregate(viewId: string) {
  const res = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/view-aggregate?viewId=${viewId}`)
  return res
}

describeIfDatabase('multitable view-aggregate (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: USER, roles: ['member'], perms: ['multitable:read'] }; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'Agg Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'Agg Sheet'])
    for (const [fid, name, type, order] of [
      [FLD_QTY, 'Qty', 'number', 1], [FLD_CAT, 'Cat', 'string', 2],
      [FLD_SECRET, 'Secret', 'number', 3], [FLD_NOTE, 'Note', 'string', 4],
      [FLD_FORMULA, 'Formula', 'formula', 5],
    ] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, SHEET_ID, name, type, '{}', order])
    }
    for (let i = 1; i <= N; i++) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
        `rec_${TS}_${i}`, SHEET_ID,
        JSON.stringify({ [FLD_QTY]: i, [FLD_CAT]: i % 2 === 1 ? 'A' : 'B', [FLD_SECRET]: i, [FLD_NOTE]: i % 3 === 0 ? '' : 'x' }),
      ])
    }
    const view = (id: string, aggregations: Record<string, string>, filter: unknown) =>
      q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',
        [id, SHEET_ID, id, 'grid', '[]', JSON.stringify(filter ?? { conjunction: 'and', conditions: [] }), JSON.stringify({ aggregations })])
    await view(V_MAIN, { [FLD_QTY]: 'sum', [FLD_NOTE]: 'countNonEmpty', [FLD_CAT]: 'count' }, null)
    await view(V_FILTER, { [FLD_QTY]: 'sum' }, { conjunction: 'and', conditions: [{ fieldId: FLD_CAT, operator: 'is', value: 'A' }] })
    await view(V_SECRET, { [FLD_SECRET]: 'sum', [FLD_QTY]: 'sum' }, null)
    await view(V_BADFN, { [FLD_CAT]: 'sum' }, null) // sum on a string field → not applicable
    // hides FLD_CAT from display (view.hiddenFieldIds) but still FILTERS on it (cat=A). /view resolves
    // the filter over static-visible fields → total 30; the aggregate must match (filter parity uses
    // visibleFields, NOT the D3c-allowed set).
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',
      [V_HIDFILTER, SHEET_ID, V_HIDFILTER, 'grid', JSON.stringify([FLD_CAT]),
        JSON.stringify({ conjunction: 'and', conditions: [{ fieldId: FLD_CAT, operator: 'is', value: 'A' }] }),
        JSON.stringify({ aggregations: { [FLD_QTY]: 'sum' } })])
    // filters on a computed (formula) field → can't be evaluated here → must HARD-FAIL 422
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',
      [V_COMPUTED, SHEET_ID, V_COMPUTED, 'grid', '[]',
        JSON.stringify({ conjunction: 'and', conditions: [{ fieldId: FLD_FORMULA, operator: 'isnotempty' }] }),
        JSON.stringify({ aggregations: { [FLD_QTY]: 'sum' } })])
    // grouped views (#4-3b-2a): grid group field = view.groupInfo.fieldId
    const groupedView = (id: string, aggregations: Record<string, string>, groupFieldId: string) =>
      q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, config, group_info) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)',
        [id, SHEET_ID, id, 'grid', '[]', JSON.stringify({ conjunction: 'and', conditions: [] }),
          JSON.stringify({ aggregations }), JSON.stringify({ fieldId: groupFieldId })])
    await groupedView(V_GROUP, { [FLD_QTY]: 'sum' }, FLD_CAT) // A/B, 30 each
    await groupedView(V_GROUP_SECRET, { [FLD_QTY]: 'sum', [FLD_SECRET]: 'sum' }, FLD_CAT) // secret omitted per group
    await groupedView(V_GROUP_NOTE, { [FLD_QTY]: 'sum' }, FLD_NOTE) // '' → null-key group
    await groupedView(V_GROUP_DENIED, { [FLD_QTY]: 'sum' }, FLD_SECRET) // hidden group field → 422
    await groupedView(V_GROUP_COMPUTED, { [FLD_QTY]: 'sum' }, FLD_FORMULA) // computed group field → 422
    // nested grouping (multi-level): groupInfo.fieldIds = ordered levels
    const nestedView = (id: string, aggregations: Record<string, string>, groupFieldIds: string[]) =>
      q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, config, group_info) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)',
        [id, SHEET_ID, id, 'grid', '[]', JSON.stringify({ conjunction: 'and', conditions: [] }),
          JSON.stringify({ aggregations }), JSON.stringify({ fieldIds: groupFieldIds, fieldId: groupFieldIds[0] })])
    await nestedView(V_GROUP_NESTED, { [FLD_QTY]: 'sum' }, [FLD_CAT, FLD_NOTE]) // cat(A/B) → note(x/'')
    await nestedView(V_GROUP_DENIED_L2, { [FLD_QTY]: 'sum' }, [FLD_CAT, FLD_SECRET]) // hidden at level 2 → 422
    await nestedView(V_GROUP_COMPUTED_L2, { [FLD_QTY]: 'sum' }, [FLD_CAT, FLD_FORMULA]) // computed at level 2 → 422
    // hide fld_secret from this user (subject-scoped) — its aggregate must be OMITTED
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    delete process.env.MULTITABLE_AGGREGATE_MAX_ROWS
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('aggregates the FULL filtered set (not a page): sum over 60 rows', async () => {
    const res = await aggregate(V_MAIN)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(N)
    expect(res.body.data.aggregates[FLD_QTY]).toEqual({ fn: 'sum', value: 1830 }) // 1+..+60
    expect(res.body.data.aggregates[FLD_NOTE]).toEqual({ fn: 'countNonEmpty', value: 40 }) // 60 - 20 empty (i%3==0)
    expect(res.body.data.aggregates[FLD_CAT]).toEqual({ fn: 'count', value: 60 })
  })

  test('PARITY: /view-aggregate total === /view filtered page.total (filter-resolution agreement)', async () => {
    // /view returns a `page` object only when paginated → pass limit. Use the FILTERED view so this
    // validates the aggregate's persisted-filter resolution matches /view's (not just a raw count).
    const viewRes = await request(app).get(`/api/multitable/view?sheetId=${SHEET_ID}&viewId=${V_FILTER}&limit=1&offset=0`)
    const aggRes = await aggregate(V_FILTER)
    expect(viewRes.body.data.page.total).toBe(30) // /view applies the persisted cat=A filter
    expect(aggRes.body.data.total).toBe(viewRes.body.data.page.total)
  })

  test('respects PERSISTED view filter (cat=A) over the full set', async () => {
    const res = await aggregate(V_FILTER)
    expect(res.body.data.total).toBe(30) // odd i → cat A
    expect(res.body.data.aggregates[FLD_QTY]).toEqual({ fn: 'sum', value: 900 }) // 1+3+...+59 = 30^2
  })

  test('SECURITY: hidden field (field_permissions.visible=false) aggregate is OMITTED', async () => {
    const res = await aggregate(V_SECRET)
    expect(res.body.data.aggregates[FLD_QTY]).toBeDefined() // visible field present
    expect(res.body.data.aggregates[FLD_SECRET]).toBeUndefined() // hidden → omitted, NOT null/0
  })

  test('fn not applicable to field type (sum on string) is omitted', async () => {
    const res = await aggregate(V_BADFN)
    expect(res.body.data.aggregates[FLD_CAT]).toBeUndefined()
  })

  test('max-rows guard HARD-FAILS with 413 + total (never truncates)', async () => {
    process.env.MULTITABLE_AGGREGATE_MAX_ROWS = '10'
    const res = await aggregate(V_MAIN)
    delete process.env.MULTITABLE_AGGREGATE_MAX_ROWS
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('AGGREGATE_TOO_LARGE')
    expect(res.body.error.total).toBe(N)
  })

  test('SEARCH PARITY: uppercase search is normalized (trim+lowercase) exactly like /view', async () => {
    // cat values are 'A'/'B' (30 each). A raw (un-lowercased) 'A' would match nothing in the
    // lowercase-compared cell text → divergence; normalizeSearchTerm makes both agree on 30.
    const viewRes = await request(app).get(`/api/multitable/view?sheetId=${SHEET_ID}&viewId=${V_MAIN}&search=A&limit=1&offset=0`)
    const aggRes = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/view-aggregate?viewId=${V_MAIN}&search=A`)
    expect(viewRes.body.data.page.total).toBe(30)
    expect(aggRes.body.data.total).toBe(viewRes.body.data.page.total)
  })

  test('FILTER PARITY: filtering on a view-hidden field still counts rows (matches /view), aggregate present', async () => {
    // V_HIDFILTER hides FLD_CAT but filters cat=A. Filter resolution uses static-visible fields (like
    // /view), NOT the D3c-allowed set — so the row count must still be 30, not 60.
    const viewRes = await request(app).get(`/api/multitable/view?sheetId=${SHEET_ID}&viewId=${V_HIDFILTER}&limit=1&offset=0`)
    const aggRes = await aggregate(V_HIDFILTER)
    expect(viewRes.body.data.page.total).toBe(30)
    expect(aggRes.body.data.total).toBe(30)
    expect(aggRes.body.data.aggregates[FLD_QTY]).toEqual({ fn: 'sum', value: 900 }) // FLD_QTY not hidden → present
  })

  test('COMPUTED FILTER: view filtering on a formula field HARD-FAILS 422 (no silent wrong total)', async () => {
    const res = await aggregate(V_COMPUTED)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('AGGREGATE_COMPUTED_FILTER_UNSUPPORTED')
  })

  // ---- #4-3b-2a group subtotals ----

  test('GROUP: groups partition the full set (Σ count === total) with per-group sums', async () => {
    const res = await aggregate(V_GROUP) // group by cat A/B
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(N)
    expect(res.body.data.groupFieldId).toBe(FLD_CAT)
    const groups = res.body.data.groups as Array<{ key: unknown; count: number; aggregates: Record<string, { fn: string; value: number }> }>
    expect(groups.map((g) => g.key)).toEqual(['A', 'B']) // server key order
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(N) // partition
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]))
    expect(byKey.A.count).toBe(30)
    expect(byKey.A.aggregates[FLD_QTY]).toEqual({ fn: 'sum', value: 900 }) // odd i 1..59
    expect(byKey.B.aggregates[FLD_QTY]).toEqual({ fn: 'sum', value: 930 }) // even i 2..60
    // grand total unchanged + still present alongside groups
    expect(res.body.data.aggregates[FLD_QTY]).toEqual({ fn: 'sum', value: 1830 })
  })

  test('GROUP SECURITY: a hidden aggregate field is OMITTED in every group (not just the grand total)', async () => {
    const res = await aggregate(V_GROUP_SECRET) // groups by cat, config aggregates FLD_SECRET (hidden) + FLD_QTY
    expect(res.status).toBe(200)
    for (const g of res.body.data.groups as Array<{ aggregates: Record<string, unknown> }>) {
      expect(g.aggregates[FLD_QTY]).toBeDefined()
      expect(g.aggregates[FLD_SECRET]).toBeUndefined() // hidden → omitted per group, NOT null/0
    }
    expect(res.body.data.aggregates[FLD_SECRET]).toBeUndefined() // and in the grand total
  })

  test('GROUP empty/NULL key: empty cell values form one group with key:null', async () => {
    const res = await aggregate(V_GROUP_NOTE) // note = '' when i%3==0 (20 rows) else 'x' (40 rows)
    expect(res.status).toBe(200)
    const groups = res.body.data.groups as Array<{ key: unknown; count: number }>
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(N)
    const nullGroup = groups.find((g) => g.key === null)
    expect(nullGroup).toBeDefined()
    expect(nullGroup!.count).toBe(20) // the '' rows
    expect(groups.find((g) => g.key === 'x')!.count).toBe(40)
  })

  test('GROUP DENIED: grouping by a hidden field HARD-FAILS 422 (group keys would leak its data)', async () => {
    const res = await aggregate(V_GROUP_DENIED) // groups by FLD_SECRET (field_permissions.visible=false)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('AGGREGATE_GROUP_FIELD_DENIED')
  })

  test('GROUP COMPUTED: grouping by a formula field HARD-FAILS 422', async () => {
    const res = await aggregate(V_GROUP_COMPUTED)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('AGGREGATE_COMPUTED_GROUP_UNSUPPORTED')
  })

  // ---- nested / multi-level grouping ----

  test('NESTED GROUP: 2-level tree partitions at every level (Σ leaf counts === N) + grand total present', async () => {
    const res = await aggregate(V_GROUP_NESTED) // group by [cat, note]
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(N)
    expect(res.body.data.groupFieldIds).toEqual([FLD_CAT, FLD_NOTE]) // ordered levels echoed
    expect(res.body.data.groupFieldId).toBe(FLD_CAT) // legacy level-1 echo for back-compat readers
    const groups = res.body.data.groups as Array<{ key: unknown; count: number; aggregates: Record<string, { fn: string; value: number }>; children?: Array<{ key: unknown; count: number; aggregates: Record<string, { fn: string; value: number }> }> }>
    expect(groups.map((g) => g.key)).toEqual(['A', 'B'])
    // partition at level 1
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(N)
    // partition at level 2 (Σ children === parent) AND Σ all leaf counts === N
    let leafSum = 0
    for (const g of groups) {
      expect(g.children).toBeDefined()
      expect(g.children!.reduce((s, c) => s + c.count, 0)).toBe(g.count)
      // each cat: note 'x' (20) + null (10) = 30
      const byKey = Object.fromEntries(g.children!.map((c) => [String(c.key), c]))
      expect(byKey['x'].count).toBe(20)
      const nullChild = g.children!.find((c) => c.key === null)!
      expect(nullChild.count).toBe(10)
      leafSum += g.children!.reduce((s, c) => s + c.count, 0)
    }
    expect(leafSum).toBe(N)
    // per-level INDEPENDENT aggregation: level-1 A sum (odd i 1..59) = 900; its 'x' child sum = the
    // odd-i rows with note≠'' = i where i odd AND i%3≠0 → recomputed over node.rows, not a child roll-up.
    const a = groups.find((g) => g.key === 'A')!
    expect(a.aggregates[FLD_QTY]).toEqual({ fn: 'sum', value: 900 })
    const aChildSum = a.children!.reduce((s, c) => s + (c.aggregates[FLD_QTY]?.value ?? 0), 0)
    expect(aChildSum).toBe(a.aggregates[FLD_QTY]!.value) // children sums DO add up for `sum` (invariant)
    // grand total still present alongside the tree
    expect(res.body.data.aggregates[FLD_QTY]).toEqual({ fn: 'sum', value: 1830 })
  })

  test('NESTED DENY at level 2: a hidden field at the 2nd level HARD-FAILS 422 (same as level 1)', async () => {
    const res = await aggregate(V_GROUP_DENIED_L2) // group by [cat, secret(hidden)]
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('AGGREGATE_GROUP_FIELD_DENIED')
  })

  test('NESTED COMPUTED at level 2: a formula field at the 2nd level HARD-FAILS 422', async () => {
    const res = await aggregate(V_GROUP_COMPUTED_L2) // group by [cat, formula]
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('AGGREGATE_COMPUTED_GROUP_UNSUPPORTED')
  })

  test('BACK-COMPAT: a view persisted with legacy groupInfo.fieldId still groups (single level, no children)', async () => {
    const res = await aggregate(V_GROUP) // V_GROUP uses { fieldId } (legacy single-field shape)
    expect(res.status).toBe(200)
    expect(res.body.data.groupFieldIds).toEqual([FLD_CAT]) // dual-read promotes fieldId → fieldIds[0]
    const groups = res.body.data.groups as Array<{ children?: unknown }>
    expect(groups.every((g) => g.children === undefined)).toBe(true) // single level → no nesting
  })
})
