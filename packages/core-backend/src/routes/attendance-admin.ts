import type { Request, Response } from 'express'
import { Router } from 'express'
import { rbacGuard } from '../rbac/rbac'
import { isAdmin as isRbacAdmin, listUserPermissions } from '../rbac/service'
import { query } from '../db/pg'
import { MAX_MANAGER_CHAIN_LEVELS } from '../services/ApprovalDirectoryOrg'
import { jsonError, jsonOk, parsePagination } from '../util/response'
import { redeliverFailedAttendanceNotification } from '../services/AttendanceNotificationRedelivery'
import { ensurePlatformAdmin } from './admin-users'
import { isDatabaseSchemaError } from '../utils/database-errors'
import {
  createAttendanceDeliveryChannelsFromEnv,
  DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME,
} from '../services/AttendanceNotificationDeliveryWorker'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type AttendanceRoleTemplateId = 'employee' | 'approver' | 'importer' | 'admin'

const ATTENDANCE_ROLE_TEMPLATES: Record<AttendanceRoleTemplateId, {
  id: AttendanceRoleTemplateId
  roleId: string
  permissions: string[]
  description: string
}> = {
  employee: {
    id: 'employee',
    roleId: 'attendance_employee',
    permissions: ['attendance:read', 'attendance:write'],
    description: 'Punch, submit adjustment requests, and read attendance records.',
  },
  approver: {
    id: 'approver',
    roleId: 'attendance_approver',
    permissions: ['attendance:read', 'attendance:approve'],
    description: 'Approve or reject attendance adjustment requests.',
  },
  importer: {
    id: 'importer',
    roleId: 'attendance_importer',
    permissions: ['attendance:read', 'attendance:import'],
    description: 'Import attendance files, run import sync, and inspect import batches.',
  },
  admin: {
    id: 'admin',
    roleId: 'attendance_admin',
    permissions: ['attendance:read', 'attendance:write', 'attendance:approve', 'attendance:import', 'attendance:admin'],
    description: 'Full attendance administration (rules, imports, holidays, groups).',
  },
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : JSON.stringify(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function parseDateParam(raw: unknown): Date | null {
  const text = String(raw || '').trim()
  if (!text) return null
  const d = new Date(text)
  if (Number.isNaN(d.getTime())) return null
  return d
}

type AttendanceAuditFilterInput = {
  q?: string
  actionPrefix?: string
  actorId?: string
  route?: string
  errorCode?: string
  statusClass?: string
  from?: Date | null
  to?: Date | null
}

type AttendanceAuditExportRow = {
  id: unknown
  actor_id: unknown
  actor_type: unknown
  action: unknown
  route: unknown
  status_code: unknown
  latency_ms: unknown
  resource_type: unknown
  resource_id: unknown
  request_id: unknown
  ip: unknown
  user_agent: unknown
  occurred_at: unknown
  meta: unknown
}

type AttendanceAuditMeta = Record<string, unknown> & {
  error?: {
    code?: unknown
    message?: unknown
  }
}

function normalizeAuditMeta(value: unknown): AttendanceAuditMeta {
  return typeof value === 'object' && value !== null ? (value as AttendanceAuditMeta) : {}
}

function readAuditMetaText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function formatAuditOccurredAt(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).toISOString()
  return ''
}

function normalizeStatusClass(raw: unknown): string | null {
  const text = String(raw || '').trim().toLowerCase()
  if (!text) return null
  if (!/^[2-5]xx$/.test(text)) return null
  return text
}

function buildAttendanceAuditWhere(input: AttendanceAuditFilterInput): { where: string; params: unknown[] } {
  const params: unknown[] = []
  const clauses: string[] = [`resource_type = 'attendance'`]

  const q = String(input.q || '').trim()
  if (q) {
    params.push(`%${q}%`)
    const idx = params.length
    clauses.push(`(
      action ILIKE $${idx}
      OR actor_id ILIKE $${idx}
      OR resource_id ILIKE $${idx}
      OR route ILIKE $${idx}
      OR (COALESCE(meta, metadata, '{}'::jsonb) -> 'error' ->> 'code') ILIKE $${idx}
    )`)
  }

  const actionPrefix = String(input.actionPrefix || '').trim()
  if (actionPrefix) {
    params.push(`${actionPrefix}%`)
    const idx = params.length
    clauses.push(`action ILIKE $${idx}`)
  }

  const actorId = String(input.actorId || '').trim()
  if (actorId) {
    params.push(`%${actorId}%`)
    const idx = params.length
    clauses.push(`actor_id ILIKE $${idx}`)
  }

  const route = String(input.route || '').trim()
  if (route) {
    params.push(`%${route}%`)
    const idx = params.length
    clauses.push(`route ILIKE $${idx}`)
  }

  const errorCode = String(input.errorCode || '').trim()
  if (errorCode) {
    params.push(errorCode)
    const idx = params.length
    clauses.push(`COALESCE(meta, metadata, '{}'::jsonb) -> 'error' ->> 'code' = $${idx}`)
  }

  const statusClass = normalizeStatusClass(input.statusClass)
  if (statusClass) {
    const lower = Number(statusClass[0]) * 100
    params.push(lower)
    const lowerIdx = params.length
    params.push(lower + 100)
    const upperIdx = params.length
    clauses.push(`status_code >= $${lowerIdx} AND status_code < $${upperIdx}`)
  }

  if (input.from) {
    params.push(input.from.toISOString())
    const idx = params.length
    clauses.push(`COALESCE(occurred_at, created_at) >= $${idx}`)
  }

  if (input.to) {
    params.push(input.to.toISOString())
    const idx = params.length
    clauses.push(`COALESCE(occurred_at, created_at) <= $${idx}`)
  }

  return { where: `WHERE ${clauses.join(' AND ')}`, params }
}

function withLimit<T>(items: T[], limit = 200): { items: T[]; truncated: boolean } {
  if (items.length <= limit) return { items, truncated: false }
  return { items: items.slice(0, limit), truncated: true }
}

async function ensureAttendanceRoleTemplates(): Promise<void> {
  // Ensure permission codes exist.
  await query(
    `INSERT INTO permissions (code, name, description)
     VALUES
      ('attendance:read', 'Attendance Read', 'Read attendance records and summaries'),
      ('attendance:write', 'Attendance Write', 'Create attendance punches and adjustment requests'),
      ('attendance:approve', 'Attendance Approve', 'Approve or reject attendance adjustments'),
      ('attendance:import', 'Attendance Import', 'Import attendance records and manage import batches'),
      ('attendance:admin', 'Attendance Admin', 'Manage attendance rules, settings, and schedules')
     ON CONFLICT (code) DO NOTHING`,
  )

  // Ensure role-permission mappings exist (role_id is a string identifier).
  const pairs: Array<[string, string]> = []
  Object.values(ATTENDANCE_ROLE_TEMPLATES).forEach((tpl) => {
    tpl.permissions.forEach((perm) => pairs.push([tpl.roleId, perm]))
  })

  const values = pairs.map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`).join(', ')
  const params = pairs.flat()
  await query(
    `INSERT INTO role_permissions (role_id, permission_code)
     VALUES ${values}
     ON CONFLICT DO NOTHING`,
    params,
  )
}

async function fetchUserProfile(userId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query<{
    id: string
    email: string
    name: string | null
    employeeNo: string | null
    department: string | null
    role: string
    is_active: boolean
    is_admin: boolean
    last_login_at: string | null
    created_at: string
  }>(
    `SELECT id, email, name, employee_no AS "employeeNo", department, role, is_active, is_admin, last_login_at, created_at
     FROM users
     WHERE id = $1`,
    [userId],
  )
  if (!rows.length) return null
  return rows[0] as unknown as Record<string, unknown>
}

async function fetchUserRoleIds(userId: string): Promise<string[]> {
  const { rows } = await query<{ role_id: string }>(
    `SELECT role_id
     FROM user_roles
     WHERE user_id = $1
     ORDER BY role_id ASC`,
    [userId],
  )
  return rows.map((row) => row.role_id).filter(Boolean)
}

function normalizeBatchUserIds(rawIds: unknown[]): { userIds: string[]; invalidUserIds: string[] } {
  const userIds: string[] = []
  const invalidUserIds: string[] = []
  const seen = new Set<string>()

  for (const value of rawIds) {
    const id = String(value || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    userIds.push(id)
  }

  return { userIds, invalidUserIds }
}

type AttendanceAdminResolvedUser = {
  id: string
  email: string
  name: string | null
  employeeNo: string | null
  department: string | null
  is_active: boolean
}

async function resolveBatchUsers(userIds: string[]): Promise<{
  items: AttendanceAdminResolvedUser[]
  missingUserIds: string[]
  inactiveUserIds: string[]
}> {
  if (userIds.length === 0) {
    return { items: [], missingUserIds: [], inactiveUserIds: [] }
  }

  const found = await query<AttendanceAdminResolvedUser>(
    `SELECT id, email, name, employee_no AS "employeeNo", department, is_active
     FROM users
     WHERE id = ANY($1::text[])`,
    [userIds],
  )

  const byId = new Map(found.rows.map((row) => [String(row.id), row]))
  const items: AttendanceAdminResolvedUser[] = []
  const missingUserIds: string[] = []

  for (const userId of userIds) {
    const item = byId.get(userId)
    if (!item) {
      missingUserIds.push(userId)
      continue
    }
    items.push(item)
  }

  const inactiveUserIds = items
    .filter((item) => item.is_active === false)
    .map((item) => item.id)

  return { items, missingUserIds, inactiveUserIds }
}

function getAttendanceAdminRequestUserId(req: Request): string {
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

/**
 * S7-5 / OD-S7-6: values-free org readiness for dynamic approval-step authoring.
 * Pure query helper so unit tests can assert the SQL is org-anchored and returns no PII.
 */
export async function readOrgDirectoryReadiness(
  orgId: string,
  runQuery: typeof query = query,
): Promise<{ hasLinkedDirectoryAccounts: boolean; maxManagerChainLevels: number }> {
  // EXISTS only — never SELECT account ids, names, phones, or raw payloads.
  // Mirrors the runtime resolver's minimum usable-account predicate
  // (ApprovalDirectoryOrg: linked + a.is_active = true).
  const result = await runQuery<{ ready: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM directory_account_links l
         JOIN directory_accounts a ON a.id = l.directory_account_id
         JOIN directory_integrations i ON i.id = a.integration_id
        WHERE i.org_id = $1
          AND l.link_status = 'linked'
          AND a.is_active = true
        LIMIT 1
     ) AS ready`,
    [orgId],
  )
  return {
    hasLinkedDirectoryAccounts: Boolean(result.rows[0]?.ready),
    maxManagerChainLevels: MAX_MANAGER_CHAIN_LEVELS,
  }
}

