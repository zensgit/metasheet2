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

// B2-04: id→name lookup for the template-keyed columns (按模板汇总 / TopN 最慢实例 / TopN SLA
// 风险模板 all render `templateDisplayName(row.templateId)`). Defaults to an empty page so the
// pre-existing tests below (which assert the RAW id 'tmpl-risk-1' renders) keep passing unless a
// test opts into a name mapping.
const listTemplatesSpy = vi.fn().mockResolvedValue({ data: [], total: 0 })

vi.mock('../src/approvals/api', () => ({
  fetchApprovalMetricsSummary: (query?: unknown) => fetchSummarySpy(query),
  fetchApprovalMetricsBreaches: () => fetchBreachesSpy(),
  fetchApprovalMetricsReport: (query?: unknown) => fetchReportSpy(query),
  listTemplates: (query?: unknown) => listTemplatesSpy(query),
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
    listTemplatesSpy.mockClear()
    listTemplatesSpy.mockResolvedValue({ data: [], total: 0 })
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

  // B2-04: template-keyed tables previously rendered the raw templateId (unscannable). Both TopN
  // tables key off the same 'tmpl-risk-1' fixture id, so a single listTemplates() mock covers both.
  it('B2-04: renders the mapped template NAME instead of the raw id once listTemplates resolves a match', async () => {
    listTemplatesSpy.mockResolvedValue({ data: [{ id: 'tmpl-risk-1', name: '采购审批' }], total: 1 })
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
    await flushPromises() // listTemplates resolves on a separate onMounted call — give it a beat

    expect(listTemplatesSpy).toHaveBeenCalledWith({ pageSize: 200 })
    expect(container!.textContent).toContain('采购审批')
    expect(container!.textContent).not.toContain('tmpl-risk-1')
    // routing is untouched by the display mapping — still routes by the real id.
    const buttons = Array.from(container!.querySelectorAll('button'))
    buttons.find((button) => button.textContent?.includes('采购审批'))?.click()
    expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-template-detail', params: { id: 'tmpl-risk-1' } })
  })

  it('B2-04: falls back to the raw template id when listTemplates has no match (and stays non-fatal on rejection)', async () => {
    listTemplatesSpy.mockResolvedValue({ data: [{ id: 'some-other-template', name: '别的模板' }], total: 1 })
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
    await flushPromises()

    expect(container!.textContent).toContain('tmpl-risk-1') // unmapped id → raw id fallback
    expect(container!.textContent).not.toContain('别的模板')
  })

  // B3-03 (看板钻取): the 按模板汇总 rows drill into the approvals list carrying that row's OWN
  // templateId (+ the shared date range, empty here since this harness's date-picker stub is
  // inert). This spec hosts the test because its ElTable stub renders scoped-slot cell content —
  // approvalMetricsView.spec.ts's count-only table stub cannot reach the per-row drill link.
  it('B3-03: a 按模板汇总 row drill link routes to the approvals list scoped to that row\'s templateId', async () => {
    fetchSummarySpy.mockResolvedValueOnce({
      total: 4, approved: 2, rejected: 1, revoked: 0, returned: 0, running: 1,
      avgDurationSeconds: 1800, p50DurationSeconds: 900, p95DurationSeconds: 7200,
      slaBreachCount: 2, slaCandidateCount: 4, slaBreachRate: 0.5,
      byTemplate: [{
        templateId: 'tmpl-risk-1',
        total: 4, approved: 2, rejected: 1, revoked: 0,
        avgDurationSeconds: 1800, slaBreachRate: 0.5,
      }],
    })
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

    const drill = container!.querySelector<HTMLButtonElement>('[data-testid="metric-template-drill-tmpl-risk-1"]')
    expect(drill, 'the per-template drill link renders in the 操作 column').toBeTruthy()
    drill!.click()

    expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-list', query: { templateId: 'tmpl-risk-1' } })
  })

  it('B2-04: a rejected listTemplates does not break the dashboard (non-fatal, falls back to raw ids)', async () => {
    listTemplatesSpy.mockRejectedValue(new Error('network error'))
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
    await flushPromises()

    expect(container!.textContent).toContain('TopN 最慢实例') // dashboard still renders
    expect(container!.textContent).toContain('tmpl-risk-1') // falls back to the raw id
  })
})
