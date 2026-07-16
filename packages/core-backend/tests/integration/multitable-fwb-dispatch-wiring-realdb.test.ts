/**
 * FWB-1 slice ④-a — dispatch wiring against the REAL durable seams (real DB, composed chain).
 * Proves: flag-off construction refused; a dispatched action derives a stable action_key, claims, writes
 * the record, and its outbox row is a REAL manifest-expanded fan-out with depth+1; re-dispatch of the same
 * rule context is net-once; different structuralPath = independent action.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { FwbActionDispatcher, type FwbRuleContext } from '../../src/multitable/approval-fwb-dispatch-wiring'
import type { FwbGateChecks } from '../../src/multitable/approval-fwb-permission-gates'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const SCRATCH = `wire_scratch_${RUN.replace(/-/g, '')}`
const FLAG_ON = { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv

const gates: FwbGateChecks = {
  isAdmin: async () => true,
  canManageSheetAccess: async () => true,
  canReadTemplate: async () => true,
  canWriteSheet: async () => true,
  hasRecordedConfirmation: async () => true,
}
const ctx = (over: Partial<FwbRuleContext> = {}): FwbRuleContext => ({
  instanceId: `apr_${RUN}`,
  ruleId: `rule_${RUN}`,
  structuralPath: 'steps[0].actions[0]',
  configurerUserId: 'u1',
  sourceTemplateId: 'tpl',
  eventId: `evt_${RUN}`,
  automationDepth: 0,
  formValues: { f1: 'hello' },
  ...over,
})
const config = { targetSheetId: `sheet_${RUN}`, mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' as const }] }

describeIfDatabase('FWB-1 slice ④-a — dispatch wiring (real DB, composed chain)', () => {
  beforeAll(async () => {
    await db().query(`CREATE TABLE IF NOT EXISTS ${SCRATCH} (id text PRIMARY KEY, sheet_id text NOT NULL, payload jsonb NOT NULL)`)
  })
  afterAll(async () => {
    await db().query(`DROP TABLE IF EXISTS ${SCRATCH}`).catch(() => {})
    await db().query('DELETE FROM meta_automation_action_applied WHERE instance_id=$1', [`apr_${RUN}`]).catch(() => {})
    await db().query('DELETE FROM meta_automation_outbox WHERE event_id LIKE $1', [`evt_${RUN}%`]).catch(() => {})
  })

  const deps = () => ({
    gates,
    createRecordWithRevision: async (trx: { query: (s: string, p?: unknown[]) => Promise<unknown> }, sheetId: string, values: Record<string, string | number>) => {
      const id = `rec_${randomUUID()}`
      await trx.query(`INSERT INTO ${SCRATCH} (id, sheet_id, payload) VALUES ($1,$2,$3::jsonb)`, [id, sheetId, JSON.stringify(values)])
      return id
    },
    env: FLAG_ON,
  })

  test('flag OFF → construction refused (no half-durable FWB path can exist)', () => {
    expect(() => new FwbActionDispatcher({ ...deps(), env: {} as NodeJS.ProcessEnv })).toThrow(/requires AUTOMATION_DURABLE_DELIVERY_ENABLED/)
  })

  test('dispatch: applied → record written + REAL manifest fan-out outbox row with depth+1; re-dispatch net-once', async () => {
    const d = new FwbActionDispatcher(deps())
    const raw = db().getInternalPool()
    const c = await raw.connect()
    try {
      await c.query('BEGIN')
      const r = await d.dispatch(c, ctx(), config)
      expect(r.status).toBe('applied')
      await c.query('COMMIT')
    } finally {
      c.release()
    }
    // the derived event landed as a real outbox row with manifest fan-out and inherited depth
    const ob = await db().query(
      `SELECT o.event_type, o.automation_depth, count(oc.consumer_key)::int AS fanout
         FROM meta_automation_outbox o JOIN meta_automation_outbox_consumer oc ON oc.outbox_id = o.id
        WHERE o.event_id LIKE $1 GROUP BY o.id`,
      [`evt_${RUN}::fwb::%`],
    )
    expect(ob.rows[0]).toMatchObject({ event_type: 'multitable.record.created', automation_depth: 1, fanout: 2 }) // record-trigger + webhook-bridge
    // net-once on re-dispatch (same rule context → same action_key)
    const c2 = await raw.connect()
    try {
      await c2.query('BEGIN')
      const r2 = await d.dispatch(c2, ctx(), config)
      expect(r2.status).toBe('already_applied')
      await c2.query('COMMIT')
    } finally {
      c2.release()
    }
    const rec = await db().query(`SELECT count(*)::int AS c FROM ${SCRATCH}`)
    expect(Number(rec.rows[0].c)).toBe(1)
  })

  test('a DIFFERENT structuralPath is an independent action (no cross-blocking)', async () => {
    const d = new FwbActionDispatcher(deps())
    const raw = db().getInternalPool()
    const c = await raw.connect()
    try {
      await c.query('BEGIN')
      const r = await d.dispatch(c, ctx({ structuralPath: 'steps[0].actions[1]' }), config)
      expect(r.status).toBe('applied')
      await c.query('COMMIT')
    } finally {
      c.release()
    }
    const rec = await db().query(`SELECT count(*)::int AS c FROM ${SCRATCH}`)
    expect(Number(rec.rows[0].c)).toBe(2)
  })
})
