const { randomUUID } = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { z } = require('zod')
const { createRuleEngine } = require('./engine/index.cjs')
const { validateConfig: validateEngineConfig } = require('./engine/schema.cjs')
const { DEFAULT_TEMPLATES } = require('./engine/template-library.cjs')

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
const TEMPLATE_LIBRARY_KEY = 'attendance.template_library'
const TEMPLATE_LIBRARY_CACHE_TTL_MS = 60000
const DEFAULT_SETTINGS = {
  autoAbsence: {
    enabled: false,
    runAt: '00:15',
    lookbackDays: 1,
  },
  holidayPolicy: {
    firstDayEnabled: true,
    firstDayBaseHours: 8,
    overtimeAdds: true,
    overtimeSource: 'approval',
    overrides: [],
  },
  holidaySync: {
    source: 'holiday-cn',
    baseUrl: 'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master',
    years: [],
    addDayIndex: true,
    dayIndexHolidays: ['春节', '国庆'],
    dayIndexMaxDays: 7,
    dayIndexFormat: 'name-1',
    overwrite: false,
    auto: {
      enabled: false,
      runAt: '02:00',
      timezone: 'UTC',
    },
    lastRun: null,
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
let autoHolidaySyncTimeout = null
let autoHolidaySyncInterval = null
let importUploadCleanupInterval = null
let settingsCache = { value: DEFAULT_SETTINGS, loadedAt: 0 }
const templateLibraryCache = new Map()
const templateLibraryVersionCache = new Map()

// Avoid per-row Intl formatter allocations during large imports.
// Cache failures as `null` so invalid timezones don't repeatedly throw.
const workDateFormatterCache = new Map()
const zonedMinutesFormatterCache = new Map()
const zonedPartsFormatterCache = new Map()
const timeToMinutesCache = new Map()

function getCachedIntlDateTimeFormat(cache, timeZone, locale, options) {
  const tz = typeof timeZone === 'string' ? timeZone.trim() : ''
  if (!tz) return null
  if (cache.has(tz)) return cache.get(tz)
  try {
    const fmt = new Intl.DateTimeFormat(locale, { ...options, timeZone: tz })
    cache.set(tz, fmt)
    return fmt
  } catch {
    cache.set(tz, null)
    return null
  }
}

const SYSTEM_TEMPLATE_NAMES = new Set(DEFAULT_TEMPLATES.map((tpl) => tpl.name))

const IMPORT_MAPPING_COLUMNS = [
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
  { sourceField: 'attendance_group', targetField: 'attendance_group', dataType: 'string' },
  { sourceField: '考勤组', targetField: 'attendanceGroup', dataType: 'string' },
  { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
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
]

const DEFAULT_REQUIRED_FIELDS = ['日期']
const DEFAULT_PUNCH_REQUIRED_FIELDS = ['上班1打卡时间', '下班1打卡时间']

const IMPORT_MAPPING_PROFILES = [
  {
    id: 'dingtalk_csv_daily_summary',
    name: 'DingTalk CSV Daily Summary',
    description: 'CSV导出（日汇总）模板：日期/工号/姓名/考勤组/打卡时间。',
    source: 'dingtalk_csv',
    mapping: { columns: IMPORT_MAPPING_COLUMNS },
    userMapKeyField: '工号',
    userMapSourceFields: ['empNo', '工号', '姓名'],
    requiredFields: DEFAULT_REQUIRED_FIELDS,
    punchRequiredFields: DEFAULT_PUNCH_REQUIRED_FIELDS,
  },
  {
    id: 'dingtalk_api_columns',
    name: 'DingTalk API Column Values',
    description: '钉钉接口 column_vals 结构（字段ID + 日期值）。',
    source: 'dingtalk',
    mapping: { columns: IMPORT_MAPPING_COLUMNS },
    requiredFields: ['workDate'],
  },
  {
    id: 'manual_rows',
    name: 'Manual Rows Payload',
    description: '自定义 rows/entries JSON 输入。',
    source: 'manual',
    mapping: { columns: IMPORT_MAPPING_COLUMNS },
    requiredFields: ['workDate'],
  },
]

function findImportProfile(profileId) {
  if (!profileId) return null
  return IMPORT_MAPPING_PROFILES.find((profile) => profile.id === profileId) ?? null
}

const IMPORT_COMMIT_TOKEN_TTL_MS = 10 * 60 * 1000
const requireImportCommitToken = process.env.ATTENDANCE_IMPORT_REQUIRE_TOKEN === '1'
const importCommitTokens = new Map()

async function pruneImportCommitTokensDb(db) {
  if (!db) return
  try {
    await db.query('DELETE FROM attendance_import_tokens WHERE expires_at <= now()')
  } catch (error) {
    if (isDatabaseSchemaError(error)) return
  }
}

function pruneImportCommitTokens() {
  const now = Date.now()
  for (const [token, entry] of importCommitTokens.entries()) {
    if (!entry || entry.expiresAt <= now) {
      importCommitTokens.delete(token)
    }
  }
}

async function createImportCommitToken({ db, orgId, userId }) {
  pruneImportCommitTokens()
  const token = randomUUID()
  const expiresAt = Date.now() + IMPORT_COMMIT_TOKEN_TTL_MS

  // Production mode: tokens must be shareable across multiple backend instances.
  // When enforcement is enabled, require DB persistence and fail fast if the table is missing.
  if (requireImportCommitToken) {
    if (!db) {
      throw new HttpError(
        503,
        'DB_NOT_READY',
        'Database connection is required to issue import commit tokens.',
      )
    }
    await pruneImportCommitTokensDb(db)
    try {
      await db.query(
        `INSERT INTO attendance_import_tokens
         (token, org_id, user_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4, now())`,
        [token, orgId, userId, new Date(expiresAt)]
      )
    } catch (error) {
      if (isDatabaseSchemaError(error)) {
        throw new HttpError(
          503,
          'DB_NOT_READY',
          'Attendance import token table missing. Run migrations before enabling token enforcement.',
        )
      }
      throw error
    }

    importCommitTokens.set(token, { orgId, userId, expiresAt })
    return { token, expiresAt }
  }

  importCommitTokens.set(token, { orgId, userId, expiresAt })
  if (db) {
    await pruneImportCommitTokensDb(db)
    try {
      await db.query(
        `INSERT INTO attendance_import_tokens
         (token, org_id, user_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4, now())`,
        [token, orgId, userId, new Date(expiresAt)]
      )
    } catch (error) {
      if (!isDatabaseSchemaError(error)) {
        throw error
      }
    }
  }
  return { token, expiresAt }
}

async function consumeImportCommitToken(token, { db, orgId, userId }) {
  pruneImportCommitTokens()
  const entry = importCommitTokens.get(token)
  if (entry) {
    if (entry.orgId !== orgId) return false
    if (entry.userId !== userId) return false
    if (entry.expiresAt <= Date.now()) {
      importCommitTokens.delete(token)
      return false
    }
    importCommitTokens.delete(token)
    if (db) {
      try {
        await db.query('DELETE FROM attendance_import_tokens WHERE token = $1', [token])
      } catch (error) {
        if (isDatabaseSchemaError(error) && requireImportCommitToken) {
          throw new HttpError(
            503,
            'DB_NOT_READY',
            'Attendance import token table missing. Run migrations before enabling token enforcement.',
          )
        }
        if (!isDatabaseSchemaError(error)) {
          throw error
        }
      }
    }
    return true
  }

  if (!db) {
    if (requireImportCommitToken) {
      throw new HttpError(
        503,
        'DB_NOT_READY',
        'Database connection is required to validate import commit tokens.',
      )
    }
    return false
  }
  await pruneImportCommitTokensDb(db)
  try {
    const rows = await db.query(
      'SELECT token, org_id, user_id, expires_at FROM attendance_import_tokens WHERE token = $1',
      [token]
    )
    if (!rows.length) return false
    const row = rows[0]
    if (row.org_id !== orgId || row.user_id !== userId) return false
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await db.query('DELETE FROM attendance_import_tokens WHERE token = $1', [token])
      return false
    }
    await db.query('DELETE FROM attendance_import_tokens WHERE token = $1', [token])
    return true
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      if (requireImportCommitToken) {
        throw new HttpError(
          503,
          'DB_NOT_READY',
          'Attendance import token table missing. Run migrations before enabling token enforcement.',
        )
      }
      return false
    }
    throw error
  }
}

function ensureStringArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean)
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return []
}

function ensureNumberArray(value) {
  if (!value) return []
  if (Array.isArray(value)) {
    return value
      .map((item) => parseNumber(item, null))
      .filter((item) => Number.isFinite(item))
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((item) => parseNumber(item, null))
      .filter((item) => Number.isFinite(item))
  }
  return []
}

function normalizeIntegrationConfig(config) {
  if (!config || typeof config !== 'object') return {}
  return {
    ...config,
    appKey: config.appKey ?? config.appkey ?? config.app_key,
    appSecret: config.appSecret ?? config.appsecret ?? config.app_secret,
    baseUrl: config.baseUrl ?? config.base_url ?? 'https://oapi.dingtalk.com',
    userIds: ensureStringArray(config.userIds ?? config.user_ids ?? config.users),
    columnIds: ensureStringArray(config.columnIds ?? config.column_id_list ?? config.columns).map((id) => String(id)),
    columns: Array.isArray(config.columns) ? config.columns : [],
    mappingProfileId: config.mappingProfileId ?? config.mapping_profile_id ?? null,
    userMapKeyField: config.userMapKeyField ?? config.user_map_key_field ?? null,
    userMapSourceFields: Array.isArray(config.userMapSourceFields) ? config.userMapSourceFields : undefined,
    userMap: config.userMap ?? config.user_map ?? undefined,
    timezone: config.timezone ?? 'Asia/Shanghai',
    source: config.source ?? 'dingtalk_api',
  }
}

async function fetchDingTalkAccessToken({ appKey, appSecret, baseUrl }) {
  if (!appKey || !appSecret) {
    throw new Error('DingTalk appKey/appSecret required')
  }
  const tokenUrl = `${baseUrl}/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`
  const res = await fetch(tokenUrl)
  const data = await res.json()
  if (!res.ok || data?.errcode) {
    throw new Error(data?.errmsg || 'Failed to obtain DingTalk token')
  }
  return data?.access_token
}

function normalizeDingTalkDateRange(value, fallback) {
  if (!value) return fallback
  const text = String(value).trim()
  if (!text) return fallback
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 00:00:00`
  return text
}

async function fetchDingTalkColumnValues({ baseUrl, accessToken, userId, columnIds, fromDate, toDate }) {
  const url = `${baseUrl}/topapi/attendance/getcolumnval?access_token=${encodeURIComponent(accessToken)}`
  const body = {
    userid: userId,
    column_id_list: Array.isArray(columnIds) ? columnIds.join(',') : String(columnIds ?? ''),
    from_date: fromDate,
    to_date: toDate,
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok || data?.errcode) {
    throw new Error(data?.errmsg || 'Failed to fetch DingTalk attendance')
  }
  return data?.result ?? {}
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function formatEngineConfigError(error) {
  const details = Array.isArray(error?.details) ? error.details : null
  const first = details && details.length > 0 ? details[0] : null
  const message = first
    ? `Invalid engine config: ${first.path || 'config'} ${first.message}`
    : (error?.message || 'Invalid engine config')
  return { message, details }
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
  const tz = typeof timeZone === 'string' ? timeZone.trim() : ''
  if (!tz) return utcDate
  try {
    // Convert a local (zoned) wall-clock time into a UTC timestamp.
    const utcMs = zonedTimeToUtc({ year, month, day, hour, minute, second }, tz)
    return new Date(utcMs)
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

function normalizeTimeString(value) {
  if (!value || typeof value !== 'string') return null
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  const hh = String(hours).padStart(2, '0')
  const mm = String(minutes).padStart(2, '0')
  return `${hh}:${mm}`
}

function resolveShiftTimeRange(shiftName) {
  if (!shiftName) return null
  const text = String(shiftName)
  const match = text.match(/(\d{1,2}:\d{2})\s*[-~—]\s*(\d{1,2}:\d{2})/)
  if (!match) return null
  const workStartTime = normalizeTimeString(match[1])
  const workEndTime = normalizeTimeString(match[2])
  if (!workStartTime || !workEndTime) return null
  return { workStartTime, workEndTime }
}

function resolveRuleOverrideFromShiftName(rule, shiftName) {
  const range = resolveShiftTimeRange(shiftName)
  if (!range) return rule
  return { ...rule, ...range }
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

function buildRowsFromDingTalk({ columns, data, userId }) {
  const map = buildDingTalkFieldMap(columns)
  const rowsByDate = new Map()
  const resolvedUserId = data?.userId ?? data?.userid ?? userId ?? null
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
        rowsByDate.set(dateKey, {
          workDate: dateKey,
          fields: {},
          userId: resolvedUserId ?? undefined,
        })
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

function resolvePositiveIntEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(raw)) return fallback
  const parsed = Math.floor(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const ATTENDANCE_IMPORT_CSV_MAX_ROWS = resolvePositiveIntEnv('ATTENDANCE_IMPORT_CSV_MAX_ROWS', 500000, {
  min: 1000,
})

const ATTENDANCE_IMPORT_BULK_ENGINE_THRESHOLD = resolvePositiveIntEnv('ATTENDANCE_IMPORT_BULK_ENGINE_THRESHOLD', 50000, {
  min: 1000,
  max: ATTENDANCE_IMPORT_CSV_MAX_ROWS,
})

const ATTENDANCE_IMPORT_ITEMS_CHUNK_SIZE = resolvePositiveIntEnv('ATTENDANCE_IMPORT_ITEMS_CHUNK_SIZE', 300, {
  min: 50,
  max: 1000,
})

const ATTENDANCE_IMPORT_RECORDS_CHUNK_SIZE = resolvePositiveIntEnv('ATTENDANCE_IMPORT_RECORDS_CHUNK_SIZE', 200, {
  min: 50,
  max: 1000,
})

const ATTENDANCE_IMPORT_BULK_ITEMS_CHUNK_SIZE = resolvePositiveIntEnv('ATTENDANCE_IMPORT_BULK_ITEMS_CHUNK_SIZE', 1200, {
  min: 200,
  max: 5000,
})

const ATTENDANCE_IMPORT_BULK_RECORDS_CHUNK_SIZE = resolvePositiveIntEnv('ATTENDANCE_IMPORT_BULK_RECORDS_CHUNK_SIZE', 1000, {
  min: 200,
  max: 5000,
})

const ATTENDANCE_IMPORT_PREFETCH_MAX_USERS = resolvePositiveIntEnv('ATTENDANCE_IMPORT_PREFETCH_MAX_USERS', 5000, {
  min: 100,
  max: 100000,
})

const ATTENDANCE_IMPORT_PREFETCH_MAX_WORK_DATES = resolvePositiveIntEnv('ATTENDANCE_IMPORT_PREFETCH_MAX_WORK_DATES', 366, {
  min: 7,
  max: 10000,
})

const ATTENDANCE_IMPORT_PREFETCH_MAX_SPAN_DAYS = resolvePositiveIntEnv('ATTENDANCE_IMPORT_PREFETCH_MAX_SPAN_DAYS', 366, {
  min: 7,
  max: 10000,
})

function resolveEnumEnv(name, fallback, allowed) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase()
  if (allowed.includes(raw)) return raw
  return fallback
}

const ATTENDANCE_IMPORT_RECORD_UPSERT_MODE = resolveEnumEnv(
  'ATTENDANCE_IMPORT_RECORD_UPSERT_MODE',
  'unnest',
  ['values', 'unnest']
)

const ATTENDANCE_IMPORT_ITEMS_INSERT_MODE = resolveEnumEnv(
  'ATTENDANCE_IMPORT_ITEMS_INSERT_MODE',
  'unnest',
  ['values', 'unnest']
)

const ATTENDANCE_IMPORT_BULK_ENGINE_MODE = resolveEnumEnv(
  'ATTENDANCE_IMPORT_BULK_ENGINE_MODE',
  'auto',
  ['auto', 'force', 'off']
)

function iterateCsvRows(csvText, delimiter = ',', onRow) {
  if (typeof csvText !== 'string' || !csvText.trim()) return { rowCount: 0, stoppedEarly: false }
  const sep = typeof delimiter === 'string' && delimiter.length > 0 ? delimiter[0] : ','
  let row = []
  let field = ''
  let inQuotes = false
  let rowCount = 0
  let stoppedEarly = false

  const emitRow = () => {
    row.push(field)
    field = ''
    const keepRow = row.length > 1 || row[0]?.trim()
    if (!keepRow) {
      row = []
      return true
    }
    const shouldContinue = typeof onRow === 'function' ? onRow(row, rowCount) !== false : true
    rowCount += 1
    row = []
    if (!shouldContinue) {
      stoppedEarly = true
      return false
    }
    return true
  }

  for (let i = 0; i < csvText.length; i += 1) {
    const ch = csvText[i]
    if (inQuotes) {
      if (ch === '"') {
        const next = csvText[i + 1]
        if (next === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else if (ch === '\r') {
        if (csvText[i + 1] === '\n') i += 1
        field += '\n'
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === sep) {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && csvText[i + 1] === '\n') i += 1
      if (!emitRow()) break
      continue
    }
    field += ch
  }

  if (!stoppedEarly) {
    emitRow()
  }

  return { rowCount, stoppedEarly }
}

function normalizeCsvHeaderValue(value) {
  if (value === undefined || value === null) return ''
  const text = String(value).replace(/\ufeff/g, '').trim()
  return text
}

function detectCsvHeaderIndex(csvText, delimiter) {
  let detectedIndex = 0
  let found = false
  iterateCsvRows(csvText, delimiter, (rawRow, rowIndex) => {
    const row = rawRow.map(normalizeCsvHeaderValue).filter(Boolean)
    if (!row.length) return true
    const hasName = row.some((cell) => cell === '姓名' || cell.toLowerCase() === 'name')
    const hasDate = row.some((cell) => ['日期', 'date', 'workdate', 'work_date'].includes(cell.toLowerCase()))
    if (hasName && hasDate) {
      detectedIndex = rowIndex
      found = true
      return false
    }
    return true
  })
  return found ? detectedIndex : 0
}

function normalizeCsvWorkDate(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  const numeric = text.replace(/[^0-9]/g, '')
  if (/^\d{13}$/.test(numeric)) {
    const date = new Date(Number(numeric))
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
  }
  if (/^\d{10}$/.test(numeric)) {
    const date = new Date(Number(numeric) * 1000)
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
  }
  const cleaned = text.split(' ')[0].trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned
  if (/^\d{2}-\d{2}-\d{2}$/.test(cleaned)) {
    const [yy, mm, dd] = cleaned.split('-')
    return `20${yy}-${mm}-${dd}`
  }
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(cleaned)) return cleaned.replace(/\//g, '-')
  return null
}

function isRestShiftRow(row) {
  const fields = row?.fields || {}
  const candidates = [
    fields.shiftName,
    fields.plan_detail,
    fields.attendanceClass,
    fields.attendance_class,
    fields['班次'],
    fields['出勤班次'],
    fields.status,
    fields.attend_result,
    fields['考勤结果'],
    fields['当天考勤情况'],
  ]
  return candidates.some((value) => {
    if (value === undefined || value === null) return false
    return String(value).includes('休息')
  })
}

const NON_PUNCH_STATUS_KEYWORDS = [
  '休息',
  '请假',
  '调休',
  '出差',
  '外出',
  '外勤',
  '补卡',
  '旷工',
  '事假',
  '病假',
  '工伤',
  '产假',
  '陪产',
  '婚假',
  '丧假',
  '年假',
  '哺乳',
]

const PUNCH_OVERRIDE_FIELDS = [
  'actual_work_hours',
  'attendance_work_time',
  'actual_work_hours_test',
  'total_work_hours',
  'leave_hours',
  'comp_time_hours',
  'overtime_duration',
  'attendance_days',
  'attendance_rest_days',
  'missing_card_times',
  'absenteeism_hours',
]

function extractStatusText(row) {
  const fields = row?.fields || {}
  const candidates = [
    fields.status,
    fields.attend_result,
    fields['考勤结果'],
    fields['当天考勤情况'],
    fields.daily_attendance_status,
    fields['异常原因'],
    fields.exceptionReason,
  ]
  return candidates
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .map((value) => String(value))
    .join(' ')
}

function parseNumberValue(value) {
  if (value === undefined || value === null) return null
  const raw = String(value).replace(/[^0-9.+-]/g, '')
  if (!raw) return null
  const num = Number(raw)
  return Number.isFinite(num) ? num : null
}

function hasPositiveFieldValue(row, keys) {
  for (const key of keys) {
    const value = resolveRequiredFieldValue(row, key)
    const num = parseNumberValue(value)
    if (num && num > 0) return true
  }
  return false
}

function shouldEnforcePunchRequired(row) {
  if (isRestShiftRow(row)) return false
  const statusText = extractStatusText(row)
  if (statusText && NON_PUNCH_STATUS_KEYWORDS.some((keyword) => statusText.includes(keyword))) {
    return false
  }
  if (hasPositiveFieldValue(row, PUNCH_OVERRIDE_FIELDS)) return false
  return true
}

function buildRowsFromCsv({ csvText, csvOptions, maxRows }) {
  const delimiter = csvOptions?.delimiter || ','
  const resolvedMaxRowsRaw = Number(maxRows ?? ATTENDANCE_IMPORT_CSV_MAX_ROWS)
  const resolvedMaxRows = Number.isFinite(resolvedMaxRowsRaw) && resolvedMaxRowsRaw > 0
    ? Math.floor(resolvedMaxRowsRaw)
    : ATTENDANCE_IMPORT_CSV_MAX_ROWS

  if (typeof csvText !== 'string' || !csvText.trim()) {
    return { rows: [], warnings: ['CSV empty or unreadable'], limitExceeded: false, maxRows: resolvedMaxRows }
  }

  const headerRowIndex = Number.isFinite(csvOptions?.headerRowIndex)
    ? Math.max(0, Number(csvOptions.headerRowIndex))
    : detectCsvHeaderIndex(csvText, delimiter)

  let seenRows = 0
  let header = []
  const rows = []
  let limitExceeded = false

  iterateCsvRows(csvText, delimiter, (rawRow, rowIndex) => {
    seenRows += 1
    if (rowIndex < headerRowIndex) return true
    if (rowIndex === headerRowIndex) {
      header = rawRow.map(normalizeCsvHeaderValue)
      return true
    }
    if (!header.length) return true
    if (rows.length >= resolvedMaxRows) {
      limitExceeded = true
      return false
    }
    const fields = {}
    let hasValue = false
    header.forEach((key, index) => {
      if (!key) return
      const value = rawRow[index] ?? ''
      if (value !== '') hasValue = true
      fields[key] = value
    })
    if (!hasValue) return true
    const workDate = normalizeCsvWorkDate(fields['日期'] ?? fields.workDate ?? fields.date)
    const userId = fields.UserId ?? fields.userId ?? fields['用户ID']
    rows.push({
      workDate: workDate ?? '',
      fields,
      userId: userId ? String(userId).trim() : undefined,
    })
    return true
  })

  if (seenRows === 0) {
    return { rows: [], warnings: ['CSV empty or unreadable'], limitExceeded: false, maxRows: resolvedMaxRows }
  }
  if (!header.length || header.every((value) => !value)) {
    return { rows: [], warnings: ['CSV header row not found'], limitExceeded: false, maxRows: resolvedMaxRows }
  }

  const warnings = []
  if (limitExceeded) {
    warnings.push(`CSV exceeds max rows (${resolvedMaxRows}); only the first ${resolvedMaxRows} rows were parsed.`)
  }
  return { rows, warnings, limitExceeded, maxRows: resolvedMaxRows }
}

function ensureCsvRowsWithinLimit(result) {
  if (!result?.limitExceeded) return
  throw new HttpError(400, 'CSV_TOO_LARGE', `CSV exceeds max rows (${result.maxRows})`)
}

function releaseImportRowMemory(row) {
  if (!row || typeof row !== 'object') return
  if (row.fields && typeof row.fields === 'object') {
    row.fields = undefined
  }
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

function resolveUserMapEntry(userMap, key) {
  if (!userMap || !key) return null
  const entry = userMap[key]
  if (entry && typeof entry === 'object') return entry
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

function resolveRowUserProfile({ row, fallbackUserId, userMap, userMapKeyField, userMapSourceFields }) {
  if (!row || !userMap) return null
  const fields = row.fields ?? {}
  const candidates = []
  if (row.userId) candidates.push(row.userId)
  if (row.user_id) candidates.push(row.user_id)
  const direct = fields.userId ?? fields.user_id
  if (direct) candidates.push(direct)
  if (fallbackUserId) candidates.push(fallbackUserId)
  if (userMapKeyField && fields[userMapKeyField] !== undefined) {
    candidates.push(fields[userMapKeyField])
  }
  if (Array.isArray(userMapSourceFields)) {
    userMapSourceFields.forEach((field) => {
      if (field && fields[field] !== undefined) candidates.push(fields[field])
    })
  }
  candidates.push(fields.empNo, fields['工号'], fields.sourceUserKey, fields.userKey, fields.userName, fields['姓名'])
  for (const value of candidates) {
    if (value === null || value === undefined || value === '') continue
    const entry = resolveUserMapEntry(userMap, String(value).trim())
    if (entry) {
      return entry.profile && typeof entry.profile === 'object' ? entry.profile : entry
    }
  }
  return null
}

const PROFILE_FIELD_ALIASES = {
  attendance_group: ['attendance_group', 'attendanceGroup', '考勤组'],
  attendanceGroup: ['attendanceGroup', 'attendance_group', '考勤组'],
  department: ['department', '部门'],
  role: ['role', '职位'],
  roleTags: ['roleTags', 'role_tags', '角色标签'],
  role_tags: ['role_tags', 'roleTags', '角色标签'],
  empNo: ['empNo', '工号', 'employeeNo', 'employee_no'],
  userName: ['userName', 'name', '姓名'],
  entryTime: ['entryTime', 'entry_time', '入职时间'],
  resignTime: ['resignTime', 'resign_time', '离职时间'],
}

function resolveProfileValue(profile, key) {
  if (!profile || typeof profile !== 'object') return undefined
  if (profile[key] !== undefined) return profile[key]
  const aliases = PROFILE_FIELD_ALIASES[key]
  if (!aliases) return undefined
  for (const alias of aliases) {
    if (profile[alias] !== undefined) return profile[alias]
  }
  return undefined
}

function resolveRequiredFieldValue(row, field) {
  if (!row || !field) return undefined
  if (row.fields && row.fields[field] !== undefined) return row.fields[field]
  if (row[field] !== undefined) return row[field]
  return undefined
}

function buildProfileSnapshot({ valueFor, userProfile }) {
  if (!valueFor) return null
  const snapshot = {
    attendanceGroup: valueFor('attendanceGroup') ?? valueFor('attendance_group'),
    department: valueFor('department'),
    role: valueFor('role') ?? valueFor('职位'),
    empNo: valueFor('empNo') ?? valueFor('工号'),
    userName: valueFor('userName') ?? valueFor('name') ?? valueFor('姓名'),
    entryTime: valueFor('entryTime') ?? valueFor('entry_time') ?? valueFor('入职时间'),
    resignTime: valueFor('resignTime') ?? valueFor('resign_time') ?? valueFor('离职时间'),
  }

  const rawRoleTags = valueFor('roleTags') ?? valueFor('role_tags')
  const roleTags = Array.isArray(rawRoleTags)
    ? rawRoleTags
    : typeof rawRoleTags === 'string'
      ? rawRoleTags.split(',').map((tag) => tag.trim()).filter(Boolean)
      : []
  if (roleTags.length) snapshot.roleTags = roleTags

  if (userProfile && typeof userProfile === 'object') {
    Object.keys(snapshot).forEach((key) => {
      if (snapshot[key] === undefined || snapshot[key] === null || snapshot[key] === '') {
        const fallback = resolveProfileValue(userProfile, key)
        if (fallback !== undefined && fallback !== null && fallback !== '') snapshot[key] = fallback
      }
    })
    if (!snapshot.roleTags || snapshot.roleTags.length === 0) {
      const fallbackTags = resolveProfileValue(userProfile, 'roleTags')
      if (Array.isArray(fallbackTags) && fallbackTags.length) snapshot.roleTags = fallbackTags
    }
  }

  const cleaned = {}
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined || value === null || value === '') continue
    cleaned[key] = value
  }
  return Object.keys(cleaned).length ? cleaned : null
}

function buildHolidayPolicyContext({ rowUserId, valueFor, userProfile, profileSnapshot }) {
  if (!valueFor) return null
  const snapshot = profileSnapshot ?? buildProfileSnapshot({ valueFor, userProfile }) ?? {}
  const rawRoleTags = snapshot.roleTags ?? valueFor('roleTags') ?? valueFor('role_tags')
  const roleTags = Array.isArray(rawRoleTags)
    ? rawRoleTags.map((tag) => String(tag).trim()).filter(Boolean)
    : typeof rawRoleTags === 'string'
      ? rawRoleTags.split(',').map((tag) => tag.trim()).filter(Boolean)
      : []
  const context = {
    userId: rowUserId ?? valueFor('userId') ?? valueFor('user_id'),
    userName: snapshot.userName ?? valueFor('userName') ?? valueFor('name') ?? valueFor('姓名'),
    attendanceGroup: snapshot.attendanceGroup ?? valueFor('attendanceGroup') ?? valueFor('attendance_group'),
    role: snapshot.role ?? valueFor('role') ?? valueFor('职位'),
    roleTags,
  }
  const cleaned = {}
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null || value === '') continue
    cleaned[key] = value
  }
  if (!cleaned.roleTags || cleaned.roleTags.length === 0) {
    delete cleaned.roleTags
  }
  return Object.keys(cleaned).length ? cleaned : null
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
  let offset = Number(template.endMonthOffset ?? template.end_month_offset ?? 0)
  if (!Number.isFinite(offset)) offset = 0
  if (offset === 0 && Number.isFinite(startDay) && Number.isFinite(endDay) && endDay < startDay) {
    offset = 1
  }

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

function addMonthsToDate(anchorDate, delta) {
  const { year, month, day } = getUtcParts(anchorDate)
  const next = addMonthsUtc(year, month, delta)
  return buildUtcDate(next.year, next.month, day)
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

function mapAttendanceGroupRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    name: row.name,
    code: row.code ?? '',
    timezone: row.timezone ?? DEFAULT_RULE.timezone,
    ruleSetId: row.rule_set_id ?? null,
    description: row.description ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  }
}

function mapAttendanceGroupMemberRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    groupId: row.group_id,
    userId: row.user_id,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
  }
}

function normalizeAttendanceGroupValue(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text.length ? text.toLowerCase() : null
}

function resolveAttendanceGroupName(row) {
  const raw = row?.fields?.attendance_group ?? row?.fields?.attendanceGroup ?? row?.fields?.['考勤组']
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim()
  return text.length ? text : null
}

function resolveAttendanceGroupKey(row) {
  return normalizeAttendanceGroupValue(resolveAttendanceGroupName(row))
}

async function loadAttendanceGroupIdMap(db, orgId) {
  const rows = await db.query(
    'SELECT id, name, code, rule_set_id FROM attendance_groups WHERE org_id = $1',
    [orgId]
  )
  const map = new Map()
  rows.forEach((row) => {
    if (typeof row.name === 'string' && row.name.trim()) {
      const key = normalizeAttendanceGroupValue(row.name)
      if (key) map.set(key, { id: row.id, name: row.name, ruleSetId: row.rule_set_id })
    }
    if (typeof row.code === 'string' && row.code.trim()) {
      const key = normalizeAttendanceGroupValue(row.code)
      if (key && !map.has(key)) map.set(key, { id: row.id, name: row.name, ruleSetId: row.rule_set_id })
    }
  })
  return map
}

async function ensureAttendanceGroups(db, orgId, groupNames, options) {
  const map = await loadAttendanceGroupIdMap(db, orgId)
  let created = 0
  if (!groupNames || groupNames.size === 0) return { map, created }
  const ruleSetId = options?.ruleSetId ?? null
  const timezone = options?.timezone ?? DEFAULT_RULE.timezone
  for (const [key, name] of groupNames.entries()) {
    if (!key || map.has(key)) continue
    const rows = await db.query(
      `INSERT INTO attendance_groups (org_id, name, code, timezone, rule_set_id, description, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, now(), now())
       ON CONFLICT (org_id, name) DO UPDATE SET
         timezone = COALESCE(attendance_groups.timezone, EXCLUDED.timezone),
         rule_set_id = COALESCE(attendance_groups.rule_set_id, EXCLUDED.rule_set_id),
         updated_at = now()
       RETURNING id, name, rule_set_id`,
      [orgId, name, null, timezone, ruleSetId]
    )
    if (rows.length) {
      const row = rows[0]
      map.set(key, { id: row.id, name: row.name ?? name, ruleSetId: row.rule_set_id })
      created += 1
    }
  }
  return { map, created }
}

async function insertAttendanceGroupMembers(db, orgId, members) {
  if (!members.length) return 0
  const chunkSize = 200
  let inserted = 0
  for (let i = 0; i < members.length; i += chunkSize) {
    const chunk = members.slice(i, i + chunkSize)
    const values = []
    const params = []
    chunk.forEach((member, index) => {
      const baseIndex = index * 3
      values.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, now(), now())`)
      params.push(orgId, member.groupId, member.userId)
    })
    const rows = await db.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id, created_at, updated_at)
       VALUES ${values.join(', ')}
       ON CONFLICT (org_id, group_id, user_id) DO NOTHING
       RETURNING id`,
      params
    )
    inserted += rows.length
  }
  return inserted
}

async function loadRuleSetConfigById(db, orgId, ruleSetId) {
  if (!ruleSetId) return null
  const rows = await db.query(
    'SELECT config FROM attendance_rule_sets WHERE id = $1 AND org_id = $2',
    [ruleSetId, orgId]
  )
  if (!rows.length) return null
  return normalizeMetadata(rows[0].config)
}

async function loadAttendanceGroupRuleSetMap(db, orgId) {
  const rows = await db.query(
    'SELECT name, code, rule_set_id FROM attendance_groups WHERE org_id = $1 AND rule_set_id IS NOT NULL',
    [orgId]
  )
  const map = new Map()
  rows.forEach((row) => {
    const ruleSetId = row.rule_set_id
    if (!ruleSetId) return
    if (typeof row.name === 'string' && row.name.trim()) {
      map.set(row.name.trim().toLowerCase(), ruleSetId)
    }
    if (typeof row.code === 'string' && row.code.trim()) {
      map.set(row.code.trim().toLowerCase(), ruleSetId)
    }
  })
  return map
}

function collectAttendanceGroupNames(rows) {
  const names = new Map()
  if (!Array.isArray(rows)) return names
  for (const row of rows) {
    const name = resolveAttendanceGroupName(row)
    const key = normalizeAttendanceGroupValue(name)
    if (!key || !name) continue
    if (!names.has(key)) names.set(key, name)
  }
  return names
}

function normalizeGroupSyncOptions(groupSync, fallbackRuleSetId, fallbackTimezone) {
  if (!groupSync || typeof groupSync !== 'object') return null
  const autoCreate = groupSync.autoCreate === true
  const autoAssignMembers = groupSync.autoAssignMembers === true
  if (!autoCreate && !autoAssignMembers) return null
  const ruleSetId = typeof groupSync.ruleSetId === 'string' && groupSync.ruleSetId.trim().length > 0
    ? groupSync.ruleSetId.trim()
    : (typeof fallbackRuleSetId === 'string' && fallbackRuleSetId.trim().length > 0 ? fallbackRuleSetId.trim() : null)
  const timezone = typeof groupSync.timezone === 'string' && groupSync.timezone.trim().length > 0
    ? groupSync.timezone.trim()
    : (typeof fallbackTimezone === 'string' && fallbackTimezone.trim().length > 0 ? fallbackTimezone.trim() : null)
  return {
    autoCreate,
    autoAssignMembers,
    ruleSetId,
    timezone,
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

function mapImportBatchRow(row) {
  const meta = normalizeMetadata(row.meta)
	  return {
	    id: row.id,
	    orgId: row.org_id ?? DEFAULT_ORG_ID,
	    idempotencyKey: row.idempotency_key ?? meta?.idempotencyKey ?? null,
	    createdBy: row.created_by,
	    source: row.source ?? null,
	    ruleSetId: row.rule_set_id ?? null,
	    mapping: normalizeMetadata(row.mapping),
    rowCount: Number(row.row_count ?? 0),
    status: row.status ?? 'committed',
    meta,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

	function mapImportItemRow(row) {
	  return {
	    id: row.id,
	    batchId: row.batch_id,
	    orgId: row.org_id ?? DEFAULT_ORG_ID,
	    userId: row.user_id,
	    workDate: row.work_date,
	    recordId: row.record_id ?? null,
	    previewSnapshot: normalizeMetadata(row.preview_snapshot),
	    createdAt: row.created_at,
	  }
	}

	let cachedImportBatchIdempotencyColumn = null

	async function hasImportBatchIdempotencyColumn(client) {
	  if (cachedImportBatchIdempotencyColumn != null) return cachedImportBatchIdempotencyColumn
	  try {
	    const rows = await client.query(
	      `SELECT 1
	       FROM information_schema.columns
	       WHERE table_name = 'attendance_import_batches'
	         AND column_name = 'idempotency_key'
	         AND table_schema = current_schema()
	       LIMIT 1`,
	      []
	    )
	    cachedImportBatchIdempotencyColumn = rows.length > 0
	  } catch (_error) {
	    cachedImportBatchIdempotencyColumn = false
	  }
	  return cachedImportBatchIdempotencyColumn
	}

	function buildSkippedImportSnapshot({ warnings, row, reason }) {
	  const safeWarnings = Array.isArray(warnings) ? warnings.map((w) => String(w)) : []
	  const snapshot = {
	    warnings: safeWarnings,
	    metrics: {
	      workMinutes: 0,
	      lateMinutes: 0,
	      earlyLeaveMinutes: 0,
	      leaveMinutes: 0,
	      overtimeMinutes: 0,
	      status: 'invalid',
	    },
	    skip: {
	      reason: reason || null,
	    },
	  }
	  if (row && typeof row === 'object') {
	    snapshot.row = {
	      workDate: row.workDate ?? null,
	      userId: row.userId ?? row.user_id ?? null,
	      fields: row.fields ?? {},
	    }
	  }
	  return snapshot
	}

	async function loadIdempotentImportBatch(client, orgId, idempotencyKey) {
	  const hasColumn = await hasImportBatchIdempotencyColumn(client)
	  const rows = await client.query(
	    hasColumn
	      ? `SELECT id, meta
	         FROM attendance_import_batches
	         WHERE org_id = $1 AND idempotency_key = $2 AND status = $3
	         ORDER BY created_at DESC
	         LIMIT 1`
	      : `SELECT id, meta
	         FROM attendance_import_batches
	         WHERE org_id = $1 AND (meta->>'idempotencyKey') = $2 AND status = $3
	         ORDER BY created_at DESC
	         LIMIT 1`,
	    [orgId, idempotencyKey, 'committed']
	  )
	  if (!rows.length) return null
	  const batch = rows[0]
	  const counts = await client.query(
	    `SELECT
	       COUNT(*) FILTER (WHERE record_id IS NOT NULL)::int AS imported,
	       COUNT(*) FILTER (WHERE record_id IS NULL)::int AS skipped
	     FROM attendance_import_items
	     WHERE batch_id = $1 AND org_id = $2`,
	    [batch.id, orgId]
	  )
	  const imported = Number(counts[0]?.imported ?? 0)
	  const skipped = Number(counts[0]?.skipped ?? 0)
	  return {
	    batchId: batch.id,
	    imported,
	    skipped,
	    meta: normalizeMetadata(batch.meta),
	  }
	}

	async function acquireImportIdempotencyLock(client, orgId, idempotencyKey) {
	  const clean = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : ''
	  if (!clean) return
	  try {
	    await client.query(
	      'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))',
	      [String(orgId ?? ''), clean]
	    )
	  } catch (_error) {
	    // Best-effort: keep functional behavior even if advisory locks are unavailable.
	  }
	}

function mapIntegrationRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    name: row.name,
    type: row.type,
    status: row.status,
    config: normalizeMetadata(row.config),
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapIntegrationRunRow(row) {
  return {
    id: row.id,
    orgId: row.org_id ?? DEFAULT_ORG_ID,
    integrationId: row.integration_id,
    status: row.status,
    message: row.message,
    meta: normalizeMetadata(row.meta),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function createIntegrationRun(db, { orgId, integrationId }) {
  const rows = await db.query(
    `INSERT INTO attendance_integration_runs
     (org_id, integration_id, status, started_at, created_at, updated_at)
     VALUES ($1, $2, 'running', now(), now(), now())
     RETURNING *`,
    [orgId, integrationId]
  )
  return rows.length ? mapIntegrationRunRow(rows[0]) : null
}

async function updateIntegrationRun(db, runId, updates) {
  const meta = updates?.meta ? JSON.stringify(updates.meta) : null
  const rows = await db.query(
    `UPDATE attendance_integration_runs
     SET status = COALESCE($2, status),
         message = COALESCE($3, message),
         meta = COALESCE($4::jsonb, meta),
         finished_at = COALESCE($5, finished_at),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [runId, updates?.status ?? null, updates?.message ?? null, meta, updates?.finishedAt ?? null]
  )
  return rows.length ? mapIntegrationRunRow(rows[0]) : null
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
  const formatter = getCachedIntlDateTimeFormat(workDateFormatterCache, timeZone, 'en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  if (!formatter) return value.toISOString().slice(0, 10)
  try {
    return formatter.format(value)
  } catch {
    return value.toISOString().slice(0, 10)
  }
}

