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

  `afterCommon` is a layout-only slot immediately below the 常用 band.
  The parent owns any dedicated request card; this component still
  fetches nothing and does not own those write paths.

  Visual follow-up (owner, 2026-08-24): employee-workspace chrome only.
  Calm refresh (owner, 2026-10-09): surfaces, type, and actions consume
  `--ms-*` tokens. No punch, policy, approval, or API change.

  Owner lock (2026-08-24, IA only): first-viewport *layout* stays
  Desktop: punch|待办 + compact 申请 footer; 常用 full-width below.
  Mobile: punch → 待办+申请 footer → 常用.
  缺卡 / anomaly rows use the makeup 面性 icon; never the character 缺.
  No employee 自定义. Admin-only icon settings.

  Visual unfreeze (2026-09-16): polish hierarchy / spacing / empty
  states / punch CTA emphasis / 常用 tiles only. Do not change IA,
  afterCommon wiring, or dedicated-card behavior.

  Below-the-fold follow-up (owner, 2026-08-25): history filters stay a
  collapsed-by-default disclosure (OD-O2) but show the active range while
  closed; expanded fields use a wrap-safe toolbar.
-->
<template>
  <div class="attendance-ew">
    <div class="attendance-ew__greeting" data-attendance-overview-greeting>
      <div class="attendance-ew__greeting-copy">
        <h2 class="attendance-ew__hello">{{ greetingText }}</h2>
        <p class="attendance-ew__hello-sub">{{ greetingSubline }}</p>
      </div>
    </div>

    <!--
      Owner lock 2026-08-24 + lock §7: desktop punch | 待办+申请 footer;
      常用 is a full-width band below. Status banner stays in the today
      column. History filters stay below this primary row.
    -->
    <div class="attendance-ew__primary" data-attendance-overview-primary>
    <div class="attendance-ew__today">
      <div class="attendance__hero-punch" data-testid="attendance-hero-punch">
        <div class="attendance-ew__hero-top">
          <div class="attendance__hero-clock">
            <p class="attendance-ew__hero-timezone" data-attendance-hero-timezone>{{ heroClockTimezone }}</p>
            <span
              class="attendance__hero-time"
              :class="{ 'attendance__hero-time--unavailable': !/^\d{2}:\d{2}:\d{2}$/.test(heroClockTime) }"
              data-testid="attendance-hero-time"
            >{{ heroClockTime }}</span>
            <p class="attendance-ew__clock-status" :data-attendance-clock-state="punchEmphasis">
              <span
                class="attendance-ew__clock-dot"
                :class="`attendance-ew__clock-dot--${punchEmphasis}`"
                aria-hidden="true"
              />
              {{ clockStatusLine }}
            </p>
          </div>
          <div class="attendance__actions attendance__hero-actions">
            <button
              class="attendance__btn attendance__btn--primary attendance__btn--hero"
              :class="punchButtonClass('check_in')"
              data-attendance-hero-cta="check_in"
              :data-attendance-hero-next="punchEmphasis === 'check_in' ? 'true' : undefined"
              :disabled="punching"
              @click="$emit('punch', 'check_in')"
            >
              {{ punching ? tr('Working...', '处理中...') : tr('Check In', '上班打卡') }}
            </button>
            <button
              class="attendance__btn attendance__btn--hero-secondary"
              :class="punchButtonClass('check_out')"
              data-attendance-hero-cta="check_out"
              :data-attendance-hero-next="punchEmphasis === 'check_out' ? 'true' : undefined"
              :disabled="punching"
              @click="$emit('punch', 'check_out')"
            >
              {{ punching ? tr('Working...', '处理中...') : tr('Check Out', '下班打卡') }}
            </button>
          </div>
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

        <div
          class="attendance-ew__metrics"
          data-selfservice-card="status"
        >
          <div
            v-if="workbenchRecordStatus"
            class="attendance__summary attendance__summary--workbench attendance__summary--stat"
            :class="{ 'attendance__hero-timeline': Boolean(heroTimeline) }"
            :data-testid="heroTimeline ? 'attendance-hero-timeline' : undefined"
          >
            <div class="attendance__summary-item attendance__summary-item--stat">
              <span>{{ tr('In', '上班') }}</span>
              <strong
                class="attendance__summary-value attendance__hero-timeline-node"
                :class="{
                  'attendance__hero-timeline-node--pending': !metricInTime || metricInTime === '--:--',
                  'attendance__summary-value--ok': Boolean(metricInTime && metricInTime !== '--:--'),
                }"
              >{{ metricInTime }}</strong>
            </div>
            <div class="attendance__summary-item attendance__summary-item--stat">
              <span>{{ tr('Out', '下班') }}</span>
              <strong
                class="attendance__summary-value attendance__hero-timeline-node"
                :class="{ 'attendance__hero-timeline-node--pending': !metricOutTime || metricOutTime === '--:--' }"
              >{{ metricOutTime }}</strong>
            </div>
            <div class="attendance__summary-item attendance__summary-item--stat">
              <span>{{ workbenchHoursLabel }}</span>
              <strong class="attendance__summary-value">{{ workDurationLabel }}</strong>
            </div>
            <div class="attendance__summary-item attendance__summary-item--stat">
              <span>{{ tr('Late / Early', '迟到 / 早退') }}</span>
              <strong
                class="attendance__summary-value"
                :class="{ 'attendance__summary-value--warning': workbenchHasLateEarly }"
              >{{ lateEarlyDisplay }}</strong>
            </div>
          </div>
          <p class="attendance__selfservice-lead">{{ workbenchStatusDescription }}</p>
          <span
            v-if="workbenchRecordStatus"
            class="attendance__status-chip"
            :class="`attendance__status-chip--${workbenchRecordStatus}`"
          >
            {{ formatStatus(workbenchRecordStatus) }}
          </span>
          <small
            v-if="refreshingAfterPunch"
            class="attendance__field-hint"
            data-testid="attendance-refreshing-indicator"
          >
            {{ tr('Updating...', '更新中...') }}
          </small>
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
    </div>

    <div
      class="attendance-ew__attention"
      data-attendance-overview-attention
      :data-attendance-overview-attention-key="attentionItem.key"
    >
      <div class="attendance-ew__todo-head">
        <h3>{{ tr("Today's to-do", '今日待办') }}</h3>
        <span
          v-if="attentionItem.key !== 'all_clear'"
          class="attendance-ew__todo-badge"
        >1</span>
      </div>
      <div
        v-if="attentionItem.key === 'all_clear'"
        class="attendance-ew__todo-empty"
        data-attendance-todo-empty
      >
        <span
          class="attendance-ew__todo-mark"
          :class="`attendance-ew__todo-mark--${todoMark.tone}`"
          data-attendance-todo-mark
          :data-attendance-todo-tone="todoMark.tone"
          aria-hidden="true"
        >
          <AttendanceEmployeeCommonIcon :name="todoMark.icon" />
        </span>
        <div class="attendance-ew__todo-copy">
          <strong>{{ attentionItem.title }}</strong>
          <p>{{ attentionItem.detail }}</p>
        </div>
      </div>
      <div v-else class="attendance-ew__todo-row">
        <span
          class="attendance-ew__todo-mark"
          :class="`attendance-ew__todo-mark--${todoMark.tone}`"
          data-attendance-todo-mark
          :data-attendance-todo-tone="todoMark.tone"
          aria-hidden="true"
        >
          <AttendanceEmployeeCommonIcon :name="todoMark.icon" />
        </span>
        <div class="attendance-ew__todo-copy">
          <strong>{{ attentionItem.title }}</strong>
          <p>{{ attentionItem.detail }}</p>
        </div>
        <button
          v-if="attentionItem.action && attentionItem.actionLabel"
          class="attendance-ew__todo-link"
          type="button"
          data-attendance-overview-attention-action
          @click="$emit('selfServiceAction', attentionItem.action)"
        >
          {{ tr('Go handle', '去处理') }}
        </button>
      </div>

      <div class="attendance-ew__request-footer" data-selfservice-card="requests">
        <div class="attendance-ew__request-footer-row">
          <h3>{{ tr('My applications', '我的申请') }}</h3>
          <strong
            v-if="hasRequestBody"
            class="attendance-ew__request-count"
            data-attendance-request-count
          >{{ requestsTotal }}</strong>
          <span
            v-else
            class="attendance-ew__request-empty"
            data-attendance-request-empty
          >{{ tr('No pending approvals', '暂无待审批') }}</span>
        </div>
        <template v-if="hasRequestBody">
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
        </template>
      </div>
    </div>
    </div>

    <div class="attendance__card attendance__card--selfservice attendance-ew__actions attendance-ew__common" data-selfservice-card="actions">
        <div class="attendance__requests-header">
          <div>
            <h3>{{ tr('Common', '常用') }}</h3>
          </div>
        </div>
        <!-- First-screen 常用: four read-only tiles. Admin picks icons via settings. -->
        <div class="attendance-ew__tiles">
          <button
            v-for="tile in commonTiles"
            :key="tile.action"
            class="attendance-ew__tile"
            type="button"
            :data-selfservice-action="tile.action"
            :data-attendance-ew-icon="tile.icon"
            @click="$emit('selfServiceAction', tile.emitAction)"
          >
            <span class="attendance-ew__tile-icon" :class="`attendance-ew__tile-icon--${tile.tone}`" aria-hidden="true">
              <AttendanceEmployeeCommonIcon :name="tile.icon" />
            </span>
            <span class="attendance-ew__tile-label">{{ tile.label }}</span>
          </button>
        </div>
        <p class="attendance-ew__common-hint">{{ selfServiceQuickActionHint }}</p>
      </div>

    <slot name="afterCommon" />

    <div class="attendance-ew__tools">
      <div class="attendance__card attendance__card--selfservice attendance-ew__balance" data-selfservice-card="annual-balance">
        <div class="attendance__requests-header">
          <div>
            <h3 data-self-balance-title>
              {{ balanceLeaveType === 'comp_time' ? tr('My comp time', '我的调休') : tr('My annual leave', '我的年假') }}
            </h3>
          </div>
          <!-- W5-1 / OD-W5-7: leave-type toggle drives the #4562-parameterized read path. The two
               buttons carry ONLY closed-set literals; the parent re-validates before fetching. -->
          <div class="attendance-ew__balance-toggle" role="group" :aria-label="tr('Leave type', '假期类型')">
            <button
              type="button"
              class="attendance__btn"
              :class="{ 'attendance__btn--primary': balanceLeaveType === 'annual' }"
              data-self-balance-type="annual"
              :aria-pressed="balanceLeaveType === 'annual'"
              @click="$emit('changeBalanceLeaveType', 'annual')"
            >
              {{ tr('Annual leave', '年假') }}
            </button>
            <button
              type="button"
              class="attendance__btn"
              :class="{ 'attendance__btn--primary': balanceLeaveType === 'comp_time' }"
              data-self-balance-type="comp_time"
              :aria-pressed="balanceLeaveType === 'comp_time'"
              @click="$emit('changeBalanceLeaveType', 'comp_time')"
            >
              {{ tr('Comp time', '调休') }}
            </button>
          </div>
        </div>
        <p v-if="annualSelfBalanceLoading" class="attendance__field-hint">{{ tr('Loading...', '加载中...') }}</p>
        <p v-else-if="annualSelfBalanceError" class="attendance__error" data-annual-self-balance-error>{{ annualSelfBalanceError }}</p>
        <div v-else-if="annualSelfBalanceSummary" class="attendance__selfbalance" data-annual-self-balance>
          <div class="attendance__selfbalance-remaining">
            <strong>{{ remainingBalanceLabel }}</strong> {{ tr('remaining', '剩余') }}
          </div>
          <small class="attendance__field-hint">
            {{ tr('Granted', '已发放') }} {{ grantedBalanceLabel }} ·
            {{ tr('Used', '已用') }} {{ usedBalanceLabel }} ·
            {{ tr('Expired', '已过期') }} {{ expiredBalanceLabel }}
          </small>
        </div>
        <p v-else class="attendance__field-hint">
          {{ balanceLeaveType === 'comp_time' ? tr('No comp-time balance yet.', '暂无调休余额。') : tr('No annual leave balance yet.', '暂无年假余额。') }}
        </p>
        <!-- W5-1 self face entry (⑤ comp_time trace): canonical query-form deep link (R2 — zero
             hash); the click is intercepted for the in-page preset + scroll, the href itself stays
             a real, shareable canonical link. Read-only entry: 查看依据 never carries a write. -->
        <p v-if="balanceLeaveType === 'comp_time' && balanceTraceHref" class="attendance__field-hint">
          <a
            :href="balanceTraceHref"
            data-self-balance-trace-link
            @click.prevent="$emit('openBalanceTrace')"
          >
            {{ tr('View basis (decision trace)', '查看依据（决策轨迹）') }}
          </a>
        </p>
      </div>

      <div class="attendance__card attendance__card--selfservice attendance-ew__tools-deemphasized attendance-ew__rules" data-selfservice-card="rules">
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
        <summary class="attendance__details-summary attendance-ew__history-filters-summary">
          <span class="attendance-ew__history-filters-title">
            {{ tr('Date, org, and user filters', '日期 / 组织 / 用户筛选') }}
          </span>
          <span class="attendance-ew__history-filters-range" data-attendance-history-filter-range>
            {{ historyFilterRangeLabel }}
          </span>
        </summary>
        <div class="attendance__filters attendance-ew__history-filters-panel">
          <slot name="historyFilters" />
        </div>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AttendanceEmployeeCommonIcon from './AttendanceEmployeeCommonIcon.vue'
