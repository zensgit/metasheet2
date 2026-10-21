/**
 * Active org membership for the task writes that name another user (M4 PR-3a S6 and S9, design
 * task-m4-pr3a-backend-design-20260930.md §4.6).
 *
 * RULED(2026-10-07): [R17] [N2] a user written into a list as a member, and (S9) an
 * assignee named at task creation or added later, or a new follower, must be an active member of
 * the caller's org by the same test as login. That test has two halves, and both are applied here:
 * - the session org (`AuthService.resolveSessionTenantId`): a `user_orgs` row for that org with
 *   `is_active`, and `users.is_active`;
 * - the account gate every sign-in and token check runs (`evaluateUserAuthenticationGate`,
 *   `user-activation.ts`): `activation_status` is `activated` and the role is not `disabled`, where
 *   the role is the one login resolves: a user holding the RBAC `admin` role is checked as `admin`.
 *   The local-password condition is not part of it: it applies to password login only.
 * ASSUMPTION(task-m4): [own-27] the target of an ownership transfer takes the same test. [own-16]
 * the acting user is never checked here: their org claim passed that test when the token was
 * verified. One
 * code for every failure: 422 `INACTIVE_ORG_MEMBER` does not say whether the user is unknown,
 * belongs to another org, is inactive in this org, or is inactive altogether. Callers: list member
 * add and owner transfer (`task-list-records.ts`), `createTask` (`task-records.ts`), `addAssignee`
 * and `addFollower` (`task-structure.ts`). Membership rows already written are never cleaned up
 * when a user leaves the org.
 */
import { fail, type Db } from './task-records'

/** The subset of `userIds` that are active members of `orgId`. Runs on the caller's `db`. */
export async function findActiveOrgMembers(db: Db, orgId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const result = await db.query(
    `SELECT uo.user_id
     FROM user_orgs uo
     JOIN users u ON u.id = uo.user_id
     WHERE uo.org_id = $1 AND uo.user_id = ANY($2::text[]) AND uo.is_active = true AND u.is_active = true
       AND u.activation_status = 'activated'
       AND (u.role <> 'disabled' OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'admin'))`,
    [orgId, userIds],
  )
  return new Set(result.rows.map((row) => String(row.user_id)))
}

/** 422 `INACTIVE_ORG_MEMBER` unless every id in `userIds` is an active member of `orgId`. */
export async function assertActiveOrgMembers(db: Db, orgId: string, userIds: string[]): Promise<void> {
  const active = await findActiveOrgMembers(db, orgId, userIds)
  if (userIds.some((userId) => !active.has(userId))) fail(422, 'INACTIVE_ORG_MEMBER')
}
