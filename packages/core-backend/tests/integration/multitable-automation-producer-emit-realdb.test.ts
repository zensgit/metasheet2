/**
 * P2 durable-delivery P1 #2 — producer REPLACE seam same-transaction goldens (real DB).
 *
 * The shared `enqueueRecordEventIfDurable` is what EVERY wired producer family calls, so one set of goldens
 * here covers the produce-seam behavior for all of them:
 *   - flag ON + COMMIT  → the outbox row + its manifest-expanded consumer rows are durable (pending).
 *   - flag ON + ROLLBACK → zero rows (atomic with the source txn — a crash/abort before commit loses nothing).
 *   - flag OFF          → no-op (no rows); the caller emits legacy post-commit instead.
 * Rows are asserted by their own outbox id and cleaned up — never drained — so this never claims a sibling
 * suite's row on the shared CI DB.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { enqueueRecordEventIfDurable } from '../../src/multitable/automation-producer-emit'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const FLAG_ON = { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv
const FLAG_OFF = {} as NodeJS.ProcessEnv
const seededOutboxIds: string[] = []

/** Run `fn` with a real transaction handle wrapped as a TransactionalQueryable; commit or rollback per `commit`. */
async function inTxn<T>(commit: boolean, fn: (trx: TransactionalQueryable) => Promise<T>): Promise<T> {
  const client = await db().getInternalPool().connect()
  try {
    await client.query('BEGIN')
    const trx: TransactionalQueryable = {
      isTransaction: true,
      query: async (sql, params) => {
        const r = await client.query(sql, params)
        return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount ?? null }
      },
    }
    const out = await fn(trx)
    await client.query(commit ? 'COMMIT' : 'ROLLBACK')
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

async function outboxCount(eventId: string): Promise<number> {
  const { rows } = await db().query('SELECT count(*)::int AS c FROM meta_automation_outbox WHERE event_id=$1', [eventId])
  return Number((rows[0] as { c: number }).c)
}
async function consumerKeys(eventId: string): Promise<string[]> {
  const { rows } = await db().query(
    `SELECT c.consumer_key FROM meta_automation_outbox_consumer c
       JOIN meta_automation_outbox o ON o.id = c.outbox_id WHERE o.event_id=$1 ORDER BY 1`,
    [eventId],
  )
  return (rows as Array<{ consumer_key: string }>).map((r) => r.consumer_key)
}

describeIfDatabase('P1#2 producer REPLACE seam same-txn goldens (real DB)', () => {
  afterAll(async () => {
    if (seededOutboxIds.length) {
      await db().query('DELETE FROM meta_automation_outbox WHERE id = ANY($1)', [seededOutboxIds]).catch(() => {})
    }
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('flag ON + COMMIT: the outbox row + its manifest consumer fan-out are durable', async () => {
    const eventId = `evt_${RUN}_commit`
    const enqueued = await inTxn(true, (trx) =>
      enqueueRecordEventIfDurable(trx, 'multitable.record.updated', { sheetId: 's', recordId: 'r', _eventId: eventId, _automationDepth: 0 }, FLAG_ON),
    )
    expect(enqueued).toBe(true)
    const { rows } = await db().query('SELECT id FROM meta_automation_outbox WHERE event_id=$1', [eventId])
    if (rows[0]) seededOutboxIds.push((rows[0] as { id: string }).id)
    expect(await outboxCount(eventId)).toBe(1)
    // manifest v1: multitable.record.updated → automation-record-trigger + webhook-event-bridge
    expect(await consumerKeys(eventId)).toEqual(['automation-record-trigger', 'webhook-event-bridge'])
  })

  test('flag ON + ROLLBACK: zero rows — the enqueue is atomic with the source transaction', async () => {
    const eventId = `evt_${RUN}_rollback`
    const enqueued = await inTxn(false, (trx) =>
      enqueueRecordEventIfDurable(trx, 'multitable.record.updated', { sheetId: 's', recordId: 'r', _eventId: eventId, _automationDepth: 0 }, FLAG_ON),
    )
    expect(enqueued).toBe(true) // it ran inside the txn…
    expect(await outboxCount(eventId)).toBe(0) // …but the rollback took the outbox row with it
  })

  test('flag OFF: no-op — zero rows (the caller emits legacy post-commit instead)', async () => {
    const eventId = `evt_${RUN}_off`
    const enqueued = await inTxn(true, (trx) =>
      enqueueRecordEventIfDurable(trx, 'multitable.record.updated', { sheetId: 's', recordId: 'r', _eventId: eventId, _automationDepth: 0 }, FLAG_OFF),
    )
    expect(enqueued).toBe(false)
    expect(await outboxCount(eventId)).toBe(0)
  })
})
