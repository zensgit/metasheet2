import { describe, expect, it } from 'vitest'
import {
  IMPORT_TEMPLATE_BASE_COLUMNS,
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
    expect(byKey['approval']?.options).toHaveLength(1)
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

  it('select-all covers every option across groups', () => {
    const groups = groupSupportedImportColumns(MAPPING_COLUMNS)
    const all = allSelectableImportFieldKeys(groups)
    expect(new Set(all).size).toBe(all.length)
    const header = buildTemplateHeaderFromSelection(groups, all)
    expect(header).toHaveLength(IMPORT_TEMPLATE_BASE_COLUMNS.length + all.length)
  })
})
