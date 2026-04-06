import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({
      push: vi.fn().mockResolvedValue(undefined),
    }),
  }
})
const { mockGlobalListLinkOptions } = vi.hoisted(() => ({
  mockGlobalListLinkOptions: vi.fn(),
}))

function stubComponent(name: string) {
  return defineComponent({
    name,
    render() {
      return h('div', { [`data-stub-${name}`]: 'true' })
    },
  })
}

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listLinkOptions: mockGlobalListLinkOptions,
  },
}))

let workbenchMock: any
let gridMock: any

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({
  useMultitableWorkbench: () => workbenchMock,
}))

vi.mock('../src/multitable/composables/useMultitableGrid', () => ({
  useMultitableGrid: () => gridMock,
}))

vi.mock('../src/multitable/composables/useMultitableCapabilities', () => ({
  useMultitableCapabilities: () => ({
    canRead: ref(true),
    canCreateRecord: ref(true),
    canEditRecord: ref(true),
    canDeleteRecord: ref(true),
    canManageFields: ref(true),
    canManageSheetAccess: ref(true),
    canManageViews: ref(true),
    canComment: ref(true),
    canManageAutomation: ref(false),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableComments', () => ({
  useMultitableComments: () => ({
    comments: ref([]),
    loading: ref(false),
    submitting: ref(false),
    resolvingIds: ref<string[]>([]),
    updatingIds: ref<string[]>([]),
    deletingIds: ref<string[]>([]),
    error: ref<string | null>(null),
    loadComments: vi.fn(),
    addComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    resolveComment: vi.fn(),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableCommentInbox', () => ({
  useMultitableCommentInbox: () => ({
    unreadCount: ref(0),
    refreshUnreadCount: vi.fn().mockResolvedValue(0),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableCommentRealtime', () => ({
  useMultitableCommentRealtime: vi.fn(),
}))

vi.mock('../src/multitable/composables/useMultitableSheetRealtime', () => ({
  useMultitableSheetRealtime: vi.fn(),
}))

vi.mock('../src/multitable/components/MetaViewTabBar.vue', () => ({
  default: stubComponent('MetaViewTabBar'),
}))

vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({
  default: defineComponent({
    name: 'MetaToolbar',
    emits: ['import'],
    render() {
      return h(
        'button',
        {
          'data-open-import': 'true',
          onClick: () => this.$emit('import'),
        },
        'open-import',
      )
    },
  }),
}))

vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({ default: stubComponent('MetaGridTable') }))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
vi.mock('../src/multitable/components/MetaRecordDrawer.vue', () => ({ default: stubComponent('MetaRecordDrawer') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({ default: stubComponent('MetaFieldManager') }))
vi.mock('../src/multitable/components/MetaViewManager.vue', () => ({ default: stubComponent('MetaViewManager') }))
vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({ default: stubComponent('MetaBasePicker') }))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({ default: stubComponent('MetaKanbanView') }))
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({ default: stubComponent('MetaGalleryView') }))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: stubComponent('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({ default: stubComponent('MetaTimelineView') }))
vi.mock('../src/multitable/components/MetaToast.vue', () => ({
  default: defineComponent({
    name: 'MetaToast',
    setup(_, { expose }) {
      expose({
        showError: showErrorSpy,
        showSuccess: showSuccessSpy,
      })
      return () => h('div', { 'data-toast': 'true' })
    },
  }),
}))

import MultitableWorkbench from '../src/multitable/views/MultitableWorkbench.vue'

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function createWorkbenchMock(fields: Array<Record<string, unknown>>) {
  const activeBaseId = ref('base_ops')
  const activeSheetId = ref('sheet_orders')
  const activeViewId = ref('view_grid')
  const views = ref([
    { id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' },
  ])
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({
        bases: [{ id: 'base_ops', name: 'Ops Base' }],
      }),
      listFields: vi.fn().mockResolvedValue({ fields: [] }),
      listLinkOptions: vi.fn(),
      loadFormContext: vi.fn(),
      getRecord: vi.fn(),
      createSheet: vi.fn(),
      createBase: vi.fn(),
      createField: vi.fn(),
      preparePersonField: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
      createView: vi.fn(),
      updateView: vi.fn(),
      deleteView: vi.fn(),
      patchRecords: vi.fn(),
      submitForm: vi.fn(),
      createRecord: vi.fn(),
      uploadAttachment: vi.fn(),
      deleteAttachment: vi.fn(),
      listRecordSummaries: vi.fn(),
    },
    sheets: ref([{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]),
    fields: ref(fields as any),
    views,
    activeBaseId,
    activeSheetId,
    activeViewId,
    capabilities: ref({
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
      canManageFields: true,
      canManageSheetAccess: true,
      canManageViews: true,
      canComment: true,
      canManageAutomation: false,
    }),
    fieldPermissions: ref({}),
    viewPermissions: ref({}),
    activeView: computed(() => views.value.find((view) => view.id === activeViewId.value) ?? null),
    loading: ref(false),
    error: ref<string | null>(null),
    loadSheets: vi.fn().mockResolvedValue(true),
    loadBaseContext: vi.fn().mockResolvedValue(true),
    loadSheetMeta: vi.fn().mockResolvedValue(true),
    switchBase: vi.fn().mockResolvedValue(true),
    syncExternalContext: vi.fn().mockResolvedValue(true),
    selectBase: vi.fn((baseId: string) => { activeBaseId.value = baseId }),
    selectSheet: vi.fn((sheetId: string) => { activeSheetId.value = sheetId }),
    selectView: vi.fn((viewId: string) => { activeViewId.value = viewId }),
  }
}

function createGridMock(fields: Array<Record<string, unknown>>) {
  return {
    fields: ref(fields as any),
    rows: ref([]),
    loading: ref(false),
    currentPage: ref(1),
    totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }),
    visibleFields: ref(fields as any),
    sortRules: ref([]),
    filterRules: ref([]),
    filterConjunction: ref('and'),
    canUndo: ref(false),
    canRedo: ref(false),
    groupFieldId: ref<string | null>(null),
    groupField: ref(null),
    hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}),
    linkSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    attachmentSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    fieldPermissions: ref({}),
    viewPermission: ref(null),
    rowActions: ref(null),
    rowActionOverrides: ref<Record<string, { canEdit: boolean; canDelete: boolean; canComment: boolean }>>({}),
    conflict: ref(null),
    error: ref<string | null>(null),
    sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(),
    addSortRule: vi.fn(),
    removeSortRule: vi.fn(),
    addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(),
    removeFilterRule: vi.fn(),
    clearFilters: vi.fn(),
    applySortFilter: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    setGroupField: vi.fn(),
    goToPage: vi.fn(),
    patchCell: vi.fn(),
    createRecord: vi.fn(),
    deleteRecord: vi.fn(),
    resolveRowActions: vi.fn(() => null),
    loadViewData: vi.fn(),
    reloadCurrentPage: vi.fn(),
    dismissConflict: vi.fn(),
    retryConflict: vi.fn(),
    setColumnWidth: vi.fn(),
    setSearchQuery: vi.fn(),
  }
}

