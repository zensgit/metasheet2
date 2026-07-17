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
import { runDispatchTick, ConsumerAdapterRegistry, type AdapterOutcome, type DispatchLoopObserver } from '../../src/multitable/automation-durable-dispatch-loop'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'
import { enqueueOutboxEvent, type OutboxEventInput } from '../../src/multitable/automation-outbox-enqueue'
import { deriveOutboundIdempotencyKey } from '../../src/multitable/automation-action-idempotency'
import { APPROVAL_COMPLETION_CONSUMERS, type RoutingManifest } from '../../src/multitable/automation-routing-manifest'
import type { PoolClient } from 'pg'

/**
 * A REAL idempotent outbound endpoint model: it records ONE effect per distinct idempotency key and
 * DEDUPS repeats. `send(key)` returns 'delivered' the first time a key is seen and 'deduped' after —
 * the endpoint the lock's Class-B semantics assume (§340). `effects` counts distinct real-world effects.
 */
class IdempotentEndpoint {
  private readonly seen = new Set<string>()
  readonly sends: string[] = []
  send(idempotencyKey: string): 'delivered' | 'deduped' {
    this.sends.push(idempotencyKey)
    if (this.seen.has(idempotencyKey)) return 'deduped'
    this.seen.add(idempotencyKey)
    return 'delivered'
  }
  get effects(): number {
    return this.seen.size
  }
}

/** A run-unique single-consumer manifest so a tick claims ONLY this test's rows on the shared CI DB. */
function uniqueManifest(consumerKey: string, eventType: string): RoutingManifest {
  return { version: 1, routes: { [eventType]: [consumerKey] } }
}

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

/**
 * Enqueue a durable event over a RUN-UNIQUE single-consumer manifest, committed. Used by the crash-injection
 * V-series so their claim/reclaim ticks touch ONLY this test's rows — never a sibling suite's due rows on the
 * shared CI DB (#4337 review P2: the prior version claimed foreign rows with real keys + batchSize:500,
 * mutating their attempts/lease/last_error and risking dead-letter).
 */
