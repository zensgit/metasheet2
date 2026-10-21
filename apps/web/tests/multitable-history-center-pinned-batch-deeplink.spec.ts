/**
 * W3-5b — pinned-batch banner: a commit toast's "view in history" deep-link (`initialBatchId`) must ALWAYS
 * render the target batch's detail, even when that batch is NOT among the rows on the modal's current
 * page (a different active filter, or many commits since — see the prop doc in HistoryCenterModal.vue).
 * Before this fix, the deep-link only expanded a matching ROW via `toggle()`; if no row matched, the fetched
 * detail had nowhere to render. This spec locks the fix: the pinned banner fetches + renders the batch
 * independent of the paged list, and its "clear" affordance dismisses it without touching the list.
 */
import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import HistoryCenterModal from '../src/multitable/components/HistoryCenterModal.vue'
import type { HistoryBatchDetail, HistoryBatchSummary } from '../src/multitable/types'

const { mockListHistoryEvents, mockGetHistoryBatch } = vi.hoisted(() => ({
  mockListHistoryEvents: vi.fn(),
  mockGetHistoryBatch: vi.fn(),
}))

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listHistoryEvents: mockListHistoryEvents,
    getHistoryBatch: mockGetHistoryBatch,
  },
}))

async function flushPromises() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function otherBatch(): HistoryBatchSummary {
  return {
    batchId: 'batch_on_page', sheetId: 'sheet_1', actorId: 'user_1', actorName: null, source: 'rest',
    action: 'update', createdAt: new Date().toISOString(), visibleAffectedRecordCount: 1,
    visibleAffectedFieldCount: 1, provenanceQuality: 'stamped',
  }
}

function mountModal(initialBatchId: string | null) {
  const { app, container } = mountReactiveModal(initialBatchId)
  return { app, container }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function pinnedDetail(batchId: string, value: string): HistoryBatchDetail {
  return {
    batchId, actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
    visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1,
    changes: [{ sheetId: 'sheet_1', recordId: `rec_${batchId}`, action: 'update', version: 2, changedFieldIds: ['fld_name'], before: { fld_name: value }, after: { fld_name: value } }],
  }
}

function mountReactiveModal(initialBatchId: string | null, baseId = 'base_1') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const open = ref(true)
  const currentBaseId = ref(baseId)
  const currentBatchId = ref<string | null>(initialBatchId)
  const app = createApp(defineComponent({
    setup() {
      return () => h(HistoryCenterModal, {
        open: open.value,
        baseId: currentBaseId.value,
        initialBatchId: currentBatchId.value,
        fields: [{ id: 'fld_name', name: 'Name' }],
      })
    },
  }))
  app.mount(container)
  return { app, container, open, currentBaseId, currentBatchId }
}

