/**
 * P2 durable-delivery — S5 real consumer handlers: the mapping proof.
 *
 * Each durable consumer_key adapter MUST delegate to the SAME production method the legacy `eventBus.subscribe`
 * closure calls (structurally closing the manifest's un-enumerable direction). This proves the routing +
 * payload reconstruction with spy services — no DB, no flag (the builder is a pure delegation over injected
 * services; `bootDurableDelivery` is the only flag gate and is proven in the real-DB activation suite).
 */
import { describe, expect, test, vi } from 'vitest'

import { buildDurableConsumerHandlers, type DurableDeliveryServices } from '../../src/multitable/automation-durable-consumer-handlers'
import { bootDurableDelivery, buildConsumerAdapterRegistry, DURABLE_CONSUMER_KEYS } from '../../src/multitable/automation-durable-activation'
import { assertManifestCompleteness, manifestConsumerKeys } from '../../src/multitable/automation-routing-manifest'
import type { ClaimedConsumer } from '../../src/multitable/automation-durable-dispatcher'
import type { AdapterOutcome, ConsumerAdapter, DispatchLoopObserver } from '../../src/multitable/automation-durable-dispatch-loop'

type Call = { method: string; args: unknown[] }

// This suite exercises the legacy handlers. A read routed here must remain pending,
// never gain an accidental ACK from a no-op substitute for the private service.
const unavailableReadAdapter: ConsumerAdapter = {
  key: 'integration-read-preview',
  handle: async () => ({ outcome: 'retryable_failure', reason: 'adapter_error' }),
}

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
      handleDurableRecordEvent: rec('handleDurableRecordEvent'),
    },
    automationReadRecord: { produce: rec('readRecordProduce') },
    projectionService: { reconcile: rec('reconcile') as unknown as (id: string) => Promise<unknown> },
    webhookService: { deliverEvent: rec('deliverEvent') as unknown as (e: never, p: unknown) => Promise<unknown> },
    recordApprovalService: { handleApprovalCompletion: rec('handleApprovalCompletion') as unknown as (e: never) => Promise<void> },
    todoMirrorService: {
      handleApprovalTaskCreated: rec('todoMirrorTaskCreated') as unknown as (e: never) => Promise<void>,
      handleApprovalCompletion: rec('todoMirrorCompletion') as unknown as (e: never) => Promise<void>,
    },
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

  test.each(['multitable.record.created', 'multitable.record.updated'])('%s delegates private admission and ordinary durable leg with authoritative identity and signal', async eventType => {
    const { services, calls } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    const context = { signal: new AbortController().signal }
    await handlers['automation-record-trigger'](
      claimed({ consumerKey: 'automation-record-trigger', eventType, eventId: 'evt_durable_id', automationDepth: 2, payload: { sheetId: 's1', recordId: 'r1', _eventId: 'STALE', _automationDepth: 99 } }),
      context,
    )
    // the DURABLE row's identity + depth win — a re-delivery dedups on the stable original id, not a stale copy
    expect(calls).toEqual([
      { method: 'readRecordProduce', args: [{ outboxId: 'obx_1', eventId: 'evt_durable_id', fence: '1', attempts: 1 }, context.signal] },
      { method: 'handleDurableRecordEvent', args: [eventType, { sheetId: 's1', recordId: 'r1', _eventId: 'evt_durable_id', _automationDepth: 2 }] },
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

  test('multitable-record-approval (manifest v2) delegates the completion event to the record-approval sink', async () => {
    const { services, calls } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    await handlers['multitable-record-approval'](
      claimed({ consumerKey: 'multitable-record-approval', eventType: 'approval.approved', payload: approvalPayload, manifestVersion: 2 }),
    )
    // The SAME sink object the eventBus leg subscribes — one idempotent handler, two legs.
    expect(calls).toEqual([{ method: 'handleApprovalCompletion', args: [approvalPayload] }])
  })

  test('multitable-record-approval ACKs an approval that is not record-linked (sink no-ops; never a throw)', async () => {
    const services = {
      ...spyServices().services,
      // The real sink resolves with { applied: false } when the UPDATE matches no submission row; the
      // adapter must treat that as SUCCESS (a throw here would dead-letter every ordinary approval).
      recordApprovalService: { handleApprovalCompletion: async () => undefined },
    } as DurableDeliveryServices
    const handlers = buildDurableConsumerHandlers(services)
    await expect(
      handlers['multitable-record-approval'](
        claimed({ consumerKey: 'multitable-record-approval', eventType: 'approval.rejected', payload: { approval: { instanceId: 'not_a_record_submission' } }, manifestVersion: 2 }),
      ),
    ).resolves.toBeUndefined()
  })

  test('dingtalk-todo-mirror (manifest v3) routes task_created to the create half and the four completions to the retire half', async () => {
    const { services, calls } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    const taskPayload = { version: 1, eventId: 'evt_task_1', eventType: 'approval.task_created', approval: { instanceId: 'appr_inst_9' }, task: { nodeKey: 'n1', entryEpoch: 1, assigneeUserId: 'u1' } }
    await handlers['dingtalk-todo-mirror'](
      claimed({ consumerKey: 'dingtalk-todo-mirror', eventType: 'approval.task_created', payload: taskPayload, manifestVersion: 3 }),
    )
    for (const t of ['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled']) {
      await handlers['dingtalk-todo-mirror'](
        claimed({ consumerKey: 'dingtalk-todo-mirror', eventType: t, payload: approvalPayload, manifestVersion: 3 }),
      )
    }
    expect(calls.map((c) => c.method)).toEqual([
      'todoMirrorTaskCreated',
      'todoMirrorCompletion',
      'todoMirrorCompletion',
      'todoMirrorCompletion',
      'todoMirrorCompletion',
    ])
    expect(calls[0].args).toEqual([taskPayload])
  })

  test('dingtalk-todo-mirror THROWS on an event type manifest v3 never routes to it (never a silent drop)', async () => {
    const { services, calls } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    await expect(
      handlers['dingtalk-todo-mirror'](
        claimed({ consumerKey: 'dingtalk-todo-mirror', eventType: 'multitable.record.created', payload: {}, manifestVersion: 3 }),
      ),
    ).rejects.toThrow(/unroutable event type/)
    expect(calls).toEqual([])
  })

  test('the REAL handler set is manifest-complete (registry keys === every routed consumer_key, bidirectional)', () => {
    const { services } = spyServices()
    const registry = buildConsumerAdapterRegistry(buildDurableConsumerHandlers(services), unavailableReadAdapter)
    // bidirectional: no routed key without an adapter, no adapter without a route (throws otherwise)
    expect(() => assertManifestCompleteness(registry)).not.toThrow()
    expect(registry.keys().sort()).toEqual(manifestConsumerKeys().sort())
  })
})

describe('SA06P — separate context-aware read consumer registration', () => {
  test('legacy handler set stays eight and read registration preserves the exact adapter, signal and outcome', async () => {
    const { services, calls } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    expect(Object.keys(handlers).sort()).toEqual([...DURABLE_CONSUMER_KEYS].sort())
    expect(DURABLE_CONSUMER_KEYS).toHaveLength(8)
    const event = claimed({ consumerKey: 'integration-read-preview', eventType: 'integration.read-preview.requested', manifestVersion: 4 })
    const context = { signal: new AbortController().signal }
    for (const outcome of [
      { outcome: 'success' },
      { outcome: 'retryable_failure', reason: 'adapter_timeout' },
      { outcome: 'permanent_failure', reason: 'permanent_rejection' },
    ] satisfies AdapterOutcome[]) {
      const handle = vi.fn(async () => outcome)
      const adapter: ConsumerAdapter = { key: 'integration-read-preview', handle }
      const registry = buildConsumerAdapterRegistry(handlers, adapter)
      expect(registry.get(adapter.key)).toBe(adapter)
      expect(await registry.get(adapter.key)!.handle(event, context)).toBe(outcome)
      expect(handle).toHaveBeenCalledTimes(1)
      expect(handle).toHaveBeenCalledWith(event, context)
    }
    expect(calls).toEqual([])
  })

  test('missing or wrongly keyed read adapter fails closed instead of creating a successful no-op', () => {
    const { services } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    for (const adapter of [undefined, { ...unavailableReadAdapter, key: 'approval-bridge' }, { key: 'integration-read-preview' }]) {
      expect(() => buildConsumerAdapterRegistry(handlers, adapter as ConsumerAdapter)).toThrow('integration-read-preview adapter required')
    }
  })

  test('flag-OFF boot remains zero-query without a read adapter; flag-ON requires it before the loop', () => {
    const { services } = spyServices()
    const handlers = buildDurableConsumerHandlers(services)
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const observer: DispatchLoopObserver = {
      onUnknownConsumerKeys() {}, onTickError() {}, onHeartbeatError() {}, onClaimTimePoison() {},
    }
    expect(bootDurableDelivery({ query }, handlers, observer, { env: {} })).toBeNull()
    expect(() => bootDurableDelivery({ query }, handlers, observer, {
      env: { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' },
    })).toThrow('integration-read-preview adapter required')
    expect(query).not.toHaveBeenCalled()
  })
})

describe('SA06V — record producer wiring is explicit and independent of ordinary rules', () => {
  const event = () => claimed({ consumerKey: 'automation-record-trigger', eventType: 'multitable.record.created',
    payload: { sheetId: 's1', recordId: 'r1' } })
  test('registry preserves the real dispatch signal for the record producer', async () => {
    const { services, calls } = spyServices(), context = { signal: new AbortController().signal }
    const adapter = buildConsumerAdapterRegistry(buildDurableConsumerHandlers(services), unavailableReadAdapter).get('automation-record-trigger')!
    expect(await adapter.handle(event(), context)).toEqual({ outcome: 'success' })
    expect(calls.map(call => call.method)).toEqual(['readRecordProduce', 'handleDurableRecordEvent'])
    expect(calls[0].args[1]).toBe(context.signal)
  })
  for (const failedLeg of ['read', 'ordinary', 'both'] as const) {
    test(`${failedLeg} failure retries transport AFTER both independent legs were attempted`, async () => {
      const { services } = spyServices()
      const read = vi.fn(async () => { if (failedLeg !== 'ordinary') throw new Error('synthetic-private-read') })
      const ordinary = vi.fn(async () => { if (failedLeg !== 'read') throw new Error('synthetic-private-ordinary') })
      services.automationReadRecord.produce = read
      services.automationService.handleDurableRecordEvent = ordinary
      const adapter = buildConsumerAdapterRegistry(buildDurableConsumerHandlers(services), unavailableReadAdapter).get('automation-record-trigger')!
      expect(await adapter.handle(event(), { signal: new AbortController().signal }))
        .toEqual({ outcome: 'retryable_failure', reason: 'adapter_error' })
      expect(read).toHaveBeenCalledTimes(1)
      expect(ordinary).toHaveBeenCalledTimes(1)
    })
  }
  for (const missing of ['signal', 'aborted'] as const) {
    test(`${missing} signal prevents read admission and cannot falsely ACK`, async () => {
      const { services, calls } = spyServices(), controller = new AbortController()
      controller.abort()
      const adapter = buildConsumerAdapterRegistry(buildDurableConsumerHandlers(services), unavailableReadAdapter).get('automation-record-trigger')!
      expect(await adapter.handle(event(), missing === 'signal' ? undefined : { signal: controller.signal }))
        .toEqual({ outcome: 'retryable_failure', reason: 'adapter_error' })
      expect(calls).toEqual([])
    })
  }
  test('other record families retain the ordinary path and never touch automatic read admission', async () => {
    const { services, calls } = spyServices(), handlers = buildDurableConsumerHandlers(services)
    await handlers['automation-record-trigger']({ ...event(), eventType: 'multitable.record.deleted' })
    expect(calls.map(call => call.method)).toEqual(['handleEvent'])
  })
  test.each(['multitable.record.created', 'multitable.record.updated'])('a %s read admission that settles after cancellation cannot start ordinary SQL', async eventType => {
    const { services } = spyServices(), controller = new AbortController()
    let finish!: () => void
    services.automationReadRecord.produce = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const ordinary = vi.fn(async () => {})
    services.automationService.handleDurableRecordEvent = ordinary
    const adapter = buildConsumerAdapterRegistry(buildDurableConsumerHandlers(services), unavailableReadAdapter).get('automation-record-trigger')!
    const running = adapter.handle({ ...event(), eventType }, { signal: controller.signal })
    expect(typeof finish).toBe('function')
    controller.abort(); finish()
    expect(await running).toEqual({ outcome: 'retryable_failure', reason: 'adapter_error' })
    expect(ordinary).not.toHaveBeenCalled()
  })
  test('missing producer or ordinary durable entry fails construction, not a successful no-op', () => {
    const { services } = spyServices()
    expect(() => buildDurableConsumerHandlers({ ...services, automationReadRecord: undefined } as unknown as DurableDeliveryServices))
      .toThrow('AUTOMATION_READ_RECORD_PRODUCER_REQUIRED')
    expect(() => buildDurableConsumerHandlers({ ...services, automationService: {
      ...services.automationService, handleDurableRecordEvent: undefined,
    } } as unknown as DurableDeliveryServices)).toThrow('AUTOMATION_READ_RECORD_PRODUCER_REQUIRED')
  })
})
