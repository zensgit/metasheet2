<template>
  <div class="meta-chart" :data-chart-type="chartData.chartType">
    <div v-if="displayConfig?.title" class="meta-chart__title">{{ displayConfig.title }}</div>

    <!-- Bar chart -->
    <template v-if="chartData.chartType === 'bar'">
      <svg :viewBox="`0 0 ${barWidth} ${barHeight}`" class="meta-chart__svg" preserveAspectRatio="xMidYMid meet" data-chart="bar">
        <g v-for="(pt, idx) in chartData.dataPoints" :key="idx">
          <rect
            v-if="isVertical"
            :x="barPadding + idx * barSlotWidth + barSlotWidth * 0.1"
            :y="barHeight - barBottomPad - barScale(pt.value)"
            :width="barSlotWidth * 0.8"
            :height="barScale(pt.value)"
            :fill="pt.color || defaultColor(idx)"
            :data-bar-index="idx"
          />
          <rect
            v-else
            :x="barLeftPad"
            :y="barPadding + idx * barSlotHeight + barSlotHeight * 0.1"
            :width="hBarScale(pt.value)"
            :height="barSlotHeight * 0.8"
            :fill="pt.color || defaultColor(idx)"
            :data-bar-index="idx"
          />
          <text
            v-if="isVertical"
            :x="barPadding + idx * barSlotWidth + barSlotWidth / 2"
            :y="barHeight - 4"
            text-anchor="middle"
            class="meta-chart__bar-label"
          >{{ pt.label }}</text>
          <text
            v-if="isVertical && displayConfig?.showValues !== false"
            :x="barPadding + idx * barSlotWidth + barSlotWidth / 2"
            :y="barHeight - barBottomPad - barScale(pt.value) - 4"
            text-anchor="middle"
            class="meta-chart__bar-value"
          >{{ pt.value }}</text>
          <text
            v-if="!isVertical"
            :x="barLeftPad - 4"
            :y="barPadding + idx * barSlotHeight + barSlotHeight / 2 + 4"
            text-anchor="end"
            class="meta-chart__bar-label"
          >{{ pt.label }}</text>
          <text
            v-if="!isVertical && displayConfig?.showValues !== false"
            :x="barLeftPad + hBarScale(pt.value) + 4"
            :y="barPadding + idx * barSlotHeight + barSlotHeight / 2 + 4"
            text-anchor="start"
            class="meta-chart__bar-value"
          >{{ pt.value }}</text>
        </g>
      </svg>
    </template>

    <!-- Line chart -->
    <template v-else-if="chartData.chartType === 'line'">
      <svg :viewBox="`0 0 ${lineWidth} ${lineHeight}`" class="meta-chart__svg" preserveAspectRatio="xMidYMid meet" data-chart="line">
        <polyline
          :points="linePoints"
          fill="none"
          stroke="#2563eb"
          stroke-width="2"
          stroke-linejoin="round"
          class="meta-chart__line"
        />
        <circle
          v-for="(pt, idx) in lineCoords"
          :key="idx"
          :cx="pt.x"
          :cy="pt.y"
          r="4"
          fill="#2563eb"
          :data-point-index="idx"
        />
        <text
          v-for="(pt, idx) in lineCoords"
          :key="'l' + idx"
          :x="pt.x"
          :y="lineHeight - 4"
          text-anchor="middle"
          class="meta-chart__line-label"
        >{{ chartData.dataPoints[idx].label }}</text>
      </svg>
    </template>

    <!-- Pie chart -->
    <template v-else-if="chartData.chartType === 'pie'">
      <div class="meta-chart__pie-wrapper">
        <svg viewBox="0 0 200 200" class="meta-chart__svg meta-chart__svg--pie" preserveAspectRatio="xMidYMid meet" data-chart="pie">
          <path
            v-for="(seg, idx) in pieSegments"
            :key="idx"
            :d="seg.d"
            :fill="seg.color"
            :data-pie-index="idx"
          />
        </svg>
        <div v-if="displayConfig?.showLegend !== false" class="meta-chart__legend" data-legend="true">
          <div v-for="(pt, idx) in chartData.dataPoints" :key="idx" class="meta-chart__legend-item">
            <span class="meta-chart__legend-swatch" :style="{ background: pt.color || defaultColor(idx) }"></span>
            <span class="meta-chart__legend-label">{{ pt.label }}</span>
            <span class="meta-chart__legend-value">{{ pt.value }}</span>
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
            <th>Label</th>
            <th>Value</th>
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
import { computed } from 'vue'
import type { ChartData, ChartDisplayConfig } from '../types'

