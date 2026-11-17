import type {
  AdminAuthorizationAction,
  AdminAuthorizationEffectivePermission,
  AdminAuthorizationImpactAdmissionChange,
  AdminAuthorizationScopeCleanup,
  AdminAuthorizationSourceChange,
} from '../utils/adminAuthorizationOperation'

/**
 * Frozen confirmation for member and role authorization changes.
 * The dialog shows this snapshot. A later edit of the user, role, or
 * admission selection must not be submitted under the old confirmation.
 */

export const PLATFORM_ADMIN_REMOVAL_PHRASE = '取消平台管理员'

export const LAST_PLATFORM_ADMIN_MESSAGE = '不能取消最后一名平台管理员'

export const ROLE_VERSION_MISMATCH_MESSAGE = '角色目录已变化，本次未写入。请刷新角色后再确认。'

export const PLATFORM_ADMIN_AUTHORITY_NOTE = '平台管理员拥有平台管理权限。权限码列表即使为空，也不表示没有管理权限。'

export type AdminAuthorizationKind = 'create-user' | 'assign-role' | 'unassign-role' | 'enable-admission' | 'disable-admission'

export type AdminAuthorizationAdmissionEffect = 'enable' | 'disable' | 'may-close' | 'source-opt-out'

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
  /**
   * Namespaces the admin explicitly checked for this assign.
   * Omitted keeps the previous membership confirmation unchanged.
   * An empty list assigns the role and opens no plugin admission.
   */
  openedAdmissionNamespaces?: readonly string[]
}): AdminAuthorizationDraft {
  const permissionKnown = input.permissionKnown !== false
  const permissionCodes = permissionKnown
    ? uniqueStrings(input.permissionCodes.filter((code) => code.trim().length > 0))
    : []
  const platformAdminAuthority = input.roleId === 'admin'
  const openedAdmissionNamespaces = input.openedAdmissionNamespaces === undefined
    ? undefined
    : uniqueStrings(input.openedAdmissionNamespaces.map((namespace) => namespace.trim()).filter((namespace) => namespace.length > 0))
  const openedChanges: AdminAuthorizationAdmissionChange[] = (openedAdmissionNamespaces ?? [])
    .map((namespace) => ({ namespace, effect: 'enable' as const }))
  const revokeAdmission = input.action === 'unassign'
    ? (input.heldRolesKnown
      ? admissionChangesForRevoke(input.roleId, input.heldRoleIds, input.namespacesByRoleId)
      : { known: false, changes: [] as AdminAuthorizationAdmissionChange[] })
    : { known: true, changes: openedChanges }
  const admissionChanges = revokeAdmission.changes
  const admissionKnown = revokeAdmission.known
  const mayClose = admissionChanges.some((change) => change.effect === 'may-close')
  const expectedUpdatedAt = input.action === 'assign' && input.expectedUpdatedAt
    ? input.expectedUpdatedAt
    : null
  const unknownPermissionNote = '角色目录没有这份角色，不能把缺失列表当作没有继承权限。'
  const assignLead = openedChanges.length > 0
    ? `只把该用户加入这个角色的成员，不写入直接权限。同时开通已勾选的插件使用：${openedChanges.map((change) => change.namespace).join('、')}。`
    : '只把该用户加入这个角色的成员，不写入直接权限，也不开通插件使用。'
  const notes = input.action === 'assign'
    ? [
      assignLead,
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
    ...(openedAdmissionNamespaces !== undefined ? { openedAdmissionNamespaces: sortedCopy(openedAdmissionNamespaces) } : {}),
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
    admissionNamespaces: input.action === 'assign' ? (openedAdmissionNamespaces ?? []) : [],
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
  if (change.effect === 'disable') return `将关闭插件使用：${change.namespace}`
  if (change.effect === 'source-opt-out') {
    return `会记下默认角色已撤销，避免之后自动重新开通插件使用：${change.namespace}`
  }
  return `如果没有其他角色仍覆盖该范围，可能会关闭插件使用：${change.namespace}`
}

export const AUTHORIZATION_NOT_CHECKED_MESSAGE = '这次授权已经提交，但最新的角色和准入还没有核对成功，不能当作已经生效。'

export const AUTHORIZATION_PENDING_MESSAGE = '还不能确认这次授权是否已经提交。请只重新读取，不要再次提交。'

export const AUTHORIZATION_PREVIEW_FAILED_MESSAGE = '服务器预览没有成功，本次没有提交。'

export const AUTHORIZATION_FORBIDDEN_MESSAGE = '没有执行这次授权的权限。本次没有提交。'

export const AUTHORIZATION_PRINCIPAL_MISSING_MESSAGE = '当前登录身份还没读到，授权操作已暂停。'

export const AUTHORIZATION_MEMBER_CHANGED_MESSAGE = '确认对象已变化，这次结果不会写入当前成员。'

export const AUTHORIZATION_PRINCIPAL_CHANGED_MESSAGE = '登录身份已变化，这次结果不会写入当前成员。'

export const INDEPENDENT_BATCH_FLOW_MESSAGE = '这是独立的批量流程，不会生成成员页单次授权的回执。'

export type ServerAdmissionFact = {
  namespace: string
  enabled: boolean
  derived: boolean
}

/** Accepts the composable's readonly impact without copying it. */
export type ReadableAuthorizationImpact = {
  readonly sourceChanges: readonly AdminAuthorizationSourceChange[]
  readonly admissionChanges: readonly AdminAuthorizationImpactAdmissionChange[]
  readonly scopeCleanup: readonly AdminAuthorizationScopeCleanup[]
  readonly effectiveBefore: readonly AdminAuthorizationEffectivePermission[]
  readonly effectiveAfter: readonly AdminAuthorizationEffectivePermission[]
  readonly retainedOtherGrants: readonly AdminAuthorizationEffectivePermission[]
  readonly warnings: readonly string[]
}

export type ReadableAuthorizationReceipt = {
  readonly targetUserId: string
  readonly action: AdminAuthorizationAction
  readonly impact: ReadableAuthorizationImpact
  readonly resultVersion: string
}

export type ServerAuthorizationImpactSummary = {
  roleSources: string[]
  explicitAdmissions: string[]
  derivedAdmissions: string[]
  scopeCleanupCount: number
  retainedSources: string[]
}

/**
 * Readable admission rows from an opaque impact list.
 * A row is derived only when the server says so. Anything else with a namespace
 * and a boolean is explicit. A malformed row fails the whole list.
 */
export function readServerAdmissionFacts(value: unknown): ServerAdmissionFact[] | null {
  if (!Array.isArray(value)) return null
  const facts: ServerAdmissionFact[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.namespace !== 'string') return null
    const namespace = item.namespace.trim()
    if (!namespace) return null
    // The client stores `{ before, after, cause }`. Older rows use `enabled`.
    const enabled = typeof item.enabled === 'boolean'
      ? item.enabled
      : (typeof item.after === 'boolean' ? item.after : null)
    if (enabled === null) return null
    facts.push({
      namespace,
      enabled,
      derived: item.derived === true
        || item.source === 'derived'
        || item.kind === 'derived'
        || item.cause === 'role_revoke',
    })
  }
  return facts
}

