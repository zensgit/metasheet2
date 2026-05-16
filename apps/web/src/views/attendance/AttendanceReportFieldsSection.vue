<template>
  <div class="attendance-report-fields">
    <div class="attendance__admin-section-header">
      <div>
        <h4>{{ tr('Report fields', '统计字段') }}</h4>
        <div class="attendance__section-meta">
          {{ tr('Fields loaded', '已加载字段') }}: {{ reportFields.length }}
          <span v-if="enabledCount"> · {{ tr('Enabled', '已启用') }}: {{ enabledCount }}</span>
          <span v-if="visibleCount"> · {{ tr('Report visible', '报表展示') }}: {{ visibleCount }}</span>
          <span v-if="configuredCount"> · {{ tr('Configured', '已配置') }}: {{ configuredCount }}</span>
          <span v-if="formulaCount"> · {{ tr('Formula', '公式') }}: {{ formulaCount }}</span>
          <span v-if="formulaErrorCount"> · {{ tr('Formula errors', '公式错误') }}: {{ formulaErrorCount }}</span>
          <span v-if="disabledCount"> · {{ tr('Disabled', '已停用') }}: {{ disabledCount }}</span>
          <span v-if="hiddenCount"> · {{ tr('Hidden', '已隐藏') }}: {{ hiddenCount }}</span>
          <span v-if="multitableProjectId"> · Project: <code>{{ multitableProjectId }}</code></span>
        </div>
      </div>
      <div class="attendance__admin-actions">
        <a
          v-if="multitableHref"
          class="attendance__btn"
          :href="multitableHref"
          target="_blank"
          rel="noreferrer"
        >
          {{ tr('Open multitable', '打开多维表') }}
        </a>
        <button class="attendance__btn" type="button" :disabled="syncing" @click="syncReportFields">
          {{ syncing ? tr('Syncing...', '同步中...') : tr('Sync catalog', '同步字段目录') }}
        </button>
        <button class="attendance__btn" type="button" :disabled="loading" @click="loadReportFields">
          {{ loading ? tr('Loading...', '加载中...') : tr('Reload fields', '重载字段') }}
        </button>
      </div>
    </div>

    <div
      v-if="syncStatusMessage"
      class="attendance__status"
      :class="{ 'attendance__status--error': syncStatusKind === 'error' }"
      role="status"
    >
      {{ syncStatusMessage }}
    </div>
    <div
      v-if="loadError"
      class="attendance__status attendance__status--error"
      role="status"
    >
      {{ loadError }}
    </div>
    <div
      v-else-if="multitableDegraded"
      class="attendance__status"
      role="status"
    >
      {{ tr('Using built-in report field definitions because multitable configuration is not available.', '多维表配置暂不可用，当前使用内置统计字段定义。') }}
    </div>
    <div
      v-if="droppedReservedCodes.length > 0"
      class="attendance__status attendance__status--warn"
      role="alert"
      data-report-field-dropped-reserved
    >
      {{ tr(
        `These catalog fields were dropped because their code collides with reserved formula raw-alias names: ${droppedReservedCodes.join(', ')}. Rename them in the multitable catalog to a non-reserved code so they appear again.`,
        `以下字段因 code 与公式 raw alias 保留字冲突已被丢弃：${droppedReservedCodes.join('、')}。请在多维表字段目录里把它们改成非保留 code 后才会重新出现。`
      ) }}
    </div>

    <div v-if="reportFields.length === 0 && !loading" class="attendance__empty">
      {{ tr('No report fields loaded yet.', '尚未加载统计字段。') }}
    </div>

    <div
      v-if="reportFields.length > 0"
      class="attendance-report-fields__filters"
      data-report-field-filters
    >
      <label class="attendance-report-fields__filter" for="attendance-report-field-search">
        <span>{{ tr('Search fields', '搜索字段') }}</span>
        <input
          id="attendance-report-field-search"
          v-model="fieldSearchTerm"
          type="search"
          :placeholder="tr('Name, code, description', '名称、编码、说明')"
        >
      </label>
      <label class="attendance-report-fields__filter" for="attendance-report-field-status-filter">
        <span>{{ tr('Field state', '字段状态') }}</span>
        <select
          id="attendance-report-field-status-filter"
          v-model="fieldStatusFilter"
        >
          <option value="all">{{ tr('All fields', '全部字段') }}</option>
          <option value="configured">{{ tr('Configured', '已配置') }}</option>
          <option value="formula">{{ tr('Formula fields', '公式字段') }}</option>
          <option value="formula_error">{{ tr('Formula errors', '公式错误') }}</option>
          <option value="disabled">{{ tr('Disabled', '已停用') }}</option>
          <option value="hidden">{{ tr('Hidden', '已隐藏') }}</option>
        </select>
      </label>
      <label class="attendance-report-fields__filter" for="attendance-report-field-category-filter">
        <span>{{ tr('Category', '分类') }}</span>
        <select
          id="attendance-report-field-category-filter"
          v-model="fieldCategoryFilter"
        >
          <option value="all">{{ tr('All categories', '全部分类') }}</option>
          <option
            v-for="category in categoryFilterOptions"
            :key="category.id"
            :value="category.id"
          >
            {{ category.label }}
          </option>
        </select>
      </label>
      <div class="attendance-report-fields__filter-summary">
        {{ tr('Filtered fields', '筛选字段') }}: {{ filteredReportFields.length }} / {{ reportFields.length }}
      </div>
      <button
        class="attendance__btn"
        type="button"
        :disabled="!hasActiveFieldFilters"
        data-report-field-reset-filters
        @click="resetReportFieldFilters"
      >
        {{ tr('Reset filters', '重置筛选') }}
      </button>
      <div
        v-if="activeFieldFilterLabels.length > 0"
        class="attendance-report-fields__active-filters"
        data-report-field-active-filters
      >
        {{ tr('Active filters', '当前筛选') }}: {{ activeFieldFilterLabels.join(' · ') }}
      </div>
    </div>

    <div
      v-if="multitableDetailRows.length > 0"
      class="attendance-report-fields__basis"
      data-report-field-multitable-status
    >
      <div class="attendance-report-fields__basis-header">
        <div class="attendance-report-fields__basis-title">
          {{ tr('Multitable backing', '多维表底座') }}
        </div>
        <span
          class="attendance-report-fields__status-pill"
          :class="{
            'attendance-report-fields__status-pill--ok': multitableConnected,
            'attendance-report-fields__status-pill--warn': multitableDegraded,
            'attendance-report-fields__status-pill--off': !multitableConnected && !multitableDegraded,
          }"
        >
          {{ multitableStatusLabel }}
        </span>
      </div>
      <dl class="attendance-report-fields__basis-details">
        <div
          v-for="row in multitableDetailRows"
          :key="row.key"
          class="attendance-report-fields__basis-detail"
          :data-report-field-multitable-detail="row.key"
        >
          <dt>{{ row.label }}</dt>
          <dd>
            <code v-if="row.monospace">{{ row.value }}</code>
            <span v-else>{{ row.value }}</span>
          </dd>
        </div>
      </dl>
    </div>

    <div
      class="attendance-report-fields__basis attendance-report-fields__record-sync"
      data-report-record-sync-panel
    >
      <div class="attendance-report-fields__basis-header">
        <div>
          <div class="attendance-report-fields__basis-title">
            {{ tr('Report records sync', '报表记录同步') }}
          </div>
        </div>
        <a
          v-if="reportRecordsMultitableHref"
          class="attendance__btn"
          :href="reportRecordsMultitableHref"
          target="_blank"
          rel="noreferrer"
          data-report-record-open-multitable
        >
          {{ tr('Open report records', '打开报表多维表') }}
        </a>
      </div>
      <div class="attendance-report-fields__record-sync-form">
        <label class="attendance-report-fields__filter" for="attendance-report-record-sync-from">
          <span>{{ tr('From date', '开始日期') }}</span>
          <input
            id="attendance-report-record-sync-from"
            v-model="recordSyncFrom"
            type="date"
            data-report-record-sync-from
          >
        </label>
        <label class="attendance-report-fields__filter" for="attendance-report-record-sync-to">
          <span>{{ tr('To date', '结束日期') }}</span>
          <input
            id="attendance-report-record-sync-to"
            v-model="recordSyncTo"
            type="date"
            data-report-record-sync-to
          >
        </label>
        <label class="attendance-report-fields__filter" for="attendance-report-record-sync-user">
          <span>{{ tr('User ID', '员工 ID') }}</span>
          <input
            id="attendance-report-record-sync-user"
            v-model="recordSyncUserId"
            type="text"
            :placeholder="tr('Required in v1', 'v1 必填')"
            data-report-record-sync-user
          >
        </label>
        <button
          class="attendance__btn"
          type="button"
          :disabled="recordSyncing || !canSyncReportRecords"
          data-report-record-sync-button
          @click="syncReportRecords"
        >
          {{ recordSyncing ? tr('Syncing...', '同步中...') : tr('Sync report records', '同步报表记录') }}
        </button>
      </div>
      <div
        v-if="recordSyncStatusMessage"
        class="attendance__status"
        :class="{
          'attendance__status--error': recordSyncStatusKind === 'error',
          'attendance__status--warn': recordSyncStatusKind === 'warn',
        }"
        role="status"
        data-report-record-sync-status
      >
        {{ recordSyncStatusMessage }}
      </div>
      <dl
        v-if="reportRecordSyncDetailRows.length > 0"
        class="attendance-report-fields__basis-details"
        data-report-record-sync-details
      >
        <div
          v-for="row in reportRecordSyncDetailRows"
          :key="row.key"
          class="attendance-report-fields__basis-detail"
          :data-report-record-sync-detail="row.key"
        >
          <dt>{{ row.label }}</dt>
          <dd>
            <code v-if="row.monospace">{{ row.value }}</code>
            <span v-else>{{ row.value }}</span>
          </dd>
        </div>
      </dl>
    </div>

    <div v-if="reportFields.length > 0 && filteredReportFields.length === 0" class="attendance__empty">
      {{ tr('No report fields match the current filters.', '当前筛选条件下没有匹配的统计字段。') }}
    </div>

    <div v-if="filteredReportFields.length > 0" class="attendance-report-fields__grid">
      <section
        v-for="category in visibleCategories"
        :key="category.id"
        class="attendance-report-fields__category"
        :data-report-field-category="category.id"
      >
        <div class="attendance-report-fields__category-header">
          <div>
            <h5>{{ category.label }}</h5>
            <div class="attendance__section-meta">
              {{ tr('Fields', '字段') }}: {{ categoryStats(category.id).total }}
              <span> · {{ tr('Enabled', '启用') }}: {{ categoryStats(category.id).enabled }}</span>
              <span> · {{ tr('Visible', '展示') }}: {{ categoryStats(category.id).visible }}</span>
            </div>
          </div>
        </div>
        <div class="attendance__table-wrapper attendance-report-fields__table-wrapper">
          <table class="attendance__table attendance-report-fields__table">
            <thead>
              <tr>
                <th>{{ tr('Field', '字段') }}</th>
                <th>{{ tr('Code', '编码') }}</th>
                <th>{{ tr('Unit', '单位') }}</th>
                <th>{{ tr('Enabled', '启用') }}</th>
                <th>{{ tr('Report', '报表') }}</th>
                <th>{{ tr('Source', '来源') }}</th>
                <th>{{ tr('Configuration', '配置') }}</th>
                <th>{{ tr('Formula', '公式') }}</th>
                <th>{{ tr('Mapping', '映射') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="field in fieldsByCategory(category.id)" :key="field.code">
                <td>
                  <strong>{{ field.name }}</strong>
                  <div class="attendance__field-hint">{{ field.description || field.dingtalkFieldName }}</div>
                </td>
                <td><code>{{ field.code }}</code></td>
                <td>{{ formatUnit(field.unit) }}</td>
                <td>
                  <span class="attendance-report-fields__pill" :class="{ 'attendance-report-fields__pill--off': !field.enabled }">
                    {{ field.enabled ? tr('On', '开') : tr('Off', '关') }}
                  </span>
                </td>
                <td>
                  <span class="attendance-report-fields__pill" :class="{ 'attendance-report-fields__pill--off': !field.reportVisible }">
                    {{ field.reportVisible ? tr('Shown', '展示') : tr('Hidden', '隐藏') }}
                  </span>
                </td>
                <td>{{ formatSource(field.source, field.systemDefined) }}</td>
                <td>
                  <span
                    class="attendance-report-fields__pill"
                    :class="configurationPillClass(field)"
                  >
                    {{ formatConfigurationSource(field) }}
                  </span>
                </td>
                <td class="attendance-report-fields__formula">
                  <template v-if="field.formulaEnabled">
                    <span
                      class="attendance-report-fields__pill attendance-report-fields__pill--formula"
                      :class="{ 'attendance-report-fields__pill--error': field.formulaValid === false }"
                    >
                      {{ field.formulaValid === false ? tr('Invalid', '异常') : tr('Formula', '公式') }}
                    </span>
                    <code v-if="field.formulaExpression">{{ field.formulaExpression }}</code>
                    <div class="attendance__field-hint">
                      {{ formatFormulaMeta(field) }}
                    </div>
                    <div
                      v-if="field.formulaError"
                      class="attendance-report-fields__formula-error"
                      role="status"
                    >
                      {{ field.formulaError }}
                    </div>
                  </template>
                  <span v-else class="attendance__field-hint">{{ tr('No formula', '无公式') }}</span>
                </td>
                <td class="attendance-report-fields__mapping">
                  <div
                    v-for="row in fieldMappingRows(field)"
                    :key="row.key"
                    class="attendance-report-fields__mapping-row"
                  >
                    <span>{{ row.label }}</span>
                    <code v-if="row.monospace">{{ row.value }}</code>
                    <strong v-else>{{ row.value }}</strong>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiFetch } from '../../utils/api'
import { readErrorMessage } from '../../utils/error'

type TranslateFn = (en: string, zh: string) => string
type ReportFieldStatusFilter = 'all' | 'configured' | 'formula' | 'formula_error' | 'disabled' | 'hidden'

interface AttendanceReportFieldCategory {
  id: string
  label: string
  sortOrder: number
}

interface AttendanceReportFieldItem {
  code: string
  name: string
  category: string
  categoryLabel: string
  source: string
  unit: string
  enabled: boolean
  reportVisible: boolean
  sortOrder: number
  dingtalkFieldName?: string
  description?: string
  internalKey?: string
  configured?: boolean
  systemDefined?: boolean
  formulaEnabled?: boolean
  formulaExpression?: string
  formulaScope?: string
  formulaOutputType?: string
  formulaValid?: boolean
  formulaError?: string | null
  formulaReferences?: string[]
}

interface AttendanceReportFieldsPayload {
  categories?: AttendanceReportFieldCategory[]
  items?: AttendanceReportFieldItem[]
  droppedReservedCodes?: string[]
  reportFieldConfig?: {
    fieldsFingerprint?: {
      algorithm?: string
      value?: string
      fieldCount?: number
      codes?: string[]
    }
  }
  multitable?: {
    available?: boolean
    degraded?: boolean
    reason?: string | null
    error?: string | null
    projectId?: string
    objectId?: string | null
    baseId?: string | null
    sheetId?: string | null
    viewId?: string | null
    seeded?: number
    existing?: number
    recordCount?: number
  }
}

interface MultitableDetailRow {
  key: string
  label: string
  value: string
  monospace?: boolean
}

interface AttendanceReportRecordsSyncResult {
  degraded?: boolean
  reason?: string | null
  synced?: number
  patched?: number
  created?: number
  skipped?: number
  failed?: number
  duplicateRowKeys?: number
  fieldFingerprint?: string
  syncedAt?: string
  multitable?: {
    available?: boolean
    degraded?: boolean
    projectId?: string
    objectId?: string | null
    baseId?: string | null
    sheetId?: string | null
    viewId?: string | null
  }
}

interface FieldMappingRow {
  key: string
  label: string
  value: string
  monospace?: boolean
}

const props = defineProps<{
  tr: TranslateFn
  orgId?: string
}>()

const tr = props.tr
const loading = ref(false)
const syncing = ref(false)
const loadError = ref('')
const syncStatusMessage = ref('')
const syncStatusKind = ref<'info' | 'error'>('info')
const recordSyncing = ref(false)
const recordSyncStatusMessage = ref('')
const recordSyncStatusKind = ref<'info' | 'warn' | 'error'>('info')
const recordSyncFrom = ref(dateInputValue(-30))
const recordSyncTo = ref(dateInputValue(0))
const recordSyncUserId = ref('')
const reportRecordsSyncResult = ref<AttendanceReportRecordsSyncResult | null>(null)
const fieldSearchTerm = ref('')
const fieldStatusFilter = ref<ReportFieldStatusFilter>('all')
const fieldCategoryFilter = ref('all')
const reportFieldsPayload = ref<AttendanceReportFieldsPayload>({
  categories: [],
  items: [],
  multitable: { available: false },
})

const reportFields = computed(() => reportFieldsPayload.value.items ?? [])
const droppedReservedCodes = computed(() => reportFieldsPayload.value.droppedReservedCodes ?? [])
const enabledCount = computed(() => reportFields.value.filter(field => field.enabled).length)
const visibleCount = computed(() => reportFields.value.filter(field => field.reportVisible).length)
const configuredCount = computed(() => reportFields.value.filter(field => field.configured).length)
const formulaCount = computed(() => reportFields.value.filter(field => field.formulaEnabled).length)
const formulaErrorCount = computed(() => reportFields.value.filter(field => field.formulaEnabled && field.formulaValid === false).length)
const disabledCount = computed(() => reportFields.value.filter(field => field.enabled === false).length)
const hiddenCount = computed(() => reportFields.value.filter(field => field.reportVisible === false).length)
const hasActiveFieldFilters = computed(() => (
  fieldSearchTerm.value.trim() !== ''
  || fieldStatusFilter.value !== 'all'
  || fieldCategoryFilter.value !== 'all'
))
const filteredReportFields = computed(() => {
  const search = fieldSearchTerm.value.trim().toLowerCase()
  return reportFields.value.filter((field) => {
    if (!matchesFieldStatusFilter(field)) return false
    if (fieldCategoryFilter.value !== 'all' && field.category !== fieldCategoryFilter.value) return false
    if (!search) return true
    const haystack = [
      field.code,
      field.name,
      field.category,
      field.categoryLabel,
      field.source,
      field.unit,
      field.dingtalkFieldName,
      field.description,
      field.internalKey,
      field.formulaExpression,
      field.formulaScope,
      field.formulaOutputType,
      field.formulaError,
      ...(field.formulaReferences ?? []),
    ].map(value => String(value ?? '').toLowerCase())
    return haystack.some(value => value.includes(search))
  })
})
const categoryFilterOptions = computed<AttendanceReportFieldCategory[]>(() => {
  const categories = reportFieldsPayload.value.categories ?? []
  const categoryIdsWithFields = new Set(reportFields.value.map(field => field.category))
  if (categories.length > 0) {
    return categories
      .filter(category => categoryIdsWithFields.has(category.id))
      .sort((left, right) => left.sortOrder - right.sortOrder)
  }
  const fallback = new Map<string, AttendanceReportFieldCategory>()
  for (const field of reportFields.value) {
    if (!fallback.has(field.category)) {
      fallback.set(field.category, {
        id: field.category,
        label: field.categoryLabel || field.category,
        sortOrder: field.sortOrder,
      })
    }
  }
  return Array.from(fallback.values()).sort((left, right) => left.sortOrder - right.sortOrder)
})
const activeFieldFilterLabels = computed(() => {
  const labels: string[] = []
  const search = fieldSearchTerm.value.trim()
  if (search) labels.push(`${tr('Search', '搜索')}: ${search}`)
  if (fieldStatusFilter.value !== 'all') {
    labels.push(`${tr('State', '状态')}: ${formatStatusFilterLabel(fieldStatusFilter.value)}`)
  }
  if (fieldCategoryFilter.value !== 'all') {
    const category = categoryFilterOptions.value.find(item => item.id === fieldCategoryFilter.value)
    labels.push(`${tr('Category', '分类')}: ${category?.label || fieldCategoryFilter.value}`)
  }
  return labels
})
const multitableState = computed(() => reportFieldsPayload.value.multitable ?? { available: false })
const multitableProjectId = computed(() => multitableState.value.projectId || '')
const multitableConnected = computed(() => Boolean(multitableState.value.available && !multitableState.value.degraded))
const multitableDegraded = computed(() => Boolean(multitableState.value.degraded))
const multitableStatusLabel = computed(() => {
  if (multitableConnected.value) return tr('Connected', '已连接')
  if (multitableDegraded.value) return tr('Degraded', '已降级')
  return tr('Unavailable', '不可用')
})
const multitableHref = computed(() => {
  const multitable = multitableState.value
  if (!multitable?.sheetId || !multitable.viewId) return ''
  const params = new URLSearchParams()
  if (multitable.baseId) params.set('baseId', multitable.baseId)
  const suffix = params.toString()
  return `/multitable/${encodeURIComponent(multitable.sheetId)}/${encodeURIComponent(multitable.viewId)}${suffix ? `?${suffix}` : ''}`
})
const multitableDetailRows = computed<MultitableDetailRow[]>(() => {
  const multitable = multitableState.value
  const rows: MultitableDetailRow[] = []
  const addId = (key: string, label: string, value?: string | null) => {
    const normalized = String(value ?? '').trim()
    if (normalized) rows.push({ key, label, value: normalized, monospace: true })
  }
  const addNumber = (key: string, label: string, value?: number) => {
    if (Number.isFinite(value)) rows.push({ key, label, value: String(value) })
  }

  addId('projectId', tr('Project ID', '项目 ID'), multitable.projectId)
  addId('objectId', tr('Object ID', '对象 ID'), multitable.objectId)
  addId('baseId', tr('Base ID', '底座 ID'), multitable.baseId)
  addId('sheetId', tr('Sheet ID', '表格 ID'), multitable.sheetId)
  addId('viewId', tr('View ID', '视图 ID'), multitable.viewId)
  addNumber('recordCount', tr('Catalog records', '目录记录'), multitable.recordCount)
  addNumber('seeded', tr('Seeded', '本次写入'), multitable.seeded)
  addNumber('existing', tr('Existing', '已存在'), multitable.existing)
  const fingerprint = reportFieldsPayload.value.reportFieldConfig?.fieldsFingerprint
  addId('fieldsFingerprintAlgorithm', tr('Fingerprint algorithm', '指纹算法'), fingerprint?.algorithm)
  addId('fieldsFingerprint', tr('Field fingerprint', '字段指纹'), fingerprint?.value)
  addNumber('fieldsFingerprintCount', tr('Fingerprint fields', '指纹字段数'), fingerprint?.fieldCount)
  addId('reason', tr('Reason', '原因'), multitable.reason)
  const error = String(multitable.error ?? '').trim()
  if (error) rows.push({ key: 'error', label: tr('Error', '错误'), value: error })
  return rows
})
const canSyncReportRecords = computed(() => (
  recordSyncFrom.value.trim() !== ''
  && recordSyncTo.value.trim() !== ''
  && recordSyncUserId.value.trim() !== ''
))
const reportRecordsMultitableHref = computed(() => {
  const multitable = reportRecordsSyncResult.value?.multitable
  if (!multitable?.sheetId || !multitable.viewId) return ''
  const params = new URLSearchParams()
  if (multitable.baseId) params.set('baseId', multitable.baseId)
  const suffix = params.toString()
  return `/multitable/${encodeURIComponent(multitable.sheetId)}/${encodeURIComponent(multitable.viewId)}${suffix ? `?${suffix}` : ''}`
})
const reportRecordSyncDetailRows = computed<MultitableDetailRow[]>(() => {
  const result = reportRecordsSyncResult.value
  if (!result) return []
  const rows: MultitableDetailRow[] = []
  const addNumber = (key: string, label: string, value?: number) => {
    if (Number.isFinite(value)) rows.push({ key, label, value: String(value) })
  }
  const addText = (key: string, label: string, value?: string | null, monospace = false) => {
    const normalized = String(value ?? '').trim()
    if (normalized) rows.push({ key, label, value: normalized, monospace })
  }
  addNumber('synced', tr('Rows read', '读取行数'), result.synced)
  addNumber('created', tr('Created', '新建'), result.created)
  addNumber('patched', tr('Patched', '更新'), result.patched)
  addNumber('skipped', tr('Skipped', '跳过'), result.skipped)
  addNumber('failed', tr('Failed', '失败'), result.failed)
  addNumber('duplicateRowKeys', tr('Duplicate row keys', '重复行键'), result.duplicateRowKeys)
  addText('fieldFingerprint', tr('Field fingerprint', '字段指纹'), result.fieldFingerprint, true)
  addText('syncedAt', tr('Synced at', '同步时间'), result.syncedAt)
  addText('projectId', tr('Project ID', '项目 ID'), result.multitable?.projectId, true)
  addText('objectId', tr('Object ID', '对象 ID'), result.multitable?.objectId, true)
  addText('sheetId', tr('Sheet ID', '表格 ID'), result.multitable?.sheetId, true)
  addText('viewId', tr('View ID', '视图 ID'), result.multitable?.viewId, true)
  addText('reason', tr('Reason', '原因'), result.reason)
  return rows
})

const visibleCategories = computed<AttendanceReportFieldCategory[]>(() => {
  const categoryIdsWithFields = new Set(filteredReportFields.value.map(field => field.category))
  if (categoryFilterOptions.value.length > 0) {
    return categoryFilterOptions.value
      .filter(category => categoryIdsWithFields.has(category.id))
  }
  const fallback = new Map<string, AttendanceReportFieldCategory>()
  for (const field of filteredReportFields.value) {
    if (!fallback.has(field.category)) {
      fallback.set(field.category, {
        id: field.category,
        label: field.categoryLabel || field.category,
        sortOrder: field.sortOrder,
      })
    }
  }
  return Array.from(fallback.values()).sort((left, right) => left.sortOrder - right.sortOrder)
})

function fieldsByCategory(categoryId: string): AttendanceReportFieldItem[] {
  return filteredReportFields.value
    .filter(field => field.category === categoryId)
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder
      return left.code.localeCompare(right.code)
    })
}

