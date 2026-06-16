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
          :title="viewRenderLabel('dashboard.rename', isZh)"
          data-action="rename"
          @click="startRename"
        >{{ viewRenderLabel('dashboard.rename', isZh) }}</button>
      </div>
      <div class="meta-dashboard__actions">
        <button
          class="meta-dashboard__btn meta-dashboard__btn--primary"
          type="button"
          data-action="create-chart"
          :disabled="!activeDashboard"
          @click="openCreateChart"
        >{{ viewRenderLabel('dashboard.newChart', isZh) }}</button>
        <button class="meta-dashboard__btn" type="button" data-action="add-panel" @click="showAddPanel = true">{{ viewRenderLabel('dashboard.addPanel', isZh) }}</button>
        <button class="meta-dashboard__btn" type="button" data-action="add-widget" :disabled="!activeDashboard" @click="openAddWidget">{{ viewRenderLabel('dashboard.addWidget', isZh) }}</button>
        <button class="meta-dashboard__btn meta-dashboard__btn--primary" type="button" data-action="create-dashboard" @click="onCreateDashboard">{{ viewRenderLabel('dashboard.newDashboard', isZh) }}</button>
      </div>
    </div>

    <div v-if="loading" class="meta-dashboard__empty">{{ viewRenderLabel('dashboard.loadingDashboard', isZh) }}</div>
    <div v-else-if="!activeDashboard" class="meta-dashboard__empty" data-empty="true">
      {{ viewRenderLabel('dashboard.empty', isZh) }}
    </div>

    <!-- Grid of panels -->
    <div v-else class="meta-dashboard__grid" data-grid="true">
      <div
        v-for="panel in sortedPanels"
        :key="panel.id"
        class="meta-dashboard__panel"
        :class="`meta-dashboard__panel--${panel.size}`"
        :data-panel-id="panel.id"
        :data-panel-type="panelType(panel)"
      >
        <div class="meta-dashboard__panel-header">
          <span class="meta-dashboard__panel-chart-name">{{ panelTitle(panel) }}</span>
          <div class="meta-dashboard__panel-controls">
            <select
              :value="panel.size"
              class="meta-dashboard__select meta-dashboard__select--sm"
              data-field="panel-size"
              @change="onResizePanel(panel.id, ($event.target as HTMLSelectElement).value as 'small' | 'medium' | 'large')"
            >
              <option value="small">{{ viewSizeLabel('small', isZh) }}</option>
              <option value="medium">{{ viewSizeLabel('medium', isZh) }}</option>
              <option value="large">{{ viewSizeLabel('large', isZh) }}</option>
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
          <!-- B4: branch the body on the widget kind. A legacy panel (no `type`) is a chart. -->
          <!-- Chart widget (default / legacy). Data/config resolved via helpers (which narrow the
               now-optional chartId inside a function body) so the bindings never depend on
               cross-element template narrowing that vue-tsc may not perform. -->
          <template v-if="panelType(panel) === 'chart'">
            <MetaChartRenderer
              v-if="panelChartData(panel)"
              :chart-data="panelChartData(panel)!"
              :display-config="panelChartConfig(panel)?.displayConfig"
              :aggregation="panelChartConfig(panel)?.dataSource?.aggregation?.function"
            />
            <div v-else class="meta-dashboard__panel-loading">{{ viewRenderLabel('dashboard.loadingChart', isZh) }}</div>
          </template>
          <!-- Metric / number card: computed via the field-read-enforced preview-data path, keyed by panel.id. -->
          <template v-else-if="panelType(panel) === 'metric'">
            <MetaChartRenderer
              v-if="metricDataMap[panel.id]"
              :chart-data="metricDataMap[panel.id]"
              :display-config="metricDisplayConfig(panel)"
              :aggregation="panel.metricConfig?.aggregation"
            />
            <div v-else class="meta-dashboard__panel-loading" data-metric-loading="true">{{ viewRenderLabel('dashboard.loadingMetric', isZh) }}</div>
          </template>
          <!-- Text / markdown note: rendered through the SHARED rich-longtext DOMPurify chokepoint (never raw v-html). -->
          <template v-else-if="panelType(panel) === 'text'">
            <MetaRichLongTextRender
              v-if="panel.textConfig?.content"
              class="meta-dashboard__text-widget"
              data-widget="text"
              :html="panel.textConfig.content"
            />
            <div v-else class="meta-dashboard__panel-loading" data-widget="text-empty">{{ viewRenderLabel('dashboard.textEmpty', isZh) }}</div>
          </template>
          <!-- Filter / control: PRESENTATIONAL ONLY — local UI state, drives no other panel. -->
          <template v-else-if="panelType(panel) === 'filter'">
            <div class="meta-dashboard__filter-widget" data-widget="filter">
              <select
                :value="filterSelections[panel.id] ?? ''"
                class="meta-dashboard__select meta-dashboard__select--sm"
                data-field="filter-control"
                @change="onFilterControlChange(panel.id, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ viewRenderLabel('dashboard.filterAllOption', isZh) }}</option>
                <option
                  v-for="field in chartFields"
                  :key="field.id"
                  :value="field.id"
                >{{ field.name }}</option>
              </select>
              <small class="meta-dashboard__hint" data-hint="filter-presentational">{{ viewRenderLabel('dashboard.filterPresentationalNote', isZh) }}</small>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Add panel modal -->
    <div v-if="showAddPanel" class="meta-dashboard__modal-overlay" @click.self="showAddPanel = false">
      <div class="meta-dashboard__modal">
        <div class="meta-dashboard__modal-header">
          <h4>{{ viewRenderLabel('dashboard.addChartPanel', isZh) }}</h4>
          <button class="meta-dashboard__btn meta-dashboard__btn--icon" type="button" @click="showAddPanel = false">&times;</button>
        </div>
        <div class="meta-dashboard__modal-body">
          <div v-if="!charts.length" class="meta-dashboard__empty">{{ viewRenderLabel('dashboard.noCharts', isZh) }}</div>
          <div
            v-for="chart in charts"
            :key="chart.id"
            class="meta-dashboard__chart-option"
            :data-chart-option="chart.id"
            @click="onAddPanel(chart.id)"
          >
            <span>{{ chart.name }}</span>
            <span class="meta-dashboard__chart-type">{{ chart.chartType }}</span>
            <span class="meta-dashboard__chart-option-actions">
              <button
                class="meta-dashboard__btn meta-dashboard__btn--icon"
                type="button"
                data-action="edit-chart"
                :data-edit-chart="chart.id"
                @click.stop="openEditChart(chart.id)"
              >{{ viewRenderLabel('dashboard.editChart', isZh) }}</button>
              <button
                class="meta-dashboard__btn meta-dashboard__btn--icon meta-dashboard__btn--danger"
                type="button"
                data-action="delete-chart"
                :data-delete-chart="chart.id"
                @click.stop="onDeleteChart(chart.id)"
              >{{ viewRenderLabel('dashboard.deleteChart', isZh) }}</button>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- B4: Add non-chart widget modal (metric / text / filter). Closed by default. -->
    <div v-if="showAddWidget" class="meta-dashboard__modal-overlay" @click.self="showAddWidget = false">
      <form class="meta-dashboard__modal" data-modal="add-widget" @submit.prevent="onSubmitWidget">
        <div class="meta-dashboard__modal-header">
          <h4>{{ viewRenderLabel('dashboard.addWidgetTitle', isZh) }}</h4>
          <button class="meta-dashboard__btn meta-dashboard__btn--icon" type="button" @click="showAddWidget = false">&times;</button>
        </div>
        <div class="meta-dashboard__modal-body">
          <label class="meta-dashboard__field">
            <span>{{ viewRenderLabel('dashboard.widgetKind', isZh) }}</span>
            <select v-model="widgetDraft.kind" class="meta-dashboard__select" data-field="widget-kind">
              <option value="metric">{{ viewRenderLabel('dashboard.widgetKindMetric', isZh) }}</option>
              <option value="text">{{ viewRenderLabel('dashboard.widgetKindText', isZh) }}</option>
              <option value="filter">{{ viewRenderLabel('dashboard.widgetKindFilter', isZh) }}</option>
            </select>
          </label>
          <label class="meta-dashboard__field">
            <span>{{ viewRenderLabel('dashboard.widgetTitle', isZh) }}</span>
            <input
              v-model="widgetDraft.title"
              class="meta-dashboard__input"
              type="text"
              data-field="widget-title"
            />
          </label>

          <!-- Metric config -->
          <template v-if="widgetDraft.kind === 'metric'">
            <label class="meta-dashboard__field">
              <span>{{ viewRenderLabel('dashboard.aggregation', isZh) }}</span>
              <select v-model="widgetDraft.aggregation" class="meta-dashboard__select" data-field="widget-aggregation">
                <option value="count">count</option>
                <option value="sum">sum</option>
                <option value="avg">avg</option>
                <option value="min">min</option>
                <option value="max">max</option>
              </select>
            </label>
            <label v-if="widgetRequiresValueField" class="meta-dashboard__field">
              <span>{{ viewRenderLabel('dashboard.valueField', isZh) }}</span>
              <select v-model="widgetDraft.valueFieldId" class="meta-dashboard__select" data-field="widget-value-field">
                <option value="">{{ viewRenderLabel('common.chooseField', isZh) }}</option>
                <option v-for="field in numericFields" :key="field.id" :value="field.id">
                  {{ field.name }} · {{ fieldTypeLabel(field.type, isZh) }}
                </option>
              </select>
              <small v-if="!numericFields.length" class="meta-dashboard__hint">{{ viewRenderLabel('dashboard.noNumericFields', isZh) }}</small>
            </label>
            <label class="meta-dashboard__field">
              <span>{{ viewRenderLabel('dashboard.metricPrefix', isZh) }}</span>
              <input
                v-model="widgetDraft.prefix"
                class="meta-dashboard__input"
                type="text"
                data-field="widget-prefix"
              />
            </label>
            <label class="meta-dashboard__field">
              <span>{{ viewRenderLabel('dashboard.metricSuffix', isZh) }}</span>
              <input
                v-model="widgetDraft.suffix"
                class="meta-dashboard__input"
                type="text"
                data-field="widget-suffix"
              />
            </label>
          </template>

          <!-- Text config (routes through the rich-longtext sanitizer on render) -->
          <template v-else-if="widgetDraft.kind === 'text'">
            <label class="meta-dashboard__field">
              <span>{{ viewRenderLabel('dashboard.textContent', isZh) }}</span>
              <textarea
                v-model="widgetDraft.textContent"
                class="meta-dashboard__input meta-dashboard__textarea"
                data-field="widget-text-content"
                :placeholder="viewRenderLabel('dashboard.textContentPlaceholder', isZh)"
                rows="4"
              ></textarea>
            </label>
          </template>

          <!-- Filter config (presentational only) -->
          <template v-else-if="widgetDraft.kind === 'filter'">
            <label class="meta-dashboard__field">
              <span>{{ viewRenderLabel('dashboard.filterField', isZh) }}</span>
              <select v-model="widgetDraft.filterFieldId" class="meta-dashboard__select" data-field="widget-filter-field">
                <option value="">{{ viewRenderLabel('common.chooseField', isZh) }}</option>
                <option v-for="field in chartFields" :key="field.id" :value="field.id">
                  {{ field.name }} · {{ fieldTypeLabel(field.type, isZh) }}
                </option>
              </select>
              <small class="meta-dashboard__hint" data-hint="filter-presentational-config">{{ viewRenderLabel('dashboard.filterPresentationalNote', isZh) }}</small>
            </label>
          </template>
        </div>
        <div class="meta-dashboard__modal-footer">
          <button class="meta-dashboard__btn" type="button" @click="showAddWidget = false">{{ viewRenderLabel('dashboard.cancel', isZh) }}</button>
          <button
            class="meta-dashboard__btn meta-dashboard__btn--primary"
            type="submit"
            data-action="submit-add-widget"
            :disabled="addWidgetDisabled || addingWidget"
          >{{ viewRenderLabel('dashboard.addWidgetAction', isZh) }}</button>
        </div>
      </form>
    </div>

    <!-- Create chart modal -->
    <div v-if="showCreateChart" class="meta-dashboard__modal-overlay" @click.self="showCreateChart = false">
      <form class="meta-dashboard__modal" data-modal="create-chart" @submit.prevent="onSubmitChart">
        <div class="meta-dashboard__modal-header">
          <h4>{{ viewRenderLabel(editingChartId ? 'dashboard.editChartTitle' : 'dashboard.createChartTitle', isZh) }}</h4>
          <button class="meta-dashboard__btn meta-dashboard__btn--icon" type="button" @click="showCreateChart = false">&times;</button>
        </div>
        <div class="meta-dashboard__modal-body">
          <label class="meta-dashboard__field">
            <span>{{ viewRenderLabel('dashboard.chartName', isZh) }}</span>
            <input
              v-model="chartDraft.name"
              class="meta-dashboard__input"
              type="text"
              data-field="chart-name"
            />
          </label>
          <label class="meta-dashboard__field">
            <span>{{ viewRenderLabel('dashboard.chartType', isZh) }}</span>
            <select v-model="chartDraft.chartType" class="meta-dashboard__select" data-field="chart-type" @change="chartDraft.variant = ''">
              <option value="bar">bar</option>
              <option value="line">line</option>
              <option value="area">area</option>
              <option value="pie">pie</option>
              <option value="funnel">funnel</option>
              <option value="gauge">gauge</option>
              <option value="scatter">scatter</option>
              <option value="number">number</option>
              <option value="table">table</option>
            </select>
          </label>
          <!-- v2-c: single-series render variant; shown only for pie (donut) / line (area). -->
          <label v-if="chartDraft.chartType === 'pie' || chartDraft.chartType === 'line'" class="meta-dashboard__field">
            <span>{{ viewRenderLabel('dashboard.chartVariant', isZh) }}</span>
            <select v-model="chartDraft.variant" class="meta-dashboard__select" data-field="chart-variant">
              <option value="">{{ viewRenderLabel('dashboard.variantStandard', isZh) }}</option>
              <option v-if="chartDraft.chartType === 'pie'" value="donut">{{ viewRenderLabel('dashboard.variantDonut', isZh) }}</option>
              <option v-if="chartDraft.chartType === 'line'" value="area">{{ viewRenderLabel('dashboard.variantArea', isZh) }}</option>
            </select>
          </label>
          <label v-if="!isScatter" class="meta-dashboard__field">
            <span>{{ viewRenderLabel('dashboard.groupBy', isZh) }}</span>
            <select
              v-model="chartDraft.groupByFieldId"
              class="meta-dashboard__select"
              data-field="chart-group-by"
              :disabled="editingDateGrouped"
            >
              <option value="">{{ viewRenderLabel('common.chooseField', isZh) }}</option>
              <option v-for="field in groupableFields" :key="field.id" :value="field.id">
                {{ field.name }} · {{ fieldTypeLabel(field.type, isZh) }}
              </option>
            </select>
            <small v-if="editingDateGrouped" class="meta-dashboard__hint" data-hint="date-grouping-locked">
              {{ viewRenderLabel('dashboard.dateGroupingLocked', isZh) }}
            </small>
            <small v-else-if="!groupableFields.length" class="meta-dashboard__hint">{{ viewRenderLabel('dashboard.noGroupableFields', isZh) }}</small>
          </label>
          <label v-if="!isScatter" class="meta-dashboard__field">
            <span>{{ viewRenderLabel('dashboard.aggregation', isZh) }}</span>
            <select v-model="chartDraft.aggregation" class="meta-dashboard__select" data-field="chart-aggregation">
              <option value="count">count</option>
              <option value="sum">sum</option>
              <option value="avg">avg</option>
              <option value="min">min</option>
              <option value="max">max</option>
            </select>
          </label>
          <label v-if="requiresValueField" class="meta-dashboard__field">
            <span>{{ viewRenderLabel('dashboard.valueField', isZh) }}</span>
            <select v-model="chartDraft.valueFieldId" class="meta-dashboard__select" data-field="chart-value-field">
              <option value="">{{ viewRenderLabel('common.chooseField', isZh) }}</option>
              <option v-for="field in numericFields" :key="field.id" :value="field.id">
                {{ field.name }} · {{ fieldTypeLabel(field.type, isZh) }}
              </option>
            </select>
            <small v-if="!numericFields.length" class="meta-dashboard__hint">{{ viewRenderLabel('dashboard.noNumericFields', isZh) }}</small>
          </label>
          <!-- r12 scatter: per-record x/y projection — x + y are required numeric fields; color/size are
               optional. Shown ONLY for scatter (groupBy/aggregation/value/series/bar-mode are hidden above). -->
          <template v-if="isScatter">
            <label class="meta-dashboard__field">
              <span>{{ viewRenderLabel('dashboard.xField', isZh) }}</span>
              <select v-model="chartDraft.xFieldId" class="meta-dashboard__select" data-field="chart-x-field">
                <option value="">{{ viewRenderLabel('common.chooseField', isZh) }}</option>
                <option v-for="field in numericFields" :key="field.id" :value="field.id">
                  {{ field.name }} · {{ fieldTypeLabel(field.type, isZh) }}
                </option>
              </select>
            </label>
            <label class="meta-dashboard__field">
              <span>{{ viewRenderLabel('dashboard.yField', isZh) }}</span>
              <select v-model="chartDraft.yFieldId" class="meta-dashboard__select" data-field="chart-y-field">
                <option value="">{{ viewRenderLabel('common.chooseField', isZh) }}</option>
                <option v-for="field in numericFields" :key="field.id" :value="field.id">
                  {{ field.name }} · {{ fieldTypeLabel(field.type, isZh) }}
                </option>
              </select>
              <small v-if="!numericFields.length" class="meta-dashboard__hint">{{ viewRenderLabel('dashboard.noNumericFields', isZh) }}</small>
            </label>
            <label class="meta-dashboard__field">
              <span>{{ viewRenderLabel('dashboard.colorField', isZh) }}</span>
              <select v-model="chartDraft.colorFieldId" class="meta-dashboard__select" data-field="chart-color-field">
                <option value="">{{ viewRenderLabel('common.none', isZh) }}</option>
                <option v-for="field in groupableFields" :key="field.id" :value="field.id">
                  {{ field.name }} · {{ fieldTypeLabel(field.type, isZh) }}
                </option>
              </select>
            </label>
            <label class="meta-dashboard__field">
              <span>{{ viewRenderLabel('dashboard.sizeField', isZh) }}</span>
              <select v-model="chartDraft.sizeFieldId" class="meta-dashboard__select" data-field="chart-size-field">
                <option value="">{{ viewRenderLabel('common.none', isZh) }}</option>
                <option v-for="field in numericFields" :key="field.id" :value="field.id">
                  {{ field.name }} · {{ fieldTypeLabel(field.type, isZh) }}
                </option>
              </select>
              <small class="meta-dashboard__hint" data-hint="scatter-fields">{{ viewRenderLabel('dashboard.scatterFieldHint', isZh) }}</small>
            </label>
          </template>
          <!-- v2-d: series split — for any bar chart (grouped or stacked); needs a primary groupBy. -->
          <label v-if="seriesByAllowed" class="meta-dashboard__field">
            <span>{{ viewRenderLabel('dashboard.seriesBy', isZh) }}</span>
            <select
              v-model="chartDraft.seriesByFieldId"
              class="meta-dashboard__select"
              data-field="chart-series-by"
              :disabled="!hasPrimaryAxis"
            >
              <option value="">{{ viewRenderLabel('dashboard.seriesByNone', isZh) }}</option>
              <option v-for="field in groupableFields" :key="field.id" :value="field.id">
                {{ field.name }} · {{ fieldTypeLabel(field.type, isZh) }}
              </option>
            </select>
            <small class="meta-dashboard__hint" data-hint="series-split">{{ viewRenderLabel('dashboard.seriesByHint', isZh) }}</small>
          </label>
          <!-- v2-d-b1: series layout (stacked vs grouped). Stacked offered only for an additive aggregation. -->
          <label v-if="barModeShown" class="meta-dashboard__field">
            <span>{{ viewRenderLabel('dashboard.barMode', isZh) }}</span>
            <select v-model="chartDraft.barMode" class="meta-dashboard__select" data-field="chart-bar-mode">
              <option v-if="stackedAllowed" value="stacked">{{ viewRenderLabel('dashboard.barModeStacked', isZh) }}</option>
              <option value="grouped">{{ viewRenderLabel('dashboard.barModeGrouped', isZh) }}</option>
            </select>
            <small v-if="!stackedAllowed" class="meta-dashboard__hint" data-hint="bar-mode-grouped-only">{{ viewRenderLabel('dashboard.barModeAdditiveOnly', isZh) }}</small>
          </label>
          <div v-if="createChartError" class="meta-dashboard__error" data-error="create-chart">{{ createChartError }}</div>
          <section class="meta-dashboard__preview" data-chart-preview="true">
            <div class="meta-dashboard__preview-title">{{ viewRenderLabel('dashboard.livePreview', isZh) }}</div>
            <div v-if="createChartDisabled" class="meta-dashboard__preview-empty" data-chart-preview-empty="true">
              {{ viewRenderLabel('dashboard.previewFillRequired', isZh) }}
            </div>
            <div v-else-if="previewLoading" class="meta-dashboard__panel-loading" data-chart-preview-loading="true">
              {{ viewRenderLabel('dashboard.loadingPreview', isZh) }}
            </div>
            <div v-else-if="previewError" class="meta-dashboard__error" data-chart-preview-error="true">
              {{ viewRenderLabel('dashboard.previewError', isZh) }}
            </div>
            <div v-else-if="previewChartData" class="meta-dashboard__preview-chart" data-chart-preview-result="true">
              <MetaChartRenderer
                :chart-data="previewChartData"
                :display-config="previewDisplayConfig"
                :aggregation="chartDraft.aggregation"
              />
            </div>
            <div v-else class="meta-dashboard__preview-empty" data-chart-preview-empty="true">
              {{ viewRenderLabel('dashboard.previewWaiting', isZh) }}
            </div>
          </section>
        </div>
        <div class="meta-dashboard__modal-footer">
          <button class="meta-dashboard__btn" type="button" @click="showCreateChart = false">{{ viewRenderLabel('dashboard.cancel', isZh) }}</button>
          <button
            class="meta-dashboard__btn meta-dashboard__btn--primary"
            type="submit"
            data-action="submit-create-chart"
            :disabled="createChartDisabled || creatingChart"
          >{{ viewRenderLabel(editingChartId ? 'dashboard.saveChart' : 'dashboard.createChart', isZh) }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script lang="ts">
import { defineAsyncComponent } from 'vue'
import MetaChartLoadError from './MetaChartLoadError.vue'

// S1-9: the ECharts renderer is the only echarts importer — loading it async puts echarts in its
// own lazy chunk (≈150KB+ off the workbench bundle); panels keep their loading state meanwhile.
// MODULE scope (plain <script>), NOT <script setup>: setup-scope would create a fresh loader
// closure per component instance, losing Vue's resolved-component cache across remounts.
//
// r2 item 3: a lazy-chunk network failure (or a slow CDN past `timeout`) previously rendered the
// panel silently empty. `errorComponent` surfaces a 'chart failed to load' + Retry fallback (Vue
// passes it a `retry` prop that re-attempts the loader); `timeout` bounds the wait so a stalled
// fetch eventually trips the error path instead of hanging on the loading state forever.
const MetaChartRenderer = defineAsyncComponent({
  loader: () => import('./MetaChartRenderer.vue'),
  errorComponent: MetaChartLoadError,
  timeout: 30_000,
})
</script>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import type { AggregationFunction, ChartDisplayConfig, ChartType, Dashboard, DashboardPanel, DashboardPanelType, ChartConfig, ChartCreateInput, ChartData, ChartDataSource, MetaField, MetaFieldType } from '../types'
import type { MultitableApiClient } from '../api/client'
import { useLocale } from '../../composables/useLocale'
import { dashboardDefaultName, viewRenderLabel, viewSizeLabel } from '../utils/meta-view-render-labels'
import { fieldTypeLabel } from '../utils/meta-core-labels'
import { filterPropertyVisibleFields } from '../utils/field-permissions'
import MetaRichLongTextRender from './cells/MetaRichLongTextRender.vue'

const props = defineProps<{
  sheetId: string
  dashboardId?: string
  fields?: MetaField[]
  client?: MultitableApiClient
}>()

const loading = ref(false)
const dashboards = ref<Dashboard[]>([])
const charts = ref<ChartConfig[]>([])
const chartDataMap = ref<Record<string, ChartData>>({})
const chartConfigMap = ref<Record<string, ChartConfig>>({})
// B4: metric-card data is keyed by panel.id (a metric has no chartId) so it never
// collides with the chartId-keyed chartDataMap.
const metricDataMap = ref<Record<string, ChartData>>({})
// B4: presentational filter selections — LOCAL UI state only, keyed by panel.id.
// Deliberately not persisted and drives nothing else (scoped-out functional filter).
const filterSelections = ref<Record<string, string>>({})
const activeDashboardId = ref<string>(props.dashboardId ?? '')
const showAddPanel = ref(false)
const showAddWidget = ref(false)
const addingWidget = ref(false)
const showCreateChart = ref(false)
const editingChartId = ref<string | null>(null)
const creatingChart = ref(false)
const createChartError = ref('')
const previewChartData = ref<ChartData | null>(null)
const previewLoading = ref(false)
const previewError = ref('')
const editingName = ref(false)
const nameInput = ref('')
const nameInputRef = ref<HTMLInputElement | null>(null)
const { isZh } = useLocale()

const GROUPABLE_FIELD_TYPES = new Set<MetaFieldType>([
  'string',
  'number',
  'currency',
  'percent',
  'rating',
  'duration',
  'boolean',
  'date',
  'dateTime',
  'formula',
  'select',
  'lookup',
  'rollup',
])
const NUMERIC_FIELD_TYPES = new Set<MetaFieldType>(['number', 'currency', 'percent', 'rating', 'duration', 'rollup'])
const AGGREGATIONS_REQUIRING_VALUE = new Set<AggregationFunction>(['sum', 'avg', 'min', 'max'])
// v2-d: only additive aggregations make a stacked total meaningful (Σ segments == the single bar).
const ADDITIVE_AGGREGATIONS = new Set<AggregationFunction>(['sum', 'count'])

const chartDraft = ref({
  name: '',
  chartType: 'bar' as ChartType,
  groupByFieldId: '',
  aggregation: 'count' as AggregationFunction,
  valueFieldId: '',
  // v2-c: single-series render variant; only meaningful for pie ('donut') / line ('area').
  variant: '' as '' | 'donut' | 'area',
  // v2-d: bar series split (groupBy × seriesBy); only meaningful for a bar chart.
  seriesByFieldId: '',
  // v2-d-b1: bar series layout — 'stacked' (default) or 'grouped' (side-by-side, allows non-additive).
  barMode: 'stacked' as 'stacked' | 'grouped',
  // r12 scatter (only meaningful for chartType === 'scatter'): x/y are required numeric fields;
  // color sets the per-point category, size the per-point bubble size.
  xFieldId: '',
  yFieldId: '',
  colorFieldId: '',
  sizeFieldId: '',
})

// B4: the non-chart widget authoring draft (metric / text / filter).
const widgetDraft = ref({
  kind: 'metric' as Exclude<DashboardPanelType, 'chart'>,
  title: '',
  // metric
  aggregation: 'count' as AggregationFunction,
  valueFieldId: '',
  prefix: '',
  suffix: '',
  // text
  textContent: '',
  // filter (presentational)
  filterFieldId: '',
})

const activeDashboard = computed(() => dashboards.value.find((d) => d.id === activeDashboardId.value) ?? dashboards.value[0] ?? null)
const editingChart = computed(() => editingChartId.value ? chartConfigMap.value[editingChartId.value] ?? null : null)
const editingDateGrouped = computed(() => Boolean(editingChart.value?.dataSource.dateFieldId))

const chartFields = computed(() => filterPropertyVisibleFields(props.fields ?? []))
const groupableFields = computed(() => chartFields.value.filter((field) => GROUPABLE_FIELD_TYPES.has(field.type)))
const numericFields = computed(() => chartFields.value.filter((field) => NUMERIC_FIELD_TYPES.has(field.type)))
// r12: scatter is the one non-grouped chart type — it hides groupBy/aggregation/value/series/bar-mode
// and shows x/y/color/size pickers instead.
const isScatter = computed(() => chartDraft.value.chartType === 'scatter')
const requiresValueField = computed(() => !isScatter.value && AGGREGATIONS_REQUIRING_VALUE.has(chartDraft.value.aggregation))
// v2-d / v2-d-b1: the series-split picker is offered for any bar chart with a non-date-grouped
// primary axis (grouped layout accepts any aggregation). Whether STACKED is a legal layout depends
// on the aggregation being additive (sum/count) — see `stackedAllowed` + the producer/validator.
// v2-d-b2: line carries a series split too (overlaid lines). The series picker is offered for any
// bar OR line chart with a non-date-grouped primary axis.
// v2-d-b3: the series picker is offered for any bar/line chart — including a date-grouped chart, whose
// date axis is the primary (groupByFieldId stays disabled there). `hasPrimaryAxis` gates the rest:
// a series split needs a primary axis = a groupBy field OR an (edited) date axis.
const seriesByAllowed = computed(() =>
  chartDraft.value.chartType === 'bar' || chartDraft.value.chartType === 'line',
)
const hasPrimaryAxis = computed(() => !!chartDraft.value.groupByFieldId || editingDateGrouped.value)
const stackedAllowed = computed(() => ADDITIVE_AGGREGATIONS.has(chartDraft.value.aggregation))
// The layout (barMode) control is bar-only (lines never stack/group); appears once a series is chosen.
const barModeShown = computed(() => chartDraft.value.chartType === 'bar' && !!chartDraft.value.seriesByFieldId)
// Clear an inapplicable series field, and fall back to grouped when stacked is illegal, whenever the
// gating inputs change (type/aggregation/groupBy/date).
watch(
  () => [chartDraft.value.chartType, chartDraft.value.aggregation, chartDraft.value.groupByFieldId, editingDateGrouped.value],
  () => {
    if (chartDraft.value.seriesByFieldId && !(seriesByAllowed.value && hasPrimaryAxis.value)) {
      chartDraft.value.seriesByFieldId = ''
    }
    // v2-d-b1: stacked requires an additive aggregation; if it's no longer additive, fall back to grouped.
    if (!stackedAllowed.value && chartDraft.value.barMode === 'stacked') {
      chartDraft.value.barMode = 'grouped'
    }
  },
)
const createChartDisabled = computed(() => {
  if (!activeDashboard.value) return true
  if (!chartDraft.value.name.trim()) return true
  // r12 scatter: requires BOTH x and y fields; it has no groupBy/aggregation to validate.
  if (isScatter.value) {
    return !chartDraft.value.xFieldId || !chartDraft.value.yFieldId
  }
  if (!editingDateGrouped.value && !chartDraft.value.groupByFieldId) return true
  if (requiresValueField.value && !chartDraft.value.valueFieldId) return true
  return false
})
const previewDisplayConfig = computed(() => buildChartInput(editingChart.value ?? undefined).displayConfig)

const sortedPanels = computed(() => {
  if (!activeDashboard.value) return []
  return [...activeDashboard.value.panels].sort((a, b) => a.order - b.order)
})

function chartNameById(chartId: string): string {
  return chartConfigMap.value[chartId]?.name ?? chartId
}

// B4: a legacy panel (no `type`) is a chart — read the discriminator everywhere as `type ?? 'chart'`.
function panelType(panel: DashboardPanel): DashboardPanelType {
  return panel.type ?? 'chart'
}

// B4: resolve a chart panel's loaded data / config from its (now-optional) chartId. The narrowing
// happens inside the function body, so the template bindings stay independent of cross-element
// vue-tsc narrowing of `panel.chartId`.
function panelChartData(panel: DashboardPanel): ChartData | undefined {
  return panel.chartId ? chartDataMap.value[panel.chartId] : undefined
}
function panelChartConfig(panel: DashboardPanel): ChartConfig | undefined {
  return panel.chartId ? chartConfigMap.value[panel.chartId] : undefined
}

// B4: header title. Chart panels use the chart name (legacy behavior); non-chart panels use
// their own `title`, falling back to a localized "Untitled" — NEVER a raw chartId, which a
// chartId-less widget does not have anyway.
function panelTitle(panel: DashboardPanel): string {
  if (panelType(panel) === 'chart') return chartNameById(panel.chartId ?? '')
  return panel.title?.trim() || viewRenderLabel('dashboard.untitledWidget', isZh.value)
}

// B4: synthesize the metric card's display config (title + optional prefix/suffix) so the
// reused MetaChartRenderer 'number' branch shows the KPI with the same chrome as a number chart.
function metricDisplayConfig(panel: DashboardPanel): ChartDisplayConfig {
  return {
    prefix: panel.metricConfig?.prefix,
    suffix: panel.metricConfig?.suffix,
  }
}

// B4: presentational filter — update LOCAL state only. No data refetch, no cross-panel effect.
function onFilterControlChange(panelId: string, value: string) {
  filterSelections.value = { ...filterSelections.value, [panelId]: value }
}

// B4: metric needs a value field only for sum/avg/min/max (count aggregates row presence).
const widgetRequiresValueField = computed(() =>
  AGGREGATIONS_REQUIRING_VALUE.has(widgetDraft.value.aggregation),
)
const addWidgetDisabled = computed(() => {
  if (!activeDashboard.value) return true
  if (widgetDraft.value.kind === 'metric') {
    return widgetRequiresValueField.value && !widgetDraft.value.valueFieldId
  }
  // text + filter have no required inputs (an empty text widget is allowed and editable later).
  return false
})

// B4: build the synthesized number-chart input a metric card computes through preview-data.
// Same field-read-enforced path a 'number' chart preview uses — NO field-perm bypass.
function buildMetricChartInput(panel: DashboardPanel): ChartCreateInput {
  const cfg = panel.metricConfig
  const aggregation = cfg?.aggregation ?? 'count'
  const needsField = AGGREGATIONS_REQUIRING_VALUE.has(aggregation)
  const dataSource: ChartDataSource = {
    sheetId: props.sheetId,
    aggregation: {
      function: aggregation,
      ...(needsField && cfg?.valueFieldId ? { fieldId: cfg.valueFieldId } : {}),
    },
  }
  return {
    name: panel.title?.trim() || viewRenderLabel('dashboard.untitledWidget', isZh.value),
    chartType: 'number',
    dataSource,
  }
}

function resetChartDraft() {
  chartDraft.value = {
    name: '',
    chartType: 'bar',
    groupByFieldId: groupableFields.value[0]?.id ?? '',
    aggregation: 'count',
    valueFieldId: '',
    variant: '',
    seriesByFieldId: '',
    barMode: 'stacked',
    xFieldId: '',
    yFieldId: '',
    colorFieldId: '',
    sizeFieldId: '',
  }
  createChartError.value = ''
  resetChartPreview()
}

function openCreateChart() {
  editingChartId.value = null
  resetChartDraft()
  showCreateChart.value = true
}

// v2-b1: open the (reused) chart form pre-filled to EDIT an existing chart's config.
function openEditChart(chartId: string) {
  const cfg = chartConfigMap.value[chartId]
  if (!cfg) return
  editingChartId.value = chartId
  chartDraft.value = {
    name: cfg.name,
    chartType: cfg.chartType,
    groupByFieldId: cfg.dataSource.groupByFieldId ?? '',
    aggregation: cfg.dataSource.aggregation.function,
    valueFieldId: cfg.dataSource.aggregation.fieldId ?? '',
    variant: cfg.displayConfig?.variant ?? '',
    seriesByFieldId: cfg.dataSource.seriesByFieldId ?? '',
    barMode: cfg.displayConfig?.barMode ?? 'stacked',
    xFieldId: cfg.dataSource.xFieldId ?? '',
    yFieldId: cfg.dataSource.yFieldId ?? '',
    colorFieldId: cfg.dataSource.colorFieldId ?? '',
    sizeFieldId: cfg.dataSource.sizeFieldId ?? '',
  }
  createChartError.value = ''
  resetChartPreview()
  showAddPanel.value = false
  showCreateChart.value = true
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
  // B4: iterate ALL panel kinds. Chart panels load via getChartData (chartId-keyed);
  // metric panels compute via previewChartData (panel.id-keyed); text/filter need no data.
  const promises = panels.map(async (panel) => {
    const kind = panelType(panel)
    if (kind === 'chart') {
      if (!panel.chartId || chartDataMap.value[panel.chartId]) return
      try {
        const data = await props.client!.getChartData(props.sheetId, panel.chartId)
        chartDataMap.value[panel.chartId] = data
      } catch {
        // skip
      }
      return
    }
    if (kind === 'metric') {
      await loadMetricData(panel)
    }
  })
  await Promise.all(promises)
}

// B4: compute a metric card's single value through the NON-persisting, field-read-enforced
// preview-data endpoint (isChartDataRestricted is applied server-side). Never bypasses
// field permissions; a restricted result renders MetaChartRenderer's restricted notice.
//
// loadPanelData can fire twice in quick succession (the sheetId immediate watch + the
// activeDashboard.id watch) before the first preview resolves, so an in-flight set
// dedupes concurrent loads — the resolved-data guard only catches already-loaded panels.
const metricInFlight = new Set<string>()
async function loadMetricData(panel: DashboardPanel) {
  if (!props.client || metricDataMap.value[panel.id] || metricInFlight.has(panel.id)) return
  metricInFlight.add(panel.id)
  try {
    const data = await props.client.previewChartData(props.sheetId, buildMetricChartInput(panel))
    metricDataMap.value[panel.id] = data
  } catch {
    // skip — panel keeps its loading state
  } finally {
    metricInFlight.delete(panel.id)
  }
}

async function onCreateDashboard() {
  if (!props.client) return
  try {
    const db = await props.client.createDashboard(props.sheetId, { name: dashboardDefaultName(dashboards.value.length + 1, isZh.value) })
    dashboards.value.push(db)
    activeDashboardId.value = db.id
  } catch {
    // skip
  }
}

async function onAddPanel(chartId: string) {
  if (!props.client || !activeDashboard.value) return
  showAddPanel.value = false
  await addPanelForChart(chartId)
}

async function addPanelForChart(chartId: string) {
  if (!props.client || !activeDashboard.value) return
  const newPanel: DashboardPanel = {
    id: `panel_${Date.now()}`,
    type: 'chart',
    chartId,
    size: 'medium',
    order: activeDashboard.value.panels.length,
  }
  const appended = await appendPanel(newPanel)
  if (!appended) return
  // Load chart data
  if (!chartDataMap.value[chartId]) {
    try {
      chartDataMap.value[chartId] = await props.client.getChartData(props.sheetId, chartId)
    } catch {
      // skip
    }
  }
}

// B4: shared panel-append (PATCH the full panels list, sync local state). Used by
// chart panels and the metric/text/filter widget flow. Returns true on success.
async function appendPanel(newPanel: DashboardPanel): Promise<boolean> {
  if (!props.client || !activeDashboard.value) return false
  const db = activeDashboard.value
  const updated = [...db.panels, newPanel]
  try {
    const result = await props.client.updateDashboard(props.sheetId, db.id, { panels: updated })
    const idx = dashboards.value.findIndex((d) => d.id === db.id)
    if (idx >= 0) dashboards.value[idx] = result
    return true
  } catch {
    return false
  }
}

function openAddWidget() {
  if (!activeDashboard.value) return
  widgetDraft.value = {
    kind: 'metric',
    title: '',
    aggregation: 'count',
    valueFieldId: '',
    prefix: '',
    suffix: '',
    textContent: '',
    filterFieldId: '',
  }
  showAddWidget.value = true
}

// B4: build the tagged-union panel for the chosen widget kind and append it. Only the
// active kind's config sub-object is set, so a metric/text/filter panel round-trips
// cleanly through the opaque-JSONB wire.
async function onSubmitWidget() {
  if (!props.client || !activeDashboard.value || addWidgetDisabled.value) return
  addingWidget.value = true
  try {
    const kind = widgetDraft.value.kind
    const title = widgetDraft.value.title.trim()
    const base: Pick<DashboardPanel, 'id' | 'size' | 'order'> = {
      id: `panel_${Date.now()}`,
      size: 'medium',
      order: activeDashboard.value.panels.length,
    }
    let newPanel: DashboardPanel
    if (kind === 'metric') {
      const needsField = AGGREGATIONS_REQUIRING_VALUE.has(widgetDraft.value.aggregation)
      newPanel = {
        ...base,
        type: 'metric',
        ...(title ? { title } : {}),
        metricConfig: {
          aggregation: widgetDraft.value.aggregation,
          ...(needsField && widgetDraft.value.valueFieldId ? { valueFieldId: widgetDraft.value.valueFieldId } : {}),
          ...(widgetDraft.value.prefix.trim() ? { prefix: widgetDraft.value.prefix.trim() } : {}),
          ...(widgetDraft.value.suffix.trim() ? { suffix: widgetDraft.value.suffix.trim() } : {}),
        },
      }
    } else if (kind === 'text') {
      newPanel = {
        ...base,
        type: 'text',
        ...(title ? { title } : {}),
        textConfig: { content: widgetDraft.value.textContent },
      }
    } else {
      newPanel = {
        ...base,
        type: 'filter',
        ...(title ? { title } : {}),
        filterConfig: { ...(widgetDraft.value.filterFieldId ? { fieldId: widgetDraft.value.filterFieldId } : {}) },
      }
    }
    const appended = await appendPanel(newPanel)
    if (appended) {
      showAddWidget.value = false
      if (kind === 'metric') await loadMetricData(newPanel)
    }
  } finally {
    addingWidget.value = false
  }
}

// Build a chart create/update payload from the form. For EDIT, pass the existing config as `base`:
// the server shallow-replaces dataSource/displayConfig with what we send ({ ...existing, ...input }),
// so we OVERLAY onto the existing objects to PRESERVE fields this minimal form does not model —
// displayConfig options (showLegend / colorScheme / showValues) and dataSource.filter / date-grouping.
// The form owns only name / chartType / groupByFieldId / aggregation. (v2-b1 boundary: a date-grouped
// chart keeps its date-grouping — full grouping-mode editing is a later slice.)
function buildChartInput(base?: ChartConfig): ChartCreateInput {
  const name = chartDraft.value.name.trim()
  // r12 scatter: a per-record x/y projection — emit x/y (+ optional color/size) and DROP the grouped
  // dataSource fields (groupBy/series/date). `aggregation` stays present (the contract requires it) but
  // the backend scatter branch ignores it. Built explicitly off `base` so groupBy/series carried by an
  // edited config are cleared when switching INTO scatter.
  if (isScatter.value) {
    const scatterSource: ChartDataSource = {
      sheetId: props.sheetId,
      aggregation: { function: chartDraft.value.aggregation },
      xFieldId: chartDraft.value.xFieldId,
      yFieldId: chartDraft.value.yFieldId,
      ...(chartDraft.value.colorFieldId ? { colorFieldId: chartDraft.value.colorFieldId } : {}),
      ...(chartDraft.value.sizeFieldId ? { sizeFieldId: chartDraft.value.sizeFieldId } : {}),
    }
    return {
      name,
      chartType: 'scatter',
      dataSource: scatterSource,
      displayConfig: {
        ...(base?.displayConfig ?? {}),
        title: name,
      },
    }
  }
  const dataSource: ChartDataSource = {
    ...(base?.dataSource ?? {}),
    sheetId: props.sheetId,
    aggregation: {
      function: chartDraft.value.aggregation,
      ...(requiresValueField.value ? { fieldId: chartDraft.value.valueFieldId } : {}),
    },
  }
  // r12: a base config switching OUT of scatter must not leak its x/y/color/size fields.
  delete dataSource.xFieldId
  delete dataSource.yFieldId
  delete dataSource.colorFieldId
  delete dataSource.sizeFieldId
  if (!editingDateGrouped.value) {
    dataSource.groupByFieldId = chartDraft.value.groupByFieldId
  }
  // v2-d / v2-d-b2: bar OR line series split, only with a primary groupBy. Set explicitly (or delete
  // the base value) so switching chartType/groupBy/date clears a now-inapplicable series.
  const hasSeriesSplit = seriesByAllowed.value && hasPrimaryAxis.value && !!chartDraft.value.seriesByFieldId
  if (hasSeriesSplit) {
    dataSource.seriesByFieldId = chartDraft.value.seriesByFieldId
  } else {
    delete dataSource.seriesByFieldId
  }
  // v2-d-b1: barMode is BAR-only (lines never stack/group); stacked falls back to grouped for a
  // non-additive aggregation (the server enforces the same). Explicit so a switch clears a base value.
  const barMode: 'stacked' | 'grouped' | undefined = (chartDraft.value.chartType === 'bar' && hasSeriesSplit)
    ? (stackedAllowed.value ? chartDraft.value.barMode : 'grouped')
    : undefined
  // v2-c: a render variant is valid only for its matching chartType (donut→pie, area→line).
  // Resolve it explicitly so switching chartType clears a now-inapplicable variant carried by base.
  const variant: 'donut' | 'area' | undefined =
    chartDraft.value.chartType === 'pie' && chartDraft.value.variant === 'donut' ? 'donut'
      : chartDraft.value.chartType === 'line' && chartDraft.value.variant === 'area' ? 'area'
        : undefined
  return {
    name,
    chartType: chartDraft.value.chartType,
    dataSource,
    displayConfig: {
      ...(base?.displayConfig ?? {}),
      title: name,
      variant,
      barMode,
    },
  }
}

let previewTimer: ReturnType<typeof setTimeout> | null = null
let previewSeq = 0

function clearPreviewTimer() {
  if (previewTimer) {
    clearTimeout(previewTimer)
    previewTimer = null
  }
}

function resetChartPreview() {
  clearPreviewTimer()
  previewSeq += 1
  previewChartData.value = null
  previewLoading.value = false
  previewError.value = ''
}

function scheduleChartPreview() {
  clearPreviewTimer()
  if (!showCreateChart.value || !props.client || createChartDisabled.value) {
    resetChartPreview()
    return
  }
  previewError.value = ''
  previewTimer = setTimeout(() => {
    void runChartPreview()
  }, 300)
}

async function runChartPreview() {
  if (!props.client || createChartDisabled.value) return
  const seq = ++previewSeq
  previewLoading.value = true
  previewError.value = ''
  try {
    const data = await props.client.previewChartData(props.sheetId, buildChartInput(editingChart.value ?? undefined))
    if (seq !== previewSeq) return
    previewChartData.value = data
  } catch {
    if (seq !== previewSeq) return
    previewChartData.value = null
    previewError.value = 'preview_failed'
  } finally {
    if (seq === previewSeq) previewLoading.value = false
  }
}

// v2-a create + v2-b1 edit share one form. editingChartId === null → create; else → update.
async function onSubmitChart() {
  if (!props.client || createChartDisabled.value) return
  const isEdit = editingChartId.value !== null
  creatingChart.value = true
  createChartError.value = ''
  try {
    if (isEdit) {
      const chartId = editingChartId.value as string
      // overlay onto the existing config so unmodeled fields survive the server's shallow replace
      const input = buildChartInput(chartConfigMap.value[chartId])
      const updated = await props.client.updateChart(props.sheetId, chartId, input)
      charts.value = charts.value.map((c) => (c.id === chartId ? updated : c))
      chartConfigMap.value[chartId] = updated
      // v2-b1: re-pull chart data so any panel showing it re-renders with the new config
      // (loadPanelData skips already-loaded charts, so refetch explicitly here).
      try {
        chartDataMap.value[chartId] = await props.client.getChartData(props.sheetId, chartId)
      } catch {
        delete chartDataMap.value[chartId]
      }
      showCreateChart.value = false
      editingChartId.value = null
    } else {
      const chart = await props.client.createChart(props.sheetId, buildChartInput())
      charts.value = [...charts.value, chart]
      chartConfigMap.value[chart.id] = chart
      showCreateChart.value = false
      await addPanelForChart(chart.id)
    }
  } catch {
    createChartError.value = viewRenderLabel(isEdit ? 'dashboard.editChartError' : 'dashboard.createChartError', isZh.value)
  } finally {
    creatingChart.value = false
  }
}

// v2-b1: delete a chart (confirm), then prune any active-dashboard panels that referenced it
// so the dashboard does not leave a dangling "loading" panel.
async function onDeleteChart(chartId: string) {
  if (!props.client) return
  const message = viewRenderLabel('dashboard.deleteChartConfirm', isZh.value)
  if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(message)) return
  try {
    await props.client.deleteChart(props.sheetId, chartId)
    charts.value = charts.value.filter((c) => c.id !== chartId)
    delete chartConfigMap.value[chartId]
    delete chartDataMap.value[chartId]
    const db = activeDashboard.value
    if (db && db.panels.some((p) => p.chartId === chartId)) {
      const updated = db.panels.filter((p) => p.chartId !== chartId)
      try {
        const result = await props.client.updateDashboard(props.sheetId, db.id, { panels: updated })
        const idx = dashboards.value.findIndex((d) => d.id === db.id)
        if (idx >= 0) dashboards.value[idx] = result
      } catch {
        // skip
      }
    }
    if (editingChartId.value === chartId) {
      showCreateChart.value = false
      editingChartId.value = null
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

watch(groupableFields, () => {
  if (editingDateGrouped.value) return
  if (!chartDraft.value.groupByFieldId && groupableFields.value[0]) {
    chartDraft.value.groupByFieldId = groupableFields.value[0].id
  }
})

watch(
  () => [
    showCreateChart.value,
    chartDraft.value.name,
    chartDraft.value.chartType,
    chartDraft.value.groupByFieldId,
    chartDraft.value.aggregation,
    chartDraft.value.valueFieldId,
    // every field buildChartInput reads must re-trigger the preview, else the saved config diverges
    // from what's shown: variant (v2-c), seriesByFieldId (v2-d), barMode (v2-d-b1).
    chartDraft.value.variant,
    chartDraft.value.seriesByFieldId,
    chartDraft.value.barMode,
    editingDateGrouped.value,
  ],
  scheduleChartPreview,
)

onBeforeUnmount(resetChartPreview)
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

.meta-dashboard__btn:disabled { cursor: not-allowed; opacity: 0.55; }
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

/* B4: non-chart widget bodies left-align their content (KPI / note / control). */
.meta-dashboard__text-widget { align-self: stretch; width: 100%; }
.meta-dashboard__filter-widget {
  align-self: stretch;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.meta-dashboard__textarea {
  resize: vertical;
  min-height: 80px;
  font-family: inherit;
}

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

.meta-dashboard__modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px 14px;
  border-top: 1px solid #e2e8f0;
}

.meta-dashboard__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: #334155;
}

.meta-dashboard__input {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 13px;
  color: #0f172a;
}

.meta-dashboard__hint { color: #94a3b8; font-weight: 400; }
.meta-dashboard__error { color: #b91c1c; font-size: 12px; }

.meta-dashboard__preview {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #f8fafc;
}

.meta-dashboard__preview-title { font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 8px; }
.meta-dashboard__preview-empty { font-size: 12px; color: #94a3b8; }
.meta-dashboard__preview-chart { background: #fff; border-radius: 8px; padding: 10px; }

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
