// UI-P2-1c batch4: ResetConfirmDialog's footer confirm button (both its non-destructive Revert-equivalent
// form and its destructive typed-confirm Reset form — they share the `.reset-confirm__btn` base class, so
// both sharers migrate together per the shared-class rule) was migrated from a bespoke <button> to the
// shared MtButton primitive: ghost for the non-destructive form (was a plain #ccc-bordered neutral action)
// and variant="danger" for the destructive form (was a solid #d92d20 fill) — `reset-confirm__btn--destructive`
// stays on the element as an additional identity class, not a styling hook. Behavior-preservation proof:
// both stay a native <button>, keep their respective :disabled gate (!hasIdentity / !canConfirm), and
// clicking either still runs the SAME onConfirm() → props.resetExecute(asOf, previewIdentity). The entry
// button and reset-entry stay bespoke — out of scope for this migration.
//
// UI-P2-1c T1 batch-4 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED): the
// header close-× (`.reset-confirm__close`) was additionally migrated from a bespoke <button>&times;</button>
// to the shared MtIconButton primitive — the &times; glyph passes through MtIconButton's default-slot icon
// fallback (glyph char preserved, size token-normalized to the icon control, consistent with the existing
// glyph-MtIconButton controls already on main). Behavior-preservation proof: it stays a native,
// keyboard-operable <button>, keeps the SAME aria-label (`l('record.resetConfirmCancelAria')`), and clicking
// it still calls the SAME onCancel() → sets open=false (identical to the pre-migration @click). This is the
// only sharer of `.reset-confirm__close` (single button, single file) — its bespoke CSS was removed outright,
// no double-styling risk. The confirm/destructive action buttons above (`.reset-confirm__btn` and its
// `--destructive` sharer) were NOT touched by this migration — see the pre-existing tests above.
//
// NB: the dialog body renders inside <teleport to="body">, so selectors below query `document.body`
// (not a local mount container) — same pattern as the existing multitable-reset-confirm-dialog.spec.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import ResetConfirmDialog from '../src/multitable/components/ResetConfirmDialog.vue'
import type { ResetPreview, ResetResult } from '../src/multitable/api/client'
import { useLocale } from '../src/composables/useLocale'

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

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  document.body.innerHTML = ''
  useLocale().setLocale('en')
})

describe('ResetConfirmDialog — MtButton migration (UI-P2-1c batch4)', () => {
  it('renders the non-destructive confirm as a native <button> (MtButton, ghost)', async () => {
    mount({ resetPreview: vi.fn(async () => previewOf({ summary: { visibleRevertCount: 1, deleteCount: 0 }, deleteRecordIds: [] })) })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-btn"]'))
    const btn = q('[data-test="reset-confirm-btn"]') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('reset-confirm__btn')).toBe(true)
    expect(btn.classList.contains('reset-confirm__btn--destructive')).toBe(false)
    expect(btn.classList.contains('mt-button--danger')).toBe(false)
  })

  it('renders the destructive confirm as a native <button> (MtButton, variant="danger")', async () => {
    mount({})
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-btn"]'))
    const btn = q('[data-test="reset-confirm-btn"]') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('reset-confirm__btn')).toBe(true)
    expect(btn.classList.contains('reset-confirm__btn--destructive')).toBe(true) // kept as identity class
    expect(btn.classList.contains('mt-button--danger')).toBe(true)
  })

  it('non-destructive path: :disabled tracks !hasIdentity — a disabled MtButton still blocks the click (no resetExecute)', async () => {
    const resetExecute = vi.fn(async () => resultOf())
    mount({
      resetPreview: vi.fn(async () => previewOf({ summary: { visibleRevertCount: 1, deleteCount: 0 }, deleteRecordIds: [], previewIdentity: '' })),
      resetExecute,
    })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-revert-equiv"]'))
    const btn = q('[data-test="reset-confirm-btn"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true) // no previewIdentity → !hasIdentity
    btn.click()
    await flush()
    expect(resetExecute).not.toHaveBeenCalled() // native disabled (+ MtButton's own guard) blocks the click
  })

  it('non-destructive path (identity present): clicking the enabled confirm runs onConfirm → resetExecute(asOf, previewIdentity)', async () => {
    const resetExecute = vi.fn(async () => resultOf())
    mount({
      resetPreview: vi.fn(async () => previewOf({ summary: { visibleRevertCount: 1, deleteCount: 0 }, deleteRecordIds: [], previewIdentity: 'tok-revert' })),
      resetExecute,
    })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-revert-equiv"]'))
    const btn = q('[data-test="reset-confirm-btn"]') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    btn.click()
    await flush()
    expect(resetExecute).toHaveBeenCalledTimes(1)
    expect(resetExecute).toHaveBeenCalledWith('2026-06-20T00:00:00Z', 'tok-revert')
  })

  it('destructive path: :disabled tracks !canConfirm (both typed "reset" AND ack required); clicking once enabled runs onConfirm → resetExecute', async () => {
    const resetExecute = vi.fn(async () => resultOf())
    mount({ resetExecute })
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="reset-confirm-btn"]'))
    const btn = () => q('[data-test="reset-confirm-btn"]') as HTMLButtonElement
    expect(btn().disabled).toBe(true) // neither typed nor ack
    setInput('[data-test="reset-confirm-type"]', 'reset'); await flush()
    setCheck('[data-test="reset-confirm-ack"] input', true); await flush()
    expect(btn().disabled).toBe(false) // both satisfied

    btn().click()
    await flush()
    expect(resetExecute).toHaveBeenCalledTimes(1)
    expect(resetExecute).toHaveBeenCalledWith('2026-06-20T00:00:00Z', 'tok1')
  })

  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + aria-label + glyph', async () => {
    mount({})
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('.reset-confirm__close'))
    const btn = q('.reset-confirm__close') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('reset-confirm__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Cancel')
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('clicking the header close-× closes the dialog (unchanged — same onCancel as before migration)', async () => {
    mount({})
    await nextTick()
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('.reset-confirm__close'))
    ;(q('.reset-confirm__close') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-test="reset-confirm"]')).toBeNull() // overlay gone → open.value was set false by onCancel
  })
})
