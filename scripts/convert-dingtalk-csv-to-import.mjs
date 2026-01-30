import fs from 'node:fs'
import path from 'node:path'

const [,, inputPath, outputPath, userMapPath] = process.argv

if (!inputPath) {
  console.error('Usage: node scripts/convert-dingtalk-csv-to-import.mjs <csvPath> [outputPath] [userMapPath]')
  process.exit(1)
}

const mappingColumns = [
  { sourceField: '1_on_duty_user_check_time', targetField: 'firstInAt', dataType: 'time' },
  { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
  { sourceField: '1_off_duty_user_check_time', targetField: 'lastOutAt', dataType: 'time' },
  { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
  { sourceField: '2_on_duty_user_check_time', targetField: 'clockIn2', dataType: 'time' },
  { sourceField: '上班2打卡时间', targetField: 'clockIn2', dataType: 'time' },
  { sourceField: '2_off_duty_user_check_time', targetField: 'clockOut2', dataType: 'time' },
  { sourceField: '下班2打卡时间', targetField: 'clockOut2', dataType: 'time' },
  { sourceField: 'attend_result', targetField: 'status', dataType: 'string' },
  { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
  { sourceField: '当天考勤情况', targetField: 'status', dataType: 'string' },
  { sourceField: '异常原因', targetField: 'exceptionReason', dataType: 'string' },
  { sourceField: 'attendance_work_time', targetField: 'workMinutes', dataType: 'hours' },
  { sourceField: '应出勤小时', targetField: 'workHours', dataType: 'hours' },
  { sourceField: '总工时', targetField: 'workHours', dataType: 'hours' },
  { sourceField: '实出勤工时(测试)', targetField: 'workHours', dataType: 'hours' },
  { sourceField: '实出勤工时', targetField: 'workMinutes', dataType: 'hours' },
  { sourceField: 'late_minute', targetField: 'lateMinutes', dataType: 'minutes' },
  { sourceField: '迟到时长', targetField: 'lateMinutes', dataType: 'minutes' },
  { sourceField: '迟到分钟', targetField: 'lateMinutes', dataType: 'minutes' },
  { sourceField: 'leave_early_minute', targetField: 'earlyLeaveMinutes', dataType: 'minutes' },
  { sourceField: '早退时长', targetField: 'earlyLeaveMinutes', dataType: 'minutes' },
  { sourceField: '早退分钟', targetField: 'earlyLeaveMinutes', dataType: 'minutes' },
  { sourceField: 'leave_hours', targetField: 'leaveMinutes', dataType: 'hours' },
  { sourceField: '请假小时', targetField: 'leaveHours', dataType: 'hours' },
  { sourceField: '调休小时', targetField: 'leaveHours', dataType: 'hours' },
  { sourceField: 'overtime_duration', targetField: 'overtimeMinutes', dataType: 'hours' },
  { sourceField: '加班小时', targetField: 'overtimeHours', dataType: 'hours' },
  { sourceField: '加班总时长', targetField: 'overtimeHours', dataType: 'hours' },
  { sourceField: 'plan_detail', targetField: 'shiftName', dataType: 'string' },
  { sourceField: '班次', targetField: 'shiftName', dataType: 'string' },
  { sourceField: 'attendance_class', targetField: 'attendanceClass', dataType: 'string' },
  { sourceField: '出勤班次', targetField: 'attendanceClass', dataType: 'string' },
  { sourceField: 'attendance_approve', targetField: 'approvalSummary', dataType: 'string' },
  { sourceField: '关联的审批单', targetField: 'approvalSummary', dataType: 'string' },
  { sourceField: 'attendance_group', targetField: 'attendanceGroup', dataType: 'string' },
  { sourceField: '考勤组', targetField: 'attendanceGroup', dataType: 'string' },
  { sourceField: '部门', targetField: 'department', dataType: 'string' },
  { sourceField: '职位', targetField: 'role', dataType: 'string' },
  { sourceField: '职位', targetField: 'roleTags', dataType: 'string' },
  { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
  { sourceField: '姓名', targetField: 'userName', dataType: 'string' },
]

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"'
        i += 1
        continue
      }
      inQuotes = !inQuotes
      continue
    }
    if (char === ',' && !inQuotes) {
      row.push(field)
      field = ''
      continue
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        i += 1
      }
      row.push(field)
      field = ''
      const hasValue = row.some(cell => String(cell).trim() !== '')
      if (hasValue) rows.push(row)
      row = []
      continue
    }
    field += char
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    const hasValue = row.some(cell => String(cell).trim() !== '')
    if (hasValue) rows.push(row)
  }
  return rows
}

