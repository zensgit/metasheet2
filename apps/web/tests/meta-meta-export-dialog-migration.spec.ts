import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaExportDialog from '../src/multitable/components/MetaExportDialog.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaExportDialog's two footer action controls (cancel / confirm) were migrated from
// bespoke <button>s to the shared MtButton primitive (confirm = variant="primary"). Behavior-
// preservation proof: they stay native, keyboard-operable <button>s; the `:disabled="!canExport"`
// binding survives on confirm; and clicking them still emits the SAME `cancel` / `confirm` events
// with the SAME payload. The dialog teleports to <body>, so queries hit `document`, not the mount
// container. The select-all / clear-all link buttons stay bespoke (untouched — a separate PR's territory).
//
// UI-P2-1c T1 batch-2: the header close-× (`.meta-export__close`) was additionally migrated from a
// bespoke <button>&times;</button> to the shared MtIconButton primitive — the &times; glyph passes
// through MtIconButton's default-slot icon fallback (glyph char preserved, size token-normalized to
// the icon control, consistent with the existing glyph-MtIconButton controls already on main).
// Behavior-preservation proof: it stays a native, keyboard-operable <button>, keeps the SAME
// aria-label (`l('export.close')`), and clicking it still calls the SAME onCancel() → emits `cancel`
// (identical to the footer cancel button's handler). This is the only sharer of `.meta-export__close`
// (single button, single file) — its bespoke CSS was removed outright, no double-styling risk.

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
    // Uncheck both columns via the bespoke "clear all" link → canExport false.
    const clearAll = Array.from(document.querySelectorAll('.meta-export__link'))
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

  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + aria-label', () => {
    mount(baseProps())
    const btn = document.querySelector('.meta-export__close') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-export__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Close')
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('clicking the header close-× emits `cancel` (unchanged — same onCancel as the footer cancel button)', () => {
    const onCancel = vi.fn()
    mount(baseProps(), { onCancel })
    const btn = document.querySelector('.meta-export__close') as HTMLButtonElement
    btn.click()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledWith()
  })
})
