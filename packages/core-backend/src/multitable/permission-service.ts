/**
 * Multitable permission-service (M4).
 *
 * Consolidates permission resolution, scope loading, and row-action derivation
 * that used to live inline in `packages/core-backend/src/routes/univer-meta.ts`.
 *
 * Complements (does not replace):
 *   - `./access.ts` — token/session-level request access resolution and base
 *     capability derivation.
 *   - `./sheet-capabilities.ts` — user-id keyed sheet capability resolution
 *     used by the Yjs bridge and API-token route.
 *   - `./permission-derivation.ts` — pure field/view/record permission
 *     derivation from capabilities + scope maps.
 *
 * This module provides the Express-request / route-specific seam:
 * - sheet permission enumeration (entries, candidates, DingTalk enrichment)
 * - view / field / record scope loaders
 * - capability origin derivation
 * - scope-aware capability compositions (including the stricter
 *   `applySheetPermissionScope` used by list / read projections)
 * - row-action helpers (`deriveDefaultRowActions`, `deriveRecordRowActions`,
 *   `buildRowActionOverrides`, `ensureRecordWriteAllowed`)
 * - request-keyed resolvers: `resolveSheetCapabilities`,
 *   `resolveSheetReadableCapabilities`, `resolveReadableSheetIds`,
 *   `filterReadableSheetRowsForAccess`
 */

import type { Request } from 'express'

import {
  deriveCapabilities,
  deriveRowActions,
  hasPermission,
  normalizePermissionCodes,
  resolveRequestAccess,
  type MultitableCapabilities,
  type MultitableRowActions,
  type ResolvedRequestAccess,
} from './access'
import {
  deriveRecordPermissions,
  type FieldPermissionScope,
  type RecordPermissionScope,
  type ViewPermissionScope,
} from './permission-derivation'
import { filterPermissionCodesByNamespaceAdmission } from '../rbac/namespace-admission'

export { deriveRowActions, type MultitableRowActions } from './access'

export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

// ── Permission-code constants (sheet scope) ─────────────────────────────────

export const SHEET_READ_PERMISSION_CODES = new Set([
  'spreadsheet:read',
  'spreadsheet:write',
  'spreadsheet:write-own',
  'spreadsheet:admin',
  'spreadsheets:read',
  'spreadsheets:write',
  'spreadsheets:write-own',
  'spreadsheets:admin',
  'multitable:read',
  'multitable:write',
  'multitable:write-own',
  'multitable:admin',
])

export const SHEET_WRITE_PERMISSION_CODES = new Set([
  'spreadsheet:write',
  'spreadsheet:admin',
  'spreadsheets:write',
  'spreadsheets:admin',
  'multitable:write',
  'multitable:admin',
])

export const SHEET_OWN_WRITE_PERMISSION_CODES = new Set([
  'spreadsheet:write-own',
  'spreadsheets:write-own',
  'multitable:write-own',
])

export const SHEET_ADMIN_PERMISSION_CODES = new Set([
  'spreadsheet:admin',
  'spreadsheets:admin',
  'multitable:admin',
])

export const MANAGED_SHEET_PERMISSION_CODES = [
  'spreadsheet:read',
  'spreadsheet:write',
  'spreadsheet:write-own',
  'spreadsheet:admin',
  'spreadsheets:read',
  'spreadsheets:write',
  'spreadsheets:write-own',
  'spreadsheets:admin',
  'multitable:read',
  'multitable:write',
  'multitable:write-own',
  'multitable:admin',
]

// ── Permission-code constants (BASE scope — ②a 2a.1 primitive) ──────────────
//
// Base-level governance codes, a DISTINCT scope from the sheet-level codes above (kept in their own
// Sets — folding them into SHEET_READ_* would be semantically wrong). They name the kernel-internal
// authority to read / administer a whole multitable base. This is the THIN scaffold ②b will build on
// (an opt-in cross-base READ path); central RBAC / auth are untouched. `multitable:base:admin` implies
// read. The §2a.2 wall does NOT consult these (it compares two base_id strings only).
export const BASE_READ_PERMISSION_CODES = new Set([
  'multitable:base:read',
  'multitable:base:admin',
  // a multitable admin implicitly governs every base
  'multitable:admin',
])

export const BASE_ADMIN_PERMISSION_CODES = new Set([
  'multitable:base:admin',
  'multitable:admin',
])

// ②b automation slice — base-level WRITE authority. Phase C3 (2026-06-14) realizes the finer
// `multitable:base:write` tier the earlier slice deferred. The write code-set is now a DISTINCT
// Set that is a strict superset of `BASE_ADMIN_PERMISSION_CODES`: `base:write` grants
// write-not-admin, while `base:admin` / `multitable:admin` continue to IMPLY write. The split is
// MONOTONE + ADDITIVE — no existing code-holder loses or gains authority; the only change is that a
// new, lower-privilege write door opens. `BASE_ADMIN_PERMISSION_CODES` is no longer aliased, so a
// future admin-only gate that consults it will correctly reject a write-only holder. Like the read
// codes, the §2a.2 wall does NOT consult these (it compares two base_id strings only).
export const BASE_WRITE_PERMISSION_CODES = new Set([
  'multitable:base:write',
  ...BASE_ADMIN_PERMISSION_CODES,
])

// ── Types ───────────────────────────────────────────────────────────────────

export type MultitableSheetPermissionSubjectType = 'user' | 'role' | 'member-group'
export type MultitableSheetAccessLevel = 'read' | 'write' | 'write-own' | 'admin'

export const CANONICAL_SHEET_PERMISSION_CODE_BY_ACCESS_LEVEL: Record<
  MultitableSheetAccessLevel,
  string
> = {
  read: 'spreadsheet:read',
  write: 'spreadsheet:write',
  'write-own': 'spreadsheet:write-own',
  admin: 'spreadsheet:admin',
}

export type SheetPermissionScope = {
  hasAssignments: boolean
  canRead: boolean
  canWrite: boolean
  canWriteOwn: boolean
  canAdmin: boolean
}

export type MultitableSheetPermissionEntry = {
  subjectType: MultitableSheetPermissionSubjectType
  subjectId: string
  accessLevel: MultitableSheetAccessLevel
  permissions: string[]
  label: string
  subtitle: string | null
  isActive: boolean
}

export type MultitableSheetPermissionCandidate = {
  subjectType: MultitableSheetPermissionSubjectType
  subjectId: string
  label: string
  subtitle: string | null
  isActive: boolean
  accessLevel: MultitableSheetAccessLevel | null
  dingtalkBound?: boolean | null
  dingtalkGrantEnabled?: boolean | null
  dingtalkPersonDeliveryAvailable?: boolean | null
}

export type MultitableCapabilityOrigin = {
  source: 'admin' | 'global-rbac' | 'sheet-grant' | 'sheet-scope'
  hasSheetAssignments: boolean
}

export const PUBLIC_FORM_CAPABILITIES: MultitableCapabilities = {
  canRead: true,
  canCreateRecord: true,
  canEditRecord: false,
  canDeleteRecord: false,
  canManageFields: false,
  canManageSheetAccess: false,
  canManageViews: false,
  canComment: false,
  canManageAutomation: false,
  canExport: false,
  // Anonymous public-form submitter must NEVER be able to send notifications.
  canSendNotification: false,
}

