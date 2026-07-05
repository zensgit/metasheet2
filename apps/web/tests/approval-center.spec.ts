import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

const pushSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({
      push: pushSpy,
      back: vi.fn(),
    }),
    useRoute: () => ({
      params: {},
      query: {},
      path: '/approvals',
      meta: {},
    }),
  }
})

// Mock the approval store
const mockPendingApprovals = ref<any[]>([])
const mockMyApprovals = ref<any[]>([])
const mockCcApprovals = ref<any[]>([])
const mockCompletedApprovals = ref<any[]>([])
const mockLoading = ref(false)
const mockError = ref<string | null>(null)
const loadPendingSpy = vi.fn().mockResolvedValue(undefined)
const loadMineSpy = vi.fn().mockResolvedValue(undefined)
const loadCcSpy = vi.fn().mockResolvedValue(undefined)
const loadCompletedSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get approvals() { return [] },
    get pendingApprovals() { return mockPendingApprovals.value },
    get myApprovals() { return mockMyApprovals.value },
    get ccApprovals() { return mockCcApprovals.value },
    get completedApprovals() { return mockCompletedApprovals.value },
    get activeApproval() { return null },
    get history() { return [] },
    get loading() { return mockLoading.value },
    get error() { return mockError.value },
    get totalPending() { return mockPendingApprovals.value.length },
    get totalMine() { return mockMyApprovals.value.length },
    get totalCc() { return mockCcApprovals.value.length },
    get totalCompleted() { return mockCompletedApprovals.value.length },
    get pendingCount() { return mockPendingApprovals.value.length },
    approvalById: () => undefined,
    loadPending: loadPendingSpy,
    loadMine: loadMineSpy,
    loadCc: loadCcSpy,
    loadCompleted: loadCompletedSpy,
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

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array, loading: Boolean, stripe: Boolean, highlightCurrentRow: Boolean },
  emits: ['row-click', 'selection-change'],
  render() {
    return h('div', { 'data-el-table': 'true' }, [
      // B1-04 test-only affordance: the real checkbox selection column can't be driven
      // headlessly here, so expose a direct trigger for "select every row currently bound to
      // `data`" — the SFC's own `handlePendingSelectionChange` still applies
      // `isRowBatchSelectable`, so this stays honest about what ends up selected.
      h('button', {
        type: 'button',
        'data-testid': 'test-select-all-rows',
        onClick: () => this.$emit('selection-change', this.data ?? []),
      }, 'select-all'),
      this.$slots.default?.(),
    ])
  },
})

const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String, width: [String, Number], minWidth: [String, Number], fixed: String },
  render() {
    // Do not invoke scoped slots — they expect { row } context from el-table
    return h('div', { 'data-column': this.prop || this.label })
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
    return h('select', { 'data-el-select': 'true' }, this.$slots.default?.())
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
    mockLoading.value = false
    mockError.value = null
    loadPendingSpy.mockClear()
    loadMineSpy.mockClear()
    loadCcSpy.mockClear()
    loadCompletedSpy.mockClear()
    pushSpy.mockClear()

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
    app.component('ElPagination', ElPagination)
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
    app.component('ElDialog', ElDialog)
    app.component('ElEmpty', ElEmpty)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  it('renders 4 tabs', async () => {
    await mountView()
    const panes = container!.querySelectorAll('[data-tab-pane]')
    expect(panes.length).toBe(4)

    const labels = Array.from(panes).map((p) => p.getAttribute('data-tab-label'))
    expect(labels).toContain('我发起的')
    expect(labels).toContain('抄送我的')
    expect(labels).toContain('已完成')
    expect(container!.textContent).toContain('待我处理')
  })

  it('calls loadPending on mount', async () => {
    await mountView()
    expect(loadPendingSpy).toHaveBeenCalled()
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
})
