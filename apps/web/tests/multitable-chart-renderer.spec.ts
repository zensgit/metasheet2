import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

import MetaChartRenderer from '../src/multitable/components/MetaChartRenderer.vue'
import type { ChartData, ChartDisplayConfig } from '../src/multitable/types'

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

describe('MetaChartRenderer', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders bar chart with correct number of bars', async () => {
    const { container } = mount({ chartData: barData })
    await flushPromises()

    expect(container.querySelector('[data-chart-type="bar"]')).toBeTruthy()
    const svg = container.querySelector('[data-chart="bar"]')
    expect(svg).toBeTruthy()
    const bars = container.querySelectorAll('[data-bar-index]')
    expect(bars.length).toBe(3)
  })

  it('renders horizontal bar chart when orientation is horizontal', async () => {
    const config: ChartDisplayConfig = { orientation: 'horizontal' }
    const { container } = mount({ chartData: barData, displayConfig: config })
    await flushPromises()

    const bars = container.querySelectorAll('[data-bar-index]')
    expect(bars.length).toBe(3)
  })

  it('renders line chart with polyline and data points', async () => {
    const { container } = mount({ chartData: lineData })
    await flushPromises()

    expect(container.querySelector('[data-chart="line"]')).toBeTruthy()
    const points = container.querySelectorAll('[data-point-index]')
    expect(points.length).toBe(3)
    const polyline = container.querySelector('.meta-chart__line')
    expect(polyline).toBeTruthy()
    expect(polyline?.getAttribute('points')).toBeTruthy()
  })

  it('renders pie chart with segments and legend', async () => {
    const { container } = mount({ chartData: pieData })
    await flushPromises()

    expect(container.querySelector('[data-chart="pie"]')).toBeTruthy()
    const segments = container.querySelectorAll('[data-pie-index]')
    expect(segments.length).toBe(3)
    expect(container.querySelector('[data-legend]')).toBeTruthy()
  })

  it('renders number chart with value', async () => {
    const { container } = mount({ chartData: numberData })
    await flushPromises()

    expect(container.querySelector('[data-chart="number"]')).toBeTruthy()
    const valueEl = container.querySelector('.meta-chart__number-value')
    expect(valueEl?.textContent).toBe('42000')
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

  it('renders table chart with rows', async () => {
    const { container } = mount({ chartData: tableData })
    await flushPromises()

    expect(container.querySelector('[data-chart="table"]')).toBeTruthy()
    const rows = container.querySelectorAll('.meta-chart__table tbody tr')
    expect(rows.length).toBe(2)
  })

  it('shows title from display config', async () => {
    const config: ChartDisplayConfig = { title: 'Sales Overview' }
    const { container } = mount({ chartData: barData, displayConfig: config })
    await flushPromises()

    const title = container.querySelector('.meta-chart__title')
    expect(title?.textContent).toBe('Sales Overview')
  })
})