function categoryStats(categoryId: string) {
  const fields = fieldsByCategory(categoryId)
  return {
    total: fields.length,
    enabled: fields.filter(field => field.enabled).length,
    visible: fields.filter(field => field.reportVisible).length,
  }
}

function matchesFieldStatusFilter(field: AttendanceReportFieldItem): boolean {
  if (fieldStatusFilter.value === 'configured') return Boolean(field.configured)
  if (fieldStatusFilter.value === 'formula') return Boolean(field.formulaEnabled)
  if (fieldStatusFilter.value === 'formula_error') return Boolean(field.formulaEnabled && field.formulaValid === false)
  if (fieldStatusFilter.value === 'disabled') return field.enabled === false
  if (fieldStatusFilter.value === 'hidden') return field.reportVisible === false
  return true
}

function formatStatusFilterLabel(value: ReportFieldStatusFilter): string {
  if (value === 'configured') return tr('Configured', '已配置')
  if (value === 'formula') return tr('Formula fields', '公式字段')
  if (value === 'formula_error') return tr('Formula errors', '公式错误')
  if (value === 'disabled') return tr('Disabled', '已停用')
  if (value === 'hidden') return tr('Hidden', '已隐藏')
  return tr('All fields', '全部字段')
}

function resetReportFieldFilters(): void {
  fieldSearchTerm.value = ''
  fieldStatusFilter.value = 'all'
  fieldCategoryFilter.value = 'all'
}

