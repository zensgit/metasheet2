/**
 * P2 durable-delivery — slice S4-a: producer-side atomic enqueue (real DB).
 *
 * The load-bearing proof is ATOMICITY: enqueue happens inside the caller's transaction, so ROLLBACK leaves
 * ZERO outbox/consumer rows (a crash before commit loses nothing), and COMMIT persists the outbox row plus
 * the manifest-expanded consumer fan-out. Also proves: unrouted event type / blank identity / bad depth are
 * hard errors; manifest_version is stamped; and the enqueued fan-out flows through the S2-b dispatch tick
 * with PER-CONSUMER independence (one consumer's failure never blocks the siblings' `done`).
 *
 * Two-point wired (plugin-tests.yml + vitest.config.ts exclude) so it cannot skip-green.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { enqueueOutboxEvent } from '../../src/multitable/automation-outbox-enqueue'
import { ConsumerAdapterRegistry, runDispatchTick, type AdapterOutcome } from '../../src/multitable/automation-durable-dispatch-loop'
import { APPROVAL_COMPLETION_CONSUMERS } from '../../src/multitable/automation-routing-manifest'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const enqueued: string[] = []

async function rowsFor(outboxId: string) {
  const outbox = await db().query('SELECT event_type, event_id, manifest_version, automation_depth FROM meta_automation_outbox WHERE id=$1', [outboxId])
  const consumers = await db().query(
    'SELECT consumer_key, status FROM meta_automation_outbox_consumer WHERE outbox_id=$1 ORDER BY consumer_key',
    [outboxId],
  )
  return { outbox: outbox.rows, consumers: consumers.rows as Array<{ consumer_key: string; status: string }> }
}

describeIfDatabase('P2 durable-delivery S4-a — producer atomic enqueue (real DB)', () => {
  afterAll(async () => {
    if (enqueued.length) {
      await db().query('DELETE FROM meta_automation_outbox WHERE id = ANY($1)', [enqueued]).catch(() => {})
    }
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('COMMIT persists the outbox row + the exact manifest fan-out (approval family → 3 consumers)', async () => {
    const raw = db().getInternalPool()
    const client = await raw.connect()
    let outboxId = ''
    try {
      await client.query('BEGIN')
      const res = await enqueueOutboxEvent(client, {
        eventType: 'approval.approved',
        eventId: `evt_${RUN}_commit`,
        payload: { instanceId: 'apr_1' },
        automationDepth: 2,
      })
      outboxId = res.outboxId
      enqueued.push(outboxId)
      await client.query('COMMIT')
      expect(res.consumerKeys).toEqual([...APPROVAL_COMPLETION_CONSUMERS])
      expect(res.manifestVersion).toBe(1)
    } finally {
      client.release()
    }
    const { outbox, consumers } = await rowsFor(outboxId)
    expect(outbox[0]).toMatchObject({ event_type: 'approval.approved', event_id: `evt_${RUN}_commit`, manifest_version: 1, automation_depth: 2 })
    expect(consumers.map((c) => c.consumer_key).sort()).toEqual([...APPROVAL_COMPLETION_CONSUMERS].sort())
    expect(consumers.every((c) => c.status === 'pending')).toBe(true)
  })

  test('ATOMICITY: ROLLBACK leaves zero outbox and zero consumer rows (crash-before-commit loses nothing)', async () => {
    const raw = db().getInternalPool()
    const client = await raw.connect()
    let outboxId = ''
    try {
      await client.query('BEGIN')
      const res = await enqueueOutboxEvent(client, {
        eventType: 'form.submitted',
        eventId: `evt_${RUN}_rollback`,
        payload: {},
      })
      outboxId = res.outboxId
      // rows are visible INSIDE the txn (same client)...
      const inside = await client.query('SELECT count(*)::int AS c FROM meta_automation_outbox WHERE id=$1', [outboxId])
      expect(Number(inside.rows[0].c)).toBe(1)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    // ...and completely gone after ROLLBACK — both tables.
    const { outbox, consumers } = await rowsFor(outboxId)
    expect(outbox).toHaveLength(0)
    expect(consumers).toHaveLength(0)
  })

  test('an unrouted event type is a HARD error and aborts the enclosing work (no half-enqueue)', async () => {
    await expect(
      enqueueOutboxEvent(db(), { eventType: 'not.a.real.family', eventId: `evt_${RUN}_x`, payload: {} }),
    ).rejects.toThrow(/not routed by manifest v1/)
  })

  test('identity/depth validation is a boundary error: blank eventId and bad depth throw before any SQL', async () => {
    await expect(enqueueOutboxEvent(db(), { eventType: 'form.submitted', eventId: '   ', payload: {} })).rejects.toThrow(/non-blank identity/)
    await expect(enqueueOutboxEvent(db(), { eventType: 'form.submitted', eventId: ' ﻿', payload: {} })).rejects.toThrow(/non-blank identity/)
    await expect(
      enqueueOutboxEvent(db(), { eventType: 'form.submitted', eventId: `evt_${RUN}_d`, payload: {}, automationDepth: -1 }),
    ).rejects.toThrow(/automationDepth/)
    await expect(
      enqueueOutboxEvent(db(), { eventType: 'form.submitted', eventId: `evt_${RUN}_d2`, payload: {}, automationDepth: 1.5 }),
    ).rejects.toThrow(/automationDepth/)
  })

  test('end-to-end: enqueued fan-out drains through the dispatch tick with PER-CONSUMER independence', async () => {
    // Real manifest keys collide with parallel suites on the shared CI DB, so claim via a snapshot of
    // this event's rows only: seed → tick with a registry serving the three approval consumers where
    // approval-bridge fails transiently — its siblings still complete independently.
    const res = await enqueueOutboxEvent(db(), {
      eventType: 'approval.rejected',
      eventId: `evt_${RUN}_e2e`,
      payload: { instanceId: 'apr_e2e' },
    })
    enqueued.push(res.outboxId)
    const registry = new ConsumerAdapterRegistry()
    const handled: string[] = []
    for (const key of APPROVAL_COMPLETION_CONSUMERS) {
      registry.register({
        key,
        async handle(e): Promise<AdapterOutcome> {
          if (e.outboxId !== res.outboxId) return { outcome: 'retryable_failure', reason: 'unknown' } // not ours: leave for the owning suite
          handled.push(key)
          return key === 'approval-bridge'
            ? { outcome: 'retryable_failure', reason: 'adapter_error' }
            : { outcome: 'success' }
        },
      })
    }
    // ticks: batch big enough to include our three rows even if siblings' rows are pending on the shared DB
    await runDispatchTick(db(), registry, { batchSize: 500 })
    const { consumers } = await rowsFor(res.outboxId)
    const byKey = Object.fromEntries(consumers.map((c) => [c.consumer_key, c.status]))
    expect(byKey['approval-trigger']).toBe('done')
    expect(byKey['approval-projection']).toBe('done')
    expect(byKey['approval-bridge']).toBe('in_progress') // rescheduled with backoff — independent of siblings
    expect(handled.sort()).toEqual([...APPROVAL_COMPLETION_CONSUMERS].sort())
  })
})
