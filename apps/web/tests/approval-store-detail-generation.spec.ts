import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ---------------------------------------------------------------------------
// Approval store — detail/history instance consistency (2026-09-06).
//
// `loadDetail`/`loadHistory` are re-entrant: a detail→detail navigation starts a second request
// while the first is still in flight and the two can settle in either order. These tests pin the
// three rules that make the store's state answer "which instance is this?" unambiguously:
//
//   1. Request generation — a superseded response never overwrites a newer one (state, error and
//      the in-flight flag alike). Positive control: the SAME response, un-superseded, does land.
//   2. Switch clears — moving to another instance drops the outgoing one synchronously, before the
//      incoming response arrives, so nothing can render (or act on) the previous instance.
//   3. Failure clears — a failed load leaves NO instance behind, so an error is never shown over
//      another instance's data.
//
// The api layer is mocked per-id through a deferred registry so response ORDER is chosen by the
// test rather than by timing.
// ---------------------------------------------------------------------------

const getApprovalMock = vi.fn()
const getApprovalHistoryMock = vi.fn()
const dispatchActionMock = vi.fn()

vi.mock('../src/approvals/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/api')>()
  return {
    ...actual,
    getApproval: (...args: unknown[]) => getApprovalMock(...args),
    getApprovalHistory: (...args: unknown[]) => getApprovalHistoryMock(...args),
    dispatchAction: (...args: unknown[]) => dispatchActionMock(...args),
  }
})

import { useApprovalStore } from '../src/approvals/store'

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolvePromise = res
    rejectPromise = rej
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function instance(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    title: `审批 ${id}`,
    status: 'pending',
    requestNo: `AP-${id}`,
    requester: { id: 'user_99', name: '张三' },
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  }
}

function historyRow(id: string): any {
  return { id: `hist_${id}`, instanceId: id, action: 'submit', comment: `记录-${id}` }
}

// Let every queued microtask (and the awaits chained on it) settle.
async function settle(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) await Promise.resolve()
}

describe('approval store — detail request generation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getApprovalMock.mockReset()
    getApprovalHistoryMock.mockReset()
    dispatchActionMock.mockReset()
    getApprovalHistoryMock.mockResolvedValue([])
  })

  it('positive control: an un-superseded response becomes the active detail', async () => {
    getApprovalMock.mockResolvedValue(instance('apv_a'))
    const store = useApprovalStore()

    await store.loadDetail('apv_a')

    expect(store.activeApproval?.id).toBe('apv_a')
    expect(store.detailLoading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('out-of-order responses: the newer instance wins and the slower older one is discarded', async () => {
    const slowA = deferred<any>()
    const fastB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (id === 'apv_a' ? slowA.promise : fastB.promise))
    const store = useApprovalStore()

    const aLoad = store.loadDetail('apv_a')
    const bLoad = store.loadDetail('apv_b')

    fastB.resolve(instance('apv_b'))
    await bLoad
    expect(store.activeApproval?.id).toBe('apv_b')

    // A's response arrives LAST. Without the generation it would overwrite B.
    slowA.resolve(instance('apv_a'))
    await aLoad
    await settle()

    expect(store.activeApproval?.id).toBe('apv_b')
    expect(getApprovalMock).toHaveBeenCalledTimes(2)
  })

  it('a superseded response does not clear the in-flight flag of the newer load', async () => {
    const slowA = deferred<any>()
    const slowB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (id === 'apv_a' ? slowA.promise : slowB.promise))
    const store = useApprovalStore()

    const aLoad = store.loadDetail('apv_a')
    const bLoad = store.loadDetail('apv_b')
    expect(store.detailLoading).toBe(true)

    slowA.resolve(instance('apv_a'))
    await aLoad
    await settle()
    expect(store.detailLoading).toBe(true)

    slowB.resolve(instance('apv_b'))
    await bLoad
    expect(store.detailLoading).toBe(false)
  })

  it('switching instances drops the outgoing detail before the incoming response arrives', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')
    expect(store.activeApproval?.id).toBe('apv_a')

    const pendingB = deferred<any>()
    getApprovalMock.mockReturnValueOnce(pendingB.promise)
    const bLoad = store.loadDetail('apv_b')
    await settle()

    expect(store.activeApproval).toBeNull()
    expect(store.detailLoading).toBe(true)

    pendingB.resolve(instance('apv_b'))
    await bLoad
    expect(store.activeApproval?.id).toBe('apv_b')
  })

  it('a same-id reload keeps the current detail on screen while it is in flight (refresh, not a switch)', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')

    const pendingRefresh = deferred<any>()
    getApprovalMock.mockReturnValueOnce(pendingRefresh.promise)
    const refresh = store.loadDetail('apv_a')
    await settle()

    expect(store.activeApproval?.id).toBe('apv_a')

    pendingRefresh.resolve(instance('apv_a', { title: '审批 apv_a（已刷新）' }))
    await refresh
    expect(store.activeApproval?.title).toBe('审批 apv_a（已刷新）')
  })

  it('a failed load leaves no stale instance and surfaces the error', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')
    expect(store.activeApproval?.id).toBe('apv_a')

    getApprovalMock.mockRejectedValueOnce(new Error('该审批暂时无法加载'))
    await store.loadDetail('apv_a')

    expect(store.activeApproval).toBeNull()
    expect(store.error).toBe('该审批暂时无法加载')
    expect(store.detailLoading).toBe(false)
  })

  it('a superseded FAILURE neither clears nor errors over the newer successful load', async () => {
    const slowA = deferred<any>()
    const fastB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (id === 'apv_a' ? slowA.promise : fastB.promise))
    const store = useApprovalStore()

    const aLoad = store.loadDetail('apv_a')
    const bLoad = store.loadDetail('apv_b')

    fastB.resolve(instance('apv_b'))
    await bLoad

    slowA.reject(new Error('该审批暂时无法加载'))
    await aLoad
    await settle()

    expect(store.activeApproval?.id).toBe('apv_b')
    expect(store.error).toBeNull()
  })
})