function formatUnit(unit: string): string {
  const normalized = String(unit || '').trim()
  const labels: Record<string, string> = {
    text: tr('Text', '文本'),
    dateTime: tr('Date time', '日期时间'),
    days: tr('Days', '天'),
    minutes: tr('Minutes', '分钟'),
    count: tr('Count', '次数'),
    hours: tr('Hours', '小时'),
  }
  return labels[normalized] ?? (normalized || '--')
}

function formatSource(source: string, systemDefined?: boolean): string {
  const normalized = String(source || '').trim()
  if (normalized === 'system') return tr('System', '系统')
  if (normalized === 'dingtalk') return tr('DingTalk', '钉钉')
  if (normalized === 'multitable') return tr('Multitable', '多维表')
  if (normalized === 'custom') return tr('Custom', '自定义')
  return normalized || (systemDefined ? tr('System', '系统') : '--')
}

function formatConfigurationSource(field: AttendanceReportFieldItem): string {
  if (field.systemDefined === false) return tr('Custom', '自定义')
  if (field.configured) return tr('Configured', '已配置')
  return tr('Built-in', '内置')
}

function configurationPillClass(field: AttendanceReportFieldItem): Record<string, boolean> {
  return {
    'attendance-report-fields__pill--configured': Boolean(field.configured && field.systemDefined !== false),
    'attendance-report-fields__pill--custom': field.systemDefined === false,
  }
}

