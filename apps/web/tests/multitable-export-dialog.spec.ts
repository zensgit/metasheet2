import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaExportDialog, { type ExportColumn, type ExportConfirmPayload } from '../src/multitable/components/MetaExportDialog.vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'

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

    ;(root.querySelector('.meta-export__bulk .mt-link:last-child') as HTMLButtonElement).click() // Clear all (UI-P2-1c T3: now MtLink)
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
    expect(root.textContent).toContain('当前视图的全部行（按视图筛选，不含搜索）')
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

// 备料分批拉取第一期 step 3 (PR A): the toolbar entry points into this dialog. On a sheet the server closed for
// generic grid export the two export buttons stay VISIBLE but DISABLED, with the reason on them; a click emits
// nothing. On every other sheet nothing changes: `canExport` alone decides, as before.
describe('MetaToolbar export buttons — grid export closure', () => {
  const REASON = '这是试点备料表，通用导出（整表、选中行、CSV、Excel）已关闭。正式交接请用「项目物料导出」；打印和复制选区不能作为交接依据。'
  const mounted: Array<{ unmount: () => void; container: HTMLElement }> = []
  afterEach(() => {
    while (mounted.length) {
      const m = mounted.pop()!
      m.unmount()
      m.container.remove()
    }
    useLocale().setLocale('en')
  })

  function mountToolbar(props: Record<string, unknown>) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ render: () => h(MetaToolbar, {
      fields: [{ id: 'fld_name', name: 'Name', type: 'string' }], hiddenFieldIds: [], sortRules: [], filterRules: [], filterConjunction: 'and',
      canCreateRecord: false, canUndo: false, canRedo: false,
      ...props,
    }) })
    app.mount(container)
    mounted.push({ unmount: () => app.unmount(), container })
    return container
  }

  it('ordinary sheet: two enabled export buttons that emit, and no closure wrapper', async () => {
    useLocale().setLocale('en')
    const onExportCsv = vi.fn()
    const onExportXlsx = vi.fn()
    const root = mountToolbar({ canExport: true, onExportCsv, onExportXlsx })
    await nextTick()
    expect(root.querySelector('[data-testid="meta-toolbar-export-closed"]')).toBeNull()
    const csv = root.querySelector<HTMLButtonElement>('button[title="Export CSV"]')!
    expect(csv.disabled).toBe(false)
    csv.click()
    expect(onExportCsv).toHaveBeenCalledTimes(1)
    root.querySelector<HTMLButtonElement>('button[aria-label="Export Excel"]')!.click()
    expect(onExportXlsx).toHaveBeenCalledTimes(1)
  })

  it('ordinary sheet without export capability: no export buttons at all (unchanged)', async () => {
    const root = mountToolbar({ canExport: false })
    await nextTick()
    expect(root.querySelector('button[title="Export CSV"]')).toBeNull()
    expect(root.querySelector('[data-testid="meta-toolbar-export-closed"]')).toBeNull()
  })

  it('closed sheet: both buttons render DISABLED with the reason, and clicks emit nothing', async () => {
    useLocale().setLocale('zh-CN')
    const onExportCsv = vi.fn()
    const onExportXlsx = vi.fn()
    const root = mountToolbar({ canExport: false, exportClosedReason: REASON, onExportCsv, onExportXlsx })
    await nextTick()
    const wrapper = root.querySelector<HTMLElement>('[data-testid="meta-toolbar-export-closed"]')!
    expect(wrapper).not.toBeNull()
    expect(wrapper.getAttribute('title')).toBe(REASON)
    const buttons = Array.from(wrapper.querySelectorAll<HTMLButtonElement>('button[data-export-closed]'))
    expect(buttons.map((b) => b.getAttribute('data-export-closed'))).toEqual(['csv', 'xlsx'])
    for (const button of buttons) {
      expect(button.disabled).toBe(true)
      expect(button.getAttribute('title')).toBe(REASON)
      button.click()
    }
    expect(onExportCsv).not.toHaveBeenCalled()
    expect(onExportXlsx).not.toHaveBeenCalled()
    // The enabled pair is gone, so no other export button exists in the toolbar.
    expect(root.querySelectorAll('button:not([disabled])[aria-label*="导出"]').length).toBe(0)
  })

  it('exportPending (sheet-switch window): the pair stays rendered but disabled, no reason wrapper, clicks emit nothing', async () => {
    useLocale().setLocale('en')
    const onExportCsv = vi.fn()
    const onExportXlsx = vi.fn()
    const root = mountToolbar({ canExport: true, exportPending: true, onExportCsv, onExportXlsx })
    await nextTick()
    expect(root.querySelector('[data-testid="meta-toolbar-export-closed"]')).toBeNull()
    const csv = root.querySelector<HTMLButtonElement>('button[title="Export CSV"]')!
    const xlsx = root.querySelector<HTMLButtonElement>('button[aria-label="Export Excel"]')!
    expect([csv.disabled, xlsx.disabled]).toEqual([true, true])
    csv.click()
    xlsx.click()
    expect(onExportCsv).not.toHaveBeenCalled()
    expect(onExportXlsx).not.toHaveBeenCalled()
  })

  it('closed sheet: a stray canExport=true never re-enables the buttons (the reason wins)', async () => {
    const onExportCsv = vi.fn()
    const root = mountToolbar({ canExport: true, exportClosedReason: REASON, onExportCsv })
    await nextTick()
    const enabled = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).filter((b) => /Export|导出/.test(b.textContent ?? '') && !b.disabled)
    expect(enabled).toEqual([])
    root.querySelector<HTMLButtonElement>('button[data-export-closed="csv"]')!.click()
    expect(onExportCsv).not.toHaveBeenCalled()
  })
})
