import { visibleUserPredicate } from '../admin/user-visibility'
import { query } from '../db/pg'
import type { RoleAssignmentScope } from '../rbac/role-assignment'

const ATTENDANCE_ROLE_NAMESPACES: readonly string[] = ['attendance']

export type AttendanceAdminResolvedUser = {
  id: string
  email: string
  name: string | null
  employeeNo: string | null
  department: string | null
  is_active: boolean
}

export type AttendanceAdminUserScope =
  | { kind: 'global' }
  | { kind: 'org'; orgId: string }

export class AttendanceAdminUserScopeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AttendanceAdminUserScopeError'
  }
}

/**
 * The authority a role write of this router runs under, derived from the caller's RESOLVED user
 * scope rather than asserted by a comment beside a constant:
 *  - `global` → `platform-admin-in-namespaces`. The preflight grants `global` to a legacy
 *    claim or the `admin` role. Role writers do not stop there: after the role-row share
 *    they lock the actor with the targets and re-read authority from that row. A token
 *    claim alone is not enough to appoint `attendance_admin`
 *    (owner ruling 「只有平台管理员能任命 *_admin」).
 *    The role-id bound is the router's own namespace.
 *  - anything else (`org`, or a shape this function does not know) → refused,
 *    ORG_SCOPED_ROLE_WRITE_UNAVAILABLE: `user_roles` has no org_id, so a delegated write would grant
 *    or revoke the role in every organization the target belongs to although the request proved
 *    only one. If an org-scoped role store ever exists, THIS is the function that must change, and
 *    the delegated arm for it is `{ kind: 'namespaces' }` (which refuses main-admin and
 *    admin-equivalent roles) — never the platform arm.
 */
export function deriveAttendanceRoleAssignmentScope(scope: AttendanceAdminUserScope): RoleAssignmentScope {
  if (scope?.kind === 'global') {
    return { kind: 'platform-admin-in-namespaces', namespaces: ATTENDANCE_ROLE_NAMESPACES }
  }
  throw new AttendanceAdminUserScopeError(
    403,
    'ORG_SCOPED_ROLE_WRITE_UNAVAILABLE',
    'Organization-scoped role changes require an organization-scoped role store',
  )
}

export async function fetchUserProfile(
  userId: string,
  runQuery: typeof query = query,
): Promise<Record<string, unknown> | null> {
  const { rows } = await runQuery<{
    id: string
    email: string
    name: string | null
    employeeNo: string | null
    department: string | null
    role: string
    is_active: boolean
    is_admin: boolean
    last_login_at: string | null
    created_at: string
  }>(
    `SELECT id, email, name, employee_no AS "employeeNo", department, role, is_active, is_admin, last_login_at, created_at
     FROM users
     WHERE id = $1`,
    [userId],
  )
  if (!rows.length) return null
  return rows[0] as unknown as Record<string, unknown>
}

export async function resolveBatchUsers(
  userIds: string[],
  scope: AttendanceAdminUserScope,
  runQuery: typeof query = query,
  lockMembership = false,
): Promise<{
  items: AttendanceAdminResolvedUser[]
  missingUserIds: string[]
  inactiveUserIds: string[]
}> {
  if (userIds.length === 0) {
    return { items: [], missingUserIds: [], inactiveUserIds: [] }
  }

  const lockClause = lockMembership
    ? scope.kind === 'org' ? 'FOR SHARE OF u, uo' : 'FOR SHARE OF u'
    : ''
  const found = scope.kind === 'org'
    ? await runQuery<AttendanceAdminResolvedUser>(
      `SELECT u.id, u.email, u.name, u.employee_no AS "employeeNo", u.department, u.is_active
       FROM users u
       JOIN user_orgs uo
         ON uo.user_id = u.id
        AND uo.org_id = $2
        AND uo.is_active = true
       WHERE u.id = ANY($1::text[])
         AND u.is_active = true
         AND ${visibleUserPredicate('u')}
       ${lockClause}`,
      [userIds, scope.orgId],
    )
    : await runQuery<AttendanceAdminResolvedUser>(
      `SELECT u.id, u.email, u.name, u.employee_no AS "employeeNo", u.department, u.is_active
       FROM users u
       WHERE u.id = ANY($1::text[])
         AND ${visibleUserPredicate('u')}
       ${lockClause}`,
      [userIds],
    )

  const byId = new Map(found.rows.map((row) => [String(row.id), row]))
  const items: AttendanceAdminResolvedUser[] = []
  const missingUserIds: string[] = []

  for (const userId of userIds) {
    const item = byId.get(userId)
    if (!item) {
      missingUserIds.push(userId)
      continue
    }
    items.push(item)
  }

  const inactiveUserIds = items
    .filter((item) => item.is_active === false)
    .map((item) => item.id)

  return { items, missingUserIds, inactiveUserIds }
}

export function assertAllRoleTargetsEligible(
  userIds: string[],
  resolved: Awaited<ReturnType<typeof resolveBatchUsers>>,
): void {
  if (
    resolved.items.length !== userIds.length
    || resolved.missingUserIds.length > 0
    || resolved.inactiveUserIds.length > 0
  ) {
    // Foreign-org, inactive and nonexistent identities intentionally share one response.
    throw new AttendanceAdminUserScopeError(404, 'USER_TARGET_NOT_FOUND', 'User not found in requested scope')
  }
}
