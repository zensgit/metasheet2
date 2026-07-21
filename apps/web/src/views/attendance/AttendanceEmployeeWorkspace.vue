<!--
  Employee overview task-first design-lock (2026-07-16, RATIFIED 2026-07-21):
  docs/development/attendance-employee-overview-task-first-design-lock-20260716.md
  vNext charter §6.2 (Wave 2 / issue #4355): first extraction of the overview's
  Today / Needs-attention / More-attendance-tools bands.

  This component owns LAYOUT, DISPLAY, and re-emitting real parent actions —
  it fetches nothing, holds no route/API state, and duplicates no write path.
  API calls, route sync, and the punch/request handlers stay in
  AttendanceView.vue (charter §6.2 table, "暂留父层"). The heavy historical
  surfaces (summary, calendar, adjustment/request list, request report) are
  NOT re-authored here — they remain parent-owned markup, passed in through
  the `historyFilters` slot, so this first extraction does not touch their
  handler-dense code (charter §6.1: "先拆展示和纯状态, 再拆网络与写入"). The
  history disclosure this component renders sits immediately before that
  parent-owned historical content and the parent-owned status-guide card
  (lock §5, §4.3 item 6) — AttendanceView.vue keeps both as siblings right
  after this component so the reports-only sections between them (zero DOM
  nodes in overview mode) do not break that adjacency.
-->
<template>
  <div class="attendance-ew">
    <div class="attendance-ew__today">
      <div class="attendance__hero-punch" data-testid="attendance-hero-punch">
        <div class="attendance__hero-clock">
          <span class="attendance__hero-time" data-testid="attendance-hero-time">{{ heroClockTime }}</span>
          <span class="attendance__hero-date">{{ heroClockDate }}</span>
        </div>
        <div class="attendance__actions attendance__hero-actions">
          <button
            class="attendance__btn attendance__btn--primary attendance__btn--hero"
            :disabled="punching"
            @click="$emit('punch', 'check_in')"
          >
            {{ punching ? tr('Working...', '处理中...') : tr('Check In', '上班打卡') }}
          </button>
          <button
            class="attendance__btn attendance__btn--hero-secondary"
            :disabled="punching"
            @click="$emit('punch', 'check_out')"
          >
            {{ punching ? tr('Working...', '处理中...') : tr('Check Out', '下班打卡') }}
          </button>
        </div>
        <div v-if="heroTimeline" class="attendance__hero-timeline" data-testid="attendance-hero-timeline">
          <span class="attendance__hero-timeline-node" :class="{ 'attendance__hero-timeline-node--pending': !heroTimeline.checkIn }">
            <span class="attendance__hero-timeline-dot" />
            {{ tr('In', '上班') }} {{ heroTimeline.checkIn ?? '--:--' }}
          </span>
          <span class="attendance__hero-timeline-rail" />
          <span class="attendance__hero-timeline-node" :class="{ 'attendance__hero-timeline-node--pending': !heroTimeline.checkOut }">
            <span class="attendance__hero-timeline-dot" />
            {{ tr('Out', '下班') }} {{ heroTimeline.checkOut ?? '--:--' }}
          </span>
        </div>
        <div v-if="punchOutdoorNoteRequired" class="attendance__punch-note" data-attendance-punch-note-form>
          <label class="attendance__field" for="attendance-punch-outdoor-note">
            <span>{{ tr('Outdoor punch note', '外勤打卡备注') }}</span>
            <input
              id="attendance-punch-outdoor-note"
              :value="punchOutdoorNoteDraft"
              type="text"
              :placeholder="tr('Required to submit an outdoor punch', '提交外勤打卡需填写')"
              @input="$emit('update:punchOutdoorNoteDraft', ($event.target as HTMLInputElement).value)"
              @keydown.enter.prevent="$emit('retryPunchNote')"
            />
          </label>
          <button
            class="attendance__btn attendance__btn--inline"
            type="button"
            data-attendance-punch-note-retry
            :disabled="punching || !punchOutdoorNoteDraft.trim()"
            @click="$emit('retryPunchNote')"
          >
            {{ punching ? tr('Working...', '处理中...') : tr('Retry punch with note', '补充备注后重试打卡') }}
          </button>
        </div>
      </div>

      <div class="attendance__card attendance__card--selfservice attendance-ew__today-status" data-selfservice-card="status">
        <div class="attendance__requests-header">
          <div>
            <h3>{{ tr('My status', '我的状态') }}</h3>
            <small class="attendance__field-hint">
              {{
                workbenchFocusDateLabel
                  ? tr(`Focus date: ${workbenchFocusDateLabel}`, `关注日期：${workbenchFocusDateLabel}`)
                  : tr('Focus date: current range', '关注日期：当前区间')
              }}
            </small>
          </div>
          <span
            v-if="workbenchRecordStatus"
            class="attendance__status-chip"
            :class="`attendance__status-chip--${workbenchRecordStatus}`"
          >
            {{ formatStatus(workbenchRecordStatus) }}
          </span>
        </div>
        <p class="attendance__selfservice-lead">{{ workbenchStatusDescription }}</p>
        <div class="attendance__summary attendance__summary--workbench attendance__summary--stat">
          <div class="attendance__summary-item attendance__summary-item--stat">
            <svg class="attendance__summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            <span>{{ tr('Latest punch', '最近一次打卡') }}</span>
            <strong class="attendance__summary-value">{{ workbenchLatestPunchLabel }}</strong>
          </div>
          <div class="attendance__summary-item attendance__summary-item--stat">
            <svg class="attendance__summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 2h4M12 2v4" /><circle cx="12" cy="14" r="7" /><path d="M12 14l2.5-2.5" /></svg>
            <span>{{ tr('Work minutes', '工时分钟') }}</span>
            <strong class="attendance__summary-value">{{ workbenchWorkMinutes }}</strong>
          </div>
          <div class="attendance__summary-item attendance__summary-item--stat">
            <svg class="attendance__summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18.5v.5" /></svg>
            <span>{{ tr('Late / Early', '迟到 / 早退') }}</span>
            <strong class="attendance__summary-value" :class="{ 'attendance__summary-value--warning': workbenchHasLateEarly }">{{ workbenchLateEarlyLabel }}</strong>
          </div>
        </div>
        <p
          v-if="selfServiceNeedsSetupHint"
          class="attendance__field-hint attendance__field-hint--strong"
          data-selfservice-setup-hint
        >
          {{ selfServiceSetupFollowupHint }}
        </p>
      </div>
    </div>

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
        @click="$emit('statusAction')"
      >
        {{ statusActionBusy ? tr('Working...', '处理中...') : statusActionLabel }}
      </button>
    </div>

    <div
      class="attendance-ew__attention"
      data-attendance-overview-attention
      :data-attendance-overview-attention-key="attentionItem.key"
    >
      <strong>{{ attentionItem.title }}</strong>
      <p>{{ attentionItem.detail }}</p>
      <button
        v-if="attentionItem.action && attentionItem.actionLabel"
        class="attendance__btn attendance__btn--primary"
        type="button"
        data-attendance-overview-attention-action
        @click="$emit('selfServiceAction', attentionItem.action)"
      >
        {{ attentionItem.actionLabel }}
      </button>
    </div>

    <div class="attendance-ew__tools">
      <div class="attendance__card attendance__card--selfservice" data-selfservice-card="requests">
        <div class="attendance__requests-header">
          <div>
            <h3>{{ tr('My request status', '我的申请状态') }}</h3>
            <small class="attendance__field-hint">
              {{ tr('Summarizes the current request backlog from the visible date range.', '汇总当前可见日期区间内的申请处理状态。') }}
            </small>
          </div>
          <strong>{{ requestsTotal }}</strong>
        </div>
        <div class="attendance__chip-list">
          <span
            v-for="item in selfServiceRequestStatusItems"
            :key="item.key"
            class="attendance__status-chip"
            :class="`attendance__status-chip--${item.key}`"
            :data-selfservice-request-stat="item.key"
          >
            {{ item.label }} · {{ item.count }}
          </span>
        </div>
        <div class="attendance__selfservice-callout" data-selfservice-request-followup>
          <div class="attendance__selfservice-callout-copy">
            <div class="attendance__selfservice-callout-header">
              <strong>{{ selfServiceRequestFollowup.title }}</strong>
              <span
                v-if="selfServiceRequestFollowup.status"
                class="attendance__status-chip"
                :class="`attendance__status-chip--${selfServiceRequestFollowup.status}`"
              >
                {{ formatStatus(selfServiceRequestFollowup.status) }}
              </span>
            </div>
            <p>{{ selfServiceRequestFollowup.detail }}</p>
          </div>
          <button
            class="attendance__btn attendance__btn--inline"
            type="button"
            data-selfservice-action="request-followup"
            @click="$emit('selfServiceAction', selfServiceRequestFollowup.action)"
          >
            {{ selfServiceRequestFollowup.actionLabel }}
          </button>
        </div>
        <ul v-if="selfServiceRecentRequests.length > 0" class="attendance__request-list attendance__request-list--compact">
          <li v-for="item in selfServiceRecentRequests" :key="item.id" class="attendance__request-item">
            <div>
              <strong>{{ formatRequestType(item.request_type) }}</strong>
              <span class="attendance__status-chip" :class="`attendance__status-chip--${item.status}`">
                {{ formatStatus(item.status) }}
              </span>
            </div>
            <div class="attendance__request-meta">
              <span>{{ formatDate(item.work_date) }}</span>
              <span>{{ selfServiceRequestSubtitle(item) }}</span>
            </div>
            <div class="attendance__request-meta" v-if="requestReasonText(item)">
              <span>{{ tr('Reason', '原因') }}: {{ requestReasonText(item) }}</span>
            </div>
            <div class="attendance__request-meta" v-if="requestDecisionCommentText(item)">
              <span>{{ requestDecisionCommentLabel(item) }}: {{ requestDecisionCommentText(item) }}</span>
            </div>
            <p class="attendance__request-note">
              {{ describeRequestStatus(item.status, item) }}
            </p>
          </li>
        </ul>
        <div v-else class="attendance__empty">{{ tr('No recent requests in this range.', '当前区间内暂无申请。') }}</div>
      </div>

      <div class="attendance__card attendance__card--selfservice" data-selfservice-card="actions">
        <div class="attendance__requests-header">
          <div>
            <h3>{{ tr('Quick actions', '快捷操作') }}</h3>
            <small class="attendance__field-hint">
              {{ tr('Jump straight into the most common employee actions without leaving overview.', '无需离开总览，直接进入最常用的员工操作。') }}
            </small>
          </div>
        </div>
        <div class="attendance__quick-actions">
          <button
            class="attendance__btn attendance__btn--primary"
            type="button"
            data-selfservice-action="missing-punch"
            @click="$emit('selfServiceAction', 'missing-punch')"
          >
            {{ tr('Fix missing punch', '处理缺卡') }}
          </button>
          <button
            class="attendance__btn"
            type="button"
            data-selfservice-action="leave"
            @click="$emit('selfServiceAction', 'leave')"
          >
            {{ tr('Leave request', '请假申请') }}
          </button>
          <button
            class="attendance__btn"
            type="button"
            data-selfservice-action="overtime"
            @click="$emit('selfServiceAction', 'overtime')"
          >
            {{ tr('Overtime request', '加班申请') }}
          </button>
          <button
            class="attendance__btn"
            type="button"
            data-selfservice-action="shift-swap"
            @click="$emit('selfServiceAction', 'shift_swap')"
          >
            {{ tr('Shift swap', '换班申请') }}
          </button>
          <button
            class="attendance__btn"
            type="button"
            data-selfservice-action="records"
            @click="$emit('selfServiceAction', 'records')"
          >
            {{ tr('Review records', '查看记录') }}
          </button>
        </div>
        <p class="attendance__field-hint attendance__field-hint--strong">
          {{ selfServiceQuickActionHint }}
        </p>
      </div>

      <div class="attendance__card attendance__card--selfservice" data-selfservice-card="annual-balance">
        <div class="attendance__requests-header">
          <div><h3>{{ tr('My annual leave', '我的年假') }}</h3></div>
        </div>
        <p v-if="annualSelfBalanceLoading" class="attendance__field-hint">{{ tr('Loading...', '加载中...') }}</p>
        <p v-else-if="annualSelfBalanceError" class="attendance__error" data-annual-self-balance-error>{{ annualSelfBalanceError }}</p>
        <div v-else-if="annualSelfBalanceSummary" class="attendance__selfbalance" data-annual-self-balance>
          <div class="attendance__selfbalance-remaining">
            <strong>{{ annualSelfBalanceSummary.remainingMinutes }}</strong> {{ tr('min remaining', '分钟剩余') }}
          </div>
          <small class="attendance__field-hint">
            {{ tr('Granted', '已发放') }} {{ annualSelfBalanceSummary.grantedMinutes }} ·
            {{ tr('Used', '已用') }} {{ annualSelfBalanceSummary.exhaustedMinutes }} ·
            {{ tr('Expired', '已过期') }} {{ annualSelfBalanceSummary.expiredMinutes }}
          </small>
        </div>
        <p v-else class="attendance__field-hint">{{ tr('No annual leave balance yet.', '暂无年假余额。') }}</p>
      </div>

      <div class="attendance__card attendance__card--selfservice attendance-ew__tools-deemphasized" data-selfservice-card="rules">
        <div class="attendance__requests-header">
          <div>
            <h3>{{ tr('My attendance rules', '我的考勤规则') }}</h3>
            <small class="attendance__field-hint">{{ tr('Read-only summary of the rules currently used for you.', '当前适用于您的考勤规则只读摘要。') }}</small>
          </div>
        </div>
        <p v-if="selfRulesLoading" class="attendance__field-hint">{{ tr('Loading...', '加载中...') }}</p>
        <p v-else-if="selfRulesError" class="attendance__error" data-selfservice-rules-error>{{ selfRulesError }}</p>
        <div v-else-if="selfRulesHasData" class="attendance__selfrules" data-selfservice-rules>
          <div class="attendance__summary attendance__summary--workbench">
            <div class="attendance__summary-item">
              <span>{{ tr('Attendance group', '考勤组') }}</span>
              <strong>{{ selfRulesAttendanceGroupSummary }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Schedule group', '排班组') }}</span>
              <strong>{{ selfRulesScheduleGroupSummary }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Work window', '工作时间') }}</span>
              <strong>{{ selfRulesWorkWindowSummary }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Punch policy', '打卡策略') }}</span>
              <strong>{{ selfRulesPunchPolicySummary }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Working days', '工作日') }}</span>
              <strong>{{ selfRulesWorkingDaysSummary }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Late / early grace', '迟到 / 早退宽限') }}</span>
              <strong>{{ selfRulesGraceSummary }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>{{ tr('Severe / absence late', '严重 / 旷工迟到') }}</span>
              <strong>{{ selfRulesLateThresholdSummary }}</strong>
            </div>
          </div>
          <p v-if="selfRulesConfiguredRuleSummary" class="attendance__field-hint attendance__field-hint--strong">
            {{ selfRulesConfiguredRuleSummary }}
          </p>
          <div v-if="selfRulesWarningCodes.length > 0" class="attendance__chip-list" data-selfservice-rules-warnings>
            <span
              v-for="code in selfRulesWarningCodes"
              :key="code"
              class="attendance__status-chip attendance__status-chip--pending"
            >
              {{ formatSelfRulesWarning(code) }}
            </span>
          </div>
        </div>
        <p v-else class="attendance__field-hint">{{ tr('No attendance rules loaded yet.', '暂无考勤规则摘要。') }}</p>
      </div>

      <details class="attendance-ew__history-filters" data-attendance-history-filters>
        <summary class="attendance__details-summary">
          {{ tr('Date, org, and user filters', '日期 / 组织 / 用户筛选') }}
        </summary>
        <div class="attendance__filters">
          <slot name="historyFilters" />
        </div>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AttendanceOverviewAttentionItem } from './attendanceOverviewPriority'

type TranslateFn = (en: string, zh: string) => string

/** Same key space `runSelfServiceAction` (AttendanceView.vue) already
 * switches on — kept local (not imported) since AttendanceView.vue does not
 * export its types; must be extended in both places together. */
type WorkspaceSelfServiceActionKey =
  | 'missing-punch'
  | 'leave'
  | 'overtime'
  | 'shift_swap'
  | 'records'
  | 'request-report'

interface WorkspaceRequestItem {
  id: string
  work_date: string
  request_type: string
  status: string
  requested_in_at: string | null
  requested_out_at: string | null
  reason?: string | null
  metadata?: Record<string, any>
}

interface RequestStatusItem {
  key: string
  label: string
  count: number
}

interface RequestFollowup {
  title: string
  detail: string
  status: string | null
  action: WorkspaceSelfServiceActionKey
  actionLabel: string
}

interface AnnualBalanceSummary {
  remainingMinutes: number
  grantedMinutes: number
  exhaustedMinutes: number
  expiredMinutes: number
}

defineProps<{
  tr: TranslateFn
  // Today band
  heroClockTime: string
  heroClockDate: string
  punching: boolean
  heroTimeline: { checkIn: string | null; checkOut: string | null } | null
  punchOutdoorNoteRequired: boolean
  punchOutdoorNoteDraft: string
  workbenchStatusDescription: string
  workbenchRecordStatus: string | null
  workbenchFocusDateLabel: string | null
  workbenchLatestPunchLabel: string
  workbenchWorkMinutes: number
  workbenchLateEarlyLabel: string
  workbenchHasLateEarly: boolean
  selfServiceNeedsSetupHint: boolean
  selfServiceSetupFollowupHint: string
  formatStatus: (value: string) => string
  // Status banner (not part of the history disclosure)
  statusMessage: string
  statusKind: 'info' | 'error'
  statusCode: string
  statusHint: string
  statusActionLabel: string
  statusActionBusy: boolean
  // Needs-attention band
  attentionItem: AttendanceOverviewAttentionItem
  // Tools band: requests
  requestsTotal: number
  selfServiceRequestStatusItems: RequestStatusItem[]
  selfServiceRequestFollowup: RequestFollowup
  selfServiceRecentRequests: WorkspaceRequestItem[]
  formatRequestType: (value: string) => string
  formatDate: (value: string | null | undefined) => string
  selfServiceRequestSubtitle: (item: WorkspaceRequestItem) => string
  requestReasonText: (item: WorkspaceRequestItem) => string
  requestDecisionCommentText: (item: WorkspaceRequestItem) => string
  requestDecisionCommentLabel: (item: WorkspaceRequestItem) => string
  describeRequestStatus: (status: string | null | undefined, item?: WorkspaceRequestItem | null) => string
  // Tools band: quick actions
  selfServiceQuickActionHint: string
  // Tools band: annual balance
  annualSelfBalanceLoading: boolean
  annualSelfBalanceError: string | null
  annualSelfBalanceSummary: AnnualBalanceSummary | null
  // Tools band: rules (de-emphasized, not removed — lock §4.3 item 4)
  selfRulesLoading: boolean
  selfRulesError: string | null
  selfRulesHasData: boolean
  selfRulesAttendanceGroupSummary: string
  selfRulesScheduleGroupSummary: string
  selfRulesWorkWindowSummary: string
  selfRulesPunchPolicySummary: string
  selfRulesWorkingDaysSummary: string
  selfRulesGraceSummary: string
  selfRulesLateThresholdSummary: string
  selfRulesConfiguredRuleSummary: string
  selfRulesWarningCodes: string[]
  formatSelfRulesWarning: (code: string) => string
}>()

defineEmits<{
  punch: [eventType: 'check_in' | 'check_out']
  retryPunchNote: []
  'update:punchOutdoorNoteDraft': [value: string]
  statusAction: []
  selfServiceAction: [action: WorkspaceSelfServiceActionKey]
}>()
</script>

<style scoped>
/* Layout shell — new band structure (lock §4, §7). All spacing/colors here
   use --ms-* tokens; the relocated card styling below is copied verbatim
   from AttendanceView.vue (byte-identical values) so the reorg introduces
   no visual drift. */
.attendance-ew {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-5, 20px);
}

.attendance-ew__today {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: var(--ms-space-5, 20px);
  align-items: start;
}

.attendance-ew__today-status {
  margin: 0;
}

.attendance-ew__attention {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2, 8px);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
  padding: var(--ms-space-4, 16px) var(--ms-space-5, 20px);
}

.attendance-ew__attention p {
  margin: 0;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.attendance-ew__tools {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 20px;
}

.attendance-ew__tools-deemphasized {
  opacity: 0.92;
}

.attendance-ew__history-filters {
  grid-column: 1 / -1;
  border: 1px dashed var(--ms-border);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-3, 12px) var(--ms-space-4, 16px);
  background: var(--ms-bg-page);
}

.attendance-ew__history-filters[open] {
  background: var(--ms-bg-card);
}

/* Relocated card/hero styling, copied verbatim from AttendanceView.vue's
   scoped stylesheet (Vue scoped CSS does not cross component boundaries —
   see attendance-employee-overview-task-first-design-lock-20260716.md
   implementation notes). Do not retokenize values here independently of
   the source; keep both copies in sync if either changes. */
.attendance__filters {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.attendance__punch-note {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.attendance__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #555;
}

.attendance__field input {
  padding: 6px 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  min-width: 180px;
}

.attendance__field-hint {
  color: #777;
  font-size: 11px;
}

.attendance__field-hint--error {
  color: #c0392b;
}

.attendance__field-hint--strong {
  display: inline-flex;
  margin-top: 12px;
  font-weight: 600;
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

.attendance__status {
  font-size: 12px;
  color: #2e7d32;
}

.attendance__status--error {
  color: #c62828;
}

.attendance__card {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.04);
}

.attendance__card--selfservice {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.attendance__summary--workbench {
  margin-top: 0;
}

.attendance__selfservice-lead {
  margin: 0;
  color: #334155;
  line-height: 1.5;
}

.attendance__selfservice-callout {
  border: 1px solid #dbe4f0;
  border-radius: 12px;
  background: linear-gradient(135deg, #f8fbff, #eef6ff);
  padding: 12px;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.attendance__selfservice-callout-copy {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__selfservice-callout-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__selfservice-callout-copy p {
  margin: 0;
  color: #475569;
  line-height: 1.5;
}

.attendance__quick-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.attendance__request-list--compact {
  gap: 8px;
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

.attendance__request-note {
  margin: 0;
  color: #475569;
  line-height: 1.5;
}

.attendance__chip-list {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attendance__status-chip {
  margin-left: 8px;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #f0f0f0;
}

.attendance__status-chip--pending { background: #fff3e0; color: #ef6c00; }
.attendance__status-chip--approved { background: #e8f5e9; color: #2e7d32; }
.attendance__status-chip--normal { background: #e8f5e9; color: #2e7d32; }
.attendance__status-chip--late { background: #fff3e0; color: #ef6c00; }
.attendance__status-chip--early_leave { background: #ede7f6; color: #6a1b9a; }
.attendance__status-chip--late_early { background: #ffebee; color: #c62828; }
.attendance__status-chip--partial { background: #e3f2fd; color: #1565c0; }
.attendance__status-chip--adjusted { background: #e0f7fa; color: #006064; }
.attendance__status-chip--off { background: #eceff1; color: #546e7a; }
.attendance__status-chip--absent { background: #f5f5f5; color: #616161; }
.attendance__status-chip--rejected { background: #ffebee; color: #c62828; }
.attendance__status-chip--cancelled { background: #eceff1; color: #546e7a; }

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

.attendance__details-summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--ms-text-1);
}

.attendance__error {
  color: #c0392b;
  font-size: 12px;
}

.attendance__empty {
  color: #777;
  font-size: 13px;
}

.attendance__selfbalance-remaining {
  font-size: 20px;
  font-weight: 600;
  color: var(--ms-text-1);
}

/* UI-P0'/P1 hero + stat cards — already fully tokenized in the source
   (see AttendanceView.vue's "UI-P0′ hero punch card" comment); copied
   verbatim, no hardcoded hex introduced. */
.attendance__hero-punch {
  display: flex;
  align-items: center;
  gap: var(--ms-space-5);
  padding: var(--ms-space-4) var(--ms-space-5);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
}

.attendance__hero-clock {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  min-width: 132px;
}

.attendance__hero-time {
  font-size: 32px;
  font-weight: var(--ms-font-weight-title);
  line-height: 1.1;
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
}

.attendance__hero-date {
  font-size: 12px;
  color: var(--ms-text-3);
}

.attendance__hero-actions {
  display: flex;
  align-items: center;
  gap: var(--ms-space-3);
}

.attendance__btn--hero {
  min-height: 56px;
  min-width: 160px;
  font-size: 16px;
  font-weight: var(--ms-font-weight-title);
  border-radius: var(--ms-radius-md);
}

.attendance__btn--hero-secondary {
  min-height: 56px;
  min-width: 132px;
  font-size: 15px;
  border-radius: var(--ms-radius-md);
  border-color: var(--ms-color-primary);
  color: var(--ms-color-primary);
}

.attendance__hero-timeline {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  font-size: 12px;
  color: var(--ms-text-2);
  font-variant-numeric: tabular-nums;
}

.attendance__hero-timeline-node {
  display: inline-flex;
  align-items: center;
  gap: var(--ms-space-1);
}

.attendance__hero-timeline-node--pending {
  color: var(--ms-text-3);
}

.attendance__hero-timeline-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ms-color-success);
}

.attendance__hero-timeline-node--pending .attendance__hero-timeline-dot {
  background: var(--ms-border);
}

.attendance__hero-timeline-rail {
  flex: 0 0 32px;
  height: 2px;
  background: var(--ms-border-light);
  border-radius: 1px;
}

.attendance__summary--stat {
  gap: var(--ms-space-3);
}

.attendance__summary-item--stat {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  padding: var(--ms-space-3) var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
}

.attendance__summary-icon {
  width: 18px;
  height: 18px;
  color: var(--ms-color-primary);
}

.attendance__summary-value {
  font-size: 22px;
  line-height: 1.2;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
}

.attendance__summary-value--warning {
  color: var(--ms-color-warning);
}

@media (max-width: 768px) {
  .attendance-ew__today {
    grid-template-columns: 1fr;
  }

  .attendance__hero-punch {
    flex-direction: column;
    align-items: stretch;
    gap: var(--ms-space-3);
  }

  .attendance__hero-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .attendance__hero-timeline {
    flex-wrap: wrap;
  }

  .attendance__summary--stat {
    grid-template-columns: repeat(2, 1fr);
  }

  .attendance__selfservice-callout {
    flex-direction: column;
    align-items: flex-start;
  }

  .attendance__btn {
    width: 100%;
  }

  .attendance__request-meta {
    flex-direction: column;
    gap: 4px;
  }

  .attendance__filters .attendance__field {
    width: 100%;
  }
}
</style>
