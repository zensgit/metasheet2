import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withCsvBom } from '../src/views/attendance/csvExport'
import {
  IMPORT_TEMPLATE_BASE_COLUMNS,
  buildImportColumnFormatRows,
  formatSpecForDataType,
  IMPORT_TEMPLATE_DEFAULT_SELECTED_KEYS,
  allSelectableImportFieldKeys,
  buildTemplateHeaderFromSelection,
  groupSupportedImportColumns,
} from '../src/views/attendance/importTemplateColumns'

const MAPPING_COLUMNS = [
  { sourceField: '1_on_duty_user_check_time', targetField: 'firstInAt' },
  { sourceField: '上班1打卡时间', targetField: 'firstInAt' },
  { sourceField: 'check_in', targetField: 'firstInAt' },
  { sourceField: '下班1打卡时间', targetField: 'lastOutAt' },
  { sourceField: '上班2打卡时间', targetField: 'clockIn2' },
  { sourceField: '考勤结果', targetField: 'status' },
  { sourceField: 'attend_result', targetField: 'status' },
  { sourceField: '异常原因', targetField: 'exceptionReason' },
  { sourceField: '迟到分钟', targetField: 'lateMinutes' },
  { sourceField: '加班小时', targetField: 'overtimeHours' },
  { sourceField: 'leave_hours', targetField: 'leaveMinutes' },
  { sourceField: 'overtime_duration', targetField: 'overtimeMinutes' },
  { sourceField: '离职时间', targetField: 'resignTime' },
  { sourceField: '班次', targetField: 'shiftName' },
  { sourceField: '考勤组', targetField: 'attendanceGroup' },
  { sourceField: '部门', targetField: 'department' },
  { sourceField: '关联的审批单', targetField: 'approvalSummary' },
]