describe('MultitableWorkbench import flow', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockGlobalListLinkOptions.mockReset()
    vi.useFakeTimers()
    window.localStorage.clear()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.clearAllMocks()
    window.localStorage.clear()
    showErrorSpy.mockReset()
    showSuccessSpy.mockReset()
  })

  function mountWorkbench(fields: Array<Record<string, unknown>>) {
    workbenchMock = createWorkbenchMock(fields)
    gridMock = createGridMock(fields)
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(defineComponent({
      render() {
        return h(MultitableWorkbench as Component, {
          baseId: 'base_ops',
          sheetId: 'sheet_orders',
          viewId: 'view_grid',
        })
      },
    }))
    app.mount(container)
  }

  it('retries transient backend failures within the initial workbench import attempt', async () => {
    mountWorkbench([
      { id: 'fld_name', name: 'Name', type: 'string' },
    ])
    workbenchMock.client.createRecord
      .mockResolvedValueOnce({ record: { id: 'rec_1', version: 1, data: {} } })
      .mockRejectedValueOnce({ message: 'Temporary outage', status: 503 })
      .mockResolvedValueOnce({ record: { id: 'rec_2', version: 1, data: {} } })

    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\nAlpha\nBeta'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 2 record'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1000)
    await flushUi(20)

    expect(workbenchMock.client.createRecord).toHaveBeenCalledTimes(3)
    expect(workbenchMock.client.createRecord).toHaveBeenNthCalledWith(3, {
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      data: { fld_name: 'Beta' },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(gridMock.loadViewData).toHaveBeenCalled()
    expect(showSuccessSpy).toHaveBeenCalledWith('2 record(s) imported')
    expect(document.body.querySelector('.meta-import-modal')).toBeNull()
  })

  it('repairs generic link import ambiguity through the picker and retries with selected ids', async () => {
    mountWorkbench([
      { id: 'fld_vendor', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors', limitSingleRecord: true } },
    ])

    workbenchMock.client.listLinkOptions.mockResolvedValue({
      field: { id: 'fld_vendor', name: 'Vendor', type: 'link' },
      targetSheet: { id: 'sheet_vendors', baseId: 'base_ops', name: 'Vendors' },
      selected: [],
      records: [
        { id: 'rec_vendor_1', display: 'Vendor' },
        { id: 'rec_vendor_2', display: 'Vendor' },
      ],
      page: { offset: 0, limit: 50, total: 2, hasMore: false },
    })
    mockGlobalListLinkOptions.mockResolvedValue({
      field: { id: 'fld_vendor', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors', limitSingleRecord: true } },
      targetSheet: { id: 'sheet_vendors', baseId: 'base_ops', name: 'Vendors' },
      selected: [],
      records: [{ id: 'rec_vendor_1', display: 'Acme Supply' }],
      page: { offset: 0, limit: 50, total: 1, hasMore: false },
    })
    workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_1', version: 1, data: {} } })

    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Vendor\nVendor'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(workbenchMock.client.listLinkOptions).toHaveBeenCalledWith('fld_vendor', {
      search: 'vendor',
      limit: 50,
      offset: 0,
    })
    expect(document.body.textContent).toContain('Choose linked records')

    Array.from(document.body.querySelectorAll('.meta-import__fix-picker-row .meta-import__btn'))
      .find((button) => button.textContent?.includes('Choose linked records'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(mockGlobalListLinkOptions).toHaveBeenCalledWith('fld_vendor', expect.objectContaining({
      search: 'Vendor',
      limit: 50,
      offset: 0,
    }))

    ;(document.body.querySelector('.meta-link-picker__item input[type="checkbox"]') as HTMLInputElement)?.click()
    await flushUi()
    ;(document.body.querySelector('.meta-link-picker__confirm') as HTMLButtonElement)?.click()
    await flushUi()

    expect(document.body.textContent).toContain('Acme Supply')

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Apply fixes and retry'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(workbenchMock.client.createRecord).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      data: { fld_vendor: ['rec_vendor_1'] },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(gridMock.loadViewData).toHaveBeenCalled()
    expect(showSuccessSpy).toHaveBeenCalledWith('1 record(s) imported')
    expect(document.body.querySelector('.meta-import-modal')).toBeNull()
  })

  it('preserves preflight failures across backend retry and manual repair in the workbench flow', async () => {
    mountWorkbench([
      { id: 'fld_vendor', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors', limitSingleRecord: true } },
    ])

    workbenchMock.client.listLinkOptions.mockImplementation(async (_fieldId: string, params: { search?: string }) => {
      const search = params.search?.toLowerCase()
      if (search === 'northwind') {
        return {
          field: { id: 'fld_vendor', name: 'Vendor', type: 'link' },
          targetSheet: { id: 'sheet_vendors', baseId: 'base_ops', name: 'Vendors' },
          selected: [],
          records: [{ id: 'rec_vendor_northwind', display: 'Northwind' }],
          page: { offset: 0, limit: 50, total: 1, hasMore: false },
        }
      }
      if (search === 'tailspin') {
        return {
          field: { id: 'fld_vendor', name: 'Vendor', type: 'link' },
          targetSheet: { id: 'sheet_vendors', baseId: 'base_ops', name: 'Vendors' },
          selected: [],
          records: [{ id: 'rec_vendor_tailspin', display: 'Tailspin' }],
          page: { offset: 0, limit: 50, total: 1, hasMore: false },
        }
      }
      return {
        field: { id: 'fld_vendor', name: 'Vendor', type: 'link' },
        targetSheet: { id: 'sheet_vendors', baseId: 'base_ops', name: 'Vendors' },
        selected: [],
        records: [
          { id: 'rec_vendor_1', display: 'Vendor' },
          { id: 'rec_vendor_2', display: 'Vendor' },
        ],
        page: { offset: 0, limit: 50, total: 2, hasMore: false },
      }
    })
    mockGlobalListLinkOptions.mockResolvedValue({
      field: { id: 'fld_vendor', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors', limitSingleRecord: true } },
      targetSheet: { id: 'sheet_vendors', baseId: 'base_ops', name: 'Vendors' },
      selected: [],
      records: [{ id: 'rec_vendor_fixed', display: 'Vendor Fixed' }],
      page: { offset: 0, limit: 50, total: 1, hasMore: false },
    })
    workbenchMock.client.createRecord
      .mockResolvedValueOnce({ record: { id: 'rec_1', version: 1, data: {} } })
      .mockRejectedValueOnce({ message: 'Temporary outage', status: 503 })
      .mockResolvedValueOnce({ record: { id: 'rec_2', version: 1, data: {} } })
      .mockResolvedValueOnce({ record: { id: 'rec_3', version: 1, data: {} } })

    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Vendor\nNorthwind\nVendor\nTailspin'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 3 record'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1000)
    await flushUi(20)

    expect(workbenchMock.client.createRecord).toHaveBeenCalledTimes(3)
    expect(document.body.textContent).toContain('2 imported, 1 failed')
    expect(document.body.textContent).toContain('Row 3')
    expect(document.body.textContent).not.toContain('Row 4')
    expect(document.body.textContent).not.toContain('Retry failed rows')
    expect(document.body.textContent).toContain('Choose linked records')
    expect(workbenchMock.client.createRecord).toHaveBeenNthCalledWith(3, {
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      data: { fld_vendor: ['rec_vendor_tailspin'] },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))

    Array.from(document.body.querySelectorAll('.meta-import__fix-picker-row .meta-import__btn'))
      .find((button) => button.textContent?.includes('Choose linked records'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-link-picker__item input[type="checkbox"]') as HTMLInputElement)?.click()
    await flushUi()
    ;(document.body.querySelector('.meta-link-picker__confirm') as HTMLButtonElement)?.click()
    await flushUi(12)

    expect(document.body.textContent).toContain('Vendor Fixed')

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Apply fixes and retry'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(20)

    expect(workbenchMock.client.createRecord).toHaveBeenCalledTimes(4)
    expect(workbenchMock.client.createRecord).toHaveBeenLastCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      data: { fld_vendor: ['rec_vendor_fixed'] },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(gridMock.loadViewData).toHaveBeenCalledTimes(2)
    expect(showSuccessSpy).toHaveBeenLastCalledWith('1 record(s) imported')
    expect(document.body.querySelector('.meta-import-modal')).toBeNull()
  })

  it('surfaces a retryable result when the workbench import path throws unexpectedly', async () => {
    mountWorkbench([
      { id: 'fld_name', name: 'Name', type: 'string' },
    ])

    workbenchMock.client.createRecord = undefined

    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\nAlpha'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1000)
    await flushUi(20)

    expect(document.body.querySelector('.meta-import__importing')).toBeNull()
    expect(document.body.textContent).toContain('0 imported, 1 failed')
    expect(document.body.textContent).toContain('Retry failed rows')
    expect(showErrorSpy).toHaveBeenCalled()

    workbenchMock.client.createRecord = vi.fn().mockResolvedValue({
      record: { id: 'rec_retry', version: 1, data: {} },
    })

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Retry failed rows'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(20)

    expect(workbenchMock.client.createRecord).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      data: { fld_name: 'Alpha' },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(showSuccessSpy).toHaveBeenLastCalledWith('1 record(s) imported')
    expect(document.body.querySelector('.meta-import-modal')).toBeNull()
  })

  it('refreshes import mapping labels when sheet metadata changes while the import modal is open', async () => {
    mountWorkbench([
      { id: 'fld_name', name: 'Name', type: 'string' },
    ])

    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\nAlpha'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    const fieldSelect = document.body.querySelector('.meta-import__field-select') as HTMLSelectElement | null
    expect(fieldSelect?.value).toBe('fld_name')
    expect(fieldSelect?.selectedOptions[0]?.textContent).toContain('Name')

    workbenchMock.loadSheetMeta.mockImplementation(async () => {
      workbenchMock.fields.value = [{ id: 'fld_name', name: 'Name Renamed', type: 'string' }] as any
      return true
    })

    await vi.advanceTimersByTimeAsync(1300)
    await flushUi(12)

    const refreshedSelect = document.body.querySelector('.meta-import__field-select') as HTMLSelectElement | null
    expect(refreshedSelect?.value).toBe('fld_name')
    expect(refreshedSelect?.selectedOptions[0]?.textContent).toContain('Name Renamed')
  })

  it('cancels an in-flight import and closes the modal cleanly', async () => {
    mountWorkbench([
      { id: 'fld_name', name: 'Name', type: 'string' },
    ])

    workbenchMock.client.createRecord.mockImplementation((_payload: any, opts?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('Import cancelled'), { name: 'AbortError' }))
      if (opts?.signal?.aborted) {
        abort()
        return
      }
      opts?.signal?.addEventListener('abort', abort, { once: true })
    }))

    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\nAlpha'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(20)

    expect(document.body.textContent).toContain('Cancel import')
    expect(workbenchMock.client.createRecord).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      data: { fld_name: 'Alpha' },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))

    ;(document.body.querySelector('.meta-import__close') as HTMLButtonElement)?.click()
    await flushUi(20)

    expect(gridMock.loadViewData).toHaveBeenCalled()
    expect(showErrorSpy).toHaveBeenCalledWith('Import cancelled')
    expect(document.body.querySelector('.meta-import-modal')).toBeNull()
  })
})
