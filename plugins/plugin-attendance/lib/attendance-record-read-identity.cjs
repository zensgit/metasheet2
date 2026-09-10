// Only the records/calendar reader uses this boundary. JWT middleware sets
// authenticatedTenantId before its legacy header fallback into user.tenantId.
function resolveAttendanceRecordReadIdentity(req, res) {
  const actorId = req.user?.id
  const tenantId = req.authenticatedTenantId
  const valid = value => typeof value === 'string' && value.length > 0 && value.trim() === value
  const reject = (status, code) => {
    res.status(status).json({ ok: false, error: { code, message: 'Attendance access denied' } })
    return null
  }
  if (!valid(actorId)) return reject(401, 'UNAUTHORIZED')
  if (!valid(tenantId)) return reject(403, 'FORBIDDEN')
  const selectors = [req.body?.orgId, req.query?.orgId, req.headers?.['x-org-id'], req.headers?.['x-tenant-id'],
    req.user?.orgId, req.user?.workspaceId]
  if (selectors.some(value => value !== undefined && (!valid(value) || value !== tenantId))) {
    return reject(403, 'FORBIDDEN')
  }
  const actorHint = req.headers?.['x-user-id']
  if (actorHint !== undefined && (!valid(actorHint) || actorHint !== actorId)) return reject(403, 'FORBIDDEN')
  return { actorId, orgId: tenantId }
}

module.exports = { resolveAttendanceRecordReadIdentity }
