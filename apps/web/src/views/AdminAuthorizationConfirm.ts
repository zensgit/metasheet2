/**
 * Frozen confirmation for member and role authorization changes.
 * The dialog shows this snapshot. A later edit of the user, role, or
 * admission selection must not be submitted under the old confirmation.
 */

export const PLATFORM_ADMIN_REMOVAL_PHRASE = '取消平台管理员'

export const LAST_PLATFORM_ADMIN_MESSAGE = '不能取消最后一名平台管理员'

export const ROLE_VERSION_MISMATCH_MESSAGE = '角色目录已变化，本次未写入。请刷新角色后再确认。'

export const PLATFORM_ADMIN_AUTHORITY_NOTE = '平台管理员拥有平台管理权限。权限码列表即使为空，也不表示没有管理权限。'

export type AdminAuthorizationKind = 'create-user' | 'assign-role' | 'unassign-role' | 'enable-admission'

export type AdminAuthorizationAdmissionEffect = 'enable' | 'may-close' | 'source-opt-out'

export type AdminAuthorizationAdmissionChange = {
  namespace: string
  effect: AdminAuthorizationAdmissionEffect
}

export type AdminAuthorizationDraft = {
  kind: AdminAuthorizationKind
  targetUserId: string
  targetName: string
  roleId: string
  roleName: string
  /** Preset or action permissions that are granted directly, not via a role. */
  directPermissionCodes: string[]
  /** Permissions listed on the role catalog. Unknown when the role is not in the catalog. */
  inheritedPermissionCodes: string[]
  inheritedKnown: boolean
  admissionChanges: AdminAuthorizationAdmissionChange[]
  /**
   * False when the catalog did not say which namespaces this action can change.
   * An empty change list is then unknown, not a promise that nothing changes.
   */
  admissionKnown: boolean
  /** True when this confirmation is about the platform-admin role or a user who holds it. */
  platformAdminAuthority: boolean
  /** Namespaces the create request will send. Empty means the admin opted into none. */
  admissionNamespaces: string[]
  expectedUpdatedAt: string | null
  requiresTypedPhrase: string | null
  notes: string[]
  fingerprint: string
  /** Frozen create body. Null for actions that are not user creation. */
  createPayload: Record<string, unknown> | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function sortedCopy(values: readonly string[]): string[] {
  return [...values].sort()
}

/**
 * Accept only an explicit string array. Permission codes are not split on ":"
 * and are not turned into namespaces.
 */
export function readAdmissionNamespaceList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const namespaces: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const namespace = item.trim()
    if (!namespace) continue
    namespaces.push(namespace)
  }
  return uniqueStrings(namespaces)
}

/** `known: false` when the server omitted the list or sent a non-array. An empty array is known. */
export function readAdmissionNamespaceFact(value: unknown): { known: boolean; namespaces: string[] } {
  if (!Array.isArray(value)) return { known: false, namespaces: [] }
  return { known: true, namespaces: readAdmissionNamespaceList(value) }
}

export function readExplicitNamespaceAdmissionCapability(source: unknown): boolean {
  if (!isRecord(source)) return false
  const own = source.capabilities
  if (isRecord(own) && own.explicitNamespaceAdmission === true) return true
  const data = source.data
  if (!isRecord(data)) return false
  const nested = data.capabilities
  return isRecord(nested) && nested.explicitNamespaceAdmission === true
}

export function authorizationFingerprint(parts: Record<string, unknown>): string {
  return JSON.stringify(parts)
}

const DEFAULT_ATTENDANCE_ROLE_ID = 'attendance_employee'
const DEFAULT_ATTENDANCE_NAMESPACE = 'attendance'

/**
 * Unassign of attendance_employee always touches attendance, even when the
 * catalog list is empty. disableNamespaceAdmissionsWithoutRoles adds that
 * namespace from the role id. Permission-derived admissionNamespaces does not.
 */
function namespacesTouchedByRevoke(roleId: string, ownNamespaces: readonly string[]): string[] {
  if (roleId !== DEFAULT_ATTENDANCE_ROLE_ID || ownNamespaces.includes(DEFAULT_ATTENDANCE_NAMESPACE)) {
    return [...ownNamespaces]
  }
  return [...ownNamespaces, DEFAULT_ATTENDANCE_NAMESPACE]
}

