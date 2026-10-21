/** Boundary-only unit tests. Positive metadata authority is proven in real PG,
 * never by the inert dependencies used here to assert pre-IO input rejection. */
import { describe, expect, it } from 'vitest'
import { createAutomationReadAuthority, type AutomationReadAuthorityOptions } from '../../../src/integration/automation-read-authority'
import type { ReadSelector } from '../../../src/integration/automation-read-contracts'
import type { AutomationIntegrationActor } from '../../../src/integration/automation-live-authority'
import type { Queryable } from '../../../src/multitable/automation-durable-dispatcher'

const nonce = '11111111-1111-4111-8111-111111111111'
const actor: AutomationIntegrationActor = { actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null }
const selector: ReadSelector = { ruleId: 'synthetic-rule', actionId: 'synthetic-action', systemId: 'synthetic-source', targetId: nonce }
function options(): AutomationReadAuthorityOptions {
  const unused = () => { throw new Error('Fixture must not cross input boundary') }
  return { producer: { generation: '1', nonce }, budgetCeiling: { maxRows: 10, maxPages: 2, maxReadCount: 4, timeoutMs: 1000 },
    codec: { restoreStockPreparationAutomationProfileMaterial: unused,
      deriveAutomationReadTargetContract: unused, composeStockPreparationAutomationExecution: unused },
    sourceStore: { lockActiveForAutomation: async () => unused() } }
}
const invalid = { code: 'AUTOMATION_READ_INPUT_INVALID', message: 'AUTOMATION_READ_INPUT_INVALID' }
describe('Automation complete authority: exact boundary capture', () => {
  for (const key of ['producer', 'codec', 'sourceStore', 'budgetCeiling'] as const) {
    it.each([undefined, null, 1, 'x', [], new Date(0)])('rejects malformed options.' + key, value => {
      const candidate = { ...options(), [key]: value }
      expect(() => createAutomationReadAuthority(candidate as never)).toThrowError(expect.objectContaining(invalid))
    })
    it('does not invoke a getter for options.' + key, () => {
      let calls = 0
      const candidate = options()
      Object.defineProperty(candidate, key, { enumerable: true, get() { calls++; return options()[key] } })
      expect(() => createAutomationReadAuthority(candidate)).toThrowError(expect.objectContaining(invalid))
      expect(calls).toBe(0)
    })
  }
  it.each(['0', '-1', '1.1', ' 1', '9223372036854775808'])('rejects producer generation %s', generation => {
    const candidate = options(); candidate.producer = { generation, nonce }
    expect(() => createAutomationReadAuthority(candidate)).toThrowError(expect.objectContaining(invalid))
  })
  for (const key of ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs'] as const) {
    it.each([0, -1, 1.5, Infinity, 2147483648])('rejects host budget ' + key, value => {
      const candidate = options(); candidate.budgetCeiling[key] = value
      expect(() => createAutomationReadAuthority(candidate)).toThrowError(expect.objectContaining(invalid))
    })
  }
  it.each(['actorId', 'tenantId', 'workspaceId'])('does not invoke actor getter %s or begin IO', async key => {
    let queries = 0, hooks = 0
    const trx: Queryable = { async query() { queries++; throw new Error('Unexpected IO') } }
    const candidate = { ...actor }
    Object.defineProperty(candidate, key, { enumerable: true, get() { hooks++; return 'synthetic' } })
    await expect(createAutomationReadAuthority(options()).lockExecution(trx, candidate, selector)).rejects.toMatchObject(invalid)
    expect([queries, hooks]).toEqual([0, 0])
  })
  it.each(['ruleId', 'actionId', 'systemId', 'targetId'])('does not invoke selector getter %s or begin IO', async key => {
    let queries = 0, hooks = 0
    const trx: Queryable = { async query() { queries++; throw new Error('Unexpected IO') } }
    const candidate = { ...selector }
    Object.defineProperty(candidate, key, { enumerable: true, get() { hooks++; return 'synthetic' } })
    await expect(createAutomationReadAuthority(options()).lockExecution(trx, actor, candidate)).rejects.toMatchObject(invalid)
    expect([queries, hooks]).toEqual([0, 0])
  })
  it('does not leak failed transaction driver details', async () => {
    const trx: Queryable = { async query() { throw new Error('synthetic-private-driver-detail') } }
    const result = await createAutomationReadAuthority(options()).lockExecution(trx, actor, selector).catch(error => error)
    expect(result).toMatchObject({ code: 'AUTOMATION_READ_TRANSACTION_REQUIRED', message: 'AUTOMATION_READ_TRANSACTION_REQUIRED' })
    expect(result).not.toHaveProperty('cause')
    expect(String(result)).not.toContain('synthetic-private')
  })
  it('history captures the original exact reference before any IO', async () => {
    let queries = 0, hooks = 0
    const trx: Queryable = { async query() { queries++; throw new Error('Unexpected IO') } }
    const reference = { connectionId: 'synthetic-connection', connectionIncarnation: nonce }
    Object.defineProperty(reference, 'connectionId', { enumerable: true, get() { hooks++; return 'synthetic' } })
    await expect(createAutomationReadAuthority(options()).lockObservation(trx, actor, reference)).rejects.toMatchObject(invalid)
    expect([queries, hooks]).toEqual([0, 0])
  })

  it.each(['actorId', 'tenantId', 'workspaceId'])('record preparation rejects actor getter %s before IO', async key => {
    let queries = 0, hooks = 0
    const trx: Queryable = { async query() { queries++; throw new Error('Unexpected IO') } }
    const candidate = { ...actor }
    Object.defineProperty(candidate, key, { enumerable: true, get() { hooks++; return 'synthetic' } })
    await expect(createAutomationReadAuthority(options()).lockRecordExecution(trx, candidate, selector)).rejects.toMatchObject(invalid)
    expect([queries, hooks]).toEqual([0, 0])
  })
  it.each(['ruleId', 'actionId', 'systemId', 'targetId'])('record preparation rejects selector getter %s before IO', async key => {
    let queries = 0, hooks = 0
    const trx: Queryable = { async query() { queries++; throw new Error('Unexpected IO') } }
    const candidate = { ...selector }
    Object.defineProperty(candidate, key, { enumerable: true, get() { hooks++; return 'synthetic' } })
    await expect(createAutomationReadAuthority(options()).lockRecordExecution(trx, actor, candidate)).rejects.toMatchObject(invalid)
    expect([queries, hooks]).toEqual([0, 0])
  })
  it.each([null, undefined, {}, [], { ...selector, extra: true }, { ...selector, targetId: ' ' }])(
    'record preparation rejects malformed closed selector before IO %#', async candidate => {
      let queries = 0
      const trx: Queryable = { async query() { queries++; throw new Error('Unexpected IO') } }
      await expect(createAutomationReadAuthority(options()).lockRecordExecution(trx, actor, candidate as never)).rejects.toMatchObject(invalid)
      expect(queries).toBe(0)
    },
  )
  it('record preparation does not expose transaction driver errors', async () => {
    const trx: Queryable = { async query() { throw new Error('synthetic-private-driver-detail') } }
    const result = await createAutomationReadAuthority(options()).lockRecordExecution(trx, actor, selector).catch(error => error)
    expect(result).toMatchObject({ code: 'AUTOMATION_READ_TRANSACTION_REQUIRED', message: 'AUTOMATION_READ_TRANSACTION_REQUIRED' })
    expect(result).not.toHaveProperty('cause')
    expect(String(result)).not.toContain('synthetic-private')
  })
  it('ordinary-shaped, copied and decorated proof data cannot supply a private condition context', async () => {
    let queries = 0, hooks = 0
    const trx: Queryable = { async query() { queries++; throw new Error('Unexpected IO') } }
    const port = createAutomationReadAuthority(options())
    // Boundary-only shapes, NOT minted authority evidence. The real-PG suite separately checks an
    // actual lockExecution proof and a copy of an actual lockRecordExecution proof.
    const shape = Object.freeze({ ...actor, key: 'a'.repeat(64), budget: options().budgetCeiling,
      sourceReference: { connectionId: 'synthetic-connection', connectionIncarnation: nonce },
      allowedTriggers: ['manual', 'record'] })
    const decorated = Object.defineProperty({ ...shape }, 'conditionContext', { enumerable: true, get() { hooks++; return {} } })
    for (const proof of [shape, { ...shape }, JSON.parse(JSON.stringify(shape)), decorated, null, undefined, 1]) {
      expect(() => port.recordConditionFor(proof as never)).toThrow('AUTOMATION_READ_DENIED')
      expect(await port.evaluateRecordConditions(trx, proof as never, {
        outboxId: 'synthetic-outbox', eventId: 'synthetic-event', eventType: 'multitable.record.created',
      })).toEqual({ kind: 'unreadable', reason: 'CONTEXT_INVALID' })
    }
    expect([queries, hooks]).toEqual([0, 0])
  })
})
