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
              <div class="attendance__template-panel">
                <div class="attendance__template-group">
                  <div class="attendance__template-header">
                    <span>System templates</span>
                    <span class="attendance__tag attendance__tag--locked">Locked</span>
                  </div>
                  <div v-if="ruleSetSystemTemplates.length === 0" class="attendance__empty">
                    No system templates detected.
                  </div>
                  <ul v-else class="attendance__template-list">
                    <li
                      v-for="tpl in ruleSetSystemTemplates"
                      :key="tpl.name"
                      class="attendance__template-item"
                      :class="{ 'attendance__template-item--active': tpl.name === selectedSystemTemplateName }"
                    >
                      <div>
                        <div class="attendance__template-name">{{ tpl.name }}</div>
                        <div class="attendance__template-meta">Rules: {{ tpl.rules?.length ?? 0 }}</div>
                      </div>
                      <button class="attendance__btn attendance__btn--sm" type="button" @click="selectSystemTemplate(tpl)">
                        Use
                      </button>
                    </li>
                  </ul>
                </div>
                <div class="attendance__template-group">
                  <div class="attendance__template-header">
                    <span>Custom templates</span>
                    <div class="attendance__template-header-actions">
                      <span class="attendance__tag attendance__tag--editable">Editable</span>
                      <button class="attendance__btn attendance__btn--sm" type="button" @click="createCustomTemplate">
                        New
                      </button>
                    </div>
                  </div>
                  <div v-if="ruleSetCustomTemplates.length === 0" class="attendance__empty">
                    No custom templates yet.
                  </div>
                  <ul v-else class="attendance__template-list">
                    <li v-for="tpl in ruleSetCustomTemplates" :key="tpl.name" class="attendance__template-item">
                      <div class="attendance__template-name">{{ tpl.name }}</div>
                      <div class="attendance__template-meta">Rules: {{ tpl.rules?.length ?? 0 }}</div>
                      <button class="attendance__btn attendance__btn--sm" type="button" @click="openCustomTemplateEditor(tpl)">
                        Edit rules
                      </button>
                    </li>
                  </ul>
                </div>
                <div class="attendance__template-group">
                  <div class="attendance__template-header">
                    <span>Template library</span>
                    <div class="attendance__template-header-actions">
                      <button class="attendance__btn attendance__btn--sm" type="button" @click="loadTemplateLibrary">
                        {{ templateLibraryLoading ? 'Loading...' : 'Reload' }}
                      </button>
                    </div>
                  </div>
                  <div v-if="templateLibraryLoading" class="attendance__empty">Loading library...</div>
                  <div v-else-if="libraryTemplates.length === 0" class="attendance__empty">
                    No library templates yet.
                  </div>
                  <ul v-else class="attendance__template-list">
                    <li v-for="tpl in libraryTemplates" :key="tpl.name" class="attendance__template-item">
                      <div>
                        <div class="attendance__template-name">{{ tpl.name }}</div>
                        <div class="attendance__template-meta">Rules: {{ tpl.rules?.length ?? 0 }}</div>
                      </div>
                      <div class="attendance__template-actions">
                        <button class="attendance__btn attendance__btn--sm" type="button" @click="applyLibraryTemplate(tpl)">
                          Use
                        </button>
                        <button class="attendance__btn attendance__btn--danger attendance__btn--sm" type="button" @click="removeLibraryTemplate(tpl.name)">
                          Delete
                        </button>
                      </div>
                    </li>
                  </ul>
                </div>
              </div>
              <div class="attendance__template-hint">
                System templates are locked. Custom templates can be promoted into the shared library for reuse.
              </div>
              <div v-if="selectedSystemTemplate" class="attendance__template-params">
                <div class="attendance__template-editor-header">
                  <div>
                    <div class="attendance__template-editor-title">Template parameters</div>
                    <div class="attendance__template-editor-name">{{ selectedSystemTemplate.name }}</div>
                  </div>
                  <button class="attendance__btn attendance__btn--sm" type="button" @click="resetTemplateParams(selectedSystemTemplate)">
                    Reset
                  </button>
                </div>
                <input
                  ref="templateParamFileInput"
                  type="file"
                  accept="application/json"
                  class="attendance__file-input"
                  @change="handleTemplateParamFile"
                />
                <div class="attendance__admin-grid">
                  <div v-if="!selectedSystemTemplate.params || selectedSystemTemplate.params.length === 0" class="attendance__empty">
                    No parameters for this template.
                  </div>
                  <template v-else>
                    <label
                      v-for="param in selectedSystemTemplate.params"
                      :key="param.key"
                      class="attendance__field"
                      :for="`attendance-template-param-${param.key}`"
                    >
                      <span>{{ param.label }}</span>
                      <input
                        v-if="param.type === 'number'"
                        :id="`attendance-template-param-${param.key}`"
                        v-model.number="templateParamValues[param.key]"
                        type="number"
                      />
                      <input
                        v-else-if="param.type === 'boolean'"
                        :id="`attendance-template-param-${param.key}`"
                        v-model="templateParamValues[param.key]"
                        type="checkbox"
                      />
                      <textarea
                        v-else-if="param.type === 'stringArray'"
                        :id="`attendance-template-param-${param.key}`"
                        v-model="templateParamValues[param.key]"
                        rows="2"
                        placeholder="Comma or newline separated"
                      />
                      <input
                        v-else
                        :id="`attendance-template-param-${param.key}`"
                        v-model="templateParamValues[param.key]"
                        type="text"
                      />
                      <small v-if="param.description" class="attendance__field-hint">{{ param.description }}</small>
                    </label>
                  </template>
                </div>
                <label class="attendance__field attendance__field--full" for="attendance-template-param-json">
                  <span>Params JSON</span>
                  <textarea
                    id="attendance-template-param-json"
                    v-model="templateParamJson"
                    rows="4"
                    placeholder='{"template":"...","params":{"lateAfter":"09:10"}}'
                  />
                </label>
                <div class="attendance__admin-actions">
                  <button class="attendance__btn attendance__btn--primary" type="button" @click="applySystemTemplate">
                    Create custom template
                  </button>
                  <button class="attendance__btn" type="button" @click="exportTemplateParams">
                    Export params
                  </button>
                  <button class="attendance__btn" type="button" @click="exportTemplateParamsFile">
                    Export file
                  </button>
                  <button class="attendance__btn" type="button" @click="importTemplateParams">
                    Import params
                  </button>
                  <button class="attendance__btn" type="button" @click="triggerTemplateParamFile">
                    Import file
                  </button>
                </div>
              </div>
              <div v-if="customTemplateEditingName" class="attendance__template-editor">
                <div class="attendance__template-editor-header">
                  <div>
                    <div class="attendance__template-editor-title">Editing custom template</div>
                    <div class="attendance__template-editor-name">{{ customTemplateEditingName }}</div>
                  </div>
                  <button class="attendance__btn attendance__btn--sm" type="button" @click="closeCustomTemplateEditor">
                    Close
                  </button>
                </div>
                <div class="attendance__admin-grid">
                  <label class="attendance__field" for="attendance-custom-template-description">
                    <span>Description</span>
                    <input
                      id="attendance-custom-template-description"
                      v-model="customTemplateDraftDescription"
                      type="text"
                      placeholder="Optional description"
                    />
                  </label>
                </div>
                <div class="attendance__template-rules">
                  <div v-if="customTemplateDraftRules.length === 0" class="attendance__empty">
                    No rules yet. Add your first rule below.
                  </div>
                  <div v-for="(rule, index) in customTemplateDraftRules" :key="rule.key" class="attendance__template-rule">
                    <label class="attendance__field" :for="`attendance-custom-rule-id-${rule.key}`">
                      <span>Rule ID</span>
                      <input :id="`attendance-custom-rule-id-${rule.key}`" v-model="rule.id" type="text" />
                    </label>
                    <label class="attendance__field attendance__field--full" :for="`attendance-custom-rule-when-${rule.key}`">
                      <span>When (JSON)</span>
                      <textarea
                        :id="`attendance-custom-rule-when-${rule.key}`"
                        v-model="rule.whenText"
                        rows="4"
                        placeholder='{\"clockIn1_exists\": true}'
                      />
                    </label>
                    <label class="attendance__field attendance__field--full" :for="`attendance-custom-rule-then-${rule.key}`">
                      <span>Then (JSON)</span>
                      <textarea
                        :id="`attendance-custom-rule-then-${rule.key}`"
                        v-model="rule.thenText"
                        rows="4"
                        placeholder='{\"warning\": \"...\"}'
                      />
                    </label>
                    <div class="attendance__template-rule-actions">
                      <button
                        class="attendance__btn attendance__btn--danger attendance__btn--sm"
                        type="button"
                        @click="removeCustomRule(index)"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
                <div class="attendance__admin-actions">
                  <button class="attendance__btn" type="button" @click="addCustomRule">Add rule</button>
                  <button class="attendance__btn" type="button" @click="insertCustomRuleSamples">
                    Insert examples
                  </button>
                  <button class="attendance__btn attendance__btn--primary" type="button" @click="saveCustomTemplate">
                    Save template
                  </button>
                  <button class="attendance__btn" type="button" @click="saveCustomTemplateToLibrary">
                    Save to library
                  </button>
                </div>
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
                <h4>Rule Preview (Engine)</h4>
                <button class="attendance__btn" :disabled="rulePreviewLoading" @click="runRulePreview">
                  {{ rulePreviewLoading ? 'Running...' : 'Run preview' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-preview-rule-set">
                  <span>Rule set</span>
                  <select
                    id="attendance-preview-rule-set"
                    v-model="rulePreviewForm.ruleSetId"
                    :disabled="ruleSets.length === 0"
                  >
                    <option value="">(Optional) Use default rule</option>
                    <option v-for="item in ruleSets" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-preview-user">
                  <span>User ID</span>
                  <input
                    id="attendance-preview-user"
                    v-model="rulePreviewForm.userId"
                    type="text"
                    placeholder="Required"
                  />
                </label>
                <label class="attendance__field" for="attendance-preview-work-date">
                  <span>Work date</span>
                  <input id="attendance-preview-work-date" v-model="rulePreviewForm.workDate" type="date" />
                </label>
                <label class="attendance__field" for="attendance-preview-clock-in">
                  <span>Clock in</span>
                  <input id="attendance-preview-clock-in" v-model="rulePreviewForm.clockInAt" type="time" />
                </label>
                <label class="attendance__field" for="attendance-preview-clock-out">
                  <span>Clock out</span>
                  <input id="attendance-preview-clock-out" v-model="rulePreviewForm.clockOutAt" type="time" />
                </label>
                <label class="attendance__field" for="attendance-preview-shift">
                  <span>Shift name</span>
                  <input id="attendance-preview-shift" v-model="rulePreviewForm.shiftName" type="text" />
                </label>
                <label class="attendance__field" for="attendance-preview-group">
                  <span>Attendance group</span>
                  <input id="attendance-preview-group" v-model="rulePreviewForm.attendanceGroup" type="text" />
                </label>
                <label class="attendance__field" for="attendance-preview-role-tags">
                  <span>Role tags</span>
                  <input
                    id="attendance-preview-role-tags"
                    v-model="rulePreviewForm.roleTags"
                    type="text"
                    placeholder="security,driver"
                  />
                </label>
                <label class="attendance__field" for="attendance-preview-dept">
                  <span>Department</span>
                  <input id="attendance-preview-dept" v-model="rulePreviewForm.department" type="text" />
                </label>
                <label class="attendance__field" for="attendance-preview-exception">
                  <span>Exception reason</span>
                  <input id="attendance-preview-exception" v-model="rulePreviewForm.exceptionReason" type="text" />
                </label>
                <label class="attendance__field" for="attendance-preview-work-hours">
                  <span>Actual hours</span>
                  <input id="attendance-preview-work-hours" v-model="rulePreviewForm.actualHours" type="number" min="0" />
                </label>
                <label class="attendance__field" for="attendance-preview-overtime">
                  <span>Overtime hours</span>
                  <input id="attendance-preview-overtime" v-model="rulePreviewForm.overtimeHours" type="number" min="0" />
                </label>
                <label class="attendance__field" for="attendance-preview-leave">
                  <span>Leave hours</span>
                  <input id="attendance-preview-leave" v-model="rulePreviewForm.leaveHours" type="number" min="0" />
                </label>
                <label class="attendance__field attendance__field--checkbox">
                  <span>Use current config</span>
                  <input v-model="rulePreviewForm.useCurrentConfig" type="checkbox" />
                </label>
              </div>
              <div v-if="rulePreviewResult" class="attendance__preview-card">
                <div class="attendance__preview-grid">
                  <div>
                    <div class="attendance__preview-label">Status</div>
                    <div>{{ formatStatus(rulePreviewResult.status) }}</div>
                  </div>
                  <div>
                    <div class="attendance__preview-label">Work minutes</div>
                    <div>{{ rulePreviewResult.workMinutes }}</div>
                  </div>
                  <div>
                    <div class="attendance__preview-label">Late minutes</div>
                    <div>{{ rulePreviewResult.lateMinutes }}</div>
                  </div>
                  <div>
                    <div class="attendance__preview-label">Early leave</div>
                    <div>{{ rulePreviewResult.earlyLeaveMinutes }}</div>
                  </div>
                  <div>
                    <div class="attendance__preview-label">Leave minutes</div>
                    <div>{{ rulePreviewResult.leaveMinutes ?? 0 }}</div>
                  </div>
                  <div>
                    <div class="attendance__preview-label">Overtime minutes</div>
                    <div>{{ rulePreviewResult.overtimeMinutes ?? 0 }}</div>
                  </div>
                </div>
                <div v-if="rulePreviewResult.engine" class="attendance__preview-engine">
                  <div class="attendance__preview-label">Applied rules</div>
                  <div>{{ formatList(rulePreviewResult.engine.appliedRules) }}</div>
                  <div class="attendance__preview-label">Warnings</div>
                  <div>{{ formatList(rulePreviewResult.engine.warnings) }}</div>
                  <div class="attendance__preview-label">Reasons</div>
                  <div>{{ formatList(rulePreviewResult.engine.reasons) }}</div>
                  <div class="attendance__preview-label">Overrides</div>
                  <pre class="attendance__preview-json">{{ formatJson(rulePreviewResult.engine.overrides) }}</pre>
                  <div class="attendance__preview-label">Base metrics</div>
                  <pre class="attendance__preview-json">{{ formatJson(rulePreviewResult.engine.base) }}</pre>
                </div>
              </div>
              <div v-else class="attendance__empty">No preview run yet.</div>
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
                    userMap profile fields supported: attendanceGroup, department, role, roleTags, entryTime, resignTime.
                  </small>
                </label>
              </div>
              <div class="attendance__admin-actions">
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
              <div v-if="importPreview.length === 0" class="attendance__empty">No preview data.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Work date</th>
                      <th>Work minutes</th>
                      <th>Late</th>
                      <th>Early leave</th>
                      <th>Status</th>
                      <th>Warnings</th>
                      <th>Policies</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in importPreview" :key="`${item.userId}::${item.workDate}`">
                      <td>{{ formatShortId(item.userId) }}</td>
                      <td>{{ item.workDate }}</td>
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

              <div class="attendance__requests-header">
                <h4>Import Batches</h4>
                <button class="attendance__btn" :disabled="importBatchesLoading" @click="loadImportBatches(importBatchesPage)">
                  {{ importBatchesLoading ? 'Loading...' : 'Reload' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-import-batch-status">
                  <span>Status</span>
                  <select id="attendance-import-batch-status" v-model="importBatchStatusFilter">
                    <option value="all">All</option>
                    <option value="committed">committed</option>
                    <option value="rolled_back">rolled_back</option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-import-batch-search">
                  <span>Search</span>
                  <input
                    id="attendance-import-batch-search"
                    v-model="importBatchSearch"
                    type="text"
                    placeholder="Batch ID / source / rule set"
                  />
                </label>
              </div>
              <div v-if="filteredImportBatches.length === 0" class="attendance__empty">No import batches.</div>
              <div v-else class="attendance__table-wrapper">
                <table class="attendance__table">
                  <thead>
                    <tr>
                      <th>Batch</th>
                      <th>Status</th>
                      <th>Rows</th>
                      <th>Source</th>
                      <th>Rule set</th>
                      <th>Created</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="batch in filteredImportBatches" :key="batch.id">
                      <td>{{ formatShortId(batch.id) }}</td>
                      <td>
                        <span class="attendance__status-chip" :class="`attendance__status-chip--${batch.status}`">
                          {{ batch.status }}
                        </span>
                      </td>
                      <td>{{ batch.rowCount }}</td>
                      <td>{{ batch.source ?? '--' }}</td>
                      <td>{{ formatShortId(batch.ruleSetId) }}</td>
                      <td>{{ formatDateTime(batch.createdAt ?? null) }}</td>
                      <td class="attendance__table-actions">
                        <button class="attendance__btn" @click="toggleImportBatch(batch.id)">
                          {{ selectedImportBatchId === batch.id ? 'Hide items' : 'View items' }}
                        </button>
                        <button
                          class="attendance__btn attendance__btn--danger"
                          :disabled="batch.status === 'rolled_back'"
                          @click="rollbackImportBatch(batch.id)"
                        >
                          Rollback
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="attendance__pagination" v-if="importBatchesTotalPages > 1">
                <button class="attendance__btn" :disabled="importBatchesPage <= 1 || importBatchesLoading" @click="loadImportBatches(importBatchesPage - 1)">
                  Prev
                </button>
                <span>Page {{ importBatchesPage }} / {{ importBatchesTotalPages }}</span>
                <button
                  class="attendance__btn"
                  :disabled="importBatchesPage >= importBatchesTotalPages || importBatchesLoading"
                  @click="loadImportBatches(importBatchesPage + 1)"
                >
                  Next
                </button>
              </div>

              <div v-if="selectedImportBatchId" class="attendance__import-items">
                <div class="attendance__requests-header">
                  <h4>Batch Items</h4>
                  <button
                    class="attendance__btn"
                    :disabled="importBatchItemsLoading"
                    @click="loadImportBatchItems(selectedImportBatchId, importBatchItemsPage)"
                  >
                    {{ importBatchItemsLoading ? 'Loading...' : 'Reload items' }}
                  </button>
                </div>
                <div v-if="importBatchItems.length === 0" class="attendance__empty">No items for this batch.</div>
                <div v-else class="attendance__table-wrapper">
                  <table class="attendance__table">
                    <thead>
                      <tr>
                        <th>User</th>
                        <th>Work date</th>
                        <th>Record</th>
                        <th>Created</th>
                        <th>Snapshot</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="item in importBatchItems" :key="item.id">
                        <td>{{ formatShortId(item.userId) }}</td>
                        <td>{{ item.workDate ?? '--' }}</td>
                        <td>{{ formatShortId(item.recordId) }}</td>
                        <td>{{ formatDateTime(item.createdAt ?? null) }}</td>
                        <td class="attendance__table-actions">
                          <button class="attendance__btn" @click="toggleImportItemSnapshot(item.id)">
                            {{ selectedImportItemId === item.id ? 'Hide' : 'View' }}
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="attendance__pagination" v-if="importBatchItemsTotalPages > 1">
                  <button
                    class="attendance__btn"
                    :disabled="importBatchItemsPage <= 1 || importBatchItemsLoading"
                    @click="loadImportBatchItems(selectedImportBatchId, importBatchItemsPage - 1)"
                  >
                    Prev
                  </button>
                  <span>Page {{ importBatchItemsPage }} / {{ importBatchItemsTotalPages }}</span>
                  <button
                    class="attendance__btn"
                    :disabled="importBatchItemsPage >= importBatchItemsTotalPages || importBatchItemsLoading"
                    @click="loadImportBatchItems(selectedImportBatchId, importBatchItemsPage + 1)"
                  >
                    Next
                  </button>
                </div>
                <div v-if="selectedImportItemId" class="attendance__preview-engine">
                  <div class="attendance__preview-label">Preview snapshot</div>
                  <div class="attendance__admin-actions">
                    <button class="attendance__btn" type="button" @click="copyImportItemSnapshot">Copy JSON</button>
                    <button class="attendance__btn" type="button" @click="downloadImportItemSnapshot">Download JSON</button>
                  </div>
                  <pre class="attendance__preview-json">{{ formatJson(selectedImportItemSnapshot) }}</pre>
                </div>
              </div>
            </div>

            <div class="attendance__admin-section">
              <div class="attendance__admin-section-header">
                <h4>Import Reconcile</h4>
                <button class="attendance__btn" :disabled="reconcileLoading" @click="runReconcile">
                  {{ reconcileLoading ? 'Reconciling...' : 'Run reconcile' }}
                </button>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-reconcile-rule-set">
                  <span>Rule set</span>
                  <select
                    id="attendance-reconcile-rule-set"
                    v-model="reconcileForm.ruleSetId"
                    :disabled="ruleSets.length === 0"
                  >
                    <option value="">(Optional) Use default rule</option>
                    <option v-for="item in ruleSets" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-reconcile-timezone">
                  <span>Timezone</span>
                  <input
                    id="attendance-reconcile-timezone"
                    v-model="reconcileForm.timezone"
                    type="text"
                  />
                </label>
                <label class="attendance__field attendance__field--checkbox" for="attendance-reconcile-config">
                  <span>Use current rule set config</span>
                  <input
                    id="attendance-reconcile-config"
                    v-model="reconcileForm.useCurrentConfig"
                    type="checkbox"
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-reconcile-entries">
                  <span>Entries payload (JSON)</span>
                  <textarea
                    id="attendance-reconcile-entries"
                    v-model="reconcileForm.entriesPayload"
                    rows="6"
                    placeholder='{"source":"dingtalk_csv","entries":[...]}'
                  />
                </label>
                <label class="attendance__field attendance__field--full" for="attendance-reconcile-rows">
                  <span>Rows payload (JSON)</span>
                  <textarea
                    id="attendance-reconcile-rows"
                    v-model="reconcileForm.rowsPayload"
                    rows="6"
                    placeholder='{"source":"dingtalk_csv","rows":[...]}'
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn" :disabled="reconcileLoading" @click="runReconcile">
                  {{ reconcileLoading ? 'Reconciling...' : 'Reconcile' }}
                </button>
                <button class="attendance__btn" :disabled="reconcileLoading" @click="clearReconcile">
                  Clear
                </button>
                <button class="attendance__btn" :disabled="!reconcileResult" @click="exportReconcileJson">
                  Export JSON
                </button>
                <button class="attendance__btn" :disabled="!reconcileResult" @click="exportReconcileCsv">
                  Export CSV
                </button>
              </div>
              <div v-if="!reconcileResult" class="attendance__empty">No reconcile data.</div>
              <div v-else class="attendance__preview-card">
                <div class="attendance__preview-grid">
                  <div>
                    <div class="attendance__preview-label">Entries items</div>
                    <div>{{ reconcileResult.entriesTotal }}</div>
                  </div>
                  <div>
                    <div class="attendance__preview-label">Rows items</div>
                    <div>{{ reconcileResult.rowsTotal }}</div>
                  </div>
                  <div>
                    <div class="attendance__preview-label">Matched</div>
                    <div>{{ reconcileResult.matched }}</div>
                  </div>
                  <div>
                    <div class="attendance__preview-label">Mismatched</div>
                    <div>{{ reconcileResult.mismatched }}</div>
                  </div>
                  <div>
                    <div class="attendance__preview-label">Missing in entries</div>
                    <div>{{ reconcileResult.missingInEntries }}</div>
                  </div>
                  <div>
                    <div class="attendance__preview-label">Missing in rows</div>
                    <div>{{ reconcileResult.missingInRows }}</div>
                  </div>
                </div>
                <div class="attendance__preview-label">First 50 diffs</div>
                <div v-if="reconcileResult.diffs.length === 0" class="attendance__empty">
                  No differences found.
                </div>
                <div v-else class="attendance__table-wrapper">
                  <table class="attendance__table">
                    <thead>
                      <tr>
                        <th>User ID</th>
                        <th>Work date</th>
                        <th>Diffs</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="diff in reconcileResult.diffs.slice(0, 50)" :key="diff.key">
                        <td>{{ diff.userId }}</td>
                        <td>{{ diff.workDate }}</td>
                        <td><pre class="attendance__preview-json">{{ formatJson(diff.differences) }}</pre></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
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
              <div class="attendance__admin-divider" />
              <div class="attendance__admin-section-header attendance__admin-section-header--sub">
                <h5>Generate cycles</h5>
              </div>
              <div class="attendance__admin-grid">
                <label class="attendance__field" for="attendance-payroll-generate-template">
                  <span>Template</span>
                  <select
                    id="attendance-payroll-generate-template"
                    v-model="payrollGenerateForm.templateId"
                    :disabled="payrollTemplates.length === 0"
                  >
                    <option value="">Default template</option>
                    <option v-for="item in payrollTemplates" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-payroll-generate-anchor">
                  <span>Anchor date</span>
                  <input
                    id="attendance-payroll-generate-anchor"
                    v-model="payrollGenerateForm.anchorDate"
                    type="date"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-generate-count">
                  <span>Count (months)</span>
                  <input
                    id="attendance-payroll-generate-count"
                    v-model.number="payrollGenerateForm.count"
                    type="number"
                    min="1"
                    max="24"
                  />
                </label>
                <label class="attendance__field" for="attendance-payroll-generate-status">
                  <span>Status</span>
                  <select id="attendance-payroll-generate-status" v-model="payrollGenerateForm.status">
                    <option value="open">Open</option>
                    <option value="closed">Closed</option>
                    <option value="archived">Archived</option>
                  </select>
                </label>
                <label class="attendance__field" for="attendance-payroll-generate-prefix">
                  <span>Name prefix</span>
                  <input
                    id="attendance-payroll-generate-prefix"
                    v-model="payrollGenerateForm.namePrefix"
                    type="text"
                    placeholder="Optional"
                  />
                </label>
              </div>
              <div class="attendance__admin-actions">
                <button
                  class="attendance__btn"
                  :disabled="payrollGenerateLoading"
                  @click="generatePayrollCycles"
                >
                  {{ payrollGenerateLoading ? 'Generating...' : 'Generate cycles' }}
                </button>
              </div>
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
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { usePlugins } from '../composables/usePlugins'
import { apiFetch } from '../utils/api'

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

interface AttendanceEngineTemplate {
  name: string
  category?: 'system' | 'custom'
  editable?: boolean
  description?: string
  scope?: Record<string, any>
  params?: AttendanceTemplateParam[]
  rules?: Array<Record<string, any>>
}

interface AttendanceTemplateParam {
  key: string
  label: string
  type?: 'string' | 'number' | 'boolean' | 'stringArray'
  default?: any
  description?: string
  paths?: string[]
}

interface AttendanceRuleDraft {
  key: string
  id: string
  whenText: string
  thenText: string
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

interface AttendanceImportMappingProfile {
  id: string
  name: string
  description?: string
  source?: string
  mapping?: {
    columns?: Array<{
      sourceField: string
      targetField: string
      dataType?: string
    }>
  }
  userMapKeyField?: string
  userMapSourceFields?: string[]
  payloadExample?: Record<string, any>
  requiredFields?: string[]
}

interface AttendanceRulePreviewItem {
  userId: string
  workDate: string
  workMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  status: string
  leaveMinutes?: number
  overtimeMinutes?: number
  engine?: {
    appliedRules?: string[]
    warnings?: string[]
    reasons?: string[]
    overrides?: Record<string, any> | null
    base?: Record<string, any> | null
  } | null
}

interface AttendanceReconcileDiff {
  key: string
  userId: string
  workDate: string
  differences: Record<string, { entries: any; rows: any }>
}

interface AttendanceReconcileResult {
  entriesTotal: number
  rowsTotal: number
  matched: number
  mismatched: number
  missingInEntries: number
  missingInRows: number
  diffs: AttendanceReconcileDiff[]
}

interface AttendanceImportBatch {
  id: string
  orgId?: string
  createdBy?: string | null
  source?: string | null
  ruleSetId?: string | null
  rowCount: number
  status: string
  meta?: Record<string, any> | null
  createdAt?: string | null
  updatedAt?: string | null
}

interface AttendanceImportItem {
  id: string
  batchId: string
  orgId?: string
  userId?: string | null
  workDate?: string | null
  recordId?: string | null
  previewSnapshot?: Record<string, any> | null
  createdAt?: string | null
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

const loading = ref(false)
const punching = ref(false)
const requestSubmitting = ref(false)
const summary = ref<AttendanceSummary | null>(null)
const records = ref<AttendanceRecord[]>([])
const requests = ref<AttendanceRequest[]>([])
const statusMessage = ref('')
const statusKind = ref<'info' | 'error'>('info')
const calendarMonth = ref(new Date())
const pluginsLoaded = ref(false)
const exporting = ref(false)
const settingsLoading = ref(false)
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
const payrollTemplateLoading = ref(false)
const payrollTemplateSaving = ref(false)
const payrollCycleLoading = ref(false)
const payrollCycleSaving = ref(false)
const payrollGenerateLoading = ref(false)
const importLoading = ref(false)
const importBatchesLoading = ref(false)
const importBatchItemsLoading = ref(false)
const reconcileLoading = ref(false)
const rulePreviewLoading = ref(false)
const adminForbidden = ref(false)
const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

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
const payrollTemplates = ref<AttendancePayrollTemplate[]>([])
const payrollCycles = ref<AttendancePayrollCycle[]>([])
const templateLibrary = ref<AttendanceEngineTemplate[]>([])
const importMappingProfiles = ref<AttendanceImportMappingProfile[]>([])
const importPreview = ref<AttendanceImportPreviewItem[]>([])
const importBatches = ref<AttendanceImportBatch[]>([])
const importBatchItems = ref<AttendanceImportItem[]>([])
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
const payrollTemplateEditingId = ref<string | null>(null)
const payrollCycleEditingId = ref<string | null>(null)
const payrollCycleSummary = ref<AttendanceSummary | null>(null)
const importProfileId = ref('')

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

const today = new Date()
const fromDate = ref(toDateInput(new Date(Date.now() - 1000 * 60 * 60 * 24 * 30)))
const toDate = ref(toDateInput(today))

const recordsPage = ref(1)
const recordsPageSize = 20
const recordsTotal = ref(0)
const recordsTotalPages = computed(() => Math.max(1, Math.ceil(recordsTotal.value / recordsPageSize)))

const importBatchesPage = ref(1)
const importBatchesPageSize = 5
const importBatchesTotal = ref(0)
const importBatchesTotalPages = computed(() => Math.max(1, Math.ceil(importBatchesTotal.value / importBatchesPageSize)))
const selectedImportBatchId = ref<string | null>(null)
const importBatchItemsPage = ref(1)
const importBatchItemsPageSize = 5
const importBatchItemsTotal = ref(0)
const importBatchItemsTotalPages = computed(() => Math.max(1, Math.ceil(importBatchItemsTotal.value / importBatchItemsPageSize)))
const selectedImportItemId = ref<string | null>(null)
const importBatchStatusFilter = ref('all')
const importBatchSearch = ref('')
const selectedImportItem = computed(() => {
  if (!selectedImportItemId.value) return null
  return importBatchItems.value.find(item => item.id === selectedImportItemId.value) ?? null
})
const selectedImportItemSnapshot = computed(() => selectedImportItem.value?.previewSnapshot ?? null)

const filteredImportBatches = computed(() => {
  const status = importBatchStatusFilter.value
  const query = importBatchSearch.value.trim().toLowerCase()
  return importBatches.value.filter((batch) => {
    if (status !== 'all' && batch.status !== status) return false
    if (!query) return true
    const haystack = [
      batch.id,
      batch.source,
      batch.ruleSetId,
      batch.createdBy,
    ].filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(query)
  })
})

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

const SYSTEM_TEMPLATE_NAMES = [
  '单休车间规则',
  '通用提醒',
  '标准上下班提醒',
  '缺卡补卡核对',
  '休息日加班',
  '角色规则',
  '部门提醒',
  '加班单核对',
]
const CUSTOM_TEMPLATE_FALLBACK: AttendanceEngineTemplate = {
  name: '用户自定义',
  category: 'custom',
  editable: true,
  description: '为考勤管理员预留的自定义规则模板',
  rules: [],
}

const ruleSetSystemTemplates = ref<AttendanceEngineTemplate[]>([])
const ruleSetCustomTemplates = ref<AttendanceEngineTemplate[]>([])
const templateLibraryLoading = ref(false)
const templateLibrarySaving = ref(false)
const selectedSystemTemplateName = ref<string | null>(null)
const templateParamValues = reactive<Record<string, any>>({})
const templateParamJson = ref('')
const templateParamFileInput = ref<HTMLInputElement | null>(null)
const customTemplateEditingName = ref<string | null>(null)
const customTemplateDraftDescription = ref('')
const customTemplateDraftRules = ref<AttendanceRuleDraft[]>([])

const RULE_FIELD_WHITELIST = new Set([
  'attendance_group',
  'attendanceGroup',
  'role',
  'role_tags',
  'department',
  'shift',
  'clockIn1',
  'clockOut1',
  'clockIn2',
  'clockOut2',
  'clockIn3',
  'clockOut3',
  'has_punch',
  'leave_hours',
  'exceptionReason',
  'exception_reason',
  'approval',
  'approvals',
  'approvalSummary',
  'overtime_hours',
  'required_hours',
  'actual_hours',
  'actualAttendanceHours',
  'requiredAttendanceHours',
])

const RULE_FIELD_PATTERNS = [/^clock(In|Out)\d+$/]

const RULE_OPERATORS = [
  { suffix: '_contains_any', type: 'contains' },
  { suffix: '_not_contains', type: 'contains' },
  { suffix: '_contains', type: 'contains' },
  { suffix: '_exists', type: 'exists' },
  { suffix: '_before', type: 'time' },
  { suffix: '_after', type: 'time' },
  { suffix: '_gte', type: 'number' },
  { suffix: '_lte', type: 'number' },
  { suffix: '_gt', type: 'number' },
  { suffix: '_lt', type: 'number' },
  { suffix: '_eq', type: 'primitive' },
  { suffix: '_ne', type: 'primitive' },
]

const RULE_ACTION_FIELDS: Record<string, 'number' | 'string' | 'stringArray'> = {
  overtime_hours: 'number',
  overtime_add: 'number',
  required_hours: 'number',
  actual_hours: 'number',
  warning: 'string',
  warnings: 'stringArray',
  reason: 'string',
  reasons: 'stringArray',
}

const CUSTOM_RULE_SAMPLES: Array<Record<string, any>> = [
  {
    id: 'role_short_hours',
    when: { role_tags_contains: 'driver' },
    then: { actual_hours: 6, warning: '司机短班', reason: 'Role-based adjustment' },
  },
  {
    id: 'missing_checkout',
    when: { clockIn1_exists: true, clockOut1_exists: false },
    then: { warning: '缺少下班卡' },
  },
  {
    id: 'trip_overtime_conflict',
    when: { exceptionReason_contains: '出差', overtime_hours_gt: 0 },
    then: { warning: '出差同时存在加班，请核对' },
  },
  {
    id: 'rest_day_punch',
    when: { shift_contains: '休息', has_punch: true },
    then: { reason: '休息日打卡', overtime_hours: 8 },
  },
  {
    id: 'leave_with_punch',
    when: { leave_hours_gt: 0, has_punch: true },
    then: { warning: '请假但仍有打卡记录' },
  },
  {
    id: 'group_attention',
    when: { attendance_group_contains: '单休' },
    then: { warning: '单休考勤组请核对', reason: 'Attendance group reminder' },
  },
]

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

const payrollGenerateForm = reactive({
  templateId: '',
  anchorDate: '',
  count: 1,
  status: 'open',
  namePrefix: '',
})

const importForm = reactive({
  ruleSetId: '',
  userId: '',
  timezone: defaultTimezone,
  payload: '{}',
})

const reconcileForm = reactive({
  ruleSetId: '',
  timezone: defaultTimezone,
  entriesPayload: '',
  rowsPayload: '',
  useCurrentConfig: false,
})

const rulePreviewForm = reactive({
  ruleSetId: '',
  userId: '',
  workDate: toDateInput(today),
  clockInAt: '',
  clockOutAt: '',
  shiftName: '',
  attendanceGroup: '',
  roleTags: '',
  department: '',
  exceptionReason: '',
  actualHours: '',
  overtimeHours: '',
  leaveHours: '',
  useCurrentConfig: true,
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

function formatShortId(value?: string | null): string {
  if (!value) return '--'
  if (value.length <= 8) return value
  return `${value.slice(0, 8)}…`
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

function formatJson(value?: Record<string, any> | null): string {
  if (!value || typeof value !== 'object') return '--'
  const keys = Object.keys(value)
  if (keys.length === 0) return '--'
  return JSON.stringify(value, null, 2)
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

function parseNumberInput(value: string | number): number | null {
  const trimmed = String(value).trim()
  if (!trimmed) return null
  const numberValue = Number(trimmed)
  if (!Number.isFinite(numberValue)) return null
  return numberValue
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

function normalizeTemplate(template: AttendanceEngineTemplate): AttendanceEngineTemplate {
  const isSystem = template.category === 'system' || template.editable === false || SYSTEM_TEMPLATE_NAMES.includes(template.name)
  return {
    ...template,
    category: isSystem ? 'system' : 'custom',
    editable: isSystem ? false : true,
  }
}

function splitTemplates(templates: AttendanceEngineTemplate[] = []) {
  const normalized = templates.map((tpl) => normalizeTemplate(tpl))
  const system = normalized.filter((tpl) => tpl.category === 'system')
  const custom = normalized.filter((tpl) => tpl.category !== 'system')
  return { system, custom, normalized }
}

const selectedSystemTemplate = computed(() => {
  if (!selectedSystemTemplateName.value) return null
  return ruleSetSystemTemplates.value.find((tpl) => tpl.name === selectedSystemTemplateName.value) ?? null
})

const libraryTemplates = computed(() => {
  return templateLibrary.value.map((tpl) => normalizeTemplate(tpl)).filter((tpl) => tpl.category !== 'system')
})

const selectedImportProfile = computed(() => {
  if (!importProfileId.value) return null
  return importMappingProfiles.value.find(profile => profile.id === importProfileId.value) ?? null
})

function defaultParamValue(param: AttendanceTemplateParam): any {
  if (param.default !== undefined) return param.default
  if (param.type === 'number') return 0
  if (param.type === 'boolean') return false
  return ''
}

function resetTemplateParams(template: AttendanceEngineTemplate | null) {
  Object.keys(templateParamValues).forEach((key) => delete templateParamValues[key])
  templateParamJson.value = ''
  if (!template || !Array.isArray(template.params)) return
  template.params.forEach((param) => {
    templateParamValues[param.key] = defaultParamValue(param)
  })
}

function selectSystemTemplate(template: AttendanceEngineTemplate) {
  selectedSystemTemplateName.value = template.name
  resetTemplateParams(template)
}

function exportTemplateParams() {
  const template = selectedSystemTemplate.value
  if (!template) {
    setStatus('Select a system template first.', 'error')
    return
  }
  const payload = {
    template: template.name,
    params: buildTemplateParamMap(template),
  }
  templateParamJson.value = JSON.stringify(payload, null, 2)
  setStatus('Template params exported.')
}

function exportTemplateParamsFile() {
  const template = selectedSystemTemplate.value
  if (!template) {
    setStatus('Select a system template first.', 'error')
    return
  }
  const payload = {
    template: template.name,
    params: buildTemplateParamMap(template),
  }
  const filename = `attendance-template-params-${template.name.replace(/\s+/g, '_')}-${Date.now()}.json`
  downloadText(filename, JSON.stringify(payload, null, 2), 'application/json')
  setStatus('Template params file exported.')
}

function importTemplateParams() {
  const template = selectedSystemTemplate.value
  if (!template) {
    setStatus('Select a system template first.', 'error')
    return
  }
  let text = templateParamJson.value.trim()
  if (!text) {
    text = window.prompt('Paste template params JSON') ?? ''
  }
  if (!text.trim()) return
  try {
    const parsed = JSON.parse(text)
    const params = parsed?.params ?? parsed
    if (!params || typeof params !== 'object') {
      throw new Error('params missing')
    }
    const paramDefs = Array.isArray(template.params) ? template.params : []
    paramDefs.forEach((param) => {
      if (params[param.key] !== undefined) {
        templateParamValues[param.key] = params[param.key]
      }
    })
    templateParamJson.value = JSON.stringify({ template: template.name, params }, null, 2)
    setStatus('Template params imported.')
  } catch {
    setStatus('Invalid template params JSON.', 'error')
  }
}

function triggerTemplateParamFile() {
  if (!selectedSystemTemplate.value) {
    setStatus('Select a system template first.', 'error')
    return
  }
  templateParamFileInput.value?.click()
}

async function handleTemplateParamFile(event: Event) {
  const input = event.target as HTMLInputElement | null
  const file = input?.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    templateParamJson.value = text
    importTemplateParams()
  } catch {
    setStatus('Failed to read template params file.', 'error')
  } finally {
    if (input) input.value = ''
  }
}

function syncRuleSetTemplates(config?: Record<string, any> | null) {
  const templates = Array.isArray(config?.engine?.templates)
    ? (config?.engine?.templates as AttendanceEngineTemplate[])
    : []
  const { system, custom } = splitTemplates(templates)
  ruleSetSystemTemplates.value = system
  ruleSetCustomTemplates.value = custom
}

async function loadTemplateLibrary() {
  templateLibraryLoading.value = true
  try {
    const response = await apiFetch('/api/attendance/rule-templates')
    if (response.status === 403) {
      adminForbidden.value = true
      return
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to load template library')
    }
    adminForbidden.value = false
    templateLibrary.value = Array.isArray(data.data?.library)
      ? data.data.library
      : (Array.isArray(data.data?.templates) ? data.data.templates : [])
    setStatus('Template library loaded.')
  } catch (error) {
    setStatus((error as Error).message || 'Failed to load template library', 'error')
  } finally {
    templateLibraryLoading.value = false
  }
}

async function persistTemplateLibrary(nextTemplates: AttendanceEngineTemplate[]) {
  templateLibrarySaving.value = true
  try {
    const response = await apiFetch('/api/attendance/rule-templates', {
      method: 'PUT',
      body: JSON.stringify({ templates: nextTemplates }),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to save template library')
    }
    adminForbidden.value = false
    templateLibrary.value = data.data?.templates ?? nextTemplates
    setStatus('Template library updated.')
  } catch (error) {
    setStatus((error as Error).message || 'Failed to save template library', 'error')
  } finally {
    templateLibrarySaving.value = false
  }
}

function normalizeLibraryTemplate(template: AttendanceEngineTemplate): AttendanceEngineTemplate {
  const normalized = normalizeTemplate(template)
  return {
    ...normalized,
    category: 'custom',
    editable: true,
    rules: normalized.rules ?? [],
  }
}

function upsertLibraryTemplate(template: AttendanceEngineTemplate) {
  const normalized = normalizeLibraryTemplate(template)
  const next = templateLibrary.value.filter((tpl) => tpl.name !== normalized.name)
  next.push(normalized)
  persistTemplateLibrary(next)
}

function removeLibraryTemplate(name: string) {
  if (!window.confirm(`Remove template "${name}" from library?`)) return
  const next = templateLibrary.value.filter((tpl) => tpl.name !== name)
  persistTemplateLibrary(next)
}

function applyLibraryTemplate(template: AttendanceEngineTemplate) {
  const config = parseJsonConfig(ruleSetForm.config)
  if (!config) {
    setStatus('Rule set config must be valid JSON before applying library templates.', 'error')
    return
  }
  const normalized = normalizeLibraryTemplate(template)
  const engine = typeof config.engine === 'object' && config.engine ? { ...config.engine } : {}
  const templates = Array.isArray(engine.templates) ? (engine.templates as AttendanceEngineTemplate[]) : []
  const index = templates.findIndex((tpl) => tpl.name === normalized.name)
  if (index >= 0) {
    templates[index] = { ...templates[index], ...normalized }
  } else {
    templates.push(normalized)
  }
  engine.templates = templates
  config.engine = engine
  ruleSetForm.config = JSON.stringify(config, null, 2)
  syncRuleSetTemplates(config)
  openCustomTemplateEditor(normalized)
  setStatus('Library template added to rule set.')
}

function saveCustomTemplateToLibrary() {
  const name = customTemplateEditingName.value?.trim()
  if (!name) {
    setStatus('Select a custom template before saving to the library.', 'error')
    return
  }
  const config = parseJsonConfig(ruleSetForm.config)
  if (!config) {
    setStatus('Rule set config must be valid JSON before saving to the library.', 'error')
    return
  }
  const templates = Array.isArray(config.engine?.templates) ? (config.engine.templates as AttendanceEngineTemplate[]) : []
  const template = templates.find((tpl) => tpl.name === name)
  if (!template) {
    setStatus('Template not found in rule set config.', 'error')
    return
  }
  upsertLibraryTemplate(template)
}

function applyTemplateLock(config: Record<string, any>) {
  const engine = typeof config.engine === 'object' && config.engine ? { ...config.engine } : {}
  const templates = Array.isArray(engine.templates) ? (engine.templates as AttendanceEngineTemplate[]) : []
  const { custom } = splitTemplates(templates)

  const lockedSystem = ruleSetSystemTemplates.value.length
    ? ruleSetSystemTemplates.value.map(normalizeTemplate)
    : splitTemplates(templates).system

  const customTemplates = custom.map(normalizeTemplate)
  if (!customTemplates.some((tpl) => tpl.name === CUSTOM_TEMPLATE_FALLBACK.name)) {
    customTemplates.push({ ...CUSTOM_TEMPLATE_FALLBACK })
  }

  const merged = new Map<string, AttendanceEngineTemplate>()
  lockedSystem.forEach((tpl) => merged.set(tpl.name, tpl))
  customTemplates.forEach((tpl) => merged.set(tpl.name, tpl))

  engine.templates = Array.from(merged.values())
  return { ...config, engine }
}

function normalizeParamValue(param: AttendanceTemplateParam, raw: any): any {
  if (param.type === 'number') {
    const num = typeof raw === 'number' ? raw : Number(String(raw).trim())
    if (Number.isFinite(num)) return num
    return defaultParamValue(param)
  }
  if (param.type === 'boolean') {
    return Boolean(raw)
  }
  if (param.type === 'stringArray') {
    if (Array.isArray(raw)) return raw.filter(Boolean)
    const text = String(raw ?? '').trim()
    if (!text) return []
    return text.split(/[\n,]/).map(item => item.trim()).filter(Boolean)
  }
  if (raw === null || raw === undefined) return defaultParamValue(param)
  return String(raw)
}

function buildTemplateParamMap(template: AttendanceEngineTemplate): Record<string, any> {
  const params = Array.isArray(template.params) ? template.params : []
  const values: Record<string, any> = {}
  params.forEach((param) => {
    values[param.key] = normalizeParamValue(param, templateParamValues[param.key])
  })
  return values
}

function resolveTemplateValue(value: any, params: Record<string, any>): any {
  if (typeof value === 'string') {
    const exact = value.match(/^{{\s*([^}]+)\s*}}$/)
    if (exact) {
      const key = exact[1]
      return params[key] ?? ''
    }
    return value.replace(/{{\s*([^}]+)\s*}}/g, (_match, key) => {
      const replacement = params[key]
      return replacement === undefined || replacement === null ? '' : String(replacement)
    })
  }
  if (Array.isArray(value)) {
    return value.map(item => resolveTemplateValue(item, params))
  }
  if (value && typeof value === 'object') {
    const output: Record<string, any> = Array.isArray(value) ? [] : {}
    Object.entries(value).forEach(([key, entry]) => {
      output[key] = resolveTemplateValue(entry, params)
    })
    return output
  }
  return value
}

function setValueByPath(target: Record<string, any>, path: string, value: any) {
  const normalized = path.replace(/\[(\d+)\]/g, '.$1')
  const parts = normalized.split('.').filter(Boolean)
  let current: any = target
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]
    if (current[key] == null) {
      const nextKey = parts[i + 1]
      current[key] = /^\d+$/.test(nextKey) ? [] : {}
    }
    current = current[key]
  }
  const finalKey = parts[parts.length - 1]
  if (finalKey !== undefined) {
    current[finalKey] = value
  }
}

function applyParamPaths(template: AttendanceEngineTemplate, params: Record<string, any>): AttendanceEngineTemplate {
  const cloned: AttendanceEngineTemplate = JSON.parse(JSON.stringify(template))
  const paramDefs = Array.isArray(template.params) ? template.params : []
  paramDefs.forEach((param) => {
    const paths = Array.isArray(param.paths) ? param.paths : []
    paths.forEach((path: string) => {
      if (typeof path === 'string' && path.trim().length > 0) {
        setValueByPath(cloned as Record<string, any>, path, params[param.key])
      }
    })
  })
  return cloned
}

function applySystemTemplate() {
  const template = selectedSystemTemplate.value
  if (!template) {
    setStatus('Select a system template first.', 'error')
    return
  }
  const config = parseJsonConfig(ruleSetForm.config)
  if (!config) {
    setStatus('Rule set config must be valid JSON before applying templates.', 'error')
    return
  }

  const paramMap = buildTemplateParamMap(template)
  const boundTemplate = applyParamPaths(template, paramMap)
  const resolvedRules = resolveTemplateValue(boundTemplate.rules ?? [], paramMap)
  const resolvedScope = resolveTemplateValue(boundTemplate.scope ?? {}, paramMap)
  const proposedName = `${template.name} - Custom`
  const nameInput = window.prompt('Custom template name', proposedName)
  const name = nameInput?.trim()
  if (!name) return
  if (SYSTEM_TEMPLATE_NAMES.includes(name)) {
    setStatus('Template name conflicts with a system template.', 'error')
    return
  }

  const newTemplate: AttendanceEngineTemplate = {
    name,
    category: 'custom',
    editable: true,
    description: template.description,
    scope: resolvedScope,
    rules: resolvedRules,
  }

  const engine = typeof config.engine === 'object' && config.engine ? { ...config.engine } : {}
  const templates = Array.isArray(engine.templates) ? (engine.templates as AttendanceEngineTemplate[]) : []
  const existingIndex = templates.findIndex((tpl) => tpl.name === name)
  if (existingIndex >= 0) {
    templates[existingIndex] = { ...templates[existingIndex], ...newTemplate }
  } else {
    templates.push(newTemplate)
  }
  engine.templates = templates
  config.engine = engine
  ruleSetForm.config = JSON.stringify(config, null, 2)
  syncRuleSetTemplates(config)
  openCustomTemplateEditor(newTemplate)
  setStatus('Custom template created from system template.')
}

function buildRuleDrafts(rules: Array<Record<string, any>> = []): AttendanceRuleDraft[] {
  return rules.map((rule, index) => ({
    key: `${rule.id ?? 'rule'}-${index}-${Date.now()}`,
    id: String(rule.id ?? `rule_${index + 1}`),
    whenText: JSON.stringify(rule.when ?? {}, null, 2),
    thenText: JSON.stringify(rule.then ?? {}, null, 2),
  }))
}

function openCustomTemplateEditor(template: AttendanceEngineTemplate) {
  customTemplateEditingName.value = template.name
  customTemplateDraftDescription.value = template.description ?? ''
  customTemplateDraftRules.value = buildRuleDrafts(template.rules ?? [])
}

function closeCustomTemplateEditor() {
  customTemplateEditingName.value = null
  customTemplateDraftDescription.value = ''
  customTemplateDraftRules.value = []
}

function addCustomRule() {
  customTemplateDraftRules.value.push({
    key: `rule-${Date.now()}`,
    id: `rule_${customTemplateDraftRules.value.length + 1}`,
    whenText: '{\n}',
    thenText: '{\n}',
  })
}

function insertCustomRuleSamples() {
  if (!customTemplateEditingName.value) {
    setStatus('Open a custom template before inserting examples.', 'error')
    return
  }
  const existingIds = new Set(customTemplateDraftRules.value.map(rule => rule.id.trim()))
  let inserted = 0
  let skipped = 0

  CUSTOM_RULE_SAMPLES.forEach((sample, index) => {
    const id = String(sample.id ?? `sample_${index + 1}`).trim()
    if (!id || existingIds.has(id)) {
      skipped += 1
      return
    }
    existingIds.add(id)
    customTemplateDraftRules.value.push({
      key: `sample-${id}-${Date.now()}`,
      id,
      whenText: JSON.stringify(sample.when ?? {}, null, 2),
      thenText: JSON.stringify(sample.then ?? {}, null, 2),
    })
    inserted += 1
  })

  if (inserted === 0) {
    setStatus('All sample rules already exist.', 'error')
    return
  }
  const message = skipped > 0
    ? `Inserted ${inserted} sample rules (${skipped} skipped).`
    : `Inserted ${inserted} sample rules.`
  setStatus(message)
}

function removeCustomRule(index: number) {
  customTemplateDraftRules.value.splice(index, 1)
}

function parseRuleJson(text: string, label: string) {
  const trimmed = text.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') return parsed
    throw new Error('JSON must be an object')
  } catch (error: any) {
    throw new Error(`${label} must be valid JSON object`)
  }
}

function isWhitelistedField(field: string): boolean {
  if (RULE_FIELD_WHITELIST.has(field)) return true
  return RULE_FIELD_PATTERNS.some(pattern => pattern.test(field))
}

function resolveOperator(key: string) {
  if (key === 'role') return { field: 'role', operator: 'role', type: 'string' as const }
  for (const op of RULE_OPERATORS) {
    if (key.endsWith(op.suffix)) {
      const field = key.slice(0, -op.suffix.length)
      return { field, operator: op.suffix, type: op.type }
    }
  }
  return { field: key, operator: 'eq', type: 'primitive' as const }
}

function validateRuleValue(label: string, key: string, expected: any, type: string): string | null {
  if (type === 'exists') {
    if (typeof expected !== 'boolean') {
      return `${label}: ${key} expects boolean (true/false)`
    }
    return null
  }
  if (type === 'time') {
    if (typeof expected !== 'string' || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(expected)) {
      return `${label}: ${key} expects time string (HH:MM)`
    }
    return null
  }
  if (type === 'number') {
    const num = typeof expected === 'number' ? expected : Number(expected)
    if (!Number.isFinite(num)) {
      return `${label}: ${key} expects number`
    }
    return null
  }
  if (type === 'contains') {
    if (Array.isArray(expected)) {
      if (expected.length === 0) {
        return `${label}: ${key} expects non-empty array`
      }
      if (!expected.every(item => ['string', 'number'].includes(typeof item))) {
        return `${label}: ${key} array values must be string or number`
      }
      return null
    }
    if (['string', 'number'].includes(typeof expected)) return null
    return `${label}: ${key} expects string/number or array`
  }
  if (type === 'string') {
    if (typeof expected !== 'string' || expected.trim().length === 0) {
      return `${label}: ${key} expects non-empty string`
    }
    return null
  }
  if (Array.isArray(expected)) {
    if (!expected.every(item => ['string', 'number', 'boolean'].includes(typeof item))) {
      return `${label}: ${key} array values must be string/number/boolean`
    }
    return null
  }
  if (!['string', 'number', 'boolean'].includes(typeof expected)) {
    return `${label}: ${key} expects string/number/boolean`
  }
  return null
}

function validateCustomTemplateRules(rules: Array<Record<string, any>>): string[] {
  const errors: string[] = []
  const seenIds = new Set<string>()
  rules.forEach((rule, index) => {
    const id = String(rule.id ?? '').trim()
    const label = id ? `Rule ${id}` : `Rule #${index + 1}`
    if (!id) {
      errors.push(`${label}: rule id is required`)
    } else if (seenIds.has(id)) {
      errors.push(`${label}: duplicate rule id`)
    }
    if (id) seenIds.add(id)
    const when = rule.when
    if (!when || typeof when !== 'object' || Array.isArray(when)) {
      errors.push(`${label}: when must be an object`)
      return
    }
    Object.entries(when).forEach(([key, expected]) => {
      const { field, type } = resolveOperator(key)
      if (!field) {
        errors.push(`${label}: invalid condition key "${key}"`)
        return
      }
      if (!isWhitelistedField(field)) {
        errors.push(`${label}: condition field "${field}" is not allowed`)
      }
      const valueError = validateRuleValue(label, key, expected, type)
      if (valueError) errors.push(valueError)
    })
    const thenBlock = rule.then
    if (!thenBlock || typeof thenBlock !== 'object' || Array.isArray(thenBlock)) {
      errors.push(`${label}: then must be an object`)
      return
    }
    Object.entries(thenBlock).forEach(([key, value]) => {
      const expectedType = RULE_ACTION_FIELDS[key]
      if (!expectedType) {
        errors.push(`${label}: action field "${key}" is not allowed`)
        return
      }
      if (expectedType === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push(`${label}: action "${key}" expects number`)
        }
      } else if (expectedType === 'string') {
        if (typeof value !== 'string' || value.trim().length === 0) {
          errors.push(`${label}: action "${key}" expects non-empty string`)
        }
      } else if (expectedType === 'stringArray') {
        if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string')) {
          errors.push(`${label}: action "${key}" expects string array`)
        }
      }
    })
  })
  return errors
}

function saveCustomTemplate() {
  const name = customTemplateEditingName.value?.trim()
  if (!name) {
    setStatus('Select a custom template to edit.', 'error')
    return
  }
  const config = parseJsonConfig(ruleSetForm.config)
  if (!config) {
    setStatus('Rule set config must be valid JSON before editing templates.', 'error')
    return
  }
  const engine = typeof config.engine === 'object' && config.engine ? { ...config.engine } : {}
  const templates = Array.isArray(engine.templates) ? (engine.templates as AttendanceEngineTemplate[]) : []
  let rules: Array<Record<string, any>>
  try {
    rules = customTemplateDraftRules.value.map((draft, index) => ({
      id: draft.id.trim() || `rule_${index + 1}`,
      when: parseRuleJson(draft.whenText, `Rule ${index + 1} when`),
      then: parseRuleJson(draft.thenText, `Rule ${index + 1} then`),
    }))
  } catch (error: any) {
    setStatus(error?.message || 'Invalid rule JSON.', 'error')
    return
  }
  const validationErrors = validateCustomTemplateRules(rules)
  if (validationErrors.length > 0) {
    setStatus(validationErrors[0], 'error')
    return
  }

  const updatedTemplate: AttendanceEngineTemplate = {
    name,
    category: 'custom',
    editable: true,
    description: customTemplateDraftDescription.value.trim() || undefined,
    rules,
  }

  const existingIndex = templates.findIndex((tpl) => tpl.name === name)
  if (existingIndex >= 0) {
    templates[existingIndex] = { ...templates[existingIndex], ...updatedTemplate }
  } else {
    templates.push(updatedTemplate)
  }

  engine.templates = templates
  config.engine = engine
  ruleSetForm.config = JSON.stringify(config, null, 2)
  syncRuleSetTemplates(config)
  setStatus('Custom template updated.')
}

function createCustomTemplate() {
  const name = window.prompt('Custom template name')
  const trimmed = name?.trim()
  if (!trimmed) return
  if (SYSTEM_TEMPLATE_NAMES.includes(trimmed)) {
    setStatus('Template name conflicts with a system template.', 'error')
    return
  }

  const config = parseJsonConfig(ruleSetForm.config)
  if (!config) {
    setStatus('Rule set config must be valid JSON before editing templates.', 'error')
    return
  }
  const engine = typeof config.engine === 'object' && config.engine ? { ...config.engine } : {}
  const templates = Array.isArray(engine.templates) ? (engine.templates as AttendanceEngineTemplate[]) : []
  const existing = templates.find((tpl) => tpl.name === trimmed)
  if (existing) {
    openCustomTemplateEditor(existing)
    setStatus('Custom template already exists. Opened for editing.')
    return
  }

  const newTemplate: AttendanceEngineTemplate = {
    name: trimmed,
    category: 'custom',
    editable: true,
    description: '',
    rules: [],
  }
  templates.push(newTemplate)
  engine.templates = templates
  config.engine = engine
  ruleSetForm.config = JSON.stringify(config, null, 2)
  syncRuleSetTemplates(config)
  openCustomTemplateEditor(newTemplate)
  setStatus('Custom template created.')
}

function buildImportPayload(): Record<string, any> | null {
  const parsed = parseJsonConfig(importForm.payload)
  if (!parsed) return null
  const payload = { ...parsed }
  const resolvedOrgId = normalizedOrgId()
  const resolvedUserId = importForm.userId.trim() || normalizedUserId()
  if (resolvedOrgId && !payload.orgId) payload.orgId = resolvedOrgId
  if (resolvedUserId && !payload.userId) payload.userId = resolvedUserId
  if (importForm.ruleSetId && !payload.ruleSetId) payload.ruleSetId = importForm.ruleSetId
  if (importForm.timezone && !payload.timezone) payload.timezone = importForm.timezone
  if (importProfileId.value && !payload.mappingProfileId) payload.mappingProfileId = importProfileId.value
  return payload
}

function parsePayloadInput(value: string, label: string): Record<string, any> {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} payload is required`)
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`${label} payload must be a JSON object`)
    }
    return parsed as Record<string, any>
  } catch {
    throw new Error(`${label} payload must be valid JSON`)
  }
}

function enrichReconcilePayload(payload: Record<string, any>): Record<string, any> {
  const resolved = { ...payload }
  const resolvedOrgId = normalizedOrgId()
  const resolvedUserId = normalizedUserId()
  if (resolvedOrgId && !resolved.orgId) resolved.orgId = resolvedOrgId
  if (resolvedUserId && !resolved.userId) resolved.userId = resolvedUserId
  if (reconcileForm.ruleSetId && !resolved.ruleSetId) resolved.ruleSetId = reconcileForm.ruleSetId
  if (reconcileForm.timezone && !resolved.timezone) resolved.timezone = reconcileForm.timezone
  if (reconcileForm.useCurrentConfig) {
    const config = parseJsonConfig(ruleSetForm.config)
    if (config?.engine) resolved.engine = config.engine
  }
  return resolved
}

async function previewPayload(payload: Record<string, any>): Promise<AttendanceImportPreviewItem[]> {
  const response = await apiFetch('/api/attendance/import/preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  const data = await response.json()
  if (!response.ok || !data.ok) {
    throw new Error(data?.error?.message || 'Failed to preview payload')
  }
  return data.data?.items ?? []
}

function diffPreviewItems(
  entriesItems: AttendanceImportPreviewItem[],
  rowsItems: AttendanceImportPreviewItem[],
): AttendanceReconcileResult {
  const left = new Map<string, AttendanceImportPreviewItem>()
  const right = new Map<string, AttendanceImportPreviewItem>()
  const buildKey = (item: AttendanceImportPreviewItem) => `${item.userId}::${item.workDate}`

  entriesItems.forEach((item) => left.set(buildKey(item), item))
  rowsItems.forEach((item) => right.set(buildKey(item), item))

  const allKeys = new Set<string>([...left.keys(), ...right.keys()])
  const diffs: AttendanceReconcileDiff[] = []
  let matched = 0
  let mismatched = 0
  let missingInEntries = 0
  let missingInRows = 0

  const fields: Array<keyof AttendanceImportPreviewItem> = [
    'status',
    'workMinutes',
    'lateMinutes',
    'earlyLeaveMinutes',
    'leaveMinutes',
    'overtimeMinutes',
  ]

  allKeys.forEach((key) => {
    const leftItem = left.get(key)
    const rightItem = right.get(key)
    if (!leftItem) {
      missingInEntries += 1
      diffs.push({
        key,
        userId: rightItem?.userId ?? '',
        workDate: rightItem?.workDate ?? '',
        differences: { missing: { entries: null, rows: rightItem } },
      })
      return
    }
    if (!rightItem) {
      missingInRows += 1
      diffs.push({
        key,
        userId: leftItem.userId,
        workDate: leftItem.workDate,
        differences: { missing: { entries: leftItem, rows: null } },
      })
      return
    }

    const differences: Record<string, { entries: any; rows: any }> = {}
    fields.forEach((field) => {
      const leftValue = leftItem[field] ?? null
      const rightValue = rightItem[field] ?? null
      if (leftValue === rightValue) return
      if (typeof leftValue === 'number' || typeof rightValue === 'number') {
        const leftNum = Number(leftValue ?? 0)
        const rightNum = Number(rightValue ?? 0)
        if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum === rightNum) return
        differences[field] = { entries: leftValue, rows: rightValue }
        return
      }
      differences[field] = { entries: leftValue, rows: rightValue }
    })

    if (Object.keys(differences).length === 0) {
      matched += 1
      return
    }
    mismatched += 1
    diffs.push({
      key,
      userId: leftItem.userId,
      workDate: leftItem.workDate,
      differences,
    })
  })

  return {
    entriesTotal: entriesItems.length,
    rowsTotal: rowsItems.length,
    matched,
    mismatched,
    missingInEntries,
    missingInRows,
    diffs,
  }
}

async function runReconcile() {
  reconcileLoading.value = true
  try {
    const entriesPayload = enrichReconcilePayload(parsePayloadInput(reconcileForm.entriesPayload, 'Entries'))
    const rowsPayload = enrichReconcilePayload(parsePayloadInput(reconcileForm.rowsPayload, 'Rows'))
    const [entriesItems, rowsItems] = await Promise.all([
      previewPayload(entriesPayload),
      previewPayload(rowsPayload),
    ])
    reconcileResult.value = diffPreviewItems(entriesItems, rowsItems)
    setStatus('Reconcile completed.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to reconcile payloads', 'error')
  } finally {
    reconcileLoading.value = false
  }
}

function clearReconcile() {
  reconcileForm.entriesPayload = ''
  reconcileForm.rowsPayload = ''
  reconcileResult.value = null
}

function escapeCsvValue(value: any): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function downloadText(filename: string, content: string, mime = 'application/json') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

async function copyToClipboard(text: string) {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    try {
      const success = document.execCommand('copy')
      return success
    } finally {
      textarea.remove()
    }
  }
}

function exportReconcileJson() {
  if (!reconcileResult.value) {
    setStatus('No reconcile result to export.', 'error')
    return
  }
  downloadText(
    `attendance-reconcile-${Date.now()}.json`,
    JSON.stringify(reconcileResult.value, null, 2),
    'application/json'
  )
  setStatus('Reconcile JSON exported.')
}

function exportReconcileCsv() {
  if (!reconcileResult.value) {
    setStatus('No reconcile result to export.', 'error')
    return
  }
  const lines = [
    ['metric', 'value'],
    ['entries_total', reconcileResult.value.entriesTotal],
    ['rows_total', reconcileResult.value.rowsTotal],
    ['matched', reconcileResult.value.matched],
    ['mismatched', reconcileResult.value.mismatched],
    ['missing_in_entries', reconcileResult.value.missingInEntries],
    ['missing_in_rows', reconcileResult.value.missingInRows],
    [],
    ['user_id', 'work_date', 'field', 'entries', 'rows'],
  ]
  reconcileResult.value.diffs.forEach((diff) => {
    Object.entries(diff.differences).forEach(([field, values]) => {
      lines.push([
        diff.userId,
        diff.workDate,
        field,
        values.entries ?? '',
        values.rows ?? '',
      ])
    })
  })
  const csv = lines.map((row) => row.map(escapeCsvValue).join(',')).join('\n')
  downloadText(`attendance-reconcile-${Date.now()}.csv`, csv, 'text/csv')
  setStatus('Reconcile CSV exported.')
}

function buildRulePreviewPayload(): Record<string, any> | null {
  if (!rulePreviewForm.workDate) {
    setStatus('Work date is required for rule preview.', 'error')
    return null
  }

  const fields: Record<string, any> = {}
  if (rulePreviewForm.clockInAt) fields.clockInAt = rulePreviewForm.clockInAt
  if (rulePreviewForm.clockOutAt) fields.clockOutAt = rulePreviewForm.clockOutAt

  const shiftName = rulePreviewForm.shiftName.trim()
  if (shiftName) fields.shiftName = shiftName
  const attendanceGroup = rulePreviewForm.attendanceGroup.trim()
  if (attendanceGroup) fields.attendanceGroup = attendanceGroup
  const roleTags = rulePreviewForm.roleTags.trim()
  if (roleTags) fields.roleTags = roleTags
  const department = rulePreviewForm.department.trim()
  if (department) fields.department = department
  const exceptionReason = rulePreviewForm.exceptionReason.trim()
  if (exceptionReason) fields.exceptionReason = exceptionReason

  const actualHours = parseNumberInput(rulePreviewForm.actualHours)
  if (actualHours !== null) fields.actualHours = actualHours
  const overtimeHours = parseNumberInput(rulePreviewForm.overtimeHours)
  if (overtimeHours !== null) fields.overtimeHours = overtimeHours
  const leaveHours = parseNumberInput(rulePreviewForm.leaveHours)
  if (leaveHours !== null) fields.leaveHours = leaveHours

  const payload: Record<string, any> = {
    source: 'manual',
    mapping: {
      columns: [
        { sourceField: 'clockInAt', targetField: 'firstInAt', dataType: 'time' },
        { sourceField: 'clockOutAt', targetField: 'lastOutAt', dataType: 'time' },
        { sourceField: 'actualHours', targetField: 'workHours', dataType: 'hours' },
        { sourceField: 'overtimeHours', targetField: 'overtimeMinutes', dataType: 'hours' },
        { sourceField: 'leaveHours', targetField: 'leaveMinutes', dataType: 'hours' },
      ],
    },
    rows: [
      {
        workDate: rulePreviewForm.workDate,
        fields,
      },
    ],
  }

  const resolvedOrgId = normalizedOrgId()
  if (resolvedOrgId) payload.orgId = resolvedOrgId

  const userId = rulePreviewForm.userId.trim() || normalizedUserId()
  if (userId) payload.userId = userId

  if (rulePreviewForm.ruleSetId) payload.ruleSetId = rulePreviewForm.ruleSetId
  if (defaultTimezone) payload.timezone = defaultTimezone

  if (rulePreviewForm.useCurrentConfig) {
    const config = parseJsonConfig(ruleSetForm.config)
    if (!config) {
      setStatus('Rule set config must be valid JSON before previewing.', 'error')
      return null
    }
    if (config.engine) payload.engine = config.engine
  }

  return payload
}

function payrollTemplateName(templateId?: string | null): string {
  if (!templateId) return 'Manual'
  const found = payrollTemplates.value.find(item => item.id === templateId)
  return found?.name ?? templateId
}

async function loadImportTemplate() {
  importLoading.value = true
  try {
    const response = await apiFetch('/api/attendance/import/template')
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to load import template')
    }
    const payloadExample = data.data?.payloadExample ?? {}
    importForm.payload = JSON.stringify(payloadExample, null, 2)
    importMappingProfiles.value = Array.isArray(data.data?.mappingProfiles)
      ? data.data.mappingProfiles
      : []
    const payloadProfileId = typeof payloadExample?.mappingProfileId === 'string'
      ? payloadExample.mappingProfileId
      : ''
    if (payloadProfileId && importMappingProfiles.value.some(profile => profile.id === payloadProfileId)) {
      importProfileId.value = payloadProfileId
    } else if (!importProfileId.value && importMappingProfiles.value.length > 0) {
      importProfileId.value = importMappingProfiles.value[0].id
    }
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

async function previewImport() {
  const payload = buildImportPayload()
  if (!payload) {
    setStatus('Invalid JSON payload for import.', 'error')
    return
  }
  importLoading.value = true
  try {
    const response = await apiFetch('/api/attendance/import/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to preview import')
    }
    adminForbidden.value = false
    importPreview.value = data.data?.items ?? []
    setStatus(`Preview loaded (${importPreview.value.length} rows).`)
  } catch (error) {
    setStatus((error as Error).message || 'Failed to preview import', 'error')
  } finally {
    importLoading.value = false
  }
}

async function loadImportBatches(page = importBatchesPage.value) {
  importBatchesLoading.value = true
  try {
    const query = buildQuery({
      page: String(page),
      pageSize: String(importBatchesPageSize),
      orgId: normalizedOrgId(),
    })
    const response = await apiFetch(`/api/attendance/import/batches?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to load import batches')
    }
    adminForbidden.value = false
    importBatches.value = data.data?.items ?? []
    importBatchesTotal.value = data.data?.total ?? 0
    importBatchesPage.value = data.data?.page ?? page

    if (selectedImportBatchId.value) {
      const stillVisible = importBatches.value.some((batch) => batch.id === selectedImportBatchId.value)
      if (!stillVisible) {
        selectedImportBatchId.value = null
        importBatchItems.value = []
        importBatchItemsTotal.value = 0
      }
    }
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load import batches', 'error')
  } finally {
    importBatchesLoading.value = false
  }
}

async function loadImportBatchItems(batchId: string, page = 1) {
  importBatchItemsLoading.value = true
  try {
    const query = buildQuery({
      page: String(page),
      pageSize: String(importBatchItemsPageSize),
      orgId: normalizedOrgId(),
    })
    const response = await apiFetch(`/api/attendance/import/batches/${batchId}/items?${query.toString()}`)
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to load import items')
    }
    adminForbidden.value = false
    importBatchItems.value = data.data?.items ?? []
    importBatchItemsTotal.value = data.data?.total ?? 0
    importBatchItemsPage.value = data.data?.page ?? page
    if (selectedImportItemId.value) {
      const stillVisible = importBatchItems.value.some((item) => item.id === selectedImportItemId.value)
      if (!stillVisible) selectedImportItemId.value = null
    }
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load import items', 'error')
  } finally {
    importBatchItemsLoading.value = false
  }
}