export function admissionChangesForRevoke(
  roleId: string,
  heldRoleIds: readonly string[],
  namespacesByRoleId: Readonly<Record<string, unknown>>,
): { known: boolean; changes: AdminAuthorizationAdmissionChange[] } {
  if (!Object.prototype.hasOwnProperty.call(namespacesByRoleId, roleId)) {
    return { known: false, changes: [] }
  }
  const own = readAdmissionNamespaceFact(namespacesByRoleId[roleId])
  if (!own.known) return { known: false, changes: [] }
  const covered = new Set<string>()
  for (const heldRoleId of heldRoleIds) {
    if (heldRoleId === roleId) continue
    if (!Object.prototype.hasOwnProperty.call(namespacesByRoleId, heldRoleId)) {
      return { known: false, changes: [] }
    }
    const held = readAdmissionNamespaceFact(namespacesByRoleId[heldRoleId])
    if (!held.known) return { known: false, changes: [] }
    for (const namespace of held.namespaces) covered.add(namespace)
  }
  const changes: AdminAuthorizationAdmissionChange[] = namespacesTouchedByRevoke(roleId, own.namespaces)
    .filter((namespace) => !covered.has(namespace))
    .map((namespace) => ({ namespace, effect: 'may-close' as const }))
  if (roleId === DEFAULT_ATTENDANCE_ROLE_ID) {
    changes.push({ namespace: DEFAULT_ATTENDANCE_NAMESPACE, effect: 'source-opt-out' })
  }
  return { known: true, changes }
}

function phraseForRemoval(action: 'assign' | 'unassign', roleId: string): string | null {
  if (action === 'unassign' && roleId === 'admin') return PLATFORM_ADMIN_REMOVAL_PHRASE
  return null
}

function withPlatformAdminNote(enabled: boolean, notes: string[]): string[] {
  if (!enabled) return notes
  return [...notes, PLATFORM_ADMIN_AUTHORITY_NOTE]
}

export function buildRoleMembershipAuthorization(input: {
  action: 'assign' | 'unassign'
  userId: string
  userName: string
  roleId: string
  roleName: string
  permissionCodes: readonly string[]
  /**
   * False when the role catalog has no usable permission array for this role.
   * Omitted means the caller already knows the list, including an honest empty one.
   */
  permissionKnown?: boolean
  expectedUpdatedAt: string | null
  heldRoleIds: readonly string[]
  heldRolesKnown: boolean
  namespacesByRoleId: Readonly<Record<string, unknown>>
  dropdownRoleId: string
}): AdminAuthorizationDraft {
  const permissionKnown = input.permissionKnown !== false
  const permissionCodes = permissionKnown
    ? uniqueStrings(input.permissionCodes.filter((code) => code.trim().length > 0))
    : []
  const platformAdminAuthority = input.roleId === 'admin'
  const revokeAdmission = input.action === 'unassign'
    ? (input.heldRolesKnown
      ? admissionChangesForRevoke(input.roleId, input.heldRoleIds, input.namespacesByRoleId)
      : { known: false, changes: [] as AdminAuthorizationAdmissionChange[] })
    : { known: true, changes: [] as AdminAuthorizationAdmissionChange[] }
  const admissionChanges = revokeAdmission.changes
  const admissionKnown = revokeAdmission.known
  const mayClose = admissionChanges.some((change) => change.effect === 'may-close')
  const expectedUpdatedAt = input.action === 'assign' && input.expectedUpdatedAt
    ? input.expectedUpdatedAt
    : null
  const unknownPermissionNote = '角色目录没有这份角色，不能把缺失列表当作没有继承权限。'
  const notes = input.action === 'assign'
    ? [
      '只把该用户加入这个角色的成员，不写入直接权限，也不开通插件使用。',
      permissionKnown ? '下列权限码是这个角色会继承的权限。' : unknownPermissionNote,
    ]
    : [
      '只移除这个角色的成员关系，不改直接权限。',
      !admissionKnown
        ? '目前看不出这次会不会关闭插件使用。'
        : mayClose
          ? '如果该用户不再持有这些范围的其他角色，可能会关闭对应的插件使用。'
          : '按目前的角色目录，这次撤销不会关闭插件使用。',
      ...admissionChanges
        .filter((change) => change.effect === 'source-opt-out')
        .map((change) => `${describeAdmissionChange(change)}。`),
      ...(permissionKnown ? [] : [unknownPermissionNote]),
    ]
  const fingerprint = authorizationFingerprint({
    kind: input.action === 'assign' ? 'assign-role' : 'unassign-role',
    userId: input.userId,
    roleId: input.roleId,
    dropdownRoleId: input.dropdownRoleId,
    permissionCodes: sortedCopy(permissionCodes),
    inheritedKnown: permissionKnown,
    admissionKnown,
    admissionNamespaces: admissionChanges
      .filter((change) => change.effect !== 'source-opt-out')
      .map((change) => change.namespace),
    sourceOptOutNamespaces: admissionChanges
      .filter((change) => change.effect === 'source-opt-out')
      .map((change) => change.namespace),
    expectedUpdatedAt,
    platformAdminAuthority,
  })
  return {
    kind: input.action === 'assign' ? 'assign-role' : 'unassign-role',
    targetUserId: input.userId,
    targetName: input.userName,
    roleId: input.roleId,
    roleName: input.roleName,
    directPermissionCodes: [],
    inheritedPermissionCodes: permissionCodes,
    inheritedKnown: permissionKnown,
    admissionChanges,
    admissionKnown,
    platformAdminAuthority,
    admissionNamespaces: [],
    expectedUpdatedAt,
    requiresTypedPhrase: phraseForRemoval(input.action, input.roleId),
    notes: withPlatformAdminNote(platformAdminAuthority, notes),
    fingerprint,
    createPayload: null,
  }
}

