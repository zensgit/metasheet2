import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaImportModal from '../src/multitable/components/MetaImportModal.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaImportModal's paste-step footer Cancel + Preview controls were migrated from
// bespoke <button>s to the shared MtButton primitive (Preview = variant="primary"). Behavior-
// preservation proof: they stay native, keyboard-operable <button>s; the `:disabled="isImporting"`
// (cancel) and `:disabled="!rawText.trim()"` (preview) bindings survive; and clicking them still
// drives the SAME handlers — requestClose() -> emits `close`, and parseAndPreview() -> transitions
// the modal into the preview step with the parsed rows/headers. The modal teleports to <body>, so
// queries hit `document`, not the mount container. Every other step's buttons (back, import,
// cancelImport, backToMapping, retry, applyFixes, close, reconcile, per-failure picker) and the
// close-× glyph stay bespoke (untouched) — they share the `.meta-import__btn` / `--primary` classes
// as sibling bespoke controls, so that CSS is intentionally left in place.

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-import-overlay').length).toBe(0) // teleport residue guard
  useLocale().setLocale('en')
  window.localStorage.clear()
})

function mount(props: Record<string, unknown>, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaImportModal, { ...props, ...handlers }) })
  app.mount(container)
  mounts.push({ app, container })
}

const baseProps = () => ({
  visible: true,
  sheetId: 'sheet_migration_test',
  fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
  importing: false,
  result: null,
})

const pasteActions = () =>
  Array.from(document.querySelectorAll('.meta-import__body .meta-import__actions .meta-import__btn')) as HTMLButtonElement[]
const cancelBtn = () => pasteActions().find((b) => !b.classList.contains('meta-import__btn--primary')) as HTMLButtonElement
const previewBtn = () => pasteActions().find((b) => b.classList.contains('meta-import__btn--primary')) as HTMLButtonElement

async function flushUi() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('MetaImportModal — MtButton migration (UI-P2-1c)', () => {
  it('renders paste-step Cancel + Preview as native <button>s on initial mount', () => {
    mount(baseProps())
    const btns = pasteActions()
    expect(btns.length).toBe(2)
    expect(btns.every((b) => b.tagName === 'BUTTON')).toBe(true) // keyboard-operable, not bare divs
    // Cancel enabled while not importing; Preview disabled until rawText has content.
    expect(cancelBtn().disabled).toBe(false)
    expect(previewBtn().disabled).toBe(true)
  })

  it('preview becomes enabled once rawText is populated (:disabled="!rawText.trim()" survives)', async () => {
    mount(baseProps())
    const textarea = document.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\nAlice'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(previewBtn().disabled).toBe(false)
  })

  it('clicking cancel emits `close` (unchanged from pre-migration requestClose)', async () => {
    const onClose = vi.fn()
    mount(baseProps(), { onClose, onImport: vi.fn() })
    cancelBtn().click()
    await flushUi()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking preview drives the SAME parseAndPreview handler: transitions into the preview step with parsed headers/rows', async () => {
    mount(baseProps(), { onClose: vi.fn(), onImport: vi.fn() })
    const textarea = document.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\nAlice'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(previewBtn().disabled).toBe(false)

    previewBtn().click()
    await flushUi()

    // If @click had been dropped, parseAndPreview() never runs and the paste-step footer (with a
    // disabled preview button) would still be showing instead of the mapping/preview UI below.
    expect(document.querySelector('.meta-import__mapping')).not.toBeNull()
    expect(document.querySelector('.meta-import__col-name')?.textContent).toBe('Name')
    expect(document.body.textContent).toContain('1 record(s) detected')
    // Paste-step body (textarea + migrated footer) is gone now that step === 'preview'.
    expect(document.querySelector('.meta-import__textarea')).toBeNull()
  })
})
