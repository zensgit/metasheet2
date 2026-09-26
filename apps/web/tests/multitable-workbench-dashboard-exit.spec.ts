// A2 (2026-09-25, 客户反馈 2026-09-24 #6, 裁定见 PR #6074): once the dashboard toolbar toggle opened
// MetaDashboardView, none of the sidebar navigation paths reset `showDashboardView`, and
// MetaDashboardView itself had no back control — there was no way back to the grid short of
// re-clicking the toggle button. This spec pins the fix across every navigation path that switches
// context away from the grid: select a different/the-same view, select a different/the-same sheet,
// switch base, the notification bell's click-to-locate (same-sheet and delegated-to-onSelectSheet
// branches), the History Center's click-through (same-sheet branch), create/delete a view,
// create/delete a sheet, install a template, an external-context sync (embed postMessage / the
// baseId+sheetId+viewId props watcher) that actually switches context, and the dashboard's own new
// `close` emit.
//
// S1 (2026-09-25 review): this spec stubs out MetaDashboardView itself, so it proves nothing about
// the real component's back-to-table button — that half is pinned separately in
// tests/multitable-dashboard-view.spec.ts (mounts the real component).
//
// N1 (2026-09-25 review): a cancelled discard-unsaved-changes confirm must leave the dashboard
// exactly as it was — see "a cancelled context switch leaves the dashboard open" below.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

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

// The rail stub exposes controls for re-selecting the ALREADY-active view/sheet (the early-return
// branches `onSelectView`/`onSelectSheet` take), selecting a genuinely different view, and creating
// or deleting a sheet — the "click the rail" scenarios this fix covers.
function stubMetaSheetViewRail() {
  return defineComponent({
    name: 'MetaSheetViewRail',
    emits: ['select-sheet', 'select-view', 'create-sheet', 'toggle-personal', 'rename-sheet', 'delete-sheet'],
    setup(_, { emit }) {
      return () => h('div', { 'data-stub-MetaSheetViewRail': 'true' }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-select-view-same',
          onClick: () => emit('select-view', 'view_grid'),
        }, 'select-view-same'),
        h('button', {
          type: 'button',
          'data-testid': 'stub-select-view-other',
          onClick: () => emit('select-view', 'view_grid_2'),
        }, 'select-view-other'),
        h('button', {
          type: 'button',
          'data-testid': 'stub-select-sheet-same',
          onClick: () => emit('select-sheet', 'sheet_orders'),
        }, 'select-sheet-same'),
        h('button', {
          type: 'button',
          'data-testid': 'stub-create-sheet',
          onClick: () => emit('create-sheet', 'New Sheet'),
        }, 'create-sheet'),
        h('button', {
          type: 'button',
          'data-testid': 'stub-delete-sheet-active',
          onClick: () => emit('delete-sheet', 'sheet_orders'),
        }, 'delete-sheet-active'),
      ])
    },
  })
}

// S2 (2026-09-25 review): a minimal stub for the notification bell — exposes the same-sheet
// click-to-locate (its own exitDashboard call, S4) and the different-sheet one (delegates to
// onSelectSheet, N1-gated).
function stubMetaNotificationBell() {
  return defineComponent({
    name: 'MetaNotificationBell',
    props: ['apiClient'],
    emits: ['navigate'],
    setup(_, { emit }) {
      return () => h('div', { 'data-stub-MetaNotificationBell': 'true' }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-notification-navigate-same-sheet',
          onClick: () => emit('navigate', { sheetId: 'sheet_orders', recordId: 'rec_1' }),
        }, 'navigate-same-sheet'),
      ])
    },
  })
}

// S2/S3 (2026-09-25 review): a minimal stub for the view manager modal — exposes create-view and
// delete-view (targeting the currently active view, the S3 bug fix).
function stubMetaViewManager() {
  return defineComponent({
    name: 'MetaViewManager',
    emits: ['close', 'create-view', 'update-view', 'delete-view', 'update:dirty'],
    setup(_, { emit }) {
      return () => h('div', { 'data-stub-MetaViewManager': 'true' }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-create-view',
          onClick: () => emit('create-view', { sheetId: 'sheet_orders', name: 'New View', type: 'grid' }),
        }, 'create-view'),
        h('button', {
          type: 'button',
          'data-testid': 'stub-delete-view-active',
          onClick: () => emit('delete-view', 'view_grid'),
        }, 'delete-view-active'),
      ])
    },
  })
}

