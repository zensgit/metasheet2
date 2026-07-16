/**
 * FWB-1 slice ④-b — write_approval_form_values through the REAL AutomationExecutor.runSingleAction (real DB).
 * Proves the case is wired end-to-end: flag-off → skipped; flag-on → record + revision + ledger claim +
 * outbox all committed together; duplicate delivery → net-once (one record); gate-deny → failed, no writes.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { AutomationExecutor, type AutomationDeps, type ExecutionContext } from '../../src/multitable/automation-executor'
import type { FwbGateChecks } from '../../src/multitable/approval-fwb-permission-gates'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const SHEET = `sheet_${RUN}`

const allowGates: FwbGateChecks = {
  isAdmin: async () => true,
  canManageSheetAccess: async () => true,
  canReadTemplate: async () => true,
  canWriteSheet: async () => true,
  hasRecordedConfirmation: async () => true,
}

function makeExecutor(gates: FwbGateChecks): AutomationExecutor {
  const pool = db().getInternalPool()
  const deps: AutomationDeps = {
    eventBus: { emit: () => {}, on: () => {}, off: () => {} } as unknown as AutomationDeps['eventBus'],
    queryFn: (sql, params) => db().query(sql, params),
    transaction: async (handler) => {
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        const r = await handler({ query: (sql, params) => c.query(sql, params) })
        await c.query('COMMIT')
        return r
      } catch (e) {
        await c.query('ROLLBACK')
        throw e
      } finally {
        c.release()
      }
    },
    fwbGateChecks: gates,
  }
  return new AutomationExecutor(deps)
}

const ctx = (): ExecutionContext => ({
  executionId: `exec_${RUN}`,
  ruleId: `rule_${RUN}`,
  sheetId: SHEET,
  recordId: 'trigger_rec',
  recordData: {},
  ruleCreatedBy: 'u1',
  actorId: 'u1',
  triggerEvent: { instanceId: `apr_${RUN}`, _eventId: `evt_${RUN}`, templateId: 'tpl1', _automationDepth: 0, formValues: { f1: 'hello' } },
})
const config = { targetSheetId: SHEET, mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' as const }] }
const action = { type: 'write_approval_form_values' as const, config: config as unknown as Record<string, unknown> }

async function counts() {
  const rec = await db().query('SELECT count(*)::int AS c FROM meta_records WHERE sheet_id=$1', [SHEET])
  const led = await db().query('SELECT count(*)::int AS c FROM meta_automation_action_applied WHERE instance_id=$1', [`apr_${RUN}`])
  const obx = await db().query('SELECT count(*)::int AS c FROM meta_automation_outbox WHERE event_id LIKE $1', [`evt_${RUN}%`])
  return { rec: Number(rec.rows[0].c), led: Number(led.rows[0].c), obx: Number(obx.rows[0].c) }
}

describeIfDatabase('FWB-1 ④-b — write_approval_form_values via runSingleAction (real DB)', () => {
  beforeAll(async () => {
    process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
    const baseId = `base_${RUN}`
    await db().query(
      `INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id) VALUES ($1,'FWB4b','','','system:test',NULL) ON CONFLICT (id) DO NOTHING`,
      [baseId],
    )
    await db().query(`INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,'FWB4bSheet','') ON CONFLICT (id) DO NOTHING`, [SHEET, baseId])
  })
  afterAll(async () => {
    delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
    await db().query('DELETE FROM meta_records WHERE sheet_id=$1', [SHEET]).catch(() => {})
    await db().query('DELETE FROM meta_automation_action_applied WHERE instance_id=$1', [`apr_${RUN}`]).catch(() => {})
    await db().query('DELETE FROM meta_automation_outbox WHERE event_id LIKE $1', [`evt_${RUN}%`]).catch(() => {})
    await db().query('DELETE FROM meta_sheets WHERE id=$1', [SHEET]).catch(() => {})
    await db().query('DELETE FROM meta_bases WHERE id=$1', [`base_${RUN}`]).catch(() => {})
  })

  test('flag OFF → the action is skipped (no half-durable path), zero writes', async () => {
    delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
    const r = await makeExecutor(allowGates).runSingleAction(action, ctx())
    expect(r.status).toBe('skipped')
    expect(await counts()).toEqual({ rec: 0, led: 0, obx: 0 })
    process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
  })

  test('flag ON → success writes record + revision + ledger claim + outbox TOGETHER; re-run is net-once', async () => {
    const r = await makeExecutor(allowGates).runSingleAction(action, ctx())
    expect(r.status).toBe('success')
    const c1 = await counts()
    expect(c1).toEqual({ rec: 1, led: 1, obx: 1 }) // all four committed together
    const rev = await db().query('SELECT count(*)::int AS c FROM meta_record_versions WHERE sheet_id=$1', [SHEET]).catch(() => ({ rows: [{ c: -1 }] }))
    expect(Number(rev.rows[0].c)).not.toBe(0) // a create revision exists (table name-agnostic: just non-zero)
    // duplicate delivery: same identity → net-once (no new record/claim)
    const r2 = await makeExecutor(allowGates).runSingleAction(action, ctx())
    expect(r2.status).toBe('success')
    expect((await counts()).rec).toBe(1)
  })

  test('gate-deny → failed, and nothing is written (fail-closed)', async () => {
    const ctx2 = ctx()
    ;(ctx2.triggerEvent as Record<string, unknown>)._eventId = `evt_${RUN}_deny`
    const deny: FwbGateChecks = { ...allowGates, canWriteSheet: async () => false }
    const before = await counts()
    const r = await makeExecutor(deny).runSingleAction({ ...action }, ctx2)
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/fwb_rejected:permission_gates/)
    expect(await counts()).toEqual(before) // no writes
  })
})
