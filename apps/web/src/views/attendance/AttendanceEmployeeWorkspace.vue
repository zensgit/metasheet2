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

  Visual follow-up (owner, 2026-08-24): employee-workspace chrome only —
  DingTalk/Feishu employee-page tone. No punch, policy, approval, or API change.
-->
<template>
  <div class="attendance-ew">
    <div class="attendance-ew__greeting" data-attendance-overview-greeting>
      <div class="attendance-ew__greeting-copy">
        <h2 class="attendance-ew__hello">{{ greetingText }}</h2>
        <p class="attendance-ew__hello-sub">{{ greetingSubline }}</p>
      </div>
      <span v-if="workbenchFocusDateLabel" class="attendance-ew__focus-pill">
        {{ tr(`Focus ${workbenchFocusDateLabel}`, `关注 ${workbenchFocusDateLabel}`) }}
      </span>
    </div>

    <!--
      Lock §7 first viewport: daily workspace (punch + status) is the dominant
      column; the one canonical attention item is the supporting column. Status
      banner stays in the today column (lock §4.1 / §5: below the daily
      workspace, never inside the history disclosure). Tools stay below this
      primary row so they cannot compete with today's work.
    -->
    <div class="attendance-ew__primary" data-attendance-overview-primary>
    <div class="attendance-ew__today">
      <div class="attendance__hero-punch" data-testid="attendance-hero-punch">
        <div class="attendance-ew__hero-top">
          <div class="attendance__hero-clock">
            <span class="attendance__hero-time" data-testid="attendance-hero-time">{{ heroClockTime }}</span>
            <p class="attendance-ew__clock-status">{{ clockStatusLine }}</p>
            <p v-if="shiftLine" class="attendance-ew__shift">
              <span class="attendance-ew__shift-dot" aria-hidden="true" />
              {{ shiftLine }}
            </p>
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
              <span>{{ tr("Today's hours", '今日工时') }}</span>
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
      >
        <strong>{{ attentionItem.title }}</strong>
        <p>{{ attentionItem.detail }}</p>
      </div>
      <div v-else class="attendance-ew__todo-row">
        <span
          class="attendance-ew__todo-mark"
          :class="`attendance-ew__todo-mark--${attentionMark.tone}`"
          aria-hidden="true"
        >{{ attentionMark.glyph }}</span>
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
      <p
        v-if="attentionItem.key !== 'all_clear' && attentionItem.key !== 'setup_needed'"
        class="attendance-ew__todo-more"
      >
        {{ tr('No more items', '没有更多事项') }}
      </p>
    </div>
    </div>

    <div class="attendance-ew__tools">
      <div class="attendance__card attendance__card--selfservice attendance-ew__requests" data-selfservice-card="requests">
        <div class="attendance__requests-header">
          <div>
            <h3>{{ tr('My applications', '我的申请') }}</h3>
            <small v-if="hasRequestBody" class="attendance__field-hint">
              {{ tr('Summarizes the current request backlog from the visible date range.', '汇总当前可见日期区间内的申请处理状态。') }}
            </small>
          </div>
          <strong v-if="hasRequestBody">{{ requestsTotal }}</strong>
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
        <div v-else class="attendance__empty">{{ tr('No pending approvals in this range.', '这个区间里没有待审批的申请') }}</div>
      </div>

      <div class="attendance__card attendance__card--selfservice attendance-ew__actions" data-selfservice-card="actions">
        <div class="attendance__requests-header">
          <div>
            <h3>{{ tr('Common', '常用') }}</h3>
          </div>
          <button
            class="attendance-ew__customize"
            type="button"
            data-attendance-ew-customize
            @click="toggleCustomize"
          >
            {{ customizing ? tr('Done', '完成') : tr('Customize', '自定义') }}
          </button>
        </div>
        <!-- First-screen 常用: all four actions. Icons are original filled
             pictograms; 自定义 swaps the glyph per user in localStorage. -->
        <div class="attendance-ew__tiles">
          <div
            v-for="tile in commonTiles"
            :key="tile.action"
            class="attendance-ew__tile-wrap"
          >
            <button
              class="attendance-ew__tile"
              type="button"
              :data-selfservice-action="tile.action"
              :data-attendance-ew-icon="commonIconPrefs[tile.action]"
              :class="{ 'attendance-ew__tile--picking': pickingAction === tile.action }"
              @click="onCommonTile(tile.action)"
            >
              <span class="attendance-ew__tile-icon" :class="`attendance-ew__tile-icon--${tile.tone}`" aria-hidden="true">
                <AttendanceEmployeeCommonIcon :name="commonIconPrefs[tile.action]" />
              </span>
              <span>{{ tile.label }}</span>
            </button>
            <div
              v-if="customizing && pickingAction === tile.action"
              class="attendance-ew__icon-picker"
              data-attendance-ew-icon-picker
            >
              <button
                v-for="iconId in commonIconIds"
                :key="iconId"
                type="button"
                class="attendance-ew__icon-option"
                :class="{ 'attendance-ew__icon-option--active': commonIconPrefs[tile.action] === iconId }"
                :data-attendance-ew-icon-option="iconId"
                :aria-label="iconId"
                @click.stop="assignCommonIcon(tile.action, iconId)"
              >
                <AttendanceEmployeeCommonIcon :name="iconId" />
              </button>
            </div>
          </div>
        </div>
        <button
          class="attendance-ew__records-link"
          type="button"
          data-selfservice-action="records"
          @click="$emit('selfServiceAction', 'records')"
        >
          {{ tr('Review records', '查看记录') }}
        </button>
        <p class="attendance__field-hint attendance__field-hint--strong">
          {{ selfServiceQuickActionHint }}
        </p>
      </div>

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
            <strong>{{ annualSelfBalanceSummary.remainingMinutes }}</strong> {{ tr('min remaining', '分钟剩余') }}
          </div>
          <small class="attendance__field-hint">
            {{ tr('Granted', '已发放') }} {{ annualSelfBalanceSummary.grantedMinutes }} ·
            {{ tr('Used', '已用') }} {{ annualSelfBalanceSummary.exhaustedMinutes }} ·
            {{ tr('Expired', '已过期') }} {{ annualSelfBalanceSummary.expiredMinutes }}
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
import { computed, onMounted, ref } from 'vue'
import AttendanceEmployeeCommonIcon from './AttendanceEmployeeCommonIcon.vue'
import type { AttendanceOverviewAttentionItem } from './attendanceOverviewPriority'
import {
  COMMON_ICON_IDS,
  type CommonActionKey,
  type CommonIconId,
  type CommonIconPrefs,
  loadCommonIconPrefs,
  saveCommonIconPrefs,
} from './attendanceEmployeeWorkspaceCommonIcons'
import {
  formatLateEarlyPair,
  formatWorkDurationMinutes,
  greetingHeadline,
  isClockedIn,
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
  punching: boolean
  // Punch button release (fix/attendance-punch-button-release, 2026-08-21):
  // display-only — never used to disable anything. `punching` alone still
  // gates the hero/note-retry buttons; this only drives the non-blocking
  // "Updating..." hint on the status card while the post-punch refresh
  // (refreshAll() / loadRequests()) runs in the background.
  refreshingAfterPunch: boolean
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
}>()

