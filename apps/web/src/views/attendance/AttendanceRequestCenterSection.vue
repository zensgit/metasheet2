<template>
  <div class="attendance__card">
    <h3>{{ tr('Adjustment Request', '补卡申请') }}</h3>
    <div class="attendance__request-form">
      <label class="attendance__field" for="attendance-request-work-date">
        <span>{{ tr('Work date', '工作日期') }}</span>
        <AttendanceScheduledDateInput
          v-model="requestForm.workDate"
          default-time="00:00"
          field-id="attendance-request-work-date"
          field-name="requestWorkDate"
          input-type="date"
          :calendar-days="calendarDays"
          :calendar-label="calendarLabel"
          :focus-calendar-month="focusCalendarMonth"
          :shift-month="shiftMonth"
          :tr="tr"
          :week-days="weekDays"
        />
      </label>
      <label class="attendance__field" for="attendance-request-type">
        <span>{{ tr('Type', '类型') }}</span>
        <select id="attendance-request-type" v-model="requestForm.requestType" name="requestType">
          <option value="missed_check_in">{{ tr('Missed check-in', '漏打上班卡') }}</option>
          <option value="missed_check_out">{{ tr('Missed check-out', '漏打下班卡') }}</option>
          <option value="time_correction">{{ tr('Time correction', '时间更正') }}</option>
          <option value="leave">{{ tr('Leave', '请假') }}</option>
          <option value="overtime">{{ tr('Overtime', '加班') }}</option>
        </select>
      </label>
      <label v-if="isLeaveRequest" class="attendance__field" for="attendance-request-leave-type">
        <span>{{ tr('Leave type', '请假类型') }}</span>
        <select
          id="attendance-request-leave-type"
          v-model="requestForm.leaveTypeId"
          name="requestLeaveType"
          :disabled="leaveTypes.length === 0"
        >
          <option value="" disabled>{{ tr('Select leave type', '选择请假类型') }}</option>
          <option v-for="item in leaveTypes" :key="item.id" :value="item.id">
            {{ formatLeaveTypeLabel(item) }}
          </option>
        </select>
      </label>
      <label v-if="isOvertimeRequest" class="attendance__field" for="attendance-request-overtime-rule">
        <span>{{ tr('Overtime rule', '加班规则') }}</span>
        <select
          id="attendance-request-overtime-rule"
          v-model="requestForm.overtimeRuleId"
          name="requestOvertimeRule"
          :disabled="overtimeRules.length === 0"
        >
          <option value="" disabled>{{ tr('Select rule', '选择规则') }}</option>
          <option v-for="rule in overtimeRules" :key="rule.id" :value="rule.id">
            {{ rule.name }}
          </option>
        </select>
      </label>
      <label class="attendance__field" for="attendance-request-in">
        <span>{{ isLeaveOrOvertimeRequest ? tr('Start', '开始') : tr('Requested in', '申请打卡入') }}</span>
        <AttendanceScheduledDateInput
          v-model="requestForm.requestedInAt"
          default-time="09:00"
          field-id="attendance-request-in"
          field-name="requestedInAt"
          input-type="datetime-local"
          :calendar-days="calendarDays"
          :calendar-label="calendarLabel"
          :focus-calendar-month="focusCalendarMonth"
          :shift-month="shiftMonth"
          :tr="tr"
          :week-days="weekDays"
        />
      </label>
      <label class="attendance__field" for="attendance-request-out">
        <span>{{ isLeaveOrOvertimeRequest ? tr('End', '结束') : tr('Requested out', '申请打卡出') }}</span>
        <AttendanceScheduledDateInput
          v-model="requestForm.requestedOutAt"
          default-time="18:00"
          field-id="attendance-request-out"
          field-name="requestedOutAt"
          input-type="datetime-local"
          :calendar-days="calendarDays"
          :calendar-label="calendarLabel"
          :focus-calendar-month="focusCalendarMonth"
          :shift-month="shiftMonth"
          :tr="tr"
          :week-days="weekDays"
        />
      </label>
      <label v-if="isLeaveOrOvertimeRequest" class="attendance__field" for="attendance-request-minutes">
        <span>{{ tr('Duration (min)', '时长（分钟）') }}</span>
        <input
          id="attendance-request-minutes"
          v-model="requestForm.minutes"
          min="0"
          name="requestMinutes"
          type="number"
        />
      </label>
      <label v-if="isLeaveRequest" class="attendance__field" for="attendance-request-attachment">
        <span>{{ tr('Attachment URL', '附件链接') }}</span>
        <input
          id="attendance-request-attachment"
          v-model="requestForm.attachmentUrl"
          name="requestAttachment"
          :placeholder="tr('Optional', '可选')"
          type="text"
        />
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-request-reason">
        <span>{{ tr('Reason', '原因') }}</span>
        <input
          id="attendance-request-reason"
          v-model="requestForm.reason"
          name="requestReason"
          :placeholder="tr('Optional', '可选')"
          type="text"
        />
      </label>
      <button class="attendance__btn attendance__btn--primary" :disabled="requestSubmitting" @click="submitRequest">
        {{ requestSubmitting ? tr('Submitting...', '提交中...') : tr('Submit request', '提交申请') }}
      </button>
    </div>

    <div class="attendance__requests">
      <div class="attendance__requests-header">
        <span>{{ tr('Recent requests', '最近申请') }}</span>
        <button class="attendance__btn" :disabled="loading" @click="loadRequests">{{ tr('Reload', '重载') }}</button>
      </div>
      <div v-if="requests.length === 0" class="attendance__empty">{{ tr('No requests.', '暂无申请。') }}</div>
      <ul v-else class="attendance__request-list">
        <li v-for="item in requests" :key="item.id" class="attendance__request-item">
          <div>
            <strong>{{ formatDate(item.work_date) }}</strong> · {{ formatRequestType(item.request_type) }}
            <span class="attendance__status-chip" :class="`attendance__status-chip--${item.status}`">
              {{ formatStatus(item.status) }}
            </span>
          </div>
          <div v-if="item.metadata" class="attendance__request-meta">
            <span v-if="item.metadata.leaveType">{{ tr('Leave', '请假') }}: {{ formatLeaveTypeLabel(item.metadata.leaveType) }}</span>
            <span v-if="item.metadata.overtimeRule">{{ tr('Overtime', '加班') }}: {{ item.metadata.overtimeRule.name }}</span>
            <span v-if="item.metadata.minutes">{{ tr('Minutes', '分钟') }}: {{ item.metadata.minutes }}</span>
          </div>
          <div class="attendance__request-meta">
            <span>{{ tr('In', '入') }}: {{ formatDateTime(item.requested_in_at) }}</span>
            <span>{{ tr('Out', '出') }}: {{ formatDateTime(item.requested_out_at) }}</span>
          </div>
          <div v-if="item.status === 'pending'" class="attendance__request-actions">
            <button class="attendance__btn" @click="cancelRequest(item.id)">{{ tr('Cancel', '取消') }}</button>
            <button class="attendance__btn" @click="resolveRequest(item.id, 'approve')">{{ tr('Approve', '批准') }}</button>
            <button class="attendance__btn attendance__btn--danger" @click="resolveRequest(item.id, 'reject')">
              {{ tr('Reject', '驳回') }}
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>

  <div class="attendance__card">
    <div class="attendance__requests-header">
      <h3>{{ tr('Anomalies', '异常') }}</h3>
      <button class="attendance__btn" :disabled="anomaliesLoading || loading" @click="loadAnomalies">
        {{ anomaliesLoading ? tr('Loading...', '加载中...') : tr('Reload anomalies', '重载异常') }}
      </button>
    </div>
    <div v-if="anomaliesLoading" class="attendance__empty">{{ tr('Loading anomalies...', '正在加载异常...') }}</div>
    <div v-else-if="anomalies.length === 0" class="attendance__empty">{{ tr('No anomalies.', '暂无异常。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Date', '日期') }}</th>
            <th>{{ tr('Status', '状态') }}</th>
            <th>{{ tr('Warnings', '警告') }}</th>
            <th>{{ tr('Request', '申请') }}</th>
            <th>{{ tr('Action', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in anomalies" :key="item.recordId">
            <td>{{ formatDate(item.workDate) }}</td>
            <td>{{ formatStatus(item.status) }}</td>
            <td>{{ formatWarningsShort(item.warnings) }}</td>
            <td>
              <template v-if="item.request">
                {{ formatRequestType(item.request.requestType) }}
                <span class="attendance__status-chip" :class="`attendance__status-chip--${item.request.status}`">
                  {{ formatStatus(item.request.status) }}
                </span>
              </template>
              <span v-else>--</span>
            </td>
            <td class="attendance__table-actions">
              <button
                class="attendance__btn"
                :disabled="item.state === 'pending'"
                @click="prefillRequestFromAnomaly(item)"
              >
                {{ item.state === 'pending' ? tr('Pending request', '申请处理中') : tr('Create request', '创建申请') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="attendance__card">
    <div class="attendance__requests-header">
      <h3>{{ tr('Request Report', '申请报表') }}</h3>
      <button class="attendance__btn" :disabled="reportLoading" @click="loadRequestReport">
        {{ reportLoading ? tr('Loading...', '加载中...') : tr('Reload report', '重载报表') }}
      </button>
    </div>
    <div v-if="requestReport.length === 0" class="attendance__empty">{{ tr('No report data.', '暂无报表数据。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Type', '类型') }}</th>
            <th>{{ tr('Status', '状态') }}</th>
            <th>{{ tr('Total', '总数') }}</th>
            <th>{{ tr('Minutes', '分钟') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in requestReport" :key="`${row.requestType}-${row.status}`">
            <td>{{ formatRequestType(row.requestType) }}</td>
            <td>{{ formatStatus(row.status) }}</td>
            <td>{{ row.total }}</td>
            <td>{{ row.minutes }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Ref } from 'vue'
import AttendanceScheduledDateInput from './AttendanceScheduledDateInput.vue'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>
type RequestResolutionAction = 'approve' | 'reject'

interface RequestFormState {
  workDate: string
  requestType: string
  requestedInAt: string
  requestedOutAt: string
  reason: string
  leaveTypeId: string
  overtimeRuleId: string
  minutes: string
  attachmentUrl: string
}

interface NamedOption {
  id: string
  name: string
  paid?: boolean
}

interface AttendanceRequestMetadata {
  leaveType?: {
    name?: string | null
    paid?: boolean | null
  } | null
  overtimeRule?: {
    name?: string | null
  } | null
  minutes?: number | string | null
}

interface AttendanceRequestItem {
  id: string
  work_date: string
  request_type: string
  requested_in_at: string | null
  requested_out_at: string | null
  status: string
  metadata?: AttendanceRequestMetadata | null
}

interface AttendanceAnomalyRequest {
  id: string
  status: string
  requestType: string
}

interface AttendanceAnomalyItem {
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
  state: 'open' | 'pending'
  request?: AttendanceAnomalyRequest | null
  suggestedRequestType: string | null
}

interface AttendanceRequestReportItem {
  requestType: string
  status: string
  total: number
  minutes: number
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

interface RequestCenterBindings {
  requestForm: RequestFormState
  requestSubmitting: Ref<boolean>
  loading: Ref<boolean>
  requests: Ref<AttendanceRequestItem[]>
  anomalies: Ref<AttendanceAnomalyItem[]>
  anomaliesLoading: Ref<boolean>
  requestReport: Ref<AttendanceRequestReportItem[]>
  reportLoading: Ref<boolean>
  leaveTypes: Ref<NamedOption[]>
  overtimeRules: Ref<NamedOption[]>
  isLeaveRequest: Ref<boolean>
  isOvertimeRequest: Ref<boolean>
  isLeaveOrOvertimeRequest: Ref<boolean>
  submitRequest: () => MaybePromise<void>
  loadRequests: () => MaybePromise<void>
  cancelRequest: (id: string) => MaybePromise<void>
  resolveRequest: (id: string, action: RequestResolutionAction) => MaybePromise<void>
  loadAnomalies: () => MaybePromise<void>
  prefillRequestFromAnomaly: (item: AttendanceAnomalyItem) => MaybePromise<void>
  loadRequestReport: () => MaybePromise<void>
  focusCalendarMonth: (value: string | null | undefined) => MaybePromise<void>
  shiftMonth: (delta: number) => MaybePromise<void>
}

const props = defineProps<{
  requestCenter: RequestCenterBindings
  calendarDays: CalendarDay[]
  calendarLabel: string
  weekDays: string[]
  formatDate: (value: string | null | undefined) => string
  formatDateTime: (value: string | null | undefined) => string
  formatRequestType: (value: string) => string
  formatStatus: (value: string) => string
  formatWarningsShort: (warnings: string[]) => string
  tr: Translate
}>()

const tr = props.tr
const requestForm = props.requestCenter.requestForm
const requestSubmitting = props.requestCenter.requestSubmitting
const loading = props.requestCenter.loading
const requests = props.requestCenter.requests
const anomalies = props.requestCenter.anomalies
const anomaliesLoading = props.requestCenter.anomaliesLoading
const requestReport = props.requestCenter.requestReport
const reportLoading = props.requestCenter.reportLoading
const leaveTypes = props.requestCenter.leaveTypes
const overtimeRules = props.requestCenter.overtimeRules
const isLeaveRequest = props.requestCenter.isLeaveRequest
const isOvertimeRequest = props.requestCenter.isOvertimeRequest
const isLeaveOrOvertimeRequest = props.requestCenter.isLeaveOrOvertimeRequest
const formatDate = props.formatDate
const formatDateTime = props.formatDateTime
const formatRequestType = props.formatRequestType
const formatStatus = props.formatStatus
const formatWarningsShort = props.formatWarningsShort

const submitRequest = () => props.requestCenter.submitRequest()
const loadRequests = () => props.requestCenter.loadRequests()
const cancelRequest = (id: string) => props.requestCenter.cancelRequest(id)
const resolveRequest = (id: string, action: RequestResolutionAction) => props.requestCenter.resolveRequest(id, action)
const loadAnomalies = () => props.requestCenter.loadAnomalies()
const prefillRequestFromAnomaly = (item: AttendanceAnomalyItem) => props.requestCenter.prefillRequestFromAnomaly(item)
const loadRequestReport = () => props.requestCenter.loadRequestReport()
const focusCalendarMonth = (value: string | null | undefined) => props.requestCenter.focusCalendarMonth(value)
const shiftMonth = (delta: number) => props.requestCenter.shiftMonth(delta)

function formatLeaveTypeLabel(item: { name?: string | null; paid?: boolean | null }): string {
  const name = String(item?.name || '').trim()
  if (!name) return '--'
  if (item?.paid === undefined || item?.paid === null) return name
  return item.paid
    ? `${name} · ${tr('Paid', '带薪')}`
    : `${name} · ${tr('Unpaid', '无薪')}`
}
</script>

<style scoped>
.attendance__card {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.04);
}

.attendance__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #555;
}

.attendance__field input,
.attendance__field select {
  padding: 6px 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  min-width: 180px;
}

.attendance__field--full {
  flex: 1;
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

.attendance__request-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin: 12px 0 16px;
}

.attendance__requests {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attendance__requests-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.attendance__request-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.attendance__request-item {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__request-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #666;
}

.attendance__request-actions {
  display: flex;
  gap: 8px;
}

.attendance__status-chip {
  margin-left: 8px;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #f0f0f0;
}

.attendance__status-chip--pending {
  background: #fff3e0;
  color: #ef6c00;
}

.attendance__status-chip--approved {
  background: #e8f5e9;
  color: #2e7d32;
}

.attendance__status-chip--rejected {
  background: #ffebee;
  color: #c62828;
}

.attendance__status-chip--cancelled {
  background: #eceff1;
  color: #546e7a;
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
  white-space: nowrap;
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

  .attendance__request-meta {
    flex-direction: column;
    gap: 4px;
  }

  .attendance__requests-header {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
