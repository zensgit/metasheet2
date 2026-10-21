// Attendance writes carry orgId in JSON. Follow-up requests must carry the same
// selector: legacy import/request reads do not derive it from the tenant claim.
export function scopeAttendanceImportUrl(rawUrl, orgId) {
  const url = new URL(rawUrl)
  if (!/^\/api\/attendance\/(?:import\/|requests(?:\/|$)|records(?:\/|$))/.test(url.pathname)) return rawUrl
  const existing = url.searchParams.getAll('orgId')
  if (existing.some(value => value !== orgId)) {
    throw new Error('ATTENDANCE_IMPORT_ORG_MISMATCH')
  }
  url.searchParams.set('orgId', orgId)
  return url.toString()
}
