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

  // Round 2 narrowed the failure clear to CROSS-INSTANCE only, and this test was rewritten to say
  // so. Its first version asserted `activeApproval === null` after a SAME-id failure, which froze a
  // rule wider than the one instance consistency needs: the cross-instance case is already covered
  // by the synchronous switch clear (see the test below — the slot is empty before the request is
  // even sent), so the unconditional clear's only observable effect was to blank a correctly
  // displayed instance whenever its own retry or post-action refresh hit a transient error. Nothing
  // about "which instance is this?" is answered by throwing away the instance the reader is on and
  // that both the route and the response agree about.
  it('a failed reload of the SAME instance keeps it and surfaces the error over it', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')
    expect(store.activeApproval?.id).toBe('apv_a')

    getApprovalMock.mockRejectedValueOnce(new Error('该审批暂时无法加载'))
    await store.loadDetail('apv_a')

    expect(store.activeApproval?.id).toBe('apv_a')
    expect(store.error).toBe('该审批暂时无法加载')
    expect(store.detailLoading).toBe(false)
  })

  it('a failed load for ANOTHER instance leaves no stale instance and surfaces the error', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')
    expect(store.activeApproval?.id).toBe('apv_a')

    getApprovalMock.mockRejectedValueOnce(new Error('该审批暂时无法加载'))
    await store.loadDetail('apv_b')

    expect(store.activeApproval).toBeNull()
    expect(store.error).toBe('该审批暂时无法加载')
    expect(store.detailLoading).toBe(false)
  })

  it('the first-ever load failing leaves nothing displayed', async () => {
    getApprovalMock.mockRejectedValueOnce(new Error('该审批暂时无法加载'))
    const store = useApprovalStore()

    await store.loadDetail('apv_a')

    expect(store.activeApproval).toBeNull()
    expect(store.error).toBe('该审批暂时无法加载')
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

  // Round 2. The generation alone cannot answer this one: a post-verb `loadHistory` for the
  // OUTGOING instance is the LATEST request, so it wins its own generation race and would first
  // empty the displayed instance's timeline (the switch clear at the top of the loader) and then
  // repopulate it with the outgoing instance's rows.
  it('a late refresh for an instance the page has left never replaces the displayed timeline', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_b'))
    getApprovalHistoryMock.mockResolvedValue([historyRow('apv_b')])
    const store = useApprovalStore()

    await store.loadDetail('apv_b')
    await store.loadHistory('apv_b')
    expect(store.history.map((row: any) => row.instanceId)).toEqual(['apv_b'])

    getApprovalHistoryMock.mockClear()
    getApprovalHistoryMock.mockResolvedValue([historyRow('apv_a')])
    await store.loadHistory('apv_a')
    await settle()

    expect(store.history.map((row: any) => row.instanceId)).toEqual(['apv_b'])
    // Refused outright — the request is not even issued for the instance that is not on screen.
    expect(getApprovalHistoryMock).not.toHaveBeenCalled()
  })

  // The displayed-instance guard reads `activeApproval.value.id`, and after a verb that slot holds
  // the ACTION's response DTO rather than the detail-load DTO. This pins the dependency that makes
  // the post-verb refresh work: the action response carries the id it was dispatched for (server
  // side, both dispatchAction implementations return getApproval(id, …), mapped as `id: row.id`).
  // Were that ever to stop holding, the post-verb timeline refresh would be skipped SILENTLY — no
  // error, no empty state, just rows that never gain the row the reader just created — so it is
  // pinned here rather than left implicit in a fixture.
  it('a post-verb refresh reaches the timeline through the action response DTO', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_b'))
    getApprovalHistoryMock.mockResolvedValue([historyRow('apv_b')])
    const store = useApprovalStore()
    await store.loadDetail('apv_b')
    await store.loadHistory('apv_b')

    dispatchActionMock.mockResolvedValueOnce(instance('apv_b', { status: 'approved' }))
    await store.executeAction('apv_b', { action: 'approve' } as any)
    expect(store.activeApproval?.id).toBe('apv_b')

    getApprovalHistoryMock.mockClear()
    getApprovalHistoryMock.mockResolvedValue([historyRow('apv_b'), { ...historyRow('apv_b'), id: 'hist_apv_b_2' }])
    await store.loadHistory('apv_b')

    expect(getApprovalHistoryMock).toHaveBeenCalledWith('apv_b')
    expect(store.history).toHaveLength(2)
  })

  it('positive control: a refresh for the DISPLAYED instance still replaces its rows', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_b'))
    getApprovalHistoryMock.mockResolvedValue([historyRow('apv_b')])
    const store = useApprovalStore()

    await store.loadDetail('apv_b')
    await store.loadHistory('apv_b')

    getApprovalHistoryMock.mockClear()
    getApprovalHistoryMock.mockResolvedValue([historyRow('apv_b'), { ...historyRow('apv_b'), id: 'hist_apv_b_2' }])
    await store.loadHistory('apv_b')

    expect(getApprovalHistoryMock).toHaveBeenCalledWith('apv_b')
    expect(store.history).toHaveLength(2)
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

  // Round 2: the same generation scoping now covers the SHARED failure surface, not just the DTO.
  it('an action that rejects after the page moved on still throws to its caller but raises no error on the new instance', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')

    const pendingAction = deferred<any>()
    dispatchActionMock.mockReturnValueOnce(pendingAction.promise)
    const action = store.executeAction('apv_a', { action: 'approve' } as any)

    getApprovalMock.mockResolvedValueOnce(instance('apv_b'))
    await store.loadDetail('apv_b')
    expect(store.activeApproval?.id).toBe('apv_b')

    pendingAction.reject(new Error('该操作已失效'))
    await expect(action).rejects.toThrow('该操作已失效')
    await settle()

    expect(store.activeApproval?.id).toBe('apv_b')
    expect(store.error).toBeNull()
  })

  it('positive control: an action that rejects while the page has NOT moved does raise the error', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')

    dispatchActionMock.mockRejectedValueOnce(new Error('该操作已失效'))
    await expect(store.executeAction('apv_a', { action: 'approve' } as any)).rejects.toThrow('该操作已失效')

    expect(store.error).toBe('该操作已失效')
    expect(store.loading).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Round 3 (B8) — a refresh of the SAME instance must not cost the verb its own result.
  //
  // The round-2 predicate was the detail request GENERATION captured before the await, which asks
  // "has any detail load started since?". A 重新加载 for the instance the reader is ON answers yes,
  // so the verb's own response — the freshest fact about that instance anywhere on the page — was
  // dropped while the caller still announced success, leaving 待处理 under 审批已通过. The predicate
  // is now the INSTANCE, and it is settle-order independent: whichever of the two lands last, the
  // action's response is the one that stays.
  // -------------------------------------------------------------------------
  it('a same-instance refresh that LANDED during the verb does not discard the verb result', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')

    const pendingAction = deferred<any>()
    dispatchActionMock.mockReturnValueOnce(pendingAction.promise)
    const action = store.executeAction('apv_a', { action: 'approve' } as any)

    // The reader clicks 重新加载 while the verb is still outstanding, and that read completes first
    // carrying the PRE-action row (it reached the server before the action committed).
    getApprovalMock.mockResolvedValueOnce(instance('apv_a', { status: 'pending' }))
    await store.loadDetail('apv_a')
    expect(store.activeApproval?.status).toBe('pending')

    pendingAction.resolve(instance('apv_a', { status: 'approved' }))
    await action
    await settle()

    expect(store.activeApproval?.id).toBe('apv_a')
    expect(store.activeApproval?.status).toBe('approved')
  })

  it('a same-instance refresh still IN FLIGHT when the verb published does not overwrite it', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')

    // The other settle order of the same race: the refresh is issued first and comes back LAST.
    const pendingRefresh = deferred<any>()
    getApprovalMock.mockReturnValueOnce(pendingRefresh.promise)
    const refresh = store.loadDetail('apv_a')

    dispatchActionMock.mockResolvedValueOnce(instance('apv_a', { status: 'approved' }))
    await store.executeAction('apv_a', { action: 'approve' } as any)
    expect(store.activeApproval?.status).toBe('approved')

    pendingRefresh.resolve(instance('apv_a', { status: 'pending' }))
    await refresh
    await settle()

    expect(store.activeApproval?.status).toBe('approved')
    // The refused read still owns — and clears — the flags it took.
    expect(store.detailLoading).toBe(false)
    expect(store.loading).toBe(false)
  })

  it('positive control: a refresh ISSUED after the action published does replace the row', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')

    dispatchActionMock.mockResolvedValueOnce(instance('apv_a', { status: 'approved' }))
    await store.executeAction('apv_a', { action: 'approve' } as any)
    expect(store.activeApproval?.status).toBe('approved')

    getApprovalMock.mockResolvedValueOnce(instance('apv_a', { status: 'approved', title: '刷新后的标题' }))
    await store.loadDetail('apv_a')
    await settle()

    expect(store.activeApproval?.title).toBe('刷新后的标题')
  })

  it('an action for an instance that is not the displayed one publishes nothing', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_b'))
    const store = useApprovalStore()
    await store.loadDetail('apv_b')

    dispatchActionMock.mockResolvedValueOnce(instance('apv_a', { status: 'approved' }))
    const result = await store.executeAction('apv_a', { action: 'approve' } as any)

    expect(result.status).toBe('approved')
    expect(store.activeApproval?.id).toBe('apv_b')
    expect(store.activeApproval?.status).toBe('pending')
    expect(store.error).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Round 3 (B12) — which instance's last detail read failed, as data.
  // -------------------------------------------------------------------------
  it('records the instance whose last detail read failed, and clears it on a successful retry', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')
    expect(store.detailErrorInstanceId).toBeNull()

    getApprovalMock.mockRejectedValueOnce(new Error('该审批暂时无法加载'))
    await store.loadDetail('apv_a')
    expect(store.detailErrorInstanceId).toBe('apv_a')
    // The instance itself is deliberately kept on screen (round 2), which is exactly why the
    // failure has to be recorded separately instead of being inferred from an empty slot.
    expect(store.activeApproval?.id).toBe('apv_a')

    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    await store.loadDetail('apv_a')
    expect(store.detailErrorInstanceId).toBeNull()
  })

  it('a retry that fails again re-records the failure rather than clearing it', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')

    getApprovalMock.mockRejectedValueOnce(new Error('该审批暂时无法加载'))
    await store.loadDetail('apv_a')
    expect(store.detailErrorInstanceId).toBe('apv_a')

    getApprovalMock.mockRejectedValueOnce(new Error('该审批暂时无法加载'))
    await store.loadDetail('apv_a')
    expect(store.detailErrorInstanceId).toBe('apv_a')
  })

  it('a failed TIMELINE fetch is not recorded as a failed detail read', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    getApprovalHistoryMock.mockRejectedValueOnce(new Error('加载审批历史失败'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')
    await store.loadHistory('apv_a')

    expect(store.error).toBe('加载审批历史失败')
    expect(store.detailErrorInstanceId).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Round 4 (B15) — the latch's LIFECYCLE, which is also the banner's.
  //
  // Round 3 cleared it at the START of every detail load, which made it a strictly weaker fact than
  // the one the view needs: the refusal it drives outlived the only thing that explained it (the
  // shared `error` string, nulled by every other loader/verb/dismiss) and the only thing that could
  // clear it. It is now released by exactly two events — a successful read of the instance it
  // names, or a load for a different one.
  // -------------------------------------------------------------------------
  async function latchApprovalA(store: ReturnType<typeof useApprovalStore>): Promise<void> {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    await store.loadDetail('apv_a')
    getApprovalMock.mockRejectedValueOnce(new Error('该审批暂时无法加载'))
    await store.loadDetail('apv_a')
    expect(store.detailErrorInstanceId).toBe('apv_a')
  }

  it('B15: the latch survives a same-id reload while it is IN FLIGHT and clears only when it succeeds', async () => {
    const store = useApprovalStore()
    await latchApprovalA(store)

    const pendingRetry = deferred<any>()
    getApprovalMock.mockReturnValueOnce(pendingRetry.promise)
    const retry = store.loadDetail('apv_a')
    await settle()
    // The retry has started and nulled the shared error string — the latch is what has to keep the
    // page refused (and its explanation on screen) until the retry actually lands.
    expect(store.error).toBeNull()
    expect(store.detailLoading).toBe(true)
    expect(store.detailErrorInstanceId).toBe('apv_a')

    pendingRetry.resolve(instance('apv_a'))
    await retry
    expect(store.detailErrorInstanceId).toBeNull()
  })

  it('B15: a load for ANOTHER instance drops the latch synchronously, before its response arrives', async () => {
    const store = useApprovalStore()
    await latchApprovalA(store)

    const pendingB = deferred<any>()
    getApprovalMock.mockReturnValueOnce(pendingB.promise)
    const bLoad = store.loadDetail('apv_b')
    // No await: the switch is synchronous, so nothing can act on a refusal that belongs to the
    // instance the reader has just left.
    expect(store.detailErrorInstanceId).toBeNull()
    expect(store.activeApproval).toBeNull()

    pendingB.resolve(instance('apv_b'))
    await bLoad
    expect(store.detailErrorInstanceId).toBeNull()
  })

  it('B15: the OTHER writers of the shared error string do not clear the latch', async () => {
    const store = useApprovalStore()
    await latchApprovalA(store)

    // Writer 1 — a timeline refresh's start. This is the no-user-action entry: a verb's own
    // post-action `loadHistory` nulls the error while the reader touches nothing.
    getApprovalHistoryMock.mockResolvedValueOnce([])
    await store.loadHistory('apv_a')
    expect(store.error).toBeNull()
    expect(store.detailErrorInstanceId).toBe('apv_a')

    // Writer 2 — a verb's start. Driven at the store directly: the view refuses to dispatch in this
    // state (that is the point of the latch), so this pins the STORE's contract, not a reachable
    // click. A promise that never settles isolates the start-of-verb write from any outcome.
    // That promise stays dangling for the rest of this test BY DESIGN, so `store.loading` is `true`
    // from here on — do not append `loading` assertions below it. It cannot reach the next test:
    // `beforeEach` installs a fresh pinia, so the store this closure holds is discarded with it.
    dispatchActionMock.mockReturnValueOnce(new Promise<any>(() => {}))
    void store.executeAction('apv_a', { action: 'comment', comment: '一条评论' } as any)
    await settle()
    expect(store.error).toBeNull()
    expect(store.detailErrorInstanceId).toBe('apv_a')
  })

  it('B15: a first-ever load that fails latches an instance that was never displayed, and the next load drops it', async () => {
    getApprovalMock.mockRejectedValueOnce(new Error('该审批暂时无法加载'))
    const store = useApprovalStore()
    await store.loadDetail('apv_b')
    expect(store.detailErrorInstanceId).toBe('apv_b')
    expect(store.activeApproval).toBeNull()

    // `activeApproval` is empty, so the switch clear above cannot be what drops it — the per-id
    // comparison is.
    getApprovalMock.mockResolvedValueOnce(instance('apv_c'))
    await store.loadDetail('apv_c')
    expect(store.detailErrorInstanceId).toBeNull()
    expect(store.activeApproval?.id).toBe('apv_c')
  })

  // -------------------------------------------------------------------------
  // Round 4 (B16) — the FAILURE path of a verb, against the same concurrent-read race the success
  // path is already pinned against. Two halves, matching the grid in `executeAction`'s doc:
  // surfaced iff the acted instance is still displayed (the two tests above this block), and not
  // swallowed / not resurrected by a read concurrent with it (the two below).
  // -------------------------------------------------------------------------
  it('B16: a same-id read in flight when the verb FAILS neither erases the failure nor loses its own row', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')

    // The reachable shape: a 重新加载 of the instance the reader is ON is still outstanding when the
    // verb rejects. Its START has already nulled the shared error string, which is precisely why a
    // read cannot swallow a failure that lands after it.
    const pendingRead = deferred<any>()
    getApprovalMock.mockReturnValueOnce(pendingRead.promise)
    const read = store.loadDetail('apv_a')
    await settle()
    expect(store.error).toBeNull()

    dispatchActionMock.mockRejectedValueOnce(new Error('该操作已失效'))
    await expect(store.executeAction('apv_a', { action: 'approve' } as any)).rejects.toThrow('该操作已失效')
    expect(store.error).toBe('该操作已失效')

    pendingRead.resolve(instance('apv_a', { currentStep: 2 }))
    await read
    await settle()

    // The read's own row lands — a failed verb publishes nothing, so there is no authoritative row
    // for it to defer to — and the failure it raced is still what the reader is being shown.
    expect(store.activeApproval?.currentStep).toBe(2)
    expect(store.error).toBe('该操作已失效')
    expect(store.detailErrorInstanceId).toBeNull()
  })

  it('B16: a verb failure that lands while the acted instance is being RE-READ is not resurrected on the re-read page', async () => {
    getApprovalMock.mockResolvedValueOnce(instance('apv_a'))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')

    const pendingAction = deferred<any>()
    dispatchActionMock.mockReturnValueOnce(pendingAction.promise)
    const action = store.executeAction('apv_a', { action: 'approve' } as any)

    // The reader leaves for B and navigates back: A is being re-read (nothing displayed) when the
    // verb from the earlier visit finally rejects. Nothing retains that failure, so the read that
    // completes AFTER it — and which therefore cannot clear the error string itself, having nulled
    // it at its start — must land on a clean surface.
    getApprovalMock.mockResolvedValueOnce(instance('apv_b'))
    await store.loadDetail('apv_b')
    const pendingA = deferred<any>()
    getApprovalMock.mockReturnValueOnce(pendingA.promise)
    const reread = store.loadDetail('apv_a')
    await settle()
    expect(store.activeApproval).toBeNull()

    pendingAction.reject(new Error('该操作已失效'))
    await expect(action).rejects.toThrow('该操作已失效')
    await settle()

    pendingA.resolve(instance('apv_a'))
    await reread
    expect(store.activeApproval?.id).toBe('apv_a')
    expect(store.error).toBeNull()
    expect(store.detailErrorInstanceId).toBeNull()
  })

  it('a superseded action does not clear the shared loading flag a newer detail load still owns', async () => {
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
    expect(store.loading).toBe(true)

    pendingAction.resolve(instance('apv_a', { status: 'approved' }))
    await action
    await settle()
    expect(store.loading).toBe(true)

    pendingB.resolve(instance('apv_b'))
    await bLoad
    expect(store.loading).toBe(false)
  })
})
