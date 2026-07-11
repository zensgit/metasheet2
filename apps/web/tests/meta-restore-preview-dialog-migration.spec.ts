import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import RestorePreviewDialog from '../src/multitable/components/RestorePreviewDialog.vue'

// UI-P2-1c: RestorePreviewDialog's two footer action controls (cancel / Execute-confirm) were
// migrated from bespoke <button>s to the shared MtButton primitive (Execute = variant="primary").
// Behavior-preservation proof: they stay native, keyboard-operable <button>s; the `:disabled` binding
// on Execute survives; and clicking them still emits the SAME `cancel` / `confirm` events with no
// change to payload. The dialog teleports to <body>, so queries hit `document`, not the mount
// container. Locale comes from the `isZh` prop (not the useLocale composable), so no locale reset.

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
})
