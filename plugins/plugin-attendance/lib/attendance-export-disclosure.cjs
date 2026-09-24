'use strict'

// Report export safety cap. Rows past this limit are disclosed, not fetched.
const ATTENDANCE_EXPORT_MAX_ROWS = 5000
const ATTENDANCE_EXPORT_STATUS_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

function resolveAttendanceExportLimit(raw) {
  if (raw == null || raw === '') return ATTENDANCE_EXPORT_MAX_ROWS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return ATTENDANCE_EXPORT_MAX_ROWS
  return Math.min(ATTENDANCE_EXPORT_MAX_ROWS, Math.max(1, Math.floor(parsed)))
}

function normalizeAttendanceExportStatus(raw) {
  if (raw == null) return { ok: true, value: null }
  const text = String(raw).trim().toLowerCase()
  if (!text || text === 'all') return { ok: true, value: null }
  if (!ATTENDANCE_EXPORT_STATUS_PATTERN.test(text)) {
    return { ok: false, message: 'status must be a lowercase attendance status token' }
  }
  return { ok: true, value: text }
}

function buildAttendanceExportDisclosure({ matchedTotal, returned, limit, status }) {
  const total = Math.max(0, Math.floor(Number(matchedTotal) || 0))
  const rowCount = Math.max(0, Math.floor(Number(returned) || 0))
  const appliedLimit = resolveAttendanceExportLimit(limit)
  return {
    matchedTotal: total,
    returned: rowCount,
    limit: appliedLimit,
    truncated: total > rowCount,
    status: status || 'all',
  }
}

function applyAttendanceExportDisclosureHeaders(res, disclosure) {
  res.setHeader('X-Attendance-Export-Total', String(disclosure.matchedTotal))
  res.setHeader('X-Attendance-Export-Returned', String(disclosure.returned))
  res.setHeader('X-Attendance-Export-Limit', String(disclosure.limit))
  res.setHeader('X-Attendance-Export-Truncated', disclosure.truncated ? 'true' : 'false')
  res.setHeader('X-Attendance-Export-Status', disclosure.status || 'all')
}

module.exports = {
  ATTENDANCE_EXPORT_MAX_ROWS,
  ATTENDANCE_EXPORT_STATUS_PATTERN,
  resolveAttendanceExportLimit,
  normalizeAttendanceExportStatus,
  buildAttendanceExportDisclosure,
  applyAttendanceExportDisclosureHeaders,
}
