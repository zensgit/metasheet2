/**
 * P2 durable-delivery — S5 real consumer handlers: the mapping proof.
 *
 * Each durable consumer_key adapter MUST delegate to the SAME production method the legacy `eventBus.subscribe`
 * closure calls (structurally closing the manifest's un-enumerable direction). This proves the routing +
 * payload reconstruction with spy services — no DB, no flag (the builder is a pure delegation over injected
 * services; `bootDurableDelivery` is the only flag gate and is proven in the real-DB activation suite).
 */
import { describe, expect, test } from 'vitest'

import { buildDurableConsumerHandlers, type DurableDeliveryServices } from '../../src/multitable/automation-durable-consumer-handlers'
import { buildConsumerAdapterRegistry } from '../../src/multitable/automation-durable-activation'
import { assertManifestCompleteness, manifestConsumerKeys } from '../../src/multitable/automation-routing-manifest'
import type { ClaimedConsumer } from '../../src/multitable/automation-durable-dispatcher'

type Call = { method: string; args: unknown[] }

function spyServices(): { services: DurableDeliveryServices; calls: Call[] } {
  const calls: Call[] = []
  const rec = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args })
  }
  const services: DurableDeliveryServices = {
    automationService: {
      handleApprovalCompletionEvent: rec('handleApprovalCompletionEvent'),
      handleApprovalCompletionTrigger: rec('handleApprovalCompletionTrigger'),
      handleApprovalTaskCreatedTrigger: rec('handleApprovalTaskCreatedTrigger'),
      handleEvent: rec('handleEvent'),
    },
    projectionService: { reconcile: rec('reconcile') as unknown as (id: string) => Promise<unknown> },
    webhookService: { deliverEvent: rec('deliverEvent') as unknown as (e: never, p: unknown) => Promise<unknown> },
  }
  return { services, calls }
}

function claimed(over: Partial<ClaimedConsumer> & Pick<ClaimedConsumer, 'consumerKey' | 'eventType'>): ClaimedConsumer {
  return {
    outboxId: 'obx_1',
    fence: '1',
    attempts: 1,
    eventId: 'evt_stable_1',
    payload: {},
    automationDepth: 0,
    manifestVersion: 1,
    ...over,
  }
}

const approvalPayload = {
  version: 1,
  eventId: 'evt_stable_1',
  eventType: 'approval.approved',
  source: 'approval-product',
  approval: { instanceId: 'appr_inst_9' },
  transition: { toStatus: 'approved' },
}

describe('buildDurableConsumerHandlers — durable consumer_key → real production method', () => {
  test('approval-bridge delegates to handleApprovalCompletionEvent with the reconstructed event payload', async () => {
    const { services, calls } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    await handlers['approval-bridge'](claimed({ consumerKey: 'approval-bridge', eventType: 'approval.approved', payload: approvalPayload }))
    expect(calls).toEqual([{ method: 'handleApprovalCompletionEvent', args: [approvalPayload] }])
  })

  test('approval-trigger delegates to handleApprovalCompletionTrigger (NOT the bridge)', async () => {
    const { services, calls } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    await handlers['approval-trigger'](claimed({ consumerKey: 'approval-trigger', eventType: 'approval.rejected', payload: approvalPayload }))
    expect(calls).toEqual([{ method: 'handleApprovalCompletionTrigger', args: [approvalPayload] }])
  })

  test('approval-projection delegates to reconcile(instanceId) taken from the payload', async () => {
    const { services, calls } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    await handlers['approval-projection'](claimed({ consumerKey: 'approval-projection', eventType: 'approval.approved', payload: approvalPayload }))
    expect(calls).toEqual([{ method: 'reconcile', args: ['appr_inst_9'] }])
  })

  test('approval-projection with NO instanceId is a no-op success (no reconcile, no throw)', async () => {
    const { services, calls } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    await expect(
      handlers['approval-projection'](claimed({ consumerKey: 'approval-projection', eventType: 'approval.approved', payload: { approval: {} } })),
    ).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  test('approval-task-trigger delegates to handleApprovalTaskCreatedTrigger with the payload', async () => {
    const { services, calls } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    const taskPayload = { version: 1, eventId: 'evt_task', templateId: 't1' }
    await handlers['approval-task-trigger'](claimed({ consumerKey: 'approval-task-trigger', eventType: 'approval.task_created', payload: taskPayload }))
    expect(calls).toEqual([{ method: 'handleApprovalTaskCreatedTrigger', args: [taskPayload] }])
  })

  test('automation-record-trigger delegates to handleEvent(eventType, payload) overlaying the durable _eventId + _automationDepth', async () => {
    const { services, calls } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    await handlers['automation-record-trigger'](
      claimed({ consumerKey: 'automation-record-trigger', eventType: 'multitable.record.created', eventId: 'evt_durable_id', automationDepth: 2, payload: { sheetId: 's1', recordId: 'r1', _eventId: 'STALE', _automationDepth: 99 } }),
    )
    // the DURABLE row's identity + depth win — a re-delivery dedups on the stable original id, not a stale copy
    expect(calls).toEqual([
      { method: 'handleEvent', args: ['multitable.record.created', { sheetId: 's1', recordId: 'r1', _eventId: 'evt_durable_id', _automationDepth: 2 }] },
    ])
  })

  test('webhook-event-bridge maps the event type via the SAME table the bus bridge uses, then deliverEvent', async () => {
    const { services, calls } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    const payload = { some: 'record-event' }
    await handlers['webhook-event-bridge'](claimed({ consumerKey: 'webhook-event-bridge', eventType: 'multitable.record.updated', payload, eventId: 'evt_whk_id' }))
    // The outbox eventId is threaded as the 3rd arg (closure item 3 — per-(webhook, event) dedup); a mutant
    // that drops it reds here.
    expect(calls).toEqual([{ method: 'deliverEvent', args: ['record.updated', payload, 'evt_whk_id'] }])
  })

  test('webhook-event-bridge THROWS on an unmapped event type (retryable adapter_error, never a silent drop)', async () => {
    const { services } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    await expect(
      handlers['webhook-event-bridge'](claimed({ consumerKey: 'webhook-event-bridge', eventType: 'multitable.record.moved', payload: {} })),
    ).rejects.toThrow(/no webhook mapping/)
  })

  test('the REAL handler set is manifest-complete (registry keys === every routed consumer_key, bidirectional)', () => {
    const { services } = spyServices()
    const registry = buildConsumerAdapterRegistry(buildDurableConsumerHandlers(services))
    // bidirectional: no routed key without an adapter, no adapter without a route (throws otherwise)
    expect(() => assertManifestCompleteness(registry)).not.toThrow()
    expect(registry.keys().sort()).toEqual(manifestConsumerKeys().sort())
  })
})
