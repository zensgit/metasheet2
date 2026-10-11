/** Closed projection/serialization tests only. Query transport here records
 * arguments; transactional durability is proved by the companion real-PG suite.
 */
import { describe, expect, it, vi } from 'vitest'
import { AutomationLogService, closedIntegrationRead, redactAutomationExecutionForResponse } from '../../../src/multitable/automation-log-service'
import type { AutomationExecution } from '../../../src/multitable/automation-executor'

const requestId = '11111111-2222-3333-4444-555555555555'
const states = ['queued', 'running', 'succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown'] as const
const invalid = 'AUTOMATION_READ_EXECUTION_PROJECTION_INVALID'
const execution: AutomationExecution = {
  id: 'axe_11111111-2222-3333-4444-555555555555', ruleId: 'synthetic-rule',
  triggeredBy: 'event', triggeredAt: '2026-10-01T00:00:00.000Z', status: 'running', steps: [],
}
function withRead(value: unknown): AutomationExecution {
  return { ...execution, integrationRead: value as AutomationExecution['integrationRead'] }
}

describe('Read execution audit closed public marker', () => {
  it.each(states)('copies the valid %s marker with exactly the two permitted fields', status => {
    const original: Record<string, unknown> = { requestId, status }
    const result = closedIntegrationRead(original)
    expect(result).toEqual({ requestId, status })
    expect(result).not.toBe(original)
    expect(Reflect.ownKeys(result!)).toEqual(['requestId', 'status'])
    original.requestId = 'synthetic-later-mutation'
    original.status = 'synthetic-unknown-state'
    expect(result).toEqual({ requestId, status })
  })

  it.each([null, undefined])('keeps absent legacy marker %s absent', value => {
    expect(closedIntegrationRead(value)).toBeUndefined()
    expect(redactAutomationExecutionForResponse(withRead(value)).integrationRead).toBeUndefined()
  })

  it('accepts a null-prototype data record but detaches it into a normal output', () => {
    const value = Object.assign(Object.create(null), { requestId, status: 'queued' })
    const result = closedIntegrationRead(value)
    expect(result).toEqual({ requestId, status: 'queued' })
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  })

  it.each([
    ['extra field', { requestId, status: 'queued', source: 'synthetic-private-source' }],
    ['symbol field', { requestId, status: 'queued', [Symbol('synthetic-private-symbol')]: true }],
    ['prototype', Object.assign(Object.create({ inherited: true }), { requestId, status: 'queued' })],
    ['array', [{ requestId, status: 'queued' }]],
    ['primitive', 'synthetic-private-input'],
    ['bad uuid', { requestId: 'synthetic-not-a-uuid', status: 'queued' }],
    ['upper uuid', { requestId: 'AAAAAAAA-2222-3333-4444-555555555555', status: 'queued' }],
    ['unknown state', { requestId, status: 'ready' }],
    ['missing state', { requestId }],
    ['non-enumerable state', Object.defineProperty({ requestId }, 'status', { value: 'queued', enumerable: false })],
  ])('rejects %s without passing it through the response redactor', (_label, value) => {
    expect(() => closedIntegrationRead(value)).toThrow(invalid)
    expect(() => redactAutomationExecutionForResponse(withRead(value))).toThrow(invalid)
  })

  it.each(['requestId', 'status'] as const)('does not invoke a %s getter at either public boundary', field => {
    const getter = vi.fn(() => { throw new Error('synthetic-private-getter') })
    const value = Object.defineProperty({ requestId, status: 'queued' }, field, { enumerable: true, get: getter })
    expect(() => closedIntegrationRead(value)).toThrow(invalid)
    expect(() => redactAutomationExecutionForResponse(withRead(value))).toThrow(invalid)
    expect(getter).not.toHaveBeenCalled()
  })

  it('response marker is a detached closed copy, not the input object reference', () => {
    const value = { requestId, status: 'succeeded' }
    const output = redactAutomationExecutionForResponse(withRead(value))
    expect(output.integrationRead).toEqual(value)
    expect(output.integrationRead).not.toBe(value)
    value.status = 'synthetic-later-state'
    expect(output.integrationRead).toEqual({ requestId, status: 'succeeded' })
  })
})

describe('Actual log service serializer with a capture-only query transport (not a database)', () => {
  it.each([undefined, null])('serializes absent ordinary marker %s as SQL NULL, not JSON null', async value => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 1 }))
    await new AutomationLogService().recordWithQuery(query, withRead(value))
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0][0]).toContain('integration_read')
    expect(query.mock.calls[0][1]?.at(-1)).toBeNull()
  })

  it.each(states)('serializes the %s closed marker and no private fields', async status => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 1 }))
    await new AutomationLogService().recordWithQuery(query, withRead({ requestId, status }))
    expect(query).toHaveBeenCalledOnce()
    expect(JSON.parse(query.mock.calls[0][1]?.at(-1) as string)).toEqual({ requestId, status })
  })

  it('rejects malformed markers before invoking even the capture query', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 1 }))
    await expect(new AutomationLogService().recordWithQuery(query, withRead({ requestId, status: 'queued', counts: { add: 1 } })))
      .rejects.toThrow(invalid)
    expect(query).not.toHaveBeenCalled()
  })
})
