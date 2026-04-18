import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import { buildOnboardingPacket } from '../auth/access-presets'
import { recordInvite } from '../auth/invite-ledger'
import { issueInviteToken } from '../auth/invite-tokens'
import { validatePassword } from '../auth/password-policy'
import { Logger } from '../core/logger'
import { query, transaction } from '../db/pg'
import {
  fetchDingTalkAppAccessToken,
  getDingTalkUserDetail,
  listDingTalkDepartments,
  listDingTalkDepartmentUsers,
  type DingTalkDepartment,
  type DingTalkDirectoryUser,
} from '../integrations/dingtalk/client'
import { assertDingTalkCorpAllowed } from '../integrations/dingtalk/runtime-policy'
import {
  deriveDelegatedAdminNamespace,
  isNamespaceAdmissionControlledResource,
  normalizeNamespace,
} from '../rbac/namespace-admission'
import { invalidateUserPerms } from '../rbac/service'
import { decryptStoredSecretValue, normalizeStoredSecretValue } from '../security/encrypted-secrets'
import { getBcryptSaltRounds } from '../security/auth-runtime-config'
import { SimpleCronExpression } from '../services/SchedulerService'

const logger = new Logger('DirectorySync')
const DEFAULT_ORG_ID = 'default'
const DEFAULT_PROVIDER = 'dingtalk'
const DEFAULT_ROOT_DEPARTMENT_ID = '1'
const DEFAULT_PAGE_SIZE = 50
const DEFAULT_ADMISSION_MODE = 'manual_only'
const DEFAULT_MEMBER_GROUP_SYNC_MODE = 'disabled'

type JsonRecord = Record<string, unknown>
export type DirectoryAdmissionMode = 'manual_only' | 'auto_for_scoped_departments'
export type DirectoryMemberGroupSyncMode = 'disabled' | 'sync_scoped_departments'

type DirectoryIntegrationConfig = {
  appKey: string
  appSecret: string
  rootDepartmentId: string
  baseUrl?: string
  pageSize?: number
  admissionMode: DirectoryAdmissionMode
  admissionDepartmentIds: string[]
  excludeDepartmentIds: string[]
  memberGroupSyncMode: DirectoryMemberGroupSyncMode
  memberGroupDepartmentIds: string[]
  memberGroupDefaultRoleIds: string[]
  memberGroupDefaultNamespaces: string[]
}

type DirectoryIntegrationRow = {
  id: string
  org_id: string
  provider: string
  name: string
  status: string
  corp_id: string
  config: JsonRecord | string | null
  sync_enabled: boolean
  schedule_cron: string | null
  default_deprovision_policy: string
  last_sync_at: string | null
  last_success_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
  department_count?: number
  account_count?: number
  pending_link_count?: number
  linked_count?: number
  last_run_status?: string | null
}

type DirectoryRunRow = {
  id: string
  integration_id: string
  status: string
  started_at: string
  finished_at: string | null
  stats: JsonRecord | string | null
  error_message: string | null
  triggered_by: string | null
  trigger_source: string
  created_at: string
  updated_at: string
}

type DirectorySyncAlertRow = {
  id: string
  integration_id: string
  run_id: string | null
  level: string
  code: string
  message: string
  details: JsonRecord | string | null
  sent_to_webhook: boolean
  acknowledged_at: string | null
  acknowledged_by: string | null
  created_at: string
  updated_at: string
}

type DirectoryDepartmentRow = {
  id: string
  external_department_id: string
  name?: string
  full_path?: string | null
}

type DirectoryAccountRow = {
  id: string
  corp_id: string | null
  external_user_id: string
  union_id: string | null
  open_id: string | null
  external_key: string
  name: string
  email: string | null
  mobile: string | null
}

type DirectoryAccountLinkRow = {
  directory_account_id: string
  local_user_id: string | null
  link_status: string
  match_strategy: string | null
}

type ExternalIdentityRow = {
  external_key: string
  provider_union_id: string | null
  provider_open_id: string | null
  corp_id: string | null
  local_user_id: string
}

type LocalUserRow = {
  id: string
  email?: string | null
  username?: string | null
  mobile?: string | null
}

type DirectoryIntegrationAccountRow = {
  integration_id: string
  provider: string
  corp_id: string | null
  directory_account_id: string
  external_user_id: string
  union_id: string | null
  open_id: string | null
  external_key: string
  account_name: string
  account_email: string | null
  account_mobile: string | null
  account_is_active: boolean
  account_updated_at: string
  link_status: string | null
  match_strategy: string | null
  reviewed_by: string | null
  review_note: string | null
  link_updated_at: string | null
  local_user_id: string | null
  local_user_email: string | null
  local_user_username: string | null
  local_user_name: string | null
  department_paths: string[] | null
}

type DirectoryReviewItemRow = DirectoryIntegrationAccountRow & {
  review_kind: string
  review_reason: string
  missing_union_id: boolean
  missing_open_id: boolean
}

type DirectoryBindingUserRow = {
  id: string
  email: string | null
  username: string | null
  mobile: string | null
  name: string | null
  role: string
  is_active: boolean
}

type DirectoryBindingCandidateRow = DirectoryBindingUserRow & {
  mobile: string | null
}

type DirectoryLinkedAccountByUserRow = {
  local_user_id: string
  directory_account_id: string
}

type DirectoryIdentityByUserRow = {
  local_user_id: string
  external_key: string
  provider_union_id: string | null
  provider_open_id: string | null
  corp_id: string | null
}

type DirectoryReviewRecommendationResult = {
  recommendations: DirectoryBindingRecommendation[]
  status: DirectoryBindingRecommendationStatus
}

type DirectoryBindingTargetAccountRow = {
  id: string
  integration_id: string
  provider: string
  corp_id: string | null
  external_user_id: string
  union_id: string | null
  open_id: string | null
  external_key: string
  name: string
  email: string | null
  mobile: string | null
}

type DirectoryAccountLinkedUserRow = {
  local_user_id: string | null
  local_user_email: string | null
  local_user_username: string | null
  local_user_name: string | null
}

export type DirectoryIntegrationSummary = {
  id: string
  orgId: string
  provider: string
  name: string
  status: string
  corpId: string
  syncEnabled: boolean
  scheduleCron: string | null
  defaultDeprovisionPolicy: string
  lastSyncAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  config: {
    appKey: string
    appSecretConfigured: boolean
    rootDepartmentId: string
    baseUrl: string | null
    pageSize: number
    admissionMode: DirectoryAdmissionMode
    admissionDepartmentIds: string[]
    excludeDepartmentIds: string[]
    memberGroupSyncMode: DirectoryMemberGroupSyncMode
    memberGroupDepartmentIds: string[]
    memberGroupDefaultRoleIds: string[]
    memberGroupDefaultNamespaces: string[]
  }
  stats: {
    departmentCount: number
    accountCount: number
    pendingLinkCount: number
    linkedCount: number
    lastRunStatus: string | null
  }
}

export type DirectoryIntegrationInput = {
  name: string
  corpId: string
  appKey: string
  appSecret?: string
  rootDepartmentId?: string
  baseUrl?: string
  pageSize?: number
  admissionMode?: DirectoryAdmissionMode | string
  admissionDepartmentIds?: string[] | string
  excludeDepartmentIds?: string[] | string
  memberGroupSyncMode?: DirectoryMemberGroupSyncMode | string
  memberGroupDepartmentIds?: string[] | string
  memberGroupDefaultRoleIds?: string[] | string
  memberGroupDefaultNamespaces?: string[] | string
  syncEnabled?: boolean
  scheduleCron?: string | null
  defaultDeprovisionPolicy?: string
  status?: string
}

export type DirectoryIntegrationTestInput = DirectoryIntegrationInput & {
  integrationId?: string
}

type NormalizedDirectoryIntegrationInput = Omit<
  DirectoryIntegrationInput,
  | 'name'
  | 'corpId'
  | 'appKey'
  | 'appSecret'
  | 'rootDepartmentId'
  | 'admissionMode'
  | 'admissionDepartmentIds'
  | 'excludeDepartmentIds'
  | 'memberGroupSyncMode'
  | 'memberGroupDepartmentIds'
  | 'memberGroupDefaultRoleIds'
  | 'memberGroupDefaultNamespaces'
  | 'defaultDeprovisionPolicy'
  | 'status'
> & {
  name: string
  corpId: string
  appKey: string
  appSecret: string
  rootDepartmentId: string
  admissionMode: DirectoryAdmissionMode
  admissionDepartmentIds: string[]
  excludeDepartmentIds: string[]
  memberGroupSyncMode: DirectoryMemberGroupSyncMode
  memberGroupDepartmentIds: string[]
  memberGroupDefaultRoleIds: string[]
  memberGroupDefaultNamespaces: string[]
  defaultDeprovisionPolicy: string
  status: string
}

export type DirectoryIntegrationTestResult = {
  corpId: string
  rootDepartmentId: string
  appKey: string
  departmentSampleCount: number
  sampledDepartments: Array<{ id: string; name: string }>
  userSampleCount: number
  sampledUsers: Array<{ userId: string; name: string }>
  diagnostics: {
    rootDepartmentChildCount: number
    rootDepartmentDirectUserCount: number
    rootDepartmentDirectUserHasMore: boolean
    rootDepartmentDirectUserCountWithAccessLimit: number
    rootDepartmentDirectUserHasMoreWithAccessLimit: boolean
    sampledRootDepartmentUsers: Array<{ userId: string; name: string }>
    sampledRootDepartmentUsersWithAccessLimit: Array<{ userId: string; name: string }>
  }
  warnings: string[]
}

export type DirectorySyncRunSummary = {
  id: string
  integrationId: string
  status: string
  startedAt: string
  finishedAt: string | null
  stats: JsonRecord
  errorMessage: string | null
  triggeredBy: string | null
  triggerSource: string
  createdAt: string
  updatedAt: string
}

export type DirectorySyncAlertFilter = 'all' | 'pending' | 'acknowledged'

export type DirectorySyncAlertSummary = {
  id: string
  integrationId: string
  runId: string | null
  level: string
  code: string
  message: string
  details: JsonRecord
  sentToWebhook: boolean
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  createdAt: string
  updatedAt: string
}

export type DirectorySyncObservationStatus =
  | 'disabled'
  | 'missing_cron'
  | 'invalid_cron'
  | 'awaiting_first_run'
  | 'scheduler_observed'
  | 'configured_no_runs'
  | 'manual_only'
  | 'auto_observed'

export type DirectorySyncScheduleSnapshot = {
  integrationId: string
  syncEnabled: boolean
  scheduleCron: string | null
  cronValid: boolean
  nextExpectedRunAt: string | null
  lastRun: DirectorySyncRunSummary | null
  lastManualRun: DirectorySyncRunSummary | null
  lastAutomaticRun: DirectorySyncRunSummary | null
  observationStatus: DirectorySyncObservationStatus
  observationMessage: string
}

export type DirectoryReviewItemFilter = 'all' | 'pending_binding' | 'inactive_linked' | 'missing_identifier'

export type DirectoryBindingRecommendationReason = 'pending_link' | 'email' | 'mobile'

export type DirectoryBindingRecommendationStatusCode =
  | 'recommended'
  | 'no_exact_match'
  | 'ambiguous_exact_match'
  | 'pending_link_conflict'
  | 'linked_user_conflict'
  | 'external_identity_conflict'

export type DirectoryBindingRecommendation = {
  localUser: {
    id: string
    email: string | null
    username: string | null
    name: string | null
    mobile: string | null
    role: string
    isActive: boolean
  }
  reasons: DirectoryBindingRecommendationReason[]
}

export type DirectoryBindingRecommendationStatus = {
  code: DirectoryBindingRecommendationStatusCode
  message: string
}

export type DirectoryReviewItemSummary = {
  kind: DirectoryReviewItemFilter
  reason: string
  account: DirectoryIntegrationAccountSummary
  recommendations: DirectoryBindingRecommendation[]
  recommendationStatus: DirectoryBindingRecommendationStatus | null
  flags: {
    missingUnionId: boolean
    missingOpenId: boolean
  }
  actionable: {
    canBatchUnbind: boolean
    canConfirmRecommendation: boolean
  }
}

export type DirectoryIntegrationAccountSummary = {
  id: string
  integrationId: string
  provider: string
  corpId: string | null
  externalUserId: string
  unionId: string | null
  openId: string | null
  externalKey: string
  name: string
  email: string | null
  mobile: string | null
  isActive: boolean
  updatedAt: string
  linkStatus: string
  matchStrategy: string | null
  reviewedBy: string | null
  reviewNote: string | null
  linkUpdatedAt: string | null
  localUser: {
    id: string
    email: string | null
    username: string | null
    name: string | null
  } | null
  departmentPaths: string[]
}

export type DirectoryAccountBindInput = {
  localUserRef: string
  adminUserId: string
  enableDingTalkGrant?: boolean
}

export type DirectoryAccountBatchBindEntry = {
  accountId: string
  localUserRef: string
  enableDingTalkGrant?: boolean
}

export type DirectoryAccountUnbindInput = {
  adminUserId: string
  disableDingTalkGrant?: boolean
}

export type DirectoryAccountMutationResult = {
  account: DirectoryIntegrationAccountSummary
  previousLocalUser: {
    id: string
    email: string | null
    name: string | null
  } | null
}

export type DirectoryAccountManualAdmissionInput = {
  adminUserId: string
  name: string
  email?: string
  username?: string
  mobile?: string | null
  enableDingTalkGrant?: boolean
  password?: string
}

export type DirectoryAccountManualAdmissionResult = DirectoryAccountMutationResult & {
  user: {
    id: string
    email: string | null
    username: string | null
    name: string
    mobile: string | null
    role: string
    is_active: boolean
  }
  temporaryPassword?: string
  inviteToken: string | null
  onboarding: ReturnType<typeof buildOnboardingPacket>
}

export type DirectoryAutoAdmissionEligibility = {
  inScope: boolean
  missingEmail: boolean
  excluded?: boolean
}

export type DirectoryProjectedMemberGroupPlan = {
  externalDepartmentId: string
  name: string
  marker: string
  memberUserIds: string[]
}

export type DirectoryProjectedGovernanceGrantSet = {
  userIds: string[]
  roleIds: string[]
  namespaces: string[]
}

function parseJsonRecord(value: JsonRecord | string | null | undefined): JsonRecord {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed as JsonRecord : {}
    } catch {
      return {}
    }
  }
  return value
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

function normalizeOptionalText(value: unknown): string | null {
  const text = normalizeText(value)
  return text.length > 0 ? text : null
}

function sanitizeDirectoryAdmissionEmail(value: string): string {
  return normalizeText(value).toLowerCase().slice(0, 255)
}

