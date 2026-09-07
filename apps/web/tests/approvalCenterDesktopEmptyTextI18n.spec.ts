/**
 * Report item O-8 (approval UI locale consistency) — ApprovalCenterView desktop empty-text i18n.
 *
 * Root cause (see the O-8 report): the DESKTOP `<ApprovalCenterTable>`'s `:empty-text` for all
 * five tabs (pending/mine/cc/completed/processed) was an unconditional Chinese literal
 * (`searchText ? '未找到匹配的审批' : '暂无待处理审批'`, etc.) even though the SAME five
 * strings were ALREADY locale-aware via `useLocale()`/`isZh` for the MOBILE
 * `<ApprovalMobileList>` path one prop down (see approvalMobileI18n.spec.ts). The computed was
 * only ever wired into the mobile branch; this pins the desktop branch — the majority case for an
 * operator on a desktop browser — onto the SAME shared computed (renamed from `mobileEmptyText`
 * to `tabEmptyText` since it now feeds both).
 *
 * This is a FRESH COPY of approval-center.spec.ts's mock/stub harness (not an edit to that shared
 * file — it has ~40 other tests with no stake in this fix, and editing its shared `ElTable` stub
 * to render the `#empty` slot has zero blast radius here but would be needless churn on a file
 * this large). The only functional change from the original harness: `ElTable`'s stub now renders
 * `slots.empty` when `data` is empty, mirroring the real el-table's `<template #empty>` behaviour
 * that stub previously ignored outright.
 *
 * RED-before: reverting ApprovalCenterView.vue's five `:empty-text` bindings back to the inline
 * Chinese-literal ternary makes the "en" test below fail (desktop would show Chinese regardless
 * of locale) while the "zh" test passes by coincidence (same literal).
 */
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
import { useLocale } from '../src/composables/useLocale'

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
        // Report item O-8: the real el-table renders <template #empty> when `data` is empty —
        // this stub previously ignored that slot entirely (irrelevant to every OTHER test in the
        // file this was copied from, none of which assert on empty-store table content).
        rows.length === 0 ? h('div', { 'data-el-table-empty': 'true' }, slots.empty?.()) : null,
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
      placeholder: this.placeholder,
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

describe('ApprovalCenterView — desktop empty-text i18n (report item O-8)', () => {
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


  function setLocale(locale: 'en' | 'zh-CN') {
    window.localStorage.setItem('metasheet_locale', locale)
    useLocale().setLocale(locale)
  }

  it('desktop pending-tab empty text follows the locale, not a hardcoded Chinese literal — "en"', async () => {
    setLocale('en')
    mockPendingApprovals.value = []
    await mountView()
    const empty = container!.querySelector('[data-el-empty]')
    expect(empty?.textContent).toBe('No pending approvals')
  })

  it('desktop pending-tab empty text follows the locale, not a hardcoded Chinese literal — "zh-CN"', async () => {
    setLocale('zh-CN')
    mockPendingApprovals.value = []
    await mountView()
    const empty = container!.querySelector('[data-el-empty]')
    expect(empty?.textContent).toBe('暂无待处理审批')
  })

  it('desktop pending-tab empty text distinguishes "no results for this search" from "nothing pending" in English', async () => {
    setLocale('en')
    mockPendingApprovals.value = []
    await mountView()
    const searchInput = container!.querySelector('[data-testid="approval-search-input"]') as HTMLInputElement
    searchInput.value = 'nonexistent'
    searchInput.dispatchEvent(new Event('input'))
    await flushUi()
    const empty = container!.querySelector('[data-el-empty]')
    expect(empty?.textContent).toBe('No matching approvals found')
  })

  it('desktop pending-tab empty text distinguishes "no results for this search" from "nothing pending" in Chinese', async () => {
    setLocale('zh-CN')
    mockPendingApprovals.value = []
    await mountView()
    const searchInput = container!.querySelector('[data-testid="approval-search-input"]') as HTMLInputElement
    searchInput.value = 'nonexistent'
    searchInput.dispatchEvent(new Event('input'))
    await flushUi()
    const empty = container!.querySelector('[data-el-empty]')
    expect(empty?.textContent).toBe('未找到匹配的审批')
  })

  it('the OTHER four desktop tabs (mine/cc/completed/processed) also follow the locale for their empty text', async () => {
    setLocale('en')
    mockMyApprovals.value = []
    mockCcApprovals.value = []
    mockCompletedApprovals.value = []
    mockProcessedApprovals.value = []
    await mountView()

    // This stubbed ElTabs/ElTabPane (unlike real Element Plus) renders every pane's content
    // unconditionally rather than lazily mounting only the active one — confirmed by this same
    // file's own "renders 5 tabs" test, which counts all 5 `[data-tab-pane]` nodes right after
    // mount with no tab switch. So all five ApprovalCenterTable empty states are already in the
    // DOM in template order (pending, mine, cc, completed, processed) with no drive needed.
    expect(container!.querySelectorAll('[data-tab-pane]').length).toBe(5)

    const emptyNodes = Array.from(container!.querySelectorAll('[data-el-empty]')).map((el) => el.textContent)
    expect(emptyNodes).toEqual([
      'No pending approvals',
      'No approvals initiated by you',
      'No approvals cc’d to you',
      'No completed approvals',
      'No approvals you have processed',
    ])
  })
  // -------------------------------------------------------------------------
  // Verification round (2026-09-08): every test above sets the locale BEFORE mountView(), so the
  // set passes identically whether `tabEmptyText` reads the shared locale reactively or took a
  // one-shot snapshot at setup time. This one pins the property the slice claims — the desktop
  // table's empty text FOLLOWS the shared shell locale on an ALREADY-MOUNTED page, through both
  // of useLocale's write paths (setLocale(), as App.vue:283 calls, and useLocale.ts:41-49's
  // cross-tab 'storage' listener).
  // Discriminating probe: freezing only the LOCALE read inside `tabEmptyText`
  // (`const frozen = isZh.value` hoisted out of the computed, keeping `searchText.value` live)
  // leaves every other test in this file GREEN — including both search-vs-default tests — and
  // turns exactly this one RED.
  // -------------------------------------------------------------------------
  it('desktop empty text follows a post-mount shell locale change, both via setLocale() and via a cross-tab storage event', async () => {
    setLocale('zh-CN')
    mockPendingApprovals.value = []
    await mountView()
    expect(container!.querySelector('[data-el-empty]')?.textContent).toBe('暂无待处理审批')

    // No remount: flip the SAME singleton the app shell writes to.
    useLocale().setLocale('en')
    await flushUi()
    expect(container!.querySelector('[data-el-empty]')?.textContent).toBe('No pending approvals')

    // And again through the cross-tab listener path.
    window.localStorage.setItem('metasheet_locale', 'zh-CN')
    window.dispatchEvent(new StorageEvent('storage', { key: 'metasheet_locale', newValue: 'zh-CN' }))
    await flushUi()
    expect(container!.querySelector('[data-el-empty]')?.textContent).toBe('暂无待处理审批')
  })
})
