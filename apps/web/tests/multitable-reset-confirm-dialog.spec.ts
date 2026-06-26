// @vitest-environment jsdom
/**
 * T8-2 Reset UI — ResetConfirmDialog. Entry is hidden unless `pitResetEnabled` (flag-derived: MULTITABLE_ENABLE_PIT_RESET
 * on AND canManageSheetAccess). The destructive path requires a typed `reset` AND a deleted-count acknowledgement before
 * the confirm enables; `deleteCount===0` is a plain revert-equivalent (no destructive confirm). The wire fires
 * reset-preview then reset-execute (with `confirm:'reset'` + the server previewIdentity).
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'

import ResetConfirmDialog from '../src/multitable/components/ResetConfirmDialog.vue'
import { MultitableApiClient, type ResetPreview, type ResetResult } from '../src/multitable/api/client'

const previewOf = (over: Partial<ResetPreview>): ResetPreview => ({
  asOf: '2026-06-20T00:00:00Z', strategy: 'reset',
  summary: { visibleRevertCount: 2, deleteCount: 3 }, deleteRecordIds: ['c', 'd', 'e'], previewIdentity: 'tok1', ...over,
})
const resultOf = (): ResetResult => ({ asOf: '2026-06-20T00:00:00Z', strategy: 'reset', revertedCount: 2, deletedRecordIds: ['c', 'd', 'e'] })

const mounted: Array<{ unmount: () => void }> = []
function mount(over: Record<string, unknown>) {
  const props: Record<string, unknown> = {
    pitResetEnabled: true, asOf: '2026-06-20T00:00:00Z',
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
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); document.body.innerHTML = '' })

describe('ResetConfirmDialog — T8-2 Reset UI', () => {
  it('(a) entry is HIDDEN when pitResetEnabled is false', async () => {
    mount({ pitResetEnabled: false }); await nextTick()
    expect(q('[data-test="reset-entry"]')).toBeFalsy()
  })

  it('(a2) entry is HIDDEN when pitResetEnabled is absent (fail-closed)', async () => {
    mount({ pitResetEnabled: undefined }); await nextTick()
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

  it('(d) WIRE: entry → reset-preview, then reset-execute with confirm:"reset" + the server previewIdentity', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('reset-preview')) return new Response(JSON.stringify({ ok: true, data: {
        asOf: '2026-06-20T00:00:00Z', strategy: 'reset', summary: { visibleRevertCount: 2, deleteCount: 3 },
        deleteRecordIds: ['c', 'd', 'e'], previewIdentity: 'server-tok',
      } }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, data: { asOf: '2026-06-20T00:00:00Z', strategy: 'reset', revertedCount: 2, deletedRecordIds: ['c', 'd', 'e'] } }), { status: 200 })
    })
    const client = new MultitableApiClient({ fetchFn })
    mount({ resetPreview: (asOf: string) => client.resetPreview('sheet_1', asOf), resetExecute: (asOf: string, id: string) => client.resetExecute('sheet_1', asOf, id) })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-type"]')) // preview rendered the destructive form
    setInput('[data-test="reset-confirm-type"]', 'reset'); setCheck('[data-test="reset-confirm-ack"] input', true); await flush()
    ;(q('[data-test="reset-confirm-btn"]') as HTMLButtonElement).click()
    await waitUntil(() => fetchFn.mock.calls.length >= 2)
    expect(fetchFn.mock.calls[0][0]).toContain('/reset-preview')
    expect(fetchFn.mock.calls[1][0]).toContain('/reset-execute')
    const body = JSON.parse((fetchFn.mock.calls[1][1] as RequestInit).body as string)
    expect(body.confirm).toBe('reset')
    expect(body.previewIdentity).toBe('server-tok')
  })

  it('(e) deleteCount===0 → NO typed confirm, a plain revert-equivalent', async () => {
    mount({ resetPreview: vi.fn(async () => previewOf({ summary: { visibleRevertCount: 1, deleteCount: 0 }, deleteRecordIds: [] })) })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-revert-equiv"]'))
    expect(q('[data-test="reset-confirm-type"]')).toBeFalsy() // no destructive typed gate
    expect(q('[data-test="reset-confirm-warn"]')).toBeFalsy()
  })
})
