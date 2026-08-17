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

// ---------------------------------------------------------------------------
// UI-7 (approval-parity-master-design-lock-20260817.md §4 UI-7) — desktop master-detail pane.
//
// §4 UI-7 scope: "desktop master-detail and optionally authoritative node-arrival aging"; the
// aging option is explicitly SKIPPED per §P5 ("do not relabel instance creation time" — no
// server-authoritative node-arrival timestamp exists). EXCLUDED from this slice (already shipped,
// must not regress or rebuild): up-to-three-field summary, batch reject, create-time aging, failure
// retry — none of those are touched here; their own specs (approval-center.spec.ts,
// approvalCenterRemindBadge/UnreadBadge/SourceFilter.spec.ts, approvalMobileResponsive.spec.ts) run
// UNMODIFIED and are asserted green separately.
//
// This spec proves:
//   - the pane renders ONLY at wide desktop widths (>= 1440px); every narrower/default width keeps
//     today's row-click-navigates behavior byte-for-byte (negative control: router push still fires);
//   - selecting a row fires exactly ONE `getApproval` fetch; reselecting cancels/replaces (the
//     generation-counter race guard is unit-tested standalone in
//     approval-center-detail-pane-controller.test.ts — this file proves the VIEW wires it correctly);
//   - the pane's quick actions dispatch through the EXACT SAME handlers as the row-level inline
//     actions (spy identity via the shared `inlineApprovingId` cross-row gate, and via the shared
//     row-reject dialog for 驳回) — not a second, independent action path;
//   - Esc closes the pane (but not while a reject/batch-result dialog is open), Up/Down move the
//     selection;
//   - the selection is URL-stable (`?detail=<id>`) so a fresh mount with that query restores it.
// ---------------------------------------------------------------------------

const pushSpy = vi.fn().mockResolvedValue(undefined)

const mockRoute = reactive({
  name: 'approval-list' as string | undefined,
  params: {},
  query: {} as Record<string, string>,
  path: '/approvals',
  meta: {},
})

// Faithfully mutates the reactive `mockRoute.query` (unlike a bare no-op spy) so the view's
// `route.query.detail` watcher — and the Esc/close "removes `detail` from the query" behavior — are
// exercised end-to-end, not just asserted against the call args in isolation.
const replaceSpy = vi.fn((loc: { query?: Record<string, unknown> } | undefined) => {
  if (loc && 'query' in loc) {
    mockRoute.query = { ...(loc.query ?? {}) } as Record<string, string>
  }
  return Promise.resolve(undefined)
})

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, replace: replaceSpy, back: vi.fn() }),
    useRoute: () => mockRoute,
  }
})

vi.mock('element-plus', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('element-plus').catch(() => ({}))
  return {
    ...actual,
    ElMessage: {
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
  }
})

// getApproval — the pane's single-fetch data-client call (the SAME call ApprovalDetailView uses
// via store.loadDetail). Deliberately included here (every OTHER approval-center* spec's api mock
// omits it — this file is the one that actually exercises the pane).
const dispatchActionSpy = vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue({})
const getPendingCountSpy = vi.fn().mockResolvedValue({ count: 0, unreadCount: 0 })
const markAllApprovalsReadSpy = vi.fn().mockResolvedValue({ markedCount: 0 })
const remindApprovalSpy = vi.fn().mockResolvedValue({ ok: true, data: {} })
const getTemplateSpy = vi.fn().mockResolvedValue({ formSchema: { fields: [] } })
const listTemplatesSpy = vi.fn().mockResolvedValue({ data: [], total: 0 })
const getApprovalSpy = vi.fn()

vi.mock('../src/approvals/api', () => ({
  dispatchAction: (...args: [string, unknown]) => dispatchActionSpy(...args),
  getPendingCount: (...args: unknown[]) => getPendingCountSpy(...args),
  markAllApprovalsRead: (...args: unknown[]) => markAllApprovalsReadSpy(...args),
  remindApproval: (...args: unknown[]) => remindApprovalSpy(...args),
  getTemplate: (...args: [string]) => getTemplateSpy(...args),
  listTemplates: (...args: unknown[]) => listTemplatesSpy(...args),
  getApproval: (...args: [string]) => getApprovalSpy(...args),
}))

