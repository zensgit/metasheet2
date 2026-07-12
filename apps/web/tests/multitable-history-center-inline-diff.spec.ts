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

  // T1b (packages/core-backend/src/multitable/history-projection.ts `loadHistoryBatchDetail`) hydrates
  // `before` from the immediately-previous revision's masked snapshot for `update` actions, and from the
  // delete revision's own masked snapshot for `delete` actions — it is no longer unconditionally null.
  // A wholly-null `before` is still a REAL wire shape, though: a `create` action has no prior state (there
  // is nothing to hydrate), so `before` stays null there. The FE diff renderer (`changeFieldDiffs`) is
  // action-agnostic — it only inspects `before`/`after` object membership — so this fixture locks that
  // still-current null-before shape (create) rendering every field as "set" (never crash, never re-fetch),
  // not as a false "masked" or a false empty-string "before" value.
  it('a create-action change (`before` wholly null, no prior state) renders every field as "set"', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch({ action: 'create' })], total: 1, nextCursor: null, searchTruncated: false })
    const detail: HistoryBatchDetail = {
      batchId: 'batch_1', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1,
      changes: [{
        sheetId: 'sheet_1', recordId: 'rec_1', action: 'create', version: 1,
        changedFieldIds: ['fld_name'],
        before: null, // real wire value for a create — no prior revision exists to hydrate from
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

// ─── PR-B: record titles + type-aware link/person diff values ────────────────────────────────────────
// Titles come from the change's OWN already-masked payload (after = full post-change snapshot, before =
// pre-delete snapshot) via pickRecordTitle (TrashModal's heuristic); link/person diff values render
// through the shared formatFieldDisplay fed by the grid's summary caches, with count/id fallbacks on
// cache miss. Legacy {id,name}-only fields (all earlier tests above) keep the plain-text path — those
// tests passing unchanged IS the regression proof for the legacy branch.

function mountModalWithProps(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(HistoryCenterModal, { open: true, baseId: 'base_1', ...props })
  app.mount(container)
  return { app, container }
}

const TYPED_FIELDS = [
  { id: 'fld_title', name: 'Title', type: 'string', order: 0 },
  { id: 'fld_link', name: 'Related', type: 'link', order: 1 },
  { id: 'fld_person', name: 'Owner', type: 'person', order: 2 },
]

function detailWith(changes: HistoryBatchDetail['changes']): HistoryBatchDetail {
  return {
    batchId: 'batch_1', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
    visibleAffectedRecordCount: changes.length, visibleAffectedFieldCount: 1, changes,
  }
}

describe('HistoryCenterModal — record titles from the masked payload (PR-B)', () => {
  it('renders the record title from the after-snapshot and keeps the full id in the title attr', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    mockGetHistoryBatch.mockResolvedValue(detailWith([{
      sheetId: 'sheet_1', recordId: 'rec_abc12345', action: 'update', version: 2,
      changedFieldIds: ['fld_title'],
      before: { fld_title: 'Old' },
      after: { fld_title: 'Quarterly Report', fld_link: ['rec_x'] },
    }]))
    const { app, container } = mountModalWithProps({ fields: TYPED_FIELDS })
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const label = container.querySelector<HTMLElement>('[data-test="hist-rec-label"]')!
      expect(label.textContent).toBe('Quarterly Report')
      expect(label.getAttribute('title')).toBe('rec_abc12345')
    } finally { app.unmount(); container.remove() }
  })

  it('a DELETED record titles from its pre-delete before-snapshot', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch({ action: 'delete' })], total: 1, nextCursor: null, searchTruncated: false })
    mockGetHistoryBatch.mockResolvedValue(detailWith([{
      sheetId: 'sheet_1', recordId: 'rec_gone1234', action: 'delete', version: 3,
      changedFieldIds: [],
      before: { fld_title: 'Doomed Row' },
      after: null,
    }]))
    const { app, container } = mountModalWithProps({ fields: TYPED_FIELDS })
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      expect(container.querySelector('[data-test="hist-rec-label"]')?.textContent).toBe('Doomed Row')
    } finally { app.unmount(); container.remove() }
  })

  it('falls back to the short record id when nothing in the masked payload is readable', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    mockGetHistoryBatch.mockResolvedValue(detailWith([{
      sheetId: 'sheet_1', recordId: 'rec_abcdefgh1234', action: 'update', version: 2,
      changedFieldIds: ['fld_title'],
      before: {},
      after: {}, // LOCK-3 masked everything — title must NOT be derivable
    }]))
    const { app, container } = mountModalWithProps({ fields: TYPED_FIELDS })
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      expect(container.querySelector('[data-test="hist-rec-label"]')?.textContent).toBe('#abcdefgh')
    } finally { app.unmount(); container.remove() }
  })
})

