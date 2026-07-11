import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

// ---------------------------------------------------------------------------
// T3-1 v0 — mobile approval CENTER responsive adaptation (ballot Q10/Q11).
//
// Proves the full rollout-gate matrix:
//   - flag OFF (any viewport)        → desktop el-table, NO mobile card list
//   - flag ON  + narrow viewport     → dedicated ApprovalMobileList card list,
//                                       batch toolbar hidden, tap → detail route
//   - flag ON  + wide viewport       → desktop el-table (enabling the tenant
//                                       gate must not force mobile chrome onto
//                                       desktop users)
//
// The store is mocked (list data never touches the api mock-mode fixtures), and
// the `approvalMobile` flag is controlled by mocking the featureFlags module —
// the view only READS the flag, so no loader runs in the test.
// ---------------------------------------------------------------------------

const pushSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, back: vi.fn() }),
    useRoute: () => ({ params: {}, query: {}, path: '/approvals', meta: {} }),
  }
})

// Feature-flag gate — a module-level ref toggled per test.
const mockApprovalMobileFlag = ref(false)
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) =>
      feature === 'approvalMobile' ? mockApprovalMobileFlag.value : false,
  }),
}))

// B2-01: `getTemplate` backs the list row key-field summary (`useApprovalListFieldSummary`) — a
// named spy (unlike the other inline `vi.fn()`s above) so individual tests can control its
// resolved/rejected value and assert on calls.
const getTemplateSpy = vi.fn().mockResolvedValue({ formSchema: { fields: [] } })

// Keep the on-mount badge/realtime side-effects off the real wire.
vi.mock('../src/approvals/api', () => ({
  dispatchAction: vi.fn().mockResolvedValue({}),
  getPendingCount: vi.fn().mockResolvedValue({ count: 0, unreadCount: 0 }),
  markAllApprovalsRead: vi.fn().mockResolvedValue({ markedCount: 0 }),
  remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  getTemplate: (...args: [string]) => getTemplateSpy(...args),
}))
vi.mock('../src/approvals/useApprovalCountsRealtime', () => ({
  useApprovalCountsRealtime: () => undefined,
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

// Element Plus stubs — the mobile card list is a real child (no Element Plus),
// so it renders for real when the mobile path is active.
function stub(name: string, tag = 'div', extraProps: Record<string, unknown> = {}) {
  return defineComponent({
    name,
    props: { modelValue: {}, type: String, label: String, name: String, ...extraProps },
    emits: ['update:modelValue', 'tab-change', 'row-click', 'change', 'clear', 'click'],
    render() {
      return h(tag, { 'data-stub': name }, [this.$slots.label?.(), this.$slots.default?.()])
    },
  })
}

const ElTabs = stub('ElTabs')
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
  props: { data: Array },
  render() {
    return h('div', { 'data-el-table': 'true' }, this.$slots.default?.())
  },
})
// Do NOT invoke scoped slots — el-table-column's `#default="{ row }"` expects a
// { row } context that only the real el-table supplies.
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String, width: [String, Number], minWidth: [String, Number] },
  render() {
    return h('div', { 'data-column': this.prop || this.label })
  },
})
const ElTag = stub('ElTag', 'span')
const ElInput = defineComponent({ name: 'ElInput', render() { return h('input', { 'data-el-input': 'true' }) } })
const ElSelect = defineComponent({ name: 'ElSelect', render() { return h('select', { 'data-el-select': 'true' }, this.$slots.default?.()) } })
const ElOption = stub('ElOption', 'option')
const ElPagination = defineComponent({ name: 'ElPagination', render() { return h('div', { 'data-el-pagination': 'true' }) } })
const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, loading: Boolean, disabled: Boolean },
  emits: ['click'],
  render() {
    return h('button', {
      'data-el-button': this.type || 'default',
      onClick: (e: Event) => this.$emit('click', e),
    }, this.$slots.default?.())
  },
})
const ElAlert = stub('ElAlert')
const ElEmpty = defineComponent({ name: 'ElEmpty', props: { description: String }, render() { return h('div', { 'data-el-empty': 'true' }, this.description) } })
const ElDialog = stub('ElDialog')
const ElBadge = stub('ElBadge', 'span')
const ElTooltip = stub('ElTooltip')
const ElIcon = stub('ElIcon', 'i')

