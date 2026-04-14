<template>
  <div class="meta-dashboard">
    <!-- Dashboard selector / header -->
    <div class="meta-dashboard__header">
      <div class="meta-dashboard__selector">
        <template v-if="editingName">
          <input
            ref="nameInputRef"
            v-model="nameInput"
            class="meta-dashboard__name-input"
            type="text"
            data-field="dashboard-name"
            @blur="finishRename"
            @keydown.enter="finishRename"
            @keydown.escape="editingName = false"
          />
        </template>
        <template v-else>
          <select
            v-if="dashboards.length > 1"
            v-model="activeDashboardId"
            class="meta-dashboard__select"
            data-field="dashboard-select"
          >
            <option v-for="d in dashboards" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
          <span v-else-if="activeDashboard" class="meta-dashboard__active-name" @dblclick="startRename">
            {{ activeDashboard.name }}
          </span>
        </template>
        <button
          v-if="activeDashboard && !editingName"
          class="meta-dashboard__btn meta-dashboard__btn--sm"
          type="button"
          title="Rename"
          data-action="rename"
          @click="startRename"
        >Rename</button>
      </div>
      <div class="meta-dashboard__actions">
        <button class="meta-dashboard__btn" type="button" data-action="add-panel" @click="showAddPanel = true">+ Add Panel</button>
        <button class="meta-dashboard__btn meta-dashboard__btn--primary" type="button" data-action="create-dashboard" @click="onCreateDashboard">+ New Dashboard</button>
      </div>
    </div>

    <div v-if="loading" class="meta-dashboard__empty">Loading dashboard...</div>
    <div v-else-if="!activeDashboard" class="meta-dashboard__empty" data-empty="true">
      No dashboards yet. Create your first dashboard.
    </div>

    <!-- Grid of panels -->
    <div v-else class="meta-dashboard__grid" data-grid="true">
      <div
        v-for="panel in sortedPanels"
        :key="panel.id"
        class="meta-dashboard__panel"
        :class="`meta-dashboard__panel--${panel.size}`"
        :data-panel-id="panel.id"
      >
        <div class="meta-dashboard__panel-header">
          <span class="meta-dashboard__panel-chart-name">{{ chartNameById(panel.chartId) }}</span>
          <div class="meta-dashboard__panel-controls">
            <select
              :value="panel.size"
              class="meta-dashboard__select meta-dashboard__select--sm"
              data-field="panel-size"
              @change="onResizePanel(panel.id, ($event.target as HTMLSelectElement).value as 'small' | 'medium' | 'large')"
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
            <button
              class="meta-dashboard__btn meta-dashboard__btn--icon meta-dashboard__btn--danger"
              type="button"
              data-action="remove-panel"
              @click="onRemovePanel(panel.id)"
            >&times;</button>
          </div>
        </div>
        <div class="meta-dashboard__panel-body">
          <MetaChartRenderer
            v-if="chartDataMap[panel.chartId]"
            :chart-data="chartDataMap[panel.chartId]"
            :display-config="chartConfigMap[panel.chartId]?.displayConfig"
          />
          <div v-else class="meta-dashboard__panel-loading">Loading chart...</div>
        </div>
      </div>
    </div>

    <!-- Add panel modal -->
    <div v-if="showAddPanel" class="meta-dashboard__modal-overlay" @click.self="showAddPanel = false">
      <div class="meta-dashboard__modal">
        <div class="meta-dashboard__modal-header">
          <h4>Add Chart Panel</h4>
          <button class="meta-dashboard__btn meta-dashboard__btn--icon" type="button" @click="showAddPanel = false">&times;</button>
        </div>
        <div class="meta-dashboard__modal-body">
          <div v-if="!charts.length" class="meta-dashboard__empty">No charts available. Create a chart first.</div>
          <div
            v-for="chart in charts"
            :key="chart.id"
            class="meta-dashboard__chart-option"
            :data-chart-option="chart.id"
            @click="onAddPanel(chart.id)"
          >
            <span>{{ chart.name }}</span>
            <span class="meta-dashboard__chart-type">{{ chart.chartType }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { Dashboard, DashboardPanel, ChartConfig, ChartData } from '../types'
import type { MultitableApiClient } from '../api/client'
import MetaChartRenderer from './MetaChartRenderer.vue'

const props = defineProps<{
  sheetId: string
  dashboardId?: string
  client?: MultitableApiClient
}>()

const loading = ref(false)
const dashboards = ref<Dashboard[]>([])
const charts = ref<ChartConfig[]>([])
const chartDataMap = ref<Record<string, ChartData>>({})
const chartConfigMap = ref<Record<string, ChartConfig>>({})
const activeDashboardId = ref<string>(props.dashboardId ?? '')
const showAddPanel = ref(false)
const editingName = ref(false)
const nameInput = ref('')
const nameInputRef = ref<HTMLInputElement | null>(null)

const activeDashboard = computed(() => dashboards.value.find((d) => d.id === activeDashboardId.value) ?? dashboards.value[0] ?? null)

const sortedPanels = computed(() => {
  if (!activeDashboard.value) return []
  return [...activeDashboard.value.panels].sort((a, b) => a.order - b.order)
})

function chartNameById(chartId: string): string {
  return chartConfigMap.value[chartId]?.name ?? chartId
}

async function loadData() {
  if (!props.client || !props.sheetId) return
  loading.value = true
  try {
    const [dbs, chs] = await Promise.all([
      props.client.listDashboards(props.sheetId),
      props.client.listCharts(props.sheetId),
    ])
    dashboards.value = dbs
    charts.value = chs
    for (const ch of chs) {
      chartConfigMap.value[ch.id] = ch
    }
    if (!activeDashboardId.value && dbs.length) {
      activeDashboardId.value = dbs[0].id
    }
    // Load chart data for active dashboard panels
    await loadPanelData()
  } catch {
    // silently fail
  } finally {
    loading.value = false
  }
}

async function loadPanelData() {
  if (!props.client || !activeDashboard.value) return
  const panels = activeDashboard.value.panels
  const promises = panels.map(async (panel) => {
    if (chartDataMap.value[panel.chartId]) return
    try {
      const data = await props.client!.getChartData(props.sheetId, panel.chartId)
      chartDataMap.value[panel.chartId] = data
    } catch {
      // skip
    }
  })
  await Promise.all(promises)
}

async function onCreateDashboard() {
  if (!props.client) return
  try {
    const db = await props.client.createDashboard(props.sheetId, { name: `Dashboard ${dashboards.value.length + 1}` })
    dashboards.value.push(db)
    activeDashboardId.value = db.id
  } catch {
    // skip
  }
}

async function onAddPanel(chartId: string) {
  if (!props.client || !activeDashboard.value) return
  showAddPanel.value = false
  const db = activeDashboard.value
  const newPanel: DashboardPanel = {
    id: `panel_${Date.now()}`,
    chartId,
    size: 'medium',
    order: db.panels.length,
  }
  const updated = [...db.panels, newPanel]
  try {
    const result = await props.client.updateDashboard(props.sheetId, db.id, { panels: updated })
    const idx = dashboards.value.findIndex((d) => d.id === db.id)
    if (idx >= 0) dashboards.value[idx] = result
    // Load chart data
    if (!chartDataMap.value[chartId]) {
      try {
        chartDataMap.value[chartId] = await props.client.getChartData(props.sheetId, chartId)
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
}

async function onRemovePanel(panelId: string) {
  if (!props.client || !activeDashboard.value) return
  const db = activeDashboard.value
  const updated = db.panels.filter((p) => p.id !== panelId)
  try {
    const result = await props.client.updateDashboard(props.sheetId, db.id, { panels: updated })
    const idx = dashboards.value.findIndex((d) => d.id === db.id)
    if (idx >= 0) dashboards.value[idx] = result
  } catch {
    // skip
  }
}

async function onResizePanel(panelId: string, size: 'small' | 'medium' | 'large') {
  if (!props.client || !activeDashboard.value) return
  const db = activeDashboard.value
  const updated = db.panels.map((p) => (p.id === panelId ? { ...p, size } : p))
  try {
    const result = await props.client.updateDashboard(props.sheetId, db.id, { panels: updated })
    const idx = dashboards.value.findIndex((d) => d.id === db.id)
    if (idx >= 0) dashboards.value[idx] = result
  } catch {
    // skip
  }
}

function startRename() {
  if (!activeDashboard.value) return
  nameInput.value = activeDashboard.value.name
  editingName.value = true
  void nextTick(() => nameInputRef.value?.focus())
}

async function finishRename() {
  editingName.value = false
  if (!props.client || !activeDashboard.value || !nameInput.value.trim()) return
  if (nameInput.value.trim() === activeDashboard.value.name) return
  try {
    const result = await props.client.updateDashboard(props.sheetId, activeDashboard.value.id, { name: nameInput.value.trim() })
    const idx = dashboards.value.findIndex((d) => d.id === activeDashboard.value!.id)
    if (idx >= 0) dashboards.value[idx] = result
  } catch {
    // skip
  }
}

watch(
  () => activeDashboard.value?.id,
  () => { void loadPanelData() },
)

watch(
  () => props.sheetId,
  () => { void loadData() },
  { immediate: true },
)
</script>

<style scoped>
.meta-dashboard { padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }

.meta-dashboard__header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.meta-dashboard__selector { display: flex; align-items: center; gap: 8px; }
.meta-dashboard__actions { display: flex; gap: 8px; }

.meta-dashboard__active-name { font-size: 16px; font-weight: 700; color: #0f172a; cursor: pointer; }

.meta-dashboard__name-input {
  border: 1px solid #2563eb;
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
  outline: none;
}

.meta-dashboard__select {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  background: #fff;
}

.meta-dashboard__select--sm { padding: 3px 6px; font-size: 11px; }

.meta-dashboard__btn {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 14px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  cursor: pointer;
}

.meta-dashboard__btn--primary { border-color: #2563eb; background: #2563eb; color: #fff; }
.meta-dashboard__btn--danger { border-color: #ef4444; color: #b91c1c; }
.meta-dashboard__btn--sm { padding: 3px 8px; font-size: 11px; }
.meta-dashboard__btn--icon { padding: 4px 8px; font-size: 16px; line-height: 1; }

.meta-dashboard__empty {
  padding: 20px;
  border-radius: 10px;
  font-size: 13px;
  background: #f8fafc;
  color: #64748b;
  text-align: center;
}

.meta-dashboard__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.meta-dashboard__panel {
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.meta-dashboard__panel--small { min-height: 160px; }
.meta-dashboard__panel--medium { min-height: 260px; grid-column: span 1; }
.meta-dashboard__panel--large { min-height: 360px; grid-column: span 2; }

.meta-dashboard__panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #f1f5f9;
}

.meta-dashboard__panel-chart-name { font-size: 13px; font-weight: 600; color: #0f172a; }
.meta-dashboard__panel-controls { display: flex; align-items: center; gap: 6px; }

.meta-dashboard__panel-body { padding: 12px 14px; flex: 1; display: flex; align-items: center; justify-content: center; }
.meta-dashboard__panel-loading { font-size: 12px; color: #94a3b8; }

.meta-dashboard__modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
}

.meta-dashboard__modal {
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 400px;
  max-width: 95vw;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
}

.meta-dashboard__modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid #e2e8f0;
}

.meta-dashboard__modal-header h4 { margin: 0; font-size: 15px; }

.meta-dashboard__modal-body {
  padding: 12px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-dashboard__chart-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}

.meta-dashboard__chart-option:hover { background: #f8fafc; }
.meta-dashboard__chart-type { font-size: 11px; color: #94a3b8; text-transform: uppercase; }
</style>
