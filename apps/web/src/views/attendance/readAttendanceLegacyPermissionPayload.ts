export type AttendanceLegacyPermissionPayload = {
  permissions: string[]
  isAdmin: boolean
}

export function readAttendanceLegacyPermissionPayload(
  payload: unknown,
  requestedUserId: string,
): AttendanceLegacyPermissionPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.degraded === true || record.unavailable === true) return null
  if (typeof record.userId !== 'string' || record.userId !== requestedUserId) return null
  if (typeof record.isAdmin !== 'boolean') return null
  if (!Array.isArray(record.permissions)) return null
  const permissions: string[] = []
  for (const item of record.permissions) {
    if (typeof item !== 'string' || item.length === 0) return null
    permissions.push(item)
  }
  return { permissions, isAdmin: record.isAdmin }
}
