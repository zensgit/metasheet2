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

  // --- v2-c single-series render variants (displayConfig.variant) ---

  it('donut: pie + variant "donut" uses an inner radius; plain pie keeps radius "70%" (regression)', () => {
    const donut = opt(buildChartOption(chart('pie', [{ label: 'A', value: 1 }]), { variant: 'donut' }))
    expect(Array.isArray(donut.series[0].radius)).toBe(true) // [inner, outer] hole
    const plain = opt(buildChartOption(chart('pie', [{ label: 'A', value: 1 }])))
    expect(plain.series[0].radius).toBe('70%')
  })

  it('area: line + variant "area" fills the area; plain line has no areaStyle (regression)', () => {
    const area = opt(buildChartOption(chart('line', [{ label: 'A', value: 1 }]), { variant: 'area' }))
    expect(area.series[0].areaStyle).toBeDefined()
    const plain = opt(buildChartOption(chart('line', [{ label: 'A', value: 1 }])))
    expect(plain.series[0].areaStyle).toBeUndefined()
  })

  it('variant is inert on non-matching types (donut only pies, area only lines)', () => {
    const barDonut = opt(buildChartOption(chart('bar', [{ label: 'A', value: 1 }]), { variant: 'donut' }))
    expect(barDonut.series[0].type).toBe('bar')
    expect(barDonut.series[0].areaStyle).toBeUndefined()
    const lineDonut = opt(buildChartOption(chart('line', [{ label: 'A', value: 1 }]), { variant: 'donut' }))
    expect(lineDonut.series[0].areaStyle).toBeUndefined() // 'donut' does not area-fill a line
    const pieArea = opt(buildChartOption(chart('pie', [{ label: 'A', value: 1 }]), { variant: 'area' }))
    expect(pieArea.series[0].radius).toBe('70%') // 'area' does not donut-ify a pie
    expect(buildChartOption(chart('number', [{ label: 'x', value: 1 }]), { variant: 'donut' })).toBeNull()
  })

  // --- v2-d: stacked bar (chartData.series) ---

  const stackedBar = (): ChartData => ({
    chartType: 'bar',
    dataPoints: [{ label: 'open', value: 3 }, { label: 'closed', value: 2 }],
    series: [
      { name: 'A', data: [2, 1] },
      { name: 'B', data: [1, 1] },
    ],
  })

  it('stacked bar: one ECharts bar series per chartData.series entry, all on the same stack', () => {
    const o = opt(buildChartOption(stackedBar()))
    expect(o.series).toHaveLength(2)
    expect(o.series.map((s: any) => s.type)).toEqual(['bar', 'bar'])
    expect(o.series.map((s: any) => s.name)).toEqual(['A', 'B'])
    expect(o.series.every((s: any) => s.stack === 'total')).toBe(true)
    expect(o.series[0].data).toEqual([2, 1])
    expect(o.series[1].data).toEqual([1, 1])
    // x-axis categories come from dataPoints (vertical bar)
    expect(o.xAxis.type).toBe('category')
    expect(o.xAxis.data).toEqual(['open', 'closed'])
  })

  it('stacked bar honors horizontal orientation (axes swap, stack preserved)', () => {
    const o = opt(buildChartOption(stackedBar(), { orientation: 'horizontal' }))
    expect(o.xAxis.type).toBe('value')
    expect(o.yAxis.type).toBe('category')
    expect(o.yAxis.data).toEqual(['open', 'closed'])
    expect(o.series.every((s: any) => s.stack === 'total')).toBe(true)
  })

  it('v2-d-b1 grouped barMode: multi-series bar has NO stack (side-by-side)', () => {
    const o = opt(buildChartOption(stackedBar(), { barMode: 'grouped' }))
    expect(o.series).toHaveLength(2)
    expect(o.series.map((s: any) => s.name)).toEqual(['A', 'B'])
    expect(o.series.every((s: any) => s.stack === undefined)).toBe(true)
  })

  it('v2-d-b1 stacked barMode (default or explicit) keeps stack:total', () => {
    expect(opt(buildChartOption(stackedBar())).series.every((s: any) => s.stack === 'total')).toBe(true)
    expect(opt(buildChartOption(stackedBar(), { barMode: 'stacked' })).series.every((s: any) => s.stack === 'total')).toBe(true)
  })

  it('no series ⇒ unchanged single-series bar (regression)', () => {
    const o = opt(buildChartOption(chart('bar', [{ label: 'A', value: 10 }, { label: 'B', value: 20 }])))
    expect(o.series).toHaveLength(1)
    expect(o.series[0].stack).toBeUndefined()
    expect(o.series[0].data.map((d: any) => d.value)).toEqual([10, 20])
  })

  it('empty series[] ⇒ falls back to single-series bar (not zero series)', () => {
    const o = opt(buildChartOption({ chartType: 'bar', dataPoints: [{ label: 'A', value: 5 }], series: [] }))
    expect(o.series).toHaveLength(1)
    expect(o.series[0].stack).toBeUndefined()
  })

  it('series is inert on pie (no native multi-series mapping)', () => {
    // pie ignores series → null/HTML path (number/table also null). bar+line handle series (see below).
    const pieWithSeries = opt(buildChartOption({
      chartType: 'pie',
      dataPoints: [{ label: 'A', value: 1 }],
      series: [{ name: 'X', data: [1] }],
    }))
    expect(pieWithSeries.series[0].type).toBe('pie') // pie renders its dataPoints, not the series split
  })

  // --- v2-d-b2: multi-series line ---

  const multiLine = (): ChartData => ({
    chartType: 'line',
    dataPoints: [{ label: 'Jan', value: 3 }, { label: 'Feb', value: 5 }],
    series: [
      { name: 'A', data: [2, 4] },
      { name: 'B', data: [1, 1] },
    ],
  })

  it('v2-d-b2 multi-line: one line series per chartData.series entry, no stack', () => {
    const o = opt(buildChartOption(multiLine()))
    expect(o.series).toHaveLength(2)
    expect(o.series.map((s: any) => s.type)).toEqual(['line', 'line'])
    expect(o.series.map((s: any) => s.name)).toEqual(['A', 'B'])
    expect(o.series.every((s: any) => s.stack === undefined)).toBe(true) // lines never stack
    expect(o.series[0].data).toEqual([2, 4])
    expect(o.xAxis.data).toEqual(['Jan', 'Feb'])
    expect(o.series.every((s: any) => s.areaStyle === undefined)).toBe(true) // no area variant
  })

  it('v2-d-b2 area + multi-line: EVERY line keeps areaStyle (area-variant compat preserved)', () => {
    const o = opt(buildChartOption(multiLine(), { variant: 'area' }))
    expect(o.series).toHaveLength(2)
    expect(o.series.every((s: any) => s.type === 'line')).toBe(true)
    expect(o.series.every((s: any) => s.areaStyle !== undefined)).toBe(true)
    expect(o.series.every((s: any) => s.stack === undefined)).toBe(true)
  })

  it('v2-d-b2 no series ⇒ single line unchanged; area variant still honored (regression)', () => {
    const plain = opt(buildChartOption(chart('line', [{ label: 'A', value: 1 }])))
    expect(plain.series).toHaveLength(1)
    expect(plain.series[0].areaStyle).toBeUndefined()
    const area = opt(buildChartOption(chart('line', [{ label: 'A', value: 1 }]), { variant: 'area' }))
    expect(area.series[0].areaStyle).toBeDefined()
  })

  // --- v2-d-b3: date-axis × series renders via the same series shape (render is date-agnostic) ---

  it('v2-d-b3: a date-axis × series line renders overlaid lines with date buckets as the x-axis', () => {
    const o = opt(buildChartOption({
      chartType: 'line',
      dataPoints: [{ label: '2026-01', value: 3 }, { label: '2026-02', value: 5 }],
      series: [{ name: 'A', data: [2, 4] }, { name: 'B', data: [1, 1] }],
    }))
    expect(o.series).toHaveLength(2)
    expect(o.series.every((s: any) => s.type === 'line' && s.stack === undefined)).toBe(true)
    expect(o.xAxis.data).toEqual(['2026-01', '2026-02']) // date buckets are the x-axis categories
  })

  it('v2-d-b3: a date-axis × series area line keeps areaStyle on every line', () => {
    const o = opt(buildChartOption({
      chartType: 'line',
      dataPoints: [{ label: '2026-01', value: 3 }, { label: '2026-02', value: 5 }],
      series: [{ name: 'A', data: [2, 4] }, { name: 'B', data: [1, 1] }],
    }, { variant: 'area' }))
    expect(o.series.every((s: any) => s.areaStyle !== undefined && s.stack === undefined)).toBe(true)
  })

  // --- S3: first-class area / funnel / gauge chart types ---

  it('S3 area: renders as a line series with areaStyle forced (no variant needed)', () => {
    const o = opt(buildChartOption(chart('area', [{ label: 'A', value: 1 }, { label: 'B', value: 2 }])))
    expect(o.series[0].type).toBe('line')
    expect(o.series[0].areaStyle).toBeDefined()
    expect(o.xAxis.type).toBe('category')
    expect(o.xAxis.data).toEqual(['A', 'B'])
    expect(o.series[0].data.map((d: any) => d.value)).toEqual([1, 2])
  })

  it('S3 area: keeps line conventions — no value labels, no ECharts legend/title', () => {
    const o = opt(buildChartOption(chart('area', [{ label: 'A', value: 1 }]), { title: 'T' }))
    expect(o.series[0].label.show).toBe(false)
    expect(o.legend).toBeUndefined()
    expect(o.title).toBeUndefined()
  })

  it('S3 area: a (defensive) series split renders overlaid area lines, never stacked', () => {
    const o = opt(buildChartOption({
      chartType: 'area',
      dataPoints: [{ label: 'Jan', value: 3 }, { label: 'Feb', value: 5 }],
      series: [{ name: 'A', data: [2, 4] }, { name: 'B', data: [1, 1] }],
    }))
    expect(o.series).toHaveLength(2)
    expect(o.series.every((s: any) => s.type === 'line' && s.areaStyle !== undefined && s.stack === undefined)).toBe(true)
  })

  it('S3 area: regression — a plain line stays areaStyle-free (area type does not leak into line)', () => {
    const o = opt(buildChartOption(chart('line', [{ label: 'A', value: 1 }])))
    expect(o.series[0].areaStyle).toBeUndefined()
  })

  it('S3 funnel: maps dataPoints to label-less {name,value} stages (HTML legend carries values)', () => {
    const o = opt(buildChartOption(chart('funnel', [{ label: 'Visit', value: 100 }, { label: 'Buy', value: 30 }])))
    expect(o.series[0].type).toBe('funnel')
    expect(o.series[0].data).toEqual([{ name: 'Visit', value: 100 }, { name: 'Buy', value: 30 }])
    expect(o.series[0].label.show).toBe(false)
    expect(o.legend).toBeUndefined()
    expect(o.tooltip.trigger).toBe('item')
  })

  it('S3 funnel: preserves backend ordering (sort "none" — dataSource.sortBy stays authoritative)', () => {
    const o = opt(buildChartOption(chart('funnel', [{ label: 'small', value: 1 }, { label: 'big', value: 9 }])))
    expect(o.series[0].sort).toBe('none')
    expect(o.series[0].data.map((d: any) => d.name)).toEqual(['small', 'big'])
  })

  it('S3 funnel: honors per-point colors via itemStyle, palette otherwise', () => {
    const o = opt(buildChartOption(chart('funnel', [{ label: 'A', value: 1, color: '#123456' }])))
    expect(o.series[0].data[0].itemStyle.color).toBe('#123456')
    expect(o.color).toEqual(CHART_COLORS)
  })

  it('S3 gauge: dials the FIRST data point against the dataPoints total (share-of-total)', () => {
    const o = opt(buildChartOption({
      chartType: 'gauge',
      dataPoints: [{ label: 'open', value: 30 }, { label: 'closed', value: 70 }],
      total: 100,
    }))
    expect(o.series[0].type).toBe('gauge')
    expect(o.series[0].data).toEqual([{ name: 'open', value: 30 }])
    expect(o.series[0].min).toBe(0)
    expect(o.series[0].max).toBe(100)
  })

  it('S3 gauge: empty dataPoints → value 0 with max clamped to ≥ 1 (never a degenerate dial)', () => {
    const o = opt(buildChartOption({ chartType: 'gauge', dataPoints: [], total: 0 }))
    expect(o.series[0].data).toEqual([{ name: '', value: 0 }])
    expect(o.series[0].max).toBe(1)
  })

  it('S3 gauge: without a total the value itself is the max (full dial)', () => {
    const o = opt(buildChartOption(chart('gauge', [{ label: 'A', value: 42 }])))
    expect(o.series[0].max).toBe(42)
  })

  it('S3: number/table still render as HTML (null option) after the type additions', () => {
    expect(buildChartOption(chart('number', [{ label: 'x', value: 1 }]))).toBeNull()
    expect(buildChartOption(chart('table', [{ label: 'x', value: 1 }]))).toBeNull()
  })

  // --- r12 scatter: per-record x/y projection ---
  const scatterData = (
    points: Array<{ label?: string; xValue: number; yValue: number; size?: number; color?: string }>,
  ): ChartData => ({
    chartType: 'scatter',
    dataPoints: points.map((p) => ({ label: p.label ?? '', value: p.yValue, xValue: p.xValue, yValue: p.yValue, ...(p.size !== undefined ? { size: p.size } : {}), ...(p.color ? { color: p.color } : {}) })),
  })

  it('r12 scatter: BOTH axes are type "value" (numeric, not category) and series type is scatter', () => {
    const o = opt(buildChartOption(scatterData([{ xValue: 1, yValue: 10 }, { xValue: 2, yValue: 20 }])))
    expect(o.xAxis.type).toBe('value')
    expect(o.yAxis.type).toBe('value')
    expect(o.xAxis.data).toBeUndefined() // no category labels
    expect(o.series[0].type).toBe('scatter')
  })

  it('r12 scatter: maps each dataPoint to an [xValue, yValue] pair', () => {
    const o = opt(buildChartOption(scatterData([{ xValue: 1, yValue: 10 }, { xValue: 3.5, yValue: 7 }])))
    expect(o.series[0].data.map((d: any) => d.value)).toEqual([[1, 10], [3.5, 7]])
  })

  it('r12 scatter: symbolSize uses the point size, falling back to the default', () => {
    const o = opt(buildChartOption(scatterData([{ xValue: 1, yValue: 1, size: 25 }, { xValue: 2, yValue: 2 }])))
    const sizeFn = o.series[0].symbolSize
    expect(typeof sizeFn).toBe('function')
    expect(sizeFn(undefined, { data: { size: 25 } })).toBe(25)
    expect(sizeFn(undefined, { data: {} })).toBe(10) // default
  })

  it('r12 scatter: honors per-point color via itemStyle', () => {
    const o = opt(buildChartOption(scatterData([{ xValue: 1, yValue: 1, color: '#abcdef' }])))
    expect(o.series[0].data[0].itemStyle.color).toBe('#abcdef')
  })

  it('r12 scatter M1: color-by category assigns a stable palette color per distinct label', () => {
    const o = opt(buildChartOption(scatterData([
      { label: 'A', xValue: 1, yValue: 1 },
      { label: 'B', xValue: 2, yValue: 2 },
      { label: 'A', xValue: 3, yValue: 3 },
    ])))
    const colors = o.series[0].data.map((d: any) => d.itemStyle.color)
    expect(colors[0]).toBe(colors[2]) // same category → same color
    expect(colors[0]).not.toBe(colors[1]) // distinct categories → distinct colors
    expect(o.series[0].data[0].category).toBe('A')
  })

  it('r12 scatter M1: tooltip names the category when present', () => {
    const o = opt(buildChartOption(scatterData([{ label: 'North', xValue: 4, yValue: 9 }])))
    expect(o.tooltip.formatter({ data: { value: [4, 9], category: 'North' } })).toBe('North\n(4, 9)')
  })

  it('r12 scatter: item tooltip formats the (x, y) coordinate (no category)', () => {
    const o = opt(buildChartOption(scatterData([{ xValue: 4, yValue: 9 }])))
    expect(o.tooltip.trigger).toBe('item')
    expect(o.tooltip.formatter({ data: { value: [4, 9] } })).toBe('(4, 9)')
  })

  it('r12 scatter: does not crash on empty dataPoints', () => {
    const o = opt(buildChartOption(scatterData([])))
    expect(o.series[0].data).toEqual([])
  })
})
