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
})