async function toggleImportBatch(batchId: string) {
  if (selectedImportBatchId.value === batchId) {
    selectedImportBatchId.value = null
    importBatchItems.value = []
    importBatchItemsTotal.value = 0
    selectedImportItemId.value = null
    return
  }
  selectedImportBatchId.value = batchId
  selectedImportItemId.value = null
  await loadImportBatchItems(batchId, 1)
}

function toggleImportItemSnapshot(itemId: string) {
  selectedImportItemId.value = selectedImportItemId.value === itemId ? null : itemId
}

async function rollbackImportBatch(batchId: string) {
  const confirmed = window.confirm('Rollback this import batch? This will delete imported records.')
  if (!confirmed) return
  importBatchItemsLoading.value = true
  try {
    const response = await apiFetch(`/api/attendance/import/rollback/${batchId}`, {
      method: 'POST',
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to rollback import batch')
    }
    adminForbidden.value = false
    setStatus('Import batch rolled back.')
    await loadImportBatches(importBatchesPage.value)
    if (selectedImportBatchId.value === batchId) {
      await loadImportBatchItems(batchId, importBatchItemsPage.value)
    }
  } catch (error: any) {
    setStatus(error?.message || 'Failed to rollback import batch', 'error')
  } finally {
    importBatchItemsLoading.value = false
  }
}

async function runRulePreview() {
  const payload = buildRulePreviewPayload()
  if (!payload) return

  rulePreviewLoading.value = true
  try {
    const response = await apiFetch('/api/attendance/import/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to run rule preview')
    }
    adminForbidden.value = false
    const items = data.data?.items ?? []
    rulePreviewResult.value = items.length > 0 ? items[0] : null
    setStatus('Rule preview completed.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to run rule preview', 'error')
  } finally {
    rulePreviewLoading.value = false
  }
}

