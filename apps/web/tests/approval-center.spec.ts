import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  defineComponent,
  h,
  inject,
  nextTick,
  provide,
  reactive,
  ref,
  Teleport,
  type App as VueApp,
  type Slot,
} from 'vue'

const pushSpy = vi.fn().mockResolvedValue(undefined)

// ---------------------------------------------------------------------------
// element-plus — ElMessage spies. `ApprovalCenterView` imports `ElMessage` (a plain JS API,
// not a component — the `<el-table>`/`<el-button>` etc. tags below are resolved purely via the
// `app.component(...)` stub registrations in `mountView()`, unrelated to this mock) directly, so
// mocking the module lets B1-03's inline-approve/reject + batch-manifest tests assert on the
// exact toast copy without rendering real Element Plus notifications into `document.body`.
// ---------------------------------------------------------------------------
const elSuccessSpy = vi.fn()
const elWarningSpy = vi.fn()
const elErrorSpy = vi.fn()

vi.mock('element-plus', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('element-plus').catch(() => ({}))
  return {
    ...actual,
    ElMessage: {
      success: elSuccessSpy,
      warning: elWarningSpy,
      error: elErrorSpy,
      info: vi.fn(),
    },
  }
})

// ---------------------------------------------------------------------------
// approvals/api — dispatchAction/getPendingCount/markAllApprovalsRead/remindApproval. B1-03's
// inline approve/reject and the batch failure manifest all go through `dispatchAction`
// (single-instance and, via `runApprovalBatchAction`'s `dispatch` callback, per-row in a batch),
// so this needs to be independently resolvable/rejectable per test rather than the real module's
// always-succeeds mock-mode fixture.
//
// B2-01: `getTemplate` backs the list row key-field summary (`useApprovalListFieldSummary`).
// Defaults to an empty-fields schema so any row that happens to carry a templateId in a test that
// isn't specifically about the summary still resolves harmlessly (no unhandled rejection, no
// summary rendered since there is nothing eligible in an empty `fields` array).
// ---------------------------------------------------------------------------
const dispatchActionSpy = vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue({})
const getPendingCountSpy = vi.fn().mockResolvedValue({ count: 0, unreadCount: 0 })
const markAllApprovalsReadSpy = vi.fn().mockResolvedValue({ markedCount: 0 })
const remindApprovalSpy = vi.fn().mockResolvedValue({ ok: true, data: {} })
const getTemplateSpy = vi.fn().mockResolvedValue({ formSchema: { fields: [] } })

// B3-03: the filter bar's template dropdown fetches options via listTemplates() on mount.
const listTemplatesSpy = vi.fn().mockResolvedValue({ data: [], total: 0 })

vi.mock('../src/approvals/api', () => ({
  dispatchAction: (...args: [string, unknown]) => dispatchActionSpy(...args),
  getPendingCount: (...args: unknown[]) => getPendingCountSpy(...args),
  markAllApprovalsRead: (...args: unknown[]) => markAllApprovalsReadSpy(...args),
  remindApproval: (...args: unknown[]) => remindApprovalSpy(...args),
  getTemplate: (...args: [string]) => getTemplateSpy(...args),
  listTemplates: (...args: unknown[]) => listTemplatesSpy(...args),
}))

// B3-03: REACTIVE so a deep-link test can set `?templateId=...&createdFrom=...&createdTo=...`
// BEFORE mounting (mirrors landing here from an ApprovalMetricsView 看板钻取 link) AND mutate it
// AFTER mounting (mirrors a params-only navigation reusing the mounted instance — the view's
// `watch(() => route.query, ...)` must observe the change). `name` matches the real
// `approval-list` route because the view's watcher is route-name-guarded. Every other existing
// test leaves the query at its default {} from beforeEach, unchanged.
const mockRoute = reactive({
  name: 'approval-list' as string | undefined,
  params: {},
  query: {} as Record<string, string>,
  path: '/approvals',
  meta: {},
})

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({
      push: pushSpy,
      back: vi.fn(),
    }),
    useRoute: () => mockRoute,
  }
})

// Mock the approval store
const mockPendingApprovals = ref<any[]>([])
const mockMyApprovals = ref<any[]>([])
const mockCcApprovals = ref<any[]>([])
const mockCompletedApprovals = ref<any[]>([])
// B3-01 (我已处理 5th tab)
const mockProcessedApprovals = ref<any[]>([])
const mockLoading = ref(false)
const mockError = ref<string | null>(null)
const loadPendingSpy = vi.fn().mockResolvedValue(undefined)
const loadMineSpy = vi.fn().mockResolvedValue(undefined)
const loadCcSpy = vi.fn().mockResolvedValue(undefined)
const loadCompletedSpy = vi.fn().mockResolvedValue(undefined)
const loadProcessedSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get approvals() { return [] },
    get pendingApprovals() { return mockPendingApprovals.value },
    get myApprovals() { return mockMyApprovals.value },
    get ccApprovals() { return mockCcApprovals.value },
    get completedApprovals() { return mockCompletedApprovals.value },
    get processedApprovals() { return mockProcessedApprovals.value },
    get activeApproval() { return null },
    get history() { return [] },
    get loading() { return mockLoading.value },
    get error() { return mockError.value },
    get totalPending() { return mockPendingApprovals.value.length },
    get totalMine() { return mockMyApprovals.value.length },
    get totalCc() { return mockCcApprovals.value.length },
    get totalCompleted() { return mockCompletedApprovals.value.length },
    get totalProcessed() { return mockProcessedApprovals.value.length },
    get pendingCount() { return mockPendingApprovals.value.length },
    approvalById: () => undefined,
    loadPending: loadPendingSpy,
    loadMine: loadMineSpy,
    loadCc: loadCcSpy,
    loadCompleted: loadCompletedSpy,
    loadProcessed: loadProcessedSpy,
    loadDetail: vi.fn(),
    loadHistory: vi.fn(),
    submitApproval: vi.fn(),
    executeAction: vi.fn(),
  }),
}))