/**
 * S7-5: can this attendance:admin read directory readiness for `orgId`?
 * Platform admins may; delegated attendance admins must be active members of that org
 * (strict org anchor — never a global directory probe).
 */
export async function canReadAttendanceDirectoryReadiness(
  req: Request,
  userId: string,
  orgId: string,
  runQuery: typeof query = query,
): Promise<boolean> {
  if (hasLegacyAdminClaim(req) || await isRbacAdmin(userId)) return true
  const member = await runQuery(
    'SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = true LIMIT 1',
    [userId, orgId],
  )
  return member.rows.length > 0
}

// ---------------------------------------------------------------------------------------------
// W4-0 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED): seven-step setup-readiness aggregate.
// §0 red line R1: readiness is READ-ONLY. Every aggregation query below MUST be issued through
// `createReadOnlyReadinessSeam` — a runtime guard (not a comment) that rejects any non-SELECT/WITH
// statement before it reaches the database. Authorization (`canReadAttendanceDirectoryReadiness`,
// reused verbatim from S7-5 above) is checked by the route BEFORE `buildAttendanceSetupReadiness`
// is ever invoked, so a foreign-org 403 issues zero aggregation SQL (OD-W4-1 追加门禁1).
// ---------------------------------------------------------------------------------------------

export type AttendanceSetupReadinessQueryFn = typeof query

/**
 * §9 追加门禁3: the setup-readiness query seam only accepts SELECT/WITH statements. Throws
 * synchronously — before any I/O — for anything else, so a mutation that slips a write statement
 * into a call site fails loudly instead of silently running against the database.
 */
export function assertSelectOnlyReadinessSql(sql: string): void {
  const normalized = sql.trim().toUpperCase()
  if (!(normalized.startsWith('SELECT') || normalized.startsWith('WITH'))) {
    throw new Error('attendance setup-readiness query seam rejected a non-SELECT/WITH statement')
  }
}

export function createReadOnlyReadinessSeam(
  runQuery: AttendanceSetupReadinessQueryFn = query,
): AttendanceSetupReadinessQueryFn {
  // `async` (not a plain arrow returning runQuery's promise) so the guard's synchronous throw
  // becomes a REJECTED PROMISE — matching `typeof query`'s always-async contract and letting every
  // caller keep using `await`/`.catch` uniformly instead of needing a try/catch just for the guard.
  return async (sql, params) => {
    assertSelectOnlyReadinessSql(sql)
    return runQuery(sql, params)
  }
}