function findHeaderIndex(rows) {
  const target = ['姓名', '日期', '考勤组', '工号', 'UserId', 'userId']
  for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
    const row = rows[i]
    const matchCount = target.filter(item => row.includes(item)).length
    if (matchCount >= 2) return i
  }
  return 0
}

function parseWorkDate(value) {
  if (!value) return null
  const text = String(value).trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{2}-\d{2}-\d{2}/.test(text)) {
    const parts = text.slice(0, 8).split('-')
    return `20${parts[0]}-${parts[1]}-${parts[2]}`
  }
  if (/^\d+$/.test(text)) {
    const ms = Number(text)
    if (Number.isFinite(ms) && ms > 0) {
      return new Date(ms).toISOString().slice(0, 10)
    }
  }
  const match = text.match(/\d{4}-\d{2}-\d{2}/)
  if (match) return match[0]
  return null
}

const csvText = fs.readFileSync(inputPath, 'utf-8').replace(/^\uFEFF/, '')
const rows = parseCsv(csvText)
const headerIndex = findHeaderIndex(rows)
const header = rows[headerIndex]
const dataRows = rows.slice(headerIndex + 1)

const userMap = userMapPath ? JSON.parse(fs.readFileSync(userMapPath, 'utf-8')) : null
const normalizedUserMap = userMap?.mapping ?? userMap

const output = {
  source: 'dingtalk_csv',
  timezone: 'Asia/Shanghai',
  userMapKeyField: 'empNo',
  userMapSourceFields: ['sourceUserKey', '工号', 'empNo'],
  userMap: normalizedUserMap ?? undefined,
  mapping: { columns: mappingColumns },
  statusMap: {
    正常: 'normal',
    迟到: 'late',
    早退: 'early_leave',
    迟到早退: 'late_early',
    缺卡: 'partial',
    未打卡: 'absent',
    旷工: 'absent',
    补卡: 'adjusted',
    外出: 'adjusted',
    外勤: 'adjusted',
    出差: 'adjusted',
    事假: 'adjusted',
    病假: 'adjusted',
    工伤假: 'adjusted',
    调休: 'adjusted',
    休息: 'off',
  },
  rows: [],
}

for (const row of dataRows) {
  if (row.length === 0) continue
  const fields = {}
  header.forEach((key, idx) => {
    if (!key) return
    fields[key] = row[idx] ?? ''
  })
  const workDate = parseWorkDate(fields.workDate ?? fields.日期)
  if (!workDate) continue
  let userId = fields.UserId || fields.userId || ''
  if (!userId && normalizedUserMap) {
    const empNo = fields.empNo || fields.工号 || fields.sourceUserKey || fields.钉钉账号 || ''
    if (empNo && normalizedUserMap[empNo]) {
      const mapped = normalizedUserMap[empNo]
      userId = mapped.userId || mapped.id || mapped.user_id || ''
    }
  }
  const record = {
    workDate,
    fields,
  }
  if (userId) record.userId = String(userId)
  output.rows.push(record)
}

const defaultName = path.basename(inputPath).replace(/\.csv$/i, '')
const outPath = outputPath || path.join(path.dirname(inputPath), `${defaultName}-import.json`)
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8')
console.log(`Wrote ${outPath} (rows=${output.rows.length})`)