const emit = defineEmits<{
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

const commonIconIds = COMMON_ICON_IDS
const commonIconPrefs = ref<CommonIconPrefs>(loadCommonIconPrefs())
const customizing = ref(false)
const pickingAction = ref<CommonActionKey | null>(null)

const commonTiles = computed(() => [
  { action: 'missing-punch' as const, tone: 'makeup', label: props.tr('Makeup punch', '补卡') },
  { action: 'leave' as const, tone: 'leave', label: props.tr('Leave', '请假') },
  { action: 'overtime' as const, tone: 'overtime', label: props.tr('Overtime', '加班') },
  { action: 'shift-swap' as const, tone: 'swap', label: props.tr('Shift swap', '换班') },
])

onMounted(() => {
  commonIconPrefs.value = loadCommonIconPrefs()
})

function toggleCustomize(): void {
  customizing.value = !customizing.value
  if (!customizing.value) pickingAction.value = null
}

function onCommonTile(action: CommonActionKey): void {
  if (customizing.value) {
    pickingAction.value = pickingAction.value === action ? null : action
    return
  }
  emit('selfServiceAction', action === 'shift-swap' ? 'shift_swap' : action)
}

function assignCommonIcon(action: CommonActionKey, iconId: CommonIconId): void {
  commonIconPrefs.value = { ...commonIconPrefs.value, [action]: iconId }
  saveCommonIconPrefs(commonIconPrefs.value)
  pickingAction.value = null
}

const greetingText = computed(() => greetingHeadline(props.tr, props.heroClockTime))

const windowShort = computed(() => workWindowShortLabel(props.selfRulesWorkWindowSummary))

const greetingSubline = computed(() => {
  const datePart = props.heroClockDate
  const window = windowShort.value
  if (window) {
    return props.tr(`${datePart}, working ${window} today`, `${datePart}，今天按 ${window} 出勤`)
  }
  return datePart
})

const shiftLine = computed(() => {
  const window = windowShort.value
  if (!window) return ''
  return props.tr(`Fixed shift ${window}`, `固定班次 ${window}`)
})

const clockedIn = computed(() => isClockedIn(props.heroTimeline, props.workbenchLatestPunchLabel))

const offDutySuggest = computed(() => suggestOffDutyTime(props.selfRulesWorkWindowSummary))

const clockStatusLine = computed(() => {
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

const workDurationLabel = computed(() => formatWorkDurationMinutes(props.workbenchWorkMinutes, props.tr))

const lateEarlyDisplay = computed(() => formatLateEarlyPair(props.workbenchLateEarlyLabel, props.tr))

const metricInTime = computed(() => props.heroTimeline?.checkIn ?? props.workbenchLatestPunchLabel ?? '--:--')

const metricOutTime = computed(() => props.heroTimeline?.checkOut ?? '--:--')

const hasRequestBody = computed(() =>
  props.requestsTotal > 0 || props.selfServiceRecentRequests.length > 0,
)

const attentionMark = computed(() => {
  switch (props.attentionItem.key) {
    case 'anomaly':
      return { glyph: '缺', tone: 'missing' }
    case 'punch_failure':
      return { glyph: '!', tone: 'missing' }
    case 'request_pending':
    case 'request_rejected':
      return { glyph: '审', tone: 'pending' }
    case 'setup_needed':
      return { glyph: '设', tone: 'setup' }
    case 'record_review':
    case 'unknown_status':
      return { glyph: '记', tone: 'review' }
    default:
      return { glyph: '·', tone: 'setup' }
  }
})
</script>

<style scoped>
/* Employee-workspace chrome only. First-viewport IA is unchanged
   (desktop punch|todo, mobile punch → status → attention → tools). */
.attendance-ew {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-4, 16px);
  min-width: 0;
}

.attendance-ew__greeting {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.attendance-ew__greeting-copy {
  min-width: 0;
}

.attendance-ew__hello {
  margin: 0;
  font-size: 28px;
  line-height: 1.2;
  font-weight: 700;
  color: #1f2329;
  letter-spacing: -0.02em;
}

.attendance-ew__hello-sub {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.4;
  color: #8f959e;
}

.attendance-ew__focus-pill {
  flex: 0 0 auto;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(31, 35, 41, 0.06);
  color: #646a73;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
}

.attendance-ew__primary {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  gap: var(--ms-space-4, 16px);
  align-items: start;
  min-width: 0;
}

.attendance-ew__today {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3, 12px);
  min-width: 0;
}

.attendance-ew__hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-width: 0;
}

.attendance-ew__clock-status {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.4;
  color: #646a73;
}

.attendance-ew__shift {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 12px;
  color: #8f959e;
}

.attendance-ew__shift-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #3370ff;
}

