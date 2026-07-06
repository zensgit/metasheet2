// Field-picker vocabulary for the attendance import template: turns the raw
// mapping columns already returned by GET /api/attendance/import/template
// (data.mapping.columns — sourceField/targetField alias pairs) into grouped,
// selectable, Chinese-first field options, and assembles a CSV template header
// from a selection. Pure and dependency-free; shared so the AttendanceView
// shell and the import-workflow composable/Section render the same vocabulary.
// See docs/development/attendance-import-section-ux-design-lock-20260706.md.

export interface AttendanceImportMappingColumnLike {
  sourceField?: unknown
  targetField?: unknown
}

export interface AttendanceImportFieldOption {
  /** stable selection key = canonical targetField */
  key: string
  /** Chinese-first column name written into the generated template header */
  columnName: string
  /** every accepted source alias (for tooltips / recognition) */
  aliases: string[]
  meaningEn: string
  meaningZh: string
}

export interface AttendanceImportFieldGroup {
  key: string
  labelEn: string
  labelZh: string
  options: AttendanceImportFieldOption[]
}

/** Base columns every generated template starts with (identity + user match). */
export const IMPORT_TEMPLATE_BASE_COLUMNS = ['日期', '工号', '姓名'] as const

const GROUP_DEFS: Array<{ key: string; labelEn: string; labelZh: string; targets: string[] }> = [
  {
    key: 'punch-times',
    labelEn: 'Punch times',
    labelZh: '打卡时间',
    targets: ['firstInAt', 'lastOutAt', 'clockIn2', 'clockOut2', 'clockIn3', 'clockOut3'],
  },
  {
    key: 'punch-results',
    labelEn: 'Punch results',
    labelZh: '打卡结果',
    targets: ['punchResultIn1', 'punchResultOut1', 'punchResultIn2', 'punchResultOut2', 'punchResultIn3', 'punchResultOut3'],
  },
  {
    key: 'status',
    labelEn: 'Status & exceptions',
    labelZh: '状态与异常',
    targets: ['status', 'exceptionReason'],
  },
  {
    key: 'durations',
    labelEn: 'Durations & hours',
    labelZh: '时长与工时',
    // leaveMinutes/overtimeMinutes are deliberately absent: they only carry
    // English API aliases (leave_hours/overtime_duration) and duplicate the
    // 请假小时/加班小时 semantics — including them would leak English column
    // names into the generated Chinese template.
    targets: ['workHours', 'workMinutes', 'lateMinutes', 'earlyLeaveMinutes', 'leaveHours', 'overtimeHours'],
  },
  {
    key: 'shift-group',
    labelEn: 'Shift & group',
    labelZh: '班次与分组',
    targets: ['shiftName', 'attendanceClass', 'attendanceGroup'],
  },
  {
    key: 'people',
    labelEn: 'People profile',
    labelZh: '人员画像',
    targets: ['department', 'role', 'entryTime', 'resignTime'],
  },
  {
    key: 'approval',
    labelEn: 'Approvals',
    labelZh: '审批关联',
    targets: ['approvalSummary'],
  },
]

