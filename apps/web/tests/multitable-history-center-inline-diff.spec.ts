/**
 * Global History Center — inline masked per-field diff in the expandable batch detail.
 *
 * SCOPE: the batch-detail wire payload (`HistoryBatchDetail.changes[]`, see
 * apps/web/src/multitable/types.ts `HistoryChange` and
 * packages/core-backend/src/multitable/history-projection.ts `loadHistoryBatchDetail`) already carries
 * `changedFieldIds` plus permission-masked `before`/`after` objects keyed by field id (LOCK-3: fields the
 * actor cannot read are dropped from `changedFieldIds` AND from `before`/`after` by the SAME allow-set —
 * see `filterDataByAllowedFields`). This spec locks the FE rendering of that payload as an inline
 * before→after diff, entirely from data already on the wire (no extra request).
 *
 * Shape rule under test (HistoryCenterModal.vue `changeFieldDiffs`):
 *  - field id present as an own key on BOTH `before` and `after`  → normal diff (before struck through,
 *    arrow, after)
 *  - present only on `after`  → "set" (no prior value — e.g. newly populated)
 *  - present only on `before` → "cleared" (value emptied)
 *  - present on NEITHER (yet still listed in `changedFieldIds`)   → masked placeholder (LOCK-3 hid the
 *    value on both sides while still reporting that the field changed)
 */
import { describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
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

function batch(over: Partial<HistoryBatchSummary> = {}): HistoryBatchSummary {
  return {
    batchId: 'batch_1', sheetId: 'sheet_1', actorId: 'user_1', actorName: null, source: 'rest',
    action: 'update', createdAt: new Date().toISOString(), visibleAffectedRecordCount: 1,
    visibleAffectedFieldCount: 1, provenanceQuality: 'stamped', ...over,
  }
}

function mountModal(fields?: Array<{ id: string; name: string }>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(HistoryCenterModal, { open: true, baseId: 'base_1', ...(fields ? { fields } : {}) })
  app.mount(container)
  return { app, container }
}

describe('HistoryCenterModal — inline masked per-field diff (detail expansion)', () => {
  it('(a) renders a before→after diff row for a normally-visible changed field', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    const detail: HistoryBatchDetail = {
      batchId: 'batch_1', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1,
      changes: [{
        sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 2,
        changedFieldIds: ['fld_name'],
        before: { fld_name: 'Old Name' },
        after: { fld_name: 'New Name' },
      }],
    }
    mockGetHistoryBatch.mockResolvedValue(detail)
    const { app, container } = mountModal([{ id: 'fld_name', name: 'Name' }])
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const rows = container.querySelectorAll<HTMLElement>('[data-test="hist-diff-row"]')
      expect(rows.length).toBe(1)
      expect(rows[0].querySelector('.meta-hist__diff-label')?.textContent).toContain('Name')
      expect(rows[0].querySelector('.meta-hist__diff-before')?.textContent).toContain('Old Name')
      expect(rows[0].querySelector('.meta-hist__diff-arrow')).not.toBeNull()
      expect(rows[0].querySelector('.meta-hist__diff-after')?.textContent).toContain('New Name')
      // masked-op elements must NOT appear on a fully-visible row
      expect(rows[0].querySelector('[data-test="hist-diff-masked"]')).toBeNull()
      expect(rows[0].querySelector('[data-test="hist-diff-op"]')).toBeNull()
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('(b) a field changed but hidden on BOTH sides (LOCK-3) renders the masked placeholder, never fetches more', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    const detail: HistoryBatchDetail = {
      batchId: 'batch_1', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1,
      changes: [{
        sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 2,
        changedFieldIds: ['fld_secret'],
        // Both sides are present-but-empty objects: filterDataByAllowedFields' shape for "the actor may
        // read OTHER fields in this batch, but not this one" — the field id survives in changedFieldIds
        // (the count/id is metadata) while its value is dropped from both snapshots.
        before: {},
        after: {},
      }],
    }
    mockGetHistoryBatch.mockResolvedValue(detail)
    const { app, container } = mountModal([{ id: 'fld_secret', name: 'Secret' }])
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const callsAfterOpen = mockGetHistoryBatch.mock.calls.length
      const masked = container.querySelector('[data-test="hist-diff-masked"]')
      expect(masked).not.toBeNull()
      expect(masked?.textContent).toContain('Masked')
      // no before/after value spans on a masked row
      expect(container.querySelector('.meta-hist__diff-before')).toBeNull()
      expect(container.querySelector('.meta-hist__diff-after')).toBeNull()
      // never fetches more to resolve the mask
      expect(mockGetHistoryBatch.mock.calls.length).toBe(callsAfterOpen)
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('(c) set (no prior value) and cleared (emptied) shapes render distinctly from a normal diff', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    const detail: HistoryBatchDetail = {
      batchId: 'batch_1', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 2,
      changes: [{
        sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 3,
        changedFieldIds: ['fld_new', 'fld_gone'],
        // fld_new: absent from `before`, present in `after` → "set" (no prior value).
        // fld_gone: present in `before`, absent from `after` → "cleared" (value emptied).
        before: { fld_gone: 'Was Set' },
        after: { fld_new: 'Hello' },
      }],
    }
    mockGetHistoryBatch.mockResolvedValue(detail)
    const { app, container } = mountModal([
      { id: 'fld_new', name: 'New Field' },
      { id: 'fld_gone', name: 'Gone Field' },
    ])
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const rows = [...container.querySelectorAll<HTMLElement>('[data-test="hist-diff-row"]')]
      expect(rows.length).toBe(2)

      const setRow = rows.find((r) => r.querySelector('.meta-hist__diff-label')?.textContent?.includes('New Field'))!
      expect(setRow.querySelector('.meta-hist__diff-before')).toBeNull() // no prior value shown
      expect(setRow.querySelector('[data-test="hist-diff-op"]')?.textContent).toBe('set')
      expect(setRow.querySelector('.meta-hist__diff-after')?.textContent).toContain('Hello')

      const clearedRow = rows.find((r) => r.querySelector('.meta-hist__diff-label')?.textContent?.includes('Gone Field'))!
      expect(clearedRow.querySelector('.meta-hist__diff-after')).toBeNull() // no new value shown
      expect(clearedRow.querySelector('[data-test="hist-diff-op"]')?.textContent).toBe('clear')
      expect(clearedRow.querySelector('.meta-hist__diff-before')?.textContent).toContain('Was Set')
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('(d) the existing changed-field-count summary still renders correctly alongside the new diff rows', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch({ visibleAffectedFieldCount: 2 })], total: 1, nextCursor: null, searchTruncated: false })
    const detail: HistoryBatchDetail = {
      batchId: 'batch_1', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 2,
      changes: [{
        sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 2,
        changedFieldIds: ['fld_a', 'fld_b'],
        before: { fld_a: 1, fld_b: 2 },
        after: { fld_a: 10, fld_b: 20 },
      }],
    }
    mockGetHistoryBatch.mockResolvedValue(detail)
    const { app, container } = mountModal([{ id: 'fld_a', name: 'A' }, { id: 'fld_b', name: 'B' }])
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const fieldsSummary = container.querySelector('.meta-hist__change-fields')
      expect(fieldsSummary?.textContent).toContain('2')
      expect(fieldsSummary?.textContent).toContain('field')
      const rows = container.querySelectorAll<HTMLElement>('[data-test="hist-diff-row"]')
      expect(rows.length).toBe(2)
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('a field id not present in the `fields` prop falls back to the raw field id (no crash, no fetch)', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    const detail: HistoryBatchDetail = {
      batchId: 'batch_1', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1,
      changes: [{
        sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 2,
        changedFieldIds: ['fld_unknown'],
        before: { fld_unknown: 'a' },
        after: { fld_unknown: 'b' },
      }],
    }
    mockGetHistoryBatch.mockResolvedValue(detail)
    const { app, container } = mountModal() // no `fields` prop at all
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const label = container.querySelector('.meta-hist__diff-label')
      expect(label?.textContent).toContain('fld_unknown')
    } finally {
      app.unmount()
      container.remove()
    }
  })

  // loadHistoryBatchDetail (packages/core-backend/src/multitable/history-projection.ts, ~line 560) currently
  // ALWAYS sends `before: null` for every change — "T1b: before/after diff hydration is a detail
  // refinement" is not yet implemented server-side; `after` is the permission-masked snapshot. This test
  // pins the FE against TODAY's real wire shape (not just a hypothetical future one): a wholly-null
  // `before` must render every field as "set" (never crash, never re-fetch), not as a false "masked" or
  // a false empty-string "before" value.
  it('matches the CURRENT real backend shape (`before` wholly null) — renders every field as "set"', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    const detail: HistoryBatchDetail = {
      batchId: 'batch_1', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1,
      changes: [{
        sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 2,
        changedFieldIds: ['fld_name'],
        before: null, // real current wire value, always
        after: { fld_name: 'New Name' },
      }],
    }
    mockGetHistoryBatch.mockResolvedValue(detail)
    const { app, container } = mountModal([{ id: 'fld_name', name: 'Name' }])
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const callsAfterOpen = mockGetHistoryBatch.mock.calls.length
      const row = container.querySelector('[data-test="hist-diff-row"]')!
      expect(row.querySelector('.meta-hist__diff-before')).toBeNull()
      expect(row.querySelector('[data-test="hist-diff-op"]')?.textContent).toBe('set')
      expect(row.querySelector('.meta-hist__diff-after')?.textContent).toContain('New Name')
      expect(mockGetHistoryBatch.mock.calls.length).toBe(callsAfterOpen) // no extra fetch
    } finally {
      app.unmount()
      container.remove()
    }
  })
})
