/**
 * P2 durable-delivery — S4-b/S5 activation seam + S7 crash-injection V-series (real DB).
 *
 * Activation (flag semantics — the byte-neutral proof):
 *   - flag OFF: produceAutomationEvent → null + ZERO rows; bootDurableDelivery → null (no registry, no loop);
 *   - missing handler → boot throws before any claim; incomplete registry → completeness assertion throws;
 *   - flag ON: produce inside a txn → boot → loop drains the fan-out; PermanentDeliveryFailure → dead_letter.
 *
 * Crash-injection V-series (crash = "no further calls from that worker" + lease expiry — the same observable
 * a killed process leaves):
 *   V1 produce-then-crash-BEFORE-commit  → ROLLBACK: zero rows, zero deliveries (nothing phantom).
 *   V2 commit-then-crash-before-dispatch → rows durable; a later tick ("restarted worker") delivers.
 *   V3 crash-after-claim                 → lease expiry → reclaim redelivers: at-least-once, and the handler
 *                                          sees the SAME stable eventId on every delivery (fence-free identity).
 *   V4 zombie + reclaimer both live      → both sides can reach "send"; the outbound idempotency SEED
 *                                          (eventId + consumer_key) is IDENTICAL across fences (#4203 §340 —
 *                                          the endpoint dedups), and the zombie's terminal write hits 0 rows.
 *
 * Uses the real manifest consumer keys; adapters defensively skip rows not seeded by this file (shared CI DB).
 * Two-point wired (plugin-tests.yml + vitest.config.ts exclude).
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  bootDurableDelivery,
  buildConsumerAdapterRegistry,
  DURABLE_CONSUMER_KEYS,
  PermanentDeliveryFailure,
  produceAutomationEvent,
  type DurableConsumerHandlers,
} from '../../src/multitable/automation-durable-activation'
import { claimDueConsumers, completeConsumer, type ClaimedConsumer } from '../../src/multitable/automation-durable-dispatcher'
import { runDispatchTick, type DispatchLoopObserver } from '../../src/multitable/automation-durable-dispatch-loop'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'
import type { OutboxEventInput } from '../../src/multitable/automation-outbox-enqueue'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const FLAG_ON = { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv
const FLAG_OFF = {} as NodeJS.ProcessEnv
const enqueued: string[] = []
/** Required telemetry sink (boot now demands one, per the loop's observability doctrine). */
const noopObserver: DispatchLoopObserver = {
  onUnknownConsumerKeys: () => {},
  onTickError: () => {},
  onHeartbeatError: () => {},
  onClaimTimePoison: () => {},
}
/** Produce inside a REAL committed transaction (the enqueue txn probe requires one) and return the result. */
async function produceCommitted(input: OutboxEventInput, env: NodeJS.ProcessEnv) {
  const client = await db().getInternalPool().connect()
  try {
    await client.query('BEGIN')
    const trx: TransactionalQueryable = { isTransaction: true, query: (sql, params) => client.query(sql, params) }
    const res = await produceAutomationEvent(trx, input, env)
    await client.query('COMMIT')
    return res
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// Handlers that record deliveries for OUR rows and defensively re-throw for foreign rows (retryable → left
// reclaimable for whichever suite owns them; never terminated by us).
function recordingHandlers(seen: Array<{ key: string; eventId: string; fence: string }>, opts: { failBridgePermanently?: boolean } = {}): DurableConsumerHandlers {
  const make = (key: string) => async (e: ClaimedConsumer) => {
    if (!e.eventId.includes(RUN)) throw new Error('foreign row — not ours, stay reclaimable')
    seen.push({ key, eventId: e.eventId, fence: e.fence })
    if (opts.failBridgePermanently && key === 'approval-bridge') throw new PermanentDeliveryFailure('ratified permanent rejection')
  }
  return Object.fromEntries(DURABLE_CONSUMER_KEYS.map((k) => [k, make(k)])) as unknown as DurableConsumerHandlers
}

async function consumerStatuses(outboxId: string) {
  const { rows } = await db().query(
    'SELECT consumer_key, status FROM meta_automation_outbox_consumer WHERE outbox_id=$1',
    [outboxId],
  )
  return Object.fromEntries((rows as Array<{ consumer_key: string; status: string }>).map((r) => [r.consumer_key, r.status]))
}

describeIfDatabase('P2 durable-delivery S4-b/S5 activation + S7 crash-injection (real DB)', () => {
  afterAll(async () => {
    if (enqueued.length) {
      await db().query('DELETE FROM meta_automation_outbox WHERE id = ANY($1)', [enqueued]).catch(() => {})
    }
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('flag OFF is byte-neutral: produce → null + zero rows; boot → null (no loop, no reads)', async () => {
    const before = await db().query('SELECT count(*)::int AS c FROM meta_automation_outbox')
    const res = await produceAutomationEvent(db() as unknown as TransactionalQueryable, { eventType: 'approval.approved', eventId: `evt_${RUN}_off`, payload: {} }, FLAG_OFF)
    expect(res).toBeNull()
    const after = await db().query('SELECT count(*)::int AS c FROM meta_automation_outbox')
    expect(Number(after.rows[0].c)).toBe(Number(before.rows[0].c)) // nothing written
    expect(bootDurableDelivery(db(), recordingHandlers([]), noopObserver, { env: FLAG_OFF })).toBeNull()
  })

  test('boot fails loudly on a missing handler (before any claim)', () => {
    const handlers = recordingHandlers([]) as Record<string, unknown>
    delete handlers['approval-projection']
    expect(() => bootDurableDelivery(db(), handlers as unknown as DurableConsumerHandlers, noopObserver, { env: FLAG_ON })).toThrow(/missing handler.*approval-projection/)
  })

  test('registry from handlers passes the bidirectional manifest completeness assertion', () => {
    const registry = buildConsumerAdapterRegistry(recordingHandlers([]))
    expect(registry.keys().sort()).toEqual([...DURABLE_CONSUMER_KEYS].sort())
  })

  test('flag ON end-to-end: produce (in txn) → boot → loop drains the fan-out; permanent failure → dead_letter', async () => {
    const raw = db().getInternalPool()
    const client = await raw.connect()
    let outboxId = ''
    try {
      await client.query('BEGIN')
      const res = await produceAutomationEvent({ isTransaction: true, query: (s, p) => client.query(s, p) }, { eventType: 'approval.approved', eventId: `evt_${RUN}_e2e`, payload: { i: 1 } }, FLAG_ON)
      outboxId = res!.outboxId
      enqueued.push(outboxId)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const seen: Array<{ key: string; eventId: string; fence: string }> = []
    const handle = bootDurableDelivery(db(), recordingHandlers(seen, { failBridgePermanently: true }), noopObserver, {
      env: FLAG_ON,
      intervalMs: 100,
      batchSize: 500,
    })
    expect(handle).toBeTruthy()
    try {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        const s = await consumerStatuses(outboxId)
        if (s['approval-trigger'] === 'done' && s['approval-projection'] === 'done' && s['approval-bridge'] === 'dead_letter') break
        await new Promise((r) => setTimeout(r, 100))
      }
    } finally {
      await handle!.stop()
    }
    const s = await consumerStatuses(outboxId)
    expect(s['approval-trigger']).toBe('done')
    expect(s['approval-projection']).toBe('done')
    expect(s['approval-bridge']).toBe('dead_letter') // PermanentDeliveryFailure → poison
    expect(seen.every((x) => x.eventId === `evt_${RUN}_e2e`)).toBe(true) // stable original identity delivered
  }, 15_000)

  test('V1: produce-then-crash-BEFORE-commit → zero rows, zero deliveries', async () => {
    const raw = db().getInternalPool()
    const client = await raw.connect()
    let outboxId = ''
    try {
      await client.query('BEGIN')
      const res = await produceAutomationEvent({ isTransaction: true, query: (s, p) => client.query(s, p) }, { eventType: 'form.submitted', eventId: `evt_${RUN}_v1`, payload: {} }, FLAG_ON)
      outboxId = res!.outboxId
      await client.query('ROLLBACK') // crash before commit
    } finally {
      client.release()
    }
    const { rows } = await db().query('SELECT count(*)::int AS c FROM meta_automation_outbox WHERE id=$1', [outboxId])
    expect(Number(rows[0].c)).toBe(0)
  })

  test('V2: commit-then-crash-before-dispatch → rows are durable; a later tick (restart) delivers', async () => {
    const res = await produceCommitted({ eventType: 'multitable.comment.created', eventId: `evt_${RUN}_v2`, payload: {} }, FLAG_ON)
    enqueued.push(res!.outboxId)
    // "crash": no dispatcher runs. Rows sit durable & pending:
    expect(await consumerStatuses(res!.outboxId)).toEqual({ 'webhook-event-bridge': 'pending' })
    // "restart": a fresh tick delivers.
    const seen: Array<{ key: string; eventId: string; fence: string }> = []
    await runDispatchTick(db(), buildConsumerAdapterRegistry(recordingHandlers(seen)), { batchSize: 500 })
    expect(await consumerStatuses(res!.outboxId)).toEqual({ 'webhook-event-bridge': 'done' })
    expect(seen.some((x) => x.eventId === `evt_${RUN}_v2`)).toBe(true)
  })

  test('V3: crash-after-claim → reclaim redelivers (at-least-once) with the SAME stable eventId across fences', async () => {
    const res = await produceCommitted({ eventType: 'form.submitted', eventId: `evt_${RUN}_v3`, payload: {} }, FLAG_ON)
    enqueued.push(res!.outboxId)
    // worker A claims and "crashes" (never resolves)
    const [a] = await claimDueConsumers(db(), { consumerKeys: ['automation-record-trigger'], batchSize: 500 })
    const mine = a && a.outboxId === res!.outboxId ? a : (await claimDueConsumers(db(), { consumerKeys: ['automation-record-trigger'], batchSize: 500 })).find((c) => c.outboxId === res!.outboxId)
    expect(mine?.eventId).toBe(`evt_${RUN}_v3`)
    await db().query(`UPDATE meta_automation_outbox_consumer SET lease_expires_at = now() - interval '1 min' WHERE outbox_id=$1`, [res!.outboxId])
    // worker B (restart) redelivers through the loop
    const seen: Array<{ key: string; eventId: string; fence: string }> = []
    await runDispatchTick(db(), buildConsumerAdapterRegistry(recordingHandlers(seen)), { batchSize: 500 })
    const delivered = seen.find((x) => x.eventId === `evt_${RUN}_v3`)
    expect(delivered).toBeTruthy() // at-least-once survived the crash
    expect(delivered!.eventId).toBe(mine!.eventId) // identity is fence-free — same dedup/idempotency seed
    expect(Number(delivered!.fence)).toBeGreaterThan(Number(mine!.fence)) // genuinely a different claim epoch
  })

  test('V4: zombie + reclaimer both reach send → identical idempotency SEED across fences; zombie terminal write = 0 rows', async () => {
    const res = await produceCommitted({ eventType: 'multitable.record.updated', eventId: `evt_${RUN}_v4`, payload: {} }, FLAG_ON)
    enqueued.push(res!.outboxId)
    // zombie Z claims (fence F1) and stalls past its lease — but stays alive
    const zAll = await claimDueConsumers(db(), { consumerKeys: ['automation-record-trigger', 'webhook-event-bridge'], batchSize: 500 })
    const z = zAll.find((c) => c.outboxId === res!.outboxId && c.consumerKey === 'automation-record-trigger')
    expect(z).toBeTruthy()
    const zombieSendKeySeed = `${z!.eventId}::${z!.consumerKey}` // the lock's outbound key basis: stable event+action identity, NO fence/attempt
    await db().query(
      `UPDATE meta_automation_outbox_consumer SET lease_expires_at = now() - interval '1 min' WHERE outbox_id=$1 AND consumer_key='automation-record-trigger'`,
      [res!.outboxId],
    )
    // reclaimer R delivers (fence F2) — R's send uses ITS row's identity
    const seen: Array<{ key: string; eventId: string; fence: string }> = []
    await runDispatchTick(db(), buildConsumerAdapterRegistry(recordingHandlers(seen)), { batchSize: 500 })
    const r = seen.find((x) => x.eventId === `evt_${RUN}_v4` && x.key === 'automation-record-trigger')
    expect(r).toBeTruthy()
    const reclaimerSendKeySeed = `${r!.eventId}::${r!.key}`
    expect(reclaimerSendKeySeed).toBe(zombieSendKeySeed) // SAME key at the endpoint → double send collapses to one effect
    expect(Number(r!.fence)).toBeGreaterThan(Number(z!.fence)) // and they really were different claim epochs
    // the zombie finally tries to write its terminal state: fence-CAS → 0 rows (single-writer persisted state)
    expect(await completeConsumer(db(), res!.outboxId, 'automation-record-trigger', z!.fence)).toBe(false)
  })
})
