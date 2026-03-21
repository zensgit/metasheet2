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
      <span v-if="importBatchItems.length"> · {{ tr('Current items', '当前条目') }}: {{ importBatchItems.length }}</span>
    </div>
    <div v-if="importBatches.length === 0" class="attendance__empty">{{ tr('No import batches.', '暂无导入批次。') }}</div>
    <div v-else class="attendance__table-wrapper">
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
            <th>{{ tr('Created', '创建时间') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in importBatches" :key="batch.id">
            <td>{{ batch.id.slice(0, 8) }}</td>
            <td>{{ formatStatus(batch.status) }}</td>
            <td>{{ batch.rowCount }}</td>
            <td>{{ resolveImportBatchEngine(batch) }}</td>
            <td>{{ resolveImportBatchChunkLabel(batch) }}</td>
            <td>{{ batch.source || '--' }}</td>
            <td>{{ resolveRuleSetName(batch.ruleSetId) }}</td>
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
    </div>

    <div v-if="importBatchItems.length > 0" class="attendance__table-wrapper">
      <div class="attendance__subheading-row">
        <h5 class="attendance__subheading">{{ tr('Batch items', '批次条目') }}</h5>
        <div class="attendance__section-meta">
          {{ tr('Loaded items', '已加载条目') }}: {{ importBatchItems.length }}
        </div>
        <div class="attendance__table-actions">
          <button class="attendance__btn" :disabled="importBatchLoading" @click="exportImportBatchItemsCsv(false)">
            {{ tr('Export items CSV', '导出条目 CSV') }}
          </button>
          <button class="attendance__btn" :disabled="importBatchLoading" @click="exportImportBatchItemsCsv(true)">
            {{ tr('Export anomalies CSV', '导出异常 CSV') }}
          </button>
        </div>
      </div>
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Work date', '工作日期') }}</th>
            <th>{{ tr('User ID', '用户 ID') }}</th>
            <th>{{ tr('Record', '记录') }}</th>
            <th>{{ tr('Snapshot', '快照') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in importBatchItems" :key="item.id">
            <td>{{ item.workDate }}</td>
            <td>{{ item.userId }}</td>
            <td>{{ item.recordId || '--' }}</td>
            <td>
              <button class="attendance__btn" @click="toggleImportBatchSnapshot(item)">
                {{ importBatchSnapshot === item.previewSnapshot ? tr('Hide', '隐藏') : tr('View', '查看') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <pre v-if="importBatchSnapshot" class="attendance__code">{{ formatJson(importBatchSnapshot) }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, type Ref } from 'vue'
import {
  resolveImportBatchChunkLabel,
  resolveImportBatchEngine,
  type AttendanceImportBatch,
  type AttendanceImportItem,
} from './useAttendanceAdminImportBatches'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>

interface ImportBatchesBindings {
  importBatchLoading: Ref<boolean>
  importBatches: Ref<AttendanceImportBatch[]>
  importBatchItems: Ref<AttendanceImportItem[]>
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
}>()

const tr = props.tr
const importBatchLoading = props.workflow.importBatchLoading
const importBatches = props.workflow.importBatches
const importBatchItems = props.workflow.importBatchItems
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

const batchRowCountTotal = computed(() => {
  return importBatches.value.reduce((total, batch) => total + (Number(batch.rowCount) || 0), 0)
})
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
