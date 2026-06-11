import type { EChartsOption } from 'echarts'
import type { ChartData, ChartDisplayConfig } from '../types'

/**
 * Categorical palette mirroring the previous hand-rolled SVG renderer's COLORS,
 * so the ECharts swap stays visually continuous.
 */
export const CHART_COLORS = [
  '#2563eb', '#16a34a', '#f59e0b', '#ef4444',
  '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16',
]

/**
 * Chart types drawn on the ECharts canvas. The rest (`number` / `table`) stay plain HTML in the
 * renderer — single source so the renderer's canvas gate and this mapper's guard never drift.
 */
export const ECHARTS_CHART_TYPES: ReadonlySet<ChartData['chartType']> = new Set<ChartData['chartType']>([
  'bar', 'line', 'pie', 'area', 'funnel', 'gauge', 'scatter',
])

// r12 scatter: default symbol size when no per-point `size` is supplied.
const SCATTER_DEFAULT_SYMBOL_SIZE = 10

/**
 * Map a ChartData (+ optional display config) to an ECharts option for the
 * bar / line / pie / area / funnel / gauge chart types. Returns `null` for `number` / `table`,
 * which the renderer keeps as plain HTML (ECharts has no native equivalent).
 *
 * Behavior contract — deliberately matches the previous hand-rolled SVG so the
 * swap is visually equivalent (only hover tooltips are added):
 *   - **No ECharts legend on any type.** Only pie had a legend before, and it was
 *     an HTML "swatch + label + value" list; the renderer keeps that HTML legend.
 *   - **Pie sectors carry no labels** (`label.show:false`) — the value stays in the
 *     HTML legend, not moved onto the sectors.
 *   - **Bar** shows per-bar value labels, toggled by `showValues` (default on);
 *     **line** shows none (it only ever showed category labels, which the x-axis covers).
 *   - **No ECharts title** — the title stays HTML chrome in the renderer (avoids a double title).
 *   - `title` + `showLegend` are renderer-level HTML chrome, not handled here.
 *
 * Pure function with type-only echarts imports → unit-testable without a canvas.
 * The renderer feeds the result to `chart.setOption(...)`.
 */
