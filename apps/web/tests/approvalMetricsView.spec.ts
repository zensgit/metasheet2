import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'

// ---------------------------------------------------------------------------
// B — Approval analytics dashboard: the requester/department breakdown sections
// (按部门汇总 / 按发起人汇总) that surface `getMetricsByDimension`, the one metric
// the backend computes but the FE never rendered.
//
//   - department section (/teams, approvals:admin) always renders on the
//     admin-gated page.
//   - requester section (/people, approvals:analytics) renders + fetches ONLY
//     when hasPermission('approvals:analytics') is true (defense-in-depth; the
//     hard gate is the backend). Both branches exercised.
//   - read-only: only GET fetchers are called; the sole affordance (refresh)
//     re-reads.
//
// The api module is fully mocked so no fetch touches the mock-mode fixtures.
// ---------------------------------------------------------------------------

const pushSpy = vi.fn().mockResolvedValue(undefined)
vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy }),
  }
})

const hasPermissionSpy = vi.fn<(p: string) => boolean>(() => true)
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ hasPermission: hasPermissionSpy }),
}))

const summarySpy = vi.fn()
const reportSpy = vi.fn()
const breachesSpy = vi.fn()
const teamsSpy = vi.fn()
const peopleSpy = vi.fn()
// B2-04: id→name lookup for the template-keyed tables. Defaults to an empty page (falls back to
// raw ids); the mapped-name / fallback behaviour itself is covered in
// approvalMetricsTopnReport.spec.ts, whose stub can render table CELL content (this file's ElTable
// stub is count-only — see `rowsOf()` below — so it stays scoped to what it can assert here).
const listTemplatesSpy = vi.fn().mockResolvedValue({ data: [], total: 0 })
vi.mock('../src/approvals/api', () => ({
  fetchApprovalMetricsSummary: (...a: unknown[]) => summarySpy(...a),
  fetchApprovalMetricsReport: (...a: unknown[]) => reportSpy(...a),
  fetchApprovalMetricsBreaches: (...a: unknown[]) => breachesSpy(...a),
  fetchApprovalMetricsTeams: (...a: unknown[]) => teamsSpy(...a),
  fetchApprovalMetricsPeople: (...a: unknown[]) => peopleSpy(...a),
  listTemplates: (...a: unknown[]) => listTemplatesSpy(...a),
}))

function emptySummary() {
  return {
    total: 0, approved: 0, rejected: 0, revoked: 0, returned: 0, running: 0,
    avgDurationSeconds: null, p50DurationSeconds: null, p95DurationSeconds: null,
    slaBreachCount: 0, slaCandidateCount: 0, slaBreachRate: 0, byTemplate: [],
  }
}

const TEAM_ROWS = [
  { key: 'Engineering', name: 'Engineering', total: 24, approved: 20, rejected: 3, revoked: 1, avgDurationSeconds: 6800, slaBreachRate: 0.12 },
  { key: 'Sales', name: 'Sales', total: 15, approved: 12, rejected: 2, revoked: 1, avgDurationSeconds: 10200, slaBreachRate: 0.27 },
]
const PEOPLE_ROWS = [
  { key: 'u-1', name: 'Alice', total: 9, approved: 8, rejected: 1, revoked: 0, avgDurationSeconds: 5400, slaBreachRate: 0.11 },
]

