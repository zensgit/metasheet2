import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
const produce = vi.hoisted(() => vi.fn())
vi.mock('../../src/multitable/automation-durable-activation', () => ({ produceAutomationEvent: produce }))
import type { ExactAnchorAppliedMutation } from '../../src/multitable/exact-anchor-recovery-execute'
import type { QueryFn } from '../../src/multitable/permission-service'
import { createRecoveryArchiveWorkerRecordEvents, enqueueRecoveryMutationEvent } from '../../src/multitable/recovery-mutation-events'

const identity = Object.freeze({ jobId: 'job', workspaceId: 'workspace', baseId: 'base', sheetId: 'sheet', actorId: 'actor' })
const mutation = (kind: 'revert' | 'delete'): ExactAnchorAppliedMutation => kind === 'revert'
  ? { kind, recordId: 'record', version: 2, revisionId: 'revision', changedFieldIds: ['field'], patch: { field: 'restored' }, linkInvalidations: [] }
  : { kind, recordId: 'record', revisionId: 'revision', linkInvalidations: [] }
beforeEach(() => {
  vi.stubEnv('AUTOMATION_DURABLE_DELIVERY_ENABLED', 'false')
  produce.mockReset().mockResolvedValue({ eventId: 'accepted' })
})
afterEach(() => { vi.unstubAllEnvs() })

describe('canonical recovery mutation events', () => {
  test.each(['revert', 'delete'] as const)('%s preserves payload and emits only after commit when durable is off', async (kind) => {
    const bus = { emit: vi.fn() }
    const hooks = createRecoveryArchiveWorkerRecordEvents(bus)
    const query = vi.fn<Parameters<QueryFn>, ReturnType<QueryFn>>(async () => ({ rows: [] }))
    const fact = mutation(kind)
    await hooks.onMutationApplied!(query, fact, identity)
    expect(produce).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(bus.emit).not.toHaveBeenCalled()
    await hooks.afterCommit!(identity, [fact])
    expect(bus.emit.mock.calls).toEqual([[
      kind === 'revert' ? 'multitable.record.updated' : 'multitable.record.deleted',
      { sheetId: 'sheet', recordId: 'record', actorId: 'actor', ...(kind === 'revert' ? { changes: { field: 'restored' } } : {}), _eventId: expect.any(String) },
    ]])
    await expect(hooks.afterCommit!(identity, [fact])).rejects.toThrow('RECOVERY_MUTATION_EVENT_BINDING_INVALID')
    expect(bus.emit).toHaveBeenCalledTimes(1)
  })
  test('durable enqueue uses the supplied transaction; legacy emission is suppressed', async () => {
    vi.stubEnv('AUTOMATION_DURABLE_DELIVERY_ENABLED', 'true')
    const query = vi.fn<Parameters<QueryFn>, ReturnType<QueryFn>>(async () => ({ rows: [{ proof: 1 }], rowCount: 1 }))
    produce.mockImplementation(async (trx, event) => {
      expect(trx.isTransaction).toBe(true)
      expect(await trx.query('transaction-probe', ['same'])).toEqual({ rows: [{ proof: 1 }], rowCount: 1 })
      return { eventId: event.eventId }
    })
    const bus = { emit: vi.fn() }
    const hooks = createRecoveryArchiveWorkerRecordEvents(bus)
    const fact = mutation('revert')
    await hooks.onMutationApplied!(query, fact, identity)
    expect(query).toHaveBeenCalledWith('transaction-probe', ['same'])
    expect(produce).toHaveBeenCalledTimes(1)
    const event = produce.mock.calls[0][1]
    expect(event.eventId).toBe(event.payload._eventId)
    await hooks.afterCommit!(identity, [fact])
    expect(bus.emit).not.toHaveBeenCalled()
  })
  test('enqueue failure propagates and cannot leave an emit-ready event', async () => {
    vi.stubEnv('AUTOMATION_DURABLE_DELIVERY_ENABLED', 'true')
    produce.mockRejectedValue(new Error('synthetic_enqueue_failure'))
    const bus = { emit: vi.fn() }
    const hooks = createRecoveryArchiveWorkerRecordEvents(bus)
    const fact = mutation('delete')
    await expect(hooks.onMutationApplied!(async () => ({ rows: [] }), fact, identity)).rejects.toThrow('synthetic_enqueue_failure')
    await expect(hooks.afterCommit!(identity, [fact])).rejects.toThrow('RECOVERY_MUTATION_EVENT_BINDING_INVALID')
    expect(bus.emit).not.toHaveBeenCalled()
  })
  test('mixed identity batch is wholly refused before any emission', async () => {
    const bus = { emit: vi.fn() }
    const hooks = createRecoveryArchiveWorkerRecordEvents(bus)
    const one = mutation('revert')
    const two = mutation('delete')
    const query: QueryFn = async () => ({ rows: [] })
    await hooks.onMutationApplied!(query, one, identity)
    await hooks.onMutationApplied!(query, two, { ...identity, jobId: 'other' })
    await expect(hooks.afterCommit!(identity, [one, two])).rejects.toThrow('RECOVERY_MUTATION_EVENT_BINDING_INVALID')
    expect(bus.emit).not.toHaveBeenCalled()
  })
  test('HTTP and worker share the same event builder', async () => {
    const event = await enqueueRecoveryMutationEvent(async () => ({ rows: [] }), 'sheet', 'actor', mutation('delete'))
    expect(event).toEqual({ type: 'multitable.record.deleted', payload: { sheetId: 'sheet', recordId: 'record', actorId: 'actor', _eventId: expect.any(String) } })
  })
})
