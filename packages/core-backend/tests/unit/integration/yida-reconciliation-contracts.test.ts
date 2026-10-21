import { it, expect } from 'vitest'
import { checkedReconciliationInput, reconciliationErrorCode } from '../../../src/integration/yida-reconciliation-contracts'
const base = () => ({ commandKey: '11111111-1111-4111-8111-111111111111', expectedHeadSequence: 0,
  conclusion: 'inconclusive', reason: 'NO_OBSERVATION', evidenceKind: null, evidenceRef: null, evidenceSha256: null,
  claimedObservedAt: null, supersedesObservationId: null })
it('captures only exact data properties without executing getters, proxies or serialization hooks', () => {
  let calls = 0
  const accessor = Object.defineProperty(base(), 'evidenceKind', { enumerable: true, get() { calls++; return null } })
  const proxy = new Proxy(base(), { get() { calls++; return null } })
  for (const value of [accessor, proxy, { ...base(), toJSON() { calls++; return {} } }]) {
    expect(() => checkedReconciliationInput(value)).toThrow('YIDA_RECONCILIATION_INPUT')
  }
  expect(calls).toBe(0); expect(checkedReconciliationInput(base())).toEqual(base())
})
it('rejects scalar coercion, mismatched reasons, private fields and invalid clock claims', () => {
  for (const patch of [{ evidenceKind: ['operator_receipt'], evidenceRef: 'SYN', evidenceSha256: 'a'.repeat(64) },
    { conclusion: 'observed_match' }, { reason: 'CORRECTION' }, { claimedObservedAt: '2026-02-31T00:00:00.000Z' },
    { expectedHeadSequence: '0' }, { tenantId: 'SYN' }, { token: 'SYN' }, { commandKey: 'not-an-id' }]) {
    expect(() => checkedReconciliationInput({ ...base(), ...patch })).toThrow('YIDA_RECONCILIATION_INPUT')
  }
  expect(reconciliationErrorCode(new Proxy({}, { get() { throw new Error('MUST_NOT_READ') } }))).toBeUndefined()
})
