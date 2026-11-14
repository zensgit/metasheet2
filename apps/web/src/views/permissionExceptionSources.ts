export type PermissionExceptionTone = 'info' | 'error'

export type PermissionExceptionInheritedRole = {
  roleId: string
  roleName: string | null
  nameKnown: boolean
  permissions: string[] | null
}

export type PermissionExceptionInheritedRoleLink = {
  roleId: string
  label: string
  href: string
  unknownName: boolean
  permissionsKnown: boolean
  permissionText: string
}

export type PermissionExceptionConfirmRequest =
  | { kind: 'grant' | 'revoke'; userId: string; userLabel: string; permission: string }
  | { kind: 'template'; userId: string; userLabel: string; templateId: string; templateName: string; permissions: string[] }
  | { kind: 'legacy'; userId: string; userLabel: string; permission: string }

export type PermissionExceptionLegacyInspection = {
  degraded: boolean
  subjectMatched: boolean
  sourceKnown: boolean
  direct: string[]
  inherited: string[]
  legacy: string[]
}

export const PERMISSION_EXCEPTION_MULTITABLE_HREF = '/multitable'
export const PERMISSION_EXCEPTION_ROLES_HREF = '/admin/roles'
export const PERMISSION_EXCEPTION_USERS_HREF = '/admin/users'

export const PERMISSION_EXCEPTION_OBJECT_NOTE =
  '打开多维表，进入具体数据表，用该表的权限管理设置数据表和字段：工具栏「权限」里有数据表访问权限和字段权限。记录权限请打开该记录的记录详情，再选择「权限」。'

export function permissionExceptionRoleRemovalHref(roleId: string, userId: string): string {
  const query = new URLSearchParams()
  query.set('roleId', roleId)
  query.set('userId', userId)
  return `${PERMISSION_EXCEPTION_ROLES_HREF}?${query.toString()}`
}

export function readPermissionExceptionInheritedRoles(value: unknown): PermissionExceptionInheritedRole[] | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) return null
  const roles: PermissionExceptionInheritedRole[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const record = item as Record<string, unknown>
    const roleId = typeof record.roleId === 'string' ? record.roleId.trim() : ''
    if (!roleId) return null
    if (record.roleName != null && typeof record.roleName !== 'string') return null
    const roleNameText = typeof record.roleName === 'string' ? record.roleName.trim() : ''
    const nameKnown = roleNameText.length > 0
    if (record.permissions !== undefined && !Array.isArray(record.permissions)) return null
    let permissions: string[] | null = null
    if (Array.isArray(record.permissions)) {
      const codes: string[] = []
      for (const code of record.permissions) {
        if (typeof code !== 'string' || code.length === 0) return null
        codes.push(code)
      }
      permissions = codes
    }
    roles.push({
      roleId,
      roleName: nameKnown ? roleNameText : null,
      nameKnown,
      permissions,
    })
  }
  return roles
}

export function describePermissionExceptionInheritedSources(input: {
  userId: string
  readable: boolean
  inheritedRoles: PermissionExceptionInheritedRole[] | null
}): { mode: 'hidden' | 'roles' | 'generic'; roles: PermissionExceptionInheritedRoleLink[] } {
  if (!input.readable || !input.userId) return { mode: 'hidden', roles: [] }
  if (input.inheritedRoles === null) return { mode: 'generic', roles: [] }
  return {
    mode: 'roles',
    roles: input.inheritedRoles.map((role) => ({
      roleId: role.roleId,
      label: role.nameKnown && role.roleName ? role.roleName : `未知角色（${role.roleId}）`,
      href: permissionExceptionRoleRemovalHref(role.roleId, input.userId),
      unknownName: !role.nameKnown,
      permissionsKnown: role.permissions !== null,
      permissionText: role.permissions ? role.permissions.join('、') : '',
    })),
  }
}

export function describePermissionExceptionConfirm(input: PermissionExceptionConfirmRequest): { title: string; summary: string } {
  const target = `用户 ${input.userLabel}（${input.userId}）`
  if (input.kind === 'grant') {
    return {
      title: '确认添加直接授权',
      summary: `将为${target}添加直接授权 ${input.permission}。角色不会改变，插件准入不会改变。这不会移除角色继承。`,
    }
  }
  if (input.kind === 'revoke') {
    return {
      title: '确认移除直接授权',
      summary: `将移除${target}的直接授权 ${input.permission}。角色不会改变，插件准入不会改变。这不会移除角色继承或历史授权。`,
    }
  }
  if (input.kind === 'template') {
    const codes = input.permissions.length > 0 ? input.permissions.join('、') : '（没有权限码）'
    return {
      title: '确认按模板写入直接授权',
      summary: `将为${target}按模板 ${input.templateName} 写入这些直接授权：${codes}。角色不会改变，插件准入不会改变。参考角色（不会分配）。`,
    }
  }
  return {
    title: '确认清除历史授权',
    summary: `将清除${target}的历史授权 ${input.permission}。角色、平台管理员身份、直接授权和插件准入不会改变。同一权限码仍可能留在直接授权或角色里，这不是整项权限的总撤销。`,
  }
}

