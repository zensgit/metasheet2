export type PermissionActionTone = 'info' | 'error'

export type UserPermissionInspection = {
  userId: string
  isAdmin: boolean
  adminKnown: boolean
  permissions: string[]
  direct: string[]
  inherited: string[]
  legacy: string[]
  effective: string[]
  blockedByNamespaceAdmission: string[]
  hasSourceBreakdown: boolean
  sourceKnown: boolean
  effectiveKnown: boolean
  degraded: boolean
  subjectMatched: boolean
}

export type PermissionWriteInput = {
  action: 'grant' | 'revoke'
  requestedUserId: string
  selectedUserId: string
  permission: string
  ok: boolean
  errorMessage?: string
  httpStatus?: number
  writeAcknowledged?: boolean
  inspection?: UserPermissionInspection | null
}

export type PermissionWriteOutcome = {
  applyInspection: boolean
  tone: PermissionActionTone
  message: string
}

export type PermissionInspectionView = {
  unread: boolean
  adminLabel: string
  directLabel: string
  inheritedLabel: string
  effectiveLabel: string
  showDirectChips: boolean
  showInheritedChips: boolean
  showEffectiveChips: boolean
  showDirectEmpty: boolean
  showInheritedEmpty: boolean
  showEffectiveEmpty: boolean
  actionsEnabled: boolean
}

export type PermissionWriteAcknowledgement = {
  accepted: boolean
  degraded: boolean
  message: string
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const codes: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) return null
    codes.push(item)
  }
  return codes
}

function unreadInspection(userId: string, subjectMatched = false): UserPermissionInspection {
  return {
    userId,
    isAdmin: false,
    adminKnown: false,
    permissions: [],
    direct: [],
    inherited: [],
    legacy: [],
    effective: [],
    blockedByNamespaceAdmission: [],
    hasSourceBreakdown: false,
    sourceKnown: false,
    effectiveKnown: false,
    degraded: true,
    subjectMatched,
  }
}

export function unreadUserPermissionInspection(userId: string): UserPermissionInspection {
  return unreadInspection(userId, false)
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

export function permissionUserPayloadUnavailable(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  return record.degraded === true || record.unavailable === true
}

export function readUserPermissionInspection(
  payload: Record<string, unknown>,
  expectedUserId: string,
): UserPermissionInspection {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return unreadInspection(expectedUserId)
  const payloadUserId = typeof payload.userId === 'string' ? payload.userId : ''
  if (!payloadUserId || payloadUserId !== expectedUserId) return unreadInspection(expectedUserId)
  if (permissionUserPayloadUnavailable(payload)) {
    return { ...unreadInspection(expectedUserId, true), userId: payloadUserId }
  }

  const direct = stringArray(payload.direct)
  const inherited = stringArray(payload.inherited)
  const legacy = stringArray(payload.legacy)
  const effectiveArray = stringArray(payload.effective)
  const permissions = stringArray(payload.permissions)
  const blocked = stringArray(payload.blockedByNamespaceAdmission)
  const sourceKnown = direct !== null && inherited !== null && legacy !== null && effectiveArray !== null && blocked !== null
  const effectiveKnown = effectiveArray !== null || permissions !== null
  if (!sourceKnown && !effectiveKnown) return unreadInspection(expectedUserId, true)

  const effective = effectiveArray ?? permissions ?? []
  const adminKnown = typeof payload.isAdmin === 'boolean'
  return {
    userId: payloadUserId,
    isAdmin: adminKnown ? payload.isAdmin === true : false,
    adminKnown,
    permissions: permissions ?? effective,
    direct: sourceKnown ? (direct ?? []) : [],
    inherited: sourceKnown ? (inherited ?? []) : [],
    legacy: sourceKnown ? (legacy ?? []) : [],
    effective,
    blockedByNamespaceAdmission: sourceKnown ? (blocked ?? []) : [],
    hasSourceBreakdown: sourceKnown,
    sourceKnown,
    effectiveKnown,
    degraded: false,
    subjectMatched: true,
  }
}

export function readPermissionWriteAcknowledgement(
  payload: unknown,
  requestedUserId: string,
  permission: string,
): PermissionWriteAcknowledgement {
  const target = `用户 ${requestedUserId}`
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { accepted: false, degraded: false, message: `${target} 的写入回执无法解析，未把本次结果当作成功` }
  }
  const record = payload as Record<string, unknown>
  if (record.degraded === true || record.unavailable === true) {
    return { accepted: false, degraded: true, message: `${target} 的写入回执处于降级，不能当作已保存` }
  }
  if (record.success !== true) {
    return { accepted: false, degraded: false, message: `${target} 的写入回执缺少成功标记，未把本次结果当作成功` }
  }
  if (record.userId !== requestedUserId) {
    return { accepted: false, degraded: false, message: `${target} 的写入回执用户不一致，未把本次结果当作成功` }
  }
  const code = typeof record.permission === 'string' ? record.permission : record.code
  if (code !== permission) {
    return { accepted: false, degraded: false, message: `${target} 的写入回执权限码不一致，未把本次结果当作成功` }
  }
  return { accepted: true, degraded: false, message: '' }
}

