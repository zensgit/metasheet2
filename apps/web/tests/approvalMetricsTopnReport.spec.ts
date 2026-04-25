import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  defineComponent,
  h,
  inject,
  nextTick,
  provide,
  reactive,
  type App as VueApp,
  type Slot,
} from 'vue'

const pushSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy }),
  }
})

const fetchSummarySpy = vi.fn().mockResolvedValue({
  total: 2,
  approved: 1,
  rejected: 0,
  revoked: 0,
  returned: 0,
  running: 1,
  avgDurationSeconds: 3600,
  p50DurationSeconds: 1800,
  p95DurationSeconds: 7200,
  slaBreachCount: 1,
  slaCandidateCount: 2,
  slaBreachRate: 0.5,
  byTemplate: [],
})
const fetchBreachesSpy = vi.fn().mockResolvedValue([])
const fetchReportSpy = vi.fn().mockResolvedValue({
  summary: {},
  slowestInstances: [{
    instanceId: 'apr-slow-1',
    templateId: 'tmpl-risk-1',
    startedAt: '2026-04-25T08:00:00Z',
    terminalAt: '2026-04-25T10:00:00Z',
    terminalState: 'approved',
    durationSeconds: 7200,
    slaHours: 1,
    slaBreached: true,
    slaBreachedAt: '2026-04-25T09:00:00Z',
  }],
  breachedTemplates: [{
    templateId: 'tmpl-risk-1',
    total: 4,
    slaCandidateCount: 4,
    slaBreachCount: 2,
    slaBreachRate: 0.5,
    avgDurationSeconds: 1800,
    p95DurationSeconds: 7200,
  }],
})

vi.mock('../src/approvals/api', () => ({
  fetchApprovalMetricsSummary: (query?: unknown) => fetchSummarySpy(query),
  fetchApprovalMetricsBreaches: () => fetchBreachesSpy(),
  fetchApprovalMetricsReport: (query?: unknown) => fetchReportSpy(query),
}))

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
const COLUMN_REGISTRY_KEY = Symbol('approval-metrics-table-columns')
let columnSeq = 0

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array, loading: Boolean, stripe: Boolean, emptyText: String },
  setup(props, { slots }) {
    const registry = reactive<ColumnRegistry>({
      columns: [],
      register(entry) {
        registry.columns.push(entry)
      },
    })
    provide(COLUMN_REGISTRY_KEY, registry)
    return () => {
      const columnInstances = slots.default?.() ?? []
      const rows = (props.data as any[] | undefined) ?? []
      return h('div', { 'data-el-table': 'true' }, [
        h('div', { style: 'display:none' }, columnInstances),
        ...rows.map((row, index) =>
          h('div', { 'data-el-row': String(index) },
            registry.columns.map((column) =>
              h('div', { 'data-el-cell': column.prop || column.label || column.key },
                column.defaultSlot ? column.defaultSlot({ row }) : String(row?.[column.prop ?? ''] ?? ''),
              ),
            ),
          ),
        ),
      ])
    }
  },
})

const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String, width: [String, Number], minWidth: [String, Number] },
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

const ElCard = defineComponent({
  name: 'ElCard',
  render() {
    return h('section', { 'data-el-card': 'true' }, [
      this.$slots.header?.(),
      this.$slots.default?.(),
    ])
  },
})

const ElLink = defineComponent({
  name: 'ElLink',
  emits: ['click'],
  render() {
    return h('button', { type: 'button', onClick: () => this.$emit('click') }, this.$slots.default?.())
  },
})

const ElButton = defineComponent({
  name: 'ElButton',
  emits: ['click'],
  render() {
    return h('button', { type: 'button', onClick: () => this.$emit('click') }, this.$slots.default?.())
  },
})

const ElDatePicker = defineComponent({
  name: 'ElDatePicker',
  render() {
    return h('input', { 'data-el-date-picker': 'true' })
  },
})

const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String },
  render() {
    return h('div', { 'data-el-alert': 'true' }, this.title)
  },
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe('ApprovalMetricsView TopN report', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    pushSpy.mockClear()
    fetchSummarySpy.mockClear()
    fetchBreachesSpy.mockClear()
    fetchReportSpy.mockClear()
    columnSeq = 0
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    app = null
    container?.remove()
    container = null
  })

  it('loads and renders TopN slowest instances and breached templates', async () => {
    const { default: ApprovalMetricsView } = await import('../src/views/approval/ApprovalMetricsView.vue')
    app = createApp(ApprovalMetricsView)
    app.component('ElAlert', ElAlert)
    app.component('ElButton', ElButton)
    app.component('ElCard', ElCard)
    app.component('ElDatePicker', ElDatePicker)
    app.component('ElLink', ElLink)
    app.component('ElTable', ElTable)
    app.component('ElTableColumn', ElTableColumn)
    app.directive('loading', {})
    app.mount(container!)

    await flushPromises()

    expect(fetchReportSpy).toHaveBeenCalledWith({ limit: 10 })
    expect(container!.textContent).toContain('TopN 最慢实例')
    expect(container!.textContent).toContain('TopN SLA 风险模板')
    expect(container!.textContent).toContain('apr-slow-1')
    expect(container!.textContent).toContain('tmpl-risk-1')
    expect(container!.textContent).toContain('2.00h')
    expect(container!.textContent).toContain('50.0%')
  })

  it('routes from TopN row links to approval detail and template detail', async () => {
    const { default: ApprovalMetricsView } = await import('../src/views/approval/ApprovalMetricsView.vue')
    app = createApp(ApprovalMetricsView)
    app.component('ElAlert', ElAlert)
    app.component('ElButton', ElButton)
    app.component('ElCard', ElCard)
    app.component('ElDatePicker', ElDatePicker)
    app.component('ElLink', ElLink)
    app.component('ElTable', ElTable)
    app.component('ElTableColumn', ElTableColumn)
    app.directive('loading', {})
    app.mount(container!)
    await flushPromises()

    const buttons = Array.from(container!.querySelectorAll('button'))
    buttons.find((button) => button.textContent?.includes('apr-slow-1'))?.click()
    buttons.find((button) => button.textContent?.includes('tmpl-risk-1'))?.click()

    expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-detail', params: { id: 'apr-slow-1' } })
    expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-template-detail', params: { id: 'tmpl-risk-1' } })
  })
})
