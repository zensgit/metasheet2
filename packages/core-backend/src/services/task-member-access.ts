/**
 * Task access for the task writes that name another user as an assignee: task creation (every
 * assignee other than the creator) and an assignee add (any target other than the caller).
 *
 * The person named must be able to use tasks the way the task routes demand it: a platform
 * administrator, or a holder of both task codes with task access enabled. The test runs after the
 * active-org-member test (task-org-members.ts), inside the caller's transaction, on the caller's
 * `db`, after the org structure lock. One code for every failure: 422
 * `ASSIGNEE_TASK_ACCESS_REQUIRED` names nobody and does not say what is missing. Nothing is ever
 * granted here. Followers, list members and owner transfers are not checked here.
 */
import { listUserPermissions } from '../rbac/service'
import { userHasEffectiveNamespaceAccess } from '../rbac/namespace-admission'
import { fail, type Db } from './task-records'

/** The two codes an assignee needs; the door checks them on separate routes. */
export const TASK_ACCESS_CODES = ['tasks:read', 'tasks:write'] as const

/** The route guard's matcher, copied (rbac.ts). */
export function holdsTaskCode(codes: readonly string[], code: string): boolean {
  if (codes.includes(code) || codes.includes('*:*')) return true
  const resource = code.split(':')[0]
  return resource ? codes.includes(`${resource}:*`) : false
}

/** The subset of `userIds` that can use tasks. Runs on the caller's `db`. Sends nothing for []. */
export async function findTaskAccessHolders(db: Db, userIds: string[]): Promise<Set<string>> {
  const ids = Array.from(new Set(userIds))
  const holders = new Set<string>()
  if (ids.length === 0) return holders
  const admins = await db.query(
    `SELECT u.id AS user_id
     FROM users u
     WHERE u.id = ANY($1::text[])
       AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'admin'))`,
    [ids],
  )
  for (const row of admins.rows) holders.add(String(row.user_id))
  for (const userId of ids) {
    if (holders.has(userId)) continue
    const codes = await listUserPermissions(userId, db.query)
    if (holdsTaskCode(codes, 'tasks:read') && holdsTaskCode(codes, 'tasks:write') && await userHasEffectiveNamespaceAccess(userId, 'tasks', db.query)) holders.add(userId)
  }
  return holders
}

/** 422 `ASSIGNEE_TASK_ACCESS_REQUIRED` unless every id in `userIds` can use tasks. Sends nothing for []. */
export async function assertTaskAccess(db: Db, userIds: string[]): Promise<void> {
  const holders = await findTaskAccessHolders(db, userIds)
  if (userIds.some((userId) => !holders.has(userId))) fail(422, 'ASSIGNEE_TASK_ACCESS_REQUIRED')
}
