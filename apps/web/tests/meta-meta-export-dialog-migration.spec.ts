import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaExportDialog from '../src/multitable/components/MetaExportDialog.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaExportDialog's two footer action controls (cancel / confirm) were migrated from
// bespoke <button>s to the shared MtButton primitive (confirm = variant="primary"). Behavior-
// preservation proof: they stay native, keyboard-operable <button>s; the `:disabled="!canExport"`
// binding survives on confirm; and clicking them still emits the SAME `cancel` / `confirm` events
// with the SAME payload. The dialog teleports to <body>, so queries hit `document`, not the mount
// container. The close-× glyph stays bespoke (untouched; T1-gated).
//
// UI-P2-1c T3 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T3, RATIFIED): the
// select-all / clear-all inline links — both sharers of the old `.meta-export__link` class — are now
// <MtLink>. Both were migrated together so the bespoke #409eff CSS was removed (no double-styling).
// Behavior-preservation proof: both stay native, keyboard-operable <button>s (now class `mt-link`);
// clicking select-all still checks every column, clicking clear-all still unchecks every column
// (verified indirectly via confirm's `:disabled="!canExport"` and the emitted fieldIds).

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-export-overlay').length).toBe(0) // teleport residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaExportDialog, { ...props, ...handlers }) })
  app.mount(container)
  mounts.push({ app, container })
}

const baseProps = () => ({
  visible: true,
  fields: [
    { id: 'f1', name: 'Name' },
    { id: 'f2', name: 'Age' },
  ],
  selectedRowCount: 0,
})

const actionBtns = () =>
  Array.from(document.querySelectorAll('.meta-export__actions .meta-export__btn')) as HTMLElement[]
const confirmBtn = () => document.querySelector('.meta-export__btn--primary') as HTMLButtonElement
const cancelBtn = () =>
  actionBtns().find((b) => !b.classList.contains('meta-export__btn--primary')) as HTMLButtonElement

describe('MetaExportDialog — MtButton migration (UI-P2-1c)', () => {
  it('renders cancel + confirm as native <button>s; confirm enabled while columns are checked', () => {
    mount(baseProps())
    const btns = actionBtns()
    expect(btns.length).toBe(2)
    expect(btns.every((b) => b.tagName === 'BUTTON')).toBe(true) // keyboard-operable, not bare divs
    // On mount every column is checked → canExport true → confirm enabled.
    expect(confirmBtn().disabled).toBe(false)
  })

  it('confirm becomes disabled when no columns are checked (:disabled="!canExport" survives)', async () => {
    mount(baseProps())
    // Uncheck both columns via the now-MtLink "clear all" link → canExport false.
    const clearAll = Array.from(document.querySelectorAll('.mt-link'))
      .find((b) => (b.textContent || '').toLowerCase().includes('clear')) as HTMLButtonElement
    clearAll.click()
    await nextTick()
    expect(confirmBtn().disabled).toBe(true)
  })

  it('clicking cancel emits `cancel` (unchanged from pre-migration onCancel)', () => {
    const onCancel = vi.fn()
    mount(baseProps(), { onCancel })
    cancelBtn().click()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('clicking confirm emits `confirm` with the same payload (unchanged from pre-migration onConfirm)', () => {
    const onConfirm = vi.fn()
    mount({ ...baseProps(), initialFormat: 'csv' }, { onConfirm })
    expect(confirmBtn().disabled).toBe(false)
    confirmBtn().click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith({ fieldIds: ['f1', 'f2'], rowScope: 'all', format: 'csv' })
  })
})

const linkBtns = () => Array.from(document.querySelectorAll('.meta-export__bulk .mt-link')) as HTMLButtonElement[]
const selectAllLink = () => linkBtns().find((b) => (b.textContent || '').toLowerCase().includes('select')) as HTMLButtonElement
const clearAllLink = () => linkBtns().find((b) => (b.textContent || '').toLowerCase().includes('clear')) as HTMLButtonElement

describe('MetaExportDialog — MtLink migration (UI-P2-1c T3)', () => {
  it('renders select-all and clear-all as native <button class="mt-link">s (keyboard-operable, no bespoke class left)', () => {
    mount(baseProps())
    const btns = linkBtns()
    expect(btns.length).toBe(2)
    expect(btns.every((b) => b.tagName === 'BUTTON')).toBe(true)
    expect(document.querySelector('.meta-export__link')).toBeNull() // bespoke class fully removed, not just unused
  })

  it('clear-all unchecks every column, then select-all re-checks every column (real state round-trip, not just an emit count)', async () => {
    mount(baseProps())
    const cols = () => Array.from(document.querySelectorAll('.meta-export__cols input[type="checkbox"]')) as HTMLInputElement[]
    expect(cols().every((cb) => cb.checked)).toBe(true) // starts fully checked

    clearAllLink().click()
    await nextTick()
    expect(cols().every((cb) => !cb.checked)).toBe(true)
    expect(confirmBtn().disabled).toBe(true) // canExport flips off

    selectAllLink().click()
    await nextTick()
    expect(cols().every((cb) => cb.checked)).toBe(true)
    expect(confirmBtn().disabled).toBe(false) // canExport flips back on
  })

  it('select-all/clear-all never emit `confirm`/`cancel` themselves (distinct from the footer MtButtons)', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    mount(baseProps(), { onConfirm, onCancel })
    clearAllLink().click()
    selectAllLink().click()
    await nextTick()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })
})
