// Workbench side of "import creates the missing columns as new text fields".
//
// The real modal is stubbed here on purpose: this file pins the WRITE-side handler
// (`applyImportCreateFields` inside MultitableWorkbench.vue) against payloads it must be able to
// refuse — including a payload that asks for field creation while the caller has no manage-fields
// capability, which the real modal would never produce. The happy path through the real modal lives
// in multitable-workbench-import-flow.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined) }),
  }
})

function stubComponent(name: string) {
  return defineComponent({
    name,
    render() {
      return h('div', { [`data-stub-${name}`]: 'true' })
    },
  })
}

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: { listLinkOptions: vi.fn() },
}))

let workbenchMock: any
let gridMock: any
let canManageFields = ref(true)
let emitImportPayload: ((payload: unknown) => void) | null = null
let importModalProps: Record<string, unknown> = {}

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
    canManageFields,
    canManageSheetAccess: ref(true),
    canManageViews: ref(true),
    canComment: ref(true),
    canManageAutomation: ref(false),
    canExport: ref(true),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableComments', () => ({
  useMultitableComments: () => ({
    comments: ref([]), loading: ref(false), submitting: ref(false),
    resolvingIds: ref<string[]>([]), updatingIds: ref<string[]>([]), deletingIds: ref<string[]>([]),
    reactingKeys: ref<string[]>([]), error: ref<string | null>(null),
    loadComments: vi.fn(), addComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn(),
    resolveComment: vi.fn(), addReaction: vi.fn(), removeReaction: vi.fn(),
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

vi.mock('../src/multitable/components/MetaSheetViewRail.vue', () => ({ default: stubComponent('MetaSheetViewRail') }))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({
  default: defineComponent({
    name: 'MetaToolbar',
    emits: ['import'],
    render() {
      return h('button', { 'data-open-import': 'true', onClick: () => this.$emit('import') }, 'open-import')
    },
  }),
}))

// Import-modal stub: records the props the workbench binds and hands the test a direct emitter.
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({
  default: defineComponent({
    name: 'MetaImportModal',
    props: {
      visible: { type: Boolean, default: false },
      sheetId: { type: String, default: null },
      fields: { type: Array, default: () => [] },
      fieldResolvers: { type: Object, default: () => ({}) },
      importing: { type: Boolean, default: false },
      result: { type: Object, default: null },
      canCreateFields: { type: Boolean, default: false },
      createFieldsError: { type: String, default: null },
      createdFieldColumns: { type: Object, default: null },
    },
    emits: ['close', 'cancel-import', 'import', 'update:dirty'],
    setup(props, { emit }) {
      emitImportPayload = (payload: unknown) => emit('import', payload as never)
      return () => {
        importModalProps = {
          visible: props.visible,
          canCreateFields: props.canCreateFields,
          createFieldsError: props.createFieldsError,
          createdFieldColumns: props.createdFieldColumns,
        }
        return h('div', { 'data-stub-import-modal': String(props.visible) })
      }
    },
  }),
}))

vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({ default: stubComponent('MetaGridTable') }))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
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
      expose({ showError: showErrorSpy, showSuccess: showSuccessSpy })
      return () => h('div', { 'data-toast': 'true' })
    },
  }),
}))

