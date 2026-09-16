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
const { mockGlobalListLinkOptions, capabilityState } = vi.hoisted(() => ({
  mockGlobalListLinkOptions: vi.fn(),
  // #5809: lets a test mount the workbench as an editor who cannot manage sheet access.
  capabilityState: { canManageSheetAccess: true },
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
    canManageSheetAccess: ref(capabilityState.canManageSheetAccess),
    canManageViews: ref(true),
    canComment: ref(true),
    canManageAutomation: ref(false), canExport: ref(true),
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
    reactingKeys: ref<string[]>([]),
    error: ref<string | null>(null),
    loadComments: vi.fn(),
    addComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    resolveComment: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
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

vi.mock('../src/multitable/components/MetaSheetViewRail.vue', () => ({
  default: stubComponent('MetaSheetViewRail'),
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
// W2 S3: MultitableWorkbench.vue now renders MetaRecordInspector.vue directly (MetaRecordDrawer.vue
// is a deprecated thin compat shell no longer mounted by the workbench, OD-W2-7=b).
vi.mock('../src/multitable/components/MetaRecordInspector.vue', () => ({ default: stubComponent('MetaRecordInspector') }))
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
import { DIALOG_META_REFRESH_INTERVAL_MS } from '../src/multitable/utils/dialog-meta-refresh'

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
      // #5809: the import path must never reach this one any more (it is canManageSheetAccess-gated
      // and clamped to 50); every person test asserts it stays uncalled.
      listSheetPermissionCandidates: vi.fn(),
      listPersonFieldDirectory: vi.fn(),
      listCommentMentionSuggestions: vi.fn(),
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
      canManageSheetAccess: capabilityState.canManageSheetAccess,
      canManageViews: true,
      canComment: true,
      canManageAutomation: false, canExport: true,
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
    filterGroups: ref([]),
    canLoadMore: ref(false),
    canUndo: ref(false),
    canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupFieldIds: ref([]),
    groupField: ref(null), groupFields: ref([]),
    hiddenFieldIds: ref<string[]>([]),
    capabilityOrigin: ref('global-rbac'),
    columnWidths: ref<Record<string, number>>({}),
    linkSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    personSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
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
    setGroupField: vi.fn(), setGroupFields: vi.fn(),
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
    capabilityState.canManageSheetAccess = true
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
    expect(showSuccessSpy).toHaveBeenCalledWith('2 records imported', undefined)
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
    expect(showSuccessSpy).toHaveBeenCalledWith('1 record imported', undefined)
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
    expect(showSuccessSpy).toHaveBeenLastCalledWith('1 record imported', undefined)
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
    expect(showSuccessSpy).toHaveBeenLastCalledWith('1 record imported', undefined)
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

    await vi.advanceTimersByTimeAsync(DIALOG_META_REFRESH_INTERVAL_MS + 100) // #5743 keep-alive tick
    await flushUi(12)

    const refreshedSelect = document.body.querySelector('.meta-import__field-select') as HTMLSelectElement | null
    expect(refreshedSelect?.value).toBe('fld_name')
    expect(refreshedSelect?.selectedOptions[0]?.textContent).toContain('Name Renamed')
  })

  it('preserves title when a people repair is reconciled after field drift in the workbench flow', async () => {
    mountWorkbench([
      { id: 'fld_title', name: 'Title', type: 'string' },
      { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } },
    ])

    workbenchMock.client.listFields.mockResolvedValue({
      fields: [
        { id: 'fld_people_name', name: 'Name', type: 'string' },
        { id: 'fld_people_email', name: 'Email', type: 'string' },
      ],
    })
    workbenchMock.client.listRecordSummaries.mockImplementation(async ({ displayFieldId }: { displayFieldId: string }) => {
      if (displayFieldId === 'fld_people_name') {
        return {
          records: [
            { id: 'rec_owner_1', display: 'Owner' },
            { id: 'rec_owner_2', display: 'Owner' },
          ],
          displayMap: {},
          page: { offset: 0, limit: 200, total: 2, hasMore: false },
        }
      }
      return {
        records: [],
        displayMap: {},
        page: { offset: 0, limit: 200, total: 0, hasMore: false },
      }
    })
    mockGlobalListLinkOptions.mockResolvedValue({
      field: { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } },
      targetSheet: { id: 'sheet_people', baseId: 'base_ops', name: 'People' },
      selected: [],
      records: [{ id: 'rec_owner_1', display: 'Owner Person' }],
      page: { offset: 0, limit: 50, total: 1, hasMore: false },
    })
    workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_people_fix', version: 1, data: {} } })

    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Title\tOwner\nAlpha\tOwner'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(12)

    Array.from(document.body.querySelectorAll('.meta-import__fix-picker-row .meta-import__btn'))
      .find((button) => button.textContent?.includes('Choose person') || button.textContent?.includes('Choose people') || button.textContent?.includes('Select person'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-link-picker__item input[type="checkbox"]') as HTMLInputElement)?.click()
    await flushUi()
    ;(document.body.querySelector('.meta-link-picker__confirm') as HTMLButtonElement)?.click()
    await flushUi(12)

    workbenchMock.loadSheetMeta.mockImplementation(async () => {
      workbenchMock.fields.value = [
        { id: 'fld_title', name: 'Title', type: 'string' },
        { id: 'fld_owner', name: 'Owner Repair', type: 'string', property: {} },
      ] as any
      return true
    })

    await vi.advanceTimersByTimeAsync(DIALOG_META_REFRESH_INTERVAL_MS + 100) // #5743 keep-alive tick
    await flushUi(16)

    expect(document.body.textContent).toContain('A selected linked-record repair for Owner Repair is no longer valid because the field changed type.')

    Array.from(document.body.querySelectorAll('.meta-import__warning .meta-import__btn-inline'))
      .find((button) => button.textContent?.includes('Reconcile draft'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(12)

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Apply fixes and retry'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(20)

    expect(workbenchMock.client.createRecord).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.createRecord).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      data: { fld_title: 'Alpha', fld_owner: 'Owner Person' },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(gridMock.loadViewData).toHaveBeenCalled()
    expect(showSuccessSpy).toHaveBeenLastCalledWith('1 record imported', undefined)
    expect(document.body.querySelector('.meta-import-modal')).toBeNull()
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
  it('creates the unmatched column as a text field and imports the row under the new field id', async () => {
    // End-to-end through the REAL import modal: an unmatched header defaults to "create new field"
    // (the workbench reports manage-fields = true), the field is created BEFORE any record write, and
    // the placeholder key the modal used is rewritten to the created field id.
    mountWorkbench([
      { id: 'fld_name', name: 'Name', type: 'string' },
    ])
    workbenchMock.client.createField.mockResolvedValue({ field: { id: 'fld_warehouse', name: 'Warehouse', type: 'string' } })
    workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_1', version: 1, data: {} } })

    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\tWarehouse\nAlpha\tA1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    const selects = Array.from(document.body.querySelectorAll('.meta-import__field-select')) as HTMLSelectElement[]
    expect(selects.map((select) => select.value)).toEqual(['fld_name', '__create__'])
    expect(document.body.textContent).toContain('1 column(s) will be created as new text fields.')

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(20)

    expect(workbenchMock.client.createField).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.createField).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      name: 'Warehouse',
      type: 'string',
    })
    expect(workbenchMock.client.createRecord).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      data: { fld_name: 'Alpha', fld_warehouse: 'A1' },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(showSuccessSpy).toHaveBeenCalledWith('1 record imported', undefined)
    expect(document.body.querySelector('.meta-import-modal')).toBeNull()
  })

  /**
   * Pins the `:existing-field-names="importExistingFieldNames"` binding on the MetaImportModal tag
   * (MultitableWorkbench.vue) end-to-end through the REAL modal. Drop that one template line and the
   * modal falls back to `props.fields` — i.e. `importSurfaceFields`, which has ALREADY stripped these
   * two columns — so both headers look "missing from the sheet", both default to the create sentinel
   * and the import silently grows shadow `Score (2)` / `Secret (2)` text columns next to the real
   * ones (export → re-import round trip).
   *
   * The two fields are chosen because they are the only shapes that can tell the two lists apart:
   *  - fld_score: importSurfaceFields drops it via effectiveFieldPermissions[...].readOnly
   *  - fld_secret: propertyVisibleWorkbenchFields drops it via property.hidden (filterPropertyVisibleFields)
   * A `type: 'formula'` field would NOT work as a probe here: importSurfaceFields keeps it (it is
   * property-visible and carries no readOnly permission), so it reaches the modal inside `props.fields`
   * and the fallback would see its name anyway — the mutation would stay green.
   */
  it('will not offer to create a column that already exists as a read-only / hidden field on the sheet', async () => {
    mountWorkbench([
      { id: 'fld_name', name: 'Name', type: 'string' },
      { id: 'fld_score', name: 'Score', type: 'number' },
      { id: 'fld_secret', name: 'Secret', type: 'string', property: { hidden: true } },
    ])
    // Field-level permission read-only: the workbench strips fld_score out of importSurfaceFields,
    // so the modal never receives it in `fields` — only `existingFieldNames` still carries the name.
    gridMock.fieldPermissions.value = { fld_score: { visible: true, readOnly: true } }
    workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_1', version: 1, data: {} } })

    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\tScore\tSecret\nAlpha\t9\tclassified'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    const selects = Array.from(document.body.querySelectorAll('.meta-import__field-select')) as HTMLSelectElement[]
    expect(selects.map((select) => select.value)).toEqual(['fld_name', '', ''])
    // "Create" stays OFFERED (an explicit manual choice is allowed), but the option label must promise
    // the name that would actually be created — the planner suffixes it because the sheet already owns
    // "Score"/"Secret". Without the binding the modal thinks the names are free and promises 「Score」.
    const createOptionLabels = selects.map((select) =>
      Array.from(select.options).find((option) => option.value === '__create__')?.textContent ?? null,
    )
    expect(createOptionLabels).toEqual([
      'Create field "Name (2)" (text)',
      'Create field "Score (2)" (text)',
      'Create field "Secret (2)" (text)',
    ])
    expect(document.body.textContent).toContain(
      '2 column(s) match an existing field that cannot be imported into (read-only, formula, or not permitted) and were skipped.',
    )
    expect(document.body.textContent).not.toContain('will be created as new text fields')

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(20)

    expect(workbenchMock.client.createField).not.toHaveBeenCalled()
    expect(workbenchMock.client.createRecord).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.createRecord).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      data: { fld_name: 'Alpha' },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(showSuccessSpy).toHaveBeenCalledWith('1 record imported', undefined)
  })

  /**
   * #5809 — person import resolves each UNIQUE token through a bounded lookup instead of one roster pull.
   *
   * Native person fields ask the field's own directory (canEditRecord gate, write-validator set, ≤ 50
   * rows, `match: 'exact'`); legacy link-backed person fields fall back to the comment @-mention
   * directory for an email-shaped token their People sheet cannot match (the People sheet no longer
   * stores emails, #5807). All people below are obviously fake (example.invalid).
   */
  describe('#5809 bounded person import lookups', () => {
    const TAB = String.fromCharCode(9)
    const NL = String.fromCharCode(10)
    const table = (...rows: string[][]) => rows.map((cells) => cells.join(TAB)).join(NL)

    type FakePerson = { userId: string; name: string | null; email: string | null }
    const FAKE_ROSTER: FakePerson[] = Array.from({ length: 60 }, (_, index) => {
      const n = String(index + 1).padStart(2, '0')
      return { userId: `usr_fake_${n}`, name: `Fake Person ${n}`, email: `fake.person${n}@example.invalid` }
    })

    const NATIVE_FIELDS = [
      { id: 'fld_title', name: 'Title', type: 'string' },
      { id: 'fld_assignee', name: 'Assignee', type: 'person', property: {} },
    ]

    /**
     * A stand-in for GET .../person-fields/:fieldId/directory. `honourExact: false` models a server that
     * predates `match=exact` (substring on name/email only), which is what the client-side exact filter
     * and the `hasMore` handling have to cope with.
     */
    function fakeDirectory(roster: FakePerson[], opts: { honourExact?: boolean } = {}) {
      return vi.fn(async (_sheetId: string, _fieldId: string, params?: { q?: string; match?: string }) => {
        const q = (params?.q ?? '').trim().toLowerCase()
        const exact = params?.match === 'exact' && opts.honourExact !== false
        const hits = roster.filter((person) => (exact
          ? [person.userId, person.name ?? '', person.email ?? ''].some((value) => value.trim().toLowerCase() === q)
          : [person.name ?? '', person.email ?? ''].some((value) => value.toLowerCase().includes(q))))
        const items = hits.slice(0, 50)
        return { items, total: items.length, query: q, hasMore: hits.length > 50, requiresQuery: false, minQueryLength: 1 }
      })
    }

    /** What the pre-#5809 resolver got from /permission-candidates: the server's first 50 rows only. */
    function clampedPermissionCandidates() {
      const items = FAKE_ROSTER.slice(0, 50).map((person) => ({
        subjectType: 'user',
        subjectId: person.userId,
        label: person.name,
        subtitle: person.email,
        isActive: true,
      }))
      return { items, total: items.length, limit: 50, query: '' }
    }

    async function runImport(text: string, recordCount: number) {
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
      await flushUi()
      const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
      textarea.value = text
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await flushUi()
      ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
      await flushUi()
      const importButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
        .find((button) => button.textContent?.includes(`Import ${recordCount} record`))
      expect(importButton).toBeTruthy()
      importButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(1000)
      await flushUi(30)
    }

    function expectCreated(data: Record<string, unknown>) {
      expect(workbenchMock.client.createRecord).toHaveBeenCalledWith({
        sheetId: 'sheet_orders',
        viewId: 'view_grid',
        data,
      }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    }

    describe('native person fields', () => {
      function mountNative(fields: Array<Record<string, unknown>> = NATIVE_FIELDS) {
        mountWorkbench(fields)
        workbenchMock.client.listPersonFieldDirectory = fakeDirectory(FAKE_ROSTER)
        workbenchMock.client.listSheetPermissionCandidates.mockResolvedValue(clampedPermissionCandidates())
        workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_new', version: 1, data: {} } })
      }

      it('resolves a person who sits past the first 50 candidates, with one exact directory lookup', async () => {
        mountNative()

        await runImport(table(['Title', 'Assignee'], ['Alpha', 'Fake Person 57']), 1)

        expectCreated({ fld_title: 'Alpha', fld_assignee: ['usr_fake_57'] })
        expect(workbenchMock.client.listPersonFieldDirectory).toHaveBeenCalledTimes(1)
        // extractImportTokens hands tokens over case-folded; the exact mode compares case-insensitively.
        expect(workbenchMock.client.listPersonFieldDirectory).toHaveBeenCalledWith(
          'sheet_orders',
          'fld_assignee',
          { q: 'fake person 57', match: 'exact' },
        )
        expect(workbenchMock.client.listSheetPermissionCandidates).not.toHaveBeenCalled()
        expect(showSuccessSpy).toHaveBeenCalledWith('1 record imported', undefined)
      })

      it('lets an editor who cannot manage sheet access import (directory 200, permission-candidates would 403)', async () => {
        capabilityState.canManageSheetAccess = false
        mountNative()
        workbenchMock.client.listSheetPermissionCandidates.mockRejectedValue(
          Object.assign(new Error('Sheet access management required'), { status: 403, code: 'FORBIDDEN' }),
        )

        await runImport(table(['Title', 'Assignee'], ['Alpha', 'fake.person03@example.invalid']), 1)

        expect(workbenchMock.capabilities.value.canManageSheetAccess).toBe(false)
        expectCreated({ fld_title: 'Alpha', fld_assignee: ['usr_fake_03'] })
        expect(workbenchMock.client.listSheetPermissionCandidates).not.toHaveBeenCalled()
        expect(document.body.textContent).not.toContain('Sheet access management required')
      })

      it('matches a user id token (the export round trip writes user ids)', async () => {
        mountNative()

        await runImport(table(['Title', 'Assignee'], ['Alpha', 'usr_fake_44']), 1)

        expectCreated({ fld_title: 'Alpha', fld_assignee: ['usr_fake_44'] })
      })

      it('asks once per unique token across the whole import (case / whitespace folded)', async () => {
        mountNative()

        await runImport(table(
          ['Title', 'Assignee'],
          ['Alpha', 'Fake Person 07'],
          ['Beta', 'fake person 07'],
          ['Gamma', ' FAKE PERSON 07 '],
        ), 3)

        expect(workbenchMock.client.listPersonFieldDirectory).toHaveBeenCalledTimes(1)
        expect(workbenchMock.client.createRecord).toHaveBeenCalledTimes(3)
        expectCreated({ fld_title: 'Gamma', fld_assignee: ['usr_fake_07'] })
      })

      it('never resolves a partial match, even when the server returns it first', async () => {
        mountNative()
        workbenchMock.client.listPersonFieldDirectory = fakeDirectory(FAKE_ROSTER, { honourExact: false })

        await runImport(table(['Title', 'Assignee'], ['Alpha', 'Person 12']), 1)

        expect(workbenchMock.client.createRecord).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('Unable to resolve people value for Assignee: Person 12')
      })

      it('reports several exact matches as ambiguous instead of picking one', async () => {
        mountNative()
        workbenchMock.client.listPersonFieldDirectory = fakeDirectory([
          { userId: 'usr_twin_a', name: 'Fake Twin', email: 'fake.twin.a@example.invalid' },
          { userId: 'usr_twin_b', name: 'Fake Twin', email: 'fake.twin.b@example.invalid' },
        ])

        await runImport(table(['Title', 'Assignee'], ['Alpha', 'Fake Twin']), 1)

        expect(workbenchMock.client.createRecord).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('Multiple people match "fake twin"')
      })

      it('says the token is too broad when a clamped answer has no exact match (not "unknown person")', async () => {
        mountNative()
        workbenchMock.client.listPersonFieldDirectory = fakeDirectory(FAKE_ROSTER, { honourExact: false })

        await runImport(table(['Title', 'Assignee'], ['Alpha', 'Fake Person']), 1)

        expect(workbenchMock.client.createRecord).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('People value for Assignee is too broad')
        expect(document.body.textContent).not.toContain('Unable to resolve people value')
      })

      it('does not trust a single NAME match from a clamped answer, but does trust a user-id match', async () => {
        mountNative()
        const roster: FakePerson[] = [{ userId: 'usr_fake_plain', name: 'Fake', email: 'plain@example.invalid' }, ...FAKE_ROSTER]
        const substring = fakeDirectory(roster, { honourExact: false })
        workbenchMock.client.listPersonFieldDirectory = vi.fn(async (sheetId: string, fieldId: string, params?: { q?: string; match?: string }) => {
          if (params?.q === 'usr_fake_60') {
            // An old server whose answer is clamped but happens to carry the id owner.
            return { items: FAKE_ROSTER.slice(10, 60), total: 50, query: 'usr_fake_60', hasMore: true, requiresQuery: false, minQueryLength: 1 }
          }
          return substring(sheetId, fieldId, params)
        })
        workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_new', version: 1, data: {} } })

        await runImport(table(['Title', 'Assignee'], ['Alpha', 'Fake'], ['Beta', 'usr_fake_60']), 2)

        expect(document.body.textContent).toContain('People value for Assignee is too broad')
        expect(workbenchMock.client.createRecord).toHaveBeenCalledTimes(1)
        expectCreated({ fld_title: 'Beta', fld_assignee: ['usr_fake_60'] })
      })

      it('surfaces a directory 403 as the permission failure, not as an unknown person', async () => {
        mountNative()
        workbenchMock.client.listPersonFieldDirectory = vi.fn().mockRejectedValue(
          Object.assign(new Error('Fake forbidden: record editing is not permitted'), { status: 403, code: 'FORBIDDEN' }),
        )

        await runImport(table(['Title', 'Assignee'], ['Alpha', 'Fake Person 01']), 1)

        expect(workbenchMock.client.createRecord).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('Fake forbidden: record editing is not permitted')
        expect(document.body.textContent).not.toContain('Unable to resolve people value')
        expect(workbenchMock.client.listSheetPermissionCandidates).not.toHaveBeenCalled()
      })

      it('keeps at most four lookups in flight', async () => {
        // limitSingleRecord: false so one cell may carry six people.
        mountNative(NATIVE_FIELDS.map((field) => (field.id === 'fld_assignee' ? { ...field, property: { limitSingleRecord: false } } : field)))
        let inFlight = 0
        let peak = 0
        const directory = fakeDirectory(FAKE_ROSTER)
        workbenchMock.client.listPersonFieldDirectory = vi.fn(async (sheetId: string, fieldId: string, params?: { q?: string; match?: string }) => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 50))
          inFlight -= 1
          return directory(sheetId, fieldId, params)
        })

        const six = ['Fake Person 01', 'Fake Person 02', 'Fake Person 03', 'Fake Person 04', 'Fake Person 05', 'Fake Person 06']
        await runImport(table(['Title', 'Assignee'], ['Alpha', six.join(', ')]), 1)

        // Six names plus the whole cell (extractImportTokens always offers the full value as a token too).
        expect(workbenchMock.client.listPersonFieldDirectory).toHaveBeenCalledTimes(7)
        expect(peak).toBe(4)
        expectCreated({
          fld_title: 'Alpha',
          fld_assignee: ['usr_fake_01', 'usr_fake_02', 'usr_fake_03', 'usr_fake_04', 'usr_fake_05', 'usr_fake_06'],
        })
      })
    })

    describe('legacy (People-sheet) person fields — email fallback', () => {
      const LEGACY_FIELDS = [
        { id: 'fld_title', name: 'Title', type: 'string' },
        { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } },
      ]
      // The preset People sheet after #5807: User ID first, Name falls back to the id, Email is empty.
      const PEOPLE_FIELDS = [
        { id: 'fld_people_uid', name: 'User ID', type: 'string' },
        { id: 'fld_people_name', name: 'Name', type: 'string' },
        { id: 'fld_people_email', name: 'Email', type: 'string' },
        { id: 'fld_people_avatar', name: 'Avatar URL', type: 'string' },
      ]
      const PEOPLE_ROWS: Record<string, Array<{ id: string; display: string }>> = {
        fld_people_uid: [
          { id: 'rec_people_1', display: 'usr_fake_01' },
          { id: 'rec_people_2', display: 'usr_fake_02' },
        ],
        fld_people_name: [
          { id: 'rec_people_1', display: 'usr_fake_01' },
          { id: 'rec_people_2', display: 'usr_fake_02' },
        ],
      }

      function mountLegacy(peopleFields = PEOPLE_FIELDS) {
        mountWorkbench(LEGACY_FIELDS)
        workbenchMock.client.listFields.mockResolvedValue({ fields: peopleFields })
        workbenchMock.client.listRecordSummaries.mockImplementation(async ({ displayFieldId }: { displayFieldId: string }) => {
          const records = PEOPLE_ROWS[displayFieldId] ?? []
          return { records, displayMap: {}, page: { offset: 0, limit: 200, total: records.length, hasMore: false } }
        })
        workbenchMock.client.listCommentMentionSuggestions.mockImplementation(async ({ q }: { q?: string }) => {
          const term = (q ?? '').trim().toLowerCase()
          const items = [
            { id: 'usr_fake_02', label: 'Fake Person 02', subtitle: 'fake.person02@example.invalid' },
            { id: 'usr_fake_09', label: 'Fake Person 09', subtitle: 'xfake.person02@example.invalid' },
          ].filter((item) => item.subtitle.toLowerCase().includes(term) || item.label.toLowerCase().includes(term))
          return { items, total: items.length, limit: 50, query: term, hasMore: false, requiresQuery: false, minQueryLength: 1 }
        })
        workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_new', version: 1, data: {} } })
      }

      it('resolves an email the People sheet no longer stores through the mention directory', async () => {
        mountLegacy()

        await runImport(table(['Title', 'Owner'], ['Alpha', 'fake.person02@example.invalid']), 1)

        expect(workbenchMock.client.listCommentMentionSuggestions).toHaveBeenCalledTimes(1)
        expect(workbenchMock.client.listCommentMentionSuggestions).toHaveBeenCalledWith({
          spreadsheetId: 'sheet_orders',
          q: 'fake.person02@example.invalid',
        })
        expectCreated({ fld_title: 'Alpha', fld_owner: ['rec_people_2'] })
        expect(workbenchMock.client.listSheetPermissionCandidates).not.toHaveBeenCalled()
      })

      it('asks once per email, and never for tokens the sheet already matches or that are not emails', async () => {
        mountLegacy()

        await runImport(table(
          ['Title', 'Owner'],
          ['Alpha', 'fake.person02@example.invalid'],
          ['Beta', 'FAKE.PERSON02@example.invalid'],
          ['Gamma', 'usr_fake_01'],
          ['Delta', 'fake.nobody@example.invalid'],
          ['Epsilon', 'Fake.Nobody@example.invalid'],
        ), 5)

        // One request per distinct email — a miss is remembered too, not re-asked on the next row.
        expect(workbenchMock.client.listCommentMentionSuggestions).toHaveBeenCalledTimes(2)
        expect(workbenchMock.client.createRecord).toHaveBeenCalledTimes(3)
        expectCreated({ fld_title: 'Beta', fld_owner: ['rec_people_2'] })
        expectCreated({ fld_title: 'Gamma', fld_owner: ['rec_people_1'] })
        expect(document.body.textContent).toContain('Unable to resolve people value for Owner: Fake.Nobody@example.invalid')
      })

      it('treats a mention-directory 403 as "not matched", not as a load failure', async () => {
        mountLegacy()
        workbenchMock.client.listCommentMentionSuggestions.mockRejectedValue(
          Object.assign(new Error('Fake forbidden: comments are not readable'), { status: 403, code: 'FORBIDDEN' }),
        )

        await runImport(table(['Title', 'Owner'], ['Alpha', 'fake.person02@example.invalid'], ['Beta', 'usr_fake_01']), 2)

        expect(document.body.textContent).toContain('Unable to resolve people value for Owner: fake.person02@example.invalid')
        expect(document.body.textContent).not.toContain('Fake forbidden')
        expect(workbenchMock.client.createRecord).toHaveBeenCalledTimes(1)
        expectCreated({ fld_title: 'Beta', fld_owner: ['rec_people_1'] })
      })

      it('only accepts an exact email, and only for someone already on the People sheet', async () => {
        mountLegacy()
        workbenchMock.client.listCommentMentionSuggestions.mockResolvedValue({
          items: [
            { id: 'usr_fake_02', label: 'Fake Person 02', subtitle: 'fake.person02@example.invalid.other' },
            { id: 'usr_not_on_sheet', label: 'Fake Stranger', subtitle: 'fake.stranger@example.invalid' },
          ],
          total: 2,
          limit: 50,
          query: '',
          hasMore: false,
          requiresQuery: false,
          minQueryLength: 1,
        })

        await runImport(table(
          ['Title', 'Owner'],
          ['Alpha', 'fake.person02@example.invalid'],
          ['Beta', 'fake.stranger@example.invalid'],
        ), 2)

        expect(workbenchMock.client.createRecord).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('Unable to resolve people value for Owner: fake.person02@example.invalid')
        expect(document.body.textContent).toContain('Unable to resolve people value for Owner: fake.stranger@example.invalid')
      })

      it('reports two exact email owners as ambiguous and a clamped answer without one as too broad', async () => {
        mountLegacy()
        workbenchMock.client.listCommentMentionSuggestions.mockImplementation(async ({ q }: { q?: string }) => {
          if (q === 'fake.person01@example.invalid') {
            return {
              items: [
                { id: 'usr_fake_01', label: 'Fake Person 01', subtitle: 'fake.person01@example.invalid' },
                { id: 'usr_fake_02', label: 'FAKE.PERSON01@example.invalid' },
              ],
              total: 2, limit: 50, query: q, hasMore: false, requiresQuery: false, minQueryLength: 1,
            }
          }
          return {
            items: [{ id: 'usr_fake_09', label: 'Fake Person 09', subtitle: 'other.fake.person02@example.invalid' }],
            total: 1, limit: 50, query: q ?? '', hasMore: true, requiresQuery: false, minQueryLength: 1,
          }
        })

        await runImport(table(
          ['Title', 'Owner'],
          ['Alpha', 'fake.person01@example.invalid'],
          ['Beta', 'fake.person02@example.invalid'],
        ), 2)

        expect(workbenchMock.client.createRecord).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('Multiple people match "fake.person01@example.invalid". Please verify the email value.')
        expect(document.body.textContent).toContain('People value for Owner is too broad')
      })

      it('adds no People-sheet read of its own: without a hydrated User ID column there is no fallback request', async () => {
        // An alias column sorts first, so the fallback alias is that column and User ID is never read.
        mountLegacy([
          { id: 'fld_people_nick', name: 'Nickname', type: 'string' },
          ...PEOPLE_FIELDS,
        ])

        await runImport(table(['Title', 'Owner'], ['Alpha', 'fake.person02@example.invalid']), 1)

        expect(workbenchMock.client.listCommentMentionSuggestions).not.toHaveBeenCalled()
        const readColumns = workbenchMock.client.listRecordSummaries.mock.calls.map(([args]: [{ displayFieldId: string }]) => args.displayFieldId)
        expect(readColumns).not.toContain('fld_people_uid')
        expect(document.body.textContent).toContain('Unable to resolve people value for Owner: fake.person02@example.invalid')
      })
    })
  })
})