.attendance-ew__metrics {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding-top: 14px;
  margin-top: 4px;
  border-top: 1px solid rgba(31, 35, 41, 0.06);
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
  gap: 12px;
  min-width: 0;
  border: none;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(31, 45, 82, 0.06);
  padding: 16px 18px;
}

.attendance-ew__todo-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.attendance-ew__todo-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
  color: #1f2329;
}

.attendance-ew__todo-badge {
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: #f54a45;
  color: #fff;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}

.attendance-ew__todo-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.attendance-ew__todo-mark {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 650;
}

.attendance-ew__todo-mark--missing {
  background: #fff1f0;
  color: #f54a45;
}

.attendance-ew__todo-mark--review {
  background: #fff7e8;
  color: #ff7d00;
}

.attendance-ew__todo-mark--pending {
  background: #e8f3ff;
  color: #3370ff;
}

.attendance-ew__todo-mark--setup {
  background: #f5f6f7;
  color: #646a73;
}

.attendance-ew__todo-copy {
  min-width: 0;
  flex: 1 1 auto;
}

.attendance-ew__todo-copy strong,
.attendance-ew__todo-empty strong {
  display: block;
  font-size: 14px;
  color: #1f2329;
}

.attendance-ew__todo-copy p,
.attendance-ew__todo-empty p,
.attendance-ew__attention p {
  margin: 2px 0 0;
  color: #8f959e;
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.attendance-ew__todo-link {
  flex: 0 0 auto;
  border: none;
  background: none;
  padding: 0;
  color: #3370ff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.attendance-ew__todo-empty {
  min-width: 0;
}

.attendance-ew__todo-more {
  margin: 0;
  font-size: 12px;
  color: #bbbfc4;
}

.attendance-ew__tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--ms-space-4, 16px);
  min-width: 0;
}