// Stub Element Plus components
const ElTabs = defineComponent({
  name: 'ElTabs',
  props: { modelValue: String },
  emits: ['update:modelValue', 'tab-change'],
  render() {
    return h('div', { 'data-el-tabs': this.modelValue }, this.$slots.default?.())
  },
})

const ElTabPane = defineComponent({
  name: 'ElTabPane',
  props: { label: String, name: String },
  render() {
    return h('div', { 'data-tab-pane': this.name, 'data-tab-label': this.label }, [
      this.$slots.label?.(),
      this.$slots.default?.(),
    ])
  },
})

// B1-03 needs to actually exercise per-row scoped-slot content (inline approve/reject buttons,
// the 已等待 cell) rather than just count table/column placeholders, so ElTable/ElTableColumn
// upgrade to the same registry pattern as `approvalTemplateCenterCategory.spec.ts`:
// ElTableColumn children register their `#default="{ row }"` slot into a shared registry via
// provide/inject; ElTable then walks `data` × registry to emit real per-row markup. The
// `test-select-all-rows` trigger (B1-04) and the `data-el-table` marker are both preserved.
type ColumnRegistryEntry = {
  key: string
  prop?: string
  label?: string
  defaultSlot?: Slot
}
type ColumnRegistry = {
  columns: ColumnRegistryEntry[]
  register: (entry: ColumnRegistryEntry) => void
}
const COLUMN_REGISTRY_KEY = Symbol('el-table-columns')

const ElTable = defineComponent({
  name: 'ElTable',
  props: {
    data: Array,
    loading: Boolean,
    stripe: Boolean,
    highlightCurrentRow: Boolean,
    maxHeight: [String, Number],
    rowKey: [String, Function],
  },
  emits: ['row-click', 'selection-change'],
  setup(props, { slots, emit }) {
    const registry = reactive<ColumnRegistry>({
      columns: [],
      register(entry) {
        registry.columns.push(entry)
      },
    })
    provide(COLUMN_REGISTRY_KEY, registry)
    return () => {
      // Instantiate the default slot once so each ElTableColumn child's setup() runs and
      // registers itself; rendered off-screen since the real per-row output is emitted below.
      const columnInstances = slots.default?.() ?? []
      const rows = (props.data as any[] | undefined) ?? []
      return h('div', { 'data-el-table': 'true' }, [
        // B1-04 test-only affordance: the real checkbox selection column can't be driven
        // headlessly here, so expose a direct trigger for "select every row currently bound to
        // `data`" — the SFC's own `handlePendingSelectionChange` still applies
        // `isRowBatchSelectable`, so this stays honest about what ends up selected.
        h('button', {
          type: 'button',
          'data-testid': 'test-select-all-rows',
          onClick: () => emit('selection-change', rows),
        }, 'select-all'),
        h('div', { style: 'display:none' }, columnInstances),
        ...rows.map((row, i) =>
          h(
            'div',
            {
              'data-el-row': (row?.id as string | undefined) ?? String(i),
              key: (row?.id as string | undefined) ?? String(i),
              // Bubble phase (the default): a descendant button's `.stop` (e.g. the inline
              // 通过/驳回 actions) correctly prevents this from firing, matching real
              // `@row-click` vs a row-scoped action button.
              onClick: () => emit('row-click', row),
            },
            registry.columns.map((col) =>
              col.defaultSlot
                ? h('div', { 'data-el-cell': col.prop || col.label || col.key }, col.defaultSlot({ row }))
                : h('div', { 'data-el-cell-header': col.prop || col.label }, ''),
            ),
          ),
        ),
      ])
    }
  },
})

let columnSeq = 0
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: {
    prop: String,
    label: String,
    width: [String, Number],
    minWidth: [String, Number],
    fixed: String,
    type: String,
    selectable: Function,
  },
  setup(props, { slots }) {
    const registry = inject<ColumnRegistry | null>(COLUMN_REGISTRY_KEY, null)
    if (registry) {
      registry.register({
        key: `col-${columnSeq++}`,
        prop: props.prop,
        label: props.label,
        defaultSlot: slots.default,
      })
    }
    return () => null
  },
})

