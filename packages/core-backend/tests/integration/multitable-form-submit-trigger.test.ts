/**
 * Real-event-chain integration test for the `form.submitted` automation trigger (#22).
 *
 * THE GAP this closes: the trigger is unit-covered (matchesTrigger, the event→type
 * mapping, the subscription count) but no test proves the REAL endpoint→fire chain.
 * This drives it end to end on real Postgres:
 *
 *   POST /views/:viewId/submit  (real route, real pool)
 *     →  eventBus.emit('multitable.form.submitted')  (integration bus)
 *       →  AutomationService subscription  →  matchesTrigger('form.submitted')
 *         →  executeRule  →  durable row in multitable_automation_executions.
 *
 * The AutomationService is wired onto the SAME integration bus the submit route emits
 * on (mirrors the webhook-event-bridge test). A NEGATIVE control proves the trigger is
 * DISTINCT: a plain POST /records (which fires record.created, NOT form.submitted)
 * produces no execution for the form.submitted rule.
 *
 * Runs only with DATABASE_URL (plugin-tests.yml multitable real-DB job).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { db } from '../../src/db/db'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_fst_${TS}`
const SHEET_ID = `sheet_fst_${TS}`
const VIEW_ID = `view_fst_${TS}`
const FLD_VALUE = `fld_fst_value_${TS}`
const USER_ID = `u_fst_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
// Real query fn for the executor's raw-SQL actions (not a mock — executeRule must run).
const queryFn = ((sql: string, params?: unknown[]) => poolManager.get().query(sql, params)) as never

let app: Express
let svc: AutomationService
let ruleId = ''

async function executionsFor(rid: string): Promise<Array<Record<string, unknown>>> {
  const r = await q('SELECT id, status FROM multitable_automation_executions WHERE rule_id = $1', [rid])
  return r.rows as Array<Record<string, unknown>>
}

async function waitForExecution(rid: string, timeoutMs = 5000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await executionsFor(rid)
    if (rows.length > 0) return rows
    if (Date.now() > deadline) return rows
    await new Promise((r) => setTimeout(r, 50))
  }
}

describeIfDatabase('form.submitted automation trigger real chain (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as unknown as { user: unknown }).user = { id: USER_ID, roles: ['member'], perms: ['multitable:write'] }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'Form Trigger Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'Form Trigger Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VALUE, SHEET_ID, 'Value', 'number', '{}', 1])
    await q('INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb)', [VIEW_ID, SHEET_ID, 'Form', 'form', JSON.stringify({})])

    // AutomationService wired onto the SAME integration bus the submit route emits on.
    svc = new AutomationService(integrationEventBus, db as never, queryFn)
    svc.init()
    // Enabled rule whose ONLY trigger is form.submitted. The action lands an execution row
    // regardless of action outcome (the log-service persists every run), so a fired rule is
    // observable even if update_record no-ops.
    const rule = await svc.createRule(SHEET_ID, {
      name: 'on form submit',
      triggerType: 'form.submitted',
      triggerConfig: {},
      actionType: 'update_record',
      actionConfig: { fields: { [FLD_VALUE]: 99 } },
    } as never)
    ruleId = (rule as { id: string }).id
  })

  afterAll(async () => {
    try { svc?.shutdown() } catch { /* noop */ }
    await q('DELETE FROM multitable_automation_executions WHERE rule_id = $1', [ruleId]).catch(() => {})
    await q('DELETE FROM automation_rules WHERE id = $1', [ruleId]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE id = $1', [VIEW_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('a real form submit emits form.submitted → AutomationService → durable execution row (keystone)', async () => {
    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { [FLD_VALUE]: 5 } })
    expect(res.status).toBe(200)

    // The subscription fires synchronously on emit, but executeRule is async; poll the durable row.
    const rows = await waitForExecution(ruleId)
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })

  test('negative: a plain record create (record.created, NOT form.submitted) does not fire the form.submitted rule', async () => {
    const before = (await executionsFor(ruleId)).length
    const res = await request(app)
      .post('/api/multitable/records')
      .send({ sheetId: SHEET_ID, data: { [FLD_VALUE]: 7 } })
    expect(res.status).toBe(200)
    // Give any (wrongly-wired) async fire a chance, then assert no new execution for the form rule.
    await new Promise((r) => setTimeout(r, 300))
    const after = (await executionsFor(ruleId)).length
    expect(after).toBe(before)
  })
})