import MultitableWorkbench from '../src/multitable/views/MultitableWorkbench.vue'
import { MAX_SHEET_FIELDS, createFieldPlaceholderId } from '../src/multitable/import/create-fields'

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function createWorkbenchMock(fields: Array<Record<string, unknown>>) {
  const activeBaseId = ref('base_ops')
  const activeSheetId = ref('sheet_orders')
  const activeViewId = ref('view_grid')
  const views = ref([{ id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' }])
  const fieldsRef = ref(fields as any)
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_ops', name: 'Ops Base' }] }),
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
    fields: fieldsRef,
    views,
    activeBaseId,
    activeSheetId,
    activeViewId,
    capabilities: ref({
      canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true,
      canManageFields: true, canManageSheetAccess: true, canManageViews: true, canComment: true,
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
    fields: ref(fields as any), rows: ref([]), loading: ref(false), currentPage: ref(1), totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }), visibleFields: ref(fields as any),
    sortRules: ref([]), filterRules: ref([]), filterConjunction: ref('and'), filterGroups: ref([]),
    canLoadMore: ref(false), canUndo: ref(false), canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupFieldIds: ref([]), groupField: ref(null), groupFields: ref([]),
    hiddenFieldIds: ref<string[]>([]), capabilityOrigin: ref('global-rbac'),
    columnWidths: ref<Record<string, number>>({}),
    linkSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    personSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    attachmentSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    fieldPermissions: ref({}), viewPermission: ref(null), rowActions: ref(null),
    rowActionOverrides: ref<Record<string, { canEdit: boolean; canDelete: boolean; canComment: boolean }>>({}),
    conflict: ref(null), error: ref<string | null>(null), sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(), addSortRule: vi.fn(), removeSortRule: vi.fn(), addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(), removeFilterRule: vi.fn(), clearFilters: vi.fn(), applySortFilter: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), setGroupField: vi.fn(), setGroupFields: vi.fn(), goToPage: vi.fn(),
    patchCell: vi.fn(), createRecord: vi.fn(), deleteRecord: vi.fn(), resolveRowActions: vi.fn(() => null),
    loadViewData: vi.fn(), reloadCurrentPage: vi.fn(), dismissConflict: vi.fn(), retryConflict: vi.fn(),
    setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
  }
}

describe('MultitableWorkbench import → create missing fields', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    canManageFields = ref(true)
    emitImportPayload = null
    importModalProps = {}
    window.localStorage.clear()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
    showErrorSpy.mockReset()
    showSuccessSpy.mockReset()
    window.localStorage.clear()
  })

  function mountWorkbench(fields: Array<Record<string, unknown>>) {
    workbenchMock = createWorkbenchMock(fields)
    gridMock = createGridMock(fields)
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(defineComponent({
      render() {
        return h(MultitableWorkbench as Component, { baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
      },
    }))
    app.mount(container)
  }

  async function openImportModal() {
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()
  }

  it('creates each requested field, reloads meta, and imports rows under the new field ids', async () => {
    mountWorkbench([{ id: 'fld_name', name: 'Name', type: 'string' }])
    workbenchMock.client.createField
      .mockResolvedValueOnce({ field: { id: 'fld_warehouse', name: 'Warehouse', type: 'string' } })
      .mockResolvedValueOnce({ field: { id: 'fld_batch', name: 'Batch', type: 'string' } })
    workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_1', version: 1, data: {} } })

    await openImportModal()
    expect(importModalProps.canCreateFields).toBe(true)
    // Mount already calls loadSheetMeta once; clear it so the assertion below can only be satisfied
    // by the reload that happens AFTER the fields were created.
    workbenchMock.loadSheetMeta.mockClear()

    emitImportPayload!({
      records: [{ fld_name: 'Alpha', [createFieldPlaceholderId(1)]: 'A1', [createFieldPlaceholderId(2)]: 'B1' }],
      rowIndexes: [0],
      failures: [],
      createFields: [
        { header: 'Warehouse', columnIndex: 1 },
        { header: 'Batch', columnIndex: 2 },
      ],
    })
    await flushUi(20)

    expect(workbenchMock.client.createField).toHaveBeenCalledTimes(2)
    expect(workbenchMock.client.createField).toHaveBeenNthCalledWith(1, { sheetId: 'sheet_orders', name: 'Warehouse', type: 'string' })
    expect(workbenchMock.client.createField).toHaveBeenNthCalledWith(2, { sheetId: 'sheet_orders', name: 'Batch', type: 'string' })
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledWith('sheet_orders')
    // ...and it must land BETWEEN the last create and the first record write, otherwise the grid
    // renders rows whose field ids it does not know yet.
    expect(workbenchMock.loadSheetMeta.mock.invocationCallOrder[0])
      .toBeGreaterThan(workbenchMock.client.createField.mock.invocationCallOrder[1])
    expect(workbenchMock.loadSheetMeta.mock.invocationCallOrder[0])
      .toBeLessThan(workbenchMock.client.createRecord.mock.invocationCallOrder[0])
    expect(workbenchMock.client.createRecord).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.createRecord).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      data: { fld_name: 'Alpha', fld_warehouse: 'A1', fld_batch: 'B1' },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(showSuccessSpy).toHaveBeenCalledWith('1 record imported', undefined)
  })

  it('suffixes a name that collides with an existing field (case-insensitive)', async () => {
    // "Score" exists as a formula field: it is not importable, so the header stays unmapped and the
    // create path must not try to reuse the name.
    mountWorkbench([
      { id: 'fld_name', name: 'Name', type: 'string' },
      { id: 'fld_score', name: 'Score', type: 'formula' },
    ])
    workbenchMock.client.createField.mockResolvedValue({ field: { id: 'fld_score_2', name: 'Score (2)', type: 'string' } })
    workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_1', version: 1, data: {} } })

    await openImportModal()
    emitImportPayload!({
      records: [{ [createFieldPlaceholderId(0)]: '42' }],
      rowIndexes: [0],
      failures: [],
      createFields: [{ header: 'score', columnIndex: 0 }],
    })
    await flushUi(20)

    expect(workbenchMock.client.createField).toHaveBeenCalledWith({ sheetId: 'sheet_orders', name: 'score (2)', type: 'string' })
    expect(workbenchMock.client.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({ data: { fld_score_2: '42' } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('writes no records when a later field creation fails', async () => {
    mountWorkbench([{ id: 'fld_name', name: 'Name', type: 'string' }])
    workbenchMock.client.createField
      .mockResolvedValueOnce({ field: { id: 'fld_warehouse', name: 'Warehouse', type: 'string' } })
      .mockRejectedValueOnce(new Error('Field limit reached'))
    workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_1', version: 1, data: {} } })

    await openImportModal()
    emitImportPayload!({
      records: [{ fld_name: 'Alpha', [createFieldPlaceholderId(1)]: 'A1', [createFieldPlaceholderId(2)]: 'B1' }],
      rowIndexes: [0],
      failures: [],
      createFields: [
        { header: 'Warehouse', columnIndex: 1 },
        { header: 'Batch', columnIndex: 2 },
      ],
    })
    await flushUi(20)

    expect(workbenchMock.client.createField).toHaveBeenCalledTimes(2)
    expect(workbenchMock.client.createRecord).not.toHaveBeenCalled()
    expect(showErrorSpy).toHaveBeenCalledWith(
      'Failed to create field "Batch": Field limit reached No records were imported.',
    )
    expect(showSuccessSpy).not.toHaveBeenCalled()
    // The modal is told to go back to mapping; it is NOT left on the importing spinner.
    expect(importModalProps.createFieldsError).toContain('Failed to create field "Batch"')
    expect(importModalProps.visible).toBe(true)
  })

  it('refuses to create fields (and to import) when the caller has no manage-fields capability', async () => {
    canManageFields = ref(false)
    mountWorkbench([{ id: 'fld_name', name: 'Name', type: 'string' }])
    workbenchMock.client.createField.mockResolvedValue({ field: { id: 'fld_warehouse', name: 'Warehouse', type: 'string' } })
    workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_1', version: 1, data: {} } })

    await openImportModal()
    expect(importModalProps.canCreateFields).toBe(false)

    // Hostile/stale payload: the modal would not emit this without the capability, the handler must
    // still refuse it.
    emitImportPayload!({
      records: [{ fld_name: 'Alpha', [createFieldPlaceholderId(1)]: 'A1' }],
      rowIndexes: [0],
      failures: [],
      createFields: [{ header: 'Warehouse', columnIndex: 1 }],
    })
    await flushUi(20)

    expect(workbenchMock.client.createField).not.toHaveBeenCalled()
    expect(workbenchMock.client.createRecord).not.toHaveBeenCalled()
    expect(showErrorSpy).toHaveBeenCalledWith(
      'Creating fields is not allowed on this sheet, so no records were imported.',
    )
  })

  it('imports unchanged when the payload carries no create requests', async () => {
    mountWorkbench([{ id: 'fld_name', name: 'Name', type: 'string' }])
    workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_1', version: 1, data: {} } })

    await openImportModal()
    emitImportPayload!({ records: [{ fld_name: 'Alpha' }], rowIndexes: [0], failures: [] })
    await flushUi(20)

    expect(workbenchMock.client.createField).not.toHaveBeenCalled()
    expect(workbenchMock.client.createRecord).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      data: { fld_name: 'Alpha' },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('refuses the whole import when the requested fields would blow the readable field limit', async () => {
    // MAX_SHEET_FIELDS mirrors the backend's `LIMIT 500` on GET /api/multitable/fields
    // (univer-meta.ts list fields): past that line the created field exists but no client can read
    // it back. The refusal must abort BEFORE the first createField, not after a partial batch.
    const packedFields = Array.from({ length: MAX_SHEET_FIELDS }, (_, i) => ({
      id: `fld_${i}`, name: `F${i}`, type: 'string',
    }))
    mountWorkbench(packedFields)
    workbenchMock.client.createField.mockResolvedValue({ field: { id: 'fld_new', name: 'Warehouse', type: 'string' } })
    workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_1', version: 1, data: {} } })

    await openImportModal()
    emitImportPayload!({
      records: [{ [createFieldPlaceholderId(0)]: 'A1' }],
      rowIndexes: [0],
      failures: [],
      createFields: [{ header: 'Warehouse', columnIndex: 0 }],
    })
    await flushUi(20)

    expect(workbenchMock.client.createField).not.toHaveBeenCalled()
    expect(workbenchMock.client.createRecord).not.toHaveBeenCalled()
    expect(showErrorSpy).toHaveBeenCalledWith(
      `Creating these fields would push this sheet past the ${MAX_SHEET_FIELDS}-field limit. Reduce columns or map them manually. No records were imported.`,
    )
    expect(importModalProps.createFieldsError).toContain('field limit')
  })

  it('refuses a header that cannot become a field name instead of creating an unnamed column', async () => {
    mountWorkbench([{ id: 'fld_name', name: 'Name', type: 'string' }])
    workbenchMock.client.createField.mockResolvedValue({ field: { id: 'fld_new', name: 'x', type: 'string' } })
    workbenchMock.client.createRecord.mockResolvedValue({ record: { id: 'rec_1', version: 1, data: {} } })

    await openImportModal()
    emitImportPayload!({
      records: [{ [createFieldPlaceholderId(1)]: 'A1' }],
      rowIndexes: [0],
      failures: [],
      createFields: [{ header: '   ', columnIndex: 1 }],
    })
    await flushUi(20)

    expect(workbenchMock.client.createField).not.toHaveBeenCalled()
    expect(workbenchMock.client.createRecord).not.toHaveBeenCalled()
    expect(showErrorSpy).toHaveBeenCalledWith(
      'Column name "   " cannot be used as a field name. No records were imported.',
    )
  })
})
