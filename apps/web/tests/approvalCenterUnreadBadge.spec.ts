/**
 * Wave 2 WP3 slice 2 — 已读/未读 frontend specs.
 *
 * Covers three surfaces introduced by the slice 2 contract:
 *   1. `ApprovalCenterView` badge reads `unreadCount` (not `count`) from the
 *      pending-count endpoint.
 *   2. Clicking "全部标记已读" invokes `markAllApprovalsRead` with the current
 *      sourceSystem and re-polls the badge afterwards, flipping to 0.
 *   3. `ApprovalDetailView` fires `markApprovalRead(instance.id)` on mount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

// ---------------------------------------------------------------------------
// Module-level spies — hoisted so `vi.mock` factories can pick them up
// without triggering the "cannot access X before initialization" guard.
// ---------------------------------------------------------------------------
const pushSpy = vi.fn().mockResolvedValue(undefined)
const getPendingCountSpy = vi.fn<(sourceSystem?: 'all' | 'platform' | 'plm') => Promise<{ count: number; unreadCount: number }>>()
const markAllApprovalsReadSpy = vi.fn<(sourceSystem?: 'all' | 'platform' | 'plm') => Promise<{ markedCount: number }>>()
const markApprovalReadSpy = vi.fn<(id: string) => Promise<{ ok: boolean }>>()
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
      params: { id: 'apv_read_target' },
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
  markAllApprovalsRead: (sourceSystem?: 'all' | 'platform' | 'plm') => markAllApprovalsReadSpy(sourceSystem),
  markApprovalRead: (id: string) => markApprovalReadSpy(id),
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

const ElTooltip = defineComponent({
  name: 'ElTooltip',
  props: { content: String, placement: String },
  render() {
    return h('span', { 'data-el-tooltip': this.content }, this.$slots.default?.())
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

async function flushUi(cycles = 6): Promise<void> {
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
  app.component('ElTooltip', ElTooltip)
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

describe('ApprovalCenterView 未读红点 (WP3 slice 2)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    getPendingCountSpy.mockReset()
    markAllApprovalsReadSpy.mockReset()
    markApprovalReadSpy.mockReset()
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

  async function mountCenter(initial: { count: number; unreadCount: number }): Promise<void> {
    getPendingCountSpy.mockResolvedValue(initial)
    const { default: ApprovalCenterView } = await import('../src/views/approval/ApprovalCenterView.vue')
    const Host = defineComponent({
      setup() {
        return () => h(ApprovalCenterView as any)
      },
    })
    app = createApp(Host)
    registerCommonStubs(app)
    app.mount(container!)
    await flushUi()
  }

  it('renders the badge with unreadCount (not count) on mount', async () => {
    await mountCenter({ count: 7, unreadCount: 3 })
    expect(getPendingCountSpy).toHaveBeenCalledWith('all')
    const badge = container!.querySelector('[data-testid="approval-pending-badge"]') as HTMLElement | null
    expect(badge).toBeTruthy()
    expect(badge?.getAttribute('data-badge-value')).toBe('3')
  })

  it('hides the badge when unreadCount is 0 even if count > 0', async () => {
    await mountCenter({ count: 4, unreadCount: 0 })
    const badge = container!.querySelector('[data-testid="approval-pending-badge"]')
    expect(badge).toBeNull()
  })

  it('全部标记已读 calls the API with the current sourceSystem and refreshes the badge to 0', async () => {
    getPendingCountSpy.mockResolvedValueOnce({ count: 4, unreadCount: 3 })
    markAllApprovalsReadSpy.mockResolvedValueOnce({ markedCount: 3 })
    // After the mark-all call the component re-fetches pending-count; the
    // second response should drop the unread count to 0 so the badge clears.
    getPendingCountSpy.mockResolvedValueOnce({ count: 4, unreadCount: 0 })

    const { default: ApprovalCenterView } = await import('../src/views/approval/ApprovalCenterView.vue')
    const Host = defineComponent({
      setup() {
        return () => h(ApprovalCenterView as any)
      },
    })
    app = createApp(Host)
    registerCommonStubs(app)
    app.mount(container!)
    await flushUi()

    const badgeBefore = container!.querySelector('[data-testid="approval-pending-badge"]') as HTMLElement | null
    expect(badgeBefore?.getAttribute('data-badge-value')).toBe('3')

    const button = container!.querySelector('[data-testid="approval-mark-all-read"]') as HTMLButtonElement
    expect(button).toBeTruthy()
    button.click()
    await flushUi()

    expect(markAllApprovalsReadSpy).toHaveBeenCalledWith('all')
    expect(elSuccessSpy).toHaveBeenCalled()
    // getPendingCount fired twice: once on mount, once after mark-all-read.
    expect(getPendingCountSpy.mock.calls.length).toBeGreaterThanOrEqual(2)

    const badgeAfter = container!.querySelector('[data-testid="approval-pending-badge"]')
    expect(badgeAfter).toBeNull()
  })

  it('disables 全部标记已读 when there is nothing unread', async () => {
    await mountCenter({ count: 2, unreadCount: 0 })
    const button = container!.querySelector('[data-testid="approval-mark-all-read"]') as HTMLButtonElement
    expect(button).toBeTruthy()
    expect(button.hasAttribute('disabled')).toBe(true)
  })
})

describe('ApprovalDetailView mark-read on mount (WP3 slice 2)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    getPendingCountSpy.mockReset()
    markAllApprovalsReadSpy.mockReset()
    markApprovalReadSpy.mockReset()
    remindApprovalSpy.mockReset()
    pushSpy.mockClear()
    elSuccessSpy.mockClear()
    elWarningSpy.mockClear()
    elErrorSpy.mockClear()
    mockActiveApproval.value = {
      id: 'apv_read_target',
      sourceSystem: 'platform',
      status: 'pending',
      requester: { id: 'user_1', name: '申请人' },
      title: '已读目标',
      requestNo: 'AP-888888',
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
    await flushUi()
  }

  it('fires markApprovalRead with the route id on mount', async () => {
    markApprovalReadSpy.mockResolvedValue({ ok: true })
    await mountDetail()
    expect(markApprovalReadSpy).toHaveBeenCalledWith('apv_read_target')
  })

  it('does not surface an error toast when mark-read rejects', async () => {
    markApprovalReadSpy.mockRejectedValue(new Error('network'))
    await mountDetail()
    await flushUi()
    expect(markApprovalReadSpy).toHaveBeenCalledWith('apv_read_target')
    expect(elErrorSpy).not.toHaveBeenCalled()
  })
})
