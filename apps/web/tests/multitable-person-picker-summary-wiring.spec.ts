/**
 * #5781 follow-up — WIRE-DRIFT LOCK for the person picker's display-name source.
 *
 * Why this file exists: #5781 made GET .../person-fields/:fieldId/directory refuse a term-less call,
 * and that fetch used to be the ONLY place MetaPersonPicker learned a display name for an
 * ALREADY-ASSIGNED userId (the picker seeds `summaryById[id] = { id, display: id }` on open and
 * upgrades it from the fetched roster). With the roster gone, opening the picker on a populated
 * person cell and pressing Confirm echoed `{ id, display: <the raw userId> }` back, and
 * applyLocalPersonSummaries wrote THAT into grid.personSummaries — so the grid cell and the drawer
 * showed a raw id until the next full refetch (patchCell does not re-hydrate person summaries).
 *
 * The fix has two seams, and a component-level test cannot see either of them:
 *   1. the WORKBENCH must hand the picker the summaries it already holds for that exact cell
 *      (`:current-summaries`) — the picker spec stays green if the workbench forgets the binding,
 *      i.e. the fix would ship dead (the #1779/#1781 wire-vs-fixture trap);
 *   2. applyLocalPersonSummaries must not let a raw-id PLACEHOLDER evict a name already known.
 * So this mounts the real MultitableWorkbench.vue with the same composable scaffold proven by
 * multitable-workbench-drawer-button-wiring.spec.ts and drives the real listeners.
 *
 * Deliberately NOT tested here: hydrating ids from the server. Resolving arbitrary ids -> names would
 * hand back exactly the roster lookup #5781 bounded; the display names used here are ones the CLIENT
 * ALREADY HAS on screen, so this discloses nothing new.
 *
 * Fixtures are obviously fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

function stubComponent(name: string) {
  return defineComponent({ name, render() { return h('div', { [`data-stub-${name}`]: 'true' }) } })
}

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()

let workbenchMock: any
let gridMock: any
let capturedGridAttrs: Record<string, unknown> | null = null
let capturedPickerProps: Record<string, unknown> | null = null
let capturedPickerAttrs: Record<string, unknown> | null = null

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined), resolve: () => ({ href: '/base/multitable' }) }),
  }
})

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
// Capturing stub for the grid: the real `@open-person-picker` listener is how a cell opens the picker.
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
// Capturing stub for the component under wiring test. Props are DECLARED (not read off attrs) so the
// assertion is on the resolved prop the real picker would receive, independent of attribute casing.
vi.mock('../src/multitable/components/MetaPersonPicker.vue', () => ({
  default: defineComponent({
    name: 'MetaPersonPicker',
    inheritAttrs: false,
    props: {
      visible: { type: Boolean, default: false },
      field: { type: Object, default: null },
      sheetId: { type: String, default: '' },
      currentValue: { type: null, default: null },
      currentSummaries: { type: Array, default: undefined },
    },
    setup(props, { attrs }) {
      capturedPickerProps = props as unknown as Record<string, unknown>
      capturedPickerAttrs = attrs as Record<string, unknown>
      return () => h('div', { 'data-stub-MetaPersonPicker': 'true' })
    },
  }),
}))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
vi.mock('../src/multitable/components/MetaRecordInspector.vue', () => ({ default: stubComponent('MetaRecordInspector') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({ default: stubComponent('MetaFieldManager') }))
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
      expose({ showError: showErrorSpy, showSuccess: showSuccessSpy })
      return () => h('div', { 'data-toast': 'true' })
    },
  }),
}))

import MultitableWorkbench from '../src/multitable/views/MultitableWorkbench.vue'
import type { PersonSummary } from '../src/multitable/types'

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) { await Promise.resolve(); await nextTick() }
}

const OWNER_FIELD = { id: 'fld_owner', name: 'Owner', type: 'person', property: { limitSingleRecord: false }, order: 0 }
const REC_ID = 'rec_fake_1'
const U_KNOWN = 'u_fake_known'
const U_OTHER = 'u_fake_other'
const KNOWN_DISPLAY = 'Fake Alice'

function createWorkbenchMock() {
  const activeBaseId = ref('base_fake')
  const activeSheetId = ref<string | null>('sheet_fake')
  const activeViewId = ref('view_grid')
  const views = ref([{ id: 'view_grid', sheetId: 'sheet_fake', name: 'Grid', type: 'grid' }])
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_fake', name: 'Fake Base' }] }),
      loadContext: vi.fn().mockResolvedValue({ base: { id: 'base_fake' }, sheet: null, sheets: [], views: [], capabilities: {} }),
      loadFormContext: vi.fn(), getRecord: vi.fn(), createSheet: vi.fn(), createBase: vi.fn(),
      createField: vi.fn(), preparePersonField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn(),
      createView: vi.fn(), deleteView: vi.fn(), patchRecords: vi.fn(), submitForm: vi.fn(), updateView: vi.fn(),
      listTemplates: vi.fn().mockResolvedValue({ templates: [] }),
    },
    sheets: ref([{ id: 'sheet_fake', baseId: 'base_fake', name: 'Fake Sheet', description: null }]),
    fields: ref([OWNER_FIELD]),
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
    selectBase: vi.fn(), selectSheet: vi.fn(), selectView: vi.fn(),
  }
}

function createGridMock() {
  return {
    fields: ref([OWNER_FIELD]),
    rows: ref([{ id: REC_ID, version: 3, data: { [OWNER_FIELD.id]: [U_KNOWN] } }]),
    loading: ref(false), currentPage: ref(1), totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 1, hasMore: false }), visibleFields: ref([OWNER_FIELD]), sortRules: ref([]),
    filterRules: ref([]), filterConjunction: ref('and'), filterGroups: ref([]), canLoadMore: ref(false), canUndo: ref(false), canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupFieldIds: ref([]), groupField: ref(null), groupFields: ref([]), hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}),
    linkSummaries: ref({}),
    // The cell already displays a real name — this is the state the picker must inherit.
    personSummaries: ref<Record<string, Record<string, PersonSummary[]>>>({
      [REC_ID]: { [OWNER_FIELD.id]: [{ id: U_KNOWN, display: KNOWN_DISPLAY }] },
    }),
    attachmentSummaries: ref({}),
    fieldPermissions: ref({}), viewPermission: ref(null), rowActions: ref(null), rowActionOverrides: ref({}),
    capabilityOrigin: ref(null), conflict: ref(null), error: ref<string | null>(null), sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(), addSortRule: vi.fn(), removeSortRule: vi.fn(), addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(), removeFilterRule: vi.fn(), clearFilters: vi.fn(), applySortFilter: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), setGroupField: vi.fn(), setGroupFields: vi.fn(), goToPage: vi.fn(),
    patchCell: vi.fn().mockResolvedValue(true),
    createRecord: vi.fn(), deleteRecord: vi.fn(), duplicateRecord: vi.fn(), resolveRowActions: vi.fn(() => null),
    loadViewData: vi.fn().mockResolvedValue(true), reloadCurrentPage: vi.fn(), dismissConflict: vi.fn(),
    retryConflict: vi.fn(), setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
  }
}

type OpenPersonPickerFn = (ctx: { recordId: string; field: typeof OWNER_FIELD }) => void
type PersonConfirmFn = (payload: { userIds: string[]; summaries: PersonSummary[] }) => Promise<void>

function storedSummaries(): PersonSummary[] | undefined {
  return gridMock.personSummaries.value[REC_ID]?.[OWNER_FIELD.id]
}

describe('#5781 follow-up — person picker display-name wiring (workbench <-> picker)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capturedGridAttrs = null
    capturedPickerProps = null
    capturedPickerAttrs = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null; container = null
    showErrorSpy.mockReset(); showSuccessSpy.mockReset()
    vi.clearAllMocks()
  })

  async function mountWorkbench(): Promise<void> {
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
  }

  async function openPickerFromGrid(): Promise<void> {
    await mountWorkbench()
    expect(capturedGridAttrs).not.toBeNull()
    const openPersonPicker = capturedGridAttrs!.onOpenPersonPicker as OpenPersonPickerFn
    expect(typeof openPersonPicker).toBe('function')
    openPersonPicker({ recordId: REC_ID, field: OWNER_FIELD })
    await flushUi()
  }

  function pickerConfirm(): PersonConfirmFn {
    expect(capturedPickerAttrs).not.toBeNull()
    const onConfirm = capturedPickerAttrs!.onConfirm as PersonConfirmFn
    expect(typeof onConfirm).toBe('function')
    return onConfirm
  }

  // SEAM 1 — the workbench must hand over what it already knows.
  it('passes the cell\'s known person summaries to the picker on open (the only display source left after #5781)', async () => {
    await openPickerFromGrid()

    expect(capturedPickerProps).not.toBeNull()
    expect(capturedPickerProps!.visible).toBe(true)
    expect(capturedPickerProps!.currentValue).toEqual([U_KNOWN])
    // Without this binding the picker can only show/echo the raw userId for an already-assigned person.
    expect(capturedPickerProps!.currentSummaries).toEqual([{ id: U_KNOWN, display: KNOWN_DISPLAY }])
  })

  it('opens with an EMPTY summary list for a cell it has no cached display for (no cross-cell bleed)', async () => {
    await mountWorkbench()
    const openPersonPicker = capturedGridAttrs!.onOpenPersonPicker as OpenPersonPickerFn
    openPersonPicker({ recordId: 'rec_fake_unknown', field: OWNER_FIELD })
    await flushUi()

    expect(capturedPickerProps!.currentSummaries).toEqual([])
  })

  // SEAM 2 — a raw-id placeholder must never evict a name we already had.
  it('keeps the known display when the picker echoes back a raw-id placeholder (confirm without re-searching)', async () => {
    await openPickerFromGrid()
    // What the picker emits for an id it could not resolve: display === the id itself.
    await pickerConfirm()({ userIds: [U_KNOWN], summaries: [{ id: U_KNOWN, display: U_KNOWN }] })
    await flushUi()

    expect(gridMock.patchCell).toHaveBeenCalledWith(REC_ID, OWNER_FIELD.id, [U_KNOWN], 3)
    expect(storedSummaries()).toEqual([{ id: U_KNOWN, display: KNOWN_DISPLAY }])
  })

  it('still writes a REAL display through unchanged (the merge only rescues placeholders)', async () => {
    await openPickerFromGrid()
    await pickerConfirm()({
      userIds: [U_KNOWN, U_OTHER],
      summaries: [{ id: U_KNOWN, display: U_KNOWN }, { id: U_OTHER, display: 'Fake Bob' }],
    })
    await flushUi()

    expect(storedSummaries()).toEqual([
      { id: U_KNOWN, display: KNOWN_DISPLAY }, // rescued from the previous state
      { id: U_OTHER, display: 'Fake Bob' }, // freshly picked, carried as emitted
    ])
  })

  it('a REMOVED person is dropped from the summaries (the merge never resurrects a de-selected id)', async () => {
    await openPickerFromGrid()
    await pickerConfirm()({ userIds: [], summaries: [] })
    await flushUi()

    expect(gridMock.patchCell).toHaveBeenCalledWith(REC_ID, OWNER_FIELD.id, [], 3)
    expect(storedSummaries()).toEqual([])
  })

  it('a rename wins over the cached display (a genuinely NEW name is not held back by the old one)', async () => {
    await openPickerFromGrid()
    await pickerConfirm()({ userIds: [U_KNOWN], summaries: [{ id: U_KNOWN, display: 'Fake Alice Renamed' }] })
    await flushUi()

    expect(storedSummaries()).toEqual([{ id: U_KNOWN, display: 'Fake Alice Renamed' }])
  })
})