.attendance-ew__tools-deemphasized {
  opacity: 0.92;
}

.attendance-ew__customize {
  border: none;
  background: none;
  padding: 0;
  color: #3370ff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.attendance-ew__tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.attendance-ew__tile-wrap {
  position: relative;
  min-width: 0;
}

.attendance-ew__tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 4px 0;
  border: none;
  background: transparent;
  color: #1f2329;
  font-size: 12px;
  line-height: 1.3;
  cursor: pointer;
}

.attendance-ew__tile--picking .attendance-ew__tile-icon {
  box-shadow: 0 0 0 2px #fff, 0 0 0 4px #3370ff, 0 8px 16px rgba(51, 112, 255, 0.22);
}

.attendance-ew__tile-icon {
  width: 52px;
  height: 52px;
  border-radius: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  box-shadow: 0 6px 14px rgba(31, 45, 82, 0.14);
}

.attendance-ew__tile-icon :deep(svg) {
  width: 26px;
  height: 26px;
}

.attendance-ew__tile-icon--makeup {
  background: linear-gradient(180deg, #5b8cff 0%, #3370ff 100%);
}

.attendance-ew__tile-icon--leave {
  background: linear-gradient(180deg, #34c759 0%, #00b42a 100%);
}

.attendance-ew__tile-icon--overtime {
  background: linear-gradient(180deg, #ff9a2e 0%, #ff7d00 100%);
}

.attendance-ew__tile-icon--swap {
  background: linear-gradient(180deg, #9b8af0 0%, #7b67ee 100%);
}

.attendance-ew__icon-picker {
  position: absolute;
  z-index: 3;
  left: 50%;
  top: calc(100% + 6px);
  transform: translateX(-50%);
  display: grid;
  grid-template-columns: repeat(4, 32px);
  gap: 6px;
  padding: 8px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 10px 28px rgba(31, 45, 82, 0.16);
}

.attendance-ew__tile-wrap:first-child .attendance-ew__icon-picker {
  left: 0;
  transform: none;
}

.attendance-ew__tile-wrap:last-child .attendance-ew__icon-picker {
  left: auto;
  right: 0;
  transform: none;
}

.attendance-ew__icon-option {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: #3d4450;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}

.attendance-ew__icon-option :deep(svg) {
  width: 16px;
  height: 16px;
}

.attendance-ew__icon-option--active {
  box-shadow: 0 0 0 2px #3370ff;
}

.attendance-ew__records-link {
  align-self: flex-start;
  border: none;
  background: none;
  padding: 0;
  color: #8f959e;
  font-size: 12px;
  cursor: pointer;
}

.attendance-ew__history-filters {
  grid-column: 1 / -1;
  border: none;
  border-radius: 16px;
  padding: var(--ms-space-3, 12px) var(--ms-space-4, 16px);
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 4px 16px rgba(31, 45, 82, 0.04);
}

.attendance-ew__history-filters[open] {
  background: #fff;
}

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
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  min-width: 0;
  width: 100%;
  max-width: 100%;
}

.attendance__field-hint {
  color: #8f959e;
  font-size: 11px;
}

.attendance__field-hint--error {
  color: #c0392b;
}

.attendance__field-hint--strong {
  display: inline-flex;
  margin-top: 8px;
  font-weight: 600;
}

.attendance__btn {
  padding: 8px 14px;
  border-radius: 999px;
  border: 1px solid #e5e6eb;
  background: #fff;
  cursor: pointer;
}

.attendance-ew__balance-toggle {
  display: inline-flex;
  gap: 4px;
}

.attendance-ew__balance-toggle .attendance__btn {
  padding: 4px 10px;
  font-size: 12px;
}

.attendance__btn--primary {
  background: linear-gradient(180deg, #4c83ff 0%, #3370ff 100%);
  border-color: transparent;
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
  border: none;
  border-radius: 18px;
  padding: 16px 18px;
  box-shadow: 0 8px 24px rgba(31, 45, 82, 0.06);
}

.attendance__card--selfservice {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.attendance__summary--workbench {
  margin-top: 0;
}

.attendance__selfservice-lead {
  margin: 0;
  color: #646a73;
  line-height: 1.5;
  font-size: 12px;
}

.attendance__selfservice-callout {
  border: none;
  border-radius: 12px;
  background: #f7f9fc;
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
  color: #646a73;
  line-height: 1.5;
}

.attendance__request-list--compact {
  gap: 8px;
}

.attendance__request-item {
  border: none;
  border-radius: 10px;
  padding: 10px;
  background: #f7f9fc;
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
  margin-left: 0;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #f0f0f0;
  align-self: flex-start;
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
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-top: 8px;
  min-width: 0;
}

.attendance__summary-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: transparent;
  border-radius: 0;
  padding: 4px 0;
}

.attendance__summary-item span {
  font-size: 12px;
  color: #8f959e;
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
  color: #8f959e;
  font-size: 13px;
}

.attendance__selfbalance-remaining {
  font-size: 20px;
  font-weight: 600;
  color: var(--ms-text-1);
}

.attendance__hero-punch {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 20px 22px 16px;
  border: none;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(31, 45, 82, 0.06);
}

.attendance__hero-clock {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
}

.attendance__hero-time {
  font-size: clamp(48px, 5vw, 64px);
  font-weight: 650;
  line-height: 1;
  color: #1f2329;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.03em;
}

.attendance__hero-actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  flex: 0 0 auto;
}

.attendance__btn--hero {
  min-height: 44px;
  min-width: 132px;
  font-size: 15px;
  font-weight: 650;
  border-radius: 999px;
  box-shadow: 0 8px 18px rgba(51, 112, 255, 0.28);
}

.attendance__btn--hero-secondary {
  min-height: 40px;
  min-width: 132px;
  font-size: 14px;
  border-radius: 999px;
  border-color: transparent;
  background: #e8f3ff;
  color: #3370ff;
  box-shadow: none;
}

.attendance__hero-timeline-node {
  display: inline-flex;
  align-items: center;
  gap: var(--ms-space-1);
}

.attendance__hero-timeline-node--pending {
  color: var(--ms-text-3, #8f959e);
}

.attendance__summary--stat {
  gap: 12px;
}

.attendance__summary-item--stat {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 4px 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.attendance__summary-value {
  font-size: 16px;
  line-height: 1.2;
  font-weight: 650;
  color: #1f2329;
  font-variant-numeric: tabular-nums;
}

.attendance__summary-value--ok {
  color: #00b42a;
}

.attendance__summary-value--warning {
  color: #ff7d00;
}

@media (max-width: 1099px) {
  .attendance-ew__primary {
    grid-template-columns: minmax(0, 1fr);
  }

  .attendance-ew__tools {
    display: flex;
    flex-direction: column;
  }

  .attendance-ew__actions { order: 1; }
  .attendance-ew__requests { order: 2; }
  .attendance-ew__balance { order: 3; }
  .attendance-ew__rules { order: 4; }
  .attendance-ew__history-filters { order: 5; }
}

@media (max-width: 768px) {
  .attendance-ew__hello {
    font-size: 26px;
  }

  .attendance__hero-time {
    font-size: 54px;
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

  .attendance-ew__focus-pill {
    white-space: normal;
  }

  .attendance__request-meta {
    flex-direction: column;
    gap: 4px;
  }

  .attendance__filters .attendance__field {
    width: 100%;
  }

  .attendance-ew__balance-toggle .attendance__btn {
    width: auto;
  }
}
</style>

<style>
/* Overview page wash only — scoped by the employee overview class, not the app shell. */
.attendance--overview {
  background-color: #f4f6fa;
  background-image: radial-gradient(ellipse 80% 46% at 50% -8%, rgba(51, 112, 255, 0.12), transparent 58%);
}
</style>
