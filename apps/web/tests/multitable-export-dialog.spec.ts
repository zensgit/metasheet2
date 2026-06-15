import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaExportDialog, { type ExportColumn, type ExportConfirmPayload } from '../src/multitable/components/MetaExportDialog.vue'

const baseFields: ExportColumn[] = [
  { id: 'fld_name', name: 'Name' },
  { id: 'fld_amount', name: 'Amount' },
  { id: 'fld_status', name: 'Status' },
]

function mountDialog(propsOverride: Partial<{
  visible: boolean
  fields: ExportColumn[]
  selectedRowCount: number
  initialFormat: 'csv' | 'xlsx'
  onConfirm: (p: ExportConfirmPayload) => void
  onCancel: () => void
}> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const props = {
    visible: true,
    fields: baseFields,
    selectedRowCount: 0,
    initialFormat: 'xlsx' as const,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...propsOverride,
  }
  const app = createApp({ render() { return h(MetaExportDialog, props) } })
  app.mount(container)
  return { app, props, root: document.body }
}

function colCheckboxes(root: HTMLElement): HTMLInputElement[] {
  return Array.from(root.querySelectorAll('.meta-export__cols input[type="checkbox"]'))
}

describe('MetaExportDialog', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    useLocale().setLocale('en')
    vi.restoreAllMocks()
  })

  it('defaults to all columns checked and emits them in on-screen order with all-rows + initial format', async () => {
    const onConfirm = vi.fn()
    const { app, root } = mountDialog({ onConfirm, initialFormat: 'xlsx' })
    await nextTick()

    expect(colCheckboxes(root).every((cb) => cb.checked)).toBe(true)
    ;(root.querySelector('.meta-export__btn--primary') as HTMLButtonElement).click()
    await nextTick()

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0]).toEqual({
      fieldIds: ['fld_name', 'fld_amount', 'fld_status'],
      rowScope: 'all',
      format: 'xlsx',
    })
    app.unmount()
  })

  it('excludes an unchecked column and preserves on-screen order', async () => {
    const onConfirm = vi.fn()
    const { app, root } = mountDialog({ onConfirm })
    await nextTick()

    // Uncheck the middle column (Amount).
    const amount = colCheckboxes(root)[1]
    amount.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    ;(root.querySelector('.meta-export__btn--primary') as HTMLButtonElement).click()
    await nextTick()
    expect(onConfirm.mock.calls[0][0].fieldIds).toEqual(['fld_name', 'fld_status'])
    app.unmount()
  })

  it('blocks export with zero columns: button disabled, warning shown, no emit', async () => {
    const onConfirm = vi.fn()
    const { app, root } = mountDialog({ onConfirm })
    await nextTick()

    ;(root.querySelector('.meta-export__link:last-child') as HTMLButtonElement).click() // Clear all
    await nextTick()

    const btn = root.querySelector('.meta-export__btn--primary') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(root.querySelector('.meta-export__hint--warn')).not.toBeNull()
    btn.click()
    await nextTick()
    expect(onConfirm).not.toHaveBeenCalled()
    app.unmount()
  })

  it('disables "selected rows only" when nothing is selected', async () => {
    const { app, root } = mountDialog({ selectedRowCount: 0 })
    await nextTick()
    const selected = root.querySelector('input[type="radio"][value="selected"]') as HTMLInputElement
    expect(selected.disabled).toBe(true)
    app.unmount()
  })

  it('emits rowScope "selected" when selection exists and the option is chosen', async () => {
    const onConfirm = vi.fn()
    const { app, root } = mountDialog({ onConfirm, selectedRowCount: 2 })
    await nextTick()

    const selected = root.querySelector('input[type="radio"][value="selected"]') as HTMLInputElement
    expect(selected.disabled).toBe(false)
    selected.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    ;(root.querySelector('.meta-export__btn--primary') as HTMLButtonElement).click()
    await nextTick()
    expect(onConfirm.mock.calls[0][0].rowScope).toBe('selected')
    app.unmount()
  })

  it('preselects the initial format (csv) and emits it', async () => {
    const onConfirm = vi.fn()
    const { app, root } = mountDialog({ onConfirm, initialFormat: 'csv' })
    await nextTick()

    const csv = root.querySelector('input[type="radio"][value="csv"]') as HTMLInputElement
    expect(csv.checked).toBe(true)
    ;(root.querySelector('.meta-export__btn--primary') as HTMLButtonElement).click()
    await nextTick()
    expect(onConfirm.mock.calls[0][0].format).toBe('csv')
    app.unmount()
  })

  it('renders zh-CN chrome while preserving raw column names', async () => {
    useLocale().setLocale('zh-CN')
    const { app, root } = mountDialog({})
    await nextTick()
    expect(root.querySelector('.meta-export__header strong')?.textContent).toBe('导出选项')
    expect(root.textContent).toContain('全部已加载行')
    expect(root.textContent).toContain('Name') // raw field name unchanged
    app.unmount()
  })

  it('emits cancel on close', async () => {
    const onCancel = vi.fn()
    const { app, root } = mountDialog({ onCancel })
    await nextTick()
    ;(root.querySelector('.meta-export__close') as HTMLButtonElement).click()
    expect(onCancel).toHaveBeenCalledTimes(1)
    app.unmount()
  })
})