// S4 (2026-09-25 review): a minimal stub for the History Center modal — exposes the same-sheet
// click-through branch of onHistoryOpenRecord.
function stubHistoryCenterModal() {
  return defineComponent({
    name: 'HistoryCenterModal',
    props: ['open', 'baseId', 'sheetId', 'fields', 'linkSummaries', 'personSummaries', 'initialBatchId', 'canRestoreRecords'],
    emits: ['close', 'open-record', 'restored'],
    setup(_, { emit }) {
      return () => h('div', { 'data-stub-HistoryCenterModal': 'true' }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-history-open-record-same-sheet',
          onClick: () => emit('open-record', { sheetId: 'sheet_orders', recordId: 'rec_1' }),
        }, 'open-record-same-sheet'),
      ])
    },
  })
}

// S4 (2026-09-25 review): a minimal stub for the template card so the template-library install
// button can be driven without the real card's chart/badge computed properties.
function stubMetaTemplateCard() {
  return defineComponent({
    name: 'MetaTemplateCard',
    props: ['template', 'installing'],
    emits: ['install', 'detail', 'delete'],
    setup(props, { emit }) {
      return () => h('div', { 'data-stub-MetaTemplateCard': 'true' }, [
        h('button', {
          type: 'button',
          'data-testid': `stub-install-template-${(props as any).template?.id}`,
          onClick: () => emit('install', (props as any).template),
        }, 'install'),
      ])
    },
  })
}

// N1/S2 (2026-09-25 review): a minimal stub for the field manager modal — exposes `update:dirty` so
// a test can force `hasUnsavedWorkbenchDrafts` true and drive the discard-changes confirm gate.
function stubMetaFieldManagerDirty() {
  return defineComponent({
    name: 'MetaFieldManager',
    emits: ['update:dirty', 'bulk-fill', 'close', 'create-field', 'update-field', 'delete-field'],
    setup(_, { emit }) {
      return () => h('div', { 'data-stub-MetaFieldManager': 'true' }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-field-manager-mark-dirty',
          onClick: () => emit('update:dirty', true),
        }, 'mark-dirty'),
      ])
    },
  })
}

// The base-picker stub exposes a control for switching to a DIFFERENT base.
function stubMetaBasePicker() {
  return defineComponent({
    name: 'MetaBasePicker',
    emits: ['select', 'create', 'toggle-favorite', 'rename'],
    setup(_, { emit }) {
      return () => h('div', { 'data-stub-MetaBasePicker': 'true' }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-select-base-other',
          onClick: () => emit('select', 'base_finance'),
        }, 'select-base-other'),
      ])
    },
  })
}

// The dashboard stub exposes its own close control so the spec can drive MetaDashboardView's new
// `close` emit without depending on its real (heavy: charts/panels/client fetches) internals.
function stubMetaDashboardView() {
  return defineComponent({
    name: 'MetaDashboardView',
    emits: ['close'],
    setup(_, { emit }) {
      return () => h('div', { 'data-stub-MetaDashboardView': 'true' }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-dashboard-close',
          onClick: () => emit('close'),
        }, 'close'),
      ])
    },
  })
}

let workbenchMock: any
let gridMock: any

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({
  useMultitableWorkbench: () => workbenchMock,
}))

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

// S4/N1 (2026-09-25 review): onCreateSheet/onInstallTemplate gate on canCreateBasesAndSheets, which
// reads auth.getAccessSnapshot() directly (not through any of the composables already mocked above).
// Grant isAdmin so the toolbar's template-library button and the rail's create-sheet path are live.
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getAccessSnapshot: () => ({ email: 'test@example.com', roles: ['admin'], permissions: [], isAdmin: true }),
    getCurrentUserId: vi.fn().mockResolvedValue('user_1'),
    // useMultitableSheetPresence/comments-realtime (reached through this component's own setup, not
    // through any of the composables already mocked above) also call these two.
    getToken: () => null,
  }),
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
vi.mock('../src/multitable/components/MetaRecordInspector.vue', () => ({ default: stubComponent('MetaRecordInspector') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({ default: stubMetaFieldManagerDirty() }))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({ default: stubComponent('MetaKanbanView') }))
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({ default: stubComponent('MetaGalleryView') }))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: stubComponent('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({ default: stubComponent('MetaTimelineView') }))
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({ default: stubComponent('MetaImportModal') }))
vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({ default: stubMetaBasePicker() }))
vi.mock('../src/multitable/components/MetaDashboardView.vue', () => ({ default: stubMetaDashboardView() }))
vi.mock('../src/multitable/components/MetaNotificationBell.vue', () => ({ default: stubMetaNotificationBell() }))
vi.mock('../src/multitable/components/MetaViewManager.vue', () => ({ default: stubMetaViewManager() }))
vi.mock('../src/multitable/components/HistoryCenterModal.vue', () => ({ default: stubHistoryCenterModal() }))
vi.mock('../src/multitable/components/MetaTemplateCard.vue', () => ({ default: stubMetaTemplateCard() }))

