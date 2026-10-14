/**
 * Read-only people lookup for the e-learning assignment forms (rehearsal finding F13).
 *
 * The course forms used to ask the teacher for a raw user UUID. A teacher holds
 * `elearning:admin`, which is not platform admin, so the platform user search
 * (`/api/admin/users`), the attendance search (`attendance:admin`) and the approval
 * directories (`approvals:*`) are all out of reach. This lookup is the smallest
 * replacement: it only ever reads ACTIVE users holding an ACTIVE membership in the
 * caller's JWT-bound org, matched by name or email, and returns id + display name +
 * email — never role, admin flag, mobile, department or login data.
 *
 * Why the whole org rather than the caller's admin scopes: the route sits behind
 * `rbacGuard('elearning', 'admin')`, and every holder of `elearning:admin` is an
 * e-learning global admin (`isElearningGlobalAdminRequest`), for whom direct
 * assignment skips the admin-scope coverage check. The population returned here is
 * therefore exactly the population such a caller can already assign to.
 */

export const ELEARNING_ASSIGNEE_SEARCH_DEFAULT_LIMIT = 20
export const ELEARNING_ASSIGNEE_SEARCH_MAX_LIMIT = 50
export const ELEARNING_ASSIGNEE_SEARCH_MAX_QUERY_LENGTH = 100

export interface ElearningAssigneeDirectoryQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningAssigneeDirectoryDb {
  transaction<T>(
    handler: (tx: ElearningAssigneeDirectoryQueryable) => Promise<T>,
  ): Promise<T>
}

export interface SearchElearningAssigneesInput {
  orgId: string
  query: string
  limit: number
}

export interface ElearningAssigneeCandidate {
  id: string
  name: string | null
  email: string | null
}

export interface ElearningAssigneeSearchResult {
  items: ElearningAssigneeCandidate[]
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Escapes the LIKE metacharacters so a typed `%` or `_` matches literally. */
export function escapeElearningAssigneeLikeTerm(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export async function searchElearningAssignees(
  db: ElearningAssigneeDirectoryDb,
  input: SearchElearningAssigneesInput,
): Promise<ElearningAssigneeSearchResult> {
  const term = input.query.trim()
  const pattern = `%${escapeElearningAssigneeLikeTerm(term)}%`
  const rows = await db.transaction(async (tx) => {
    const result = await tx.query(
      `/* elearning-assignee-directory:search */
       SELECT platform_user.id, platform_user.name, platform_user.email
       FROM users platform_user
       JOIN user_orgs membership
         ON membership.user_id = platform_user.id
        AND membership.org_id = $1
        AND membership.is_active = TRUE
       WHERE platform_user.is_active = TRUE
         AND (
           $2::text = ''
           OR COALESCE(platform_user.name, '') ILIKE $3
           OR COALESCE(platform_user.email, '') ILIKE $3
         )
       ORDER BY COALESCE(NULLIF(platform_user.name, ''), platform_user.email, platform_user.id) ASC,
                platform_user.id ASC
       LIMIT $4`,
      [input.orgId, term, pattern, input.limit],
    )
    return result.rows
  })
  const items: ElearningAssigneeCandidate[] = []
  for (const row of rows) {
    const id = optionalText(row.id)
    if (!id) continue
    items.push({ id, name: optionalText(row.name), email: optionalText(row.email) })
  }
  return { items }
}
