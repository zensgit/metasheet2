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
 * Map a ChartData (+ optional display config) to an ECharts option for the
 * bar / line / pie chart types. Returns `null` for `number` / `table`, which the
 * renderer keeps as plain HTML (ECharts has no native equivalent).
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
  if (chartType !== 'bar' && chartType !== 'line' && chartType !== 'pie') return null

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

  // bar | line share value-encoded data; bar additionally supports horizontal orientation.
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

  // line — category labels come from the x-axis; no per-point value labels (matches old SVG)
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
        ...(displayConfig?.variant === 'area' ? { areaStyle: {} } : {}),
        data: seriesData,
      },
    ],
  }
}