export function describePermissionInspectionView(
  inspection: UserPermissionInspection | null,
  selectedUserId: string,
): PermissionInspectionView {
  const matched = Boolean(
    inspection
    && selectedUserId
    && inspection.subjectMatched
    && inspection.userId === selectedUserId
    && !inspection.degraded,
  )
  if (!matched || !inspection) {
    return {
      unread: true,
      adminLabel: '身份未读',
      directLabel: '未读',
      inheritedLabel: '未读',
      effectiveLabel: '未读',
      showDirectChips: false,
      showInheritedChips: false,
      showEffectiveChips: false,
      showDirectEmpty: false,
      showInheritedEmpty: false,
      showEffectiveEmpty: false,
      actionsEnabled: false,
    }
  }
  const sourceKnown = inspection.sourceKnown
  const effectiveKnown = inspection.effectiveKnown
  return {
    unread: false,
    adminLabel: inspection.adminKnown ? (inspection.isAdmin ? '管理员' : '普通用户') : '身份未读',
    directLabel: sourceKnown ? `${inspection.direct.length} 项` : '未知',
    inheritedLabel: sourceKnown ? `${inspection.inherited.length} 项` : '未知',
    effectiveLabel: effectiveKnown ? `${inspection.effective.length} 项` : '未知',
    showDirectChips: sourceKnown,
    showInheritedChips: sourceKnown,
    showEffectiveChips: effectiveKnown,
    showDirectEmpty: sourceKnown && inspection.direct.length === 0,
    showInheritedEmpty: sourceKnown && inspection.inherited.length === 0,
    showEffectiveEmpty: effectiveKnown && inspection.effective.length === 0,
    actionsEnabled: sourceKnown || effectiveKnown,
  }
}

export function describeSelectedPermissionHint(
  permission: string,
  inspection: UserPermissionInspection | null,
): string {
  const code = permission.trim()
  if (!code || !inspection) return ''
  if (inspection.degraded || !inspection.subjectMatched) {
    return '权限来源暂时不可用，不能把空列表当作已回收或未授予'
  }
  if (!inspection.hasSourceBreakdown) {
    const listed = inspection.effectiveKnown
      && (inspection.effective.includes(code) || inspection.permissions.includes(code))
    if (listed) return `权限 ${code} 出现在生效权限中；直接授予来源未回读。`
    return `权限 ${code} 的来源未回读，不能把空列表当作未授予或已回收。`
  }
  const direct = inspection.direct.includes(code)
  const inherited = inspection.inherited.includes(code)
  const blocked = inspection.blockedByNamespaceAdmission.includes(code)
  const effective = inspection.effective.includes(code) || inspection.permissions.includes(code)
  if (direct && blocked) {
    return `权限 ${code} 已直接授予，但因命名空间准入未满足而未生效。回收只删除直接授予，不会自动开通准入。`
  }
  if (direct) {
    return `权限 ${code} 是直接授予，回收将删除该直接授予。`
  }
  if (inherited) {
    return `权限 ${code} 来自角色继承，权限页回收不会移除角色成员关系。`
  }
  if (effective) {
    return `权限 ${code} 出现在生效权限中，但不是直接授予。`
  }
  return `权限 ${code} 当前不是该用户的直接授予。`
}

function unverifiedReadback(target: string): PermissionWriteOutcome {
  return {
    applyInspection: false,
    tone: 'error',
    message: `${target} 的权限回读无法核对，未把本次结果当作成功`,
  }
}

