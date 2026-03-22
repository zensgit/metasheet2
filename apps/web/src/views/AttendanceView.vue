<template>
  <div class="attendance">
    <div v-if="pluginLoading" class="attendance__card attendance__card--empty">
      <h3>{{ tr('Checking attendance module...', '正在检查考勤模块...') }}</h3>
      <p class="attendance__empty">{{ tr('Loading plugin status.', '正在加载插件状态。') }}</p>
    </div>
    <div v-else-if="pluginMissing" class="attendance__card attendance__card--empty">
      <h3>{{ tr('Attendance module not enabled', '考勤模块未启用') }}</h3>
      <p class="attendance__empty" v-if="pluginFailed">{{ tr('Attendance plugin failed to load. Check server logs.', '考勤插件加载失败，请检查服务端日志。') }}</p>
      <p class="attendance__empty" v-else-if="pluginErrorMessage">{{ pluginErrorMessage }}</p>
      <p class="attendance__empty" v-else>{{ tr('Enable the attendance plugin to use this page.', '启用考勤插件后可使用此页面。') }}</p>
    </div>
    <template v-else>
      <header class="attendance__header" v-if="showOverview">
        <div>
          <h2 class="attendance__title">{{ tr('Attendance', '考勤') }}</h2>
          <p class="attendance__subtitle">{{ tr('Track punches, summaries, and adjustments.', '跟踪打卡、汇总和补卡调整。') }}</p>
        </div>
        <div class="attendance__actions">
          <button class="attendance__btn attendance__btn--primary" :disabled="punching" @click="punch('check_in')">
            {{ punching ? tr('Working...', '处理中...') : tr('Check In', '上班打卡') }}
          </button>
          <button class="attendance__btn" :disabled="punching" @click="punch('check_out')">
            {{ punching ? tr('Working...', '处理中...') : tr('Check Out', '下班打卡') }}
          </button>
          <p class="attendance__punch-state" aria-live="polite">{{ currentPunchStatusText }}</p>
        </div>
      </header>

      <section class="attendance__filters" v-if="showOverview">
        <label class="attendance__field" for="attendance-from-date">
          <span>{{ tr('From', '开始') }}</span>
          <input id="attendance-from-date" name="fromDate" v-model="fromDate" type="date" />
        </label>
        <label class="attendance__field" for="attendance-to-date">
          <span>{{ tr('To', '结束') }}</span>
          <input id="attendance-to-date" name="toDate" v-model="toDate" type="date" />
        </label>
        <label class="attendance__field" for="attendance-org-id">
          <span>{{ tr('Org ID', '组织 ID') }}</span>
          <input id="attendance-org-id" name="orgId" v-model="orgId" type="text" :placeholder="tr('default', '默认')" />
        </label>
        <label class="attendance__field" for="attendance-user-id">
          <span>{{ tr('User ID (optional)', '用户 ID（可选）') }}</span>
          <input
            id="attendance-user-id"
            name="targetUserId"
            v-model="targetUserId"
            type="text"
            :placeholder="tr('Current user', '当前用户')"
          />
        </label>
        <button class="attendance__btn" :disabled="loading" @click="refreshAll">{{ tr('Refresh', '刷新') }}</button>
        <div v-if="statusMessage" class="attendance__status-block">
          <span class="attendance__status" :class="{ 'attendance__status--error': statusKind === 'error' }">
            {{ statusMessage }}
          </span>
          <span v-if="statusCode" class="attendance__field-hint attendance__field-hint--error">
            {{ tr('Code', '代码') }}: {{ statusCode }}
          </span>
          <span v-if="statusHint" class="attendance__field-hint" :class="{ 'attendance__field-hint--error': statusKind === 'error' }">
            {{ statusHint }}
          </span>
          <button
            v-if="statusActionLabel"
            class="attendance__btn attendance__btn--inline"
            type="button"
            :disabled="statusActionBusy"
            @click="runStatusAction"
          >
            {{ statusActionBusy ? tr('Working...', '处理中...') : statusActionLabel }}
          </button>
        </div>
      </section>

      <section class="attendance__grid" v-if="showOverview">
        <div class="attendance__card">
          <h3>{{ tr('Summary', '汇总') }}</h3>
          <div v-if="summary" class="attendance__summary">
            <div class="attendance__summary-item">
              <span>{{ tr('Total days', '总天数') }}</span>
              <strong>{{ summary.total_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Total minutes', '总分钟数') }}</span>
              <strong>{{ summary.total_minutes }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Late minutes', '迟到分钟') }}</span>
              <strong>{{ summary.total_late_minutes ?? 0 }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Early leave minutes', '早退分钟') }}</span>
              <strong>{{ summary.total_early_leave_minutes ?? 0 }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Leave minutes', '请假分钟') }}</span>
              <strong>{{ summary.leave_minutes ?? 0 }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Overtime minutes', '加班分钟') }}</span>
              <strong>{{ summary.overtime_minutes ?? 0 }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Normal', '正常') }}</span>
              <strong>{{ summary.normal_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Late', '迟到') }}</span>
              <strong>{{ summary.late_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Early leave', '早退') }}</span>
              <strong>{{ summary.early_leave_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Late + Early', '迟到+早退') }}</span>
              <strong>{{ summary.late_early_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Partial', '部分出勤') }}</span>
              <strong>{{ summary.partial_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Absent', '缺勤') }}</span>
              <strong>{{ summary.absent_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Adjusted', '已调整') }}</span>
              <strong>{{ summary.adjusted_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Off', '休息') }}</span>
              <strong>{{ summary.off_days }}</strong>
            </div>
          </div>
          <div v-else class="attendance__empty">{{ tr('No summary yet.', '暂无汇总数据。') }}</div>
        </div>

        <div class="attendance__card attendance__card--calendar">
          <div class="attendance__calendar-header">
            <h3>{{ tr('Calendar', '日历') }}</h3>
            <div class="attendance__calendar-nav">
              <button class="attendance__btn" @click="shiftMonth(-1)">{{ tr('Prev', '上月') }}</button>
              <span class="attendance__calendar-label">{{ calendarLabel }}</span>
              <button class="attendance__btn" @click="shiftMonth(1)">{{ tr('Next', '下月') }}</button>
            </div>
          </div>
          <div class="attendance__calendar-weekdays">
            <span v-for="day in weekDays" :key="day">{{ day }}</span>
          </div>
          <div class="attendance__calendar-grid">
            <div
              v-for="day in calendarDays"
              :key="day.key"
              class="attendance__calendar-cell"
              :class="[
                !day.isCurrentMonth ? 'attendance__calendar-cell--muted' : '',
                day.isToday ? 'attendance__calendar-cell--today' : '',
                day.status ? `attendance__calendar-cell--${day.status}` : ''
              ]"
              :title="day.tooltip"
            >
              <span class="attendance__calendar-date">{{ day.day }}</span>
              <span v-if="day.statusLabel" class="attendance__calendar-status">{{ day.statusLabel }}</span>
              <span v-else class="attendance__calendar-status attendance__calendar-status--empty">--</span>
              <span v-if="day.lunarLabel" class="attendance__calendar-lunar">{{ day.lunarLabel }}</span>
              <span v-if="day.holidayName" class="attendance__calendar-holiday">{{ day.holidayName }}</span>
            </div>
          </div>
        </div>

        <AttendanceRequestCenterSection
          :format-date="formatDate"
          :format-date-time="formatDateTime"
          :format-request-type="formatRequestType"
          :format-status="formatStatus"
          :format-warnings-short="formatWarningsShort"
          :calendar-days="calendarDays"
          :calendar-label="calendarLabel"
          :shift-month="shiftMonth"
          :week-days="weekDays"
          :request-center="requestCenterSectionBindings"
          :tr="tr"
        />
      </section>

      <section class="attendance__card" v-if="showOverview">
        <div class="attendance__records-header">
          <h3>{{ tr('Records', '记录') }}</h3>
          <div class="attendance__records-actions">
            <button class="attendance__btn" :disabled="loading" @click="loadRecords">{{ tr('Reload', '重载') }}</button>
            <button class="attendance__btn" :disabled="exporting || loading" @click="exportCsv">
              {{ exporting ? tr('Exporting...', '导出中...') : tr('Export CSV', '导出 CSV') }}
            </button>
          </div>
        </div>
        <div v-if="records.length === 0" class="attendance__empty">{{ tr('No records.', '暂无记录。') }}</div>
        <div v-else class="attendance__table-wrapper">
          <table class="attendance__table attendance__table--records">
            <thead>
              <tr>
                <th>{{ tr('Date', '日期') }}</th>
                <th>{{ tr('First in', '首次打卡') }}</th>
                <th>{{ tr('Last out', '最后打卡') }}</th>
                <th>{{ tr('Work (min)', '工时（分钟）') }}</th>
                <th>{{ tr('Late', '迟到') }}</th>
                <th>{{ tr('Early leave', '早退') }}</th>
                <th>{{ tr('Leave', '请假') }}</th>
                <th>{{ tr('Overtime', '加班') }}</th>
                <th>{{ tr('Status', '状态') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="record in records" :key="record.id">
                <td>{{ formatDate(record.work_date) }}</td>
                <td>{{ formatDateTime(record.first_in_at) }}</td>
                <td>{{ formatDateTime(record.last_out_at) }}</td>
                <td>{{ record.work_minutes }}</td>
                <td>{{ record.late_minutes }}</td>
                <td>{{ record.early_leave_minutes }}</td>
                <td>{{ formatMetaMinutes(record.meta, 'leave') }}</td>
                <td>{{ formatMetaMinutes(record.meta, 'overtime') }}</td>
                <td>{{ formatStatus(record.status) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="attendance__pagination">
          <button class="attendance__btn" :disabled="recordsPage <= 1 || loading" @click="changeRecordsPage(-1)">
            {{ tr('Prev', '上一页') }}
          </button>
          <span>{{ tr('Page', '页码') }} {{ recordsPage }} / {{ recordsTotalPages }}</span>
          <button class="attendance__btn" :disabled="recordsPage >= recordsTotalPages || loading" @click="changeRecordsPage(1)">
            {{ tr('Next', '下一页') }}
          </button>
        </div>
      </section>

      <section class="attendance__grid" v-if="showAdmin">
        <div class="attendance__card attendance__card--admin">
          <div class="attendance__admin-header">
            <h3>{{ tr('Admin Console', '管理控制台') }}</h3>
            <button class="attendance__btn" :disabled="adminLoading" @click="loadAdminData">
              {{ adminLoading ? tr('Loading...', '加载中...') : tr('Reload admin', '重载管理数据') }}
            </button>
          </div>
          <div v-if="statusMessage" class="attendance__status-block attendance__status-block--admin">
            <span class="attendance__status" :class="{ 'attendance__status--error': statusKind === 'error' }">
              {{ statusMessage }}
            </span>
            <span v-if="statusCode" class="attendance__field-hint attendance__field-hint--error">
              {{ tr('Code', '代码') }}: {{ statusCode }}
            </span>
            <span v-if="statusHint" class="attendance__field-hint" :class="{ 'attendance__field-hint--error': statusKind === 'error' }">
              {{ statusHint }}
            </span>
            <button
              v-if="statusActionLabel"
              class="attendance__btn attendance__btn--inline"
              type="button"
              :disabled="statusActionBusy"
              @click="runStatusAction"
            >
              {{ statusActionBusy ? tr('Working...', '处理中...') : statusActionLabel }}
            </button>
          </div>
          <div v-if="adminForbidden" class="attendance__empty">{{ tr('Admin permissions required to manage attendance settings.', '需要管理员权限才能管理考勤设置。') }}</div>
          <div v-else>
            <AttendanceSettingsSection :settings="settingsSectionBindings" :tr="tr" />

            <AttendanceHolidayRuleSection
              :attendance-group-options="attendanceGroupOptions"
              :config="holidayRuleSectionBindings"
              :format-date-time="formatDateTime"
              :tr="tr"
            />

            <AttendanceHolidayDataSection :format-date="formatDate" :holiday="holidayDataSectionBindings" :tr="tr" />

            <AttendanceProvisioningSection :provisioning="provisioningSectionBindings" :tr="tr" />

            <AttendanceAuditLogsSection
              :audit="auditLogsSectionBindings"
              :format-date-time="formatDateTime"
              :format-json="formatJson"
              :tr="tr"
            />

            <AttendanceRulesAndGroupsSection
              :format-date-time="formatDateTime"
              :rules="rulesAndGroupsSectionBindings"
              :tr="tr"
            />

            <AttendanceImportWorkflowSection
              :format-date-time="formatDateTime"
              :workflow="importWorkflowSectionBindings"
              :format-list="formatList"
              :format-policy-list="formatPolicyList"
              :format-status="formatStatus"
              :import-status-visible="importStatusVisible"
              :rule-sets="ruleSets"
              :run-status-action="runStatusAction"
              :status-action-busy="statusActionBusy"
              :status-action-label="statusActionLabel"
              :status-code="statusCode"
              :status-hint="statusHint"
              :status-message="statusMessage"
              :tr="tr"
            />

            <AttendanceImportBatchesSection
              :format-date-time="formatDateTime"
              :format-json="formatJson"
              :format-status="formatStatus"
              :resolve-rule-set-name="resolveRuleSetName"
              :tr="tr"
              :workflow="importBatchesSectionBindings"
            />

            <AttendancePayrollAdminSection :format-status="formatStatus" :payroll="payrollSectionBindings" :tr="tr" />

            <AttendanceLeavePoliciesSection
              :format-request-type="formatRequestType"
              :policies="leavePoliciesSectionBindings"
              :tr="tr"
            />

            <AttendanceSchedulingAdminSection :scheduling="schedulingSectionBindings" :tr="tr" />
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useLocale } from '../composables/useLocale'
import { usePlugins } from '../composables/usePlugins'
import { apiFetch } from '../utils/api'
import {
  formatCalendarMonthLabel,
  formatLunarDayLabel,
  normalizeDateKey,
  toDateInput,
  toDateKey,
} from './attendanceCalendarUtils'
import { useAttendanceAdminAuditLogs } from './attendance/useAttendanceAdminAuditLogs'
import AttendanceAuditLogsSection from './attendance/AttendanceAuditLogsSection.vue'
import AttendanceHolidayDataSection from './attendance/AttendanceHolidayDataSection.vue'
import AttendanceHolidayRuleSection from './attendance/AttendanceHolidayRuleSection.vue'
import AttendanceProvisioningSection from './attendance/AttendanceProvisioningSection.vue'
import AttendanceRequestCenterSection from './attendance/AttendanceRequestCenterSection.vue'
import AttendanceSettingsSection from './attendance/AttendanceSettingsSection.vue'
import AttendanceImportBatchesSection from './attendance/AttendanceImportBatchesSection.vue'
import { useAttendanceAdminConfig } from './attendance/useAttendanceAdminConfig'
import AttendanceImportWorkflowSection from './attendance/AttendanceImportWorkflowSection.vue'
import { useAttendanceAdminImportBatches } from './attendance/useAttendanceAdminImportBatches'
import { useAttendanceAdminImportWorkflow } from './attendance/useAttendanceAdminImportWorkflow'
import AttendanceLeavePoliciesSection from './attendance/AttendanceLeavePoliciesSection.vue'
import { useAttendanceAdminLeavePolicies } from './attendance/useAttendanceAdminLeavePolicies'
import AttendancePayrollAdminSection from './attendance/AttendancePayrollAdminSection.vue'
import { useAttendanceAdminPayroll } from './attendance/useAttendanceAdminPayroll'
import { useAttendanceAdminProvisioning } from './attendance/useAttendanceAdminProvisioning'
import AttendanceRulesAndGroupsSection from './attendance/AttendanceRulesAndGroupsSection.vue'
import { useAttendanceAdminRulesAndGroups } from './attendance/useAttendanceAdminRulesAndGroups'
import AttendanceSchedulingAdminSection from './attendance/AttendanceSchedulingAdminSection.vue'
import { type AttendanceHoliday, useAttendanceAdminScheduling } from './attendance/useAttendanceAdminScheduling'

type AttendancePageMode = 'overview' | 'admin'
type AttendanceStatusAction =
  | 'refresh-overview'
  | 'reload-admin'
  | 'reload-import-job'
  | 'resume-import-job'
  | 'reload-import-csv'
  | 'retry-save-settings'
  | 'retry-sync-holidays'
  | 'retry-save-rule'
  | 'retry-preview-import'
  | 'retry-run-import'
  | 'retry-submit-request'
  | 'reload-requests'
type AttendanceStatusContext =
  | 'refresh'
  | 'admin'
  | 'save-settings'
  | 'sync-holidays'
  | 'save-rule'
  | 'import-preview'
  | 'import-run'
  | 'request-submit'
  | 'request-resolve'
  | 'request-cancel'

interface AttendanceStatusMeta {
  code?: string
  hint?: string
  action?: AttendanceStatusAction
  context?: AttendanceStatusContext
  sticky?: boolean
}

const props = withDefaults(
  defineProps<{
    mode?: AttendancePageMode
  }>(),
  {
    mode: 'overview',
  }
)

const { locale, isZh } = useLocale()
const tr = (en: string, zh: string): string => (isZh.value ? zh : en)

interface AttendanceSummary {
  total_days: number
  total_minutes: number
  total_late_minutes?: number
  total_early_leave_minutes?: number
  normal_days: number
  late_days: number
  early_leave_days: number
  late_early_days: number
  partial_days: number
  absent_days: number
  adjusted_days: number
  off_days: number
  leave_minutes?: number
  overtime_minutes?: number
}

interface AttendanceRecord {
  id: string
  work_date: string
  first_in_at: string | null
  last_out_at: string | null
  work_minutes: number
  late_minutes: number
  early_leave_minutes: number
  status: string
  is_workday?: boolean
  workday_context?: AttendanceWorkdayContext | null
  meta?: Record<string, any>
}

interface AttendanceAnomaly {
  recordId: string
  workDate: string
  status: string
  isWorkday?: boolean
  firstInAt: string | null
  lastOutAt: string | null
  workMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  leaveMinutes?: number
  overtimeMinutes?: number
  warnings: string[]
  workdayContext?: AttendanceWorkdayContext | null
  state: 'open' | 'pending'
  request?: {
    id: string
    status: string
    requestType: string
  } | null
  suggestedRequestType: string | null
}

interface AttendanceRequest {
  id: string
  work_date: string
  request_type: string
  requested_in_at: string | null
  requested_out_at: string | null
  status: string
  metadata?: Record<string, any>
}

interface AttendanceRequestReportItem {
  requestType: string
  status: string
  total: number
  minutes: number
}

interface AttendanceImportPreviewItem {
  userId: string
  workDate: string
  workMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  status: string
  leaveMinutes?: number
  overtimeMinutes?: number
  isWorkday?: boolean
  warnings?: string[]
  appliedPolicies?: string[]
  userGroups?: string[]
}

interface AttendanceWorkdayContext {
  storedIsWorkday: boolean
  resolvedIsWorkday: boolean
  matchesStored: boolean
  source: 'rule' | 'shift' | 'rotation'
  sourceName?: string | null
  weekday?: number
  workingDays?: number[]
  holiday?: {
    id?: string | null
    name?: string | null
    isWorkingDay?: boolean
    type?: string | null
  } | null
}

interface CalendarDay {
  key: string
  day: number
  isToday: boolean
  isCurrentMonth: boolean
  status?: string
  statusLabel?: string
  tooltip: string
  holidayName?: string
  lunarLabel?: string
}

interface AttendanceApiError extends Error {
  code?: string
  status?: number
}

const loading = ref(false)
const punching = ref(false)
const requestSubmitting = ref(false)
const summary = ref<AttendanceSummary | null>(null)
const records = ref<AttendanceRecord[]>([])
const latestPunchRecord = ref<AttendanceRecord | null>(null)
const requests = ref<AttendanceRequest[]>([])
const anomalies = ref<AttendanceAnomaly[]>([])
const anomaliesLoading = ref(false)
const statusMessage = ref('')
const statusKind = ref<'info' | 'error'>('info')
const statusMeta = ref<AttendanceStatusMeta | null>(null)
const calendarMonth = ref(new Date())
const pluginsLoaded = ref(false)
const exporting = ref(false)
const adminLoading = ref(false)
const reportLoading = ref(false)
const adminForbidden = ref(false)
const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const ATTENDANCE_ADMIN_REQUEST_TIMEOUT_MS = 45 * 1000
const {
  addHolidayOverride,
  holidaySyncLastRun,
  holidaySyncLoading,
  loadRule,
  loadSettings,
  removeHolidayOverride,
  ruleForm,
  ruleLoading,
  saveRule,
  saveSettings,
  settingsForm,
  settingsLoading,
  syncHolidays,
  syncHolidaysForYears,
} = useAttendanceAdminConfig({
  adminForbidden,
  apiFetchWithTimeout: (path, options) => apiFetchWithTimeout(path, options, ATTENDANCE_ADMIN_REQUEST_TIMEOUT_MS),
  buildQuery,
  createApiError,
  createForbiddenError,
  defaultTimezone,
  getOrgId: normalizedOrgId,
  setStatus,
  setStatusFromError,
  tr,
})
const {
  clearProvisionBatch,
  grantProvisioningRole,
  grantProvisioningRoleBatch,
  loadProvisionRoleTemplates,
  loadProvisioningUser,
  previewProvisionBatchUsers,
  provisionBatchAffectedIds,
  provisionBatchIds,
  provisionBatchInvalidIds,
  provisionBatchLoading,
  provisionBatchPreviewHasResult,
  provisionBatchPreviewInactiveIds,
  provisionBatchPreviewItems,
  provisionBatchPreviewLoading,
  provisionBatchPreviewMissingIds,
  provisionBatchPreviewRequested,
  provisionBatchRole,
  provisionBatchStatusKind,
  provisionBatchStatusMessage,
  provisionBatchUnchangedIds,
  provisionBatchUserIdsText,
  provisionForm,
  provisionHasLoaded,
  provisionLoading,
  provisionPermissions,
  provisionRoles,
  provisionSearchHasNext,
  provisionSearchHasSearched,
  provisionSearchLoading,
  provisionSearchPage,
  provisionSearchQuery,
  provisionSearchResults,
  provisionSearchTotal,
  provisionStatusKind,
  provisionStatusMessage,
  provisionUserIsAdmin,
  provisionUserProfile,
  revokeProvisioningRole,
  revokeProvisioningRoleBatch,
  searchProvisionUsers,
  selectProvisionUser,
  addProvisionUserToBatch,
  syncProvisionUserId,
} = useAttendanceAdminProvisioning({ adminForbidden, tr })
const {
  auditLogActionPrefix,
  auditLogErrorCode,
  auditLogExporting,
  auditLogFrom,
  auditLogLoading,
  auditLogPage,
  auditLogQuery,
  auditLogSelectedId,
  auditLogStatusClass,
  auditLogStatusKind,
  auditLogStatusMessage,
  auditLogTo,
  auditLogTotal,
  auditLogTotalPages,
  auditLogs,
  auditSummaryActions,
  auditSummaryErrors,
  auditSummaryLoading,
  auditSummaryRowCount,
  exportAuditLogsCsv,
  loadAuditLogs,
  loadAuditSummary,
  reloadAuditLogs,
  toggleAuditLogMeta,
} = useAttendanceAdminAuditLogs({
  adminForbidden,
  downloadCsv: downloadCsvText,
  tr,
})
const {
  exportImportBatchItemsCsv,
  importBatchImpactLoading,
  importBatchImpactReport,
  importBatchItems,
  importBatchSelectedId,
  importBatchSnapshot,
  importBatches,
  importLoading: importBatchLoading,
  loadFullImportBatchImpact,
  loadImportBatchItems,
  loadImportBatches,
  rollbackImportBatch,
  toggleImportBatchSnapshot,
} = useAttendanceAdminImportBatches({
  adminForbidden,
  confirm: (message) => window.confirm(message),
  downloadCsv: downloadCsvText,
  setStatus,
  tr,
})
const {
  deletePayrollCycle,
  deletePayrollTemplate,
  editPayrollCycle,
  editPayrollTemplate,
  exportPayrollCycleSummary,
  generatePayrollCycles,
  loadPayrollCycleSummary,
  loadPayrollCycles,
  loadPayrollTemplates,
  payrollCycleEditingId,
  payrollCycleForm,
  payrollCycleGenerateForm,
  payrollCycleGenerateResult,
  payrollCycleGenerating,
  payrollCycleLoading,
  payrollCycleSaving,
  payrollCycleSummary,
  payrollCycles,
  payrollTemplateEditingId,
  payrollTemplateForm,
  payrollTemplateLoading,
  payrollTemplateName,
  payrollTemplateSaving,
  payrollTemplates,
  resetPayrollCycleForm,
  resetPayrollCycleGenerateForm,
  resetPayrollTemplateForm,
  savePayrollCycle,
  savePayrollTemplate,
} = useAttendanceAdminPayroll({
  adminForbidden,
  apiFetch,
  confirm: (message) => window.confirm(message),
  defaultTimezone,
  getOrgId: normalizedOrgId,
  getUserId: normalizedUserId,
  setStatus,
  todayDate: toDateInput(new Date()),
  tr,
})
const {
  addAttendanceGroupMembers,
  attendanceGroupEditingId,
  attendanceGroupForm,
  attendanceGroupLoading,
  attendanceGroupMemberGroupId,
  attendanceGroupMemberLoading,
  attendanceGroupMemberSaving,
  attendanceGroupMemberUserIds,
  attendanceGroupMembers,
  attendanceGroupSaving,
  attendanceGroups,
  copySystemTemplates,
  deleteAttendanceGroup,
  deleteRuleSet,
  editAttendanceGroup,
  editRuleSet,
  loadAttendanceGroupMembers,
  loadAttendanceGroups,
  loadRuleSetTemplate,
  loadRuleSets,
  loadRuleTemplates,
  removeAttendanceGroupMember,
  resetAttendanceGroupForm,
  resetRuleSetForm,
  closeRuleTemplateVersionView,
  resolveRuleSetName,
  restoreRuleTemplates,
  openRuleTemplateVersion,
  ruleSetEditingId,
  ruleSetForm,
  ruleSetLoading,
  ruleSetSaving,
  ruleSets,
  ruleTemplateLibraryText,
  ruleTemplateLoading,
  ruleTemplateRestoring,
  ruleTemplateSaving,
  ruleTemplateSystemText,
  ruleTemplateVersionLoading,
  ruleTemplateVersions,
  selectedRuleTemplateVersion,
  saveAttendanceGroup,
  saveRuleSet,
  saveRuleTemplates,
} = useAttendanceAdminRulesAndGroups({
  adminForbidden,
  confirm: (message) => window.confirm(message),
  defaultTimezone,
  getOrgId: normalizedOrgId,
  setStatus,
  tr,
})

const requestReport = ref<AttendanceRequestReportItem[]>([])
const attendanceGroupOptions = computed(() =>
  attendanceGroups.value.map(group => group.name).filter(name => Boolean(name))
)

const orgId = ref('')
const targetUserId = ref('')

const { plugins, fetchPlugins, loading: pluginsLoading, error: pluginsError } = usePlugins()
const attendancePluginNames = new Set(['plugin-attendance', '@metasheet/plugin-attendance'])
const attendancePluginEntry = computed(() => {
  return plugins.value.find(plugin => attendancePluginNames.has(plugin.name)) ?? null
})
const attendancePluginActive = computed(() => attendancePluginEntry.value?.status === 'active')
const pluginFailed = computed(() => pluginsLoaded.value && attendancePluginEntry.value?.status === 'failed')
const pluginLoading = computed(() => !pluginsLoaded.value || pluginsLoading.value)
const pluginMissing = computed(() => pluginsLoaded.value && !attendancePluginActive.value)
const pluginErrorMessage = computed(() => pluginsError.value)

const showAdmin = computed(() => props.mode === 'admin')
const showOverview = computed(() => props.mode === 'overview')
const statusCode = computed(() => statusMeta.value?.code || '')
const statusHint = computed(() => statusMeta.value?.hint || '')
const importStatusVisible = computed(() => {
  const context = statusMeta.value?.context
  return Boolean(
    statusKind.value === 'error'
    && statusMessage.value
    && (context === 'import-preview' || context === 'import-run')
  )
})
const canResumeImportJobFromStatus = computed(() => {
  const action = statusMeta.value?.action
  if (action !== 'retry-run-import') return false
  const status = String(importAsyncJob.value?.status || '').trim().toLowerCase()
  return status === 'queued' || status === 'running'
})

const statusActionLabel = computed(() => {
  const action = statusMeta.value?.action
  if (!action) return ''
  if (action === 'refresh-overview') return tr('Retry refresh', '重试刷新')
  if (action === 'reload-admin') return tr('Reload admin', '重载管理数据')
  if (action === 'reload-import-job') return tr('Reload import job', '重载导入任务')
  if (action === 'resume-import-job') return tr('Resume import job', '恢复导入任务')
  if (action === 'reload-import-csv') return tr('Re-apply CSV', '重新应用 CSV')
  if (action === 'retry-save-settings') return tr('Retry save settings', '重试保存设置')
  if (action === 'retry-sync-holidays') return tr('Retry holiday sync', '重试节假日同步')
  if (action === 'retry-save-rule') return tr('Retry save rule', '重试保存规则')
  if (action === 'retry-preview-import') return tr('Retry preview', '重试预览')
  if (action === 'retry-run-import' && canResumeImportJobFromStatus.value) return tr('Resume import job', '恢复导入任务')
  if (action === 'retry-run-import') return tr('Retry import', '重试导入')
  if (action === 'retry-submit-request') return tr('Retry submit request', '重试提交申请')
  if (action === 'reload-requests') return tr('Reload requests', '重载申请')
  return ''
})

const statusActionBusy = computed(() => {
  const action = statusMeta.value?.action
  if (!action) return false
  if (action === 'refresh-overview') return loading.value
  if (action === 'reload-admin') return adminLoading.value
  if (action === 'reload-import-job') return importAsyncPolling.value
  if (action === 'resume-import-job') return importAsyncPolling.value
  if (action === 'reload-import-csv') return importLoading.value
  if (action === 'retry-save-settings') return settingsLoading.value
  if (action === 'retry-sync-holidays') return holidaySyncLoading.value
  if (action === 'retry-save-rule') return ruleLoading.value
  if (action === 'retry-preview-import') return importLoading.value
  if (action === 'retry-run-import') {
    return canResumeImportJobFromStatus.value ? importAsyncPolling.value : importLoading.value
  }
  if (action === 'retry-submit-request') return requestSubmitting.value
  if (action === 'reload-requests') return loading.value
  return false
})

const today = new Date()
const fromDate = ref(toDateInput(new Date(Date.now() - 1000 * 60 * 60 * 24 * 30)))
const toDate = ref(toDateInput(today))

const recordsPage = ref(1)
const recordsPageSize = 20
const recordsTotal = ref(0)
const recordsTotalPages = computed(() => Math.max(1, Math.ceil(recordsTotal.value / recordsPageSize)))

const weekDays = computed(() => (
  isZh.value
    ? ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
))
const calendarLabel = computed(() => {
  return formatCalendarMonthLabel(calendarMonth.value, {
    locale: isZh.value ? 'zh-CN' : 'en-US',
    timeZone: isZh.value ? 'Asia/Shanghai' : defaultTimezone,
  })
})

const recordMap = computed(() => {
  const map = new Map<string, AttendanceRecord>()
  records.value.forEach((record) => {
    map.set(record.work_date, record)
  })
  return map
})

const currentPunchRecord = computed(() => {
  const todayKey = toDateKey(new Date())
  return recordMap.value.get(todayKey) ?? latestPunchRecord.value
})

const currentPunchStatusText = computed(() => {
  const record = currentPunchRecord.value
  if (!record) {
    return tr('Today: no punch recorded yet.', '今日状态：尚未打卡。')
  }

  const firstIn = formatDateTime(record.first_in_at)
  const lastOut = formatDateTime(record.last_out_at)

  if (record.first_in_at && record.last_out_at) {
    return isZh.value
      ? `今日状态：已上班打卡 ${firstIn}，已下班打卡 ${lastOut}。`
      : `Today's status: checked in ${firstIn}, checked out ${lastOut}.`
  }

  if (record.first_in_at) {
    return isZh.value
      ? `今日状态：已上班打卡 ${firstIn}，待下班打卡。`
      : `Today's status: checked in ${firstIn}, awaiting check-out.`
  }

  if (record.last_out_at) {
    return isZh.value
      ? `今日状态：已记录下班打卡 ${lastOut}，缺少上班打卡。`
      : `Today's status: check-out recorded ${lastOut}; check-in is still missing.`
  }

  return isZh.value
    ? `今日状态：${formatStatus(record.status)}。`
    : `Today's status: ${formatStatus(record.status)}.`
})

const holidayMap = computed(() => {
  const map = new Map<string, AttendanceHoliday>()
  holidays.value.forEach((holiday) => {
    const key = normalizeDateKey(holiday.date)
    if (key) map.set(key, holiday)
  })
  return map
})

function formatWorkdayWeekday(weekday: number | undefined): string {
  if (!Number.isInteger(weekday) || weekday == null || weekday < 0 || weekday > 6) return tr('Unknown day', '未知星期')
  return isZh.value
    ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday]
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday]
}

function formatWorkingDaysList(days: number[] | undefined): string {
  if (!Array.isArray(days) || days.length === 0) return tr('No working days configured', '未配置工作日')
  return days
    .map((day) => formatWorkdayWeekday(day))
    .join(isZh.value ? '、' : ', ')
}

function buildWorkdayTooltipLines(context: AttendanceWorkdayContext | null | undefined): string[] {
  if (!context) return []

  const resolvedLabel = context.resolvedIsWorkday
    ? tr('Working day', '工作日')
    : tr('Rest day', '休息日')
  const sourceLabel = context.source === 'rotation'
    ? tr('Rotation', '轮班')
    : context.source === 'shift'
      ? tr('Shift', '班次')
      : tr('Default rule', '默认规则')
  const lines = [
    tr(`Workday decision: ${resolvedLabel}`, `工作日判定：${resolvedLabel}`),
    context.sourceName
      ? tr(`Source: ${sourceLabel} · ${context.sourceName}`, `来源：${sourceLabel} · ${context.sourceName}`)
      : tr(`Source: ${sourceLabel}`, `来源：${sourceLabel}`),
    tr(`Configured days: ${formatWorkingDaysList(context.workingDays)}`, `配置工作日：${formatWorkingDaysList(context.workingDays)}`),
  ]

  if (context.weekday != null) {
    lines.push(tr(`Date weekday: ${formatWorkdayWeekday(context.weekday)}`, `当天星期：${formatWorkdayWeekday(context.weekday)}`))
  }

  if (context.holiday) {
    const holidayLabel = context.holiday.isWorkingDay
      ? tr('working-day override', '调班工作日')
      : tr('holiday/rest override', '节假日/休息日覆盖')
    lines.push(
      context.holiday.name
        ? tr(`Holiday override: ${context.holiday.name} (${holidayLabel})`, `节假日覆盖：${context.holiday.name}（${holidayLabel}）`)
        : tr(`Holiday override: ${holidayLabel}`, `节假日覆盖：${holidayLabel}`)
    )
  }

  if (!context.matchesStored) {
    lines.push(
      tr(
        `Stored record differs: stored=${context.storedIsWorkday ? 'working day' : 'rest day'}`,
        `记录值不同：存量记录=${context.storedIsWorkday ? '工作日' : '休息日'}`
      )
    )
  }

  return lines
}

const calendarDays = computed<CalendarDay[]>(() => {
  const year = calendarMonth.value.getFullYear()
  const month = calendarMonth.value.getMonth()
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)
  const weekStartsOn = 1
  const startOffset = (firstDay.getDay() - weekStartsOn + 7) % 7
  const totalCells = Math.ceil((lastDay.getDate() + startOffset) / 7) * 7
  const now = new Date()

  return Array.from({ length: totalCells }, (_, index) => {
    const date = new Date(year, month, index - startOffset + 1)
    const key = toDateKey(date)
    const record = recordMap.value.get(key)
    const holiday = holidayMap.value.get(key)
    let status = record?.status
    let statusLabel = status ? formatStatus(status) : undefined
    const holidayName = typeof holiday?.name === 'string' && holiday.name.trim().length > 0
      ? holiday.name.trim()
      : undefined
    const lunarLabel = formatLunarDayLabel(date, {
      enabled: isZh.value,
      timeZone: 'Asia/Shanghai',
    })
    let tooltip = record
      ? `${key} · ${statusLabel} · ${record.work_minutes} min`
      : key
    if (!record && holiday && holiday.isWorkingDay === false) {
      status = 'off'
      statusLabel = tr('Holiday', '休息日')
      tooltip = holidayName ? `${key} · ${holidayName}` : `${key} · ${tr('Holiday', '休息日')}`
    } else if (record && status === 'off' && holidayName) {
      tooltip = `${key} · ${holidayName} · ${record.work_minutes} min`
    }
    const workdayTooltipLines = buildWorkdayTooltipLines(record?.workday_context)
    if (workdayTooltipLines.length > 0) {
      tooltip = `${tooltip}\n${workdayTooltipLines.join('\n')}`
    }
    return {
      key,
      day: date.getDate(),
      isToday: date.toDateString() === now.toDateString(),
      isCurrentMonth: date.getMonth() === month,
      status,
      statusLabel,
      tooltip,
      holidayName,
      lunarLabel,
    }
  })
})

const requestForm = reactive({
  workDate: toDateInput(today),
  requestType: 'missed_check_in',
  requestedInAt: '',
  requestedOutAt: '',
  reason: '',
  leaveTypeId: '',
  overtimeRuleId: '',
  minutes: '',
  attachmentUrl: '',
})
const {
  approvalFlowEditingId,
  approvalFlowForm,
  approvalFlowLoading,
  approvalFlowSaving,
  approvalFlows,
  deleteApprovalFlow,
  deleteLeaveType,
  deleteOvertimeRule,
  editApprovalFlow,
  editLeaveType,
  editOvertimeRule,
  leaveTypeEditingId,
  leaveTypeForm,
  leaveTypeLoading,
  leaveTypeSaving,
  leaveTypes,
  loadApprovalFlows,
  loadLeaveTypes,
  loadOvertimeRules,
  overtimeRuleEditingId,
  overtimeRuleForm,
  overtimeRuleLoading,
  overtimeRuleSaving,
  overtimeRules,
  resetApprovalFlowForm,
  resetLeaveTypeForm,
  resetOvertimeRuleForm,
  saveApprovalFlow,
  saveLeaveType,
  saveOvertimeRule,
} = useAttendanceAdminLeavePolicies({
  adminForbidden,
  apiFetch,
  getOrgId: normalizedOrgId,
  requestForm,
  setStatus,
  setStatusFromError,
  tr,
})
const {
  assignmentEditingId,
  assignmentForm,
  assignmentLoading,
  assignments,
  assignmentSaving,
  deleteAssignment,
  deleteHoliday,
  deleteRotationAssignment,
  deleteRotationRule,
  deleteShift,
  editAssignment,
  editHoliday,
  editRotationAssignment,
  editRotationRule,
  editShift,
  holidayRange,
  holidayEditingId,
  holidayForm,
  holidayLoading,
  holidayTotal,
  holidays,
  holidaySaving,
  loadAssignments,
  loadHolidays,
  loadRotationAssignments,
  loadRotationRules,
  loadShifts,
  resetAssignmentForm,
  resetHolidayForm,
  resetRotationAssignmentForm,
  resetRotationRuleForm,
  resetShiftForm,
  rotationAssignmentEditingId,
  rotationAssignmentForm,
  rotationAssignmentLoading,
  rotationAssignments,
  rotationAssignmentSaving,
  rotationRuleEditingId,
  rotationRuleForm,
  rotationRuleLoading,
  rotationRules,
  rotationRuleSaving,
  saveAssignment,
  saveHoliday,
  saveRotationAssignment,
  saveRotationRule,
  saveShift,
  shiftEditingId,
  shiftForm,
  shiftLoading,
  shifts,
  shiftSaving,
} = useAttendanceAdminScheduling({
  adminForbidden,
  apiFetch,
  confirm: (message) => window.confirm(message),
  defaultTimezone,
  getDateRange: () => ({ from: fromDate.value, to: toDate.value }),
  getOrgId: normalizedOrgId,
  setStatus,
  tr,
})
const {
  applyImportCsvFile,
  applyImportProfile,
  clearImportAsyncJob,
  clearImportPreviewTask,
  handleImportCsvChange,
  handleImportUserMapChange,
  importAsyncJob,
  importAsyncJobTelemetryText,
  importAsyncPolling,
  importCsvDelimiter,
  importCsvFileName,
  importCsvFileId,
  importCsvFileRowCountHint,
  importCsvFileExpiresAt,
  importCsvHeaderRow,
  importCsvWarnings,
  importCommitLane,
  importCommitLaneHint,
  importForm,
  importGroupAutoAssign,
  importGroupAutoCreate,
  importGroupRuleSetId,
  importGroupTimezone,
  importLoading,
  importMappingProfiles,
  importMode,
  importPayloadRowCountHint,
  importPreview,
  importPreviewLane,
  importPreviewLaneHint,
  importPreviewTask,
  importProfileId,
  importScalabilityHint,
  importTemplateGuide,
  importUserMapCount,
  importUserMapError,
  importUserMapFileName,
  importUserMapKeyField,
  importUserMapSourceFields,
  loadImportTemplate,
  downloadImportTemplateCsv,
  previewImport,
  refreshImportAsyncJob,
  resumeImportAsyncJobPolling,
  runImport,
  selectedImportProfile,
  selectedImportProfileGuide,
} = useAttendanceAdminImportWorkflow({
  adminForbidden,
  apiFetch,
  defaultTimezone,
  getOrgId: normalizedOrgId,
  getUserId: normalizedUserId,
  loadImportBatches: options => loadImportBatches(options),
  loadRecords,
  setStatus,
  setStatusFromError,
  tr,
})
const importWorkflowSectionBindings = {
  applyImportCsvFile,
  applyImportProfile,
  clearImportAsyncJob,
  clearImportPreviewTask,
  handleImportCsvChange,
  handleImportUserMapChange,
  importAsyncJob,
  importAsyncJobTelemetryText,
  importAsyncPolling,
  importCsvDelimiter,
  importCsvFileName,
  importCsvFileId,
  importCsvFileRowCountHint,
  importCsvFileExpiresAt,
  importCsvHeaderRow,
  importCsvWarnings,
  importCommitLane,
  importCommitLaneHint,
  importForm,
  importGroupAutoAssign,
  importGroupAutoCreate,
  importGroupRuleSetId,
  importGroupTimezone,
  importLoading,
  importMappingProfiles,
  importMode,
  importPayloadRowCountHint,
  importPreview,
  importPreviewLane,
  importPreviewLaneHint,
  importPreviewTask,
  importProfileId,
  importScalabilityHint,
  importTemplateGuide,
  importUserMapCount,
  importUserMapError,
  importUserMapFileName,
  importUserMapKeyField,
  importUserMapSourceFields,
  loadImportTemplate,
  downloadImportTemplateCsv,
  previewImport,
  refreshImportAsyncJob,
  resumeImportAsyncJobPolling,
  runImport,
  selectedImportProfile,
  selectedImportProfileGuide,
}
const importBatchesSectionBindings = {
  exportImportBatchItemsCsv,
  importBatchImpactLoading,
  importBatchImpactReport,
  importBatchItems,
  importBatchLoading,
  importBatchSelectedId,
  importBatchSnapshot,
  importBatches,
  loadFullImportBatchImpact,
  loadImportBatchItems,
  reloadImportBatches: () => loadImportBatches({ orgId: normalizedOrgId() }),
  rollbackImportBatch: (batchId: string, confirmMessage?: string) => rollbackImportBatch(batchId, { orgId: normalizedOrgId(), confirmMessage }),
  toggleImportBatchSnapshot,
}
const payrollSectionBindings = {
  deletePayrollCycle,
  deletePayrollTemplate,
  editPayrollCycle,
  editPayrollTemplate,
  exportPayrollCycleSummary,
  generatePayrollCycles,
  loadPayrollCycleSummary,
  loadPayrollCycles,
  loadPayrollTemplates,
  payrollCycleEditingId,
  payrollCycleForm,
  payrollCycleGenerateForm,
  payrollCycleGenerateResult,
  payrollCycleGenerating,
  payrollCycleLoading,
  payrollCycleSaving,
  payrollCycleSummary,
  payrollCycles,
  payrollTemplateEditingId,
  payrollTemplateForm,
  payrollTemplateLoading,
  payrollTemplateName,
  payrollTemplateSaving,
  payrollTemplates,
  resetPayrollCycleForm,
  resetPayrollCycleGenerateForm,
  resetPayrollTemplateForm,
  savePayrollCycle,
  savePayrollTemplate,
}
const leavePoliciesSectionBindings = {
  approvalFlowEditingId,
  approvalFlowForm,
  approvalFlowLoading,
  approvalFlows,
  approvalFlowSaving,
  deleteApprovalFlow,
  deleteLeaveType,
  deleteOvertimeRule,
  editApprovalFlow,
  editLeaveType,
  editOvertimeRule,
  leaveTypeEditingId,
  leaveTypeForm,
  leaveTypeLoading,
  leaveTypes,
  leaveTypeSaving,
  loadApprovalFlows,
  loadLeaveTypes,
  loadOvertimeRules,
  overtimeRuleEditingId,
  overtimeRuleForm,
  overtimeRuleLoading,
  overtimeRules,
  overtimeRuleSaving,
  resetApprovalFlowForm,
  resetLeaveTypeForm,
  resetOvertimeRuleForm,
  saveApprovalFlow,
  saveLeaveType,
  saveOvertimeRule,
}
const schedulingSectionBindings = {
  assignmentEditingId,
  assignmentForm,
  assignmentLoading,
  assignments,
  assignmentSaving,
  deleteAssignment,
  deleteRotationAssignment,
  deleteRotationRule,
  deleteShift,
  editAssignment,
  editRotationAssignment,
  editRotationRule,
  editShift,
  loadAssignments,
  loadRule,
  loadRotationAssignments,
  loadRotationRules,
  loadShifts,
  resetAssignmentForm,
  resetRotationAssignmentForm,
  resetRotationRuleForm,
  resetShiftForm,
  ruleForm,
  ruleLoading,
  rotationAssignmentEditingId,
  rotationAssignmentForm,
  rotationAssignmentLoading,
  rotationAssignments,
  rotationAssignmentSaving,
  rotationRuleEditingId,
  rotationRuleForm,
  rotationRuleLoading,
  rotationRules,
  rotationRuleSaving,
  saveAssignment,
  saveRule,
  saveRotationAssignment,
  saveRotationRule,
  saveShift,
  shiftEditingId,
  shiftForm,
  shiftLoading,
  shifts,
  shiftSaving,
}
const rulesAndGroupsSectionBindings = {
  addAttendanceGroupMembers,
  attendanceGroupEditingId,
  attendanceGroupForm,
  attendanceGroupLoading,
  attendanceGroupMemberGroupId,
  attendanceGroupMemberLoading,
  attendanceGroupMemberSaving,
  attendanceGroupMemberUserIds,
  attendanceGroupMembers,
  attendanceGroupSaving,
  attendanceGroups,
  copySystemTemplates,
  deleteAttendanceGroup,
  deleteRuleSet,
  editAttendanceGroup,
  editRuleSet,
  loadAttendanceGroupMembers,
  loadAttendanceGroups,
  loadRuleSetTemplate,
  loadRuleSets,
  loadRuleTemplates,
  removeAttendanceGroupMember,
  resetAttendanceGroupForm,
  resetRuleSetForm,
  closeRuleTemplateVersionView,
  resolveRuleSetName,
  restoreRuleTemplates,
  openRuleTemplateVersion,
  ruleSetEditingId,
  ruleSetForm,
  ruleSetLoading,
  ruleSetSaving,
  ruleSets,
  ruleTemplateLibraryText,
  ruleTemplateLoading,
  ruleTemplateRestoring,
  ruleTemplateSaving,
  ruleTemplateSystemText,
  ruleTemplateVersionLoading,
  ruleTemplateVersions,
  selectedRuleTemplateVersion,
  saveAttendanceGroup,
  saveRuleSet,
  saveRuleTemplates,
}
const provisioningSectionBindings = {
  clearProvisionBatch,
  grantProvisioningRole,
  grantProvisioningRoleBatch,
  loadProvisioningUser,
  previewProvisionBatchUsers,
  provisionBatchAffectedIds,
  provisionBatchIds,
  provisionBatchInvalidIds,
  provisionBatchLoading,
  provisionBatchPreviewHasResult,
  provisionBatchPreviewInactiveIds,
  provisionBatchPreviewItems,
  provisionBatchPreviewLoading,
  provisionBatchPreviewMissingIds,
  provisionBatchPreviewRequested,
  provisionBatchRole,
  provisionBatchStatusKind,
  provisionBatchStatusMessage,
  provisionBatchUnchangedIds,
  provisionBatchUserIdsText,
  provisionForm,
  provisionHasLoaded,
  provisionLoading,
  provisionPermissions,
  provisionRoles,
  provisionSearchHasNext,
  provisionSearchHasSearched,
  provisionSearchLoading,
  provisionSearchPage,
  provisionSearchQuery,
  provisionSearchResults,
  provisionSearchTotal,
  provisionStatusKind,
  provisionStatusMessage,
  provisionUserIsAdmin,
  provisionUserProfile,
  revokeProvisioningRole,
  revokeProvisioningRoleBatch,
  addProvisionUserToBatch,
  searchProvisionUsers,
  selectProvisionUser,
  syncProvisionUserId,
}
const auditLogsSectionBindings = {
  auditLogActionPrefix,
  auditLogErrorCode,
  auditLogExporting,
  auditLogFrom,
  auditLogLoading,
  auditLogPage,
  auditLogQuery,
  auditLogSelectedId,
  auditLogStatusClass,
  auditLogStatusKind,
  auditLogStatusMessage,
  auditLogTo,
  auditLogTotal,
  auditLogTotalPages,
  auditLogs,
  auditSummaryActions,
  auditSummaryErrors,
  auditSummaryLoading,
  auditSummaryRowCount,
  exportAuditLogsCsv,
  loadAuditLogs,
  loadAuditSummary,
  reloadAuditLogs,
  toggleAuditLogMeta,
}
const settingsSectionBindings = {
  saveSettings,
  settingsForm,
  settingsLoading,
}
const holidayRuleSectionBindings = {
  addHolidayOverride,
  holidaySyncLastRun,
  holidaySyncLoading,
  removeHolidayOverride,
  saveSettings,
  settingsForm,
  settingsLoading,
  syncHolidays,
  syncHolidaysForYears,
}
const holidayDataSectionBindings = {
  deleteHoliday,
  editHoliday,
  holidayEditingId,
  holidayForm,
  holidayLoading,
  holidayRange,
  holidayTotal,
  holidays,
  holidaySaving,
  loadHolidays,
  resetHolidayForm,
  saveHoliday,
}

const isLeaveRequest = computed(() => requestForm.requestType === 'leave')
const isOvertimeRequest = computed(() => requestForm.requestType === 'overtime')
const isLeaveOrOvertimeRequest = computed(() => isLeaveRequest.value || isOvertimeRequest.value)
const requestCenterSectionBindings = {
  anomalies,
  anomaliesLoading,
  cancelRequest,
  isLeaveOrOvertimeRequest,
  isLeaveRequest,
  isOvertimeRequest,
  leaveTypes,
  loadAnomalies,
  loadRequestReport,
  loadRequests,
  loading,
  overtimeRules,
  prefillRequestFromAnomaly,
  reportLoading,
  requestForm,
  requestReport,
  requests,
  requestSubmitting,
  resolveRequest,
  focusCalendarMonth,
  shiftMonth,
  submitRequest,
}

function parseDateValue(value: string | null | undefined): Date | null {
  const key = normalizeDateKey(value)
  if (!key) return null
  const date = new Date(`${key}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString(locale.value)
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '--'
  const raw = String(value).trim()
  if (!raw) return '--'

  const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch
    const localDate = new Date(Number(year), Number(month) - 1, Number(day))
    if (!Number.isNaN(localDate.getTime())) {
      return localDate.toLocaleDateString(locale.value)
    }
  }

  const parsed = new Date(raw)
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString(locale.value)
  }

  return raw
}

function formatStatus(value: string): string {
  const raw = String(value || '').trim()
  if (!raw) return '--'
  const normalized = raw.toLowerCase()
  const map: Record<string, string> = isZh.value
    ? {
        normal: '正常',
        late: '迟到',
        early_leave: '早退',
        late_early: '迟到+早退',
        partial: '部分出勤',
        absent: '缺勤',
        adjusted: '已调整',
        off: '休息',
        pending: '待处理',
        approved: '已批准',
        rejected: '已驳回',
        cancelled: '已取消',
        canceled: '已取消',
        queued: '已排队',
        running: '运行中',
        processing: '处理中',
        completed: '已完成',
        success: '成功',
        failed: '失败',
        error: '错误',
        committed: '已提交',
        rolled_back: '已回滚',
        rollback_pending: '回滚中',
        active: '启用',
        inactive: '停用',
        enabled: '启用',
        disabled: '停用',
        open: '打开',
        closed: '关闭',
        draft: '草稿',
        submitted: '已提交',
      }
    : {
        normal: 'Normal',
        late: 'Late',
        early_leave: 'Early leave',
        late_early: 'Late + Early',
        partial: 'Partial',
        absent: 'Absent',
        adjusted: 'Adjusted',
        off: 'Off',
        pending: 'Pending',
        approved: 'Approved',
        rejected: 'Rejected',
        cancelled: 'Cancelled',
        canceled: 'Canceled',
        queued: 'Queued',
        running: 'Running',
        processing: 'Processing',
        completed: 'Completed',
        success: 'Success',
        failed: 'Failed',
        error: 'Error',
        committed: 'Committed',
        rolled_back: 'Rolled back',
        rollback_pending: 'Rollback pending',
        active: 'Active',
        inactive: 'Inactive',
        enabled: 'Enabled',
        disabled: 'Disabled',
        open: 'Open',
        closed: 'Closed',
        draft: 'Draft',
        submitted: 'Submitted',
      }
  return map[normalized] ?? raw
}

function formatList(items?: Array<string> | null): string {
  if (!items || items.length === 0) return '--'
  return items.map(item => String(item)).filter(Boolean).join(', ')
}

function formatJson(value: unknown): string {
  if (!value) return '--'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatPolicyList(item: AttendanceImportPreviewItem): string {
  const applied = Array.isArray(item.appliedPolicies) ? item.appliedPolicies : []
  const groups = Array.isArray(item.userGroups) ? item.userGroups : []
  const combined = Array.from(new Set([...applied, ...groups])).filter(Boolean)
  return formatList(combined)
}

function formatRequestType(value: string): string {
  const map: Record<string, string> = isZh.value
    ? {
        missed_check_in: '漏打上班卡',
        missed_check_out: '漏打下班卡',
        time_correction: '时间更正',
        leave: '请假申请',
        overtime: '加班申请',
      }
    : {
        missed_check_in: 'Missed check-in',
        missed_check_out: 'Missed check-out',
        time_correction: 'Time correction',
        leave: 'Leave request',
        overtime: 'Overtime request',
      }
  return map[value] ?? value
}

function formatWarningsShort(warnings: string[]): string {
  if (!warnings || warnings.length === 0) return '--'
  const head = warnings.slice(0, 2).join(', ')
  if (warnings.length > 2) return `${head} (+${warnings.length - 2})`
  return head
}

async function prefillRequestFromAnomaly(item: AttendanceAnomaly): Promise<void> {
  if (item.state === 'pending') {
    setStatus(tr('A pending request already exists for this work date.', '该工作日已存在待处理申请。'), 'error')
    return
  }
  requestForm.workDate = item.workDate
  requestForm.requestType = item.suggestedRequestType ?? 'time_correction'
  setStatus(tr('Request form updated from anomaly.', '已根据异常记录填充申请表单。'))
  await nextTick()
  document.getElementById('attendance-request-work-date')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function buildQuery(params: Record<string, string | undefined>): URLSearchParams {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value && value.length > 0) query.set(key, value)
  })
  return query
}

function normalizedOrgId(): string | undefined {
  const value = orgId.value.trim()
  return value.length > 0 ? value : undefined
}

function normalizedUserId(): string | undefined {
  const value = targetUserId.value.trim()
  return value.length > 0 ? value : undefined
}

function formatMetaMinutes(meta: Record<string, any> | undefined, key: 'leave' | 'overtime'): string {
  if (!meta) return '--'
  const leaveMinutes = Number(meta.leave_minutes ?? meta.leaveMinutes ?? 0)
  const overtimeMinutes = Number(meta.overtime_minutes ?? meta.overtimeMinutes ?? 0)
  const value = key === 'leave' ? leaveMinutes : overtimeMinutes
  return Number.isFinite(value) && value > 0 ? String(value) : '--'
}

function downloadCsvText(filename: string, csvText: string) {
  const blob = new Blob([csvText], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function defaultStatusActionForContext(context: AttendanceStatusContext): AttendanceStatusAction | undefined {
  if (context === 'refresh') return 'refresh-overview'
  if (context === 'admin') return 'reload-admin'
  if (context === 'save-settings') return 'retry-save-settings'
  if (context === 'sync-holidays') return 'retry-sync-holidays'
  if (context === 'save-rule') return 'retry-save-rule'
  if (context === 'import-preview') return 'retry-preview-import'
  if (context === 'import-run') return 'retry-run-import'
  if (context === 'request-submit') return 'retry-submit-request'
  if (context === 'request-resolve' || context === 'request-cancel') return 'reload-requests'
  return undefined
}

function normalizeErrorCode(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase()
}

function inferErrorCodeFromMessage(message: string): string {
  const text = String(message || '')
  const normalized = text.toUpperCase()
  if (!normalized) return ''
  if (normalized.includes('INVALID_CSV_FILE_ID')) return 'INVALID_CSV_FILE_ID'
  if (normalized.includes('COMMIT_TOKEN_INVALID')) return 'COMMIT_TOKEN_INVALID'
  if (normalized.includes('COMMIT_TOKEN_REQUIRED')) return 'COMMIT_TOKEN_REQUIRED'
  if (normalized.includes('PAYLOAD_TOO_LARGE')) return 'PAYLOAD_TOO_LARGE'
  if (normalized.includes('CSV_TOO_LARGE')) return 'CSV_TOO_LARGE'
  if (normalized.includes('IMPORT_JOB_NOT_FOUND') || normalized.includes('JOB_NOT_FOUND')) return 'IMPORT_JOB_NOT_FOUND'
  if (normalized.includes('REQUEST_TIMEOUT') || normalized.includes('TIMED OUT')) return 'REQUEST_TIMEOUT'
  if (normalized.includes('RATE_LIMIT')) return 'RATE_LIMITED'
  if (normalized.includes('IMPORT UPLOAD EXPIRED')) return 'EXPIRED'
  if (normalized.includes('CSVFILEID') && normalized.includes('UUID')) return 'INVALID_CSV_FILE_ID'
  if (normalized.includes('PUNCH_TOO_SOON')) return 'PUNCH_TOO_SOON'
  if (normalized.includes('BAD_GATEWAY') || normalized.includes('HTTP 502')) return 'BAD_GATEWAY'
  if (normalized.includes('GATEWAY_TIMEOUT') || normalized.includes('HTTP 504')) return 'GATEWAY_TIMEOUT'
  if (normalized.includes('SERVICE UNAVAILABLE') || normalized.includes('HTTP 503')) return 'SERVICE_UNAVAILABLE'
  if (normalized.includes('FORBIDDEN') || normalized.includes('PERMISSION')) return 'FORBIDDEN'
  if (normalized.includes('UNAUTHORIZED') || normalized.includes('TOKEN_EXPIRED')) return 'UNAUTHORIZED'
  if (normalized.includes('SERVICE_UNAVAILABLE') || normalized.includes('DB_NOT_READY')) return 'SERVICE_UNAVAILABLE'

  const codeMatch = normalized.match(/\b[A-Z][A-Z0-9_]{2,}\b/)
  if (!codeMatch) return ''
  const candidate = codeMatch[0]
  if (candidate === 'FAILED' || candidate === 'ERROR' || candidate === 'REQUEST' || candidate === 'UNKNOWN') {
    return ''
  }
  return candidate
}

function createApiError(response: { status: number }, payload: any, fallbackMessage: string): AttendanceApiError {
  const errorNode = payload?.error
  const message = typeof errorNode?.message === 'string' && errorNode.message.trim().length > 0
    ? errorNode.message.trim()
    : fallbackMessage
  const error = new Error(message) as AttendanceApiError
  error.status = Number(response?.status) || 0
  if (typeof errorNode?.code === 'string' && errorNode.code.trim().length > 0) {
    error.code = normalizeErrorCode(errorNode.code)
  }
  return error
}

function createRequestTimeoutError(timeoutMs: number): AttendanceApiError {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000))
  const error = new Error(`Request timed out after ${seconds}s`) as AttendanceApiError
  error.status = 408
  error.code = 'REQUEST_TIMEOUT'
  return error
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = String((error as any).name || '').toLowerCase()
  return name === 'aborterror'
}

async function apiFetchWithTimeout(path: string, options: RequestInit = {}, timeoutMs = ATTENDANCE_ADMIN_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const parentSignal = options.signal
  let parentAbortHandler: (() => void) | null = null
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort()
    } else {
      parentAbortHandler = () => controller.abort()
      parentSignal.addEventListener('abort', parentAbortHandler, { once: true })
    }
  }
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await apiFetch(path, {
      ...options,
      signal: controller.signal,
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw createRequestTimeoutError(timeoutMs)
    }
    throw error
  } finally {
    window.clearTimeout(timer)
    if (parentSignal && parentAbortHandler) {
      parentSignal.removeEventListener('abort', parentAbortHandler)
    }
  }
}

function createForbiddenError(message = tr('Admin permissions required', '需要管理员权限')): AttendanceApiError {
  const error = new Error(message) as AttendanceApiError
  error.status = 403
  error.code = 'FORBIDDEN'
  return error
}

function localizeRuntimeErrorMessage(rawMessage: string, fallbackMessage: string): string {
  const message = String(rawMessage || '').trim()
  if (!message) return fallbackMessage
  if (!isZh.value) return message

  const mappings: Array<[RegExp, string]> = [
    [/^failed to load anomalies\b/i, '加载异常失败'],
    [/^failed to load requests\b/i, '加载申请失败'],
    [/^failed to load request report\b/i, '加载申请报表失败'],
    [/^failed to load admin data\b/i, '加载管理数据失败'],
    [/^refresh failed\b/i, '刷新失败'],
    [/^request failed\b/i, '申请失败'],
    [/^request update failed\b/i, '申请处理失败'],
    [/^request cancel failed\b/i, '申请取消失败'],
    [/\bpunch too soon\b|\bpunch_too_soon\b/i, '打卡间隔过短，请稍后再试。'],
    [/\binvalid token\b|\btoken expired\b|session expired/i, '登录已过期或令牌无效。'],
    [/\bpermission denied\b|\bforbidden\b/i, '当前操作无权限。'],
  ]
  for (const [pattern, localized] of mappings) {
    if (pattern.test(message)) return localized
  }

  const hasChinese = /[\u4e00-\u9fff]/.test(message)
  const hasLatin = /[A-Za-z]/.test(message)
  if (hasLatin && !hasChinese) return fallbackMessage
  return message
}

function classifyStatusError(
  error: unknown,
  fallbackMessage: string,
  context: AttendanceStatusContext,
): { message: string; meta: AttendanceStatusMeta } {
  const err = error as Record<string, unknown> | null
  const originalMessage = typeof err?.message === 'string' && err.message.trim().length > 0
    ? String(err.message)
    : fallbackMessage
  const rawMessage = localizeRuntimeErrorMessage(originalMessage, fallbackMessage)
  const status = typeof err?.status === 'number' ? Number(err.status) : Number.NaN
  const explicitCode = typeof err?.code === 'string' ? normalizeErrorCode(String(err.code)) : ''
  const code = explicitCode || inferErrorCodeFromMessage(originalMessage)
  const defaultAction = defaultStatusActionForContext(context)
  const meta: AttendanceStatusMeta = {}
  let message = rawMessage
  const nestedCode = inferErrorCodeFromMessage(originalMessage)

  if (code) meta.code = code

  if (code === 'COMMIT_TOKEN_INVALID' || code === 'COMMIT_TOKEN_REQUIRED') {
    message = tr('Import token expired before request completed.', '导入令牌已过期，请重试。')
    meta.hint = tr('Click retry to refresh commit token and submit again.', '点击重试以刷新导入令牌并重新提交。')
    meta.action = context === 'import-run' ? 'retry-run-import' : 'retry-preview-import'
  } else if (
    context === 'import-preview'
    && (code === 'EXPIRED' || code === 'INVALID_CSV_FILE_ID')
  ) {
    message = code === 'EXPIRED'
      ? tr('Uploaded CSV file has expired on the server.', '上传的 CSV 文件在服务端已过期。')
      : tr('Uploaded CSV reference is invalid.', '上传的 CSV 引用无效。')
    meta.hint = tr('Click "Re-apply CSV" to upload again, then retry preview.', '点击“重新应用 CSV”重新上传后再试预览。')
    meta.action = 'reload-import-csv'
  } else if (
    context === 'import-run'
    && (code === 'EXPIRED' || code === 'INVALID_CSV_FILE_ID')
  ) {
    message = code === 'EXPIRED'
      ? tr('Uploaded CSV file has expired on the server.', '上传的 CSV 文件在服务端已过期。')
      : tr('Uploaded CSV reference is invalid.', '上传的 CSV 引用无效。')
    meta.hint = tr('Click "Re-apply CSV" to upload again, then retry import.', '点击“重新应用 CSV”重新上传后再试导入。')
    meta.action = 'reload-import-csv'
  } else if (
    (context === 'import-preview' || context === 'import-run')
    && (code === 'CSV_TOO_LARGE' || code === 'PAYLOAD_TOO_LARGE' || status === 413)
  ) {
    message = code === 'CSV_TOO_LARGE'
      ? rawMessage
      : tr('CSV upload exceeds server size limit.', 'CSV 上传超过服务端大小限制。')
    meta.hint = tr('Use a smaller file or split the CSV by date/user range, then retry.', '请缩小文件或按日期/用户拆分 CSV 后重试。')
    meta.action = 'reload-import-csv'
  } else if (code === 'IMPORT_JOB_TIMEOUT') {
    message = tr('Async import job is still running in background.', '异步导入任务仍在后台运行。')
    meta.hint = tr('Use "Resume import job" to continue polling, or open the async job card for manual controls.', '可点击“恢复导入任务”继续轮询，或在异步任务卡片中手动处理。')
    meta.action = 'resume-import-job'
  } else if (code === 'IMPORT_JOB_FAILED') {
    if (nestedCode === 'EXPIRED' || nestedCode === 'INVALID_CSV_FILE_ID') {
      message = nestedCode === 'EXPIRED'
        ? tr('Uploaded CSV file expired while async import was running.', '异步导入运行期间，上传的 CSV 已过期。')
        : tr('Uploaded CSV reference is invalid for async import.', '异步导入使用的 CSV 引用无效。')
      meta.hint = tr('Re-apply CSV and retry import.', '请重新应用 CSV 后重试导入。')
      meta.action = 'reload-import-csv'
    } else if (nestedCode === 'COMMIT_TOKEN_INVALID' || nestedCode === 'COMMIT_TOKEN_REQUIRED') {
      message = tr('Import token expired while async import was running.', '异步导入运行期间，导入令牌已过期。')
      meta.hint = tr('Retry import to request a new commit token.', '请重试导入以获取新的提交令牌。')
      meta.action = 'retry-run-import'
    } else if (nestedCode === 'CSV_TOO_LARGE' || nestedCode === 'PAYLOAD_TOO_LARGE') {
      message = nestedCode === 'CSV_TOO_LARGE'
        ? rawMessage
        : tr('CSV upload exceeds server size limit.', 'CSV 上传超过服务端大小限制。')
      meta.hint = tr('Split the CSV into smaller files, then retry import.', '请将 CSV 拆分为更小文件后重试导入。')
      meta.action = 'reload-import-csv'
    } else {
      message = rawMessage
      meta.hint = tr('Inspect job error details, then retry import.', '请先查看任务错误详情，再重试导入。')
      meta.action = 'retry-run-import'
    }
  } else if (code === 'IMPORT_JOB_CANCELED') {
    message = tr('Async import job was canceled before completion.', '异步导入任务在完成前被取消。')
    meta.hint = tr('Submit a new import when ready.', '准备好后可重新提交导入。')
    meta.action = 'retry-run-import'
  } else if (context === 'import-run' && code === 'IMPORT_JOB_NOT_FOUND') {
    message = tr('Async import job is no longer available.', '异步导入任务已不可用。')
    meta.hint = tr('Submit a new import task and continue from the latest payload.', '请重新提交导入任务，并基于最新载荷继续。')
    meta.action = 'retry-run-import'
  } else if (
    (context === 'import-run' || context === 'import-preview')
    && (status === 502 || status === 503 || status === 504 || code === 'BAD_GATEWAY' || code === 'GATEWAY_TIMEOUT')
  ) {
    message = context === 'import-run'
      ? tr('Import request hit a temporary gateway error.', '导入请求遇到临时网关错误。')
      : tr('Import preview request hit a temporary gateway error.', '导入预览请求遇到临时网关错误。')
    meta.hint = context === 'import-run'
      ? tr('Click retry. If an async job was already accepted, the flow will resume polling automatically.', '点击重试；若异步任务已被受理，流程会自动恢复轮询。')
      : tr('Click retry preview in a moment. If this persists, check gateway/backend health.', '稍后重试预览；若持续失败，请检查网关/后端健康状态。')
    meta.action = context === 'import-run' ? 'retry-run-import' : 'retry-preview-import'
  } else if (code === 'RATE_LIMITED' || status === 429) {
    message = tr('Request was rate-limited by the server.', '请求被服务端限流。')
    meta.hint = tr('Wait a few seconds before retrying to avoid repeated throttling.', '请等待几秒后再重试，避免持续触发限流。')
    meta.action = defaultAction
  } else if (code === 'REQUEST_TIMEOUT' || status === 408) {
    message = tr('Request timed out before the server responded.', '请求在服务端响应前已超时。')
    meta.hint = tr('Retry the action. If this repeats, check network/server health.', '请重试当前操作；若持续出现，请检查网络与服务健康状态。')
    meta.action = defaultAction
  } else if (code === 'PUNCH_TOO_SOON') {
    message = rawMessage
    meta.hint = tr('Minimum punch interval is enforced by policy. Retry after the interval.', '系统已启用最小打卡间隔，请稍后重试。')
    meta.action = 'refresh-overview'
  } else if (status === 401 || code === 'UNAUTHORIZED' || code === 'INVALID_TOKEN' || code === 'TOKEN_EXPIRED') {
    message = tr('Session expired or token is invalid.', '登录已过期或令牌无效。')
    meta.hint = tr('Sign in again, then retry the action.', '请重新登录后再重试。')
    meta.action = 'refresh-overview'
  } else if (code === 'DUPLICATE_REQUEST' || status === 409) {
    message = tr('An identical attendance request already exists for this date.', '同一天同类型的相同申请已存在。')
    meta.hint = tr('Refresh the request list before submitting again.', '请先刷新申请列表，确认现有申请状态后再提交。')
    meta.action = 'reload-requests'
  } else if (status === 403 || code === 'FORBIDDEN' || code === 'PERMISSION_DENIED') {
    message = rawMessage === fallbackMessage ? tr('Permission denied for this action.', '当前操作无权限。') : rawMessage
    meta.hint = tr('Use an account with required attendance permissions, then reload data.', '请使用具备所需考勤权限的账号，并重新加载数据。')
    meta.action = context === 'request-submit' || context === 'request-resolve' || context === 'request-cancel'
      ? 'reload-requests'
      : 'reload-admin'
  } else if (status >= 500 || code === 'SERVICE_UNAVAILABLE' || code === 'DB_NOT_READY') {
    if (!message) message = fallbackMessage
    meta.hint = tr('Server may be warming up or temporarily unavailable. Retry in a moment.', '服务可能正在预热或临时不可用，请稍后重试。')
    meta.action = defaultAction
  } else {
    meta.action = defaultAction
  }

  return { message, meta }
}

function setStatusFromError(error: unknown, fallbackMessage: string, context: AttendanceStatusContext) {
  const { message, meta } = classifyStatusError(error, fallbackMessage, context)
  const sticky = context === 'import-preview' || context === 'import-run'
  setStatus(message || fallbackMessage, 'error', {
    ...(meta || {}),
    context,
    sticky,
  })
}

async function runStatusAction() {
  const action = statusMeta.value?.action
  if (!action) return
  if (action === 'refresh-overview') {
    await refreshAll()
    return
  }
  if (action === 'reload-admin') {
    await loadAdminData()
    return
  }
  if (action === 'reload-import-job') {
    await refreshImportAsyncJob()
    return
  }
  if (action === 'resume-import-job') {
    await refreshImportAsyncJob({ silent: true })
    await resumeImportAsyncJobPolling()
    return
  }
  if (action === 'reload-import-csv') {
    await applyImportCsvFile()
    return
  }
  if (action === 'retry-save-settings') {
    await saveSettings()
    return
  }
  if (action === 'retry-sync-holidays') {
    await syncHolidays()
    return
  }
  if (action === 'retry-save-rule') {
    await saveRule()
    return
  }
  if (action === 'retry-preview-import') {
    await previewImport()
    return
  }
  if (action === 'retry-run-import') {
    if (canResumeImportJobFromStatus.value) {
      await refreshImportAsyncJob({ silent: true })
      await resumeImportAsyncJobPolling()
      return
    }
    await runImport()
    return
  }
  if (action === 'retry-submit-request') {
    await submitRequest()
    return
  }
  if (action === 'reload-requests') {
    await loadRequests()
  }
}

function setStatus(message: string, kind: 'info' | 'error' = 'info', meta: AttendanceStatusMeta | null = null) {
  statusKind.value = kind
  statusMeta.value = kind === 'error' ? meta : null
  if (statusMessage.value === message && message) {
    statusMessage.value = ''
    void nextTick(() => {
      statusMessage.value = message
    })
  } else {
    statusMessage.value = message
  }
  if (!message) return
  if (kind === 'error' && meta?.sticky) return
  const timeoutMs = kind === 'error'
    ? (meta?.action || meta?.hint ? 10000 : 7000)
    : 4000
  window.setTimeout(() => {
    if (statusMessage.value === message) {
      statusMessage.value = ''
      if (statusMeta.value === meta) {
        statusMeta.value = null
      }
    }
  }, timeoutMs)
}

async function punch(eventType: 'check_in' | 'check_out') {
  punching.value = true
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const payload: Record<string, string> = { eventType, timezone }
    const orgValue = normalizedOrgId()
    if (orgValue) payload.orgId = orgValue
    const response = await apiFetch('/api/attendance/punch', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || tr('Punch failed', '打卡失败'))
    }
    const record = data?.data?.record
    if (record && typeof record === 'object') {
      latestPunchRecord.value = record as AttendanceRecord
    }
    const statusText = currentPunchStatusText.value
    setStatus(
      isZh.value
        ? `${eventType === 'check_in' ? '上班打卡' : '下班打卡'}已记录。${statusText}`
        : `${eventType === 'check_in' ? 'Check in' : 'Check out'} recorded. ${statusText}`
    )
    await refreshAll()
  } catch (error: any) {
    setStatusFromError(error, tr('Punch failed', '打卡失败'), 'refresh')
  } finally {
    punching.value = false
  }
}

async function loadSummary() {
  const query = buildQuery({
    from: fromDate.value,
    to: toDate.value,
    orgId: normalizedOrgId(),
    userId: normalizedUserId(),
  })
  const response = await apiFetch(`/api/attendance/summary?${query.toString()}`)
  const data = await response.json()
  if (!response.ok || !data.ok) {
    throw new Error(data?.error?.message || tr('Failed to load summary', '加载汇总失败'))
  }
  summary.value = data.data
}

async function loadRecords() {
  const query = buildQuery({
    from: fromDate.value,
    to: toDate.value,
    page: String(recordsPage.value),
    pageSize: String(recordsPageSize),
    orgId: normalizedOrgId(),
    userId: normalizedUserId(),
  })
  const response = await apiFetch(`/api/attendance/records?${query.toString()}`)
  const data = await response.json()
  if (!response.ok || !data.ok) {
    throw new Error(data?.error?.message || tr('Failed to load records', '加载记录失败'))
  }
  records.value = data.data.items
  recordsTotal.value = data.data.total
  const todayKey = toDateKey(new Date())
  const todayRecord = Array.isArray(data.data.items)
    ? data.data.items.find((item: AttendanceRecord) => item.work_date === todayKey) ?? null
    : null
  if (todayRecord) {
    latestPunchRecord.value = todayRecord
  }
}

async function loadRequests() {
  const query = buildQuery({
    from: fromDate.value,
    to: toDate.value,
    page: '1',
    pageSize: '10',
    orgId: normalizedOrgId(),
    userId: normalizedUserId(),
  })
  const response = await apiFetch(`/api/attendance/requests?${query.toString()}`)
  const data = await response.json()
  if (!response.ok || !data.ok) {
    throw new Error(data?.error?.message || tr('Failed to load requests', '加载申请失败'))
  }
  requests.value = data.data.items
}

async function loadAnomalies() {
  anomaliesLoading.value = true
  try {
    const query = buildQuery({
      from: fromDate.value,
      to: toDate.value,
      page: '1',
      pageSize: '50',
      orgId: normalizedOrgId(),
      userId: normalizedUserId(),
    })
    const response = await apiFetch(`/api/attendance/anomalies?${query.toString()}`)
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || tr('Failed to load anomalies', '加载异常失败'))
    }
    anomalies.value = data.data?.items ?? []
  } finally {
    anomaliesLoading.value = false
  }
}

async function loadRequestReport() {
  reportLoading.value = true
  try {
    const query = buildQuery({
      from: fromDate.value,
      to: toDate.value,
      orgId: normalizedOrgId(),
      userId: normalizedUserId(),
    })
    const response = await apiFetch(`/api/attendance/reports/requests?${query.toString()}`)
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || tr('Failed to load request report', '加载申请报表失败'))
    }
    requestReport.value = data.data.items || []
  } catch (error: any) {
    setStatus(error?.message || tr('Failed to load request report', '加载申请报表失败'), 'error')
  } finally {
    reportLoading.value = false
  }
}

async function refreshAll() {
  if (!attendancePluginActive.value) return
  loading.value = true
  recordsPage.value = 1
  calendarMonth.value = new Date(`${toDate.value}T00:00:00`)
  try {
    await Promise.all([loadSummary(), loadRecords(), loadRequests(), loadAnomalies(), loadRequestReport(), loadHolidays()])
  } catch (error: any) {
    setStatusFromError(error, tr('Refresh failed', '刷新失败'), 'refresh')
  } finally {
    loading.value = false
  }
}

function shiftMonth(delta: number) {
  const next = new Date(calendarMonth.value)
  next.setMonth(next.getMonth() + delta, 1)
  const from = new Date(next.getFullYear(), next.getMonth(), 1)
  const to = new Date(next.getFullYear(), next.getMonth() + 1, 0)
  fromDate.value = toDateInput(from)
  toDate.value = toDateInput(to)
  refreshAll()
}

async function focusCalendarMonth(value: string | null | undefined) {
  const next = parseDateValue(value) ?? new Date()
  const nextMonth = new Date(next.getFullYear(), next.getMonth(), 1)
  const currentMonth = calendarMonth.value
  if (
    currentMonth.getFullYear() === nextMonth.getFullYear()
    && currentMonth.getMonth() === nextMonth.getMonth()
  ) {
    return
  }
  calendarMonth.value = nextMonth
  fromDate.value = toDateInput(new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 1))
  toDate.value = toDateInput(new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0))
  await refreshAll()
}

function validateRequestForm(): string | null {
  if (!requestForm.workDate) return tr('Work date is required', '工作日期为必填项')

  const requestType = requestForm.requestType
  const hasIn = Boolean(requestForm.requestedInAt)
  const hasOut = Boolean(requestForm.requestedOutAt)

  if (hasIn && hasOut) {
    const inTime = new Date(requestForm.requestedInAt).getTime()
    const outTime = new Date(requestForm.requestedOutAt).getTime()
    if (Number.isFinite(inTime) && Number.isFinite(outTime) && outTime <= inTime) {
      return tr('End time must be after start time', '结束时间必须晚于开始时间')
    }
  }

  if (requestType === 'missed_check_in' && !hasIn) {
    return tr('Requested in time is required', '补签上班时间为必填项')
  }
  if (requestType === 'missed_check_out' && !hasOut) {
    return tr('Requested out time is required', '补签下班时间为必填项')
  }
  if (requestType === 'time_correction' && !hasIn && !hasOut) {
    return tr('Provide requested in or out time', '请提供补签上班或下班时间')
  }

  if (requestType === 'leave') {
    if (!requestForm.leaveTypeId) return tr('Leave type is required', '请假类型为必选项')
    const leaveType = leaveTypes.value.find(item => item.id === requestForm.leaveTypeId)
    if (leaveType?.requiresAttachment && !requestForm.attachmentUrl.trim()) {
      return tr('Attachment URL required for this leave type', '该请假类型要求填写附件 URL')
    }
  }

  if (requestType === 'overtime') {
    if (!requestForm.overtimeRuleId) return tr('Overtime rule is required', '加班规则为必选项')
    const minutesValue = String(requestForm.minutes ?? '').trim()
    const minutes = minutesValue.length > 0 ? Number(minutesValue) : Number.NaN
    const hasMinutes = Number.isFinite(minutes) && minutes > 0
    const hasRange = hasIn && hasOut
    if (!hasMinutes && !hasRange) {
      return tr('Overtime duration required', '请填写加班时长')
    }
  }

  return null
}

async function submitRequest() {
  if (requestSubmitting.value) return
  requestSubmitting.value = true
  try {
    const validationMessage = validateRequestForm()
    if (validationMessage) {
      setStatus(validationMessage, 'error')
      return
    }
    const orgValue = normalizedOrgId()
    const minutesValue = String(requestForm.minutes ?? '').trim()
    const minutes = minutesValue.length > 0 ? Number(minutesValue) : undefined
    const payload = {
      workDate: requestForm.workDate,
      requestType: requestForm.requestType,
      requestedInAt: requestForm.requestedInAt || undefined,
      requestedOutAt: requestForm.requestedOutAt || undefined,
      reason: requestForm.reason || undefined,
      leaveTypeId: requestForm.leaveTypeId || undefined,
      overtimeRuleId: requestForm.overtimeRuleId || undefined,
      minutes: Number.isFinite(minutes) ? minutes : undefined,
      attachmentUrl: requestForm.attachmentUrl || undefined,
      orgId: orgValue,
    }
    const response = await apiFetch('/api/attendance/requests', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw createApiError(response, data, tr('Request failed', '申请失败'))
    }
    setStatus(tr('Request submitted.', '申请已提交。'))
    await loadRequests()
  } catch (error: any) {
    setStatusFromError(error, tr('Request failed', '申请失败'), 'request-submit')
  } finally {
    requestSubmitting.value = false
  }
}

async function resolveRequest(id: string, action: 'approve' | 'reject') {
  try {
    const response = await apiFetch(`/api/attendance/requests/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify({})
    })
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw createApiError(response, data, tr('Request update failed', '申请处理失败'))
    }
    const actionText = action === 'approve' ? tr('approved', '已批准') : tr('rejected', '已驳回')
    setStatus(tr(`Request ${action}d.`, `申请${actionText}。`))
    await loadRequests()
    await loadSummary()
    await loadRecords()
  } catch (error: any) {
    setStatusFromError(error, tr('Request update failed', '申请处理失败'), 'request-resolve')
  }
}

async function cancelRequest(id: string) {
  try {
    const response = await apiFetch(`/api/attendance/requests/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({})
    })
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw createApiError(response, data, tr('Request cancel failed', '申请取消失败'))
    }
    setStatus(tr('Request cancelled.', '申请已取消。'))
    await loadRequests()
  } catch (error: any) {
    setStatusFromError(error, tr('Request cancel failed', '申请取消失败'), 'request-cancel')
  }
}

async function changeRecordsPage(delta: number) {
  const next = recordsPage.value + delta
  if (next < 1 || next > recordsTotalPages.value) return
  recordsPage.value = next
  await loadRecords()
}

async function exportCsv() {
  exporting.value = true
  try {
    const query = buildQuery({
      from: fromDate.value,
      to: toDate.value,
      orgId: normalizedOrgId(),
      userId: normalizedUserId(),
    })
    const response = await apiFetch(`/api/attendance/export?${query.toString()}`)
    const text = await response.text()
    if (!response.ok) {
      let message = tr('Export failed', '导出失败')
      try {
        const parsed = JSON.parse(text)
        message = parsed?.error?.message || message
      } catch {
        message = text || message
      }
      throw new Error(message)
    }
    const disposition = response.headers.get('content-disposition')
    const match = disposition?.match(/filename=\"?([^\";]+)\"?/)
    const filename = match?.[1] || 'attendance-export.csv'
    const blob = new Blob([text], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setStatus(tr('Export ready.', '导出完成。'))
  } catch (error: any) {
    setStatus(error?.message || tr('Export failed', '导出失败'), 'error')
  } finally {
    exporting.value = false
  }
}

async function loadAdminData() {
  if (adminLoading.value) return
  adminLoading.value = true
  try {
    await Promise.all([
      loadSettings(),
      loadProvisionRoleTemplates(),
      loadAuditLogs(1),
      loadAuditSummary(),
      loadRule(),
      loadRuleSets(),
      loadRuleTemplates(),
      loadAttendanceGroups(),
      loadImportBatches({ orgId: normalizedOrgId() }),
      loadPayrollTemplates(),
      loadPayrollCycles(),
      loadLeaveTypes(),
      loadOvertimeRules(),
      loadApprovalFlows(),
      loadRotationRules(),
      loadShifts(),
      loadAssignments(),
      loadRotationAssignments(),
      loadHolidays(),
    ])
  } catch (error) {
    setStatusFromError(error, tr('Failed to load admin data', '加载管理数据失败'), 'admin')
  } finally {
    adminLoading.value = false
  }
}

onMounted(() => {
  fetchPlugins()
    .then(() => {
      pluginsLoaded.value = true
      if (attendancePluginActive.value) {
        refreshAll()
        loadAdminData()
      }
    })
    .catch(() => {
      pluginsLoaded.value = true
    })
})

watch(orgId, () => {
  if (attendancePluginActive.value) {
    refreshAll()
    loadAdminData()
  }
})

watch(attendanceGroupMemberGroupId, () => {
  if (attendancePluginActive.value) {
    loadAttendanceGroupMembers()
  }
})

</script>

<style scoped>
.attendance {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 24px;
  color: #2b2b2b;
}

.attendance__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.attendance__title {
  font-size: 22px;
  margin-bottom: 4px;
}

.attendance__subtitle {
  color: #666;
}

.attendance__actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.attendance__punch-state {
  width: 100%;
  margin: 0;
  color: #555;
  font-size: 12px;
}

.attendance__filters {
  display: flex;
  align-items: center;
  gap: 16px;
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

.attendance__field--checkbox {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.attendance__field--checkbox input {
  width: auto;
  min-width: auto;
}

.attendance__field-hint {
  color: #777;
  font-size: 11px;
}

.attendance__field-hint--error {
  color: #c0392b;
}

.attendance__btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  background: #fff;
  cursor: pointer;
}

.attendance__btn--primary {
  background: #1976d2;
  border-color: #1976d2;
  color: #fff;
}

.attendance__btn--danger {
  border-color: #e53935;
  color: #e53935;
}

.attendance__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.attendance__btn--inline {
  padding: 5px 10px;
  font-size: 12px;
}

.attendance__status-block {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.attendance__status-block--admin {
  margin-bottom: 12px;
}

.attendance__status {
  font-size: 12px;
  color: #2e7d32;
}

.attendance__status--error {
  color: #c62828;
}

.attendance__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 20px;
}

.attendance__card {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.04);
}

.attendance__card--empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attendance__summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.attendance__summary-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: #f7f9fb;
  border-radius: 8px;
  padding: 10px;
}

.attendance__summary-item span {
  font-size: 12px;
  color: #666;
}

.attendance__card--calendar {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.attendance__calendar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.attendance__calendar-nav {
  display: flex;
  align-items: center;
  gap: 8px;
}

.attendance__calendar-label {
  font-weight: 600;
  font-size: 14px;
  color: #333;
}

.attendance__calendar-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #777;
}

.attendance__calendar-weekdays span {
  text-align: center;
}

.attendance__calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}

.attendance__calendar-cell {
  min-height: 72px;
  border: 1px solid #e3e3e3;
  border-radius: 10px;
  padding: 8px;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.attendance__calendar-date {
  font-weight: 600;
  color: #333;
}

.attendance__calendar-status {
  font-size: 11px;
  color: #555;
}

.attendance__calendar-status--empty {
  color: #999;
}

.attendance__calendar-lunar {
  font-size: 10px;
  color: #6b7280;
  line-height: 1.2;
}

.attendance__calendar-holiday {
  margin-top: auto;
  font-size: 10px;
  color: #b45309;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-radius: 6px;
  padding: 2px 4px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.attendance__calendar-cell--muted {
  opacity: 0.45;
  background: #f2f2f2;
}

.attendance__calendar-cell--today {
  border-color: #1976d2;
  box-shadow: 0 0 0 1px rgba(25, 118, 210, 0.15);
}

.attendance__calendar-cell--normal {
  background: #e8f5e9;
  border-color: #c8e6c9;
}

.attendance__calendar-cell--late {
  background: #fff3e0;
  border-color: #ffcc80;
}

.attendance__calendar-cell--early_leave {
  background: #ede7f6;
  border-color: #d1c4e9;
}

.attendance__calendar-cell--late_early {
  background: #ffebee;
  border-color: #ef9a9a;
}

.attendance__calendar-cell--partial {
  background: #e3f2fd;
  border-color: #bbdefb;
}

.attendance__calendar-cell--absent {
  background: #f5f5f5;
  border-color: #e0e0e0;
}

.attendance__calendar-cell--adjusted {
  background: #e0f7fa;
  border-color: #b2ebf2;
}

.attendance__calendar-cell--off {
  background: #f3f4f6;
  border-color: #d6d6d6;
}

.attendance__chip-list {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attendance__table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
}

.attendance__table--records {
  min-width: 860px;
}

.attendance__table-wrapper {
  width: 100%;
  overflow-x: auto;
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

.attendance__code {
  margin-top: 8px;
  padding: 12px;
  background: #f5f6f8;
  border-radius: 8px;
  font-size: 12px;
  white-space: pre-wrap;
  color: #333;
}

.attendance__table-row--meta td {
  background: #fafafa;
}

.attendance__override-filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
}

.attendance__override-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.attendance__records-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.attendance__records-actions {
  display: flex;
  gap: 8px;
}

.attendance__pagination {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.attendance__empty {
  color: #888;
  font-size: 13px;
  margin-top: 8px;
}

.attendance__admin-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.attendance__admin-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}

.attendance__admin-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.attendance__admin-meta {
  font-size: 12px;
  color: #6b7280;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}

.attendance__admin-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.attendance__admin-subsection {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attendance__admin-subsection-header {
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

.attendance__admin-grid--compact {
  margin-top: 12px;
}

.attendance__details {
  margin-top: 12px;
  padding: 12px;
  border-radius: 12px;
  border: 1px dashed #d1d5db;
  background: #fafafa;
}

.attendance__details[open] {
  background: #fff;
}

.attendance__details-summary {
  cursor: pointer;
  font-weight: 600;
  color: #111827;
}

@media (max-width: 768px) {
  .attendance {
    padding: 16px;
  }

  .attendance__header {
    flex-direction: column;
    align-items: flex-start;
  }

  .attendance__actions {
    width: 100%;
  }

  .attendance__btn {
    width: 100%;
  }

  .attendance__calendar-cell {
    min-height: 60px;
    padding: 6px;
  }

}
</style>
