// Import writes carry orgId in JSON. Follow-up GETs must carry the same selector:
// legacy import reads do not derive it from the authenticated tenant claim.
export function scopeAttendanceImportUrl(rawUrl, orgId) {
  const url = new URL(rawUrl)
  if (!url.pathname.startsWith('/api/attendance/import/')) return rawUrl
  const existing = url.searchParams.getAll('orgId')
  if (existing.some(value => value !== orgId)) {
    throw new Error('ATTENDANCE_IMPORT_ORG_MISMATCH')
  }
  url.searchParams.set('orgId', orgId)
  return url.toString()
}
