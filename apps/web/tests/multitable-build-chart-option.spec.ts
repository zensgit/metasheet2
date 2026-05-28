import { describe, it, expect } from 'vitest'
import { buildChartOption, CHART_COLORS } from '../src/multitable/utils/buildChartOption'
import type { ChartData } from '../src/multitable/types'

// Reaching into ECharts' broad option unions in assertions; `any` is local to the test.
/* eslint-disable @typescript-eslint/no-explicit-any */
const opt = (v: unknown) => v as any

function chart(
  chartType: ChartData['chartType'],
  points: Array<{ label: string; value: number; color?: string }>,
): ChartData {
  return { chartType, dataPoints: points }
}

describe('buildChartOption', () => {
  it('returns null for number/table (HTML-rendered, no ECharts)', () => {
    expect(buildChartOption(chart('number', [{ label: 'x', value: 1 }]))).toBeNull()
    expect(buildChartOption(chart('table', [{ label: 'x', value: 1 }]))).toBeNull()
  })

  it('maps a vertical bar: category x-axis, value y-axis, bar series', () => {
    const o = opt(buildChartOption(chart('bar', [{ label: 'A', value: 10 }, { label: 'B', value: 20 }])))
    expect(o.xAxis.type).toBe('category')
    expect(o.xAxis.data).toEqual(['A', 'B'])
    expect(o.yAxis.type).toBe('value')
    expect(o.series[0].type).toBe('bar')
    expect(o.series[0].data.map((d: any) => d.value)).toEqual([10, 20])
  })

  it('swaps axes for a horizontal bar', () => {
    const o = opt(buildChartOption(chart('bar', [{ label: 'A', value: 10 }]), { orientation: 'horizontal' }))
    expect(o.xAxis.type).toBe('value')
    expect(o.yAxis.type).toBe('category')
    expect(o.yAxis.data).toEqual(['A'])
    expect(o.series[0].label.position).toBe('right')
  })

  it('maps a line series on a category axis', () => {
    const o = opt(buildChartOption(chart('line', [{ label: 'A', value: 5 }])))
    expect(o.series[0].type).toBe('line')
    expect(o.xAxis.type).toBe('category')
  })

  it('maps pie to {name,value} slices', () => {
    const o = opt(buildChartOption(chart('pie', [{ label: 'A', value: 3 }, { label: 'B', value: 7 }])))
    expect(o.series[0].type).toBe('pie')
    expect(o.series[0].data).toEqual([{ name: 'A', value: 3 }, { name: 'B', value: 7 }])
  })

  it('uses per-point color via itemStyle, palette otherwise', () => {
    const o = opt(buildChartOption(chart('pie', [{ label: 'A', value: 1, color: '#123456' }])))
    expect(o.series[0].data[0].itemStyle.color).toBe('#123456')
    expect(o.color).toEqual(CHART_COLORS)
  })

  // --- behavior-equivalence contracts (locked per pre-renderer review) ---

  it('emits NO ECharts legend on any type (legend stays HTML, pie-only, in the renderer)', () => {
    for (const t of ['bar', 'line', 'pie'] as const) {
      const o = opt(buildChartOption(chart(t, [{ label: 'A', value: 1 }])))
      expect(o.legend).toBeUndefined()
    }
  })

  it('keeps pie sectors label-less (value shown by the HTML legend, not on sectors)', () => {
    const o = opt(buildChartOption(chart('pie', [{ label: 'A', value: 1 }])))
    expect(o.series[0].label.show).toBe(false)
  })

  it('shows no value labels on line points (only bar shows values)', () => {
    const o = opt(buildChartOption(chart('line', [{ label: 'A', value: 1 }])))
    expect(o.series[0].label.show).toBe(false)
  })

  it('bar value labels default on, hidden when showValues=false', () => {
    const on = opt(buildChartOption(chart('bar', [{ label: 'A', value: 1 }])))
    expect(on.series[0].label.show).toBe(true)
    const off = opt(buildChartOption(chart('bar', [{ label: 'A', value: 1 }]), { showValues: false }))
    expect(off.series[0].label.show).toBe(false)
  })

  it('does NOT emit an ECharts title (title stays HTML chrome, like the legend)', () => {
    const o = opt(buildChartOption(chart('bar', [{ label: 'A', value: 1 }]), { title: 'Sales' }))
    expect(o.title).toBeUndefined()
  })

  it('does not crash on empty dataPoints', () => {
    const o = opt(buildChartOption(chart('bar', [])))
    expect(o.series[0].data).toEqual([])
    expect(o.xAxis.data).toEqual([])
  })
})
