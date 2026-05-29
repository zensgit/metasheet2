import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useAttendanceAdminPayroll } from '../src/views/attendance/useAttendanceAdminPayroll'

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response
}

function binaryResponse(status: number, body = 'csv,data'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    blob: async () => new Blob([body], { type: 'text/csv' }),
    text: async () => body,
  } as Response
}

function createOptions(overrides: Partial<Parameters<typeof useAttendanceAdminPayroll>[0]> = {}) {
  const adminForbidden = ref(false)
  const setStatus = vi.fn()
  return {
    adminForbidden,
    apiFetch: vi.fn(),
    confirm: vi.fn(() => true),
    defaultTimezone: 'Asia/Shanghai',
    downloadFile: vi.fn(),
    getOrgId: () => 'org-1',
    getUserId: () => 'user-1',
    setStatus,
    todayDate: '2026-03-12',
    tr: (en: string, _zh: string) => en,
    ...overrides,
  }
}

describe('useAttendanceAdminPayroll', () => {
  it('loads payroll templates and resolves template names', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, {
      ok: true,
      data: {
        items: [
          {
            id: 'tpl-1',
            name: 'Monthly',
            timezone: 'Asia/Shanghai',
            startDay: 1,
            endDay: 30,
            endMonthOffset: 0,
            autoGenerate: true,
            isDefault: true,
          },
        ],
      },
    }))
    const payroll = useAttendanceAdminPayroll(createOptions({ apiFetch }))

    await payroll.loadPayrollTemplates()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/payroll-templates?orgId=org-1')
    expect(payroll.payrollTemplates.value).toHaveLength(1)
    expect(payroll.payrollTemplateName('tpl-1')).toBe('Monthly')
    expect(payroll.payrollTemplateName('')).toBe('Manual')
  })

  it('saves a payroll template with parsed JSON config, reloads, and resets the form', async () => {
    const apiFetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/attendance/payroll-templates' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true, data: { id: 'tpl-2' } })
      }
      if (input === '/api/attendance/payroll-templates?orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'tpl-2',
                name: 'Biweekly',
                timezone: 'UTC',
                startDay: 5,
                endDay: 20,
                endMonthOffset: 1,
                autoGenerate: false,
                isDefault: false,
              },
            ],
          },
        })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const options = createOptions({ apiFetch })
    const payroll = useAttendanceAdminPayroll(options)

    payroll.payrollTemplateForm.name = ' Biweekly '
    payroll.payrollTemplateForm.timezone = 'UTC'
    payroll.payrollTemplateForm.startDay = 5
    payroll.payrollTemplateForm.endDay = 20
    payroll.payrollTemplateForm.endMonthOffset = 1
    payroll.payrollTemplateForm.autoGenerate = false
    payroll.payrollTemplateForm.config = '{"region":"CN"}'

    await payroll.savePayrollTemplate()

    const [, init] = apiFetch.mock.calls[0]!
    expect(JSON.parse(String(init?.body || '{}'))).toMatchObject({
      name: 'Biweekly',
      timezone: 'UTC',
      startDay: 5,
      endDay: 20,
      endMonthOffset: 1,
      autoGenerate: false,
      isDefault: false,
      config: { region: 'CN' },
      orgId: 'org-1',
    })
    expect(payroll.payrollTemplateForm.name).toBe('')
    expect(payroll.payrollTemplates.value[0]?.id).toBe('tpl-2')
    expect(options.setStatus).toHaveBeenCalledWith('Payroll template saved.')
  })

  it('loads summary formula field options and keeps only visible summary formulas', async () => {
    const apiFetch = vi.fn(async (input: string) => {
      if (input === '/api/attendance/report-fields?orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                code: 'period_net_minutes',
                name: '周期净时长',
                unit: 'minutes',
                enabled: true,
                reportVisible: true,
                formulaEnabled: true,
                formulaScope: 'summary',
              },
              {
                code: 'record_net_minutes',
                name: '记录净时长',
                enabled: true,
                reportVisible: true,
                formulaEnabled: true,
                formulaScope: 'record',
              },
              {
                code: 'hidden_period_metric',
                name: '隐藏周期字段',
                enabled: true,
                reportVisible: false,
                formulaEnabled: true,
                formulaScope: 'summary',
              },
            ],
          },
        })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const payroll = useAttendanceAdminPayroll(createOptions({ apiFetch }))

    await payroll.loadPayrollSummaryFieldOptions()

    expect(payroll.payrollSummaryFieldOptions.value.map(option => option.code)).toEqual(
      expect.arrayContaining(['total_minutes', 'work_duration', 'period_net_minutes']),
    )
    expect(payroll.payrollSummaryFieldOptions.value.map(option => option.code)).not.toContain('record_net_minutes')
    expect(payroll.payrollSummaryFieldOptions.value.map(option => option.code)).not.toContain('hidden_period_metric')
  })

  it('saves ordered summary fields into payroll template config', async () => {
    const apiFetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/attendance/payroll-templates' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true, data: { id: 'tpl-summary' } })
      }
      if (input === '/api/attendance/payroll-templates?orgId=org-1') {
        return jsonResponse(200, { ok: true, data: { items: [] } })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const payroll = useAttendanceAdminPayroll(createOptions({ apiFetch }))

    payroll.payrollTemplateForm.name = 'Field ordered'
    payroll.payrollTemplateForm.config = JSON.stringify({
      region: 'CN',
      summaryFieldCodes: ['legacy_metric'],
      payrollSummaryFields: ['legacy_alias'],
    })
    payroll.togglePayrollSummaryFieldCode('work_duration', true)
    payroll.togglePayrollSummaryFieldCode('period_net_minutes', true)
    payroll.togglePayrollSummaryFieldCode('late_days', true)
    payroll.movePayrollSummaryFieldCode('late_days', -1)

    await payroll.savePayrollTemplate()

    const [, init] = apiFetch.mock.calls[0]!
    const payload = JSON.parse(String(init?.body || '{}'))
    expect(payload.config).toEqual({
      region: 'CN',
      summaryFields: ['work_duration', 'late_days', 'period_net_minutes'],
    })
    expect(payroll.payrollTemplateForm.summaryFieldCodes).toEqual([])
  })

  it('hydrates summary field selections when editing a payroll template', () => {
    const payroll = useAttendanceAdminPayroll(createOptions())

    payroll.editPayrollTemplate({
      id: 'tpl-3',
      name: 'Configured',
      timezone: 'Asia/Shanghai',
      startDay: 1,
      endDay: 30,
      endMonthOffset: 0,
      autoGenerate: true,
      isDefault: false,
      config: {
        summaryFields: [
          'period_net_minutes',
          { fieldCode: 'work_duration' },
          { code: 'disabled_metric', enabled: false },
          'period_net_minutes',
        ],
      },
    })

    expect(payroll.payrollTemplateForm.summaryFieldCodes).toEqual(['period_net_minutes', 'work_duration'])
    expect(payroll.isPayrollSummaryFieldSelected('work_duration')).toBe(true)
  })

  it('requires a payroll template name before saving', async () => {
    const options = createOptions()
    const payroll = useAttendanceAdminPayroll(options)
    payroll.payrollTemplateForm.name = '   '
    payroll.payrollTemplateForm.config = '{"region":"CN"}'

    await payroll.savePayrollTemplate()

    expect(options.apiFetch).not.toHaveBeenCalled()
    expect(options.setStatus).toHaveBeenCalledWith('Payroll template name is required', 'error')
  })

  it('generates payroll cycles, records created/skipped counts, and reloads cycles', async () => {
    const apiFetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/attendance/payroll-cycles/generate' && init?.method === 'POST') {
        return jsonResponse(200, {
          ok: true,
          data: {
            created: [{ id: 'cycle-1' }, { id: 'cycle-2' }],
            skipped: [{ id: 'cycle-3' }],
          },
        })
      }
      if (input === '/api/attendance/payroll-cycles?orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'cycle-1', startDate: '2026-03-01', endDate: '2026-03-31', status: 'open' },
            ],
          },
        })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const options = createOptions({ apiFetch })
    const payroll = useAttendanceAdminPayroll(options)
    payroll.payrollCycleGenerateForm.anchorDate = '2026-03-12'
    payroll.payrollCycleGenerateForm.count = 2
    payroll.payrollCycleGenerateForm.metadata = '{"source":"seed"}'

    await payroll.generatePayrollCycles()

    expect(payroll.payrollCycleGenerateResult.value).toEqual({ created: 2, skipped: 1 })
    expect(payroll.payrollCycles.value).toHaveLength(1)
    expect(options.setStatus).toHaveBeenCalledWith('Payroll cycles generated.')
  })

  it('blocks empty manual payroll cycles before posting', async () => {
    const options = createOptions()
    const payroll = useAttendanceAdminPayroll(options)

    expect(payroll.payrollCycleCanSave.value).toBe(false)
    expect(payroll.payrollCycleValidationHint.value).toContain('start and end dates')

    await payroll.savePayrollCycle()

    expect(options.apiFetch).not.toHaveBeenCalled()
    expect(options.setStatus).toHaveBeenCalledWith(
      'Select a payroll template, or enter both start and end dates for a manual cycle.',
      'error',
    )
  })

  it('selects a saved payroll cycle so summary actions target it immediately', async () => {
    const savedCycle = {
      id: 'cycle-new',
      templateId: null,
      name: 'Manual May',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      status: 'open',
    }
    const apiFetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/attendance/payroll-cycles' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true, data: savedCycle })
      }
      if (input === '/api/attendance/payroll-cycles?orgId=org-1') {
        return jsonResponse(200, { ok: true, data: { items: [savedCycle] } })
      }
      if (input === '/api/attendance/payroll-cycles/cycle-new/summary?orgId=org-1&userId=user-1') {
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
      throw new Error(`Unexpected request: ${input}`)
    })
    const options = createOptions({ apiFetch })
    const payroll = useAttendanceAdminPayroll(options)
    payroll.payrollCycleForm.name = 'Manual May'
    payroll.payrollCycleForm.startDate = '2026-05-01'
    payroll.payrollCycleForm.endDate = '2026-05-31'

    await payroll.savePayrollCycle()
    await payroll.loadPayrollCycleSummary()

    expect(payroll.payrollCycleEditingId.value).toBe('cycle-new')
    expect(payroll.payrollCycleForm.name).toBe('Manual May')
    expect(payroll.payrollCycleSummary.value?.total_minutes).toBe(9600)
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/payroll-cycles/cycle-new/summary?orgId=org-1&userId=user-1')
    expect(options.setStatus).toHaveBeenCalledWith('Payroll cycle saved and selected.')
  })

  it('loads payroll summary and exports it through the injected downloader', async () => {
    const downloadFile = vi.fn()
    const apiFetch = vi.fn(async (input: string) => {
      if (input === '/api/attendance/payroll-cycles/cycle-9/summary?orgId=org-1&userId=user-1') {
        return jsonResponse(200, {
          ok: true,
          data: {
            summary: {
              total_days: 20,
              total_minutes: 9600,
              normal_days: 18,
              late_days: 1,
              early_leave_days: 0,
              late_early_days: 0,
              partial_days: 0,
              absent_days: 1,
              adjusted_days: 0,
              off_days: 8,
            },
          },
        })
      }
      if (input === '/api/attendance/payroll-cycles/cycle-9/summary/export?orgId=org-1&userId=user-1') {
        return binaryResponse(200)
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const options = createOptions({ apiFetch, downloadFile })
    const payroll = useAttendanceAdminPayroll(options)
    payroll.payrollCycleEditingId.value = 'cycle-9'

    await payroll.loadPayrollCycleSummary()
    await payroll.exportPayrollCycleSummary()

    expect(payroll.payrollCycleSummary.value?.total_minutes).toBe(9600)
    expect(downloadFile).toHaveBeenCalledTimes(1)
    expect(downloadFile).toHaveBeenCalledWith(expect.any(Blob), 'payroll-cycle-cycle-9.csv')
    expect(options.setStatus).toHaveBeenCalledWith('Payroll summary exported.')
  })

  it('marks admin forbidden on protected payroll template endpoints', async () => {
    const adminForbidden = ref(false)
    const apiFetch = vi.fn(async () => jsonResponse(403, { ok: false }))
    const payroll = useAttendanceAdminPayroll(createOptions({ adminForbidden, apiFetch }))

    await payroll.loadPayrollTemplates()

    expect(adminForbidden.value).toBe(true)
  })
})