function pushUnique(target: string[], value: string): void {
  const label = value.trim()
  if (!label || target.includes(label)) return
  target.push(label)
}

function retainedLabel(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (!isRecord(value)) return null
  if (value.kind === 'role' && typeof value.id === 'string' && value.id.trim()) return value.id.trim()
  if (typeof value.roleId === 'string' && value.roleId.trim()) return value.roleId.trim()
  if (typeof value.code === 'string' && value.code.trim()) return value.code.trim()
  if (typeof value.namespace === 'string' && value.namespace.trim()) return value.namespace.trim()
  if (typeof value.id === 'string' && value.id.trim()) return value.id.trim()
  return null
}

function admissionLabel(fact: ServerAdmissionFact): string {
  return `${fact.enabled ? '开通' : '关闭'} ${fact.namespace}`
}

export function describeServerAuthorizationImpact(
  impact: ReadableAuthorizationImpact | null | undefined,
): ServerAuthorizationImpactSummary | null {
  if (!impact) return null
  const roleSources: string[] = []
  for (const permission of [...impact.effectiveBefore, ...impact.effectiveAfter]) {
    for (const source of permission.sources) {
      if (source.kind === 'role') pushUnique(roleSources, source.id)
    }
  }
  for (const change of impact.sourceChanges) {
    const record = change as unknown as Record<string, unknown>
    if (typeof record.roleId === 'string') pushUnique(roleSources, record.roleId)
    const id = typeof record.id === 'string' ? record.id : ''
    if (id && (record.kind === 'role' || record.source === 'role')) pushUnique(roleSources, id)
  }
  const explicitAdmissions: string[] = []
  const derivedAdmissions: string[] = []
  const facts = readServerAdmissionFacts(impact.admissionChanges) ?? []
  for (const fact of facts) {
    pushUnique(fact.derived ? derivedAdmissions : explicitAdmissions, admissionLabel(fact))
  }
  const retainedSources: string[] = []
  for (const item of impact.retainedOtherGrants) {
    const label = retainedLabel(item)
    if (label) pushUnique(retainedSources, label)
  }
  return {
    roleSources,
    explicitAdmissions,
    derivedAdmissions,
    scopeCleanupCount: impact.scopeCleanup.length,
    retainedSources,
  }
}

