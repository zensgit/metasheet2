import { query } from '../db/pg'

/**
 * Minimal-exposure directory lookups for the approval-authoring assignee picker.
 *
 * These deliberately return ONLY an identifier + label (and email for users) — far less
 * than admin-users' ADMIN_USER_PROFILE_SELECT / fetchRoleCatalog. The picker needs to turn
 * a free-text id into a human-pickable option, nothing more, and these endpoints are gated
 * upstream by the template-admin guard (`approval-templates:manage` or
 * `approvals:admin-templates`). Keeping the shape minimal is the least-privilege choice
 * and avoids re-exposing the full admin user profile through a template-authoring surface.
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

/**
 * Lock-1 §K2 — optional scope narrowing for the submit-time requester-choice picker. Both
 * constraints AND onto the base active-user search: `userIds` restricts candidates to an
 * explicit id list (the `members` scope, template-authored config); `roleIds` restricts to
 * users holding at least one of the roles via PLAIN `user_roles` membership (the `role`
 * scope) — deliberately NOT joined on `roles.approval_usable`, which curates the
 * `requester.role` ROUTING predicate, not approver selection (§K1 honesty note). The picker
 * is candidate convenience only; `validateAndFreezeRequesterChoices` re-validates the actual
 * submitted choice server-side at create.
 */
export interface DirectoryUserSearchScope {
  userIds?: string[]
  roleIds?: string[]
}

/** Search active users by id/name/email/username. Returns id/name/email only. */
export async function searchDirectoryUsers(
  q: string,
  limit: number,
  scope: DirectoryUserSearchScope = {},
): Promise<DirectoryUserOption[]> {
  const safeLimit = clampLimit(limit)
  const term = q ? `%${q}%` : null
  const params: unknown[] = []
  const conditions: string[] = ['is_active = TRUE']
  if (term) {
    params.push(term)
    const p = `$${params.length}`
    conditions.push(`(COALESCE(email, '') ILIKE ${p} OR COALESCE(username, '') ILIKE ${p} OR name ILIKE ${p} OR id ILIKE ${p})`)
  }
  const scopeUserIds = (scope.userIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0)
  if (scopeUserIds.length > 0) {
    params.push(scopeUserIds)
    conditions.push(`id = ANY($${params.length}::varchar[])`)
  }
  const scopeRoleIds = (scope.roleIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0)
  if (scopeRoleIds.length > 0) {
    params.push(scopeRoleIds)
    conditions.push(`EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = users.id AND ur.role_id = ANY($${params.length}::varchar[]))`)
  }
  params.push(safeLimit)
  const sql = `
    SELECT id, name, COALESCE(email, '') AS email
    FROM users
    WHERE ${conditions.join(' AND ')}
    ORDER BY name ASC
    LIMIT $${params.length}
  `
  const result = await query<{ id: string; name: string; email: string }>(sql, params)
  return result.rows.map((row) => ({ id: row.id, name: row.name ?? '', email: row.email ?? '' }))
}

const RESOLVE_MAX_IDS = 200

function sanitizeResolveIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id) continue
    seen.add(id)
    if (seen.size >= RESOLVE_MAX_IDS) break
  }
  return Array.from(seen)
}

/**
 * member-display-identity (2026-08-19) — EXACT batch id->name resolver for the participant
 * directory. Distinct from `searchDirectoryUsers`: no ILIKE/substring matching (the id list is
 * ANDed with `id = ANY($1)`, never combined with a `q` term), and — the important difference for
 * a values-free display resolver — a row whose `name` is null/blank is DROPPED from the result
 * rather than returned with an empty string, so "absent from the response" is the single,
 * unambiguous unresolved signal a caller needs (no per-caller "is this name blank" convention).
 * `is_active = TRUE` (same predicate `searchDirectoryUsers` uses): a deactivated/removed account
 * resolves to unresolved, not an error and not its old name — the caller decides how to render
 * that (a values-free placeholder / count, never the raw id).
 *
 * Ids are de-duplicated and capped at `RESOLVE_MAX_IDS` (200, matching the existing `?userIds=`
 * scope-narrowing cap on the participant directory search route) so a hostile query cannot smuggle
 * an unbounded `id = ANY(...)` array. An empty/all-blank input short-circuits to `[]` with no query.
 */
