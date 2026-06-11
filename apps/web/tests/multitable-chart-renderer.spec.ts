import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

// ECharts needs a real canvas (absent in jsdom) → mock the runtime entry points. The renderer's
// option-building is the pure `buildChartOption` (imported real below), so we assert the wiring:
// init once + setOption(buildChartOption(...)). Legend/title/number/table are HTML and asserted directly.
const mocks = vi.hoisted(() => {
  const setOption = vi.fn()
  const resize = vi.fn()
  const dispose = vi.fn()
  const instance = { setOption, resize, dispose }
  const init = vi.fn(() => instance)
  return { setOption, resize, dispose, init, instance }
})
vi.mock('echarts/core', () => ({ init: mocks.init, use: vi.fn() }))
vi.mock('echarts/charts', () => ({ BarChart: {}, LineChart: {}, PieChart: {}, FunnelChart: {}, GaugeChart: {} }))
vi.mock('echarts/components', () => ({ GridComponent: {}, TooltipComponent: {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))

import MetaChartRenderer from '../src/multitable/components/MetaChartRenderer.vue'
import { buildChartOption } from '../src/multitable/utils/buildChartOption'
import type { ChartData, ChartDisplayConfig } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaChartRenderer, props) })
  app.mount(container)
  return { container, app }
}

const barData: ChartData = {
  chartType: 'bar',
  dataPoints: [
    { label: 'A', value: 10 },
    { label: 'B', value: 20 },
    { label: 'C', value: 15 },
  ],
}

const lineData: ChartData = {
  chartType: 'line',
  dataPoints: [
    { label: 'Jan', value: 5 },
    { label: 'Feb', value: 12 },
    { label: 'Mar', value: 8 },
  ],
}

const pieData: ChartData = {
  chartType: 'pie',
  dataPoints: [
    { label: 'Red', value: 30, color: '#ef4444' },
    { label: 'Blue', value: 50, color: '#2563eb' },
    { label: 'Green', value: 20, color: '#16a34a' },
  ],
}

const numberData: ChartData = {
  chartType: 'number',
  dataPoints: [{ label: 'Total Sales', value: 42000 }],
  total: 42000,
}

const tableData: ChartData = {
  chartType: 'table',
  dataPoints: [
    { label: 'Row 1', value: 100 },
    { label: 'Row 2', value: 200 },
  ],
}

const restrictedBarData: ChartData = {
  chartType: 'bar',
  dataPoints: [],
  total: 0,
  metadata: { restricted: true, recordCount: 0 },
}

// S3 chart-type completion fixtures
const areaData: ChartData = {
  chartType: 'area',
  dataPoints: [
    { label: 'Jan', value: 5 },
    { label: 'Feb', value: 12 },
  ],
}

const funnelData: ChartData = {
  chartType: 'funnel',
  dataPoints: [
    { label: 'Visit', value: 100 },
    { label: 'Signup', value: 40 },
    { label: 'Buy', value: 10 },
  ],
}

const gaugeData: ChartData = {
  chartType: 'gauge',
  dataPoints: [
    { label: 'open', value: 30 },
    { label: 'closed', value: 70 },
  ],
  total: 100,
}

