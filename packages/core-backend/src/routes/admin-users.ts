import type { Request, Response } from 'express'
import { Router } from 'express'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import { buildOnboardingPacket, getAccessPreset, listAccessPresets } from '../auth/access-presets'
import { recordInvite } from '../auth/invite-ledger'
import { isInviteTokenExpired, issueInviteToken } from '../auth/invite-tokens'
import { validatePassword } from '../auth/password-policy'
import { getUserSession, listUserSessions, revokeUserSession } from '../auth/session-registry'
import { revokeUserSessions } from '../auth/session-revocation'
import { auditLog } from '../audit/audit'
import { authenticate } from '../middleware/auth'
import { query } from '../db/pg'
import { invalidateUserPerms, isAdmin as isRbacAdmin, listUserPermissions } from '../rbac/service'
import {
  deriveDelegatedAdminNamespace,
  disableNamespaceAdmissionsWithoutRoles,
  isNamespaceAdmissionControlledResource,
  listRoleNamespaces,
  listUserNamespaceAdmissionSnapshots,
  normalizeNamespace,
  roleIdMatchesNamespaces as matchRoleIdToNamespaces,
  setUserNamespaceAdmission,
} from '../rbac/namespace-admission'
import { getBcryptSaltRounds } from '../security/auth-runtime-config'
import { isDatabaseSchemaError } from '../utils/database-errors'
import { jsonError, jsonOk, parsePagination } from '../util/response'

type AdminUserProfile = {
  id: string
  email: string
  name: string | null
  role: string
  is_active: boolean
  is_admin: boolean
  last_login_at: string | null
  created_at: string
  updated_at?: string
}

type AdminRoleCatalogRow = {
  id: string
  name: string
  permissions: string[] | null
  member_count: number | string
}

type AdminAuditLogRow = {
  id: number
  created_at: string
  event_type: string
  event_category: string
  event_severity: string
  action: string
  resource_type: string | null
  resource_id: string | null
  user_id: number | null
  user_name: string | null
  user_email: string | null
  action_details: Record<string, unknown> | null
  error_code: string | null
}

type AdminSessionRevocationRow = {
  user_id: string
  revoked_after: string
  updated_at: string
  updated_by: string | null
  reason: string | null
  user_email: string | null
  user_name: string | null
  updated_by_email: string | null
  updated_by_name: string | null
}

type AdminInviteLedgerRow = {
  id: string
  user_id: string
  email: string
  preset_id: string | null
  product_mode: 'platform' | 'attendance' | 'plm-workbench'
  role_id: string | null
  invited_by: string | null
  invite_token: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  accepted_at: string | null
  consumed_by: string | null
  last_sent_at: string
  created_at: string
  updated_at: string
  user_name: string | null
  invited_by_email: string | null
  invited_by_name: string | null
}

type AdminDingTalkGrantRow = {
  enabled: boolean
  granted_by: string | null
  created_at: string
  updated_at: string
}

type AdminDingTalkIdentityRow = {
  corp_id: string | null
  last_login_at: string | null
  created_at: string
  updated_at: string
}

type DirectoryMembershipRow = {
  integration_id: string
  integration_name: string
  provider: string
  corp_id: string | null
  directory_account_id: string
  external_user_id: string
  account_name: string
  account_email: string | null
  account_mobile: string | null
  account_is_active: boolean
  account_updated_at: string
  link_status: string
  match_strategy: string | null
  reviewed_by: string | null
  review_note: string | null
  link_updated_at: string
  department_paths: string[] | null
}

type DelegatedRoleCatalogRow = {
  id: string
  name: string
  permissions: string[] | null
}

type DelegatedScopeAssignmentRow = {
  id: string
  admin_user_id: string
  namespace: string
  directory_department_id: string
  created_by: string | null
  created_at: string
  updated_at: string
  integration_id: string
  integration_name: string
  provider: string
  corp_id: string | null
  external_department_id: string
  department_name: string
  department_full_path: string | null
  department_is_active: boolean
}

type DelegatedDepartmentCatalogRow = {
  directory_department_id: string
  integration_id: string
  integration_name: string
  provider: string
  corp_id: string | null
  external_department_id: string
  department_name: string
  department_full_path: string | null
  department_is_active: boolean
}

type DelegatedScopeTemplateRow = {
  id: string
  name: string
  description: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
  department_count: number | string
  member_group_count: number | string
}

type DelegatedScopeTemplateDepartmentRow = {
  template_id: string
  directory_department_id: string
  integration_id: string
  integration_name: string
  provider: string
  corp_id: string | null
  external_department_id: string
  department_name: string
  department_full_path: string | null
  department_is_active: boolean
}

type PlatformMemberGroupRow = {
  id: string
  name: string
  description: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
  member_count: number | string
}

type PlatformMemberGroupMemberRow = {
  group_id: string
  user_id: string
  email: string
  name: string | null
  role: string
  is_active: boolean
  is_admin: boolean
}

type DelegatedGroupAssignmentRow = {
  id: string
  admin_user_id: string
  namespace: string
  group_id: string
  created_by: string | null
  created_at: string
  updated_at: string
  group_name: string
  group_description: string | null
  member_count: number | string
}

type DelegatedScopeTemplateMemberGroupRow = {
  template_id: string
  group_id: string
  group_name: string
  group_description: string | null
  member_count: number | string
}

type AuditRangeBoundaryMode = 'start' | 'end'

type CreateUserRequestBody = {
  email?: string
  name?: string
  password?: string
  role?: string
  roleId?: string
  presetId?: string
  isActive?: boolean
}

const ADMIN_AUDIT_RESOURCE_TYPES = ['user', 'user-role', 'user-auth-grant', 'user-namespace-admission', 'user-password', 'user-session', 'user-invite', 'role', 'permission', 'permission-template', 'delegated-admin-scope', 'delegated-admin-scope-template', 'platform-member-group', 'delegated-admin-group-scope'] as const
const DINGTALK_PROVIDER = 'dingtalk'
const PLATFORM_ADMIN_ROLE_ID = 'admin'
const ATTENDANCE_ROLE_IDS = new Set(['attendance_employee', 'attendance_approver', 'attendance_admin'])

function getRequestUserId(req: Request): string {
  const raw = req.user as Record<string, unknown> | undefined
  const userId = raw?.id ?? raw?.userId ?? raw?.sub
  return typeof userId === 'string' ? userId.trim() : ''
}

function hasLegacyAdminClaim(req: Request): boolean {
  const raw = req.user as Record<string, unknown> | undefined
  if (!raw) return false
  if (raw.role === 'admin') return true
  if (Array.isArray(raw.roles) && raw.roles.includes('admin')) return true
  if (Array.isArray(raw.perms) && (raw.perms.includes('*:*') || raw.perms.includes('admin:all'))) return true
  return false
}

async function ensurePlatformAdmin(req: Request, res: Response): Promise<string | null> {
  const userId = getRequestUserId(req)
  if (!userId) {
    jsonError(res, 401, 'UNAUTHENTICATED', 'Authentication required')
    return null
  }

  const allowed = hasLegacyAdminClaim(req) || await isRbacAdmin(userId)
  if (!allowed) {
    jsonError(res, 403, 'FORBIDDEN', 'Admin access required')
    return null
  }

  return userId
}

async function fetchUserProfile(userId: string): Promise<AdminUserProfile | null> {
  const result = await query<AdminUserProfile>(
    `SELECT id, email, name, role, is_active, is_admin, last_login_at, created_at, updated_at
     FROM users
     WHERE id = $1`,
    [userId],
  )
  return result.rows[0] ?? null
}

async function fetchUserRoleIds(userId: string): Promise<string[]> {
  const result = await query<{ role_id: string }>(
    `SELECT role_id
     FROM user_roles
     WHERE user_id = $1
     ORDER BY role_id ASC`,
    [userId],
  )
  return result.rows.map((row) => row.role_id).filter(Boolean)
}

async function fetchRoleCatalog() {
  const result = await query<AdminRoleCatalogRow>(
    `SELECT
        r.id,
        r.name,
        COALESCE(array_remove(array_agg(DISTINCT rp.permission_code), NULL), ARRAY[]::text[]) AS permissions,
        COUNT(DISTINCT ur.user_id)::int AS member_count
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN user_roles ur ON ur.role_id = r.id
     GROUP BY r.id, r.name
     ORDER BY r.id ASC`,
  )

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    permissions: Array.isArray(row.permissions) ? row.permissions.filter(Boolean) : [],
    memberCount: Number(row.member_count || 0),
  }))
}

async function fetchUserAccessSnapshot(userId: string) {
  const profile = await fetchUserProfile(userId)
  if (!profile) return null

  const [roles, permissions, isAdmin] = await Promise.all([
    fetchUserRoleIds(userId),
    listUserPermissions(userId),
    isRbacAdmin(userId),
  ])

  return {
    user: profile,
    roles,
    permissions,
    isAdmin,
  }
}

function generateTemporaryPassword(): string {
  return `Tmp-${crypto.randomBytes(8).toString('base64url')}9A`
}

function sanitizeEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, 255)
}

function sanitizeName(name: string): string {
  return name.trim().replace(/[<>'"&;]/g, '').slice(0, 100)
}

function parseAuditRangeBoundary(value: unknown, mode: AuditRangeBoundaryMode): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}${mode === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z'}`
    : trimmed

  const timestamp = Date.parse(normalized)
  if (Number.isNaN(timestamp)) return null
  return new Date(timestamp).toISOString()
}

function normalizeInviteLedgerRow(row: AdminInviteLedgerRow): AdminInviteLedgerRow {
  if (row.status === 'pending' && isInviteTokenExpired(row.invite_token)) {
    return {
      ...row,
      status: 'expired',
    }
  }
  return row
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] ?? '').trim().toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(raw)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) return false
  return fallback
}

function isDatabaseUniqueConstraintError(error: unknown): boolean {
  const dbError = error as { code?: string, message?: string }
  if (dbError?.code === '23505') return true
  if (typeof dbError?.message === 'string') {
    const message = dbError.message.toLowerCase()
    return message.includes('duplicate key') || message.includes('unique constraint')
  }
  return false
}

