/**
 * Wave 2 WP3 slice 1 — 红点 / 催办 frontend specs.
 *
 * Covers two surfaces:
 *   1. `ApprovalCenterView` renders a red badge on the 待我处理 tab with the
 *      server-provided count when > 0, and hides it when 0.
 *   2. `ApprovalDetailView` exposes a "催一下" button for the requester on a
 *      pending instance and maps the API result (200 vs 429) to a toast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

// ---------------------------------------------------------------------------
// Module-level spies — hoisted so `vi.mock` factories can pick them up
// without triggering the "cannot access X before initialization" guard.
// ---------------------------------------------------------------------------
const pushSpy = vi.fn().mockResolvedValue(undefined)
const getPendingCountSpy = vi.fn<(sourceSystem?: 'all' | 'platform' | 'plm') => Promise<{ count: number }>>()
const remindApprovalSpy = vi.fn()
const elSuccessSpy = vi.fn()
const elWarningSpy = vi.fn()
const elErrorSpy = vi.fn()

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({
      push: pushSpy,
      back: vi.fn(),
    }),
    useRoute: () => ({
      params: { id: 'apv_remind_target' },
      query: {},
      path: '/approvals',
      meta: {},
    }),
  }
})

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

vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({
    canWrite: ref(true),
    canAct: ref(true),
    canRead: ref(true),
  }),
}))

const mockPendingApprovals = ref<any[]>([])
const mockMyApprovals = ref<any[]>([])
const mockCcApprovals = ref<any[]>([])
const mockCompletedApprovals = ref<any[]>([])
const mockActiveApproval = ref<any>(null)
const mockHistory = ref<any[]>([])
const mockLoading = ref(false)
const mockError = ref<string | null>(null)

vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get approvals() { return [] },
    get pendingApprovals() { return mockPendingApprovals.value },
    get myApprovals() { return mockMyApprovals.value },
    get ccApprovals() { return mockCcApprovals.value },
    get completedApprovals() { return mockCompletedApprovals.value },
    get activeApproval() { return mockActiveApproval.value },
    get history() { return mockHistory.value },
    get loading() { return mockLoading.value },
    get error() { return mockError.value },
    set error(value: string | null) { mockError.value = value },
    get totalPending() { return mockPendingApprovals.value.length },
    get totalMine() { return mockMyApprovals.value.length },
    get totalCc() { return mockCcApprovals.value.length },
    get totalCompleted() { return mockCompletedApprovals.value.length },
    get pendingCount() { return mockPendingApprovals.value.length },
    approvalById: () => undefined,
    loadPending: vi.fn().mockResolvedValue(undefined),
    loadMine: vi.fn().mockResolvedValue(undefined),
    loadCc: vi.fn().mockResolvedValue(undefined),
    loadCompleted: vi.fn().mockResolvedValue(undefined),
    loadDetail: vi.fn().mockResolvedValue(undefined),
    loadHistory: vi.fn().mockResolvedValue(undefined),
    submitApproval: vi.fn(),
    executeAction: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    loadTemplate: vi.fn().mockResolvedValue(undefined),
    templateById: () => undefined,
  }),
}))

vi.mock('../src/approvals/api', () => ({
  getPendingCount: (sourceSystem?: 'all' | 'platform' | 'plm') => getPendingCountSpy(sourceSystem),
  remindApproval: (...args: unknown[]) => remindApprovalSpy(...args),
}))

// ---------------------------------------------------------------------------
// Element Plus component stubs (minimal reactive surface).
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
    return h(
      'div',
      { 'data-tab-pane': this.name, 'data-tab-label': this.label },
      [this.$slots.label?.(), this.$slots.default?.()].filter(Boolean),
    )
  },
})

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array, loading: Boolean, stripe: Boolean, highlightCurrentRow: Boolean },
  emits: ['row-click'],
  render() {
    return h('div', { 'data-el-table': 'true' }, this.$slots.default?.())
  },
})

const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String, width: [String, Number], minWidth: [String, Number], fixed: String },
  render() {
    return h('div', { 'data-column': this.prop || this.label })
  },
})

const ElTag = defineComponent({
  name: 'ElTag',
  props: { type: String, size: String },
  render() {
    return h('span', { 'data-el-tag': this.type }, this.$slots.default?.())
  },
})

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: String, placeholder: String, clearable: Boolean },
  emits: ['update:modelValue', 'clear'],
  render() {
    return h('input', { 'data-el-input': 'true' })
  },
})

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Array], placeholder: String, clearable: Boolean },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit, slots, attrs }) {
    return () => h(
      'select',
      {
        ...attrs,
        'data-el-select': 'true',
        value: props.modelValue as string | undefined,
        onChange: (event: Event) => {
          const value = (event.target as HTMLSelectElement).value
          emit('update:modelValue', value)
          emit('change', value)
        },
      },
      slots.default?.(),
    )
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
  props: {
    type: String,
    plain: Boolean,
    text: Boolean,
    disabled: Boolean,
    loading: Boolean,
  },
  emits: ['click'],
  render() {
    return h(
      'button',
      {
        'data-el-button': this.type || 'default',
        'data-loading': this.loading ? 'true' : 'false',
        disabled: this.disabled ? 'disabled' : undefined,
        onClick: (event: Event) => this.$emit('click', event),
      },
      this.$slots.default?.(),
    )
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

const ElBadge = defineComponent({
  name: 'ElBadge',
  props: { value: [Number, String], max: Number, isDot: Boolean },
  setup(props, { attrs, slots }) {
    return () => h(
      'sup',
      {
        ...attrs,
        'data-el-badge': 'true',
        'data-badge-value': String(props.value ?? ''),
      },
      slots.default?.() ?? String(props.value ?? ''),
    )
  },
})

const ElIcon = defineComponent({
  name: 'ElIcon',
  render() {
    return h('i', { 'data-el-icon': 'true' }, this.$slots.default?.())
  },
})

const ElPopconfirm = defineComponent({
  name: 'ElPopconfirm',
  props: { title: String, confirmButtonText: String, cancelButtonText: String },
  emits: ['confirm', 'cancel'],
  render() {
    return h('div', { 'data-el-popconfirm': 'true' }, this.$slots.reference?.())
  },
})

const ElDialog = defineComponent({
  name: 'ElDialog',
  props: { modelValue: Boolean, title: String, width: String },
  emits: ['update:modelValue'],
  render() {
    return h('div', { 'data-el-dialog': 'true' }, this.$slots.default?.())
  },
})

const ElForm = defineComponent({
  name: 'ElForm',
  render() {
    return h('form', { 'data-el-form': 'true' }, this.$slots.default?.())
  },
})

const ElFormItem = defineComponent({
  name: 'ElFormItem',
  props: { label: String },
  render() {
    return h('div', { 'data-el-form-item': 'true' }, this.$slots.default?.())
  },
})

const ElDivider = defineComponent({
  name: 'ElDivider',
  render() {
    return h('hr', { 'data-el-divider': 'true' })
  },
})

const ElTimeline = defineComponent({
  name: 'ElTimeline',
  render() {
    return h('div', { 'data-el-timeline': 'true' }, this.$slots.default?.())
  },
})

const ElTimelineItem = defineComponent({
  name: 'ElTimelineItem',
  props: { type: String, hollow: Boolean, color: String, timestamp: String },
  render() {
    return h('div', { 'data-el-timeline-item': 'true' }, this.$slots.default?.())
  },
})

const stubDirective = { mounted() {}, updated() {} }

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function registerCommonStubs(app: VueApp<Element>): void {
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
  app.component('ElEmpty', ElEmpty)
  app.component('ElBadge', ElBadge)
  app.component('ElIcon', ElIcon)
  app.component('ElPopconfirm', ElPopconfirm)
  app.component('ElDialog', ElDialog)
  app.component('ElForm', ElForm)
  app.component('ElFormItem', ElFormItem)
  app.component('ElDivider', ElDivider)
  app.component('ElTimeline', ElTimeline)
  app.component('ElTimelineItem', ElTimelineItem)
  app.directive('loading', stubDirective)
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('ApprovalCenterView 待办红点 (WP3 slice 1)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    getPendingCountSpy.mockReset()
    remindApprovalSpy.mockReset()
    pushSpy.mockClear()
    elSuccessSpy.mockClear()
    elWarningSpy.mockClear()
    elErrorSpy.mockClear()
    mockPendingApprovals.value = []
    mockMyApprovals.value = []
    mockCcApprovals.value = []
    mockCompletedApprovals.value = []
    mockLoading.value = false
    mockError.value = null

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

  async function mountCenter(pendingCount: number): Promise<void> {
    getPendingCountSpy.mockResolvedValue({ count: pendingCount })
    const { default: ApprovalCenterView } = await import('../src/views/approval/ApprovalCenterView.vue')
    const Host = defineComponent({
      setup() {
        return () => h(ApprovalCenterView as any)
      },
    })
    app = createApp(Host)
    registerCommonStubs(app)
    app.mount(container!)
    await flushUi(6)
  }

  it('renders a badge with the server count on mount when > 0', async () => {
    await mountCenter(5)
    expect(getPendingCountSpy).toHaveBeenCalledWith('all')
    const badge = container!.querySelector('[data-testid="approval-pending-badge"]') as HTMLElement | null
    expect(badge).toBeTruthy()
    // el-badge prop is mapped to data-badge-value in our stub; the content is
    // the same integer the endpoint returned.
    expect(badge?.getAttribute('data-badge-value')).toBe('5')
  })

  it('hides the badge when the pending count is 0', async () => {
    await mountCenter(0)
    expect(getPendingCountSpy).toHaveBeenCalled()
    const badge = container!.querySelector('[data-testid="approval-pending-badge"]')
    expect(badge).toBeNull()
  })
})

describe('ApprovalDetailView 催一下 (WP3 slice 1)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    getPendingCountSpy.mockReset()
    remindApprovalSpy.mockReset()
    pushSpy.mockClear()
    elSuccessSpy.mockClear()
    elWarningSpy.mockClear()
    elErrorSpy.mockClear()
    mockActiveApproval.value = {
      id: 'apv_remind_target',
      sourceSystem: 'platform',
      status: 'pending',
      requester: { id: 'user_1', name: '申请人' },
      title: '催办目标',
      requestNo: 'AP-999999',
      templateId: null,
      templateVersionId: null,
      publishedDefinitionId: null,
      formSnapshot: null,
      currentNodeKey: 'approval_1',
      assignments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalSteps: 2,
      currentStep: 1,
    }
    mockHistory.value = []

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

  async function mountDetail(): Promise<void> {
    const { default: ApprovalDetailView } = await import('../src/views/approval/ApprovalDetailView.vue')
    const Host = defineComponent({
      setup() {
        return () => h(ApprovalDetailView as any)
      },
    })
    app = createApp(Host)
    registerCommonStubs(app)
    app.mount(container!)
    await flushUi(6)
  }

  it('shows the 催一下 button for the requester on a pending approval', async () => {
    await mountDetail()
    const button = container!.querySelector('[data-testid="approval-remind-button"]') as HTMLButtonElement | null
    expect(button).toBeTruthy()
    expect(button!.textContent).toContain('催一下')
  })

  it('calls the remind API and shows a success toast on 200', async () => {
    remindApprovalSpy.mockResolvedValueOnce({
      ok: true,
      data: {
        id: 'apv_remind_target',
        action: 'remind',
        remindedAt: new Date().toISOString(),
        bridged: false,
        sourceSystem: 'platform',
      },
    })
    await mountDetail()
    const button = container!.querySelector('[data-testid="approval-remind-button"]') as HTMLButtonElement
    button.click()
    await flushUi(6)
    expect(remindApprovalSpy).toHaveBeenCalledWith('apv_remind_target')
    expect(elSuccessSpy).toHaveBeenCalledWith('已催办')
  })

  it('surfaces the throttle message when the server returns 429', async () => {
    const lastRemindedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    remindApprovalSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      error: {
        code: 'APPROVAL_REMIND_THROTTLED',
        message: 'Remind is rate-limited',
        lastRemindedAt,
        retryAfterSeconds: 3600,
      },
    })
    await mountDetail()
    const button = container!.querySelector('[data-testid="approval-remind-button"]') as HTMLButtonElement
    button.click()
    await flushUi(6)
    expect(remindApprovalSpy).toHaveBeenCalledWith('apv_remind_target')
    expect(elWarningSpy).toHaveBeenCalled()
    const message = elWarningSpy.mock.calls[0]?.[0] as string
    expect(message).toContain('已在')
    expect(message).toContain('催办过')
    expect(elSuccessSpy).not.toHaveBeenCalled()
  })

  it('hides the 催一下 button when the current user is not the requester', async () => {
    mockActiveApproval.value = {
      ...mockActiveApproval.value,
      requester: { id: 'user_not_the_current', name: '他人' },
    }
    await mountDetail()
    const button = container!.querySelector('[data-testid="approval-remind-button"]')
    expect(button).toBeNull()
  })
})