describe('importTemplateColumns', () => {
  it('groups by semantic category, dedupes aliases, prefers Chinese column names', () => {
    const groups = groupSupportedImportColumns(MAPPING_COLUMNS)
    const byKey = Object.fromEntries(groups.map(group => [group.key, group]))

    const punchTimes = byKey['punch-times']
    expect(punchTimes).toBeTruthy()
    const firstIn = punchTimes.options.find(option => option.key === 'firstInAt')
    expect(firstIn?.columnName).toBe('上班1打卡时间')
    expect(firstIn?.aliases).toEqual(['1_on_duty_user_check_time', '上班1打卡时间', 'check_in'])

    expect(byKey['status']?.options.map(option => option.columnName)).toEqual(['考勤结果', '异常原因'])
    expect(byKey['durations']?.options.map(option => option.key)).toEqual(['lateMinutes', 'overtimeHours'])
    expect(byKey['shift-group']?.options.map(option => option.columnName)).toEqual(['班次', '考勤组'])
    expect(byKey['people']?.options.map(option => option.columnName)).toEqual(['部门', '离职时间'])
    expect(byKey['approval']?.options).toHaveLength(1)
  })

  it('excludes English-only near-duplicate targets so generated headers stay Chinese', () => {
    const groups = groupSupportedImportColumns(MAPPING_COLUMNS)
    const keys = allSelectableImportFieldKeys(groups)
    expect(keys).not.toContain('leaveMinutes')
    expect(keys).not.toContain('overtimeMinutes')
    const header = buildTemplateHeaderFromSelection(groups, keys)
    expect(header.filter(column => /[A-Za-z_]/.test(column))).toEqual([])
  })

  it('skips empty/unknown mapping rows and empty input', () => {
    expect(groupSupportedImportColumns(null)).toEqual([])
    expect(groupSupportedImportColumns([
      { sourceField: '', targetField: 'firstInAt' },
      { sourceField: 'x', targetField: '' },
      { sourceField: 'mystery', targetField: 'notARealTarget' },
    ])).toEqual([])
  })

  it('builds the header with locked base columns first, in group order, ignoring unknown keys', () => {
    const groups = groupSupportedImportColumns(MAPPING_COLUMNS)
    const header = buildTemplateHeaderFromSelection(groups, new Set(['status', 'firstInAt', 'bogus']))
    expect(header.slice(0, IMPORT_TEMPLATE_BASE_COLUMNS.length)).toEqual([...IMPORT_TEMPLATE_BASE_COLUMNS])
    expect(header).toEqual(['日期', '工号', '姓名', '上班1打卡时间', '考勤结果'])
  })

  it('default selection reproduces the starter-template shape', () => {
    const groups = groupSupportedImportColumns(MAPPING_COLUMNS)
    const header = buildTemplateHeaderFromSelection(groups, new Set(IMPORT_TEMPLATE_DEFAULT_SELECTED_KEYS))
    expect(header).toEqual(['日期', '工号', '姓名', '上班1打卡时间', '下班1打卡时间', '考勤结果', '异常原因', '考勤组'])
  })

  it('default selection stays in sync with the backend starter template (fixture-sync)', () => {
    // Guard against silent drift (review P3-1): the hardcoded default keys must
    // keep reproducing the backend's first template profile. Reads the real
    // plugin source so a backend starter-template change turns this red.
    const source = readFileSync(
      resolve(__dirname, '../../../plugins/plugin-attendance/index.cjs'),
      'utf8',
    )
    const mappingBlock = source.match(/const IMPORT_MAPPING_COLUMNS = \[([\s\S]*?)\n\]/)?.[1]
    expect(mappingBlock, 'expected IMPORT_MAPPING_COLUMNS in plugin source').toBeTruthy()
    const realColumns = Array.from(
      mappingBlock!.matchAll(/sourceField: '([^']+)', targetField: '([^']+)'/g),
    ).map(match => ({ sourceField: match[1], targetField: match[2] }))
    expect(realColumns.length).toBeGreaterThan(30)

    const starterBlock = source.match(/templateColumns: \[([^\]]+)\]/)?.[1]
    expect(starterBlock, 'expected first profile templateColumns').toBeTruthy()
    const starterColumns = Array.from(starterBlock!.matchAll(/'([^']+)'/g)).map(match => match[1])

    const groups = groupSupportedImportColumns(realColumns)
    const header = buildTemplateHeaderFromSelection(groups, new Set(IMPORT_TEMPLATE_DEFAULT_SELECTED_KEYS))
    expect([...header].sort()).toEqual([...starterColumns].sort())
  })

  it('select-all covers every option across groups', () => {
    const groups = groupSupportedImportColumns(MAPPING_COLUMNS)
    const all = allSelectableImportFieldKeys(groups)
    expect(new Set(all).size).toBe(all.length)
    const header = buildTemplateHeaderFromSelection(groups, all)
    expect(header).toHaveLength(IMPORT_TEMPLATE_BASE_COLUMNS.length + all.length)
  })

  it('withCsvBom prefixes exactly once (idempotent)', () => {
    const once = withCsvBom('日期,姓名')
    expect(once.charCodeAt(0)).toBe(0xfeff)
    expect(withCsvBom(once)).toBe(once)
  })

  describe('formatSpecForDataType', () => {
    it('maps each backend dataType to a format + example', () => {
      expect(formatSpecForDataType('date')).toEqual({ formatEn: 'YYYY-MM-DD', formatZh: 'YYYY-MM-DD', example: '2026-06-01' })
      expect(formatSpecForDataType('datetime').example).toBe('2026-06-01 09:00')
      expect(formatSpecForDataType('time').formatZh).toContain('HH:mm')
      expect(formatSpecForDataType('hours').example).toBe('8.5')
      expect(formatSpecForDataType('minutes').example).toBe('15')
      expect(formatSpecForDataType('number').example).toBe('0')
      expect(formatSpecForDataType('string').formatZh).toBe('文本')
      expect(formatSpecForDataType(undefined).example).toBe('—')
    })
  })

  describe('column format options carry dataType-derived format + curated example', () => {
    const COLS = [
      { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'datetime' },
      { sourceField: '加班小时', targetField: 'overtimeHours', dataType: 'hours' },
      { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
      { sourceField: '考勤组', targetField: 'attendanceGroup', dataType: 'string' },
    ]
    it('threads dataType into each option and curates string examples', () => {
      const groups = groupSupportedImportColumns(COLS)
      const opt = (key: string) => groups.flatMap(g => g.options).find(o => o.key === key)!
      expect(opt('firstInAt').formatZh).toContain('HH:mm')
      expect(opt('firstInAt').example).toBe('2026-06-01 09:00')
      expect(opt('overtimeHours').example).toBe('8.5')
      expect(opt('status').example).toBe('正常')
      expect(opt('attendanceGroup').example).toBe('总部日班')
    })
  })

  describe('buildImportColumnFormatRows', () => {
    const groups = groupSupportedImportColumns([
      { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'datetime' },
      { sourceField: '加班小时', targetField: 'overtimeHours', dataType: 'hours' },
    ])
    it('leads with required/identity base columns then optional supported columns', () => {
      const rows = buildImportColumnFormatRows(groups)
      const byCol = Object.fromEntries(rows.map(r => [r.column, r]))
      expect(byCol['日期'].requirement).toBe('required')
      expect(byCol['日期'].formatZh).toBe('YYYY-MM-DD')
      expect(byCol['日期'].example).toBe('2026-06-01')
      expect(byCol['工号'].requirement).toBe('identity')
      expect(byCol['姓名'].requirement).toBe('identity')
      expect(byCol['上班1打卡时间'].requirement).toBe('optional')
      expect(byCol['上班1打卡时间'].example).toBe('2026-06-01 09:00')
      expect(byCol['加班小时'].requirement).toBe('optional')
      // base columns come first
      expect(rows.slice(0, 3).map(r => r.column)).toEqual(['日期', '工号', '姓名'])
    })
    it('does not duplicate a supported column that shares a base column name', () => {
      const rows = buildImportColumnFormatRows(groups)
      expect(rows.filter(r => r.column === '日期')).toHaveLength(1)
    })
  })
})
