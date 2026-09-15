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

function stubComponent(name: string) {
  return defineComponent({
    name,
    render() {
      return h('div', { [`data-stub-${name}`]: 'true' })
    },
  })
}

// Rename affordance (feat/multitable-rename): unlike the other mocked children above, these two
// stubs need to actually EMIT (rename-sheet / rename) so the tests below can drive
// MultitableWorkbench.vue's onRenameSheet/onRenameBase wiring — a bare stubComponent() has no way
// to trigger an emit. They also surface the canManageFields prop they were passed via a data
// attribute, as a cheap positive proof that the workbench threads caps.canManageFields.value down
// (the negative case — the affordance actually disappearing when the capability is false — is
// exhaustively covered at the component level in meta-sheet-view-rail.spec.ts / meta-base-picker.spec.ts).
function stubMetaSheetViewRail() {
  return defineComponent({
    name: 'MetaSheetViewRail',
    props: { canManageFields: { type: Boolean, default: false } },
    emits: ['select-sheet', 'select-view', 'create-sheet', 'toggle-personal', 'rename-sheet'],
    setup(props, { emit }) {
      return () => h('div', {
        'data-stub-MetaSheetViewRail': 'true',
        'data-can-manage-fields': String(props.canManageFields === true),
      }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-rename-sheet',
          onClick: () => emit('rename-sheet', 'sheet_orders', 'Orders Renamed'),
        }, 'rename-sheet'),
      ])
    },
  })
}

// #5743's keep-alive test needs to CLOSE a manager dialog. MetaFieldManager is rendered
// unconditionally with a :visible prop, so a bare stubComponent() gives the test no way to emit
// 'close' back to the workbench; this stub surfaces both the visible prop and a close button.
function stubMetaFieldManager() {
  return defineComponent({
    name: 'MetaFieldManager',
    props: { visible: { type: Boolean, default: false } },
    emits: ['close'],
    setup(props, { emit }) {
      return () => h('div', {
        'data-stub-MetaFieldManager': 'true',
        'data-visible': String(props.visible === true),
      }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-close-field-manager',
          onClick: () => emit('close'),
        }, 'close'),
      ])
    },
  })
}

function stubMetaBasePicker() {
  return defineComponent({
    name: 'MetaBasePicker',
    props: { canManageFields: { type: Boolean, default: false } },
    emits: ['select', 'create', 'toggle-favorite', 'rename'],
    setup(props, { emit }) {
      return () => h('div', {
        'data-stub-MetaBasePicker': 'true',
        'data-can-manage-fields': String(props.canManageFields === true),
      }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-rename-base',
          onClick: () => emit('rename', 'base_ops', 'Ops Base Renamed'),
        }, 'rename-base'),
      ])
    },
  })
}

let workbenchMock: any
let gridMock: any

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({
  useMultitableWorkbench: () => workbenchMock,
}))

// MetaViewManager imports the pure `parseFilterTree` named export directly from this module
// (not via the useMultitableGrid() hook return value) to hydrate a view's stored filter into its
// config-drawer draft. A hook-only mock leaves that export undefined and throws the moment a real
// (unstubbed) MetaViewManager opens a non-grid view's config — keep it real via importActual.
vi.mock('../src/multitable/composables/useMultitableGrid', async () => {
  const actual = await vi.importActual<typeof import('../src/multitable/composables/useMultitableGrid')>(
    '../src/multitable/composables/useMultitableGrid',
  )
  return {
    ...actual,
    useMultitableGrid: () => gridMock,
  }
})

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

vi.mock('../src/multitable/import/bulk-import', () => ({
  bulkImportRecords: vi.fn(),
}))

