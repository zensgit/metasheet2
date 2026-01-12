const { randomUUID } = require('crypto')
const { z } = require('zod')

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

function computeMetrics(options) {
  const { rule, firstInAt, lastOutAt, isWorkingDay } = options

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

  return { workMinutes, lateMinutes, earlyLeaveMinutes, status }
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

async function resolveWorkContext(options) {
  const { db, orgId, userId, workDate, defaultRule, holidayOverride } = options
  const rule = defaultRule ?? await loadDefaultRule(db, orgId)
  const holiday = holidayOverride ?? await loadHoliday(db, orgId, workDate)
  const assignmentInfo = userId ? await loadShiftAssignment(db, orgId, userId, workDate) : null
  const profile = assignmentInfo?.shift ?? rule
  const weekday = getWeekdayFromDateKey(workDate)
  let isWorkingDay = profile.workingDays.includes(weekday)
  if (holiday) {
    isWorkingDay = holiday.isWorkingDay === true
  }
  return {
    rule: profile,
    assignment: assignmentInfo?.assignment ?? null,
    holiday,
    isWorkingDay,
    source: assignmentInfo ? 'shift' : 'rule',
  }
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
    isWorkday,
    client,
  } = options

  const existing = await client.query(
    'SELECT * FROM attendance_records WHERE user_id = $1 AND work_date = $2 AND org_id = $3 FOR UPDATE',
    [userId, workDate, orgId]
  )

  let firstInAt = existing[0]?.first_in_at ?? null
  let lastOutAt = existing[0]?.last_out_at ?? null

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
  })
  const status = statusOverride ?? metrics.status

  const updated = await client.query(
    `INSERT INTO attendance_records
      (user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
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
       updated_at = now()
     RETURNING *`,
    [
      userId,
      orgId,
      workDate,
      timezone,
      firstInAt,
      lastOutAt,
      metrics.workMinutes,
      metrics.lateMinutes,
      metrics.earlyLeaveMinutes,
      status,
      isWorkday !== false,
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

          res.json({
            ok: true,
            data: {
              items: rows,
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
          const rows = await db.query(
            `SELECT
               COALESCE(SUM(CASE WHEN is_workday THEN 1 ELSE 0 END), 0)::int AS total_days,
               COALESCE(SUM(CASE WHEN is_workday THEN work_minutes ELSE 0 END), 0)::int AS total_minutes,
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
            [targetUserId, orgId, from, to]
          )

          const row = rows[0] ?? {}
          const summary = {
            total_days: Number(row.total_days ?? 0),
            total_minutes: Number(row.total_minutes ?? 0),
            normal_days: Number(row.normal_days ?? 0),
            late_days: Number(row.late_days ?? 0),
            early_leave_days: Number(row.early_leave_days ?? 0),
            late_early_days: Number(row.late_early_days ?? 0),
            partial_days: Number(row.partial_days ?? 0),
            absent_days: Number(row.absent_days ?? 0),
            adjusted_days: Number(row.adjusted_days ?? 0),
            off_days: Number(row.off_days ?? 0),
          }

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
      'POST',
      '/api/attendance/requests',
      withPermission('attendance:write', async (req, res) => {
        const schema = z.object({
          workDate: z.string(),
          requestType: z.enum(['missed_check_in', 'missed_check_out', 'time_correction']),
          requestedInAt: z.string().optional(),
          requestedOutAt: z.string().optional(),
          reason: z.string().optional(),
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

        const requestedInAt = parseDateInput(parsed.data.requestedInAt)
        const requestedOutAt = parseDateInput(parsed.data.requestedOutAt)

        if (parsed.data.requestType === 'missed_check_in' && !requestedInAt) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'requestedInAt required' } })
          return
        }
        if (parsed.data.requestType === 'missed_check_out' && !requestedOutAt) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'requestedOutAt required' } })
          return
        }
        if (parsed.data.requestType === 'time_correction' && !requestedInAt && !requestedOutAt) {
          res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'requestedInAt or requestedOutAt required' } })
          return
        }

        const approvalId = `apv_${randomUUID()}`
        const orgId = getOrgId(req)

        try {
          const request = await db.transaction(async (trx) => {
            await trx.query(
              'INSERT INTO approval_instances (id, status, version) VALUES ($1, $2, $3)',
              [approvalId, 'pending', 0]
            )

            const rows = await trx.query(
              `INSERT INTO attendance_requests
               (id, user_id, org_id, work_date, request_type, requested_in_at, requested_out_at, reason, status, approval_instance_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               RETURNING *`,
              [
                randomUUID(),
                userId,
                orgId,
                parsed.data.workDate,
                parsed.data.requestType,
                requestedInAt,
                requestedOutAt,
                parsed.data.reason ?? null,
                'pending',
                approvalId,
              ]
            )

            return rows[0]
          })

          emitEvent('attendance.requested', {
            orgId,
            userId,
            workDate: parsed.data.workDate,
            requestType: parsed.data.requestType,
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
          const newStatus = action === 'approve' ? 'approved' : 'rejected'
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
              action,
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

          const resolvedAt = new Date()
          await trx.query(
            `UPDATE attendance_requests
             SET status = $2, resolved_by = $3, resolved_at = $4, updated_at = now()
             WHERE id = $1`,
            [requestId, newStatus, requesterId, resolvedAt]
          )

          let record = null
          const orgId = requestRow.org_id ?? DEFAULT_ORG_ID
          if (action === 'approve') {
            const baseRule = await loadDefaultRule(trx, orgId)
            const context = await resolveWorkContext({
              db: trx,
              orgId,
              userId: requestRow.user_id,
              workDate: requestRow.work_date,
              defaultRule: baseRule,
            })
            const timezone = context.rule.timezone
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
              client: trx,
            })

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
                JSON.stringify({
                  requestId,
                  requested_in_at: requestRow.requested_in_at,
                  requested_out_at: requestRow.requested_out_at,
                }),
              ]
            )
          }

          return { requestId, status: newStatus, record, orgId, userId: requestRow.user_id }
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
