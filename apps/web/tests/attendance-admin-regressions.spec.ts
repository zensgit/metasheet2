import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([
      {
        name: 'plugin-attendance',
        status: 'active',
      },
    ]),
    views: ref([]),
    navItems: ref([]),
    loading: ref(false),
    error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)], { type: 'application/json' }),
  } as unknown as Response
}

function textResponse(status: number, text: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => JSON.parse(text),
    text: async () => text,
    blob: async () => new Blob([text], { type: headers['Content-Type'] || 'text/plain' }),
  } as unknown as Response
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function setInput(container: HTMLElement, selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector)
  expect(input, `expected input ${selector}`).toBeTruthy()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
}

function selectUserPicker(container: HTMLElement, selector: string, userId: string): void {
  const searchInput = container.querySelector<HTMLInputElement>(selector)
  expect(searchInput, `expected user picker ${selector}`).toBeTruthy()
  const field = searchInput!.closest('.attendance__field')
  expect(field, `expected user picker field ${selector}`).toBeTruthy()
  const select = field!.querySelector<HTMLSelectElement>('select')
  expect(select, `expected user picker select ${selector}`).toBeTruthy()
  if (!Array.from(select!.options).some((option) => option.value === userId)) {
    select!.appendChild(new Option(userId, userId))
  }
  select!.value = userId
  select!.dispatchEvent(new Event('change', { bubbles: true }))
}

function selectMultipleOptions(container: HTMLElement, selector: string, values: string[]): void {
  const select = container.querySelector<HTMLSelectElement>(selector)
  expect(select, `expected multi-select ${selector}`).toBeTruthy()
  for (const option of Array.from(select!.options)) {
    option.selected = values.includes(option.value)
  }
  select!.dispatchEvent(new Event('change', { bubbles: true }))
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  })
  window.dispatchEvent(new Event('resize'))
}

function emptyAttendanceResponse(): Response {
  return jsonResponse(200, {
    ok: true,
    data: {
      items: [],
      summary: null,
    },
  })
}

