/**
 * P2 durable-delivery P1#2e — producer family 1 seam (`enqueueApprovalEventIfDurable`).
 *
 * Pins the two load-bearing decisions of the approval seam entry WITHOUT a DB (the real-DB enqueue is proven by
 * the family-1 goldens): (1) flag OFF ⇒ a pure no-op that never touches the transaction handle; (2) flag ON ⇒
 * it forwards the WHOLE approval event as the durable `payload`, keys the outbox on the event's TOP-LEVEL
 * `eventId` (NOT a record-event `_eventId`), and stamps `automation_depth = 0` (an approval event is an
 * ORIGINAL producer event, never an automation-chain link). A fake in-transaction handle answers the
 * `pg_current_xact_id()` probe with a stable xid and records the INSERTs.
 */
import { describe, expect, test, vi } from 'vitest'

import { enqueueApprovalEventIfDurable } from '../../src/multitable/automation-producer-emit'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

const FLAG_ON = { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv
const FLAG_OFF = {} as NodeJS.ProcessEnv

const completionEvent = {
  version: 1,
  eventId: 'approval:inst_1:3:approval.approved',
  eventType: 'approval.approved',
  occurredAt: '2026-07-17T00:00:00.000Z',
  source: 'approval-product',
  approval: { instanceId: 'inst_1', requestNo: 'RQ-1' },
  transition: { action: 'approve', toStatus: 'approved', toVersion: 3 },
  actor: { id: 'u1', name: 'U1' },
  requester: { id: 'u0' },
}

/** A fake handle that PASSES the xid probe (stable id) and records every non-probe statement's [sql, params]. */
function fakeTxn(): { trx: TransactionalQueryable; writes: Array<{ sql: string; params?: unknown[] }> } {
  const writes: Array<{ sql: string; params?: unknown[] }> = []
  const trx = {
    isTransaction: true as const,
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: '777' }], rowCount: 1 }
      writes.push({ sql, params })
      return { rows: [] as Array<Record<string, unknown>>, rowCount: 1 }
    },
  }
  return { trx, writes }
}

describe('enqueueApprovalEventIfDurable — flag OFF is a pure no-op', () => {
  test('returns false and never touches the transaction handle', async () => {
    const query = vi.fn()
    const trx = { isTransaction: true as const, query } as unknown as TransactionalQueryable
    expect(await enqueueApprovalEventIfDurable(trx, completionEvent, FLAG_OFF)).toBe(false)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('enqueueApprovalEventIfDurable — flag ON enqueues the FULL event, keyed on top-level eventId, depth 0', () => {
  test('outbox INSERT carries the whole event payload + eventId + automation_depth 0; consumers = completion fan-out', async () => {
    const { trx, writes } = fakeTxn()
    expect(await enqueueApprovalEventIfDurable(trx, completionEvent, FLAG_ON)).toBe(true)

    const outboxInsert = writes.find((w) => w.sql.includes('INSERT INTO meta_automation_outbox '))
    expect(outboxInsert).toBeDefined()
    // params: [id, event_type, payload::jsonb, automation_depth, manifest_version, event_id]
    const p = outboxInsert!.params as unknown[]
    expect(p[1]).toBe('approval.approved')
    expect(JSON.parse(p[2] as string)).toEqual(completionEvent) // WHOLE event forwarded verbatim as payload
    expect(p[3]).toBe(0) // automation_depth: an approval event is an ORIGINAL producer event
    expect(p[5]).toBe(completionEvent.eventId) // keyed on the TOP-LEVEL eventId, not a record `_eventId`

    const consumerInsert = writes.find((w) => w.sql.includes('meta_automation_outbox_consumer'))
    expect(consumerInsert).toBeDefined()
    // approval.approved fans out to the three completion consumers (manifest v1).
    expect(consumerInsert!.params?.[1]).toEqual(['approval-bridge', 'approval-trigger', 'approval-projection'])
  })

  test('task_created event routes to exactly [approval-task-trigger]', async () => {
    const { trx, writes } = fakeTxn()
    const taskEvent = {
      version: 1,
      eventId: 'approval-task:inst_1:approval_1:1:u5',
      eventType: 'approval.task_created',
      occurredAt: '2026-07-17T00:00:00.000Z',
      source: 'approval-product',
      approval: { instanceId: 'inst_1' },
      task: { nodeKey: 'approval_1', entryEpoch: 1, assigneeUserId: 'u5', sourceStep: 0 },
      requester: { id: 'u0' },
    }
    expect(await enqueueApprovalEventIfDurable(trx, taskEvent, FLAG_ON)).toBe(true)
    const consumerInsert = writes.find((w) => w.sql.includes('meta_automation_outbox_consumer'))
    expect(consumerInsert!.params?.[1]).toEqual(['approval-task-trigger'])
    const outboxInsert = writes.find((w) => w.sql.includes('INSERT INTO meta_automation_outbox '))
    expect((outboxInsert!.params as unknown[])[5]).toBe(taskEvent.eventId)
  })
})