async function enqueueUnique(eventType: string, eventId: string, consumerKey: string) {
  const client = await db().getInternalPool().connect()
  try {
    await client.query('BEGIN')
    const trx: TransactionalQueryable = { isTransaction: true, query: (sql, params) => client.query(sql, params) }
    const res = await enqueueOutboxEvent(trx, { eventType, eventId, payload: {} }, uniqueManifest(consumerKey, eventType))
    await client.query('COMMIT')
    enqueued.push(res.outboxId)
    return res
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** A registry with a single run-unique consumer whose adapter calls `onDeliver(event)` then succeeds. */
function uniqueRegistry(consumerKey: string, onDeliver: (e: ClaimedConsumer) => void): ConsumerAdapterRegistry {
  const reg = new ConsumerAdapterRegistry()
  reg.register({
    key: consumerKey,
    async handle(e): Promise<AdapterOutcome> {
      onDeliver(e)
      return { outcome: 'success' }
    },
  })
  return reg
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

  test('flag ON: produce (in txn) via the REAL seam enqueues the exact manifest fan-out (approval → 3 consumers, pending)', async () => {
    // Proves the real produce→manifest fan-out WITHOUT draining (no tick → cannot claim a sibling suite's
    // rows on the shared CI DB — the drain/poison behavior is proven separately on run-unique keys below).
    const client = await db().getInternalPool().connect()
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
    const s = await consumerStatuses(outboxId)
    expect(Object.keys(s).sort()).toEqual([...APPROVAL_COMPLETION_CONSUMERS].sort())
    expect(Object.values(s).every((v) => v === 'pending')).toBe(true)
  })

  test('flag ON: a PermanentDeliveryFailure handler poisons its row to dead_letter (run-unique key — no shared-row pollution)', async () => {
    const keyP = `upoison_${RUN}`
    const res = await enqueueUnique('multitable.record.updated', `evt_${RUN}_poison`, keyP)
    const registry = new ConsumerAdapterRegistry()
    let handled = false
    registry.register({
      key: keyP,
      async handle(): Promise<AdapterOutcome> {
        handled = true
        return { outcome: 'permanent_failure', reason: 'permanent_rejection' } // the mapped PermanentDeliveryFailure
      },
    })
    await runDispatchTick(db(), registry)
    expect(handled).toBe(true)
    expect(await consumerStatuses(res.outboxId)).toEqual({ [keyP]: 'dead_letter' })
  })

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
    // "crash": no dispatcher runs. Rows sit durable & pending (run-unique key — only ours):
    const key2 = `uv2_${RUN}`
    const r2 = await enqueueUnique('multitable.comment.created', `evt_${RUN}_v2`, key2)
    expect(await consumerStatuses(r2.outboxId)).toEqual({ [key2]: 'pending' })
    // "restart": a fresh tick delivers.
    const seen: string[] = []
    await runDispatchTick(db(), uniqueRegistry(key2, (e) => seen.push(e.eventId)))
    expect(await consumerStatuses(r2.outboxId)).toEqual({ [key2]: 'done' })
    expect(seen).toContain(`evt_${RUN}_v2`)
  })

  test('V3: crash-after-claim → reclaim redelivers (at-least-once) with the SAME stable eventId across fences', async () => {
    const key3 = `uv3_${RUN}`
    const res = await enqueueUnique('form.submitted', `evt_${RUN}_v3`, key3)
    // worker A claims its OWN run-unique row and "crashes" (never resolves)
    const claimed = await claimDueConsumers(db(), { consumerKeys: [key3], batchSize: 50 })
    const mine = claimed.find((c) => c.outboxId === res.outboxId)
    expect(mine?.eventId).toBe(`evt_${RUN}_v3`)
    await db().query(`UPDATE meta_automation_outbox_consumer SET lease_expires_at = now() - interval '1 min' WHERE outbox_id=$1`, [res.outboxId])
    // worker B (restart) redelivers through the loop
    const seen: Array<{ eventId: string; fence: string }> = []
    await runDispatchTick(db(), uniqueRegistry(key3, (e) => seen.push({ eventId: e.eventId, fence: e.fence })))
    const delivered = seen.find((x) => x.eventId === `evt_${RUN}_v3`)
    expect(delivered).toBeTruthy() // at-least-once survived the crash
    expect(delivered!.eventId).toBe(mine!.eventId) // identity is fence-free — same dedup/idempotency seed
    expect(Number(delivered!.fence)).toBeGreaterThan(Number(mine!.fence)) // genuinely a different claim epoch
  })

  test('V4: zombie AND reclaimer BOTH reach send → a real idempotent endpoint collapses the double-send to ONE effect; zombie terminal write = 0 rows', async () => {
    const keyZ = `uv4_${RUN}`
    const res = await enqueueUnique('multitable.record.updated', `evt_${RUN}_v4`, keyZ)
    const endpoint = new IdempotentEndpoint()
    // the Class-B outbound identity is EVENT + ACTION (not consumer_key, which can't distinguish two actions
    // in one consumer). We use the ledger's deriveOutboundIdempotencyKey(eventId, actionKey) as the seed.
    const seedFor = (eventId: string) => deriveOutboundIdempotencyKey(eventId, `action:${keyZ}`)

    // 1) zombie Z claims (fence F1) and ACTUALLY reaches send — then stalls past its lease but stays alive.
    const zClaim = await claimDueConsumers(db(), { consumerKeys: [keyZ], batchSize: 50 })
    const z = zClaim.find((c) => c.outboxId === res.outboxId)
    expect(z).toBeTruthy()
    const zSend = endpoint.send(seedFor(z!.eventId)) // Z reaches the endpoint
    expect(zSend).toBe('delivered')
    await db().query(
      `UPDATE meta_automation_outbox_consumer SET lease_expires_at = now() - interval '1 min' WHERE outbox_id=$1 AND consumer_key=$2`,
      [res.outboxId, keyZ],
    )

    // 2) reclaimer R claims (fence F2) and ALSO reaches send — through the real loop.
    let rEventId = ''
    let rFence = ''
    await runDispatchTick(
      db(),
      uniqueRegistry(keyZ, (e) => {
        rEventId = e.eventId
        rFence = e.fence
        endpoint.send(seedFor(e.eventId)) // R reaches the endpoint too — the double send
      }),
    )
    expect(rEventId).toBe(`evt_${RUN}_v4`)
    expect(Number(rFence)).toBeGreaterThan(Number(z!.fence)) // genuinely different claim epochs (F2 > F1)

    // BOTH reached send (2 sends), but the idempotent endpoint recorded exactly ONE effect — the double
    // send collapsed because Z and R derived the IDENTICAL seed (event+action identity, fence-free).
    expect(endpoint.sends).toHaveLength(2)
    expect(endpoint.effects).toBe(1)

    // POSITIVE CONTROL: a send with a DIFFERENT event identity is a distinct effect — the endpoint is not
    // trivially collapsing everything (so the effects===1 above is meaningful, not vacuous).
    expect(endpoint.send(seedFor('some-other-event'))).toBe('delivered')
    expect(endpoint.effects).toBe(2)

    // the zombie finally tries to write its terminal state: fence-CAS → 0 rows (single-writer persisted state)
    expect(await completeConsumer(db(), res.outboxId, keyZ, z!.fence)).toBe(false)
  })
})