function sanitizeDirectoryAdmissionName(value: string): string {
  return normalizeText(value).replace(/[<>'"&;]/g, '').slice(0, 100)
}

function sanitizeDirectoryAdmissionMobile(value: unknown): string | null {
  const text = normalizeText(value).replace(/\s+/g, '')
  if (!text) return null
  return text.slice(0, 32)
}

function sanitizeDirectoryAdmissionUsername(value: unknown): string | null {
  const text = normalizeText(value).toLowerCase()
  if (!text) return null
  return text.slice(0, 64)
}

function validateDirectoryAdmissionUsername(username: string | null): string | null {
  if (!username) return null
  if (!/^(?=.*[a-z])[a-z0-9._-]{3,64}$/.test(username)) {
    return 'Username must be 3-64 characters and include at least one letter. Only lowercase letters, numbers, dot, underscore, and dash are allowed'
  }
  return null
}

function resolveDirectoryAdmissionAccountLabel(options: {
  email?: string | null
  username?: string | null
  mobile?: string | null
  userId?: string | null
}): string {
  return options.email || options.username || options.mobile || options.userId || '由管理员单独告知'
}

function generateDirectoryAdmissionTemporaryPassword(): string {
  return `Tmp-${crypto.randomBytes(8).toString('base64url')}9A`
}

function normalizePageSize(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_PAGE_SIZE
  return Math.min(Math.max(Math.trunc(numeric), 1), 100)
}

function normalizeAdmissionMode(value: unknown, fallback: DirectoryAdmissionMode = DEFAULT_ADMISSION_MODE): DirectoryAdmissionMode {
  const normalized = normalizeText(value)
  if (normalized === 'auto_for_scoped_departments') return normalized
  return fallback
}

function normalizeMemberGroupSyncMode(
  value: unknown,
  fallback: DirectoryMemberGroupSyncMode = DEFAULT_MEMBER_GROUP_SYNC_MODE,
): DirectoryMemberGroupSyncMode {
  if (value === 'sync_scoped_departments') return 'sync_scoped_departments'
  if (value === 'disabled') return 'disabled'
  return fallback
}

function normalizeAdmissionDepartmentIds(value: unknown, fallback: string[] = []): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : fallback
  const deduped = new Set<string>()
  for (const entry of rawValues) {
    const normalized = normalizeText(entry)
    if (!normalized) continue
    deduped.add(normalized)
  }
  return Array.from(deduped)
}

function normalizeExcludeDepartmentIds(value: unknown, fallback: string[] = []): string[] {
  return normalizeAdmissionDepartmentIds(value, fallback)
}

function normalizeMemberGroupDepartmentIds(value: unknown, fallback: string[] = []): string[] {
  return normalizeAdmissionDepartmentIds(value, fallback)
}

function normalizeMemberGroupDefaultRoleIds(value: unknown, fallback: string[] = []): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : fallback
  const deduped = new Set<string>()
  for (const entry of rawValues) {
    const normalized = normalizeText(entry)
    if (!normalized) continue
    deduped.add(normalized)
  }
  return Array.from(deduped)
}

function normalizeMemberGroupDefaultNamespaces(value: unknown, fallback: string[] = []): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : fallback
  const deduped = new Set<string>()
  for (const entry of rawValues) {
    const normalized = normalizeNamespace(entry)
    if (!normalized || !isNamespaceAdmissionControlledResource(normalized)) continue
    deduped.add(normalized)
  }
  return Array.from(deduped)
}

export function isDirectoryUserWithinAdmissionScope(
  userDepartmentIds: string[],
  allowedDepartmentIds: string[],
  departments: Map<string, Pick<DingTalkDepartment, 'id' | 'parentId'>>,
): boolean {
  if (allowedDepartmentIds.length === 0 || userDepartmentIds.length === 0) return false
  const allowed = new Set(allowedDepartmentIds.map((value) => normalizeText(value)).filter(Boolean))
  if (allowed.size === 0) return false

  for (const departmentId of userDepartmentIds.map((value) => normalizeText(value)).filter(Boolean)) {
    let currentId: string | null = departmentId
    const seen = new Set<string>()

    while (currentId && !seen.has(currentId)) {
      if (allowed.has(currentId)) return true
      seen.add(currentId)
      currentId = departments.get(currentId)?.parentId ?? null
    }
  }

  return false
}

export function evaluateDirectoryAutoAdmissionEligibility(options: {
  admissionMode: DirectoryAdmissionMode
  admissionDepartmentIds: string[]
  excludeDepartmentIds: string[]
  userDepartmentIds: string[]
  departments: Map<string, Pick<DingTalkDepartment, 'id' | 'parentId'>>
  email: string | null
}): DirectoryAutoAdmissionEligibility {
  if (options.admissionMode !== 'auto_for_scoped_departments') {
    return { inScope: false, missingEmail: false }
  }

  const inAllowedScope = isDirectoryUserWithinAdmissionScope(
    options.userDepartmentIds,
    options.admissionDepartmentIds,
    options.departments,
  )
  if (!inAllowedScope) return { inScope: false, missingEmail: false }

  const excluded = isDirectoryUserWithinAdmissionScope(
    options.userDepartmentIds,
    options.excludeDepartmentIds,
    options.departments,
  )
  if (excluded) {
    return { inScope: false, missingEmail: false, excluded: true }
  }

  return {
    inScope: true,
    missingEmail: !normalizeText(options.email),
  }
}

function normalizeDirectorySyncAuditUserId(adminUserId: string): string | null {
  const normalized = normalizeText(adminUserId)
  if (!normalized || normalized.startsWith('system:')) return null
  return normalized
}

function buildDirectoryProjectedMemberGroupMarker(integrationId: string, externalDepartmentId: string): string {
  return `dingtalk-sync-group:${normalizeText(integrationId)}:${normalizeText(externalDepartmentId)}`
}

function buildDirectoryProjectedMemberGroupName(
  integrationName: string,
  departmentPath: string,
  externalDepartmentId: string,
): string {
  const normalizedPath = normalizeText(departmentPath)
  const normalizedDepartmentId = normalizeText(externalDepartmentId)
  return `钉钉同步 · ${normalizeText(integrationName)} · ${normalizedPath || normalizedDepartmentId}`
}

export function buildDirectoryProjectedMemberGroupPlans(options: {
  integrationId: string
  integrationName: string
  memberGroupSyncMode: DirectoryMemberGroupSyncMode
  memberGroupDepartmentIds: string[]
  departments: Map<string, Pick<DingTalkDepartment, 'id' | 'parentId' | 'name'>>
  departmentPathMap: Map<string, string>
  userDepartmentIdsByExternalUserId: Map<string, string[]>
  linkedUserIdByExternalUserId: Map<string, string>
}): DirectoryProjectedMemberGroupPlan[] {
  if (options.memberGroupSyncMode !== 'sync_scoped_departments') return []
  const plans: DirectoryProjectedMemberGroupPlan[] = []
  for (const externalDepartmentId of options.memberGroupDepartmentIds) {
    const normalizedDepartmentId = normalizeText(externalDepartmentId)
    if (!normalizedDepartmentId) continue
    const department = options.departments.get(normalizedDepartmentId)
    if (!department) continue
    const memberUserIds = new Set<string>()
    for (const [externalUserId, userId] of options.linkedUserIdByExternalUserId.entries()) {
      const userDepartmentIds = options.userDepartmentIdsByExternalUserId.get(externalUserId) ?? []
      const inScope = isDirectoryUserWithinAdmissionScope(
        userDepartmentIds,
        [normalizedDepartmentId],
        options.departments,
      )
      if (inScope) memberUserIds.add(userId)
    }
    plans.push({
      externalDepartmentId: normalizedDepartmentId,
      name: buildDirectoryProjectedMemberGroupName(
        options.integrationName,
        options.departmentPathMap.get(normalizedDepartmentId) ?? department.name,
        normalizedDepartmentId,
      ),
      marker: buildDirectoryProjectedMemberGroupMarker(options.integrationId, normalizedDepartmentId),
      memberUserIds: Array.from(memberUserIds).sort(),
    })
  }
  return plans
}

export function buildDirectoryProjectedGovernanceGrantSet(options: {
  plans: DirectoryProjectedMemberGroupPlan[]
  defaultRoleIds: string[]
  defaultNamespaces: string[]
}): DirectoryProjectedGovernanceGrantSet {
  const userIds = Array.from(new Set(
    options.plans.flatMap((plan) => plan.memberUserIds.map((value) => normalizeText(value)).filter(Boolean)),
  )).sort()
  return {
    userIds,
    roleIds: normalizeMemberGroupDefaultRoleIds(options.defaultRoleIds),
    namespaces: normalizeMemberGroupDefaultNamespaces(options.defaultNamespaces),
  }
}

async function assertDirectoryProjectedGovernanceConfigValid(config: Pick<
  DirectoryIntegrationConfig,
  'memberGroupDefaultRoleIds' | 'memberGroupDefaultNamespaces'
>): Promise<void> {
  const roleIds = normalizeMemberGroupDefaultRoleIds(config.memberGroupDefaultRoleIds)
  const namespaces = normalizeMemberGroupDefaultNamespaces(config.memberGroupDefaultNamespaces)

  for (const roleId of roleIds) {
    if (roleId === 'admin' || deriveDelegatedAdminNamespace(roleId)) {
      throw new Error('Projected member-group default roles cannot include platform admin or delegated admin roles')
    }
  }

  if (roleIds.length > 0) {
    const existingRoles = await query<{ id: string }>(
      `SELECT id
       FROM roles
       WHERE id = ANY($1::text[])`,
      [roleIds],
    )
    const existingRoleIds = new Set(existingRoles.rows.map((row) => normalizeText(row.id)).filter(Boolean))
    const missingRoleIds = roleIds.filter((roleId) => !existingRoleIds.has(roleId))
    if (missingRoleIds.length > 0) {
      throw new Error(`Projected member-group default roles not found: ${missingRoleIds.join(', ')}`)
    }
  }

  const unsupportedNamespaces = namespaces.filter((namespace) => !isNamespaceAdmissionControlledResource(namespace))
  if (unsupportedNamespaces.length > 0) {
    throw new Error(`Projected member-group default namespaces are not admission-controlled: ${unsupportedNamespaces.join(', ')}`)
  }
}

function parseIntegrationConfig(row: Pick<DirectoryIntegrationRow, 'config'>): DirectoryIntegrationConfig {
  const config = parseJsonRecord(row.config)
  const appKey = normalizeText(config.appKey)
  const rawAppSecret = normalizeText(config.appSecret)
  const appSecret = rawAppSecret ? decryptStoredSecretValue(rawAppSecret) : ''
  const rootDepartmentId = normalizeText(config.rootDepartmentId) || DEFAULT_ROOT_DEPARTMENT_ID
  const baseUrl = normalizeOptionalText(config.baseUrl) ?? undefined
  const pageSize = normalizePageSize(config.pageSize)
  const admissionMode = normalizeAdmissionMode(config.admissionMode)
  const admissionDepartmentIds = normalizeAdmissionDepartmentIds(config.admissionDepartmentIds)
  const excludeDepartmentIds = normalizeExcludeDepartmentIds(config.excludeDepartmentIds)
  const memberGroupSyncMode = normalizeMemberGroupSyncMode(config.memberGroupSyncMode)
  const memberGroupDepartmentIds = normalizeMemberGroupDepartmentIds(config.memberGroupDepartmentIds)
  const memberGroupDefaultRoleIds = normalizeMemberGroupDefaultRoleIds(config.memberGroupDefaultRoleIds)
  const memberGroupDefaultNamespaces = normalizeMemberGroupDefaultNamespaces(config.memberGroupDefaultNamespaces)
  return {
    appKey,
    appSecret,
    rootDepartmentId,
    baseUrl,
    pageSize,
    admissionMode,
    admissionDepartmentIds,
    excludeDepartmentIds,
    memberGroupSyncMode,
    memberGroupDepartmentIds,
    memberGroupDefaultRoleIds,
    memberGroupDefaultNamespaces,
  }
}

function summarizeIntegration(row: DirectoryIntegrationRow): DirectoryIntegrationSummary {
  const config = parseIntegrationConfig(row)
  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    name: row.name,
    status: row.status,
    corpId: row.corp_id,
    syncEnabled: Boolean(row.sync_enabled),
    scheduleCron: row.schedule_cron,
    defaultDeprovisionPolicy: row.default_deprovision_policy,
    lastSyncAt: row.last_sync_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config: {
      appKey: config.appKey,
      appSecretConfigured: Boolean(config.appSecret),
      rootDepartmentId: config.rootDepartmentId,
      baseUrl: config.baseUrl ?? null,
      pageSize: config.pageSize,
      admissionMode: config.admissionMode,
      admissionDepartmentIds: config.admissionDepartmentIds,
      excludeDepartmentIds: config.excludeDepartmentIds,
      memberGroupSyncMode: config.memberGroupSyncMode,
      memberGroupDepartmentIds: config.memberGroupDepartmentIds,
      memberGroupDefaultRoleIds: config.memberGroupDefaultRoleIds,
      memberGroupDefaultNamespaces: config.memberGroupDefaultNamespaces,
    },
    stats: {
      departmentCount: Number(row.department_count ?? 0),
      accountCount: Number(row.account_count ?? 0),
      pendingLinkCount: Number(row.pending_link_count ?? 0),
      linkedCount: Number(row.linked_count ?? 0),
      lastRunStatus: row.last_run_status ?? null,
    },
  }
}