vi.mock('../src/approvals/useApprovalCountsRealtime', () => ({
  useApprovalCountsRealtime: () => undefined,
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({ hasFeature: () => false }),
}))

const mockPendingApprovals = ref<any[]>([])
const mockMyApprovals = ref<any[]>([])
const mockCcApprovals = ref<any[]>([])
const mockCompletedApprovals = ref<any[]>([])
const mockProcessedApprovals = ref<any[]>([])
const mockLoading = ref(false)
const loadPendingSpy = vi.fn().mockResolvedValue(undefined)

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
    get error() { return null },
    error: null,
    get totalPending() { return mockPendingApprovals.value.length },
    get totalMine() { return mockMyApprovals.value.length },
    get totalCc() { return mockCcApprovals.value.length },
    get totalCompleted() { return mockCompletedApprovals.value.length },
    get totalProcessed() { return mockProcessedApprovals.value.length },
    get pendingCount() { return mockPendingApprovals.value.length },
    approvalById: () => undefined,
    loadPending: loadPendingSpy,
    loadMine: vi.fn(),
    loadCc: vi.fn(),
    loadCompleted: vi.fn(),
    loadProcessed: vi.fn().mockResolvedValue(undefined),
    loadDetail: vi.fn(),
    loadHistory: vi.fn(),
    submitApproval: vi.fn(),
    executeAction: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Element Plus stubs — same registry pattern as approval-center.spec.ts (real per-row scoped-slot
// content, real ElTable/ElTableColumn wiring) PLUS a `row-class-name` implementation (Element
// Plus's own current-row marker is internal state this stub does not reproduce, so the UI-7
// selected-row marker is asserted via this prop instead — see ApprovalCenterTable.vue's own
// `rowClassName`).
// ---------------------------------------------------------------------------
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

type ColumnRegistryEntry = { key: string; prop?: string; label?: string; defaultSlot?: Slot }
type ColumnRegistry = { columns: ColumnRegistryEntry[]; register: (entry: ColumnRegistryEntry) => void }
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
    rowClassName: [String, Function],
  },
  emits: ['row-click', 'selection-change'],
  setup(props, { slots, emit }) {
    const registry = reactive<ColumnRegistry>({
      columns: [],
      register(entry) { registry.columns.push(entry) },
    })
    provide(COLUMN_REGISTRY_KEY, registry)
    return () => {
      const columnInstances = slots.default?.() ?? []
      const rows = (props.data as any[] | undefined) ?? []
      return h('div', { 'data-el-table': 'true' }, [
        // Mirrors approval-center.spec.ts's own test-only affordance for driving the checkbox
        // selection column headlessly (the SFC's own `handlePendingSelectionChange` still applies
        // `isRowBatchSelectable`, so this stays honest about what ends up selected).
        h('button', {
          type: 'button',
          'data-testid': 'test-select-all-rows',
          onClick: () => emit('selection-change', rows),
        }, 'select-all'),
        h('div', { style: 'display:none' }, columnInstances),
        ...rows.map((row, i) => {
          const className = typeof props.rowClassName === 'function'
            ? (props.rowClassName as (ctx: { row: any; rowIndex: number }) => string)({ row, rowIndex: i })
            : undefined
          return h(
            'div',
            {
              'data-el-row': (row?.id as string | undefined) ?? String(i),
              class: className || undefined,
              key: (row?.id as string | undefined) ?? String(i),
              onClick: () => emit('row-click', row),
            },
            registry.columns.map((col) =>
              col.defaultSlot
                ? h('div', { 'data-el-cell': col.prop || col.label || col.key }, col.defaultSlot({ row }))
                : h('div', { 'data-el-cell-header': col.prop || col.label }, ''),
            ),
          )
        }),
      ])
    }
  },
})

let columnSeq = 0
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: {
    prop: String, label: String, width: [String, Number], minWidth: [String, Number],
    fixed: String, type: String, selectable: Function,
  },
  setup(props, { slots }) {
    const registry = inject<ColumnRegistry | null>(COLUMN_REGISTRY_KEY, null)
    if (registry) {
      registry.register({ key: `col-${columnSeq++}`, prop: props.prop, label: props.label, defaultSlot: slots.default })
    }
    return () => null
  },
})

