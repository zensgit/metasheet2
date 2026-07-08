import { describe, expect, it, vi } from 'vitest'

import { createRoutePreviewController, type RoutePreviewState } from '../src/approvals/routePreviewController'
import type { ApprovalRoutePreview } from '../src/approvals/api'

// RP-2 (B3-05) — race-guard semantics: a preview resolved AFTER the form changed (or after a newer
// request started) must NOT commit, so the发起页 never renders a path computed from stale values.

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function route(nodeKey: string): ApprovalRoutePreview {
  return { route: [{ nodeKey, nodeLabel: nodeKey, assignees: [] }], totalSteps: 1, truncated: false }
}

function collector() {
  const state: RoutePreviewState = { preview: null, loading: false, error: '' }
  const apply = (patch: Partial<RoutePreviewState>) => {
    if ('preview' in patch) state.preview = patch.preview ?? null
    if (patch.loading !== undefined) state.loading = patch.loading
    if (patch.error !== undefined) state.error = patch.error
  }
  return { state, apply }
}

describe('createRoutePreviewController — race guard', () => {
  it('commits the result when nothing invalidated it', async () => {
    const d = deferred<ApprovalRoutePreview>()
    const { state, apply } = collector()
    const ctrl = createRoutePreviewController(() => d.promise, apply)
    const p = ctrl.run({ templateId: 't', formData: {} })
    expect(state.loading).toBe(true)
    d.resolve(route('approval_1'))
    await p
    expect(state.loading).toBe(false)
    expect(state.preview?.route[0]!.nodeKey).toBe('approval_1')
  })

  it('DISCARDS a stale response when a form edit invalidated the request mid-flight', async () => {
    const d = deferred<ApprovalRoutePreview>()
    const { state, apply } = collector()
    const ctrl = createRoutePreviewController(() => d.promise, apply)
    const p = ctrl.run({ templateId: 't', formData: { amount: 1 } })
    // user edits a field while the request is in flight → invalidate()
    ctrl.invalidate()
    expect(state.preview).toBeNull()
    expect(state.loading).toBe(false)
    // the ORIGINAL request now resolves — it must not overwrite the cleared state
    d.resolve(route('approval_1'))
    await p
    expect(state.preview).toBeNull()
    expect(state.loading).toBe(false)
  })

  it('keeps only the newest of two overlapping requests (out-of-order resolution)', async () => {
    const d1 = deferred<ApprovalRoutePreview>()
    const d2 = deferred<ApprovalRoutePreview>()
    const fetcher = vi.fn()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise)
    const { state, apply } = collector()
    const ctrl = createRoutePreviewController(fetcher as never, apply)
    const p1 = ctrl.run({ templateId: 't', formData: {} })
    const p2 = ctrl.run({ templateId: 't', formData: {} })
    // resolve them out of order: the newer (d2) first, then the stale (d1)
    d2.resolve(route('newer'))
    await p2
    expect(state.preview?.route[0]!.nodeKey).toBe('newer')
    d1.resolve(route('older'))
    await p1
    expect(state.preview?.route[0]!.nodeKey).toBe('newer')
  })

  it('DISCARDS a stale rejection after invalidation (no error flash from an abandoned request)', async () => {
    const d = deferred<ApprovalRoutePreview>()
    const { state, apply } = collector()
    const ctrl = createRoutePreviewController(() => d.promise, apply)
    const p = ctrl.run({ templateId: 't', formData: {} })
    ctrl.invalidate()
    d.reject(new Error('boom'))
    await p
    expect(state.error).toBe('')
    expect(state.preview).toBeNull()
  })

  it('surfaces the error message when the current request rejects', async () => {
    const d = deferred<ApprovalRoutePreview>()
    const { state, apply } = collector()
    const ctrl = createRoutePreviewController(() => d.promise, apply)
    const p = ctrl.run({ templateId: 't', formData: {} })
    d.reject(new Error('权限不足'))
    await p
    expect(state.error).toBe('权限不足')
    expect(state.loading).toBe(false)
  })
})
