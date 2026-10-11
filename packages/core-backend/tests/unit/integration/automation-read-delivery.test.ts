import { describe, expect, it, vi } from 'vitest'
import { createAutomationReadDelivery } from '../../../src/integration/automation-read-delivery'
import { AUTOMATION_READ_CONSUMER, AUTOMATION_READ_EVENT } from '../../../src/integration/automation-read-contracts'
import type { ClaimedConsumer } from '../../../src/multitable/automation-durable-dispatcher'

const requestId = '00000000-0000-4000-8000-000000000001'
const valid = (): ClaimedConsumer => ({
  outboxId: 'obx_00000000-0000-4000-8000-000000000002', consumerKey: AUTOMATION_READ_CONSUMER,
  fence: '1', attempts: 1, eventType: AUTOMATION_READ_EVENT, eventId: `integration-read:${requestId}`,
  payload: { requestId }, automationDepth: 0, manifestVersion: 4,
})
const malformed: Array<[string, (event: ClaimedConsumer) => unknown]> = [
  ['wrong key', event => ({ ...event, consumerKey: 'approval-bridge' })],
  ['wrong type', event => ({ ...event, eventType: 'approval.approved' })],
  ['wrong event identity', event => ({ ...event, eventId: 'integration-read:other' })],
  ['wrong outbox identity', event => ({ ...event, outboxId: 'outbox' })],
  ['uppercase UUID', event => ({ ...event, payload: { requestId: 'AAAAAAAA-0000-4000-8000-000000000001' } })],
  ['extra payload key', event => ({ ...event, payload: { requestId, token: 'synthetic-private' } })],
  ['missing payload', event => ({ ...event, payload: null })],
  ['array payload', event => ({ ...event, payload: [requestId] })],
  ['accessor payload', event => ({ ...event, payload: Object.defineProperty({}, 'requestId', { enumerable: true, get() { throw new Error('must not read') } }) })],
  ['extra event key', event => ({ ...event, privateMaterial: {} })],
  ['prototype event', event => Object.create(event)],
  ['zero fence', event => ({ ...event, fence: '0' })],
  ['numeric fence', event => ({ ...event, fence: 1 })],
  ['overflow fence', event => ({ ...event, fence: '9223372036854775808' })],
  ['wrong depth', event => ({ ...event, automationDepth: 1 })],
  ['invalid version', event => ({ ...event, manifestVersion: 0 })],
  ['invalid attempts', event => ({ ...event, attempts: 0 })],
]

describe('Automation read delivery: closed admission before any DB/source IO', () => {
  for (const [name, mutate] of malformed) {
    it(`rejects ${name} without touching storage or runtime`, async () => {
      const transaction = vi.fn(), execute = vi.fn()
      const adapter = createAutomationReadDelivery({ transaction, execute })
      expect(adapter.key).toBe(AUTOMATION_READ_CONSUMER)
      expect(await adapter.handle(mutate(valid()) as ClaimedConsumer, { signal: new AbortController().signal }))
        .toEqual({ outcome: 'permanent_failure', reason: 'permanent_rejection' })
      expect(transaction).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
    })
  }
  it('requires the actual un-aborted signal instead of constructing one or accepting a duck type', async () => {
    const transaction = vi.fn(), execute = vi.fn()
    const adapter = createAutomationReadDelivery({ transaction, execute })
    const controller = new AbortController()
    controller.abort()
    for (const context of [undefined, { signal: controller.signal }, { signal: { aborted: false } as AbortSignal }]) {
      expect(await adapter.handle(valid(), context)).toEqual({ outcome: 'retryable_failure', reason: 'adapter_error' })
    }
    expect(transaction).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
  it('returns only a fixed retry code on transaction failures, never error details or acceptance', async () => {
    const transaction = vi.fn().mockRejectedValue(new Error('synthetic-private-DB-detail')), execute = vi.fn()
    const adapter = createAutomationReadDelivery({ transaction, execute })
    expect(await adapter.handle(valid(), { signal: new AbortController().signal }))
      .toEqual({ outcome: 'retryable_failure', reason: 'adapter_error' })
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })
})
