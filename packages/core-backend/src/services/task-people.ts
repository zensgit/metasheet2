/**
 * Task usability package 1b — the reads behind the people picker of the task pages. Reads only.
 *
 * - `searchOrgPeople` / `resolveOrgPeople` (`GET /api/tasks/people`, tasks:write): the people the
 *   task writes accept as an assignee or follower, from the caller's org only. Who counts is decided
 *   by `findActiveOrgMembers` (task-org-members.ts), the same test the writes run, so the directory
 *   never offers a person the write would refuse as `INACTIVE_ORG_MEMBER`, and never leaves out one
 *   it would accept. Each row carries the name, a masked email as the distinguishing detail, and
 *   whether the person can use tasks (`findTaskAccessHolders`, task-member-access.ts, the test an
 *   assignee write runs). Nothing else about the person leaves the server.
 * - `loadTaskPeople` (`GET /api/tasks/:id/people`, tasks:read): for a task the caller can view (the
 *   same 404 as the detail read otherwise), its creator, assignees and followers, each with a name
 *   and whether they are still an active member of the caller's org. A name is given only for a
 *   person with a membership row in that org, active or not; nobody gets an email or any other
 *   detail.
 */
import { can } from '../tasks/task-access'
import { escapeLikeTerm, maskEmail, PEOPLE_SEARCH_BATCH, PEOPLE_SEARCH_MAX_BATCHES } from '../tasks/task-people-search'
import { findTaskAccessHolders } from './task-member-access'
import { findActiveOrgMembers } from './task-org-members'
import { fail, loadRowRoles, loadTask, plainDb, type Db, type Row } from './task-records'

export interface PersonOption {
  /** `users.id`, the value the task writes take. */
  id: string
  /** The trimmed name; `''` when blank (the client shows the id). */
  name: string
  /** The masked email (`maskEmail`). */
  detail: string
  canUseTasks: boolean
}

export type TaskPersonStatus = 'active' | 'inactive'

export interface TaskPerson {
  name: string
  status: TaskPersonStatus
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function toOptions(rows: Row[], holders: Set<string>): PersonOption[] {
  return rows.map((row) => {
    const id = String(row.id)
    return { id, name: textOf(row.name), detail: maskEmail(textOf(row.email)), canUseTasks: holders.has(id) }
  })
}

/**
 * Active members of `orgId` whose name contains `term` (a literal, case-insensitive substring) or
 * whose id is exactly `term`, ordered by name then id, at most `limit` of them. The candidates of the
 * org are read in batches and each batch is narrowed by `findActiveOrgMembers`; after
 * `PEOPLE_SEARCH_MAX_BATCHES` batches the search stops with `hasMore`, so a term that matches many
 * people who are no longer members costs a bounded number of statements.
 */
export async function searchOrgPeople(db: Db, input: { orgId: string; term: string; limit: number }): Promise<{ items: PersonOption[]; hasMore: boolean }> {
  const pattern = `%${escapeLikeTerm(input.term)}%`
  const kept: Row[] = []
  let exhausted = false
  for (let batch = 0; batch < PEOPLE_SEARCH_MAX_BATCHES && kept.length <= input.limit; batch += 1) {
    const result = await db.query(
      `SELECT u.id, u.name, u.email
       FROM user_orgs uo
       JOIN users u ON u.id = uo.user_id
       WHERE uo.org_id = $1 AND (COALESCE(u.name, '') ILIKE $2 OR u.id = $3)
       ORDER BY u.name NULLS LAST, u.id
       LIMIT $4 OFFSET $5`,
      [input.orgId, pattern, input.term, PEOPLE_SEARCH_BATCH, batch * PEOPLE_SEARCH_BATCH],
    )
    const active = await findActiveOrgMembers(db, input.orgId, result.rows.map((row) => String(row.id)))
    for (const row of result.rows) if (active.has(String(row.id))) kept.push(row)
    if (result.rows.length < PEOPLE_SEARCH_BATCH) {
      exhausted = true
      break
    }
  }
  const page = kept.slice(0, input.limit)
  const holders = await findTaskAccessHolders(db, page.map((row) => String(row.id)))
  return { items: toOptions(page, holders), hasMore: kept.length > input.limit || !exhausted }
}

/** The subset of `ids` that are active members of `orgId`, in the order given. An id that is
 *  unknown, in another org, or no longer active is left out, and nothing says which. */
export async function resolveOrgPeople(db: Db, input: { orgId: string; ids: string[] }): Promise<PersonOption[]> {
  const active = await findActiveOrgMembers(db, input.orgId, input.ids)
  const kept = input.ids.filter((id) => active.has(id))
  if (kept.length === 0) return []
  const result = await db.query(`SELECT id, name, email FROM users WHERE id = ANY($1::text[])`, [kept])
  const byId = new Map<string, Row>(result.rows.map((row): [string, Row] => [String(row.id), row]))
  const rows = kept.flatMap((id) => {
    const row = byId.get(id)
    return row ? [row] : []
  })
  return toOptions(rows, await findTaskAccessHolders(db, kept))
}

/**
 * The creator, assignees and followers of a task the actor can view, each with a name and a status.
 * 404 exactly when the detail read is 404: a missing task, one in another org, or one the actor has
 * no role on (list roles included).
 */
export async function loadTaskPeople(input: { orgId: string; actorId: string; taskId: string }): Promise<Record<string, TaskPerson>> {
  const task = await loadTask(plainDb, input.taskId, input.orgId)
  const { roles, assignees } = await loadRowRoles(plainDb, { taskId: input.taskId, actorId: input.actorId, createdBy: task.createdBy })
  if (!can(roles, 'view')) fail(404, 'NOT_FOUND')
  const followers = await plainDb.query(`SELECT user_id FROM task_followers WHERE task_id = $1 ORDER BY user_id`, [input.taskId])
  const ids = Array.from(new Set([
    task.createdBy,
    ...assignees.map((row) => row.userId),
    ...followers.rows.map((row) => String(row.user_id)),
  ]))
  const named = await plainDb.query(
    `SELECT u.id, u.name
     FROM users u
     JOIN user_orgs uo ON uo.user_id = u.id AND uo.org_id = $2
     WHERE u.id = ANY($1::text[])`,
    [ids, input.orgId],
  )
  const names = new Map<string, string>(named.rows.map((row): [string, string] => [String(row.id), textOf(row.name)]))
  const active = await findActiveOrgMembers(plainDb, input.orgId, ids)
  // Object.fromEntries defines each id as an own key, whatever the id is.
  return Object.fromEntries(ids.map((id): [string, TaskPerson] => [id, {
    name: names.get(id) ?? '',
    status: active.has(id) ? 'active' : 'inactive',
  }]))
}
