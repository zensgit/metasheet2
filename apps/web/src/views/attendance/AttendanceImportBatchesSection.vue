<template>
  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Import batches', '导入批次') }}</h4>
      <button class="attendance__btn" :disabled="importBatchLoading" @click="reloadImportBatches">
        {{ importBatchLoading ? tr('Loading...', '加载中...') : tr('Reload batches', '重载批次') }}
      </button>
    </div>
    <div class="attendance__section-meta">
      {{ tr('Batches loaded', '已加载批次') }}: {{ importBatches.length }}
      <span v-if="batchRowCountTotal"> · {{ tr('Rows total', '总行数') }}: {{ batchRowCountTotal }}</span>
      <span v-if="visibleImportBatches.length !== importBatches.length"> · {{ tr('Visible batches', '当前可见批次') }}: {{ visibleImportBatches.length }}</span>
      <span v-if="visibleBatchRowCountTotal !== batchRowCountTotal"> · {{ tr('Visible rows', '当前可见行数') }}: {{ visibleBatchRowCountTotal }}</span>
      <span v-if="importBatchItems.length"> · {{ tr('Current items', '当前条目') }}: {{ importBatchItems.length }}</span>
    </div>
    <div v-if="batchItemSummary.totalItems > 0" class="attendance__impact-summary">
      <div class="attendance__impact-card">
        <span>{{ tr('Loaded rows', '已加载行') }}</span>
        <strong>{{ batchItemSummary.totalItems }}</strong>
      </div>
      <div class="attendance__impact-card">
        <span>{{ tr('Anomalies', '异常') }}</span>
        <strong>{{ batchItemSummary.anomalyItems }}</strong>
      </div>
      <div class="attendance__impact-card">
        <span>{{ tr('Warnings', '警告') }}</span>
        <strong>{{ batchItemSummary.warningItems }}</strong>
      </div>
      <div class="attendance__impact-card">
        <span>{{ tr('Missing record', '缺少记录') }}</span>
        <strong>{{ batchItemSummary.missingRecordItems }}</strong>
      </div>
      <div class="attendance__impact-card">
        <span>{{ tr('Late / early', '迟到 / 早退') }}</span>
        <strong>{{ batchItemSummary.lateItems }} / {{ batchItemSummary.earlyLeaveItems }}</strong>
      </div>
      <div class="attendance__impact-card">
        <span>{{ tr('Leave / OT', '请假 / 加班') }}</span>
        <strong>{{ batchItemSummary.leaveItems }} / {{ batchItemSummary.overtimeItems }}</strong>
      </div>
    </div>
    <div v-if="importBatches.length === 0" class="attendance__empty">{{ tr('No import batches.', '暂无导入批次。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <div class="attendance__inbox-toolbar">
        <div class="attendance__admin-grid attendance__admin-grid--wide">
          <label class="attendance__field" for="attendance-import-batch-inbox-search">
            <span>{{ tr('Search batches', '搜索批次') }}</span>
            <input
              id="attendance-import-batch-inbox-search"
              v-model="batchSearchText"
              type="search"
              :placeholder="tr('Search by batch, source, creator, rule set, or chunk', '按批次、来源、创建人、规则集或分块搜索')"
            />
          </label>
          <label class="attendance__field" for="attendance-import-batch-status-filter">
            <span>{{ tr('Status filter', '状态筛选') }}</span>
            <select id="attendance-import-batch-status-filter" v-model="batchStatusFilter">
              <option value="all">{{ tr('All statuses', '全部状态') }}</option>
              <option v-for="option in batchStatusOptions" :key="option" :value="option">{{ formatBatchOptionLabel(option) }}</option>
            </select>
          </label>
          <label class="attendance__field" for="attendance-import-batch-engine-filter">
            <span>{{ tr('Engine filter', '引擎筛选') }}</span>
            <select id="attendance-import-batch-engine-filter" v-model="batchEngineFilter">
              <option value="all">{{ tr('All engines', '全部引擎') }}</option>
              <option v-for="option in batchEngineOptions" :key="option" :value="option">{{ formatBatchOptionLabel(option) }}</option>
            </select>
          </label>
          <label class="attendance__field" for="attendance-import-batch-source-filter">
            <span>{{ tr('Source filter', '来源筛选') }}</span>
            <select id="attendance-import-batch-source-filter" v-model="batchSourceFilter">
              <option value="all">{{ tr('All sources', '全部来源') }}</option>
              <option v-for="option in batchSourceOptions" :key="option" :value="option">{{ formatBatchOptionLabel(option) }}</option>
            </select>
          </label>
          <label class="attendance__field" for="attendance-import-batch-creator-filter">
            <span>{{ tr('Creator filter', '创建人筛选') }}</span>
            <select id="attendance-import-batch-creator-filter" v-model="batchCreatorFilter">
              <option value="all">{{ tr('All creators', '全部创建人') }}</option>
              <option v-for="option in batchCreatorOptions" :key="option" :value="option">{{ formatBatchOptionLabel(option) }}</option>
            </select>
          </label>
          <label class="attendance__field" for="attendance-import-batch-created-from">
            <span>{{ tr('Created from', '创建起始') }}</span>
            <input id="attendance-import-batch-created-from" v-model="batchCreatedFrom" type="date" @input="markBatchTimeSliceCustom" />
          </label>
          <label class="attendance__field" for="attendance-import-batch-created-to">
            <span>{{ tr('Created to', '创建截止') }}</span>
            <input id="attendance-import-batch-created-to" v-model="batchCreatedTo" type="date" @input="markBatchTimeSliceCustom" />
          </label>
          <label class="attendance__field attendance__field--full">
            <span>{{ tr('Time slice', '时间切片') }}</span>
            <div class="attendance__filter-chip-row">
              <button
                v-for="preset in batchTimeSlicePresets"
                :key="preset.key"
                class="attendance__chip"
                :class="{ 'attendance__chip--active': batchTimeSlicePreset === preset.key }"
                type="button"
                @click="applyBatchTimeSlicePreset(preset.key)"
              >
                {{ preset.label }}
              </button>
            </div>
          </label>
        </div>
        <div class="attendance__subheading-row">
          <div class="attendance__section-meta">
            {{ tr('View mode', '视图模式') }}:
            <strong>{{ tr('Batch inbox', '批次收件箱') }}</strong>
            <span> · {{ tr('Time slice', '时间切片') }}: <strong>{{ batchTimeSliceLabel }}</strong></span>
            <span> · {{ tr('Active filters', '当前筛选') }}: <strong>{{ batchFilterSummary }}</strong></span>
            <span v-if="batchSearchQuery"> · {{ tr('Search', '搜索') }}: <strong>{{ batchSearchText }}</strong></span>
          </div>
          <div class="attendance__table-actions">
            <button class="attendance__btn" type="button" @click="resetBatchFilters">
              {{ tr('Reset batch filters', '重置批次筛选') }}
            </button>
          </div>
        </div>
      </div>
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Batch', '批次') }}</th>
            <th>{{ tr('Status', '状态') }}</th>
            <th>{{ tr('Rows', '行数') }}</th>
            <th>{{ tr('Engine', '引擎') }}</th>
            <th>{{ tr('Chunk', '分块') }}</th>
            <th>{{ tr('Source', '来源') }}</th>
            <th>{{ tr('Rule set', '规则集') }}</th>
            <th>{{ tr('Created by', '创建人') }}</th>
            <th>{{ tr('Created', '创建时间') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in visibleImportBatches" :key="batch.id">
            <td>{{ batch.id.slice(0, 8) }}</td>
            <td>{{ formatStatus(batch.status) }}</td>
            <td>{{ batch.rowCount }}</td>
            <td>{{ resolveImportBatchEngine(batch) }}</td>
            <td>{{ resolveImportBatchChunkLabel(batch) }}</td>
            <td>{{ batch.source || '--' }}</td>
            <td>{{ resolveRuleSetName(batch.ruleSetId) }}</td>
            <td>{{ batch.createdBy || '--' }}</td>
            <td>{{ formatDateTime(batch.createdAt ?? null) }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="loadImportBatchItems(batch.id)">{{ tr('View items', '查看条目') }}</button>
              <button
                class="attendance__btn attendance__btn--danger"
                :disabled="importBatchLoading"
                @click="rollbackImportBatch(batch.id)"
              >
                {{ tr('Rollback', '回滚') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="visibleImportBatches.length === 0" class="attendance__empty">
        {{ tr('No batches match the current inbox filters.', '当前批次收件箱筛选下没有匹配批次。') }}
      </div>
    </div>

    <div v-if="importBatchItems.length > 0" class="attendance__table-wrapper">
      <div class="attendance__subheading-row">
        <h5 class="attendance__subheading">{{ tr('Batch items', '批次条目') }}</h5>
        <div class="attendance__section-meta">
          {{ tr('Loaded items', '已加载条目') }}: {{ importBatchItems.length }}
          <span v-if="batchItemSummary.anomalyItems"> · {{ tr('Anomalies', '异常') }}: {{ batchItemSummary.anomalyItems }}</span>
        </div>
        <div class="attendance__table-actions">
          <button class="attendance__btn" :disabled="importBatchLoading" @click="setIssueFilter('all')">
            {{ tr('Reset view', '重置视图') }}
          </button>
          <button class="attendance__btn" :disabled="importBatchLoading" @click="exportImportBatchItemsCsv(false)">
            {{ tr('Export items CSV', '导出条目 CSV') }}
          </button>
          <button class="attendance__btn" :disabled="importBatchLoading" @click="exportImportBatchItemsCsv(true)">
            {{ tr('Export anomalies CSV', '导出异常 CSV') }}
          </button>
        </div>
      </div>

      <div v-if="selectedBatch" class="attendance__batch-meta">
        <div class="attendance__impact-card">
          <span>{{ tr('Selected batch', '当前批次') }}</span>
          <strong>{{ selectedBatch.id.slice(0, 8) }}</strong>
        </div>
        <div class="attendance__impact-card">
          <span>{{ tr('Batch status', '批次状态') }}</span>
          <strong>{{ formatStatus(selectedBatch.status) }}</strong>
        </div>
        <div class="attendance__impact-card">
          <span>{{ tr('Rule set', '规则集') }}</span>
          <strong>{{ resolveRuleSetName(selectedBatch.ruleSetId) }}</strong>
        </div>
        <div class="attendance__impact-card">
          <span>{{ tr('Source', '来源') }}</span>
          <strong>{{ selectedBatch.source || '--' }}</strong>
        </div>
      </div>

      <div v-if="selectedBatchRollbackEstimate.loadedItems > 0" class="attendance__detail-panel">
        <div class="attendance__subheading-row">
          <h6 class="attendance__subheading">{{ tr('Rollback impact estimate', '回滚影响估算') }}</h6>
          <span class="attendance__section-meta">
            {{ tr('Coverage', '覆盖范围') }}:
            <strong>{{ selectedBatchRollbackEstimate.loadedItems }} / {{ selectedBatchRollbackEstimate.totalBatchRows }}</strong>
            <span v-if="selectedBatchRollbackEstimate.coveragePercent !== null"> ({{ selectedBatchRollbackEstimate.coveragePercent }}%)</span>
          </span>
        </div>
        <div class="attendance__impact-summary">
          <div class="attendance__impact-card">
            <span>{{ tr('Loaded for estimate', '已纳入估算') }}</span>
            <strong>{{ selectedBatchRollbackEstimate.loadedItems }}</strong>
          </div>
          <div class="attendance__impact-card">
            <span>{{ tr('Est. committed rows', '预计受影响记录') }}</span>
            <strong>{{ selectedBatchRollbackEstimate.estimatedCommittedRows }}</strong>
          </div>
          <div class="attendance__impact-card">
            <span>{{ tr('Preview-only rows', '仅预演行') }}</span>
            <strong>{{ selectedBatchRollbackEstimate.previewOnlyRows }}</strong>
          </div>
          <div class="attendance__impact-card">
            <span>{{ tr('Flagged rows', '已标记行') }}</span>
            <strong>{{ selectedBatchRollbackEstimate.flaggedRows }}</strong>
          </div>
          <div class="attendance__impact-card">
            <span>{{ tr('Warning rows', '警告行') }}</span>
            <strong>{{ selectedBatchRollbackEstimate.warningRows }}</strong>
          </div>
          <div class="attendance__impact-card">
            <span>{{ tr('Policy-sensitive rows', '规则敏感行') }}</span>
            <strong>{{ selectedBatchRollbackEstimate.policyReviewRows }}</strong>
          </div>
        </div>
        <div v-if="selectedBatchRollbackNotes.length" class="attendance__detail-hints">
          <span class="attendance__detail-hints-title">{{ tr('Rollback notes', '回滚提示') }}</span>
          <ul class="attendance__detail-hints-list">
            <li v-for="note in selectedBatchRollbackNotes" :key="note">{{ note }}</li>
          </ul>
        </div>
      </div>

      <div v-if="selectedBatchOperatorNotes.length" class="attendance__field-hint">
        {{ tr('Operator notes', '运营提示') }}: {{ selectedBatchOperatorNotes.join(' · ') }}
      </div>

      <div v-if="selectedBatchMappingEntries.length" class="attendance__mapping-panel">
        <div class="attendance__subheading-row">
          <h6 class="attendance__subheading">{{ tr('Mapping viewer', '映射预览') }}</h6>
          <span class="attendance__section-meta">
            {{ tr('Fields', '字段数') }}: {{ selectedBatchMappingEntries.length }}
          </span>
        </div>
        <div class="attendance__mapping-grid">
          <div v-for="entry in selectedBatchMappingEntries" :key="entry.key" class="attendance__mapping-card">
            <span>{{ entry.label }}</span>
            <strong>{{ entry.value }}</strong>
          </div>
        </div>
      </div>

      <div class="attendance__admin-grid">
        <label class="attendance__field" for="attendance-import-batch-search">
          <span>{{ tr('Search items', '搜索条目') }}</span>
          <input
            id="attendance-import-batch-search"
            v-model="searchText"
            type="search"
            :placeholder="tr('Search by user, date, record, warning, or snapshot', '按用户、日期、记录、警告或快照搜索')"
          />
        </label>
      </div>

      <div v-if="issueClusters.length" class="attendance__filter-chip-row">
        <button
          class="attendance__chip"
          :class="{ 'attendance__chip--active': isIssueFilterActive('all') }"
          type="button"
          @click="setIssueFilter('all')"
        >
          {{ tr('All items', '全部条目') }} · {{ importBatchItems.length }}
        </button>
        <button
          v-for="cluster in issueClusters"
          :key="cluster.key"
          class="attendance__chip"
          :class="[
            `attendance__chip--${cluster.severity}`,
            { 'attendance__chip--active': isIssueFilterActive(cluster.key) },
          ]"
          type="button"
          @click="setIssueFilter(cluster.key)"
        >
          {{ formatIssueFilterLabel(cluster.key) }} · {{ cluster.count }}
        </button>
      </div>

      <div class="attendance__section-meta">
        {{ tr('View mode', '视图模式') }}:
        <strong>{{ formatIssueFilterLabel(issueFilter) }}</strong>
        <span v-if="searchQuery"> · {{ tr('Search', '搜索') }}: <strong>{{ searchText }}</strong></span>
      </div>

      <div v-if="visibleImportBatchRows.length === 0" class="attendance__empty">
        {{ tr('No items match the current batch triage filters.', '当前批次分诊筛选下没有匹配条目。') }}
      </div>
      <table v-else class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Work date', '工作日期') }}</th>
            <th>{{ tr('User ID', '用户 ID') }}</th>
            <th>{{ tr('Record', '记录') }}</th>
            <th>{{ tr('Severity', '严重度') }}</th>
            <th>{{ tr('Flags', '标记') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in visibleImportBatchRows"
            :key="row.item.id"
            :class="{ 'attendance__row--selected': selectedImportBatchRow?.item.id === row.item.id }"
          >
            <td>{{ row.item.workDate }}</td>
            <td>{{ row.item.userId }}</td>
            <td>{{ row.item.recordId || '--' }}</td>
            <td>
              <span class="attendance__severity" :class="`attendance__severity--${resolveImportBatchSeverity(row.analysis)}`">
                {{ formatSeverity(resolveImportBatchSeverity(row.analysis)) }}
              </span>
            </td>
            <td>{{ formatImportBatchFlags(row.analysis) }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" type="button" @click="selectImportBatchRow(row.item)">
                {{ tr('Details', '详情') }}
              </button>
              <button class="attendance__btn" type="button" @click="toggleImportBatchSnapshot(row.item)">
                {{ importBatchSnapshot === row.item.previewSnapshot ? tr('Hide snapshot', '隐藏快照') : tr('View snapshot', '查看快照') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="selectedImportBatchRow" class="attendance__detail-panel">
        <div class="attendance__subheading-row">
          <h6 class="attendance__subheading">{{ tr('Selected item detail', '选中条目详情') }}</h6>
          <span class="attendance__severity" :class="`attendance__severity--${selectedImportBatchSeverity}`">
            {{ formatSeverity(selectedImportBatchSeverity) }}
          </span>
        </div>
        <div class="attendance__preview-summary">
          <span>{{ tr('User', '用户') }}: <strong>{{ selectedImportBatchRow.item.userId || '--' }}</strong></span>
          <span>{{ tr('Work date', '工作日期') }}: <strong>{{ selectedImportBatchRow.item.workDate || '--' }}</strong></span>
          <span>{{ tr('Record ID', '记录 ID') }}: <strong>{{ selectedImportBatchRow.item.recordId || '--' }}</strong></span>
          <span>{{ tr('Created', '创建时间') }}: <strong>{{ formatDateTime(selectedImportBatchRow.item.createdAt ?? null) }}</strong></span>
        </div>
        <div class="attendance__impact-summary">
          <div v-for="metric in selectedImportBatchMetrics" :key="metric.key" class="attendance__impact-card">
            <span>{{ metric.label }}</span>
            <strong>{{ metric.value }}</strong>
          </div>
        </div>
        <div v-if="selectedImportBatchWarnings.length" class="attendance__warning-list">
          <span
            v-for="warning in selectedImportBatchWarnings"
            :key="warning"
            class="attendance__warning-chip"
          >
            {{ warning }}
          </span>
        </div>
        <div v-if="selectedImportBatchActionHints.length" class="attendance__detail-hints">
          <span class="attendance__detail-hints-title">{{ tr('Recommended next steps', '建议下一步') }}</span>
          <ul class="attendance__detail-hints-list">
            <li v-for="hint in selectedImportBatchActionHints" :key="hint">{{ hint }}</li>
          </ul>
        </div>
        <div v-if="selectedImportBatchSnapshotSections.length" class="attendance__snapshot-sections">
          <div
            v-for="section in selectedImportBatchSnapshotSections"
            :key="section.key"
            class="attendance__snapshot-card"
          >
            <div class="attendance__subheading-row">
              <span class="attendance__detail-hints-title">{{ section.title }}</span>
              <span class="attendance__section-meta">{{ section.rows.length }}</span>
            </div>
            <div class="attendance__snapshot-grid">
              <div v-for="detail in section.rows" :key="`${section.key}-${detail.label}`" class="attendance__snapshot-item">
                <span>{{ detail.label }}</span>
                <strong>{{ detail.value }}</strong>
              </div>
            </div>
          </div>
        </div>
        <div v-if="selectedImportBatchSnapshot" class="attendance__detail-hints">
          <span class="attendance__detail-hints-title">{{ tr('Snapshot actions', '快照操作') }}</span>
          <div class="attendance__table-actions">
            <button class="attendance__btn" type="button" @click="copySelectedImportBatchSnapshot">
              {{ tr('Copy snapshot JSON', '复制快照 JSON') }}
            </button>
            <button class="attendance__btn" type="button" @click="toggleImportBatchSnapshot(selectedImportBatchRow.item)">
              {{ selectedImportBatchSnapshotVisible ? tr('Hide raw snapshot', '隐藏原始快照') : tr('View raw snapshot', '查看原始快照') }}
            </button>
          </div>
          <span v-if="snapshotActionMessage" class="attendance__field-hint">{{ snapshotActionMessage }}</span>
        </div>
        <pre v-if="selectedImportBatchSnapshotVisible" class="attendance__code">{{ formatJson(importBatchSnapshot) }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, type Ref } from 'vue'
import {
  buildImportBatchRollbackNotes,
  buildImportBatchActionHints,
  buildImportBatchSearchIndex,
  classifyImportBatchItem,
  estimateImportBatchRollbackImpact,
  matchesImportBatchIssueFilter,
  resolveImportBatchChunkLabel,
  resolveImportBatchEngine,
  resolveImportBatchSeverity,
  summarizeImportBatchIssueClusters,
  summarizeImportBatchItems,
  type AttendanceImportBatch,
  type AttendanceImportBatchImpactSummary,
  type AttendanceImportBatchIssueCluster,
  type AttendanceImportBatchIssueFilter,
  type AttendanceImportBatchSeverity,
  type AttendanceImportItem,
  type AttendanceImportBatchItemAnalysis,
} from './useAttendanceAdminImportBatches'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>
type BatchTimeSlicePreset = 'all' | 'today' | 'last7' | 'last30' | 'thisMonth' | 'custom'
type BatchTimeSlicePresetOption = {
  key: Exclude<BatchTimeSlicePreset, 'custom'>
  label: string
}

interface ImportBatchesBindings {
  importBatchLoading: Ref<boolean>
  importBatches: Ref<AttendanceImportBatch[]>
  importBatchItems: Ref<AttendanceImportItem[]>
  importBatchSelectedId: Ref<string>
  importBatchSnapshot: Ref<Record<string, any> | null>
  reloadImportBatches: () => MaybePromise<void>
  loadImportBatchItems: (batchId: string) => MaybePromise<void>
  rollbackImportBatch: (batchId: string) => MaybePromise<void>
  exportImportBatchItemsCsv: (onlyAnomalies: boolean) => MaybePromise<void>
  toggleImportBatchSnapshot: (item: AttendanceImportItem) => void
}

const props = defineProps<{
  tr: Translate
  workflow: ImportBatchesBindings
  resolveRuleSetName: (ruleSetId?: string | null) => string
  formatStatus: (value: string) => string
  formatDateTime: (value: string | null | undefined) => string
  formatJson: (value: unknown) => string
  clock?: () => Date
}>()

const tr = props.tr
const importBatchLoading = props.workflow.importBatchLoading
const importBatches = props.workflow.importBatches
const importBatchItems = props.workflow.importBatchItems
const importBatchSelectedId = props.workflow.importBatchSelectedId
const importBatchSnapshot = props.workflow.importBatchSnapshot
const reloadImportBatches = () => props.workflow.reloadImportBatches()
const loadImportBatchItems = (batchId: string) => props.workflow.loadImportBatchItems(batchId)
const rollbackImportBatch = (batchId: string) => props.workflow.rollbackImportBatch(batchId)
const exportImportBatchItemsCsv = (onlyAnomalies: boolean) => props.workflow.exportImportBatchItemsCsv(onlyAnomalies)
const toggleImportBatchSnapshot = (item: AttendanceImportItem) => props.workflow.toggleImportBatchSnapshot(item)
const resolveRuleSetName = props.resolveRuleSetName
const formatStatus = props.formatStatus
const formatDateTime = props.formatDateTime
const formatJson = props.formatJson
const clock = props.clock ?? (() => new Date())
const issueFilter = ref<AttendanceImportBatchIssueFilter>('all')
const searchText = ref('')
const batchSearchText = ref('')
const batchStatusFilter = ref('all')
const batchEngineFilter = ref('all')
const batchSourceFilter = ref('all')
const batchCreatorFilter = ref('all')
const batchCreatedFrom = ref('')
const batchCreatedTo = ref('')
const batchTimeSlicePreset = ref<BatchTimeSlicePreset>('all')
const selectedImportBatchItemId = ref('')
const snapshotActionMessage = ref('')

const batchSearchQuery = computed(() => batchSearchText.value.trim().toLowerCase())
const batchTimeSlicePresets = computed<BatchTimeSlicePresetOption[]>(() => ([
  { key: 'all', label: tr('All time', '全部时间') },
  { key: 'today', label: tr('Today', '今天') },
  { key: 'last7', label: tr('Last 7 days', '近 7 天') },
  { key: 'last30', label: tr('Last 30 days', '近 30 天') },
  { key: 'thisMonth', label: tr('This month', '本月至今') },
]))
const batchStatusOptions = computed(() => collectBatchFilterOptions((batch) => batch.status))
const batchEngineOptions = computed(() => collectBatchFilterOptions((batch) => resolveImportBatchEngine(batch)))
const batchSourceOptions = computed(() => collectBatchFilterOptions((batch) => batch.source))
const batchCreatorOptions = computed(() => collectBatchFilterOptions((batch) => batch.createdBy))
const visibleImportBatches = computed(() => importBatches.value.filter((batch) => {
  if (batchStatusFilter.value !== 'all' && batch.status !== batchStatusFilter.value) {
    return false
  }
  if (batchEngineFilter.value !== 'all' && resolveImportBatchEngine(batch) !== batchEngineFilter.value) {
    return false
  }
  if (batchSourceFilter.value !== 'all' && (batch.source || '--') !== batchSourceFilter.value) {
    return false
  }
  if (batchCreatorFilter.value !== 'all' && normalizeBatchFilterValue(batch.createdBy) !== batchCreatorFilter.value) {
    return false
  }
  const createdDate = resolveBatchCreatedDate(batch.createdAt)
  if (batchCreatedFrom.value && (!createdDate || createdDate < batchCreatedFrom.value)) {
    return false
  }
  if (batchCreatedTo.value && (!createdDate || createdDate > batchCreatedTo.value)) {
    return false
  }
  const query = batchSearchQuery.value
  if (!query) return true
  return buildBatchInboxSearchIndex(batch).includes(query)
}))

const batchItemRows = computed(() => importBatchItems.value.map((item) => ({
  item,
  analysis: classifyImportBatchItem(item),
})))
const selectedBatch = computed(() => importBatches.value.find((batch) => batch.id === importBatchSelectedId.value) ?? null)
const issueClusters = computed<AttendanceImportBatchIssueCluster[]>(() => summarizeImportBatchIssueClusters(importBatchItems.value))
const searchQuery = computed(() => searchText.value.trim().toLowerCase())
const visibleImportBatchRows = computed(() => (
  batchItemRows.value.filter((row) => {
    if (!matchesImportBatchIssueFilter(row.analysis, issueFilter.value)) {
      return false
    }
    const query = searchQuery.value
    if (!query) {
      return true
    }
    return buildImportBatchSearchIndex(row.item, row.analysis).includes(query)
  })
))
const batchItemSummary = computed<AttendanceImportBatchImpactSummary>(() => summarizeImportBatchItems(importBatchItems.value))
const selectedImportBatchRow = computed(() => {
  const rows = visibleImportBatchRows.value
  const selected = rows.find((row) => row.item.id === selectedImportBatchItemId.value)
  return selected ?? rows[0] ?? null
})
const selectedImportBatchSeverity = computed<AttendanceImportBatchSeverity>(() => (
  selectedImportBatchRow.value ? resolveImportBatchSeverity(selectedImportBatchRow.value.analysis) : 'clean'
))
const selectedImportBatchWarnings = computed(() => selectedImportBatchRow.value?.analysis.warnings ?? [])
const selectedImportBatchSnapshot = computed<Record<string, any> | null>(() => (
  selectedImportBatchRow.value?.item.previewSnapshot ?? null
))
const selectedImportBatchSnapshotVisible = computed(() => (
  Boolean(selectedImportBatchSnapshot.value) && importBatchSnapshot.value === selectedImportBatchSnapshot.value
))
const selectedImportBatchMetrics = computed(() => {
  const analysis = selectedImportBatchRow.value?.analysis
  if (!analysis) return []
  return [
    { key: 'workMinutes', label: tr('Work minutes', '工时分钟'), value: analysis.workMinutes },
    { key: 'lateMinutes', label: tr('Late', '迟到'), value: analysis.lateMinutes },
    { key: 'earlyLeaveMinutes', label: tr('Early leave', '早退'), value: analysis.earlyLeaveMinutes },
    { key: 'leaveMinutes', label: tr('Leave', '请假'), value: analysis.leaveMinutes },
    { key: 'overtimeMinutes', label: tr('Overtime', '加班'), value: analysis.overtimeMinutes },
  ]
})
const selectedImportBatchActionHints = computed(() => {
  const row = selectedImportBatchRow.value
  if (!row) return []

  const { analysis } = row
  const hints: string[] = []
  if (!analysis.hasRecord) {
    hints.push(tr('Verify row mapping and identity merge before rollback; this row does not have a committed attendance record yet.', '先核对行映射和身份归并，再考虑回滚；该行目前没有已提交的考勤记录。'))
  }
  if (analysis.warnings.length > 0) {
    hints.push(tr('Warnings were emitted during preview. Export anomalies CSV and review the warning payload before any rollback decision.', '预演阶段产生了警告。请先导出异常 CSV 并核对警告内容，再决定是否回滚。'))
  }
  if (analysis.lateMinutes > 0 || analysis.earlyLeaveMinutes > 0) {
    hints.push(tr(`Check shift windows and grace settings for this row (${analysis.lateMinutes} late / ${analysis.earlyLeaveMinutes} early leave).`, `检查该行对应班次窗口和宽限设置（迟到 ${analysis.lateMinutes} / 早退 ${analysis.earlyLeaveMinutes}）。`))
  }
  if (analysis.leaveMinutes > 0 || analysis.overtimeMinutes > 0) {
    hints.push(tr('Keep leave and overtime rows aligned with downstream approval and payroll reconciliation before editing source imports.', '请先对齐请假、加班与后续审批/薪资对账，再修改源导入数据。'))
  }
  if (hints.length === 0) {
    hints.push(tr('This row looks clean. Keep it as a baseline sample while triaging the anomalous rows around it.', '该行看起来正常，可作为周边异常条目的基线样本。'))
  }
  return hints
})
const selectedBatchOperatorNotes = computed(() => {
  const batch = selectedBatch.value
  const notes = buildImportBatchActionHints(batchItemSummary.value, tr)
  if (!batch) return notes
  const mappingKeys = batch.mapping && typeof batch.mapping === 'object' ? Object.keys(batch.mapping).length : 0
  if (mappingKeys > 0) {
    notes.push(tr(`Mapping fields: ${mappingKeys}`, `映射字段：${mappingKeys}`))
  }
  const engine = resolveImportBatchEngine(batch)
  if (engine !== '--') {
    notes.push(tr(`Engine: ${engine}`, `引擎：${engine}`))
  }
  const chunkLabel = resolveImportBatchChunkLabel(batch)
  if (chunkLabel !== '--') {
    notes.push(tr(`Chunk ${chunkLabel}`, `分块 ${chunkLabel}`))
  }
  if (batch.createdBy) {
    notes.push(tr(`Created by ${batch.createdBy}`, `创建人 ${batch.createdBy}`))
  }
  if (batch.updatedAt) {
    notes.push(tr(`Updated ${formatDateTime(batch.updatedAt)}`, `更新时间 ${formatDateTime(batch.updatedAt)}`))
  }
  if (batchItemSummary.value.missingRecordItems > 0) {
    notes.push(tr('Missing records usually point to row mapping or identity merge mismatches.', '缺少记录通常意味着行映射或身份归并不匹配。'))
  }
  if (batchItemSummary.value.warningItems > 0) {
    notes.push(tr('Warnings should be reviewed before a rollback decision.', '警告需要先复核，再决定是否回滚。'))
  }
  return notes
})
const selectedBatchRollbackEstimate = computed(() => estimateImportBatchRollbackImpact(selectedBatch.value, importBatchItems.value))
const selectedBatchRollbackNotes = computed(() => buildImportBatchRollbackNotes(selectedBatchRollbackEstimate.value, tr))
const selectedBatchMappingEntries = computed(() => {
  const mapping = selectedBatch.value?.mapping
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return []
  return Object.entries(mapping)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({
      key,
      label: key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }))
})
const selectedImportBatchSnapshotSections = computed(() => {
  const snapshot = selectedImportBatchSnapshot.value
  if (!snapshot || typeof snapshot !== 'object') return []

  const sections: Array<{ key: string; title: string; rows: Array<{ label: string; value: string }> }> = []
  const metrics = snapshot.metrics && typeof snapshot.metrics === 'object' && !Array.isArray(snapshot.metrics)
    ? snapshot.metrics as Record<string, unknown>
    : null
  const policy = snapshot.policy && typeof snapshot.policy === 'object' && !Array.isArray(snapshot.policy)
    ? snapshot.policy as Record<string, unknown>
    : null
  const engine = snapshot.engine && typeof snapshot.engine === 'object' && !Array.isArray(snapshot.engine)
    ? snapshot.engine as Record<string, unknown>
    : null

  if (metrics) {
    sections.push({
      key: 'metrics',
      title: tr('Metrics', '指标'),
      rows: Object.entries(metrics)
        .filter(([key]) => key !== 'warnings')
        .map(([key, value]) => ({
          label: key,
          value: typeof value === 'string' ? value : JSON.stringify(value),
        })),
    })
  }
  if (policy) {
    sections.push({
      key: 'policy',
      title: tr('Policy diagnostics', '规则诊断'),
      rows: Object.entries(policy).map(([key, value]) => ({
        label: key,
        value: typeof value === 'string' ? value : JSON.stringify(value),
      })),
    })
  }
  if (engine) {
    sections.push({
      key: 'engine',
      title: tr('Engine diagnostics', '引擎诊断'),
      rows: Object.entries(engine).map(([key, value]) => ({
        label: key,
        value: typeof value === 'string' ? value : JSON.stringify(value),
      })),
    })
  }

  return sections.filter((section) => section.rows.length > 0)
})

const batchRowCountTotal = computed(() => {
  return importBatches.value.reduce((total, batch) => total + (Number(batch.rowCount) || 0), 0)
})
const visibleBatchRowCountTotal = computed(() => {
  return visibleImportBatches.value.reduce((total, batch) => total + (Number(batch.rowCount) || 0), 0)
})
const batchTimeSliceLabel = computed(() => formatBatchTimeSliceLabel(batchTimeSlicePreset.value))
const batchFilterSummary = computed(() => {
  const parts: string[] = []
  if (batchStatusFilter.value !== 'all') {
    parts.push(tr(`status ${formatBatchOptionLabel(batchStatusFilter.value)}`, `状态 ${formatBatchOptionLabel(batchStatusFilter.value)}`))
  }
  if (batchEngineFilter.value !== 'all') {
    parts.push(tr(`engine ${formatBatchOptionLabel(batchEngineFilter.value)}`, `引擎 ${formatBatchOptionLabel(batchEngineFilter.value)}`))
  }
  if (batchSourceFilter.value !== 'all') {
    parts.push(tr(`source ${formatBatchOptionLabel(batchSourceFilter.value)}`, `来源 ${formatBatchOptionLabel(batchSourceFilter.value)}`))
  }
  if (batchCreatorFilter.value !== 'all') {
    parts.push(tr(`creator ${formatBatchOptionLabel(batchCreatorFilter.value)}`, `创建人 ${formatBatchOptionLabel(batchCreatorFilter.value)}`))
  }
  if (batchCreatedFrom.value || batchCreatedTo.value) {
    const from = batchCreatedFrom.value || '--'
    const to = batchCreatedTo.value || '--'
    parts.push(tr(`created ${from} to ${to}`, `创建时间 ${from} 到 ${to}`))
  }
  return parts.length > 0 ? parts.join(' · ') : tr('All batches', '全部批次')
})

function toDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shiftDate(base: Date, diffDays: number): Date {
  const next = new Date(base)
  next.setDate(next.getDate() + diffDays)
  return next
}

function formatBatchTimeSliceLabel(preset: BatchTimeSlicePreset): string {
  switch (preset) {
    case 'today':
      return tr('Today', '今天')
    case 'last7':
      return tr('Last 7 days', '近 7 天')
    case 'last30':
      return tr('Last 30 days', '近 30 天')
    case 'thisMonth':
      return tr('This month', '本月至今')
    case 'custom':
      return tr('Custom', '自定义')
    default:
      return tr('All time', '全部时间')
  }
}

function collectBatchFilterOptions(resolver: (batch: AttendanceImportBatch) => unknown): string[] {
  return Array.from(new Set(
    importBatches.value
      .map((batch) => normalizeBatchFilterValue(resolver(batch)))
      .filter((value) => value !== '--'),
  )).sort((left, right) => left.localeCompare(right))
}

function normalizeBatchFilterValue(value: unknown): string {
  const text = String(value ?? '').trim()
  return text ? text : '--'
}

function resolveBatchCreatedDate(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const matched = text.match(/^(\d{4}-\d{2}-\d{2})/)
  if (matched?.[1]) {
    return matched[1]
  }
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return ''
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${parsed.getFullYear()}-${month}-${day}`
}

function applyBatchTimeSlicePreset(preset: Exclude<BatchTimeSlicePreset, 'custom'>) {
  const now = clock()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  batchTimeSlicePreset.value = preset

  if (preset === 'all') {
    batchCreatedFrom.value = ''
    batchCreatedTo.value = ''
    return
  }

  if (preset === 'today') {
    const value = toDateInput(today)
    batchCreatedFrom.value = value
    batchCreatedTo.value = value
    return
  }

  if (preset === 'last7') {
    batchCreatedFrom.value = toDateInput(shiftDate(today, -6))
    batchCreatedTo.value = toDateInput(today)
    return
  }

  if (preset === 'last30') {
    batchCreatedFrom.value = toDateInput(shiftDate(today, -29))
    batchCreatedTo.value = toDateInput(today)
    return
  }

  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  batchCreatedFrom.value = toDateInput(monthStart)
  batchCreatedTo.value = toDateInput(today)
}

function markBatchTimeSliceCustom() {
  batchTimeSlicePreset.value = batchCreatedFrom.value || batchCreatedTo.value ? 'custom' : 'all'
}

function buildBatchInboxSearchIndex(batch: AttendanceImportBatch): string {
  return [
    batch.id,
    batch.status,
    resolveImportBatchEngine(batch),
    resolveImportBatchChunkLabel(batch),
    batch.source,
    batch.createdBy,
    batch.ruleSetId,
    batch.createdAt,
    batch.updatedAt,
  ]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ')
}

function formatImportBatchFlags(analysis: AttendanceImportBatchItemAnalysis): string {
  const flags: string[] = []
  if (!analysis.hasRecord) flags.push(tr('missing record', '缺少记录'))
  if (analysis.warnings.length > 0) flags.push(tr(`${analysis.warnings.length} warnings`, `${analysis.warnings.length} 个警告`))
  if (analysis.status && analysis.status !== 'normal') flags.push(analysis.status)
  if (analysis.lateMinutes > 0) flags.push(tr(`late ${analysis.lateMinutes}`, `迟到 ${analysis.lateMinutes}`))
  if (analysis.earlyLeaveMinutes > 0) flags.push(tr(`early ${analysis.earlyLeaveMinutes}`, `早退 ${analysis.earlyLeaveMinutes}`))
  if (analysis.leaveMinutes > 0) flags.push(tr(`leave ${analysis.leaveMinutes}`, `请假 ${analysis.leaveMinutes}`))
  if (analysis.overtimeMinutes > 0) flags.push(tr(`ot ${analysis.overtimeMinutes}`, `加班 ${analysis.overtimeMinutes}`))
  return flags.length > 0 ? flags.join(' · ') : tr('clean', '正常')
}

function formatIssueFilterLabel(filter: AttendanceImportBatchIssueFilter): string {
  switch (filter) {
    case 'all':
      return tr('All items', '全部条目')
    case 'anomalies':
      return tr('Anomalies', '异常')
    case 'missingRecord':
      return tr('Missing record', '缺少记录')
    case 'warnings':
      return tr('Warnings', '警告')
    case 'late':
      return tr('Late', '迟到')
    case 'earlyLeave':
      return tr('Early leave', '早退')
    case 'leave':
      return tr('Leave', '请假')
    case 'overtime':
      return tr('Overtime', '加班')
    case 'clean':
      return tr('Clean', '正常')
    default:
      return tr('All items', '全部条目')
  }
}

function formatSeverity(severity: AttendanceImportBatchSeverity): string {
  switch (severity) {
    case 'critical':
      return tr('Critical', '严重')
    case 'warning':
      return tr('Warning', '警告')
    case 'review':
      return tr('Needs review', '待复核')
    default:
      return tr('Clean', '正常')
  }
}

function formatBatchOptionLabel(value: string): string {
  return value === '--' ? tr('Unknown', '未知') : value
}

function resetBatchFilters() {
  batchSearchText.value = ''
  batchStatusFilter.value = 'all'
  batchEngineFilter.value = 'all'
  batchSourceFilter.value = 'all'
  batchCreatorFilter.value = 'all'
  batchCreatedFrom.value = ''
  batchCreatedTo.value = ''
  batchTimeSlicePreset.value = 'all'
}

function setIssueFilter(filter: AttendanceImportBatchIssueFilter) {
  issueFilter.value = filter
}

function isIssueFilterActive(filter: AttendanceImportBatchIssueFilter): boolean {
  return issueFilter.value === filter
}

function selectImportBatchRow(item: AttendanceImportItem) {
  selectedImportBatchItemId.value = item.id
}

async function copySelectedImportBatchSnapshot() {
  if (!selectedImportBatchSnapshot.value) return
  const payload = JSON.stringify(selectedImportBatchSnapshot.value, null, 2)
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload)
      snapshotActionMessage.value = tr('Snapshot JSON copied.', '快照 JSON 已复制。')
      return
    }
    throw new Error('clipboard-unavailable')
  } catch {
    snapshotActionMessage.value = tr('Clipboard is unavailable in this browser. Open the raw snapshot and copy it manually.', '当前浏览器无法直接写入剪贴板，请展开原始快照后手动复制。')
  } finally {
    globalThis.setTimeout(() => {
      snapshotActionMessage.value = ''
    }, 3000)
  }
}
</script>

<style scoped>
.attendance__admin-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}

.attendance__admin-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.attendance__btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  background: #fff;
  cursor: pointer;
}

.attendance__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.attendance__table-wrapper {
  width: 100%;
  overflow-x: auto;
}

.attendance__table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
}

.attendance__table th,
.attendance__table td {
  border-bottom: 1px solid #e0e0e0;
  padding: 8px;
  text-align: left;
  font-size: 13px;
}

.attendance__table-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__subheading {
  margin: 12px 0;
  font-size: 14px;
  font-weight: 600;
}

.attendance__subheading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.attendance__empty {
  color: #888;
  font-size: 13px;
  margin-top: 8px;
}

.attendance__section-meta {
  color: #666;
  font-size: 12px;
}

.attendance__impact-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin-top: 10px;
}

.attendance__batch-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin-top: 10px;
}

.attendance__mapping-panel,
.attendance__snapshot-sections {
  display: grid;
  gap: 10px;
  margin-top: 10px;
}

.attendance__impact-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid #dde4ef;
  border-radius: 10px;
  background: linear-gradient(180deg, #fbfcfe 0%, #f5f8fc 100%);
}

.attendance__impact-card span {
  color: #5d6b82;
  font-size: 12px;
}

.attendance__impact-card strong {
  color: #162235;
  font-size: 18px;
  font-weight: 700;
}

.attendance__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__field--full {
  grid-column: 1 / -1;
}

.attendance__field input {
  padding: 8px 10px;
  border: 1px solid #d7dfe9;
  border-radius: 8px;
}

.attendance__filter-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attendance__chip {
  border: 1px solid #d0d7e4;
  border-radius: 999px;
  padding: 6px 10px;
  background: #fff;
  color: #334155;
  cursor: pointer;
  font-size: 12px;
}

.attendance__chip--active {
  border-color: #2563eb;
  color: #1d4ed8;
  background: #eff6ff;
}

.attendance__chip--critical {
  border-color: #fecaca;
  color: #b42318;
  background: #fff5f5;
}

.attendance__chip--warning {
  border-color: #fcd34d;
  color: #9a6700;
  background: #fff8db;
}

.attendance__chip--review {
  border-color: #bfdbfe;
  color: #1d4ed8;
  background: #eff6ff;
}

.attendance__chip--clean {
  border-color: #bbf7d0;
  color: #166534;
  background: #f0fdf4;
}

.attendance__row--selected {
  background: #f8fbff;
}

.attendance__severity {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 84px;
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.attendance__severity--critical {
  background: #fee2e2;
  color: #b42318;
}

.attendance__severity--warning {
  background: #fef3c7;
  color: #92400e;
}

.attendance__severity--review {
  background: #dbeafe;
  color: #1d4ed8;
}

.attendance__severity--clean {
  background: #dcfce7;
  color: #166534;
}

.attendance__detail-panel {
  margin-top: 12px;
  padding: 14px;
  border: 1px solid #dbe4f0;
  border-radius: 12px;
  background: linear-gradient(180deg, #fbfdff 0%, #f6f9fd 100%);
  display: grid;
  gap: 12px;
}

.attendance__preview-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  font-size: 13px;
  color: #44546a;
}

.attendance__preview-summary strong {
  color: #162235;
}

.attendance__warning-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attendance__detail-hints {
  display: grid;
  gap: 8px;
}

.attendance__detail-hints-title {
  font-size: 12px;
  font-weight: 600;
  color: #4b5563;
}

.attendance__detail-hints-list {
  margin: 0;
  padding-left: 18px;
  color: #44546a;
  font-size: 13px;
}

.attendance__mapping-grid,
.attendance__snapshot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 10px;
}

.attendance__mapping-card,
.attendance__snapshot-card,
.attendance__snapshot-item {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid #dde4ef;
  border-radius: 10px;
  background: #fbfcfe;
}

.attendance__mapping-card span,
.attendance__snapshot-item span {
  color: #5d6b82;
  font-size: 12px;
}

.attendance__mapping-card strong,
.attendance__snapshot-item strong {
  color: #162235;
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}

.attendance__warning-chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 999px;
  background: #fff1f2;
  color: #be123c;
  font-size: 12px;
}

.attendance__code {
  margin-top: 8px;
  padding: 12px;
  background: #f5f6f8;
  border-radius: 8px;
  font-size: 12px;
  white-space: pre-wrap;
  color: #333;
}
</style>