describe('HistoryCenterModal — type-aware link/person diff values (PR-B)', () => {
  it('link diffs render EACH SIDE from its own value ids (owner P2): before=[A] vs after=[A,B] differ', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    mockGetHistoryBatch.mockResolvedValue(detailWith([{
      sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 2,
      changedFieldIds: ['fld_link'],
      before: { fld_link: ['rec_a'] },
      after: { fld_link: ['rec_a', 'rec_b'] },
    }]))
    const { app, container } = mountModalWithProps({
      fields: TYPED_FIELDS,
      // The cache describes the CURRENT cell ([A,B]); each side must be filtered to its own ids —
      // an unfiltered pass-through renders "Alpha Task, Beta Task" on BOTH sides.
      linkSummaries: { rec_1: { fld_link: [
        { id: 'rec_a', display: 'Alpha Task' },
        { id: 'rec_b', display: 'Beta Task' },
      ] } },
    })
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const row = container.querySelector<HTMLElement>('[data-test="hist-diff-row"]')!
      const before = row.querySelector('.meta-hist__diff-before')?.textContent ?? ''
      const after = row.querySelector('.meta-hist__diff-after')?.textContent ?? ''
      expect(before).toContain('Alpha Task')
      expect(before).not.toContain('Beta Task') // before=[rec_a] only — the P2 regression
      expect(after).toContain('Alpha Task')
      expect(after).toContain('Beta Task')
      expect(after).not.toContain('[') // no JSON dump
      expect(after).not.toContain('rec_a')
    } finally { app.unmount(); container.remove() }
  })

  it('link diff PARTIAL cache coverage falls back to the count summary, never an under-counted name list', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    mockGetHistoryBatch.mockResolvedValue(detailWith([{
      sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 2,
      changedFieldIds: ['fld_link'],
      before: null,
      after: { fld_link: ['rec_a', 'rec_gone'] }, // rec_gone is NOT in the cache
    }]))
    const { app, container } = mountModalWithProps({
      fields: TYPED_FIELDS,
      linkSummaries: { rec_1: { fld_link: [{ id: 'rec_a', display: 'Alpha Task' }] } },
    })
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const after = container.querySelector('.meta-hist__diff-after')?.textContent ?? ''
      expect(after).not.toContain('Alpha Task') // "Alpha Task" alone would misread as a 1-link value
      expect(after).not.toContain('[')
      expect(after.length).toBeGreaterThan(0) // honest count-summary text
    } finally { app.unmount(); container.remove() }
  })

  it('link diff cache-miss falls back to a count summary — still no JSON dump', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    mockGetHistoryBatch.mockResolvedValue(detailWith([{
      sheetId: 'sheet_1', recordId: 'rec_offpage', action: 'update', version: 2,
      changedFieldIds: ['fld_link'],
      before: null,
      after: { fld_link: ['rec_a', 'rec_b'] },
    }]))
    const { app, container } = mountModalWithProps({ fields: TYPED_FIELDS, linkSummaries: {} })
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const after = container.querySelector('.meta-hist__diff-after')?.textContent ?? ''
      expect(after).not.toContain('[')
      expect(after).not.toContain('rec_a')
      expect(after.length).toBeGreaterThan(0) // count-summary text from formatFieldDisplay
    } finally { app.unmount(); container.remove() }
  })

  it('person diffs resolve display names from the cache and fall back to the raw id on miss', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    mockGetHistoryBatch.mockResolvedValue(detailWith([{
      sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 2,
      changedFieldIds: ['fld_person'],
      before: { fld_person: ['user_known'] },
      after: { fld_person: ['user_known', 'user_unknown'] },
    }]))
    const { app, container } = mountModalWithProps({
      fields: TYPED_FIELDS,
      personSummaries: { rec_1: { fld_person: [{ id: 'user_known', display: 'Zhang San' }] } },
    })
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const after = container.querySelector('.meta-hist__diff-after')?.textContent ?? ''
      expect(after).toContain('Zhang San')
      expect(after).toContain('user_unknown') // cache miss → raw id, not JSON
      expect(after).not.toContain('[')
    } finally { app.unmount(); container.remove() }
  })
})