function formatFormulaScope(scope?: string): string {
  const normalized = String(scope || 'record').trim()
  if (normalized === 'record') return tr('Record scope', '单记录')
  return normalized || '--'
}

function formatFormulaOutputType(outputType?: string): string {
  const normalized = String(outputType || '').trim()
  const labels: Record<string, string> = {
    number: tr('Number', '数字'),
    duration_minutes: tr('Duration minutes', '分钟时长'),
    text: tr('Text', '文本'),
    boolean: tr('Boolean', '布尔'),
    date: tr('Date', '日期'),
  }
  return labels[normalized] ?? (normalized || '--')
}

function formatFormulaMeta(field: AttendanceReportFieldItem): string {
  const parts = [
    formatFormulaScope(field.formulaScope),
    formatFormulaOutputType(field.formulaOutputType),
  ]
  const references = Array.isArray(field.formulaReferences)
    ? field.formulaReferences.filter(Boolean)
    : []
  if (references.length > 0) {
    parts.push(`${tr('References', '引用')}: ${references.join(', ')}`)
  }
  return parts.filter(Boolean).join(' · ')
}

function fieldMappingRows(field: AttendanceReportFieldItem): FieldMappingRow[] {
  const rows: FieldMappingRow[] = []
  const dingtalkFieldName = String(field.dingtalkFieldName ?? '').trim()
  const internalKey = String(field.internalKey ?? '').trim()
  const sortOrder = Number(field.sortOrder)
  if (dingtalkFieldName) {
    rows.push({
      key: 'dingtalkFieldName',
      label: tr('DingTalk field', '钉钉字段'),
      value: dingtalkFieldName,
    })
  }
  if (internalKey) {
    rows.push({
      key: 'internalKey',
      label: tr('Internal key', '内部键'),
      value: internalKey,
      monospace: true,
    })
  }
  if (Number.isFinite(sortOrder)) {
    rows.push({
      key: 'sortOrder',
      label: tr('Order', '排序'),
      value: String(sortOrder),
      monospace: true,
    })
  }
  return rows
}