function cleanupNamespace(item: unknown): string | null {
  if (typeof item === 'string') return item.trim() || null
  if (!isRecord(item) || typeof item.namespace !== 'string') return null
  return item.namespace.trim() || null
}

/** Fail closed. A cleanup item without a namespace is not treated as already clean. */
export function authorizationLiveReadAgrees(input: {
  action: AdminAuthorizationAction
  roles: readonly string[]
  admissions: ReadonlyArray<{ namespace: string; enabled: boolean }>
  impact: ReadableAuthorizationImpact
}): boolean {
  if (input.action.kind === 'role.assign' && !input.roles.includes(input.action.roleId)) return false
  if (input.action.kind === 'role.revoke' && input.roles.includes(input.action.roleId)) return false
  const facts = readServerAdmissionFacts(input.impact.admissionChanges)
  if (!facts) return false
  for (const fact of facts) {
    const row = input.admissions.find((item) => item.namespace === fact.namespace)
    if (!row) {
      if (fact.enabled) return false
      continue
    }
    if (row.enabled !== fact.enabled) return false
  }
  for (const item of input.impact.scopeCleanup) {
    const namespace = cleanupNamespace(item)
    if (!namespace) return false
    const row = input.admissions.find((entry) => entry.namespace === namespace)
    if (row?.enabled) return false
  }
  return true
}

function explicitAdmissionChanges(
  impact: ReadableAuthorizationImpact,
  requested: ReadonlyArray<{ namespace: string; enabled: boolean }> | null | undefined,
): Array<{ namespace: string; enabled: boolean }> | null {
  if (requested) {
    return requested.map((change) => ({ namespace: change.namespace, enabled: change.enabled }))
  }
  const facts = readServerAdmissionFacts(impact.admissionChanges)
  if (!facts) return null
  return facts.filter((fact) => !fact.derived).map((fact) => ({ namespace: fact.namespace, enabled: fact.enabled }))
}

export function describeVerifiedAuthorization(input: {
  action: AdminAuthorizationAction
  impact: ReadableAuthorizationImpact
  requestedAdmissionChanges?: ReadonlyArray<{ namespace: string; enabled: boolean }> | null
}): string {
  if (input.action.kind === 'role.assign') {
    const changes = explicitAdmissionChanges(input.impact, input.requestedAdmissionChanges)
    if (!changes) return '角色已分配。所勾选的插件准入还不能从回执里核对。这不是全部权限已经生效。'
    if (changes.some((change) => change.enabled === true)) {
      return '角色已分配，所勾选的插件准入已按回执核对。这不是全部权限已经生效。'
    }
    return '角色已分配，准入未开'
  }
  if (input.action.kind === 'role.revoke') {
    const retained = input.impact.retainedOtherGrants.map(retainedLabel).filter((label): label is string => Boolean(label))
    const uniqueRetained = uniqueStrings(retained)
    if (input.impact.retainedOtherGrants.length > 0) {
      return uniqueRetained.length > 0
        ? `角色已从该成员移除。其他来源仍保留：${uniqueRetained.join('、')}。`
        : '角色已从该成员移除。其他来源仍保留。'
    }
    return '角色已从该成员移除。'
  }
  const changes = explicitAdmissionChanges(input.impact, input.requestedAdmissionChanges) ?? []
  const enabled = changes.filter((change) => change.enabled)
  const disabled = changes.filter((change) => !change.enabled)
  if (enabled.length === 1 && disabled.length === 0) return `已开通 ${enabled[0]?.namespace} 插件使用`
  if (disabled.length === 1 && enabled.length === 0) return `已关闭 ${disabled[0]?.namespace} 插件使用`
  if (enabled.length > 0) return `已开通 ${enabled.map((change) => change.namespace).join('、')} 插件使用`
  if (disabled.length > 0) return `已关闭 ${disabled.map((change) => change.namespace).join('、')} 插件使用`
  return AUTHORIZATION_NOT_CHECKED_MESSAGE
}

