import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField } from '../src/multitable/types'

const fields: MetaField[] = [
  { id: 'fld_name', name: 'Name', type: 'string', property: {} },
  { id: 'fld_amount', name: 'Amount', type: 'number', property: {} },
]

const rows = [
  { id: 'rec_1', data: { fld_name: 'Alpha', fld_amount: 1 }, version: 1 },
  { id: 'rec_2', data: { fld_name: 'Beta', fld_amount: 2 }, version: 1 },
  { id: 'rec_3', data: { fld_name: 'Gamma', fld_amount: 3 }, version: 1 },
]

function mount(overrides: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const props: Record<string, unknown> = {
    rows,
    visibleFields: fields,
    sortRules: [],
    loading: false,
    currentPage: 1,
    totalPages: 1,
    startIndex: 0,
    canEdit: true,
    canDelete: true,
    canBulkEdit: true,
    enableMultiSelect: true,
    ...overrides,
  }
  const app = createApp({
    render() {
      return h(MetaGridTable, props)
    },
  })
  app.mount(container)
  return { app, container, props }
}

function selectAllRows(container: HTMLElement) {
  const headerCheckbox = container.querySelector('thead .meta-grid__check-col input[type=checkbox]') as HTMLInputElement
  headerCheckbox.click()
}

describe('MetaGridTable bulk-edit affordances', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders Set field and Clear field buttons when canBulkEdit and selection are present', async () => {
    const { app, container } = mount()
    await nextTick()

    selectAllRows(container)
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('.meta-grid__bulk-bar .meta-grid__bulk-btn')) as HTMLButtonElement[]
    const labels = buttons.map((btn) => btn.textContent?.trim())
    expect(labels).toContain('Set field')
    expect(labels).toContain('Clear field')
    expect(labels).toContain('Delete selected')
    app.unmount()
  })

  it('hides Set/Clear field buttons when canBulkEdit is false', async () => {
    const { app, container } = mount({ canBulkEdit: false })
    await nextTick()

    selectAllRows(container)
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('.meta-grid__bulk-bar .meta-grid__bulk-btn')) as HTMLButtonElement[]
    const labels = buttons.map((btn) => btn.textContent?.trim())
    expect(labels).not.toContain('Set field')
    expect(labels).not.toContain('Clear field')
    app.unmount()
  })

  it('clicking Set field emits bulk-edit with mode=set and current selection', async () => {
    const onBulkEdit = vi.fn()
    const { app, container } = mount({ onBulkEdit })
    await nextTick()

    selectAllRows(container)
    await nextTick()

    const setBtn = Array.from(container.querySelectorAll('.meta-grid__bulk-bar .meta-grid__bulk-btn'))
      .find((btn) => btn.textContent?.trim() === 'Set field') as HTMLButtonElement
    setBtn.click()
    await nextTick()

    expect(onBulkEdit).toHaveBeenCalledTimes(1)
    expect(onBulkEdit).toHaveBeenCalledWith({
      mode: 'set',
      recordIds: ['rec_1', 'rec_2', 'rec_3'],
    })
    app.unmount()
  })

  it('clicking Clear field emits bulk-edit with mode=clear and current selection', async () => {
    const onBulkEdit = vi.fn()
    const { app, container } = mount({ onBulkEdit })
    await nextTick()

    selectAllRows(container)
    await nextTick()

    const clearBtn = Array.from(container.querySelectorAll('.meta-grid__bulk-bar .meta-grid__bulk-btn'))
      .find((btn) => btn.textContent?.trim() === 'Clear field') as HTMLButtonElement
    clearBtn.click()
    await nextTick()

    expect(onBulkEdit).toHaveBeenCalledTimes(1)
    expect(onBulkEdit).toHaveBeenCalledWith({
      mode: 'clear',
      recordIds: ['rec_1', 'rec_2', 'rec_3'],
    })
    app.unmount()
  })

  it('does not render Set/Clear buttons when there is no selection', async () => {
    const { app, container } = mount()
    await nextTick()

    const bar = container.querySelector('.meta-grid__bulk-bar')
    expect(bar).toBeNull()
    app.unmount()
  })

  it('canEdit=true / canDelete=false: row checkboxes are enabled and bulk-edit emits all editable IDs (regression: PR #1451 review)', async () => {
    const onBulkEdit = vi.fn()
    const onBulkDelete = vi.fn()
    const { app, container } = mount({
      canEdit: true,
      canDelete: false,
      canBulkEdit: true,
      onBulkEdit,
      onBulkDelete,
    })
    await nextTick()

    const rowCheckboxes = Array.from(
      container.querySelectorAll('tbody .meta-grid__check-col input[type=checkbox]'),
    ) as HTMLInputElement[]
    expect(rowCheckboxes.length).toBe(3)
    for (const cb of rowCheckboxes) {
      expect(cb.disabled).toBe(false)
    }

    selectAllRows(container)
    await nextTick()

    const buttons = Array.from(
      container.querySelectorAll('.meta-grid__bulk-bar .meta-grid__bulk-btn'),
    ) as HTMLButtonElement[]
    const labels = buttons.map((btn) => btn.textContent?.trim())
    expect(labels).toContain('Set field')
    expect(labels).toContain('Clear field')
    expect(labels).not.toContain('Delete selected')

    const setBtn = buttons.find((btn) => btn.textContent?.trim() === 'Set field') as HTMLButtonElement
    setBtn.click()
    await nextTick()

    expect(onBulkEdit).toHaveBeenCalledTimes(1)
    expect(onBulkEdit).toHaveBeenCalledWith({
      mode: 'set',
      recordIds: ['rec_1', 'rec_2', 'rec_3'],
    })
    expect(onBulkDelete).not.toHaveBeenCalled()
    app.unmount()
  })

  it('mixed per-row permissions: bulk-delete emits only deletable IDs and bulk-edit emits only editable IDs', async () => {
    const onBulkDelete = vi.fn()
    const onBulkEdit = vi.fn()
    const { app, container } = mount({
      canEdit: true,
      canDelete: true,
      canBulkEdit: true,
      rowActionOverrides: {
        rec_1: { canEdit: true, canDelete: false, canComment: true },
        rec_2: { canEdit: false, canDelete: true, canComment: true },
        rec_3: { canEdit: true, canDelete: true, canComment: true },
      },
      onBulkDelete,
      onBulkEdit,
    })
    await nextTick()

    selectAllRows(container)
    await nextTick()

    const buttons = Array.from(
      container.querySelectorAll('.meta-grid__bulk-bar .meta-grid__bulk-btn'),
    ) as HTMLButtonElement[]

    const setBtn = buttons.find((btn) => btn.textContent?.trim() === 'Set field') as HTMLButtonElement
    setBtn.click()
    await nextTick()

    expect(onBulkEdit).toHaveBeenCalledWith({
      mode: 'set',
      recordIds: ['rec_1', 'rec_3'],
    })

    const deleteBtn = buttons.find((btn) => btn.textContent?.trim() === 'Delete selected') as HTMLButtonElement
    deleteBtn.click()
    await nextTick()

    expect(onBulkDelete).toHaveBeenCalledWith(['rec_2', 'rec_3'])
    app.unmount()
  })

  it('row with neither canEdit nor canDelete keeps its checkbox disabled even when sheet allows bulk actions', async () => {
    const { app, container } = mount({
      canEdit: true,
      canDelete: true,
      canBulkEdit: true,
      rowActionOverrides: {
        rec_2: { canEdit: false, canDelete: false, canComment: true },
      },
    })
    await nextTick()

    const rowCheckboxes = Array.from(
      container.querySelectorAll('tbody .meta-grid__check-col input[type=checkbox]'),
    ) as HTMLInputElement[]
    expect(rowCheckboxes[0].disabled).toBe(false)
    expect(rowCheckboxes[1].disabled).toBe(true)
    expect(rowCheckboxes[2].disabled).toBe(false)
    app.unmount()
  })
})
