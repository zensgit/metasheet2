import { evaluateUserAuthenticationGate } from '../auth/user-activation'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction } from '../multitable/pg-transaction-guard'
import { deriveGrantNamespaces } from '../rbac/namespace-admission'

export type AutomationIntegrationActor = {
  actorId: string
  tenantId: string
  workspaceId: null
}

export type AutomationActorAuthorityErrorCode =
  | 'AUTOMATION_ACTOR_INPUT_INVALID'
  | 'AUTOMATION_ACTOR_TRANSACTION_REQUIRED'
  | 'AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE'
  | 'AUTOMATION_ACTOR_AUTHORITY_DENIED'

const ERROR_MESSAGES: Record<AutomationActorAuthorityErrorCode, string> = {
  AUTOMATION_ACTOR_INPUT_INVALID: 'Automation actor scope is invalid',
  AUTOMATION_ACTOR_TRANSACTION_REQUIRED: 'Automation actor authority requires a read-committed transaction',
  AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE: 'Automation actor authority is unavailable',
  AUTOMATION_ACTOR_AUTHORITY_DENIED: 'Automation actor authority is denied',
}

export class AutomationActorAuthorityError extends Error {
  constructor(readonly code: AutomationActorAuthorityErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'AutomationActorAuthorityError'
  }
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && value.trim() === value
    // eslint-disable-next-line no-control-regex -- Scope identifiers must explicitly reject embedded ASCII controls.
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function normalizedPermissionCodes(values: unknown[]): string[] {
  return values.flatMap((value) => typeof value === 'string' && value.trim() ? [value.trim()] : [])
}

/**
 * Host-only LIVE actor prerequisite for Automation A, not an execution authorization.
 * The host must supply the trusted actor/tenant and check Connection ownership, grant,
 * source/version/receipt, target, expiry and budget separately in this SAME transaction.
 * No request header, plugin identity, cached RBAC result or caller admin boolean is used.
 *
 * The caller must BEGIN and SET TRANSACTION ISOLATION LEVEL READ COMMITTED BEFORE this
 * function (the transaction probe already executes a statement). No SET/COMMIT occurs here.
 * Only rows RETURNED by the locking reads below contribute authority. A separate unlocked
 * reread could adopt a concurrently inserted grant that was never locked; do not add one.
 * The phased FOR SHARE locks retain each observed positive grant until caller commit/rollback.
 * This does not promise continuous revocation after commit or during subsequent source IO.
 *
 * Lock order: user_roles -> role_permissions -> user_permissions -> users -> user_orgs
 * -> namespace admissions. Role display names/users.is_admin are deliberately not authority.
 * Missing tables and every query failure reject, even when ordinary RBAC permits degradation.
 */
export async function assertAutomationIntegrationActor(
  trx: Queryable,
  input: AutomationIntegrationActor,
): Promise<void> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !isCanonicalId(input.actorId) || !isCanonicalId(input.tenantId)
    || !Object.prototype.hasOwnProperty.call(input, 'workspaceId') || input.workspaceId !== null) {
    throw new AutomationActorAuthorityError('AUTOMATION_ACTOR_INPUT_INVALID')
  }

  try {
    if (!trx || typeof trx.query !== 'function') throw new Error('Missing transaction')
    const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
    if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') {
      throw new Error('Wrong isolation')
    }
    await assertInTransaction(trx, 'Automation actor authority')
  } catch {
    throw new AutomationActorAuthorityError('AUTOMATION_ACTOR_TRANSACTION_REQUIRED')
  }

  let roles: Array<Record<string, unknown>>
  let rolePermissions: Array<Record<string, unknown>>
  let directPermissions: Array<Record<string, unknown>>
  let users: Array<Record<string, unknown>>
  let memberships: Array<Record<string, unknown>>
  let admissions: Array<Record<string, unknown>>
  try {
    roles = (await trx.query(
      `SELECT role_id FROM user_roles
       WHERE user_id = $1 ORDER BY role_id FOR SHARE`,
      [input.actorId],
    )).rows
    // Capture the exact locked role ids; never rejoin user_roles in a later query.
    const roleIds = [...new Set(roles.map((row) => row.role_id))]
    if (roleIds.some((roleId) => typeof roleId !== 'string' || !roleId)) {
      throw new Error('Invalid role row')
    }
    rolePermissions = (await trx.query(
      `SELECT role_id, permission_code FROM role_permissions
       WHERE role_id = ANY($1::text[]) ORDER BY role_id, permission_code FOR SHARE`,
      [roleIds.sort()],
    )).rows
    directPermissions = (await trx.query(
      `SELECT permission_code FROM user_permissions
       WHERE user_id = $1 ORDER BY permission_code FOR SHARE`,
      [input.actorId],
    )).rows
    users = (await trx.query(
      `SELECT id, role, is_active, activation_status, permissions FROM users
       WHERE id = $1 FOR SHARE`,
      [input.actorId],
    )).rows
    memberships = (await trx.query(
      `SELECT user_id, org_id, is_active FROM user_orgs
       WHERE user_id = $1 AND org_id = $2 ORDER BY org_id FOR SHARE`,
      [input.actorId, input.tenantId],
    )).rows
    admissions = (await trx.query(
      `SELECT namespace, enabled FROM user_namespace_admissions
       WHERE user_id = $1 AND namespace = $2 ORDER BY namespace FOR SHARE`,
      [input.actorId, 'integration'],
    )).rows
  } catch {
    // Never project SQL errors, database identifiers or underlying error causes.
    throw new AutomationActorAuthorityError('AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE')
  }

  const user = users[0]
  const normalizedAdmin = roles.some((row) => row.role_id === 'admin')
  const effectiveRole = normalizedAdmin ? 'admin' : typeof user?.role === 'string' ? user.role : null
  if (users.length !== 1 || user?.id !== input.actorId || user.is_active !== true
    || evaluateUserAuthenticationGate({
      role: effectiveRole,
      is_active: user.is_active,
      activation_status: typeof user.activation_status === 'string' ? user.activation_status : null,
    }) !== null
    || memberships.length !== 1 || memberships[0]?.user_id !== input.actorId
    || memberships[0]?.org_id !== input.tenantId || memberships[0]?.is_active !== true) {
    throw new AutomationActorAuthorityError('AUTOMATION_ACTOR_AUTHORITY_DENIED')
  }

  const codes = new Set(normalizedPermissionCodes([
    ...rolePermissions.map((row) => row.permission_code),
    ...directPermissions.map((row) => row.permission_code),
    ...(Array.isArray(user.permissions) ? user.permissions : []),
  ]))
  // Match the integration HTTP admin gate exactly: wildcards alone do not qualify.
  // role:admin is a non-namespace-controlled permission in the existing RBAC contract.
  if (effectiveRole === 'admin' || codes.has('role:admin')) return

  const roleNamespaces = new Set(roles.flatMap((role) => deriveGrantNamespaces({
    roleId: role.role_id as string,
    permissionCodes: normalizedPermissionCodes(rolePermissions
      .filter((row) => row.role_id === role.role_id)
      .map((row) => row.permission_code)),
  })))
  if (codes.has('integration:admin') && roleNamespaces.has('integration')
    && admissions.length === 1 && admissions[0]?.namespace === 'integration'
    && admissions[0]?.enabled === true) return

  throw new AutomationActorAuthorityError('AUTOMATION_ACTOR_AUTHORITY_DENIED')
}
