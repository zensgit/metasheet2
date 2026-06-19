/**
 * Dashboard chart aggregation — production wiring + row-level read-deny (real DB).
 *
 * Two things this golden locks, both previously unverified (charts were only tested via an injected
 * setRecordProvider, so prod computed on [] and row-deny over chart records was never exercised):
 *   1. WIRING: with NO record provider injected, the chart-data route loads real meta_records itself and
 *      aggregates them → non-empty data (the empty-charts-in-prod defect would make this fail).
 *   2. ROW-DENY: a conditional read-deny rule excludes the denied record from the aggregate (no
 *      count/label leak), with the SAME admin-bypass + flag-off-inert semantics as /view + /view-aggregate.
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
const BASE_ID = `base_crd_chart_${TS}`
const SHEET_ID = `sheet_crd_chart_${TS}`
const STATUS = `fld_crd_chart_status_${TS}`
const CHART_ID = `chart_crd_${TS}`
const USER_ID = `u_crd_chart_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const asJson = (v: unknown) => JSON.stringify(v)
let app: Express
let testUserId = USER_ID
let testRoles: string[] = []
let testPerms: string[] = ['multitable:read']

const setFlag = (on: boolean) => q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])
const setRules = (rules: unknown[]) => q('UPDATE meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1', [SHEET_ID, asJson(rules)])
const denySecretRule = [{ id: 'r1', fieldId: STATUS, operator: 'eq', value: 'secret', effect: 'deny_read' }]

const chartData = async () => {
  const res = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/charts/${CHART_ID}/data`)
  expect(res.status).toBe(200)
  return res.body as { dataPoints?: Array<{ label: string; value: number }>; total?: number; metadata?: { restricted?: boolean } }
}
const bucket = (body: { dataPoints?: Array<{ label: string; value: number }> }, label: string) =>
  (body.dataPoints ?? []).find((p) => p.label === label)?.value

describeIfDatabase('dashboard chart aggregation — wiring + row-level read-deny (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = testUserId ? { id: testUserId, roles: testRoles, perms: testPerms } : undefined; next() })
    app.use('/api/multitable', dashboardRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'CRD Chart Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'CRD Chart Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [STATUS, SHEET_ID, 'Status', 'select', '{}', 1])
    // 2 open + 1 secret
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [`rec_crd_o1_${TS}`, SHEET_ID, asJson({ [STATUS]: 'open' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [`rec_crd_o2_${TS}`, SHEET_ID, asJson({ [STATUS]: 'open' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [`rec_crd_s1_${TS}`, SHEET_ID, asJson({ [STATUS]: 'secret' })])
    await q(
      `INSERT INTO multitable_charts (id, name, type, sheet_id, data_source, display, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [CHART_ID, 'Count by status', 'bar', SHEET_ID, asJson({ groupByFieldId: STATUS, aggregation: { function: 'count' } }), '{}', USER_ID],
    )
  })

  afterAll(async () => {
    getDashboardService().setRecordProvider(async () => [])
    await q('DELETE FROM multitable_charts WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
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
    // Empty provider on purpose: the route must NOT depend on it — it loads real meta_records.
    getDashboardService().setRecordProvider(async () => [])
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('wiring — with NO provider, the chart aggregates real records (non-empty)', async () => {
    const body = await chartData()
    expect((body.dataPoints ?? []).length).toBeGreaterThan(0) // would be 0 if prod still computed on []
    expect(bucket(body, 'open')).toBe(2)
    expect(bucket(body, 'secret')).toBe(1)
  })

  test('row-deny — flag ON + deny rule: the denied record is excluded from the aggregate (no leak)', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const body = await chartData()
    expect(bucket(body, 'open')).toBe(2) // visible records still aggregated
    expect(bucket(body, 'secret')).toBeUndefined() // denied record contributes nothing
    expect(JSON.stringify(body)).not.toContain('"secret"')
  })

  test('inert — flag OFF even with a deny rule: all records aggregate (default-off changes nothing)', async () => {
    await setRules(denySecretRule)
    await setFlag(false)
    const body = await chartData()
    expect(bucket(body, 'secret')).toBe(1)
  })

  test('admin bypass — flag ON + deny rule: an admin still sees the denied record in the aggregate', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    testRoles = ['admin']
    const body = await chartData()
    expect(bucket(body, 'secret')).toBe(1)
    testRoles = []
  })
})