export interface AttendanceSetupReadinessOrgCounts {
  orgActiveMemberCount: number
  groupCount: number
  groupsWithMembers: number
  shiftCount: number
  rotationRuleCount: number
  approvalFlowCount: number
}

/**
 * §4.2 single CTE covering every org-scoped count (①②③⑤ + group-membership, OD-W4-6). ④ (settings)
 * and ⑥ (notify runtime port) are deliberately NOT here — ④ is a deployment-level system_configs
 * read, ⑥ is a non-DB runtime port; both live in their own functions below.
 */
export async function readAttendanceSetupReadinessOrgCounts(
  orgId: string,
  runQuery: AttendanceSetupReadinessQueryFn,
): Promise<AttendanceSetupReadinessOrgCounts> {
  const result = await runQuery<{
    org_active_member_count: number
    group_count: number
    groups_with_members: number
    shift_count: number
    rotation_rule_count: number
    approval_flow_count: number
  }>(
    `WITH member_scope AS (
       SELECT COUNT(*)::int AS org_active_member_count
         FROM user_orgs
        WHERE org_id = $1 AND is_active = true
     ),
     group_member_counts AS (
       SELECT group_id, COUNT(*)::int AS member_count
         FROM attendance_group_members
        WHERE org_id = $1
        GROUP BY group_id
     ),
     group_scope AS (
       SELECT COUNT(*)::int AS group_count,
              COUNT(*) FILTER (WHERE COALESCE(gmc.member_count, 0) > 0)::int AS groups_with_members
         FROM attendance_groups g
         LEFT JOIN group_member_counts gmc ON gmc.group_id = g.id
        WHERE g.org_id = $1
     ),
     shift_scope AS (
       SELECT COUNT(*)::int AS shift_count
         FROM attendance_shifts
        WHERE org_id = $1
     ),
     rotation_scope AS (
       SELECT COUNT(*)::int AS rotation_rule_count
         FROM attendance_rotation_rules
        WHERE org_id = $1
     ),
     approval_scope AS (
       SELECT COUNT(*)::int AS approval_flow_count
         FROM attendance_approval_flows
        WHERE org_id = $1 AND is_active = true
     )
     SELECT member_scope.org_active_member_count,
            group_scope.group_count,
            group_scope.groups_with_members,
            shift_scope.shift_count,
            rotation_scope.rotation_rule_count,
            approval_scope.approval_flow_count
       FROM member_scope, group_scope, shift_scope, rotation_scope, approval_scope`,
    [orgId],
  )
  const row = result.rows[0]
  return {
    orgActiveMemberCount: Number(row?.org_active_member_count ?? 0),
    groupCount: Number(row?.group_count ?? 0),
    groupsWithMembers: Number(row?.groups_with_members ?? 0),
    shiftCount: Number(row?.shift_count ?? 0),
    rotationRuleCount: Number(row?.rotation_rule_count ?? 0),
    approvalFlowCount: Number(row?.approval_flow_count ?? 0),
  }
}

const ATTENDANCE_SETTINGS_KEY = 'attendance.settings'

export type AttendancePunchPolicyPosture = 'default' | 'customized' | 'unknown'

// Mirrors plugins/plugin-attendance/index.cjs DEFAULT_SETTINGS.punchPolicy (~L291-345; SETTINGS_KEY
// 'attendance.settings' is a single DEPLOYMENT-WIDE key — round-1 P2-2). Core-backend has no
// sanctioned import of plugin internals (plugin -> core-backend is the only wired dependency
// direction, e.g. the attendanceScheduler/approvalAssigneeResolver ports), so this is a literal,
// independently pinned mirror of the punchPolicy subtree only — deliberately NOT the whole settings
// blob, so an unrelated customization elsewhere (e.g. holiday sync years) can never mislabel step ④.
const ATTENDANCE_DEFAULT_PUNCH_POLICY_MIRROR = {
  unscheduledMode: 'allow',
  mergeInternalWinsOnIn: false,
  mergeExternalWinsOnOut: false,
  outdoorRequireApproval: false,
  outdoorRequireNote: false,
  outdoorRequirePhoto: false,
  outdoorApprovalFlowId: '',
} as const

function isDefaultAttendancePunchPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const unscheduled = (v.unscheduled ?? {}) as Record<string, unknown>
  const merge = (v.merge ?? {}) as Record<string, unknown>
  const outdoor = (v.outdoor ?? {}) as Record<string, unknown>
  const d = ATTENDANCE_DEFAULT_PUNCH_POLICY_MIRROR
  return (
    unscheduled.mode === d.unscheduledMode &&
    merge.internalWinsOnIn === d.mergeInternalWinsOnIn &&
    merge.externalWinsOnOut === d.mergeExternalWinsOnOut &&
    outdoor.requireApproval === d.outdoorRequireApproval &&
    outdoor.requireNote === d.outdoorRequireNote &&
    outdoor.requirePhoto === d.outdoorRequirePhoto &&
    (outdoor.approvalFlowId ?? '') === d.outdoorApprovalFlowId
  )
}

/**
 * §3④ / OD-W4-4=(c): back-end internal semantic check against normalized defaults. The FRONT END
 * never sees `attendance.settings` values — only this values-free posture enum (round-3 P3).
 * `default` and `customized` are both `ready` at the discriminator layer (round-3 (b): the platform
 * default is a legitimate, usable policy); only `unknown` fails closed.
 */
export async function readAttendancePunchPolicyPosture(
  runQuery: AttendanceSetupReadinessQueryFn,
): Promise<AttendancePunchPolicyPosture> {
  try {
    const result = await runQuery<{ value: string }>(
      'SELECT value FROM system_configs WHERE key = $1',
      [ATTENDANCE_SETTINGS_KEY],
    )
    const raw = result.rows[0]?.value
    if (raw === undefined || raw === null) {
      // No row at all: the platform default is in force (never explicitly saved).
      return 'default'
    }
    const parsed = JSON.parse(String(raw)) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || !('punchPolicy' in parsed)) {
      // A row exists but carries no punchPolicy subtree (pre-S0 shape / corrupted write) — cannot
      // honestly claim default or customized.
      return 'unknown'
    }
    return isDefaultAttendancePunchPolicy(parsed.punchPolicy) ? 'default' : 'customized'
  } catch {
    return 'unknown'
  }
}