export function buildChartOption(
  chartData: ChartData,
  displayConfig?: ChartDisplayConfig,
): EChartsOption | null {
  const { chartType, dataPoints } = chartData
  if (!ECHARTS_CHART_TYPES.has(chartType)) return null

  const showValues = displayConfig?.showValues !== false
  const labels = dataPoints.map((p) => p.label)

  // title + legend stay HTML chrome in the renderer (behavior-exact; no double title /
  // redundant legend). buildChartOption owns only the plot + palette.
  const base: EChartsOption = {
    color: CHART_COLORS,
  }

  if (chartType === 'pie') {
    return {
      ...base,
      tooltip: { trigger: 'item' },
      series: [
        {
          type: 'pie',
          // v2-c: displayConfig.variant 'donut' renders the pie with an inner radius (a hole).
          radius: displayConfig?.variant === 'donut' ? ['45%', '70%'] : '70%',
          // sectors stay label-less; value is shown by the renderer's HTML legend
          label: { show: false },
          data: dataPoints.map((p) => ({
            name: p.label,
            value: p.value,
            ...(p.color ? { itemStyle: { color: p.color } } : {}),
          })),
        },
      ],
    }
  }

  // S3 funnel: dataPoints map to {name,value} stages like pie; stages stay label-less and the
  // renderer shows the same HTML "swatch + label + value" legend as pie.
  if (chartType === 'funnel') {
    return {
      ...base,
      tooltip: { trigger: 'item' },
      series: [
        {
          type: 'funnel',
          // Backend ordering (dataSource.sortBy/sortOrder) stays authoritative — ECharts' default
          // value-descending re-sort would silently override it (mirrors the date-axis rationale:
          // the producer owns ordering, the renderer is order-faithful).
          sort: 'none',
          label: { show: false },
          data: dataPoints.map((p) => ({
            name: p.label,
            value: p.value,
            ...(p.color ? { itemStyle: { color: p.color } } : {}),
          })),
        },
      ],
    }
  }

  // S3 gauge: dials the FIRST data point against the dataPoints total (share-of-total semantic —
  // the backend emits grouped {label,value} + total = Σ values; there is no per-type aggregation).
  // max is clamped to ≥ 1 so an all-zero result still renders a sane (empty) dial.
  if (chartType === 'gauge') {
    const point = dataPoints[0]
    const value = point?.value ?? 0
    return {
      ...base,
      tooltip: { trigger: 'item' },
      series: [
        {
          type: 'gauge',
          min: 0,
          max: Math.max(chartData.total ?? 0, value, 1),
          progress: { show: true },
          data: [{ name: point?.label ?? '', value }],
        },
      ],
    }
  }

  // r12 scatter: a per-record x/y projection. BOTH axes are type:'value' (numeric, not category) — the
  // defining difference from bar/line. Each dataPoint maps to an [xValue, yValue] pair; symbolSize comes
  // from the point's `size` (falling back to a default), and the tooltip shows the (x, y) coordinate.
  if (chartType === 'scatter') {
    // Color-by (review M1): `label` carries the optional color-category from colorFieldId.
    // Assign each distinct category a stable palette color here (the palette lives frontend-side)
    // so the Color-by picker has a visible effect; the category is also named in the tooltip.
    const scatterCategories = [...new Set(dataPoints.map((p) => p.label).filter((l) => l !== ''))]
    const colorForCategory = (label: string): string | undefined =>
      label === '' ? undefined : CHART_COLORS[scatterCategories.indexOf(label) % CHART_COLORS.length]
    return {
      ...base,
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown) => {
          const data = (params as { data?: { value?: unknown; category?: string } })?.data
          const value = data?.value
          const [x, y] = Array.isArray(value) ? value : [undefined, undefined]
          return data?.category ? `${data.category}\n(${x}, ${y})` : `(${x}, ${y})`
        },
      },
      grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
      xAxis: { type: 'value' },
      yAxis: { type: 'value' },
      series: [
        {
          type: 'scatter',
          symbolSize: (rawValue: unknown, params: unknown) => {
            const size = (params as { data?: { size?: number } })?.data?.size
            return typeof size === 'number' && Number.isFinite(size) ? size : SCATTER_DEFAULT_SYMBOL_SIZE
          },
          data: dataPoints.map((p) => {
            const color = p.color ?? colorForCategory(p.label)
            return {
              value: [p.xValue ?? 0, p.yValue ?? 0],
              ...(p.label !== '' ? { category: p.label } : {}),
              ...(p.size !== undefined ? { size: p.size } : {}),
              ...(color ? { itemStyle: { color } } : {}),
            }
          }),
        },
      ],
    }
  }

  // bar | line | area share value-encoded data; bar additionally supports horizontal orientation.
  const seriesData = dataPoints.map((p) => ({
    value: p.value,
    ...(p.color ? { itemStyle: { color: p.color } } : {}),
  }))
  const categoryAxis = { type: 'category' as const, data: labels }
  const valueAxis = { type: 'value' as const }
  const grid = { left: '3%', right: '4%', bottom: '3%', containLabel: true }

  if (chartType === 'bar') {
    const horizontal = displayConfig?.orientation === 'horizontal'
    // v2-d: multi-series bar — one ECharts series per seriesByFieldId value. Categories (xAxis) come
    // from dataPoints; each series.data is dense + aligned to that order. Colored by series (palette),
    // values read via the HTML legend + axis tooltip. v2-d-b1: barMode 'grouped' renders them
    // side-by-side (no stack); default 'stacked' shares one stack.
    const multiSeries = chartData.series
    if (multiSeries && multiSeries.length > 0) {
      const grouped = displayConfig?.barMode === 'grouped'
      return {
        ...base,
        tooltip: { trigger: 'axis' },
        grid,
        xAxis: horizontal ? valueAxis : categoryAxis,
        yAxis: horizontal ? categoryAxis : valueAxis,
        series: multiSeries.map((s) => ({
          type: 'bar',
          name: s.name,
          ...(grouped ? {} : { stack: 'total' }),
          label: { show: false },
          data: s.data,
        })),
      }
    }
    return {
      ...base,
      tooltip: { trigger: 'axis' },
      grid,
      xAxis: horizontal ? valueAxis : categoryAxis,
      yAxis: horizontal ? categoryAxis : valueAxis,
      series: [
        {
          type: 'bar',
          colorBy: 'data',
          label: { show: showValues, position: horizontal ? 'right' : 'top' },
          data: seriesData,
        },
      ],
    }
  }

  // line | area — category labels come from the x-axis; no per-point value labels (matches old SVG).
  // S3: the first-class 'area' type forces areaStyle; the v2-c line-variant 'area' keeps working.
  const area = chartType === 'area' || displayConfig?.variant === 'area'
  // v2-d-b2: multi-series line — one overlaid line per seriesByFieldId value (never stacked).
  // Categories (xAxis) come from dataPoints; each series.data is dense + aligned to that order.
  // The area variant is preserved: every line keeps its areaStyle.
  const lineSeries = chartData.series
  if (lineSeries && lineSeries.length > 0) {
    return {
      ...base,
      tooltip: { trigger: 'axis' },
      grid,
      xAxis: categoryAxis,
      yAxis: valueAxis,
      series: lineSeries.map((s) => ({
        type: 'line',
        name: s.name,
        label: { show: false },
        ...(area ? { areaStyle: {} } : {}),
        data: s.data,
      })),
    }
  }
  return {
    ...base,
    tooltip: { trigger: 'axis' },
    grid,
    xAxis: categoryAxis,
    yAxis: valueAxis,
    series: [
      {
        type: 'line',
        label: { show: false },
        // v2-c: displayConfig.variant 'area' fills the area under the line.
        ...(area ? { areaStyle: {} } : {}),
        data: seriesData,
      },
    ],
  }
}