// ── Internal helpers ────────────────────────────────────────────────────────

function isUndefinedTableError(err: unknown, tableName: string): boolean {
  const code = typeof (err as any)?.code === 'string' ? (err as any).code : null
  const msg = typeof (err as any)?.message === 'string' ? (err as any).message : ''
  if (code === '42P01') return msg.includes(tableName)
  return msg.includes(`relation "${tableName}" does not exist`)
}

export function isSheetPermissionSubjectType(
  value: unknown,
): value is MultitableSheetPermissionSubjectType {
  return value === 'user' || value === 'role' || value === 'member-group'
}

async function loadCandidateUserEligibilityMap(
  query: QueryFn,
  userIds: string[],
): Promise<Map<string, boolean>> {
  const uniqueUserIds = Array.from(new Set(userIds.map((id) => id.trim()).filter(Boolean)))
  const eligibility = new Map<string, boolean>(uniqueUserIds.map((id) => [id, false]))
  if (uniqueUserIds.length === 0) return eligibility

  try {
    const permissionResult = await query(
      `SELECT user_id, permission_code
       FROM (
         SELECT up.user_id, up.permission_code
         FROM user_permissions up
         WHERE up.user_id = ANY($1::text[])
         UNION ALL
         SELECT ur.user_id, rp.permission_code
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = ANY($1::text[])
       ) permissions`,
      [uniqueUserIds],
    )
    for (const row of permissionResult.rows as Array<{ user_id?: string | null; permission_code?: string | null }>) {
      const userId = typeof row.user_id === 'string' ? row.user_id : ''
      if (!userId) continue
      const permissions = normalizePermissionCodes([row.permission_code ?? ''])
      if (hasPermission(permissions, 'multitable:read') || hasPermission(permissions, 'multitable:write')) {
        eligibility.set(userId, true)
      }
    }
  } catch (err) {
    if (
      !isUndefinedTableError(err, 'user_permissions')
      && !isUndefinedTableError(err, 'user_roles')
      && !isUndefinedTableError(err, 'role_permissions')
    ) {
      throw err
    }
  }

  try {
    const adminResult = await query(
      `SELECT user_id
       FROM user_roles
       WHERE user_id = ANY($1::text[])
         AND role_id = $2`,
      [uniqueUserIds, 'admin'],
    )
    for (const row of adminResult.rows as Array<{ user_id?: string | null }>) {
      const userId = typeof row.user_id === 'string' ? row.user_id : ''
      if (userId) eligibility.set(userId, true)
    }
  } catch (err) {
    if (!isUndefinedTableError(err, 'user_roles')) throw err
  }

  const legacyResult = await query(
    `SELECT id, permissions
     FROM users
     WHERE id = ANY($1::text[])`,
    [uniqueUserIds],
  )
  for (const row of legacyResult.rows as Array<{ id?: string | null; permissions?: unknown }>) {
    const userId = typeof row.id === 'string' ? row.id : ''
    if (!userId) continue
    const legacyPermissions = Array.isArray(row.permissions) ? normalizePermissionCodes(row.permissions) : []
    if (hasPermission(legacyPermissions, 'multitable:read') || hasPermission(legacyPermissions, 'multitable:write')) {
      eligibility.set(userId, true)
    }
  }

  return eligibility
}

export function summarizeSheetPermissionCodes(codes: string[]): SheetPermissionScope {
  return {
    hasAssignments: codes.length > 0,
    canRead: codes.some((code) => SHEET_READ_PERMISSION_CODES.has(code)),
    canWrite: codes.some((code) => SHEET_WRITE_PERMISSION_CODES.has(code)),
    canWriteOwn: codes.some((code) => SHEET_OWN_WRITE_PERMISSION_CODES.has(code)),
    canAdmin: codes.some((code) => SHEET_ADMIN_PERMISSION_CODES.has(code)),
  }
}

export function deriveSheetAccessLevel(codes: string[]): MultitableSheetAccessLevel | null {
  const normalized = normalizePermissionCodes(codes)
  if (normalized.some((code) => SHEET_ADMIN_PERMISSION_CODES.has(code))) return 'admin'
  if (normalized.some((code) => SHEET_WRITE_PERMISSION_CODES.has(code))) return 'write'
  if (normalized.some((code) => SHEET_OWN_WRITE_PERMISSION_CODES.has(code))) return 'write-own'
  if (normalized.some((code) => SHEET_READ_PERMISSION_CODES.has(code))) return 'read'
  return null
}

// ── Sheet permission enumeration ────────────────────────────────────────────

export async function listSheetPermissionEntries(
  query: QueryFn,
  sheetId: string,
): Promise<MultitableSheetPermissionEntry[]> {
  const result = await query(
    `SELECT
        sp.subject_type,
        sp.subject_id,
        ARRAY_AGG(sp.perm_code ORDER BY sp.perm_code) AS permission_codes,
        u.name AS user_name,
        u.email AS user_email,
        u.is_active AS user_is_active,
        r.name AS role_name,
        g.name AS group_name,
        g.description AS group_description
     FROM spreadsheet_permissions sp
     LEFT JOIN users u
       ON sp.subject_type = 'user'
      AND u.id = sp.subject_id
     LEFT JOIN roles r
       ON sp.subject_type = 'role'
      AND r.id = sp.subject_id
     LEFT JOIN platform_member_groups g
       ON sp.subject_type = 'member-group'
      AND g.id::text = sp.subject_id
     WHERE sp.sheet_id = $1
     GROUP BY sp.subject_type, sp.subject_id, u.name, u.email, u.is_active, r.name, g.name, g.description
     ORDER BY
       CASE
         WHEN sp.subject_type = 'user' THEN 0
         WHEN sp.subject_type = 'member-group' THEN 1
         ELSE 2
       END,
       CASE WHEN sp.subject_type = 'user' AND COALESCE(u.is_active, true) THEN 0 WHEN sp.subject_type = 'user' THEN 1 ELSE 0 END,
       COALESCE(NULLIF(u.name, ''), NULLIF(u.email, ''), NULLIF(g.name, ''), NULLIF(r.name, ''), sp.subject_id) ASC`,
    [sheetId],
  )

  return (result.rows as Array<{
    subject_type: string
    subject_id: string
    permission_codes?: string[]
    user_name?: string | null
    user_email?: string | null
    user_is_active?: boolean | null
    role_name?: string | null
    group_name?: string | null
    group_description?: string | null
  }>)
    .map((row) => {
      const subjectType = isSheetPermissionSubjectType(row.subject_type) ? row.subject_type : 'user'
      const subjectId = String(row.subject_id)
      const permissions = normalizePermissionCodes(row.permission_codes)
      const accessLevel = deriveSheetAccessLevel(permissions)
      if (!accessLevel) return null
      const userName = typeof row.user_name === 'string' ? row.user_name.trim() : ''
      const userEmail = typeof row.user_email === 'string' ? row.user_email.trim() : ''
      const roleName = typeof row.role_name === 'string' ? row.role_name.trim() : ''
      const groupName = typeof row.group_name === 'string' ? row.group_name.trim() : ''
      const groupDescription = typeof row.group_description === 'string' ? row.group_description.trim() : ''
      return {
        subjectType,
        subjectId,
        accessLevel,
        permissions,
        label:
          subjectType === 'user'
            ? (userName || userEmail || subjectId)
            : subjectType === 'member-group'
              ? (groupName || subjectId)
              : (roleName || subjectId),
        subtitle:
          subjectType === 'user'
            ? (userEmail || (userName && userName !== subjectId ? subjectId : null))
            : subjectType === 'member-group'
              ? (groupDescription || (groupName && groupName !== subjectId ? subjectId : 'Member group'))
              : (roleName && roleName !== subjectId ? subjectId : 'Role'),
        isActive: subjectType === 'user' ? row.user_is_active !== false : true,
      } satisfies MultitableSheetPermissionEntry
    })
    .filter((entry): entry is MultitableSheetPermissionEntry => !!entry)
}

