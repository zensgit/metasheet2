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
import type { Dashboard, ChartConfig, ChartData } from '../src/multitable/types'
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
    dataSource: { sheetId: 'sheet_1', fieldId: 'fld_1', aggregation: 'count' },
    ...overrides,
  }
}

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
