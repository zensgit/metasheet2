<template>
  <div class="meta-chart" :data-chart-type="chartData.chartType">
    <div v-if="displayConfig?.title" class="meta-chart__title">{{ displayConfig.title }}</div>

    <div v-if="isRestricted" class="meta-chart__restricted" data-chart-restricted="true">
      <strong>{{ viewRenderLabel('chart.restrictedTitle', isZh) }}</strong>
      <span>{{ viewRenderLabel('chart.restrictedHint', isZh) }}</span>
    </div>

    <!-- bar / line / pie / area / funnel / gauge → ECharts canvas. Title + (pie/funnel) legend stay as HTML chrome. -->
    <template v-else-if="isEChartsType">
      <div class="meta-chart__plot" :class="{ 'meta-chart__plot--pie': hasPointLegend }">
        <div ref="chartEl" class="meta-chart__echarts" data-chart-canvas="true"></div>
        <!-- r2 item 2: caption a gauge whose share-of-total dial is misleading for a non-additive aggregation. -->
        <p
          v-if="showGaugeAggNote"
          class="meta-chart__gauge-note"
          data-gauge-agg-note="true"
        >{{ viewRenderLabel('chart.gaugeNonAdditiveNote', isZh) }}</p>
        <!-- S3: funnel shares the pie-style point legend (stages are label-less on the canvas). -->
        <div
          v-if="hasPointLegend && displayConfig?.showLegend !== false"
          class="meta-chart__legend"
          data-legend="true"
        >
          <!-- Cross-filtering: the pie/funnel point legend is HTML, so clicking a legend row is the
               accessible twin of clicking a canvas slice — both emit the row's label. Empty labels
               (uncategorized) carry no filterable value, so their row is not interactive. -->
          <div
            v-for="(pt, idx) in chartData.dataPoints"
            :key="idx"
            class="meta-chart__legend-item"
            :class="{ 'meta-chart__legend-item--clickable': pt.label !== '' }"
            :role="pt.label !== '' ? 'button' : undefined"
            :tabindex="pt.label !== '' ? 0 : undefined"
            :data-legend-segment="pt.label !== '' ? pt.label : undefined"
            @click="pt.label !== '' && emit('segment-click', pt.label)"
            @keydown.enter="pt.label !== '' && emit('segment-click', pt.label)"
          >
            <span class="meta-chart__legend-swatch" :style="{ background: pt.color || defaultColor(idx) }"></span>
            <span class="meta-chart__legend-label">{{ pt.label }}</span>
            <span class="meta-chart__legend-value">{{ pt.value }}</span>
          </div>
        </div>
        <!-- v2-d: multi-series legend over series names (bar grouped/stacked or multi-line; colors map to the palette by series index). -->
        <div
          v-if="hasSeriesLegend && displayConfig?.showLegend !== false"
          class="meta-chart__legend meta-chart__legend--inline"
          data-legend="series"
        >
          <div v-for="(s, idx) in chartData.series" :key="s.name" class="meta-chart__legend-item">
            <span class="meta-chart__legend-swatch" :style="{ background: defaultColor(idx) }"></span>
            <span class="meta-chart__legend-label">{{ s.name }}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- Number chart -->
    <template v-else-if="chartData.chartType === 'number'">
      <div class="meta-chart__number" data-chart="number">
        <span v-if="displayConfig?.prefix" class="meta-chart__number-affix">{{ displayConfig.prefix }}</span>
        <span class="meta-chart__number-value">{{ chartData.dataPoints[0]?.value ?? chartData.total ?? 0 }}</span>
        <span v-if="displayConfig?.suffix" class="meta-chart__number-affix">{{ displayConfig.suffix }}</span>
      </div>
      <div v-if="chartData.dataPoints[0]?.label" class="meta-chart__number-label">{{ chartData.dataPoints[0].label }}</div>
    </template>

    <!-- Table chart -->
    <template v-else-if="chartData.chartType === 'table'">
      <table class="meta-chart__table" data-chart="table">
        <thead>
          <tr>
            <th>{{ viewRenderLabel('chart.label', isZh) }}</th>
            <th>{{ viewRenderLabel('chart.value', isZh) }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(pt, idx) in chartData.dataPoints" :key="idx">
            <td>{{ pt.label }}</td>
            <td>{{ pt.value }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart, FunnelChart, GaugeChart, ScatterChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { AggregationFunction, ChartData, ChartDisplayConfig } from '../types'
import { buildChartOption, CHART_COLORS, ECHARTS_CHART_TYPES } from '../utils/buildChartOption'
import { useLocale } from '../../composables/useLocale'
import { viewRenderLabel } from '../utils/meta-view-render-labels'

// Tree-shakeable: only the chart types + components actually used (S3 adds funnel/gauge; r12 adds
// scatter; the 'area' type reuses LineChart). Legend/title are HTML chrome (not ECharts components),
// so LegendComponent/TitleComponent are deliberately absent.
echarts.use([BarChart, LineChart, PieChart, FunnelChart, GaugeChart, ScatterChart, GridComponent, TooltipComponent, CanvasRenderer])

const props = defineProps<{
  chartData: ChartData
  displayConfig?: ChartDisplayConfig
  // r2 item 2: the chart's aggregation function (from dataSource.aggregation.function). Optional —
  // the renderer is also mounted in places that have only ChartData. Used solely to caption a gauge
  // whose share-of-total dial is misleading for a non-additive aggregation (avg/min/max).
  aggregation?: AggregationFunction
}>()
// Cross-filtering (dashboard): a click on a chart SEGMENT emits the clicked category's LABEL. The
// renderer has no `dataSource`, so it cannot know which FIELD the label belongs to — the parent
// (MetaDashboardView) maps `label → { fieldId: dataSource.groupByFieldId, value: label }` and folds
// it into the SAME dashboard-filter state #3007 added (no parallel filter path). The renderer only
// surfaces the user's intent; turning it into a (permission-gated) filter is the parent's job.
const emit = defineEmits<{ (e: 'segment-click', label: string): void }>()
const { isZh } = useLocale()

// Additive aggregations are the only ones whose Σ values is a meaningful whole, so the gauge's
// share-of-total dial is sound. Mirrors charts.ts ADDITIVE_AGGREGATIONS.
const ADDITIVE_AGGREGATIONS: ReadonlySet<AggregationFunction> = new Set<AggregationFunction>(['count', 'sum'])
const showGaugeAggNote = computed(() =>
  props.chartData.chartType === 'gauge'
  && props.aggregation !== undefined
  && !ADDITIVE_AGGREGATIONS.has(props.aggregation),
)

const isEChartsType = computed(() => ECHARTS_CHART_TYPES.has(props.chartData.chartType))
// pie + funnel share the HTML "swatch + label + value" point legend (their canvas marks are label-less).
const hasPointLegend = computed(() =>
  props.chartData.chartType === 'pie' || props.chartData.chartType === 'funnel',
)
const isRestricted = computed(() => props.chartData.metadata?.restricted === true)
const hasSeriesLegend = computed(() =>
  (props.chartData.chartType === 'bar' || props.chartData.chartType === 'line')
  && (props.chartData.series?.length ?? 0) > 0,
)

// Legend swatch fallback color — same palette as buildChartOption so canvas + HTML legend match.
function defaultColor(idx: number): string {
  return CHART_COLORS[idx % CHART_COLORS.length]
}

const chartEl = ref<HTMLElement | null>(null)
let chart: ReturnType<typeof echarts.init> | null = null
let resizeObserver: ResizeObserver | null = null

// Attach the resize observer once the canvas exists. Idempotent + called on every render, so it
// also wires up when the canvas appears LATER via a number/table → bar/line/pie type switch.
function ensureResizeObserver(): void {
  if (resizeObserver || !chartEl.value || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => chart?.resize())
  resizeObserver.observe(chartEl.value)
}

function teardownChart(): void {
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.dispose()
  chart = null
}

function renderChart(): void {
  if (isRestricted.value) {
    teardownChart()
    return
  }
  // non-chart type (number/table) → release any canvas instance + observer
  if (!isEChartsType.value) {
    teardownChart()
    return
  }
  if (!chartEl.value) return
  if (!chart) {
    chart = echarts.init(chartEl.value)
    // Cross-filtering: a click on a series item (bar/pie/funnel/line/area marks) emits the clicked
    // category's label. `params.name` is the dataPoint label (= the group-by category value). Bound
    // once on init (not per setOption) — ECharts keeps the handler across re-renders. The parent
    // decides whether the source chart can become a cross-filter (scatter/date-grouped/gauge have no
    // group-by category, so the parent no-ops those; see onSegmentClick in MetaDashboardView).
    chart.on('click', (params: unknown) => {
      const name = (params as { name?: unknown } | undefined)?.name
      if (typeof name === 'string' && name !== '') emit('segment-click', name)
    })
  }
  ensureResizeObserver()
  const option = buildChartOption(props.chartData, props.displayConfig)
  if (option) chart.setOption(option, true)
}

onMounted(renderChart)

// flush: 'post' — run AFTER the DOM updates so the canvas container exists when chartType
// switches into bar/line/pie; a pre-flush watch would no-op on the not-yet-rendered ref.
watch(() => [props.chartData, props.displayConfig], renderChart, { deep: true, flush: 'post' })

onBeforeUnmount(teardownChart)
</script>

<style scoped>
.meta-chart { width: 100%; }

.meta-chart__title {
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
  margin-bottom: 8px;
  text-align: center;
}

.meta-chart__restricted {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  gap: 6px;
  padding: 24px 18px;
  border: 1px dashed #cbd5e1;
  border-radius: 12px;
  background: #f8fafc;
  text-align: center;
}

.meta-chart__restricted strong { color: #0f172a; font-size: 14px; }
.meta-chart__restricted span { color: #64748b; font-size: 12px; }

.meta-chart__plot { width: 100%; }
.meta-chart__plot--pie { display: flex; align-items: flex-start; gap: 16px; }
.meta-chart__plot--pie .meta-chart__echarts { flex: 1; min-width: 0; }

.meta-chart__echarts { width: 100%; height: 250px; }

.meta-chart__gauge-note {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.4;
  color: #94a3b8;
  text-align: center;
}

.meta-chart__legend { display: flex; flex-direction: column; gap: 4px; }
.meta-chart__legend--inline { flex-direction: row; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
.meta-chart__legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.meta-chart__legend-item--clickable { cursor: pointer; border-radius: 4px; padding: 1px 3px; margin: -1px -3px; }
.meta-chart__legend-item--clickable:hover { background: #f1f5f9; }
.meta-chart__legend-item--clickable:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
.meta-chart__legend-swatch { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; }
.meta-chart__legend-label { color: #475569; }
.meta-chart__legend-value { color: #0f172a; font-weight: 600; margin-left: auto; }

.meta-chart__number { text-align: center; padding: 20px 0 4px; }
.meta-chart__number-value { font-size: 48px; font-weight: 800; color: #0f172a; }
.meta-chart__number-affix { font-size: 20px; color: #64748b; }
.meta-chart__number-label { text-align: center; font-size: 14px; color: #64748b; }

.meta-chart__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.meta-chart__table th {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 2px solid #e2e8f0;
  font-weight: 600;
  color: #475569;
}

.meta-chart__table td {
  padding: 6px 12px;
  border-bottom: 1px solid #f1f5f9;
  color: #0f172a;
}
</style>
