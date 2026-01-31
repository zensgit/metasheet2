const { randomUUID } = require('crypto')
const { z } = require('zod')
const { createRuleEngine } = require('./engine/index.cjs')

const DEFAULT_ORG_ID = 'default'
const DEFAULT_RULE = {
  orgId: DEFAULT_ORG_ID,
  name: 'Default',
  timezone: 'UTC',
  workStartTime: '09:00',
  workEndTime: '18:00',
  lateGraceMinutes: 10,
  earlyGraceMinutes: 10,
  roundingMinutes: 5,
  workingDays: [1, 2, 3, 4, 5],
  isDefault: true,
}
const DEFAULT_SHIFT = {
  orgId: DEFAULT_ORG_ID,
  name: 'Standard Shift',
  timezone: DEFAULT_RULE.timezone,
  workStartTime: DEFAULT_RULE.workStartTime,
  workEndTime: DEFAULT_RULE.workEndTime,
  lateGraceMinutes: DEFAULT_RULE.lateGraceMinutes,
  earlyGraceMinutes: DEFAULT_RULE.earlyGraceMinutes,
  roundingMinutes: DEFAULT_RULE.roundingMinutes,
  workingDays: [...DEFAULT_RULE.workingDays],
}
const REQUEST_TYPES = [
  'missed_check_in',
  'missed_check_out',
  'time_correction',
  'leave',
  'overtime',
]

const SETTINGS_KEY = 'attendance.settings'
const SETTINGS_CACHE_TTL_MS = 60000
const DEFAULT_SETTINGS = {
  autoAbsence: {
    enabled: false,
    runAt: '00:15',
    lookbackDays: 1,
  },
  ipAllowlist: [],
  geoFence: null,
  minPunchIntervalMinutes: 1,
}

const allowRbacDegradation = process.env.RBAC_OPTIONAL === '1'
let rbacDegraded = false
let autoAbsenceTimeout = null
let autoAbsenceInterval = null
let lastAutoAbsenceKey = ''
let settingsCache = { value: DEFAULT_SETTINGS, loadedAt: 0 }

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function isDatabaseSchemaError(error) {
  if (error?.code === '42P01') return true
  if (error?.code === '42703') return true
  if (typeof error?.message === 'string') {
    const msg = error.message.toLowerCase()
    if ((msg.includes('relation') || msg.includes('table')) && msg.includes('does not exist')) {
      return true
    }
    if (msg.includes('column') && msg.includes('does not exist')) {
      return true
    }
  }
  return false
}

function parsePagination(query, options = {}) {
  const {
    defaultPage = 1,
    defaultPageSize = 50,
    maxPageSize = 200,
    minPageSize = 1,
  } = options

  const page = Math.max(parseInt(String(query.page || defaultPage), 10), 1)
  const pageSize = Math.min(
    Math.max(parseInt(String(query.pageSize || defaultPageSize), 10), minPageSize),
    maxPageSize,
  )
  const offset = (page - 1) * pageSize

  return { page, pageSize, offset }
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  return fallback
}

function parseNumber(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return parsed
}

function getUserId(req) {
  const user = req.user
  const headerUserId = req.headers['x-user-id']
  const header = Array.isArray(headerUserId) ? headerUserId[0] : headerUserId
  const raw = user?.id ?? user?.sub ?? user?.userId ?? header
  if (typeof raw === 'string' && raw.trim().length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return null
}

function getOrgId(req) {
  const user = req.user
  const headerOrg = req.headers['x-org-id']
  const header = Array.isArray(headerOrg) ? headerOrg[0] : headerOrg
  const raw = req.body?.orgId ?? req.query?.orgId ?? user?.orgId ?? user?.workspaceId ?? header
  if (typeof raw === 'string' && raw.trim().length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return DEFAULT_ORG_ID
}

function getUserLabel(req, fallback) {
  const user = req.user
  if (typeof user?.name === 'string' && user.name.trim().length > 0) return user.name
  if (typeof user?.email === 'string' && user.email.trim().length > 0) return user.email
  return fallback
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const raw = header ? String(header).split(',')[0]?.trim() : req.ip
  if (!raw) return ''
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

function isIpAllowed(ip, allowlist) {
  if (!allowlist || allowlist.length === 0) return true
  const normalized = ip.trim()
  return allowlist.some((entry) => {
    if (!entry) return false
    const rule = entry.trim()
    if (!rule) return false
    if (rule.endsWith('*')) {
      const prefix = rule.slice(0, -1)
      return normalized.startsWith(prefix)
    }
    if (rule.includes('/')) {
      const [base, mask] = rule.split('/')
      if (mask === '32') return normalized === base
      if (mask === '24') {
        const prefix = base.split('.').slice(0, 3).join('.') + '.'
        return normalized.startsWith(prefix)
      }
      return normalized === base
    }
    return normalized === rule
  })
}

function toRadians(deg) {
  return (deg * Math.PI) / 180
}

function distanceInMeters(a, b) {
  const earthRadius = 6371000
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)
  const dLat = toRadians(b.lat - a.lat)
  const dLng = toRadians(b.lng - a.lng)
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)))
}

function isGeoAllowed(location, fence) {
  if (!fence) return true
  if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
    return false
  }
  const radius = Number(fence.radiusMeters ?? 0)
  if (!Number.isFinite(radius) || radius <= 0) return false
  const dist = distanceInMeters({ lat: location.lat, lng: location.lng }, fence)
  return dist <= radius
}

function parseDateInput(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date
}

function normalizeStatusLabel(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!text) return null
  const normalized = text.toLowerCase()
  const map = {
    normal: 'normal',
    ok: 'normal',
    '正常': 'normal',
    late: 'late',
    '迟到': 'late',
    '早退': 'early_leave',
    early: 'early_leave',
    '迟到早退': 'late_early',
    'late+early': 'late_early',
    partial: 'partial',
    '缺卡': 'partial',
    '补卡': 'adjusted',
    adjusted: 'adjusted',
    absent: 'absent',
    '旷工': 'absent',
    off: 'off',
    '休息': 'off',
  }
  return map[text] ?? map[normalized] ?? normalized.replace(/\s+/g, '_')
}

function resolveStatusOverride(value, statusMap) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!text) return null
  if (statusMap && typeof statusMap === 'object') {
    const direct = statusMap[text] ?? statusMap[text.toLowerCase()]
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
    const keys = Object.keys(statusMap)
    let bestMatch = null
    for (const key of keys) {
      if (!key) continue
      const lowerKey = String(key).toLowerCase()
      const lowerText = text.toLowerCase()
      if (lowerText.startsWith(lowerKey) || lowerText.includes(lowerKey)) {
        if (!bestMatch || key.length > bestMatch.length) bestMatch = key
      }
    }
    if (bestMatch && typeof statusMap[bestMatch] === 'string') {
      return String(statusMap[bestMatch]).trim()
    }
  }
  return normalizeStatusLabel(text)
}

function parseMinutesValue(value, dataType) {
  if (value === null || value === undefined || value === '') return null
  const numeric = parseNumber(value, null)
  if (!Number.isFinite(numeric)) return null
  const type = typeof dataType === 'string' ? dataType.toLowerCase() : ''
  if (type.includes('hour')) return Math.round(numeric * 60)
  if (type.includes('minute')) return Math.round(numeric)
  return Math.round(numeric)
}

function buildZonedDate(dateString, timeString, timeZone) {
  const dateParts = String(dateString).split('-').map(item => Number(item))
  if (dateParts.length !== 3 || dateParts.some(item => !Number.isFinite(item))) return null
  const [year, month, day] = dateParts
  const timeParts = String(timeString).split(':').map(item => Number(item))
  if (timeParts.length < 2 || timeParts.some(item => !Number.isFinite(item))) return null
  const [hour, minute, second] = [timeParts[0], timeParts[1], timeParts[2] ?? 0]
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (!timeZone) return utcDate
  try {
    const tzDate = new Date(utcDate.toLocaleString('en-US', { timeZone }))
    const offsetMs = utcDate.getTime() - tzDate.getTime()
    return new Date(utcDate.getTime() + offsetMs)
  } catch {
    return utcDate
  }
}

function parseImportedDateTime(value, workDate, timeZone) {
  if (!value) return null
  if (value instanceof Date) return value
  const text = String(value).trim()
  if (!text) return null
  const dateMatch = text.match(/\d{4}-\d{2}-\d{2}/)
  const timeMatch = text.match(/\d{2}:\d{2}(:\d{2})?/)
  if (dateMatch && timeMatch) {
    return buildZonedDate(dateMatch[0], timeMatch[0], timeZone)
  }
  if (timeMatch && workDate) {
    return buildZonedDate(workDate, timeMatch[0], timeZone)
  }
  return parseDateInput(text)
}

function buildDingTalkFieldMap(columns) {
  const map = new Map()
  if (!Array.isArray(columns)) return map
  for (const column of columns) {
    const id = column?.id ?? column?.column_id ?? column?.columnId
    if (id === undefined || id === null) continue
    const key = String(id)
    const alias = typeof column.alias === 'string' && column.alias.trim().length > 0 ? column.alias.trim() : null
    const name = typeof column.name === 'string' && column.name.trim().length > 0 ? column.name.trim() : null
    map.set(key, { id: key, alias, name })
  }
  return map
}

function buildRowsFromDingTalk({ columns, data }) {
  const map = buildDingTalkFieldMap(columns)
  const rowsByDate = new Map()
  const columnVals = data?.column_vals
  if (!Array.isArray(columnVals)) return []
  for (const columnEntry of columnVals) {
    const colId = columnEntry?.column_vo?.id ?? columnEntry?.column_vo?.column_id ?? columnEntry?.columnId
    if (colId === undefined || colId === null) continue
    const columnInfo = map.get(String(colId)) ?? { id: String(colId) }
    const keys = []
    if (columnInfo.alias) keys.push(columnInfo.alias)
    if (columnInfo.name) keys.push(columnInfo.name)
    keys.push(`col_${columnInfo.id}`)
    const values = Array.isArray(columnEntry?.column_vals) ? columnEntry.column_vals : []
    for (const entry of values) {
      const dateRaw = entry?.date
      if (!dateRaw) continue
      const dateKey = String(dateRaw).slice(0, 10)
      if (!rowsByDate.has(dateKey)) {
        rowsByDate.set(dateKey, { workDate: dateKey, fields: {} })
      }
      const row = rowsByDate.get(dateKey)
      const rawValue = entry?.value ?? entry?.date ?? ''
      for (const key of keys) {
        if (key && row.fields[key] === undefined) {
          row.fields[key] = rawValue
        }
      }
    }
  }
  return Array.from(rowsByDate.values())
}

function buildRowsFromEntries({ entries }) {
  if (!Array.isArray(entries)) return []
  const rowsByKey = new Map()
  for (const entry of entries) {
    const meta = entry?.meta ?? {}
    const workDate = entry?.workDate ?? meta.workDate ?? (entry?.occurredAt ? String(entry.occurredAt).slice(0, 10) : null)
    if (!workDate) continue
    const userId = entry?.userId ?? meta.userId
    const rowKey = `${userId ?? meta.sourceUserKey ?? 'unknown'}|${workDate}`
    if (!rowsByKey.has(rowKey)) {
      rowsByKey.set(rowKey, { workDate, fields: {}, userId })
    }
    const row = rowsByKey.get(rowKey)
    if (!row.userId && userId) row.userId = userId
    const column = meta.column ?? entry?.column ?? entry?.field
    const rawValue = meta.rawTime ?? meta.value ?? entry?.value ?? entry?.occurredAt ?? ''
    if (column && row.fields[column] === undefined) {
      row.fields[column] = rawValue
    }
    if (meta.sourceUserKey && row.fields.sourceUserKey === undefined) {
      row.fields.sourceUserKey = meta.sourceUserKey
    }
    if (meta.sourceUserName && row.fields.sourceUserName === undefined) {
      row.fields.sourceUserName = meta.sourceUserName
    }
    if (meta.sourceUserKey && row.fields.empNo === undefined) {
      row.fields.empNo = meta.sourceUserKey
    }
    if (entry?.eventType && row.fields.eventType === undefined) {
      row.fields.eventType = entry.eventType
    }
  }
  return Array.from(rowsByKey.values())
}

function resolveUserMapValue(userMap, key) {
  if (!userMap || !key) return null
  const entry = userMap[key]
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    return entry.userId ?? entry.id ?? entry.user_id ?? null
  }
  return null
}

function resolveRowUserId({ row, fallbackUserId, userMap, userMapKeyField, userMapSourceFields }) {
  if (!row) return fallbackUserId ?? null
  if (row.userId) return row.userId
  if (row.user_id) return row.user_id
  const fields = row.fields ?? {}
  const direct = fields.userId ?? fields.user_id
  if (direct) return direct
  const candidates = []
  if (userMapKeyField) candidates.push(userMapKeyField)
  if (Array.isArray(userMapSourceFields)) candidates.push(...userMapSourceFields)
  candidates.push('empNo', '工号', 'sourceUserKey', 'userKey', 'userName', '姓名')
  for (const key of candidates) {
    if (!key) continue
    const value = fields[key]
    if (value === null || value === undefined || value === '') continue
    const mapped = resolveUserMapValue(userMap, String(value).trim())
    if (mapped) return mapped
  }
  return fallbackUserId ?? null
}

function applyFieldMappings(fields, mappings) {
  const normalized = {}
  if (!Array.isArray(mappings)) return normalized
  for (const mapping of mappings) {
    const sourceField = mapping?.sourceField
    const targetField = mapping?.targetField
    if (!sourceField || !targetField) continue
    if (fields[sourceField] === undefined) continue
    normalized[targetField] = {
      value: fields[sourceField],
      dataType: mapping?.dataType,
    }
  }
  return normalized
}

function getUtcParts(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
  }
}

function addMonthsUtc(year, month, delta) {
  const date = new Date(Date.UTC(year, month, 1))
  date.setUTCMonth(date.getUTCMonth() + delta)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() }
}

function daysInMonthUtc(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

function buildUtcDate(year, month, day) {
  const safeDay = Math.min(Math.max(day, 1), daysInMonthUtc(year, month))
  return new Date(Date.UTC(year, month, safeDay))
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10)
}

function resolvePayrollWindow(template, anchorDate) {
  const anchor = anchorDate ?? new Date()
  const { year, month, day } = getUtcParts(anchor)
  const startDay = Number(template.startDay ?? template.start_day ?? 1)
  const endDay = Number(template.endDay ?? template.end_day ?? 30)
  const offset = Number(template.endMonthOffset ?? template.end_month_offset ?? 0)

  const startMonthOffset = day >= startDay ? 0 : -1
  const startAnchor = addMonthsUtc(year, month, startMonthOffset)
  const startDate = buildUtcDate(startAnchor.year, startAnchor.month, startDay)

  const endAnchor = addMonthsUtc(startAnchor.year, startAnchor.month, offset)
  const endDate = buildUtcDate(endAnchor.year, endAnchor.month, endDay)

  return {
    startDate: formatDateOnly(startDate),
    endDate: formatDateOnly(endDate),
  }
}

function normalizeRuleOverride(value) {
  if (!value || typeof value !== 'object') return null
  const override = value
  const workingDays = Array.isArray(override.workingDays)
    ? override.workingDays.map(day => Number(day)).filter(day => Number.isFinite(day) && day >= 0 && day <= 6)
    : undefined
  return {
    timezone: typeof override.timezone === 'string' && override.timezone.trim().length > 0
      ? override.timezone.trim()
      : undefined,
    workStartTime: typeof override.workStartTime === 'string' && override.workStartTime.trim().length > 0
      ? override.workStartTime.trim()
      : undefined,
    workEndTime: typeof override.workEndTime === 'string' && override.workEndTime.trim().length > 0
      ? override.workEndTime.trim()
      : undefined,
    lateGraceMinutes: Number.isFinite(Number(override.lateGraceMinutes))
      ? Math.max(0, Number(override.lateGraceMinutes))
      : undefined,
    earlyGraceMinutes: Number.isFinite(Number(override.earlyGraceMinutes))
      ? Math.max(0, Number(override.earlyGraceMinutes))
      : undefined,
    roundingMinutes: Number.isFinite(Number(override.roundingMinutes))
      ? Math.max(0, Number(override.roundingMinutes))
      : undefined,
    workingDays: workingDays && workingDays.length > 0 ? workingDays : undefined,
  }
}

function normalizeWorkingDays(value) {
  if (Array.isArray(value)) {
    return value.map(v => Number(v)).filter(v => Number.isFinite(v))
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return normalizeWorkingDays(parsed)
    } catch {
      return [...DEFAULT_RULE.workingDays]
    }
  }
  return [...DEFAULT_RULE.workingDays]
}

function mapRuleRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    name: row.name ?? DEFAULT_RULE.name,
    timezone: row.timezone ?? DEFAULT_RULE.timezone,
    workStartTime: row.work_start_time ?? DEFAULT_RULE.workStartTime,
    workEndTime: row.work_end_time ?? DEFAULT_RULE.workEndTime,
    lateGraceMinutes: Number(row.late_grace_minutes ?? DEFAULT_RULE.lateGraceMinutes),
    earlyGraceMinutes: Number(row.early_grace_minutes ?? DEFAULT_RULE.earlyGraceMinutes),
    roundingMinutes: Number(row.rounding_minutes ?? DEFAULT_RULE.roundingMinutes),
    workingDays: normalizeWorkingDays(row.working_days),
    isDefault: row.is_default ?? true,
  }
}

function mapShiftRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    name: row.name ?? DEFAULT_SHIFT.name,
    timezone: row.timezone ?? DEFAULT_SHIFT.timezone,
    workStartTime: row.work_start_time ?? DEFAULT_SHIFT.workStartTime,
    workEndTime: row.work_end_time ?? DEFAULT_SHIFT.workEndTime,
    lateGraceMinutes: Number(row.late_grace_minutes ?? DEFAULT_SHIFT.lateGraceMinutes),
    earlyGraceMinutes: Number(row.early_grace_minutes ?? DEFAULT_SHIFT.earlyGraceMinutes),
    roundingMinutes: Number(row.rounding_minutes ?? DEFAULT_SHIFT.roundingMinutes),
    workingDays: normalizeWorkingDays(row.working_days),
  }
}

function mapAssignmentRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    userId: row.user_id,
    shiftId: row.shift_id,
    startDate: row.start_date,
    endDate: row.end_date ?? null,
    isActive: row.is_active ?? true,
  }
}

function mapShiftFromAssignmentRow(row) {
  return mapShiftRow({
    id: row.shift_id,
    org_id: row.org_id ?? DEFAULT_ORG_ID,
    name: row.shift_name,
    timezone: row.shift_timezone,
    work_start_time: row.shift_work_start_time,
    work_end_time: row.shift_work_end_time,
    late_grace_minutes: row.shift_late_grace_minutes,
    early_grace_minutes: row.shift_early_grace_minutes,
    rounding_minutes: row.shift_rounding_minutes,
    working_days: row.shift_working_days,
  })
}

function mapHolidayRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    date: row.holiday_date,
    name: row.name ?? null,
    isWorkingDay: row.is_working_day ?? false,
  }
}

function mapRuleSetRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    name: row.name,
    description: row.description ?? null,
    version: Number(row.version ?? 1),
    scope: row.scope ?? 'org',
    config: normalizeMetadata(row.config),
    isDefault: row.is_default ?? false,
  }
}

function mapPayrollTemplateRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    name: row.name,
    timezone: row.timezone ?? 'UTC',
    startDay: Number(row.start_day ?? 1),
    endDay: Number(row.end_day ?? 30),
    endMonthOffset: Number(row.end_month_offset ?? 0),
    autoGenerate: row.auto_generate ?? true,
    config: normalizeMetadata(row.config),
    isDefault: row.is_default ?? false,
  }
}

function mapPayrollCycleRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    templateId: row.template_id ?? null,
    name: row.name ?? null,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status ?? 'open',
    metadata: normalizeMetadata(row.metadata),
  }
}

function normalizeJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : fallback
    } catch {
      return fallback
    }
  }
  return fallback
}

function normalizeStringArray(value) {
  return normalizeJsonArray(value, []).map(item => String(item)).filter(Boolean)
}

function normalizeMetadata(value) {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' ? value : {}
}

function mapLeaveTypeRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    code: row.code,
    name: row.name,
    requiresApproval: row.requires_approval ?? true,
    requiresAttachment: row.requires_attachment ?? false,
    defaultMinutesPerDay: Number(row.default_minutes_per_day ?? 480),
    isActive: row.is_active ?? true,
  }
}

function mapOvertimeRuleRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    name: row.name,
    minMinutes: Number(row.min_minutes ?? 0),
    roundingMinutes: Number(row.rounding_minutes ?? 15),
    maxMinutesPerDay: Number(row.max_minutes_per_day ?? 600),
    requiresApproval: row.requires_approval ?? true,
    isActive: row.is_active ?? true,
  }
}

function mapApprovalFlowRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    name: row.name,
    requestType: row.request_type,
    steps: normalizeJsonArray(row.steps, []).filter(step => step && typeof step === 'object'),
    isActive: row.is_active ?? true,
  }
}

function mapRotationRuleRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    name: row.name,
    timezone: row.timezone ?? 'UTC',
    shiftSequence: normalizeStringArray(row.shift_sequence),
    isActive: row.is_active ?? true,
  }
}

function mapRotationAssignmentRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    userId: row.user_id,
    rotationRuleId: row.rotation_rule_id,
    startDate: row.start_date,
    endDate: row.end_date ?? null,
    isActive: row.is_active ?? true,
  }
}

function mapRotationRuleFromAssignmentRow(row) {
  return mapRotationRuleRow({
    id: row.rotation_rule_id,
    org_id: row.org_id ?? DEFAULT_ORG_ID,
    name: row.rotation_name,
    timezone: row.rotation_timezone,
    shift_sequence: row.rotation_shift_sequence,
    is_active: row.rotation_is_active,
  })
}

function toWorkDate(value, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(value)
  } catch {
    return value.toISOString().slice(0, 10)
  }
}

function getZonedMinutes(value, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(value)
    const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0')
    const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0')
    return hour * 60 + minute
  } catch {
    return value.getUTCHours() * 60 + value.getUTCMinutes()
  }
}

function parseTimeToMinutes(value, fallback) {
  if (!value) return fallback
  const [hours, minutes] = value.split(':')
  const h = Number(hours)
  const m = Number(minutes)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return fallback
  return h * 60 + m
}

function roundMinutes(value, step) {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (!Number.isFinite(step) || step <= 1) return Math.floor(value)
  return Math.floor(value / step) * step
}

function calculateDurationMinutes(startAt, endAt) {
  if (!startAt || !endAt) return null
  const diff = (endAt.getTime() - startAt.getTime()) / 60000
  if (!Number.isFinite(diff) || diff <= 0) return null
  return Math.floor(diff)
}

function applyOvertimeRule(minutes, rule) {
  if (!rule) return minutes
  const minMinutes = Math.max(0, Number(rule.minMinutes ?? 0))
  const rounding = Math.max(1, Number(rule.roundingMinutes ?? 1))
  const maxMinutes = Math.max(0, Number(rule.maxMinutesPerDay ?? 0))
  let adjusted = minutes
  if (Number.isFinite(minMinutes) && adjusted < minMinutes) adjusted = minMinutes
  if (Number.isFinite(rounding) && rounding > 1) {
    adjusted = Math.ceil(adjusted / rounding) * rounding
  }
  if (Number.isFinite(maxMinutes) && maxMinutes > 0) {
    adjusted = Math.min(adjusted, maxMinutes)
  }
  return adjusted
}