import type { AttendanceOverviewAttentionItem } from './attendanceOverviewPriority'
import {
  type EmployeeQuickActionIcons,
  resolveEmployeeQuickActionIcons,
} from './attendanceEmployeeWorkspaceCommonIcons'
import {
  formatLateEarlyPair,
  formatLeaveBalanceMinutes,
  formatWorkDurationMinutes,
  greetingHeadline,
  isClockedIn,
  resolveHeroPunchEmphasis,
  resolveTodoMark,
  suggestOffDutyTime,
  workWindowShortLabel,
} from './attendanceEmployeeWorkspacePresentation'

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

const props = defineProps<{
  tr: TranslateFn
  // Today band
  heroClockTime: string
  heroClockDate: string
  heroClockTimezone?: string
  punching: boolean
  // Punch button release (fix/attendance-punch-button-release, 2026-08-21):
  // display-only — never used to disable anything. `punching` alone still
  // gates the hero/note-retry buttons; this only drives the non-blocking
  // "Updating..." hint on the status card while the post-punch refresh
  // (refreshAll() / loadRequests()) runs in the background.
  refreshingAfterPunch: boolean
  heroTimeline: { checkIn: string | null; checkOut: string | null } | null
  todayStateHint?: string
  punchOutdoorNoteRequired: boolean
  punchOutdoorNoteDraft: string
  workbenchStatusDescription: string
  workbenchRecordStatus: string | null
  workbenchFocusDateLabel: string | null
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
  employeeQuickActionIcons?: Partial<EmployeeQuickActionIcons> | null
  // Tools band: annual balance
  annualSelfBalanceLoading: boolean
  annualSelfBalanceError: string | null
  annualSelfBalanceSummary: AnnualBalanceSummary | null
  // W5-1 / OD-W5-7 (#4562 leaveTypeCode channel): which leave-type balance the card shows.
  // Closed set 'annual' | 'comp_time' — the PARENT validates before fetching (UI 输入自验);
  // this component only re-emits the literal the toggle button carries.
  balanceLeaveType: 'annual' | 'comp_time'
  // Canonical query-form deep link into the self decision-trace section (R2: never hash-form) —
  // rendered as the「查看依据」entry on the comp_time face only (⑤ trace is comp_time-scoped).
  balanceTraceHref: string
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
  // Display-only history-range hint on the collapsed OD-O2 disclosure.
  historyFromDate?: string
  historyToDate?: string
  historyOrgId?: string
  historyUserId?: string
}>()

