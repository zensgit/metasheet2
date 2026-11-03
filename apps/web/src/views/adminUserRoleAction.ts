export type RoleActionTone = 'info' | 'error'

export type SelectedRoleMembership = {
  state: 'none' | 'held' | 'not-held'
  text: string
}

export type RoleMembershipWriteInput = {
  action: 'assign' | 'unassign'
  requestedUserId: string
  selectedUserId: string
  roleId: string
  persistedRoleIds: readonly string[]
  roleHeld?: boolean
  membershipChanged?: boolean
  actorId?: string
  snapshotUserId?: string
  changedRoleId?: string
  rolesVerified?: boolean
  ok: boolean
  errorMessage?: string
}

export type RoleMembershipSnapshot = {
  user: { id: string }
  roles: string[]
  permissions: string[]
  isAdmin: boolean
}

export type RoleMembershipWriteOutcome = {
  applySnapshot: boolean
  tone: RoleActionTone
  message: string
}

function heldAfterWrite(input: RoleMembershipWriteInput): boolean | null {
  if (input.roleHeld === true) return true
  if (input.roleHeld === false) return input.persistedRoleIds.includes(input.roleId)
  return null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
}

export function nextAccessReadGeneration(current: number): number {
  return current + 1
}

export function accessReadStillCurrent(
  startedGeneration: number,
  currentGeneration: number,
  requestedUserId: string,
  selectedUserId: string,
): boolean {
  return startedGeneration === currentGeneration && requestedUserId === selectedUserId
}

export function userAccessSnapshotMatches(
  snapshot: { user?: { id?: unknown } | null; roles?: unknown } | null | undefined,
  userId: string,
): boolean {
  if (!snapshot?.user || typeof snapshot.user !== 'object') return false
  if (snapshot.user.id !== userId) return false
  return isStringArray(snapshot.roles)
}

function unverifiedRoleReadback(input: RoleMembershipWriteInput): RoleMembershipWriteOutcome {
  const actor = actorSuffix(input.actorId)
  return {
    applySnapshot: false,
    tone: 'error',
    message: `用户 ${input.requestedUserId} 的角色回读不完整或主体不一致，不能把缺失的角色列表当作未持有${actor}`,
  }
}

export function roleWriteOutcomeFromPayload(
  data: unknown,
  input: {
    action: 'assign' | 'unassign'
    requestedUserId: string
    selectedUserId: string
    roleId: string
  },
): { outcome: RoleMembershipWriteOutcome; snapshot: RoleMembershipSnapshot | null } {
  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null
  const user = record?.user && typeof record.user === 'object' && !Array.isArray(record.user)
    ? record.user as Record<string, unknown>
    : null
  const userId = typeof user?.id === 'string' ? user.id : ''
  const roles = record ? record.roles : undefined
  const permissions = record ? record.permissions : undefined
  const changedRoleId = typeof record?.changedRoleId === 'string' ? record.changedRoleId : ''
  const roleHeld = record?.roleHeld
  const membershipChanged = record?.membershipChanged
  const trusted = Boolean(
    record
    && user
    && userId === input.requestedUserId
    && isStringArray(roles)
    && isStringArray(permissions)
    && typeof record.isAdmin === 'boolean'
    && (roleHeld === true || roleHeld === false)
    && typeof membershipChanged === 'boolean'
    && changedRoleId === input.roleId,
  )
  if (!trusted || !record || !user || !isStringArray(roles) || !isStringArray(permissions)) {
    return {
      snapshot: null,
      outcome: describeRoleMembershipWrite({
        action: input.action,
        requestedUserId: input.requestedUserId,
        selectedUserId: input.selectedUserId,
        roleId: input.roleId,
        persistedRoleIds: [],
        ok: true,
        rolesVerified: false,
      }),
    }
  }
  return {
    snapshot: {
      user: user as { id: string },
      roles,
      permissions,
      isAdmin: record.isAdmin === true,
    },
    outcome: describeRoleMembershipWrite({
      action: input.action,
      requestedUserId: input.requestedUserId,
      selectedUserId: input.selectedUserId,
      roleId: input.roleId,
      persistedRoleIds: roles,
      roleHeld: roleHeld === true,
      membershipChanged: membershipChanged === true,
      actorId: typeof record.actorId === 'string' ? record.actorId : undefined,
      snapshotUserId: userId,
      changedRoleId,
      rolesVerified: true,
      ok: true,
    }),
  }
}

function actorSuffix(actorId: string | undefined): string {
  return actorId ? `（操作者 ${actorId}）` : ''
}

export function selectedRoleMembershipHint(
  selectedRoleId: string,
  assignedRoleIds: readonly string[],
): SelectedRoleMembership {
  const roleId = selectedRoleId.trim()
  if (!roleId) {
    return { state: 'none', text: '请选择角色，查看当前用户是否已是该角色成员' }
  }
  if (assignedRoleIds.includes(roleId)) {
    return { state: 'held', text: `当前用户已是角色 ${roleId} 的成员` }
  }
  return { state: 'not-held', text: `当前用户不是角色 ${roleId} 的成员` }
}

export function describeRoleMembershipWrite(input: RoleMembershipWriteInput): RoleMembershipWriteOutcome {
  const actor = actorSuffix(input.actorId)
  const target = `用户 ${input.requestedUserId}`
  const switched = input.requestedUserId !== input.selectedUserId

  if (!input.ok) {
    const failure = input.errorMessage || '保存角色失败'
    return {
      applySnapshot: false,
      tone: 'error',
      message: switched
        ? `针对${target}的角色操作失败：${failure}。未覆盖当前选中用户 ${input.selectedUserId} 的状态${actor}`
        : failure,
    }
  }

  if (
    input.rolesVerified === false
    || (input.snapshotUserId !== undefined && input.snapshotUserId !== input.requestedUserId)
    || (input.changedRoleId !== undefined && input.changedRoleId !== input.roleId)
  ) {
    return unverifiedRoleReadback(input)
  }

  const held = heldAfterWrite(input)
  if (held === null) return unverifiedRoleReadback(input)
  const applySnapshot = !switched
  if (switched) {
    return {
      applySnapshot: false,
      tone: 'info',
      message: `针对${target}的角色操作已完成，未覆盖当前选中用户 ${input.selectedUserId} 的状态${actor}`,
    }
  }

  if (input.action === 'unassign') {
    if (held) {
      return {
        applySnapshot,
        tone: 'error',
        message: `撤销未改变成员关系：${target} 仍持有角色 ${input.roleId}${actor}`,
      }
    }
    if (input.membershipChanged === false) {
      return {
        applySnapshot,
        tone: 'info',
        message: `${target} 当前未持有角色 ${input.roleId}，成员关系未变化${actor}`,
      }
    }
    return {
      applySnapshot,
      tone: 'info',
      message: `已撤销角色 ${input.roleId}，${target} 当前未持有该角色${actor}`,
    }
  }

  if (!held) {
    return {
      applySnapshot,
      tone: 'error',
      message: `分配未写入成员关系：${target} 仍未持有角色 ${input.roleId}${actor}`,
    }
  }
  if (input.membershipChanged === false) {
    return {
      applySnapshot,
      tone: 'info',
      message: `${target} 已持有角色 ${input.roleId}，成员关系未变化${actor}`,
    }
  }
  return {
    applySnapshot,
    tone: 'info',
    message: `已分配角色 ${input.roleId}，${target} 当前持有该角色${actor}`,
  }
}
