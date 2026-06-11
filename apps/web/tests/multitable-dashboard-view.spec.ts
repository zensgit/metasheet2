import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

async function settleMicrotasksAndRender() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

// MetaDashboardView renders MetaChartRenderer, which now uses ECharts (needs a canvas absent in
// jsdom) → mock the runtime entry points so the dashboard mounts cleanly.
vi.mock('echarts/core', () => ({
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })),
  use: vi.fn(),
}))
vi.mock('echarts/charts', () => ({ BarChart: {}, LineChart: {}, PieChart: {}, FunnelChart: {}, GaugeChart: {}, ScatterChart: {} }))
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
  { id: 'fld_date', name: 'Created', type: 'date' },
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
    if (method === 'PATCH' && url.includes('/charts/')) {
      const body = JSON.parse(init?.body as string)
      const chartId = url.split('/charts/')[1]
      return ok({ id: chartId, sheetId: 'sheet_1', name: body.name, chartType: body.chartType, dataSource: body.dataSource, displayConfig: body.displayConfig })
    }
    if (method === 'DELETE' && url.includes('/charts/')) {
      return noContent()
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
  // S1-9: MetaChartRenderer is an async chunk (defineAsyncComponent). Resolve its loader ONCE up
  // front (real timers) so every test — including the fake-timer preview tests — renders the
  // cached component the same tick its chart data lands, exactly like the old static import.
  beforeAll(async () => {
    const { client } = mockClient([fakeDashboard()], [fakeChart()])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ render: () => h(MetaDashboardView, { sheetId: 'sheet_1', client }) })
    app.mount(container)
    // Wall-clock bound, not an iteration count: under full-suite load the first module
    // transform of the renderer chunk can outlast many setTimeout(0) round-trips.
    const deadline = Date.now() + 10_000
    while (!container.querySelector('[data-chart-canvas]') && Date.now() < deadline) {
      await flushPromises()
    }
    expect(container.querySelector('[data-chart-canvas]')).toBeTruthy()
    app.unmount()
    document.body.innerHTML = ''
    // Explicit hook timeout > the in-loop 10s deadline so a pathological stall fails on the
    // assertion above (loud), never on vitest's default hook timeout (review N2).
  }, 15_000)

  afterEach(() => {
    vi.useRealTimers()
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

  it('r12 scatter: shows x/y/color/size pickers + hides grouped pickers, and gates save on x && y', async () => {
    const dashboard = fakeDashboard({ panels: [] })
    const { client, fetchFn } = mockClient([dashboard], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()

    ;(container.querySelector('[data-action="create-chart"]') as HTMLButtonElement).click()
    await flushPromises()

    // grouped pickers are shown for the default (bar) type
    expect(container.querySelector('[data-field="chart-group-by"]')).toBeTruthy()
    expect(container.querySelector('[data-field="chart-aggregation"]')).toBeTruthy()
    expect(container.querySelector('[data-field="chart-x-field"]')).toBeNull()

    const typeSelect = container.querySelector('[data-field="chart-type"]') as HTMLSelectElement
    typeSelect.value = 'scatter'
    typeSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    // scatter HIDES groupBy/aggregation/series/bar-mode and SHOWS x/y/color/size
    expect(container.querySelector('[data-field="chart-group-by"]')).toBeNull()
    expect(container.querySelector('[data-field="chart-aggregation"]')).toBeNull()
    expect(container.querySelector('[data-field="chart-series-by"]')).toBeNull()
    expect(container.querySelector('[data-field="chart-x-field"]')).toBeTruthy()
    expect(container.querySelector('[data-field="chart-y-field"]')).toBeTruthy()
    expect(container.querySelector('[data-field="chart-color-field"]')).toBeTruthy()
    expect(container.querySelector('[data-field="chart-size-field"]')).toBeTruthy()

    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Amount vs Amount'
    nameInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const submit = container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement
    // x and y both required — disabled with neither, then only x, then enabled with both
    expect(submit.disabled).toBe(true)

    const xSelect = container.querySelector('[data-field="chart-x-field"]') as HTMLSelectElement
    xSelect.value = 'fld_amount'
    xSelect.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(submit.disabled).toBe(true) // still missing y

    const ySelect = container.querySelector('[data-field="chart-y-field"]') as HTMLSelectElement
    ySelect.value = 'fld_amount'
    ySelect.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(submit.disabled).toBe(false)

    submit.click()
    await flushPromises()

    const chartPosts = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => url.includes('/charts') && init?.method === 'POST',
    )
    expect(chartPosts.length).toBe(1)
    const chartBody = JSON.parse(chartPosts[0][1].body as string)
    // the client maps chartType -> type and dataSource/displayConfig -> dataSource/display on the wire
    expect(chartBody).toMatchObject({
      name: 'Amount vs Amount',
      type: 'scatter',
      dataSource: { sheetId: 'sheet_1', xFieldId: 'fld_amount', yFieldId: 'fld_amount' },
    })
    // scatter payload carries NO grouped fields
    expect(chartBody.dataSource.groupByFieldId).toBeUndefined()
    expect(chartBody.dataSource.seriesByFieldId).toBeUndefined()
  })

  it('loads a debounced live preview without gating chart save', async () => {
    const dashboard = fakeDashboard({ panels: [] })
    const { client } = mockClient([dashboard], [])
    const previewSpy = vi.spyOn(client, 'previewChartData').mockResolvedValue({
      chartType: 'number',
      dataPoints: [{ label: 'Preview total', value: 42 }],
      total: 42,
    })
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()

    vi.useFakeTimers()
    ;(container.querySelector('[data-action="create-chart"]') as HTMLButtonElement).click()
    await nextTick()
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Preview chart'
    nameInput.dispatchEvent(new Event('input'))
    await nextTick()

    const submit = container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    expect(previewSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)
    await nextTick()

    expect(previewSpy).toHaveBeenCalledTimes(1)
    expect(previewSpy).toHaveBeenCalledWith('sheet_1', expect.objectContaining({
      name: 'Preview chart',
      dataSource: expect.objectContaining({ groupByFieldId: 'fld_status' }),
    }))
    const previewNumber = container.querySelector('[data-chart-preview-result] [data-chart="number"]')
    expect(previewNumber?.textContent).toContain('42')
    expect(submit.disabled).toBe(false)
  })

  it('drops stale live-preview responses when chart draft changes quickly', async () => {
    const dashboard = fakeDashboard({ panels: [] })
    const { client } = mockClient([dashboard], [])
    const resolvers: Array<(value: ChartData) => void> = []
    vi.spyOn(client, 'previewChartData').mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve)
    }))
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()

    vi.useFakeTimers()
    ;(container.querySelector('[data-action="create-chart"]') as HTMLButtonElement).click()
    await nextTick()
    const typeSelect = container.querySelector('[data-field="chart-type"]') as HTMLSelectElement
    typeSelect.value = 'number'
    typeSelect.dispatchEvent(new Event('change'))
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'First preview'
    nameInput.dispatchEvent(new Event('input'))
    await nextTick()

    await vi.advanceTimersByTimeAsync(300)
    expect(resolvers).toHaveLength(1)

    nameInput.value = 'Second preview'
    nameInput.dispatchEvent(new Event('input'))
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)
    expect(resolvers).toHaveLength(2)

    resolvers[1]({ chartType: 'number', dataPoints: [{ label: 'new', value: 2 }], total: 2 })
    await settleMicrotasksAndRender()
    const previewNumber = () => container.querySelector('[data-chart-preview-result] [data-chart="number"]')?.textContent ?? ''
    expect(previewNumber()).toContain('2')

    resolvers[0]({ chartType: 'number', dataPoints: [{ label: 'old', value: 1 }], total: 1 })
    await settleMicrotasksAndRender()
    expect(previewNumber()).toContain('2')
    expect(previewNumber()).not.toContain('1')
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

  // ---- v2-b1: edit / delete an existing chart from the chart list ----

  it('edits an existing chart from the chart list (reuses the form) and re-pulls its data', async () => {
    const chart = fakeChart()
    const { client, fetchFn } = mockClient([fakeDashboard()], [chart])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()

    // open the chart list (add-panel modal) and click edit on the chart row
    ;(container.querySelector('[data-action="add-panel"]') as HTMLButtonElement).click()
    await nextTick()
    const editBtn = container.querySelector(`[data-edit-chart="${chart.id}"]`) as HTMLButtonElement
    expect(editBtn).toBeTruthy()
    editBtn.click()
    await nextTick()

    // form is pre-filled from the existing chart config (reused create form, edit mode)
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    expect(nameInput.value).toBe('Sales Chart')
    expect(container.querySelector('[data-modal="create-chart"]')?.textContent).toContain('Edit chart')

    nameInput.value = 'Renamed Chart'
    nameInput.dispatchEvent(new Event('input'))
    await nextTick()
    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()

    // updateChart → PATCH /charts/<id> with the edited config
    const patchChart = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => init?.method === 'PATCH' && url.includes(`/charts/${chart.id}`),
    )
    expect(patchChart.length).toBe(1)
    expect(JSON.parse(patchChart[0][1].body as string).name).toBe('Renamed Chart')

    // its chart data is re-pulled (initial panel load + the post-edit refetch)
    const dataLoads = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => (init?.method ?? 'GET') === 'GET' && url.includes(`/charts/${chart.id}/data`),
    )
    expect(dataLoads.length).toBeGreaterThanOrEqual(2)

    // edit path must NOT create a new chart
    const chartPosts = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => init?.method === 'POST' && url.includes('/charts'),
    )
    expect(chartPosts.length).toBe(0)
  })

  it('edit preserves config the minimal form does not model (display options + dataSource extras)', async () => {
    // The server shallow-replaces dataSource/displayConfig with the sent objects, so edit must
    // overlay onto the existing config. Carry display options (typed) + a dataSource extra
    // (filter — a backend runtime field absent from the frontend type) and assert both survive.
    const chart = fakeChart({
      displayConfig: { title: 'Sales Chart', showLegend: false, colorScheme: 'cool' },
      dataSource: { sheetId: 'sheet_1', groupByFieldId: 'fld_status', aggregation: { function: 'count' }, filter: [{ fieldId: 'fld_status', operator: 'is', value: 'open' }] } as ChartConfig['dataSource'],
    })
    const { client, fetchFn } = mockClient([fakeDashboard()], [chart])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()

    ;(container.querySelector('[data-action="add-panel"]') as HTMLButtonElement).click()
    await nextTick()
    ;(container.querySelector(`[data-edit-chart="${chart.id}"]`) as HTMLButtonElement).click()
    await nextTick()
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Renamed'
    nameInput.dispatchEvent(new Event('input'))
    await nextTick()
    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()

    const patch = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'PATCH' && url.includes(`/charts/${chart.id}`),
    )
    const body = JSON.parse(patch![1].body as string)
    // client maps displayConfig→`display` on the wire; the overlay must preserve unmodeled fields
    expect(body.display.showLegend).toBe(false) // preserved (not in the form)
    expect(body.display.colorScheme).toBe('cool') // preserved
    expect(body.display.title).toBe('Renamed') // form owns the title
    expect(body.dataSource.filter).toEqual([{ fieldId: 'fld_status', operator: 'is', value: 'open' }]) // preserved
    expect(body.dataSource.groupByFieldId).toBe('fld_status') // form owns grouping
  })

  it('edits a date-grouped chart without requiring a group field and preserves date grouping', async () => {
    const chart = fakeChart({
      dataSource: {
        sheetId: 'sheet_1',
        dateFieldId: 'fld_date',
        dateGrouping: 'month',
        aggregation: { function: 'count' },
      },
    })
    const { client, fetchFn } = mockClient([fakeDashboard()], [chart])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()

    ;(container.querySelector('[data-action="add-panel"]') as HTMLButtonElement).click()
    await nextTick()
    ;(container.querySelector(`[data-edit-chart="${chart.id}"]`) as HTMLButtonElement).click()
    await nextTick()

    const groupSelect = container.querySelector('[data-field="chart-group-by"]') as HTMLSelectElement
    expect(groupSelect.disabled).toBe(true)
    expect(groupSelect.value).toBe('')
    expect(container.querySelector('[data-hint="date-grouping-locked"]')?.textContent).toContain('Grouped by date')

    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Renamed date chart'
    nameInput.dispatchEvent(new Event('input'))
    await nextTick()

    const submit = container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    submit.click()
    await flushPromises()

    const patch = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'PATCH' && url.includes(`/charts/${chart.id}`),
    )
    const body = JSON.parse(patch![1].body as string)
    expect(body.name).toBe('Renamed date chart')
    expect(body.dataSource.dateFieldId).toBe('fld_date')
    expect(body.dataSource.dateGrouping).toBe('month')
    expect(body.dataSource.groupByFieldId).toBeUndefined()
  })

  it('v2-d-b3: editing a date-grouped chart exposes an enabled series picker; PATCH carries the series + preserves date grouping', async () => {
    const chart = fakeChart({
      chartType: 'line',
      dataSource: { sheetId: 'sheet_1', dateFieldId: 'fld_date', dateGrouping: 'month', aggregation: { function: 'count' } },
    })
    const { client, fetchFn } = mockClient([fakeDashboard()], [chart])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    ;(container.querySelector('[data-action="add-panel"]') as HTMLButtonElement).click()
    await nextTick()
    ;(container.querySelector(`[data-edit-chart="${chart.id}"]`) as HTMLButtonElement).click()
    await nextTick()

    // groupBy stays disabled (date is the primary), but the series picker is now SHOWN + ENABLED (b3)
    expect((container.querySelector('[data-field="chart-group-by"]') as HTMLSelectElement).disabled).toBe(true)
    const series = container.querySelector('[data-field="chart-series-by"]') as HTMLSelectElement
    expect(series).toBeTruthy()
    expect(series.disabled).toBe(false) // enabled because the date axis is the primary, even with no groupBy
    series.value = 'fld_amount'; series.dispatchEvent(new Event('change')); await nextTick()

    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()
    const patch = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'PATCH' && url.includes(`/charts/${chart.id}`),
    )
    const body = JSON.parse(patch![1].body as string)
    expect(body.dataSource.seriesByFieldId).toBe('fld_amount') // series added on a date-grouped chart
    expect(body.dataSource.dateFieldId).toBe('fld_date')        // date grouping preserved
    expect(body.dataSource.dateGrouping).toBe('month')
    expect(body.dataSource.groupByFieldId).toBeUndefined()      // no spurious groupBy
    expect(body.display.barMode).toBeUndefined()                // line → no barMode
  })

  it('v2-d-b3: changing ONLY the series field on a date-grouped chart re-requests the live preview', async () => {
    const chart = fakeChart({
      chartType: 'line',
      dataSource: { sheetId: 'sheet_1', dateFieldId: 'fld_date', dateGrouping: 'month', aggregation: { function: 'count' } },
    })
    const { client } = mockClient([fakeDashboard()], [chart])
    const previewSpy = vi.spyOn(client, 'previewChartData').mockResolvedValue({ chartType: 'line', dataPoints: [{ label: '2026-01', value: 1 }] })
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    vi.useFakeTimers()
    ;(container.querySelector('[data-action="add-panel"]') as HTMLButtonElement).click()
    await nextTick()
    ;(container.querySelector(`[data-edit-chart="${chart.id}"]`) as HTMLButtonElement).click()
    await nextTick()
    await vi.advanceTimersByTimeAsync(300); await nextTick() // let the on-open preview settle
    previewSpy.mockClear()

    // change ONLY the series field — must re-trigger the debounced preview (the watcher-dep bug)
    const series = container.querySelector('[data-field="chart-series-by"]') as HTMLSelectElement
    series.value = 'fld_amount'; series.dispatchEvent(new Event('change')); await nextTick()
    await vi.advanceTimersByTimeAsync(300); await nextTick()

    expect(previewSpy).toHaveBeenCalledTimes(1)
    expect(previewSpy).toHaveBeenLastCalledWith('sheet_1', expect.objectContaining({
      dataSource: expect.objectContaining({ seriesByFieldId: 'fld_amount' }),
    }))
    vi.useRealTimers()
  })

  it('deletes a chart from the chart list (after confirm) and prunes the panel that showed it', async () => {
    const chart = fakeChart()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { client, fetchFn } = mockClient([fakeDashboard()], [chart])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()

    ;(container.querySelector('[data-action="add-panel"]') as HTMLButtonElement).click()
    await nextTick()
    const delBtn = container.querySelector(`[data-delete-chart="${chart.id}"]`) as HTMLButtonElement
    expect(delBtn).toBeTruthy()
    delBtn.click()
    await flushPromises()

    const delCalls = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => init?.method === 'DELETE' && url.includes(`/charts/${chart.id}`),
    )
    expect(delCalls.length).toBe(1)

    // the only panel referenced the deleted chart → pruned via updateDashboard
    const patchDb = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => init?.method === 'PATCH' && url.includes('/dashboards/'),
    )
    expect(patchDb.length).toBe(1)
    expect(JSON.parse(patchDb[0][1].body as string).panels).toEqual([])
    confirmSpy.mockRestore()
  })

  it('does not delete a chart when confirm is declined', async () => {
    const chart = fakeChart()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { client, fetchFn } = mockClient([fakeDashboard()], [chart])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()

    ;(container.querySelector('[data-action="add-panel"]') as HTMLButtonElement).click()
    await nextTick()
    ;(container.querySelector(`[data-delete-chart="${chart.id}"]`) as HTMLButtonElement).click()
    await flushPromises()

    const delCalls = fetchFn.mock.calls.filter(
      ([url, init]: [string, RequestInit?]) => init?.method === 'DELETE' && url.includes(`/charts/${chart.id}`),
    )
    expect(delCalls.length).toBe(0)
    confirmSpy.mockRestore()
  })

  // ---- v2-c: donut / area single-series render variants (displayConfig.variant) ----

  const openCreateForm = async (container: HTMLElement) => {
    ;(container.querySelector('[data-action="create-chart"]') as HTMLButtonElement).click()
    await nextTick()
  }
  const setSelect = async (el: HTMLSelectElement, value: string) => {
    el.value = value
    el.dispatchEvent(new Event('change'))
    await nextTick()
  }
  const typeSelectOf = (c: HTMLElement) => c.querySelector('[data-field="chart-type"]') as HTMLSelectElement
  const variantSelectOf = (c: HTMLElement) => c.querySelector('[data-field="chart-variant"]') as HTMLSelectElement | null

  it('v2-c: variant select shows only for pie/line and offers donut/area respectively', async () => {
    const { client } = mockClient([fakeDashboard({ panels: [] })], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    await openCreateForm(container)
    const typeSelect = typeSelectOf(container)

    await setSelect(typeSelect, 'bar')
    expect(variantSelectOf(container)).toBeNull()
    await setSelect(typeSelect, 'pie')
    expect(Array.from(variantSelectOf(container)!.options).map((o) => o.value)).toEqual(['', 'donut'])
    await setSelect(typeSelect, 'line')
    expect(Array.from(variantSelectOf(container)!.options).map((o) => o.value)).toEqual(['', 'area'])
    await setSelect(typeSelect, 'number')
    expect(variantSelectOf(container)).toBeNull()
  })

  it('v2-c: create carries displayConfig.variant (pie + donut)', async () => {
    const { client, fetchFn } = mockClient([fakeDashboard({ panels: [] })], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    await openCreateForm(container)
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Donut'; nameInput.dispatchEvent(new Event('input')); await nextTick()
    await setSelect(typeSelectOf(container), 'pie')
    await setSelect(variantSelectOf(container)!, 'donut')
    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()

    const post = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'POST' && url.includes('/charts') && !url.includes('preview-data'),
    )
    const body = JSON.parse(post![1].body as string)
    expect(body.type).toBe('pie')
    expect(body.display.variant).toBe('donut') // wire maps displayConfig -> display
  })

  it('v2-c: switching chartType clears an inapplicable variant (donut -> bar drops it)', async () => {
    const { client, fetchFn } = mockClient([fakeDashboard({ panels: [] })], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    await openCreateForm(container)
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Switcher'; nameInput.dispatchEvent(new Event('input')); await nextTick()
    await setSelect(typeSelectOf(container), 'pie')
    await setSelect(variantSelectOf(container)!, 'donut')
    await setSelect(typeSelectOf(container), 'bar') // @change clears variant
    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()

    const post = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'POST' && url.includes('/charts') && !url.includes('preview-data'),
    )
    const body = JSON.parse(post![1].body as string)
    expect(body.type).toBe('bar')
    expect(body.display.variant).toBeUndefined()
  })

  it('v2-c: edit carries displayConfig.variant', async () => {
    const chart = fakeChart({ chartType: 'pie' })
    const { client, fetchFn } = mockClient([fakeDashboard()], [chart])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    ;(container.querySelector('[data-action="add-panel"]') as HTMLButtonElement).click()
    await nextTick()
    ;(container.querySelector(`[data-edit-chart="${chart.id}"]`) as HTMLButtonElement).click()
    await nextTick()
    await setSelect(variantSelectOf(container)!, 'donut')
    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()

    const patch = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'PATCH' && url.includes(`/charts/${chart.id}`),
    )
    expect(JSON.parse(patch![1].body as string).display.variant).toBe('donut')
  })

  it('v2-c: editing an existing donut chart preserves variant on a no-op (round-trip)', async () => {
    // The v2-b1 config-loss trap: openEditChart must pre-fill the variant, else a
    // name-only edit would drop it (buildChartInput always sets variant explicitly).
    const chart = fakeChart({ chartType: 'pie', displayConfig: { title: 'Sales Chart', variant: 'donut' } })
    const { client, fetchFn } = mockClient([fakeDashboard()], [chart])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    ;(container.querySelector('[data-action="add-panel"]') as HTMLButtonElement).click()
    await nextTick()
    ;(container.querySelector(`[data-edit-chart="${chart.id}"]`) as HTMLButtonElement).click()
    await nextTick()
    // change ONLY the name; never touch the variant select
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Renamed'; nameInput.dispatchEvent(new Event('input')); await nextTick()
    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()

    const patch = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'PATCH' && url.includes(`/charts/${chart.id}`),
    )
    const body = JSON.parse(patch![1].body as string)
    expect(body.display.variant).toBe('donut') // preserved, not dropped
    expect(body.name).toBe('Renamed')
  })

  it('v2-c: live preview carries displayConfig.variant (same config as save)', async () => {
    const { client } = mockClient([fakeDashboard({ panels: [] })], [])
    const previewSpy = vi.spyOn(client, 'previewChartData').mockResolvedValue({ chartType: 'pie', dataPoints: [{ label: 'A', value: 1 }] })
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    vi.useFakeTimers()
    await openCreateForm(container)
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Preview donut'; nameInput.dispatchEvent(new Event('input')); await nextTick()
    await setSelect(typeSelectOf(container), 'pie')
    await setSelect(variantSelectOf(container)!, 'donut')

    await vi.advanceTimersByTimeAsync(300)
    await nextTick()
    expect(previewSpy).toHaveBeenLastCalledWith('sheet_1', expect.objectContaining({
      chartType: 'pie',
      displayConfig: expect.objectContaining({ variant: 'donut' }),
    }))
    vi.useRealTimers()
  })

  // ---- v2-d: stacked-bar series picker (seriesByFieldId) ----

  const aggSelectOf = (c: HTMLElement) => c.querySelector('[data-field="chart-aggregation"]') as HTMLSelectElement
  const groupBySelectOf = (c: HTMLElement) => c.querySelector('[data-field="chart-group-by"]') as HTMLSelectElement
  const seriesSelectOf = (c: HTMLElement) => c.querySelector('[data-field="chart-series-by"]') as HTMLSelectElement | null

  const barModeSelectOf = (c: HTMLElement) => c.querySelector('[data-field="chart-bar-mode"]') as HTMLSelectElement | null

  it('v2-d-b1: series picker shows for any bar chart; barMode appears once a series is chosen', async () => {
    const { client } = mockClient([fakeDashboard({ panels: [] })], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    await openCreateForm(container)
    const typeSelect = typeSelectOf(container)
    const aggSelect = aggSelectOf(container)

    // default bar + count: picker shown, but barMode hidden until a series is picked
    expect(seriesSelectOf(container)).toBeTruthy()
    expect(barModeSelectOf(container)).toBeNull()
    await setSelect(seriesSelectOf(container)!, 'fld_amount')
    // additive → barMode offers stacked + grouped
    expect(Array.from(barModeSelectOf(container)!.options).map((o) => o.value)).toEqual(['stacked', 'grouped'])
    // bar + avg (non-additive): picker STILL shown (grouped allows it); barMode offers grouped only
    await setSelect(aggSelect, 'avg')
    expect(seriesSelectOf(container)).toBeTruthy()
    expect(Array.from(barModeSelectOf(container)!.options).map((o) => o.value)).toEqual(['grouped'])
    // v2-d-b2: line shows the picker too, but NEVER the barMode control (lines don't stack/group)
    await setSelect(typeSelect, 'line')
    expect(seriesSelectOf(container)).toBeTruthy()
    expect(barModeSelectOf(container)).toBeNull()
    // number → both hidden
    await setSelect(typeSelect, 'number')
    expect(seriesSelectOf(container)).toBeNull()
    expect(barModeSelectOf(container)).toBeNull()
  })

  it('v2-d: series picker is disabled without a primary groupBy', async () => {
    const { client } = mockClient([fakeDashboard({ panels: [] })], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    await openCreateForm(container)
    expect(seriesSelectOf(container)!.disabled).toBe(false)    // groupBy defaults to first groupable field
    await setSelect(groupBySelectOf(container), '')
    expect(seriesSelectOf(container)!.disabled).toBe(true)
  })

  it('v2-d: create carries dataSource.seriesByFieldId', async () => {
    const { client, fetchFn } = mockClient([fakeDashboard({ panels: [] })], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    await openCreateForm(container)
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Stacked'; nameInput.dispatchEvent(new Event('input')); await nextTick()
    // bar + count (defaults), groupBy = fld_status (default), series = fld_amount
    await setSelect(seriesSelectOf(container)!, 'fld_amount')
    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()

    const post = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'POST' && url.includes('/charts') && !url.includes('preview-data'),
    )
    const body = JSON.parse(post![1].body as string)
    expect(body.dataSource.seriesByFieldId).toBe('fld_amount')
    expect(body.display.barMode).toBe('stacked') // additive default
  })

  it('v2-d-b1: switching to a non-additive aggregation keeps the series and forces grouped layout', async () => {
    const { client, fetchFn } = mockClient([fakeDashboard({ panels: [] })], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    await openCreateForm(container)
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Switcher'; nameInput.dispatchEvent(new Event('input')); await nextTick()
    await setSelect(seriesSelectOf(container)!, 'fld_amount')  // bar + count + series (stacked default)
    await setSelect(aggSelectOf(container), 'avg')            // non-additive → series KEPT, layout forced grouped
    const valueSelect = container.querySelector('[data-field="chart-value-field"]') as HTMLSelectElement
    await setSelect(valueSelect, 'fld_amount')               // avg requires a value field
    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()

    const post = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'POST' && url.includes('/charts') && !url.includes('preview-data'),
    )
    const body = JSON.parse(post![1].body as string)
    expect(body.dataSource.aggregation.function).toBe('avg')
    expect(body.dataSource.seriesByFieldId).toBe('fld_amount') // kept (grouped allows non-additive)
    expect(body.display.barMode).toBe('grouped')               // forced — stacked is illegal for avg
  })

  it('v2-d: editing a stacked chart preserves seriesByFieldId on a name-only edit (round-trip)', async () => {
    const chart = fakeChart({
      chartType: 'bar',
      dataSource: { sheetId: 'sheet_1', groupByFieldId: 'fld_status', seriesByFieldId: 'fld_amount', aggregation: { function: 'count' } },
    })
    const { client, fetchFn } = mockClient([fakeDashboard()], [chart])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    ;(container.querySelector('[data-action="add-panel"]') as HTMLButtonElement).click()
    await nextTick()
    ;(container.querySelector(`[data-edit-chart="${chart.id}"]`) as HTMLButtonElement).click()
    await nextTick()
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Renamed'; nameInput.dispatchEvent(new Event('input')); await nextTick()
    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()

    const patch = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'PATCH' && url.includes(`/charts/${chart.id}`),
    )
    expect(JSON.parse(patch![1].body as string).dataSource.seriesByFieldId).toBe('fld_amount')
  })

  it('v2-d: live preview carries dataSource.seriesByFieldId', async () => {
    const { client } = mockClient([fakeDashboard({ panels: [] })], [])
    const previewSpy = vi.spyOn(client, 'previewChartData').mockResolvedValue({ chartType: 'bar', dataPoints: [{ label: 'A', value: 1 }] })
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    vi.useFakeTimers()
    await openCreateForm(container)
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Preview stacked'; nameInput.dispatchEvent(new Event('input')); await nextTick()
    await setSelect(seriesSelectOf(container)!, 'fld_amount')

    await vi.advanceTimersByTimeAsync(300)
    await nextTick()
    expect(previewSpy).toHaveBeenLastCalledWith('sheet_1', expect.objectContaining({
      chartType: 'bar',
      dataSource: expect.objectContaining({ seriesByFieldId: 'fld_amount' }),
    }))
    vi.useRealTimers()
  })

  it('v2-d-b1: editing a grouped chart preserves display.barMode on a name-only edit (round-trip)', async () => {
    const chart = fakeChart({
      chartType: 'bar',
      dataSource: { sheetId: 'sheet_1', groupByFieldId: 'fld_status', seriesByFieldId: 'fld_amount', aggregation: { function: 'count' } },
      displayConfig: { title: 'Grouped chart', barMode: 'grouped' },
    })
    const { client, fetchFn } = mockClient([fakeDashboard()], [chart])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    ;(container.querySelector('[data-action="add-panel"]') as HTMLButtonElement).click()
    await nextTick()
    ;(container.querySelector(`[data-edit-chart="${chart.id}"]`) as HTMLButtonElement).click()
    await nextTick()
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Renamed'; nameInput.dispatchEvent(new Event('input')); await nextTick()
    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()

    const patch = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'PATCH' && url.includes(`/charts/${chart.id}`),
    )
    const body = JSON.parse(patch![1].body as string)
    expect(body.display.barMode).toBe('grouped')               // preserved, not reset to stacked
    expect(body.dataSource.seriesByFieldId).toBe('fld_amount')
  })

  it('v2-d-b1: live preview carries display.barMode', async () => {
    const { client } = mockClient([fakeDashboard({ panels: [] })], [])
    const previewSpy = vi.spyOn(client, 'previewChartData').mockResolvedValue({ chartType: 'bar', dataPoints: [{ label: 'A', value: 1 }] })
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    vi.useFakeTimers()
    await openCreateForm(container)
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Preview grouped'; nameInput.dispatchEvent(new Event('input')); await nextTick()
    await setSelect(seriesSelectOf(container)!, 'fld_amount')
    await setSelect(barModeSelectOf(container)!, 'grouped')

    await vi.advanceTimersByTimeAsync(300)
    await nextTick()
    expect(previewSpy).toHaveBeenLastCalledWith('sheet_1', expect.objectContaining({
      chartType: 'bar',
      displayConfig: expect.objectContaining({ barMode: 'grouped' }),
    }))
    vi.useRealTimers()
  })

  it('v2-d-b2: a line chart carries dataSource.seriesByFieldId but no display.barMode (create + preview)', async () => {
    const { client, fetchFn } = mockClient([fakeDashboard({ panels: [] })], [])
    const previewSpy = vi.spyOn(client, 'previewChartData').mockResolvedValue({ chartType: 'line', dataPoints: [{ label: 'A', value: 1 }] })
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    vi.useFakeTimers()
    await openCreateForm(container)
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Multi line'; nameInput.dispatchEvent(new Event('input')); await nextTick()
    await setSelect(typeSelectOf(container), 'line')
    await setSelect(seriesSelectOf(container)!, 'fld_amount')   // line + series; barMode control not shown

    // preview carries the series, no barMode
    await vi.advanceTimersByTimeAsync(300); await nextTick()
    expect(previewSpy).toHaveBeenLastCalledWith('sheet_1', expect.objectContaining({
      chartType: 'line',
      dataSource: expect.objectContaining({ seriesByFieldId: 'fld_amount' }),
    }))
    const previewArg = previewSpy.mock.calls.at(-1)![1] as { displayConfig?: { barMode?: unknown } }
    expect(previewArg.displayConfig?.barMode).toBeUndefined()
    vi.useRealTimers()

    // create carries series, no barMode
    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()
    const post = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'POST' && url.includes('/charts') && !url.includes('preview-data'),
    )
    const body = JSON.parse(post![1].body as string)
    expect(body.type).toBe('line')
    expect(body.dataSource.seriesByFieldId).toBe('fld_amount')
    expect(body.display.barMode).toBeUndefined()
  })

  // ---- S3: chart-type completion (area / funnel / gauge) + S1-9 async renderer ----

  it('S3 + r12: the chart-type select offers area / funnel / gauge / scatter alongside the originals', async () => {
    const { client } = mockClient([fakeDashboard({ panels: [] })], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    await openCreateForm(container)

    const options = Array.from(typeSelectOf(container).options).map((o) => o.value)
    expect(options).toEqual(['bar', 'line', 'area', 'pie', 'funnel', 'gauge', 'scatter', 'number', 'table'])
  })

  it('S3: variant + series pickers stay hidden for area/funnel/gauge (no inapplicable controls)', async () => {
    const { client } = mockClient([fakeDashboard({ panels: [] })], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    await openCreateForm(container)
    const typeSelect = typeSelectOf(container)

    for (const t of ['area', 'funnel', 'gauge']) {
      await setSelect(typeSelect, t)
      expect(variantSelectOf(container), `variant select must stay hidden for ${t}`).toBeNull()
      expect(seriesSelectOf(container), `series select must stay hidden for ${t}`).toBeNull()
    }
  })

  it('S3: create carries type funnel (wire maps chartType -> type)', async () => {
    const { client, fetchFn } = mockClient([fakeDashboard({ panels: [] })], [])
    const { container } = mount({ sheetId: 'sheet_1', client, fields: chartFields })
    await flushPromises()
    await openCreateForm(container)
    const nameInput = container.querySelector('[data-field="chart-name"]') as HTMLInputElement
    nameInput.value = 'Pipeline'; nameInput.dispatchEvent(new Event('input')); await nextTick()
    await setSelect(typeSelectOf(container), 'funnel')
    ;(container.querySelector('[data-action="submit-create-chart"]') as HTMLButtonElement).click()
    await flushPromises()

    const post = fetchFn.mock.calls.find(
      ([url, init]: [string, RequestInit?]) => init?.method === 'POST' && url.includes('/charts') && !url.includes('preview-data'),
    )
    const body = JSON.parse(post![1].body as string)
    expect(body.type).toBe('funnel')
    expect(body.display.variant).toBeUndefined() // no render variant applies to funnel
  })

  it('S1-9: a panel renders the (async-chunked) chart renderer after promises flush', async () => {
    const funnelChart = fakeChart({ chartType: 'funnel' })
    const funnelChartData: ChartData = {
      chartType: 'funnel',
      dataPoints: [{ label: 'Visit', value: 100 }, { label: 'Buy', value: 30 }],
      total: 130,
    }
    const { client } = mockClient([fakeDashboard()], [funnelChart], funnelChartData)
    const { container } = mount({ sheetId: 'sheet_1', client })
    await flushPromises()

    // defineAsyncComponent resolves through the same microtask flushing the data load uses;
    // after the flush the panel must contain the real renderer (canvas + funnel legend).
    expect(container.querySelector('[data-chart-type="funnel"]')).toBeTruthy()
    expect(container.querySelector('[data-chart-canvas]')).toBeTruthy()
    expect(container.querySelector('[data-legend]')).toBeTruthy()
  })
})
