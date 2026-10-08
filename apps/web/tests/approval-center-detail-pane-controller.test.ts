import { describe, expect, it, vi } from 'vitest'

import { createDetailPaneController, type DetailPaneState } from '../src/approvals/approvalCenterDetailPaneController'
import type { UnifiedApprovalDTO } from '../src/types/approval'

// UI-7 (approval-parity-master-design-lock-20260817.md §4 UI-7) — race-guard semantics for the
// approval center's desktop master-detail pane. Mirrors
// `approval-route-preview-controller.test.ts`'s test shape for its sibling
// `routePreviewController.ts` (same generation-counter idiom).

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function approval(id: string): UnifiedApprovalDTO {
  return {
    id,
    sourceSystem: 'platform',
    externalApprovalId: null,
    workflowKey: null,
    businessKey: null,
    title: `审批 ${id}`,
    status: 'pending',
    requester: null,
    subject: null,
    policy: null,
    currentStep: 1,
    totalSteps: 2,
    currentNodeKey: 'node_1',
    assignments: [],
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  }
}

function collector() {
  const state: DetailPaneState = { approval: null, loading: false, error: '' }
  const apply = (patch: Partial<DetailPaneState>) => {
    if ('approval' in patch) state.approval = patch.approval ?? null
    if (patch.loading !== undefined) state.loading = patch.loading
    if (patch.error !== undefined) state.error = patch.error
  }
  return { state, apply }
}

describe('createDetailPaneController — race guard', () => {
  it('commits the result when nothing invalidated it', async () => {
    const d = deferred<UnifiedApprovalDTO>()
    const { state, apply } = collector()
    const ctrl = createDetailPaneController(() => d.promise, apply)
    const p = ctrl.select('apv_1')
    expect(state.loading).toBe(true)
    d.resolve(approval('apv_1'))
    await p
    expect(state.loading).toBe(false)
    expect(state.approval?.id).toBe('apv_1')
  })

  it('fetches exactly once per select() call', async () => {
    const fetcher = vi.fn().mockResolvedValue(approval('apv_1'))
    const { apply } = collector()
    const ctrl = createDetailPaneController(fetcher, apply)
    await ctrl.select('apv_1')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('apv_1')
  })

  it('DISCARDS a stale response when clear() invalidated the request mid-flight', async () => {
    const d = deferred<UnifiedApprovalDTO>()
    const { state, apply } = collector()
    const ctrl = createDetailPaneController(() => d.promise, apply)
    const p = ctrl.select('apv_1')
    // pane closed while the fetch is in flight → clear()
    ctrl.clear()
    expect(state.approval).toBeNull()
    expect(state.loading).toBe(false)
    // the ORIGINAL request now resolves — it must not overwrite the cleared state
    d.resolve(approval('apv_1'))
    await p
    expect(state.approval).toBeNull()
    expect(state.loading).toBe(false)
  })

  it('RESELECTION: keeps only the newest of two overlapping selections (out-of-order resolution)', async () => {
    const d1 = deferred<UnifiedApprovalDTO>()
    const d2 = deferred<UnifiedApprovalDTO>()
    const fetcher = vi.fn()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise)
    const { state, apply } = collector()
    const ctrl = createDetailPaneController(fetcher as never, apply)
    const p1 = ctrl.select('apv_1')
    const p2 = ctrl.select('apv_2')
    expect(fetcher).toHaveBeenCalledTimes(2)
    // resolve them out of order: the newer (apv_2) first, then the stale (apv_1)
    d2.resolve(approval('apv_2'))
    await p2
    expect(state.approval?.id).toBe('apv_2')
    d1.resolve(approval('apv_1'))
    await p1
    expect(state.approval?.id).toBe('apv_2')
  })

  it('a rejected fetch surfaces an error message and clears the approval', async () => {
    const { state, apply } = collector()
    const ctrl = createDetailPaneController(() => Promise.reject(new Error('该审批不存在')), apply)
    await ctrl.select('apv_missing')
    expect(state.approval).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.error).toBe('该审批不存在')
  })

  it('a stale rejection (superseded by a newer selection) does not overwrite the newer commit', async () => {
    const d1 = deferred<UnifiedApprovalDTO>()
    const { state, apply } = collector()
    const fetcher = vi.fn()
      .mockReturnValueOnce(d1.promise)
      .mockResolvedValueOnce(approval('apv_2'))
    const ctrl = createDetailPaneController(fetcher as never, apply)
    const p1 = ctrl.select('apv_1')
    const p2 = ctrl.select('apv_2')
    await p2
    expect(state.approval?.id).toBe('apv_2')
    d1.reject(new Error('stale failure'))
    await p1.catch(() => undefined)
    expect(state.approval?.id).toBe('apv_2')
    expect(state.error).toBe('')
  })
})
