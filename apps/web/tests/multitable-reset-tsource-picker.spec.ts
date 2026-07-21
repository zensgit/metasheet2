// @vitest-environment jsdom
/**
 * T8-2 / W2 Reset UI — ResetToPointPicker (the T-source the #3250 dialog was missing), exact-anchor contract.
 * Hidden unless `pitResetEnabled`. Sources the destructive anchor EXCLUSIVELY from a selected Global History
 * batch (`historyBatchId`) — there is no free-time fallback. The WIRE tests below assert the selected batch's
 * `historyBatchId` (never a wall-clock time) reaches reset-preview, and that reset-execute is token-only.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'

import ResetToPointPicker from '../src/multitable/components/ResetToPointPicker.vue'
import { MultitableApiClient, type ExactAnchorRequest } from '../src/multitable/api/client'
import { useLocale } from '../src/composables/useLocale'
import type { HistoryBatchSummary } from '../src/multitable/types'

const mounted: Array<{ unmount: () => void }> = []
function historyBatch(id: string, createdAt = '2020-01-15T10:30:00.000Z'): HistoryBatchSummary {
  return {
    batchId: id,
    sheetId: 'sheet_xyz',
    actorId: 'u1',
    actorName: 'Ada',
    source: 'rest',
    action: 'update',
    createdAt,
    visibleAffectedRecordCount: 1,
    visibleAffectedFieldCount: 1,
    provenanceQuality: 'stamped',
  }
}

function mount(over: Record<string, unknown> = {}) {
  const batches = [historyBatch('batch_new'), historyBatch('batch_old', '2020-01-14T09:00:00.000Z')]
  const props: Record<string, unknown> = {
    pitResetEnabled: true,
    baseId: 'base_abc',
    sheetId: 'sheet_xyz',
    listHistoryEvents: vi.fn(async () => ({ batches, total: batches.length, nextCursor: null, searchTruncated: false })),
    resetPreview: vi.fn(async () => ({ strategy: 'reset', summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 1 }, deleteRecordIds: [], previewIdentity: 't' })),
    resetExecute: vi.fn(async () => ({ strategy: 'reset', revertedCount: 0, deletedRecordIds: [] })),
    ...over,
  }
  const app = createApp(ResetToPointPicker, props)
  const c = document.createElement('div'); document.body.appendChild(c); app.mount(c); mounted.push(app); return props
}
const q = (s: string) => document.body.querySelector(s) as HTMLElement | null
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }
const waitUntil = async (pred: () => boolean, tries = 100): Promise<void> => {
  for (let i = 0; i < tries; i++) { if (pred()) return; await flush() }
  throw new Error('waitUntil: condition not met')
}
const setSelect = (sel: string, val: string) => { const el = q(sel) as HTMLSelectElement; el.value = val; el.dispatchEvent(new Event('change')) }
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); document.body.innerHTML = ''; useLocale().setLocale('en') })

describe('ResetToPointPicker — T8-2 / W2 exact-anchor Reset UI T-source', () => {
  it('(a) whole entry HIDDEN when pitResetEnabled false / absent (fail-closed)', async () => {
    mount({ pitResetEnabled: false }); await nextTick()
    expect(q('[data-test="reset-picker"]')).toBeFalsy()
    mounted.pop()!.unmount(); document.body.innerHTML = ''
    mount({ pitResetEnabled: undefined }); await nextTick()
    expect(q('[data-test="reset-picker"]')).toBeFalsy()
  })

  it('(b) enabled: loads and shows recent Global History batches, but NO dialog/target until a batch is chosen; no manual/free-time control exists', async () => {
    const props = mount(); await nextTick()
    await waitUntil(() => (q('[data-test="reset-picker-history-select"]') as HTMLSelectElement | null)?.options.length === 3)
    expect(q('[data-test="reset-picker-history-select"]')).toBeTruthy()
    expect(q('[data-test="reset-picker-input"]')).toBeFalsy() // manual datetime-local fallback is GONE (W2)
    expect(q('[data-test="reset-picker-manual"]')).toBeFalsy()
    expect(q('[data-test="reset-picker-target"]')).toBeFalsy()
    expect(q('[data-test="reset-entry"]')).toBeFalsy() // the dialog isn't mounted yet → no second reset button
    expect(q('[data-test="reset-picker-exact-anchor-note"]')).toBeTruthy()
    expect((props.listHistoryEvents as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['base_abc', { sheetId: 'sheet_xyz', limit: 20 }])
  })

  it('(c) selecting a valid history batch composes the exact anchor and shows the target line + mounts the ResetConfirmDialog entry', async () => {
    mount(); await nextTick()
    await waitUntil(() => (q('[data-test="reset-picker-history-select"]') as HTMLSelectElement | null)?.options.length === 3)
    setSelect('[data-test="reset-picker-history-select"]', 'batch_new'); await flush()
    expect(q('[data-test="reset-picker-target"]')).toBeTruthy()
    await waitUntil(() => !!q('[data-test="reset-entry"]')) // dialog mounted → its own entry button present
  })

  it('(d1) P3-2 history load ERROR: listHistoryEvents rejects → error hint shown; there is no manual fallback to source an anchor from', async () => {
    const listHistoryEvents = vi.fn(async () => { throw new Error('history service unavailable') })
    mount({ listHistoryEvents }); await nextTick()
    await waitUntil(() => !!q('[data-test="reset-picker-history-error"]'))
    expect(q('[data-test="reset-picker-history-error"]')?.textContent).toBe('history service unavailable')
    expect(q('[data-test="reset-picker-history-loading"]')).toBeFalsy()
    expect(q('[data-test="reset-picker-history-empty"]')).toBeFalsy()
    expect(q('[data-test="reset-picker-history-unavailable"]')).toBeFalsy()
    expect(q('[data-test="reset-entry"]')).toBeFalsy() // no anchor available → nothing to reset to
  })

  it('(d2) P3-2 history EMPTY: canLoadHistory true + zero batches → empty hint (not the error or unavailable hint)', async () => {
    const listHistoryEvents = vi.fn(async () => ({ batches: [], total: 0, nextCursor: null, searchTruncated: false }))
    mount({ listHistoryEvents }); await nextTick()
    await waitUntil(() => !!q('[data-test="reset-picker-history-empty"]'))
    expect(q('[data-test="reset-picker-history-empty"]')?.textContent).toBe('No recent history batches found.')
    expect(q('[data-test="reset-picker-history-error"]')).toBeFalsy()
    expect(q('[data-test="reset-picker-history-unavailable"]')).toBeFalsy()
    expect((q('[data-test="reset-picker-history-select"]') as HTMLSelectElement).options.length).toBe(1) // only the placeholder option
  })

  it('(d3) P3-2 history UNAVAILABLE: no usable baseId → unavailable hint (history-load never even attempted)', async () => {
    const listHistoryEvents = vi.fn(async () => ({ batches: [], total: 0, nextCursor: null, searchTruncated: false }))
    mount({ baseId: '', listHistoryEvents }); await nextTick(); await flush()
    expect(q('[data-test="reset-picker-history-unavailable"]')?.textContent).toBe('History points unavailable.')
    expect(q('[data-test="reset-picker-history-error"]')).toBeFalsy()
    expect(q('[data-test="reset-picker-history-empty"]')).toBeFalsy()
    expect(listHistoryEvents).not.toHaveBeenCalled() // canLoadHistory is false — no doomed fetch attempt
    expect(q('[data-test="reset-picker-history-select"]')).toBeTruthy()
  })

  it('(e) WIRE: choosing a history batch → reset-preview hits the picker sheetId with an EXCLUSIVE historyBatchId body (no asOf, no wall-clock)', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {
      strategy: 'reset', summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 1 }, deleteRecordIds: [], previewIdentity: 'srv',
    } }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })
    mount({
      listHistoryEvents: vi.fn(async () => ({ batches: [historyBatch('batch_wire')], total: 1, nextCursor: null, searchTruncated: false })),
      sheetId: 'sheet_xyz',
      resetPreview: (sid: string, anchor: ExactAnchorRequest) => client.resetPreview(sid, anchor),
      resetExecute: (sid: string, id: string) => client.resetExecute(sid, id),
    })
    await nextTick()
    await waitUntil(() => (q('[data-test="reset-picker-history-select"]') as HTMLSelectElement | null)?.options.length === 2)
    setSelect('[data-test="reset-picker-history-select"]', 'batch_wire'); await flush()
    await waitUntil(() => !!q('[data-test="reset-entry"]'))
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => fetchFn.mock.calls.length >= 1)
    const url = fetchFn.mock.calls[0][0] as string
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)
    expect(url).toContain('sheet_xyz')           // sheetId wiring (picker → client), not a fixture
    expect(url).toContain('/reset-preview')
    expect(body).toEqual({ historyBatchId: 'batch_wire' })
    expect(body.asOf).toBeUndefined()
    expect(body.anchorOperationId).toBeUndefined()
  })

  it('(f) POST-EXECUTE SEAM: a successful reset fires onDone and hits reset-execute with ONLY the previewIdentity + confirm — never the batch id or a timestamp', async () => {
    const onDone = vi.fn()
    const fetchFn = vi.fn(async (url: string) => {
      // deleteCount:0 → the dialog's revert-equivalent path (no typed confirm) so we can drive execute simply.
      if (String(url).includes('reset-preview')) return new Response(JSON.stringify({ ok: true, data: {
        strategy: 'reset', summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 1 }, deleteRecordIds: [], previewIdentity: 'srv',
      } }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, data: { strategy: 'reset', revertedCount: 1, deletedRecordIds: [] } }), { status: 200 })
    })
    const client = new MultitableApiClient({ fetchFn })
    mount({
      sheetId: 'sheet_xyz', onDone,
      listHistoryEvents: vi.fn(async () => ({ batches: [historyBatch('batch_execute')], total: 1, nextCursor: null, searchTruncated: false })),
      resetPreview: (sid: string, anchor: ExactAnchorRequest) => client.resetPreview(sid, anchor),
      resetExecute: (sid: string, id: string) => client.resetExecute(sid, id),
    })
    await nextTick()
    await waitUntil(() => (q('[data-test="reset-picker-history-select"]') as HTMLSelectElement | null)?.options.length === 2)
    setSelect('[data-test="reset-picker-history-select"]', 'batch_execute'); await flush()
    await waitUntil(() => !!q('[data-test="reset-entry"]'))
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-btn"]')) // revert-equivalent confirm (deleteCount 0)
    ;(q('[data-test="reset-confirm-btn"]') as HTMLButtonElement).click()
    await waitUntil(() => fetchFn.mock.calls.length >= 2)
    expect(String(fetchFn.mock.calls[1][0])).toContain('sheet_xyz')
    expect(String(fetchFn.mock.calls[1][0])).toContain('/reset-execute')
    const execBody = JSON.parse((fetchFn.mock.calls[1][1] as RequestInit).body as string)
    expect(execBody).toEqual({ previewIdentity: 'srv', confirm: 'reset' })
    await waitUntil(() => onDone.mock.calls.length >= 1) // the seam back to the workbench (grid refresh) fired
  })

  it('(g) R5b i18n: zh locale renders the typed zh labels (strings live in meta-record-labels, not inline)', async () => {
    useLocale().setLocale('zh-CN')
    mount(); await nextTick()
    await waitUntil(() => (q('[data-test="reset-picker-history-select"]') as HTMLSelectElement | null)?.options.length === 3)
    expect(q('.reset-picker__heading')?.textContent).toBe('将此数据表重置到某个全局历史点')
    expect(q('[data-test="reset-picker-history"] .reset-picker__label > span')?.textContent).toBe('历史点')
    expect((q('[data-test="reset-picker-history-select"]') as HTMLSelectElement).options[0].textContent).toBe('选择一个最近的历史批次')
    // history option zh: record count uses the measure-word form; the wire `action` value and actor 'Ada'
    // are data, rendered raw (only the missing-action/missing-actor FALLBACK literals are typed labels)
    expect((q('[data-test="reset-picker-history-select"]') as HTMLSelectElement).options[1].textContent?.trim()).toContain('update - Ada - 1 条记录')
    expect(q('[data-test="reset-picker-history-refresh"]')?.textContent?.trim()).toBe('刷新')
    expect(q('[data-test="reset-picker-exact-anchor-note"]')?.textContent?.trim()).toBe('重置仅使用来自全局历史的精确、可审计的时间点——不支持自由输入时间。')
    // valid history T → zh target line
    setSelect('[data-test="reset-picker-history-select"]', 'batch_new'); await flush()
    const target = q('[data-test="reset-picker-target"]')?.textContent ?? ''
    expect(target).toContain('目标：')
    expect(target).toContain('（你的本地时间）')
    expect(target).toContain('来自历史批次 batch_ne')
  })

  it('(h) R5b i18n: zh empty/unavailable/loading-error hints render the typed zh labels', async () => {
    useLocale().setLocale('zh-CN')
    // empty
    mount({ listHistoryEvents: vi.fn(async () => ({ batches: [], total: 0, nextCursor: null, searchTruncated: false })) }); await nextTick()
    await waitUntil(() => !!q('[data-test="reset-picker-history-empty"]'))
    expect(q('[data-test="reset-picker-history-empty"]')?.textContent).toBe('未找到最近的历史批次。')
    mounted.pop()!.unmount(); document.body.innerHTML = ''
    // unavailable (no baseId → history source off, fail-closed on this source only)
    mount({ baseId: '' }); await nextTick(); await flush()
    expect(q('[data-test="reset-picker-history-unavailable"]')?.textContent).toBe('历史点不可用。')
    mounted.pop()!.unmount(); document.body.innerHTML = ''
    // non-Error rejection → typed zh fallback copy (an Error's own message stays raw — covered by (d1))
    mount({ listHistoryEvents: vi.fn(async () => { throw 'not-an-error' }) }); await nextTick()
    await waitUntil(() => !!q('[data-test="reset-picker-history-error"]'))
    expect(q('[data-test="reset-picker-history-error"]')?.textContent).toBe('加载历史点失败')
  })
})