function syncStatusMetric(labelEn: string, labelZh: string, value?: number): string {
  return Number.isFinite(value) ? `${tr(labelEn, labelZh)}: ${value}` : ''
}

function buildSyncStatusMessage(data: AttendanceReportFieldsPayload): string {
  const multitable = data.multitable ?? {}
  const details = [
    syncStatusMetric('Seeded', '本次写入', multitable.seeded),
    syncStatusMetric('Existing', '已存在', multitable.existing),
    syncStatusMetric('Records', '记录数', multitable.recordCount),
  ].filter(Boolean)

  if (multitable.degraded) {
    details.push(`${tr('Status', '状态')}: ${tr('Degraded', '已降级')}`)
  } else if (multitable.available) {
    details.push(`${tr('Status', '状态')}: ${tr('Connected', '已连接')}`)
  }

  const summary = details.length > 0 ? ` ${details.join(' · ')}` : ''
  return `${tr('Report field catalog synchronized.', '统计字段目录已同步。')}${summary}`
}

function dateInputValue(offsetDays: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildReportRecordsSyncStatusMessage(data: AttendanceReportRecordsSyncResult): string {
  if (data.degraded) {
    const reason = String(data.reason ?? '').trim()
    return reason
      ? `${tr('Report records sync degraded.', '报表记录同步已降级。')} ${reason}`
      : tr('Report records sync degraded.', '报表记录同步已降级。')
  }
  const details = [
    syncStatusMetric('Rows', '行数', data.synced),
    syncStatusMetric('Created', '新建', data.created),
    syncStatusMetric('Patched', '更新', data.patched),
    syncStatusMetric('Skipped', '跳过', data.skipped),
    syncStatusMetric('Failed', '失败', data.failed),
    syncStatusMetric('Duplicate row keys', '重复行键', data.duplicateRowKeys),
  ].filter(Boolean)
  const summary = details.length > 0 ? ` ${details.join(' · ')}` : ''
  return `${tr('Report records synchronized.', '报表记录已同步。')}${summary}`
}

async function loadReportFields(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const params = new URLSearchParams()
    const orgId = props.orgId?.trim()
    if (orgId) params.set('orgId', orgId)
    const suffix = params.toString()
    const response = await apiFetch(`/api/attendance/report-fields${suffix ? `?${suffix}` : ''}`)
    const payload = await response.json()
    if (!response.ok || payload?.ok === false) {
      throw payload
    }
    reportFieldsPayload.value = payload?.data ?? { categories: [], items: [], multitable: { available: false } }
  } catch (error) {
    loadError.value = readErrorMessage(error, tr('Failed to load report fields', '加载统计字段失败'))
  } finally {
    loading.value = false
  }
}

