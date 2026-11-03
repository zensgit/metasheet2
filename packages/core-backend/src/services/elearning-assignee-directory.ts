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

/**
 * Synthetic addresses the platform stores on `users.email` that are not a person's mailbox:
 * DingTalk JIT accounts get `dingtalk_<unionId|openId>@placeholder.local`
 * (auth/dingtalk-oauth.ts), the no-email migration's down() backfills `<id>@migration-revert.local`,
 * and trusted-token principals are named `<id>@trusted-token.local` (auth/AuthService.ts). They
 * embed external or internal identifiers, so they are neither matched nor returned.
 */
export const ELEARNING_ASSIGNEE_PLACEHOLDER_EMAIL_DOMAINS = [
  'placeholder.local',
  'migration-revert.local',
  'trusted-token.local',
] as const

const PLACEHOLDER_EMAIL_LIKE_PATTERNS = ELEARNING_ASSIGNEE_PLACEHOLDER_EMAIL_DOMAINS.map(
  (domain) => `%@${domain}`,
)

export function isElearningAssigneePlaceholderEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase()
  return ELEARNING_ASSIGNEE_PLACEHOLDER_EMAIL_DOMAINS.some((domain) => normalized.endsWith(`@${domain}`))
}

function visibleEmail(value: unknown): string | null {
  const email = optionalText(value)
  return email && !isElearningAssigneePlaceholderEmail(email) ? email : null
}

/** Escapes the LIKE metacharacters so a typed `%` or `_` matches literally. */
export function escapeElearningAssigneeLikeTerm(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** Defence in depth: the route already rejects out-of-range limits. */
export function clampElearningAssigneeLimit(value: number): number {
  if (!Number.isFinite(value)) return ELEARNING_ASSIGNEE_SEARCH_DEFAULT_LIMIT
  return Math.min(ELEARNING_ASSIGNEE_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(value)))
}

export async function searchElearningAssignees(
  db: ElearningAssigneeDirectoryDb,
  input: SearchElearningAssigneesInput,
): Promise<ElearningAssigneeSearchResult> {
  const term = input.query.trim()
  const pattern = `%${escapeElearningAssigneeLikeTerm(term)}%`
  const limit = clampElearningAssigneeLimit(input.limit)
  const rows = await db.transaction(async (tx) => {
    const result = await tx.query(
      `/* elearning-assignee-directory:search */
       SELECT platform_user.id, platform_user.name,
              CASE WHEN lower(COALESCE(platform_user.email, '')) LIKE ANY($5::text[])
                   THEN NULL ELSE platform_user.email END AS email
       FROM users platform_user
       JOIN user_orgs membership
         ON membership.user_id = platform_user.id
        AND membership.org_id = $1
        AND membership.is_active = TRUE
       WHERE platform_user.is_active = TRUE
         AND (
           $2::text = ''
           OR COALESCE(platform_user.name, '') ILIKE $3 ESCAPE '\\'
           OR (
             COALESCE(platform_user.email, '') ILIKE $3 ESCAPE '\\'
             AND NOT lower(COALESCE(platform_user.email, '')) LIKE ANY($5::text[])
           )
         )
       ORDER BY COALESCE(NULLIF(platform_user.name, ''), platform_user.email, platform_user.id) ASC,
                platform_user.id ASC
       LIMIT $4`,
      [input.orgId, term, pattern, limit, PLACEHOLDER_EMAIL_LIKE_PATTERNS],
    )
    return result.rows
  })
  const items: ElearningAssigneeCandidate[] = []
  for (const row of rows) {
    const id = optionalText(row.id)
    if (!id) continue
    items.push({ id, name: optionalText(row.name), email: visibleEmail(row.email) })
  }
  return { items }
}