vi.mock('../src/multitable/components/MetaToast.vue', () => ({
  default: defineComponent({
    name: 'MetaToast',
    setup(_, { expose }) {
      expose({
        showError: vi.fn(),
        showSuccess: vi.fn(),
      })
      return () => h('div', { 'data-toast': 'true' })
    },
  }),
}))

import MultitableWorkbench from '../src/multitable/views/MultitableWorkbench.vue'

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
    // A second GRID-typed view (not e.g. gallery) so switching to it still renders MetaGridTable —
    // this spec is about the dashboard-exit wiring, not the per-view-type render chain.
    { id: 'view_grid_2', sheetId: 'sheet_orders', name: 'Grid 2', type: 'grid' },
  ])

  return {
    client: {
      listBases: vi.fn().mockResolvedValue({
        bases: [{ id: 'base_ops', name: 'Ops Base' }, { id: 'base_finance', name: 'Finance Base' }],
      }),
      updateView: vi.fn(),
      loadFormContext: vi.fn(),
      getRecord: vi.fn(),
      createSheet: vi.fn().mockResolvedValue({ sheet: { id: 'sheet_new', baseId: 'base_ops', name: 'New Sheet' } }),
      deleteSheet: vi.fn().mockResolvedValue(undefined),
      createBase: vi.fn(),
      createField: vi.fn(),
      preparePersonField: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
      createView: vi.fn().mockResolvedValue({ view: { id: 'view_new', sheetId: 'sheet_orders', name: 'New View', type: 'grid' } }),
      // S3 (2026-09-25 review): actually removes the view, the same shape as the real server call, so
      // the loadSheetMeta mock below can faithfully reproduce the bug this fixes (activeViewId already
      // reset to the fallback by the time onDeleteView's OWN check used to run).
      deleteView: vi.fn(async (viewId: string) => { views.value = views.value.filter((view) => view.id !== viewId) }),
      // S4 (2026-09-25 review): onInstallTemplate/loadTemplateLibrary.
      listTemplates: vi.fn().mockResolvedValue({ templates: [{ id: 'tpl_1', name: 'Tpl', sheets: [], fields: [], views: [] }] }),
      installTemplate: vi.fn().mockResolvedValue({
        base: { id: 'base_tpl', name: 'Templated Base' },
        sheets: [{ id: 'sheet_tpl', baseId: 'base_tpl', name: 'Templated Sheet' }],
        views: [{ id: 'view_tpl', sheetId: 'sheet_tpl', name: 'Templated View', type: 'grid' }],
        template: { id: 'tpl_1', name: 'Tpl' },
      }),
      patchRecords: vi.fn(),
      submitForm: vi.fn(),
      renameSheet: vi.fn(),
      renameBase: vi.fn(),
    },
    sheets: ref([{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]),
    fields: ref([
      { id: 'fld_title', name: 'Title', type: 'string' },
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
      // S4 (2026-09-25 review): onDeleteSheet's own capability gate.
      canDeleteSheet: true,
    }),
    capabilityOrigin: ref(null),
    fieldPermissions: ref({}),
    viewPermissions: ref({}),
    activeView: computed(() => views.value.find((view) => view.id === activeViewId.value) ?? null),
    loading: ref(false),
    error: ref<string | null>(null),
    loadSheets: vi.fn().mockResolvedValue(true),
    loadBaseContext: vi.fn().mockResolvedValue(true),
    // S3 (2026-09-25 review): the real useMultitableWorkbench.loadSheetMeta falls activeViewId back
    // to views[0] once the requested/active view is no longer in the reloaded list — reproduce that
    // one fallback bit here (nothing else this spec needs) so onDeleteView's "was it active" check
    // sees the SAME already-moved-on activeViewId a real deleteView -> loadSheetMeta round trip would
    // leave behind.
    loadSheetMeta: vi.fn(async () => {
      if (!views.value.some((view) => view.id === activeViewId.value)) {
        activeViewId.value = views.value[0]?.id ?? ''
      }
      return true
    }),
    switchBase: vi.fn(async (baseId: string) => { activeBaseId.value = baseId; return true }),
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

describe('MultitableWorkbench dashboard exit (A2)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  // S4 (2026-09-25 review): the public surface `defineExpose`s — including requestExternalContextSync,
  // the external-context-sync entry point reached from the props watcher and the embed's postMessage
  // handler — captured off a template ref so the test can call it directly, the same way an embed host
  // (or the watcher) would through this exact function.
  let workbenchInstance: { requestExternalContextSync: (...args: any[]) => Promise<unknown> } | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    container = document.createElement('div')
    document.body.appendChild(container)
    workbenchInstance = null
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    workbenchInstance = null
    vi.clearAllMocks()
  })

  function mountWorkbench(): HTMLDivElement {
    const Host = defineComponent({
      setup() {
        return () => h(MultitableWorkbench as Component, {
          ref: (el: any) => { workbenchInstance = el },
        })
      },
    })
    app = createApp(Host)
    app.mount(container!)
    return container!
  }

  function toggleButton(root: HTMLDivElement): HTMLButtonElement {
    const button = root.querySelector<HTMLButtonElement>('[data-action="toggle-dashboard"]')
    expect(button).toBeTruthy()
    return button!
  }

  function isDashboardShown(root: HTMLDivElement): boolean {
    return !!root.querySelector('[data-stub-MetaDashboardView]')
  }

  function isGridShown(root: HTMLDivElement): boolean {
    return !!root.querySelector('[data-stub-MetaGridTable]')
  }

  it('toggling the button opens the dashboard', async () => {
    const root = mountWorkbench()
    await flushUi()
    expect(isDashboardShown(root)).toBe(false)

    const button = toggleButton(root)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    button.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(true)
    expect(isGridShown(root)).toBe(false)
    expect(toggleButton(root).getAttribute('aria-pressed')).toBe('true')
    expect(toggleButton(root).classList.contains('mt-workbench__mgr-btn--active')).toBe(true)
  })

  it('selecting a DIFFERENT view returns to the grid', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-select-view-other"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
    expect(workbenchMock.selectView).toHaveBeenCalledWith('view_grid_2')
  })

  it('re-selecting the ALREADY-active view returns to the grid instead of doing nothing', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)
    expect(workbenchMock.activeViewId.value).toBe('view_grid')

    root.querySelector<HTMLButtonElement>('[data-testid="stub-select-view-same"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
    // The early-return branch never calls workbench.selectView — it is already the active view.
    expect(workbenchMock.selectView).not.toHaveBeenCalled()
  })

  it('switching to a different base returns to the grid', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-select-base-other"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(workbenchMock.switchBase).toHaveBeenCalledWith('base_finance')
  })

  it("the dashboard's own close control returns to the grid", async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-dashboard-close"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
  })

  // S2 (2026-09-25 review): the rail's OTHER navigation emit.
  it('selecting the same sheet from the rail returns to the grid', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-select-sheet-same"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
    // The early-return branch never calls workbench.selectSheet — it is already the active sheet.
    expect(workbenchMock.selectSheet).not.toHaveBeenCalled()
  })

  // S2 (2026-09-25 review): the notification bell's same-sheet locate — its own exitDashboard call
  // (A2), separate from the delegated-to-onSelectSheet different-sheet branch.
  it("the notification bell's same-sheet locate returns to the grid", async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-notification-navigate-same-sheet"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
    expect(workbenchMock.selectSheet).not.toHaveBeenCalled()
  })

  // S2 (2026-09-25 review): create view (onCreateView already called exitDashboard() before this
  // review round — this pins that it is actually wired up and reachable end to end).
  it('creating a view returns to the grid', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-create-view"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
    expect(workbenchMock.client.createView).toHaveBeenCalledWith(
      expect.objectContaining({ sheetId: 'sheet_orders', name: 'New View', type: 'grid' }),
    )
    expect(workbenchMock.selectView).toHaveBeenCalledWith('view_new')
  })

  // S3 (2026-09-25 review): onDeleteView's exit never ran on success — loadSheetMeta resets
  // activeViewId (to the fallback view) BEFORE onDeleteView's own "was it active" check, so that
  // check always read the fallback, never the deleted view's id. The mock's loadSheetMeta reproduces
  // exactly that fallback so this test would have failed before the wasActive capture.
  it('deleting the active view returns to the grid (S3)', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)
    expect(workbenchMock.activeViewId.value).toBe('view_grid')

    root.querySelector<HTMLButtonElement>('[data-testid="stub-delete-view-active"]')!.click()
    await flushUi()

    expect(workbenchMock.client.deleteView).toHaveBeenCalledWith('view_grid')
    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
    // The fallback loadSheetMeta leaves behind — the only view left is view_grid_2.
    expect(workbenchMock.activeViewId.value).toBe('view_grid_2')
  })

  // S4 (2026-09-25 review): create sheet.
  it('creating a sheet returns to the grid', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-create-sheet"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
    expect(workbenchMock.client.createSheet).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Sheet' }))
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledWith(expect.objectContaining({ sheetId: 'sheet_new' }))
  })

  // S4 (2026-09-25 review): delete the active sheet.
  it('deleting the active sheet returns to the grid', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      root.querySelector<HTMLButtonElement>('[data-testid="stub-delete-sheet-active"]')!.click()
      await flushUi()
    } finally {
      confirmSpy.mockRestore()
    }

    expect(workbenchMock.client.deleteSheet).toHaveBeenCalledWith('sheet_orders')
    expect(workbenchMock.loadBaseContext).toHaveBeenCalledWith('base_ops')
    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
  })

  // S4 (2026-09-25 review): install a template.
  it('installing a template returns to the grid', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-action="open-template-library"]')!.click()
    await flushUi()
    const installBtn = root.querySelector<HTMLButtonElement>('[data-testid="stub-install-template-tpl_1"]')
    expect(installBtn).toBeTruthy()
    installBtn!.click()
    await flushUi()

    expect(workbenchMock.client.installTemplate).toHaveBeenCalledWith('tpl_1')
    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
  })

  // S4 (2026-09-25 review): the external-context sync path, reached from the baseId/sheetId/viewId
  // props watcher and the embed's postMessage handler alike — both call this exact exposed function.
  // Calling it directly here is the same entry point either caller uses.
  it('an external context sync that switches context returns to the grid', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)
    expect(workbenchInstance).toBeTruthy()

    const result: any = await workbenchInstance!.requestExternalContextSync({
      baseId: 'base_ops',
      sheetId: 'sheet_orders',
      viewId: 'view_grid_2',
    })
    await flushUi()

    expect(result.status).toBe('applied')
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledWith(
      expect.objectContaining({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid_2' }),
    )
    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
  })

  // S4 (2026-09-25 review): the same-sheet branch of onHistoryOpenRecord — skips onSelectSheet (and
  // its own exitDashboard call) entirely, the same gap onNotificationNavigate's same-sheet case had.
  it('opening a same-sheet history record returns to the grid', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-history-open-record-same-sheet"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
    expect(workbenchMock.selectSheet).not.toHaveBeenCalled()
  })

  // N1 (2026-09-25 review): exitDashboard() used to run BEFORE confirmDiscardContextChanges(), so a
  // user who declined the discard-unsaved-changes prompt still lost the dashboard even though nothing
  // switched. Force hasUnsavedWorkbenchDrafts true (the field manager's dirty flag) and decline the
  // confirm — the dashboard must stay exactly as it was.
  it('a cancelled context switch (declined discard-changes confirm) leaves the dashboard open', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-field-manager-mark-dirty"]')!.click()
    await flushUi()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      root.querySelector<HTMLButtonElement>('[data-testid="stub-select-view-other"]')!.click()
      await flushUi()
      expect(confirmSpy).toHaveBeenCalled()
    } finally {
      confirmSpy.mockRestore()
    }

    // The switch was cancelled — it never happened — so the dashboard must still be showing, not the
    // grid, and the view must not have switched either.
    expect(workbenchMock.selectView).not.toHaveBeenCalled()
    expect(isDashboardShown(root)).toBe(true)
    expect(isGridShown(root)).toBe(false)
  })
})