// B1-03: real popconfirm semantics are two clicks — the reference OPENS the popup (real
// Element Plus never dispatches anything on that click alone), and a SEPARATE 确认 button
// INSIDE the popup (which Element Plus renders in a teleported popper, OUTSIDE the reference's
// DOM subtree) actually emits `confirm`. Teleporting this test-only confirm trigger to
// `document.body` reproduces that structural guarantee — a click on it can never bubble to an
// ancestor row's `@row-click`, by construction, regardless of the reference's own `.stop` or any
// re-render timing. (An earlier `onClickCapture`-on-a-wrapping-span design tried to fake this via
// event-PHASE ordering instead of DOM structure; it raced against Vue's re-render scheduling —
// intermittently failing only when run alongside other spec files — so it was replaced with this
// unconditionally-robust Teleport.)
const ElPopconfirm = defineComponent({
  name: 'ElPopconfirm',
  props: { title: String, confirmButtonText: String, cancelButtonText: String },
  emits: ['confirm', 'cancel'],
  render() {
    return h('span', { 'data-el-popconfirm': this.title ?? '' }, [
      this.$slots.reference?.(),
      h(Teleport, { to: 'body' }, [
        h('button', {
          type: 'button',
          'data-el-popconfirm-confirm': this.title ?? '',
          onClick: () => this.$emit('confirm'),
        }, '确认'),
      ]),
    ])
  },
})

const ElTag = defineComponent({
  name: 'ElTag',
  props: { type: String, size: String },
  render() {
    return h('span', { 'data-el-tag': this.type, class: `el-tag--${this.type}` }, this.$slots.default?.())
  },
})

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: String, placeholder: String, clearable: Boolean, type: String, rows: Number },
  emits: ['update:modelValue', 'clear'],
  render() {
    return h('input', {
      'data-el-input': 'true',
      value: this.modelValue ?? '',
      onInput: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLInputElement).value),
    })
  },
})

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Array], placeholder: String, clearable: Boolean, multiple: Boolean, filterable: Boolean },
  emits: ['update:modelValue', 'change'],
  render() {
    // B3-03: a native `change` drives v-model + @change (like the real component) so tests can
    // exercise the filter bar's own reload path, not just deep-link prefill.
    return h('select', {
      'data-el-select': 'true',
      onChange: (e: Event) => {
        const value = (e.target as HTMLSelectElement).value
        this.$emit('update:modelValue', value)
        this.$emit('change', value)
      },
    }, this.$slots.default?.())
  },
})

// B3-03: interactive stand-in for the created-range picker (same pattern as
// approvalMetricsView.spec.ts's set-date-range stub) — clicking commits a fixed
// YYYY-MM-DD day-boundary range through v-model + @change.
const ElDatePicker = defineComponent({
  name: 'ElDatePicker',
  props: { modelValue: { type: Array, default: null } },
  emits: ['update:modelValue', 'change'],
  render() {
    return h('button', {
      onClick: () => {
        const range = ['2026-05-01', '2026-06-30']
        this.$emit('update:modelValue', range)
        this.$emit('change', range)
      },
    }, 'created-range')
  },
})

const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: String, value: String },
  render() {
    return h('option', { value: this.value }, this.label)
  },
})

const ElPagination = defineComponent({
  name: 'ElPagination',
  props: { background: Boolean, layout: String, total: Number, currentPage: Number, pageSize: Number },
  emits: ['update:currentPage'],
  render() {
    return h('div', { 'data-el-pagination': 'true' })
  },
})

const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, text: Boolean, link: Boolean, plain: Boolean, size: String, loading: Boolean, disabled: Boolean },
  emits: ['click'],
  render() {
    // B1-04: reflect `disabled`/`loading` on the native button (matches real el-button, which
    // also treats `loading` as disabled) so the batch-reject pre-flight is actually testable — a
    // disabled button must not fire its click handler.
    const isDisabled = this.disabled || this.loading
    return h('button', {
      'data-el-button': this.type || 'default',
      disabled: isDisabled,
      onClick: (e: Event) => {
        if (isDisabled) return
        this.$emit('click', e)
      },
    }, this.$slots.default?.())
  },
})

const ElDialog = defineComponent({
  name: 'ElDialog',
  props: { modelValue: Boolean, title: String, width: String },
  emits: ['update:modelValue'],
  render() {
    if (!this.modelValue) return null
    return h('div', { 'data-el-dialog': this.title }, [this.$slots.default?.(), this.$slots.footer?.()])
  },
})

const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, type: String, showIcon: Boolean, closable: Boolean },
  render() {
    return h('div', { 'data-el-alert': this.type }, this.title)
  },
})

const ElEmpty = defineComponent({
  name: 'ElEmpty',
  props: { description: String, imageSize: Number },
  render() {
    return h('div', { 'data-el-empty': 'true' }, this.description)
  },
})

