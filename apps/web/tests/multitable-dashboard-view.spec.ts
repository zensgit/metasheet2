import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

import MetaDashboardView from '../src/multitable/components/MetaDashboardView.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import type { Dashboard, ChartConfig, ChartData } from '../src/multitable/types'

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

function mockClient(dashboards: Dashboard[] = [], charts: ChartConfig[] = []) {
  const ok = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const noContent = () => new Response(null, { status: 204 })

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('/dashboards') && !url.includes('/charts')) {
      return ok({ dashboards })
    }
    if (method === 'GET' && url.includes('/charts') && url.includes('/data')) {
      return ok(fakeChartData)
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
})