export async function resolveDirectoryUsersByIds(ids: readonly string[]): Promise<DirectoryUserOption[]> {
  const safeIds = sanitizeResolveIds(ids)
  if (safeIds.length === 0) return []
  const result = await query<{ id: string; name: string | null; email: string }>(
    `SELECT id, name, COALESCE(email, '') AS email
     FROM users
     WHERE id = ANY($1::varchar[]) AND is_active = TRUE`,
    [safeIds],
  )
  return result.rows
    .filter((row) => typeof row.name === 'string' && row.name.trim().length > 0)
    .map((row) => ({ id: row.id, name: (row.name as string).trim(), email: row.email ?? '' }))
}

/**
 * member-display-identity (2026-08-19) — EXACT batch id->name resolver for roles, the sibling of
 * `resolveDirectoryUsersByIds` above. Roles carry no `is_active` column (unlike users) — a role
 * row either exists with a name or it does not; a blank/null name (or a deleted role id) is
 * dropped the same values-free way.
 */
export async function resolveDirectoryRolesByIds(ids: readonly string[]): Promise<DirectoryRoleOption[]> {
  const safeIds = sanitizeResolveIds(ids)
  if (safeIds.length === 0) return []
  const result = await query<{ id: string; name: string | null }>(
    `SELECT id, name FROM roles WHERE id = ANY($1::varchar[])`,
    [safeIds],
  )
  return result.rows
    .filter((row) => typeof row.name === 'string' && row.name.trim().length > 0)
    .map((row) => ({ id: row.id, name: (row.name as string).trim() }))
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
 * Lock-1 §K1 — the org-scoped `user_group` picker option: id + name + member COUNT only (never
 * the member list itself — the picker is a values-free convenience surface, not the resolution
 * source; see `fetchMemberGroupSnapshot` for the freeze-at-create read). Leaner than
 * admin-users.ts's group-detail endpoints, which also return the full member roster.
 */
export interface DirectoryMemberGroupOption {
  id: string
  name: string
  memberCount: number
}

/**
 * Lock-1 §K1 / OD-L1-2(a) — org-scoped listing of groups CURATED (bound) for approval use in
 * `orgId`, for the template-authoring `user_group` picker. Convenience only: the publish HARD GATE
 * (`fetchCuratedApprovalMemberGroupIds` + `assertUserGroupSourcesBoundToOrg`) is the actual
 * boundary, independent of this picker — mirroring RA-1b's picker/gate split
 * (`listFormulaConditionRoles` vs. `fetchCuratedApprovalRoleIds`). `orgId` is REQUIRED here
 * (unlike the publish gate, which defaults it) so a caller can never accidentally list an
 * unscoped/every-org view through this endpoint.
 */
export async function listBoundMemberGroups(orgId: string): Promise<DirectoryMemberGroupOption[]> {
  const scopedOrgId = orgId.trim()
  if (!scopedOrgId) return []
  const result = await query<{ id: string; name: string; member_count: string }>(
    `SELECT g.id, g.name, COUNT(m.user_id)::text AS member_count
     FROM approval_usable_member_groups b
     JOIN platform_member_groups g ON g.id = b.group_id
     LEFT JOIN platform_member_group_members m ON m.group_id = g.id
     WHERE b.org_id = $1
     GROUP BY g.id, g.name
     ORDER BY g.name ASC`,
    [scopedOrgId],
  )
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name ?? '',
    memberCount: Number.parseInt(row.member_count, 10) || 0,
  }))
}

/**
 * Lock-1 §K1 / OD-L1-2(a) — the curated set of group ids bound to `orgId` for approval use
 * (`approval_usable_member_groups`). THE source of truth for the publish HARD GATE
 * (`assertUserGroupSourcesBoundToOrg`), independent of the picker above. Pass a
 * transaction-scoped query fn at publish (same `CuratedQueryFn` shape `fetchCuratedApprovalRoleIds`
 * uses); defaults to the pooled `query`.
 */