vi.mock('../src/multitable/components/MetaSheetViewRail.vue', () => ({ default: stubMetaSheetViewRail() }))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({ default: stubComponent('MetaGridTable') }))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
// W2 S3: MultitableWorkbench.vue now renders MetaRecordInspector.vue directly (MetaRecordDrawer.vue
// is a deprecated thin compat shell no longer mounted by the workbench, OD-W2-7=b).
vi.mock('../src/multitable/components/MetaRecordInspector.vue', () => ({ default: stubComponent('MetaRecordInspector') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({ default: stubMetaFieldManager() }))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({ default: stubComponent('MetaKanbanView') }))
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({ default: stubComponent('MetaGalleryView') }))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: stubComponent('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({ default: stubComponent('MetaTimelineView') }))
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({ default: stubComponent('MetaImportModal') }))
vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({ default: stubMetaBasePicker() }))

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

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function createWorkbenchMock() {
  const activeBaseId = ref('base_ops')
  const activeSheetId = ref('sheet_orders')
  const activeViewId = ref('view_grid')
  const views = ref([
    { id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' },
    { id: 'view_gallery', sheetId: 'sheet_orders', name: 'Gallery', type: 'gallery', config: { titleFieldId: 'fld_title', columns: 3, cardSize: 'medium' } },
    { id: 'view_timeline', sheetId: 'sheet_orders', name: 'Timeline', type: 'timeline', config: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_title', zoom: 'week' } },
  ])

  return {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_ops', name: 'Ops Base' }] }),
      updateView: vi.fn().mockResolvedValue({ view: views.value[2] }),
      loadFormContext: vi.fn(),
      getRecord: vi.fn(),
      createSheet: vi.fn(),
      createBase: vi.fn(),
      createField: vi.fn(),
      preparePersonField: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
      createView: vi.fn(),
      deleteView: vi.fn(),
      patchRecords: vi.fn(),
      submitForm: vi.fn(),
      renameSheet: vi.fn().mockResolvedValue({ sheet: { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders Renamed', description: null } }),
      renameBase: vi.fn().mockResolvedValue({ base: { id: 'base_ops', name: 'Ops Base Renamed' } }),
    },
    sheets: ref([{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]),
    fields: ref([
      { id: 'fld_title', name: 'Title', type: 'string' },
      { id: 'fld_start', name: 'Start', type: 'date' },
      { id: 'fld_end', name: 'End', type: 'date' },
      { id: 'fld_owner', name: 'Owner', type: 'string' },
    ]),
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
      canManageAutomation: false, canExport: true,
    }),
    capabilityOrigin: ref(null),
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

function createGridMock() {
  return {
    fields: ref([]),
    rows: ref([]),
    loading: ref(false),
    currentPage: ref(1),
    totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }),
    visibleFields: ref([]),
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
    columnWidths: ref<Record<string, number>>({}),
    linkSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    personSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    attachmentSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    fieldPermissions: ref({}),
    viewPermission: ref(null),
    rowActions: ref(null),
    rowActionOverrides: ref<Record<string, { canEdit: boolean; canDelete: boolean; canComment: boolean }>>({}),
    capabilityOrigin: ref(null),
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
    loadViewData: vi.fn().mockResolvedValue(true),
    reloadCurrentPage: vi.fn(),
    dismissConflict: vi.fn(),
    retryConflict: vi.fn(),
    setColumnWidth: vi.fn(),
    setSearchQuery: vi.fn(),
  }
}

describe('MultitableWorkbench manager-driven config flow', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    showErrorSpy.mockReset()
    showSuccessSpy.mockReset()
    vi.clearAllMocks()
  })

  it('persists timeline config updates through the real view manager and workbench client', async () => {
    const Host = defineComponent({
      setup() {
        return () => h(MultitableWorkbench as Component)
      },
    })

    app = createApp(Host)
    app.mount(container!)
    await flushUi()

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Views'))?.click()
    await flushUi()

    const configureButtons = Array.from(container!.querySelectorAll('.meta-view-mgr__action'))
      .filter((button) => (button as HTMLButtonElement).title === 'Configure') as HTMLButtonElement[]
    configureButtons[2]?.click()
    await flushUi()

    const selects = Array.from(container!.querySelectorAll('.meta-view-mgr__config select')) as HTMLSelectElement[]
    // 5, not 4: MetaViewManager's config drawer grew a shared "Filter, sort, group" section
    // (.meta-view-mgr__common) rendered after every type-specific block, whose "Group field"
    // select is always present (5th) regardless of view type. The 4 timeline-specific selects
    // (start/end/label/zoom) this test drives are still indices 0-3 — the new select is appended
    // after them, not inserted before, so the positional assertions below are unaffected.
    expect(selects).toHaveLength(5)
    selects[2].value = 'fld_owner'
    selects[2].dispatchEvent(new Event('change', { bubbles: true }))
    selects[3].value = 'month'
    selects[3].dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(Array.from(container!.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings'))
      ?.click()
    await flushUi()

    expect(workbenchMock.client.updateView).toHaveBeenCalledWith('view_timeline', {
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        labelFieldId: 'fld_owner',
        zoom: 'month',
      },
    })
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledWith('sheet_orders')
    expect(gridMock.loadViewData).toHaveBeenCalledWith(0)
    // #3720 (W3-5b) added an optional `action?: ToastAction` 2nd param to the workbench's local
    // showSuccess(msg, action) wrapper (for History Center deep-link toast actions); it always
    // forwards both positional args to the MetaToast stub, so a call site that only supplies
    // `msg` still records `action === undefined` explicitly as the 2nd arg.
    expect(showSuccessSpy).toHaveBeenCalledWith('View settings saved', undefined)
    expect(showErrorSpy).not.toHaveBeenCalled()
  })
})

// Rename affordance (feat/multitable-rename). Both PATCH routes gate server-side on
// canManageFields — these tests cover the workbench-level wiring: (a) the emit reaches
// workbench.client.rename*, refreshes via the same paths onUpdateField/onCreateBase use, and (b) a
// rejected client call (simulating the server's 403) surfaces through showError rather than a
// silent success, with NO refresh performed on failure.
describe('MultitableWorkbench rename affordance wiring', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    showErrorSpy.mockReset()
    showSuccessSpy.mockReset()
    vi.clearAllMocks()
  })

  function mountWorkbench(): HTMLDivElement {
    const Host = defineComponent({
      setup() {
        return () => h(MultitableWorkbench as Component)
      },
    })
    app = createApp(Host)
    app.mount(container!)
    return container!
  }

  it('threads caps.canManageFields.value into both the sheet rail and the base picker', async () => {
    const root = mountWorkbench()
    await flushUi()

    expect(root.querySelector('[data-stub-MetaSheetViewRail]')?.getAttribute('data-can-manage-fields')).toBe('true')
    expect(root.querySelector('[data-stub-MetaBasePicker]')?.getAttribute('data-can-manage-fields')).toBe('true')
  })

  it('wires rename-sheet to client.renameSheet and refreshes sheet meta via loadSheetMeta', async () => {
    const root = mountWorkbench()
    await flushUi()

    root.querySelector<HTMLButtonElement>('[data-testid="stub-rename-sheet"]')?.click()
    await flushUi()

    expect(workbenchMock.client.renameSheet).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.renameSheet).toHaveBeenCalledWith('sheet_orders', 'Orders Renamed')
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledWith('sheet_orders')
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('a rejected client.renameSheet (simulating the server 403) surfaces through showError, not a silent success, and skips the refresh', async () => {
    const message = 'Renaming requires schema authority: an admin role or the multitable:manage-schema permission. multitable:write alone is not sufficient.'
    workbenchMock.client.renameSheet.mockRejectedValueOnce(new Error(message))
    const root = mountWorkbench()
    await flushUi()
    workbenchMock.loadSheetMeta.mockClear() // drop the mount-time call so we assert only the post-click behavior

    root.querySelector<HTMLButtonElement>('[data-testid="stub-rename-sheet"]')?.click()
    await flushUi()

    expect(showErrorSpy).toHaveBeenCalledWith(message)
    expect(workbenchMock.loadSheetMeta).not.toHaveBeenCalled()
  })

  it('wires rename to client.renameBase', async () => {
    const root = mountWorkbench()
    await flushUi()

    root.querySelector<HTMLButtonElement>('[data-testid="stub-rename-base"]')?.click()
    await flushUi()

    expect(workbenchMock.client.renameBase).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.renameBase).toHaveBeenCalledWith('base_ops', 'Ops Base Renamed')
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('a rejected client.renameBase (simulating the server 403) surfaces through showError, not a silent success', async () => {
    const message = 'Renaming requires schema authority: an admin role or the multitable:manage-schema permission. multitable:write alone is not sufficient.'
    workbenchMock.client.renameBase.mockRejectedValueOnce(new Error(message))
    const root = mountWorkbench()
    await flushUi()

    root.querySelector<HTMLButtonElement>('[data-testid="stub-rename-base"]')?.click()
    await flushUi()

    expect(showErrorSpy).toHaveBeenCalledWith(message)
  })
})

