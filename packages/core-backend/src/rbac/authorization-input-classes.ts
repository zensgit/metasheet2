/**
 * Class-raising predicates of the authorization-input contract.
 *
 * A permission code is class-raising when granting it can move a user from the standard privilege
 * class to the high class; a role id is class-raising when holding the role does so by itself. Both
 * predicates mirror the shapes the privilege classifier applies to the same inputs, and the
 * differential test `tests/unit/class-raising-predicate.test.ts` pins them equal to the classifier's
 * verdict over the same code and role-id matrix. The classifier does not import this module: the
 * predicates are copied here so that the classifier's own import set stays fixed, and the test keeps
 * the two copies from drifting apart.
 *
 * Imports are exactly the two modules the classifier reads its predicates from.
 */
import { deriveDelegatedAdminNamespace } from './namespace-admission'
import { isAdminLevelPermissionCode } from './role-assignment'

function foldCode(code: string): string {
  return code.trim().toLowerCase()
}

/** The role editor's elevation shapes on top of `isAdminLevelPermissionCode`. */
function isEditorElevatedShape(code: string): boolean {
  const normalized = foldCode(code)
  if (!normalized) return false
  if (normalized === '*' || normalized === '*:*') return true
  if (normalized.endsWith(':*')) return true
  const resource = normalized.split(':')[0]
  return resource === '*' || resource === 'admin'
}

const SENSITIVE_AUTHORITY_RESOURCES: ReadonlySet<string> = new Set(['users', 'roles', 'permissions'])

function isSensitiveAuthorityCode(code: string): boolean {
  const separator = code.indexOf(':')
  if (separator < 0) return false
  const resource = foldCode(code.slice(0, separator))
  const action = foldCode(code.slice(separator + 1))
  return SENSITIVE_AUTHORITY_RESOURCES.has(resource) && action === 'write'
}

function isPlatformAdminRoleId(roleId: string): boolean {
  return foldCode(roleId) === 'admin'
}

function isDelegatedAdminRoleId(roleId: string): boolean {
  return deriveDelegatedAdminNamespace(roleId) !== null || deriveDelegatedAdminNamespace(foldCode(roleId)) !== null
}

/**
 * Whether granting `code` (directly, through a role, or through the legacy column) can raise a
 * user's privilege class: an admin-level code, an editor elevation shape, or a sensitive authority
 * code. Non-string values never raise.
 */
export function isClassRaisingPermissionCode(code: unknown): boolean {
  if (typeof code !== 'string') return false
  return isAdminLevelPermissionCode(code) || isEditorElevatedShape(code) || isSensitiveAuthorityCode(code)
}

/**
 * Whether holding the role `roleId` raises a user's privilege class by itself: the platform
 * administrator role, or a delegated administrator role, read from the raw and the folded id.
 * Non-string values never raise.
 */
export function isClassRaisingRoleId(roleId: unknown): boolean {
  if (typeof roleId !== 'string') return false
  return isPlatformAdminRoleId(roleId) || isDelegatedAdminRoleId(roleId)
}