async function syncReportFields(): Promise<void> {
  syncing.value = true
  syncStatusMessage.value = ''
  syncStatusKind.value = 'info'
  try {
    const params = new URLSearchParams()
    const orgId = props.orgId?.trim()
    if (orgId) params.set('orgId', orgId)
    const suffix = params.toString()
    const response = await apiFetch(`/api/attendance/report-fields/sync${suffix ? `?${suffix}` : ''}`, {
      method: 'POST',
    })
    const payload = await response.json()
    if (!response.ok || payload?.ok === false) {
      throw payload
    }
    const data = payload?.data ?? { categories: [], items: [], multitable: { available: false } }
    reportFieldsPayload.value = data
    syncStatusMessage.value = buildSyncStatusMessage(data)
  } catch (error) {
    syncStatusKind.value = 'error'
    syncStatusMessage.value = readErrorMessage(error, tr('Failed to sync report fields', '同步统计字段失败'))
  } finally {
    syncing.value = false
  }
}

async function syncReportRecords(): Promise<void> {
  if (!canSyncReportRecords.value) return
  recordSyncing.value = true
  recordSyncStatusMessage.value = ''
  recordSyncStatusKind.value = 'info'
  try {
    const params = new URLSearchParams()
    const orgId = props.orgId?.trim()
    if (orgId) params.set('orgId', orgId)
    const suffix = params.toString()
    const response = await apiFetch(`/api/attendance/report-records/sync${suffix ? `?${suffix}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: recordSyncFrom.value.trim(),
        to: recordSyncTo.value.trim(),
        userId: recordSyncUserId.value.trim(),
      }),
    })
    const payload = await response.json()
    if (!response.ok || payload?.ok === false) {
      throw payload
    }
    const data = payload?.data ?? {}
    reportRecordsSyncResult.value = data
    recordSyncStatusKind.value = data.degraded ? 'warn' : 'info'
    recordSyncStatusMessage.value = buildReportRecordsSyncStatusMessage(data)
  } catch (error) {
    recordSyncStatusKind.value = 'error'
    recordSyncStatusMessage.value = readErrorMessage(error, tr('Failed to sync report records', '同步报表记录失败'))
  } finally {
    recordSyncing.value = false
  }
}

