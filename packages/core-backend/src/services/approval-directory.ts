import { query } from '../db/pg'

/**
 * Minimal-exposure directory lookups for the approval-authoring assignee picker.
 *
 * These deliberately return ONLY an identifier + label (and email for users) — far less
 * than admin-users' ADMIN_USER_PROFILE_SELECT / fetchRoleCatalog. The picker needs to turn
 * a free-text id into a human-pickable option, nothing more, and these endpoints are gated
 * upstream by rbacGuard('approval-templates:manage'). Keeping the shape minimal is the
 * least-privilege choice and avoids re-exposing the full admin user profile through a
 * template-authoring surface.
 */

export interface DirectoryUserOption {
  id: string
  name: string
  email: string
}

export interface DirectoryRoleOption {
  id: string
  name: string
}

const MAX_LIMIT = 50
const DEFAULT_LIMIT = 20

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT)
}

/** Search active users by id/name/email/username. Returns id/name/email only. */
export async function searchDirectoryUsers(q: string, limit: number): Promise<DirectoryUserOption[]> {
  const safeLimit = clampLimit(limit)
  const term = q ? `%${q}%` : null
  const where = term
    ? `WHERE is_active = TRUE AND (COALESCE(email, '') ILIKE $1 OR COALESCE(username, '') ILIKE $1 OR name ILIKE $1 OR id ILIKE $1)`
    : `WHERE is_active = TRUE`
  const sql = `
    SELECT id, name, COALESCE(email, '') AS email
    FROM users
    ${where}
    ORDER BY name ASC
    LIMIT ${term ? '$2' : '$1'}
  `
  const result = await query<{ id: string; name: string; email: string }>(
    sql,
    term ? [term, safeLimit] : [safeLimit],
  )
  return result.rows.map((row) => ({ id: row.id, name: row.name ?? '', email: row.email ?? '' }))
}

/**
 * List roles as id/name options. Deliberately leaner than admin-users' fetchRoleCatalog
 * (which also computes permissions + member counts); the picker only needs id + label.
 */
export async function listDirectoryRoles(): Promise<DirectoryRoleOption[]> {
  const result = await query<{ id: string; name: string }>(
    `SELECT r.id, r.name FROM roles r ORDER BY r.id ASC`,
  )
  return result.rows.map((row) => ({ id: row.id, name: row.name ?? '' }))
}

/**
 * RA-1b CURATED-VOCABULARY: list ONLY the roles an author may route on in a formula `requester.role in
 * [...]` condition — i.e. `approval_usable = true`. This is the DEDICATED formula-condition role picker,
 * distinct from `listDirectoryRoles` (which serves static_role approver selection and returns ALL roles).
 * The publish/dry-run HARD GATE re-validates against the same curated set, so the picker is convenience,
 * not the security boundary.
 */
export async function listFormulaConditionRoles(): Promise<DirectoryRoleOption[]> {
  const result = await query<{ id: string; name: string }>(
    `SELECT r.id, r.name FROM roles r WHERE r.approval_usable = true ORDER BY r.id ASC`,
  )
  return result.rows.map((row) => ({ id: row.id, name: row.name ?? '' }))
}

/** QueryFn shape so the publish HARD GATE can fetch the curated set on its OWN transaction client (one read
 *  per publish), while the dry-run route uses the default pooled `query`. */
type CuratedQueryFn = <Row>(text: string, params?: unknown[]) => Promise<{ rows: Row[] }>

/**
 * RA-1b CURATED-VOCABULARY: the curated set of role ids approved for formula `requester.role` routing —
 * `SELECT id FROM roles WHERE approval_usable = true`. This is THE source of truth for the publish + dry-run
 * HARD GATE (independent of any picker). Pass a transaction-scoped query fn at publish; defaults to the
 * pooled `query` for the dry-run route.
 */
export async function fetchCuratedApprovalRoleIds(queryFn?: CuratedQueryFn): Promise<Set<string>> {
  const run: CuratedQueryFn = queryFn ?? (query as unknown as CuratedQueryFn)
  const result = await run<{ id: string }>(`SELECT id FROM roles WHERE approval_usable = true`, [])
  const curated = new Set<string>()
  for (const row of result.rows) {
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id) curated.add(id)
  }
  return curated
}