describe('HistoryCenterModal — record click-through emit (PR-C)', () => {
  it('a non-delete change row renders a BUTTON chip that emits open-record with {sheetId, recordId}', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    mockGetHistoryBatch.mockResolvedValue(detailWith([{
      sheetId: 'sheet_9', recordId: 'rec_click', action: 'update', version: 2,
      changedFieldIds: ['fld_title'], before: { fld_title: 'a' }, after: { fld_title: 'b' },
    }]))
    const onOpenRecord = vi.fn()
    const { app, container } = mountModalWithProps({ fields: TYPED_FIELDS, onOpenRecord })
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const chip = container.querySelector<HTMLElement>('[data-test="hist-rec-label"]')!
      expect(chip.tagName).toBe('BUTTON')
      chip.click()
      expect(onOpenRecord).toHaveBeenCalledTimes(1)
      expect(onOpenRecord).toHaveBeenCalledWith({ sheetId: 'sheet_9', recordId: 'rec_click' })
    } finally { app.unmount(); container.remove() }
  })

  it('a DELETE change row renders plain text (no button — the record is gone)', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch({ action: 'delete' })], total: 1, nextCursor: null, searchTruncated: false })
    mockGetHistoryBatch.mockResolvedValue(detailWith([{
      sheetId: 'sheet_1', recordId: 'rec_gone', action: 'delete', version: 3,
      changedFieldIds: [], before: { fld_title: 'Doomed' }, after: null,
    }]))
    const onOpenRecord = vi.fn()
    const { app, container } = mountModalWithProps({ fields: TYPED_FIELDS, onOpenRecord })
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const chip = container.querySelector<HTMLElement>('[data-test="hist-rec-label"]')!
      expect(chip.tagName).toBe('SPAN')
      chip.click()
      expect(onOpenRecord).not.toHaveBeenCalled()
    } finally { app.unmount(); container.remove() }
  })
})

// all-tables-B (R11): a batch can span multiple sheets, but the `fields` prop only carries the ACTIVE
// sheet's fields. diffFieldName resolves the active sheet via `fields` (byte-identical to pre-R11), a
// non-active sheet via the server-masked `fieldNames` map, and neither → the raw id.
describe('HistoryCenterModal — all-tables-B cross-table field-name resolution', () => {
  it('active sheet uses `fields` prop; non-active sheet uses the masked fieldNames map; neither → raw id', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    const detail: HistoryBatchDetail = {
      batchId: 'batch_1', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 2, visibleAffectedFieldCount: 3,
      changes: [
        { sheetId: 'sheet_active', recordId: 'rec_a', action: 'update', version: 2,
          changedFieldIds: ['fld_active'], before: { fld_active: 'x' }, after: { fld_active: 'y' } },
        { sheetId: 'sheet_other', recordId: 'rec_o', action: 'update', version: 2,
          changedFieldIds: ['fld_other', 'fld_orphan'],
          before: { fld_other: 'p', fld_orphan: 'm' }, after: { fld_other: 'q', fld_orphan: 'n' } },
      ],
      // active field's map name is DIFFERENT from its prop name, to prove props win for the active sheet.
      fieldNames: { sheet_active: { fld_active: 'ActiveMap' }, sheet_other: { fld_other: 'OtherName' } },
    }
    mockGetHistoryBatch.mockResolvedValue(detail)
    const { app, container } = mountModal([{ id: 'fld_active', name: 'ActiveProp' }])
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const labels = Array.from(container.querySelectorAll<HTMLElement>('.meta-hist__diff-label')).map((n) => n.textContent?.trim())
      expect(labels).toEqual(['ActiveProp', 'OtherName', 'fld_orphan'])
    } finally { app.unmount(); container.remove() }
  })
})