/**
 * Permission codes for the named roles, taken only from explicit catalog arrays.
 * A missing role or a non-array value makes the whole list unknown. Callers must
 * not substitute an effective access snapshot.
 */
export function catalogPermissionCodesForRoles(
  roleIds: readonly string[],
  catalogPermissionsByRoleId: Readonly<Record<string, unknown>>,
): { known: boolean; codes: string[] } {
  const codes: string[] = []
  const seen = new Set<string>()
  for (const roleId of roleIds) {
    if (!Object.prototype.hasOwnProperty.call(catalogPermissionsByRoleId, roleId)) {
      return { known: false, codes: [] }
    }
    const value = catalogPermissionsByRoleId[roleId]
    if (!Array.isArray(value)) return { known: false, codes: [] }
    for (const item of value) {
      if (typeof item !== 'string') return { known: false, codes: [] }
      const code = item.trim()
      if (!code || seen.has(code)) continue
      seen.add(code)
      codes.push(code)
    }
  }
  return { known: true, codes }
}

export function buildAdmissionEnableAuthorization(input: {
  userId: string
  userName: string
  namespace: string
  roleIds: readonly string[]
  /**
   * Explicit permission arrays keyed by role id. Omitted roles are unknown.
   * This is not the user's effective permission snapshot.
   */
  catalogPermissionsByRoleId: Readonly<Record<string, unknown>>
  dropdownRoleId: string
}): AdminAuthorizationDraft {
  const namespace = input.namespace.trim()
  const inherited = catalogPermissionCodesForRoles(input.roleIds, input.catalogPermissionsByRoleId)
  const roleLabel = input.roleIds.length > 0 ? input.roleIds.join('、') : '未分配角色'
  const platformAdminAuthority = input.roleIds.includes('admin')
  const fingerprint = authorizationFingerprint({
    kind: 'enable-admission',
    userId: input.userId,
    namespace,
    dropdownRoleId: input.dropdownRoleId,
    roleIds: [...input.roleIds],
    inheritedKnown: inherited.known,
    inheritedPermissionCodes: sortedCopy(inherited.codes),
    platformAdminAuthority,
  })
  const inheritedNote = input.roleIds.length === 0
    ? '当前没有已分配角色，所以没有角色继承权限码。'
    : inherited.known
      ? (inherited.codes.length > 0
        ? '下列权限码来自这些角色在角色目录中的清单。'
        : '这些角色在角色目录里没有权限码。')
      : '角色目录不完整，不能把当前访问快照里的权限码说成角色继承。'
  return {
    kind: 'enable-admission',
    targetUserId: input.userId,
    targetName: input.userName,
    roleId: roleLabel,
    roleName: roleLabel,
    directPermissionCodes: [],
    inheritedPermissionCodes: inherited.codes,
    inheritedKnown: inherited.known,
    admissionChanges: [{ namespace, effect: 'enable' }],
    admissionKnown: true,
    platformAdminAuthority,
    admissionNamespaces: [namespace],
    expectedUpdatedAt: null,
    requiresTypedPhrase: null,
    notes: withPlatformAdminNote(platformAdminAuthority, [
      `只开通「${namespace}」的插件使用。`,
      '不分配角色，也不写入直接权限。',
      inheritedNote,
    ]),
    fingerprint,
    createPayload: null,
  }
}