describe('Attendance admin regressions', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined
  let exportReportFieldFingerprint = 'records-unit-test-fingerprint'
  let exportReportFieldCodes = 'work_date,employee_name'
  let exportReportFieldCount = '2'
  let exportReportFieldProjectId = 'default:attendance'
  let exportReportFieldObjectId = 'attendance_report_field_catalog'
  let exportReportFieldSheetId = 'sheet-1'
  let exportReportFieldViewId = 'fields_by_category'
  let attendanceSettingsData: Record<string, unknown> | null = null
  let attendanceSettingsFail = false
  let attendanceSettingsSaveData: Record<string, unknown> | null = null
  let attendanceApprovalFlowsData: unknown[] | null = null
  let attendanceGroupsData: unknown[] | null = null
  let autoShiftPreviewStatus = 200
  let autoShiftPreviewData: Record<string, unknown> | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    attendanceSettingsData = null
    attendanceSettingsFail = false
    attendanceSettingsSaveData = null
    attendanceApprovalFlowsData = null
    attendanceGroupsData = null
    autoShiftPreviewStatus = 200
    autoShiftPreviewData = null
    exportReportFieldFingerprint = 'records-unit-test-fingerprint'
    exportReportFieldCodes = 'work_date,employee_name'
    exportReportFieldCount = '2'
    exportReportFieldProjectId = 'default:attendance'
    exportReportFieldObjectId = 'attendance_report_field_catalog'
    exportReportFieldSheetId = 'sheet-1'
    exportReportFieldViewId = 'fields_by_category'
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance')
    setViewportWidth(1280)

    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/rule-sets/preview')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            ruleSetId: 'rule-set-1',
            totalEvents: 2,
            config: {
              source: 'manual',
              rule: {
                timezone: 'Asia/Shanghai',
                workStartTime: '09:00',
                workEndTime: '18:00',
                lateGraceMinutes: 10,
                earlyGraceMinutes: 10,
                workingDays: [1, 2, 3, 4, 5],
                overtimeThresholdMinutes: 60,
              },
            },
            notes: ['Preview normalized overtime threshold.'],
            preview: [
              {
                userId: 'user-1',
                workDate: '2026-03-28',
                firstInAt: '2026-03-28T09:17:00.000Z',
                lastOutAt: '2026-03-28T18:02:00.000Z',
                workMinutes: 465,
                lateMinutes: 17,
                earlyLeaveMinutes: 0,
                status: 'late',
                isWorkingDay: true,
                source: {
                  eventIds: ['evt-1', 'evt-2'],
                },
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/rule-templates/versions/version-1')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            id: 'version-1',
            version: 7,
            createdAt: '2026-03-28T08:00:00.000Z',
            createdBy: 'ops-admin',
            sourceVersionId: 'version-6',
            itemCount: 2,
            templates: [
              { name: 'Night Shift', rules: [] },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/rule-templates')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            system: [],
            library: [],
            versions: [
              {
                id: 'version-1',
                version: 7,
                createdAt: '2026-03-28T08:00:00.000Z',
                createdBy: 'ops-admin',
                itemCount: 2,
                sourceVersionId: 'version-6',
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/rule-sets')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'rule-set-1',
                name: 'Ops Rules',
                scope: 'org',
                version: 3,
                config: {
                  source: 'manual',
                  rule: {
                    timezone: 'Asia/Shanghai',
                    workStartTime: '09:00',
                    workEndTime: '18:00',
                    workingDays: [1, 2, 3, 4, 5],
                  },
                },
                isDefault: true,
              },
            ],
            total: (attendanceGroupsData ?? [null]).length,
          },
        })
      }
      if (url.includes('/api/attendance/groups/group-a/managers')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'manager-1',
                groupId: 'group-a',
                userId: 'owner-1',
                role: 'owner',
                createdBy: 'ops-admin',
                createdAt: '2026-03-28T08:10:00.000Z',
              },
              {
                id: 'manager-2',
                groupId: 'group-a',
                userId: 'owner-2',
                role: 'sub_owner',
                createdBy: 'ops-admin',
                createdAt: '2026-03-28T08:20:00.000Z',
              },
            ],
            total: 2,
          },
        })
      }
      if (url.includes('/api/attendance/groups/group-a/members')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'member-1',
                groupId: 'group-a',
                userId: 'user-1',
                createdAt: '2026-03-28T08:00:00.000Z',
              },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/groups')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: attendanceGroupsData ?? [
              {
                id: 'group-a',
                name: 'Ops Team',
                code: 'ops-team',
                timezone: 'Asia/Shanghai',
                ruleSetId: 'rule-set-1',
                attendanceType: 'fixed_shift',
                description: 'Operations attendance group',
                memberCount: 1,
                createdAt: '2026-03-28T08:00:00.000Z',
                updatedAt: '2026-03-28T08:30:00.000Z',
              },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/advanced-scheduling/workbench')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            range: { from: '2026-05-01', to: '2026-05-31' },
            summary: {
              scheduleGroups: 1,
              scheduleGroupMembers: 2,
              schedulerScopes: 1,
              shifts: 2,
              rotationRules: 1,
              shiftAssignments: 1,
              rotationAssignments: 9,
              assignedUsers: 10,
              diagnostics: 1,
              groupsWithoutMembers: 0,
              assignmentUsersWithoutScheduleGroup: 1,
              usersWithMultipleScheduleGroups: 0,
              usersWithBothAssignmentKinds: 0,
            },
            scheduleGroups: {
              total: 1,
              items: [
                {
                  id: 'sg-1',
                  name: 'Line A',
                  code: 'line-a',
                  source: 'manual',
                  memberCount: 2,
                  assignedUserCount: 1,
                  shiftAssignmentCount: 1,
                  rotationAssignmentCount: 1,
                  isActive: true,
                },
              ],
            },
            diagnostics: [
              {
                code: 'assignment_without_schedule_group',
                severity: 'warning',
                message: 'Active shift or rotation assignments reference users without an effective schedule-group membership in this range.',
                count: 1,
                userIds: ['user-3'],
                scheduleGroupIds: [],
              },
            ],
            metadata: {
              readOnly: true,
              source: 'attendance_advanced_scheduling_workbench',
              truncation: {
                assignmentLimit: 500,
                shiftAssignments: true,
                rotationAssignments: false,
                truncated: true,
              },
              sampling: {
                assignmentLimit: 500,
                sampled: true,
                shiftAssignments: {
                  visible: 1,
                  total: 1,
                  truncated: true,
                },
                rotationAssignments: {
                  visible: 1,
                  total: 9,
                  truncated: false,
                },
              },
            },
          },
        })
      }
      if (url.includes('/api/attendance/comprehensive-hours/preview')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            readOnly: true,
            period: {
              type: 'month',
              key: '2026-05',
              from: '2026-05-01',
              to: '2026-05-31',
              label: 'May 2026',
            },
            metric: 'planned',
            enforcement: 'warn',
            capMinutes: 9600,
            scope: {
              userIds: ['user-1'],
            },
            aggregate: {
              users: 1,
              ok: 0,
              warning: 0,
              violation: 1,
              totalMinutes: 10200,
              totalExcessMinutes: 600,
              totalRemainingMinutes: 0,
              status: 'violation',
            },
            rows: [
              {
                userId: 'user-1',
                minutes: 10200,
                plannedMinutes: 10200,
                capMinutes: 9600,
                remainingMinutes: 0,
                excessMinutes: 600,
                status: 'violation',
                source: 'effective_calendar',
                days: 31,
                workingDays: 22,
              },
            ],
            degraded: false,
          },
        })
      }
      if (url.includes('/api/attendance/leave-types')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'leave-type-1',
                code: 'annual_leave',
                name: 'Annual Leave',
                paid: true,
                requiresApproval: true,
                requiresAttachment: false,
                defaultMinutesPerDay: 480,
                isActive: true,
              },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/import/batches/batch-1/items')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            total: 1,
            items: [
              {
                id: 'item-1',
                userId: 'user-1',
                workDate: '2026-03-28',
                recordId: null,
                createdAt: '2026-03-28T09:00:00.000Z',
                previewSnapshot: {
                  metrics: {
                    status: 'warning',
                    workMinutes: 470,
                    lateMinutes: 12,
                    earlyLeaveMinutes: 0,
                    leaveMinutes: 0,
                    overtimeMinutes: 30,
                    warnings: ['Missing downstream record'],
                  },
                  policy: {
                    matchedRuleSet: 'Default policy',
                  },
                  engine: {
                    adapter: 'bulk',
                  },
                },
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/import/batches')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'batch-1',
                status: 'completed',
                rowCount: 3,
                source: 'csv',
                createdBy: 'ops-admin',
                createdAt: '2026-03-28T08:30:00.000Z',
                updatedAt: '2026-03-28T09:00:00.000Z',
                ruleSetId: '',
                mapping: {
                  firstInAt: '1_on_duty_user_check_time',
                  lastOutAt: '1_off_duty_user_check_time',
                },
                meta: {
                  engine: 'bulk',
                  chunkConfig: {
                    itemsChunkSize: 200,
                    recordsChunkSize: 100,
                  },
                },
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/import/template')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            payloadExample: {
              source: 'dingtalk',
              mode: 'override',
              columns: ['userId', 'workDate', 'firstInAt', 'lastOutAt'],
              requiredFields: ['userId', 'workDate'],
              ruleSetId: '<ruleSetId>',
              userId: '<userId>',
            },
            mappingProfiles: [
              {
                id: 'default-profile',
                name: 'Default profile',
                description: 'Default import mapping',
                requiredFields: ['userId'],
                mapping: {
                  firstInAt: { sourceField: '1_on_duty_user_check_time' },
                },
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/records')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'record-1',
                work_date: '2026-05-13',
                user_id: 'user-1',
                user_name: 'Ada',
                first_in_at: '2026-05-13T09:00:00.000Z',
                last_out_at: '2026-05-13T18:00:00.000Z',
                work_minutes: 480,
                late_minutes: 0,
                early_leave_minutes: 0,
                status: 'normal',
                is_workday: true,
                meta: {},
              },
            ],
            total: 1,
            reportFields: [
              { code: 'work_date', name: '日期', sortOrder: 1000 },
              { code: 'employee_name', name: '姓名', sortOrder: 1010 },
            ],
            reportFieldConfig: {
              multitable: {
                available: true,
                degraded: false,
                projectId: 'default:attendance',
                objectId: 'attendance_report_field_catalog',
                sheetId: 'sheet-1',
                viewId: 'fields_by_category',
              },
              fieldsFingerprint: {
                algorithm: 'sha1',
                value: 'records-unit-test-fingerprint',
                fieldCount: 2,
                codes: ['work_date', 'employee_name'],
              },
            },
          },
        })
      }
      if (url.includes('/api/attendance/export')) {
        return textResponse(200, '日期,姓名\n2026-05-13,Ada\n', {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="attendance-export.csv"',
          'X-Attendance-Report-Fields-Fingerprint-Algorithm': 'sha1',
          'X-Attendance-Report-Fields-Fingerprint': exportReportFieldFingerprint,
          'X-Attendance-Report-Fields-Count': exportReportFieldCount,
          'X-Attendance-Report-Fields-Codes': exportReportFieldCodes,
          'X-Attendance-Report-Fields-Project-Id': exportReportFieldProjectId,
          'X-Attendance-Report-Fields-Object-Id': exportReportFieldObjectId,
          'X-Attendance-Report-Fields-Sheet-Id': exportReportFieldSheetId,
          'X-Attendance-Report-Fields-View-Id': exportReportFieldViewId,
        })
      }
      if (url.includes('/api/attendance/settings')) {
        const settingsMethod = String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase()
        if (settingsMethod !== 'GET') {
          return jsonResponse(200, { ok: true, data: attendanceSettingsSaveData ?? {} })
        }
        if (attendanceSettingsFail) {
          return jsonResponse(500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'settings unavailable' } })
        }
        return jsonResponse(200, { ok: true, data: attendanceSettingsData ?? {} })
      }
      if (url.includes('/api/attendance/auto-shift-matching/preview')) {
        if (autoShiftPreviewStatus >= 400) {
          return jsonResponse(autoShiftPreviewStatus, {
            ok: false,
            error: { code: 'AUTO_SHIFT_MATCHING_DISABLED', message: 'Auto shift matching preview is disabled' },
          })
        }
        return jsonResponse(200, {
          ok: true,
          data: autoShiftPreviewData ?? { items: [], skipped: [] },
        })
      }
      if (url.includes('/api/attendance/approval-flows')
        && String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase() === 'GET') {
        // Default [] keeps existing behaviour (loadApprovalFlows reads data.data.items || []); the outdoor
        // flow-select test seeds this to assert the active-outdoor_punch filter.
        return jsonResponse(200, { ok: true, data: { items: attendanceApprovalFlowsData ?? [] } })
      }
      if (url.includes('/api/attendance/scheduler-scopes')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'scope-1',
                subjectType: 'user',
                subjectRef: 'Alice',
                actions: ['view', 'edit'],
                scope: {
                  scheduleGroupIds: ['sg-1'],
                  attendanceGroupIds: [],
                  userIds: [],
                  departments: ['dept-eng'],
                  roles: [],
                  roleTags: [],
                },
                isActive: true,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 20,
          },
        })
      }
      return emptyAttendanceResponse()
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      })
    }
    app = null
    container = null
  })

  it('does not preload admin-only attendance data on the employee overview surface', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const requestedUrls = vi.mocked(apiFetch).mock.calls.map(call => String(call[0]))
    const overviewReadOnlyCatalogLoads = new Set([
      '/api/attendance/leave-types?isActive=true',
      '/api/attendance/overtime-rules?isActive=true',
    ])
    const forbiddenAdminLoads = [
      '/api/attendance-admin/',
      '/api/attendance/settings',
      '/api/attendance/rule-templates',
      '/api/attendance/rule-sets',
      '/api/attendance/groups',
      '/api/attendance/import/batches',
      '/api/attendance/report-fields',
      // NOTE: leave-types / overtime-rules are intentionally NOT in this forbidden list.
      // As of #2066 (self-service leave policies) the employee overview refresh loads the
      // ACTIVE leave-types and overtime-rules (?isActive=true) so the self-service leave /
      // overtime request form can populate its dropdowns (AttendanceView.vue:
      // requestForm.leaveTypeId / requestForm.overtimeRuleId). Those are employee-facing
      // reference reads, not admin-only preloads — the full admin lists stay showAdmin-gated.
      '/api/attendance/payroll-templates',
      '/api/attendance/approval-flows',
      '/api/attendance/payroll-cycles',
      '/api/attendance/advanced-scheduling/workbench',
      '/api/attendance/shifts',
      '/api/attendance/rotation-assignments',
      '/api/attendance/assignments',
      '/api/attendance/rotation-rules',
      '/api/attendance/scheduler-scopes',
    ]

    expect(requestedUrls.length).toBeGreaterThan(0)
    expect(
      requestedUrls.filter(url =>
        !overviewReadOnlyCatalogLoads.has(url)
        && forbiddenAdminLoads.some(prefix => url.startsWith(prefix))
      ),
    ).toEqual([])
  })

  it('renders scheduler scopes as a read-only registry under scheduling admin', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const scopesNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-scheduler-scopes"]')
    expect(scopesNav).toBeTruthy()
    scopesNav!.click()
    await flushUi(4)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-scheduler-scopes')
    expect(section).toBeTruthy()
    expect(window.getComputedStyle(section!).display).not.toBe('none')
    // The intent banner must ship — it keeps partial enforcement and deferred surfaces honest.
    const schedulerScopeIntentText = section!.querySelector('[data-attendance-scheduler-scopes-intent]')?.textContent || ''
    expect(schedulerScopeIntentText).toContain('selected runtime paths')
    expect(schedulerScopeIntentText).toContain('Async import jobs')
    // The mocked scope row renders by subjectRef (real wire render, not a vacuous mount).
    expect(section!.querySelector('[data-attendance-scheduler-scopes-list]')?.textContent || '').toContain('Alice')
    // Request the full first page so the registry is not silently capped at the backend default (no-silent-caps).
    const scopeCall = vi.mocked(apiFetch).mock.calls.map(call => String(call[0])).find(url => url.includes('/api/attendance/scheduler-scopes'))
    expect(scopeCall).toBeTruthy()
    expect(scopeCall).toContain('page=1')
    expect(scopeCall).toContain('pageSize=200')
  })

  it('flags truncation when scheduler scopes exceed the fetched page (no silent caps)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/attendance/scheduler-scopes')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 's1',
                subjectType: 'user',
                subjectRef: 'Alice',
                actions: ['view'],
                scope: { scheduleGroupIds: [], attendanceGroupIds: [], userIds: ['u1'], departments: [], roles: [], roleTags: [] },
                isActive: true,
              },
            ],
            total: 250,
            page: 1,
            pageSize: 200,
          },
        })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const scopesNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-scheduler-scopes"]')
    scopesNav!.click()
    await flushUi(4)

    const hint = container!.querySelector('[data-attendance-scheduler-scopes-truncated]')
    expect(hint).toBeTruthy()
    expect(hint?.textContent || '').toContain('250')
  })

  it('warns when the attendance-group picker source is capped (no silent caps)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/attendance/scheduler-scopes')) {
        return jsonResponse(200, { ok: true, data: { items: [], total: 0, page: 1, pageSize: 200 } })
      }
      if (url.includes('/api/attendance/groups')) {
        // Real COUNT(*) total 4 but only 1 item came back (the loader caps at pageSize) -> a group
        // past the cap would be silently un-pickable in the target <select> without this hint.
        return jsonResponse(200, { ok: true, data: { items: [
          { id: 'ag-1', name: 'AG 1', timezone: 'Asia/Shanghai' },
        ], total: 4 } })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-scheduler-scopes"]')!.click()
    await flushUi(4)
    const section = container!.querySelector<HTMLElement>('#attendance-admin-scheduler-scopes')!

    const hint = section.querySelector('[data-attendance-scheduler-scope-attendance-groups-truncated]')
    expect(hint).toBeTruthy()
    expect(hint?.textContent || '').toContain('of 4') // "Showing first 1 of 4 attendance groups …"
  })

  it('creates a scheduler scope, mapping each picker/chip target field to its scope key', async () => {
    const created: Array<Record<string, unknown>> = []
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = String(input)
      const method = String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase()
      if (url.startsWith('/api/admin/users')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'user-x', email: 'user-x@example.com', name: 'User X', role: 'employee', is_active: true, is_admin: false, last_login_at: null, created_at: '2026-05-30T00:00:00.000Z' },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/scheduler-scopes') && method === 'POST') {
        created.push(JSON.parse(String((init as { body?: string } | undefined)?.body || '{}')))
        return jsonResponse(200, { ok: true, data: { id: 'scope-new' } })
      }
      if (url.includes('/api/attendance/scheduler-scopes')) {
        return jsonResponse(200, { ok: true, data: { items: [], total: 0, page: 1, pageSize: 200 } })
      }
      if (url.includes('/api/attendance/groups/group-a/')) {
        return emptyAttendanceResponse()
      }
      if (url.includes('/api/attendance/groups')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'group-a', name: 'Ops Team', code: 'ops-team', timezone: 'Asia/Shanghai', attendanceType: 'fixed_shift', memberCount: 1 },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/advanced-scheduling/workbench')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            summary: {
              scheduleGroups: 1,
              scheduleGroupMembers: 0,
              schedulerScopes: 0,
              shifts: 0,
              rotationRules: 0,
              shiftAssignments: 0,
              rotationAssignments: 0,
              assignedUsers: 0,
              diagnostics: 0,
              groupsWithoutMembers: 0,
              assignmentUsersWithoutScheduleGroup: 0,
              usersWithMultipleScheduleGroups: 0,
              usersWithBothAssignmentKinds: 0,
            },
            scheduleGroups: {
              items: [{ id: 'sg-1', name: 'Line A', code: 'line-a', source: 'manual', memberCount: 0, assignedUserCount: 0, shiftAssignmentCount: 0, rotationAssignmentCount: 0, isActive: true }],
              total: 1,
            },
            diagnostics: [],
            metadata: { readOnly: true },
          },
        })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-scheduler-scopes"]')!.click()
    await flushUi(4)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-scheduler-scopes')!
    const subjectType = section.querySelector<HTMLSelectElement>('#attendance-scheduler-scope-subject-type')!
    subjectType.value = 'role'
    subjectType.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    const subjectRef = section.querySelector<HTMLInputElement>('#attendance-scheduler-scope-subject-ref')!
    subjectRef.value = 'attendance_admin'
    subjectRef.dispatchEvent(new Event('input', { bubbles: true }))
    section.querySelector<HTMLInputElement>('[data-attendance-scheduler-scope-actions] input[data-action="view"]')!.click()

    // Distinct sentinel per target field — catches a field wired to the wrong scope key
    // (the backend normalizer silently drops unknown keys; this is the A2 round-trip guard).
    const addTextTarget = (key: string, id: string, value: string): void => {
      const el = section.querySelector<HTMLInputElement>(`#${id}`)!
      el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      section.querySelector<HTMLButtonElement>(`[data-attendance-scheduler-scope-target-add="${key}"]`)!.click()
    }
    addTextTarget('departments', 'attendance-scheduler-scope-target-departments', 'dept-x')
    selectMultipleOptions(section, '#attendance-scheduler-scope-target-attendance-groups', ['group-a'])
    selectMultipleOptions(section, '#attendance-scheduler-scope-target-schedule-groups', ['sg-1'])
    selectUserPicker(section, '#attendance-scheduler-scope-target-users', 'user-x')
    await flushUi(2)
    section.querySelector<HTMLButtonElement>('[data-attendance-scheduler-scope-target-user-add]')!.click()
    addTextTarget('roles', 'attendance-scheduler-scope-target-roles', 'role-x')
    addTextTarget('roleTags', 'attendance-scheduler-scope-target-role-tags', 'tag-x')
    await flushUi(2)

    section.querySelector<HTMLButtonElement>('[data-attendance-scheduler-scope-create]')!.click()
    await flushUi(4)

    expect(created).toHaveLength(1)
    // toEqual (not toMatchObject) so an extra body key — e.g. a re-added orgId, which the
    // backend's .strict() schema rejects with 400 — fails the test instead of slipping through.
    expect(created[0]).toEqual({
      subjectType: 'role',
      subjectRef: 'attendance_admin',
      actions: ['view'],
      scope: {
        departments: ['dept-x'],
        attendanceGroupIds: ['group-a'],
        scheduleGroupIds: ['sg-1'],
        userIds: ['user-x'],
        roles: ['role-x'],
        roleTags: ['tag-x'],
      },
    })
  })

  it('refuses to create a scheduler scope without a target and explains why', async () => {
    const posts: unknown[] = []
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = String(input)
      const method = String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase()
      if (url.includes('/api/attendance/scheduler-scopes') && method === 'POST') {
        posts.push(1)
        return jsonResponse(200, { ok: true, data: {} })
      }
      if (url.includes('/api/attendance/scheduler-scopes')) {
        return jsonResponse(200, { ok: true, data: { items: [], total: 0, page: 1, pageSize: 200 } })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-scheduler-scopes"]')!.click()
    await flushUi(4)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-scheduler-scopes')!
    const subjectType = section.querySelector<HTMLSelectElement>('#attendance-scheduler-scope-subject-type')!
    subjectType.value = 'role'
    subjectType.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    const subjectRef = section.querySelector<HTMLInputElement>('#attendance-scheduler-scope-subject-ref')!
    subjectRef.value = 'attendance_admin'
    subjectRef.dispatchEvent(new Event('input', { bubbles: true }))
    section.querySelector<HTMLInputElement>('[data-attendance-scheduler-scope-actions] input[data-action="view"]')!.click()
    await flushUi(2)

    // No targets entered → client guard blocks the POST.
    section.querySelector<HTMLButtonElement>('[data-attendance-scheduler-scope-create]')!.click()
    await flushUi(4)

    expect(posts).toEqual([])
    expect(container!.textContent).toContain('Add at least one scope target')
  })

  it('clears the scheduler scope subject ref when the subject type changes', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-scheduler-scopes"]')!.click()
    await flushUi(4)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-scheduler-scopes')!
    const subjectType = section.querySelector<HTMLSelectElement>('#attendance-scheduler-scope-subject-type')!
    subjectType.value = 'role'
    subjectType.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    const subjectRef = section.querySelector<HTMLInputElement>('#attendance-scheduler-scope-subject-ref')!
    subjectRef.value = 'some-role'
    subjectRef.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(1)

    subjectType.value = 'role_tag'
    subjectType.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    expect(section.querySelector<HTMLInputElement>('#attendance-scheduler-scope-subject-ref')!.value).toBe('')
  })

  it('edits a scope: prefills the form then PUTs the full strict body to the scope id', async () => {
    const puts: Array<{ url: string; body: Record<string, unknown> }> = []
    const existing = {
      id: 'scope-7',
      subjectType: 'role',
      subjectRef: 'attendance_admin',
      actions: ['view', 'edit'],
      scope: { scheduleGroupIds: [], attendanceGroupIds: [], userIds: [], departments: ['dept-x'], roles: [], roleTags: [] },
      isActive: true,
    }
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = String(input)
      const method = String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase()
      if (url.includes('/api/attendance/scheduler-scopes/scope-7') && method === 'PUT') {
        puts.push({ url, body: JSON.parse(String((init as { body?: string } | undefined)?.body || '{}')) })
        return jsonResponse(200, { ok: true, data: { ...existing } })
      }
      if (url.includes('/api/attendance/scheduler-scopes')) {
        return jsonResponse(200, { ok: true, data: { items: [existing], total: 1, page: 1, pageSize: 200 } })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-scheduler-scopes"]')!.click()
    await flushUi(4)
    const section = container!.querySelector<HTMLElement>('#attendance-admin-scheduler-scopes')!

    section.querySelector<HTMLButtonElement>('[data-attendance-scheduler-scope-item] [data-attendance-scheduler-scope-edit]')!.click()
    await flushUi(2)
    const deptChips = section.querySelector<HTMLElement>('[data-attendance-scheduler-scope-target-chips="departments"]')!
    expect(deptChips.textContent).toContain('dept-x') // prefilled from the existing scope
    deptChips.querySelector<HTMLButtonElement>('[data-attendance-scheduler-scope-target-remove="departments"]')!.click()
    const dept = section.querySelector<HTMLInputElement>('#attendance-scheduler-scope-target-departments')!
    dept.value = 'dept-y'
    dept.dispatchEvent(new Event('input', { bubbles: true }))
    section.querySelector<HTMLButtonElement>('[data-attendance-scheduler-scope-target-add="departments"]')!.click()
    await flushUi(2)

    section.querySelector<HTMLButtonElement>('[data-attendance-scheduler-scope-create]')!.click()
    await flushUi(4)

    expect(puts).toHaveLength(1)
    expect(puts[0].url).toContain('/api/attendance/scheduler-scopes/scope-7')
    // toEqual: no orgId (rides the query) and no isActive (backend merge preserves the flag).
    expect(puts[0].body).toEqual({
      subjectType: 'role',
      subjectRef: 'attendance_admin',
      actions: ['view', 'edit'],
      scope: {
        scheduleGroupIds: [],
        attendanceGroupIds: [],
        userIds: [],
        departments: ['dept-y'],
        roles: [],
        roleTags: [],
      },
    })
  })

  it('keeps the user subject ref through edit hydration (PUTs the original UUID, not blank)', async () => {
    const uuid = '11111111-1111-1111-1111-111111111111'
    const puts: Array<Record<string, unknown>> = []
    const existing = {
      id: 'scope-u',
      subjectType: 'user',
      subjectRef: uuid,
      actions: ['view'],
      scope: { scheduleGroupIds: [], attendanceGroupIds: [], userIds: ['u-1'], departments: [], roles: [], roleTags: [] },
      isActive: true,
    }
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = String(input)
      const method = String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase()
      if (url.includes('/api/attendance/scheduler-scopes/scope-u') && method === 'PUT') {
        puts.push(JSON.parse(String((init as { body?: string } | undefined)?.body || '{}')))
        return jsonResponse(200, { ok: true, data: { ...existing } })
      }
      if (url.includes('/api/attendance/scheduler-scopes')) {
        return jsonResponse(200, { ok: true, data: { items: [existing], total: 1, page: 1, pageSize: 200 } })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-scheduler-scopes"]')!.click()
    await flushUi(4)
    const section = container!.querySelector<HTMLElement>('#attendance-admin-scheduler-scopes')!

    section.querySelector<HTMLButtonElement>('[data-attendance-scheduler-scope-item] [data-attendance-scheduler-scope-edit]')!.click()
    await flushUi(4) // hydration nextTick + the subjectType watcher must both flush

    // Submit unchanged. If the hydration guard had let the watcher wipe subjectRef, it would be ''
    // and client validation would block the PUT. A PUT carrying the original UUID proves the guard.
    section.querySelector<HTMLButtonElement>('[data-attendance-scheduler-scope-create]')!.click()
    await flushUi(4)

    expect(puts).toHaveLength(1)
    expect(puts[0].subjectType).toBe('user')
    expect(puts[0].subjectRef).toBe(uuid)
  })

  it('deactivates a scope: DELETEs its id and drops it from the active list', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const deletes: string[] = []
    let items: Array<Record<string, unknown>> = [
      { id: 'scope-d', subjectType: 'role', subjectRef: 'r1', actions: ['view'], scope: { scheduleGroupIds: [], attendanceGroupIds: [], userIds: [], departments: ['d1'], roles: [], roleTags: [] }, isActive: true },
    ]
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = String(input)
      const method = String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase()
      if (url.includes('/api/attendance/scheduler-scopes/scope-d') && method === 'DELETE') {
        deletes.push(url)
        items = [] // soft-deactivated rows leave the active-only list
        return jsonResponse(200, { ok: true, data: { id: 'scope-d', isActive: false } })
      }
      if (url.includes('/api/attendance/scheduler-scopes')) {
        return jsonResponse(200, { ok: true, data: { items, total: items.length, page: 1, pageSize: 200 } })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-scheduler-scopes"]')!.click()
    await flushUi(4)
    const section = container!.querySelector<HTMLElement>('#attendance-admin-scheduler-scopes')!
    expect(section.querySelector('[data-attendance-scheduler-scope-item]')).toBeTruthy()

    section.querySelector<HTMLButtonElement>('[data-attendance-scheduler-scope-item] [data-attendance-scheduler-scope-deactivate]')!.click()
    await flushUi(4)

    expect(confirmSpy).toHaveBeenCalled() // gated behind a confirm, like the file's other destructive admin actions
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toContain('/api/attendance/scheduler-scopes/scope-d') // the specific id, not just "a DELETE"
    // reactivation / an inactive view is a follow-up slice — the deactivated row is gone here.
    expect(section.querySelector('[data-attendance-scheduler-scope-item]')).toBeNull()
    confirmSpy.mockRestore()
  })

  it('does not deactivate a scope when the confirmation is dismissed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const deletes: string[] = []
    const items = [
      { id: 'scope-d', subjectType: 'role', subjectRef: 'r1', actions: ['view'], scope: { scheduleGroupIds: [], attendanceGroupIds: [], userIds: [], departments: ['d1'], roles: [], roleTags: [] }, isActive: true },
    ]
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = String(input)
      const method = String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase()
      if (url.includes('/api/attendance/scheduler-scopes/scope-d') && method === 'DELETE') {
        deletes.push(url)
        return jsonResponse(200, { ok: true, data: { id: 'scope-d', isActive: false } })
      }
      if (url.includes('/api/attendance/scheduler-scopes')) {
        return jsonResponse(200, { ok: true, data: { items, total: items.length, page: 1, pageSize: 200 } })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-scheduler-scopes"]')!.click()
    await flushUi(4)
    const section = container!.querySelector<HTMLElement>('#attendance-admin-scheduler-scopes')!

    section.querySelector<HTMLButtonElement>('[data-attendance-scheduler-scope-item] [data-attendance-scheduler-scope-deactivate]')!.click()
    await flushUi(4)

    expect(confirmSpy).toHaveBeenCalled() // the confirm IS consulted...
    expect(deletes).toHaveLength(0) // ...and dismissing it sends no DELETE
    expect(section.querySelector('[data-attendance-scheduler-scope-item]')).toBeTruthy() // the row stays in the active list
    confirmSpy.mockRestore()
  })

  it('keeps the clicked admin section focused and retires the show-all toggle', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const settings = container!.querySelector<HTMLElement>('#attendance-admin-settings')
    const groupMembers = container!.querySelector<HTMLElement>('#attendance-admin-group-members')
    expect(settings).toBeTruthy()
    expect(groupMembers).toBeTruthy()
    expect(window.getComputedStyle(settings!).display).not.toBe('none')
    expect(window.getComputedStyle(groupMembers!).display).toBe('none')

    const groupMembersNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-group-members"]')
    expect(groupMembersNav).toBeTruthy()
    groupMembersNav!.click()
    await flushUi(2)

    expect(container!.querySelector('[data-admin-focus-toggle="true"]')).toBeNull()
    expect(window.getComputedStyle(settings!).display).toBe('none')
    expect(window.getComputedStyle(groupMembers!).display).not.toBe('none')
    expect(container!.querySelector('[data-admin-shortcut="attendance-admin-group-members"]')?.textContent).toContain('Organization · Group members')
    expect(container!.textContent).toContain('Group members now live inside the selected attendance group detail.')
    expect(container!.textContent).toContain('Open Attendance groups')
  })

  it('blocks empty manual payroll cycles and selects a newly saved cycle for summary', async () => {
    const savedCycle = {
      id: 'cycle-new',
      templateId: null,
      name: 'Manual May',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      status: 'open',
    }
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      const method = String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase()
      if (url.includes('/api/attendance/payroll-cycles/cycle-new/summary')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            summary: {
              total_days: 20,
              total_minutes: 9600,
              normal_days: 20,
              late_days: 0,
              early_leave_days: 0,
              late_early_days: 0,
              partial_days: 0,
              absent_days: 0,
              adjusted_days: 0,
              off_days: 8,
            },
          },
        })
      }
      if (url === '/api/attendance/payroll-cycles' && method === 'POST') {
        return jsonResponse(200, { ok: true, data: savedCycle })
      }
      if (url.includes('/api/attendance/payroll-cycles')) {
        return jsonResponse(200, { ok: true, data: { items: [savedCycle] } })
      }
      if (url.includes('/api/attendance/payroll-templates')) {
        return jsonResponse(200, { ok: true, data: { items: [] } })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const dataPayrollHeader = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-nav-group-header'))
      .find(button => button.textContent?.includes('Data & Payroll'))
    expect(dataPayrollHeader).toBeTruthy()
    if (dataPayrollHeader!.getAttribute('aria-expanded') === 'false') {
      dataPayrollHeader!.click()
      await flushUi(2)
    }

    const payrollCyclesNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-payroll-cycles"]')
    expect(payrollCyclesNav).toBeTruthy()
    payrollCyclesNav!.click()
    await flushUi(2)

    const payrollCyclesSection = container!.querySelector<HTMLElement>('[data-admin-section="attendance-admin-payroll-cycles"]')
    expect(payrollCyclesSection).toBeTruthy()
    const createButton = Array.from(payrollCyclesSection!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Create cycle'))
    expect(createButton).toBeTruthy()
    expect(createButton!.disabled).toBe(true)
    expect(payrollCyclesSection!.querySelector('[data-payroll-cycle-validation-hint]')?.textContent).toContain('start and end dates')
    expect(payrollCyclesSection!.querySelector<HTMLInputElement>('#attendance-payroll-cycle-start')?.getAttribute('aria-invalid')).toBe('true')

    setInput(payrollCyclesSection!, '#attendance-payroll-cycle-name', 'Manual May')
    setInput(payrollCyclesSection!, '#attendance-payroll-cycle-start', '2026-05-01')
    setInput(payrollCyclesSection!, '#attendance-payroll-cycle-end', '2026-05-31')
    await flushUi(2)

    expect(createButton!.disabled).toBe(false)
    createButton!.click()
    await flushUi(6)

    const postCall = vi.mocked(apiFetch).mock.calls.find(call =>
      String(call[0]) === '/api/attendance/payroll-cycles' &&
      String((call[1] as { method?: string } | undefined)?.method || '').toUpperCase() === 'POST'
    )
    expect(postCall).toBeTruthy()
    expect(JSON.parse(String((postCall![1] as { body?: string }).body))).toMatchObject({
      name: 'Manual May',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    })

    const loadSummaryButton = Array.from(payrollCyclesSection!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Load summary'))
    expect(loadSummaryButton?.disabled).toBe(false)
    loadSummaryButton!.click()
    await flushUi(6)

    expect(vi.mocked(apiFetch).mock.calls.some(call =>
      String(call[0]).includes('/api/attendance/payroll-cycles/cycle-new/summary')
    )).toBe(true)
    expect(payrollCyclesSection!.textContent).toContain('Cycle total minutes')
    expect(payrollCyclesSection!.textContent).toContain('9600')
  })

  it('renders attendance groups as a list-detail manager with people inside the selected group', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const groupsNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsNav).toBeTruthy()
    groupsNav!.click()
    await flushUi(4)

    const groupsSection = container!.querySelector<HTMLElement>('#attendance-admin-groups')
    expect(groupsSection).toBeTruthy()
    expect(window.getComputedStyle(groupsSection!).display).not.toBe('none')

    expect(groupsSection!.matches('[data-attendance-group-manager]')).toBe(true)
    expect(groupsSection!.querySelector('[data-attendance-group-list]')?.textContent).toContain('Ops Team')
    expect(groupsSection!.querySelector('[data-attendance-group-detail]')?.textContent).toContain('Basic info')
    expect(groupsSection!.querySelector('[data-attendance-group-people]')?.textContent).toContain('User picker')
    expect(groupsSection!.querySelector('[data-attendance-group-people]')?.textContent).toContain('Append selected user')
    expect(groupsSection!.querySelector('[data-attendance-group-people]')?.textContent).toContain('user-1')
    expect(groupsSection!.querySelector('[data-attendance-group-managers]')?.textContent).toContain('Owners')
    expect(groupsSection!.querySelector('[data-attendance-group-managers]')?.textContent).toContain('owner-1')
    expect(groupsSection!.querySelector('[data-attendance-group-managers]')?.textContent).toContain('Sub-owner')
    expect(groupsSection!.querySelector('[data-attendance-group-managers]')?.textContent).toContain('Owners are not counted as attendance people')
    expect(groupsSection!.querySelector('[data-attendance-group-manager-count]')?.textContent).toContain('1 owner')
    const summaryGrid = groupsSection!.querySelector<HTMLElement>('[data-attendance-group-summaries]')
    expect(summaryGrid).toBeTruthy()
    const rulePolicyCard = summaryGrid!.querySelector<HTMLElement>('[data-attendance-group-summary-card="rule-policy"]')
    expect(rulePolicyCard?.textContent).toContain('Ops Rules')
    expect(rulePolicyCard?.querySelector('[data-attendance-group-policy-line="work-window"]')?.textContent).toContain('09:00 - 18:00')
    expect(rulePolicyCard?.querySelector('[data-attendance-group-policy-line="working-days"]')?.textContent).toContain('Mon')
    expect(summaryGrid!.querySelector('[data-attendance-group-summary-card="work-time"]')?.textContent).toContain('Fixed shift')
    expect(groupsSection!.querySelector<HTMLSelectElement>('[data-attendance-group-type]')?.disabled).toBe(true)
    expect(summaryGrid!.querySelector('[data-attendance-group-summary-card="scheduling-coverage"]')?.textContent).toContain('Advanced scheduling owns rotation and coverage checks')
    expect(summaryGrid!.querySelector('[data-attendance-group-summary-card="comprehensive-hours"]')?.textContent).toContain('Review and reporting live in their own admin surface')
    expect(summaryGrid!.querySelector('[data-attendance-group-summary-card="punch-method"]')?.textContent).toContain('applies to all attendance groups')
    expect(summaryGrid!.querySelector('[data-attendance-group-summary-card="advanced-controls"]')?.textContent).toContain('No disabled fake controls')
    expect(summaryGrid!.querySelectorAll('input, textarea, select').length).toBe(0)
    expect(Array.from(summaryGrid!.querySelectorAll('button')).every(button => button.textContent?.trim().startsWith('Open'))).toBe(true)

    const beforeRuleDrawerCalls = vi.mocked(apiFetch).mock.calls.length
    const openRulePolicy = summaryGrid!.querySelector<HTMLButtonElement>('[data-attendance-group-summary-action="open-rule-policy-drawer"]')
    expect(openRulePolicy).toBeTruthy()
    openRulePolicy!.click()
    await flushUi(2)

    const ruleDrawer = groupsSection!.querySelector<HTMLElement>('[data-attendance-group-rule-policy-drawer]')
    expect(ruleDrawer).toBeTruthy()
    expect(ruleDrawer!.querySelector('[data-attendance-group-rule-policy-scope]')?.textContent).toContain('Group rule link')
    expect(ruleDrawer!.querySelector('[data-attendance-group-rule-policy-line="rule-set"]')?.textContent).toContain('Ops Rules')
    expect(ruleDrawer!.querySelector('[data-attendance-group-rule-policy-line="work-window"]')?.textContent).toContain('09:00 - 18:00')
    expect(ruleDrawer!.querySelector('[data-attendance-group-rule-policy-line="working-days"]')?.textContent).toContain('Mon')
    expect(ruleDrawer!.querySelector('[data-attendance-group-rule-policy-priority]')?.textContent).toContain('Date-specific priority preview')
    expect(ruleDrawer!.querySelector('[data-attendance-group-rule-policy-boundary]')?.textContent).toContain('Group-owned rule editing deferred')
    expect(ruleDrawer!.querySelectorAll('input, select, textarea').length).toBe(0)
    expect(vi.mocked(apiFetch).mock.calls.slice(beforeRuleDrawerCalls)).toHaveLength(0)

    ruleDrawer!.querySelector<HTMLButtonElement>('[data-attendance-group-rule-policy-close]')!.click()
    await flushUi(2)
    expect(groupsSection!.querySelector('[data-attendance-group-rule-policy-drawer]')).toBeNull()

    const beforeSavedDrawerCalls = vi.mocked(apiFetch).mock.calls.length
    const openWorkTime = summaryGrid!.querySelector<HTMLButtonElement>('[data-attendance-group-summary-action="open-work-time-drawer"]')
    expect(openWorkTime).toBeTruthy()
    openWorkTime!.click()
    await flushUi(2)

    const savedDrawer = groupsSection!.querySelector<HTMLElement>('[data-attendance-group-work-time-drawer]')
    expect(savedDrawer).toBeTruthy()
    expect(savedDrawer!.querySelectorAll('[data-attendance-group-work-time-option]').length).toBe(3)
    expect(savedDrawer!.querySelector('[data-attendance-group-work-time-selected]')?.textContent).toContain('Fixed shift')
    expect(savedDrawer!.querySelector('[data-attendance-group-work-time-lock]')?.textContent).toContain('Type changes are blocked')
    expect(savedDrawer!.querySelector<HTMLButtonElement>('[data-attendance-group-work-time-option="free_time"]')?.disabled).toBe(true)
    expect(savedDrawer!.querySelectorAll('[data-attendance-group-work-time-week-day]').length).toBe(7)
    expect(savedDrawer!.querySelector('[data-attendance-group-work-time-holidays]')?.textContent).toContain('Holiday calendar')
    expect(vi.mocked(apiFetch).mock.calls.slice(beforeSavedDrawerCalls)).toHaveLength(0)

    savedDrawer!.querySelector<HTMLButtonElement>('[data-attendance-group-work-time-close]')!.click()
    await flushUi(2)
    expect(groupsSection!.querySelector('[data-attendance-group-work-time-drawer]')).toBeNull()

    const newGroupButton = Array.from(groupsSection!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('New group'))
    expect(newGroupButton).toBeTruthy()
    newGroupButton!.click()
    await flushUi(2)

    expect(groupsSection!.querySelector('[data-attendance-group-detail]')?.textContent).toContain('New attendance group')
    expect(groupsSection!.querySelector<HTMLSelectElement>('[data-attendance-group-type]')?.disabled).toBe(false)
    expect(groupsSection!.querySelector('[data-attendance-group-people]')?.textContent).toContain('Save the group before adding people.')
    expect(groupsSection!.querySelector('[data-attendance-group-managers]')?.textContent).toContain('Save the group before adding owners.')
    expect(groupsSection!.querySelector('[data-attendance-group-summary-card="rule-policy"]')?.textContent).toContain('Choose or save a group first')

    const draftOpenWorkTime = groupsSection!.querySelector<HTMLButtonElement>('[data-attendance-group-summary-action="open-work-time-drawer"]')
    expect(draftOpenWorkTime).toBeTruthy()
    draftOpenWorkTime!.click()
    await flushUi(2)

    const draftDrawer = groupsSection!.querySelector<HTMLElement>('[data-attendance-group-work-time-drawer]')
    expect(draftDrawer).toBeTruthy()
    const freeTimeOption = draftDrawer!.querySelector<HTMLButtonElement>('[data-attendance-group-work-time-option="free_time"]')
    expect(freeTimeOption).toBeTruthy()
    expect(freeTimeOption!.disabled).toBe(false)
    freeTimeOption!.click()
    await flushUi(2)

    expect(groupsSection!.querySelector<HTMLSelectElement>('[data-attendance-group-type]')?.value).toBe('free_time')
    expect(draftDrawer!.querySelector('[data-attendance-group-work-time-selected]')?.textContent).toContain('Free time')
    expect(draftDrawer!.querySelector('[data-attendance-group-work-time-draft]')?.textContent).toContain('selected type')
    expect(draftDrawer!.querySelector('[data-attendance-group-work-time-week-matrix]')).toBeNull()
    expect(draftDrawer!.querySelector('[data-attendance-group-work-time-holidays]')).toBeNull()
  })

  it('manages attendance group owners separately from attendance members', async () => {
    const managerUserId = 'manager-user-1'
    const existingOwnerId = 'owner-user-1'
    const managerPostBodies: Array<Record<string, unknown>> = []
    const deletedManagerIds: string[] = []
    const managers = [
      {
        id: 'manager-owner',
        groupId: 'group-a',
        userId: existingOwnerId,
        role: 'owner',
        createdBy: 'ops-admin',
        createdAt: '2026-05-29T08:00:00.000Z',
      },
    ]

    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = String(init?.method || 'GET').toUpperCase()
      if (url.startsWith('/api/admin/users')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: managerUserId, email: 'manager@example.com', name: 'Manager User', role: 'employee', is_active: true, is_admin: false, last_login_at: null, created_at: '2026-05-29T00:00:00.000Z' },
              { id: existingOwnerId, email: 'owner@example.com', name: 'Ops Owner', role: 'employee', is_active: true, is_admin: false, last_login_at: null, created_at: '2026-05-29T00:00:00.000Z' },
            ],
          },
        })
      }
      if (url === '/api/attendance-admin/users/batch/resolve') {
        const body = JSON.parse(String(init?.body || '{}')) as { userIds?: string[] }
        const requested = Array.isArray(body.userIds) ? body.userIds : []
        return jsonResponse(200, {
          ok: true,
          data: {
            items: requested.map((userId) => ({
              id: userId,
              email: userId === managerUserId ? 'manager@example.com' : 'owner@example.com',
              name: userId === managerUserId ? 'Manager User' : 'Ops Owner',
              is_active: true,
            })),
          },
        })
      }
      if (url.includes('/api/attendance/rule-sets')) {
        return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      }
      if (url.startsWith('/api/attendance/groups?') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'group-a',
                name: 'Ops Team',
                code: 'ops-team',
                timezone: 'Asia/Shanghai',
                ruleSetId: null,
                attendanceType: 'fixed_shift',
                description: null,
                memberCount: 1,
              },
            ],
            total: 1,
          },
        })
      }
      if (url === '/api/attendance/groups/group-a/members' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'member-1',
                groupId: 'group-a',
                userId: 'member-user-1',
                createdAt: '2026-05-29T08:00:00.000Z',
              },
            ],
            total: 1,
          },
        })
      }
      if (url === '/api/attendance/groups/group-a/managers' && method === 'GET') {
        return jsonResponse(200, { ok: true, data: { items: [...managers], total: managers.length } })
      }
      if (url === '/api/attendance/groups/group-a/managers' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        managerPostBodies.push(body)
        managers.push({
          id: 'manager-sub-owner',
          groupId: 'group-a',
          userId: String(body.userId),
          role: String(body.role || 'owner'),
          createdBy: 'ops-admin',
          createdAt: '2026-05-29T08:30:00.000Z',
        })
        return jsonResponse(200, { ok: true, data: managers.at(-1) })
      }
      if (url === '/api/attendance/groups/group-a/managers/manager-owner' && method === 'DELETE') {
        deletedManagerIds.push('manager-owner')
        const index = managers.findIndex(manager => manager.id === 'manager-owner')
        if (index >= 0) managers.splice(index, 1)
        return jsonResponse(200, { ok: true, data: { id: 'manager-owner' } })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')!.click()
    await flushUi(4)

    const groupsSection = container!.querySelector<HTMLElement>('#attendance-admin-groups')!
    const managersSection = groupsSection.querySelector<HTMLElement>('[data-attendance-group-managers]')!
    expect(managersSection.textContent).toContain('Ops Owner')
    expect(groupsSection.querySelector('[data-attendance-group-list-member-count]')?.textContent).toContain('1 member')

    selectUserPicker(managersSection, '#attendance-group-manager-user-picker', managerUserId)
    const roleSelect = managersSection.querySelector<HTMLSelectElement>('[data-attendance-group-manager-role]')!
    roleSelect.value = 'sub_owner'
    roleSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    managersSection.querySelector<HTMLButtonElement>('[data-attendance-group-manager-add]')!.click()
    await flushUi(8)

    expect(managerPostBodies).toEqual([
      expect.objectContaining({
        userId: managerUserId,
        role: 'sub_owner',
      }),
    ])
    expect(managersSection.textContent).toContain('Manager User')
    expect(managersSection.textContent).toContain('Sub-owner')

    const existingOwnerRow = Array.from(managersSection.querySelectorAll<HTMLElement>('[data-attendance-group-manager-row]'))
      .find(row => row.textContent?.includes('Ops Owner'))
    expect(existingOwnerRow).toBeTruthy()
    existingOwnerRow!.querySelector<HTMLButtonElement>('[data-attendance-group-manager-remove]')!.click()
    await flushUi(8)

    expect(deletedManagerIds).toEqual(['manager-owner'])
    expect(Array.from(managersSection.querySelectorAll<HTMLElement>('[data-attendance-group-manager-row]')).some(row =>
      row.textContent?.includes('Ops Owner')
    )).toBe(false)
    expect(groupsSection.querySelector('[data-attendance-group-list-member-count]')?.textContent).toContain('1 member')
    expect(vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
      String(input).includes('/api/attendance/groups/group-a/members')
      && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(init?.method || 'GET').toUpperCase())
    )).toBe(false)
  })

  it('filters, exports, copies, and deletes attendance groups from the list tools', async () => {
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn(() => 'blob:attendance-groups')
    const revokeObjectURL = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    const savedGroups = [
      {
        id: 'group-a',
        name: 'Ops Team',
        code: 'ops-team',
        timezone: 'Asia/Shanghai',
        ruleSetId: 'rule-set-1',
        attendanceType: 'fixed_shift',
        description: 'Operations attendance group',
        memberCount: 3,
        createdAt: '2026-03-28T08:00:00.000Z',
        updatedAt: '2026-03-28T08:30:00.000Z',
      },
      {
        id: 'group-b',
        name: 'QA Team',
        code: 'qa-team',
        timezone: 'Asia/Shanghai',
        ruleSetId: null,
        attendanceType: 'scheduled_shift',
        description: 'Quality attendance group',
        memberCount: 0,
        createdAt: '2026-03-29T08:00:00.000Z',
        updatedAt: '2026-03-29T08:30:00.000Z',
      },
    ]
    const copyBodies: Array<Record<string, unknown>> = []
    const deletedGroupIds: string[] = []

    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = String(init?.method || 'GET').toUpperCase()
      if (url.includes('/api/attendance/rule-sets')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'rule-set-1',
                name: 'Ops Rules',
                scope: 'org',
                version: 3,
                config: {},
                isDefault: true,
              },
            ],
            total: 1,
          },
        })
      }
      if (url.startsWith('/api/attendance/groups?') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [...savedGroups],
            total: savedGroups.length,
          },
        })
      }
      if (url === '/api/attendance/groups' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        copyBodies.push(body)
        const copied = {
          id: 'group-copy',
          name: String(body.name || 'Copied group'),
          code: 'ops-team-copy',
          timezone: String(body.timezone || 'Asia/Shanghai'),
          ruleSetId: typeof body.ruleSetId === 'string' ? body.ruleSetId : null,
          attendanceType: String(body.attendanceType || 'fixed_shift'),
          description: typeof body.description === 'string' ? body.description : null,
          memberCount: 0,
          createdAt: '2026-03-30T08:00:00.000Z',
          updatedAt: '2026-03-30T08:00:00.000Z',
        }
        savedGroups.unshift(copied)
        return jsonResponse(200, { ok: true, data: copied })
      }
      if (url === '/api/attendance/groups/group-b' && method === 'DELETE') {
        deletedGroupIds.push('group-b')
        const index = savedGroups.findIndex(group => group.id === 'group-b')
        if (index >= 0) savedGroups.splice(index, 1)
        return jsonResponse(200, { ok: true, data: { id: 'group-b' } })
      }
      if (url === '/api/attendance/groups/group-a/members') {
        return jsonResponse(200, { ok: true, data: { items: [], total: 3 } })
      }
      if (url === '/api/attendance/groups/group-copy/members') {
        return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      }
      return emptyAttendanceResponse()
    })

    try {
      app = createApp(AttendanceView, { mode: 'admin' })
      app.mount(container!)
      await flushUi(8)

      container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')!.click()
      await flushUi(4)

      const groupsSection = container!.querySelector<HTMLElement>('#attendance-admin-groups')!
      const list = groupsSection.querySelector<HTMLElement>('[data-attendance-group-list]')!
      expect(list.textContent).toContain('2 groups')

      setInput(groupsSection, '#attendance-group-search', 'qa')
      await flushUi(2)
      expect(list.textContent).toContain('QA Team')
      expect(list.textContent).not.toContain('Ops Team')
      expect(list.textContent).toContain('1 of 2 groups')

      const ruleFilter = groupsSection.querySelector<HTMLSelectElement>('#attendance-group-rule-filter')!
      ruleFilter.value = 'rule-set-1'
      ruleFilter.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi(2)
      expect(list.textContent).toContain('No groups match')

      groupsSection.querySelector<HTMLButtonElement>('.attendance__group-list-tool-actions button:nth-child(2)')!.click()
      await flushUi(2)
      expect(list.textContent).toContain('Ops Team')
      expect(list.textContent).toContain('QA Team')

      const typeFilter = groupsSection.querySelector<HTMLSelectElement>('#attendance-group-type-filter')!
      typeFilter.value = 'fixed_shift'
      typeFilter.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi(2)
      expect(list.textContent).toContain('Ops Team')
      expect(list.textContent).not.toContain('QA Team')
      expect(list.textContent).toContain('1 of 2 groups')

      groupsSection.querySelector<HTMLButtonElement>('.attendance__group-list-tool-actions button:nth-child(2)')!.click()
      await flushUi(2)
      expect(list.textContent).toContain('Ops Team')
      expect(list.textContent).toContain('QA Team')

      groupsSection.querySelector<HTMLButtonElement>('[data-attendance-group-list-tools] .attendance__btn')!.click()
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:attendance-groups')

      const qaRow = Array.from(groupsSection.querySelectorAll<HTMLElement>('[data-attendance-group-row]'))
        .find(row => row.textContent?.includes('QA Team'))
      expect(qaRow).toBeTruthy()
      expect(qaRow!.querySelector<HTMLButtonElement>('[data-attendance-group-row-edit]')?.textContent).toContain('Edit')
      const beforeEditCalls = vi.mocked(apiFetch).mock.calls.length
      qaRow!.querySelector<HTMLButtonElement>('[data-attendance-group-row-edit]')!.click()
      await flushUi(2)
      expect(vi.mocked(apiFetch).mock.calls.slice(beforeEditCalls).filter(([, init]) =>
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(init?.method || 'GET').toUpperCase())
      )).toEqual([])
      expect(groupsSection.querySelector('[data-attendance-group-schedule-type-placeholder]')?.textContent).toContain('Scheduled shift')
      expect(groupsSection.querySelector('[data-attendance-group-fixed-schedule-preview]')).toBeNull()

      const opsRow = Array.from(groupsSection.querySelectorAll<HTMLElement>('[data-attendance-group-row]'))
        .find(row => row.textContent?.includes('Ops Team'))
      expect(opsRow).toBeTruthy()
      expect(opsRow!.querySelector('[data-attendance-group-list-member-count]')?.textContent).toContain('3 members')
      opsRow!.querySelector<HTMLButtonElement>('[data-attendance-group-copy]')!.click()
      await flushUi(8)

      expect(copyBodies).toEqual([
        expect.objectContaining({
          name: 'Ops Team copy',
          code: null,
          timezone: 'Asia/Shanghai',
          ruleSetId: 'rule-set-1',
          attendanceType: 'fixed_shift',
          description: 'Operations attendance group',
        }),
      ])
      expect(list.textContent).toContain('Ops Team copy')
      expect(groupsSection.querySelector('[data-attendance-group-detail]')?.textContent).toContain('Ops Team copy')

      const qaRowForDelete = Array.from(groupsSection.querySelectorAll<HTMLElement>('[data-attendance-group-row]'))
        .find(row => row.textContent?.includes('QA Team'))
      expect(qaRowForDelete).toBeTruthy()
      qaRowForDelete!.querySelector<HTMLButtonElement>('[data-attendance-group-row-delete]')!.click()
      await flushUi(8)

      expect(confirmSpy).toHaveBeenCalledTimes(1)
      expect(deletedGroupIds).toEqual(['group-b'])
      expect(list.textContent).not.toContain('QA Team')
      expect(groupsSection.querySelector('[data-attendance-group-detail]')?.textContent).toContain('Ops Team copy')
      expect(vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
        String(input).includes('/api/attendance/groups/group-b/members')
        && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(init?.method || 'GET').toUpperCase())
      )).toBe(false)
      expect(vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
        String(input).includes('/api/attendance/assignments')
        && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(init?.method || 'GET').toUpperCase())
      )).toBe(false)
    } finally {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
      confirmSpy.mockRestore()
    }
  })

  it('keeps attendance setup flows on user pickers and resolved labels instead of UUID handoffs', async () => {
    const memberUserId = '11111111-1111-4111-8111-111111111111'
    const shiftUserId = '22222222-2222-4222-8222-222222222222'
    const rotationUserId = '33333333-3333-4333-8333-333333333333'
    const memberPostBodies: unknown[] = []
    const resolvedUsers = new Map([
      [memberUserId, { id: memberUserId, email: 'mei.member@example.com', name: 'Mei Member', is_active: true }],
      [shiftUserId, { id: shiftUserId, email: 'shift.owner@example.com', name: 'Shift Owner', is_active: true }],
      [rotationUserId, { id: rotationUserId, email: 'rotation.owner@example.com', name: 'Rotation Owner', is_active: true }],
    ])
    const groupMembers: Array<{ id: string, groupId: string, userId: string, createdAt: string }> = []

    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = String(init?.method || 'GET').toUpperCase()
      if (url.startsWith('/api/admin/users')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: memberUserId, email: 'mei.member@example.com', name: 'Mei Member', role: 'employee', is_active: true, is_admin: false, last_login_at: null, created_at: '2026-05-28T00:00:00.000Z' },
              { id: shiftUserId, email: 'shift.owner@example.com', name: 'Shift Owner', role: 'employee', is_active: true, is_admin: false, last_login_at: null, created_at: '2026-05-28T00:00:00.000Z' },
              { id: rotationUserId, email: 'rotation.owner@example.com', name: 'Rotation Owner', role: 'employee', is_active: true, is_admin: false, last_login_at: null, created_at: '2026-05-28T00:00:00.000Z' },
            ],
          },
        })
      }
      if (url === '/api/attendance-admin/users/batch/resolve') {
        const body = JSON.parse(String(init?.body || '{}')) as { userIds?: string[] }
        const requested = Array.isArray(body.userIds) ? body.userIds : []
        return jsonResponse(200, {
          ok: true,
          data: {
            requested: requested.length,
            items: requested.map((userId) => resolvedUsers.get(userId)).filter(Boolean),
            missingUserIds: requested.filter((userId) => !resolvedUsers.has(userId)),
            inactiveUserIds: [],
          },
        })
      }
      if (url === '/api/attendance/groups/group-a/members' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'))
        memberPostBodies.push(body)
        const createdUserIds = Array.isArray(body.userIds) ? body.userIds : []
        groupMembers.splice(0, groupMembers.length, ...createdUserIds.map((userId: string, index: number) => ({
          id: `member-${index}`,
          groupId: 'group-a',
          userId,
          createdAt: '2026-05-28T08:00:00.000Z',
        })))
        return jsonResponse(200, { ok: true, data: { items: groupMembers, total: groupMembers.length } })
      }
      if (url === '/api/attendance/groups/group-a/members') {
        return jsonResponse(200, { ok: true, data: { items: groupMembers, total: groupMembers.length } })
      }
      if (url.startsWith('/api/attendance/groups?')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'group-a', name: 'Operations floor', code: 'ops_floor', timezone: 'Asia/Shanghai', ruleSetId: null },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'shift-a', name: 'Day shift', timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00', isOvernight: false, lateGraceMinutes: 10, earlyGraceMinutes: 10, roundingMinutes: 5, workingDays: [1, 2, 3, 4, 5] },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/rotation-rules')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'rot-1', name: 'Two shift', timezone: 'UTC', shiftSequence: ['shift-a'], isActive: true },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/assignments')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                assignment: { id: 'assignment-a', userId: shiftUserId, shiftId: 'shift-a', startDate: '2026-05-01', endDate: null, isActive: true },
                shift: { id: 'shift-a', name: 'Day shift', timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00', isOvernight: false, lateGraceMinutes: 10, earlyGraceMinutes: 10, roundingMinutes: 5, workingDays: [1, 2, 3, 4, 5] },
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/rotation-assignments')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                assignment: { id: 'rotation-assignment-a', userId: rotationUserId, rotationRuleId: 'rot-1', startDate: '2026-05-01', endDate: null, isActive: true },
                rotation: { id: 'rot-1', name: 'Two shift', timezone: 'UTC', shiftSequence: ['shift-a'], isActive: true },
              },
            ],
          },
        })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(10)

    const groupsNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsNav).toBeTruthy()
    groupsNav!.click()
    await flushUi(4)

    const people = container!.querySelector<HTMLElement>('[data-attendance-group-people]')
    expect(people).toBeTruthy()
    selectUserPicker(people!, '#attendance-group-member-user-picker', memberUserId)
    await flushUi(2)

    const addButton = Array.from(people!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Add members'))
    expect(addButton).toBeTruthy()
    expect(addButton!.disabled).toBe(false)
    addButton!.click()
    await flushUi(10)

    expect(memberPostBodies).toEqual([{ userIds: [memberUserId] }])
    expect(people!.querySelector('[data-attendance-group-member-label]')?.textContent).toContain('Mei Member')
    expect(people!.querySelector('[data-attendance-group-member-secondary]')?.textContent).toContain('mei.member@example.com')

    const assignmentsSection = container!.querySelector<HTMLElement>('#attendance-admin-assignments')
    expect(assignmentsSection).toBeTruthy()
    expect(assignmentsSection!.querySelector('[data-attendance-assignment-user-label]')?.textContent).toContain('Shift Owner')
    expect(assignmentsSection!.querySelector('[data-attendance-assignment-user-secondary]')?.textContent).toContain('shift.owner@example.com')

    const rotationsSection = container!.querySelector<HTMLElement>('#attendance-admin-rotation-assignments')
    expect(rotationsSection).toBeTruthy()
    expect(rotationsSection!.querySelector('[data-attendance-rotation-assignment-user-label]')?.textContent).toContain('Rotation Owner')
    expect(rotationsSection!.querySelector('[data-attendance-rotation-assignment-user-secondary]')?.textContent).toContain('rotation.owner@example.com')
  })

  async function openAttendanceGroupPunchCard(): Promise<HTMLElement> {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')!.click()
    await flushUi(4)
    const card = container!.querySelector<HTMLElement>('[data-attendance-group-summary-card="punch-method"]')
    expect(card).toBeTruthy()
    return card!
  }

  it('surfaces live workspace-level punch policy in the group punch-method card', async () => {
    attendanceSettingsData = {
      ipAllowlist: ['10.0.0.0/8', '192.168.0.0/16'],
      geoFence: { lat: 31.2, lng: 121.5, radiusMeters: 200 },
      minPunchIntervalMinutes: 5,
    }
    const card = await openAttendanceGroupPunchCard()
    // PM2: explicit workspace-level framing; never group-specific
    expect(card.textContent).toContain('applies to all attendance groups')
    expect(card.textContent).not.toContain("this group's punch")
    // PM1: live values rendered per field
    expect(card.querySelector('[data-attendance-group-punch-line="ip"]')?.textContent).toContain('Restricted to 2 address range(s)')
    expect(card.querySelector('[data-attendance-group-punch-line="geofence"]')?.textContent).toContain('Geofence enabled · 200 m radius')
    expect(card.querySelector('[data-attendance-group-punch-line="interval"]')?.textContent).toContain('5 minutes')
    // raw IP ranges are never exposed (count only)
    expect(card.textContent).not.toContain('10.0.0.0/8')
    expect(card.textContent).not.toContain('192.168.0.0/16')
  })

  it('opens a read-only group punch-method drawer without issuing API writes', async () => {
    attendanceSettingsData = {
      ipAllowlist: ['10.0.0.0/8', '192.168.0.0/16'],
      geoFence: { lat: 31.2, lng: 121.5, radiusMeters: 200 },
      minPunchIntervalMinutes: 5,
    }
    const card = await openAttendanceGroupPunchCard()
    const openDrawer = card.querySelector<HTMLButtonElement>('[data-attendance-group-summary-action="open-punch-method-drawer"]')
    expect(openDrawer).toBeTruthy()

    const beforeCalls = vi.mocked(apiFetch).mock.calls.length
    openDrawer!.click()
    await flushUi(2)

    const drawer = container!.querySelector<HTMLElement>('[data-attendance-group-punch-method-drawer]')
    expect(drawer).toBeTruthy()
    expect(drawer!.querySelector('[data-attendance-group-punch-method-scope]')?.textContent).toContain('Workspace-level policy')
    expect(drawer!.querySelector('[data-attendance-group-punch-method-line="ip"]')?.textContent).toContain('Restricted to 2 address range(s)')
    expect(drawer!.querySelector('[data-attendance-group-punch-method-line="geofence"]')?.textContent).toContain('Geofence enabled · 200 m radius')
    expect(drawer!.querySelector('[data-attendance-group-punch-method-line="interval"]')?.textContent).toContain('5 minutes')
    expect(drawer!.querySelector('[data-attendance-group-punch-method-boundary]')?.textContent).toContain('Group-owned controls deferred')
    expect(drawer!.querySelectorAll('input, select, textarea').length).toBe(0)
    expect(drawer!.textContent).not.toContain('10.0.0.0/8')
    expect(drawer!.textContent).not.toContain('192.168.0.0/16')
    expect(vi.mocked(apiFetch).mock.calls.slice(beforeCalls)).toHaveLength(0)

    drawer!.querySelector<HTMLButtonElement>('[data-attendance-group-punch-method-close]')!.click()
    await flushUi(2)
    expect(container!.querySelector('[data-attendance-group-punch-method-drawer]')).toBeNull()
  })

  it('renders default punch policy as unrestricted in the group punch-method card', async () => {
    attendanceSettingsData = null
    const card = await openAttendanceGroupPunchCard()
    // PM3: a successfully-loaded (empty) settings object is a real workspace default
    expect(card.querySelector('[data-attendance-group-punch-line="ip"]')?.textContent).toContain('No IP restriction')
    expect(card.querySelector('[data-attendance-group-punch-line="geofence"]')?.textContent).toContain('No geofence')
    expect(card.querySelector('[data-attendance-group-punch-line="interval"]')?.textContent).toContain('1 minute')
  })

  it('shows a neutral punch policy (not unrestricted) when workspace settings are unavailable', async () => {
    // F1: settings failed/forbidden/not-loaded must NOT be reported as a confident
    // "No IP restriction / No geofence" policy (design §5.1 honesty constraint).
    attendanceSettingsFail = true
    const card = await openAttendanceGroupPunchCard()
    expect(card.textContent).not.toContain('No IP restriction')
    expect(card.textContent).not.toContain('No geofence')
    expect(card.querySelector('[data-attendance-group-punch-line="ip"]')).toBeNull()
    expect(card.querySelector('[data-attendance-group-punch-line="status"]')?.textContent).toContain('Unavailable')
    // workspace-level framing still present; only the values are withheld
    expect(card.textContent).toContain('applies to all attendance groups')
  })

  it('refreshes the punch card after saving workspace settings without a reload (F2)', async () => {
    attendanceSettingsData = {
      ipAllowlist: ['10.0.0.0/8'],
      geoFence: { lat: 1, lng: 2, radiusMeters: 100 },
      minPunchIntervalMinutes: 2,
    }
    const card = await openAttendanceGroupPunchCard()
    // old policy visible
    expect(card.querySelector('[data-attendance-group-punch-line="ip"]')?.textContent).toContain('Restricted to 1 address range(s)')
    expect(card.querySelector('[data-attendance-group-punch-line="geofence"]')?.textContent).toContain('100 m radius')
    expect(card.querySelector('[data-attendance-group-punch-line="interval"]')?.textContent).toContain('2 minutes')

    // save new settings through the only edit path (Settings surface)
    attendanceSettingsSaveData = {
      ipAllowlist: ['10.0.0.0/8', '192.168.0.0/16'],
      geoFence: { lat: 1, lng: 2, radiusMeters: 300 },
      minPunchIntervalMinutes: 7,
    }
    const saveButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Save settings'))
    expect(saveButton).toBeTruthy()
    saveButton!.click()
    await flushUi(4)

    // punch card reflects the saved policy immediately (no admin reload)
    const refreshed = container!.querySelector<HTMLElement>('[data-attendance-group-summary-card="punch-method"]')!
    expect(refreshed.querySelector('[data-attendance-group-punch-line="ip"]')?.textContent).toContain('Restricted to 2 address range(s)')
    expect(refreshed.querySelector('[data-attendance-group-punch-line="geofence"]')?.textContent).toContain('300 m radius')
    expect(refreshed.querySelector('[data-attendance-group-punch-line="interval"]')?.textContent).toContain('7 minutes')
    expect(refreshed.textContent).not.toContain('100 m radius')
  })

  it('loads shiftCompliance into the config card, edits/clears caps, and PUTs only { shiftCompliance }', async () => {
    attendanceSettingsData = {
      shiftCompliance: { enforcement: 'block', dailyMaxMinutes: 480, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
    }
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    // Drain BOTH admin loads — fetchPlugins→loadAdminData and the orgId-watch reload — before reading or
    // editing, so settingsLoading has settled (a late load would otherwise disable the save button and
    // reset the form).
    await flushUi(16)

    // Load: existing shiftCompliance maps into the card (number → string; null → '').
    const daily = container!.querySelector<HTMLInputElement>('[data-shift-compliance="daily"]')
    const weekly = container!.querySelector<HTMLInputElement>('[data-shift-compliance="weekly"]')
    const monthly = container!.querySelector<HTMLInputElement>('[data-shift-compliance="monthly"]')
    const enforcement = container!.querySelector<HTMLSelectElement>('[data-shift-compliance="enforcement"]')
    expect(Boolean(daily && weekly && monthly && enforcement)).toBe(true)
    expect(daily!.value).toBe('480')
    expect(weekly!.value).toBe('')
    expect(monthly!.value).toBe('')
    expect(enforcement!.value).toBe('block')

    // Edit: clear the daily cap (empty = not enforced) and set a weekly cap; leave enforcement = block.
    daily!.value = ''
    daily!.dispatchEvent(new Event('input'))
    weekly!.value = '1200'
    weekly!.dispatchEvent(new Event('input'))
    await flushUi(2)

    // Sanity: the edit survived (no late load reset it) before we save.
    expect(weekly!.value).toBe('1200')
    const saveButton = container!.querySelector<HTMLButtonElement>('[data-shift-compliance="save"]')
    expect(saveButton).toBeTruthy()
    saveButton!.click()
    await flushUi(6)

    // The PUT body must be EXACTLY { shiftCompliance: {...} } — toEqual (not toMatchObject) so any other
    // policy key (autoAbsence / punchPolicy / …) leaking in would fail. Cleared cap -> null; edited -> int.
    const settingsPuts = vi.mocked(apiFetch).mock.calls.filter(([url, init]) =>
      String(url).includes('/api/attendance/settings')
      && String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase() === 'PUT')
    expect(settingsPuts).toHaveLength(1)
    const body = JSON.parse(String((settingsPuts[0][1] as { body?: string } | undefined)?.body || '{}'))
    expect(body).toEqual({
      shiftCompliance: {
        enforcement: 'block',
        dailyMaxMinutes: null,
        weeklyMaxMinutes: 1200,
        monthlyMaxMinutes: null,
      },
    })
  })

  // ② S3-2 外勤打卡审批 (outdoor approval) admin config card.
  const lastSettingsPutBody = (): unknown => {
    const puts = vi.mocked(apiFetch).mock.calls.filter(([url, init]) =>
      String(url).includes('/api/attendance/settings')
      && String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase() === 'PUT')
    expect(puts).toHaveLength(1)
    return JSON.parse(String((puts[0][1] as { body?: string } | undefined)?.body || '{}'))
  }

  const lastAutoShiftPreviewBody = (): unknown => {
    const posts = vi.mocked(apiFetch).mock.calls.filter(([url, init]) =>
      String(url).includes('/api/attendance/auto-shift-matching/preview')
      && String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase() === 'POST')
    expect(posts).toHaveLength(1)
    return JSON.parse(String((posts[0][1] as { body?: string } | undefined)?.body || '{}'))
  }

  it('loads autoShiftMatching into the preview card and PUTs ONLY { autoShiftMatching }', async () => {
    attendanceSettingsData = {
      autoShiftMatching: {
        enabled: true,
        mode: 'preview',
        maxToleranceMinutes: 90,
        minConfidenceToApply: 'medium',
      },
    }
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(16)

    const enabled = container!.querySelector<HTMLInputElement>('[data-auto-shift="enabled"]')
    const tolerance = container!.querySelector<HTMLInputElement>('[data-auto-shift="tolerance"]')
    const confidence = container!.querySelector<HTMLSelectElement>('[data-auto-shift="confidence"]')
    expect(Boolean(enabled && tolerance && confidence)).toBe(true)
    expect(enabled!.checked).toBe(true)
    expect(tolerance!.value).toBe('90')
    expect(confidence!.value).toBe('medium')

    enabled!.checked = false
    enabled!.dispatchEvent(new Event('change'))
    tolerance!.value = '75'
    tolerance!.dispatchEvent(new Event('input'))
    confidence!.value = 'low'
    confidence!.dispatchEvent(new Event('change'))
    await flushUi(2)
    container!.querySelector<HTMLButtonElement>('[data-auto-shift="save-settings"]')!.click()
    await flushUi(6)

    expect(lastSettingsPutBody()).toEqual({
      autoShiftMatching: {
        enabled: false,
        mode: 'preview',
        maxToleranceMinutes: 75,
        minConfidenceToApply: 'low',
      },
    })
  })

  it('posts auto shift preview filters, renders suggestions/skips, and exposes no apply action in A0', async () => {
    attendanceSettingsData = {
      autoShiftMatching: {
        enabled: true,
        mode: 'preview',
        maxToleranceMinutes: 120,
        minConfidenceToApply: 'high',
      },
    }
    attendanceGroupsData = [
      {
        id: 'group-scheduled',
        name: 'Scheduled Ops',
        code: 'scheduled-ops',
        timezone: 'Asia/Shanghai',
        attendanceType: 'scheduled_shift',
        memberCount: 2,
      },
      {
        id: 'group-fixed',
        name: 'Fixed Team',
        code: 'fixed-team',
        timezone: 'Asia/Shanghai',
        attendanceType: 'fixed_shift',
        memberCount: 1,
      },
    ]
    autoShiftPreviewData = {
      items: [
        {
          userId: 'user-1',
          workDate: '2026-06-03',
          candidateShiftId: 'shift-1',
          candidateShiftName: 'Morning Shift',
          confidence: 'high',
          score: 12,
          reasons: ['check_in_delta:5', 'check_out_delta:7'],
          evidence: {
            firstInAt: '2026-06-03T01:05:00.000Z',
            lastOutAt: '2026-06-03T10:07:00.000Z',
            eventIds: ['evt-in', 'evt-out'],
          },
        },
      ],
      skipped: [
        { userId: 'user-2', workDate: '2026-06-03', reason: 'already_scheduled' },
      ],
    }
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(16)

    const from = container!.querySelector<HTMLInputElement>('[data-auto-shift="from"]')!
    const to = container!.querySelector<HTMLInputElement>('[data-auto-shift="to"]')!
    const groups = container!.querySelector<HTMLSelectElement>('[data-auto-shift="groups"]')!
    const tolerance = container!.querySelector<HTMLInputElement>('[data-auto-shift="tolerance"]')!
    const confidence = container!.querySelector<HTMLSelectElement>('[data-auto-shift="confidence"]')!
    expect(Array.from(groups.options).map(option => option.value)).toEqual(['group-scheduled'])
    from.value = '2026-06-03'
    from.dispatchEvent(new Event('input'))
    to.value = '2026-06-03'
    to.dispatchEvent(new Event('input'))
    Array.from(groups.options).forEach((option) => {
      option.selected = option.value === 'group-scheduled'
    })
    groups.dispatchEvent(new Event('change'))
    tolerance.value = '45'
    tolerance.dispatchEvent(new Event('input'))
    confidence.value = 'medium'
    confidence.dispatchEvent(new Event('change'))
    await flushUi(2)

    container!.querySelector<HTMLButtonElement>('[data-auto-shift="preview"]')!.click()
    await flushUi(8)

    expect(lastAutoShiftPreviewBody()).toEqual({
      from: '2026-06-03',
      to: '2026-06-03',
      attendanceGroupIds: ['group-scheduled'],
      userIds: [],
      maxToleranceMinutes: 45,
      minConfidenceToApply: 'medium',
    })
    const suggestions = container!.querySelector<HTMLElement>('[data-auto-shift="suggestions"]')
    const skipped = container!.querySelector<HTMLElement>('[data-auto-shift="skipped"]')
    expect(suggestions?.textContent || '').toContain('Morning Shift')
    expect(suggestions?.textContent || '').toContain('high · 12')
    expect(skipped?.textContent || '').toContain('already_scheduled')
    expect(container!.querySelector('[data-auto-shift="apply"]')).toBeNull()
    expect(
      vi.mocked(apiFetch).mock.calls.some(([url, init]) =>
        String(url).includes('/api/attendance/assignments')
        && ['POST', 'PUT', 'DELETE'].includes(String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase()),
      ),
    ).toBe(false)
  })

  it('shows disabled feedback when the auto shift preview endpoint rejects the A0 gate', async () => {
    autoShiftPreviewStatus = 403
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(16)

    const from = container!.querySelector<HTMLInputElement>('[data-auto-shift="from"]')!
    const to = container!.querySelector<HTMLInputElement>('[data-auto-shift="to"]')!
    const userIds = container!.querySelector<HTMLTextAreaElement>('[data-auto-shift="user-ids"]')!
    from.value = '2026-06-03'
    from.dispatchEvent(new Event('input'))
    to.value = '2026-06-03'
    to.dispatchEvent(new Event('input'))
    userIds.value = 'user-1'
    userIds.dispatchEvent(new Event('input'))
    await flushUi(2)

    container!.querySelector<HTMLButtonElement>('[data-auto-shift="preview"]')!.click()
    await flushUi(8)

    expect(lastAutoShiftPreviewBody()).toEqual({
      from: '2026-06-03',
      to: '2026-06-03',
      attendanceGroupIds: [],
      userIds: ['user-1'],
      maxToleranceMinutes: 120,
      minConfidenceToApply: 'high',
    })
    expect(container!.querySelector('[data-auto-shift="error"]')?.textContent || '').toContain('Auto shift matching preview is disabled')
    expect(container!.querySelector('[data-auto-shift="suggestion-row"]')).toBeNull()
    expect(container!.querySelector('[data-auto-shift="apply"]')).toBeNull()
  })

  it('loads punchPolicy.outdoor into the card and PUTs ONLY { punchPolicy: { outdoor } } (flow id round-trips)', async () => {
    attendanceSettingsData = {
      punchPolicy: { outdoor: { requireApproval: true, requireNote: true, requirePhoto: false, approvalFlowId: 'flow-out-7' } },
    }
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(16)

    const requireApproval = container!.querySelector<HTMLInputElement>('[data-outdoor="require-approval"]')
    const requireNote = container!.querySelector<HTMLInputElement>('[data-outdoor="require-note"]')
    const flow = container!.querySelector<HTMLSelectElement>('[data-outdoor="approval-flow"]')
    expect(Boolean(requireApproval && requireNote && flow)).toBe(true)
    // load: booleans → checkboxes; the saved flow id round-trips via the preserve-option even when it is not
    // in the active-flow list (so a previously-saved flow is never silently reset to '').
    expect(requireApproval!.checked).toBe(true)
    expect(requireNote!.checked).toBe(true)
    expect(flow!.value).toBe('flow-out-7')

    const saveButton = container!.querySelector<HTMLButtonElement>('[data-outdoor="save"]')
    expect(saveButton).toBeTruthy()
    saveButton!.click()
    await flushUi(6)

    // EXACTLY { punchPolicy: { outdoor: { requireApproval, requireNote, approvalFlowId } } }: no requirePhoto,
    // no orgId, no sibling settings. toEqual (not toMatchObject) so any leak fails.
    expect(lastSettingsPutBody()).toEqual({
      punchPolicy: { outdoor: { requireApproval: true, requireNote: true, approvalFlowId: 'flow-out-7' } },
    })
  })

  it('loads punchPolicy.merge into the in/out merge card and PUTs ONLY { punchPolicy: { merge } }', async () => {
    attendanceSettingsData = {
      punchPolicy: { merge: { internalWinsOnIn: true, externalWinsOnOut: true } },
    }
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(16)

    const internalWinsOnIn = container!.querySelector<HTMLInputElement>('[data-merge="internal-wins-on-in"]')
    const externalWinsOnOut = container!.querySelector<HTMLInputElement>('[data-merge="external-wins-on-out"]')
    expect(Boolean(internalWinsOnIn && externalWinsOnOut)).toBe(true)
    // load: persisted booleans → checkboxes (catches a missing applyInOutMergeToForm wire in the load flow).
    expect(internalWinsOnIn!.checked).toBe(true)
    expect(externalWinsOnOut!.checked).toBe(true)

    const saveButton = container!.querySelector<HTMLButtonElement>('[data-merge="save"]')
    expect(saveButton).toBeTruthy()
    saveButton!.click()
    await flushUi(6)

    // EXACTLY { punchPolicy: { merge: { internalWinsOnIn, externalWinsOnOut } } }: no orgId, no sibling
    // settings (outdoor / unscheduled ride the backend per-sub-key preserve). toEqual so any leak fails.
    expect(lastSettingsPutBody()).toEqual({
      punchPolicy: { merge: { internalWinsOnIn: true, externalWinsOnOut: true } },
    })
  })

  it('toggles one merge key from off and PUTs the exact partial body (asymmetric, default-off)', async () => {
    attendanceSettingsData = { punchPolicy: { merge: { internalWinsOnIn: false, externalWinsOnOut: false } } }
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(16)

    const internalWinsOnIn = container!.querySelector<HTMLInputElement>('[data-merge="internal-wins-on-in"]')
    const externalWinsOnOut = container!.querySelector<HTMLInputElement>('[data-merge="external-wins-on-out"]')
    // default off = both unchecked (no regression to existing append behaviour)
    expect(internalWinsOnIn!.checked).toBe(false)
    expect(externalWinsOnOut!.checked).toBe(false)
    internalWinsOnIn!.checked = true
    internalWinsOnIn!.dispatchEvent(new Event('change'))
    await flushUi(2)
    container!.querySelector<HTMLButtonElement>('[data-merge="save"]')!.click()
    await flushUi(6)

    // one key on, one off — the body carries both keys explicitly with the chosen booleans.
    expect(lastSettingsPutBody()).toEqual({
      punchPolicy: { merge: { internalWinsOnIn: true, externalWinsOnOut: false } },
    })
  })

  it('enabling outdoor approval from off PUTs requireApproval/requireNote=true + auto (empty) flow', async () => {
    attendanceSettingsData = { punchPolicy: { outdoor: { requireApproval: false, requireNote: false, approvalFlowId: '' } } }
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(16)

    const requireApproval = container!.querySelector<HTMLInputElement>('[data-outdoor="require-approval"]')
    const requireNote = container!.querySelector<HTMLInputElement>('[data-outdoor="require-note"]')
    expect(requireApproval!.checked).toBe(false)
    requireApproval!.checked = true
    requireApproval!.dispatchEvent(new Event('change'))
    requireNote!.checked = true
    requireNote!.dispatchEvent(new Event('change'))
    await flushUi(2)
    container!.querySelector<HTMLButtonElement>('[data-outdoor="save"]')!.click()
    await flushUi(6)

    expect(lastSettingsPutBody()).toEqual({
      punchPolicy: { outdoor: { requireApproval: true, requireNote: true, approvalFlowId: '' } },
    })
  })

  it('disabling requireApproval PUTs requireApproval=false (default-off, no regression)', async () => {
    attendanceSettingsData = { punchPolicy: { outdoor: { requireApproval: true, requireNote: false, approvalFlowId: '' } } }
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(16)

    const requireApproval = container!.querySelector<HTMLInputElement>('[data-outdoor="require-approval"]')
    expect(requireApproval!.checked).toBe(true)
    requireApproval!.checked = false
    requireApproval!.dispatchEvent(new Event('change'))
    await flushUi(2)
    container!.querySelector<HTMLButtonElement>('[data-outdoor="save"]')!.click()
    await flushUi(6)

    expect(lastSettingsPutBody()).toEqual({
      punchPolicy: { outdoor: { requireApproval: false, requireNote: false, approvalFlowId: '' } },
    })
  })

  it('the approval-flow select lists ONLY active outdoor_punch flows and saves the chosen id', async () => {
    attendanceApprovalFlowsData = [
      { id: 'flow-out-active', name: 'Outdoor Active', requestType: 'outdoor_punch', isActive: true, steps: [] },
      { id: 'flow-out-inactive', name: 'Outdoor Inactive', requestType: 'outdoor_punch', isActive: false, steps: [] },
      { id: 'flow-leave', name: 'Leave Flow', requestType: 'leave', isActive: true, steps: [] },
    ]
    attendanceSettingsData = { punchPolicy: { outdoor: { requireApproval: true, requireNote: false, approvalFlowId: '' } } }
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(16)

    const flow = container!.querySelector<HTMLSelectElement>('[data-outdoor="approval-flow"]')
    expect(flow).toBeTruthy()
    // The select offers '' (auto) + ONLY the active outdoor_punch flow — the inactive outdoor flow and the
    // non-outdoor (leave) flow are filtered out by outdoorApprovalFlowOptions.
    expect(Array.from(flow!.querySelectorAll('option')).map((o) => o.value)).toEqual(['', 'flow-out-active'])

    // Choose the active outdoor flow and save → the chosen id is in the PUT body.
    flow!.value = 'flow-out-active'
    flow!.dispatchEvent(new Event('change'))
    await flushUi(2)
    container!.querySelector<HTMLButtonElement>('[data-outdoor="save"]')!.click()
    await flushUi(6)
    expect(lastSettingsPutBody()).toEqual({
      punchPolicy: { outdoor: { requireApproval: true, requireNote: false, approvalFlowId: 'flow-out-active' } },
    })
  })

  it('keeps the group punch-method card read-only with only an Open drawer action', async () => {
    const card = await openAttendanceGroupPunchCard()
    // PM4: no inputs/toggles/save controls inside the punch card
    expect(card.querySelectorAll('input, select, textarea').length).toBe(0)
    const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons.length).toBe(1)
    expect(buttons[0].textContent?.trim().startsWith('Open')).toBe(true)
    expect(buttons.every(button => button.type !== 'submit')).toBe(true)
    // PM5: T2 capabilities are honest not-available text, never controls
    expect(card.textContent).toContain('not available')
    expect(card.textContent?.toLowerCase()).toContain('wi-fi')
    expect(card.textContent?.toLowerCase()).toContain('face')
  })

  it('does not write punch policy or touch clock events from the group detail', async () => {
    const card = await openAttendanceGroupPunchCard()
    const openDrawer = card.querySelector<HTMLButtonElement>('[data-attendance-group-summary-action="open-punch-method-drawer"]')
    expect(openDrawer).toBeTruthy()
    openDrawer!.click()
    await flushUi(2)

    const drawer = container!.querySelector<HTMLElement>('[data-attendance-group-punch-method-drawer]')
    expect(drawer).toBeTruthy()
    const settingsAction = drawer!.querySelector<HTMLButtonElement>('[data-attendance-group-punch-method-settings-open]')
    expect(settingsAction).toBeTruthy()
    settingsAction!.click()
    await flushUi(2)

    const calls = vi.mocked(apiFetch).mock.calls
    // PM6: no settings write, no punch-policy POST/PUT
    const settingsWrites = calls.filter(([url, init]) =>
      String(url).includes('/api/attendance/settings')
      && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase()))
    expect(settingsWrites).toEqual([])
    // PM9: the punch card / group-detail flow neither punches nor writes events/records.
    // (A baseline GET /api/attendance/records overview load on admin mount is unrelated to this feature.)
    const punchEventCalls = calls.filter(([url]) => String(url).includes('/api/attendance/punch'))
    expect(punchEventCalls).toEqual([])
    const recordWrites = calls.filter(([url, init]) =>
      String(url).includes('/api/attendance/records')
      && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String((init as { method?: string } | undefined)?.method || 'GET').toUpperCase()))
    expect(recordWrites).toEqual([])
    expect(container!.querySelector('[data-attendance-group-punch-method-drawer]')).toBeNull()
  })

  it('navigates from attendance group summary cards without issuing API writes', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const groupsNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsNav).toBeTruthy()
    groupsNav!.click()
    await flushUi(4)

    const summaryGrid = container!.querySelector<HTMLElement>('[data-attendance-group-summaries]')
    expect(summaryGrid).toBeTruthy()
    expect(summaryGrid!.querySelectorAll('[data-attendance-group-summary-action]').length).toBe(9)

    const beforeCalls = vi.mocked(apiFetch).mock.calls.length
    const openWorkTime = summaryGrid!.querySelector<HTMLButtonElement>('[data-attendance-group-summary-action="open-work-time-drawer"]')
    expect(openWorkTime).toBeTruthy()
    openWorkTime!.click()
    await flushUi(2)
    expect(container!.querySelector('[data-attendance-group-work-time-drawer]')).toBeTruthy()
    expect(vi.mocked(apiFetch).mock.calls.slice(beforeCalls)).toHaveLength(0)

    container!.querySelector<HTMLButtonElement>('[data-attendance-group-work-time-close]')!.click()
    await flushUi(2)

    const beforeNavCalls = vi.mocked(apiFetch).mock.calls.length
    const openShifts = summaryGrid!.querySelector<HTMLButtonElement>('[data-attendance-group-summary-action="open-shifts"]')
    expect(openShifts).toBeTruthy()
    openShifts!.click()
    await flushUi(4)

    const newCalls = vi.mocked(apiFetch).mock.calls.slice(beforeNavCalls)
    expect(newCalls).toHaveLength(0)
    expect(window.getComputedStyle(container!.querySelector<HTMLElement>('#attendance-admin-shifts')!).display).not.toBe('none')
    expect(window.getComputedStyle(container!.querySelector<HTMLElement>('#attendance-admin-groups')!).display).toBe('none')
  })

  it('opens the Holidays surface from the fixed-shift work-time drawer without writes', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const groupsNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsNav).toBeTruthy()
    groupsNav!.click()
    await flushUi(4)

    const openWorkTime = container!.querySelector<HTMLButtonElement>('[data-attendance-group-summary-action="open-work-time-drawer"]')
    expect(openWorkTime).toBeTruthy()
    openWorkTime!.click()
    await flushUi(2)

    const drawer = container!.querySelector<HTMLElement>('[data-attendance-group-work-time-drawer]')
    expect(drawer).toBeTruthy()
    expect(drawer!.querySelector('[data-attendance-group-work-time-holidays]')?.textContent).toContain('Holiday calendar')

    const beforeCalls = vi.mocked(apiFetch).mock.calls.length
    const openHolidays = drawer!.querySelector<HTMLButtonElement>('[data-attendance-group-work-time-holidays-open]')
    expect(openHolidays).toBeTruthy()
    openHolidays!.click()
    await flushUi(4)

    expect(vi.mocked(apiFetch).mock.calls.slice(beforeCalls)).toHaveLength(0)
    expect(container!.querySelector('[data-attendance-group-work-time-drawer]')).toBeNull()
    expect(window.getComputedStyle(container!.querySelector<HTMLElement>('#attendance-admin-holidays')!).display).not.toBe('none')
    expect(window.getComputedStyle(container!.querySelector<HTMLElement>('#attendance-admin-groups')!).display).toBe('none')
  })

  it('previews fixed schedule coverage and disables apply when blocking conflicts exist', async () => {
    const previewBodies: unknown[] = []
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/rule-sets')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'rule-set-1', name: 'Ops Rules', scope: 'org', version: 3, isDefault: true },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/groups/group-a/fixed-schedule/preview') && init?.method === 'POST') {
        previewBodies.push(JSON.parse(String(init.body || '{}')))
        return jsonResponse(200, {
          ok: true,
          data: {
            group: {
              id: 'group-a',
              name: 'Ops Team',
              timezone: 'Asia/Shanghai',
            },
            shift: {
              id: 'shift-a',
              name: 'Day shift',
              timezone: 'Asia/Shanghai',
              workStartTime: '09:00',
              workEndTime: '18:00',
              lateGraceMinutes: 10,
              earlyGraceMinutes: 5,
              roundingMinutes: 5,
              workingDays: [1, 2, 3, 4, 5],
            },
            window: { startDate: '2026-06-01', endDate: '2026-06-30' },
            target: { total: 3, userIds: ['user-create', 'user-skip', 'user-conflict'] },
            wouldCreate: [
              { userId: 'user-create', shiftId: 'shift-a', startDate: '2026-06-01', endDate: '2026-06-30', isActive: true },
            ],
            skipped: [
              { assignmentId: 'assignment-skip', userId: 'user-skip', shiftId: 'shift-a', startDate: '2026-06-01', endDate: '2026-06-30' },
            ],
            blockingConflicts: [
              {
                conflictType: 'shift_assignment_overlap',
                draftKind: 'shift',
                existingKind: 'shift',
                assignmentId: 'assignment-conflict',
                userId: 'user-conflict',
                startDate: '2026-06-01',
                endDate: '2026-06-30',
                existingStartDate: '2026-06-10',
                existingEndDate: '2026-06-20',
                message: 'Shift assignment overlaps an active shift assignment for the same user',
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/groups/group-a/members')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'member-1', groupId: 'group-a', userId: 'user-create', createdAt: '2026-03-28T08:00:00.000Z' },
            ],
            total: 3,
          },
        })
      }
      if (url.includes('/api/attendance/groups')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'group-a',
                name: 'Ops Team',
                code: 'ops-team',
                timezone: 'Asia/Shanghai',
                ruleSetId: 'rule-set-1',
                description: 'Operations attendance group',
              },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'shift-a',
                name: 'Day shift',
                timezone: 'Asia/Shanghai',
                workStartTime: '09:00',
                workEndTime: '18:00',
                lateGraceMinutes: 10,
                earlyGraceMinutes: 5,
                roundingMinutes: 5,
                workingDays: [1, 2, 3, 4, 5],
              },
            ],
          },
        })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const groupsNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsNav).toBeTruthy()
    groupsNav!.click()
    await flushUi(4)

    const previewPanel = container!.querySelector<HTMLElement>('[data-attendance-group-fixed-schedule-preview]')
    expect(previewPanel).toBeTruthy()
    const shiftSelect = previewPanel!.querySelector<HTMLSelectElement>('[data-attendance-group-fixed-schedule-shift]')
    expect(shiftSelect).toBeTruthy()
    shiftSelect!.value = 'shift-a'
    shiftSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(previewPanel!, '[data-attendance-group-fixed-schedule-start]', '2026-06-01')
    setInput(previewPanel!, '[data-attendance-group-fixed-schedule-end]', '2026-06-30')
    await flushUi(2)

    const weekMatrix = previewPanel!.querySelector<HTMLElement>('[data-attendance-group-fixed-schedule-week-matrix]')
    expect(weekMatrix).toBeTruthy()
    expect(weekMatrix!.textContent).toContain('Day shift')
    expect(weekMatrix!.textContent).toContain('09:00-18:00')
    expect(weekMatrix!.textContent).toContain('Sun')
    expect(weekMatrix!.textContent).toContain('Rest')

    const previewButton = previewPanel!.querySelector<HTMLButtonElement>('[data-attendance-group-fixed-schedule-preview-submit]')
    expect(previewButton).toBeTruthy()
    previewButton!.click()
    await flushUi(8)

    expect(previewBodies).toEqual([
      {
        shiftId: 'shift-a',
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      },
    ])
    expect(previewPanel!.querySelector('[data-attendance-group-fixed-schedule-preview-summary]')?.textContent).toContain('3 target members')
    expect(previewPanel!.querySelector('[data-attendance-group-fixed-schedule-preview-create]')?.textContent).toContain('1')
    expect(previewPanel!.querySelector('[data-attendance-group-fixed-schedule-preview-skip]')?.textContent).toContain('1')
    expect(previewPanel!.querySelector('[data-attendance-group-fixed-schedule-preview-conflict]')?.textContent).toContain('1')
    expect(previewPanel!.querySelector<HTMLButtonElement>('[data-attendance-group-fixed-schedule-apply-submit]')?.disabled).toBe(true)
    expect(vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
      String(input) === '/api/attendance/assignments' && init?.method === 'POST'
    )).toBe(false)
  })

  it('applies a fixed schedule preview through the group route without posting individual assignments', async () => {
    const previewBodies: unknown[] = []
    const applyBodies: unknown[] = []
    const previewData = {
      group: {
        id: 'group-a',
        name: 'Ops Team',
        timezone: 'Asia/Shanghai',
      },
      shift: {
        id: 'shift-a',
        name: 'Day shift',
        timezone: 'Asia/Shanghai',
        workStartTime: '09:00',
        workEndTime: '18:00',
        lateGraceMinutes: 10,
        earlyGraceMinutes: 5,
        roundingMinutes: 5,
        workingDays: [1, 2, 3, 4, 5],
      },
      window: { startDate: '2026-06-01', endDate: '2026-06-30' },
      target: { total: 2, userIds: ['user-create', 'user-skip'] },
      wouldCreate: [
        { userId: 'user-create', shiftId: 'shift-a', startDate: '2026-06-01', endDate: '2026-06-30', isActive: true },
      ],
      skipped: [
        { assignmentId: 'assignment-skip', userId: 'user-skip', shiftId: 'shift-a', startDate: '2026-06-01', endDate: '2026-06-30' },
      ],
      blockingConflicts: [],
    }
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/rule-sets')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'rule-set-1', name: 'Ops Rules', scope: 'org', version: 3, isDefault: true },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/groups/group-a/fixed-schedule/preview') && init?.method === 'POST') {
        previewBodies.push(JSON.parse(String(init.body || '{}')))
        return jsonResponse(200, { ok: true, data: previewData })
      }
      if (url.includes('/api/attendance/groups/group-a/fixed-schedule/apply') && init?.method === 'POST') {
        applyBodies.push(JSON.parse(String(init.body || '{}')))
        return jsonResponse(201, {
          ok: true,
          data: {
            ...previewData,
            applied: true,
            created: [
              { id: 'assignment-created', userId: 'user-create', shiftId: 'shift-a', startDate: '2026-06-01', endDate: '2026-06-30', isActive: true },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/groups/group-a/members')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'member-1', groupId: 'group-a', userId: 'user-create', createdAt: '2026-03-28T08:00:00.000Z' },
            ],
            total: 2,
          },
        })
      }
      if (url.includes('/api/attendance/groups')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'group-a',
                name: 'Ops Team',
                code: 'ops-team',
                timezone: 'Asia/Shanghai',
                ruleSetId: 'rule-set-1',
                description: 'Operations attendance group',
              },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'shift-a',
                name: 'Day shift',
                timezone: 'Asia/Shanghai',
                workStartTime: '09:00',
                workEndTime: '18:00',
                lateGraceMinutes: 10,
                earlyGraceMinutes: 5,
                roundingMinutes: 5,
                workingDays: [1, 2, 3, 4, 5],
              },
            ],
          },
        })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const groupsNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsNav).toBeTruthy()
    groupsNav!.click()
    await flushUi(4)

    const previewPanel = container!.querySelector<HTMLElement>('[data-attendance-group-fixed-schedule-preview]')
    expect(previewPanel).toBeTruthy()
    const shiftSelect = previewPanel!.querySelector<HTMLSelectElement>('[data-attendance-group-fixed-schedule-shift]')
    expect(shiftSelect).toBeTruthy()
    shiftSelect!.value = 'shift-a'
    shiftSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(previewPanel!, '[data-attendance-group-fixed-schedule-start]', '2026-06-01')
    setInput(previewPanel!, '[data-attendance-group-fixed-schedule-end]', '2026-06-30')
    await flushUi(2)

    previewPanel!.querySelector<HTMLButtonElement>('[data-attendance-group-fixed-schedule-preview-submit]')!.click()
    await flushUi(8)
    const applyButton = previewPanel!.querySelector<HTMLButtonElement>('[data-attendance-group-fixed-schedule-apply-submit]')
    expect(applyButton).toBeTruthy()
    expect(applyButton!.disabled).toBe(false)
    applyButton!.click()
    await flushUi(8)

    const expectedBody = {
      shiftId: 'shift-a',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    }
    expect(previewBodies).toEqual([expectedBody])
    expect(applyBodies).toEqual([expectedBody])
    expect(previewPanel!.querySelector('[data-attendance-group-fixed-schedule-apply-created]')?.textContent).toContain('1')
    expect(applyButton!.disabled).toBe(true)
    applyButton!.click()
    await flushUi(2)
    expect(applyBodies).toEqual([expectedBody])
    expect(vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
      String(input) === '/api/attendance/assignments' && init?.method === 'POST'
    )).toBe(false)
  })

  it('rebuilds and clears managed fixed schedule rows through group routes', async () => {
    const rebuildBodies: unknown[] = []
    const clearBodies: unknown[] = []
    const confirmSpy = vi.spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const rebuiltData = {
      group: { id: 'group-a', name: 'Ops Team', timezone: 'Asia/Shanghai' },
      shift: {
        id: 'shift-a',
        name: 'Day shift',
        timezone: 'Asia/Shanghai',
        workStartTime: '09:00',
        workEndTime: '18:00',
        lateGraceMinutes: 10,
        earlyGraceMinutes: 5,
        roundingMinutes: 5,
        workingDays: [1, 2, 3, 4, 5],
      },
      window: { startDate: '2026-06-01', endDate: '2026-06-30' },
      target: { total: 2, userIds: ['user-create', 'user-stale'] },
      wouldCreate: [
        { userId: 'user-create', shiftId: 'shift-a', startDate: '2026-06-01', endDate: '2026-06-30', isActive: true },
      ],
      skipped: [],
      skippedManaged: [],
      skippedUnmanaged: [],
      skippedExternalManaged: [],
      blockingConflicts: [],
      rebuilt: true,
      created: [
        { id: 'assignment-created', userId: 'user-create', shiftId: 'shift-a', startDate: '2026-06-01', endDate: '2026-06-30', isActive: true },
      ],
      deactivated: [
        { id: 'assignment-stale', userId: 'user-stale', shiftId: 'shift-a', startDate: '2026-06-01', endDate: '2026-06-30', isActive: false },
      ],
    }

    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/rule-sets')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'rule-set-1', name: 'Ops Rules', scope: 'org', version: 3, isDefault: true },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/groups/group-a/fixed-schedule/rebuild') && init?.method === 'POST') {
        rebuildBodies.push(JSON.parse(String(init.body || '{}')))
        return jsonResponse(200, { ok: true, data: rebuiltData })
      }
      if (url.includes('/api/attendance/groups/group-a/fixed-schedule/clear') && init?.method === 'POST') {
        clearBodies.push(JSON.parse(String(init.body || '{}')))
        return jsonResponse(200, {
          ok: true,
          data: {
            producer: {
              type: 'attendance_group_fixed_schedule',
              refId: 'group-a',
              key: 'attendance_group_fixed_schedule:group-a:shift-a:2026-06-01:2026-06-30',
            },
            deactivated: [
              { id: 'assignment-created', userId: 'user-create', shiftId: 'shift-a', startDate: '2026-06-01', endDate: '2026-06-30', isActive: false },
              { id: 'assignment-stale', userId: 'user-stale', shiftId: 'shift-a', startDate: '2026-06-01', endDate: '2026-06-30', isActive: false },
            ],
            cleared: true,
          },
        })
      }
      if (url.includes('/api/attendance/groups/group-a/members')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'member-1', groupId: 'group-a', userId: 'user-create', createdAt: '2026-03-28T08:00:00.000Z' },
            ],
            total: 2,
          },
        })
      }
      if (url.includes('/api/attendance/groups')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'group-a',
                name: 'Ops Team',
                code: 'ops-team',
                timezone: 'Asia/Shanghai',
                ruleSetId: 'rule-set-1',
                description: 'Operations attendance group',
              },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'shift-a',
                name: 'Day shift',
                timezone: 'Asia/Shanghai',
                workStartTime: '09:00',
                workEndTime: '18:00',
                lateGraceMinutes: 10,
                earlyGraceMinutes: 5,
                roundingMinutes: 5,
                workingDays: [1, 2, 3, 4, 5],
              },
            ],
          },
        })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')!.click()
    await flushUi(4)

    const previewPanel = container!.querySelector<HTMLElement>('[data-attendance-group-fixed-schedule-preview]')
    expect(previewPanel).toBeTruthy()
    const shiftSelect = previewPanel!.querySelector<HTMLSelectElement>('[data-attendance-group-fixed-schedule-shift]')
    expect(shiftSelect).toBeTruthy()
    shiftSelect!.value = 'shift-a'
    shiftSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(previewPanel!, '[data-attendance-group-fixed-schedule-start]', '2026-06-01')
    setInput(previewPanel!, '[data-attendance-group-fixed-schedule-end]', '2026-06-30')
    await flushUi(2)

    const expectedBody = {
      shiftId: 'shift-a',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    }
    const rebuildButton = previewPanel!.querySelector<HTMLButtonElement>('[data-attendance-group-fixed-schedule-rebuild-submit]')
    const clearButton = previewPanel!.querySelector<HTMLButtonElement>('[data-attendance-group-fixed-schedule-clear-submit]')
    expect(rebuildButton).toBeTruthy()
    expect(clearButton).toBeTruthy()
    expect(rebuildButton!.disabled).toBe(false)
    expect(clearButton!.disabled).toBe(false)

    try {
      rebuildButton!.click()
      await flushUi(8)

      expect(rebuildBodies).toEqual([expectedBody])
      expect(previewPanel!.querySelector('[data-attendance-group-fixed-schedule-rebuild-created]')?.textContent).toContain('1')
      expect(previewPanel!.querySelector('[data-attendance-group-fixed-schedule-deactivated]')?.textContent).toContain('1')

      clearButton!.click()
      await flushUi(2)
      expect(confirmSpy).toHaveBeenCalledTimes(1)
      expect(clearBodies).toEqual([])

      clearButton!.click()
      await flushUi(8)

      expect(clearBodies).toEqual([expectedBody])
      expect(previewPanel!.querySelector('[data-attendance-group-fixed-schedule-preview-result]')).toBeNull()
      expect(container!.textContent).toContain('Cleared 2 managed fixed schedule rows.')
      expect(vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
        String(input) === '/api/attendance/assignments' && init?.method === 'POST'
      )).toBe(false)
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('shows a clear-first hint when a managed fixed schedule blocks the selected window', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/rule-sets')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'rule-set-1', name: 'Ops Rules', scope: 'org', version: 3, isDefault: true },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/groups/group-a/fixed-schedule/preview') && init?.method === 'POST') {
        return jsonResponse(200, {
          ok: true,
          data: {
            group: { id: 'group-a', name: 'Ops Team', timezone: 'Asia/Shanghai' },
            shift: {
              id: 'shift-a',
              name: 'Day shift',
              timezone: 'Asia/Shanghai',
              workStartTime: '09:00',
              workEndTime: '18:00',
              lateGraceMinutes: 10,
              earlyGraceMinutes: 5,
              roundingMinutes: 5,
              workingDays: [1, 2, 3, 4, 5],
            },
            window: { startDate: '2026-06-01', endDate: '2026-06-30' },
            target: { total: 1, userIds: ['user-a'] },
            wouldCreate: [],
            skipped: [],
            blockingConflicts: [
              {
                conflictType: 'shift_assignment_overlap',
                draftKind: 'shift',
                existingKind: 'shift',
                assignmentId: 'assignment-managed-old-window',
                userId: 'user-a',
                startDate: '2026-06-01',
                endDate: '2026-06-30',
                existingStartDate: '2026-05-15',
                existingEndDate: '2026-06-15',
                managedScheduleAction: 'clear_existing_managed_schedule_first',
                message: 'Shift assignment overlaps an active shift assignment for the same user',
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/groups/group-a/members')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'member-1', groupId: 'group-a', userId: 'user-a', createdAt: '2026-03-28T08:00:00.000Z' },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/groups')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'group-a',
                name: 'Ops Team',
                code: 'ops-team',
                timezone: 'Asia/Shanghai',
                ruleSetId: 'rule-set-1',
                description: 'Operations attendance group',
              },
            ],
            total: 1,
          },
        })
      }
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'shift-a',
                name: 'Day shift',
                timezone: 'Asia/Shanghai',
                workStartTime: '09:00',
                workEndTime: '18:00',
                lateGraceMinutes: 10,
                earlyGraceMinutes: 5,
                roundingMinutes: 5,
                workingDays: [1, 2, 3, 4, 5],
              },
            ],
          },
        })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')!.click()
    await flushUi(4)

    const previewPanel = container!.querySelector<HTMLElement>('[data-attendance-group-fixed-schedule-preview]')
    expect(previewPanel).toBeTruthy()
    const shiftSelect = previewPanel!.querySelector<HTMLSelectElement>('[data-attendance-group-fixed-schedule-shift]')
    expect(shiftSelect).toBeTruthy()
    shiftSelect!.value = 'shift-a'
    shiftSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(previewPanel!, '[data-attendance-group-fixed-schedule-start]', '2026-06-01')
    setInput(previewPanel!, '[data-attendance-group-fixed-schedule-end]', '2026-06-30')
    await flushUi(2)

    previewPanel!.querySelector<HTMLButtonElement>('[data-attendance-group-fixed-schedule-preview-submit]')!.click()
    await flushUi(8)

    expect(previewPanel!.querySelector('[data-attendance-group-fixed-schedule-clear-first-hint]')?.textContent).toContain('Clear the existing managed rows first')
    expect(previewPanel!.querySelector<HTMLButtonElement>('[data-attendance-group-fixed-schedule-apply-submit]')?.disabled).toBe(true)
  })

  it('renders the production calendar-policy quick-add panel and appends a group day-index row', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const settings = container!.querySelector<HTMLElement>('#attendance-admin-settings')
    expect(settings).toBeTruthy()
    expect(window.getComputedStyle(settings!).display).not.toBe('none')
    expect(settings!.querySelector('[data-attendance-calendar-policy-quick-add]')).toBeTruthy()

    setInput(settings!, '[data-calendar-policy-quick-holiday]', 'National Day')
    setInput(settings!, '[data-calendar-policy-quick-group]', 'day-shift')
    await flushUi(2)

    const quickAddButton = settings!.querySelector<HTMLButtonElement>('button[data-calendar-policy-quick-add]')
    expect(quickAddButton).toBeTruthy()
    expect(quickAddButton!.disabled).toBe(false)
    quickAddButton!.click()
    await flushUi(4)

    expect(settings!.textContent).toContain('Will add a group workday exception for holiday day 4-5.')
    const policyRows = settings!.querySelectorAll('template, tbody tr')
    expect(policyRows.length).toBeGreaterThan(0)
    const groupInputs = Array.from(settings!.querySelectorAll<HTMLInputElement>('[data-calendar-policy-override-attendance-groups]'))
    expect(groupInputs.some(input => input.value === 'day-shift')).toBe(true)
    const dayIndexStartInputs = Array.from(settings!.querySelectorAll<HTMLInputElement>('[data-calendar-policy-override-day-index-start]'))
    const dayIndexEndInputs = Array.from(settings!.querySelectorAll<HTMLInputElement>('[data-calendar-policy-override-day-index-end]'))
    expect(dayIndexStartInputs.some(input => input.value === '4')).toBe(true)
    expect(dayIndexEndInputs.some(input => input.value === '5')).toBe(true)
  })

  it('renders the production quick-add panel and appends a longer-rest date range row', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const settings = container!.querySelector<HTMLElement>('#attendance-admin-settings')
    expect(settings).toBeTruthy()
    expect(window.getComputedStyle(settings!).display).not.toBe('none')
    expect(settings!.querySelector('[data-attendance-calendar-policy-quick-add]')).toBeTruthy()

    setInput(settings!, '[data-calendar-policy-quick-holiday]', 'National Day')
    setInput(settings!, '[data-calendar-policy-quick-group]', 'long-rest-shift')
    setInput(settings!, '[data-calendar-policy-quick-base-days]', '3')
    setInput(settings!, '[data-calendar-policy-quick-target-days]', '5')
    setInput(settings!, '[data-calendar-policy-quick-base-start-date]', '2026-10-01')
    await flushUi(2)

    const quickAddButton = settings!.querySelector<HTMLButtonElement>('button[data-calendar-policy-quick-add]')
    expect(quickAddButton).toBeTruthy()
    expect(quickAddButton!.disabled).toBe(false)
    quickAddButton!.click()
    await flushUi(4)

    expect(settings!.textContent).toContain('Will add a group rest exception from 2026-10-04 to 2026-10-05.')
    const groupInputs = Array.from(settings!.querySelectorAll<HTMLInputElement>('[data-calendar-policy-override-attendance-groups]'))
    expect(groupInputs.some(input => input.value === 'long-rest-shift')).toBe(true)
    const fromInputs = Array.from(settings!.querySelectorAll<HTMLInputElement>('[data-calendar-policy-override-from]'))
    const toInputs = Array.from(settings!.querySelectorAll<HTMLInputElement>('[data-calendar-policy-override-to]'))
    expect(fromInputs.some(input => input.value === '2026-10-04')).toBe(true)
    expect(toInputs.some(input => input.value === '2026-10-05')).toBe(true)
    const dayIndexStartInputs = Array.from(settings!.querySelectorAll<HTMLInputElement>('[data-calendar-policy-override-day-index-start]'))
    const dayIndexEndInputs = Array.from(settings!.querySelectorAll<HTMLInputElement>('[data-calendar-policy-override-day-index-end]'))
    expect(dayIndexStartInputs.some(input => input.value === '4')).toBe(false)
    expect(dayIndexEndInputs.some(input => input.value === '5')).toBe(false)
  })

  it('passes the selected CSV header mode when exporting report records', async () => {
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn(() => 'blob:attendance-export')
    const revokeObjectURL = vi.fn()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    try {
      app = createApp(AttendanceView, { mode: 'reports' })
      app.mount(container!)
      await flushUi()

      const headerSelect = container!.querySelector<HTMLSelectElement>('#attendance-record-export-header')
      expect(headerSelect).toBeTruthy()
      expect(headerSelect!.value).toBe('label')
      headerSelect!.value = 'code'
      headerSelect!.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi(2)
      expect(headerSelect!.value).toBe('code')

      const exportButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
        .find(button => button.textContent?.includes('Export CSV'))
      expect(exportButton).toBeTruthy()
      exportButton!.click()
      await flushUi(6)

      const exportCall = vi.mocked(apiFetch).mock.calls
        .map(call => String(call[0]))
        .find(url => url.includes('/api/attendance/export?'))
      expect(exportCall).toContain('header=code')
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(clickSpy).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:attendance-export')
      expect(container!.querySelector('[data-record-export-config]')?.textContent).toContain('Last CSV export')
      expect(container!.querySelector('[data-record-export-config-detail="headerMode"]')?.textContent).toContain('Field codes')
      expect(container!.querySelector('[data-record-export-config-detail="evidenceStatus"]')?.textContent).toContain('Complete')
      expect(container!.querySelector('[data-record-export-config-detail="evidenceStatus"]')?.classList.contains('attendance__report-config-item--ok')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="range"]')?.textContent).toContain(' - ')
      expect(container!.querySelector('[data-record-export-config-detail="rangeMatch"]')?.textContent).toContain('Current range')
      expect(container!.querySelector('[data-record-export-config-detail="rangeMatch"]')?.classList.contains('attendance__report-config-item--ok')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="fieldCount"]')?.textContent).toContain('2')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCountMatch"]')?.textContent).toContain('Matches records')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCountMatch"]')?.classList.contains('attendance__report-config-item--ok')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="configMatch"]')?.textContent).toContain('Matches records')
      expect(container!.querySelector('[data-record-export-config-detail="configMatch"]')?.classList.contains('attendance__report-config-item--ok')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="fieldCodesMatch"]')?.textContent).toContain('Matches records')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCodesMatch"]')?.classList.contains('attendance__report-config-item--ok')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="backingMatch"]')?.textContent).toContain('Matches records')
      expect(container!.querySelector('[data-record-export-config-detail="backingMatch"]')?.classList.contains('attendance__report-config-item--ok')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="projectId"]')?.textContent).toContain('default:attendance')
      expect(container!.querySelector('[data-record-export-config-detail="objectId"]')?.textContent).toContain('attendance_report_field_catalog')
      expect(container!.querySelector('[data-record-export-config-detail="sheetId"]')?.textContent).toContain('sheet-1')
      expect(container!.querySelector('[data-record-export-config-detail="viewId"]')?.textContent).toContain('fields_by_category')
      expect(container!.querySelector('[data-record-export-config-detail="fingerprintAlgorithm"]')?.textContent).toContain('sha1')
      expect(container!.querySelector('[data-record-export-config-detail="fingerprint"]')?.textContent).toContain('records-unit-test-fingerprint')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCodes"]')?.textContent).toContain('work_date, employee_name')
      expect(container!.querySelector('[data-record-export-config-detail="filename"]')?.textContent).toContain('attendance-export.csv')

      const fromInput = container!.querySelector<HTMLInputElement>('#attendance-from-date')
      expect(fromInput).toBeTruthy()
      fromInput!.value = '2026-01-01'
      fromInput!.dispatchEvent(new Event('input', { bubbles: true }))
      fromInput!.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi(2)
      expect(container!.querySelector('[data-record-export-config-detail="rangeMatch"]')?.textContent).toContain('Different range')
      expect(container!.querySelector('[data-record-export-config-detail="rangeMatch"]')?.classList.contains('attendance__report-config-item--warn')).toBe(true)
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
  })

  it('warns when the CSV export field config differs from the loaded records', async () => {
    exportReportFieldFingerprint = 'csv-mismatch-fingerprint'
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn(() => 'blob:attendance-export')
    const revokeObjectURL = vi.fn()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    try {
      app = createApp(AttendanceView, { mode: 'reports' })
      app.mount(container!)
      await flushUi()

      const exportButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
        .find(button => button.textContent?.includes('Export CSV'))
      expect(exportButton).toBeTruthy()
      exportButton!.click()
      await flushUi(6)

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(clickSpy).toHaveBeenCalledTimes(1)
      expect(container!.querySelector('[data-record-export-config-detail="configMatch"]')?.textContent).toContain('Differs from records')
      expect(container!.querySelector('[data-record-export-config-detail="configMatch"]')?.classList.contains('attendance__report-config-item--warn')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="fieldCountMatch"]')?.textContent).toContain('Matches records')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCountMatch"]')?.classList.contains('attendance__report-config-item--ok')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="fieldCodesMatch"]')?.textContent).toContain('Matches records')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCodesMatch"]')?.classList.contains('attendance__report-config-item--ok')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="fingerprint"]')?.textContent).toContain('csv-mismatch-fingerprint')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCodes"]')?.textContent).toContain('work_date, employee_name')
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
  })

  it('warns when the CSV export field codes differ from the loaded records', async () => {
    exportReportFieldCodes = 'employee_name,work_date'
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn(() => 'blob:attendance-export')
    const revokeObjectURL = vi.fn()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    try {
      app = createApp(AttendanceView, { mode: 'reports' })
      app.mount(container!)
      await flushUi()

      const exportButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
        .find(button => button.textContent?.includes('Export CSV'))
      expect(exportButton).toBeTruthy()
      exportButton!.click()
      await flushUi(6)

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(clickSpy).toHaveBeenCalledTimes(1)
      expect(container!.querySelector('[data-record-export-config-detail="configMatch"]')?.textContent).toContain('Matches records')
      expect(container!.querySelector('[data-record-export-config-detail="configMatch"]')?.classList.contains('attendance__report-config-item--ok')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="fieldCountMatch"]')?.textContent).toContain('Matches records')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCountMatch"]')?.classList.contains('attendance__report-config-item--ok')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="fieldCodesMatch"]')?.textContent).toContain('Differs from records')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCodesMatch"]')?.classList.contains('attendance__report-config-item--warn')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="fieldCodes"]')?.textContent).toContain('employee_name, work_date')
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
  })

  it('warns when the CSV export field count differs from the loaded records', async () => {
    exportReportFieldCount = '3'
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn(() => 'blob:attendance-export')
    const revokeObjectURL = vi.fn()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    try {
      app = createApp(AttendanceView, { mode: 'reports' })
      app.mount(container!)
      await flushUi()

      const exportButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
        .find(button => button.textContent?.includes('Export CSV'))
      expect(exportButton).toBeTruthy()
      exportButton!.click()
      await flushUi(6)

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(clickSpy).toHaveBeenCalledTimes(1)
      expect(container!.querySelector('[data-record-export-config-detail="fieldCount"]')?.textContent).toContain('3')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCountMatch"]')?.textContent).toContain('Differs from records')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCountMatch"]')?.classList.contains('attendance__report-config-item--warn')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="configMatch"]')?.textContent).toContain('Matches records')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCodesMatch"]')?.textContent).toContain('Matches records')
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
  })

  it('warns when the CSV export backing differs from the loaded records', async () => {
    exportReportFieldSheetId = 'sheet-from-other-catalog'
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn(() => 'blob:attendance-export')
    const revokeObjectURL = vi.fn()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    try {
      app = createApp(AttendanceView, { mode: 'reports' })
      app.mount(container!)
      await flushUi()

      const exportButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
        .find(button => button.textContent?.includes('Export CSV'))
      expect(exportButton).toBeTruthy()
      exportButton!.click()
      await flushUi(6)

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(clickSpy).toHaveBeenCalledTimes(1)
      expect(container!.querySelector('[data-record-export-config-detail="configMatch"]')?.textContent).toContain('Matches records')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCountMatch"]')?.textContent).toContain('Matches records')
      expect(container!.querySelector('[data-record-export-config-detail="fieldCodesMatch"]')?.textContent).toContain('Matches records')
      expect(container!.querySelector('[data-record-export-config-detail="backingMatch"]')?.textContent).toContain('Differs from records')
      expect(container!.querySelector('[data-record-export-config-detail="backingMatch"]')?.classList.contains('attendance__report-config-item--warn')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="sheetId"]')?.textContent).toContain('sheet-from-other-catalog')
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
  })

  it('warns when CSV export field evidence headers are incomplete', async () => {
    exportReportFieldFingerprint = ''
    exportReportFieldCount = ''
    exportReportFieldCodes = ''
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn(() => 'blob:attendance-export')
    const revokeObjectURL = vi.fn()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    try {
      app = createApp(AttendanceView, { mode: 'reports' })
      app.mount(container!)
      await flushUi()

      const exportButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
        .find(button => button.textContent?.includes('Export CSV'))
      expect(exportButton).toBeTruthy()
      exportButton!.click()
      await flushUi(6)

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(clickSpy).toHaveBeenCalledTimes(1)
      expect(container!.querySelector('[data-record-export-config-detail="evidenceStatus"]')?.textContent).toContain('Missing: field count, fingerprint, field codes')
      expect(container!.querySelector('[data-record-export-config-detail="evidenceStatus"]')?.classList.contains('attendance__report-config-item--warn')).toBe(true)
      expect(container!.querySelector('[data-record-export-config-detail="fieldCount"]')).toBeNull()
      expect(container!.querySelector('[data-record-export-config-detail="fieldCountMatch"]')).toBeNull()
      expect(container!.querySelector('[data-record-export-config-detail="configMatch"]')).toBeNull()
      expect(container!.querySelector('[data-record-export-config-detail="fieldCodesMatch"]')).toBeNull()
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
  })

  it('shows the active record report field config fingerprint', async () => {
    app = createApp(AttendanceView, { mode: 'reports' })
    app.mount(container!)
    await flushUi()

    expect(container!.querySelector('[data-record-report-config]')?.textContent).toContain('Field config')
    expect(container!.querySelector('[data-record-report-config-detail="backing"]')?.textContent).toContain('Connected')
    expect(container!.querySelector('[data-record-report-config-detail="fieldCount"]')?.textContent).toContain('2')
    expect(container!.querySelector('[data-record-report-config-detail="fingerprintAlgorithm"]')?.textContent).toContain('sha1')
    expect(container!.querySelector('[data-record-report-config-detail="fingerprint"]')?.textContent).toContain('records-unit-test-fingerprint')
    expect(container!.querySelector('[data-record-report-config-detail="fieldCodes"]')?.textContent).toContain('work_date, employee_name')
    expect(container!.querySelector('[data-record-report-config-detail="projectId"]')?.textContent).toContain('default:attendance')
  })

  it('keeps edit buttons visible for the active section while focused mode hides inactive sections', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const ruleSetNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-rule-sets"]')
    const leaveTypeSection = container!.querySelector<HTMLElement>('#attendance-admin-leave-types')
    expect(ruleSetNav).toBeTruthy()
    expect(leaveTypeSection).toBeTruthy()

    ruleSetNav!.click()
    await flushUi(2)

    const ruleSetSection = container!.querySelector<HTMLElement>('#attendance-admin-rule-sets')
    const visibleEditButton = Array.from(ruleSetSection!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Edit'))
    expect(ruleSetSection).toBeTruthy()
    expect(window.getComputedStyle(ruleSetSection!).display).not.toBe('none')
    expect(visibleEditButton).toBeTruthy()
    expect(container!.querySelector('[data-admin-focus-toggle="true"]')).toBeNull()
    expect(window.getComputedStyle(leaveTypeSection!).display).toBe('none')
    const actionCell = visibleEditButton?.closest('td')
    expect(actionCell).toBeTruthy()
    expect(actionCell?.classList.contains('attendance__table-actions')).toBe(true)
    expect(window.getComputedStyle(actionCell!).display).toBe('table-cell')
  })

  it('renders the read-only advanced scheduling workbench without write controls', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const workbenchNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-advanced-scheduling-workbench"]')
    expect(workbenchNav).toBeTruthy()
    workbenchNav!.click()
    await flushUi(2)

    const section = container!.querySelector<HTMLElement>('[data-attendance-advanced-scheduling-workbench]')
    expect(section).toBeTruthy()
    expect(window.getComputedStyle(section!).display).not.toBe('none')
    expect(section!.textContent).toContain('Read-only snapshot')
    expect(section!.querySelector('[data-attendance-advanced-scheduling-truncation]')?.textContent).toContain('Shift assignment detail rows are capped at 500')
    expect(section!.querySelector('[data-attendance-advanced-scheduling-truncation]')?.textContent).toContain('top metrics use full aggregate counts')
    expect(section!.querySelector('[data-attendance-advanced-scheduling-metric="schedule-groups"]')?.textContent).toContain('1')
    expect(section!.querySelector('[data-attendance-advanced-scheduling-metric="assignments"]')?.textContent).toContain('10')
    expect(section!.querySelector('[data-attendance-advanced-scheduling-diagnostic="assignment_without_schedule_group"]')?.textContent).toContain('1')
    expect(section!.querySelector('[data-attendance-advanced-scheduling-groups]')?.textContent).toContain('Line A')
    const buttons = Array.from(section!.querySelectorAll<HTMLButtonElement>('button')).map(button => button.textContent || '')
    expect(buttons.join(' ')).toContain('Reload workbench')
    expect(buttons.join(' ')).not.toContain('Create')
    expect(buttons.join(' ')).not.toContain('Edit')
    expect(buttons.join(' ')).not.toContain('Delete')
  })

  it('runs the read-only comprehensive hours preview without write controls', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const previewNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-comprehensive-hours-preview"]')
    expect(previewNav).toBeTruthy()
    previewNav!.click()
    await flushUi(2)

    const section = container!.querySelector<HTMLElement>('[data-attendance-comprehensive-hours-preview]')
    expect(section).toBeTruthy()
    expect(window.getComputedStyle(section!).display).not.toBe('none')

    const userInput = section!.querySelector<HTMLInputElement>('[data-attendance-comprehensive-hours-user-id]')
    expect(userInput).toBeTruthy()
    userInput!.value = 'user-1'
    userInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const runButton = section!.querySelector<HTMLButtonElement>('[data-attendance-comprehensive-hours-preview-run]')
    expect(runButton).toBeTruthy()
    expect(runButton!.disabled).toBe(false)
    runButton!.click()
    await flushUi(4)

    const previewCall = vi.mocked(apiFetch).mock.calls.find(([input]) =>
      String(input).includes('/api/attendance/comprehensive-hours/preview')
    )
    expect(previewCall).toBeTruthy()
    const requestBody = JSON.parse(String((previewCall![1] as RequestInit).body))
    expect(requestBody).toMatchObject({
      policyDraft: { capHours: 160, enforcement: 'warn' },
      scope: { userId: 'user-1' },
      period: { type: 'month' },
      metric: 'planned',
    })

    expect(section!.textContent).toContain('Read-only preview')
    expect(section!.querySelector('[data-attendance-comprehensive-hours-status]')?.textContent).toContain('No policy was saved')
    expect(section!.querySelector('[data-attendance-comprehensive-hours-aggregate-item="violation"]')?.textContent).toContain('1')
    expect(section!.querySelector('[data-attendance-comprehensive-hours-rows]')?.textContent).toContain('user-1')
    expect(section!.querySelector('[data-attendance-comprehensive-hours-rows]')?.textContent).toContain('Violation')

    const buttons = Array.from(section!.querySelectorAll<HTMLButtonElement>('button')).map(button => button.textContent || '')
    expect(buttons.join(' ')).toContain('Preview comprehensive hours')
    expect(buttons.join(' ')).not.toContain('Save')
    expect(buttons.join(' ')).not.toContain('Apply')
    expect(buttons.join(' ')).not.toContain('Enforce')
    expect(buttons.join(' ')).not.toContain('Create')
    expect(buttons.join(' ')).not.toContain('Edit')
    expect(buttons.join(' ')).not.toContain('Delete')
  })

  it('runs a weak comprehensive-hours advisory before saving shift assignments without blocking save', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'shift-a',
                name: 'Day shift',
                timezone: 'UTC',
                workStartTime: '09:00',
                workEndTime: '18:00',
                isOvernight: false,
                lateGraceMinutes: 10,
                earlyGraceMinutes: 10,
                roundingMinutes: 5,
                workingDays: [1, 2, 3, 4, 5],
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/comprehensive-hours/preview')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            readOnly: true,
            period: { type: 'custom_range', from: '2026-05-01', to: '2026-05-10' },
            metric: 'planned',
            enforcement: 'warn',
            capMinutes: 9600,
            scope: { userIds: ['user-9'] },
            aggregate: {
              users: 1,
              ok: 0,
              warning: 0,
              violation: 1,
              totalMinutes: 10200,
              totalExcessMinutes: 600,
              totalRemainingMinutes: 0,
              status: 'violation',
            },
            rows: [
              {
                userId: 'user-9',
                minutes: 10200,
                plannedMinutes: 10200,
                capMinutes: 9600,
                remainingMinutes: 0,
                excessMinutes: 600,
                status: 'violation',
                source: 'effective_calendar',
              },
            ],
            degraded: false,
          },
        })
      }
      if (url === '/api/attendance/assignments' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const assignmentsNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-assignments"]')
    expect(assignmentsNav).toBeTruthy()
    assignmentsNav!.click()
    await flushUi(2)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-assignments')
    expect(section).toBeTruthy()
    selectUserPicker(section!, '#attendance-assignment-user-id', 'user-9')
    const shiftSelect = section!.querySelector<HTMLSelectElement>('#attendance-assignment-shift-id')
    expect(shiftSelect).toBeTruthy()
    shiftSelect!.value = 'shift-a'
    shiftSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(section!, '#attendance-assignment-start-date', '2026-05-01')
    setInput(section!, '#attendance-assignment-end-date', '2026-05-10')
    await flushUi(2)

    const createButton = Array.from(section!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Create assignment'))
    expect(createButton).toBeTruthy()
    expect(createButton!.disabled).toBe(false)
    createButton!.click()
    await flushUi(8)

    const previewCallIndex = vi.mocked(apiFetch).mock.calls.findIndex(([input]) =>
      String(input).includes('/api/attendance/comprehensive-hours/preview')
    )
    const saveCallIndex = vi.mocked(apiFetch).mock.calls.findIndex(([input, init]) =>
      String(input) === '/api/attendance/assignments' && init?.method === 'POST'
    )
    expect(previewCallIndex).toBeGreaterThanOrEqual(0)
    expect(saveCallIndex).toBeGreaterThan(previewCallIndex)
    const previewBody = JSON.parse(String(vi.mocked(apiFetch).mock.calls[previewCallIndex]![1]!.body))
    expect(previewBody).toMatchObject({
      policyDraft: { capHours: 160, enforcement: 'warn' },
      scope: { userId: 'user-9' },
      period: { type: 'custom_range', from: '2026-05-01', to: '2026-05-10' },
      metric: 'planned',
    })
    expect(previewBody).not.toHaveProperty('allUsers')
    expect(section!.querySelector('[data-attendance-comprehensive-hours-assignment-advisory="shift"]')?.textContent)
      .toContain('Saving is still allowed')
    expect(container!.textContent).toContain('Assignment created.')
  })

  it('runs a weak comprehensive-hours advisory before saving rotation assignments without blocking save', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/rotation-rules')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'rot-1',
                name: 'Two shift',
                timezone: 'UTC',
                shiftSequence: ['shift-a', 'shift-b'],
                isActive: true,
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/comprehensive-hours/preview')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            readOnly: true,
            period: { type: 'custom_range', from: '2026-05-01', to: '2026-05-10' },
            metric: 'planned',
            enforcement: 'warn',
            capMinutes: 9600,
            scope: { userIds: ['user-7'] },
            aggregate: {
              users: 1,
              ok: 0,
              warning: 1,
              violation: 0,
              totalMinutes: 9500,
              totalExcessMinutes: 0,
              totalRemainingMinutes: 100,
              status: 'warning',
            },
            rows: [
              {
                userId: 'user-7',
                minutes: 9500,
                plannedMinutes: 9500,
                capMinutes: 9600,
                remainingMinutes: 100,
                excessMinutes: 0,
                status: 'warning',
                source: 'effective_calendar',
              },
            ],
            degraded: false,
          },
        })
      }
      if (url === '/api/attendance/rotation-assignments' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const section = container!.querySelector<HTMLElement>('#attendance-admin-rotation-assignments')
    expect(section).toBeTruthy()
    selectUserPicker(section!, '#attendance-rotation-user', 'user-7')
    const rotationSelect = section!.querySelector<HTMLSelectElement>('#attendance-rotation-rule')
    expect(rotationSelect).toBeTruthy()
    rotationSelect!.value = 'rot-1'
    rotationSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(section!, '#attendance-rotation-start', '2026-05-01')
    setInput(section!, '#attendance-rotation-end', '2026-05-10')
    await flushUi(2)

    const createButton = Array.from(section!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Create assignment'))
    expect(createButton).toBeTruthy()
    createButton!.click()
    await flushUi(8)

    const previewCallIndex = vi.mocked(apiFetch).mock.calls.findIndex(([input]) =>
      String(input).includes('/api/attendance/comprehensive-hours/preview')
    )
    const saveCallIndex = vi.mocked(apiFetch).mock.calls.findIndex(([input, init]) =>
      String(input) === '/api/attendance/rotation-assignments' && init?.method === 'POST'
    )
    expect(previewCallIndex).toBeGreaterThanOrEqual(0)
    expect(saveCallIndex).toBeGreaterThan(previewCallIndex)
    const previewBody = JSON.parse(String(vi.mocked(apiFetch).mock.calls[previewCallIndex]![1]!.body))
    expect(previewBody).toMatchObject({
      policyDraft: { capHours: 160, enforcement: 'warn' },
      scope: { userId: 'user-7' },
      period: { type: 'custom_range', from: '2026-05-01', to: '2026-05-10' },
      metric: 'planned',
    })
    expect(previewBody).not.toHaveProperty('allUsers')
    expect(section!.querySelector('[data-attendance-comprehensive-hours-assignment-advisory="rotation"]')?.textContent)
      .toContain('Saving is still allowed')
    expect(container!.textContent).toContain('Rotation assignment created.')
  })

  it('keeps shift assignment save available when the weak comprehensive-hours advisory preview fails', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'shift-a',
                name: 'Day shift',
                timezone: 'UTC',
                workStartTime: '09:00',
                workEndTime: '18:00',
                isOvernight: false,
                lateGraceMinutes: 10,
                earlyGraceMinutes: 10,
                roundingMinutes: 5,
                workingDays: [1, 2, 3, 4, 5],
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/comprehensive-hours/preview')) {
        return jsonResponse(503, {
          ok: false,
          error: { code: 'DB_NOT_READY', message: 'schema not ready' },
        })
      }
      if (url === '/api/attendance/assignments' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const section = container!.querySelector<HTMLElement>('#attendance-admin-assignments')
    expect(section).toBeTruthy()
    selectUserPicker(section!, '#attendance-assignment-user-id', 'user-9')
    const shiftSelect = section!.querySelector<HTMLSelectElement>('#attendance-assignment-shift-id')
    expect(shiftSelect).toBeTruthy()
    shiftSelect!.value = 'shift-a'
    shiftSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(section!, '#attendance-assignment-start-date', '2026-05-01')
    setInput(section!, '#attendance-assignment-end-date', '2026-05-10')
    await flushUi(2)

    const createButton = Array.from(section!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Create assignment'))
    expect(createButton).toBeTruthy()
    createButton!.click()
    await flushUi(8)

    expect(vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
      String(input) === '/api/attendance/assignments' && init?.method === 'POST'
    )).toBe(true)
    expect(section!.querySelector('[data-attendance-comprehensive-hours-assignment-advisory="shift"]')?.textContent)
      .toContain('saving is still allowed')
    expect(container!.textContent).toContain('Assignment created.')
  })

  it('PR5 strong-control blocks shift assignment save when preview returns violation', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'shift-a',
                name: 'Day shift',
                timezone: 'UTC',
                workStartTime: '09:00',
                workEndTime: '18:00',
                isOvernight: false,
                lateGraceMinutes: 10,
                earlyGraceMinutes: 10,
                roundingMinutes: 5,
                workingDays: [1, 2, 3, 4, 5],
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/comprehensive-hours/preview')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            readOnly: true,
            period: { type: 'custom_range', from: '2026-05-01', to: '2026-05-10' },
            metric: 'planned',
            enforcement: 'block',
            capMinutes: 9600,
            scope: { userIds: ['user-9'] },
            aggregate: {
              users: 1,
              ok: 0,
              warning: 0,
              violation: 1,
              totalMinutes: 10200,
              totalExcessMinutes: 600,
              totalRemainingMinutes: 0,
              status: 'violation',
            },
            rows: [
              {
                userId: 'user-9',
                minutes: 10200,
                plannedMinutes: 10200,
                capMinutes: 9600,
                remainingMinutes: 0,
                excessMinutes: 600,
                status: 'violation',
                source: 'effective_calendar',
              },
            ],
            degraded: false,
          },
        })
      }
      if (url === '/api/attendance/assignments' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const strongModeCheckbox = container!.querySelector<HTMLInputElement>('#attendance-comprehensive-hours-save-block-mode')
    expect(strongModeCheckbox).toBeTruthy()
    strongModeCheckbox!.checked = true
    strongModeCheckbox!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-assignments')
    expect(section).toBeTruthy()
    selectUserPicker(section!, '#attendance-assignment-user-id', 'user-9')
    const shiftSelect = section!.querySelector<HTMLSelectElement>('#attendance-assignment-shift-id')
    expect(shiftSelect).toBeTruthy()
    shiftSelect!.value = 'shift-a'
    shiftSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(section!, '#attendance-assignment-start-date', '2026-05-01')
    setInput(section!, '#attendance-assignment-end-date', '2026-05-10')
    await flushUi(2)

    const createButton = Array.from(section!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Create assignment'))
    expect(createButton).toBeTruthy()
    createButton!.click()
    await flushUi(8)

    const previewBody = JSON.parse(String(vi.mocked(apiFetch).mock.calls.find(([input]) =>
      String(input).includes('/api/attendance/comprehensive-hours/preview')
    )![1]!.body))
    expect(previewBody).toMatchObject({
      policyDraft: { capHours: 160, enforcement: 'block' },
      scope: { userId: 'user-9' },
      period: { type: 'custom_range', from: '2026-05-01', to: '2026-05-10' },
      metric: 'planned',
    })
    expect(previewBody).not.toHaveProperty('allUsers')

    const savePosted = vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
      String(input) === '/api/attendance/assignments' && init?.method === 'POST'
    )
    expect(savePosted).toBe(false)
    expect(container!.textContent).not.toContain('Assignment created.')

    const advisory = section!.querySelector<HTMLElement>('[data-attendance-comprehensive-hours-assignment-advisory="shift"]')
    expect(advisory).toBeTruthy()
    expect(advisory!.dataset.attendanceComprehensiveHoursAssignmentAdvisoryKind).toBe('block')
    const advisoryText = advisory!.textContent || ''
    expect(advisoryText).toContain('strong-control')
    expect(advisoryText).toContain('save blocked')
    expect(advisoryText).not.toContain('cannot save')
    expect(advisoryText).not.toContain('policy enforced')
    expect(advisoryText).not.toContain('violation prevented')
    expect(advisoryText).not.toContain('禁止保存')
    expect(advisoryText).not.toContain('已强制策略')
    expect(advisoryText).not.toContain('已阻止违规')
  })

  it('PR5 strong-control allows shift assignment save when preview returns warning', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'shift-a',
                name: 'Day shift',
                timezone: 'UTC',
                workStartTime: '09:00',
                workEndTime: '18:00',
                isOvernight: false,
                lateGraceMinutes: 10,
                earlyGraceMinutes: 10,
                roundingMinutes: 5,
                workingDays: [1, 2, 3, 4, 5],
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/comprehensive-hours/preview')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            readOnly: true,
            period: { type: 'custom_range', from: '2026-05-01', to: '2026-05-10' },
            metric: 'planned',
            enforcement: 'block',
            capMinutes: 9600,
            scope: { userIds: ['user-9'] },
            aggregate: {
              users: 1,
              ok: 0,
              warning: 1,
              violation: 0,
              totalMinutes: 9500,
              totalExcessMinutes: 0,
              totalRemainingMinutes: 100,
              status: 'warning',
            },
            rows: [
              {
                userId: 'user-9',
                minutes: 9500,
                plannedMinutes: 9500,
                capMinutes: 9600,
                remainingMinutes: 100,
                excessMinutes: 0,
                status: 'warning',
                source: 'effective_calendar',
              },
            ],
            degraded: false,
          },
        })
      }
      if (url === '/api/attendance/assignments' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const strongModeCheckbox = container!.querySelector<HTMLInputElement>('#attendance-comprehensive-hours-save-block-mode')
    expect(strongModeCheckbox).toBeTruthy()
    strongModeCheckbox!.checked = true
    strongModeCheckbox!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-assignments')
    expect(section).toBeTruthy()
    selectUserPicker(section!, '#attendance-assignment-user-id', 'user-9')
    const shiftSelect = section!.querySelector<HTMLSelectElement>('#attendance-assignment-shift-id')
    shiftSelect!.value = 'shift-a'
    shiftSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(section!, '#attendance-assignment-start-date', '2026-05-01')
    setInput(section!, '#attendance-assignment-end-date', '2026-05-10')
    await flushUi(2)

    const createButton = Array.from(section!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Create assignment'))
    expect(createButton).toBeTruthy()
    createButton!.click()
    await flushUi(8)

    const previewBody = JSON.parse(String(vi.mocked(apiFetch).mock.calls.find(([input]) =>
      String(input).includes('/api/attendance/comprehensive-hours/preview')
    )![1]!.body))
    expect(previewBody.policyDraft.enforcement).toBe('block')

    const savePosted = vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
      String(input) === '/api/attendance/assignments' && init?.method === 'POST'
    )
    expect(savePosted).toBe(true)
    expect(container!.textContent).toContain('Assignment created.')

    const advisory = section!.querySelector<HTMLElement>('[data-attendance-comprehensive-hours-assignment-advisory="shift"]')
    expect(advisory?.dataset.attendanceComprehensiveHoursAssignmentAdvisoryKind).toBe('warn')
    expect(advisory?.textContent).toContain('Saving is still allowed')
  })

  it('PR5 strong-control allows shift assignment save when preview returns ok', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'shift-a',
                name: 'Day shift',
                timezone: 'UTC',
                workStartTime: '09:00',
                workEndTime: '18:00',
                isOvernight: false,
                lateGraceMinutes: 10,
                earlyGraceMinutes: 10,
                roundingMinutes: 5,
                workingDays: [1, 2, 3, 4, 5],
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/comprehensive-hours/preview')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            readOnly: true,
            period: { type: 'custom_range', from: '2026-05-01', to: '2026-05-10' },
            metric: 'planned',
            enforcement: 'block',
            capMinutes: 9600,
            scope: { userIds: ['user-9'] },
            aggregate: {
              users: 1,
              ok: 1,
              warning: 0,
              violation: 0,
              totalMinutes: 5000,
              totalExcessMinutes: 0,
              totalRemainingMinutes: 4600,
              status: 'ok',
            },
            rows: [
              {
                userId: 'user-9',
                minutes: 5000,
                plannedMinutes: 5000,
                capMinutes: 9600,
                remainingMinutes: 4600,
                excessMinutes: 0,
                status: 'ok',
                source: 'effective_calendar',
              },
            ],
            degraded: false,
          },
        })
      }
      if (url === '/api/attendance/assignments' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const strongModeCheckbox = container!.querySelector<HTMLInputElement>('#attendance-comprehensive-hours-save-block-mode')
    strongModeCheckbox!.checked = true
    strongModeCheckbox!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-assignments')
    selectUserPicker(section!, '#attendance-assignment-user-id', 'user-9')
    const shiftSelect = section!.querySelector<HTMLSelectElement>('#attendance-assignment-shift-id')
    shiftSelect!.value = 'shift-a'
    shiftSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(section!, '#attendance-assignment-start-date', '2026-05-01')
    setInput(section!, '#attendance-assignment-end-date', '2026-05-10')
    await flushUi(2)

    const createButton = Array.from(section!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Create assignment'))
    createButton!.click()
    await flushUi(8)

    expect(vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
      String(input) === '/api/attendance/assignments' && init?.method === 'POST'
    )).toBe(true)
    expect(container!.textContent).toContain('Assignment created.')

    const advisory = section!.querySelector<HTMLElement>('[data-attendance-comprehensive-hours-assignment-advisory="shift"]')
    expect(advisory?.textContent || '').toBe('')
  })

  it('PR5 strong-control allows shift assignment save when preview fails with 503', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'shift-a',
                name: 'Day shift',
                timezone: 'UTC',
                workStartTime: '09:00',
                workEndTime: '18:00',
                isOvernight: false,
                lateGraceMinutes: 10,
                earlyGraceMinutes: 10,
                roundingMinutes: 5,
                workingDays: [1, 2, 3, 4, 5],
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/comprehensive-hours/preview')) {
        return jsonResponse(503, {
          ok: false,
          error: { code: 'DB_NOT_READY', message: 'schema not ready' },
        })
      }
      if (url === '/api/attendance/assignments' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const strongModeCheckbox = container!.querySelector<HTMLInputElement>('#attendance-comprehensive-hours-save-block-mode')
    strongModeCheckbox!.checked = true
    strongModeCheckbox!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-assignments')
    selectUserPicker(section!, '#attendance-assignment-user-id', 'user-9')
    const shiftSelect = section!.querySelector<HTMLSelectElement>('#attendance-assignment-shift-id')
    shiftSelect!.value = 'shift-a'
    shiftSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(section!, '#attendance-assignment-start-date', '2026-05-01')
    setInput(section!, '#attendance-assignment-end-date', '2026-05-10')
    await flushUi(2)

    const createButton = Array.from(section!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Create assignment'))
    createButton!.click()
    await flushUi(8)

    expect(vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
      String(input) === '/api/attendance/assignments' && init?.method === 'POST'
    )).toBe(true)
    expect(container!.textContent).toContain('Assignment created.')

    const advisory = section!.querySelector<HTMLElement>('[data-attendance-comprehensive-hours-assignment-advisory="shift"]')
    expect(advisory?.dataset.attendanceComprehensiveHoursAssignmentAdvisoryKind).toBe('error')
    expect(advisory?.textContent).toContain('saving is still allowed')
  })

  it('PR5 strong-control blocks rotation assignment save when preview returns violation', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/rotation-rules')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'rot-1',
                name: 'Two shift',
                timezone: 'UTC',
                shiftSequence: ['shift-a', 'shift-b'],
                isActive: true,
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/comprehensive-hours/preview')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            readOnly: true,
            period: { type: 'custom_range', from: '2026-05-01', to: '2026-05-10' },
            metric: 'planned',
            enforcement: 'block',
            capMinutes: 9600,
            scope: { userIds: ['user-7'] },
            aggregate: {
              users: 1,
              ok: 0,
              warning: 0,
              violation: 1,
              totalMinutes: 10500,
              totalExcessMinutes: 900,
              totalRemainingMinutes: 0,
              status: 'violation',
            },
            rows: [
              {
                userId: 'user-7',
                minutes: 10500,
                plannedMinutes: 10500,
                capMinutes: 9600,
                remainingMinutes: 0,
                excessMinutes: 900,
                status: 'violation',
                source: 'effective_calendar',
              },
            ],
            degraded: false,
          },
        })
      }
      if (url === '/api/attendance/rotation-assignments' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const strongModeCheckbox = container!.querySelector<HTMLInputElement>('#attendance-comprehensive-hours-save-block-mode')
    strongModeCheckbox!.checked = true
    strongModeCheckbox!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-rotation-assignments')
    expect(section).toBeTruthy()
    selectUserPicker(section!, '#attendance-rotation-user', 'user-7')
    const rotationSelect = section!.querySelector<HTMLSelectElement>('#attendance-rotation-rule')
    rotationSelect!.value = 'rot-1'
    rotationSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(section!, '#attendance-rotation-start', '2026-05-01')
    setInput(section!, '#attendance-rotation-end', '2026-05-10')
    await flushUi(2)

    const createButton = Array.from(section!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Create assignment'))
    createButton!.click()
    await flushUi(8)

    const previewBody = JSON.parse(String(vi.mocked(apiFetch).mock.calls.find(([input]) =>
      String(input).includes('/api/attendance/comprehensive-hours/preview')
    )![1]!.body))
    expect(previewBody).toMatchObject({
      policyDraft: { capHours: 160, enforcement: 'block' },
      scope: { userId: 'user-7' },
      period: { type: 'custom_range', from: '2026-05-01', to: '2026-05-10' },
      metric: 'planned',
    })
    expect(previewBody).not.toHaveProperty('allUsers')

    expect(vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
      String(input) === '/api/attendance/rotation-assignments' && init?.method === 'POST'
    )).toBe(false)
    expect(container!.textContent).not.toContain('Rotation assignment created.')

    const advisory = section!.querySelector<HTMLElement>('[data-attendance-comprehensive-hours-assignment-advisory="rotation"]')
    expect(advisory?.dataset.attendanceComprehensiveHoursAssignmentAdvisoryKind).toBe('block')
    expect(advisory?.textContent).toContain('strong-control')
    expect(advisory?.textContent).toContain('save blocked')
  })

  it('PR5 strong-control does NOT block shift assignment save when preview is degraded even if status is violation', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'shift-a',
                name: 'Day shift',
                timezone: 'UTC',
                workStartTime: '09:00',
                workEndTime: '18:00',
                isOvernight: false,
                lateGraceMinutes: 10,
                earlyGraceMinutes: 10,
                roundingMinutes: 5,
                workingDays: [1, 2, 3, 4, 5],
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/comprehensive-hours/preview')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            readOnly: true,
            period: { type: 'custom_range', from: '2026-05-01', to: '2026-05-10' },
            metric: 'planned',
            enforcement: 'block',
            capMinutes: 9600,
            scope: { userIds: ['user-9'] },
            aggregate: {
              users: 1,
              ok: 0,
              warning: 0,
              violation: 1,
              totalMinutes: 10200,
              totalExcessMinutes: 600,
              totalRemainingMinutes: 0,
              status: 'violation',
            },
            rows: [
              {
                userId: 'user-9',
                minutes: 10200,
                plannedMinutes: 10200,
                capMinutes: 9600,
                remainingMinutes: 0,
                excessMinutes: 600,
                status: 'violation',
                source: 'effective_calendar',
              },
            ],
            degraded: true,
          },
        })
      }
      if (url === '/api/attendance/assignments' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const strongModeCheckbox = container!.querySelector<HTMLInputElement>('#attendance-comprehensive-hours-save-block-mode')
    strongModeCheckbox!.checked = true
    strongModeCheckbox!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-assignments')
    selectUserPicker(section!, '#attendance-assignment-user-id', 'user-9')
    const shiftSelect = section!.querySelector<HTMLSelectElement>('#attendance-assignment-shift-id')
    shiftSelect!.value = 'shift-a'
    shiftSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(section!, '#attendance-assignment-start-date', '2026-05-01')
    setInput(section!, '#attendance-assignment-end-date', '2026-05-10')
    await flushUi(2)

    const createButton = Array.from(section!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Create assignment'))
    createButton!.click()
    await flushUi(8)

    expect(vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
      String(input) === '/api/attendance/assignments' && init?.method === 'POST'
    )).toBe(true)
    expect(container!.textContent).toContain('Assignment created.')

    const advisory = section!.querySelector<HTMLElement>('[data-attendance-comprehensive-hours-assignment-advisory="shift"]')
    expect(advisory?.dataset.attendanceComprehensiveHoursAssignmentAdvisoryKind).toBe('warn')
    const advisoryText = advisory?.textContent || ''
    expect(advisoryText).toContain('degraded')
    expect(advisoryText).toContain('saving is still allowed')
    expect(advisoryText).not.toContain('save blocked')
  })

  it('PR5 inactive shift assignment skips the preview call in both modes', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/shifts')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'shift-a',
                name: 'Day shift',
                timezone: 'UTC',
                workStartTime: '09:00',
                workEndTime: '18:00',
                isOvernight: false,
                lateGraceMinutes: 10,
                earlyGraceMinutes: 10,
                roundingMinutes: 5,
                workingDays: [1, 2, 3, 4, 5],
              },
            ],
          },
        })
      }
      if (url === '/api/attendance/assignments' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const strongModeCheckbox = container!.querySelector<HTMLInputElement>('#attendance-comprehensive-hours-save-block-mode')
    strongModeCheckbox!.checked = true
    strongModeCheckbox!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-assignments')
    selectUserPicker(section!, '#attendance-assignment-user-id', 'user-9')
    const shiftSelect = section!.querySelector<HTMLSelectElement>('#attendance-assignment-shift-id')
    shiftSelect!.value = 'shift-a'
    shiftSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(section!, '#attendance-assignment-start-date', '2026-05-01')
    setInput(section!, '#attendance-assignment-end-date', '2026-05-10')

    const activeCheckbox = section!.querySelector<HTMLInputElement>('#attendance-assignment-active')
    expect(activeCheckbox).toBeTruthy()
    activeCheckbox!.checked = false
    activeCheckbox!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const createButton = Array.from(section!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Create assignment'))
    createButton!.click()
    await flushUi(8)

    const previewCalled = vi.mocked(apiFetch).mock.calls.some(([input]) =>
      String(input).includes('/api/attendance/comprehensive-hours/preview')
    )
    expect(previewCalled).toBe(false)

    expect(vi.mocked(apiFetch).mock.calls.some(([input, init]) =>
      String(input) === '/api/attendance/assignments' && init?.method === 'POST'
    )).toBe(true)
    expect(container!.textContent).toContain('Assignment created.')

    const advisory = section!.querySelector<HTMLElement>('[data-attendance-comprehensive-hours-assignment-advisory="shift"]')
    expect(advisory?.textContent || '').toBe('')
  })

  it('restores the run21 holiday calendar, rule builder, and import template guidance', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const holidayNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-holidays"]')
    const ruleSetNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-rule-sets"]')
    const importNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import"]')
    expect(holidayNav).toBeTruthy()
    expect(ruleSetNav).toBeTruthy()
    expect(importNav).toBeTruthy()

    holidayNav!.click()
    await flushUi(2)
    expect(container!.textContent).toContain('Holiday management now follows a month calendar.')
    expect(container!.textContent).toContain('Selected date')

    ruleSetNav!.click()
    await flushUi(2)
    expect(container!.textContent).toContain('Structured rule builder')
    expect(container!.textContent).toContain('engine.templates[].rules[]')
    expect(container!.textContent).toContain('Apply builder to JSON')
    expect(container!.textContent).toContain('Draft preview')
    expect(container!.textContent).toContain('Sample event builder')
    expect(container!.querySelector('.attendance__rule-set-workbench')).toBeTruthy()
    expect(container!.querySelector('.attendance__rule-set-basics')).toBeTruthy()
    expect(container!.querySelector('.attendance__rule-builder-shell')).toBeTruthy()
    expect(container!.querySelector('.attendance__rule-set-advanced')).toBeTruthy()

    const previewButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Preview rule set'))
    expect(previewButton).toBeTruthy()
    previewButton!.click()
    await flushUi(4)

    expect(container!.textContent).toContain('Rows affected')
    expect(container!.textContent).toContain('Raise late grace')
    expect(container!.textContent).toContain('Selected preview row')
    expect(container!.textContent).toContain('Source payload')

    importNav!.click()
    await flushUi(2)
    const importSection = container!.querySelector<HTMLElement>('[data-admin-section="attendance-admin-import"]')
    expect(importSection).toBeTruthy()
    const buttons = Array.from(importSection!.querySelectorAll<HTMLButtonElement>('button'))
    const loadTemplateButton = buttons.find(button => button.textContent?.includes('Load template'))
    expect(loadTemplateButton).toBeTruthy()
    loadTemplateButton!.click()
    await flushUi(2)

    const mappingProfileSelect = container!.querySelector<HTMLSelectElement>('#attendance-import-profile')
    expect(mappingProfileSelect).toBeTruthy()
    mappingProfileSelect!.value = 'default-profile'
    mappingProfileSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    expect(container!.textContent).toContain('Template guide')
    expect(container!.textContent).toContain('Field meanings')
    expect(container!.textContent).toContain('Selected mapping profile')
    expect(container!.textContent).toContain('Single-user quick start')
    expect(container!.textContent).toContain('Suggested CSV header')
    expect(container!.textContent).toContain('日期,上班1打卡时间,下班1打卡时间')
  })

  it('restores template version details and import batch diagnostics from the split admin sections', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const templateLibraryNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-rule-template-library"]')
    expect(templateLibraryNav).toBeTruthy()
    templateLibraryNav!.click()
    await flushUi(2)

    const viewVersionButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('View'))
    expect(viewVersionButton).toBeTruthy()
    viewVersionButton!.click()
    await flushUi(2)

    expect(container!.textContent).toContain('Selected version')
    expect(container!.textContent).toContain('ops-admin')
    expect(container!.textContent).toContain('Night Shift')

    const dataPayrollHeader = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-nav-group-header'))
      .find(button => button.textContent?.includes('Data & Payroll'))
    expect(dataPayrollHeader).toBeTruthy()
    if (dataPayrollHeader!.getAttribute('aria-expanded') === 'false') {
      dataPayrollHeader!.click()
      await flushUi(2)
    }

    const importBatchesNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    expect(importBatchesNav).toBeTruthy()
    importBatchesNav!.click()
    await flushUi(2)

    const importBatchesSection = container!.querySelector<HTMLElement>('[data-admin-section="attendance-admin-import-batches"]')
    expect(importBatchesSection).toBeTruthy()

    const viewItemsButton = Array.from(importBatchesSection!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('View items'))
    expect(viewItemsButton).toBeTruthy()
    viewItemsButton!.click()
    await flushUi(6)

    expect(importBatchesSection!.textContent).toContain('Rollback impact estimate')
    expect(importBatchesSection!.textContent).toContain('Retry guidance')
    expect(importBatchesSection!.textContent).toContain('Mapping viewer')
    expect(importBatchesSection!.textContent).toContain('Selected item detail')
    expect(importBatchesSection!.textContent).toContain('Engine: bulk')
  })
})
