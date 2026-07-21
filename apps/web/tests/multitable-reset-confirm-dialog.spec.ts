// @vitest-environment jsdom
/**
 * T8-2 / W2 Reset UI — ResetConfirmDialog, exact-anchor contract. Entry is hidden unless `pitResetEnabled`
 * (flag-derived: MULTITABLE_ENABLE_PIT_RESET on AND canManageSheetAccess) AND a valid `anchor` is selected.
 * The destructive authority is EXCLUSIVELY `historyBatchId` XOR `anchorOperationId` — `asOf` is display text
 * only and is never sent over the wire. The destructive path requires a typed `reset` AND a deleted-count
 * acknowledgement before the confirm enables; `deleteCount===0` is a plain revert-equivalent (no destructive
 * confirm). A preview reporting `resurrectCount>0` can never become executable. The wire fires reset-preview
 * (anchor body) then reset-execute (token-only body, `confirm:'reset'`).
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'

import ResetConfirmDialog from '../src/multitable/components/ResetConfirmDialog.vue'
import { MultitableApiClient, type ExactAnchorRequest, type ResetPreview, type ResetResult } from '../src/multitable/api/client'
import { useLocale } from '../src/composables/useLocale'

const ANCHOR: ExactAnchorRequest = { historyBatchId: 'batch_1' }
const ASOF_LABEL = '2026-06-20T00:00:00Z'

const previewOf = (over: Partial<ResetPreview>): ResetPreview => ({
  strategy: 'reset',
  summary: { visibleRevertCount: 2, deleteCount: 3, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 5 },
  deleteRecordIds: ['c', 'd', 'e'], previewIdentity: 'tok1', ...over,
})
// Counts-only is the canonical L8 result shape; the UI must not depend on the server echoing target ids.
const resultOf = (): ResetResult => ({ strategy: 'reset', revertedCount: 2, deletedCount: 3 })

const mounted: Array<{ unmount: () => void }> = []
function mount(over: Record<string, unknown>) {
  const props: Record<string, unknown> = {
    pitResetEnabled: true, asOf: ASOF_LABEL, anchor: ANCHOR,
    resetPreview: vi.fn(async () => previewOf({})), resetExecute: vi.fn(async () => resultOf()), ...over,
  }
  const app = createApp(ResetConfirmDialog, props)
  const c = document.createElement('div'); document.body.appendChild(c); app.mount(c); mounted.push(app); return props
}
const q = (s: string) => document.body.querySelector(s) as HTMLElement | null
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }
const waitUntil = async (pred: () => boolean, tries = 100): Promise<void> => {
  for (let i = 0; i < tries; i++) { if (pred()) return; await flush() }
  throw new Error('waitUntil: condition not met')
}
const setInput = (sel: string, val: string) => { const el = q(sel) as HTMLInputElement; el.value = val; el.dispatchEvent(new Event('input')) }
const setCheck = (sel: string, on: boolean) => { const el = q(sel) as HTMLInputElement; el.checked = on; el.dispatchEvent(new Event('change')) }
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); document.body.innerHTML = ''; useLocale().setLocale('en') })

describe('ResetConfirmDialog — T8-2 / W2 exact-anchor Reset UI', () => {
  it('(a) entry is HIDDEN when pitResetEnabled is false', async () => {
    mount({ pitResetEnabled: false }); await nextTick()
    expect(q('[data-test="reset-entry"]')).toBeFalsy()
  })

  it('(a2) entry is HIDDEN when pitResetEnabled is absent (fail-closed)', async () => {
    mount({ pitResetEnabled: undefined }); await nextTick()
    expect(q('[data-test="reset-entry"]')).toBeFalsy()
  })

  it('(a3) entry is HIDDEN when pitResetEnabled is true but anchor is null (no exact target selected)', async () => {
    mount({ anchor: null }); await nextTick()
    expect(q('[data-test="reset-entry"]')).toBeFalsy()
  })

  it('(b) destructive confirm stays DISABLED until BOTH typed `reset` AND count-ack', async () => {
    mount({}); await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-btn"]'))
    const btn = () => q('[data-test="reset-confirm-btn"]') as HTMLButtonElement
    expect(btn().disabled).toBe(true) // neither
    setInput('[data-test="reset-confirm-type"]', 'reset'); await flush()
    expect(btn().disabled).toBe(true) // typed only
    setInput('[data-test="reset-confirm-type"]', ''); setCheck('[data-test="reset-confirm-ack"] input', true); await flush()
    expect(btn().disabled).toBe(true) // ack only
    setInput('[data-test="reset-confirm-type"]', 'reset'); await flush()
    expect(btn().disabled).toBe(false) // BOTH
  })

  it('(c) destructive copy names the recycle bin + the count + Revert as the safe alternative', async () => {
    mount({}); await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-warn"]'))
    const t = q('[data-test="reset-confirm-warn"]')!.textContent || ''
    expect(t).toContain('recycle bin')
    expect(t).toContain('3') // the deleteCount
    expect(t).toMatch(/Revert/) // names the non-destructive alternative
    expect(t).toMatch(/not\b.*normal restore/i)
  })

  it('(d) WIRE: entry → reset-preview with the exact anchor body, then reset-execute with confirm:"reset" + the server previewIdentity ONLY (no asOf/anchor re-sent)', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('reset-preview')) return new Response(JSON.stringify({ ok: true, data: {
        strategy: 'reset', summary: { visibleRevertCount: 2, deleteCount: 3, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 5 },
        deleteRecordIds: ['c', 'd', 'e'], previewIdentity: 'server-tok',
      } }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, data: { strategy: 'reset', revertedCount: 2, deletedRecordIds: ['c', 'd', 'e'] } }), { status: 200 })
    })
    const client = new MultitableApiClient({ fetchFn })
    mount({ resetPreview: (a: ExactAnchorRequest) => client.resetPreview('sheet_1', a), resetExecute: (id: string) => client.resetExecute('sheet_1', id) })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-type"]')) // preview rendered the destructive form
    setInput('[data-test="reset-confirm-type"]', 'reset'); setCheck('[data-test="reset-confirm-ack"] input', true); await flush()
    ;(q('[data-test="reset-confirm-btn"]') as HTMLButtonElement).click()
    await waitUntil(() => fetchFn.mock.calls.length >= 2)
    expect(fetchFn.mock.calls[0][0]).toContain('/reset-preview')
    const previewBody = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)
    expect(previewBody).toEqual({ historyBatchId: 'batch_1' }) // the exclusive anchor, nothing else
    expect(previewBody.asOf).toBeUndefined()
    expect(previewBody.anchorOperationId).toBeUndefined()

    expect(fetchFn.mock.calls[1][0]).toContain('/reset-execute')
    const execBody = JSON.parse((fetchFn.mock.calls[1][1] as RequestInit).body as string)
    expect(execBody).toEqual({ previewIdentity: 'server-tok', confirm: 'reset' }) // token + confirm ONLY
    expect(execBody.asOf).toBeUndefined()
    expect(execBody.historyBatchId).toBeUndefined()
  })

  it('(d2) WIRE: the anchorOperationId arm of the exclusive union (API-type direct anchor) serializes to ONLY anchorOperationId — no historyBatchId, no asOf', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {
      strategy: 'reset', summary: { visibleRevertCount: 0, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 0 }, deleteRecordIds: [], previewIdentity: null,
    } }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })
    await client.resetPreview('sheet_1', { anchorOperationId: 'op_1' })
    expect(fetchFn.mock.calls[0][0]).toContain('/reset-preview')
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({ anchorOperationId: 'op_1' })
    expect(body.historyBatchId).toBeUndefined()
    expect(body.asOf).toBeUndefined()
  })

  it('(e) deleteCount===0 → NO typed confirm, a plain revert-equivalent', async () => {
    mount({ resetPreview: vi.fn(async () => previewOf({ summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 1 }, deleteRecordIds: [] })) })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-revert-equiv"]'))
    expect(q('[data-test="reset-confirm-type"]')).toBeFalsy() // no destructive typed gate
    expect(q('[data-test="reset-confirm-warn"]')).toBeFalsy()
  })

  it('(f1) DISABLED/no-token path (non-destructive): a null previewIdentity keeps the revert-equivalent confirm disabled and blocks the click', async () => {
    const resetExecute = vi.fn(async () => resultOf())
    mount({
      resetPreview: vi.fn(async () => previewOf({ summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 1 }, deleteRecordIds: [], previewIdentity: null })),
      resetExecute,
    })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-revert-equiv"]'))
    const btn = q('[data-test="reset-confirm-btn"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    btn.click(); await flush()
    expect(resetExecute).not.toHaveBeenCalled()
  })

  it('(f2) DISABLED/no-token path (destructive): a null previewIdentity keeps the destructive confirm disabled EVEN when typed+ack are both satisfied', async () => {
    const resetExecute = vi.fn(async () => resultOf())
    mount({ resetPreview: vi.fn(async () => previewOf({ previewIdentity: null })), resetExecute })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-btn"]'))
    setInput('[data-test="reset-confirm-type"]', 'reset'); setCheck('[data-test="reset-confirm-ack"] input', true); await flush()
    const btn = q('[data-test="reset-confirm-btn"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true) // typed + ack satisfied but there's no token to execute
    btn.click(); await flush()
    expect(resetExecute).not.toHaveBeenCalled()
  })

  it('(g) RESURRECT BLOCK: a preview with resurrectCount>0 renders a blocked notice, never a confirm control, even if the server returned a previewIdentity', async () => {
    const resetExecute = vi.fn(async () => resultOf())
    mount({
      resetPreview: vi.fn(async () => previewOf({ summary: { visibleRevertCount: 1, deleteCount: 2, resurrectCount: 4, driftCount: 0, effectiveWriteCount: 7 }, previewIdentity: 'tok-should-be-ignored' })),
      resetExecute,
    })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-blocked"]'))
    expect(q('[data-test="reset-confirm-blocked"]')!.textContent).toContain('4')
    expect(q('[data-test="reset-confirm-btn"]')).toBeFalsy() // no confirm control of any kind
    expect(q('[data-test="reset-confirm-type"]')).toBeFalsy()
    expect(q('[data-test="reset-confirm-revert-equiv"]')).toBeFalsy()
    expect(resetExecute).not.toHaveBeenCalled()
  })

  it('(h) TOCTOU: changing the live anchor/asOf props after the dialog is open does NOT retarget the already-loaded preview or the eventual execute', async () => {
    const anchorRef = ref<ExactAnchorRequest>({ historyBatchId: 'batch_A' })
    const asOfRef = ref('2026-01-01T00:00:00Z')
    const resetPreview = vi.fn(async (a: ExactAnchorRequest) => previewOf({ deleteRecordIds: [] , summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 1 }, previewIdentity: `tok-for-${'historyBatchId' in a ? a.historyBatchId : a.anchorOperationId}` }))
    const resetExecute = vi.fn(async (_id: string) => ({ ...resultOf(), records: undefined } as ResetResult))

    const app: App<Element> = createApp({
      setup() {
        return () => h(ResetConfirmDialog, {
          pitResetEnabled: true,
          asOf: asOfRef.value,
          anchor: anchorRef.value,
          resetPreview,
          resetExecute,
        })
      },
    })
    const c = document.createElement('div'); document.body.appendChild(c); app.mount(c)
    mounted.push({ unmount: () => app.unmount() })

    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-revert-equiv"]'))
    expect(resetPreview).toHaveBeenCalledTimes(1)
    expect(resetPreview).toHaveBeenCalledWith({ historyBatchId: 'batch_A' })
    expect(q('.reset-confirm__title')?.textContent).toContain('2026-01-01T00:00:00Z')

    // Mutate the LIVE upstream selection while the modal is still open — simulates the picker's selection
    // (or its underlying reactive state) changing behind the modal.
    anchorRef.value = { historyBatchId: 'batch_B' }
    asOfRef.value = '2099-01-01T00:00:00Z'
    await flush()

    // The already-open modal must still show batch_A's snapshot, not batch_B's.
    expect(q('.reset-confirm__title')?.textContent).toContain('2026-01-01T00:00:00Z')
    expect(q('.reset-confirm__title')?.textContent).not.toContain('2099-01-01T00:00:00Z')
    expect(resetPreview).toHaveBeenCalledTimes(1) // no re-preview fired for batch_B while open

    const btn = q('[data-test="reset-confirm-btn"]') as HTMLButtonElement
    btn.click()
    await flush()
    expect(resetExecute).toHaveBeenCalledTimes(1)
    expect(resetExecute).toHaveBeenCalledWith('tok-for-batch_A') // the token bound to the SNAPSHOT, not batch_B
  })

  it('(h2) CLOSE+REOPEN race: a late preview from the closed anchor cannot overwrite the reopened anchor', async () => {
    const anchorRef = ref<ExactAnchorRequest>({ historyBatchId: 'batch_A' })
    const asOfRef = ref('label-A')
    let resolveA!: (value: ResetPreview) => void
    let resolveB!: (value: ResetPreview) => void
    const resetPreview = vi.fn((anchor: ExactAnchorRequest) => new Promise<ResetPreview>((resolve) => {
      const id = 'historyBatchId' in anchor ? anchor.historyBatchId : anchor.anchorOperationId
      if (id === 'batch_A') resolveA = resolve
      else resolveB = resolve
    }))
    const resetExecute = vi.fn(async () => resultOf())
    const app: App<Element> = createApp({
      setup: () => () => h(ResetConfirmDialog, {
        pitResetEnabled: true,
        asOf: asOfRef.value,
        anchor: anchorRef.value,
        resetPreview,
        resetExecute,
      }),
    })
    const c = document.createElement('div'); document.body.appendChild(c); app.mount(c)
    mounted.push({ unmount: () => app.unmount() })

    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => resetPreview.mock.calls.length === 1)
    ;(q('.reset-confirm__close') as HTMLButtonElement).click()
    await flush()

    anchorRef.value = { historyBatchId: 'batch_B' }
    asOfRef.value = 'label-B'
    await flush()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => resetPreview.mock.calls.length === 2)

    resolveB(previewOf({
      summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 1 },
      deleteRecordIds: [],
      previewIdentity: 'tok-B',
    }))
    await waitUntil(() => !!q('[data-test="reset-confirm-btn"]'))
    expect(q('.reset-confirm__title')?.textContent).toContain('label-B')

    resolveA(previewOf({
      summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 1 },
      deleteRecordIds: [],
      previewIdentity: 'tok-A-late',
    }))
    await flush()
    ;(q('[data-test="reset-confirm-btn"]') as HTMLButtonElement).click()
    await flush()
    expect(resetExecute).toHaveBeenCalledTimes(1)
    expect(resetExecute).toHaveBeenCalledWith('tok-B')
  })

  it('(h3) DOUBLE CONFIRM: one preview token can produce at most one in-flight execute request', async () => {
    let resolveExecute!: (value: ResetResult) => void
    const resetExecute = vi.fn(() => new Promise<ResetResult>((resolve) => { resolveExecute = resolve }))
    mount({
      resetPreview: vi.fn(async () => previewOf({
        summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 1 },
        deleteRecordIds: [],
        previewIdentity: 'single-use-token',
      })),
      resetExecute,
    })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-btn"]'))
    const button = q('[data-test="reset-confirm-btn"]') as HTMLButtonElement
    button.click()
    button.click()
    await flush()
    expect(resetExecute).toHaveBeenCalledTimes(1)
    expect(q('[data-test="reset-confirm-submitting"]')).toBeTruthy()
    expect((q('.reset-confirm__close') as HTMLButtonElement).disabled).toBe(true)

    resolveExecute(resultOf())
    await waitUntil(() => !!q('[data-test="reset-confirm-result"]'))
    expect(resetExecute).toHaveBeenCalledTimes(1)
  })

  it('(h3b) POST-COMMIT refresh failure cannot rewrite a successful recovery as an execute failure', async () => {
    const onDone = vi.fn(async () => { throw new Error('refresh failed') })
    mount({
      resetPreview: vi.fn(async () => previewOf({
        summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 1 },
        deleteRecordIds: [],
        previewIdentity: 'committed-token',
      })),
      resetExecute: vi.fn(async () => ({ strategy: 'revert', revertedCount: 1, deletedCount: 0 } as ResetResult)),
      onDone,
    })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-btn"]'))
    ;(q('[data-test="reset-confirm-btn"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-result"]'))

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(q('[data-test="reset-confirm-error"]')).toBeFalsy()
    expect(q('[data-test="reset-confirm-trash-link"]')).toBeFalsy()
    expect(q('[data-test="reset-confirm-result"]')?.textContent).toContain('1 record(s) reverted')
  })

  it('(h4) doomed/no-op previews have no executable control, including a malformed drift+token response', async () => {
    mount({ resetPreview: vi.fn(async () => previewOf({
      summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 1, effectiveWriteCount: 1 },
      deleteRecordIds: [],
      previewIdentity: 'must-not-run',
    })) })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-drift-blocked"]'))
    expect(q('[data-test="reset-confirm-btn"]')).toBeFalsy()
    mounted.pop()!.unmount(); document.body.innerHTML = ''

    mount({ resetPreview: vi.fn(async () => previewOf({
      summary: { visibleRevertCount: 0, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 0 },
      deleteRecordIds: [],
      previewIdentity: null,
    })) })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-no-changes"]'))
    expect(q('[data-test="reset-confirm-btn"]')).toBeFalsy()
  })

  it('(i) R5c i18n: zh locale renders the typed zh labels for the entry/dialog chrome + destructive path (strings live in meta-record-labels, not inline)', async () => {
    useLocale().setLocale('zh-CN')
    mount({}); await nextTick()
    expect(q('[data-test="reset-entry"]')?.textContent?.trim()).toBe('重置到 2026-06-20T00:00:00Z…')
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-warn"]'))
    expect(q('.reset-confirm__title')?.textContent).toBe('将数据表重置到 2026-06-20T00:00:00Z')
    expect(q('.reset-confirm-modal')?.getAttribute('aria-label')).toBe('将数据表重置到某个时间点')
    expect(q('.reset-confirm__close')?.getAttribute('aria-label')).toBe('取消')
    // destructive warn: 3 bolded words (重置/并不是/回退) + the deleteCount-embedded clause, all typed
    const warn = q('[data-test="reset-confirm-warn"]')!.textContent ?? ''
    expect(warn).toContain('重置')
    expect(warn).toContain('并将 2026-06-20T00:00:00Z 之后新建的 3 条记录移至回收站')
    expect(warn).toContain('并不是')
    expect(warn).toContain('回退')
    // ack + typed-confirm + destructive button
    expect(q('[data-test="reset-confirm-ack"]')?.textContent?.trim()).toBe('我知道 3 条记录将被移至回收站。')
    const typeLabel = q('.reset-confirm__type')!.textContent ?? ''
    expect(typeLabel).toContain('输入')
    expect(typeLabel).toContain('reset') // server-authoritative confirm token — never translated
    expect(typeLabel).toContain('以确认：')
    expect(q('[data-test="reset-confirm-type"]')?.getAttribute('aria-label')).toBe('输入 reset 以确认')
    expect(q('[data-test="reset-confirm-btn"]')?.textContent?.trim()).toBe('重置 — 将 3 条记录移至回收站')
  })

  it('(j) R5c i18n: zh locale renders the typed zh labels for the revert-equivalent + result + resurrect-block + error paths', async () => {
    useLocale().setLocale('zh-CN')
    // revert-equivalent (deleteCount===0)
    mount({ resetPreview: vi.fn(async () => previewOf({ summary: { visibleRevertCount: 1, deleteCount: 0, resurrectCount: 0, driftCount: 0, effectiveWriteCount: 1 }, deleteRecordIds: [] })) })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-revert-equiv"]'))
    const revertEquiv = q('[data-test="reset-confirm-revert-equiv"]')!.textContent ?? ''
    expect(revertEquiv).toContain('2026-06-20T00:00:00Z 之后没有新建任何记录')
    expect(revertEquiv).toContain('回退')
    expect(q('[data-test="reset-confirm-btn"]')?.textContent?.trim()).toBe('回退到 2026-06-20T00:00:00Z')
    mounted.pop()!.unmount(); document.body.innerHTML = ''

    // result (post-execute)
    mount({}); await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-type"]'))
    setInput('[data-test="reset-confirm-type"]', 'reset'); setCheck('[data-test="reset-confirm-ack"] input', true); await flush()
    ;(q('[data-test="reset-confirm-btn"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-result"]'))
    const resultText = q('[data-test="reset-confirm-result"]')!.textContent ?? ''
    expect(resultText).toContain('3 条记录已移至回收站')
    expect(resultText).toContain('2 条记录已回退到 2026-06-20T00:00:00Z')
    expect(q('[data-test="reset-confirm-trash-link"]')?.textContent).toBe('在回收站中查看')
    mounted.pop()!.unmount(); document.body.innerHTML = ''

    // resurrect block
    mount({ resetPreview: vi.fn(async () => previewOf({ summary: { visibleRevertCount: 0, deleteCount: 0, resurrectCount: 2, driftCount: 0, effectiveWriteCount: 2 } })) })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-blocked"]'))
    const blockedText = q('[data-test="reset-confirm-blocked"]')!.textContent ?? ''
    expect(blockedText).toContain('无法重置到该时间点')
    expect(blockedText).toContain('2')
    mounted.pop()!.unmount(); document.body.innerHTML = ''

    // error branches: one per status/code combo, including the 400 typed-confirm-mismatch (token stays raw)
    const errCase = async (status: number, code: string | undefined, expected: string) => {
      mount({ resetPreview: vi.fn(async () => { const e = new Error('boom') as Error & { status?: number; code?: string }; e.status = status; e.code = code; throw e }) })
      await nextTick()
      ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
      await waitUntil(() => !!q('[data-test="reset-confirm-error"]'))
      expect(q('[data-test="reset-confirm-error"]')?.textContent).toBe(expected)
      mounted.pop()!.unmount(); document.body.innerHTML = ''
    }
    await errCase(403, 'RESET_DISABLED', '此处未启用重置。')
    await errCase(403, undefined, '你没有权限重置此数据表。')
    await errCase(409, 'RESET_BLOCKED', '某条目标记录被锁定或拒绝 — 未做任何更改。')
    await errCase(409, 'RECORD_LOCKED', '某条目标记录被锁定或拒绝 — 未做任何更改。')
    await errCase(409, 'RECOVERY_IN_PROGRESS', '某条目标记录被锁定或拒绝 — 未做任何更改。')
    await errCase(409, 'RESET_RETENTION_CONFLICT', '修订保留任务运行期间无法执行重置。请在停用保留任务后重试。')
    await errCase(409, undefined, '数据表在预览之后已发生变化 — 请重新预览后再试。')
    await errCase(413, undefined, '此数据表记录过多，无法一次性重置。')
    await errCase(400, undefined, '请输入 "reset" 以确认。') // 'reset' literal preserved even in zh
    await errCase(999, undefined, '重置未能完成。请重新预览后再试。')
    // exact-anchor / kernel refusal mapping — code-driven, not status-driven
    await errCase(400, 'EXACT_ANCHOR_REQUIRED', '这不是一个有效的精确历史点。请刷新并从列表中重新选择一个批次。')
    await errCase(400, 'AMBIGUOUS_ANCHOR', '这不是一个有效的精确历史点。请刷新并从列表中重新选择一个批次。')
    await errCase(400, 'INVALID_ANCHOR', '这不是一个有效的精确历史点。请刷新并从列表中重新选择一个批次。')
    await errCase(404, 'UNKNOWN_ANCHOR', '这不是一个有效的精确历史点。请刷新并从列表中重新选择一个批次。')
    await errCase(409, 'NO_COVERING_CHECKPOINT', '没有可信的历史检查点覆盖该时间点了——请选择一个更近的时间点。')
    await errCase(409, 'CHECKPOINT_CHANGED', '没有可信的历史检查点覆盖该时间点了——请选择一个更近的时间点。')
    await errCase(409, 'RECOVERY_TRUST_REQUIRED', '重置不可用——无法验证此数据表的历史可信度。')
    await errCase(409, 'HISTORY_INCOMPLETE', '重置不可用——无法验证此数据表的历史可信度。')
    await errCase(422, 'SCHEMA_DRIFT', '自该时间点以来结构已发生变化——请重新预览或选择其他时间点。')
    await errCase(409, 'LINK_INTEGRITY', '相关联的链接目标缺失或无效——未做任何更改。')
    await errCase(422, 'VALUE_INVALID', '某个目标值对当前结构已不再有效——未做任何更改。')
    await errCase(409, 'INBOUND_UNPROVABLE', '此次重置无法安全地恢复已删除的记录——未做任何更改。')
    await errCase(410, 'PREVIEW_IDENTITY_INVALID', '数据表在预览之后已发生变化 — 请重新预览后再试。')
    await errCase(409, 'TOKEN_REPLAYED', '数据表在预览之后已发生变化 — 请重新预览后再试。')
  })
})
