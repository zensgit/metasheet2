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

import { isAdmin, listUserPermissions } from '../rbac/service'
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

  const eligibility = await Promise.all(
    candidates.map(async (candidate) => {
      if (candidate.subjectType === 'member-group') return true
      if (candidate.subjectType === 'role') {
        if (candidate.subjectId === 'admin') return true
        const permissions = normalizePermissionCodes(rolePermissionsById.get(candidate.subjectId) ?? [])
        return hasPermission(permissions, 'multitable:read') || hasPermission(permissions, 'multitable:write')
      }

      const [permissions, admin] = await Promise.all([
        listUserPermissions(candidate.subjectId),
        isAdmin(candidate.subjectId),
      ])
      return admin || hasPermission(permissions, 'multitable:read') || hasPermission(permissions, 'multitable:write')
    }),
  )

  return candidates.filter((_candidate, index) => eligibility[index])
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
      const level = row.access_level as 'read' | 'write' | 'admin'
      if (existing) {
        const rank = { read: 0, write: 1, admin: 2 } as const
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