export async function listSheetPermissionCandidates(
  query: QueryFn,
  sheetId: string,
  params: { q?: string; limit: number },
): Promise<MultitableSheetPermissionCandidate[]> {
  const q = params.q?.trim() ?? ''
  const term = q ? `%${q}%` : '%'
  const result = await query(
    `WITH user_candidates AS (
        SELECT
          'user'::text AS subject_type,
          u.id AS subject_id,
          u.name AS user_name,
          u.email AS user_email,
          u.is_active AS user_is_active,
          NULL::text AS role_name,
          NULL::text AS group_name,
          NULL::text AS group_description,
          NULL::integer AS member_count,
          COALESCE(
            ARRAY_AGG(sp.perm_code ORDER BY sp.perm_code) FILTER (WHERE sp.perm_code IS NOT NULL),
            ARRAY[]::text[]
          ) AS permission_codes
        FROM users u
        LEFT JOIN spreadsheet_permissions sp
          ON sp.sheet_id = $1
         AND sp.subject_type = 'user'
         AND sp.subject_id = u.id
        WHERE ($2 = '' OR u.id ILIKE $3 OR u.email ILIKE $3 OR COALESCE(u.name, '') ILIKE $3)
        GROUP BY u.id, u.name, u.email, u.is_active
      ),
      member_group_candidates AS (
        SELECT
          'member-group'::text AS subject_type,
          g.id::text AS subject_id,
          NULL::text AS user_name,
          NULL::text AS user_email,
          true AS user_is_active,
          NULL::text AS role_name,
          g.name AS group_name,
          g.description AS group_description,
          COUNT(gm.user_id)::integer AS member_count,
          COALESCE(
            ARRAY_AGG(sp.perm_code ORDER BY sp.perm_code) FILTER (WHERE sp.perm_code IS NOT NULL),
            ARRAY[]::text[]
          ) AS permission_codes
        FROM platform_member_groups g
        LEFT JOIN platform_member_group_members gm
          ON gm.group_id = g.id
        LEFT JOIN spreadsheet_permissions sp
          ON sp.sheet_id = $1
         AND sp.subject_type = 'member-group'
         AND sp.subject_id = g.id::text
        WHERE ($2 = '' OR g.id::text ILIKE $3 OR COALESCE(g.name, '') ILIKE $3 OR COALESCE(g.description, '') ILIKE $3)
        GROUP BY g.id, g.name, g.description
      ),
      role_candidates AS (
        SELECT
          'role'::text AS subject_type,
          r.id AS subject_id,
          NULL::text AS user_name,
          NULL::text AS user_email,
          true AS user_is_active,
          r.name AS role_name,
          NULL::text AS group_name,
          NULL::text AS group_description,
          NULL::integer AS member_count,
          COALESCE(
            ARRAY_AGG(sp.perm_code ORDER BY sp.perm_code) FILTER (WHERE sp.perm_code IS NOT NULL),
            ARRAY[]::text[]
          ) AS permission_codes
        FROM roles r
        LEFT JOIN spreadsheet_permissions sp
          ON sp.sheet_id = $1
         AND sp.subject_type = 'role'
         AND sp.subject_id = r.id
        WHERE ($2 = '' OR r.id ILIKE $3 OR COALESCE(r.name, '') ILIKE $3)
        GROUP BY r.id, r.name
      )
      SELECT *
      FROM (
        SELECT * FROM user_candidates
        UNION ALL
        SELECT * FROM member_group_candidates
        UNION ALL
        SELECT * FROM role_candidates
      ) candidates
      ORDER BY
        CASE
          WHEN subject_type = 'user' THEN 0
          WHEN subject_type = 'member-group' THEN 1
          ELSE 2
        END,
        CASE WHEN user_is_active THEN 0 ELSE 1 END,
        COALESCE(NULLIF(user_name, ''), NULLIF(user_email, ''), NULLIF(group_name, ''), NULLIF(role_name, ''), subject_id) ASC
      LIMIT $4`,
    [sheetId, q, term, params.limit],
  )

  const candidates = (result.rows as Array<{
    subject_type: string
    subject_id: string
    user_name?: string | null
    user_email?: string | null
    user_is_active?: boolean | null
    role_name?: string | null
    group_name?: string | null
    group_description?: string | null
    member_count?: number | null
    permission_codes?: string[]
  }>)
    .map((row) => {
      const subjectType = isSheetPermissionSubjectType(row.subject_type) ? row.subject_type : 'user'
      const subjectId = String(row.subject_id)
      const name = typeof row.user_name === 'string' ? row.user_name.trim() : ''
      const email = typeof row.user_email === 'string' ? row.user_email.trim() : ''
      const roleName = typeof row.role_name === 'string' ? row.role_name.trim() : ''
      const groupName = typeof row.group_name === 'string' ? row.group_name.trim() : ''
      const groupDescription = typeof row.group_description === 'string' ? row.group_description.trim() : ''
      const memberCount = typeof row.member_count === 'number' ? row.member_count : null
      return {
        subjectType,
        subjectId,
        label:
          subjectType === 'user'
            ? (name || email || subjectId)
            : subjectType === 'member-group'
              ? (groupName || subjectId)
              : (roleName || subjectId),
        subtitle:
          subjectType === 'user'
            ? (email || (name && name !== subjectId ? subjectId : null))
            : subjectType === 'member-group'
              ? (groupDescription || (memberCount != null ? `${memberCount} member${memberCount === 1 ? '' : 's'}` : 'Member group'))
              : (roleName && roleName !== subjectId ? subjectId : 'Role'),
        isActive: subjectType === 'user' ? row.user_is_active !== false : true,
        accessLevel: deriveSheetAccessLevel(normalizePermissionCodes(row.permission_codes)),
      } satisfies MultitableSheetPermissionCandidate
    })

  const roleIds = Array.from(new Set(
    candidates
      .filter((candidate) => candidate.subjectType === 'role' && candidate.subjectId !== 'admin')
      .map((candidate) => candidate.subjectId),
  ))
  const rolePermissionsById = new Map<string, string[]>()
  if (roleIds.length > 0) {
    const result = await query(
      'SELECT role_id, permission_code FROM role_permissions WHERE role_id = ANY($1::text[])',
      [roleIds],
    )
    for (const row of result.rows as Array<{ role_id?: string | null; permission_code?: string | null }>) {
      const roleId = typeof row.role_id === 'string' ? row.role_id : ''
      if (!roleId) continue
      const permissions = rolePermissionsById.get(roleId) ?? []
      if (typeof row.permission_code === 'string') permissions.push(row.permission_code)
      rolePermissionsById.set(roleId, permissions)
    }
  }
  const userEligibility = await loadCandidateUserEligibilityMap(
    query,
    candidates
      .filter((candidate) => candidate.subjectType === 'user')
      .map((candidate) => candidate.subjectId),
  )

  const eligibility = await Promise.all(
    candidates.map((candidate) => {
      if (candidate.subjectType === 'member-group') return true
      if (candidate.subjectType === 'role') {
        if (candidate.subjectId === 'admin') return true
        const permissions = normalizePermissionCodes(rolePermissionsById.get(candidate.subjectId) ?? [])
        return hasPermission(permissions, 'multitable:read') || hasPermission(permissions, 'multitable:write')
      }
      return userEligibility.get(candidate.subjectId) === true
    }),
  )

  return candidates.filter((_candidate, index) => eligibility[index])
}

