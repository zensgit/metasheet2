import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

describe('attendance report field formula engine wrapper', () => {
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

  function createFormulaCatalogContext(recordsSeed: Array<{ id: string; data: Record<string, unknown> }> = []) {
    const records = [...recordsSeed]
    const context = {
      api: {
        database: null,
        multitable: {
          provisioning: {
            ensureObject: vi.fn().mockResolvedValue({
              baseId: 'base-1',
              sheet: { id: 'sheet-1', baseId: 'base-1', name: '考勤统计字段目录' },
              fields: [],
            }),
            ensureView: vi.fn().mockResolvedValue({ id: 'view-1' }),
            findObjectSheet: vi.fn().mockResolvedValue({
              id: 'sheet-1',
              baseId: 'base-1',
              name: '考勤统计字段目录',
            }),
            resolveFieldIds: vi.fn().mockResolvedValue(fieldIds),
          },
          records: {
            queryRecords: vi.fn().mockImplementation(async () => records.map(record => ({
              sheetId: 'sheet-1',
              version: 1,
              ...record,
            }))),
            createRecord: vi.fn().mockImplementation(async (input: { sheetId: string; data: Record<string, unknown> }) => {
              const record = {
                id: `rec-${records.length + 1}`,
                sheetId: input.sheetId,
                version: 1,
                data: input.data,
              }
              records.push(record)
              return record
            }),
            patchRecord: vi.fn().mockImplementation(async (input: { sheetId: string; recordId: string; changes: Record<string, unknown> }) => {
              const target = records.find(record => record.id === input.recordId)
              if (!target) throw new Error(`Record not found: ${input.recordId}`)
              target.data = { ...target.data, ...input.changes }
              return {
                id: target.id,
                sheetId: input.sheetId,
                version: 2,
                data: target.data,
              }
            }),
          },
        },
      },
    }
    return { context, records }
  }

  it('creates a custom formula field through physical multitable field ids', async () => {
    const { context } = createFormulaCatalogContext()

    const result = await helpers.saveAttendanceReportFormulaField(
      context,
      'org-a',
      { warn: vi.fn(), error: vi.fn() },
      'net_anomaly_minutes',
      {
        name: '异常净时长',
        category: 'anomaly',
        unit: 'minutes',
        reportVisible: true,
        formulaEnabled: true,
        formulaExpression: '={late_duration}+{early_leave_duration}',
        formulaOutputType: 'duration_minutes',
      },
      { rawAliasesAllowed: true },
    )

    expect(result.operation).toBe('created')
    expect(result.field).toMatchObject({
      code: 'net_anomaly_minutes',
      name: '异常净时长',
      systemDefined: false,
      formulaEnabled: true,
      formulaExpression: '={late_duration}+{early_leave_duration}',
      formulaValid: true,
      formulaReferences: ['early_leave_duration', 'late_duration'],
    })
    expect(context.api.multitable.records.createRecord).toHaveBeenCalledWith({
      sheetId: 'sheet-1',
      data: expect.objectContaining({
        fld_code: 'net_anomaly_minutes',
        fld_name: '异常净时长',
        fld_category: '异常统计字段',
        fld_source: 'custom',
        fld_formula_enabled: true,
        fld_formula_expression: '={late_duration}+{early_leave_duration}',
        fld_formula_scope: 'record',
        fld_formula_output_type: 'duration_minutes',
      }),
    })
    expect(context.api.multitable.records.patchRecord).not.toHaveBeenCalled()
  })

  it('patches an existing custom formula field and rejects invalid saves before writing', async () => {
    const { context } = createFormulaCatalogContext([
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
          fld_formula_expression: '={late_duration}+1',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
    ])

    const result = await helpers.saveAttendanceReportFormulaField(
      context,
      'org-a',
      { warn: vi.fn(), error: vi.fn() },
      'net_anomaly_minutes',
      {
        formulaEnabled: true,
        formulaExpression: '={late_duration}+{early_leave_duration}',
        formulaOutputType: 'duration_minutes',
      },
      { rawAliasesAllowed: true },
    )

    expect(result.operation).toBe('patched')
    expect(result.field).toMatchObject({
      code: 'net_anomaly_minutes',
      formulaExpression: '={late_duration}+{early_leave_duration}',
      formulaValid: true,
    })
    expect(context.api.multitable.records.patchRecord).toHaveBeenCalledWith({
      sheetId: 'sheet-1',
      recordId: 'rec-formula',
      changes: expect.objectContaining({
        fld_code: 'net_anomaly_minutes',
        fld_formula_enabled: true,
        fld_formula_expression: '={late_duration}+{early_leave_duration}',
      }),
    })
    expect(context.api.multitable.records.createRecord).not.toHaveBeenCalled()

    await expect(helpers.saveAttendanceReportFormulaField(
      context,
      'org-a',
      { warn: vi.fn(), error: vi.fn() },
      'net_anomaly_minutes',
      {
        formulaEnabled: true,
        formulaExpression: '={missing_reference}+1',
        formulaOutputType: 'duration_minutes',
      },
      { rawAliasesAllowed: true },
    )).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_FORMULA',
      message: 'Unknown attendance report field reference: missing_reference.',
    })
    expect(context.api.multitable.records.patchRecord).toHaveBeenCalledTimes(1)
  })

  it('rejects system, dynamic subtype, reserved, and malformed formula field codes', async () => {
    const { context } = createFormulaCatalogContext()
    const logger = { warn: vi.fn(), error: vi.fn() }
    const input = {
      formulaEnabled: true,
      formulaExpression: '={late_duration}+1',
      formulaOutputType: 'duration_minutes',
    }

    await expect(helpers.saveAttendanceReportFormulaField(context, 'org-a', logger, 'late_duration', input))
      .rejects.toMatchObject({ status: 400, code: 'READ_ONLY_FIELD' })
    await expect(helpers.saveAttendanceReportFormulaField(context, 'org-a', logger, 'leave_type_annual_duration', input))
      .rejects.toMatchObject({ status: 400, code: 'READ_ONLY_FIELD' })
    await expect(helpers.saveAttendanceReportFormulaField(context, 'org-a', logger, 'late_minutes', input))
      .rejects.toMatchObject({ status: 400, code: 'RESERVED_FIELD_CODE' })
    await expect(helpers.saveAttendanceReportFormulaField(context, 'org-a', logger, 'Bad-Code', input))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_FIELD_CODE' })

    expect(context.api.multitable.provisioning.ensureObject).not.toHaveBeenCalled()
    expect(context.api.multitable.records.createRecord).not.toHaveBeenCalled()
    expect(context.api.multitable.records.patchRecord).not.toHaveBeenCalled()
  })

  it('merges custom formula fields and evaluates them through the formula API', async () => {
    const merged = helpers.mergeAttendanceReportFieldDefinitions([
      {
        id: 'rec-net-anomaly',
        data: {
          fld_code: 'net_anomaly_minutes',
          fld_name: '异常净时长',
          fld_category: '异常统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 4500,
          fld_dingtalk: '异常净时长',
          fld_description: '迟到与早退分钟数之和。',
          fld_internal: 'formula.netAnomalyMinutes',
          fld_formula_enabled: true,
          fld_formula_expression: '={late_duration}+{early_leave_duration}',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
    ], fieldIds)
    const formulaField = merged.find((field: { code: string }) => field.code === 'net_anomaly_minutes')

    expect(formulaField).toMatchObject({
      formulaEnabled: true,
      formulaExpression: '={late_duration}+{early_leave_duration}',
      formulaScope: 'record',
      formulaOutputType: 'duration_minutes',
      formulaValid: true,
      formulaError: null,
      systemDefined: false,
    })

    const reportFields = helpers.resolveAttendanceRecordReportFields(merged)
    const formulaSourceFields = helpers.resolveAttendanceFormulaSourceFields(merged)
    expect(reportFields.some((field: { code: string }) => field.code === 'net_anomaly_minutes')).toBe(true)

    const context = {
      api: {
        formula: {
          calculateFormula: vi.fn(async (expression: string) => {
            expect(expression).toBe('=12+5')
            return 17
          }),
        },
      },
    }
    const row = {
      work_date: '2026-05-13',
      status: 'late',
      late_minutes: 12,
      early_leave_minutes: 5,
      work_minutes: 460,
      is_workday: true,
      meta: {},
    }

    await expect(helpers.buildAttendanceRecordReportExportItemAsync(context, row, reportFields, formulaSourceFields))
      .resolves.toMatchObject({
        late_duration: 12,
        early_leave_duration: 5,
        net_anomaly_minutes: 17,
      })
    expect(context.api.formula.calculateFormula).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown references, volatile functions, and formula-to-formula references', () => {
    const systemFields = helpers.cloneAttendanceReportFieldDefinitions()
    expect(helpers.validateAttendanceReportFormulaExpression('={not_a_field}+1', { fields: systemFields }))
      .toMatchObject({
        valid: false,
        error: 'Unknown attendance report field reference: not_a_field.',
      })
    expect(helpers.validateAttendanceReportFormulaExpression('=NOW()', { fields: systemFields }))
      .toMatchObject({
        valid: false,
        error: 'Function NOW is not allowed for attendance report formulas.',
      })

    const merged = helpers.mergeAttendanceReportFieldDefinitions([
      {
        id: 'rec-a',
        data: {
          fld_code: 'formula_a',
          fld_name: '公式 A',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 3500,
          fld_formula_enabled: true,
          fld_formula_expression: '={late_duration}+1',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
      {
        id: 'rec-b',
        data: {
          fld_code: 'formula_b',
          fld_name: '公式 B',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 3501,
          fld_formula_enabled: true,
          fld_formula_expression: '={formula_a}+1',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
    ], fieldIds)
    expect(merged.find((field: { code: string }) => field.code === 'formula_b'))
      .toMatchObject({
        formulaValid: false,
        formulaError: 'Formula field reference formula_a is not supported in v1.',
      })
    const graph = helpers.buildAttendanceReportFormulaDependencyGraph(merged)
    expect(graph).toMatchObject({
      formulaFieldCount: 2,
      edgeCount: 2,
      blockedFormulaReferenceCount: 1,
      hasCycles: false,
      blockedFormulaReferences: [{ from: 'formula_b', to: 'formula_a' }],
    })
    expect(graph.edges).toEqual([
      { from: 'formula_a', to: 'late_duration', type: 'field' },
      { from: 'formula_b', to: 'formula_a', type: 'formula' },
    ])
  })

  it('detects formula dependency cycles in read-only graph diagnostics', () => {
    const graph = helpers.buildAttendanceReportFormulaDependencyGraph([
      {
        code: 'formula_a',
        name: '公式 A',
        formulaEnabled: true,
        formulaValid: false,
        formulaExpression: '={formula_b}+1',
        formulaReferences: ['formula_b'],
      },
      {
        code: 'formula_b',
        name: '公式 B',
        formulaEnabled: true,
        formulaValid: false,
        formulaExpression: '={formula_a}+1',
        formulaReferences: ['formula_a'],
      },
      {
        code: 'formula_c',
        name: '公式 C',
        formulaEnabled: true,
        formulaValid: true,
        formulaExpression: '={late_duration}+1',
        formulaReferences: ['late_duration'],
      },
    ])

    expect(graph).toMatchObject({
      formulaFieldCount: 3,
      edgeCount: 3,
      blockedFormulaReferenceCount: 2,
      hasCycles: true,
      cycles: [['formula_a', 'formula_b', 'formula_a']],
    })
    expect(graph.edges).toEqual([
      { from: 'formula_a', to: 'formula_b', type: 'formula' },
      { from: 'formula_b', to: 'formula_a', type: 'formula' },
      { from: 'formula_c', to: 'late_duration', type: 'field' },
    ])
  })

  it('allows representative formula functions from each whitelist category', () => {
    const systemFields = helpers.cloneAttendanceReportFieldDefinitions()
    const cases = [
      {
        category: 'condition',
        expression: '=IF({attendance_days}>0,{work_duration},0)',
        functions: ['IF'],
        references: ['attendance_days', 'work_duration'],
      },
      {
        category: 'math',
        expression: '=ROUND(ABS({late_duration}),0)',
        functions: ['ABS', 'ROUND'],
        references: ['late_duration'],
      },
      {
        category: 'aggregate',
        expression: '=SUM({late_duration},{early_leave_duration},COUNT({work_duration}),COUNTA({employee_name}))',
        functions: ['COUNT', 'COUNTA', 'SUM'],
        references: ['early_leave_duration', 'employee_name', 'late_duration', 'work_duration'],
      },
      {
        category: 'date',
        expression: '=DATEDIF(DATE(YEAR({work_date}),1,1),{work_date},"D")',
        functions: ['DATE', 'DATEDIF', 'YEAR'],
        references: ['work_date'],
      },
      {
        category: 'text',
        expression: '=CONCAT(LEFT({employee_name},1),LEN({employee_name}))',
        functions: ['CONCAT', 'LEFT', 'LEN'],
        references: ['employee_name'],
      },
    ]

    for (const testCase of cases) {
      expect(helpers.validateAttendanceReportFormulaExpression(testCase.expression, { fields: systemFields }))
        .toMatchObject({
          valid: true,
          error: null,
          functions: testCase.functions,
          references: testCase.references,
        })
    }
  })

  it('returns #ERROR! for invalid formula fields without blocking the row export', async () => {
    const merged = helpers.mergeAttendanceReportFieldDefinitions([
      {
        id: 'rec-bad',
        data: {
          fld_code: 'broken_formula',
          fld_name: '错误公式',
          fld_category: '异常统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 4501,
          fld_formula_enabled: true,
          fld_formula_expression: '={missing_reference}+1',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
    ], fieldIds)
    const reportFields = helpers.resolveAttendanceRecordReportFields(merged)
    const formulaSourceFields = helpers.resolveAttendanceFormulaSourceFields(merged)
    const context = {
      api: {
        formula: {
          calculateFormula: vi.fn(),
        },
      },
    }

    await expect(helpers.buildAttendanceRecordReportExportItemAsync(context, {
      work_date: '2026-05-13',
      status: 'normal',
      late_minutes: 0,
      early_leave_minutes: 0,
      work_minutes: 480,
      is_workday: true,
      meta: {},
    }, reportFields, formulaSourceFields)).resolves.toMatchObject({
      work_date: '2026-05-13',
      broken_formula: '#ERROR!',
    })
    expect(context.api.formula.calculateFormula).not.toHaveBeenCalled()
  })

  it('includes formula metadata in the report field fingerprint', () => {
    const baseField = {
      code: 'net_anomaly_minutes',
      name: '异常净时长',
      category: 'anomaly',
      unit: 'minutes',
      enabled: true,
      reportVisible: true,
      sortOrder: 4500,
      source: 'custom',
      formulaEnabled: true,
      formulaScope: 'record',
      formulaOutputType: 'duration_minutes',
      formulaValid: true,
    }
    const left = helpers.buildAttendanceReportFieldConfigFingerprint([
      { ...baseField, formulaExpression: '={late_duration}+{early_leave_duration}' },
    ])
    const right = helpers.buildAttendanceReportFieldConfigFingerprint([
      { ...baseField, formulaExpression: '={late_duration}' },
    ])

    expect(left.value).not.toBe(right.value)

    const legacyPayload = [{
      code: 'net_anomaly_minutes',
      name: '异常净时长',
      category: 'anomaly',
      unit: 'minutes',
      sortOrder: 4500,
      source: 'custom',
      configured: false,
      systemDefined: true,
      formulaEnabled: true,
      formulaExpression: '={late_duration}',
      formulaScope: 'record',
      formulaOutputType: 'duration_minutes',
      formulaValid: true,
    }]
    expect(right.value).toBe(createHash('sha1').update(JSON.stringify(legacyPayload)).digest('hex'))

    const sourceFieldsLeft = helpers.buildAttendanceReportFieldConfigFingerprint([
      { ...baseField, formulaExpression: '={custom_metric}+1' },
    ], {
      formulaSourceFields: [{ code: 'custom_metric', systemDefined: false, formulaSourceMode: 'meta', internalKey: 'custom_metric' }],
    })
    const sourceFieldsRight = helpers.buildAttendanceReportFieldConfigFingerprint([
      { ...baseField, formulaExpression: '={custom_metric}+1' },
    ], {
      formulaSourceFields: [{ code: 'custom_metric', systemDefined: false, formulaSourceMode: 'alias', internalKey: 'manualCredit' }],
    })
    expect(sourceFieldsLeft.value).not.toBe(sourceFieldsRight.value)
  })

  it('previews formulas against supplied sample values', async () => {
    const context = {
      api: {
        formula: {
          calculateFormula: vi.fn(async (expression: string) => {
            expect(expression).toBe('=12+3')
            return 15
          }),
        },
      },
    }

    await expect(helpers.previewAttendanceReportFormula(context, '={late_duration}+{early_leave_duration}', {
      late_duration: 12,
      early_leave_duration: 3,
    }, helpers.cloneAttendanceReportFieldDefinitions())).resolves.toEqual({
      ok: true,
      value: 15,
      references: ['early_leave_duration', 'late_duration'],
      error: null,
    })
  })

  it('rejects bare spreadsheet cell and range references', () => {
    const systemFields = helpers.cloneAttendanceReportFieldDefinitions()

    expect(helpers.validateAttendanceReportFormulaExpression('=A1+1', { fields: systemFields }))
      .toMatchObject({
        valid: false,
        error: 'Spreadsheet cell reference A1 is not allowed; use {field_code} to reference attendance fields.',
      })

    expect(helpers.validateAttendanceReportFormulaExpression('=SUM(A1:B2)', { fields: systemFields }))
      .toMatchObject({
        valid: false,
        error: 'Spreadsheet cell reference A1:B2 is not allowed; use {field_code} to reference attendance fields.',
      })

    expect(helpers.validateAttendanceReportFormulaExpression('=A1+{late_duration}', { fields: systemFields }))
      .toMatchObject({
        valid: false,
        error: 'Spreadsheet cell reference A1 is not allowed; use {field_code} to reference attendance fields.',
      })

    expect(helpers.validateAttendanceReportFormulaExpression('=b2+1', { fields: systemFields }))
      .toMatchObject({
        valid: false,
        error: 'Spreadsheet cell reference b2 is not allowed; use {field_code} to reference attendance fields.',
      })

    expect(helpers.validateAttendanceReportFormulaExpression('=IF({attendance_days}>0,"A1","B2")', { fields: systemFields }))
      .toMatchObject({ valid: true, error: null })

    expect(helpers.validateAttendanceReportFormulaExpression('={A1}+1', { fields: systemFields }))
      .toMatchObject({
        valid: false,
        error: 'Unknown attendance report field reference: A1.',
      })
  })

  it('hidden but enabled source field still resolves in formulas', async () => {
    const merged = helpers.mergeAttendanceReportFieldDefinitions([
      {
        id: 'rec-late-hidden',
        data: {
          fld_code: 'late_duration',
          fld_name: '迟到时长',
          fld_category: '异常统计字段',
          fld_source: 'system',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: false,
          fld_sort: 4000,
        },
      },
      {
        id: 'rec-late-plus-one',
        data: {
          fld_code: 'late_plus_one',
          fld_name: '迟到+1',
          fld_category: '异常统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 4500,
          fld_formula_enabled: true,
          fld_formula_expression: '={late_duration}+1',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
    ], fieldIds)

    const lateField = merged.find((field: { code: string }) => field.code === 'late_duration')
    expect(lateField).toMatchObject({ enabled: true, reportVisible: false })

    const formulaField = merged.find((field: { code: string }) => field.code === 'late_plus_one')
    expect(formulaField).toMatchObject({
      formulaEnabled: true,
      formulaValid: true,
      formulaError: null,
    })

    const outputFields = helpers.resolveAttendanceRecordReportFields(merged)
    expect(outputFields.some((field: { code: string }) => field.code === 'late_duration')).toBe(false)
    expect(outputFields.some((field: { code: string }) => field.code === 'late_plus_one')).toBe(true)

    const formulaSourceFields = helpers.resolveAttendanceFormulaSourceFields(merged)
    expect(formulaSourceFields.some((field: { code: string }) => field.code === 'late_duration')).toBe(true)
    expect(formulaSourceFields.some((field: { code: string }) => field.code === 'late_plus_one')).toBe(false)

    const context = {
      api: {
        formula: {
          calculateFormula: vi.fn(async (expression: string) => {
            expect(expression).toBe('=12+1')
            return 13
          }),
        },
      },
    }

    await expect(helpers.buildAttendanceRecordReportExportItemAsync(context, {
      work_date: '2026-05-13',
      status: 'late',
      late_minutes: 12,
      early_leave_minutes: 0,
      work_minutes: 460,
      is_workday: true,
      meta: {},
    }, outputFields, formulaSourceFields)).resolves.toMatchObject({
      late_plus_one: 13,
    })
    expect(context.api.formula.calculateFormula).toHaveBeenCalledTimes(1)
  })

  it('disabled source field is rejected by the validator and yields #ERROR! at evaluation', async () => {
    const merged = helpers.mergeAttendanceReportFieldDefinitions([
      {
        id: 'rec-late-disabled',
        data: {
          fld_code: 'late_duration',
          fld_name: '迟到时长',
          fld_category: '异常统计字段',
          fld_source: 'system',
          fld_unit: 'minutes',
          fld_enabled: false,
          fld_visible: true,
          fld_sort: 4000,
        },
      },
      {
        id: 'rec-late-plus-one',
        data: {
          fld_code: 'late_plus_one',
          fld_name: '迟到+1',
          fld_category: '异常统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 4500,
          fld_formula_enabled: true,
          fld_formula_expression: '={late_duration}+1',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
    ], fieldIds)

    const lateField = merged.find((field: { code: string }) => field.code === 'late_duration')
    expect(lateField).toMatchObject({ enabled: false })

    const formulaField = merged.find((field: { code: string }) => field.code === 'late_plus_one')
    expect(formulaField).toMatchObject({
      formulaEnabled: true,
      formulaValid: false,
      formulaError: 'Unknown attendance report field reference: late_duration.',
    })

    const formulaSourceFields = helpers.resolveAttendanceFormulaSourceFields(merged)
    expect(formulaSourceFields.some((field: { code: string }) => field.code === 'late_duration')).toBe(false)

    const outputFields = helpers.resolveAttendanceRecordReportFields(merged)
    const context = {
      api: {
        formula: {
          calculateFormula: vi.fn(),
        },
      },
    }

    await expect(helpers.buildAttendanceRecordReportExportItemAsync(context, {
      work_date: '2026-05-13',
      status: 'late',
      late_minutes: 12,
      early_leave_minutes: 0,
      work_minutes: 460,
      is_workday: true,
      meta: {},
    }, outputFields, formulaSourceFields)).resolves.toMatchObject({
      late_plus_one: '#ERROR!',
    })
    expect(context.api.formula.calculateFormula).not.toHaveBeenCalled()
  })

  it('defaults to rejecting custom non-formula fields as formula sources', () => {
    const merged = helpers.mergeAttendanceReportFieldDefinitions([
      {
        id: 'rec-custom-metric',
        data: {
          fld_code: 'custom_metric',
          fld_name: '客户自定义指标',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 3000,
        },
      },
      {
        id: 'rec-uses-custom',
        data: {
          fld_code: 'uses_custom_metric',
          fld_name: '用了自定义',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 3001,
          fld_formula_enabled: true,
          fld_formula_expression: '={custom_metric}+1',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
    ], fieldIds)

    const customField = merged.find((field: { code: string }) => field.code === 'custom_metric')
    expect(customField).toMatchObject({ systemDefined: false, enabled: true, formulaEnabled: false })

    const usesField = merged.find((field: { code: string }) => field.code === 'uses_custom_metric')
    expect(usesField).toMatchObject({
      formulaEnabled: true,
      formulaValid: false,
      formulaError: 'Unknown attendance report field reference: custom_metric.',
    })

    const formulaSourceFields = helpers.resolveAttendanceFormulaSourceFields(merged)
    expect(formulaSourceFields.some((field: { code: string }) => field.code === 'custom_metric')).toBe(false)
    expect(formulaSourceFields.every((field: { systemDefined: boolean }) => field.systemDefined === true)).toBe(true)
  })

  it('allows opt-in custom non-formula fields as record formula sources', async () => {
    const merged = helpers.mergeAttendanceReportFieldDefinitions([
      {
        id: 'rec-custom-meta',
        data: {
          fld_code: 'custom_meta_minutes',
          fld_name: '手工调整分钟',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 3000,
          fld_formula_source_mode: 'meta',
        },
      },
      {
        id: 'rec-custom-path',
        data: {
          fld_code: 'custom_path_minutes',
          fld_name: '路径调整分钟',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 3001,
          fld_internal: 'meta.adjustments.pathMinutes',
          fld_formula_source_mode: 'internal_key',
        },
      },
      {
        id: 'rec-custom-alias',
        data: {
          fld_code: 'custom_alias_minutes',
          fld_name: '别名调整分钟',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 3002,
          fld_internal: 'manualCredit',
          fld_formula_source_mode: 'alias',
        },
      },
      {
        id: 'rec-uses-custom',
        data: {
          fld_code: 'uses_custom_sources',
          fld_name: '使用自定义源',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 3003,
          fld_formula_enabled: true,
          fld_formula_expression: '={custom_meta_minutes}+{custom_path_minutes}+{custom_alias_minutes}',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
    ], fieldIds)

    const formulaField = merged.find((field: { code: string }) => field.code === 'uses_custom_sources')
    expect(formulaField).toMatchObject({
      formulaEnabled: true,
      formulaValid: true,
      formulaError: null,
      formulaReferences: ['custom_alias_minutes', 'custom_meta_minutes', 'custom_path_minutes'],
    })

    const outputFields = helpers.resolveAttendanceRecordReportFields(merged)
    expect(outputFields.some((field: { code: string }) => field.code === 'custom_meta_minutes')).toBe(false)
    expect(outputFields.some((field: { code: string }) => field.code === 'uses_custom_sources')).toBe(true)

    const formulaSourceFields = helpers.resolveAttendanceFormulaSourceFields(merged)
    expect(formulaSourceFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'custom_meta_minutes', systemDefined: false, formulaSourceMode: 'meta' }),
      expect.objectContaining({ code: 'custom_path_minutes', systemDefined: false, formulaSourceMode: 'internal_key', internalKey: 'meta.adjustments.pathMinutes' }),
      expect.objectContaining({ code: 'custom_alias_minutes', systemDefined: false, formulaSourceMode: 'alias', internalKey: 'manualCredit' }),
    ]))

    const context = {
      api: {
        formula: {
          calculateFormula: vi.fn(async (expression: string) => {
            expect(expression).toBe('=7+5+4')
            return 16
          }),
        },
      },
    }

    await expect(helpers.buildAttendanceRecordReportExportItemAsync(context, {
      work_date: '2026-05-13',
      status: 'normal',
      late_minutes: 0,
      early_leave_minutes: 0,
      work_minutes: 460,
      is_workday: true,
      meta: {
        custom_meta_minutes: 7,
        adjustments: { pathMinutes: 5 },
        formulaSources: { manualCredit: 4 },
      },
    }, outputFields, formulaSourceFields)).resolves.toMatchObject({
      uses_custom_sources: 16,
    })
    expect(context.api.formula.calculateFormula).toHaveBeenCalledTimes(1)
  })

  it('rejects disabled or unsafe custom formula sources before evaluation', () => {
    const merged = helpers.mergeAttendanceReportFieldDefinitions([
      {
        id: 'rec-disabled-custom',
        data: {
          fld_code: 'disabled_custom_metric',
          fld_name: '停用自定义指标',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: false,
          fld_visible: true,
          fld_sort: 3000,
          fld_formula_source_mode: 'meta',
        },
      },
      {
        id: 'rec-unsafe-custom',
        data: {
          fld_code: 'unsafe_custom_metric',
          fld_name: '危险路径指标',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 3001,
          fld_internal: 'report_values.net_minutes',
          fld_formula_source_mode: 'internal_key',
        },
      },
      {
        id: 'rec-uses-disabled',
        data: {
          fld_code: 'uses_disabled_custom',
          fld_name: '使用停用自定义',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 3002,
          fld_formula_enabled: true,
          fld_formula_expression: '={disabled_custom_metric}+1',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
      {
        id: 'rec-uses-unsafe',
        data: {
          fld_code: 'uses_unsafe_custom',
          fld_name: '使用危险自定义',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 3003,
          fld_formula_enabled: true,
          fld_formula_expression: '={unsafe_custom_metric}+1',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
    ], fieldIds)

    expect(helpers.resolveAttendanceFormulaSourceFields(merged)
      .some((field: { code: string }) => ['disabled_custom_metric', 'unsafe_custom_metric'].includes(field.code)))
      .toBe(false)
    expect(merged.find((field: { code: string }) => field.code === 'uses_disabled_custom')).toMatchObject({
      formulaValid: false,
      formulaError: 'Unknown attendance report field reference: disabled_custom_metric.',
    })
    expect(merged.find((field: { code: string }) => field.code === 'uses_unsafe_custom')).toMatchObject({
      formulaValid: false,
      formulaError: 'Unknown attendance report field reference: unsafe_custom_metric.',
    })
  })

  it('raw alias references bypass catalog enable/visibility state', async () => {
    const merged = helpers.mergeAttendanceReportFieldDefinitions([
      {
        id: 'rec-late-disabled',
        data: {
          fld_code: 'late_duration',
          fld_name: '迟到时长',
          fld_category: '异常统计字段',
          fld_source: 'system',
          fld_unit: 'minutes',
          fld_enabled: false,
          fld_visible: true,
          fld_sort: 4000,
        },
      },
      {
        id: 'rec-raw-late-plus-one',
        data: {
          fld_code: 'raw_late_plus_one',
          fld_name: '迟到分钟+1（raw alias）',
          fld_category: '异常统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 4501,
          fld_formula_enabled: true,
          fld_formula_expression: '={late_minutes}+1',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
    ], fieldIds)

    const lateField = merged.find((field: { code: string }) => field.code === 'late_duration')
    expect(lateField).toMatchObject({ enabled: false })

    const rawFormula = merged.find((field: { code: string }) => field.code === 'raw_late_plus_one')
    expect(rawFormula).toMatchObject({
      formulaValid: true,
      formulaError: null,
      formulaReferences: ['late_minutes'],
    })

    const formulaSourceFields = helpers.resolveAttendanceFormulaSourceFields(merged)
    expect(formulaSourceFields.some((field: { code: string }) => field.code === 'late_duration')).toBe(false)

    const outputFields = helpers.resolveAttendanceRecordReportFields(merged)
    const context = {
      api: {
        formula: {
          calculateFormula: vi.fn(async (expression: string) => {
            expect(expression).toBe('=12+1')
            return 13
          }),
        },
      },
    }

    await expect(helpers.buildAttendanceRecordReportExportItemAsync(context, {
      work_date: '2026-05-13',
      status: 'late',
      late_minutes: 12,
      early_leave_minutes: 0,
      work_minutes: 460,
      is_workday: true,
      meta: {},
    }, outputFields, formulaSourceFields)).resolves.toMatchObject({
      raw_late_plus_one: 13,
    })
    expect(context.api.formula.calculateFormula).toHaveBeenCalledTimes(1)
  })

  it('can globally disable raw alias references without touching field enabled state', async () => {
    expect(helpers.readAttendanceFormulaRawAliasesEnvOverride({
      ATTENDANCE_FORMULA_ALLOW_RAW_ALIASES: 'off',
    })).toBe(false)
    expect(helpers.resolveAttendanceFormulaRawAliasesAllowed({
      formula: { allowRawAliases: true },
    }, {
      ATTENDANCE_FORMULA_ALLOW_RAW_ALIASES: 'false',
    })).toBe(false)
    expect(helpers.resolveAttendanceFormulaRawAliasesAllowed({
      formula: { allowRawAliases: false },
    }, {
      ATTENDANCE_FORMULA_ALLOW_RAW_ALIASES: 'true',
    })).toBe(true)

    const merged = helpers.mergeAttendanceReportFieldDefinitions([
      {
        id: 'rec-raw-late-plus-one',
        data: {
          fld_code: 'raw_late_plus_one',
          fld_name: '迟到分钟+1（raw alias）',
          fld_category: '异常统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 4501,
          fld_formula_enabled: true,
          fld_formula_expression: '={late_minutes}+1',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
    ], fieldIds, { rawAliasesAllowed: false })

    const rawFormula = merged.find((field: { code: string }) => field.code === 'raw_late_plus_one')
    expect(rawFormula).toMatchObject({
      formulaValid: false,
      formulaError: 'Raw alias reference late_minutes is disabled by attendance formula settings.',
      formulaReferences: ['late_minutes'],
    })

    expect(helpers.validateAttendanceReportFormulaExpression('={late_minutes}+1', {
      fields: merged,
      rawAliasesAllowed: false,
    })).toMatchObject({
      valid: false,
      error: 'Raw alias reference late_minutes is disabled by attendance formula settings.',
    })

    const context = {
      api: {
        formula: {
          calculateFormula: vi.fn(),
        },
      },
    }
    const outputFields = helpers.resolveAttendanceRecordReportFields(merged)
    const formulaSourceFields = helpers.resolveAttendanceFormulaSourceFields(merged)
    await expect(helpers.buildAttendanceRecordReportExportItemAsync(context, {
      work_date: '2026-05-13',
      status: 'late',
      late_minutes: 12,
      early_leave_minutes: 0,
      work_minutes: 460,
      is_workday: true,
      meta: {},
    }, outputFields, formulaSourceFields, { rawAliasesAllowed: false })).resolves.toMatchObject({
      raw_late_plus_one: '#ERROR!',
    })
    expect(context.api.formula.calculateFormula).not.toHaveBeenCalled()
  })

  it('catalog fields with raw alias codes are dropped (raw aliases are reserved)', async () => {
    const merged = helpers.mergeAttendanceReportFieldDefinitions([
      {
        id: 'rec-shadow-nonformula',
        data: {
          fld_code: 'work_minutes',
          fld_name: '工时分钟（违规非公式）',
          fld_category: '出勤统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 3501,
        },
      },
      {
        id: 'rec-shadow-formula',
        data: {
          fld_code: 'late_minutes',
          fld_name: '迟到分钟（违规公式）',
          fld_category: '异常统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 4002,
          fld_formula_enabled: true,
          fld_formula_expression: '={attendance_days}*0',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
      {
        id: 'rec-use-raw',
        data: {
          fld_code: 'use_raw_late',
          fld_name: '用 raw alias',
          fld_category: '异常统计字段',
          fld_source: 'custom',
          fld_unit: 'minutes',
          fld_enabled: true,
          fld_visible: true,
          fld_sort: 4503,
          fld_formula_enabled: true,
          fld_formula_expression: '={late_minutes}+1',
          fld_formula_scope: 'record',
          fld_formula_output_type: 'duration_minutes',
        },
      },
    ], fieldIds)

    expect(merged.find((field: { code: string }) => field.code === 'work_minutes')).toBeUndefined()
    expect(merged.find((field: { code: string }) => field.code === 'late_minutes')).toBeUndefined()

    const useField = merged.find((field: { code: string }) => field.code === 'use_raw_late')
    expect(useField).toMatchObject({
      formulaValid: true,
      formulaError: null,
      formulaReferences: ['late_minutes'],
    })

    expect(helpers.validateAttendanceReportFormulaExpression('={late_minutes}+1', { fields: merged }))
      .toMatchObject({ valid: true, error: null })

    const outputFields = helpers.resolveAttendanceRecordReportFields(merged)
    const formulaSourceFields = helpers.resolveAttendanceFormulaSourceFields(merged)
    const context = {
      api: {
        formula: {
          calculateFormula: vi.fn(async (expression: string) => {
            expect(expression).toBe('=12+1')
            return 13
          }),
        },
      },
    }

    await expect(helpers.buildAttendanceRecordReportExportItemAsync(context, {
      work_date: '2026-05-13',
      status: 'late',
      late_minutes: 12,
      early_leave_minutes: 0,
      work_minutes: 460,
      is_workday: true,
      meta: {},
    }, outputFields, formulaSourceFields)).resolves.toMatchObject({
      use_raw_late: 13,
    })
    expect(context.api.formula.calculateFormula).toHaveBeenCalledTimes(1)
  })

  it('preview does not let sample keys extend the legal field set', async () => {
    const systemFields = helpers.cloneAttendanceReportFieldDefinitions()
    const context = {
      api: {
        formula: {
          calculateFormula: vi.fn(),
        },
      },
    }

    await expect(helpers.previewAttendanceReportFormula(
      context,
      '={phantom_field}+1',
      { phantom_field: 99 },
      systemFields,
    )).resolves.toMatchObject({
      ok: false,
      value: null,
      error: 'Unknown attendance report field reference: phantom_field.',
    })
    expect(context.api.formula.calculateFormula).not.toHaveBeenCalled()
  })

  it('preview rejects raw alias references when the global gate is disabled', async () => {
    const context = {
      api: {
        formula: {
          calculateFormula: vi.fn(),
        },
      },
    }

    await expect(helpers.previewAttendanceReportFormula(
      context,
      '={late_minutes}+1',
      { late_minutes: 12 },
      helpers.cloneAttendanceReportFieldDefinitions(),
      { rawAliasesAllowed: false },
    )).resolves.toMatchObject({
      ok: false,
      value: null,
      references: ['late_minutes'],
      error: 'Raw alias reference late_minutes is disabled by attendance formula settings.',
    })
    expect(context.api.formula.calculateFormula).not.toHaveBeenCalled()
  })
})
