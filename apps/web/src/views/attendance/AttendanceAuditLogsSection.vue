<template>
  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Audit Logs', '审计日志') }}</h4>
      <div class="attendance__admin-actions">
        <button class="attendance__btn" :disabled="auditLogLoading || auditSummaryLoading" @click="reloadAuditLogs">
          {{ auditLogLoading ? tr('Loading...', '加载中...') : tr('Reload logs', '重载日志') }}
        </button>
        <button class="attendance__btn" :disabled="auditLogExporting" @click="exportAuditLogsCsv">
          {{ auditLogExporting ? tr('Exporting...', '导出中...') : tr('Export CSV', '导出 CSV') }}
        </button>
      </div>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field attendance__field--full" for="attendance-audit-search">
        <span>{{ tr('Search (action/actor/resource/route)', '搜索（动作/操作人/资源/路由）') }}</span>
        <input
          id="attendance-audit-search"
          v-model="auditLogQuery"
          type="text"
          :placeholder="tr('commit, export.csv, userId...', 'commit, export.csv, userId...')"
          @keydown.enter.prevent="loadAuditLogs(1)"
        />
      </label>
      <label class="attendance__field" for="attendance-audit-action-prefix">
        <span>{{ tr('Action prefix', '动作前缀') }}</span>
        <input
          id="attendance-audit-action-prefix"
          v-model="auditLogActionPrefix"
          type="text"
          :placeholder="tr('attendance_http:POST:/api/attendance-admin', 'attendance_http:POST:/api/attendance-admin')"
          @keydown.enter.prevent="loadAuditLogs(1)"
        />
      </label>
      <label class="attendance__field" for="attendance-audit-status-class">
        <span>{{ tr('Status class', '状态分类') }}</span>
        <select id="attendance-audit-status-class" v-model="auditLogStatusClass">
          <option value="">{{ tr('All', '全部') }}</option>
          <option value="2xx">2xx</option>
          <option value="3xx">3xx</option>
          <option value="4xx">4xx</option>
          <option value="5xx">5xx</option>
        </select>
      </label>
      <label class="attendance__field" for="attendance-audit-error-code">
        <span>{{ tr('Error code', '错误代码') }}</span>
        <input
          id="attendance-audit-error-code"
          v-model="auditLogErrorCode"
          type="text"
          :placeholder="tr('RATE_LIMITED', 'RATE_LIMITED')"
          @keydown.enter.prevent="loadAuditLogs(1)"
        />
      </label>
      <label class="attendance__field" for="attendance-audit-from">
        <span>{{ tr('From', '开始') }}</span>
        <input id="attendance-audit-from" v-model="auditLogFrom" type="datetime-local" />
      </label>
      <label class="attendance__field" for="attendance-audit-to">
        <span>{{ tr('To', '结束') }}</span>
        <input id="attendance-audit-to" v-model="auditLogTo" type="datetime-local" />
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn" :disabled="auditLogLoading || auditLogPage <= 1" @click="loadAuditLogs(auditLogPage - 1)">
        {{ tr('Prev', '上一页') }}
      </button>
      <button
        class="attendance__btn"
        :disabled="auditLogLoading || auditLogPage >= auditLogTotalPages"
        @click="loadAuditLogs(auditLogPage + 1)"
      >
        {{ tr('Next', '下一页') }}
      </button>
      <span v-if="auditLogTotal" class="attendance__field-hint">
        {{ tr('Page', '页码') }} {{ auditLogPage }} / {{ auditLogTotalPages }} · {{ auditLogTotal }} {{ tr('row(s)', '行') }}
      </span>
    </div>
    <div class="attendance__admin-grid">
      <div class="attendance__field attendance__field--full">
        <div class="attendance__requests-header">
          <span>{{ tr('Audit summary (last 60m)', '审计汇总（最近 60 分钟）') }}</span>
          <button class="attendance__btn" :disabled="auditSummaryLoading" @click="loadAuditSummary">
            {{ auditSummaryLoading ? tr('Loading...', '加载中...') : tr('Reload summary', '重载汇总') }}
          </button>
        </div>
        <div v-if="auditSummaryActions.length || auditSummaryErrors.length" class="attendance__table-wrapper">
          <table class="attendance__table">
            <thead>
              <tr>
                <th>{{ tr('Top actions', '高频动作') }}</th>
                <th>{{ tr('Count', '次数') }}</th>
                <th>{{ tr('Top error codes', '高频错误码') }}</th>
                <th>{{ tr('Count', '次数') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="idx in auditSummaryRowCount" :key="`audit-summary-${idx}`">
                <td>{{ auditSummaryActions[idx - 1]?.key || '--' }}</td>
                <td>{{ auditSummaryActions[idx - 1]?.total ?? '--' }}</td>
                <td>{{ auditSummaryErrors[idx - 1]?.key || '--' }}</td>
                <td>{{ auditSummaryErrors[idx - 1]?.total ?? '--' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="attendance__empty">{{ tr('No summary data.', '暂无汇总数据。') }}</div>
      </div>
    </div>
    <p
      v-if="auditLogStatusMessage"
      class="attendance__status"
      :class="{ 'attendance__status--error': auditLogStatusKind === 'error' }"
    >
      {{ auditLogStatusMessage }}
    </p>
    <div v-if="auditLogs.length === 0" class="attendance__empty">{{ tr('No audit logs.', '暂无审计日志。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Time', '时间') }}</th>
            <th>{{ tr('Actor', '操作人') }}</th>
            <th>{{ tr('Action', '动作') }}</th>
            <th>{{ tr('Route', '路由') }}</th>
            <th>{{ tr('Status', '状态') }}</th>
            <th>{{ tr('Latency', '延迟') }}</th>
            <th>{{ tr('Error', '错误') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="item in auditLogs" :key="item.id">
            <tr>
              <td>{{ formatDateTime(item.occurred_at) }}</td>
              <td><code>{{ item.actor_id ? item.actor_id.slice(0, 8) : '--' }}</code></td>
              <td>{{ item.action }}</td>
              <td><code>{{ item.route || '--' }}</code></td>
              <td>{{ item.status_code ?? '--' }}</td>
              <td>{{ item.latency_ms ?? '--' }}</td>
              <td>{{ item.meta?.error?.code || '--' }}</td>
              <td class="attendance__table-actions">
                <button class="attendance__btn" @click="toggleAuditLogMeta(item)">
                  {{ auditLogSelectedId === item.id ? tr('Hide', '隐藏') : tr('View', '查看') }}
                </button>
              </td>
            </tr>
            <tr v-if="auditLogSelectedId === item.id" class="attendance__table-row--meta">
              <td colspan="8">
                <pre class="attendance__code">{{ formatJson(item.meta) }}</pre>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Ref } from 'vue'
import type { AttendanceAdminAuditLogItem, AttendanceAdminAuditSummaryRow } from './useAttendanceAdminAuditLogs'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>
type AuditStatusKind = 'info' | 'error'

interface AttendanceAuditBindings {
  auditLogActionPrefix: Ref<string>
  auditLogErrorCode: Ref<string>
  auditLogExporting: Ref<boolean>
  auditLogFrom: Ref<string>
  auditLogLoading: Ref<boolean>
  auditLogPage: Ref<number>
  auditLogQuery: Ref<string>
  auditLogSelectedId: Ref<string>
  auditLogStatusClass: Ref<string>
  auditLogStatusKind: Ref<AuditStatusKind>
  auditLogStatusMessage: Ref<string>
  auditLogTo: Ref<string>
  auditLogTotal: Ref<number>
  auditLogTotalPages: Ref<number>
  auditLogs: Ref<AttendanceAdminAuditLogItem[]>
  auditSummaryActions: Ref<AttendanceAdminAuditSummaryRow[]>
  auditSummaryErrors: Ref<AttendanceAdminAuditSummaryRow[]>
  auditSummaryLoading: Ref<boolean>
  auditSummaryRowCount: Ref<number>
  exportAuditLogsCsv: () => MaybePromise<void>
  loadAuditLogs: (page: number) => MaybePromise<void>
  loadAuditSummary: () => MaybePromise<void>
  reloadAuditLogs: () => MaybePromise<void>
  toggleAuditLogMeta: (item: AttendanceAdminAuditLogItem) => void
}

const props = defineProps<{
  tr: Translate
  audit: AttendanceAuditBindings
  formatDateTime: (value: string | null | undefined) => string
  formatJson: (value: unknown) => string
}>()

const tr = props.tr
const audit = props.audit
const formatDateTime = props.formatDateTime
const formatJson = props.formatJson

const auditLogActionPrefix = audit.auditLogActionPrefix
const auditLogErrorCode = audit.auditLogErrorCode
const auditLogExporting = audit.auditLogExporting
const auditLogFrom = audit.auditLogFrom
const auditLogLoading = audit.auditLogLoading
const auditLogPage = audit.auditLogPage
const auditLogQuery = audit.auditLogQuery
const auditLogSelectedId = audit.auditLogSelectedId
const auditLogStatusClass = audit.auditLogStatusClass
const auditLogStatusKind = audit.auditLogStatusKind
const auditLogStatusMessage = audit.auditLogStatusMessage
const auditLogTo = audit.auditLogTo
const auditLogTotal = audit.auditLogTotal
const auditLogTotalPages = audit.auditLogTotalPages
const auditLogs = audit.auditLogs
const auditSummaryActions = audit.auditSummaryActions
const auditSummaryErrors = audit.auditSummaryErrors
const auditSummaryLoading = audit.auditSummaryLoading
const auditSummaryRowCount = audit.auditSummaryRowCount
const exportAuditLogsCsv = () => audit.exportAuditLogsCsv()
const loadAuditLogs = (page: number) => audit.loadAuditLogs(page)
const loadAuditSummary = () => audit.loadAuditSummary()
const reloadAuditLogs = () => audit.reloadAuditLogs()
const toggleAuditLogMeta = (item: AttendanceAdminAuditLogItem) => audit.toggleAuditLogMeta(item)
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

.attendance__admin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.attendance__admin-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.attendance__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #555;
}

.attendance__field input,
.attendance__field select,
.attendance__field textarea {
  padding: 6px 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  min-width: 180px;
}

.attendance__field--full {
  flex: 1;
}

.attendance__field-hint {
  color: #777;
  font-size: 11px;
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

.attendance__status {
  font-size: 12px;
  color: #2e7d32;
}

.attendance__status--error {
  color: #c62828;
}

.attendance__requests-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
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

.attendance__table-row--meta td {
  background: #fafafa;
}

.attendance__table-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
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

.attendance__empty {
  color: #888;
  font-size: 13px;
  margin-top: 8px;
}

@media (max-width: 768px) {
  .attendance__btn {
    width: 100%;
  }
}
</style>