async function fetchDingTalkAccessSnapshot(userId: string) {
  const [grantResult, identityResult] = await Promise.all([
    query<AdminDingTalkGrantRow>(
      `SELECT enabled, granted_by, created_at, updated_at
       FROM user_external_auth_grants
       WHERE provider = $1 AND local_user_id = $2
       LIMIT 1`,
      [DINGTALK_PROVIDER, userId],
    ),
    query<AdminDingTalkIdentityRow>(
      `SELECT corp_id, last_login_at, created_at, updated_at
       FROM user_external_identities
       WHERE provider = $1 AND local_user_id = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [DINGTALK_PROVIDER, userId],
    ),
  ])

  const grant = grantResult.rows[0] ?? null
  const identity = identityResult.rows[0] ?? null

  return {
    provider: DINGTALK_PROVIDER,
    requireGrant: readBooleanEnv('DINGTALK_AUTH_REQUIRE_GRANT', false),
    autoLinkEmail: readBooleanEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', true),
    autoProvision: readBooleanEnv('DINGTALK_AUTH_AUTO_PROVISION', false),
    grant: {
      exists: grant !== null,
      enabled: grant?.enabled === true,
      grantedBy: grant?.granted_by ?? null,
      createdAt: grant?.created_at ?? null,
      updatedAt: grant?.updated_at ?? null,
    },
    identity: {
      exists: identity !== null,
      corpId: identity?.corp_id ?? null,
      lastLoginAt: identity?.last_login_at ?? null,
      createdAt: identity?.created_at ?? null,
      updatedAt: identity?.updated_at ?? null,
    },
  }
}

function deriveDelegableNamespaces(roleIds: string[]): string[] {
  return Array.from(new Set(
    roleIds
      .map((roleId) => deriveDelegatedAdminNamespace(roleId))
      .filter((namespace): namespace is string => Boolean(namespace)),
  )).sort()
}

function roleIdMatchesNamespaces(roleId: string, namespaces: string[]): boolean {
  return matchRoleIdToNamespaces(roleId, namespaces)
}

async function fetchDelegatedRoleCatalog(namespaces?: string[]) {
  if (Array.isArray(namespaces) && namespaces.length === 0) return []

  const result = Array.isArray(namespaces)
    ? await query<DelegatedRoleCatalogRow>(
      `SELECT
          r.id,
          r.name,
          COALESCE(array_remove(array_agg(DISTINCT rp.permission_code), NULL), ARRAY[]::text[]) AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE EXISTS (
         SELECT 1
         FROM unnest($1::text[]) AS namespace
         WHERE r.id = namespace OR r.id LIKE namespace || '\_%' ESCAPE '\'
       )
       GROUP BY r.id, r.name
       ORDER BY r.id ASC`,
      [namespaces],
    )
    : await query<DelegatedRoleCatalogRow>(
      `SELECT
          r.id,
          r.name,
          COALESCE(array_remove(array_agg(DISTINCT rp.permission_code), NULL), ARRAY[]::text[]) AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       GROUP BY r.id, r.name
       ORDER BY r.id ASC`,
    )

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    permissions: Array.isArray(row.permissions) ? row.permissions.filter(Boolean) : [],
  }))
}

async function fetchDelegatedScopeAssignments(adminUserId: string, namespaces?: string[]) {
  if (Array.isArray(namespaces) && namespaces.length === 0) return []

  const result = Array.isArray(namespaces)
    ? await query<DelegatedScopeAssignmentRow>(
      `SELECT
          s.id,
          s.admin_user_id,
          s.namespace,
          s.directory_department_id,
          s.created_by,
          s.created_at,
          s.updated_at,
          d.integration_id,
          i.name AS integration_name,
          i.provider,
          i.corp_id,
          d.external_department_id,
          d.name AS department_name,
          d.full_path AS department_full_path,
          d.is_active AS department_is_active
       FROM delegated_role_admin_scopes s
       JOIN directory_departments d ON d.id = s.directory_department_id
       JOIN directory_integrations i ON i.id = d.integration_id
       WHERE s.admin_user_id = $1
         AND s.namespace = ANY($2::text[])
       ORDER BY s.namespace ASC, i.name ASC, COALESCE(d.full_path, d.name) ASC`,
      [adminUserId, namespaces],
    )
    : await query<DelegatedScopeAssignmentRow>(
      `SELECT
          s.id,
          s.admin_user_id,
          s.namespace,
          s.directory_department_id,
          s.created_by,
          s.created_at,
          s.updated_at,
          d.integration_id,
          i.name AS integration_name,
          i.provider,
          i.corp_id,
          d.external_department_id,
          d.name AS department_name,
          d.full_path AS department_full_path,
          d.is_active AS department_is_active
       FROM delegated_role_admin_scopes s
       JOIN directory_departments d ON d.id = s.directory_department_id
       JOIN directory_integrations i ON i.id = d.integration_id
       WHERE s.admin_user_id = $1
       ORDER BY s.namespace ASC, i.name ASC, COALESCE(d.full_path, d.name) ASC`,
      [adminUserId],
    )

  return result.rows.map((row) => ({
    id: row.id,
    adminUserId: row.admin_user_id,
    namespace: row.namespace,
    directoryDepartmentId: row.directory_department_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    integrationId: row.integration_id,
    integrationName: row.integration_name,
    provider: row.provider,
    corpId: row.corp_id,
    externalDepartmentId: row.external_department_id,
    departmentName: row.department_name,
    departmentFullPath: row.department_full_path,
    departmentActive: row.department_is_active,
  }))
}

async function fetchDelegatedDepartmentCatalog(search: string, limit = 50) {
  const trimmed = search.trim()
  const term = trimmed ? `%${trimmed}%` : '%'
  const result = await query<DelegatedDepartmentCatalogRow>(
    `SELECT
        d.id AS directory_department_id,
        d.integration_id,
        i.name AS integration_name,
        i.provider,
        i.corp_id,
        d.external_department_id,
        d.name AS department_name,
        d.full_path AS department_full_path,
        d.is_active AS department_is_active
     FROM directory_departments d
     JOIN directory_integrations i ON i.id = d.integration_id
     WHERE d.is_active = true
       AND (
         $1 = '%'
         OR d.name ILIKE $1
         OR COALESCE(d.full_path, '') ILIKE $1
         OR i.name ILIKE $1
         OR d.external_department_id ILIKE $1
       )
     ORDER BY i.name ASC, COALESCE(d.full_path, d.name) ASC
     LIMIT $2`,
    [term, limit],
  )

  return result.rows.map((row) => ({
    directoryDepartmentId: row.directory_department_id,
    integrationId: row.integration_id,
    integrationName: row.integration_name,
    provider: row.provider,
    corpId: row.corp_id,
    externalDepartmentId: row.external_department_id,
    departmentName: row.department_name,
    departmentFullPath: row.department_full_path,
    departmentActive: row.department_is_active,
  }))
}

function sanitizeScopeTemplateText(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().replace(/[<>'"&;]/g, '').slice(0, maxLength)
}

async function fetchPlatformMemberGroups(search = '') {
  const trimmed = search.trim()
  const term = trimmed ? `%${trimmed}%` : '%'
  const result = await query<PlatformMemberGroupRow>(
    `SELECT
        g.id,
        g.name,
        g.description,
        g.created_by,
        g.updated_by,
        g.created_at,
        g.updated_at,
        COUNT(gm.user_id)::int AS member_count
     FROM platform_member_groups g
     LEFT JOIN platform_member_group_members gm ON gm.group_id = g.id
     WHERE (
       $1 = '%'
       OR g.name ILIKE $1
       OR COALESCE(g.description, '') ILIKE $1
     )
     GROUP BY g.id, g.name, g.description, g.created_by, g.updated_by, g.created_at, g.updated_at
     ORDER BY g.updated_at DESC, g.name ASC`,
    [term],
  )

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    memberCount: Number(row.member_count || 0),
  }))
}

async function fetchPlatformMemberGroupMembers(groupId: string) {
  const result = await query<PlatformMemberGroupMemberRow>(
    `SELECT
        gm.group_id,
        u.id AS user_id,
        u.email,
        u.name,
        u.role,
        u.is_active,
        u.is_admin
     FROM platform_member_group_members gm
     JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1
     ORDER BY COALESCE(u.name, u.email) ASC, u.email ASC`,
    [groupId],
  )

  const userIds = result.rows.map((row) => row.user_id).filter(Boolean)
  if (userIds.length === 0) return []

  const [roleRows, grantRows, directoryRows] = await Promise.all([
    query<{ user_id: string, role_id: string }>(
      `SELECT user_id, role_id
       FROM user_roles
       WHERE user_id = ANY($1::text[])
       ORDER BY role_id ASC`,
      [userIds],
    ),
    query<{ user_id: string }>(
      `SELECT local_user_id AS user_id
       FROM user_external_auth_grants
       WHERE provider = $1
         AND enabled = true
         AND local_user_id = ANY($2::text[])`,
      [DINGTALK_PROVIDER, userIds],
    ),
    query<{ user_id: string }>(
      `SELECT DISTINCT local_user_id AS user_id
       FROM directory_account_links
       WHERE link_status = 'linked'
         AND local_user_id = ANY($1::text[])`,
      [userIds],
    ),
  ])

  const roleMap = new Map<string, string[]>()
  for (const row of roleRows.rows) {
    const current = roleMap.get(row.user_id) || []
    current.push(row.role_id)
    roleMap.set(row.user_id, current)
  }

  const dingtalkGrantSet = new Set(grantRows.rows.map((row) => row.user_id))
  const directoryLinkedSet = new Set(directoryRows.rows.map((row) => row.user_id))

  return result.rows.map((row) => {
    const roles = roleMap.get(row.user_id) || []
    return {
      id: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      isActive: row.is_active,
      isAdmin: row.is_admin,
      roles,
      platformAdminEnabled: row.role === 'admin' || row.is_admin || roles.includes(PLATFORM_ADMIN_ROLE_ID),
      attendanceAdminEnabled: roles.includes('attendance_admin'),
      businessRoleIds: roles.filter((roleId) => roleId !== PLATFORM_ADMIN_ROLE_ID && !ATTENDANCE_ROLE_IDS.has(roleId)),
      dingtalkLoginEnabled: dingtalkGrantSet.has(row.user_id),
      directoryLinked: directoryLinkedSet.has(row.user_id),
    }
  })
}

async function fetchPlatformMemberGroupMembershipsForUser(userId: string, allowedGroupIds?: string[]) {
  if (Array.isArray(allowedGroupIds) && allowedGroupIds.length === 0) {
    return []
  }

  const result = Array.isArray(allowedGroupIds)
    ? await query<PlatformMemberGroupRow>(
      `SELECT
          g.id,
          g.name,
          g.description,
          g.created_by,
          g.updated_by,
          g.created_at,
          g.updated_at,
          COUNT(gm2.user_id)::int AS member_count
       FROM platform_member_groups g
       JOIN platform_member_group_members gm ON gm.group_id = g.id
       LEFT JOIN platform_member_group_members gm2 ON gm2.group_id = g.id
       WHERE gm.user_id = $1
         AND g.id = ANY($2::uuid[])
       GROUP BY g.id, g.name, g.description, g.created_by, g.updated_by, g.created_at, g.updated_at
       ORDER BY g.name ASC`,
      [userId, allowedGroupIds],
    )
    : await query<PlatformMemberGroupRow>(
      `SELECT
          g.id,
          g.name,
          g.description,
          g.created_by,
          g.updated_by,
          g.created_at,
          g.updated_at,
          COUNT(gm2.user_id)::int AS member_count
       FROM platform_member_groups g
       JOIN platform_member_group_members gm ON gm.group_id = g.id
       LEFT JOIN platform_member_group_members gm2 ON gm2.group_id = g.id
       WHERE gm.user_id = $1
       GROUP BY g.id, g.name, g.description, g.created_by, g.updated_by, g.created_at, g.updated_at
       ORDER BY g.name ASC`,
      [userId],
    )

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    memberCount: Number(row.member_count || 0),
  }))
}

async function fetchPlatformMemberGroupDetail(groupId: string) {
  const [groupResult, members] = await Promise.all([
    query<PlatformMemberGroupRow>(
      `SELECT
          g.id,
          g.name,
          g.description,
          g.created_by,
          g.updated_by,
          g.created_at,
          g.updated_at,
          COUNT(gm.user_id)::int AS member_count
       FROM platform_member_groups g
       LEFT JOIN platform_member_group_members gm ON gm.group_id = g.id
       WHERE g.id = $1
       GROUP BY g.id, g.name, g.description, g.created_by, g.updated_by, g.created_at, g.updated_at
       LIMIT 1`,
      [groupId],
    ),
    fetchPlatformMemberGroupMembers(groupId),
  ])

  const group = groupResult.rows[0]
  if (!group) return null

  return {
    id: group.id,
    name: group.name,
    description: group.description,
    createdBy: group.created_by,
    updatedBy: group.updated_by,
    createdAt: group.created_at,
    updatedAt: group.updated_at,
    memberCount: Number(group.member_count || 0),
    members,
  }
}

async function fetchDelegatedScopeTemplates(search = '') {
  const trimmed = search.trim()
  const term = trimmed ? `%${trimmed}%` : '%'
  const result = await query<DelegatedScopeTemplateRow>(
    `SELECT
        t.id,
        t.name,
        t.description,
        t.created_by,
        t.updated_by,
        t.created_at,
        t.updated_at,
        COUNT(DISTINCT td.directory_department_id)::int AS department_count,
        COUNT(DISTINCT tg.group_id)::int AS member_group_count
     FROM delegated_role_scope_templates t
     LEFT JOIN delegated_role_scope_template_departments td ON td.template_id = t.id
     LEFT JOIN delegated_role_scope_template_member_groups tg ON tg.template_id = t.id
     WHERE (
       $1 = '%'
       OR t.name ILIKE $1
       OR COALESCE(t.description, '') ILIKE $1
     )
     GROUP BY t.id, t.name, t.description, t.created_by, t.updated_by, t.created_at, t.updated_at
     ORDER BY t.updated_at DESC, t.name ASC`,
    [term],
  )

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    departmentCount: Number(row.department_count || 0),
    memberGroupCount: Number(row.member_group_count || 0),
  }))
}

async function fetchDelegatedScopeTemplateDepartments(templateId: string) {
  const result = await query<DelegatedScopeTemplateDepartmentRow>(
    `SELECT
        td.template_id,
        d.id AS directory_department_id,
        d.integration_id,
        i.name AS integration_name,
        i.provider,
        i.corp_id,
        d.external_department_id,
        d.name AS department_name,
        d.full_path AS department_full_path,
        d.is_active AS department_is_active
     FROM delegated_role_scope_template_departments td
     JOIN directory_departments d ON d.id = td.directory_department_id
     JOIN directory_integrations i ON i.id = d.integration_id
     WHERE td.template_id = $1
     ORDER BY i.name ASC, COALESCE(d.full_path, d.name) ASC`,
    [templateId],
  )

  return result.rows.map((row) => ({
    directoryDepartmentId: row.directory_department_id,
    integrationId: row.integration_id,
    integrationName: row.integration_name,
    provider: row.provider,
    corpId: row.corp_id,
    externalDepartmentId: row.external_department_id,
    departmentName: row.department_name,
    departmentFullPath: row.department_full_path,
    departmentActive: row.department_is_active,
  }))
}

async function fetchDelegatedScopeTemplateMemberGroups(templateId: string) {
  const result = await query<DelegatedScopeTemplateMemberGroupRow>(
    `SELECT
        tg.template_id,
        g.id AS group_id,
        g.name AS group_name,
        g.description AS group_description,
        COUNT(gm.user_id)::int AS member_count
     FROM delegated_role_scope_template_member_groups tg
     JOIN platform_member_groups g ON g.id = tg.group_id
     LEFT JOIN platform_member_group_members gm ON gm.group_id = g.id
     WHERE tg.template_id = $1
     GROUP BY tg.template_id, g.id, g.name, g.description
     ORDER BY g.name ASC`,
    [templateId],
  )

  return result.rows.map((row) => ({
    id: row.group_id,
    name: row.group_name,
    description: row.group_description,
    memberCount: Number(row.member_count || 0),
  }))
}

async function fetchDelegatedScopeTemplateDetail(templateId: string) {
  const [templateResult, departments, memberGroups] = await Promise.all([
    query<DelegatedScopeTemplateRow>(
      `SELECT
          t.id,
          t.name,
          t.description,
          t.created_by,
          t.updated_by,
          t.created_at,
          t.updated_at,
          COUNT(DISTINCT td.directory_department_id)::int AS department_count,
          COUNT(DISTINCT tg.group_id)::int AS member_group_count
       FROM delegated_role_scope_templates t
       LEFT JOIN delegated_role_scope_template_departments td ON td.template_id = t.id
       LEFT JOIN delegated_role_scope_template_member_groups tg ON tg.template_id = t.id
       WHERE t.id = $1
       GROUP BY t.id, t.name, t.description, t.created_by, t.updated_by, t.created_at, t.updated_at
       LIMIT 1`,
      [templateId],
    ),
    fetchDelegatedScopeTemplateDepartments(templateId),
    fetchDelegatedScopeTemplateMemberGroups(templateId),
  ])

  const template = templateResult.rows[0]
  if (!template) return null

  return {
    id: template.id,
    name: template.name,
    description: template.description,
    createdBy: template.created_by,
    updatedBy: template.updated_by,
    createdAt: template.created_at,
    updatedAt: template.updated_at,
    departmentCount: Number(template.department_count || 0),
    memberGroupCount: Number(template.member_group_count || 0),
    departments,
    memberGroups,
  }
}

async function fetchDelegatedGroupAssignments(adminUserId: string, namespaces?: string[]) {
  if (Array.isArray(namespaces) && namespaces.length === 0) return []

  const result = Array.isArray(namespaces)
    ? await query<DelegatedGroupAssignmentRow>(
      `SELECT
          gscope.id,
          gscope.admin_user_id,
          gscope.namespace,
          gscope.group_id,
          gscope.created_by,
          gscope.created_at,
          gscope.updated_at,
          g.name AS group_name,
          g.description AS group_description,
          COUNT(gm.user_id)::int AS member_count
       FROM delegated_role_admin_member_groups gscope
       JOIN platform_member_groups g ON g.id = gscope.group_id
       LEFT JOIN platform_member_group_members gm ON gm.group_id = g.id
       WHERE gscope.admin_user_id = $1
         AND gscope.namespace = ANY($2::text[])
       GROUP BY gscope.id, gscope.admin_user_id, gscope.namespace, gscope.group_id, gscope.created_by, gscope.created_at, gscope.updated_at, g.name, g.description
       ORDER BY gscope.namespace ASC, g.name ASC`,
      [adminUserId, namespaces],
    )
    : await query<DelegatedGroupAssignmentRow>(
      `SELECT
          gscope.id,
          gscope.admin_user_id,
          gscope.namespace,
          gscope.group_id,
          gscope.created_by,
          gscope.created_at,
          gscope.updated_at,
          g.name AS group_name,
          g.description AS group_description,
          COUNT(gm.user_id)::int AS member_count
       FROM delegated_role_admin_member_groups gscope
       JOIN platform_member_groups g ON g.id = gscope.group_id
       LEFT JOIN platform_member_group_members gm ON gm.group_id = g.id
       WHERE gscope.admin_user_id = $1
       GROUP BY gscope.id, gscope.admin_user_id, gscope.namespace, gscope.group_id, gscope.created_by, gscope.created_at, gscope.updated_at, g.name, g.description
       ORDER BY gscope.namespace ASC, g.name ASC`,
      [adminUserId],
    )

  return result.rows.map((row) => ({
    id: row.id,
    adminUserId: row.admin_user_id,
    namespace: row.namespace,
    groupId: row.group_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    name: row.group_name,
    description: row.group_description,
    memberCount: Number(row.member_count || 0),
  }))
}

function hasDelegatedAudienceAssignments(
  scopeAssignments: Array<{ id: string }>,
  groupAssignments: Array<{ id: string }>,
): boolean {
  return scopeAssignments.length > 0 || groupAssignments.length > 0
}

async function fetchScopedDelegationUsers(adminUserId: string, namespaces: string[], search: string, pageSize: number, offset: number) {
  if (namespaces.length === 0) {
    return { total: 0, items: [] as AdminUserProfile[] }
  }

  const term = search.trim() ? `%${search.trim()}%` : ''
  const filterSql = term
    ? `AND (u.email ILIKE $3 OR COALESCE(u.name, '') ILIKE $3 OR u.id ILIKE $3)`
    : ''
  const paginationParams = term ? [adminUserId, namespaces, term, pageSize, offset] : [adminUserId, namespaces, pageSize, offset]

  const countSql = `
    WITH RECURSIVE seed_departments AS (
      SELECT DISTINCT d.id, d.integration_id, d.external_department_id
      FROM delegated_role_admin_scopes s
      JOIN directory_departments d ON d.id = s.directory_department_id
      WHERE s.admin_user_id = $1
        AND s.namespace = ANY($2::text[])
        AND d.is_active = true
    ),
    allowed_departments AS (
      SELECT id, integration_id, external_department_id
      FROM seed_departments
      UNION
      SELECT child.id, child.integration_id, child.external_department_id
      FROM directory_departments child
      JOIN allowed_departments parent
        ON child.integration_id = parent.integration_id
       AND child.external_parent_department_id = parent.external_department_id
      WHERE child.is_active = true
    ),
    allowed_groups AS (
      SELECT DISTINCT gscope.group_id
      FROM delegated_role_admin_member_groups gscope
      WHERE gscope.admin_user_id = $1
        AND gscope.namespace = ANY($2::text[])
    ),
    scoped_users AS (
      SELECT DISTINCT u.id
      FROM users u
      JOIN directory_account_links l
        ON l.local_user_id = u.id
       AND l.link_status = 'linked'
      JOIN directory_accounts a
        ON a.id = l.directory_account_id
       AND a.is_active = true
      JOIN directory_account_departments ad
        ON ad.directory_account_id = a.id
      JOIN allowed_departments scoped
        ON scoped.id = ad.directory_department_id
      WHERE 1 = 1
      ${filterSql}
      UNION
      SELECT DISTINCT u.id
      FROM users u
      JOIN platform_member_group_members gm
        ON gm.user_id = u.id
      JOIN allowed_groups scoped_groups
        ON scoped_groups.group_id = gm.group_id
      WHERE 1 = 1
      ${filterSql}
    )
    SELECT COUNT(*)::int AS c
    FROM scoped_users
  `

  const listSql = `
    WITH RECURSIVE seed_departments AS (
      SELECT DISTINCT d.id, d.integration_id, d.external_department_id
      FROM delegated_role_admin_scopes s
      JOIN directory_departments d ON d.id = s.directory_department_id
      WHERE s.admin_user_id = $1
        AND s.namespace = ANY($2::text[])
        AND d.is_active = true
    ),
    allowed_departments AS (
      SELECT id, integration_id, external_department_id
      FROM seed_departments
      UNION
      SELECT child.id, child.integration_id, child.external_department_id
      FROM directory_departments child
      JOIN allowed_departments parent
        ON child.integration_id = parent.integration_id
       AND child.external_parent_department_id = parent.external_department_id
      WHERE child.is_active = true
    ),
    allowed_groups AS (
      SELECT DISTINCT gscope.group_id
      FROM delegated_role_admin_member_groups gscope
      WHERE gscope.admin_user_id = $1
        AND gscope.namespace = ANY($2::text[])
    ),
    scoped_users AS (
      SELECT DISTINCT
        u.id,
        u.email,
        u.name,
        u.role,
        u.is_active,
        u.is_admin,
        u.last_login_at,
        u.created_at,
        u.updated_at
      FROM users u
      JOIN directory_account_links l
        ON l.local_user_id = u.id
       AND l.link_status = 'linked'
      JOIN directory_accounts a
        ON a.id = l.directory_account_id
       AND a.is_active = true
      JOIN directory_account_departments ad
        ON ad.directory_account_id = a.id
      JOIN allowed_departments scoped
        ON scoped.id = ad.directory_department_id
      WHERE 1 = 1
      ${filterSql}
      UNION
      SELECT DISTINCT
        u.id,
        u.email,
        u.name,
        u.role,
        u.is_active,
        u.is_admin,
        u.last_login_at,
        u.created_at,
        u.updated_at
      FROM users u
      JOIN platform_member_group_members gm
        ON gm.user_id = u.id
      JOIN allowed_groups scoped_groups
        ON scoped_groups.group_id = gm.group_id
      WHERE 1 = 1
      ${filterSql}
    )
    SELECT id, email, name, role, is_active, is_admin, last_login_at, created_at, updated_at
    FROM scoped_users
    ORDER BY created_at DESC
    LIMIT $${term ? 4 : 3} OFFSET $${term ? 5 : 4}
  `

  const count = await query<{ c: number }>(countSql, term ? [adminUserId, namespaces, term] : [adminUserId, namespaces])
  const list = await query<AdminUserProfile>(listSql, paginationParams)

  return {
    total: count.rows[0]?.c ?? 0,
    items: list.rows,
  }
}

async function isUserWithinDelegatedScope(adminUserId: string, namespaces: string[], userId: string): Promise<boolean> {
  if (namespaces.length === 0) return false

  const result = await query<{ allowed: boolean }>(
    `WITH RECURSIVE seed_departments AS (
        SELECT DISTINCT d.id, d.integration_id, d.external_department_id
        FROM delegated_role_admin_scopes s
        JOIN directory_departments d ON d.id = s.directory_department_id
        WHERE s.admin_user_id = $1
          AND s.namespace = ANY($2::text[])
          AND d.is_active = true
      ),
      allowed_departments AS (
        SELECT id, integration_id, external_department_id
        FROM seed_departments
        UNION
        SELECT child.id, child.integration_id, child.external_department_id
        FROM directory_departments child
        JOIN allowed_departments parent
         ON child.integration_id = parent.integration_id
         AND child.external_parent_department_id = parent.external_department_id
        WHERE child.is_active = true
      ),
      allowed_groups AS (
        SELECT DISTINCT gscope.group_id
        FROM delegated_role_admin_member_groups gscope
        WHERE gscope.admin_user_id = $1
          AND gscope.namespace = ANY($2::text[])
      )
      SELECT EXISTS (
        SELECT 1
        FROM directory_account_links l
        JOIN directory_accounts a
          ON a.id = l.directory_account_id
         AND a.is_active = true
        JOIN directory_account_departments ad
          ON ad.directory_account_id = a.id
        JOIN allowed_departments scoped
          ON scoped.id = ad.directory_department_id
        WHERE l.local_user_id = $3
          AND l.link_status = 'linked'
        UNION
        SELECT 1
        FROM platform_member_group_members gm
        JOIN allowed_groups scoped_groups
          ON scoped_groups.group_id = gm.group_id
        WHERE gm.user_id = $3
      ) AS allowed`,
    [adminUserId, namespaces, userId],
  )

  return result.rows[0]?.allowed === true
}

function deriveVisibleDelegatedMemberGroupIds(groupAssignments: Array<{ groupId: string }>): string[] {
  return Array.from(new Set(groupAssignments.map((assignment) => assignment.groupId).filter(Boolean))).sort()
}

function deriveMatchingNamespacesForRole(roleId: string, namespaces: string[]): string[] {
  return namespaces.filter((namespace) => roleIdMatchesNamespaces(roleId, [namespace]))
}

async function fetchVisibleNamespaceAdmissions(userId: string, namespaces?: string[]) {
  const admissions = await listUserNamespaceAdmissionSnapshots(userId)
  if (!Array.isArray(namespaces)) return admissions
  return admissions.filter((admission) => namespaces.includes(admission.namespace))
}

async function ensureRoleDelegationAdmin(req: Request, res: Response): Promise<{
  actorId: string
  isPlatformAdmin: boolean
  delegableNamespaces: string[]
}> {
  const actorId = getRequestUserId(req)
  if (!actorId) {
    jsonError(res, 401, 'UNAUTHENTICATED', 'Authentication required')
    return null as never
  }

  if (hasLegacyAdminClaim(req) || await isRbacAdmin(actorId)) {
    return {
      actorId,
      isPlatformAdmin: true,
      delegableNamespaces: [],
    }
  }

  const roleIds = await fetchUserRoleIds(actorId)
  const delegableNamespaces = deriveDelegableNamespaces(roleIds)
  if (delegableNamespaces.length === 0) {
    jsonError(res, 403, 'FORBIDDEN', 'Delegated role-admin access required')
    return null as never
  }

  return {
    actorId,
    isPlatformAdmin: false,
    delegableNamespaces,
  }
}

async function fetchDirectoryMemberships(userId: string) {
  const result = await query<DirectoryMembershipRow>(
    `SELECT
        i.id AS integration_id,
        i.name AS integration_name,
        i.provider,
        i.corp_id,
        a.id AS directory_account_id,
        a.external_user_id,
        a.name AS account_name,
        a.email AS account_email,
        a.mobile AS account_mobile,
        a.is_active AS account_is_active,
        a.updated_at AS account_updated_at,
        l.link_status,
        l.match_strategy,
        l.reviewed_by,
        l.review_note,
        l.updated_at AS link_updated_at,
        COALESCE(array_remove(array_agg(DISTINCT d.full_path), NULL), ARRAY[]::text[]) AS department_paths
     FROM directory_account_links l
     JOIN directory_accounts a ON a.id = l.directory_account_id
     JOIN directory_integrations i ON i.id = a.integration_id
     LEFT JOIN directory_account_departments ad ON ad.directory_account_id = a.id
     LEFT JOIN directory_departments d ON d.id = ad.directory_department_id
     WHERE l.local_user_id = $1
     GROUP BY
       i.id, i.name, i.provider, i.corp_id,
       a.id, a.external_user_id, a.name, a.email, a.mobile, a.is_active, a.updated_at,
       l.link_status, l.match_strategy, l.reviewed_by, l.review_note, l.updated_at
     ORDER BY i.name ASC, a.name ASC`,
    [userId],
  )

  return result.rows.map((row) => ({
    integrationId: row.integration_id,
    integrationName: row.integration_name,
    provider: row.provider,
    corpId: row.corp_id,
    directoryAccountId: row.directory_account_id,
    externalUserId: row.external_user_id,
    name: row.account_name,
    email: row.account_email,
    mobile: row.account_mobile,
    accountEnabled: row.account_is_active,
    accountUpdatedAt: row.account_updated_at,
    linkStatus: row.link_status,
    matchStrategy: row.match_strategy,
    reviewedBy: row.reviewed_by,
    reviewNote: row.review_note,
    linkUpdatedAt: row.link_updated_at,
    departmentPaths: Array.isArray(row.department_paths) ? row.department_paths.filter(Boolean) : [],
  }))
}

async function fetchMemberAdmissionSnapshot(userId: string) {
  const [profile, roles, directoryMemberships, dingtalkAccess, memberGroups, namespaceAdmissions] = await Promise.all([
    fetchUserProfile(userId),
    fetchUserRoleIds(userId),
    fetchDirectoryMemberships(userId),
    fetchDingTalkAccessSnapshot(userId),
    fetchPlatformMemberGroupMembershipsForUser(userId),
    listUserNamespaceAdmissionSnapshots(userId),
  ])
  if (!profile) return null

  return {
    userId,
    accountEnabled: profile.is_active,
    platformAdminEnabled: profile.role === 'admin' || profile.is_admin || roles.includes(PLATFORM_ADMIN_ROLE_ID),
    attendanceAdminEnabled: roles.includes('attendance_admin'),
    businessRoleIds: roles.filter((roleId) => roleId !== PLATFORM_ADMIN_ROLE_ID && !ATTENDANCE_ROLE_IDS.has(roleId)),
    memberGroups,
    directoryMemberships,
    dingtalk: dingtalkAccess,
    namespaceAdmissions,
  }
}

async function syncLegacyAdminProfile(userId: string, enabled: boolean): Promise<void> {
  await query(
    `UPDATE users
     SET role = CASE
       WHEN $2::boolean THEN 'admin'
       WHEN role = 'admin' THEN 'user'
       ELSE role
     END,
     is_admin = $2,
     updated_at = NOW()
     WHERE id = $1`,
    [userId, enabled],
  )
}

export function adminUsersRouter(): Router {
  const r = Router()

  r.get('/api/admin/role-delegation/summary', authenticate, async (req: Request, res: Response) => {
    const delegation = await ensureRoleDelegationAdmin(req, res)
    if (!delegation) return

    try {
      const [roleCatalog, scopeAssignments, groupAssignments] = await Promise.all([
        fetchDelegatedRoleCatalog(
          delegation.isPlatformAdmin ? undefined : delegation.delegableNamespaces,
        ),
        delegation.isPlatformAdmin
          ? Promise.resolve([])
          : fetchDelegatedScopeAssignments(delegation.actorId, delegation.delegableNamespaces),
        delegation.isPlatformAdmin
          ? Promise.resolve([])
          : fetchDelegatedGroupAssignments(delegation.actorId, delegation.delegableNamespaces),
      ])
      return jsonOk(res, {
        actorId: delegation.actorId,
        isPlatformAdmin: delegation.isPlatformAdmin,
        delegableNamespaces: delegation.delegableNamespaces,
        roleCatalog,
        scopeAssignments,
        groupAssignments,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_SUMMARY_FAILED', (error as Error)?.message || 'Failed to load delegated role summary')
    }
  })

  r.get('/api/admin/role-delegation/departments', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const q = String(req.query.q || '').trim()
      const items = await fetchDelegatedDepartmentCatalog(q)
      return jsonOk(res, {
        actorId: adminUserId,
        items,
        query: q,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_DEPARTMENT_LIST_FAILED', (error as Error)?.message || 'Failed to list delegation departments')
    }
  })

  r.get('/api/admin/role-delegation/member-groups', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const q = String(req.query.q || '').trim()
      const items = await fetchPlatformMemberGroups(q)
      return jsonOk(res, {
        actorId: adminUserId,
        items,
        query: q,
      })
    } catch (error) {
      return jsonError(res, 500, 'PLATFORM_MEMBER_GROUP_LIST_FAILED', (error as Error)?.message || 'Failed to list platform member groups')
    }
  })

  r.post('/api/admin/role-delegation/member-groups', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const name = sanitizeScopeTemplateText(req.body?.name, 100)
      const description = sanitizeScopeTemplateText(req.body?.description, 255)
      if (!name) return jsonError(res, 400, 'GROUP_NAME_REQUIRED', 'name is required')

      const created = await query<{ id: string }>(
        `INSERT INTO platform_member_groups (
           name, description, created_by, updated_by, created_at, updated_at
         )
         VALUES ($1, NULLIF($2, ''), $3, $3, NOW(), NOW())
         RETURNING id`,
        [name, description, adminUserId],
      )

      const item = await fetchPlatformMemberGroupDetail(created.rows[0].id)
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'create',
        resourceType: 'platform-member-group',
        resourceId: `group:${created.rows[0].id}`,
        meta: {
          name,
        },
      })

      return jsonOk(res, {
        actorId: adminUserId,
        item,
      })
    } catch (error) {
      if (isDatabaseUniqueConstraintError(error)) {
        return jsonError(res, 409, 'PLATFORM_MEMBER_GROUP_NAME_CONFLICT', 'Platform member group name already exists')
      }
      return jsonError(res, 500, 'PLATFORM_MEMBER_GROUP_CREATE_FAILED', (error as Error)?.message || 'Failed to create platform member group')
    }
  })

  r.get('/api/admin/role-delegation/member-groups/:groupId', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const groupId = String(req.params.groupId || '').trim()
      if (!groupId) return jsonError(res, 400, 'GROUP_ID_REQUIRED', 'groupId is required')

      const item = await fetchPlatformMemberGroupDetail(groupId)
      if (!item) return jsonError(res, 404, 'PLATFORM_MEMBER_GROUP_NOT_FOUND', 'Platform member group not found')

      return jsonOk(res, {
        actorId: adminUserId,
        item,
      })
    } catch (error) {
      return jsonError(res, 500, 'PLATFORM_MEMBER_GROUP_READ_FAILED', (error as Error)?.message || 'Failed to load platform member group')
    }
  })

  r.get('/api/admin/role-delegation/scope-templates', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const q = String(req.query.q || '').trim()
      const items = await fetchDelegatedScopeTemplates(q)
      return jsonOk(res, {
        actorId: adminUserId,
        items,
        query: q,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_SCOPE_TEMPLATE_LIST_FAILED', (error as Error)?.message || 'Failed to list scope templates')
    }
  })

  r.post('/api/admin/role-delegation/scope-templates', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const name = sanitizeScopeTemplateText(req.body?.name, 100)
      const description = sanitizeScopeTemplateText(req.body?.description, 255)
      if (!name) return jsonError(res, 400, 'TEMPLATE_NAME_REQUIRED', 'name is required')

      const created = await query<{ id: string }>(
        `INSERT INTO delegated_role_scope_templates (
           name, description, created_by, updated_by, created_at, updated_at
         )
         VALUES ($1, NULLIF($2, ''), $3, $3, NOW(), NOW())
         RETURNING id`,
        [name, description, adminUserId],
      )

      const template = await fetchDelegatedScopeTemplateDetail(created.rows[0].id)
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'create',
        resourceType: 'delegated-admin-scope-template',
        resourceId: `template:${created.rows[0].id}`,
        meta: {
          name,
        },
      })

      return jsonOk(res, {
        actorId: adminUserId,
        item: template,
      })
    } catch (error) {
      if (isDatabaseUniqueConstraintError(error)) {
        return jsonError(res, 409, 'ROLE_DELEGATION_SCOPE_TEMPLATE_NAME_CONFLICT', 'Scope template name already exists')
      }
      return jsonError(res, 500, 'ROLE_DELEGATION_SCOPE_TEMPLATE_CREATE_FAILED', (error as Error)?.message || 'Failed to create scope template')
    }
  })

  r.get('/api/admin/role-delegation/scope-templates/:templateId', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const templateId = String(req.params.templateId || '').trim()
      if (!templateId) return jsonError(res, 400, 'TEMPLATE_ID_REQUIRED', 'templateId is required')

      const item = await fetchDelegatedScopeTemplateDetail(templateId)
      if (!item) return jsonError(res, 404, 'ROLE_DELEGATION_SCOPE_TEMPLATE_NOT_FOUND', 'Scope template not found')

      return jsonOk(res, {
        actorId: adminUserId,
        item,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_SCOPE_TEMPLATE_READ_FAILED', (error as Error)?.message || 'Failed to load scope template')
    }
  })

  r.post('/api/admin/role-delegation/scope-templates/:templateId/departments/:action(assign|unassign)', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const templateId = String(req.params.templateId || '').trim()
      const action = String(req.params.action || '').trim()
      const directoryDepartmentId = String(req.body?.directoryDepartmentId || '').trim()
      if (!templateId) return jsonError(res, 400, 'TEMPLATE_ID_REQUIRED', 'templateId is required')
      if (!directoryDepartmentId) return jsonError(res, 400, 'DIRECTORY_DEPARTMENT_REQUIRED', 'directoryDepartmentId is required')

      const templateExists = await query<{ id: string }>(
        'SELECT id FROM delegated_role_scope_templates WHERE id = $1 LIMIT 1',
        [templateId],
      )
      if (!templateExists.rows.length) {
        return jsonError(res, 404, 'ROLE_DELEGATION_SCOPE_TEMPLATE_NOT_FOUND', 'Scope template not found')
      }

      if (action === 'assign') {
        const department = await query<{ id: string }>(
          `SELECT id
           FROM directory_departments
           WHERE id = $1
             AND is_active = true
           LIMIT 1`,
          [directoryDepartmentId],
        )
        if (!department.rows.length) {
          return jsonError(res, 404, 'DIRECTORY_DEPARTMENT_NOT_FOUND', 'Directory department not found')
        }
        await query(
          `INSERT INTO delegated_role_scope_template_departments (
             template_id, directory_department_id, created_at
           )
           VALUES ($1, $2, NOW())
           ON CONFLICT DO NOTHING`,
          [templateId, directoryDepartmentId],
        )
      } else {
        await query(
          `DELETE FROM delegated_role_scope_template_departments
           WHERE template_id = $1
             AND directory_department_id = $2`,
          [templateId, directoryDepartmentId],
        )
      }

      await query(
        `UPDATE delegated_role_scope_templates
         SET updated_by = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [templateId, adminUserId],
      )

      const item = await fetchDelegatedScopeTemplateDetail(templateId)
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: action === 'assign' ? 'grant' : 'revoke',
        resourceType: 'delegated-admin-scope-template',
        resourceId: `template:${templateId}:${directoryDepartmentId}`,
        meta: {
          templateId,
          directoryDepartmentId,
        },
      })

      return jsonOk(res, {
        actorId: adminUserId,
        item,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_SCOPE_TEMPLATE_UPDATE_FAILED', (error as Error)?.message || 'Failed to update scope template departments')
    }
  })

  r.post('/api/admin/role-delegation/scope-templates/:templateId/member-groups/:action(assign|unassign)', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const templateId = String(req.params.templateId || '').trim()
      const action = String(req.params.action || '').trim()
      const groupId = String(req.body?.groupId || '').trim()
      if (!templateId) return jsonError(res, 400, 'TEMPLATE_ID_REQUIRED', 'templateId is required')
      if (!groupId) return jsonError(res, 400, 'GROUP_ID_REQUIRED', 'groupId is required')

      const [templateExists, groupExists] = await Promise.all([
        query<{ id: string }>(
          'SELECT id FROM delegated_role_scope_templates WHERE id = $1 LIMIT 1',
          [templateId],
        ),
        query<{ id: string }>(
          'SELECT id FROM platform_member_groups WHERE id = $1 LIMIT 1',
          [groupId],
        ),
      ])
      if (!templateExists.rows.length) {
        return jsonError(res, 404, 'ROLE_DELEGATION_SCOPE_TEMPLATE_NOT_FOUND', 'Scope template not found')
      }
      if (!groupExists.rows.length) {
        return jsonError(res, 404, 'PLATFORM_MEMBER_GROUP_NOT_FOUND', 'Platform member group not found')
      }

      if (action === 'assign') {
        await query(
          `INSERT INTO delegated_role_scope_template_member_groups (
             template_id, group_id, created_at
           )
           VALUES ($1, $2, NOW())
           ON CONFLICT DO NOTHING`,
          [templateId, groupId],
        )
      } else {
        await query(
          `DELETE FROM delegated_role_scope_template_member_groups
           WHERE template_id = $1
             AND group_id = $2`,
          [templateId, groupId],
        )
      }

      await query(
        `UPDATE delegated_role_scope_templates
         SET updated_by = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [templateId, adminUserId],
      )

      const item = await fetchDelegatedScopeTemplateDetail(templateId)
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: action === 'assign' ? 'grant' : 'revoke',
        resourceType: 'delegated-admin-scope-template',
        resourceId: `template:${templateId}:group:${groupId}`,
        meta: {
          templateId,
          groupId,
        },
      })

      return jsonOk(res, {
        actorId: adminUserId,
        item,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_SCOPE_TEMPLATE_GROUP_UPDATE_FAILED', (error as Error)?.message || 'Failed to update scope template member groups')
    }
  })

  r.get('/api/admin/role-delegation/users/:userId/scopes', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const [profile, roleIds, scopeAssignments, groupAssignments] = await Promise.all([
        fetchUserProfile(userId),
        fetchUserRoleIds(userId),
        fetchDelegatedScopeAssignments(userId),
        fetchDelegatedGroupAssignments(userId),
      ])
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      const adminNamespaces = deriveDelegableNamespaces(roleIds)

      return jsonOk(res, {
        actorId: adminUserId,
        user: profile,
        adminNamespaces,
        scopeAssignments: scopeAssignments.filter((scope) => adminNamespaces.includes(scope.namespace)),
        groupAssignments: groupAssignments.filter((assignment) => adminNamespaces.includes(assignment.namespace)),
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_SCOPE_READ_FAILED', (error as Error)?.message || 'Failed to load delegated admin scopes')
    }
  })

  r.post('/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      const action = String(req.params.action || '').trim()
      const namespace = String(req.body?.namespace || '').trim()
      const directoryDepartmentId = String(req.body?.directoryDepartmentId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')
      if (!namespace) return jsonError(res, 400, 'NAMESPACE_REQUIRED', 'namespace is required')
      if (!directoryDepartmentId) return jsonError(res, 400, 'DIRECTORY_DEPARTMENT_REQUIRED', 'directoryDepartmentId is required')

      const [profile, roleIds] = await Promise.all([
        fetchUserProfile(userId),
        fetchUserRoleIds(userId),
      ])
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      const adminNamespaces = deriveDelegableNamespaces(roleIds)
      if (action === 'assign' && !adminNamespaces.includes(namespace)) {
        return jsonError(res, 409, 'ROLE_DELEGATION_NAMESPACE_NOT_HELD', 'Selected user does not hold that delegated admin namespace')
      }

      if (action === 'assign') {
        const department = await query<{ id: string }>(
          `SELECT id
           FROM directory_departments
           WHERE id = $1
             AND is_active = true
           LIMIT 1`,
          [directoryDepartmentId],
        )
        if (!department.rows.length) {
          return jsonError(res, 404, 'DIRECTORY_DEPARTMENT_NOT_FOUND', 'Directory department not found')
        }
        await query(
          `INSERT INTO delegated_role_admin_scopes (
             admin_user_id, namespace, directory_department_id, created_by, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (admin_user_id, namespace, directory_department_id)
           DO UPDATE SET
             created_by = EXCLUDED.created_by,
             updated_at = NOW()`,
          [userId, namespace, directoryDepartmentId, adminUserId],
        )
      } else {
        await query(
          `DELETE FROM delegated_role_admin_scopes
           WHERE admin_user_id = $1
             AND namespace = $2
             AND directory_department_id = $3`,
          [userId, namespace, directoryDepartmentId],
        )
      }

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: action === 'assign' ? 'grant' : 'revoke',
        resourceType: 'delegated-admin-scope',
        resourceId: `${userId}:${namespace}:${directoryDepartmentId}`,
        meta: {
          userId,
          namespace,
          directoryDepartmentId,
        },
      })

      const [scopeAssignments, groupAssignments] = await Promise.all([
        fetchDelegatedScopeAssignments(userId),
        fetchDelegatedGroupAssignments(userId),
      ])
      return jsonOk(res, {
        actorId: adminUserId,
        user: profile,
        adminNamespaces,
        scopeAssignments,
        groupAssignments,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_SCOPE_UPDATE_FAILED', (error as Error)?.message || 'Failed to update delegated admin scope')
    }
  })

  r.post('/api/admin/role-delegation/users/:userId/scope-groups/:action(assign|unassign)', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      const action = String(req.params.action || '').trim()
      const namespace = String(req.body?.namespace || '').trim()
      const groupId = String(req.body?.groupId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')
      if (!namespace) return jsonError(res, 400, 'NAMESPACE_REQUIRED', 'namespace is required')
      if (!groupId) return jsonError(res, 400, 'GROUP_ID_REQUIRED', 'groupId is required')

      const [profile, roleIds, groupRow] = await Promise.all([
        fetchUserProfile(userId),
        fetchUserRoleIds(userId),
        query<{ id: string }>('SELECT id FROM platform_member_groups WHERE id = $1 LIMIT 1', [groupId]),
      ])
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')
      if (!groupRow.rows.length) return jsonError(res, 404, 'PLATFORM_MEMBER_GROUP_NOT_FOUND', 'Platform member group not found')

      const adminNamespaces = deriveDelegableNamespaces(roleIds)
      if (action === 'assign' && !adminNamespaces.includes(namespace)) {
        return jsonError(res, 409, 'ROLE_DELEGATION_NAMESPACE_NOT_HELD', 'Selected user does not hold that delegated admin namespace')
      }

      if (action === 'assign') {
        await query(
          `INSERT INTO delegated_role_admin_member_groups (
             admin_user_id, namespace, group_id, created_by, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (admin_user_id, namespace, group_id)
           DO UPDATE SET
             created_by = EXCLUDED.created_by,
             updated_at = NOW()`,
          [userId, namespace, groupId, adminUserId],
        )
      } else {
        await query(
          `DELETE FROM delegated_role_admin_member_groups
           WHERE admin_user_id = $1
             AND namespace = $2
             AND group_id = $3`,
          [userId, namespace, groupId],
        )
      }

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: action === 'assign' ? 'grant' : 'revoke',
        resourceType: 'delegated-admin-group-scope',
        resourceId: `${userId}:${namespace}:group:${groupId}`,
        meta: {
          userId,
          namespace,
          groupId,
        },
      })

      const [scopeAssignments, groupAssignments] = await Promise.all([
        fetchDelegatedScopeAssignments(userId),
        fetchDelegatedGroupAssignments(userId),
      ])

      return jsonOk(res, {
        actorId: adminUserId,
        user: profile,
        adminNamespaces,
        scopeAssignments,
        groupAssignments,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_GROUP_SCOPE_UPDATE_FAILED', (error as Error)?.message || 'Failed to update delegated admin member-group scope')
    }
  })

  r.post('/api/admin/role-delegation/users/:userId/member-groups/:action(assign|unassign)', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      const action = String(req.params.action || '').trim()
      const groupId = String(req.body?.groupId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')
      if (!groupId) return jsonError(res, 400, 'GROUP_ID_REQUIRED', 'groupId is required')

      const [profile, groupRow] = await Promise.all([
        fetchUserProfile(userId),
        query<{ id: string }>('SELECT id FROM platform_member_groups WHERE id = $1 LIMIT 1', [groupId]),
      ])
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')
      if (!groupRow.rows.length) return jsonError(res, 404, 'PLATFORM_MEMBER_GROUP_NOT_FOUND', 'Platform member group not found')

      if (action === 'assign') {
        await query(
          `INSERT INTO platform_member_group_members (group_id, user_id, created_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT DO NOTHING`,
          [groupId, userId],
        )
      } else {
        await query(
          `DELETE FROM platform_member_group_members
           WHERE group_id = $1
             AND user_id = $2`,
          [groupId, userId],
        )
      }

      const [snapshot, memberGroups] = await Promise.all([
        fetchUserAccessSnapshot(userId),
        fetchPlatformMemberGroupMembershipsForUser(userId),
      ])

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: action === 'assign' ? 'grant' : 'revoke',
        resourceType: 'platform-member-group',
        resourceId: `${groupId}:${userId}`,
        meta: {
          groupId,
          userId,
        },
      })

      return jsonOk(res, {
        actorId: adminUserId,
        user: snapshot?.user ?? profile,
        roles: snapshot?.roles ?? [],
        permissions: snapshot?.permissions ?? [],
        isAdmin: snapshot?.isAdmin ?? false,
        memberGroups,
      })
    } catch (error) {
      return jsonError(res, 500, 'PLATFORM_MEMBER_GROUP_MEMBER_UPDATE_FAILED', (error as Error)?.message || 'Failed to update platform member group membership')
    }
  })

  r.post('/api/admin/role-delegation/users/:userId/scope-templates/apply', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      const namespace = String(req.body?.namespace || '').trim()
      const templateId = String(req.body?.templateId || '').trim()
      const mode = String(req.body?.mode || 'replace').trim().toLowerCase()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')
      if (!namespace) return jsonError(res, 400, 'NAMESPACE_REQUIRED', 'namespace is required')
      if (!templateId) return jsonError(res, 400, 'TEMPLATE_ID_REQUIRED', 'templateId is required')
      if (!['replace', 'merge'].includes(mode)) return jsonError(res, 400, 'ROLE_DELEGATION_SCOPE_TEMPLATE_MODE_INVALID', 'mode must be replace or merge')

      const [profile, roleIds, template] = await Promise.all([
        fetchUserProfile(userId),
        fetchUserRoleIds(userId),
        fetchDelegatedScopeTemplateDetail(templateId),
      ])
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')
      if (!template) return jsonError(res, 404, 'ROLE_DELEGATION_SCOPE_TEMPLATE_NOT_FOUND', 'Scope template not found')

      const adminNamespaces = deriveDelegableNamespaces(roleIds)
      if (!adminNamespaces.includes(namespace)) {
        return jsonError(res, 409, 'ROLE_DELEGATION_NAMESPACE_NOT_HELD', 'Selected user does not hold that delegated admin namespace')
      }
      if (template.departments.length === 0 && template.memberGroups.length === 0) {
        return jsonError(res, 409, 'ROLE_DELEGATION_SCOPE_TEMPLATE_EMPTY', 'Scope template has no departments or member groups to apply')
      }

      if (mode === 'replace') {
        await Promise.all([
          query(
            `DELETE FROM delegated_role_admin_scopes
             WHERE admin_user_id = $1
               AND namespace = $2`,
            [userId, namespace],
          ),
          query(
            `DELETE FROM delegated_role_admin_member_groups
             WHERE admin_user_id = $1
               AND namespace = $2`,
            [userId, namespace],
          ),
        ])
      }

      for (const department of template.departments) {
        await query(
          `INSERT INTO delegated_role_admin_scopes (
             admin_user_id, namespace, directory_department_id, created_by, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (admin_user_id, namespace, directory_department_id)
           DO UPDATE SET
             created_by = EXCLUDED.created_by,
             updated_at = NOW()`,
          [userId, namespace, department.directoryDepartmentId, adminUserId],
        )
      }

      for (const group of template.memberGroups) {
        await query(
          `INSERT INTO delegated_role_admin_member_groups (
             admin_user_id, namespace, group_id, created_by, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (admin_user_id, namespace, group_id)
           DO UPDATE SET
             created_by = EXCLUDED.created_by,
             updated_at = NOW()`,
          [userId, namespace, group.id, adminUserId],
        )
      }

      const [scopeAssignments, groupAssignments] = await Promise.all([
        fetchDelegatedScopeAssignments(userId),
        fetchDelegatedGroupAssignments(userId),
      ])
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'grant',
        resourceType: 'delegated-admin-scope-template',
        resourceId: `${userId}:${namespace}:template:${templateId}`,
        meta: {
          userId,
          namespace,
          templateId,
          mode,
          departmentCount: template.departments.length,
          memberGroupCount: template.memberGroups.length,
        },
      })

      return jsonOk(res, {
        actorId: adminUserId,
        user: profile,
        adminNamespaces,
        scopeAssignments: scopeAssignments.filter((scope) => adminNamespaces.includes(scope.namespace)),
        groupAssignments: groupAssignments.filter((assignment) => adminNamespaces.includes(assignment.namespace)),
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_SCOPE_TEMPLATE_APPLY_FAILED', (error as Error)?.message || 'Failed to apply scope template')
    }
  })

  r.get('/api/admin/role-delegation/users', authenticate, async (req: Request, res: Response) => {
    const delegation = await ensureRoleDelegationAdmin(req, res)
    if (!delegation) return

    try {
      const q = String(req.query.q || '').trim()
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })

      const [scopeAssignments, groupAssignments, scopedList] = delegation.isPlatformAdmin
        ? await Promise.all([
          Promise.resolve([]),
          Promise.resolve([]),
          (async () => {
            const term = q ? `%${q}%` : '%'
            const where = q ? 'WHERE email ILIKE $1 OR name ILIKE $1 OR id ILIKE $1' : ''
            const countSql = `SELECT COUNT(*)::int AS c FROM users ${where}`
            const listSql = `
              SELECT id, email, name, role, is_active, is_admin, last_login_at, created_at, updated_at
              FROM users
              ${where}
              ORDER BY created_at DESC
              LIMIT $${q ? 2 : 1} OFFSET $${q ? 3 : 2}
            `

            const count = await query<{ c: number }>(countSql, q ? [term] : undefined)
            const list = await query<AdminUserProfile>(listSql, q ? [term, pageSize, offset] : [pageSize, offset])
            return {
              total: count.rows[0]?.c ?? 0,
              items: list.rows,
            }
          })(),
        ])
        : await Promise.all([
          fetchDelegatedScopeAssignments(delegation.actorId, delegation.delegableNamespaces),
          fetchDelegatedGroupAssignments(delegation.actorId, delegation.delegableNamespaces),
          fetchScopedDelegationUsers(delegation.actorId, delegation.delegableNamespaces, q, pageSize, offset),
        ])

      return jsonOk(res, {
        items: scopedList.items,
        page,
        pageSize,
        total: scopedList.total,
        actorId: delegation.actorId,
        isPlatformAdmin: delegation.isPlatformAdmin,
        delegableNamespaces: delegation.delegableNamespaces,
        scopeAssignments,
        groupAssignments,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_USER_LIST_FAILED', (error as Error)?.message || 'Failed to list delegation users')
    }
  })

  r.get('/api/admin/role-delegation/users/:userId/access', authenticate, async (req: Request, res: Response) => {
    const delegation = await ensureRoleDelegationAdmin(req, res)
    if (!delegation) return

    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const [scopeAssignments, groupAssignments] = delegation.isPlatformAdmin
        ? await Promise.all([Promise.resolve([]), Promise.resolve([])])
        : await Promise.all([
          fetchDelegatedScopeAssignments(delegation.actorId, delegation.delegableNamespaces),
          fetchDelegatedGroupAssignments(delegation.actorId, delegation.delegableNamespaces),
        ])
      if (!delegation.isPlatformAdmin && !hasDelegatedAudienceAssignments(scopeAssignments, groupAssignments)) {
        return jsonError(res, 403, 'ROLE_DELEGATION_SCOPE_REQUIRED', 'No delegated department or member-group scope is configured for your plugin admin role')
      }
      if (!delegation.isPlatformAdmin) {
        const allowed = await isUserWithinDelegatedScope(delegation.actorId, delegation.delegableNamespaces, userId)
        if (!allowed) {
          return jsonError(res, 403, 'ROLE_DELEGATION_USER_OUT_OF_SCOPE', 'User is outside your delegated department or member-group scope')
        }
      }

      const visibleMemberGroupIds = delegation.isPlatformAdmin
        ? undefined
        : deriveVisibleDelegatedMemberGroupIds(groupAssignments)
      const [snapshot, memberGroups, namespaceAdmissions] = await Promise.all([
        fetchUserAccessSnapshot(userId),
        fetchPlatformMemberGroupMembershipsForUser(userId, visibleMemberGroupIds),
        fetchVisibleNamespaceAdmissions(
          userId,
          delegation.isPlatformAdmin ? undefined : delegation.delegableNamespaces,
        ),
      ])
      if (!snapshot) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      const roleCatalog = await fetchDelegatedRoleCatalog(
        delegation.isPlatformAdmin ? undefined : delegation.delegableNamespaces,
      )

      return jsonOk(res, {
        actorId: delegation.actorId,
        isPlatformAdmin: delegation.isPlatformAdmin,
        delegableNamespaces: delegation.delegableNamespaces,
        scopeAssignments,
        groupAssignments,
        roleCatalog,
        user: snapshot.user,
        roles: snapshot.roles,
        memberGroups,
        namespaceAdmissions,
        delegableRoles: delegation.isPlatformAdmin
          ? snapshot.roles
          : snapshot.roles.filter((roleId) => roleIdMatchesNamespaces(roleId, delegation.delegableNamespaces)),
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_ACCESS_FAILED', (error as Error)?.message || 'Failed to load delegated user access')
    }
  })

  r.patch('/api/admin/role-delegation/users/:userId/namespaces/:namespace/admission', authenticate, async (req: Request, res: Response) => {
    const delegation = await ensureRoleDelegationAdmin(req, res)
    if (!delegation) return

    try {
      const userId = String(req.params.userId || '').trim()
      const namespace = normalizeNamespace(req.params.namespace)
      const enabled = req.body?.enabled
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')
      if (!namespace) return jsonError(res, 400, 'NAMESPACE_REQUIRED', 'namespace is required')
      if (typeof enabled !== 'boolean') return jsonError(res, 400, 'ENABLED_REQUIRED', 'enabled boolean is required')
      if (!isNamespaceAdmissionControlledResource(namespace)) {
        return jsonError(res, 400, 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls')
      }
      if (!delegation.isPlatformAdmin && !delegation.delegableNamespaces.includes(namespace)) {
        return jsonError(res, 403, 'ROLE_DELEGATION_FORBIDDEN', 'Namespace is outside your delegated admin scope')
      }

      const [profile, scopeAssignments, groupAssignments] = await Promise.all([
        fetchUserProfile(userId),
        delegation.isPlatformAdmin
          ? Promise.resolve([])
          : fetchDelegatedScopeAssignments(delegation.actorId, delegation.delegableNamespaces),
        delegation.isPlatformAdmin
          ? Promise.resolve([])
          : fetchDelegatedGroupAssignments(delegation.actorId, delegation.delegableNamespaces),
      ])
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')
      if (!delegation.isPlatformAdmin && !hasDelegatedAudienceAssignments(scopeAssignments, groupAssignments)) {
        return jsonError(res, 403, 'ROLE_DELEGATION_SCOPE_REQUIRED', 'No delegated department or member-group scope is configured for your plugin admin role')
      }
      if (!delegation.isPlatformAdmin) {
        const allowed = await isUserWithinDelegatedScope(delegation.actorId, [namespace], userId)
        if (!allowed) {
          return jsonError(res, 403, 'ROLE_DELEGATION_USER_OUT_OF_SCOPE', 'User is outside your delegated department or member-group scope')
        }
      }

      const namespaceAdmissions = await setUserNamespaceAdmission({
        userId,
        namespace,
        enabled,
        actorId: delegation.actorId,
        source: delegation.isPlatformAdmin ? 'platform_admin' : 'delegated_admin',
      })
      invalidateUserPerms(userId)

      await auditLog({
        actorId: delegation.actorId,
        actorType: 'user',
        action: enabled ? 'grant' : 'revoke',
        resourceType: 'user-namespace-admission',
        resourceId: `${userId}:${namespace}`,
        meta: {
          adminUserId: delegation.actorId,
          userId,
          namespace,
          enabled,
          delegated: !delegation.isPlatformAdmin,
          delegableNamespaces: delegation.delegableNamespaces,
        },
      })

      return jsonOk(res, {
        actorId: delegation.actorId,
        isPlatformAdmin: delegation.isPlatformAdmin,
        delegableNamespaces: delegation.delegableNamespaces,
        scopeAssignments,
        groupAssignments,
        namespaceAdmissions: delegation.isPlatformAdmin
          ? namespaceAdmissions
          : namespaceAdmissions.filter((admission) => delegation.delegableNamespaces.includes(admission.namespace)),
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_ADMISSION_FAILED', (error as Error)?.message || 'Failed to update delegated namespace admission')
    }
  })

  r.post('/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', authenticate, async (req: Request, res: Response) => {
    const delegation = await ensureRoleDelegationAdmin(req, res)
    if (!delegation) return

    try {
      const userId = String(req.params.userId || '').trim()
      const action = String(req.params.action || '').trim()
      const roleId = String(req.body?.roleId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')
      if (!roleId) return jsonError(res, 400, 'ROLE_REQUIRED', 'roleId is required')

      const [profile, roleRow] = await Promise.all([
        fetchUserProfile(userId),
        query<{ id: string }>('SELECT id FROM roles WHERE id = $1', [roleId]),
      ])
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')
      if (!roleRow.rows.length) return jsonError(res, 404, 'ROLE_NOT_FOUND', 'Role not found')
      if (!delegation.isPlatformAdmin && !roleIdMatchesNamespaces(roleId, delegation.delegableNamespaces)) {
        return jsonError(res, 403, 'ROLE_DELEGATION_FORBIDDEN', 'Role is outside your delegated namespaces')
      }

      const [scopeAssignments, groupAssignments] = delegation.isPlatformAdmin
        ? await Promise.all([Promise.resolve([]), Promise.resolve([])])
        : await Promise.all([
          fetchDelegatedScopeAssignments(delegation.actorId, delegation.delegableNamespaces),
          fetchDelegatedGroupAssignments(delegation.actorId, delegation.delegableNamespaces),
        ])
      if (!delegation.isPlatformAdmin && !hasDelegatedAudienceAssignments(scopeAssignments, groupAssignments)) {
        return jsonError(res, 403, 'ROLE_DELEGATION_SCOPE_REQUIRED', 'No delegated department or member-group scope is configured for your plugin admin role')
      }
      if (!delegation.isPlatformAdmin) {
        const scopedNamespaces = deriveMatchingNamespacesForRole(roleId, delegation.delegableNamespaces)
        const allowed = await isUserWithinDelegatedScope(delegation.actorId, scopedNamespaces, userId)
        if (!allowed) {
          return jsonError(res, 403, 'ROLE_DELEGATION_USER_OUT_OF_SCOPE', 'User is outside your delegated department or member-group scope')
        }
      }

      if (action === 'assign') {
        await query(
          `INSERT INTO user_roles (user_id, role_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [userId, roleId],
        )
      } else {
        await query(
          `DELETE FROM user_roles
           WHERE user_id = $1 AND role_id = $2`,
          [userId, roleId],
        )
      }
      if (roleId === PLATFORM_ADMIN_ROLE_ID) {
        await syncLegacyAdminProfile(userId, action === 'assign')
      }
      const disabledNamespaces = action === 'assign'
        ? []
        : await disableNamespaceAdmissionsWithoutRoles({
          userId,
          namespaces: await listRoleNamespaces(roleId),
          actorId: delegation.actorId,
          source: 'role_unassigned',
        })
      invalidateUserPerms(userId)

      await auditLog({
        actorId: delegation.actorId,
        actorType: 'user',
        action: action === 'assign' ? 'grant' : 'revoke',
        resourceType: 'user-role',
        resourceId: `${userId}:${roleId}`,
        meta: {
          adminUserId: delegation.actorId,
          userId,
          roleId,
          delegated: !delegation.isPlatformAdmin,
          delegableNamespaces: delegation.delegableNamespaces,
          disabledNamespaces,
        },
      })

      const [snapshot, memberGroups, namespaceAdmissions] = await Promise.all([
        fetchUserAccessSnapshot(userId),
        fetchPlatformMemberGroupMembershipsForUser(userId),
        fetchVisibleNamespaceAdmissions(
          userId,
          delegation.isPlatformAdmin ? undefined : delegation.delegableNamespaces,
        ),
      ])
      const roleCatalog = await fetchDelegatedRoleCatalog(
        delegation.isPlatformAdmin ? undefined : delegation.delegableNamespaces,
      )

      return jsonOk(res, {
        actorId: delegation.actorId,
        isPlatformAdmin: delegation.isPlatformAdmin,
        delegableNamespaces: delegation.delegableNamespaces,
        scopeAssignments,
        groupAssignments,
        roleCatalog,
        user: snapshot?.user ?? profile,
        roles: snapshot?.roles ?? [],
        memberGroups,
        namespaceAdmissions,
        delegableRoles: delegation.isPlatformAdmin
          ? snapshot?.roles ?? []
          : (snapshot?.roles ?? []).filter((candidateRoleId) => roleIdMatchesNamespaces(candidateRoleId, delegation.delegableNamespaces)),
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_DELEGATION_UPDATE_FAILED', (error as Error)?.message || 'Failed to update delegated role')
    }
  })

  r.get('/api/admin/users', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const q = String(req.query.q || '').trim()
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })

      const term = q ? `%${q}%` : '%'
      const where = q ? 'WHERE email ILIKE $1 OR name ILIKE $1 OR id ILIKE $1' : ''
      const countSql = `SELECT COUNT(*)::int AS c FROM users ${where}`
      const listSql = `
        SELECT id, email, name, role, is_active, is_admin, last_login_at, created_at, updated_at
        FROM users
        ${where}
        ORDER BY created_at DESC
        LIMIT $${q ? 2 : 1} OFFSET $${q ? 3 : 2}
      `

      const count = await query<{ c: number }>(countSql, q ? [term] : undefined)
      const total = count.rows[0]?.c ?? 0
      const list = await query<AdminUserProfile>(listSql, q ? [term, pageSize, offset] : [pageSize, offset])

      return jsonOk(res, {
        items: list.rows,
        page,
        pageSize,
        total,
        query: q,
        actorId: adminUserId,
      })
    } catch (error) {
      return jsonError(res, 500, 'USER_LIST_FAILED', (error as Error)?.message || 'Failed to list users')
    }
  })

  r.get('/api/admin/access-presets', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    const mode = String(req.query.mode || '').trim()
    const items = listAccessPresets().filter((preset) => !mode || preset.productMode === mode)

    return jsonOk(res, {
      items,
      actorId: adminUserId,
    })
  })

  r.get('/api/admin/invites', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const q = String(req.query.q || '').trim()
      const status = String(req.query.status || '').trim()
      const userId = String(req.query.userId || '').trim()
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })

      const where: string[] = []
      const values: unknown[] = []

      if (userId) {
        values.push(userId)
        where.push(`inv.user_id = $${values.length}`)
      }

      if (status) {
        values.push(status)
        where.push(`inv.status = $${values.length}`)
      }

      if (q) {
        values.push(`%${q}%`)
        where.push(
          `(inv.email ILIKE $${values.length}
            OR COALESCE(u.name, '') ILIKE $${values.length}
            OR COALESCE(inv.preset_id, '') ILIKE $${values.length}
            OR COALESCE(inv.product_mode, '') ILIKE $${values.length})`,
        )
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const countResult = await query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
         FROM user_invites inv
         LEFT JOIN users u ON u.id = inv.user_id
         ${whereSql}`,
        values,
      )

      values.push(pageSize, offset)
      const rows = await query<AdminInviteLedgerRow>(
        `SELECT
            inv.id,
            inv.user_id,
            inv.email,
            inv.preset_id,
            inv.product_mode,
            inv.role_id,
            inv.invited_by,
            inv.invite_token,
            inv.status,
            inv.accepted_at,
            inv.consumed_by,
            inv.last_sent_at,
            inv.created_at,
            inv.updated_at,
            u.name AS user_name,
            inviter.email AS invited_by_email,
            inviter.name AS invited_by_name
         FROM user_invites inv
         LEFT JOIN users u ON u.id = inv.user_id
         LEFT JOIN users inviter ON inviter.id = inv.invited_by
         ${whereSql}
         ORDER BY inv.created_at DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      )

      return jsonOk(res, {
        items: rows.rows.map(normalizeInviteLedgerRow),
        page,
        pageSize,
        total: countResult.rows[0]?.c ?? 0,
        actorId: adminUserId,
      })
    } catch (error) {
      if (isDatabaseSchemaError(error)) {
        return jsonOk(res, {
          items: [],
          page: 1,
          pageSize: 20,
          total: 0,
          actorId: adminUserId,
          degraded: true,
        })
      }
      return jsonError(res, 500, 'INVITE_LEDGER_LIST_FAILED', (error as Error)?.message || 'Failed to load invite ledger')
    }
  })

  r.post('/api/admin/invites/:inviteId/revoke', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const inviteId = String(req.params.inviteId || '').trim()
      if (!inviteId) return jsonError(res, 400, 'INVITE_ID_REQUIRED', 'inviteId is required')

      const result = await query<AdminInviteLedgerRow>(
        `UPDATE user_invites
         SET status = 'revoked',
             updated_at = NOW()
         WHERE id = $1
           AND status = 'pending'
         RETURNING id, user_id, email, preset_id, product_mode, role_id, invited_by, invite_token, status, accepted_at, consumed_by, last_sent_at, created_at, updated_at,
                   NULL::text AS user_name,
                   NULL::text AS invited_by_email,
                   NULL::text AS invited_by_name`,
        [inviteId],
      )

      const invite = result.rows[0]
      if (!invite) {
        return jsonError(res, 404, 'INVITE_NOT_FOUND', 'Pending invite not found')
      }

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'revoke',
        resourceType: 'user-invite',
        resourceId: inviteId,
        meta: {
          adminUserId,
          inviteId,
          userId: invite.user_id,
          email: invite.email,
          status: invite.status,
          productMode: invite.product_mode,
        },
      })

      return jsonOk(res, {
        item: invite,
        actorId: adminUserId,
      })
    } catch (error) {
      if (isDatabaseSchemaError(error)) {
        return jsonError(res, 503, 'INVITE_LEDGER_UNAVAILABLE', 'Invite ledger is not available until migrations are applied')
      }
      return jsonError(res, 500, 'INVITE_REVOKE_FAILED', (error as Error)?.message || 'Failed to revoke invite')
    }
  })

  r.post('/api/admin/invites/:inviteId/resend', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const inviteId = String(req.params.inviteId || '').trim()
      if (!inviteId) return jsonError(res, 400, 'INVITE_ID_REQUIRED', 'inviteId is required')

      const currentResult = await query<AdminInviteLedgerRow>(
        `SELECT
            inv.id,
            inv.user_id,
            inv.email,
            inv.preset_id,
            inv.product_mode,
            inv.role_id,
            inv.invited_by,
            inv.invite_token,
            inv.status,
            inv.accepted_at,
            inv.consumed_by,
            inv.last_sent_at,
            inv.created_at,
            inv.updated_at,
            u.name AS user_name,
            inviter.email AS invited_by_email,
            inviter.name AS invited_by_name
         FROM user_invites inv
         LEFT JOIN users u ON u.id = inv.user_id
         LEFT JOIN users inviter ON inviter.id = inv.invited_by
         WHERE inv.id = $1`,
        [inviteId],
      )

      const current = currentResult.rows[0]
      if (!current) {
        return jsonError(res, 404, 'INVITE_NOT_FOUND', 'Invite not found')
      }

      const normalized = normalizeInviteLedgerRow(current)
      if (normalized.status === 'accepted') {
        return jsonError(res, 409, 'INVITE_ALREADY_ACCEPTED', 'Accepted invite cannot be resent')
      }

      const inviteToken = issueInviteToken({
        userId: current.user_id,
        email: current.email,
        presetId: current.preset_id,
      })

      const updateResult = await query<AdminInviteLedgerRow>(
        `UPDATE user_invites
         SET invite_token = $2,
             status = 'pending',
             accepted_at = NULL,
             consumed_by = NULL,
             invited_by = $3,
             last_sent_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, user_id, email, preset_id, product_mode, role_id, invited_by, invite_token, status, accepted_at, consumed_by, last_sent_at, created_at, updated_at,
                   NULL::text AS user_name,
                   NULL::text AS invited_by_email,
                   NULL::text AS invited_by_name`,
        [inviteId, inviteToken, adminUserId],
      )

      const invite = updateResult.rows[0]
      if (!invite) {
        return jsonError(res, 404, 'INVITE_NOT_FOUND', 'Invite not found')
      }

      const preset = getAccessPreset(invite.preset_id)
      const onboarding = buildOnboardingPacket({
        email: invite.email,
        temporaryPassword: null,
        preset,
        inviteToken,
      })

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'update',
        resourceType: 'user-invite',
        resourceId: inviteId,
        meta: {
          adminUserId,
          inviteId,
          userId: invite.user_id,
          email: invite.email,
          previousStatus: normalized.status,
          status: 'pending',
          productMode: invite.product_mode,
          presetId: invite.preset_id,
          reissued: true,
        },
      })

      return jsonOk(res, {
        item: invite,
        inviteToken,
        onboarding,
        actorId: adminUserId,
      })
    } catch (error) {
      if (isDatabaseSchemaError(error)) {
        return jsonError(res, 503, 'INVITE_LEDGER_UNAVAILABLE', 'Invite ledger is not available until migrations are applied')
      }
      return jsonError(res, 500, 'INVITE_RESEND_FAILED', (error as Error)?.message || 'Failed to resend invite')
    }
  })

  r.post('/api/admin/users', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const body = (req.body || {}) as CreateUserRequestBody
      const cleanEmail = typeof body.email === 'string' ? sanitizeEmail(body.email) : ''
      const cleanName = typeof body.name === 'string' ? sanitizeName(body.name) : ''
      const preset = getAccessPreset(typeof body.presetId === 'string' ? body.presetId.trim() : '')
      const cleanRole = typeof body.role === 'string' && body.role.trim()
        ? body.role.trim().slice(0, 100)
        : preset?.role || 'user'
      const roleId = typeof body.roleId === 'string' && body.roleId.trim()
        ? body.roleId.trim()
        : preset?.roleId || ''
      const effectiveRole = roleId === PLATFORM_ADMIN_ROLE_ID || cleanRole === 'admin' ? 'admin' : cleanRole
      const isActive = typeof body.isActive === 'boolean' ? body.isActive : true
      const requestedPassword = typeof body.password === 'string' ? body.password.trim() : ''
      const directPermissions = Array.from(new Set(preset?.permissions || []))

      if (!cleanEmail || !cleanName) {
        return jsonError(res, 400, 'USER_FIELDS_REQUIRED', 'email and name are required')
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(cleanEmail)) {
        return jsonError(res, 400, 'INVALID_EMAIL', 'Invalid email format')
      }

      if (cleanName.length < 2 || cleanName.length > 100) {
        return jsonError(res, 400, 'INVALID_NAME', 'Name must be between 2 and 100 characters')
      }

      const password = requestedPassword || generateTemporaryPassword()
      const passwordValidation = validatePassword(password)
      if (!passwordValidation.valid) {
        return jsonError(res, 400, 'PASSWORD_POLICY_FAILED', 'Password does not meet requirements', {
          details: passwordValidation.errors,
        })
      }

      const existing = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [cleanEmail])
      if (existing.rows.length > 0) {
        return jsonError(res, 409, 'USER_ALREADY_EXISTS', 'User with this email already exists')
      }

      if (roleId) {
        const roleRow = await query<{ id: string }>('SELECT id FROM roles WHERE id = $1', [roleId])
        if (!roleRow.rows.length) {
          return jsonError(res, 404, 'ROLE_NOT_FOUND', 'Role not found')
        }
      }

      const userId = crypto.randomUUID()
      const passwordHash = await bcrypt.hash(password, getBcryptSaltRounds())

      await query(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW(), NOW())`,
        [userId, cleanEmail, cleanName, passwordHash, effectiveRole, JSON.stringify(directPermissions), isActive, effectiveRole === 'admin'],
      )

      if (roleId) {
        await query(
          `INSERT INTO user_roles (user_id, role_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [userId, roleId],
        )
        invalidateUserPerms(userId)
      }

      if (directPermissions.length > 0) {
        const values = directPermissions.map((_, index) => `($1, $${index + 2})`).join(', ')
        await query(
          `INSERT INTO user_permissions (user_id, permission_code)
           VALUES ${values}
           ON CONFLICT DO NOTHING`,
          [userId, ...directPermissions],
        )
        invalidateUserPerms(userId)
      }

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'create',
        resourceType: 'user',
        resourceId: userId,
        meta: {
          email: cleanEmail,
          name: cleanName,
          adminUserId,
          role: effectiveRole,
          presetId: preset?.id || null,
          roleId: roleId || null,
          is_active: isActive,
          permissions: directPermissions,
          generatedPassword: requestedPassword.length === 0,
        },
      })

      const snapshot = await fetchUserAccessSnapshot(userId)
      if (!snapshot) {
        return jsonError(res, 500, 'USER_CREATE_FAILED', 'User created but failed to load access snapshot')
      }

      const inviteToken = issueInviteToken({
        userId,
        email: cleanEmail,
        presetId: preset?.id || null,
      })
      await recordInvite({
        userId,
        email: cleanEmail,
        presetId: preset?.id || null,
        productMode: preset?.productMode || 'platform',
        roleId: roleId || preset?.roleId || null,
        invitedBy: adminUserId,
        inviteToken,
      })

      return jsonOk(res, {
        ...snapshot,
        actorId: adminUserId,
        temporaryPassword: requestedPassword.length === 0 ? password : undefined,
        inviteToken,
        onboarding: buildOnboardingPacket({
          email: cleanEmail,
          temporaryPassword: requestedPassword.length === 0 ? password : null,
          preset,
          inviteToken,
        }),
      })
    } catch (error) {
      return jsonError(res, 500, 'USER_CREATE_FAILED', (error as Error)?.message || 'Failed to create user')
    }
  })

  r.get('/api/admin/users/:userId/access', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const snapshot = await fetchUserAccessSnapshot(userId)
      if (!snapshot) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      return jsonOk(res, { ...snapshot, actorId: adminUserId })
    } catch (error) {
      return jsonError(res, 500, 'USER_ACCESS_FAILED', (error as Error)?.message || 'Failed to load user access')
    }
  })

  r.get('/api/admin/users/:userId/dingtalk-access', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      return jsonOk(res, {
        userId,
        actorId: adminUserId,
        ...(await fetchDingTalkAccessSnapshot(userId)),
      })
    } catch (error) {
      return jsonError(res, 500, 'DINGTALK_ACCESS_FAILED', (error as Error)?.message || 'Failed to load DingTalk access')
    }
  })

  r.get('/api/admin/users/:userId/member-admission', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const snapshot = await fetchMemberAdmissionSnapshot(userId)
      if (!snapshot) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      return jsonOk(res, {
        actorId: adminUserId,
        ...snapshot,
      })
    } catch (error) {
      return jsonError(res, 500, 'MEMBER_ADMISSION_FAILED', (error as Error)?.message || 'Failed to load member admission snapshot')
    }
  })

  r.patch('/api/admin/users/:userId/namespaces/:namespace/admission', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      const namespace = normalizeNamespace(req.params.namespace)
      const enabled = req.body?.enabled
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')
      if (!namespace) return jsonError(res, 400, 'NAMESPACE_REQUIRED', 'namespace is required')
      if (typeof enabled !== 'boolean') return jsonError(res, 400, 'ENABLED_REQUIRED', 'enabled boolean is required')
      if (!isNamespaceAdmissionControlledResource(namespace)) {
        return jsonError(res, 400, 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls')
      }

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      const namespaceAdmissions = await setUserNamespaceAdmission({
        userId,
        namespace,
        enabled,
        actorId: adminUserId,
        source: 'platform_admin',
      })
      invalidateUserPerms(userId)

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: enabled ? 'grant' : 'revoke',
        resourceType: 'user-namespace-admission',
        resourceId: `${userId}:${namespace}`,
        meta: {
          adminUserId,
          userId,
          namespace,
          enabled,
        },
      })

      return jsonOk(res, {
        actorId: adminUserId,
        userId,
        namespaceAdmissions,
      })
    } catch (error) {
      return jsonError(res, 500, 'MEMBER_NAMESPACE_ADMISSION_FAILED', (error as Error)?.message || 'Failed to update namespace admission')
    }
  })

  r.patch('/api/admin/users/:userId/dingtalk-grant', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      const enabled = req.body?.enabled
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')
      if (typeof enabled !== 'boolean') return jsonError(res, 400, 'ENABLED_REQUIRED', 'enabled boolean is required')

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      await query(
        `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (provider, local_user_id)
         DO UPDATE SET enabled = EXCLUDED.enabled, granted_by = EXCLUDED.granted_by, updated_at = NOW()`,
        [DINGTALK_PROVIDER, userId, enabled, adminUserId],
      )

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: enabled ? 'grant' : 'revoke',
        resourceType: 'user-auth-grant',
        resourceId: `${userId}:${DINGTALK_PROVIDER}`,
        meta: {
          adminUserId,
          userId,
          provider: DINGTALK_PROVIDER,
          enabled,
        },
      })

      return jsonOk(res, {
        userId,
        actorId: adminUserId,
        ...(await fetchDingTalkAccessSnapshot(userId)),
      })
    } catch (error) {
      return jsonError(res, 500, 'DINGTALK_GRANT_UPDATE_FAILED', (error as Error)?.message || 'Failed to update DingTalk access')
    }
  })

  r.post('/api/admin/users/:userId/roles/assign', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      const roleId = String(req.body?.roleId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')
      if (!roleId) return jsonError(res, 400, 'ROLE_REQUIRED', 'roleId is required')

      const [roleRow, profile] = await Promise.all([
        query<{ id: string }>('SELECT id FROM roles WHERE id = $1', [roleId]),
        fetchUserProfile(userId),
      ])
      if (!roleRow.rows.length) return jsonError(res, 404, 'ROLE_NOT_FOUND', 'Role not found')
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      await query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, roleId],
      )
      if (roleId === PLATFORM_ADMIN_ROLE_ID) {
        await syncLegacyAdminProfile(userId, true)
      }
      const disabledNamespaces: string[] = []
      invalidateUserPerms(userId)

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'grant',
        resourceType: 'user-role',
        resourceId: `${userId}:${roleId}`,
        meta: {
          adminUserId,
          userId,
          roleId,
          disabledNamespaces,
        },
      })

      const snapshot = await fetchUserAccessSnapshot(userId)
      return jsonOk(res, {
        ...snapshot,
        changedRoleId: roleId,
        actorId: adminUserId,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_ASSIGN_FAILED', (error as Error)?.message || 'Failed to assign role')
    }
  })

  r.post('/api/admin/users/:userId/roles/unassign', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      const roleId = String(req.body?.roleId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')
      if (!roleId) return jsonError(res, 400, 'ROLE_REQUIRED', 'roleId is required')

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      await query(
        `DELETE FROM user_roles
         WHERE user_id = $1 AND role_id = $2`,
        [userId, roleId],
      )
      if (roleId === PLATFORM_ADMIN_ROLE_ID) {
        await syncLegacyAdminProfile(userId, false)
      }
      const disabledNamespaces = await disableNamespaceAdmissionsWithoutRoles({
        userId,
        namespaces: await listRoleNamespaces(roleId),
        actorId: adminUserId,
        source: 'role_unassigned',
      })
      invalidateUserPerms(userId)

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'revoke',
        resourceType: 'user-role',
        resourceId: `${userId}:${roleId}`,
        meta: {
          adminUserId,
          userId,
          roleId,
          disabledNamespaces,
        },
      })

      const snapshot = await fetchUserAccessSnapshot(userId)
      return jsonOk(res, {
        ...snapshot,
        changedRoleId: roleId,
        actorId: adminUserId,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_UNASSIGN_FAILED', (error as Error)?.message || 'Failed to unassign role')
    }
  })

  r.patch('/api/admin/users/:userId/status', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      const isActive = req.body?.isActive
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')
      if (typeof isActive !== 'boolean') return jsonError(res, 400, 'STATUS_REQUIRED', 'isActive boolean is required')
      if (userId === adminUserId && isActive === false) {
        return jsonError(res, 400, 'SELF_DISABLE_FORBIDDEN', 'Cannot disable your own account')
      }

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      await query(
        `UPDATE users
         SET is_active = $1, updated_at = NOW()
         WHERE id = $2`,
        [isActive, userId],
      )

      const revocation = !isActive
        ? await revokeUserSessions(userId, {
            updatedBy: adminUserId,
            reason: 'user-disabled',
          })
        : null

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'update',
        resourceType: 'user',
        resourceId: userId,
        meta: {
          adminUserId,
          before: { is_active: profile.is_active },
          after: { is_active: isActive },
          revokedAfter: revocation?.revokedAfter || null,
        },
      })

      const snapshot = await fetchUserAccessSnapshot(userId)
      return jsonOk(res, {
        ...snapshot,
        actorId: adminUserId,
      })
    } catch (error) {
      return jsonError(res, 500, 'USER_STATUS_FAILED', (error as Error)?.message || 'Failed to update user status')
    }
  })

  r.post('/api/admin/users/:userId/reset-password', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      const requestedPassword = typeof req.body?.password === 'string' ? req.body.password.trim() : ''
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      const temporaryPassword = requestedPassword || generateTemporaryPassword()
      if (temporaryPassword.length < 8) {
        return jsonError(res, 400, 'PASSWORD_TOO_SHORT', 'Password must be at least 8 characters long')
      }

      const passwordHash = await bcrypt.hash(temporaryPassword, getBcryptSaltRounds())
      await query(
        `UPDATE users
         SET password_hash = $1, updated_at = NOW()
         WHERE id = $2`,
        [passwordHash, userId],
      )

      const revocation = await revokeUserSessions(userId, {
        updatedBy: adminUserId,
        reason: 'password-reset',
      })

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'update',
        resourceType: 'user-password',
        resourceId: userId,
        meta: {
          adminUserId,
          generated: requestedPassword.length === 0,
          revokedAfter: revocation?.revokedAfter || null,
        },
      })

      return jsonOk(res, {
        userId,
        temporaryPassword,
        actorId: adminUserId,
      })
    } catch (error) {
      return jsonError(res, 500, 'PASSWORD_RESET_FAILED', (error as Error)?.message || 'Failed to reset password')
    }
  })

  r.post('/api/admin/users/:userId/revoke-sessions', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 255)
        : 'admin-force-logout'

      const revocation = await revokeUserSessions(userId, {
        updatedBy: adminUserId,
        reason,
      })

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'revoke',
        resourceType: 'user-session',
        resourceId: userId,
        meta: {
          adminUserId,
          reason,
          revokedAfter: revocation?.revokedAfter || null,
        },
      })

      return jsonOk(res, {
        userId,
        revokedAfter: revocation?.revokedAfter || null,
        actorId: adminUserId,
        reason,
      })
    } catch (error) {
      return jsonError(res, 500, 'SESSION_REVOKE_FAILED', (error as Error)?.message || 'Failed to revoke user sessions')
    }
  })

  r.get('/api/admin/roles', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const roles = await fetchRoleCatalog()
      return jsonOk(res, {
        items: roles,
        total: roles.length,
        actorId: adminUserId,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_LIST_FAILED', (error as Error)?.message || 'Failed to list roles')
    }
  })

  r.get('/api/admin/audit-activity', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const q = String(req.query.q || '').trim()
      const action = String(req.query.action || '').trim()
      const resourceType = String(req.query.resourceType || '').trim()
      const from = parseAuditRangeBoundary(req.query.from, 'start')
      const to = parseAuditRangeBoundary(req.query.to, 'end')
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })

      const values: unknown[] = [resourceType ? [resourceType] : [...ADMIN_AUDIT_RESOURCE_TYPES]]
      const where = ['resource_type = ANY($1::text[])']

      if (action) {
        values.push(action)
        where.push(`action = $${values.length}`)
      }

      if (q) {
        values.push(`%${q}%`)
        where.push(
          `(COALESCE(resource_id, '') ILIKE $${values.length}
            OR COALESCE(action, '') ILIKE $${values.length}
            OR COALESCE(action_details::text, '') ILIKE $${values.length}
            OR COALESCE(user_email, '') ILIKE $${values.length}
            OR COALESCE(user_name, '') ILIKE $${values.length})`,
        )
      }

      if (from) {
        values.push(from)
        where.push(`created_at >= $${values.length}`)
      }

      if (to) {
        values.push(to)
        where.push(`created_at <= $${values.length}`)
      }

      const whereSql = `WHERE ${where.join(' AND ')}`
      const countResult = await query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
         FROM audit_logs
         ${whereSql}`,
        values,
      )

      values.push(pageSize, offset)
      const itemsResult = await query<AdminAuditLogRow>(
        `SELECT
            id,
            created_at,
            event_type,
            event_category,
            event_severity,
            action,
            resource_type,
            resource_id,
            user_id,
            user_name,
            user_email,
            action_details,
            error_code
         FROM audit_logs
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      )

      return jsonOk(res, {
        items: itemsResult.rows,
        page,
        pageSize,
        total: countResult.rows[0]?.c ?? 0,
        query: q,
        resourceType: resourceType || null,
        action: action || null,
        from,
        to,
        actorId: adminUserId,
      })
    } catch (error) {
      return jsonError(res, 500, 'ADMIN_AUDIT_LIST_FAILED', (error as Error)?.message || 'Failed to load admin audit activity')
    }
  })

  r.get('/api/admin/audit-activity/export.csv', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const q = String(req.query.q || '').trim()
      const action = String(req.query.action || '').trim()
      const resourceType = String(req.query.resourceType || '').trim()
      const from = parseAuditRangeBoundary(req.query.from, 'start')
      const to = parseAuditRangeBoundary(req.query.to, 'end')
      const rawLimit = Number(req.query.limit || 1000)
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 5000) : 1000

      const values: unknown[] = [resourceType ? [resourceType] : [...ADMIN_AUDIT_RESOURCE_TYPES]]
      const where = ['resource_type = ANY($1::text[])']

      if (action) {
        values.push(action)
        where.push(`action = $${values.length}`)
      }

      if (q) {
        values.push(`%${q}%`)
        where.push(
          `(COALESCE(resource_id, '') ILIKE $${values.length}
            OR COALESCE(action, '') ILIKE $${values.length}
            OR COALESCE(action_details::text, '') ILIKE $${values.length}
            OR COALESCE(user_email, '') ILIKE $${values.length}
            OR COALESCE(user_name, '') ILIKE $${values.length})`,
        )
      }

      if (from) {
        values.push(from)
        where.push(`created_at >= $${values.length}`)
      }

      if (to) {
        values.push(to)
        where.push(`created_at <= $${values.length}`)
      }

      values.push(limit)
      const rows = await query<AdminAuditLogRow>(
        `SELECT
            id,
            created_at,
            event_type,
            event_category,
            event_severity,
            action,
            resource_type,
            resource_id,
            user_id,
            user_name,
            user_email,
            action_details,
            error_code
         FROM audit_logs
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT $${values.length}`,
        values,
      )

      const filename = `iam-admin-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.write('id,created_at,resource_type,resource_id,action,event_type,event_severity,user_email,user_name,error_code,action_details\n')

      for (const item of rows.rows) {
        const line = [
          item.id,
          item.created_at,
          item.resource_type || '',
          item.resource_id || '',
          item.action,
          item.event_type,
          item.event_severity,
          item.user_email || '',
          item.user_name || '',
          item.error_code || '',
          JSON.stringify(item.action_details || {}),
        ].map((value) => {
          const text = String(value)
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
        }).join(',')
        res.write(`${line}\n`)
      }

      return res.end()
    } catch (error) {
      return jsonError(res, 500, 'ADMIN_AUDIT_EXPORT_FAILED', (error as Error)?.message || 'Failed to export admin audit activity')
    }
  })

  r.get('/api/admin/users/:userId/sessions', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      const sessions = await listUserSessions(userId)
      return jsonOk(res, {
        userId,
        items: sessions,
      })
    } catch (error) {
      return jsonError(res, 500, 'SESSION_LIST_FAILED', (error as Error)?.message || 'Failed to load user sessions')
    }
  })

  r.post('/api/admin/users/:userId/sessions/:sessionId/revoke', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const userId = String(req.params.userId || '').trim()
      const sessionId = String(req.params.sessionId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')
      if (!sessionId) return jsonError(res, 400, 'SESSION_ID_REQUIRED', 'sessionId is required')

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      const session = await getUserSession(sessionId)
      if (!session || session.userId !== userId) {
        return jsonError(res, 404, 'NOT_FOUND', 'Session not found')
      }

      const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 255)
        : 'admin-force-single-session-logout'

      const revoked = await revokeUserSession(sessionId, {
        revokedBy: adminUserId,
        reason,
      })

      if (!revoked) {
        return jsonError(res, 404, 'NOT_FOUND', 'Session not found')
      }

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'revoke',
        resourceType: 'user-session',
        resourceId: sessionId,
        meta: {
          adminUserId,
          userId,
          sessionId,
          reason,
          revokedAt: revoked.revokedAt,
        },
      })

      return jsonOk(res, {
        userId,
        sessionId,
        revokedAt: revoked.revokedAt,
        actorId: adminUserId,
        reason,
      })
    } catch (error) {
      return jsonError(res, 500, 'SESSION_REVOKE_FAILED', (error as Error)?.message || 'Failed to revoke session')
    }
  })

  r.get('/api/admin/session-revocations', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const q = String(req.query.q || '').trim()
      const from = parseAuditRangeBoundary(req.query.from, 'start')
      const to = parseAuditRangeBoundary(req.query.to, 'end')
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })

      const values: unknown[] = []
      const where: string[] = []

      if (q) {
        values.push(`%${q}%`)
        where.push(
          `(usr.user_id ILIKE $${values.length}
            OR COALESCE(target.email, '') ILIKE $${values.length}
            OR COALESCE(target.name, '') ILIKE $${values.length}
            OR COALESCE(actor.email, '') ILIKE $${values.length}
            OR COALESCE(actor.name, '') ILIKE $${values.length}
            OR COALESCE(usr.reason, '') ILIKE $${values.length})`,
        )
      }

      if (from) {
        values.push(from)
        where.push(`usr.updated_at >= $${values.length}`)
      }

      if (to) {
        values.push(to)
        where.push(`usr.updated_at <= $${values.length}`)
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const countResult = await query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
         FROM user_session_revocations usr
         LEFT JOIN users target ON target.id = usr.user_id
         LEFT JOIN users actor ON actor.id = usr.updated_by
         ${whereSql}`,
        values,
      )

      values.push(pageSize, offset)
      const rows = await query<AdminSessionRevocationRow>(
        `SELECT
            usr.user_id,
            usr.revoked_after,
            usr.updated_at,
            usr.updated_by,
            usr.reason,
            target.email AS user_email,
            target.name AS user_name,
            actor.email AS updated_by_email,
            actor.name AS updated_by_name
         FROM user_session_revocations usr
         LEFT JOIN users target ON target.id = usr.user_id
         LEFT JOIN users actor ON actor.id = usr.updated_by
         ${whereSql}
         ORDER BY usr.updated_at DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      )

      return jsonOk(res, {
        items: rows.rows,
        page,
        pageSize,
        total: countResult.rows[0]?.c ?? 0,
        query: q,
        from,
        to,
        actorId: adminUserId,
      })
    } catch (error) {
      return jsonError(res, 500, 'SESSION_REVOCATION_LIST_FAILED', (error as Error)?.message || 'Failed to load session revocations')
    }
  })

  return r
}
