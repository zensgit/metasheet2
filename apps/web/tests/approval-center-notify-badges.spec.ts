import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocale } from '../src/composables/useLocale'
import { __resetResolvedDirectoryNamesForTests } from '../src/approvals/directoryResolve'
import {
  createApp,
  defineComponent,
  h,
  inject,
  nextTick,
  provide,
  reactive,
  ref,
  type App as VueApp,
  type Slot,
} from 'vue'

// ---------------------------------------------------------------------------
// Test report 2026-10-08 — read-state badges on the approval center's tabs.
//
//   T3 (抄送我的): being CC'd produced no prompt at all. Behind the server switch surfaced as the
//   session feature `approvalCcUnreadBadge`, the 抄送我的 tab carries its own unread-CC badge (its
//   own endpoint, never the 待办/未读 numbers — todo-center lock B) and a per-row dot from the
//   list's `ccUnread`.
//   T6 (我发起的): a requester whose request was rejected got no prompt. Behind
//   `approvalMineOutcomeBadge`, the 我发起的 tab carries a new-outcome badge and a per-row dot from
//   the list's `outcomeUnseen`, with exactly the same discipline.
//
// This spec pins the web half: switch OFF ⇒ zero new requests and nothing rendered; switch ON ⇒
// the badge shows the server's number (hidden at 0 or on failure), dots follow the server's per-row
// verdict exactly, the count is re-asked on every list (re)load / tab switch / source change / an
// existing approval counts frame / a pane read — the newest request's answer wins even when an
// older one lands last — and never feeds the header 待办/未读 numbers.
// ---------------------------------------------------------------------------

const pushSpy = vi.fn().mockResolvedValue(undefined)
const mockRoute = reactive({
  name: 'approval-list' as string | undefined,
  params: {},
  query: {} as Record<string, string>,
  path: '/approvals',
  meta: {},
})
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
    ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  }
})

const getPendingCountSpy = vi.fn().mockResolvedValue({ count: 0, unreadCount: 0 })
const getCcUnreadCountSpy = vi.fn().mockResolvedValue({ count: 0 })
const getMineOutcomesUnseenCountSpy = vi.fn().mockResolvedValue({ count: 0 })
const markApprovalReadSpy = vi.fn().mockResolvedValue({ ok: true })
const getApprovalSpy = vi.fn()

vi.mock('../src/approvals/api', () => ({
  dispatchAction: vi.fn().mockResolvedValue({}),
  getPendingCount: (...args: unknown[]) => getPendingCountSpy(...args),
  getCcUnreadCount: (...args: unknown[]) => getCcUnreadCountSpy(...args),
  getMineOutcomesUnseenCount: (...args: unknown[]) => getMineOutcomesUnseenCountSpy(...args),
  markAllApprovalsRead: vi.fn().mockResolvedValue({ markedCount: 0 }),
  markApprovalRead: (...args: unknown[]) => markApprovalReadSpy(...args),
  remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  getTemplate: vi.fn().mockResolvedValue({ formSchema: { fields: [] } }),
  listTemplates: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  getApproval: (...args: unknown[]) => getApprovalSpy(...args),
  resolveApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
}))

// The realtime composable is replaced by a capture so a test can deliver an existing approval
// counts frame exactly as the socket would.
let countsFrameHandler: ((payload: { count: number; unreadCount: number }) => void) | null = null
vi.mock('../src/approvals/useApprovalCountsRealtime', () => ({
  useApprovalCountsRealtime: (options: { onCountsUpdated: (payload: { count: number; unreadCount: number }) => void }) => {
    countsFrameHandler = options.onCountsUpdated
  },
}))

const enabledFeatures = new Set<string>()
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({ hasFeature: (feature: string) => enabledFeatures.has(feature) }),
}))