defineEmits<{
  punch: [eventType: 'check_in' | 'check_out']
  retryPunchNote: []
  'update:punchOutdoorNoteDraft': [value: string]
  statusAction: []
  selfServiceAction: [action: WorkspaceSelfServiceActionKey]
  // W5-1: balance leave-type toggle (payload = closed-set literal; parent validates) +
  // the「查看依据」in-page entry into the self decision-trace section.
  changeBalanceLeaveType: [code: 'annual' | 'comp_time']
  openBalanceTrace: []
}>()

const resolvedQuickIcons = computed(() => resolveEmployeeQuickActionIcons(props.employeeQuickActionIcons))

const commonTiles = computed(() => [
  {
    action: 'missing-punch' as const,
    emitAction: 'missing-punch' as const,
    tone: 'makeup',
    icon: resolvedQuickIcons.value.makeup,
    label: props.tr('Makeup punch', '补卡'),
  },
  {
    action: 'leave' as const,
    emitAction: 'leave' as const,
    tone: 'leave',
    icon: resolvedQuickIcons.value.leave,
    label: props.tr('Leave', '请假'),
  },
  {
    action: 'overtime' as const,
    emitAction: 'overtime' as const,
    tone: 'overtime',
    icon: resolvedQuickIcons.value.overtime,
    label: props.tr('Overtime', '加班'),
  },
  {
    action: 'shift-swap' as const,
    emitAction: 'shift_swap' as const,
    tone: 'swap',
    icon: resolvedQuickIcons.value.swap,
    label: props.tr('Shift swap', '换班'),
  },
])