const FIELD_MEANINGS: Record<string, { en: string; zh: string }> = {
  firstInAt: { en: 'First clock-in time of the day', zh: '当日第一次上班打卡时间' },
  lastOutAt: { en: 'Last clock-out time of the day', zh: '当日最后一次下班打卡时间' },
  clockIn2: { en: 'Second-slot clock-in', zh: '第二段上班打卡时间' },
  clockOut2: { en: 'Second-slot clock-out', zh: '第二段下班打卡时间' },
  clockIn3: { en: 'Third-slot clock-in', zh: '第三段上班打卡时间' },
  clockOut3: { en: 'Third-slot clock-out', zh: '第三段下班打卡时间' },
  punchResultIn1: { en: 'Result of clock-in #1', zh: '上班1打卡结果（正常/迟到…）' },
  punchResultOut1: { en: 'Result of clock-out #1', zh: '下班1打卡结果' },
  punchResultIn2: { en: 'Result of clock-in #2', zh: '上班2打卡结果' },
  punchResultOut2: { en: 'Result of clock-out #2', zh: '下班2打卡结果' },
  punchResultIn3: { en: 'Result of clock-in #3', zh: '上班3打卡结果' },
  punchResultOut3: { en: 'Result of clock-out #3', zh: '下班3打卡结果' },
  status: { en: 'Attendance result for the day', zh: '当日考勤结果（正常/迟到/缺卡…）' },
  exceptionReason: { en: 'Exception reason text', zh: '异常原因说明' },
  workHours: { en: 'Expected/total work hours', zh: '应出勤/总工时（小时）' },
  workMinutes: { en: 'Actual work duration', zh: '实出勤工时' },
  lateMinutes: { en: 'Late duration (minutes)', zh: '迟到时长（分钟）' },
  earlyLeaveMinutes: { en: 'Early-leave duration (minutes)', zh: '早退时长（分钟）' },
  leaveHours: { en: 'Leave hours (incl. comp leave)', zh: '请假/调休小时' },
  leaveMinutes: { en: 'Leave duration', zh: '请假时长' },
  overtimeHours: { en: 'Overtime hours', zh: '加班小时' },
  overtimeMinutes: { en: 'Overtime duration', zh: '加班时长' },
  shiftName: { en: 'Shift name (drives shift window)', zh: '班次名称（参与班次时间窗计算）' },
  attendanceClass: { en: 'Attendance class label', zh: '出勤班次标签' },
  attendanceGroup: { en: 'Attendance group name', zh: '考勤组名称' },
  department: { en: 'Department (also drives rules)', zh: '部门（可参与规则匹配）' },
  role: { en: 'Role/position (also drives rules)', zh: '职位（可参与规则匹配）' },
  entryTime: { en: 'Entry (hire) date', zh: '入职时间' },
  resignTime: { en: 'Resignation date', zh: '离职时间' },
  approvalSummary: { en: 'Linked approval summary', zh: '关联的审批单摘要' },
}

const CJK_RE = /[一-鿿]/

function normalizeCell(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Group the raw mapping columns into selectable, deduped, Chinese-first field
 * options. Aliases sharing a targetField merge into one option; the displayed
 * (and generated) column name prefers the first Chinese alias.
 */
export function groupSupportedImportColumns(
  columns: readonly AttendanceImportMappingColumnLike[] | null | undefined,
): AttendanceImportFieldGroup[] {
  const byTarget = new Map<string, { aliases: string[]; cjk: string | null }>()
  for (const column of Array.isArray(columns) ? columns : []) {
    const source = normalizeCell(column?.sourceField)
    const target = normalizeCell(column?.targetField)
    if (!source || !target) continue
    const entry = byTarget.get(target) ?? { aliases: [], cjk: null }
    if (!entry.aliases.includes(source)) entry.aliases.push(source)
    if (!entry.cjk && CJK_RE.test(source)) entry.cjk = source
    byTarget.set(target, entry)
  }

  const groups: AttendanceImportFieldGroup[] = []
  for (const def of GROUP_DEFS) {
    const options: AttendanceImportFieldOption[] = []
    for (const target of def.targets) {
      const entry = byTarget.get(target)
      if (!entry) continue
      const meaning = FIELD_MEANINGS[target] ?? { en: `Field ${target}`, zh: `字段 ${target}` }
      options.push({
        key: target,
        columnName: entry.cjk ?? entry.aliases[0],
        aliases: entry.aliases,
        meaningEn: meaning.en,
        meaningZh: meaning.zh,
      })
    }
    if (options.length > 0) {
      groups.push({ key: def.key, labelEn: def.labelEn, labelZh: def.labelZh, options })
    }
  }
  return groups
}

/** Default selection = the starter template's semantic fields. */
export const IMPORT_TEMPLATE_DEFAULT_SELECTED_KEYS = [
  'attendanceGroup',
  'firstInAt',
  'lastOutAt',
  'status',
  'exceptionReason',
] as const

/**
 * Assemble the template header from a selection: locked base columns first,
 * then selected fields in group/definition order (selection set order does
 * not matter). Unknown keys are ignored.
 */
export function buildTemplateHeaderFromSelection(
  groups: readonly AttendanceImportFieldGroup[],
  selectedKeys: ReadonlySet<string> | readonly string[],
): string[] {
  const selected = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys)
  const header: string[] = [...IMPORT_TEMPLATE_BASE_COLUMNS]
  for (const group of groups) {
    for (const option of group.options) {
      if (!selected.has(option.key)) continue
      if (!header.includes(option.columnName)) header.push(option.columnName)
    }
  }
  return header
}

/** All selectable keys across groups (for 全选). */
export function allSelectableImportFieldKeys(groups: readonly AttendanceImportFieldGroup[]): string[] {
  return groups.flatMap(group => group.options.map(option => option.key))
}