// #5743: with a manager dialog open, the workbench used to re-arm a 1200 ms interval that called
// workbench.loadSheetMeta() forever — GET /fields + GET /context roughly once a second, for as long
// as the dialog stayed open, on a tab nobody was looking at. These tests pin the replacement
// cadence: one refresh on open, then DIALOG_META_REFRESH_INTERVAL_MS, nothing at all while the tab
// is hidden, one catch-up refresh when it comes back, and silence once the dialog closes.
describe('MultitableWorkbench manager dialog meta keep-alive (#5743)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (document as unknown as { visibilityState?: unknown }).visibilityState
    showErrorSpy.mockReset()
    showSuccessSpy.mockReset()
    vi.clearAllMocks()
  })

  function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    })
  }

  // Fake timers do not fake microtasks, so the component's own await chain still needs draining.
  async function flushFake(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
    await flushUi()
  }

  function openFieldManager(root: HTMLDivElement) {
    const managerButtons = Array.from(root.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    const fieldsButton = managerButtons.find((button) => button.textContent?.includes('Fields'))
    expect(fieldsButton).toBeTruthy()
    fieldsButton!.click()
  }

  async function mountWithOpenDialog(): Promise<HTMLDivElement> {
    const Host = defineComponent({
      setup() {
        return () => h(MultitableWorkbench as Component)
      },
    })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
    setVisibility('visible')
    vi.useFakeTimers()
    workbenchMock.loadSheetMeta.mockClear() // drop mount-time refreshes; count only the keep-alive
    openFieldManager(container!)
    await flushUi()
    return container!
  }

  it('refreshes once on open and then only every DIALOG_META_REFRESH_INTERVAL_MS — not once a second', async () => {
    await mountWithOpenDialog()

    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)

    await flushFake(10_000)
    // The old cadence would have fired ~8 more times by here.
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)

    await flushFake(DIALOG_META_REFRESH_INTERVAL_MS - 10_000)
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(2)
    expect(workbenchMock.loadSheetMeta).toHaveBeenLastCalledWith('sheet_orders')
  })

  it('polls nothing while the tab is hidden and catches up once when it becomes visible again', async () => {
    await mountWithOpenDialog()
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await flushFake(30_000)
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await flushUi()
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(2)

    // ...and the slow cadence resumes from there rather than replaying the hidden window.
    await flushFake(DIALOG_META_REFRESH_INTERVAL_MS)
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(3)
  })

  it('stops entirely once the dialog closes, including the visibility catch-up', async () => {
    const root = await mountWithOpenDialog()
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-close-field-manager"]')?.click()
    await flushUi()
    workbenchMock.loadSheetMeta.mockClear()

    await flushFake(DIALOG_META_REFRESH_INTERVAL_MS * 4)
    expect(workbenchMock.loadSheetMeta).not.toHaveBeenCalled()

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await flushUi()
    expect(workbenchMock.loadSheetMeta).not.toHaveBeenCalled()
  })

  // The catch-up listener is document-scoped and outlives the dialog, so stopDialogMetaRefresh has
  // to detach it (the interval alone is not the whole teardown). Behaviourally it is masked by the
  // dialogMetaRefreshWanted() re-check, hence the listener-identity assertion.
  it('detaches the visibilitychange listener when the dialog closes', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const root = await mountWithOpenDialog()
    const added = addSpy.mock.calls
      .filter(([type]) => type === 'visibilitychange')
      .map(([, handler]) => handler)
    expect(added).toHaveLength(1)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-close-field-manager"]')?.click()
    await flushUi()

    const removed = removeSpy.mock.calls
      .filter(([type]) => type === 'visibilitychange')
      .map(([, handler]) => handler)
    expect(removed).toContain(added[0])
  })

  // Teardown has to cancel the QUEUED re-run too, not just the interval and the listener: a refresh
  // that is still awaiting when the workbench unmounts comes back into a finally whose re-run clause
  // is armed (the sheet changed mid-flight) and whose dialog refs still read "open" — that used to
  // put one more GET /fields + GET /context on the wire against a dead component.
  it('fires nothing after unmount, even with a refresh in flight and a sheet switch queued', async () => {
    await mountWithOpenDialog()
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)

    // Hold the keep-alive tick's refresh open.
    const pending: { settle: (value: boolean) => void } = { settle: () => {} }
    workbenchMock.loadSheetMeta.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { pending.settle = resolve }),
    )
    await flushFake(DIALOG_META_REFRESH_INTERVAL_MS)
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(2)

    // Sheet switches while that refresh is in flight -> the finally's re-run clause arms.
    workbenchMock.activeSheetId.value = 'sheet_invoices'
    await flushUi()
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(2)

    app!.unmount()
    app = null
    pending.settle(true)
    await flushUi()

    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(2)
  })

  // The keep-alive also reseated grid.fields with a brand-new array on every tick, which invalidates
  // every grid computed (and re-renders the table) even when the refresh brought back the very same
  // field objects — which, with the composable's fingerprint skip, is now the steady state.
  it('leaves grid.fields identity alone when a refresh brings back the same field objects', async () => {
    await mountWithOpenDialog()
    const seeded = gridMock.fields.value
    expect(seeded.length).toBeGreaterThan(0)

    await flushFake(DIALOG_META_REFRESH_INTERVAL_MS)
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(2)
    expect(gridMock.fields.value).toBe(seeded)

    // A real field change still reseats it.
    workbenchMock.fields.value = [
      ...workbenchMock.fields.value,
      { id: 'fld_qty', name: 'Qty', type: 'number' },
    ]
    await flushFake(DIALOG_META_REFRESH_INTERVAL_MS)
    expect(gridMock.fields.value).not.toBe(seeded)
    expect(gridMock.fields.value.map((field: { id: string }) => field.id)).toContain('fld_qty')
  })

  // Same teardown hole on the other side of the await: the refresh's own grid.fields write lands
  // after loadSheetMeta settles, so an unmount in between must cancel it too (here the answer
  // genuinely changed, which is the only way the write is observable).
  it('does not write grid.fields from a refresh that settles after unmount', async () => {
    await mountWithOpenDialog()
    const seeded = gridMock.fields.value
    expect(seeded.length).toBeGreaterThan(0)

    const pending: { settle: (value: boolean) => void } = { settle: () => {} }
    workbenchMock.loadSheetMeta.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { pending.settle = resolve }),
    )
    await flushFake(DIALOG_META_REFRESH_INTERVAL_MS)
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(2)

    // What that in-flight refresh is about to apply.
    workbenchMock.fields.value = [
      ...workbenchMock.fields.value,
      { id: 'fld_qty', name: 'Qty', type: 'number' },
    ]
    app!.unmount()
    app = null
    pending.settle(true)
    await flushUi()

    expect(gridMock.fields.value).toBe(seeded)
  })
})
