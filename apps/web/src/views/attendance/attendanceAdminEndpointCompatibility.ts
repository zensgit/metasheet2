export function isAttendanceAdminEndpointUnavailable(status: number, payload: unknown): boolean {
  if (status !== 404) return false
  if (!payload || typeof payload !== 'object') return true
  return (payload as { ok?: unknown }).ok !== false
}