watch(
  () => props.orgId,
  () => {
    void loadReportFields()
  },
  { immediate: true },
)
</script>

<style scoped>
.attendance-report-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.attendance__admin-section-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.attendance__admin-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.attendance__section-meta,
.attendance__field-hint {
  color: #64748b;
  font-size: 12px;
  line-height: 1.4;
}

.attendance__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 7px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  color: #1f2937;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}

.attendance__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.attendance__status,
.attendance__empty {
  padding: 10px 12px;
  border-radius: 8px;
  background: #f8fafc;
  color: #475569;
  font-size: 13px;
}

.attendance__status--error {
  border: 1px solid #fecaca;
  background: #fff1f2;
  color: #b91c1c;
}

.attendance__status--warn {
  border: 1px solid #fde68a;
  background: #fffbeb;
  color: #92400e;
}

.attendance__table-wrapper {
  width: 100%;
  overflow-x: auto;
}

.attendance__table {
  width: 100%;
  border-collapse: collapse;
}

.attendance__table th,
.attendance__table td {
  border-bottom: 1px solid #e2e8f0;
  padding: 9px 10px;
  text-align: left;
  font-size: 13px;
}

.attendance__table th {
  color: #475569;
  font-weight: 700;
  background: #f8fafc;
}

.attendance-report-fields__grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}

