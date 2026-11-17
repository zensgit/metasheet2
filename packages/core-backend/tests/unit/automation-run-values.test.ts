/**
 * C1/S2 first slice — S01 / S03 on the per-run value store (multitable/automation-run-values.ts).
 * Cross-run and cross-tenant handles, forward references, undeclared columns, dangerous keys and any
 * consumer other than the allowlisted YiDa preview are refused; dispose revokes every handle.
 */
import { describe, expect, it, vi } from 'vitest'
import { createRunValueStore, isRunValueStoreError } from '../../src/multitable/automation-run-values'
import { createYidaSyntheticPreviewConsumer } from '../../src/integration/yida-automation-preview'

const PLAN = {
  stepOrder: ['read-materials', 'yida-preview'],
  outputs: [{ stepId: 'read-materials', output: 'materialRows', columns: ['projectNo', 'componentCode'], consumers: ['yida.preview.synthetic.v1'] }],
}
const REF = { fromStep: 'read-materials', output: 'materialRows', columns: ['projectNo', 'componentCode'] }
const ROW = { projectNo: 'SYN-P1', componentCode: 'SYN-DRW-001' }
const scopeA = { runId: 'run-a', tenantId: 'tenant-a' }

function code(fn: () => unknown): string | undefined {
  try { fn() } catch (error) { return isRunValueStoreError(error) ? error.code : 'FOREIGN_ERROR' }
  return 'NO_ERROR'
}