const stubDirective = { mounted() {}, updated() {} }

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('ApprovalCenterView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockPendingApprovals.value = []
    mockMyApprovals.value = []
    mockCcApprovals.value = []
    mockCompletedApprovals.value = []
    mockProcessedApprovals.value = []
    mockLoading.value = false
    mockError.value = null
    loadPendingSpy.mockClear()
    loadMineSpy.mockClear()
    loadCcSpy.mockClear()
    loadCompletedSpy.mockClear()
    loadProcessedSpy.mockClear()
    pushSpy.mockClear()

    elSuccessSpy.mockClear()
    elWarningSpy.mockClear()
    elErrorSpy.mockClear()
    dispatchActionSpy.mockClear()
    dispatchActionSpy.mockResolvedValue({})
    getPendingCountSpy.mockClear()
    getPendingCountSpy.mockResolvedValue({ count: 0, unreadCount: 0 })
    markAllApprovalsReadSpy.mockClear()
    markAllApprovalsReadSpy.mockResolvedValue({ markedCount: 0 })
    remindApprovalSpy.mockClear()
    remindApprovalSpy.mockResolvedValue({ ok: true, data: {} })
    getTemplateSpy.mockClear()
    getTemplateSpy.mockResolvedValue({ formSchema: { fields: [] } })
    listTemplatesSpy.mockClear()
    listTemplatesSpy.mockResolvedValue({ data: [], total: 0 })
    mockRoute.name = 'approval-list'
    mockRoute.query = {}

    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mountView() {
    const { default: ApprovalCenterView } = await import('../src/views/approval/ApprovalCenterView.vue')
    const Host = defineComponent({
      setup() {
        return () => h(ApprovalCenterView as any)
      },
    })
    app = createApp(Host)
    app.component('ElTabs', ElTabs)
    app.component('ElTabPane', ElTabPane)
    app.component('ElTable', ElTable)
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElTag', ElTag)
    app.component('ElInput', ElInput)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.component('ElDatePicker', ElDatePicker)
    app.component('ElPagination', ElPagination)
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
    app.component('ElDialog', ElDialog)
    app.component('ElEmpty', ElEmpty)
    app.component('ElPopconfirm', ElPopconfirm)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  it('renders 5 tabs (B3-01 adds 我已处理)', async () => {
    await mountView()
    const panes = container!.querySelectorAll('[data-tab-pane]')
    expect(panes.length).toBe(5)

    const labels = Array.from(panes).map((p) => p.getAttribute('data-tab-label'))
    expect(labels).toContain('我发起的')
    expect(labels).toContain('抄送我的')
    expect(labels).toContain('已完成')
    expect(labels).toContain('我已处理')
    expect(container!.textContent).toContain('待我处理')
  })

  it('calls loadPending on mount', async () => {
    await mountView()
    expect(loadPendingSpy).toHaveBeenCalled()
  })

  it('B3-01: renders 我已处理 rows from store.processedApprovals and calls loadPending on mount (loadProcessed only fires once that tab is active)', async () => {
    mockProcessedApprovals.value = [
      {
        id: 'apv_processed_1',
        requestNo: 'AP-200001',
        title: '已处理的审批',
        status: 'approved',
        requester: { name: '李四' },
        createdAt: '2026-04-01T00:00:00Z',
      },
    ]
    await mountView()

    const processedPane = container!.querySelector('[data-tab-pane="processed"]')
    expect(processedPane).not.toBeNull()
    expect(processedPane?.textContent).toContain('已处理的审批')
    expect(processedPane?.textContent).toContain('李四')
    // Default mount stays on the 待我处理 tab (unchanged default) — loadProcessed is wired into
    // the same switch-case choke point as the other three non-default tabs, none of which fire on
    // an unrelated tab's mount either.
    expect(loadPendingSpy).toHaveBeenCalled()
    expect(loadProcessedSpy).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // B3-03 (模板/时间筛选 + 看板钻取): templateId + createdFrom/createdTo — additive filter-bar
  // params, and the ApprovalMetricsView deep-link pre-fill that lands here.
  // ---------------------------------------------------------------------------
  it('B3-03: a 看板钻取 deep link (templateId + createdFrom/createdTo query) pre-fills the filter bar before the first load', async () => {
    mockRoute.query = {
      templateId: 'tpl-88',
      createdFrom: '2026-05-01T00:00:00Z',
      createdTo: '2026-06-30T23:59:59Z',
    }
    await mountView()

    expect(loadPendingSpy).toHaveBeenCalledWith(expect.objectContaining({
      templateId: 'tpl-88',
      createdFrom: '2026-05-01T00:00:00Z',
      createdTo: '2026-06-30T23:59:59Z',
    }))
  })

  it('B3-03: fetches template options for the filter dropdown on mount', async () => {
    listTemplatesSpy.mockResolvedValue({ data: [{ id: 'tpl-1', name: '采购审批' }], total: 1 })
    await mountView()
    expect(listTemplatesSpy).toHaveBeenCalledWith({ pageSize: 200 })
  })

  it('B3-03: driving the filter bar (template select + created range) reloads with the server params — same day-boundary convention as the deep link', async () => {
    listTemplatesSpy.mockResolvedValue({ data: [{ id: 'tpl-7', name: '费用报销' }], total: 1 })
    await mountView()
    expect(loadPendingSpy).toHaveBeenCalledTimes(1)

    const select = container!.querySelector<HTMLSelectElement>('[data-testid="approval-template-filter"]')
    expect(select, 'the template filter select renders').toBeTruthy()
    select!.value = 'tpl-7'
    select!.dispatchEvent(new Event('change'))
    await flushUi()

    expect(loadPendingSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      templateId: 'tpl-7',
      page: 1,
    }))

    const picker = container!.querySelector<HTMLButtonElement>('[data-testid="approval-created-range-filter"]')
    expect(picker, 'the created-range picker renders').toBeTruthy()
    picker!.click()
    await flushUi()

    // Plain YYYY-MM-DD picker days widen to the inclusive day-start/day-end ISO window the
    // server's `created_at >= / <=` predicate expects — identical to the deep-link convention.
    expect(loadPendingSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      templateId: 'tpl-7',
      createdFrom: '2026-05-01T00:00:00Z',
      createdTo: '2026-06-30T23:59:59Z',
      page: 1,
    }))
  })

  it('B3-03: a params-only navigation (query change on the mounted instance) re-syncs the filters and explicitly reloads', async () => {
    await mountView()
    expect(loadPendingSpy).toHaveBeenCalledTimes(1)
    expect(loadPendingSpy).toHaveBeenCalledWith(expect.objectContaining({
      templateId: undefined,
      createdFrom: undefined,
      createdTo: undefined,
    }))

    // The router reuses this instance for /approvals?templateId=... — only the query changes.
    mockRoute.query = {
      templateId: 'tpl-42',
      createdFrom: '2026-05-01T00:00:00Z',
      createdTo: '2026-06-30T23:59:59Z',
    }
    await flushUi()

    expect(loadPendingSpy).toHaveBeenCalledTimes(2)
    expect(loadPendingSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      templateId: 'tpl-42',
      createdFrom: '2026-05-01T00:00:00Z',
      createdTo: '2026-06-30T23:59:59Z',
      page: 1,
    }))
  })

  it('B3-03: a params-nav to the BARE list (empty query) clears previously deep-linked filters — full sync, not merge', async () => {
    mockRoute.query = {
      templateId: 'tpl-88',
      createdFrom: '2026-05-01T00:00:00Z',
      createdTo: '2026-06-30T23:59:59Z',
    }
    await mountView()
    expect(loadPendingSpy).toHaveBeenLastCalledWith(expect.objectContaining({ templateId: 'tpl-88' }))

    // e.g. clicking the 审批中心 menu entry while already on the filtered list.
    mockRoute.query = {}
    await flushUi()

    expect(loadPendingSpy).toHaveBeenCalledTimes(2)
    expect(loadPendingSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      templateId: undefined,
      createdFrom: undefined,
      createdTo: undefined,
      page: 1,
    }))
  })

  it('B3-03: the query watcher stays inert while navigating AWAY from approval-list (route-name guard)', async () => {
    await mountView()
    expect(loadPendingSpy).toHaveBeenCalledTimes(1)

    // Navigation to another route mutates the global route object BEFORE this instance unmounts.
    mockRoute.name = 'attendance'
    mockRoute.query = { section: 'attendance-overview-requests' }
    await flushUi()

    expect(loadPendingSpy).toHaveBeenCalledTimes(1)
  })

  it('renders pending approvals with status tags', async () => {
    mockPendingApprovals.value = [
      {
        id: 'apv_1',
        requestNo: 'AP-100001',
        title: '出差报销',
        status: 'pending',
        requester: { name: '张三' },
        createdAt: '2026-04-10T08:00:00Z',
        assignments: [],
      },
      {
        id: 'apv_2',
        requestNo: 'AP-100002',
        title: '采购申请',
        status: 'approved',
        requester: { name: '李四' },
        createdAt: '2026-04-09T08:00:00Z',
        assignments: [],
      },
    ]
    await mountView()
    // The table should exist in the pending tab
    const tables = container!.querySelectorAll('[data-el-table]')
    expect(tables.length).toBeGreaterThanOrEqual(1)
  })

  it('renders the header with title', async () => {
    await mountView()
    const header = container!.querySelector('.approval-center__header h1')
    expect(header?.textContent).toBe('审批中心')
  })

  it('renders search input and status filter', async () => {
    await mountView()
    expect(container!.querySelector('[data-el-input]')).toBeTruthy()
    expect(container!.querySelector('[data-el-select]')).toBeTruthy()
  })

  it('routes the attendance approval queue entry to the first pending attendance request', async () => {
    mockPendingApprovals.value = [
      {
        id: 'apv_attendance_1',
        requestNo: 'ATT-100001',
        title: '补卡申请',
        status: 'pending',
        requester: { name: '王五' },
        createdAt: '2026-06-08T08:00:00Z',
        workflowKey: 'attendance.request',
        formSnapshot: { attendanceRequestId: 'request-att-1' },
        assignments: [],
      },
    ]

    await mountView()

    const entry = container!.querySelector('[data-testid="attendance-approval-queue-entry"]')
    expect(entry?.textContent).toContain('考勤审批')
    expect(entry?.textContent).toContain('待处理考勤审批')

    const button = Array.from(container!.querySelectorAll('button')).find(candidate =>
      candidate.textContent?.includes('待处理考勤审批'),
    )
    expect(button).toBeTruthy()

    button!.click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({
      name: 'attendance',
      query: {
        section: 'attendance-overview-requests',
        requestId: 'request-att-1',
      },
    })
  })

  it('keeps the attendance approval queue entry fallback when no request id is available', async () => {
    await mountView()

    const button = Array.from(container!.querySelectorAll('button')).find(candidate =>
      candidate.textContent?.includes('待处理考勤审批'),
    )
    expect(button).toBeTruthy()

    button!.click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({
      name: 'attendance',
      query: { section: 'attendance-overview-requests' },
    })
  })

  // ---------------------------------------------------------------------------
  // B1-04 (宽恕型错误三件套 part 3) — batch reject pre-flight. List rows already carry `policy`
  // (UnifiedApprovalDTO.policy), so `ApprovalCenterView` mirrors the single-instance reject
  // dialog's conservative default: required unless EVERY selected row's policy explicitly opts
  // out with `false`.
  // ---------------------------------------------------------------------------
  function pendingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'apv_1',
      requestNo: 'AP-100001',
      title: '出差报销',
      status: 'pending',
      requester: { name: '张三' },
      createdAt: '2026-04-10T08:00:00Z',
      assignments: [],
      policy: null,
      ...overrides,
    }
  }

  function selectAllPendingRows(): void {
    const trigger = container!.querySelector('[data-testid="test-select-all-rows"]') as HTMLButtonElement
    trigger.click()
  }

  it('B1-04: batch reject confirm is disabled until a comment is entered (default/undefined policy = required)', async () => {
    mockPendingApprovals.value = [pendingRow()]
    await mountView()

    selectAllPendingRows()
    await flushUi()

    const openBtn = container!.querySelector('[data-testid="approval-batch-reject"]') as HTMLButtonElement
    expect(openBtn.disabled).toBe(false)
    openBtn.click()
    await flushUi()

    const confirmBtn = container!.querySelector('[data-testid="approval-batch-reject-confirm"]') as HTMLButtonElement
    expect(confirmBtn).toBeTruthy()
    expect(confirmBtn.disabled).toBe(true)

    const commentInput = container!.querySelector('[data-testid="approval-batch-reject-comment"]') as HTMLInputElement
    commentInput.value = '金额有误'
    commentInput.dispatchEvent(new Event('input'))
    await flushUi()

    expect(confirmBtn.disabled).toBe(false)
  })

  it('B1-04: batch reject confirm stays enabled with an empty comment when every selected row opts out', async () => {
    mockPendingApprovals.value = [
      pendingRow({ id: 'apv_1', policy: { rejectCommentRequired: false } }),
      pendingRow({ id: 'apv_2', policy: { rejectCommentRequired: false } }),
    ]
    await mountView()

    selectAllPendingRows()
    await flushUi()

    const openBtn = container!.querySelector('[data-testid="approval-batch-reject"]') as HTMLButtonElement
    openBtn.click()
    await flushUi()

    const confirmBtn = container!.querySelector('[data-testid="approval-batch-reject-confirm"]') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(false)
  })

  it('B1-04: batch reject confirm stays disabled when only SOME selected rows opt out (conservative default)', async () => {
    mockPendingApprovals.value = [
      pendingRow({ id: 'apv_1', policy: { rejectCommentRequired: false } }),
      pendingRow({ id: 'apv_2', policy: null }),
    ]
    await mountView()

    selectAllPendingRows()
    await flushUi()

    const openBtn = container!.querySelector('[data-testid="approval-batch-reject"]') as HTMLButtonElement
    openBtn.click()
    await flushUi()

    const confirmBtn = container!.querySelector('[data-testid="approval-batch-reject-confirm"]') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // B1-03 (审批中心列表热路径包) — part 1: inline approve/reject on the pending list.
  // ---------------------------------------------------------------------------
  it('B1-03: inline 通过 popconfirm-confirm dispatches exactly one approve action; row-click is not triggered', async () => {
    mockPendingApprovals.value = [pendingRow({ id: 'apv_1', title: '出差报销' })]
    await mountView()

    const approveBtn = container!.querySelector('[data-testid="approval-row-approve-apv_1"]') as HTMLButtonElement
    expect(approveBtn).toBeTruthy()
    approveBtn.click()
    await flushUi()
    // The reference only OPENS the popup in real Element Plus — `.stop` must keep the row's own
    // navigation untouched, and nothing should have dispatched yet.
    expect(pushSpy).not.toHaveBeenCalled()
    expect(dispatchActionSpy).not.toHaveBeenCalled()

    const confirmBtn = document.querySelector('[data-el-popconfirm-confirm="确认通过「出差报销」？"]') as HTMLButtonElement
    expect(confirmBtn).toBeTruthy()
    confirmBtn.click()
    await flushUi()

    expect(dispatchActionSpy).toHaveBeenCalledTimes(1)
    expect(dispatchActionSpy).toHaveBeenCalledWith('apv_1', { action: 'approve' })
    expect(elSuccessSpy).toHaveBeenCalledWith('审批已通过')
    expect(pushSpy).not.toHaveBeenCalled()

    // Sanity: the row's OWN click handler (outside any action button) still navigates — proves
    // the absence of navigation above is because of `.stop`, not a broken row-click wire.
    const rowEl = container!.querySelector('[data-el-row="apv_1"]') as HTMLElement
    rowEl.click()
    await flushUi()
    expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-detail', params: { id: 'apv_1' } })
  })

  it('B1-03: inline 通过 failure surfaces the server message as a toast (approve never opens a dialog)', async () => {
    mockPendingApprovals.value = [pendingRow({ id: 'apv_1', title: '出差报销' })]
    dispatchActionSpy.mockRejectedValueOnce(new Error('该审批已被他人处理'))
    await mountView()

    ;(container!.querySelector('[data-testid="approval-row-approve-apv_1"]') as HTMLButtonElement).click()
    await flushUi()
    ;(document.querySelector('[data-el-popconfirm-confirm="确认通过「出差报销」？"]') as HTMLButtonElement).click()
    await flushUi()

    expect(elErrorSpy).toHaveBeenCalledWith('该审批已被他人处理')
    expect(elSuccessSpy).not.toHaveBeenCalled()
  })

  it('B1-03: inline 驳回 dialog gates confirm on a required comment, then dispatches with it', async () => {
    mockPendingApprovals.value = [pendingRow({ id: 'apv_1', policy: null })]
    await mountView()

    const rejectBtn = container!.querySelector('[data-testid="approval-row-reject-apv_1"]') as HTMLButtonElement
    expect(rejectBtn).toBeTruthy()
    rejectBtn.click()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-row-reject-dialog"]')).toBeTruthy()
    const confirmBtn = container!.querySelector('[data-testid="approval-row-reject-confirm"]') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)

    const commentInput = container!.querySelector('[data-testid="approval-row-reject-comment"]') as HTMLInputElement
    commentInput.value = '材料不全'
    commentInput.dispatchEvent(new Event('input'))
    await flushUi()
    expect(confirmBtn.disabled).toBe(false)

    confirmBtn.click()
    await flushUi()

    expect(dispatchActionSpy).toHaveBeenCalledWith('apv_1', { action: 'reject', comment: '材料不全' })
    expect(elSuccessSpy).toHaveBeenCalledWith('审批已驳回')
    expect(container!.querySelector('[data-testid="approval-row-reject-dialog"]')).toBeNull()
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('B1-03: inline 驳回 confirm stays enabled with an empty comment when the row opts out, and omits the comment key', async () => {
    mockPendingApprovals.value = [pendingRow({ id: 'apv_1', policy: { rejectCommentRequired: false } })]
    await mountView()

    ;(container!.querySelector('[data-testid="approval-row-reject-apv_1"]') as HTMLButtonElement).click()
    await flushUi()

    const confirmBtn = container!.querySelector('[data-testid="approval-row-reject-confirm"]') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(false)

    confirmBtn.click()
    await flushUi()
    expect(dispatchActionSpy).toHaveBeenCalledWith('apv_1', { action: 'reject' })
  })

  it('B1-03: inline 驳回 failure keeps the dialog open and shows the server message inline (not a toast)', async () => {
    mockPendingApprovals.value = [pendingRow({ id: 'apv_1', policy: { rejectCommentRequired: false } })]
    dispatchActionSpy.mockRejectedValueOnce(new Error('该审批已被撤回'))
    await mountView()

    ;(container!.querySelector('[data-testid="approval-row-reject-apv_1"]') as HTMLButtonElement).click()
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-row-reject-confirm"]') as HTMLButtonElement).click()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-row-reject-dialog"]')).toBeTruthy()
    expect(container!.querySelector('[data-testid="approval-row-reject-error"]')?.textContent).toContain('该审批已被撤回')
    expect(elErrorSpy).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // B1-03 — part 2: 已等待 aging + progress glanceability.
  // ---------------------------------------------------------------------------
  it('B1-03: pending tab 已等待 column shows aging text, urgent severity class, and step progress', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    mockPendingApprovals.value = [
      pendingRow({ id: 'apv_1', createdAt: eightDaysAgo, currentStep: 2, totalSteps: 3 }),
    ]
    await mountView()

    const cell = container!.querySelector('[data-el-row="apv_1"] [data-el-cell="已等待"]')
    expect(cell).toBeTruthy()
    expect(cell!.textContent).toContain('8 天')
    expect(cell!.textContent).toContain('第 2/3 步')
    expect(cell!.querySelector('.approval-center__wait--urgent')).toBeTruthy()
  })

  it('B1-03: mine tab shows 已等待 next to 催办 for pending rows', async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
    mockMyApprovals.value = [pendingRow({ id: 'apv_mine_1', createdAt: fiveHoursAgo })]
    await mountView()

    const cell = container!.querySelector('[data-el-row="apv_mine_1"] [data-el-cell="操作"]')
    expect(cell).toBeTruthy()
    expect(cell!.textContent).toContain('已等待')
    expect(cell!.textContent).toContain('5 小时')
    expect(cell!.querySelector('[data-testid="approval-urge-apv_mine_1"]')).toBeTruthy()
  })

  // ---------------------------------------------------------------------------
  // B1-03 — part 3: batch failure manifest (replaces the old collapsed toast).
  // ---------------------------------------------------------------------------
  it('B1-03: a batch failure opens a manifest dialog listing failed rows; 重试失败项 re-dispatches only the failed ids', async () => {
    mockPendingApprovals.value = [
      pendingRow({ id: 'apv_a', title: 'AAA 报销', requestNo: 'AP-A' }),
      pendingRow({ id: 'apv_b', title: 'BBB 报销', requestNo: 'AP-B' }),
    ]
    dispatchActionSpy.mockImplementation((id: unknown) =>
      id === 'apv_b' ? Promise.reject(new Error('冲突：状态已变更')) : Promise.resolve({}),
    )
    await mountView()

    selectAllPendingRows()
    await flushUi()

    const approveBtn = container!.querySelector('[data-testid="approval-batch-approve"]') as HTMLButtonElement
    approveBtn.click()
    await flushUi(6)

    const dialog = container!.querySelector('[data-testid="approval-batch-result-dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toContain('AP-B')
    expect(dialog!.textContent).toContain('BBB 报销')
    expect(dialog!.textContent).toContain('冲突：状态已变更')
    // The succeeded row never shows up in the manifest.
    expect(dialog!.textContent).not.toContain('AP-A')
    expect(dispatchActionSpy).toHaveBeenCalledTimes(2)

    // The retry succeeds this time.
    dispatchActionSpy.mockImplementation(() => Promise.resolve({}))
    const retryBtn = container!.querySelector('[data-testid="approval-batch-retry"]') as HTMLButtonElement
    retryBtn.click()
    await flushUi(6)

    // Only the still-failed id (apv_b) is retried — apv_a is never re-dispatched.
    expect(dispatchActionSpy).toHaveBeenCalledTimes(3)
    expect(dispatchActionSpy).toHaveBeenNthCalledWith(3, 'apv_b', { action: 'approve' })
    // Full success on retry closes the dialog.
    expect(container!.querySelector('[data-testid="approval-batch-result-dialog"]')).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // B2-01 (待办列表关键字段摘要) — list row key-field summary line. The list DTO never carries
  // the frozen per-instance formSchema (only the detail endpoint does), so the summary is built
  // from the LIVE template schema fetched via `getTemplate` and cached per templateId.
  // ---------------------------------------------------------------------------
  describe('B2-01: list row key-field summary', () => {
    const leaveTemplateSchema = {
      fields: [
        {
          id: 'fld_leave_type',
          type: 'select',
          label: '请假类型',
          options: [{ label: '年假', value: 'annual' }, { label: '事假', value: 'personal' }],
        },
        { id: 'fld_duration', type: 'number', label: '时长' },
        { id: 'fld_reason', type: 'textarea', label: '事由' },
        { id: 'fld_attachment', type: 'attachment', label: '附件' },
      ],
    }

    it('a row whose template has fields renders the summary line with mapped labels/values', async () => {
      getTemplateSpy.mockResolvedValue({ formSchema: leaveTemplateSchema })
      mockPendingApprovals.value = [
        pendingRow({
          id: 'apv_1',
          templateId: 'tpl_leave',
          formSnapshot: {
            fld_leave_type: 'annual',
            fld_duration: 2,
            fld_reason: '家里有事',
            fld_attachment: ['file_1'],
          },
        }),
      ]
      await mountView()
      await flushUi(6)

      expect(getTemplateSpy).toHaveBeenCalledWith('tpl_leave')
      expect(getTemplateSpy).toHaveBeenCalledTimes(1)

      const cell = container!.querySelector('[data-el-row="apv_1"] [data-el-cell="标题"]')
      expect(cell).toBeTruthy()
      expect(cell!.textContent).toContain('出差报销')
      const summary = cell!.querySelector('.approval-center__row-summary')
      expect(summary).toBeTruthy()
      expect(summary!.textContent?.trim()).toBe('请假类型：年假 · 时长：2 · 事由：家里有事')
      // The attachment field is a schema field but never part of the summary.
      expect(summary!.textContent).not.toContain('附件')
    })

    it('a row without templateId renders no summary and never calls getTemplate', async () => {
      mockPendingApprovals.value = [
        pendingRow({ id: 'apv_1', templateId: null, formSnapshot: { fld_reason: '出差' } }),
      ]
      await mountView()
      await flushUi(6)

      expect(getTemplateSpy).not.toHaveBeenCalled()
      const cell = container!.querySelector('[data-el-row="apv_1"] [data-el-cell="标题"]')
      expect(cell).toBeTruthy()
      expect(cell!.textContent).toContain('出差报销')
      expect(cell!.querySelector('.approval-center__row-summary')).toBeNull()
    })

    it('a template-fetch failure leaves the row summary-less, without throwing', async () => {
      getTemplateSpy.mockRejectedValueOnce(new Error('模板不存在'))
      mockPendingApprovals.value = [
        pendingRow({ id: 'apv_1', templateId: 'tpl_missing', formSnapshot: { fld_reason: '出差' } }),
      ]
      await mountView()
      await flushUi(6)

      expect(getTemplateSpy).toHaveBeenCalledWith('tpl_missing')
      const cell = container!.querySelector('[data-el-row="apv_1"] [data-el-cell="标题"]')
      expect(cell).toBeTruthy()
      expect(cell!.textContent).toContain('出差报销')
      expect(cell!.querySelector('.approval-center__row-summary')).toBeNull()
      // Silent by design — no toast, no console-visible rejection reaching the view layer.
      expect(elErrorSpy).not.toHaveBeenCalled()
    })
  })
})