export function buildCreateUserAuthorization(input: {
  targetName: string
  roleId: string
  roleName: string
  directPermissionCodes: readonly string[]
  inheritedPermissionCodes: readonly string[]
  inheritedKnown: boolean
  admissionNamespaces: readonly string[]
  createPayload: Record<string, unknown>
}): AdminAuthorizationDraft {
  const admissionNamespaces = readAdmissionNamespaceList(input.admissionNamespaces)
  const directPermissionCodes = uniqueStrings(input.directPermissionCodes.filter((code) => code.trim().length > 0))
  const inheritedPermissionCodes = uniqueStrings(input.inheritedPermissionCodes.filter((code) => code.trim().length > 0))
  const platformAdminAuthority = input.roleId === 'admin'
  const fingerprint = authorizationFingerprint({
    kind: 'create-user',
    targetName: input.targetName,
    roleId: input.roleId,
    directPermissionCodes: sortedCopy(directPermissionCodes),
    inheritedPermissionCodes: sortedCopy(inheritedPermissionCodes),
    inheritedKnown: input.inheritedKnown,
    admissionNamespaces,
    createPayload: input.createPayload,
    platformAdminAuthority,
  })
  const notes = withPlatformAdminNote(platformAdminAuthority, [
    admissionNamespaces.length > 0
      ? `创建后会开通已勾选的插件使用：${admissionNamespaces.join('、')}。`
      : '创建后不会开通插件使用。',
    input.inheritedKnown
      ? '预设自带的权限和角色继承的权限分开列出，两者不是同一份清单。'
      : '角色目录里没有这个角色，不能把预设自带的权限说成角色继承。',
  ])
  return {
    kind: 'create-user',
    targetUserId: '',
    targetName: input.targetName,
    roleId: input.roleId,
    roleName: input.roleName || '不分配角色',
    directPermissionCodes,
    inheritedPermissionCodes,
    inheritedKnown: input.inheritedKnown,
    admissionChanges: admissionNamespaces.map((namespace) => ({ namespace, effect: 'enable' as const })),
    admissionKnown: true,
    platformAdminAuthority,
    admissionNamespaces,
    expectedUpdatedAt: null,
    requiresTypedPhrase: null,
    notes,
    fingerprint,
    createPayload: input.createPayload,
  }
}

export function adminAuthorizationStillCurrent(
  draft: AdminAuthorizationDraft,
  liveFingerprint: string,
): boolean {
  return draft.fingerprint.length > 0 && draft.fingerprint === liveFingerprint
}

export function describeAdmissionChange(change: AdminAuthorizationAdmissionChange): string {
  if (change.effect === 'enable') return `将开通插件使用：${change.namespace}`
  if (change.effect === 'source-opt-out') {
    return `会记下默认角色已撤销，避免之后自动重新开通插件使用：${change.namespace}`
  }
  return `如果没有其他角色仍覆盖该范围，可能会关闭插件使用：${change.namespace}`
}
