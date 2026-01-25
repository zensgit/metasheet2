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
      <header class="attendance__header">
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

      <section class="attendance__filters">
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
        <span v-if="statusMessage" class="attendance__status" :class="{ 'attendance__status--error': statusKind === 'error' }">
          {{ statusMessage }}
        </span>
      </section>

      <div v-if="authRequired" class="attendance__card attendance__card--empty attendance__card--auth">
        <h3>Authentication required</h3>
        <p class="attendance__empty">{{ authMessage }}</p>
        <div class="attendance__auth-actions">
          <button class="attendance__btn" :disabled="loading" @click="refreshAll">Retry</button>
        </div>
      </div>

      <section class="attendance__grid">
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
              </select>
            </label>
            <label class="attendance__field" for="attendance-request-in">
              <span>Requested in</span>
              <input
                id="attendance-request-in"
                name="requestedInAt"
                v-model="requestForm.requestedInAt"
                type="datetime-local"
              />
            </label>
            <label class="attendance__field" for="attendance-request-out">
              <span>Requested out</span>
              <input
                id="attendance-request-out"
                name="requestedOutAt"
                v-model="requestForm.requestedOutAt"
                type="datetime-local"
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
                <div class="attendance__request-meta">
                  <span>In: {{ formatDateTime(item.requested_in_at) }}</span>
                  <span>Out: {{ formatDateTime(item.requested_out_at) }}</span>
                </div>
                <div class="attendance__request-actions" v-if="item.status === 'pending'">
                  <button class="attendance__btn" @click="resolveRequest(item.id, 'approve')">Approve</button>
                  <button class="attendance__btn attendance__btn--danger" @click="resolveRequest(item.id, 'reject')">Reject</button>
                </div>
              </li>
            </ul>
          </div>
        </div>

        <div class="attendance__card attendance__card--admin">
          <div class="attendance__admin-header">
            <h3>Admin Console</h3>
            <button class="attendance__btn" :disabled="settingsLoading || ruleLoading" @click="loadAdminData">
              {{ settingsLoading || ruleLoading ? 'Loading...' : 'Reload admin' }}
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

      <section class="attendance__card">
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
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { usePlugins } from '../composables/usePlugins'
import { apiFetch as rawApiFetch } from '../utils/api'

interface AttendanceSummary {
  total_days: number
  total_minutes: number
  normal_days: number
  late_days: number
  early_leave_days: number
  late_early_days: number
  partial_days: number
  absent_days: number
  adjusted_days: number
  off_days: number
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
}

interface AttendanceRequest {
  id: string
  work_date: string
  request_type: string
  requested_in_at: string | null
  requested_out_at: string | null
  status: string
}

interface AttendanceSettings {
  autoAbsence?: {
    enabled?: boolean
    runAt?: string
    lookbackDays?: number
  }
  ipAllowlist?: string[]
  geoFence?: {
    lat: number
    lng: number
    radiusMeters: number
  } | null
  minPunchIntervalMinutes?: number
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

interface CalendarDay {
  key: string
  day: number
  isToday: boolean
  isCurrentMonth: boolean
  status?: string
  statusLabel?: string
  tooltip: string
}

const loading = ref(false)
const punching = ref(false)
const requestSubmitting = ref(false)
const summary = ref<AttendanceSummary | null>(null)
const records = ref<AttendanceRecord[]>([])
const requests = ref<AttendanceRequest[]>([])
const statusMessage = ref('')
const statusKind = ref<'info' | 'error'>('info')
const AUTH_REQUIRED_MESSAGE =
  'Authentication required. Please login and refresh. If you already have a token, set localStorage auth_token and reload.'
const authRequired = ref(false)
const authMessage = ref(AUTH_REQUIRED_MESSAGE)
const calendarMonth = ref(new Date())
const exporting = ref(false)
const settingsLoading = ref(false)
const ruleLoading = ref(false)
const shiftLoading = ref(false)
const shiftSaving = ref(false)
const assignmentLoading = ref(false)
const assignmentSaving = ref(false)
const holidayLoading = ref(false)
const holidaySaving = ref(false)
const adminForbidden = ref(false)
const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const shifts = ref<AttendanceShift[]>([])
const assignments = ref<AttendanceAssignmentItem[]>([])
const holidays = ref<AttendanceHoliday[]>([])

const shiftEditingId = ref<string | null>(null)
const assignmentEditingId = ref<string | null>(null)
const holidayEditingId = ref<string | null>(null)

const orgId = ref('')
const targetUserId = ref('')

const { plugins, fetchPlugins, loading: pluginsLoading, loaded: pluginsLoaded, error: pluginsError } = usePlugins()
const attendancePluginNames = new Set(['plugin-attendance', '@metasheet/plugin-attendance'])
const attendancePluginEntry = computed(() => {
  return plugins.value.find(plugin => attendancePluginNames.has(plugin.name)) ?? null
})
const attendancePluginActive = computed(() => attendancePluginEntry.value?.status === 'active')
const pluginFailed = computed(() => pluginsLoaded.value && attendancePluginEntry.value?.status === 'failed')
const pluginLoading = computed(() => !pluginsLoaded.value || pluginsLoading.value)
const pluginMissing = computed(() => pluginsLoaded.value && !attendancePluginActive.value)
const pluginErrorMessage = computed(() => pluginsError.value)

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
})