// R11 restore back-reference: a change carrying restoredFromVersion renders a "Restored from vN" badge;
// a change with null/absent restoredFromVersion renders no badge (the badge keys on NON-NULL).
describe('HistoryCenterModal — restore back-reference badge', () => {
  it('renders "Restored from vN" only for a change with a non-null restoredFromVersion', async () => {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    const detail: HistoryBatchDetail = {
      batchId: 'batch_1', actorId: 'user_1', source: 'restore', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 2, visibleAffectedFieldCount: 2,
      changes: [
        { sheetId: 'sheet_1', recordId: 'rec_restored', action: 'update', version: 4,
          changedFieldIds: ['fld_name'], before: { fld_name: 'old' }, after: { fld_name: 'new' }, restoredFromVersion: 5 },
        { sheetId: 'sheet_1', recordId: 'rec_plain', action: 'update', version: 2,
          changedFieldIds: ['fld_name'], before: { fld_name: 'a' }, after: { fld_name: 'b' }, restoredFromVersion: null },
      ],
    }
    mockGetHistoryBatch.mockResolvedValue(detail)
    const { app, container } = mountModal([{ id: 'fld_name', name: 'Name' }])
    try {
      await flushPromises()
      container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
      await flushPromises()
      const badges = Array.from(container.querySelectorAll<HTMLElement>('[data-test="hist-restored-from"]'))
      expect(badges.length).toBe(1) // exactly one change carries a source version
      expect(badges[0].textContent).toContain('v5')
    } finally { app.unmount(); container.remove() }
  })
})

// Person before-side name resolution. The grid's `personSummaries` cache describes the record's CURRENT
// cell, so a person REMOVED by the very change you're looking at is NOT in it and used to render as a raw
// userId — "who was removed" was unreadable. The server's `personNames` map covers BOTH sides.
// Priority per id: personNames → grid cell cache → raw id.
describe('HistoryCenterModal — person before-side name resolution', () => {
  const removedChange = [{
    sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 2,
    changedFieldIds: ['fld_person'],
    before: { fld_person: ['user_kept', 'user_removed'] },
    after: { fld_person: ['user_kept'] },
  }] as unknown as HistoryBatchDetail['changes']

  async function openWith(personNames: Record<string, { display: string; inactive?: boolean }> | undefined, personSummaries: unknown) {
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    mockGetHistoryBatch.mockResolvedValue({ ...detailWith(removedChange), ...(personNames ? { personNames } : {}) })
    const { app, container } = mountModalWithProps({ fields: TYPED_FIELDS, personSummaries })
    await flushPromises()
    container.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
    await flushPromises()
    return { app, container }
  }

  it('BEFORE side resolves the REMOVED person from personNames — the grid cache cannot know them', async () => {
    // the cache holds ONLY the current cell (user_kept); user_removed is gone from it by definition
    const { app, container } = await openWith(
      { user_kept: { display: 'Kept Person' }, user_removed: { display: 'Removed Person' } },
      { rec_1: { fld_person: [{ id: 'user_kept', display: 'Kept Person' }] } },
    )
    try {
      const before = container.querySelector('.meta-hist__diff-before')?.textContent ?? ''
      expect(before).toContain('Removed Person') // ← the whole point of the feature
      expect(before).not.toContain('user_removed') // not the raw id
      expect(before).toContain('Kept Person')
    } finally { app.unmount(); container.remove() }
  })

  it('marks a DEACTIVATED person and still renders them (OD-P2)', async () => {
    const { app, container } = await openWith(
      { user_kept: { display: 'Kept Person' }, user_removed: { display: 'Removed Person', inactive: true } },
      { rec_1: { fld_person: [{ id: 'user_kept', display: 'Kept Person' }] } },
    )
    try {
      const before = container.querySelector('.meta-hist__diff-before')?.textContent ?? ''
      expect(before).toContain('Removed Person') // still visible…
      expect(before).toContain('deactivated') // …and marked
    } finally { app.unmount(); container.remove() }
  })

  it('falls back to the grid cache, then to the raw id, when personNames lacks the id', async () => {
    // personNames covers neither id → cache supplies user_kept; user_removed has no source → raw id
    const { app, container } = await openWith(
      {},
      { rec_1: { fld_person: [{ id: 'user_kept', display: 'Kept Person' }] } },
    )
    try {
      const before = container.querySelector('.meta-hist__diff-before')?.textContent ?? ''
      expect(before).toContain('Kept Person') // cache fallback
      expect(before).toContain('user_removed') // raw-id fallback, not JSON
      expect(before).not.toContain('[')
    } finally { app.unmount(); container.remove() }
  })

  it('no personNames at all (older payload) → legacy behavior exactly (cache, then raw id)', async () => {
    const { app, container } = await openWith(undefined, { rec_1: { fld_person: [{ id: 'user_kept', display: 'Kept Person' }] } })
    try {
      const before = container.querySelector('.meta-hist__diff-before')?.textContent ?? ''
      expect(before).toContain('Kept Person')
      expect(before).toContain('user_removed')
    } finally { app.unmount(); container.remove() }
  })
})
