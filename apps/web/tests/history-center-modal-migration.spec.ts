// UI-P2-1c batch4: HistoryCenterModal's Filter-apply, pinned-banner Clear, and Load-more controls were
// migrated from bespoke <button>s to the shared MtButton primitive (all ghost — none carried a primary/
// danger accent; `.meta-hist__apply` / `.meta-hist__more` were unstyled, `.meta-hist__pinned-dismiss` was
// already a neutral --ms-* bordered secondary action). Behavior-preservation proof: each control stays a
// native <button>, keeps its :disabled binding (Load-more) and data-test attribute, and clicking it still
// runs the SAME composable method with the SAME arguments. The per-row __summary batch toggle (a domain
// row control) stays bespoke — out of scope for this migration.
//
// UI-P2-1c T1 batch-4 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED,
// "各 manager header" remainder): the header close-× (`.meta-hist__close`) was additionally migrated
// from a bespoke <button>×</button> to the shared MtIconButton primitive — the × glyph char passes
// through MtIconButton's default-slot icon fallback (glyph char preserved, size token-normalized to the
// icon control). Behavior-preservation proof: it stays a native, keyboard-operable <button>, keeps the
// SAME aria-label (`t('关闭', 'Close')`), and clicking it still fires the SAME `emit('close')`. This is
// the only sharer of `.meta-hist__close` — its bespoke CSS was removed outright, no double-styling risk.
// The bespoke `type="button"` attribute was dropped (redundant — MtButton's own template already
// hardcodes `type="button"` on its root native <button>).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import HistoryCenterModal from '../src/multitable/components/HistoryCenterModal.vue'
import type { HistoryBatchSummary, HistoryBatchDetail } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

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

async function flush(): Promise<void> {
  await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick()
}

function batch(id: string): HistoryBatchSummary {
  return {
    batchId: id, sheetId: 'sheet_1', actorId: 'user_1', actorName: null, source: 'rest',
    action: 'update', createdAt: new Date().toISOString(), visibleAffectedRecordCount: 1,
    visibleAffectedFieldCount: 1, provenanceQuality: 'stamped',
  }
}

function pinnedDetail(id: string): HistoryBatchDetail {
  return {
    batchId: id, actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
    visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1, changes: [],
  }
}

const setInput = (container: HTMLDivElement, sel: string, val: string) => {
  const el = container.querySelector(sel) as HTMLInputElement
  el.value = val
  el.dispatchEvent(new Event('input'))
}

let mounts: Array<{ app: App; container: HTMLDivElement }> = []
afterEach(() => {
  mounts.forEach(({ app, container }) => { app.unmount(); container.remove() })
  mounts = []
  expect(document.querySelectorAll('.meta-hist__overlay').length).toBe(0) // residue guard
  mockListHistoryEvents.mockReset()
  mockGetHistoryBatch.mockReset()
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(HistoryCenterModal, props)
  app.mount(container)
  mounts.push({ app, container })
  return container
}

describe('HistoryCenterModal — MtButton migration (UI-P2-1c batch4)', () => {
  it('renders Filter, Clear, and Load-more as native <button>s (MtButton)', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch('b1')], total: 1, nextCursor: 'cur1', searchTruncated: false })
    mockGetHistoryBatch.mockResolvedValue(pinnedDetail('b_pinned'))
    const container = mount({ open: true, baseId: 'base_1', initialBatchId: 'b_pinned' })
    await flush()
    expect(container.querySelector('[data-test="hist-apply"]')!.tagName).toBe('BUTTON')
    expect(container.querySelector('[data-test="hist-pinned-dismiss"]')!.tagName).toBe('BUTTON')
    expect(container.querySelector('[data-test="hist-load-more"]')!.tagName).toBe('BUTTON')
  })

  it('clicking Filter re-runs reload() → listHistoryEvents with the current filter values (@click unchanged)', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [], total: 0, nextCursor: null, searchTruncated: false })
    const container = mount({ open: true, baseId: 'base_1' })
    await flush()
    mockListHistoryEvents.mockClear()

    setInput(container, '[data-test="hist-filter-search"]', 'orders')
    await flush()
    ;(container.querySelector('[data-test="hist-apply"]') as HTMLButtonElement).click()
    await flush()

    expect(mockListHistoryEvents).toHaveBeenCalledTimes(1)
    const [baseIdArg, paramsArg] = mockListHistoryEvents.mock.calls[0]
    expect(baseIdArg).toBe('base_1')
    expect(paramsArg.q).toBe('orders') // filterSearch -> reload() -> clientParams().q, unchanged
  })

  it('clicking Clear dismisses the pinned banner (@click unchanged, dismissPinned)', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [], total: 0, nextCursor: null, searchTruncated: false })
    mockGetHistoryBatch.mockResolvedValue(pinnedDetail('b_pinned'))
    const container = mount({ open: true, baseId: 'base_1', initialBatchId: 'b_pinned' })
    await flush()
    expect(container.querySelector('[data-test="hist-pinned-batch"]')).not.toBeNull()

    ;(container.querySelector('[data-test="hist-pinned-dismiss"]') as HTMLButtonElement).click()
    await flush()

    expect(container.querySelector('[data-test="hist-pinned-batch"]')).toBeNull()
  })

  it('clicking Load-more re-runs loadMore() → listHistoryEvents(nextCursor) and appends rows (@click + :disabled unchanged)', async () => {
    mockListHistoryEvents
      .mockResolvedValueOnce({ batches: [batch('b1')], total: 2, nextCursor: 'cur1', searchTruncated: false })
      .mockResolvedValueOnce({ batches: [batch('b2')], total: 2, nextCursor: null, searchTruncated: false })
    const container = mount({ open: true, baseId: 'base_1' })
    await flush()

    const loadMoreBtn = container.querySelector('[data-test="hist-load-more"]') as HTMLButtonElement
    expect(loadMoreBtn.disabled).toBe(false) // :disabled="loadingMore" — false once the initial load settles
    loadMoreBtn.click()
    await flush()

    expect(mockListHistoryEvents).toHaveBeenCalledTimes(2)
    const [, paramsArg] = mockListHistoryEvents.mock.calls[1]
    expect(paramsArg.cursor).toBe('cur1')
    expect(container.querySelectorAll('[data-test="hist-batch"]').length).toBe(2) // b1 + appended b2
    // v-if="nextCursor && !loading" — the control disappears once the cursor is exhausted.
    expect(container.querySelector('[data-test="hist-load-more"]')).toBeNull()
  })
})

describe('HistoryCenterModal — close-× MtIconButton migration (UI-P2-1c T1 batch-4)', () => {
  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + aria-label + glyph', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [], total: 0, nextCursor: null, searchTruncated: false })
    const container = mount({ open: true, baseId: 'base_1' })
    await flush()
    const btn = container.querySelector('.meta-hist__close') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-hist__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Close')
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('clicking the header close-× emits `close` (unchanged — same emit(\'close\'))', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [], total: 0, nextCursor: null, searchTruncated: false })
    const onClose = vi.fn()
    const container = mount({ open: true, baseId: 'base_1', onClose })
    await flush()
    const btn = container.querySelector('.meta-hist__close') as HTMLButtonElement
    btn.click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })
})
