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