export interface AttendanceSetupReadinessNotifyPort {
  workerEnabled: boolean | 'unknown'
  defaultChannelAvailable: boolean | 'unknown'
  availableChannelCount: number | 'unknown'
  orgRecipientBindingReady: boolean | 'unknown'
}

const ATTENDANCE_NOTIFY_PORT_UNKNOWN: AttendanceSetupReadinessNotifyPort = {
  workerEnabled: 'unknown',
  defaultChannelAvailable: 'unknown',
  availableChannelCount: 'unknown',
  orgRecipientBindingReady: 'unknown',
}

/**
 * §4.5 read-only runtime readiness port (P2-3). Never returns env names, channel names, or
 * credentials — only booleans/counts. `orgRecipientBindingReady` mirrors the EXACT join
 * `AttendanceNotificationDeliveryWorker.resolveRecipient` uses to find a bound DingTalk recipient
 * (org-scoped, values-free EXISTS). If the port itself throws, the WHOLE block fails closed to
 * `unknown` rather than a partial/misleading signal; if only the org-scoped DB probe fails, that
 * one field alone goes `unknown` while the pure env-derived fields still resolve.
 */
export async function readAttendanceNotifyReadinessPort(
  orgId: string,
  runQuery: AttendanceSetupReadinessQueryFn,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AttendanceSetupReadinessNotifyPort> {
  try {
    const workerEnabled = env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED === 'true'
    const channels = createAttendanceDeliveryChannelsFromEnv(env)
    const defaultChannelAvailable = channels.some((c) => c.name === DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
    const availableChannelCount = channels.length

    let orgRecipientBindingReady: boolean | 'unknown' = 'unknown'
    try {
      const result = await runQuery<{ ready: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM directory_account_links l
             JOIN directory_accounts a
               ON a.id = l.directory_account_id
              AND a.provider = 'dingtalk'
              AND a.is_active = true
             JOIN directory_integrations i
               ON i.id = a.integration_id
              AND i.provider = 'dingtalk'
              AND i.status = 'active'
              AND i.org_id = $1
            WHERE l.link_status = 'linked'
            LIMIT 1
         ) AS ready`,
        [orgId],
      )
      orgRecipientBindingReady = Boolean(result.rows[0]?.ready)
    } catch {
      orgRecipientBindingReady = 'unknown'
    }

    return { workerEnabled, defaultChannelAvailable, availableChannelCount, orgRecipientBindingReady }
  } catch {
    return { ...ATTENDANCE_NOTIFY_PORT_UNKNOWN }
  }
}

export type AttendanceSetupReadinessEffectiveTimePosture =
  | 'immediate'
  | 'scheduled'
  | 'manual_activation'
  | 'undeterminable'

export interface AttendanceSetupReadinessEffectiveTime {
  source: string
  posture: AttendanceSetupReadinessEffectiveTimePosture
  effectiveAt?: string
}

export interface AttendanceSetupReadinessStepMeta {
  /** Canonical admin-section deep-link id (§6.2) that "去配置/修复" resolves to; 'preview' for ⑦
   *  (no section — the preview lives inside the wizard itself, read-only). */
  step: string
  scope: 'org' | 'deployment'
  effectiveTime: AttendanceSetupReadinessEffectiveTime
}

// §3 "计划生效时间" (追加门禁4): each step's authoritative source registered here, once, for the
// whole W4-0/W4-1/W4-2 lifetime. A step with no app-observable trigger is 'undeterminable' or
// 'manual_activation' — NEVER guessed as 'immediate' ("不得省略、不得猜测").
export const ATTENDANCE_SETUP_READINESS_STEP_META: readonly AttendanceSetupReadinessStepMeta[] = [
  {
    step: 'attendance-admin-user-access',
    scope: 'org',
    effectiveTime: { source: 'user_orgs.is_active', posture: 'immediate' },
  },
  {
    step: 'attendance-admin-groups',
    scope: 'org',
    effectiveTime: { source: 'attendance_group_members', posture: 'immediate' },
  },
  {
    step: 'attendance-admin-shifts',
    scope: 'org',
    effectiveTime: { source: 'attendance_shifts+attendance_rotation_rules', posture: 'immediate' },
  },
  {
    step: 'attendance-admin-settings',
    scope: 'deployment',
    effectiveTime: { source: 'system_configs.attendance_settings', posture: 'immediate' },
  },
  {
    step: 'attendance-admin-approval-flows',
    scope: 'org',
    effectiveTime: { source: 'attendance_approval_flows.is_active', posture: 'immediate' },
  },
  {
    step: 'attendance-admin-notification-deliveries',
    scope: 'deployment',
    // Channel/worker enablement is operator env/redeploy-controlled — no app-observable schedule.
    effectiveTime: { source: 'none', posture: 'undeterminable' },
  },
  {
    step: 'preview',
    scope: 'org',
    // §3⑦: preview-ready never means "already enabled" — activation is a human action against the
    // canonical checklist, never an app-triggered event.
    effectiveTime: { source: 'none', posture: 'manual_activation' },
  },
] as const

// §4.2 / 追加门禁2: the deployment-scoped ("global") signals, explicitly enumerated so a contract
// test can lock this list rather than re-deriving it from prose. Every signal NOT listed here is
// org-scoped (org_id-anchored).
export const ATTENDANCE_SETUP_READINESS_DEPLOYMENT_SCOPED_SIGNALS = [
  'punchPolicyPosture',
  'notify.workerEnabled',
  'notify.defaultChannelAvailable',
  'notify.availableChannelCount',
] as const

export interface AttendanceSetupReadinessResponse {
  directoryLinked: boolean
  orgActiveMemberCount: number
  groupCount: number
  groupsWithMembers: number
  shiftCount: number
  rotationRuleCount: number
  hasRotationRules: boolean
  approvalFlowCount: number
  punchPolicyPosture: AttendancePunchPolicyPosture
  notify: AttendanceSetupReadinessNotifyPort
  perStep: readonly AttendanceSetupReadinessStepMeta[]
  deploymentScopedSignals: readonly string[]
}

/**
 * Owns EVERY aggregation read for the setup-readiness endpoint. The route calls this ONLY after
 * `canReadAttendanceDirectoryReadiness` has already returned true — so a 403 response path never
 * reaches this function, and therefore never issues a single aggregation query (OD-W4-1 追加门禁1).
 */
export async function buildAttendanceSetupReadiness(
  orgId: string,
  runQuery: AttendanceSetupReadinessQueryFn = query,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AttendanceSetupReadinessResponse> {
  const seam = createReadOnlyReadinessSeam(runQuery)
  const [directory, counts, punchPolicyPosture, notify] = await Promise.all([
    readOrgDirectoryReadiness(orgId, seam),
    readAttendanceSetupReadinessOrgCounts(orgId, seam),
    readAttendancePunchPolicyPosture(seam),
    readAttendanceNotifyReadinessPort(orgId, seam, env),
  ])
  return {
    directoryLinked: directory.hasLinkedDirectoryAccounts,
    orgActiveMemberCount: counts.orgActiveMemberCount,
    groupCount: counts.groupCount,
    groupsWithMembers: counts.groupsWithMembers,
    shiftCount: counts.shiftCount,
    rotationRuleCount: counts.rotationRuleCount,
    hasRotationRules: counts.rotationRuleCount > 0,
    approvalFlowCount: counts.approvalFlowCount,
    punchPolicyPosture,
    notify,
    perStep: ATTENDANCE_SETUP_READINESS_STEP_META,
    deploymentScopedSignals: ATTENDANCE_SETUP_READINESS_DEPLOYMENT_SCOPED_SIGNALS,
  }
}

export function attendanceAdminRouter(): Router {
  const r = Router()

  // NOTE: This is an attendance-scoped admin surface. Guard by attendance:admin (not global admin),
  // so tenants can delegate attendance administration without exposing the whole platform.
  r.use('/api/attendance-admin', rbacGuard('attendance', 'admin'))

  // S7-5 / OD-S7-6: smallest values-free, org-anchored readiness read for the approval-flow
  // authoring warning. Delegated attendance admins MUST NOT call platform-admin directory
  // endpoints; this seam is the only authoring path. Response carries ONLY a boolean + the
  // host-authoritative manager-chain max (no account/user/integration payload).
  r.get('/api/attendance-admin/directory-readiness', async (req: Request, res: Response) => {
    try {
      const orgId = String(req.query.orgId || '').trim()
      if (!orgId) {
        return jsonError(res, 400, 'ORG_ID_REQUIRED', 'orgId is required')
      }
      const userId = getAttendanceAdminRequestUserId(req)
      if (!userId) {
        return jsonError(res, 401, 'UNAUTHENTICATED', 'Authentication required')
      }
      const allowed = await canReadAttendanceDirectoryReadiness(req, userId, orgId)
      if (!allowed) {
        return jsonError(res, 403, 'FORBIDDEN', 'Org membership required for directory readiness')
      }
      const readiness = await readOrgDirectoryReadiness(orgId)
      return jsonOk(res, readiness)
    } catch (_error) {
      // Values-free seam: never leak raw DB / driver messages to the client.
      return jsonError(res, 500, 'DIRECTORY_READINESS_FAILED', 'Failed to load directory readiness')
    }
  })

  // W4-0 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §4.1 OD-W4-1=(a)): seven-step
  // setup-readiness aggregate. Same org-membership door as S7-5 above (canReadAttendanceDirectoryReadiness,
  // reused verbatim) — authorization completes BEFORE buildAttendanceSetupReadiness is ever called, so a
  // foreign-org 403 issues zero aggregation SQL. Response is values-free by construction (§4.2): counts,
  // enums, and time postures only — never IDs, names, credentials, or raw configuration values.
  r.get('/api/attendance-admin/setup-readiness', async (req: Request, res: Response) => {
    try {
      const orgId = String(req.query.orgId || '').trim()
      if (!orgId) {
        return jsonError(res, 400, 'ORG_ID_REQUIRED', 'orgId is required')
      }
      const userId = getAttendanceAdminRequestUserId(req)
      if (!userId) {
        return jsonError(res, 401, 'UNAUTHENTICATED', 'Authentication required')
      }
      const allowed = await canReadAttendanceDirectoryReadiness(req, userId, orgId)
      if (!allowed) {
        return jsonError(res, 403, 'FORBIDDEN', 'Org membership required for setup readiness')
      }
      const readiness = await buildAttendanceSetupReadiness(orgId)
      return jsonOk(res, readiness)
    } catch (error) {
      if (isDatabaseSchemaError(error)) {
        return jsonError(res, 503, 'DB_NOT_READY', 'Attendance tables not ready')
      }
      // Values-free seam: never leak raw DB / driver messages to the client.
      return jsonError(res, 500, 'SETUP_READINESS_FAILED', 'Failed to load setup readiness')
    }
  })

  r.get('/api/attendance-admin/role-templates', async (_req: Request, res: Response) => {
    try {
      await ensureAttendanceRoleTemplates()
      const templates = Object.values(ATTENDANCE_ROLE_TEMPLATES)
      return jsonOk(res, { templates })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_TEMPLATES_FAILED', (error as Error)?.message || 'Failed to load role templates')
    }
  })

  r.get('/api/attendance-admin/users/search', async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || '').trim()
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })

      const term = q ? `%${q}%` : '%'
      const where = q
        ? 'WHERE COALESCE(email, \'\') ILIKE $1 OR COALESCE(username, \'\') ILIKE $1 OR name ILIKE $1 OR COALESCE(mobile, \'\') ILIKE $1 OR COALESCE(employee_no, \'\') ILIKE $1 OR COALESCE(department, \'\') ILIKE $1 OR id ILIKE $1'
        : ''
      const countSql = `SELECT COUNT(*)::int AS c FROM users ${where}`
      const listSql = `
        SELECT id, email, name, employee_no AS "employeeNo", department, role, is_active, is_admin, last_login_at, created_at
        FROM users
        ${where}
        ORDER BY created_at DESC
        LIMIT $${q ? 2 : 1} OFFSET $${q ? 3 : 2}
      `

      const count = await query<{ c: number }>(countSql, q ? [term] : undefined)
      const total = count.rows[0]?.c ?? 0
      const listParams = q ? [term, pageSize, offset] : [pageSize, offset]
      const list = await query(listSql, listParams)

      return jsonOk(res, { items: list.rows, page, pageSize, total })
    } catch (error) {
      return jsonError(res, 500, 'USER_SEARCH_FAILED', (error as Error)?.message || 'Failed to search users')
    }
  })

  r.post('/api/attendance-admin/users/batch/resolve', async (req: Request, res: Response) => {
    try {
      const rawIds = Array.isArray(req.body?.userIds) ? req.body.userIds : []
      const { userIds, invalidUserIds } = normalizeBatchUserIds(rawIds)
      if (userIds.length === 0) return jsonError(res, 400, 'USER_IDS_REQUIRED', 'userIds is required')
      if (invalidUserIds.length) {
        return jsonError(res, 400, 'USER_IDS_INVALID', `Invalid UUID(s): ${invalidUserIds.slice(0, 5).join(', ')}`)
      }

      const resolved = await resolveBatchUsers(userIds)
      return jsonOk(res, {
        requested: userIds.length,
        found: resolved.items.length,
        missingUserIds: resolved.missingUserIds,
        inactiveUserIds: resolved.inactiveUserIds,
        items: resolved.items,
      })
    } catch (error) {
      return jsonError(res, 500, 'BATCH_USER_RESOLVE_FAILED', (error as Error)?.message || 'Failed to resolve users')
    }
  })

  r.post('/api/attendance-admin/users/batch/roles/assign', async (req: Request, res: Response) => {
    try {
      const rawIds = Array.isArray(req.body?.userIds) ? req.body.userIds : []
      const { userIds, invalidUserIds } = normalizeBatchUserIds(rawIds)
      if (userIds.length === 0) return jsonError(res, 400, 'USER_IDS_REQUIRED', 'userIds is required')
      if (invalidUserIds.length) {
        return jsonError(res, 400, 'USER_IDS_INVALID', `Invalid UUID(s): ${invalidUserIds.slice(0, 5).join(', ')}`)
      }

      const templateId = String(req.body?.template || '').trim() as AttendanceRoleTemplateId
      const roleId = String(req.body?.roleId || '').trim()
      const resolvedTemplate = templateId && ATTENDANCE_ROLE_TEMPLATES[templateId]
      const finalRoleId = resolvedTemplate?.roleId || roleId
      if (!finalRoleId) return jsonError(res, 400, 'ROLE_REQUIRED', 'template or roleId is required')

      await ensureAttendanceRoleTemplates()

      const resolvedUsers = await resolveBatchUsers(userIds)
      const eligibleUserIds = resolvedUsers.items.map((item) => item.id)
      if (eligibleUserIds.length === 0) {
        return jsonOk(res, {
          roleId: finalRoleId,
          requested: userIds.length,
          eligible: 0,
          updated: 0,
          affectedUserIds: [],
          affectedUserIdsTruncated: false,
          unchangedUserIds: [],
          unchangedUserIdsTruncated: false,
          missingUserIds: resolvedUsers.missingUserIds,
          inactiveUserIds: resolvedUsers.inactiveUserIds,
          items: resolvedUsers.items,
        })
      }

      const insert = await query<{ user_id: string }>(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT unnest($1::text[]), $2
         ON CONFLICT DO NOTHING
         RETURNING user_id`,
        [eligibleUserIds, finalRoleId],
      )

      const affectedUserIdsRaw = insert.rows
        .map((row) => String(row.user_id || '').trim())
        .filter(Boolean)
      const affectedSet = new Set(affectedUserIdsRaw)
      const unchangedUserIdsRaw = eligibleUserIds.filter((id) => !affectedSet.has(id))
      const affectedUserIds = withLimit(affectedUserIdsRaw)
      const unchangedUserIds = withLimit(unchangedUserIdsRaw)

      return jsonOk(res, {
        roleId: finalRoleId,
        requested: userIds.length,
        eligible: eligibleUserIds.length,
        updated: insert.rowCount ?? insert.rows.length,
        affectedUserIds: affectedUserIds.items,
        affectedUserIdsTruncated: affectedUserIds.truncated,
        unchangedUserIds: unchangedUserIds.items,
        unchangedUserIdsTruncated: unchangedUserIds.truncated,
        missingUserIds: resolvedUsers.missingUserIds,
        inactiveUserIds: resolvedUsers.inactiveUserIds,
        items: resolvedUsers.items,
      })
    } catch (error) {
      return jsonError(res, 500, 'BATCH_ROLE_ASSIGN_FAILED', (error as Error)?.message || 'Failed to batch assign role')
    }
  })

  r.post('/api/attendance-admin/users/batch/roles/unassign', async (req: Request, res: Response) => {
    try {
      const rawIds = Array.isArray(req.body?.userIds) ? req.body.userIds : []
      const { userIds, invalidUserIds } = normalizeBatchUserIds(rawIds)
      if (userIds.length === 0) return jsonError(res, 400, 'USER_IDS_REQUIRED', 'userIds is required')
      if (invalidUserIds.length) {
        return jsonError(res, 400, 'USER_IDS_INVALID', `Invalid UUID(s): ${invalidUserIds.slice(0, 5).join(', ')}`)
      }

      const templateId = String(req.body?.template || '').trim() as AttendanceRoleTemplateId
      const roleId = String(req.body?.roleId || '').trim()
      const resolved = templateId && ATTENDANCE_ROLE_TEMPLATES[templateId]
      const finalRoleId = resolved?.roleId || roleId
      if (!finalRoleId) return jsonError(res, 400, 'ROLE_REQUIRED', 'template or roleId is required')

      const resolvedUsers = await resolveBatchUsers(userIds)
      const eligibleUserIds = resolvedUsers.items.map((item) => item.id)
      if (eligibleUserIds.length === 0) {
        return jsonOk(res, {
          roleId: finalRoleId,
          requested: userIds.length,
          eligible: 0,
          updated: 0,
          affectedUserIds: [],
          affectedUserIdsTruncated: false,
          unchangedUserIds: [],
          unchangedUserIdsTruncated: false,
          missingUserIds: resolvedUsers.missingUserIds,
          inactiveUserIds: resolvedUsers.inactiveUserIds,
          items: resolvedUsers.items,
        })
      }

      const del = await query<{ user_id: string }>(
        `DELETE FROM user_roles
         WHERE role_id = $2 AND user_id = ANY($1::text[])
         RETURNING user_id`,
        [eligibleUserIds, finalRoleId],
      )

      const affectedUserIdsRaw = del.rows
        .map((row) => String(row.user_id || '').trim())
        .filter(Boolean)
      const affectedSet = new Set(affectedUserIdsRaw)
      const unchangedUserIdsRaw = eligibleUserIds.filter((id) => !affectedSet.has(id))
      const affectedUserIds = withLimit(affectedUserIdsRaw)
      const unchangedUserIds = withLimit(unchangedUserIdsRaw)

      return jsonOk(res, {
        roleId: finalRoleId,
        requested: userIds.length,
        eligible: eligibleUserIds.length,
        updated: del.rowCount ?? del.rows.length,
        affectedUserIds: affectedUserIds.items,
        affectedUserIdsTruncated: affectedUserIds.truncated,
        unchangedUserIds: unchangedUserIds.items,
        unchangedUserIdsTruncated: unchangedUserIds.truncated,
        missingUserIds: resolvedUsers.missingUserIds,
        inactiveUserIds: resolvedUsers.inactiveUserIds,
        items: resolvedUsers.items,
      })
    } catch (error) {
      return jsonError(res, 500, 'BATCH_ROLE_UNASSIGN_FAILED', (error as Error)?.message || 'Failed to batch unassign role')
    }
  })

  r.get('/api/attendance-admin/users/:userId/access', async (req: Request, res: Response) => {
    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      const [roles, permissions, isAdmin] = await Promise.all([
        fetchUserRoleIds(userId),
        listUserPermissions(userId),
        isRbacAdmin(userId),
      ])

      return jsonOk(res, {
        user: profile,
        roles,
        permissions,
        isAdmin,
      })
    } catch (error) {
      return jsonError(res, 500, 'USER_ACCESS_FAILED', (error as Error)?.message || 'Failed to load user access')
    }
  })

  r.post('/api/attendance-admin/users/:userId/roles/assign', async (req: Request, res: Response) => {
    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const templateId = String(req.body?.template || '').trim() as AttendanceRoleTemplateId
      const roleId = String(req.body?.roleId || '').trim()
      const resolved = templateId && ATTENDANCE_ROLE_TEMPLATES[templateId]
      const finalRoleId = resolved?.roleId || roleId
      if (!finalRoleId) return jsonError(res, 400, 'ROLE_REQUIRED', 'template or roleId is required')

      await ensureAttendanceRoleTemplates()

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      await query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, finalRoleId],
      )

      const [roles, permissions, isAdmin] = await Promise.all([
        fetchUserRoleIds(userId),
        listUserPermissions(userId),
        isRbacAdmin(userId),
      ])

      return jsonOk(res, {
        user: profile,
        roles,
        permissions,
        isAdmin,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_ASSIGN_FAILED', (error as Error)?.message || 'Failed to assign role')
    }
  })

  r.post('/api/attendance-admin/users/:userId/roles/unassign', async (req: Request, res: Response) => {
    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const templateId = String(req.body?.template || '').trim() as AttendanceRoleTemplateId
      const roleId = String(req.body?.roleId || '').trim()
      const resolved = templateId && ATTENDANCE_ROLE_TEMPLATES[templateId]
      const finalRoleId = resolved?.roleId || roleId
      if (!finalRoleId) return jsonError(res, 400, 'ROLE_REQUIRED', 'template or roleId is required')

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      await query(
        `DELETE FROM user_roles
         WHERE user_id = $1 AND role_id = $2`,
        [userId, finalRoleId],
      )

      const [roles, permissions, isAdmin] = await Promise.all([
        fetchUserRoleIds(userId),
        listUserPermissions(userId),
        isRbacAdmin(userId),
      ])

      return jsonOk(res, {
        user: profile,
        roles,
        permissions,
        isAdmin,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_UNASSIGN_FAILED', (error as Error)?.message || 'Failed to unassign role')
    }
  })

  r.get('/api/attendance-admin/audit-logs', async (req: Request, res: Response) => {
    try {
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 50,
        maxPageSize: 200,
      })

      const from = parseDateParam(req.query.from)
      const to = parseDateParam(req.query.to)
      const { where, params } = buildAttendanceAuditWhere({
        q: req.query.q as string | undefined,
        actionPrefix: req.query.actionPrefix as string | undefined,
        actorId: req.query.actorId as string | undefined,
        route: req.query.route as string | undefined,
        errorCode: req.query.errorCode as string | undefined,
        statusClass: req.query.statusClass as string | undefined,
        from,
        to,
      })

      const count = await query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM operation_audit_logs ${where}`,
        params,
      )
      const total = count.rows[0]?.c ?? 0

      const listSql = `
        SELECT
          id,
          actor_id,
          actor_type,
          action,
          resource_type,
          resource_id,
          request_id,
          COALESCE(ip, ip_address) AS ip,
          user_agent,
          route,
          status_code,
          latency_ms,
          COALESCE(occurred_at, created_at) AS occurred_at,
          COALESCE(meta, metadata, '{}'::jsonb) AS meta
        FROM operation_audit_logs
        ${where}
        ORDER BY COALESCE(occurred_at, created_at) DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `
      const list = await query(listSql, [...params, pageSize, offset])

      return jsonOk(res, { items: list.rows, page, pageSize, total })
    } catch (error) {
      return jsonError(res, 500, 'AUDIT_LOGS_FAILED', (error as Error)?.message || 'Failed to load audit logs')
    }
  })

  r.get('/api/attendance-admin/audit-logs/export.csv', async (req: Request, res: Response) => {
    try {
      const from = parseDateParam(req.query.from)
      const to = parseDateParam(req.query.to)
      const rawLimit = Number(req.query.limit ?? 0) || 0
      const limit = Math.min(Math.max(rawLimit || 5000, 1), 10000)

      const { where, params } = buildAttendanceAuditWhere({
        q: req.query.q as string | undefined,
        actionPrefix: req.query.actionPrefix as string | undefined,
        actorId: req.query.actorId as string | undefined,
        route: req.query.route as string | undefined,
        errorCode: req.query.errorCode as string | undefined,
        statusClass: req.query.statusClass as string | undefined,
        from,
        to,
      })

      const limitIdx = params.length + 1
      const sql = `
        SELECT
          id,
          actor_id,
          actor_type,
          action,
          resource_type,
          resource_id,
          request_id,
          COALESCE(ip, ip_address) AS ip,
          user_agent,
          route,
          status_code,
          latency_ms,
          COALESCE(occurred_at, created_at) AS occurred_at,
          COALESCE(meta, metadata, '{}'::jsonb) AS meta
        FROM operation_audit_logs
        ${where}
        ORDER BY COALESCE(occurred_at, created_at) DESC
        LIMIT $${limitIdx}
      `

      const rows = await query<AttendanceAuditExportRow>(sql, [...params, limit])

      const filename = `attendance-audit-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

      const header = [
        'occurredAt',
        'id',
        'actorId',
        'actorType',
        'action',
        'route',
        'statusCode',
        'latencyMs',
        'resourceType',
        'resourceId',
        'requestId',
        'ip',
        'userAgent',
        'errorCode',
        'errorMessage',
        'meta',
      ].join(',')
      const lines: string[] = [header]

      for (const row of rows.rows) {
        const meta = normalizeAuditMeta(row.meta)
        const errorCode = readAuditMetaText(meta.error?.code)
        const errorMessage = readAuditMetaText(meta.error?.message)
        const occurredAt = formatAuditOccurredAt(row.occurred_at)
        lines.push([
          csvCell(occurredAt),
          csvCell(row.id),
          csvCell(row.actor_id),
          csvCell(row.actor_type),
          csvCell(row.action),
          csvCell(row.route),
          csvCell(row.status_code),
          csvCell(row.latency_ms),
          csvCell(row.resource_type),
          csvCell(row.resource_id),
          csvCell(row.request_id),
          csvCell(row.ip),
          csvCell(row.user_agent),
          csvCell(errorCode),
          csvCell(errorMessage),
          csvCell(meta),
        ].join(','))
      }

      res.send(lines.join('\n'))
    } catch (error) {
      return jsonError(res, 500, 'AUDIT_LOGS_EXPORT_FAILED', (error as Error)?.message || 'Failed to export audit logs')
    }
  })

  r.get('/api/attendance-admin/audit-logs/summary', async (req: Request, res: Response) => {
    try {
      const windowMinutesRaw = Number(req.query.windowMinutes ?? 0) || 0
      const limitRaw = Number(req.query.limit ?? 0) || 0
      const windowMinutes = Math.min(Math.max(windowMinutesRaw || 60, 5), 7 * 24 * 60)
      const limit = Math.min(Math.max(limitRaw || 10, 1), 50)

      const actions = await query<{ action: string; total: number }>(
        `SELECT action, COUNT(*)::int AS total
         FROM operation_audit_logs
         WHERE resource_type = 'attendance'
           AND COALESCE(occurred_at, created_at) >= now() - ($1::int * interval '1 minute')
         GROUP BY action
         ORDER BY total DESC
         LIMIT $2`,
        [windowMinutes, limit],
      )

      const errors = await query<{ error_code: string; total: number }>(
        `SELECT COALESCE(NULLIF(COALESCE(meta, metadata, '{}'::jsonb)->'error'->>'code', ''), 'NONE') AS error_code,
                COUNT(*)::int AS total
         FROM operation_audit_logs
         WHERE resource_type = 'attendance'
           AND COALESCE(occurred_at, created_at) >= now() - ($1::int * interval '1 minute')
         GROUP BY error_code
         ORDER BY total DESC
         LIMIT $2`,
        [windowMinutes, limit],
      )

      return jsonOk(res, {
        windowMinutes,
        actions: actions.rows,
        errors: errors.rows,
      })
    } catch (error) {
      return jsonError(res, 500, 'AUDIT_LOGS_SUMMARY_FAILED', (error as Error)?.message || 'Failed to load audit summary')
    }
  })

  // §7.6 Delivery Closure — OPERATOR-INITIATED redelivery of a single FAILED attendance-notification
  // delivery. Explicit operator request only (there is no background/auto path — see
  // AttendanceNotificationRedelivery doctrine header). Doctrine outcomes map to HTTP:
  //   requeued            → 200 (failed → pending; worker sends exactly once)
  //   already_delivered   → 200 (sent row → no-op; destination already received it, nothing sent)
  //   refused_outcome_unknown → 409 (may already have been delivered; never resent — manual review)
  //   not_eligible        → 409 (failed-but-not-safe / non-dingtalk / pending / sending / retrying /
  //                              skipped — not a redelivery target)
  //   not_found           → 404
  r.post('/api/attendance-admin/notification-deliveries/:deliveryId/redeliver', async (req: Request, res: Response) => {
    // AUTH DIVERGENCE — READ BEFORE "FIXING" THIS BACK TO attendance:admin.
    // Every OTHER route on this router is deliberately guarded by attendance:admin (see the
    // r.use(rbacGuard('attendance','admin')) note above): an attendance-scoped admin surface tenants
    // can delegate. This ONE route is different because it TRIGGERS AN EXTERNAL SEND (the worker
    // re-sends a DingTalk work notification to a real recipient). `attendance:admin` cannot currently
    // prove org-boundedness — user_roles carries no org_id — so an attendance admin of org A could
    // otherwise redeliver a row belonging to org B. Owner transitional ruling (2026-07-11): until the
    // org-scoped-RBAC governance line lands, ONLY a platform admin may invoke this send-triggering
    // route. requireOrgMemberAccess was explicitly REJECTED by the owner for this seam. Reuse the
    // single-source platform-admin check (exported in place from admin-users.ts) so there is no second
    // drifting auth check. It writes the 401/403 response itself and returns null — RETURN EARLY.
    const platformAdminId = await ensurePlatformAdmin(req, res)
    if (!platformAdminId) return

    try {
      const deliveryId = String(req.params.deliveryId || '').trim()
      if (!UUID_RE.test(deliveryId)) {
        return jsonError(res, 400, 'DELIVERY_ID_INVALID', 'deliveryId must be a UUID')
      }
      const result = await redeliverFailedAttendanceNotification(query, deliveryId)

      // VALUES-FREE audit metadata for the attendance audit middleware (which writes ONE audit row on
      // res 'finish'). Passed via res.locals so it never leaks into the client-facing response body
      // and is guaranteed PII-free: org_id, channel, and the prior/result status enums only — NEVER
      // recipient id / phone / source_key / message body. The middleware records it under
      // meta.redelivery + keys resource_id off the :deliveryId param.
      res.locals.attendanceAuditExtra = {
        org_id: result.orgId,
        channel: result.channel,
        old_status: result.previousStatus,
        result: result.outcome,
      }

      switch (result.outcome) {
        case 'requeued':
          return jsonOk(res, { outcome: result.outcome, deliveryId, status: result.status })
        case 'already_delivered':
          // Idempotent no-op: the destination already succeeded; nothing was sent. 200, not an error.
          return jsonOk(res, { outcome: result.outcome, deliveryId, status: result.status })
        case 'refused_outcome_unknown':
          return jsonError(res, 409, 'DELIVERY_OUTCOME_UNKNOWN', 'Delivery outcome is unknown (possibly already delivered); not resent. Reconcile manually.', { deliveryId, status: result.status })
        case 'not_eligible':
          return jsonError(res, 409, 'DELIVERY_NOT_ELIGIBLE', `Delivery is not a redelivery-safe DingTalk failure (status=${result.status}); only definite DingTalk failures can be redelivered.`, { deliveryId, status: result.status })
        case 'not_found':
        default:
          return jsonError(res, 404, 'DELIVERY_NOT_FOUND', 'No such notification delivery')
      }
    } catch (error) {
      return jsonError(res, 500, 'DELIVERY_REDELIVER_FAILED', (error as Error)?.message || 'Failed to redeliver notification')
    }
  })

  return r
}