/**
 * Native person field (design 2026-06-16) member boundary.
 *
 * Returns the flat set of `userId`s that are valid members of `sheetId` — i.e. EXACTLY
 * the active users {@link listSheetPermissionCandidates} offers as selectable people
 * (the same eligibility filter: active + multitable read/write or admin). Reusing the
 * candidate resolver here is load-bearing: the person PICKER and the person write-time
 * VALIDATOR must accept/reject the identical set, or a user could pick someone the
 * validator rejects (advisor §4 — single resolver, no drift).
 *
 * Resolved ONCE per request batch by record writers (parallel to the link-target-exists
 * loop). The same boundary control is what the notify recipient dispatch reuses, so a
 * person cell and a notify recipient share one membership set.
 */
export async function loadSheetMemberUserIdSet(
  query: QueryFn,
  sheetId: string,
): Promise<Set<string>> {
  // Bounded but generous; person fields validate against the full eligible-member roster.
  const candidates = await listSheetPermissionCandidates(query, sheetId, { limit: 10000 })
  const members = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.subjectType !== 'user') continue
    if (!candidate.isActive) continue
    const id = candidate.subjectId.trim()
    if (id) members.add(id)
  }
  return members
}

/**
 * P1 (native person `restrictToMemberGroupIds` enforcement, design 2026-06-17): resolve the
 * union of ACTIVE member-group members' userIds for the given member-group ids. Used to NARROW
 * a person field's assignable set (sheet membership ∩ this set) when the field configures
 * `restrictToMemberGroupIds`. Empty / unknown groups → empty set (a closed narrowing — all
 * assignments rejected, consistent with validatePersonValue's "null set = closed" rule).
 * Mirrors the member-group resolution used by the automation recipient path.
 */
export async function loadMemberGroupUserIdSet(
  query: QueryFn,
  groupIds: string[],
): Promise<Set<string>> {
  const ids = Array.from(new Set(groupIds.map((g) => (typeof g === 'string' ? g.trim() : '')).filter(Boolean)))
  if (ids.length === 0) return new Set<string>()
  const res = await query(
    `SELECT DISTINCT gm.user_id::text AS user_id
       FROM platform_member_group_members gm
       JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id::text = ANY($1::text[])
        AND u.is_active = TRUE`,
    [ids],
  )
  const members = new Set<string>()
  for (const row of res.rows as Array<Record<string, unknown>>) {
    const id = typeof row.user_id === 'string' ? row.user_id.trim() : ''
    if (id) members.add(id)
  }
  return members
}

export async function enrichFormShareCandidatesWithDingTalkStatus(
  query: QueryFn,
  candidates: MultitableSheetPermissionCandidate[],
): Promise<MultitableSheetPermissionCandidate[]> {
  const userIds = Array.from(new Set(
    candidates
      .filter((candidate) => candidate.subjectType === 'user')
      .map((candidate) => candidate.subjectId.trim())
      .filter((subjectId) => subjectId.length > 0),
  ))
  if (userIds.length === 0) {
    return candidates.map((candidate) => candidate.subjectType === 'member-group'
      ? {
        ...candidate,
        dingtalkBound: null,
        dingtalkGrantEnabled: null,
        dingtalkPersonDeliveryAvailable: null,
      }
      : candidate)
  }

  const [identityResult, deliveryResult, grantResult] = await Promise.all([
    query(
      `SELECT DISTINCT local_user_id
       FROM user_external_identities
       WHERE local_user_id = ANY($1::text[])
         AND provider = $2`,
      [userIds, 'dingtalk'],
    ),
    query(
      `SELECT DISTINCT l.local_user_id
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
       WHERE l.local_user_id = ANY($1::text[])
         AND l.link_status = 'linked'
         AND a.provider = $2
         AND a.is_active = TRUE
         AND COALESCE(a.external_user_id, '') <> ''`,
      [userIds, 'dingtalk'],
    ),
    query(
      `SELECT local_user_id, BOOL_OR(enabled) AS enabled
       FROM user_external_auth_grants
       WHERE local_user_id = ANY($1::text[])
         AND provider = $2
       GROUP BY local_user_id`,
      [userIds, 'dingtalk'],
    ),
  ])

  const identityUserIds = new Set(
    (identityResult.rows as Array<{ local_user_id?: string | null }>)
      .map((row) => (typeof row.local_user_id === 'string' ? row.local_user_id.trim() : ''))
      .filter((localUserId) => localUserId.length > 0),
  )
  const deliveryUserIds = new Set(
    (deliveryResult.rows as Array<{ local_user_id?: string | null }>)
      .map((row) => (typeof row.local_user_id === 'string' ? row.local_user_id.trim() : ''))
      .filter((localUserId) => localUserId.length > 0),
  )
  const grantEnabledByUserId = new Map(
    (grantResult.rows as Array<{ local_user_id?: string | null; enabled?: boolean | null }>)
      .map((row) => [
        typeof row.local_user_id === 'string' ? row.local_user_id.trim() : '',
        row.enabled === true,
      ] as const)
      .filter(([localUserId]) => localUserId.length > 0),
  )

  return candidates.map((candidate) => {
    if (candidate.subjectType === 'member-group') {
      return {
        ...candidate,
        dingtalkBound: null,
        dingtalkGrantEnabled: null,
        dingtalkPersonDeliveryAvailable: null,
      }
    }
    if (candidate.subjectType !== 'user') return candidate
    const dingtalkPersonDeliveryAvailable = deliveryUserIds.has(candidate.subjectId)
    return {
      ...candidate,
      dingtalkBound: dingtalkPersonDeliveryAvailable || identityUserIds.has(candidate.subjectId),
      dingtalkGrantEnabled: grantEnabledByUserId.get(candidate.subjectId) === true,
      dingtalkPersonDeliveryAvailable,
    }
  })
}

