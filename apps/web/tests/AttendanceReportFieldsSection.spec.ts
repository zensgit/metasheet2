import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AttendanceReportFieldsSection from '../src/views/attendance/AttendanceReportFieldsSection.vue'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function populatedCatalogPayload() {
  return {
    ok: true,
    data: {
      categories: [
        { id: 'fixed', label: '固定字段', sortOrder: 10 },
        { id: 'basic', label: '基础字段', sortOrder: 20 },
        { id: 'attendance', label: '出勤统计字段', sortOrder: 30 },
        { id: 'anomaly', label: '异常统计字段', sortOrder: 40 },
        { id: 'leave', label: '请假统计字段', sortOrder: 50 },
        { id: 'overtime', label: '加班统计字段', sortOrder: 60 },
      ],
      items: [
        { code: 'employee_name', name: '姓名', category: 'fixed', categoryLabel: '固定字段', source: 'system', unit: 'text', enabled: true, reportVisible: true, sortOrder: 1001, dingtalkFieldName: '姓名', description: '员工姓名', internalKey: 'employee.name', systemDefined: true },
        { code: 'punch_result', name: '打卡结果', category: 'basic', categoryLabel: '基础字段', source: 'system', unit: 'text', enabled: true, reportVisible: true, sortOrder: 2001, dingtalkFieldName: '打卡结果', description: '打卡是否正常', internalKey: 'record.punchResult', systemDefined: true },
        { code: 'attendance_days', name: '出勤天数', category: 'attendance', categoryLabel: '出勤统计字段', source: 'system', unit: 'days', enabled: true, reportVisible: true, sortOrder: 3001, dingtalkFieldName: '出勤天数', description: '有效出勤天数', internalKey: 'summary.attendanceDays', systemDefined: true },
        { code: 'late_count', name: '迟到次数', category: 'anomaly', categoryLabel: '异常统计字段', source: 'system', unit: 'count', enabled: true, reportVisible: false, sortOrder: 4001, dingtalkFieldName: '迟到次数', description: '迟到次数', internalKey: 'summary.lateCount', configured: true, systemDefined: true, formulaEnabled: true, formulaExpression: '={late_duration}+{early_leave_duration}', formulaScope: 'record', formulaOutputType: 'number', formulaValid: true, formulaError: null, formulaReferences: ['early_leave_duration', 'late_duration'] },
        { code: 'leave_duration', name: '请假时长', category: 'leave', categoryLabel: '请假统计字段', source: 'system', unit: 'minutes', enabled: true, reportVisible: true, sortOrder: 5001, dingtalkFieldName: '请假时长', description: '请假分钟数', internalKey: 'summary.leaveMinutes', systemDefined: true },
        { code: 'workday_overtime_duration', name: '工作日加班时长', category: 'overtime', categoryLabel: '加班统计字段', source: 'system', unit: 'minutes', enabled: false, reportVisible: true, sortOrder: 6001, dingtalkFieldName: '工作日加班时长', description: '工作日加班分钟数', internalKey: 'summary.workdayOvertimeMinutes', systemDefined: true },
      ],
      multitable: {
        available: true,
        degraded: false,
        projectId: 'org-1:attendance',
        objectId: 'attendance_report_field_catalog',
        baseId: 'base-1',
        sheetId: 'sheet-1',
        viewId: 'view-1',
        seeded: 0,
        existing: 6,
        recordCount: 6,
      },
      reportFieldConfig: {
        fieldsFingerprint: {
          algorithm: 'sha1',
          value: 'unit-test-report-fields-fingerprint',
          fieldCount: 6,
          codes: [
            'employee_name',
            'punch_result',
            'attendance_days',
            'late_count',
            'leave_duration',
            'workday_overtime_duration',
          ],
        },
      },
    },
  }
}