describe('S01 — references', () => {
  it('the declared consumer resolves a deep-frozen projection of the declared columns', () => {
    const store = createRunValueStore(scopeA, PLAN)
    const handle = store.publish('read-materials', 'materialRows', [ROW])
    const rows = store.resolveForConsumer(handle, REF, 'yida.preview.synthetic.v1', 'yida-preview', scopeA)
    expect(rows).toEqual([ROW])
    expect(Object.isFrozen(rows)).toBe(true)
    expect(Object.isFrozen(rows[0])).toBe(true)
    const narrowed = store.resolveForConsumer(handle, { ...REF, columns: ['projectNo'] }, 'yida.preview.synthetic.v1', 'yida-preview', scopeA)
    expect(narrowed).toEqual([{ projectNo: 'SYN-P1' }])
  })

  it('a handle from another run or another tenant does not resolve, nor does a forged handle or string id', () => {
    const storeA = createRunValueStore(scopeA, PLAN)
    const storeB = createRunValueStore({ runId: 'run-b', tenantId: 'tenant-b' }, PLAN)
    const handleB = storeB.publish('read-materials', 'materialRows', [ROW])
    storeA.publish('read-materials', 'materialRows', [ROW])
    expect(code(() => storeA.resolveForConsumer(handleB, REF, 'yida.preview.synthetic.v1', 'yida-preview', scopeA))).toBe('RUN_VALUE_FOREIGN_REF')
    expect(code(() => storeA.resolveForConsumer({ kind: 'run-value-ref' }, REF, 'yida.preview.synthetic.v1', 'yida-preview', scopeA))).toBe('RUN_VALUE_FOREIGN_REF')
    expect(code(() => storeA.resolveForConsumer('read-materials', REF, 'yida.preview.synthetic.v1', 'yida-preview', scopeA))).toBe('RUN_VALUE_FOREIGN_REF')
    // Same store, but the caller claims another run or tenant.
    const storeC = createRunValueStore(scopeA, PLAN)
    const handleC = storeC.publish('read-materials', 'materialRows', [ROW])
    expect(code(() => storeC.resolveForConsumer(handleC, REF, 'yida.preview.synthetic.v1', 'yida-preview', { runId: 'run-a', tenantId: 'tenant-b' }))).toBe('RUN_VALUE_FOREIGN_REF')
    expect(code(() => storeC.resolveForConsumer(handleC, REF, 'yida.preview.synthetic.v1', 'yida-preview', { runId: 'run-x', tenantId: 'tenant-a' }))).toBe('RUN_VALUE_FOREIGN_REF')
  })

  it('a forward reference (consumer not after the producer) and an unpublished output are refused', () => {
    const store = createRunValueStore(scopeA, PLAN)
    const handle = store.publish('read-materials', 'materialRows', [ROW])
    expect(code(() => store.resolveForConsumer(handle, REF, 'yida.preview.synthetic.v1', 'read-materials', scopeA))).toBe('RUN_VALUE_FORWARD_REF')
    expect(code(() => store.resolveForConsumer(handle, REF, 'yida.preview.synthetic.v1', 'unknown-step', scopeA))).toBe('RUN_VALUE_FORWARD_REF')
  })

  it('undeclared outputs, undeclared or dangerous columns, and duplicate publication are refused', () => {
    const store = createRunValueStore(scopeA, PLAN)
    expect(code(() => store.publish('yida-preview', 'materialRows', [ROW]))).toBe('RUN_VALUE_UNDECLARED')
    expect(code(() => store.publish('read-materials', 'otherRows', [ROW]))).toBe('RUN_VALUE_UNDECLARED')
    const handle = store.publish('read-materials', 'materialRows', [ROW])
    expect(code(() => store.publish('read-materials', 'materialRows', [ROW]))).toBe('RUN_VALUE_DUPLICATE')
    for (const column of ['secret', '__proto__', 'constructor']) {
      expect(code(() => store.resolveForConsumer(handle, { ...REF, columns: [column] }, 'yida.preview.synthetic.v1', 'yida-preview', scopeA))).toBe('RUN_VALUE_UNDECLARED')
    }
  })

  it('only a finite JSON domain on exactly the declared columns is accepted', () => {
    const fresh = () => createRunValueStore(scopeA, PLAN)
    const dangerous = JSON.parse('{"projectNo":"SYN-P1","__proto__":{"polluted":true}}')
    const cases: unknown[] = [
      [dangerous],
      [{ ...ROW, extra: 'x' }],
      [{ projectNo: 'SYN-P1' }],
      [{ ...ROW, componentCode: { nested: 'x' } }],
      [{ ...ROW, componentCode: Number.NaN }],
      [{ ...ROW, componentCode: () => 'x' }],
      [Object.defineProperty({ projectNo: 'SYN-P1' }, 'componentCode', { enumerable: true, get: () => 'x' })],
      [new (class Row { projectNo = 'a'; componentCode = 'b' })()],
      'not-an-array',
    ]
    for (const rows of cases) expect(code(() => fresh().publish('read-materials', 'materialRows', rows))).toBe('RUN_VALUE_INPUT')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it.each(['send_webhook', 'record.write', 'update_record', 'yida.send', 'yida.prepareDraft', 'integration_read_preview'])(
    'consumer %s is refused, and no business call happens', (consumer) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const compile = vi.fn()
      const store = createRunValueStore(scopeA, PLAN)
      const handle = store.publish('read-materials', 'materialRows', [ROW])
      expect(code(() => {
        const rows = store.resolveForConsumer(handle, REF, consumer, 'yida-preview', scopeA)
        createYidaSyntheticPreviewConsumer(compile).consume(rows, {} as never)
      })).toBe('RUN_VALUE_CONSUMER_DENIED')
      expect(compile).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      fetchSpy.mockRestore()
    },
  )
})

describe('S03 — dispose', () => {
  it('dispose drops every value and revokes every handle; nothing can be published afterwards', () => {
    const store = createRunValueStore(scopeA, PLAN)
    const handle = store.publish('read-materials', 'materialRows', [ROW, ROW])
    expect(store.counts()).toEqual({ outputs: 1, rows: 2 })
    store.dispose()
    expect(store.disposed).toBe(true)
    expect(store.counts()).toEqual({ outputs: 0, rows: 0 })
    expect(code(() => store.resolveForConsumer(handle, REF, 'yida.preview.synthetic.v1', 'yida-preview', scopeA))).toBe('RUN_VALUE_DISPOSED')
    expect(code(() => store.publish('read-materials', 'materialRows', [ROW]))).toBe('RUN_VALUE_DISPOSED')
  })

  it('the store and its handles are frozen and expose no value through enumeration', () => {
    const store = createRunValueStore(scopeA, PLAN)
    const handle = store.publish('read-materials', 'materialRows', [ROW])
    expect(Object.isFrozen(store)).toBe(true)
    expect(Object.isFrozen(handle)).toBe(true)
    expect(JSON.stringify(handle)).not.toContain('SYN-')
    expect(JSON.stringify(store)).not.toContain('SYN-')
  })
})