// ── Scope map loaders ───────────────────────────────────────────────────────

export async function loadSheetPermissionScopeMap(
  query: QueryFn,
  sheetIds: string[],
  userId: string,
): Promise<Map<string, SheetPermissionScope>> {
  if (!userId || sheetIds.length === 0) return new Map()
  try {
    const result = await query(
      `SELECT sp.sheet_id, sp.perm_code, sp.subject_type
       FROM spreadsheet_permissions sp
       WHERE sp.sheet_id = ANY($2::text[])
         AND (
           (sp.subject_type = 'user' AND sp.subject_id = $1)
           OR (
             sp.subject_type = 'member-group'
             AND EXISTS (
               SELECT 1
               FROM platform_member_group_members pgm
               WHERE pgm.user_id = $1
                 AND pgm.group_id::text = sp.subject_id
             )
           )
           OR (
             sp.subject_type = 'role'
             AND EXISTS (
               SELECT 1
               FROM user_roles ur
               WHERE ur.user_id = $1
                 AND ur.role_id = sp.subject_id
             )
           )
         )`,
      [userId, sheetIds],
    )
    const grouped = new Map<string, { direct: string[]; memberGroup: string[]; role: string[] }>()
    for (const row of result.rows as Array<{ sheet_id: string; perm_code: string; subject_type?: string }>) {
      const sheetId = typeof row.sheet_id === 'string' ? row.sheet_id : ''
      const code = typeof row.perm_code === 'string' ? row.perm_code.trim() : ''
      if (!sheetId || !code) continue
      const current = grouped.get(sheetId) ?? { direct: [], memberGroup: [], role: [] }
      if (row.subject_type === 'user') current.direct.push(code)
      else if (row.subject_type === 'member-group') current.memberGroup.push(code)
      else current.role.push(code)
      grouped.set(sheetId, current)
    }
    return new Map(
      Array.from(grouped.entries()).map(([sheetId, codes]) => [
        sheetId,
        summarizeSheetPermissionCodes(
          codes.direct.length > 0 ? codes.direct
            : codes.memberGroup.length > 0 ? codes.memberGroup
              : codes.role,
        ),
      ]),
    )
  } catch (err) {
    if (
      isUndefinedTableError(err, 'spreadsheet_permissions')
      || isUndefinedTableError(err, 'user_roles')
      || isUndefinedTableError(err, 'platform_member_group_members')
    ) return new Map()
    throw err
  }
}

export async function loadViewPermissionScopeMap(
  query: QueryFn,
  viewIds: string[],
  userId: string,
): Promise<Map<string, ViewPermissionScope>> {
  if (!userId || viewIds.length === 0) return new Map()
  try {
    const result = await query(
      `WITH assigned_views AS (
         SELECT DISTINCT vp.view_id
         FROM meta_view_permissions vp
         WHERE vp.view_id = ANY($2::text[])
       ),
       effective_permissions AS (
         SELECT vp.view_id, vp.permission
         FROM meta_view_permissions vp
         WHERE vp.view_id = ANY($2::text[])
           AND (
             (vp.subject_type = 'user' AND vp.subject_id = $1)
             OR (
               vp.subject_type = 'member-group'
               AND EXISTS (
                 SELECT 1 FROM platform_member_group_members pgm
                 WHERE pgm.user_id = $1 AND pgm.group_id::text = vp.subject_id
               )
             )
             OR (
               vp.subject_type = 'role'
               AND EXISTS (
                 SELECT 1 FROM user_roles ur
                 WHERE ur.user_id = $1 AND ur.role_id = vp.subject_id
               )
             )
           )
       )
       SELECT av.view_id,
              COALESCE(
                array_agg(DISTINCT ep.permission) FILTER (WHERE ep.permission IS NOT NULL),
                ARRAY[]::text[]
              ) AS permissions
       FROM assigned_views av
       LEFT JOIN effective_permissions ep ON ep.view_id = av.view_id
       GROUP BY av.view_id`,
      [userId, viewIds],
    )
    return new Map(
      (result.rows as Array<{ view_id: string; permissions: string[] | null }>).flatMap((row) => {
        const viewId = typeof row.view_id === 'string' ? row.view_id : ''
        if (!viewId) return []
        const perms = Array.isArray(row.permissions)
          ? row.permissions.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean)
          : []
        return [[
          viewId,
          {
            hasAssignments: true,
            canRead: perms.includes('read') || perms.includes('write') || perms.includes('admin'),
            canWrite: perms.includes('write') || perms.includes('admin'),
            canAdmin: perms.includes('admin'),
          },
        ] as const]
      }),
    )
  } catch (err) {
    if (
      isUndefinedTableError(err, 'meta_view_permissions')
      || isUndefinedTableError(err, 'user_roles')
      || isUndefinedTableError(err, 'platform_member_group_members')
    ) return new Map()
    throw err
  }
}

export async function loadFieldPermissionScopeMap(
  query: QueryFn,
  sheetId: string,
  userId: string,
): Promise<Map<string, FieldPermissionScope>> {
  if (!userId || !sheetId) return new Map()
  try {
    const result = await query(
      `SELECT fp.field_id, fp.visible, fp.read_only
       FROM field_permissions fp
       WHERE fp.sheet_id = $2
         AND (
           (fp.subject_type = 'user' AND fp.subject_id = $1)
           OR (
             fp.subject_type = 'member-group'
             AND EXISTS (
               SELECT 1 FROM platform_member_group_members pgm
               WHERE pgm.user_id = $1 AND pgm.group_id::text = fp.subject_id
             )
           )
           OR (
             fp.subject_type = 'role'
             AND EXISTS (
               SELECT 1 FROM user_roles ur
               WHERE ur.user_id = $1 AND ur.role_id = fp.subject_id
             )
           )
         )`,
      [userId, sheetId],
    )
    const scopes = new Map<string, FieldPermissionScope>()
    for (const row of result.rows as Array<{ field_id: string; visible: boolean; read_only: boolean }>) {
      const fieldId = typeof row.field_id === 'string' ? row.field_id : ''
      if (!fieldId) continue
      const existing = scopes.get(fieldId)
      if (existing) {
        existing.visible = existing.visible && row.visible !== false
        existing.readOnly = existing.readOnly || row.read_only === true
      } else {
        scopes.set(fieldId, {
          visible: row.visible !== false,
          readOnly: row.read_only === true,
        })
      }
    }
    return scopes
  } catch (err) {
    if (
      isUndefinedTableError(err, 'field_permissions')
      || isUndefinedTableError(err, 'user_roles')
      || isUndefinedTableError(err, 'platform_member_group_members')
    ) return new Map()
    throw err
  }
}

/**
 * #18 read-deny: the per-sheet opt-in flag. When true, a 'none' record_permission DENIES read on its
 * record. Default-off → the deny is inert and the read model stays grant-additive (#2787).
 */
