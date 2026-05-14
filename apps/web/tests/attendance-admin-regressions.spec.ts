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

  beforeEach(() => {
    vi.clearAllMocks()
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

    vi.mocked(apiFetch).mockImplementation(async (input) => {
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
            total: 1,
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
    expect(container!.textContent).toContain('User picker')
    expect(container!.textContent).toContain('Append selected user')
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