export function readPermissionExceptionLegacyRevokeAcknowledgement(
  payload: unknown,
  requestedUserId: string,
  permission: string,
): { accepted: boolean; degraded: boolean; message: string } {
  const target = `用户 ${requestedUserId}`
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { accepted: false, degraded: false, message: `${target} 的历史授权回执无法解析，未把本次结果当作已清除` }
  }
  const record = payload as Record<string, unknown>
  if (record.degraded === true || record.unavailable === true) {
    return { accepted: false, degraded: true, message: `${target} 的历史授权回执不可用，未把本次结果当作已清除` }
  }
  if (record.success !== true || record.userId !== requestedUserId || record.permission !== permission || record.changed !== true) {
    return { accepted: false, degraded: false, message: `${target} 的历史授权回执不能证明 ${permission} 已经清除，未把本次结果当作已清除` }
  }
  return { accepted: true, degraded: false, message: '' }
}

function legacyRevokeOutcomeUnknown(httpStatus: number | undefined): boolean {
  return httpStatus == null || httpStatus >= 500
}

export function describePermissionExceptionLegacyRevoke(input: {
  requestedUserId: string
  selectedUserId: string
  permission: string
  ok: boolean
  httpStatus?: number
  errorMessage?: string
  writeAcknowledged?: boolean
  inspection?: PermissionExceptionLegacyInspection | null
}): { applyInspection: boolean; offerReadOnlyReread: boolean; tone: PermissionExceptionTone; message: string } {
  const untouched = '角色、平台管理员身份、直接授权和插件准入不会因此改变。'
  if (!input.ok && legacyRevokeOutcomeUnknown(input.httpStatus)) {
    const coverage = input.selectedUserId === input.requestedUserId
      ? ''
      : `该结果未覆盖当前选中用户 ${input.selectedUserId}。`
    return {
      applyInspection: false,
      offerReadOnlyReread: true,
      tone: 'error',
      message: `未能确认清除结果。还不能判断用户 ${input.requestedUserId} 的历史授权 ${input.permission} 是否已去掉。${coverage}请只读重新读取，不会自动再次清除。`,
    }
  }
  if (input.selectedUserId !== input.requestedUserId) {
    return {
      applyInspection: false,
      offerReadOnlyReread: false,
      tone: 'error',
      message: `用户 ${input.requestedUserId} 的历史授权结果未覆盖当前选中用户 ${input.selectedUserId}。${untouched}`,
    }
  }
  if (!input.ok) {
    const status = input.httpStatus ? `服务返回 ${input.httpStatus}。` : ''
    const detail = input.errorMessage ? `${input.errorMessage}。` : ''
    return {
      applyInspection: false,
      offerReadOnlyReread: false,
      tone: 'error',
      message: `没有清除用户 ${input.requestedUserId} 的历史授权 ${input.permission}。${status}${detail}${untouched}`,
    }
  }
  if (input.writeAcknowledged === false) {
    return {
      applyInspection: false,
      offerReadOnlyReread: false,
      tone: 'error',
      message: input.errorMessage || `用户 ${input.requestedUserId} 的历史授权回执不能证明 ${input.permission} 已经清除，未把本次结果当作已清除`,
    }
  }
  const inspection = input.inspection
  if (!inspection || inspection.degraded || !inspection.subjectMatched || !inspection.sourceKnown) {
    return {
      applyInspection: false,
      offerReadOnlyReread: false,
      tone: 'error',
      message: `历史授权已提交，但权限回读不可用，不能把当前列表当作已清除。${untouched}`,
    }
  }
  if (inspection.legacy.includes(input.permission)) {
    return {
      applyInspection: true,
      offerReadOnlyReread: false,
      tone: 'error',
      message: `回读里用户 ${input.requestedUserId} 的历史授权仍包含 ${input.permission}，不能当成已清除。${untouched}`,
    }
  }
  const retained: string[] = []
  if (inspection.direct.includes(input.permission)) retained.push('直接授权')
  if (inspection.inherited.includes(input.permission)) retained.push('角色继承')
  const retainedText = retained.length > 0
    ? `${retained.join('和')}里仍有这项权限码。`
    : '这次回读的直接授权和角色继承里没有这项权限码。'
  return {
    applyInspection: true,
    offerReadOnlyReread: false,
    tone: 'info',
    message: `已清除用户 ${input.requestedUserId} 的历史授权 ${input.permission}。${untouched}${retainedText}这不是整项权限的总撤销。`,
  }
}