describe('HistoryCenterModal — W3-5b pinned-batch deep-link banner', () => {
  it('renders the deep-linked batch via the pinned banner even when it is NOT in the current page', async () => {
    // The paged list comes back WITHOUT the deep-linked batch (e.g. it scrolled off, or a filter excludes it).
    mockListHistoryEvents.mockResolvedValue({ batches: [otherBatch()], total: 1, nextCursor: null, searchTruncated: false })
    const pinned: HistoryBatchDetail = {
      batchId: 'batch_deep_linked', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1,
      changes: [{
        sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 2,
        changedFieldIds: ['fld_name'],
        before: { fld_name: 'Old Name' },
        after: { fld_name: 'New Name' },
      }],
    }
    mockGetHistoryBatch.mockResolvedValue(pinned)

    const { app, container } = mountModal('batch_deep_linked')
    try {
      await flushPromises()
      // The pinned banner fetched the target batch directly, independent of the paged list.
      expect(mockGetHistoryBatch).toHaveBeenCalledWith('base_1', 'batch_deep_linked')

      const banner = container.querySelector('[data-test="hist-pinned-batch"]')
      expect(banner).not.toBeNull()
      const diffRow = banner!.querySelector('[data-test="hist-diff-row"]')
      expect(diffRow).not.toBeNull()
      expect(diffRow!.querySelector('.meta-hist__diff-before')?.textContent).toContain('Old Name')
      expect(diffRow!.querySelector('.meta-hist__diff-after')?.textContent).toContain('New Name')

      // The normal paged list is untouched — the OTHER batch still renders as a plain, unexpanded row.
      const rows = container.querySelectorAll('[data-test="hist-batch"]')
      expect(rows.length).toBe(1)
      expect(container.querySelector('[data-test="hist-detail"]')).toBeNull() // no row auto-expanded
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('dismissing the pinned banner clears it without touching the normal list', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [otherBatch()], total: 1, nextCursor: null, searchTruncated: false })
    const pinned: HistoryBatchDetail = {
      batchId: 'batch_deep_linked', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1,
      changes: [{ sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 2, changedFieldIds: [], before: {}, after: {} }],
    }
    mockGetHistoryBatch.mockResolvedValue(pinned)

    const { app, container } = mountModal('batch_deep_linked')
    try {
      await flushPromises()
      expect(container.querySelector('[data-test="hist-pinned-batch"]')).not.toBeNull()

      container.querySelector<HTMLButtonElement>('[data-test="hist-pinned-dismiss"]')!.click()
      await flushPromises()

      expect(container.querySelector('[data-test="hist-pinned-batch"]')).toBeNull()
      // The normal list is unaffected by the dismiss.
      expect(container.querySelectorAll('[data-test="hist-batch"]').length).toBe(1)
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('no pinned banner renders for a normal (non-deep-linked) open', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [otherBatch()], total: 1, nextCursor: null, searchTruncated: false })
    const callsBeforeOpen = mockGetHistoryBatch.mock.calls.length
    const { app, container } = mountModal(null)
    try {
      await flushPromises()
      // No initialBatchId -> the pinned-banner fetch never fires (relative count: the mock is shared across
      // this file's tests, so an absolute "never called" assertion would be a false positive/negative).
      expect(mockGetHistoryBatch.mock.calls.length).toBe(callsBeforeOpen)
      expect(container.querySelector('[data-test="hist-pinned-batch"]')).toBeNull()
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('ignores a dismissed pin from an earlier open after the modal reopens on another base', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [], total: 0, nextCursor: null, searchTruncated: false })
    const oldPin = deferred<HistoryBatchDetail | null>()
    const currentPin = deferred<HistoryBatchDetail | null>()
    mockGetHistoryBatch.mockReturnValueOnce(oldPin.promise).mockReturnValueOnce(currentPin.promise)
    const { app, container, currentBaseId, currentBatchId, open } = mountReactiveModal('old_pin')
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-pinned-dismiss"]')!.click()
      open.value = false
      await flushPromises()
      expect(container.querySelector('[data-test="hist-pinned-batch"]')).toBeNull()
      currentBaseId.value = 'base_2'
      currentBatchId.value = 'current_pin'
      open.value = true
      await flushPromises()

      currentPin.resolve(pinnedDetail('current_pin', 'current value'))
      await flushPromises()
      oldPin.resolve(pinnedDetail('old_pin', 'stale value'))
      await flushPromises()

      expect(container.querySelector('[data-test="hist-pinned-batch"]')?.textContent).toContain('current value')
      expect(container.textContent).not.toContain('stale value')
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('refetches a pin when only initialBatchId changes and ignores its earlier response', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [otherBatch()], total: 1, nextCursor: null, searchTruncated: false })
    const oldPin = deferred<HistoryBatchDetail | null>()
    const currentPin = deferred<HistoryBatchDetail | null>()
    mockGetHistoryBatch.mockReturnValueOnce(oldPin.promise)
      .mockResolvedValueOnce(pinnedDetail('batch_on_page', 'expanded row'))
      .mockReturnValueOnce(currentPin.promise)
    const { app, container, currentBatchId } = mountReactiveModal('old_pin')
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      expect(container.querySelector('[data-test="hist-detail"]')?.textContent).toContain('expanded row')
      const listCalls = mockListHistoryEvents.mock.calls.length
      currentBatchId.value = 'current_pin'
      await flushPromises()
      expect(mockGetHistoryBatch).toHaveBeenCalledWith('base_1', 'current_pin')
      expect(mockListHistoryEvents.mock.calls.length).toBe(listCalls)
      expect(container.querySelector('[data-test="hist-detail"]')?.textContent).toContain('expanded row')

      currentPin.resolve(pinnedDetail('current_pin', 'current value'))
      await flushPromises()
      oldPin.resolve(pinnedDetail('old_pin', 'stale value'))
      await flushPromises()

      expect(container.querySelector('[data-test="hist-pinned-batch"]')?.textContent).toContain('current value')
      expect(container.textContent).not.toContain('stale value')
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('does not render a list response that resolves after the modal closes and reopens', async () => {
    const oldList = deferred<{ batches: HistoryBatchSummary[]; total: number; nextCursor: null; searchTruncated: boolean }>()
    const currentList = deferred<{ batches: HistoryBatchSummary[]; total: number; nextCursor: null; searchTruncated: boolean }>()
    mockListHistoryEvents.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(currentList.promise)
    const { app, container, open } = mountReactiveModal(null)
    try {
      await flushPromises()
      open.value = false
      await flushPromises()
      open.value = true
      await flushPromises()

      oldList.resolve({ batches: [otherBatch()], total: 1, nextCursor: null, searchTruncated: false })
      await flushPromises()
      expect(container.querySelector('[data-test="hist-batch"]')).toBeNull()

      currentList.resolve({ batches: [], total: 0, nextCursor: null, searchTruncated: false })
      await flushPromises()
    } finally {
      app.unmount()
      container.remove()
    }
  })
})