describe('AttendanceReportFieldsSection', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  function mountSection(orgId = 'org-1') {
    app = createApp(AttendanceReportFieldsSection, {
      tr: (en: string) => en,
      orgId,
    })
    app.mount(container!)
  }

  it('renders DingTalk-compatible report field categories and multitable entry', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, populatedCatalogPayload()))

    mountSection()
    await flushUi()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/report-fields?orgId=org-1')
    expect(container!.textContent).toContain('Report fields')
    expect(container!.textContent).toContain('固定字段')
    expect(container!.textContent).toContain('基础字段')
    expect(container!.textContent).toContain('出勤统计字段')
    expect(container!.textContent).toContain('异常统计字段')
    expect(container!.textContent).toContain('请假统计字段')
    expect(container!.textContent).toContain('加班统计字段')
    expect(container!.textContent).toContain('Configured: 1')
    expect(container!.textContent).toContain('Formula: 1')
    expect(container!.textContent).toContain('Disabled: 1')
    expect(container!.textContent).toContain('Hidden: 1')
    expect(container!.textContent).toContain('Configuration')
    expect(container!.textContent).toContain('Formula')
    expect(container!.textContent).toContain('Mapping')
    expect(container!.textContent).toContain('Built-in')
    expect(container!.textContent).toContain('Configured')
    expect(container!.textContent).toContain('DingTalk field')
    expect(container!.textContent).toContain('Internal key')
    expect(container!.textContent).toContain('summary.lateCount')
    expect(container!.textContent).toContain('Order')
    expect(container!.textContent).toContain('4001')
    expect(container!.textContent).toContain('={late_duration}+{early_leave_duration}')
    expect(container!.textContent).toContain('References: early_leave_duration, late_duration')
    expect(container!.querySelector<HTMLAnchorElement>('a.attendance__btn')?.getAttribute('href')).toBe('/multitable/sheet-1/view-1?baseId=base-1')
    expect(container!.querySelector('[data-report-field-multitable-status]')?.textContent).toContain('Connected')
    expect(container!.querySelector('[data-report-field-multitable-detail="projectId"]')?.textContent).toContain('org-1:attendance')
    expect(container!.querySelector('[data-report-field-multitable-detail="objectId"]')?.textContent).toContain('attendance_report_field_catalog')
    expect(container!.querySelector('[data-report-field-multitable-detail="sheetId"]')?.textContent).toContain('sheet-1')
    expect(container!.querySelector('[data-report-field-multitable-detail="recordCount"]')?.textContent).toContain('6')
    expect(container!.querySelector('[data-report-field-multitable-detail="fieldsFingerprintAlgorithm"]')?.textContent).toContain('sha1')
    expect(container!.querySelector('[data-report-field-multitable-detail="fieldsFingerprint"]')?.textContent).toContain('unit-test-report-fields-fingerprint')
    expect(container!.querySelector('[data-report-field-multitable-detail="fieldsFingerprintCount"]')?.textContent).toContain('6')

    const syncButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Sync catalog'))
    expect(syncButton).toBeTruthy()
    syncButton!.click()
    await flushUi()
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/report-fields/sync?orgId=org-1', {
      method: 'POST',
    })
    const syncStatus = Array.from(container!.querySelectorAll<HTMLElement>('[role="status"]'))
      .find(element => element.textContent?.includes('Report field catalog synchronized.'))
    expect(syncStatus?.textContent).toContain('Seeded: 0')
    expect(syncStatus?.textContent).toContain('Existing: 6')
    expect(syncStatus?.textContent).toContain('Records: 6')
    expect(syncStatus?.textContent).toContain('Status: Connected')
  })

  it('filters report fields by text and operational state', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, populatedCatalogPayload()))

    mountSection()
    await flushUi()

    const searchInput = container!.querySelector<HTMLInputElement>('#attendance-report-field-search')
    const statusSelect = container!.querySelector<HTMLSelectElement>('#attendance-report-field-status-filter')
    const categorySelect = container!.querySelector<HTMLSelectElement>('#attendance-report-field-category-filter')
    const resetButton = container!.querySelector<HTMLButtonElement>('[data-report-field-reset-filters]')
    expect(searchInput).toBeTruthy()
    expect(statusSelect).toBeTruthy()
    expect(categorySelect).toBeTruthy()
    expect(resetButton).toBeTruthy()
    expect(resetButton!.disabled).toBe(true)
    expect(container!.textContent).toContain('Filtered fields: 6 / 6')

    categorySelect!.value = 'leave'
    categorySelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(container!.textContent).toContain('Filtered fields: 1 / 6')
    expect(container!.querySelector('[data-report-field-active-filters]')?.textContent).toContain('Category: 请假统计字段')
    expect(resetButton!.disabled).toBe(false)
    expect(container!.textContent).toContain('leave_duration')
    expect(container!.textContent).not.toContain('late_count')

    statusSelect!.value = 'hidden'
    statusSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(container!.textContent).toContain('Filtered fields: 0 / 6')
    expect(container!.querySelector('[data-report-field-active-filters]')?.textContent).toContain('State: Hidden')
    expect(container!.textContent).toContain('No report fields match the current filters.')

    resetButton!.click()
    await flushUi()
    expect(searchInput!.value).toBe('')
    expect(statusSelect!.value).toBe('all')
    expect(categorySelect!.value).toBe('all')
    expect(resetButton!.disabled).toBe(true)
    expect(container!.querySelector('[data-report-field-active-filters]')).toBeNull()
    expect(container!.textContent).toContain('Filtered fields: 6 / 6')

    categorySelect!.value = 'all'
    categorySelect!.dispatchEvent(new Event('change', { bubbles: true }))
    statusSelect!.value = 'all'
    statusSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(container!.textContent).toContain('Filtered fields: 6 / 6')

    searchInput!.value = 'late_count'
    searchInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(container!.textContent).toContain('Filtered fields: 1 / 6')
    expect(container!.textContent).toContain('late_count')
    expect(container!.textContent).not.toContain('employee_name')

    searchInput!.value = ''
    searchInput!.dispatchEvent(new Event('input', { bubbles: true }))
    statusSelect!.value = 'disabled'
    statusSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(container!.textContent).toContain('Filtered fields: 1 / 6')
    expect(container!.textContent).toContain('workday_overtime_duration')
    expect(container!.textContent).not.toContain('employee_name')

    statusSelect!.value = 'formula'
    statusSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(container!.textContent).toContain('Filtered fields: 1 / 6')
    expect(container!.querySelector('[data-report-field-active-filters]')?.textContent).toContain('State: Formula fields')
    expect(container!.textContent).toContain('late_count')
    expect(container!.textContent).not.toContain('employee_name')

    statusSelect!.value = 'hidden'
    statusSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(container!.textContent).toContain('Filtered fields: 1 / 6')
    expect(container!.textContent).toContain('late_count')

    searchInput!.value = 'not-a-field'
    searchInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(container!.textContent).toContain('Filtered fields: 0 / 6')
    expect(container!.textContent).toContain('No report fields match the current filters.')
  })

  it('handles an empty initial catalog without crashing', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        categories: [
          { id: 'fixed', label: '固定字段', sortOrder: 10 },
          { id: 'basic', label: '基础字段', sortOrder: 20 },
        ],
        items: [],
        multitable: {
          available: false,
          degraded: true,
          reason: 'MULTITABLE_UNAVAILABLE',
          projectId: 'default:attendance',
        },
      },
    }))

    mountSection('')
    await flushUi()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/report-fields')
    expect(container!.textContent).toContain('No report fields loaded yet.')
    expect(container!.textContent).toContain('Using built-in report field definitions')
    expect(container!.querySelector('[data-report-field-multitable-status]')?.textContent).toContain('Degraded')
    expect(container!.querySelector('[data-report-field-multitable-detail="reason"]')?.textContent).toContain('MULTITABLE_UNAVAILABLE')

    const syncButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Sync catalog'))
    expect(syncButton).toBeTruthy()
    syncButton!.click()
    await flushUi()
    const syncStatus = Array.from(container!.querySelectorAll<HTMLElement>('[role="status"]'))
      .find(element => element.textContent?.includes('Report field catalog synchronized.'))
    expect(syncStatus?.textContent).toContain('Status: Degraded')
  })
})