const stubDirective = { mounted() {}, updated() {} }

function setViewport(mobile: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes('max-width'),
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

function pendingRow(id: string, title: string, createdAt = '2026-04-10T08:00:00Z'): any {
  return {
    id,
    requestNo: `AP-${id}`,
    title,
    status: 'pending',
    requester: { name: '张三' },
    createdAt,
    assignments: [],
  }
}

describe('ApprovalCenterView — T3-1 mobile responsive gate', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    // This suite's fixtures/assertions are Chinese (e.g. '待处理', '张三');
    // pin the locale explicitly rather than depend on jsdom's default
    // navigator.language, matching the existing zh-locked spec convention
    // (see attendance-experience-mobile-zh.spec.ts). The i18n retrofit
    // (approvalMobileI18n.spec.ts) separately proves the English path.
    window.localStorage.setItem('metasheet_locale', 'zh-CN')
    useLocale().setLocale('zh-CN')
    mockApprovalMobileFlag.value = false
    mockPendingApprovals.value = []
    mockMyApprovals.value = []
    mockCcApprovals.value = []
    mockCompletedApprovals.value = []
    mockLoading.value = false
    loadPendingSpy.mockClear()
    pushSpy.mockClear()
    getTemplateSpy.mockClear()
    getTemplateSpy.mockResolvedValue({ formSchema: { fields: [] } })
    setViewport(false)
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
    const Host = defineComponent({ setup() { return () => h(ApprovalCenterView as any) } })
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
    app.component('ElEmpty', ElEmpty)
    app.component('ElDialog', ElDialog)
    app.component('ElBadge', ElBadge)
    app.component('ElTooltip', ElTooltip)
    app.component('ElIcon', ElIcon)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  it('flag OFF + narrow viewport → keeps the desktop table, no mobile list', async () => {
    mockApprovalMobileFlag.value = false
    setViewport(true)
    mockPendingApprovals.value = [pendingRow('1', '出差报销')]
    await mountView()

    expect(container!.querySelector('[data-testid="approval-mobile-list"]')).toBeNull()
    expect(container!.querySelector('[data-el-table]')).toBeTruthy()
  })

  it('flag ON + narrow viewport → renders the mobile card list, hides the desktop table + batch toolbar', async () => {
    mockApprovalMobileFlag.value = true
    setViewport(true)
    mockPendingApprovals.value = [pendingRow('1', '出差报销'), pendingRow('2', '采购申请')]
    await mountView()

    const list = container!.querySelector('[data-testid="approval-mobile-list"]')
    expect(list).toBeTruthy()
    const cards = container!.querySelectorAll('[data-testid="approval-mobile-card"]')
    expect(cards.length).toBe(2)
    expect(cards[0].textContent).toContain('出差报销')
    expect(cards[0].textContent).toContain('待处理')

    // Desktop widgets are gone on the mobile surface.
    expect(container!.querySelector('[data-el-table]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-batch-approve"]')).toBeNull()
  })

  it('flag ON + WIDE viewport → stays on the desktop table (gate does not force mobile chrome)', async () => {
    mockApprovalMobileFlag.value = true
    setViewport(false)
    mockPendingApprovals.value = [pendingRow('1', '出差报销')]
    await mountView()

    expect(container!.querySelector('[data-testid="approval-mobile-list"]')).toBeNull()
    expect(container!.querySelector('[data-el-table]')).toBeTruthy()
  })

  it('flag ON + narrow → tapping a card routes to the approval detail', async () => {
    mockApprovalMobileFlag.value = true
    setViewport(true)
    mockPendingApprovals.value = [pendingRow('42', '报销单')]
    await mountView()

    const card = container!.querySelector<HTMLButtonElement>('[data-testid="approval-mobile-card"]')
    expect(card).toBeTruthy()
    card!.click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-detail', params: { id: '42' } })
  })

  // ---------------------------------------------------------------------------
  // B1-03 (审批中心列表热路径包) — the mobile card's date line switches to 已等待 aging with
  // severity coloring; the absolute date is preserved as a `:title` tooltip rather than lost.
  // ---------------------------------------------------------------------------
  it('flag ON + narrow → mobile card shows 已等待 aging with severity coloring (absolute date kept as a tooltip)', async () => {
    mockApprovalMobileFlag.value = true
    setViewport(true)
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    mockPendingApprovals.value = [pendingRow('1', '出差报销', eightDaysAgo)]
    await mountView()

    const card = container!.querySelector('[data-testid="approval-mobile-card"]')
    expect(card).toBeTruthy()
    const dateEl = card!.querySelector('.approval-mobile-list__date')
    expect(dateEl).toBeTruthy()
    expect(dateEl!.textContent).toContain('已等待')
    expect(dateEl!.textContent).toContain('8 天')
    expect(dateEl!.classList.contains('approval-mobile-list__date--urgent')).toBe(true)
    expect(dateEl!.getAttribute('title')).toBeTruthy()
  })

  // ---------------------------------------------------------------------------
  // B2-01 (待办列表关键字段摘要) — the mobile card list surfaces the same live-template summary
  // line as the desktop table's title column, resolved from the `templateSchemas` cache
  // ApprovalCenterView owns (useApprovalListFieldSummary) and passes down as a prop.
  // ---------------------------------------------------------------------------
  describe('B2-01: mobile card key-field summary', () => {
    const leaveTemplateSchema = {
      fields: [
        {
          id: 'fld_leave_type',
          type: 'select',
          label: '请假类型',
          options: [{ label: '年假', value: 'annual' }],
        },
        { id: 'fld_duration', type: 'number', label: '时长' },
        { id: 'fld_attachment', type: 'attachment', label: '附件' },
      ],
    }

    it('flag ON + narrow → a card whose template has fields shows the summary line', async () => {
      getTemplateSpy.mockResolvedValue({ formSchema: leaveTemplateSchema })
      mockApprovalMobileFlag.value = true
      setViewport(true)
      mockPendingApprovals.value = [
        {
          ...pendingRow('1', '出差报销'),
          templateId: 'tpl_leave',
          formSnapshot: { fld_leave_type: 'annual', fld_duration: 2, fld_attachment: ['f1'] },
        },
      ]
      await mountView()
      await flushUi(6)

      expect(getTemplateSpy).toHaveBeenCalledWith('tpl_leave')
      const card = container!.querySelector('[data-testid="approval-mobile-card"]')
      expect(card).toBeTruthy()
      const summary = card!.querySelector('.approval-mobile-list__summary')
      expect(summary).toBeTruthy()
      expect(summary!.textContent?.trim()).toBe('请假类型：年假 · 时长：2')
      // The attachment field is a schema field but never part of the summary.
      expect(summary!.textContent).not.toContain('附件')
    })

    it('flag ON + narrow → a card without templateId shows no summary and never calls getTemplate', async () => {
      mockApprovalMobileFlag.value = true
      setViewport(true)
      mockPendingApprovals.value = [pendingRow('1', '出差报销')]
      await mountView()
      await flushUi(6)

      expect(getTemplateSpy).not.toHaveBeenCalled()
      const card = container!.querySelector('[data-testid="approval-mobile-card"]')
      expect(card).toBeTruthy()
      expect(card!.querySelector('.approval-mobile-list__summary')).toBeNull()
    })

    it('flag ON + narrow → a template-fetch failure leaves the card summary-less, without throwing', async () => {
      getTemplateSpy.mockRejectedValueOnce(new Error('模板不存在'))
      mockApprovalMobileFlag.value = true
      setViewport(true)
      mockPendingApprovals.value = [
        { ...pendingRow('1', '出差报销'), templateId: 'tpl_missing', formSnapshot: { fld_reason: '出差' } },
      ]
      await mountView()
      await flushUi(6)

      expect(getTemplateSpy).toHaveBeenCalledWith('tpl_missing')
      const card = container!.querySelector('[data-testid="approval-mobile-card"]')
      expect(card).toBeTruthy()
      expect(card!.textContent).toContain('出差报销')
      expect(card!.querySelector('.approval-mobile-list__summary')).toBeNull()
    })
  })
})