const historyFilterRangeLabel = computed(() => {
  const from = props.historyFromDate?.trim() || '—'
  const to = props.historyToDate?.trim() || '—'
  const extras: string[] = []
  const org = props.historyOrgId?.trim()
  const user = props.historyUserId?.trim()
  if (org) extras.push(`${props.tr('Org', '组织')} ${org}`)
  if (user) extras.push(`${props.tr('User', '用户')} ${user}`)
  return extras.length > 0 ? `${from} – ${to} · ${extras.join(' · ')}` : `${from} – ${to}`
})

const greetingText = computed(() => greetingHeadline(props.tr, props.heroClockTime))

const windowShort = computed(() => workWindowShortLabel(props.selfRulesWorkWindowSummary))

const greetingSubline = computed(() => {
  const datePart = props.heroClockDate
  const window = windowShort.value
  if (window) {
    return props.tr(`${datePart}, ${window}`, `${datePart}, ${window}`)
  }
  return datePart
})

const clockedIn = computed(() => isClockedIn(props.heroTimeline))

const clockedOut = computed(() => Boolean(props.heroTimeline?.checkOut))

const punchEmphasis = computed(() => props.todayStateHint ? 'unknown' : resolveHeroPunchEmphasis(props.heroTimeline))

const todoMark = computed(() => resolveTodoMark(props.attentionItem.key))

function punchButtonClass(which: 'check_in' | 'check_out'): string {
  if (punchEmphasis.value === 'complete') return 'attendance-ew__punch-btn--complete'
  return punchEmphasis.value === which
    ? 'attendance-ew__punch-btn--next'
    : 'attendance-ew__punch-btn--rest'
}

const offDutySuggest = computed(() => suggestOffDutyTime(props.selfRulesWorkWindowSummary))
const workbenchHoursLabel = computed(() => props.workbenchFocusDateLabel
  ? `${props.tr('Hours', '工时')} · ${props.workbenchFocusDateLabel}`
  : props.tr('Hours', '工时'))