function diffDays(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00Z`)
  const to = new Date(`${toDate}T00:00:00Z`)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0
  const diffMs = to.getTime() - from.getTime()
  return Math.floor(diffMs / (1000 * 60 * 60 * 24))
}

function computeMetrics(options) {
  const { rule, firstInAt, lastOutAt, isWorkingDay, leaveMinutes, overtimeMinutes } = options

  if (!isWorkingDay) {
    if (!firstInAt && !lastOutAt) {
      return { workMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, status: 'off' }
    }
    if (!firstInAt || !lastOutAt) {
      return { workMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, status: 'off' }
    }
    const rawMinutes = Math.max(0, Math.floor((lastOutAt.getTime() - firstInAt.getTime()) / 60000))
    const workMinutes = roundMinutes(rawMinutes, rule.roundingMinutes)
    return { workMinutes, lateMinutes: 0, earlyLeaveMinutes: 0, status: 'off' }
  }

  if (!firstInAt && !lastOutAt) {
    if (Number(leaveMinutes ?? 0) > 0) {
      return { workMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, status: 'adjusted' }
    }
    return { workMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, status: 'absent' }
  }

  if (!firstInAt || !lastOutAt) {
    return { workMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, status: 'partial' }
  }

  const rawMinutes = Math.max(0, Math.floor((lastOutAt.getTime() - firstInAt.getTime()) / 60000))
  const workMinutes = roundMinutes(rawMinutes, rule.roundingMinutes)

  const startMinutes = parseTimeToMinutes(rule.workStartTime, 9 * 60)
  const endMinutes = parseTimeToMinutes(rule.workEndTime, 18 * 60)
  const firstInMinutes = getZonedMinutes(firstInAt, rule.timezone)
  const lastOutMinutes = getZonedMinutes(lastOutAt, rule.timezone)

  const lateThreshold = startMinutes + Math.max(0, rule.lateGraceMinutes)
  const earlyThreshold = endMinutes - Math.max(0, rule.earlyGraceMinutes)

  const lateMinutes = Math.max(0, firstInMinutes - lateThreshold)
  const earlyLeaveMinutes = Math.max(0, earlyThreshold - lastOutMinutes)

  let status = 'normal'
  if (lateMinutes > 0 && earlyLeaveMinutes > 0) status = 'late_early'
  else if (lateMinutes > 0) status = 'late'
  else if (earlyLeaveMinutes > 0) status = 'early_leave'
  else if (Number(leaveMinutes ?? 0) > 0 || Number(overtimeMinutes ?? 0) > 0) status = 'adjusted'

  return { workMinutes, lateMinutes, earlyLeaveMinutes, status }
}

function normalizeComparableValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value
  const text = String(value).trim()
  if (!text) return ''
  const lower = text.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const num = Number(text)
    if (Number.isFinite(num)) return num
  }
  return text
}

function valuesEqual(left, right) {
  const lhs = normalizeComparableValue(left)
  const rhs = normalizeComparableValue(right)
  if (lhs === null || rhs === null) return false
  if (typeof lhs === 'number' && typeof rhs === 'number') return lhs === rhs
  if (typeof lhs === 'boolean' && typeof rhs === 'boolean') return lhs === rhs
  return String(lhs).toLowerCase() === String(rhs).toLowerCase()
}

function fieldHasValue(value) {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

function matchFieldEquals(actual, expected) {
  if (Array.isArray(expected)) {
    return expected.some(item => valuesEqual(actual, item))
  }
  if (Array.isArray(actual)) {
    return actual.some(item => valuesEqual(item, expected))
  }
  return valuesEqual(actual, expected)
}

function matchFieldIn(actual, expectedList) {
  if (!Array.isArray(expectedList)) return false
  if (Array.isArray(actual)) {
    return actual.some(item => expectedList.some(expected => valuesEqual(item, expected)))
  }
  return expectedList.some(expected => valuesEqual(actual, expected))
}

function matchFieldContains(actual, expectedText) {
  if (actual === null || actual === undefined || expectedText === null || expectedText === undefined) return false
  const source = String(actual).toLowerCase()
  const target = String(expectedText).toLowerCase()
  return source.includes(target)
}

function normalizeNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed)
      return Number.isFinite(num) ? num : null
    }
  }
  return null
}

function normalizeDateOnly(value) {
  if (!value) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }
  const raw = String(value).trim()
  if (!raw) return null
  if (/^\d{10,13}$/.test(raw)) {
    const ts = Number(raw.length === 10 ? `${raw}000` : raw)
    if (Number.isFinite(ts)) return new Date(ts).toISOString().slice(0, 10)
  }
  const match = raw.match(/(\d{2,4})-(\d{1,2})-(\d{1,2})/)
  if (match) {
    let year = match[1]
    const month = match[2].padStart(2, '0')
    const day = match[3].padStart(2, '0')
    if (year.length === 2) year = `20${year}`
    return `${year.padStart(4, '0')}-${month}-${day}`
  }
  if (raw.includes('T')) return raw.slice(0, 10)
  if (raw.includes(' ')) return raw.split(' ')[0]
  return raw.slice(0, 10)
}

function augmentFieldValuesWithDates(fieldValues, workDate) {
  if (!fieldValues || typeof fieldValues !== 'object') return fieldValues
  const normalizedWorkDate = normalizeDateOnly(workDate)
  const entryDate = normalizeDateOnly(
    fieldValues.entryTime ?? fieldValues.entry_time ?? fieldValues['入职时间']
  )
  const resignDate = normalizeDateOnly(
    fieldValues.resignTime ?? fieldValues.resign_time ?? fieldValues['离职时间']
  )

  if (normalizedWorkDate) fieldValues.workDate = normalizedWorkDate
  if (entryDate) fieldValues.entry_date = entryDate
  if (resignDate) fieldValues.resign_date = resignDate

  if (normalizedWorkDate) {
    fieldValues.entry_after_work_date = entryDate ? entryDate > normalizedWorkDate : false
    fieldValues.entry_on_or_before_work_date = entryDate ? entryDate <= normalizedWorkDate : true
    fieldValues.resign_on_or_before_work_date = resignDate ? resignDate <= normalizedWorkDate : false
    fieldValues.resign_before_work_date = resignDate ? resignDate < normalizedWorkDate : false
  }

  return fieldValues
}

function matchesNumberGte(actual, expected) {
  const actualNum = normalizeNumber(actual)
  const expectedNum = normalizeNumber(expected)
  if (actualNum === null || expectedNum === null) return false
  return actualNum >= expectedNum
}

function matchesNumberLte(actual, expected) {
  const actualNum = normalizeNumber(actual)
  const expectedNum = normalizeNumber(expected)
  if (actualNum === null || expectedNum === null) return false
  return actualNum <= expectedNum
}

function buildFieldValueMap(rawFields, mappedFields) {
  const values = { ...(rawFields || {}) }
  if (mappedFields && typeof mappedFields === 'object') {
    for (const [key, detail] of Object.entries(mappedFields)) {
      if (detail && Object.prototype.hasOwnProperty.call(detail, 'value')) {
        values[key] = detail.value
      }
    }
  }
  return values
}

function resolveUserGroups(userGroups, facts, fieldValues) {
  const groups = new Set()
  if (!Array.isArray(userGroups)) return groups
  for (const group of userGroups) {
    if (!group || typeof group !== 'object') continue
    const name = String(group.name ?? '').trim()
    if (!name) continue
    const matchedByUserId =
      Array.isArray(group.userIds) && group.userIds.length > 0 && group.userIds.includes(facts.userId)
    if (matchedByUserId) {
      groups.add(name)
      continue
    }
    const conditions = []
    if (Array.isArray(group.shiftNames) && group.shiftNames.length > 0) {
      conditions.push(group.shiftNames.includes(facts.shiftName))
    }
    if (typeof group.isHoliday === 'boolean') {
      conditions.push(group.isHoliday === facts.isHoliday)
    }
    if (typeof group.isWorkingDay === 'boolean') {
      conditions.push(group.isWorkingDay === facts.isWorkingDay)
    }
    if (group.fieldEquals && typeof group.fieldEquals === 'object') {
      for (const [key, expected] of Object.entries(group.fieldEquals)) {
        conditions.push(matchFieldEquals(fieldValues[key], expected))
      }
    }
    if (group.fieldIn && typeof group.fieldIn === 'object') {
      for (const [key, expected] of Object.entries(group.fieldIn)) {
        conditions.push(matchFieldIn(fieldValues[key], expected))
      }
    }
    if (group.fieldContains && typeof group.fieldContains === 'object') {
      for (const [key, expected] of Object.entries(group.fieldContains)) {
        conditions.push(matchFieldContains(fieldValues[key], expected))
      }
    }
    const matched = conditions.length === 0 ? false : conditions.every(Boolean)
    if (matched) groups.add(name)
  }
  return groups
}

function matchPolicyRule(ruleWhen, facts, fieldValues, userGroups, metrics) {
  if (!ruleWhen) return true
  if (Array.isArray(ruleWhen.userIds) && ruleWhen.userIds.length > 0) {
    if (!ruleWhen.userIds.includes(facts.userId)) return false
  }
  if (ruleWhen.userGroup) {
    if (!userGroups.has(ruleWhen.userGroup)) return false
  }
  if (Array.isArray(ruleWhen.shiftNames) && ruleWhen.shiftNames.length > 0) {
    if (!ruleWhen.shiftNames.includes(facts.shiftName)) return false
  }
  if (typeof ruleWhen.isHoliday === 'boolean' && ruleWhen.isHoliday !== facts.isHoliday) return false
  if (typeof ruleWhen.isWorkingDay === 'boolean' && ruleWhen.isWorkingDay !== facts.isWorkingDay) return false
  if (Array.isArray(ruleWhen.statusIn) && ruleWhen.statusIn.length > 0) {
    if (!ruleWhen.statusIn.includes(metrics.status)) return false
  }
  if (Array.isArray(ruleWhen.fieldExists)) {
    for (const key of ruleWhen.fieldExists) {
      if (!fieldHasValue(fieldValues[key])) return false
    }
  }
  if (ruleWhen.metricGte && typeof ruleWhen.metricGte === 'object') {
    for (const [key, expected] of Object.entries(ruleWhen.metricGte)) {
      if (!matchesNumberGte(metrics[key], expected)) return false
    }
  }
  if (ruleWhen.metricLte && typeof ruleWhen.metricLte === 'object') {
    for (const [key, expected] of Object.entries(ruleWhen.metricLte)) {
      if (!matchesNumberLte(metrics[key], expected)) return false
    }
  }
  if (ruleWhen.fieldEquals && typeof ruleWhen.fieldEquals === 'object') {
    for (const [key, expected] of Object.entries(ruleWhen.fieldEquals)) {
      if (!matchFieldEquals(fieldValues[key], expected)) return false
    }
  }
  if (ruleWhen.fieldIn && typeof ruleWhen.fieldIn === 'object') {
    for (const [key, expected] of Object.entries(ruleWhen.fieldIn)) {
      if (!matchFieldIn(fieldValues[key], expected)) return false
    }
  }
  if (ruleWhen.fieldContains && typeof ruleWhen.fieldContains === 'object') {
    for (const [key, expected] of Object.entries(ruleWhen.fieldContains)) {
      if (!matchFieldContains(fieldValues[key], expected)) return false
    }
  }
  if (ruleWhen.fieldNumberGte && typeof ruleWhen.fieldNumberGte === 'object') {
    for (const [key, expected] of Object.entries(ruleWhen.fieldNumberGte)) {
      if (!matchesNumberGte(fieldValues[key], expected)) return false
    }
  }
  if (ruleWhen.fieldNumberLte && typeof ruleWhen.fieldNumberLte === 'object') {
    for (const [key, expected] of Object.entries(ruleWhen.fieldNumberLte)) {
      if (!matchesNumberLte(fieldValues[key], expected)) return false
    }
  }
  return true
}

function applyAttendancePolicies({ policies, facts, fieldValues, metrics }) {
  const nextMetrics = { ...metrics }
  const warnings = []
  const appliedRules = []
  if (!policies || typeof policies !== 'object') {
    return { metrics: nextMetrics, warnings, appliedRules, userGroups: [] }
  }
  const userGroups = resolveUserGroups(policies.userGroups, facts, fieldValues)
  const rules = Array.isArray(policies.rules) ? policies.rules : []
  rules.forEach((rule, index) => {
    if (!rule || typeof rule !== 'object') return
    if (!matchPolicyRule(rule.when, facts, fieldValues, userGroups, nextMetrics)) return
    const ruleName = (typeof rule.name === 'string' && rule.name.trim()) ? rule.name.trim() : `rule-${index + 1}`
    appliedRules.push(ruleName)
    const actions = rule.then ?? {}
    if (Number.isFinite(actions.setWorkMinutes)) nextMetrics.workMinutes = actions.setWorkMinutes
    if (Number.isFinite(actions.setLateMinutes)) nextMetrics.lateMinutes = actions.setLateMinutes
    if (Number.isFinite(actions.setEarlyLeaveMinutes)) nextMetrics.earlyLeaveMinutes = actions.setEarlyLeaveMinutes
    if (Number.isFinite(actions.setLeaveMinutes)) nextMetrics.leaveMinutes = actions.setLeaveMinutes
    if (Number.isFinite(actions.setOvertimeMinutes)) nextMetrics.overtimeMinutes = actions.setOvertimeMinutes
    if (Number.isFinite(actions.addWorkMinutes)) nextMetrics.workMinutes = (nextMetrics.workMinutes ?? 0) + actions.addWorkMinutes
    if (Number.isFinite(actions.addLateMinutes)) nextMetrics.lateMinutes = (nextMetrics.lateMinutes ?? 0) + actions.addLateMinutes
    if (Number.isFinite(actions.addEarlyLeaveMinutes)) {
      nextMetrics.earlyLeaveMinutes = (nextMetrics.earlyLeaveMinutes ?? 0) + actions.addEarlyLeaveMinutes
    }
    if (Number.isFinite(actions.addLeaveMinutes)) nextMetrics.leaveMinutes = (nextMetrics.leaveMinutes ?? 0) + actions.addLeaveMinutes
    if (Number.isFinite(actions.addOvertimeMinutes)) {
      nextMetrics.overtimeMinutes = (nextMetrics.overtimeMinutes ?? 0) + actions.addOvertimeMinutes
    }
    if (typeof actions.setStatus === 'string' && actions.setStatus.trim()) {
      nextMetrics.status = actions.setStatus.trim()
    }
    if (typeof actions.addWarning === 'string' && actions.addWarning.trim()) {
      warnings.push(actions.addWarning.trim())
    }
    if (Array.isArray(actions.addWarnings)) {
      warnings.push(...actions.addWarnings.map(item => String(item).trim()).filter(Boolean))
    }
  })
  return { metrics: nextMetrics, warnings, appliedRules, userGroups: Array.from(userGroups) }
}

function applyEngineOverrides(metrics, engineResult) {
  if (!engineResult || typeof engineResult !== 'object') {
    return { metrics, meta: null }
  }
  const toMinutes = (hours) => Number.isFinite(hours) ? Math.round(Number(hours) * 60) : null
  const base = {
    workMinutes: metrics.workMinutes,
    overtimeMinutes: metrics.overtimeMinutes,
    requiredMinutes: metrics.requiredMinutes,
  }
  const overrides = {}
  const nextMetrics = { ...metrics }

  const overtimeMinutes = toMinutes(engineResult.overtime_hours)
  if (overtimeMinutes != null) {
    nextMetrics.overtimeMinutes = overtimeMinutes
    overrides.overtimeMinutes = overtimeMinutes
  }
  const workMinutes = toMinutes(engineResult.actual_hours)
  if (workMinutes != null) {
    nextMetrics.workMinutes = workMinutes
    overrides.workMinutes = workMinutes
  }
  const requiredMinutes = toMinutes(engineResult.required_hours)
  if (requiredMinutes != null) {
    overrides.requiredMinutes = requiredMinutes
  }

  if (Object.keys(overrides).length === 0) {
    return { metrics, meta: null }
  }
  return { metrics: nextMetrics, meta: { base, overrides } }
}

async function loadAttendanceSummary(db, orgId, userId, from, to) {
  const rows = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN is_workday THEN 1 ELSE 0 END), 0)::int AS total_days,
       COALESCE(SUM(CASE WHEN is_workday THEN work_minutes ELSE 0 END), 0)::int AS total_minutes,
       COALESCE(SUM(CASE WHEN is_workday THEN late_minutes ELSE 0 END), 0)::int AS total_late_minutes,
       COALESCE(SUM(CASE WHEN is_workday THEN early_leave_minutes ELSE 0 END), 0)::int AS total_early_leave_minutes,
       COALESCE(SUM(CASE WHEN is_workday AND status = 'normal' THEN 1 ELSE 0 END), 0)::int AS normal_days,
       COALESCE(SUM(CASE WHEN is_workday AND status = 'late' THEN 1 ELSE 0 END), 0)::int AS late_days,
       COALESCE(SUM(CASE WHEN is_workday AND status = 'early_leave' THEN 1 ELSE 0 END), 0)::int AS early_leave_days,
       COALESCE(SUM(CASE WHEN is_workday AND status = 'late_early' THEN 1 ELSE 0 END), 0)::int AS late_early_days,
       COALESCE(SUM(CASE WHEN is_workday AND status = 'partial' THEN 1 ELSE 0 END), 0)::int AS partial_days,
       COALESCE(SUM(CASE WHEN is_workday AND status = 'absent' THEN 1 ELSE 0 END), 0)::int AS absent_days,
       COALESCE(SUM(CASE WHEN is_workday AND status = 'adjusted' THEN 1 ELSE 0 END), 0)::int AS adjusted_days,
       COALESCE(SUM(CASE WHEN NOT is_workday THEN 1 ELSE 0 END), 0)::int AS off_days
     FROM attendance_records
     WHERE user_id = $1 AND org_id = $2 AND work_date BETWEEN $3 AND $4`,
    [userId, orgId, from, to]
  )

  const requestRows = await db.query(
    `SELECT request_type,
            COALESCE(SUM(CASE WHEN (metadata->>'minutes') ~ '^[0-9]+' THEN (metadata->>'minutes')::int ELSE 0 END), 0)::int AS total_minutes
     FROM attendance_requests
     WHERE user_id = $1
       AND org_id = $2
       AND work_date BETWEEN $3 AND $4
       AND status = 'approved'
       AND request_type IN ('leave', 'overtime')
     GROUP BY request_type`,
    [userId, orgId, from, to]
  )

  const leaveMinutes = Number(requestRows.find(row => row.request_type === 'leave')?.total_minutes ?? 0)
  const overtimeMinutes = Number(requestRows.find(row => row.request_type === 'overtime')?.total_minutes ?? 0)

  const row = rows[0] ?? {}
  return {
    total_days: Number(row.total_days ?? 0),
    total_minutes: Number(row.total_minutes ?? 0),
    total_late_minutes: Number(row.total_late_minutes ?? 0),
    total_early_leave_minutes: Number(row.total_early_leave_minutes ?? 0),
    normal_days: Number(row.normal_days ?? 0),
    late_days: Number(row.late_days ?? 0),
    early_leave_days: Number(row.early_leave_days ?? 0),
    late_early_days: Number(row.late_early_days ?? 0),
    partial_days: Number(row.partial_days ?? 0),
    absent_days: Number(row.absent_days ?? 0),
    adjusted_days: Number(row.adjusted_days ?? 0),
    off_days: Number(row.off_days ?? 0),
    leave_minutes: leaveMinutes,
    overtime_minutes: overtimeMinutes,
  }
}

function normalizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
  const autoAbsence = raw.autoAbsence ?? {}
  const ipAllowlist = Array.isArray(raw.ipAllowlist) ? raw.ipAllowlist.filter(Boolean) : []
  const geoFence = raw.geoFence && typeof raw.geoFence === 'object' ? raw.geoFence : null
  return {
    autoAbsence: {
      enabled: parseBoolean(autoAbsence.enabled, DEFAULT_SETTINGS.autoAbsence.enabled),
      runAt: typeof autoAbsence.runAt === 'string' && autoAbsence.runAt.trim().length > 0
        ? autoAbsence.runAt
        : DEFAULT_SETTINGS.autoAbsence.runAt,
      lookbackDays: Math.max(1, parseNumber(autoAbsence.lookbackDays, DEFAULT_SETTINGS.autoAbsence.lookbackDays)),
    },
    ipAllowlist,
    geoFence,
    minPunchIntervalMinutes: Math.max(0, parseNumber(raw.minPunchIntervalMinutes, DEFAULT_SETTINGS.minPunchIntervalMinutes)),
  }
}

function mergeSettings(base, update) {
  return normalizeSettings({
    ...base,
    ...update,
    autoAbsence: {
      ...(base?.autoAbsence || {}),
      ...(update?.autoAbsence || {}),
    },
  })
}

async function loadSettings(db) {
  try {
    const rows = await db.query('SELECT value FROM system_configs WHERE key = $1', [SETTINGS_KEY])
    if (!rows.length) return { ...DEFAULT_SETTINGS }
    const raw = JSON.parse(rows[0].value)
    return normalizeSettings(raw)
  } catch (error) {
    if (isDatabaseSchemaError(error)) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS }
  }
}

async function getSettings(db) {
  if (Date.now() - settingsCache.loadedAt < SETTINGS_CACHE_TTL_MS) {
    return settingsCache.value
  }
  const next = await loadSettings(db)
  settingsCache = { value: next, loadedAt: Date.now() }
  return next
}

