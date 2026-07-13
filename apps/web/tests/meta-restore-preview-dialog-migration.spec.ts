import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import RestorePreviewDialog from '../src/multitable/components/RestorePreviewDialog.vue'

// UI-P2-1c: RestorePreviewDialog's two footer action controls (cancel / Execute-confirm) were
// migrated from bespoke <button>s to the shared MtButton primitive (Execute = variant="primary").
// Behavior-preservation proof: they stay native, keyboard-operable <button>s; the `:disabled` binding
// on Execute survives; and clicking them still emits the SAME `cancel` / `confirm` events with no
// change to payload. The dialog teleports to <body>, so queries hit `document`, not the mount
// container. Locale comes from the `isZh` prop (not the useLocale composable), so no locale reset.
//
// UI-P2-1c T1 batch-4 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED): the
// header close-× (`.restore-preview__close`) was additionally migrated from a bespoke <button>&times;</button>
// to the shared MtIconButton primitive — the &times; glyph passes through MtIconButton's default-slot icon
// fallback (glyph char preserved, size token-normalized to the icon control, consistent with the existing
// glyph-MtIconButton controls already on main). Behavior-preservation proof: it stays a native,
// keyboard-operable <button>, keeps the SAME aria-label (`l('record.restorePreviewCancel')`), and clicking
// it still calls the SAME onCancel() → emits the SAME `cancel` event (identical to the footer cancel
// button's handler). This is the only sharer of `.restore-preview__close` (single button, single file) —
// its bespoke CSS was removed outright, no double-styling risk. The footer Execute-confirm button was NOT
// touched by this migration — see the pre-existing tests below (kept as the positive control).

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.restore-preview-overlay').length).toBe(0) // teleport residue guard
})

function mount(props: Record<string, unknown>, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(RestorePreviewDialog, { ...props, ...handlers }) })
  app.mount(container)
  mounts.push({ app, container })
}

// canConfirm = !loading && executable && !schemaDrift && changes.length > 0 — this fixture makes the
// Execute button enabled so the confirm click path is exercisable.
const baseProps = () => ({
  visible: true,
  loading: false,
  executable: true,
  schemaDrift: false,
  changes: [{ fieldId: 'f1', op: 'set', value: 'x' }],
  fieldName: (id: string) => id,
  isZh: false,
})

const cancelBtn = () =>
  document.querySelector('.restore-preview__btn:not(.restore-preview__btn--primary)') as HTMLButtonElement
const confirmBtn = () =>
  document.querySelector('[data-test="restore-preview-confirm"]') as HTMLButtonElement

describe('RestorePreviewDialog — MtButton migration (UI-P2-1c)', () => {
  it('renders cancel + Execute as native <button>s', () => {
    mount(baseProps())
    expect(cancelBtn()).toBeTruthy()
    expect(confirmBtn()).toBeTruthy()
    expect(cancelBtn().tagName).toBe('BUTTON') // keyboard-operable, not a bare div
    expect(confirmBtn().tagName).toBe('BUTTON')
  })

  it('Execute is disabled when there is no executable change set (:disabled="!canConfirm" survives)', () => {
    mount({ ...baseProps(), changes: [] }) // empty change set → canConfirm false
    expect(confirmBtn().disabled).toBe(true)
  })

  it('clicking cancel emits `cancel` (unchanged from pre-migration onCancel)', () => {
    const onCancel = vi.fn()
    mount(baseProps(), { onCancel })
    cancelBtn().click()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('clicking Execute (enabled) emits `confirm` (unchanged from pre-migration onConfirm)', () => {
    const onConfirm = vi.fn()
    mount(baseProps(), { onConfirm })
    expect(confirmBtn().disabled).toBe(false) // precondition driven enabled
    confirmBtn().click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + aria-label + glyph', () => {
    mount(baseProps())
    const btn = document.querySelector('.restore-preview__close') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('restore-preview__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Cancel')
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('clicking the header close-× emits `cancel` (unchanged — same onCancel as the footer cancel button)', () => {
    const onCancel = vi.fn()
    mount(baseProps(), { onCancel })
    const btn = document.querySelector('.restore-preview__close') as HTMLButtonElement
    btn.click()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