// Element Plus stubs. ElTable surfaces its bound `data` length as data-rows so a
// stubbed table (which can't invoke scoped slots) still proves the mocked data
// reached the section.
function passthrough(name: string, tag = 'div') {
  return defineComponent({
    name,
    props: { modelValue: {}, type: String, loading: Boolean, title: String },
    emits: ['update:modelValue', 'click', 'change', 'close'],
    render() {
      return h(tag, { 'data-stub': name, onClick: (e: Event) => this.$emit('click', e) }, this.$slots.default?.())
    },
  })
}
const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, loading: Boolean },
  emits: ['click'],
  render() {
    return h('button', { 'data-el-button': this.type || 'default', onClick: (e: Event) => this.$emit('click', e) }, this.$slots.default?.())
  },
})
const ElCard = defineComponent({
  name: 'ElCard',
  render() {
    return h('div', { 'data-el-card': '' }, [
      this.$slots.header ? h('div', { 'data-el-card-header': '' }, this.$slots.header()) : null,
      this.$slots.default?.(),
    ])
  },
})
const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: { type: Array, default: () => [] } },
  render() {
    return h('div', { 'data-el-table': '', 'data-rows': String((this.data as unknown[]).length) })
  },
})
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String },
  render() { return h('div', { 'data-column': this.prop || this.label }) },
})
// Drives the shared date-range: clicking emits a v-model update + @change so the
// view re-runs loadAll with a concrete since/until. B2-04: also surfaces the bound `shortcuts`
// prop as a data attribute (labels only) so a test can assert the picker received presets
// without needing to simulate Element Plus's real shortcut-panel DOM.
const ElDatePicker = defineComponent({
  name: 'ElDatePicker',
  props: { modelValue: { type: Array, default: null }, shortcuts: { type: Array, default: () => [] } },
  emits: ['update:modelValue', 'change'],
  render() {
    return h('button', {
      'data-testid': 'set-date-range',
      'data-shortcut-labels': (this.shortcuts as Array<{ text: string }>).map((s) => s.text).join(','),
      onClick: () => {
        const range = ['2026-04-01', '2026-04-25']
        this.$emit('update:modelValue', range)
        this.$emit('change', range)
      },
    }, 'range')
  },
})

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mountView(): Promise<{ app: VueApp<Element>; container: HTMLDivElement }> {
  const { default: ApprovalMetricsView } = await import('../src/views/approval/ApprovalMetricsView.vue')
  const Host = defineComponent({ setup() { return () => h(ApprovalMetricsView as never) } })
  const app = createApp(Host)
  for (const name of ['ElAlert', 'ElLink']) app.component(name, passthrough(name))
  app.component('ElButton', ElButton)
  app.component('ElCard', ElCard)
  app.component('ElTable', ElTable)
  app.component('ElTableColumn', ElTableColumn)
  app.component('ElDatePicker', ElDatePicker)
  app.directive('loading', { mounted() {}, updated() {} })
  const container = document.createElement('div')
  document.body.appendChild(container)
  app.mount(container)
  await flushUi()
  return { app, container }
}

function rowsOf(container: HTMLElement, sectionTestId: string): number | null {
  const table = container.querySelector(`[data-testid="${sectionTestId}"] [data-el-table]`)
  return table ? Number(table.getAttribute('data-rows')) : null
}

