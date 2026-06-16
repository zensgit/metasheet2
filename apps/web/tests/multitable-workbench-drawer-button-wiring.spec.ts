import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Wire-drift lock for the B1-e record-drawer button (mirrors the restore-wiring
// lock #2662). The drawer emits `run-button { recordId, field }`; the ONLY
// untested link between that emit and `client.runButton` is the `@run-button`
// listener the workbench wires onto <MetaRecordDrawer> + the existing
// onRunButton handler. The drawer-emit (multitable-record-drawer-button.spec)
// and the client call (multitable-button-run-client.spec) are covered, but a
// drawer-component test stays green even if the workbench forgets `@run-button`,
// so the feature would ship dead (the #1779/#1781 wire-vs-fixture trap). This
// captures the real listener the workbench passes down and asserts the payload
// round-trips into the exact client args + the failed (HTTP-200) status branch.

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()

let capturedDrawerAttrs: Record<string, unknown> | null = null
let capturedGridAttrs: Record<string, unknown> | null = null

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined) }) }
})

function stubComponent(name: string) {
  return defineComponent({ name, render() { return h('div', { [`data-stub-${name}`]: 'true' }) } })
}

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
    canRead: ref(true), canCreateRecord: ref(true), canEditRecord: ref(true), canDeleteRecord: ref(true),
    canManageFields: ref(true), canManageSheetAccess: ref(true), canManageViews: ref(true), canComment: ref(true),
    canManageAutomation: ref(false), canExport: ref(true),
  }),
}))
vi.mock('../src/multitable/composables/useMultitableComments', () => ({
  useMultitableComments: () => ({
    comments: ref([]), loading: ref(false), submitting: ref(false), resolvingIds: ref<string[]>([]),
    updatingIds: ref<string[]>([]), deletingIds: ref<string[]>([]), error: ref<string | null>(null),
    reactingKeys: ref<string[]>([]),
    loadComments: vi.fn(), addComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn(), resolveComment: vi.fn(),
    addReaction: vi.fn(), removeReaction: vi.fn(),
  }),
}))
vi.mock('../src/multitable/composables/useMultitableCommentInbox', () => ({
  useMultitableCommentInbox: () => ({ unreadCount: ref(0), refreshUnreadCount: vi.fn().mockResolvedValue(0) }),
}))
vi.mock('../src/multitable/composables/useMultitableCommentRealtime', () => ({ useMultitableCommentRealtime: vi.fn() }))
vi.mock('../src/multitable/composables/useMultitableSheetRealtime', () => ({ useMultitableSheetRealtime: vi.fn() }))
vi.mock('../src/multitable/import/bulk-import', () => ({ bulkImportRecords: vi.fn() }))

vi.mock('../src/multitable/components/MetaViewTabBar.vue', () => ({ default: stubComponent('MetaViewTabBar') }))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
// Capturing stub for the grid — records the real listeners (for the duplicate-record wire-drift lock).
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({
  default: defineComponent({
    name: 'MetaGridTable',
    inheritAttrs: false,
    setup(_props, { attrs }) {
      capturedGridAttrs = attrs as Record<string, unknown>
      return () => h('div', { 'data-stub-MetaGridTable': 'true' })
    },
  }),
}))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
// Capturing stub for the component under wiring test — records the real listeners.
vi.mock('../src/multitable/components/MetaRecordDrawer.vue', () => ({
  default: defineComponent({
    name: 'MetaRecordDrawer',
    inheritAttrs: false,
    setup(_props, { attrs }) {
      capturedDrawerAttrs = attrs as Record<string, unknown>
      return () => h('div', { 'data-stub-MetaRecordDrawer': 'true' })
    },
  }),
}))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({ default: stubComponent('MetaFieldManager') }))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({ default: stubComponent('MetaKanbanView') }))
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({ default: stubComponent('MetaGalleryView') }))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: stubComponent('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({ default: stubComponent('MetaTimelineView') }))
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({ default: stubComponent('MetaImportModal') }))
vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({ default: stubComponent('MetaBasePicker') }))
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

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) { await Promise.resolve(); await nextTick() }
}

const buttonField = { id: 'fld_btn', name: 'Approve', type: 'button', property: { label: 'Approve', variant: 'primary' } }