export async function fetchCuratedApprovalMemberGroupIds(
  orgId: string,
  queryFn?: CuratedQueryFn,
): Promise<Set<string>> {
  const run: CuratedQueryFn = queryFn ?? (query as unknown as CuratedQueryFn)
  const result = await run<{ group_id: string }>(
    `SELECT group_id FROM approval_usable_member_groups WHERE org_id = $1`,
    [orgId],
  )
  const curated = new Set<string>()
  for (const row of result.rows) {
    const id = typeof row.group_id === 'string' ? row.group_id.trim() : ''
    if (id) curated.add(id)
  }
  return curated
}

/**
 * Lock-1 §K1 (RATIFIED OD-L1-1(a) EAGER_EXPANSION) — freeze-at-create read: the CURRENT member
 * list of every group id in `groupIds`, keyed by group id, ordered by join time then user id for
 * determinism. Called ONCE per create (opt-in, gated on the published graph actually using a
 * `user_group` source — `collectApprovalGraphMemberGroupIds`); the resolver never reads this table
 * again after create (no live read at dispatch/return/admin-jump/timeout — that purity is what
 * makes the freeze real). A group id with no rows (deleted after publish, or genuinely empty)
 * simply contributes `[]` — NOT an error; §K1 fail-closes a foreign/dangling reference only at
 * publish, never at dispatch.
 */
export async function fetchMemberGroupSnapshot(
  groupIds: Iterable<string>,
  queryFn?: CuratedQueryFn,
): Promise<Record<string, string[]>> {
  const ids = Array.from(new Set(Array.from(groupIds).map((id) => id.trim()).filter((id) => id.length > 0)))
  const snapshot: Record<string, string[]> = {}
  if (ids.length === 0) return snapshot
  for (const id of ids) snapshot[id] = []
  const run: CuratedQueryFn = queryFn ?? (query as unknown as CuratedQueryFn)
  const result = await run<{ group_id: string; user_id: string }>(
    `SELECT group_id, user_id
     FROM platform_member_group_members
     WHERE group_id = ANY($1::uuid[])
     ORDER BY group_id ASC, created_at ASC, user_id ASC`,
    [ids],
  )
  for (const row of result.rows) {
    const groupId = typeof row.group_id === 'string' ? row.group_id.trim() : ''
    const userId = typeof row.user_id === 'string' ? row.user_id.trim() : ''
    if (!groupId || !userId) continue
    if (!snapshot[groupId]) snapshot[groupId] = []
    snapshot[groupId].push(userId)
  }
  return snapshot
}

/**
 * Lock-1 §K1 / OD-L1-2(a) — the CURATED PATH: the only sanctioned way to add/remove an
 * `(org_id, group_id)` binding row. Mirrors the shipped
 * `delegated_role_scope_template_member_groups` assign/unassign admin pattern
 * (`routes/admin-users.ts` scope-templates member-groups action route) — idempotent (`ON CONFLICT
 * DO NOTHING` / plain `DELETE`), no read-modify-write race. Callers (routes) are responsible for
 * verifying `groupId` resolves to a real `platform_member_groups` row before calling `bind` (a
 * dangling FK would otherwise surface as a raw constraint-violation 500 instead of a clean 404).
 */
export async function bindApprovalUsableMemberGroup(
  orgId: string,
  groupId: string,
  createdBy: string | null,
): Promise<void> {
  await query(
    `INSERT INTO approval_usable_member_groups (org_id, group_id, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id, group_id) DO NOTHING`,
    [orgId, groupId, createdBy],
  )
}

export async function unbindApprovalUsableMemberGroup(orgId: string, groupId: string): Promise<void> {
  await query(
    `DELETE FROM approval_usable_member_groups WHERE org_id = $1 AND group_id = $2`,
    [orgId, groupId],
  )
}

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
