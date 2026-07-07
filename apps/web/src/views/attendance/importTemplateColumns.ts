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
  dataType?: unknown
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
  /** backend dataType (date/datetime/time/hours/minutes/number/string) */
  dataType: string
  /** required cell format, from the dataType (column-formats design-lock) */
  formatEn: string
  formatZh: string
  /** a concrete example value for the column */
  example: string
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
 * Cell-format spec per backend dataType, anchored to the real import parser
 * (normalizeCsvWorkDate / parseImportedDateTime). Column-formats design-lock §1.
 */
export function formatSpecForDataType(dataType: string | null | undefined): { formatEn: string; formatZh: string; example: string } {
  switch (dataType) {
    case 'date':
      return { formatEn: 'YYYY-MM-DD', formatZh: 'YYYY-MM-DD', example: '2026-06-01' }
    case 'datetime':
    case 'time':
      return { formatEn: 'YYYY-MM-DD HH:mm (or HH:mm)', formatZh: 'YYYY-MM-DD HH:mm（或纯 HH:mm）', example: '2026-06-01 09:00' }
    case 'hours':
      return { formatEn: 'Hours (decimals allowed)', formatZh: '小时数（可小数）', example: '8.5' }
    case 'minutes':
      return { formatEn: 'Whole minutes', formatZh: '整数分钟', example: '15' }
    case 'number':
      return { formatEn: 'Number', formatZh: '数字', example: '0' }
    case 'string':
      return { formatEn: 'Text', formatZh: '文本', example: '正常' }
    default:
      return { formatEn: 'Text', formatZh: '文本', example: '—' }
  }
}

/** Curated realistic examples for text columns (overrides the generic string default). */
const STRING_EXAMPLE_OVERRIDES: Record<string, string> = {
  status: '正常',
  exceptionReason: '迟到',
  punchResultIn1: '正常',
  punchResultOut1: '正常',
  punchResultIn2: '正常',
  punchResultOut2: '正常',
  punchResultIn3: '正常',
  punchResultOut3: '正常',
  shiftName: '白班',
  attendanceClass: '标准班',
  attendanceGroup: '总部日班',
  department: '技术部',
  role: '工程师',
  approvalSummary: '年假 1 天',
}

/**
 * Group the raw mapping columns into selectable, deduped, Chinese-first field
 * options. Aliases sharing a targetField merge into one option; the displayed
 * (and generated) column name prefers the first Chinese alias.
 */
export function groupSupportedImportColumns(
  columns: readonly AttendanceImportMappingColumnLike[] | null | undefined,
): AttendanceImportFieldGroup[] {
  const byTarget = new Map<string, { aliases: string[]; cjk: string | null; dataType: string }>()
  for (const column of Array.isArray(columns) ? columns : []) {
    const source = normalizeCell(column?.sourceField)
    const target = normalizeCell(column?.targetField)
    if (!source || !target) continue
    const entry = byTarget.get(target) ?? { aliases: [], cjk: null, dataType: '' }
    if (!entry.aliases.includes(source)) entry.aliases.push(source)
    if (!entry.cjk && CJK_RE.test(source)) entry.cjk = source
    if (!entry.dataType) entry.dataType = normalizeCell(column?.dataType)
    byTarget.set(target, entry)
  }

  const groups: AttendanceImportFieldGroup[] = []
  for (const def of GROUP_DEFS) {
    const options: AttendanceImportFieldOption[] = []
    for (const target of def.targets) {
      const entry = byTarget.get(target)
      if (!entry) continue
      const meaning = FIELD_MEANINGS[target] ?? { en: `Field ${target}`, zh: `字段 ${target}` }
      const spec = formatSpecForDataType(entry.dataType)
      options.push({
        key: target,
        columnName: entry.cjk ?? entry.aliases[0],
        aliases: entry.aliases,
        meaningEn: meaning.en,
        meaningZh: meaning.zh,
        dataType: entry.dataType,
        formatEn: spec.formatEn,
        formatZh: spec.formatZh,
        example: entry.dataType === 'string' ? (STRING_EXAMPLE_OVERRIDES[target] ?? spec.example) : spec.example,
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

// ── Column format reference (column-formats design-lock) ──────────────────────

export type AttendanceImportColumnRequirement = 'required' | 'identity' | 'optional'

export interface AttendanceImportColumnFormatRow {
  column: string
  requirement: AttendanceImportColumnRequirement
  formatEn: string
  formatZh: string
  example: string
  meaningEn: string
  meaningZh: string
}

/**
 * Base columns every template carries, with their required semantics anchored
 * to the backend header gate (IMPORT_HEADER_DATE_KEYS + CONTEXT_KEYS): the date
 * is required; 工号/姓名 are the identity pair (at least one required).
 */
const IMPORT_TEMPLATE_BASE_COLUMN_SPECS: readonly AttendanceImportColumnFormatRow[] = [
  { column: '日期', requirement: 'required', formatEn: 'YYYY-MM-DD', formatZh: 'YYYY-MM-DD', example: '2026-06-01', meaningEn: 'Attendance date (required)', meaningZh: '考勤日期（必填）' },
  { column: '工号', requirement: 'identity', formatEn: 'Text', formatZh: '文本', example: 'EMP001', meaningEn: 'Employee no. (工号 or 姓名 required)', meaningZh: '员工工号（工号/姓名至少填一个）' },
  { column: '姓名', requirement: 'identity', formatEn: 'Text', formatZh: '文本', example: '张三', meaningEn: 'Name (工号 or 姓名 required)', meaningZh: '姓名（工号/姓名至少填一个）' },
]

/**
 * Build the column-format reference: base columns (with their required marks)
 * first, then every supported field (all optional) in group order. Powers the
 * "列格式说明" table so a user knows each column's format, example, and whether
 * it is required.
 */
export function buildImportColumnFormatRows(
  groups: readonly AttendanceImportFieldGroup[],
): AttendanceImportColumnFormatRow[] {
  const rows: AttendanceImportColumnFormatRow[] = [...IMPORT_TEMPLATE_BASE_COLUMN_SPECS]
  const seen = new Set(rows.map(row => row.column))
  for (const group of groups) {
    for (const option of group.options) {
      if (seen.has(option.columnName)) continue
      seen.add(option.columnName)
      rows.push({
        column: option.columnName,
        requirement: 'optional',
        formatEn: option.formatEn,
        formatZh: option.formatZh,
        example: option.example,
        meaningEn: option.meaningEn,
        meaningZh: option.meaningZh,
      })
    }
  }
  return rows
}

/**
 * Build the example-value row for a generated template header, so the
 * downloaded "selected fields" template carries a concrete sample line (like
 * the backend template.csv) — format-by-example per column. Columns without a
 * known example emit an empty cell.
 */
export function buildTemplateExampleRow(
  formatRows: readonly AttendanceImportColumnFormatRow[],
  header: readonly string[],
): string[] {
  const exampleByColumn = new Map(formatRows.map(row => [row.column, row.example]))
  return header.map(column => {
    const example = exampleByColumn.get(column)
    return example && example !== '—' ? example : ''
  })
}