const clockStatusLine = computed(() => {
  if (props.todayStateHint) return props.todayStateHint
  if (clockedOut.value) return props.tr('Clocked out', '已下班')
  if (!clockedIn.value) return props.tr('Not clocked in yet', '尚未上班')
  const suggestAt = offDutySuggest.value
  if (suggestAt) {
    return props.tr(
      `Clocked in · Suggest clocking out after ${suggestAt}`,
      `已上班 · 建议 ${suggestAt} 后下班打卡`,
    )
  }
  return props.tr('Clocked in', '已上班')
})

const workDurationLabel = computed(() => props.todayStateHint ? '—' : formatWorkDurationMinutes(props.workbenchWorkMinutes, props.tr))

const remainingBalanceLabel = computed(() =>
  formatLeaveBalanceMinutes(props.annualSelfBalanceSummary?.remainingMinutes, props.tr),
)
const grantedBalanceLabel = computed(() =>
  formatLeaveBalanceMinutes(props.annualSelfBalanceSummary?.grantedMinutes, props.tr),
)
const usedBalanceLabel = computed(() =>
  formatLeaveBalanceMinutes(props.annualSelfBalanceSummary?.exhaustedMinutes, props.tr),
)
const expiredBalanceLabel = computed(() =>
  formatLeaveBalanceMinutes(props.annualSelfBalanceSummary?.expiredMinutes, props.tr),
)

const lateEarlyDisplay = computed(() => formatLateEarlyPair(props.workbenchLateEarlyLabel, props.tr))

const metricInTime = computed(() => props.heroTimeline?.checkIn ?? '--:--')

const metricOutTime = computed(() => props.heroTimeline?.checkOut ?? '--:--')

const hasRequestBody = computed(() =>
  props.requestsTotal > 0 || props.selfServiceRecentRequests.length > 0,
)
</script>

<style scoped>
/* Employee-workspace chrome only. First-viewport IA: desktop punch|待办+申请
   footer, 常用 full-width below; mobile punch → 待办+申请 footer → 常用.
   Visual system (2026-10-09): one card elevation (--ms-shadow-card),
   --ms-radius-lg, --ms-border-light, type via --ms-text-1/2/3.
   Primary blue is reserved for the next punch action. */
.attendance-ew {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-5);
  min-width: 0;
  color: var(--ms-text-1);
}

.attendance-ew__greeting {
  display: flex;
  align-items: flex-end;
  gap: var(--ms-space-3);
  min-width: 0;
}

.attendance-ew__greeting-copy {
  min-width: 0;
}

.attendance-ew__hello {
  margin: 0;
  font-size: 28px;
  line-height: 1.2;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
  letter-spacing: -0.02em;
}

.attendance-ew__hello-sub {
  margin: var(--ms-space-1) 0 0;
  font-size: 14px;
  line-height: 1.45;
  color: var(--ms-text-2);
}

.attendance-ew__primary {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  gap: var(--ms-space-4);
  align-items: stretch;
  min-width: 0;
}

.attendance-ew__today {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  min-width: 0;
}

.attendance-ew__hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-5);
  min-width: 0;
}

.attendance-ew__hero-timezone,
.attendance-ew__clock-status {
  display: inline-flex;
  align-items: center;
  gap: var(--ms-space-2);
  margin: var(--ms-space-2) 0 0;
  font-size: 14px;
  line-height: 1.4;
  color: var(--ms-text-2);
}

.attendance-ew__clock-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ms-text-3);
}

.attendance-ew__clock-dot--check_in {
  background: var(--ms-color-warning);
}

.attendance-ew__clock-dot--check_out {
  background: var(--ms-color-primary);
}

.attendance-ew__clock-dot--complete {
  background: var(--ms-color-success);
}

.attendance-ew__metrics {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  min-width: 0;
  padding-top: var(--ms-space-3);
  margin-top: var(--ms-space-2);
  border-top: 1px solid var(--ms-border-light);
}

.attendance-ew__metrics .attendance__selfservice-lead {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.attendance-ew__metrics .attendance__field-hint--strong {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.attendance-ew__attention {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  min-width: 0;
  min-height: 100%;
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
  padding: var(--ms-space-5);
}

.attendance-ew__todo-head {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
}

.attendance-ew__todo-head h3 {
  margin: 0;
  font-size: var(--ms-font-size-section-title);
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}

.attendance-ew__todo-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger-dark-2);
  font-size: 12px;
  font-weight: var(--ms-font-weight-title);
  line-height: 18px;
  text-align: center;
}

.attendance-ew__todo-row {
  display: flex;
  align-items: center;
  gap: var(--ms-space-3);
  min-width: 0;
}

