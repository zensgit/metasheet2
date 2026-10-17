import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationReadLedgerDependencies } from '../../../src/integration/automation-read-contracts'
import { lockAutomationReadSourceObservation } from '../../../src/integration/automation-read-source-observation'

const factory = vi.hoisted(() => vi.fn())
vi.mock('../../../src/integration/automation-read-ledger', () => ({ createAutomationReadLedger: factory }))
import { createAutomationReadManagement } from '../../../src/integration/automation-read-management'

const actor = { actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null }
const id = '11111111-1111-4111-8111-111111111111'
const methods = ['grantDetail', 'listGrants', 'listRequests', 'observe', 'retryContext', 'cancel', 'revoke'] as const
describe('host-private management lifetime (explicit ledger doubles)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  function setup() {
    const ledger = Object.fromEntries(methods.map(method => [method, vi.fn().mockResolvedValue({ fixed: true })]))
    factory.mockReturnValue(ledger)
    const transaction = vi.fn() as unknown as AutomationReadLedgerDependencies['transaction']
    const management = createAutomationReadManagement({ transaction, manifest: { version: 4, routes: {} } })
    return { ledger, management }
  }
  it('uses the real observation guard, never exposes execution or grant creation', async () => {
    const { management } = setup()
    const deps = factory.mock.calls[0][0]
    expect(deps.authority.lockObservation).toBe(lockAutomationReadSourceObservation)
    await expect(deps.authority.lockExecution()).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    expect(Object.keys(management).sort()).toEqual([...methods, 'stop'].sort())
  })
  it.each(methods)('%s works without an active plugin and drains before server shutdown', async method => {
    const { ledger, management } = setup()
    // Both the admitted and (mutant-only) wrongly admitted call are controllable.
    // Never await a forbidden call before cleanup: an admission mutant must fail
    // on a second ledger invocation, not hang until the test timeout.
    let finishFirst!: () => void, finishSecond!: () => void
    const first = new Promise<void>(resolve => { finishFirst = resolve })
    const second = new Promise<void>(resolve => { finishSecond = resolve })
    ledger[method].mockImplementationOnce(() => first).mockImplementationOnce(() => second)
    const input = method === 'listGrants' || method === 'listRequests' ? { limit: 20 } : id
    // The runtime union has different typed input contracts; this explicit
    // lifecycle test varies only the fixed method/argument pair, not authority.
    const call = management[method] as (a: typeof actor, value: typeof input) => Promise<unknown>
    const task = call(actor, input)
    await Promise.resolve()
    expect(ledger[method]).toHaveBeenCalledWith(actor, input)
    let stopped = false
    const stopping = management.stop().then(() => { stopped = true })
    let later: unknown = 'pending'
    const refused = call(actor, input).then(() => { later = 'fulfilled' }, error => { later = error?.code })
    try {
      // Bounded microtask sampling, not a sleep/deadline oracle. These doubles
      // never settle either admitted operation until this test releases them.
      for (let turn = 0; turn < 8; turn++) await Promise.resolve()
      expect(ledger[method]).toHaveBeenCalledTimes(1)
      expect(later).toBe('AUTOMATION_READ_UNAVAILABLE')
      expect(stopped).toBe(false)
    } finally {
      finishFirst(); finishSecond()
      await Promise.allSettled([task, refused, stopping])
      await management.stop()
    }
    expect(stopped).toBe(true)
  })
  it('rejected operations do not prevent shutdown from draining', async () => {
    const { ledger, management } = setup()
    ledger.observe.mockRejectedValue(new Error('synthetic-failure'))
    await expect(management.observe(actor, id)).rejects.toThrow('synthetic-failure')
    await expect(management.stop()).resolves.toBeUndefined()
  })
  it('retry context returns the original observation receipt without ordinary observe or execution fallback', async () => {
    const { ledger, management } = setup()
    // The ledger, not this observation-only lifecycle double, proves the actual
    // parent/grant/link snapshot and that running requests are not reconciled.
    const receipt = Object.freeze({ request: { requestId: id, status: 'running' }, nextAttempt: null })
    ledger.retryContext.mockResolvedValueOnce(receipt)
    expect(await management.retryContext(actor, id)).toBe(receipt)
    expect(ledger.retryContext).toHaveBeenCalledTimes(1)
    expect(ledger.retryContext).toHaveBeenCalledWith(actor, id)
    for (const method of methods) if (method !== 'retryContext') expect(ledger[method]).not.toHaveBeenCalled()
    expect(management).not.toHaveProperty('retry')
    expect(management).not.toHaveProperty('submit')
    expect(management).not.toHaveProperty('execute')
  })
  it('retry context preserves refusal identity and still drains server shutdown', async () => {
    const { ledger, management } = setup(), refusal = new Error('synthetic-observation-refusal')
    ledger.retryContext.mockRejectedValueOnce(refusal)
    await expect(management.retryContext(actor, id)).rejects.toBe(refusal)
    await expect(management.stop()).resolves.toBeUndefined()
    await expect(management.retryContext(actor, id)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(ledger.retryContext).toHaveBeenCalledTimes(1)
    expect(ledger.observe).not.toHaveBeenCalled()
  })
})