export function buildAdmissionDisableAuthorization(input: {
  userId: string
  userName: string
  namespace: string
  roleIds: readonly string[]
  catalogPermissionsByRoleId: Readonly<Record<string, unknown>>
  dropdownRoleId: string
}): AdminAuthorizationDraft {
  const namespace = input.namespace.trim()
  const inherited = catalogPermissionCodesForRoles(input.roleIds, input.catalogPermissionsByRoleId)
  const roleLabel = input.roleIds.length > 0 ? input.roleIds.join('、') : '未分配角色'
  const platformAdminAuthority = input.roleIds.includes('admin')
  const fingerprint = authorizationFingerprint({
    kind: 'disable-admission',
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
    kind: 'disable-admission',
    targetUserId: input.userId,
    targetName: input.userName,
    roleId: roleLabel,
    roleName: roleLabel,
    directPermissionCodes: [],
    inheritedPermissionCodes: inherited.codes,
    inheritedKnown: inherited.known,
    admissionChanges: [{ namespace, effect: 'disable' }],
    admissionKnown: true,
    platformAdminAuthority,
    admissionNamespaces: [namespace],
    expectedUpdatedAt: null,
    requiresTypedPhrase: null,
    notes: withPlatformAdminNote(platformAdminAuthority, [
      `只关闭「${namespace}」的插件使用。`,
      '不分配角色，也不写入直接权限。',
      '关闭前会先向服务器预览，确认后才提交。',
      inheritedNote,
    ]),
    fingerprint,
    createPayload: null,
  }
}

function recoveredPlaceholder(targetUserId: string, userName: string): AdminAuthorizationDraft {
  return {
    kind: 'assign-role',
    targetUserId,
    targetName: userName || targetUserId,
    roleId: '',
    roleName: '未保留',
    directPermissionCodes: [],
    inheritedPermissionCodes: [],
    inheritedKnown: false,
    admissionChanges: [],
    admissionKnown: false,
    platformAdminAuthority: false,
    admissionNamespaces: [],
    expectedUpdatedAt: null,
    requiresTypedPhrase: null,
    notes: ['原来的请求没有保留。只能读取服务器回执。'],
    fingerprint: authorizationFingerprint({ kind: 'recovered-unknown', targetUserId }),
    createPayload: null,
  }
}

export function buildRecoveredAuthorizationDraft(input: {
  receipt: ReadableAuthorizationReceipt | null
  userName: string
  dropdownRoleId: string
  heldRoleIds: readonly string[]
  heldRolesKnown: boolean
  namespacesByRoleId: Readonly<Record<string, unknown>>
  catalogPermissionsByRoleId: Readonly<Record<string, unknown>>
}): AdminAuthorizationDraft {
  const receipt = input.receipt
  if (!receipt) return recoveredPlaceholder('', input.userName)
  if (receipt.action.kind === 'role.assign' || receipt.action.kind === 'role.revoke') {
    return buildRoleMembershipAuthorization({
      action: receipt.action.kind === 'role.assign' ? 'assign' : 'unassign',
      userId: receipt.targetUserId,
      userName: input.userName || receipt.targetUserId,
      roleId: receipt.action.roleId,
      roleName: receipt.action.roleId,
      permissionCodes: [],
      permissionKnown: false,
      expectedUpdatedAt: null,
      heldRoleIds: input.heldRoleIds,
      heldRolesKnown: input.heldRolesKnown,
      namespacesByRoleId: input.namespacesByRoleId,
      dropdownRoleId: input.dropdownRoleId,
    })
  }
  const facts = readServerAdmissionFacts(receipt.impact.admissionChanges)
  const enabled = facts?.find((fact) => !fact.derived && fact.enabled)
  const disabled = facts?.find((fact) => !fact.derived && !fact.enabled)
  const namespace = enabled?.namespace || disabled?.namespace || ''
  if (!namespace) return recoveredPlaceholder(receipt.targetUserId, input.userName)
  const shared = {
    userId: receipt.targetUserId,
    userName: input.userName || receipt.targetUserId,
    namespace,
    roleIds: input.heldRoleIds,
    catalogPermissionsByRoleId: input.catalogPermissionsByRoleId,
    dropdownRoleId: input.dropdownRoleId,
  }
  return enabled
    ? buildAdmissionEnableAuthorization(shared)
    : buildAdmissionDisableAuthorization(shared)
}
