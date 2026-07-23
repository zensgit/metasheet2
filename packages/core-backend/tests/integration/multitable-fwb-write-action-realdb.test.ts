/**
 * FWB-1 slice ③ — write_approval_form_values executor, SAME-TRANSACTION composition (real DB).
 *
 * Proves the D9/D10 contract with a scratch record table standing in for the record-service seam:
 *   - applied: claim + record + outbox rows ALL committed together (flag ON env);
 *   - duplicate: a second run returns 'already_applied' and writes NOTHING new;
 *   - gate-fail / mapping-fail: 'rejected' BEFORE the claim (no ledger row);
 *   - crash inside the txn AFTER claim+record (seam of the caller's own record write throws later /
 *     rollback): claim, record AND outbox rows all vanish together — the atomicity proof.
 *
 * Two-point wired (plugin-tests.yml + vitest.config.ts exclude).
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { executeWriteApprovalFormValues, type FwbRecordWriteSeam, type FwbWriteActionInput } from '../../src/multitable/approval-fwb-write-action'
import type { FwbGateChecks } from '../../src/multitable/approval-fwb-permission-gates'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const SCRATCH = `fwb_scratch_${RUN.replace(/-/g, '')}`

const gatesAll = (ok = true): FwbGateChecks => ({
  isAdmin: async () => ok,
  canManageSheetAccess: async () => ok,
  canReadTemplate: async () => ok,
  canWriteSheet: async () => ok,
  canWriteTargetFields: async () => ok,
  hasRecordedConfirmation: async () => ok,
})
const seam: FwbRecordWriteSeam = {
  async createRecordWithRevision(trx, sheetId, values) {
    const id = `rec_${randomUUID()}`
    await trx.query(`INSERT INTO ${SCRATCH} (id, sheet_id, payload) VALUES ($1,$2,$3::jsonb)`, [id, sheetId, JSON.stringify(values)])
    return id
  },
  async enqueueOutbox(trx, e) {
    await trx.query(
      `INSERT INTO meta_automation_outbox (id, event_type, payload, automation_depth, manifest_version, event_id)
       VALUES ($1,$2,$3::jsonb,$4,1,$5)`,
      [`obx_${randomUUID()}`, e.eventType, JSON.stringify(e.payload), e.automationDepth, e.eventId],
    )
  },
}
const input = (over: Partial<FwbWriteActionInput> = {}): FwbWriteActionInput => ({
  claimId: `aa_${randomUUID()}`,
  instanceId: `apr_${RUN}`,
  ruleId: `rule_${RUN}`,
  actionKey: `ak_${RUN}_1`,
  gateSubject: { configurerUserId: 'u1', ruleId: `rule_${RUN}`, actionKey: `ak_${RUN}_1`, sourceTemplateId: 'tpl', targetSheetId: `sheet_${RUN}` },
  mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
  formValues: { f1: 'hello' },
  eventId: `evt_${RUN}_${randomUUID().slice(0, 8)}`,
  ...over,
})

async function counts(eventId: string) {
  const rec = await db().query(`SELECT count(*)::int AS c FROM ${SCRATCH}`)
  const led = await db().query('SELECT count(*)::int AS c FROM meta_fwb_action_applied WHERE instance_id=$1', [`apr_${RUN}`])
  const obx = await db().query('SELECT count(*)::int AS c FROM meta_automation_outbox WHERE event_id=$1', [eventId])
  return { rec: Number(rec.rows[0].c), led: Number(led.rows[0].c), obx: Number(obx.rows[0].c) }
}

describeIfDatabase('FWB-1 slice ③ — same-transaction write action (real DB)', () => {
  beforeAll(async () => {
    await db().query(`CREATE TABLE IF NOT EXISTS ${SCRATCH} (id text PRIMARY KEY, sheet_id text NOT NULL, payload jsonb NOT NULL)`)
  })
  afterAll(async () => {
    await db().query(`DROP TABLE IF EXISTS ${SCRATCH}`).catch(() => {})
    await db().query('DELETE FROM meta_fwb_action_applied WHERE instance_id=$1', [`apr_${RUN}`]).catch(() => {})
    await db().query(`DELETE FROM meta_automation_outbox WHERE event_id LIKE $1`, [`evt_${RUN}%`]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('applied: claim + record + outbox commit TOGETHER; duplicate rerun writes nothing new', async () => {
    const raw = db().getInternalPool()
    const c = await raw.connect()
    const i = input()
    try {
      await c.query('BEGIN')
      const r = await executeWriteApprovalFormValues(c, i, gatesAll(), seam)
      expect(r.status).toBe('applied')
      await c.query('COMMIT')
    } finally {
      c.release()
    }
    expect(await counts(i.eventId)).toEqual({ rec: 1, led: 1, obx: 1 })
    // duplicate: same identity → already_applied, nothing new (different eventId to isolate the outbox count)
    const c2 = await raw.connect()
    try {
      await c2.query('BEGIN')
      const r2 = await executeWriteApprovalFormValues(c2, { ...i, claimId: `aa_${randomUUID()}`, eventId: `evt_${RUN}_dup` }, gatesAll(), seam)
      expect(r2.status).toBe('already_applied')
      await c2.query('COMMIT')
    } finally {
      c2.release()
    }
    expect(await counts(`evt_${RUN}_dup`)).toEqual({ rec: 1, led: 1, obx: 0 }) // no new record/claim/outbox
  })

  test('gate-fail and mapping-fail reject BEFORE the claim (no ledger row, nothing written)', async () => {
    const iGate = input({ actionKey: `ak_${RUN}_g` })
    const r1 = await executeWriteApprovalFormValues(db(), iGate, gatesAll(false), seam)
    expect(r1).toMatchObject({ status: 'rejected', reason: 'permission_gates' })
    const iMap = input({ actionKey: `ak_${RUN}_m`, formValues: { f1: { bad: true } } })
    const r2 = await executeWriteApprovalFormValues(db(), iMap, gatesAll(), seam)
    expect(r2).toMatchObject({ status: 'rejected', reason: 'mapping' })
    const led = await db().query('SELECT count(*)::int AS c FROM meta_fwb_action_applied WHERE action_key = ANY($1)', [[`ak_${RUN}_g`, `ak_${RUN}_m`]])
    expect(Number(led.rows[0].c)).toBe(0)
  })

  test('ATOMICITY: rollback after a successful execute erases claim + record + outbox together', async () => {
    const raw = db().getInternalPool()
    const c = await raw.connect()
    const i = input({ actionKey: `ak_${RUN}_atomic`, eventId: `evt_${RUN}_atomic` })
    try {
      await c.query('BEGIN')
      const r = await executeWriteApprovalFormValues(c, i, gatesAll(), seam)
      expect(r.status).toBe('applied')
      await c.query('ROLLBACK') // a later failure in the caller's txn (e.g. the source status write)
    } finally {
      c.release()
    }
    const led = await db().query('SELECT count(*)::int AS c FROM meta_fwb_action_applied WHERE action_key=$1', [`ak_${RUN}_atomic`])
    expect(Number(led.rows[0].c)).toBe(0)
    expect((await counts(`evt_${RUN}_atomic`)).obx).toBe(0)
  })
})