.attendance-ew__todo-mark {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: var(--ms-radius-lg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
}

.attendance-ew__todo-mark--makeup {
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
}

.attendance-ew__todo-mark--leave {
  background: var(--el-color-success-light-9);
  color: var(--ms-color-success);
}

.attendance-ew__todo-mark--review {
  background: var(--el-color-warning-light-9);
  color: var(--ms-color-warning);
}

.attendance-ew__todo-mark--setup {
  background: var(--el-color-info-light-9);
  color: var(--ms-color-info);
}

.attendance-ew__todo-mark--clear {
  background: var(--el-color-success-light-9);
  color: var(--ms-color-success);
}

.attendance-ew__todo-mark :deep(svg) {
  width: 18px;
  height: 18px;
}

.attendance-ew__todo-copy {
  min-width: 0;
  flex: 1 1 auto;
}

.attendance-ew__todo-copy strong,
.attendance-ew__todo-empty strong {
  display: block;
  font-size: 15px;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}

.attendance-ew__todo-copy p,
.attendance-ew__todo-empty p,
.attendance-ew__attention p {
  margin: var(--ms-space-1) 0 0;
  color: var(--ms-text-3);
  font-size: 13px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.attendance-ew__todo-link {
  flex: 0 0 auto;
  border: 1px solid var(--el-color-primary-light-7);
  background: var(--el-color-primary-light-9);
  padding: 6px var(--ms-space-3);
  border-radius: var(--ms-radius-md);
  color: var(--ms-color-primary);
  font-size: 13px;
  font-weight: var(--ms-font-weight-title);
  cursor: pointer;
}

.attendance-ew__todo-link:hover {
  background: var(--el-color-primary-light-8);
}

.attendance-ew__todo-link:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 2px;
}

.attendance-ew__todo-empty {
  display: flex;
  align-items: flex-start;
  gap: var(--ms-space-3);
  min-width: 0;
}

.attendance-ew__request-footer {
  margin-top: auto;
  padding-top: var(--ms-space-3);
  border-top: 1px solid var(--ms-border-light);
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  min-width: 0;
}

.attendance-ew__request-footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-3);
  min-width: 0;
}

.attendance-ew__request-footer-row h3 {
  margin: 0;
  font-size: 15px;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}

.attendance-ew__request-count {
  min-width: 20px;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
  font-size: 12px;
  font-weight: var(--ms-font-weight-title);
  line-height: 20px;
  text-align: center;
}

.attendance-ew__request-empty {
  color: var(--ms-text-3);
  font-size: 13px;
  line-height: 1.4;
}

.attendance-ew__common {
  min-width: 0;
}

.attendance-ew__common .attendance__requests-header {
  margin: 0;
}

.attendance-ew__common h3 {
  margin: 0;
  font-size: var(--ms-font-size-section-title);
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}

.attendance-ew__common-hint {
  margin: var(--ms-space-1) 0 0;
  color: var(--ms-text-3);
  font-size: 13px;
  line-height: 1.45;
}

.attendance-ew__tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--ms-space-4);
  min-width: 0;
}

.attendance-ew__tools-deemphasized {
  opacity: 1;
}

.attendance-ew__tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--ms-space-2);
}

.attendance-ew__tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--ms-space-2);
  width: 100%;
  min-width: 0;
  min-height: 88px;
  padding: var(--ms-space-2) var(--ms-space-1) var(--ms-space-2);
  border: none;
  border-radius: var(--ms-radius-lg);
  background: transparent;
  color: var(--ms-text-1);
  font-size: 13px;
  line-height: 1.3;
  cursor: pointer;
}

.attendance-ew__tile:hover {
  background: var(--ms-bg-page);
}

.attendance-ew__tile:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 2px;
}

.attendance-ew__tile-label {
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}

.attendance-ew__tile-icon {
  width: 48px;
  height: 48px;
  border-radius: var(--ms-radius-lg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
  box-shadow: none;
}

.attendance-ew__tile-icon :deep(svg) {
  width: 24px;
  height: 24px;
}

.attendance-ew__tile-icon--makeup {
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
}

.attendance-ew__tile-icon--leave {
  background: var(--el-color-success-light-9);
  color: var(--ms-color-success);
}

.attendance-ew__tile-icon--overtime {
  background: var(--el-color-warning-light-9);
  color: var(--ms-color-warning);
}

.attendance-ew__tile-icon--swap {
  background: var(--el-color-info-light-9);
  color: var(--ms-color-info);
}

.attendance-ew__history-filters {
  grid-column: 1 / -1;
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  padding: var(--ms-space-3) var(--ms-space-4);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
  min-width: 0;
  max-width: 100%;
}

.attendance-ew__history-filters[open] {
  background: var(--ms-bg-card);
}

.attendance-ew__history-filters-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--ms-space-2) var(--ms-space-4);
  min-width: 0;
}

.attendance-ew__history-filters-title {
  min-width: 0;
  color: var(--ms-text-1);
}

.attendance-ew__history-filters-range {
  font-weight: 500;
  color: var(--ms-text-2);
  font-variant-numeric: tabular-nums;
  min-width: 0;
}

.attendance__filters {
  display: flex;
  align-items: center;
  gap: var(--ms-space-4);
  flex-wrap: wrap;
  min-width: 0;
}

