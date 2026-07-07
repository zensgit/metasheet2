import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaToolbar's standalone action buttons (undo/redo/fit/print/import/export/new-record)
// were migrated from bespoke `<button class="meta-toolbar__btn">` markup to the shared MtButton /
// MtIconButton primitives (apps/web/src/multitable/ui). This is an interaction-preservation proof,
// not a snapshot: every migrated control must still be a real, keyboard-operable <button> that
// emits the exact same event (same name, same — absent — payload) it emitted before migration, and
// disabled ones must still carry the native `disabled` attribute so a click never fires the emit.

// Track EVERY mount, not a single shared app/container: several tests mount the toolbar twice (the
// present-vs-absent-by-prop cases), and a shared global would leave the first tree in document.body
// after teardown — DOM pollution that risks false-pass / cross-talk once later slices migrate more
// toolbar controls. afterEach unmounts ALL of them and asserts no toolbar DOM survives.
const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

beforeEach(() => { useLocale().setLocale('en') })
afterEach(() => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  expect(document.querySelectorAll('.meta-toolbar').length).toBe(0) // residue guard: no leaked toolbar
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'status', name: 'Status', type: 'select', options: [{ value: 'a' }] },
]

function mountToolbar(props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaToolbar, {
    fields: FIELDS, hiddenFieldIds: [], sortRules: [], filterRules: [], filterConjunction: 'and',
    canCreateRecord: true, canExport: true, canUndo: true, canRedo: true, sortFilterDirty: false,
    ...props,
  }) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

function byTitle(root: HTMLElement, title: string): HTMLButtonElement {
  const btn = root.querySelector(`button[title="${title}"]`) as HTMLButtonElement | null
  expect(btn, `expected a <button title="${title}">`).toBeTruthy()
  return btn as HTMLButtonElement
}

describe('MetaToolbar action buttons — MtButton/MtIconButton migration (UI-P2-1c)', () => {
  it('undo: is a native <button>, emits undo() when enabled, is disabled (and inert) when canUndo=false', () => {
    const onUndo = vi.fn()
    const root = mountToolbar({ canUndo: true, onUndo })
    const btn = byTitle(root, 'Undo (Ctrl+Z)')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('aria-label')).toBe('Undo')
    expect(btn.disabled).toBe(false)
    btn.click()
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(onUndo).toHaveBeenCalledWith() // no payload — matches pre-migration `emit('undo')`
  })

  it('undo: disabled when canUndo=false — native disabled attribute, click emits nothing', () => {
    const onUndo = vi.fn()
    const root = mountToolbar({ canUndo: false, onUndo })
    const btn = byTitle(root, 'Undo (Ctrl+Z)')
    expect(btn.disabled).toBe(true)
    btn.click()
    expect(onUndo).not.toHaveBeenCalled()
  })

  it('redo: is a native <button>, emits redo() when enabled, is disabled when canRedo=false', () => {
    const onRedo = vi.fn()
    const root = mountToolbar({ canRedo: true, onRedo })
    const btn = byTitle(root, 'Redo (Ctrl+Y)')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('aria-label')).toBe('Redo')
    expect(btn.disabled).toBe(false)
    btn.click()
    expect(onRedo).toHaveBeenCalledTimes(1)
    expect(onRedo).toHaveBeenCalledWith()
  })

  it('redo: disabled when canRedo=false — click emits nothing', () => {
    const onRedo = vi.fn()
    const root = mountToolbar({ canRedo: false, onRedo })
    const btn = byTitle(root, 'Redo (Ctrl+Y)')
    expect(btn.disabled).toBe(true)
    btn.click()
    expect(onRedo).not.toHaveBeenCalled()
  })

  it('fit: emits auto-fit-columns()', () => {
    const onAutoFitColumns = vi.fn()
    const root = mountToolbar({ onAutoFitColumns })
    const btn = byTitle(root, 'Auto-fit columns')
    expect(btn.tagName).toBe('BUTTON')
    btn.click()
    expect(onAutoFitColumns).toHaveBeenCalledTimes(1)
    expect(onAutoFitColumns).toHaveBeenCalledWith()
  })

  it('print: emits print()', () => {
    const onPrint = vi.fn()
    const root = mountToolbar({ onPrint })
    const btn = byTitle(root, 'Print')
    expect(btn.tagName).toBe('BUTTON')
    btn.click()
    expect(onPrint).toHaveBeenCalledTimes(1)
    expect(onPrint).toHaveBeenCalledWith()
  })

  it('import: emits import() when canCreateRecord=true, is absent when canCreateRecord=false', () => {
    const onImport = vi.fn()
    const root = mountToolbar({ canCreateRecord: true, onImport })
    const btn = byTitle(root, 'Import records')
    expect(btn.tagName).toBe('BUTTON')
    btn.click()
    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onImport).toHaveBeenCalledWith()

    const root2 = mountToolbar({ canCreateRecord: false })
    expect(root2.querySelector('button[title="Import records"]')).toBeNull()
  })

  it('export-csv: emits export-csv() when canExport=true, is absent when canExport=false', () => {
    const onExportCsv = vi.fn()
    const root = mountToolbar({ canExport: true, onExportCsv })
    const btn = byTitle(root, 'Export CSV')
    expect(btn.tagName).toBe('BUTTON')
    btn.click()
    expect(onExportCsv).toHaveBeenCalledTimes(1)
    expect(onExportCsv).toHaveBeenCalledWith()

    const root2 = mountToolbar({ canExport: false })
    expect(root2.querySelector('button[title="Export CSV"]')).toBeNull()
  })

  it('export-xlsx: emits export-xlsx() when canExport=true, is absent when canExport=false', () => {
    const onExportXlsx = vi.fn()
    const root = mountToolbar({ canExport: true, onExportXlsx })
    const btn = byTitle(root, 'Export Excel (.xlsx)')
    expect(btn.tagName).toBe('BUTTON')
    btn.click()
    expect(onExportXlsx).toHaveBeenCalledTimes(1)
    expect(onExportXlsx).toHaveBeenCalledWith()

    const root2 = mountToolbar({ canExport: false })
    expect(root2.querySelector('button[title="Export Excel (.xlsx)"]')).toBeNull()
  })

  it('new record: primary CTA emits add-record() when canCreateRecord=true, is absent when false', () => {
    const onAddRecord = vi.fn()
    const root = mountToolbar({ canCreateRecord: true, onAddRecord })
    const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === '+ New Record') as HTMLButtonElement
    expect(btn, 'expected the "+ New Record" primary CTA button').toBeTruthy()
    expect(btn.tagName).toBe('BUTTON')
    btn.click()
    expect(onAddRecord).toHaveBeenCalledTimes(1)
    expect(onAddRecord).toHaveBeenCalledWith()

    const root2 = mountToolbar({ canCreateRecord: false })
    expect(Array.from(root2.querySelectorAll('button')).some((b) => b.textContent?.trim() === '+ New Record')).toBe(false)
  })

  it('reset-to-shared is untouched by this slice: still renders via data-testid, still a plain button', () => {
    const onResetToShared = vi.fn()
    const root = mountToolbar({ canResetToShared: true, onResetToShared })
    const btn = root.querySelector('[data-testid="reset-to-shared"]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.tagName).toBe('BUTTON')
    btn.click()
    expect(onResetToShared).toHaveBeenCalledTimes(1)
  })
})