async function runImport() {
  const payload = buildImportPayload()
  if (!payload) {
    setStatus('Invalid JSON payload for import.', 'error')
    return
  }
  importLoading.value = true
  try {
    const prepareResponse = await apiFetch('/api/attendance/import/prepare', { method: 'POST' })
    if (prepareResponse.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const prepareData = await prepareResponse.json()
    if (!prepareResponse.ok || !prepareData.ok) {
      throw new Error(prepareData?.error?.message || 'Failed to prepare import')
    }
    payload.commitToken = prepareData.data?.commitToken
    const response = await apiFetch('/api/attendance/import/commit', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error('Admin permissions required')
    }
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Failed to import attendance')
    }
    adminForbidden.value = false
    const count = data.data?.imported ?? 0
    const batchId = data.data?.batchId
    setStatus(batchId ? `Imported ${count} rows (batch ${formatShortId(batchId)}).` : `Imported ${count} rows.`)
    await Promise.all([loadRecords(), loadImportBatches()])
  } catch (error) {
    setStatus((error as Error).message || 'Failed to import attendance', 'error')
  } finally {
    importLoading.value = false
  }
}

async function copyImportItemSnapshot() {
  if (!selectedImportItemSnapshot.value) {
    setStatus('No snapshot to copy.', 'error')
    return
  }
  const text = JSON.stringify(selectedImportItemSnapshot.value, null, 2)
  const ok = await copyToClipboard(text)
  setStatus(ok ? 'Snapshot copied.' : 'Copy failed.', ok ? 'info' : 'error')
}

