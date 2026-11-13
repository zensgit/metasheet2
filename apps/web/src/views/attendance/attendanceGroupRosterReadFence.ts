interface AttendanceGroupRosterReadContext {
  groupId: string
  orgId: string
}

export function createAttendanceGroupRosterReadFence(
  readContext: () => AttendanceGroupRosterReadContext,
  isSessionCurrent: () => boolean,
) {
  let generation = 0
  return {
    invalidate() { generation += 1 },
    begin() {
      const request = ++generation
      const context = readContext()
      return () => {
        const current = readContext()
        return request === generation
          && context.groupId === current.groupId
          && context.orgId === current.orgId
          && isSessionCurrent()
      }
    },
  }
}
