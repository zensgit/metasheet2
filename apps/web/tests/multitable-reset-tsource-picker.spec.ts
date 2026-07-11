// @vitest-environment jsdom
/**
 * T8-2 Reset UI — ResetToPointPicker (the T-source the #3250 dialog was missing). Hidden unless `pitResetEnabled`.
 * Sources a point-in-time T from recent Global History batches first, keeps datetime-local as an advanced fallback,
 * and binds the (sheetId, asOf) wire to the client. The WIRE tests below assert the selected history batch's
 * `createdAt` ISO reaches reset-preview/reset-execute.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'

import ResetToPointPicker from '../src/multitable/components/ResetToPointPicker.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
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
    resetPreview: vi.fn(async () => ({ asOf: '', strategy: 'reset', summary: { visibleRevertCount: 0, deleteCount: 0 }, deleteRecordIds: [], previewIdentity: 't' })),
    resetExecute: vi.fn(async () => ({ asOf: '', strategy: 'reset', revertedCount: 0, deletedRecordIds: [] })),
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
const setInput = (sel: string, val: string) => { const el = q(sel) as HTMLInputElement; el.value = val; el.dispatchEvent(new Event('input')) }
const setSelect = (sel: string, val: string) => { const el = q(sel) as HTMLSelectElement; el.value = val; el.dispatchEvent(new Event('change')) }
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); document.body.innerHTML = ''; useLocale().setLocale('en') })

describe('ResetToPointPicker — T8-2 Reset UI T-source', () => {
  it('(a) whole entry HIDDEN when pitResetEnabled false / absent (fail-closed)', async () => {
    mount({ pitResetEnabled: false }); await nextTick()
    expect(q('[data-test="reset-picker"]')).toBeFalsy()
    mounted.pop()!.unmount(); document.body.innerHTML = ''
    mount({ pitResetEnabled: undefined }); await nextTick()
    expect(q('[data-test="reset-picker"]')).toBeFalsy()
  })

  it('(b) enabled: loads and shows recent Global History batches, but NO dialog/target until a T is chosen', async () => {
    const props = mount(); await nextTick()
    await waitUntil(() => (q('[data-test="reset-picker-history-select"]') as HTMLSelectElement | null)?.options.length === 3)
    expect(q('[data-test="reset-picker-history-select"]')).toBeTruthy()
    expect(q('[data-test="reset-picker-input"]')).toBeTruthy() // advanced/manual fallback stays mounted
    expect(q('[data-test="reset-picker-target"]')).toBeFalsy()
    expect(q('[data-test="reset-entry"]')).toBeFalsy() // the dialog isn't mounted yet → no second reset button
    expect((props.listHistoryEvents as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['base_abc', { sheetId: 'sheet_xyz', limit: 20 }])
  })

  it('(c) FUTURE manual fallback T → future hint, no dialog (can only reset to the past)', async () => {
    mount(); await nextTick()
    setInput('[data-test="reset-picker-input"]', '2099-01-01T00:00'); await flush()
    expect(q('[data-test="reset-picker-future"]')).toBeTruthy()
    expect(q('[data-test="reset-entry"]')).toBeFalsy()
  })

  it('(d1) P3-2 history load ERROR: listHistoryEvents rejects → error hint shown, manual fallback still mounts a dialog', async () => {
    const listHistoryEvents = vi.fn(async () => { throw new Error('history service unavailable') })
    mount({ listHistoryEvents }); await nextTick()
    await waitUntil(() => !!q('[data-test="reset-picker-history-error"]'))
    expect(q('[data-test="reset-picker-history-error"]')?.textContent).toBe('history service unavailable')
    expect(q('[data-test="reset-picker-history-loading"]')).toBeFalsy()
    expect(q('[data-test="reset-picker-history-empty"]')).toBeFalsy()
    expect(q('[data-test="reset-picker-history-unavailable"]')).toBeFalsy()
    // the manual/Advanced fallback isn't disabled by a history-load failure — it must still be able to
    // source a T and mount the dialog (the whole point of keeping it as a fallback).
    setInput('[data-test="reset-picker-input"]', '2020-01-16T12:00'); await flush()
    expect(q('[data-test="reset-picker-target"]')).toBeTruthy()
    await waitUntil(() => !!q('[data-test="reset-entry"]'))
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
    // the select + manual fallback are still present (fail-closed on THIS source only, not the whole picker)
    expect(q('[data-test="reset-picker-history-select"]')).toBeTruthy()
    expect(q('[data-test="reset-picker-input"]')).toBeTruthy()
  })

  it('(e) valid history batch T → shows local target + mounts the ResetConfirmDialog entry', async () => {
    mount(); await nextTick()
    await waitUntil(() => (q('[data-test="reset-picker-history-select"]') as HTMLSelectElement | null)?.options.length === 3)
    setSelect('[data-test="reset-picker-history-select"]', 'batch_new'); await flush()
    expect(q('[data-test="reset-picker-target"]')).toBeTruthy()
    await waitUntil(() => !!q('[data-test="reset-entry"]')) // dialog mounted → its own entry button present
  })

  it('(f) WIRE: choosing a history batch → reset-preview hits the picker sheetId with that batch createdAt ISO', async () => {
    const batchCreatedAt = '2020-01-15T10:30:00.000Z'
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {
      asOf: '', strategy: 'reset', summary: { visibleRevertCount: 1, deleteCount: 0 }, deleteRecordIds: [], previewIdentity: 'srv',
    } }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })
    mount({
      listHistoryEvents: vi.fn(async () => ({ batches: [historyBatch('batch_wire', batchCreatedAt)], total: 1, nextCursor: null, searchTruncated: false })),
      sheetId: 'sheet_xyz',
      resetPreview: (sid: string, asOf: string) => client.resetPreview(sid, asOf),
      resetExecute: (sid: string, asOf: string, id: string) => client.resetExecute(sid, asOf, id),
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
    expect(body.asOf).toBe(batchCreatedAt)
  })

  it('(g) POST-EXECUTE SEAM: a successful reset fires onDone and hits reset-execute with the history batch ISO', async () => {
    const onDone = vi.fn()
    const batchCreatedAt = '2020-01-15T10:30:00.000Z'
    const fetchFn = vi.fn(async (url: string) => {
      // deleteCount:0 → the dialog's revert-equivalent path (no typed confirm) so we can drive execute simply.
      if (String(url).includes('reset-preview')) return new Response(JSON.stringify({ ok: true, data: {
        asOf: '', strategy: 'reset', summary: { visibleRevertCount: 1, deleteCount: 0 }, deleteRecordIds: [], previewIdentity: 'srv',
      } }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, data: { asOf: '', strategy: 'reset', revertedCount: 1, deletedRecordIds: [] } }), { status: 200 })
    })
    const client = new MultitableApiClient({ fetchFn })
    mount({
      sheetId: 'sheet_xyz', onDone,
      listHistoryEvents: vi.fn(async () => ({ batches: [historyBatch('batch_execute', batchCreatedAt)], total: 1, nextCursor: null, searchTruncated: false })),
      resetPreview: (sid: string, asOf: string) => client.resetPreview(sid, asOf),
      resetExecute: (sid: string, asOf: string, id: string) => client.resetExecute(sid, asOf, id),
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
    expect(JSON.parse((fetchFn.mock.calls[1][1] as RequestInit).body as string).asOf).toBe(batchCreatedAt)
    await waitUntil(() => onDone.mock.calls.length >= 1) // the seam back to the workbench (grid refresh) fired
  })

  it('(h) R5b i18n: zh locale renders the typed zh labels (strings live in meta-record-labels, not inline)', async () => {
    useLocale().setLocale('zh-CN')
    mount(); await nextTick()
    await waitUntil(() => (q('[data-test="reset-picker-history-select"]') as HTMLSelectElement | null)?.options.length === 3)
    expect(q('.reset-picker__heading')?.textContent).toBe('将此表重置到某个全局历史点')
    expect(q('[data-test="reset-picker-history"] .reset-picker__label > span')?.textContent).toBe('历史点')
    expect((q('[data-test="reset-picker-history-select"]') as HTMLSelectElement).options[0].textContent).toBe('选择一个最近的历史批次')
    // history option zh: record count uses the measure-word form; the wire `action` value and actor 'Ada'
    // are data, rendered raw (only the missing-action/missing-actor FALLBACK literals are typed labels)
    expect((q('[data-test="reset-picker-history-select"]') as HTMLSelectElement).options[1].textContent?.trim()).toContain('update - Ada - 1 条记录')
    expect(q('[data-test="reset-picker-history-refresh"]')?.textContent?.trim()).toBe('刷新')
    expect(q('[data-test="reset-picker-manual"] summary')?.textContent).toBe('高级：手动指定时间')
    expect(q('[data-test="reset-picker-manual"] .reset-picker__label > span')?.textContent).toBe('手动指定时间点')
    // future warn (manual T in the future)
    setInput('[data-test="reset-picker-input"]', '2099-01-01T00:00'); await flush()
    expect(q('[data-test="reset-picker-future"]')?.textContent?.trim()).toBe('请选择过去的时间——只能重置到更早的状态。')
    // valid history T → zh target line
    setSelect('[data-test="reset-picker-history-select"]', 'batch_new'); await flush()
    const target = q('[data-test="reset-picker-target"]')?.textContent ?? ''
    expect(target).toContain('目标：')
    expect(target).toContain('（你的本地时间）')
    expect(target).toContain('来自历史批次 batch_ne')
  })

  it('(h2) R5b i18n: zh empty/unavailable/loading-error hints render the typed zh labels', async () => {
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
