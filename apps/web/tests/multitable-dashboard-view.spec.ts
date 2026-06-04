import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

// MetaDashboardView renders MetaChartRenderer, which now uses ECharts (needs a canvas absent in
// jsdom) → mock the runtime entry points so the dashboard mounts cleanly.
vi.mock('echarts/core', () => ({
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })),
  use: vi.fn(),
}))
vi.mock('echarts/charts', () => ({ BarChart: {}, LineChart: {}, PieChart: {} }))
vi.mock('echarts/components', () => ({ GridComponent: {}, TooltipComponent: {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))

import MetaDashboardView from '../src/multitable/components/MetaDashboardView.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import type { Dashboard, ChartConfig, ChartData, MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

function fakeDashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'dash_1',
    sheetId: 'sheet_1',
    name: 'My Dashboard',
    panels: [
      { id: 'panel_1', chartId: 'chart_1', size: 'medium', order: 0 },
    ],
    ...overrides,
  }
}

function fakeChart(overrides: Partial<ChartConfig> = {}): ChartConfig {
  return {
    id: 'chart_1',
    sheetId: 'sheet_1',
    name: 'Sales Chart',
    chartType: 'bar',
    dataSource: { sheetId: 'sheet_1', groupByFieldId: 'fld_status', aggregation: { function: 'count' } },
    ...overrides,
  }
}

const chartFields: MetaField[] = [
  { id: 'fld_status', name: 'Status', type: 'select' },
  { id: 'fld_amount', name: 'Amount', type: 'number' },
  { id: 'fld_hidden', name: 'Hidden', type: 'string', property: { hidden: true } },
  { id: 'fld_link', name: 'Link', type: 'link' },
]

const fakeChartData: ChartData = {
  chartType: 'bar',
  dataPoints: [
    { label: 'A', value: 10 },
    { label: 'B', value: 20 },
  ],
}

function mockClient(dashboards: Dashboard[] = [], charts: ChartConfig[] = [], chartData: ChartData = fakeChartData) {
  const ok = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const noContent = () => new Response(null, { status: 204 })

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('/dashboards') && !url.includes('/charts')) {
      return ok({ dashboards })
    }
    if (method === 'GET' && url.includes('/charts') && url.includes('/data')) {
      return ok(chartData)
    }
    if (method === 'GET' && url.includes('/charts')) {
      return ok({ charts })
    }
    if (method === 'POST' && url.includes('/charts')) {
      const body = JSON.parse(init?.body as string)
      return ok({
        id: 'chart_new',
        sheetId: 'sheet_1',
        name: body.name,
        type: body.type,
        dataSource: body.dataSource,
        display: body.display,
      })
    }
    if (method === 'POST' && url.includes('/dashboards')) {
      const body = JSON.parse(init?.body as string)
      return ok({ id: 'dash_new', sheetId: 'sheet_1', panels: [], ...body })
    }
    if (method === 'PATCH' && url.includes('/dashboards/')) {
      const body = JSON.parse(init?.body as string)
      const db = dashboards[0] ?? fakeDashboard()
      return ok({ ...db, ...body })
    }
    if (method === 'DELETE' && url.includes('/dashboards/')) {
      return noContent()
    }
    return ok({})
  })
  return { client: new MultitableApiClient({ fetchFn }), fetchFn }
}

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaDashboardView, props) })
  app.mount(container)
  return { container, app }
}