function getZonedMinutes(value, timeZone) {
  const formatter = getCachedIntlDateTimeFormat(zonedMinutesFormatterCache, timeZone, 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  if (!formatter) return value.getUTCHours() * 60 + value.getUTCMinutes()
  try {
    const text = formatter.format(value)
    const [hRaw, mRaw] = String(text).split(':')
    const hour = Number(hRaw)
    const minute = Number(mRaw)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return value.getUTCHours() * 60 + value.getUTCMinutes()
    }
    return hour * 60 + minute
  } catch {
    return value.getUTCHours() * 60 + value.getUTCMinutes()
  }
}

function parseTimeToMinutes(value, fallback) {
  if (!value) return fallback
  const key = typeof value === 'string' ? value.trim() : String(value).trim()
  if (!key) return fallback
  if (timeToMinutesCache.has(key)) {
    const cached = timeToMinutesCache.get(key)
    return cached === null ? fallback : cached
  }
  const [hours, minutes] = key.split(':')
  const h = Number(hours)
  const m = Number(minutes)
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    timeToMinutesCache.set(key, null)
    return fallback
  }
  const parsed = h * 60 + m
  timeToMinutesCache.set(key, parsed)
  return parsed
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

function parseHolidayDayIndex(name) {
  if (!name) return null
  const trimmed = String(name).trim()
  if (!trimmed) return null
  const patterns = [
    /第\s*([0-9]{1,2})\s*[天日]/u,
    /[-_\s]([0-9]{1,2})\s*[天日]?$/u,
    /\bDAY\s*([0-9]{1,2})\b/i,
    /([0-9]{1,2})\s*[天日]$/u,
  ]
  for (const pattern of patterns) {
    const match = trimmed.match(pattern)
    if (match && match[1]) {
      const num = Number(match[1])
      if (Number.isFinite(num) && num > 0) return num
    }
  }
  return null
}

function resolveTimeZone(timeZone, fallback) {
  const zone = typeof timeZone === 'string' ? timeZone.trim() : ''
  if (!zone) return fallback
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date())
    return zone
  } catch (error) {
    return fallback
  }
}

function resolveHolidayMeta(holiday) {
  if (!holiday || typeof holiday !== 'object') {
    return { name: null, dayIndex: null, isFirstDay: false }
  }
  const name = typeof holiday.name === 'string' ? holiday.name.trim() : ''
  const dayIndex = parseHolidayDayIndex(name)
  return {
    name: name || null,
    dayIndex,
    isFirstDay: dayIndex === 1,
  }
}

function hasOvertimeApproval(summary) {
  if (!summary) return false
  const text = Array.isArray(summary) ? summary.join(' ') : String(summary)
  return /加班|overtime/i.test(text)
}

function normalizeMatchValue(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizeMatchKey(value) {
  return normalizeMatchValue(value).toLowerCase()
}

function matchListValue(value, list) {
  if (!list || list.length === 0) return true
  const normalized = normalizeMatchKey(value)
  if (!normalized) return false
  return list.some((item) => normalizeMatchKey(item) === normalized)
}

function matchAnyTag(values, list) {
  if (!list || list.length === 0) return true
  if (!values || values.length === 0) return false
  const normalizedList = list.map((item) => normalizeMatchKey(item)).filter(Boolean)
  if (normalizedList.length === 0) return false
  return values.some((value) => normalizedList.includes(normalizeMatchKey(value)))
}

function matchHolidayOverrideFilters(override, holidayMeta, policyContext) {
  if (!override) return true
  const dayIndex = holidayMeta?.dayIndex
  if (override.dayIndexStart != null || override.dayIndexEnd != null || (override.dayIndexList && override.dayIndexList.length)) {
    if (!dayIndex) return false
    if (Array.isArray(override.dayIndexList) && override.dayIndexList.length && !override.dayIndexList.includes(dayIndex)) {
      return false
    }
    if (Number.isFinite(override.dayIndexStart) && dayIndex < override.dayIndexStart) return false
    if (Number.isFinite(override.dayIndexEnd) && dayIndex > override.dayIndexEnd) return false
  }
  const context = policyContext ?? {}
  if (Array.isArray(override.userIds) && override.userIds.length && !matchListValue(context.userId, override.userIds)) {
    return false
  }
  if (Array.isArray(override.userNames) && override.userNames.length && !matchListValue(context.userName, override.userNames)) {
    return false
  }
  if (Array.isArray(override.excludeUserIds) && override.excludeUserIds.length && matchListValue(context.userId, override.excludeUserIds)) {
    return false
  }
  if (Array.isArray(override.excludeUserNames) && override.excludeUserNames.length && matchListValue(context.userName, override.excludeUserNames)) {
    return false
  }
  if (Array.isArray(override.attendanceGroups) && override.attendanceGroups.length && !matchListValue(context.attendanceGroup, override.attendanceGroups)) {
    return false
  }
  if (Array.isArray(override.roles) && override.roles.length && !matchListValue(context.role, override.roles)) {
    return false
  }
  if (Array.isArray(override.roleTags) && override.roleTags.length && !matchAnyTag(context.roleTags, override.roleTags)) {
    return false
  }
  return true
}

function omitUndefinedFields(source) {
  if (!source || typeof source !== 'object') return {}
  const cleaned = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) cleaned[key] = value
  }
  return cleaned
}

function matchHolidayOverride(name, override) {
  if (!name || !override) return false
  const matchType = override.match || 'contains'
  const pattern = String(override.name || '').trim()
  if (!pattern) return false
  if (matchType === 'equals') return name === pattern
  if (matchType === 'regex') {
    try {
      return new RegExp(pattern, 'i').test(name)
    } catch (_error) {
      return false
    }
  }
  return name.includes(pattern)
}

function resolveHolidayPolicyOverride(policy, holidayMeta, policyContext) {
  if (!policy || !holidayMeta?.name) return null
  const overrides = Array.isArray(policy.overrides) ? policy.overrides : []
  if (!overrides.length) return null
  for (const override of overrides) {
    if (!matchHolidayOverride(holidayMeta.name, override)) continue
    if (!matchHolidayOverrideFilters(override, holidayMeta, policyContext)) continue
    return override
  }
  return null
}

function applyHolidayPolicy({ settings, holiday, holidayMeta, metrics, approvalSummary, policyContext }) {
  const basePolicy = settings?.holidayPolicy ?? DEFAULT_SETTINGS.holidayPolicy
  const meta = holidayMeta ?? resolveHolidayMeta(holiday)
  const override = resolveHolidayPolicyOverride(basePolicy, meta, policyContext)
  const overrideConfig = override ? omitUndefinedFields(override) : null
  const policy = overrideConfig
    ? { ...basePolicy, ...overrideConfig }
    : basePolicy
  const warnings = []
  if (!holiday || holiday.isWorkingDay === true) {
    return { metrics, warnings, holidayMeta: meta }
  }
  const overrideHasDayIndex = Boolean(override && (
    override.dayIndexStart != null
    || override.dayIndexEnd != null
    || (Array.isArray(override.dayIndexList) && override.dayIndexList.length > 0)
  ))
  const shouldApplyBaseHours = overrideHasDayIndex ? true : meta.isFirstDay
  if (!policy?.firstDayEnabled || !shouldApplyBaseHours) {
    return { metrics, warnings, holidayMeta: meta }
  }
  const baseHours = Number.isFinite(policy.firstDayBaseHours)
    ? policy.firstDayBaseHours
    : DEFAULT_SETTINGS.holidayPolicy.firstDayBaseHours
  const baseMinutes = Math.round(baseHours * 60)
  const nextMetrics = {
    ...metrics,
    workMinutes: baseMinutes,
    status: 'adjusted',
  }
  if (overrideHasDayIndex && meta.dayIndex != null) {
    warnings.push(`节假日第${meta.dayIndex}天按${baseHours}小时`)
  } else {
    warnings.push(`节假日首日按${baseHours}小时`)
  }

  const overtimeSource = policy.overtimeSource ?? DEFAULT_SETTINGS.holidayPolicy.overtimeSource
  const overtimeByApproval = hasOvertimeApproval(approvalSummary)
  const overtimeByClock = Number(metrics.overtimeMinutes ?? 0) > 0
  const shouldAddOvertime = policy.overtimeAdds && (
    overtimeSource === 'both'
      ? (overtimeByApproval || overtimeByClock)
      : overtimeSource === 'approval'
        ? overtimeByApproval
        : overtimeByClock
  )

  if (shouldAddOvertime && overtimeByClock) {
    warnings.push('节假日首日加班单叠加工时')
  } else if (shouldAddOvertime && !overtimeByClock) {
    warnings.push('节假日首日存在加班单但未提供加班工时')
  }

  return { metrics: nextMetrics, warnings, holidayMeta: meta }
}

function resolvePolicySkipRules(settings) {
  const skip = new Set()
  if (settings?.holidayPolicy?.firstDayEnabled) {
    skip.add('holiday-default-8h')
  }
  return skip
}

function parseHolidayCnDate(date) {
  if (!date) return null
  const trimmed = String(date).trim()
  if (!trimmed) return null
  const parts = trimmed.split('-')
  if (parts.length !== 3) return trimmed
  const year = parts[0].padStart(4, '0')
  const month = parts[1].padStart(2, '0')
  const day = parts[2].padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatHolidayDayIndex(name, index, format) {
  if (!name) return name
  switch (format) {
    case 'name第1天':
      return `${name}第${index}天`
    case 'name DAY1':
      return `${name} DAY${index}`
    case 'name-1':
    default:
      return `${name}-${index}`
  }
}

function normalizeHolidayCnDays(days, { addDayIndex, dayIndexHolidays, dayIndexMaxDays, dayIndexFormat }) {
  const items = Array.isArray(days) ? days : []
  const sorted = items
    .map((item) => ({
      date: parseHolidayCnDate(item?.date),
      name: typeof item?.name === 'string' ? item.name.trim() : '',
      isOffDay: Boolean(item?.isOffDay),
    }))
    .filter((item) => item.date)
    .sort((a, b) => a.date.localeCompare(b.date))

  let prevName = null
  let prevIsOff = false
  let prevDate = null
  let dayIndex = 0

  const output = []
  for (const item of sorted) {
    const { date, name, isOffDay } = item
    const normalizedName = name || null
    let labeledName = normalizedName

    const shouldIndexHoliday = (() => {
      if (!addDayIndex || !isOffDay || !normalizedName) return false
      if (!dayIndexHolidays || dayIndexHolidays.length === 0) return true
      return dayIndexHolidays.some((holiday) => normalizedName.includes(holiday))
    })()

    if (shouldIndexHoliday) {
      const contiguous =
        prevName === normalizedName &&
        prevIsOff &&
        prevDate &&
        Math.round((new Date(`${date}T00:00:00Z`) - new Date(`${prevDate}T00:00:00Z`)) / 86400000) === 1
      dayIndex = contiguous ? dayIndex + 1 : 1
      if (!dayIndexMaxDays || dayIndex <= dayIndexMaxDays) {
        labeledName = formatHolidayDayIndex(normalizedName, dayIndex, dayIndexFormat)
      }
    } else {
      dayIndex = 0
    }

    output.push({
      date,
      name: labeledName,
      isWorkingDay: !isOffDay,
    })

    prevName = normalizedName
    prevIsOff = isOffDay
    prevDate = date
  }

  return output
}

function resolveHolidaySyncYears(settings, payload) {
  const payloadYears = Array.isArray(payload?.years) ? payload.years : null
  const settingsYears = Array.isArray(settings?.holidaySync?.years) ? settings.holidaySync.years : null
  if (payloadYears && payloadYears.length > 0) return payloadYears
  if (settingsYears && settingsYears.length > 0) return settingsYears
  const currentYear = new Date().getFullYear()
  return [currentYear, currentYear + 1]
}

function resolveHolidaySyncConfig(settings, payload) {
  const source = 'holiday-cn'
  const baseUrl = typeof payload?.baseUrl === 'string' && payload.baseUrl.trim()
    ? payload.baseUrl.trim()
    : settings?.holidaySync?.baseUrl || DEFAULT_SETTINGS.holidaySync.baseUrl
  const addDayIndex = typeof payload?.addDayIndex === 'boolean'
    ? payload.addDayIndex
    : (settings?.holidaySync?.addDayIndex ?? DEFAULT_SETTINGS.holidaySync.addDayIndex)
  const dayIndexHolidays = Array.isArray(payload?.dayIndexHolidays) && payload.dayIndexHolidays.length
    ? payload.dayIndexHolidays.map((name) => String(name).trim()).filter(Boolean)
    : (settings?.holidaySync?.dayIndexHolidays ?? DEFAULT_SETTINGS.holidaySync.dayIndexHolidays)
  const dayIndexMaxDays = Number.isFinite(payload?.dayIndexMaxDays)
    ? Math.max(1, Number(payload.dayIndexMaxDays))
    : (settings?.holidaySync?.dayIndexMaxDays ?? DEFAULT_SETTINGS.holidaySync.dayIndexMaxDays)
  const dayIndexFormat = typeof payload?.dayIndexFormat === 'string' && payload.dayIndexFormat.trim()
    ? payload.dayIndexFormat.trim()
    : (settings?.holidaySync?.dayIndexFormat ?? DEFAULT_SETTINGS.holidaySync.dayIndexFormat)
  const overwrite = typeof payload?.overwrite === 'boolean'
    ? payload.overwrite
    : (settings?.holidaySync?.overwrite ?? DEFAULT_SETTINGS.holidaySync.overwrite)
  return { source, baseUrl, addDayIndex, dayIndexHolidays, dayIndexMaxDays, dayIndexFormat, overwrite }
}

async function fetchHolidayCnYear({ year, baseUrl }) {
  const sanitizedBase = String(baseUrl || DEFAULT_SETTINGS.holidaySync.baseUrl).replace(/\/$/, '')
  const url = `${sanitizedBase}/${year}.json`
  const fetchImpl = typeof fetch === 'function' ? fetch : null
  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this runtime')
  }
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'metasheet-attendance/holiday-sync' },
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch holiday-cn data for ${year}`)
  }
  const data = await response.json()
  const days = Array.isArray(data?.days) ? data.days : []
  return { url, year, days }
}

async function upsertHolidayRows(db, { orgId, rows, overwrite }) {
  if (!rows.length) return 0
  const chunkSize = 200
  let applied = 0

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const values = []
    const params = []
    chunk.forEach((row, index) => {
      const baseIndex = index * 5
      values.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5})`)
      params.push(randomUUID(), orgId, row.date, row.name ?? null, row.isWorkingDay)
    })
    const conflictAction = overwrite
      ? 'DO UPDATE SET name = EXCLUDED.name, is_working_day = EXCLUDED.is_working_day'
      : 'DO NOTHING'
    const rowsInserted = await db.query(
      `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day)
       VALUES ${values.join(', ')}
       ON CONFLICT (org_id, holiday_date) ${conflictAction}
       RETURNING holiday_date`,
      params
    )
    applied += rowsInserted.length
  }

  return applied
}

function getZonedParts(date, timeZone) {
  const formatter = getCachedIntlDateTimeFormat(zonedPartsFormatterCache, timeZone, 'en-US', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  if (!formatter) {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
    }
  }
  const parts = formatter.formatToParts(date)
  let year = 0
  let month = 0
  let day = 0
  let hour = 0
  let minute = 0
  let second = 0
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value)
    else if (part.type === 'month') month = Number(part.value)
    else if (part.type === 'day') day = Number(part.value)
    else if (part.type === 'hour') hour = Number(part.value)
    else if (part.type === 'minute') minute = Number(part.value)
    else if (part.type === 'second') second = Number(part.value)
  }
  return { year, month, day, hour, minute, second }
}

function getTimeZoneOffset(date, timeZone) {
  const parts = getZonedParts(date, timeZone)
  const utcTime = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  )
  return (utcTime - date.getTime()) / 60000
}

function zonedTimeToUtc(parts, timeZone) {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0
  )
  const offset = getTimeZoneOffset(new Date(utcGuess), timeZone)
  return utcGuess - offset * 60000
}

function computeNextRunTime({ now, timeZone, hour, minute }) {
  const nowDate = now || new Date()
  const nowParts = getZonedParts(nowDate, timeZone)
  let targetUtc = zonedTimeToUtc(
    {
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour,
      minute,
      second: 0,
    },
    timeZone
  )
  if (targetUtc <= nowDate.getTime()) {
    const middayUtc = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 12, 0, 0)
    const nextDay = new Date(middayUtc + 24 * 60 * 60 * 1000)
    const nextParts = getZonedParts(nextDay, timeZone)
    targetUtc = zonedTimeToUtc(
      {
        year: nextParts.year,
        month: nextParts.month,
        day: nextParts.day,
        hour,
        minute,
        second: 0,
      },
      timeZone
    )
  }
  return targetUtc
}

