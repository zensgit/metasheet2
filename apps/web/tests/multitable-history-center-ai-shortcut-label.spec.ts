/**
 * AI-fields S1 — G8: History Center's inline sourceLabel map renders the 'ai-shortcut' entry, and the
 * unknown-source fallback (render the raw string) stays intact for a source the map doesn't know.
 *
 * Design lock: docs/development/multitable-ai-write-provenance-batch-grouping-s1-designlock-20260705.md
 * (§2 A5, §5 G8). The label map is deliberately an INLINE zh/en map inside HistoryCenterModal.vue — the
 * lock explicitly forbids extracting it into a shared module until a second consumer needs it, so this
 * test mounts the real component rather than importing an isolated helper.
 */
import { describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import HistoryCenterModal from '../src/multitable/components/HistoryCenterModal.vue'

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

function mountModal() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(HistoryCenterModal, { open: true, baseId: 'base_g8' })
  app.mount(container)
  return { app, container }
}

describe('HistoryCenterModal — G8 ai-shortcut source label', () => {
  it('renders the ai-shortcut label for a batch attributed to it', async () => {
    mockListHistoryEvents.mockResolvedValue({
      batches: [{
        batchId: 'batch_ai_1',
        sheetId: 'sheet_1',
        actorId: 'user_1',
        actorName: null,
        source: 'ai-shortcut',
        action: 'update',
        createdAt: new Date().toISOString(),
        visibleAffectedRecordCount: 1,
        visibleAffectedFieldCount: 1,
      }],
      total: 1,
      nextCursor: null,
      searchTruncated: false,
    })

    const { app, container } = mountModal()
    try {
      await flushPromises()
      const who = container.querySelector('.meta-hist__who')
      expect(who?.textContent).toContain('AI fill')
      expect(who?.textContent).not.toContain('ai-shortcut') // the label wins, not a raw-string fallback
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('unknown-source fallback is unchanged: an unrecognized source renders as its own raw string', async () => {
    mockListHistoryEvents.mockResolvedValue({
      batches: [{
        batchId: 'batch_unknown_1',
        sheetId: 'sheet_1',
        actorId: 'user_1',
        actorName: null,
        source: 'some-future-source',
        action: 'update',
        createdAt: new Date().toISOString(),
        visibleAffectedRecordCount: 1,
        visibleAffectedFieldCount: 1,
      }],
      total: 1,
      nextCursor: null,
      searchTruncated: false,
    })

    const { app, container } = mountModal()
    try {
      await flushPromises()
      const who = container.querySelector('.meta-hist__who')
      expect(who?.textContent).toContain('some-future-source')
    } finally {
      app.unmount()
      container.remove()
    }
  })
})
