import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

// A11 (customer feedback 2026-09-24 #7c) wire-drift lock. The AI surfaces hide behind component
// props (MetaFieldManager/MetaRecordInspector `aiAvailable`) and the grid's existing host opt-in
// (`aiRunEnabled` → MetaCellEditor's AI-run button). Component specs prove each prop hides its
// surface; only THIS spec proves the workbench actually feeds them from
// GET /api/multitable/ai/availability — a component test stays green even if the workbench never
// asks, or asks and wires the answer nowhere (the "guard not wired" failure class).
//
// Harness: the same capture-stub pattern as multitable-workbench-drawer-button-wiring.spec.ts.

let capturedGridAttrs: Record<string, unknown> | null = null
let capturedInspectorAttrs: Record<string, unknown> | null = null
let capturedFieldManagerAttrs: Record<string, unknown> | null = null

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined), resolve: vi.fn(() => ({ href: '/x' })) }),
  }
})

function stubComponent(name: string) {
  return defineComponent({ name, render() { return h('div', { [`data-stub-${name}`]: 'true' }) } })
}

function captureStub(name: string, sink: (attrs: Record<string, unknown>) => void) {
  return defineComponent({
    name,
    inheritAttrs: false,
    setup(_props, { attrs }) {
      sink(attrs as Record<string, unknown>)
      return () => h('div', { [`data-stub-${name}`]: 'true' })
    },
  })
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

vi.mock('../src/multitable/components/MetaSheetViewRail.vue', () => ({ default: stubComponent('MetaSheetViewRail') }))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({
  default: captureStub('MetaGridTable', (attrs) => { capturedGridAttrs = attrs }),
}))
vi.mock('../src/multitable/components/MetaRecordInspector.vue', () => ({
  default: captureStub('MetaRecordInspector', (attrs) => { capturedInspectorAttrs = attrs }),
}))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({
  default: captureStub('MetaFieldManager', (attrs) => { capturedFieldManagerAttrs = attrs }),
}))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaViewManager.vue', () => ({ default: stubComponent('MetaViewManager') }))
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
      expose({ showError: vi.fn(), showSuccess: vi.fn() })
      return () => h('div', { 'data-toast': 'true' })
    },
  }),
}))

import MultitableWorkbench from '../src/multitable/views/MultitableWorkbench.vue'

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) { await Promise.resolve(); await nextTick() }
}

