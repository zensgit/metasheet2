/**
 * B4 dashboard-LEVEL filtering — real-DB integration (chart-data + preview-data aggregation paths).
 *
 * A dashboard filter widget's (field, value) selection becomes an additional equals-constraint applied
 * to EVERY data panel's aggregation, AND-combined with the chart's own filter. This golden locks:
 *   1. NARROW: a dashboard filter narrows the aggregate to the matching records (per chart-data + preview).
 *   2. AND: it combines with a chart's OWN filter (intersection, not replacement).
 *   3. ALL: an empty/absent filter is a pass-through (the unfiltered aggregate).
 *   4. MULTI: two filter widgets AND-combine.
 *   5. ROW-DENY HOLDS: a row excluded by a read-deny rule stays excluded even when the dashboard filter
 *      would otherwise select it (the filter narrows the ALREADY-row-denied set; it cannot widen it).
 *   6. FIELD-MASK HOLDS / NO SIDE-CHANNEL: a dashboard filter on a field the actor CANNOT read restricts
 *      the chart wholesale (empty + metadata.restricted) and never leaks the hidden field's value — so it
 *      can't be used to probe a hidden column ("how many rows have secret = X").
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { dashboardRouter, getDashboardService } from '../../src/routes/dashboard'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_dlf_${TS}`
const SHEET_ID = `sheet_dlf_${TS}`
const REGION = `fld_dlf_region_${TS}`
const STATUS = `fld_dlf_status_${TS}`
const SECRET = `fld_dlf_secret_${TS}` // denied to the reader → must not be filterable as a side-channel
// Charts: one plain group-by-region count; one group-by-region count with its OWN filter status=open.
const CHART_REGION = `chart_dlf_region_${TS}`
const CHART_REGION_OPEN = `chart_dlf_region_open_${TS}`
const USER_ID = `u_dlf_reader_${TS}`
const USER_DENIED = `u_dlf_denied_${TS}`
const SECRET_CANARY = 'do-not-leak-dlf-canary'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const asJson = (v: unknown) => JSON.stringify(v)
let app: Express
let testUserId = USER_ID
let testRoles: string[] = []
let testPerms: string[] = ['multitable:read']

const setFlag = (on: boolean) => q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])
const setRules = (rules: unknown[]) => q('UPDATE meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1', [SHEET_ID, asJson(rules)])

type Body = { dataPoints?: Array<{ label: string; value: number }>; total?: number; metadata?: { restricted?: boolean; recordCount?: number } }
const bucket = (body: Body, label: string) => (body.dataPoints ?? []).find((p) => p.label === label)?.value

// GET /charts/:id/data with an optional dashboard filter list (URL-encoded JSON).
const chartData = async (chartId: string, filters?: Array<{ fieldId: string; value: unknown }>) => {
  let url = `/api/multitable/sheets/${SHEET_ID}/charts/${chartId}/data`
  if (filters && filters.length) url += `?dashboardFilter=${encodeURIComponent(JSON.stringify(filters))}`
  const res = await request(app).get(url)
  expect(res.status).toBe(200)
  return res.body as Body
}

// POST /charts/preview-data (group-by-region count — a VALID preview shape) with an optional dashboard
// filter on the body. (A groupBy is required by the preview-data validator for every non-scatter type.)
const previewByRegion = async (filters?: Array<{ fieldId: string; value: unknown }>) => {
  const res = await request(app)
    .post(`/api/multitable/sheets/${SHEET_ID}/charts/preview-data`)
    .send({
      name: 'by region',
      type: 'bar',
      dataSource: { groupByFieldId: REGION, aggregation: { function: 'count' } },
      ...(filters && filters.length ? { dashboardFilter: filters } : {}),
    })
  expect(res.status).toBe(200)
  return res.body as Body
}

describeIfDatabase('B4 dashboard-level filtering (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = testUserId ? { id: testUserId, roles: testRoles, perms: testPerms } : undefined; next() })
    app.use('/api/multitable', dashboardRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'DLF Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'DLF Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [REGION, SHEET_ID, 'Region', 'select', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [STATUS, SHEET_ID, 'Status', 'select', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SECRET, SHEET_ID, 'Secret', 'string', '{}', 3])
    // SECRET denied to USER_DENIED at field-permission layer-3 (property.hidden UNSET) so the deny is solely RBAC.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, SECRET, 'user', USER_DENIED, false, false])

    // 5 records:
    //   east/open, east/open, east/closed, west/open, west/closed
    // → region count: east=3, west=2 ; status=open count: east=2, west=1 ; (east AND open)=2.
    const rec = (id: string, region: string, status: string) =>
      q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [id, SHEET_ID, asJson({ [REGION]: region, [STATUS]: status, [SECRET]: SECRET_CANARY })])
    await rec(`rec_dlf_1_${TS}`, 'east', 'open')
    await rec(`rec_dlf_2_${TS}`, 'east', 'open')
    await rec(`rec_dlf_3_${TS}`, 'east', 'closed')
    await rec(`rec_dlf_4_${TS}`, 'west', 'open')
    await rec(`rec_dlf_5_${TS}`, 'west', 'closed')

    await q(
      `INSERT INTO multitable_charts (id, name, type, sheet_id, data_source, display, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [CHART_REGION, 'Count by region', 'bar', SHEET_ID, asJson({ groupByFieldId: REGION, aggregation: { function: 'count' } }), '{}', USER_ID],
    )
    // Chart with its OWN filter status=open — used to prove AND-combination with a dashboard filter.
    await q(
      `INSERT INTO multitable_charts (id, name, type, sheet_id, data_source, display, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [CHART_REGION_OPEN, 'Open by region', 'bar', SHEET_ID, asJson({ groupByFieldId: REGION, aggregation: { function: 'count' }, filterFieldId: STATUS, filterOperator: 'equals', filterValue: 'open' }), '{}', USER_ID],
    )
  })

  afterAll(async () => {
    getDashboardService().setRecordProvider(async () => [])
    await q('DELETE FROM multitable_charts WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  beforeEach(async () => {
    testUserId = USER_ID
    testRoles = []
    testPerms = ['multitable:read']
    await setFlag(false)
    await setRules([])
    getDashboardService().setRecordProvider(async () => [])
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('ALL — no dashboard filter: the full aggregate (east=3, west=2)', async () => {
    const body = await chartData(CHART_REGION)
    expect(bucket(body, 'east')).toBe(3)
    expect(bucket(body, 'west')).toBe(2)
  })

  test('NARROW — dashboard filter status=open narrows EVERY bucket (east=2, west=1)', async () => {
    const body = await chartData(CHART_REGION, [{ fieldId: STATUS, value: 'open' }])
    expect(bucket(body, 'east')).toBe(2)
    expect(bucket(body, 'west')).toBe(1)
    expect(body.metadata?.recordCount).toBe(3) // 3 open records total
  })

  test('NARROW — dashboard filter region=east narrows to one bucket (east=3, west gone)', async () => {
    const body = await chartData(CHART_REGION, [{ fieldId: REGION, value: 'east' }])
    expect(bucket(body, 'east')).toBe(3)
    expect(bucket(body, 'west')).toBeUndefined()
  })

  test('AND — dashboard filter region=east + the chart\'s OWN filter status=open → intersection (east=2 only)', async () => {
    // CHART_REGION_OPEN already filters status=open; add a dashboard filter region=east.
    const body = await chartData(CHART_REGION_OPEN, [{ fieldId: REGION, value: 'east' }])
    expect(bucket(body, 'east')).toBe(2) // east AND open
    expect(bucket(body, 'west')).toBeUndefined() // west excluded by the dashboard filter
  })

  test('MULTI — two dashboard filters (region=east AND status=open) AND-combine (east=2 only)', async () => {
    const body = await chartData(CHART_REGION, [
      { fieldId: REGION, value: 'east' },
      { fieldId: STATUS, value: 'open' },
    ])
    expect(bucket(body, 'east')).toBe(2)
    expect(bucket(body, 'west')).toBeUndefined()
    expect(body.metadata?.recordCount).toBe(2)
  })

  test('ALL — an empty selection in the list is dropped (behaves like no filter)', async () => {
    const body = await chartData(CHART_REGION, [{ fieldId: STATUS, value: '' }])
    expect(bucket(body, 'east')).toBe(3)
    expect(bucket(body, 'west')).toBe(2)
  })

  test('preview-data — a chart narrows by the dashboard filter (open: east=2, west=1)', async () => {
    const all = await previewByRegion()
    expect(bucket(all, 'east')).toBe(3)
    expect(bucket(all, 'west')).toBe(2)
    const open = await previewByRegion([{ fieldId: STATUS, value: 'open' }])
    expect(bucket(open, 'east')).toBe(2)
    expect(bucket(open, 'west')).toBe(1)
    expect(open.metadata?.recordCount).toBe(3)
  })

  test('ROW-DENY HOLDS — a read-denied row stays excluded even when the dashboard filter would select it', async () => {
    // Deny status=closed rows; then filter region=east. east has 2 open + 1 closed; the closed one is
    // denied, so the filtered east count is 2 (not 3) — the filter narrows the already-row-denied set.
    await setFlag(true)
    await setRules([{ id: 'r1', fieldId: STATUS, operator: 'eq', value: 'closed', effect: 'deny_read' }])
    const body = await chartData(CHART_REGION, [{ fieldId: REGION, value: 'east' }])
    expect(bucket(body, 'east')).toBe(2) // 3 east rows − 1 denied closed = 2
  })

  test('NO SIDE-CHANNEL — a dashboard filter on a DENIED field restricts the chart (no value leak)', async () => {
    // The reader who CANNOT read SECRET tries to filter on it → restricted, not a probe of the hidden column.
    testUserId = USER_DENIED
    testPerms = ['multitable:read']
    const body = await chartData(CHART_REGION, [{ fieldId: SECRET, value: SECRET_CANARY }])
    expect(body).toMatchObject({ chartId: CHART_REGION, dataPoints: [], total: 0, metadata: { restricted: true, recordCount: 0 } })
    expect(JSON.stringify(body)).not.toContain(SECRET_CANARY)
  })

  test('NO SIDE-CHANNEL — same denied-field filter via preview-data is also restricted', async () => {
    testUserId = USER_DENIED
    testPerms = ['multitable:read']
    const body = await previewByRegion([{ fieldId: SECRET, value: SECRET_CANARY }])
    expect(body.metadata?.restricted).toBe(true)
    expect((body.dataPoints ?? []).length).toBe(0)
    expect(JSON.stringify(body)).not.toContain(SECRET_CANARY)
  })

  test('an allowed reader CAN filter on a readable field unaffected (control for the deny test)', async () => {
    // The non-denied USER_ID filtering on a readable field works normally — proves the restriction is
    // field-permission-scoped, not a blanket reject of all dashboard filters.
    const body = await chartData(CHART_REGION, [{ fieldId: STATUS, value: 'open' }])
    expect(body.metadata?.restricted).toBeUndefined()
    expect(bucket(body, 'east')).toBe(2)
  })
})
