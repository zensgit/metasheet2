export type PermissionCheckerPhase =
  | 'idle'
  | 'pending'
  | 'allowed'
  | 'denied'
  | 'degraded'
  | 'forbidden'
  | 'error'

export type PermissionCheckerView = {
  phase: PermissionCheckerPhase
  userId: string
  permission: string
  detail: string
}

export const PERMISSION_CHECKER_SCOPE_NOTE =
  '这次结果只针对当前选中的这一项权限码。业务操作还可能另外检查范围、准入或管理员规则。'

export function idlePermissionCheckerView(): PermissionCheckerView {
  return { phase: 'idle', userId: '', permission: '', detail: '' }
}

export function pendingPermissionCheckerView(userId: string, permission: string): PermissionCheckerView {
  return {
    phase: 'pending',
    userId,
    permission,
    detail: `正在检查用户 ${userId} 的权限码 ${permission}。`,
  }
}

export function permissionCheckerRequestBody(userId: string, permission: string): { userId: string; permission: string } {
  return { userId, permission }
}

export function permissionCheckerStillCurrent(
  startedGeneration: number,
  currentGeneration: number,
  requestedUserId: string,
  requestedPermission: string,
  selectedUserId: string,
  selectedPermission: string,
): boolean {
  return startedGeneration === currentGeneration
    && requestedUserId === selectedUserId
    && requestedPermission === selectedPermission
}

function responseRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  return payload as Record<string, unknown>
}

export function readPermissionCheckerResponse(input: {
  httpStatus: number
  payload: unknown
  requestedUserId: string
  requestedPermission: string
}): PermissionCheckerView {
  const base = {
    userId: input.requestedUserId,
    permission: input.requestedPermission,
  }
  const body = responseRecord(input.payload)
  if (input.httpStatus === 403) {
    return {
      ...base,
      phase: 'forbidden',
      detail: `没有权限检查用户 ${input.requestedUserId}，本次没有结论。`,
    }
  }
  if (body?.degraded === true || body?.unavailable === true) {
    return {
      ...base,
      phase: 'degraded',
      detail: `用户 ${input.requestedUserId} 的权限码 ${input.requestedPermission} 检查暂时不可用，本次没有结论。`,
    }
  }
  if (input.httpStatus < 200 || input.httpStatus >= 300) {
    const serverError = body && typeof body.error === 'string' ? body.error : ''
    return {
      ...base,
      phase: 'error',
      detail: serverError
        ? `检查用户 ${input.requestedUserId} 的权限码 ${input.requestedPermission} 失败：${serverError}。本次没有结论。`
        : `检查用户 ${input.requestedUserId} 的权限码 ${input.requestedPermission} 失败，本次没有结论。`,
    }
  }
  if (!body || body.userId !== input.requestedUserId || body.permission !== input.requestedPermission || typeof body.allowed !== 'boolean') {
    return {
      ...base,
      phase: 'error',
      detail: `用户 ${input.requestedUserId} 的权限码 ${input.requestedPermission} 回执无法核对，本次没有结论。`,
    }
  }
  if (body.allowed === true) {
    return {
      ...base,
      phase: 'allowed',
      detail: `用户 ${input.requestedUserId} 的权限码 ${input.requestedPermission}：允许。`,
    }
  }
  return {
    ...base,
    phase: 'denied',
    detail: `用户 ${input.requestedUserId} 的权限码 ${input.requestedPermission}：不允许。`,
  }
}
