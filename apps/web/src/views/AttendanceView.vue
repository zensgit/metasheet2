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
        <button class="attendance__btn" :disabled="loading" @click="refreshOverviewWithStatus">{{ tr('Refresh', '刷新') }}</button>
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
          <small class="attendance__field-hint">{{ summaryTimezoneContextHint }}</small>
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
            <div class="attendance__calendar-flags">
              <label class="attendance__calendar-flag">
                <input v-model="showLunarLabel" type="checkbox" />
                <span>{{ tr('Lunar', '农历') }}</span>
              </label>
              <label class="attendance__calendar-flag">
                <input v-model="showHolidayBadge" type="checkbox" />
                <span>{{ tr('Holiday', '节假日') }}</span>
              </label>
            </div>
          </div>
          <small class="attendance__field-hint">{{ calendarTimezoneContextHint }}</small>
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
              <span v-if="showLunarLabel && day.lunarLabel" class="attendance__calendar-lunar">{{ day.lunarLabel }}</span>
              <span v-if="showHolidayBadge && day.holidayName" class="attendance__calendar-holiday">{{ day.holidayName }}</span>
            </div>
          </div>
        </div>

        <div class="attendance__card">
          <h3>{{ tr('Adjustment Request', '补卡申请') }}</h3>
          <small class="attendance__field-hint">{{ requestTimezoneContextHint }}</small>
          <div class="attendance__request-form">
            <label class="attendance__field" for="attendance-request-work-date">
              <span>{{ tr('Work date', '工作日期') }}</span>
              <input
                id="attendance-request-work-date"
                name="requestWorkDate"
                v-model="requestForm.workDate"
                type="date"
              />
            </label>
            <label class="attendance__field" for="attendance-request-type">
              <span>{{ tr('Type', '类型') }}</span>
              <select id="attendance-request-type" name="requestType" v-model="requestForm.requestType">
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
                name="requestLeaveType"
                v-model="requestForm.leaveTypeId"
                :disabled="leaveTypes.length === 0"
              >
                <option value="" disabled>{{ tr('Select leave type', '选择请假类型') }}</option>
                <option v-for="item in leaveTypes" :key="item.id" :value="item.id">
                  {{ item.name }}
                </option>
              </select>
            </label>
            <label v-if="isOvertimeRequest" class="attendance__field" for="attendance-request-overtime-rule">
              <span>{{ tr('Overtime rule', '加班规则') }}</span>
              <select
                id="attendance-request-overtime-rule"
                name="requestOvertimeRule"
                v-model="requestForm.overtimeRuleId"
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
              <input
                id="attendance-request-in"
                name="requestedInAt"
                v-model="requestForm.requestedInAt"
                type="datetime-local"
              />
            </label>
            <label class="attendance__field" for="attendance-request-out">
              <span>{{ isLeaveOrOvertimeRequest ? tr('End', '结束') : tr('Requested out', '申请打卡出') }}</span>
              <input
                id="attendance-request-out"
                name="requestedOutAt"
                v-model="requestForm.requestedOutAt"
                type="datetime-local"
              />
            </label>
            <label v-if="isLeaveOrOvertimeRequest" class="attendance__field" for="attendance-request-minutes">
              <span>{{ tr('Duration (min)', '时长（分钟）') }}</span>
              <input
                id="attendance-request-minutes"
                name="requestMinutes"
                v-model="requestForm.minutes"
                type="number"
                min="0"
              />
            </label>
            <label v-if="isLeaveRequest" class="attendance__field" for="attendance-request-attachment">
              <span>{{ tr('Attachment URL', '附件链接') }}</span>
              <input
                id="attendance-request-attachment"
                name="requestAttachment"
                v-model="requestForm.attachmentUrl"
                type="text"
                :placeholder="tr('Optional', '可选')"
              />
            </label>
            <label class="attendance__field attendance__field--full" for="attendance-request-reason">
              <span>{{ tr('Reason', '原因') }}</span>
              <input
                id="attendance-request-reason"
                name="requestReason"
                v-model="requestForm.reason"
                type="text"
                :placeholder="tr('Optional', '可选')"
              />
            </label>
            <button class="attendance__btn attendance__btn--primary" :disabled="requestSubmitting" @click="submitRequest">
              {{ requestSubmitting ? tr('Submitting...', '提交中...') : tr('Submit request', '提交申请') }}
            </button>
          </div>

          <div class="attendance__requests">
            <div class="attendance__requests-header">
              <span>{{ tr('Recent requests', '最近申请') }}</span>
              <button class="attendance__btn" :disabled="loading" @click="reloadRequestsWithStatus">{{ tr('Reload', '重载') }}</button>
            </div>
            <div v-if="requests.length === 0" class="attendance__empty">{{ tr('No requests.', '暂无申请。') }}</div>
            <ul v-else class="attendance__request-list">
              <li v-for="item in requests" :key="item.id" class="attendance__request-item">
                <div>
                  <strong>{{ item.work_date }}</strong> · {{ formatRequestType(item.request_type) }}
                  <span class="attendance__status-chip" :class="`attendance__status-chip--${item.status}`">
                    {{ formatStatus(item.status) }}
                  </span>
                </div>
                <div class="attendance__request-meta" v-if="item.metadata">
                  <span v-if="item.metadata.leaveType">{{ tr('Leave', '请假') }}: {{ item.metadata.leaveType.name }}</span>
                  <span v-if="item.metadata.overtimeRule">{{ tr('Overtime', '加班') }}: {{ item.metadata.overtimeRule.name }}</span>
                  <span v-if="item.metadata.minutes">{{ tr('Minutes', '分钟') }}: {{ item.metadata.minutes }}</span>
                </div>
                <div class="attendance__request-meta">
                  <span>{{ tr('In', '入') }}: {{ formatDateTime(item.requested_in_at) }}</span>
                  <span>{{ tr('Out', '出') }}: {{ formatDateTime(item.requested_out_at) }}</span>
                </div>
                <div class="attendance__request-actions" v-if="item.status === 'pending'">
                  <button class="attendance__btn" @click="cancelRequest(item.id)">{{ tr('Cancel', '取消') }}</button>
                  <button class="attendance__btn" @click="resolveRequest(item.id, 'approve')">{{ tr('Approve', '批准') }}</button>
                  <button class="attendance__btn attendance__btn--danger" @click="resolveRequest(item.id, 'reject')">{{ tr('Reject', '驳回') }}</button>
                </div>
              </li>
            </ul>
          </div>
        </div>

        <div class="attendance__card">
          <div class="attendance__requests-header">
            <h3>{{ tr('Anomalies', '异常') }}</h3>
            <button class="attendance__btn" :disabled="anomaliesLoading || loading" @click="reloadAnomaliesWithStatus">
              {{ anomaliesLoading ? tr('Loading...', '加载中...') : tr('Reload anomalies', '重载异常') }}
            </button>
          </div>
          <small class="attendance__field-hint">{{ anomaliesTimezoneContextHint }}</small>
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
                  <td>{{ item.workDate }}</td>
                  <td>{{ formatStatus(item.status) }}</td>
                  <td>{{ formatWarningsShort(item.warnings) }}</td>
                  <td>
                    <template v-if="item.request">
                      {{ formatRequestType(item.request.requestType) }}
                      <span
                        class="attendance__status-chip"
                        :class="`attendance__status-chip--${item.request.status}`"
                      >
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
            <button class="attendance__btn" :disabled="reportLoading" @click="reloadRequestReportWithStatus">
              {{ reportLoading ? tr('Loading...', '加载中...') : tr('Reload report', '重载报表') }}
            </button>
          </div>
          <small class="attendance__field-hint">{{ requestReportTimezoneContextHint }}</small>
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
      </section>

      <section class="attendance__card" v-if="showOverview">
        <div class="attendance__records-header">
          <h3>{{ tr('Records', '记录') }}</h3>
          <div class="attendance__records-actions">
            <button class="attendance__btn" :disabled="loading" @click="reloadRecordsWithStatus">{{ tr('Reload', '重载') }}</button>
            <button class="attendance__btn" :disabled="exporting || loading" @click="exportCsv">
              {{ exporting ? tr('Exporting...', '导出中...') : tr('Export CSV', '导出 CSV') }}
            </button>
          </div>
        </div>
        <small class="attendance__field-hint">{{ recordsTimezoneContextHint }}</small>
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
                <td>{{ record.work_date }}</td>
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
            <button class="attendance__btn" :disabled="settingsLoading || ruleLoading" @click="loadAdminData">
              {{ settingsLoading || ruleLoading ? tr('Loading...', '加载中...') : tr('Reload admin', '重载管理数据') }}
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
          <div v-else class="attendance__admin-shell">
            <AttendanceAdminRail
              :tr="tr"
              :admin-section-nav-count-label="adminSectionNavCountLabel"
              :admin-nav-storage-scope="adminNavStorageScope"
              :admin-nav-default-storage-scope="adminNavDefaultStorageScope"
              :admin-nav-scope-feedback="adminNavScopeFeedback"
              :active-admin-section-context-label="activeAdminSectionContextLabel"
              :is-compact-admin-nav="isCompactAdminNav"
              :admin-compact-nav-open="adminCompactNavOpen"
              :admin-section-filter="adminSectionFilter"
              :admin-section-filter-active="adminSectionFilterActive"
              :all-admin-section-groups-expanded="allAdminSectionGroupsExpanded"
              :all-admin-section-groups-collapsed="allAdminSectionGroupsCollapsed"
              :visible-recent-admin-section-nav-items="visibleRecentAdminSectionNavItems"
              :visible-admin-section-nav-groups="visibleAdminSectionNavGroups"
              :admin-active-section-id="adminActiveSectionId"
              @update:compact-nav-open="adminCompactNavOpen = $event"
              @update:section-filter="adminSectionFilter = $event"
              @expand-all="expandAllAdminSectionGroups"
              @collapse-all="collapseAllAdminSectionGroups"
              @copy-current-link="copyCurrentAdminSectionLink"
              @clear-recents="clearRecentAdminSections"
              @toggle-group="toggleAdminSectionGroup"
              @select-section="scrollToAdminSection"
            />
            <div class="attendance__admin-content">
            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.settings)">
              <h4>{{ tr('Settings', '设置') }}</h4>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--checkbox" for="attendance-auto-absence-enabled">
                  <span>{{ tr('Auto absence', '自动缺勤') }}</span>
                  <input
                    id="attendance-auto-absence-enabled"
                    name="autoAbsenceEnabled"
                    v-model="settingsForm.autoAbsenceEnabled"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field" for="attendance-auto-absence-run-at">
                  <span>{{ tr('Run at', '执行时间') }}</span>
                  <input
                    id="attendance-auto-absence-run-at"
                    name="autoAbsenceRunAt"
                    v-model="settingsForm.autoAbsenceRunAt"
                    type="time"
                  />
                </label>
                <label class="attendance__field" for="attendance-auto-absence-lookback">
                  <span>{{ tr('Lookback days', '回溯天数') }}</span>
                  <input
                    id="attendance-auto-absence-lookback"
                    name="autoAbsenceLookbackDays"
                    v-model.number="settingsForm.autoAbsenceLookbackDays"
                    type="number"
                    min="1"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-first-day-enabled">
                  <span>{{ tr('Holiday first-day base hours', '节假日首日基准工时') }}</span>
                  <input
                    id="attendance-holiday-first-day-enabled"
                    name="holidayFirstDayEnabled"
                    v-model="settingsForm.holidayFirstDayEnabled"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-first-day-hours">
                  <span>{{ tr('First-day base hours', '首日基准工时') }}</span>
                  <input
                    id="attendance-holiday-first-day-hours"
                    name="holidayFirstDayBaseHours"
                    v-model.number="settingsForm.holidayFirstDayBaseHours"
                    type="number"
                    min="0"
                    step="0.5"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-overtime-adds">
                  <span>{{ tr('Overtime adds on holiday', '节假日计入加班') }}</span>
                  <input
                    id="attendance-holiday-overtime-adds"
                    name="holidayOvertimeAdds"
                    v-model="settingsForm.holidayOvertimeAdds"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-overtime-source">
                  <span>{{ tr('Overtime source', '加班来源') }}</span>
                  <select
                    id="attendance-holiday-overtime-source"
                    name="holidayOvertimeSource"
                    v-model="settingsForm.holidayOvertimeSource"
                  >
                    <option value="approval">{{ tr('Approval', '审批') }}</option>
                    <option value="clock">{{ tr('Clock', '打卡') }}</option>
                    <option value="both">{{ tr('Both', '两者') }}</option>
                  </select>
                </label>
                <div class="attendance__field attendance__field--full">
                  <div class="attendance__admin-subsection">
                    <div class="attendance__admin-subsection-header">
                      <h5>{{ tr('Holiday overrides', '节假日覆盖规则') }}</h5>
                      <button class="attendance__btn" type="button" @click="addHolidayOverride">
                        {{ tr('Add override', '新增覆盖') }}
                      </button>
                    </div>
                    <div v-if="settingsForm.holidayOverrides.length === 0" class="attendance__empty">
                      {{ tr('No overrides configured.', '暂无覆盖规则。') }}
                    </div>
                    <div v-else class="attendance__table-wrapper">
                      <table class="attendance__table">
                        <thead>
                          <tr>
                            <th>{{ tr('Holiday name', '节假日名称') }}</th>
                            <th>{{ tr('Match', '匹配方式') }}</th>
                            <th>{{ tr('First-day hours', '首日工时') }}</th>
                            <th>{{ tr('Enable', '启用') }}</th>
                            <th>{{ tr('Overtime adds', '计入加班') }}</th>
                            <th>{{ tr('Overtime source', '加班来源') }}</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          <template v-for="(override, index) in settingsForm.holidayOverrides" :key="`holiday-override-${index}`">
                            <tr>
                              <td>
                                <input
                                  v-model="override.name"
                                  type="text"
                                  placeholder="春节"
                                />
                              </td>
                              <td>
                                <select v-model="override.match">
                                  <option value="contains">{{ tr('Contains', '包含') }}</option>
                                  <option value="equals">{{ tr('Equals', '等于') }}</option>
                                  <option value="regex">{{ tr('Regex', '正则') }}</option>
                                </select>
                              </td>
                              <td>
                                <input
                                  v-model.number="override.firstDayBaseHours"
                                  type="number"
                                  min="0"
                                  step="0.5"
                                />
                              </td>
                              <td>
                                <input v-model="override.firstDayEnabled" type="checkbox" />
                              </td>
                              <td>
                                <input v-model="override.overtimeAdds" type="checkbox" />
                              </td>
                              <td>
                                <select v-model="override.overtimeSource">
                                  <option value="approval">{{ tr('Approval', '审批') }}</option>
                                  <option value="clock">{{ tr('Clock', '打卡') }}</option>
                                  <option value="both">{{ tr('Both', '两者') }}</option>
                                </select>
                              </td>
                              <td>
                                <button class="attendance__btn attendance__btn--danger" type="button" @click="removeHolidayOverride(index)">
                                  {{ tr('Remove', '移除') }}
                                </button>
                              </td>
                            </tr>
                            <tr class="attendance__table-row--meta">
                              <td colspan="7">
                                <div class="attendance__override-filters">
                                  <label class="attendance__override-field">
                                    <span>{{ tr('Attendance groups', '考勤组') }}</span>
                                    <input v-model="override.attendanceGroups" type="text" placeholder="单休办公,白班" />
                                    <small v-if="attendanceGroupOptions.length" class="attendance__field-hint">
                                      {{ tr('Known groups', '已知分组') }}: {{ attendanceGroupOptions.join(', ') }}
                                    </small>
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>{{ tr('Roles', '角色') }}</span>
                                    <input v-model="override.roles" type="text" placeholder="司机,工段长" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>{{ tr('Role tags', '角色标签') }}</span>
                                    <input v-model="override.roleTags" type="text" placeholder="车间,仓储" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>{{ tr('User IDs', '用户ID') }}</span>
                                    <input v-model="override.userIds" type="text" placeholder="uuid1,uuid2" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>{{ tr('User names', '用户名') }}</span>
                                    <input v-model="override.userNames" type="text" placeholder="张三,李四" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>{{ tr('Exclude user IDs', '排除用户ID') }}</span>
                                    <input v-model="override.excludeUserIds" type="text" placeholder="uuid3" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>{{ tr('Exclude user names', '排除用户名') }}</span>
                                    <input v-model="override.excludeUserNames" type="text" placeholder="王五" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>{{ tr('Day index start', '节假日序号起始') }}</span>
                                    <input v-model.number="override.dayIndexStart" type="number" min="1" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>{{ tr('Day index end', '节假日序号结束') }}</span>
                                    <input v-model.number="override.dayIndexEnd" type="number" min="1" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>{{ tr('Day index list', '节假日序号列表') }}</span>
                                    <input v-model="override.dayIndexList" type="text" placeholder="1,2,3" />
                                  </label>
                                </div>
                              </td>
                            </tr>
                          </template>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
                <label class="attendance__field" for="attendance-min-punch-interval">
                  <span>{{ tr('Min punch interval (min)', '最小打卡间隔（分钟）') }}</span>
                  <input
                    id="attendance-min-punch-interval"
                    name="minPunchIntervalMinutes"
                    v-model.number="settingsForm.minPunchIntervalMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-ip-allowlist">
                  <span>{{ tr('IP allowlist', 'IP 白名单') }}</span>
                  <textarea
                    id="attendance-ip-allowlist"
                    name="ipAllowlist"
                    v-model="settingsForm.ipAllowlist"
                    rows="3"
                    :placeholder="tr('One per line or comma separated', '每行一个或逗号分隔')"
                  ></textarea>
                </label>
                <label class="attendance__field" for="attendance-geo-lat">
                  <span>{{ tr('Geo fence lat', '地理围栏纬度') }}</span>
                  <input
                    id="attendance-geo-lat"
                    name="geoFenceLat"
                    v-model="settingsForm.geoFenceLat"
                    type="number"
                    step="0.000001"
                  />
                </label>
                <label class="attendance__field" for="attendance-geo-lng">
                  <span>{{ tr('Geo fence lng', '地理围栏经度') }}</span>
                  <input
                    id="attendance-geo-lng"
                    name="geoFenceLng"
                    v-model="settingsForm.geoFenceLng"
                    type="number"
                    step="0.000001"
                  />
                </label>
                <label class="attendance__field" for="attendance-geo-radius">
                  <span>{{ tr('Geo fence radius (m)', '地理围栏半径（米）') }}</span>
                  <input
                    id="attendance-geo-radius"
                    name="geoFenceRadius"
                    v-model="settingsForm.geoFenceRadius"
                    type="number"
                    min="1"
                  />
                </label>
              </div>
              <button class="attendance__btn attendance__btn--primary" :disabled="settingsLoading" @click="saveSettings">
                {{ settingsLoading ? tr('Saving...', '保存中...') : tr('Save settings', '保存设置') }}
              </button>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.userAccess)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('User Access', '用户权限') }}</h4>
                <div class="attendance__admin-actions">
                  <button class="attendance__btn" :disabled="provisionLoading" @click="loadProvisioningUser">
                    {{ provisionLoading ? tr('Loading...', '加载中...') : tr('Load', '加载') }}
                  </button>
                  <button class="attendance__btn attendance__btn--primary" :disabled="provisionLoading" @click="grantProvisioningRole">
                    {{ provisionLoading ? tr('Working...', '处理中...') : tr('Assign role', '分配角色') }}
                  </button>
                  <button class="attendance__btn" :disabled="provisionLoading" @click="revokeProvisioningRole">
                    {{ provisionLoading ? tr('Working...', '处理中...') : tr('Remove role', '移除角色') }}
                  </button>
                </div>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--full" for="attendance-provision-search">
                  <span>{{ tr('User search (email/name/id)', '用户搜索（邮箱/姓名/ID）') }}</span>
                  <input
                    id="attendance-provision-search"
                    v-model="provisionSearchQuery"
                    type="text"
                    :placeholder="tr('Search users to avoid pasting UUIDs', '搜索用户，避免手工粘贴 UUID')"
                    @keydown.enter.prevent="searchProvisionUsers(1)"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn" :disabled="provisionSearchLoading" @click="searchProvisionUsers(1)">
                  {{ provisionSearchLoading ? tr('Searching...', '搜索中...') : tr('Search', '搜索') }}
                </button>
                <button
                  class="attendance__btn"
                  :disabled="provisionSearchLoading || provisionSearchPage <= 1"
                  @click="searchProvisionUsers(provisionSearchPage - 1)"
                >
                  {{ tr('Prev', '上一页') }}
                </button>
                <button
                  class="attendance__btn"
                  :disabled="provisionSearchLoading || !provisionSearchHasNext"
                  @click="searchProvisionUsers(provisionSearchPage + 1)"
                >
                  {{ tr('Next', '下一页') }}
                </button>
                <span v-if="provisionSearchHasSearched" class="attendance__field-hint">
                  {{ tr('Page', '页码') }} {{ provisionSearchPage }} · {{ provisionSearchTotal }} {{ tr('result(s)', '条结果') }}
                </span>
              </div>
              <div v-if="provisionSearchResults.length > 0" class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Email', '邮箱') }}</th>
                      <th>{{ tr('Name', '姓名') }}</th>
                      <th>{{ tr('User ID', '用户 ID') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="user in provisionSearchResults" :key="user.id">
                      <td>{{ user.email }}</td>
                      <td>{{ user.name || '--' }}</td>
                      <td><code>{{ user.id.slice(0, 8) }}</code></td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="selectProvisionUser(user)">{{ tr('Select', '选择') }}</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else-if="provisionSearchHasSearched" class="attendance__empty">{{ tr('No users found.', '未找到用户。') }}</p>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--full" for="attendance-provision-user-id">
                  <span>{{ tr('User ID (UUID)', '用户 ID（UUID）') }}</span>
                  <input
                    id="attendance-provision-user-id"
                    name="provisionUserId"
                    v-model="provisionForm.userId"
                    type="text"
                    :placeholder="tr('e.g. 0cdf4a9c-4fe1-471b-be08-854b683dc930', '例如 0cdf4a9c-4fe1-471b-be08-854b683dc930')"
                  />
                  <small v-if="provisionUserProfile" class="attendance__field-hint">
                    {{ tr('Selected', '已选择') }}: {{ provisionUserProfile.email }}{{ provisionUserProfile.name ? ` (${provisionUserProfile.name})` : '' }}
                  </small>
                </label>
                <label class="attendance__field" for="attendance-provision-role">
                  <span>{{ tr('Role template', '角色模板') }}</span>
                  <select
                    id="attendance-provision-role"
                    name="provisionRole"
                    v-model="provisionForm.role"
                  >
                    <option value="employee">{{ tr('employee', '员工') }}</option>
                    <option value="approver">{{ tr('approver', '审批人') }}</option>
                    <option value="admin">{{ tr('admin', '管理员') }}</option>
                  </select>
                </label>
              </div>
              <p v-if="provisionStatusMessage" class="attendance__status" :class="{ 'attendance__status--error': provisionStatusKind === 'error' }">
                {{ provisionStatusMessage }}
              </p>
              <div v-if="provisionRoles.length > 0" class="attendance__chip-list">
                <span v-for="role in provisionRoles" :key="role" class="attendance__status-chip">
                  {{ role }}
                </span>
              </div>
              <div v-if="provisionPermissions.length > 0" class="attendance__chip-list">
                <span v-for="perm in provisionPermissions" :key="perm" class="attendance__status-chip">
                  {{ perm }}
                </span>
                <span v-if="provisionUserIsAdmin" class="attendance__status-chip">
                  isAdmin=true
                </span>
              </div>
              <p v-else-if="provisionHasLoaded" class="attendance__empty">{{ tr('No permissions loaded.', '未加载到权限。') }}</p>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.batchProvisioning)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Batch Provisioning', '批量授权') }}</h4>
                <div class="attendance__admin-actions">
                  <button
                    class="attendance__btn"
                    :disabled="provisionBatchLoading || provisionBatchPreviewLoading"
                    @click="previewProvisionBatchUsers"
                  >
                    {{ provisionBatchPreviewLoading ? tr('Previewing...', '预览中...') : tr('Preview users', '预览用户') }}
                  </button>
                  <button
                    class="attendance__btn attendance__btn--primary"
                    :disabled="provisionBatchLoading"
                    @click="grantProvisioningRoleBatch"
                  >
                    {{ provisionBatchLoading ? tr('Working...', '处理中...') : tr('Assign role (batch)', '分配角色（批量）') }}
                  </button>
                  <button
                    class="attendance__btn"
                    :disabled="provisionBatchLoading"
                    @click="revokeProvisioningRoleBatch"
                  >
                    {{ provisionBatchLoading ? tr('Working...', '处理中...') : tr('Remove role (batch)', '移除角色（批量）') }}
                  </button>
                  <button class="attendance__btn" :disabled="provisionBatchLoading" @click="clearProvisionBatch">
                    {{ tr('Clear', '清空') }}
                  </button>
                </div>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--full" for="attendance-provision-batch-user-ids">
                  <span>{{ tr('User IDs (UUIDs)', '用户 ID（UUID）') }}</span>
                  <textarea
                    id="attendance-provision-batch-user-ids"
                    v-model="provisionBatchUserIdsText"
                    rows="4"
                    placeholder="uuid1\nuuid2\n..."
                  />
                  <small class="attendance__field-hint">
                    {{ tr('Parsed', '已解析') }}: {{ provisionBatchIds.length }} {{ tr('user(s)', '个用户') }}
                    <template v-if="provisionBatchInvalidIds.length">
                      · {{ tr('Invalid', '无效') }}: {{ provisionBatchInvalidIds.length }}
                    </template>
                  </small>
                </label>
                <label class="attendance__field" for="attendance-provision-batch-role">
                  <span>{{ tr('Role template', '角色模板') }}</span>
                  <select
                    id="attendance-provision-batch-role"
                    name="provisionBatchRole"
                    v-model="provisionBatchRole"
                  >
                    <option value="employee">{{ tr('employee', '员工') }}</option>
                    <option value="approver">{{ tr('approver', '审批人') }}</option>
                    <option value="admin">{{ tr('admin', '管理员') }}</option>
                  </select>
                </label>
              </div>
              <p
                v-if="provisionBatchStatusMessage"
                class="attendance__status"
                :class="{ 'attendance__status--error': provisionBatchStatusKind === 'error' }"
              >
                {{ provisionBatchStatusMessage }}
              </p>
              <p v-if="provisionBatchPreviewHasResult" class="attendance__field-hint">
                {{ tr('Preview', '预览') }}: {{ provisionBatchPreviewItems.length }}/{{ provisionBatchPreviewRequested }} {{ tr('found', '已找到') }}
                · {{ tr('Missing', '缺失') }} {{ provisionBatchPreviewMissingIds.length }}
                · {{ tr('Inactive', '未激活') }} {{ provisionBatchPreviewInactiveIds.length }}
              </p>
              <div v-if="provisionBatchPreviewItems.length > 0" class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Email', '邮箱') }}</th>
                      <th>{{ tr('Name', '姓名') }}</th>
                      <th>{{ tr('User ID', '用户 ID') }}</th>
                      <th>{{ tr('Active', '启用') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in provisionBatchPreviewItems" :key="item.id">
                      <td>{{ item.email }}</td>
                      <td>{{ item.name || '--' }}</td>
                      <td><code>{{ item.id.slice(0, 8) }}</code></td>
                      <td>{{ item.is_active ? tr('yes', '是') : tr('no', '否') }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-if="provisionBatchPreviewMissingIds.length > 0" class="attendance__field-hint">
                {{ tr('Missing user IDs', '缺失用户 ID') }}:
                <code>{{ provisionBatchPreviewMissingIds.slice(0, 6).join(', ') }}</code>
                <template v-if="provisionBatchPreviewMissingIds.length > 6"> ...</template>
              </p>
              <p v-if="provisionBatchAffectedIds.length > 0" class="attendance__field-hint">
                {{ tr('Affected user IDs', '受影响用户 ID') }}:
                <code>{{ provisionBatchAffectedIds.slice(0, 6).join(', ') }}</code>
                <template v-if="provisionBatchAffectedIds.length > 6"> ...</template>
              </p>
              <p v-if="provisionBatchUnchangedIds.length > 0" class="attendance__field-hint">
                {{ tr('Unchanged user IDs', '未变更用户 ID') }}:
                <code>{{ provisionBatchUnchangedIds.slice(0, 6).join(', ') }}</code>
                <template v-if="provisionBatchUnchangedIds.length > 6"> ...</template>
              </p>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.auditLogs)">
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
                  <select
                    id="attendance-audit-status-class"
                    v-model="auditLogStatusClass"
                  >
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
                  <input
                    id="attendance-audit-from"
                    v-model="auditLogFrom"
                    type="datetime-local"
                  />
                </label>
                <label class="attendance__field" for="attendance-audit-to">
                  <span>{{ tr('To', '结束') }}</span>
                  <input
                    id="attendance-audit-to"
                    v-model="auditLogTo"
                    type="datetime-local"
                  />
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
                  <div class="attendance__table-wrapper" v-if="auditSummaryActions.length || auditSummaryErrors.length">
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

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.holidaySync)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Holiday Sync', '节假日同步') }}</h4>
                <div class="attendance__admin-actions">
                  <button class="attendance__btn" :disabled="holidaySyncLoading" @click="syncHolidays">
                    {{ holidaySyncLoading ? tr('Syncing...', '同步中...') : tr('Sync now', '立即同步') }}
                  </button>
                  <button
                    class="attendance__btn"
                    :disabled="holidaySyncLoading"
                    @click="syncHolidaysForYears([new Date().getFullYear()])"
                  >
                    {{ tr('Sync current year', '同步当年') }}
                  </button>
                  <button
                    class="attendance__btn"
                    :disabled="holidaySyncLoading"
                    @click="syncHolidaysForYears([new Date().getFullYear() + 1])"
                  >
                    {{ tr('Sync next year', '同步下一年') }}
                  </button>
                </div>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--full" for="attendance-holiday-sync-base-url">
                  <span>{{ tr('Holiday source URL', '节假日数据源地址') }}</span>
                  <input
                    id="attendance-holiday-sync-base-url"
                    name="holidaySyncBaseUrl"
                    v-model="settingsForm.holidaySyncBaseUrl"
                    type="text"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-holiday-sync-years">
                  <span>{{ tr('Years (comma separated)', '年份（逗号分隔）') }}</span>
                  <input
                    id="attendance-holiday-sync-years"
                    name="holidaySyncYears"
                    v-model="settingsForm.holidaySyncYears"
                    type="text"
                    placeholder="2025,2026"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-sync-auto">
                  <span>{{ tr('Auto sync (daily)', '自动同步（每日）') }}</span>
                  <input
                    id="attendance-holiday-sync-auto"
                    name="holidaySyncAutoEnabled"
                    v-model="settingsForm.holidaySyncAutoEnabled"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-sync-auto-run">
                  <span>{{ tr('Auto sync time', '自动同步时间') }}</span>
                  <input
                    id="attendance-holiday-sync-auto-run"
                    name="holidaySyncAutoRunAt"
                    v-model="settingsForm.holidaySyncAutoRunAt"
                    type="time"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-sync-auto-tz">
                  <span>{{ tr('Auto sync timezone', '自动同步时区') }}</span>
                  <select
                    id="attendance-holiday-sync-auto-tz"
                    name="holidaySyncAutoTimezone"
                    v-model="settingsForm.holidaySyncAutoTimezone"
                  >
                    <option v-for="option in timezoneOptions" :key="`holiday-sync-${option.value}`" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                  <small class="attendance__field-hint">{{ tr('Current', '当前') }}: {{ holidaySyncAutoTimezoneLabel }}</small>
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-sync-index">
                  <span>{{ tr('Append day index', '追加节假日序号') }}</span>
                  <input
                    id="attendance-holiday-sync-index"
                    name="holidaySyncAddDayIndex"
                    v-model="settingsForm.holidaySyncAddDayIndex"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-holiday-sync-index-holidays">
                  <span>{{ tr('Index holidays', '需要编号的节假日') }}</span>
                  <input
                    id="attendance-holiday-sync-index-holidays"
                    name="holidaySyncDayIndexHolidays"
                    v-model="settingsForm.holidaySyncDayIndexHolidays"
                    type="text"
                    placeholder="春节,国庆"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-sync-index-max">
                  <span>{{ tr('Max index days', '最大编号天数') }}</span>
                  <input
                    id="attendance-holiday-sync-index-max"
                    name="holidaySyncDayIndexMaxDays"
                    v-model.number="settingsForm.holidaySyncDayIndexMaxDays"
                    type="number"
                    min="1"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-sync-index-format">
                  <span>{{ tr('Index format', '编号格式') }}</span>
                  <select
                    id="attendance-holiday-sync-index-format"
                    name="holidaySyncDayIndexFormat"
                    v-model="settingsForm.holidaySyncDayIndexFormat"
                  >
                    <option value="name-1">name-1</option>
                    <option value="name第1天">name第1天</option>
                    <option value="name DAY1">name DAY1</option>
                  </select>
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-sync-overwrite">
                  <span>{{ tr('Overwrite existing', '覆盖已有数据') }}</span>
                  <input
                    id="attendance-holiday-sync-overwrite"
                    name="holidaySyncOverwrite"
                    v-model="settingsForm.holidaySyncOverwrite"
                    type="checkbox"
                  />
                </label>
              </div>
              <div class="attendance__admin-meta">
                <strong>{{ tr('Last sync', '最近同步') }}</strong>
                <span v-if="holidaySyncLastRun?.ranAt">
                  {{ new Date(holidaySyncLastRun.ranAt).toLocaleString() }}
                  · {{ holidaySyncLastRun.success ? tr('success', '成功') : tr('failed', '失败') }}
                  · {{ holidaySyncLastRun.totalApplied ?? 0 }} {{ tr('applied', '已应用') }} / {{ holidaySyncLastRun.totalFetched ?? 0 }} {{ tr('fetched', '已获取') }}
                  <span v-if="holidaySyncLastRun.years && holidaySyncLastRun.years.length">
                    · {{ holidaySyncLastRun.years.join(',') }}
                  </span>
                  <span v-if="holidaySyncLastRun.error">
                    · {{ holidaySyncLastRun.error }}
                  </span>
                </span>
                <span v-else>--</span>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.defaultRule)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Default Rule', '默认规则') }}</h4>
                <button class="attendance__btn" :disabled="ruleLoading" @click="loadRule">
                  {{ ruleLoading ? tr('Loading...', '加载中...') : tr('Reload rule', '重载规则') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-rule-name">
                  <span>{{ tr('Name', '名称') }}</span>
                  <input id="attendance-rule-name" name="ruleName" v-model="ruleForm.name" type="text" />
                </label>
                <label class="attendance__field" for="attendance-rule-timezone">
                  <span>{{ tr('Timezone', '时区') }}</span>
                  <select
                    id="attendance-rule-timezone"
                    name="ruleTimezone"
                    v-model="ruleForm.timezone"
                  >
                    <option v-for="option in timezoneOptions" :key="`rule-${option.value}`" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                  <small class="attendance__field-hint">{{ tr('Current', '当前') }}: {{ ruleTimezoneLabel }}</small>
                </label>
                <label class="attendance__field" for="attendance-rule-start">
                  <span>{{ tr('Work start', '上班时间') }}</span>
                  <input
                    id="attendance-rule-start"
                    name="ruleWorkStartTime"
                    v-model="ruleForm.workStartTime"
                    type="time"
                  />
                </label>
                <label class="attendance__field" for="attendance-rule-end">
                  <span>{{ tr('Work end', '下班时间') }}</span>
                  <input
                    id="attendance-rule-end"
                    name="ruleWorkEndTime"
                    v-model="ruleForm.workEndTime"
                    type="time"
                  />
                </label>
                <label class="attendance__field" for="attendance-rule-late-grace">
                  <span>{{ tr('Late grace (min)', '迟到宽限（分钟）') }}</span>
                  <input
                    id="attendance-rule-late-grace"
                    name="ruleLateGraceMinutes"
                    v-model.number="ruleForm.lateGraceMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field" for="attendance-rule-early-grace">
                  <span>{{ tr('Early grace (min)', '早退宽限（分钟）') }}</span>
                  <input
                    id="attendance-rule-early-grace"
                    name="ruleEarlyGraceMinutes"
                    v-model.number="ruleForm.earlyGraceMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field" for="attendance-rule-rounding">
                  <span>{{ tr('Rounding (min)', '取整（分钟）') }}</span>
                  <input
                    id="attendance-rule-rounding"
                    name="ruleRoundingMinutes"
                    v-model.number="ruleForm.roundingMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-rule-working-days">
                  <span>{{ tr('Working days (0-6)', '工作日（0-6）') }}</span>
                  <input
                    id="attendance-rule-working-days"
                    name="ruleWorkingDays"
                    v-model="ruleForm.workingDays"
                    type="text"
                    placeholder="1,2,3,4,5"
                  />
                </label>
              </div>
              <button class="attendance__btn attendance__btn--primary" :disabled="ruleLoading" @click="saveRule">
                {{ ruleLoading ? tr('Saving...', '保存中...') : tr('Save rule', '保存规则') }}
              </button>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.ruleSets)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Rule Sets', '规则集') }}</h4>
                <button class="attendance__btn" :disabled="ruleSetLoading" @click="loadRuleSets">
                  {{ ruleSetLoading ? tr('Loading...', '加载中...') : tr('Reload rule sets', '重载规则集') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-rule-set-name">
                  <span>{{ tr('Name', '名称') }}</span>
                  <input id="attendance-rule-set-name" name="ruleSetName" v-model="ruleSetForm.name" type="text" />
                </label>
                <label class="attendance__field" for="attendance-rule-set-scope">
                  <span>{{ tr('Scope', '范围') }}</span>
                  <select id="attendance-rule-set-scope" name="ruleSetScope" v-model="ruleSetForm.scope">
                    <option value="org">{{ tr('Org', '组织') }}</option>
                    <option value="department">{{ tr('Department', '部门') }}</option>
                    <option value="project">{{ tr('Project', '项目') }}</option>
                    <option value="user">{{ tr('User', '用户') }}</option>
                    <option value="custom">{{ tr('Custom', '自定义') }}</option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-rule-set-version">
                  <span>{{ tr('Version', '版本') }}</span>
                  <input
                    id="attendance-rule-set-version"
                    name="ruleSetVersion"
                    v-model.number="ruleSetForm.version"
                    type="number"
                    min="1"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-rule-set-default">
                  <span>{{ tr('Default', '默认') }}</span>
                  <input
                    id="attendance-rule-set-default"
                    name="ruleSetDefault"
                    v-model="ruleSetForm.isDefault"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-rule-set-description">
                  <span>{{ tr('Description', '描述') }}</span>
                  <input
                    id="attendance-rule-set-description"
                    name="ruleSetDescription"
                    v-model="ruleSetForm.description"
                    type="text"
                    :placeholder="tr('Optional', '可选')"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-rule-set-config">
                  <span>{{ tr('Config (JSON)', '配置（JSON）') }}</span>
                  <textarea
                    id="attendance-rule-set-config"
                    name="ruleSetConfig"
                    v-model="ruleSetForm.config"
                    rows="4"
                    placeholder='{"source":"dingtalk","mappings":{"columns":[{"sourceField":"1_on_duty_user_check_time","targetField":"firstInAt"}]}}'
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn attendance__btn--primary" :disabled="ruleSetSaving" @click="saveRuleSet">
                  {{ ruleSetSaving ? tr('Saving...', '保存中...') : ruleSetEditingId ? tr('Update rule set', '更新规则集') : tr('Create rule set', '创建规则集') }}
                </button>
                <button class="attendance__btn" :disabled="ruleSetSaving" @click="loadRuleSetTemplate">
                  {{ tr('Load template', '加载模板') }}
                </button>
                <button
                  v-if="ruleSetEditingId"
                  class="attendance__btn"
                  :disabled="ruleSetSaving"
                  @click="resetRuleSetForm"
                >
                  {{ tr('Cancel edit', '取消编辑') }}
                </button>
              </div>
              <div v-if="ruleSets.length === 0" class="attendance__empty">{{ tr('No rule sets yet.', '暂无规则集。') }}</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Name', '名称') }}</th>
                      <th>{{ tr('Scope', '范围') }}</th>
                      <th>{{ tr('Version', '版本') }}</th>
                      <th>{{ tr('Default', '默认') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in ruleSets" :key="item.id">
                      <td>{{ item.name }}</td>
                      <td>{{ item.scope }}</td>
                      <td>{{ item.version }}</td>
                      <td>{{ item.isDefault ? tr('Yes', '是') : tr('No', '否') }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editRuleSet(item)">{{ tr('Edit', '编辑') }}</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteRuleSet(item.id)">
                          {{ tr('Delete', '删除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.ruleTemplateLibrary)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Rule Template Library', '规则模板库') }}</h4>
                <button
                  class="attendance__btn"
                  :disabled="ruleTemplateLoading || ruleTemplateSaving || ruleTemplateRestoring"
                  @click="loadRuleTemplates"
                >
                  {{ ruleTemplateLoading ? tr('Loading...', '加载中...') : tr('Reload templates', '重载模板') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--full" for="attendance-rule-template-system">
                  <span>{{ tr('System templates (read-only)', '系统模板（只读）') }}</span>
                  <textarea
                    id="attendance-rule-template-system"
                    name="ruleTemplateSystem"
                    v-model="ruleTemplateSystemText"
                    rows="6"
                    readonly
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-rule-template-library">
                  <span>{{ tr('Library templates (JSON)', '库模板（JSON）') }}</span>
                  <textarea
                    id="attendance-rule-template-library"
                    name="ruleTemplateLibrary"
                    v-model="ruleTemplateLibraryText"
                    rows="8"
                    placeholder="[]"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn" :disabled="ruleTemplateSaving || ruleTemplateRestoring" @click="copySystemTemplates">
                  {{ tr('Copy system to library', '复制系统模板到库') }}
                </button>
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="ruleTemplateSaving || ruleTemplateRestoring"
                  @click="saveRuleTemplates"
                >
                  {{ ruleTemplateSaving ? tr('Saving...', '保存中...') : tr('Save library', '保存模板库') }}
                </button>
              </div>
              <div class="attendance__admin-subsection">
                <div class="attendance__admin-section-header">
                  <h5>{{ tr('Template Versions', '模板版本') }}</h5>
                </div>
                <div v-if="ruleTemplateVersions.length === 0" class="attendance__empty">{{ tr('No versions yet.', '暂无版本。') }}</div>
                <div v-else class="attendance__table-wrapper">
                  <table class="attendance__table">
                    <thead>
                      <tr>
                        <th>{{ tr('Version', '版本') }}</th>
                        <th>{{ tr('Items', '条目') }}</th>
                        <th>{{ tr('Created', '创建时间') }}</th>
                        <th>{{ tr('Created by', '创建人') }}</th>
                        <th>{{ tr('Actions', '操作') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="version in ruleTemplateVersions" :key="version.id">
                        <td>{{ version.version }}</td>
                        <td>{{ version.itemCount ?? '--' }}</td>
                        <td>{{ formatDateTime(version.createdAt ?? null) }}</td>
                        <td>{{ version.createdBy || '--' }}</td>
                        <td class="attendance__table-actions">
                          <button
                            class="attendance__btn"
                            :disabled="ruleTemplateRestoring || ruleTemplateSaving"
                            @click="restoreRuleTemplates(version.id)"
                          >
                            {{ tr('Restore', '恢复') }}
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.attendanceGroups)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Attendance groups', '考勤组') }}</h4>
                <button class="attendance__btn" :disabled="attendanceGroupLoading" @click="loadAttendanceGroups">
                  {{ attendanceGroupLoading ? tr('Loading...', '加载中...') : tr('Reload groups', '重载分组') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-group-name">
                  <span>{{ tr('Name', '名称') }}</span>
                  <input id="attendance-group-name" v-model="attendanceGroupForm.name" type="text" />
                </label>
                <label class="attendance__field" for="attendance-group-code">
                  <span>{{ tr('Code', '编码') }}</span>
                  <input id="attendance-group-code" v-model="attendanceGroupForm.code" type="text" :placeholder="tr('optional', '可选')" />
                </label>
                <label class="attendance__field" for="attendance-group-timezone">
                  <span>{{ tr('Timezone', '时区') }}</span>
                  <select id="attendance-group-timezone" v-model="attendanceGroupForm.timezone">
                    <option v-for="option in timezoneOptions" :key="`group-${option.value}`" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                  <small class="attendance__field-hint">{{ tr('Current', '当前') }}: {{ attendanceGroupTimezoneLabel }}</small>
                </label>
                <label class="attendance__field" for="attendance-group-rule-set">
                  <span>{{ tr('Rule set', '规则集') }}</span>
                  <select
                    id="attendance-group-rule-set"
                    v-model="attendanceGroupForm.ruleSetId"
                    :disabled="ruleSets.length === 0"
                  >
                    <option value="">(Optional) Use default rule</option>
                    <option v-for="item in ruleSets" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-group-description">
                  <span>{{ tr('Description', '描述') }}</span>
                  <input id="attendance-group-description" v-model="attendanceGroupForm.description" type="text" />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="attendanceGroupSaving"
                  @click="saveAttendanceGroup"
                >
                  {{ attendanceGroupSaving ? tr('Saving...', '保存中...') : attendanceGroupEditingId ? tr('Update group', '更新分组') : tr('Create group', '创建分组') }}
                </button>
                <button class="attendance__btn" :disabled="attendanceGroupSaving" @click="resetAttendanceGroupForm">
                  {{ tr('Reset', '重置') }}
                </button>
              </div>
              <div v-if="attendanceGroups.length === 0" class="attendance__empty">{{ tr('No attendance groups.', '暂无考勤组。') }}</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Name', '名称') }}</th>
                      <th>{{ tr('Code', '编码') }}</th>
                      <th>{{ tr('Timezone', '时区') }}</th>
                      <th>{{ tr('Rule set', '规则集') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in attendanceGroups" :key="item.id">
                      <td>{{ item.name }}</td>
                      <td>{{ item.code || '-' }}</td>
                      <td>{{ displayTimezone(item.timezone) }}</td>
                      <td>{{ resolveRuleSetName(item.ruleSetId) }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editAttendanceGroup(item)">{{ tr('Edit', '编辑') }}</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteAttendanceGroup(item.id)">
                          {{ tr('Delete', '删除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.groupMembers)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Group members', '分组成员') }}</h4>
                <button
                  class="attendance__btn"
                  :disabled="attendanceGroupMemberLoading"
                  @click="loadAttendanceGroupMembers"
                >
                  {{ attendanceGroupMemberLoading ? tr('Loading...', '加载中...') : tr('Reload members', '重载成员') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-group-member-group">
                  <span>{{ tr('Group', '分组') }}</span>
                  <select
                    id="attendance-group-member-group"
                    v-model="attendanceGroupMemberGroupId"
                    :disabled="attendanceGroups.length === 0"
                  >
                    <option value="">{{ tr('Select a group', '选择分组') }}</option>
                    <option v-for="group in attendanceGroups" :key="group.id" :value="group.id">
                      {{ group.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-group-member-user-ids">
                  <span>{{ tr('User IDs', '用户 ID') }}</span>
                  <input
                    id="attendance-group-member-user-ids"
                    v-model="attendanceGroupMemberUserIds"
                    type="text"
                    :placeholder="tr('userId1, userId2', 'userId1, userId2')"
                  />
                  <small class="attendance__field-hint">{{ tr('Separate multiple IDs with commas or spaces.', '多个 ID 请用逗号或空格分隔。') }}</small>
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="attendanceGroupMemberSaving"
                  @click="addAttendanceGroupMembers"
                >
                  {{ attendanceGroupMemberSaving ? tr('Saving...', '保存中...') : tr('Add members', '添加成员') }}
                </button>
              </div>
              <div v-if="attendanceGroupMembers.length === 0" class="attendance__empty">{{ tr('No group members yet.', '暂无分组成员。') }}</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('User ID', '用户 ID') }}</th>
                      <th>{{ tr('Joined', '加入时间') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="member in attendanceGroupMembers" :key="member.id">
                      <td>{{ member.userId }}</td>
                      <td>{{ formatDateTime(member.createdAt ?? null) }}</td>
                      <td class="attendance__table-actions">
                        <button
                          class="attendance__btn attendance__btn--danger"
                          :disabled="attendanceGroupMemberSaving"
                          @click="removeAttendanceGroupMember(member.userId)"
                        >
                          {{ tr('Remove', '移除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.import)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Import (DingTalk / Manual)', '导入（钉钉 / 手工）') }}</h4>
                <button class="attendance__btn" :disabled="importLoading" @click="loadImportTemplate">
                  {{ importLoading ? tr('Loading...', '加载中...') : tr('Load template', '加载模板') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-import-rule-set">
                  <span>{{ tr('Rule set', '规则集') }}</span>
                  <select
                    id="attendance-import-rule-set"
                    name="importRuleSetId"
                    v-model="importForm.ruleSetId"
                    :disabled="ruleSets.length === 0"
                  >
                    <option value="">{{ tr('(Optional) Use default rule', '（可选）使用默认规则') }}</option>
                    <option v-for="item in ruleSets" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-import-mode">
                  <span>{{ tr('Import mode', '导入模式') }}</span>
                  <select id="attendance-import-mode" v-model="importMode">
                    <option value="override">{{ tr('override', '覆盖') }}</option>
                    <option value="merge">{{ tr('merge', '合并') }}</option>
                  </select>
                  <small class="attendance__field-hint">
                    <code>{{ tr('override', '覆盖') }}</code>: {{ tr('overwrite same user/date.', '覆盖同用户同日期记录。') }}
                    <code>{{ tr('merge', '合并') }}</code>: {{ tr('keep existing fields when present.', '存在字段时保留已有值。') }}
                  </small>
                </label>
                <label class="attendance__field" for="attendance-import-profile">
                  <span>{{ tr('Mapping profile', '映射配置') }}</span>
                  <select
                    id="attendance-import-profile"
                    v-model="importProfileId"
                    :disabled="importMappingProfiles.length === 0"
                  >
                    <option value="">{{ tr('(Optional) Select profile', '（可选）选择配置') }}</option>
                    <option v-for="profile in importMappingProfiles" :key="profile.id" :value="profile.id">
                      {{ profile.name }}
                    </option>
                  </select>
                  <small v-if="selectedImportProfile?.description" class="attendance__field-hint">
                    {{ selectedImportProfile.description }}
                  </small>
                  <small v-if="selectedImportProfile?.requiredFields?.length" class="attendance__field-hint">
                    {{ tr('Required fields', '必填字段') }}: {{ selectedImportProfile.requiredFields.join(', ') }}
                  </small>
                </label>
                <label class="attendance__field" for="attendance-import-csv">
                  <span>{{ tr('CSV file (optional)', 'CSV 文件（可选）') }}</span>
                  <input
                    id="attendance-import-csv"
                    type="file"
                    accept=".csv,text/csv"
                    @change="handleImportCsvChange"
                  />
                  <small v-if="importCsvFileName" class="attendance__field-hint">{{ tr('Selected', '已选择') }}: {{ importCsvFileName }}</small>
                </label>
                <label class="attendance__field" for="attendance-import-csv-header">
                  <span>{{ tr('CSV header row', 'CSV 表头行') }}</span>
                  <input
                    id="attendance-import-csv-header"
                    v-model="importCsvHeaderRow"
                    type="number"
                    min="0"
                    :placeholder="tr('Auto-detect', '自动识别')"
                  />
                </label>
                <label class="attendance__field" for="attendance-import-csv-delimiter">
                  <span>{{ tr('CSV delimiter', 'CSV 分隔符') }}</span>
                  <input
                    id="attendance-import-csv-delimiter"
                    v-model="importCsvDelimiter"
                    type="text"
                    maxlength="2"
                    placeholder=","
                  />
                </label>
                <label class="attendance__field" for="attendance-import-user-map">
                  <span>{{ tr('User map JSON (optional)', '用户映射 JSON（可选）') }}</span>
                  <input
                    id="attendance-import-user-map"
                    type="file"
                    accept=".json,application/json"
                    @change="handleImportUserMapChange"
                  />
                  <small v-if="importUserMapFileName" class="attendance__field-hint">
                    {{ tr('Selected', '已选择') }}: {{ importUserMapFileName }} · {{ importUserMapCount }} {{ tr('entries', '条') }}
                  </small>
                  <small v-if="importUserMapError" class="attendance__field-hint attendance__field-hint--error">
                    {{ importUserMapError }}
                  </small>
                </label>
                <label class="attendance__field" for="attendance-import-user-map-key">
                  <span>{{ tr('User map key field', '用户映射键字段') }}</span>
                  <input
                    id="attendance-import-user-map-key"
                    v-model="importUserMapKeyField"
                    type="text"
                    placeholder="工号"
                  />
                  <small v-if="selectedImportProfile?.userMapKeyField" class="attendance__field-hint">
                    {{ tr('Default', '默认') }}: {{ selectedImportProfile.userMapKeyField }}
                  </small>
                </label>
                <label class="attendance__field" for="attendance-import-user-map-source">
                  <span>{{ tr('User map source fields', '用户映射源字段') }}</span>
                  <input
                    id="attendance-import-user-map-source"
                    v-model="importUserMapSourceFields"
                    type="text"
                    placeholder="empNo,工号,姓名"
                  />
                  <small v-if="selectedImportProfile?.userMapSourceFields?.length" class="attendance__field-hint">
                    {{ tr('Default', '默认') }}: {{ selectedImportProfile.userMapSourceFields.join(', ') }}
                  </small>
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-import-group-create">
                  <span>{{ tr('Auto-create groups', '自动创建分组') }}</span>
                  <input id="attendance-import-group-create" v-model="importGroupAutoCreate" type="checkbox" />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-import-group-assign">
                  <span>{{ tr('Auto-assign group members', '自动分配分组成员') }}</span>
                  <input id="attendance-import-group-assign" v-model="importGroupAutoAssign" type="checkbox" />
                </label>
                <label class="attendance__field" for="attendance-import-group-rule-set">
                  <span>{{ tr('Group rule set', '分组规则集') }}</span>
                  <select
                    id="attendance-import-group-rule-set"
                    v-model="importGroupRuleSetId"
                    :disabled="ruleSets.length === 0"
                  >
                    <option value="">{{ tr('(Optional) Use import rule set', '（可选）使用导入规则集') }}</option>
                    <option v-for="item in ruleSets" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-import-group-timezone">
                  <span>{{ tr('Group timezone (optional)', '分组时区（可选）') }}</span>
                  <select
                    id="attendance-import-group-timezone"
                    v-model="importGroupTimezone"
                  >
                    <option value="">{{ tr('Use import timezone', '使用导入时区') }}</option>
                    <option v-for="option in timezoneOptions" :key="`import-group-${option.value}`" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                  <small class="attendance__field-hint">{{ tr('Current effective timezone', '当前生效时区') }}: {{ importGroupTimezoneLabel }}</small>
                </label>
                <label class="attendance__field" for="attendance-import-user">
                  <span>{{ tr('User ID', '用户 ID') }}</span>
                  <input
                    id="attendance-import-user"
                    name="importUserId"
                    v-model="importForm.userId"
                    type="text"
                    :placeholder="tr('Required if not in payload', '若 payload 无该字段则必填')"
                  />
                </label>
                <label class="attendance__field" for="attendance-import-timezone">
                  <span>{{ tr('Timezone', '时区') }}</span>
                  <select
                    id="attendance-import-timezone"
                    name="importTimezone"
                    v-model="importForm.timezone"
                  >
                    <option v-for="option in timezoneOptions" :key="`import-${option.value}`" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                  <small class="attendance__field-hint">{{ tr('Current', '当前') }}: {{ importTimezoneLabel }}</small>
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-import-payload">
                  <span>{{ tr('Payload (JSON)', '负载（JSON）') }}</span>
                  <textarea
                    id="attendance-import-payload"
                    name="importPayload"
                    v-model="importForm.payload"
                    rows="6"
                    placeholder='{\"source\":\"dingtalk\",\"userId\":\"...\",\"columns\":[],\"data\":{}}'
                  />
                  <small class="attendance__field-hint">
                    {{ tr('Default import mode is', '默认导入模式为') }} <strong>{{ tr('override', '覆盖') }}</strong>
                    {{ tr('(same user/date will be overwritten). Use', '（同用户同日期将被覆盖）。如需保留已存在字段，请在 payload 使用') }}
                    <code>mode: \"merge\"</code>.
                  </small>
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn" :disabled="importLoading" @click="applyImportCsvFile">
                  {{ tr('Load CSV', '加载 CSV') }}
                </button>
                <button class="attendance__btn" :disabled="importLoading" @click="applyImportProfile">
                  {{ tr('Apply profile', '应用配置') }}
                </button>
                <button class="attendance__btn" :disabled="importLoading" @click="previewImport">
                  {{ importLoading ? tr('Working...', '处理中...') : tr('Preview', '预览') }}
                </button>
                <button class="attendance__btn attendance__btn--primary" :disabled="importLoading" @click="runImport">
                  {{ importLoading ? tr('Importing...', '导入中...') : tr('Import', '导入') }}
                </button>
              </div>
              <small class="attendance__field-hint">
                {{ importScalabilityHint }}
              </small>
              <small class="attendance__field-hint">
                {{ importPreviewTimezoneHint }}
              </small>
              <div
                v-if="importPreviewTask"
                class="attendance__status"
                :class="{ 'attendance__status--error': importPreviewTask.status === 'failed' }"
              >
                <div class="attendance__requests-header">
                  <span>{{ importPreviewTask.mode === 'chunked' ? tr('Chunked preview task', '分块预览任务') : tr('Preview task', '预览任务') }}</span>
                  <button class="attendance__btn" type="button" @click="clearImportPreviewTask">
                    {{ tr('Clear', '清空') }}
                  </button>
                </div>
                <div>
                  {{ tr('Status', '状态') }}: <strong>{{ formatStatus(importPreviewTask.status) }}</strong>
                  <template v-if="importPreviewTask.mode === 'chunked'">
                    · {{ tr('Chunks', '分块') }} {{ importPreviewTask.completedChunks }} / {{ importPreviewTask.totalChunks }}
                  </template>
                </div>
                <div v-if="importPreviewTask.totalRows">
                  {{ tr('Progress', '进度') }}: {{ importPreviewTask.processedRows }} / {{ importPreviewTask.totalRows }}
                </div>
                <div class="attendance__field-hint">{{ importPreviewTimezoneHint }}</div>
                <div v-if="importPreviewTask.message">{{ importPreviewTask.message }}</div>
              </div>
              <div
                v-if="importAsyncJob"
                class="attendance__status"
                :class="{ 'attendance__status--error': importAsyncJob.status === 'failed' }"
              >
                <div class="attendance__requests-header">
                  <span>{{ importAsyncJob.kind === 'preview' ? tr('Async preview job', '异步预览任务') : tr('Async import job', '异步导入任务') }}</span>
                  <div class="attendance__table-actions">
                    <button
                      class="attendance__btn"
                      type="button"
                      :disabled="importAsyncPolling"
                      @click="refreshImportAsyncJob()"
                    >
                      {{ tr('Reload job', '重载任务') }}
                    </button>
                    <button
                      v-if="importAsyncJob.status === 'queued' || importAsyncJob.status === 'running'"
                      class="attendance__btn"
                      type="button"
                      :disabled="importAsyncPolling"
                      @click="resumeImportAsyncJobPolling"
                    >
                      {{ importAsyncPolling ? tr('Polling...', '轮询中...') : tr('Resume polling', '恢复轮询') }}
                    </button>
                    <button class="attendance__btn" type="button" @click="clearImportAsyncJob">
                      {{ tr('Clear', '清空') }}
                    </button>
                  </div>
                </div>
                <div>
                  {{ tr('Status', '状态') }}: <strong>{{ formatStatus(importAsyncJob.status) }}</strong>
                  <span v-if="importAsyncPolling"> · {{ tr('polling...', '轮询中...') }}</span>
                </div>
                <div v-if="importAsyncJob.total">
                  {{ tr('Progress', '进度') }}: {{ importAsyncJob.progress }} / {{ importAsyncJob.total }}
                  <span v-if="typeof importAsyncJob.progressPercent === 'number'">
                    ({{ importAsyncJob.progressPercent }}%)
                  </span>
                </div>
                <div v-if="importAsyncJobTelemetryText">{{ importAsyncJobTelemetryText }}</div>
                <div v-if="importAsyncJob.kind !== 'preview' && importAsyncJob.batchId">{{ tr('Batch', '批次') }}: {{ importAsyncJob.batchId }}</div>
                <div v-if="importAsyncJob.kind === 'preview' && importAsyncJob.preview?.rowCount">
                  {{ tr('Preview rows', '预览行数') }}: {{ importAsyncJob.preview?.total ?? 0 }} / {{ importAsyncJob.preview?.rowCount }}
                </div>
                <div class="attendance__field-hint">{{ importPreviewTimezoneHint }}</div>
                <div v-if="importAsyncJob.error">{{ tr('Error', '错误') }}: {{ importAsyncJob.error }}</div>
              </div>
              <div v-if="importCsvWarnings.length" class="attendance__status attendance__status--error">
                <div>{{ tr('CSV warnings', 'CSV 警告') }}: {{ importCsvWarnings.join('; ') }}</div>
                <div class="attendance__field-hint">{{ importPreviewTimezoneHint }}</div>
              </div>
              <div v-if="importPreview.length === 0" class="attendance__empty-state">
                <div class="attendance__empty">{{ tr('No preview data.', '暂无预览数据。') }}</div>
                <div class="attendance__field-hint">{{ importPreviewTimezoneHint }}</div>
              </div>
              <div v-else class="attendance__table-wrapper">
                <div class="attendance__field-hint">{{ importPreviewTimezoneHint }}</div>
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Work date', '工作日期') }}</th>
                      <th>{{ tr('User ID', '用户 ID') }}</th>
                      <th>{{ tr('Work minutes', '工作分钟') }}</th>
                      <th>{{ tr('Late', '迟到') }}</th>
                      <th>{{ tr('Early leave', '早退') }}</th>
                      <th>{{ tr('Status', '状态') }}</th>
                      <th>{{ tr('Warnings', '警告') }}</th>
                      <th>{{ tr('Policies', '规则') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in importPreview" :key="`${item.userId}-${item.workDate}`">
                      <td>{{ item.workDate }}</td>
                      <td>{{ item.userId }}</td>
                      <td>{{ item.workMinutes }}</td>
                      <td>{{ item.lateMinutes }}</td>
                      <td>{{ item.earlyLeaveMinutes }}</td>
                      <td>{{ formatStatus(item.status) }}</td>
                      <td>{{ formatList(item.warnings) }}</td>
                      <td>{{ formatPolicyList(item) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="attendance__admin-section-header" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.importBatches)">
                <h4>{{ tr('Import batches', '导入批次') }}</h4>
                <button class="attendance__btn" :disabled="importLoading" @click="loadImportBatches">
                  {{ importLoading ? tr('Loading...', '加载中...') : tr('Reload batches', '重载批次') }}
                </button>
              </div>
              <div v-if="importBatches.length === 0" class="attendance__empty-state">
                <div class="attendance__empty">{{ tr('No import batches.', '暂无导入批次。') }}</div>
                <div class="attendance__field-hint">{{ importPreviewTimezoneHint }}</div>
              </div>
              <div v-else class="attendance__table-wrapper">
                <div class="attendance__field-hint">{{ importPreviewTimezoneHint }}</div>
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
                          :disabled="importLoading"
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
                  <div class="attendance__table-actions">
                    <button class="attendance__btn" :disabled="importLoading" @click="exportImportBatchItemsCsv(false)">
                      {{ tr('Export items CSV', '导出条目 CSV') }}
                    </button>
                    <button class="attendance__btn" :disabled="importLoading" @click="exportImportBatchItemsCsv(true)">
                      {{ tr('Export anomalies CSV', '导出异常 CSV') }}
                    </button>
                  </div>
                </div>
                <div class="attendance__field-hint">{{ importPreviewTimezoneHint }}</div>
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
                <div v-if="importBatchSnapshot" class="attendance__snapshot-panel">
                  <div class="attendance__field-hint">
                    {{ tr('Snapshot context', '快照上下文') }}: {{ importBatchSnapshotContextLabel }}
                  </div>
                  <div class="attendance__field-hint">{{ importPreviewTimezoneHint }}</div>
                  <pre class="attendance__code">{{ formatJson(importBatchSnapshot.snapshot) }}</pre>
                </div>
              </div>
              <div v-else-if="importBatchSelectedId" class="attendance__empty-state">
                <div class="attendance__empty">{{ tr('No batch items.', '暂无批次条目。') }}</div>
                <div class="attendance__field-hint">{{ importPreviewTimezoneHint }}</div>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.payrollTemplates)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Payroll Templates', '计薪模板') }}</h4>
                <button class="attendance__btn" :disabled="payrollTemplateLoading" @click="loadPayrollTemplates">
                  {{ payrollTemplateLoading ? tr('Loading...', '加载中...') : tr('Reload templates', '重载模板') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-payroll-template-name">
                  <span>{{ tr('Name', '名称') }}</span>
                  <input
                    id="attendance-payroll-template-name"
                    name="payrollTemplateName"
                    v-model="payrollTemplateForm.name"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-template-timezone">
                  <span>{{ tr('Timezone', '时区') }}</span>
                  <select
                    id="attendance-payroll-template-timezone"
                    name="payrollTemplateTimezone"
                    v-model="payrollTemplateForm.timezone"
                  >
                    <option v-for="option in timezoneOptions" :key="`payroll-template-${option.value}`" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                  <small class="attendance__field-hint">{{ tr('Current', '当前') }}: {{ payrollTemplateTimezoneLabel }}</small>
                </label>
                <label class="attendance__field" for="attendance-payroll-template-start">
                  <span>{{ tr('Start day', '起始日') }}</span>
                  <input
                    id="attendance-payroll-template-start"
                    name="payrollTemplateStartDay"
                    v-model.number="payrollTemplateForm.startDay"
                    type="number"
                    min="1"
                    max="31"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-template-end">
                  <span>{{ tr('End day', '结束日') }}</span>
                  <input
                    id="attendance-payroll-template-end"
                    name="payrollTemplateEndDay"
                    v-model.number="payrollTemplateForm.endDay"
                    type="number"
                    min="1"
                    max="31"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-template-offset">
                  <span>{{ tr('End month offset', '结束月偏移') }}</span>
                  <select
                    id="attendance-payroll-template-offset"
                    name="payrollTemplateOffset"
                    v-model.number="payrollTemplateForm.endMonthOffset"
                  >
                    <option :value="0">{{ tr('Same month', '当月') }}</option>
                    <option :value="1">{{ tr('Next month', '次月') }}</option>
                  </select>
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-payroll-template-auto">
                  <span>{{ tr('Auto generate', '自动生成') }}</span>
                  <input
                    id="attendance-payroll-template-auto"
                    name="payrollTemplateAuto"
                    v-model="payrollTemplateForm.autoGenerate"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-payroll-template-default">
                  <span>{{ tr('Default', '默认') }}</span>
                  <input
                    id="attendance-payroll-template-default"
                    name="payrollTemplateDefault"
                    v-model="payrollTemplateForm.isDefault"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-payroll-template-config">
                  <span>{{ tr('Config (JSON)', '配置（JSON）') }}</span>
                  <textarea
                    id="attendance-payroll-template-config"
                    name="payrollTemplateConfig"
                    v-model="payrollTemplateForm.config"
                    rows="3"
                    placeholder="{}"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="payrollTemplateSaving"
                  @click="savePayrollTemplate"
                >
                  {{ payrollTemplateSaving ? tr('Saving...', '保存中...') : payrollTemplateEditingId ? tr('Update template', '更新模板') : tr('Create template', '创建模板') }}
                </button>
                <button
                  v-if="payrollTemplateEditingId"
                  class="attendance__btn"
                  :disabled="payrollTemplateSaving"
                  @click="resetPayrollTemplateForm"
                >
                  {{ tr('Cancel edit', '取消编辑') }}
                </button>
              </div>
              <small class="attendance__field-hint">
                {{ tr('Template timezone context', '模板时区上下文') }}: {{ payrollTemplateTimezoneLabel }}
              </small>
              <div v-if="payrollTemplates.length === 0" class="attendance__empty-state">
                <div class="attendance__empty">{{ tr('No payroll templates yet.', '暂无计薪模板。') }}</div>
                <div class="attendance__field-hint">
                  {{ tr('Template timezone context', '模板时区上下文') }}: {{ payrollTemplateTimezoneLabel }}
                </div>
              </div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Name', '名称') }}</th>
                      <th>{{ tr('Timezone', '时区') }}</th>
                      <th>{{ tr('Start', '开始') }}</th>
                      <th>{{ tr('End', '结束') }}</th>
                      <th>{{ tr('Offset', '偏移') }}</th>
                      <th>{{ tr('Default', '默认') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in payrollTemplates" :key="item.id">
                      <td>{{ item.name }}</td>
                      <td>{{ displayTimezone(item.timezone) }}</td>
                      <td>{{ item.startDay }}</td>
                      <td>{{ item.endDay }}</td>
                      <td>{{ item.endMonthOffset }}</td>
                      <td>{{ item.isDefault ? tr('Yes', '是') : tr('No', '否') }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editPayrollTemplate(item)">{{ tr('Edit', '编辑') }}</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deletePayrollTemplate(item.id)">
                          {{ tr('Delete', '删除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.payrollCycles)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Payroll Cycles', '计薪周期') }}</h4>
                <button class="attendance__btn" :disabled="payrollCycleLoading" @click="loadPayrollCycles">
                  {{ payrollCycleLoading ? tr('Loading...', '加载中...') : tr('Reload cycles', '重载周期') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-payroll-cycle-template">
                  <span>{{ tr('Template', '模板') }}</span>
                  <select
                    id="attendance-payroll-cycle-template"
                    name="payrollCycleTemplate"
                    v-model="payrollCycleForm.templateId"
                    :disabled="payrollTemplates.length === 0"
                  >
                    <option value="">{{ tr('Manual', '手工') }}</option>
                    <option v-for="item in payrollTemplates" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-payroll-cycle-name">
                  <span>{{ tr('Name', '名称') }}</span>
                  <input
                    id="attendance-payroll-cycle-name"
                    name="payrollCycleName"
                    v-model="payrollCycleForm.name"
                    type="text"
                    :placeholder="tr('Optional', '可选')"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-cycle-anchor">
                  <span>{{ tr('Anchor date', '锚点日期') }}</span>
                  <input
                    id="attendance-payroll-cycle-anchor"
                    name="payrollCycleAnchor"
                    v-model="payrollCycleForm.anchorDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-cycle-start">
                  <span>{{ tr('Start date', '开始日期') }}</span>
                  <input
                    id="attendance-payroll-cycle-start"
                    name="payrollCycleStartDate"
                    v-model="payrollCycleForm.startDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-cycle-end">
                  <span>{{ tr('End date', '结束日期') }}</span>
                  <input
                    id="attendance-payroll-cycle-end"
                    name="payrollCycleEndDate"
                    v-model="payrollCycleForm.endDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-cycle-status">
                  <span>{{ tr('Status', '状态') }}</span>
                  <select
                    id="attendance-payroll-cycle-status"
                    name="payrollCycleStatus"
                    v-model="payrollCycleForm.status"
                  >
                    <option value="open">{{ tr('Open', '开启') }}</option>
                    <option value="closed">{{ tr('Closed', '关闭') }}</option>
                    <option value="archived">{{ tr('Archived', '归档') }}</option>
                  </select>
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="payrollCycleSaving"
                  @click="savePayrollCycle"
                >
                  {{ payrollCycleSaving ? tr('Saving...', '保存中...') : payrollCycleEditingId ? tr('Update cycle', '更新周期') : tr('Create cycle', '创建周期') }}
                </button>
                <button class="attendance__btn" :disabled="payrollCycleSaving" @click="loadPayrollCycleSummary">
                  {{ tr('Load summary', '加载汇总') }}
                </button>
                <button class="attendance__btn" :disabled="payrollCycleSaving" @click="exportPayrollCycleSummary">
                  {{ tr('Export CSV', '导出 CSV') }}
                </button>
                <button
                  v-if="payrollCycleEditingId"
                  class="attendance__btn"
                  :disabled="payrollCycleSaving"
                  @click="resetPayrollCycleForm"
                >
                  {{ tr('Cancel edit', '取消编辑') }}
                </button>
              </div>
              <small class="attendance__field-hint">
                {{ payrollCycleTemplateTimezoneHint }}
              </small>

              <details class="attendance__details">
                <summary class="attendance__details-summary">{{ tr('Batch generate cycles', '批量生成周期') }}</summary>
                <div class="attendance__admin-grid attendance__admin-grid--compact">
                  <label class="attendance__field" for="attendance-payroll-cycle-gen-template">
                    <span>{{ tr('Template', '模板') }}</span>
                    <select
                      id="attendance-payroll-cycle-gen-template"
                      name="payrollCycleGenTemplate"
                      v-model="payrollCycleGenerateForm.templateId"
                      :disabled="payrollTemplates.length === 0"
                    >
                      <option value="">{{ tr('Default template', '默认模板') }}</option>
                      <option v-for="item in payrollTemplates" :key="item.id" :value="item.id">
                        {{ item.name }}
                      </option>
                    </select>
                  </label>
                  <label class="attendance__field" for="attendance-payroll-cycle-gen-anchor">
                    <span>{{ tr('Anchor date', '锚点日期') }}</span>
                    <input
                      id="attendance-payroll-cycle-gen-anchor"
                      name="payrollCycleGenAnchor"
                      v-model="payrollCycleGenerateForm.anchorDate"
                      type="date"
                    />
                  </label>
                  <label class="attendance__field" for="attendance-payroll-cycle-gen-count">
                    <span>{{ tr('Count', '数量') }}</span>
                    <input
                      id="attendance-payroll-cycle-gen-count"
                      name="payrollCycleGenCount"
                      v-model.number="payrollCycleGenerateForm.count"
                      type="number"
                      min="1"
                      max="36"
                    />
                  </label>
                  <label class="attendance__field" for="attendance-payroll-cycle-gen-status">
                    <span>{{ tr('Status', '状态') }}</span>
                    <select
                      id="attendance-payroll-cycle-gen-status"
                      name="payrollCycleGenStatus"
                      v-model="payrollCycleGenerateForm.status"
                    >
                      <option value="open">{{ tr('Open', '开启') }}</option>
                      <option value="closed">{{ tr('Closed', '关闭') }}</option>
                      <option value="archived">{{ tr('Archived', '归档') }}</option>
                    </select>
                  </label>
                  <label class="attendance__field" for="attendance-payroll-cycle-gen-prefix">
                    <span>{{ tr('Name prefix', '名称前缀') }}</span>
                    <input
                      id="attendance-payroll-cycle-gen-prefix"
                      name="payrollCycleGenPrefix"
                      v-model="payrollCycleGenerateForm.namePrefix"
                      type="text"
                      :placeholder="tr('Optional', '可选')"
                    />
                  </label>
                  <label class="attendance__field attendance__field--full" for="attendance-payroll-cycle-gen-metadata">
                    <span>{{ tr('Metadata (JSON)', '元数据（JSON）') }}</span>
                    <textarea
                      id="attendance-payroll-cycle-gen-metadata"
                      name="payrollCycleGenMetadata"
                      v-model="payrollCycleGenerateForm.metadata"
                      rows="2"
                      placeholder="{}"
                    />
                  </label>
                </div>
                <div class="attendance__admin-actions">
                  <button
                    class="attendance__btn attendance__btn--primary"
                    :disabled="payrollCycleGenerating"
                    @click="generatePayrollCycles"
                  >
                    {{ payrollCycleGenerating ? tr('Generating...', '生成中...') : tr('Generate cycles', '生成周期') }}
                  </button>
                  <button class="attendance__btn" :disabled="payrollCycleGenerating" @click="resetPayrollCycleGenerateForm">
                    {{ tr('Reset', '重置') }}
                  </button>
                  <span v-if="payrollCycleGenerateResult" class="attendance__empty">
                    {{ tr('Created', '已创建') }} {{ payrollCycleGenerateResult.created }}，{{ tr('skipped', '跳过') }} {{ payrollCycleGenerateResult.skipped }}。
                  </span>
                </div>
                <small class="attendance__field-hint">
                  {{ payrollCycleGenerateTimezoneHint }}
                </small>
              </details>
              <div v-if="payrollCycleSummary" class="attendance__field-hint">{{ payrollCycleTemplateTimezoneHint }}</div>
              <div v-if="payrollCycleSummary" class="attendance__summary">
                <div class="attendance__summary-item">
                  <span>{{ tr('Cycle total minutes', '周期总分钟数') }}</span>
                  <strong>{{ payrollCycleSummary.total_minutes }}</strong>
                </div>
                <div class="attendance__summary-item">
                  <span>{{ tr('Leave minutes', '请假分钟数') }}</span>
                  <strong>{{ payrollCycleSummary.leave_minutes ?? 0 }}</strong>
                </div>
                <div class="attendance__summary-item">
                  <span>{{ tr('Overtime minutes', '加班分钟数') }}</span>
                  <strong>{{ payrollCycleSummary.overtime_minutes ?? 0 }}</strong>
                </div>
                <div class="attendance__summary-item">
                  <span>{{ tr('Late minutes', '迟到分钟数') }}</span>
                  <strong>{{ payrollCycleSummary.total_late_minutes ?? 0 }}</strong>
                </div>
                <div class="attendance__summary-item">
                  <span>{{ tr('Early leave minutes', '早退分钟数') }}</span>
                  <strong>{{ payrollCycleSummary.total_early_leave_minutes ?? 0 }}</strong>
                </div>
              </div>
              <div v-if="payrollCycles.length === 0" class="attendance__empty-state">
                <div class="attendance__empty">{{ tr('No payroll cycles yet.', '暂无计薪周期。') }}</div>
                <div class="attendance__field-hint">{{ payrollCycleTemplateTimezoneHint }}</div>
                <div class="attendance__field-hint">{{ payrollCycleGenerateTimezoneHint }}</div>
              </div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Name', '名称') }}</th>
                      <th>{{ tr('Template', '模板') }}</th>
                      <th>{{ tr('Start', '开始') }}</th>
                      <th>{{ tr('End', '结束') }}</th>
                      <th>{{ tr('Status', '状态') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in payrollCycles" :key="item.id">
                      <td>{{ item.name || '--' }}</td>
                      <td>{{ payrollTemplateName(item.templateId) }}</td>
                      <td>{{ item.startDate }}</td>
                      <td>{{ item.endDate }}</td>
                      <td>{{ formatStatus(item.status) }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editPayrollCycle(item)">{{ tr('Edit', '编辑') }}</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deletePayrollCycle(item.id)">
                          {{ tr('Delete', '删除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.leaveTypes)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Leave Types', '请假类型') }}</h4>
                <button class="attendance__btn" :disabled="leaveTypeLoading" @click="loadLeaveTypes">
                  {{ leaveTypeLoading ? tr('Loading...', '加载中...') : tr('Reload leave types', '重载请假类型') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-leave-code">
                  <span>{{ tr('Code', '编码') }}</span>
                  <input id="attendance-leave-code" name="leaveCode" v-model="leaveTypeForm.code" type="text" />
                </label>
                <label class="attendance__field" for="attendance-leave-name">
                  <span>{{ tr('Name', '名称') }}</span>
                  <input id="attendance-leave-name" name="leaveName" v-model="leaveTypeForm.name" type="text" />
                </label>
                <label class="attendance__field" for="attendance-leave-minutes">
                  <span>{{ tr('Minutes / day', '每日分钟数') }}</span>
                  <input
                    id="attendance-leave-minutes"
                    name="leaveMinutes"
                    v-model.number="leaveTypeForm.defaultMinutesPerDay"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-leave-approval">
                  <span>{{ tr('Requires approval', '需要审批') }}</span>
                  <input
                    id="attendance-leave-approval"
                    name="leaveRequiresApproval"
                    v-model="leaveTypeForm.requiresApproval"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-leave-attachment">
                  <span>{{ tr('Requires attachment', '需要附件') }}</span>
                  <input
                    id="attendance-leave-attachment"
                    name="leaveRequiresAttachment"
                    v-model="leaveTypeForm.requiresAttachment"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-leave-active">
                  <span>{{ tr('Active', '启用') }}</span>
                  <input
                    id="attendance-leave-active"
                    name="leaveActive"
                    v-model="leaveTypeForm.isActive"
                    type="checkbox"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn attendance__btn--primary" :disabled="leaveTypeSaving" @click="saveLeaveType">
                  {{ leaveTypeSaving ? tr('Saving...', '保存中...') : leaveTypeEditingId ? tr('Update leave type', '更新请假类型') : tr('Create leave type', '创建请假类型') }}
                </button>
                <button
                  v-if="leaveTypeEditingId"
                  class="attendance__btn"
                  :disabled="leaveTypeSaving"
                  @click="resetLeaveTypeForm"
                >
                  {{ tr('Cancel edit', '取消编辑') }}
                </button>
              </div>
              <div v-if="leaveTypes.length === 0" class="attendance__empty">{{ tr('No leave types yet.', '暂无请假类型。') }}</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Code', '编码') }}</th>
                      <th>{{ tr('Name', '名称') }}</th>
                      <th>{{ tr('Approval', '审批') }}</th>
                      <th>{{ tr('Attachment', '附件') }}</th>
                      <th>{{ tr('Minutes', '分钟') }}</th>
                      <th>{{ tr('Active', '启用') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in leaveTypes" :key="item.id">
                      <td>{{ item.code }}</td>
                      <td>{{ item.name }}</td>
                      <td>{{ item.requiresApproval ? tr('Yes', '是') : tr('No', '否') }}</td>
                      <td>{{ item.requiresAttachment ? tr('Yes', '是') : tr('No', '否') }}</td>
                      <td>{{ item.defaultMinutesPerDay }}</td>
                      <td>{{ item.isActive ? tr('Yes', '是') : tr('No', '否') }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editLeaveType(item)">{{ tr('Edit', '编辑') }}</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteLeaveType(item.id)">
                          {{ tr('Delete', '删除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.overtimeRules)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Overtime Rules', '加班规则') }}</h4>
                <button class="attendance__btn" :disabled="overtimeRuleLoading" @click="loadOvertimeRules">
                  {{ overtimeRuleLoading ? tr('Loading...', '加载中...') : tr('Reload overtime rules', '重载加班规则') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-overtime-name">
                  <span>{{ tr('Name', '名称') }}</span>
                  <input id="attendance-overtime-name" name="overtimeName" v-model="overtimeRuleForm.name" type="text" />
                </label>
                <label class="attendance__field" for="attendance-overtime-min">
                  <span>{{ tr('Min minutes', '最小分钟数') }}</span>
                  <input
                    id="attendance-overtime-min"
                    name="overtimeMinMinutes"
                    v-model.number="overtimeRuleForm.minMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field" for="attendance-overtime-rounding">
                  <span>{{ tr('Rounding', '取整') }}</span>
                  <input
                    id="attendance-overtime-rounding"
                    name="overtimeRounding"
                    v-model.number="overtimeRuleForm.roundingMinutes"
                    type="number"
                    min="1"
                  />
                </label>
                <label class="attendance__field" for="attendance-overtime-max">
                  <span>{{ tr('Max / day', '每日上限') }}</span>
                  <input
                    id="attendance-overtime-max"
                    name="overtimeMax"
                    v-model.number="overtimeRuleForm.maxMinutesPerDay"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-overtime-approval">
                  <span>{{ tr('Requires approval', '需要审批') }}</span>
                  <input
                    id="attendance-overtime-approval"
                    name="overtimeRequiresApproval"
                    v-model="overtimeRuleForm.requiresApproval"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-overtime-active">
                  <span>{{ tr('Active', '启用') }}</span>
                  <input
                    id="attendance-overtime-active"
                    name="overtimeActive"
                    v-model="overtimeRuleForm.isActive"
                    type="checkbox"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="overtimeRuleSaving"
                  @click="saveOvertimeRule"
                >
                  {{ overtimeRuleSaving ? tr('Saving...', '保存中...') : overtimeRuleEditingId ? tr('Update rule', '更新规则') : tr('Create rule', '创建规则') }}
                </button>
                <button
                  v-if="overtimeRuleEditingId"
                  class="attendance__btn"
                  :disabled="overtimeRuleSaving"
                  @click="resetOvertimeRuleForm"
                >
                  {{ tr('Cancel edit', '取消编辑') }}
                </button>
              </div>
              <div v-if="overtimeRules.length === 0" class="attendance__empty">{{ tr('No overtime rules yet.', '暂无加班规则。') }}</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Name', '名称') }}</th>
                      <th>{{ tr('Min', '最小') }}</th>
                      <th>{{ tr('Rounding', '取整') }}</th>
                      <th>{{ tr('Max', '上限') }}</th>
                      <th>{{ tr('Approval', '审批') }}</th>
                      <th>{{ tr('Active', '启用') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="rule in overtimeRules" :key="rule.id">
                      <td>{{ rule.name }}</td>
                      <td>{{ rule.minMinutes }}</td>
                      <td>{{ rule.roundingMinutes }}</td>
                      <td>{{ rule.maxMinutesPerDay }}</td>
                      <td>{{ rule.requiresApproval ? tr('Yes', '是') : tr('No', '否') }}</td>
                      <td>{{ rule.isActive ? tr('Yes', '是') : tr('No', '否') }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editOvertimeRule(rule)">{{ tr('Edit', '编辑') }}</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteOvertimeRule(rule.id)">
                          {{ tr('Delete', '删除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.approvalFlows)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Approval Flows', '审批流') }}</h4>
                <button class="attendance__btn" :disabled="approvalFlowLoading" @click="loadApprovalFlows">
                  {{ approvalFlowLoading ? tr('Loading...', '加载中...') : tr('Reload flows', '重载流程') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-approval-name">
                  <span>{{ tr('Name', '名称') }}</span>
                  <input
                    id="attendance-approval-name"
                    name="approvalName"
                    v-model="approvalFlowForm.name"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-approval-type">
                  <span>{{ tr('Request type', '申请类型') }}</span>
                  <select id="attendance-approval-type" name="approvalType" v-model="approvalFlowForm.requestType">
                    <option value="missed_check_in">{{ tr('Missed check-in', '漏打上班卡') }}</option>
                    <option value="missed_check_out">{{ tr('Missed check-out', '漏打下班卡') }}</option>
                    <option value="time_correction">{{ tr('Time correction', '时间更正') }}</option>
                    <option value="leave">{{ tr('Leave', '请假') }}</option>
                    <option value="overtime">{{ tr('Overtime', '加班') }}</option>
                  </select>
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-approval-active">
                  <span>{{ tr('Active', '启用') }}</span>
                  <input
                    id="attendance-approval-active"
                    name="approvalActive"
                    v-model="approvalFlowForm.isActive"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-approval-steps">
                  <span>{{ tr('Steps (JSON)', '步骤（JSON）') }}</span>
                  <textarea
                    id="attendance-approval-steps"
                    name="approvalSteps"
                    v-model="approvalFlowForm.steps"
                    rows="3"
                    placeholder='[{"name":"Manager","approverRoleIds":["manager"]}]'
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="approvalFlowSaving"
                  @click="saveApprovalFlow"
                >
                  {{ approvalFlowSaving ? tr('Saving...', '保存中...') : approvalFlowEditingId ? tr('Update flow', '更新流程') : tr('Create flow', '创建流程') }}
                </button>
                <button
                  v-if="approvalFlowEditingId"
                  class="attendance__btn"
                  :disabled="approvalFlowSaving"
                  @click="resetApprovalFlowForm"
                >
                  {{ tr('Cancel edit', '取消编辑') }}
                </button>
              </div>
              <div v-if="approvalFlows.length === 0" class="attendance__empty">{{ tr('No approval flows yet.', '暂无审批流程。') }}</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Name', '名称') }}</th>
                      <th>{{ tr('Request', '申请') }}</th>
                      <th>{{ tr('Steps', '步骤') }}</th>
                      <th>{{ tr('Active', '启用') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="flow in approvalFlows" :key="flow.id">
                      <td>{{ flow.name }}</td>
                      <td>{{ formatRequestType(flow.requestType) }}</td>
                      <td>{{ flow.steps.length }}</td>
                      <td>{{ flow.isActive ? tr('Yes', '是') : tr('No', '否') }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editApprovalFlow(flow)">{{ tr('Edit', '编辑') }}</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteApprovalFlow(flow.id)">
                          {{ tr('Delete', '删除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.rotationRules)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Rotation Rules', '轮班规则') }}</h4>
                <button class="attendance__btn" :disabled="rotationRuleLoading" @click="loadRotationRules">
                  {{ rotationRuleLoading ? tr('Loading...', '加载中...') : tr('Reload rotation rules', '重载轮班规则') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-rotation-name">
                  <span>{{ tr('Name', '名称') }}</span>
                  <input
                    id="attendance-rotation-name"
                    name="rotationName"
                    v-model="rotationRuleForm.name"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-rotation-timezone">
                  <span>{{ tr('Timezone', '时区') }}</span>
                  <select
                    id="attendance-rotation-timezone"
                    name="rotationTimezone"
                    v-model="rotationRuleForm.timezone"
                  >
                    <option v-for="option in timezoneOptions" :key="`rotation-${option.value}`" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                  <small class="attendance__field-hint">{{ tr('Current', '当前') }}: {{ rotationRuleTimezoneLabel }}</small>
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-rotation-sequence">
                  <span>{{ tr('Shift sequence (IDs)', '班次序列（ID）') }}</span>
                  <input
                    id="attendance-rotation-sequence"
                    name="rotationSequence"
                    v-model="rotationRuleForm.shiftSequence"
                    type="text"
                    :placeholder="tr('shiftId1, shiftId2', '班次ID1, 班次ID2')"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-rotation-active">
                  <span>{{ tr('Active', '启用') }}</span>
                  <input
                    id="attendance-rotation-active"
                    name="rotationActive"
                    v-model="rotationRuleForm.isActive"
                    type="checkbox"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="rotationRuleSaving"
                  @click="saveRotationRule"
                >
                  {{ rotationRuleSaving ? tr('Saving...', '保存中...') : rotationRuleEditingId ? tr('Update rotation', '更新轮班') : tr('Create rotation', '创建轮班') }}
                </button>
                <button
                  v-if="rotationRuleEditingId"
                  class="attendance__btn"
                  :disabled="rotationRuleSaving"
                  @click="resetRotationRuleForm"
                >
                  {{ tr('Cancel edit', '取消编辑') }}
                </button>
              </div>
              <div v-if="rotationRules.length === 0" class="attendance__empty">{{ tr('No rotation rules yet.', '暂无轮班规则。') }}</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Name', '名称') }}</th>
                      <th>{{ tr('Timezone', '时区') }}</th>
                      <th>{{ tr('Sequence', '序列') }}</th>
                      <th>{{ tr('Active', '启用') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="rule in rotationRules" :key="rule.id">
                      <td>{{ rule.name }}</td>
                      <td>{{ displayTimezone(rule.timezone) }}</td>
                      <td>{{ rule.shiftSequence.join(', ') }}</td>
                      <td>{{ rule.isActive ? tr('Yes', '是') : tr('No', '否') }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editRotationRule(rule)">{{ tr('Edit', '编辑') }}</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteRotationRule(rule.id)">
                          {{ tr('Delete', '删除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.rotationAssignments)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Rotation Assignments', '轮班分配') }}</h4>
                <button class="attendance__btn" :disabled="rotationAssignmentLoading" @click="loadRotationAssignments">
                  {{ rotationAssignmentLoading ? tr('Loading...', '加载中...') : tr('Reload rotations', '重载轮班分配') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-rotation-user">
                  <span>{{ tr('User ID', '用户 ID') }}</span>
                  <input
                    id="attendance-rotation-user"
                    name="rotationUserId"
                    v-model="rotationAssignmentForm.userId"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-rotation-rule">
                  <span>{{ tr('Rotation rule', '轮班规则') }}</span>
                  <select
                    id="attendance-rotation-rule"
                    name="rotationRuleId"
                    v-model="rotationAssignmentForm.rotationRuleId"
                    :disabled="rotationRules.length === 0"
                  >
                    <option value="" disabled>{{ tr('Select rotation', '选择轮班') }}</option>
                    <option v-for="rule in rotationRules" :key="rule.id" :value="rule.id">
                      {{ rule.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-rotation-start">
                  <span>{{ tr('Start date', '开始日期') }}</span>
                  <input
                    id="attendance-rotation-start"
                    name="rotationStartDate"
                    v-model="rotationAssignmentForm.startDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-rotation-end">
                  <span>{{ tr('End date', '结束日期') }}</span>
                  <input
                    id="attendance-rotation-end"
                    name="rotationEndDate"
                    v-model="rotationAssignmentForm.endDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-rotation-active">
                  <span>{{ tr('Active', '启用') }}</span>
                  <input
                    id="attendance-rotation-active"
                    name="rotationActive"
                    v-model="rotationAssignmentForm.isActive"
                    type="checkbox"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="rotationAssignmentSaving"
                  @click="saveRotationAssignment"
                >
                  {{ rotationAssignmentSaving ? tr('Saving...', '保存中...') : rotationAssignmentEditingId ? tr('Update assignment', '更新分配') : tr('Create assignment', '创建分配') }}
                </button>
                <button
                  v-if="rotationAssignmentEditingId"
                  class="attendance__btn"
                  :disabled="rotationAssignmentSaving"
                  @click="resetRotationAssignmentForm"
                >
                  {{ tr('Cancel edit', '取消编辑') }}
                </button>
              </div>
              <div v-if="rotationAssignments.length === 0" class="attendance__empty">{{ tr('No rotation assignments yet.', '暂无轮班分配。') }}</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('User', '用户') }}</th>
                      <th>{{ tr('Rotation', '轮班') }}</th>
                      <th>{{ tr('Start', '开始') }}</th>
                      <th>{{ tr('End', '结束') }}</th>
                      <th>{{ tr('Active', '启用') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in rotationAssignments" :key="item.assignment.id">
                      <td>{{ item.assignment.userId }}</td>
                      <td>{{ item.rotation.name }}</td>
                      <td>{{ item.assignment.startDate }}</td>
                      <td>{{ item.assignment.endDate || '--' }}</td>
                      <td>{{ item.assignment.isActive ? tr('Yes', '是') : tr('No', '否') }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editRotationAssignment(item)">{{ tr('Edit', '编辑') }}</button>
                        <button
                          class="attendance__btn attendance__btn--danger"
                          @click="deleteRotationAssignment(item.assignment.id)"
                        >
                          {{ tr('Delete', '删除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.shifts)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Shifts', '班次') }}</h4>
                <button class="attendance__btn" :disabled="shiftLoading" @click="loadShifts">
                  {{ shiftLoading ? tr('Loading...', '加载中...') : tr('Reload shifts', '重载班次') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-shift-name">
                  <span>{{ tr('Name', '名称') }}</span>
                  <input id="attendance-shift-name" name="shiftName" v-model="shiftForm.name" type="text" />
                </label>
                <label class="attendance__field" for="attendance-shift-timezone">
                  <span>{{ tr('Timezone', '时区') }}</span>
                  <select
                    id="attendance-shift-timezone"
                    name="shiftTimezone"
                    v-model="shiftForm.timezone"
                  >
                    <option v-for="option in timezoneOptions" :key="`shift-${option.value}`" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                  <small class="attendance__field-hint">{{ tr('Current', '当前') }}: {{ shiftTimezoneLabel }}</small>
                </label>
                <label class="attendance__field" for="attendance-shift-start">
                  <span>{{ tr('Work start', '上班开始') }}</span>
                  <input
                    id="attendance-shift-start"
                    name="shiftWorkStartTime"
                    v-model="shiftForm.workStartTime"
                    type="time"
                  />
                </label>
                <label class="attendance__field" for="attendance-shift-end">
                  <span>{{ tr('Work end', '下班结束') }}</span>
                  <input
                    id="attendance-shift-end"
                    name="shiftWorkEndTime"
                    v-model="shiftForm.workEndTime"
                    type="time"
                  />
                </label>
                <label class="attendance__field" for="attendance-shift-late-grace">
                  <span>{{ tr('Late grace (min)', '迟到宽限（分钟）') }}</span>
                  <input
                    id="attendance-shift-late-grace"
                    name="shiftLateGraceMinutes"
                    v-model.number="shiftForm.lateGraceMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field" for="attendance-shift-early-grace">
                  <span>{{ tr('Early grace (min)', '早退宽限（分钟）') }}</span>
                  <input
                    id="attendance-shift-early-grace"
                    name="shiftEarlyGraceMinutes"
                    v-model.number="shiftForm.earlyGraceMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field" for="attendance-shift-rounding">
                  <span>{{ tr('Rounding (min)', '取整（分钟）') }}</span>
                  <input
                    id="attendance-shift-rounding"
                    name="shiftRoundingMinutes"
                    v-model.number="shiftForm.roundingMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-shift-working-days">
                  <span>{{ tr('Working days (0-6)', '工作日（0-6）') }}</span>
                  <input
                    id="attendance-shift-working-days"
                    name="shiftWorkingDays"
                    v-model="shiftForm.workingDays"
                    type="text"
                    :placeholder="tr('1,2,3,4,5', '1,2,3,4,5')"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn attendance__btn--primary" :disabled="shiftSaving" @click="saveShift">
                  {{ shiftSaving ? tr('Saving...', '保存中...') : shiftEditingId ? tr('Update shift', '更新班次') : tr('Create shift', '创建班次') }}
                </button>
                <button v-if="shiftEditingId" class="attendance__btn" :disabled="shiftSaving" @click="resetShiftForm">
                  {{ tr('Cancel edit', '取消编辑') }}
                </button>
              </div>
              <div v-if="shifts.length === 0" class="attendance__empty">{{ tr('No shifts yet.', '暂无班次。') }}</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Name', '名称') }}</th>
                      <th>{{ tr('Timezone', '时区') }}</th>
                      <th>{{ tr('Start', '开始') }}</th>
                      <th>{{ tr('End', '结束') }}</th>
                      <th>{{ tr('Working days', '工作日') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="shift in shifts" :key="shift.id">
                      <td>{{ shift.name }}</td>
                      <td>{{ displayTimezone(shift.timezone) }}</td>
                      <td>{{ shift.workStartTime }}</td>
                      <td>{{ shift.workEndTime }}</td>
                      <td>{{ shift.workingDays.join(',') }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editShift(shift)">{{ tr('Edit', '编辑') }}</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteShift(shift.id)">
                          {{ tr('Delete', '删除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.assignments)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Assignments', '排班分配') }}</h4>
                <button class="attendance__btn" :disabled="assignmentLoading" @click="loadAssignments">
                  {{ assignmentLoading ? tr('Loading...', '加载中...') : tr('Reload assignments', '重载分配') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-assignment-user-id">
                  <span>{{ tr('User ID', '用户 ID') }}</span>
                  <input
                    id="attendance-assignment-user-id"
                    name="assignmentUserId"
                    v-model="assignmentForm.userId"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-assignment-shift-id">
                  <span>{{ tr('Shift', '班次') }}</span>
                  <select
                    id="attendance-assignment-shift-id"
                    name="assignmentShiftId"
                    v-model="assignmentForm.shiftId"
                    :disabled="shifts.length === 0"
                  >
                    <option value="" disabled>{{ tr('Select shift', '选择班次') }}</option>
                    <option v-for="shift in shifts" :key="shift.id" :value="shift.id">
                      {{ shift.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-assignment-start-date">
                  <span>{{ tr('Start date', '开始日期') }}</span>
                  <input
                    id="attendance-assignment-start-date"
                    name="assignmentStartDate"
                    v-model="assignmentForm.startDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-assignment-end-date">
                  <span>{{ tr('End date', '结束日期') }}</span>
                  <input
                    id="attendance-assignment-end-date"
                    name="assignmentEndDate"
                    v-model="assignmentForm.endDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-assignment-active">
                  <span>{{ tr('Active', '启用') }}</span>
                  <input
                    id="attendance-assignment-active"
                    name="assignmentActive"
                    v-model="assignmentForm.isActive"
                    type="checkbox"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn attendance__btn--primary" :disabled="assignmentSaving" @click="saveAssignment">
                  {{ assignmentSaving ? tr('Saving...', '保存中...') : assignmentEditingId ? tr('Update assignment', '更新分配') : tr('Create assignment', '创建分配') }}
                </button>
                <button
                  v-if="assignmentEditingId"
                  class="attendance__btn"
                  :disabled="assignmentSaving"
                  @click="resetAssignmentForm"
                >
                  {{ tr('Cancel edit', '取消编辑') }}
                </button>
              </div>
              <div v-if="assignments.length === 0" class="attendance__empty">{{ tr('No assignments yet.', '暂无排班分配。') }}</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('User', '用户') }}</th>
                      <th>{{ tr('Shift', '班次') }}</th>
                      <th>{{ tr('Start', '开始') }}</th>
                      <th>{{ tr('End', '结束') }}</th>
                      <th>{{ tr('Active', '启用') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in assignments" :key="item.assignment.id">
                      <td>{{ item.assignment.userId }}</td>
                      <td>{{ item.shift.name }}</td>
                      <td>{{ item.assignment.startDate }}</td>
                      <td>{{ item.assignment.endDate || '--' }}</td>
                      <td>{{ item.assignment.isActive ? tr('Yes', '是') : tr('No', '否') }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editAssignment(item)">{{ tr('Edit', '编辑') }}</button>
                        <button
                          class="attendance__btn attendance__btn--danger"
                          @click="deleteAssignment(item.assignment.id)"
                        >
                          {{ tr('Delete', '删除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.holidays)">
              <div class="attendance__admin-section-header">
                <h4>{{ tr('Holidays', '节假日') }}</h4>
                <button class="attendance__btn" :disabled="holidayLoading" @click="loadHolidays">
                  {{ holidayLoading ? tr('Loading...', '加载中...') : tr('Reload holidays', '重载节假日') }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-holiday-date">
                  <span>{{ tr('Date', '日期') }}</span>
                  <input
                    id="attendance-holiday-date"
                    name="holidayDate"
                    v-model="holidayForm.date"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-name">
                  <span>{{ tr('Name', '名称') }}</span>
                  <input
                    id="attendance-holiday-name"
                    name="holidayName"
                    v-model="holidayForm.name"
                    type="text"
                    :placeholder="tr('Optional', '可选')"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-working">
                  <span>{{ tr('Working day override', '工作日覆盖') }}</span>
                  <input
                    id="attendance-holiday-working"
                    name="holidayWorkingDay"
                    v-model="holidayForm.isWorkingDay"
                    type="checkbox"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn attendance__btn--primary" :disabled="holidaySaving" @click="saveHoliday">
                  {{ holidaySaving ? tr('Saving...', '保存中...') : holidayEditingId ? tr('Update holiday', '更新节假日') : tr('Create holiday', '创建节假日') }}
                </button>
                <button
                  v-if="holidayEditingId"
                  class="attendance__btn"
                  :disabled="holidaySaving"
                  @click="resetHolidayForm"
                >
                  {{ tr('Cancel edit', '取消编辑') }}
                </button>
              </div>
              <div v-if="holidays.length === 0" class="attendance__empty">{{ tr('No holidays in this range.', '当前范围内暂无节假日。') }}</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>{{ tr('Date', '日期') }}</th>
                      <th>{{ tr('Name', '名称') }}</th>
                      <th>{{ tr('Working day', '工作日') }}</th>
                      <th>{{ tr('Actions', '操作') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="holiday in holidays" :key="holiday.id">
                      <td>{{ holiday.date }}</td>
                      <td>{{ holiday.name || '--' }}</td>
                      <td>{{ holiday.isWorkingDay ? tr('Yes', '是') : tr('No', '否') }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editHoliday(holiday)">{{ tr('Edit', '编辑') }}</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteHoliday(holiday.id)">
                          {{ tr('Delete', '删除') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import AttendanceAdminRail from './attendance/AttendanceAdminRail.vue'
import {
  ATTENDANCE_ADMIN_SECTION_IDS,
  useAttendanceAdminRail,
} from './attendance/useAttendanceAdminRail'
import { useAttendanceAdminRailNavigation } from './attendance/useAttendanceAdminRailNavigation'
import { useLocale } from '../composables/useLocale'
import { usePlugins } from '../composables/usePlugins'
import { apiFetch } from '../utils/api'
import { readErrorMessage } from '../utils/error'
import { buildTimezoneOptions, formatTimezoneLabel } from '../utils/timezones'

type AttendancePageMode = 'overview' | 'admin'
type ProvisionRole = 'employee' | 'approver' | 'admin'
type AttendanceStatusAction =
  | 'refresh-overview'
  | 'reload-admin'
  | 'reload-import-job'
  | 'resume-import-job'
  | 'reload-import-csv'
  | 'retry-save-settings'
  | 'retry-save-rule'
  | 'retry-preview-import'
  | 'retry-run-import'
  | 'retry-submit-request'
  | 'reload-requests'
type AttendanceStatusContext =
  | 'refresh'
  | 'admin'
  | 'save-settings'
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
const CALENDAR_DISPLAY_PREFS_STORAGE_KEY = 'metasheet_attendance_calendar_display'

interface AttendanceCalendarDisplayPrefs {
  showLunar: boolean
  showHoliday: boolean
}

function loadCalendarDisplayPrefs(): AttendanceCalendarDisplayPrefs {
  const defaults: AttendanceCalendarDisplayPrefs = {
    showLunar: true,
    showHoliday: true,
  }
  if (typeof window === 'undefined') return defaults
  try {
    const raw = window.localStorage.getItem(CALENDAR_DISPLAY_PREFS_STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<AttendanceCalendarDisplayPrefs>
    return {
      showLunar: parsed.showLunar !== false,
      showHoliday: parsed.showHoliday !== false,
    }
  } catch {
    return defaults
  }
}

function persistCalendarDisplayPrefs(prefs: AttendanceCalendarDisplayPrefs): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CALENDAR_DISPLAY_PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // ignore storage write failures (private mode, quota).
  }
}

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

interface PermissionUserResponse {
  userId: string
  permissions: string[]
  isAdmin: boolean
  degraded?: boolean
}

interface AttendanceAdminUserSearchItem {
  id: string
  email: string
  name: string | null
  role: string
  is_active: boolean
  is_admin: boolean
  last_login_at: string | null
  created_at: string
}

interface AttendanceAdminUserProfileSummary {
  id: string
  email: string
  name: string | null
}

interface AttendanceAdminBatchResolveItem {
  id: string
  email: string
  name: string | null
  is_active: boolean
}

interface AttendanceAdminRoleTemplate {
  id: ProvisionRole
  roleId: string
  permissions: string[]
  description: string
}

interface AttendanceAuditLogItem {
  id: string
  actor_id: string | null
  actor_type: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  request_id: string | null
  ip: string | null
  user_agent: string | null
  route: string | null
  status_code: number | null
  latency_ms: number | null
  occurred_at: string
  meta: Record<string, any>
}

interface AttendanceAuditSummaryRow {
  key: string
  total: number
}

interface AttendanceSettings {
  autoAbsence?: {
    enabled?: boolean
    runAt?: string
    lookbackDays?: number
  }
  holidayPolicy?: {
    firstDayEnabled?: boolean
    firstDayBaseHours?: number
    overtimeAdds?: boolean
    overtimeSource?: 'approval' | 'clock' | 'both'
    overrides?: HolidayPolicyOverride[]
  }
  holidaySync?: {
    source?: 'holiday-cn'
    baseUrl?: string
    years?: number[]
    addDayIndex?: boolean
    dayIndexHolidays?: string[]
    dayIndexMaxDays?: number
    dayIndexFormat?: 'name-1' | 'name第1天' | 'name DAY1'
    overwrite?: boolean
    auto?: {
      enabled?: boolean
      runAt?: string
      timezone?: string
    }
    lastRun?: {
      ranAt?: string | null
      success?: boolean | null
      years?: number[] | null
      totalFetched?: number | null
      totalApplied?: number | null
      error?: string | null
    } | null
  }
  ipAllowlist?: string[]
  geoFence?: {
    lat: number
    lng: number
    radiusMeters: number
  } | null
  minPunchIntervalMinutes?: number
}

interface HolidayPolicyOverride {
  name: string
  match?: 'contains' | 'regex' | 'equals'
  attendanceGroups?: string[]
  roles?: string[]
  roleTags?: string[]
  userIds?: string[]
  userNames?: string[]
  excludeUserIds?: string[]
  excludeUserNames?: string[]
  dayIndexStart?: number
  dayIndexEnd?: number
  dayIndexList?: number[]
  firstDayEnabled?: boolean
  firstDayBaseHours?: number
  overtimeAdds?: boolean
  overtimeSource?: 'approval' | 'clock' | 'both'
}

interface HolidayPolicyOverrideForm {
  name: string
  match: 'contains' | 'regex' | 'equals'
  attendanceGroups?: string
  roles?: string
  roleTags?: string
  userIds?: string
  userNames?: string
  excludeUserIds?: string
  excludeUserNames?: string
  dayIndexStart?: number | null
  dayIndexEnd?: number | null
  dayIndexList?: string
  firstDayEnabled?: boolean
  firstDayBaseHours?: number
  overtimeAdds?: boolean
  overtimeSource?: 'approval' | 'clock' | 'both'
}

interface AttendanceRule {
  id?: string
  orgId?: string
  name: string
  timezone: string
  workStartTime: string
  workEndTime: string
  lateGraceMinutes: number
  earlyGraceMinutes: number
  roundingMinutes: number
  workingDays: number[]
  isDefault?: boolean
}

interface AttendanceRuleSet {
  id: string
  orgId?: string
  name: string
  description?: string | null
  version: number
  scope: string
  config?: Record<string, any>
  isDefault: boolean
}

interface AttendanceRuleTemplateVersion {
  id: string
  version: number
  createdAt?: string | null
  createdBy?: string | null
  sourceVersionId?: string | null
  itemCount?: number | null
}

interface AttendanceGroup {
  id: string
  orgId?: string
  name: string
  code?: string | null
  timezone: string
  ruleSetId?: string | null
  description?: string | null
  createdAt?: string
  updatedAt?: string
}

interface AttendanceGroupMember {
  id: string
  groupId: string
  userId: string
  createdAt?: string
}

interface AttendancePayrollTemplate {
  id: string
  orgId?: string
  name: string
  timezone: string
  startDay: number
  endDay: number
  endMonthOffset: number
  autoGenerate: boolean
  config?: Record<string, any>
  isDefault: boolean
}

interface AttendancePayrollCycle {
  id: string
  orgId?: string
  templateId?: string | null
  name?: string | null
  startDate: string
  endDate: string
  status: string
  metadata?: Record<string, any>
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

interface AttendanceImportBatch {
  id: string
  orgId?: string
  createdBy?: string | null
  source?: string | null
  ruleSetId?: string | null
  mapping?: Record<string, any> | null
  rowCount: number
  status: string
  meta?: Record<string, any> | null
  createdAt?: string
  updatedAt?: string
}

interface AttendanceImportItem {
  id: string
  batchId: string
  orgId?: string
  userId: string | null
  workDate: string | null
  recordId?: string | null
  previewSnapshot?: Record<string, any> | null
  createdAt?: string
}

interface AttendanceImportBatchSnapshotContext {
  userId: string | null
  workDate: string | null
  recordId: string | null
}

interface AttendanceImportBatchSnapshotState {
  snapshot: Record<string, any>
  context: AttendanceImportBatchSnapshotContext
}

interface AttendanceImportMappingProfile {
  id: string
  name: string
  description?: string
  source?: string
  mapping?: Record<string, any>
  requiredFields?: string[]
  userMapKeyField?: string
  userMapSourceFields?: string[]
  payloadExample?: Record<string, any>
}

interface AttendanceImportJob {
  id: string
  orgId?: string
  batchId: string
  createdBy?: string | null
  idempotencyKey?: string | null
  kind?: 'commit' | 'preview' | string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | string
  progress: number
  total: number
  engine?: 'standard' | 'bulk' | string | null
  processedRows?: number
  failedRows?: number
  elapsedMs?: number
  progressPercent?: number
  throughputRowsPerSec?: number
  error?: string | null
  preview?: {
    items?: AttendanceImportPreviewItem[]
    total?: number
    rowCount?: number
    truncated?: boolean
    previewLimit?: number
    stats?: { rowCount?: number; invalid?: number; duplicates?: number }
    csvWarnings?: string[]
    groupWarnings?: string[]
  } | null
  startedAt?: string | null
  finishedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

interface AttendanceImportPreviewTask {
  mode: 'single' | 'chunked'
  status: 'running' | 'completed' | 'failed'
  totalRows: number
  processedRows: number
  totalChunks: number
  completedChunks: number
  message?: string | null
}

interface AttendanceReconcileResult {
  summary?: Record<string, any>
  warnings?: string[]
}

interface AttendanceRulePreviewItem {
  userId: string
  workDate: string
  firstInAt?: string | null
  lastOutAt?: string | null
  workMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  status: string
  isWorkingDay?: boolean
  source?: string
}

interface AttendanceShift {
  id: string
  orgId?: string
  name: string
  timezone: string
  workStartTime: string
  workEndTime: string
  lateGraceMinutes: number
  earlyGraceMinutes: number
  roundingMinutes: number
  workingDays: number[]
}

interface AttendanceAssignment {
  id: string
  orgId?: string
  userId: string
  shiftId: string
  startDate: string
  endDate: string | null
  isActive: boolean
}

interface AttendanceAssignmentItem {
  assignment: AttendanceAssignment
  shift: AttendanceShift
}

interface AttendanceHoliday {
  id: string
  orgId?: string
  date: string
  name: string | null
  isWorkingDay: boolean
}

interface AttendanceLeaveType {
  id: string
  orgId?: string
  code: string
  name: string
  requiresApproval: boolean
  requiresAttachment: boolean
  defaultMinutesPerDay: number
  isActive: boolean
}

interface AttendanceOvertimeRule {
  id: string
  orgId?: string
  name: string
  minMinutes: number
  roundingMinutes: number
  maxMinutesPerDay: number
  requiresApproval: boolean
  isActive: boolean
}

interface AttendanceApprovalStep {
  name?: string
  approverUserIds?: string[]
  approverRoleIds?: string[]
}

interface AttendanceApprovalFlow {
  id: string
  orgId?: string
  name: string
  requestType: string
  steps: AttendanceApprovalStep[]
  isActive: boolean
}

interface AttendanceRotationRule {
  id: string
  orgId?: string
  name: string
  timezone: string
  shiftSequence: string[]
  isActive: boolean
}

interface AttendanceRotationAssignment {
  id: string
  orgId?: string
  userId: string
  rotationRuleId: string
  startDate: string
  endDate: string | null
  isActive: boolean
}

interface AttendanceRotationAssignmentItem {
  assignment: AttendanceRotationAssignment
  rotation: AttendanceRotationRule
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

interface AttendanceImportDebugOptions {
  forceUploadCsv: boolean
  forceAsyncImport: boolean
  forceTimeoutOnce: boolean
  pollIntervalMs: number | null
  pollTimeoutMs: number | null
}

function parseDebugBoolean(value: unknown): boolean {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  return false
}

function parseDebugPositiveInt(value: unknown): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.trunc(parsed)
}

function readImportDebugOptions(): AttendanceImportDebugOptions {
  const defaults: AttendanceImportDebugOptions = {
    forceUploadCsv: false,
    forceAsyncImport: false,
    forceTimeoutOnce: false,
    pollIntervalMs: null,
    pollTimeoutMs: null,
  }
  if (typeof window === 'undefined') return defaults

  const raw = window.localStorage.getItem('metasheet_attendance_debug')
  if (!raw) return defaults
  try {
    const parsed = JSON.parse(raw) as Record<string, any>
    const importNode = parsed?.import && typeof parsed.import === 'object'
      ? (parsed.import as Record<string, any>)
      : parsed
    return {
      forceUploadCsv: parseDebugBoolean(importNode.forceUploadCsv ?? parsed.forceUploadCsv),
      forceAsyncImport: parseDebugBoolean(importNode.forceAsyncImport ?? parsed.forceAsyncImport),
      forceTimeoutOnce: parseDebugBoolean(importNode.forceTimeoutOnce ?? parsed.forceTimeoutOnce),
      pollIntervalMs: parseDebugPositiveInt(importNode.pollIntervalMs ?? parsed.pollIntervalMs),
      pollTimeoutMs: parseDebugPositiveInt(importNode.pollTimeoutMs ?? parsed.pollTimeoutMs),
    }
  } catch {
    return defaults
  }
}

const loading = ref(false)
const punching = ref(false)
const requestSubmitting = ref(false)
const summary = ref<AttendanceSummary | null>(null)
const records = ref<AttendanceRecord[]>([])
const requests = ref<AttendanceRequest[]>([])
const anomalies = ref<AttendanceAnomaly[]>([])
const anomaliesLoading = ref(false)
const statusMessage = ref('')
const statusKind = ref<'info' | 'error'>('info')
const statusMeta = ref<AttendanceStatusMeta | null>(null)
const calendarMonth = ref(new Date())
const pluginsLoaded = ref(false)
const exporting = ref(false)
const settingsLoading = ref(false)
const holidaySyncLoading = ref(false)
const provisionLoading = ref(false)
const provisionHasLoaded = ref(false)
const provisionStatusMessage = ref('')
const provisionStatusKind = ref<'info' | 'error'>('info')
const provisionPermissions = ref<string[]>([])
const provisionUserIsAdmin = ref(false)
const provisionRoles = ref<string[]>([])
const provisionUserProfile = ref<AttendanceAdminUserProfileSummary | null>(null)
const provisionRoleTemplates = ref<AttendanceAdminRoleTemplate[]>([])
const provisionSearchQuery = ref('')
const provisionSearchResults = ref<AttendanceAdminUserSearchItem[]>([])
const provisionSearchLoading = ref(false)
const provisionSearchHasSearched = ref(false)
const provisionSearchPage = ref(1)
const provisionSearchTotal = ref(0)
const provisionSearchPageSize = 10
const provisionSearchHasNext = computed(() => {
  return provisionSearchPage.value * provisionSearchPageSize < provisionSearchTotal.value
})
const provisionBatchLoading = ref(false)
const provisionBatchPreviewLoading = ref(false)
const provisionBatchUserIdsText = ref('')
const provisionBatchRole = ref<ProvisionRole>('employee')
const provisionBatchStatusMessage = ref('')
const provisionBatchStatusKind = ref<'info' | 'error'>('info')
const provisionBatchParsed = computed(() => parseUserIdListText(provisionBatchUserIdsText.value))
const provisionBatchIds = computed(() => provisionBatchParsed.value.valid)
const provisionBatchInvalidIds = computed(() => provisionBatchParsed.value.invalid)
const provisionBatchPreviewRequested = ref(0)
const provisionBatchPreviewItems = ref<AttendanceAdminBatchResolveItem[]>([])
const provisionBatchPreviewMissingIds = ref<string[]>([])
const provisionBatchPreviewInactiveIds = ref<string[]>([])
const provisionBatchAffectedIds = ref<string[]>([])
const provisionBatchUnchangedIds = ref<string[]>([])
const provisionBatchPreviewHasResult = computed(() => {
  return provisionBatchPreviewRequested.value > 0
    || provisionBatchPreviewItems.value.length > 0
    || provisionBatchPreviewMissingIds.value.length > 0
})
const auditLogLoading = ref(false)
const auditLogExporting = ref(false)
const auditLogs = ref<AttendanceAuditLogItem[]>([])
const auditLogQuery = ref('')
const auditLogActionPrefix = ref('')
const auditLogStatusClass = ref('')
const auditLogErrorCode = ref('')
const auditLogFrom = ref('')
const auditLogTo = ref('')
const auditLogStatusMessage = ref('')
const auditLogStatusKind = ref<'info' | 'error'>('info')
const auditLogPage = ref(1)
const auditLogTotal = ref(0)
const auditLogPageSize = 50
const auditLogTotalPages = computed(() => Math.max(1, Math.ceil(auditLogTotal.value / auditLogPageSize)))
const auditLogSelectedId = ref('')
const auditSummaryLoading = ref(false)
const auditSummaryActions = ref<AttendanceAuditSummaryRow[]>([])
const auditSummaryErrors = ref<AttendanceAuditSummaryRow[]>([])
const auditSummaryRowCount = computed(() => Math.max(auditSummaryActions.value.length, auditSummaryErrors.value.length))
const holidaySyncLastRun = ref<AttendanceSettings['holidaySync'] extends { lastRun?: infer T } ? T | null : any>(null)
const ruleLoading = ref(false)
const shiftLoading = ref(false)
const shiftSaving = ref(false)
const assignmentLoading = ref(false)
const assignmentSaving = ref(false)
const holidayLoading = ref(false)
const holidaySaving = ref(false)
const reportLoading = ref(false)
const leaveTypeLoading = ref(false)
const leaveTypeSaving = ref(false)
const overtimeRuleLoading = ref(false)
const overtimeRuleSaving = ref(false)
const approvalFlowLoading = ref(false)
const approvalFlowSaving = ref(false)
const rotationRuleLoading = ref(false)
const rotationRuleSaving = ref(false)
const rotationAssignmentLoading = ref(false)
const rotationAssignmentSaving = ref(false)
const ruleSetLoading = ref(false)
const ruleSetSaving = ref(false)
const ruleTemplateLoading = ref(false)
const ruleTemplateSaving = ref(false)
const ruleTemplateRestoring = ref(false)
const attendanceGroupLoading = ref(false)
const attendanceGroupSaving = ref(false)
const attendanceGroupMemberLoading = ref(false)
const attendanceGroupMemberSaving = ref(false)
const payrollTemplateLoading = ref(false)
const payrollTemplateSaving = ref(false)
const payrollCycleLoading = ref(false)
const payrollCycleSaving = ref(false)
const payrollCycleGenerating = ref(false)
const payrollCycleGenerateResult = ref<{ created: number; skipped: number } | null>(null)
const importLoading = ref(false)
const adminForbidden = ref(false)
const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const timezoneOptions = computed(() =>
  buildTimezoneOptions([defaultTimezone, 'UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'America/New_York'])
)
const overviewTimezoneLabel = computed(() => displayTimezone(defaultTimezone))
const overviewRefreshTimezoneContextHint = computed(() =>
  `${tr('Overview timezone context', '总览时区上下文')}: ${overviewTimezoneLabel.value}`
)
const calendarTimezoneContextHint = computed(() =>
  `${tr('Calendar timezone context', '日历时区上下文')}: ${overviewTimezoneLabel.value}`
)
const requestTimezoneContextHint = computed(() =>
  `${tr('Request timezone context', '申请时区上下文')}: ${overviewTimezoneLabel.value}`
)
const summaryTimezoneContextHint = computed(() =>
  `${tr('Summary timezone context', '汇总时区上下文')}: ${overviewTimezoneLabel.value}`
)
const anomaliesTimezoneContextHint = computed(() =>
  `${tr('Anomalies timezone context', '异常时区上下文')}: ${overviewTimezoneLabel.value}`
)
const requestReportTimezoneContextHint = computed(() =>
  `${tr('Request report timezone context', '申请报表时区上下文')}: ${overviewTimezoneLabel.value}`
)
const recordsTimezoneContextHint = computed(() =>
  `${tr('Records timezone context', '记录时区上下文')}: ${overviewTimezoneLabel.value}`
)
const holidaySyncAutoTimezoneLabel = computed(() => displayTimezone(settingsForm.holidaySyncAutoTimezone))
const ruleTimezoneLabel = computed(() => displayTimezone(ruleForm.timezone))
const attendanceGroupTimezoneLabel = computed(() => displayTimezone(attendanceGroupForm.timezone))
const importTimezoneLabel = computed(() => displayTimezone(importForm.timezone))
const importGroupTimezoneLabel = computed(() =>
  importGroupTimezone.value
    ? displayTimezone(importGroupTimezone.value)
    : `${tr('Use import timezone', '使用导入时区')} (${displayTimezone(importForm.timezone)})`
)
const importPreviewTimezoneHint = computed(() =>
  `${tr('Preview timezone', '预览时区')}: ${importTimezoneLabel.value} · ${tr('Group timezone', '分组时区')}: ${importGroupTimezoneLabel.value}`
)
const importBatchSnapshotContextLabel = computed(() => {
  const snapshot = importBatchSnapshot.value
  if (!snapshot) return '--'
  const context = snapshot.context && typeof snapshot.context === 'object'
    ? snapshot.context
    : null
  return `userId: ${context?.userId || '--'} · workDate: ${context?.workDate || '--'} · recordId: ${context?.recordId || '--'}`
})
const payrollTemplateTimezoneLabel = computed(() => displayTimezone(payrollTemplateForm.timezone))
const payrollCycleTemplateTimezoneHint = computed(() =>
  `${tr('Cycle template timezone', '周期模板时区')}: ${resolvePayrollTemplateTimezoneLabel(payrollCycleForm.templateId, 'manual')}`
)
const payrollCycleGenerateTimezoneHint = computed(() =>
  `${tr('Generate timezone context', '生成时区上下文')}: ${resolvePayrollTemplateTimezoneLabel(payrollCycleGenerateForm.templateId, 'default')}`
)
const rotationRuleTimezoneLabel = computed(() => displayTimezone(rotationRuleForm.timezone))
const shiftTimezoneLabel = computed(() => displayTimezone(shiftForm.timezone))

const provisionRolePermissions: Record<ProvisionRole, string[]> = {
  employee: ['attendance:read', 'attendance:write'],
  approver: ['attendance:read', 'attendance:approve'],
  admin: ['attendance:read', 'attendance:write', 'attendance:approve', 'attendance:admin'],
}

const shifts = ref<AttendanceShift[]>([])
const assignments = ref<AttendanceAssignmentItem[]>([])
const holidays = ref<AttendanceHoliday[]>([])
const requestReport = ref<AttendanceRequestReportItem[]>([])
const leaveTypes = ref<AttendanceLeaveType[]>([])
const overtimeRules = ref<AttendanceOvertimeRule[]>([])
const approvalFlows = ref<AttendanceApprovalFlow[]>([])
const rotationRules = ref<AttendanceRotationRule[]>([])
const rotationAssignments = ref<AttendanceRotationAssignmentItem[]>([])
const ruleSets = ref<AttendanceRuleSet[]>([])
const ruleTemplateSystemText = ref('[]')
const ruleTemplateLibraryText = ref('[]')
const ruleTemplateVersions = ref<AttendanceRuleTemplateVersion[]>([])
const attendanceGroups = ref<AttendanceGroup[]>([])
const attendanceGroupMembers = ref<AttendanceGroupMember[]>([])
const payrollTemplates = ref<AttendancePayrollTemplate[]>([])
const payrollCycles = ref<AttendancePayrollCycle[]>([])
const importPreview = ref<AttendanceImportPreviewItem[]>([])
const importBatches = ref<AttendanceImportBatch[]>([])
const importBatchItems = ref<AttendanceImportItem[]>([])
const importBatchSelectedId = ref('')
const importBatchSnapshot = ref<AttendanceImportBatchSnapshotState | null>(null)
const importCsvWarnings = ref<string[]>([])
const importPreviewTask = ref<AttendanceImportPreviewTask | null>(null)
const importAsyncJob = ref<AttendanceImportJob | null>(null)
const importAsyncPolling = ref(false)
const _reconcileResult = ref<AttendanceReconcileResult | null>(null)
const _rulePreviewResult = ref<AttendanceRulePreviewItem | null>(null)

function toNonNegativeNumber(value: unknown): number | null {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return null
  return num
}

const importAsyncJobTelemetryText = computed(() => {
  const job = importAsyncJob.value
  if (!job) return ''

  const parts: string[] = []
  const engine = String(job.engine || '').trim()
  const total = toNonNegativeNumber(job.total)
  const hasInlineProgress = total !== null && total > 0
  const processed = toNonNegativeNumber(
    job.processedRows ?? (hasInlineProgress ? null : job.progress),
  )
  const failed = toNonNegativeNumber(job.failedRows)
  const elapsedMs = toNonNegativeNumber(job.elapsedMs)
  const progressPercent = toNonNegativeNumber(job.progressPercent)
  const throughputRowsPerSec = toNonNegativeNumber(job.throughputRowsPerSec)

  if (engine) parts.push(`Engine: ${engine}`)
  if (processed !== null) {
    if (total !== null && total > 0) {
      parts.push(`Processed: ${processed}/${total}`)
    } else {
      parts.push(`Processed: ${processed}`)
    }
  }
  if (failed !== null) parts.push(`Failed: ${failed}`)
  if (elapsedMs !== null) parts.push(`Elapsed: ${Math.round(elapsedMs)} ms`)
  if (!hasInlineProgress && progressPercent !== null) parts.push(`Progress: ${Math.round(progressPercent)}%`)
  if (throughputRowsPerSec !== null) parts.push(`Throughput: ${throughputRowsPerSec.toFixed(2)} rows/s`)

  return parts.join(' · ')
})

const shiftEditingId = ref<string | null>(null)
const assignmentEditingId = ref<string | null>(null)
const holidayEditingId = ref<string | null>(null)
const leaveTypeEditingId = ref<string | null>(null)
const overtimeRuleEditingId = ref<string | null>(null)
const approvalFlowEditingId = ref<string | null>(null)
const rotationRuleEditingId = ref<string | null>(null)
const rotationAssignmentEditingId = ref<string | null>(null)
const ruleSetEditingId = ref<string | null>(null)
const attendanceGroupEditingId = ref<string | null>(null)
const attendanceGroupMemberGroupId = ref('')
const attendanceGroupMemberUserIds = ref('')
const payrollTemplateEditingId = ref<string | null>(null)
const payrollCycleEditingId = ref<string | null>(null)
const payrollCycleSummary = ref<AttendanceSummary | null>(null)
const importProfileId = ref('')
const importMode = ref<'override' | 'merge'>('override')
const importMappingProfiles = ref<AttendanceImportMappingProfile[]>([])
const selectedImportProfile = computed(() => {
  if (!importProfileId.value) return null
  return importMappingProfiles.value.find(profile => profile.id === importProfileId.value) ?? null
})
const attendanceGroupOptions = computed(() =>
  attendanceGroups.value.map(group => group.name).filter(name => Boolean(name))
)
const importCsvFile = ref<File | null>(null)
const importCsvFileName = ref('')
const importCsvFileId = ref('')
const importCsvFileRowCountHint = ref<number | null>(null)
const importCsvFileExpiresAt = ref('')
const importCsvHeaderRow = ref('')
const importCsvDelimiter = ref(',')
const importUserMapFile = ref<File | null>(null)
const importUserMapFileName = ref('')
const importUserMap = ref<Record<string, any> | null>(null)
const importUserMapError = ref('')
const importUserMapKeyField = ref('')
const importUserMapSourceFields = ref('')
const importGroupAutoCreate = ref(false)
const importGroupAutoAssign = ref(false)
const importGroupRuleSetId = ref('')
const importGroupTimezone = ref('')
const importCommitToken = ref('')
const importCommitTokenExpiresAt = ref('')

const importUserMapCount = computed(() => {
  if (!importUserMap.value) return 0
  if (Array.isArray(importUserMap.value)) return importUserMap.value.length
  return Object.keys(importUserMap.value).length
})

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
const {
  adminActiveSectionId,
  adminCompactNavOpen,
  adminNavDefaultStorageScope,
  adminNavScopeFeedback,
  adminNavStorageScope,
  adminSectionFilter,
  adminSectionFilterActive,
  adminSectionNavCountLabel,
  adminSectionNavItems,
  allAdminSectionGroupsCollapsed,
  allAdminSectionGroupsExpanded,
  activeAdminSectionContextLabel,
  clearRecentAdminSections,
  copyCurrentAdminSectionLink,
  expandAllAdminSectionGroups,
  isCompactAdminNav,
  isKnownAdminSectionId,
  readLastAdminSection,
  collapseAllAdminSectionGroups,
  toggleAdminSectionGroup,
  visibleAdminSectionNavGroups,
  visibleRecentAdminSectionNavItems,
} = useAttendanceAdminRail({
  tr,
  resolveStorageScope: normalizedOrgId,
  showAdmin,
  notify: (message, kind = 'info') => setStatus(message, kind),
})

const {
  adminSectionBinding,
  scrollToAdminSection,
} = useAttendanceAdminRailNavigation({
  showAdmin,
  adminForbidden,
  adminNavStorageScope,
  adminActiveSectionId,
  adminSectionNavItems,
  isKnownAdminSectionId,
  readLastAdminSection,
  isCompactAdminNav,
  adminCompactNavOpen,
})

const statusCode = computed(() => statusMeta.value?.code || '')
const statusHint = computed(() => statusMeta.value?.hint || '')
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
  if (action === 'reload-admin') return settingsLoading.value || ruleLoading.value
  if (action === 'reload-import-job') return importAsyncPolling.value
  if (action === 'resume-import-job') return importAsyncPolling.value
  if (action === 'reload-import-csv') return importLoading.value
  if (action === 'retry-save-settings') return settingsLoading.value
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
const calendarDisplayPrefs = loadCalendarDisplayPrefs()
const showLunarLabel = ref(calendarDisplayPrefs.showLunar)
const showHolidayBadge = ref(calendarDisplayPrefs.showHoliday)

const weekDays = computed(() => (
  isZh.value
    ? ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
))
const calendarLabel = computed(() => {
  return new Intl.DateTimeFormat(isZh.value ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'long' }).format(calendarMonth.value)
})

watch([showLunarLabel, showHolidayBadge], ([showLunar, showHoliday]) => {
  persistCalendarDisplayPrefs({ showLunar, showHoliday })
})

const recordMap = computed(() => {
  const map = new Map<string, AttendanceRecord>()
  records.value.forEach((record) => {
    map.set(record.work_date, record)
  })
  return map
})

const holidayMap = computed(() => {
  const map = new Map<string, AttendanceHoliday>()
  holidays.value.forEach((holiday) => {
    const key = normalizeDateKey(holiday.date)
    if (key) map.set(key, holiday)
  })
  return map
})

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
    const lunarLabel = formatLunarDayLabel(date)
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

const isLeaveRequest = computed(() => requestForm.requestType === 'leave')
const isOvertimeRequest = computed(() => requestForm.requestType === 'overtime')
const isLeaveOrOvertimeRequest = computed(() => isLeaveRequest.value || isOvertimeRequest.value)

const settingsForm = reactive({
  autoAbsenceEnabled: false,
  autoAbsenceRunAt: '00:15',
  autoAbsenceLookbackDays: 1,
  holidayFirstDayEnabled: true,
  holidayFirstDayBaseHours: 8,
  holidayOvertimeAdds: true,
  holidayOvertimeSource: 'approval' as 'approval' | 'clock' | 'both',
  holidayOverrides: [] as HolidayPolicyOverrideForm[],
  holidaySyncBaseUrl: 'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master',
  holidaySyncYears: '',
  holidaySyncAddDayIndex: true,
  holidaySyncDayIndexHolidays: '春节,国庆',
  holidaySyncDayIndexMaxDays: 7,
  holidaySyncDayIndexFormat: 'name-1',
  holidaySyncOverwrite: false,
  holidaySyncAutoEnabled: false,
  holidaySyncAutoRunAt: '02:00',
  holidaySyncAutoTimezone: 'UTC',
  ipAllowlist: '',
  geoFenceLat: '',
  geoFenceLng: '',
  geoFenceRadius: '',
  minPunchIntervalMinutes: 1,
})

const provisionForm = reactive({
  userId: '',
  role: 'employee' as ProvisionRole,
})

const ruleForm = reactive({
  name: 'Default',
  timezone: defaultTimezone,
  workStartTime: '09:00',
  workEndTime: '18:00',
  lateGraceMinutes: 10,
  earlyGraceMinutes: 10,
  roundingMinutes: 5,
  workingDays: '1,2,3,4,5',
})

const shiftForm = reactive({
  name: 'Standard Shift',
  timezone: defaultTimezone,
  workStartTime: '09:00',
  workEndTime: '18:00',
  lateGraceMinutes: 10,
  earlyGraceMinutes: 10,
  roundingMinutes: 5,
  workingDays: '1,2,3,4,5',
})

const assignmentForm = reactive({
  userId: '',
  shiftId: '',
  startDate: toDateInput(today),
  endDate: '',
  isActive: true,
})

const holidayForm = reactive({
  date: toDateInput(today),
  name: '',
  isWorkingDay: false,
})

const leaveTypeForm = reactive({
  code: '',
  name: '',
  requiresApproval: true,
  requiresAttachment: false,
  defaultMinutesPerDay: 480,
  isActive: true,
})

const overtimeRuleForm = reactive({
  name: '',
  minMinutes: 0,
  roundingMinutes: 15,
  maxMinutesPerDay: 600,
  requiresApproval: true,
  isActive: true,
})

const approvalFlowForm = reactive({
  name: '',
  requestType: 'leave',
  steps: '',
  isActive: true,
})

const rotationRuleForm = reactive({
  name: '',
  timezone: defaultTimezone,
  shiftSequence: '',
  isActive: true,
})

const rotationAssignmentForm = reactive({
  userId: '',
  rotationRuleId: '',
  startDate: toDateInput(today),
  endDate: '',
  isActive: true,
})

const ruleSetForm = reactive({
  name: '',
  description: '',
  version: 1,
  scope: 'org',
  isDefault: false,
  config: '{}',
})

const attendanceGroupForm = reactive({
  name: '',
  code: '',
  timezone: defaultTimezone,
  ruleSetId: '',
  description: '',
})

const payrollTemplateForm = reactive({
  name: '',
  timezone: defaultTimezone,
  startDay: 1,
  endDay: 30,
  endMonthOffset: 0,
  autoGenerate: true,
  isDefault: false,
  config: '{}',
})

const payrollCycleForm = reactive({
  templateId: '',
  name: '',
  anchorDate: '',
  startDate: '',
  endDate: '',
  status: 'open',
})

const payrollCycleGenerateForm = reactive({
  templateId: '',
  anchorDate: toDateInput(today),
  count: 1,
  status: 'open',
  namePrefix: '',
  metadata: '{}',
})

const importForm = reactive({
  ruleSetId: '',
  userId: '',
  timezone: defaultTimezone,
  payload: '{}',
})

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeDateKey(value: string | null | undefined): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  if (direct) return direct[1]
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

function formatDateTime(value: string | null): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString(locale.value)
}

function displayTimezone(value: string | null | undefined): string {
  return formatTimezoneLabel(value)
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

function formatLunarDayLabel(date: Date): string | undefined {
  if (!isZh.value || Number.isNaN(date.getTime())) return undefined
  try {
    const text = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      month: 'short',
      day: 'numeric',
    }).format(date)
    const normalized = text.replace(/\s+/g, '')
    return normalized || undefined
  } catch {
    return undefined
  }
}

function formatWarningsShort(warnings: string[]): string {
  if (!warnings || warnings.length === 0) return '--'
  const head = warnings.slice(0, 2).join(', ')
  if (warnings.length > 2) return `${head} (+${warnings.length - 2})`
  return head
}

async function prefillRequestFromAnomaly(item: AttendanceAnomaly): Promise<void> {
  if (item.state === 'pending') {
    setStatus(
      appendStatusContext(
        tr('A pending request already exists for this work date.', '该工作日已存在待处理申请。'),
        requestTimezoneContextHint.value,
      ),
      'error',
    )
    return
  }
  requestForm.workDate = item.workDate
  requestForm.requestType = item.suggestedRequestType ?? 'time_correction'
  setStatus(
    appendStatusContext(
      tr('Request form updated from anomaly.', '已根据异常记录填充申请表单。'),
      requestTimezoneContextHint.value,
    ),
  )
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

function parseWorkingDaysInput(value: string): number[] {
  const days = value
    .split(',')
    .map(item => Number(item.trim()))
    .filter(item => Number.isFinite(item) && item >= 0 && item <= 6)
  return days.length > 0 ? days : [1, 2, 3, 4, 5]
}

function parseShiftSequenceInput(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean)
}

function parseApprovalStepsInput(value: string): AttendanceApprovalStep[] | null {
  if (!value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    return parsed.filter(item => item && typeof item === 'object') as AttendanceApprovalStep[]
  } catch {
    return null
  }
}

function parseUserIdList(value: string): string[] {
  if (!value) return []
  return Array.from(new Set(
    value
      .split(/[\n,，\s]+/)
      .map(item => item.trim())
      .filter(Boolean)
  ))
}

function formatApprovalSteps(steps: AttendanceApprovalStep[]): string {
  return JSON.stringify(steps ?? [], null, 2)
}

function formatMetaMinutes(meta: Record<string, any> | undefined, key: 'leave' | 'overtime'): string {
  if (!meta) return '--'
  const leaveMinutes = Number(meta.leave_minutes ?? meta.leaveMinutes ?? 0)
  const overtimeMinutes = Number(meta.overtime_minutes ?? meta.overtimeMinutes ?? 0)
  const value = key === 'leave' ? leaveMinutes : overtimeMinutes
  return Number.isFinite(value) && value > 0 ? String(value) : '--'
}

function parseJsonConfig(value: string): Record<string, any> | null {
  const trimmed = value.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, any>
    return null
  } catch {
    return null
  }
}

function parseTemplateLibrary(value: string): any[] | null {
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object') {
      const templates = (parsed as any).templates ?? (parsed as any).library
      if (Array.isArray(templates)) return templates
    }
    return null
  } catch {
    return null
  }
}

function validateTemplateLibrarySchema(templates: any[]): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  templates.forEach((template, index) => {
    if (!template || typeof template !== 'object' || Array.isArray(template)) {
      errors.push(`[${index}] template must be an object`)
      return
    }
    if (typeof template.name !== 'string' || template.name.trim().length === 0) {
      errors.push(`[${index}].name must be a non-empty string`)
    }
    if (!Array.isArray(template.rules)) {
      errors.push(`[${index}].rules must be an array`)
    } else {
      template.rules.forEach((rule: any, ruleIndex: number) => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
          errors.push(`[${index}].rules[${ruleIndex}] must be an object`)
        }
      })
    }
    if (template.params !== undefined && !Array.isArray(template.params)) {
      errors.push(`[${index}].params must be an array when provided`)
    } else if (Array.isArray(template.params)) {
      template.params.forEach((param: any, paramIndex: number) => {
        if (!param || typeof param !== 'object' || Array.isArray(param)) {
          errors.push(`[${index}].params[${paramIndex}] must be an object`)
        } else if (typeof param.key !== 'string' || param.key.trim().length === 0) {
          errors.push(`[${index}].params[${paramIndex}].key must be a non-empty string`)
        }
      })
    }
  })
  return { ok: errors.length === 0, errors }
}

function buildImportPayload(): Record<string, any> | null {
  const parsed = parseJsonConfig(importForm.payload)
  if (!parsed) return null
  const payload = { ...parsed }
  const resolvedOrgId = normalizedOrgId()
  const resolvedUserId = importForm.userId.trim() || normalizedUserId()
  if (resolvedOrgId && !payload.orgId) payload.orgId = resolvedOrgId
  if (resolvedUserId && !payload.userId) payload.userId = resolvedUserId
  const uuidLike = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  if (importForm.ruleSetId) {
    // Always honor the explicit selection (override template placeholders).
    payload.ruleSetId = importForm.ruleSetId
  } else if (typeof payload.ruleSetId === 'string') {
    // The backend template payload example may contain placeholders like "<ruleSetId>",
    // but the API validates ruleSetId as a UUID. If the user didn't pick a rule set,
    // treat invalid strings as "unset" so the default rule set can be used.
    const trimmed = payload.ruleSetId.trim()
    if (trimmed && !uuidLike(trimmed)) delete payload.ruleSetId
  }
  if (importForm.timezone && !payload.timezone) payload.timezone = importForm.timezone
  const userMapKeyField = resolveImportUserMapKeyField()
  const userMapSourceFields = resolveImportUserMapSourceFields()
  if (importUserMap.value) payload.userMap = importUserMap.value
  if (userMapKeyField) payload.userMapKeyField = userMapKeyField
  if (userMapSourceFields.length) payload.userMapSourceFields = userMapSourceFields
  if (!payload.groupSync && (importGroupAutoCreate.value || importGroupAutoAssign.value)) {
    payload.groupSync = {
      autoCreate: importGroupAutoCreate.value,
      autoAssignMembers: importGroupAutoAssign.value,
      ruleSetId: importGroupRuleSetId.value || undefined,
      timezone: importGroupTimezone.value || undefined,
    }
  }
  payload.mode = importMode.value || payload.mode || 'override'
  if (payload.mappingProfileId === '') delete payload.mappingProfileId
  return payload
}

const IMPORT_LARGE_ROW_THRESHOLD = 2000
const IMPORT_PREVIEW_LIMIT = 200
const IMPORT_COMMIT_ITEMS_LIMIT = 200
const IMPORT_PREVIEW_CHUNK_THRESHOLD = 10_000
const IMPORT_PREVIEW_CHUNK_SIZE = 5000
const IMPORT_PREVIEW_ASYNC_ROW_THRESHOLD = 50_000
const IMPORT_ASYNC_ROW_THRESHOLD = 50_000
const IMPORT_ASYNC_DEFAULT_POLL_INTERVAL_MS = 2000
const IMPORT_ASYNC_DEFAULT_POLL_TIMEOUT_MS = 30 * 60 * 1000
const ATTENDANCE_ADMIN_REQUEST_TIMEOUT_MS = 45 * 1000

function parseEnvPositiveInt(raw: unknown, fallback: number, minimum = 1): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  const normalized = Math.floor(parsed)
  if (normalized < minimum) return fallback
  return normalized
}

const importThresholds = {
  largeRow: parseEnvPositiveInt(import.meta.env.VITE_ATTENDANCE_IMPORT_LARGE_ROW_THRESHOLD, IMPORT_LARGE_ROW_THRESHOLD, 100),
  previewLimit: parseEnvPositiveInt(import.meta.env.VITE_ATTENDANCE_IMPORT_PREVIEW_LIMIT, IMPORT_PREVIEW_LIMIT, 10),
  commitItemsLimit: parseEnvPositiveInt(import.meta.env.VITE_ATTENDANCE_IMPORT_COMMIT_ITEMS_LIMIT, IMPORT_COMMIT_ITEMS_LIMIT, 10),
  previewChunkThreshold: parseEnvPositiveInt(import.meta.env.VITE_ATTENDANCE_IMPORT_PREVIEW_CHUNK_THRESHOLD, IMPORT_PREVIEW_CHUNK_THRESHOLD, 1000),
  previewChunkSize: parseEnvPositiveInt(import.meta.env.VITE_ATTENDANCE_IMPORT_PREVIEW_CHUNK_SIZE, IMPORT_PREVIEW_CHUNK_SIZE, 100),
  previewAsyncThreshold: parseEnvPositiveInt(import.meta.env.VITE_ATTENDANCE_IMPORT_PREVIEW_ASYNC_ROW_THRESHOLD, IMPORT_PREVIEW_ASYNC_ROW_THRESHOLD, 1000),
  commitAsyncThreshold: parseEnvPositiveInt(
    import.meta.env.VITE_ATTENDANCE_IMPORT_COMMIT_ASYNC_ROW_THRESHOLD
      ?? import.meta.env.VITE_ATTENDANCE_IMPORT_ASYNC_ROW_THRESHOLD,
    IMPORT_ASYNC_ROW_THRESHOLD,
    1000,
  ),
}

const importScalabilityHint = computed(() => {
  const previewChunk = importThresholds.previewChunkThreshold.toLocaleString()
  const previewChunkSize = importThresholds.previewChunkSize.toLocaleString()
  const previewAsync = importThresholds.previewAsyncThreshold.toLocaleString()
  const commitAsync = importThresholds.commitAsyncThreshold.toLocaleString()
  return `Auto mode: preview >= ${previewChunk} rows may use chunked preview (${previewChunkSize}/chunk); preview >= ${previewAsync} rows queues async preview; import >= ${commitAsync} rows queues async import.`
})

const importDebugOptions = readImportDebugOptions()
const importAsyncPollIntervalMs = importDebugOptions.pollIntervalMs ?? IMPORT_ASYNC_DEFAULT_POLL_INTERVAL_MS
const importAsyncPollTimeoutMs = importDebugOptions.pollTimeoutMs ?? IMPORT_ASYNC_DEFAULT_POLL_TIMEOUT_MS
let importDebugTimeoutPending = importDebugOptions.forceTimeoutOnce

function estimateImportRowCount(payload: Record<string, any>): number | null {
  if (importDebugOptions.forceAsyncImport) {
    return importThresholds.previewAsyncThreshold
  }
  if (typeof payload.csvFileId === 'string' && payload.csvFileId.trim().length > 0) {
    const id = payload.csvFileId.trim()
    if (importCsvFileId.value && id === importCsvFileId.value && importCsvFileRowCountHint.value) {
      return importCsvFileRowCountHint.value
    }
    // Force async import path when the payload references a server-side upload.
    return importThresholds.previewAsyncThreshold
  }
  if (Array.isArray(payload.rows)) return payload.rows.length
  if (typeof payload.csvText === 'string') {
    // Cheap line-count heuristic (avoid splitting large strings).
    let lines = 0
    for (let i = 0; i < payload.csvText.length; i++) {
      if (payload.csvText[i] === '\n') lines += 1
    }
    // header + last line (if no trailing newline)
    return Math.max(0, lines)
  }
  return null
}

function applyImportScalabilityHints(payload: Record<string, any>, options: { mode: 'preview' | 'commit' }) {
  const rowCountHint = estimateImportRowCount(payload)
  if (!rowCountHint || rowCountHint <= importThresholds.largeRow) return

  if (options.mode === 'preview') {
    if (payload.previewLimit === undefined || payload.previewLimit === null) {
      payload.previewLimit = importThresholds.previewLimit
    }
    return
  }

  // commit
  if (payload.returnItems === undefined || payload.returnItems === null) {
    payload.returnItems = false
  }
  if (payload.itemsLimit === undefined || payload.itemsLimit === null) {
    payload.itemsLimit = importThresholds.commitItemsLimit
  }
}

interface ImportPreviewChunkPlan {
  totalRows: number
  chunkCount: number
  sampleLimit: number
  buildPayload: (chunkIndex: number, remainingSample: number) => Record<string, any>
}

function normalizePreviewSampleLimit(rawLimit: unknown): number {
  const value = Number(rawLimit)
  if (!Number.isFinite(value)) return importThresholds.previewLimit
  return Math.min(Math.max(Math.trunc(value), 1), 1000)
}

function splitCsvRecords(csvText: string): string[] {
  if (!csvText) return []
  const records: string[] = []
  let start = 0
  let inQuotes = false

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i]
    if (ch === '"') {
      if (inQuotes && csvText[i + 1] === '"') {
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (ch === '\n' && !inQuotes) {
      const raw = csvText.slice(start, i)
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      records.push(line)
      start = i + 1
    }
  }

  if (start <= csvText.length) {
    const raw = csvText.slice(start)
    if (raw.length > 0) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      records.push(line)
    }
  }

  if (records.length > 0 && records[0].charCodeAt(0) === 0xfeff) {
    records[0] = records[0].slice(1)
  }
  return records.filter((line, index) => !(index === records.length - 1 && line.trim() === ''))
}

function buildChunkedImportPreviewPlan(payload: Record<string, any>): ImportPreviewChunkPlan | null {
  const chunkThreshold = importThresholds.previewChunkThreshold
  const chunkSize = importThresholds.previewChunkSize
  const sampleCap = importThresholds.previewLimit
  const sampleLimit = normalizePreviewSampleLimit(payload.previewLimit)

  if (Array.isArray(payload.rows) && payload.rows.length >= chunkThreshold) {
    const totalRows = payload.rows.length
    const chunkCount = Math.ceil(totalRows / chunkSize)
    return {
      totalRows,
      chunkCount,
      sampleLimit,
      buildPayload: (chunkIndex, remainingSample) => {
        const start = chunkIndex * chunkSize
        const end = Math.min(totalRows, start + chunkSize)
        return {
          ...payload,
          rows: payload.rows.slice(start, end),
          previewLimit: Math.max(1, Math.min(remainingSample, sampleCap)),
        }
      },
    }
  }

  if (Array.isArray(payload.entries) && payload.entries.length >= chunkThreshold) {
    const totalRows = payload.entries.length
    const chunkCount = Math.ceil(totalRows / chunkSize)
    return {
      totalRows,
      chunkCount,
      sampleLimit,
      buildPayload: (chunkIndex, remainingSample) => {
        const start = chunkIndex * chunkSize
        const end = Math.min(totalRows, start + chunkSize)
        return {
          ...payload,
          entries: payload.entries.slice(start, end),
          previewLimit: Math.max(1, Math.min(remainingSample, sampleCap)),
        }
      },
    }
  }

  if (typeof payload.csvText === 'string' && payload.csvText.length > 0) {
    const records = splitCsvRecords(payload.csvText)
    if (records.length <= 1) return null
    const header = records[0]
    const dataRows = records.slice(1)
    const totalRows = dataRows.length
    if (totalRows < chunkThreshold) return null
    const chunkCount = Math.ceil(totalRows / chunkSize)

    return {
      totalRows,
      chunkCount,
      sampleLimit,
      buildPayload: (chunkIndex, remainingSample) => {
        const start = chunkIndex * chunkSize
        const end = Math.min(totalRows, start + chunkSize)
        const csvText = [header, ...dataRows.slice(start, end)].join('\n')
        const nextPayload: Record<string, any> = {
          ...payload,
          csvText,
          previewLimit: Math.max(1, Math.min(remainingSample, sampleCap)),
        }
        delete nextPayload.rows
        delete nextPayload.entries
        return nextPayload
      },
    }
  }

  return null
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveImportJobProcessedRows(job: AttendanceImportJob | null): number {
  if (!job) return 0
  const direct = Number(job.processedRows)
  if (Number.isFinite(direct)) return Math.max(0, Math.floor(direct))
  const fallback = Number(job.progress)
  return Number.isFinite(fallback) ? Math.max(0, Math.floor(fallback)) : 0
}

function _resolveImportJobFailedRows(job: AttendanceImportJob | null): number {
  if (!job) return 0
  const direct = Number(job.failedRows)
  if (Number.isFinite(direct)) return Math.max(0, Math.floor(direct))
  if (job.status === 'failed') {
    const total = Number(job.total)
    const processed = resolveImportJobProcessedRows(job)
    if (Number.isFinite(total)) return Math.max(0, Math.floor(total) - processed)
  }
  return 0
}

function _formatImportElapsedMs(value: unknown): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return '--'
  if (numeric < 1000) return `${Math.round(numeric)} ms`
  const seconds = numeric / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const minutes = Math.floor(seconds / 60)
  const remainSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainSeconds}s`
}

function syncImportModeToPayload() {
  const base = parseJsonConfig(importForm.payload)
  if (!base) return
  const current = typeof (base as any).mode === 'string' ? String((base as any).mode) : ''
  if (current === importMode.value) return
  importForm.payload = JSON.stringify({ ...base, mode: importMode.value }, null, 2)
}

function payrollTemplateName(templateId?: string | null): string {
  if (!templateId) return tr('Manual', '手工')
  const found = payrollTemplates.value.find(item => item.id === templateId)
  return found?.name ?? templateId
}

function resolvePayrollTemplateTimezoneLabel(
  templateId: string | null | undefined,
  fallback: 'manual' | 'default',
): string {
  if (templateId) {
    const found = payrollTemplates.value.find(item => item.id === templateId)
    if (found) return `${found.name} (${displayTimezone(found.timezone)})`
    return `${templateId} (${tr('template unavailable', '模板不可用')})`
  }

  if (fallback === 'default') {
    const found = payrollTemplates.value.find(item => item.isDefault) ?? payrollTemplates.value[0]
    if (found) return `${tr('Default template', '默认模板')} · ${found.name} (${displayTimezone(found.timezone)})`
    return tr('Default template unavailable', '默认模板不可用')
  }

  return tr('Manual dates (no template timezone)', '手工日期（无模板时区）')
}

function appendStatusContext(message: string, context: string): string {
  return `${message} · ${context}`
}

function appendStatusHintContext(hint: string | undefined, context: string): string {
  return hint ? `${hint} ${context}` : context
}

function setStatusFromErrorWithContext(
  error: unknown,
  fallbackMessage: string,
  statusContext: string,
  context: AttendanceStatusContext,
) {
  const { message, meta } = classifyStatusError(error, fallbackMessage, context)
  setStatus(
    message || fallbackMessage,
    'error',
    {
      ...meta,
      hint: appendStatusHintContext(meta.hint, statusContext),
    },
  )
}

async function loadImportTemplate() {
  clearImportPreviewTask()
  importLoading.value = true
  try {
    const response = await apiFetch('/api/attendance/import/template')
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load import template', '加载导入模板失败')))
    }
    const payloadExample = (data.data?.payloadExample ?? {}) as Record<string, any>
    importMode.value = payloadExample?.mode === 'merge' ? 'merge' : 'override'
    importForm.payload = JSON.stringify(payloadExample, null, 2)
    importMappingProfiles.value = Array.isArray(data.data?.mappingProfiles) ? data.data.mappingProfiles : []
    setStatus(tr('Import template loaded.', '导入模板已加载。'))
  } catch (error) {
    setStatus(readErrorMessage(error, tr('Failed to load import template', '加载导入模板失败')), 'error')
  } finally {
    importLoading.value = false
  }
}

function applyImportProfile() {
  const profile = selectedImportProfile.value
  if (!profile) {
    setStatus(tr('Select an import mapping profile first.', '请先选择导入映射配置。'), 'error')
    return
  }
  const base = parseJsonConfig(importForm.payload)
  if (!base) {
    setStatus(tr('Import payload must be valid JSON before applying profile.', '应用配置前，导入载荷必须是合法 JSON。'), 'error')
    return
  }
  let next = { ...base }
  if (profile.payloadExample && Object.keys(base).length === 0) {
    next = { ...profile.payloadExample }
  } else {
    if (profile.source) next.source = profile.source
    if (profile.mapping) next.mapping = profile.mapping
    if (profile.userMapKeyField) next.userMapKeyField = profile.userMapKeyField
    if (profile.userMapSourceFields) next.userMapSourceFields = profile.userMapSourceFields
  }
  next.mappingProfileId = profile.id
  importForm.payload = JSON.stringify(next, null, 2)
  setStatus(tr(`Applied mapping profile: ${profile.name}`, `已应用映射配置：${profile.name}`))
}

function splitListInput(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function resolveImportUserMapKeyField(): string {
  return importUserMapKeyField.value.trim()
    || selectedImportProfile.value?.userMapKeyField
    || ''
}

function resolveImportUserMapSourceFields(): string[] {
  if (importUserMapSourceFields.value.trim()) {
    return splitListInput(importUserMapSourceFields.value)
  }
  return selectedImportProfile.value?.userMapSourceFields ?? []
}

function normalizeUserMapPayload(payload: any, keyField: string): Record<string, any> | null {
  if (!payload) return null
  if (payload.mapping && typeof payload.mapping === 'object' && !Array.isArray(payload.mapping)) {
    return payload.mapping as Record<string, any>
  }
  if (Array.isArray(payload)) {
    if (!keyField) return null
    const map: Record<string, any> = {}
    payload.forEach((entry) => {
      const key = entry?.[keyField]
      if (key !== undefined && key !== null) {
        const textKey = String(key).trim()
        if (textKey) map[textKey] = entry
      }
    })
    return Object.keys(map).length ? map : null
  }
  if (typeof payload === 'object') return payload as Record<string, any>
  return null
}

function handleImportCsvChange(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target?.files?.[0] ?? null
  importCsvFile.value = file
  importCsvFileName.value = file?.name ?? ''
  importCsvFileId.value = ''
  importCsvFileRowCountHint.value = null
  importCsvFileExpiresAt.value = ''
}

async function handleImportUserMapChange(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target?.files?.[0] ?? null
  importUserMapFile.value = file
  importUserMapFileName.value = file?.name ?? ''
  importUserMapError.value = ''
  if (!file) {
    importUserMap.value = null
    return
  }
  try {
    const text = await file.text()
    const parsed = JSON.parse(text)
    const keyField = resolveImportUserMapKeyField()
    const normalized = normalizeUserMapPayload(parsed, keyField)
    if (!normalized) {
      throw new Error(tr('User map JSON format not recognized. Provide mapping object or array with key field.', '无法识别用户映射 JSON 格式。请提供映射对象或包含关键字段的数组。'))
    }
    importUserMap.value = normalized
    setStatus(tr(`User map loaded (${Object.keys(normalized).length} entries).`, `用户映射已加载（${Object.keys(normalized).length} 条）。`))
  } catch (error) {
    importUserMap.value = null
    importUserMapError.value = readErrorMessage(error, tr('Failed to parse user map JSON', '解析用户映射 JSON 失败'))
    setStatus(importUserMapError.value, 'error')
  }
}

const IMPORT_CSV_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024

async function uploadImportCsvFile(file: File): Promise<{ fileId: string; rowCount: number; bytes: number; expiresAt: string }> {
  const query = new URLSearchParams()
  const resolvedOrgId = normalizedOrgId()
  if (resolvedOrgId) query.set('orgId', resolvedOrgId)
  if (file?.name) query.set('filename', file.name)

  const response = await apiFetch(`/api/attendance/import/upload?${query.toString()}`, {
    method: 'POST',
    body: file,
    headers: {
      'Content-Type': file?.type && file.type.toLowerCase().includes('csv') ? file.type : 'text/csv',
    },
  })

  const data = await response.json().catch(() => ({} as any))
  if (!response.ok || !data?.ok) {
    throw new Error(readErrorMessage(data, tr(`Failed to upload CSV (HTTP ${response.status})`, `上传 CSV 失败（HTTP ${response.status}）`)))
  }
  const fileId = String(data.data?.fileId || '')
  if (!fileId) throw new Error(tr('Upload did not return fileId', '上传接口未返回 fileId'))
  const rowCount = Number(data.data?.rowCount ?? 0)
  const bytes = Number(data.data?.bytes ?? 0)
  const expiresAt = String(data.data?.expiresAt ?? '')
  return { fileId, rowCount, bytes, expiresAt }
}

async function applyImportCsvFile() {
  if (!importCsvFile.value) {
    setStatus(tr('Select a CSV file first.', '请先选择 CSV 文件。'), 'error', {
      hint: tr('Choose a CSV file, then retry preview/import.', '选择 CSV 文件后，再重试预览或导入。'),
      action: 'retry-preview-import',
    })
    return
  }
  try {
    const file = importCsvFile.value
    const base = parseJsonConfig(importForm.payload) ?? {}
    const next: Record<string, any> = {
      ...base,
      source: base.source ?? 'dingtalk_csv',
    }
    const resolvedOrgId = normalizedOrgId()
    if (resolvedOrgId && !next.orgId) next.orgId = resolvedOrgId
    if (importProfileId.value && !next.mappingProfileId) {
      next.mappingProfileId = importProfileId.value
    }
    const csvOptions: Record<string, any> = {}
    if (importCsvHeaderRow.value !== '') {
      const rowIndex = Number(importCsvHeaderRow.value)
      if (Number.isFinite(rowIndex) && rowIndex >= 0) csvOptions.headerRowIndex = rowIndex
    }
    if (importCsvDelimiter.value && importCsvDelimiter.value !== ',') {
      csvOptions.delimiter = importCsvDelimiter.value
    }
    if (Object.keys(csvOptions).length) next.csvOptions = csvOptions

    const shouldUpload = importDebugOptions.forceUploadCsv || file.size >= IMPORT_CSV_UPLOAD_THRESHOLD_BYTES
    if (shouldUpload) {
      const uploaded = await uploadImportCsvFile(file)
      importCsvFileId.value = uploaded.fileId
      importCsvFileRowCountHint.value = Number.isFinite(uploaded.rowCount) && uploaded.rowCount > 0 ? uploaded.rowCount : null
      importCsvFileExpiresAt.value = uploaded.expiresAt
      next.csvFileId = uploaded.fileId
      delete next.csvText
      setStatus(
        tr(
          `CSV uploaded: ${importCsvFileName.value || 'file'} (${importCsvFileRowCountHint.value ?? 'unknown'} rows).`,
          `CSV 已上传：${importCsvFileName.value || '文件'}（${importCsvFileRowCountHint.value ?? '未知'} 行）。`
        )
      )
    } else {
      const csvText = await file.text()
      importCsvFileId.value = ''
      importCsvFileRowCountHint.value = null
      importCsvFileExpiresAt.value = ''
      next.csvText = csvText
      delete next.csvFileId
      setStatus(tr(`CSV loaded: ${importCsvFileName.value || 'file'}`, `CSV 已加载：${importCsvFileName.value || '文件'}`))
    }

    importForm.payload = JSON.stringify(next, null, 2)
  } catch (error) {
    setStatusFromError(error, tr('Failed to load CSV', '加载 CSV 失败'), 'import-preview')
  }
}

function isImportCommitTokenValid(): boolean {
  if (!importCommitToken.value) return false
  if (!importCommitTokenExpiresAt.value) return true
  const expiresAt = new Date(importCommitTokenExpiresAt.value).getTime()
  return Number.isFinite(expiresAt) && expiresAt - Date.now() > 60 * 1000
}

async function ensureImportCommitToken(options: { forceRefresh?: boolean } = {}): Promise<boolean> {
  if (options.forceRefresh) {
    importCommitToken.value = ''
    importCommitTokenExpiresAt.value = ''
  }
  if (isImportCommitTokenValid()) return true
  try {
    const response = await apiFetch('/api/attendance/import/prepare', { method: 'POST' })
    if (response.status === 404) {
      // Legacy backend: commit token endpoints not available.
      importCommitToken.value = ''
      importCommitTokenExpiresAt.value = ''
      return true
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to prepare import token', '准备导入令牌失败')))
    }
    importCommitToken.value = data.data?.commitToken ?? ''
    importCommitTokenExpiresAt.value = data.data?.expiresAt ?? ''
    return Boolean(importCommitToken.value)
  } catch (error) {
    setStatus(readErrorMessage(error, tr('Failed to prepare import token', '准备导入令牌失败')), 'error')
    return false
  }
}

let importPreviewTaskSeq = 0

function clearImportPreviewTask() {
  importPreviewTaskSeq += 1
  importPreviewTask.value = null
}

async function runChunkedImportPreview(payload: Record<string, any>, plan: ImportPreviewChunkPlan): Promise<void> {
  const seq = ++importPreviewTaskSeq
  importPreviewTask.value = {
    mode: 'chunked',
    status: 'running',
    totalRows: plan.totalRows,
    processedRows: 0,
    totalChunks: plan.chunkCount,
    completedChunks: 0,
    message: null,
  }

  const aggregatedItems: AttendanceImportPreviewItem[] = []
  let totalRowCount = 0
  let invalidCount = 0
  let duplicateCount = 0
  const warningSet = new Set<string>()

  for (let chunkIndex = 0; chunkIndex < plan.chunkCount; chunkIndex += 1) {
    if (seq !== importPreviewTaskSeq) {
      throw new Error(tr('Preview task canceled', '预览任务已取消'))
    }

    const remainingSample = Math.max(1, plan.sampleLimit - aggregatedItems.length)
    const chunkPayload = plan.buildPayload(chunkIndex, remainingSample)
    const tokenOk = await ensureImportCommitToken({ forceRefresh: true })
    if (!tokenOk) throw new Error(tr('Failed to prepare import token', '准备导入令牌失败'))
    if (importCommitToken.value) chunkPayload.commitToken = importCommitToken.value

    const response = await apiFetch('/api/attendance/import/preview', {
      method: 'POST',
      body: JSON.stringify(chunkPayload),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(readErrorMessage(data, tr(
        `Failed to preview chunk ${chunkIndex + 1}/${plan.chunkCount}`,
        `预览分片 ${chunkIndex + 1}/${plan.chunkCount} 失败`
      )))
    }

    const chunkItems = Array.isArray(data.data?.items) ? data.data.items as AttendanceImportPreviewItem[] : []
    const rowCount = Number(data.data?.rowCount)
    const stats = data.data?.stats && typeof data.data.stats === 'object' ? data.data.stats : null
    const chunkWarnings = [
      ...(Array.isArray(data.data?.csvWarnings) ? data.data.csvWarnings : []),
      ...(Array.isArray(data.data?.groupWarnings) ? data.data.groupWarnings : []),
    ]

    totalRowCount += Number.isFinite(rowCount) ? rowCount : 0
    if (stats && Number.isFinite(Number((stats as any).invalid))) {
      invalidCount += Number((stats as any).invalid)
    }
    if (stats && Number.isFinite(Number((stats as any).duplicates))) {
      duplicateCount += Number((stats as any).duplicates)
    }

    for (const warning of chunkWarnings) {
      warningSet.add(String(warning))
    }

    if (aggregatedItems.length < plan.sampleLimit && chunkItems.length > 0) {
      const remains = plan.sampleLimit - aggregatedItems.length
      aggregatedItems.push(...chunkItems.slice(0, remains))
    }

    // Token is single-use and consumed by preview.
    importCommitToken.value = ''
    importCommitTokenExpiresAt.value = ''

    if (importPreviewTask.value && seq === importPreviewTaskSeq) {
      importPreviewTask.value = {
        ...importPreviewTask.value,
        processedRows: Math.min(plan.totalRows, (chunkIndex + 1) * importThresholds.previewChunkSize),
        completedChunks: chunkIndex + 1,
      }
    }
  }

  if (seq !== importPreviewTaskSeq) {
    throw new Error(tr('Preview task canceled', '预览任务已取消'))
  }

  importPreview.value = aggregatedItems
  importCsvWarnings.value = Array.from(warningSet)
  const shown = aggregatedItems.length
  const message = tr(
    `Preview loaded (chunked ${plan.chunkCount} chunks, showing ${shown}/${totalRowCount} rows).`,
    `预览已加载（分片 ${plan.chunkCount} 个，显示 ${shown}/${totalRowCount} 行）。`
  )
  const suffix = invalidCount || duplicateCount
    ? tr(` Invalid: ${invalidCount}. Duplicates: ${duplicateCount}.`, ` 无效：${invalidCount}。重复：${duplicateCount}。`)
    : ''
  setStatus(appendStatusContext(`${message}${suffix}`, importPreviewTimezoneHint.value))

  importPreviewTask.value = {
    mode: 'chunked',
    status: 'completed',
    totalRows: plan.totalRows,
    processedRows: plan.totalRows,
    totalChunks: plan.chunkCount,
    completedChunks: plan.chunkCount,
    message: tr(`Completed in ${plan.chunkCount} chunk(s).`, `已完成，共 ${plan.chunkCount} 个分片。`),
  }
}

async function runPreviewImportAsync(payload: Record<string, any>, rowCountHint: number): Promise<boolean> {
  importPreviewTask.value = {
    mode: 'single',
    status: 'running',
    totalRows: rowCountHint,
    processedRows: 0,
    totalChunks: 1,
    completedChunks: 0,
    message: tr('Queued async preview job.', '已排队异步预览任务。'),
  }

  const tokenOk = await ensureImportCommitToken({ forceRefresh: true })
  if (!tokenOk) return true
  if (importCommitToken.value) payload.commitToken = importCommitToken.value

  let asyncResponse = await apiFetch('/api/attendance/import/preview-async', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  let asyncData = await asyncResponse.json().catch(() => ({}))
  if (!asyncResponse.ok || !asyncData?.ok) {
    const errorCode = asyncData?.error?.code
    if (asyncResponse.status === 404 || errorCode === 'NOT_FOUND') {
      return false
    }
    if (errorCode === 'COMMIT_TOKEN_INVALID' || errorCode === 'COMMIT_TOKEN_REQUIRED') {
      importCommitToken.value = ''
      importCommitTokenExpiresAt.value = ''
      const refreshed = await ensureImportCommitToken({ forceRefresh: true })
      if (!refreshed || !importCommitToken.value) {
        throw new Error(tr('Failed to refresh import commit token. Check server deployment/migrations.', '刷新导入提交令牌失败，请检查服务端部署或迁移。'))
      }
      payload.commitToken = importCommitToken.value
      asyncResponse = await apiFetch('/api/attendance/import/preview-async', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      asyncData = await asyncResponse.json().catch(() => ({}))
    }
  }

  if (!asyncResponse.ok || !asyncData?.ok) {
    throw createApiError(asyncResponse, asyncData, tr('Failed to queue async preview', '排队异步预览失败'))
  }

  const job = asyncData.data?.job as AttendanceImportJob | undefined
  if (!job?.id) {
    throw new Error(tr('Async preview did not return job id', '异步预览未返回任务 ID'))
  }

  adminForbidden.value = false
  importAsyncJob.value = job
  setStatus(appendStatusContext(
    tr(`Preview job queued (${job.status}).`, `预览任务已排队（${job.status}）。`),
    importPreviewTimezoneHint.value,
  ))

  const finalJob = await pollImportJob(job.id)
  const previewData = finalJob.preview && typeof finalJob.preview === 'object' ? finalJob.preview : null
  if (!previewData) {
    throw new Error(tr('Async preview completed without preview payload', '异步预览完成但缺少预览载荷'))
  }

  const items = Array.isArray(previewData.items) ? previewData.items as AttendanceImportPreviewItem[] : []
  importPreview.value = items
  const previewWarnings = [
    ...(Array.isArray(previewData.csvWarnings) ? previewData.csvWarnings : []),
    ...(Array.isArray(previewData.groupWarnings) ? previewData.groupWarnings : []),
  ]
  importCsvWarnings.value = Array.from(new Set(previewWarnings))

  const shown = items.length
  const rowCount = Number(previewData.rowCount)
  const truncated = Boolean(previewData.truncated)
  const stats = previewData.stats && typeof previewData.stats === 'object' ? previewData.stats : null
  const invalidCount = stats && Number.isFinite(Number((stats as any).invalid)) ? Number((stats as any).invalid) : 0
  const dupCount = stats && Number.isFinite(Number((stats as any).duplicates)) ? Number((stats as any).duplicates) : 0
  const baseMsg = truncated && Number.isFinite(rowCount)
    ? tr(`Preview loaded (async, showing ${shown}/${rowCount} rows).`, `预览已加载（异步，显示 ${shown}/${rowCount} 行）。`)
    : tr(`Preview loaded (async ${shown} rows).`, `预览已加载（异步 ${shown} 行）。`)
  const suffix = invalidCount || dupCount
    ? tr(` Invalid: ${invalidCount}. Duplicates: ${dupCount}.`, ` 无效：${invalidCount}。重复：${dupCount}。`)
    : ''
  setStatus(appendStatusContext(`${baseMsg}${suffix}`, importPreviewTimezoneHint.value))

  importPreviewTask.value = {
    mode: 'single',
    status: 'completed',
    totalRows: Number.isFinite(rowCount) ? rowCount : shown,
    processedRows: Number.isFinite(rowCount) ? rowCount : shown,
    totalChunks: 1,
    completedChunks: 1,
    message: tr(`Completed via async preview job (${job.id.slice(0, 8)}...).`, `异步预览任务已完成（${job.id.slice(0, 8)}...）。`),
  }

  importCommitToken.value = ''
  importCommitTokenExpiresAt.value = ''
  return true
}

async function previewImport() {
  clearImportPreviewTask()
  clearImportAsyncJob()
  const payload = buildImportPayload()
  if (!payload) {
    setStatus(appendStatusContext(
      tr('Invalid JSON payload for import.', '导入载荷 JSON 无效。'),
      importPreviewTimezoneHint.value,
    ), 'error', {
      hint: tr('Fix JSON syntax in payload and retry preview.', '请修复载荷 JSON 语法后重试预览。'),
      action: 'retry-preview-import',
    })
    return
  }
  applyImportScalabilityHints(payload, { mode: 'preview' })
  importLoading.value = true
  try {
    const rowCountHint = estimateImportRowCount(payload)
    if (rowCountHint && rowCountHint >= importThresholds.previewAsyncThreshold) {
      const handledByAsync = await runPreviewImportAsync(payload, rowCountHint)
      if (handledByAsync) return
    }

    const chunkPlan = buildChunkedImportPreviewPlan(payload)
    if (chunkPlan) {
      await runChunkedImportPreview(payload, chunkPlan)
      return
    }

    importPreviewTask.value = {
      mode: 'single',
      status: 'running',
      totalRows: estimateImportRowCount(payload) ?? 0,
      processedRows: 0,
      totalChunks: 1,
      completedChunks: 0,
      message: null,
    }

    const tokenOk = await ensureImportCommitToken({ forceRefresh: true })
    if (!tokenOk) {
      if (importPreviewTask.value) {
        importPreviewTask.value = {
          ...importPreviewTask.value,
          status: 'failed',
          message: tr('Failed to prepare import token', '准备导入令牌失败'),
        }
      }
      return
    }
    if (importCommitToken.value) payload.commitToken = importCommitToken.value
    const response = await apiFetch('/api/attendance/import/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw createApiError(response, data, tr('Failed to preview import', '预览导入失败'))
    }
    importPreview.value = data.data?.items ?? []
    const rowCount = Number(data.data?.rowCount)
    const truncated = Boolean(data.data?.truncated)
    const stats = data.data?.stats && typeof data.data.stats === 'object' ? data.data.stats : null
    const previewWarnings = [
      ...(Array.isArray(data.data?.csvWarnings) ? data.data.csvWarnings : []),
      ...(Array.isArray(data.data?.groupWarnings) ? data.data.groupWarnings : []),
    ]
    importCsvWarnings.value = Array.from(new Set(previewWarnings))
    const shown = importPreview.value.length
    const invalidCount = stats && Number.isFinite(Number((stats as any).invalid)) ? Number((stats as any).invalid) : 0
    const dupCount = stats && Number.isFinite(Number((stats as any).duplicates)) ? Number((stats as any).duplicates) : 0
    const baseMsg = truncated && Number.isFinite(rowCount)
      ? tr(`Preview loaded (showing ${shown}/${rowCount} rows).`, `预览已加载（显示 ${shown}/${rowCount} 行）。`)
      : tr(`Preview loaded (${shown} rows).`, `预览已加载（${shown} 行）。`)
    const suffix = invalidCount || dupCount
      ? tr(` Invalid: ${invalidCount}. Duplicates: ${dupCount}.`, ` 无效：${invalidCount}。重复：${dupCount}。`)
      : ''
    setStatus(appendStatusContext(`${baseMsg}${suffix}`, importPreviewTimezoneHint.value))
    importPreviewTask.value = {
      mode: 'single',
      status: 'completed',
      totalRows: Number.isFinite(rowCount) ? rowCount : shown,
      processedRows: Number.isFinite(rowCount) ? rowCount : shown,
      totalChunks: 1,
      completedChunks: 1,
      message: null,
    }
    // Token is single-use (consumed by preview); clear it to avoid reusing a stale token.
    importCommitToken.value = ''
    importCommitTokenExpiresAt.value = ''
  } catch (error) {
    if (importPreviewTask.value) {
      importPreviewTask.value = {
        ...importPreviewTask.value,
        status: 'failed',
        message: readErrorMessage(error, tr('Preview failed', '预览失败')),
      }
    }
    setStatusFromErrorWithContext(
      error,
      tr('Failed to preview import', '预览导入失败'),
      importPreviewTimezoneHint.value,
      'import-preview',
    )
  } finally {
    importLoading.value = false
  }
}

let importJobPollSeq = 0

async function fetchImportJob(jobId: string): Promise<AttendanceImportJob> {
  const response = await apiFetch(`/api/attendance/import/jobs/${encodeURIComponent(jobId)}`)
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.ok) {
    throw createApiError(response, data, tr('Failed to load import job', '加载导入任务失败'))
  }
  return (data.data ?? data) as AttendanceImportJob
}

function createImportJobStateError(code: string, message: string): AttendanceApiError {
  const error = new Error(message) as AttendanceApiError
  error.code = code
  return error
}

async function pollImportJob(jobId: string): Promise<AttendanceImportJob> {
  const seq = ++importJobPollSeq
  importAsyncPolling.value = true
  const startedAt = Date.now()
  try {
    while (seq === importJobPollSeq) {
      if (importDebugTimeoutPending) {
        importDebugTimeoutPending = false
        throw createImportJobStateError('IMPORT_JOB_TIMEOUT', tr('Import job timed out', '导入任务超时'))
      }
      const job = await fetchImportJob(jobId)
      importAsyncJob.value = job
      if (job.status === 'completed') return job
      if (job.status === 'failed') {
        throw createImportJobStateError('IMPORT_JOB_FAILED', job.error || tr('Import job failed', '导入任务失败'))
      }
      if (job.status === 'canceled') {
        throw createImportJobStateError('IMPORT_JOB_CANCELED', tr('Import job canceled', '导入任务已取消'))
      }
      if (Date.now() - startedAt > importAsyncPollTimeoutMs) {
        throw createImportJobStateError('IMPORT_JOB_TIMEOUT', tr('Import job timed out', '导入任务超时'))
      }
      await sleep(importAsyncPollIntervalMs)
    }
    throw createImportJobStateError('IMPORT_JOB_CANCELED', tr('Import job polling canceled', '导入任务轮询已取消'))
  } finally {
    if (seq === importJobPollSeq) importAsyncPolling.value = false
  }
}

async function refreshImportAsyncJob(options: { silent?: boolean } = {}) {
  const jobId = String(importAsyncJob.value?.id || '').trim()
  if (!jobId) {
    if (!options.silent) setStatus(tr('No async import job selected.', '未选择异步导入任务。'), 'error')
    return
  }
  try {
    const job = await fetchImportJob(jobId)
    importAsyncJob.value = job
    if (!options.silent) {
      setStatus(appendStatusContext(
        tr(`Import job ${jobId.slice(0, 8)} reloaded (${job.status}).`, `导入任务 ${jobId.slice(0, 8)} 已重载（${job.status}）。`),
        importPreviewTimezoneHint.value,
      ))
    }
  } catch (error) {
    if (!options.silent) {
      setStatusFromError(error, tr('Failed to reload import job', '重载导入任务失败'), 'import-run')
    }
  }
}

async function resumeImportAsyncJobPolling() {
  const jobId = String(importAsyncJob.value?.id || '').trim()
  if (!jobId) {
    setStatus(tr('No async import job selected.', '未选择异步导入任务。'), 'error')
    return
  }
  try {
    const finalJob = await pollImportJob(jobId)
    if (finalJob.kind === 'preview') {
      const previewData = finalJob.preview && typeof finalJob.preview === 'object' ? finalJob.preview : null
      if (previewData) {
        importPreview.value = Array.isArray(previewData.items) ? previewData.items as AttendanceImportPreviewItem[] : []
      }
      setStatus(appendStatusContext(
        tr(`Preview job completed (${jobId.slice(0, 8)}).`, `预览任务完成（${jobId.slice(0, 8)}）。`),
        importPreviewTimezoneHint.value,
      ))
      return
    }
    const imported = Number(finalJob.progress ?? 0)
    const total = Number(finalJob.total ?? 0)
    if (total && imported !== total) {
      setStatus(appendStatusContext(
        tr(`Imported ${imported}/${total} rows (async job).`, `已导入 ${imported}/${total} 行（异步任务）。`),
        importPreviewTimezoneHint.value,
      ))
    } else {
      setStatus(appendStatusContext(
        tr(`Imported ${imported} rows (async job).`, `已导入 ${imported} 行（异步任务）。`),
        importPreviewTimezoneHint.value,
      ))
    }
    await loadRecords()
    await loadImportBatches()
  } catch (error) {
    setStatusFromErrorWithContext(
      error,
      tr('Failed while polling import job', '轮询导入任务失败'),
      importPreviewTimezoneHint.value,
      'import-run',
    )
  }
}

function clearImportAsyncJob() {
  // Cancel any in-flight polling loop.
  importJobPollSeq += 1
  importAsyncPolling.value = false
  importAsyncJob.value = null
}

async function runImport() {
  clearImportPreviewTask()
  const payload = buildImportPayload()
  if (!payload) {
    setStatus(appendStatusContext(
      tr('Invalid JSON payload for import.', '导入载荷 JSON 无效。'),
      importPreviewTimezoneHint.value,
    ), 'error', {
      hint: tr('Fix JSON syntax in payload and retry import.', '请修复载荷 JSON 语法后重试导入。'),
      action: 'retry-run-import',
    })
    return
  }
  applyImportScalabilityHints(payload, { mode: 'commit' })
  importLoading.value = true
  try {
    const tokenOk = await ensureImportCommitToken({ forceRefresh: true })
    if (!tokenOk) return
    if (importCommitToken.value) payload.commitToken = importCommitToken.value

    // Prefer async commit for very large imports to avoid long-running HTTP requests.
    // Falls back to sync commit when the backend does not support async jobs.
    importAsyncJob.value = null
    const rowCountHint = estimateImportRowCount(payload)
    if (rowCountHint && rowCountHint >= importThresholds.commitAsyncThreshold) {
      let asyncResponse = await apiFetch('/api/attendance/import/commit-async', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      let asyncData = await asyncResponse.json().catch(() => ({}))
      if (!asyncResponse.ok || !asyncData.ok) {
        const errorCode = asyncData?.error?.code
        if (asyncResponse.status === 404 || errorCode === 'NOT_FOUND') {
          asyncResponse = null as any
        } else if (errorCode === 'COMMIT_TOKEN_INVALID' || errorCode === 'COMMIT_TOKEN_REQUIRED') {
          importCommitToken.value = ''
          importCommitTokenExpiresAt.value = ''
          const refreshed = await ensureImportCommitToken({ forceRefresh: true })
          if (!refreshed || !importCommitToken.value) {
            throw new Error(tr('Failed to refresh import commit token. Check server deployment/migrations.', '刷新导入提交令牌失败，请检查服务端部署或迁移。'))
          }
          payload.commitToken = importCommitToken.value
          asyncResponse = await apiFetch('/api/attendance/import/commit-async', {
            method: 'POST',
            body: JSON.stringify(payload),
          })
          asyncData = await asyncResponse.json().catch(() => ({}))
        }
      }

      if (asyncResponse && asyncResponse.ok && asyncData?.ok) {
        const job = asyncData.data?.job as AttendanceImportJob | undefined
        if (!job?.id) {
          throw new Error(tr('Async import did not return job id', '异步导入未返回任务 ID'))
        }
        adminForbidden.value = false
        importAsyncJob.value = job
        setStatus(appendStatusContext(
          tr(`Import job queued (${job.status}).`, `导入任务已排队（${job.status}）。`),
          importPreviewTimezoneHint.value,
        ))

        const finalJob = await pollImportJob(job.id)
        const imported = Number(finalJob.progress ?? 0)
        const total = Number(finalJob.total ?? 0)
        setStatus(appendStatusContext(
          tr(`Imported ${imported} rows (async job).`, `已导入 ${imported} 行（异步任务）。`),
          importPreviewTimezoneHint.value,
        ))
        if (total && imported !== total) {
          setStatus(appendStatusContext(
            tr(`Imported ${imported}/${total} rows (async job).`, `已导入 ${imported}/${total} 行（异步任务）。`),
            importPreviewTimezoneHint.value,
          ))
        }

        await loadRecords()
        await loadImportBatches()
        importCommitToken.value = ''
        importCommitTokenExpiresAt.value = ''
        return
      }
    }
    const runLegacyImport = async () => {
      const legacyResponse = await apiFetch('/api/attendance/import', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const legacyData = await legacyResponse.json().catch(() => ({}))
      return { response: legacyResponse, data: legacyData }
    }

    let response = await apiFetch('/api/attendance/import/commit', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    let data = await response.json().catch(() => ({}))
    if (!response.ok || !data.ok) {
      const errorCode = data?.error?.code
      if (response.status === 404 || errorCode === 'NOT_FOUND') {
        const legacy = await runLegacyImport()
        response = legacy.response
        data = legacy.data
      } else if (errorCode === 'COMMIT_TOKEN_INVALID' || errorCode === 'COMMIT_TOKEN_REQUIRED') {
        importCommitToken.value = ''
        importCommitTokenExpiresAt.value = ''
        const refreshed = await ensureImportCommitToken({ forceRefresh: true })
        if (!refreshed || !importCommitToken.value) {
          throw new Error(tr('Failed to refresh import commit token. Check server deployment/migrations.', '刷新导入提交令牌失败，请检查服务端部署或迁移。'))
        }
        payload.commitToken = importCommitToken.value
        response = await apiFetch('/api/attendance/import/commit', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        data = await response.json().catch(() => ({}))
      }
    }
    if (!response.ok || !data.ok) {
      throw createApiError(response, data, tr('Failed to import attendance', '导入考勤失败'))
    }
    adminForbidden.value = false
    const importWarnings = [
      ...(Array.isArray(data.data?.csvWarnings) ? data.data.csvWarnings : []),
      ...(Array.isArray(data.data?.groupWarnings) ? data.data.groupWarnings : []),
    ]
    importCsvWarnings.value = Array.from(new Set(importWarnings))
    const count = data.data?.imported ?? 0
    const groupCreated = data.data?.meta?.groupCreated ?? 0
    const groupMembersAdded = data.data?.meta?.groupMembersAdded ?? 0
    if (groupCreated || groupMembersAdded) {
      setStatus(appendStatusContext(
        tr(`Imported ${count} rows. Groups created: ${groupCreated}. Members added: ${groupMembersAdded}.`, `已导入 ${count} 行。新建分组：${groupCreated}。新增成员：${groupMembersAdded}。`),
        importPreviewTimezoneHint.value,
      ))
    } else {
      setStatus(appendStatusContext(
        tr(`Imported ${count} rows.`, `已导入 ${count} 行。`),
        importPreviewTimezoneHint.value,
      ))
    }
    await loadRecords()
    await loadImportBatches()
    importCommitToken.value = ''
    importCommitTokenExpiresAt.value = ''
  } catch (error) {
    setStatusFromErrorWithContext(
      error,
      tr('Failed to import attendance', '导入考勤失败'),
      importPreviewTimezoneHint.value,
      'import-run',
    )
  } finally {
    importLoading.value = false
  }
}

function resolveImportBatchEngine(batch: AttendanceImportBatch): string {
  const engine = typeof batch?.meta?.engine === 'string' ? batch.meta.engine.trim().toLowerCase() : ''
  if (engine === 'bulk' || engine === 'standard') return engine
  return '--'
}

function resolveImportBatchChunkLabel(batch: AttendanceImportBatch): string {
  const chunk = batch?.meta?.chunkConfig && typeof batch.meta.chunkConfig === 'object'
    ? batch.meta.chunkConfig as Record<string, unknown>
    : null
  const items = Number(chunk?.itemsChunkSize)
  const records = Number(chunk?.recordsChunkSize)
  if (!Number.isFinite(items) || !Number.isFinite(records)) return '--'
  return `${Math.max(0, Math.floor(items))}/${Math.max(0, Math.floor(records))}`
}

async function loadImportBatches() {
  importLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetch(`/api/attendance/import/batches?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load import batches', '加载导入批次失败')))
    }
    importBatches.value = data.data?.items ?? []
  } catch (error: any) {
    setStatus(appendStatusContext(
      readErrorMessage(error, tr('Failed to load import batches', '加载导入批次失败')),
      importPreviewTimezoneHint.value,
    ), 'error')
  } finally {
    importLoading.value = false
  }
}

async function loadImportBatchItems(batchId: string) {
  if (!batchId) return
  importLoading.value = true
  try {
    const response = await apiFetch(`/api/attendance/import/batches/${batchId}/items`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load import batch items', '加载导入批次明细失败')))
    }
    importBatchSelectedId.value = batchId
    importBatchItems.value = data.data?.items ?? []
    importBatchSnapshot.value = null
    setStatus(appendStatusContext(
      tr(`Batch items loaded (${importBatchItems.value.length} rows).`, `批次条目已加载（${importBatchItems.value.length} 行）。`),
      importPreviewTimezoneHint.value,
    ))
  } catch (error: any) {
    setStatus(appendStatusContext(
      readErrorMessage(error, tr('Failed to load import batch items', '加载导入批次明细失败')),
      importPreviewTimezoneHint.value,
    ), 'error')
  } finally {
    importLoading.value = false
  }
}

function toggleImportBatchSnapshot(item: AttendanceImportItem) {
  if (!item.previewSnapshot) {
    importBatchSnapshot.value = null
    return
  }
  if (importBatchSnapshot.value?.snapshot === item.previewSnapshot) {
    importBatchSnapshot.value = null
  } else {
    importBatchSnapshot.value = {
      snapshot: item.previewSnapshot,
      context: {
        userId: item.userId ?? null,
        workDate: item.workDate ?? null,
        recordId: item.recordId ?? null,
      },
    }
  }
}

async function rollbackImportBatch(batchId: string) {
  if (!batchId || !window.confirm(tr('Rollback this import batch?', '确认回滚该导入批次吗？'))) return
  importLoading.value = true
  try {
    const response = await apiFetch(`/api/attendance/import/rollback/${batchId}`, { method: 'POST' })
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to rollback import batch', '回滚导入批次失败')))
    }
    await loadImportBatches()
    if (importBatchSelectedId.value === batchId) {
      importBatchItems.value = []
      importBatchSnapshot.value = null
      importBatchSelectedId.value = ''
    }
    setStatus(appendStatusContext(
      tr('Import batch rolled back.', '导入批次已回滚。'),
      importPreviewTimezoneHint.value,
    ))
  } catch (error: any) {
    setStatus(appendStatusContext(
      readErrorMessage(error, tr('Failed to rollback import batch', '回滚导入批次失败')),
      importPreviewTimezoneHint.value,
    ), 'error')
  } finally {
    importLoading.value = false
  }
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
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

function extractImportSnapshotMetrics(snapshot?: Record<string, any> | null): Record<string, any> {
  if (!snapshot || typeof snapshot !== 'object') return {}
  const metrics = (snapshot as any).metrics
  if (metrics && typeof metrics === 'object' && !Array.isArray(metrics)) return metrics
  return {}
}

function extractImportSnapshotWarnings(snapshot?: Record<string, any> | null): string[] {
  if (!snapshot || typeof snapshot !== 'object') return []
  const warnings: string[] = []
  const direct = (snapshot as any).warnings
  if (Array.isArray(direct)) warnings.push(...direct.map((w) => String(w)))
  const metrics = extractImportSnapshotMetrics(snapshot)
  const metricWarnings = (metrics as any).warnings
  if (Array.isArray(metricWarnings)) warnings.push(...metricWarnings.map((w: any) => String(w)))
  const policyWarnings = (snapshot as any).policy?.warnings
  if (Array.isArray(policyWarnings)) warnings.push(...policyWarnings.map((w: any) => String(w)))
  const engineWarnings = (snapshot as any).engine?.warnings
  if (Array.isArray(engineWarnings)) warnings.push(...engineWarnings.map((w: any) => String(w)))
  return Array.from(new Set(warnings))
}

async function fetchAllImportBatchItems(batchId: string): Promise<AttendanceImportItem[]> {
  const pageSize = 200
  let page = 1
  let total: number | null = null
  const items: AttendanceImportItem[] = []

  while (total === null || items.length < total) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    })
    const response = await apiFetch(`/api/attendance/import/batches/${batchId}/items?${params.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load import items', '加载导入条目失败')))
    }
    const pageItems = Array.isArray(data.data?.items) ? data.data.items : []
    items.push(...pageItems)
    const nextTotal = Number(data.data?.total)
    if (Number.isFinite(nextTotal)) total = nextTotal
    if (pageItems.length === 0) break
    page += 1
    if (page > 500) break
  }

  return items
}

async function exportImportBatchItemsCsv(onlyAnomalies: boolean) {
  const batchId = importBatchSelectedId.value
  if (!batchId) {
    setStatus(appendStatusContext(
      tr('Select a batch first.', '请先选择批次。'),
      importPreviewTimezoneHint.value,
    ), 'error')
    return
  }
  importLoading.value = true

  try {
    // Prefer server-side exports when available (works for large batches and includes skipped rows).
    const exportType = onlyAnomalies ? 'anomalies' : 'all'
    const serverResponse = await apiFetch(`/api/attendance/import/batches/${batchId}/export.csv?type=${exportType}`, {
      method: 'GET',
      headers: {
        Accept: 'text/csv',
      },
    })
    if (serverResponse.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    if (serverResponse.ok) {
      const csvText = await serverResponse.text()
      const stamp = new Date().toISOString().slice(0, 10)
      const filename = `attendance-import-${batchId.slice(0, 8)}-${exportType}-${stamp}.csv`
      downloadCsvText(filename, csvText)
      setStatus(appendStatusContext(
        tr('CSV exported.', 'CSV 已导出。'),
        importPreviewTimezoneHint.value,
      ))
      return
    }

    // Backward-compatible fallback for older deployments without the export endpoint.
    if (serverResponse.status !== 404) {
      const errorText = await serverResponse.text().catch(() => '')
      throw new Error(errorText || tr(`Failed to export CSV (HTTP ${serverResponse.status})`, `导出 CSV 失败（HTTP ${serverResponse.status}）`))
    }

    const allItems = await fetchAllImportBatchItems(batchId)
    if (allItems.length === 0) {
      setStatus(appendStatusContext(
        tr('No batch items found.', '未找到批次明细。'),
        importPreviewTimezoneHint.value,
      ), 'error')
      return
    }
    allItems.sort((a, b) => {
      const dateCmp = String(a.workDate ?? '').localeCompare(String(b.workDate ?? ''))
      if (dateCmp !== 0) return dateCmp
      return String(a.userId ?? '').localeCompare(String(b.userId ?? ''))
    })

    const headers = [
      'batchId',
      'itemId',
      'workDate',
      'userId',
      'recordId',
      'status',
      'workMinutes',
      'lateMinutes',
      'earlyLeaveMinutes',
      'leaveMinutes',
      'overtimeMinutes',
      'warnings',
    ]

    const rows = allItems.map((item) => {
      const snapshot = item.previewSnapshot
      const metrics = extractImportSnapshotMetrics(snapshot)
      const warnings = extractImportSnapshotWarnings(snapshot)

      const status = String((metrics as any).status ?? '')
      const workMinutes = Number((metrics as any).workMinutes ?? 0)
      const lateMinutes = Number((metrics as any).lateMinutes ?? 0)
      const earlyLeaveMinutes = Number((metrics as any).earlyLeaveMinutes ?? 0)
      const leaveMinutes = Number((metrics as any).leaveMinutes ?? 0)
      const overtimeMinutes = Number((metrics as any).overtimeMinutes ?? 0)

      const isAnomaly = Boolean(
        warnings.length
        || (item.recordId ?? null) === null
        || (status && status !== 'normal')
        || lateMinutes > 0
        || earlyLeaveMinutes > 0
        || leaveMinutes > 0
        || overtimeMinutes > 0,
      )

      return {
        item,
        status,
        workMinutes,
        lateMinutes,
        earlyLeaveMinutes,
        leaveMinutes,
        overtimeMinutes,
        warnings,
        isAnomaly,
      }
    }).filter((row) => (onlyAnomalies ? row.isAnomaly : true))

    const lines: string[] = []
    lines.push(headers.map(csvEscape).join(','))
    rows.forEach(({ item, status, workMinutes, lateMinutes, earlyLeaveMinutes, leaveMinutes, overtimeMinutes, warnings }) => {
      const values = [
        batchId,
        item.id,
        item.workDate || '',
        item.userId || '',
        item.recordId || '',
        status,
        workMinutes,
        lateMinutes,
        earlyLeaveMinutes,
        leaveMinutes,
        overtimeMinutes,
        warnings.join('; '),
      ]
      lines.push(values.map(csvEscape).join(','))
    })

    const stamp = new Date().toISOString().slice(0, 10)
    const filename = `attendance-import-${batchId.slice(0, 8)}-${onlyAnomalies ? 'anomalies' : 'items'}-${stamp}.csv`
    downloadCsvText(filename, lines.join('\n'))
    setStatus(appendStatusContext(
      tr(`CSV exported (${rows.length}/${allItems.length}).`, `CSV 已导出（${rows.length}/${allItems.length}）。`),
      importPreviewTimezoneHint.value,
    ))
  } catch (error: any) {
    setStatus(appendStatusContext(
      readErrorMessage(error, tr('Failed to export CSV', '导出 CSV 失败')),
      importPreviewTimezoneHint.value,
    ), 'error')
  } finally {
    importLoading.value = false
  }
}

function defaultStatusActionForContext(context: AttendanceStatusContext): AttendanceStatusAction | undefined {
  if (context === 'refresh') return 'refresh-overview'
  if (context === 'admin') return 'reload-admin'
  if (context === 'save-settings') return 'retry-save-settings'
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

async function apiFetchWithTimeout(path: string, options: globalThis.RequestInit = {}, timeoutMs = ATTENDANCE_ADMIN_REQUEST_TIMEOUT_MS): Promise<Response> {
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
    [/^admin permissions required\b/i, '需要管理员权限'],
    [/^failed to load anomalies\b/i, '加载异常失败'],
    [/^failed to load requests\b/i, '加载申请失败'],
    [/^failed to load request report\b/i, '加载申请报表失败'],
    [/^failed to load admin data\b/i, '加载管理数据失败'],
    [/^failed to load leave types\b/i, '加载请假类型失败'],
    [/^failed to save leave type\b/i, '保存请假类型失败'],
    [/^failed to delete leave type\b/i, '删除请假类型失败'],
    [/^failed to load overtime rules\b/i, '加载加班规则失败'],
    [/^failed to save overtime rule\b/i, '保存加班规则失败'],
    [/^failed to delete overtime rule\b/i, '删除加班规则失败'],
    [/^code and name are required\b/i, '编码和名称为必填项'],
    [/^name is required\b/i, '名称为必填项'],
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
  } else if (status === 403 || code === 'FORBIDDEN' || code === 'PERMISSION_DENIED') {
    message = rawMessage === fallbackMessage ? tr('Permission denied for this action.', '当前操作无权限。') : rawMessage
    meta.hint = tr('Use an account with required attendance permissions, then reload data.', '请使用具备所需考勤权限的账号，并重新加载数据。')
    meta.action = context === 'request-submit' || context === 'request-resolve' || context === 'request-cancel'
      ? 'reload-requests'
      : 'reload-admin'
  } else if (status === 409 || code === 'DUPLICATE_REQUEST' || code === 'ALREADY_EXISTS') {
    message = context === 'request-submit'
      ? tr('A request for the same date and type already exists.', '同一天同类型的申请已存在。')
      : rawMessage
    meta.hint = tr('Refresh the request list and continue from the existing item.', '请刷新申请列表，并基于已有申请继续处理。')
    meta.action = context === 'request-submit' ? 'reload-requests' : defaultAction
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
  setStatus(message || fallbackMessage, 'error', meta)
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
  const normalizedMessage = kind === 'error'
    ? localizeRuntimeErrorMessage(message, message)
    : message
  statusKind.value = kind
  statusMeta.value = kind === 'error' ? meta : null
  if (statusMessage.value === normalizedMessage && normalizedMessage) {
    statusMessage.value = ''
    void nextTick(() => {
      statusMessage.value = normalizedMessage
    })
  } else {
    statusMessage.value = normalizedMessage
  }
  if (!normalizedMessage) return
  const timeoutMs = kind === 'error'
    ? (meta?.action || meta?.hint ? 10000 : 7000)
    : 4000
  window.setTimeout(() => {
    if (statusMessage.value === normalizedMessage) {
      statusMessage.value = ''
      if (statusMeta.value === meta) {
        statusMeta.value = null
      }
    }
  }, timeoutMs)
}

function setProvisionStatus(message: string, kind: 'info' | 'error' = 'info') {
  provisionStatusKind.value = kind
  provisionStatusMessage.value = message
  if (!message) return
  window.setTimeout(() => {
    if (provisionStatusMessage.value === message) {
      provisionStatusMessage.value = ''
    }
  }, 6000)
}

function setProvisionBatchStatus(message: string, kind: 'info' | 'error' = 'info') {
  provisionBatchStatusKind.value = kind
  provisionBatchStatusMessage.value = message
  if (!message) return
  window.setTimeout(() => {
    if (provisionBatchStatusMessage.value === message) {
      provisionBatchStatusMessage.value = ''
    }
  }, 6000)
}

function setAuditLogStatus(message: string, kind: 'info' | 'error' = 'info') {
  auditLogStatusKind.value = kind
  auditLogStatusMessage.value = message
  if (!message) return
  window.setTimeout(() => {
    if (auditLogStatusMessage.value === message) {
      auditLogStatusMessage.value = ''
    }
  }, 6000)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())
}

function parseUserIdListText(raw: string): { valid: string[]; invalid: string[] } {
  const tokens = String(raw || '')
    .split(/[,\s;]+/g)
    .map((v) => v.trim())
    .filter(Boolean)

  const valid: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()

  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    if (isUuid(token)) {
      valid.push(token)
    } else {
      invalid.push(token)
    }
  }

  return { valid, invalid }
}

function applyProvisionBatchResolvePayload(payload: any, requestedUserIds: string[]) {
  const requested = Number(payload?.requested ?? requestedUserIds.length) || requestedUserIds.length
  const itemsRaw = Array.isArray(payload?.items) ? payload.items : []
  const items: AttendanceAdminBatchResolveItem[] = []
  const seen = new Set<string>()

  for (const raw of itemsRaw) {
    if (!raw || typeof raw !== 'object') continue
    const id = String((raw as any).id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    items.push({
      id,
      email: String((raw as any).email || ''),
      name: (raw as any).name === null || (raw as any).name === undefined ? null : String((raw as any).name),
      is_active: Boolean((raw as any).is_active),
    })
  }

  const fallbackMissing = requestedUserIds.filter((userId) => !seen.has(userId))
  const missingRaw: string[] = Array.isArray(payload?.missingUserIds)
    ? payload.missingUserIds.map((v: any) => String(v || '').trim())
    : fallbackMissing
  const missing = Array.from(new Set(missingRaw.filter((v) => v.length > 0)))

  const fallbackInactive = items.filter((item) => !item.is_active).map((item) => item.id)
  const inactiveRaw: string[] = Array.isArray(payload?.inactiveUserIds)
    ? payload.inactiveUserIds.map((v: any) => String(v || '').trim())
    : fallbackInactive
  const inactive = Array.from(new Set(inactiveRaw.filter((v) => v.length > 0)))

  const affectedRaw: string[] = Array.isArray(payload?.affectedUserIds)
    ? payload.affectedUserIds.map((v: any) => String(v || '').trim())
    : []
  const unchangedRaw: string[] = Array.isArray(payload?.unchangedUserIds)
    ? payload.unchangedUserIds.map((v: any) => String(v || '').trim())
    : []
  const affected = Array.from(new Set(affectedRaw.filter((v) => v.length > 0)))
  const unchanged = Array.from(new Set(unchangedRaw.filter((v) => v.length > 0)))

  provisionBatchPreviewRequested.value = requested
  provisionBatchPreviewItems.value = items
  provisionBatchPreviewMissingIds.value = missing
  provisionBatchPreviewInactiveIds.value = inactive
  provisionBatchAffectedIds.value = affected
  provisionBatchUnchangedIds.value = unchanged
}

function clearProvisionBatchPreview() {
  provisionBatchPreviewRequested.value = 0
  provisionBatchPreviewItems.value = []
  provisionBatchPreviewMissingIds.value = []
  provisionBatchPreviewInactiveIds.value = []
  provisionBatchAffectedIds.value = []
  provisionBatchUnchangedIds.value = []
}

function normalizeProvisionUserProfile(value: any, fallbackUserId: string): AttendanceAdminUserProfileSummary | null {
  if (!value || typeof value !== 'object') return null
  const id = String(value.id || value.userId || value.user_id || fallbackUserId || '')
  const email = String(value.email || '')
  const name = value.name === null || value.name === undefined ? null : String(value.name)
  if (!id || !email) return null
  return { id, email, name }
}

function applyProvisionAccessPayload(payload: any, fallbackUserId: string) {
  provisionPermissions.value = Array.isArray(payload?.permissions) ? payload.permissions : []
  provisionUserIsAdmin.value = Boolean(payload?.isAdmin)
  provisionRoles.value = Array.isArray(payload?.roles) ? payload.roles : []
  const profile = normalizeProvisionUserProfile(payload?.user, fallbackUserId)
  provisionUserProfile.value = profile
}

async function loadProvisionRoleTemplates() {
  try {
    const response = await apiFetch('/api/attendance-admin/role-templates')
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    if (response.status === 404) return
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) return
    const templates = Array.isArray(data.data?.templates) ? data.data.templates : []
    provisionRoleTemplates.value = templates
  } catch {
    // Non-blocking: UI can still use static template ids.
  }
}

async function searchProvisionUsers(page: number) {
  const q = provisionSearchQuery.value.trim()
  provisionSearchHasSearched.value = true
  if (!q) {
    provisionSearchResults.value = []
    provisionSearchTotal.value = 0
    provisionSearchPage.value = 1
    setProvisionStatus(tr('Enter a search query (email/name/id).', '请输入搜索关键词（邮箱/姓名/ID）。'), 'error')
    return
  }
  provisionSearchLoading.value = true
  try {
    const params = new URLSearchParams({
      q,
      page: String(page),
      pageSize: String(provisionSearchPageSize),
    })
    const response = await apiFetch(`/api/attendance-admin/users/search?${params.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to search users', '搜索用户失败')))
    }
    const items = Array.isArray(data.data?.items) ? data.data.items : []
    provisionSearchResults.value = items
    provisionSearchTotal.value = Number(data.data?.total ?? items.length) || 0
    provisionSearchPage.value = Number(data.data?.page ?? page) || page
  } catch (error: any) {
    setProvisionStatus(readErrorMessage(error, tr('Failed to search users', '搜索用户失败')), 'error')
  } finally {
    provisionSearchLoading.value = false
  }
}

function selectProvisionUser(user: AttendanceAdminUserSearchItem) {
  provisionForm.userId = user.id
  provisionUserProfile.value = { id: user.id, email: user.email, name: user.name }
  provisionHasLoaded.value = true
  void loadProvisioningUser()
}

async function fetchProvisioningUser(userId: string) {
  provisionRoles.value = []
  const response = await apiFetch(`/api/permissions/user/${encodeURIComponent(userId)}`)
  if (response.status === 403) {
    adminForbidden.value = true
    throw new Error(tr('Admin permissions required', '需要管理员权限'))
  }
  const data: PermissionUserResponse = await response.json()
  if (!response.ok) {
    throw new Error(readErrorMessage(data, tr('Failed to load permissions', '加载权限失败')))
  }
  provisionPermissions.value = Array.isArray(data.permissions) ? data.permissions : []
  provisionUserIsAdmin.value = Boolean(data.isAdmin)
}

async function fetchProvisioningUserAccess(userId: string) {
  const response = await apiFetch(`/api/attendance-admin/users/${encodeURIComponent(userId)}/access`)
  if (response.status === 404) {
    // Backward compatibility: old deployments only support /api/permissions/user/:id
    await fetchProvisioningUser(userId)
    return
  }
  if (response.status === 403) {
    adminForbidden.value = true
    throw new Error(tr('Admin permissions required', '需要管理员权限'))
  }
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.ok) {
    throw new Error(readErrorMessage(data, tr('Failed to load user access', '加载用户访问权限失败')))
  }
  applyProvisionAccessPayload(data.data, userId)
}

async function loadProvisioningUser() {
  const userId = provisionForm.userId.trim()
  provisionHasLoaded.value = true
  if (!isUuid(userId)) {
    setProvisionStatus(tr('Please enter a valid UUID for User ID.', '请输入有效的用户 ID（UUID）。'), 'error')
    return
  }
  provisionLoading.value = true
  try {
    await fetchProvisioningUserAccess(userId)
    setProvisionStatus(tr(`Loaded ${provisionPermissions.value.length} permission(s).`, `已加载 ${provisionPermissions.value.length} 项权限。`))
  } catch (error: any) {
    setProvisionStatus(readErrorMessage(error, tr('Failed to load permissions', '加载权限失败')), 'error')
  } finally {
    provisionLoading.value = false
  }
}

async function grantProvisioningRole() {
  const userId = provisionForm.userId.trim()
  provisionHasLoaded.value = true
  if (!isUuid(userId)) {
    setProvisionStatus(tr('Please enter a valid UUID for User ID.', '请输入有效的用户 ID（UUID）。'), 'error')
    return
  }
  provisionLoading.value = true
  try {
    const role = provisionForm.role
    // Prefer attendance-scoped role assignment (role templates) when available.
    const modern = await apiFetch(`/api/attendance-admin/users/${encodeURIComponent(userId)}/roles/assign`, {
      method: 'POST',
      body: JSON.stringify({ template: role }),
    })
    if (modern.status !== 404) {
      if (modern.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const modernData = await modern.json().catch(() => null)
      if (!modern.ok || !modernData?.ok) {
        throw new Error(readErrorMessage(modernData, tr('Failed to assign role', '分配角色失败')))
      }
      applyProvisionAccessPayload(modernData.data, userId)
      setProvisionStatus(tr(`Role '${role}' assigned.`, `角色 '${role}' 已分配。`))
      return
    }

    // Backward compatibility: old deployments grant permissions directly.
    const permissions = provisionRolePermissions[role] || []
    for (const permission of permissions) {
      const response = await apiFetch('/api/permissions/grant', {
        method: 'POST',
        body: JSON.stringify({ userId, permission }),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await response.json()
      if (!response.ok) {
        throw new Error(readErrorMessage(data, tr(`Failed to grant ${permission}`, `授予权限 ${permission} 失败`)))
      }
    }
    await fetchProvisioningUser(userId)
    setProvisionStatus(tr(`Role '${role}' granted.`, `角色 '${role}' 已授权。`))
  } catch (error: any) {
    setProvisionStatus(readErrorMessage(error, tr('Failed to grant role', '授权角色失败')), 'error')
  } finally {
    provisionLoading.value = false
  }
}

async function revokeProvisioningRole() {
  const userId = provisionForm.userId.trim()
  provisionHasLoaded.value = true
  if (!isUuid(userId)) {
    setProvisionStatus(tr('Please enter a valid UUID for User ID.', '请输入有效的用户 ID（UUID）。'), 'error')
    return
  }
  provisionLoading.value = true
  try {
    const role = provisionForm.role
    // Prefer attendance-scoped role unassignment when available.
    const modern = await apiFetch(`/api/attendance-admin/users/${encodeURIComponent(userId)}/roles/unassign`, {
      method: 'POST',
      body: JSON.stringify({ template: role }),
    })
    if (modern.status !== 404) {
      if (modern.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const modernData = await modern.json().catch(() => null)
      if (!modern.ok || !modernData?.ok) {
        throw new Error(readErrorMessage(modernData, tr('Failed to remove role', '移除角色失败')))
      }
      applyProvisionAccessPayload(modernData.data, userId)
      setProvisionStatus(tr(`Role '${role}' removed.`, `角色 '${role}' 已移除。`))
      return
    }

    // Backward compatibility: old deployments revoke permissions directly.
    const permissions = provisionRolePermissions[role] || []
    for (const permission of permissions) {
      const response = await apiFetch('/api/permissions/revoke', {
        method: 'POST',
        body: JSON.stringify({ userId, permission }),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await response.json()
      // 404 is fine for revokes (permission not present).
      if (!response.ok && response.status !== 404) {
        throw new Error(readErrorMessage(data, tr(`Failed to revoke ${permission}`, `撤销权限 ${permission} 失败`)))
      }
    }
    await fetchProvisioningUser(userId)
    setProvisionStatus(tr(`Role '${role}' revoked.`, `角色 '${role}' 已撤销。`))
  } catch (error: any) {
    setProvisionStatus(readErrorMessage(error, tr('Failed to revoke role', '撤销角色失败')), 'error')
  } finally {
    provisionLoading.value = false
  }
}

async function previewProvisionBatchUsers() {
  provisionBatchStatusMessage.value = ''
  const { valid, invalid } = parseUserIdListText(provisionBatchUserIdsText.value)
  if (invalid.length) {
    setProvisionBatchStatus(tr(`Invalid UUID(s): ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`, `无效 UUID：${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`), 'error')
    return
  }
  if (valid.length === 0) {
    setProvisionBatchStatus(tr('Please enter at least one valid User ID (UUID).', '请至少输入一个有效的用户 ID（UUID）。'), 'error')
    clearProvisionBatchPreview()
    return
  }

  provisionBatchPreviewLoading.value = true
  try {
    const response = await apiFetch('/api/attendance-admin/users/batch/resolve', {
      method: 'POST',
      body: JSON.stringify({ userIds: valid }),
    })

    if (response.status === 404) {
      // Backward compatibility: old deployments may not expose this endpoint.
      clearProvisionBatchPreview()
      provisionBatchPreviewRequested.value = valid.length
      setProvisionBatchStatus(tr('Batch preview API not available on this deployment.', '当前部署不支持批量预览 API。'), 'error')
      return
    }
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }

    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to preview batch users', '批量预览用户失败')))
    }

    applyProvisionBatchResolvePayload(data.data, valid)
    const found = provisionBatchPreviewItems.value.length
    const missing = provisionBatchPreviewMissingIds.value.length
    const inactive = provisionBatchPreviewInactiveIds.value.length
    const kind = missing > 0 ? 'error' : 'info'
    setProvisionBatchStatus(tr(`Preview ready: found ${found}/${valid.length}, missing ${missing}, inactive ${inactive}.`, `预览完成：找到 ${found}/${valid.length}，缺失 ${missing}，停用 ${inactive}。`), kind)
  } catch (error: any) {
    setProvisionBatchStatus(readErrorMessage(error, tr('Failed to preview batch users', '批量预览用户失败')), 'error')
  } finally {
    provisionBatchPreviewLoading.value = false
  }
}

async function grantProvisioningRoleBatch() {
  provisionBatchStatusMessage.value = ''
  const role = provisionBatchRole.value
  const { valid, invalid } = parseUserIdListText(provisionBatchUserIdsText.value)
  if (invalid.length) {
    setProvisionBatchStatus(tr(`Invalid UUID(s): ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`, `无效 UUID：${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`), 'error')
    return
  }
  if (valid.length === 0) {
    setProvisionBatchStatus(tr('Please enter at least one valid User ID (UUID).', '请至少输入一个有效的用户 ID（UUID）。'), 'error')
    return
  }

  provisionBatchLoading.value = true
  try {
    const batch = await apiFetch('/api/attendance-admin/users/batch/roles/assign', {
      method: 'POST',
      body: JSON.stringify({ userIds: valid, template: role }),
    })
    if (batch.status !== 404) {
      if (batch.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const batchData = await batch.json().catch(() => null)
      if (!batch.ok || !batchData?.ok) {
        throw new Error(readErrorMessage(batchData, tr('Failed to batch assign role', '批量分配角色失败')))
      }
      applyProvisionBatchResolvePayload(batchData.data, valid)
      const updated = Number(batchData.data?.updated ?? 0) || 0
      const eligible = Number(batchData.data?.eligible ?? (valid.length - provisionBatchPreviewMissingIds.value.length)) || 0
      const missing = provisionBatchPreviewMissingIds.value.length
      const inactive = provisionBatchPreviewInactiveIds.value.length
      const unchanged = provisionBatchUnchangedIds.value.length
      const kind = missing > 0 ? 'error' : 'info'
      setProvisionBatchStatus(tr(`Role '${role}' assigned to ${updated}/${eligible} eligible user(s). Unchanged ${unchanged}. Missing ${missing}, inactive ${inactive}.`, `角色 '${role}' 已分配给 ${updated}/${eligible} 个可处理用户。未变更 ${unchanged}。缺失 ${missing}，停用 ${inactive}。`), kind)
      return
    }

    // Backward compatibility: per-user role assign or direct permission grants.
    const failed: string[] = []
    let updated = 0
    for (const userId of valid) {
      try {
        const modern = await apiFetch(`/api/attendance-admin/users/${encodeURIComponent(userId)}/roles/assign`, {
          method: 'POST',
          body: JSON.stringify({ template: role }),
        })
        if (modern.status !== 404) {
          if (modern.status === 403) {
            adminForbidden.value = true
            throw new Error(tr('Admin permissions required', '需要管理员权限'))
          }
          const modernData = await modern.json().catch(() => null)
          if (!modern.ok || !modernData?.ok) {
            throw new Error(readErrorMessage(modernData, tr('Failed to assign role', '分配角色失败')))
          }
          updated += 1
          continue
        }

        const permissions = provisionRolePermissions[role] || []
        for (const permission of permissions) {
          const response = await apiFetch('/api/permissions/grant', {
            method: 'POST',
            body: JSON.stringify({ userId, permission }),
          })
          if (response.status === 403) {
            adminForbidden.value = true
            throw new Error(tr('Admin permissions required', '需要管理员权限'))
          }
          const data = await response.json().catch(() => null)
          if (!response.ok) {
            throw new Error(readErrorMessage(data, tr(`Failed to grant ${permission}`, `授予权限 ${permission} 失败`)))
          }
        }
        updated += 1
      } catch {
        failed.push(userId)
      }
    }

    const message = failed.length
      ? tr(`Role '${role}' assigned to ${updated}/${valid.length} user(s). Failed: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`, `角色 '${role}' 已分配给 ${updated}/${valid.length} 个用户。失败：${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`)
      : tr(`Role '${role}' assigned to ${updated}/${valid.length} user(s).`, `角色 '${role}' 已分配给 ${updated}/${valid.length} 个用户。`)
    setProvisionBatchStatus(message, failed.length ? 'error' : 'info')
  } catch (error: any) {
    setProvisionBatchStatus(readErrorMessage(error, tr('Failed to batch assign role', '批量分配角色失败')), 'error')
  } finally {
    provisionBatchLoading.value = false
  }
}

async function revokeProvisioningRoleBatch() {
  provisionBatchStatusMessage.value = ''
  const role = provisionBatchRole.value
  const { valid, invalid } = parseUserIdListText(provisionBatchUserIdsText.value)
  if (invalid.length) {
    setProvisionBatchStatus(tr(`Invalid UUID(s): ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`, `无效 UUID：${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`), 'error')
    return
  }
  if (valid.length === 0) {
    setProvisionBatchStatus(tr('Please enter at least one valid User ID (UUID).', '请至少输入一个有效的用户 ID（UUID）。'), 'error')
    return
  }

  provisionBatchLoading.value = true
  try {
    const batch = await apiFetch('/api/attendance-admin/users/batch/roles/unassign', {
      method: 'POST',
      body: JSON.stringify({ userIds: valid, template: role }),
    })
    if (batch.status !== 404) {
      if (batch.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const batchData = await batch.json().catch(() => null)
      if (!batch.ok || !batchData?.ok) {
        throw new Error(readErrorMessage(batchData, tr('Failed to batch remove role', '批量移除角色失败')))
      }
      applyProvisionBatchResolvePayload(batchData.data, valid)
      const updated = Number(batchData.data?.updated ?? 0) || 0
      const eligible = Number(batchData.data?.eligible ?? (valid.length - provisionBatchPreviewMissingIds.value.length)) || 0
      const missing = provisionBatchPreviewMissingIds.value.length
      const inactive = provisionBatchPreviewInactiveIds.value.length
      const unchanged = provisionBatchUnchangedIds.value.length
      const kind = missing > 0 ? 'error' : 'info'
      setProvisionBatchStatus(tr(`Role '${role}' removed from ${updated}/${eligible} eligible user(s). Unchanged ${unchanged}. Missing ${missing}, inactive ${inactive}.`, `角色 '${role}' 已从 ${updated}/${eligible} 个可处理用户移除。未变更 ${unchanged}。缺失 ${missing}，停用 ${inactive}。`), kind)
      return
    }

    // Backward compatibility: per-user role unassign or direct permission revokes.
    const failed: string[] = []
    let updated = 0
    for (const userId of valid) {
      try {
        const modern = await apiFetch(`/api/attendance-admin/users/${encodeURIComponent(userId)}/roles/unassign`, {
          method: 'POST',
          body: JSON.stringify({ template: role }),
        })
        if (modern.status !== 404) {
          if (modern.status === 403) {
            adminForbidden.value = true
            throw new Error(tr('Admin permissions required', '需要管理员权限'))
          }
          const modernData = await modern.json().catch(() => null)
          if (!modern.ok || !modernData?.ok) {
            throw new Error(readErrorMessage(modernData, tr('Failed to remove role', '移除角色失败')))
          }
          updated += 1
          continue
        }

        const permissions = provisionRolePermissions[role] || []
        for (const permission of permissions) {
          const response = await apiFetch('/api/permissions/revoke', {
            method: 'POST',
            body: JSON.stringify({ userId, permission }),
          })
          if (response.status === 403) {
            adminForbidden.value = true
            throw new Error(tr('Admin permissions required', '需要管理员权限'))
          }
          const data = await response.json().catch(() => null)
          if (!response.ok && response.status !== 404) {
            throw new Error(readErrorMessage(data, tr(`Failed to revoke ${permission}`, `撤销权限 ${permission} 失败`)))
          }
        }
        updated += 1
      } catch {
        failed.push(userId)
      }
    }

    const message = failed.length
      ? tr(`Role '${role}' removed from ${updated}/${valid.length} user(s). Failed: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`, `角色 '${role}' 已从 ${updated}/${valid.length} 个用户移除。失败：${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`)
      : tr(`Role '${role}' removed from ${updated}/${valid.length} user(s).`, `角色 '${role}' 已从 ${updated}/${valid.length} 个用户移除。`)
    setProvisionBatchStatus(message, failed.length ? 'error' : 'info')
  } catch (error: any) {
    setProvisionBatchStatus(readErrorMessage(error, tr('Failed to batch remove role', '批量移除角色失败')), 'error')
  } finally {
    provisionBatchLoading.value = false
  }
}

function clearProvisionBatch() {
  provisionBatchUserIdsText.value = ''
  provisionBatchStatusMessage.value = ''
  provisionBatchStatusKind.value = 'info'
  provisionBatchPreviewLoading.value = false
  clearProvisionBatchPreview()
}

function toggleAuditLogMeta(item: AttendanceAuditLogItem) {
  auditLogSelectedId.value = auditLogSelectedId.value === item.id ? '' : item.id
}

function appendAuditLogFilters(params: URLSearchParams) {
  const q = auditLogQuery.value.trim()
  if (q) params.set('q', q)
  const actionPrefix = auditLogActionPrefix.value.trim()
  if (actionPrefix) params.set('actionPrefix', actionPrefix)
  const statusClass = auditLogStatusClass.value.trim()
  if (statusClass) params.set('statusClass', statusClass)
  const errorCode = auditLogErrorCode.value.trim()
  if (errorCode) params.set('errorCode', errorCode)
  const from = auditLogFrom.value.trim()
  if (from) {
    const fromDate = new Date(from)
    if (!Number.isNaN(fromDate.getTime())) params.set('from', fromDate.toISOString())
  }
  const to = auditLogTo.value.trim()
  if (to) {
    const toDate = new Date(to)
    if (!Number.isNaN(toDate.getTime())) params.set('to', toDate.toISOString())
  }
}

async function loadAuditSummary() {
  auditSummaryLoading.value = true
  try {
    const params = new URLSearchParams({
      windowMinutes: '60',
      limit: '8',
    })
    const response = await apiFetch(`/api/attendance-admin/audit-logs/summary?${params.toString()}`)
    if (response.status === 404) {
      auditSummaryActions.value = []
      auditSummaryErrors.value = []
      return
    }
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load audit summary', '加载审计汇总失败')))
    }

    const actionsRaw = Array.isArray(data.data?.actions) ? data.data.actions : []
    const errorsRaw = Array.isArray(data.data?.errors) ? data.data.errors : []

    auditSummaryActions.value = actionsRaw.map((row: any) => ({
      key: String(row?.action || '--'),
      total: Number(row?.total ?? 0) || 0,
    }))
    auditSummaryErrors.value = errorsRaw.map((row: any) => ({
      key: String(row?.error_code || '--'),
      total: Number(row?.total ?? 0) || 0,
    }))
  } catch (error: any) {
    setAuditLogStatus(readErrorMessage(error, tr('Failed to load audit summary', '加载审计汇总失败')), 'error')
  } finally {
    auditSummaryLoading.value = false
  }
}

function reloadAuditLogs() {
  void Promise.all([loadAuditLogs(1), loadAuditSummary()])
}

async function exportAuditLogsCsv() {
  auditLogExporting.value = true
  try {
    const params = new URLSearchParams()
    appendAuditLogFilters(params)
    // Safety cap (server also enforces).
    params.set('limit', '5000')

    const response = await apiFetch(`/api/attendance-admin/audit-logs/export.csv?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'text/csv' },
    })

    if (response.status === 404) {
      setAuditLogStatus(tr('Audit log export API not available on this deployment.', '当前部署不支持审计日志导出 API。'), 'error')
      return
    }
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }

    const csvText = await response.text()
    if (!response.ok) {
      throw new Error(csvText.slice(0, 200) || tr(`Export failed (HTTP ${response.status})`, `导出失败（HTTP ${response.status}）`))
    }

    const now = new Date()
    const filename = `attendance-audit-logs-${now.toISOString().replace(/[:.]/g, '-')}.csv`
    downloadCsvText(filename, csvText)
    setAuditLogStatus(tr('Audit logs exported.', '审计日志已导出。'))
  } catch (error: any) {
    setAuditLogStatus(readErrorMessage(error, tr('Failed to export audit logs', '导出审计日志失败')), 'error')
  } finally {
    auditLogExporting.value = false
  }
}

async function loadAuditLogs(page: number) {
  auditLogSelectedId.value = ''
  auditLogLoading.value = true
  try {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(auditLogPageSize),
    })
    appendAuditLogFilters(params)
    const response = await apiFetch(`/api/attendance-admin/audit-logs?${params.toString()}`)
    if (response.status === 404) {
      auditLogs.value = []
      auditLogTotal.value = 0
      auditLogPage.value = 1
      setAuditLogStatus(tr('Audit log API not available on this deployment.', '当前部署不支持审计日志 API。'), 'error')
      return
    }
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load audit logs', '加载审计日志失败')))
    }
    const items = Array.isArray(data.data?.items) ? data.data.items : []
    auditLogs.value = items
    auditLogTotal.value = Number(data.data?.total ?? items.length) || 0
    auditLogPage.value = Number(data.data?.page ?? page) || page
    setAuditLogStatus(tr(`Loaded ${items.length} log(s).`, `已加载 ${items.length} 条日志。`))
  } catch (error: any) {
    setAuditLogStatus(readErrorMessage(error, tr('Failed to load audit logs', '加载审计日志失败')), 'error')
  } finally {
    auditLogLoading.value = false
  }
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
      throw new Error(readErrorMessage(data, tr('Punch failed', '打卡失败')))
    }
    setStatus(tr(`${eventType === 'check_in' ? 'Check in' : 'Check out'} recorded.`, `${eventType === 'check_in' ? '上班打卡' : '下班打卡'}已记录。`))
    await refreshAll()
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Punch failed', '打卡失败')), 'error')
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
    throw new Error(readErrorMessage(data, tr('Failed to load summary', '加载汇总失败')))
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
    throw new Error(readErrorMessage(data, tr('Failed to load records', '加载记录失败')))
  }
  records.value = data.data.items
  recordsTotal.value = data.data.total
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
    throw new Error(readErrorMessage(data, tr('Failed to load requests', '加载申请失败')))
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
      throw new Error(readErrorMessage(data, tr('Failed to load anomalies', '加载异常失败')))
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
      throw new Error(readErrorMessage(data, tr('Failed to load request report', '加载申请报表失败')))
    }
    requestReport.value = data.data.items || []
  } finally {
    reportLoading.value = false
  }
}

async function refreshAll(): Promise<boolean> {
  if (!attendancePluginActive.value) return false
  loading.value = true
  recordsPage.value = 1
  calendarMonth.value = new Date(`${toDate.value}T00:00:00`)
  let success = true
  try {
    await Promise.all([loadSummary(), loadRecords(), loadRequests(), loadAnomalies(), loadRequestReport(), loadHolidays()])
  } catch (error: any) {
    success = false
    setStatusFromError(error, tr('Refresh failed', '刷新失败'), 'refresh')
  } finally {
    loading.value = false
  }
  return success
}

async function refreshOverviewWithStatus() {
  const success = await refreshAll()
  if (!success) return
  setStatus(
    appendStatusContext(tr('Overview refreshed.', '总览已刷新。'), overviewRefreshTimezoneContextHint.value),
  )
}

async function reloadAnomaliesWithStatus() {
  try {
    await loadAnomalies()
    setStatus(
      appendStatusContext(
        tr(`Anomalies loaded (${anomalies.value.length}).`, `异常已加载（${anomalies.value.length} 条）。`),
        anomaliesTimezoneContextHint.value,
      ),
    )
  } catch (error: any) {
    setStatusFromErrorWithContext(
      error,
      tr('Failed to load anomalies', '加载异常失败'),
      anomaliesTimezoneContextHint.value,
      'refresh',
    )
  }
}

async function reloadRequestReportWithStatus() {
  try {
    await loadRequestReport()
    setStatus(
      appendStatusContext(
        tr(`Report loaded (${requestReport.value.length}).`, `报表已加载（${requestReport.value.length} 条）。`),
        requestReportTimezoneContextHint.value,
      ),
    )
  } catch (error: any) {
    setStatusFromErrorWithContext(
      error,
      tr('Failed to load request report', '加载申请报表失败'),
      requestReportTimezoneContextHint.value,
      'refresh',
    )
  }
}

async function reloadRecordsWithStatus() {
  try {
    await loadRecords()
    setStatus(
      appendStatusContext(
        tr(`Records loaded (${records.value.length}).`, `记录已加载（${records.value.length} 条）。`),
        recordsTimezoneContextHint.value,
      ),
    )
  } catch (error: any) {
    setStatusFromErrorWithContext(
      error,
      tr('Failed to load records', '加载记录失败'),
      recordsTimezoneContextHint.value,
      'refresh',
    )
  }
}

async function reloadRequestsWithStatus() {
  try {
    await loadRequests()
    setStatus(
      appendStatusContext(
        tr(`Requests loaded (${requests.value.length}).`, `申请已加载（${requests.value.length} 条）。`),
        requestTimezoneContextHint.value,
      ),
    )
  } catch (error: any) {
    setStatusFromErrorWithContext(
      error,
      tr('Failed to load requests', '加载申请失败'),
      requestTimezoneContextHint.value,
      'refresh',
    )
  }
}

async function shiftMonth(delta: number) {
  const next = new Date(calendarMonth.value)
  next.setMonth(next.getMonth() + delta, 1)
  const from = new Date(next.getFullYear(), next.getMonth(), 1)
  const to = new Date(next.getFullYear(), next.getMonth() + 1, 0)
  fromDate.value = toDateInput(from)
  toDate.value = toDateInput(to)
  const success = await refreshAll()
  if (!success) return
  setStatus(
    appendStatusContext(
      tr(`Calendar updated: ${calendarLabel.value}.`, `日历已切换：${calendarLabel.value}。`),
      calendarTimezoneContextHint.value,
    ),
  )
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
      setStatus(appendStatusContext(validationMessage, requestTimezoneContextHint.value), 'error')
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
    setStatus(appendStatusContext(tr('Request submitted.', '申请已提交。'), requestTimezoneContextHint.value))
    await loadRequests()
  } catch (error: any) {
    setStatusFromErrorWithContext(
      error,
      tr('Request failed', '申请失败'),
      requestTimezoneContextHint.value,
      'request-submit',
    )
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
    const actionLabel = action === 'approve'
      ? tr('Request approved.', '申请已批准。')
      : tr('Request rejected.', '申请已驳回。')
    setStatus(
      appendStatusContext(actionLabel, requestTimezoneContextHint.value),
    )
    await loadRequests()
    await loadSummary()
    await loadRecords()
  } catch (error: any) {
    setStatusFromErrorWithContext(
      error,
      tr('Request update failed', '申请处理失败'),
      requestTimezoneContextHint.value,
      'request-resolve',
    )
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
    setStatus(appendStatusContext(tr('Request cancelled.', '申请已取消。'), requestTimezoneContextHint.value))
    await loadRequests()
  } catch (error: any) {
    setStatusFromErrorWithContext(
      error,
      tr('Request cancel failed', '申请取消失败'),
      requestTimezoneContextHint.value,
      'request-cancel',
    )
  }
}

async function changeRecordsPage(delta: number) {
  const next = recordsPage.value + delta
  if (next < 1 || next > recordsTotalPages.value) return
  recordsPage.value = next
  try {
    await loadRecords()
    setStatus(
      appendStatusContext(
        tr(`Records page ${recordsPage.value}/${recordsTotalPages.value} loaded.`, `记录页 ${recordsPage.value}/${recordsTotalPages.value} 已加载。`),
        recordsTimezoneContextHint.value,
      ),
    )
  } catch (error: any) {
    setStatusFromErrorWithContext(
      error,
      tr('Failed to load records', '加载记录失败'),
      recordsTimezoneContextHint.value,
      'refresh',
    )
  }
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
        message = readErrorMessage(parsed, message)
      } catch {
        message = text || message
      }
      throw new Error(message)
    }
    const disposition = response.headers.get('content-disposition')
    const match = disposition?.match(/filename="?([^";]+)"?/)
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
    setStatus(appendStatusContext(tr('Export ready.', '导出完成。'), recordsTimezoneContextHint.value))
  } catch (error: any) {
    setStatus(
      appendStatusContext(readErrorMessage(error, tr('Export failed', '导出失败')), recordsTimezoneContextHint.value),
      'error',
    )
  } finally {
    exporting.value = false
  }
}

function listToText(list?: Array<string | number>): string {
  return Array.isArray(list) ? list.join(',') : ''
}

function splitListText(value?: string): string[] {
  if (!value) return []
  return value
    .split(/[\n,]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function splitNumberList(value?: string): number[] {
  if (!value) return []
  return value
    .split(/[\n,\s]+/)
    .map(item => Number(item))
    .filter(item => Number.isFinite(item))
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : undefined
}

function applySettingsToForm(settings: AttendanceSettings) {
  settingsForm.autoAbsenceEnabled = Boolean(settings.autoAbsence?.enabled)
  settingsForm.autoAbsenceRunAt = settings.autoAbsence?.runAt || '00:15'
  settingsForm.autoAbsenceLookbackDays = settings.autoAbsence?.lookbackDays || 1
  settingsForm.holidayFirstDayEnabled = settings.holidayPolicy?.firstDayEnabled ?? true
  settingsForm.holidayFirstDayBaseHours = settings.holidayPolicy?.firstDayBaseHours ?? 8
  settingsForm.holidayOvertimeAdds = settings.holidayPolicy?.overtimeAdds ?? true
  settingsForm.holidayOvertimeSource = settings.holidayPolicy?.overtimeSource ?? 'approval'
  settingsForm.holidayOverrides = Array.isArray(settings.holidayPolicy?.overrides)
    ? settings.holidayPolicy?.overrides.map((override) => {
        const overrideSource = override.overtimeSource === 'approval'
          || override.overtimeSource === 'clock'
          || override.overtimeSource === 'both'
          ? override.overtimeSource
          : settingsForm.holidayOvertimeSource
        return {
          name: override.name || '',
          match: override.match ?? 'contains',
          attendanceGroups: listToText(override.attendanceGroups),
          roles: listToText(override.roles),
          roleTags: listToText(override.roleTags),
          userIds: listToText(override.userIds),
          userNames: listToText(override.userNames),
          excludeUserIds: listToText(override.excludeUserIds),
          excludeUserNames: listToText(override.excludeUserNames),
          dayIndexStart: override.dayIndexStart ?? null,
          dayIndexEnd: override.dayIndexEnd ?? null,
          dayIndexList: listToText(override.dayIndexList),
          firstDayEnabled: override.firstDayEnabled ?? settingsForm.holidayFirstDayEnabled,
          firstDayBaseHours: override.firstDayBaseHours ?? settingsForm.holidayFirstDayBaseHours,
          overtimeAdds: override.overtimeAdds ?? settingsForm.holidayOvertimeAdds,
          overtimeSource: overrideSource,
        }
      })
    : []
  settingsForm.holidaySyncBaseUrl = settings.holidaySync?.baseUrl
    || 'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master'
  settingsForm.holidaySyncYears = Array.isArray(settings.holidaySync?.years)
    ? settings.holidaySync?.years?.join(',')
    : ''
  settingsForm.holidaySyncAddDayIndex = settings.holidaySync?.addDayIndex ?? true
  settingsForm.holidaySyncDayIndexHolidays = Array.isArray(settings.holidaySync?.dayIndexHolidays)
    ? settings.holidaySync?.dayIndexHolidays?.join(',')
    : '春节,国庆'
  settingsForm.holidaySyncDayIndexMaxDays = settings.holidaySync?.dayIndexMaxDays ?? 7
  settingsForm.holidaySyncDayIndexFormat = settings.holidaySync?.dayIndexFormat ?? 'name-1'
  settingsForm.holidaySyncOverwrite = settings.holidaySync?.overwrite ?? false
  settingsForm.holidaySyncAutoEnabled = settings.holidaySync?.auto?.enabled ?? false
  settingsForm.holidaySyncAutoRunAt = settings.holidaySync?.auto?.runAt ?? '02:00'
  settingsForm.holidaySyncAutoTimezone = settings.holidaySync?.auto?.timezone ?? 'UTC'
  holidaySyncLastRun.value = settings.holidaySync?.lastRun ?? null
  settingsForm.ipAllowlist = (settings.ipAllowlist || []).join('\n')
  settingsForm.geoFenceLat = settings.geoFence?.lat?.toString() ?? ''
  settingsForm.geoFenceLng = settings.geoFence?.lng?.toString() ?? ''
  settingsForm.geoFenceRadius = settings.geoFence?.radiusMeters?.toString() ?? ''
  settingsForm.minPunchIntervalMinutes = settings.minPunchIntervalMinutes ?? 1
}

function addHolidayOverride() {
  settingsForm.holidayOverrides.push({
    name: '',
    match: 'contains',
    attendanceGroups: '',
    roles: '',
    roleTags: '',
    userIds: '',
    userNames: '',
    excludeUserIds: '',
    excludeUserNames: '',
    dayIndexStart: null,
    dayIndexEnd: null,
    dayIndexList: '',
    firstDayEnabled: settingsForm.holidayFirstDayEnabled,
    firstDayBaseHours: settingsForm.holidayFirstDayBaseHours,
    overtimeAdds: settingsForm.holidayOvertimeAdds,
    overtimeSource: settingsForm.holidayOvertimeSource,
  })
}

function removeHolidayOverride(index: number) {
  settingsForm.holidayOverrides.splice(index, 1)
}

async function loadSettings() {
  settingsLoading.value = true
  try {
    const response = await apiFetchWithTimeout('/api/attendance/settings', {}, ATTENDANCE_ADMIN_REQUEST_TIMEOUT_MS)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load settings', '加载设置失败')))
    }
    adminForbidden.value = false
    applySettingsToForm(data.data || {})
  } catch (error: any) {
    setStatusFromError(error, tr('Failed to load settings', '加载设置失败'), 'admin')
  } finally {
    settingsLoading.value = false
  }
}

async function saveSettings() {
  settingsLoading.value = true
  try {
    const ipAllowlist = settingsForm.ipAllowlist
      .split(/[\n,]/)
      .map(item => item.trim())
      .filter(Boolean)

    const latValue = settingsForm.geoFenceLat.trim()
    const lngValue = settingsForm.geoFenceLng.trim()
    const radiusValue = settingsForm.geoFenceRadius.trim()
    const lat = latValue.length > 0 ? Number(latValue) : Number.NaN
    const lng = lngValue.length > 0 ? Number(lngValue) : Number.NaN
    const radius = radiusValue.length > 0 ? Number(radiusValue) : Number.NaN
    const geoFence = Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radius)
      ? { lat, lng, radiusMeters: radius }
      : null

    const overtimeSourceValue = settingsForm.holidayOvertimeSource
    const overtimeSource = overtimeSourceValue === 'approval' || overtimeSourceValue === 'clock' || overtimeSourceValue === 'both'
      ? overtimeSourceValue
      : 'approval'
    const dayIndexFormatValue = settingsForm.holidaySyncDayIndexFormat
    const dayIndexFormat = dayIndexFormatValue === 'name-1'
      || dayIndexFormatValue === 'name第1天'
      || dayIndexFormatValue === 'name DAY1'
      ? dayIndexFormatValue
      : 'name-1'

    const payload: AttendanceSettings = {
      autoAbsence: {
        enabled: settingsForm.autoAbsenceEnabled,
        runAt: settingsForm.autoAbsenceRunAt || '00:15',
        lookbackDays: Number(settingsForm.autoAbsenceLookbackDays) || 1,
      },
      holidayPolicy: {
        firstDayEnabled: settingsForm.holidayFirstDayEnabled,
        firstDayBaseHours: Number(settingsForm.holidayFirstDayBaseHours) || 0,
        overtimeAdds: settingsForm.holidayOvertimeAdds,
        overtimeSource,
        overrides: settingsForm.holidayOverrides
          .map((override) => ({
            name: override.name?.trim() || '',
            match: override.match || 'contains',
            attendanceGroups: splitListText(override.attendanceGroups),
            roles: splitListText(override.roles),
            roleTags: splitListText(override.roleTags),
            userIds: splitListText(override.userIds),
            userNames: splitListText(override.userNames),
            excludeUserIds: splitListText(override.excludeUserIds),
            excludeUserNames: splitListText(override.excludeUserNames),
            dayIndexStart: normalizeOptionalNumber(override.dayIndexStart),
            dayIndexEnd: normalizeOptionalNumber(override.dayIndexEnd),
            dayIndexList: splitNumberList(override.dayIndexList),
            firstDayEnabled: override.firstDayEnabled,
            firstDayBaseHours: Number.isFinite(Number(override.firstDayBaseHours))
              ? Number(override.firstDayBaseHours)
              : undefined,
            overtimeAdds: override.overtimeAdds,
            overtimeSource: override.overtimeSource === 'approval'
              || override.overtimeSource === 'clock'
              || override.overtimeSource === 'both'
              ? override.overtimeSource
              : undefined,
          }))
          .filter((override) => override.name.length > 0),
      },
      holidaySync: {
        source: 'holiday-cn',
        baseUrl: settingsForm.holidaySyncBaseUrl?.trim() || undefined,
        years: settingsForm.holidaySyncYears
          ? settingsForm.holidaySyncYears
              .split(/[\s,]+/)
              .map(item => Number(item))
              .filter(item => Number.isFinite(item))
          : undefined,
        addDayIndex: settingsForm.holidaySyncAddDayIndex,
        dayIndexHolidays: settingsForm.holidaySyncDayIndexHolidays
          ? settingsForm.holidaySyncDayIndexHolidays
              .split(/[\s,]+/)
              .map(item => item.trim())
              .filter(Boolean)
          : undefined,
        dayIndexMaxDays: Number(settingsForm.holidaySyncDayIndexMaxDays) || undefined,
        dayIndexFormat,
        overwrite: settingsForm.holidaySyncOverwrite,
        auto: {
          enabled: settingsForm.holidaySyncAutoEnabled,
          runAt: settingsForm.holidaySyncAutoRunAt || '02:00',
          timezone: settingsForm.holidaySyncAutoTimezone?.trim() || undefined,
        },
      },
      ipAllowlist,
      geoFence,
      minPunchIntervalMinutes: Number(settingsForm.minPunchIntervalMinutes) || 0,
    }

    const response = await apiFetchWithTimeout('/api/attendance/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }, ATTENDANCE_ADMIN_REQUEST_TIMEOUT_MS)
    if (response.status === 403) {
      adminForbidden.value = true
      throw createForbiddenError()
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw createApiError(response, data, tr('Failed to save settings', '保存设置失败'))
    }
    adminForbidden.value = false
    applySettingsToForm(data.data || payload)
    setStatus(tr('Settings updated.', '设置已更新。'))
  } catch (error: any) {
    setStatusFromError(error, tr('Failed to save settings', '保存设置失败'), 'save-settings')
  } finally {
    settingsLoading.value = false
  }
}

async function syncHolidays() {
  holidaySyncLoading.value = true
  try {
    const payload = {
      source: 'holiday-cn',
      ...buildHolidaySyncPayload(),
    }
    const response = await apiFetch('/api/attendance/holidays/sync', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Holiday sync failed', '节假日同步失败')))
    }
    if (data?.data?.lastRun) {
      holidaySyncLastRun.value = data.data.lastRun
    }
    setStatus(tr(`Holiday sync complete (${data.data?.totalApplied ?? 0} applied).`, `节假日同步完成（已应用 ${data.data?.totalApplied ?? 0} 条）。`))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Holiday sync failed', '节假日同步失败')), 'error')
  } finally {
    holidaySyncLoading.value = false
  }
}

function buildHolidaySyncPayload(overrides?: { years?: number[] }) {
  const years = overrides?.years ?? (settingsForm.holidaySyncYears
    ? settingsForm.holidaySyncYears
        .split(/[\s,]+/)
        .map(item => Number(item))
        .filter(item => Number.isFinite(item))
    : undefined)

  return {
    baseUrl: settingsForm.holidaySyncBaseUrl?.trim() || undefined,
    years,
    addDayIndex: settingsForm.holidaySyncAddDayIndex,
    dayIndexHolidays: settingsForm.holidaySyncDayIndexHolidays
      ? settingsForm.holidaySyncDayIndexHolidays
          .split(/[\s,]+/)
          .map(item => item.trim())
          .filter(Boolean)
      : undefined,
    dayIndexMaxDays: Number(settingsForm.holidaySyncDayIndexMaxDays) || undefined,
    dayIndexFormat: settingsForm.holidaySyncDayIndexFormat || 'name-1',
    overwrite: settingsForm.holidaySyncOverwrite,
  }
}

async function syncHolidaysForYears(years: number[]) {
  settingsForm.holidaySyncYears = years.join(',')
  holidaySyncLoading.value = true
  try {
    const response = await apiFetch('/api/attendance/holidays/sync', {
      method: 'POST',
      body: JSON.stringify({
        source: 'holiday-cn',
        ...buildHolidaySyncPayload({ years }),
      }),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Holiday sync failed', '节假日同步失败')))
    }
    if (data?.data?.lastRun) {
      holidaySyncLastRun.value = data.data.lastRun
    }
    setStatus(tr(`Holiday sync complete (${data.data?.totalApplied ?? 0} applied).`, `节假日同步完成（已应用 ${data.data?.totalApplied ?? 0} 条）。`))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Holiday sync failed', '节假日同步失败')), 'error')
  } finally {
    holidaySyncLoading.value = false
  }
}

async function loadRule() {
  ruleLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetchWithTimeout(`/api/attendance/rules/default?${query.toString()}`, {}, ATTENDANCE_ADMIN_REQUEST_TIMEOUT_MS)
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load rule', '加载规则失败')))
    }
    const rule: AttendanceRule = data.data
    ruleForm.name = rule.name || 'Default'
    ruleForm.timezone = rule.timezone || defaultTimezone
    ruleForm.workStartTime = rule.workStartTime || '09:00'
    ruleForm.workEndTime = rule.workEndTime || '18:00'
    ruleForm.lateGraceMinutes = rule.lateGraceMinutes ?? 10
    ruleForm.earlyGraceMinutes = rule.earlyGraceMinutes ?? 10
    ruleForm.roundingMinutes = rule.roundingMinutes ?? 5
    ruleForm.workingDays = Array.isArray(rule.workingDays) ? rule.workingDays.join(',') : '1,2,3,4,5'
  } catch (error: any) {
    setStatusFromError(error, tr('Failed to load rule', '加载规则失败'), 'admin')
  } finally {
    ruleLoading.value = false
  }
}

async function saveRule() {
  ruleLoading.value = true
  try {
    const payload = {
      name: ruleForm.name,
      timezone: ruleForm.timezone,
      workStartTime: ruleForm.workStartTime,
      workEndTime: ruleForm.workEndTime,
      lateGraceMinutes: Number(ruleForm.lateGraceMinutes) || 0,
      earlyGraceMinutes: Number(ruleForm.earlyGraceMinutes) || 0,
      roundingMinutes: Number(ruleForm.roundingMinutes) || 0,
      workingDays: parseWorkingDaysInput(ruleForm.workingDays),
      orgId: normalizedOrgId(),
    }
    const response = await apiFetchWithTimeout('/api/attendance/rules/default', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }, ATTENDANCE_ADMIN_REQUEST_TIMEOUT_MS)
    if (response.status === 403) {
      adminForbidden.value = true
      throw createForbiddenError()
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw createApiError(response, data, tr('Failed to save rule', '保存规则失败'))
    }
    const rule: AttendanceRule = data.data
    ruleForm.name = rule.name || ruleForm.name
    ruleForm.timezone = rule.timezone || ruleForm.timezone
    ruleForm.workStartTime = rule.workStartTime || ruleForm.workStartTime
    ruleForm.workEndTime = rule.workEndTime || ruleForm.workEndTime
    ruleForm.lateGraceMinutes = rule.lateGraceMinutes ?? ruleForm.lateGraceMinutes
    ruleForm.earlyGraceMinutes = rule.earlyGraceMinutes ?? ruleForm.earlyGraceMinutes
    ruleForm.roundingMinutes = rule.roundingMinutes ?? ruleForm.roundingMinutes
    ruleForm.workingDays = Array.isArray(rule.workingDays) ? rule.workingDays.join(',') : ruleForm.workingDays
    setStatus(tr('Rule updated.', '规则已更新。'))
  } catch (error: any) {
    setStatusFromError(error, tr('Failed to save rule', '保存规则失败'), 'save-rule')
  } finally {
    ruleLoading.value = false
  }
}

function resetLeaveTypeForm() {
  leaveTypeEditingId.value = null
  leaveTypeForm.code = ''
  leaveTypeForm.name = ''
  leaveTypeForm.requiresApproval = true
  leaveTypeForm.requiresAttachment = false
  leaveTypeForm.defaultMinutesPerDay = 480
  leaveTypeForm.isActive = true
}

function editLeaveType(item: AttendanceLeaveType) {
  leaveTypeEditingId.value = item.id
  leaveTypeForm.code = item.code
  leaveTypeForm.name = item.name
  leaveTypeForm.requiresApproval = item.requiresApproval
  leaveTypeForm.requiresAttachment = item.requiresAttachment
  leaveTypeForm.defaultMinutesPerDay = item.defaultMinutesPerDay
  leaveTypeForm.isActive = item.isActive
}

async function loadLeaveTypes() {
  leaveTypeLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetch(`/api/attendance/leave-types?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load leave types', '加载请假类型失败')))
    }
    adminForbidden.value = false
    leaveTypes.value = data.data.items || []
    if (!requestForm.leaveTypeId && leaveTypes.value.length > 0) {
      requestForm.leaveTypeId = leaveTypes.value[0].id
    }
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load leave types', '加载请假类型失败')), 'error')
  } finally {
    leaveTypeLoading.value = false
  }
}

async function saveLeaveType() {
  leaveTypeSaving.value = true
  const isEditing = Boolean(leaveTypeEditingId.value)
  try {
    if (!leaveTypeForm.code.trim() || !leaveTypeForm.name.trim()) {
      throw new Error(tr('Code and name are required', '编码和名称为必填项'))
    }
    const payload = {
      code: leaveTypeForm.code.trim(),
      name: leaveTypeForm.name.trim(),
      requiresApproval: leaveTypeForm.requiresApproval,
      requiresAttachment: leaveTypeForm.requiresAttachment,
      defaultMinutesPerDay: Number(leaveTypeForm.defaultMinutesPerDay) || 0,
      isActive: leaveTypeForm.isActive,
      orgId: normalizedOrgId(),
    }
    const endpoint = isEditing
      ? `/api/attendance/leave-types/${leaveTypeEditingId.value}`
      : '/api/attendance/leave-types'
    const response = await apiFetch(endpoint, {
      method: isEditing ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save leave type', '保存请假类型失败')))
    }
    adminForbidden.value = false
    await loadLeaveTypes()
    resetLeaveTypeForm()
    setStatus(isEditing ? tr('Leave type updated.', '请假类型已更新。') : tr('Leave type created.', '请假类型已创建。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save leave type', '保存请假类型失败')), 'error')
  } finally {
    leaveTypeSaving.value = false
  }
}

async function deleteLeaveType(id: string) {
  if (!window.confirm(tr('Delete this leave type?', '确认删除该请假类型吗？'))) return
  try {
    const response = await apiFetch(`/api/attendance/leave-types/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to delete leave type', '删除请假类型失败')))
    }
    adminForbidden.value = false
    await loadLeaveTypes()
    setStatus(tr('Leave type deleted.', '请假类型已删除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to delete leave type', '删除请假类型失败')), 'error')
  }
}

function resetOvertimeRuleForm() {
  overtimeRuleEditingId.value = null
  overtimeRuleForm.name = ''
  overtimeRuleForm.minMinutes = 0
  overtimeRuleForm.roundingMinutes = 15
  overtimeRuleForm.maxMinutesPerDay = 600
  overtimeRuleForm.requiresApproval = true
  overtimeRuleForm.isActive = true
}

function editOvertimeRule(item: AttendanceOvertimeRule) {
  overtimeRuleEditingId.value = item.id
  overtimeRuleForm.name = item.name
  overtimeRuleForm.minMinutes = item.minMinutes
  overtimeRuleForm.roundingMinutes = item.roundingMinutes
  overtimeRuleForm.maxMinutesPerDay = item.maxMinutesPerDay
  overtimeRuleForm.requiresApproval = item.requiresApproval
  overtimeRuleForm.isActive = item.isActive
}

async function loadOvertimeRules() {
  overtimeRuleLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetch(`/api/attendance/overtime-rules?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load overtime rules', '加载加班规则失败')))
    }
    adminForbidden.value = false
    overtimeRules.value = data.data.items || []
    if (!requestForm.overtimeRuleId && overtimeRules.value.length > 0) {
      requestForm.overtimeRuleId = overtimeRules.value[0].id
    }
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load overtime rules', '加载加班规则失败')), 'error')
  } finally {
    overtimeRuleLoading.value = false
  }
}

async function saveOvertimeRule() {
  overtimeRuleSaving.value = true
  const isEditing = Boolean(overtimeRuleEditingId.value)
  try {
    if (!overtimeRuleForm.name.trim()) {
      throw new Error(tr('Name is required', '名称为必填项'))
    }
    const payload = {
      name: overtimeRuleForm.name.trim(),
      minMinutes: Number(overtimeRuleForm.minMinutes) || 0,
      roundingMinutes: Number(overtimeRuleForm.roundingMinutes) || 1,
      maxMinutesPerDay: Number(overtimeRuleForm.maxMinutesPerDay) || 0,
      requiresApproval: overtimeRuleForm.requiresApproval,
      isActive: overtimeRuleForm.isActive,
      orgId: normalizedOrgId(),
    }
    const endpoint = isEditing
      ? `/api/attendance/overtime-rules/${overtimeRuleEditingId.value}`
      : '/api/attendance/overtime-rules'
    const response = await apiFetch(endpoint, {
      method: isEditing ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save overtime rule', '保存加班规则失败')))
    }
    adminForbidden.value = false
    await loadOvertimeRules()
    resetOvertimeRuleForm()
    setStatus(
      isEditing
        ? tr('Overtime rule updated.', '加班规则已更新。')
        : tr('Overtime rule created.', '加班规则已创建。')
    )
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save overtime rule', '保存加班规则失败')), 'error')
  } finally {
    overtimeRuleSaving.value = false
  }
}

async function deleteOvertimeRule(id: string) {
  if (!window.confirm(tr('Delete this overtime rule?', '确认删除该加班规则吗？'))) return
  try {
    const response = await apiFetch(`/api/attendance/overtime-rules/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to delete overtime rule', '删除加班规则失败')))
    }
    adminForbidden.value = false
    await loadOvertimeRules()
    setStatus(tr('Overtime rule deleted.', '加班规则已删除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to delete overtime rule', '删除加班规则失败')), 'error')
  }
}

function resetApprovalFlowForm() {
  approvalFlowEditingId.value = null
  approvalFlowForm.name = ''
  approvalFlowForm.requestType = 'leave'
  approvalFlowForm.steps = ''
  approvalFlowForm.isActive = true
}

function editApprovalFlow(flow: AttendanceApprovalFlow) {
  approvalFlowEditingId.value = flow.id
  approvalFlowForm.name = flow.name
  approvalFlowForm.requestType = flow.requestType
  approvalFlowForm.steps = formatApprovalSteps(flow.steps)
  approvalFlowForm.isActive = flow.isActive
}

async function loadApprovalFlows() {
  approvalFlowLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetch(`/api/attendance/approval-flows?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load approval flows', '加载审批流程失败')))
    }
    adminForbidden.value = false
    approvalFlows.value = data.data.items || []
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load approval flows', '加载审批流程失败')), 'error')
  } finally {
    approvalFlowLoading.value = false
  }
}

async function saveApprovalFlow() {
  approvalFlowSaving.value = true
  const isEditing = Boolean(approvalFlowEditingId.value)
  try {
    if (!approvalFlowForm.name.trim()) {
      throw new Error(tr('Name is required', '名称为必填项'))
    }
    const steps = parseApprovalStepsInput(approvalFlowForm.steps)
    if (steps === null) {
      throw new Error(tr('Invalid steps JSON', '步骤 JSON 格式无效'))
    }
    const payload = {
      name: approvalFlowForm.name.trim(),
      requestType: approvalFlowForm.requestType,
      steps,
      isActive: approvalFlowForm.isActive,
      orgId: normalizedOrgId(),
    }
    const endpoint = isEditing
      ? `/api/attendance/approval-flows/${approvalFlowEditingId.value}`
      : '/api/attendance/approval-flows'
    const response = await apiFetch(endpoint, {
      method: isEditing ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save approval flow', '保存审批流程失败')))
    }
    adminForbidden.value = false
    await loadApprovalFlows()
    resetApprovalFlowForm()
    setStatus(isEditing ? tr('Approval flow updated.', '审批流程已更新。') : tr('Approval flow created.', '审批流程已创建。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save approval flow', '保存审批流程失败')), 'error')
  } finally {
    approvalFlowSaving.value = false
  }
}

async function deleteApprovalFlow(id: string) {
  if (!window.confirm(tr('Delete this approval flow?', '确认删除该审批流程吗？'))) return
  try {
    const response = await apiFetch(`/api/attendance/approval-flows/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to delete approval flow', '删除审批流程失败')))
    }
    adminForbidden.value = false
    await loadApprovalFlows()
    setStatus(tr('Approval flow deleted.', '审批流程已删除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to delete approval flow', '删除审批流程失败')), 'error')
  }
}

function resetRotationRuleForm() {
  rotationRuleEditingId.value = null
  rotationRuleForm.name = ''
  rotationRuleForm.timezone = defaultTimezone
  rotationRuleForm.shiftSequence = ''
  rotationRuleForm.isActive = true
}

function editRotationRule(rule: AttendanceRotationRule) {
  rotationRuleEditingId.value = rule.id
  rotationRuleForm.name = rule.name
  rotationRuleForm.timezone = rule.timezone
  rotationRuleForm.shiftSequence = rule.shiftSequence.join(', ')
  rotationRuleForm.isActive = rule.isActive
}

async function loadRotationRules() {
  rotationRuleLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetch(`/api/attendance/rotation-rules?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load rotation rules', '加载轮班规则失败')))
    }
    adminForbidden.value = false
    rotationRules.value = data.data.items || []
    if (!rotationAssignmentForm.rotationRuleId && rotationRules.value.length > 0) {
      rotationAssignmentForm.rotationRuleId = rotationRules.value[0].id
    }
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load rotation rules', '加载轮班规则失败')), 'error')
  } finally {
    rotationRuleLoading.value = false
  }
}

async function saveRotationRule() {
  rotationRuleSaving.value = true
  const isEditing = Boolean(rotationRuleEditingId.value)
  try {
    if (!rotationRuleForm.name.trim()) {
      throw new Error(tr('Name is required', '名称为必填项'))
    }
    const shiftSequence = parseShiftSequenceInput(rotationRuleForm.shiftSequence)
    if (shiftSequence.length === 0) {
      throw new Error(tr('Shift sequence required', '班次序列为必填项'))
    }
    const payload = {
      name: rotationRuleForm.name.trim(),
      timezone: rotationRuleForm.timezone.trim() || defaultTimezone,
      shiftSequence,
      isActive: rotationRuleForm.isActive,
      orgId: normalizedOrgId(),
    }
    const endpoint = isEditing
      ? `/api/attendance/rotation-rules/${rotationRuleEditingId.value}`
      : '/api/attendance/rotation-rules'
    const response = await apiFetch(endpoint, {
      method: isEditing ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save rotation rule', '保存轮班规则失败')))
    }
    adminForbidden.value = false
    await loadRotationRules()
    resetRotationRuleForm()
    setStatus(isEditing ? tr('Rotation rule updated.', '轮班规则已更新。') : tr('Rotation rule created.', '轮班规则已创建。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save rotation rule', '保存轮班规则失败')), 'error')
  } finally {
    rotationRuleSaving.value = false
  }
}

async function deleteRotationRule(id: string) {
  if (!window.confirm(tr('Delete this rotation rule?', '确认删除该轮班规则吗？'))) return
  try {
    const response = await apiFetch(`/api/attendance/rotation-rules/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to delete rotation rule', '删除轮班规则失败')))
    }
    adminForbidden.value = false
    await loadRotationRules()
    await loadRotationAssignments()
    setStatus(tr('Rotation rule deleted.', '轮班规则已删除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to delete rotation rule', '删除轮班规则失败')), 'error')
  }
}

function resetRotationAssignmentForm() {
  rotationAssignmentEditingId.value = null
  rotationAssignmentForm.userId = ''
  rotationAssignmentForm.rotationRuleId = rotationRules.value[0]?.id ?? ''
  rotationAssignmentForm.startDate = toDateInput(today)
  rotationAssignmentForm.endDate = ''
  rotationAssignmentForm.isActive = true
}

function editRotationAssignment(item: AttendanceRotationAssignmentItem) {
  rotationAssignmentEditingId.value = item.assignment.id
  rotationAssignmentForm.userId = item.assignment.userId
  rotationAssignmentForm.rotationRuleId = item.assignment.rotationRuleId
  rotationAssignmentForm.startDate = item.assignment.startDate
  rotationAssignmentForm.endDate = item.assignment.endDate ?? ''
  rotationAssignmentForm.isActive = item.assignment.isActive
}

async function loadRotationAssignments() {
  rotationAssignmentLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetch(`/api/attendance/rotation-assignments?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load rotation assignments', '加载轮班分配失败')))
    }
    adminForbidden.value = false
    rotationAssignments.value = data.data.items || []
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load rotation assignments', '加载轮班分配失败')), 'error')
  } finally {
    rotationAssignmentLoading.value = false
  }
}

async function saveRotationAssignment() {
  rotationAssignmentSaving.value = true
  const isEditing = Boolean(rotationAssignmentEditingId.value)
  try {
    if (!rotationAssignmentForm.userId.trim()) {
      throw new Error(tr('User ID is required', '用户 ID 为必填项'))
    }
    if (!rotationAssignmentForm.rotationRuleId) {
      throw new Error(tr('Rotation rule is required', '轮班规则为必填项'))
    }
    const endDate = rotationAssignmentForm.endDate.trim()
    const payload = {
      userId: rotationAssignmentForm.userId.trim(),
      rotationRuleId: rotationAssignmentForm.rotationRuleId,
      startDate: rotationAssignmentForm.startDate,
      endDate: endDate.length > 0 ? endDate : null,
      isActive: rotationAssignmentForm.isActive,
      orgId: normalizedOrgId(),
    }
    const endpoint = isEditing
      ? `/api/attendance/rotation-assignments/${rotationAssignmentEditingId.value}`
      : '/api/attendance/rotation-assignments'
    const response = await apiFetch(endpoint, {
      method: isEditing ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save rotation assignment', '保存轮班分配失败')))
    }
    adminForbidden.value = false
    await loadRotationAssignments()
    resetRotationAssignmentForm()
    setStatus(
      isEditing
        ? tr('Rotation assignment updated.', '轮班分配已更新。')
        : tr('Rotation assignment created.', '轮班分配已创建。')
    )
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save rotation assignment', '保存轮班分配失败')), 'error')
  } finally {
    rotationAssignmentSaving.value = false
  }
}

async function deleteRotationAssignment(id: string) {
  if (!window.confirm(tr('Delete this rotation assignment?', '确认删除该轮班分配吗？'))) return
  try {
    const response = await apiFetch(`/api/attendance/rotation-assignments/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to delete rotation assignment', '删除轮班分配失败')))
    }
    adminForbidden.value = false
    await loadRotationAssignments()
    setStatus(tr('Rotation assignment deleted.', '轮班分配已删除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to delete rotation assignment', '删除轮班分配失败')), 'error')
  }
}

function resetShiftForm() {
  shiftEditingId.value = null
  shiftForm.name = 'Standard Shift'
  shiftForm.timezone = defaultTimezone
  shiftForm.workStartTime = '09:00'
  shiftForm.workEndTime = '18:00'
  shiftForm.lateGraceMinutes = 10
  shiftForm.earlyGraceMinutes = 10
  shiftForm.roundingMinutes = 5
  shiftForm.workingDays = '1,2,3,4,5'
}

function editShift(shift: AttendanceShift) {
  shiftEditingId.value = shift.id
  shiftForm.name = shift.name
  shiftForm.timezone = shift.timezone
  shiftForm.workStartTime = shift.workStartTime
  shiftForm.workEndTime = shift.workEndTime
  shiftForm.lateGraceMinutes = shift.lateGraceMinutes
  shiftForm.earlyGraceMinutes = shift.earlyGraceMinutes
  shiftForm.roundingMinutes = shift.roundingMinutes
  shiftForm.workingDays = shift.workingDays.join(',')
}

async function loadShifts() {
  shiftLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetch(`/api/attendance/shifts?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load shifts', '加载班次失败')))
    }
    adminForbidden.value = false
    shifts.value = data.data.items || []
    if (!assignmentForm.shiftId && shifts.value.length > 0) {
      assignmentForm.shiftId = shifts.value[0].id
    }
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load shifts', '加载班次失败')), 'error')
  } finally {
    shiftLoading.value = false
  }
}

async function saveShift() {
  shiftSaving.value = true
  const isEditing = Boolean(shiftEditingId.value)
  try {
    const payload = {
      name: shiftForm.name,
      timezone: shiftForm.timezone,
      workStartTime: shiftForm.workStartTime,
      workEndTime: shiftForm.workEndTime,
      lateGraceMinutes: Number(shiftForm.lateGraceMinutes) || 0,
      earlyGraceMinutes: Number(shiftForm.earlyGraceMinutes) || 0,
      roundingMinutes: Number(shiftForm.roundingMinutes) || 0,
      workingDays: parseWorkingDaysInput(shiftForm.workingDays),
      orgId: normalizedOrgId(),
    }
    const endpoint = isEditing
      ? `/api/attendance/shifts/${shiftEditingId.value}`
      : '/api/attendance/shifts'
    const response = await apiFetch(endpoint, {
      method: isEditing ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save shift', '保存班次失败')))
    }
    adminForbidden.value = false
    await loadShifts()
    resetShiftForm()
    setStatus(isEditing ? tr('Shift updated.', '班次已更新。') : tr('Shift created.', '班次已创建。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save shift', '保存班次失败')), 'error')
  } finally {
    shiftSaving.value = false
  }
}

async function deleteShift(id: string) {
  if (!window.confirm(tr('Delete this shift? Assignments will be removed.', '确认删除该班次吗？关联分配也会被移除。'))) return
  try {
    const response = await apiFetch(`/api/attendance/shifts/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to delete shift', '删除班次失败')))
    }
    adminForbidden.value = false
    await loadShifts()
    await loadAssignments()
    setStatus(tr('Shift deleted.', '班次已删除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to delete shift', '删除班次失败')), 'error')
  }
}

function resetAssignmentForm() {
  assignmentEditingId.value = null
  assignmentForm.userId = ''
  assignmentForm.shiftId = shifts.value[0]?.id ?? ''
  assignmentForm.startDate = toDateInput(today)
  assignmentForm.endDate = ''
  assignmentForm.isActive = true
}

function editAssignment(item: AttendanceAssignmentItem) {
  assignmentEditingId.value = item.assignment.id
  assignmentForm.userId = item.assignment.userId
  assignmentForm.shiftId = item.assignment.shiftId
  assignmentForm.startDate = item.assignment.startDate
  assignmentForm.endDate = item.assignment.endDate ?? ''
  assignmentForm.isActive = item.assignment.isActive
}

async function loadAssignments() {
  assignmentLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetch(`/api/attendance/assignments?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load assignments', '加载分配失败')))
    }
    adminForbidden.value = false
    assignments.value = data.data.items || []
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load assignments', '加载分配失败')), 'error')
  } finally {
    assignmentLoading.value = false
  }
}

async function saveAssignment() {
  assignmentSaving.value = true
  const isEditing = Boolean(assignmentEditingId.value)
  try {
    if (!assignmentForm.userId.trim()) {
      throw new Error(tr('User ID is required', '用户 ID 为必填项'))
    }
    if (!assignmentForm.shiftId) {
      throw new Error(tr('Shift selection is required', '班次为必选项'))
    }
    const endDate = assignmentForm.endDate.trim()
    const payload = {
      userId: assignmentForm.userId.trim(),
      shiftId: assignmentForm.shiftId,
      startDate: assignmentForm.startDate,
      endDate: endDate.length > 0 ? endDate : null,
      isActive: assignmentForm.isActive,
      orgId: normalizedOrgId(),
    }
    const endpoint = isEditing
      ? `/api/attendance/assignments/${assignmentEditingId.value}`
      : '/api/attendance/assignments'
    const response = await apiFetch(endpoint, {
      method: isEditing ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save assignment', '保存分配失败')))
    }
    adminForbidden.value = false
    await loadAssignments()
    resetAssignmentForm()
    setStatus(isEditing ? tr('Assignment updated.', '分配已更新。') : tr('Assignment created.', '分配已创建。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save assignment', '保存分配失败')), 'error')
  } finally {
    assignmentSaving.value = false
  }
}

async function deleteAssignment(id: string) {
  if (!window.confirm(tr('Delete this assignment?', '确认删除该分配吗？'))) return
  try {
    const response = await apiFetch(`/api/attendance/assignments/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to delete assignment', '删除分配失败')))
    }
    adminForbidden.value = false
    await loadAssignments()
    setStatus(tr('Assignment deleted.', '分配已删除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to delete assignment', '删除分配失败')), 'error')
  }
}

function resetHolidayForm() {
  holidayEditingId.value = null
  holidayForm.date = toDateInput(today)
  holidayForm.name = ''
  holidayForm.isWorkingDay = false
}

function editHoliday(holiday: AttendanceHoliday) {
  holidayEditingId.value = holiday.id
  holidayForm.date = holiday.date
  holidayForm.name = holiday.name ?? ''
  holidayForm.isWorkingDay = holiday.isWorkingDay
}

async function loadHolidays() {
  holidayLoading.value = true
  try {
    const query = buildQuery({
      from: fromDate.value,
      to: toDate.value,
      orgId: normalizedOrgId(),
    })
    const response = await apiFetch(`/api/attendance/holidays?${query.toString()}`)
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load holidays', '加载节假日失败')))
    }
    holidays.value = data.data.items || []
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load holidays', '加载节假日失败')), 'error')
  } finally {
    holidayLoading.value = false
  }
}

async function saveHoliday() {
  holidaySaving.value = true
  const isEditing = Boolean(holidayEditingId.value)
  try {
    if (!holidayForm.date) {
      throw new Error(tr('Holiday date is required', '节假日日期为必填项'))
    }
    const payload = {
      date: holidayForm.date,
      name: holidayForm.name.trim().length > 0 ? holidayForm.name.trim() : null,
      isWorkingDay: holidayForm.isWorkingDay,
      orgId: normalizedOrgId(),
    }
    const endpoint = isEditing
      ? `/api/attendance/holidays/${holidayEditingId.value}`
      : '/api/attendance/holidays'
    const response = await apiFetch(endpoint, {
      method: isEditing ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save holiday', '保存节假日失败')))
    }
    adminForbidden.value = false
    await loadHolidays()
    resetHolidayForm()
    setStatus(isEditing ? tr('Holiday updated.', '节假日已更新。') : tr('Holiday created.', '节假日已创建。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save holiday', '保存节假日失败')), 'error')
  } finally {
    holidaySaving.value = false
  }
}

async function deleteHoliday(id: string) {
  if (!window.confirm(tr('Delete this holiday?', '确认删除该节假日吗？'))) return
  try {
    const response = await apiFetch(`/api/attendance/holidays/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to delete holiday', '删除节假日失败')))
    }
    adminForbidden.value = false
    await loadHolidays()
    setStatus(tr('Holiday deleted.', '节假日已删除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to delete holiday', '删除节假日失败')), 'error')
  }
}

function resetRuleSetForm() {
  ruleSetEditingId.value = null
  ruleSetForm.name = ''
  ruleSetForm.description = ''
  ruleSetForm.version = 1
  ruleSetForm.scope = 'org'
  ruleSetForm.isDefault = false
  ruleSetForm.config = '{}'
}

function editRuleSet(item: AttendanceRuleSet) {
  ruleSetEditingId.value = item.id
  ruleSetForm.name = item.name
  ruleSetForm.description = item.description ?? ''
  ruleSetForm.version = item.version ?? 1
  ruleSetForm.scope = item.scope ?? 'org'
  ruleSetForm.isDefault = item.isDefault ?? false
  ruleSetForm.config = JSON.stringify(item.config ?? {}, null, 2)
}

async function loadRuleSets() {
  ruleSetLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetch(`/api/attendance/rule-sets?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load rule sets', '加载规则集失败')))
    }
    adminForbidden.value = false
    ruleSets.value = data.data?.items ?? []
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load rule sets', '加载规则集失败')), 'error')
  } finally {
    ruleSetLoading.value = false
  }
}

async function saveRuleSet() {
  ruleSetSaving.value = true
  try {
    const config = parseJsonConfig(ruleSetForm.config)
    if (!config) {
      throw new Error(tr('Rule set config must be valid JSON', '规则集配置必须是合法 JSON'))
    }

    const payload = {
      name: ruleSetForm.name.trim(),
      description: ruleSetForm.description.trim() || null,
      version: Number(ruleSetForm.version) || 1,
      scope: ruleSetForm.scope,
      isDefault: ruleSetForm.isDefault,
      config,
      orgId: normalizedOrgId(),
    }

    const response = await apiFetch(
      ruleSetEditingId.value ? `/api/attendance/rule-sets/${ruleSetEditingId.value}` : '/api/attendance/rule-sets',
      {
        method: ruleSetEditingId.value ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      }
    )
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save rule set', '保存规则集失败')))
    }
    adminForbidden.value = false
    resetRuleSetForm()
    await loadRuleSets()
    setStatus(tr('Rule set saved.', '规则集已保存。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save rule set', '保存规则集失败')), 'error')
  } finally {
    ruleSetSaving.value = false
  }
}

async function deleteRuleSet(id: string) {
  if (!window.confirm(tr('Delete this rule set?', '确认删除该规则集吗？'))) return
  try {
    const response = await apiFetch(`/api/attendance/rule-sets/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to delete rule set', '删除规则集失败')))
    }
    adminForbidden.value = false
    await loadRuleSets()
    setStatus(tr('Rule set deleted.', '规则集已删除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to delete rule set', '删除规则集失败')), 'error')
  }
}

function resetAttendanceGroupForm() {
  attendanceGroupEditingId.value = null
  attendanceGroupForm.name = ''
  attendanceGroupForm.code = ''
  attendanceGroupForm.timezone = defaultTimezone
  attendanceGroupForm.ruleSetId = ''
  attendanceGroupForm.description = ''
}

function editAttendanceGroup(item: AttendanceGroup) {
  attendanceGroupEditingId.value = item.id
  attendanceGroupForm.name = item.name
  attendanceGroupForm.code = item.code ?? ''
  attendanceGroupForm.timezone = item.timezone ?? defaultTimezone
  attendanceGroupForm.ruleSetId = item.ruleSetId ?? ''
  attendanceGroupForm.description = item.description ?? ''
}

function resolveRuleSetName(ruleSetId?: string | null): string {
  if (!ruleSetId) return tr('Default', '默认')
  return ruleSets.value.find(item => item.id === ruleSetId)?.name ?? tr('Default', '默认')
}

async function loadAttendanceGroups() {
  attendanceGroupLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetch(`/api/attendance/groups?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load attendance groups', '加载考勤分组失败')))
    }
    adminForbidden.value = false
    attendanceGroups.value = data.data?.items ?? []
    if (!attendanceGroupMemberGroupId.value && attendanceGroups.value.length > 0) {
      attendanceGroupMemberGroupId.value = attendanceGroups.value[0].id
    }
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load attendance groups', '加载考勤分组失败')), 'error')
  } finally {
    attendanceGroupLoading.value = false
  }
}

async function saveAttendanceGroup() {
  attendanceGroupSaving.value = true
  try {
    const payload = {
      name: attendanceGroupForm.name.trim(),
      code: attendanceGroupForm.code.trim() || null,
      timezone: attendanceGroupForm.timezone.trim() || defaultTimezone,
      ruleSetId: attendanceGroupForm.ruleSetId || null,
      description: attendanceGroupForm.description.trim() || null,
      orgId: normalizedOrgId(),
    }
    if (!payload.name) {
      throw new Error(tr('Attendance group name is required', '考勤分组名称为必填项'))
    }
    const response = await apiFetch(
      attendanceGroupEditingId.value
        ? `/api/attendance/groups/${attendanceGroupEditingId.value}`
        : '/api/attendance/groups',
      {
        method: attendanceGroupEditingId.value ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      }
    )
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save attendance group', '保存考勤分组失败')))
    }
    adminForbidden.value = false
    resetAttendanceGroupForm()
    await loadAttendanceGroups()
    setStatus(tr('Attendance group saved.', '考勤分组已保存。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save attendance group', '保存考勤分组失败')), 'error')
  } finally {
    attendanceGroupSaving.value = false
  }
}

async function loadAttendanceGroupMembers() {
  const groupId = attendanceGroupMemberGroupId.value
  if (!groupId) {
    attendanceGroupMembers.value = []
    return
  }
  attendanceGroupMemberLoading.value = true
  try {
    const response = await apiFetch(`/api/attendance/groups/${groupId}/members`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load group members', '加载分组成员失败')))
    }
    adminForbidden.value = false
    attendanceGroupMembers.value = data.data?.items ?? []
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load group members', '加载分组成员失败')), 'error')
  } finally {
    attendanceGroupMemberLoading.value = false
  }
}

async function addAttendanceGroupMembers() {
  const groupId = attendanceGroupMemberGroupId.value
  const userIds = parseUserIdList(attendanceGroupMemberUserIds.value)
  if (!groupId) {
    setStatus(tr('Select an attendance group first.', '请先选择考勤分组。'), 'error')
    return
  }
  if (userIds.length === 0) {
    setStatus(tr('Enter at least one user ID.', '请至少输入一个用户 ID。'), 'error')
    return
  }
  attendanceGroupMemberSaving.value = true
  try {
    const response = await apiFetch(`/api/attendance/groups/${groupId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userIds }),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to add group members', '添加分组成员失败')))
    }
    adminForbidden.value = false
    attendanceGroupMemberUserIds.value = ''
    await loadAttendanceGroupMembers()
    setStatus(tr('Group members added.', '分组成员已添加。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to add group members', '添加分组成员失败')), 'error')
  } finally {
    attendanceGroupMemberSaving.value = false
  }
}

async function removeAttendanceGroupMember(userId: string) {
  const groupId = attendanceGroupMemberGroupId.value
  if (!groupId || !userId) return
  attendanceGroupMemberSaving.value = true
  try {
    const response = await apiFetch(`/api/attendance/groups/${groupId}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    })
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to remove group member', '移除分组成员失败')))
    }
    adminForbidden.value = false
    await loadAttendanceGroupMembers()
    setStatus(tr('Group member removed.', '分组成员已移除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to remove group member', '移除分组成员失败')), 'error')
  } finally {
    attendanceGroupMemberSaving.value = false
  }
}

async function deleteAttendanceGroup(id: string) {
  if (!window.confirm(tr('Delete this attendance group?', '确认删除该考勤分组吗？'))) return
  try {
    const response = await apiFetch(`/api/attendance/groups/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to delete attendance group', '删除考勤分组失败')))
    }
    adminForbidden.value = false
    await loadAttendanceGroups()
    setStatus(tr('Attendance group deleted.', '考勤分组已删除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to delete attendance group', '删除考勤分组失败')), 'error')
  }
}

async function loadRuleSetTemplate() {
  try {
    const response = await apiFetch('/api/attendance/rule-sets/template')
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load rule set template', '加载规则集模板失败')))
    }
    ruleSetForm.config = JSON.stringify(data.data ?? {}, null, 2)
    setStatus(tr('Rule set template loaded.', '规则集模板已加载。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load rule set template', '加载规则集模板失败')), 'error')
  }
}

async function loadRuleTemplates() {
  ruleTemplateLoading.value = true
  try {
    const response = await apiFetch('/api/attendance/rule-templates')
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load rule templates', '加载规则模板失败')))
    }
    adminForbidden.value = false
    const systemTemplates = data.data?.system ?? []
    const libraryTemplates = data.data?.library ?? []
    ruleTemplateVersions.value = Array.isArray(data.data?.versions) ? data.data.versions : []
    ruleTemplateSystemText.value = JSON.stringify(systemTemplates, null, 2)
    ruleTemplateLibraryText.value = JSON.stringify(libraryTemplates, null, 2)
    setStatus(tr('Rule templates loaded.', '规则模板已加载。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load rule templates', '加载规则模板失败')), 'error')
  } finally {
    ruleTemplateLoading.value = false
  }
}

async function saveRuleTemplates() {
  ruleTemplateSaving.value = true
  try {
    const templates = parseTemplateLibrary(ruleTemplateLibraryText.value)
    if (!templates) {
      throw new Error(tr('Template library must be valid JSON array', '模板库必须是合法 JSON 数组'))
    }
    const validation = validateTemplateLibrarySchema(templates)
    if (!validation.ok) {
      const preview = validation.errors.slice(0, 3).join('; ')
      throw new Error(tr(`Template schema errors: ${preview}`, `模板结构校验失败：${preview}`))
    }
    const response = await apiFetch('/api/attendance/rule-templates', {
      method: 'PUT',
      body: JSON.stringify({ templates }),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save rule templates', '保存规则模板失败')))
    }
    adminForbidden.value = false
    ruleTemplateLibraryText.value = JSON.stringify(data.data?.templates ?? templates, null, 2)
    setStatus(tr('Rule templates saved.', '规则模板已保存。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save rule templates', '保存规则模板失败')), 'error')
  } finally {
    ruleTemplateSaving.value = false
  }
}

async function restoreRuleTemplates(versionId: string) {
  if (!versionId) return
  if (!window.confirm(tr('Restore this template version? This will overwrite the current library.', '确认恢复该模板版本吗？当前模板库会被覆盖。'))) return
  ruleTemplateRestoring.value = true
  try {
    const response = await apiFetch('/api/attendance/rule-templates/restore', {
      method: 'POST',
      body: JSON.stringify({ versionId }),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to restore rule templates', '恢复规则模板失败')))
    }
    adminForbidden.value = false
    ruleTemplateLibraryText.value = JSON.stringify(data.data?.templates ?? [], null, 2)
    await loadRuleTemplates()
    setStatus(tr('Rule templates restored.', '规则模板已恢复。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to restore rule templates', '恢复规则模板失败')), 'error')
  } finally {
    ruleTemplateRestoring.value = false
  }
}

function copySystemTemplates() {
  ruleTemplateLibraryText.value = ruleTemplateSystemText.value
  setStatus(tr('System templates copied to library.', '系统模板已复制到模板库。'))
}

function resetPayrollTemplateForm() {
  payrollTemplateEditingId.value = null
  payrollTemplateForm.name = ''
  payrollTemplateForm.timezone = defaultTimezone
  payrollTemplateForm.startDay = 1
  payrollTemplateForm.endDay = 30
  payrollTemplateForm.endMonthOffset = 0
  payrollTemplateForm.autoGenerate = true
  payrollTemplateForm.isDefault = false
  payrollTemplateForm.config = '{}'
}

function editPayrollTemplate(item: AttendancePayrollTemplate) {
  payrollTemplateEditingId.value = item.id
  payrollTemplateForm.name = item.name
  payrollTemplateForm.timezone = item.timezone
  payrollTemplateForm.startDay = item.startDay
  payrollTemplateForm.endDay = item.endDay
  payrollTemplateForm.endMonthOffset = item.endMonthOffset
  payrollTemplateForm.autoGenerate = item.autoGenerate
  payrollTemplateForm.isDefault = item.isDefault
  payrollTemplateForm.config = JSON.stringify(item.config ?? {}, null, 2)
}

async function loadPayrollTemplates() {
  payrollTemplateLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetch(`/api/attendance/payroll-templates?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load payroll templates', '加载计薪模板失败')))
    }
    adminForbidden.value = false
    payrollTemplates.value = data.data?.items ?? []
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load payroll templates', '加载计薪模板失败')), 'error')
  } finally {
    payrollTemplateLoading.value = false
  }
}

async function savePayrollTemplate() {
  payrollTemplateSaving.value = true
  try {
    const config = parseJsonConfig(payrollTemplateForm.config)
    if (!config) {
      throw new Error(tr('Payroll template config must be valid JSON', '计薪模板配置必须是合法 JSON'))
    }

    const payload = {
      name: payrollTemplateForm.name.trim(),
      timezone: payrollTemplateForm.timezone.trim() || defaultTimezone,
      startDay: Number(payrollTemplateForm.startDay) || 1,
      endDay: Number(payrollTemplateForm.endDay) || 30,
      endMonthOffset: Number(payrollTemplateForm.endMonthOffset) || 0,
      autoGenerate: payrollTemplateForm.autoGenerate,
      isDefault: payrollTemplateForm.isDefault,
      config,
      orgId: normalizedOrgId(),
    }

    const response = await apiFetch(
      payrollTemplateEditingId.value
        ? `/api/attendance/payroll-templates/${payrollTemplateEditingId.value}`
        : '/api/attendance/payroll-templates',
      {
        method: payrollTemplateEditingId.value ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      }
    )
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save payroll template', '保存计薪模板失败')))
    }
    adminForbidden.value = false
    resetPayrollTemplateForm()
    await loadPayrollTemplates()
    setStatus(tr('Payroll template saved.', '计薪模板已保存。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save payroll template', '保存计薪模板失败')), 'error')
  } finally {
    payrollTemplateSaving.value = false
  }
}

async function deletePayrollTemplate(id: string) {
  if (!window.confirm(tr('Delete this payroll template?', '确认删除该计薪模板吗？'))) return
  try {
    const response = await apiFetch(`/api/attendance/payroll-templates/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to delete payroll template', '删除计薪模板失败')))
    }
    adminForbidden.value = false
    await loadPayrollTemplates()
    setStatus(tr('Payroll template deleted.', '计薪模板已删除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to delete payroll template', '删除计薪模板失败')), 'error')
  }
}

function resetPayrollCycleForm() {
  payrollCycleEditingId.value = null
  payrollCycleForm.templateId = ''
  payrollCycleForm.name = ''
  payrollCycleForm.anchorDate = ''
  payrollCycleForm.startDate = ''
  payrollCycleForm.endDate = ''
  payrollCycleForm.status = 'open'
  payrollCycleSummary.value = null
}

function resetPayrollCycleGenerateForm() {
  payrollCycleGenerateForm.templateId = ''
  payrollCycleGenerateForm.anchorDate = toDateInput(today)
  payrollCycleGenerateForm.count = 1
  payrollCycleGenerateForm.status = 'open'
  payrollCycleGenerateForm.namePrefix = ''
  payrollCycleGenerateForm.metadata = '{}'
  payrollCycleGenerateResult.value = null
}

function editPayrollCycle(item: AttendancePayrollCycle) {
  payrollCycleEditingId.value = item.id
  payrollCycleForm.templateId = item.templateId ?? ''
  payrollCycleForm.name = item.name ?? ''
  payrollCycleForm.anchorDate = ''
  payrollCycleForm.startDate = item.startDate
  payrollCycleForm.endDate = item.endDate
  payrollCycleForm.status = item.status ?? 'open'
  payrollCycleSummary.value = null
}

async function loadPayrollCycles() {
  payrollCycleLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await apiFetch(`/api/attendance/payroll-cycles?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load payroll cycles', '加载计薪周期失败')))
    }
    adminForbidden.value = false
    payrollCycles.value = data.data?.items ?? []
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to load payroll cycles', '加载计薪周期失败')), 'error')
  } finally {
    payrollCycleLoading.value = false
  }
}

async function generatePayrollCycles() {
  payrollCycleGenerating.value = true
  try {
    const anchorDate = payrollCycleGenerateForm.anchorDate
    if (!anchorDate) {
      throw new Error(tr('Anchor date is required for generation', '生成周期需要锚点日期'))
    }

    const metadata = parseJsonConfig(payrollCycleGenerateForm.metadata)
    if (!metadata) {
      throw new Error(tr('Metadata must be valid JSON', '元数据必须是合法 JSON'))
    }

    const payload: Record<string, any> = {
      templateId: payrollCycleGenerateForm.templateId || undefined,
      anchorDate,
      count: payrollCycleGenerateForm.count,
      status: payrollCycleGenerateForm.status,
      namePrefix: payrollCycleGenerateForm.namePrefix.trim() || undefined,
      metadata,
      orgId: normalizedOrgId(),
    }

    const response = await apiFetch('/api/attendance/payroll-cycles/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to generate payroll cycles', '生成计薪周期失败')))
    }

    const created = Array.isArray(data.data?.created) ? data.data.created.length : 0
    const skipped = Array.isArray(data.data?.skipped) ? data.data.skipped.length : 0
    payrollCycleGenerateResult.value = { created, skipped }
    adminForbidden.value = false
    await loadPayrollCycles()
    setStatus(appendStatusContext(
      tr('Payroll cycles generated.', '计薪周期已生成。'),
      payrollCycleGenerateTimezoneHint.value,
    ))
  } catch (error: any) {
    setStatus(
      appendStatusContext(
        readErrorMessage(error, tr('Failed to generate payroll cycles', '生成计薪周期失败')),
        payrollCycleGenerateTimezoneHint.value,
      ),
      'error',
    )
  } finally {
    payrollCycleGenerating.value = false
  }
}

async function savePayrollCycle() {
  payrollCycleSaving.value = true
  try {
    const payload: Record<string, any> = {
      templateId: payrollCycleForm.templateId || undefined,
      name: payrollCycleForm.name.trim() || undefined,
      anchorDate: payrollCycleForm.anchorDate || undefined,
      startDate: payrollCycleForm.startDate || undefined,
      endDate: payrollCycleForm.endDate || undefined,
      status: payrollCycleForm.status,
      orgId: normalizedOrgId(),
    }

    const response = await apiFetch(
      payrollCycleEditingId.value
        ? `/api/attendance/payroll-cycles/${payrollCycleEditingId.value}`
        : '/api/attendance/payroll-cycles',
      {
        method: payrollCycleEditingId.value ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      }
    )
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to save payroll cycle', '保存计薪周期失败')))
    }
    adminForbidden.value = false
    resetPayrollCycleForm()
    await loadPayrollCycles()
    setStatus(tr('Payroll cycle saved.', '计薪周期已保存。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to save payroll cycle', '保存计薪周期失败')), 'error')
  } finally {
    payrollCycleSaving.value = false
  }
}

async function deletePayrollCycle(id: string) {
  if (!window.confirm(tr('Delete this payroll cycle?', '确认删除该计薪周期吗？'))) return
  try {
    const response = await apiFetch(`/api/attendance/payroll-cycles/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to delete payroll cycle', '删除计薪周期失败')))
    }
    adminForbidden.value = false
    await loadPayrollCycles()
    payrollCycleSummary.value = null
    setStatus(tr('Payroll cycle deleted.', '计薪周期已删除。'))
  } catch (error: any) {
    setStatus(readErrorMessage(error, tr('Failed to delete payroll cycle', '删除计薪周期失败')), 'error')
  }
}

async function loadPayrollCycleSummary() {
  const cycleId = payrollCycleEditingId.value
  if (!cycleId) {
    setStatus(tr('Select or create a payroll cycle first.', '请先选择或创建计薪周期。'), 'error')
    return
  }
  try {
    const query = buildQuery({ orgId: normalizedOrgId(), userId: normalizedUserId() })
    const response = await apiFetch(`/api/attendance/payroll-cycles/${cycleId}/summary?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(readErrorMessage(data, tr('Failed to load payroll summary', '加载计薪汇总失败')))
    }
    payrollCycleSummary.value = data.data?.summary ?? null
    setStatus(appendStatusContext(
      tr('Payroll summary loaded.', '计薪汇总已加载。'),
      payrollCycleTemplateTimezoneHint.value,
    ))
  } catch (error: any) {
    setStatus(
      appendStatusContext(
        readErrorMessage(error, tr('Failed to load payroll summary', '加载计薪汇总失败')),
        payrollCycleTemplateTimezoneHint.value,
      ),
      'error',
    )
  }
}

async function exportPayrollCycleSummary() {
  const cycleId = payrollCycleEditingId.value
  if (!cycleId) {
    setStatus(tr('Select or create a payroll cycle first.', '请先选择或创建计薪周期。'), 'error')
    return
  }
  try {
    const query = buildQuery({ orgId: normalizedOrgId(), userId: normalizedUserId() })
    const response = await apiFetch(`/api/attendance/payroll-cycles/${cycleId}/summary/export?${query.toString()}`)
    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || tr('Failed to export payroll summary', '导出计薪汇总失败'))
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `payroll-cycle-${cycleId}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setStatus(appendStatusContext(
      tr('Payroll summary exported.', '计薪汇总已导出。'),
      payrollCycleTemplateTimezoneHint.value,
    ))
  } catch (error: any) {
    setStatus(
      appendStatusContext(
        readErrorMessage(error, tr('Failed to export payroll summary', '导出计薪汇总失败')),
        payrollCycleTemplateTimezoneHint.value,
      ),
      'error',
    )
  }
}

async function loadAdminData() {
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
      loadImportBatches(),
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

watch(importProfileId, () => {
  const profile = selectedImportProfile.value
  if (!profile) return
  if (!importUserMapKeyField.value && profile.userMapKeyField) {
    importUserMapKeyField.value = profile.userMapKeyField
  }
  if (!importUserMapSourceFields.value && profile.userMapSourceFields?.length) {
    importUserMapSourceFields.value = profile.userMapSourceFields.join(', ')
  }
})

watch(importMode, () => {
  syncImportModeToPayload()
})

watch([provisionBatchUserIdsText, provisionBatchRole], () => {
  clearProvisionBatchPreview()
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

.attendance__calendar-flags {
  display: flex;
  align-items: center;
  gap: 10px;
}

.attendance__calendar-flag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #4b5563;
  font-size: 12px;
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

.attendance__chip-list {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attendance__chip-list .attendance__status-chip {
  margin-left: 0;
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

.attendance__empty-state {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__snapshot-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__admin-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.attendance__admin-shell {
  display: grid;
  grid-template-columns: minmax(220px, 250px) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

.attendance__admin-content {
  min-width: 0;
}

[data-admin-section] {
  scroll-margin-top: 96px;
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

  .attendance__calendar-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .attendance__calendar-nav,
  .attendance__calendar-flags {
    flex-wrap: wrap;
  }

  .attendance__admin-shell {
    grid-template-columns: 1fr;
  }

  .attendance__request-meta {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
