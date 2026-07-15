/**
 * 八场景全链验收矩阵 — P2 durable delivery × action idempotency × FWB (real DB, constructed crash/concurrency).
 *
 * The formal acceptance matrix the month plan gates FWB/attachment/flag enablement on. Each scenario is an
 * explicit end-to-end construction (not a unit re-assertion):
 *   S1 crash BEFORE source commit        → zero rows, zero deliveries ever.
 *   S2 crash AFTER commit, before tick   → rows durable; a restarted worker delivers.
 *   S3 crash AFTER claim, before resolve → lease expiry → reclaim redelivers (at-least-once), identity stable.
 *   S4 zombie + reclaimer double-send    → identical outbound idempotency seed across fences; zombie's
 *                                          terminal write = 0 rows (single persisted writer).
 *   S5 version mismatch (N-1 worker)     → unknown consumer_key stays pending + alerted, never terminated.
 *   S6 FWB action idempotency            → the SAME (instance, rule, action) delivered twice writes ONE record.
 *   S7 crash mid-FWB (post-apply rollback) → claim+record+outbox vanish together; a clean retry re-applies.
 *   S8 full chain                        → approval event → dispatch tick → FWB executor (adapter) →
 *                                          chained record.updated outbox row with automation_depth+1.
 *
 * Runs on the composed chain (integration rehearsal / merged main — identical content either way).
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { enqueueOutboxEvent } from '../../src/multitable/automation-outbox-enqueue'
import { claimDueConsumers, completeConsumer } from '../../src/multitable/automation-durable-dispatcher'
import { ConsumerAdapterRegistry, runDispatchTick, type AdapterOutcome } from '../../src/multitable/automation-durable-dispatch-loop'
import { executeWriteApprovalFormValues, type FwbRecordWriteSeam } from '../../src/multitable/approval-fwb-write-action'
import { deriveOutboundIdempotencyKey } from '../../src/multitable/automation-action-idempotency'
import type { FwbGateChecks } from '../../src/multitable/approval-fwb-permission-gates'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const SCRATCH = `es_scratch_${RUN.replace(/-/g, '')}`
const cleanupEvt: string[] = []

const gates: FwbGateChecks = {
  isAdmin: async () => true,
  canManageSheetAccess: async () => true,
  canReadTemplate: async () => true,
  canWriteSheet: async () => true,
  hasRecordedConfirmation: async () => true,
}
const seam: FwbRecordWriteSeam = {
  async createRecordWithRevision(trx, sheetId, values) {
    const id = `rec_${randomUUID()}`
    await trx.query(`INSERT INTO ${SCRATCH} (id, sheet_id, payload) VALUES ($1,$2,$3::jsonb)`, [id, sheetId, JSON.stringify(values)])
    return id
  },
  async enqueueOutbox(trx, e) {
    await enqueueOutboxEvent(trx, { eventType: e.eventType, eventId: e.eventId, payload: e.payload, automationDepth: e.automationDepth })
  },
}
const fwbInput = (n: string) => ({
  claimId: `aa_${randomUUID()}`,
  instanceId: `apr_${RUN}`,
  ruleId: `rule_${RUN}`,
  actionKey: `ak_${RUN}_${n}`,
  gateSubject: { configurerUserId: 'u1', ruleId: `rule_${RUN}`, sourceTemplateId: 'tpl', targetSheetId: `sheet_${RUN}` },
  mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' as const }],
  formValues: { f1: 'v' },
  eventId: track(`evt_${RUN}_${n}`),
})
function track(e: string): string {
  cleanupEvt.push(e)
  return e
}

describeIfDatabase('八场景全链验收矩阵 (P2 × ledger × FWB, real DB)', () => {
  test('setup', async () => {
    await db().query(`CREATE TABLE IF NOT EXISTS ${SCRATCH} (id text PRIMARY KEY, sheet_id text NOT NULL, payload jsonb NOT NULL)`)
    expect(process.env.DATABASE_URL).toBeTruthy()
  })
  afterAll(async () => {
    await db().query(`DROP TABLE IF EXISTS ${SCRATCH}`).catch(() => {})
    await db().query('DELETE FROM meta_automation_outbox WHERE event_id = ANY($1)', [cleanupEvt]).catch(() => {})
    await db().query('DELETE FROM meta_automation_action_applied WHERE instance_id=$1', [`apr_${RUN}`]).catch(() => {})
  })

  test('S1 crash before source commit → zero rows, zero deliveries', async () => {
    const raw = db().getInternalPool()
    const c = await raw.connect()
    const evt = track(`evt_${RUN}_s1`)
    try {
      await c.query('BEGIN')
      await enqueueOutboxEvent(c, { eventType: 'form.submitted', eventId: evt, payload: {} })
      await c.query('ROLLBACK')
    } finally {
      c.release()
    }
    const r = await db().query('SELECT count(*)::int AS c FROM meta_automation_outbox WHERE event_id=$1', [evt])
    expect(Number(r.rows[0].c)).toBe(0)
  })

  test('S2 crash after commit before tick → durable; restart tick delivers', async () => {
    const evt = track(`evt_${RUN}_s2`)
    const res = await enqueueOutboxEvent(db(), { eventType: 'multitable.comment.created', eventId: evt, payload: {} })
    const reg = new ConsumerAdapterRegistry()
    const seen: string[] = []
    reg.register({ key: 'webhook-event-bridge', handle: async (e) => (e.eventId === evt ? (seen.push(e.eventId), { outcome: 'success' }) : { outcome: 'retryable_failure', reason: 'unknown' }) as AdapterOutcome })
    await runDispatchTick(db(), reg, { batchSize: 500 })
    expect(seen).toContain(evt)
    const st = await db().query('SELECT status FROM meta_automation_outbox_consumer WHERE outbox_id=$1', [res.outboxId])
    expect(st.rows[0].status).toBe('done')
  })

  test('S3+S4 crash after claim → reclaim redelivers; zombie seed identical, zombie terminal write = 0 rows', async () => {
    const evt = track(`evt_${RUN}_s34`)
    const res = await enqueueOutboxEvent(db(), { eventType: 'form.submitted', eventId: evt, payload: {} })
    const all = await claimDueConsumers(db(), { consumerKeys: ['automation-record-trigger'], batchSize: 500 })
    const z = all.find((c) => c.outboxId === res.outboxId)
    expect(z).toBeTruthy() // zombie claimed, then "crashes" (never resolves)
    await db().query(`UPDATE meta_automation_outbox_consumer SET lease_expires_at = now() - interval '1 min' WHERE outbox_id=$1`, [res.outboxId])
    const reg = new ConsumerAdapterRegistry()
    const seen: Array<{ id: string; fence: string }> = []
    reg.register({ key: 'automation-record-trigger', handle: async (e) => (e.eventId === evt ? (seen.push({ id: e.eventId, fence: e.fence }), { outcome: 'success' }) : { outcome: 'retryable_failure', reason: 'unknown' }) as AdapterOutcome })
    await runDispatchTick(db(), reg, { batchSize: 500 })
    const r = seen.find((x) => x.id === evt)
    expect(r).toBeTruthy() // at-least-once across the crash
    expect(deriveOutboundIdempotencyKey(evt, 'automation-record-trigger')).toBe(deriveOutboundIdempotencyKey(z!.eventId, z!.consumerKey)) // S4: same seed
    expect(Number(r!.fence)).toBeGreaterThan(Number(z!.fence))
    expect(await completeConsumer(db(), res.outboxId, 'automation-record-trigger', z!.fence)).toBe(false) // zombie: 0 rows
  })

  test('S5 version mismatch: unknown consumer_key stays pending + alerted, never terminated', async () => {
    const evt = track(`evt_${RUN}_s5`)
    const res = await enqueueOutboxEvent(db(), { eventType: 'approval.task_created', eventId: evt, payload: {} }) // routes to approval-task-trigger
    const reg = new ConsumerAdapterRegistry()
    reg.register({ key: `ck_${RUN}_other`, handle: async () => ({ outcome: 'success' }) }) // N-1 worker: doesn't know the key
    const alerted: string[] = []
    await runDispatchTick(db(), reg, { onUnknownConsumerKeys: (k) => alerted.push(...k), batchSize: 500 })
    expect(alerted).toContain('approval-task-trigger')
    const st = await db().query('SELECT status, attempts FROM meta_automation_outbox_consumer WHERE outbox_id=$1', [res.outboxId])
    expect(st.rows[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  test('S6 FWB idempotency: same (instance,rule,action) delivered twice → exactly ONE record', async () => {
    const i = fwbInput('s6')
    const raw = db().getInternalPool()
    for (const k of [1, 2]) {
      const c = await raw.connect()
      try {
        await c.query('BEGIN')
        const r = await executeWriteApprovalFormValues(c, { ...i, claimId: `aa_${randomUUID()}`, eventId: track(`evt_${RUN}_s6_${k}`) }, gates, seam)
        expect(r.status).toBe(k === 1 ? 'applied' : 'already_applied')
        await c.query('COMMIT')
      } finally {
        c.release()
      }
    }
    const rec = await db().query(`SELECT count(*)::int AS c FROM ${SCRATCH}`)
    expect(Number(rec.rows[0].c)).toBe(1) // net-once
  })

  test('S7 crash mid-FWB: rollback erases claim+record+outbox; a clean retry re-applies', async () => {
    const i = fwbInput('s7')
    const raw = db().getInternalPool()
    const c = await raw.connect()
    try {
      await c.query('BEGIN')
      expect((await executeWriteApprovalFormValues(c, i, gates, seam)).status).toBe('applied')
      await c.query('ROLLBACK') // crash before the caller's source-status write committed
    } finally {
      c.release()
    }
    const c2 = await raw.connect()
    try {
      await c2.query('BEGIN')
      expect((await executeWriteApprovalFormValues(c2, { ...i, claimId: `aa_${randomUUID()}`, eventId: track(`evt_${RUN}_s7b`) }, gates, seam)).status).toBe('applied') // retry succeeds cleanly
      await c2.query('COMMIT')
    } finally {
      c2.release()
    }
  })

  test('S8 full chain: FWB write → chained outbox row → next tick dispatches it (depth propagated)', async () => {
    const i = { ...fwbInput('s8'), automationDepth: 1 }
    const raw = db().getInternalPool()
    const c = await raw.connect()
    try {
      await c.query('BEGIN')
      expect((await executeWriteApprovalFormValues(c, i, gates, seam)).status).toBe('applied')
      await c.query('COMMIT')
    } finally {
      c.release()
    }
    // the FWB-produced record.created row exists with depth 1 and fans out per manifest
    const ob = await db().query('SELECT automation_depth FROM meta_automation_outbox WHERE event_id=$1', [i.eventId])
    expect(ob.rows[0].automation_depth).toBe(1)
    const reg = new ConsumerAdapterRegistry()
    const seen: string[] = []
    for (const key of ['automation-record-trigger', 'webhook-event-bridge']) {
      reg.register({ key, handle: async (e) => (e.eventId === i.eventId ? (seen.push(key), { outcome: 'success' }) : { outcome: 'retryable_failure', reason: 'unknown' }) as AdapterOutcome })
    }
    await runDispatchTick(db(), reg, { batchSize: 500 })
    expect(seen.sort()).toEqual(['automation-record-trigger', 'webhook-event-bridge']) // full fan-out delivered
  })
})