async function saveSettings(db, settings) {
  const normalized = normalizeSettings(settings)
  await db.query(
    `INSERT INTO system_configs (key, value, is_encrypted, updated_at)
     VALUES ($1, $2, false, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [SETTINGS_KEY, JSON.stringify(normalized)]
  )
  settingsCache = { value: normalized, loadedAt: Date.now() }
  return normalized
}

async function loadDefaultRule(db, orgId) {
  const targetOrg = orgId || DEFAULT_ORG_ID
  try {
    const rows = await db.query(
      `SELECT id, name, timezone, work_start_time, work_end_time, late_grace_minutes,
              early_grace_minutes, rounding_minutes, working_days, is_default, org_id
       FROM attendance_rules
       WHERE is_default = true AND org_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [targetOrg]
    )
    if (!rows.length && targetOrg !== DEFAULT_ORG_ID) {
      const fallbackRows = await db.query(
        `SELECT id, name, timezone, work_start_time, work_end_time, late_grace_minutes,
                early_grace_minutes, rounding_minutes, working_days, is_default, org_id
         FROM attendance_rules
         WHERE is_default = true AND org_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [DEFAULT_ORG_ID]
      )
      if (fallbackRows.length) return mapRuleRow(fallbackRows[0])
    }
    if (!rows.length) return { ...DEFAULT_RULE, orgId: targetOrg }
    return mapRuleRow(rows[0])
  } catch (error) {
    if (isDatabaseSchemaError(error)) return { ...DEFAULT_RULE, orgId: targetOrg }
    throw error
  }
}

async function loadHoliday(db, orgId, workDate) {
  const targetOrg = orgId || DEFAULT_ORG_ID
  try {
    const rows = await db.query(
      `SELECT id, org_id, holiday_date, name, is_working_day
       FROM attendance_holidays
       WHERE org_id = $1 AND holiday_date = $2
       LIMIT 1`,
      [targetOrg, workDate]
    )
    if (!rows.length) return null
    return mapHolidayRow(rows[0])
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

async function loadShiftAssignment(db, orgId, userId, workDate) {
  const targetOrg = orgId || DEFAULT_ORG_ID
  try {
    const rows = await db.query(
      `SELECT a.id, a.org_id, a.user_id, a.shift_id, a.start_date, a.end_date, a.is_active,
              s.name AS shift_name, s.timezone AS shift_timezone, s.work_start_time AS shift_work_start_time,
              s.work_end_time AS shift_work_end_time, s.late_grace_minutes AS shift_late_grace_minutes,
              s.early_grace_minutes AS shift_early_grace_minutes, s.rounding_minutes AS shift_rounding_minutes,
              s.working_days AS shift_working_days
       FROM attendance_shift_assignments a
       JOIN attendance_shifts s ON s.id = a.shift_id
       WHERE a.org_id = $1
         AND a.user_id = $2
         AND a.is_active = true
         AND a.start_date <= $3
         AND (a.end_date IS NULL OR a.end_date >= $3)
       ORDER BY a.start_date DESC, a.created_at DESC
       LIMIT 1`,
      [targetOrg, userId, workDate]
    )
    if (!rows.length) return null
    const row = rows[0]
    return {
      assignment: mapAssignmentRow(row),
      shift: mapShiftFromAssignmentRow(row),
    }
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

async function loadShiftById(db, orgId, shiftId) {
  const targetOrg = orgId || DEFAULT_ORG_ID
  try {
    const rows = await db.query(
      'SELECT * FROM attendance_shifts WHERE id = $1 AND org_id = $2 LIMIT 1',
      [shiftId, targetOrg]
    )
    if (!rows.length) return null
    return mapShiftRow(rows[0])
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

async function loadLeaveType(db, orgId, { id, code }) {
  const targetOrg = orgId || DEFAULT_ORG_ID
  if (!id && !code) return null
  try {
    const rows = await db.query(
      `SELECT * FROM attendance_leave_types
       WHERE org_id = $1 AND ${id ? 'id = $2' : 'code = $2'}
       LIMIT 1`,
      [targetOrg, id || code]
    )
    if (!rows.length) return null
    return mapLeaveTypeRow(rows[0])
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

async function loadOvertimeRule(db, orgId, { id, name }) {
  const targetOrg = orgId || DEFAULT_ORG_ID
  if (!id && !name) return null
  try {
    const rows = await db.query(
      `SELECT * FROM attendance_overtime_rules
       WHERE org_id = $1 AND ${id ? 'id = $2' : 'name = $2'}
       LIMIT 1`,
      [targetOrg, id || name]
    )
    if (!rows.length) return null
    return mapOvertimeRuleRow(rows[0])
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

async function loadApprovalFlow(db, orgId, { requestType, flowId }) {
  const targetOrg = orgId || DEFAULT_ORG_ID
  try {
    if (flowId) {
      const rows = await db.query(
        `SELECT * FROM attendance_approval_flows
         WHERE org_id = $1 AND id = $2
         LIMIT 1`,
        [targetOrg, flowId]
      )
      if (!rows.length) return null
      return mapApprovalFlowRow(rows[0])
    }
    if (!requestType) return null
    const rows = await db.query(
      `SELECT * FROM attendance_approval_flows
       WHERE org_id = $1 AND request_type = $2 AND is_active = true
       ORDER BY created_at DESC
       LIMIT 1`,
      [targetOrg, requestType]
    )
    if (!rows.length) return null
    return mapApprovalFlowRow(rows[0])
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

async function loadRotationAssignment(db, orgId, userId, workDate) {
  const targetOrg = orgId || DEFAULT_ORG_ID
  try {
    const rows = await db.query(
      `SELECT a.id, a.org_id, a.user_id, a.rotation_rule_id, a.start_date, a.end_date, a.is_active,
              r.name AS rotation_name, r.timezone AS rotation_timezone, r.shift_sequence AS rotation_shift_sequence,
              r.is_active AS rotation_is_active
       FROM attendance_rotation_assignments a
       JOIN attendance_rotation_rules r ON r.id = a.rotation_rule_id
       WHERE a.org_id = $1
         AND a.user_id = $2
         AND a.is_active = true
         AND r.is_active = true
         AND a.start_date <= $3
         AND (a.end_date IS NULL OR a.end_date >= $3)
       ORDER BY a.start_date DESC, a.created_at DESC
       LIMIT 1`,
      [targetOrg, userId, workDate]
    )
    if (!rows.length) return null
    const row = rows[0]
    const rotation = mapRotationRuleFromAssignmentRow(row)
    if (!rotation.shiftSequence.length) return null
    const offset = diffDays(row.start_date, workDate)
    if (offset < 0) return null
    const index = offset % rotation.shiftSequence.length
    const shiftId = rotation.shiftSequence[index]
    if (!shiftId) return null
    const shift = await loadShiftById(db, targetOrg, shiftId)
    if (!shift) return null
    return {
      assignment: mapRotationAssignmentRow(row),
      rotation,
      shift,
    }
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

async function resolveWorkContext(options) {
  const { db, orgId, userId, workDate, defaultRule, holidayOverride } = options
  const rule = defaultRule ?? await loadDefaultRule(db, orgId)
  const holiday = holidayOverride ?? await loadHoliday(db, orgId, workDate)
  const rotationInfo = userId ? await loadRotationAssignment(db, orgId, userId, workDate) : null
  const assignmentInfo = userId ? await loadShiftAssignment(db, orgId, userId, workDate) : null
  const profile = rotationInfo?.shift ?? assignmentInfo?.shift ?? rule
  const weekday = getWeekdayFromDateKey(workDate)
  let isWorkingDay = profile.workingDays.includes(weekday)
  if (holiday) {
    isWorkingDay = holiday.isWorkingDay === true
  }
  return {
    rule: profile,
    assignment: assignmentInfo?.assignment ?? null,
    rotation: rotationInfo?.rotation ?? null,
    rotationAssignment: rotationInfo?.assignment ?? null,
    holiday,
    isWorkingDay,
    source: rotationInfo ? 'rotation' : assignmentInfo ? 'shift' : 'rule',
  }
}

async function loadApprovedMinutes(db, orgId, userId, workDate) {
  const rows = await db.query(
    `SELECT request_type,
            COALESCE(SUM(CASE WHEN (metadata->>'minutes') ~ '^[0-9]+' THEN (metadata->>'minutes')::int ELSE 0 END), 0)::int AS total_minutes
     FROM attendance_requests
     WHERE user_id = $1
       AND org_id = $2
       AND work_date = $3
       AND status = 'approved'
       AND request_type IN ('leave', 'overtime')
     GROUP BY request_type`,
    [userId, orgId, workDate]
  )
  const leaveMinutes = Number(rows.find(row => row.request_type === 'leave')?.total_minutes ?? 0)
  const overtimeMinutes = Number(rows.find(row => row.request_type === 'overtime')?.total_minutes ?? 0)
  return { leaveMinutes, overtimeMinutes }
}

async function loadApprovedMinutesRange(db, orgId, userId, fromDate, toDate) {
  const rows = await db.query(
    `SELECT work_date,
            request_type,
            COALESCE(SUM(CASE WHEN (metadata->>'minutes') ~ '^[0-9]+' THEN (metadata->>'minutes')::int ELSE 0 END), 0)::int AS total_minutes
     FROM attendance_requests
     WHERE user_id = $1
       AND org_id = $2
       AND work_date BETWEEN $3 AND $4
       AND status = 'approved'
       AND request_type IN ('leave', 'overtime')
     GROUP BY work_date, request_type
     ORDER BY work_date`,
    [userId, orgId, fromDate, toDate]
  )

  const map = new Map()
  for (const row of rows) {
    const workDate = row.work_date
    if (!map.has(workDate)) {
      map.set(workDate, { leaveMinutes: 0, overtimeMinutes: 0 })
    }
    const entry = map.get(workDate)
    if (row.request_type === 'leave') {
      entry.leaveMinutes = Number(row.total_minutes ?? 0)
    } else if (row.request_type === 'overtime') {
      entry.overtimeMinutes = Number(row.total_minutes ?? 0)
    }
  }
  return map
}

async function upsertAttendanceRecord(options) {
  const {
    userId,
    orgId,
    workDate,
    timezone,
    rule,
    updateFirstInAt,
    updateLastOutAt,
    mode,
    statusOverride,
    overrideMetrics,
    isWorkday,
    leaveMinutes,
    overtimeMinutes,
    meta,
    client,
  } = options

  const existing = await client.query(
    'SELECT * FROM attendance_records WHERE user_id = $1 AND work_date = $2 AND org_id = $3 FOR UPDATE',
    [userId, workDate, orgId]
  )

  let firstInAt = existing[0]?.first_in_at ?? null
  let lastOutAt = existing[0]?.last_out_at ?? null
  const existingMeta = normalizeMetadata(existing[0]?.meta)
  const finalMeta = meta && typeof meta === 'object'
    ? { ...existingMeta, ...meta }
    : existingMeta

  if (mode === 'override') {
    if (updateFirstInAt) firstInAt = updateFirstInAt
    if (updateLastOutAt) lastOutAt = updateLastOutAt
  } else {
    if (updateFirstInAt) {
      firstInAt = !firstInAt || updateFirstInAt < firstInAt ? updateFirstInAt : firstInAt
    }
    if (updateLastOutAt) {
      lastOutAt = !lastOutAt || updateLastOutAt > lastOutAt ? updateLastOutAt : lastOutAt
    }
  }

  const metrics = computeMetrics({
    rule,
    firstInAt,
    lastOutAt,
    isWorkingDay: isWorkday !== false,
    leaveMinutes,
    overtimeMinutes,
  })
  const finalMetrics = {
    workMinutes: metrics.workMinutes,
    lateMinutes: metrics.lateMinutes,
    earlyLeaveMinutes: metrics.earlyLeaveMinutes,
    status: metrics.status,
  }
  if (overrideMetrics) {
    if (Number.isFinite(overrideMetrics.workMinutes)) finalMetrics.workMinutes = overrideMetrics.workMinutes
    if (Number.isFinite(overrideMetrics.lateMinutes)) finalMetrics.lateMinutes = overrideMetrics.lateMinutes
    if (Number.isFinite(overrideMetrics.earlyLeaveMinutes)) finalMetrics.earlyLeaveMinutes = overrideMetrics.earlyLeaveMinutes
    if (typeof overrideMetrics.status === 'string' && overrideMetrics.status.trim()) {
      finalMetrics.status = overrideMetrics.status.trim()
    }
  }
  const status = statusOverride ?? finalMetrics.status

  const updated = await client.query(
    `INSERT INTO attendance_records
      (user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (user_id, work_date, org_id)
     DO UPDATE SET
       org_id = EXCLUDED.org_id,
       timezone = EXCLUDED.timezone,
       first_in_at = EXCLUDED.first_in_at,
       last_out_at = EXCLUDED.last_out_at,
       work_minutes = EXCLUDED.work_minutes,
       late_minutes = EXCLUDED.late_minutes,
       early_leave_minutes = EXCLUDED.early_leave_minutes,
       status = EXCLUDED.status,
       is_workday = EXCLUDED.is_workday,
       meta = EXCLUDED.meta,
       updated_at = now()
     RETURNING *`,
    [
      userId,
      orgId,
      workDate,
      timezone,
      firstInAt,
      lastOutAt,
      finalMetrics.workMinutes,
      finalMetrics.lateMinutes,
      finalMetrics.earlyLeaveMinutes,
      status,
      isWorkday !== false,
      JSON.stringify(finalMeta ?? {}),
    ]
  )

  return updated[0]
}

function getWeekdayFromDateKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`)
  return date.getUTCDay()
}

function formatCsvValue(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function buildCsv(rows, headers) {
  const lines = [headers.join(',')]
  for (const row of rows) {
    const line = headers.map((key) => formatCsvValue(row[key])).join(',')
    lines.push(line)
  }
  return lines.join('\n')
}

function buildPayrollSummaryCsv(summary, cycle) {
  const headers = ['cycle_id', 'cycle_name', 'start_date', 'end_date', 'metric', 'value']
  const rows = [
    ['total_minutes', summary.total_minutes ?? 0],
    ['leave_minutes', summary.leave_minutes ?? 0],
    ['overtime_minutes', summary.overtime_minutes ?? 0],
    ['total_late_minutes', summary.total_late_minutes ?? 0],
    ['total_early_leave_minutes', summary.total_early_leave_minutes ?? 0],
    ['total_days', summary.total_days ?? 0],
    ['normal_days', summary.normal_days ?? 0],
    ['late_days', summary.late_days ?? 0],
    ['early_leave_days', summary.early_leave_days ?? 0],
    ['late_early_days', summary.late_early_days ?? 0],
    ['partial_days', summary.partial_days ?? 0],
    ['absent_days', summary.absent_days ?? 0],
    ['adjusted_days', summary.adjusted_days ?? 0],
    ['off_days', summary.off_days ?? 0],
  ]
  const csvRows = rows.map(([metric, value]) => ({
    cycle_id: cycle.id,
    cycle_name: cycle.name ?? '',
    start_date: cycle.startDate,
    end_date: cycle.endDate,
    metric,
    value,
  }))
  return buildCsv(csvRows, headers)
}

async function enforcePunchConstraints({ db, userId, orgId, occurredAt, settings, req }) {
  if (settings.ipAllowlist && settings.ipAllowlist.length > 0) {
    const ip = getClientIp(req)
    if (!isIpAllowed(ip, settings.ipAllowlist)) {
      throw new HttpError(403, 'IP_RESTRICTED', 'Punch not allowed from this IP')
    }
  }

  if (settings.geoFence) {
    const location = req.body?.location ?? req.body?.meta?.location ?? null
    if (!isGeoAllowed(location, settings.geoFence)) {
      throw new HttpError(403, 'LOCATION_RESTRICTED', 'Punch location outside allowed area')
    }
  }

  if (settings.minPunchIntervalMinutes > 0) {
    const rows = await db.query(
      `SELECT occurred_at
       FROM attendance_events
       WHERE user_id = $1 AND org_id = $2
       ORDER BY occurred_at DESC
       LIMIT 1`,
      [userId, orgId]
    )
    if (rows.length > 0 && rows[0].occurred_at) {
      const last = new Date(rows[0].occurred_at)
      const diffMinutes = (occurredAt.getTime() - last.getTime()) / 60000
      if (diffMinutes < settings.minPunchIntervalMinutes) {
        throw new HttpError(429, 'PUNCH_TOO_SOON', 'Punch interval too short')
      }
    }
  }
}

async function generateAbsenceRecords(db, orgId, workDate, timezone, userIds) {
  if (!userIds || userIds.length === 0) return []
  return db.query(
    `INSERT INTO attendance_records
       (user_id, org_id, work_date, timezone, work_minutes, late_minutes, early_leave_minutes, status, is_workday, created_at, updated_at)
     SELECT uo.user_id, $2, $1, $3, 0, 0, 0, 'absent', true, now(), now()
     FROM user_orgs uo
     JOIN users u ON u.id = uo.user_id
     WHERE uo.org_id = $2
       AND uo.is_active = true
       AND u.is_active = true
       AND uo.user_id = ANY($4)
       AND NOT EXISTS (
         SELECT 1 FROM attendance_records r
         WHERE r.user_id = uo.user_id AND r.work_date = $1 AND r.org_id = $2
       )
     RETURNING user_id`,
    [workDate, orgId, timezone, userIds]
  )
}

function clearAutoAbsenceSchedule() {
  if (autoAbsenceTimeout) {
    clearTimeout(autoAbsenceTimeout)
    autoAbsenceTimeout = null
  }
  if (autoAbsenceInterval) {
    clearInterval(autoAbsenceInterval)
    autoAbsenceInterval = null
  }
}

function scheduleAutoAbsence({ db, logger, emit }) {
  clearAutoAbsenceSchedule()
  const settings = settingsCache.value
  if (!settings.autoAbsence?.enabled) return

  const [hourStr, minuteStr] = settings.autoAbsence.runAt.split(':')
  const hours = Math.min(23, Math.max(0, parseInt(hourStr, 10)))
  const minutes = Math.min(59, Math.max(0, parseInt(minuteStr ?? '0', 10)))
  const now = new Date()
  const next = new Date(now)
  next.setHours(hours, minutes, 0, 0)
  if (next <= now) {
    next.setDate(next.getDate() + 1)
  }
  const delay = next.getTime() - now.getTime()

  const run = async () => {
    try {
      const lookbackDays = settings.autoAbsence.lookbackDays || 1
      const orgRows = await db.query('SELECT DISTINCT org_id FROM attendance_rules')
      const orgIds = orgRows.length > 0
        ? orgRows.map(row => row.org_id || DEFAULT_ORG_ID)
        : [DEFAULT_ORG_ID]
      for (const orgId of orgIds) {
        const rule = await loadDefaultRule(db, orgId)
        for (let offset = 1; offset <= lookbackDays; offset += 1) {
          const targetDate = new Date(Date.now() - offset * 24 * 60 * 60 * 1000)
          const workDate = toWorkDate(targetDate, rule.timezone)
          const holiday = await loadHoliday(db, orgId, workDate)
          if (holiday && holiday.isWorkingDay === false) {
            continue
          }
          const key = `${orgId}:${workDate}`
          if (key === lastAutoAbsenceKey) continue
          const userRows = await db.query(
            `SELECT uo.user_id
             FROM user_orgs uo
             JOIN users u ON u.id = uo.user_id
             WHERE uo.org_id = $1
               AND uo.is_active = true
               AND u.is_active = true`,
            [orgId]
          )
          const targetUsers = []
          for (const row of userRows) {
            const context = await resolveWorkContext({
              db,
              orgId,
              userId: row.user_id,
              workDate,
              defaultRule: rule,
              holidayOverride: holiday,
            })
            if (!context.isWorkingDay) continue
            targetUsers.push(row.user_id)
          }
          const rows = await generateAbsenceRecords(db, orgId, workDate, rule.timezone, targetUsers)
          lastAutoAbsenceKey = key
          emit('attendance.absence.generated', {
            orgId,
            workDate,
            total: rows.length,
          })
          if (rows.length > 0) {
            logger.info(`Auto absence generated for ${workDate}`, { orgId, total: rows.length })
          }
        }
      }
    } catch (error) {
      logger.error('Auto absence job failed', error)
    }
  }

  autoAbsenceTimeout = setTimeout(async () => {
    await run()
    autoAbsenceInterval = setInterval(run, 24 * 60 * 60 * 1000)
  }, delay)
}

function createRbacHelpers(db, logger) {
  async function isAdmin(userId) {
    try {
      const rows = await db.query(
        'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1',
        [userId, 'admin']
      )
      return rows.length > 0
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowRbacDegradation) {
        if (!rbacDegraded) {
          logger.warn('RBAC service degraded - user_roles table not found')
          rbacDegraded = true
        }
        return false
      }
      throw error
    }
  }

  async function userHasPermission(userId, code) {
    try {
      const direct = await db.query(
        'SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = $2 LIMIT 1',
        [userId, code]
      )
      if (direct.length > 0) return true
      const viaRole = await db.query(
        `SELECT 1
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = $1 AND rp.permission_code = $2
         LIMIT 1`,
        [userId, code]
      )
      return viaRole.length > 0
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowRbacDegradation) {
        if (!rbacDegraded) {
          logger.warn('RBAC service degraded - permission tables not found')
          rbacDegraded = true
        }
        return false
      }
      throw error
    }
  }

  function withPermission(permission, handler) {
    return async (req, res, next) => {
      const userId = getUserId(req)
      if (!userId) {
        res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
        return
      }

      if (process.env.RBAC_BYPASS === 'true') {
        await handler(req, res, next)
        return
      }

      try {
        const admin = await isAdmin(userId)
        if (!admin) {
          const allowed = await userHasPermission(userId, permission)
          if (!allowed) {
            res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
            return
          }
        }
        await handler(req, res, next)
      } catch (error) {
        logger.error('RBAC guard error', error)
        res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Permission check failed' } })
      }
    }
  }

  async function canAccessOtherUsers(userId) {
    if (process.env.RBAC_BYPASS === 'true') return true
    if (await isAdmin(userId)) return true
    if (await userHasPermission(userId, 'attendance:admin')) return true
    return userHasPermission(userId, 'attendance:approve')
  }

  return { withPermission, canAccessOtherUsers }
}

function normalizeApprovalSteps(value) {
  return normalizeJsonArray(value, [])
    .map((step) => {
      if (!step || typeof step !== 'object') return null
      const name = typeof step.name === 'string' ? step.name : undefined
      const approverUserIds = Array.isArray(step.approverUserIds)
        ? step.approverUserIds.map(item => String(item)).filter(Boolean)
        : []
      const approverRoleIds = Array.isArray(step.approverRoleIds)
        ? step.approverRoleIds.map(item => String(item)).filter(Boolean)
        : []
      return { name, approverUserIds, approverRoleIds }
    })
    .filter(Boolean)
}

async function userHasAnyRole(db, userId, roleIds, logger) {
  if (!roleIds || roleIds.length === 0) return false
  try {
    const rows = await db.query(
      'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = ANY($2) LIMIT 1',
      [userId, roleIds]
    )
    return rows.length > 0
  } catch (error) {
    if (isDatabaseSchemaError(error) && allowRbacDegradation) {
      if (!rbacDegraded) {
        logger.warn('RBAC service degraded - user_roles table not found')
        rbacDegraded = true
      }
      return true
    }
    throw error
  }
}

async function isApproverAllowed(db, userId, step, logger) {
  if (!step) return true
  const approverUserIds = Array.isArray(step.approverUserIds) ? step.approverUserIds : []
  const approverRoleIds = Array.isArray(step.approverRoleIds) ? step.approverRoleIds : []
  if (approverUserIds.length === 0 && approverRoleIds.length === 0) return true
  if (approverUserIds.includes(userId)) return true
  if (approverRoleIds.length > 0) {
    return userHasAnyRole(db, userId, approverRoleIds, logger)
  }
  return false
}

module.exports = {
  async activate(context) {
    const db = context.api.database
    const logger = context.logger
    const { withPermission, canAccessOtherUsers } = createRbacHelpers(db, logger)
    const emitEvent = (type, data) => {
      if (context.api?.events?.emit) {
        context.api.events.emit(type, data)
      }
    }

    const settingsSchema = z.object({
      autoAbsence: z.object({
        enabled: z.boolean().optional(),
        runAt: z.string().optional(),
        lookbackDays: z.number().int().min(1).optional(),
      }).optional(),
      ipAllowlist: z.array(z.string()).optional(),
      geoFence: z.object({
        lat: z.number(),
        lng: z.number(),
        radiusMeters: z.number().int().min(1),
      }).nullable().optional(),
      minPunchIntervalMinutes: z.number().int().min(0).optional(),
    })

    const punchSchema = z.object({
      eventType: z.enum(['check_in', 'check_out']),
      occurredAt: z.string().optional(),
      timezone: z.string().optional(),
      source: z.string().optional(),
      location: z.record(z.unknown()).optional(),
      meta: z.record(z.unknown()).optional(),
      orgId: z.string().optional(),
    })

    const shiftCreateSchema = z.object({
      name: z.string().min(1),
      timezone: z.string().optional(),
      workStartTime: z.string().optional(),
      workEndTime: z.string().optional(),
      lateGraceMinutes: z.number().int().min(0).optional(),
      earlyGraceMinutes: z.number().int().min(0).optional(),
      roundingMinutes: z.number().int().min(0).optional(),
      workingDays: z.array(z.number().int().min(0).max(6)).optional(),
      orgId: z.string().optional(),
    })
    const shiftUpdateSchema = shiftCreateSchema.partial()

    const assignmentCreateSchema = z.object({
      userId: z.string().min(1),
      shiftId: z.string().min(1),
      startDate: z.string().min(1),
      endDate: z.string().nullable().optional(),
      isActive: z.boolean().optional(),
      orgId: z.string().optional(),
    })
    const assignmentUpdateSchema = assignmentCreateSchema.partial()

    const holidayCreateSchema = z.object({
      date: z.string().min(1),
      name: z.string().nullable().optional(),
      isWorkingDay: z.boolean().optional(),
      orgId: z.string().optional(),
    })
    const holidayUpdateSchema = holidayCreateSchema.partial()

    const leaveTypeCreateSchema = z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      requiresApproval: z.boolean().optional(),
      requiresAttachment: z.boolean().optional(),
      defaultMinutesPerDay: z.number().int().min(0).optional(),
      isActive: z.boolean().optional(),
      orgId: z.string().optional(),
    })
    const leaveTypeUpdateSchema = leaveTypeCreateSchema.partial()

    const overtimeRuleCreateSchema = z.object({
      name: z.string().min(1),
      minMinutes: z.number().int().min(0).optional(),
      roundingMinutes: z.number().int().min(1).optional(),
      maxMinutesPerDay: z.number().int().min(0).optional(),
      requiresApproval: z.boolean().optional(),
      isActive: z.boolean().optional(),
      orgId: z.string().optional(),
    })
    const overtimeRuleUpdateSchema = overtimeRuleCreateSchema.partial()

    const ruleSetCreateSchema = z.object({
      name: z.string().min(1),
      description: z.string().nullable().optional(),
      version: z.number().int().min(1).optional(),
      scope: z.enum(['org', 'department', 'project', 'user', 'custom']).optional(),
      config: z.record(z.unknown()).optional(),
      isDefault: z.boolean().optional(),
      orgId: z.string().optional(),
    })
    const ruleSetUpdateSchema = ruleSetCreateSchema.partial()

    const ruleSetConfigSchema = z.object({
      source: z.string().optional(),
      rule: z.object({
        timezone: z.string().optional(),
        workStartTime: z.string().optional(),
        workEndTime: z.string().optional(),
        lateGraceMinutes: z.number().int().min(0).optional(),
        earlyGraceMinutes: z.number().int().min(0).optional(),
        roundingMinutes: z.number().int().min(0).optional(),
        workingDays: z.array(z.number().int().min(0).max(6)).optional(),
      }).optional(),
      mappings: z.object({
        columns: z.array(z.object({
          sourceField: z.string().min(1),
          targetField: z.string().min(1),
          dataType: z.string().optional(),
          transform: z.string().optional(),
        })).optional(),
        fields: z.array(z.object({
          sourceField: z.string().min(1),
          targetField: z.string().min(1),
          dataType: z.string().optional(),
          transform: z.string().optional(),
        })).optional(),
      }).optional(),
      approvals: z.object({
        processCodes: z.array(z.string()).optional(),
        roleMappings: z.array(z.object({
          roleId: z.string().min(1),
          roleName: z.string().optional(),
        })).optional(),
      }).optional(),
      payroll: z.object({
        cycleMode: z.enum(['template', 'manual']).optional(),
        templateId: z.string().optional(),
      }).optional(),
      engine: z.record(z.unknown()).optional(),
      policies: z.object({
        userGroups: z.array(
          z.object({
            name: z.string().min(1),
            userIds: z.array(z.string().min(1)).optional(),
            fieldEquals: z.record(z.unknown()).optional(),
            fieldIn: z.record(z.array(z.unknown())).optional(),
            fieldContains: z.record(z.string()).optional(),
            fieldNumberGte: z.record(z.number()).optional(),
            fieldNumberLte: z.record(z.number()).optional(),
            shiftNames: z.array(z.string()).optional(),
            isHoliday: z.boolean().optional(),
            isWorkingDay: z.boolean().optional(),
          }).catchall(z.unknown())
        ).optional(),
        rules: z.array(
          z.object({
            name: z.string().optional(),
            when: z.object({
              userIds: z.array(z.string().min(1)).optional(),
              userGroup: z.string().optional(),
              shiftNames: z.array(z.string()).optional(),
              isHoliday: z.boolean().optional(),
              isWorkingDay: z.boolean().optional(),
              statusIn: z.array(z.string()).optional(),
              fieldEquals: z.record(z.unknown()).optional(),
              fieldIn: z.record(z.array(z.unknown())).optional(),
              fieldContains: z.record(z.string()).optional(),
              fieldExists: z.array(z.string()).optional(),
              metricGte: z.record(z.number()).optional(),
              metricLte: z.record(z.number()).optional(),
              fieldNumberGte: z.record(z.number()).optional(),
              fieldNumberLte: z.record(z.number()).optional(),
            }).optional(),
            then: z.object({
              setWorkMinutes: z.number().int().min(0).optional(),
              setLateMinutes: z.number().int().min(0).optional(),
              setEarlyLeaveMinutes: z.number().int().min(0).optional(),
              setLeaveMinutes: z.number().int().min(0).optional(),
              setOvertimeMinutes: z.number().int().min(0).optional(),
              addWorkMinutes: z.number().int().optional(),
              addLateMinutes: z.number().int().optional(),
              addEarlyLeaveMinutes: z.number().int().optional(),
              addLeaveMinutes: z.number().int().optional(),
              addOvertimeMinutes: z.number().int().optional(),
              setStatus: z.string().optional(),
              addWarning: z.string().optional(),
              addWarnings: z.array(z.string()).optional(),
            }).optional(),
          }).catchall(z.unknown())
        ).optional(),
      }).optional(),
    }).catchall(z.unknown())

    const importColumnSchema = z.object({
      id: z.union([z.string(), z.number()]),
      name: z.string().optional(),
      alias: z.string().optional(),
    })

    const importRowSchema = z.object({
      workDate: z.string().min(1),
      fields: z.record(z.unknown()),
      userId: z.string().optional(),
      user_id: z.string().optional(),
    })

    const importPayloadSchema = z.object({
      source: z.enum(['dingtalk', 'manual', 'dingtalk_csv']).optional(),
      orgId: z.string().optional(),
      userId: z.string().optional(),
      timezone: z.string().optional(),
      ruleSetId: z.string().uuid().optional(),
      engine: z.record(z.unknown()).optional(),
      userMap: z.record(z.unknown()).optional(),
      userMapKeyField: z.string().optional(),
      userMapSourceFields: z.array(z.string()).optional(),
      mapping: z.object({
        columns: z.array(z.object({
          sourceField: z.string().min(1),
          targetField: z.string().min(1),
          dataType: z.string().optional(),
        })).optional(),
        fields: z.array(z.object({
          sourceField: z.string().min(1),
          targetField: z.string().min(1),
          dataType: z.string().optional(),
        })).optional(),
      }).optional(),
      columns: z.array(importColumnSchema).optional(),
      data: z.object({
        column_vals: z.array(z.object({
          column_vo: z.object({ id: z.union([z.string(), z.number()]) }).optional(),
          column_vals: z.array(z.object({
            date: z.string(),
            value: z.unknown().optional(),
          })).optional(),
        })).optional(),
      }).optional(),
      rows: z.array(importRowSchema).optional(),
      entries: z.array(z.object({
        userId: z.string().optional(),
        occurredAt: z.string().optional(),
        eventType: z.string().optional(),
        timezone: z.string().optional(),
        workDate: z.string().optional(),
        column: z.string().optional(),
        field: z.string().optional(),
        value: z.unknown().optional(),
        meta: z.record(z.unknown()).optional(),
      })).optional(),
      statusMap: z.record(z.string()).optional(),
      mode: z.enum(['merge', 'override']).optional(),
    })

    const payrollTemplateCreateSchema = z.object({
      name: z.string().min(1),
      timezone: z.string().optional(),
      startDay: z.number().int().min(1).max(31).optional(),
      endDay: z.number().int().min(1).max(31).optional(),
      endMonthOffset: z.number().int().min(0).max(1).optional(),
      autoGenerate: z.boolean().optional(),
      config: z.record(z.unknown()).optional(),
      isDefault: z.boolean().optional(),
      orgId: z.string().optional(),
    })
    const payrollTemplateUpdateSchema = payrollTemplateCreateSchema.partial()

    const payrollCycleCreateSchema = z.object({
      templateId: z.string().uuid().optional(),
      name: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      anchorDate: z.string().optional(),
      status: z.enum(['open', 'closed', 'archived']).optional(),
      metadata: z.record(z.unknown()).optional(),
      orgId: z.string().optional(),
    })
    const payrollCycleUpdateSchema = payrollCycleCreateSchema.partial()

    const approvalStepSchema = z.object({
      name: z.string().optional(),
      approverUserIds: z.array(z.string()).optional(),
      approverRoleIds: z.array(z.string()).optional(),
    })
    const approvalFlowCreateSchema = z.object({
      name: z.string().min(1),
      requestType: z.enum(REQUEST_TYPES),
      steps: z.array(approvalStepSchema).optional(),
      isActive: z.boolean().optional(),
      orgId: z.string().optional(),
    })
    const approvalFlowUpdateSchema = approvalFlowCreateSchema.partial()

    const rotationRuleCreateSchema = z.object({
      name: z.string().min(1),
      timezone: z.string().optional(),
      shiftSequence: z.array(z.string()).optional(),
      isActive: z.boolean().optional(),
      orgId: z.string().optional(),
    })
    const rotationRuleUpdateSchema = rotationRuleCreateSchema.partial()

    const rotationAssignmentCreateSchema = z.object({
      userId: z.string().min(1),
      rotationRuleId: z.string().min(1),
      startDate: z.string().min(1),
      endDate: z.string().nullable().optional(),
      isActive: z.boolean().optional(),
      orgId: z.string().optional(),
    })
    const rotationAssignmentUpdateSchema = rotationAssignmentCreateSchema.partial()

    context.api.http.addRoute(
      'POST',
      '/api/attendance/punch',
      withPermission('attendance:write', async (req, res) => {
        const parsed = punchSchema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const userId = getUserId(req)
        if (!userId) {
          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
          return
        }

        const orgId = getOrgId(req)
        const occurredAt = parseDateInput(parsed.data.occurredAt) ?? new Date()

        try {
          const settings = await getSettings(db)
          await enforcePunchConstraints({ db, userId, orgId, occurredAt, settings, req })

          const baseRule = await loadDefaultRule(db, orgId)
          const baseTimezone = parsed.data.timezone ?? baseRule.timezone
          let workDate = toWorkDate(occurredAt, baseTimezone)
          let context = await resolveWorkContext({
            db,
            orgId,
            userId,
            workDate,
            defaultRule: baseRule,
          })
          let timezone = parsed.data.timezone ?? context.rule.timezone
          if (timezone !== baseTimezone) {
            const recalculated = toWorkDate(occurredAt, timezone)
            if (recalculated !== workDate) {
              workDate = recalculated
              context = await resolveWorkContext({
                db,
                orgId,
                userId,
                workDate,
                defaultRule: baseRule,
              })
            }
          }

          const result = await db.transaction(async (trx) => {
            const event = await trx.query(
              `INSERT INTO attendance_events
               (id, user_id, org_id, work_date, occurred_at, event_type, source, timezone, location, meta)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
               RETURNING *`,
              [
                randomUUID(),
                userId,
                orgId,
                workDate,
                occurredAt,
                parsed.data.eventType,
                parsed.data.source ?? 'manual',
                timezone,
                JSON.stringify(parsed.data.location ?? {}),
                JSON.stringify(parsed.data.meta ?? {}),
              ]
            )

            const record = await upsertAttendanceRecord({
              userId,
              orgId,
              workDate,
              timezone,
              rule: { ...context.rule, timezone },
              updateFirstInAt: parsed.data.eventType === 'check_in' ? occurredAt : null,
              updateLastOutAt: parsed.data.eventType === 'check_out' ? occurredAt : null,
              mode: 'append',
              isWorkday: context.isWorkingDay,
              leaveMinutes: 0,
              overtimeMinutes: 0,
              client: trx,
            })

            return { event: event[0], record }
          })

          emitEvent('attendance.punched', {
            userId,
            orgId,
            workDate,
            eventType: parsed.data.eventType,
            occurredAt: occurredAt.toISOString(),
            timezone,
          })
          res.json({ ok: true, data: result })
        } catch (error) {
          if (error instanceof HttpError) {
            res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance punch failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to punch attendance' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/records',
      withPermission('attendance:read', async (req, res) => {
        const schema = z.object({
          userId: z.string().optional(),
          orgId: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
        })

        const parsed = schema.safeParse({
          userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
          from: typeof req.query.from === 'string' ? req.query.from : undefined,
          to: typeof req.query.to === 'string' ? req.query.to : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const requesterId = getUserId(req)
        if (!requesterId) {
          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
          return
        }

        const orgId = getOrgId(req)
        const targetUserId = parsed.data.userId ?? requesterId
        if (targetUserId !== requesterId) {
          const allowed = await canAccessOtherUsers(requesterId)
          if (!allowed) {
            res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'No access to other users' } })
            return
          }
        }

        const { page, pageSize, offset } = parsePagination(req.query)
        const from = parsed.data.from ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 10)
        const to = parsed.data.to ?? new Date().toISOString().slice(0, 10)

        try {
          const countRows = await db.query(
            `SELECT COUNT(*)::int AS total
             FROM attendance_records
             WHERE user_id = $1 AND org_id = $2 AND work_date BETWEEN $3 AND $4`,
            [targetUserId, orgId, from, to]
          )
          const total = Number(countRows[0]?.total ?? 0)

          const rows = await db.query(
            `SELECT * FROM attendance_records
             WHERE user_id = $1 AND org_id = $2 AND work_date BETWEEN $3 AND $4
             ORDER BY work_date DESC
             LIMIT $5 OFFSET $6`,
            [targetUserId, orgId, from, to, pageSize, offset]
          )

          const approvedMap = await loadApprovedMinutesRange(db, orgId, targetUserId, from, to)
          const records = rows.map((row) => {
            const meta = normalizeMetadata(row.meta)
            const approved = approvedMap.get(row.work_date) ?? { leaveMinutes: 0, overtimeMinutes: 0 }
            return {
              ...row,
              meta: {
                ...meta,
                leave_minutes: approved.leaveMinutes,
                overtime_minutes: approved.overtimeMinutes,
              },
            }
          })

          res.json({
            ok: true,
            data: {
              items: records,
              total,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance records query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load records' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/summary',
      withPermission('attendance:read', async (req, res) => {
        const schema = z.object({
          userId: z.string().optional(),
          orgId: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
        })

        const parsed = schema.safeParse({
          userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
          from: typeof req.query.from === 'string' ? req.query.from : undefined,
          to: typeof req.query.to === 'string' ? req.query.to : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const requesterId = getUserId(req)
        if (!requesterId) {
          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
          return
        }

        const targetUserId = parsed.data.userId ?? requesterId
        if (targetUserId !== requesterId) {
          const allowed = await canAccessOtherUsers(requesterId)
          if (!allowed) {
            res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'No access to other users' } })
            return
          }
        }

        const orgId = getOrgId(req)
        const from = parsed.data.from ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 10)
        const to = parsed.data.to ?? new Date().toISOString().slice(0, 10)

        try {
          const summary = await loadAttendanceSummary(db, orgId, targetUserId, from, to)
          res.json({ ok: true, data: summary })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance summary failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load summary' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/reports/requests',
      withPermission('attendance:read', async (req, res) => {
        const schema = z.object({
          userId: z.string().optional(),
          orgId: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
        })

        const parsed = schema.safeParse({
          userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
          from: typeof req.query.from === 'string' ? req.query.from : undefined,
          to: typeof req.query.to === 'string' ? req.query.to : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const requesterId = getUserId(req)
        if (!requesterId) {
          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
          return
        }

        const targetUserId = parsed.data.userId ?? requesterId
        if (targetUserId !== requesterId) {
          const allowed = await canAccessOtherUsers(requesterId)
          if (!allowed) {
            res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'No access to other users' } })
            return
          }
        }

        const orgId = getOrgId(req)
        const from = parsed.data.from ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 10)
        const to = parsed.data.to ?? new Date().toISOString().slice(0, 10)

        try {
          const rows = await db.query(
            `SELECT request_type, status,
                    COUNT(*)::int AS total,
                    COALESCE(SUM(CASE WHEN (metadata->>'minutes') ~ '^[0-9]+' THEN (metadata->>'minutes')::int ELSE 0 END), 0)::int AS total_minutes
             FROM attendance_requests
             WHERE user_id = $1 AND org_id = $2 AND work_date BETWEEN $3 AND $4
             GROUP BY request_type, status
             ORDER BY request_type, status`,
            [targetUserId, orgId, from, to]
          )

          const items = rows.map(row => ({
            requestType: row.request_type,
            status: row.status,
            total: Number(row.total ?? 0),
            minutes: Number(row.total_minutes ?? 0),
          }))

          res.json({ ok: true, data: { items, from, to } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance requests report failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load request report' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/requests',
      withPermission('attendance:write', async (req, res) => {
        const schema = z.object({
          workDate: z.string(),
          requestType: z.enum(REQUEST_TYPES),
          requestedInAt: z.string().optional(),
          requestedOutAt: z.string().optional(),
          reason: z.string().optional(),
          leaveTypeId: z.string().optional(),
          leaveTypeCode: z.string().optional(),
          overtimeRuleId: z.string().optional(),
          overtimeRuleName: z.string().optional(),
          minutes: z.coerce.number().int().min(0).optional(),
          attachmentUrl: z.string().optional(),
          approvalFlowId: z.string().optional(),
          orgId: z.string().optional(),
        })

        const parsed = schema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const userId = getUserId(req)
        if (!userId) {
          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
          return
        }

        const orgId = getOrgId(req)
        const requestedInAt = parseDateInput(parsed.data.requestedInAt)
        const requestedOutAt = parseDateInput(parsed.data.requestedOutAt)
        if (requestedInAt && requestedOutAt && requestedOutAt <= requestedInAt) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'requestedOutAt must be after requestedInAt' } })
          return
        }

        const requestType = parsed.data.requestType
        if (requestType === 'missed_check_in' && !requestedInAt) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'requestedInAt required' } })
          return
        }
        if (requestType === 'missed_check_out' && !requestedOutAt) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'requestedOutAt required' } })
          return
        }
        if (requestType === 'time_correction' && !requestedInAt && !requestedOutAt) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'requestedInAt or requestedOutAt required' } })
          return
        }

        let durationMinutes = parsed.data.minutes ?? null
        if (!durationMinutes) {
          durationMinutes = calculateDurationMinutes(requestedInAt, requestedOutAt)
        }

        let leaveType = null
        let overtimeRule = null
        if (requestType === 'leave') {
          leaveType = await loadLeaveType(db, orgId, {
            id: parsed.data.leaveTypeId,
            code: parsed.data.leaveTypeCode,
          })
          if (!leaveType) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Leave type not found' } })
            return
          }
          if (!leaveType.isActive) {
            res.status(400).json({ ok: false, error: { code: 'INVALID_STATE', message: 'Leave type inactive' } })
            return
          }
          if (!durationMinutes) {
            durationMinutes = leaveType.defaultMinutesPerDay
          }
        } else if (requestType === 'overtime') {
          overtimeRule = await loadOvertimeRule(db, orgId, {
            id: parsed.data.overtimeRuleId,
            name: parsed.data.overtimeRuleName,
          })
          if (!overtimeRule) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Overtime rule not found' } })
            return
          }
          if (!overtimeRule.isActive) {
            res.status(400).json({ ok: false, error: { code: 'INVALID_STATE', message: 'Overtime rule inactive' } })
            return
          }
          if (!durationMinutes) {
            res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Duration required for overtime' } })
            return
          }
          durationMinutes = applyOvertimeRule(durationMinutes, overtimeRule)
        }

        if ((requestType === 'leave' || requestType === 'overtime') && (!durationMinutes || durationMinutes <= 0)) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Duration required' } })
          return
        }

        const approvalFlow = await loadApprovalFlow(db, orgId, {
          requestType,
          flowId: parsed.data.approvalFlowId,
        })
        const metadata = {}
        if (durationMinutes) metadata.minutes = durationMinutes
        if (leaveType) {
          metadata.leaveType = {
            id: leaveType.id,
            code: leaveType.code,
            name: leaveType.name,
            requiresApproval: leaveType.requiresApproval,
            requiresAttachment: leaveType.requiresAttachment,
            defaultMinutesPerDay: leaveType.defaultMinutesPerDay,
          }
        }
        if (overtimeRule) {
          metadata.overtimeRule = {
            id: overtimeRule.id,
            name: overtimeRule.name,
            minMinutes: overtimeRule.minMinutes,
            roundingMinutes: overtimeRule.roundingMinutes,
            maxMinutesPerDay: overtimeRule.maxMinutesPerDay,
            requiresApproval: overtimeRule.requiresApproval,
          }
        }
        if (parsed.data.attachmentUrl) {
          metadata.attachmentUrl = parsed.data.attachmentUrl
        }
        if (approvalFlow) {
          metadata.approvalFlow = {
            id: approvalFlow.id,
            name: approvalFlow.name,
            steps: approvalFlow.steps,
            currentStep: 0,
          }
        }

        const approvalId = `apv_${randomUUID()}`

        try {
          const request = await db.transaction(async (trx) => {
            await trx.query(
              'INSERT INTO approval_instances (id, status, version) VALUES ($1, $2, $3)',
              [approvalId, 'pending', 0]
            )

            const rows = await trx.query(
              `INSERT INTO attendance_requests
               (id, user_id, org_id, work_date, request_type, requested_in_at, requested_out_at, reason, status, approval_instance_id, metadata)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
               RETURNING *`,
              [
                randomUUID(),
                userId,
                orgId,
                parsed.data.workDate,
                requestType,
                requestedInAt,
                requestedOutAt,
                parsed.data.reason ?? null,
                'pending',
                approvalId,
                JSON.stringify(metadata),
              ]
            )

            return rows[0]
          })

          emitEvent('attendance.requested', {
            orgId,
            userId,
            workDate: parsed.data.workDate,
            requestType,
          })
          res.status(201).json({ ok: true, data: { request } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance request creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create request' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/requests',
      withPermission('attendance:read', async (req, res) => {
        const schema = z.object({
          userId: z.string().optional(),
          orgId: z.string().optional(),
          status: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
        })

        const parsed = schema.safeParse({
          userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
          status: typeof req.query.status === 'string' ? req.query.status : undefined,
          from: typeof req.query.from === 'string' ? req.query.from : undefined,
          to: typeof req.query.to === 'string' ? req.query.to : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const requesterId = getUserId(req)
        if (!requesterId) {
          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
          return
        }

        const targetUserId = parsed.data.userId ?? requesterId
        if (targetUserId !== requesterId) {
          const allowed = await canAccessOtherUsers(requesterId)
          if (!allowed) {
            res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'No access to other users' } })
            return
          }
        }

        const { page, pageSize, offset } = parsePagination(req.query)
        const orgId = getOrgId(req)
        const from = parsed.data.from ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 10)
        const to = parsed.data.to ?? new Date().toISOString().slice(0, 10)

        try {
          const params = [targetUserId, orgId, from, to]
          let statusFilter = ''
          if (parsed.data.status) {
            params.push(parsed.data.status)
            statusFilter = `AND status = $${params.length}`
          }

          const countRows = await db.query(
            `SELECT COUNT(*)::int AS total
             FROM attendance_requests
             WHERE user_id = $1 AND org_id = $2 AND work_date BETWEEN $3 AND $4 ${statusFilter}`,
            params
          )
          const total = Number(countRows[0]?.total ?? 0)

          params.push(pageSize, offset)
          const rows = await db.query(
            `SELECT * FROM attendance_requests
             WHERE user_id = $1 AND org_id = $2 AND work_date BETWEEN $3 AND $4 ${statusFilter}
             ORDER BY created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
          )

          res.json({ ok: true, data: { items: rows, total, page, pageSize } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance request list failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list requests' } })
        }
      })
    )

    const resolveSchema = z.object({
      comment: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })

    async function resolveRequest(req, res, action) {
      const parsed = resolveSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
        return
      }

      const requesterId = getUserId(req)
      if (!requesterId) {
        res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
        return
      }

      const allowed = await canAccessOtherUsers(requesterId)
      if (!allowed) {
        res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'No approval access' } })
        return
      }

      const requestId = req.params.id

      try {
        const result = await db.transaction(async (trx) => {
          const requestRows = await trx.query(
            'SELECT * FROM attendance_requests WHERE id = $1 FOR UPDATE',
            [requestId]
          )
          if (requestRows.length === 0) {
            throw new HttpError(404, 'NOT_FOUND', 'Request not found')
          }

          const requestRow = requestRows[0]
          if (requestRow.status !== 'pending') {
            throw new HttpError(400, 'INVALID_STATUS', 'Request already resolved')
          }

          const approvalId = requestRow.approval_instance_id
          if (!approvalId) {
            throw new HttpError(400, 'INVALID_STATE', 'Missing approval instance')
          }

          const approvalRows = await trx.query(
            'SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE',
            [approvalId]
          )
          if (approvalRows.length === 0) {
            throw new HttpError(400, 'INVALID_STATE', 'Approval instance missing')
          }

          const approval = approvalRows[0]
          const requestMetadata = normalizeMetadata(requestRow.metadata)
          const flowMeta = normalizeMetadata(requestMetadata.approvalFlow)
          const flowSteps = normalizeApprovalSteps(flowMeta.steps)
          const rawStepIndex = Number(flowMeta.currentStep ?? 0)
          const currentStepIndex = flowSteps.length > 0
            ? Math.min(Math.max(Number.isFinite(rawStepIndex) ? rawStepIndex : 0, 0), flowSteps.length - 1)
            : 0
          const currentStep = flowSteps[currentStepIndex]

          if (action === 'approve') {
            const canApprove = await isApproverAllowed(trx, requesterId, currentStep, logger)
            if (!canApprove) {
              throw new HttpError(403, 'FORBIDDEN', 'Not authorized for this approval step')
            }
          }

          const isFinalApproval = action !== 'approve' || flowSteps.length === 0 || currentStepIndex >= flowSteps.length - 1
          const newStatus = action === 'approve'
            ? (isFinalApproval ? 'approved' : 'pending')
            : 'rejected'
          const newVersion = Number(approval.version ?? 0) + 1

          await trx.query(
            'UPDATE approval_instances SET status = $1, version = $2, updated_at = now() WHERE id = $3',
            [newStatus, newVersion, approvalId]
          )

          const recordMetadata = {
            ...(parsed.data.metadata ?? {}),
            stepIndex: currentStepIndex,
            stepName: currentStep?.name ?? null,
          }

          await trx.query(
            `INSERT INTO approval_records
             (instance_id, action, actor_id, actor_name, comment, from_status, to_status, from_version, to_version, metadata, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
            [
              approvalId,
              action,
              requesterId,
              getUserLabel(req, requesterId),
              parsed.data.comment ?? null,
              approval.status,
              newStatus,
              approval.version,
              newVersion,
              JSON.stringify(recordMetadata),
              req.ip ?? null,
              req.get('user-agent') ?? null,
            ]
          )

          const resolvedAt = new Date()
          const nextMetadata = { ...requestMetadata }
          if (flowMeta.id || flowMeta.name || flowSteps.length > 0) {
            nextMetadata.approvalFlow = {
              id: flowMeta.id,
              name: flowMeta.name,
              steps: flowSteps,
              currentStep: isFinalApproval ? currentStepIndex : currentStepIndex + 1,
            }
          }

          if (isFinalApproval) {
            await trx.query(
              `UPDATE attendance_requests
               SET status = $2, resolved_by = $3, resolved_at = $4, metadata = $5::jsonb, updated_at = now()
               WHERE id = $1`,
              [requestId, newStatus, requesterId, resolvedAt, JSON.stringify(nextMetadata)]
            )
          } else {
            await trx.query(
              `UPDATE attendance_requests
               SET metadata = $2::jsonb, updated_at = now()
               WHERE id = $1`,
              [requestId, JSON.stringify(nextMetadata)]
            )
          }

          let record = null
          const orgId = requestRow.org_id ?? DEFAULT_ORG_ID
          const requestType = requestRow.request_type
          if (action === 'approve' && isFinalApproval) {
            const baseRule = await loadDefaultRule(trx, orgId)
            const context = await resolveWorkContext({
              db: trx,
              orgId,
              userId: requestRow.user_id,
              workDate: requestRow.work_date,
              defaultRule: baseRule,
            })
            const timezone = context.rule.timezone
            if (requestType === 'missed_check_in' || requestType === 'missed_check_out' || requestType === 'time_correction') {
              const approvedMinutes = await loadApprovedMinutes(trx, orgId, requestRow.user_id, requestRow.work_date)
              const updateFirstInAt = requestRow.requested_in_at ? new Date(requestRow.requested_in_at) : null
              const updateLastOutAt = requestRow.requested_out_at ? new Date(requestRow.requested_out_at) : null
              record = await upsertAttendanceRecord({
                userId: requestRow.user_id,
                orgId,
                workDate: requestRow.work_date,
                timezone,
                rule: context.rule,
                updateFirstInAt,
                updateLastOutAt,
                mode: 'override',
                statusOverride: 'adjusted',
                isWorkday: context.isWorkingDay,
                leaveMinutes: approvedMinutes.leaveMinutes,
                overtimeMinutes: approvedMinutes.overtimeMinutes,
                client: trx,
              })
            } else if (requestType === 'leave' || requestType === 'overtime') {
              const approvedMinutes = await loadApprovedMinutes(trx, orgId, requestRow.user_id, requestRow.work_date)
              record = await upsertAttendanceRecord({
                userId: requestRow.user_id,
                orgId,
                workDate: requestRow.work_date,
                timezone,
                rule: context.rule,
                updateFirstInAt: null,
                updateLastOutAt: null,
                mode: 'merge',
                statusOverride: context.isWorkingDay ? 'adjusted' : 'off',
                isWorkday: context.isWorkingDay,
                leaveMinutes: approvedMinutes.leaveMinutes,
                overtimeMinutes: approvedMinutes.overtimeMinutes,
                client: trx,
              })
            }

            const eventMeta = {
              requestId,
              requestType,
              minutes: requestMetadata.minutes ?? null,
              leaveType: requestMetadata.leaveType ?? null,
              overtimeRule: requestMetadata.overtimeRule ?? null,
              requested_in_at: requestRow.requested_in_at,
              requested_out_at: requestRow.requested_out_at,
            }

            await trx.query(
              `INSERT INTO attendance_events
               (id, user_id, org_id, work_date, occurred_at, event_type, source, timezone, location, meta)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
              [
                randomUUID(),
                requestRow.user_id,
                orgId,
                requestRow.work_date,
                resolvedAt,
                'adjustment',
                'request',
                timezone,
                JSON.stringify({}),
                JSON.stringify(eventMeta),
              ]
            )
          }

          return {
            requestId,
            status: isFinalApproval ? newStatus : 'pending',
            record,
            orgId,
            userId: requestRow.user_id,
            approvalStep: {
              index: isFinalApproval ? currentStepIndex : currentStepIndex + 1,
              total: flowSteps.length,
            },
          }
        })

        emitEvent('attendance.resolved', {
          requestId: result.requestId,
          status: result.status,
          orgId: result.orgId,
          userId: result.userId,
        })
        res.json({ ok: true, data: result })
      } catch (error) {
        if (error instanceof HttpError) {
          res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
          return
        }
        if (isDatabaseSchemaError(error)) {
          res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
          return
        }
        logger.error('Attendance request resolution failed', error)
        res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve request' } })
      }
    }

    async function cancelRequest(req, res) {
      const parsed = resolveSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
        return
      }

      const requesterId = getUserId(req)
      if (!requesterId) {
        res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
        return
      }

      const requestId = req.params.id

      try {
        const result = await db.transaction(async (trx) => {
          const requestRows = await trx.query(
            'SELECT * FROM attendance_requests WHERE id = $1 FOR UPDATE',
            [requestId]
          )
          if (requestRows.length === 0) {
            throw new HttpError(404, 'NOT_FOUND', 'Request not found')
          }

          const requestRow = requestRows[0]
          if (requestRow.status !== 'pending') {
            throw new HttpError(400, 'INVALID_STATUS', 'Request already resolved')
          }

          if (requestRow.user_id !== requesterId) {
            const allowed = await canAccessOtherUsers(requesterId)
            if (!allowed) {
              throw new HttpError(403, 'FORBIDDEN', 'No access to cancel request')
            }
          }

          const approvalId = requestRow.approval_instance_id
          if (approvalId) {
            const approvalRows = await trx.query(
              'SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE',
              [approvalId]
            )
            if (approvalRows.length > 0) {
              const approval = approvalRows[0]
              const newStatus = 'cancelled'
              const newVersion = Number(approval.version ?? 0) + 1

              await trx.query(
                'UPDATE approval_instances SET status = $1, version = $2, updated_at = now() WHERE id = $3',
                [newStatus, newVersion, approvalId]
              )

              await trx.query(
                `INSERT INTO approval_records
                 (instance_id, action, actor_id, actor_name, comment, from_status, to_status, from_version, to_version, metadata, ip_address, user_agent)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
                [
                  approvalId,
                  'revoke',
                  requesterId,
                  getUserLabel(req, requesterId),
                  parsed.data.comment ?? null,
                  approval.status,
                  newStatus,
                  approval.version,
                  newVersion,
                  JSON.stringify(parsed.data.metadata ?? {}),
                  req.ip ?? null,
                  req.get('user-agent') ?? null,
                ]
              )
            }
          }

          const resolvedAt = new Date()
          await trx.query(
            `UPDATE attendance_requests
             SET status = $2, resolved_by = $3, resolved_at = $4, updated_at = now()
             WHERE id = $1`,
            [requestId, 'cancelled', requesterId, resolvedAt]
          )

          return {
            requestId,
            status: 'cancelled',
            orgId: requestRow.org_id ?? DEFAULT_ORG_ID,
            userId: requestRow.user_id,
          }
        })

        emitEvent('attendance.request.cancelled', {
          requestId: result.requestId,
          status: result.status,
          orgId: result.orgId,
          userId: result.userId,
        })
        res.json({ ok: true, data: result })
      } catch (error) {
        if (error instanceof HttpError) {
          res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
          return
        }
        if (isDatabaseSchemaError(error)) {
          res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
          return
        }
        logger.error('Attendance request cancellation failed', error)
        res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to cancel request' } })
      }
    }

    context.api.http.addRoute(
      'POST',
      '/api/attendance/requests/:id/approve',
      withPermission('attendance:approve', async (req, res) => resolveRequest(req, res, 'approve'))
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/requests/:id/reject',
      withPermission('attendance:approve', async (req, res) => resolveRequest(req, res, 'reject'))
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/requests/:id/cancel',
      withPermission('attendance:write', async (req, res) => cancelRequest(req, res))
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/leave-types',
      withPermission('attendance:admin', async (req, res) => {
        const schema = z.object({
          orgId: z.string().optional(),
          isActive: z.string().optional(),
        })

        const parsed = schema.safeParse({
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
          isActive: typeof req.query.isActive === 'string' ? req.query.isActive : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const { page, pageSize, offset } = parsePagination(req.query)
        const orgId = getOrgId(req)
        const params = [orgId]
        let activeFilter = ''
        if (parsed.data.isActive !== undefined) {
          params.push(parseBoolean(parsed.data.isActive, true))
          activeFilter = `AND is_active = $${params.length}`
        }

        try {
          const countRows = await db.query(
            `SELECT COUNT(*)::int AS total
             FROM attendance_leave_types
             WHERE org_id = $1 ${activeFilter}`,
            params
          )
          const total = Number(countRows[0]?.total ?? 0)

          params.push(pageSize, offset)
          const rows = await db.query(
            `SELECT * FROM attendance_leave_types
             WHERE org_id = $1 ${activeFilter}
             ORDER BY created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
          )

          res.json({
            ok: true,
            data: {
              items: rows.map(mapLeaveTypeRow),
              total,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance leave types query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load leave types' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/leave-types',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = leaveTypeCreateSchema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const payload = {
          code: parsed.data.code,
          name: parsed.data.name,
          requiresApproval: parsed.data.requiresApproval ?? true,
          requiresAttachment: parsed.data.requiresAttachment ?? false,
          defaultMinutesPerDay: parsed.data.defaultMinutesPerDay ?? 480,
          isActive: parsed.data.isActive ?? true,
        }

        try {
          const rows = await db.query(
            `INSERT INTO attendance_leave_types
             (id, org_id, code, name, requires_approval, requires_attachment, default_minutes_per_day, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
              randomUUID(),
              orgId,
              payload.code,
              payload.name,
              payload.requiresApproval,
              payload.requiresAttachment,
              payload.defaultMinutesPerDay,
              payload.isActive,
            ]
          )

          const leaveType = mapLeaveTypeRow(rows[0])
          emitEvent('attendance.leaveType.created', { orgId, leaveTypeId: leaveType.id })
          res.status(201).json({ ok: true, data: leaveType })
        } catch (error) {
          if (error?.code === '23505') {
            res.status(409).json({ ok: false, error: { code: 'ALREADY_EXISTS', message: 'Leave type code already exists' } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance leave type creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create leave type' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/leave-types/:id',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = leaveTypeUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const leaveTypeId = req.params.id

        try {
          const existingRows = await db.query(
            'SELECT * FROM attendance_leave_types WHERE id = $1 AND org_id = $2',
            [leaveTypeId, orgId]
          )
          if (!existingRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Leave type not found' } })
            return
          }

          const existing = existingRows[0]
          const payload = {
            code: parsed.data.code ?? existing.code,
            name: parsed.data.name ?? existing.name,
            requiresApproval: parsed.data.requiresApproval ?? existing.requires_approval,
            requiresAttachment: parsed.data.requiresAttachment ?? existing.requires_attachment,
            defaultMinutesPerDay: parsed.data.defaultMinutesPerDay ?? existing.default_minutes_per_day,
            isActive: parsed.data.isActive ?? existing.is_active,
          }

          const rows = await db.query(
            `UPDATE attendance_leave_types
             SET code = $3,
                 name = $4,
                 requires_approval = $5,
                 requires_attachment = $6,
                 default_minutes_per_day = $7,
                 is_active = $8,
                 updated_at = now()
             WHERE id = $1 AND org_id = $2
             RETURNING *`,
            [
              leaveTypeId,
              orgId,
              payload.code,
              payload.name,
              payload.requiresApproval,
              payload.requiresAttachment,
              payload.defaultMinutesPerDay,
              payload.isActive,
            ]
          )

          const leaveType = mapLeaveTypeRow(rows[0])
          emitEvent('attendance.leaveType.updated', { orgId, leaveTypeId: leaveType.id })
          res.json({ ok: true, data: leaveType })
        } catch (error) {
          if (error?.code === '23505') {
            res.status(409).json({ ok: false, error: { code: 'ALREADY_EXISTS', message: 'Leave type code already exists' } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance leave type update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update leave type' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/leave-types/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const leaveTypeId = req.params.id

        try {
          const rows = await db.query(
            'DELETE FROM attendance_leave_types WHERE id = $1 AND org_id = $2 RETURNING id',
            [leaveTypeId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Leave type not found' } })
            return
          }
          emitEvent('attendance.leaveType.deleted', { orgId, leaveTypeId })
          res.json({ ok: true, data: { id: leaveTypeId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance leave type delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete leave type' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/overtime-rules',
      withPermission('attendance:admin', async (req, res) => {
        const schema = z.object({
          orgId: z.string().optional(),
          isActive: z.string().optional(),
        })

        const parsed = schema.safeParse({
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
          isActive: typeof req.query.isActive === 'string' ? req.query.isActive : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const { page, pageSize, offset } = parsePagination(req.query)
        const orgId = getOrgId(req)
        const params = [orgId]
        let activeFilter = ''
        if (parsed.data.isActive !== undefined) {
          params.push(parseBoolean(parsed.data.isActive, true))
          activeFilter = `AND is_active = $${params.length}`
        }

        try {
          const countRows = await db.query(
            `SELECT COUNT(*)::int AS total
             FROM attendance_overtime_rules
             WHERE org_id = $1 ${activeFilter}`,
            params
          )
          const total = Number(countRows[0]?.total ?? 0)

          params.push(pageSize, offset)
          const rows = await db.query(
            `SELECT * FROM attendance_overtime_rules
             WHERE org_id = $1 ${activeFilter}
             ORDER BY created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
          )

          res.json({
            ok: true,
            data: {
              items: rows.map(mapOvertimeRuleRow),
              total,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance overtime rules query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load overtime rules' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/overtime-rules',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = overtimeRuleCreateSchema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const payload = {
          name: parsed.data.name,
          minMinutes: parsed.data.minMinutes ?? 0,
          roundingMinutes: parsed.data.roundingMinutes ?? 15,
          maxMinutesPerDay: parsed.data.maxMinutesPerDay ?? 600,
          requiresApproval: parsed.data.requiresApproval ?? true,
          isActive: parsed.data.isActive ?? true,
        }

        try {
          const rows = await db.query(
            `INSERT INTO attendance_overtime_rules
             (id, org_id, name, min_minutes, rounding_minutes, max_minutes_per_day, requires_approval, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
              randomUUID(),
              orgId,
              payload.name,
              payload.minMinutes,
              payload.roundingMinutes,
              payload.maxMinutesPerDay,
              payload.requiresApproval,
              payload.isActive,
            ]
          )

          const overtimeRule = mapOvertimeRuleRow(rows[0])
          emitEvent('attendance.overtimeRule.created', { orgId, overtimeRuleId: overtimeRule.id })
          res.status(201).json({ ok: true, data: overtimeRule })
        } catch (error) {
          if (error?.code === '23505') {
            res.status(409).json({ ok: false, error: { code: 'ALREADY_EXISTS', message: 'Overtime rule name already exists' } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance overtime rule creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create overtime rule' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/overtime-rules/:id',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = overtimeRuleUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const overtimeRuleId = req.params.id

        try {
          const existingRows = await db.query(
            'SELECT * FROM attendance_overtime_rules WHERE id = $1 AND org_id = $2',
            [overtimeRuleId, orgId]
          )
          if (!existingRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Overtime rule not found' } })
            return
          }

          const existing = existingRows[0]
          const payload = {
            name: parsed.data.name ?? existing.name,
            minMinutes: parsed.data.minMinutes ?? existing.min_minutes,
            roundingMinutes: parsed.data.roundingMinutes ?? existing.rounding_minutes,
            maxMinutesPerDay: parsed.data.maxMinutesPerDay ?? existing.max_minutes_per_day,
            requiresApproval: parsed.data.requiresApproval ?? existing.requires_approval,
            isActive: parsed.data.isActive ?? existing.is_active,
          }

          const rows = await db.query(
            `UPDATE attendance_overtime_rules
             SET name = $3,
                 min_minutes = $4,
                 rounding_minutes = $5,
                 max_minutes_per_day = $6,
                 requires_approval = $7,
                 is_active = $8,
                 updated_at = now()
             WHERE id = $1 AND org_id = $2
             RETURNING *`,
            [
              overtimeRuleId,
              orgId,
              payload.name,
              payload.minMinutes,
              payload.roundingMinutes,
              payload.maxMinutesPerDay,
              payload.requiresApproval,
              payload.isActive,
            ]
          )

          const overtimeRule = mapOvertimeRuleRow(rows[0])
          emitEvent('attendance.overtimeRule.updated', { orgId, overtimeRuleId: overtimeRule.id })
          res.json({ ok: true, data: overtimeRule })
        } catch (error) {
          if (error?.code === '23505') {
            res.status(409).json({ ok: false, error: { code: 'ALREADY_EXISTS', message: 'Overtime rule name already exists' } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance overtime rule update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update overtime rule' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/overtime-rules/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const overtimeRuleId = req.params.id

        try {
          const rows = await db.query(
            'DELETE FROM attendance_overtime_rules WHERE id = $1 AND org_id = $2 RETURNING id',
            [overtimeRuleId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Overtime rule not found' } })
            return
          }
          emitEvent('attendance.overtimeRule.deleted', { orgId, overtimeRuleId })
          res.json({ ok: true, data: { id: overtimeRuleId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance overtime rule delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete overtime rule' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/approval-flows',
      withPermission('attendance:admin', async (req, res) => {
        const schema = z.object({
          orgId: z.string().optional(),
          requestType: z.string().optional(),
          isActive: z.string().optional(),
        })

        const parsed = schema.safeParse({
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
          requestType: typeof req.query.requestType === 'string' ? req.query.requestType : undefined,
          isActive: typeof req.query.isActive === 'string' ? req.query.isActive : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const { page, pageSize, offset } = parsePagination(req.query)
        const orgId = getOrgId(req)
        const params = [orgId]
        let filters = ''
        if (parsed.data.requestType) {
          params.push(parsed.data.requestType)
          filters += ` AND request_type = $${params.length}`
        }
        if (parsed.data.isActive !== undefined) {
          params.push(parseBoolean(parsed.data.isActive, true))
          filters += ` AND is_active = $${params.length}`
        }

        try {
          const countRows = await db.query(
            `SELECT COUNT(*)::int AS total
             FROM attendance_approval_flows
             WHERE org_id = $1 ${filters}`,
            params
          )
          const total = Number(countRows[0]?.total ?? 0)

          params.push(pageSize, offset)
          const rows = await db.query(
            `SELECT * FROM attendance_approval_flows
             WHERE org_id = $1 ${filters}
             ORDER BY created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
          )

          res.json({
            ok: true,
            data: {
              items: rows.map(mapApprovalFlowRow),
              total,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance approval flows query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load approval flows' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/approval-flows',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = approvalFlowCreateSchema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const steps = normalizeApprovalSteps(parsed.data.steps)
        const payload = {
          name: parsed.data.name,
          requestType: parsed.data.requestType,
          steps,
          isActive: parsed.data.isActive ?? true,
        }

        try {
          const rows = await db.query(
            `INSERT INTO attendance_approval_flows
             (id, org_id, name, request_type, steps, is_active)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)
             RETURNING *`,
            [
              randomUUID(),
              orgId,
              payload.name,
              payload.requestType,
              JSON.stringify(payload.steps),
              payload.isActive,
            ]
          )

          const flow = mapApprovalFlowRow(rows[0])
          emitEvent('attendance.approvalFlow.created', { orgId, approvalFlowId: flow.id })
          res.status(201).json({ ok: true, data: flow })
        } catch (error) {
          if (error?.code === '23505') {
            res.status(409).json({ ok: false, error: { code: 'ALREADY_EXISTS', message: 'Approval flow already exists' } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance approval flow creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create approval flow' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/approval-flows/:id',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = approvalFlowUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const flowId = req.params.id

        try {
          const existingRows = await db.query(
            'SELECT * FROM attendance_approval_flows WHERE id = $1 AND org_id = $2',
            [flowId, orgId]
          )
          if (!existingRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Approval flow not found' } })
            return
          }

          const existing = existingRows[0]
          const steps = parsed.data.steps ? normalizeApprovalSteps(parsed.data.steps) : normalizeApprovalSteps(existing.steps)
          const payload = {
            name: parsed.data.name ?? existing.name,
            requestType: parsed.data.requestType ?? existing.request_type,
            steps,
            isActive: parsed.data.isActive ?? existing.is_active,
          }

          const rows = await db.query(
            `UPDATE attendance_approval_flows
             SET name = $3,
                 request_type = $4,
                 steps = $5::jsonb,
                 is_active = $6,
                 updated_at = now()
             WHERE id = $1 AND org_id = $2
             RETURNING *`,
            [
              flowId,
              orgId,
              payload.name,
              payload.requestType,
              JSON.stringify(payload.steps),
              payload.isActive,
            ]
          )

          const flow = mapApprovalFlowRow(rows[0])
          emitEvent('attendance.approvalFlow.updated', { orgId, approvalFlowId: flow.id })
          res.json({ ok: true, data: flow })
        } catch (error) {
          if (error?.code === '23505') {
            res.status(409).json({ ok: false, error: { code: 'ALREADY_EXISTS', message: 'Approval flow already exists' } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance approval flow update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update approval flow' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/approval-flows/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const flowId = req.params.id

        try {
          const rows = await db.query(
            'DELETE FROM attendance_approval_flows WHERE id = $1 AND org_id = $2 RETURNING id',
            [flowId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Approval flow not found' } })
            return
          }
          emitEvent('attendance.approvalFlow.deleted', { orgId, approvalFlowId: flowId })
          res.json({ ok: true, data: { id: flowId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance approval flow delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete approval flow' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/rotation-rules',
      withPermission('attendance:admin', async (req, res) => {
        const schema = z.object({
          orgId: z.string().optional(),
          isActive: z.string().optional(),
        })

        const parsed = schema.safeParse({
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
          isActive: typeof req.query.isActive === 'string' ? req.query.isActive : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const { page, pageSize, offset } = parsePagination(req.query)
        const orgId = getOrgId(req)
        const params = [orgId]
        let activeFilter = ''
        if (parsed.data.isActive !== undefined) {
          params.push(parseBoolean(parsed.data.isActive, true))
          activeFilter = `AND is_active = $${params.length}`
        }

        try {
          const countRows = await db.query(
            `SELECT COUNT(*)::int AS total
             FROM attendance_rotation_rules
             WHERE org_id = $1 ${activeFilter}`,
            params
          )
          const total = Number(countRows[0]?.total ?? 0)

          params.push(pageSize, offset)
          const rows = await db.query(
            `SELECT * FROM attendance_rotation_rules
             WHERE org_id = $1 ${activeFilter}
             ORDER BY created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
          )

          res.json({
            ok: true,
            data: {
              items: rows.map(mapRotationRuleRow),
              total,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rotation rules query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load rotation rules' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/rotation-rules',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = rotationRuleCreateSchema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const shiftSequence = normalizeStringArray(parsed.data.shiftSequence)
        if (shiftSequence.length === 0) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Shift sequence required' } })
          return
        }
        const payload = {
          name: parsed.data.name,
          timezone: parsed.data.timezone ?? 'UTC',
          shiftSequence,
          isActive: parsed.data.isActive ?? true,
        }

        try {
          const rows = await db.query(
            `INSERT INTO attendance_rotation_rules
             (id, org_id, name, timezone, shift_sequence, is_active)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)
             RETURNING *`,
            [
              randomUUID(),
              orgId,
              payload.name,
              payload.timezone,
              JSON.stringify(payload.shiftSequence),
              payload.isActive,
            ]
          )

          const rule = mapRotationRuleRow(rows[0])
          emitEvent('attendance.rotationRule.created', { orgId, rotationRuleId: rule.id })
          res.status(201).json({ ok: true, data: rule })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rotation rule creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create rotation rule' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/rotation-rules/:id',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = rotationRuleUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const ruleId = req.params.id

        try {
          const existingRows = await db.query(
            'SELECT * FROM attendance_rotation_rules WHERE id = $1 AND org_id = $2',
            [ruleId, orgId]
          )
          if (!existingRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Rotation rule not found' } })
            return
          }

          const existing = existingRows[0]
          const shiftSequence = parsed.data.shiftSequence
            ? normalizeStringArray(parsed.data.shiftSequence)
            : normalizeStringArray(existing.shift_sequence)
          if (shiftSequence.length === 0) {
            res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Shift sequence required' } })
            return
          }
          const payload = {
            name: parsed.data.name ?? existing.name,
            timezone: parsed.data.timezone ?? existing.timezone,
            shiftSequence,
            isActive: parsed.data.isActive ?? existing.is_active,
          }

          const rows = await db.query(
            `UPDATE attendance_rotation_rules
             SET name = $3,
                 timezone = $4,
                 shift_sequence = $5::jsonb,
                 is_active = $6,
                 updated_at = now()
             WHERE id = $1 AND org_id = $2
             RETURNING *`,
            [
              ruleId,
              orgId,
              payload.name,
              payload.timezone,
              JSON.stringify(payload.shiftSequence),
              payload.isActive,
            ]
          )

          const rule = mapRotationRuleRow(rows[0])
          emitEvent('attendance.rotationRule.updated', { orgId, rotationRuleId: rule.id })
          res.json({ ok: true, data: rule })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rotation rule update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update rotation rule' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/rotation-rules/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const ruleId = req.params.id

        try {
          const rows = await db.query(
            'DELETE FROM attendance_rotation_rules WHERE id = $1 AND org_id = $2 RETURNING id',
            [ruleId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Rotation rule not found' } })
            return
          }
          emitEvent('attendance.rotationRule.deleted', { orgId, rotationRuleId: ruleId })
          res.json({ ok: true, data: { id: ruleId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rotation rule delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete rotation rule' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/rotation-assignments',
      withPermission('attendance:admin', async (req, res) => {
        const schema = z.object({
          orgId: z.string().optional(),
        })

        const parsed = schema.safeParse({
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const { page, pageSize, offset } = parsePagination(req.query)
        const orgId = getOrgId(req)

        try {
          const countRows = await db.query(
            `SELECT COUNT(*)::int AS total
             FROM attendance_rotation_assignments
             WHERE org_id = $1`,
            [orgId]
          )
          const total = Number(countRows[0]?.total ?? 0)

          const rows = await db.query(
            `SELECT a.id, a.org_id, a.user_id, a.rotation_rule_id, a.start_date, a.end_date, a.is_active,
                    r.name AS rotation_name, r.timezone AS rotation_timezone, r.shift_sequence AS rotation_shift_sequence,
                    r.is_active AS rotation_is_active
             FROM attendance_rotation_assignments a
             JOIN attendance_rotation_rules r ON r.id = a.rotation_rule_id
             WHERE a.org_id = $1
             ORDER BY a.start_date DESC, a.created_at DESC
             LIMIT $2 OFFSET $3`,
            [orgId, pageSize, offset]
          )

          const items = rows.map(row => ({
            assignment: mapRotationAssignmentRow(row),
            rotation: mapRotationRuleFromAssignmentRow(row),
          }))

          res.json({
            ok: true,
            data: {
              items,
              total,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rotation assignments query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load rotation assignments' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/rotation-assignments',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = rotationAssignmentCreateSchema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const payload = {
          userId: parsed.data.userId,
          rotationRuleId: parsed.data.rotationRuleId,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate ?? null,
          isActive: parsed.data.isActive ?? true,
        }

        try {
          const ruleRows = await db.query(
            'SELECT * FROM attendance_rotation_rules WHERE id = $1 AND org_id = $2',
            [payload.rotationRuleId, orgId]
          )
          if (!ruleRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Rotation rule not found' } })
            return
          }

          const rows = await db.query(
            `INSERT INTO attendance_rotation_assignments
             (id, org_id, user_id, rotation_rule_id, start_date, end_date, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
              randomUUID(),
              orgId,
              payload.userId,
              payload.rotationRuleId,
              payload.startDate,
              payload.endDate,
              payload.isActive,
            ]
          )

          const assignment = mapRotationAssignmentRow(rows[0])
          const rotation = mapRotationRuleRow(ruleRows[0])
          emitEvent('attendance.rotationAssignment.created', { orgId, rotationAssignmentId: assignment.id })
          res.status(201).json({ ok: true, data: { assignment, rotation } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rotation assignment creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create rotation assignment' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/rotation-assignments/:id',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = rotationAssignmentUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const assignmentId = req.params.id

        try {
          const existingRows = await db.query(
            'SELECT * FROM attendance_rotation_assignments WHERE id = $1 AND org_id = $2',
            [assignmentId, orgId]
          )
          if (!existingRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Rotation assignment not found' } })
            return
          }

          const existing = existingRows[0]
          const payload = {
            userId: parsed.data.userId ?? existing.user_id,
            rotationRuleId: parsed.data.rotationRuleId ?? existing.rotation_rule_id,
            startDate: parsed.data.startDate ?? existing.start_date,
            endDate: parsed.data.endDate ?? existing.end_date,
            isActive: parsed.data.isActive ?? existing.is_active,
          }

          const ruleRows = await db.query(
            'SELECT * FROM attendance_rotation_rules WHERE id = $1 AND org_id = $2',
            [payload.rotationRuleId, orgId]
          )
          if (!ruleRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Rotation rule not found' } })
            return
          }

          const rows = await db.query(
            `UPDATE attendance_rotation_assignments
             SET user_id = $3,
                 rotation_rule_id = $4,
                 start_date = $5,
                 end_date = $6,
                 is_active = $7,
                 updated_at = now()
             WHERE id = $1 AND org_id = $2
             RETURNING *`,
            [
              assignmentId,
              orgId,
              payload.userId,
              payload.rotationRuleId,
              payload.startDate,
              payload.endDate,
              payload.isActive,
            ]
          )

          const assignment = mapRotationAssignmentRow(rows[0])
          const rotation = mapRotationRuleRow(ruleRows[0])
          emitEvent('attendance.rotationAssignment.updated', { orgId, rotationAssignmentId: assignment.id })
          res.json({ ok: true, data: { assignment, rotation } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rotation assignment update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update rotation assignment' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/rotation-assignments/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const assignmentId = req.params.id

        try {
          const rows = await db.query(
            'DELETE FROM attendance_rotation_assignments WHERE id = $1 AND org_id = $2 RETURNING id',
            [assignmentId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Rotation assignment not found' } })
            return
          }
          emitEvent('attendance.rotationAssignment.deleted', { orgId, rotationAssignmentId: assignmentId })
          res.json({ ok: true, data: { id: assignmentId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rotation assignment delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete rotation assignment' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/rules/default',
      withPermission('attendance:read', async (req, res) => {
        try {
          const orgId = getOrgId(req)
          const rule = await loadDefaultRule(db, orgId)
          res.json({ ok: true, data: rule })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rule lookup failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load rule' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/rules/default',
      withPermission('attendance:admin', async (req, res) => {
        const schema = z.object({
          name: z.string().optional(),
          timezone: z.string().optional(),
          workStartTime: z.string().optional(),
          workEndTime: z.string().optional(),
          lateGraceMinutes: z.number().int().min(0).optional(),
          earlyGraceMinutes: z.number().int().min(0).optional(),
          roundingMinutes: z.number().int().min(0).optional(),
          workingDays: z.array(z.number().int().min(0).max(6)).optional(),
          orgId: z.string().optional(),
        })

        const parsed = schema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const payload = {
          name: parsed.data.name ?? DEFAULT_RULE.name,
          timezone: parsed.data.timezone ?? DEFAULT_RULE.timezone,
          workStartTime: parsed.data.workStartTime ?? DEFAULT_RULE.workStartTime,
          workEndTime: parsed.data.workEndTime ?? DEFAULT_RULE.workEndTime,
          lateGraceMinutes: parsed.data.lateGraceMinutes ?? DEFAULT_RULE.lateGraceMinutes,
          earlyGraceMinutes: parsed.data.earlyGraceMinutes ?? DEFAULT_RULE.earlyGraceMinutes,
          roundingMinutes: parsed.data.roundingMinutes ?? DEFAULT_RULE.roundingMinutes,
          workingDays: parsed.data.workingDays ?? DEFAULT_RULE.workingDays,
        }

        const orgId = getOrgId(req)
        try {
          const rule = await db.transaction(async (trx) => {
            await trx.query('UPDATE attendance_rules SET is_default = false WHERE is_default = true AND org_id = $1', [orgId])

            const rows = await trx.query(
              `INSERT INTO attendance_rules
               (id, org_id, name, timezone, work_start_time, work_end_time, late_grace_minutes, early_grace_minutes, rounding_minutes, working_days, is_default)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, true)
               RETURNING *`,
              [
                randomUUID(),
                orgId,
                payload.name,
                payload.timezone,
                payload.workStartTime,
                payload.workEndTime,
                payload.lateGraceMinutes,
                payload.earlyGraceMinutes,
                payload.roundingMinutes,
                JSON.stringify(payload.workingDays),
              ]
            )

            return rows[0]
          })

          const mapped = mapRuleRow(rule)
          emitEvent('attendance.rule.updated', {
            orgId,
            ruleId: mapped.id,
          })
          res.json({ ok: true, data: mapped })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rule update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update rule' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/rule-sets',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const { page, pageSize, offset } = parsePagination(req.query)

        try {
          const countRows = await db.query(
            'SELECT COUNT(*)::int AS total FROM attendance_rule_sets WHERE org_id = $1',
            [orgId]
          )
          const total = Number(countRows[0]?.total ?? 0)
          const rows = await db.query(
            `SELECT * FROM attendance_rule_sets
             WHERE org_id = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [orgId, pageSize, offset]
          )
          res.json({
            ok: true,
            data: {
              items: rows.map(mapRuleSetRow),
              total,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rule sets query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load rule sets' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/rule-sets/template',
      withPermission('attendance:admin', async (_req, res) => {
        res.json({
          ok: true,
          data: {
            source: 'dingtalk',
            mappings: {
              columns: [
                { sourceField: '1_on_duty_user_check_time', targetField: 'firstInAt', dataType: 'datetime' },
                { sourceField: '1_off_duty_user_check_time', targetField: 'lastOutAt', dataType: 'datetime' },
                { sourceField: 'attend_result', targetField: 'status', dataType: 'string' },
                { sourceField: 'plan_detail', targetField: 'shiftName', dataType: 'string' },
                { sourceField: 'attendance_class', targetField: 'attendanceClass', dataType: 'string' },
                { sourceField: 'attendance_approve', targetField: 'approvalSummary', dataType: 'string' },
                { sourceField: 'attendance_group', targetField: 'attendanceGroup', dataType: 'string' },
                { sourceField: 'department', targetField: 'department', dataType: 'string' },
                { sourceField: 'role', targetField: 'role', dataType: 'string' },
                { sourceField: 'UserId', targetField: 'userId', dataType: 'string' },
                { sourceField: 'workDate', targetField: 'workDate', dataType: 'date' },
                { sourceField: 'entryTime', targetField: 'entryTime', dataType: 'date' },
                { sourceField: 'resignTime', targetField: 'resignTime', dataType: 'date' },
              ],
            },
            approvals: {
              processCodes: [],
              roleMappings: [],
            },
            payroll: {
              cycleMode: 'template',
              templateId: '',
            },
            engine: {
              templates: [
                {
                  name: '单休车间规则',
                  category: 'system',
                  editable: false,
                  params: [
                    { key: 'groupName', label: 'Attendance group', type: 'string', default: '单休车间', paths: ['scope.attendance_group[0]'] },
                    { key: 'restTripOvertimeHours', label: 'Rest day trip overtime (hours)', type: 'number', default: 8, paths: ['rules[0].then.overtime_hours'] },
                    { key: 'lateWarningAfter', label: 'Late checkout warning after', type: 'string', default: '19:00', paths: ['rules[1].when.clockOut2_after'] },
                  ],
                  scope: { attendance_group: ['单休车间'] },
                  rules: [
                    {
                      id: 'rest_trip_default_overtime',
                      when: { shift: '休息', approval_contains: '出差' },
                      then: { overtime_hours: 8, reason: '单休车间休息日出差默认8小时' },
                    },
                    {
                      id: 'after7_no_overtime_warning',
                      when: { clockOut2_after: '19:00', overtime_hours_eq: 0 },
                      then: { warning: '下班晚但无加班单' },
                    },
                    {
                      id: 'rest_punch_no_overtime_warning',
                      when: { exceptionReason_contains: '休息并打卡', overtime_hours_eq: 0 },
                      then: { warning: '休息日打卡但无加班单' },
                    },
                    {
                      id: 'rest_punch_missing_checkout_warning',
                      when: {
                        exceptionReason_contains: '休息并打卡',
                        clockIn1_exists: true,
                        clockOut1_exists: false,
                      },
                      then: { warning: '休息日打卡但缺少下班卡' },
                    },
                  ],
                },
                {
                  name: '通用提醒',
                  category: 'system',
                  editable: false,
                  rules: [
                    {
                      id: 'overtime_approval_no_punch_warning',
                      when: { approval_contains: '加班', has_punch: false },
                      then: { warning: '有加班单但未打卡' },
                    },
                    {
                      id: 'trip_and_overtime_warning',
                      when: { exceptionReason_contains: '出差', overtime_hours_gt: 0 },
                      then: { warning: '出差同时存在加班工时，请核对' },
                    },
                    {
                      id: 'trip_low_hours_warning',
                      when: {
                        exceptionReason_contains: '出差',
                        shift_not_contains: '休息',
                        actual_hours_lt: 8,
                        department_not_contains: ['国内销售', '服务测试部-调试'],
                      },
                      then: { warning: '出差当天实际工时不足8小时，请核对' },
                    },
                    {
                      id: 'leave_makeup_missing_punch_warning',
                      when: { exceptionReason_contains: ['缺卡', '补卡'], clockIn2_exists: false },
                      then: { warning: '缺卡且补卡，但未找到上班2打卡，请核对' },
                    },
                    {
                      id: 'trip_and_leave_conflict_warning',
                      when: { exceptionReason_contains: ['出差', '事假'] },
                      then: { warning: '出差+事假请核对' },
                    },
                    {
                      id: 'trip_and_sick_conflict_warning',
                      when: { exceptionReason_contains: ['出差', '病假'] },
                      then: { warning: '出差+病假请核对' },
                    },
                    {
                      id: 'trip_and_injury_conflict_warning',
                      when: { exceptionReason_contains: ['出差', '工伤假'] },
                      then: { warning: '出差+工伤假请核对' },
                    },
                  ],
                },
                {
                  name: '标准上下班提醒',
                  category: 'system',
                  editable: false,
                  params: [
                    { key: 'lateAfter', label: 'Late after (HH:MM)', type: 'string', default: '09:10', paths: ['rules[0].when.clockIn1_after'] },
                    { key: 'earlyBefore', label: 'Leave before (HH:MM)', type: 'string', default: '17:50', paths: ['rules[1].when.clockOut1_before'] },
                    { key: 'lateWarning', label: 'Late warning text', type: 'string', default: '迟到，请核对', paths: ['rules[0].then.warning'] },
                    { key: 'earlyWarning', label: 'Early leave warning text', type: 'string', default: '早退，请核对', paths: ['rules[1].then.warning'] },
                  ],
                  rules: [
                    {
                      id: 'late_after_warning',
                      when: { clockIn1_after: '09:10' },
                      then: { warning: '迟到，请核对' },
                    },
                    {
                      id: 'early_leave_warning',
                      when: { clockOut1_before: '17:50' },
                      then: { warning: '早退，请核对' },
                    },
                  ],
                },
                {
                  name: '缺卡补卡核对',
                  category: 'system',
                  editable: false,
                  rules: [
                    {
                      id: 'missing_checkout_warning',
                      when: { clockIn1_exists: true, clockOut1_exists: false },
                      then: { warning: '缺少下班卡' },
                    },
                    {
                      id: 'missing_checkin_warning',
                      when: { clockIn1_exists: false, clockOut1_exists: true },
                      then: { warning: '缺少上班卡' },
                    },
                    {
                      id: 'makeup_missing_second_in',
                      when: { exceptionReason_contains_any: ['补卡', '缺卡'], clockIn2_exists: false },
                      then: { warning: '缺卡/补卡但未找到上班2打卡' },
                    },
                  ],
                },
                {
                  name: '休息日加班',
                  category: 'system',
                  editable: false,
                  params: [
                    { key: 'restOvertimeHours', label: 'Rest day overtime (hours)', type: 'number', default: 8, paths: ['rules[0].then.overtime_hours'] },
                    { key: 'restReason', label: 'Reason text', type: 'string', default: '休息日打卡算加班', paths: ['rules[0].then.reason'] },
                  ],
                  rules: [
                    {
                      id: 'rest_day_punch_overtime',
                      when: { shift_contains: '休息', has_punch: true },
                      then: { overtime_hours: 8, reason: '休息日打卡算加班' },
                    },
                  ],
                },
                {
                  name: '角色规则',
                  category: 'system',
                  editable: false,
                  params: [
                    { key: 'securityBaseHours', label: 'Security base hours', type: 'number', default: 8, paths: ['rules[0].then.required_hours'] },
                    { key: 'securityHolidayOvertime', label: 'Security holiday overtime (hours)', type: 'number', default: 8, paths: ['rules[1].then.overtime_hours'] },
                    { key: 'driverRestOvertime', label: 'Driver rest overtime (hours)', type: 'number', default: 8, paths: ['rules[2].then.overtime_hours'] },
                  ],
                  scope: { role_tags: ['security', 'driver'] },
                  rules: [
                    {
                      id: 'security_base_hours',
                      when: { role: 'security' },
                      then: { required_hours: 8 },
                    },
                    {
                      id: 'security_holiday_overtime',
                      when: { role: 'security', is_holiday: true, has_punch: true },
                      then: { overtime_hours: 8, reason: '保安节假日算加班' },
                    },
                    {
                      id: 'driver_rest_punch_overtime',
                      when: { role: 'driver', shift: '休息', clockIn1_exists: true },
                      then: { overtime_hours: 8, reason: '司机休息日打卡算加班' },
                    },
                  ],
                },
                {
                  name: '部门提醒',
                  category: 'system',
                  editable: false,
                  scope: { department: ['国内销售', '服务测试部-调试'] },
                  rules: [
                    {
                      id: 'trip_and_leave_warning',
                      when: { exceptionReason_contains: ['出差', '事假'] },
                      then: { warning: '出差+事假请核对' },
                    },
                    {
                      id: 'trip_and_sick_warning',
                      when: { exceptionReason_contains: ['出差', '病假'] },
                      then: { warning: '出差+病假请核对' },
                    },
                    {
                      id: 'trip_and_injury_warning',
                      when: { exceptionReason_contains: ['出差', '工伤假'] },
                      then: { warning: '出差+工伤假请核对' },
                    },
                  ],
                },
                {
                  name: '用户自定义',
                  category: 'custom',
                  editable: true,
                  description: '为考勤管理员预留的自定义规则模板',
                  rules: [],
                },
              ],
            },
            policies: {
              userGroups: [
                {
                  name: 'security',
                  fieldContains: { attendance_group: '保安' },
                },
                {
                  name: 'security',
                  fieldContains: { role: '保安' },
                },
                {
                  name: 'driver',
                  fieldContains: { role: '司机' },
                },
                {
                  name: 'driver',
                  fieldContains: { attendance_group: '司机' },
                },
                {
                  name: 'single_rest_workshop',
                  fieldContains: { attendance_group: '单休车间' },
                },
              ],
              rules: [
                {
                  name: 'holiday-entry-after-zero',
                  when: { isHoliday: true, fieldEquals: { entry_after_work_date: true } },
                  then: { setWorkMinutes: 0, setStatus: 'off', addWarning: '入职晚于节假日，出勤设为0' },
                },
                {
                  name: 'holiday-resigned-zero',
                  when: { isHoliday: true, fieldEquals: { resign_on_or_before_work_date: true } },
                  then: { setWorkMinutes: 0, setStatus: 'off', addWarning: '离职日期早于/等于节假日，出勤设为0' },
                },
                {
                  name: 'holiday-default-8h',
                  when: { isHoliday: true, fieldEquals: { entry_on_or_before_work_date: true, resign_on_or_before_work_date: false } },
                  then: { setWorkMinutes: 480, setStatus: 'adjusted', addWarning: '节假日默认8小时' },
                },
                {
                  name: 'single-rest-trip-overtime',
                  when: { userGroup: 'single_rest_workshop', fieldContains: { shiftName: '休息', approvalSummary: '出差' } },
                  then: { setOvertimeMinutes: 480, addWarning: '单休车间休息日出差默认8小时加班' },
                },
                {
                  name: 'security-base-hours',
                  when: { userGroup: 'security' },
                  then: { setWorkMinutes: 480, setStatus: 'adjusted', addWarning: '保安默认按8小时出勤' },
                },
                {
                  name: 'security-holiday-overtime',
                  when: { userGroup: 'security', isHoliday: true, fieldExists: ['firstInAt'] },
                  then: { setOvertimeMinutes: 480, addWarning: '保安节假日出勤算加班' },
                },
                {
                  name: 'driver-rest-overtime',
                  when: { userGroup: 'driver', fieldContains: { shiftName: '休息' }, fieldExists: ['firstInAt'] },
                  then: { setOvertimeMinutes: 480, addWarning: '司机休息日打卡算加班' },
                },
                {
                  name: 'special-user-fixed-hours',
                  when: { userIds: ['16256197521696414'] },
                  then: { setWorkMinutes: 600, setStatus: 'adjusted', addWarning: '特殊十小时班次' },
                },
              ],
            },
          },
        })
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/rule-sets',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = ruleSetCreateSchema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const payload = {
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          version: parsed.data.version ?? 1,
          scope: parsed.data.scope ?? 'org',
          config: parsed.data.config ?? {},
          isDefault: parsed.data.isDefault ?? false,
        }

        const configValidation = ruleSetConfigSchema.safeParse(payload.config)
        if (!configValidation.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: configValidation.error.message } })
          return
        }
        payload.config = configValidation.data

        try {
          const ruleSet = await db.transaction(async (trx) => {
            if (payload.isDefault) {
              await trx.query('UPDATE attendance_rule_sets SET is_default = false WHERE org_id = $1', [orgId])
            }
            const rows = await trx.query(
              `INSERT INTO attendance_rule_sets
               (id, org_id, name, description, version, scope, config, is_default)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
               RETURNING *`,
              [
                randomUUID(),
                orgId,
                payload.name,
                payload.description,
                payload.version,
                payload.scope,
                JSON.stringify(payload.config),
                payload.isDefault,
              ]
            )
            return rows[0]
          })

          const mapped = mapRuleSetRow(ruleSet)
          emitEvent('attendance.ruleSet.created', { orgId, ruleSetId: mapped.id })
          res.status(201).json({ ok: true, data: mapped })
        } catch (error) {
          if (error?.code === '23505') {
            res.status(409).json({ ok: false, error: { code: 'ALREADY_EXISTS', message: 'Rule set already exists' } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rule set creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create rule set' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/rule-sets/:id',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = ruleSetUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const ruleSetId = req.params.id

        try {
          const existingRows = await db.query(
            'SELECT * FROM attendance_rule_sets WHERE id = $1 AND org_id = $2',
            [ruleSetId, orgId]
          )
          if (!existingRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Rule set not found' } })
            return
          }
          const existing = existingRows[0]
          const payload = {
            name: parsed.data.name ?? existing.name,
            description: parsed.data.description ?? existing.description,
            version: parsed.data.version ?? existing.version ?? 1,
            scope: parsed.data.scope ?? existing.scope ?? 'org',
            config: parsed.data.config ?? normalizeMetadata(existing.config),
            isDefault: parsed.data.isDefault ?? existing.is_default ?? false,
          }

          const configValidation = ruleSetConfigSchema.safeParse(payload.config)
          if (!configValidation.success) {
            res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: configValidation.error.message } })
            return
          }
          payload.config = configValidation.data

          const updated = await db.transaction(async (trx) => {
            if (payload.isDefault) {
              await trx.query('UPDATE attendance_rule_sets SET is_default = false WHERE org_id = $1', [orgId])
            }
            const rows = await trx.query(
              `UPDATE attendance_rule_sets
               SET name = $3,
                   description = $4,
                   version = $5,
                   scope = $6,
                   config = $7::jsonb,
                   is_default = $8,
                   updated_at = now()
               WHERE id = $1 AND org_id = $2
               RETURNING *`,
              [
                ruleSetId,
                orgId,
                payload.name,
                payload.description,
                payload.version,
                payload.scope,
                JSON.stringify(payload.config),
                payload.isDefault,
              ]
            )
            return rows[0]
          })

          const mapped = mapRuleSetRow(updated)
          emitEvent('attendance.ruleSet.updated', { orgId, ruleSetId: mapped.id })
          res.json({ ok: true, data: mapped })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rule set update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update rule set' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/rule-sets/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const ruleSetId = req.params.id

        try {
          const rows = await db.query(
            'DELETE FROM attendance_rule_sets WHERE id = $1 AND org_id = $2 RETURNING id',
            [ruleSetId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Rule set not found' } })
            return
          }
          emitEvent('attendance.ruleSet.deleted', { orgId, ruleSetId })
          res.json({ ok: true, data: { id: ruleSetId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rule set delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete rule set' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/rule-sets/preview',
      withPermission('attendance:read', async (req, res) => {
        const schema = z.object({
          ruleSetId: z.string().uuid().optional(),
          config: z.record(z.unknown()).optional(),
          events: z.array(z.object({
            eventType: z.enum(['check_in', 'check_out']),
            occurredAt: z.string(),
            workDate: z.string().optional(),
            userId: z.string().optional(),
          })).optional(),
        })

        const parsed = schema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        let config = parsed.data.config ?? {}
        let ruleSetId = parsed.data.ruleSetId

        try {
          if (ruleSetId) {
            const rows = await db.query(
              'SELECT * FROM attendance_rule_sets WHERE id = $1 AND org_id = $2',
              [ruleSetId, orgId]
            )
            if (!rows.length) {
              res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Rule set not found' } })
              return
            }
            config = normalizeMetadata(rows[0].config)
          }

          const baseRule = await loadDefaultRule(db, orgId)
          const override = normalizeRuleOverride(config.rule)
          const ruleOverride = override
            ? {
              ...baseRule,
              ...override,
              workingDays: override.workingDays ?? baseRule.workingDays,
            }
            : baseRule

          const events = Array.isArray(parsed.data.events) ? parsed.data.events : []
          const buckets = new Map()
          for (const event of events) {
            const occurred = parseDateInput(event.occurredAt)
            if (!occurred) continue
            const userId = event.userId ?? 'unknown'
            const workDate = event.workDate ?? toWorkDate(occurred, ruleOverride.timezone)
            const key = `${userId}::${workDate}`
            const entry = buckets.get(key) ?? {
              userId,
              workDate,
              firstInAt: null,
              lastOutAt: null,
            }
            if (event.eventType === 'check_in') {
              if (!entry.firstInAt || occurred < entry.firstInAt) entry.firstInAt = occurred
            }
            if (event.eventType === 'check_out') {
              if (!entry.lastOutAt || occurred > entry.lastOutAt) entry.lastOutAt = occurred
            }
            buckets.set(key, entry)
          }

          const preview = []
          for (const entry of buckets.values()) {
            const context = await resolveWorkContext({
              db,
              orgId,
              userId: entry.userId,
              workDate: entry.workDate,
              defaultRule: ruleOverride,
            })
            const metrics = computeMetrics({
              rule: context.rule,
              firstInAt: entry.firstInAt,
              lastOutAt: entry.lastOutAt,
              isWorkingDay: context.isWorkingDay,
            })
            preview.push({
              userId: entry.userId,
              workDate: entry.workDate,
              firstInAt: entry.firstInAt ? entry.firstInAt.toISOString() : null,
              lastOutAt: entry.lastOutAt ? entry.lastOutAt.toISOString() : null,
              workMinutes: metrics.workMinutes,
              lateMinutes: metrics.lateMinutes,
              earlyLeaveMinutes: metrics.earlyLeaveMinutes,
              status: metrics.status,
              isWorkingDay: context.isWorkingDay,
              source: context.source,
            })
          }

          res.json({
            ok: true,
            data: {
              ruleSetId: ruleSetId ?? null,
              totalEvents: events.length,
              preview,
              config,
              notes: ['Preview uses rule/shift/holiday context with basic in/out pairing.'],
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance rule set preview failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to preview rule set' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/import/template',
      withPermission('attendance:admin', async (_req, res) => {
        res.json({
          ok: true,
          data: {
            source: 'dingtalk',
            mapping: {
              columns: [
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
                { sourceField: 'UserId', targetField: 'userId', dataType: 'string' },
                { sourceField: 'userId', targetField: 'userId', dataType: 'string' },
                { sourceField: 'workDate', targetField: 'workDate', dataType: 'date' },
                { sourceField: '入职时间', targetField: 'entryTime', dataType: 'date' },
                { sourceField: 'entry_time', targetField: 'entryTime', dataType: 'date' },
                { sourceField: '离职时间', targetField: 'resignTime', dataType: 'date' },
                { sourceField: 'resign_time', targetField: 'resignTime', dataType: 'date' },
                { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
                { sourceField: '姓名', targetField: 'userName', dataType: 'string' },
              ],
            },
            payloadExample: {
              source: 'dingtalk_csv',
              ruleSetId: '<ruleSetId>',
              userMapKeyField: 'empNo',
              userMap: {
                A0054: { userId: 'tmp_9cf257fde42ac517bc769838', name: '秦夫林', empNo: 'A0054' },
              },
              entries: [
                {
                  userId: 'tmp_9cf257fde42ac517bc769838',
                  occurredAt: '2026-01-20T07:51:00',
                  eventType: 'check_in',
                  timezone: 'Asia/Shanghai',
                  meta: {
                    workDate: '2026-01-20',
                    column: '上班1打卡时间',
                    rawTime: '07:51',
                    sourceUserKey: 'A0054',
                    sourceUserName: '秦夫林',
                  },
                },
                {
                  userId: 'tmp_9cf257fde42ac517bc769838',
                  occurredAt: '2026-01-20T17:05:00',
                  eventType: 'check_out',
                  timezone: 'Asia/Shanghai',
                  meta: {
                    workDate: '2026-01-20',
                    column: '下班1打卡时间',
                    rawTime: '17:05',
                    sourceUserKey: 'A0054',
                    sourceUserName: '秦夫林',
                  },
                },
              ],
            },
          },
        })
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/import/preview',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = importPayloadSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const userId = parsed.data.userId ?? getUserId(req)
        if (!userId) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId is required' } })
          return
        }

        try {
          let ruleSetConfig = null
          if (parsed.data.ruleSetId) {
            const rows = await db.query(
              'SELECT config FROM attendance_rule_sets WHERE id = $1 AND org_id = $2',
              [parsed.data.ruleSetId, orgId]
            )
            if (rows.length) ruleSetConfig = normalizeMetadata(rows[0].config)
          }

          const mapping = parsed.data.mapping?.columns
            ?? parsed.data.mapping?.fields
            ?? ruleSetConfig?.mappings?.columns
            ?? ruleSetConfig?.mappings?.fields
            ?? []

          let engine = null
          const engineConfig = parsed.data.engine ?? ruleSetConfig?.engine
          if (engineConfig) {
            try {
              engine = createRuleEngine({ config: engineConfig, logger })
            } catch (error) {
              logger.warn('Attendance rule engine config invalid (preview)', error)
            }
          }

          const rows = Array.isArray(parsed.data.rows)
            ? parsed.data.rows
            : Array.isArray(parsed.data.entries)
              ? buildRowsFromEntries({ entries: parsed.data.entries })
              : buildRowsFromDingTalk({ columns: parsed.data.columns, data: parsed.data.data })

          if (rows.length === 0) {
            res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'No rows to preview' } })
            return
          }

          const baseRule = await loadDefaultRule(db, orgId)
          const override = normalizeRuleOverride(ruleSetConfig?.rule)
          const ruleOverride = override
            ? { ...baseRule, ...override, workingDays: override.workingDays ?? baseRule.workingDays }
            : baseRule

          const statusMap = parsed.data.statusMap ?? {}
          const preview = []
          for (const row of rows) {
            const workDate = row.workDate
            const rowUserId = resolveRowUserId({
              row,
              fallbackUserId: userId,
              userMap: parsed.data.userMap,
              userMapKeyField: parsed.data.userMapKeyField,
              userMapSourceFields: parsed.data.userMapSourceFields,
            })
            const context = await resolveWorkContext({
              db,
              orgId,
              userId: rowUserId,
              workDate,
              defaultRule: ruleOverride,
            })
            const mapped = applyFieldMappings(row.fields ?? {}, mapping)
            const valueFor = (key) => (mapped[key]?.value !== undefined ? mapped[key].value : row.fields?.[key])
            const dataTypeFor = (key) => mapped[key]?.dataType

            const firstInAt = parseImportedDateTime(valueFor('firstInAt'), workDate, context.rule.timezone)
            const lastOutAt = parseImportedDateTime(valueFor('lastOutAt'), workDate, context.rule.timezone)
            const statusRaw = valueFor('status')
            const statusOverride = statusRaw != null
              ? resolveStatusOverride(statusRaw, statusMap)
              : null

            const workMinutes = parseMinutesValue(
              valueFor('workMinutes') ?? valueFor('workHours'),
              dataTypeFor('workMinutes') ?? dataTypeFor('workHours')
            )
            const lateMinutes = parseMinutesValue(valueFor('lateMinutes'), dataTypeFor('lateMinutes'))
            const earlyLeaveMinutes = parseMinutesValue(valueFor('earlyLeaveMinutes'), dataTypeFor('earlyLeaveMinutes'))
            const leaveMinutes = parseMinutesValue(valueFor('leaveMinutes') ?? valueFor('leaveHours'), dataTypeFor('leaveMinutes') ?? dataTypeFor('leaveHours'))
            const overtimeMinutes = parseMinutesValue(valueFor('overtimeMinutes') ?? valueFor('overtimeHours'), dataTypeFor('overtimeMinutes') ?? dataTypeFor('overtimeHours'))

            const computed = computeMetrics({
              rule: context.rule,
              firstInAt,
              lastOutAt,
              isWorkingDay: context.isWorkingDay,
              leaveMinutes,
              overtimeMinutes,
            })
            const initialMetrics = {
              workMinutes: Number.isFinite(workMinutes) ? workMinutes : computed.workMinutes,
              lateMinutes: Number.isFinite(lateMinutes) ? lateMinutes : computed.lateMinutes,
              earlyLeaveMinutes: Number.isFinite(earlyLeaveMinutes) ? earlyLeaveMinutes : computed.earlyLeaveMinutes,
              status: statusOverride ?? computed.status,
            }

            const fieldValues = buildFieldValueMap(row.fields ?? {}, mapped)
            augmentFieldValuesWithDates(fieldValues, workDate)
            const policyResult = applyAttendancePolicies({
              policies: ruleSetConfig?.policies,
              facts: {
                userId: rowUserId,
                orgId,
                workDate,
                shiftName: context.rule?.name ?? null,
                isHoliday: Boolean(context.holiday),
                isWorkingDay: context.isWorkingDay,
              },
              fieldValues,
              metrics: {
                ...initialMetrics,
                leaveMinutes: leaveMinutes ?? 0,
                overtimeMinutes: overtimeMinutes ?? 0,
              },
            })
            const effective = policyResult.metrics
            let engineResult = null
            if (engine) {
              const approvalSummary = valueFor('approvalSummary')
                ?? valueFor('attendance_approve')
                ?? valueFor('attendanceApprove')
              const rawRoleTags = valueFor('roleTags') ?? valueFor('role_tags')
              const roleTags = Array.isArray(rawRoleTags)
                ? rawRoleTags
                : typeof rawRoleTags === 'string' && rawRoleTags.trim()
                  ? rawRoleTags.split(',').map((tag) => tag.trim()).filter(Boolean)
                  : []

                engineResult = engine.evaluate({
                  record: {
                    userId: rowUserId,
                    shift: valueFor('shiftName') ?? valueFor('plan_detail') ?? valueFor('attendanceClass'),
                    attendance_group: valueFor('attendanceGroup') ?? valueFor('attendance_group'),
                    clockIn1: valueFor('clockIn1') ?? valueFor('firstInAt') ?? valueFor('1_on_duty_user_check_time'),
                    clockOut1: valueFor('clockOut1') ?? valueFor('lastOutAt') ?? valueFor('1_off_duty_user_check_time'),
                    clockIn2: valueFor('clockIn2') ?? valueFor('2_on_duty_user_check_time'),
                    clockOut2: valueFor('clockOut2') ?? valueFor('2_off_duty_user_check_time'),
                    entryTime: valueFor('entryTime') ?? valueFor('entry_time') ?? valueFor('入职时间'),
                    resignTime: valueFor('resignTime') ?? valueFor('resign_time') ?? valueFor('离职时间'),
                    is_holiday: Boolean(context.holiday),
                    is_workday: context.isWorkingDay,
                    overtime_hours: Number.isFinite(effective.overtimeMinutes) ? effective.overtimeMinutes / 60 : undefined,
                    actual_hours: Number.isFinite(effective.workMinutes) ? effective.workMinutes / 60 : undefined,
                  },
                  profile: {
                    roleTags,
                    role: valueFor('role') ?? valueFor('职位'),
                    department: valueFor('department'),
                    attendanceGroup: valueFor('attendanceGroup') ?? valueFor('attendance_group'),
                    entryTime: valueFor('entryTime') ?? valueFor('entry_time') ?? valueFor('入职时间'),
                    resignTime: valueFor('resignTime') ?? valueFor('resign_time') ?? valueFor('离职时间'),
                  },
                  approvals: approvalSummary ?? [],
                  calc: {
                    leaveHours: Number.isFinite(effective.leaveMinutes) ? effective.leaveMinutes / 60 : undefined,
                    exceptionReason: valueFor('exceptionReason') ?? valueFor('exception_reason'),
                  },
                })
            }
            const baseMetrics = {
              ...effective,
              leaveMinutes: Number.isFinite(effective.leaveMinutes) ? effective.leaveMinutes : (leaveMinutes ?? 0),
              overtimeMinutes: Number.isFinite(effective.overtimeMinutes) ? effective.overtimeMinutes : (overtimeMinutes ?? 0),
            }
            const engineAdjustment = engineResult ? applyEngineOverrides(baseMetrics, engineResult) : { metrics: baseMetrics, meta: null }
            const finalMetrics = engineAdjustment.metrics

            preview.push({
              userId: rowUserId,
              workDate,
              firstInAt: firstInAt ? firstInAt.toISOString() : null,
              lastOutAt: lastOutAt ? lastOutAt.toISOString() : null,
              workMinutes: finalMetrics.workMinutes,
              lateMinutes: finalMetrics.lateMinutes,
              earlyLeaveMinutes: finalMetrics.earlyLeaveMinutes,
              leaveMinutes: finalMetrics.leaveMinutes,
              overtimeMinutes: finalMetrics.overtimeMinutes,
              status: finalMetrics.status,
              isWorkday: context.isWorkingDay,
              warnings: policyResult.warnings,
              appliedPolicies: policyResult.appliedRules,
              userGroups: policyResult.userGroups,
              engine: engineResult
                ? {
                    appliedRules: engineResult.appliedRules,
                    warnings: engineResult.warnings,
                    reasons: engineResult.reasons,
                    overrides: engineAdjustment.meta?.overrides ?? null,
                    base: engineAdjustment.meta?.base ?? null,
                  }
                : null,
            })
          }

          res.json({
            ok: true,
            data: {
              items: preview,
              total: preview.length,
              mappingUsed: mapping,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance import preview failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to preview import' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/import',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = importPayloadSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const userId = parsed.data.userId ?? getUserId(req)
        if (!userId) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId is required' } })
          return
        }

        try {
          let ruleSetConfig = null
          if (parsed.data.ruleSetId) {
            const rows = await db.query(
              'SELECT config FROM attendance_rule_sets WHERE id = $1 AND org_id = $2',
              [parsed.data.ruleSetId, orgId]
            )
            if (rows.length) ruleSetConfig = normalizeMetadata(rows[0].config)
          }

          const mapping = parsed.data.mapping?.columns
            ?? parsed.data.mapping?.fields
            ?? ruleSetConfig?.mappings?.columns
            ?? ruleSetConfig?.mappings?.fields
            ?? []

          let engine = null
          const engineConfig = parsed.data.engine ?? ruleSetConfig?.engine
          if (engineConfig) {
            try {
              engine = createRuleEngine({ config: engineConfig, logger })
            } catch (error) {
              logger.warn('Attendance rule engine config invalid (import)', error)
            }
          }

          const rows = Array.isArray(parsed.data.rows)
            ? parsed.data.rows
            : Array.isArray(parsed.data.entries)
              ? buildRowsFromEntries({ entries: parsed.data.entries })
              : buildRowsFromDingTalk({ columns: parsed.data.columns, data: parsed.data.data })

          if (rows.length === 0) {
            res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'No rows to import' } })
            return
          }

          const baseRule = await loadDefaultRule(db, orgId)
          const override = normalizeRuleOverride(ruleSetConfig?.rule)
          const ruleOverride = override
            ? { ...baseRule, ...override, workingDays: override.workingDays ?? baseRule.workingDays }
            : baseRule

          const statusMap = parsed.data.statusMap ?? {}
          const results = []
          await db.transaction(async (trx) => {
            for (const row of rows) {
              const workDate = row.workDate
              const rowUserId = resolveRowUserId({
                row,
                fallbackUserId: userId,
                userMap: parsed.data.userMap,
                userMapKeyField: parsed.data.userMapKeyField,
                userMapSourceFields: parsed.data.userMapSourceFields,
              })
              const context = await resolveWorkContext({
                db: trx,
                orgId,
                userId: rowUserId,
                workDate,
                defaultRule: ruleOverride,
              })
              const mapped = applyFieldMappings(row.fields ?? {}, mapping)
              const valueFor = (key) => (mapped[key]?.value !== undefined ? mapped[key].value : row.fields?.[key])
              const dataTypeFor = (key) => mapped[key]?.dataType

              const firstInAt = parseImportedDateTime(valueFor('firstInAt'), workDate, context.rule.timezone)
              const lastOutAt = parseImportedDateTime(valueFor('lastOutAt'), workDate, context.rule.timezone)
              const statusRaw = valueFor('status')
              const statusOverride = statusRaw != null
                ? resolveStatusOverride(statusRaw, statusMap)
                : null

              const workMinutes = parseMinutesValue(
                valueFor('workMinutes') ?? valueFor('workHours'),
                dataTypeFor('workMinutes') ?? dataTypeFor('workHours')
              )
              const lateMinutes = parseMinutesValue(valueFor('lateMinutes'), dataTypeFor('lateMinutes'))
              const earlyLeaveMinutes = parseMinutesValue(valueFor('earlyLeaveMinutes'), dataTypeFor('earlyLeaveMinutes'))
              const leaveMinutes = parseMinutesValue(valueFor('leaveMinutes') ?? valueFor('leaveHours'), dataTypeFor('leaveMinutes') ?? dataTypeFor('leaveHours'))
              const overtimeMinutes = parseMinutesValue(valueFor('overtimeMinutes') ?? valueFor('overtimeHours'), dataTypeFor('overtimeMinutes') ?? dataTypeFor('overtimeHours'))

              const computed = computeMetrics({
                rule: context.rule,
                firstInAt,
                lastOutAt,
                isWorkingDay: context.isWorkingDay,
                leaveMinutes,
                overtimeMinutes,
              })
              const initialMetrics = {
                workMinutes: Number.isFinite(workMinutes) ? workMinutes : computed.workMinutes,
                lateMinutes: Number.isFinite(lateMinutes) ? lateMinutes : computed.lateMinutes,
                earlyLeaveMinutes: Number.isFinite(earlyLeaveMinutes) ? earlyLeaveMinutes : computed.earlyLeaveMinutes,
                status: statusOverride ?? computed.status,
              }

              const fieldValues = buildFieldValueMap(row.fields ?? {}, mapped)
              augmentFieldValuesWithDates(fieldValues, workDate)
              const policyResult = applyAttendancePolicies({
                policies: ruleSetConfig?.policies,
                facts: {
                  userId: rowUserId,
                  orgId,
                  workDate,
                  shiftName: context.rule?.name ?? null,
                  isHoliday: Boolean(context.holiday),
                  isWorkingDay: context.isWorkingDay,
                },
                fieldValues,
                metrics: {
                  ...initialMetrics,
                  leaveMinutes: leaveMinutes ?? 0,
                  overtimeMinutes: overtimeMinutes ?? 0,
                },
              })
              const effective = policyResult.metrics
              let engineResult = null
              if (engine) {
                const approvalSummary = valueFor('approvalSummary')
                  ?? valueFor('attendance_approve')
                  ?? valueFor('attendanceApprove')
                const rawRoleTags = valueFor('roleTags') ?? valueFor('role_tags')
                const roleTags = Array.isArray(rawRoleTags)
                  ? rawRoleTags
                  : typeof rawRoleTags === 'string' && rawRoleTags.trim()
                    ? rawRoleTags.split(',').map((tag) => tag.trim()).filter(Boolean)
                    : []

                engineResult = engine.evaluate({
                  record: {
                    userId: rowUserId,
                    shift: valueFor('shiftName') ?? valueFor('plan_detail') ?? valueFor('attendanceClass'),
                    attendance_group: valueFor('attendanceGroup') ?? valueFor('attendance_group'),
                    clockIn1: valueFor('clockIn1') ?? valueFor('firstInAt') ?? valueFor('1_on_duty_user_check_time'),
                    clockOut1: valueFor('clockOut1') ?? valueFor('lastOutAt') ?? valueFor('1_off_duty_user_check_time'),
                    clockIn2: valueFor('clockIn2') ?? valueFor('2_on_duty_user_check_time'),
                    clockOut2: valueFor('clockOut2') ?? valueFor('2_off_duty_user_check_time'),
                    entryTime: valueFor('entryTime') ?? valueFor('entry_time') ?? valueFor('入职时间'),
                    resignTime: valueFor('resignTime') ?? valueFor('resign_time') ?? valueFor('离职时间'),
                    is_holiday: Boolean(context.holiday),
                    is_workday: context.isWorkingDay,
                    overtime_hours: Number.isFinite(effective.overtimeMinutes) ? effective.overtimeMinutes / 60 : undefined,
                    actual_hours: Number.isFinite(effective.workMinutes) ? effective.workMinutes / 60 : undefined,
                  },
                  profile: {
                    roleTags,
                    role: valueFor('role') ?? valueFor('职位'),
                    department: valueFor('department'),
                    attendanceGroup: valueFor('attendanceGroup') ?? valueFor('attendance_group'),
                    entryTime: valueFor('entryTime') ?? valueFor('entry_time') ?? valueFor('入职时间'),
                    resignTime: valueFor('resignTime') ?? valueFor('resign_time') ?? valueFor('离职时间'),
                  },
                  approvals: approvalSummary ?? [],
                  calc: {
                    leaveHours: Number.isFinite(effective.leaveMinutes) ? effective.leaveMinutes / 60 : undefined,
                    exceptionReason: valueFor('exceptionReason') ?? valueFor('exception_reason'),
                  },
                })
            }
              const baseMetrics = {
                ...effective,
                leaveMinutes: Number.isFinite(effective.leaveMinutes) ? effective.leaveMinutes : leaveMinutes,
                overtimeMinutes: Number.isFinite(effective.overtimeMinutes) ? effective.overtimeMinutes : overtimeMinutes,
              }
              const engineAdjustment = engineResult ? applyEngineOverrides(baseMetrics, engineResult) : { metrics: baseMetrics, meta: null }
            const finalMetrics = engineAdjustment.metrics
              const effectiveLeaveMinutes = Number.isFinite(finalMetrics.leaveMinutes)
                ? finalMetrics.leaveMinutes
                : leaveMinutes
              const effectiveOvertimeMinutes = Number.isFinite(finalMetrics.overtimeMinutes)
                ? finalMetrics.overtimeMinutes
                : overtimeMinutes

              let meta = null
              if (policyResult.warnings.length || policyResult.appliedRules.length || policyResult.userGroups.length) {
                meta = {
                  policy: {
                    warnings: policyResult.warnings,
                    appliedRules: policyResult.appliedRules,
                    userGroups: policyResult.userGroups,
                  },
                }
              }
              if (engineResult && (engineResult.appliedRules.length || engineResult.warnings.length || engineResult.reasons.length)) {
                meta = meta ?? {}
                meta.engine = {
                  appliedRules: engineResult.appliedRules,
                  warnings: engineResult.warnings,
                  reasons: engineResult.reasons,
                  overrides: engineAdjustment.meta?.overrides ?? null,
                  base: engineAdjustment.meta?.base ?? null,
                }
              }

              const record = await upsertAttendanceRecord({
                userId: rowUserId,
                orgId,
                workDate,
                timezone: context.rule.timezone,
                rule: context.rule,
                updateFirstInAt: firstInAt,
                updateLastOutAt: lastOutAt,
                mode: parsed.data.mode ?? 'override',
                statusOverride,
                overrideMetrics: {
                  workMinutes: finalMetrics.workMinutes,
                  lateMinutes: finalMetrics.lateMinutes,
                  earlyLeaveMinutes: finalMetrics.earlyLeaveMinutes,
                  status: finalMetrics.status,
                },
                isWorkday: context.isWorkingDay,
                leaveMinutes: effectiveLeaveMinutes,
                overtimeMinutes: effectiveOvertimeMinutes,
                meta: meta ?? undefined,
                client: trx,
              })
              results.push({
                id: record.id,
                userId: rowUserId,
                workDate,
                engine: engineResult
                  ? {
                      appliedRules: engineResult.appliedRules,
                      warnings: engineResult.warnings,
                      reasons: engineResult.reasons,
                      overrides: engineAdjustment.meta?.overrides ?? null,
                      base: engineAdjustment.meta?.base ?? null,
                    }
                  : null,
              })
            }
          })

          res.json({
            ok: true,
            data: {
              imported: results.length,
              items: results,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance import failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to import attendance' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/payroll-templates',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const { page, pageSize, offset } = parsePagination(req.query)

        try {
          const countRows = await db.query(
            'SELECT COUNT(*)::int AS total FROM attendance_payroll_templates WHERE org_id = $1',
            [orgId]
          )
          const total = Number(countRows[0]?.total ?? 0)
          const rows = await db.query(
            `SELECT * FROM attendance_payroll_templates
             WHERE org_id = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [orgId, pageSize, offset]
          )

          res.json({
            ok: true,
            data: {
              items: rows.map(mapPayrollTemplateRow),
              total,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance payroll templates query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load payroll templates' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/payroll-templates',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = payrollTemplateCreateSchema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const payload = {
          name: parsed.data.name,
          timezone: parsed.data.timezone ?? 'UTC',
          startDay: parsed.data.startDay ?? 1,
          endDay: parsed.data.endDay ?? 30,
          endMonthOffset: parsed.data.endMonthOffset ?? 0,
          autoGenerate: parsed.data.autoGenerate ?? true,
          config: parsed.data.config ?? {},
          isDefault: parsed.data.isDefault ?? false,
        }

        try {
          const template = await db.transaction(async (trx) => {
            if (payload.isDefault) {
              await trx.query('UPDATE attendance_payroll_templates SET is_default = false WHERE org_id = $1', [orgId])
            }
            const rows = await trx.query(
              `INSERT INTO attendance_payroll_templates
               (id, org_id, name, timezone, start_day, end_day, end_month_offset, auto_generate, config, is_default)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
               RETURNING *`,
              [
                randomUUID(),
                orgId,
                payload.name,
                payload.timezone,
                payload.startDay,
                payload.endDay,
                payload.endMonthOffset,
                payload.autoGenerate,
                JSON.stringify(payload.config),
                payload.isDefault,
              ]
            )
            return rows[0]
          })

          const mapped = mapPayrollTemplateRow(template)
          emitEvent('attendance.payrollTemplate.created', { orgId, templateId: mapped.id })
          res.status(201).json({ ok: true, data: mapped })
        } catch (error) {
          if (error?.code === '23505') {
            res.status(409).json({ ok: false, error: { code: 'ALREADY_EXISTS', message: 'Payroll template already exists' } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance payroll template creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create payroll template' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/payroll-templates/:id',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = payrollTemplateUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const templateId = req.params.id

        try {
          const existingRows = await db.query(
            'SELECT * FROM attendance_payroll_templates WHERE id = $1 AND org_id = $2',
            [templateId, orgId]
          )
          if (!existingRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Payroll template not found' } })
            return
          }
          const existing = existingRows[0]
          const payload = {
            name: parsed.data.name ?? existing.name,
            timezone: parsed.data.timezone ?? existing.timezone ?? 'UTC',
            startDay: parsed.data.startDay ?? existing.start_day ?? 1,
            endDay: parsed.data.endDay ?? existing.end_day ?? 30,
            endMonthOffset: parsed.data.endMonthOffset ?? existing.end_month_offset ?? 0,
            autoGenerate: parsed.data.autoGenerate ?? existing.auto_generate ?? true,
            config: parsed.data.config ?? normalizeMetadata(existing.config),
            isDefault: parsed.data.isDefault ?? existing.is_default ?? false,
          }

          const updated = await db.transaction(async (trx) => {
            if (payload.isDefault) {
              await trx.query('UPDATE attendance_payroll_templates SET is_default = false WHERE org_id = $1', [orgId])
            }
            const rows = await trx.query(
              `UPDATE attendance_payroll_templates
               SET name = $3,
                   timezone = $4,
                   start_day = $5,
                   end_day = $6,
                   end_month_offset = $7,
                   auto_generate = $8,
                   config = $9::jsonb,
                   is_default = $10,
                   updated_at = now()
               WHERE id = $1 AND org_id = $2
               RETURNING *`,
              [
                templateId,
                orgId,
                payload.name,
                payload.timezone,
                payload.startDay,
                payload.endDay,
                payload.endMonthOffset,
                payload.autoGenerate,
                JSON.stringify(payload.config),
                payload.isDefault,
              ]
            )
            return rows[0]
          })

          const mapped = mapPayrollTemplateRow(updated)
          emitEvent('attendance.payrollTemplate.updated', { orgId, templateId: mapped.id })
          res.json({ ok: true, data: mapped })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance payroll template update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update payroll template' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/payroll-templates/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const templateId = req.params.id

        try {
          const rows = await db.query(
            'DELETE FROM attendance_payroll_templates WHERE id = $1 AND org_id = $2 RETURNING id',
            [templateId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Payroll template not found' } })
            return
          }
          emitEvent('attendance.payrollTemplate.deleted', { orgId, templateId })
          res.json({ ok: true, data: { id: templateId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance payroll template delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete payroll template' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/payroll-cycles',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const { page, pageSize, offset } = parsePagination(req.query)
        const status = typeof req.query.status === 'string' ? req.query.status : null
        const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : null
        const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : null

        const conditions = ['org_id = $1']
        const params = [orgId]

        if (status) {
          params.push(status)
          conditions.push(`status = $${params.length}`)
        }
        if (startDate) {
          params.push(startDate)
          conditions.push(`start_date >= $${params.length}`)
        }
        if (endDate) {
          params.push(endDate)
          conditions.push(`end_date <= $${params.length}`)
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

        try {
          const countRows = await db.query(
            `SELECT COUNT(*)::int AS total FROM attendance_payroll_cycles ${whereClause}`,
            params
          )
          const total = Number(countRows[0]?.total ?? 0)
          const rows = await db.query(
            `SELECT * FROM attendance_payroll_cycles
             ${whereClause}
             ORDER BY start_date DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, pageSize, offset]
          )

          res.json({
            ok: true,
            data: {
              items: rows.map(mapPayrollCycleRow),
              total,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance payroll cycles query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load payroll cycles' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/payroll-cycles',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = payrollCycleCreateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        let template = null
        if (parsed.data.templateId) {
          const templateRows = await db.query(
            'SELECT * FROM attendance_payroll_templates WHERE id = $1 AND org_id = $2',
            [parsed.data.templateId, orgId]
          )
          if (!templateRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Payroll template not found' } })
            return
          }
          template = templateRows[0]
        }

        let startDate = parsed.data.startDate
        let endDate = parsed.data.endDate
        if ((!startDate || !endDate) && template) {
          const anchor = parseDateInput(parsed.data.anchorDate) ?? new Date()
          const resolved = resolvePayrollWindow(mapPayrollTemplateRow(template), anchor)
          startDate = startDate ?? resolved.startDate
          endDate = endDate ?? resolved.endDate
        }

        if (!startDate || !endDate) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'startDate and endDate are required' } })
          return
        }

        const startParsed = parseDateInput(startDate)
        const endParsed = parseDateInput(endDate)
        if (!startParsed || !endParsed || startParsed > endParsed) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid date range' } })
          return
        }

        const payload = {
          templateId: parsed.data.templateId ?? null,
          name: parsed.data.name ?? null,
          startDate,
          endDate,
          status: parsed.data.status ?? 'open',
          metadata: parsed.data.metadata ?? {},
        }

        try {
          const rows = await db.query(
            `INSERT INTO attendance_payroll_cycles
             (id, org_id, template_id, name, start_date, end_date, status, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
             RETURNING *`,
            [
              randomUUID(),
              orgId,
              payload.templateId,
              payload.name,
              payload.startDate,
              payload.endDate,
              payload.status,
              JSON.stringify(payload.metadata),
            ]
          )

          const mapped = mapPayrollCycleRow(rows[0])
          emitEvent('attendance.payrollCycle.created', { orgId, payrollCycleId: mapped.id })
          res.status(201).json({ ok: true, data: mapped })
        } catch (error) {
          if (error?.code === '23505') {
            res.status(409).json({ ok: false, error: { code: 'ALREADY_EXISTS', message: 'Payroll cycle already exists' } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance payroll cycle creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create payroll cycle' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/payroll-cycles/:id',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = payrollCycleUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const payrollCycleId = req.params.id

        try {
          const existingRows = await db.query(
            'SELECT * FROM attendance_payroll_cycles WHERE id = $1 AND org_id = $2',
            [payrollCycleId, orgId]
          )
          if (!existingRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Payroll cycle not found' } })
            return
          }
          const existing = existingRows[0]

          let template = null
          if (parsed.data.templateId) {
            const templateRows = await db.query(
              'SELECT * FROM attendance_payroll_templates WHERE id = $1 AND org_id = $2',
              [parsed.data.templateId, orgId]
            )
            if (!templateRows.length) {
              res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Payroll template not found' } })
              return
            }
            template = templateRows[0]
          }

          let startDate = parsed.data.startDate ?? existing.start_date
          let endDate = parsed.data.endDate ?? existing.end_date
          if (parsed.data.anchorDate && template) {
            const anchor = parseDateInput(parsed.data.anchorDate) ?? new Date()
            const resolved = resolvePayrollWindow(mapPayrollTemplateRow(template), anchor)
            startDate = resolved.startDate
            endDate = resolved.endDate
          }

          const startParsed = parseDateInput(startDate)
          const endParsed = parseDateInput(endDate)
          if (!startParsed || !endParsed || startParsed > endParsed) {
            res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid date range' } })
            return
          }

          const payload = {
            templateId: parsed.data.templateId ?? existing.template_id ?? null,
            name: parsed.data.name ?? existing.name,
            startDate,
            endDate,
            status: parsed.data.status ?? existing.status ?? 'open',
            metadata: parsed.data.metadata ?? normalizeMetadata(existing.metadata),
          }

          const rows = await db.query(
            `UPDATE attendance_payroll_cycles
             SET template_id = $3,
                 name = $4,
                 start_date = $5,
                 end_date = $6,
                 status = $7,
                 metadata = $8::jsonb,
                 updated_at = now()
             WHERE id = $1 AND org_id = $2
             RETURNING *`,
            [
              payrollCycleId,
              orgId,
              payload.templateId,
              payload.name,
              payload.startDate,
              payload.endDate,
              payload.status,
              JSON.stringify(payload.metadata),
            ]
          )

          const mapped = mapPayrollCycleRow(rows[0])
          emitEvent('attendance.payrollCycle.updated', { orgId, payrollCycleId: mapped.id })
          res.json({ ok: true, data: mapped })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance payroll cycle update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update payroll cycle' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/payroll-cycles/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const payrollCycleId = req.params.id

        try {
          const rows = await db.query(
            'DELETE FROM attendance_payroll_cycles WHERE id = $1 AND org_id = $2 RETURNING id',
            [payrollCycleId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Payroll cycle not found' } })
            return
          }
          emitEvent('attendance.payrollCycle.deleted', { orgId, payrollCycleId })
          res.json({ ok: true, data: { id: payrollCycleId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance payroll cycle delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete payroll cycle' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/payroll-cycles/:id/summary',
      withPermission('attendance:read', async (req, res) => {
        const schema = z.object({
          userId: z.string().optional(),
          orgId: z.string().optional(),
        })

        const parsed = schema.safeParse({
          userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const requesterId = getUserId(req)
        if (!requesterId) {
          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
          return
        }

        const targetUserId = parsed.data.userId ?? requesterId
        if (targetUserId !== requesterId) {
          const allowed = await canAccessOtherUsers(requesterId)
          if (!allowed) {
            res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'No access to other users' } })
            return
          }
        }

        const orgId = getOrgId(req)
        const cycleId = req.params.id

        try {
          const cycleRows = await db.query(
            'SELECT * FROM attendance_payroll_cycles WHERE id = $1 AND org_id = $2',
            [cycleId, orgId]
          )
          if (!cycleRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Payroll cycle not found' } })
            return
          }
          const cycle = mapPayrollCycleRow(cycleRows[0])
          const summary = await loadAttendanceSummary(db, orgId, targetUserId, cycle.startDate, cycle.endDate)

          res.json({
            ok: true,
            data: {
              cycle,
              summary,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance payroll cycle summary failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load payroll summary' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/payroll-cycles/:id/summary/export',
      withPermission('attendance:read', async (req, res) => {
        const schema = z.object({
          userId: z.string().optional(),
          orgId: z.string().optional(),
        })

        const parsed = schema.safeParse({
          userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const requesterId = getUserId(req)
        if (!requesterId) {
          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
          return
        }

        const targetUserId = parsed.data.userId ?? requesterId
        if (targetUserId !== requesterId) {
          const allowed = await canAccessOtherUsers(requesterId)
          if (!allowed) {
            res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'No access to other users' } })
            return
          }
        }

        const orgId = getOrgId(req)
        const cycleId = req.params.id

        try {
          const cycleRows = await db.query(
            'SELECT * FROM attendance_payroll_cycles WHERE id = $1 AND org_id = $2',
            [cycleId, orgId]
          )
          if (!cycleRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Payroll cycle not found' } })
            return
          }
          const cycle = mapPayrollCycleRow(cycleRows[0])
          const summary = await loadAttendanceSummary(db, orgId, targetUserId, cycle.startDate, cycle.endDate)
          const csv = buildPayrollSummaryCsv(summary, cycle)
          const filename = `payroll-cycle-${cycle.id}.csv`

          res.setHeader('Content-Type', 'text/csv; charset=utf-8')
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
          res.status(200).send(csv)
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance payroll cycle summary export failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to export payroll summary' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/shifts',
      withPermission('attendance:admin', async (req, res) => {
        const schema = z.object({
          orgId: z.string().optional(),
        })

        const parsed = schema.safeParse({
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const { page, pageSize, offset } = parsePagination(req.query)

        try {
          const countRows = await db.query(
            'SELECT COUNT(*)::int AS total FROM attendance_shifts WHERE org_id = $1',
            [orgId]
          )
          const total = Number(countRows[0]?.total ?? 0)

          const rows = await db.query(
            `SELECT * FROM attendance_shifts
             WHERE org_id = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [orgId, pageSize, offset]
          )

          res.json({
            ok: true,
            data: {
              items: rows.map(mapShiftRow),
              total,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance shifts query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load shifts' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/shifts',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = shiftCreateSchema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const payload = {
          name: parsed.data.name ?? DEFAULT_SHIFT.name,
          timezone: parsed.data.timezone ?? DEFAULT_SHIFT.timezone,
          workStartTime: parsed.data.workStartTime ?? DEFAULT_SHIFT.workStartTime,
          workEndTime: parsed.data.workEndTime ?? DEFAULT_SHIFT.workEndTime,
          lateGraceMinutes: parsed.data.lateGraceMinutes ?? DEFAULT_SHIFT.lateGraceMinutes,
          earlyGraceMinutes: parsed.data.earlyGraceMinutes ?? DEFAULT_SHIFT.earlyGraceMinutes,
          roundingMinutes: parsed.data.roundingMinutes ?? DEFAULT_SHIFT.roundingMinutes,
          workingDays: normalizeWorkingDays(parsed.data.workingDays ?? DEFAULT_SHIFT.workingDays),
        }

        try {
          const rows = await db.query(
            `INSERT INTO attendance_shifts
             (id, org_id, name, timezone, work_start_time, work_end_time, late_grace_minutes, early_grace_minutes, rounding_minutes, working_days)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
             RETURNING *`,
            [
              randomUUID(),
              orgId,
              payload.name,
              payload.timezone,
              payload.workStartTime,
              payload.workEndTime,
              payload.lateGraceMinutes,
              payload.earlyGraceMinutes,
              payload.roundingMinutes,
              JSON.stringify(payload.workingDays),
            ]
          )
          const shift = mapShiftRow(rows[0])
          emitEvent('attendance.shift.created', { orgId, shiftId: shift.id })
          res.status(201).json({ ok: true, data: shift })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance shift creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create shift' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/shifts/:id',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = shiftUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const shiftId = req.params.id

        try {
          const existingRows = await db.query(
            'SELECT * FROM attendance_shifts WHERE id = $1 AND org_id = $2',
            [shiftId, orgId]
          )
          if (!existingRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Shift not found' } })
            return
          }

          const existing = existingRows[0]
          const workingDays = parsed.data.workingDays
            ? normalizeWorkingDays(parsed.data.workingDays)
            : normalizeWorkingDays(existing.working_days)

          const payload = {
            name: parsed.data.name ?? existing.name,
            timezone: parsed.data.timezone ?? existing.timezone,
            workStartTime: parsed.data.workStartTime ?? existing.work_start_time,
            workEndTime: parsed.data.workEndTime ?? existing.work_end_time,
            lateGraceMinutes: parsed.data.lateGraceMinutes ?? existing.late_grace_minutes,
            earlyGraceMinutes: parsed.data.earlyGraceMinutes ?? existing.early_grace_minutes,
            roundingMinutes: parsed.data.roundingMinutes ?? existing.rounding_minutes,
            workingDays,
          }

          const rows = await db.query(
            `UPDATE attendance_shifts
             SET name = $3,
                 timezone = $4,
                 work_start_time = $5,
                 work_end_time = $6,
                 late_grace_minutes = $7,
                 early_grace_minutes = $8,
                 rounding_minutes = $9,
                 working_days = $10::jsonb,
                 updated_at = now()
             WHERE id = $1 AND org_id = $2
             RETURNING *`,
            [
              shiftId,
              orgId,
              payload.name,
              payload.timezone,
              payload.workStartTime,
              payload.workEndTime,
              payload.lateGraceMinutes,
              payload.earlyGraceMinutes,
              payload.roundingMinutes,
              JSON.stringify(payload.workingDays),
            ]
          )

          const shift = mapShiftRow(rows[0])
          emitEvent('attendance.shift.updated', { orgId, shiftId: shift.id })
          res.json({ ok: true, data: shift })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance shift update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update shift' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/shifts/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const shiftId = req.params.id

        try {
          const rows = await db.query(
            'DELETE FROM attendance_shifts WHERE id = $1 AND org_id = $2 RETURNING id',
            [shiftId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Shift not found' } })
            return
          }
          emitEvent('attendance.shift.deleted', { orgId, shiftId })
          res.json({ ok: true, data: { id: shiftId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance shift delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete shift' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/assignments',
      withPermission('attendance:admin', async (req, res) => {
        const schema = z.object({
          orgId: z.string().optional(),
          userId: z.string().optional(),
        })

        const parsed = schema.safeParse({
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
          userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const { page, pageSize, offset } = parsePagination(req.query)

        try {
          const params = [orgId]
          let userFilter = ''
          if (parsed.data.userId) {
            params.push(parsed.data.userId)
            userFilter = `AND a.user_id = $${params.length}`
          }

          const countRows = await db.query(
            `SELECT COUNT(*)::int AS total
             FROM attendance_shift_assignments a
             WHERE a.org_id = $1 ${userFilter}`,
            params
          )
          const total = Number(countRows[0]?.total ?? 0)

          params.push(pageSize, offset)
          const rows = await db.query(
            `SELECT a.id, a.org_id, a.user_id, a.shift_id, a.start_date, a.end_date, a.is_active,
                    s.name AS shift_name, s.timezone AS shift_timezone, s.work_start_time AS shift_work_start_time,
                    s.work_end_time AS shift_work_end_time, s.late_grace_minutes AS shift_late_grace_minutes,
                    s.early_grace_minutes AS shift_early_grace_minutes, s.rounding_minutes AS shift_rounding_minutes,
                    s.working_days AS shift_working_days
             FROM attendance_shift_assignments a
             JOIN attendance_shifts s ON s.id = a.shift_id
             WHERE a.org_id = $1 ${userFilter}
             ORDER BY a.start_date DESC, a.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
          )

          res.json({
            ok: true,
            data: {
              items: rows.map(row => ({
                assignment: mapAssignmentRow(row),
                shift: mapShiftFromAssignmentRow(row),
              })),
              total,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance assignments query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load assignments' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/assignments',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = assignmentCreateSchema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const normalizedEndDate = typeof parsed.data.endDate === 'string' && parsed.data.endDate.trim().length > 0
          ? parsed.data.endDate
          : null

        const payload = {
          userId: parsed.data.userId,
          shiftId: parsed.data.shiftId,
          startDate: parsed.data.startDate,
          endDate: normalizedEndDate,
          isActive: parsed.data.isActive ?? true,
        }

        if (payload.endDate && payload.endDate < payload.startDate) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'End date must be after start date' } })
          return
        }

        try {
          const shiftRows = await db.query(
            'SELECT * FROM attendance_shifts WHERE id = $1 AND org_id = $2',
            [payload.shiftId, orgId]
          )
          if (!shiftRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Shift not found' } })
            return
          }

          const rows = await db.query(
            `INSERT INTO attendance_shift_assignments
             (id, org_id, user_id, shift_id, start_date, end_date, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
              randomUUID(),
              orgId,
              payload.userId,
              payload.shiftId,
              payload.startDate,
              payload.endDate,
              payload.isActive,
            ]
          )

          const assignment = mapAssignmentRow(rows[0])
          const shift = mapShiftRow(shiftRows[0])
          emitEvent('attendance.assignment.created', { orgId, assignmentId: assignment.id })
          res.status(201).json({ ok: true, data: { assignment, shift } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance assignment creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create assignment' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/assignments/:id',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = assignmentUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const assignmentId = req.params.id

        try {
          const existingRows = await db.query(
            'SELECT * FROM attendance_shift_assignments WHERE id = $1 AND org_id = $2',
            [assignmentId, orgId]
          )
          if (!existingRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Assignment not found' } })
            return
          }

          const existing = existingRows[0]
          const normalizedEndDate = typeof parsed.data.endDate === 'string'
            ? (parsed.data.endDate.trim().length > 0 ? parsed.data.endDate : null)
            : parsed.data.endDate

          const payload = {
            userId: parsed.data.userId ?? existing.user_id,
            shiftId: parsed.data.shiftId ?? existing.shift_id,
            startDate: parsed.data.startDate ?? existing.start_date,
            endDate: normalizedEndDate ?? existing.end_date,
            isActive: parsed.data.isActive ?? existing.is_active,
          }

          if (payload.endDate && payload.endDate < payload.startDate) {
            res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'End date must be after start date' } })
            return
          }

          const shiftRows = await db.query(
            'SELECT * FROM attendance_shifts WHERE id = $1 AND org_id = $2',
            [payload.shiftId, orgId]
          )
          if (!shiftRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Shift not found' } })
            return
          }

          const rows = await db.query(
            `UPDATE attendance_shift_assignments
             SET user_id = $3,
                 shift_id = $4,
                 start_date = $5,
                 end_date = $6,
                 is_active = $7,
                 updated_at = now()
             WHERE id = $1 AND org_id = $2
             RETURNING *`,
            [
              assignmentId,
              orgId,
              payload.userId,
              payload.shiftId,
              payload.startDate,
              payload.endDate,
              payload.isActive,
            ]
          )

          const assignment = mapAssignmentRow(rows[0])
          const shift = mapShiftRow(shiftRows[0])
          emitEvent('attendance.assignment.updated', { orgId, assignmentId: assignment.id })
          res.json({ ok: true, data: { assignment, shift } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance assignment update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update assignment' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/assignments/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const assignmentId = req.params.id

        try {
          const rows = await db.query(
            'DELETE FROM attendance_shift_assignments WHERE id = $1 AND org_id = $2 RETURNING id',
            [assignmentId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Assignment not found' } })
            return
          }
          emitEvent('attendance.assignment.deleted', { orgId, assignmentId })
          res.json({ ok: true, data: { id: assignmentId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance assignment delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete assignment' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/holidays',
      withPermission('attendance:read', async (req, res) => {
        const schema = z.object({
          orgId: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
        })

        const parsed = schema.safeParse({
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
          from: typeof req.query.from === 'string' ? req.query.from : undefined,
          to: typeof req.query.to === 'string' ? req.query.to : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const from = parsed.data.from ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 10)
        const to = parsed.data.to ?? new Date().toISOString().slice(0, 10)

        try {
          const countRows = await db.query(
            `SELECT COUNT(*)::int AS total
             FROM attendance_holidays
             WHERE org_id = $1 AND holiday_date BETWEEN $2 AND $3`,
            [orgId, from, to]
          )
          const total = Number(countRows[0]?.total ?? 0)

          const rows = await db.query(
            `SELECT id, org_id, holiday_date, name, is_working_day
             FROM attendance_holidays
             WHERE org_id = $1 AND holiday_date BETWEEN $2 AND $3
             ORDER BY holiday_date ASC`,
            [orgId, from, to]
          )

          res.json({ ok: true, data: { items: rows.map(mapHolidayRow), total } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance holidays query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load holidays' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/holidays',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = holidayCreateSchema.safeParse(req.body)
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const normalizedName = typeof parsed.data.name === 'string' && parsed.data.name.trim().length === 0
          ? null
          : parsed.data.name ?? null

        const payload = {
          date: parsed.data.date,
          name: normalizedName,
          isWorkingDay: parsed.data.isWorkingDay ?? false,
        }

        try {
          const rows = await db.query(
            `INSERT INTO attendance_holidays
             (id, org_id, holiday_date, name, is_working_day)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, org_id, holiday_date, name, is_working_day`,
            [
              randomUUID(),
              orgId,
              payload.date,
              payload.name,
              payload.isWorkingDay,
            ]
          )
          const holiday = mapHolidayRow(rows[0])
          emitEvent('attendance.holiday.created', { orgId, holidayId: holiday.id })
          res.status(201).json({ ok: true, data: holiday })
        } catch (error) {
          if (error?.code === '23505') {
            res.status(409).json({ ok: false, error: { code: 'ALREADY_EXISTS', message: 'Holiday already exists' } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance holiday creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create holiday' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/holidays/:id',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = holidayUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const holidayId = req.params.id

        try {
          const existingRows = await db.query(
            'SELECT id, org_id, holiday_date, name, is_working_day FROM attendance_holidays WHERE id = $1 AND org_id = $2',
            [holidayId, orgId]
          )
          if (!existingRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Holiday not found' } })
            return
          }

          const existing = existingRows[0]
          const normalizedName = typeof parsed.data.name === 'string' && parsed.data.name.trim().length === 0
            ? null
            : parsed.data.name

          const payload = {
            date: parsed.data.date ?? existing.holiday_date,
            name: normalizedName ?? existing.name,
            isWorkingDay: parsed.data.isWorkingDay ?? existing.is_working_day,
          }

          const rows = await db.query(
            `UPDATE attendance_holidays
             SET holiday_date = $3,
                 name = $4,
                 is_working_day = $5,
                 updated_at = now()
             WHERE id = $1 AND org_id = $2
             RETURNING id, org_id, holiday_date, name, is_working_day`,
            [holidayId, orgId, payload.date, payload.name, payload.isWorkingDay]
          )

          const holiday = mapHolidayRow(rows[0])
          emitEvent('attendance.holiday.updated', { orgId, holidayId: holiday.id })
          res.json({ ok: true, data: holiday })
        } catch (error) {
          if (error?.code === '23505') {
            res.status(409).json({ ok: false, error: { code: 'ALREADY_EXISTS', message: 'Holiday already exists' } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance holiday update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update holiday' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/holidays/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const holidayId = req.params.id

        try {
          const rows = await db.query(
            'DELETE FROM attendance_holidays WHERE id = $1 AND org_id = $2 RETURNING id',
            [holidayId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Holiday not found' } })
            return
          }
          emitEvent('attendance.holiday.deleted', { orgId, holidayId })
          res.json({ ok: true, data: { id: holidayId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance holiday delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete holiday' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/settings',
      withPermission('attendance:admin', async (_req, res) => {
        try {
          const settings = await getSettings(db)
          res.json({ ok: true, data: settings })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance settings lookup failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load settings' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/settings',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = settingsSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        try {
          const current = await getSettings(db)
          const merged = mergeSettings(current, parsed.data)
          const saved = await saveSettings(db, merged)
          scheduleAutoAbsence({ db, logger, emit: emitEvent })
          emitEvent('attendance.settings.updated', {
            settings: saved,
          })
          res.json({ ok: true, data: saved })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance settings update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update settings' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/export',
      withPermission('attendance:read', async (req, res) => {
        const schema = z.object({
          userId: z.string().optional(),
          orgId: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.string().optional(),
        })

        const parsed = schema.safeParse({
          userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
          orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined,
          from: typeof req.query.from === 'string' ? req.query.from : undefined,
          to: typeof req.query.to === 'string' ? req.query.to : undefined,
          limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
        })

        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const requesterId = getUserId(req)
        if (!requesterId) {
          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
          return
        }

        const orgId = getOrgId(req)
        const targetUserId = parsed.data.userId ?? requesterId
        if (targetUserId !== requesterId) {
          const allowed = await canAccessOtherUsers(requesterId)
          if (!allowed) {
            res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'No access to other users' } })
            return
          }
        }

        const from = parsed.data.from ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 10)
        const to = parsed.data.to ?? new Date().toISOString().slice(0, 10)
        const requestedLimit = parseNumber(parsed.data.limit, 1000)
        const limit = Math.min(Math.max(requestedLimit, 1), 5000)

        try {
          const rows = await db.query(
            `SELECT user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes,
                    early_leave_minutes, status, is_workday
             FROM attendance_records
             WHERE user_id = $1 AND org_id = $2 AND work_date BETWEEN $3 AND $4
             ORDER BY work_date DESC
             LIMIT $5`,
            [targetUserId, orgId, from, to, limit]
          )

          const headers = [
            'user_id',
            'org_id',
            'work_date',
            'timezone',
            'first_in_at',
            'last_out_at',
            'work_minutes',
            'late_minutes',
            'early_leave_minutes',
            'status',
            'is_workday',
          ]
          const csv = buildCsv(rows, headers)
          const filename = `attendance-${orgId}-${from}-to-${to}.csv`

          emitEvent('attendance.exported', {
            orgId,
            userId: targetUserId,
            from,
            to,
            total: rows.length,
          })
          res.setHeader('Content-Type', 'text/csv')
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
          res.status(200).send(csv)
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance export failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to export attendance' } })
        }
      })
    )

    try {
      await getSettings(db)
      scheduleAutoAbsence({ db, logger, emit: emitEvent })
    } catch (error) {
      logger.warn('Attendance settings preload failed', error)
    }

    logger.info('Attendance plugin activated')
  },

  async deactivate() {
    clearAutoAbsenceSchedule()
  }
}