describe('MetaChartRenderer', () => {
  // jsdom has no ResizeObserver — stub it so the renderer's resize wiring is exercisable.
  const realResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver
  const roObserve = vi.fn()
  const roDisconnect = vi.fn()
  let resizeObserverCb: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    resizeObserverCb = null
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = vi.fn((cb: () => void) => {
      resizeObserverCb = cb
      return { observe: roObserve, unobserve: vi.fn(), disconnect: roDisconnect }
    })
  })
  afterEach(() => {
    useLocale().setLocale('en')
    document.body.innerHTML = ''
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realResizeObserver
  })

  function mountReactive(initial: { chartData: ChartData; displayConfig?: ChartDisplayConfig }) {
    const state = reactive<{ chartData: ChartData; displayConfig?: ChartDisplayConfig }>({
      chartData: initial.chartData,
      displayConfig: initial.displayConfig,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render: () => h(MetaChartRenderer, { chartData: state.chartData, displayConfig: state.displayConfig }),
    })
    app.mount(container)
    return { container, app, state }
  }

  it('renders bar via ECharts canvas: init once + setOption(buildChartOption)', async () => {
    const { container } = mount({ chartData: barData })
    await flushPromises()

    expect(container.querySelector('[data-chart-type="bar"]')).toBeTruthy()
    expect(container.querySelector('[data-chart-canvas]')).toBeTruthy()
    expect(mocks.init).toHaveBeenCalledTimes(1)
    expect(mocks.setOption).toHaveBeenCalledTimes(1)
    // the renderer feeds the pure mapper's output straight to setOption
    expect(mocks.setOption.mock.calls[0][0]).toEqual(buildChartOption(barData))
  })

  it('renders horizontal bar by passing orientation through to the option', async () => {
    const config: ChartDisplayConfig = { orientation: 'horizontal' }
    mount({ chartData: barData, displayConfig: config })
    await flushPromises()
    expect(mocks.setOption.mock.calls[0][0]).toEqual(buildChartOption(barData, config))
  })

  it('renders line via ECharts canvas', async () => {
    const { container } = mount({ chartData: lineData })
    await flushPromises()

    expect(container.querySelector('[data-chart-type="line"]')).toBeTruthy()
    expect(mocks.init).toHaveBeenCalledTimes(1)
    expect((mocks.setOption.mock.calls[0][0] as { series: { type: string }[] }).series[0].type).toBe('line')
  })

  it('renders pie via ECharts canvas + keeps the HTML legend (swatch/label/value)', async () => {
    const { container } = mount({ chartData: pieData })
    await flushPromises()

    expect(container.querySelector('[data-chart-type="pie"]')).toBeTruthy()
    expect(mocks.init).toHaveBeenCalledTimes(1)
    const legend = container.querySelector('[data-legend]')
    expect(legend).toBeTruthy()
    expect(container.querySelectorAll('.meta-chart__legend-item').length).toBe(3)
    expect(legend?.textContent).toContain('Red')
    expect(legend?.textContent).toContain('30')
  })

  // V-S1-3b: showLegend is only provable at the renderer layer (HTML legend, pie-only)
  it('hides the pie HTML legend when showLegend is false', async () => {
    const { container } = mount({ chartData: pieData, displayConfig: { showLegend: false } })
    await flushPromises()
    expect(container.querySelector('[data-legend]')).toBeNull()
  })

  // v2-d: multi-series legend over series names (bar grouped/stacked) + v2-d-b2 (multi-line).
  it('renders the multi-series legend (series names) for a bar series split', async () => {
    const { container } = mount({
      chartData: { chartType: 'bar', dataPoints: [{ label: 'X', value: 1 }], series: [{ name: 'A', data: [1] }, { name: 'B', data: [0] }] },
    })
    await flushPromises()
    const legend = container.querySelector('[data-legend="series"]')
    expect(legend).toBeTruthy()
    expect(legend?.textContent).toContain('A')
    expect(legend?.textContent).toContain('B')
  })

  it('v2-d-b2: renders the multi-series legend for a multi-line chart too', async () => {
    const { container } = mount({
      chartData: { chartType: 'line', dataPoints: [{ label: 'Jan', value: 1 }], series: [{ name: 'A', data: [1] }, { name: 'B', data: [2] }] },
    })
    await flushPromises()
    const legend = container.querySelector('[data-legend="series"]')
    expect(legend).toBeTruthy()
    expect(legend?.textContent).toContain('A')
  })

  it('hides the multi-series legend when showLegend is false', async () => {
    const { container } = mount({
      chartData: { chartType: 'line', dataPoints: [{ label: 'Jan', value: 1 }], series: [{ name: 'A', data: [1] }] },
      displayConfig: { showLegend: false },
    })
    await flushPromises()
    expect(container.querySelector('[data-legend="series"]')).toBeNull()
  })

  // --- S3: area / funnel / gauge chart types ---

  it('S3: renders area via ECharts canvas as a line+areaStyle option', async () => {
    const { container } = mount({ chartData: areaData })
    await flushPromises()

    expect(container.querySelector('[data-chart-type="area"]')).toBeTruthy()
    expect(container.querySelector('[data-chart-canvas]')).toBeTruthy()
    expect(mocks.init).toHaveBeenCalledTimes(1)
    expect(mocks.setOption.mock.calls[0][0]).toEqual(buildChartOption(areaData))
    const series = (mocks.setOption.mock.calls[0][0] as { series: { type: string; areaStyle?: unknown }[] }).series
    expect(series[0].type).toBe('line')
    expect(series[0].areaStyle).toBeDefined()
  })

  it('S3: renders funnel via ECharts canvas + shares the pie-style HTML legend (swatch/label/value)', async () => {
    const { container } = mount({ chartData: funnelData })
    await flushPromises()

    expect(container.querySelector('[data-chart-type="funnel"]')).toBeTruthy()
    expect(container.querySelector('[data-chart-canvas]')).toBeTruthy()
    expect(mocks.init).toHaveBeenCalledTimes(1)
    expect(mocks.setOption.mock.calls[0][0]).toEqual(buildChartOption(funnelData))
    const legend = container.querySelector('[data-legend]')
    expect(legend).toBeTruthy()
    expect(container.querySelectorAll('.meta-chart__legend-item').length).toBe(3)
    expect(legend?.textContent).toContain('Visit')
    expect(legend?.textContent).toContain('100')
  })

  it('S3: hides the funnel HTML legend when showLegend is false', async () => {
    const { container } = mount({ chartData: funnelData, displayConfig: { showLegend: false } })
    await flushPromises()
    expect(container.querySelector('[data-legend]')).toBeNull()
  })

  it('S3: renders gauge via ECharts canvas without any HTML legend', async () => {
    const { container } = mount({ chartData: gaugeData })
    await flushPromises()

    expect(container.querySelector('[data-chart-type="gauge"]')).toBeTruthy()
    expect(container.querySelector('[data-chart-canvas]')).toBeTruthy()
    expect(mocks.init).toHaveBeenCalledTimes(1)
    expect(mocks.setOption.mock.calls[0][0]).toEqual(buildChartOption(gaugeData))
    expect(container.querySelector('[data-legend]')).toBeNull()
  })

  // r2 item 2: gauge dial=first point / max=share-of-total is only meaningful for an ADDITIVE
  // aggregation (count/sum). For avg/min/max the share-of-total framing misleads → surface an
  // i18n'd caption. The caption is HTML chrome in the renderer (buildChartOption stays unchanged).
  it('r2: gauge with a non-additive aggregation (avg) shows the misleading-share caption', async () => {
    const { container } = mount({ chartData: gaugeData, aggregation: 'avg' })
    await flushPromises()
    const note = container.querySelector('[data-gauge-agg-note]')
    expect(note).toBeTruthy()
    expect(note?.textContent || '').toMatch(/share of total/i)
  })

  it('r2: gauge with min / max also shows the caption (all non-additive aggs)', async () => {
    for (const agg of ['min', 'max'] as const) {
      const { container } = mount({ chartData: gaugeData, aggregation: agg })
      await flushPromises()
      expect(container.querySelector('[data-gauge-agg-note]'), `agg=${agg}`).toBeTruthy()
    }
  })

  it('r2: gauge with an additive aggregation (count / sum) shows NO caption', async () => {
    for (const agg of ['count', 'sum'] as const) {
      const { container } = mount({ chartData: gaugeData, aggregation: agg })
      await flushPromises()
      expect(container.querySelector('[data-gauge-agg-note]'), `agg=${agg}`).toBeNull()
    }
  })

  it('r2: a non-gauge chart never shows the gauge caption even with a non-additive agg', async () => {
    const { container } = mount({ chartData: barData, aggregation: 'avg' })
    await flushPromises()
    expect(container.querySelector('[data-gauge-agg-note]')).toBeNull()
  })

  it('r2: gauge caption localizes to zh', async () => {
    useLocale().setLocale('zh')
    const { container } = mount({ chartData: gaugeData, aggregation: 'avg' })
    await flushPromises()
    const note = container.querySelector('[data-gauge-agg-note]')
    expect(note?.textContent || '').toContain('占比')
  })

  it('S3: disposes the canvas when switching funnel → number (new types share the lifecycle)', async () => {
    const { state } = mountReactive({ chartData: funnelData })
    await flushPromises()
    expect(mocks.init).toHaveBeenCalledTimes(1)

    state.chartData = numberData
    await flushPromises()
    expect(mocks.dispose).toHaveBeenCalled()
  })

  it('does NOT init ECharts for number/table (HTML-rendered)', async () => {
    const num = mount({ chartData: numberData })
    await flushPromises()
    expect(num.container.querySelector('[data-chart="number"]')).toBeTruthy()
    expect(num.container.querySelector('.meta-chart__number-value')?.textContent).toBe('42000')

    vi.clearAllMocks()
    const tbl = mount({ chartData: tableData })
    await flushPromises()
    expect(tbl.container.querySelector('[data-chart="table"]')).toBeTruthy()
    expect(tbl.container.querySelectorAll('.meta-chart__table tbody tr').length).toBe(2)

    expect(mocks.init).not.toHaveBeenCalled()
  })

  it('renders number chart with prefix and suffix', async () => {
    const config: ChartDisplayConfig = { prefix: '$', suffix: 'USD' }
    const { container } = mount({ chartData: numberData, displayConfig: config })
    await flushPromises()

    const affixes = container.querySelectorAll('.meta-chart__number-affix')
    expect(affixes.length).toBe(2)
    expect(affixes[0].textContent).toBe('$')
    expect(affixes[1].textContent).toBe('USD')
  })

  it('renders restricted chart data as a permission notice without initializing ECharts', async () => {
    const { container } = mount({ chartData: restrictedBarData })
    await flushPromises()

    expect(container.querySelector('[data-chart-restricted]')).toBeTruthy()
    expect(container.querySelector('[data-chart-canvas]')).toBeNull()
    expect(container.textContent).toContain('Chart data restricted')
    expect(container.textContent).toContain('fields you cannot read')
    expect(mocks.init).not.toHaveBeenCalled()
    expect(mocks.setOption).not.toHaveBeenCalled()
  })

  it('localizes the restricted chart notice', async () => {
    useLocale().setLocale('zh-CN')
    const { container } = mount({ chartData: restrictedBarData })
    await flushPromises()

    expect(container.querySelector('[data-chart-restricted]')).toBeTruthy()
    expect(container.textContent).toContain('图表数据受限')
    expect(container.textContent).toContain('无权读取')
  })

  it('shows the HTML title from display config (single source, no ECharts title)', async () => {
    const config: ChartDisplayConfig = { title: 'Sales Overview' }
    const { container } = mount({ chartData: barData, displayConfig: config })
    await flushPromises()

    const titles = container.querySelectorAll('.meta-chart__title')
    expect(titles.length).toBe(1)
    expect(titles[0].textContent).toBe('Sales Overview')
    // title is HTML chrome, not in the ECharts option
    expect((mocks.setOption.mock.calls[0][0] as { title?: unknown }).title).toBeUndefined()
  })

  it('disposes the ECharts instance on unmount', async () => {
    const { app } = mount({ chartData: barData })
    await flushPromises()
    expect(mocks.dispose).not.toHaveBeenCalled()
    app.unmount()
    expect(mocks.dispose).toHaveBeenCalled()
  })

  // --- lifecycle (V-S1-4): prop update, cross-type switch, resize wiring ---

  it('re-runs setOption when the chart data changes (prop update)', async () => {
    const { state } = mountReactive({ chartData: barData })
    await flushPromises()
    expect(mocks.setOption).toHaveBeenCalledTimes(1)

    state.chartData = { chartType: 'bar', dataPoints: [{ label: 'Z', value: 99 }] }
    await flushPromises()
    expect(mocks.setOption).toHaveBeenCalledTimes(2)
    expect((mocks.setOption.mock.calls[1][0] as { xAxis: { data: string[] } }).xAxis.data).toEqual(['Z'])
  })

  it('inits ECharts when switching number → bar (post-flush: canvas now exists)', async () => {
    const { container, state } = mountReactive({ chartData: numberData })
    await flushPromises()
    expect(mocks.init).not.toHaveBeenCalled()
    expect(container.querySelector('[data-chart-canvas]')).toBeNull()

    state.chartData = barData
    await flushPromises()
    expect(container.querySelector('[data-chart-canvas]')).toBeTruthy()
    expect(mocks.init).toHaveBeenCalledTimes(1)
    expect(mocks.setOption).toHaveBeenCalled()
  })

  it('disposes the canvas when switching bar → number', async () => {
    const { state } = mountReactive({ chartData: barData })
    await flushPromises()
    expect(mocks.init).toHaveBeenCalledTimes(1)

    state.chartData = numberData
    await flushPromises()
    expect(mocks.dispose).toHaveBeenCalled()
  })

  it('disposes the canvas when switching bar → restricted', async () => {
    const { container, state } = mountReactive({ chartData: barData })
    await flushPromises()
    expect(mocks.init).toHaveBeenCalledTimes(1)

    state.chartData = restrictedBarData
    await flushPromises()
    expect(mocks.dispose).toHaveBeenCalled()
    expect(container.querySelector('[data-chart-restricted]')).toBeTruthy()
    expect(container.querySelector('[data-chart-canvas]')).toBeNull()
  })

  it('wires the resize observer to chart.resize()', async () => {
    mountReactive({ chartData: barData })
    await flushPromises()
    expect(roObserve).toHaveBeenCalled()
    expect(typeof resizeObserverCb).toBe('function')
    resizeObserverCb?.()
    expect(mocks.resize).toHaveBeenCalled()
  })

  it('localizes table headers while keeping chart data labels raw', async () => {
    useLocale().setLocale('zh-CN')
    const { container } = mount({ chartData: tableData })
    await flushPromises()

    expect(container.querySelectorAll('th')[0]?.textContent).toBe('标签')
    expect(container.querySelectorAll('th')[1]?.textContent).toBe('值')
    expect(container.textContent).toContain('Row 1')
    expect(container.textContent).toContain('100')
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0)
    expect(container.querySelectorAll('[title]')).toHaveLength(0)
    expect(container.querySelectorAll('[placeholder]')).toHaveLength(0)
  })
})