.attendance-ew__history-filters-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  align-items: end;
  gap: var(--ms-space-3) var(--ms-space-4);
  padding-top: var(--ms-space-3);
  min-width: 0;
  max-width: 100%;
}

.attendance-ew__history-filters-panel .attendance__field,
.attendance-ew__history-filters-panel .attendance__btn {
  min-width: 0;
  max-width: 100%;
}

.attendance__punch-note {
  display: flex;
  align-items: flex-end;
  gap: var(--ms-space-3);
  margin-top: var(--ms-space-3);
  flex-wrap: wrap;
}

.attendance__field {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  font-size: 12px;
  color: var(--ms-text-2);
}

.attendance__field input {
  padding: 6px 10px;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-md);
  min-width: 0;
  width: 100%;
  max-width: 100%;
  color: var(--ms-text-1);
  background: var(--ms-bg-card);
}

.attendance__field-hint {
  color: var(--ms-text-3);
  font-size: 12px;
}

.attendance__field-hint--error {
  color: var(--ms-color-danger);
}

.attendance__field-hint--strong {
  display: inline-flex;
  margin-top: var(--ms-space-2);
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-2);
}

.attendance__btn {
  padding: 8px 14px;
  border-radius: var(--ms-radius-md);
  border: 1px solid var(--ms-border);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
}

.attendance-ew__balance-toggle {
  display: inline-flex;
  gap: var(--ms-space-1);
}

.attendance-ew__balance-toggle .attendance__btn {
  padding: 4px 10px;
  font-size: 12px;
}

.attendance__btn--primary {
  background: var(--ms-color-primary);
  border-color: var(--ms-color-primary);
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
  gap: var(--ms-space-2);
}

.attendance__status {
  font-size: 13px;
  color: var(--ms-color-success);
}

.attendance__status--error {
  color: var(--ms-color-danger);
}

.attendance__card {
  background: var(--ms-bg-card);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  padding: var(--ms-space-5);
  box-shadow: var(--ms-shadow-card);
}

.attendance__card--selfservice {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  min-width: 0;
}

.attendance__summary--workbench {
  margin-top: 0;
}

.attendance__selfservice-lead {
  margin: 0;
  color: var(--ms-text-2);
  line-height: 1.5;
  font-size: 13px;
}

.attendance__selfservice-callout {
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-page);
  padding: var(--ms-space-3);
  display: flex;
  justify-content: space-between;
  gap: var(--ms-space-3);
  align-items: center;
}