function createWorkbenchMock(aiAvailability: unknown) {
  const activeBaseId = ref('base_ops')
  const activeSheetId = ref<string | null>('sheet_orders')
  const activeViewId = ref('view_grid')
  const views = ref([{ id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' }])
  const client: Record<string, unknown> = {
    listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_ops', name: 'Ops Base' }] }),
    loadContext: vi.fn().mockResolvedValue({ base: { id: 'base_ops' }, sheet: null, sheets: [], views: [], capabilities: {} }),
    loadFormContext: vi.fn(), getRecord: vi.fn(), createSheet: vi.fn(), createBase: vi.fn(),
    createField: vi.fn(), preparePersonField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn(),
    createView: vi.fn(), deleteView: vi.fn(), patchRecords: vi.fn(), submitForm: vi.fn(), updateView: vi.fn(),
    runButton: vi.fn(), listTemplates: vi.fn().mockResolvedValue({ templates: [] }),
  }
  if (aiAvailability !== undefined) client.aiAvailability = aiAvailability
  return {
    client,
    sheets: ref([{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]),
    fields: ref([]),
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
    filterRules: ref([]), filterConjunction: ref('and'), filterGroups: ref([]), canLoadMore: ref(false), canUndo: ref(false), canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupFieldIds: ref([]), groupField: ref(null), groupFields: ref([]), hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}), linkSummaries: ref({}), personSummaries: ref({}), attachmentSummaries: ref({}),
    fieldPermissions: ref({}), viewPermission: ref(null), rowActions: ref(null), rowActionOverrides: ref({}),
    capabilityOrigin: ref(null), conflict: ref(null), error: ref<string | null>(null), sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(), addSortRule: vi.fn(), removeSortRule: vi.fn(), addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(), removeFilterRule: vi.fn(), clearFilters: vi.fn(), applySortFilter: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), setGroupField: vi.fn(), setGroupFields: vi.fn(), goToPage: vi.fn(), patchCell: vi.fn(),
    createRecord: vi.fn(), deleteRecord: vi.fn(), duplicateRecord: vi.fn(), resolveRowActions: vi.fn(() => null),
    loadViewData: vi.fn().mockResolvedValue(true), reloadCurrentPage: vi.fn(), dismissConflict: vi.fn(),
    retryConflict: vi.fn(), setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
  }
}

/** Plain (non-event) attrs land under their kebab-case key in `attrs`. */
function attr(attrs: Record<string, unknown> | null, kebab: string, camel: string): unknown {
  expect(attrs, `${kebab} host was not rendered`).not.toBeNull()
  return kebab in attrs! ? attrs![kebab] : attrs![camel]
}

function gateState() {
  return {
    cellEditorAiRun: attr(capturedGridAttrs, 'ai-run-enabled', 'aiRunEnabled'),
    drawerAiButtons: attr(capturedInspectorAttrs, 'ai-available', 'aiAvailable'),
    fieldManagerAi: attr(capturedFieldManagerAttrs, 'ai-available', 'aiAvailable'),
  }
}

describe('MultitableWorkbench AI availability wiring (A11)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    gridMock = createGridMock()
    capturedGridAttrs = null
    capturedInspectorAttrs = null
    capturedFieldManagerAttrs = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null; container = null
    vi.clearAllMocks()
  })

  async function mountWorkbench(): Promise<void> {
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
  }

  it('server says available → every AI host receives true; asked exactly once', async () => {
    const aiAvailability = vi.fn().mockResolvedValue({ available: true })
    workbenchMock = createWorkbenchMock(aiAvailability)
    await mountWorkbench()

    expect(aiAvailability).toHaveBeenCalledTimes(1)
    expect(gateState()).toEqual({ cellEditorAiRun: true, drawerAiButtons: true, fieldManagerAi: true })
  })

  it('server says unavailable → every AI host receives false', async () => {
    const aiAvailability = vi.fn().mockResolvedValue({ available: false })
    workbenchMock = createWorkbenchMock(aiAvailability)
    await mountWorkbench()

    expect(aiAvailability).toHaveBeenCalledTimes(1)
    expect(gateState()).toEqual({ cellEditorAiRun: false, drawerAiButtons: false, fieldManagerAi: false })
  })

  it('availability call fails (old backend 404) → false everywhere (fail-closed)', async () => {
    const aiAvailability = vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }))
    workbenchMock = createWorkbenchMock(aiAvailability)
    await mountWorkbench()

    expect(aiAvailability).toHaveBeenCalledTimes(1)
    expect(gateState()).toEqual({ cellEditorAiRun: false, drawerAiButtons: false, fieldManagerAi: false })
  })

  it('client without the method → false everywhere, and the workbench still mounts', async () => {
    workbenchMock = createWorkbenchMock(undefined)
    await mountWorkbench()

    expect(gateState()).toEqual({ cellEditorAiRun: false, drawerAiButtons: false, fieldManagerAi: false })
  })

  it('before the answer lands the hosts already get false (no flash of AI buttons)', async () => {
    let resolveAnswer: (value: unknown) => void = () => undefined
    const aiAvailability = vi.fn(() => new Promise((resolve) => { resolveAnswer = resolve }))
    workbenchMock = createWorkbenchMock(aiAvailability)
    await mountWorkbench()

    expect(gateState()).toEqual({ cellEditorAiRun: false, drawerAiButtons: false, fieldManagerAi: false })
    resolveAnswer({ available: true })
    await flushUi()
    expect(gateState()).toEqual({ cellEditorAiRun: true, drawerAiButtons: true, fieldManagerAi: true })
  })
})