const settingsForm = reactive({
  autoAbsenceEnabled: false,
  autoAbsenceRunAt: '00:15',
  autoAbsenceLookbackDays: 1,
  ipAllowlist: '',
  geoFenceLat: '',
  geoFenceLng: '',
  geoFenceRadius: '',
  minPunchIntervalMinutes: 1,
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

function formatRequestType(value: string): string {
  const map: Record<string, string> = {
    missed_check_in: 'Missed check-in',
    missed_check_out: 'Missed check-out',
    time_correction: 'Time correction',
  }
  return map[value] ?? value
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

function setStatus(message: string, kind: 'info' | 'error' = 'info') {
  statusMessage.value = message
  statusKind.value = kind
  if (!message) return
  window.setTimeout(() => {
    if (statusMessage.value === message) {
      statusMessage.value = ''
    }
  }, 4000)
}

function setAuthRequired(message = AUTH_REQUIRED_MESSAGE) {
  authRequired.value = true
  authMessage.value = message
  summary.value = null
  records.value = []
  requests.value = []
  recordsTotal.value = 0
}

function clearAuthRequired() {
  authRequired.value = false
}

async function attendanceFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const response = await rawApiFetch(path, options)
  if (response.status === 401) {
    setAuthRequired()
    throw new Error(AUTH_REQUIRED_MESSAGE)
  }
  if (response.ok) {
    clearAuthRequired()
  }
  return response
}

async function punch(eventType: 'check_in' | 'check_out') {
  punching.value = true
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const payload: Record<string, string> = { eventType, timezone }
    const orgValue = normalizedOrgId()
    if (orgValue) payload.orgId = orgValue
    const response = await attendanceFetch('/api/attendance/punch', {
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
  const response = await attendanceFetch(`/api/attendance/summary?${query.toString()}`)
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
  const response = await attendanceFetch(`/api/attendance/records?${query.toString()}`)
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
  const response = await attendanceFetch(`/api/attendance/requests?${query.toString()}`)
  const data = await response.json()
  if (!response.ok || !data.ok) {
    throw new Error(data?.error?.message || 'Failed to load requests')
  }
  requests.value = data.data.items
}

async function refreshAll() {
  if (!attendancePluginActive.value) return
  clearAuthRequired()
  loading.value = true
  recordsPage.value = 1
  calendarMonth.value = new Date(`${toDate.value}T00:00:00`)
  try {
    await Promise.all([loadSummary(), loadRecords(), loadRequests(), loadHolidays()])
  } catch (error: any) {
    setStatus(error?.message || 'Refresh failed', 'error')
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

async function submitRequest() {
  requestSubmitting.value = true
  try {
    const orgValue = normalizedOrgId()
    const payload = {
      workDate: requestForm.workDate,
      requestType: requestForm.requestType,
      requestedInAt: requestForm.requestedInAt || undefined,
      requestedOutAt: requestForm.requestedOutAt || undefined,
      reason: requestForm.reason || undefined,
      orgId: orgValue,
    }
    const response = await attendanceFetch('/api/attendance/requests', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Request failed')
    }
    setStatus('Request submitted.')
    await loadRequests()
  } catch (error: any) {
    setStatus(error?.message || 'Request failed', 'error')
  } finally {
    requestSubmitting.value = false
  }
}

async function resolveRequest(id: string, action: 'approve' | 'reject') {
  try {
    const response = await attendanceFetch(`/api/attendance/requests/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify({})
    })
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Request update failed')
    }
    setStatus(`Request ${action}d.`)
    await loadRequests()
    await loadSummary()
    await loadRecords()
  } catch (error: any) {
    setStatus(error?.message || 'Request update failed', 'error')
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
    const response = await attendanceFetch(`/api/attendance/export?${query.toString()}`)
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

function applySettingsToForm(settings: AttendanceSettings) {
  settingsForm.autoAbsenceEnabled = Boolean(settings.autoAbsence?.enabled)
  settingsForm.autoAbsenceRunAt = settings.autoAbsence?.runAt || '00:15'
  settingsForm.autoAbsenceLookbackDays = settings.autoAbsence?.lookbackDays || 1
  settingsForm.ipAllowlist = (settings.ipAllowlist || []).join('\n')
  settingsForm.geoFenceLat = settings.geoFence?.lat?.toString() ?? ''
  settingsForm.geoFenceLng = settings.geoFence?.lng?.toString() ?? ''
  settingsForm.geoFenceRadius = settings.geoFence?.radiusMeters?.toString() ?? ''
  settingsForm.minPunchIntervalMinutes = settings.minPunchIntervalMinutes ?? 1
}

async function loadSettings() {
  settingsLoading.value = true
  try {
    const response = await attendanceFetch('/api/attendance/settings')
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
    setStatus(error?.message || 'Failed to load settings', 'error')
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

    const payload: AttendanceSettings = {
      autoAbsence: {
        enabled: settingsForm.autoAbsenceEnabled,
        runAt: settingsForm.autoAbsenceRunAt || '00:15',
        lookbackDays: Number(settingsForm.autoAbsenceLookbackDays) || 1,
      },
      ipAllowlist,
      geoFence,
      minPunchIntervalMinutes: Number(settingsForm.minPunchIntervalMinutes) || 0,
    }

    const response = await attendanceFetch('/api/attendance/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save settings')
    }
    adminForbidden.value = false
    applySettingsToForm(data.data || payload)
    setStatus('Settings updated.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to save settings', 'error')
  } finally {
    settingsLoading.value = false
  }
}

async function loadRule() {
  ruleLoading.value = true
  try {
    const query = buildQuery({ orgId: normalizedOrgId() })
    const response = await attendanceFetch(`/api/attendance/rules/default?${query.toString()}`)
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
    setStatus(error?.message || 'Failed to load rule', 'error')
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
    const response = await attendanceFetch('/api/attendance/rules/default', {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save rule')
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
    setStatus(error?.message || 'Failed to save rule', 'error')
  } finally {
    ruleLoading.value = false
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
    const response = await attendanceFetch(`/api/attendance/shifts?${query.toString()}`)
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
    const response = await attendanceFetch(endpoint, {
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
    const response = await attendanceFetch(`/api/attendance/shifts/${id}`, { method: 'DELETE' })
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
    const response = await attendanceFetch(`/api/attendance/assignments?${query.toString()}`)
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
    const response = await attendanceFetch(endpoint, {
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
    const response = await attendanceFetch(`/api/attendance/assignments/${id}`, { method: 'DELETE' })
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
    const response = await attendanceFetch(`/api/attendance/holidays?${query.toString()}`)
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
    const response = await attendanceFetch(endpoint, {
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
    const response = await attendanceFetch(`/api/attendance/holidays/${id}`, { method: 'DELETE' })
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

async function loadAdminData() {
  await Promise.all([loadSettings(), loadRule(), loadShifts(), loadAssignments(), loadHolidays()])
}

onMounted(() => {
  fetchPlugins()
    .then(() => {
      if (attendancePluginActive.value) {
        refreshAll()
        loadAdminData()
      }
    })
    .catch(() => null)
})

watch(orgId, () => {
  if (attendancePluginActive.value) {
    refreshAll()
    loadAdminData()
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

.attendance__card--auth {
  border-color: #f2b8b5;
  background: #fff5f5;
}

.attendance__auth-actions {
  display: flex;
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