function summarizeRun(row: DirectoryRunRow): DirectorySyncRunSummary {
  return {
    id: row.id,
    integrationId: row.integration_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stats: parseJsonRecord(row.stats),
    errorMessage: row.error_message,
    triggeredBy: row.triggered_by,
    triggerSource: row.trigger_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function summarizeAlert(row: DirectorySyncAlertRow): DirectorySyncAlertSummary {
  return {
    id: row.id,
    integrationId: row.integration_id,
    runId: row.run_id,
    level: row.level,
    code: row.code,
    message: row.message,
    details: parseJsonRecord(row.details),
    sentToWebhook: Boolean(row.sent_to_webhook),
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function summarizeReviewItem(
  row: DirectoryReviewItemRow,
  recommendation: DirectoryReviewRecommendationResult | null = null,
): DirectoryReviewItemSummary {
  const kind = row.review_kind === 'inactive_linked' || row.review_kind === 'missing_identifier'
    ? row.review_kind
    : 'pending_binding'
  const recommendations = recommendation?.recommendations ?? []

  return {
    kind,
    reason: row.review_reason,
    account: summarizeDirectoryAccount(row),
    recommendations,
    recommendationStatus: kind === 'pending_binding'
      ? recommendation?.status ?? {
        code: 'no_exact_match',
        message: '未命中唯一的邮箱或手机号精确匹配，请人工搜索本地用户。',
      }
      : null,
    flags: {
      missingUnionId: Boolean(row.missing_union_id),
      missingOpenId: Boolean(row.missing_open_id),
    },
    actionable: {
      canBatchUnbind: kind === 'inactive_linked' && Boolean(row.local_user_id),
      canConfirmRecommendation: kind === 'pending_binding' && recommendations.length > 0,
    },
  }
}

function summarizeDirectoryAccount(row: DirectoryIntegrationAccountRow): DirectoryIntegrationAccountSummary {
  return {
    id: row.directory_account_id,
    integrationId: row.integration_id,
    provider: row.provider,
    corpId: row.corp_id,
    externalUserId: row.external_user_id,
    unionId: row.union_id,
    openId: row.open_id,
    externalKey: row.external_key,
    name: row.account_name,
    email: row.account_email,
    mobile: row.account_mobile,
    isActive: row.account_is_active,
    updatedAt: row.account_updated_at,
    linkStatus: row.link_status ?? 'unmatched',
    matchStrategy: row.match_strategy,
    reviewedBy: row.reviewed_by,
    reviewNote: row.review_note,
    linkUpdatedAt: row.link_updated_at,
    localUser: row.local_user_id
      ? {
        id: row.local_user_id,
        email: row.local_user_email,
        username: row.local_user_username,
        name: row.local_user_name,
      }
      : null,
    departmentPaths: Array.isArray(row.department_paths) ? row.department_paths.filter(Boolean) : [],
  }
}

function readErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return fallback
}

function buildScopedIdentityKey(corpId: string | null | undefined, providerId: string | null | undefined): string | null {
  const normalizedProviderId = normalizeText(providerId)
  if (!normalizedProviderId) return null
  const normalizedCorpId = normalizeText(corpId)
  return normalizedCorpId ? `${normalizedCorpId}:${normalizedProviderId}` : `global:${normalizedProviderId}`
}

function buildDingTalkIdentityExternalKey(corpId: string | null | undefined, openId: string | null | undefined, unionId: string | null | undefined): string {
  const normalizedCorpId = normalizeText(corpId)
  const normalizedOpenId = normalizeText(openId)
  const normalizedUnionId = normalizeText(unionId)

  if (normalizedCorpId && normalizedOpenId) {
    return `${normalizedCorpId}:${normalizedOpenId}`
  }

  return normalizedUnionId || normalizedOpenId
}

function buildRecommendationScore(reasons: DirectoryBindingRecommendationReason[]): number {
  let score = 0
  if (reasons.includes('pending_link')) score += 100
  if (reasons.includes('email')) score += 10
  if (reasons.includes('mobile')) score += 5
  return score
}

function sortRecommendationReasons(reasons: Iterable<DirectoryBindingRecommendationReason>): DirectoryBindingRecommendationReason[] {
  const order: DirectoryBindingRecommendationReason[] = ['pending_link', 'email', 'mobile']
  const values = new Set(reasons)
  return order.filter((item) => values.has(item))
}

function buildRecommendationStatus(
  code: DirectoryBindingRecommendationStatusCode,
): DirectoryBindingRecommendationStatus {
  if (code === 'recommended') {
    return {
      code,
      message: '已命中唯一精确候选，可直接确认推荐绑定。',
    }
  }
  if (code === 'ambiguous_exact_match') {
    return {
      code,
      message: '邮箱或手机号命中多个本地用户，需人工确认。',
    }
  }
  if (code === 'pending_link_conflict') {
    return {
      code,
      message: '现有待确认匹配与精确候选不一致，请人工复核。',
    }
  }
  if (code === 'linked_user_conflict') {
    return {
      code,
      message: '候选本地用户已链接其他钉钉目录成员，请人工处理。',
    }
  }
  if (code === 'external_identity_conflict') {
    return {
      code,
      message: '候选本地用户已绑定其他钉钉身份，请人工处理。',
    }
  }
  return {
    code,
    message: '未命中唯一的邮箱或手机号精确匹配，请人工搜索本地用户。',
  }
}

function doesExternalIdentityMatchAccount(
  identity: DirectoryIdentityByUserRow,
  account: Pick<DirectoryReviewItemRow, 'corp_id' | 'external_key' | 'open_id' | 'union_id'>,
): boolean {
  const externalKey = buildDingTalkIdentityExternalKey(account.corp_id, account.open_id, account.union_id)
  if (externalKey && identity.external_key === externalKey) return true

  const scopedOpenKey = buildScopedIdentityKey(account.corp_id, account.open_id)
  const identityOpenKey = buildScopedIdentityKey(identity.corp_id, identity.provider_open_id)
  if (scopedOpenKey && identityOpenKey && scopedOpenKey === identityOpenKey) return true

  const scopedUnionKey = buildScopedIdentityKey(account.corp_id, account.union_id)
  const identityUnionKey = buildScopedIdentityKey(identity.corp_id, identity.provider_union_id)
  if (scopedUnionKey && identityUnionKey && scopedUnionKey === identityUnionKey) return true

  return normalizeText(identity.external_key) !== '' && identity.external_key === normalizeText(account.external_key)
}

async function loadDirectoryReviewRecommendations(
  rows: DirectoryReviewItemRow[],
): Promise<Map<string, DirectoryReviewRecommendationResult>> {
  const pendingRows = rows.filter((row) => row.review_kind === 'pending_binding')
  const emails = Array.from(new Set(
    pendingRows
      .map((row) => normalizeText(row.account_email).toLowerCase())
      .filter(Boolean),
  ))
  const mobiles = Array.from(new Set(
    pendingRows
      .map((row) => normalizeText(row.account_mobile))
      .filter(Boolean),
  ))

  if (pendingRows.length === 0) {
    return new Map()
  }

  const candidateUsersResult = emails.length > 0 || mobiles.length > 0
    ? await query<DirectoryBindingCandidateRow>(
      `SELECT id,
              email,
              name,
              COALESCE(role, 'user') AS role,
              COALESCE(is_active, TRUE) AS is_active,
              mobile
       FROM users
       WHERE COALESCE(is_active, TRUE) = TRUE
         AND (
           LOWER(email) = ANY($1::text[])
           OR mobile = ANY($2::text[])
         )`,
      [emails, mobiles],
    )
    : { rows: [] }

  const usersByEmail = new Map<string, DirectoryBindingCandidateRow[]>()
  const usersByMobile = new Map<string, DirectoryBindingCandidateRow[]>()
  const userDetailsById = new Map<string, DirectoryBindingCandidateRow>()

  for (const user of candidateUsersResult.rows) {
    userDetailsById.set(user.id, user)

    const normalizedEmail = normalizeText(user.email).toLowerCase()
    if (normalizedEmail) {
      const items = usersByEmail.get(normalizedEmail) ?? []
      items.push(user)
      usersByEmail.set(normalizedEmail, items)
    }

    const normalizedMobile = normalizeText(user.mobile)
    if (normalizedMobile) {
      const items = usersByMobile.get(normalizedMobile) ?? []
      items.push(user)
      usersByMobile.set(normalizedMobile, items)
    }
  }

  const candidateUserIds = Array.from(new Set(candidateUsersResult.rows.map((user) => user.id)))
  const [linkedAccountsResult, identitiesResult] = candidateUserIds.length > 0
    ? await Promise.all([
      query<DirectoryLinkedAccountByUserRow>(
        `SELECT l.local_user_id, l.directory_account_id
         FROM directory_account_links l
         JOIN directory_accounts a ON a.id = l.directory_account_id
         WHERE a.provider = $1
           AND l.link_status = 'linked'
           AND l.local_user_id = ANY($2::text[])`,
        [DEFAULT_PROVIDER, candidateUserIds],
      ),
      query<DirectoryIdentityByUserRow>(
        `SELECT local_user_id, external_key, provider_union_id, provider_open_id, corp_id
         FROM user_external_identities
         WHERE provider = $1
           AND local_user_id = ANY($2::text[])`,
        [DEFAULT_PROVIDER, candidateUserIds],
      ),
    ])
    : [{ rows: [] }, { rows: [] }]

  const linkedAccountsByUser = new Map<string, Set<string>>()
  for (const row of linkedAccountsResult.rows) {
    const accountIds = linkedAccountsByUser.get(row.local_user_id) ?? new Set<string>()
    accountIds.add(row.directory_account_id)
    linkedAccountsByUser.set(row.local_user_id, accountIds)
  }

  const identitiesByUser = new Map<string, DirectoryIdentityByUserRow>()
  for (const row of identitiesResult.rows) {
    identitiesByUser.set(row.local_user_id, row)
  }

  const summaries = new Map<string, DirectoryReviewRecommendationResult>()
  for (const row of pendingRows) {
    const matches = new Map<string, Set<DirectoryBindingRecommendationReason>>()
    const normalizedEmail = normalizeText(row.account_email).toLowerCase()
    const normalizedMobile = normalizeText(row.account_mobile)
    const emailMatches = normalizedEmail ? (usersByEmail.get(normalizedEmail) ?? []) : []
    const mobileMatches = normalizedMobile ? (usersByMobile.get(normalizedMobile) ?? []) : []
    const hasAmbiguousEmail = emailMatches.length > 1
    const hasAmbiguousMobile = mobileMatches.length > 1

    if (emailMatches.length === 1) {
      matches.set(emailMatches[0].id, new Set<DirectoryBindingRecommendationReason>(['email']))
    }
    if (mobileMatches.length === 1) {
      const reasons = matches.get(mobileMatches[0].id) ?? new Set<DirectoryBindingRecommendationReason>()
      reasons.add('mobile')
      matches.set(mobileMatches[0].id, reasons)
    }

    const pendingLocalUserId = normalizeText(row.local_user_id)
    if (pendingLocalUserId) {
      if (matches.size === 1 && matches.has(pendingLocalUserId)) {
        matches.get(pendingLocalUserId)?.add('pending_link')
      } else if (matches.size > 0) {
        summaries.set(row.directory_account_id, {
          recommendations: [],
          status: buildRecommendationStatus('pending_link_conflict'),
        })
        continue
      }
    }

    if (hasAmbiguousEmail || hasAmbiguousMobile || matches.size > 1) {
      summaries.set(row.directory_account_id, {
        recommendations: [],
        status: buildRecommendationStatus('ambiguous_exact_match'),
      })
      continue
    }

    if (matches.size !== 1) {
      summaries.set(row.directory_account_id, {
        recommendations: [],
        status: buildRecommendationStatus('no_exact_match'),
      })
      continue
    }

    const [candidateUserId, reasons] = Array.from(matches.entries())[0]
    const user = userDetailsById.get(candidateUserId)
    if (!user?.is_active) {
      summaries.set(row.directory_account_id, {
        recommendations: [],
        status: buildRecommendationStatus('no_exact_match'),
      })
      continue
    }

    const linkedAccounts = linkedAccountsByUser.get(candidateUserId)
    if (linkedAccounts && Array.from(linkedAccounts).some((accountId) => accountId !== row.directory_account_id)) {
      summaries.set(row.directory_account_id, {
        recommendations: [],
        status: buildRecommendationStatus('linked_user_conflict'),
      })
      continue
    }

    const externalIdentity = identitiesByUser.get(candidateUserId)
    if (externalIdentity && !doesExternalIdentityMatchAccount(externalIdentity, row)) {
      summaries.set(row.directory_account_id, {
        recommendations: [],
        status: buildRecommendationStatus('external_identity_conflict'),
      })
      continue
    }

    summaries.set(row.directory_account_id, {
      recommendations: [{
        localUser: {
          id: user.id,
          email: user.email,
          username: user.username ?? null,
          name: user.name,
          mobile: user.mobile,
          role: user.role,
          isActive: user.is_active,
        },
        reasons: sortRecommendationReasons(reasons),
      }].sort((left, right) => buildRecommendationScore(right.reasons) - buildRecommendationScore(left.reasons)),
      status: buildRecommendationStatus('recommended'),
    })
  }

  return summaries
}

function normalizeIntegrationInput(
  input: DirectoryIntegrationInput,
  current?: DirectoryIntegrationConfig,
): NormalizedDirectoryIntegrationInput {
  const name = normalizeText(input.name)
  const corpId = normalizeText(input.corpId)
  const appKey = normalizeText(input.appKey)
  const appSecret = normalizeText(input.appSecret) || current?.appSecret || ''
  const rootDepartmentId = normalizeText(input.rootDepartmentId) || current?.rootDepartmentId || DEFAULT_ROOT_DEPARTMENT_ID
  const admissionMode = normalizeAdmissionMode(input.admissionMode, current?.admissionMode ?? DEFAULT_ADMISSION_MODE)
  const admissionDepartmentIds = normalizeAdmissionDepartmentIds(input.admissionDepartmentIds, current?.admissionDepartmentIds ?? [])
  const excludeDepartmentIds = normalizeExcludeDepartmentIds(input.excludeDepartmentIds, current?.excludeDepartmentIds ?? [])
  const memberGroupSyncMode = normalizeMemberGroupSyncMode(input.memberGroupSyncMode, current?.memberGroupSyncMode ?? DEFAULT_MEMBER_GROUP_SYNC_MODE)
  const memberGroupDepartmentIds = normalizeMemberGroupDepartmentIds(input.memberGroupDepartmentIds, current?.memberGroupDepartmentIds ?? [])
  const memberGroupDefaultRoleIds = normalizeMemberGroupDefaultRoleIds(input.memberGroupDefaultRoleIds, current?.memberGroupDefaultRoleIds ?? [])
  const memberGroupDefaultNamespaces = normalizeMemberGroupDefaultNamespaces(input.memberGroupDefaultNamespaces, current?.memberGroupDefaultNamespaces ?? [])
  const defaultDeprovisionPolicy = normalizeText(input.defaultDeprovisionPolicy) || 'mark_inactive'
  const status = normalizeText(input.status) || 'active'

  if (!name) throw new Error('Integration name is required')
  if (!corpId) throw new Error('corpId is required')
  if (!appKey) throw new Error('appKey is required')
  if (!appSecret) throw new Error('appSecret is required')
  assertDingTalkCorpAllowed(corpId, { context: 'Directory integration corpId' })

  return {
    ...input,
    name,
    corpId,
    appKey,
    appSecret,
    rootDepartmentId,
    baseUrl: normalizeOptionalText(input.baseUrl) ?? current?.baseUrl,
    pageSize: normalizePageSize(input.pageSize ?? current?.pageSize),
    admissionMode,
    admissionDepartmentIds,
    excludeDepartmentIds,
    memberGroupSyncMode,
    memberGroupDepartmentIds,
    memberGroupDefaultRoleIds,
    memberGroupDefaultNamespaces,
    syncEnabled: input.syncEnabled ?? false,
    scheduleCron: normalizeOptionalText(input.scheduleCron),
    defaultDeprovisionPolicy,
    status,
  }
}

async function getIntegrationRow(integrationId: string): Promise<DirectoryIntegrationRow | null> {
  const result = await query<DirectoryIntegrationRow>(
    `SELECT id, org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron,
            default_deprovision_policy, last_sync_at, last_success_at, last_error, created_at, updated_at
     FROM directory_integrations
     WHERE id = $1 AND provider = $2`,
    [integrationId, DEFAULT_PROVIDER],
  )
  return result.rows[0] ?? null
}

export async function listDirectoryIntegrations(orgId = DEFAULT_ORG_ID): Promise<DirectoryIntegrationSummary[]> {
  const result = await query<DirectoryIntegrationRow>(
    `SELECT i.id, i.org_id, i.provider, i.name, i.status, i.corp_id, i.config, i.sync_enabled, i.schedule_cron,
            i.default_deprovision_policy, i.last_sync_at, i.last_success_at, i.last_error, i.created_at, i.updated_at,
            COALESCE((SELECT COUNT(*)::int FROM directory_departments d WHERE d.integration_id = i.id AND d.is_active = true), 0) AS department_count,
            COALESCE((SELECT COUNT(*)::int FROM directory_accounts a WHERE a.integration_id = i.id AND a.is_active = true), 0) AS account_count,
            COALESCE((
              SELECT COUNT(*)::int
              FROM directory_account_links l
              JOIN directory_accounts a ON a.id = l.directory_account_id
              WHERE a.integration_id = i.id AND l.link_status = 'pending'
            ), 0) AS pending_link_count,
            COALESCE((
              SELECT COUNT(*)::int
              FROM directory_account_links l
              JOIN directory_accounts a ON a.id = l.directory_account_id
              WHERE a.integration_id = i.id AND l.link_status = 'linked'
            ), 0) AS linked_count,
            (
              SELECT r.status
              FROM directory_sync_runs r
              WHERE r.integration_id = i.id
              ORDER BY r.started_at DESC
              LIMIT 1
            ) AS last_run_status
     FROM directory_integrations i
     WHERE i.org_id = $1 AND i.provider = $2
     ORDER BY i.updated_at DESC`,
    [orgId, DEFAULT_PROVIDER],
  )

  return result.rows.map(summarizeIntegration)
}

export async function createDirectoryIntegration(input: DirectoryIntegrationInput): Promise<DirectoryIntegrationSummary> {
  const normalized = normalizeIntegrationInput(input)
  await assertDirectoryProjectedGovernanceConfigValid({
    memberGroupDefaultRoleIds: normalized.memberGroupDefaultRoleIds,
    memberGroupDefaultNamespaces: normalized.memberGroupDefaultNamespaces,
  })
  const result = await query<DirectoryIntegrationRow>(
    `INSERT INTO directory_integrations (
       org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron,
       default_deprovision_policy, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, NOW(), NOW())
     RETURNING id, org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron,
               default_deprovision_policy, last_sync_at, last_success_at, last_error, created_at, updated_at`,
    [
      DEFAULT_ORG_ID,
      DEFAULT_PROVIDER,
      normalized.name,
      normalized.status,
      normalized.corpId,
      JSON.stringify({
        appKey: normalized.appKey,
        appSecret: normalizeStoredSecretValue(normalized.appSecret),
        rootDepartmentId: normalized.rootDepartmentId,
        baseUrl: normalized.baseUrl ?? null,
        pageSize: normalized.pageSize,
        admissionMode: normalized.admissionMode,
        admissionDepartmentIds: normalized.admissionDepartmentIds,
        excludeDepartmentIds: normalized.excludeDepartmentIds,
        memberGroupSyncMode: normalized.memberGroupSyncMode,
        memberGroupDepartmentIds: normalized.memberGroupDepartmentIds,
        memberGroupDefaultRoleIds: normalized.memberGroupDefaultRoleIds,
        memberGroupDefaultNamespaces: normalized.memberGroupDefaultNamespaces,
      }),
      Boolean(normalized.syncEnabled),
      normalized.scheduleCron,
      normalized.defaultDeprovisionPolicy,
    ],
  )

  return summarizeIntegration(result.rows[0])
}

export async function updateDirectoryIntegration(
  integrationId: string,
  input: DirectoryIntegrationInput,
): Promise<DirectoryIntegrationSummary | null> {
  const current = await getIntegrationRow(integrationId)
  if (!current) return null

  const currentConfig = parseIntegrationConfig(current)
  const normalized = normalizeIntegrationInput(input, currentConfig)
  await assertDirectoryProjectedGovernanceConfigValid({
    memberGroupDefaultRoleIds: normalized.memberGroupDefaultRoleIds,
    memberGroupDefaultNamespaces: normalized.memberGroupDefaultNamespaces,
  })
  const result = await query<DirectoryIntegrationRow>(
    `UPDATE directory_integrations
     SET name = $2,
         status = $3,
         corp_id = $4,
         config = $5::jsonb,
         sync_enabled = $6,
         schedule_cron = $7,
         default_deprovision_policy = $8,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron,
               default_deprovision_policy, last_sync_at, last_success_at, last_error, created_at, updated_at`,
    [
      integrationId,
      normalized.name,
      normalized.status,
      normalized.corpId,
      JSON.stringify({
        appKey: normalized.appKey,
        appSecret: normalizeStoredSecretValue(normalized.appSecret),
        rootDepartmentId: normalized.rootDepartmentId,
        baseUrl: normalized.baseUrl ?? null,
        pageSize: normalized.pageSize,
        admissionMode: normalized.admissionMode,
        admissionDepartmentIds: normalized.admissionDepartmentIds,
        excludeDepartmentIds: normalized.excludeDepartmentIds,
        memberGroupSyncMode: normalized.memberGroupSyncMode,
        memberGroupDepartmentIds: normalized.memberGroupDepartmentIds,
        memberGroupDefaultRoleIds: normalized.memberGroupDefaultRoleIds,
        memberGroupDefaultNamespaces: normalized.memberGroupDefaultNamespaces,
      }),
      Boolean(normalized.syncEnabled),
      normalized.scheduleCron,
      normalized.defaultDeprovisionPolicy,
    ],
  )

  return summarizeIntegration(result.rows[0])
}

async function resolveDirectoryTestCurrentConfig(input: DirectoryIntegrationTestInput): Promise<DirectoryIntegrationConfig | undefined> {
  const integrationId = normalizeText(input.integrationId)
  if (!integrationId) return undefined

  const current = await getIntegrationRow(integrationId)
  if (!current) {
    throw new Error('Directory integration not found')
  }

  return parseIntegrationConfig(current)
}

export function buildDirectoryIntegrationTestWarnings(result: {
  rootDepartmentId: string
  departmentSampleCount: number
  rootDepartmentDirectUserCount: number
  rootDepartmentDirectUserHasMore: boolean
  rootDepartmentDirectUserCountWithAccessLimit: number
  rootDepartmentDirectUserHasMoreWithAccessLimit: boolean
}): string[] {
  const warnings: string[] = []
  const hasNoChildDepartments = result.departmentSampleCount === 0
  const hasSuspiciouslySparseRootMembers =
    result.rootDepartmentDirectUserCount <= 1 && !result.rootDepartmentDirectUserHasMore

  if (hasNoChildDepartments) {
    warnings.push(`根部门 ${result.rootDepartmentId} 未返回任何子部门。`)
  }

  if (hasNoChildDepartments && hasSuspiciouslySparseRootMembers) {
    warnings.push(
      `根部门 ${result.rootDepartmentId} 当前仅返回 ${result.rootDepartmentDirectUserCount} 个直属成员；如果钉钉企业通讯录里实际成员更多，通常是应用通讯录接口范围未覆盖，或根部门 ID 配置不正确。`,
    )
  }

  if (
    hasNoChildDepartments
    && hasSuspiciouslySparseRootMembers
    && result.rootDepartmentDirectUserCountWithAccessLimit === result.rootDepartmentDirectUserCount
    && result.rootDepartmentDirectUserHasMoreWithAccessLimit === result.rootDepartmentDirectUserHasMore
  ) {
    warnings.push('开启“包含访问受限成员”后返回结果没有变化，说明当前问题不是受限成员过滤导致的。')
  }

  return warnings
}

export async function testDirectoryIntegration(input: DirectoryIntegrationTestInput): Promise<DirectoryIntegrationTestResult> {
  const current = await resolveDirectoryTestCurrentConfig(input)
  const normalized = normalizeIntegrationInput(input, current)
  const accessToken = await fetchDingTalkAppAccessToken({
    appKey: normalized.appKey,
    appSecret: normalized.appSecret,
    baseUrl: normalized.baseUrl ?? undefined,
  })

  const departments = await listDingTalkDepartments(
    accessToken,
    normalized.rootDepartmentId,
    { baseUrl: normalized.baseUrl ?? undefined },
  )
  const firstDepartmentId = departments[0]?.id ?? normalized.rootDepartmentId
  const { users } = await listDingTalkDepartmentUsers(
    accessToken,
    firstDepartmentId,
    0,
    Math.min(normalized.pageSize ?? DEFAULT_PAGE_SIZE, 5),
    { baseUrl: normalized.baseUrl ?? undefined },
  )
  const rootUsers = await listDingTalkDepartmentUsers(
    accessToken,
    normalized.rootDepartmentId,
    0,
    Math.min(normalized.pageSize ?? DEFAULT_PAGE_SIZE, 100),
    { baseUrl: normalized.baseUrl ?? undefined },
  )
  const rootUsersWithAccessLimit = await listDingTalkDepartmentUsers(
    accessToken,
    normalized.rootDepartmentId,
    0,
    Math.min(normalized.pageSize ?? DEFAULT_PAGE_SIZE, 100),
    {
      baseUrl: normalized.baseUrl ?? undefined,
      containAccessLimit: true,
    },
  )

  const diagnostics = {
    rootDepartmentChildCount: departments.length,
    rootDepartmentDirectUserCount: rootUsers.users.length,
    rootDepartmentDirectUserHasMore: rootUsers.hasMore,
    rootDepartmentDirectUserCountWithAccessLimit: rootUsersWithAccessLimit.users.length,
    rootDepartmentDirectUserHasMoreWithAccessLimit: rootUsersWithAccessLimit.hasMore,
    sampledRootDepartmentUsers: rootUsers.users.slice(0, 10).map((user) => ({ userId: user.userId, name: user.name })),
    sampledRootDepartmentUsersWithAccessLimit: rootUsersWithAccessLimit.users.slice(0, 10).map((user) => ({ userId: user.userId, name: user.name })),
  }

  return {
    corpId: normalized.corpId,
    rootDepartmentId: normalized.rootDepartmentId,
    appKey: normalized.appKey,
    departmentSampleCount: departments.length,
    sampledDepartments: departments.slice(0, 5).map((department) => ({ id: department.id, name: department.name })),
    userSampleCount: users.length,
    sampledUsers: users.slice(0, 5).map((user) => ({ userId: user.userId, name: user.name })),
    diagnostics,
    warnings: buildDirectoryIntegrationTestWarnings({
      rootDepartmentId: normalized.rootDepartmentId,
      departmentSampleCount: departments.length,
      rootDepartmentDirectUserCount: diagnostics.rootDepartmentDirectUserCount,
      rootDepartmentDirectUserHasMore: diagnostics.rootDepartmentDirectUserHasMore,
      rootDepartmentDirectUserCountWithAccessLimit: diagnostics.rootDepartmentDirectUserCountWithAccessLimit,
      rootDepartmentDirectUserHasMoreWithAccessLimit: diagnostics.rootDepartmentDirectUserHasMoreWithAccessLimit,
    }),
  }
}

async function fetchAllDepartments(config: DirectoryIntegrationConfig, integrationName: string): Promise<Map<string, DingTalkDepartment>> {
  const accessToken = await fetchDingTalkAppAccessToken({
    appKey: config.appKey,
    appSecret: config.appSecret,
    baseUrl: config.baseUrl,
  })
  const departments = new Map<string, DingTalkDepartment>()
  departments.set(config.rootDepartmentId, {
    id: config.rootDepartmentId,
    parentId: null,
    name: integrationName,
    order: 0,
    source: { syntheticRoot: true },
  })

  const queue = [config.rootDepartmentId]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    const children = await listDingTalkDepartments(accessToken, current, { baseUrl: config.baseUrl })
    for (const child of children) {
      const existing = departments.get(child.id)
      departments.set(child.id, existing ? { ...existing, ...child } : child)
      if (!existing) queue.push(child.id)
    }
  }

  return departments
}

function mergeDepartmentIds(primary: string[], secondary: string[]): string[] {
  return Array.from(new Set([...primary, ...secondary].filter(Boolean)))
}

async function fetchAllUsers(
  config: DirectoryIntegrationConfig,
  departmentMap: Map<string, DingTalkDepartment>,
): Promise<Map<string, DingTalkDirectoryUser>> {
  const accessToken = await fetchDingTalkAppAccessToken({
    appKey: config.appKey,
    appSecret: config.appSecret,
    baseUrl: config.baseUrl,
  })
  const users = new Map<string, DingTalkDirectoryUser>()
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE

  for (const departmentId of departmentMap.keys()) {
    let cursor = 0
    let hasMore = true
    while (hasMore) {
      const response = await listDingTalkDepartmentUsers(
        accessToken,
        departmentId,
        cursor,
        pageSize,
        { baseUrl: config.baseUrl },
      )
      for (const summary of response.users) {
        const existing = users.get(summary.userId)
        if (!existing) {
          const detail = await getDingTalkUserDetail(accessToken, summary.userId, { baseUrl: config.baseUrl })
          users.set(summary.userId, {
            ...detail,
            departmentIds: mergeDepartmentIds(detail.departmentIds, summary.departmentIds),
          })
          continue
        }
        users.set(summary.userId, {
          ...existing,
          departmentIds: mergeDepartmentIds(existing.departmentIds, summary.departmentIds),
        })
      }
      if (!response.hasMore || response.nextCursor === null) {
        hasMore = false
      } else {
        cursor = response.nextCursor
      }
    }
  }

  return users
}

function buildDepartmentPathMap(departments: Map<string, DingTalkDepartment>): Map<string, string> {
  const cache = new Map<string, string>()

  const walk = (departmentId: string): string => {
    if (cache.has(departmentId)) return cache.get(departmentId) ?? ''
    const department = departments.get(departmentId)
    if (!department) return ''
    if (!department.parentId || !departments.has(department.parentId)) {
      cache.set(departmentId, department.name)
      return department.name
    }
    const parentPath = walk(department.parentId)
    const fullPath = parentPath ? `${parentPath} / ${department.name}` : department.name
    cache.set(departmentId, fullPath)
    return fullPath
  }

  for (const departmentId of departments.keys()) {
    walk(departmentId)
  }

  return cache
}

async function markSyncFailure(integrationId: string, runId: string, message: string): Promise<void> {
  await query(
    `UPDATE directory_integrations
     SET last_sync_at = NOW(),
         last_error = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [integrationId, message],
  )
  await query(
    `UPDATE directory_sync_runs
     SET status = 'failed',
         finished_at = NOW(),
         error_message = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [runId, message],
  )
  try {
    await query(
      `INSERT INTO directory_sync_alerts (integration_id, run_id, level, code, message, details, created_at, updated_at)
       VALUES ($1, $2, 'error', 'sync_failed', $3, '{}'::jsonb, NOW(), NOW())`,
      [integrationId, runId, message],
    )
  } catch (error) {
    logger.warn(`Failed to persist directory alert: ${readErrorMessage(error, 'unknown error')}`)
  }
}

async function loadMatchMaps(accounts: DirectoryAccountRow[]) {
  const externalKeys = Array.from(new Set(accounts.map((account) => account.external_key).filter(Boolean)))
  const unionIds = Array.from(new Set(
    accounts
      .map((account) => normalizeText(account.union_id))
      .filter(Boolean),
  ))
  const openIds = Array.from(new Set(
    accounts
      .map((account) => normalizeText(account.open_id))
      .filter(Boolean),
  ))
  const emails = Array.from(new Set(
    accounts
      .map((account) => normalizeText(account.email).toLowerCase())
      .filter(Boolean),
  ))
  const mobiles = Array.from(new Set(
    accounts
      .map((account) => normalizeText(account.mobile))
      .filter(Boolean),
  ))

  const [externalIdentities, emailUsers, mobileUsers] = await Promise.all([
    externalKeys.length > 0 || unionIds.length > 0 || openIds.length > 0
      ? query<ExternalIdentityRow>(
        `SELECT external_key, provider_union_id, provider_open_id, corp_id, local_user_id
         FROM user_external_identities
         WHERE provider = $1
           AND (
             external_key = ANY($2::text[])
             OR provider_union_id = ANY($3::text[])
             OR provider_open_id = ANY($4::text[])
           )`,
        [DEFAULT_PROVIDER, externalKeys, unionIds, openIds],
      )
      : Promise.resolve({ rows: [] } as Awaited<ReturnType<typeof query<ExternalIdentityRow>>>),
    emails.length > 0
      ? query<LocalUserRow>(
        `SELECT id, email
         FROM users
         WHERE lower(email) = ANY($1::text[])`,
        [emails],
      )
      : Promise.resolve({ rows: [] } as Awaited<ReturnType<typeof query<LocalUserRow>>>),
    mobiles.length > 0
      ? query<LocalUserRow>(
        `SELECT id, mobile
         FROM users
         WHERE mobile = ANY($1::text[])`,
        [mobiles],
      )
      : Promise.resolve({ rows: [] } as Awaited<ReturnType<typeof query<LocalUserRow>>>),
  ])

  const scopedUnionIdentityMap = new Map<string, string>()
  const scopedOpenIdentityMap = new Map<string, string>()
  for (const row of externalIdentities.rows) {
    const unionKey = buildScopedIdentityKey(row.corp_id, row.provider_union_id)
    if (unionKey) scopedUnionIdentityMap.set(unionKey, row.local_user_id)
    const openKey = buildScopedIdentityKey(row.corp_id, row.provider_open_id)
    if (openKey) scopedOpenIdentityMap.set(openKey, row.local_user_id)
  }

  return {
    externalIdentityMap: new Map(externalIdentities.rows.map((row) => [row.external_key, row.local_user_id])),
    scopedUnionIdentityMap,
    scopedOpenIdentityMap,
    emailMap: new Map(
      emailUsers.rows
        .map((row) => [normalizeText(row.email).toLowerCase(), row.id] as const)
        .filter(([email]) => email.length > 0),
    ),
    mobileMap: new Map(
      mobileUsers.rows
        .map((row) => [normalizeText(row.mobile), row.id] as const)
        .filter(([mobile]) => mobile.length > 0),
    ),
  }
}

export async function syncDirectoryIntegration(
  integrationId: string,
  triggeredBy: string,
  triggerSource: 'manual' | 'scheduler' = 'manual',
): Promise<{ integration: DirectoryIntegrationSummary; run: DirectorySyncRunSummary }> {
  const governedUserIds = new Set<string>()
  const integration = await getIntegrationRow(integrationId)
  if (!integration) throw new Error('Directory integration not found')

  const config = parseIntegrationConfig(integration)
  const runResult = await query<DirectoryRunRow>(
    `INSERT INTO directory_sync_runs (
       integration_id, status, started_at, stats, meta, triggered_by, trigger_source, created_at, updated_at
     )
     VALUES ($1, 'running', NOW(), '{}'::jsonb, '{}'::jsonb, $2, $3, NOW(), NOW())
     RETURNING id, integration_id, status, started_at, finished_at, stats, error_message, triggered_by, trigger_source, created_at, updated_at`,
    [integrationId, triggeredBy, triggerSource],
  )
  const runId = runResult.rows[0].id

  try {
    const departments = await fetchAllDepartments(config, integration.name)
    const departmentPathMap = buildDepartmentPathMap(departments)
    const users = await fetchAllUsers(config, departments)
    const syncTimestamp = new Date().toISOString()
    const autoAdmissionInvites: Array<{ userId: string; email: string; inviteToken: string }> = []

    await transaction(async (client) => {
      for (const department of departments.values()) {
        await client.query(
          `INSERT INTO directory_departments (
             integration_id, provider, external_department_id, external_parent_department_id, name,
             full_path, order_index, is_active, raw, last_seen_at, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb, $9, NOW(), NOW())
           ON CONFLICT (integration_id, external_department_id)
           DO UPDATE SET
             external_parent_department_id = EXCLUDED.external_parent_department_id,
             name = EXCLUDED.name,
             full_path = EXCLUDED.full_path,
             order_index = EXCLUDED.order_index,
             is_active = true,
             raw = EXCLUDED.raw,
             last_seen_at = EXCLUDED.last_seen_at,
             updated_at = NOW()`,
          [
            integrationId,
            DEFAULT_PROVIDER,
            department.id,
            department.parentId,
            department.name,
            departmentPathMap.get(department.id) ?? department.name,
            department.order,
            JSON.stringify(department.source),
            syncTimestamp,
          ],
        )
      }

      const userList = Array.from(users.values())
      for (const user of userList) {
        const externalKey = normalizeText(user.unionId || user.openId || user.userId)
        await client.query(
          `INSERT INTO directory_accounts (
             integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key,
             name, nick, email, mobile, job_number, title, avatar_url, is_active, raw, last_seen_at, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, $15::jsonb, $16, NOW(), NOW())
           ON CONFLICT (integration_id, external_user_id)
           DO UPDATE SET
             union_id = EXCLUDED.union_id,
             open_id = EXCLUDED.open_id,
             external_key = EXCLUDED.external_key,
             name = EXCLUDED.name,
             nick = EXCLUDED.nick,
             email = EXCLUDED.email,
             mobile = EXCLUDED.mobile,
             job_number = EXCLUDED.job_number,
             title = EXCLUDED.title,
             avatar_url = EXCLUDED.avatar_url,
             is_active = true,
             raw = EXCLUDED.raw,
             last_seen_at = EXCLUDED.last_seen_at,
             updated_at = NOW()`,
          [
            integrationId,
            DEFAULT_PROVIDER,
            integration.corp_id,
            user.userId,
            normalizeOptionalText(user.unionId),
            normalizeOptionalText(user.openId),
            externalKey,
            user.name,
            normalizeOptionalText(user.nick),
            normalizeOptionalText(user.email),
            normalizeOptionalText(user.mobile),
            normalizeOptionalText(user.jobNumber),
            normalizeOptionalText(user.title),
            normalizeOptionalText(user.avatarUrl),
            JSON.stringify(user.source),
            syncTimestamp,
          ],
        )
      }

      await client.query(
        `UPDATE directory_departments
         SET is_active = false, updated_at = NOW()
         WHERE integration_id = $1 AND last_seen_at < $2`,
        [integrationId, syncTimestamp],
      )
      await client.query(
        `UPDATE directory_accounts
         SET is_active = false, updated_at = NOW()
         WHERE integration_id = $1 AND last_seen_at < $2`,
        [integrationId, syncTimestamp],
      )

      const [departmentRows, accountRows] = await Promise.all([
        client.query(
          `SELECT id, external_department_id, name, full_path
           FROM directory_departments
           WHERE integration_id = $1`,
          [integrationId],
        ),
        client.query(
          `SELECT id, corp_id, external_user_id, union_id, open_id, external_key, name, email, mobile
           FROM directory_accounts
           WHERE integration_id = $1`,
          [integrationId],
        ),
      ])

      const departmentIdMap = new Map<string, string>()
      for (const row of departmentRows.rows as DirectoryDepartmentRow[]) {
        departmentIdMap.set(row.external_department_id, row.id)
      }

      const accountIdMap = new Map<string, DirectoryAccountRow>()
      for (const row of accountRows.rows as DirectoryAccountRow[]) {
        accountIdMap.set(row.external_user_id, row)
      }

      await client.query(
        `DELETE FROM directory_account_departments
         WHERE directory_account_id IN (
           SELECT id FROM directory_accounts WHERE integration_id = $1
         )`,
        [integrationId],
      )

      for (const user of users.values()) {
        const account = accountIdMap.get(user.userId)
        if (!account) continue
        for (const departmentId of user.departmentIds) {
          const directoryDepartmentId = departmentIdMap.get(departmentId)
          if (!directoryDepartmentId) continue
          await client.query(
            `INSERT INTO directory_account_departments (
               directory_account_id, directory_department_id, is_primary, created_at
             )
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (directory_account_id, directory_department_id)
             DO UPDATE SET is_primary = EXCLUDED.is_primary`,
            [account.id, directoryDepartmentId, departmentId === user.departmentIds[0]],
          )
        }
      }

      const { externalIdentityMap, scopedUnionIdentityMap, scopedOpenIdentityMap, emailMap, mobileMap } = await loadMatchMaps(
        Array.from(accountIdMap.values()),
      )

      const existingLinksResult = await client.query(
        `SELECT directory_account_id, local_user_id, link_status, match_strategy
         FROM directory_account_links
         WHERE directory_account_id = ANY($1::uuid[])`,
        [Array.from(accountIdMap.values()).map((account) => account.id)],
      )
      const existingLinks = new Map(
        (existingLinksResult.rows as DirectoryAccountLinkRow[]).map((row) => [row.directory_account_id, row]),
      )

      let linkedCount = 0
      let pendingCount = 0
      let unmatchedCount = 0
      let autoAdmissionCandidateCount = 0
      let autoAdmittedCount = 0
      let autoAdmissionSkippedMissingEmailCount = 0
      let autoAdmissionExcludedCount = 0
      let autoAdmissionFailedCount = 0
      const linkedUserIdByExternalUserId = new Map<string, string>()
      for (const account of accountIdMap.values()) {
        const directoryUser = users.get(account.external_user_id)
        const existing = existingLinks.get(account.id)
        let localUserId: string | null = existing?.local_user_id ?? null
        let linkStatus = existing?.link_status ?? 'pending'
        let matchStrategy = existing?.match_strategy ?? null

        if (!(existing && existing.link_status === 'linked' && existing.local_user_id)) {
          const scopedOpenIdentityKey = buildScopedIdentityKey(account.corp_id, account.open_id)
          const scopedUnionIdentityKey = buildScopedIdentityKey(account.corp_id, account.union_id)
          const externalIdentityUserId = externalIdentityMap.get(account.external_key)
            || (scopedOpenIdentityKey ? scopedOpenIdentityMap.get(scopedOpenIdentityKey) : undefined)
            || (scopedUnionIdentityKey ? scopedUnionIdentityMap.get(scopedUnionIdentityKey) : undefined)
          if (externalIdentityUserId) {
            localUserId = externalIdentityUserId
            linkStatus = 'linked'
            matchStrategy = 'external_identity'
          } else {
            const emailUserId = normalizeText(account.email).toLowerCase() ? emailMap.get(normalizeText(account.email).toLowerCase()) : undefined
            const mobileUserId = normalizeText(account.mobile) ? mobileMap.get(normalizeText(account.mobile)) : undefined
            if (emailUserId) {
              localUserId = emailUserId
              linkStatus = 'pending'
              matchStrategy = 'email'
            } else if (mobileUserId) {
              localUserId = mobileUserId
              linkStatus = 'pending'
              matchStrategy = 'mobile'
            } else {
              const autoAdmission = evaluateDirectoryAutoAdmissionEligibility({
                admissionMode: config.admissionMode,
                admissionDepartmentIds: config.admissionDepartmentIds,
                excludeDepartmentIds: config.excludeDepartmentIds,
                userDepartmentIds: directoryUser?.departmentIds ?? [],
                departments,
                email: account.email,
              })
              if (autoAdmission.inScope) autoAdmissionCandidateCount += 1
              if (autoAdmission.excluded) autoAdmissionExcludedCount += 1

              if (autoAdmission.inScope && !autoAdmission.missingEmail && directoryUser) {
                try {
                  const cleanName = sanitizeDirectoryAdmissionName(account.name)
                  const cleanEmail = sanitizeDirectoryAdmissionEmail(account.email ?? '')
                  const cleanMobile = sanitizeDirectoryAdmissionMobile(account.mobile)
                  const generatedPassword = generateDirectoryAdmissionTemporaryPassword()
                  const passwordHash = await bcrypt.hash(generatedPassword, getBcryptSaltRounds())
                  const created = await createDirectoryAdmittedUserInTransaction(client, {
                    account: {
                      id: account.id,
                      integration_id: integrationId,
                      provider: DEFAULT_PROVIDER,
                      corp_id: account.corp_id,
                      external_user_id: account.external_user_id,
                      union_id: account.union_id,
                      open_id: account.open_id,
                      external_key: account.external_key,
                      name: account.name,
                      email: account.email,
                      mobile: account.mobile,
                    },
                    adminUserId: triggeredBy,
                    name: cleanName,
                    email: cleanEmail,
                    username: null,
                    mobile: cleanMobile,
                    passwordHash,
                    mustChangePassword: true,
                    enableDingTalkGrant: true,
                  })
                  const inviteToken = issueInviteToken({
                    userId: created.userId,
                    email: cleanEmail,
                    presetId: null,
                  })
                  autoAdmissionInvites.push({
                    userId: created.userId,
                    email: cleanEmail,
                    inviteToken,
                  })
                  localUserId = created.userId
                  linkStatus = 'linked'
                  matchStrategy = 'auto_admit'
                  autoAdmittedCount += 1
                  emailMap.set(cleanEmail.toLowerCase(), created.userId)
                  if (cleanMobile) mobileMap.set(cleanMobile, created.userId)
                  externalIdentityMap.set(account.external_key, created.userId)
                  const scopedOpenIdentityKey = buildScopedIdentityKey(account.corp_id, account.open_id)
                  if (scopedOpenIdentityKey) scopedOpenIdentityMap.set(scopedOpenIdentityKey, created.userId)
                  const scopedUnionIdentityKey = buildScopedIdentityKey(account.corp_id, account.union_id)
                  if (scopedUnionIdentityKey) scopedUnionIdentityMap.set(scopedUnionIdentityKey, created.userId)
                } catch (error) {
                  autoAdmissionFailedCount += 1
                  logger.warn(`Failed to auto-admit DingTalk directory account ${account.id}: ${readErrorMessage(error, 'unknown error')}`)
                  localUserId = null
                  linkStatus = 'unmatched'
                  matchStrategy = 'none'
                }
              } else {
                if (autoAdmission.missingEmail) autoAdmissionSkippedMissingEmailCount += 1
                localUserId = null
                linkStatus = 'unmatched'
                matchStrategy = 'none'
              }
            }
          }
        }

        if (linkStatus === 'linked') linkedCount += 1
        else if (linkStatus === 'pending') pendingCount += 1
        else unmatchedCount += 1

        if (linkStatus === 'linked' && localUserId && directoryUser) {
          linkedUserIdByExternalUserId.set(account.external_user_id, localUserId)
        }

        await client.query(
          `INSERT INTO directory_account_links (
             directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (directory_account_id)
           DO UPDATE SET
             local_user_id = EXCLUDED.local_user_id,
             link_status = EXCLUDED.link_status,
             match_strategy = EXCLUDED.match_strategy,
             updated_at = NOW()`,
          [account.id, localUserId, linkStatus, matchStrategy],
        )
      }

      const memberGroupPlans = buildDirectoryProjectedMemberGroupPlans({
        integrationId,
        integrationName: integration.name,
        memberGroupSyncMode: config.memberGroupSyncMode,
        memberGroupDepartmentIds: config.memberGroupDepartmentIds,
        departments,
        departmentPathMap,
        userDepartmentIdsByExternalUserId: new Map(
          Array.from(users.values()).map((user) => [user.userId, user.departmentIds]),
        ),
        linkedUserIdByExternalUserId,
      })
      const memberGroupProjection = await syncProjectedDepartmentMemberGroupsInTransaction(
        client,
        memberGroupPlans,
        {
          defaultRoleIds: config.memberGroupDefaultRoleIds,
          defaultNamespaces: config.memberGroupDefaultNamespaces,
        },
        triggeredBy,
      )
      for (const userId of memberGroupProjection.governedUserIds) {
        const normalizedUserId = normalizeText(userId)
        if (normalizedUserId) governedUserIds.add(normalizedUserId)
      }

      const stats = {
        departmentsSynced: departments.size,
        accountsSynced: users.size,
        linkedCount,
        pendingCount,
        unmatchedCount,
        autoAdmissionCandidateCount,
        autoAdmittedCount,
        autoAdmissionSkippedMissingEmailCount,
        autoAdmissionExcludedCount,
        autoAdmissionFailedCount,
        memberGroupsCreatedCount: memberGroupProjection.memberGroupsCreatedCount,
        memberGroupsSyncedCount: memberGroupProjection.memberGroupsSyncedCount,
        memberGroupMembershipsUpdatedCount: memberGroupProjection.memberGroupMembershipsUpdatedCount,
        memberGroupGovernedUserCount: memberGroupProjection.memberGroupGovernedUserCount,
        memberGroupDefaultRoleAssignmentsCount: memberGroupProjection.memberGroupDefaultRoleAssignmentsCount,
        memberGroupDefaultNamespaceAdmissionsCount: memberGroupProjection.memberGroupDefaultNamespaceAdmissionsCount,
      }

      await client.query(
        `UPDATE directory_integrations
         SET last_sync_at = NOW(),
             last_success_at = NOW(),
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [integrationId],
      )
      await client.query(
        `UPDATE directory_sync_runs
         SET status = 'completed',
             finished_at = NOW(),
             stats = $2::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [runId, JSON.stringify(stats)],
      )
    })

    for (const invite of autoAdmissionInvites) {
      await recordInvite({
        userId: invite.userId,
        email: invite.email,
        presetId: null,
        productMode: 'platform',
        roleId: null,
        invitedBy: triggeredBy,
        inviteToken: invite.inviteToken,
      })
    }

    for (const userId of governedUserIds) {
      invalidateUserPerms(userId)
    }

    const [updatedIntegration, updatedRun] = await Promise.all([
      getIntegrationRow(integrationId),
      query<DirectoryRunRow>(
        `SELECT id, integration_id, status, started_at, finished_at, stats, error_message, triggered_by, trigger_source, created_at, updated_at
         FROM directory_sync_runs
         WHERE id = $1`,
        [runId],
      ),
    ])

    if (!updatedIntegration || !updatedRun.rows[0]) {
      throw new Error('Directory sync completed but summary reload failed')
    }

    return {
      integration: summarizeIntegration(updatedIntegration),
      run: summarizeRun(updatedRun.rows[0]),
    }
  } catch (error) {
    const message = readErrorMessage(error, 'Directory sync failed')
    await markSyncFailure(integrationId, runId, message)
    throw error
  }
}

export async function listDirectorySyncRuns(
  integrationId: string,
  pagination: { limit: number; offset: number },
): Promise<{ items: DirectorySyncRunSummary[]; total: number }> {
  const [totalResult, rowsResult] = await Promise.all([
    query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM directory_sync_runs
       WHERE integration_id = $1`,
      [integrationId],
    ),
    query<DirectoryRunRow>(
      `SELECT id, integration_id, status, started_at, finished_at, stats, error_message, triggered_by, trigger_source, created_at, updated_at
       FROM directory_sync_runs
       WHERE integration_id = $1
       ORDER BY started_at DESC
       LIMIT $2 OFFSET $3`,
      [integrationId, pagination.limit, pagination.offset],
    ),
  ])

  return {
    items: rowsResult.rows.map(summarizeRun),
    total: Number(totalResult.rows[0]?.total ?? 0),
  }
}

export async function listDirectorySyncAlerts(
  integrationId: string,
  pagination: { limit: number; offset: number },
  filter: DirectorySyncAlertFilter = 'all',
): Promise<{
  items: DirectorySyncAlertSummary[]
  total: number
  counts: {
    total: number
    pending: number
    acknowledged: number
  }
}> {
  const normalizedIntegrationId = normalizeText(integrationId)
  if (!normalizedIntegrationId) throw new Error('integrationId is required')

  const normalizedFilter: DirectorySyncAlertFilter = filter === 'pending' || filter === 'acknowledged' ? filter : 'all'
  const whereClauses: string[] = ['integration_id = $1']
  const params: unknown[] = [normalizedIntegrationId]
  if (normalizedFilter === 'pending') whereClauses.push('acknowledged_at IS NULL')
  if (normalizedFilter === 'acknowledged') whereClauses.push('acknowledged_at IS NOT NULL')

  const whereSql = whereClauses.join(' AND ')
  const [countResult, countsResult, rowsResult] = await Promise.all([
    query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM directory_sync_alerts
       WHERE ${whereSql}`,
      params,
    ),
    query<{
      total_count: number
      pending_count: number
      acknowledged_count: number
    }>(
      `SELECT
         COUNT(*)::int AS total_count,
         COUNT(*) FILTER (WHERE acknowledged_at IS NULL)::int AS pending_count,
         COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acknowledged_count
       FROM directory_sync_alerts
       WHERE integration_id = $1`,
      [normalizedIntegrationId],
    ),
    query<DirectorySyncAlertRow>(
      `SELECT
          id,
          integration_id,
          run_id,
          level,
          code,
          message,
          details,
          sent_to_webhook,
          acknowledged_at,
          acknowledged_by,
          created_at,
          updated_at
       FROM directory_sync_alerts
       WHERE ${whereSql}
       ORDER BY acknowledged_at IS NULL DESC, created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pagination.limit, pagination.offset],
    ),
  ])

  const countsRow = countsResult.rows[0]
  return {
    items: rowsResult.rows.map(summarizeAlert),
    total: Number(countResult.rows[0]?.total ?? 0),
    counts: {
      total: Number(countsRow?.total_count ?? 0),
      pending: Number(countsRow?.pending_count ?? 0),
      acknowledged: Number(countsRow?.acknowledged_count ?? 0),
    },
  }
}

export async function acknowledgeDirectorySyncAlert(
  alertId: string,
  acknowledgedBy: string,
): Promise<DirectorySyncAlertSummary | null> {
  const normalizedAlertId = normalizeText(alertId)
  const normalizedAcknowledgedBy = normalizeText(acknowledgedBy)
  if (!normalizedAlertId) throw new Error('alertId is required')
  if (!normalizedAcknowledgedBy) throw new Error('acknowledgedBy is required')

  const result = await query<DirectorySyncAlertRow>(
    `UPDATE directory_sync_alerts
     SET acknowledged_at = COALESCE(acknowledged_at, NOW()),
         acknowledged_by = COALESCE(acknowledged_by, $2),
         updated_at = NOW()
     WHERE id = $1
     RETURNING
       id,
       integration_id,
       run_id,
       level,
       code,
       message,
       details,
       sent_to_webhook,
       acknowledged_at,
       acknowledged_by,
       created_at,
       updated_at`,
    [normalizedAlertId, normalizedAcknowledgedBy],
  )

  const row = result.rows[0]
  return row ? summarizeAlert(row) : null
}

function readScheduleObservation(
  integration: DirectoryIntegrationRow,
  lastManualRun: DirectoryRunRow | null,
  lastAutomaticRun: DirectoryRunRow | null,
): Pick<DirectorySyncScheduleSnapshot, 'cronValid' | 'nextExpectedRunAt' | 'observationStatus' | 'observationMessage'> {
  if (!integration.sync_enabled) {
    return {
      cronValid: normalizeText(integration.schedule_cron).length > 0,
      nextExpectedRunAt: null,
      observationStatus: 'disabled',
      observationMessage: '自动同步未启用。',
    }
  }

  const cronExpression = normalizeText(integration.schedule_cron)
  if (!cronExpression) {
    return {
      cronValid: false,
      nextExpectedRunAt: null,
      observationStatus: 'missing_cron',
      observationMessage: '已启用自动同步，但尚未配置 cron 表达式。',
    }
  }

  try {
    const parser = new SimpleCronExpression(cronExpression, 'UTC')
    const nextRun = parser.next()
    if (lastAutomaticRun) {
      return {
        cronValid: true,
        nextExpectedRunAt: nextRun?.toISOString() ?? null,
        observationStatus: 'auto_observed',
        observationMessage: `已观察到自动触发记录（${lastAutomaticRun.trigger_source}）。`,
      }
    }

    if (lastManualRun) {
      return {
        cronValid: true,
        nextExpectedRunAt: nextRun?.toISOString() ?? null,
        observationStatus: 'manual_only',
        observationMessage: '当前只观察到 manual 触发记录；尚未看到自动执行。',
      }
    }

    return {
      cronValid: true,
      nextExpectedRunAt: nextRun?.toISOString() ?? null,
      observationStatus: 'configured_no_runs',
      observationMessage: '已保存自动同步配置，但尚未看到任何执行记录。',
    }
  } catch {
    return {
      cronValid: false,
      nextExpectedRunAt: null,
      observationStatus: 'invalid_cron',
      observationMessage: 'cron 表达式无效，当前无法推算下次自动同步时间。',
    }
  }
}

export async function getDirectorySyncScheduleSnapshot(
  integrationId: string,
): Promise<DirectorySyncScheduleSnapshot | null> {
  const normalizedIntegrationId = normalizeText(integrationId)
  if (!normalizedIntegrationId) throw new Error('integrationId is required')

  const integration = await getIntegrationRow(normalizedIntegrationId)
  if (!integration) return null

  const [lastRunResult, lastManualRunResult, lastAutomaticRunResult] = await Promise.all([
    query<DirectoryRunRow>(
      `SELECT id, integration_id, status, started_at, finished_at, stats, error_message, triggered_by, trigger_source, created_at, updated_at
       FROM directory_sync_runs
       WHERE integration_id = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [normalizedIntegrationId],
    ),
    query<DirectoryRunRow>(
      `SELECT id, integration_id, status, started_at, finished_at, stats, error_message, triggered_by, trigger_source, created_at, updated_at
       FROM directory_sync_runs
       WHERE integration_id = $1 AND trigger_source = 'manual'
       ORDER BY started_at DESC
       LIMIT 1`,
      [normalizedIntegrationId],
    ),
    query<DirectoryRunRow>(
      `SELECT id, integration_id, status, started_at, finished_at, stats, error_message, triggered_by, trigger_source, created_at, updated_at
       FROM directory_sync_runs
       WHERE integration_id = $1 AND trigger_source = 'scheduler'
       ORDER BY started_at DESC
       LIMIT 1`,
      [normalizedIntegrationId],
    ),
  ])

  const lastRun = lastRunResult.rows[0] ?? null
  const lastManualRun = lastManualRunResult.rows[0] ?? null
  const lastAutomaticRun = lastAutomaticRunResult.rows[0] ?? null
  const observation = readScheduleObservation(integration, lastManualRun, lastAutomaticRun)

  return {
    integrationId: normalizedIntegrationId,
    syncEnabled: Boolean(integration.sync_enabled),
    scheduleCron: integration.schedule_cron,
    cronValid: observation.cronValid,
    nextExpectedRunAt: observation.nextExpectedRunAt,
    lastRun: lastRun ? summarizeRun(lastRun) : null,
    lastManualRun: lastManualRun ? summarizeRun(lastManualRun) : null,
    lastAutomaticRun: lastAutomaticRun ? summarizeRun(lastAutomaticRun) : null,
    observationStatus: observation.observationStatus,
    observationMessage: observation.observationMessage,
  }
}

function buildReviewFilterSql(filter: DirectoryReviewItemFilter): string {
  if (filter === 'inactive_linked') {
    return '(a.is_active = FALSE AND l.local_user_id IS NOT NULL)'
  }
  if (filter === 'missing_identifier') {
    return "(COALESCE(a.union_id, '') = '' AND COALESCE(a.open_id, '') = '')"
  }
  if (filter === 'pending_binding') {
    return "(l.local_user_id IS NULL OR COALESCE(l.link_status, 'pending') <> 'linked')"
  }
  return `(
    (COALESCE(a.union_id, '') = '' AND COALESCE(a.open_id, '') = '')
    OR (a.is_active = FALSE AND l.local_user_id IS NOT NULL)
    OR (l.local_user_id IS NULL OR COALESCE(l.link_status, 'pending') <> 'linked')
  )`
}

export async function listDirectoryReviewItems(
  integrationId: string,
  pagination: { limit: number; offset: number },
  filter: DirectoryReviewItemFilter = 'all',
): Promise<{ items: DirectoryReviewItemSummary[]; total: number }> {
  const normalizedIntegrationId = normalizeText(integrationId)
  if (!normalizedIntegrationId) throw new Error('integrationId is required')

  const normalizedFilter: DirectoryReviewItemFilter = filter === 'pending_binding' || filter === 'inactive_linked' || filter === 'missing_identifier'
    ? filter
    : 'all'
  const filterSql = buildReviewFilterSql(normalizedFilter)

  const [countResult, rowsResult] = await Promise.all([
    query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM directory_accounts a
       LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
       WHERE a.integration_id = $1 AND ${filterSql}`,
      [normalizedIntegrationId],
    ),
    query<DirectoryReviewItemRow>(
      `SELECT
          a.integration_id,
          a.provider,
          a.corp_id,
          a.id AS directory_account_id,
          a.external_user_id,
          a.union_id,
          a.open_id,
          a.external_key,
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
          u.id AS local_user_id,
          u.email AS local_user_email,
          u.username AS local_user_username,
          u.name AS local_user_name,
          COALESCE(array_remove(array_agg(DISTINCT d.full_path), NULL), ARRAY[]::text[]) AS department_paths,
          CASE
            WHEN COALESCE(a.union_id, '') = '' AND COALESCE(a.open_id, '') = '' THEN 'missing_identifier'
            WHEN a.is_active = FALSE AND u.id IS NOT NULL THEN 'inactive_linked'
            ELSE 'pending_binding'
          END AS review_kind,
          CASE
            WHEN COALESCE(a.union_id, '') = '' AND COALESCE(a.open_id, '') = '' THEN '目录成员缺少 unionId/openId，无法用于钉钉登录绑定。'
            WHEN a.is_active = FALSE AND u.id IS NOT NULL THEN '目录成员已停用，但仍绑定本地用户，需要停权处理。'
            WHEN u.id IS NULL THEN '目录成员尚未绑定本地用户。'
            ELSE '目录成员当前不是已确认绑定状态，建议复核。'
          END AS review_reason,
          (COALESCE(a.union_id, '') = '') AS missing_union_id,
          (COALESCE(a.open_id, '') = '') AS missing_open_id
       FROM directory_accounts a
       LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
       LEFT JOIN users u ON u.id = l.local_user_id
       LEFT JOIN directory_account_departments ad ON ad.directory_account_id = a.id
       LEFT JOIN directory_departments d ON d.id = ad.directory_department_id
       WHERE a.integration_id = $1 AND ${filterSql}
       GROUP BY
         a.integration_id, a.provider, a.corp_id, a.id, a.external_user_id, a.union_id, a.open_id, a.external_key,
         a.name, a.email, a.mobile, a.is_active, a.updated_at,
         l.link_status, l.match_strategy, l.reviewed_by, l.review_note, l.updated_at,
         u.id, u.email, u.username, u.name
       ORDER BY
         CASE
           WHEN COALESCE(a.union_id, '') = '' AND COALESCE(a.open_id, '') = '' THEN 0
           WHEN a.is_active = FALSE AND u.id IS NOT NULL THEN 1
           ELSE 2
         END,
         a.name ASC,
         a.external_user_id ASC
       LIMIT $2 OFFSET $3`,
      [normalizedIntegrationId, pagination.limit, pagination.offset],
    ),
  ])

  const recommendationsByAccount = await loadDirectoryReviewRecommendations(rowsResult.rows)

  return {
    items: rowsResult.rows.map((row) => summarizeReviewItem(
      row,
      recommendationsByAccount.get(row.directory_account_id) ?? null,
    )),
    total: Number(countResult.rows[0]?.total ?? 0),
  }
}

export async function getDirectoryReviewItem(
  accountId: string,
): Promise<DirectoryReviewItemSummary | null> {
  const normalizedAccountId = normalizeText(accountId)
  if (!normalizedAccountId) throw new Error('accountId is required')

  const rowsResult = await query<DirectoryReviewItemRow>(
    `SELECT
        a.integration_id,
        a.provider,
        a.corp_id,
        a.id AS directory_account_id,
        a.external_user_id,
        a.union_id,
        a.open_id,
        a.external_key,
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
        u.id AS local_user_id,
        u.email AS local_user_email,
        u.username AS local_user_username,
        u.name AS local_user_name,
        COALESCE(array_remove(array_agg(DISTINCT d.full_path), NULL), ARRAY[]::text[]) AS department_paths,
        CASE
          WHEN COALESCE(a.union_id, '') = '' AND COALESCE(a.open_id, '') = '' THEN 'missing_identifier'
          WHEN a.is_active = FALSE AND u.id IS NOT NULL THEN 'inactive_linked'
          ELSE 'pending_binding'
        END AS review_kind,
        CASE
          WHEN COALESCE(a.union_id, '') = '' AND COALESCE(a.open_id, '') = '' THEN '目录成员缺少 unionId/openId，无法用于钉钉登录绑定。'
          WHEN a.is_active = FALSE AND u.id IS NOT NULL THEN '目录成员已停用，但仍绑定本地用户，需要停权处理。'
          WHEN u.id IS NULL THEN '目录成员尚未绑定本地用户。'
          ELSE '目录成员当前不是已确认绑定状态，建议复核。'
        END AS review_reason,
        (COALESCE(a.union_id, '') = '') AS missing_union_id,
        (COALESCE(a.open_id, '') = '') AS missing_open_id
     FROM directory_accounts a
     LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
     LEFT JOIN users u ON u.id = l.local_user_id
     LEFT JOIN directory_account_departments ad ON ad.directory_account_id = a.id
     LEFT JOIN directory_departments d ON d.id = ad.directory_department_id
     WHERE a.id = $1
     GROUP BY
       a.integration_id, a.provider, a.corp_id, a.id, a.external_user_id, a.union_id, a.open_id, a.external_key,
       a.name, a.email, a.mobile, a.is_active, a.updated_at,
       l.link_status, l.match_strategy, l.reviewed_by, l.review_note, l.updated_at,
       u.id, u.email, u.username, u.name`,
    [normalizedAccountId],
  )

  const row = rowsResult.rows[0]
  if (!row) return null
  const recommendationsByAccount = await loadDirectoryReviewRecommendations([row])
  return summarizeReviewItem(row, recommendationsByAccount.get(row.directory_account_id) ?? null)
}

export async function batchUnbindDirectoryAccounts(
  directoryAccountIds: string[],
  input: DirectoryAccountUnbindInput,
): Promise<DirectoryAccountMutationResult[]> {
  const normalizedIds = Array.from(new Set(directoryAccountIds.map((item) => normalizeText(item)).filter(Boolean)))
  if (normalizedIds.length === 0) throw new Error('accountIds are required')

  const results: DirectoryAccountMutationResult[] = []
  for (const directoryAccountId of normalizedIds) {
    results.push(await unbindDirectoryAccount(directoryAccountId, input))
  }
  return results
}

export async function batchBindDirectoryAccounts(
  entries: DirectoryAccountBatchBindEntry[],
  input: { adminUserId: string },
): Promise<DirectoryAccountMutationResult[]> {
  const normalizedEntries = entries
    .map((entry) => ({
      accountId: normalizeText(entry.accountId),
      localUserRef: normalizeText(entry.localUserRef),
      enableDingTalkGrant: entry.enableDingTalkGrant !== false,
    }))
    .filter((entry) => entry.accountId.length > 0 && entry.localUserRef.length > 0)

  if (normalizedEntries.length === 0) throw new Error('bindings are required')

  const results: DirectoryAccountMutationResult[] = []
  for (const entry of normalizedEntries) {
    results.push(await bindDirectoryAccount(entry.accountId, {
      localUserRef: entry.localUserRef,
      adminUserId: input.adminUserId,
      enableDingTalkGrant: entry.enableDingTalkGrant,
    }))
  }
  return results
}

async function applyDirectoryAccountBindInTransaction(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  options: {
    normalizedAccountId: string
    normalizedAdminUserId: string
    enableDingTalkGrant: boolean
    account: DirectoryBindingTargetAccountRow
    localUser: Pick<DirectoryBindingUserRow, 'id' | 'email' | 'username' | 'name'>
  },
): Promise<void> {
  const { normalizedAccountId, normalizedAdminUserId, enableDingTalkGrant, account, localUser } = options
  const identityExternalKey = buildDingTalkIdentityExternalKey(account.corp_id, account.open_id, account.union_id)
  if (!identityExternalKey) {
    throw new Error('Directory account is missing DingTalk openId/unionId and cannot be pre-bound for DingTalk login')
  }

  const profile = JSON.stringify({
    source: 'directory_admin_bind',
    integrationId: account.integration_id,
    corpId: account.corp_id,
    externalUserId: account.external_user_id,
    unionId: account.union_id,
    openId: account.open_id,
    externalKey: account.external_key,
    name: account.name,
    email: account.email,
    mobile: account.mobile,
  })

  const conflictingIdentityResult = await client.query(
    `SELECT local_user_id
     FROM user_external_identities
     WHERE provider = $1
       AND local_user_id <> $5
       AND (
         external_key = $2
         OR ($3 IS NOT NULL AND provider_union_id = $3 AND corp_id IS NOT DISTINCT FROM $4)
         OR ($6 IS NOT NULL AND provider_open_id = $6 AND corp_id IS NOT DISTINCT FROM $4)
     )
     LIMIT 1`,
    [account.provider, identityExternalKey, account.union_id, account.corp_id, localUser.id, account.open_id],
  )
  if (conflictingIdentityResult.rows.length > 0) {
    throw new Error('DingTalk account is already bound to another local user')
  }

  const conflictingLinkResult = await client.query(
    `SELECT l.directory_account_id
     FROM directory_account_links l
     JOIN directory_accounts a ON a.id = l.directory_account_id
     WHERE a.provider = $1
       AND l.local_user_id = $2
       AND l.link_status = 'linked'
       AND l.directory_account_id <> $3
     LIMIT 1`,
    [account.provider, localUser.id, normalizedAccountId],
  )
  if (conflictingLinkResult.rows.length > 0) {
    throw new Error('Local user is already linked to another DingTalk directory account')
  }

  const existingIdentityResult = await client.query(
    `SELECT id
     FROM user_external_identities
     WHERE provider = $1 AND local_user_id = $2
     LIMIT 1`,
    [account.provider, localUser.id],
  )

  if (existingIdentityResult.rows.length > 0) {
    await client.query(
      `UPDATE user_external_identities
       SET external_key = $3,
           provider_union_id = $4,
           provider_open_id = $5,
           corp_id = $6,
           profile = $7::jsonb,
           bound_by = COALESCE(bound_by, $8),
           updated_at = NOW()
       WHERE provider = $1 AND local_user_id = $2`,
      [
        account.provider,
        localUser.id,
        identityExternalKey,
        account.union_id,
        account.open_id,
        account.corp_id,
        profile,
        normalizedAdminUserId,
      ],
    )
  } else {
    await client.query(
      `INSERT INTO user_external_identities (
         provider,
         external_key,
         provider_union_id,
         provider_open_id,
         corp_id,
         local_user_id,
         profile,
         bound_by,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())`,
      [
        account.provider,
        identityExternalKey,
        account.union_id,
        account.open_id,
        account.corp_id,
        localUser.id,
        profile,
        normalizedAdminUserId,
      ],
    )
  }

  if (enableDingTalkGrant) {
    await client.query(
      `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
       VALUES ($1, $2, TRUE, $3, NOW(), NOW())
       ON CONFLICT (provider, local_user_id)
       DO UPDATE SET enabled = TRUE, granted_by = EXCLUDED.granted_by, updated_at = NOW()`,
      [account.provider, localUser.id, normalizedAdminUserId],
    )
  }

  await client.query(
    `INSERT INTO directory_account_links (
       directory_account_id, local_user_id, link_status, match_strategy, reviewed_by, review_note, created_at, updated_at
     )
     VALUES ($1, $2, 'linked', 'manual_admin', $3, NULL, NOW(), NOW())
     ON CONFLICT (directory_account_id)
     DO UPDATE SET
       local_user_id = EXCLUDED.local_user_id,
       link_status = EXCLUDED.link_status,
       match_strategy = EXCLUDED.match_strategy,
       reviewed_by = EXCLUDED.reviewed_by,
       review_note = EXCLUDED.review_note,
       updated_at = NOW()`,
    [normalizedAccountId, localUser.id, normalizedAdminUserId],
  )
}

async function createDirectoryAdmittedUserInTransaction(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  options: {
    account: DirectoryBindingTargetAccountRow
    adminUserId: string
    name: string
    email: string | null
    username: string | null
    mobile: string | null
    passwordHash: string
    mustChangePassword: boolean
    enableDingTalkGrant: boolean
  },
): Promise<{ userId: string }> {
  const userId = crypto.randomUUID()
  if (options.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email)) {
    throw new Error('Invalid email format')
  }
  const usernameValidationError = validateDirectoryAdmissionUsername(options.username)
  if (usernameValidationError) {
    throw new Error(usernameValidationError)
  }
  if (!options.email && !options.username && !options.mobile) {
    throw new Error('At least one account identifier (email, username, or mobile) is required')
  }

  if (options.email) {
    const existingUserResult = await client.query(
      `SELECT id
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [options.email],
    )
    if (existingUserResult.rows.length > 0) {
      throw new Error('User with this email already exists')
    }
  }

  if (options.username) {
    const existingUsernameResult = await client.query(
      `SELECT id
       FROM users
       WHERE lower(username) = lower($1)
       LIMIT 1`,
      [options.username],
    )
    if (existingUsernameResult.rows.length > 0) {
      throw new Error('User with this username already exists')
    }
  }

  if (options.mobile) {
    const existingMobileResult = await client.query(
      `SELECT id
       FROM users
       WHERE mobile = $1
       LIMIT 1`,
      [options.mobile],
    )
    if (existingMobileResult.rows.length > 0) {
      throw new Error('User with this mobile already exists')
    }
  }

  await client.query(
    `INSERT INTO users (id, email, username, name, mobile, password_hash, must_change_password, role, permissions, is_active, is_admin, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'user', $8::jsonb, TRUE, FALSE, NOW(), NOW())`,
    [userId, options.email, options.username, options.name, options.mobile, options.passwordHash, options.mustChangePassword, JSON.stringify([])],
  )

  await applyDirectoryAccountBindInTransaction(client, {
    normalizedAccountId: options.account.id,
    normalizedAdminUserId: options.adminUserId,
    enableDingTalkGrant: options.enableDingTalkGrant,
    account: options.account,
    localUser: {
      id: userId,
      email: options.email,
      username: options.username,
      name: options.name,
    },
  })

  return { userId }
}

async function applyDirectoryProjectedMemberGroupGovernanceInTransaction(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  options: {
    plans: DirectoryProjectedMemberGroupPlan[]
    defaultRoleIds: string[]
    defaultNamespaces: string[]
    adminUserId: string
  },
): Promise<{
  governedUserIds: string[]
  defaultRoleAssignmentsCount: number
  defaultNamespaceAdmissionsCount: number
}> {
  const grantSet = buildDirectoryProjectedGovernanceGrantSet({
    plans: options.plans,
    defaultRoleIds: options.defaultRoleIds,
    defaultNamespaces: options.defaultNamespaces,
  })
  if (
    grantSet.userIds.length === 0
    || (grantSet.roleIds.length === 0 && grantSet.namespaces.length === 0)
  ) {
    return {
      governedUserIds: [],
      defaultRoleAssignmentsCount: 0,
      defaultNamespaceAdmissionsCount: 0,
    }
  }

  const auditUserId = normalizeDirectorySyncAuditUserId(options.adminUserId)
  let defaultRoleAssignmentsCount = 0
  let defaultNamespaceAdmissionsCount = 0

  if (grantSet.roleIds.length > 0) {
    const insertedRolesResult = await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.user_id, r.role_id
       FROM unnest($1::text[]) AS u(user_id)
       CROSS JOIN unnest($2::text[]) AS r(role_id)
       ON CONFLICT DO NOTHING
       RETURNING user_id, role_id`,
      [grantSet.userIds, grantSet.roleIds],
    )
    defaultRoleAssignmentsCount = insertedRolesResult.rows.length
  }

  if (grantSet.namespaces.length > 0) {
    const existingAdmissionsResult = await client.query(
      `SELECT user_id, namespace, enabled
       FROM user_namespace_admissions
       WHERE user_id = ANY($1::text[])
         AND namespace = ANY($2::text[])`,
      [grantSet.userIds, grantSet.namespaces],
    )
    const existingEnabledPairs = new Set(
      existingAdmissionsResult.rows
        .filter((row) => row.enabled === true)
        .map((row) => `${normalizeText(row.user_id)}:${normalizeNamespace(row.namespace)}`),
    )
    for (const userId of grantSet.userIds) {
      for (const namespace of grantSet.namespaces) {
        if (!existingEnabledPairs.has(`${userId}:${namespace}`)) {
          defaultNamespaceAdmissionsCount += 1
        }
      }
    }

    await client.query(
      `INSERT INTO user_namespace_admissions (
         user_id, namespace, enabled, source, granted_by, updated_by, created_at, updated_at
       )
       SELECT u.user_id, n.namespace, TRUE, $3, $4, $4, NOW(), NOW()
       FROM unnest($1::text[]) AS u(user_id)
       CROSS JOIN unnest($2::text[]) AS n(namespace)
       ON CONFLICT (user_id, namespace)
       DO UPDATE SET
         enabled = TRUE,
         source = EXCLUDED.source,
         granted_by = EXCLUDED.granted_by,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [grantSet.userIds, grantSet.namespaces, 'directory_member_group_sync', auditUserId],
    )
  }

  return {
    governedUserIds: grantSet.userIds,
    defaultRoleAssignmentsCount,
    defaultNamespaceAdmissionsCount,
  }
}