// Same Teleport-based real popconfirm semantics as approval-center.spec.ts: the reference OPENS
// (never dispatches), a SEPARATE teleported 确认 button fires `confirm`.
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

const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, text: Boolean, link: Boolean, plain: Boolean, size: String, loading: Boolean, disabled: Boolean },
  emits: ['click'],
  render() {
    const isDisabled = this.disabled || this.loading
    return h('button', {
      'data-el-button': this.type || 'default',
      disabled: isDisabled,
      onClick: (e: Event) => { if (!isDisabled) this.$emit('click', e) },
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

function passthrough(name: string, tag = 'div') {
  return defineComponent({
    name,
    render() { return h(tag, { 'data-stub': name }, this.$slots.default?.()) },
  })
}

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
  render() { return h('select', { 'data-el-select': 'true' }, this.$slots.default?.()) },
})

const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: String, value: String },
  render() { return h('option', { value: this.value }, this.label) },
})

const ElDatePicker = defineComponent({
  name: 'ElDatePicker',
  props: { modelValue: { type: Array, default: null } },
  render() { return h('button', { 'data-el-date-picker': 'true' }) },
})

const ElPagination = defineComponent({
  name: 'ElPagination',
  props: { background: Boolean, layout: String, total: Number, currentPage: Number, pageSize: Number },
  emits: ['update:currentPage'],
  render() { return h('div', { 'data-el-pagination': 'true' }) },
})

const ElAlert = passthrough('ElAlert')
const ElEmpty = defineComponent({
  name: 'ElEmpty',
  props: { description: String, imageSize: Number },
  render() { return h('div', { 'data-el-empty': 'true' }, this.description) },
})
const ElBadge = passthrough('ElBadge', 'span')
const ElTooltip = passthrough('ElTooltip')
const ElIcon = passthrough('ElIcon', 'i')
const ElSkeleton = passthrough('ElSkeleton')

const stubDirective = { mounted() {}, updated() {} }

