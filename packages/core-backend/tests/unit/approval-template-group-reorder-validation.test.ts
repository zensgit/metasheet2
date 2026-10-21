import { describe, expect, it } from 'vitest'
import { validateApprovalTemplateGroupReorderIds } from '../../src/services/ApprovalTemplateGroupReorderService'
import { ServiceError } from '../../src/services/ApprovalBridgeService'

/**
 * Approval form grouping lock v2.13, §3 I3 / §4 acceptance E (phase-3 leg) / task brief "排列
 * 缺项/多项/含归档组 ⇒ 400 专用错误码". This is the pure, DB-free half of that requirement — the
 * SET-equality check itself; the L0 critical section and the actual `sort_order` writes are
 * exercised by the real-DB acceptance test (a later unit in this slice).
 */
describe('validateApprovalTemplateGroupReorderIds (lock §3 I3 / §4 row E phase-3 leg)', () => {
  it('accepts an exact permutation of the active id set', () => {
    expect(() =>
      validateApprovalTemplateGroupReorderIds(['b', 'a', 'c'], ['a', 'b', 'c']),
    ).not.toThrow()
  })

  it('accepts the empty permutation when the org has zero active groups', () => {
    expect(() => validateApprovalTemplateGroupReorderIds([], [])).not.toThrow()
  })

  it('rejects a missing id (fewer entries than the active set)', () => {
    expect(() => validateApprovalTemplateGroupReorderIds(['a'], ['a', 'b'])).toThrow(ServiceError)
  })

  it('rejects an extra id not in the active set', () => {
    expect(() => validateApprovalTemplateGroupReorderIds(['a', 'b', 'zzz'], ['a', 'b'])).toThrow(ServiceError)
  })

  it('rejects a duplicated id even when every element individually belongs to the active set', () => {
    expect(() => validateApprovalTemplateGroupReorderIds(['a', 'a'], ['a', 'b'])).toThrow(ServiceError)
  })

  it('rejects an archived group id (absent from the caller-supplied active set)', () => {
    // The caller is expected to pass ONLY `archived_at IS NULL` ids as `activeIds` — an archived
    // group's id is therefore indistinguishable here from any other id foreign to this org.
    expect(() => validateApprovalTemplateGroupReorderIds(['a', 'archived-1'], ['a', 'b'])).toThrow(ServiceError)
  })

  it('raises the dedicated GROUP_REORDER_SET_MISMATCH code, not a bare 400', () => {
    try {
      validateApprovalTemplateGroupReorderIds(['a'], ['a', 'b'])
      throw new Error('expected validateApprovalTemplateGroupReorderIds to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError)
      expect((error as ServiceError).code).toBe('GROUP_REORDER_SET_MISMATCH')
      expect((error as ServiceError).statusCode).toBe(400)
    }
  })
})