describe('MetaDashboardView', () => {
  afterEach(() => {
    useLocale().setLocale('en')
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('shows empty state when no dashboards exist', async () => {
    const { client } = mockClient([], [])
    const { container } = mount({ sheetId: 'sheet_1', client })
    await flushPromises()

    expect(container.querySelector('[data-empty]')).toBeTruthy()
  })

  it('renders dashboard with panels', async () => {
    const { client } = mockClient([fakeDashboard()], [fakeChart()])
    const { container } = mount({ sheetId: 'sheet_1', client })
    await flushPromises()

    const grid = container.querySelector('[data-grid]')
    expect(grid).toBeTruthy()
    const panels = container.querySelectorAll('[data-panel-id]')
    expect(panels.length).toBe(1)
  })

  it('renders a restricted chart-data notice in a dashboard panel', async () => {
    const restrictedData: ChartData = {
      chartType: 'bar',
      dataPoints: [],
      total: 0,
      metadata: { restricted: true, recordCount: 0 },
    }
    const { client } = mockClient([fakeDashboard()], [fakeChart()], restrictedData)
    const { container } = mount({ sheetId: 'sheet_1', client })
    await flushPromises()

    expect(container.querySelector('[data-chart-restricted]')).toBeTruthy()
    expect(container.textContent).toContain('Chart data restricted')
    expect(container.textContent).toContain('fields you cannot read')
  })

  it('creates a new dashboard', async () => {
    const { client, fetchFn } = mockClient([], [])
    const { container } = mount({ sheetId: 'sheet_1', client })
    await flushPromises()

    const createBtn = container.querySelector('[data-action="create-dashboard"]') as HTMLButtonElement
    expect(createBtn).toBeTruthy()
    createBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => url.includes('/dashboards') && init?.method === 'POST',
    )
    expect(postCalls.length).toBe(1)
  })

  it('can add a panel from chart picker', async () => {
    const dashboard = fakeDashboard({ panels: [] })
    const chart = fakeChart()
    const { client, fetchFn } = mockClient([dashboard], [chart])
    const { container } = mount({ sheetId: 'sheet_1', client })
    await flushPromises()

    const addPanelBtn = container.querySelector('[data-action="add-panel"]') as HTMLButtonElement
    addPanelBtn.click()
    await flushPromises()

    const chartOption = container.querySelector(`[data-chart-option="${chart.id}"]`) as HTMLElement
    expect(chartOption).toBeTruthy()
    chartOption.click()
    await flushPromises()

    // Should have called PATCH to update dashboard
    const patchCalls = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => url.includes('/dashboards/') && init?.method === 'PATCH',
    )
    expect(patchCalls.length).toBe(1)
  })

  it('creates a chart and adds it to the active dashboard panel list', async () => {
    const dashboard = fakeDashboard({ panels: [] })
    const { client, fetchFn } = mockClient([dashboard], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()

    const createChartBtn = container.querySelector('[data-action="create-chart"]') as HTMLButtonElement
    createChartBtn.click()
    await flushPromises()

    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Revenue by status'
    nameInput.dispatchEvent(new Event('input'))
    const aggregationSelect = container.querySelector('[data-field="chart-aggregation"]') as HTMLSelectElement
    aggregationSelect.value = 'sum'
    aggregationSelect.dispatchEvent(new Event('change'))
    await flushPromises()
    const valueSelect = container.querySelector('[data-field="chart-value-field"]') as HTMLSelectElement
    valueSelect.value = 'fld_amount'
    valueSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const submit = container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    submit.click()
    await flushPromises()

    const chartPosts = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => url.includes('/charts') && init?.method === 'POST',
    )
    expect(chartPosts.length).toBe(1)
    const chartBody = JSON.parse(chartPosts[0][1].body as string)
    expect(chartBody).toMatchObject({
      name: 'Revenue by status',
      type: 'bar',
      dataSource: {
        sheetId: 'sheet_1',
        groupByFieldId: 'fld_status',
        aggregation: { function: 'sum', fieldId: 'fld_amount' },
      },
      display: { title: 'Revenue by status' },
    })
    expect(chartBody.chartType).toBeUndefined()

    const dashboardPatches = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => url.includes('/dashboards/') && init?.method === 'PATCH',
    )
    expect(dashboardPatches.length).toBe(1)
    const dashboardBody = JSON.parse(dashboardPatches[0][1].body as string)
    expect(dashboardBody.panels).toEqual([
      expect.objectContaining({ chartId: 'chart_new', size: 'medium', order: 0 }),
    ])
    const dataLoads = fetchFn.mock.calls.filter(([url]: [string]) => url.includes('/charts/chart_new/data'))
    expect(dataLoads.length).toBe(1)
  })

  it('offers only chart-compatible fields and blocks value aggregations without a numeric field', async () => {
    const dashboard = fakeDashboard({ panels: [] })
    const { client, fetchFn } = mockClient([dashboard], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields.filter((field) => field.id !== 'fld_amount') })
    await flushPromises()

    const createChartBtn = container.querySelector('[data-action="create-chart"]') as HTMLButtonElement
    createChartBtn.click()
    await flushPromises()

    const groupSelect = container.querySelector('[data-field="chart-group-by"]') as HTMLSelectElement
    const groupValues = Array.from(groupSelect.options).map((option) => option.value)
    expect(groupValues).toContain('fld_status')
    expect(groupValues).not.toContain('fld_hidden')
    expect(groupValues).not.toContain('fld_link')

    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Needs value'
    nameInput.dispatchEvent(new Event('input'))
    const aggregationSelect = container.querySelector('[data-field="chart-aggregation"]') as HTMLSelectElement
    aggregationSelect.value = 'sum'
    aggregationSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    expect(container.textContent).toContain('No readable numeric fields available.')
    const submit = container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    submit.click()
    await flushPromises()

    const chartPosts = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => url.includes('/charts') && init?.method === 'POST',
    )
    expect(chartPosts.length).toBe(0)
  })

  it('can remove a panel', async () => {
    const { client, fetchFn } = mockClient([fakeDashboard()], [fakeChart()])
    const { container } = mount({ sheetId: 'sheet_1', client })
    await flushPromises()

    const removeBtn = container.querySelector('[data-action="remove-panel"]') as HTMLButtonElement
    expect(removeBtn).toBeTruthy()
    removeBtn.click()
    await flushPromises()

    const patchCalls = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => url.includes('/dashboards/') && init?.method === 'PATCH',
    )
    expect(patchCalls.length).toBe(1)
    const body = JSON.parse(patchCalls[0][1].body as string)
    expect(body.panels).toEqual([])
  })

  it('can resize a panel', async () => {
    const { client, fetchFn } = mockClient([fakeDashboard()], [fakeChart()])
    const { container } = mount({ sheetId: 'sheet_1', client })
    await flushPromises()

    const sizeSelect = container.querySelector('[data-field="panel-size"]') as HTMLSelectElement
    expect(sizeSelect).toBeTruthy()
    sizeSelect.value = 'large'
    sizeSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const patchCalls = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => url.includes('/dashboards/') && init?.method === 'PATCH',
    )
    expect(patchCalls.length).toBe(1)
    const body = JSON.parse(patchCalls[0][1].body as string)
    expect(body.panels[0].size).toBe('large')
  })

  it('localizes dashboard chrome and generated dashboard name while keeping chart names raw', async () => {
    useLocale().setLocale('zh-CN')
    const chart = fakeChart({ name: 'Sales Chart' })
    const { client, fetchFn } = mockClient([fakeDashboard()], [chart])
    const { container } = mount({ sheetId: 'sheet_1', client })
    await flushPromises()

    expect(container.textContent).toContain('重命名')
    expect(container.textContent).toContain('+ 添加面板')
    expect(container.textContent).toContain('+ 新建仪表板')
    expect(container.textContent).toContain('Sales Chart')
    expect(container.textContent).toContain('中')

    const addPanelBtn = container.querySelector('[data-action="add-panel"]') as HTMLButtonElement
    addPanelBtn.click()
    await flushPromises()
    expect(container.textContent).toContain('添加图表面板')

    const createBtn = container.querySelector('[data-action="create-dashboard"]') as HTMLButtonElement
    createBtn.click()
    await flushPromises()
    const postCalls = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => url.includes('/dashboards') && init?.method === 'POST',
    )
    const body = JSON.parse(postCalls[0][1].body as string)
    expect(body.name).toBe('仪表板 2')
    expect(container.querySelector('[data-action="rename"]')?.getAttribute('title')).toBe('重命名')
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0)
    expect(container.querySelectorAll('[title]')).toHaveLength(1)
    expect(container.querySelectorAll('[placeholder]')).toHaveLength(0)
  })
})
