// Attendance leftovers (2026-09-17): ACL slice A — parent-side task-home filter.
// UX only. Server list/get is the security boundary. Charter §6.2: TaskHome renders
// exactly the groups the parent hands it.

export const ATTENDANCE_GROUP_CATALOG_SCOPES = ['org', 'managed', 'unknown'] as const
export type AttendanceGroupCatalogScope = (typeof ATTENDANCE_GROUP_CATALOG_SCOPES)[number]

/** Group keys a non-fullAdmin group manager may see on the task home (slice A). */
export const MANAGED_TASK_HOME_GROUP_KEYS = ['people-groups'] as const

/** people-groups actions a scoped manager may see. Org-level wizard / access stay hidden. */
export const MANAGED_PEOPLE_GROUPS_ACTION_KEYS = ['attendance-groups', 'team-availability'] as const

export function resolveAttendanceGroupCatalogScope(value: unknown): AttendanceGroupCatalogScope {
  if (value === 'org' || value === 'managed' || value === 'unknown') return value
  return 'unknown'
}

export type FilterableTaskHomeAction = { key: string }
export type FilterableTaskHomeGroup<TAction extends FilterableTaskHomeAction> = {
  key: string
  actions: TAction[]
}

/**
 * Full admin / unknown (not yet loaded) keep the four-group catalog so the common
 * admin first paint does not flash empty. `managed` keeps only group-ops entries.
 */
export function filterAdminTaskHomeGroupsForCatalogScope<TAction extends FilterableTaskHomeAction, TGroup extends FilterableTaskHomeGroup<TAction>>(
  groups: readonly TGroup[],
  scope: AttendanceGroupCatalogScope,
): TGroup[] {
  if (scope !== 'managed') return [...groups]
  const allowedGroups = new Set<string>(MANAGED_TASK_HOME_GROUP_KEYS)
  const allowedActions = new Set<string>(MANAGED_PEOPLE_GROUPS_ACTION_KEYS)
  return groups
    .filter((group) => allowedGroups.has(group.key))
    .map((group) => ({
      ...group,
      actions: group.actions.filter((action) => allowedActions.has(action.key)),
    }))
}

export function attendanceGroupEmptyListCopy(
  scope: AttendanceGroupCatalogScope,
  tr: (en: string, zh: string) => string,
): string {
  if (scope === 'managed') {
    return tr('You are not the owner of any attendance group.', '你不是任何考勤组的负责人')
  }
  return tr('No attendance groups yet. Create one to start configuring members.', '暂无考勤组。先新建一个考勤组，再配置成员。')
}