export function describePermissionWrite(input: PermissionWriteInput): PermissionWriteOutcome {
  const switched = input.requestedUserId !== input.selectedUserId
  const target = `用户 ${input.requestedUserId}`
  const code = input.permission

  if (!input.ok) {
    const inheritedOnly = Boolean(
      input.httpStatus === 404
      || (input.errorMessage && input.errorMessage.includes('Permission not found for user')),
    )
    const failure = inheritedOnly
      ? `该权限不是${target} 的直接授予，权限页回收只删除直接授予；角色继承请到用户管理撤销角色`
      : (input.errorMessage || '权限操作失败')
    return {
      applyInspection: false,
      tone: 'error',
      message: switched
        ? `针对${target} 的权限操作失败：${failure}。未覆盖当前选中用户 ${input.selectedUserId} 的状态`
        : failure,
    }
  }

  if (input.writeAcknowledged === false) {
    return {
      applyInspection: false,
      tone: 'error',
      message: input.errorMessage || `${target} 的写入回执不能证明已保存`,
    }
  }

  const inspection = input.inspection
  if (!inspection) {
    return {
      applyInspection: false,
      tone: 'error',
      message: `${target} 的权限回读失败，未把本次结果当作成功`,
    }
  }
  if (!inspection.subjectMatched || inspection.userId !== input.requestedUserId) {
    return unverifiedReadback(target)
  }
  if (inspection.degraded) {
    return {
      applyInspection: false,
      tone: 'error',
      message: `${target} 的权限来源暂时不可用，不能把空列表当作已回收或未授予`,
    }
  }

  if (switched) {
    return {
      applyInspection: false,
      tone: 'info',
      message: `针对${target} 的权限操作已完成，未覆盖当前选中用户 ${input.selectedUserId} 的状态`,
    }
  }

  const inDirect = inspection.sourceKnown && inspection.direct.includes(code)
  const inEffective = inspection.effectiveKnown
    && (inspection.effective.includes(code) || inspection.permissions.includes(code))
  const blocked = inspection.sourceKnown && inspection.blockedByNamespaceAdmission.includes(code)

  if (input.action === 'grant') {
    if (!inspection.hasSourceBreakdown) {
      if (inspection.effectiveKnown && inEffective) {
        return {
          applyInspection: true,
          tone: 'info',
          message: `生效权限包含 ${code}；权限来源未回读，不能把缺失来源当作已核对的直接授予`,
        }
      }
      return {
        applyInspection: true,
        tone: 'error',
        message: `${target} 的生效权限回读未包含 ${code}，不能当作已核对成功`,
      }
    }
    if (!inDirect) {
      return {
        applyInspection: true,
        tone: 'error',
        message: `授予已返回成功，但${target} 的直接授予中没有 ${code}`,
      }
    }
    if (blocked || !inEffective) {
      return {
        applyInspection: true,
        tone: 'info',
        message: `已写入${target} 的直接授予 ${code}，但未生效：命名空间准入未满足。未自动开通准入。`,
      }
    }
    return {
      applyInspection: true,
      tone: 'info',
      message: `已写入${target} 的直接授予 ${code}，且已出现在生效权限中`,
    }
  }

  if (!inspection.hasSourceBreakdown) {
    if (inspection.effectiveKnown && inEffective) {
      return {
        applyInspection: true,
        tone: 'info',
        message: `生效权限仍包含 ${code}；权限来源未回读，不能把缺失来源当作已核对的回收`,
      }
    }
    return {
      applyInspection: true,
      tone: 'error',
      message: `${target} 的直接授予来源未回读，不能把本次回收当作已核对成功`,
    }
  }
  if (inDirect) {
    return {
      applyInspection: true,
      tone: 'error',
      message: `回收未移除直接授予：${target} 仍直接持有 ${code}`,
    }
  }
  if (inEffective) {
    return {
      applyInspection: true,
      tone: 'info',
      message: `已回收${target} 的直接授予 ${code}；生效权限仍包含它（角色继承或历史字段）`,
    }
  }
  return {
    applyInspection: true,
    tone: 'info',
    message: `已回收${target} 的直接授予 ${code}，生效权限不再包含它`,
  }
}

export function readPermissionTemplateApplyAcknowledgement(
  payload: unknown,
  requestedUserId: string,
  templateId: string,
): PermissionWriteAcknowledgement {
  const target = `用户 ${requestedUserId}`
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { accepted: false, degraded: false, message: `${target} 的模板写入回执无法解析，未把本次提交当作完成` }
  }
  const record = payload as Record<string, unknown>
  if (record.degraded === true || record.unavailable === true) {
    return { accepted: false, degraded: true, message: `${target} 的模板写入回执处于降级，未把本次提交当作完成` }
  }
  if (record.success === false || record.ok === false || (record.success !== true && record.ok !== true)) {
    return { accepted: false, degraded: false, message: `${target} 的模板写入回执缺少成功标记，未把本次提交当作完成` }
  }
  const template = record.template && typeof record.template === 'object' && !Array.isArray(record.template)
    ? record.template as Record<string, unknown>
    : null
  const permissions = stringArray(record.permissions)
  if (record.userId !== requestedUserId || !template || template.id !== templateId || !permissions || typeof record.isAdmin !== 'boolean') {
    return { accepted: false, degraded: false, message: `${target} 的模板写入回执缺少用户、模板或权限数组，未把本次提交当作完成` }
  }
  return { accepted: true, degraded: false, message: '' }
}

export function describePermissionTemplateApply(input: {
  templateName: string
  inspection: UserPermissionInspection
}): { tone: PermissionActionTone; message: string } {
  if (input.inspection.degraded || !input.inspection.subjectMatched) {
    return {
      tone: 'error',
      message: `模板已提交，但权限回读不可用，不能把当前列表当作已按模板 ${input.templateName} 补齐`,
    }
  }
  if (!input.inspection.sourceKnown) {
    return {
      tone: 'error',
      message: `模板已提交，但权限来源回读不完整，不能把当前列表当作已按模板 ${input.templateName} 补齐`,
    }
  }
  return {
    tone: 'info',
    message: `已按模板 ${input.templateName} 补齐权限`,
  }
}
