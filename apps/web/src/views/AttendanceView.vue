<template>
  <div class="attendance">
    <div v-if="pluginLoading" class="attendance__card attendance__card--empty">
      <h3>Checking attendance module...</h3>
      <p class="attendance__empty">Loading plugin status.</p>
    </div>
    <div v-else-if="pluginMissing" class="attendance__card attendance__card--empty">
      <h3>Attendance module not enabled</h3>
      <p class="attendance__empty" v-if="pluginFailed">Attendance plugin failed to load. Check server logs.</p>
      <p class="attendance__empty" v-else-if="pluginErrorMessage">{{ pluginErrorMessage }}</p>
      <p class="attendance__empty" v-else>Enable the attendance plugin to use this page.</p>
    </div>
    <template v-else>
      <header class="attendance__header" v-if="showOverview">
        <div>
          <h2 class="attendance__title">Attendance</h2>
          <p class="attendance__subtitle">Track punches, summaries, and adjustments.</p>
        </div>
        <div class="attendance__actions">
          <button class="attendance__btn attendance__btn--primary" :disabled="punching" @click="punch('check_in')">
            {{ punching ? 'Working...' : 'Check In' }}
          </button>
          <button class="attendance__btn" :disabled="punching" @click="punch('check_out')">
            {{ punching ? 'Working...' : 'Check Out' }}
          </button>
        </div>
      </header>

      <section class="attendance__filters" v-if="showOverview">
        <label class="attendance__field" for="attendance-from-date">
          <span>From</span>
          <input id="attendance-from-date" name="fromDate" v-model="fromDate" type="date" />
        </label>
        <label class="attendance__field" for="attendance-to-date">
          <span>To</span>
          <input id="attendance-to-date" name="toDate" v-model="toDate" type="date" />
        </label>
        <label class="attendance__field" for="attendance-org-id">
          <span>Org ID</span>
          <input id="attendance-org-id" name="orgId" v-model="orgId" type="text" placeholder="default" />
        </label>
        <label class="attendance__field" for="attendance-user-id">
          <span>User ID (optional)</span>
          <input
            id="attendance-user-id"
            name="targetUserId"
            v-model="targetUserId"
            type="text"
            placeholder="Current user"
          />
        </label>
        <button class="attendance__btn" :disabled="loading" @click="refreshAll">Refresh</button>
        <div v-if="statusMessage" class="attendance__status-block">
          <span class="attendance__status" :class="{ 'attendance__status--error': statusKind === 'error' }">
            {{ statusMessage }}
          </span>
          <span v-if="statusCode" class="attendance__field-hint attendance__field-hint--error">
            Code: {{ statusCode }}
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
            {{ statusActionBusy ? 'Working...' : statusActionLabel }}
          </button>
        </div>
      </section>

      <section class="attendance__grid" v-if="showOverview">
        <div class="attendance__card">
          <h3>Summary</h3>
          <div v-if="summary" class="attendance__summary">
            <div class="attendance__summary-item">
              <span>Total days</span>
              <strong>{{ summary.total_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Total minutes</span>
              <strong>{{ summary.total_minutes }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Late minutes</span>
              <strong>{{ summary.total_late_minutes ?? 0 }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Early leave minutes</span>
              <strong>{{ summary.total_early_leave_minutes ?? 0 }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Leave minutes</span>
              <strong>{{ summary.leave_minutes ?? 0 }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Overtime minutes</span>
              <strong>{{ summary.overtime_minutes ?? 0 }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Normal</span>
              <strong>{{ summary.normal_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Late</span>
              <strong>{{ summary.late_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Early leave</span>
              <strong>{{ summary.early_leave_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Late + Early</span>
              <strong>{{ summary.late_early_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Partial</span>
              <strong>{{ summary.partial_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Absent</span>
              <strong>{{ summary.absent_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Adjusted</span>
              <strong>{{ summary.adjusted_days }}</strong>
            </div>
            <div class="attendance__summary-item">
              <span>Off</span>
              <strong>{{ summary.off_days }}</strong>
            </div>
          </div>
          <div v-else class="attendance__empty">No summary yet.</div>
        </div>

        <div class="attendance__card attendance__card--calendar">
          <div class="attendance__calendar-header">
            <h3>Calendar</h3>
            <div class="attendance__calendar-nav">
              <button class="attendance__btn" @click="shiftMonth(-1)">Prev</button>
              <span class="attendance__calendar-label">{{ calendarLabel }}</span>
              <button class="attendance__btn" @click="shiftMonth(1)">Next</button>
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
            </div>
          </div>
        </div>

        <div class="attendance__card">
          <h3>Adjustment Request</h3>
          <div class="attendance__request-form">
            <label class="attendance__field" for="attendance-request-work-date">
              <span>Work date</span>
              <input
                id="attendance-request-work-date"
                name="requestWorkDate"
                v-model="requestForm.workDate"
                type="date"
              />
            </label>
            <label class="attendance__field" for="attendance-request-type">
              <span>Type</span>
              <select id="attendance-request-type" name="requestType" v-model="requestForm.requestType">
                <option value="missed_check_in">Missed check-in</option>
                <option value="missed_check_out">Missed check-out</option>
                <option value="time_correction">Time correction</option>
                <option value="leave">Leave</option>
                <option value="overtime">Overtime</option>
              </select>
            </label>
            <label v-if="isLeaveRequest" class="attendance__field" for="attendance-request-leave-type">
              <span>Leave type</span>
              <select
                id="attendance-request-leave-type"
                name="requestLeaveType"
                v-model="requestForm.leaveTypeId"
                :disabled="leaveTypes.length === 0"
              >
                <option value="" disabled>Select leave type</option>
                <option v-for="item in leaveTypes" :key="item.id" :value="item.id">
                  {{ item.name }}
                </option>
              </select>
            </label>
            <label v-if="isOvertimeRequest" class="attendance__field" for="attendance-request-overtime-rule">
              <span>Overtime rule</span>
              <select
                id="attendance-request-overtime-rule"
                name="requestOvertimeRule"
                v-model="requestForm.overtimeRuleId"
                :disabled="overtimeRules.length === 0"
              >
                <option value="" disabled>Select rule</option>
                <option v-for="rule in overtimeRules" :key="rule.id" :value="rule.id">
                  {{ rule.name }}
                </option>
              </select>
            </label>
            <label class="attendance__field" for="attendance-request-in">
              <span>{{ isLeaveOrOvertimeRequest ? 'Start' : 'Requested in' }}</span>
              <input
                id="attendance-request-in"
                name="requestedInAt"
                v-model="requestForm.requestedInAt"
                type="datetime-local"
              />
            </label>
            <label class="attendance__field" for="attendance-request-out">
              <span>{{ isLeaveOrOvertimeRequest ? 'End' : 'Requested out' }}</span>
              <input
                id="attendance-request-out"
                name="requestedOutAt"
                v-model="requestForm.requestedOutAt"
                type="datetime-local"
              />
            </label>
            <label v-if="isLeaveOrOvertimeRequest" class="attendance__field" for="attendance-request-minutes">
              <span>Duration (min)</span>
              <input
                id="attendance-request-minutes"
                name="requestMinutes"
                v-model="requestForm.minutes"
                type="number"
                min="0"
              />
            </label>
            <label v-if="isLeaveRequest" class="attendance__field" for="attendance-request-attachment">
              <span>Attachment URL</span>
              <input
                id="attendance-request-attachment"
                name="requestAttachment"
                v-model="requestForm.attachmentUrl"
                type="text"
                placeholder="Optional"
              />
            </label>
            <label class="attendance__field attendance__field--full" for="attendance-request-reason">
              <span>Reason</span>
              <input
                id="attendance-request-reason"
                name="requestReason"
                v-model="requestForm.reason"
                type="text"
                placeholder="Optional"
              />
            </label>
            <button class="attendance__btn attendance__btn--primary" :disabled="requestSubmitting" @click="submitRequest">
              {{ requestSubmitting ? 'Submitting...' : 'Submit request' }}
            </button>
          </div>

          <div class="attendance__requests">
            <div class="attendance__requests-header">
              <span>Recent requests</span>
              <button class="attendance__btn" :disabled="loading" @click="loadRequests">Reload</button>
            </div>
            <div v-if="requests.length === 0" class="attendance__empty">No requests.</div>
            <ul v-else class="attendance__request-list">
              <li v-for="item in requests" :key="item.id" class="attendance__request-item">
                <div>
                  <strong>{{ item.work_date }}</strong> · {{ formatRequestType(item.request_type) }}
                  <span class="attendance__status-chip" :class="`attendance__status-chip--${item.status}`">
                    {{ item.status }}
                  </span>
                </div>
                <div class="attendance__request-meta" v-if="item.metadata">
                  <span v-if="item.metadata.leaveType">Leave: {{ item.metadata.leaveType.name }}</span>
                  <span v-if="item.metadata.overtimeRule">Overtime: {{ item.metadata.overtimeRule.name }}</span>
                  <span v-if="item.metadata.minutes">Minutes: {{ item.metadata.minutes }}</span>
                </div>
                <div class="attendance__request-meta">
                  <span>In: {{ formatDateTime(item.requested_in_at) }}</span>
                  <span>Out: {{ formatDateTime(item.requested_out_at) }}</span>
                </div>
                <div class="attendance__request-actions" v-if="item.status === 'pending'">
                  <button class="attendance__btn" @click="cancelRequest(item.id)">Cancel</button>
                  <button class="attendance__btn" @click="resolveRequest(item.id, 'approve')">Approve</button>
                  <button class="attendance__btn attendance__btn--danger" @click="resolveRequest(item.id, 'reject')">Reject</button>
                </div>
              </li>
            </ul>
          </div>
        </div>

        <div class="attendance__card">
          <div class="attendance__requests-header">
            <h3>Anomalies</h3>
            <button class="attendance__btn" :disabled="anomaliesLoading || loading" @click="loadAnomalies">
              {{ anomaliesLoading ? 'Loading...' : 'Reload anomalies' }}
            </button>
          </div>
          <div v-if="anomaliesLoading" class="attendance__empty">Loading anomalies...</div>
          <div v-else-if="anomalies.length === 0" class="attendance__empty">No anomalies.</div>
          <div v-else class="attendance__table-wrapper">
            <table class="attendance__table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Warnings</th>
                  <th>Request</th>
                  <th>Action</th>
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
                        {{ item.request.status }}
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
                      {{ item.state === 'pending' ? 'Pending request' : 'Create request' }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="attendance__card">
          <div class="attendance__requests-header">
            <h3>Request Report</h3>
            <button class="attendance__btn" :disabled="reportLoading" @click="loadRequestReport">
              {{ reportLoading ? 'Loading...' : 'Reload report' }}
            </button>
          </div>
          <div v-if="requestReport.length === 0" class="attendance__empty">No report data.</div>
          <div v-else class="attendance__table-wrapper">
            <table class="attendance__table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Total</th>
                  <th>Minutes</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in requestReport" :key="`${row.requestType}-${row.status}`">
                  <td>{{ formatRequestType(row.requestType) }}</td>
                  <td>{{ row.status }}</td>
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
          <h3>Records</h3>
          <div class="attendance__records-actions">
            <button class="attendance__btn" :disabled="loading" @click="loadRecords">Reload</button>
            <button class="attendance__btn" :disabled="exporting || loading" @click="exportCsv">
              {{ exporting ? 'Exporting...' : 'Export CSV' }}
            </button>
          </div>
        </div>
        <div v-if="records.length === 0" class="attendance__empty">No records.</div>
        <table v-else class="attendance__table">
          <thead>
            <tr>
              <th>Date</th>
              <th>First in</th>
              <th>Last out</th>
              <th>Work (min)</th>
              <th>Late</th>
              <th>Early leave</th>
              <th>Leave</th>
              <th>Overtime</th>
              <th>Status</th>
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
        <div class="attendance__pagination">
          <button class="attendance__btn" :disabled="recordsPage <= 1 || loading" @click="changeRecordsPage(-1)">
            Prev
          </button>
          <span>Page {{ recordsPage }} / {{ recordsTotalPages }}</span>
          <button class="attendance__btn" :disabled="recordsPage >= recordsTotalPages || loading" @click="changeRecordsPage(1)">
            Next
          </button>
        </div>
      </section>

      <section class="attendance__grid" v-if="showAdmin">
        <div class="attendance__card attendance__card--admin">
          <div class="attendance__admin-header">
            <h3>Admin Console</h3>
            <button class="attendance__btn" :disabled="settingsLoading || ruleLoading" @click="loadAdminData">
              {{ settingsLoading || ruleLoading ? 'Loading...' : 'Reload admin' }}
            </button>
          </div>
          <div v-if="statusMessage" class="attendance__status-block attendance__status-block--admin">
            <span class="attendance__status" :class="{ 'attendance__status--error': statusKind === 'error' }">
              {{ statusMessage }}
            </span>
            <span v-if="statusCode" class="attendance__field-hint attendance__field-hint--error">
              Code: {{ statusCode }}
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
              {{ statusActionBusy ? 'Working...' : statusActionLabel }}
            </button>
          </div>
          <div v-if="adminForbidden" class="attendance__empty">Admin permissions required to manage attendance settings.</div>
          <div v-else>
            <div class="attendance__admin-section">
              <h4>Settings</h4>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--checkbox" for="attendance-auto-absence-enabled">
                  <span>Auto absence</span>
                  <input
                    id="attendance-auto-absence-enabled"
                    name="autoAbsenceEnabled"
                    v-model="settingsForm.autoAbsenceEnabled"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field" for="attendance-auto-absence-run-at">
                  <span>Run at</span>
                  <input
                    id="attendance-auto-absence-run-at"
                    name="autoAbsenceRunAt"
                    v-model="settingsForm.autoAbsenceRunAt"
                    type="time"
                  />
                </label>
                <label class="attendance__field" for="attendance-auto-absence-lookback">
                  <span>Lookback days</span>
                  <input
                    id="attendance-auto-absence-lookback"
                    name="autoAbsenceLookbackDays"
                    v-model.number="settingsForm.autoAbsenceLookbackDays"
                    type="number"
                    min="1"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-first-day-enabled">
                  <span>Holiday first-day base hours</span>
                  <input
                    id="attendance-holiday-first-day-enabled"
                    name="holidayFirstDayEnabled"
                    v-model="settingsForm.holidayFirstDayEnabled"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-first-day-hours">
                  <span>First-day base hours</span>
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
                  <span>Overtime adds on holiday</span>
                  <input
                    id="attendance-holiday-overtime-adds"
                    name="holidayOvertimeAdds"
                    v-model="settingsForm.holidayOvertimeAdds"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-overtime-source">
                  <span>Overtime source</span>
                  <select
                    id="attendance-holiday-overtime-source"
                    name="holidayOvertimeSource"
                    v-model="settingsForm.holidayOvertimeSource"
                  >
                    <option value="approval">Approval</option>
                    <option value="clock">Clock</option>
                    <option value="both">Both</option>
                  </select>
                </label>
                <div class="attendance__field attendance__field--full">
                  <div class="attendance__admin-subsection">
                    <div class="attendance__admin-subsection-header">
                      <h5>Holiday overrides</h5>
                      <button class="attendance__btn" type="button" @click="addHolidayOverride">
                        Add override
                      </button>
                    </div>
                    <div v-if="settingsForm.holidayOverrides.length === 0" class="attendance__empty">
                      No overrides configured.
                    </div>
                    <div v-else class="attendance__table-wrapper">
                      <table class="attendance__table">
                        <thead>
                          <tr>
                            <th>Holiday name</th>
                            <th>Match</th>
                            <th>First-day hours</th>
                            <th>Enable</th>
                            <th>Overtime adds</th>
                            <th>Overtime source</th>
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
                                  <option value="contains">Contains</option>
                                  <option value="equals">Equals</option>
                                  <option value="regex">Regex</option>
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
                                  <option value="approval">Approval</option>
                                  <option value="clock">Clock</option>
                                  <option value="both">Both</option>
                                </select>
                              </td>
                              <td>
                                <button class="attendance__btn attendance__btn--danger" type="button" @click="removeHolidayOverride(index)">
                                  Remove
                                </button>
                              </td>
                            </tr>
                            <tr class="attendance__table-row--meta">
                              <td colspan="7">
                                <div class="attendance__override-filters">
                                  <label class="attendance__override-field">
                                    <span>Attendance groups</span>
                                    <input v-model="override.attendanceGroups" type="text" placeholder="单休办公,白班" />
                                    <small v-if="attendanceGroupOptions.length" class="attendance__field-hint">
                                      Known groups: {{ attendanceGroupOptions.join(', ') }}
                                    </small>
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>Roles</span>
                                    <input v-model="override.roles" type="text" placeholder="司机,工段长" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>Role tags</span>
                                    <input v-model="override.roleTags" type="text" placeholder="车间,仓储" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>User IDs</span>
                                    <input v-model="override.userIds" type="text" placeholder="uuid1,uuid2" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>User names</span>
                                    <input v-model="override.userNames" type="text" placeholder="张三,李四" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>Exclude user IDs</span>
                                    <input v-model="override.excludeUserIds" type="text" placeholder="uuid3" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>Exclude user names</span>
                                    <input v-model="override.excludeUserNames" type="text" placeholder="王五" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>Day index start</span>
                                    <input v-model.number="override.dayIndexStart" type="number" min="1" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>Day index end</span>
                                    <input v-model.number="override.dayIndexEnd" type="number" min="1" />
                                  </label>
                                  <label class="attendance__override-field">
                                    <span>Day index list</span>
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
                  <span>Min punch interval (min)</span>
                  <input
                    id="attendance-min-punch-interval"
                    name="minPunchIntervalMinutes"
                    v-model.number="settingsForm.minPunchIntervalMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-ip-allowlist">
                  <span>IP allowlist</span>
                  <textarea
                    id="attendance-ip-allowlist"
                    name="ipAllowlist"
                    v-model="settingsForm.ipAllowlist"
                    rows="3"
                    placeholder="One per line or comma separated"
                  ></textarea>
                </label>
                <label class="attendance__field" for="attendance-geo-lat">
                  <span>Geo fence lat</span>
                  <input
                    id="attendance-geo-lat"
                    name="geoFenceLat"
                    v-model="settingsForm.geoFenceLat"
                    type="number"
                    step="0.000001"
                  />
                </label>
                <label class="attendance__field" for="attendance-geo-lng">
                  <span>Geo fence lng</span>
                  <input
                    id="attendance-geo-lng"
                    name="geoFenceLng"
                    v-model="settingsForm.geoFenceLng"
                    type="number"
                    step="0.000001"
                  />
                </label>
                <label class="attendance__field" for="attendance-geo-radius">
                  <span>Geo fence radius (m)</span>
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
                {{ settingsLoading ? 'Saving...' : 'Save settings' }}
              </button>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>User Access</h4>
                <div class="attendance__admin-actions">
                  <button class="attendance__btn" :disabled="provisionLoading" @click="loadProvisioningUser">
                    {{ provisionLoading ? 'Loading...' : 'Load' }}
                  </button>
                  <button class="attendance__btn attendance__btn--primary" :disabled="provisionLoading" @click="grantProvisioningRole">
                    {{ provisionLoading ? 'Working...' : 'Assign role' }}
                  </button>
                  <button class="attendance__btn" :disabled="provisionLoading" @click="revokeProvisioningRole">
                    {{ provisionLoading ? 'Working...' : 'Remove role' }}
                  </button>
                </div>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--full" for="attendance-provision-search">
                  <span>User search (email/name/id)</span>
                  <input
                    id="attendance-provision-search"
                    v-model="provisionSearchQuery"
                    type="text"
                    placeholder="Search users to avoid pasting UUIDs"
                    @keydown.enter.prevent="searchProvisionUsers(1)"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn" :disabled="provisionSearchLoading" @click="searchProvisionUsers(1)">
                  {{ provisionSearchLoading ? 'Searching...' : 'Search' }}
                </button>
                <button
                  class="attendance__btn"
                  :disabled="provisionSearchLoading || provisionSearchPage <= 1"
                  @click="searchProvisionUsers(provisionSearchPage - 1)"
                >
                  Prev
                </button>
                <button
                  class="attendance__btn"
                  :disabled="provisionSearchLoading || !provisionSearchHasNext"
                  @click="searchProvisionUsers(provisionSearchPage + 1)"
                >
                  Next
                </button>
                <span v-if="provisionSearchHasSearched" class="attendance__field-hint">
                  Page {{ provisionSearchPage }} · {{ provisionSearchTotal }} result(s)
                </span>
              </div>
              <div v-if="provisionSearchResults.length > 0" class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Name</th>
                      <th>User ID</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="user in provisionSearchResults" :key="user.id">
                      <td>{{ user.email }}</td>
                      <td>{{ user.name || '--' }}</td>
                      <td><code>{{ user.id.slice(0, 8) }}</code></td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="selectProvisionUser(user)">Select</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else-if="provisionSearchHasSearched" class="attendance__empty">No users found.</p>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--full" for="attendance-provision-user-id">
                  <span>User ID (UUID)</span>
                  <input
                    id="attendance-provision-user-id"
                    name="provisionUserId"
                    v-model="provisionForm.userId"
                    type="text"
                    placeholder="e.g. 0cdf4a9c-4fe1-471b-be08-854b683dc930"
                  />
                  <small v-if="provisionUserProfile" class="attendance__field-hint">
                    Selected: {{ provisionUserProfile.email }}{{ provisionUserProfile.name ? ` (${provisionUserProfile.name})` : '' }}
                  </small>
                </label>
                <label class="attendance__field" for="attendance-provision-role">
                  <span>Role template</span>
                  <select
                    id="attendance-provision-role"
                    name="provisionRole"
                    v-model="provisionForm.role"
                  >
                    <option value="employee">employee</option>
                    <option value="approver">approver</option>
                    <option value="admin">admin</option>
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
              <p v-else-if="provisionHasLoaded" class="attendance__empty">No permissions loaded.</p>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Batch Provisioning</h4>
                <div class="attendance__admin-actions">
                  <button
                    class="attendance__btn"
                    :disabled="provisionBatchLoading || provisionBatchPreviewLoading"
                    @click="previewProvisionBatchUsers"
                  >
                    {{ provisionBatchPreviewLoading ? 'Previewing...' : 'Preview users' }}
                  </button>
                  <button
                    class="attendance__btn attendance__btn--primary"
                    :disabled="provisionBatchLoading"
                    @click="grantProvisioningRoleBatch"
                  >
                    {{ provisionBatchLoading ? 'Working...' : 'Assign role (batch)' }}
                  </button>
                  <button
                    class="attendance__btn"
                    :disabled="provisionBatchLoading"
                    @click="revokeProvisioningRoleBatch"
                  >
                    {{ provisionBatchLoading ? 'Working...' : 'Remove role (batch)' }}
                  </button>
                  <button class="attendance__btn" :disabled="provisionBatchLoading" @click="clearProvisionBatch">
                    Clear
                  </button>
                </div>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--full" for="attendance-provision-batch-user-ids">
                  <span>User IDs (UUIDs)</span>
                  <textarea
                    id="attendance-provision-batch-user-ids"
                    v-model="provisionBatchUserIdsText"
                    rows="4"
                    placeholder="uuid1\nuuid2\n..."
                  />
                  <small class="attendance__field-hint">
                    Parsed: {{ provisionBatchIds.length }} user(s)
                    <template v-if="provisionBatchInvalidIds.length">
                      · Invalid: {{ provisionBatchInvalidIds.length }}
                    </template>
                  </small>
                </label>
                <label class="attendance__field" for="attendance-provision-batch-role">
                  <span>Role template</span>
                  <select
                    id="attendance-provision-batch-role"
                    name="provisionBatchRole"
                    v-model="provisionBatchRole"
                  >
                    <option value="employee">employee</option>
                    <option value="approver">approver</option>
                    <option value="admin">admin</option>
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
                Preview: {{ provisionBatchPreviewItems.length }}/{{ provisionBatchPreviewRequested }} found
                · Missing {{ provisionBatchPreviewMissingIds.length }}
                · Inactive {{ provisionBatchPreviewInactiveIds.length }}
              </p>
              <div v-if="provisionBatchPreviewItems.length > 0" class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Name</th>
                      <th>User ID</th>
                      <th>Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in provisionBatchPreviewItems" :key="item.id">
                      <td>{{ item.email }}</td>
                      <td>{{ item.name || '--' }}</td>
                      <td><code>{{ item.id.slice(0, 8) }}</code></td>
                      <td>{{ item.is_active ? 'yes' : 'no' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-if="provisionBatchPreviewMissingIds.length > 0" class="attendance__field-hint">
                Missing user IDs:
                <code>{{ provisionBatchPreviewMissingIds.slice(0, 6).join(', ') }}</code>
                <template v-if="provisionBatchPreviewMissingIds.length > 6"> ...</template>
              </p>
              <p v-if="provisionBatchAffectedIds.length > 0" class="attendance__field-hint">
                Affected user IDs:
                <code>{{ provisionBatchAffectedIds.slice(0, 6).join(', ') }}</code>
                <template v-if="provisionBatchAffectedIds.length > 6"> ...</template>
              </p>
              <p v-if="provisionBatchUnchangedIds.length > 0" class="attendance__field-hint">
                Unchanged user IDs:
                <code>{{ provisionBatchUnchangedIds.slice(0, 6).join(', ') }}</code>
                <template v-if="provisionBatchUnchangedIds.length > 6"> ...</template>
              </p>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Audit Logs</h4>
                <div class="attendance__admin-actions">
                  <button class="attendance__btn" :disabled="auditLogLoading || auditSummaryLoading" @click="reloadAuditLogs">
                    {{ auditLogLoading ? 'Loading...' : 'Reload logs' }}
                  </button>
                  <button class="attendance__btn" :disabled="auditLogExporting" @click="exportAuditLogsCsv">
                    {{ auditLogExporting ? 'Exporting...' : 'Export CSV' }}
                  </button>
                </div>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--full" for="attendance-audit-search">
                  <span>Search (action/actor/resource/route)</span>
                  <input
                    id="attendance-audit-search"
                    v-model="auditLogQuery"
                    type="text"
                    placeholder="commit, export.csv, userId..."
                    @keydown.enter.prevent="loadAuditLogs(1)"
                  />
                </label>
                <label class="attendance__field" for="attendance-audit-action-prefix">
                  <span>Action prefix</span>
                  <input
                    id="attendance-audit-action-prefix"
                    v-model="auditLogActionPrefix"
                    type="text"
                    placeholder="attendance_http:POST:/api/attendance-admin"
                    @keydown.enter.prevent="loadAuditLogs(1)"
                  />
                </label>
                <label class="attendance__field" for="attendance-audit-status-class">
                  <span>Status class</span>
                  <select
                    id="attendance-audit-status-class"
                    v-model="auditLogStatusClass"
                  >
                    <option value="">All</option>
                    <option value="2xx">2xx</option>
                    <option value="3xx">3xx</option>
                    <option value="4xx">4xx</option>
                    <option value="5xx">5xx</option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-audit-error-code">
                  <span>Error code</span>
                  <input
                    id="attendance-audit-error-code"
                    v-model="auditLogErrorCode"
                    type="text"
                    placeholder="RATE_LIMITED"
                    @keydown.enter.prevent="loadAuditLogs(1)"
                  />
                </label>
                <label class="attendance__field" for="attendance-audit-from">
                  <span>From</span>
                  <input
                    id="attendance-audit-from"
                    v-model="auditLogFrom"
                    type="datetime-local"
                  />
                </label>
                <label class="attendance__field" for="attendance-audit-to">
                  <span>To</span>
                  <input
                    id="attendance-audit-to"
                    v-model="auditLogTo"
                    type="datetime-local"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn" :disabled="auditLogLoading || auditLogPage <= 1" @click="loadAuditLogs(auditLogPage - 1)">
                  Prev
                </button>
                <button
                  class="attendance__btn"
                  :disabled="auditLogLoading || auditLogPage >= auditLogTotalPages"
                  @click="loadAuditLogs(auditLogPage + 1)"
                >
                  Next
                </button>
                <span v-if="auditLogTotal" class="attendance__field-hint">
                  Page {{ auditLogPage }} / {{ auditLogTotalPages }} · {{ auditLogTotal }} row(s)
                </span>
              </div>
              <div class="attendance__admin-grid">
                <div class="attendance__field attendance__field--full">
                  <div class="attendance__requests-header">
                    <span>Audit summary (last 60m)</span>
                    <button class="attendance__btn" :disabled="auditSummaryLoading" @click="loadAuditSummary">
                      {{ auditSummaryLoading ? 'Loading...' : 'Reload summary' }}
                    </button>
                  </div>
                  <div class="attendance__table-wrapper" v-if="auditSummaryActions.length || auditSummaryErrors.length">
                    <table class="attendance__table">
                      <thead>
                        <tr>
                          <th>Top actions</th>
                          <th>Count</th>
                          <th>Top error codes</th>
                          <th>Count</th>
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
                  <div v-else class="attendance__empty">No summary data.</div>
                </div>
              </div>
              <p
                v-if="auditLogStatusMessage"
                class="attendance__status"
                :class="{ 'attendance__status--error': auditLogStatusKind === 'error' }"
              >
                {{ auditLogStatusMessage }}
              </p>
              <div v-if="auditLogs.length === 0" class="attendance__empty">No audit logs.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Route</th>
                      <th>Status</th>
                      <th>Latency</th>
                      <th>Error</th>
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
                            {{ auditLogSelectedId === item.id ? 'Hide' : 'View' }}
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

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Holiday Sync</h4>
                <div class="attendance__admin-actions">
                  <button class="attendance__btn" :disabled="holidaySyncLoading" @click="syncHolidays">
                    {{ holidaySyncLoading ? 'Syncing...' : 'Sync now' }}
                  </button>
                  <button
                    class="attendance__btn"
                    :disabled="holidaySyncLoading"
                    @click="syncHolidaysForYears([new Date().getFullYear()])"
                  >
                    Sync current year
                  </button>
                  <button
                    class="attendance__btn"
                    :disabled="holidaySyncLoading"
                    @click="syncHolidaysForYears([new Date().getFullYear() + 1])"
                  >
                    Sync next year
                  </button>
                </div>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--full" for="attendance-holiday-sync-base-url">
                  <span>Holiday source URL</span>
                  <input
                    id="attendance-holiday-sync-base-url"
                    name="holidaySyncBaseUrl"
                    v-model="settingsForm.holidaySyncBaseUrl"
                    type="text"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-holiday-sync-years">
                  <span>Years (comma separated)</span>
                  <input
                    id="attendance-holiday-sync-years"
                    name="holidaySyncYears"
                    v-model="settingsForm.holidaySyncYears"
                    type="text"
                    placeholder="2025,2026"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-sync-auto">
                  <span>Auto sync (daily)</span>
                  <input
                    id="attendance-holiday-sync-auto"
                    name="holidaySyncAutoEnabled"
                    v-model="settingsForm.holidaySyncAutoEnabled"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-sync-auto-run">
                  <span>Auto sync time</span>
                  <input
                    id="attendance-holiday-sync-auto-run"
                    name="holidaySyncAutoRunAt"
                    v-model="settingsForm.holidaySyncAutoRunAt"
                    type="time"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-sync-auto-tz">
                  <span>Auto sync timezone</span>
                  <input
                    id="attendance-holiday-sync-auto-tz"
                    name="holidaySyncAutoTimezone"
                    v-model="settingsForm.holidaySyncAutoTimezone"
                    type="text"
                    placeholder="Asia/Shanghai"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-sync-index">
                  <span>Append day index</span>
                  <input
                    id="attendance-holiday-sync-index"
                    name="holidaySyncAddDayIndex"
                    v-model="settingsForm.holidaySyncAddDayIndex"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-holiday-sync-index-holidays">
                  <span>Index holidays</span>
                  <input
                    id="attendance-holiday-sync-index-holidays"
                    name="holidaySyncDayIndexHolidays"
                    v-model="settingsForm.holidaySyncDayIndexHolidays"
                    type="text"
                    placeholder="春节,国庆"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-sync-index-max">
                  <span>Max index days</span>
                  <input
                    id="attendance-holiday-sync-index-max"
                    name="holidaySyncDayIndexMaxDays"
                    v-model.number="settingsForm.holidaySyncDayIndexMaxDays"
                    type="number"
                    min="1"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-sync-index-format">
                  <span>Index format</span>
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
                  <span>Overwrite existing</span>
                  <input
                    id="attendance-holiday-sync-overwrite"
                    name="holidaySyncOverwrite"
                    v-model="settingsForm.holidaySyncOverwrite"
                    type="checkbox"
                  />
                </label>
              </div>
              <div class="attendance__admin-meta">
                <strong>Last sync</strong>
                <span v-if="holidaySyncLastRun?.ranAt">
                  {{ new Date(holidaySyncLastRun.ranAt).toLocaleString() }}
                  · {{ holidaySyncLastRun.success ? 'success' : 'failed' }}
                  · {{ holidaySyncLastRun.totalApplied ?? 0 }} applied / {{ holidaySyncLastRun.totalFetched ?? 0 }} fetched
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

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Default Rule</h4>
                <button class="attendance__btn" :disabled="ruleLoading" @click="loadRule">
                  {{ ruleLoading ? 'Loading...' : 'Reload rule' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-rule-name">
                  <span>Name</span>
                  <input id="attendance-rule-name" name="ruleName" v-model="ruleForm.name" type="text" />
                </label>
                <label class="attendance__field" for="attendance-rule-timezone">
                  <span>Timezone</span>
                  <input
                    id="attendance-rule-timezone"
                    name="ruleTimezone"
                    v-model="ruleForm.timezone"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-rule-start">
                  <span>Work start</span>
                  <input
                    id="attendance-rule-start"
                    name="ruleWorkStartTime"
                    v-model="ruleForm.workStartTime"
                    type="time"
                  />
                </label>
                <label class="attendance__field" for="attendance-rule-end">
                  <span>Work end</span>
                  <input
                    id="attendance-rule-end"
                    name="ruleWorkEndTime"
                    v-model="ruleForm.workEndTime"
                    type="time"
                  />
                </label>
                <label class="attendance__field" for="attendance-rule-late-grace">
                  <span>Late grace (min)</span>
                  <input
                    id="attendance-rule-late-grace"
                    name="ruleLateGraceMinutes"
                    v-model.number="ruleForm.lateGraceMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field" for="attendance-rule-early-grace">
                  <span>Early grace (min)</span>
                  <input
                    id="attendance-rule-early-grace"
                    name="ruleEarlyGraceMinutes"
                    v-model.number="ruleForm.earlyGraceMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field" for="attendance-rule-rounding">
                  <span>Rounding (min)</span>
                  <input
                    id="attendance-rule-rounding"
                    name="ruleRoundingMinutes"
                    v-model.number="ruleForm.roundingMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-rule-working-days">
                  <span>Working days (0-6)</span>
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
                {{ ruleLoading ? 'Saving...' : 'Save rule' }}
              </button>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Rule Sets</h4>
                <button class="attendance__btn" :disabled="ruleSetLoading" @click="loadRuleSets">
                  {{ ruleSetLoading ? 'Loading...' : 'Reload rule sets' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-rule-set-name">
                  <span>Name</span>
                  <input id="attendance-rule-set-name" name="ruleSetName" v-model="ruleSetForm.name" type="text" />
                </label>
                <label class="attendance__field" for="attendance-rule-set-scope">
                  <span>Scope</span>
                  <select id="attendance-rule-set-scope" name="ruleSetScope" v-model="ruleSetForm.scope">
                    <option value="org">Org</option>
                    <option value="department">Department</option>
                    <option value="project">Project</option>
                    <option value="user">User</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-rule-set-version">
                  <span>Version</span>
                  <input
                    id="attendance-rule-set-version"
                    name="ruleSetVersion"
                    v-model.number="ruleSetForm.version"
                    type="number"
                    min="1"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-rule-set-default">
                  <span>Default</span>
                  <input
                    id="attendance-rule-set-default"
                    name="ruleSetDefault"
                    v-model="ruleSetForm.isDefault"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-rule-set-description">
                  <span>Description</span>
                  <input
                    id="attendance-rule-set-description"
                    name="ruleSetDescription"
                    v-model="ruleSetForm.description"
                    type="text"
                    placeholder="Optional"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-rule-set-config">
                  <span>Config (JSON)</span>
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
                  {{ ruleSetSaving ? 'Saving...' : ruleSetEditingId ? 'Update rule set' : 'Create rule set' }}
                </button>
                <button class="attendance__btn" :disabled="ruleSetSaving" @click="loadRuleSetTemplate">
                  Load template
                </button>
                <button
                  v-if="ruleSetEditingId"
                  class="attendance__btn"
                  :disabled="ruleSetSaving"
                  @click="resetRuleSetForm"
                >
                  Cancel edit
                </button>
              </div>
              <div v-if="ruleSets.length === 0" class="attendance__empty">No rule sets yet.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Scope</th>
                      <th>Version</th>
                      <th>Default</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in ruleSets" :key="item.id">
                      <td>{{ item.name }}</td>
                      <td>{{ item.scope }}</td>
                      <td>{{ item.version }}</td>
                      <td>{{ item.isDefault ? 'Yes' : 'No' }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editRuleSet(item)">Edit</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteRuleSet(item.id)">
                          Delete
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Rule Template Library</h4>
                <button
                  class="attendance__btn"
                  :disabled="ruleTemplateLoading || ruleTemplateSaving || ruleTemplateRestoring"
                  @click="loadRuleTemplates"
                >
                  {{ ruleTemplateLoading ? 'Loading...' : 'Reload templates' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field attendance__field--full" for="attendance-rule-template-system">
                  <span>System templates (read-only)</span>
                  <textarea
                    id="attendance-rule-template-system"
                    name="ruleTemplateSystem"
                    v-model="ruleTemplateSystemText"
                    rows="6"
                    readonly
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-rule-template-library">
                  <span>Library templates (JSON)</span>
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
                  Copy system to library
                </button>
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="ruleTemplateSaving || ruleTemplateRestoring"
                  @click="saveRuleTemplates"
                >
                  {{ ruleTemplateSaving ? 'Saving...' : 'Save library' }}
                </button>
              </div>
              <div class="attendance__admin-subsection">
                <div class="attendance__admin-section-header">
                  <h5>Template Versions</h5>
                </div>
                <div v-if="ruleTemplateVersions.length === 0" class="attendance__empty">No versions yet.</div>
                <div v-else class="attendance__table-wrapper">
                  <table class="attendance__table">
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th>Items</th>
                        <th>Created</th>
                        <th>Created by</th>
                        <th>Actions</th>
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
                            Restore
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Attendance groups</h4>
                <button class="attendance__btn" :disabled="attendanceGroupLoading" @click="loadAttendanceGroups">
                  {{ attendanceGroupLoading ? 'Loading...' : 'Reload groups' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-group-name">
                  <span>Name</span>
                  <input id="attendance-group-name" v-model="attendanceGroupForm.name" type="text" />
                </label>
                <label class="attendance__field" for="attendance-group-code">
                  <span>Code</span>
                  <input id="attendance-group-code" v-model="attendanceGroupForm.code" type="text" placeholder="optional" />
                </label>
                <label class="attendance__field" for="attendance-group-timezone">
                  <span>Timezone</span>
                  <input id="attendance-group-timezone" v-model="attendanceGroupForm.timezone" type="text" />
                </label>
                <label class="attendance__field" for="attendance-group-rule-set">
                  <span>Rule set</span>
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
                  <span>Description</span>
                  <input id="attendance-group-description" v-model="attendanceGroupForm.description" type="text" />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="attendanceGroupSaving"
                  @click="saveAttendanceGroup"
                >
                  {{ attendanceGroupSaving ? 'Saving...' : attendanceGroupEditingId ? 'Update group' : 'Create group' }}
                </button>
                <button class="attendance__btn" :disabled="attendanceGroupSaving" @click="resetAttendanceGroupForm">
                  Reset
                </button>
              </div>
              <div v-if="attendanceGroups.length === 0" class="attendance__empty">No attendance groups.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Code</th>
                      <th>Timezone</th>
                      <th>Rule set</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in attendanceGroups" :key="item.id">
                      <td>{{ item.name }}</td>
                      <td>{{ item.code || '-' }}</td>
                      <td>{{ item.timezone }}</td>
                      <td>{{ resolveRuleSetName(item.ruleSetId) }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editAttendanceGroup(item)">Edit</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteAttendanceGroup(item.id)">
                          Delete
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Group members</h4>
                <button
                  class="attendance__btn"
                  :disabled="attendanceGroupMemberLoading"
                  @click="loadAttendanceGroupMembers"
                >
                  {{ attendanceGroupMemberLoading ? 'Loading...' : 'Reload members' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-group-member-group">
                  <span>Group</span>
                  <select
                    id="attendance-group-member-group"
                    v-model="attendanceGroupMemberGroupId"
                    :disabled="attendanceGroups.length === 0"
                  >
                    <option value="">Select a group</option>
                    <option v-for="group in attendanceGroups" :key="group.id" :value="group.id">
                      {{ group.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-group-member-user-ids">
                  <span>User IDs</span>
                  <input
                    id="attendance-group-member-user-ids"
                    v-model="attendanceGroupMemberUserIds"
                    type="text"
                    placeholder="userId1, userId2"
                  />
                  <small class="attendance__field-hint">Separate multiple IDs with commas or spaces.</small>
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="attendanceGroupMemberSaving"
                  @click="addAttendanceGroupMembers"
                >
                  {{ attendanceGroupMemberSaving ? 'Saving...' : 'Add members' }}
                </button>
              </div>
              <div v-if="attendanceGroupMembers.length === 0" class="attendance__empty">No group members yet.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>User ID</th>
                      <th>Joined</th>
                      <th>Actions</th>
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
                          Remove
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Import (DingTalk / Manual)</h4>
                <button class="attendance__btn" :disabled="importLoading" @click="loadImportTemplate">
                  {{ importLoading ? 'Loading...' : 'Load template' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-import-rule-set">
                  <span>Rule set</span>
                  <select
                    id="attendance-import-rule-set"
                    name="importRuleSetId"
                    v-model="importForm.ruleSetId"
                    :disabled="ruleSets.length === 0"
                  >
                    <option value="">(Optional) Use default rule</option>
                    <option v-for="item in ruleSets" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-import-mode">
                  <span>Import mode</span>
                  <select id="attendance-import-mode" v-model="importMode">
                    <option value="override">override</option>
                    <option value="merge">merge</option>
                  </select>
                  <small class="attendance__field-hint">
                    <code>override</code>: overwrite same user/date. <code>merge</code>: keep existing fields when present.
                  </small>
                </label>
                <label class="attendance__field" for="attendance-import-profile">
                  <span>Mapping profile</span>
                  <select
                    id="attendance-import-profile"
                    v-model="importProfileId"
                    :disabled="importMappingProfiles.length === 0"
                  >
                    <option value="">(Optional) Select profile</option>
                    <option v-for="profile in importMappingProfiles" :key="profile.id" :value="profile.id">
                      {{ profile.name }}
                    </option>
                  </select>
                  <small v-if="selectedImportProfile?.description" class="attendance__field-hint">
                    {{ selectedImportProfile.description }}
                  </small>
                  <small v-if="selectedImportProfile?.requiredFields?.length" class="attendance__field-hint">
                    Required fields: {{ selectedImportProfile.requiredFields.join(', ') }}
                  </small>
                </label>
                <label class="attendance__field" for="attendance-import-csv">
                  <span>CSV file (optional)</span>
                  <input
                    id="attendance-import-csv"
                    type="file"
                    accept=".csv,text/csv"
                    @change="handleImportCsvChange"
                  />
                  <small v-if="importCsvFileName" class="attendance__field-hint">Selected: {{ importCsvFileName }}</small>
                </label>
                <label class="attendance__field" for="attendance-import-csv-header">
                  <span>CSV header row</span>
                  <input
                    id="attendance-import-csv-header"
                    v-model="importCsvHeaderRow"
                    type="number"
                    min="0"
                    placeholder="Auto-detect"
                  />
                </label>
                <label class="attendance__field" for="attendance-import-csv-delimiter">
                  <span>CSV delimiter</span>
                  <input
                    id="attendance-import-csv-delimiter"
                    v-model="importCsvDelimiter"
                    type="text"
                    maxlength="2"
                    placeholder=","
                  />
                </label>
                <label class="attendance__field" for="attendance-import-user-map">
                  <span>User map JSON (optional)</span>
                  <input
                    id="attendance-import-user-map"
                    type="file"
                    accept=".json,application/json"
                    @change="handleImportUserMapChange"
                  />
                  <small v-if="importUserMapFileName" class="attendance__field-hint">
                    Selected: {{ importUserMapFileName }} · {{ importUserMapCount }} entries
                  </small>
                  <small v-if="importUserMapError" class="attendance__field-hint attendance__field-hint--error">
                    {{ importUserMapError }}
                  </small>
                </label>
                <label class="attendance__field" for="attendance-import-user-map-key">
                  <span>User map key field</span>
                  <input
                    id="attendance-import-user-map-key"
                    v-model="importUserMapKeyField"
                    type="text"
                    placeholder="工号"
                  />
                  <small v-if="selectedImportProfile?.userMapKeyField" class="attendance__field-hint">
                    Default: {{ selectedImportProfile.userMapKeyField }}
                  </small>
                </label>
                <label class="attendance__field" for="attendance-import-user-map-source">
                  <span>User map source fields</span>
                  <input
                    id="attendance-import-user-map-source"
                    v-model="importUserMapSourceFields"
                    type="text"
                    placeholder="empNo,工号,姓名"
                  />
                  <small v-if="selectedImportProfile?.userMapSourceFields?.length" class="attendance__field-hint">
                    Default: {{ selectedImportProfile.userMapSourceFields.join(', ') }}
                  </small>
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-import-group-create">
                  <span>Auto-create groups</span>
                  <input id="attendance-import-group-create" v-model="importGroupAutoCreate" type="checkbox" />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-import-group-assign">
                  <span>Auto-assign group members</span>
                  <input id="attendance-import-group-assign" v-model="importGroupAutoAssign" type="checkbox" />
                </label>
                <label class="attendance__field" for="attendance-import-group-rule-set">
                  <span>Group rule set</span>
                  <select
                    id="attendance-import-group-rule-set"
                    v-model="importGroupRuleSetId"
                    :disabled="ruleSets.length === 0"
                  >
                    <option value="">(Optional) Use import rule set</option>
                    <option v-for="item in ruleSets" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-import-group-timezone">
                  <span>Group timezone (optional)</span>
                  <input
                    id="attendance-import-group-timezone"
                    v-model="importGroupTimezone"
                    type="text"
                    placeholder="Asia/Shanghai"
                  />
                </label>
                <label class="attendance__field" for="attendance-import-user">
                  <span>User ID</span>
                  <input
                    id="attendance-import-user"
                    name="importUserId"
                    v-model="importForm.userId"
                    type="text"
                    placeholder="Required if not in payload"
                  />
                </label>
                <label class="attendance__field" for="attendance-import-timezone">
                  <span>Timezone</span>
                  <input
                    id="attendance-import-timezone"
                    name="importTimezone"
                    v-model="importForm.timezone"
                    type="text"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-import-payload">
                  <span>Payload (JSON)</span>
                  <textarea
                    id="attendance-import-payload"
                    name="importPayload"
                    v-model="importForm.payload"
                    rows="6"
                    placeholder='{\"source\":\"dingtalk\",\"userId\":\"...\",\"columns\":[],\"data\":{}}'
                  />
                  <small class="attendance__field-hint">
                    Default import mode is <strong>override</strong> (same user/date will be overwritten). Use
                    <code>mode: \"merge\"</code> in payload if needed.
                  </small>
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn" :disabled="importLoading" @click="applyImportCsvFile">
                  Load CSV
                </button>
                <button class="attendance__btn" :disabled="importLoading" @click="applyImportProfile">
                  Apply profile
                </button>
                <button class="attendance__btn" :disabled="importLoading" @click="previewImport">
                  {{ importLoading ? 'Working...' : 'Preview' }}
                </button>
                <button class="attendance__btn attendance__btn--primary" :disabled="importLoading" @click="runImport">
                  {{ importLoading ? 'Importing...' : 'Import' }}
                </button>
              </div>
              <div
                v-if="importPreviewTask"
                class="attendance__status"
                :class="{ 'attendance__status--error': importPreviewTask.status === 'failed' }"
              >
                <div class="attendance__requests-header">
                  <span>{{ importPreviewTask.mode === 'chunked' ? 'Chunked preview task' : 'Preview task' }}</span>
                  <button class="attendance__btn" type="button" @click="clearImportPreviewTask">
                    Clear
                  </button>
                </div>
                <div>
                  Status: <strong>{{ importPreviewTask.status }}</strong>
                  <template v-if="importPreviewTask.mode === 'chunked'">
                    · Chunks {{ importPreviewTask.completedChunks }} / {{ importPreviewTask.totalChunks }}
                  </template>
                </div>
                <div v-if="importPreviewTask.totalRows">
                  Progress: {{ importPreviewTask.processedRows }} / {{ importPreviewTask.totalRows }}
                </div>
                <div v-if="importPreviewTask.message">{{ importPreviewTask.message }}</div>
              </div>
              <div
                v-if="importAsyncJob"
                class="attendance__status"
                :class="{ 'attendance__status--error': importAsyncJob.status === 'failed' }"
              >
                <div class="attendance__requests-header">
                  <span>{{ importAsyncJob.kind === 'preview' ? 'Async preview job' : 'Async import job' }}</span>
                  <div class="attendance__table-actions">
                    <button
                      class="attendance__btn"
                      type="button"
                      :disabled="importAsyncPolling"
                      @click="refreshImportAsyncJob()"
                    >
                      Reload job
                    </button>
                    <button
                      v-if="importAsyncJob.status === 'queued' || importAsyncJob.status === 'running'"
                      class="attendance__btn"
                      type="button"
                      :disabled="importAsyncPolling"
                      @click="resumeImportAsyncJobPolling"
                    >
                      {{ importAsyncPolling ? 'Polling...' : 'Resume polling' }}
                    </button>
                    <button class="attendance__btn" type="button" @click="clearImportAsyncJob">
                      Clear
                    </button>
                  </div>
                </div>
                <div>
                  Status: <strong>{{ importAsyncJob.status }}</strong>
                  <span v-if="importAsyncPolling"> · polling...</span>
                </div>
                <div v-if="importAsyncJob.total">
                  Progress: {{ importAsyncJob.progress }} / {{ importAsyncJob.total }}
                  <span v-if="typeof importAsyncJob.progressPercent === 'number'">
                    ({{ importAsyncJob.progressPercent }}%)
                  </span>
                </div>
                <div v-if="typeof importAsyncJob.processedRows === 'number' || typeof importAsyncJob.failedRows === 'number'">
                  Processed: {{ importAsyncJob.processedRows ?? 0 }} · Failed: {{ importAsyncJob.failedRows ?? 0 }}
                </div>
                <div v-if="typeof importAsyncJob.elapsedMs === 'number' || typeof importAsyncJob.throughputRowsPerSec === 'number'">
                  Elapsed: {{ importAsyncJob.elapsedMs ?? 0 }} ms
                  <span v-if="typeof importAsyncJob.throughputRowsPerSec === 'number'">
                    · Throughput: {{ importAsyncJob.throughputRowsPerSec }} rows/s
                  </span>
                </div>
                <div v-if="importAsyncJob.kind !== 'preview' && importAsyncJob.batchId">Batch: {{ importAsyncJob.batchId }}</div>
                <div v-if="importAsyncJob.kind === 'preview' && importAsyncJob.preview?.rowCount">
                  Preview rows: {{ importAsyncJob.preview?.total ?? 0 }} / {{ importAsyncJob.preview?.rowCount }}
                </div>
                <div v-if="importAsyncJob.error">Error: {{ importAsyncJob.error }}</div>
              </div>
              <div v-if="importCsvWarnings.length" class="attendance__status attendance__status--error">
                CSV warnings: {{ importCsvWarnings.join('; ') }}
              </div>
              <div v-if="importPreview.length === 0" class="attendance__empty">No preview data.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Work date</th>
                      <th>User ID</th>
                      <th>Work minutes</th>
                      <th>Late</th>
                      <th>Early leave</th>
                      <th>Status</th>
                      <th>Warnings</th>
                      <th>Policies</th>
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

              <div class="attendance__admin-section-header">
                <h4>Import batches</h4>
                <button class="attendance__btn" :disabled="importLoading" @click="loadImportBatches">
                  {{ importLoading ? 'Loading...' : 'Reload batches' }}
                </button>
              </div>
              <div v-if="importBatches.length === 0" class="attendance__empty">No import batches.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Batch</th>
                      <th>Status</th>
                      <th>Rows</th>
                      <th>Engine</th>
                      <th>Chunk</th>
                      <th>Source</th>
                      <th>Rule set</th>
                      <th>Created</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="batch in importBatches" :key="batch.id">
                      <td>{{ batch.id.slice(0, 8) }}</td>
                      <td>{{ batch.status }}</td>
                      <td>{{ batch.rowCount }}</td>
                      <td>{{ resolveImportBatchEngine(batch) }}</td>
                      <td>{{ resolveImportBatchChunkLabel(batch) }}</td>
                      <td>{{ batch.source || '--' }}</td>
                      <td>{{ resolveRuleSetName(batch.ruleSetId) }}</td>
                      <td>{{ formatDateTime(batch.createdAt ?? null) }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="loadImportBatchItems(batch.id)">View items</button>
                        <button
                          class="attendance__btn attendance__btn--danger"
                          :disabled="importLoading"
                          @click="rollbackImportBatch(batch.id)"
                        >
                          Rollback
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div v-if="importBatchItems.length > 0" class="attendance__table-wrapper">
                <div class="attendance__subheading-row">
                  <h5 class="attendance__subheading">Batch items</h5>
                  <div class="attendance__table-actions">
                    <button class="attendance__btn" :disabled="importLoading" @click="exportImportBatchItemsCsv(false)">
                      Export items CSV
                    </button>
                    <button class="attendance__btn" :disabled="importLoading" @click="exportImportBatchItemsCsv(true)">
                      Export anomalies CSV
                    </button>
                  </div>
                </div>
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Work date</th>
                      <th>User ID</th>
                      <th>Record</th>
                      <th>Snapshot</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in importBatchItems" :key="item.id">
                      <td>{{ item.workDate }}</td>
                      <td>{{ item.userId }}</td>
                      <td>{{ item.recordId || '--' }}</td>
                      <td>
                        <button class="attendance__btn" @click="toggleImportBatchSnapshot(item)">
                          {{ importBatchSnapshot === item.previewSnapshot ? 'Hide' : 'View' }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <pre v-if="importBatchSnapshot" class="attendance__code">{{ formatJson(importBatchSnapshot) }}</pre>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Payroll Templates</h4>
                <button class="attendance__btn" :disabled="payrollTemplateLoading" @click="loadPayrollTemplates">
                  {{ payrollTemplateLoading ? 'Loading...' : 'Reload templates' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-payroll-template-name">
                  <span>Name</span>
                  <input
                    id="attendance-payroll-template-name"
                    name="payrollTemplateName"
                    v-model="payrollTemplateForm.name"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-template-timezone">
                  <span>Timezone</span>
                  <input
                    id="attendance-payroll-template-timezone"
                    name="payrollTemplateTimezone"
                    v-model="payrollTemplateForm.timezone"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-template-start">
                  <span>Start day</span>
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
                  <span>End day</span>
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
                  <span>End month offset</span>
                  <select
                    id="attendance-payroll-template-offset"
                    name="payrollTemplateOffset"
                    v-model.number="payrollTemplateForm.endMonthOffset"
                  >
                    <option :value="0">Same month</option>
                    <option :value="1">Next month</option>
                  </select>
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-payroll-template-auto">
                  <span>Auto generate</span>
                  <input
                    id="attendance-payroll-template-auto"
                    name="payrollTemplateAuto"
                    v-model="payrollTemplateForm.autoGenerate"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-payroll-template-default">
                  <span>Default</span>
                  <input
                    id="attendance-payroll-template-default"
                    name="payrollTemplateDefault"
                    v-model="payrollTemplateForm.isDefault"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-payroll-template-config">
                  <span>Config (JSON)</span>
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
                  {{ payrollTemplateSaving ? 'Saving...' : payrollTemplateEditingId ? 'Update template' : 'Create template' }}
                </button>
                <button
                  v-if="payrollTemplateEditingId"
                  class="attendance__btn"
                  :disabled="payrollTemplateSaving"
                  @click="resetPayrollTemplateForm"
                >
                  Cancel edit
                </button>
              </div>
              <div v-if="payrollTemplates.length === 0" class="attendance__empty">No payroll templates yet.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Timezone</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Offset</th>
                      <th>Default</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in payrollTemplates" :key="item.id">
                      <td>{{ item.name }}</td>
                      <td>{{ item.timezone }}</td>
                      <td>{{ item.startDay }}</td>
                      <td>{{ item.endDay }}</td>
                      <td>{{ item.endMonthOffset }}</td>
                      <td>{{ item.isDefault ? 'Yes' : 'No' }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editPayrollTemplate(item)">Edit</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deletePayrollTemplate(item.id)">
                          Delete
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Payroll Cycles</h4>
                <button class="attendance__btn" :disabled="payrollCycleLoading" @click="loadPayrollCycles">
                  {{ payrollCycleLoading ? 'Loading...' : 'Reload cycles' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-payroll-cycle-template">
                  <span>Template</span>
                  <select
                    id="attendance-payroll-cycle-template"
                    name="payrollCycleTemplate"
                    v-model="payrollCycleForm.templateId"
                    :disabled="payrollTemplates.length === 0"
                  >
                    <option value="">Manual</option>
                    <option v-for="item in payrollTemplates" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-payroll-cycle-name">
                  <span>Name</span>
                  <input
                    id="attendance-payroll-cycle-name"
                    name="payrollCycleName"
                    v-model="payrollCycleForm.name"
                    type="text"
                    placeholder="Optional"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-cycle-anchor">
                  <span>Anchor date</span>
                  <input
                    id="attendance-payroll-cycle-anchor"
                    name="payrollCycleAnchor"
                    v-model="payrollCycleForm.anchorDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-cycle-start">
                  <span>Start date</span>
                  <input
                    id="attendance-payroll-cycle-start"
                    name="payrollCycleStartDate"
                    v-model="payrollCycleForm.startDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-cycle-end">
                  <span>End date</span>
                  <input
                    id="attendance-payroll-cycle-end"
                    name="payrollCycleEndDate"
                    v-model="payrollCycleForm.endDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-cycle-status">
                  <span>Status</span>
                  <select
                    id="attendance-payroll-cycle-status"
                    name="payrollCycleStatus"
                    v-model="payrollCycleForm.status"
                  >
                    <option value="open">Open</option>
                    <option value="closed">Closed</option>
                    <option value="archived">Archived</option>
                  </select>
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button
                  class="attendance__btn attendance__btn--primary"
                  :disabled="payrollCycleSaving"
                  @click="savePayrollCycle"
                >
                  {{ payrollCycleSaving ? 'Saving...' : payrollCycleEditingId ? 'Update cycle' : 'Create cycle' }}
                </button>
                <button class="attendance__btn" :disabled="payrollCycleSaving" @click="loadPayrollCycleSummary">
                  Load summary
                </button>
                <button class="attendance__btn" :disabled="payrollCycleSaving" @click="exportPayrollCycleSummary">
                  Export CSV
                </button>
                <button
                  v-if="payrollCycleEditingId"
                  class="attendance__btn"
                  :disabled="payrollCycleSaving"
                  @click="resetPayrollCycleForm"
                >
                  Cancel edit
                </button>
              </div>

              <details class="attendance__details">
                <summary class="attendance__details-summary">Batch generate cycles</summary>
                <div class="attendance__admin-grid attendance__admin-grid--compact">
                  <label class="attendance__field" for="attendance-payroll-cycle-gen-template">
                    <span>Template</span>
                    <select
                      id="attendance-payroll-cycle-gen-template"
                      name="payrollCycleGenTemplate"
                      v-model="payrollCycleGenerateForm.templateId"
                      :disabled="payrollTemplates.length === 0"
                    >
                      <option value="">Default template</option>
                      <option v-for="item in payrollTemplates" :key="item.id" :value="item.id">
                        {{ item.name }}
                      </option>
                    </select>
                  </label>
                  <label class="attendance__field" for="attendance-payroll-cycle-gen-anchor">
                    <span>Anchor date</span>
                    <input
                      id="attendance-payroll-cycle-gen-anchor"
                      name="payrollCycleGenAnchor"
                      v-model="payrollCycleGenerateForm.anchorDate"
                      type="date"
                    />
                  </label>
                  <label class="attendance__field" for="attendance-payroll-cycle-gen-count">
                    <span>Count</span>
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
                    <span>Status</span>
                    <select
                      id="attendance-payroll-cycle-gen-status"
                      name="payrollCycleGenStatus"
                      v-model="payrollCycleGenerateForm.status"
                    >
                      <option value="open">Open</option>
                      <option value="closed">Closed</option>
                      <option value="archived">Archived</option>
                    </select>
                  </label>
                  <label class="attendance__field" for="attendance-payroll-cycle-gen-prefix">
                    <span>Name prefix</span>
                    <input
                      id="attendance-payroll-cycle-gen-prefix"
                      name="payrollCycleGenPrefix"
                      v-model="payrollCycleGenerateForm.namePrefix"
                      type="text"
                      placeholder="Optional"
                    />
                  </label>
                  <label class="attendance__field attendance__field--full" for="attendance-payroll-cycle-gen-metadata">
                    <span>Metadata (JSON)</span>
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
                    {{ payrollCycleGenerating ? 'Generating...' : 'Generate cycles' }}
                  </button>
                  <button class="attendance__btn" :disabled="payrollCycleGenerating" @click="resetPayrollCycleGenerateForm">
                    Reset
                  </button>
                  <span v-if="payrollCycleGenerateResult" class="attendance__empty">
                    Created {{ payrollCycleGenerateResult.created }}, skipped {{ payrollCycleGenerateResult.skipped }}.
                  </span>
                </div>
              </details>
              <div v-if="payrollCycleSummary" class="attendance__summary">
                <div class="attendance__summary-item">
                  <span>Cycle total minutes</span>
                  <strong>{{ payrollCycleSummary.total_minutes }}</strong>
                </div>
                <div class="attendance__summary-item">
                  <span>Leave minutes</span>
                  <strong>{{ payrollCycleSummary.leave_minutes ?? 0 }}</strong>
                </div>
                <div class="attendance__summary-item">
                  <span>Overtime minutes</span>
                  <strong>{{ payrollCycleSummary.overtime_minutes ?? 0 }}</strong>
                </div>
                <div class="attendance__summary-item">
                  <span>Late minutes</span>
                  <strong>{{ payrollCycleSummary.total_late_minutes ?? 0 }}</strong>
                </div>
                <div class="attendance__summary-item">
                  <span>Early leave minutes</span>
                  <strong>{{ payrollCycleSummary.total_early_leave_minutes ?? 0 }}</strong>
                </div>
              </div>
              <div v-if="payrollCycles.length === 0" class="attendance__empty">No payroll cycles yet.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Template</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in payrollCycles" :key="item.id">
                      <td>{{ item.name || '--' }}</td>
                      <td>{{ payrollTemplateName(item.templateId) }}</td>
                      <td>{{ item.startDate }}</td>
                      <td>{{ item.endDate }}</td>
                      <td>{{ item.status }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editPayrollCycle(item)">Edit</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deletePayrollCycle(item.id)">
                          Delete
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Leave Types</h4>
                <button class="attendance__btn" :disabled="leaveTypeLoading" @click="loadLeaveTypes">
                  {{ leaveTypeLoading ? 'Loading...' : 'Reload leave types' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-leave-code">
                  <span>Code</span>
                  <input id="attendance-leave-code" name="leaveCode" v-model="leaveTypeForm.code" type="text" />
                </label>
                <label class="attendance__field" for="attendance-leave-name">
                  <span>Name</span>
                  <input id="attendance-leave-name" name="leaveName" v-model="leaveTypeForm.name" type="text" />
                </label>
                <label class="attendance__field" for="attendance-leave-minutes">
                  <span>Minutes / day</span>
                  <input
                    id="attendance-leave-minutes"
                    name="leaveMinutes"
                    v-model.number="leaveTypeForm.defaultMinutesPerDay"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-leave-approval">
                  <span>Requires approval</span>
                  <input
                    id="attendance-leave-approval"
                    name="leaveRequiresApproval"
                    v-model="leaveTypeForm.requiresApproval"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-leave-attachment">
                  <span>Requires attachment</span>
                  <input
                    id="attendance-leave-attachment"
                    name="leaveRequiresAttachment"
                    v-model="leaveTypeForm.requiresAttachment"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-leave-active">
                  <span>Active</span>
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
                  {{ leaveTypeSaving ? 'Saving...' : leaveTypeEditingId ? 'Update leave type' : 'Create leave type' }}
                </button>
                <button
                  v-if="leaveTypeEditingId"
                  class="attendance__btn"
                  :disabled="leaveTypeSaving"
                  @click="resetLeaveTypeForm"
                >
                  Cancel edit
                </button>
              </div>
              <div v-if="leaveTypes.length === 0" class="attendance__empty">No leave types yet.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Name</th>
                      <th>Approval</th>
                      <th>Attachment</th>
                      <th>Minutes</th>
                      <th>Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in leaveTypes" :key="item.id">
                      <td>{{ item.code }}</td>
                      <td>{{ item.name }}</td>
                      <td>{{ item.requiresApproval ? 'Yes' : 'No' }}</td>
                      <td>{{ item.requiresAttachment ? 'Yes' : 'No' }}</td>
                      <td>{{ item.defaultMinutesPerDay }}</td>
                      <td>{{ item.isActive ? 'Yes' : 'No' }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editLeaveType(item)">Edit</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteLeaveType(item.id)">
                          Delete
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Overtime Rules</h4>
                <button class="attendance__btn" :disabled="overtimeRuleLoading" @click="loadOvertimeRules">
                  {{ overtimeRuleLoading ? 'Loading...' : 'Reload overtime rules' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-overtime-name">
                  <span>Name</span>
                  <input id="attendance-overtime-name" name="overtimeName" v-model="overtimeRuleForm.name" type="text" />
                </label>
                <label class="attendance__field" for="attendance-overtime-min">
                  <span>Min minutes</span>
                  <input
                    id="attendance-overtime-min"
                    name="overtimeMinMinutes"
                    v-model.number="overtimeRuleForm.minMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field" for="attendance-overtime-rounding">
                  <span>Rounding</span>
                  <input
                    id="attendance-overtime-rounding"
                    name="overtimeRounding"
                    v-model.number="overtimeRuleForm.roundingMinutes"
                    type="number"
                    min="1"
                  />
                </label>
                <label class="attendance__field" for="attendance-overtime-max">
                  <span>Max / day</span>
                  <input
                    id="attendance-overtime-max"
                    name="overtimeMax"
                    v-model.number="overtimeRuleForm.maxMinutesPerDay"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-overtime-approval">
                  <span>Requires approval</span>
                  <input
                    id="attendance-overtime-approval"
                    name="overtimeRequiresApproval"
                    v-model="overtimeRuleForm.requiresApproval"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-overtime-active">
                  <span>Active</span>
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
                  {{ overtimeRuleSaving ? 'Saving...' : overtimeRuleEditingId ? 'Update rule' : 'Create rule' }}
                </button>
                <button
                  v-if="overtimeRuleEditingId"
                  class="attendance__btn"
                  :disabled="overtimeRuleSaving"
                  @click="resetOvertimeRuleForm"
                >
                  Cancel edit
                </button>
              </div>
              <div v-if="overtimeRules.length === 0" class="attendance__empty">No overtime rules yet.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Min</th>
                      <th>Rounding</th>
                      <th>Max</th>
                      <th>Approval</th>
                      <th>Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="rule in overtimeRules" :key="rule.id">
                      <td>{{ rule.name }}</td>
                      <td>{{ rule.minMinutes }}</td>
                      <td>{{ rule.roundingMinutes }}</td>
                      <td>{{ rule.maxMinutesPerDay }}</td>
                      <td>{{ rule.requiresApproval ? 'Yes' : 'No' }}</td>
                      <td>{{ rule.isActive ? 'Yes' : 'No' }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editOvertimeRule(rule)">Edit</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteOvertimeRule(rule.id)">
                          Delete
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Approval Flows</h4>
                <button class="attendance__btn" :disabled="approvalFlowLoading" @click="loadApprovalFlows">
                  {{ approvalFlowLoading ? 'Loading...' : 'Reload flows' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-approval-name">
                  <span>Name</span>
                  <input
                    id="attendance-approval-name"
                    name="approvalName"
                    v-model="approvalFlowForm.name"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-approval-type">
                  <span>Request type</span>
                  <select id="attendance-approval-type" name="approvalType" v-model="approvalFlowForm.requestType">
                    <option value="missed_check_in">Missed check-in</option>
                    <option value="missed_check_out">Missed check-out</option>
                    <option value="time_correction">Time correction</option>
                    <option value="leave">Leave</option>
                    <option value="overtime">Overtime</option>
                  </select>
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-approval-active">
                  <span>Active</span>
                  <input
                    id="attendance-approval-active"
                    name="approvalActive"
                    v-model="approvalFlowForm.isActive"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-approval-steps">
                  <span>Steps (JSON)</span>
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
                  {{ approvalFlowSaving ? 'Saving...' : approvalFlowEditingId ? 'Update flow' : 'Create flow' }}
                </button>
                <button
                  v-if="approvalFlowEditingId"
                  class="attendance__btn"
                  :disabled="approvalFlowSaving"
                  @click="resetApprovalFlowForm"
                >
                  Cancel edit
                </button>
              </div>
              <div v-if="approvalFlows.length === 0" class="attendance__empty">No approval flows yet.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Request</th>
                      <th>Steps</th>
                      <th>Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="flow in approvalFlows" :key="flow.id">
                      <td>{{ flow.name }}</td>
                      <td>{{ formatRequestType(flow.requestType) }}</td>
                      <td>{{ flow.steps.length }}</td>
                      <td>{{ flow.isActive ? 'Yes' : 'No' }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editApprovalFlow(flow)">Edit</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteApprovalFlow(flow.id)">
                          Delete
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Rotation Rules</h4>
                <button class="attendance__btn" :disabled="rotationRuleLoading" @click="loadRotationRules">
                  {{ rotationRuleLoading ? 'Loading...' : 'Reload rotation rules' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-rotation-name">
                  <span>Name</span>
                  <input
                    id="attendance-rotation-name"
                    name="rotationName"
                    v-model="rotationRuleForm.name"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-rotation-timezone">
                  <span>Timezone</span>
                  <input
                    id="attendance-rotation-timezone"
                    name="rotationTimezone"
                    v-model="rotationRuleForm.timezone"
                    type="text"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-rotation-sequence">
                  <span>Shift sequence (IDs)</span>
                  <input
                    id="attendance-rotation-sequence"
                    name="rotationSequence"
                    v-model="rotationRuleForm.shiftSequence"
                    type="text"
                    placeholder="shiftId1, shiftId2"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-rotation-active">
                  <span>Active</span>
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
                  {{ rotationRuleSaving ? 'Saving...' : rotationRuleEditingId ? 'Update rotation' : 'Create rotation' }}
                </button>
                <button
                  v-if="rotationRuleEditingId"
                  class="attendance__btn"
                  :disabled="rotationRuleSaving"
                  @click="resetRotationRuleForm"
                >
                  Cancel edit
                </button>
              </div>
              <div v-if="rotationRules.length === 0" class="attendance__empty">No rotation rules yet.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Timezone</th>
                      <th>Sequence</th>
                      <th>Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="rule in rotationRules" :key="rule.id">
                      <td>{{ rule.name }}</td>
                      <td>{{ rule.timezone }}</td>
                      <td>{{ rule.shiftSequence.join(', ') }}</td>
                      <td>{{ rule.isActive ? 'Yes' : 'No' }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editRotationRule(rule)">Edit</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteRotationRule(rule.id)">
                          Delete
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Rotation Assignments</h4>
                <button class="attendance__btn" :disabled="rotationAssignmentLoading" @click="loadRotationAssignments">
                  {{ rotationAssignmentLoading ? 'Loading...' : 'Reload rotations' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-rotation-user">
                  <span>User ID</span>
                  <input
                    id="attendance-rotation-user"
                    name="rotationUserId"
                    v-model="rotationAssignmentForm.userId"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-rotation-rule">
                  <span>Rotation rule</span>
                  <select
                    id="attendance-rotation-rule"
                    name="rotationRuleId"
                    v-model="rotationAssignmentForm.rotationRuleId"
                    :disabled="rotationRules.length === 0"
                  >
                    <option value="" disabled>Select rotation</option>
                    <option v-for="rule in rotationRules" :key="rule.id" :value="rule.id">
                      {{ rule.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-rotation-start">
                  <span>Start date</span>
                  <input
                    id="attendance-rotation-start"
                    name="rotationStartDate"
                    v-model="rotationAssignmentForm.startDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-rotation-end">
                  <span>End date</span>
                  <input
                    id="attendance-rotation-end"
                    name="rotationEndDate"
                    v-model="rotationAssignmentForm.endDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-rotation-active">
                  <span>Active</span>
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
                  {{ rotationAssignmentSaving ? 'Saving...' : rotationAssignmentEditingId ? 'Update assignment' : 'Create assignment' }}
                </button>
                <button
                  v-if="rotationAssignmentEditingId"
                  class="attendance__btn"
                  :disabled="rotationAssignmentSaving"
                  @click="resetRotationAssignmentForm"
                >
                  Cancel edit
                </button>
              </div>
              <div v-if="rotationAssignments.length === 0" class="attendance__empty">No rotation assignments yet.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Rotation</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in rotationAssignments" :key="item.assignment.id">
                      <td>{{ item.assignment.userId }}</td>
                      <td>{{ item.rotation.name }}</td>
                      <td>{{ item.assignment.startDate }}</td>
                      <td>{{ item.assignment.endDate || '--' }}</td>
                      <td>{{ item.assignment.isActive ? 'Yes' : 'No' }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editRotationAssignment(item)">Edit</button>
                        <button
                          class="attendance__btn attendance__btn--danger"
                          @click="deleteRotationAssignment(item.assignment.id)"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Shifts</h4>
                <button class="attendance__btn" :disabled="shiftLoading" @click="loadShifts">
                  {{ shiftLoading ? 'Loading...' : 'Reload shifts' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-shift-name">
                  <span>Name</span>
                  <input id="attendance-shift-name" name="shiftName" v-model="shiftForm.name" type="text" />
                </label>
                <label class="attendance__field" for="attendance-shift-timezone">
                  <span>Timezone</span>
                  <input
                    id="attendance-shift-timezone"
                    name="shiftTimezone"
                    v-model="shiftForm.timezone"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-shift-start">
                  <span>Work start</span>
                  <input
                    id="attendance-shift-start"
                    name="shiftWorkStartTime"
                    v-model="shiftForm.workStartTime"
                    type="time"
                  />
                </label>
                <label class="attendance__field" for="attendance-shift-end">
                  <span>Work end</span>
                  <input
                    id="attendance-shift-end"
                    name="shiftWorkEndTime"
                    v-model="shiftForm.workEndTime"
                    type="time"
                  />
                </label>
                <label class="attendance__field" for="attendance-shift-late-grace">
                  <span>Late grace (min)</span>
                  <input
                    id="attendance-shift-late-grace"
                    name="shiftLateGraceMinutes"
                    v-model.number="shiftForm.lateGraceMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field" for="attendance-shift-early-grace">
                  <span>Early grace (min)</span>
                  <input
                    id="attendance-shift-early-grace"
                    name="shiftEarlyGraceMinutes"
                    v-model.number="shiftForm.earlyGraceMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field" for="attendance-shift-rounding">
                  <span>Rounding (min)</span>
                  <input
                    id="attendance-shift-rounding"
                    name="shiftRoundingMinutes"
                    v-model.number="shiftForm.roundingMinutes"
                    type="number"
                    min="0"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-shift-working-days">
                  <span>Working days (0-6)</span>
                  <input
                    id="attendance-shift-working-days"
                    name="shiftWorkingDays"
                    v-model="shiftForm.workingDays"
                    type="text"
                    placeholder="1,2,3,4,5"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn attendance__btn--primary" :disabled="shiftSaving" @click="saveShift">
                  {{ shiftSaving ? 'Saving...' : shiftEditingId ? 'Update shift' : 'Create shift' }}
                </button>
                <button v-if="shiftEditingId" class="attendance__btn" :disabled="shiftSaving" @click="resetShiftForm">
                  Cancel edit
                </button>
              </div>
              <div v-if="shifts.length === 0" class="attendance__empty">No shifts yet.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Timezone</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Working days</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="shift in shifts" :key="shift.id">
                      <td>{{ shift.name }}</td>
                      <td>{{ shift.timezone }}</td>
                      <td>{{ shift.workStartTime }}</td>
                      <td>{{ shift.workEndTime }}</td>
                      <td>{{ shift.workingDays.join(',') }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editShift(shift)">Edit</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteShift(shift.id)">
                          Delete
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Assignments</h4>
                <button class="attendance__btn" :disabled="assignmentLoading" @click="loadAssignments">
                  {{ assignmentLoading ? 'Loading...' : 'Reload assignments' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-assignment-user-id">
                  <span>User ID</span>
                  <input
                    id="attendance-assignment-user-id"
                    name="assignmentUserId"
                    v-model="assignmentForm.userId"
                    type="text"
                  />
                </label>
                <label class="attendance__field" for="attendance-assignment-shift-id">
                  <span>Shift</span>
                  <select
                    id="attendance-assignment-shift-id"
                    name="assignmentShiftId"
                    v-model="assignmentForm.shiftId"
                    :disabled="shifts.length === 0"
                  >
                    <option value="" disabled>Select shift</option>
                    <option v-for="shift in shifts" :key="shift.id" :value="shift.id">
                      {{ shift.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-assignment-start-date">
                  <span>Start date</span>
                  <input
                    id="attendance-assignment-start-date"
                    name="assignmentStartDate"
                    v-model="assignmentForm.startDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-assignment-end-date">
                  <span>End date</span>
                  <input
                    id="attendance-assignment-end-date"
                    name="assignmentEndDate"
                    v-model="assignmentForm.endDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-assignment-active">
                  <span>Active</span>
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
                  {{ assignmentSaving ? 'Saving...' : assignmentEditingId ? 'Update assignment' : 'Create assignment' }}
                </button>
                <button
                  v-if="assignmentEditingId"
                  class="attendance__btn"
                  :disabled="assignmentSaving"
                  @click="resetAssignmentForm"
                >
                  Cancel edit
                </button>
              </div>
              <div v-if="assignments.length === 0" class="attendance__empty">No assignments yet.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Shift</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in assignments" :key="item.assignment.id">
                      <td>{{ item.assignment.userId }}</td>
                      <td>{{ item.shift.name }}</td>
                      <td>{{ item.assignment.startDate }}</td>
                      <td>{{ item.assignment.endDate || '--' }}</td>
                      <td>{{ item.assignment.isActive ? 'Yes' : 'No' }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editAssignment(item)">Edit</button>
                        <button
                          class="attendance__btn attendance__btn--danger"
                          @click="deleteAssignment(item.assignment.id)"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Holidays</h4>
                <button class="attendance__btn" :disabled="holidayLoading" @click="loadHolidays">
                  {{ holidayLoading ? 'Loading...' : 'Reload holidays' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-holiday-date">
                  <span>Date</span>
                  <input
                    id="attendance-holiday-date"
                    name="holidayDate"
                    v-model="holidayForm.date"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-holiday-name">
                  <span>Name</span>
                  <input
                    id="attendance-holiday-name"
                    name="holidayName"
                    v-model="holidayForm.name"
                    type="text"
                    placeholder="Optional"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-working">
                  <span>Working day override</span>
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
                  {{ holidaySaving ? 'Saving...' : holidayEditingId ? 'Update holiday' : 'Create holiday' }}
                </button>
                <button
                  v-if="holidayEditingId"
                  class="attendance__btn"
                  :disabled="holidaySaving"
                  @click="resetHolidayForm"
                >
                  Cancel edit
                </button>
              </div>
              <div v-if="holidays.length === 0" class="attendance__empty">No holidays in this range.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Name</th>
                      <th>Working day</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="holiday in holidays" :key="holiday.id">
                      <td>{{ holiday.date }}</td>
                      <td>{{ holiday.name || '--' }}</td>
                      <td>{{ holiday.isWorkingDay ? 'Yes' : 'No' }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="editHoliday(holiday)">Edit</button>
                        <button class="attendance__btn attendance__btn--danger" @click="deleteHoliday(holiday.id)">
                          Delete
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
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
import { usePlugins } from '../composables/usePlugins'
import { apiFetch } from '../utils/api'

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
const importBatchSnapshot = ref<Record<string, any> | null>(null)
const importCsvWarnings = ref<string[]>([])
const importPreviewTask = ref<AttendanceImportPreviewTask | null>(null)
const importAsyncJob = ref<AttendanceImportJob | null>(null)
const importAsyncPolling = ref(false)
const reconcileResult = ref<AttendanceReconcileResult | null>(null)
const rulePreviewResult = ref<AttendanceRulePreviewItem | null>(null)

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
const statusCode = computed(() => statusMeta.value?.code || '')
const statusHint = computed(() => statusMeta.value?.hint || '')

const statusActionLabel = computed(() => {
  const action = statusMeta.value?.action
  if (!action) return ''
  if (action === 'refresh-overview') return 'Retry refresh'
  if (action === 'reload-admin') return 'Reload admin'
  if (action === 'reload-import-job') return 'Reload import job'
  if (action === 'resume-import-job') return 'Resume import job'
  if (action === 'reload-import-csv') return 'Re-apply CSV'
  if (action === 'retry-save-settings') return 'Retry save settings'
  if (action === 'retry-save-rule') return 'Retry save rule'
  if (action === 'retry-preview-import') return 'Retry preview'
  if (action === 'retry-run-import') return 'Retry import'
  if (action === 'retry-submit-request') return 'Retry submit request'
  if (action === 'reload-requests') return 'Reload requests'
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
  if (action === 'retry-run-import') return importLoading.value
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

const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const calendarLabel = computed(() => {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long' }).format(calendarMonth.value)
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
    map.set(holiday.date, holiday)
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
    let tooltip = record
      ? `${key} · ${statusLabel} · ${record.work_minutes} min`
      : key
    if (!record && holiday && holiday.isWorkingDay === false) {
      status = 'off'
      statusLabel = 'Holiday'
      tooltip = holiday.name ? `${key} · ${holiday.name}` : `${key} · Holiday`
    } else if (record && status === 'off' && holiday?.name) {
      tooltip = `${key} · ${holiday.name} · ${record.work_minutes} min`
    }
    return {
      key,
      day: date.getDate(),
      isToday: date.toDateString() === now.toDateString(),
      isCurrentMonth: date.getMonth() === month,
      status,
      statusLabel,
      tooltip,
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

function formatDateTime(value: string | null): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString()
}

function formatStatus(value: string): string {
  const map: Record<string, string> = {
    normal: 'Normal',
    late: 'Late',
    early_leave: 'Early leave',
    late_early: 'Late + Early',
    partial: 'Partial',
    absent: 'Absent',
    adjusted: 'Adjusted',
    off: 'Off',
  }
  return map[value] ?? value
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
  const map: Record<string, string> = {
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
    setStatus('A pending request already exists for this work date.', 'error')
    return
  }
  requestForm.workDate = item.workDate
  requestForm.requestType = item.suggestedRequestType ?? 'time_correction'
  setStatus('Request form updated from anomaly.')
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
const importDebugOptions = readImportDebugOptions()
const importAsyncPollIntervalMs = importDebugOptions.pollIntervalMs ?? IMPORT_ASYNC_DEFAULT_POLL_INTERVAL_MS
const importAsyncPollTimeoutMs = importDebugOptions.pollTimeoutMs ?? IMPORT_ASYNC_DEFAULT_POLL_TIMEOUT_MS
let importDebugTimeoutPending = importDebugOptions.forceTimeoutOnce

function estimateImportRowCount(payload: Record<string, any>): number | null {
  if (importDebugOptions.forceAsyncImport) {
    return IMPORT_PREVIEW_ASYNC_ROW_THRESHOLD
  }
  if (typeof payload.csvFileId === 'string' && payload.csvFileId.trim().length > 0) {
    const id = payload.csvFileId.trim()
    if (importCsvFileId.value && id === importCsvFileId.value && importCsvFileRowCountHint.value) {
      return importCsvFileRowCountHint.value
    }
    // Force async import path when the payload references a server-side upload.
    return IMPORT_PREVIEW_ASYNC_ROW_THRESHOLD
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
  if (!rowCountHint || rowCountHint <= IMPORT_LARGE_ROW_THRESHOLD) return

  if (options.mode === 'preview') {
    if (payload.previewLimit === undefined || payload.previewLimit === null) {
      payload.previewLimit = IMPORT_PREVIEW_LIMIT
    }
    return
  }

  // commit
  if (payload.returnItems === undefined || payload.returnItems === null) {
    payload.returnItems = false
  }
  if (payload.itemsLimit === undefined || payload.itemsLimit === null) {
    payload.itemsLimit = IMPORT_COMMIT_ITEMS_LIMIT
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
  if (!Number.isFinite(value)) return IMPORT_PREVIEW_LIMIT
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
  const sampleLimit = normalizePreviewSampleLimit(payload.previewLimit)

  if (Array.isArray(payload.rows) && payload.rows.length >= IMPORT_PREVIEW_CHUNK_THRESHOLD) {
    const totalRows = payload.rows.length
    const chunkCount = Math.ceil(totalRows / IMPORT_PREVIEW_CHUNK_SIZE)
    return {
      totalRows,
      chunkCount,
      sampleLimit,
      buildPayload: (chunkIndex, remainingSample) => {
        const start = chunkIndex * IMPORT_PREVIEW_CHUNK_SIZE
        const end = Math.min(totalRows, start + IMPORT_PREVIEW_CHUNK_SIZE)
        return {
          ...payload,
          rows: payload.rows.slice(start, end),
          previewLimit: Math.max(1, Math.min(remainingSample, IMPORT_PREVIEW_LIMIT)),
        }
      },
    }
  }

  if (Array.isArray(payload.entries) && payload.entries.length >= IMPORT_PREVIEW_CHUNK_THRESHOLD) {
    const totalRows = payload.entries.length
    const chunkCount = Math.ceil(totalRows / IMPORT_PREVIEW_CHUNK_SIZE)
    return {
      totalRows,
      chunkCount,
      sampleLimit,
      buildPayload: (chunkIndex, remainingSample) => {
        const start = chunkIndex * IMPORT_PREVIEW_CHUNK_SIZE
        const end = Math.min(totalRows, start + IMPORT_PREVIEW_CHUNK_SIZE)
        return {
          ...payload,
          entries: payload.entries.slice(start, end),
          previewLimit: Math.max(1, Math.min(remainingSample, IMPORT_PREVIEW_LIMIT)),
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
    if (totalRows < IMPORT_PREVIEW_CHUNK_THRESHOLD) return null
    const chunkCount = Math.ceil(totalRows / IMPORT_PREVIEW_CHUNK_SIZE)

    return {
      totalRows,
      chunkCount,
      sampleLimit,
      buildPayload: (chunkIndex, remainingSample) => {
        const start = chunkIndex * IMPORT_PREVIEW_CHUNK_SIZE
        const end = Math.min(totalRows, start + IMPORT_PREVIEW_CHUNK_SIZE)
        const csvText = [header, ...dataRows.slice(start, end)].join('\n')
        const nextPayload: Record<string, any> = {
          ...payload,
          csvText,
          previewLimit: Math.max(1, Math.min(remainingSample, IMPORT_PREVIEW_LIMIT)),
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

function resolveImportJobFailedRows(job: AttendanceImportJob | null): number {
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

function formatImportElapsedMs(value: unknown): string {
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
  if (!templateId) return 'Manual'
  const found = payrollTemplates.value.find(item => item.id === templateId)
  return found?.name ?? templateId
}

async function loadImportTemplate() {
  clearImportPreviewTask()
  importLoading.value = true
  try {
    const response = await apiFetch('/api/attendance/import/template')
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to load import template')
    }
    const payloadExample = (data.data?.payloadExample ?? {}) as Record<string, any>
    importMode.value = payloadExample?.mode === 'merge' ? 'merge' : 'override'
    importForm.payload = JSON.stringify(payloadExample, null, 2)
    importMappingProfiles.value = Array.isArray(data.data?.mappingProfiles) ? data.data.mappingProfiles : []
    setStatus('Import template loaded.')
  } catch (error) {
    setStatus((error as Error).message || 'Failed to load import template', 'error')
  } finally {
    importLoading.value = false
  }
}

function applyImportProfile() {
  const profile = selectedImportProfile.value
  if (!profile) {
    setStatus('Select an import mapping profile first.', 'error')
    return
  }
  const base = parseJsonConfig(importForm.payload)
  if (!base) {
    setStatus('Import payload must be valid JSON before applying profile.', 'error')
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
  setStatus(`Applied mapping profile: ${profile.name}`)
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
      throw new Error('User map JSON format not recognized. Provide mapping object or array with key field.')
    }
    importUserMap.value = normalized
    setStatus(`User map loaded (${Object.keys(normalized).length} entries).`)
  } catch (error) {
    importUserMap.value = null
    importUserMapError.value = (error as Error).message || 'Failed to parse user map JSON'
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
    throw new Error(data?.error?.message || `Failed to upload CSV (HTTP ${response.status})`)
  }
  const fileId = String(data.data?.fileId || '')
  if (!fileId) throw new Error('Upload did not return fileId')
  const rowCount = Number(data.data?.rowCount ?? 0)
  const bytes = Number(data.data?.bytes ?? 0)
  const expiresAt = String(data.data?.expiresAt ?? '')
  return { fileId, rowCount, bytes, expiresAt }
}

async function applyImportCsvFile() {
  if (!importCsvFile.value) {
    setStatus('Select a CSV file first.', 'error', {
      hint: 'Choose a CSV file, then retry preview/import.',
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
      setStatus(`CSV uploaded: ${importCsvFileName.value || 'file'} (${importCsvFileRowCountHint.value ?? 'unknown'} rows).`)
    } else {
      const csvText = await file.text()
      importCsvFileId.value = ''
      importCsvFileRowCountHint.value = null
      importCsvFileExpiresAt.value = ''
      next.csvText = csvText
      delete next.csvFileId
      setStatus(`CSV loaded: ${importCsvFileName.value || 'file'}`)
    }

    importForm.payload = JSON.stringify(next, null, 2)
  } catch (error) {
    setStatusFromError(error, 'Failed to load CSV', 'import-preview')
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
      throw new Error(data?.error?.message || 'Failed to prepare import token')
    }
    importCommitToken.value = data.data?.commitToken ?? ''
    importCommitTokenExpiresAt.value = data.data?.expiresAt ?? ''
    return Boolean(importCommitToken.value)
  } catch (error) {
    setStatus((error as Error).message || 'Failed to prepare import token', 'error')
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
      throw new Error('Preview task canceled')
    }

    const remainingSample = Math.max(1, plan.sampleLimit - aggregatedItems.length)
    const chunkPayload = plan.buildPayload(chunkIndex, remainingSample)
    const tokenOk = await ensureImportCommitToken({ forceRefresh: true })
    if (!tokenOk) throw new Error('Failed to prepare import token')
    if (importCommitToken.value) chunkPayload.commitToken = importCommitToken.value

    const response = await apiFetch('/api/attendance/import/preview', {
      method: 'POST',
      body: JSON.stringify(chunkPayload),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error?.message || `Failed to preview chunk ${chunkIndex + 1}/${plan.chunkCount}`)
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
        processedRows: Math.min(plan.totalRows, (chunkIndex + 1) * IMPORT_PREVIEW_CHUNK_SIZE),
        completedChunks: chunkIndex + 1,
      }
    }
  }

  if (seq !== importPreviewTaskSeq) {
    throw new Error('Preview task canceled')
  }

  importPreview.value = aggregatedItems
  importCsvWarnings.value = Array.from(warningSet)
  const shown = aggregatedItems.length
  const message = `Preview loaded (chunked ${plan.chunkCount} chunks, showing ${shown}/${totalRowCount} rows).`
  const suffix = invalidCount || duplicateCount ? ` Invalid: ${invalidCount}. Duplicates: ${duplicateCount}.` : ''
  setStatus(`${message}${suffix}`)

  importPreviewTask.value = {
    mode: 'chunked',
    status: 'completed',
    totalRows: plan.totalRows,
    processedRows: plan.totalRows,
    totalChunks: plan.chunkCount,
    completedChunks: plan.chunkCount,
    message: `Completed in ${plan.chunkCount} chunk(s).`,
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
    message: 'Queued async preview job.',
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
        throw new Error('Failed to refresh import commit token. Check server deployment/migrations.')
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
    throw createApiError(asyncResponse, asyncData, 'Failed to queue async preview')
  }

  const job = asyncData.data?.job as AttendanceImportJob | undefined
  if (!job?.id) {
    throw new Error('Async preview did not return job id')
  }

  adminForbidden.value = false
  importAsyncJob.value = job
  setStatus(`Preview job queued (${job.status}).`)

  const finalJob = await pollImportJob(job.id)
  const previewData = finalJob.preview && typeof finalJob.preview === 'object' ? finalJob.preview : null
  if (!previewData) {
    throw new Error('Async preview completed without preview payload')
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
    ? `Preview loaded (async, showing ${shown}/${rowCount} rows).`
    : `Preview loaded (async ${shown} rows).`
  const suffix = invalidCount || dupCount ? ` Invalid: ${invalidCount}. Duplicates: ${dupCount}.` : ''
  setStatus(`${baseMsg}${suffix}`)

  importPreviewTask.value = {
    mode: 'single',
    status: 'completed',
    totalRows: Number.isFinite(rowCount) ? rowCount : shown,
    processedRows: Number.isFinite(rowCount) ? rowCount : shown,
    totalChunks: 1,
    completedChunks: 1,
    message: `Completed via async preview job (${job.id.slice(0, 8)}...).`,
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
    setStatus('Invalid JSON payload for import.', 'error', {
      hint: 'Fix JSON syntax in payload and retry preview.',
      action: 'retry-preview-import',
    })
    return
  }
  applyImportScalabilityHints(payload, { mode: 'preview' })
  importLoading.value = true
  try {
    const rowCountHint = estimateImportRowCount(payload)
    if (rowCountHint && rowCountHint >= IMPORT_PREVIEW_ASYNC_ROW_THRESHOLD) {
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
          message: 'Failed to prepare import token',
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
      throw createApiError(response, data, 'Failed to preview import')
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
      ? `Preview loaded (showing ${shown}/${rowCount} rows).`
      : `Preview loaded (${shown} rows).`
    const suffix = invalidCount || dupCount ? ` Invalid: ${invalidCount}. Duplicates: ${dupCount}.` : ''
    setStatus(`${baseMsg}${suffix}`)
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
        message: (error as Error).message || 'Preview failed',
      }
    }
    setStatusFromError(error, 'Failed to preview import', 'import-preview')
  } finally {
    importLoading.value = false
  }
}

let importJobPollSeq = 0

async function fetchImportJob(jobId: string): Promise<AttendanceImportJob> {
  const response = await apiFetch(`/api/attendance/import/jobs/${encodeURIComponent(jobId)}`)
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.ok) {
    throw createApiError(response, data, 'Failed to load import job')
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
        throw createImportJobStateError('IMPORT_JOB_TIMEOUT', 'Import job timed out')
      }
      const job = await fetchImportJob(jobId)
      importAsyncJob.value = job
      if (job.status === 'completed') return job
      if (job.status === 'failed') {
        throw createImportJobStateError('IMPORT_JOB_FAILED', job.error || 'Import job failed')
      }
      if (job.status === 'canceled') {
        throw createImportJobStateError('IMPORT_JOB_CANCELED', 'Import job canceled')
      }
      if (Date.now() - startedAt > importAsyncPollTimeoutMs) {
        throw createImportJobStateError('IMPORT_JOB_TIMEOUT', 'Import job timed out')
      }
      await sleep(importAsyncPollIntervalMs)
    }
    throw createImportJobStateError('IMPORT_JOB_CANCELED', 'Import job polling canceled')
  } finally {
    if (seq === importJobPollSeq) importAsyncPolling.value = false
  }
}

async function refreshImportAsyncJob(options: { silent?: boolean } = {}) {
  const jobId = String(importAsyncJob.value?.id || '').trim()
  if (!jobId) {
    if (!options.silent) setStatus('No async import job selected.', 'error')
    return
  }
  try {
    const job = await fetchImportJob(jobId)
    importAsyncJob.value = job
    if (!options.silent) setStatus(`Import job ${jobId.slice(0, 8)} reloaded (${job.status}).`)
  } catch (error) {
    if (!options.silent) {
      setStatusFromError(error, 'Failed to reload import job', 'import-run')
    }
  }
}

async function resumeImportAsyncJobPolling() {
  const jobId = String(importAsyncJob.value?.id || '').trim()
  if (!jobId) {
    setStatus('No async import job selected.', 'error')
    return
  }
  try {
    const finalJob = await pollImportJob(jobId)
    if (finalJob.kind === 'preview') {
      const previewData = finalJob.preview && typeof finalJob.preview === 'object' ? finalJob.preview : null
      if (previewData) {
        importPreview.value = Array.isArray(previewData.items) ? previewData.items as AttendanceImportPreviewItem[] : []
      }
      setStatus(`Preview job completed (${jobId.slice(0, 8)}).`)
      return
    }
    const imported = Number(finalJob.progress ?? 0)
    const total = Number(finalJob.total ?? 0)
    if (total && imported !== total) {
      setStatus(`Imported ${imported}/${total} rows (async job).`)
    } else {
      setStatus(`Imported ${imported} rows (async job).`)
    }
    await loadRecords()
    await loadImportBatches()
  } catch (error) {
    setStatusFromError(error, 'Failed while polling import job', 'import-run')
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
    setStatus('Invalid JSON payload for import.', 'error', {
      hint: 'Fix JSON syntax in payload and retry import.',
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
    if (rowCountHint && rowCountHint >= IMPORT_ASYNC_ROW_THRESHOLD) {
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
            throw new Error('Failed to refresh import commit token. Check server deployment/migrations.')
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
          throw new Error('Async import did not return job id')
        }
        adminForbidden.value = false
        importAsyncJob.value = job
        setStatus(`Import job queued (${job.status}).`)

        const finalJob = await pollImportJob(job.id)
        const imported = Number(finalJob.progress ?? 0)
        const total = Number(finalJob.total ?? 0)
        setStatus(`Imported ${imported} rows (async job).`)
        if (total && imported !== total) {
          setStatus(`Imported ${imported}/${total} rows (async job).`)
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
          throw new Error('Failed to refresh import commit token. Check server deployment/migrations.')
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
      throw createApiError(response, data, 'Failed to import attendance')
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
      setStatus(`Imported ${count} rows. Groups created: ${groupCreated}. Members added: ${groupMembersAdded}.`)
    } else {
      setStatus(`Imported ${count} rows.`)
    }
    await loadRecords()
    await loadImportBatches()
    importCommitToken.value = ''
    importCommitTokenExpiresAt.value = ''
  } catch (error) {
    setStatusFromError(error, 'Failed to import attendance', 'import-run')
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
      throw new Error(data?.error?.message || 'Failed to load import batches')
    }
    importBatches.value = data.data?.items ?? []
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load import batches', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load import batch items')
    }
    importBatchSelectedId.value = batchId
    importBatchItems.value = data.data?.items ?? []
    importBatchSnapshot.value = null
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load import batch items', 'error')
  } finally {
    importLoading.value = false
  }
}

function toggleImportBatchSnapshot(item: AttendanceImportItem) {
  if (!item.previewSnapshot) {
    importBatchSnapshot.value = null
    return
  }
  if (importBatchSnapshot.value === item.previewSnapshot) {
    importBatchSnapshot.value = null
  } else {
    importBatchSnapshot.value = item.previewSnapshot
  }
}

async function rollbackImportBatch(batchId: string) {
  if (!batchId || !window.confirm('Rollback this import batch?')) return
  importLoading.value = true
  try {
    const response = await apiFetch(`/api/attendance/import/rollback/${batchId}`, { method: 'POST' })
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to rollback import batch')
    }
    await loadImportBatches()
    if (importBatchSelectedId.value === batchId) {
      importBatchItems.value = []
      importBatchSnapshot.value = null
      importBatchSelectedId.value = ''
    }
    setStatus('Import batch rolled back.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to rollback import batch', 'error')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error?.message || 'Failed to load import items')
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
    setStatus('Select a batch first.', 'error')
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
      throw new Error('Admin permissions required')
    }
    if (serverResponse.ok) {
      const csvText = await serverResponse.text()
      const stamp = new Date().toISOString().slice(0, 10)
      const filename = `attendance-import-${batchId.slice(0, 8)}-${exportType}-${stamp}.csv`
      downloadCsvText(filename, csvText)
      setStatus('CSV exported.')
      return
    }

    // Backward-compatible fallback for older deployments without the export endpoint.
    if (serverResponse.status !== 404) {
      const errorText = await serverResponse.text().catch(() => '')
      throw new Error(errorText || `Failed to export CSV (HTTP ${serverResponse.status})`)
    }

    const allItems = await fetchAllImportBatchItems(batchId)
    if (allItems.length === 0) {
      setStatus('No batch items found.', 'error')
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
    setStatus(`CSV exported (${rows.length}/${allItems.length}).`)
  } catch (error: any) {
    setStatus(error?.message || 'Failed to export CSV', 'error')
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
  if (normalized.includes('FORBIDDEN') || normalized.includes('PERMISSION')) return 'FORBIDDEN'
  if (normalized.includes('UNAUTHORIZED') || normalized.includes('TOKEN_EXPIRED')) return 'UNAUTHORIZED'
  if (normalized.includes('SERVICE_UNAVAILABLE') || normalized.includes('DB_NOT_READY')) return 'SERVICE_UNAVAILABLE'

  const codeMatch = normalized.match(/\b[A-Z][A-Z0-9_]{2,}\b/)
  return codeMatch ? codeMatch[0] : ''
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

function createForbiddenError(message = 'Admin permissions required'): AttendanceApiError {
  const error = new Error(message) as AttendanceApiError
  error.status = 403
  error.code = 'FORBIDDEN'
  return error
}

function classifyStatusError(
  error: unknown,
  fallbackMessage: string,
  context: AttendanceStatusContext,
): { message: string; meta: AttendanceStatusMeta } {
  const err = error as Record<string, unknown> | null
  const rawMessage = typeof err?.message === 'string' && err.message.trim().length > 0
    ? String(err.message)
    : fallbackMessage
  const status = typeof err?.status === 'number' ? Number(err.status) : Number.NaN
  const explicitCode = typeof err?.code === 'string' ? normalizeErrorCode(String(err.code)) : ''
  const code = explicitCode || inferErrorCodeFromMessage(rawMessage)
  const defaultAction = defaultStatusActionForContext(context)
  const meta: AttendanceStatusMeta = {}
  let message = rawMessage
  const nestedCode = inferErrorCodeFromMessage(rawMessage)

  if (code) meta.code = code

  if (code === 'COMMIT_TOKEN_INVALID' || code === 'COMMIT_TOKEN_REQUIRED') {
    message = 'Import token expired before request completed.'
    meta.hint = 'Click retry to refresh commit token and submit again.'
    meta.action = context === 'import-run' ? 'retry-run-import' : 'retry-preview-import'
  } else if (
    context === 'import-preview'
    && (code === 'EXPIRED' || code === 'INVALID_CSV_FILE_ID')
  ) {
    message = code === 'EXPIRED'
      ? 'Uploaded CSV file has expired on the server.'
      : 'Uploaded CSV reference is invalid.'
    meta.hint = 'Click "Re-apply CSV" to upload again, then retry preview.'
    meta.action = 'reload-import-csv'
  } else if (
    context === 'import-run'
    && (code === 'EXPIRED' || code === 'INVALID_CSV_FILE_ID')
  ) {
    message = code === 'EXPIRED'
      ? 'Uploaded CSV file has expired on the server.'
      : 'Uploaded CSV reference is invalid.'
    meta.hint = 'Click "Re-apply CSV" to upload again, then retry import.'
    meta.action = 'reload-import-csv'
  } else if (
    (context === 'import-preview' || context === 'import-run')
    && (code === 'CSV_TOO_LARGE' || code === 'PAYLOAD_TOO_LARGE' || status === 413)
  ) {
    message = code === 'CSV_TOO_LARGE'
      ? rawMessage
      : 'CSV upload exceeds server size limit.'
    meta.hint = 'Use a smaller file or split the CSV by date/user range, then retry.'
    meta.action = 'reload-import-csv'
  } else if (code === 'IMPORT_JOB_TIMEOUT') {
    message = 'Async import job is still running in background.'
    meta.hint = 'Use "Resume import job" to continue polling, or open the async job card for manual controls.'
    meta.action = 'resume-import-job'
  } else if (code === 'IMPORT_JOB_FAILED') {
    if (nestedCode === 'EXPIRED' || nestedCode === 'INVALID_CSV_FILE_ID') {
      message = nestedCode === 'EXPIRED'
        ? 'Uploaded CSV file expired while async import was running.'
        : 'Uploaded CSV reference is invalid for async import.'
      meta.hint = 'Re-apply CSV and retry import.'
      meta.action = 'reload-import-csv'
    } else if (nestedCode === 'COMMIT_TOKEN_INVALID' || nestedCode === 'COMMIT_TOKEN_REQUIRED') {
      message = 'Import token expired while async import was running.'
      meta.hint = 'Retry import to request a new commit token.'
      meta.action = 'retry-run-import'
    } else if (nestedCode === 'CSV_TOO_LARGE' || nestedCode === 'PAYLOAD_TOO_LARGE') {
      message = nestedCode === 'CSV_TOO_LARGE'
        ? rawMessage
        : 'CSV upload exceeds server size limit.'
      meta.hint = 'Split the CSV into smaller files, then retry import.'
      meta.action = 'reload-import-csv'
    } else {
      message = rawMessage
      meta.hint = 'Inspect job error details, then retry import.'
      meta.action = 'retry-run-import'
    }
  } else if (code === 'IMPORT_JOB_CANCELED') {
    message = 'Async import job was canceled before completion.'
    meta.hint = 'Submit a new import when ready.'
    meta.action = 'retry-run-import'
  } else if (context === 'import-run' && code === 'IMPORT_JOB_NOT_FOUND') {
    message = 'Async import job is no longer available.'
    meta.hint = 'Submit a new import task and continue from the latest payload.'
    meta.action = 'retry-run-import'
  } else if (code === 'RATE_LIMITED' || status === 429) {
    message = 'Request was rate-limited by the server.'
    meta.hint = 'Wait a few seconds before retrying to avoid repeated throttling.'
    meta.action = defaultAction
  } else if (code === 'REQUEST_TIMEOUT' || status === 408) {
    message = 'Request timed out before the server responded.'
    meta.hint = 'Retry the action. If this repeats, check network/server health.'
    meta.action = defaultAction
  } else if (code === 'PUNCH_TOO_SOON') {
    message = rawMessage
    meta.hint = 'Minimum punch interval is enforced by policy. Retry after the interval.'
    meta.action = 'refresh-overview'
  } else if (status === 401 || code === 'UNAUTHORIZED' || code === 'INVALID_TOKEN' || code === 'TOKEN_EXPIRED') {
    message = 'Session expired or token is invalid.'
    meta.hint = 'Sign in again, then retry the action.'
    meta.action = 'refresh-overview'
  } else if (status === 403 || code === 'FORBIDDEN' || code === 'PERMISSION_DENIED') {
    message = rawMessage === fallbackMessage ? 'Permission denied for this action.' : rawMessage
    meta.hint = 'Use an account with required attendance permissions, then reload data.'
    meta.action = context === 'request-submit' || context === 'request-resolve' || context === 'request-cancel'
      ? 'reload-requests'
      : 'reload-admin'
  } else if (status >= 500 || code === 'SERVICE_UNAVAILABLE' || code === 'DB_NOT_READY') {
    if (!message) message = fallbackMessage
    meta.hint = 'Server may be warming up or temporarily unavailable. Retry in a moment.'
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
    setProvisionStatus('Enter a search query (email/name/id).', 'error')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error?.message || 'Failed to search users')
    }
    const items = Array.isArray(data.data?.items) ? data.data.items : []
    provisionSearchResults.value = items
    provisionSearchTotal.value = Number(data.data?.total ?? items.length) || 0
    provisionSearchPage.value = Number(data.data?.page ?? page) || page
  } catch (error: any) {
    setProvisionStatus(error?.message || 'Failed to search users', 'error')
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
    throw new Error('Admin permissions required')
  }
  const data: PermissionUserResponse = await response.json()
  if (!response.ok) {
    const message = (data as any)?.error || (data as any)?.message || 'Failed to load permissions'
    throw new Error(message)
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
    throw new Error('Admin permissions required')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error?.message || 'Failed to load user access')
  }
  applyProvisionAccessPayload(data.data, userId)
}

async function loadProvisioningUser() {
  const userId = provisionForm.userId.trim()
  provisionHasLoaded.value = true
  if (!isUuid(userId)) {
    setProvisionStatus('Please enter a valid UUID for User ID.', 'error')
    return
  }
  provisionLoading.value = true
  try {
    await fetchProvisioningUserAccess(userId)
    setProvisionStatus(`Loaded ${provisionPermissions.value.length} permission(s).`)
  } catch (error: any) {
    setProvisionStatus(error?.message || 'Failed to load permissions', 'error')
  } finally {
    provisionLoading.value = false
  }
}

async function grantProvisioningRole() {
  const userId = provisionForm.userId.trim()
  provisionHasLoaded.value = true
  if (!isUuid(userId)) {
    setProvisionStatus('Please enter a valid UUID for User ID.', 'error')
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
        throw new Error('Admin permissions required')
      }
      const modernData = await modern.json().catch(() => null)
      if (!modern.ok || !modernData?.ok) {
        throw new Error(modernData?.error?.message || 'Failed to assign role')
      }
      applyProvisionAccessPayload(modernData.data, userId)
      setProvisionStatus(`Role '${role}' assigned.`)
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
        throw new Error('Admin permissions required')
      }
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data?.error || data?.message || `Failed to grant ${permission}`)
      }
    }
    await fetchProvisioningUser(userId)
    setProvisionStatus(`Role '${role}' granted.`)
  } catch (error: any) {
    setProvisionStatus(error?.message || 'Failed to grant role', 'error')
  } finally {
    provisionLoading.value = false
  }
}

async function revokeProvisioningRole() {
  const userId = provisionForm.userId.trim()
  provisionHasLoaded.value = true
  if (!isUuid(userId)) {
    setProvisionStatus('Please enter a valid UUID for User ID.', 'error')
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
        throw new Error('Admin permissions required')
      }
      const modernData = await modern.json().catch(() => null)
      if (!modern.ok || !modernData?.ok) {
        throw new Error(modernData?.error?.message || 'Failed to remove role')
      }
      applyProvisionAccessPayload(modernData.data, userId)
      setProvisionStatus(`Role '${role}' removed.`)
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
        throw new Error('Admin permissions required')
      }
      const data = await response.json()
      // 404 is fine for revokes (permission not present).
      if (!response.ok && response.status !== 404) {
        throw new Error(data?.error || data?.message || `Failed to revoke ${permission}`)
      }
    }
    await fetchProvisioningUser(userId)
    setProvisionStatus(`Role '${role}' revoked.`)
  } catch (error: any) {
    setProvisionStatus(error?.message || 'Failed to revoke role', 'error')
  } finally {
    provisionLoading.value = false
  }
}

async function previewProvisionBatchUsers() {
  provisionBatchStatusMessage.value = ''
  const { valid, invalid } = parseUserIdListText(provisionBatchUserIdsText.value)
  if (invalid.length) {
    setProvisionBatchStatus(`Invalid UUID(s): ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`, 'error')
    return
  }
  if (valid.length === 0) {
    setProvisionBatchStatus('Please enter at least one valid User ID (UUID).', 'error')
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
      setProvisionBatchStatus('Batch preview API not available on this deployment.', 'error')
      return
    }
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }

    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error?.message || 'Failed to preview batch users')
    }

    applyProvisionBatchResolvePayload(data.data, valid)
    const found = provisionBatchPreviewItems.value.length
    const missing = provisionBatchPreviewMissingIds.value.length
    const inactive = provisionBatchPreviewInactiveIds.value.length
    const kind = missing > 0 ? 'error' : 'info'
    setProvisionBatchStatus(`Preview ready: found ${found}/${valid.length}, missing ${missing}, inactive ${inactive}.`, kind)
  } catch (error: any) {
    setProvisionBatchStatus(error?.message || 'Failed to preview batch users', 'error')
  } finally {
    provisionBatchPreviewLoading.value = false
  }
}

async function grantProvisioningRoleBatch() {
  provisionBatchStatusMessage.value = ''
  const role = provisionBatchRole.value
  const { valid, invalid } = parseUserIdListText(provisionBatchUserIdsText.value)
  if (invalid.length) {
    setProvisionBatchStatus(`Invalid UUID(s): ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`, 'error')
    return
  }
  if (valid.length === 0) {
    setProvisionBatchStatus('Please enter at least one valid User ID (UUID).', 'error')
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
        throw new Error('Admin permissions required')
      }
      const batchData = await batch.json().catch(() => null)
      if (!batch.ok || !batchData?.ok) {
        throw new Error(batchData?.error?.message || 'Failed to batch assign role')
      }
      applyProvisionBatchResolvePayload(batchData.data, valid)
      const updated = Number(batchData.data?.updated ?? 0) || 0
      const eligible = Number(batchData.data?.eligible ?? (valid.length - provisionBatchPreviewMissingIds.value.length)) || 0
      const missing = provisionBatchPreviewMissingIds.value.length
      const inactive = provisionBatchPreviewInactiveIds.value.length
      const unchanged = provisionBatchUnchangedIds.value.length
      const kind = missing > 0 ? 'error' : 'info'
      setProvisionBatchStatus(`Role '${role}' assigned to ${updated}/${eligible} eligible user(s). Unchanged ${unchanged}. Missing ${missing}, inactive ${inactive}.`, kind)
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
            throw new Error('Admin permissions required')
          }
          const modernData = await modern.json().catch(() => null)
          if (!modern.ok || !modernData?.ok) {
            throw new Error(modernData?.error?.message || 'Failed to assign role')
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
            throw new Error('Admin permissions required')
          }
          const data = await response.json().catch(() => null)
          if (!response.ok) {
            throw new Error(data?.error || data?.message || `Failed to grant ${permission}`)
          }
        }
        updated += 1
      } catch {
        failed.push(userId)
      }
    }

    const message = failed.length
      ? `Role '${role}' assigned to ${updated}/${valid.length} user(s). Failed: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`
      : `Role '${role}' assigned to ${updated}/${valid.length} user(s).`
    setProvisionBatchStatus(message, failed.length ? 'error' : 'info')
  } catch (error: any) {
    setProvisionBatchStatus(error?.message || 'Failed to batch assign role', 'error')
  } finally {
    provisionBatchLoading.value = false
  }
}

async function revokeProvisioningRoleBatch() {
  provisionBatchStatusMessage.value = ''
  const role = provisionBatchRole.value
  const { valid, invalid } = parseUserIdListText(provisionBatchUserIdsText.value)
  if (invalid.length) {
    setProvisionBatchStatus(`Invalid UUID(s): ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`, 'error')
    return
  }
  if (valid.length === 0) {
    setProvisionBatchStatus('Please enter at least one valid User ID (UUID).', 'error')
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
        throw new Error('Admin permissions required')
      }
      const batchData = await batch.json().catch(() => null)
      if (!batch.ok || !batchData?.ok) {
        throw new Error(batchData?.error?.message || 'Failed to batch remove role')
      }
      applyProvisionBatchResolvePayload(batchData.data, valid)
      const updated = Number(batchData.data?.updated ?? 0) || 0
      const eligible = Number(batchData.data?.eligible ?? (valid.length - provisionBatchPreviewMissingIds.value.length)) || 0
      const missing = provisionBatchPreviewMissingIds.value.length
      const inactive = provisionBatchPreviewInactiveIds.value.length
      const unchanged = provisionBatchUnchangedIds.value.length
      const kind = missing > 0 ? 'error' : 'info'
      setProvisionBatchStatus(`Role '${role}' removed from ${updated}/${eligible} eligible user(s). Unchanged ${unchanged}. Missing ${missing}, inactive ${inactive}.`, kind)
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
            throw new Error('Admin permissions required')
          }
          const modernData = await modern.json().catch(() => null)
          if (!modern.ok || !modernData?.ok) {
            throw new Error(modernData?.error?.message || 'Failed to remove role')
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
            throw new Error('Admin permissions required')
          }
          const data = await response.json().catch(() => null)
          if (!response.ok && response.status !== 404) {
            throw new Error(data?.error || data?.message || `Failed to revoke ${permission}`)
          }
        }
        updated += 1
      } catch {
        failed.push(userId)
      }
    }

    const message = failed.length
      ? `Role '${role}' removed from ${updated}/${valid.length} user(s). Failed: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`
      : `Role '${role}' removed from ${updated}/${valid.length} user(s).`
    setProvisionBatchStatus(message, failed.length ? 'error' : 'info')
  } catch (error: any) {
    setProvisionBatchStatus(error?.message || 'Failed to batch remove role', 'error')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error?.message || 'Failed to load audit summary')
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
    setAuditLogStatus(error?.message || 'Failed to load audit summary', 'error')
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
      setAuditLogStatus('Audit log export API not available on this deployment.', 'error')
      return
    }
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }

    const csvText = await response.text()
    if (!response.ok) {
      throw new Error(csvText.slice(0, 200) || `Export failed (HTTP ${response.status})`)
    }

    const now = new Date()
    const filename = `attendance-audit-logs-${now.toISOString().replace(/[:.]/g, '-')}.csv`
    downloadCsvText(filename, csvText)
    setAuditLogStatus('Audit logs exported.')
  } catch (error: any) {
    setAuditLogStatus(error?.message || 'Failed to export audit logs', 'error')
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
      setAuditLogStatus('Audit log API not available on this deployment.', 'error')
      return
    }
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error?.message || 'Failed to load audit logs')
    }
    const items = Array.isArray(data.data?.items) ? data.data.items : []
    auditLogs.value = items
    auditLogTotal.value = Number(data.data?.total ?? items.length) || 0
    auditLogPage.value = Number(data.data?.page ?? page) || page
    setAuditLogStatus(`Loaded ${items.length} log(s).`)
  } catch (error: any) {
    setAuditLogStatus(error?.message || 'Failed to load audit logs', 'error')
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
      throw new Error(data?.error?.message || 'Punch failed')
    }
    setStatus(`${eventType === 'check_in' ? 'Check in' : 'Check out'} recorded.`)
    await refreshAll()
  } catch (error: any) {
    setStatus(error?.message || 'Punch failed', 'error')
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
    throw new Error(data?.error?.message || 'Failed to load summary')
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
    throw new Error(data?.error?.message || 'Failed to load records')
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
    throw new Error(data?.error?.message || 'Failed to load requests')
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
      throw new Error(data?.error?.message || 'Failed to load anomalies')
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
      throw new Error(data?.error?.message || 'Failed to load request report')
    }
    requestReport.value = data.data.items || []
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load request report', 'error')
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
    setStatusFromError(error, 'Refresh failed', 'refresh')
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

function validateRequestForm(): string | null {
  if (!requestForm.workDate) return 'Work date is required'

  const requestType = requestForm.requestType
  const hasIn = Boolean(requestForm.requestedInAt)
  const hasOut = Boolean(requestForm.requestedOutAt)

  if (hasIn && hasOut) {
    const inTime = new Date(requestForm.requestedInAt).getTime()
    const outTime = new Date(requestForm.requestedOutAt).getTime()
    if (Number.isFinite(inTime) && Number.isFinite(outTime) && outTime <= inTime) {
      return 'End time must be after start time'
    }
  }

  if (requestType === 'missed_check_in' && !hasIn) {
    return 'Requested in time is required'
  }
  if (requestType === 'missed_check_out' && !hasOut) {
    return 'Requested out time is required'
  }
  if (requestType === 'time_correction' && !hasIn && !hasOut) {
    return 'Provide requested in or out time'
  }

  if (requestType === 'leave') {
    if (!requestForm.leaveTypeId) return 'Leave type is required'
    const leaveType = leaveTypes.value.find(item => item.id === requestForm.leaveTypeId)
    if (leaveType?.requiresAttachment && !requestForm.attachmentUrl.trim()) {
      return 'Attachment URL required for this leave type'
    }
  }

  if (requestType === 'overtime') {
    if (!requestForm.overtimeRuleId) return 'Overtime rule is required'
    const minutesValue = String(requestForm.minutes ?? '').trim()
    const minutes = minutesValue.length > 0 ? Number(minutesValue) : Number.NaN
    const hasMinutes = Number.isFinite(minutes) && minutes > 0
    const hasRange = hasIn && hasOut
    if (!hasMinutes && !hasRange) {
      return 'Overtime duration required'
    }
  }

  return null
}

async function submitRequest() {
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
      throw createApiError(response, data, 'Request failed')
    }
    setStatus('Request submitted.')
    await loadRequests()
  } catch (error: any) {
    setStatusFromError(error, 'Request failed', 'request-submit')
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
      throw createApiError(response, data, 'Request update failed')
    }
    setStatus(`Request ${action}d.`)
    await loadRequests()
    await loadSummary()
    await loadRecords()
  } catch (error: any) {
    setStatusFromError(error, 'Request update failed', 'request-resolve')
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
      throw createApiError(response, data, 'Request cancel failed')
    }
    setStatus('Request cancelled.')
    await loadRequests()
  } catch (error: any) {
    setStatusFromError(error, 'Request cancel failed', 'request-cancel')
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
      let message = 'Export failed'
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
    setStatus('Export ready.')
  } catch (error: any) {
    setStatus(error?.message || 'Export failed', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load settings')
    }
    adminForbidden.value = false
    applySettingsToForm(data.data || {})
  } catch (error: any) {
    setStatusFromError(error, 'Failed to load settings', 'admin')
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
      throw createApiError(response, data, 'Failed to save settings')
    }
    adminForbidden.value = false
    applySettingsToForm(data.data || payload)
    setStatus('Settings updated.')
  } catch (error: any) {
    setStatusFromError(error, 'Failed to save settings', 'save-settings')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Holiday sync failed')
    }
    if (data?.data?.lastRun) {
      holidaySyncLastRun.value = data.data.lastRun
    }
    setStatus(`Holiday sync complete (${data.data?.totalApplied ?? 0} applied).`)
  } catch (error: any) {
    setStatus(error?.message || 'Holiday sync failed', 'error')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Holiday sync failed')
    }
    if (data?.data?.lastRun) {
      holidaySyncLastRun.value = data.data.lastRun
    }
    setStatus(`Holiday sync complete (${data.data?.totalApplied ?? 0} applied).`)
  } catch (error: any) {
    setStatus(error?.message || 'Holiday sync failed', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load rule')
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
    setStatusFromError(error, 'Failed to load rule', 'admin')
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
      throw createApiError(response, data, 'Failed to save rule')
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
    setStatus('Rule updated.')
  } catch (error: any) {
    setStatusFromError(error, 'Failed to save rule', 'save-rule')
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
      throw new Error(data?.error?.message || 'Failed to load leave types')
    }
    adminForbidden.value = false
    leaveTypes.value = data.data.items || []
    if (!requestForm.leaveTypeId && leaveTypes.value.length > 0) {
      requestForm.leaveTypeId = leaveTypes.value[0].id
    }
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load leave types', 'error')
  } finally {
    leaveTypeLoading.value = false
  }
}

async function saveLeaveType() {
  leaveTypeSaving.value = true
  const isEditing = Boolean(leaveTypeEditingId.value)
  try {
    if (!leaveTypeForm.code.trim() || !leaveTypeForm.name.trim()) {
      throw new Error('Code and name are required')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save leave type')
    }
    adminForbidden.value = false
    await loadLeaveTypes()
    resetLeaveTypeForm()
    setStatus(isEditing ? 'Leave type updated.' : 'Leave type created.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save leave type', 'error')
  } finally {
    leaveTypeSaving.value = false
  }
}

async function deleteLeaveType(id: string) {
  if (!window.confirm('Delete this leave type?')) return
  try {
    const response = await apiFetch(`/api/attendance/leave-types/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to delete leave type')
    }
    adminForbidden.value = false
    await loadLeaveTypes()
    setStatus('Leave type deleted.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to delete leave type', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load overtime rules')
    }
    adminForbidden.value = false
    overtimeRules.value = data.data.items || []
    if (!requestForm.overtimeRuleId && overtimeRules.value.length > 0) {
      requestForm.overtimeRuleId = overtimeRules.value[0].id
    }
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load overtime rules', 'error')
  } finally {
    overtimeRuleLoading.value = false
  }
}

async function saveOvertimeRule() {
  overtimeRuleSaving.value = true
  const isEditing = Boolean(overtimeRuleEditingId.value)
  try {
    if (!overtimeRuleForm.name.trim()) {
      throw new Error('Name is required')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save overtime rule')
    }
    adminForbidden.value = false
    await loadOvertimeRules()
    resetOvertimeRuleForm()
    setStatus(isEditing ? 'Overtime rule updated.' : 'Overtime rule created.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save overtime rule', 'error')
  } finally {
    overtimeRuleSaving.value = false
  }
}

async function deleteOvertimeRule(id: string) {
  if (!window.confirm('Delete this overtime rule?')) return
  try {
    const response = await apiFetch(`/api/attendance/overtime-rules/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to delete overtime rule')
    }
    adminForbidden.value = false
    await loadOvertimeRules()
    setStatus('Overtime rule deleted.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to delete overtime rule', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load approval flows')
    }
    adminForbidden.value = false
    approvalFlows.value = data.data.items || []
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load approval flows', 'error')
  } finally {
    approvalFlowLoading.value = false
  }
}

async function saveApprovalFlow() {
  approvalFlowSaving.value = true
  const isEditing = Boolean(approvalFlowEditingId.value)
  try {
    if (!approvalFlowForm.name.trim()) {
      throw new Error('Name is required')
    }
    const steps = parseApprovalStepsInput(approvalFlowForm.steps)
    if (steps === null) {
      throw new Error('Invalid steps JSON')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save approval flow')
    }
    adminForbidden.value = false
    await loadApprovalFlows()
    resetApprovalFlowForm()
    setStatus(isEditing ? 'Approval flow updated.' : 'Approval flow created.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save approval flow', 'error')
  } finally {
    approvalFlowSaving.value = false
  }
}

async function deleteApprovalFlow(id: string) {
  if (!window.confirm('Delete this approval flow?')) return
  try {
    const response = await apiFetch(`/api/attendance/approval-flows/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to delete approval flow')
    }
    adminForbidden.value = false
    await loadApprovalFlows()
    setStatus('Approval flow deleted.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to delete approval flow', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load rotation rules')
    }
    adminForbidden.value = false
    rotationRules.value = data.data.items || []
    if (!rotationAssignmentForm.rotationRuleId && rotationRules.value.length > 0) {
      rotationAssignmentForm.rotationRuleId = rotationRules.value[0].id
    }
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load rotation rules', 'error')
  } finally {
    rotationRuleLoading.value = false
  }
}

async function saveRotationRule() {
  rotationRuleSaving.value = true
  const isEditing = Boolean(rotationRuleEditingId.value)
  try {
    if (!rotationRuleForm.name.trim()) {
      throw new Error('Name is required')
    }
    const shiftSequence = parseShiftSequenceInput(rotationRuleForm.shiftSequence)
    if (shiftSequence.length === 0) {
      throw new Error('Shift sequence required')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save rotation rule')
    }
    adminForbidden.value = false
    await loadRotationRules()
    resetRotationRuleForm()
    setStatus(isEditing ? 'Rotation rule updated.' : 'Rotation rule created.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save rotation rule', 'error')
  } finally {
    rotationRuleSaving.value = false
  }
}

async function deleteRotationRule(id: string) {
  if (!window.confirm('Delete this rotation rule?')) return
  try {
    const response = await apiFetch(`/api/attendance/rotation-rules/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to delete rotation rule')
    }
    adminForbidden.value = false
    await loadRotationRules()
    await loadRotationAssignments()
    setStatus('Rotation rule deleted.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to delete rotation rule', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load rotation assignments')
    }
    adminForbidden.value = false
    rotationAssignments.value = data.data.items || []
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load rotation assignments', 'error')
  } finally {
    rotationAssignmentLoading.value = false
  }
}

async function saveRotationAssignment() {
  rotationAssignmentSaving.value = true
  const isEditing = Boolean(rotationAssignmentEditingId.value)
  try {
    if (!rotationAssignmentForm.userId.trim()) {
      throw new Error('User ID is required')
    }
    if (!rotationAssignmentForm.rotationRuleId) {
      throw new Error('Rotation rule is required')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save rotation assignment')
    }
    adminForbidden.value = false
    await loadRotationAssignments()
    resetRotationAssignmentForm()
    setStatus(isEditing ? 'Rotation assignment updated.' : 'Rotation assignment created.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save rotation assignment', 'error')
  } finally {
    rotationAssignmentSaving.value = false
  }
}

async function deleteRotationAssignment(id: string) {
  if (!window.confirm('Delete this rotation assignment?')) return
  try {
    const response = await apiFetch(`/api/attendance/rotation-assignments/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to delete rotation assignment')
    }
    adminForbidden.value = false
    await loadRotationAssignments()
    setStatus('Rotation assignment deleted.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to delete rotation assignment', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load shifts')
    }
    adminForbidden.value = false
    shifts.value = data.data.items || []
    if (!assignmentForm.shiftId && shifts.value.length > 0) {
      assignmentForm.shiftId = shifts.value[0].id
    }
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load shifts', 'error')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save shift')
    }
    adminForbidden.value = false
    await loadShifts()
    resetShiftForm()
    setStatus(isEditing ? 'Shift updated.' : 'Shift created.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save shift', 'error')
  } finally {
    shiftSaving.value = false
  }
}

async function deleteShift(id: string) {
  if (!window.confirm('Delete this shift? Assignments will be removed.')) return
  try {
    const response = await apiFetch(`/api/attendance/shifts/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to delete shift')
    }
    adminForbidden.value = false
    await loadShifts()
    await loadAssignments()
    setStatus('Shift deleted.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to delete shift', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load assignments')
    }
    adminForbidden.value = false
    assignments.value = data.data.items || []
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load assignments', 'error')
  } finally {
    assignmentLoading.value = false
  }
}

async function saveAssignment() {
  assignmentSaving.value = true
  const isEditing = Boolean(assignmentEditingId.value)
  try {
    if (!assignmentForm.userId.trim()) {
      throw new Error('User ID is required')
    }
    if (!assignmentForm.shiftId) {
      throw new Error('Shift selection is required')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save assignment')
    }
    adminForbidden.value = false
    await loadAssignments()
    resetAssignmentForm()
    setStatus(isEditing ? 'Assignment updated.' : 'Assignment created.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save assignment', 'error')
  } finally {
    assignmentSaving.value = false
  }
}

async function deleteAssignment(id: string) {
  if (!window.confirm('Delete this assignment?')) return
  try {
    const response = await apiFetch(`/api/attendance/assignments/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to delete assignment')
    }
    adminForbidden.value = false
    await loadAssignments()
    setStatus('Assignment deleted.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to delete assignment', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load holidays')
    }
    holidays.value = data.data.items || []
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load holidays', 'error')
  } finally {
    holidayLoading.value = false
  }
}

async function saveHoliday() {
  holidaySaving.value = true
  const isEditing = Boolean(holidayEditingId.value)
  try {
    if (!holidayForm.date) {
      throw new Error('Holiday date is required')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save holiday')
    }
    adminForbidden.value = false
    await loadHolidays()
    resetHolidayForm()
    setStatus(isEditing ? 'Holiday updated.' : 'Holiday created.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save holiday', 'error')
  } finally {
    holidaySaving.value = false
  }
}

async function deleteHoliday(id: string) {
  if (!window.confirm('Delete this holiday?')) return
  try {
    const response = await apiFetch(`/api/attendance/holidays/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to delete holiday')
    }
    adminForbidden.value = false
    await loadHolidays()
    setStatus('Holiday deleted.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to delete holiday', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load rule sets')
    }
    adminForbidden.value = false
    ruleSets.value = data.data?.items ?? []
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load rule sets', 'error')
  } finally {
    ruleSetLoading.value = false
  }
}

async function saveRuleSet() {
  ruleSetSaving.value = true
  try {
    const config = parseJsonConfig(ruleSetForm.config)
    if (!config) {
      throw new Error('Rule set config must be valid JSON')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save rule set')
    }
    adminForbidden.value = false
    resetRuleSetForm()
    await loadRuleSets()
    setStatus('Rule set saved.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save rule set', 'error')
  } finally {
    ruleSetSaving.value = false
  }
}

async function deleteRuleSet(id: string) {
  if (!window.confirm('Delete this rule set?')) return
  try {
    const response = await apiFetch(`/api/attendance/rule-sets/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to delete rule set')
    }
    adminForbidden.value = false
    await loadRuleSets()
    setStatus('Rule set deleted.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to delete rule set', 'error')
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
  if (!ruleSetId) return 'Default'
  return ruleSets.value.find(item => item.id === ruleSetId)?.name ?? 'Default'
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
      throw new Error(data?.error?.message || 'Failed to load attendance groups')
    }
    adminForbidden.value = false
    attendanceGroups.value = data.data?.items ?? []
    if (!attendanceGroupMemberGroupId.value && attendanceGroups.value.length > 0) {
      attendanceGroupMemberGroupId.value = attendanceGroups.value[0].id
    }
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load attendance groups', 'error')
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
      throw new Error('Attendance group name is required')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save attendance group')
    }
    adminForbidden.value = false
    resetAttendanceGroupForm()
    await loadAttendanceGroups()
    setStatus('Attendance group saved.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save attendance group', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load group members')
    }
    adminForbidden.value = false
    attendanceGroupMembers.value = data.data?.items ?? []
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load group members', 'error')
  } finally {
    attendanceGroupMemberLoading.value = false
  }
}

async function addAttendanceGroupMembers() {
  const groupId = attendanceGroupMemberGroupId.value
  const userIds = parseUserIdList(attendanceGroupMemberUserIds.value)
  if (!groupId) {
    setStatus('Select an attendance group first.', 'error')
    return
  }
  if (userIds.length === 0) {
    setStatus('Enter at least one user ID.', 'error')
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
      throw new Error(data?.error?.message || 'Failed to add group members')
    }
    adminForbidden.value = false
    attendanceGroupMemberUserIds.value = ''
    await loadAttendanceGroupMembers()
    setStatus('Group members added.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to add group members', 'error')
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
      throw new Error(data?.error?.message || 'Failed to remove group member')
    }
    adminForbidden.value = false
    await loadAttendanceGroupMembers()
    setStatus('Group member removed.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to remove group member', 'error')
  } finally {
    attendanceGroupMemberSaving.value = false
  }
}

async function deleteAttendanceGroup(id: string) {
  if (!window.confirm('Delete this attendance group?')) return
  try {
    const response = await apiFetch(`/api/attendance/groups/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to delete attendance group')
    }
    adminForbidden.value = false
    await loadAttendanceGroups()
    setStatus('Attendance group deleted.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to delete attendance group', 'error')
  }
}

async function loadRuleSetTemplate() {
  try {
    const response = await apiFetch('/api/attendance/rule-sets/template')
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to load rule set template')
    }
    ruleSetForm.config = JSON.stringify(data.data ?? {}, null, 2)
    setStatus('Rule set template loaded.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load rule set template', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load rule templates')
    }
    adminForbidden.value = false
    const systemTemplates = data.data?.system ?? []
    const libraryTemplates = data.data?.library ?? []
    ruleTemplateVersions.value = Array.isArray(data.data?.versions) ? data.data.versions : []
    ruleTemplateSystemText.value = JSON.stringify(systemTemplates, null, 2)
    ruleTemplateLibraryText.value = JSON.stringify(libraryTemplates, null, 2)
    setStatus('Rule templates loaded.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load rule templates', 'error')
  } finally {
    ruleTemplateLoading.value = false
  }
}

async function saveRuleTemplates() {
  ruleTemplateSaving.value = true
  try {
    const templates = parseTemplateLibrary(ruleTemplateLibraryText.value)
    if (!templates) {
      throw new Error('Template library must be valid JSON array')
    }
    const validation = validateTemplateLibrarySchema(templates)
    if (!validation.ok) {
      const preview = validation.errors.slice(0, 3).join('; ')
      throw new Error(`Template schema errors: ${preview}`)
    }
    const response = await apiFetch('/api/attendance/rule-templates', {
      method: 'PUT',
      body: JSON.stringify({ templates }),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save rule templates')
    }
    adminForbidden.value = false
    ruleTemplateLibraryText.value = JSON.stringify(data.data?.templates ?? templates, null, 2)
    setStatus('Rule templates saved.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save rule templates', 'error')
  } finally {
    ruleTemplateSaving.value = false
  }
}

async function restoreRuleTemplates(versionId: string) {
  if (!versionId) return
  if (!window.confirm('Restore this template version? This will overwrite the current library.')) return
  ruleTemplateRestoring.value = true
  try {
    const response = await apiFetch('/api/attendance/rule-templates/restore', {
      method: 'POST',
      body: JSON.stringify({ versionId }),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to restore rule templates')
    }
    adminForbidden.value = false
    ruleTemplateLibraryText.value = JSON.stringify(data.data?.templates ?? [], null, 2)
    await loadRuleTemplates()
    setStatus('Rule templates restored.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to restore rule templates', 'error')
  } finally {
    ruleTemplateRestoring.value = false
  }
}

function copySystemTemplates() {
  ruleTemplateLibraryText.value = ruleTemplateSystemText.value
  setStatus('System templates copied to library.')
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
      throw new Error(data?.error?.message || 'Failed to load payroll templates')
    }
    adminForbidden.value = false
    payrollTemplates.value = data.data?.items ?? []
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load payroll templates', 'error')
  } finally {
    payrollTemplateLoading.value = false
  }
}

async function savePayrollTemplate() {
  payrollTemplateSaving.value = true
  try {
    const config = parseJsonConfig(payrollTemplateForm.config)
    if (!config) {
      throw new Error('Payroll template config must be valid JSON')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save payroll template')
    }
    adminForbidden.value = false
    resetPayrollTemplateForm()
    await loadPayrollTemplates()
    setStatus('Payroll template saved.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save payroll template', 'error')
  } finally {
    payrollTemplateSaving.value = false
  }
}

async function deletePayrollTemplate(id: string) {
  if (!window.confirm('Delete this payroll template?')) return
  try {
    const response = await apiFetch(`/api/attendance/payroll-templates/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to delete payroll template')
    }
    adminForbidden.value = false
    await loadPayrollTemplates()
    setStatus('Payroll template deleted.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to delete payroll template', 'error')
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
      throw new Error(data?.error?.message || 'Failed to load payroll cycles')
    }
    adminForbidden.value = false
    payrollCycles.value = data.data?.items ?? []
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load payroll cycles', 'error')
  } finally {
    payrollCycleLoading.value = false
  }
}

async function generatePayrollCycles() {
  payrollCycleGenerating.value = true
  try {
    const anchorDate = payrollCycleGenerateForm.anchorDate
    if (!anchorDate) {
      throw new Error('Anchor date is required for generation')
    }

    const metadata = parseJsonConfig(payrollCycleGenerateForm.metadata)
    if (!metadata) {
      throw new Error('Metadata must be valid JSON')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to generate payroll cycles')
    }

    const created = Array.isArray(data.data?.created) ? data.data.created.length : 0
    const skipped = Array.isArray(data.data?.skipped) ? data.data.skipped.length : 0
    payrollCycleGenerateResult.value = { created, skipped }
    adminForbidden.value = false
    await loadPayrollCycles()
    setStatus('Payroll cycles generated.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to generate payroll cycles', 'error')
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
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save payroll cycle')
    }
    adminForbidden.value = false
    resetPayrollCycleForm()
    await loadPayrollCycles()
    setStatus('Payroll cycle saved.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save payroll cycle', 'error')
  } finally {
    payrollCycleSaving.value = false
  }
}

async function deletePayrollCycle(id: string) {
  if (!window.confirm('Delete this payroll cycle?')) return
  try {
    const response = await apiFetch(`/api/attendance/payroll-cycles/${id}`, { method: 'DELETE' })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to delete payroll cycle')
    }
    adminForbidden.value = false
    await loadPayrollCycles()
    payrollCycleSummary.value = null
    setStatus('Payroll cycle deleted.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to delete payroll cycle', 'error')
  }
}

async function loadPayrollCycleSummary() {
  const cycleId = payrollCycleEditingId.value
  if (!cycleId) {
    setStatus('Select or create a payroll cycle first.', 'error')
    return
  }
  try {
    const query = buildQuery({ orgId: normalizedOrgId(), userId: normalizedUserId() })
    const response = await apiFetch(`/api/attendance/payroll-cycles/${cycleId}/summary?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to load payroll summary')
    }
    payrollCycleSummary.value = data.data?.summary ?? null
    setStatus('Payroll summary loaded.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load payroll summary', 'error')
  }
}

async function exportPayrollCycleSummary() {
  const cycleId = payrollCycleEditingId.value
  if (!cycleId) {
    setStatus('Select or create a payroll cycle first.', 'error')
    return
  }
  try {
    const query = buildQuery({ orgId: normalizedOrgId(), userId: normalizedUserId() })
    const response = await apiFetch(`/api/attendance/payroll-cycles/${cycleId}/summary/export?${query.toString()}`)
    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || 'Failed to export payroll summary')
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
    setStatus('Payroll summary exported.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to export payroll summary', 'error')
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
    setStatusFromError(error, 'Failed to load admin data', 'admin')
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

  .attendance__request-meta {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