function createWorkbenchMock() {
  const activeBaseId = ref('base_ops')
  const activeSheetId = ref<string | null>('sheet_orders')
  const activeViewId = ref('view_grid')
  const views = ref([{ id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' }])
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_ops', name: 'Ops Base' }] }),
      loadContext: vi.fn().mockResolvedValue({ base: { id: 'base_ops' }, sheet: null, sheets: [], views: [], capabilities: {} }),
      loadFormContext: vi.fn(), getRecord: vi.fn(), createSheet: vi.fn(), createBase: vi.fn(),
      createField: vi.fn(), preparePersonField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn(),
      createView: vi.fn(), deleteView: vi.fn(), patchRecords: vi.fn(), submitForm: vi.fn(), updateView: vi.fn(),
      // The function under test:
      runButton: vi.fn().mockResolvedValue({ status: 'succeeded', executionId: 'exec_1' }),
    },
    sheets: ref([{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]),
    fields: ref([buttonField]),
    views, activeBaseId, activeSheetId, activeViewId,
    capabilities: ref({
      canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true,
      canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: false, canExport: true,
    }),
    capabilityOrigin: ref(null), fieldPermissions: ref({}), viewPermissions: ref({}),
    activeView: computed(() => views.value.find((v) => v.id === activeViewId.value) ?? null),
    loading: ref(false), error: ref<string | null>(null),
    loadSheets: vi.fn().mockResolvedValue(true), loadBaseContext: vi.fn().mockResolvedValue(true),
    loadSheetMeta: vi.fn().mockResolvedValue(true), switchBase: vi.fn().mockResolvedValue(true),
    syncExternalContext: vi.fn().mockResolvedValue(true),
    selectBase: vi.fn((id: string) => { activeBaseId.value = id }),
    selectSheet: vi.fn((id: string) => { activeSheetId.value = id }),
    selectView: vi.fn((id: string) => { activeViewId.value = id }),
  }
}

function createGridMock() {
  return {
    fields: ref([]), rows: ref([]), loading: ref(false), currentPage: ref(1), totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }), visibleFields: ref([]), sortRules: ref([]),
    filterRules: ref([]), filterConjunction: ref('and'), canUndo: ref(false), canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupField: ref(null), hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}), linkSummaries: ref({}), personSummaries: ref({}), attachmentSummaries: ref({}),
    fieldPermissions: ref({}), viewPermission: ref(null), rowActions: ref(null), rowActionOverrides: ref({}),
    capabilityOrigin: ref(null), conflict: ref(null), error: ref<string | null>(null), sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(), addSortRule: vi.fn(), removeSortRule: vi.fn(), addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(), removeFilterRule: vi.fn(), clearFilters: vi.fn(), applySortFilter: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), setGroupField: vi.fn(), goToPage: vi.fn(), patchCell: vi.fn(),
    createRecord: vi.fn(), deleteRecord: vi.fn(), duplicateRecord: vi.fn().mockResolvedValue('rec_clone'), resolveRowActions: vi.fn(() => null),
    loadViewData: vi.fn().mockResolvedValue(true), reloadCurrentPage: vi.fn(), dismissConflict: vi.fn(),
    retryConflict: vi.fn(), setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
  }
}

type RunButtonFn = (p: { recordId: string; field: { id: string } }) => Promise<void>