describe('approval store — history request generation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getApprovalMock.mockReset()
    getApprovalHistoryMock.mockReset()
    dispatchActionMock.mockReset()
  })

  it('positive control: an un-superseded history response becomes the timeline', async () => {
    getApprovalHistoryMock.mockResolvedValue([historyRow('apv_a')])
    const store = useApprovalStore()

    await store.loadHistory('apv_a')

    expect(store.history.map((row: any) => row.instanceId)).toEqual(['apv_a'])
  })

  it('switching instances empties the timeline immediately and a slower older response never repopulates it', async () => {
    const slowA = deferred<any>()
    const fastB = deferred<any>()
    getApprovalHistoryMock.mockImplementation((id: string) => (id === 'apv_a' ? slowA.promise : fastB.promise))
    const store = useApprovalStore()

    const aLoad = store.loadHistory('apv_a')
    slowA.resolve([historyRow('apv_a')])
    await aLoad
    expect(store.history).toHaveLength(1)

    const stillSlowA = deferred<any>()
    const stillFastB = deferred<any>()
    getApprovalHistoryMock.mockImplementation((id: string) => (id === 'apv_a' ? stillSlowA.promise : stillFastB.promise))

    const secondA = store.loadHistory('apv_a')
    const secondB = store.loadHistory('apv_b')
    await settle()
    expect(store.history).toHaveLength(0)

    stillFastB.resolve([historyRow('apv_b')])
    await secondB
    expect(store.history.map((row: any) => row.instanceId)).toEqual(['apv_b'])

    stillSlowA.resolve([historyRow('apv_a')])
    await secondA
    await settle()

    expect(store.history.map((row: any) => row.instanceId)).toEqual(['apv_b'])
  })
})

describe('approval store — executeAction result publication', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getApprovalMock.mockReset()
    getApprovalHistoryMock.mockReset()
    dispatchActionMock.mockReset()
    getApprovalHistoryMock.mockResolvedValue([])
  })

  it('positive control: the action result becomes the active detail when the page has not moved', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    dispatchActionMock.mockResolvedValueOnce(instance('apv_a', { status: 'approved' }))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')

    const result = await store.executeAction('apv_a', { action: 'approve' } as any)

    expect(result.status).toBe('approved')
    expect(store.activeApproval?.status).toBe('approved')
  })

  it('an action that resolves after the page moved on returns its result without publishing it', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')

    const pendingAction = deferred<any>()
    dispatchActionMock.mockReturnValueOnce(pendingAction.promise)
    const action = store.executeAction('apv_a', { action: 'approve' } as any)

    const pendingB = deferred<any>()
    getApprovalMock.mockReturnValueOnce(pendingB.promise)
    const bLoad = store.loadDetail('apv_b')
    await settle()

    pendingAction.resolve(instance('apv_a', { status: 'approved' }))
    const result = await action
    await settle()

    expect(result.status).toBe('approved')
    expect(store.activeApproval).toBeNull()

    pendingB.resolve(instance('apv_b'))
    await bLoad
    expect(store.activeApproval?.id).toBe('apv_b')
  })
})
