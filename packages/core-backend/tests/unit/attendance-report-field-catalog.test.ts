import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

describe('attendance report field catalog multitable foundation', () => {
  it('keeps the descriptor stable and covers DingTalk report field categories', () => {
    const descriptor = helpers.getAttendanceReportFieldCatalogDescriptor()
    const categories = helpers.cloneAttendanceReportFieldCategories()
    const fieldIds = descriptor.fields.map((field: { id: string }) => field.id)

    expect(descriptor.id).toBe('attendance_report_field_catalog')
    expect(helpers.getAttendanceReportFieldProjectId('org-a')).toBe('org-a:attendance')
    expect(categories.map((category: { label: string }) => category.label)).toEqual([
      '固定字段',
      '基础字段',
      '出勤统计字段',
      '异常统计字段',
      '请假统计字段',
      '加班统计字段',
    ])
    expect(fieldIds).toEqual([
      'field_code',
      'field_name',
      'category',
      'source',
      'unit',
      'enabled',
      'report_visible',
      'sort_order',
      'dingtalk_field_name',
      'description',
      'internal_key',
      'formula_enabled',
      'formula_expression',
      'formula_scope',
      'formula_output_type',
      'formula_source_mode',
    ])
  })

  it('provisions and seeds the catalog through the multitable plugin API only', async () => {
    const fieldIds = Object.fromEntries(
      Object.values(helpers.ATTENDANCE_REPORT_FIELD_CATALOG_FIELDS).map((fieldId) => [fieldId, `fld_${fieldId}`]),
    )
    const context = {
      api: {
        multitable: {
          provisioning: {
            ensureObject: vi.fn().mockResolvedValue({
              baseId: 'base-1',
              sheet: {
                id: 'sheet-1',
                baseId: 'base-1',
                name: '考勤统计字段目录',
                description: null,
              },
              fields: [],
            }),
            ensureView: vi.fn().mockResolvedValue({
              id: 'view-1',
              sheetId: 'sheet-1',
              name: '按分类查看',
              type: 'grid',
              filterInfo: {},
              sortInfo: {},
              groupInfo: {},
              hiddenFieldIds: [],
              config: {},
            }),
            resolveFieldIds: vi.fn().mockResolvedValue(fieldIds),
          },
          records: {
            queryRecords: vi.fn().mockResolvedValue([]),
            createRecord: vi.fn().mockImplementation(async (input) => ({
              id: 'rec-1',
              sheetId: input.sheetId,
              version: 1,
              data: input.data,
            })),
          },
        },
      },
    }

    const result = await helpers.ensureAttendanceReportFieldCatalog(context, 'org-a', { warn: vi.fn() })

    expect(result.projectId).toBe('org-a:attendance')
    expect(result.sheetId).toBe('sheet-1')
    expect(result.viewId).toBe('view-1')
    expect(context.api.multitable.provisioning.ensureObject).toHaveBeenCalledWith({
      projectId: 'org-a:attendance',
      descriptor: expect.objectContaining({
        id: 'attendance_report_field_catalog',
        name: '考勤统计字段目录',
      }),
    })
    expect(context.api.multitable.records.createRecord).toHaveBeenCalledTimes(
      helpers.cloneAttendanceReportFieldDefinitions().length,
    )
    const firstRecord = context.api.multitable.records.createRecord.mock.calls[0]?.[0]
    expect(firstRecord.sheetId).toBe('sheet-1')
    expect(firstRecord.data.fld_field_code).toBe('work_date')
    expect(firstRecord.data.fld_category).toBe('固定字段')
  })

  it('loads the catalog read-only for report usage without provisioning writes', async () => {
    const context = {
      api: {
        multitable: {
          provisioning: {
            ensureObject: vi.fn(),
            findObjectSheet: vi.fn().mockResolvedValue({
              id: 'sheet-1',
              baseId: 'base-1',
              name: '考勤统计字段目录',
              description: null,
            }),
            resolveFieldIds: vi.fn().mockResolvedValue({
              field_code: 'fld_code',
              sort_order: 'fld_sort',
            }),
          },
          records: {
            queryRecords: vi.fn().mockResolvedValue([]),
          },
        },
      },
    }

    const result = await helpers.loadAttendanceReportFieldCatalog(context, 'org-a')

    expect(result.available).toBe(true)
    expect(result.projectId).toBe('org-a:attendance')
    expect(result.sheetId).toBe('sheet-1')
    expect(result.viewId).toMatch(/^view_/)
    expect(context.api.multitable.provisioning.ensureObject).not.toHaveBeenCalled()
  })

  it('merges system fields with multitable configuration and degrades to built-ins', async () => {
    const fieldIds = {
      field_code: 'fld_code',
      field_name: 'fld_name',
      category: 'fld_category',
      source: 'fld_source',
      unit: 'fld_unit',
      enabled: 'fld_enabled',
      report_visible: 'fld_visible',
      sort_order: 'fld_sort',
      dingtalk_field_name: 'fld_dingtalk',
      description: 'fld_description',
      internal_key: 'fld_internal',
      formula_enabled: 'fld_formula_enabled',
      formula_expression: 'fld_formula_expression',
      formula_scope: 'fld_formula_scope',
      formula_output_type: 'fld_formula_output_type',
      formula_source_mode: 'fld_formula_source_mode',
    }
    const merged = helpers.mergeAttendanceReportFieldDefinitions([
      {
        id: 'rec-late-count',
        data: {
          fld_code: 'late_count',
          fld_name: '迟到次数',
          fld_category: '异常统计字段',
          fld_source: 'custom',
          fld_unit: 'count',
          fld_enabled: false,
          fld_visible: true,
          fld_sort: 4100,
          fld_dingtalk: '迟到次数',
          fld_description: '运营侧关闭该字段',
          fld_internal: 'summary.lateCount',
          fld_formula_enabled: false,
          fld_formula_expression: '',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'number',
        },
      },
    ], fieldIds)

    const lateCount = merged.find((field: { code: string }) => field.code === 'late_count')
    expect(lateCount).toMatchObject({
      enabled: false,
      configured: true,
      source: 'custom',
      description: '运营侧关闭该字段',
    })

    const fallback = await helpers.buildAttendanceReportFieldCatalogResponse(
      { api: { multitable: null } },
      'org-z',
      { warn: vi.fn() },
    )
    expect(fallback.multitable.available).toBe(false)
    expect(fallback.multitable.projectId).toBe('org-z:attendance')
    expect(fallback.items.some((field: { code: string }) => field.code === 'employee_name')).toBe(true)
    expect(fallback.reportFieldConfig.formulaDependencyGraph).toMatchObject({
      formulaFieldCount: 0,
      edgeCount: 0,
      hasCycles: false,
    })
  })

  it('reports dropped reserved-code shadow fields', async () => {
    const fieldIds = {
      field_code: 'fld_code',
      field_name: 'fld_name',
      category: 'fld_category',
      source: 'fld_source',
      unit: 'fld_unit',
      enabled: 'fld_enabled',
      report_visible: 'fld_visible',
      sort_order: 'fld_sort',
      dingtalk_field_name: 'fld_dingtalk',
      description: 'fld_description',
      internal_key: 'fld_internal',
      formula_enabled: 'fld_formula_enabled',
      formula_expression: 'fld_formula_expression',
      formula_scope: 'fld_formula_scope',
      formula_output_type: 'fld_formula_output_type',
      formula_source_mode: 'fld_formula_source_mode',
    }
    const records = [
      {
        id: 'rec-shadow-late-minutes',
        data: { fld_code: 'late_minutes', fld_name: '违规公式', fld_category: '异常统计字段', fld_source: 'custom', fld_unit: 'minutes', fld_enabled: true, fld_visible: true, fld_sort: 4002, fld_formula_enabled: true, fld_formula_expression: '={attendance_days}*0', fld_formula_scope: 'record', fld_formula_output_type: 'duration_minutes' },
      },
      {
        id: 'rec-shadow-work-minutes',
        data: { fld_code: 'work_minutes', fld_name: '违规非公式', fld_category: '出勤统计字段', fld_source: 'custom', fld_unit: 'minutes', fld_enabled: true, fld_visible: true, fld_sort: 3501 },
      },
      {
        id: 'rec-ok-custom',
        data: { fld_code: 'ok_custom_metric', fld_name: '正常自定义', fld_category: '出勤统计字段', fld_source: 'custom', fld_unit: 'minutes', fld_enabled: true, fld_visible: true, fld_sort: 3502 },
      },
    ]

    const dropped = helpers.getAttendanceReportFieldDroppedReservedCodes(records, fieldIds)
    expect(dropped).toEqual(['late_minutes', 'work_minutes'])

    const merged = helpers.mergeAttendanceReportFieldDefinitions(records, fieldIds)
    expect(merged.find((field: { code: string }) => field.code === 'late_minutes')).toBeUndefined()
    expect(merged.find((field: { code: string }) => field.code === 'work_minutes')).toBeUndefined()
    expect(merged.find((field: { code: string }) => field.code === 'ok_custom_metric')).toBeTruthy()

    expect(helpers.getAttendanceReportFieldDroppedReservedCodes([], {})).toEqual([])

    const fallback = await helpers.buildAttendanceReportFieldCatalogResponse(
      { api: { multitable: null } },
      'org-z',
      { warn: vi.fn() },
    )
    expect(fallback.droppedReservedCodes).toEqual([])
  })

  it('returns formula dependency graph in catalog response report config', async () => {
    const fieldIds = {
      field_code: 'fld_code',
      field_name: 'fld_name',
      category: 'fld_category',
      source: 'fld_source',
      unit: 'fld_unit',
      enabled: 'fld_enabled',
      report_visible: 'fld_visible',
      sort_order: 'fld_sort',
      dingtalk_field_name: 'fld_dingtalk',
      description: 'fld_description',
      internal_key: 'fld_internal',
      formula_enabled: 'fld_formula_enabled',
      formula_expression: 'fld_formula_expression',
      formula_scope: 'fld_formula_scope',
      formula_output_type: 'fld_formula_output_type',
      formula_source_mode: 'fld_formula_source_mode',
    }
    const context = {
      api: {
        database: null,
        multitable: {
          provisioning: {
            findObjectSheet: vi.fn().mockResolvedValue({ id: 'sheet-1', baseId: 'base-1' }),
            resolveFieldIds: vi.fn().mockResolvedValue(fieldIds),
          },
          records: {
            queryRecords: vi.fn().mockResolvedValue([
              {
                id: 'rec-formula',
                data: {
                  fld_code: 'net_anomaly_minutes',
                  fld_name: '异常净时长',
                  fld_category: '异常统计字段',
                  fld_source: 'custom',
                  fld_unit: 'minutes',
                  fld_enabled: true,
                  fld_visible: true,
                  fld_sort: 4500,
                  fld_formula_enabled: true,
                  fld_formula_expression: '={late_duration}+{early_leave_duration}',
                  fld_formula_scope: 'record',
                  fld_formula_output_type: 'duration_minutes',
                },
              },
            ]),
          },
        },
      },
    }

    const result = await helpers.buildAttendanceReportFieldCatalogResponse(context, 'org-a', { warn: vi.fn() })
    expect(result.reportFieldConfig.formulaDependencyGraph).toMatchObject({
      formulaFieldCount: 1,
      edgeCount: 2,
      blockedFormulaReferenceCount: 0,
      hasCycles: false,
    })
    expect(result.reportFieldConfig.formulaDependencyGraph.edges).toEqual([
      { from: 'net_anomaly_minutes', to: 'early_leave_duration', type: 'field' },
      { from: 'net_anomaly_minutes', to: 'late_duration', type: 'field' },
    ])
  })

  it('applies enabled/reportVisible/sortOrder to record report fields and export values', () => {
    const fields = helpers.resolveAttendanceRecordReportFields([
      {
        code: 'late_duration',
        name: '迟到时长',
        category: 'anomaly',
        categoryLabel: '异常统计字段',
        unit: 'minutes',
        enabled: true,
        reportVisible: true,
        sortOrder: 30,
      },
      {
        code: 'leave_duration',
        name: '请假时长',
        category: 'leave',
        categoryLabel: '请假统计字段',
        unit: 'minutes',
        enabled: true,
        reportVisible: false,
        sortOrder: 20,
      },
      {
        code: 'work_date',
        name: '日期',
        category: 'fixed',
        categoryLabel: '固定字段',
        unit: 'text',
        enabled: true,
        reportVisible: true,
        sortOrder: 10,
      },
    ])
    expect(fields.map((field: { code: string }) => field.code)).toEqual(['work_date', 'late_duration'])

    const row = {
      work_date: '2026-05-13',
      status: 'late',
      late_minutes: 12,
      early_leave_minutes: 0,
      work_minutes: 460,
      is_workday: true,
      meta: {
        leave_minutes: 60,
      },
    }
    expect(helpers.buildAttendanceRecordReportExportItem(row, fields)).toEqual({
      work_date: '2026-05-13',
      late_duration: 12,
    })
    expect(helpers.buildAttendanceRecordReportCsv([
      helpers.buildAttendanceRecordReportExportItem(row, fields),
    ], fields)).toBe('日期,迟到时长\n2026-05-13,12')
    expect(helpers.buildAttendanceRecordReportCsv([
      helpers.buildAttendanceRecordReportExportItem(row, fields),
    ], fields, { headerMode: 'code' })).toBe('work_date,late_duration\n2026-05-13,12')
  })

  it('builds a shared report field config envelope for records and JSON exports', () => {
    const fields = helpers.resolveAttendanceRecordReportFields([
      {
        code: 'work_date',
        name: '日期',
        category: 'fixed',
        categoryLabel: '固定字段',
        unit: 'text',
        enabled: true,
        reportVisible: true,
        sortOrder: 10,
      },
      {
        code: 'late_duration',
        name: '迟到时长',
        category: 'anomaly',
        categoryLabel: '异常统计字段',
        unit: 'minutes',
        enabled: true,
        reportVisible: true,
        sortOrder: 20,
        configured: true,
      },
    ])

    expect(helpers.buildAttendanceReportFieldConfig({
      fields,
      multitable: {
        available: true,
        degraded: false,
        projectId: 'org-a:attendance',
        objectId: 'attendance_report_field_catalog',
        baseId: 'base-1',
        sheetId: 'sheet-1',
        viewId: 'fields_by_category',
      },
    })).toEqual({
      multitable: {
        available: true,
        degraded: false,
        projectId: 'org-a:attendance',
        objectId: 'attendance_report_field_catalog',
        baseId: 'base-1',
        sheetId: 'sheet-1',
        viewId: 'fields_by_category',
      },
      fieldsFingerprint: {
        algorithm: 'sha1',
        value: helpers.buildAttendanceReportFieldConfigFingerprint(fields).value,
        fieldCount: 2,
        codes: ['work_date', 'late_duration'],
      },
      formulaDependencyGraph: {
        formulaFieldCount: 0,
        edgeCount: 0,
        blockedFormulaReferenceCount: 0,
        hasCycles: false,
        nodes: [],
        edges: [],
        blockedFormulaReferences: [],
        cycles: [],
      },
    })

    expect(helpers.buildAttendanceReportFieldConfig(null)).toEqual({
      multitable: {
        available: false,
        degraded: true,
        reason: 'REPORT_FIELD_CONFIG_UNAVAILABLE',
      },
      fieldsFingerprint: {
        algorithm: 'sha1',
        value: helpers.buildAttendanceReportFieldConfigFingerprint([]).value,
        fieldCount: 0,
        codes: [],
      },
      formulaDependencyGraph: {
        formulaFieldCount: 0,
        edgeCount: 0,
        blockedFormulaReferenceCount: 0,
        hasCycles: false,
        nodes: [],
        edges: [],
        blockedFormulaReferences: [],
        cycles: [],
      },
    })

    expect(helpers.buildAttendanceReportFieldConfigHeaders({
      multitable: {
        projectId: 'org-a:attendance',
        objectId: 'attendance_report_field_catalog',
        sheetId: 'sheet-1',
        viewId: 'fields_by_category',
      },
      fieldsFingerprint: {
        algorithm: 'sha1',
        value: 'abc123',
        fieldCount: 2,
        codes: ['work_date', 'late_duration'],
      },
    })).toEqual({
      'X-Attendance-Report-Fields-Fingerprint-Algorithm': 'sha1',
      'X-Attendance-Report-Fields-Fingerprint': 'abc123',
      'X-Attendance-Report-Fields-Count': '2',
      'X-Attendance-Report-Fields-Codes': 'work_date,late_duration',
      'X-Attendance-Report-Fields-Project-Id': 'org-a:attendance',
      'X-Attendance-Report-Fields-Object-Id': 'attendance_report_field_catalog',
      'X-Attendance-Report-Fields-Sheet-Id': 'sheet-1',
      'X-Attendance-Report-Fields-View-Id': 'fields_by_category',
    })
  })

  it('splits DingTalk punch time/result into 12 catalog fields without polluting result slots with day status', () => {
    const defs = helpers.cloneAttendanceReportFieldDefinitions()
    const byCode = new Map(defs.map((field: { code: string }) => [field.code, field]))
    const newCodes = [
      'punch_in_1', 'punch_out_1', 'punch_in_2', 'punch_out_2', 'punch_in_3', 'punch_out_3',
      'punch_result_in_1', 'punch_result_out_1', 'punch_result_in_2', 'punch_result_out_2', 'punch_result_in_3', 'punch_result_out_3',
    ]
    for (const code of newCodes) {
      expect(byCode.has(code)).toBe(true)
    }
    expect(byCode.get('punch_in_1')).toMatchObject({ dingtalkFieldName: '上班1打卡时间', unit: 'dateTime', source: 'system' })
    expect(byCode.get('punch_result_out_3')).toMatchObject({ dingtalkFieldName: '下班3打卡结果', unit: 'text' })
    // aggregate fields retained (additive)
    expect(byCode.has('punch_times')).toBe(true)
    expect(byCode.has('punch_result')).toBe(true)

    const row = {
      work_date: '2026-05-13',
      status: 'late',
      first_in_at: '2026-05-13T09:05:00.000Z',
      last_out_at: '2026-05-13T18:30:00.000Z',
      late_minutes: 5,
      early_leave_minutes: 0,
      work_minutes: 480,
      is_workday: true,
      timezone: 'UTC',
      meta: { clockIn2: '2026-05-13T13:00:00.000Z' },
    }

    // slot-1 carries real first/last punch
    expect(String(helpers.getAttendanceRecordReportFieldValue(row, 'punch_in_1'))).toContain('2026-05-13')
    expect(String(helpers.getAttendanceRecordReportFieldValue(row, 'punch_out_1'))).toContain('2026-05-13')
    // slot-2 reads meta when present
    expect(String(helpers.getAttendanceRecordReportFieldValue(row, 'punch_in_2'))).toContain('2026-05-13')
    // slot-3 + missing meta resolves to empty string, not #ERROR!
    expect(helpers.getAttendanceRecordReportFieldValue(row, 'punch_out_2')).toBe('')
    expect(helpers.getAttendanceRecordReportFieldValue(row, 'punch_in_3')).toBe('')
    expect(helpers.getAttendanceRecordReportFieldValue(row, 'punch_out_3')).toBe('')
    // CRITICAL invariant: punch_result_* must NEVER echo day-level status
    for (const code of ['punch_result_in_1', 'punch_result_out_1', 'punch_result_in_2', 'punch_result_out_2', 'punch_result_in_3', 'punch_result_out_3']) {
      const value = helpers.getAttendanceRecordReportFieldValue(row, code)
      expect(value).toBe('')
      expect(value).not.toBe('late')
    }
    // result reads its own meta key when a future ingest-persist provides it
    expect(helpers.getAttendanceRecordReportFieldValue({ ...row, meta: { punchResultIn1: '正常' } }, 'punch_result_in_1')).toBe('正常')

    // new codes are valid formula sources (registered in ATTENDANCE_RECORD_REPORT_FIELD_CODES)
    const sources = helpers.resolveAttendanceFormulaSourceFields(defs)
    expect(sources.some((field: { code: string }) => field.code === 'punch_in_1')).toBe(true)
    expect(helpers.validateAttendanceReportFormulaExpression('={punch_in_1}', { fields: defs }))
      .toMatchObject({ valid: true, error: null })

    // export carries the new columns with DingTalk display names
    const reportFields = helpers.resolveAttendanceRecordReportFields(defs)
    const item = helpers.buildAttendanceRecordReportExportItem(row, reportFields)
    expect(Object.prototype.hasOwnProperty.call(item, 'punch_in_1')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(item, 'punch_result_out_3')).toBe(true)
    const csv = helpers.buildAttendanceRecordReportCsv([item], reportFields)
    expect(csv.split('\n')[0]).toContain('上班1打卡时间')
    expect(csv.split('\n')[0]).toContain('下班3打卡结果')
  })

  it('persists imported multi-punch values into attendance record meta and clears stale managed punch keys on override', () => {
    const sourceValues: Record<string, unknown> = {
      clockIn2: '13:00',
      '下班2打卡时间': '18:30',
      '3_on_duty_user_check_time': '19:00',
      punchResultIn1: '正常',
      '下班2打卡结果': '早退',
      status: 'late',
    }
    const valueFor = (key: string) => sourceValues[key]
    const punchMeta = helpers.buildAttendanceImportMultiPunchMeta({
      valueFor,
      workDate: '2026-05-13',
      timezone: 'UTC',
      clearMissing: true,
    })

    expect(punchMeta).toMatchObject({
      clockIn2: '2026-05-13T13:00:00.000Z',
      clockOut2: '2026-05-13T18:30:00.000Z',
      clockIn3: '2026-05-13T19:00:00.000Z',
      clockOut3: null,
      punchResultIn1: '正常',
      punchResultOut2: '早退',
      punchResultOut3: null,
    })
    expect(punchMeta.punchResultIn1).not.toBe('late')

    const values = helpers.computeAttendanceRecordUpsertValues({
      existingRow: {
        first_in_at: null,
        last_out_at: null,
        source_batch_id: null,
        meta: {
          clockOut3: '2026-05-13T21:00:00.000Z',
          punchResultOut3: '旧结果',
        },
      },
      updateFirstInAt: null,
      updateLastOutAt: null,
      workDate: '2026-05-13',
      mode: 'override',
      statusOverride: null,
      overrideMetrics: { workMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, status: 'normal' },
      isWorkday: true,
      meta: punchMeta,
      sourceBatchId: '00000000-0000-0000-0000-000000000000',
      rule: {
        timezone: 'UTC',
        workStart: '09:00',
        workEnd: '18:00',
        lateGraceMinutes: 0,
        earlyLeaveGraceMinutes: 0,
      },
      leaveMinutes: 0,
      overtimeMinutes: 0,
    })
    const storedMeta = JSON.parse(values.metaJson)
    expect(storedMeta.clockIn2).toBe('2026-05-13T13:00:00.000Z')
    expect(storedMeta.clockOut3).toBeNull()
    expect(storedMeta.punchResultOut3).toBeNull()

    const row = {
      work_date: '2026-05-13',
      status: 'late',
      timezone: 'UTC',
      first_in_at: '2026-05-13T09:05:00.000Z',
      last_out_at: '2026-05-13T18:00:00.000Z',
      meta: storedMeta,
    }
    expect(String(helpers.getAttendanceRecordReportFieldValue(row, 'punch_in_2'))).toContain('2026-05-13T13:00:00')
    expect(helpers.getAttendanceRecordReportFieldValue(row, 'punch_result_in_1')).toBe('正常')
    expect(helpers.getAttendanceRecordReportFieldValue(row, 'punch_result_out_2')).toBe('早退')
    expect(helpers.getAttendanceRecordReportFieldValue(row, 'punch_result_out_3')).toBe('')
  })

  it('generates dynamic leave/overtime subtype fields with collision-safe stable codes', () => {
    const used = new Set(['leave_type_annual_duration'])
    const leave = helpers.buildAttendanceLeaveSubtypeReportFieldDefinitions([
      { id: 'lt-1', code: 'annual', name: '年假', is_active: true },
      { id: 'lt-2', code: 'sick', name: '病假', is_active: true },
      { id: 'lt-3', code: 'annual-1', name: '年假补', is_active: true },
      { id: 'lt-4', code: 'expired', name: '失效假', is_active: false },
    ], used)
    const leaveCodes = leave.definitions.map((d: { code: string }) => d.code)
    // inactive excluded
    expect(leave.definitions.some((d: { name: string }) => d.name.includes('失效假'))).toBe(false)
    // `annual` collides with pre-seeded used code → deterministic suffix, not dropped
    expect(leaveCodes).toContain('leave_type_sick_duration')
    expect(leaveCodes.some((c: string) => c.startsWith('leave_type_annual_') && c !== 'leave_type_annual_duration')).toBe(true)
    // `annual-1` normalizes to `annual_1` (distinct from `annual`)
    expect(leaveCodes).toContain('leave_type_annual_1_duration')
    // all generated codes match the predicate and are unique
    for (const c of leaveCodes) expect(helpers.isAttendanceLeaveSubtypeCode(c)).toBe(true)
    expect(new Set(leaveCodes).size).toBe(leaveCodes.length)
    expect(leave.leaveTypeCodeToFieldCode.sick).toBe('leave_type_sick_duration')

    const overtime = helpers.buildAttendanceOvertimeSubtypeReportFieldDefinitions([
      { id: 'OT-Rule-A', name: '工作日加班', is_active: true },
      { id: 'ot_rule_b', name: '周末加班', is_active: false },
    ], new Set())
    const otCodes = overtime.definitions.map((d: { code: string }) => d.code)
    expect(otCodes).toEqual(['overtime_rule_otrulea_duration'])
    expect(helpers.isAttendanceOvertimeSubtypeCode(otCodes[0])).toBe(true)
    expect(overtime.overtimeRuleIdToFieldCode['OT-Rule-A']).toBe('overtime_rule_otrulea_duration')

    // generated codes never collide with static report codes or raw alias reserved codes
    const staticDefs = helpers.cloneAttendanceReportFieldDefinitions()
    const staticCodes = new Set(staticDefs.map((d: { code: string }) => d.code))
    for (const c of [...leaveCodes, ...otCodes]) {
      expect(staticCodes.has(c)).toBe(false)
      expect(['work_minutes', 'late_minutes', 'early_leave_minutes', 'leave_minutes', 'overtime_minutes']).not.toContain(c)
    }
  })

  it('dynamic subtype fields: report-field gate, formula source, value resolution, and invariants', async () => {
    const dynamicDefs = [
      { code: 'leave_type_annual_duration', name: '年假时长', category: 'leave', source: 'system', unit: 'minutes', dingtalkFieldName: '年假时长', description: '年假', internalKey: 'requests.leaveType.annual.minutes' },
      { code: 'overtime_rule_ota_duration', name: '工作日加班加班时长', category: 'overtime', source: 'system', unit: 'minutes', dingtalkFieldName: '工作日加班加班时长', description: 'OT', internalKey: 'requests.overtimeRule.ot-a.minutes' },
    ]
    const merged = helpers.mergeAttendanceReportFieldDefinitions([], {}, { extraSystemDefinitions: dynamicDefs })
    const annual = merged.find((f: { code: string }) => f.code === 'leave_type_annual_duration')
    expect(annual).toMatchObject({ systemDefined: true, category: 'leave', enabled: true })

    // gap-1: dynamic subtype enters report output fields
    const reportFields = helpers.resolveAttendanceRecordReportFields(merged)
    expect(reportFields.some((f: { code: string }) => f.code === 'leave_type_annual_duration')).toBe(true)
    expect(reportFields.some((f: { code: string }) => f.code === 'overtime_rule_ota_duration')).toBe(true)

    // formula source via existing systemDefined path (no over-threaded predicate)
    const sources = helpers.resolveAttendanceFormulaSourceFields(merged)
    expect(sources.some((f: { code: string }) => f.code === 'leave_type_annual_duration')).toBe(true)
    expect(helpers.validateAttendanceReportFormulaExpression('={leave_type_annual_duration}+1', { fields: merged }))
      .toMatchObject({ valid: true, error: null })

    // INVARIANT #3: a custom (systemDefined:false) field matching the dynamic pattern is NOT promoted
    const fieldIds = {
      field_code: 'fld_code', field_name: 'fld_name', category: 'fld_category', source: 'fld_source',
      unit: 'fld_unit', enabled: 'fld_enabled', report_visible: 'fld_visible', sort_order: 'fld_sort',
      dingtalk_field_name: 'fld_dingtalk', description: 'fld_description', internal_key: 'fld_internal',
      formula_enabled: 'fld_formula_enabled', formula_expression: 'fld_formula_expression',
      formula_scope: 'fld_formula_scope', formula_output_type: 'fld_formula_output_type',
      formula_source_mode: 'fld_formula_source_mode',
    }
    const mergedWithCustom = helpers.mergeAttendanceReportFieldDefinitions([
      { id: 'rec-x', data: { fld_code: 'leave_type_fake_duration', fld_name: '伪造', fld_category: '请假统计字段', fld_source: 'custom', fld_unit: 'minutes', fld_enabled: true, fld_visible: true, fld_sort: 9000 } },
    ], fieldIds)
    const fake = mergedWithCustom.find((f: { code: string }) => f.code === 'leave_type_fake_duration')
    expect(fake).toMatchObject({ systemDefined: false })
    expect(helpers.resolveAttendanceRecordReportFields(mergedWithCustom).some((f: { code: string }) => f.code === 'leave_type_fake_duration')).toBe(false)
    expect(helpers.resolveAttendanceFormulaSourceFields(mergedWithCustom).some((f: { code: string }) => f.code === 'leave_type_fake_duration')).toBe(false)

    // gap-2: value resolution from meta.reportSubtypeMinutes; missing → 0 (not #ERROR!)
    const row = { work_date: '2026-05-13', status: 'normal', is_workday: true, meta: { reportSubtypeMinutes: { leave_type_annual_duration: 240 } } }
    expect(helpers.getAttendanceRecordReportFieldValue(row, 'leave_type_annual_duration')).toBe(240)
    expect(helpers.getAttendanceRecordReportFieldValue(row, 'overtime_rule_ota_duration')).toBe(0)
    expect(helpers.getAttendanceRecordReportFieldValue({ work_date: '2026-05-13', meta: {} }, 'leave_type_annual_duration')).toBe(0)
  })

  it('loadApprovedMinutesRange aggregates subtypes while keeping aggregate totals unchanged', async () => {
    const calls: string[] = []
    const db = {
      query: async (sql: string) => {
        calls.push(sql)
        if (/FROM attendance_leave_types/.test(sql)) return [{ id: 'lt-1', code: 'annual', name: '年假', is_active: true }]
        if (/FROM attendance_overtime_rules/.test(sql)) return [{ id: 'ot-1', name: '工作日加班', is_active: true }]
        if (/GROUP BY work_date, request_type, subtype_key/.test(sql)) {
          return [
            { work_date: '2026-05-13', request_type: 'leave', subtype_key: 'annual', total_minutes: 240 },
            { work_date: '2026-05-13', request_type: 'leave', subtype_key: null, total_minutes: 60 },
            { work_date: '2026-05-13', request_type: 'overtime', subtype_key: 'ot-1', total_minutes: 120 },
          ]
        }
        // base aggregate query
        return [
          { work_date: '2026-05-13', request_type: 'leave', total_minutes: 300 },
          { work_date: '2026-05-13', request_type: 'overtime', total_minutes: 120 },
        ]
      },
    }
    const map = await helpers.loadApprovedMinutesRange(db, 'default', 'user-1', '2026-05-01', '2026-05-31')
    const entry = map.get('2026-05-13')
    // aggregate totals unchanged (INVARIANT #4): base query value, not the subtype sum
    expect(entry.leaveMinutes).toBe(300)
    expect(entry.overtimeMinutes).toBe(120)
    // subtype map populated; unmatched/null subtype_key NOT added (INVARIANT #2 reconciliation)
    expect(entry.reportSubtypeMinutes.leave_type_annual_duration).toBe(240)
    expect(entry.reportSubtypeMinutes.overtime_rule_ot1_duration).toBe(120)
    // aggregate >= sum(subtypes): leave 300 >= 240 (60 unclassified counts only in aggregate)
    const leaveSubtypeSum = Object.entries(entry.reportSubtypeMinutes)
      .filter(([k]) => k.startsWith('leave_type_'))
      .reduce((acc, [, v]) => acc + (v as number), 0)
    expect(entry.leaveMinutes).toBeGreaterThanOrEqual(leaveSubtypeSum)
  })

  it('attendance_report_records: stable descriptor + idempotent ensure + degraded fallback', async () => {
    const d1 = helpers.getAttendanceReportRecordsDescriptor()
    const d2 = helpers.getAttendanceReportRecordsDescriptor()
    expect(d1.id).toBe('attendance_report_records')
    expect(helpers.ATTENDANCE_REPORT_RECORDS_OBJECT_ID).toBe('attendance_report_records')
    // descriptor stable across calls (same field ids/types/order)
    expect(JSON.stringify(d1)).toBe(JSON.stringify(d2))
    const ids = d1.fields.map((f: { id: string }) => f.id)
    expect(ids).toEqual([
      'row_key', 'org_id', 'user_id', 'employee_name', 'department',
      'attendance_group', 'work_date', 'field_fingerprint', 'source_fingerprint', 'synced_at',
    ])
    // provisioning field-type contract: string/date/dateTime only (no "text")
    const typeByCode = Object.fromEntries(d1.fields.map((f: { id: string, type: string }) => [f.id, f.type]))
    expect(typeByCode.row_key).toBe('string')
    expect(typeByCode.work_date).toBe('date')
    expect(typeByCode.synced_at).toBe('dateTime')
    expect(d1.fields.some((f: { type: string }) => f.type === 'text')).toBe(false)
    expect(d1.fields.find((f: { id: string }) => f.id === 'row_key')?.property?.validation?.required).toBe(true)

    // idempotent ensure: ensureObject called once per ensure, same descriptor each time
    const ensureCalls: unknown[] = []
    const context = {
      api: {
        multitable: {
          provisioning: {
            ensureObject: async (input: unknown) => {
              ensureCalls.push(input)
              return { baseId: 'base_legacy', sheet: { id: 'sheet_report_records' } }
            },
            ensureView: vi.fn().mockResolvedValue({
              id: 'view_report_records',
              sheetId: 'sheet_report_records',
              name: '按日期查看',
              type: 'grid',
            }),
            resolveFieldIds: async ({ fieldIds }: { fieldIds: string[] }) =>
              Object.fromEntries(fieldIds.map(fid => [fid, `fld_${fid}`])),
          },
        },
      },
    }
    const r1 = await helpers.ensureAttendanceReportRecords(context, 'org-a', { warn: vi.fn() })
    const r2 = await helpers.ensureAttendanceReportRecords(context, 'org-a', { warn: vi.fn() })
    expect(r1).toMatchObject({
      available: true,
      reason: null,
      objectId: 'attendance_report_records',
      sheetId: 'sheet_report_records',
      viewId: 'view_report_records',
    })
    expect(r1.fieldIds.row_key).toBe('fld_row_key')
    expect(r1.fieldIds.synced_at).toBe('fld_synced_at')
    expect(helpers.getAttendanceReportRecordsViewDescriptor(r1.fieldIds)).toMatchObject({
      id: helpers.ATTENDANCE_REPORT_RECORDS_VIEW_ID,
      objectId: 'attendance_report_records',
      sortInfo: {
        rules: [
          { fieldId: 'fld_work_date', direction: 'desc' },
          { fieldId: 'fld_user_id', direction: 'asc' },
          { fieldId: 'fld_synced_at', direction: 'desc' },
        ],
      },
    })
    // idempotent: second ensure returns equivalent result, descriptor passed unchanged
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1))
    expect(JSON.stringify((ensureCalls[0] as { descriptor: unknown }).descriptor))
      .toBe(JSON.stringify((ensureCalls[1] as { descriptor: unknown }).descriptor))

    // degraded: provisioning API unavailable → no throw, available:false
    const degraded = await helpers.ensureAttendanceReportRecords({ api: { multitable: null } }, 'org-z', { warn: vi.fn() })
    expect(degraded).toMatchObject({
      available: false,
      reason: 'MULTITABLE_API_UNAVAILABLE',
      objectId: 'attendance_report_records',
      sheetId: null,
    })
    expect(degraded.fieldIds).toEqual({})

    // degraded: ensureObject throws → caught, available:false PROVISIONING_FAILED, no throw
    const throwing = {
      api: { multitable: { provisioning: { ensureObject: async () => { throw new Error('boom') } } } },
    }
    const failed = await helpers.ensureAttendanceReportRecords(throwing, 'org-z', { warn: vi.fn() })
    expect(failed).toMatchObject({ available: false, reason: 'PROVISIONING_FAILED', sheetId: null })
  })

  it('attendance_report_period_summaries (PR1): stable descriptor + ensure + degraded fallback', async () => {
    const d1 = helpers.getAttendanceReportPeriodSummariesDescriptor()
    const d2 = helpers.getAttendanceReportPeriodSummariesDescriptor()
    expect(d1.id).toBe('attendance_report_period_summaries')
    expect(helpers.ATTENDANCE_REPORT_PERIOD_SUMMARIES_OBJECT_ID).toBe('attendance_report_period_summaries')
    // descriptor stable across calls (same field ids/types/order)
    expect(JSON.stringify(d1)).toBe(JSON.stringify(d2))
    const ids = d1.fields.map((f: { id: string }) => f.id)
    expect(ids).toEqual([
      'row_key', 'org_id', 'user_id', 'employee_name', 'department', 'attendance_group',
      'period_type', 'period_key', 'cycle_id', 'period_name', 'period_start', 'period_end',
      'field_fingerprint', 'source_fingerprint', 'synced_at',
    ])
    expect(ids).toEqual(Object.values(helpers.ATTENDANCE_REPORT_PERIOD_SUMMARIES_FIELDS))
    // provisioning field-type contract: only string/date/dateTime/number/boolean
    const allowedTypes = new Set(['string', 'date', 'dateTime', 'number', 'boolean'])
    expect(d1.fields.every((f: { type: string }) => allowedTypes.has(f.type))).toBe(true)
    const typeByCode = Object.fromEntries(d1.fields.map((f: { id: string, type: string }) => [f.id, f.type]))
    expect(typeByCode.row_key).toBe('string')
    expect(typeByCode.period_start).toBe('date')
    expect(typeByCode.period_end).toBe('date')
    expect(typeByCode.synced_at).toBe('dateTime')
    expect(d1.fields.some((f: { type: string }) => f.type === 'text')).toBe(false)
    // row_key required
    expect(d1.fields.find((f: { id: string }) => f.id === 'row_key')?.property?.validation?.required).toBe(true)

    // ensure: ensureObject called with projectId `${orgId}:attendance`, same descriptor each call
    const ensureCalls: unknown[] = []
    const context = {
      api: {
        multitable: {
          provisioning: {
            ensureObject: async (input: unknown) => {
              ensureCalls.push(input)
              return { baseId: 'base_period', sheet: { id: 'sheet_period_summaries' } }
            },
            ensureView: vi.fn().mockResolvedValue({
              id: 'view_period_summaries',
              sheetId: 'sheet_period_summaries',
              name: '按周期查看',
              type: 'grid',
            }),
            resolveFieldIds: async ({ fieldIds }: { fieldIds: string[] }) =>
              Object.fromEntries(fieldIds.map(fid => [fid, `fld_${fid}`])),
          },
        },
      },
    }
    const r1 = await helpers.ensureAttendanceReportPeriodSummaries(context, 'org-a', { warn: vi.fn() })
    const r2 = await helpers.ensureAttendanceReportPeriodSummaries(context, 'org-a', { warn: vi.fn() })
    expect(r1).toMatchObject({
      available: true,
      reason: null,
      projectId: 'org-a:attendance',
      objectId: 'attendance_report_period_summaries',
      sheetId: 'sheet_period_summaries',
      viewId: 'view_period_summaries',
    })
    expect(r1.fieldIds.row_key).toBe('fld_row_key')
    expect(r1.fieldIds.cycle_id).toBe('fld_cycle_id')
    expect(r1.fieldIds.synced_at).toBe('fld_synced_at')
    expect((ensureCalls[0] as { projectId: string }).projectId).toBe('org-a:attendance')
    expect(JSON.stringify((ensureCalls[0] as { descriptor: unknown }).descriptor))
      .toBe(JSON.stringify((ensureCalls[1] as { descriptor: unknown }).descriptor))
    expect(helpers.getAttendanceReportPeriodSummariesViewDescriptor(r1.fieldIds)).toMatchObject({
      id: helpers.ATTENDANCE_REPORT_PERIOD_SUMMARIES_VIEW_ID,
      objectId: 'attendance_report_period_summaries',
      sortInfo: {
        rules: [
          { fieldId: 'fld_period_start', direction: 'desc' },
          { fieldId: 'fld_user_id', direction: 'asc' },
          { fieldId: 'fld_synced_at', direction: 'desc' },
        ],
      },
    })
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1))

    // degraded: provisioning API unavailable → no throw, available:false
    const degraded = await helpers.ensureAttendanceReportPeriodSummaries({ api: { multitable: null } }, 'org-z', { warn: vi.fn() })
    expect(degraded).toMatchObject({
      available: false,
      reason: 'MULTITABLE_API_UNAVAILABLE',
      objectId: 'attendance_report_period_summaries',
      sheetId: null,
    })
    expect(degraded.fieldIds).toEqual({})

    // degraded: ensureObject throws → caught, available:false PROVISIONING_FAILED, no throw
    const throwing = {
      api: { multitable: { provisioning: { ensureObject: async () => { throw new Error('boom') } } } },
    }
    const failed = await helpers.ensureAttendanceReportPeriodSummaries(throwing, 'org-z', { warn: vi.fn() })
    expect(failed).toMatchObject({ available: false, reason: 'PROVISIONING_FAILED', sheetId: null })

    // ensureView failure does NOT block ensureObject success (inner try/catch → available:true, viewId:null)
    const viewFailing = {
      api: {
        multitable: {
          provisioning: {
            ensureObject: async () => ({ baseId: 'base_period', sheet: { id: 'sheet_period_summaries' } }),
            ensureView: async () => { throw new Error('view boom') },
            resolveFieldIds: async ({ fieldIds }: { fieldIds: string[] }) =>
              Object.fromEntries(fieldIds.map(fid => [fid, `fld_${fid}`])),
          },
        },
      },
    }
    const viewFailed = await helpers.ensureAttendanceReportPeriodSummaries(viewFailing, 'org-a', { warn: vi.fn() })
    expect(viewFailed).toMatchObject({
      available: true,
      reason: null,
      objectId: 'attendance_report_period_summaries',
      sheetId: 'sheet_period_summaries',
      viewId: null,
    })
    expect(viewFailed.fieldIds.row_key).toBe('fld_row_key')
  })

  it('report-records sync: pure helpers (type map / value columns / row key / source fingerprint)', () => {
    expect(helpers.mapReportFieldToMultitableType({ unit: 'minutes' })).toBe('number')
    expect(helpers.mapReportFieldToMultitableType({ unit: 'count' })).toBe('number')
    expect(helpers.mapReportFieldToMultitableType({ unit: 'text' })).toBe('string')
    expect(helpers.mapReportFieldToMultitableType({ unit: 'dateTime' })).toBe('dateTime')
    expect(helpers.mapReportFieldToMultitableType({ formulaEnabled: true, formulaOutputType: 'duration_minutes' })).toBe('number')
    expect(helpers.mapReportFieldToMultitableType({ formulaEnabled: true, formulaOutputType: 'boolean' })).toBe('boolean')
    expect(helpers.mapReportFieldToMultitableType({ formulaEnabled: true, formulaOutputType: 'date' })).toBe('date')

    expect(helpers.attendanceReportRecordRowKey('org-1', 'u-1', '2026-05-13')).toBe('org-1:u-1:2026-05-13')

    const cols = helpers.buildAttendanceReportRecordsValueColumns([
      { code: 'work_date', name: '工作日期', unit: 'dateTime' }, // fixed skeleton id → excluded
      { code: 'employee_name', name: '姓名', unit: 'text' }, // skeleton → excluded
      { code: 'department', name: '部门', unit: 'text' }, // skeleton → excluded
      { code: 'attendance_group', name: '考勤组', unit: 'text' }, // skeleton → excluded
      { code: 'work_duration', name: '工作时长', unit: 'minutes' },
      { code: 'late_minutes', name: '迟到分钟(reserved)', unit: 'minutes' }, // raw alias reserved → skipped
      { code: 'leave_type_annual_duration', name: '年假时长', unit: 'minutes' },
    ])
    expect(cols.map((c: { id: string }) => c.id)).toEqual(['work_duration', 'leave_type_annual_duration'])
    expect(cols.every((c: { type: string }) => c.type === 'number')).toBe(true)
    // deterministic order preserved (sortOrder upstream → index here), reserved excluded
    expect(cols.find((c: { id: string }) => c.id === 'late_minutes')).toBeUndefined()
    // Fix-1 regression: value columns have ZERO intersection with the fixed skeleton ids
    const skeletonIds = new Set(Object.values(helpers.ATTENDANCE_REPORT_RECORDS_FIELDS) as string[])
    expect(cols.some((c: { id: string }) => skeletonIds.has(c.id))).toBe(false)
    // composing [skeleton, ...valueColumns] for ensureObject: work_date appears ONCE, type stays 'date'
    const composed = [...helpers.getAttendanceReportRecordsDescriptor().fields, ...cols]
    const workDateFields = composed.filter((f: { id: string }) => f.id === 'work_date')
    expect(workDateFields).toHaveLength(1)
    expect(workDateFields[0].type).toBe('date')
    for (const sk of ['employee_name', 'department', 'attendance_group']) {
      expect(composed.filter((f: { id: string }) => f.id === sk)).toHaveLength(1)
    }

    // source fingerprint: excludes synced_at + both fingerprints, key-sorted (order-independent)
    const a = helpers.buildAttendanceReportRecordSourceFingerprint({ b: 2, a: 1, synced_at: 'X', source_fingerprint: 'S', field_fingerprint: 'F' })
    const b = helpers.buildAttendanceReportRecordSourceFingerprint({ a: 1, b: 2, synced_at: 'Y', source_fingerprint: 'Z', field_fingerprint: 'Q' })
    expect(a).toBe(b) // synced_at + fingerprints excluded, key order irrelevant
    const c = helpers.buildAttendanceReportRecordSourceFingerprint({ a: 1, b: 3 })
    expect(c).not.toBe(a) // payload value change → different fingerprint
  })

  it('report-records sync: upsert / skip / duplicate / degraded / export decoupling', async () => {
    // degraded: no multitable provisioning → {degraded:true}, no throw
    const degraded = await helpers.syncAttendanceReportRecords(
      { api: { multitable: null, database: { query: async () => [] } } },
      { query: async () => [] },
      'org-1',
      { warn: vi.fn() },
      { from: '2026-05-01', to: '2026-05-31', userId: 'u-1' },
    )
    expect(degraded).toMatchObject({ degraded: true, synced: 0, created: 0, patched: 0 })

    // export decoupling: a degraded sync must not break the independent export builder
    const exportFields = helpers.resolveAttendanceRecordReportFields(
      helpers.mergeAttendanceReportFieldDefinitions([], {}),
    )
    const exportRow = { work_date: '2026-05-13', status: 'normal', is_workday: true, meta: {}, work_minutes: 480 }
    expect(() => helpers.buildAttendanceRecordReportExportItem(exportRow, exportFields)).not.toThrow()

    // store-backed records mock (Map by physical row_key value) for upsert/skip/duplicate
    const store: Array<{ id: string; data: Record<string, unknown> }> = []
    let seq = 0
    const rowKeyFid = 'fld_row_key'
    const records = {
      queryRecords: async ({ filters }: { filters?: Record<string, unknown> }) => {
        const want = filters?.[rowKeyFid]
        return store.filter(r => r.data[rowKeyFid] === want)
      },
      createRecord: async ({ data }: { data: Record<string, unknown> }) => {
        const rec = { id: `rec-${++seq}`, data: { ...data } }
        store.push(rec)
        return rec
      },
      patchRecord: async ({ recordId, changes }: { recordId: string; changes: Record<string, unknown> }) => {
        const rec = store.find(r => r.id === recordId)
        if (rec) rec.data = { ...rec.data, ...changes }
        return rec
      },
    }
    const ensureObjectDescriptors: Array<{ fields: Array<{ id: string; type: string }> }> = []
    const provisioning = {
      ensureObject: async (input: { descriptor?: { fields?: Array<{ id: string; type: string }> } }) => {
        if (input?.descriptor?.fields) ensureObjectDescriptors.push({ fields: input.descriptor.fields })
        return { baseId: 'base_legacy', sheet: { id: 'sheet_rr' } }
      },
      resolveFieldIds: async ({ fieldIds }: { fieldIds: string[] }) =>
        Object.fromEntries(fieldIds.map(f => [f, `fld_${f}`])),
      // NO findObjectSheet → catalog falls back to deterministic built-in field set
    }
    const attendanceRows = [
      { user_id: 'u-1', org_id: 'org-1', work_date: '2026-05-13', timezone: 'UTC', first_in_at: '2026-05-13T09:00:00Z', last_out_at: '2026-05-13T18:00:00Z', work_minutes: 480, late_minutes: 0, early_leave_minutes: 0, status: 'normal', is_workday: true, meta: {}, user_name: '张三', username: 'zhangsan' },
      { user_id: 'u-1', org_id: 'org-1', work_date: '2026-05-14', timezone: 'UTC', first_in_at: '2026-05-14T09:10:00Z', last_out_at: '2026-05-14T18:00:00Z', work_minutes: 470, late_minutes: 10, early_leave_minutes: 0, status: 'late', is_workday: true, meta: {}, user_name: '张三', username: 'zhangsan' },
    ]
    const db = {
      query: async (sql: string) => {
        if (/FROM attendance_records ar/.test(sql)) return attendanceRows
        return [] // system_configs / leave_types / overtime_rules / approved → empty (tolerated)
      },
    }
    const context = { api: { multitable: { provisioning, records }, database: db } }

    // sync #1 → all created
    const r1 = await helpers.syncAttendanceReportRecords(context, db, 'org-1', { warn: vi.fn() }, { from: '2026-05-01', to: '2026-05-31', userId: 'u-1' })
    expect(r1).toMatchObject({ synced: 2, created: 2, patched: 0, skipped: 0, failed: 0, duplicateRowKeys: 0 })
    expect(r1.multitable).toMatchObject({
      available: true,
      objectId: 'attendance_report_records',
      sheetId: 'sheet_rr',
    })
    expect(store.length).toBe(2)
    // Fix-1 integration: the descriptor handed to ensureObject (value-columns ensure) must
    // carry work_date exactly once and still as type 'date' (no string overwrite collision)
    const valueEnsure = ensureObjectDescriptors[ensureObjectDescriptors.length - 1]
    const wd = valueEnsure.fields.filter(f => f.id === 'work_date')
    expect(wd).toHaveLength(1)
    expect(wd[0].type).toBe('date')
    for (const sk of ['employee_name', 'department', 'attendance_group', 'row_key']) {
      expect(valueEnsure.fields.filter(f => f.id === sk)).toHaveLength(1)
    }
    expect(store[0].data[rowKeyFid]).toBe('org-1:u-1:2026-05-13')
    expect(typeof store[0].data['fld_field_fingerprint']).toBe('string')
    expect(typeof store[0].data['fld_source_fingerprint']).toBe('string')

    // sync #2 same data → all skipped (source+field fingerprint 双等)
    const r2 = await helpers.syncAttendanceReportRecords(context, db, 'org-1', { warn: vi.fn() }, { from: '2026-05-01', to: '2026-05-31', userId: 'u-1' })
    expect(r2).toMatchObject({ synced: 2, created: 0, skipped: 2, patched: 0 })
    expect(store.length).toBe(2)

    // skip-boundary: source unchanged but field_fingerprint stale → must patch, not skip
    store[0].data['fld_field_fingerprint'] = 'STALE-FIELD-FP'
    const r3 = await helpers.syncAttendanceReportRecords(context, db, 'org-1', { warn: vi.fn() }, { from: '2026-05-01', to: '2026-05-31', userId: 'u-1' })
    expect(r3.patched).toBe(1)
    expect(r3.skipped).toBe(1)
    expect(store[0].data['fld_field_fingerprint']).not.toBe('STALE-FIELD-FP') // rewritten

    // duplicate row_key fuse: inject a 2nd record same row_key → patch first, count duplicate
    store.push({ id: 'rec-dup', data: { ...store[0].data } })
    const r4 = await helpers.syncAttendanceReportRecords(context, db, 'org-1', { warn: vi.fn() }, { from: '2026-05-01', to: '2026-05-31', userId: 'u-1' })
    expect(r4.duplicateRowKeys).toBeGreaterThanOrEqual(1)
    expect(store.filter(r => r.data[rowKeyFid] === 'org-1:u-1:2026-05-13').length).toBe(2) // not auto-deleted (v1)
  })

  it('report-records sync: bulk explicit users dedupe and aggregate per-user results', async () => {
    expect(helpers.normalizeAttendanceReportRecordsSyncUserIds(['u-1', ' u-1 ', '', null, 'u-2']))
      .toEqual(['u-1', 'u-2'])
    expect(helpers.normalizeAttendanceReportRecordsSyncPage('2', '500'))
      .toMatchObject({ page: 2, pageSize: 100, offset: 100 })

    const store: Array<{ id: string; data: Record<string, unknown> }> = []
    let seq = 0
    const rowKeyFid = 'fld_row_key'
    const records = {
      queryRecords: async ({ filters }: { filters?: Record<string, unknown> }) => {
        const want = filters?.[rowKeyFid]
        return store.filter(r => r.data[rowKeyFid] === want)
      },
      createRecord: async ({ data }: { data: Record<string, unknown> }) => {
        const rec = { id: `rec-${++seq}`, data: { ...data } }
        store.push(rec)
        return rec
      },
      patchRecord: async ({ recordId, changes }: { recordId: string; changes: Record<string, unknown> }) => {
        const rec = store.find(r => r.id === recordId)
        if (rec) rec.data = { ...rec.data, ...changes }
        return rec
      },
    }
    const provisioning = {
      ensureObject: async () => ({ baseId: 'base_rr', sheet: { id: 'sheet_rr' } }),
      ensureView: async () => ({ id: 'view_rr', sheetId: 'sheet_rr' }),
      resolveFieldIds: async ({ fieldIds }: { fieldIds: string[] }) =>
        Object.fromEntries(fieldIds.map(fieldId => [fieldId, `fld_${fieldId}`])),
    }
    const rowsByUser: Record<string, Array<Record<string, unknown>>> = {
      'u-1': [
        { user_id: 'u-1', org_id: 'org-1', work_date: '2026-05-13', timezone: 'UTC', first_in_at: '2026-05-13T09:00:00Z', last_out_at: '2026-05-13T18:00:00Z', work_minutes: 480, late_minutes: 0, early_leave_minutes: 0, status: 'normal', is_workday: true, meta: {}, user_name: '张三', username: 'zhangsan' },
        { user_id: 'u-1', org_id: 'org-1', work_date: '2026-05-14', timezone: 'UTC', first_in_at: '2026-05-14T09:10:00Z', last_out_at: '2026-05-14T18:00:00Z', work_minutes: 470, late_minutes: 10, early_leave_minutes: 0, status: 'late', is_workday: true, meta: {}, user_name: '张三', username: 'zhangsan' },
      ],
      'u-2': [
        { user_id: 'u-2', org_id: 'org-1', work_date: '2026-05-13', timezone: 'UTC', first_in_at: '2026-05-13T09:00:00Z', last_out_at: '2026-05-13T18:00:00Z', work_minutes: 480, late_minutes: 0, early_leave_minutes: 0, status: 'normal', is_workday: true, meta: {}, user_name: '李四', username: 'lisi' },
      ],
    }
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (/FROM attendance_records ar/.test(sql)) return rowsByUser[String(params?.[0])] ?? []
        return []
      },
    }
    const context = { api: { multitable: { provisioning, records }, database: db } }

    const result = await helpers.syncAttendanceReportRecordsForUsers(
      context,
      db,
      'org-1',
      { warn: vi.fn() },
      { from: '2026-05-01', to: '2026-05-31', userIds: ['u-1', ' u-1 ', 'u-2', ''] },
    )
    expect(result).toMatchObject({
      userSelection: 'explicit',
      totalUsers: 2,
      usersScanned: 2,
      usersSynced: 2,
      usersFailed: 0,
      synced: 3,
      rowsSynced: 3,
      created: 3,
      patched: 0,
      skipped: 0,
      failed: 0,
      hasNextPage: false,
    })
    expect(store).toHaveLength(3)
    expect(store.map(row => row.data[rowKeyFid])).toEqual([
      'org-1:u-1:2026-05-13',
      'org-1:u-1:2026-05-14',
      'org-1:u-2:2026-05-13',
    ])

    const second = await helpers.syncAttendanceReportRecordsForUsers(
      context,
      db,
      'org-1',
      { warn: vi.fn() },
      { from: '2026-05-01', to: '2026-05-31', userIds: ['u-1', 'u-2'] },
    )
    expect(second).toMatchObject({ synced: 3, created: 0, patched: 0, skipped: 3, usersScanned: 2 })
  })

  it('report-records sync: all-user pages prefer active org users and fall back to record owners', async () => {
    const primaryDb = {
      query: async (sql: string) => {
        if (/COUNT\(\*\)::int AS total\s+FROM user_orgs/s.test(sql)) return [{ total: 5 }]
        if (/SELECT uo\.user_id\s+FROM user_orgs/s.test(sql)) return [{ user_id: 'u-3' }, { user_id: 'u-4' }]
        return []
      },
    }
    const page = await helpers.loadAttendanceReportRecordsSyncUserPage(
      primaryDb,
      'org-1',
      '2026-05-01',
      '2026-05-31',
      { page: 2, pageSize: 2 },
    )
    expect(page).toEqual({
      userIds: ['u-3', 'u-4'],
      totalUsers: 5,
      page: 2,
      pageSize: 2,
      hasNextPage: true,
      userSelection: 'allUsers',
    })

    const fallbackDb = {
      query: async (sql: string) => {
        if (/FROM user_orgs/.test(sql)) {
          const error = new Error('relation "user_orgs" does not exist') as Error & { code: string }
          error.code = '42P01'
          throw error
        }
        if (/users_with_records/.test(sql)) return [{ total: 1 }]
        if (/SELECT DISTINCT user_id/.test(sql)) return [{ user_id: 'u-record' }]
        return []
      },
    }
    const fallback = await helpers.loadAttendanceReportRecordsSyncUserPage(
      fallbackDb,
      'org-1',
      '2026-05-01',
      '2026-05-31',
      { page: 1, pageSize: 50 },
    )
    expect(fallback).toMatchObject({
      userIds: ['u-record'],
      totalUsers: 1,
      hasNextPage: false,
      userSelection: 'attendanceRecordsFallback',
    })
  })

  it('report-records sync: disabled managed value columns are patched to null', async () => {
    const catalogFieldIds = Object.fromEntries(
      Object.values(helpers.ATTENDANCE_REPORT_FIELD_CATALOG_FIELDS).map((fieldId) => [fieldId, `fld_${fieldId}`]),
    )
    const disabledLateDurationRecord = {
      id: 'cfg-late-duration',
      data: {
        fld_field_code: 'late_duration',
        fld_field_name: '迟到时长',
        fld_category: '异常统计字段',
        fld_source: 'system',
        fld_unit: 'minutes',
        fld_enabled: false,
        fld_report_visible: true,
        fld_sort_order: 4010,
        fld_dingtalk_field_name: '迟到时长',
        fld_description: '已停用字段应该清空报表记录旧值',
        fld_internal_key: 'summary.lateMinutes',
        fld_formula_enabled: false,
        fld_formula_expression: '',
        fld_formula_scope: 'record',
        fld_formula_output_type: 'duration_minutes',
      },
    }

    const store = [{
      id: 'rec-existing',
      data: {
        fld_row_key: 'org-1:u-1:2026-05-13',
        fld_field_fingerprint: 'STALE-FIELD',
        fld_source_fingerprint: 'STALE-SOURCE',
        fld_late_duration: 12,
      },
    }]
    const records = {
      queryRecords: async ({ sheetId, filters }: { sheetId: string; filters?: Record<string, unknown> }) => {
        if (sheetId === 'sheet_catalog') return [disabledLateDurationRecord]
        const want = filters?.fld_row_key
        return store.filter(r => r.data.fld_row_key === want)
      },
      createRecord: vi.fn(),
      patchRecord: vi.fn(async ({ recordId, changes }: { recordId: string; changes: Record<string, unknown> }) => {
        const rec = store.find(r => r.id === recordId)
        if (rec) rec.data = { ...rec.data, ...changes }
        return rec
      }),
    }
    const provisioning = {
      ensureObject: async () => ({ baseId: 'base_rr', sheet: { id: 'sheet_rr' } }),
      ensureView: async () => ({ id: 'view_rr', sheetId: 'sheet_rr' }),
      findObjectSheet: async ({ objectId }: { objectId: string }) => (
        objectId === 'attendance_report_field_catalog'
          ? { id: 'sheet_catalog', baseId: 'base_catalog' }
          : null
      ),
      resolveFieldIds: async ({ objectId, fieldIds }: { objectId: string; fieldIds: string[] }) => (
        objectId === 'attendance_report_field_catalog'
          ? Object.fromEntries(fieldIds.map(fieldId => [fieldId, catalogFieldIds[fieldId] || `fld_${fieldId}`]))
          : Object.fromEntries(fieldIds.map(fieldId => [fieldId, `fld_${fieldId}`]))
      ),
    }
    const attendanceRows = [
      { user_id: 'u-1', org_id: 'org-1', work_date: '2026-05-13', timezone: 'UTC', first_in_at: '2026-05-13T09:00:00Z', last_out_at: '2026-05-13T18:00:00Z', work_minutes: 480, late_minutes: 12, early_leave_minutes: 0, status: 'late', is_workday: true, meta: {}, user_name: '张三', username: 'zhangsan' },
    ]
    const db = {
      query: async (sql: string) => {
        if (/FROM attendance_records ar/.test(sql)) return attendanceRows
        return []
      },
    }
    const context = { api: { multitable: { provisioning, records }, database: db } }

    const result = await helpers.syncAttendanceReportRecords(
      context,
      db,
      'org-1',
      { warn: vi.fn() },
      { from: '2026-05-01', to: '2026-05-31', userId: 'u-1' },
    )

    expect(result).toMatchObject({ synced: 1, patched: 1, created: 0, skipped: 0, failed: 0 })
    expect(records.createRecord).not.toHaveBeenCalled()
    expect(records.patchRecord).toHaveBeenCalledTimes(1)
    const patch = records.patchRecord.mock.calls[0]?.[0]
    expect(patch.changes.fld_late_duration).toBeNull()
    expect(store[0].data.fld_late_duration).toBeNull()
    expect(store[0].data.fld_field_fingerprint).not.toBe('STALE-FIELD')
    expect(store[0].data.fld_source_fingerprint).not.toBe('STALE-SOURCE')
  })

  it('period-summary sync: pure helpers and period resolver stay deterministic', async () => {
    const managedFormulas = helpers.resolveAttendanceReportPeriodSummaryManagedFormulaFields([
      {
        code: 'period_efficiency',
        name: '周期效率',
        unit: 'number',
        sortOrder: 30,
        enabled: true,
        reportVisible: true,
        formulaEnabled: true,
        formulaExpression: '={total_minutes}/{total_days}',
        formulaScope: 'summary',
        formulaOutputType: 'number',
      },
      {
        code: 'disabled_period_score',
        name: '停用周期分',
        unit: 'number',
        sortOrder: 20,
        enabled: false,
        reportVisible: true,
        formulaEnabled: true,
        formulaExpression: '={total_minutes}',
        formulaScope: 'summary',
        formulaOutputType: 'number',
      },
      {
        code: 'record_formula_ignored',
        formulaEnabled: true,
        formulaScope: 'record',
      },
    ])
    expect(managedFormulas.map((field: { code: string }) => field.code)).toEqual([
      'disabled_period_score',
      'period_efficiency',
    ])

    const valueFields = helpers.buildAttendanceReportPeriodSummaryValueFields(managedFormulas, [
      { code: 'leave_type_annual_duration', name: '年假时长', unit: 'minutes', sortOrder: 10 },
    ])
    const columns = helpers.buildAttendanceReportPeriodSummaryValueColumns(valueFields)
    expect(columns.map((column: { id: string }) => column.id)).toContain('total_minutes')
    expect(columns.map((column: { id: string }) => column.id)).toContain('disabled_period_score')
    expect(columns.map((column: { id: string }) => column.id)).toContain('leave_type_annual_duration')
    expect(columns.every((column: { type: string }) => ['number', 'string'].includes(column.type))).toBe(true)
    const skeletonIds = new Set(Object.values(helpers.ATTENDANCE_REPORT_PERIOD_SUMMARIES_FIELDS) as string[])
    expect(columns.some((column: { id: string }) => skeletonIds.has(column.id))).toBe(false)

    const activeCodes = helpers.buildAttendanceReportPeriodSummaryActiveValueCodes(
      managedFormulas.filter((field: { enabled?: boolean }) => field.enabled !== false),
      [{ code: 'leave_type_annual_duration' }],
    )
    expect(activeCodes.has('total_minutes')).toBe(true)
    expect(activeCodes.has('period_efficiency')).toBe(true)
    expect(activeCodes.has('disabled_period_score')).toBe(false)

    expect(helpers.attendanceReportPeriodSummaryRowKey('org-1', 'u-1', {
      periodType: 'date_range',
      from: '2026-05-01',
      to: '2026-05-31',
    })).toBe('org-1:u-1:range:2026-05-01:2026-05-31')
    expect(helpers.attendanceReportPeriodSummaryRowKey('org-1', 'u-1', {
      periodType: 'payroll_cycle',
      cycleId: '11111111-1111-4111-8111-111111111111',
      from: '2026-05-01',
      to: '2026-05-31',
    })).toBe('org-1:u-1:cycle:11111111-1111-4111-8111-111111111111')

    const fpA = helpers.buildAttendanceReportPeriodSummarySourceFingerprint({
      b: 2,
      a: 1,
      synced_at: 'A',
      source_fingerprint: 'B',
      field_fingerprint: 'C',
    })
    const fpB = helpers.buildAttendanceReportPeriodSummarySourceFingerprint({
      field_fingerprint: 'X',
      source_fingerprint: 'Y',
      synced_at: 'Z',
      a: 1,
      b: 2,
    })
    expect(fpA).toBe(fpB)
    expect(helpers.buildAttendanceReportPeriodSummarySourceFingerprint({ a: 1, b: 3 })).not.toBe(fpA)

    const subtypeTotals = helpers.buildAttendancePeriodSummarySubtypeTotals(new Map([
      ['2026-05-01', { reportSubtypeMinutes: { leave_type_annual_duration: 60 } }],
      ['2026-05-02', { reportSubtypeMinutes: { leave_type_annual_duration: 30, overtime_rule_r1_duration: 45 } }],
    ]))
    expect(subtypeTotals).toEqual({
      leave_type_annual_duration: 90,
      overtime_rule_r1_duration: 45,
    })

    const cycleId = '11111111-1111-4111-8111-111111111111'
    const db = {
      query: vi.fn(async (_sql: string, params?: unknown[]) => (
        params?.[0] === cycleId
          ? [{
              id: cycleId,
              org_id: 'org-1',
              name: '2026-05 薪资周期',
              start_date: '2026-05-01',
              end_date: '2026-05-31',
              status: 'open',
            }]
          : []
      )),
    }
    expect(await helpers.resolveAttendanceReportPeriodSyncPeriod(db, 'org-1', { cycleId, from: '2026-05-01', to: '2026-05-31' }))
      .toMatchObject({ ok: false, status: 400 })
    expect(await helpers.resolveAttendanceReportPeriodSyncPeriod(db, 'org-1', {}))
      .toMatchObject({ ok: false, status: 400 })
    expect(await helpers.resolveAttendanceReportPeriodSyncPeriod(db, 'org-1', { from: '2026-05-01' }))
      .toMatchObject({ ok: false, status: 400 })
    expect(await helpers.resolveAttendanceReportPeriodSyncPeriod(db, 'org-1', { cycleId: 'not-a-uuid' }))
      .toMatchObject({ ok: false, status: 400 })
    expect(await helpers.resolveAttendanceReportPeriodSyncPeriod(db, 'org-1', { cycleId: '22222222-2222-4222-8222-222222222222' }))
      .toMatchObject({ ok: false, status: 404 })
    const cycle = await helpers.resolveAttendanceReportPeriodSyncPeriod(db, 'org-1', { cycleId })
    expect(cycle).toMatchObject({
      ok: true,
      period: {
        periodType: 'payroll_cycle',
        periodKey: `cycle:${cycleId}`,
        cycleId,
        from: '2026-05-01',
        to: '2026-05-31',
      },
    })
    const range = await helpers.resolveAttendanceReportPeriodSyncPeriod(db, 'org-1', {
      from: '2026-05-01',
      to: '2026-05-31',
    })
    expect(range).toMatchObject({
      ok: true,
      period: {
        periodType: 'date_range',
        periodKey: 'range:2026-05-01:2026-05-31',
      },
    })
  })

  it('period-summary sync: upsert / skip / duplicate / subtype values / stale formula null', async () => {
    const catalogFieldIds = Object.fromEntries(
      Object.values(helpers.ATTENDANCE_REPORT_FIELD_CATALOG_FIELDS).map((fieldId) => [fieldId, `fld_${fieldId}`]),
    )
    const disabledSummaryFormulaRecord = {
      id: 'cfg-disabled-period-score',
      data: {
        fld_field_code: 'period_score',
        fld_field_name: '周期得分',
        fld_category: '出勤统计字段',
        fld_source: 'custom',
        fld_unit: 'number',
        fld_enabled: false,
        fld_report_visible: true,
        fld_sort_order: 9500,
        fld_dingtalk_field_name: '周期得分',
        fld_description: '停用周期公式字段应清空旧值',
        fld_internal_key: 'formula.period_score',
        fld_formula_enabled: true,
        fld_formula_expression: '={total_minutes}',
        fld_formula_scope: 'summary',
        fld_formula_output_type: 'number',
      },
    }
    const store: Array<{ id: string; data: Record<string, unknown> }> = []
    let seq = 0
    const records = {
      queryRecords: vi.fn(async ({ sheetId, filters }: { sheetId: string; filters?: Record<string, unknown> }) => {
        if (sheetId === 'sheet_catalog') return [disabledSummaryFormulaRecord]
        const want = filters?.fld_row_key
        return store.filter(record => record.data.fld_row_key === want)
      }),
      createRecord: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const record = { id: `rec-${++seq}`, data: { ...data } }
        store.push(record)
        return record
      }),
      patchRecord: vi.fn(async ({ recordId, changes }: { recordId: string; changes: Record<string, unknown> }) => {
        const record = store.find(item => item.id === recordId)
        if (record) record.data = { ...record.data, ...changes }
        return record
      }),
    }
    const ensureObjectDescriptors: Array<{ fields: Array<{ id: string; type: string }> }> = []
    const provisioning = {
      ensureObject: vi.fn(async (input: { descriptor?: { fields?: Array<{ id: string; type: string }> } }) => {
        if (input?.descriptor?.fields) ensureObjectDescriptors.push({ fields: input.descriptor.fields })
        return { baseId: 'base_period', sheet: { id: 'sheet_period' } }
      }),
      ensureView: vi.fn(async () => ({ id: 'view_period', sheetId: 'sheet_period' })),
      findObjectSheet: vi.fn(async ({ objectId }: { objectId: string }) => (
        objectId === 'attendance_report_field_catalog'
          ? { id: 'sheet_catalog', baseId: 'base_catalog' }
          : null
      )),
      resolveFieldIds: vi.fn(async ({ objectId, fieldIds }: { objectId: string; fieldIds: string[] }) => (
        objectId === 'attendance_report_field_catalog'
          ? Object.fromEntries(fieldIds.map(fieldId => [fieldId, catalogFieldIds[fieldId] || `fld_${fieldId}`]))
          : Object.fromEntries(fieldIds.map(fieldId => [fieldId, `fld_${fieldId}`]))
      )),
    }
    const db = {
      query: vi.fn(async (sql: string) => {
        if (/FROM attendance_leave_types/.test(sql)) {
          return [{ id: 'leave-annual', code: 'annual', name: '年假', is_active: true }]
        }
        if (/FROM attendance_overtime_rules/.test(sql)) return []
        if (/SELECT\s+COALESCE\(SUM\(CASE WHEN is_workday THEN 1 ELSE 0 END\)/.test(sql)) {
          return [{
            total_days: 2,
            total_minutes: 960,
            total_late_minutes: 10,
            total_early_leave_minutes: 5,
            normal_days: 1,
            late_days: 1,
            early_leave_days: 0,
            late_early_days: 0,
            partial_days: 0,
            absent_days: 0,
            adjusted_days: 0,
            off_days: 0,
          }]
        }
        if (/SELECT request_type,\s+COALESCE\(SUM/.test(sql) && /GROUP BY request_type/.test(sql)) {
          return [{ request_type: 'leave', total_minutes: 240 }]
        }
        if (/metadata->'leaveType'->>'code'/.test(sql)) {
          return [{ work_date: '2026-05-02', request_type: 'leave', subtype_key: 'annual', total_minutes: 240 }]
        }
        if (/SELECT work_date,\s+request_type/.test(sql) && /GROUP BY work_date, request_type/.test(sql)) {
          return [{ work_date: '2026-05-02', request_type: 'leave', total_minutes: 240 }]
        }
        if (/FROM users u/.test(sql)) {
          return [{
            user_name: '张三',
            username: 'zhangsan',
            meta: { department: '研发', attendanceGroup: '默认考勤组' },
          }]
        }
        return []
      }),
    }
    const context = { api: { multitable: { provisioning, records }, database: db } }
    const period = {
      periodType: 'date_range',
      periodKey: 'range:2026-05-01:2026-05-31',
      cycleId: null,
      periodName: '2026-05-01..2026-05-31',
      from: '2026-05-01',
      to: '2026-05-31',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
    }

    const first = await helpers.syncAttendanceReportPeriodSummary(
      context,
      db,
      'org-1',
      { warn: vi.fn() },
      { period, userId: 'u-1' },
    )
    expect(first).toMatchObject({ synced: 1, usersScanned: 1, usersSynced: 1, created: 1, patched: 0, skipped: 0, failed: 0 })
    expect(first.multitable).toMatchObject({
      objectId: 'attendance_report_period_summaries',
      sheetId: 'sheet_period',
      viewId: 'view_period',
    })
    expect(store).toHaveLength(1)
    expect(store[0].data.fld_row_key).toBe('org-1:u-1:range:2026-05-01:2026-05-31')
    expect(store[0].data.fld_period_type).toBe('date_range')
    expect(store[0].data.fld_period_start).toBe('2026-05-01')
    expect(store[0].data.fld_total_minutes).toBe(960)
    expect(store[0].data.fld_leave_minutes).toBe(240)
    expect(store[0].data.fld_leave_type_annual_duration).toBe(240)
    expect(store[0].data.fld_period_score).toBeNull()
    const periodEnsure = ensureObjectDescriptors[ensureObjectDescriptors.length - 1]
    expect(periodEnsure.fields.filter(field => field.id === 'period_start')).toHaveLength(1)
    expect(periodEnsure.fields.filter(field => field.id === 'row_key')).toHaveLength(1)

    const second = await helpers.syncAttendanceReportPeriodSummary(
      context,
      db,
      'org-1',
      { warn: vi.fn() },
      { period, userId: 'u-1' },
    )
    expect(second).toMatchObject({ synced: 1, created: 0, patched: 0, skipped: 1 })

    store[0].data.fld_field_fingerprint = 'STALE-FIELD'
    store[0].data.fld_period_score = 99
    const third = await helpers.syncAttendanceReportPeriodSummary(
      context,
      db,
      'org-1',
      { warn: vi.fn() },
      { period, userId: 'u-1' },
    )
    expect(third).toMatchObject({ patched: 1, skipped: 0, duplicateRowKeys: 0 })
    const patch = records.patchRecord.mock.calls.at(-1)?.[0]
    expect(patch.changes.fld_period_score).toBeNull()
    expect(store[0].data.fld_period_score).toBeNull()
    expect(store[0].data.fld_field_fingerprint).not.toBe('STALE-FIELD')

    store.push({ id: 'rec-duplicate', data: { ...store[0].data } })
    const fourth = await helpers.syncAttendanceReportPeriodSummary(
      context,
      db,
      'org-1',
      { warn: vi.fn() },
      { period, userId: 'u-1' },
    )
    expect(fourth.duplicateRowKeys).toBeGreaterThanOrEqual(1)
    expect(store.filter(row => row.data.fld_row_key === 'org-1:u-1:range:2026-05-01:2026-05-31')).toHaveLength(2)
  })

  it('period-summary sync: explicit users aggregate per user', async () => {
    const store: Array<{ id: string; data: Record<string, unknown> }> = []
    let seq = 0
    const records = {
      queryRecords: async ({ filters }: { filters?: Record<string, unknown> }) => {
        const want = filters?.fld_row_key
        return store.filter(record => record.data.fld_row_key === want)
      },
      createRecord: async ({ data }: { data: Record<string, unknown> }) => {
        const record = { id: `rec-${++seq}`, data: { ...data } }
        store.push(record)
        return record
      },
      patchRecord: async ({ recordId, changes }: { recordId: string; changes: Record<string, unknown> }) => {
        const record = store.find(item => item.id === recordId)
        if (record) record.data = { ...record.data, ...changes }
        return record
      },
    }
    const provisioning = {
      ensureObject: async () => ({ baseId: 'base_period', sheet: { id: 'sheet_period' } }),
      ensureView: async () => ({ id: 'view_period', sheetId: 'sheet_period' }),
      resolveFieldIds: async ({ fieldIds }: { fieldIds: string[] }) =>
        Object.fromEntries(fieldIds.map(fieldId => [fieldId, `fld_${fieldId}`])),
    }
    const db = {
      query: async (sql: string) => {
        if (/FROM attendance_leave_types/.test(sql) || /FROM attendance_overtime_rules/.test(sql)) return []
        if (/SELECT\s+COALESCE\(SUM\(CASE WHEN is_workday THEN 1 ELSE 0 END\)/.test(sql)) {
          return [{
            total_days: 1,
            total_minutes: 480,
            total_late_minutes: 0,
            total_early_leave_minutes: 0,
            normal_days: 1,
            late_days: 0,
            early_leave_days: 0,
            late_early_days: 0,
            partial_days: 0,
            absent_days: 0,
            adjusted_days: 0,
            off_days: 0,
          }]
        }
        if (/FROM users u/.test(sql)) return [{ user_name: '员工', username: 'employee', meta: {} }]
        return []
      },
    }
    const context = { api: { multitable: { provisioning, records }, database: db } }
    const period = {
      periodType: 'date_range',
      periodKey: 'range:2026-05-01:2026-05-31',
      cycleId: null,
      periodName: '2026-05-01..2026-05-31',
      from: '2026-05-01',
      to: '2026-05-31',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
    }

    const result = await helpers.syncAttendanceReportPeriodSummariesForUsers(
      context,
      db,
      'org-1',
      { warn: vi.fn() },
      { period, userIds: ['u-1', ' u-1 ', 'u-2'] },
    )
    expect(result).toMatchObject({
      userSelection: 'explicit',
      totalUsers: 2,
      usersScanned: 2,
      usersSynced: 2,
      synced: 2,
      rowsSynced: 2,
      created: 2,
      patched: 0,
      skipped: 0,
      failed: 0,
      hasNextPage: false,
      periodType: 'date_range',
    })
    expect(store.map(row => row.data.fld_row_key)).toEqual([
      'org-1:u-1:range:2026-05-01:2026-05-31',
      'org-1:u-2:range:2026-05-01:2026-05-31',
    ])
  })

  it('does not add direct meta table writes to the attendance plugin', () => {
    const source = readFileSync(
      new URL('../../../../plugins/plugin-attendance/index.cjs', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/INSERT\s+INTO\s+meta_/i)
    expect(source).not.toMatch(/UPDATE\s+meta_/i)
    expect(source).not.toMatch(/DELETE\s+FROM\s+meta_/i)
  })
})
