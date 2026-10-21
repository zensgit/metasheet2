/** Pure closed-input checks only; production transaction/lease/actor guarantees
 * are asserted against the actual migrations in record-activation-realdb. */
import { describe, expect, it } from 'vitest'
import { assertReadRecordSignal, captureReadRecordData, captureReadRecordDelivery,
  readRecordEventType, readRecordTriggerType } from '../../../src/integration/automation-read-record-activation'
import type { ReadRecordDelivery } from '../../../src/integration/automation-read-contracts'

const delivery = () => ({ outboxId: 'synthetic-outbox', eventId: 'synthetic-event', fence: '7', attempts: 1 })
describe('Record admission closed identity and cancellation input', () => {
  it.each(['record.created', 'record.updated'] as const)('maps only the exact saved %s to its durable family', trigger => {
    expect(readRecordTriggerType(trigger)).toBe(trigger)
    expect(readRecordEventType(trigger)).toBe(`multitable.${trigger}`)
  })
  it.each(['record.deleted', 'field.value_changed', 'record.created ', 'Record.updated', 'multitable.record.updated', null, undefined, {}])(
    'rejects unsupported saved record family %#', value => { expect(readRecordTriggerType(value)).toBeNull() },
  )
  it('captures a detached frozen identity, including a lossless bigint fence', () => {
    const supplied = { ...delivery(), fence: '9223372036854775807' }
    const result = captureReadRecordDelivery(supplied)
    expect(result).toEqual(supplied); expect(result).not.toBe(supplied); expect(Object.isFrozen(result)).toBe(true)
    supplied.eventId = 'changed'
    expect(result.eventId).toBe('synthetic-event')
    expect(captureReadRecordDelivery(Object.assign(Object.create(null), delivery()))).toEqual(delivery())
  })
  it.each([
    ['missing', { outboxId: 'synthetic-outbox', eventId: 'synthetic-event', fence: '1' }],
    ['extra', { ...delivery(), actorId: 'self-reported-owner' }],
    ['payload', { ...delivery(), payload: { sheetId: 'self-reported-sheet' } }],
    ['event type', { ...delivery(), eventType: 'multitable.record.updated' }],
    ['trigger type', { ...delivery(), triggerType: 'record.updated' }],
    ['space id', { ...delivery(), eventId: ' event ' }],
    ['empty id', { ...delivery(), outboxId: '' }],
    ['numeric fence', { ...delivery(), fence: 7 }],
    ['zero fence', { ...delivery(), fence: '0' }],
    ['negative fence', { ...delivery(), fence: '-1' }],
    ['padded fence', { ...delivery(), fence: '01' }],
    ['overflow fence', { ...delivery(), fence: '9223372036854775808' }],
    ['zero attempts', { ...delivery(), attempts: 0 }],
    ['fraction attempts', { ...delivery(), attempts: 1.5 }],
    ['overflow attempts', { ...delivery(), attempts: 2147483648 }],
    ['prototype', Object.assign(Object.create({ injected: true }), delivery())],
    ['symbol', { ...delivery(), [Symbol('scope')]: true }],
    ['array', []], ['null', null], ['undefined', undefined],
  ])('rejects %s without retaining provider fields', (_name, value) => {
    expect(() => captureReadRecordDelivery(value as ReadRecordDelivery)).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
  it.each(['outboxId', 'eventId', 'fence', 'attempts'] as const)('does not invoke an own %s accessor', key => {
    let calls = 0
    const value = delivery()
    Object.defineProperty(value, key, { enumerable: true, get() { calls++; throw new Error('MUST_NOT_EXECUTE') } })
    expect(() => captureReadRecordDelivery(value)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    expect(calls).toBe(0)
  })
  it('rejects nonenumerable data and cannot inherit missing fields', () => {
    const nonenumerable = delivery()
    Object.defineProperty(nonenumerable, 'eventId', { enumerable: false, value: 'synthetic-event' })
    expect(() => captureReadRecordDelivery(nonenumerable)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    expect(() => captureReadRecordData(Object.create({ budget: {} }), ['budget'])).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
  it('accepts only an actual live AbortSignal; cancellation is a fence failure', () => {
    const controller = new AbortController()
    expect(() => assertReadRecordSignal(controller.signal)).not.toThrow()
    controller.abort()
    expect(() => assertReadRecordSignal(controller.signal)).toThrow('AUTOMATION_READ_FENCE_LOST')
    expect(() => assertReadRecordSignal({ aborted: false } as AbortSignal)).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
})
