import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

import MetaChartLoadError from '../src/multitable/components/MetaChartLoadError.vue'
import { useLocale } from '../src/composables/useLocale'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaChartLoadError, props) })
  app.mount(container)
  return { container, app }
}

// r2 item 3: the lazy MetaChartRenderer chunk previously rendered an EMPTY panel on a network
// failure. The errorComponent (this) must surface a 'chart failed to load' message + a Retry that
// re-invokes Vue's loader-retry (or, absent it, reloads the page).
describe('MetaChartLoadError (async chunk fallback)', () => {
  afterEach(() => {
    useLocale().setLocale('en')
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders the failure message and a retry button', async () => {
    const { container } = mount({})
    await flushPromises()
    expect(container.querySelector('[data-chart-load-error]')).toBeTruthy()
    expect(container.textContent).toContain('Chart failed to load')
    const retry = container.querySelector('[data-action="retry-chart-load"]')
    expect(retry).toBeTruthy()
    expect(retry?.textContent).toContain('Retry')
  })

  it('calls the Vue-provided retry prop when retry is clicked', async () => {
    const retry = vi.fn()
    const { container } = mount({ retry })
    await flushPromises()
    ;(container.querySelector('[data-action="retry-chart-load"]') as HTMLButtonElement).click()
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('localizes the message + retry to zh', async () => {
    useLocale().setLocale('zh')
    const { container } = mount({})
    await flushPromises()
    expect(container.textContent).toContain('图表加载失败')
    expect(container.textContent).toContain('重试')
  })
})

// Wiring leg: a rejected chunk loader must render THIS error component inside a dashboard panel
// (not an empty panel). Module-isolated so the real ./MetaChartRenderer.vue import is forced to
// reject before MetaDashboardView's module-scope defineAsyncComponent resolves it.
describe('MetaDashboardView async chunk failure → error fallback', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('renders the chart-load-error fallback when the renderer chunk fails to import', async () => {
    vi.resetModules()
    // Force the lazy chunk import to reject (simulated network/chunk failure).
    vi.doMock('../src/multitable/components/MetaChartRenderer.vue', () => {
      throw new Error('Failed to fetch dynamically imported module')
    })
    // echarts entrypoints are irrelevant here (renderer never loads) but keep them harmless.
    vi.doMock('echarts/core', () => ({ init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })), use: vi.fn() }))
    vi.doMock('echarts/charts', () => ({ BarChart: {}, LineChart: {}, PieChart: {}, FunnelChart: {}, GaugeChart: {} }))
    vi.doMock('echarts/components', () => ({ GridComponent: {}, TooltipComponent: {} }))
    vi.doMock('echarts/renderers', () => ({ CanvasRenderer: {} }))

    const { default: DashboardView } = await import('../src/multitable/components/MetaDashboardView.vue')
    const { MultitableApiClient } = await import('../src/multitable/api/client')

    const ok = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/dashboards') && !url.includes('/charts')) {
        return ok({ dashboards: [{ id: 'dash_1', sheetId: 'sheet_1', name: 'D', panels: [{ id: 'p1', chartId: 'chart_1', size: 'medium', order: 0 }] }] })
      }
      if (url.includes('/charts') && url.includes('/data')) {
        return ok({ chartType: 'bar', dataPoints: [{ label: 'A', value: 1 }] })
      }
      if (url.includes('/charts')) {
        return ok({ charts: [{ id: 'chart_1', sheetId: 'sheet_1', name: 'C', chartType: 'bar', dataSource: { sheetId: 'sheet_1', groupByFieldId: 'f', aggregation: { function: 'count' } } }] })
      }
      return ok({})
    })
    const client = new MultitableApiClient({ fetchFn })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ render: () => h(DashboardView, { sheetId: 'sheet_1', client }) })
    app.mount(container)

    // Let data load + the async-component loader reject + the error component render.
    const deadline = Date.now() + 5_000
    while (!container.querySelector('[data-chart-load-error]') && Date.now() < deadline) {
      await flushPromises()
    }
    expect(container.querySelector('[data-chart-load-error]')).toBeTruthy()
    app.unmount()
  })
})