.attendance-report-fields__filters {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid #d8dee8;
  border-radius: 8px;
  background: #fff;
}

.attendance-report-fields__filter {
  display: grid;
  gap: 4px;
  min-width: 180px;
  color: #475569;
  font-size: 12px;
  font-weight: 700;
}

.attendance-report-fields__filter input,
.attendance-report-fields__filter select {
  min-height: 34px;
  padding: 6px 9px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  color: #1f2937;
  font-size: 13px;
}

.attendance-report-fields__filter-summary {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  color: #64748b;
  font-size: 13px;
  font-weight: 600;
}

.attendance-report-fields__active-filters {
  flex: 1 1 100%;
  color: #64748b;
  font-size: 12px;
  line-height: 1.4;
}

.attendance-report-fields__basis {
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid #d8dee8;
  border-radius: 8px;
  background: #fff;
}

.attendance-report-fields__basis-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.attendance-report-fields__basis-title {
  color: #1f2937;
  font-size: 14px;
  font-weight: 700;
}

.attendance-report-fields__basis-details {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px 12px;
  margin: 0;
}

.attendance-report-fields__basis-detail {
  min-width: 0;
}

.attendance-report-fields__basis-detail dt {
  color: #64748b;
  font-size: 12px;
  line-height: 1.4;
}

.attendance-report-fields__basis-detail dd {
  margin: 2px 0 0;
  color: #1f2937;
  font-size: 13px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.attendance-report-fields__basis-detail code {
  font-size: 12px;
}

.attendance-report-fields__record-sync {
  gap: 12px;
}

.attendance-report-fields__record-sync-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: end;
}

.attendance-report-fields__record-sync-form .attendance-report-fields__filter {
  flex: 1 1 180px;
}

.attendance-report-fields__category {
  border: 1px solid #d8dee8;
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
}

.attendance-report-fields__category-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid #edf1f5;
  background: #f8fafc;
}

.attendance-report-fields__category h5 {
  margin: 0 0 4px;
  font-size: 14px;
}

.attendance-report-fields__table-wrapper {
  margin: 0;
  border: 0;
  border-radius: 0;
}

.attendance-report-fields__table th,
.attendance-report-fields__table td {
  vertical-align: top;
}

.attendance-report-fields__pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #e9f7ef;
  color: #17633a;
  font-size: 12px;
  font-weight: 600;
}

.attendance-report-fields__pill--off {
  background: #f1f5f9;
  color: #64748b;
}

.attendance-report-fields__pill--configured {
  background: #e0f2fe;
  color: #075985;
}

.attendance-report-fields__pill--custom {
  background: #fef3c7;
  color: #92400e;
}

.attendance-report-fields__pill--formula {
  background: #ecfdf5;
  color: #047857;
}

.attendance-report-fields__pill--error {
  background: #fff1f2;
  color: #be123c;
}

.attendance-report-fields__formula {
  min-width: 220px;
}

.attendance-report-fields__formula code {
  display: block;
  margin-top: 6px;
  color: #1f2937;
  font-size: 12px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.attendance-report-fields__formula-error {
  margin-top: 6px;
  color: #be123c;
  font-size: 12px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.attendance-report-fields__mapping {
  min-width: 180px;
}

.attendance-report-fields__mapping-row {
  display: grid;
  gap: 2px;
  margin-bottom: 6px;
}

.attendance-report-fields__mapping-row:last-child {
  margin-bottom: 0;
}

.attendance-report-fields__mapping-row span {
  color: #64748b;
  font-size: 11px;
  line-height: 1.3;
}

.attendance-report-fields__mapping-row strong,
.attendance-report-fields__mapping-row code {
  color: #1f2937;
  font-size: 12px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.attendance-report-fields__status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 72px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
}

.attendance-report-fields__status-pill--ok {
  background: #e9f7ef;
  color: #17633a;
}

.attendance-report-fields__status-pill--warn {
  background: #fff7ed;
  color: #9a3412;
}

.attendance-report-fields__status-pill--off {
  background: #f1f5f9;
  color: #64748b;
}
</style>
