interface AttendanceGroupManagerIdentity {
  userId?: string | null
  user_id?: string | null
  createdBy?: string | null
  created_by?: string | null
}

type ResolvedLabels = Readonly<Record<string, { name?: string | null; email?: string | null }>>

export function attendanceGroupManagerCreatorId(manager: AttendanceGroupManagerIdentity): string {
  return manager.createdBy?.trim() || manager.created_by?.trim() || ''
}

export function collectAttendanceGroupManagerUserIds(managers: readonly AttendanceGroupManagerIdentity[]): string[] {
  const seen = new Set<string>()
  const userIds: string[] = []
  const push = (id: string) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    userIds.push(id)
  }
  for (const manager of managers) push(String(manager.userId || manager.user_id || '').trim())
  for (const manager of managers) push(attendanceGroupManagerCreatorId(manager))
  return userIds
}

export function attendanceGroupManagerCreatorLabel(
  manager: AttendanceGroupManagerIdentity,
  resolved: ResolvedLabels,
  neutralLabel: string,
): string {
  const id = attendanceGroupManagerCreatorId(manager)
  if (!id) return '-'
  const item = Object.prototype.hasOwnProperty.call(resolved, id) ? resolved[id] : undefined
  return item?.name?.trim() || item?.email?.trim() || neutralLabel
}