describe('ApprovalMetricsView — B analytics breakdown sections', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    hasPermissionSpy.mockReset().mockReturnValue(true)
    summarySpy.mockReset().mockResolvedValue(emptySummary())
    reportSpy.mockReset().mockResolvedValue({ summary: emptySummary(), slowestInstances: [], breachedTemplates: [] })
    breachesSpy.mockReset().mockResolvedValue([])
    teamsSpy.mockReset().mockResolvedValue(TEAM_ROWS)
    peopleSpy.mockReset().mockResolvedValue(PEOPLE_ROWS)
    listTemplatesSpy.mockReset().mockResolvedValue({ data: [], total: 0 })
    pushSpy.mockClear()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  it('renders the department section from the mocked /teams fetcher', async () => {
    const m = await mountView()
    app = m.app; container = m.container

    expect(teamsSpy).toHaveBeenCalledTimes(1)
    // No date range set on load → limit only (the section's fixed depth).
    expect(teamsSpy).toHaveBeenCalledWith({ limit: 20 })
    expect(container.textContent).toContain('按部门汇总')
    expect(rowsOf(container, 'metrics-table-teams')).toBe(TEAM_ROWS.length)
  })

  it('renders the requester section + fetches /people when approvals:analytics is granted', async () => {
    hasPermissionSpy.mockReturnValue(true)
    const m = await mountView()
    app = m.app; container = m.container

    expect(hasPermissionSpy).toHaveBeenCalledWith('approvals:analytics')
    expect(peopleSpy).toHaveBeenCalledTimes(1)
    expect(peopleSpy).toHaveBeenCalledWith({ limit: 20 })
    expect(container.textContent).toContain('按发起人汇总')
    expect(rowsOf(container, 'metrics-table-people')).toBe(PEOPLE_ROWS.length)
  })

  it('hides the requester section AND does not fetch /people without approvals:analytics', async () => {
    hasPermissionSpy.mockReturnValue(false)
    const m = await mountView()
    app = m.app; container = m.container

    expect(peopleSpy).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="metrics-section-people"]')).toBeNull()
    expect(container.textContent).not.toContain('按发起人汇总')
    // The department section (admin-gated) is unaffected.
    expect(teamsSpy).toHaveBeenCalledTimes(1)
    expect(rowsOf(container, 'metrics-table-teams')).toBe(TEAM_ROWS.length)
  })

  it('read-only: only GET fetchers run; refresh re-reads the breakdowns', async () => {
    const m = await mountView()
    app = m.app; container = m.container

    expect(teamsSpy).toHaveBeenCalledTimes(1)
    expect(peopleSpy).toHaveBeenCalledTimes(1)

    const refresh = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('刷新'))
    expect(refresh, 'a 刷新 button exists').toBeTruthy()
    refresh!.click()
    await flushUi()

    // Refresh is a pure re-read of the same GET endpoints — never a mutation.
    expect(teamsSpy).toHaveBeenCalledTimes(2)
    expect(peopleSpy).toHaveBeenCalledTimes(2)
    expect(container.querySelector('form')).toBeNull()
  })

  it('propagates the shared date-range to the breakdown fetchers', async () => {
    const m = await mountView()
    app = m.app; container = m.container
    teamsSpy.mockClear()
    peopleSpy.mockClear()

    const picker = container.querySelector<HTMLButtonElement>('[data-testid="set-date-range"]')
    expect(picker, 'the date-range picker stub is present').toBeTruthy()
    picker!.click()
    await flushUi()

    const expected = { since: '2026-04-01T00:00:00Z', until: '2026-04-25T23:59:59Z', limit: 20 }
    expect(teamsSpy).toHaveBeenCalledWith(expected)
    expect(peopleSpy).toHaveBeenCalledWith(expected)
  })

  it('B2-04: the date-range picker receives quick-range shortcuts (近 7 天 / 近 30 天 / 本月)', async () => {
    const m = await mountView()
    app = m.app; container = m.container

    const picker = container.querySelector<HTMLButtonElement>('[data-testid="set-date-range"]')
    expect(picker, 'the date-range picker stub is present').toBeTruthy()
    const labels = picker!.getAttribute('data-shortcut-labels')?.split(',') ?? []
    expect(labels).toEqual(['近 7 天', '近 30 天', '本月'])
  })

  it('B2-04: fetches the template id→name lookup once on mount with a generous pageSize', async () => {
    const m = await mountView()
    app = m.app; container = m.container

    expect(listTemplatesSpy).toHaveBeenCalledTimes(1)
    expect(listTemplatesSpy).toHaveBeenCalledWith({ pageSize: 200 })

    // Refreshing re-reads the breakdowns but must NOT re-fetch the template lookup — it is a
    // once-on-mount catalog fetch, independent of the date range/refresh button.
    const refresh = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('刷新'))
    refresh!.click()
    await flushUi()
    expect(listTemplatesSpy).toHaveBeenCalledTimes(1)
  })

  it('B2-04: a rejected template lookup is non-fatal — the dashboard still renders', async () => {
    listTemplatesSpy.mockReset().mockRejectedValue(new Error('network error'))
    const m = await mountView()
    app = m.app; container = m.container

    expect(container.textContent).toContain('按部门汇总')
    expect(rowsOf(container, 'metrics-table-teams')).toBe(TEAM_ROWS.length)
  })

  // ---------------------------------------------------------------------------
  // B3-03 (看板钻取): every KPI tile deep-links into the approvals list. With no date range set,
  // the query is EMPTY (never a status filter — no tile maps to one); once the shared date range
  // is set, the link carries the SAME createdFrom/createdTo window the tile's own numbers were
  // computed over (identical day-start/day-end convention as the since/until the fetchers get).
  // ---------------------------------------------------------------------------
  it('B3-03: a KPI tile drill link routes to the approvals list with an EMPTY query when no date range is set', async () => {
    const m = await mountView()
    app = m.app; container = m.container

    const drill = container.querySelector<HTMLElement>('[data-testid="metric-total-drill"]')
    expect(drill, 'the 总量 tile has a drill link').toBeTruthy()
    drill!.click()

    expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-list', query: {} })
  })

  it('B3-03: a KPI tile drill link carries the tile\'s own createdFrom/createdTo window once the date range is set', async () => {
    const m = await mountView()
    app = m.app; container = m.container

    container.querySelector<HTMLButtonElement>('[data-testid="set-date-range"]')!.click()
    await flushUi()

    const drill = container.querySelector<HTMLElement>('[data-testid="metric-sla-rate-drill"]')
    expect(drill, 'the SLA 超时率 tile has a drill link').toBeTruthy()
    drill!.click()

    expect(pushSpy).toHaveBeenCalledWith({
      name: 'approval-list',
      query: {
        createdFrom: '2026-04-01T00:00:00Z',
        createdTo: '2026-04-25T23:59:59Z',
      },
    })
  })

  it('B3-03: all four KPI tiles expose a drill link', async () => {
    const m = await mountView()
    app = m.app; container = m.container

    for (const tile of ['metric-total-drill', 'metric-approval-rate-drill', 'metric-avg-duration-drill', 'metric-sla-rate-drill']) {
      expect(container.querySelector(`[data-testid="${tile}"]`), `${tile} exists`).toBeTruthy()
    }
  })
})
