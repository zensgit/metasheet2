export type DirectoryPreviewGroupEffectsInput = {
  plans: Array<{ marker: string; memberUserIds: string[] }>
  grantSet: { userIds: string[]; roleIds: string[]; namespaces: string[] }
  existingGroups: Array<{ id: string; description: string }>
  members: Array<{ groupId: string; userId: string }>
  rolePairs: Array<{ userId: string; roleId: string }>
  namespacePairs: Array<{ userId: string; namespace: string; enabled: boolean }>
}

export type DirectoryPreviewGroupEffects = {
  wouldCreateMemberGroups: number
  wouldSyncMemberGroups: number
  wouldAddMemberGroupMemberships: number
  wouldRemoveMemberGroupMemberships: number
  wouldAssignRoles: number
  wouldAdmitNamespaces: number
}

export function projectDirectoryPreviewGroupEffects(
  options: DirectoryPreviewGroupEffectsInput,
): DirectoryPreviewGroupEffects {
  const effects: DirectoryPreviewGroupEffects = {
    wouldCreateMemberGroups: 0,
    wouldSyncMemberGroups: 0,
    wouldAddMemberGroupMemberships: 0,
    wouldRemoveMemberGroupMemberships: 0,
    wouldAssignRoles: 0,
    wouldAdmitNamespaces: 0,
  }
  if (options.plans.length === 0) return effects

  const membersByGroup = new Map<string, Set<string>>()
  for (const { groupId, userId } of options.members) {
    if (!membersByGroup.has(groupId)) membersByGroup.set(groupId, new Set())
    membersByGroup.get(groupId)!.add(userId)
  }
  const membersByMarker = new Map<string, Set<string>>()
  for (const { id, description } of options.existingGroups) {
    if (!membersByGroup.has(id)) membersByGroup.set(id, new Set())
    membersByMarker.set(description, membersByGroup.get(id)!)
  }

  for (const plan of options.plans) {
    let current = membersByMarker.get(plan.marker)
    if (!current) {
      current = new Set<string>()
      membersByMarker.set(plan.marker, current)
      effects.wouldCreateMemberGroups += 1
    }
    effects.wouldSyncMemberGroups += 1
    const desired = new Set(plan.memberUserIds)
    for (const userId of current) {
      if (!desired.has(userId)) effects.wouldRemoveMemberGroupMemberships += 1
    }
    for (const userId of desired) {
      if (!current.has(userId)) effects.wouldAddMemberGroupMemberships += 1
    }
    current.clear()
    for (const userId of desired) current.add(userId)
  }

  const users = new Set(options.grantSet.userIds)
  const roles = new Set(options.grantSet.roleIds)
  const namespaces = new Set(options.grantSet.namespaces)
  if (users.size === 0 || (roles.size === 0 && namespaces.size === 0)) return effects

  const assignedPairs = new Set(
    options.rolePairs.map(({ userId, roleId }) => JSON.stringify([userId, roleId])),
  )
  const enabledPairs = new Set(
    options.namespacePairs
      .filter(({ enabled }) => enabled === true)
      .map(({ userId, namespace }) => JSON.stringify([userId, namespace])),
  )
  for (const userId of users) {
    for (const roleId of roles) {
      if (!assignedPairs.has(JSON.stringify([userId, roleId]))) effects.wouldAssignRoles += 1
    }
    for (const namespace of namespaces) {
      if (!enabledPairs.has(JSON.stringify([userId, namespace]))) effects.wouldAdmitNamespaces += 1
    }
  }
  return effects
}