async function performHolidaySync({ db, logger, orgId, settings, payload }) {
  const syncConfig = resolveHolidaySyncConfig(settings, payload)
  const years = resolveHolidaySyncYears(settings, payload)
  let totalFetched = 0
  let totalApplied = 0
  const results = []

  for (const year of years) {
    const { url, days } = await fetchHolidayCnYear({ year, baseUrl: syncConfig.baseUrl })
    totalFetched += days.length
    const rows = normalizeHolidayCnDays(days, {
      addDayIndex: syncConfig.addDayIndex,
      dayIndexHolidays: syncConfig.dayIndexHolidays,
      dayIndexMaxDays: syncConfig.dayIndexMaxDays,
      dayIndexFormat: syncConfig.dayIndexFormat,
    })
    const applied = await upsertHolidayRows(db, {
      orgId,
      rows,
      overwrite: syncConfig.overwrite,
    })
    totalApplied += applied
    results.push({ year, url, fetched: days.length, applied })
  }

  const lastRun = {
    ranAt: new Date().toISOString(),
    success: true,
    years,
    totalFetched,
    totalApplied,
    error: null,
  }
  await saveSettings(db, {
    ...settings,
    holidaySync: {
      ...(settings.holidaySync || {}),
      lastRun,
    },
  })

  return { syncConfig, years, totalFetched, totalApplied, results, lastRun }
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

function buildFieldValueMap(rawFields, mappedFields, profile) {
  const values = { ...(rawFields || {}) }
  if (mappedFields && typeof mappedFields === 'object') {
    for (const [key, detail] of Object.entries(mappedFields)) {
      if (detail && Object.prototype.hasOwnProperty.call(detail, 'value')) {
        values[key] = detail.value
      }
    }
  }
  if (profile && typeof profile === 'object') {
    for (const [key, value] of Object.entries(profile)) {
      if (values[key] === undefined) values[key] = value
    }
    Object.keys(PROFILE_FIELD_ALIASES).forEach((canonical) => {
      if (values[canonical] !== undefined) return
      const resolved = resolveProfileValue(profile, canonical)
      if (resolved !== undefined) values[canonical] = resolved
    })
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

function matchShiftMapping(ruleWhen, facts, fieldValues, userGroups) {
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
  if (Array.isArray(ruleWhen.fieldExists)) {
    for (const key of ruleWhen.fieldExists) {
      if (!fieldHasValue(fieldValues[key])) return false
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

function normalizeShiftOverride(payload) {
  if (!payload || typeof payload !== 'object') return null
  const workStartTime = normalizeTimeString(payload.workStartTime ?? payload.work_start_time)
  const workEndTime = normalizeTimeString(payload.workEndTime ?? payload.work_end_time)
  const timezone = typeof payload.timezone === 'string' && payload.timezone.trim()
    ? payload.timezone.trim()
    : null
  if (!workStartTime && !workEndTime && !timezone) return null
  return {
    ...(workStartTime ? { workStartTime } : {}),
    ...(workEndTime ? { workEndTime } : {}),
    ...(timezone ? { timezone } : {}),
  }
}

function resolveShiftOverrideFromMappings(shiftMappings, facts, fieldValues, userGroups) {
  if (!Array.isArray(shiftMappings)) return null
  for (const mapping of shiftMappings) {
    if (!mapping || typeof mapping !== 'object') continue
    if (!matchShiftMapping(mapping.when, facts, fieldValues, userGroups)) continue
    const payload = mapping.then ?? mapping.shift ?? mapping
    const normalized = normalizeShiftOverride(payload)
    if (normalized) return normalized
  }
  return null
}

function applyAttendancePolicies({ policies, facts, fieldValues, metrics, options }) {
  const nextMetrics = { ...metrics }
  const warnings = []
  const appliedRules = []
  const skipRules = options?.skipRules
  if (!policies || typeof policies !== 'object') {
    return { metrics: nextMetrics, warnings, appliedRules, userGroups: [] }
  }
  const userGroups = resolveUserGroups(policies.userGroups, facts, fieldValues)
  const rules = Array.isArray(policies.rules) ? policies.rules : []
  const shouldSkip = (name) => {
    if (!skipRules) return false
    if (skipRules instanceof Set) return skipRules.has(name)
    if (Array.isArray(skipRules)) return skipRules.includes(name)
    return false
  }
  rules.forEach((rule, index) => {
    if (!rule || typeof rule !== 'object') return
    const ruleName = (typeof rule.name === 'string' && rule.name.trim()) ? rule.name.trim() : `rule-${index + 1}`
    if (shouldSkip(ruleName)) return
    if (!matchPolicyRule(rule.when, facts, fieldValues, userGroups, nextMetrics)) return
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

function normalizeHolidayPolicyOverrides(rawOverrides) {
  if (!Array.isArray(rawOverrides)) return []
  return rawOverrides
    .map((override) => {
      if (!override || typeof override !== 'object') return null
      const name = String(override.name ?? override.pattern ?? override.keyword ?? '').trim()
      if (!name) return null
      const matchRaw = typeof override.match === 'string'
        ? override.match.trim()
        : typeof override.matchType === 'string'
          ? override.matchType.trim()
          : 'contains'
      const match = ['contains', 'regex', 'equals'].includes(matchRaw) ? matchRaw : 'contains'
      const attendanceGroups = ensureStringArray(
        override.attendanceGroups ?? override.attendance_group ?? override.attendanceGroup
      )
      const roles = ensureStringArray(override.roles ?? override.role ?? override.position ?? override.jobTitle)
      const roleTags = ensureStringArray(override.roleTags ?? override.role_tags ?? override.tags)
      const userIds = ensureStringArray(override.userIds ?? override.userId ?? override.user_id)
      const userNames = ensureStringArray(override.userNames ?? override.userName ?? override.user_name ?? override.names)
      const excludeUserIds = ensureStringArray(override.excludeUserIds ?? override.excludeUserId ?? override.exclude_user_ids)
      const excludeUserNames = ensureStringArray(override.excludeUserNames ?? override.excludeUserName ?? override.exclude_user_names)
      const dayIndexStart = parseNumber(override.dayIndexStart ?? override.day_index_start, null)
      const dayIndexEnd = parseNumber(override.dayIndexEnd ?? override.day_index_end, null)
      const dayIndexList = ensureNumberArray(override.dayIndexList ?? override.day_index_list ?? override.dayIndexRange)
      const baseHours = parseNumber(override.firstDayBaseHours, null)
      const overtimeSourceRaw = typeof override.overtimeSource === 'string' ? override.overtimeSource.trim() : ''
      const overtimeSource = ['approval', 'clock', 'both'].includes(overtimeSourceRaw) ? overtimeSourceRaw : null
      return {
        name,
        match,
        attendanceGroups: attendanceGroups.length ? attendanceGroups : undefined,
        roles: roles.length ? roles : undefined,
        roleTags: roleTags.length ? roleTags : undefined,
        userIds: userIds.length ? userIds : undefined,
        userNames: userNames.length ? userNames : undefined,
        excludeUserIds: excludeUserIds.length ? excludeUserIds : undefined,
        excludeUserNames: excludeUserNames.length ? excludeUserNames : undefined,
        dayIndexStart: Number.isFinite(dayIndexStart) ? Math.max(1, dayIndexStart) : undefined,
        dayIndexEnd: Number.isFinite(dayIndexEnd) ? Math.max(1, dayIndexEnd) : undefined,
        dayIndexList: dayIndexList.length ? dayIndexList.map((item) => Math.max(1, item)) : undefined,
        firstDayEnabled: typeof override.firstDayEnabled === 'boolean' ? override.firstDayEnabled : undefined,
        firstDayBaseHours: Number.isFinite(baseHours) ? Math.max(0, baseHours) : undefined,
        overtimeAdds: typeof override.overtimeAdds === 'boolean' ? override.overtimeAdds : undefined,
        overtimeSource: overtimeSource ?? undefined,
      }
    })
    .filter(Boolean)
}

function normalizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
  const autoAbsence = raw.autoAbsence ?? {}
  const holidayPolicy = raw.holidayPolicy ?? {}
  const holidaySync = raw.holidaySync ?? {}
  const holidaySyncAuto = holidaySync.auto ?? {}
  const holidaySyncLastRun = holidaySync.lastRun ?? null
  const ipAllowlist = Array.isArray(raw.ipAllowlist) ? raw.ipAllowlist.filter(Boolean) : []
  const geoFence = raw.geoFence && typeof raw.geoFence === 'object' ? raw.geoFence : null
  const overtimeSourceRaw = typeof holidayPolicy.overtimeSource === 'string'
    ? holidayPolicy.overtimeSource.trim()
    : ''
  const overtimeSource = ['approval', 'clock', 'both'].includes(overtimeSourceRaw)
    ? overtimeSourceRaw
    : DEFAULT_SETTINGS.holidayPolicy.overtimeSource
  const holidaySyncBaseUrl = typeof holidaySync.baseUrl === 'string' && holidaySync.baseUrl.trim()
    ? holidaySync.baseUrl.trim()
    : DEFAULT_SETTINGS.holidaySync.baseUrl
  const holidaySyncYears = Array.isArray(holidaySync.years)
    ? holidaySync.years.map((year) => parseNumber(year, null)).filter((year) => Number.isFinite(year))
    : []
  const holidaySyncDayIndexHolidays = Array.isArray(holidaySync.dayIndexHolidays)
    ? holidaySync.dayIndexHolidays.map((name) => String(name).trim()).filter(Boolean)
    : [...DEFAULT_SETTINGS.holidaySync.dayIndexHolidays]
  const holidaySyncDayIndexMaxDays = Math.max(
    1,
    parseNumber(holidaySync.dayIndexMaxDays, DEFAULT_SETTINGS.holidaySync.dayIndexMaxDays)
  )
  const holidaySyncDayIndexFormatRaw = typeof holidaySync.dayIndexFormat === 'string'
    ? holidaySync.dayIndexFormat.trim()
    : ''
  const holidaySyncDayIndexFormat = ['name-1', 'name第1天', 'name DAY1'].includes(holidaySyncDayIndexFormatRaw)
    ? holidaySyncDayIndexFormatRaw
    : DEFAULT_SETTINGS.holidaySync.dayIndexFormat
  const holidaySyncAutoRunAt = typeof holidaySyncAuto.runAt === 'string' && holidaySyncAuto.runAt.trim().length > 0
    ? holidaySyncAuto.runAt
    : DEFAULT_SETTINGS.holidaySync.auto.runAt
  const holidaySyncAutoTimezone = resolveTimeZone(
    holidaySyncAuto.timezone,
    DEFAULT_SETTINGS.holidaySync.auto.timezone
  )
  const holidaySyncLastRunNormalized = holidaySyncLastRun && typeof holidaySyncLastRun === 'object'
    ? {
        ranAt: typeof holidaySyncLastRun.ranAt === 'string' ? holidaySyncLastRun.ranAt : null,
        success: typeof holidaySyncLastRun.success === 'boolean' ? holidaySyncLastRun.success : null,
        years: Array.isArray(holidaySyncLastRun.years)
          ? holidaySyncLastRun.years.map((year) => parseNumber(year, null)).filter((year) => Number.isFinite(year))
          : null,
        totalFetched: Number.isFinite(holidaySyncLastRun.totalFetched)
          ? Number(holidaySyncLastRun.totalFetched)
          : null,
        totalApplied: Number.isFinite(holidaySyncLastRun.totalApplied)
          ? Number(holidaySyncLastRun.totalApplied)
          : null,
        error: typeof holidaySyncLastRun.error === 'string' ? holidaySyncLastRun.error : null,
      }
    : null
  const holidayPolicyOverrides = normalizeHolidayPolicyOverrides(holidayPolicy.overrides)
  return {
    autoAbsence: {
      enabled: parseBoolean(autoAbsence.enabled, DEFAULT_SETTINGS.autoAbsence.enabled),
      runAt: typeof autoAbsence.runAt === 'string' && autoAbsence.runAt.trim().length > 0
        ? autoAbsence.runAt
        : DEFAULT_SETTINGS.autoAbsence.runAt,
      lookbackDays: Math.max(1, parseNumber(autoAbsence.lookbackDays, DEFAULT_SETTINGS.autoAbsence.lookbackDays)),
    },
    holidayPolicy: {
      firstDayEnabled: parseBoolean(holidayPolicy.firstDayEnabled, DEFAULT_SETTINGS.holidayPolicy.firstDayEnabled),
      firstDayBaseHours: Math.max(0, parseNumber(holidayPolicy.firstDayBaseHours, DEFAULT_SETTINGS.holidayPolicy.firstDayBaseHours)),
      overtimeAdds: parseBoolean(holidayPolicy.overtimeAdds, DEFAULT_SETTINGS.holidayPolicy.overtimeAdds),
      overtimeSource,
      overrides: holidayPolicyOverrides,
    },
    holidaySync: {
      source: 'holiday-cn',
      baseUrl: holidaySyncBaseUrl,
      years: holidaySyncYears,
      addDayIndex: parseBoolean(holidaySync.addDayIndex, DEFAULT_SETTINGS.holidaySync.addDayIndex),
      dayIndexHolidays: holidaySyncDayIndexHolidays,
      dayIndexMaxDays: holidaySyncDayIndexMaxDays,
      dayIndexFormat: holidaySyncDayIndexFormat,
      overwrite: parseBoolean(holidaySync.overwrite, DEFAULT_SETTINGS.holidaySync.overwrite),
      auto: {
        enabled: parseBoolean(holidaySyncAuto.enabled, DEFAULT_SETTINGS.holidaySync.auto.enabled),
        runAt: holidaySyncAutoRunAt,
        timezone: holidaySyncAutoTimezone,
      },
      lastRun: holidaySyncLastRunNormalized,
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
    holidayPolicy: {
      ...(base?.holidayPolicy || {}),
      ...(update?.holidayPolicy || {}),
    },
    holidaySync: {
      ...(base?.holidaySync || {}),
      ...(update?.holidaySync || {}),
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

function normalizeTemplateLibrary(raw) {
  const templates = Array.isArray(raw?.templates)
    ? raw.templates
    : Array.isArray(raw)
      ? raw
      : []
  return templates
    .filter((template) => template && typeof template === 'object')
    .map((template) => {
      const name = String(template.name ?? '').trim()
      if (!name) return null
      return {
        ...template,
        name,
        category: 'custom',
        editable: true,
      }
    })
    .filter(Boolean)
    .filter((template) => !SYSTEM_TEMPLATE_NAMES.has(template.name))
}

function mapTemplateLibraryRow(row) {
  const template = normalizeMetadata(row.template)
  const name = String(row.name ?? template?.name ?? '').trim()
  if (!name) return null
  return {
    ...(template || {}),
    name,
    description: row.description ?? template?.description,
    category: 'custom',
    editable: true,
  }
}

function mapTemplateLibraryVersionRow(row) {
  if (!row) return null
  const version = Number(row.version ?? 0)
  if (!Number.isFinite(version) || version <= 0) return null
  const itemCount = Number(row.item_count ?? row.itemCount ?? 0)
  return {
    id: row.id,
    version,
    createdAt: row.created_at ?? row.createdAt ?? null,
    createdBy: row.created_by ?? row.createdBy ?? null,
    sourceVersionId: row.source_version_id ?? row.sourceVersionId ?? null,
    itemCount: Number.isFinite(itemCount) ? itemCount : 0,
  }
}

async function loadLegacyTemplateLibrary(db) {
  try {
    const rows = await db.query('SELECT value FROM system_configs WHERE key = $1', [TEMPLATE_LIBRARY_KEY])
    if (!rows.length) return []
    const raw = JSON.parse(rows[0].value)
    const normalized = normalizeTemplateLibrary(raw)
    const validated = validateEngineConfig({ templates: normalized })
    return Array.isArray(validated?.templates) ? validated.templates : []
  } catch (error) {
    if (isDatabaseSchemaError(error)) return []
    return []
  }
}

async function loadTemplateLibrary(db, orgId) {
  try {
    const rows = await db.query(
      `SELECT * FROM attendance_rule_template_library
       WHERE org_id = $1
       ORDER BY created_at DESC`,
      [orgId]
    )
    if (rows.length) {
      return rows.map(mapTemplateLibraryRow).filter(Boolean)
    }
    const legacy = await loadLegacyTemplateLibrary(db)
    if (legacy.length) {
      try {
        await saveTemplateLibrary(db, orgId, legacy)
      } catch {
        return legacy
      }
      return legacy
    }
    return []
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return loadLegacyTemplateLibrary(db)
    }
    return []
  }
}

function getTemplateLibraryCache(orgId) {
  const entry = templateLibraryCache.get(orgId)
  if (!entry) return null
  if (Date.now() - entry.loadedAt >= TEMPLATE_LIBRARY_CACHE_TTL_MS) return null
  return entry.value
}

function getTemplateLibraryVersionCache(orgId) {
  const entry = templateLibraryVersionCache.get(orgId)
  if (!entry) return null
  if (Date.now() - entry.loadedAt >= TEMPLATE_LIBRARY_CACHE_TTL_MS) return null
  return entry.value
}

async function getTemplateLibrary(db, orgId) {
  const cached = getTemplateLibraryCache(orgId)
  if (cached) return cached
  const next = await loadTemplateLibrary(db, orgId)
  templateLibraryCache.set(orgId, { value: next, loadedAt: Date.now() })
  return next
}

async function loadTemplateLibraryVersions(db, orgId) {
  try {
    const rows = await db.query(
      `SELECT id, org_id, version, created_at, created_by, source_version_id,
              jsonb_array_length(templates) AS item_count
       FROM attendance_rule_template_versions
       WHERE org_id = $1
       ORDER BY version DESC`,
      [orgId]
    )
    return rows.map(mapTemplateLibraryVersionRow).filter(Boolean)
  } catch (error) {
    if (isDatabaseSchemaError(error)) return []
    return []
  }
}

async function getTemplateLibraryVersions(db, orgId) {
  const cached = getTemplateLibraryVersionCache(orgId)
  if (cached) return cached
  const next = await loadTemplateLibraryVersions(db, orgId)
  templateLibraryVersionCache.set(orgId, { value: next, loadedAt: Date.now() })
  return next
}

async function getTemplateLibraryVersionPayload(db, orgId, versionId, versionNumber) {
  try {
    let rows = []
    if (versionId) {
      rows = await db.query(
        `SELECT * FROM attendance_rule_template_versions
         WHERE org_id = $1 AND id = $2
         LIMIT 1`,
        [orgId, versionId]
      )
    }
    if (!rows.length && Number.isFinite(versionNumber)) {
      rows = await db.query(
        `SELECT * FROM attendance_rule_template_versions
         WHERE org_id = $1 AND version = $2
         LIMIT 1`,
        [orgId, versionNumber]
      )
    }
    if (!rows.length) return null
    const row = rows[0]
    const templates = normalizeTemplateLibrary(row.templates ?? [])
    return { id: row.id, version: Number(row.version ?? 0), templates }
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

async function saveTemplateLibrary(db, orgId, templates, userId = null, sourceVersionId = null) {
  const normalized = normalizeTemplateLibrary(templates)
  const validated = validateEngineConfig({ templates: normalized })
  const stored = Array.isArray(validated?.templates) ? validated.templates : []
  await db.transaction(async (trx) => {
    await trx.query(
      'DELETE FROM attendance_rule_template_library WHERE org_id = $1',
      [orgId]
    )
    for (const template of stored) {
      await trx.query(
        `INSERT INTO attendance_rule_template_library
         (id, org_id, name, description, template, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, now(), now())`,
        [
          randomUUID(),
          orgId,
          template.name,
          template.description ?? null,
          JSON.stringify(template),
        ]
      )
    }
    try {
      const versionRows = await trx.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM attendance_rule_template_versions
         WHERE org_id = $1`,
        [orgId]
      )
      const nextVersion = Number(versionRows[0]?.next_version ?? 1)
      await trx.query(
        `INSERT INTO attendance_rule_template_versions
         (id, org_id, version, templates, created_at, created_by, source_version_id)
         VALUES ($1, $2, $3, $4::jsonb, now(), $5, $6)`,
        [
          randomUUID(),
          orgId,
          nextVersion,
          JSON.stringify(stored),
          userId,
          sourceVersionId,
        ]
      )
    } catch (error) {
      if (!isDatabaseSchemaError(error)) throw error
    }
  })
  templateLibraryCache.set(orgId, { value: stored, loadedAt: Date.now() })
  templateLibraryVersionCache.delete(orgId)
  return stored
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

async function loadHolidayMapByDates(db, orgId, workDates) {
  const targetOrg = orgId || DEFAULT_ORG_ID
  if (!Array.isArray(workDates) || workDates.length === 0) return new Map()
  try {
    const rows = await db.query(
      `SELECT id, org_id, holiday_date, name, is_working_day
       FROM attendance_holidays
       WHERE org_id = $1 AND holiday_date = ANY($2::date[])`,
      [targetOrg, workDates]
    )
    const map = new Map()
    for (const row of rows) {
      const holiday = mapHolidayRow(row)
      if (holiday?.date) map.set(holiday.date, holiday)
    }
    return map
  } catch (error) {
    if (isDatabaseSchemaError(error)) return new Map()
    throw error
  }
}

async function loadShiftAssignmentMapForUsersRange(db, orgId, userIds, fromDate, toDate) {
  const targetOrg = orgId || DEFAULT_ORG_ID
  if (!Array.isArray(userIds) || userIds.length === 0) return new Map()
  if (!fromDate || !toDate) return new Map()
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
         AND a.user_id = ANY($2::text[])
         AND a.is_active = true
         AND a.start_date <= $3
         AND (a.end_date IS NULL OR a.end_date >= $4)
       ORDER BY a.user_id, a.start_date DESC, a.created_at DESC`,
      [targetOrg, userIds, toDate, fromDate]
    )
    const byUser = new Map()
    for (const row of rows) {
      const userId = row.user_id
      if (!userId) continue
      if (!byUser.has(userId)) byUser.set(userId, [])
      byUser.get(userId).push({
        assignment: mapAssignmentRow(row),
        shift: mapShiftFromAssignmentRow(row),
      })
    }
    return byUser
  } catch (error) {
    if (isDatabaseSchemaError(error)) return new Map()
    throw error
  }
}

async function loadRotationAssignmentMapForUsersRange(db, orgId, userIds, fromDate, toDate) {
  const targetOrg = orgId || DEFAULT_ORG_ID
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return { assignmentsByUser: new Map(), shiftsById: new Map() }
  }
  if (!fromDate || !toDate) return { assignmentsByUser: new Map(), shiftsById: new Map() }
  try {
    const rows = await db.query(
      `SELECT a.id, a.org_id, a.user_id, a.rotation_rule_id, a.start_date, a.end_date, a.is_active,
              r.name AS rotation_name, r.timezone AS rotation_timezone, r.shift_sequence AS rotation_shift_sequence,
              r.is_active AS rotation_is_active
       FROM attendance_rotation_assignments a
       JOIN attendance_rotation_rules r ON r.id = a.rotation_rule_id
       WHERE a.org_id = $1
         AND a.user_id = ANY($2::text[])
         AND a.is_active = true
         AND r.is_active = true
         AND a.start_date <= $3
         AND (a.end_date IS NULL OR a.end_date >= $4)
       ORDER BY a.user_id, a.start_date DESC, a.created_at DESC`,
      [targetOrg, userIds, toDate, fromDate]
    )
    const assignmentsByUser = new Map()
    const shiftIdSet = new Set()
    for (const row of rows) {
      const userId = row.user_id
      if (!userId) continue
      const rotation = mapRotationRuleFromAssignmentRow(row)
      const assignment = mapRotationAssignmentRow(row)
      if (!assignmentsByUser.has(userId)) assignmentsByUser.set(userId, [])
      assignmentsByUser.get(userId).push({ assignment, rotation })
      for (const shiftId of rotation.shiftSequence) {
        if (shiftId) shiftIdSet.add(shiftId)
      }
    }

    const shiftsById = new Map()
    const uuidLike = (value) =>
      typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    const shiftIds = Array.from(shiftIdSet).filter(uuidLike)
    if (shiftIds.length) {
      const shiftRows = await db.query(
        'SELECT * FROM attendance_shifts WHERE id = ANY($1::uuid[]) AND org_id = $2',
        [shiftIds, targetOrg]
      )
      for (const row of shiftRows) {
        const shift = mapShiftRow(row)
        if (shift?.id) shiftsById.set(shift.id, shift)
      }
    }

    return { assignmentsByUser, shiftsById }
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return { assignmentsByUser: new Map(), shiftsById: new Map() }
    }
    throw error
  }
}

function resolveShiftAssignmentFromPrefetch(entries, workDate) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  for (const entry of entries) {
    const startDate = entry?.assignment?.startDate
    const endDate = entry?.assignment?.endDate
    if (!startDate) continue
    if (startDate <= workDate && (!endDate || endDate >= workDate)) return entry
  }
  return null
}

function resolveRotationInfoFromPrefetch(entries, workDate, shiftsById) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  for (const entry of entries) {
    const assignment = entry?.assignment
    const rotation = entry?.rotation
    const startDate = assignment?.startDate
    const endDate = assignment?.endDate
    if (!assignment || !rotation || !startDate) continue
    if (!(startDate <= workDate && (!endDate || endDate >= workDate))) continue
    if (!rotation.shiftSequence.length) return null
    const offset = diffDays(startDate, workDate)
    if (offset < 0) return null
    const index = offset % rotation.shiftSequence.length
    const shiftId = rotation.shiftSequence[index]
    if (!shiftId) return null
    const shift = shiftsById?.get(shiftId) ?? null
    if (!shift) return null
    return { assignment, rotation, shift }
  }
  return null
}

function resolveWorkContextFromPrefetch(options) {
  const { orgId, userId, workDate, defaultRule, prefetched } = options
  if (!prefetched || !workDate) return null

  const holiday = prefetched.holidaysByDate?.get(workDate) ?? null
  const rotationInfo = userId
    ? resolveRotationInfoFromPrefetch(prefetched.rotationAssignmentsByUser?.get(userId), workDate, prefetched.rotationShiftsById)
    : null
  const assignmentInfo = userId
    ? resolveShiftAssignmentFromPrefetch(prefetched.shiftAssignmentsByUser?.get(userId), workDate)
    : null
  const profile = rotationInfo?.shift ?? assignmentInfo?.shift ?? defaultRule
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
    sourceBatchId,
    existingRow,
    client,
  } = options

  // Allow callers to prefetch + lock rows in bulk (performance) while keeping
  // this helper backwards compatible.
  const existing = existingRow
    ? [existingRow]
    : await client.query(
        'SELECT * FROM attendance_records WHERE user_id = $1 AND work_date = $2 AND org_id = $3 FOR UPDATE',
        [userId, workDate, orgId]
      )

  const values = computeAttendanceRecordUpsertValues({
    existingRow: existing[0] ?? null,
    updateFirstInAt,
    updateLastOutAt,
    mode,
    statusOverride,
    overrideMetrics,
    isWorkday,
    meta,
    sourceBatchId,
    rule,
    leaveMinutes,
    overtimeMinutes,
  })

  const updated = await client.query(
    `INSERT INTO attendance_records
      (user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, source_batch_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
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
       source_batch_id = EXCLUDED.source_batch_id,
       updated_at = now()
     RETURNING *`,
    [
      userId,
      orgId,
      workDate,
      timezone,
      values.firstInAt,
      values.lastOutAt,
      values.workMinutes,
      values.lateMinutes,
      values.earlyLeaveMinutes,
      values.status,
      values.isWorkday,
      values.metaJson,
      values.sourceBatchId,
    ]
  )

  return updated[0]
}

function computeAttendanceRecordUpsertValues(options) {
  const {
    existingRow,
    updateFirstInAt,
    updateLastOutAt,
    mode,
    statusOverride,
    overrideMetrics,
    isWorkday,
    meta,
    sourceBatchId,
    rule,
    leaveMinutes,
    overtimeMinutes,
  } = options

  let firstInAt = existingRow?.first_in_at ?? null
  let lastOutAt = existingRow?.last_out_at ?? null
  const existingSourceBatchId = existingRow?.source_batch_id ?? null
  const existingMeta = normalizeMetadata(existingRow?.meta)
  const finalMeta = meta && typeof meta === 'object'
    ? { ...existingMeta, ...meta }
    : existingMeta
  const finalSourceBatchId = sourceBatchId ?? existingSourceBatchId

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

  return {
    firstInAt,
    lastOutAt,
    workMinutes: finalMetrics.workMinutes,
    lateMinutes: finalMetrics.lateMinutes,
    earlyLeaveMinutes: finalMetrics.earlyLeaveMinutes,
    status,
    isWorkday: isWorkday !== false,
    metaJson: JSON.stringify(finalMeta ?? {}),
    sourceBatchId: finalSourceBatchId,
  }
}

async function batchUpsertAttendanceRecordsValues(client, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return new Map()

  const values = rows
    .map((_, idx) => {
      const base = idx * 13
      // meta is jsonb (cast explicitly).
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}::jsonb, $${base + 13}, now())`
    })
    .join(', ')

  const params = []
  for (const row of rows) {
    params.push(
      row.userId,
      row.orgId,
      row.workDate,
      row.timezone,
      row.firstInAt,
      row.lastOutAt,
      row.workMinutes,
      row.lateMinutes,
      row.earlyLeaveMinutes,
      row.status,
      row.isWorkday,
      row.metaJson,
      row.sourceBatchId,
    )
  }

  const inserted = await client.query(
    `INSERT INTO attendance_records
      (user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, source_batch_id, updated_at)
     VALUES ${values}
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
       source_batch_id = EXCLUDED.source_batch_id,
       updated_at = now()
     RETURNING id, user_id, work_date`,
    params
  )

  const map = new Map()
  for (const row of inserted) {
    if (!row?.user_id || !row?.work_date) continue
    const workDateKey = normalizeDateOnly(row.work_date) ?? String(row.work_date).slice(0, 10)
    map.set(`${row.user_id}:${workDateKey}`, row)
  }
  return map
}

async function batchUpsertAttendanceRecordsUnnest(client, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return new Map()

  const userIds = []
  const orgIds = []
  const workDates = []
  const timezones = []
  const firstInAts = []
  const lastOutAts = []
  const workMinutes = []
  const lateMinutes = []
  const earlyLeaveMinutes = []
  const statuses = []
  const isWorkdays = []
  const metaJsons = []
  const sourceBatchIds = []

  for (const row of rows) {
    userIds.push(row.userId ?? null)
    orgIds.push(row.orgId ?? null)
    workDates.push(row.workDate ?? null)
    timezones.push(row.timezone ?? null)
    firstInAts.push(row.firstInAt ?? null)
    lastOutAts.push(row.lastOutAt ?? null)
    workMinutes.push(row.workMinutes ?? 0)
    lateMinutes.push(row.lateMinutes ?? 0)
    earlyLeaveMinutes.push(row.earlyLeaveMinutes ?? 0)
    statuses.push(row.status ?? null)
    isWorkdays.push(row.isWorkday ?? true)
    metaJsons.push(row.metaJson ?? '{}')
    sourceBatchIds.push(row.sourceBatchId ?? null)
  }

  const inserted = await client.query(
    `INSERT INTO attendance_records
      (user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, source_batch_id, updated_at)
     SELECT
       t.user_id,
       t.org_id,
       t.work_date,
       t.timezone,
       t.first_in_at,
       t.last_out_at,
       t.work_minutes,
       t.late_minutes,
       t.early_leave_minutes,
       t.status,
       t.is_workday,
       t.meta_json::jsonb,
       t.source_batch_id,
       now()
     FROM unnest(
       $1::text[],
       $2::text[],
       $3::date[],
       $4::text[],
       $5::timestamptz[],
       $6::timestamptz[],
       $7::int[],
       $8::int[],
       $9::int[],
       $10::text[],
       $11::boolean[],
       $12::text[],
       $13::uuid[]
     ) AS t(
       user_id,
       org_id,
       work_date,
       timezone,
       first_in_at,
       last_out_at,
       work_minutes,
       late_minutes,
       early_leave_minutes,
       status,
       is_workday,
       meta_json,
       source_batch_id
     )
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
       source_batch_id = EXCLUDED.source_batch_id,
       updated_at = now()
     RETURNING id, user_id, work_date`,
    [
      userIds,
      orgIds,
      workDates,
      timezones,
      firstInAts,
      lastOutAts,
      workMinutes,
      lateMinutes,
      earlyLeaveMinutes,
      statuses,
      isWorkdays,
      metaJsons,
      sourceBatchIds,
    ]
  )

  const map = new Map()
  for (const row of inserted) {
    if (!row?.user_id || !row?.work_date) continue
    const workDateKey = normalizeDateOnly(row.work_date) ?? String(row.work_date).slice(0, 10)
    map.set(`${row.user_id}:${workDateKey}`, row)
  }
  return map
}

async function batchUpsertAttendanceRecords(client, rows) {
  if (ATTENDANCE_IMPORT_RECORD_UPSERT_MODE === 'values') {
    return batchUpsertAttendanceRecordsValues(client, rows)
  }
  return batchUpsertAttendanceRecordsUnnest(client, rows)
}

async function batchInsertAttendanceImportItems(client, { batchId, orgId, items }) {
  if (!Array.isArray(items) || items.length === 0) return

  if (ATTENDANCE_IMPORT_ITEMS_INSERT_MODE === 'values') {
    const values = items
      .map((_, idx) => {
        const base = idx * 7
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, now())`
      })
      .join(', ')
    const params = []
    for (const item of items) {
      params.push(item.id, batchId, orgId, item.userId, item.workDate, item.recordId, item.previewSnapshot)
    }
    await client.query(
      `INSERT INTO attendance_import_items
       (id, batch_id, org_id, user_id, work_date, record_id, preview_snapshot, created_at)
       VALUES ${values}`,
      params
    )
    return
  }

  const ids = []
  const userIds = []
  const workDates = []
  const recordIds = []
  const snapshots = []

  for (const item of items) {
    ids.push(item.id ?? null)
    userIds.push(item.userId ?? null)
    workDates.push(item.workDate ?? null)
    recordIds.push(item.recordId ?? null)
    snapshots.push(item.previewSnapshot ?? '{}')
  }

  await client.query(
    `INSERT INTO attendance_import_items
     (id, batch_id, org_id, user_id, work_date, record_id, preview_snapshot, created_at)
     SELECT
       t.id,
       $6::uuid,
       $7::text,
       t.user_id,
       t.work_date,
       t.record_id,
       t.preview_snapshot::jsonb,
       now()
     FROM unnest(
       $1::uuid[],
       $2::text[],
       $3::date[],
       $4::uuid[],
       $5::text[]
     ) AS t(
       id,
       user_id,
       work_date,
       record_id,
       preview_snapshot
     )`,
    [ids, userIds, workDates, recordIds, snapshots, batchId, orgId]
  )
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

function clearHolidaySyncSchedule() {
  if (autoHolidaySyncTimeout) {
    clearTimeout(autoHolidaySyncTimeout)
    autoHolidaySyncTimeout = null
  }
  if (autoHolidaySyncInterval) {
    clearInterval(autoHolidaySyncInterval)
    autoHolidaySyncInterval = null
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

function scheduleHolidaySync({ db, logger, emit }) {
  clearHolidaySyncSchedule()
  const settings = settingsCache.value
  const auto = settings.holidaySync?.auto
  if (!auto?.enabled) return

  const [hourStr, minuteStr] = String(auto.runAt || '').split(':')
  const hours = Math.min(23, Math.max(0, parseInt(hourStr, 10)))
  const minutes = Math.min(59, Math.max(0, parseInt(minuteStr ?? '0', 10)))
  const timeZone = resolveTimeZone(auto.timezone, DEFAULT_SETTINGS.holidaySync.auto.timezone)
  const now = new Date()
  const nextTimestamp = computeNextRunTime({
    now,
    timeZone,
    hour: hours,
    minute: minutes,
  })
  const delay = Math.max(0, nextTimestamp - now.getTime())

  const run = async () => {
    try {
      const orgRows = await db.query('SELECT DISTINCT org_id FROM attendance_rules')
      const orgIds = orgRows.length > 0
        ? orgRows.map(row => row.org_id || DEFAULT_ORG_ID)
        : [DEFAULT_ORG_ID]
      for (const orgId of orgIds) {
        const result = await performHolidaySync({
          db,
          logger,
          orgId,
          settings,
          payload: {},
        })
        emit('attendance.holiday.sync', {
          orgId,
          years: result.years,
          totalFetched: result.totalFetched,
          totalApplied: result.totalApplied,
        })
        logger.info('Auto holiday sync completed', {
          orgId,
          years: result.years,
          totalFetched: result.totalFetched,
          totalApplied: result.totalApplied,
        })
      }
    } catch (error) {
      logger.error('Auto holiday sync failed', error)
    }
  }

  autoHolidaySyncTimeout = setTimeout(async () => {
    await run()
    autoHolidaySyncInterval = setInterval(run, 24 * 60 * 60 * 1000)
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
      holidayPolicy: z.object({
        firstDayEnabled: z.boolean().optional(),
        firstDayBaseHours: z.number().min(0).optional(),
        overtimeAdds: z.boolean().optional(),
        overtimeSource: z.enum(['approval', 'clock', 'both']).optional(),
        overrides: z.array(
          z.object({
            name: z.string().min(1),
            match: z.enum(['contains', 'regex', 'equals']).optional(),
            attendanceGroups: z.array(z.string()).optional(),
            roles: z.array(z.string()).optional(),
            roleTags: z.array(z.string()).optional(),
            userIds: z.array(z.string()).optional(),
            userNames: z.array(z.string()).optional(),
            excludeUserIds: z.array(z.string()).optional(),
            excludeUserNames: z.array(z.string()).optional(),
            dayIndexStart: z.number().int().min(1).optional(),
            dayIndexEnd: z.number().int().min(1).optional(),
            dayIndexList: z.array(z.number().int().min(1)).optional(),
            firstDayEnabled: z.boolean().optional(),
            firstDayBaseHours: z.number().min(0).optional(),
            overtimeAdds: z.boolean().optional(),
            overtimeSource: z.enum(['approval', 'clock', 'both']).optional(),
          })
        ).optional(),
      }).optional(),
      holidaySync: z.object({
        source: z.enum(['holiday-cn']).optional(),
        baseUrl: z.string().optional(),
        years: z.array(z.number().int()).optional(),
        addDayIndex: z.boolean().optional(),
        dayIndexHolidays: z.array(z.string()).optional(),
        dayIndexMaxDays: z.number().int().min(1).optional(),
        dayIndexFormat: z.enum(['name-1', 'name第1天', 'name DAY1']).optional(),
        overwrite: z.boolean().optional(),
        auto: z.object({
          enabled: z.boolean().optional(),
          runAt: z.string().optional(),
          timezone: z.string().optional(),
        }).optional(),
        lastRun: z.object({
          ranAt: z.string().optional(),
          success: z.boolean().optional(),
          years: z.array(z.number().int()).optional(),
          totalFetched: z.number().optional(),
          totalApplied: z.number().optional(),
          error: z.string().optional(),
        }).optional(),
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
    const holidaySyncSchema = z.object({
      source: z.enum(['holiday-cn']).optional(),
      baseUrl: z.string().optional(),
      years: z.array(z.number().int()).optional(),
      addDayIndex: z.boolean().optional(),
      dayIndexHolidays: z.array(z.string()).optional(),
      dayIndexMaxDays: z.number().int().min(1).optional(),
      dayIndexFormat: z.enum(['name-1', 'name第1天', 'name DAY1']).optional(),
      overwrite: z.boolean().optional(),
    })

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
        shiftMappings: z.array(
          z.object({
            name: z.string().optional(),
            when: z.object({
              userIds: z.array(z.string().min(1)).optional(),
              userGroup: z.string().optional(),
              shiftNames: z.array(z.string()).optional(),
              isHoliday: z.boolean().optional(),
              isWorkingDay: z.boolean().optional(),
              fieldEquals: z.record(z.unknown()).optional(),
              fieldIn: z.record(z.array(z.unknown())).optional(),
              fieldContains: z.record(z.string()).optional(),
              fieldExists: z.array(z.string()).optional(),
              fieldNumberGte: z.record(z.number()).optional(),
              fieldNumberLte: z.record(z.number()).optional(),
            }).optional(),
            then: z.object({
              workStartTime: z.string().optional(),
              workEndTime: z.string().optional(),
              work_start_time: z.string().optional(),
              work_end_time: z.string().optional(),
              timezone: z.string().optional(),
            }).optional(),
            shift: z.object({
              workStartTime: z.string().optional(),
              workEndTime: z.string().optional(),
              work_start_time: z.string().optional(),
              work_end_time: z.string().optional(),
              timezone: z.string().optional(),
            }).optional(),
          }).catchall(z.unknown())
        ).optional(),
      }).optional(),
    }).catchall(z.unknown())

    const templateLibrarySchema = z
      .object({
        templates: z.array(z.record(z.unknown())).optional(),
        library: z.array(z.record(z.unknown())).optional(),
      })
      .catchall(z.unknown())

    const templateLibraryRestoreSchema = z
      .object({
        versionId: z.string().optional(),
        version: z.coerce.number().optional(),
      })
      .catchall(z.unknown())

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
	      source: z.enum(['dingtalk', 'manual', 'dingtalk_csv', 'dingtalk_api', 'csv']).optional(),
	      orgId: z.string().optional(),
	      userId: z.string().optional(),
	      idempotencyKey: z.string().trim().min(1).max(128).optional(),
	      // Large imports can overwhelm the UI/response size. These optional flags allow clients to
	      // request a truncated preview/response while keeping server-side validation/commit intact.
	      previewLimit: z.number().int().positive().max(1000).optional(),
	      returnItems: z.boolean().optional(),
	      itemsLimit: z.number().int().positive().max(1000).optional(),
	      timezone: z.string().optional(),
	      ruleSetId: z.string().uuid().optional(),
	      engine: z.record(z.unknown()).optional(),
	      userMap: z.record(z.unknown()).optional(),
      userMapKeyField: z.string().optional(),
      userMapSourceFields: z.array(z.string()).optional(),
      mappingProfileId: z.string().optional(),
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
      groupSync: z.object({
        autoCreate: z.boolean().optional(),
        autoAssignMembers: z.boolean().optional(),
        ruleSetId: z.string().uuid().optional(),
        timezone: z.string().optional(),
      }).optional(),
      commitToken: z.string().optional(),
      batchMeta: z.record(z.unknown()).optional(),
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
	      csvFileId: z.string().uuid().optional(),
	      csvText: z.string().optional(),
	      csvOptions: z.object({
	        delimiter: z.string().optional(),
	        headerRowIndex: z.number().int().nonnegative().optional(),
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

		    // ============================================================
		    // Import Upload Channel (raw CSV body -> server-side fileId)
		    // ============================================================

		    const ATTENDANCE_IMPORT_UPLOAD_DIR = String(
		      process.env.ATTENDANCE_IMPORT_UPLOAD_DIR || path.join(process.cwd(), 'uploads', 'attendance-import')
		    )
		    const ATTENDANCE_IMPORT_UPLOAD_MAX_BYTES = (() => {
		      const raw = Number(process.env.ATTENDANCE_IMPORT_UPLOAD_MAX_BYTES ?? '')
		      if (!Number.isFinite(raw) || raw <= 0) return 120 * 1024 * 1024 // 120MB
		      return Math.max(1, Math.floor(raw))
		    })()
		    const ATTENDANCE_IMPORT_UPLOAD_TTL_MS = (() => {
		      const raw = Number(process.env.ATTENDANCE_IMPORT_UPLOAD_TTL_MS ?? '')
		      if (!Number.isFinite(raw) || raw <= 0) return 24 * 60 * 60 * 1000 // 24h
		      return Math.max(1, Math.floor(raw))
		    })()

		    const sanitizeImportUploadOrgId = (orgId) => {
		      const raw = typeof orgId === 'string' && orgId.trim() ? orgId.trim() : DEFAULT_ORG_ID
		      const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
		      return safe || DEFAULT_ORG_ID
		    }

		    const getImportUploadPaths = ({ orgId, fileId }) => {
		      const safeOrgId = sanitizeImportUploadOrgId(orgId)
		      const dir = path.join(ATTENDANCE_IMPORT_UPLOAD_DIR, safeOrgId)
		      return {
		        dir,
		        csvPath: path.join(dir, `${fileId}.csv`),
		        metaPath: path.join(dir, `${fileId}.json`),
		      }
		    }

		    const isUuidLike = (value) => {
		      if (typeof value !== 'string') return false
		      const text = value.trim()
		      if (!text) return false
		      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
		    }

		    class ImportUploadMeter extends Transform {
		      constructor(maxBytes) {
		        super()
		        this.maxBytes = maxBytes
		        this.bytes = 0
		        this.newlines = 0
		        this.lastByte = null
		      }

		      _transform(chunk, _enc, cb) {
		        try {
		          if (!chunk || chunk.length === 0) {
		            cb(null, chunk)
		            return
		          }
		          this.bytes += chunk.length
		          if (this.bytes > this.maxBytes) {
		            cb(new HttpError(413, 'PAYLOAD_TOO_LARGE', `Upload exceeds ${this.maxBytes} bytes`))
		            return
		          }
		          for (let i = 0; i < chunk.length; i++) {
		            if (chunk[i] === 10) this.newlines += 1
		          }
		          this.lastByte = chunk[chunk.length - 1]
		          cb(null, chunk)
		        } catch (error) {
		          cb(error)
		        }
		      }
		    }

		    const loadImportUploadMeta = async ({ orgId, fileId }) => {
		      if (!isUuidLike(fileId)) return null
		      const paths = getImportUploadPaths({ orgId, fileId })
		      try {
		        const raw = await fsp.readFile(paths.metaPath, 'utf8')
		        const parsed = raw ? JSON.parse(raw) : null
		        if (!parsed || typeof parsed !== 'object') return null
		        return parsed
		      } catch {
		        return null
		      }
		    }

		    const isImportUploadExpired = (meta) => {
		      const createdAt = meta?.createdAt ? Date.parse(String(meta.createdAt)) : NaN
		      if (!Number.isFinite(createdAt)) return false
		      return Date.now() - createdAt > ATTENDANCE_IMPORT_UPLOAD_TTL_MS
		    }

		    const readImportUploadCsvText = async ({ orgId, fileId }) => {
		      if (!isUuidLike(fileId)) {
		        throw new HttpError(400, 'VALIDATION_ERROR', 'csvFileId must be a UUID')
		      }
		      const meta = await loadImportUploadMeta({ orgId, fileId })
		      if (!meta) {
		        throw new HttpError(404, 'NOT_FOUND', 'Import upload not found')
		      }
		      if (isImportUploadExpired(meta)) {
		        throw new HttpError(410, 'EXPIRED', 'Import upload expired')
		      }
		      const paths = getImportUploadPaths({ orgId, fileId })
		      const csvText = await fsp.readFile(paths.csvPath, 'utf8')
		      return { csvText, meta }
		    }

		    const deleteImportUpload = async ({ orgId, fileId }) => {
		      if (!isUuidLike(fileId)) return
		      const paths = getImportUploadPaths({ orgId, fileId })
		      await Promise.allSettled([fsp.unlink(paths.csvPath), fsp.unlink(paths.metaPath)])
		    }

		    // Best-effort cleanup to avoid upload directory growth if users preview but never commit.
		    const ATTENDANCE_IMPORT_UPLOAD_CLEANUP_ENABLED = process.env.ATTENDANCE_IMPORT_UPLOAD_CLEANUP !== 'false'
		    const ATTENDANCE_IMPORT_UPLOAD_CLEANUP_INTERVAL_MS = (() => {
		      const raw = Number(process.env.ATTENDANCE_IMPORT_UPLOAD_CLEANUP_INTERVAL_MS ?? '')
		      if (!Number.isFinite(raw) || raw <= 0) return 30 * 60 * 1000 // 30m
		      return Math.max(60 * 1000, Math.floor(raw))
		    })()
		    let importUploadCleanupRunning = false

		    const cleanupExpiredImportUploads = async () => {
		      if (importUploadCleanupRunning) return
		      importUploadCleanupRunning = true
		      try {
		        const orgDirs = await fsp.readdir(ATTENDANCE_IMPORT_UPLOAD_DIR, { withFileTypes: true }).catch(() => [])
		        for (const orgDir of orgDirs) {
		          if (!orgDir.isDirectory()) continue
		          const orgIdDir = orgDir.name
		          const dirPath = path.join(ATTENDANCE_IMPORT_UPLOAD_DIR, orgIdDir)
		          const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => [])
		          for (const entry of entries) {
		            if (!entry.isFile()) continue
		            if (!entry.name.endsWith('.json')) continue
		            const fileId = entry.name.slice(0, -'.json'.length)
		            const meta = await loadImportUploadMeta({ orgId: orgIdDir, fileId })
		            if (!meta) continue
		            if (isImportUploadExpired(meta)) {
		              await deleteImportUpload({ orgId: orgIdDir, fileId })
		            }
		          }
		        }
		      } finally {
		        importUploadCleanupRunning = false
		      }
		    }

		    const scheduleImportUploadCleanup = () => {
		      if (!ATTENDANCE_IMPORT_UPLOAD_CLEANUP_ENABLED) return
		      if (importUploadCleanupInterval) return
		      cleanupExpiredImportUploads().catch((error) => {
		        logger.warn('Attendance import upload cleanup failed', error)
		      })
		      importUploadCleanupInterval = setInterval(() => {
		        cleanupExpiredImportUploads().catch((error) => {
		          logger.warn('Attendance import upload cleanup failed', error)
		        })
		      }, ATTENDANCE_IMPORT_UPLOAD_CLEANUP_INTERVAL_MS)
		    }

		    const clearImportUploadCleanup = () => {
		      if (importUploadCleanupInterval) clearInterval(importUploadCleanupInterval)
		      importUploadCleanupInterval = null
		    }

		    const resolveImportRows = async ({ payload, orgId, fallbackUserId }) => {
		      let csvWarnings = []
		      let csvFileId = null
		      if (Array.isArray(payload.rows)) return { rows: payload.rows, csvWarnings, csvFileId }
		      if (typeof payload.csvFileId === 'string' && payload.csvFileId.trim()) {
		        csvFileId = payload.csvFileId.trim()
		        const { csvText } = await readImportUploadCsvText({ orgId, fileId: csvFileId })
		        const result = buildRowsFromCsv({ csvText, csvOptions: payload.csvOptions })
		        ensureCsvRowsWithinLimit(result)
		        csvWarnings = result.warnings
		        return { rows: result.rows, csvWarnings, csvFileId }
		      }
		      if (typeof payload.csvText === 'string' && payload.csvText.length > 0) {
		        const result = buildRowsFromCsv({ csvText: payload.csvText, csvOptions: payload.csvOptions })
		        ensureCsvRowsWithinLimit(result)
		        csvWarnings = result.warnings
		        return { rows: result.rows, csvWarnings, csvFileId }
		      }
		      if (Array.isArray(payload.entries)) return { rows: buildRowsFromEntries({ entries: payload.entries }), csvWarnings, csvFileId }
		      return {
		        rows: buildRowsFromDingTalk({
		          columns: payload.columns,
		          data: payload.data,
		          userId: payload.userId ?? fallbackUserId,
		        }),
		        csvWarnings,
		        csvFileId,
		      }
		    }

		    // ============================================================
		    // Async Import Commit (large payloads)
		    // ============================================================

	    const ATTENDANCE_IMPORT_ASYNC_ENABLED = process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED !== 'false'
	    const ATTENDANCE_IMPORT_PREVIEW_ASYNC_ENABLED = process.env.ATTENDANCE_IMPORT_PREVIEW_ASYNC_ENABLED !== 'false'
	    const ATTENDANCE_IMPORT_ASYNC_QUEUE = 'attendance-import'
	    const ATTENDANCE_IMPORT_ASYNC_JOB = 'attendance-import-commit-async'
	    const ATTENDANCE_IMPORT_ASYNC_PROGRESS_MIN_INTERVAL_MS = 1000
	    const ATTENDANCE_IMPORT_PREVIEW_ASYNC_DEFAULT_LIMIT = (() => {
	      const raw = Number(process.env.ATTENDANCE_IMPORT_PREVIEW_ASYNC_DEFAULT_LIMIT ?? 300)
	      if (!Number.isFinite(raw)) return 300
	      return Math.max(1, Math.min(1000, Math.floor(raw)))
	    })()

	    const normalizePreviewAsyncLimit = (value) => {
	      const numeric = Number(value)
	      if (!Number.isFinite(numeric)) return ATTENDANCE_IMPORT_PREVIEW_ASYNC_DEFAULT_LIMIT
	      return Math.max(1, Math.min(1000, Math.floor(numeric)))
	    }

	    const toPreviewJobIdempotencyKey = (idempotencyKey) => {
	      const clean = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : ''
	      if (!clean) return ''
	      return `preview:${clean}`.slice(0, 128)
	    }

		    const sanitizeImportJobPayload = (payload) => {
		      if (!payload || typeof payload !== 'object') return {}
		      const next = { ...payload }
		      const jobType = next.__jobType === 'preview' ? 'preview' : 'commit'
		      // Never persist single-use tokens in the job payload.
		      delete next.commitToken
		      // If a server-side upload reference is present, avoid persisting duplicate CSV payloads.
		      if (typeof next.csvFileId === 'string' && next.csvFileId.trim()) {
		        delete next.csvText
		        delete next.rows
		        delete next.entries
		      }
		      if (jobType === 'preview') {
		        next.previewLimit = normalizePreviewAsyncLimit(next.previewLimit)
		        // Keep payload size bounded for durable queue storage.
		        if (Array.isArray(next.rows) && next.rows.length > 10000 && typeof next.csvText === 'string') delete next.rows
		        if (Array.isArray(next.entries) && next.entries.length > 30000 && typeof next.csvText === 'string') delete next.entries
		        return next
		      }
	      // Prefer csvText over expanded rows/entries for large jobs to avoid DB bloat.
	      if (Array.isArray(next.rows) && next.rows.length > 5000) delete next.rows
	      if (Array.isArray(next.entries) && next.entries.length > 20000) delete next.entries
	      return next
	    }

	    const resolveImportEngineByRowCount = (rowCount) => {
	      const numeric = Number(rowCount ?? 0)
	      const thresholdReached = Number.isFinite(numeric) && numeric >= ATTENDANCE_IMPORT_BULK_ENGINE_THRESHOLD
	      const supportsBulkPath = ATTENDANCE_IMPORT_RECORD_UPSERT_MODE === 'unnest'
	        && ATTENDANCE_IMPORT_ITEMS_INSERT_MODE === 'unnest'
	      if (!supportsBulkPath) return 'standard'
	      if (ATTENDANCE_IMPORT_BULK_ENGINE_MODE === 'off') return 'standard'
	      if (ATTENDANCE_IMPORT_BULK_ENGINE_MODE === 'force') return 'bulk'
	      if (thresholdReached) return 'bulk'
	      return 'standard'
	    }

	    const resolveImportChunkConfig = (engine) => {
	      if (engine === 'bulk') {
	        return {
	          itemsChunkSize: ATTENDANCE_IMPORT_BULK_ITEMS_CHUNK_SIZE,
	          recordsChunkSize: ATTENDANCE_IMPORT_BULK_RECORDS_CHUNK_SIZE,
	        }
	      }
	      return {
	        itemsChunkSize: ATTENDANCE_IMPORT_ITEMS_CHUNK_SIZE,
	        recordsChunkSize: ATTENDANCE_IMPORT_RECORDS_CHUNK_SIZE,
	      }
	    }

	    const resolveImportEngineFromMeta = (meta, rowCountHint) => {
	      const payload = normalizeMetadata(meta)
	      const explicit = typeof payload?.__importEngine === 'string' ? payload.__importEngine.trim().toLowerCase() : ''
	      if (explicit === 'bulk' || explicit === 'standard') return explicit
	      const hint = Number(rowCountHint ?? payload?.summary?.processedRows ?? payload?.rowCount ?? payload?.total ?? 0)
	      return resolveImportEngineByRowCount(Number.isFinite(hint) ? hint : 0)
	    }

	    const resolveImportChunkConfigFromMeta = (meta, engineHint) => {
	      const payload = normalizeMetadata(meta)
	      const itemsRaw = Number(payload?.summary?.chunkConfig?.itemsChunkSize ?? payload?.chunkConfig?.itemsChunkSize)
	      const recordsRaw = Number(payload?.summary?.chunkConfig?.recordsChunkSize ?? payload?.chunkConfig?.recordsChunkSize)
	      if (Number.isFinite(itemsRaw) && Number.isFinite(recordsRaw) && itemsRaw > 0 && recordsRaw > 0) {
	        return {
	          itemsChunkSize: Math.floor(itemsRaw),
	          recordsChunkSize: Math.floor(recordsRaw),
	        }
	      }
	      return resolveImportChunkConfig(engineHint)
	    }

	    const computeImportJobElapsedMs = (startedAt, finishedAt, status) => {
	      const startMs = startedAt ? Date.parse(String(startedAt)) : Number.NaN
	      if (!Number.isFinite(startMs)) return 0
	      const finishedMs = finishedAt ? Date.parse(String(finishedAt)) : Number.NaN
	      const terminal = status === 'completed' || status === 'failed'
	      const endMs = terminal && Number.isFinite(finishedMs) ? finishedMs : Date.now()
	      return Math.max(0, Math.floor(endMs - startMs))
	    }

	    const mapImportJobRow = (row) => {
	      const payload = normalizeMetadata(row.payload)
	      const kind = payload?.__jobType === 'preview' ? 'preview' : 'commit'
	      const status = normalizeImportJobStatus(row.status)
	      const progress = Number(row.progress ?? 0)
	      const total = Number(row.total ?? 0)
	      const processedRowsRaw = Number(payload?.summary?.processedRows)
	      const failedRowsRaw = Number(payload?.summary?.failedRows)
	      const processedRows = Number.isFinite(processedRowsRaw)
	        ? Math.max(0, Math.floor(processedRowsRaw))
	        : (status === 'completed' ? Math.max(0, Math.floor(total)) : Math.max(0, Math.floor(progress)))
	      const failedRows = Number.isFinite(failedRowsRaw)
	        ? Math.max(0, Math.floor(failedRowsRaw))
	        : Math.max(0, Math.floor(total) - processedRows)
	      const preview = kind === 'preview' && payload?.previewResult && typeof payload.previewResult === 'object'
	        ? payload.previewResult
	        : null
	      const rawIdempotencyKey = row.idempotency_key ?? payload?.idempotencyKey ?? null
	      const idempotencyKey = kind === 'preview'
	        && typeof rawIdempotencyKey === 'string'
	        && rawIdempotencyKey.startsWith('preview:')
	        ? rawIdempotencyKey.slice('preview:'.length)
	        : rawIdempotencyKey
	      const progressPercent = total > 0
	        ? Math.max(0, Math.min(100, Math.round((Math.max(0, progress) / total) * 100)))
	        : 0
	      const elapsedMs = computeImportJobElapsedMs(row.started_at, row.finished_at, status)
	      const throughputRowsPerSec = (() => {
	        if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
	        const rows = Math.max(0, processedRows)
	        return Number((rows / (elapsedMs / 1000)).toFixed(2))
	      })()
	      const engine = resolveImportEngineFromMeta(payload, total)
	      const chunkConfig = resolveImportChunkConfigFromMeta(payload, engine)
	      return {
	        id: row.id,
	        orgId: row.org_id ?? DEFAULT_ORG_ID,
	        batchId: row.batch_id,
	        createdBy: row.created_by,
	        idempotencyKey,
	        kind,
	        status,
	        engine,
	        chunkConfig,
	        progress,
	        total,
	        progressPercent,
	        processedRows,
	        failedRows,
	        elapsedMs,
	        throughputRowsPerSec,
	        error: row.error ?? null,
	        preview,
	        startedAt: row.started_at ?? null,
	        finishedAt: row.finished_at ?? null,
	        createdAt: row.created_at ?? null,
	        updatedAt: row.updated_at ?? null,
	      }
	    }

	    const estimateCsvRowCount = (csvText) => {
	      if (typeof csvText !== 'string' || csvText.length === 0) return 0
	      // Count '\n' without splitting to reduce memory.
	      let lines = 1
	      for (let i = 0; i < csvText.length; i++) {
	        if (csvText.charCodeAt(i) === 10) lines += 1
	      }
	      // Assume first line is header for CSV imports.
	      return Math.max(0, lines - 1)
	    }

	    const getQueueService = () => context?.services?.queue

	    const loadImportJob = async (jobId, orgId) => {
	      const rows = await db.query(
	        'SELECT * FROM attendance_import_jobs WHERE id = $1 AND org_id = $2',
	        [jobId, orgId]
	      )
	      return rows.length ? rows[0] : null
	    }

	    const loadImportJobByIdempotencyKey = async (orgId, idempotencyKey) => {
	      if (!idempotencyKey) return null
	      const rows = await db.query(
	        `SELECT * FROM attendance_import_jobs
	         WHERE org_id = $1 AND idempotency_key = $2
	         ORDER BY created_at DESC
	         LIMIT 1`,
	        [orgId, idempotencyKey]
	      )
	      return rows.length ? rows[0] : null
	    }

	    const updateImportJobProgress = async ({ jobId, orgId, status, progress, total, error, startedAt, finishedAt }) => {
	      const fields = []
	      const params = [jobId, orgId]
	      let idx = 3
	      if (status) {
	        fields.push(`status = $${idx++}`)
	        params.push(status)
	      }
	      if (progress != null) {
	        fields.push(`progress = $${idx++}`)
	        params.push(Number(progress) || 0)
	      }
	      if (total != null) {
	        fields.push(`total = $${idx++}`)
	        params.push(Number(total) || 0)
	      }
	      if (error !== undefined) {
	        fields.push(`error = $${idx++}`)
	        params.push(error ? String(error).slice(0, 2000) : null)
	      }
	      if (startedAt) fields.push(`started_at = now()`)
	      if (finishedAt) fields.push(`finished_at = now()`)
	      fields.push('updated_at = now()')

	      await db.query(
	        `UPDATE attendance_import_jobs
	         SET ${fields.join(', ')}
	         WHERE id = $1 AND org_id = $2`,
	        params
	      )
	    }

	    const enqueueImportJob = async (jobId) => {
	      const queue = getQueueService()
	      if (queue && typeof queue.add === 'function') {
	        await queue.add(
	          ATTENDANCE_IMPORT_ASYNC_QUEUE,
	          ATTENDANCE_IMPORT_ASYNC_JOB,
	          { jobId },
	          {
	            jobId,
	            attempts: 3,
	            backoff: { type: 'exponential', delay: 2000 },
	            removeOnComplete: true,
	            removeOnFail: false,
	          }
	        )
	        return
	      }

	      // Fallback: run in-process (best-effort). This keeps the API usable even if queue services
	      // are not wired in a given deployment.
	      setImmediate(() => {
	        processAsyncImportCommitJob({ jobId }).catch((error) => {
	          logger.error('Attendance async import job failed (fallback)', error)
	        })
	      })
	    }

	    const normalizeImportJobStatus = (value) => {
	      const status = typeof value === 'string' ? value.trim().toLowerCase() : ''
	      if (['queued', 'running', 'completed', 'failed', 'canceled'].includes(status)) return status
	      return 'queued'
	    }

		    const buildAsyncPreviewResult = async ({ payload, requesterId, orgId }) => {
		      const profile = findImportProfile(payload.mappingProfileId)
		      const requiredFields = profile?.requiredFields ?? []
		      const punchRequiredFields = profile?.punchRequiredFields ?? []
		      const { rows, csvWarnings } = await resolveImportRows({
		        payload,
		        orgId,
		        fallbackUserId: payload.userId ?? requesterId,
		      })
		      if (!rows.length) {
		        throw new Error('No rows to preview')
		      }

	      const previewLimit = normalizePreviewAsyncLimit(payload.previewLimit)
	      const preview = []
	      const previewStats = {
	        rowCount: rows.length,
	        invalid: 0,
	        duplicates: 0,
	      }
	      const seenKeys = new Set()

	      for (const row of rows) {
	        const shouldRender = preview.length < previewLimit
	        const workDate = row.workDate
	        const rowUserId = resolveRowUserId({
	          row,
	          fallbackUserId: payload.userId ?? requesterId,
	          userMap: payload.userMap,
	          userMapKeyField: payload.userMapKeyField,
	          userMapSourceFields: payload.userMapSourceFields,
	        })
	        const warnings = []
	        if (!rowUserId) warnings.push('Missing userId')
	        if (!workDate) warnings.push('Missing workDate')
	        if (requiredFields.length) {
	          const missingRequired = requiredFields.filter((field) => {
	            const value = resolveRequiredFieldValue(row, field)
	            return value === undefined || value === null || value === ''
	          })
	          if (missingRequired.length) warnings.push(`Missing required: ${missingRequired.join(', ')}`)
	        }
	        if (punchRequiredFields.length && shouldEnforcePunchRequired(row)) {
	          const missingPunch = punchRequiredFields.filter((field) => {
	            const value = resolveRequiredFieldValue(row, field)
	            return value === undefined || value === null || value === ''
	          })
	          if (missingPunch.length) warnings.push(`Missing required: ${missingPunch.join(', ')}`)
	        }
	        if (warnings.length) {
	          previewStats.invalid += 1
	          if (shouldRender) {
	            preview.push({
	              userId: rowUserId ?? 'unknown',
	              workDate: workDate ?? '',
	              firstInAt: null,
	              lastOutAt: null,
	              workMinutes: 0,
	              lateMinutes: 0,
	              earlyLeaveMinutes: 0,
	              leaveMinutes: 0,
	              overtimeMinutes: 0,
	              status: 'invalid',
	              isWorkday: undefined,
	              warnings,
	              appliedPolicies: [],
	              userGroups: [],
	            })
	          }
	          continue
	        }

	        const dedupKey = `${rowUserId}:${workDate}`
	        if (seenKeys.has(dedupKey)) {
	          previewStats.duplicates += 1
	          if (shouldRender) {
	            preview.push({
	              userId: rowUserId,
	              workDate,
	              firstInAt: null,
	              lastOutAt: null,
	              workMinutes: 0,
	              lateMinutes: 0,
	              earlyLeaveMinutes: 0,
	              leaveMinutes: 0,
	              overtimeMinutes: 0,
	              status: 'invalid',
	              isWorkday: undefined,
	              warnings: ['Duplicate row for same user/workDate (skipped during commit).'],
	              appliedPolicies: [],
	              userGroups: [],
	            })
	          }
	          continue
	        }
	        seenKeys.add(dedupKey)

	        if (!shouldRender) continue

	        preview.push({
	          userId: rowUserId,
	          workDate,
	          firstInAt: null,
	          lastOutAt: null,
	          workMinutes: 0,
	          lateMinutes: 0,
	          earlyLeaveMinutes: 0,
	          leaveMinutes: 0,
	          overtimeMinutes: 0,
	          status: 'normal',
	          isWorkday: undefined,
	          warnings: [],
	          appliedPolicies: [],
	          userGroups: [],
	        })
	      }

	      return {
	        items: preview,
	        total: preview.length,
	        rowCount: rows.length,
	        truncated: rows.length > previewLimit,
	        previewLimit,
	        stats: previewStats,
	        csvWarnings,
	        groupWarnings: [],
	        asyncSimplified: true,
	      }
		    }

		    const processAsyncImportPreviewJob = async ({ rowId, orgId, requesterId, payload }) => {
		      const result = await buildAsyncPreviewResult({ payload, requesterId, orgId })
		      await db.query(
		        `UPDATE attendance_import_jobs
		         SET status = 'completed',
	             progress = $3,
	             total = $4,
	             error = NULL,
	             payload = $5::jsonb,
	             finished_at = now(),
	             updated_at = now()
	         WHERE id = $1 AND org_id = $2`,
	        [
	          rowId,
	          orgId,
	          result.rowCount,
	          result.rowCount,
		          JSON.stringify({
		            __jobType: 'preview',
		            idempotencyKey: payload.idempotencyKey ?? null,
		            __importEngine: resolveImportEngineFromMeta(payload, result.rowCount),
		            previewResult: result,
		          }),
	        ]
	      )
	    }

	    const processAsyncImportCommitJob = async ({ jobId }) => {
	      const rowId = String(jobId || '').trim()
	      if (!rowId) return

	      const jobRows = await db.query('SELECT * FROM attendance_import_jobs WHERE id = $1', [rowId])
	      if (!jobRows.length) return

	      const jobRow = jobRows[0]
	      const orgId = jobRow.org_id ?? DEFAULT_ORG_ID
	      const batchId = jobRow.batch_id
	      const requesterId = jobRow.created_by
	      const payload = normalizeMetadata(jobRow.payload)
	      const isPreviewJob = payload?.__jobType === 'preview'
	      const status = normalizeImportJobStatus(jobRow.status)
	      if (status === 'completed') return

	      if (!isPreviewJob) {
	        // If the batch already exists, treat the job as complete (idempotent re-run).
	        try {
	          const batchRows = await db.query(
	            'SELECT id, status, meta FROM attendance_import_batches WHERE id = $1 AND org_id = $2',
	            [batchId, orgId]
	          )
	          if (batchRows.length && String(batchRows[0].status ?? '').toLowerCase() === 'committed') {
	            await updateImportJobProgress({
	              jobId: rowId,
	              orgId,
	              status: 'completed',
	              progress: jobRow.total ?? 0,
	              total: jobRow.total ?? 0,
	              error: null,
	              finishedAt: true,
	            })
	            return
	          }
	        } catch (_error) {
	          // Ignore and proceed - batch may not exist yet.
	        }
	      }

	      await updateImportJobProgress({ jobId: rowId, orgId, status: 'running', startedAt: true })
	      const idempotencyKey = typeof jobRow.idempotency_key === 'string' ? jobRow.idempotency_key : null

	      if (isPreviewJob) {
	        try {
	          await processAsyncImportPreviewJob({
	            rowId,
	            orgId,
	            requesterId,
	            payload,
	          })
	        } catch (error) {
	          const message = String(error?.message ?? error ?? 'Unknown error')
	          logger.error('Attendance async import preview failed', error)
	          await updateImportJobProgress({
	            jobId: rowId,
	            orgId,
	            status: 'failed',
	            error: message,
	            finishedAt: true,
	          })
	        }
	        return
	      }

	      let lastProgressWriteAt = 0
	      let lastProgressValue = -1
	      const onProgress = async ({ imported, total }) => {
	        const now = Date.now()
	        const nextProgress = Number(imported ?? 0)
	        const nextTotal = Number(total ?? 0)
	        if (!Number.isFinite(nextProgress) || !Number.isFinite(nextTotal)) return
	        if (nextProgress === lastProgressValue && now - lastProgressWriteAt < ATTENDANCE_IMPORT_ASYNC_PROGRESS_MIN_INTERVAL_MS) return
	        if (now - lastProgressWriteAt < ATTENDANCE_IMPORT_ASYNC_PROGRESS_MIN_INTERVAL_MS && nextProgress < lastProgressValue + 300) return

	        lastProgressWriteAt = now
	        lastProgressValue = nextProgress
	        await updateImportJobProgress({
	          jobId: rowId,
	          orgId,
	          progress: nextProgress,
	          total: nextTotal,
	        })
	      }

	      try {
	        const commitResult = await commitAttendanceImportPayload({
	          payload,
	          orgId,
	          requesterId,
	          batchId,
	          idempotencyKey,
	          onProgress,
	        })

	        await updateImportJobProgress({
	          jobId: rowId,
	          orgId,
	          status: 'completed',
	          progress: commitResult.imported ?? 0,
	          total: commitResult.rowCount ?? 0,
	          error: null,
	          finishedAt: true,
	        })

	        // Drop large payload after completion while preserving compact progress metadata.
		        const summaryPayload = {
		          __jobType: 'commit',
		          idempotencyKey: payload.idempotencyKey ?? idempotencyKey ?? null,
		          __importEngine: commitResult.engine ?? resolveImportEngineFromMeta(payload, commitResult.rowCount ?? 0),
		          summary: {
		            processedRows: Number(commitResult.processedRows ?? commitResult.rowCount ?? 0),
		            failedRows: Math.max(0, Number(commitResult.failedRows ?? commitResult.skippedCount ?? 0)),
		            elapsedMs: Number(commitResult.elapsedMs ?? 0),
		            chunkConfig: commitResult?.meta?.chunkConfig ?? resolveImportChunkConfig(
		              commitResult.engine ?? resolveImportEngineFromMeta(payload, commitResult.rowCount ?? 0)
		            ),
		          },
		        }
	        await db.query(
	          'UPDATE attendance_import_jobs SET payload = $3::jsonb, updated_at = now() WHERE id = $1 AND org_id = $2',
	          [rowId, orgId, JSON.stringify(summaryPayload)]
	        )
	      } catch (error) {
	        const message = String(error?.message ?? error ?? 'Unknown error')
	        logger.error('Attendance async import commit failed', error)
	        await updateImportJobProgress({
	          jobId: rowId,
	          orgId,
	          status: 'failed',
	          error: message,
	          finishedAt: true,
	        })
	      }
	    }

	    // Shared background commit implementation. Intentionally mirrors the sync commit logic but:
	    // - uses a stable batchId (job.batch_id)
	    // - does NOT consume commit tokens (token is consumed when the job is enqueued)
	    const commitAttendanceImportPayload = async ({ payload, orgId, requesterId, batchId, idempotencyKey, onProgress }) => {
	      const cleanIdempotency = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : ''
	      const commitStartedAtMs = Date.now()
	      if (cleanIdempotency) {
	        const existing = await loadIdempotentImportBatch(db, orgId, cleanIdempotency)
	        if (existing) {
	          const existingRowCount = existing.imported + existing.skipped
	          return {
	            batchId: existing.batchId,
	            imported: existing.imported,
	            rowCount: existingRowCount,
	            processedRows: existing.imported,
	            failedRows: existing.skipped,
	            elapsedMs: 0,
	            skippedCount: existing.skipped,
	            engine: resolveImportEngineFromMeta(existing.meta, existingRowCount),
	            meta: existing.meta,
	            idempotent: true,
	          }
	        }
	      }

	      let ruleSetConfig = null
	      if (payload.ruleSetId) {
	        const rows = await db.query(
	          'SELECT config FROM attendance_rule_sets WHERE id = $1 AND org_id = $2',
	          [payload.ruleSetId, orgId]
	        )
	        if (rows.length) ruleSetConfig = normalizeMetadata(rows[0].config)
	      }

	      const profile = findImportProfile(payload.mappingProfileId)
	      const profileMapping = profile?.mapping?.columns ?? profile?.mapping?.fields ?? []
	      const mapping = payload.mapping?.columns
	        ?? payload.mapping?.fields
	        ?? (profileMapping.length ? profileMapping : undefined)
	        ?? ruleSetConfig?.mappings?.columns
	        ?? ruleSetConfig?.mappings?.fields
	        ?? []
	      const requiredFields = profile?.requiredFields ?? []
	      const punchRequiredFields = profile?.punchRequiredFields ?? []

		      const { rows, csvWarnings, csvFileId } = await resolveImportRows({
		        payload,
		        orgId,
		        fallbackUserId: payload.userId ?? requesterId,
		      })

	      if (rows.length === 0) {
	        throw new Error('No rows to import')
	      }
	      const importEngine = resolveImportEngineByRowCount(rows.length)
	      const importChunkConfig = resolveImportChunkConfig(importEngine)

	      const baseRule = await loadDefaultRule(db, orgId)
	      const settings = await getSettings(db)
	      const groupRuleSetMap = payload.ruleSetId ? new Map() : await loadAttendanceGroupRuleSetMap(db, orgId)
	      const groupSync = normalizeGroupSyncOptions(payload.groupSync, payload.ruleSetId, payload.timezone)
	      const groupNames = groupSync ? collectAttendanceGroupNames(rows) : new Map()
	      const groupWarnings = []
	      if (groupNames.size && !groupSync?.autoCreate) {
	        const groupIdMap = await loadAttendanceGroupIdMap(db, orgId)
	        for (const [key, name] of groupNames.entries()) {
	          if (!groupIdMap.has(key)) groupWarnings.push(`Attendance group not found: ${name}`)
	        }
	      }
	      if (groupSync?.ruleSetId && !payload.ruleSetId && groupNames.size) {
	        for (const key of groupNames.keys()) {
	          if (!groupRuleSetMap.has(key)) groupRuleSetMap.set(key, groupSync.ruleSetId)
	        }
	      }
	      const ruleSetConfigCache = new Map()
	      if (payload.ruleSetId && ruleSetConfig) {
	        ruleSetConfigCache.set(payload.ruleSetId, ruleSetConfig)
	      }
	      const engineCache = new Map()
	      let payloadEngine = null
	      if (payload.engine) {
	        try {
	          payloadEngine = createRuleEngine({ config: payload.engine, logger })
	        } catch (error) {
	          logger.warn('Attendance rule engine config invalid (commit payload)', error)
	        }
	      }

	      const statusMap = payload.statusMap ?? {}
	      const returnItems = payload.returnItems !== false
	      const itemsLimit = returnItems && typeof payload.itemsLimit === 'number' ? payload.itemsLimit : null
	      const results = []
	      let importedCount = 0
	      const skipped = []
	      const idempotencyEnabled = Boolean(cleanIdempotency) && await hasImportBatchIdempotencyColumn(db)
	      const resolvedBatchId = batchId || randomUUID()
	      let batchMeta = null
	      let idempotentInTransaction = null

	      await db.transaction(async (trx) => {
	        if (cleanIdempotency) {
	          await acquireImportIdempotencyLock(trx, orgId, cleanIdempotency)
	          const existing = await loadIdempotentImportBatch(trx, orgId, cleanIdempotency)
	          if (existing) {
	            idempotentInTransaction = existing
	            return
	          }
	        }

	        let groupIdMap = null
	        let groupCreated = 0
	        if (groupSync) {
	          groupIdMap = await loadAttendanceGroupIdMap(trx, orgId)
	          if (groupSync.autoCreate && groupNames.size) {
	            const ensured = await ensureAttendanceGroups(trx, orgId, groupNames, {
	              ruleSetId: groupSync.ruleSetId,
	              timezone: groupSync.timezone,
	            })
	            groupIdMap = ensured.map
	            groupCreated = ensured.created
	          }
	        }
	        const groupMembersToInsert = new Map()
		        batchMeta = {
		          ...(payload.batchMeta ?? {}),
		          idempotencyKey: cleanIdempotency || undefined,
		          engine: importEngine,
		          chunkConfig: importChunkConfig,
		          mappingProfileId: payload.mappingProfileId ?? null,
		          groupSync: groupSync
		            ? {
	                autoCreate: groupSync.autoCreate,
	                autoAssignMembers: groupSync.autoAssignMembers,
	                ruleSetId: groupSync.ruleSetId,
	                timezone: groupSync.timezone,
	              }
	            : undefined,
	          groupCreated,
	          async: true,
	        }

	        const batchInsert = idempotencyEnabled
	          ? {
	              sql: `INSERT INTO attendance_import_batches
	               (id, org_id, idempotency_key, created_by, source, rule_set_id, mapping, row_count, status, meta, created_at, updated_at)
	               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, now(), now())`,
	              params: [
	                resolvedBatchId,
	                orgId,
	                cleanIdempotency,
	                requesterId,
	                payload.source ?? null,
	                payload.ruleSetId ?? null,
	                JSON.stringify(mapping),
	                rows.length,
	                'committed',
	                JSON.stringify(batchMeta),
	              ],
	            }
	          : {
	              sql: `INSERT INTO attendance_import_batches
	               (id, org_id, created_by, source, rule_set_id, mapping, row_count, status, meta, created_at, updated_at)
	               VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, now(), now())`,
	              params: [
	                resolvedBatchId,
	                orgId,
	                requesterId,
	                payload.source ?? null,
	                payload.ruleSetId ?? null,
	                JSON.stringify(mapping),
	                rows.length,
	                'committed',
	                JSON.stringify(batchMeta),
	              ],
	            }
	        await trx.query(batchInsert.sql, batchInsert.params)

		        const importItemsBuffer = []
		        const flushImportItems = async () => {
		          if (!importItemsBuffer.length) return
		          const chunk = importItemsBuffer.splice(0, importItemsBuffer.length)
		          await batchInsertAttendanceImportItems(trx, {
		            batchId: resolvedBatchId,
		            orgId,
		            items: chunk,
		          })
		        }
		        const enqueueImportItem = async ({ userId, workDate, recordId, previewSnapshot }) => {
		          importItemsBuffer.push({
		            id: randomUUID(),
	            userId: userId ?? null,
	            workDate: workDate ?? null,
	          recordId: recordId ?? null,
	          previewSnapshot: JSON.stringify(previewSnapshot ?? {}),
	      })
	          if (importItemsBuffer.length >= importChunkConfig.itemsChunkSize) {
	            await flushImportItems()
	          }
	        }

	        // Prefetch holidays + scheduling assignments for the import scope to reduce per-row DB roundtrips.
	        const scopeWorkDates = new Set()
	        const scopeUserIds = new Set()
	        for (const row of rows) {
	          const workDate = row?.workDate
	          if (typeof workDate === 'string' && workDate.trim()) scopeWorkDates.add(workDate.trim())
	          const rowUserId = resolveRowUserId({
	            row,
	            fallbackUserId: requesterId,
	            userMap: payload.userMap,
	            userMapKeyField: payload.userMapKeyField,
	            userMapSourceFields: payload.userMapSourceFields,
	          })
	          if (rowUserId) scopeUserIds.add(rowUserId)
	        }
	        const scopeWorkDateList = Array.from(scopeWorkDates)
	        const scopeUserIdList = Array.from(scopeUserIds)
	        let scopeFromDate = null
	        let scopeToDate = null
	        for (const dateKey of scopeWorkDateList) {
	          if (!scopeFromDate || dateKey < scopeFromDate) scopeFromDate = dateKey
	          if (!scopeToDate || dateKey > scopeToDate) scopeToDate = dateKey
	        }
	        const scopeSpanDays = scopeFromDate && scopeToDate ? Math.max(0, diffDays(scopeFromDate, scopeToDate)) + 1 : 0
	        const shouldPrefetchWorkContext = Boolean(
	          scopeFromDate
	          && scopeToDate
	          && scopeUserIdList.length <= ATTENDANCE_IMPORT_PREFETCH_MAX_USERS
	          && scopeWorkDateList.length <= ATTENDANCE_IMPORT_PREFETCH_MAX_WORK_DATES
	          && scopeSpanDays <= ATTENDANCE_IMPORT_PREFETCH_MAX_SPAN_DAYS
	        )
	        const prefetchedWorkContext = {
	          holidaysByDate: new Map(),
	          shiftAssignmentsByUser: new Map(),
	          rotationAssignmentsByUser: new Map(),
	          rotationShiftsById: new Map(),
	        }
	        if (shouldPrefetchWorkContext) {
	          prefetchedWorkContext.holidaysByDate = await loadHolidayMapByDates(trx, orgId, scopeWorkDateList)
	          prefetchedWorkContext.shiftAssignmentsByUser = await loadShiftAssignmentMapForUsersRange(
	            trx,
	            orgId,
	            scopeUserIdList,
	            scopeFromDate,
	            scopeToDate
	          )
	          const rotationPrefetch = await loadRotationAssignmentMapForUsersRange(
	            trx,
	            orgId,
	            scopeUserIdList,
	            scopeFromDate,
	            scopeToDate
	          )
	          prefetchedWorkContext.rotationAssignmentsByUser = rotationPrefetch.assignmentsByUser
	          prefetchedWorkContext.rotationShiftsById = rotationPrefetch.shiftsById
	        } else if (scopeUserIdList.length || scopeWorkDateList.length) {
	          logger.info('Attendance import scope prefetch skipped due to limits', {
	            orgId,
	            users: scopeUserIdList.length,
	            workDates: scopeWorkDateList.length,
	            spanDays: scopeSpanDays,
	            maxUsers: ATTENDANCE_IMPORT_PREFETCH_MAX_USERS,
	            maxWorkDates: ATTENDANCE_IMPORT_PREFETCH_MAX_WORK_DATES,
	            maxSpanDays: ATTENDANCE_IMPORT_PREFETCH_MAX_SPAN_DAYS,
	          })
	        }

				            // Bulk-prefetch existing attendance_records to avoid per-row SELECT ... FOR UPDATE.
				            const recordUpsertsBuffer = []
				            const flushRecordUpserts = async () => {
				              if (!recordUpsertsBuffer.length) return
				              const chunk = recordUpsertsBuffer.splice(0, recordUpsertsBuffer.length)
				              const chunkUserIds = chunk.map((item) => item.userId)
				              const chunkWorkDates = chunk.map((item) => normalizeDateOnly(item.workDate) ?? item.workDate)

				              const existingRows = await trx.query(
				                `SELECT ar.*
				                 FROM attendance_records ar
				                 JOIN unnest($2::text[], $3::date[]) AS t(user_id, work_date)
	               ON ar.user_id = t.user_id AND ar.work_date = t.work_date
	             WHERE ar.org_id = $1
	             FOR UPDATE`,
	            [orgId, chunkUserIds, chunkWorkDates]
	          )
	          const existingMap = new Map()
	          for (const row of existingRows) {
	            const workDateKey = normalizeDateOnly(row.work_date) ?? row.work_date
	            existingMap.set(`${row.user_id}:${workDateKey}`, row)
	          }

	          const upsertRows = []
	          for (const item of chunk) {
	            const existingRow = existingMap.get(`${item.userId}:${item.workDate}`) ?? undefined
	            const values = computeAttendanceRecordUpsertValues({
	              existingRow,
	              updateFirstInAt: item.updateFirstInAt,
	              updateLastOutAt: item.updateLastOutAt,
	              mode: item.mode,
	              statusOverride: item.statusOverride,
	              overrideMetrics: item.overrideMetrics,
	              isWorkday: item.isWorkday,
	              meta: item.meta,
	              sourceBatchId: item.sourceBatchId,
	              rule: item.rule,
	              leaveMinutes: item.leaveMinutes,
	              overtimeMinutes: item.overtimeMinutes,
	            })
	            upsertRows.push({
	              userId: item.userId,
	              orgId,
	              workDate: item.workDate,
	              timezone: item.timezone,
	              firstInAt: values.firstInAt,
	              lastOutAt: values.lastOutAt,
	              workMinutes: values.workMinutes,
	              lateMinutes: values.lateMinutes,
	              earlyLeaveMinutes: values.earlyLeaveMinutes,
	              status: values.status,
	              isWorkday: values.isWorkday,
	              metaJson: values.metaJson,
	              sourceBatchId: values.sourceBatchId,
	            })
	          }

	          const upserted = await batchUpsertAttendanceRecords(trx, upsertRows)

	          for (const item of chunk) {
	            const record = upserted.get(`${item.userId}:${item.workDate}`)
	            if (!record?.id) {
	              throw new Error(`Attendance record upsert failed for ${item.userId}:${item.workDate}`)
	            }

	            await enqueueImportItem({
	              userId: item.userId,
	              workDate: item.workDate,
	              recordId: record.id,
	              previewSnapshot: item.previewSnapshot,
	            })

	            importedCount += 1
	            if (returnItems && (!itemsLimit || results.length < itemsLimit)) {
	              results.push({
	                id: record.id,
	                userId: item.userId,
	                workDate: item.workDate,
	                engine: item.engine,
	              })
	            }
	          }

	          if (typeof onProgress === 'function') {
	            await onProgress({ imported: importedCount, total: rows.length })
	          }
	        }
	        const enqueueRecordUpsert = async (item) => {
	          recordUpsertsBuffer.push(item)
	          if (recordUpsertsBuffer.length >= importChunkConfig.recordsChunkSize) {
	            await flushRecordUpserts()
	          }
	        }

	        const seenRowKeys = new Set()
	        for (const row of rows) {
	          const workDate = row.workDate
	          const groupKey = resolveAttendanceGroupKey(row)
	          const rowUserId = resolveRowUserId({
	            row,
	            fallbackUserId: requesterId,
	            userMap: payload.userMap,
	            userMapKeyField: payload.userMapKeyField,
	            userMapSourceFields: payload.userMapSourceFields,
	          })
	          const userProfile = resolveRowUserProfile({
	            row,
	            fallbackUserId: requesterId,
	            userMap: payload.userMap,
	            userMapKeyField: payload.userMapKeyField,
	            userMapSourceFields: payload.userMapSourceFields,
	          })
	          const importWarnings = []
	          if (!rowUserId) importWarnings.push('Missing userId')
	          if (!workDate) importWarnings.push('Missing workDate')
	          if (requiredFields.length) {
	            const missingRequired = requiredFields.filter((field) => {
	              const value = resolveRequiredFieldValue(row, field)
	              return value === undefined || value === null || value === ''
	            })
	            if (missingRequired.length) {
	              importWarnings.push(`Missing required: ${missingRequired.join(', ')}`)
	            }
	          }
	          if (punchRequiredFields.length && shouldEnforcePunchRequired(row)) {
	            const missingPunch = punchRequiredFields.filter((field) => {
	              const value = resolveRequiredFieldValue(row, field)
	              return value === undefined || value === null || value === ''
	            })
	            if (missingPunch.length) {
	              importWarnings.push(`Missing required: ${missingPunch.join(', ')}`)
	            }
	          }
	          if (importWarnings.length) {
	            const snapshot = buildSkippedImportSnapshot({ warnings: importWarnings, row, reason: 'validation' })
	            await enqueueImportItem({
	              userId: rowUserId ?? null,
	              workDate: workDate ?? null,
	              recordId: null,
	              previewSnapshot: snapshot,
	            })
	            skipped.push({
	              userId: rowUserId ?? null,
	              workDate: workDate ?? null,
	              warnings: importWarnings,
	            })
	            releaseImportRowMemory(row)
	            continue
	          }

	          const dedupKey = `${rowUserId}:${workDate}`
	          if (seenRowKeys.has(dedupKey)) {
	            const warnings = ['Duplicate row in payload (same userId + workDate)']
	            const snapshot = buildSkippedImportSnapshot({ warnings, row, reason: 'duplicate' })
	            await enqueueImportItem({
	              userId: rowUserId,
	              workDate,
	              recordId: null,
	              previewSnapshot: snapshot,
	            })
	            skipped.push({ userId: rowUserId, workDate, warnings })
	            releaseImportRowMemory(row)
	            continue
	          }
	          seenRowKeys.add(dedupKey)
	          if (groupSync?.autoAssignMembers && groupKey && rowUserId && groupIdMap && groupIdMap.has(groupKey)) {
	            const groupEntry = groupIdMap.get(groupKey)
	            if (groupEntry?.id) {
	              groupMembersToInsert.set(`${groupEntry.id}:${rowUserId}`, { groupId: groupEntry.id, userId: rowUserId })
	            }
	          }

	          let activeRuleSetId = payload.ruleSetId ?? null
	          let activeRuleSetConfig = ruleSetConfig
	          if (!activeRuleSetId && groupRuleSetMap.size) {
	            if (groupKey && groupRuleSetMap.has(groupKey)) {
	              activeRuleSetId = groupRuleSetMap.get(groupKey)
	            }
	          }
	          if (!activeRuleSetConfig && activeRuleSetId) {
	            if (ruleSetConfigCache.has(activeRuleSetId)) {
	              activeRuleSetConfig = ruleSetConfigCache.get(activeRuleSetId)
	            } else {
	              activeRuleSetConfig = await loadRuleSetConfigById(db, orgId, activeRuleSetId)
	              ruleSetConfigCache.set(activeRuleSetId, activeRuleSetConfig)
	            }
	          }

	          const override = normalizeRuleOverride(activeRuleSetConfig?.rule)
	          const ruleOverride = override
	            ? { ...baseRule, ...override, workingDays: override.workingDays ?? baseRule.workingDays }
	            : baseRule

	          let engine = payloadEngine
	          if (!engine && activeRuleSetConfig?.engine) {
	            if (activeRuleSetId && engineCache.has(activeRuleSetId)) {
	              engine = engineCache.get(activeRuleSetId)
	            } else {
	              try {
	                engine = createRuleEngine({ config: activeRuleSetConfig.engine, logger })
	                if (activeRuleSetId) engineCache.set(activeRuleSetId, engine)
	              } catch (error) {
	                logger.warn('Attendance rule engine config invalid (rule set)', error)
	              }
	            }
	          }

	          const context = resolveWorkContextFromPrefetch({
	            orgId,
	            userId: rowUserId,
	            workDate,
	            defaultRule: ruleOverride,
	            prefetched: prefetchedWorkContext,
	          }) ?? await resolveWorkContext({
	            db: trx,
	            orgId,
	            userId: rowUserId,
	            workDate,
	            defaultRule: ruleOverride,
	          })

	          const mapped = applyFieldMappings(row.fields ?? {}, mapping)
	          const valueFor = (key) => {
	            if (mapped[key]?.value !== undefined) return mapped[key].value
	            if (row.fields?.[key] !== undefined) return row.fields[key]
	            const profileValue = resolveProfileValue(userProfile, key)
	            if (profileValue !== undefined) return profileValue
	            return undefined
	          }
	          const dataTypeFor = (key) => mapped[key]?.dataType
	          const profileSnapshot = buildProfileSnapshot({ valueFor, userProfile })

	          const shiftNameRaw = valueFor('shiftName') ?? valueFor('plan_detail') ?? valueFor('attendanceClass')
	          const fieldValues = buildFieldValueMap(row.fields ?? {}, mapped, userProfile)
	          augmentFieldValuesWithDates(fieldValues, workDate)
	          const holidayMeta = resolveHolidayMeta(context.holiday)
	          if (holidayMeta.name) fieldValues.holiday_name = holidayMeta.name
	          if (holidayMeta.dayIndex != null) fieldValues.holiday_day_index = holidayMeta.dayIndex
	          fieldValues.holiday_first_day = holidayMeta.isFirstDay

	          const baseFacts = {
	            userId: rowUserId,
	            orgId,
	            workDate,
	            shiftName: shiftNameRaw ?? context.rule?.name ?? null,
	            isHoliday: Boolean(context.holiday),
	            isWorkingDay: context.isWorkingDay,
	          }
	          const baseUserGroups = resolveUserGroups(activeRuleSetConfig?.policies?.userGroups, baseFacts, fieldValues)
	          const shiftOverride = resolveShiftOverrideFromMappings(
	            activeRuleSetConfig?.policies?.shiftMappings,
	            baseFacts,
	            fieldValues,
	            baseUserGroups
	          )

	          const shiftRange = resolveShiftTimeRange(shiftNameRaw)
	          const baseRuleForMetrics = shiftRange ? { ...context.rule, ...shiftRange } : context.rule
	          const ruleForMetrics = shiftRange
	            ? baseRuleForMetrics
	            : (shiftOverride ? { ...context.rule, ...shiftOverride } : baseRuleForMetrics)

	          const firstInAt = parseImportedDateTime(valueFor('firstInAt'), workDate, ruleForMetrics.timezone)
	          const lastOutAt = parseImportedDateTime(valueFor('lastOutAt'), workDate, ruleForMetrics.timezone)
	          const statusRaw = valueFor('status')
	          const statusOverride = statusRaw != null ? resolveStatusOverride(statusRaw, statusMap) : null

	          const workMinutes = parseMinutesValue(valueFor('workMinutes') ?? valueFor('workHours'), dataTypeFor('workMinutes') ?? dataTypeFor('workHours'))
	          const lateMinutes = parseMinutesValue(valueFor('lateMinutes'), dataTypeFor('lateMinutes'))
	          const earlyLeaveMinutes = parseMinutesValue(valueFor('earlyLeaveMinutes'), dataTypeFor('earlyLeaveMinutes'))
	          const leaveMinutes = parseMinutesValue(valueFor('leaveMinutes') ?? valueFor('leaveHours'), dataTypeFor('leaveMinutes') ?? dataTypeFor('leaveHours'))
	          const overtimeMinutes = parseMinutesValue(valueFor('overtimeMinutes') ?? valueFor('overtimeHours'), dataTypeFor('overtimeMinutes') ?? dataTypeFor('overtimeHours'))

	          const computed = computeMetrics({
	            rule: ruleForMetrics,
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

	          const approvalSummary = valueFor('approvalSummary') ?? valueFor('attendance_approve') ?? valueFor('attendanceApprove')
	          const policyBaseMetrics = {
	            ...initialMetrics,
	            leaveMinutes: leaveMinutes ?? 0,
	            overtimeMinutes: overtimeMinutes ?? 0,
	          }
	          const holidayPolicyContext = buildHolidayPolicyContext({ rowUserId, valueFor, userProfile })
	          const holidayPolicyResult = applyHolidayPolicy({
	            settings,
	            holiday: context.holiday,
	            holidayMeta,
	            metrics: policyBaseMetrics,
	            approvalSummary,
	            policyContext: holidayPolicyContext,
	          })
	          const policyResult = applyAttendancePolicies({
	            policies: activeRuleSetConfig?.policies,
	            facts: {
	              userId: rowUserId,
	              orgId,
	              workDate,
	              shiftName: shiftNameRaw ?? context.rule?.name ?? null,
	              isHoliday: Boolean(context.holiday),
	              isWorkingDay: context.isWorkingDay,
	              holidayName: holidayMeta.name,
	              holidayDayIndex: holidayMeta.dayIndex,
	              holidayFirstDay: holidayMeta.isFirstDay,
	            },
	            fieldValues,
	            metrics: holidayPolicyResult.metrics,
	            options: { skipRules: resolvePolicySkipRules(settings) },
	          })
	          const effective = policyResult.metrics
	          let engineResult = null
	          if (engine) {
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
	                holiday_name: holidayMeta.name ?? undefined,
	                holiday_day_index: holidayMeta.dayIndex ?? undefined,
	                holiday_first_day: holidayMeta.isFirstDay,
	                holiday_policy_enabled: Boolean(settings?.holidayPolicy?.firstDayEnabled),
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
	          const effectiveLeaveMinutes = Number.isFinite(finalMetrics.leaveMinutes) ? finalMetrics.leaveMinutes : leaveMinutes
	          const effectiveOvertimeMinutes = Number.isFinite(finalMetrics.overtimeMinutes) ? finalMetrics.overtimeMinutes : overtimeMinutes

	          const policyWarnings = [...holidayPolicyResult.warnings, ...policyResult.warnings]
	          let meta = null
	          if (policyWarnings.length || policyResult.appliedRules.length || policyResult.userGroups.length) {
	            meta = {
	              policy: {
	                warnings: policyWarnings,
	                appliedRules: policyResult.appliedRules,
	                userGroups: policyResult.userGroups,
	              },
	            }
	          }
	          if (profileSnapshot) {
	            meta = meta ?? {}
	            meta.profile = profileSnapshot
	          }
	          meta = meta ?? {}
	          meta.metrics = {
	            leaveMinutes: effectiveLeaveMinutes,
	            overtimeMinutes: effectiveOvertimeMinutes,
	          }
	          meta.source = {
	            source: payload.source ?? null,
	            mappingProfileId: payload.mappingProfileId ?? null,
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

	          const snapshot = {
	            metrics: {
	              workMinutes: finalMetrics.workMinutes,
	              lateMinutes: finalMetrics.lateMinutes,
	              earlyLeaveMinutes: finalMetrics.earlyLeaveMinutes,
	              leaveMinutes: effectiveLeaveMinutes,
	              overtimeMinutes: effectiveOvertimeMinutes,
	              status: finalMetrics.status,
	            },
	            policy: meta?.policy ?? null,
	            engine: meta?.engine ?? null,
	          }
	          await enqueueRecordUpsert({
	            userId: rowUserId,
	            workDate,
	            timezone: context.rule.timezone,
	            rule: context.rule,
	            updateFirstInAt: firstInAt,
	            updateLastOutAt: lastOutAt,
	            mode: payload.mode ?? 'override',
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
	            sourceBatchId: resolvedBatchId,
	            previewSnapshot: snapshot,
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
	          releaseImportRowMemory(row)
	        }

	        await flushRecordUpserts()
	        await flushImportItems()

	        if (groupSync?.autoAssignMembers && groupMembersToInsert.size) {
	          const groupMembersAdded = await insertAttendanceGroupMembers(trx, orgId, Array.from(groupMembersToInsert.values()))
	          if (batchMeta) {
	            batchMeta.groupMembersAdded = groupMembersAdded
	            await trx.query(
	              'UPDATE attendance_import_batches SET meta = $3::jsonb, updated_at = now() WHERE id = $1 AND org_id = $2',
	              [resolvedBatchId, orgId, JSON.stringify(batchMeta)]
	            )
	          }
	        }
	        if (skipped.length) {
	          const updatedMeta = {
	            ...(batchMeta ?? {}),
	            skippedCount: skipped.length,
	            skippedRows: skipped.slice(0, 50),
	          }
	          await trx.query(
	            'UPDATE attendance_import_batches SET meta = $3::jsonb, updated_at = now() WHERE id = $1 AND org_id = $2',
	            [resolvedBatchId, orgId, JSON.stringify(updatedMeta)]
	          )
			          batchMeta = updatedMeta
			        }
			      })

		      if (csvFileId) {
		        await deleteImportUpload({ orgId, fileId: csvFileId })
		      }

	      if (idempotentInTransaction) {
	        const idempotentRowCount = idempotentInTransaction.imported + idempotentInTransaction.skipped
	        return {
	          batchId: idempotentInTransaction.batchId,
	          imported: idempotentInTransaction.imported,
	          rowCount: idempotentRowCount,
	          processedRows: idempotentInTransaction.imported,
	          failedRows: idempotentInTransaction.skipped,
	          elapsedMs: Math.max(0, Date.now() - commitStartedAtMs),
	          skippedCount: idempotentInTransaction.skipped,
	          engine: resolveImportEngineFromMeta(
	            idempotentInTransaction.meta,
	            idempotentRowCount
	          ),
	          items: [],
	          skipped: [],
		          csvWarnings: [],
	          groupWarnings: [],
	          meta: idempotentInTransaction.meta,
	          idempotent: true,
	        }
	      }

	      return {
	        batchId: resolvedBatchId,
	        imported: importedCount,
	        rowCount: rows.length,
	        processedRows: importedCount,
	        failedRows: skipped.length,
	        elapsedMs: Math.max(0, Date.now() - commitStartedAtMs),
	        skippedCount: skipped.length,
	        engine: importEngine,
	        items: returnItems ? results : [],
		        itemsTruncated: Boolean(returnItems && itemsLimit && importedCount > results.length),
		        skipped,
	        csvWarnings: [...csvWarnings, ...groupWarnings],
	        groupWarnings,
	        meta: batchMeta,
	      }
	    }

	    // Register queue processor (best-effort).
	    const importQueue = getQueueService()
	    if (ATTENDANCE_IMPORT_ASYNC_ENABLED && importQueue && typeof importQueue.process === 'function') {
	      importQueue.process(ATTENDANCE_IMPORT_ASYNC_QUEUE, ATTENDANCE_IMPORT_ASYNC_JOB, async (job) => {
	        await processAsyncImportCommitJob(job.data ?? {})
	      })

	      // Re-enqueue queued/running jobs on startup (e.g. after a restart). This is best-effort with
	      // the in-memory queue; for Bull-based backends, the queue will persist separately.
	      setImmediate(async () => {
	        try {
	          const rows = await db.query(
	            `SELECT id, org_id
	             FROM attendance_import_jobs
	             WHERE status IN ('queued', 'running')
	             ORDER BY created_at ASC
	             LIMIT 50`,
	            []
	          )
	          for (const row of rows) {
	            await enqueueImportJob(row.id)
	          }
	        } catch (error) {
	          logger.warn('Attendance async import requeue skipped', error)
	        }
	      })
	    }

	    const integrationCreateSchema = z.object({
	      name: z.string().min(1),
	      type: z.enum(['dingtalk']),
      status: z.enum(['active', 'disabled']).optional(),
      config: z.record(z.unknown()).optional(),
    })
    const integrationUpdateSchema = integrationCreateSchema.partial()
    const integrationSyncSchema = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      dryRun: z.boolean().optional(),
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
    const payrollCycleGenerateSchema = z.object({
      templateId: z.string().uuid().optional(),
      anchorDate: z.string().min(1),
      count: z.number().int().min(1).max(24).optional(),
      status: z.enum(['open', 'closed', 'archived']).optional(),
      namePrefix: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
      orgId: z.string().optional(),
    })

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
	      '/api/attendance/anomalies',
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

	        const excludedStatuses = ['normal', 'off', 'adjusted']

	        const extractWarnings = (snapshot) => {
	          if (!snapshot || typeof snapshot !== 'object') return []
	          const out = []
	          if (Array.isArray(snapshot.warnings)) out.push(...snapshot.warnings)
	          if (snapshot.metrics && typeof snapshot.metrics === 'object' && Array.isArray(snapshot.metrics.warnings)) {
	            out.push(...snapshot.metrics.warnings)
	          }
	          if (snapshot.policy && Array.isArray(snapshot.policy.warnings)) out.push(...snapshot.policy.warnings)
	          if (snapshot.engine && Array.isArray(snapshot.engine.warnings)) out.push(...snapshot.engine.warnings)
	          return Array.from(new Set(out.map((w) => String(w)).filter(Boolean)))
	        }

	        const suggestRequestType = (row) => {
	          const status = row?.status ? String(row.status) : ''
	          if (status === 'absent') return 'leave'
	          if (status === 'partial') {
	            if (!row.first_in_at) return 'missed_check_in'
	            if (!row.last_out_at) return 'missed_check_out'
	            return 'time_correction'
	          }
	          if (status === 'late' || status === 'early_leave' || status === 'late_early') return 'time_correction'
	          return null
	        }

	        try {
	          const countRows = await db.query(
	            `SELECT COUNT(*)::int AS total
	             FROM attendance_records
	             WHERE user_id = $1
	               AND org_id = $2
	               AND work_date BETWEEN $3 AND $4
	               AND COALESCE(is_workday, true) = true
	               AND COALESCE(status, '') <> ALL($5)`,
	            [targetUserId, orgId, from, to, excludedStatuses]
	          )
	          const total = Number(countRows[0]?.total ?? 0)

	          const rows = await db.query(
	            `SELECT *
	             FROM attendance_records
	             WHERE user_id = $1
	               AND org_id = $2
	               AND work_date BETWEEN $3 AND $4
	               AND COALESCE(is_workday, true) = true
	               AND COALESCE(status, '') <> ALL($5)
	             ORDER BY work_date DESC
	             LIMIT $6 OFFSET $7`,
	            [targetUserId, orgId, from, to, excludedStatuses, pageSize, offset]
	          )

	          const requestRows = await db.query(
	            `SELECT id, work_date, request_type, status
	             FROM attendance_requests
	             WHERE user_id = $1 AND org_id = $2 AND work_date BETWEEN $3 AND $4
	             ORDER BY work_date DESC, created_at DESC`,
	            [targetUserId, orgId, from, to]
	          )
	          const requestByDate = new Map()
	          for (const row of requestRows) {
	            const workDate = row.work_date
	            const entry = requestByDate.get(workDate) ?? {
	              hasPending: false,
	              pending: null,
	              latest: null,
	            }
	            const summary = {
	              id: row.id,
	              status: row.status,
	              requestType: row.request_type,
	            }
	            if (!entry.latest) entry.latest = summary
	            if (row.status === 'pending') {
	              entry.hasPending = true
	              if (!entry.pending) entry.pending = summary
	            }
	            requestByDate.set(workDate, entry)
	          }

	          const approvedMap = await loadApprovedMinutesRange(db, orgId, targetUserId, from, to)
	          const items = rows.map((row) => {
	            const meta = normalizeMetadata(row.meta)
	            const approved = approvedMap.get(row.work_date) ?? { leaveMinutes: 0, overtimeMinutes: 0 }
	            const warnings = extractWarnings(meta)
	            const requestSummary = requestByDate.get(row.work_date) ?? { hasPending: false, pending: null, latest: null }
	            const suggestedRequestType = suggestRequestType(row)
	            const state = requestSummary.hasPending ? 'pending' : 'open'

	            return {
	              recordId: row.id,
	              workDate: row.work_date,
	              status: row.status,
	              isWorkday: row.is_workday,
	              firstInAt: row.first_in_at,
	              lastOutAt: row.last_out_at,
	              workMinutes: Number(row.work_minutes ?? 0),
	              lateMinutes: Number(row.late_minutes ?? 0),
	              earlyLeaveMinutes: Number(row.early_leave_minutes ?? 0),
	              leaveMinutes: approved.leaveMinutes,
	              overtimeMinutes: approved.overtimeMinutes,
	              warnings,
	              state,
	              request: requestSummary.pending ?? requestSummary.latest,
	              suggestedRequestType,
	            }
	          })

	          if (csvFileId) {
	            await deleteImportUpload({ orgId, fileId: csvFileId })
	          }

	          res.json({
	            ok: true,
	            data: {
	              items,
	              total,
	              page,
	              pageSize,
	              from,
	              to,
	            },
	          })
	        } catch (error) {
	          if (isDatabaseSchemaError(error)) {
	            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
	            return
	          }
	          logger.error('Attendance anomalies query failed', error)
	          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load anomalies' } })
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
          // Surface the underlying missing table/column during integration testing and misconfigured deploys.
          // The response stays generic to avoid leaking schema details to clients.
          logger.error('Attendance resolveRequest failed due to missing tables/columns', error)
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
      '/api/attendance/rule-templates',
      withPermission('attendance:admin', async (_req, res) => {
        const orgId = getOrgId(_req)
        const library = await getTemplateLibrary(db, orgId)
        const versions = await getTemplateLibraryVersions(db, orgId)
        res.json({
          ok: true,
          data: {
            system: DEFAULT_TEMPLATES,
            library,
            versions,
          },
        })
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/rule-templates',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = templateLibrarySchema.safeParse(req.body ?? {})
        let templates = null
        if (Array.isArray(req.body)) {
          templates = req.body
        } else if (parsed.success) {
          templates = parsed.data.templates ?? parsed.data.library ?? null
        }

        if (!Array.isArray(templates)) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'templates is required' } })
          return
        }

        const orgId = getOrgId(req)
        try {
          const saved = await saveTemplateLibrary(db, orgId, templates, getUserId(req))
          res.json({ ok: true, data: { templates: saved } })
        } catch (error) {
          const { message, details } = formatEngineConfigError(error)
          res.status(400).json({ ok: false, error: { code: 'INVALID_TEMPLATE_LIBRARY', message, details } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/rule-templates/restore',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = templateLibraryRestoreSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'versionId or version is required' } })
          return
        }
        const { versionId, version } = parsed.data
        if (!versionId && !Number.isFinite(version)) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'versionId or version is required' } })
          return
        }
        const orgId = getOrgId(req)
        const target = await getTemplateLibraryVersionPayload(db, orgId, versionId ?? null, version)
        if (!target) {
          res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Template version not found' } })
          return
        }
        try {
          const saved = await saveTemplateLibrary(db, orgId, target.templates, getUserId(req), target.id)
          res.json({ ok: true, data: { templates: saved, restoredFrom: target.id, version: target.version } })
        } catch (error) {
          const { message, details } = formatEngineConfigError(error)
          res.status(400).json({ ok: false, error: { code: 'INVALID_TEMPLATE_LIBRARY', message, details } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/rule-sets/template',
      withPermission('attendance:admin', async (_req, res) => {
        const orgId = getOrgId(_req)
        const templateLibrary = await getTemplateLibrary(db, orgId)
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
                { sourceField: 'attendance_group', targetField: 'attendance_group', dataType: 'string' },
                { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
                { sourceField: '考勤组', targetField: 'attendanceGroup', dataType: 'string' },
                { sourceField: '班次', targetField: 'shiftName', dataType: 'string' },
                { sourceField: '出勤班次', targetField: 'shiftName', dataType: 'string' },
                { sourceField: '部门', targetField: 'department', dataType: 'string' },
                { sourceField: '职位', targetField: 'role', dataType: 'string' },
                { sourceField: '异常原因', targetField: 'exceptionReason', dataType: 'string' },
                { sourceField: '关联的审批单', targetField: 'attendance_approve', dataType: 'string' },
                { sourceField: '关联的审批单', targetField: 'approvalSummary', dataType: 'string' },
                { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'datetime' },
                { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'datetime' },
                { sourceField: '上班2打卡时间', targetField: 'clockIn2', dataType: 'datetime' },
                { sourceField: '下班2打卡时间', targetField: 'clockOut2', dataType: 'datetime' },
                { sourceField: '上班3打卡时间', targetField: 'clockIn3', dataType: 'datetime' },
                { sourceField: '下班3打卡时间', targetField: 'clockOut3', dataType: 'datetime' },
                { sourceField: 'department', targetField: 'department', dataType: 'string' },
                { sourceField: 'role', targetField: 'role', dataType: 'string' },
                { sourceField: '迟到分钟', targetField: 'lateMinutes', dataType: 'number' },
                { sourceField: '早退分钟', targetField: 'earlyLeaveMinutes', dataType: 'number' },
                { sourceField: '实出勤工时', targetField: 'workHours', dataType: 'number' },
                { sourceField: '加班小时', targetField: 'overtimeHours', dataType: 'number' },
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
              templates: [...DEFAULT_TEMPLATES, ...templateLibrary],
            },
            templateLibrary,
            policies: {
              userGroups: [
                {
                  name: 'security',
                  fieldContains: { attendance_group: '保安' },
                },
                {
                  name: 'security',
                  fieldContains: { attendanceGroup: '保安' },
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
                  name: 'driver',
                  fieldContains: { attendanceGroup: '司机' },
                },
                {
                  name: 'single_rest_workshop',
                  fieldContains: { attendance_group: '单休车间' },
                },
                {
                  name: 'single_rest_workshop',
                  fieldContains: { attendanceGroup: '单休车间' },
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
        if (payload.config?.engine) {
          try {
            validateEngineConfig(payload.config.engine)
          } catch (error) {
            const { message, details } = formatEngineConfigError(error)
            res.status(400).json({ ok: false, error: { code: 'INVALID_ENGINE_CONFIG', message, details } })
            return
          }
        }

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
          if (payload.config?.engine) {
            try {
              validateEngineConfig(payload.config.engine)
            } catch (error) {
              const { message, details } = formatEngineConfigError(error)
              res.status(400).json({ ok: false, error: { code: 'INVALID_ENGINE_CONFIG', message, details } })
              return
            }
          }

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
              columns: IMPORT_MAPPING_COLUMNS,
            },
            mappingProfiles: IMPORT_MAPPING_PROFILES,
            payloadExample: {
              source: 'dingtalk_csv',
              mode: 'override',
              // Keep the template payload valid out-of-the-box: ruleSetId is optional.
              userMapKeyField: '工号',
              userMapSourceFields: ['empNo', '工号', '姓名'],
              userMap: {},
              entries: [],
            },
          },
        })
	      })
	    )

	    // Upload a CSV file (raw body) and receive a server-side csvFileId reference.
	    // Intended for extreme-scale imports where embedding csvText in JSON hits body limits.
	    context.api.http.addRoute(
	      'POST',
	      '/api/attendance/import/upload',
	      withPermission('attendance:admin', async (req, res) => {
	        const orgId = getOrgId(req)
	        const requesterId = getUserId(req)
	        if (!requesterId) {
	          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
	          return
	        }

	        const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
	        if (contentType.startsWith('multipart/')) {
	          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Use raw CSV body (Content-Type: text/csv), not multipart/form-data' } })
	          return
	        }

	        const filename = String(req.query?.filename ?? req.query?.name ?? req.headers['x-filename'] ?? 'import.csv')
	        const fileId = randomUUID()
	        const paths = getImportUploadPaths({ orgId, fileId })
	        const createdAt = new Date().toISOString()
	        const expiresAt = new Date(Date.now() + ATTENDANCE_IMPORT_UPLOAD_TTL_MS).toISOString()

	        try {
	          await fsp.mkdir(paths.dir, { recursive: true })
	          const meter = new ImportUploadMeter(ATTENDANCE_IMPORT_UPLOAD_MAX_BYTES)
	          await pipeline(req, meter, fs.createWriteStream(paths.csvPath))

	          const endedWithNewline = meter.lastByte === 10
	          const lines = meter.bytes === 0 ? 0 : meter.newlines + (endedWithNewline ? 0 : 1)
	          const rowCount = Math.max(0, lines - 1) // header row excluded

	          if (rowCount <= 0) {
	            await deleteImportUpload({ orgId, fileId })
	            res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'CSV must include at least 1 data row' } })
	            return
	          }

	          const meta = {
	            fileId,
	            orgId,
	            createdBy: requesterId,
	            filename: filename.slice(0, 200),
	            contentType: contentType ? contentType.slice(0, 200) : null,
	            bytes: meter.bytes,
	            rowCount,
	            createdAt,
	            expiresAt,
	          }
	          await fsp.writeFile(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

	          res.status(201).json({
	            ok: true,
	            data: {
	              fileId,
	              rowCount,
	              bytes: meter.bytes,
	              createdAt,
	              expiresAt,
	              maxBytes: ATTENDANCE_IMPORT_UPLOAD_MAX_BYTES,
	            },
	          })
	        } catch (error) {
	          await deleteImportUpload({ orgId, fileId })
	          if (error instanceof HttpError) {
	            res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
	            return
	          }
	          logger.error('Attendance import upload failed', error)
	          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to upload CSV' } })
	        }
	      })
	    )

	    context.api.http.addRoute(
	      'POST',
	      '/api/attendance/import/prepare',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const requesterId = getUserId(req)
        if (!requesterId) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId is required' } })
          return
        }

        try {
          const { token, expiresAt } = await createImportCommitToken({ db, orgId, userId: requesterId })
          res.json({
            ok: true,
            data: {
              commitToken: token,
              expiresAt: new Date(expiresAt).toISOString(),
              ttlSeconds: Math.floor(IMPORT_COMMIT_TOKEN_TTL_MS / 1000),
            },
          })
        } catch (error) {
          if (error instanceof HttpError) {
            res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
            return
          }
          logger.error('Attendance import token prepare failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to prepare import token' } })
        }
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
        const requesterId = getUserId(req)
        const userId = parsed.data.userId ?? requesterId
        if (!userId) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId is required' } })
          return
        }
        if (requireImportCommitToken) {
          if (!requesterId) {
            res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
            return
          }
          const commitToken = parsed.data.commitToken
          if (!commitToken) {
            res.status(400).json({ ok: false, error: { code: 'COMMIT_TOKEN_REQUIRED', message: 'commitToken is required' } })
            return
          }
          let tokenOk = false
          try {
            // Tokens are bound to the requester, not the imported row's userId.
            tokenOk = await consumeImportCommitToken(commitToken, { db, orgId, userId: requesterId })
          } catch (error) {
            if (error instanceof HttpError) {
              res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
              return
            }
            logger.error('Attendance import token validation failed (preview)', error)
            res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to validate commit token' } })
            return
          }
          if (!tokenOk) {
            res.status(403).json({ ok: false, error: { code: 'COMMIT_TOKEN_INVALID', message: 'commitToken invalid or expired' } })
            return
          }
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

          const profile = findImportProfile(parsed.data.mappingProfileId)
          const profileMapping = profile?.mapping?.columns ?? profile?.mapping?.fields ?? []
          const mapping = parsed.data.mapping?.columns
            ?? parsed.data.mapping?.fields
            ?? (profileMapping.length ? profileMapping : undefined)
            ?? ruleSetConfig?.mappings?.columns
            ?? ruleSetConfig?.mappings?.fields
            ?? []
          const requiredFields = profile?.requiredFields ?? []
          const punchRequiredFields = profile?.punchRequiredFields ?? []

	          const { rows, csvWarnings } = await resolveImportRows({
	            payload: parsed.data,
	            orgId,
	            fallbackUserId: parsed.data.userId ?? userId,
	          })

	          if (rows.length === 0) {
	            res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'No rows to preview' } })
	            return
	          }

          const baseRule = await loadDefaultRule(db, orgId)
          const settings = await getSettings(db)
          const groupRuleSetMap = parsed.data.ruleSetId ? new Map() : await loadAttendanceGroupRuleSetMap(db, orgId)
          const groupSync = normalizeGroupSyncOptions(
            parsed.data.groupSync,
            parsed.data.ruleSetId,
            parsed.data.timezone
          )
          const groupNames = groupSync ? collectAttendanceGroupNames(rows) : new Map()
          const groupWarnings = []
          if (groupNames.size && !groupSync?.autoCreate) {
            const groupIdMap = await loadAttendanceGroupIdMap(db, orgId)
            for (const [key, name] of groupNames.entries()) {
              if (!groupIdMap.has(key)) groupWarnings.push(`Attendance group not found: ${name}`)
            }
          }
          if (groupSync?.ruleSetId && !parsed.data.ruleSetId && groupNames.size) {
            for (const key of groupNames.keys()) {
              if (!groupRuleSetMap.has(key)) groupRuleSetMap.set(key, groupSync.ruleSetId)
            }
          }
          const ruleSetConfigCache = new Map()
          if (parsed.data.ruleSetId && ruleSetConfig) {
            ruleSetConfigCache.set(parsed.data.ruleSetId, ruleSetConfig)
          }
          const engineCache = new Map()
          let payloadEngine = null
          if (parsed.data.engine) {
            try {
              payloadEngine = createRuleEngine({ config: parsed.data.engine, logger })
            } catch (error) {
              logger.warn('Attendance rule engine config invalid (preview payload)', error)
            }
          }

          const statusMap = parsed.data.statusMap ?? {}
          const previewLimit = typeof parsed.data.previewLimit === 'number' ? parsed.data.previewLimit : null
          const truncated = previewLimit != null && rows.length > previewLimit
          const previewStats = {
            rowCount: rows.length,
            invalid: 0,
            duplicates: 0,
          }
          const preview = []
          const seenKeys = new Set()
          for (const row of rows) {
            const shouldRender = previewLimit == null || preview.length < previewLimit
            const workDate = row.workDate
            const rowUserId = resolveRowUserId({
              row,
              fallbackUserId: userId,
              userMap: parsed.data.userMap,
              userMapKeyField: parsed.data.userMapKeyField,
              userMapSourceFields: parsed.data.userMapSourceFields,
            })
            const userProfile = resolveRowUserProfile({
              row,
              fallbackUserId: userId,
              userMap: parsed.data.userMap,
              userMapKeyField: parsed.data.userMapKeyField,
              userMapSourceFields: parsed.data.userMapSourceFields,
            })
            const importWarnings = []
            if (!rowUserId) importWarnings.push('Missing userId')
            if (!workDate) importWarnings.push('Missing workDate')
            if (requiredFields.length) {
              const missingRequired = requiredFields.filter((field) => {
                const value = resolveRequiredFieldValue(row, field)
                return value === undefined || value === null || value === ''
              })
              if (missingRequired.length) {
                importWarnings.push(`Missing required: ${missingRequired.join(', ')}`)
              }
            }
            if (punchRequiredFields.length && shouldEnforcePunchRequired(row)) {
              const missingPunch = punchRequiredFields.filter((field) => {
                const value = resolveRequiredFieldValue(row, field)
                return value === undefined || value === null || value === ''
              })
              if (missingPunch.length) {
                importWarnings.push(`Missing required: ${missingPunch.join(', ')}`)
              }
            }
            if (importWarnings.length) {
              previewStats.invalid += 1
              if (shouldRender) {
                preview.push({
                  userId: rowUserId ?? 'unknown',
                  workDate: workDate ?? '',
                  firstInAt: null,
                  lastOutAt: null,
                  workMinutes: 0,
                  lateMinutes: 0,
                  earlyLeaveMinutes: 0,
                  leaveMinutes: 0,
                  overtimeMinutes: 0,
                  status: 'invalid',
                  isWorkday: undefined,
                  warnings: importWarnings,
                  appliedPolicies: [],
                  userGroups: [],
                })
              }
              continue
            }

            const dedupKey = `${rowUserId}:${workDate}`
            if (seenKeys.has(dedupKey)) {
              previewStats.duplicates += 1
              if (shouldRender) {
                preview.push({
                  userId: rowUserId,
                  workDate,
                  firstInAt: null,
                  lastOutAt: null,
                  workMinutes: 0,
                  lateMinutes: 0,
                  earlyLeaveMinutes: 0,
                  leaveMinutes: 0,
                  overtimeMinutes: 0,
                  status: 'invalid',
                  isWorkday: undefined,
                  warnings: ['Duplicate row for same user/workDate (skipped during commit).'],
                  appliedPolicies: [],
                  userGroups: [],
                })
              }
              continue
            }
            seenKeys.add(dedupKey)

            // When previewLimit is set, skip expensive context/engine evaluation after we have
            // rendered enough sample rows. Stats above still reflect all rows.
            if (!shouldRender) continue

            let activeRuleSetId = parsed.data.ruleSetId ?? null
            let activeRuleSetConfig = ruleSetConfig
            if (!activeRuleSetId && groupRuleSetMap.size) {
              const groupKey = resolveAttendanceGroupKey(row)
              if (groupKey && groupRuleSetMap.has(groupKey)) {
                activeRuleSetId = groupRuleSetMap.get(groupKey)
              }
            }
            if (!activeRuleSetConfig && activeRuleSetId) {
              if (ruleSetConfigCache.has(activeRuleSetId)) {
                activeRuleSetConfig = ruleSetConfigCache.get(activeRuleSetId)
              } else {
                activeRuleSetConfig = await loadRuleSetConfigById(db, orgId, activeRuleSetId)
                ruleSetConfigCache.set(activeRuleSetId, activeRuleSetConfig)
              }
            }

            const override = normalizeRuleOverride(activeRuleSetConfig?.rule)
            const ruleOverride = override
              ? { ...baseRule, ...override, workingDays: override.workingDays ?? baseRule.workingDays }
              : baseRule

            let engine = payloadEngine
            if (!engine && activeRuleSetConfig?.engine) {
              if (activeRuleSetId && engineCache.has(activeRuleSetId)) {
                engine = engineCache.get(activeRuleSetId)
              } else {
                try {
                  engine = createRuleEngine({ config: activeRuleSetConfig.engine, logger })
                  if (activeRuleSetId) engineCache.set(activeRuleSetId, engine)
                } catch (error) {
                  logger.warn('Attendance rule engine config invalid (rule set)', error)
                }
              }
            }
            const context = await resolveWorkContext({
              db,
              orgId,
              userId: rowUserId,
              workDate,
              defaultRule: ruleOverride,
            })
            const mapped = applyFieldMappings(row.fields ?? {}, mapping)
            const valueFor = (key) => {
              if (mapped[key]?.value !== undefined) return mapped[key].value
              if (row.fields?.[key] !== undefined) return row.fields[key]
              const profileValue = resolveProfileValue(userProfile, key)
              if (profileValue !== undefined) return profileValue
              return undefined
            }
            const dataTypeFor = (key) => mapped[key]?.dataType
            const profileSnapshot = buildProfileSnapshot({ valueFor, userProfile })

            const shiftNameRaw = valueFor('shiftName') ?? valueFor('plan_detail') ?? valueFor('attendanceClass')
            const fieldValues = buildFieldValueMap(row.fields ?? {}, mapped, userProfile)
            augmentFieldValuesWithDates(fieldValues, workDate)
            const holidayMeta = resolveHolidayMeta(context.holiday)
            if (holidayMeta.name) fieldValues.holiday_name = holidayMeta.name
            if (holidayMeta.dayIndex != null) fieldValues.holiday_day_index = holidayMeta.dayIndex
            fieldValues.holiday_first_day = holidayMeta.isFirstDay

            const baseFacts = {
              userId: rowUserId,
              orgId,
              workDate,
              shiftName: shiftNameRaw ?? context.rule?.name ?? null,
              isHoliday: Boolean(context.holiday),
              isWorkingDay: context.isWorkingDay,
            }
            const baseUserGroups = resolveUserGroups(activeRuleSetConfig?.policies?.userGroups, baseFacts, fieldValues)
            const shiftOverride = resolveShiftOverrideFromMappings(
              activeRuleSetConfig?.policies?.shiftMappings,
              baseFacts,
              fieldValues,
              baseUserGroups
            )

            const shiftRange = resolveShiftTimeRange(shiftNameRaw)
            const baseRuleForMetrics = shiftRange ? { ...context.rule, ...shiftRange } : context.rule
            const ruleForMetrics = shiftRange
              ? baseRuleForMetrics
              : (shiftOverride ? { ...context.rule, ...shiftOverride } : baseRuleForMetrics)

            const firstInAt = parseImportedDateTime(valueFor('firstInAt'), workDate, ruleForMetrics.timezone)
            const lastOutAt = parseImportedDateTime(valueFor('lastOutAt'), workDate, ruleForMetrics.timezone)
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
              rule: ruleForMetrics,
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

            const approvalSummary = valueFor('approvalSummary')
              ?? valueFor('attendance_approve')
              ?? valueFor('attendanceApprove')

            const policyBaseMetrics = {
              ...initialMetrics,
              leaveMinutes: leaveMinutes ?? 0,
              overtimeMinutes: overtimeMinutes ?? 0,
            }
            const holidayPolicyContext = buildHolidayPolicyContext({ rowUserId, valueFor, userProfile })
            const holidayPolicyResult = applyHolidayPolicy({
              settings,
              holiday: context.holiday,
              holidayMeta,
              metrics: policyBaseMetrics,
              approvalSummary,
              policyContext: holidayPolicyContext,
            })
            const policyResult = applyAttendancePolicies({
              policies: activeRuleSetConfig?.policies,
              facts: {
                userId: rowUserId,
                orgId,
                workDate,
                shiftName: shiftNameRaw ?? context.rule?.name ?? null,
                isHoliday: Boolean(context.holiday),
                isWorkingDay: context.isWorkingDay,
                holidayName: holidayMeta.name,
                holidayDayIndex: holidayMeta.dayIndex,
                holidayFirstDay: holidayMeta.isFirstDay,
              },
              fieldValues,
              metrics: holidayPolicyResult.metrics,
              options: { skipRules: resolvePolicySkipRules(settings) },
            })
            const effective = policyResult.metrics
            let engineResult = null
            if (engine) {
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
                    holiday_name: holidayMeta.name ?? undefined,
                    holiday_day_index: holidayMeta.dayIndex ?? undefined,
                    holiday_first_day: holidayMeta.isFirstDay,
                    holiday_policy_enabled: Boolean(settings?.holidayPolicy?.firstDayEnabled),
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
              warnings: [...holidayPolicyResult.warnings, ...policyResult.warnings, ...importWarnings],
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

          const combinedWarnings = [...csvWarnings, ...groupWarnings]
          res.json({
            ok: true,
            data: {
              items: preview,
              total: preview.length,
              rowCount: rows.length,
              truncated,
              previewLimit,
              stats: previewStats,
              mappingUsed: mapping,
              csvWarnings: combinedWarnings,
              groupWarnings,
            },
          })
        } catch (error) {
          if (error instanceof HttpError) {
            res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
            return
          }
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
      '/api/attendance/import/commit',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = importPayloadSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

	        const orgId = getOrgId(req)
	        const requesterId = getUserId(req)
	        if (!requesterId) {
	          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId is required' } })
	          return
	        }

	        const idempotencyKey = typeof parsed.data.idempotencyKey === 'string'
	          ? parsed.data.idempotencyKey.trim()
	          : ''
	        if (idempotencyKey) {
	          const existing = await loadIdempotentImportBatch(db, orgId, idempotencyKey)
	          if (existing) {
	            const existingRowCount = existing.imported + existing.skipped
	            res.json({
	              ok: true,
	              data: {
	                batchId: existing.batchId,
	                imported: existing.imported,
	                processedRows: existing.imported,
	                failedRows: existing.skipped,
	                elapsedMs: 0,
	                engine: resolveImportEngineFromMeta(existing.meta, existingRowCount),
	                items: [],
	                skipped: [],
	                csvWarnings: [],
	                groupWarnings: [],
	                meta: existing.meta,
	                idempotent: true,
	              },
	            })
	            return
	          }
	        }

	        const commitToken = parsed.data.commitToken
	        if (!commitToken && requireImportCommitToken) {
	          res.status(400).json({ ok: false, error: { code: 'COMMIT_TOKEN_REQUIRED', message: 'commitToken is required' } })
	          return
        }
	        if (commitToken) {
	          let tokenOk = false
          try {
            tokenOk = await consumeImportCommitToken(commitToken, { db, orgId, userId: requesterId })
          } catch (error) {
            if (error instanceof HttpError) {
              res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
              return
            }
            logger.error('Attendance import token validation failed (commit)', error)
            res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to validate commit token' } })
            return
          }
          if (!tokenOk && requireImportCommitToken) {
            res.status(403).json({ ok: false, error: { code: 'COMMIT_TOKEN_INVALID', message: 'commitToken invalid or expired' } })
            return
          }
	          if (!tokenOk && !requireImportCommitToken) {
	            logger.warn('Attendance import commit token invalid; continuing without enforcement.')
	          }
	        }
	        const commitStartedAtMs = Date.now()

	        try {
          let ruleSetConfig = null
          if (parsed.data.ruleSetId) {
            const rows = await db.query(
              'SELECT config FROM attendance_rule_sets WHERE id = $1 AND org_id = $2',
              [parsed.data.ruleSetId, orgId]
            )
            if (rows.length) ruleSetConfig = normalizeMetadata(rows[0].config)
          }

          const profile = findImportProfile(parsed.data.mappingProfileId)
          const profileMapping = profile?.mapping?.columns ?? profile?.mapping?.fields ?? []
          const mapping = parsed.data.mapping?.columns
            ?? parsed.data.mapping?.fields
            ?? (profileMapping.length ? profileMapping : undefined)
            ?? ruleSetConfig?.mappings?.columns
            ?? ruleSetConfig?.mappings?.fields
            ?? []
          const requiredFields = profile?.requiredFields ?? []
          const punchRequiredFields = profile?.punchRequiredFields ?? []

	          const { rows, csvWarnings, csvFileId } = await resolveImportRows({
	            payload: parsed.data,
	            orgId,
	            fallbackUserId: parsed.data.userId ?? requesterId,
	          })

	          if (rows.length === 0) {
	            res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'No rows to import' } })
	            return
	          }
	          const importEngine = resolveImportEngineByRowCount(rows.length)
	          const importChunkConfig = resolveImportChunkConfig(importEngine)

          const baseRule = await loadDefaultRule(db, orgId)
          const settings = await getSettings(db)
          const groupRuleSetMap = parsed.data.ruleSetId ? new Map() : await loadAttendanceGroupRuleSetMap(db, orgId)
          const groupSync = normalizeGroupSyncOptions(
            parsed.data.groupSync,
            parsed.data.ruleSetId,
            parsed.data.timezone
          )
          const groupNames = groupSync ? collectAttendanceGroupNames(rows) : new Map()
          const groupWarnings = []
          if (groupNames.size && !groupSync?.autoCreate) {
            const groupIdMap = await loadAttendanceGroupIdMap(db, orgId)
            for (const [key, name] of groupNames.entries()) {
              if (!groupIdMap.has(key)) groupWarnings.push(`Attendance group not found: ${name}`)
            }
          }
          if (groupSync?.ruleSetId && !parsed.data.ruleSetId && groupNames.size) {
            for (const key of groupNames.keys()) {
              if (!groupRuleSetMap.has(key)) groupRuleSetMap.set(key, groupSync.ruleSetId)
            }
          }
          const ruleSetConfigCache = new Map()
          if (parsed.data.ruleSetId && ruleSetConfig) {
            ruleSetConfigCache.set(parsed.data.ruleSetId, ruleSetConfig)
          }
          const engineCache = new Map()
          let payloadEngine = null
          if (parsed.data.engine) {
            try {
              payloadEngine = createRuleEngine({ config: parsed.data.engine, logger })
            } catch (error) {
              logger.warn('Attendance rule engine config invalid (commit payload)', error)
            }
          }

	          const statusMap = parsed.data.statusMap ?? {}
	          const returnItems = parsed.data.returnItems !== false
	          const itemsLimit = returnItems && typeof parsed.data.itemsLimit === 'number'
	            ? parsed.data.itemsLimit
	            : null
	          const results = []
	          let importedCount = 0
	          const skipped = []
	          const idempotencyEnabled = Boolean(idempotencyKey) && await hasImportBatchIdempotencyColumn(db)
	          const batchId = randomUUID()
	          let batchMeta = null
	          let idempotentInTransaction = null

          await db.transaction(async (trx) => {
            if (idempotencyKey) {
              await acquireImportIdempotencyLock(trx, orgId, idempotencyKey)
              const existing = await loadIdempotentImportBatch(trx, orgId, idempotencyKey)
              if (existing) {
                idempotentInTransaction = existing
                return
              }
            }

            let groupIdMap = null
            let groupCreated = 0
            if (groupSync) {
              groupIdMap = await loadAttendanceGroupIdMap(trx, orgId)
              if (groupSync.autoCreate && groupNames.size) {
                const ensured = await ensureAttendanceGroups(trx, orgId, groupNames, {
                  ruleSetId: groupSync.ruleSetId,
                  timezone: groupSync.timezone,
                })
                groupIdMap = ensured.map
                groupCreated = ensured.created
              }
            }
            const groupMembersToInsert = new Map()
	            batchMeta = {
	              ...(parsed.data.batchMeta ?? {}),
	              idempotencyKey: idempotencyKey || undefined,
	              engine: importEngine,
	              chunkConfig: importChunkConfig,
	              mappingProfileId: parsed.data.mappingProfileId ?? null,
	              groupSync: groupSync
	                ? {
                    autoCreate: groupSync.autoCreate,
                    autoAssignMembers: groupSync.autoAssignMembers,
                    ruleSetId: groupSync.ruleSetId,
                    timezone: groupSync.timezone,
                  }
	                : undefined,
	              groupCreated,
	            }
	            const batchInsert = idempotencyEnabled
	              ? {
	                  sql: `INSERT INTO attendance_import_batches
	                   (id, org_id, idempotency_key, created_by, source, rule_set_id, mapping, row_count, status, meta, created_at, updated_at)
	                   VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, now(), now())`,
	                  params: [
	                    batchId,
	                    orgId,
	                    idempotencyKey,
	                    requesterId,
	                    parsed.data.source ?? null,
	                    parsed.data.ruleSetId ?? null,
	                    JSON.stringify(mapping),
	                    rows.length,
	                    'committed',
	                    JSON.stringify(batchMeta),
	                  ],
	                }
	              : {
	                  sql: `INSERT INTO attendance_import_batches
	                   (id, org_id, created_by, source, rule_set_id, mapping, row_count, status, meta, created_at, updated_at)
	                   VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, now(), now())`,
	                  params: [
	                    batchId,
	                    orgId,
	                    requesterId,
	                    parsed.data.source ?? null,
	                    parsed.data.ruleSetId ?? null,
	                    JSON.stringify(mapping),
	                    rows.length,
	                    'committed',
	                    JSON.stringify(batchMeta),
	                  ],
	                }
		            await trx.query(batchInsert.sql, batchInsert.params)

			            const importItemsBuffer = []
			            const flushImportItems = async () => {
			              if (!importItemsBuffer.length) return
			              const chunk = importItemsBuffer.splice(0, importItemsBuffer.length)
			              await batchInsertAttendanceImportItems(trx, {
			                batchId,
			                orgId,
			                items: chunk,
			              })
			            }
				            const enqueueImportItem = async ({ userId, workDate, recordId, previewSnapshot }) => {
				              importItemsBuffer.push({
				                id: randomUUID(),
			                userId: userId ?? null,
			                workDate: workDate ?? null,
			                recordId: recordId ?? null,
			                previewSnapshot: JSON.stringify(previewSnapshot ?? {}),
			              })
			              if (importItemsBuffer.length >= importChunkConfig.itemsChunkSize) {
			                await flushImportItems()
			              }
			            }

			            // Prefetch holidays + scheduling assignments for the import scope to reduce per-row DB roundtrips.
			            const scopeWorkDates = new Set()
			            const scopeUserIds = new Set()
			            for (const row of rows) {
			              const workDate = row?.workDate
			              if (typeof workDate === 'string' && workDate.trim()) scopeWorkDates.add(workDate.trim())
			              const rowUserId = resolveRowUserId({
			                row,
			                fallbackUserId: requesterId,
			                userMap: parsed.data.userMap,
			                userMapKeyField: parsed.data.userMapKeyField,
			                userMapSourceFields: parsed.data.userMapSourceFields,
			              })
			              if (rowUserId) scopeUserIds.add(rowUserId)
			            }
			            const scopeWorkDateList = Array.from(scopeWorkDates)
			            const scopeUserIdList = Array.from(scopeUserIds)
			            let scopeFromDate = null
			            let scopeToDate = null
			            for (const dateKey of scopeWorkDateList) {
			              if (!scopeFromDate || dateKey < scopeFromDate) scopeFromDate = dateKey
			              if (!scopeToDate || dateKey > scopeToDate) scopeToDate = dateKey
			            }
			            const scopeSpanDays = scopeFromDate && scopeToDate ? Math.max(0, diffDays(scopeFromDate, scopeToDate)) + 1 : 0
			            const shouldPrefetchWorkContext = Boolean(
			              scopeFromDate
			              && scopeToDate
			              && scopeUserIdList.length <= ATTENDANCE_IMPORT_PREFETCH_MAX_USERS
			              && scopeWorkDateList.length <= ATTENDANCE_IMPORT_PREFETCH_MAX_WORK_DATES
			              && scopeSpanDays <= ATTENDANCE_IMPORT_PREFETCH_MAX_SPAN_DAYS
			            )
			            const prefetchedWorkContext = {
			              holidaysByDate: new Map(),
			              shiftAssignmentsByUser: new Map(),
			              rotationAssignmentsByUser: new Map(),
			              rotationShiftsById: new Map(),
			            }
			            if (shouldPrefetchWorkContext) {
			              prefetchedWorkContext.holidaysByDate = await loadHolidayMapByDates(trx, orgId, scopeWorkDateList)
			              prefetchedWorkContext.shiftAssignmentsByUser = await loadShiftAssignmentMapForUsersRange(
			                trx,
			                orgId,
			                scopeUserIdList,
			                scopeFromDate,
			                scopeToDate
			              )
			              const rotationPrefetch = await loadRotationAssignmentMapForUsersRange(
			                trx,
			                orgId,
			                scopeUserIdList,
			                scopeFromDate,
			                scopeToDate
			              )
			              prefetchedWorkContext.rotationAssignmentsByUser = rotationPrefetch.assignmentsByUser
			              prefetchedWorkContext.rotationShiftsById = rotationPrefetch.shiftsById
			            } else if (scopeUserIdList.length || scopeWorkDateList.length) {
			              logger.info('Attendance import scope prefetch skipped due to limits', {
			                orgId,
			                users: scopeUserIdList.length,
			                workDates: scopeWorkDateList.length,
			                spanDays: scopeSpanDays,
			                maxUsers: ATTENDANCE_IMPORT_PREFETCH_MAX_USERS,
			                maxWorkDates: ATTENDANCE_IMPORT_PREFETCH_MAX_WORK_DATES,
			                maxSpanDays: ATTENDANCE_IMPORT_PREFETCH_MAX_SPAN_DAYS,
			              })
			            }

			            // Bulk-prefetch existing attendance_records to avoid per-row SELECT ... FOR UPDATE.
			            const recordUpsertsBuffer = []
			            const flushRecordUpserts = async () => {
			              if (!recordUpsertsBuffer.length) return
			              const chunk = recordUpsertsBuffer.splice(0, recordUpsertsBuffer.length)
			              const chunkUserIds = chunk.map((item) => item.userId)
			              const chunkWorkDates = chunk.map((item) => item.workDate)

			              const existingRows = await trx.query(
			                `SELECT ar.*
			                 FROM attendance_records ar
			                 JOIN unnest($2::text[], $3::date[]) AS t(user_id, work_date)
			                   ON ar.user_id = t.user_id AND ar.work_date = t.work_date
			                 WHERE ar.org_id = $1
			                 FOR UPDATE`,
				                [orgId, chunkUserIds, chunkWorkDates]
				              )
				              const existingMap = new Map()
				              for (const row of existingRows) {
				                const workDateKey = normalizeDateOnly(row.work_date) ?? row.work_date
				                existingMap.set(`${row.user_id}:${workDateKey}`, row)
				              }

				              const upsertRows = []
				              for (const item of chunk) {
				                const workDateKey = normalizeDateOnly(item.workDate) ?? item.workDate
				                const existingRow = existingMap.get(`${item.userId}:${workDateKey}`) ?? undefined
				                const values = computeAttendanceRecordUpsertValues({
				                  existingRow,
				                  updateFirstInAt: item.updateFirstInAt,
				                  updateLastOutAt: item.updateLastOutAt,
				                  mode: item.mode,
				                  statusOverride: item.statusOverride,
				                  overrideMetrics: item.overrideMetrics,
				                  isWorkday: item.isWorkday,
				                  meta: item.meta,
				                  sourceBatchId: item.sourceBatchId,
				                  rule: item.rule,
				                  leaveMinutes: item.leaveMinutes,
				                  overtimeMinutes: item.overtimeMinutes,
				                })
				                upsertRows.push({
				                  userId: item.userId,
				                  orgId,
				                  workDate: workDateKey,
				                  timezone: item.timezone,
				                  firstInAt: values.firstInAt,
				                  lastOutAt: values.lastOutAt,
				                  workMinutes: values.workMinutes,
				                  lateMinutes: values.lateMinutes,
				                  earlyLeaveMinutes: values.earlyLeaveMinutes,
				                  status: values.status,
				                  isWorkday: values.isWorkday,
				                  metaJson: values.metaJson,
				                  sourceBatchId: values.sourceBatchId,
				                })
				              }

				              const upserted = await batchUpsertAttendanceRecords(trx, upsertRows)

				              for (const item of chunk) {
				                const workDateKey = normalizeDateOnly(item.workDate) ?? item.workDate
				                const record = upserted.get(`${item.userId}:${workDateKey}`)
				                if (!record?.id) {
				                  throw new Error(`Attendance record upsert failed for ${item.userId}:${workDateKey}`)
				                }

				                await enqueueImportItem({
				                  userId: item.userId,
				                  workDate: workDateKey,
				                  recordId: record.id,
				                  previewSnapshot: item.previewSnapshot,
				                })

				                importedCount += 1
				                if (returnItems && (!itemsLimit || results.length < itemsLimit)) {
				                  results.push({
				                    id: record.id,
				                    userId: item.userId,
				                    workDate: workDateKey,
				                    engine: item.engine,
				                  })
				                }
				              }
				            }
				            const enqueueRecordUpsert = async (item) => {
				              recordUpsertsBuffer.push(item)
				              if (recordUpsertsBuffer.length >= importChunkConfig.recordsChunkSize) {
			                await flushRecordUpserts()
			              }
			            }

			            const seenRowKeys = new Set()
			            for (const row of rows) {
			              const workDate = row.workDate
			              const groupKey = resolveAttendanceGroupKey(row)
			              const rowUserId = resolveRowUserId({
                row,
                fallbackUserId: requesterId,
                userMap: parsed.data.userMap,
                userMapKeyField: parsed.data.userMapKeyField,
                userMapSourceFields: parsed.data.userMapSourceFields,
              })
              const userProfile = resolveRowUserProfile({
                row,
                fallbackUserId: requesterId,
                userMap: parsed.data.userMap,
                userMapKeyField: parsed.data.userMapKeyField,
                userMapSourceFields: parsed.data.userMapSourceFields,
              })
              const importWarnings = []
              if (!rowUserId) importWarnings.push('Missing userId')
              if (!workDate) importWarnings.push('Missing workDate')
              if (requiredFields.length) {
                const missingRequired = requiredFields.filter((field) => {
                  const value = resolveRequiredFieldValue(row, field)
                  return value === undefined || value === null || value === ''
                })
                if (missingRequired.length) {
                  importWarnings.push(`Missing required: ${missingRequired.join(', ')}`)
                }
              }
	              if (punchRequiredFields.length && shouldEnforcePunchRequired(row)) {
	                const missingPunch = punchRequiredFields.filter((field) => {
	                  const value = resolveRequiredFieldValue(row, field)
	                  return value === undefined || value === null || value === ''
	                })
	                if (missingPunch.length) {
	                  importWarnings.push(`Missing required: ${missingPunch.join(', ')}`)
	                }
	              }
		              if (importWarnings.length) {
		                const snapshot = buildSkippedImportSnapshot({ warnings: importWarnings, row, reason: 'validation' })
		                await enqueueImportItem({
		                  userId: rowUserId ?? null,
		                  workDate: workDate ?? null,
		                  recordId: null,
		                  previewSnapshot: snapshot,
		                })
		                skipped.push({
		                  userId: rowUserId ?? null,
		                  workDate: workDate ?? null,
		                  warnings: importWarnings,
		                })
		                releaseImportRowMemory(row)
	                continue
	              }

		              const dedupKey = `${rowUserId}:${workDate}`
		              if (seenRowKeys.has(dedupKey)) {
		                const warnings = ['Duplicate row in payload (same userId + workDate)']
		                const snapshot = buildSkippedImportSnapshot({ warnings, row, reason: 'duplicate' })
		                await enqueueImportItem({
		                  userId: rowUserId,
		                  workDate,
		                  recordId: null,
		                  previewSnapshot: snapshot,
		                })
		                skipped.push({ userId: rowUserId, workDate, warnings })
		                releaseImportRowMemory(row)
		                continue
		              }
	              seenRowKeys.add(dedupKey)
	              if (groupSync?.autoAssignMembers && groupKey && rowUserId && groupIdMap && groupIdMap.has(groupKey)) {
	                const groupEntry = groupIdMap.get(groupKey)
	                if (groupEntry?.id) {
	                  groupMembersToInsert.set(`${groupEntry.id}:${rowUserId}`, { groupId: groupEntry.id, userId: rowUserId })
	                }
	              }
              let activeRuleSetId = parsed.data.ruleSetId ?? null
              let activeRuleSetConfig = ruleSetConfig
              if (!activeRuleSetId && groupRuleSetMap.size) {
                if (groupKey && groupRuleSetMap.has(groupKey)) {
                  activeRuleSetId = groupRuleSetMap.get(groupKey)
                }
              }
              if (!activeRuleSetConfig && activeRuleSetId) {
                if (ruleSetConfigCache.has(activeRuleSetId)) {
                  activeRuleSetConfig = ruleSetConfigCache.get(activeRuleSetId)
                } else {
                  activeRuleSetConfig = await loadRuleSetConfigById(db, orgId, activeRuleSetId)
                  ruleSetConfigCache.set(activeRuleSetId, activeRuleSetConfig)
                }
              }

              const override = normalizeRuleOverride(activeRuleSetConfig?.rule)
              const ruleOverride = override
                ? { ...baseRule, ...override, workingDays: override.workingDays ?? baseRule.workingDays }
                : baseRule

              let engine = payloadEngine
              if (!engine && activeRuleSetConfig?.engine) {
                if (activeRuleSetId && engineCache.has(activeRuleSetId)) {
                  engine = engineCache.get(activeRuleSetId)
                } else {
                  try {
                    engine = createRuleEngine({ config: activeRuleSetConfig.engine, logger })
                    if (activeRuleSetId) engineCache.set(activeRuleSetId, engine)
	                  } catch (error) {
	                    logger.warn('Attendance rule engine config invalid (rule set)', error)
	                  }
	                }
	              }
	              const context = resolveWorkContextFromPrefetch({
	                orgId,
	                userId: rowUserId,
	                workDate,
	                defaultRule: ruleOverride,
	                prefetched: prefetchedWorkContext,
	              }) ?? await resolveWorkContext({
	                db: trx,
	                orgId,
	                userId: rowUserId,
	                workDate,
	                defaultRule: ruleOverride,
	              })
              const mapped = applyFieldMappings(row.fields ?? {}, mapping)
              const valueFor = (key) => {
                if (mapped[key]?.value !== undefined) return mapped[key].value
                if (row.fields?.[key] !== undefined) return row.fields[key]
                const profileValue = resolveProfileValue(userProfile, key)
                if (profileValue !== undefined) return profileValue
                return undefined
              }
              const dataTypeFor = (key) => mapped[key]?.dataType
              const profileSnapshot = buildProfileSnapshot({ valueFor, userProfile })

              const shiftNameRaw = valueFor('shiftName') ?? valueFor('plan_detail') ?? valueFor('attendanceClass')
              const fieldValues = buildFieldValueMap(row.fields ?? {}, mapped, userProfile)
              augmentFieldValuesWithDates(fieldValues, workDate)
              const holidayMeta = resolveHolidayMeta(context.holiday)
              if (holidayMeta.name) fieldValues.holiday_name = holidayMeta.name
              if (holidayMeta.dayIndex != null) fieldValues.holiday_day_index = holidayMeta.dayIndex
              fieldValues.holiday_first_day = holidayMeta.isFirstDay

              const baseFacts = {
                userId: rowUserId,
                orgId,
                workDate,
                shiftName: shiftNameRaw ?? context.rule?.name ?? null,
                isHoliday: Boolean(context.holiday),
                isWorkingDay: context.isWorkingDay,
              }
              const baseUserGroups = resolveUserGroups(activeRuleSetConfig?.policies?.userGroups, baseFacts, fieldValues)
              const shiftOverride = resolveShiftOverrideFromMappings(
                activeRuleSetConfig?.policies?.shiftMappings,
                baseFacts,
                fieldValues,
                baseUserGroups
              )

              const shiftRange = resolveShiftTimeRange(shiftNameRaw)
              const baseRuleForMetrics = shiftRange ? { ...context.rule, ...shiftRange } : context.rule
              const ruleForMetrics = shiftRange
                ? baseRuleForMetrics
                : (shiftOverride ? { ...context.rule, ...shiftOverride } : baseRuleForMetrics)

              const firstInAt = parseImportedDateTime(valueFor('firstInAt'), workDate, ruleForMetrics.timezone)
              const lastOutAt = parseImportedDateTime(valueFor('lastOutAt'), workDate, ruleForMetrics.timezone)
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
                rule: ruleForMetrics,
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

              const approvalSummary = valueFor('approvalSummary')
                ?? valueFor('attendance_approve')
                ?? valueFor('attendanceApprove')

              const policyBaseMetrics = {
                ...initialMetrics,
                leaveMinutes: leaveMinutes ?? 0,
                overtimeMinutes: overtimeMinutes ?? 0,
              }
              const holidayPolicyContext = buildHolidayPolicyContext({ rowUserId, valueFor, userProfile })
              const holidayPolicyResult = applyHolidayPolicy({
                settings,
                holiday: context.holiday,
                holidayMeta,
                metrics: policyBaseMetrics,
                approvalSummary,
                policyContext: holidayPolicyContext,
              })
              const policyResult = applyAttendancePolicies({
                policies: activeRuleSetConfig?.policies,
                facts: {
                  userId: rowUserId,
                  orgId,
                  workDate,
                  shiftName: shiftNameRaw ?? context.rule?.name ?? null,
                  isHoliday: Boolean(context.holiday),
                  isWorkingDay: context.isWorkingDay,
                  holidayName: holidayMeta.name,
                  holidayDayIndex: holidayMeta.dayIndex,
                  holidayFirstDay: holidayMeta.isFirstDay,
                },
                fieldValues,
                metrics: holidayPolicyResult.metrics,
                options: { skipRules: resolvePolicySkipRules(settings) },
              })
              const effective = policyResult.metrics
              let engineResult = null
              if (engine) {
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
                    holiday_name: holidayMeta.name ?? undefined,
                    holiday_day_index: holidayMeta.dayIndex ?? undefined,
                    holiday_first_day: holidayMeta.isFirstDay,
                    holiday_policy_enabled: Boolean(settings?.holidayPolicy?.firstDayEnabled),
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

              const policyWarnings = [...holidayPolicyResult.warnings, ...policyResult.warnings]
              let meta = null
              if (policyWarnings.length || policyResult.appliedRules.length || policyResult.userGroups.length) {
                meta = {
                  policy: {
                    warnings: policyWarnings,
                    appliedRules: policyResult.appliedRules,
                    userGroups: policyResult.userGroups,
                  },
                }
              }
              if (profileSnapshot) {
                meta = meta ?? {}
                meta.profile = profileSnapshot
              }
              meta = meta ?? {}
              meta.metrics = {
                leaveMinutes: effectiveLeaveMinutes,
                overtimeMinutes: effectiveOvertimeMinutes,
              }
              meta.source = {
                source: parsed.data.source ?? null,
                mappingProfileId: parsed.data.mappingProfileId ?? null,
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

	              const snapshot = {
	                metrics: {
	                  workMinutes: finalMetrics.workMinutes,
	                  lateMinutes: finalMetrics.lateMinutes,
                  earlyLeaveMinutes: finalMetrics.earlyLeaveMinutes,
                  leaveMinutes: effectiveLeaveMinutes,
                  overtimeMinutes: effectiveOvertimeMinutes,
                  status: finalMetrics.status,
                },
	                policy: meta?.policy ?? null,
	                engine: meta?.engine ?? null,
	              }
	              await enqueueRecordUpsert({
	                userId: rowUserId,
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
	                sourceBatchId: batchId,
	                previewSnapshot: snapshot,
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
	              releaseImportRowMemory(row)
			            }

			            await flushRecordUpserts()
			            await flushImportItems()

		            if (groupSync?.autoAssignMembers && groupMembersToInsert.size) {
		              const groupMembersAdded = await insertAttendanceGroupMembers(
		                trx,
		                orgId,
                Array.from(groupMembersToInsert.values())
              )
              if (batchMeta) {
                batchMeta.groupMembersAdded = groupMembersAdded
                await trx.query(
                  'UPDATE attendance_import_batches SET meta = $3::jsonb, updated_at = now() WHERE id = $1 AND org_id = $2',
                  [batchId, orgId, JSON.stringify(batchMeta)]
                )
              }
            }
            if (skipped.length) {
              const updatedMeta = {
                ...(batchMeta ?? {}),
                skippedCount: skipped.length,
                skippedRows: skipped.slice(0, 50),
              }
              await trx.query(
                'UPDATE attendance_import_batches SET meta = $3::jsonb, updated_at = now() WHERE id = $1 AND org_id = $2',
                [batchId, orgId, JSON.stringify(updatedMeta)]
              )
              batchMeta = updatedMeta
	            }
	          })

	          // Best-effort cleanup: once commit succeeds, the uploaded CSV is no longer needed.
	          if (csvFileId) {
	            await deleteImportUpload({ orgId, fileId: csvFileId })
	          }

	          if (idempotentInTransaction) {
	            const idempotentRowCount = idempotentInTransaction.imported + idempotentInTransaction.skipped
	            res.json({
	              ok: true,
	              data: {
	                batchId: idempotentInTransaction.batchId,
	                imported: idempotentInTransaction.imported,
	                processedRows: idempotentInTransaction.imported,
	                failedRows: idempotentInTransaction.skipped,
	                elapsedMs: Math.max(0, Date.now() - commitStartedAtMs),
	                engine: resolveImportEngineFromMeta(
	                  idempotentInTransaction.meta,
	                  idempotentRowCount
	                ),
	                items: [],
	                skipped: [],
                csvWarnings: [],
                groupWarnings: [],
                meta: idempotentInTransaction.meta,
                idempotent: true,
              },
            })
            return
          }

	          res.json({
	            ok: true,
	            data: {
	              batchId,
	              imported: importedCount,
	              processedRows: importedCount,
	              failedRows: skipped.length,
	              elapsedMs: Math.max(0, Date.now() - commitStartedAtMs),
	              engine: importEngine,
	              items: returnItems ? results : [],
	              itemsTruncated: Boolean(returnItems && itemsLimit && importedCount > results.length),
              skipped,
              csvWarnings: [...csvWarnings, ...groupWarnings],
              groupWarnings,
              meta: batchMeta,
            },
          })
	        } catch (error) {
	          if (error instanceof HttpError) {
	            res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
	            return
	          }
	          if (isDatabaseSchemaError(error)) {
	            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
	            return
	          }
	          const maybeConstraint = String(error?.constraint ?? '')
	          const isIdempotencyUnique = Boolean(idempotencyKey)
	            && String(error?.code ?? '') === '23505'
	            && maybeConstraint.includes('uq_attendance_import_batches_idempotency_key')
		          if (isIdempotencyUnique && await hasImportBatchIdempotencyColumn(db)) {
		            try {
		              const existing = await loadIdempotentImportBatch(db, orgId, idempotencyKey)
			              if (existing) {
			                const existingRowCount = existing.imported + existing.skipped
			                res.json({
			                  ok: true,
			                  data: {
			                    batchId: existing.batchId,
			                    imported: existing.imported,
			                    processedRows: existing.imported,
			                    failedRows: existing.skipped,
			                    elapsedMs: 0,
			                    engine: resolveImportEngineFromMeta(existing.meta, existingRowCount),
			                    items: [],
			                    skipped: [],
			                    csvWarnings: [],
	                    groupWarnings: [],
	                    meta: existing.meta,
	                    idempotent: true,
	                  },
	                })
	                return
	              }
	            } catch (_error) {
	              // Fall through to generic error response.
	            }
	          }
	          logger.error('Attendance import commit failed', error)
	          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to import attendance' } })
	        }
      })
    )

    // Async preview endpoint for ultra-large imports. Enqueues preview computation and lets clients
    // poll /api/attendance/import/jobs/:id for completion + preview payload.
    context.api.http.addRoute(
      'POST',
      '/api/attendance/import/preview-async',
      withPermission('attendance:admin', async (req, res) => {
        if (!ATTENDANCE_IMPORT_PREVIEW_ASYNC_ENABLED) {
          res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Async preview disabled' } })
          return
        }

        const parsed = importPayloadSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const requesterId = getUserId(req)
        if (!requesterId) {
          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
          return
        }

        const rawIdempotencyKey = typeof parsed.data.idempotencyKey === 'string'
          ? parsed.data.idempotencyKey.trim()
          : ''
        const previewJobIdempotencyKey = toPreviewJobIdempotencyKey(rawIdempotencyKey)
        if (previewJobIdempotencyKey) {
          try {
            const existingJob = await loadImportJobByIdempotencyKey(orgId, previewJobIdempotencyKey)
            if (existingJob) {
              res.json({ ok: true, data: { job: mapImportJobRow(existingJob), idempotent: true } })
              return
            }
          } catch (error) {
            if (isDatabaseSchemaError(error)) {
              res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
              return
            }
            // Fall through and attempt to create a job.
          }
        }

        const commitToken = parsed.data.commitToken
        if (!commitToken && requireImportCommitToken) {
          res.status(400).json({ ok: false, error: { code: 'COMMIT_TOKEN_REQUIRED', message: 'commitToken is required' } })
          return
        }
        if (commitToken) {
          let tokenOk = false
          try {
            tokenOk = await consumeImportCommitToken(commitToken, { db, orgId, userId: requesterId })
          } catch (error) {
            if (error instanceof HttpError) {
              res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
              return
            }
            logger.error('Attendance import token validation failed (async preview)', error)
            res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to validate commit token' } })
            return
          }
          if (!tokenOk && requireImportCommitToken) {
            res.status(403).json({ ok: false, error: { code: 'COMMIT_TOKEN_INVALID', message: 'commitToken invalid or expired' } })
            return
          }
          if (!tokenOk && !requireImportCommitToken) {
            logger.warn('Attendance import preview token invalid; continuing without enforcement.')
          }
        }

	        try {
	          const jobId = randomUUID()
	          const batchId = randomUUID()
	          let total = 0
	          if (Array.isArray(parsed.data.rows)) total = parsed.data.rows.length
	          else if (Array.isArray(parsed.data.entries)) total = parsed.data.entries.length
	          else if (typeof parsed.data.csvFileId === 'string' && parsed.data.csvFileId.trim()) {
	            const meta = await loadImportUploadMeta({ orgId, fileId: parsed.data.csvFileId.trim() })
	            if (meta && isImportUploadExpired(meta)) {
	              throw new HttpError(410, 'EXPIRED', 'Import upload expired')
	            }
	            const hint = Number(meta?.rowCount ?? 0)
	            total = Number.isFinite(hint) && hint > 0 ? hint : 0
	          }
	          else if (typeof parsed.data.csvText === 'string') total = estimateCsvRowCount(parsed.data.csvText)

	          const sanitizedPayload = sanitizeImportJobPayload({
	            ...parsed.data,
	            __jobType: 'preview',
	            __importEngine: resolveImportEngineByRowCount(total),
	            previewLimit: normalizePreviewAsyncLimit(parsed.data.previewLimit),
	            idempotencyKey: rawIdempotencyKey || undefined,
	          })

          await db.query(
            `INSERT INTO attendance_import_jobs
             (id, org_id, batch_id, created_by, idempotency_key, status, progress, total, payload, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now())`,
            [
              jobId,
              orgId,
              batchId,
              requesterId,
              previewJobIdempotencyKey || null,
              'queued',
              0,
              total,
              JSON.stringify(sanitizedPayload),
            ]
          )

          const jobRow = await loadImportJob(jobId, orgId)
          if (!jobRow) {
            res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create preview job' } })
            return
          }
          await enqueueImportJob(jobId)
          res.json({ ok: true, data: { job: mapImportJobRow(jobRow) } })
        } catch (error) {
          if (error instanceof HttpError) {
            res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
            return
          }
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          const maybeConstraint = String(error?.constraint ?? '')
          const isIdempotencyUnique = Boolean(previewJobIdempotencyKey)
            && String(error?.code ?? '') === '23505'
            && maybeConstraint.includes('uq_attendance_import_jobs_idempotency')
          if (isIdempotencyUnique) {
            try {
              const existingJob = await loadImportJobByIdempotencyKey(orgId, previewJobIdempotencyKey)
              if (existingJob) {
                res.json({ ok: true, data: { job: mapImportJobRow(existingJob), idempotent: true } })
                return
              }
            } catch (_error) {
              // Fall through to generic error response.
            }
          }
          logger.error('Attendance import async preview failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to enqueue preview job' } })
        }
      })
    )

    // Async commit endpoint for large imports. Returns a durable job record and processes the
    // commit out-of-band so clients can poll progress without holding an HTTP request open.
    context.api.http.addRoute(
      'POST',
      '/api/attendance/import/commit-async',
      withPermission('attendance:admin', async (req, res) => {
        if (!ATTENDANCE_IMPORT_ASYNC_ENABLED) {
          res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Async import disabled' } })
          return
        }

        const parsed = importPayloadSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const requesterId = getUserId(req)
        if (!requesterId) {
          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
          return
        }

        const cleanIdempotencyKey = typeof parsed.data.idempotencyKey === 'string'
          ? parsed.data.idempotencyKey.trim()
          : ''

        // First: dedupe retries without consuming a new commit token.
        if (cleanIdempotencyKey) {
          try {
            const existingJob = await loadImportJobByIdempotencyKey(orgId, cleanIdempotencyKey)
            if (existingJob) {
              res.json({ ok: true, data: { job: mapImportJobRow(existingJob), idempotent: true } })
              return
            }
          } catch (error) {
            if (isDatabaseSchemaError(error)) {
              res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
              return
            }
            // Fall through and attempt to create a job.
          }
        }

        const commitToken = parsed.data.commitToken
        if (!commitToken && requireImportCommitToken) {
          res.status(400).json({ ok: false, error: { code: 'COMMIT_TOKEN_REQUIRED', message: 'commitToken is required' } })
          return
        }
        if (commitToken) {
          let tokenOk = false
          try {
            tokenOk = await consumeImportCommitToken(commitToken, { db, orgId, userId: requesterId })
          } catch (error) {
            if (error instanceof HttpError) {
              res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
              return
            }
            logger.error('Attendance import token validation failed (async commit)', error)
            res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to validate commit token' } })
            return
          }
          if (!tokenOk && requireImportCommitToken) {
            res.status(403).json({ ok: false, error: { code: 'COMMIT_TOKEN_INVALID', message: 'commitToken invalid or expired' } })
            return
          }
          if (!tokenOk && !requireImportCommitToken) {
            logger.warn('Attendance import commit token invalid; continuing without enforcement.')
          }
        }

	        try {
	          const jobId = randomUUID()
	          const batchId = randomUUID()
	          let total = 0
	          if (Array.isArray(parsed.data.rows)) total = parsed.data.rows.length
	          else if (Array.isArray(parsed.data.entries)) total = parsed.data.entries.length
	          else if (typeof parsed.data.csvFileId === 'string' && parsed.data.csvFileId.trim()) {
	            const meta = await loadImportUploadMeta({ orgId, fileId: parsed.data.csvFileId.trim() })
	            if (meta && isImportUploadExpired(meta)) {
	              throw new HttpError(410, 'EXPIRED', 'Import upload expired')
	            }
	            const hint = Number(meta?.rowCount ?? 0)
	            total = Number.isFinite(hint) && hint > 0 ? hint : 0
	          }
	          else if (typeof parsed.data.csvText === 'string') total = estimateCsvRowCount(parsed.data.csvText)

	          const sanitizedPayload = sanitizeImportJobPayload({
	            ...parsed.data,
	            __importEngine: resolveImportEngineByRowCount(total),
	          })

          const status = 'queued'
          await db.query(
            `INSERT INTO attendance_import_jobs
             (id, org_id, batch_id, created_by, idempotency_key, status, progress, total, payload, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now())`,
            [
              jobId,
              orgId,
              batchId,
              requesterId,
              cleanIdempotencyKey || null,
              status,
              0,
              total,
              JSON.stringify(sanitizedPayload),
            ]
          )

          const jobRow = await loadImportJob(jobId, orgId)
          if (!jobRow) {
            res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create import job' } })
            return
          }

          await enqueueImportJob(jobId)

          res.json({ ok: true, data: { job: mapImportJobRow(jobRow) } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }

          // Race on idempotencyKey (unique index) - return the existing job.
          const maybeConstraint = String(error?.constraint ?? '')
          const isIdempotencyUnique = Boolean(cleanIdempotencyKey)
            && String(error?.code ?? '') === '23505'
            && maybeConstraint.includes('uq_attendance_import_jobs_idempotency')
          if (isIdempotencyUnique) {
            try {
              const existingJob = await loadImportJobByIdempotencyKey(orgId, cleanIdempotencyKey)
              if (existingJob) {
                res.json({ ok: true, data: { job: mapImportJobRow(existingJob), idempotent: true } })
                return
              }
            } catch (_error) {
              // Fall through to generic error response.
            }
          }

          logger.error('Attendance import async commit failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to enqueue import job' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/import/jobs/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const jobId = String(req.params?.id ?? '').trim()
        if (!jobId) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'jobId is required' } })
          return
        }
        try {
          const row = await loadImportJob(jobId, orgId)
          if (!row) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Import job not found' } })
            return
          }
          res.json({ ok: true, data: mapImportJobRow(row) })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance import job query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load import job' } })
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
        const requesterId = getUserId(req)
        const userId = parsed.data.userId ?? requesterId
        if (!userId) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId is required' } })
          return
        }
        if (requireImportCommitToken) {
          if (!requesterId) {
            res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
            return
          }
          const commitToken = parsed.data.commitToken
          if (!commitToken) {
            res.status(400).json({ ok: false, error: { code: 'COMMIT_TOKEN_REQUIRED', message: 'commitToken is required' } })
            return
          }
          let tokenOk = false
          try {
            tokenOk = await consumeImportCommitToken(commitToken, { db, orgId, userId: requesterId })
          } catch (error) {
            if (error instanceof HttpError) {
              res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } })
              return
            }
            logger.error('Attendance import token validation failed (legacy import)', error)
            res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to validate commit token' } })
            return
          }
          if (!tokenOk) {
            res.status(403).json({ ok: false, error: { code: 'COMMIT_TOKEN_INVALID', message: 'commitToken invalid or expired' } })
            return
          }
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

          const profile = findImportProfile(parsed.data.mappingProfileId)
          const profileMapping = profile?.mapping?.columns ?? profile?.mapping?.fields ?? []
          const mapping = parsed.data.mapping?.columns
            ?? parsed.data.mapping?.fields
            ?? (profileMapping.length ? profileMapping : undefined)
            ?? ruleSetConfig?.mappings?.columns
            ?? ruleSetConfig?.mappings?.fields
            ?? []
          const requiredFields = profile?.requiredFields ?? []
          const punchRequiredFields = profile?.punchRequiredFields ?? []

	          const { rows, csvWarnings, csvFileId } = await resolveImportRows({
	            payload: parsed.data,
	            orgId,
	            fallbackUserId: parsed.data.userId ?? userId,
	          })

	          if (rows.length === 0) {
	            res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'No rows to import' } })
	            return
	          }
	          const importEngine = resolveImportEngineByRowCount(rows.length)

          const baseRule = await loadDefaultRule(db, orgId)
          const settings = await getSettings(db)
          const groupRuleSetMap = parsed.data.ruleSetId ? new Map() : await loadAttendanceGroupRuleSetMap(db, orgId)
          const groupSync = normalizeGroupSyncOptions(
            parsed.data.groupSync,
            parsed.data.ruleSetId,
            parsed.data.timezone
          )
          const groupNames = groupSync ? collectAttendanceGroupNames(rows) : new Map()
          const groupWarnings = []
          if (groupNames.size && !groupSync?.autoCreate) {
            const groupIdMap = await loadAttendanceGroupIdMap(db, orgId)
            for (const [key, name] of groupNames.entries()) {
              if (!groupIdMap.has(key)) groupWarnings.push(`Attendance group not found: ${name}`)
            }
          }
          if (groupSync?.ruleSetId && !parsed.data.ruleSetId && groupNames.size) {
            for (const key of groupNames.keys()) {
              if (!groupRuleSetMap.has(key)) groupRuleSetMap.set(key, groupSync.ruleSetId)
            }
          }

          const ruleSetConfigCache = new Map()
          if (parsed.data.ruleSetId && ruleSetConfig) {
            ruleSetConfigCache.set(parsed.data.ruleSetId, ruleSetConfig)
          }

          const engineCache = new Map()
          let payloadEngine = null
          if (parsed.data.engine) {
            try {
              payloadEngine = createRuleEngine({ config: parsed.data.engine, logger })
            } catch (error) {
              logger.warn('Attendance rule engine config invalid (import payload)', error)
            }
          }

          const statusMap = parsed.data.statusMap ?? {}
          const results = []
          const skipped = []
          let groupCreated = 0
          let groupMembersAdded = 0
          await db.transaction(async (trx) => {
            let groupIdMap = null
            if (groupSync) {
              groupIdMap = await loadAttendanceGroupIdMap(trx, orgId)
              if (groupSync.autoCreate && groupNames.size) {
                const ensured = await ensureAttendanceGroups(trx, orgId, groupNames, {
                  ruleSetId: groupSync.ruleSetId,
                  timezone: groupSync.timezone,
                })
                groupIdMap = ensured.map
                groupCreated = ensured.created
              }
            }
            const groupMembersToInsert = new Map()
            for (const row of rows) {
              const workDate = row.workDate
              const groupKey = resolveAttendanceGroupKey(row)
              const rowUserId = resolveRowUserId({
                row,
                fallbackUserId: userId,
                userMap: parsed.data.userMap,
                userMapKeyField: parsed.data.userMapKeyField,
                userMapSourceFields: parsed.data.userMapSourceFields,
              })
              const userProfile = resolveRowUserProfile({
                row,
                fallbackUserId: userId,
                userMap: parsed.data.userMap,
                userMapKeyField: parsed.data.userMapKeyField,
                userMapSourceFields: parsed.data.userMapSourceFields,
              })
              const importWarnings = []
              if (!rowUserId) importWarnings.push('Missing userId')
              if (!workDate) importWarnings.push('Missing workDate')
              if (requiredFields.length) {
                const missingRequired = requiredFields.filter((field) => {
                  const value = resolveRequiredFieldValue(row, field)
                  return value === undefined || value === null || value === ''
                })
                if (missingRequired.length) {
                  importWarnings.push(`Missing required: ${missingRequired.join(', ')}`)
                }
              }
              if (punchRequiredFields.length && shouldEnforcePunchRequired(row)) {
                const missingPunch = punchRequiredFields.filter((field) => {
                  const value = resolveRequiredFieldValue(row, field)
                  return value === undefined || value === null || value === ''
                })
                if (missingPunch.length) {
                  importWarnings.push(`Missing required: ${missingPunch.join(', ')}`)
                }
              }
              if (importWarnings.length) {
                skipped.push({
                  userId: rowUserId ?? null,
                  workDate: workDate ?? null,
                  warnings: importWarnings,
                })
                continue
              }
              if (groupSync?.autoAssignMembers && groupKey && rowUserId && groupIdMap && groupIdMap.has(groupKey)) {
                const groupEntry = groupIdMap.get(groupKey)
                if (groupEntry?.id) {
                  groupMembersToInsert.set(`${groupEntry.id}:${rowUserId}`, { groupId: groupEntry.id, userId: rowUserId })
                }
              }
              let activeRuleSetId = parsed.data.ruleSetId ?? null
              let activeRuleSetConfig = ruleSetConfig
              if (!activeRuleSetId && groupRuleSetMap.size) {
                if (groupKey && groupRuleSetMap.has(groupKey)) {
                  activeRuleSetId = groupRuleSetMap.get(groupKey)
                }
              }
              if (!activeRuleSetConfig && activeRuleSetId) {
                if (ruleSetConfigCache.has(activeRuleSetId)) {
                  activeRuleSetConfig = ruleSetConfigCache.get(activeRuleSetId)
                } else {
                  activeRuleSetConfig = await loadRuleSetConfigById(db, orgId, activeRuleSetId)
                  ruleSetConfigCache.set(activeRuleSetId, activeRuleSetConfig)
                }
              }

              const override = normalizeRuleOverride(activeRuleSetConfig?.rule)
              const ruleOverride = override
                ? { ...baseRule, ...override, workingDays: override.workingDays ?? baseRule.workingDays }
                : baseRule

              let engine = payloadEngine
              if (!engine && activeRuleSetConfig?.engine) {
                if (activeRuleSetId && engineCache.has(activeRuleSetId)) {
                  engine = engineCache.get(activeRuleSetId)
                } else {
                  try {
                    engine = createRuleEngine({ config: activeRuleSetConfig.engine, logger })
                    if (activeRuleSetId) engineCache.set(activeRuleSetId, engine)
                  } catch (error) {
                    logger.warn('Attendance rule engine config invalid (rule set)', error)
                  }
                }
              }
              const context = await resolveWorkContext({
                db: trx,
                orgId,
                userId: rowUserId,
                workDate,
                defaultRule: ruleOverride,
              })
              const mapped = applyFieldMappings(row.fields ?? {}, mapping)
              const valueFor = (key) => {
                if (mapped[key]?.value !== undefined) return mapped[key].value
                if (row.fields?.[key] !== undefined) return row.fields[key]
                const profileValue = resolveProfileValue(userProfile, key)
                if (profileValue !== undefined) return profileValue
                return undefined
              }
              const dataTypeFor = (key) => mapped[key]?.dataType
              const profileSnapshot = buildProfileSnapshot({ valueFor, userProfile })

              const shiftNameRaw = valueFor('shiftName') ?? valueFor('plan_detail') ?? valueFor('attendanceClass')
              const fieldValues = buildFieldValueMap(row.fields ?? {}, mapped, userProfile)
              augmentFieldValuesWithDates(fieldValues, workDate)
              const holidayMeta = resolveHolidayMeta(context.holiday)
              if (holidayMeta.name) fieldValues.holiday_name = holidayMeta.name
              if (holidayMeta.dayIndex != null) fieldValues.holiday_day_index = holidayMeta.dayIndex
              fieldValues.holiday_first_day = holidayMeta.isFirstDay

              const baseFacts = {
                userId: rowUserId,
                orgId,
                workDate,
                shiftName: shiftNameRaw ?? context.rule?.name ?? null,
                isHoliday: Boolean(context.holiday),
                isWorkingDay: context.isWorkingDay,
              }
              const baseUserGroups = resolveUserGroups(activeRuleSetConfig?.policies?.userGroups, baseFacts, fieldValues)
              const shiftOverride = resolveShiftOverrideFromMappings(
                activeRuleSetConfig?.policies?.shiftMappings,
                baseFacts,
                fieldValues,
                baseUserGroups
              )

              const shiftRange = resolveShiftTimeRange(shiftNameRaw)
              const baseRuleForMetrics = shiftRange ? { ...context.rule, ...shiftRange } : context.rule
              const ruleForMetrics = shiftRange
                ? baseRuleForMetrics
                : (shiftOverride ? { ...context.rule, ...shiftOverride } : baseRuleForMetrics)

              const firstInAt = parseImportedDateTime(valueFor('firstInAt'), workDate, ruleForMetrics.timezone)
              const lastOutAt = parseImportedDateTime(valueFor('lastOutAt'), workDate, ruleForMetrics.timezone)
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
                rule: ruleForMetrics,
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

              const approvalSummary = valueFor('approvalSummary')
                ?? valueFor('attendance_approve')
                ?? valueFor('attendanceApprove')

              const policyBaseMetrics = {
                ...initialMetrics,
                leaveMinutes: leaveMinutes ?? 0,
                overtimeMinutes: overtimeMinutes ?? 0,
              }
              const holidayPolicyContext = buildHolidayPolicyContext({ rowUserId, valueFor, userProfile })
              const holidayPolicyResult = applyHolidayPolicy({
                settings,
                holiday: context.holiday,
                holidayMeta,
                metrics: policyBaseMetrics,
                approvalSummary,
                policyContext: holidayPolicyContext,
              })
              const policyResult = applyAttendancePolicies({
                policies: activeRuleSetConfig?.policies,
                facts: {
                  userId: rowUserId,
                  orgId,
                  workDate,
                  shiftName: shiftNameRaw ?? context.rule?.name ?? null,
                  isHoliday: Boolean(context.holiday),
                  isWorkingDay: context.isWorkingDay,
                  holidayName: holidayMeta.name,
                  holidayDayIndex: holidayMeta.dayIndex,
                  holidayFirstDay: holidayMeta.isFirstDay,
                },
                fieldValues,
                metrics: holidayPolicyResult.metrics,
                options: { skipRules: resolvePolicySkipRules(settings) },
              })
              const effective = policyResult.metrics
              let engineResult = null
              if (engine) {
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
                    holiday_name: holidayMeta.name ?? undefined,
                    holiday_day_index: holidayMeta.dayIndex ?? undefined,
                    holiday_first_day: holidayMeta.isFirstDay,
                    holiday_policy_enabled: Boolean(settings?.holidayPolicy?.firstDayEnabled),
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

              const policyWarnings = [...holidayPolicyResult.warnings, ...policyResult.warnings]
              let meta = null
              if (policyWarnings.length || policyResult.appliedRules.length || policyResult.userGroups.length) {
                meta = {
                  policy: {
                    warnings: policyWarnings,
                    appliedRules: policyResult.appliedRules,
                    userGroups: policyResult.userGroups,
                  },
                }
              }
              if (profileSnapshot) {
                meta = meta ?? {}
                meta.profile = profileSnapshot
              }
              meta = meta ?? {}
              meta.metrics = {
                leaveMinutes: effectiveLeaveMinutes,
                overtimeMinutes: effectiveOvertimeMinutes,
              }
              meta.source = {
                source: parsed.data.source ?? null,
                mappingProfileId: parsed.data.mappingProfileId ?? null,
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
            if (groupSync?.autoAssignMembers && groupMembersToInsert.size) {
              groupMembersAdded = await insertAttendanceGroupMembers(
                trx,
                orgId,
                Array.from(groupMembersToInsert.values())
              )
            }
          })

          res.json({
            ok: true,
            data: {
              imported: results.length,
              items: results,
              skipped,
              csvWarnings: [...csvWarnings, ...groupWarnings],
              groupWarnings,
              meta: groupSync
                ? {
                    groupCreated,
                    groupMembersAdded,
                    groupSync: {
                      autoCreate: groupSync.autoCreate,
                      autoAssignMembers: groupSync.autoAssignMembers,
                      ruleSetId: groupSync.ruleSetId,
                      timezone: groupSync.timezone,
                    },
                  }
                : null,
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
      '/api/attendance/integrations',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const { page, pageSize, offset } = parsePagination(req.query)
        const status = typeof req.query.status === 'string' ? req.query.status : null

        try {
          const where = ['org_id = $1']
          const params = [orgId]
          if (status) {
            where.push(`status = $${params.length + 1}`)
            params.push(status)
          }
          const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''
          const totalRows = await db.query(
            `SELECT COUNT(*)::int AS total FROM attendance_integrations ${whereClause}`,
            params
          )
          const rows = await db.query(
            `SELECT * FROM attendance_integrations
             ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, pageSize, offset]
          )
          res.json({
            ok: true,
            data: {
              items: rows.map(mapIntegrationRow),
              total: totalRows[0]?.total ?? 0,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance integrations query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load integrations' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/integrations',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = integrationCreateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }
        const orgId = getOrgId(req)
        const payload = parsed.data
        const status = payload.status ?? 'active'
        const config = payload.config ?? {}

        try {
          const rows = await db.query(
            `INSERT INTO attendance_integrations
             (org_id, name, type, status, config, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, now(), now())
             RETURNING *`,
            [orgId, payload.name, payload.type, status, JSON.stringify(config)]
          )
          const mapped = rows.length ? mapIntegrationRow(rows[0]) : null
          res.json({ ok: true, data: mapped })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance integration creation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create integration' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/integrations/:id',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = integrationUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }
        const orgId = getOrgId(req)
        const integrationId = req.params.id

        try {
          const existing = await db.query(
            'SELECT * FROM attendance_integrations WHERE id = $1 AND org_id = $2',
            [integrationId, orgId]
          )
          if (!existing.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Integration not found' } })
            return
          }
          const current = mapIntegrationRow(existing[0])
          const next = {
            name: parsed.data.name ?? current.name,
            type: parsed.data.type ?? current.type,
            status: parsed.data.status ?? current.status,
            config: parsed.data.config ?? current.config,
          }
          const rows = await db.query(
            `UPDATE attendance_integrations
             SET name = $3, type = $4, status = $5, config = $6::jsonb, updated_at = now()
             WHERE id = $1 AND org_id = $2
             RETURNING *`,
            [integrationId, orgId, next.name, next.type, next.status, JSON.stringify(next.config)]
          )
          res.json({ ok: true, data: mapIntegrationRow(rows[0]) })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance integration update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update integration' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/integrations/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const integrationId = req.params.id

        try {
          const rows = await db.query(
            'DELETE FROM attendance_integrations WHERE id = $1 AND org_id = $2 RETURNING id',
            [integrationId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Integration not found' } })
            return
          }
          res.json({ ok: true, data: { id: integrationId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance integration delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete integration' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/integrations/:id/runs',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const integrationId = req.params.id
        const { page, pageSize, offset } = parsePagination(req.query)

        try {
          const totalRows = await db.query(
            'SELECT COUNT(*)::int AS total FROM attendance_integration_runs WHERE integration_id = $1 AND org_id = $2',
            [integrationId, orgId]
          )
          const rows = await db.query(
            `SELECT * FROM attendance_integration_runs
             WHERE integration_id = $1 AND org_id = $2
             ORDER BY started_at DESC
             LIMIT $3 OFFSET $4`,
            [integrationId, orgId, pageSize, offset]
          )
          res.json({
            ok: true,
            data: {
              items: rows.map(mapIntegrationRunRow),
              total: totalRows[0]?.total ?? 0,
              page,
              pageSize,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance integration runs query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load integration runs' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/integrations/:id/sync',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = integrationSyncSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }
        const orgId = getOrgId(req)
        const requesterId = getUserId(req)
        if (!requesterId) {
          res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'User ID not found' } })
          return
        }
        const integrationId = req.params.id

        try {
          const rows = await db.query(
            'SELECT * FROM attendance_integrations WHERE id = $1 AND org_id = $2',
            [integrationId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Integration not found' } })
            return
          }
          const integration = mapIntegrationRow(rows[0])
          if (integration.status !== 'active') {
            res.status(400).json({ ok: false, error: { code: 'INACTIVE', message: 'Integration is disabled' } })
            return
          }
          const run = await createIntegrationRun(db, { orgId, integrationId })
          const config = normalizeIntegrationConfig(integration.config)
          const fromDate = normalizeDingTalkDateRange(parsed.data.from, new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
          const toDate = normalizeDingTalkDateRange(parsed.data.to, new Date().toISOString().slice(0, 10))

          let imported = 0
          let skipped = []
          let batchId = null

          if (integration.type === 'dingtalk') {
            const accessToken = await fetchDingTalkAccessToken({
              appKey: config.appKey,
              appSecret: config.appSecret,
              baseUrl: config.baseUrl,
            })
            const columns = Array.isArray(config.columns) && config.columns.length
              ? config.columns
              : config.columnIds.map((id) => ({ id }))
            if (!columns.length) {
              throw new Error('DingTalk columnIds/columns required in integration config')
            }
            const userIds = config.userIds
            if (!userIds.length) {
              throw new Error('DingTalk userIds required in integration config')
            }
            const allRows = []
            for (const userId of userIds) {
              const result = await fetchDingTalkColumnValues({
                baseUrl: config.baseUrl,
                accessToken,
                userId,
                columnIds: config.columnIds,
                fromDate,
                toDate,
              })
              const payload = {
                column_vals: result.column_vals ?? [],
                userId,
              }
              const rowsForUser = buildRowsFromDingTalk({ columns, data: payload, userId })
              allRows.push(...rowsForUser)
            }
            const payload = {
              source: config.source ?? 'dingtalk_api',
              rows: allRows,
              userMap: config.userMap,
              userMapKeyField: config.userMapKeyField,
              userMapSourceFields: config.userMapSourceFields,
              mappingProfileId: config.mappingProfileId ?? 'dingtalk_api_columns',
            }
            if (parsed.data.dryRun) {
              imported = 0
              skipped = []
            } else {
              const importResponse = await (async () => {
                const parsedImport = importPayloadSchema.safeParse(payload)
                if (!parsedImport.success) throw new Error(parsedImport.error.message)
                const importUserId = payload.userId ?? requesterId
                const importOrgId = orgId
                const importRows = Array.isArray(parsedImport.data.rows) ? parsedImport.data.rows : []
                let ruleSetConfig = null
                const profile = findImportProfile(parsedImport.data.mappingProfileId)
                const profileMapping = profile?.mapping?.columns ?? profile?.mapping?.fields ?? []
                const mapping = parsedImport.data.mapping?.columns
                  ?? parsedImport.data.mapping?.fields
                  ?? (profileMapping.length ? profileMapping : undefined)
                  ?? ruleSetConfig?.mappings?.columns
                  ?? ruleSetConfig?.mappings?.fields
                  ?? []
                const requiredFields = profile?.requiredFields ?? []
                const punchRequiredFields = profile?.punchRequiredFields ?? []
                const baseRule = await loadDefaultRule(db, orgId)
                const override = normalizeRuleOverride(ruleSetConfig?.rule)
                const ruleOverride = override
                  ? { ...baseRule, ...override, workingDays: override.workingDays ?? baseRule.workingDays }
                  : baseRule
                const settings = await getSettings(db)
                const statusMap = parsedImport.data.statusMap ?? {}
                const results = []
                const skippedRows = []
                const newBatchId = randomUUID()
                const batchMeta = {
                  source: 'integration',
                  integrationId,
                  mappingProfileId: parsedImport.data.mappingProfileId ?? null,
                }

                await db.transaction(async (trx) => {
                  await trx.query(
                    `INSERT INTO attendance_import_batches
                     (id, org_id, created_by, source, rule_set_id, mapping, row_count, status, meta, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, now(), now())`,
                    [
                      newBatchId,
                      orgId,
                      requesterId,
                      payload.source ?? null,
                      null,
                      JSON.stringify(mapping),
                      importRows.length,
                      'committed',
                      JSON.stringify(batchMeta),
                    ]
                  )

                  const seenRowKeys = new Set()
                  for (const row of importRows) {
                    const workDate = row.workDate
                    const rowUserId = resolveRowUserId({
                      row,
                      fallbackUserId: importUserId,
                      userMap: parsedImport.data.userMap,
                      userMapKeyField: parsedImport.data.userMapKeyField,
                      userMapSourceFields: parsedImport.data.userMapSourceFields,
                    })
                    const userProfile = resolveRowUserProfile({
                      row,
                      fallbackUserId: importUserId,
                      userMap: parsedImport.data.userMap,
                      userMapKeyField: parsedImport.data.userMapKeyField,
                      userMapSourceFields: parsedImport.data.userMapSourceFields,
                    })
                    const importWarnings = []
                    if (!rowUserId) importWarnings.push('Missing userId')
                    if (!workDate) importWarnings.push('Missing workDate')
                    if (requiredFields.length) {
                      const missingRequired = requiredFields.filter((field) => {
                        const value = resolveRequiredFieldValue(row, field)
                        return value === undefined || value === null || value === ''
                      })
                      if (missingRequired.length) {
                        importWarnings.push(`Missing required: ${missingRequired.join(', ')}`)
                      }
                    }
                    if (punchRequiredFields.length && shouldEnforcePunchRequired(row)) {
                      const missingPunch = punchRequiredFields.filter((field) => {
                        const value = resolveRequiredFieldValue(row, field)
                        return value === undefined || value === null || value === ''
                      })
                      if (missingPunch.length) {
                        importWarnings.push(`Missing required: ${missingPunch.join(', ')}`)
                      }
                    }
                    if (importWarnings.length) {
                      const snapshot = buildSkippedImportSnapshot({ warnings: importWarnings, row, reason: 'validation' })
                      await trx.query(
                        `INSERT INTO attendance_import_items
                         (id, batch_id, org_id, user_id, work_date, record_id, preview_snapshot, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())`,
                        [
                          randomUUID(),
                          newBatchId,
                          orgId,
                          rowUserId ?? null,
                          workDate ?? null,
                          null,
                          JSON.stringify(snapshot),
                        ]
                      )
                      skippedRows.push({ userId: rowUserId ?? null, workDate: workDate ?? null, warnings: importWarnings })
                      continue
                    }

                    const dedupKey = `${rowUserId}:${workDate}`
                    if (seenRowKeys.has(dedupKey)) {
                      const warnings = ['Duplicate row in payload (same userId + workDate)']
                      const snapshot = buildSkippedImportSnapshot({ warnings, row, reason: 'duplicate' })
                      await trx.query(
                        `INSERT INTO attendance_import_items
                         (id, batch_id, org_id, user_id, work_date, record_id, preview_snapshot, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())`,
                        [
                          randomUUID(),
                          newBatchId,
                          orgId,
                          rowUserId,
                          workDate,
                          null,
                          JSON.stringify(snapshot),
                        ]
                      )
                      skippedRows.push({ userId: rowUserId, workDate, warnings })
                      continue
                    }
                    seenRowKeys.add(dedupKey)
                    const context = await resolveWorkContext({
                      db: trx,
                      orgId,
                      userId: rowUserId,
                      workDate,
                      defaultRule: ruleOverride,
                    })
                    const mapped = applyFieldMappings(row.fields ?? {}, mapping)
                    const valueFor = (key) => {
                      if (mapped[key]?.value !== undefined) return mapped[key].value
                      if (row.fields?.[key] !== undefined) return row.fields[key]
                      const profileValue = resolveProfileValue(userProfile, key)
                      if (profileValue !== undefined) return profileValue
                      return undefined
                    }
                    const dataTypeFor = (key) => mapped[key]?.dataType
                    const profileSnapshot = buildProfileSnapshot({ valueFor, userProfile })

                    const shiftNameRaw = valueFor('shiftName') ?? valueFor('plan_detail') ?? valueFor('attendanceClass')
                    const fieldValues = buildFieldValueMap(row.fields ?? {}, mapped, userProfile)
                    augmentFieldValuesWithDates(fieldValues, workDate)
                    const holidayMeta = resolveHolidayMeta(context.holiday)
                    if (holidayMeta.name) fieldValues.holiday_name = holidayMeta.name
                    if (holidayMeta.dayIndex != null) fieldValues.holiday_day_index = holidayMeta.dayIndex
                    fieldValues.holiday_first_day = holidayMeta.isFirstDay

                    const baseFacts = {
                      userId: rowUserId,
                      orgId,
                      workDate,
                      shiftName: shiftNameRaw ?? context.rule?.name ?? null,
                      isHoliday: Boolean(context.holiday),
                      isWorkingDay: context.isWorkingDay,
                    }
                    const baseUserGroups = resolveUserGroups(ruleSetConfig?.policies?.userGroups, baseFacts, fieldValues)
                    const shiftOverride = resolveShiftOverrideFromMappings(
                      ruleSetConfig?.policies?.shiftMappings,
                      baseFacts,
                      fieldValues,
                      baseUserGroups
                    )

                    const shiftRange = resolveShiftTimeRange(shiftNameRaw)
                    const baseRuleForMetrics = shiftRange ? { ...context.rule, ...shiftRange } : context.rule
                    const ruleForMetrics = shiftRange
                      ? baseRuleForMetrics
                      : (shiftOverride ? { ...context.rule, ...shiftOverride } : baseRuleForMetrics)

                    const firstInAt = parseImportedDateTime(valueFor('firstInAt'), workDate, ruleForMetrics.timezone)
                    const lastOutAt = parseImportedDateTime(valueFor('lastOutAt'), workDate, ruleForMetrics.timezone)
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
                      rule: ruleForMetrics,
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

                    const approvalSummary = valueFor('approvalSummary')
                      ?? valueFor('attendance_approve')
                      ?? valueFor('attendanceApprove')

                    const policyBaseMetrics = {
                      ...initialMetrics,
                      leaveMinutes: leaveMinutes ?? 0,
                      overtimeMinutes: overtimeMinutes ?? 0,
                    }
                    const holidayPolicyContext = buildHolidayPolicyContext({ rowUserId, valueFor, userProfile })
                    const holidayPolicyResult = applyHolidayPolicy({
                      settings,
                      holiday: context.holiday,
                      holidayMeta,
                      metrics: policyBaseMetrics,
                      approvalSummary,
                      policyContext: holidayPolicyContext,
                    })
                    const policyResult = applyAttendancePolicies({
                      policies: ruleSetConfig?.policies,
                      facts: {
                        userId: rowUserId,
                        orgId,
                        workDate,
                      shiftName: shiftNameRaw ?? context.rule?.name ?? null,
                        isHoliday: Boolean(context.holiday),
                        isWorkingDay: context.isWorkingDay,
                        holidayName: holidayMeta.name,
                        holidayDayIndex: holidayMeta.dayIndex,
                        holidayFirstDay: holidayMeta.isFirstDay,
                      },
                      fieldValues,
                      metrics: holidayPolicyResult.metrics,
                      options: { skipRules: resolvePolicySkipRules(settings) },
                    })
                    const effective = policyResult.metrics
                    const baseMetrics = {
                      ...effective,
                      leaveMinutes: Number.isFinite(effective.leaveMinutes) ? effective.leaveMinutes : leaveMinutes,
                      overtimeMinutes: Number.isFinite(effective.overtimeMinutes) ? effective.overtimeMinutes : overtimeMinutes,
                    }
                    const finalMetrics = baseMetrics
                    const effectiveLeaveMinutes = Number.isFinite(finalMetrics.leaveMinutes)
                      ? finalMetrics.leaveMinutes
                      : leaveMinutes
                    const effectiveOvertimeMinutes = Number.isFinite(finalMetrics.overtimeMinutes)
                      ? finalMetrics.overtimeMinutes
                      : overtimeMinutes

                    const policyWarnings = [...holidayPolicyResult.warnings, ...policyResult.warnings]
                    let meta = null
                    if (policyWarnings.length || policyResult.appliedRules.length || policyResult.userGroups.length) {
                      meta = {
                        policy: {
                          warnings: policyWarnings,
                          appliedRules: policyResult.appliedRules,
                          userGroups: policyResult.userGroups,
                        },
                      }
                    }
                    if (profileSnapshot) {
                      meta = meta ?? {}
                      meta.profile = profileSnapshot
                    }
                    meta = meta ?? {}
                    meta.metrics = {
                      leaveMinutes: effectiveLeaveMinutes,
                      overtimeMinutes: effectiveOvertimeMinutes,
                    }
                    meta.source = {
                      source: payload.source ?? null,
                      mappingProfileId: payload.mappingProfileId ?? null,
                      integrationId,
                    }

                    const record = await upsertAttendanceRecord({
                      userId: rowUserId,
                      orgId,
                      workDate,
                      timezone: context.rule.timezone,
                      rule: context.rule,
                      updateFirstInAt: firstInAt,
                      updateLastOutAt: lastOutAt,
                      mode: parsedImport.data.mode ?? 'override',
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
                      sourceBatchId: newBatchId,
                      client: trx,
                    })

                    const snapshot = {
                      metrics: {
                        workMinutes: finalMetrics.workMinutes,
                        lateMinutes: finalMetrics.lateMinutes,
                        earlyLeaveMinutes: finalMetrics.earlyLeaveMinutes,
                        leaveMinutes: effectiveLeaveMinutes,
                        overtimeMinutes: effectiveOvertimeMinutes,
                        status: finalMetrics.status,
                      },
                      policy: meta?.policy ?? null,
                    }

                    await trx.query(
                      `INSERT INTO attendance_import_items
                       (id, batch_id, org_id, user_id, work_date, record_id, preview_snapshot, created_at)
                       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())`,
                      [
                        randomUUID(),
                        newBatchId,
                        orgId,
                        rowUserId,
                        workDate,
                        record.id,
                        JSON.stringify(snapshot),
                      ]
                    )

                    results.push({ id: record.id, userId: rowUserId, workDate })
                  }

                  if (skippedRows.length) {
                    await trx.query(
                      'UPDATE attendance_import_batches SET meta = $3::jsonb, updated_at = now() WHERE id = $1 AND org_id = $2',
                      [newBatchId, orgId, JSON.stringify({ ...batchMeta, skippedCount: skippedRows.length, skippedRows: skippedRows.slice(0, 50) })]
                    )
                  }
                })

                return { results, skipped: skippedRows, batchId: newBatchId }
              })()
              imported = importResponse.results.length
              skipped = importResponse.skipped
              batchId = importResponse.batchId
            }
          }

          await db.query(
            'UPDATE attendance_integrations SET last_sync_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2',
            [integrationId, orgId]
          )
          const runResult = await updateIntegrationRun(db, run.id, {
            status: 'success',
            message: parsed.data.dryRun ? 'Dry run completed' : 'Sync completed',
            meta: { imported, skipped: skipped.length, batchId },
            finishedAt: new Date().toISOString(),
          })

          res.json({
            ok: true,
            data: {
              integrationId,
              imported,
              skipped,
              batchId,
              run: runResult,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance integration sync failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: (error?.message || 'Integration sync failed') } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/import/batches',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const { page, pageSize, offset } = parsePagination(req.query)

        try {
          const countRows = await db.query(
            'SELECT COUNT(*)::int AS total FROM attendance_import_batches WHERE org_id = $1',
            [orgId]
          )
          const total = Number(countRows[0]?.total ?? 0)
          const rows = await db.query(
            `SELECT * FROM attendance_import_batches
             WHERE org_id = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [orgId, pageSize, offset]
          )
          res.json({
            ok: true,
            data: {
              items: rows.map(mapImportBatchRow),
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
          logger.error('Attendance import batches query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load import batches' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/import/batches/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const batchId = req.params.id
        try {
          const rows = await db.query(
            'SELECT * FROM attendance_import_batches WHERE id = $1 AND org_id = $2',
            [batchId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Import batch not found' } })
            return
          }
          res.json({ ok: true, data: mapImportBatchRow(rows[0]) })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance import batch lookup failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load import batch' } })
        }
      })
    )

	    context.api.http.addRoute(
	      'GET',
	      '/api/attendance/import/batches/:id/items',
	      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const batchId = req.params.id
        const { page, pageSize, offset } = parsePagination(req.query)
        try {
          const countRows = await db.query(
            'SELECT COUNT(*)::int AS total FROM attendance_import_items WHERE batch_id = $1 AND org_id = $2',
            [batchId, orgId]
          )
          const total = Number(countRows[0]?.total ?? 0)
          const rows = await db.query(
            `SELECT * FROM attendance_import_items
             WHERE batch_id = $1 AND org_id = $2
             ORDER BY created_at DESC
             LIMIT $3 OFFSET $4`,
            [batchId, orgId, pageSize, offset]
          )
          res.json({
            ok: true,
            data: {
              items: rows.map(mapImportItemRow),
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
          logger.error('Attendance import items query failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load import items' } })
        }
	      })
	    )

	    context.api.http.addRoute(
	      'GET',
	      '/api/attendance/import/batches/:id/export.csv',
	      withPermission('attendance:admin', async (req, res) => {
	        const orgId = getOrgId(req)
	        const batchId = req.params.id
	        const rawType = String(req.query?.type ?? req.query?.kind ?? '').toLowerCase()
	        const type = ['all', 'imported', 'skipped', 'anomalies'].includes(rawType) ? rawType : 'all'

	        const csvEscape = (value) => {
	          const text = value === null || value === undefined ? '' : String(value)
	          if (/[\",\n]/.test(text)) return `"${text.replace(/\"/g, '\"\"')}"`
	          return text
	        }

	        const extractMetrics = (snapshot) => {
	          if (!snapshot || typeof snapshot !== 'object') return {}
	          const metrics = snapshot.metrics
	          if (metrics && typeof metrics === 'object' && !Array.isArray(metrics)) return metrics
	          return {}
	        }

	        const extractWarnings = (snapshot) => {
	          if (!snapshot || typeof snapshot !== 'object') return []
	          const out = []
	          if (Array.isArray(snapshot.warnings)) out.push(...snapshot.warnings)
	          const metrics = extractMetrics(snapshot)
	          if (Array.isArray(metrics.warnings)) out.push(...metrics.warnings)
	          if (snapshot.policy && Array.isArray(snapshot.policy.warnings)) out.push(...snapshot.policy.warnings)
	          if (snapshot.engine && Array.isArray(snapshot.engine.warnings)) out.push(...snapshot.engine.warnings)
	          return Array.from(new Set(out.map((w) => String(w)).filter(Boolean)))
	        }

	        const isAnomaly = (row, snapshot) => {
	          const metrics = extractMetrics(snapshot)
	          const warnings = extractWarnings(snapshot)
	          const status = metrics.status ? String(metrics.status) : ''
	          const lateMinutes = Number(metrics.lateMinutes ?? 0)
	          const earlyLeaveMinutes = Number(metrics.earlyLeaveMinutes ?? 0)
	          const leaveMinutes = Number(metrics.leaveMinutes ?? 0)
	          const overtimeMinutes = Number(metrics.overtimeMinutes ?? 0)
	          return Boolean(
	            warnings.length
	            || row.record_id == null
	            || (status && status !== 'normal')
	            || lateMinutes > 0
	            || earlyLeaveMinutes > 0
	            || leaveMinutes > 0
	            || overtimeMinutes > 0
	          )
	        }

	        try {
	          // Ensure batch exists (nicer 404 vs empty CSV).
	          const batchRows = await db.query(
	            'SELECT id FROM attendance_import_batches WHERE id = $1 AND org_id = $2',
	            [batchId, orgId]
	          )
	          if (!batchRows.length) {
	            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Import batch not found' } })
	            return
	          }

	          const where = type === 'imported'
	            ? 'AND record_id IS NOT NULL'
	            : type === 'skipped'
	              ? 'AND record_id IS NULL'
	              : ''

	          const rows = await db.query(
	            `SELECT * FROM attendance_import_items
	             WHERE batch_id = $1 AND org_id = $2
	             ${where}
	             ORDER BY created_at ASC`,
	            [batchId, orgId]
	          )

	          const headers = [
	            'batchId',
	            'itemId',
	            'workDate',
	            'userId',
	            'recordId',
	            'status',
	            'workMinutes',
	            'lateMinutes',
	            'earlyLeaveMinutes',
	            'leaveMinutes',
	            'overtimeMinutes',
	            'warnings',
	          ]

	          const lines = []
	          lines.push(headers.map(csvEscape).join(','))

	          for (const row of rows) {
	            const snapshot = normalizeMetadata(row.preview_snapshot)
	            if (type === 'anomalies' && !isAnomaly(row, snapshot)) continue

	            const metrics = extractMetrics(snapshot)
	            const warnings = extractWarnings(snapshot)
	            const status = metrics.status ? String(metrics.status) : ''

	            const values = [
	              batchId,
	              row.id,
	              row.work_date ?? '',
	              row.user_id ?? '',
	              row.record_id ?? '',
	              status,
	              Number(metrics.workMinutes ?? 0),
	              Number(metrics.lateMinutes ?? 0),
	              Number(metrics.earlyLeaveMinutes ?? 0),
	              Number(metrics.leaveMinutes ?? 0),
	              Number(metrics.overtimeMinutes ?? 0),
	              warnings.join('; '),
	            ]
	            lines.push(values.map(csvEscape).join(','))
	          }

	          const stamp = new Date().toISOString().slice(0, 10)
	          const filename = `attendance-import-${String(batchId).slice(0, 8)}-${type}-${stamp}.csv`
	          res.setHeader('Content-Type', 'text/csv; charset=utf-8')
	          res.setHeader('Content-Disposition', `attachment; filename=\"${filename}\"`)
	          res.send(lines.join('\n'))
	        } catch (error) {
	          if (isDatabaseSchemaError(error)) {
	            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
	            return
	          }
	          logger.error('Attendance import export failed', error)
	          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to export import items' } })
	        }
	      })
	    )

	    context.api.http.addRoute(
	      'POST',
	      '/api/attendance/import/rollback/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const batchId = req.params.id
        try {
          const batchRows = await db.query(
            'SELECT * FROM attendance_import_batches WHERE id = $1 AND org_id = $2',
            [batchId, orgId]
          )
          if (!batchRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Import batch not found' } })
            return
          }
          const batch = batchRows[0]
          if (batch.status === 'rolled_back') {
            res.json({ ok: true, data: { id: batchId, deleted: 0, status: 'rolled_back' } })
            return
          }

          let deletedCount = 0
          await db.transaction(async (trx) => {
            const deleted = await trx.query(
              'DELETE FROM attendance_records WHERE source_batch_id = $1 AND org_id = $2 RETURNING id',
              [batchId, orgId]
            )
            deletedCount = deleted.length
            await trx.query(
              'UPDATE attendance_import_batches SET status = $3, updated_at = now() WHERE id = $1 AND org_id = $2',
              [batchId, orgId, 'rolled_back']
            )
          })

          res.json({ ok: true, data: { id: batchId, deleted: deletedCount, status: 'rolled_back' } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance import rollback failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to rollback import batch' } })
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
        let resolvedTemplateId = parsed.data.templateId ?? null
        if (resolvedTemplateId) {
          const templateRows = await db.query(
            'SELECT * FROM attendance_payroll_templates WHERE id = $1 AND org_id = $2',
            [resolvedTemplateId, orgId]
          )
          if (!templateRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Payroll template not found' } })
            return
          }
          template = templateRows[0]
        } else if (parsed.data.anchorDate || !parsed.data.startDate || !parsed.data.endDate) {
          const defaultRows = await db.query(
            'SELECT * FROM attendance_payroll_templates WHERE org_id = $1 AND is_default = true LIMIT 1',
            [orgId]
          )
          if (defaultRows.length) {
            template = defaultRows[0]
            resolvedTemplateId = template.id
          }
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
          res.status(400).json({
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: template
                ? 'startDate and endDate are required'
                : 'startDate/endDate or a payroll template is required',
            },
          })
          return
        }

        const startParsed = parseDateInput(startDate)
        const endParsed = parseDateInput(endDate)
        if (!startParsed || !endParsed || startParsed > endParsed) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid date range' } })
          return
        }

        const payload = {
          templateId: resolvedTemplateId,
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
      'POST',
      '/api/attendance/payroll-cycles/generate',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = payrollCycleGenerateSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        let template = null
        let resolvedTemplateId = parsed.data.templateId ?? null
        if (resolvedTemplateId) {
          const templateRows = await db.query(
            'SELECT * FROM attendance_payroll_templates WHERE id = $1 AND org_id = $2',
            [resolvedTemplateId, orgId]
          )
          if (!templateRows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Payroll template not found' } })
            return
          }
          template = templateRows[0]
        } else {
          const defaultRows = await db.query(
            'SELECT * FROM attendance_payroll_templates WHERE org_id = $1 AND is_default = true LIMIT 1',
            [orgId]
          )
          if (defaultRows.length) {
            template = defaultRows[0]
            resolvedTemplateId = template.id
          }
        }

        if (!template) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Payroll template required for generation' } })
          return
        }

        const anchorBase = parseDateInput(parsed.data.anchorDate)
        if (!anchorBase) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid anchorDate' } })
          return
        }

        const count = parsed.data.count ?? 1
        const status = parsed.data.status ?? 'open'
        const namePrefix = parsed.data.namePrefix && parsed.data.namePrefix.trim().length > 0
          ? parsed.data.namePrefix.trim()
          : template.name

        const created = []
        const skipped = []
        try {
          await db.transaction(async (trx) => {
            for (let i = 0; i < count; i += 1) {
              const anchor = addMonthsToDate(anchorBase, i)
              const window = resolvePayrollWindow(mapPayrollTemplateRow(template), anchor)
              const name = `${namePrefix} ${window.startDate}~${window.endDate}`
              const metadata = {
                ...(parsed.data.metadata ?? {}),
                generatedFrom: resolvedTemplateId,
                anchorDate: formatDateOnly(anchor),
                index: i + 1,
              }
              const rows = await trx.query(
                `INSERT INTO attendance_payroll_cycles
                 (id, org_id, template_id, name, start_date, end_date, status, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
                 ON CONFLICT (org_id, start_date, end_date) DO NOTHING
                 RETURNING *`,
                [
                  randomUUID(),
                  orgId,
                  resolvedTemplateId,
                  name,
                  window.startDate,
                  window.endDate,
                  status,
                  JSON.stringify(metadata),
                ]
              )
              if (rows.length) {
                created.push(mapPayrollCycleRow(rows[0]))
              } else {
                skipped.push({ startDate: window.startDate, endDate: window.endDate })
              }
            }
          })

          res.json({
            ok: true,
            data: {
              templateId: resolvedTemplateId,
              created,
              skipped,
            },
          })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance payroll cycle generation failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to generate payroll cycles' } })
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
          let resolvedTemplateId = parsed.data.templateId ?? existing.template_id ?? null
          if (resolvedTemplateId) {
            const templateRows = await db.query(
              'SELECT * FROM attendance_payroll_templates WHERE id = $1 AND org_id = $2',
              [resolvedTemplateId, orgId]
            )
            if (!templateRows.length) {
              res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Payroll template not found' } })
              return
            }
            template = templateRows[0]
          } else if (parsed.data.anchorDate) {
            const defaultRows = await db.query(
              'SELECT * FROM attendance_payroll_templates WHERE org_id = $1 AND is_default = true LIMIT 1',
              [orgId]
            )
            if (defaultRows.length) {
              template = defaultRows[0]
              resolvedTemplateId = template.id
            }
          }

          let startDate = parsed.data.startDate ?? existing.start_date
          let endDate = parsed.data.endDate ?? existing.end_date
          if (parsed.data.anchorDate) {
            if (!template) {
              res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Payroll template required for anchorDate' } })
              return
            }
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
            templateId: resolvedTemplateId,
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
      '/api/attendance/groups',
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
            'SELECT COUNT(*)::int AS total FROM attendance_groups WHERE org_id = $1',
            [orgId]
          )
          const total = Number(countRows[0]?.total ?? 0)

          const rows = await db.query(
            `SELECT * FROM attendance_groups
             WHERE org_id = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [orgId, pageSize, offset]
          )

          res.json({
            ok: true,
            data: {
              items: rows.map(mapAttendanceGroupRow),
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
          logger.error('Attendance groups fetch failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load groups' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/groups',
      withPermission('attendance:admin', async (req, res) => {
        const schema = z.object({
          name: z.string().min(1),
          code: z.string().optional().nullable(),
          timezone: z.string().optional().nullable(),
          ruleSetId: z.string().uuid().optional().nullable(),
          description: z.string().optional().nullable(),
        })

        const parsed = schema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const name = parsed.data.name.trim()
        const code = parsed.data.code?.trim() || null
        const timezone = parsed.data.timezone?.trim() || DEFAULT_RULE.timezone
        const ruleSetId = parsed.data.ruleSetId ?? null
        const description = parsed.data.description?.trim() || null

        try {
          const rows = await db.query(
            `INSERT INTO attendance_groups (org_id, name, code, timezone, rule_set_id, description, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, now(), now())
             RETURNING *`,
            [orgId, name, code, timezone, ruleSetId, description]
          )
          res.json({ ok: true, data: mapAttendanceGroupRow(rows[0]) })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance group create failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create group' } })
        }
      })
    )

    context.api.http.addRoute(
      'PUT',
      '/api/attendance/groups/:id',
      withPermission('attendance:admin', async (req, res) => {
        const schema = z.object({
          name: z.string().min(1),
          code: z.string().optional().nullable(),
          timezone: z.string().optional().nullable(),
          ruleSetId: z.string().uuid().optional().nullable(),
          description: z.string().optional().nullable(),
        })

        const parsed = schema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const groupId = req.params.id
        const name = parsed.data.name.trim()
        const code = parsed.data.code?.trim() || null
        const timezone = parsed.data.timezone?.trim() || DEFAULT_RULE.timezone
        const ruleSetId = parsed.data.ruleSetId ?? null
        const description = parsed.data.description?.trim() || null

        try {
          const rows = await db.query(
            `UPDATE attendance_groups
             SET name = $3,
                 code = $4,
                 timezone = $5,
                 rule_set_id = $6,
                 description = $7,
                 updated_at = now()
             WHERE id = $1 AND org_id = $2
             RETURNING *`,
            [groupId, orgId, name, code, timezone, ruleSetId, description]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
            return
          }
          res.json({ ok: true, data: mapAttendanceGroupRow(rows[0]) })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance group update failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update group' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/groups/:id',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const groupId = req.params.id
        try {
          const rows = await db.query(
            'DELETE FROM attendance_groups WHERE id = $1 AND org_id = $2 RETURNING id',
            [groupId, orgId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
            return
          }
          res.json({ ok: true, data: { id: groupId } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance group delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete group' } })
        }
      })
    )

    context.api.http.addRoute(
      'GET',
      '/api/attendance/groups/:id/members',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const groupId = req.params.id
        const { page, pageSize, offset } = parsePagination(req.query)

        try {
          const countRows = await db.query(
            'SELECT COUNT(*)::int AS total FROM attendance_group_members WHERE org_id = $1 AND group_id = $2',
            [orgId, groupId]
          )
          const total = Number(countRows[0]?.total ?? 0)
          const rows = await db.query(
            `SELECT * FROM attendance_group_members
             WHERE org_id = $1 AND group_id = $2
             ORDER BY created_at DESC
             LIMIT $3 OFFSET $4`,
            [orgId, groupId, pageSize, offset]
          )
          res.json({
            ok: true,
            data: {
              items: rows.map(mapAttendanceGroupMemberRow),
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
          logger.error('Attendance group members fetch failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load group members' } })
        }
      })
    )

    context.api.http.addRoute(
      'POST',
      '/api/attendance/groups/:id/members',
      withPermission('attendance:admin', async (req, res) => {
        const schema = z.object({
          userId: z.string().optional(),
          userIds: z.array(z.string()).optional(),
        })

        const parsed = schema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }

        const orgId = getOrgId(req)
        const groupId = req.params.id
        const list = Array.isArray(parsed.data.userIds) ? parsed.data.userIds : []
        const userIds = [
          ...list,
          parsed.data.userId ? parsed.data.userId : null,
        ].filter(Boolean).map((value) => String(value).trim()).filter(Boolean)

        if (!userIds.length) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId is required' } })
          return
        }

        try {
          const created = []
          await db.transaction(async (trx) => {
            for (const userId of new Set(userIds)) {
              const rows = await trx.query(
                `INSERT INTO attendance_group_members (org_id, group_id, user_id, created_at, updated_at)
                 VALUES ($1, $2, $3, now(), now())
                 ON CONFLICT (org_id, group_id, user_id) DO NOTHING
                 RETURNING *`,
                [orgId, groupId, userId]
              )
              if (rows.length) created.push(mapAttendanceGroupMemberRow(rows[0]))
            }
          })
          res.json({ ok: true, data: { items: created } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance group member create failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to add group members' } })
        }
      })
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/attendance/groups/:id/members/:userId',
      withPermission('attendance:admin', async (req, res) => {
        const orgId = getOrgId(req)
        const groupId = req.params.id
        const userId = req.params.userId
        try {
          const rows = await db.query(
            'DELETE FROM attendance_group_members WHERE org_id = $1 AND group_id = $2 AND user_id = $3 RETURNING id',
            [orgId, groupId, userId]
          )
          if (!rows.length) {
            res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Member not found' } })
            return
          }
          res.json({ ok: true, data: { id: rows[0].id } })
        } catch (error) {
          if (isDatabaseSchemaError(error)) {
            res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attendance tables missing' } })
            return
          }
          logger.error('Attendance group member delete failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to remove group member' } })
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
      '/api/attendance/holidays/sync',
      withPermission('attendance:admin', async (req, res) => {
        const parsed = holidaySyncSchema.safeParse(req.body ?? {})
        if (!parsed.success) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
          return
        }
        const orgId = getOrgId(req)
        const settings = await getSettings(db)
        const years = resolveHolidaySyncYears(settings, parsed.data)

        try {
          const { syncConfig, totalFetched, totalApplied, results, lastRun } = await performHolidaySync({
            db,
            logger,
            orgId,
            settings,
            payload: parsed.data,
          })

          res.json({
            ok: true,
            data: {
              source: syncConfig.source,
              baseUrl: syncConfig.baseUrl,
              years,
              addDayIndex: syncConfig.addDayIndex,
              dayIndexHolidays: syncConfig.dayIndexHolidays,
              dayIndexMaxDays: syncConfig.dayIndexMaxDays,
              dayIndexFormat: syncConfig.dayIndexFormat,
              overwrite: syncConfig.overwrite,
              totalFetched,
              totalApplied,
              results,
              lastRun,
            },
          })
        } catch (error) {
          const lastRun = {
            ranAt: new Date().toISOString(),
            success: false,
            years,
            totalFetched: 0,
            totalApplied: 0,
            error: error instanceof Error ? error.message : 'Holiday sync failed',
          }
          try {
            await saveSettings(db, {
              ...settings,
              holidaySync: {
                ...(settings.holidaySync || {}),
                lastRun,
              },
            })
          } catch (persistError) {
            logger.warn('Failed to persist holiday sync status', persistError)
          }
          logger.error('Attendance holiday sync failed', error)
          res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to sync holidays' } })
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
          scheduleHolidaySync({ db, logger, emit: emitEvent })
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
	      scheduleHolidaySync({ db, logger, emit: emitEvent })
	      scheduleImportUploadCleanup()
	    } catch (error) {
	      logger.warn('Attendance settings preload failed', error)
	    }

    logger.info('Attendance plugin activated')
  },

	  async deactivate() {
	    clearAutoAbsenceSchedule()
	    clearHolidaySyncSchedule()
	    if (importUploadCleanupInterval) clearInterval(importUploadCleanupInterval)
	    importUploadCleanupInterval = null
	  }
}