const mockPendingApprovals = ref<any[]>([])
const mockMyApprovals = ref<any[]>([])
const mockCcApprovals = ref<any[]>([])
const mockCompletedApprovals = ref<any[]>([])
const mockProcessedApprovals = ref<any[]>([])
const loadPendingSpy = vi.fn().mockResolvedValue(undefined)
const loadMineSpy = vi.fn().mockResolvedValue(undefined)
const loadCcSpy = vi.fn().mockResolvedValue(undefined)

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
    get loading() { return false },
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
    loadMine: loadMineSpy,
    loadCc: loadCcSpy,
    loadCompleted: vi.fn().mockResolvedValue(undefined),
    loadProcessed: vi.fn().mockResolvedValue(undefined),
    loadDetail: vi.fn(),
    loadHistory: vi.fn(),
    submitApproval: vi.fn(),
    executeAction: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Element Plus stubs. Tab panes render label slot + content side by side (every pane at once), and
// the table renders each column's real scoped slot per row, so a row's dot is observable per tab.
// ---------------------------------------------------------------------------
const TAB_NAMES = ['pending', 'mine', 'cc', 'completed', 'processed'] as const

const ElTabs = defineComponent({
  name: 'ElTabs',
  props: { modelValue: String },
  emits: ['update:modelValue', 'tab-change'],
  render() {
    return h('div', { 'data-el-tabs': this.modelValue }, [
      ...TAB_NAMES.map((name) => h('button', {
        type: 'button',
        'data-testid': `test-switch-tab-${name}`,
        onClick: () => {
          this.$emit('update:modelValue', name)
          this.$emit('tab-change', name)
        },
      }, name)),
      this.$slots.default?.(),
    ])
  },
})

const ElTabPane = defineComponent({
  name: 'ElTabPane',
  props: { label: String, name: String },
  render() {
    return h('div', { 'data-tab-pane': this.name }, [
      h('div', { 'data-tab-label': this.name }, this.$slots.label ? this.$slots.label() : this.label),
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
        h('div', { style: 'display:none' }, columnInstances),
        ...rows.map((row, i) => h(
          'div',
          {
            'data-el-row': (row?.id as string | undefined) ?? String(i),
            key: (row?.id as string | undefined) ?? String(i),
            onClick: () => emit('row-click', row),
          },
          registry.columns.map((col) =>
            col.defaultSlot
              ? h('div', { 'data-el-cell': col.prop || col.label || col.key }, col.defaultSlot({ row }))
              : h('div', { 'data-el-cell-header': col.prop || col.label }, ''),
          ),
        )),
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

const ElBadge = defineComponent({
  name: 'ElBadge',
  props: { value: [Number, String], max: Number },
  render() {
    return h('span', { 'data-badge-value': String(this.value) }, String(this.value))
  },
})

const ElTooltip = defineComponent({
  name: 'ElTooltip',
  props: { content: String, placement: String },
  render() {
    return h('span', { 'data-tooltip-content': this.content ?? '' }, this.$slots.default?.())
  },
})

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Array], placeholder: String, clearable: Boolean, multiple: Boolean, filterable: Boolean },
  emits: ['update:modelValue', 'change'],
  render() {
    return h('select', {
      'data-el-select': 'true',
      value: this.modelValue as string,
      onChange: (event: Event) => {
        const value = (event.target as HTMLSelectElement).value
        this.$emit('update:modelValue', value)
        this.$emit('change', value)
      },
    }, this.$slots.default?.())
  },
})

const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: String, value: String },
  render() { return h('option', { value: this.value }, this.label) },
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

function passthrough(name: string, tag = 'div') {
  return defineComponent({
    name,
    render() { return h(tag, { 'data-stub': name }, this.$slots.default?.()) },
  })
}

const ElDialog = defineComponent({
  name: 'ElDialog',
  props: { modelValue: Boolean, title: String, width: String },
  render() {
    if (!this.modelValue) return null
    return h('div', { 'data-el-dialog': this.title }, [this.$slots.default?.(), this.$slots.footer?.()])
  },
})

const ElPopconfirm = defineComponent({
  name: 'ElPopconfirm',
  props: { title: String, confirmButtonText: String, cancelButtonText: String },
  render() { return h('span', {}, this.$slots.reference?.()) },
})

const ElDatePicker = defineComponent({
  name: 'ElDatePicker',
  props: { modelValue: { type: Array, default: null } },
  render() { return h('button', { 'data-el-date-picker': 'true' }) },
})

const ElPagination = defineComponent({
  name: 'ElPagination',
  props: { background: Boolean, layout: String, total: Number, currentPage: Number, pageSize: Number },
  render() { return h('div', { 'data-el-pagination': 'true' }) },
})