function downloadImportItemSnapshot() {
  if (!selectedImportItemSnapshot.value || !selectedImportItemId.value) {
    setStatus('No snapshot to download.', 'error')
    return
  }
  const text = JSON.stringify(selectedImportItemSnapshot.value, null, 2)
  const filename = `attendance-import-snapshot-${selectedImportItemId.value}.json`
  downloadText(filename, text, 'application/json')
  setStatus('Snapshot downloaded.')
}

function setStatus(message: string, kind: 'info' | 'error' = 'info') {
  statusKind.value = kind
  if (statusMessage.value === message && message) {
    statusMessage.value = ''
    void nextTick(() => {
      statusMessage.value = message
    })
  } else {
    statusMessage.value = message
  }
  if (!message) return
  window.setTimeout(() => {
    if (statusMessage.value === message) {
      statusMessage.value = ''
    }
  }, 4000)
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
    await Promise.all([loadSummary(), loadRecords(), loadRequests(), loadRequestReport(), loadHolidays()])
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
    const response = await apiFetch(`/api/attendance/requests/${id}/${action}`, {
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

async function cancelRequest(id: string) {
  try {
    const response = await apiFetch(`/api/attendance/requests/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({})
    })
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'Request cancel failed')
    }
    setStatus('Request cancelled.')
    await loadRequests()
  } catch (error: any) {
    setStatus(error?.message || 'Request cancel failed', 'error')
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
    const response = await apiFetch('/api/attendance/settings')
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

    const response = await apiFetch('/api/attendance/settings', {
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
    const response = await apiFetch(`/api/attendance/rules/default?${query.toString()}`)
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
    const response = await apiFetch('/api/attendance/rules/default', {
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
  ruleSetSystemTemplates.value = []
  ruleSetCustomTemplates.value = []
  selectedSystemTemplateName.value = null
  resetTemplateParams(null)
  closeCustomTemplateEditor()
}

function editRuleSet(item: AttendanceRuleSet) {
  ruleSetEditingId.value = item.id
  ruleSetForm.name = item.name
  ruleSetForm.description = item.description ?? ''
  ruleSetForm.version = item.version ?? 1
  ruleSetForm.scope = item.scope ?? 'org'
  ruleSetForm.isDefault = item.isDefault ?? false
  ruleSetForm.config = JSON.stringify(item.config ?? {}, null, 2)
  syncRuleSetTemplates(item.config ?? {})
  selectedSystemTemplateName.value = null
  resetTemplateParams(null)
  closeCustomTemplateEditor()
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
    let config = parseJsonConfig(ruleSetForm.config)
    if (!config) {
      throw new Error('Rule set config must be valid JSON')
    }
    config = applyTemplateLock(config)

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
    syncRuleSetTemplates(data.data ?? {})
    if (Array.isArray(data.data?.templateLibrary)) {
      templateLibrary.value = data.data.templateLibrary
    }
    selectedSystemTemplateName.value = null
    resetTemplateParams(null)
    closeCustomTemplateEditor()
    setStatus('Rule set template loaded.')
  } catch (error: any) {
    setStatus(error?.message || 'Failed to load rule set template', 'error')
  }
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
    if (!payrollGenerateForm.templateId && payrollTemplates.value.length > 0) {
      const preferred = payrollTemplates.value.find((tpl) => tpl.isDefault) ?? payrollTemplates.value[0]
      payrollGenerateForm.templateId = preferred?.id ?? ''
    }
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

async function generatePayrollCycles() {
  if (!payrollGenerateForm.anchorDate) {
    setStatus('Anchor date is required to generate cycles.', 'error')
    return
  }
  payrollGenerateLoading.value = true
  try {
    const payload: Record<string, any> = {
      templateId: payrollGenerateForm.templateId || undefined,
      anchorDate: payrollGenerateForm.anchorDate,
      count: Number(payrollGenerateForm.count) || 1,
      status: payrollGenerateForm.status,
      namePrefix: payrollGenerateForm.namePrefix.trim() || undefined,
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
    adminForbidden.value = false
    const created = data.data?.created?.length ?? 0
    const skipped = data.data?.skipped?.length ?? 0
    await loadPayrollCycles()
    setStatus(`Generated ${created} cycles (skipped ${skipped}).`)
  } catch (error: any) {
    setStatus(error?.message || 'Failed to generate payroll cycles', 'error')
  } finally {
    payrollGenerateLoading.value = false
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
  await Promise.all([
    loadSettings(),
    loadRule(),
    loadRuleSets(),
    loadTemplateLibrary(),
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
    loadImportTemplate(),
    loadImportBatches(),
  ])
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

watch(
  () => ruleSetForm.config,
  (value) => {
    const parsed = parseJsonConfig(value)
    if (parsed) syncRuleSetTemplates(parsed)
  },
  { immediate: true }
)

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

.attendance__btn--sm {
  padding: 4px 10px;
  font-size: 12px;
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

.attendance__import-items {
  margin-top: 16px;
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

.attendance__status-chip--cancelled {
  background: #eceff1;
  color: #546e7a;
}

.attendance__status-chip--committed {
  background: #e3f2fd;
  color: #1565c0;
}

.attendance__status-chip--rolled_back {
  background: #fff3e0;
  color: #e65100;
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

.attendance__admin-section-header--sub {
  margin-top: 4px;
}

.attendance__admin-section-header--sub h5 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.attendance__admin-divider {
  height: 1px;
  width: 100%;
  background: #eee;
  margin: 4px 0;
}

.attendance__admin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.attendance__template-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.attendance__template-actions {
  display: flex;
  gap: 6px;
}

.attendance__preview-card {
  border: 1px solid #e6e6e6;
  border-radius: 12px;
  padding: 12px;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.attendance__preview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px 16px;
}

.attendance__preview-label {
  font-size: 12px;
  color: #777;
  margin-bottom: 4px;
}

.attendance__preview-engine {
  display: grid;
  gap: 6px;
  font-size: 13px;
}

.attendance__preview-json {
  margin: 0;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid #e3e3e3;
  background: #fff;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.attendance__template-group {
  border: 1px solid #e6e6e6;
  border-radius: 12px;
  padding: 12px;
  background: #fafafa;
}

.attendance__template-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  margin-bottom: 8px;
  font-size: 13px;
  color: #333;
}

.attendance__template-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.attendance__template-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attendance__template-item {
  background: #fff;
  border: 1px solid #e8e8e8;
  border-radius: 10px;
  padding: 8px 10px;
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.attendance__template-item--active {
  border-color: #2f5ea5;
  box-shadow: 0 0 0 1px rgba(47, 94, 165, 0.2);
}

.attendance__template-editor {
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  padding: 12px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.attendance__template-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.attendance__template-editor-title {
  font-size: 13px;
  font-weight: 600;
  color: #333;
}

.attendance__template-editor-name {
  font-size: 12px;
  color: #666;
}

.attendance__template-rules {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.attendance__template-rule {
  border: 1px dashed #d6d6d6;
  border-radius: 10px;
  padding: 12px;
  display: grid;
  gap: 8px;
}

.attendance__template-rule-actions {
  display: flex;
  justify-content: flex-end;
}

.attendance__template-name {
  font-size: 13px;
  font-weight: 600;
  color: #222;
}

.attendance__template-meta {
  font-size: 12px;
  color: #666;
}

.attendance__template-params {
  border: 1px dashed #d0d0d0;
  border-radius: 12px;
  padding: 12px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.attendance__file-input {
  display: none;
}

.attendance__template-hint {
  font-size: 12px;
  color: #666;
}

.attendance__field-hint {
  font-size: 11px;
  color: #888;
  margin-top: 4px;
  display: inline-block;
}

.attendance__tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #e9eef7;
  color: #2f5ea5;
}

.attendance__tag--locked {
  background: #f0f0f0;
  color: #666;
}

.attendance__tag--editable {
  background: #e6f4ea;
  color: #2e7d32;
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