export async function loadRowLevelReadDenyEnabled(query: QueryFn, sheetId: string): Promise<boolean> {
  if (!sheetId) return false
  try {
    const r = await query('SELECT row_level_read_permissions_enabled AS enabled FROM meta_sheets WHERE id = $1', [sheetId])
    return (r.rows[0] as { enabled?: boolean } | undefined)?.enabled === true
  } catch {
    return false
  }
}

export async function loadRecordPermissionScopeMap(
  query: QueryFn,
  sheetId: string,
  recordIds: string[],
  userId: string,
): Promise<Map<string, RecordPermissionScope>> {
  if (!userId || !sheetId || recordIds.length === 0) return new Map()
  try {
    const result = await query(
      `SELECT rp.record_id, rp.access_level
       FROM record_permissions rp
       WHERE rp.sheet_id = $2
         AND rp.record_id = ANY($3::text[])
         AND (
           (rp.subject_type = 'user' AND rp.subject_id = $1)
           OR (
             rp.subject_type = 'member-group'
             AND EXISTS (
               SELECT 1 FROM platform_member_group_members pgm
               WHERE pgm.user_id = $1 AND pgm.group_id::text = rp.subject_id
             )
           )
           OR (
             rp.subject_type = 'role'
             AND EXISTS (
               SELECT 1 FROM user_roles ur
               WHERE ur.user_id = $1 AND ur.role_id = rp.subject_id
             )
           )
         )`,
      [userId, sheetId, recordIds],
    )
    const scopes = new Map<string, RecordPermissionScope>()
    for (const row of result.rows as Array<{ record_id: string; access_level: string }>) {
      const recordId = typeof row.record_id === 'string' ? row.record_id : ''
      if (!recordId) continue
      const existing = scopes.get(recordId)
      const raw = row.access_level
      // #18 read-deny FOUNDATION: 'none' is now a valid level. Defensive narrow (DB-constrained anyway).
      const level: 'read' | 'write' | 'admin' | 'none' =
        raw === 'none' || raw === 'write' || raw === 'admin' ? raw : 'read'
      if (existing) {
        // DENY-WINS: a 'none' read-deny is the most restrictive and overrides grants via other subjects
        // (a deny cannot be bypassed by group/role membership). Otherwise max of read<write<admin.
        const rank = { read: 0, write: 1, admin: 2, none: 3 } as const
        if (rank[level] > rank[existing.accessLevel]) {
          existing.accessLevel = level
        }
      } else {
        scopes.set(recordId, { recordId, accessLevel: level })
      }
    }
    return scopes
  } catch (err) {
    if (
      isUndefinedTableError(err, 'record_permissions')
      || isUndefinedTableError(err, 'user_roles')
      || isUndefinedTableError(err, 'platform_member_group_members')
    ) return new Map()
    throw err
  }
}

/**
 * #18 read-deny: the set of record ids in `sheetId` the actor is DENIED read on — i.e. a `'none'`
 * record_permission via any of the actor's subjects (user/member-group/role). Deny-wins: a `'none'`
 * for the actor denies the record regardless of any grant via another subject. The shared exclusion
 * primitive for list/count read surfaces. Caller MUST first gate on `loadRowLevelReadDenyEnabled(sheetId)`
 * AND skip for admins (admins bypass record-level read, mirroring requireRecordReadable) — this returns
 * the raw denied set unconditionally.
 */
export async function loadDeniedRecordIds(query: QueryFn, sheetId: string, userId: string): Promise<Set<string>> {
  if (!userId || !sheetId) return new Set<string>()
  try {
    const result = await query(
      `SELECT DISTINCT rp.record_id
       FROM record_permissions rp
       WHERE rp.sheet_id = $2
         AND rp.access_level = 'none'
         AND (
           (rp.subject_type = 'user' AND rp.subject_id = $1)
           OR (
             rp.subject_type = 'member-group'
             AND EXISTS (
               SELECT 1 FROM platform_member_group_members pgm
               WHERE pgm.user_id = $1 AND pgm.group_id::text = rp.subject_id
             )
           )
           OR (
             rp.subject_type = 'role'
             AND EXISTS (
               SELECT 1 FROM user_roles ur
               WHERE ur.user_id = $1 AND ur.role_id = rp.subject_id
             )
           )
         )`,
      [userId, sheetId],
    )
    const denied = new Set<string>()
    for (const row of result.rows as Array<{ record_id?: unknown }>) {
      if (typeof row.record_id === 'string' && row.record_id) denied.add(row.record_id)
    }
    return denied
  } catch (err) {
    if (
      isUndefinedTableError(err, 'record_permissions')
      || isUndefinedTableError(err, 'user_roles')
      || isUndefinedTableError(err, 'platform_member_group_members')
    ) return new Set<string>()
    throw err
  }
}

export async function hasRecordPermissionAssignments(
  query: QueryFn,
  sheetId: string,
): Promise<boolean> {
  try {
    const result = await query(
      'SELECT 1 FROM record_permissions WHERE sheet_id = $1 LIMIT 1',
      [sheetId],
    )
    return result.rows.length > 0
  } catch (err) {
    if (isUndefinedTableError(err, 'record_permissions')) return false
    throw err
  }
}

export async function loadRecordCreatorMap(
  query: QueryFn,
  sheetId: string,
  recordIds: string[],
): Promise<Map<string, string | null>> {
  if (recordIds.length === 0) return new Map()
  try {
    const result = await query(
      'SELECT id, created_by FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
      [sheetId, recordIds],
    )
    return new Map(
      (result.rows as Array<{ id: string; created_by: string | null }>).map((row) => [
        String(row.id),
        typeof row.created_by === 'string' ? row.created_by : null,
      ]),
    )
  } catch (err) {
    if (err instanceof Error && err.message.includes('column') && err.message.includes('created_by')) {
      return new Map()
    }
    throw err
  }
}

// ── Scope-aware capability compositions ─────────────────────────────────────