.attendance__selfservice-callout-copy {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.attendance__selfservice-callout-header {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
}

.attendance__selfservice-callout-copy p {
  margin: 0;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.attendance__request-list--compact {
  gap: var(--ms-space-2);
}

.attendance__request-item {
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-3);
  background: var(--ms-bg-page);
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.attendance__request-meta {
  display: flex;
  gap: var(--ms-space-3);
  font-size: 12px;
  color: var(--ms-text-3);
}

.attendance__request-note {
  margin: 0;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.attendance__chip-list {
  margin-top: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

.attendance__status-chip {
  margin-left: 0;
  font-size: 12px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  border: 1px solid var(--ms-border-light);
  align-self: flex-start;
}

.attendance__status-chip--pending { background: var(--el-color-warning-light-9); color: var(--el-color-warning-dark-2); border-color: transparent; }
.attendance__status-chip--approved { background: var(--el-color-success-light-9); color: var(--el-color-success-dark-2); border-color: transparent; }
.attendance__status-chip--normal { background: var(--el-color-success-light-9); color: var(--el-color-success-dark-2); border-color: transparent; }
.attendance__status-chip--late { background: var(--el-color-warning-light-9); color: var(--el-color-warning-dark-2); border-color: transparent; }
.attendance__status-chip--early_leave { background: var(--el-color-info-light-9); color: var(--el-color-info-dark-2); border-color: transparent; }
.attendance__status-chip--late_early { background: var(--el-color-danger-light-9); color: var(--el-color-danger-dark-2); border-color: transparent; }
.attendance__status-chip--partial { background: var(--el-color-primary-light-9); color: var(--el-color-primary-dark-2); border-color: transparent; }
.attendance__status-chip--adjusted { background: var(--el-color-primary-light-9); color: var(--el-color-primary-dark-2); border-color: transparent; }
.attendance__status-chip--off { background: var(--ms-bg-page); color: var(--ms-text-2); border-color: var(--ms-border-light); }
.attendance__status-chip--absent { background: var(--ms-bg-page); color: var(--ms-text-2); border-color: var(--ms-border-light); }
.attendance__status-chip--rejected { background: var(--el-color-danger-light-9); color: var(--el-color-danger-dark-2); border-color: transparent; }
.attendance__status-chip--cancelled { background: var(--ms-bg-page); color: var(--ms-text-2); border-color: var(--ms-border-light); }

.attendance__summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--ms-space-2);
  margin-top: var(--ms-space-2);
  min-width: 0;
}

.attendance__summary-item {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  background: transparent;
  border-radius: 0;
  padding: var(--ms-space-1) 0;
}

.attendance__summary-item span {
  font-size: 12px;
  color: var(--ms-text-3);
}

.attendance__summary-item strong {
  color: var(--ms-text-1);
  font-weight: var(--ms-font-weight-title);
}

.attendance__details-summary {
  cursor: pointer;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}

.attendance__error {
  color: var(--ms-color-danger);
  font-size: 12px;
}

.attendance__empty {
  color: var(--ms-text-3);
  font-size: 13px;
}

.attendance__selfbalance-remaining {
  font-size: 28px;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.attendance__selfbalance-remaining strong {
  font-weight: var(--ms-font-weight-title);
}

.attendance__hero-punch {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  min-width: 0;
  padding: var(--ms-space-5) var(--ms-space-5) var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
}

.attendance__hero-clock {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
}

.attendance__hero-time {
  font-size: clamp(48px, 5vw, 64px);
  font-weight: var(--ms-font-weight-title);
  line-height: 1;
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.03em;
}

.attendance__hero-time.attendance__hero-time--unavailable {
  font-size: 20px;
  line-height: 1.4;
  letter-spacing: normal;
}

.attendance__hero-actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--ms-space-2);
  flex: 0 0 auto;
}

.attendance__btn--hero {
  min-height: 44px;
  min-width: 132px;
  font-size: 15px;
  font-weight: var(--ms-font-weight-title);
  border-radius: var(--ms-radius-lg);
  box-shadow: none;
}

.attendance__btn--hero-secondary {
  min-height: 40px;
  min-width: 132px;
  font-size: 14px;
  font-weight: var(--ms-font-weight-title);
  border-radius: var(--ms-radius-lg);
  border-color: var(--el-color-primary-light-7);
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
  box-shadow: none;
}

.attendance-ew__punch-btn--next {
  background: var(--ms-color-primary);
  border-color: var(--ms-color-primary);
  color: #fff;
  box-shadow: none;
  font-weight: var(--ms-font-weight-title);
}

.attendance-ew__punch-btn--rest {
  background: var(--ms-bg-page);
  border-color: var(--ms-border-light);
  color: var(--ms-text-2);
  box-shadow: none;
}

.attendance-ew__punch-btn--rest.attendance__btn--primary {
  background: var(--ms-bg-page);
  border-color: var(--ms-border-light);
  color: var(--ms-text-2);
}

.attendance-ew__punch-btn--complete,
.attendance-ew__punch-btn--complete.attendance__btn--primary {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-7);
  color: var(--ms-color-primary);
  box-shadow: none;
}

.attendance__hero-timeline-node {
  display: inline-flex;
  align-items: center;
  gap: var(--ms-space-1);
}

.attendance__hero-timeline-node--pending {
  color: var(--ms-text-3);
}

.attendance__summary--stat {
  gap: var(--ms-space-3);
}

.attendance__summary-item--stat {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  min-width: 0;
  padding: var(--ms-space-1) 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.attendance__summary-value {
  font-size: 18px;
  line-height: 1.2;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
}

.attendance__summary-value--ok {
  color: var(--ms-color-success);
}

.attendance__summary-value--warning {
  color: var(--ms-color-warning);
}

@media (max-width: 1099px) {
  .attendance-ew__primary {
    grid-template-columns: minmax(0, 1fr);
  }

  .attendance-ew__tools {
    display: flex;
    flex-direction: column;
  }

  .attendance-ew__balance { order: 1; }
  .attendance-ew__rules { order: 2; }
  .attendance-ew__history-filters { order: 3; }
}

@media (max-width: 768px) {
  .attendance-ew {
    gap: var(--ms-space-4);
  }

  .attendance-ew__hello {
    font-size: 26px;
  }

  .attendance__hero-time {
    font-size: 52px;
  }

  .attendance-ew__hero-top {
    flex-direction: column;
    align-items: stretch;
  }

  .attendance__hero-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .attendance__btn--hero,
  .attendance__btn--hero-secondary {
    min-width: 0;
    width: 100%;
  }

  .attendance__summary,
  .attendance__summary--stat {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .attendance__selfservice-callout {
    flex-direction: column;
    align-items: flex-start;
  }

  .attendance-ew__todo-row {
    flex-wrap: wrap;
  }

  .attendance__request-meta {
    flex-direction: column;
    gap: var(--ms-space-1);
  }

  .attendance__filters .attendance__field {
    width: 100%;
  }

  .attendance-ew__history-filters-panel {
    grid-template-columns: minmax(0, 1fr);
  }

  .attendance-ew__balance-toggle .attendance__btn {
    width: auto;
  }

  .attendance-ew__attention,
  .attendance__hero-punch,
  .attendance__card {
    padding: var(--ms-space-4);
  }
}
</style>

<style>
/* Overview page wash only — scoped by the employee overview class, not the app shell. */
.attendance--overview {
  background: var(--ms-bg-page, #f5f6f8);
}
</style>
