/**
 * P2 durable-delivery — slice S4-a: producer-side atomic enqueue (real DB).
 *
 * The load-bearing proof is ATOMICITY: enqueue happens inside the caller's transaction, so ROLLBACK leaves
 * ZERO outbox/consumer rows (a crash before commit loses nothing), and COMMIT persists the outbox row plus
 * the manifest-expanded consumer fan-out. Atomicity is MACHINE-ENFORCED against the DATABASE's own transaction
 * state (pg_current_xact_id probe — a pool, an autocommit client, and a FORGED isTransaction marker all fail),
 * so the outbox-committed / consumer-failed orphan is impossible by construction (#4336 review P1).
 * Also proves: unrouted event type / blank identity / bad depth are hard errors; manifest_version is stamped;
 * and the enqueued fan-out flows through the S2-b dispatch tick with PER-CONSUMER independence — over a
 * RUN-UNIQUE manifest so it claims only THIS test's rows on the shared CI DB (#4336 review P2).
 *
 * Two-point wired (plugin-tests.yml + vitest.config.ts exclude) so it cannot skip-green.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { enqueueOutboxEvent, type TransactionalQueryable } from '../../src/multitable/automation-outbox-enqueue'
import { ConsumerAdapterRegistry, runDispatchTick, type AdapterOutcome } from '../../src/multitable/automation-durable-dispatch-loop'
import { APPROVAL_COMPLETION_CONSUMERS, type RoutingManifest } from '../../src/multitable/automation-routing-manifest'
import type { PoolClient } from 'pg'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const enqueued: string[] = []

/** Wrap a checked-out client as a real transaction handle (the isTransaction marker the enqueue guard requires). */
const txn = (client: PoolClient): TransactionalQueryable => ({ isTransaction: true, query: (sql, params) => client.query(sql, params) })
/** A transaction handle whose query must NOT be reached (validation throws first). */
const txnStub = (): TransactionalQueryable => ({ isTransaction: true, query: async () => { throw new Error('query should not be reached') } })

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
    const client = await db().getInternalPool().connect()
    let outboxId = ''
    try {
      await client.query('BEGIN')
      const res = await enqueueOutboxEvent(txn(client), {
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
    const client = await db().getInternalPool().connect()
    let outboxId = ''
    try {
      await client.query('BEGIN')
      const res = await enqueueOutboxEvent(txn(client), { eventType: 'multitable.form.submitted', eventId: `evt_${RUN}_rollback`, payload: {} })
      outboxId = res.outboxId
      const inside = await client.query('SELECT count(*)::int AS c FROM meta_automation_outbox WHERE id=$1', [outboxId])
      expect(Number(inside.rows[0].c)).toBe(1) // visible INSIDE the txn (same client)...
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    const { outbox, consumers } = await rowsFor(outboxId) // ...and completely gone after ROLLBACK — both tables
    expect(outbox).toHaveLength(0)
    expect(consumers).toHaveLength(0)
  })

  test('P1 pool NEGATIVE: a pool — even with a FORGED isTransaction marker — is REJECTED by the xid probe before any write', async () => {
    const eid = `evt_${RUN}_poolneg`
    // 1) the Pool itself (cast past the compile-time brand): the DB probe rejects it — the marker proves nothing.
    await expect(enqueueOutboxEvent(db() as unknown as TransactionalQueryable, { eventType: 'approval.approved', eventId: eid, payload: {} })).rejects.toThrow(
      /real database TRANSACTION/,
    )
    // 2) a FORGED marker wrapping the pool (the owner's counter-example): still rejected — the probe asks
    //    Postgres, not the caller (two statements on a pool land in different transactions).
    const forged: TransactionalQueryable = { isTransaction: true, query: (sql, params) => db().query(sql, params) }
    await expect(enqueueOutboxEvent(forged, { eventType: 'approval.approved', eventId: eid, payload: {} })).rejects.toThrow(/real database TRANSACTION/)
    // 3) a single client in AUTOCOMMIT (no BEGIN): each statement is its own implicit txn — rejected too.
    const bare = await db().getInternalPool().connect()
    try {
      const bareTxn: TransactionalQueryable = { isTransaction: true, query: (sql, params) => bare.query(sql, params) }
      await expect(enqueueOutboxEvent(bareTxn, { eventType: 'approval.approved', eventId: eid, payload: {} })).rejects.toThrow(/real database TRANSACTION/)
    } finally {
      bare.release()
    }
    // and NOTHING was written in any case — not even the outbox row (pre-fix pool path: outbox=1, consumer=0)
    const { rows } = await db().query('SELECT count(*)::int AS c FROM meta_automation_outbox WHERE event_id=$1', [eid])
    expect(Number(rows[0].c)).toBe(0)
  })

  test('P1 transaction POSITIVE control: a failure on the 2nd (consumer) INSERT rolls the outbox row back too', async () => {
    const client = await db().getInternalPool().connect()
    const eid = `evt_${RUN}_txnpc`
    // a transaction handle whose consumer-fan-out INSERT fails, as a mid-enqueue DB error would
    const failingTxn: TransactionalQueryable = {
      isTransaction: true,
      query: async (sql, params) => {
        if (/meta_automation_outbox_consumer/.test(sql)) throw new Error('simulated DB failure on the consumer INSERT')
        return client.query(sql, params)
      },
    }
    try {
      await client.query('BEGIN')
      await expect(enqueueOutboxEvent(failingTxn, { eventType: 'multitable.form.submitted', eventId: eid, payload: {} })).rejects.toThrow(/simulated DB failure/)
      // the outbox INSERT (1st query) ran but is UNCOMMITTED — visible only inside this txn
      const inside = await client.query('SELECT count(*)::int AS c FROM meta_automation_outbox WHERE event_id=$1', [eid])
      expect(Number(inside.rows[0].c)).toBe(1)
      await client.query('ROLLBACK') // the source write fails → the whole enqueue vanishes, no orphan
    } finally {
      client.release()
    }
    const { rows } = await db().query('SELECT count(*)::int AS c FROM meta_automation_outbox WHERE event_id=$1', [eid])
    expect(Number(rows[0].c)).toBe(0)
  })

  test('an unrouted event type is a HARD error and aborts the enclosing work (no half-enqueue)', async () => {
    await expect(
      enqueueOutboxEvent(txnStub(), { eventType: 'not.a.real.family', eventId: `evt_${RUN}_x`, payload: {} }),
    ).rejects.toThrow(/not routed by manifest v1/)
  })

  test('identity/depth validation is a boundary error: blank eventId and bad depth throw before any SQL', async () => {
    await expect(enqueueOutboxEvent(txnStub(), { eventType: 'multitable.form.submitted', eventId: '   ', payload: {} })).rejects.toThrow(/non-blank identity/)
    await expect(enqueueOutboxEvent(txnStub(), { eventType: 'multitable.form.submitted', eventId: ' ﻿', payload: {} })).rejects.toThrow(/non-blank identity/)
    await expect(
      enqueueOutboxEvent(txnStub(), { eventType: 'multitable.form.submitted', eventId: `evt_${RUN}_d`, payload: {}, automationDepth: -1 }),
    ).rejects.toThrow(/automationDepth/)
    await expect(
      enqueueOutboxEvent(txnStub(), { eventType: 'multitable.form.submitted', eventId: `evt_${RUN}_d2`, payload: {}, automationDepth: 1.5 }),
    ).rejects.toThrow(/automationDepth/)
  })

  test('end-to-end: enqueued fan-out drains through the dispatch tick with PER-CONSUMER independence', async () => {
    // RUN-UNIQUE consumer keys via a test-local manifest, so the dispatch tick claims ONLY this test's rows on
    // the shared CI DB (real manifest keys + a big batchSize would claim sibling suites' rows — #4336 review P2).
    const keys = [`ubridge_${RUN}`, `utrigger_${RUN}`, `uproj_${RUN}`] as const
    const testManifest: RoutingManifest = { version: 1, routes: { 'approval.rejected': keys } }
    const client = await db().getInternalPool().connect()
    let outboxId = ''
    try {
      await client.query('BEGIN')
      const res = await enqueueOutboxEvent(txn(client), { eventType: 'approval.rejected', eventId: `evt_${RUN}_e2e`, payload: { instanceId: 'apr_e2e' } }, testManifest)
      outboxId = res.outboxId
      enqueued.push(outboxId)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const registry = new ConsumerAdapterRegistry()
    const handled: string[] = []
    for (const key of keys) {
      registry.register({
        key,
        async handle(): Promise<AdapterOutcome> {
          handled.push(key)
          return key === keys[0] ? { outcome: 'retryable_failure', reason: 'adapter_error' } : { outcome: 'success' }
        },
      })
    }
    await runDispatchTick(db(), registry) // default batch — only this test's 3 unique-key rows are reclaimable by it
    const { consumers } = await rowsFor(outboxId)
    const byKey = Object.fromEntries(consumers.map((c) => [c.consumer_key, c.status]))
    expect(byKey[keys[1]]).toBe('done')
    expect(byKey[keys[2]]).toBe('done')
    expect(byKey[keys[0]]).toBe('in_progress') // rescheduled with backoff — independent of siblings
    expect(handled.sort()).toEqual([...keys].sort())
  })
})