describe('MultitableWorkbench drawer run-button handler wiring (B1-e)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capturedDrawerAttrs = null
    capturedGridAttrs = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null; container = null
    showErrorSpy.mockReset(); showSuccessSpy.mockReset()
    vi.unstubAllGlobals(); vi.clearAllMocks()
  })

  async function mountAndGetRunButton(): Promise<RunButtonFn> {
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
    expect(capturedDrawerAttrs).not.toBeNull()
    // The wire under test: the workbench MUST pass `@run-button` down to the drawer.
    const onRunButton = capturedDrawerAttrs!.onRunButton as RunButtonFn
    expect(typeof onRunButton).toBe('function')
    return onRunButton
  }

  it('threads the drawer emit into client.runButton(sheetId, recordId, fieldId) and shows the success toast', async () => {
    const onRunButton = await mountAndGetRunButton()
    await onRunButton({ recordId: 'rec_42', field: { id: 'fld_btn' } })
    await flushUi()
    expect(workbenchMock.client.runButton).toHaveBeenCalledTimes(1)
    // Active sheet from the workbench + record + field id, in order — a reorder would silently
    // run the wrong button; caught here.
    expect(workbenchMock.client.runButton).toHaveBeenCalledWith('sheet_orders', 'rec_42', 'fld_btn')
    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('branches on a failed (HTTP-200, resolved) result and shows an error toast (not a throw)', async () => {
    workbenchMock.client.runButton.mockResolvedValueOnce({ status: 'failed', executionId: 'exec_2', message: 'Action rejected' })
    const onRunButton = await mountAndGetRunButton()
    await onRunButton({ recordId: 'rec_42', field: { id: 'fld_btn' } })
    await flushUi()
    expect(showErrorSpy).toHaveBeenCalledTimes(1)
    expect(showErrorSpy.mock.calls[0][0]).toBe('Action rejected')
    expect(showSuccessSpy).not.toHaveBeenCalled()
  })

  it('passes a buttonRunPending array down to the drawer (shared in-flight key surface)', async () => {
    await mountAndGetRunButton()
    // Plain (non-event) attrs land under their kebab-case key in `attrs`.
    const pending = capturedDrawerAttrs!['button-run-pending'] ?? capturedDrawerAttrs!.buttonRunPending
    expect(Array.isArray(pending)).toBe(true)
  })

  it('does nothing when there is no active sheet', async () => {
    const onRunButton = await mountAndGetRunButton()
    workbenchMock.activeSheetId.value = null
    await onRunButton({ recordId: 'rec_42', field: { id: 'fld_btn' } })
    await flushUi()
    expect(workbenchMock.client.runButton).not.toHaveBeenCalled()
  })
})

// Wire-drift lock for the duplicate / clone record affordance (design 2026-06-16). Both the drawer Duplicate
// button (`@duplicate`) and the grid right-click (`@duplicate-record`) must be threaded by the workbench into
// the SAME onDuplicateRecord handler → grid.duplicateRecord. A component-level test (drawer/grid emit) stays
// green even if the workbench forgets the listener, shipping a dead feature — so capture the real listeners.
describe('MultitableWorkbench duplicate-record handler wiring (2026-06-16)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capturedDrawerAttrs = null
    capturedGridAttrs = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null; container = null
    showErrorSpy.mockReset(); showSuccessSpy.mockReset()
    vi.unstubAllGlobals(); vi.clearAllMocks()
  })

  async function mountWorkbench(): Promise<void> {
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
  }

  it('threads the grid @duplicate-record emit into grid.duplicateRecord and shows the success toast', async () => {
    await mountWorkbench()
    expect(capturedGridAttrs).not.toBeNull()
    const onDuplicateRecord = capturedGridAttrs!.onDuplicateRecord as (recordId: string) => Promise<void>
    expect(typeof onDuplicateRecord).toBe('function')

    await onDuplicateRecord('rec_source')
    await flushUi()

    expect(gridMock.duplicateRecord).toHaveBeenCalledTimes(1)
    expect(gridMock.duplicateRecord).toHaveBeenCalledWith('rec_source')
    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('threads the drawer @duplicate emit into grid.duplicateRecord with the selected record id', async () => {
    await mountWorkbench()
    expect(capturedDrawerAttrs).not.toBeNull()
    // The workbench wires `@duplicate="onDuplicateRecord(selectedRecordId)"`. Drive a selection first so the
    // handler has a source id to duplicate (mirrors a user opening a record then clicking Duplicate).
    const onSelectRecord = capturedGridAttrs!.onSelectRecord as (id: string) => void
    onSelectRecord('rec_open')
    await flushUi()

    const onDuplicate = capturedDrawerAttrs!.onDuplicate as () => Promise<void>
    expect(typeof onDuplicate).toBe('function')
    await onDuplicate()
    await flushUi()

    expect(gridMock.duplicateRecord).toHaveBeenCalledWith('rec_open')
  })

  it('surfaces grid.error on a failed duplicate (null id) instead of a success toast', async () => {
    gridMock.duplicateRecord.mockResolvedValueOnce(null)
    gridMock.error.value = 'Failed to duplicate record'
    await mountWorkbench()
    const onDuplicateRecord = capturedGridAttrs!.onDuplicateRecord as (recordId: string) => Promise<void>

    await onDuplicateRecord('rec_source')
    await flushUi()

    expect(showSuccessSpy).not.toHaveBeenCalled()
    expect(showErrorSpy).toHaveBeenCalledWith('Failed to duplicate record')
  })
})