function setViewport(mode: 'narrow' | 'default' | 'wide'): void {
  window.matchMedia = ((query: string) => ({
    matches: mode === 'narrow' ? query.includes('max-width') : mode === 'wide' ? query.includes('min-width') : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function pendingRow(id: string, title: string, extra: Record<string, unknown> = {}): any {
  return {
    id,
    requestNo: `AP-${id}`,
    title,
    status: 'pending',
    requester: { name: '张三' },
    createdAt: '2026-08-10T08:00:00Z',
    updatedAt: '2026-08-10T08:00:00Z',
    currentNodeKey: 'node_manager',
    assignments: [
      { id: `asg_${id}`, type: 'user', assigneeId: 'user_9', sourceStep: 1, nodeKey: 'node_manager', isActive: true, metadata: {} },
    ],
    ...extra,
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('ApprovalCenterView — UI-7 desktop master-detail pane', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockPendingApprovals.value = []
    mockMyApprovals.value = []
    mockCcApprovals.value = []
    mockCompletedApprovals.value = []
    mockProcessedApprovals.value = []
    mockLoading.value = false
    loadPendingSpy.mockClear()
    pushSpy.mockClear()
    replaceSpy.mockClear()
    dispatchActionSpy.mockClear()
    dispatchActionSpy.mockResolvedValue({})
    getPendingCountSpy.mockClear()
    getPendingCountSpy.mockResolvedValue({ count: 0, unreadCount: 0 })
    getTemplateSpy.mockClear()
    getTemplateSpy.mockResolvedValue({ formSchema: { fields: [] } })
    listTemplatesSpy.mockClear()
    getApprovalSpy.mockClear()
    getApprovalSpy.mockReset()
    mockRoute.name = 'approval-list'
    mockRoute.query = {}
    setViewport('wide')
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
    const Host = defineComponent({ setup: () => () => h(ApprovalCenterView as any) })
    app = createApp(Host)
    app.component('ElTabs', ElTabs)
    app.component('ElTabPane', ElTabPane)
    app.component('ElTable', ElTable)
    app.component('ElTableColumn', ElTableColumn)
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
    app.component('ElBadge', ElBadge)
    app.component('ElTooltip', ElTooltip)
    app.component('ElIcon', ElIcon)
    app.component('ElSkeleton', ElSkeleton)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  function rowApproveButton(id: string): HTMLButtonElement | null {
    return container!.querySelector(`[data-testid="approval-row-approve-${id}"]`)
  }

  // -------------------------------------------------------------------------
  // Wide-only gating: negative control at narrower/default widths.
  // -------------------------------------------------------------------------
  it('DEFAULT (non-wide) desktop width: row click still navigates — no pane, router push fires exactly as before', async () => {
    setViewport('default')
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销')]
    await mountView()

    expect(container!.querySelector('[data-testid="approval-detail-pane"]')).toBeNull()
    const row = container!.querySelector('[data-el-row="apv_1"]') as HTMLElement
    expect(row).toBeTruthy()
    row.click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-detail', params: { id: 'apv_1' } })
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(getApprovalSpy).not.toHaveBeenCalled()
  })

  it('NARROW width: row click still navigates — no pane', async () => {
    setViewport('narrow')
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销')]
    await mountView()

    const row = container!.querySelector('[data-el-row="apv_1"]') as HTMLElement
    row.click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-detail', params: { id: 'apv_1' } })
    expect(container!.querySelector('[data-testid="approval-detail-pane"]')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Wide desktop: selection opens the pane, single fetch, reselect replaces.
  // -------------------------------------------------------------------------
  it('WIDE desktop: row click selects into the pane instead of navigating, and fetches the detail exactly once', async () => {
    getApprovalSpy.mockResolvedValue(pendingRow('apv_1', '出差报销'))
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销')]
    await mountView()

    const row = container!.querySelector('[data-el-row="apv_1"]') as HTMLElement
    row.click()
    await flushUi()

    expect(pushSpy).not.toHaveBeenCalled()
    expect(getApprovalSpy).toHaveBeenCalledTimes(1)
    expect(getApprovalSpy).toHaveBeenCalledWith('apv_1')
    const pane = container!.querySelector('[data-testid="approval-detail-pane"]')
    expect(pane).toBeTruthy()
    expect(pane!.textContent).toContain('出差报销')
    expect(pane!.textContent).toContain('AP-apv_1')
    // URL-stable selection.
    expect(replaceSpy).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ detail: 'apv_1' }) }))
  })

  it('reselecting a DIFFERENT row fires a second fetch and replaces the stale in-flight one', async () => {
    const d1 = deferred<any>()
    getApprovalSpy.mockReturnValueOnce(d1.promise).mockResolvedValueOnce(pendingRow('apv_2', '采购申请'))
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销'), pendingRow('apv_2', '采购申请')]
    await mountView()

    ;(container!.querySelector('[data-el-row="apv_1"]') as HTMLElement).click()
    await flushUi()
    expect(getApprovalSpy).toHaveBeenCalledTimes(1)

    // Reselect apv_2 BEFORE apv_1's fetch resolves.
    ;(container!.querySelector('[data-el-row="apv_2"]') as HTMLElement).click()
    await flushUi()
    expect(getApprovalSpy).toHaveBeenCalledTimes(2)
    expect(container!.querySelector('[data-testid="approval-detail-pane"]')?.textContent).toContain('采购申请')

    // The stale apv_1 fetch now resolves — must NOT override apv_2's already-committed pane.
    d1.resolve(pendingRow('apv_1', '出差报销'))
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-detail-pane"]')?.textContent).toContain('采购申请')
    expect(container!.querySelector('[data-testid="approval-detail-pane"]')?.textContent).not.toContain('出差报销')
  })

  it('selected-row marker class is applied to exactly the selected row (via ApprovalCenterTable`s row-class-name)', async () => {
    getApprovalSpy.mockResolvedValue(pendingRow('apv_1', '出差报销'))
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销'), pendingRow('apv_2', '采购申请')]
    await mountView()

    ;(container!.querySelector('[data-el-row="apv_1"]') as HTMLElement).click()
    await flushUi()

    expect(container!.querySelector('[data-el-row="apv_1"]')?.className).toContain('approval-center-row--selected')
    expect(container!.querySelector('[data-el-row="apv_2"]')?.className ?? '').not.toContain('approval-center-row--selected')
  })

  // -------------------------------------------------------------------------
  // Quick actions dispatch through the SAME handlers as row actions.
  // -------------------------------------------------------------------------
  it('pane 通过 dispatches dispatchAction through the SAME shared gate the row buttons use (cross-row disable proves shared handler, not a bypass)', async () => {
    getApprovalSpy.mockResolvedValue(pendingRow('apv_1', '出差报销'))
    const d = deferred<unknown>()
    dispatchActionSpy.mockReturnValueOnce(d.promise)
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销'), pendingRow('apv_2', '采购申请')]
    await mountView()

    ;(container!.querySelector('[data-el-row="apv_1"]') as HTMLElement).click()
    await flushUi()

    // Row apv_2's own approve button must be enabled before anything is in flight.
    expect(rowApproveButton('apv_2')?.disabled).toBe(false)

    const paneApprove = container!.querySelector('[data-testid="approval-detail-pane-approve"]') as HTMLButtonElement
    expect(paneApprove).toBeTruthy()
    // The row-level 通过 popconfirm for apv_1 (same title text — "确认通过「出差报销」？" — since the
    // pane is displaying that SAME row) is ALSO teleported to document.body and already present at
    // this point, so a bare `querySelector` would silently grab the ROW's confirm button instead of
    // the pane's, defeating this test's whole premise. The pane's popconfirm mounts strictly AFTER
    // the row's (it only exists once the pane opens), so it is teleported LATER — take the LAST
    // matching node, not the first.
    const paneConfirmCandidates = document.querySelectorAll('[data-el-popconfirm-confirm="确认通过「出差报销」？"]')
    expect(paneConfirmCandidates.length).toBe(2)
    const paneConfirm = paneConfirmCandidates[paneConfirmCandidates.length - 1] as HTMLButtonElement
    paneConfirm.click()
    await flushUi()

    expect(dispatchActionSpy).toHaveBeenCalledWith('apv_1', { action: 'approve' })
    // The MUTATION-DISCRIMINATING assertion: a bypass that called dispatchAction directly instead
    // of routing through handleInlineApprove would never flip `inlineApprovingId`, so row apv_2's
    // OWN button would stay enabled here. Going through the shared handler disables every row.
    expect(rowApproveButton('apv_2')?.disabled).toBe(true)

    d.resolve({})
    await flushUi()
    expect(rowApproveButton('apv_2')?.disabled).toBe(false)
  })

  it('pane 驳回 opens the SAME row-reject dialog the row-level 驳回 action uses (not a second dialog)', async () => {
    getApprovalSpy.mockResolvedValue(pendingRow('apv_1', '出差报销'))
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销')]
    await mountView()

    ;(container!.querySelector('[data-el-row="apv_1"]') as HTMLElement).click()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-row-reject-dialog"]')).toBeNull()
    const paneReject = container!.querySelector('[data-testid="approval-detail-pane-reject"]') as HTMLButtonElement
    expect(paneReject).toBeTruthy()
    paneReject.click()
    await flushUi()

    const dialog = container!.querySelector('[data-testid="approval-row-reject-dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toContain('出差报销')
  })

  it('打开完整详情 navigates to the exact same approval-detail route the narrow-width click uses', async () => {
    getApprovalSpy.mockResolvedValue(pendingRow('apv_1', '出差报销'))
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销')]
    await mountView()

    ;(container!.querySelector('[data-el-row="apv_1"]') as HTMLElement).click()
    await flushUi()

    const fullLink = container!.querySelector('[data-testid="approval-detail-pane-full-link"]') as HTMLButtonElement
    expect(fullLink).toBeTruthy()
    fullLink.click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-detail', params: { id: 'apv_1' } })
  })

  // -------------------------------------------------------------------------
  // Keyboard: Esc closes, Up/Down move selection, dialogs take precedence over Esc.
  // -------------------------------------------------------------------------
  it('Esc closes the pane', async () => {
    getApprovalSpy.mockResolvedValue(pendingRow('apv_1', '出差报销'))
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销')]
    await mountView()

    ;(container!.querySelector('[data-el-row="apv_1"]') as HTMLElement).click()
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-detail-pane"]')).toBeTruthy()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-detail-pane"]')).toBeNull()
    expect(replaceSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.not.objectContaining({ detail: expect.anything() }),
    }))
  })

  it('Esc does NOT close the pane while the row-reject dialog is open', async () => {
    getApprovalSpy.mockResolvedValue(pendingRow('apv_1', '出差报销'))
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销')]
    await mountView()

    ;(container!.querySelector('[data-el-row="apv_1"]') as HTMLElement).click()
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-detail-pane-reject"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-row-reject-dialog"]')).toBeTruthy()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushUi()

    // The pane must still be open — Esc was consumed by (or at least did not bypass) the dialog.
    expect(container!.querySelector('[data-testid="approval-detail-pane"]')).toBeTruthy()
  })

  it('ArrowDown moves the selection to the next row in the active tab', async () => {
    getApprovalSpy.mockImplementation((id: string) => Promise.resolve(pendingRow(id, id === 'apv_1' ? '出差报销' : '采购申请')))
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销'), pendingRow('apv_2', '采购申请')]
    await mountView()

    ;(container!.querySelector('[data-el-row="apv_1"]') as HTMLElement).click()
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-detail-pane"]')?.textContent).toContain('出差报销')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    await flushUi()

    expect(getApprovalSpy).toHaveBeenCalledWith('apv_2')
    expect(container!.querySelector('[data-testid="approval-detail-pane"]')?.textContent).toContain('采购申请')
  })

  // -------------------------------------------------------------------------
  // URL restore.
  // -------------------------------------------------------------------------
  it('a fresh mount with `?detail=<id>` in the URL restores the pane once the row loads', async () => {
    getApprovalSpy.mockResolvedValue(pendingRow('apv_1', '出差报销'))
    mockRoute.query = { detail: 'apv_1' }
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销')]
    await mountView()

    expect(container!.querySelector('[data-testid="approval-detail-pane"]')?.textContent).toContain('出差报销')
    expect(getApprovalSpy).toHaveBeenCalledWith('apv_1')
  })

  // -------------------------------------------------------------------------
  // Zero regression: row selection must NOT reload the list or wipe an in-progress batch
  // selection. This is the exact incident the narrowed `route.query` watcher fix prevents — see
  // that watcher's own comment in ApprovalCenterView.vue.
  // -------------------------------------------------------------------------
  it('selecting a row does not reload the list and does not clear a pre-existing batch selection', async () => {
    getApprovalSpy.mockResolvedValue(pendingRow('apv_1', '出差报销'))
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销'), pendingRow('apv_2', '采购申请')]
    await mountView()
    expect(loadPendingSpy).toHaveBeenCalledTimes(1)

    ;(container!.querySelector('[data-testid="test-select-all-rows"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-selection-count"]')?.textContent).toContain('已选 2 项')

    ;(container!.querySelector('[data-el-row="apv_1"]') as HTMLElement).click()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-detail-pane"]')).toBeTruthy()
    expect(loadPendingSpy).toHaveBeenCalledTimes(1)
    expect(container!.querySelector('[data-testid="approval-selection-count"]')?.textContent).toContain('已选 2 项')
  })

  // -------------------------------------------------------------------------
  // Zero regression: batch toolbar still renders and is unaffected at wide width.
  // -------------------------------------------------------------------------
  it('wide width does not affect the batch toolbar — it renders exactly as at any other desktop width', async () => {
    mockPendingApprovals.value = [pendingRow('apv_1', '出差报销')]
    await mountView()

    expect(container!.querySelector('[data-testid="approval-batch-approve"]')).toBeTruthy()
    expect(container!.querySelector('[data-testid="approval-batch-reject"]')).toBeTruthy()
    expect(container!.querySelector('[data-testid="approval-mark-all-read"]')).toBeTruthy()
  })
})
