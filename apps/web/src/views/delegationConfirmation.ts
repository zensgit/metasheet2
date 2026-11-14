export type DelegationConfirmationKind = 'grant' | 'admission-enable' | 'revoke'

/** Catalog permission codes, as the catalog actually returned them. */
export type DelegationPermissionListing = 'listed' | 'empty' | 'unknown'

export const PLATFORM_ADMIN_ROLE_ID = 'admin'
export const PLATFORM_ADMIN_REVOKE_PHRASE = '取消平台管理员'

export type DelegationConfirmation = {
  token: number
  kind: DelegationConfirmationKind
  targetUserId: string
  targetLabel: string
  roleId: string | null
  roleTitle: string | null
  permissions: string[]
  permissionListing: DelegationPermissionListing
  namespace: string | null
  expectedUpdatedAt: string | null
}

type DelegationConfirmationInput = Omit<DelegationConfirmation, 'token' | 'permissions'> & {
  permissions: readonly string[]
}

let nextDelegationConfirmationToken = 0

export function openDelegationConfirmation(input: DelegationConfirmationInput): DelegationConfirmation {
  nextDelegationConfirmationToken += 1
  return {
    token: nextDelegationConfirmationToken,
    kind: input.kind,
    targetUserId: input.targetUserId,
    targetLabel: input.targetLabel,
    roleId: input.roleId,
    roleTitle: input.roleTitle,
    permissions: input.permissions.filter((code) => typeof code === 'string' && code.trim().length > 0),
    permissionListing: input.permissionListing,
    namespace: input.namespace,
    expectedUpdatedAt: input.expectedUpdatedAt,
  }
}

export function delegationConfirmationStillValid(
  confirmation: DelegationConfirmation | null,
  current: { targetUserId: string; roleId: string | null; namespace: string | null },
): boolean {
  if (!confirmation || confirmation.targetUserId !== current.targetUserId) return false
  if (confirmation.kind === 'admission-enable') {
    return confirmation.namespace !== null && confirmation.namespace === current.namespace
  }
  return confirmation.roleId !== null && confirmation.roleId === current.roleId
}

/** Catalog `updatedAt` only. The request field is `expectedUpdatedAt`. */
export function readCatalogExpectedUpdatedAt(role: { updatedAt?: unknown } | null | undefined): string | null {
  const value = role?.updatedAt
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}
