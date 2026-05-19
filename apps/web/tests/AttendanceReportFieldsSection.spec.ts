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
        formulaDependencyGraph: {
          formulaFieldCount: 1,
          edgeCount: 2,
          blockedFormulaReferenceCount: 0,
          hasCycles: false,
          nodes: [
            { code: 'late_count', name: '迟到次数', formulaValid: true, formulaError: null, referenceCount: 2 },
          ],
          edges: [
            { from: 'late_count', to: 'early_leave_duration', type: 'field' },
            { from: 'late_count', to: 'late_duration', type: 'field' },
          ],
          blockedFormulaReferences: [],
          cycles: [],
        },
      },
    },
  }
}

function formulaEditorPayload(expression = '={late_duration}+1', scope = 'record') {
  const payload = populatedCatalogPayload() as any
  payload.data.items = [
    ...payload.data.items,
    {
      code: 'net_anomaly_minutes',
      name: '异常净时长',
      category: 'anomaly',
      categoryLabel: '异常统计字段',
      source: 'custom',
      unit: 'minutes',
      enabled: true,
      reportVisible: true,
      sortOrder: 4500,
      dingtalkFieldName: '异常净时长',
      description: '自定义公式字段',
      internalKey: 'formula.net_anomaly_minutes',
      configured: true,
      systemDefined: false,
      formulaEnabled: true,
      formulaExpression: expression,
      formulaScope: scope,
      formulaOutputType: 'duration_minutes',
      formulaValid: true,
      formulaError: null,
      formulaReferences: ['late_duration'],
    },
  ]
  payload.data.reportFieldConfig.fieldsFingerprint.fieldCount = payload.data.items.length
  payload.data.reportFieldConfig.fieldsFingerprint.codes = payload.data.items.map((item: { code: string }) => item.code)
  return payload
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

  it('renders the formula function reference panel', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, populatedCatalogPayload()))

    mountSection()
    await flushUi()

    const panel = container!.querySelector('[data-report-field-formula-reference]')
    expect(panel).toBeTruthy()
    expect(container!.querySelectorAll('[data-report-field-formula-reference]')).toHaveLength(1)
    expect(panel?.textContent).toContain('Formula reference')
    expect(panel?.textContent).toContain('Record and summary scopes')
    expect(panel?.textContent).toContain('{field_code}')
    expect(panel?.textContent).toContain('{late_duration}')
    expect(panel?.textContent).toContain('{leave_type_annual_duration}')
    expect(panel?.textContent).toContain('{total_minutes}')
    expect(panel?.textContent).toContain('IF')
    expect(panel?.textContent).toContain('SUM')
    expect(panel?.textContent).toContain('DATEDIF')
    expect(panel?.textContent).toContain('CONCAT')
    expect(panel?.textContent).toContain('={late_duration}+{early_leave_duration}')
    expect(panel?.textContent).toContain('=IF({attendance_days}>0,{work_duration},0)')
    expect(panel?.textContent).toContain('NOW, TODAY, lookup functions')
  })

  it('renders all six function reference groups with descriptions and examples in tooltips', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, populatedCatalogPayload()))

    mountSection()
    await flushUi()

    const panel = container!.querySelector('[data-report-field-formula-reference]')!
    const groupIds = Array.from(panel.querySelectorAll('[data-report-field-formula-reference-group]'))
      .map((el) => el.getAttribute('data-report-field-formula-reference-group'))
    expect(groupIds).toEqual(['condition', 'logical', 'math', 'aggregate', 'date', 'text'])

    expect(panel.querySelectorAll('[data-report-field-formula-function]')).toHaveLength(29)

    const ifTitle = panel.querySelector('[data-report-field-formula-function="IF"]')!.getAttribute('title') ?? ''
    expect(ifTitle).toContain('IF')
    expect(ifTitle).toContain('Conditional branch')
    expect(ifTitle).toContain('Example:')
    expect(ifTitle).toContain('IF({attendance_days}>0,1,0)')

    const sumTitle = panel.querySelector('[data-report-field-formula-function="SUM"]')!.getAttribute('title') ?? ''
    expect(sumTitle).toContain('summary scope')

    const datedifTitle = panel.querySelector('[data-report-field-formula-function="DATEDIF"]')!.getAttribute('title') ?? ''
    expect(datedifTitle).toContain('DATEDIF({work_date},DATE(2026,12,31),"D")')
  })

  it('renders the dedicated disabled-functions block with five entries', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, populatedCatalogPayload()))

    mountSection()
    await flushUi()

    const block = container!.querySelector('[data-report-field-formula-reference-disabled]')!
    expect(block.textContent).toContain('Disabled functions')
    const items = Array.from(block.querySelectorAll('[data-report-field-formula-disabled-id]'))
      .map((el) => el.getAttribute('data-report-field-formula-disabled-id'))
    expect(items).toEqual(['now', 'today', 'lookup', 'cross-table', 'scripts'])
    expect(block.textContent).toContain('Non-deterministic')
    expect(block.textContent).toContain('VLOOKUP')
    expect(block.textContent).toContain('Spreadsheet-style references')
    expect(block.textContent).toContain('Free-form scripts')
  })

  it('toggles the formula reference scope and updates the scope hint', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, populatedCatalogPayload()))

    mountSection()
    await flushUi()

    const recordBtn = container!.querySelector<HTMLButtonElement>('[data-report-field-formula-reference-scope-option="record"]')!
    const summaryBtn = container!.querySelector<HTMLButtonElement>('[data-report-field-formula-reference-scope-option="summary"]')!
    expect(recordBtn.getAttribute('aria-pressed')).toBe('true')
    expect(summaryBtn.getAttribute('aria-pressed')).toBe('false')

    const hint = container!.querySelector('[data-report-field-formula-reference-scope-hint]')!
    expect(hint.textContent).toContain('Record scope')
    expect(hint.textContent).toContain('reads the row value directly')

    summaryBtn.click()
    await flushUi()

    expect(recordBtn.getAttribute('aria-pressed')).toBe('false')
    expect(summaryBtn.getAttribute('aria-pressed')).toBe('true')
    expect(hint.textContent).toContain('Summary scope')
    expect(hint.textContent).toContain('SUM, AVERAGE, COUNT, or COUNTA')

    recordBtn.click()
    await flushUi()
    expect(recordBtn.getAttribute('aria-pressed')).toBe('true')
    expect(hint.textContent).toContain('Record scope')
  })

  it('renders catalog-derived referenceable chips, excluding formula and disabled fields', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, populatedCatalogPayload()))

    mountSection()
    await flushUi()

    const codes = Array.from(container!.querySelectorAll('[data-report-field-formula-reference-code]'))
      .map((el) => el.getAttribute('data-report-field-formula-reference-code'))
    expect(codes).toContain('employee_name')
    expect(codes).toContain('punch_result')
    expect(codes).toContain('attendance_days')
    expect(codes).toContain('leave_duration')
    expect(codes).not.toContain('late_count')
    expect(codes).not.toContain('workday_overtime_duration')
  })

  it('switches static chips to summary aliases and hides catalog-derived chips in summary scope', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, populatedCatalogPayload()))

    mountSection()
    await flushUi()

    const recordStatic = Array.from(container!.querySelectorAll('[data-report-field-formula-static-chip]'))
      .map((el) => el.getAttribute('data-report-field-formula-static-chip'))
    expect(recordStatic).toEqual(['field_code', 'late_duration', 'leave_type_annual_duration', 'total_minutes'])
    expect(container!.querySelectorAll('[data-report-field-formula-reference-code]').length).toBeGreaterThan(0)

    container!.querySelector<HTMLButtonElement>('[data-report-field-formula-reference-scope-option="summary"]')!.click()
    await flushUi()

    const summaryStatic = Array.from(container!.querySelectorAll('[data-report-field-formula-static-chip]'))
      .map((el) => el.getAttribute('data-report-field-formula-static-chip'))
    expect(summaryStatic).toEqual(['total_minutes', 'leave_minutes', 'overtime_minutes', 'work_duration', 'late_duration', 'early_leave_duration'])
    expect(summaryStatic).toContain('total_minutes')
    expect(summaryStatic).toContain('leave_minutes')
    expect(container!.querySelectorAll('[data-report-field-formula-reference-code]')).toHaveLength(0)

    const summaryHint = container!.querySelector('[data-report-field-formula-reference-scope-hint]')!
    expect(summaryHint.textContent).toContain('summary aliases')
    expect(summaryHint.textContent).toContain('Preview validates')

    container!.querySelector<HTMLButtonElement>('[data-report-field-formula-reference-scope-option="record"]')!.click()
    await flushUi()

    const recordStaticAgain = Array.from(container!.querySelectorAll('[data-report-field-formula-static-chip]'))
      .map((el) => el.getAttribute('data-report-field-formula-static-chip'))
    expect(recordStaticAgain).toEqual(['field_code', 'late_duration', 'leave_type_annual_duration', 'total_minutes'])
    expect(container!.querySelectorAll('[data-report-field-formula-reference-code]').length).toBeGreaterThan(0)
  })

  it('shows the inline editor help line pointing to the reference panel when editing', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, formulaEditorPayload()))

    mountSection()
    await flushUi()

    expect(container!.querySelector('[data-report-field-formula-editor-help="net_anomaly_minutes"]')).toBeNull()

    container!.querySelector<HTMLButtonElement>('[data-report-field-formula-edit="net_anomaly_minutes"]')!.click()
    await flushUi()

    const help = container!.querySelector('[data-report-field-formula-editor-help="net_anomaly_minutes"]')!
    expect(help.textContent).toContain('function reference panel above')
    expect(help.textContent).toContain('Preview before saving')
  })

  it('surfaces preview errors from the existing formula preview endpoint', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(200, formulaEditorPayload()))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          ok: false,
          error: 'Reference {foo} is not allowed in v1.',
        },
      }))

    mountSection()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-report-field-formula-edit="net_anomaly_minutes"]')!.click()
    await flushUi()

    const textarea = container!.querySelector<HTMLTextAreaElement>('[data-report-field-formula-expression="net_anomaly_minutes"]')!
    textarea.value = '={foo}+1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-report-field-formula-preview="net_anomaly_minutes"]')!.click()
    await flushUi()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/report-fields/formula/preview?orgId=org-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: '={foo}+1', formulaScope: 'record' }),
    })
    const message = container!.querySelector('[data-report-field-formula-preview-result]')!
    expect(message.textContent).toContain('Preview error')
    expect(message.textContent).toContain('Reference {foo} is not allowed in v1.')
  })

  it('renders formula dependency graph summary and blocked formula references', async () => {
    const payload = formulaEditorPayload('={late_count}+1') as any
    payload.data.reportFieldConfig.formulaDependencyGraph = {
      formulaFieldCount: 2,
      edgeCount: 3,
      blockedFormulaReferenceCount: 1,
      hasCycles: false,
      nodes: [
        { code: 'late_count', name: '迟到次数', formulaValid: true, formulaError: null, referenceCount: 2 },
        { code: 'net_anomaly_minutes', name: '异常净时长', formulaValid: false, formulaError: 'Formula field reference late_count is not supported in v1.', referenceCount: 1 },
      ],
      edges: [
        { from: 'late_count', to: 'early_leave_duration', type: 'field' },
        { from: 'late_count', to: 'late_duration', type: 'field' },
        { from: 'net_anomaly_minutes', to: 'late_count', type: 'formula' },
      ],
      blockedFormulaReferences: [
        { from: 'net_anomaly_minutes', to: 'late_count', type: 'formula' },
      ],
      cycles: [],
    }
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, payload))

    mountSection()
    await flushUi()

    const graph = container!.querySelector('[data-report-field-formula-dependency-graph]')
    expect(graph).toBeTruthy()
    expect(graph?.textContent).toContain('Formula dependencies')
    expect(graph?.textContent).toContain('Formula fields: 2')
    expect(graph?.textContent).toContain('References: 3')
    expect(graph?.textContent).toContain('Blocked formula refs: 1')
    expect(graph?.textContent).toContain('No cycles')
    expect(container!.querySelector('[data-report-field-formula-dependency-blocked]')?.textContent).toContain('net_anomaly_minutes -> late_count')
  })

  it('renders opt-in custom formula source mode metadata', async () => {
    const payload = populatedCatalogPayload() as any
    payload.data.items.push({
      code: 'manual_credit_minutes',
      name: '手工抵扣分钟',
      category: 'attendance',
      categoryLabel: '出勤统计字段',
      source: 'custom',
      unit: 'minutes',
      enabled: true,
      reportVisible: false,
      sortOrder: 3002,
      description: '只作为公式源',
      internalKey: 'manualCredit',
      configured: true,
      systemDefined: false,
      formulaEnabled: false,
      formulaSourceMode: 'alias',
    })
    payload.data.multitable.recordCount = payload.data.items.length
    payload.data.reportFieldConfig.fieldsFingerprint.fieldCount = payload.data.items.length
    payload.data.reportFieldConfig.fieldsFingerprint.codes = payload.data.items.map((item: { code: string }) => item.code)
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, payload))

    mountSection()
    await flushUi()

    expect(container!.textContent).toContain('手工抵扣分钟')
    expect(container!.textContent).toContain('Formula source')
    expect(container!.textContent).toContain('Named formula source alias')
    expect(container!.textContent).toContain('manualCredit')
  })

  it('previews and saves an existing custom formula field inline', async () => {
    const initial = formulaEditorPayload()
    const updated = formulaEditorPayload('={late_duration}+{early_leave_duration}')
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(200, initial))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          ok: true,
          value: 17,
          references: ['early_leave_duration', 'late_duration'],
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          operation: 'patched',
          field: updated.data.items.find((item: { code: string }) => item.code === 'net_anomaly_minutes'),
          catalog: updated.data,
        },
      }))

    mountSection()
    await flushUi()

    expect(container!.querySelector('[data-report-field-formula-edit="late_count"]')).toBeNull()
    const editButton = container!.querySelector<HTMLButtonElement>('[data-report-field-formula-edit="net_anomaly_minutes"]')
    expect(editButton).toBeTruthy()
    editButton!.click()
    await flushUi()

    const textarea = container!.querySelector<HTMLTextAreaElement>('[data-report-field-formula-expression="net_anomaly_minutes"]')
    expect(textarea).toBeTruthy()
    textarea!.value = '={late_duration}+{early_leave_duration}'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-report-field-formula-preview="net_anomaly_minutes"]')!.click()
    await flushUi()
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/report-fields/formula/preview?orgId=org-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: '={late_duration}+{early_leave_duration}', formulaScope: 'record' }),
    })
    expect(container!.querySelector('[data-report-field-formula-preview-result]')?.textContent).toContain('Preview value: 17')
    expect(container!.querySelector('[data-report-field-formula-preview-result]')?.textContent).toContain('early_leave_duration, late_duration')

    container!.querySelector<HTMLButtonElement>('[data-report-field-formula-save="net_anomaly_minutes"]')!.click()
    await flushUi()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/report-fields/net_anomaly_minutes/formula?orgId=org-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('={late_duration}+{early_leave_duration}'),
    })
    expect(container!.textContent).toContain('Formula field saved.')
    expect(container!.textContent).toContain('={late_duration}+{early_leave_duration}')
    expect(container!.querySelector('[data-report-field-formula-editor="net_anomaly_minutes"]')).toBeNull()
  })

  it('creates a new custom formula field from the reference panel', async () => {
    const updated = formulaEditorPayload('={total_minutes}-{leave_minutes}', 'summary')
    const newField = updated.data.items.find((item: { code: string }) => item.code === 'net_anomaly_minutes')
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(200, populatedCatalogPayload()))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          operation: 'created',
          field: newField,
          catalog: updated.data,
        },
      }))

    mountSection()
    await flushUi()

    container!.querySelector<HTMLInputElement>('[data-report-field-formula-create-code]')!.value = 'net_anomaly_minutes'
    container!.querySelector<HTMLInputElement>('[data-report-field-formula-create-code]')!.dispatchEvent(new Event('input', { bubbles: true }))
    container!.querySelector<HTMLInputElement>('[data-report-field-formula-create-name]')!.value = '异常净时长'
    container!.querySelector<HTMLInputElement>('[data-report-field-formula-create-name]')!.dispatchEvent(new Event('input', { bubbles: true }))
    const scopeSelect = container!.querySelector<HTMLSelectElement>('[data-report-field-formula-create-scope]')!
    expect(scopeSelect).toBeTruthy()
    scopeSelect.value = 'summary'
    scopeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    container!.querySelector<HTMLTextAreaElement>('[data-report-field-formula-create-expression]')!.value = '={total_minutes}-{leave_minutes}'
    container!.querySelector<HTMLTextAreaElement>('[data-report-field-formula-create-expression]')!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-report-field-formula-create-save]')!.click()
    await flushUi()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/report-fields/net_anomaly_minutes/formula?orgId=org-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('"formulaScope":"summary"'),
    })
    expect(container!.textContent).toContain('Formula field saved.')
    expect(container!.textContent).toContain('net_anomaly_minutes')
    expect(container!.textContent).toContain('={total_minutes}-{leave_minutes}')
    expect(container!.textContent).toContain('Summary scope')
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

  it('shows a warning banner when droppedReservedCodes is present and hides it otherwise', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        categories: [{ id: 'fixed', label: '固定字段', sortOrder: 10 }],
        items: [
          { code: 'employee_name', name: '姓名', category: 'fixed', categoryLabel: '固定字段', source: 'system', unit: 'text', enabled: true, reportVisible: true, sortOrder: 1001, systemDefined: true },
        ],
        droppedReservedCodes: ['late_minutes', 'work_minutes'],
        multitable: { available: true, degraded: false, projectId: 'org-1:attendance', recordCount: 3 },
      },
    }))

    mountSection()
    await flushUi()

    const banner = container!.querySelector('[data-report-field-dropped-reserved]')
    expect(banner).toBeTruthy()
    expect(banner?.getAttribute('role')).toBe('alert')
    expect(banner?.textContent).toContain('late_minutes, work_minutes')
    expect(banner?.textContent).toContain('Rename them in the multitable catalog')

    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, populatedCatalogPayload()))
    if (app) app.unmount()
    container!.innerHTML = ''
    mountSection()
    await flushUi()
    expect(container!.querySelector('[data-report-field-dropped-reserved]')).toBeNull()
  })

  it('renders the DingTalk punch split fields in the grid', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        categories: [{ id: 'basic', label: '基础字段', sortOrder: 20 }],
        items: [
          { code: 'punch_in_1', name: '上班1打卡时间', category: 'basic', categoryLabel: '基础字段', source: 'system', unit: 'dateTime', enabled: true, reportVisible: true, sortOrder: 2010, dingtalkFieldName: '上班1打卡时间', description: '第1次上班打卡时间', systemDefined: true },
          { code: 'punch_out_3', name: '下班3打卡时间', category: 'basic', categoryLabel: '基础字段', source: 'system', unit: 'dateTime', enabled: true, reportVisible: true, sortOrder: 2060, dingtalkFieldName: '下班3打卡时间', description: '第3次下班打卡时间', systemDefined: true },
          { code: 'punch_result_in_1', name: '上班1打卡结果', category: 'basic', categoryLabel: '基础字段', source: 'system', unit: 'text', enabled: true, reportVisible: true, sortOrder: 2070, dingtalkFieldName: '上班1打卡结果', description: '第1次上班打卡结果', systemDefined: true },
        ],
        droppedReservedCodes: [],
        multitable: { available: true, degraded: false, projectId: 'org-1:attendance', recordCount: 3 },
      },
    }))

    mountSection()
    await flushUi()

    const text = container!.textContent ?? ''
    expect(text).toContain('上班1打卡时间')
    expect(text).toContain('下班3打卡时间')
    expect(text).toContain('上班1打卡结果')
    const codes = Array.from(container!.querySelectorAll('code')).map(node => node.textContent)
    expect(codes).toEqual(expect.arrayContaining(['punch_in_1', 'punch_out_3', 'punch_result_in_1']))
  })

  it('renders dynamic leave/overtime subtype fields in the grid', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        categories: [
          { id: 'leave', label: '请假统计字段', sortOrder: 50 },
          { id: 'overtime', label: '加班统计字段', sortOrder: 60 },
        ],
        items: [
          { code: 'leave_type_annual_duration', name: '年假时长', category: 'leave', categoryLabel: '请假统计字段', source: 'system', unit: 'minutes', enabled: true, reportVisible: true, sortOrder: 5010, dingtalkFieldName: '年假时长', description: '已审批年假时长', systemDefined: true },
          { code: 'overtime_rule_ota_duration', name: '工作日加班加班时长', category: 'overtime', categoryLabel: '加班统计字段', source: 'system', unit: 'minutes', enabled: true, reportVisible: true, sortOrder: 6010, dingtalkFieldName: '工作日加班加班时长', description: '已审批工作日加班时长', systemDefined: true },
        ],
        droppedReservedCodes: [],
        multitable: { available: true, degraded: false, projectId: 'org-1:attendance', recordCount: 2 },
      },
    }))

    mountSection()
    await flushUi()

    const text = container!.textContent ?? ''
    expect(text).toContain('年假时长')
    expect(text).toContain('工作日加班加班时长')
    const codes = Array.from(container!.querySelectorAll('code')).map(node => node.textContent)
    expect(codes).toEqual(expect.arrayContaining(['leave_type_annual_duration', 'overtime_rule_ota_duration']))
  })

  it('syncs report records into the multitable object and shows the fingerprint chain', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(200, populatedCatalogPayload()))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          synced: 2,
          created: 1,
          patched: 1,
          skipped: 0,
          failed: 0,
          duplicateRowKeys: 0,
          fieldFingerprint: 'rr-field-fingerprint',
          syncedAt: '2026-05-16T12:00:00.000Z',
          multitable: {
            available: true,
            degraded: false,
            projectId: 'org-1:attendance',
            objectId: 'attendance_report_records',
            baseId: 'base-rr',
            sheetId: 'sheet-rr',
            viewId: 'view-rr',
          },
        },
      }))

    mountSection()
    await flushUi()

    const fromInput = container!.querySelector<HTMLInputElement>('[data-report-record-sync-from]')
    const toInput = container!.querySelector<HTMLInputElement>('[data-report-record-sync-to]')
    const userInput = container!.querySelector<HTMLInputElement>('[data-report-record-sync-user]')
    const syncButton = container!.querySelector<HTMLButtonElement>('[data-report-record-sync-button]')
    expect(fromInput).toBeTruthy()
    expect(toInput).toBeTruthy()
    expect(userInput).toBeTruthy()
    expect(syncButton).toBeTruthy()
    expect(syncButton!.disabled).toBe(true)

    fromInput!.value = '2026-05-01'
    fromInput!.dispatchEvent(new Event('input', { bubbles: true }))
    toInput!.value = '2026-05-31'
    toInput!.dispatchEvent(new Event('input', { bubbles: true }))
    userInput!.value = 'u-1'
    userInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(syncButton!.disabled).toBe(false)

    syncButton!.click()
    await flushUi()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/report-records/sync?orgId=org-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-05-01', to: '2026-05-31', userId: 'u-1' }),
    })
    const status = container!.querySelector('[data-report-record-sync-status]')
    expect(status?.textContent).toContain('Report records synchronized.')
    expect(status?.textContent).toContain('Rows: 2')
    expect(status?.textContent).toContain('Created: 1')
    expect(status?.textContent).toContain('Patched: 1')
    expect(container!.querySelector('[data-report-record-sync-detail="fieldFingerprint"]')?.textContent).toContain('rr-field-fingerprint')
    expect(container!.querySelector('[data-report-record-sync-detail="syncedAt"]')?.textContent).toContain('2026-05-16T12:00:00.000Z')
    expect(container!.querySelector('[data-report-record-sync-detail="objectId"]')?.textContent).toContain('attendance_report_records')
    expect(container!.querySelector<HTMLAnchorElement>('[data-report-record-open-multitable]')?.getAttribute('href'))
      .toBe('/multitable/sheet-rr/view-rr?baseId=base-rr')
  })

  it('syncs report records for all users with pagination controls', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(200, populatedCatalogPayload()))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          synced: 4,
          rowsSynced: 4,
          created: 3,
          patched: 1,
          skipped: 0,
          failed: 0,
          duplicateRowKeys: 0,
          usersScanned: 2,
          usersSynced: 2,
          usersFailed: 0,
          totalUsers: 5,
          page: 2,
          pageSize: 2,
          hasNextPage: true,
          fieldFingerprint: 'bulk-field-fingerprint',
          syncedAt: '2026-05-18T12:00:00.000Z',
          multitable: {
            available: true,
            degraded: false,
            projectId: 'org-1:attendance',
            objectId: 'attendance_report_records',
            sheetId: 'sheet-rr',
            viewId: 'view-rr',
          },
        },
      }))

    mountSection()
    await flushUi()

    const fromInput = container!.querySelector<HTMLInputElement>('[data-report-record-sync-from]')!
    const toInput = container!.querySelector<HTMLInputElement>('[data-report-record-sync-to]')!
    const userInput = container!.querySelector<HTMLInputElement>('[data-report-record-sync-user]')!
    const allUsersInput = container!.querySelector<HTMLInputElement>('[data-report-record-sync-all-users]')!
    const pageInput = container!.querySelector<HTMLInputElement>('[data-report-record-sync-page]')!
    const pageSizeInput = container!.querySelector<HTMLInputElement>('[data-report-record-sync-page-size]')!
    const syncButton = container!.querySelector<HTMLButtonElement>('[data-report-record-sync-button]')!

    fromInput.value = '2026-05-01'
    fromInput.dispatchEvent(new Event('input', { bubbles: true }))
    toInput.value = '2026-05-31'
    toInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(syncButton.disabled).toBe(true)

    allUsersInput.click()
    await flushUi()
    expect(userInput.disabled).toBe(true)
    expect(pageInput.disabled).toBe(false)
    expect(pageSizeInput.disabled).toBe(false)

    pageInput.value = '2'
    pageInput.dispatchEvent(new Event('input', { bubbles: true }))
    pageSizeInput.value = '2'
    pageSizeInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(syncButton.disabled).toBe(false)

    syncButton.click()
    await flushUi()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/report-records/sync?orgId=org-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-05-01', to: '2026-05-31', allUsers: true, page: 2, pageSize: 2 }),
    })
    const status = container!.querySelector('[data-report-record-sync-status]')
    expect(status?.textContent).toContain('Users: 2')
    expect(status?.textContent).toContain('Synced users: 2')
    expect(status?.textContent).toContain('Rows: 4')
    expect(container!.querySelector('[data-report-record-sync-detail="totalUsers"]')?.textContent).toContain('5')
    expect(container!.querySelector('[data-report-record-sync-detail="page"]')?.textContent).toContain('2')
    expect(container!.querySelector('[data-report-record-sync-detail="hasNextPage"]')?.textContent).toContain('Yes')
    expect(container!.querySelector('[data-report-record-sync-detail="fieldFingerprint"]')?.textContent).toContain('bulk-field-fingerprint')
  })

  it('shows degraded report-records sync as a non-blocking warning', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(200, populatedCatalogPayload()))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          degraded: true,
          reason: 'MULTITABLE_RECORDS_API_UNAVAILABLE',
          synced: 0,
        },
      }))

    mountSection()
    await flushUi()

    const fromInput = container!.querySelector<HTMLInputElement>('[data-report-record-sync-from]')!
    const toInput = container!.querySelector<HTMLInputElement>('[data-report-record-sync-to]')!
    const userInput = container!.querySelector<HTMLInputElement>('[data-report-record-sync-user]')!
    fromInput.value = '2026-05-01'
    fromInput.dispatchEvent(new Event('input', { bubbles: true }))
    toInput.value = '2026-05-31'
    toInput.dispatchEvent(new Event('input', { bubbles: true }))
    userInput.value = 'u-1'
    userInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-report-record-sync-button]')!.click()
    await flushUi()

    const status = container!.querySelector('[data-report-record-sync-status]')
    expect(status?.textContent).toContain('Report records sync degraded.')
    expect(status?.textContent).toContain('MULTITABLE_RECORDS_API_UNAVAILABLE')
    expect(status?.className).toContain('attendance__status--warn')
    expect(container!.querySelector('[data-report-record-open-multitable]')).toBeNull()
    expect(container!.textContent).toContain('Report fields')
  })

  it('syncs date-range period summaries for a single user and shows the multitable result', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(200, populatedCatalogPayload()))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          periodType: 'date_range',
          periodKey: 'range:2026-05-01:2026-05-31',
          from: '2026-05-01',
          to: '2026-05-31',
          synced: 1,
          created: 1,
          patched: 0,
          skipped: 0,
          failed: 0,
          duplicateRowKeys: 0,
          usersScanned: 1,
          usersSynced: 1,
          usersFailed: 0,
          fieldFingerprint: 'period-field-fingerprint',
          syncedAt: '2026-05-19T12:00:00.000Z',
          multitable: {
            available: true,
            degraded: false,
            projectId: 'org-1:attendance',
            objectId: 'attendance_report_period_summaries',
            baseId: 'base-period',
            sheetId: 'sheet-period',
            viewId: 'view-period',
          },
        },
      }))

    mountSection()
    await flushUi()

    const fromInput = container!.querySelector<HTMLInputElement>('[data-report-period-summary-sync-from]')
    const toInput = container!.querySelector<HTMLInputElement>('[data-report-period-summary-sync-to]')
    const userInput = container!.querySelector<HTMLInputElement>('[data-report-period-summary-sync-user]')
    const syncButton = container!.querySelector<HTMLButtonElement>('[data-report-period-summary-sync-button]')
    expect(fromInput).toBeTruthy()
    expect(toInput).toBeTruthy()
    expect(userInput).toBeTruthy()
    expect(syncButton).toBeTruthy()
    expect(syncButton!.disabled).toBe(true)

    fromInput!.value = '2026-05-01'
    fromInput!.dispatchEvent(new Event('input', { bubbles: true }))
    toInput!.value = '2026-05-31'
    toInput!.dispatchEvent(new Event('input', { bubbles: true }))
    userInput!.value = 'u-1'
    userInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(syncButton!.disabled).toBe(false)

    syncButton!.click()
    await flushUi()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/report-period-summaries/sync?orgId=org-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-05-01', to: '2026-05-31', userId: 'u-1' }),
    })
    const status = container!.querySelector('[data-report-period-summary-sync-status]')
    expect(status?.textContent).toContain('Period summaries synchronized.')
    expect(status?.textContent).toContain('Period: date_range 2026-05-01..2026-05-31')
    expect(status?.textContent).toContain('Rows: 1')
    expect(status?.textContent).toContain('Created: 1')
    expect(container!.querySelector('[data-report-period-summary-sync-detail="periodType"]')?.textContent).toContain('date_range')
    expect(container!.querySelector('[data-report-period-summary-sync-detail="fieldFingerprint"]')?.textContent).toContain('period-field-fingerprint')
    expect(container!.querySelector('[data-report-period-summary-sync-detail="syncedAt"]')?.textContent).toContain('2026-05-19T12:00:00.000Z')
    expect(container!.querySelector('[data-report-period-summary-sync-detail="objectId"]')?.textContent).toContain('attendance_report_period_summaries')
    expect(container!.querySelector<HTMLAnchorElement>('[data-report-period-summary-open-multitable]')?.getAttribute('href'))
      .toBe('/multitable/sheet-period/view-period?baseId=base-period')
  })

  it('syncs payroll-cycle period summaries for an explicit user list', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(200, populatedCatalogPayload()))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          periodType: 'payroll_cycle',
          periodKey: 'cycle:11111111-1111-4111-8111-111111111111',
          cycleId: '11111111-1111-4111-8111-111111111111',
          periodName: 'May payroll',
          from: '2026-05-01',
          to: '2026-05-31',
          synced: 2,
          created: 2,
          patched: 0,
          skipped: 0,
          failed: 0,
          duplicateRowKeys: 0,
          usersScanned: 2,
          usersSynced: 2,
          usersFailed: 0,
          fieldFingerprint: 'cycle-field-fingerprint',
          syncedAt: '2026-05-19T12:10:00.000Z',
          multitable: {
            available: true,
            degraded: false,
            projectId: 'org-1:attendance',
            objectId: 'attendance_report_period_summaries',
            sheetId: 'sheet-period',
            viewId: 'view-period',
          },
        },
      }))

    mountSection()
    await flushUi()

    const periodMode = container!.querySelector<HTMLSelectElement>('[data-report-period-summary-sync-period-mode]')!
    const userMode = container!.querySelector<HTMLSelectElement>('[data-report-period-summary-sync-user-mode]')!
    periodMode.value = 'payroll_cycle'
    periodMode.dispatchEvent(new Event('change', { bubbles: true }))
    userMode.value = 'multiple'
    userMode.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    const cycleInput = container!.querySelector<HTMLInputElement>('[data-report-period-summary-sync-cycle]')!
    const userIdsInput = container!.querySelector<HTMLTextAreaElement>('[data-report-period-summary-sync-user-ids]')!
    cycleInput.value = '11111111-1111-4111-8111-111111111111'
    cycleInput.dispatchEvent(new Event('input', { bubbles: true }))
    userIdsInput.value = 'u-1, u-2\nu-3'
    userIdsInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-report-period-summary-sync-button]')!.click()
    await flushUi()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/report-period-summaries/sync?orgId=org-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cycleId: '11111111-1111-4111-8111-111111111111', userIds: ['u-1', 'u-2', 'u-3'] }),
    })
    expect(container!.querySelector('[data-report-period-summary-sync-detail="cycleId"]')?.textContent)
      .toContain('11111111-1111-4111-8111-111111111111')
    expect(container!.querySelector('[data-report-period-summary-sync-detail="periodName"]')?.textContent).toContain('May payroll')
    expect(container!.querySelector('[data-report-period-summary-sync-detail="usersScanned"]')?.textContent).toContain('2')
  })

  it('syncs period summaries for all users with pagination controls', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(200, populatedCatalogPayload()))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          periodType: 'date_range',
          from: '2026-05-01',
          to: '2026-05-31',
          synced: 4,
          created: 3,
          patched: 1,
          skipped: 0,
          failed: 0,
          duplicateRowKeys: 0,
          usersScanned: 2,
          usersSynced: 2,
          usersFailed: 0,
          totalUsers: 7,
          page: 2,
          pageSize: 2,
          hasNextPage: true,
          fieldFingerprint: 'period-bulk-field-fingerprint',
          syncedAt: '2026-05-19T12:20:00.000Z',
          multitable: {
            available: true,
            degraded: false,
            projectId: 'org-1:attendance',
            objectId: 'attendance_report_period_summaries',
            sheetId: 'sheet-period',
            viewId: 'view-period',
          },
        },
      }))

    mountSection()
    await flushUi()

    const userMode = container!.querySelector<HTMLSelectElement>('[data-report-period-summary-sync-user-mode]')!
    const pageInput = container!.querySelector<HTMLInputElement>('[data-report-period-summary-sync-page]')!
    const pageSizeInput = container!.querySelector<HTMLInputElement>('[data-report-period-summary-sync-page-size]')!
    const syncButton = container!.querySelector<HTMLButtonElement>('[data-report-period-summary-sync-button]')!
    expect(pageInput.disabled).toBe(true)
    expect(pageSizeInput.disabled).toBe(true)

    userMode.value = 'all'
    userMode.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(pageInput.disabled).toBe(false)
    expect(pageSizeInput.disabled).toBe(false)

    container!.querySelector<HTMLInputElement>('[data-report-period-summary-sync-from]')!.value = '2026-05-01'
    container!.querySelector<HTMLInputElement>('[data-report-period-summary-sync-from]')!.dispatchEvent(new Event('input', { bubbles: true }))
    container!.querySelector<HTMLInputElement>('[data-report-period-summary-sync-to]')!.value = '2026-05-31'
    container!.querySelector<HTMLInputElement>('[data-report-period-summary-sync-to]')!.dispatchEvent(new Event('input', { bubbles: true }))
    pageInput.value = '2'
    pageInput.dispatchEvent(new Event('input', { bubbles: true }))
    pageSizeInput.value = '2'
    pageSizeInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(syncButton.disabled).toBe(false)

    syncButton.click()
    await flushUi()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/report-period-summaries/sync?orgId=org-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-05-01', to: '2026-05-31', allUsers: true, page: 2, pageSize: 2 }),
    })
    expect(container!.querySelector('[data-report-period-summary-sync-status]')?.textContent).toContain('Users: 2')
    expect(container!.querySelector('[data-report-period-summary-sync-status]')?.textContent).toContain('Rows: 4')
    expect(container!.querySelector('[data-report-period-summary-sync-detail="totalUsers"]')?.textContent).toContain('7')
    expect(container!.querySelector('[data-report-period-summary-sync-detail="page"]')?.textContent).toContain('2')
    expect(container!.querySelector('[data-report-period-summary-sync-detail="hasNextPage"]')?.textContent).toContain('Yes')
    expect(container!.querySelector('[data-report-period-summary-sync-detail="fieldFingerprint"]')?.textContent).toContain('period-bulk-field-fingerprint')
  })

  it('shows degraded period summary sync as a non-blocking warning', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(200, populatedCatalogPayload()))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          degraded: true,
          reason: 'MULTITABLE_RECORDS_API_UNAVAILABLE',
          periodType: 'date_range',
          from: '2026-05-01',
          to: '2026-05-31',
          synced: 0,
        },
      }))

    mountSection()
    await flushUi()

    const userInput = container!.querySelector<HTMLInputElement>('[data-report-period-summary-sync-user]')!
    userInput.value = 'u-1'
    userInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-report-period-summary-sync-button]')!.click()
    await flushUi()

    const status = container!.querySelector('[data-report-period-summary-sync-status]')
    expect(status?.textContent).toContain('Period summaries sync degraded.')
    expect(status?.textContent).toContain('MULTITABLE_RECORDS_API_UNAVAILABLE')
    expect(status?.className).toContain('attendance__status--warn')
    expect(container!.querySelector('[data-report-period-summary-open-multitable]')).toBeNull()
  })

  it('shows period summary sync API errors without clearing the report fields panel', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(200, populatedCatalogPayload()))
      .mockResolvedValueOnce(jsonResponse(400, { ok: false }))

    mountSection()
    await flushUi()

    const userInput = container!.querySelector<HTMLInputElement>('[data-report-period-summary-sync-user]')!
    userInput.value = 'u-1'
    userInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-report-period-summary-sync-button]')!.click()
    await flushUi()

    const status = container!.querySelector('[data-report-period-summary-sync-status]')
    expect(status?.textContent).toContain('Failed to sync period summaries')
    expect(status?.className).toContain('attendance__status--error')
    expect(container!.textContent).toContain('Report fields')
  })
})