async function syncProjectedDepartmentMemberGroupsInTransaction(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  plans: DirectoryProjectedMemberGroupPlan[],
  options: {
    defaultRoleIds: string[]
    defaultNamespaces: string[]
  },
  adminUserId: string,
): Promise<{
  memberGroupsCreatedCount: number
  memberGroupsSyncedCount: number
  memberGroupMembershipsUpdatedCount: number
  memberGroupGovernedUserCount: number
  memberGroupDefaultRoleAssignmentsCount: number
  memberGroupDefaultNamespaceAdmissionsCount: number
  governedUserIds: string[]
}> {
  if (plans.length === 0) {
    return {
      memberGroupsCreatedCount: 0,
      memberGroupsSyncedCount: 0,
      memberGroupMembershipsUpdatedCount: 0,
      memberGroupGovernedUserCount: 0,
      memberGroupDefaultRoleAssignmentsCount: 0,
      memberGroupDefaultNamespaceAdmissionsCount: 0,
      governedUserIds: [],
    }
  }

  const auditUserId = normalizeDirectorySyncAuditUserId(adminUserId)
  const existingGroupsResult = await client.query(
    `SELECT id, description
     FROM platform_member_groups
     WHERE description = ANY($1::text[])`,
    [plans.map((plan) => plan.marker)],
  )
  const groupIdByMarker = new Map<string, string>()
  for (const row of existingGroupsResult.rows) {
    const marker = normalizeText(row.description)
    const groupId = normalizeText(row.id)
    if (marker && groupId) groupIdByMarker.set(marker, groupId)
  }

  let memberGroupsCreatedCount = 0
  let memberGroupsSyncedCount = 0
  let memberGroupMembershipsUpdatedCount = 0

  for (const plan of plans) {
    let groupId = groupIdByMarker.get(plan.marker) ?? ''
    if (!groupId) {
      const createdGroupResult = await client.query(
        `INSERT INTO platform_member_groups (
           name, description, created_by, updated_by, created_at, updated_at
         )
         VALUES ($1, $2, $3, $3, NOW(), NOW())
         RETURNING id`,
        [plan.name, plan.marker, auditUserId],
      )
      groupId = normalizeText(createdGroupResult.rows[0]?.id)
      if (!groupId) throw new Error('Failed to create projected platform member group')
      groupIdByMarker.set(plan.marker, groupId)
      memberGroupsCreatedCount += 1
    } else {
      await client.query(
        `UPDATE platform_member_groups
         SET name = $2,
             updated_by = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [groupId, plan.name, auditUserId],
      )
    }

    memberGroupsSyncedCount += 1

    const currentMembersResult = await client.query(
      `SELECT user_id
       FROM platform_member_group_members
       WHERE group_id = $1`,
      [groupId],
    )
    const currentMembers = new Set(
      currentMembersResult.rows
        .map((row) => normalizeText(row.user_id))
        .filter(Boolean),
    )
    const desiredMembers = new Set(plan.memberUserIds.map((value) => normalizeText(value)).filter(Boolean))

    const membersToDelete = Array.from(currentMembers).filter((value) => !desiredMembers.has(value))
    const membersToInsert = Array.from(desiredMembers).filter((value) => !currentMembers.has(value))

    if (membersToDelete.length > 0) {
      await client.query(
        `DELETE FROM platform_member_group_members
         WHERE group_id = $1
           AND user_id = ANY($2::text[])`,
        [groupId, membersToDelete],
      )
    }

    for (const userId of membersToInsert) {
      await client.query(
        `INSERT INTO platform_member_group_members (group_id, user_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT DO NOTHING`,
        [groupId, userId],
      )
    }

    memberGroupMembershipsUpdatedCount += membersToDelete.length + membersToInsert.length
  }

  const governance = await applyDirectoryProjectedMemberGroupGovernanceInTransaction(client, {
    plans,
    defaultRoleIds: options.defaultRoleIds,
    defaultNamespaces: options.defaultNamespaces,
    adminUserId,
  })

  return {
    memberGroupsCreatedCount,
    memberGroupsSyncedCount,
    memberGroupMembershipsUpdatedCount,
    memberGroupGovernedUserCount: governance.governedUserIds.length,
    memberGroupDefaultRoleAssignmentsCount: governance.defaultRoleAssignmentsCount,
    memberGroupDefaultNamespaceAdmissionsCount: governance.defaultNamespaceAdmissionsCount,
    governedUserIds: governance.governedUserIds,
  }
}

export async function getDirectoryAccountSummary(accountId: string): Promise<DirectoryIntegrationAccountSummary | null> {
  const normalizedAccountId = normalizeText(accountId)
  if (!normalizedAccountId) throw new Error('accountId is required')

  const result = await query<DirectoryIntegrationAccountRow>(
    `SELECT
        a.integration_id,
        a.provider,
        a.corp_id,
        a.id AS directory_account_id,
        a.external_user_id,
        a.union_id,
        a.open_id,
        a.external_key,
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
        u.id AS local_user_id,
        u.email AS local_user_email,
        u.username AS local_user_username,
        u.name AS local_user_name,
        COALESCE(array_remove(array_agg(DISTINCT d.full_path), NULL), ARRAY[]::text[]) AS department_paths
     FROM directory_accounts a
     LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
     LEFT JOIN users u ON u.id = l.local_user_id
     LEFT JOIN directory_account_departments ad ON ad.directory_account_id = a.id
     LEFT JOIN directory_departments d ON d.id = ad.directory_department_id
     WHERE a.id = $1
     GROUP BY
       a.integration_id, a.provider, a.corp_id, a.id, a.external_user_id, a.union_id, a.open_id, a.external_key,
       a.name, a.email, a.mobile, a.is_active, a.updated_at,
       l.link_status, l.match_strategy, l.reviewed_by, l.review_note, l.updated_at,
       u.id, u.email, u.username, u.name`,
    [normalizedAccountId],
  )

  const row = result.rows[0]
  return row ? summarizeDirectoryAccount(row) : null
}

async function resolveDirectoryBindingUser(localUserRef: string): Promise<DirectoryBindingUserRow | null> {
  const ref = normalizeText(localUserRef)
  if (!ref) return null

  const result = await query<DirectoryBindingUserRow>(
    `SELECT id,
            email,
            username,
            mobile,
            name,
            COALESCE(role, 'user') AS role,
            COALESCE(is_active, TRUE) AS is_active
     FROM users
     WHERE id = $1
        OR LOWER(COALESCE(email, '')) = LOWER($1)
        OR LOWER(COALESCE(username, '')) = LOWER($1)
        OR regexp_replace(COALESCE(mobile, ''), '\\s+', '', 'g') = regexp_replace($1, '\\s+', '', 'g')
     ORDER BY
       CASE
         WHEN id = $1 THEN 0
         WHEN LOWER(COALESCE(email, '')) = LOWER($1) THEN 1
         WHEN LOWER(COALESCE(username, '')) = LOWER($1) THEN 2
         WHEN regexp_replace(COALESCE(mobile, ''), '\\s+', '', 'g') = regexp_replace($1, '\\s+', '', 'g') THEN 3
         ELSE 4
       END
     LIMIT 1`,
    [ref],
  )

  return result.rows[0] ?? null
}

async function loadDirectoryBindingTargetAccount(directoryAccountId: string): Promise<DirectoryBindingTargetAccountRow | null> {
  const result = await query<DirectoryBindingTargetAccountRow>(
    `SELECT id, integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key, name, email, mobile
     FROM directory_accounts
     WHERE id = $1
     LIMIT 1`,
    [directoryAccountId],
  )
  return result.rows[0] ?? null
}

async function loadDirectoryLinkedUser(directoryAccountId: string): Promise<DirectoryAccountLinkedUserRow | null> {
  const result = await query<DirectoryAccountLinkedUserRow>(
    `SELECT l.local_user_id,
            u.email AS local_user_email,
            u.username AS local_user_username,
            u.name AS local_user_name
     FROM directory_account_links l
     LEFT JOIN users u ON u.id = l.local_user_id
     WHERE l.directory_account_id = $1
     LIMIT 1`,
    [directoryAccountId],
  )
  return result.rows[0] ?? null
}

export async function listDirectoryIntegrationAccounts(
  integrationId: string,
  pagination: { limit: number; offset: number },
  search?: string,
): Promise<{ items: DirectoryIntegrationAccountSummary[]; total: number }> {
  const normalizedIntegrationId = normalizeText(integrationId)
  if (!normalizedIntegrationId) throw new Error('integrationId is required')

  const normalizedSearch = normalizeText(search)
  const values: unknown[] = [normalizedIntegrationId]
  const where: string[] = ['a.integration_id = $1']

  if (normalizedSearch) {
    values.push(`%${normalizedSearch}%`)
    where.push(`(
      a.name ILIKE $${values.length}
      OR COALESCE(a.email, '') ILIKE $${values.length}
      OR COALESCE(a.mobile, '') ILIKE $${values.length}
      OR a.external_user_id ILIKE $${values.length}
      OR COALESCE(a.union_id, '') ILIKE $${values.length}
      OR COALESCE(a.open_id, '') ILIKE $${values.length}
      OR COALESCE(u.email, '') ILIKE $${values.length}
      OR COALESCE(u.name, '') ILIKE $${values.length}
      OR COALESCE(u.id, '') ILIKE $${values.length}
    )`)
  }

  const whereSql = where.join(' AND ')
  const countValues = [...values]
  const listValues = [...values, pagination.limit, pagination.offset]

  const [countResult, rowsResult] = await Promise.all([
    query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM directory_accounts a
       LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
       LEFT JOIN users u ON u.id = l.local_user_id
       WHERE ${whereSql}`,
      countValues,
    ),
    query<DirectoryIntegrationAccountRow>(
      `SELECT
          a.integration_id,
          a.provider,
          a.corp_id,
          a.id AS directory_account_id,
          a.external_user_id,
          a.union_id,
          a.open_id,
          a.external_key,
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
          u.id AS local_user_id,
          u.email AS local_user_email,
          u.username AS local_user_username,
          u.name AS local_user_name,
          COALESCE(array_remove(array_agg(DISTINCT d.full_path), NULL), ARRAY[]::text[]) AS department_paths
       FROM directory_accounts a
       LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
       LEFT JOIN users u ON u.id = l.local_user_id
       LEFT JOIN directory_account_departments ad ON ad.directory_account_id = a.id
       LEFT JOIN directory_departments d ON d.id = ad.directory_department_id
       WHERE ${whereSql}
       GROUP BY
         a.integration_id, a.provider, a.corp_id, a.id, a.external_user_id, a.union_id, a.open_id, a.external_key,
         a.name, a.email, a.mobile, a.is_active, a.updated_at,
         l.link_status, l.match_strategy, l.reviewed_by, l.review_note, l.updated_at,
         u.id, u.email, u.username, u.name
       ORDER BY a.is_active DESC, a.name ASC, a.external_user_id ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      listValues,
    ),
  ])

  return {
    items: rowsResult.rows.map(summarizeDirectoryAccount),
    total: Number(countResult.rows[0]?.total ?? 0),
  }
}

export async function bindDirectoryAccount(
  directoryAccountId: string,
  input: DirectoryAccountBindInput,
): Promise<DirectoryAccountMutationResult> {
  const normalizedAccountId = normalizeText(directoryAccountId)
  const normalizedLocalUserRef = normalizeText(input.localUserRef)
  const normalizedAdminUserId = normalizeText(input.adminUserId)
  const enableDingTalkGrant = input.enableDingTalkGrant !== false

  if (!normalizedAccountId) throw new Error('directoryAccountId is required')
  if (!normalizedLocalUserRef) throw new Error('localUserRef is required')
  if (!normalizedAdminUserId) throw new Error('adminUserId is required')

  const [account, previousLinkedUser] = await Promise.all([
    loadDirectoryBindingTargetAccount(normalizedAccountId),
    loadDirectoryLinkedUser(normalizedAccountId),
  ])
  if (!account) throw new Error('Directory account not found')

  if (!buildDingTalkIdentityExternalKey(account.corp_id, account.open_id, account.union_id)) {
    throw new Error('Directory account is missing DingTalk openId/unionId and cannot be pre-bound for DingTalk login')
  }

  const localUser = await resolveDirectoryBindingUser(normalizedLocalUserRef)
  if (!localUser) throw new Error('Local user not found')

  await transaction(async (client) => {
    await applyDirectoryAccountBindInTransaction(client, {
      normalizedAccountId,
      normalizedAdminUserId,
      enableDingTalkGrant,
      account,
      localUser,
    })
  })

  const summary = await getDirectoryAccountSummary(normalizedAccountId)
  if (!summary) {
    throw new Error('Directory account bound but summary reload failed')
  }

  return {
    account: summary,
    previousLocalUser: previousLinkedUser?.local_user_id
      ? {
        id: previousLinkedUser.local_user_id,
        email: previousLinkedUser.local_user_email,
        name: previousLinkedUser.local_user_name,
      }
      : null,
  }
}

export async function admitDirectoryAccountUser(
  directoryAccountId: string,
  input: DirectoryAccountManualAdmissionInput,
): Promise<DirectoryAccountManualAdmissionResult> {
  const normalizedAccountId = normalizeText(directoryAccountId)
  const normalizedAdminUserId = normalizeText(input.adminUserId)
  const cleanName = sanitizeDirectoryAdmissionName(input.name)
  const cleanEmail = sanitizeDirectoryAdmissionEmail(input.email)
  const cleanUsername = sanitizeDirectoryAdmissionUsername(input.username)
  const cleanMobile = sanitizeDirectoryAdmissionMobile(input.mobile)
  const requestedPassword = normalizeText(input.password)
  const enableDingTalkGrant = input.enableDingTalkGrant !== false

  if (!normalizedAccountId) throw new Error('directoryAccountId is required')
  if (!normalizedAdminUserId) throw new Error('adminUserId is required')
  if (!cleanName || (!cleanEmail && !cleanUsername && !cleanMobile)) {
    throw new Error('name and at least one account identifier (email, username, or mobile) are required')
  }
  if (cleanName.length < 2 || cleanName.length > 100) throw new Error('Name must be between 2 and 100 characters')
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Invalid email format')
  const usernameValidationError = validateDirectoryAdmissionUsername(cleanUsername)
  if (usernameValidationError) throw new Error(usernameValidationError)

  const generatedPassword = requestedPassword || generateDirectoryAdmissionTemporaryPassword()
  const mustChangePassword = requestedPassword.length === 0
  const passwordValidation = validatePassword(generatedPassword)
  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.errors[0] || 'Password does not meet requirements')
  }

  const [account, previousLinkedUser] = await Promise.all([
    loadDirectoryBindingTargetAccount(normalizedAccountId),
    loadDirectoryLinkedUser(normalizedAccountId),
  ])
  if (!account) throw new Error('Directory account not found')

  if (!buildDingTalkIdentityExternalKey(account.corp_id, account.open_id, account.union_id)) {
    throw new Error('Directory account is missing DingTalk openId/unionId and cannot be pre-bound for DingTalk login')
  }

  const passwordHash = await bcrypt.hash(generatedPassword, getBcryptSaltRounds())
  let userId = ''

  await transaction(async (client) => {
    const created = await createDirectoryAdmittedUserInTransaction(client, {
      account,
      adminUserId: normalizedAdminUserId,
      name: cleanName,
      email: cleanEmail || null,
      username: cleanUsername,
      mobile: cleanMobile,
      passwordHash,
      mustChangePassword,
      enableDingTalkGrant,
    })
    userId = created.userId
  })

  const resolvedInviteToken = cleanEmail
    ? issueInviteToken({
      userId,
      email: cleanEmail,
      presetId: null,
    })
    : null

  if (cleanEmail && resolvedInviteToken) {
    await recordInvite({
      userId,
      email: cleanEmail,
      presetId: null,
      productMode: 'platform',
      roleId: null,
      invitedBy: normalizedAdminUserId,
      inviteToken: resolvedInviteToken,
    })
  }

  const summary = await getDirectoryAccountSummary(normalizedAccountId)
  if (!summary) {
    throw new Error('Directory account bound but summary reload failed')
  }

  return {
    account: summary,
    previousLocalUser: previousLinkedUser?.local_user_id
      ? {
        id: previousLinkedUser.local_user_id,
        email: previousLinkedUser.local_user_email,
        name: previousLinkedUser.local_user_name,
      }
      : null,
    user: {
      id: userId,
      email: cleanEmail || null,
      username: cleanUsername,
      name: cleanName,
      mobile: cleanMobile,
      role: 'user',
      is_active: true,
    },
    temporaryPassword: requestedPassword.length === 0 ? generatedPassword : undefined,
    inviteToken: resolvedInviteToken,
    onboarding: buildOnboardingPacket({
      email: cleanEmail || null,
      accountLabel: resolveDirectoryAdmissionAccountLabel({
        email: cleanEmail || null,
        username: cleanUsername,
        mobile: cleanMobile,
        userId,
      }),
      temporaryPassword: requestedPassword.length === 0 ? generatedPassword : null,
      preset: null,
      inviteToken: resolvedInviteToken,
    }),
  }
}

export async function unbindDirectoryAccount(
  directoryAccountId: string,
  input: DirectoryAccountUnbindInput,
): Promise<DirectoryAccountMutationResult> {
  const normalizedAccountId = normalizeText(directoryAccountId)
  const normalizedAdminUserId = normalizeText(input.adminUserId)
  const disableDingTalkGrant = input.disableDingTalkGrant === true

  if (!normalizedAccountId) throw new Error('directoryAccountId is required')
  if (!normalizedAdminUserId) throw new Error('adminUserId is required')

  const [account, previousLinkedUser] = await Promise.all([
    loadDirectoryBindingTargetAccount(normalizedAccountId),
    loadDirectoryLinkedUser(normalizedAccountId),
  ])
  if (!account) throw new Error('Directory account not found')

  const identityExternalKey = buildDingTalkIdentityExternalKey(account.corp_id, account.open_id, account.union_id)

  await transaction(async (client) => {
    if (previousLinkedUser?.local_user_id) {
      const deleteIdentityParams: unknown[] = [
        account.provider,
        previousLinkedUser.local_user_id,
      ]
      const deleteIdentityClauses = [
        'provider = $1',
        'local_user_id = $2',
      ]

      if (identityExternalKey) {
        deleteIdentityParams.push(identityExternalKey)
        deleteIdentityClauses.push(`external_key = $${deleteIdentityParams.length}`)
      } else if (normalizeText(account.open_id)) {
        deleteIdentityParams.push(account.open_id, account.corp_id)
        deleteIdentityClauses.push(
          `(provider_open_id = $${deleteIdentityParams.length - 1} AND corp_id IS NOT DISTINCT FROM $${deleteIdentityParams.length})`,
        )
      } else if (normalizeText(account.union_id)) {
        deleteIdentityParams.push(account.union_id, account.corp_id)
        deleteIdentityClauses.push(
          `(provider_union_id = $${deleteIdentityParams.length - 1} AND corp_id IS NOT DISTINCT FROM $${deleteIdentityParams.length})`,
        )
      }

      if (deleteIdentityClauses.length > 2) {
        await client.query(
          `DELETE FROM user_external_identities
           WHERE ${deleteIdentityClauses.join(' AND ')}`,
          deleteIdentityParams,
        )
      }

      if (disableDingTalkGrant) {
        await client.query(
          `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
           VALUES ($1, $2, FALSE, $3, NOW(), NOW())
           ON CONFLICT (provider, local_user_id)
           DO UPDATE SET enabled = FALSE, granted_by = EXCLUDED.granted_by, updated_at = NOW()`,
          [account.provider, previousLinkedUser.local_user_id, normalizedAdminUserId],
        )
      }
    }

    await client.query(
      `INSERT INTO directory_account_links (
         directory_account_id, local_user_id, link_status, match_strategy, reviewed_by, review_note, created_at, updated_at
       )
       VALUES ($1, NULL, 'unmatched', 'manual_unbound', $2, 'unbound by admin', NOW(), NOW())
       ON CONFLICT (directory_account_id)
       DO UPDATE SET
         local_user_id = NULL,
         link_status = EXCLUDED.link_status,
         match_strategy = EXCLUDED.match_strategy,
         reviewed_by = EXCLUDED.reviewed_by,
         review_note = EXCLUDED.review_note,
         updated_at = NOW()`,
      [normalizedAccountId, normalizedAdminUserId],
    )
  })

  const summary = await getDirectoryAccountSummary(normalizedAccountId)
  if (!summary) {
    throw new Error('Directory account unbound but summary reload failed')
  }

  return {
    account: summary,
    previousLocalUser: previousLinkedUser?.local_user_id
      ? {
        id: previousLinkedUser.local_user_id,
        email: previousLinkedUser.local_user_email,
        name: previousLinkedUser.local_user_name,
      }
      : null,
  }
}