const props = defineProps<{
  chartData: ChartData
  displayConfig?: ChartDisplayConfig
}>()

const COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16']

function defaultColor(idx: number): string {
  return COLORS[idx % COLORS.length]
}

const isVertical = computed(() => props.displayConfig?.orientation !== 'horizontal')

// Bar chart helpers
const barWidth = 400
const barHeight = 250
const barPadding = 20
const barBottomPad = 24
const barLeftPad = 80
const barSlotWidth = computed(() => {
  const count = props.chartData.dataPoints.length || 1
  return (barWidth - barPadding * 2) / count
})
const barSlotHeight = computed(() => {
  const count = props.chartData.dataPoints.length || 1
  return (barHeight - barPadding * 2) / count
})
const barMax = computed(() => Math.max(1, ...props.chartData.dataPoints.map((p) => p.value)))

function barScale(val: number): number {
  return (val / barMax.value) * (barHeight - barPadding - barBottomPad - 20)
}

function hBarScale(val: number): number {
  return (val / barMax.value) * (barWidth - barLeftPad - 20)
}

// Line chart helpers
const lineWidth = 400
const lineHeight = 250
const linePad = 30
const lineCoords = computed(() => {
  const pts = props.chartData.dataPoints
  if (!pts.length) return []
  const max = Math.max(1, ...pts.map((p) => p.value))
  const xStep = pts.length > 1 ? (lineWidth - linePad * 2) / (pts.length - 1) : 0
  return pts.map((p, i) => ({
    x: linePad + i * xStep,
    y: lineHeight - linePad - 20 - (p.value / max) * (lineHeight - linePad * 2 - 20),
  }))
})

const linePoints = computed(() => lineCoords.value.map((c) => `${c.x},${c.y}`).join(' '))

// Pie chart helpers
const pieSegments = computed(() => {
  const pts = props.chartData.dataPoints
  const total = pts.reduce((s, p) => s + p.value, 0) || 1
  const segments: Array<{ d: string; color: string }> = []
  let startAngle = -Math.PI / 2
  for (let i = 0; i < pts.length; i++) {
    const angle = (pts[i].value / total) * Math.PI * 2
    const endAngle = startAngle + angle
    const largeArc = angle > Math.PI ? 1 : 0
    const cx = 100
    const cy = 100
    const r = 90
    const x1 = cx + r * Math.cos(startAngle)
    const y1 = cy + r * Math.sin(startAngle)
    const x2 = cx + r * Math.cos(endAngle)
    const y2 = cy + r * Math.sin(endAngle)
    // For a single-item pie, draw a full circle
    if (pts.length === 1) {
      segments.push({
        d: `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`,
        color: pts[i].color || defaultColor(i),
      })
    } else {
      segments.push({
        d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`,
        color: pts[i].color || defaultColor(i),
      })
    }
    startAngle = endAngle
  }
  return segments
})
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

.meta-chart__svg {
  width: 100%;
  height: auto;
  display: block;
}

.meta-chart__svg--pie { max-width: 200px; }

.meta-chart__bar-label { font-size: 10px; fill: #64748b; }
.meta-chart__bar-value { font-size: 9px; fill: #0f172a; font-weight: 600; }
.meta-chart__line-label { font-size: 10px; fill: #64748b; }

.meta-chart__pie-wrapper { display: flex; align-items: flex-start; gap: 16px; }

.meta-chart__legend { display: flex; flex-direction: column; gap: 4px; }
.meta-chart__legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; }
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
