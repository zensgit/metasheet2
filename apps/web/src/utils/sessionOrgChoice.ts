/**
 * Session-org choice vs injected tenant hint (D6 R1 / F1).
 *
 * The injected hint (`tenantId` / `workspaceId`) is written by persistTenantHint
 * and sent as `x-tenant-id` on ordinary requests. A stored `'default'` there is
 * not a user choice — every backfilled user has a legal `'default'` membership.
 *
 * An explicit switcher write goes to `sessionOrgChoice` and is bound to a user
 * id so a later login as someone else cannot inherit it.
 */

export const DEFAULT_SESSION_ORG_ID = 'default'
export const SESSION_ORG_CHOICE_KEY = 'sessionOrgChoice'
export const INJECTED_TENANT_HINT_KEYS = ['tenantId', 'workspaceId'] as const

export type SessionOrgChoice = {
  userId: string
  orgId: string
}

function trimNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function isDefaultSessionOrgId(value: unknown): boolean {
  return trimNonEmpty(value) === DEFAULT_SESSION_ORG_ID
}

export function readStoredInjectedTenantHint(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    for (const key of INJECTED_TENANT_HINT_KEYS) {
      const value = trimNonEmpty(localStorage.getItem(key))
      if (value) return value
    }
  } catch {
    return null
  }
  return null
}

/**
 * Seed the attendance history-filter / punch `orgId` box from injected hint keys
 * only (`tenantId` / `workspaceId`), including a stored `'default'`.
 *
 * Existing admin pickers and harnesses still treat that box as the request
 * org scope. F2 is preserved because this never reads `sessionOrgChoice` or
 * the reminted JWT — a switcher remint must not fill this box. F1 stays on
 * login: `tenantHintForLoginRequest` still strips `'default'`.
 */
export function readHistoryFilterOrgSeed(): string {
  return readStoredInjectedTenantHint() ?? ''
}

export function readSessionOrgChoice(): SessionOrgChoice | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(SESSION_ORG_CHOICE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const userId = trimNonEmpty(record.userId)
    const orgId = trimNonEmpty(record.orgId)
    if (!userId || !orgId) return null
    return { userId, orgId }
  } catch {
    return null
  }
}

export function persistSessionOrgChoice(userId: string, orgId: string): void {
  const trimmedUserId = trimNonEmpty(userId)
  const trimmedOrgId = trimNonEmpty(orgId)
  if (!trimmedUserId || !trimmedOrgId || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SESSION_ORG_CHOICE_KEY, JSON.stringify({
      userId: trimmedUserId,
      orgId: trimmedOrgId,
    }))
  } catch (err) {
    console.warn('[auth] failed to persist session org choice', err)
  }
}

export function clearSessionOrgChoice(): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(SESSION_ORG_CHOICE_KEY)
  } catch (err) {
    console.warn('[auth] failed to clear session org choice', err)
  }
}

export function sessionOrgChoiceForUser(userId: string | null | undefined): string | null {
  const trimmedUserId = trimNonEmpty(userId)
  if (!trimmedUserId) return null
  const choice = readSessionOrgChoice()
  if (!choice || choice.userId !== trimmedUserId) return null
  return choice.orgId
}

export function isExplicitSessionOrgChoice(orgId: string | null | undefined): boolean {
  const trimmed = trimNonEmpty(orgId)
  if (!trimmed) return false
  const choice = readSessionOrgChoice()
  return choice?.orgId === trimmed
}

/** Login must not send a persisted `'default'` hint as if the user chose it. */
export function tenantHintForLoginRequest(hint: string | null | undefined): string | null {
  const trimmed = trimNonEmpty(hint)
  if (!trimmed || isDefaultSessionOrgId(trimmed)) return null
  return trimmed
}
