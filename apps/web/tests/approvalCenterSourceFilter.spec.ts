/**
 * Wave 2 WP2 regression: ensure the ApprovalCenterView source filter maps
 * 1:1 to the `sourceSystem` query arg on the underlying list call.
 *
 * The view delegates loading to the Pinia store's `load{Pending|Mine|Cc|Completed}`
 * helpers — each accepts a query object that is forwarded verbatim to the
 * `/api/approvals` URL builder in `approvals/api.ts`. Asserting the store spy
 * argument is therefore equivalent to asserting the outgoing URL carries
 * `sourceSystem=plm` (or `=all`, `=platform`).
 */
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

// `useApprovalPermissions` touches localStorage on setup; the jsdom env
// provided by vitest does not always expose it depending on invocation path.
// Stub it so the view can mount cleanly in the unit-style spec.
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({
    canWrite: ref(true),
    canAct: ref(true),
    canRead: ref(true),
  }),
}))

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

// Minimal Element Plus stubs: the select component needs to expose
// `modelValue` plumbing so we can drive the filter change event.
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
    return h('div', { 'data-tab-pane': this.name, 'data-tab-label': this.label }, this.$slots.default?.())
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

/**
 * Preserve the same reactivity contract as el-select: emit
 * `update:modelValue` + `change` on value mutation. We expose the
 * attribute via `data-testid` so the test can locate the source filter
 * without depending on the stub's internal order in the DOM tree.
 */
const ElSelect = defineComponent({
  name: 'ElSelect',
  props: {
    modelValue: [String, Array],
    placeholder: String,
    clearable: Boolean,
  },
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
  props: { type: String },
  emits: ['click'],
  render() {
    return h('button', { 'data-el-button': this.type || 'default' }, this.$slots.default?.())
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

describe('ApprovalCenterView source filter (Wave 2 WP2)', () => {
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
    app.component('ElEmpty', ElEmpty)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  it('defaults the source filter to "all" on mount', async () => {
    await mountView()

    expect(loadPendingSpy).toHaveBeenCalledTimes(1)
    const [firstCallQuery] = loadPendingSpy.mock.calls[0] ?? []
    expect(firstCallQuery).toMatchObject({ sourceSystem: 'all' })
  })

  it('renders the source filter dropdown with all three options', async () => {
    await mountView()

    const filter = container!.querySelector('[data-testid="approval-source-filter"]')
    expect(filter).toBeTruthy()

    const options = filter!.querySelectorAll('option')
    const values = Array.from(options).map((option) => option.getAttribute('value'))
    expect(values).toEqual(expect.arrayContaining(['all', 'platform', 'plm']))
  })

  it('propagates sourceSystem=plm to the store when the filter switches to PLM', async () => {
    await mountView()

    const filter = container!.querySelector('[data-testid="approval-source-filter"]') as HTMLSelectElement
    expect(filter).toBeTruthy()

    filter.value = 'plm'
    filter.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    const [latestQuery] = loadPendingSpy.mock.calls.at(-1) ?? []
    expect(latestQuery).toMatchObject({ sourceSystem: 'plm' })
  })

  it('propagates sourceSystem=platform when the filter switches to platform', async () => {
    await mountView()

    const filter = container!.querySelector('[data-testid="approval-source-filter"]') as HTMLSelectElement
    expect(filter).toBeTruthy()

    filter.value = 'platform'
    filter.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    const [latestQuery] = loadPendingSpy.mock.calls.at(-1) ?? []
    expect(latestQuery).toMatchObject({ sourceSystem: 'platform' })
  })
})