const ElEmpty = defineComponent({
  name: 'ElEmpty',
  props: { description: String, imageSize: Number },
  render() { return h('div', { 'data-el-empty': 'true' }, this.description) },
})

const stubDirective = { mounted() {}, updated() {} }

function setViewport(mode: 'default' | 'wide'): void {
  window.matchMedia = ((query: string) => ({
    matches: mode === 'wide' ? query.includes('min-width') : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function row(id: string, title: string, extra: Record<string, unknown> = {}): any {
  return {
    id,
    requestNo: `AP-${id}`,
    title,
    status: 'pending',
    requester: { name: 'requester-x' },
    createdAt: '2026-10-01T08:00:00Z',
    updatedAt: '2026-10-01T08:00:00Z',
    currentNodeKey: 'node_a',
    currentStep: 1,
    totalSteps: 2,
    assignments: [],
    ...extra,
  }
}

beforeEach(() => {
  useLocale().setLocale('zh-CN')
})

describe('ApprovalCenterView — tab read-state badges (test report 2026-10-08)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    enabledFeatures.clear()
    countsFrameHandler = null
    mockPendingApprovals.value = []
    mockMyApprovals.value = []
    mockCcApprovals.value = []
    mockCompletedApprovals.value = []
    mockProcessedApprovals.value = []
    pushSpy.mockClear()
    replaceSpy.mockClear()
    loadPendingSpy.mockClear()
    loadMineSpy.mockClear()
    loadCcSpy.mockClear()
    getPendingCountSpy.mockReset().mockResolvedValue({ count: 0, unreadCount: 0 })
    getCcUnreadCountSpy.mockReset().mockResolvedValue({ count: 0 })
    getMineOutcomesUnseenCountSpy.mockReset().mockResolvedValue({ count: 0 })
    markApprovalReadSpy.mockReset().mockResolvedValue({ ok: true })
    getApprovalSpy.mockReset()
    __resetResolvedDirectoryNamesForTests()
    mockRoute.name = 'approval-list'
    mockRoute.query = {}
    setViewport('default')
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
    app.component('ElBadge', ElBadge)
    app.component('ElTooltip', ElTooltip)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.component('ElButton', ElButton)
    app.component('ElInput', ElInput)
    app.component('ElDialog', ElDialog)
    app.component('ElPopconfirm', ElPopconfirm)
    app.component('ElDatePicker', ElDatePicker)
    app.component('ElPagination', ElPagination)
    app.component('ElEmpty', ElEmpty)
    app.component('ElAlert', passthrough('ElAlert'))
    app.component('ElIcon', passthrough('ElIcon', 'i'))
    app.component('ElSkeleton', passthrough('ElSkeleton'))
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  const q = (selector: string) => container!.querySelector(selector)
  const tabLabel = (name: string) => q(`[data-tab-label="${name}"]`) as HTMLElement | null
  const dotOf = (id: string) => q(`[data-el-row="${id}"] [data-testid="approval-row-unread-dot"]`)
  const switchTab = async (name: string) => {
    ;(q(`[data-testid="test-switch-tab-${name}"]`) as HTMLButtonElement).click()
    await flushUi()
  }
  const changeSource = async (value: string) => {
    const sourceSelect = q('[data-testid="approval-source-filter"]') as HTMLSelectElement
    sourceSelect.value = value
    sourceSelect.dispatchEvent(new Event('change'))
    await flushUi()
  }
  type HeldCount = { answer: (count: number) => void; fail: () => void }
  /** Makes `spy` answer (or fail) only when the test says so, per source: the newest call per source wins. */
  function holdCountAnswers(spy: ReturnType<typeof vi.fn>): Map<string, HeldCount> {
    const pending = new Map<string, HeldCount>()
    spy.mockImplementation((source: unknown) => new Promise<{ count: number }>((resolve, reject) => {
      pending.set(String(source), {
        answer: (count) => resolve({ count }),
        fail: () => reject(new Error('unavailable')),
      })
    }))
    return pending
  }

  // -------------------------------------------------------------------------
  // T3 — 抄送我的 unread badge.
  // -------------------------------------------------------------------------
  describe('抄送我的 unread-CC badge (T3)', () => {
    it('switch OFF: no count request on load or tab switch, no badge, and no dot even on a row the server marked unread', async () => {
      mockCcApprovals.value = [row('cc_1', '出差报销', { ccUnread: true })]
      await mountView()
      await switchTab('cc')

      expect(getCcUnreadCountSpy).not.toHaveBeenCalled()
      expect(q('[data-testid="approval-cc-unread-badge"]')).toBeNull()
      expect(tabLabel('cc')?.textContent).toBe('抄送我的')
      expect(dotOf('cc_1')).toBeNull()
    })

    it('switch ON: the badge shows the server count, keeps the tab label, and asks for the current source', async () => {
      enabledFeatures.add('approvalCcUnreadBadge')
      getCcUnreadCountSpy.mockResolvedValue({ count: 3 })
      await mountView()

      expect(getCcUnreadCountSpy).toHaveBeenCalledWith('all')
      const badge = q('[data-testid="approval-cc-unread-badge"]')
      expect(badge?.getAttribute('data-badge-value')).toBe('3')
      expect(tabLabel('cc')?.textContent).toContain('抄送我的')
      expect(q('[data-tooltip-content="3 条抄送未读"]')).toBeTruthy()
    })

    it('switch ON: a zero count renders no badge (never an empty bubble)', async () => {
      enabledFeatures.add('approvalCcUnreadBadge')
      getCcUnreadCountSpy.mockResolvedValue({ count: 0 })
      await mountView()

      expect(getCcUnreadCountSpy).toHaveBeenCalled()
      expect(q('[data-testid="approval-cc-unread-badge"]')).toBeNull()
      expect(tabLabel('cc')?.textContent).toBe('抄送我的')
    })

    it('switch ON: row dots follow the server verdict exactly — true ⇒ dot, false / absent ⇒ none', async () => {
      enabledFeatures.add('approvalCcUnreadBadge')
      mockCcApprovals.value = [
        row('cc_unread', '未读抄送', { ccUnread: true }),
        row('cc_read', '已读抄送', { ccUnread: false }),
        row('cc_plain', '无标记'),
      ]
      await mountView()

      expect(dotOf('cc_unread')).toBeTruthy()
      expect(dotOf('cc_read')).toBeNull()
      expect(dotOf('cc_plain')).toBeNull()
    })

    it('switch ON: the count is re-asked on tab switch, on a source change (with the new source), and on an approval counts frame', async () => {
      enabledFeatures.add('approvalCcUnreadBadge')
      getCcUnreadCountSpy.mockResolvedValue({ count: 1 })
      await mountView()
      const afterMount = getCcUnreadCountSpy.mock.calls.length
      expect(afterMount).toBeGreaterThan(0)

      await switchTab('cc')
      expect(getCcUnreadCountSpy.mock.calls.length).toBeGreaterThan(afterMount)

      const sourceSelect = q('[data-testid="approval-source-filter"]') as HTMLSelectElement
      sourceSelect.value = 'platform'
      sourceSelect.dispatchEvent(new Event('change'))
      await flushUi()
      expect(getCcUnreadCountSpy).toHaveBeenLastCalledWith('platform')

      const beforeFrame = getCcUnreadCountSpy.mock.calls.length
      getCcUnreadCountSpy.mockResolvedValue({ count: 4 })
      expect(countsFrameHandler).toBeTypeOf('function')
      countsFrameHandler!({ count: 0, unreadCount: 0 })
      await flushUi()
      expect(getCcUnreadCountSpy.mock.calls.length).toBe(beforeFrame + 1)
      expect(q('[data-testid="approval-cc-unread-badge"]')?.getAttribute('data-badge-value')).toBe('4')
    })

    it('switch ON: a failed count hides the badge instead of keeping a stale number', async () => {
      enabledFeatures.add('approvalCcUnreadBadge')
      getCcUnreadCountSpy.mockResolvedValueOnce({ count: 2 })
      await mountView()
      expect(q('[data-testid="approval-cc-unread-badge"]')).toBeTruthy()

      getCcUnreadCountSpy.mockRejectedValueOnce(new Error('unavailable'))
      countsFrameHandler!({ count: 0, unreadCount: 0 })
      await flushUi()
      expect(q('[data-testid="approval-cc-unread-badge"]')).toBeNull()
    })

    it('switch ON: an older count that answers last never overwrites the newer one (previous source after a source change)', async () => {
      enabledFeatures.add('approvalCcUnreadBadge')
      await mountView()
      const held = holdCountAnswers(getCcUnreadCountSpy)

      // A re-ask for the current source is in flight when the user narrows the source.
      countsFrameHandler!({ count: 0, unreadCount: 0 })
      await flushUi()
      await changeSource('platform')
      expect(getCcUnreadCountSpy).toHaveBeenLastCalledWith('platform')

      held.get('platform')!.answer(2)
      await flushUi()
      expect(q('[data-testid="approval-cc-unread-badge"]')?.getAttribute('data-badge-value')).toBe('2')

      // The previous source's slower answer lands last: it must not replace the current one.
      held.get('all')!.answer(9)
      await flushUi()
      expect(q('[data-testid="approval-cc-unread-badge"]')?.getAttribute('data-badge-value')).toBe('2')
    })

    it('switch ON: an older count that FAILS last never hides the newer one', async () => {
      enabledFeatures.add('approvalCcUnreadBadge')
      await mountView()
      const held = holdCountAnswers(getCcUnreadCountSpy)

      countsFrameHandler!({ count: 0, unreadCount: 0 })
      await flushUi()
      await changeSource('platform')

      held.get('platform')!.answer(2)
      await flushUi()
      expect(q('[data-testid="approval-cc-unread-badge"]')?.getAttribute('data-badge-value')).toBe('2')

      // Only the newest request's failure may hide the badge; an older one's may not.
      held.get('all')!.fail()
      await flushUi()
      expect(q('[data-testid="approval-cc-unread-badge"]')?.getAttribute('data-badge-value')).toBe('2')
    })

    it('lock B: the header 待办 / 未读 numbers come from the pending count only — the CC count never feeds them', async () => {
      enabledFeatures.add('approvalCcUnreadBadge')
      getPendingCountSpy.mockResolvedValue({ count: 1, unreadCount: 1 })
      getCcUnreadCountSpy.mockResolvedValue({ count: 7 })
      await mountView()

      const stats = Array.from(container!.querySelectorAll('.approval-center__stat strong')).map((el) => el.textContent)
      expect(stats).toEqual(['1', '1'])
      expect(q('[data-testid="approval-pending-badge"]')?.getAttribute('data-badge-value')).toBe('1')
      expect(q('[data-testid="approval-cc-unread-badge"]')?.getAttribute('data-badge-value')).toBe('7')
    })

    it('English locale: the badge tooltip is English', async () => {
      useLocale().setLocale('en')
      enabledFeatures.add('approvalCcUnreadBadge')
      getCcUnreadCountSpy.mockResolvedValue({ count: 2 })
      await mountView()

      expect(q('[data-tooltip-content="2 unread CC"]')).toBeTruthy()
    })

    it('switch ON, wide pane: opening a CC row records the read, clears that row\'s dot and re-asks the count', async () => {
      setViewport('wide')
      enabledFeatures.add('approvalCcUnreadBadge')
      getCcUnreadCountSpy.mockResolvedValue({ count: 2 })
      mockCcApprovals.value = [
        row('cc_1', '出差报销', { ccUnread: true }),
        row('cc_2', '采购申请', { ccUnread: true }),
      ]
      getApprovalSpy.mockResolvedValue(row('cc_1', '出差报销'))
      await mountView()
      await switchTab('cc')
      expect(dotOf('cc_1')).toBeTruthy()

      getCcUnreadCountSpy.mockResolvedValue({ count: 1 })
      const before = getCcUnreadCountSpy.mock.calls.length
      ;(q('[data-el-row="cc_1"]') as HTMLElement).click()
      await flushUi(10)

      expect(markApprovalReadSpy).toHaveBeenCalledWith('cc_1')
      expect(dotOf('cc_1')).toBeNull()
      expect(dotOf('cc_2')).toBeTruthy()
      expect(getCcUnreadCountSpy.mock.calls.length).toBeGreaterThan(before)
      expect(q('[data-testid="approval-cc-unread-badge"]')?.getAttribute('data-badge-value')).toBe('1')
    })
  })

  // -------------------------------------------------------------------------
  // T6 — 我发起的 new-outcome badge.
  // -------------------------------------------------------------------------
  describe('我发起的 new-outcome badge (T6)', () => {
    it('switch OFF: no count request on load or tab switch, no badge, and no dot even on a row the server marked unseen', async () => {
      mockMyApprovals.value = [row('mine_1', '出差报销', { status: 'rejected', outcomeUnseen: true })]
      await mountView()
      await switchTab('mine')

      expect(getMineOutcomesUnseenCountSpy).not.toHaveBeenCalled()
      expect(q('[data-testid="approval-mine-outcome-badge"]')).toBeNull()
      expect(tabLabel('mine')?.textContent).toBe('我发起的')
      expect(dotOf('mine_1')).toBeNull()
    })

    it('switch ON: the badge shows the server count with its tooltip; zero renders nothing', async () => {
      enabledFeatures.add('approvalMineOutcomeBadge')
      getMineOutcomesUnseenCountSpy.mockResolvedValueOnce({ count: 2 })
      await mountView()

      expect(getMineOutcomesUnseenCountSpy).toHaveBeenCalledWith('all')
      expect(q('[data-testid="approval-mine-outcome-badge"]')?.getAttribute('data-badge-value')).toBe('2')
      expect(q('[data-tooltip-content="2 条新结果"]')).toBeTruthy()
      expect(tabLabel('mine')?.textContent).toContain('我发起的')

      getMineOutcomesUnseenCountSpy.mockResolvedValueOnce({ count: 0 })
      countsFrameHandler!({ count: 0, unreadCount: 0 })
      await flushUi()
      expect(q('[data-testid="approval-mine-outcome-badge"]')).toBeNull()
      expect(tabLabel('mine')?.textContent).toBe('我发起的')
    })

    it('switch ON: row dots follow outcomeUnseen exactly, and the 催办 actions of a pending row are untouched', async () => {
      enabledFeatures.add('approvalMineOutcomeBadge')
      mockMyApprovals.value = [
        row('mine_new', '已驳回', { status: 'rejected', outcomeUnseen: true }),
        row('mine_seen', '已通过', { status: 'approved', outcomeUnseen: false }),
        row('mine_pending', '审批中'),
      ]
      await mountView()

      expect(dotOf('mine_new')).toBeTruthy()
      expect(dotOf('mine_seen')).toBeNull()
      expect(dotOf('mine_pending')).toBeNull()
      expect(q('[data-testid="approval-urge-mine_pending"]')).toBeTruthy()
    })

    it('switch ON: re-asked on tab switch, on a source change (with the new source) and on an approval counts frame', async () => {
      enabledFeatures.add('approvalMineOutcomeBadge')
      await mountView()
      const afterMount = getMineOutcomesUnseenCountSpy.mock.calls.length
      expect(afterMount).toBeGreaterThan(0)

      await switchTab('mine')
      expect(getMineOutcomesUnseenCountSpy.mock.calls.length).toBeGreaterThan(afterMount)

      const sourceSelect = q('[data-testid="approval-source-filter"]') as HTMLSelectElement
      sourceSelect.value = 'plm'
      sourceSelect.dispatchEvent(new Event('change'))
      await flushUi()
      expect(getMineOutcomesUnseenCountSpy).toHaveBeenLastCalledWith('plm')

      const beforeFrame = getMineOutcomesUnseenCountSpy.mock.calls.length
      countsFrameHandler!({ count: 0, unreadCount: 0 })
      await flushUi()
      expect(getMineOutcomesUnseenCountSpy.mock.calls.length).toBe(beforeFrame + 1)
    })

    it('switch ON: an older count that answers last never overwrites the newer one (previous source after a source change)', async () => {
      enabledFeatures.add('approvalMineOutcomeBadge')
      await mountView()
      const held = holdCountAnswers(getMineOutcomesUnseenCountSpy)

      countsFrameHandler!({ count: 0, unreadCount: 0 })
      await flushUi()
      await changeSource('platform')
      expect(getMineOutcomesUnseenCountSpy).toHaveBeenLastCalledWith('platform')

      held.get('platform')!.answer(1)
      await flushUi()
      expect(q('[data-testid="approval-mine-outcome-badge"]')?.getAttribute('data-badge-value')).toBe('1')

      held.get('all')!.answer(8)
      await flushUi()
      expect(q('[data-testid="approval-mine-outcome-badge"]')?.getAttribute('data-badge-value')).toBe('1')
    })

    it('switch ON: an older count that FAILS last never hides the newer one', async () => {
      enabledFeatures.add('approvalMineOutcomeBadge')
      await mountView()
      const held = holdCountAnswers(getMineOutcomesUnseenCountSpy)

      countsFrameHandler!({ count: 0, unreadCount: 0 })
      await flushUi()
      await changeSource('platform')

      held.get('platform')!.answer(1)
      await flushUi()
      expect(q('[data-testid="approval-mine-outcome-badge"]')?.getAttribute('data-badge-value')).toBe('1')

      held.get('all')!.fail()
      await flushUi()
      expect(q('[data-testid="approval-mine-outcome-badge"]')?.getAttribute('data-badge-value')).toBe('1')
    })

    it('switch ON, wide pane: opening an unseen outcome records the read, clears its dot and re-asks the count', async () => {
      setViewport('wide')
      enabledFeatures.add('approvalMineOutcomeBadge')
      getMineOutcomesUnseenCountSpy.mockResolvedValue({ count: 1 })
      mockMyApprovals.value = [row('mine_new', '已驳回', { status: 'rejected', outcomeUnseen: true })]
      getApprovalSpy.mockResolvedValue(row('mine_new', '已驳回', { status: 'rejected' }))
      await mountView()
      await switchTab('mine')
      expect(dotOf('mine_new')).toBeTruthy()

      getMineOutcomesUnseenCountSpy.mockResolvedValue({ count: 0 })
      const before = getMineOutcomesUnseenCountSpy.mock.calls.length
      ;(q('[data-el-row="mine_new"]') as HTMLElement).click()
      await flushUi(10)

      expect(markApprovalReadSpy).toHaveBeenCalledWith('mine_new')
      expect(dotOf('mine_new')).toBeNull()
      expect(getMineOutcomesUnseenCountSpy.mock.calls.length).toBeGreaterThan(before)
      expect(q('[data-testid="approval-mine-outcome-badge"]')).toBeNull()
    })

    it('the two switches are independent: only the enabled badge asks and renders', async () => {
      enabledFeatures.add('approvalMineOutcomeBadge')
      getMineOutcomesUnseenCountSpy.mockResolvedValue({ count: 3 })
      getCcUnreadCountSpy.mockResolvedValue({ count: 5 })
      await mountView()

      expect(getMineOutcomesUnseenCountSpy).toHaveBeenCalled()
      expect(getCcUnreadCountSpy).not.toHaveBeenCalled()
      expect(q('[data-testid="approval-mine-outcome-badge"]')?.getAttribute('data-badge-value')).toBe('3')
      expect(q('[data-testid="approval-cc-unread-badge"]')).toBeNull()
    })

    it('lock B: with both badges on, the header 待办 / 未读 numbers still come from the pending count only', async () => {
      enabledFeatures.add('approvalMineOutcomeBadge')
      enabledFeatures.add('approvalCcUnreadBadge')
      getPendingCountSpy.mockResolvedValue({ count: 2, unreadCount: 1 })
      getCcUnreadCountSpy.mockResolvedValue({ count: 4 })
      getMineOutcomesUnseenCountSpy.mockResolvedValue({ count: 6 })
      await mountView()

      const stats = Array.from(container!.querySelectorAll('.approval-center__stat strong')).map((el) => el.textContent)
      expect(stats).toEqual(['2', '1'])
      expect(q('[data-testid="approval-mine-outcome-badge"]')?.getAttribute('data-badge-value')).toBe('6')
      expect(q('[data-testid="approval-cc-unread-badge"]')?.getAttribute('data-badge-value')).toBe('4')
    })

    it('English locale: the badge tooltip is English', async () => {
      useLocale().setLocale('en')
      enabledFeatures.add('approvalMineOutcomeBadge')
      getMineOutcomesUnseenCountSpy.mockResolvedValue({ count: 1 })
      await mountView()

      expect(q('[data-tooltip-content="1 new outcome(s)"]')).toBeTruthy()
    })
  })
})