export function applySheetPermissionScope(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilities {
  if (isAdminRole) return capabilities
  if (!scope?.hasAssignments) {
    return {
      ...capabilities,
      canManageSheetAccess: capabilities.canManageSheetAccess && capabilities.canRead,
      canExport: capabilities.canExport,
    }
  }
  const canWriteAnyRecord = scope.canWrite || scope.canWriteOwn
  const scopedCanRead = capabilities.canRead && scope.canRead
  return {
    canRead: scopedCanRead,
    canCreateRecord: capabilities.canCreateRecord && canWriteAnyRecord,
    canEditRecord: capabilities.canEditRecord && canWriteAnyRecord,
    canDeleteRecord: capabilities.canDeleteRecord && canWriteAnyRecord,
    canManageFields: capabilities.canManageFields && scope.canWrite,
    canManageSheetAccess: scope.canAdmin,
    canManageViews: capabilities.canManageViews && scope.canWrite,
    canComment: capabilities.canComment && scope.canRead,
    canManageAutomation: capabilities.canManageAutomation && scope.canWrite,
    canExport: scopedCanRead,
    // Notify = full sheet write/admin only (scope.canWrite), NOT write-own: a
    // record-scoped write must not imply notifying members from any row.
    canSendNotification: capabilities.canSendNotification && scope.canWrite,
  }
}

export function canReadWithSheetGrant(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): boolean {
  if (applySheetPermissionScope(capabilities, scope, isAdminRole).canRead) return true
  return !isAdminRole && !capabilities.canRead && scope?.canRead === true
}

export function applyContextSheetReadGrant(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilities {
  const scoped = applySheetPermissionScope(capabilities, scope, isAdminRole)
  if (scoped.canRead || !scope?.canRead || isAdminRole || capabilities.canRead) return scoped
  return {
    ...scoped,
    canRead: true,
  }
}

export function applyContextSheetRecordWriteGrant(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilities {
  const scoped = applyContextSheetReadGrant(capabilities, scope, isAdminRole)
  if (isAdminRole || !scope?.hasAssignments) return scoped
  const canWriteAnyRecord = scope.canRead && (scope.canWrite || scope.canWriteOwn)
  if (!canWriteAnyRecord) return scoped
  return {
    ...scoped,
    canCreateRecord: true,
    canEditRecord: true,
    canDeleteRecord: true,
  }
}

export function applyContextSheetSchemaWriteGrant(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilities {
  const scoped = applyContextSheetRecordWriteGrant(capabilities, scope, isAdminRole)
  if (isAdminRole || !scope?.hasAssignments) return scoped
  const canManageSchema = scope.canRead && scope.canWrite
  if (!canManageSchema) return scoped
  return {
    ...scoped,
    canManageFields: true,
    canManageViews: true,
    // Sheet-scoped FULL write (scope.canRead && scope.canWrite — NOT write-own) also grants
    // the sheet-level notify capability, so a user with a sheet full-write grant but no global
    // multitable:write can still send_notification (parity with canEditRecord/canManageViews).
    canSendNotification: true,
    ...(scope.canAdmin ? { canManageSheetAccess: true } : {}),
  }
}

const MULTITABLE_CAPABILITY_KEYS: Array<keyof MultitableCapabilities> = [
  'canRead',
  'canCreateRecord',
  'canEditRecord',
  'canDeleteRecord',
  'canManageFields',
  'canManageSheetAccess',
  'canManageViews',
  'canComment',
  'canManageAutomation',
  'canSendNotification',
]

export function deriveCapabilityOrigin(
  baseCapabilities: MultitableCapabilities,
  effectiveCapabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilityOrigin {
  const hasSheetAssignments = !!scope?.hasAssignments
  if (isAdminRole) {
    return { source: 'admin', hasSheetAssignments }
  }
  if (!hasSheetAssignments) {
    return { source: 'global-rbac', hasSheetAssignments: false }
  }
  const expandsBaseCapabilities = MULTITABLE_CAPABILITY_KEYS.some(
    (key) => !baseCapabilities[key] && effectiveCapabilities[key],
  )
  return {
    source: expandsBaseCapabilities ? 'sheet-grant' : 'sheet-scope',
    hasSheetAssignments: true,
  }
}

export function requiresOwnWriteRowPolicy(
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): boolean {
  return !isAdminRole && !!scope?.hasAssignments && scope.canWriteOwn && !scope.canWrite
}

export function deriveDefaultRowActions(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableRowActions {
  if (!requiresOwnWriteRowPolicy(scope, isAdminRole)) {
    return deriveRowActions(capabilities)
  }
  return {
    canEdit: false,
    canDelete: false,
    canComment: capabilities.canComment,
  }
}

export function deriveRecordRowActions(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  access: ResolvedRequestAccess,
  createdBy: string | null | undefined,
): MultitableRowActions {
  if (!requiresOwnWriteRowPolicy(scope, access.isAdminRole)) {
    return deriveRowActions(capabilities)
  }

  const isCreator = !!createdBy && !!access.userId && createdBy === access.userId
  return {
    canEdit: capabilities.canEditRecord && isCreator,
    canDelete: capabilities.canDeleteRecord && isCreator,
    canComment: capabilities.canComment,
  }
}

export function buildRowActionOverrides(
  records: Array<{ id: string }>,
  creatorMap: Map<string, string | null>,
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  access: ResolvedRequestAccess,
): Record<string, MultitableRowActions> | undefined {
  if (!requiresOwnWriteRowPolicy(scope, access.isAdminRole)) return undefined
  const overrides: Record<string, MultitableRowActions> = {}
  for (const record of records) {
    const rowActions = deriveRecordRowActions(capabilities, scope, access, creatorMap.get(record.id))
    if (rowActions.canEdit || rowActions.canDelete || rowActions.canComment !== capabilities.canComment) {
      overrides[record.id] = rowActions
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

export function ensureRecordWriteAllowed(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  access: ResolvedRequestAccess,
  createdBy: string | null | undefined,
  action: 'edit' | 'delete',
  recordScopeMap?: Map<string, RecordPermissionScope>,
  recordId?: string,
): boolean {
  const rowActions = deriveRecordRowActions(capabilities, scope, access, createdBy)
  const baseAllowed = action === 'edit' ? rowActions.canEdit : rowActions.canDelete
  if (baseAllowed) return true
  if (recordScopeMap && recordId) {
    const recordPerms = deriveRecordPermissions(recordId, capabilities, recordScopeMap)
    return action === 'edit' ? recordPerms.canEdit : recordPerms.canDelete
  }
  return false
}

// ── Request-keyed resolvers ─────────────────────────────────────────────────

export async function filterReadableSheetRowsForAccess<T extends { id: string }>(
  query: QueryFn,
  sheetRows: T[],
  access: ResolvedRequestAccess,
  baseCapabilities?: MultitableCapabilities,
): Promise<T[]> {
  if (sheetRows.length === 0 || access.isAdminRole) return sheetRows
  const effectiveCapabilities = baseCapabilities ?? deriveCapabilities(access.permissions, access.isAdminRole)
  const scopeMap = await loadSheetPermissionScopeMap(
    query,
    sheetRows.map((row) => String(row.id)),
    access.userId,
  )
  return sheetRows.filter((row) =>
    canReadWithSheetGrant(
      effectiveCapabilities,
      scopeMap.get(String(row.id)),
      access.isAdminRole,
    ),
  )
}

export async function resolveSheetCapabilities(
  req: Request,
  query: QueryFn,
  sheetId: string,
): Promise<{
  access: ResolvedRequestAccess
  capabilities: MultitableCapabilities
  capabilityOrigin: MultitableCapabilityOrigin
  sheetScope?: SheetPermissionScope
}> {
  const access = await resolveRequestAccess(req)
  const baseCapabilities = deriveCapabilities(access.permissions, access.isAdminRole)
  const scopeMap = await loadSheetPermissionScopeMap(query, [sheetId], access.userId)
  const sheetScope = scopeMap.get(sheetId)
  const capabilities = applyContextSheetSchemaWriteGrant(baseCapabilities, sheetScope, access.isAdminRole)
  return {
    access,
    capabilities,
    capabilityOrigin: deriveCapabilityOrigin(baseCapabilities, capabilities, sheetScope, access.isAdminRole),
    ...(sheetScope ? { sheetScope } : {}),
  }
}

export async function resolveSheetReadableCapabilities(
  req: Request,
  query: QueryFn,
  sheetId: string,
): Promise<{
  access: ResolvedRequestAccess
  capabilities: MultitableCapabilities
  capabilityOrigin: MultitableCapabilityOrigin
  sheetScope?: SheetPermissionScope
}> {
  return resolveSheetCapabilities(req, query, sheetId)
}

export async function resolveReadableSheetIds(
  req: Request,
  query: QueryFn,
  sheetIds: Iterable<string>,
): Promise<Set<string>> {
  const uniqueSheetIds = Array.from(new Set(Array.from(sheetIds).map((sheetId) => sheetId.trim()).filter(Boolean)))
  if (uniqueSheetIds.length === 0) return new Set()

  const access = await resolveRequestAccess(req)
  if (access.isAdminRole) {
    return new Set(uniqueSheetIds)
  }

  const baseCapabilities = deriveCapabilities(access.permissions, access.isAdminRole)
  const scopeMap = await loadSheetPermissionScopeMap(query, uniqueSheetIds, access.userId)
  const readableSheetIds = new Set<string>()
  for (const sheetId of uniqueSheetIds) {
    if (canReadWithSheetGrant(baseCapabilities, scopeMap.get(sheetId), access.isAdminRole)) {
      readableSheetIds.add(sheetId)
    }
  }
  return readableSheetIds
}

/**
 * ②a 2a.1 — base-level readability resolver (SCAFFOLD, unwired).
 *
 * Mirrors `resolveReadableSheetIds` at the base granularity: returns whether the requesting actor may
 * READ the given base. There is no `base_permissions` table at this stage, so readability derives from:
 *   1. admin role → any base;
 *   2. a global base-read grant (`multitable:base:read` / `:base:admin` / `multitable:admin`) → any base;
 *   3. base ownership (`meta_bases.owner_id` === actor) → that base.
 * A missing / soft-deleted base is NOT readable (no null-deref).
 *
 * This is the ②b cross-base READ primitive. It is WIRED (since #2582): the read paths call it via
 * `resolveForeignFieldReadability` (univer-meta.ts) — a cross-base foreign field (foreignBaseId !=
 * sourceBaseId) resolves only when the actor canReadBase(foreignBaseId), else its value is masked and
 * dropped from lookup/rollup (no cardinality leak). The §2a.2 wall remains a separate same-base/base-id
 * check; this is the per-actor base-read gate on top. Kernel-internal to multitable; no central RBAC/auth.
 */
export async function resolveBaseReadable(
  req: Request,
  query: QueryFn,
  baseId: string,
): Promise<boolean> {
  const normalizedBaseId = baseId.trim()
  if (!normalizedBaseId) return false

  const access = await resolveRequestAccess(req)

  // Symmetry with `resolveBaseWritable`'s NIT-1: resolve target-base EXISTENCE FIRST. A missing /
  // soft-deleted base is NOT readable by ANYONE — including an admin / base-read-grant holder — which is
  // what the docstring promises; previously the admin/grant short-circuits returned `true` ahead of this
  // check, leaving "a missing/soft-deleted base → false" as dead code for those authorities. The owner
  // derivation below reuses this same row. (Soft-delete is runtime-unreachable today; this hardens
  // against a future base soft-delete feature and keeps the two base resolvers consistent.)
  const res = await query(
    'SELECT owner_id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL',
    [normalizedBaseId],
  )
  const row = (res.rows as Array<{ owner_id: unknown }>)[0]
  if (!row) return false // missing / soft-deleted base → not readable, even for admin / grant

  if (access.isAdminRole) return true
  if (access.permissions.some((code) => BASE_READ_PERMISSION_CODES.has(code))) return true

  const ownerId = typeof row.owner_id === 'string' ? row.owner_id.trim() : ''
  return Boolean(ownerId) && Boolean(access.userId) && ownerId === access.userId
}

/**
 * ②b automation slice — base-level WRITE resolver (the write-side counterpart of `resolveBaseReadable`).
 *
 * Unlike `resolveBaseReadable`, this takes an ALREADY-RESOLVED `userId`, NOT a `Request`: the automation
 * executor has no `req`, only a `queryFn`. It mirrors the `start_approval` requester-resolution mechanism
 * (`listRbacPermissionCodes`) — fetch the user's effective permission codes (user_permissions ∪
 * role_permissions, then narrowed by namespace admission so a namespace-revoked code cannot grant write)
 * and grant write when any is a `BASE_WRITE_PERMISSION_CODES` code (Phase C3: `multitable:base:write`
 * — the finer write-not-admin tier — OR `multitable:base:admin` / `multitable:admin`, which imply
 * write), OR when the user owns the base (`meta_bases.owner_id`, mirroring
 * `resolveBaseReadable`'s owner derivation). FAIL-CLOSED: no userId → false; a missing / soft-deleted
 * base → false. It does NOT touch central RBAC / auth — kernel-internal to multitable.
 */
export async function resolveBaseWritable(
  userId: string | null | undefined,
  query: QueryFn,
  baseId: string,
): Promise<boolean> {
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
  if (!normalizedUserId) return false // fail-closed: no identity → no write
  const normalizedBaseId = baseId.trim()
  if (!normalizedBaseId) return false

  // NIT-1: target-base EXISTENCE first (mirrors the owner SELECT's `deleted_at IS NULL` guard). A
  // missing / soft-deleted base is NOT writable by ANYONE — including an admin/grant holder. Resolving
  // existence BEFORE the admin/grant short-circuit closes the latent hole where the short-circuit
  // returned `true` ahead of this check, so the documented "a missing/soft-deleted base → false"
  // intent was dead code for admins. The owner derivation below reuses this same row.
  const baseRes = await query(
    'SELECT owner_id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL',
    [normalizedBaseId],
  )
  const baseRow = (baseRes.rows as Array<{ owner_id: unknown }>)[0]
  if (!baseRow) return false // missing / soft-deleted target base → fail-closed (even for an admin)

  // Effective permission codes (user_permissions ∪ role_permissions), narrowed by namespace admission so
  // the write gate is never MORE permissive than the codebase's effective-permission resolution.
  const codesRes = await query(
    `SELECT DISTINCT permission_code AS code FROM (
       SELECT up.permission_code
         FROM user_permissions up
        WHERE up.user_id = $1
       UNION ALL
       SELECT rp.permission_code
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1
     ) t`,
    [normalizedUserId],
  )
  const rawCodes = (codesRes.rows as Array<{ code: unknown }>)
    .map((r) => (typeof r.code === 'string' ? r.code : ''))
    .filter(Boolean)
  const codes = await filterPermissionCodesByNamespaceAdmission(normalizedUserId, rawCodes)
  if (codes.some((code) => BASE_WRITE_PERMISSION_CODES.has(code))) return true

  // base ownership (symmetric with resolveBaseReadable) — reuses the existence row resolved above.
  const ownerId = typeof baseRow.owner_id === 'string' ? baseRow.owner_id.trim() : ''
  return Boolean(ownerId) && ownerId === normalizedUserId
}
