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
  getDingTalkDepartmentDetail,
  getDingTalkUserDetail,
  listDingTalkDepartments,
  listDingTalkDepartmentUsers,
  type DingTalkDepartment,
  type DingTalkDirectoryUser,
} from '../integrations/dingtalk/client'
import {
  capturePriorDeptManagers,
  enrichDepartmentsWithManagers,
  mergeDeptManagerIntoRaw,
  resolveManagerListForDept,
} from './department-manager-enrichment'
import {
  createDirectorySyncApiCallCounters,
  summarizeDirectorySyncApiCalls,
  type DirectorySyncApiCallCounters,
} from './directory-sync-api-telemetry'
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
import { deliverDirectorySyncFailureAlert, getDirectoryManagerBindingCoverage } from './directory-sync-alert-delivery'
import { resolveDirectoryScheduleTimezone } from './directory-sync-timezone'

const logger = new Logger('DirectorySync')
const DEFAULT_ORG_ID = 'default'
const DEFAULT_PROVIDER = 'dingtalk'
const DEFAULT_ROOT_DEPARTMENT_ID = '1'
const DEFAULT_PAGE_SIZE = 50
const DEFAULT_ADMISSION_MODE = 'manual_only'
const DEFAULT_MEMBER_GROUP_SYNC_MODE = 'disabled'
const DINGTALK_OPEN_ID_REQUIRED_FOR_GRANT_ERROR =
  'Directory account is missing DingTalk openId and cannot enable DingTalk login grant; resync DingTalk directory or complete DingTalk OAuth binding first'

type JsonRecord = Record<string, unknown>
export type DirectoryAdmissionMode = 'manual_only' | 'auto_for_scoped_departments'
export type DirectoryMemberGroupSyncMode = 'disabled' | 'sync_scoped_departments'

type DirectoryIntegrationConfig = {
  appKey: string
  appSecret: string
  workNotificationAgentId: string
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
  // Roadmap §7.8: NULL for every row created before this landed. NULL/'UTC'/'Etc/UTC' are
  // all "no configured timezone" — resolved via `resolveDirectoryScheduleTimezone`.
  schedule_timezone: string | null
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

type DirectoryDepartmentSummaryRow = {
  directory_department_id: string
  integration_id: string
  provider: string
  external_department_id: string
  external_parent_department_id: string | null
  name: string
  full_path: string | null
  order_index: number
  is_active: boolean
  last_seen_at: string
  updated_at: string
  account_count: number
  linked_account_count: number
  child_count: number
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
  scheduleTimezone: string | null
  defaultDeprovisionPolicy: string
  lastSyncAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  config: {
    appKey: string
    appSecretConfigured: boolean
    workNotificationAgentIdConfigured: boolean
    approvalCardLinkSecretConfigured: boolean
    approvalCardPublicAppUrl: string | null
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

export type DirectoryDepartmentSummary = {
  id: string
  integrationId: string
  provider: string
  externalDepartmentId: string
  parentExternalDepartmentId: string | null
  name: string
  fullPath: string | null
  orderIndex: number
  isActive: boolean
  lastSeenAt: string
  updatedAt: string
  accountCount: number
  linkedAccountCount: number
  childCount: number
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
  // Roadmap §7.8: an IANA zone (e.g. 'Asia/Shanghai'), '' / null / 'UTC' / 'Etc/UTC' for the
  // default, or `undefined` (key absent) to leave whatever is currently saved untouched —
  // see `updateDirectoryIntegration`'s absent-vs-present handling.
  scheduleTimezone?: string | null
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
  workNotificationAgentId: string
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
  summary: DirectoryIntegrationDiagnosticSummary
  warnings: string[]
}

export type DirectoryIntegrationDiagnosticSummary = {
  code: string
  title: string
  nextAction: string
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
  scheduleTimezone: string | null
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

export type DirectoryAccountBatchAdmissionInput = {
  adminUserId: string
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

export type DirectoryAccountBatchAdmissionOutcome = {
  succeeded: DirectoryAccountManualAdmissionResult[]
  failed: Array<{ accountId: string; error: string }>
}

export type DirectoryAutoAdmissionOnboardingPacket = {
  userId: string
  name: string
  email: string | null
  username: string | null
  mobile: string | null
  temporaryPassword: string
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

function normalizeMobileIdentifier(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, '')
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
  const text = normalizeMobileIdentifier(value)
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

export function buildDirectoryAutoAdmissionUsername(account: {
  id: string
  external_user_id: string
  union_id: string | null
  open_id: string | null
}): string {
  const stableSource = [
    normalizeText(account.external_user_id),
    normalizeText(account.union_id),
    normalizeText(account.open_id),
    normalizeText(account.id).replace(/-/g, ''),
  ].find((value) => value.length > 0) || 'user'
  const normalizedSource = stableSource
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const uniqueSuffix = normalizeText(account.id).replace(/-/g, '').slice(0, 8).toLowerCase() || 'account'
  const username = `dt_${normalizedSource || 'user'}_${uniqueSuffix}`
    .replace(/_+/g, '_')
    .slice(0, 64)
  return username.length >= 3 ? username : `dt_${uniqueSuffix}`
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

/**
 * DT-HARDEN-07 — which department is the requester's PRIMARY one.
 *
 * `directory_account_departments.is_primary` is what `ApprovalDirectoryOrg` anchors on:
 * `direct_manager` and the whole `continuous_managers` chain start from the primary
 * department. It was derived as `departmentIds[0]`, i.e. wherever DingTalk happened to
 * put the department in `dept_id_list` (and, for a user first seen through another
 * department's listing, wherever the merge happened to put it). A multi-department
 * employee could therefore route approvals up the wrong management chain.
 *
 * DingTalk's `topapi/v2/user/get` has no unambiguous "main department" field. It returns
 * `dept_order_list: [{dept_id, order}]`, whose `order` is the employee's sort position
 * within each department — conventionally lowest for the primary department, but that is
 * NOT contractually documented. Silently switching the signal would change live approval
 * routing on an unverified assumption, so the order-based resolver ships DEFAULT-OFF
 * behind `DIRECTORY_PRIMARY_DEPT_FROM_ORDER`. Roadmap §6.8 gates enabling it on
 * confirming the field shape against a real tenant in staging.
 *
 * Either way the choice is now explicit, deterministic and testable rather than an
 * accident of array order.
 */
export function isDirectoryPrimaryDepartmentFromOrderEnabled(): boolean {
  return ['true', '1', 'yes'].includes(
    String(process.env.DIRECTORY_PRIMARY_DEPT_FROM_ORDER ?? '').trim().toLowerCase(),
  )
}

type DirectoryDepartmentOrderEntry = { departmentId: string; order: number }

export function parseDirectoryDepartmentOrderList(raw: unknown): DirectoryDepartmentOrderEntry[] {
  const source = asJsonRecord(raw)
  if (!source) return []
  const list = source.dept_order_list ?? source.deptOrderList
  if (!Array.isArray(list)) return []

  const entries: DirectoryDepartmentOrderEntry[] = []
  for (const item of list) {
    const record = asJsonRecord(item)
    if (!record) continue
    const departmentId = normalizeText(record.dept_id ?? record.deptId)
    const order = parseDepartmentOrderValue(record.order)
    if (!departmentId || order === null) continue
    entries.push({ departmentId, order })
  }
  return entries
}

/**
 * `Number()` folds null, '', [], and false to 0 — and 0 is the winning order. A missing or
 * malformed `order` must drop the entry, never silently elect its department primary.
 */
function parseDepartmentOrderValue(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function resolveDirectoryPrimaryDepartmentId(user: {
  departmentIds: string[]
  source?: unknown
}): string | null {
  const departmentIds = user.departmentIds.map((value) => normalizeText(value)).filter(Boolean)
  if (departmentIds.length === 0) return null
  if (departmentIds.length === 1) return departmentIds[0]

  if (isDirectoryPrimaryDepartmentFromOrderEnabled()) {
    const ranked = parseDirectoryDepartmentOrderList(user.source)
      // Only departments the user actually belongs to; guards against stale entries.
      .filter((entry) => departmentIds.includes(entry.departmentId))
    if (ranked.length > 0) {
      // Lowest order wins; ties break by the user's own dept_id_list position so the
      // result is stable across syncs rather than dependent on payload iteration order.
      const best = ranked.reduce((winner, candidate) => {
        if (candidate.order !== winner.order) return candidate.order < winner.order ? candidate : winner
        return departmentIds.indexOf(candidate.departmentId) < departmentIds.indexOf(winner.departmentId)
          ? candidate
          : winner
      })
      return best.departmentId
    }
  }

  return departmentIds[0]
}

export type DirectoryAccountDepartmentWriteSummary = {
  membershipsWritten: number
  /** Accounts that ended the write with exactly one department flagged primary. */
  accountsWithPrimary: number
  /** Accounts whose departments were all unknown to this integration — nothing written. */
  accountsWithoutKnownDepartment: number
}

/**
 * DT-HARDEN-07 — writes `directory_account_departments`, including the `is_primary` flag
 * that `ApprovalDirectoryOrg` anchors approval routing on.
 *
 * This is a seam, not decoration. The flag used to be computed inline inside
 * `syncDirectoryIntegration`, whose orchestration has no test (it needs a live DingTalk).
 * The one line that decided a person's management chain was therefore unreachable from any
 * test: reverting it left the whole suite green. Extracting the write lets a real-DB golden
 * drive it directly — and any future rewrite of this body (a bulk `unnest` insert, say) has
 * to keep that golden passing rather than silently reverting to `departmentIds[0]`.
 */
/**
 * DT-PERF-01 — flatten (employee × department) membership into three parallel arrays for a
 * single `unnest` upsert. Exported because the per-row loop it replaced was the sync's largest
 * source of round trips, and its semantics — which pair exists, which one is primary, how a
 * repeated pair collapses — must be pinned by tests rather than re-derived by a reader.
 *
 * `isPrimary` comes from `resolveDirectoryPrimaryDepartmentId`, NOT from `departmentIds[0]`.
 * Reintroducing the array index here would silently revert DT-HARDEN-07's approval-routing fix,
 * which is why the real-DB golden drives the writer rather than this builder.
 */
export function buildDirectoryAccountDepartmentRows(
  users: Iterable<{ userId: string; departmentIds: string[]; source?: unknown }>,
  accountIdByExternalUserId: Map<string, { id: string }>,
  departmentIdByExternalDepartmentId: Map<string, string>,
): { accountIds: string[]; departmentIds: string[]; isPrimary: boolean[]; summary: DirectoryAccountDepartmentWriteSummary } {
  const accountIds: string[] = []
  const departmentIds: string[] = []
  const isPrimary: boolean[] = []
  const seen = new Set<string>()
  const summary: DirectoryAccountDepartmentWriteSummary = {
    membershipsWritten: 0,
    accountsWithPrimary: 0,
    accountsWithoutKnownDepartment: 0,
  }

  for (const user of users) {
    const account = accountIdByExternalUserId.get(user.userId)
    if (!account) continue

    // An explicit, deterministic primary department — approval manager routing anchors on
    // is_primary, so this must not be an accident of array order.
    const primaryDepartmentId = resolveDirectoryPrimaryDepartmentId(user)
    let wrotePrimary = false
    let wroteAny = false

    for (const departmentId of user.departmentIds) {
      const directoryDepartmentId = departmentIdByExternalDepartmentId.get(departmentId)
      if (!directoryDepartmentId) continue
      const pairKey = `${account.id}:${directoryDepartmentId}`
      if (seen.has(pairKey)) continue
      seen.add(pairKey)

      const primary = departmentId === primaryDepartmentId
      accountIds.push(account.id)
      departmentIds.push(directoryDepartmentId)
      isPrimary.push(primary)
      summary.membershipsWritten += 1
      wroteAny = true
      wrotePrimary = wrotePrimary || primary
    }

    if (!wroteAny) summary.accountsWithoutKnownDepartment += 1
    else if (wrotePrimary) summary.accountsWithPrimary += 1
  }

  return { accountIds, departmentIds, isPrimary, summary }
}

export async function upsertDirectoryAccountDepartments(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  input: {
    users: Iterable<{ userId: string; departmentIds: string[]; source?: unknown }>
    /** external_user_id → the account row (only `id` is read). */
    accountIdMap: Map<string, { id: string }>
    /** external_department_id → directory_departments.id */
    departmentIdMap: Map<string, string>
  },
): Promise<DirectoryAccountDepartmentWriteSummary> {
  const rows = buildDirectoryAccountDepartmentRows(input.users, input.accountIdMap, input.departmentIdMap)

  // DT-PERF-01: this is the highest-cardinality write in the sync — one row per
  // (employee × department), so a 2,000-employee tenant issued thousands of single-row round
  // trips inside the apply transaction, holding its locks open for the whole walk. One `unnest`
  // statement writes them all with identical semantics.
  if (rows.accountIds.length > 0) {
    await client.query(
      `INSERT INTO directory_account_departments (
         directory_account_id, directory_department_id, is_primary, created_at
       )
       SELECT account_id, department_id, is_primary, NOW()
         FROM unnest($1::uuid[], $2::uuid[], $3::boolean[])
           AS t(account_id, department_id, is_primary)
       ON CONFLICT (directory_account_id, directory_department_id)
       DO UPDATE SET is_primary = EXCLUDED.is_primary`,
      [rows.accountIds, rows.departmentIds, rows.isPrimary],
    )
  }

  return rows.summary
}

/**
 * DT-HARDEN-02: whether an auto-admitted account can be granted DingTalk login.
 * A grant needs a stable identity key: corp-scoped accounts key on corpId+openId,
 * so a corp account WITHOUT an openId cannot be granted (directory 通讯录's
 * user/get does not return openId — it only appears after a real DingTalk OAuth
 * bind); non-corp accounts key on unionId and are grantable. Mirrors
 * `assertDirectoryAccountCanEnableDingTalkGrant` exactly so auto-admission never
 * requests a grant the assertion would reject (which previously threw AFTER the
 * users row was inserted, leaving a committed orphan).
 */
export function resolveDirectoryAutoAdmissionCanGrantDingTalkLogin(
  account: { corp_id: string | null; open_id: string | null },
): boolean {
  return !normalizeText(account.corp_id) || Boolean(normalizeText(account.open_id))
}

/** The identity fields the matching cascade below needs from a pulled/upserted account. */
export type DirectoryIdentityMatchAccount = {
  corpId: string | null
  externalKey: string
  unionId: string | null
  openId: string | null
  email: string | null
  mobile: string | null
}

/** Just enough of the existing link row to decide the already-linked short-circuit. */
export type DirectoryIdentityExistingLink = {
  local_user_id: string | null
  link_status: string
}

export type DirectoryIdentityMatchMaps = {
  externalIdentityMap: Map<string, string>
  scopedUnionIdentityMap: Map<string, string>
  scopedOpenIdentityMap: Map<string, string>
  emailMap: Map<string, string>
  mobileMap: Map<string, string>
  ambiguousEmailKeys: Set<string>
  ambiguousMobileKeys: Set<string>
}

export type DirectoryIdentityMatchOutcome =
  | { matched: 'already_linked' }
  | { matched: 'external_identity'; localUserId: string }
  | { matched: 'email'; localUserId: string }
  | { matched: 'mobile'; localUserId: string }
  | { matched: 'ambiguous' }
  | { matched: 'none' }

/**
 * The identity-matching cascade `syncDirectoryIntegration` walks for every pulled DingTalk
 * user, extracted so `previewDirectorySyncIntegration` can walk the exact same cascade
 * instead of approximating it. Order matters and mirrors apply: already-linked short-circuit,
 * then external-identity (union/open id or external_key), then unique email, then unique
 * mobile, then ambiguous-identifier. `{ matched: 'none' }` is the ONLY outcome under which
 * apply reaches the auto-admission branch — that is the exact condition preview must gate
 * `autoAdmissionCandidateCount` behind to avoid over-counting accounts that would actually be
 * linked (or already are) rather than newly created.
 */
export function resolveDirectoryIdentityMatch(
  account: DirectoryIdentityMatchAccount,
  existingLink: DirectoryIdentityExistingLink | null | undefined,
  maps: DirectoryIdentityMatchMaps,
): DirectoryIdentityMatchOutcome {
  if (existingLink && existingLink.link_status === 'linked' && existingLink.local_user_id) {
    return { matched: 'already_linked' }
  }

  const scopedOpenIdentityKey = buildScopedIdentityKey(account.corpId, account.openId)
  const scopedUnionIdentityKey = buildScopedIdentityKey(account.corpId, account.unionId)
  const externalIdentityUserId = maps.externalIdentityMap.get(account.externalKey)
    || (scopedOpenIdentityKey ? maps.scopedOpenIdentityMap.get(scopedOpenIdentityKey) : undefined)
    || (scopedUnionIdentityKey ? maps.scopedUnionIdentityMap.get(scopedUnionIdentityKey) : undefined)
  if (externalIdentityUserId) {
    return { matched: 'external_identity', localUserId: externalIdentityUserId }
  }

  const emailKey = normalizeText(account.email).toLowerCase()
  const mobileKey = normalizeMobileIdentifier(account.mobile)
  const emailUserId = emailKey ? maps.emailMap.get(emailKey) : undefined
  const mobileUserId = mobileKey ? maps.mobileMap.get(mobileKey) : undefined
  const hasAmbiguousIdentifierMatch = (emailKey.length > 0 && maps.ambiguousEmailKeys.has(emailKey))
    || (mobileKey.length > 0 && maps.ambiguousMobileKeys.has(mobileKey))

  if (emailUserId) return { matched: 'email', localUserId: emailUserId }
  if (mobileUserId) return { matched: 'mobile', localUserId: mobileUserId }
  if (hasAmbiguousIdentifierMatch) return { matched: 'ambiguous' }
  return { matched: 'none' }
}

/**
 * DT-OPS-01 — offboarding policy executor.
 *
 * `directory_integrations.default_deprovision_policy` and
 * `directory_accounts.deprovision_policy_override` have been stored since the schema was
 * created and never enforced. Removing a member from DingTalk marked the shadow account
 * inactive and dropped it into the admin review queue, but their LOCAL account stayed
 * active: password login kept working, and `unbind` only cleared the identity.
 *
 * Two hazards shape this design:
 *  1. the column's DB default is already `mark_inactive`, so simply honouring the stored
 *     value would silently start deactivating users on the very next sync of every
 *     existing integration;
 *  2. deactivating the wrong person locks a real employee out.
 *
 * So the executor is env-gated (`DIRECTORY_DEPROVISION_ENABLED`, default off). With it
 * off — the shipped default — nothing is written and the run reports exactly what it
 * WOULD have done, giving an operator the preview the roadmap asks for before enabling.
 */
export type DirectoryDeprovisionPolicy = 'manual_review' | 'disable_grant_only' | 'mark_inactive'

export const DIRECTORY_DEPROVISION_POLICIES: readonly DirectoryDeprovisionPolicy[] = [
  'manual_review',
  'disable_grant_only',
  'mark_inactive',
]

export function isDirectoryDeprovisionEnabled(): boolean {
  return ['true', '1', 'yes'].includes(
    String(process.env.DIRECTORY_DEPROVISION_ENABLED ?? '').trim().toLowerCase(),
  )
}

/**
 * An unrecognised stored value must never be interpreted as "do something destructive".
 * Anything we do not understand degrades to review-only.
 */
export function resolveDirectoryDeprovisionPolicy(
  integrationDefault: string | null | undefined,
  accountOverride: string | null | undefined,
): DirectoryDeprovisionPolicy {
  const candidate = normalizeText(accountOverride) || normalizeText(integrationDefault)
  return (DIRECTORY_DEPROVISION_POLICIES as readonly string[]).includes(candidate)
    ? (candidate as DirectoryDeprovisionPolicy)
    : 'manual_review'
}

export type DirectoryDeprovisionOutcome = {
  applied: boolean
  /** Number of PEOPLE, not accounts — a user reached through two departed accounts counts once. */
  candidateCount: number
  manualReviewCount: number
  grantsDisabledCount: number
  usersDeactivatedCount: number
  /** Set when the circuit breaker refused to act; `applied` is forced false. */
  abortedReason: DirectoryDeprovisionAbortReason | null
  affected: Array<{
    directoryAccountId: string
    localUserId: string
    policy: DirectoryDeprovisionPolicy
  }>
}

type DeprovisionCandidateRow = {
  directory_account_id: string
  local_user_id: string
  deprovision_policy_override: string | null
}

/**
 * Least-destructive wins. A user reached through several departed accounts is deprovisioned
 * by the *safest* policy any of them names: if one binding says review-only, a human looks.
 */
const DEPROVISION_POLICY_SEVERITY: Record<DirectoryDeprovisionPolicy, number> = {
  manual_review: 0,
  disable_grant_only: 1,
  mark_inactive: 2,
}

/**
 * DT-OPS-01 circuit breaker. "Absent from the fetch" is NOT the same as "departed": a blank
 * `name` is silently dropped by the client, a missing `list` yields zero users with no error,
 * `contain_access_limit:false` hides restricted members (this repo already ships
 * `sampleRootDepartmentDiagnostics` precisely because that happens), and a narrowed
 * `rootDepartmentId` shrinks the whole tree. Before this executor existed,
 * `directory_accounts.is_active` was never load-bearing — now it decides whether a person
 * can log in, and there is no reactivation path in the product. So a suspicious fetch
 * refuses to deprovision anyone rather than trusting a flag that was never built for this.
 */
export const DIRECTORY_DEPROVISION_MAX_BATCH = (() => {
  const raw = Number(process.env.DIRECTORY_DEPROVISION_MAX_BATCH)
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 25
})()

export type DirectoryDeprovisionAbortReason = 'empty_directory_fetch' | 'batch_exceeds_max'

export function evaluateDirectoryDeprovisionCircuitBreaker(options: {
  syncedAccountCount: number
  candidateCount: number
  maxBatch?: number
}): DirectoryDeprovisionAbortReason | null {
  // Every account "vanished" — that is a broken fetch, not an evacuated company.
  if (options.syncedAccountCount === 0) return 'empty_directory_fetch'
  if (options.candidateCount > (options.maxBatch ?? DIRECTORY_DEPROVISION_MAX_BATCH)) return 'batch_exceeds_max'
  return null
}

export async function applyDirectoryDeprovisionPolicies(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  options: {
    integrationId: string
    /** Ids of the accounts this run *transitioned* to inactive. NOT the lifetime backlog. */
    deactivatedAccountIds: string[]
    /** How many accounts the DingTalk fetch actually returned — the circuit breaker's input. */
    syncedAccountCount: number
    integrationDefaultPolicy: string
    enabled: boolean
    maxBatch?: number
  },
): Promise<DirectoryDeprovisionOutcome> {
  const outcome: DirectoryDeprovisionOutcome = {
    applied: options.enabled,
    candidateCount: 0,
    manualReviewCount: 0,
    grantsDisabledCount: 0,
    usersDeactivatedCount: 0,
    abortedReason: null,
    affected: [],
  }

  if (options.deactivatedAccountIds.length === 0) return outcome

  // Accounts this run just deactivated, whose linked local user has NO other active linked
  // directory account ANYWHERE.
  //
  // The sibling guard is deliberately NOT scoped by integration_id, and that is the whole
  // point: `directory_account_links` is unique on directory_account_id only — local_user_id
  // carries a plain index — so N accounts map to 1 user. A rehire (the old account departs,
  // the new one links via the stable unionId) or a second integration would otherwise
  // deactivate a person who is actively employed, with no way to undo it.
  const candidates = await client.query(
    `SELECT a.id::text AS directory_account_id,
            l.local_user_id,
            a.deprovision_policy_override
       FROM directory_accounts a
       JOIN directory_account_links l
         ON l.directory_account_id = a.id
        AND l.link_status = 'linked'
        AND l.local_user_id IS NOT NULL
      WHERE a.id = ANY($1::uuid[])
        AND NOT EXISTS (
          SELECT 1
            FROM directory_account_links sibling_link
            JOIN directory_accounts sibling ON sibling.id = sibling_link.directory_account_id
           WHERE sibling_link.local_user_id = l.local_user_id
             AND sibling_link.link_status = 'linked'
             AND sibling.is_active = true
        )`,
    [options.deactivatedAccountIds],
  )

  // One decision per PERSON, not per account: a user reached through two departed accounts
  // must not be audited twice, nor deactivated under the harsher of two policies.
  const byUser = new Map<string, { directoryAccountId: string; policy: DirectoryDeprovisionPolicy }>()
  for (const row of candidates.rows as DeprovisionCandidateRow[]) {
    const policy = resolveDirectoryDeprovisionPolicy(options.integrationDefaultPolicy, row.deprovision_policy_override)
    const existing = byUser.get(row.local_user_id)
    if (!existing || DEPROVISION_POLICY_SEVERITY[policy] < DEPROVISION_POLICY_SEVERITY[existing.policy]) {
      byUser.set(row.local_user_id, { directoryAccountId: row.directory_account_id, policy })
    }
  }

  outcome.candidateCount = byUser.size

  const abortReason = evaluateDirectoryDeprovisionCircuitBreaker({
    syncedAccountCount: options.syncedAccountCount,
    candidateCount: outcome.candidateCount,
    maxBatch: options.maxBatch,
  })
  if (abortReason) {
    outcome.abortedReason = abortReason
    outcome.applied = false
    logger.error(
      `Directory deprovision ABORTED for ${options.integrationId}: ${abortReason} `
      + `(${outcome.candidateCount} candidate(s), ${options.syncedAccountCount} account(s) fetched). `
      + 'Nothing was deprovisioned. Verify the DingTalk fetch (contact-scope, root department, access-limited members) before retrying.',
    )
    return outcome
  }

  for (const [localUserId, { directoryAccountId, policy }] of byUser) {
    if (policy === 'manual_review') {
      outcome.manualReviewCount += 1
      continue
    }

    outcome.affected.push({ directoryAccountId, localUserId, policy })

    outcome.grantsDisabledCount += 1
    if (options.enabled) {
      await client.query(
        `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
         VALUES ($1, $2, FALSE, $3, NOW(), NOW())
         ON CONFLICT (provider, local_user_id)
         DO UPDATE SET enabled = FALSE, updated_at = NOW()`,
        [DEFAULT_PROVIDER, localUserId, 'system:directory-deprovision'],
      )
    }

    if (policy === 'mark_inactive') {
      outcome.usersDeactivatedCount += 1
      if (options.enabled) {
        await client.query(
          `UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1::text`,
          [localUserId],
        )
      }
    }
  }

  if (!options.enabled && outcome.candidateCount > 0) {
    logger.info(
      `Directory deprovision preview for ${options.integrationId}: ${outcome.candidateCount} person(s) — `
      + `${outcome.grantsDisabledCount} grant(s) and ${outcome.usersDeactivatedCount} local user(s) would be disabled. `
      + `Affected: ${outcome.affected.map((a) => a.localUserId).join(', ') || '(none)'}. `
      + 'Set DIRECTORY_DEPROVISION_ENABLED=true to apply.',
    )
  }

  return outcome
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
  const rawWorkNotificationAgentId = normalizeText(config.workNotificationAgentId ?? config.agentId)
  const workNotificationAgentId = rawWorkNotificationAgentId
    ? decryptStoredSecretValue(rawWorkNotificationAgentId)
    : ''
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
    workNotificationAgentId,
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
  // Approval-card keys are presence-only in summaries (secret never decrypted here).
  const rawConfig = parseJsonRecord(row.config)
  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    name: row.name,
    status: row.status,
    corpId: row.corp_id,
    syncEnabled: Boolean(row.sync_enabled),
    scheduleCron: row.schedule_cron,
    scheduleTimezone: row.schedule_timezone,
    defaultDeprovisionPolicy: row.default_deprovision_policy,
    lastSyncAt: row.last_sync_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config: {
      appKey: config.appKey,
      appSecretConfigured: Boolean(config.appSecret),
      workNotificationAgentIdConfigured: Boolean(config.workNotificationAgentId),
      approvalCardLinkSecretConfigured: Boolean(normalizeText(rawConfig.approvalCardLinkSecret)),
      approvalCardPublicAppUrl: normalizeText(rawConfig.approvalCardPublicAppUrl) || null,
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

function summarizeDirectoryDepartment(row: DirectoryDepartmentSummaryRow): DirectoryDepartmentSummary {
  return {
    id: row.directory_department_id,
    integrationId: row.integration_id,
    provider: row.provider,
    externalDepartmentId: row.external_department_id,
    parentExternalDepartmentId: row.external_parent_department_id,
    name: row.name,
    fullPath: row.full_path,
    orderIndex: Number(row.order_index ?? 0),
    isActive: Boolean(row.is_active),
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
    accountCount: Number(row.account_count ?? 0),
    linkedAccountCount: Number(row.linked_account_count ?? 0),
    childCount: Number(row.child_count ?? 0),
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

function assertDirectoryAccountCanEnableDingTalkGrant(
  account: Pick<DirectoryBindingTargetAccountRow, 'corp_id' | 'open_id'>,
  enableDingTalkGrant: boolean,
): void {
  if (!enableDingTalkGrant) return
  if (!normalizeText(account.corp_id)) return
  if (normalizeText(account.open_id)) return
  throw new Error(DINGTALK_OPEN_ID_REQUIRED_FOR_GRANT_ERROR)
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
  const workNotificationAgentId = current?.workNotificationAgentId || ''
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
    workNotificationAgentId,
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
    // Roadmap §7.8: this naive normalize (no absent-vs-present distinction) is what
    // `createDirectoryIntegration` uses as-is — there is no prior row to preserve on
    // create. `updateDirectoryIntegration` OVERRIDES this field after calling this
    // function (see the absent-vs-present comment there) because there is no FE field for
    // it yet: unlike `scheduleCron`, which the FE form always resends verbatim on every
    // save, an FE-driven PUT would omit `scheduleTimezone` entirely and — with only this
    // naive normalize — would silently reset any directly-API-configured zone back to
    // UTC on the next unrelated edit.
    scheduleTimezone: normalizeOptionalText(input.scheduleTimezone),
    defaultDeprovisionPolicy,
    status,
  }
}

async function getIntegrationRow(integrationId: string): Promise<DirectoryIntegrationRow | null> {
  const result = await query<DirectoryIntegrationRow>(
    `SELECT id, org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron, schedule_timezone,
            default_deprovision_policy, last_sync_at, last_success_at, last_error, created_at, updated_at
     FROM directory_integrations
     WHERE id = $1 AND provider = $2`,
    [integrationId, DEFAULT_PROVIDER],
  )
  return result.rows[0] ?? null
}

export async function listDirectoryIntegrations(orgId = DEFAULT_ORG_ID): Promise<DirectoryIntegrationSummary[]> {
  const result = await query<DirectoryIntegrationRow>(
    `SELECT i.id, i.org_id, i.provider, i.name, i.status, i.corp_id, i.config, i.sync_enabled, i.schedule_cron, i.schedule_timezone,
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
       org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron, schedule_timezone,
       default_deprovision_policy, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, NOW(), NOW())
     RETURNING id, org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron, schedule_timezone,
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
        workNotificationAgentId: normalized.workNotificationAgentId
          ? normalizeStoredSecretValue(normalized.workNotificationAgentId)
          : null,
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
      normalized.scheduleTimezone,
      normalized.defaultDeprovisionPolicy,
    ],
  )

  return summarizeIntegration(result.rows[0])
}

/**
 * Thrown by `updateDirectoryIntegration` when a generic integration-form save tries to swap
 * `corp_id` on an integration that already has synced accounts — see the guard's comment there
 * (org-transfer Phase 1 §12.1) for why this is blocked.
 */
export class DirectoryTenantChangeBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectoryTenantChangeBlockedError'
  }
}

export async function updateDirectoryIntegration(
  integrationId: string,
  input: DirectoryIntegrationInput,
): Promise<DirectoryIntegrationSummary | null> {
  const current = await getIntegrationRow(integrationId)
  if (!current) return null

  const currentConfig = parseIntegrationConfig(current)
  const normalized = normalizeIntegrationInput(input, currentConfig)

  // org-transfer Phase 1 §12.1 — corp_id is IMMUTABLE once set (no probe, no bypass).
  //
  // `corp_id` identifies WHICH DingTalk tenant this integration syncs against. Changing it via this
  // generic integration-form save is a tenant swap disguised as an edit: the next sync's absence sweep
  // only "sees" accounts/departments returned by the NEW corp's DingTalk API and marks every row still
  // tagged with the OLD corp inactive — silently mass-deactivating the previous organization.
  //
  // A "block only if it already has synced records" rule is NOT sufficient: `syncDirectoryIntegration`
  // reads the corp config, then claims the run lease, then pulls and writes rows. During the FIRST sync
  // (corp_id already set, no account/department rows written yet) an interleaved PUT could change corp_id
  // from under the in-flight sync — which then writes the OLD corp's data into the now-retagged
  // integration, re-arming the exact mass-deactivation on the following sync. There is no safe TOCTOU
  // window, so the rule is absolute and race-free: once `corp_id` is set, an ordinary PUT can NEVER
  // change it. A mis-entered corp_id (before first sync) is corrected by deleting and recreating the
  // integration; a genuine organization change must go through the org-transfer workflow. There is
  // deliberately NO production escape hatch.
  //
  // Initial set (current empty → a value) and same-corp resend pass through. `normalized.corpId` cannot
  // be empty here — normalizeIntegrationInput throws 'corpId is required' earlier — so a "clear" is
  // already unreachable.
  const currentCorpId = normalizeText(current.corp_id)
  if (currentCorpId !== '' && normalized.corpId !== currentCorpId) {
    throw new DirectoryTenantChangeBlockedError(
      `corp_id is immutable once set on directory integration ${integrationId} (currently "${currentCorpId}", attempted "${normalized.corpId}"): changing it via a generic integration edit would make the next sync mass-deactivate the previous organization's accounts and departments. To correct a mis-entered corp_id before the first sync, delete and recreate the integration; to move to a different organization, use the org-transfer workflow.`,
    )
  }

  await assertDirectoryProjectedGovernanceConfigValid({
    memberGroupDefaultRoleIds: normalized.memberGroupDefaultRoleIds,
    memberGroupDefaultNamespaces: normalized.memberGroupDefaultNamespaces,
  })
  // Carry-through for keys NOT edited by this generic form (approval-card config lives in the
  // same JSONB but is written only via its dedicated admin endpoints): the rebuild below would
  // otherwise silently wipe them on every integration-form save. The encrypted secret is carried
  // as-is — never decrypted here.
  const rawCurrentConfig = parseJsonRecord(current.config)
  const carriedApprovalCardLinkSecret = normalizeText(rawCurrentConfig.approvalCardLinkSecret) || null
  const carriedApprovalCardPublicAppUrl = normalizeText(rawCurrentConfig.approvalCardPublicAppUrl) || null
  // Roadmap §7.8: unlike `scheduleCron` (the existing FE form always resends it verbatim, so
  // a plain "always overwrite from input" is safe), there is no FE field for `scheduleTimezone`
  // yet. An absent key (the FE's payload shape today) must PRESERVE whatever is already saved,
  // not reset it to UTC on the next unrelated edit; an explicitly present key (including `''`)
  // still overwrites, so a direct API caller can still clear it back to the default.
  const scheduleTimezone = input.scheduleTimezone !== undefined
    ? normalizeOptionalText(input.scheduleTimezone)
    : current.schedule_timezone
  const result = await query<DirectoryIntegrationRow>(
    `UPDATE directory_integrations
     SET name = $2,
         status = $3,
         corp_id = $4,
         config = $5::jsonb,
         sync_enabled = $6,
         schedule_cron = $7,
         schedule_timezone = $8,
         default_deprovision_policy = $9,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron, schedule_timezone,
               default_deprovision_policy, last_sync_at, last_success_at, last_error, created_at, updated_at`,
    [
      integrationId,
      normalized.name,
      normalized.status,
      normalized.corpId,
      JSON.stringify({
        appKey: normalized.appKey,
        appSecret: normalizeStoredSecretValue(normalized.appSecret),
        workNotificationAgentId: normalized.workNotificationAgentId
          ? normalizeStoredSecretValue(normalized.workNotificationAgentId)
          : null,
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
        approvalCardLinkSecret: carriedApprovalCardLinkSecret,
        approvalCardPublicAppUrl: carriedApprovalCardPublicAppUrl,
      }),
      Boolean(normalized.syncEnabled),
      normalized.scheduleCron,
      scheduleTimezone,
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

export function buildDirectoryIntegrationDiagnosticSummary(result: {
  departmentSampleCount: number
  rootDepartmentDirectUserCount: number
  rootDepartmentDirectUserHasMore: boolean
}): DirectoryIntegrationDiagnosticSummary {
  const hasNoChildDepartments = result.departmentSampleCount === 0
  const hasSuspiciouslySparseRootMembers =
    result.rootDepartmentDirectUserCount <= 1 && !result.rootDepartmentDirectUserHasMore

  if (hasNoChildDepartments && hasSuspiciouslySparseRootMembers) {
    return {
      code: 'scope_or_root_misconfigured',
      title: '通讯录范围或根部门疑似配置不当',
      nextAction: '请检查应用「通讯录管理」权限范围是否覆盖全员，并确认根部门 ID 是否正确。',
    }
  }

  if (hasNoChildDepartments) {
    return {
      code: 'no_child_departments',
      title: '根部门未返回子部门',
      nextAction: '如企业通讯录确有部门层级，请检查应用通讯录可见范围配置。',
    }
  }

  return {
    code: 'healthy',
    title: '通讯录连通正常',
    nextAction: '通讯录范围正常，可执行目录同步。',
  }
}

export type DirectoryRootDepartmentDiagnosticSample = {
  rootDepartmentChildCount: number
  rootDepartmentDirectUserCount: number
  rootDepartmentDirectUserHasMore: boolean
  rootDepartmentDirectUserCountWithAccessLimit: number
  rootDepartmentDirectUserHasMoreWithAccessLimit: boolean
  sampledRootDepartmentUsers: Array<{ userId: string; name: string }>
  sampledRootDepartmentUsersWithAccessLimit: Array<{ userId: string; name: string }>
  summary: DirectoryIntegrationDiagnosticSummary
  warnings: string[]
}

export async function sampleRootDepartmentDiagnostics(
  config: DirectoryIntegrationConfig,
): Promise<DirectoryRootDepartmentDiagnosticSample> {
  const accessToken = await fetchDingTalkAppAccessToken({
    appKey: config.appKey,
    appSecret: config.appSecret,
    baseUrl: config.baseUrl,
  })
  const departments = await listDingTalkDepartments(accessToken, config.rootDepartmentId, {
    baseUrl: config.baseUrl,
  })
  const rootUsers = await listDingTalkDepartmentUsers(
    accessToken,
    config.rootDepartmentId,
    0,
    Math.min(config.pageSize ?? DEFAULT_PAGE_SIZE, 100),
    { baseUrl: config.baseUrl },
  )
  const rootUsersWithAccessLimit = await listDingTalkDepartmentUsers(
    accessToken,
    config.rootDepartmentId,
    0,
    Math.min(config.pageSize ?? DEFAULT_PAGE_SIZE, 100),
    { baseUrl: config.baseUrl, containAccessLimit: true },
  )

  const rootDepartmentChildCount = departments.length
  const rootDepartmentDirectUserCount = rootUsers.users.length
  const rootDepartmentDirectUserHasMore = rootUsers.hasMore
  const rootDepartmentDirectUserCountWithAccessLimit = rootUsersWithAccessLimit.users.length
  const rootDepartmentDirectUserHasMoreWithAccessLimit = rootUsersWithAccessLimit.hasMore

  const warnings = buildDirectoryIntegrationTestWarnings({
    rootDepartmentId: config.rootDepartmentId,
    departmentSampleCount: rootDepartmentChildCount,
    rootDepartmentDirectUserCount,
    rootDepartmentDirectUserHasMore,
    rootDepartmentDirectUserCountWithAccessLimit,
    rootDepartmentDirectUserHasMoreWithAccessLimit,
  })
  const summary = buildDirectoryIntegrationDiagnosticSummary({
    departmentSampleCount: rootDepartmentChildCount,
    rootDepartmentDirectUserCount,
    rootDepartmentDirectUserHasMore,
  })

  return {
    rootDepartmentChildCount,
    rootDepartmentDirectUserCount,
    rootDepartmentDirectUserHasMore,
    rootDepartmentDirectUserCountWithAccessLimit,
    rootDepartmentDirectUserHasMoreWithAccessLimit,
    sampledRootDepartmentUsers: rootUsers.users.slice(0, 10).map((user) => ({ userId: user.userId, name: user.name })),
    sampledRootDepartmentUsersWithAccessLimit: rootUsersWithAccessLimit.users
      .slice(0, 10)
      .map((user) => ({ userId: user.userId, name: user.name })),
    summary,
    warnings,
  }
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
    summary: buildDirectoryIntegrationDiagnosticSummary({
      departmentSampleCount: departments.length,
      rootDepartmentDirectUserCount: diagnostics.rootDepartmentDirectUserCount,
      rootDepartmentDirectUserHasMore: diagnostics.rootDepartmentDirectUserHasMore,
    }),
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

export async function fetchAllDepartments(
  config: DirectoryIntegrationConfig,
  integrationName: string,
  // §7.7 telemetry: increment per external directory-pull call so the N+1 is ops-visible on
  // the run record. Optional — the preview path (no run row) omits it.
  apiCalls?: DirectorySyncApiCallCounters,
): Promise<Map<string, DingTalkDepartment>> {
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
    if (apiCalls) apiCalls.departmentListCalls += 1
    const children = await listDingTalkDepartments(accessToken, current, { baseUrl: config.baseUrl })
    for (const child of children) {
      const existing = departments.get(child.id)
      departments.set(child.id, existing ? { ...existing, ...child } : child)
      if (!existing) queue.push(child.id)
    }
  }

  // dept-head plumbing: enrich each department with its manager user ids from the
  // department-detail API (listsub does not return them). Best-effort + sequential
  // (concurrency=1; explicit min-interval throttle deferred — no real rate limiter
  // yet): a per-dept failure leaves managerUserIds undefined so the upsert carries
  // the prior dept_manager_userid_list forward instead of wiping it.
  await enrichDepartmentsWithManagers(
    departments.values(),
    (deptId) => {
      if (apiCalls) apiCalls.departmentDetailCalls += 1
      return getDingTalkDepartmentDetail(accessToken, deptId, { baseUrl: config.baseUrl })
    },
    (deptId, error) =>
      logger.warn(
        `dept-head: department/get failed for dept ${deptId} (integration ${integrationName}); carrying prior forward: ${readErrorMessage(error, 'unknown error')}`,
      ),
  )

  return departments
}

function mergeDepartmentIds(primary: string[], secondary: string[]): string[] {
  return Array.from(new Set([...primary, ...secondary].filter(Boolean)))
}

export async function fetchAllUsers(
  config: DirectoryIntegrationConfig,
  departmentMap: Map<string, DingTalkDepartment>,
  // §7.7 telemetry: `userDetailCalls` is THE N+1 metric — one `user/get` per unique user.
  // Optional — the preview path (no run row) omits it.
  apiCalls?: DirectorySyncApiCallCounters,
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
      if (apiCalls) apiCalls.userListPageCalls += 1
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
          // The N+1: a per-user detail fetch, issued once per UNIQUE user (this branch only
          // runs on first sight — a user in two departments is fetched once).
          if (apiCalls) apiCalls.userDetailCalls += 1
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

async function readIntegrationNameForAlert(integrationId: string): Promise<string> {
  try {
    const result = await query<{ name: string }>(
      `SELECT name FROM directory_integrations WHERE id = $1`,
      [integrationId],
    )
    return result.rows[0]?.name || integrationId
  } catch {
    return integrationId
  }
}

async function markSyncFailure(integrationId: string, runId: string, message: string): Promise<void> {
  // DT-HARDEN-05: one transaction, run-row (lease release) first. As two bare
  // statements, a crash between them left the lease held until it went stale while
  // the integration already recorded the failure. No status guard on the run row on
  // purpose: if the lease was reclaimed while this run was alive, overwriting the
  // reclaimer's generic orphaned message with the real failure (e.g. the lease-lost
  // rollback) is the more truthful record — and the row is already 'failed', so no
  // state regresses.
  await transaction(async (client) => {
    await client.query(
      `UPDATE directory_sync_runs
       SET status = 'failed',
           finished_at = NOW(),
           error_message = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [runId, message],
    )
    await client.query(
      `UPDATE directory_integrations
       SET last_sync_at = NOW(),
           last_error = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [integrationId, message],
    )
  })
  try {
    await query(
      `INSERT INTO directory_sync_alerts (integration_id, run_id, level, code, message, details, created_at, updated_at)
       VALUES ($1, $2, 'error', 'sync_failed', $3, '{}'::jsonb, NOW(), NOW())`,
      [integrationId, runId, message],
    )
  } catch (error) {
    logger.warn(`Failed to persist directory alert: ${readErrorMessage(error, 'unknown error')}`)
  }

  // DT-OPS-03: the alert row is useless if nobody opens the table. Deliver it over the
  // channel the product already owns. Best-effort by construction — a failed sync must
  // never be made worse by a failed webhook.
  const integrationName = await readIntegrationNameForAlert(integrationId)
  await deliverDirectorySyncFailureAlert({ integrationId, integrationName, runId, message })
}

export function buildUniqueLocalUserMatchMap(
  rows: LocalUserRow[],
  readKey: (row: LocalUserRow) => string,
): { uniqueMap: Map<string, string>; ambiguousKeys: Set<string> } {
  const idsByKey = new Map<string, Set<string>>()
  for (const row of rows) {
    const key = readKey(row)
    if (!key) continue
    const ids = idsByKey.get(key) ?? new Set<string>()
    ids.add(row.id)
    idsByKey.set(key, ids)
  }

  const uniqueMap = new Map<string, string>()
  const ambiguousKeys = new Set<string>()
  for (const [key, ids] of idsByKey.entries()) {
    if (ids.size === 1) {
      uniqueMap.set(key, Array.from(ids)[0])
    } else {
      ambiguousKeys.add(key)
    }
  }
  return { uniqueMap, ambiguousKeys }
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
      .map((account) => normalizeMobileIdentifier(account.mobile))
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
         WHERE regexp_replace(mobile, '\\s+', '', 'g') = ANY($1::text[])`,
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

  const emailMatches = buildUniqueLocalUserMatchMap(
    emailUsers.rows,
    (row) => normalizeText(row.email).toLowerCase(),
  )
  const mobileMatches = buildUniqueLocalUserMatchMap(
    mobileUsers.rows,
    (row) => normalizeMobileIdentifier(row.mobile),
  )

  return {
    externalIdentityMap: new Map(externalIdentities.rows.map((row) => [row.external_key, row.local_user_id])),
    scopedUnionIdentityMap,
    scopedOpenIdentityMap,
    emailMap: emailMatches.uniqueMap,
    mobileMap: mobileMatches.uniqueMap,
    ambiguousEmailKeys: emailMatches.ambiguousKeys,
    ambiguousMobileKeys: mobileMatches.ambiguousKeys,
  }
}

/**
 * DT-HARDEN-05 — how often a running sync proves it is alive by touching
 * `last_heartbeat_at` on its run row. Env-tunable; any value that is not a finite
 * number of at least 5000ms is IGNORED and the 60-second default applies (a sub-5s
 * request is not floored up to 5s — it falls back entirely), so a misconfiguration
 * cannot hammer the pool.
 */
export const DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS = (() => {
  const raw = Number(process.env.DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS)
  return Number.isFinite(raw) && raw >= 5_000 ? Math.trunc(raw) : 60_000
})()

/**
 * DT-HARDEN-05 — how long a `running` run may go without a heartbeat before another
 * caller may assume its owner died and reclaim the lease. This keys off liveness
 * (`last_heartbeat_at`, falling back to `started_at` for a run that died before its
 * first beat), NOT total run age — a live large-tenant sync beats indefinitely and is
 * never reclaimed, while a crashed one is reclaimed within minutes instead of hours.
 * Clamped to at least 5x the heartbeat interval so a GC pause or one slow beat write
 * cannot cause a false reclaim in a multi-replica deployment.
 */
export const DIRECTORY_SYNC_LEASE_STALE_MINUTES = (() => {
  const raw = Number(process.env.DIRECTORY_SYNC_LEASE_STALE_MINUTES)
  const requested = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 10
  const floorMinutes = Math.ceil((DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS * 5) / 60_000)
  return Math.max(requested, floorMinutes)
})()

/** Thrown when another sync already holds the lease for this integration. */
export class DirectorySyncInProgressError extends Error {
  readonly statusCode = 409
  readonly code = 'DIRECTORY_SYNC_IN_PROGRESS'
  readonly activeRunId: string | null

  constructor(activeRunId: string | null) {
    super(
      activeRunId
        ? `A directory sync is already running for this integration (run ${activeRunId})`
        : 'A directory sync is already running for this integration',
    )
    this.name = 'DirectorySyncInProgressError'
    this.activeRunId = activeRunId
  }
}

/**
 * Thrown when a run reaches its completion write only to find its row is no longer
 * `running` — the lease was reclaimed as stale while this process was still alive
 * (heartbeat starved: event-loop stall, saturated pool, network partition). Thrown
 * INSIDE the apply transaction so the zombie's writes roll back instead of racing
 * the new claimant's.
 */
export class DirectorySyncLeaseLostError extends Error {
  readonly code = 'DIRECTORY_SYNC_LEASE_LOST'

  constructor(runId: string) {
    super(
      `Directory sync run ${runId} lost its lease while still alive (reclaimed as stale by a newer trigger); its apply was rolled back`,
    )
    this.name = 'DirectorySyncLeaseLostError'
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

/**
 * Close out `running` rows whose owner is gone (crash, redeploy, killed pod). Without
 * this a single crash would wedge the integration behind a lease nobody holds.
 * Exported so the scheduler can sweep once at boot rather than waiting for the next
 * manual trigger to unstick it.
 */
export async function reclaimStaleDirectorySyncRuns(integrationId?: string): Promise<number> {
  const params: unknown[] = [DIRECTORY_SYNC_LEASE_STALE_MINUTES]
  let scope = ''
  if (integrationId && normalizeText(integrationId)) {
    params.push(normalizeText(integrationId))
    scope = ` AND integration_id = $${params.length}`
  }

  const result = await query<{ id: string }>(
    `UPDATE directory_sync_runs
        SET status = 'failed',
            finished_at = NOW(),
            error_message = COALESCE(error_message, 'orphaned: sync lease heartbeat went stale; owner presumed crashed'),
            updated_at = NOW()
      WHERE status = 'running'
        AND COALESCE(last_heartbeat_at, started_at) < NOW() - ($1::int * INTERVAL '1 minute')${scope}
      RETURNING id`,
    params,
  )
  if (result.rows.length > 0) {
    logger.warn(`Reclaimed ${result.rows.length} stale directory sync run(s)`)
  }
  return result.rows.length
}

async function findActiveDirectorySyncRunId(integrationId: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    `SELECT id
       FROM directory_sync_runs
      WHERE integration_id = $1 AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1`,
    [integrationId],
  )
  return result.rows[0]?.id ?? null
}

/**
 * Atomic lease claim: the partial unique index on (integration_id) WHERE status='running'
 * makes a concurrent second claim a unique violation, so exactly one caller proceeds.
 * A plain "SELECT then INSERT" check would race under READ COMMITTED.
 */
async function claimDirectorySyncRun(
  integrationId: string,
  triggeredBy: string,
  triggerSource: 'manual' | 'scheduler',
): Promise<{ rows: DirectoryRunRow[] }> {
  try {
    return await query<DirectoryRunRow>(
      `INSERT INTO directory_sync_runs (
         integration_id, status, started_at, stats, meta, triggered_by, trigger_source, created_at, updated_at
       )
       VALUES ($1, 'running', NOW(), '{}'::jsonb, '{}'::jsonb, $2, $3, NOW(), NOW())
       RETURNING id, integration_id, status, started_at, finished_at, stats, error_message, triggered_by, trigger_source, created_at, updated_at`,
      [integrationId, triggeredBy, triggerSource],
    )
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DirectorySyncInProgressError(await findActiveDirectorySyncRunId(integrationId))
    }
    throw error
  }
}

export async function syncDirectoryIntegration(
  integrationId: string,
  triggeredBy: string,
  triggerSource: 'manual' | 'scheduler' = 'manual',
  /**
   * DT-OPS-02: fired the moment the run row exists, before the DingTalk pull begins. A
   * caller that wants to answer 202 needs the runId, and only the runId, up front — it
   * cannot wait for a large-tenant walk to finish inside an HTTP request.
   */
  hooks: { onRunStarted?: (runId: string) => void } = {},
): Promise<{
  integration: DirectoryIntegrationSummary
  run: DirectorySyncRunSummary
  autoAdmissionOnboardingPackets: DirectoryAutoAdmissionOnboardingPacket[]
}> {
  const governedUserIds = new Set<string>()
  const integration = await getIntegrationRow(integrationId)
  if (!integration) throw new Error('Directory integration not found')

  const config = parseIntegrationConfig(integration)
  let deprovisionOutcome: DirectoryDeprovisionOutcome | null = null
  // DT-HARDEN-05: claim the run lease BEFORE the first DingTalk call. The API pull that
  // follows is the expensive, quota-consuming part; a transaction-scoped lock around the
  // later apply would not protect it. Expired leases are reclaimed first so a crashed
  // run cannot wedge an integration forever.
  await reclaimStaleDirectorySyncRuns(integrationId)
  const runResult = await claimDirectorySyncRun(integrationId, triggeredBy, triggerSource)
  const runId = runResult.rows[0].id
  // R5: wall-clock anchor for stats.durationMs. Measured app-side from the lease claim to
  // just before the completion UPDATE (stats is serialized inside the transaction), so it
  // is immune to app/DB clock skew that started_at/finished_at arithmetic would inherit.
  const runStartedAtMs = Date.now()
  hooks.onRunStarted?.(runId)

  // DT-HARDEN-05 heartbeat: prove this run is alive for as long as it holds the lease.
  // A timer (rather than beats threaded through fetchAllDepartments/fetchAllUsers) also
  // covers the long apply transaction, and keeps runId out of the fetch helpers' scope.
  // The `status = 'running'` predicate keeps a late beat from resurrecting a row the
  // reclaimer already flipped. unref'd so a beat never keeps the process alive.
  const heartbeat = setInterval(() => {
    query(
      `UPDATE directory_sync_runs
          SET last_heartbeat_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND status = 'running'`,
      [runId],
    ).catch((error) => {
      // Best-effort by design: a missed beat only matters if EVERY beat inside the
      // staleness window misses, and reclaim then treats the run as dead — safe, loud.
      logger.warn(`Directory sync heartbeat failed for run ${runId}: ${readErrorMessage(error, 'unknown error')}`)
    })
  }, DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS)
  heartbeat.unref?.()

  // §7.7 telemetry: one counter set per run, incremented at each external directory-pull call
  // site (departments + users) so the N+1 detail fan-out is measurable on the run record.
  const apiCallCounters = createDirectorySyncApiCallCounters()

  try {
    const departments = await fetchAllDepartments(config, integration.name, apiCallCounters)
    const departmentPathMap = buildDepartmentPathMap(departments)
    // dept-head plumbing: capture last-known-good dept_manager_userid_list BEFORE the
    // whole-column upsert (raw = EXCLUDED.raw) overwrites raw, so a failed department/get
    // (managerUserIds left undefined) carries the prior value forward instead of wiping it.
    const priorDeptManagers = await capturePriorDeptManagers(integrationId, query)
    const users = await fetchAllUsers(config, departments, apiCallCounters)

    let directoryDiagnosticStats: JsonRecord = {}
    if (triggerSource === 'manual') {
      try {
        const diagnosticSample = await sampleRootDepartmentDiagnostics(config)
        directoryDiagnosticStats = {
          rootDepartmentChildCount: diagnosticSample.rootDepartmentChildCount,
          rootDepartmentDirectUserCount: diagnosticSample.rootDepartmentDirectUserCount,
          rootDepartmentDirectUserHasMore: diagnosticSample.rootDepartmentDirectUserHasMore,
          rootDepartmentDirectUserCountWithAccessLimit: diagnosticSample.rootDepartmentDirectUserCountWithAccessLimit,
          rootDepartmentDirectUserHasMoreWithAccessLimit:
            diagnosticSample.rootDepartmentDirectUserHasMoreWithAccessLimit,
          diagnosticCode: diagnosticSample.summary.code,
          diagnosticTitle: diagnosticSample.summary.title,
          diagnosticNextAction: diagnosticSample.summary.nextAction,
          diagnosticWarnings: diagnosticSample.warnings,
          sampledRootDepartmentUsers: diagnosticSample.sampledRootDepartmentUsers,
          sampledRootDepartmentUsersWithAccessLimit: diagnosticSample.sampledRootDepartmentUsersWithAccessLimit,
        }
      } catch (error) {
        directoryDiagnosticStats = {}
        logger.warn(
          `Failed to sample directory diagnostics for integration ${integrationId}: ${readErrorMessage(error, 'unknown error')}`,
        )
      }
    }

    const syncTimestamp = new Date().toISOString()
    const autoAdmissionInvites: Array<{ userId: string; email: string; inviteToken: string }> = []
    const autoAdmissionOnboardingPackets: DirectoryAutoAdmissionOnboardingPacket[] = []

    await transaction(async (client) => {
      // R5: created-vs-updated split for the run summary. `departmentsSynced`/`accountsSynced`
      // conflate "0 new" and "500 new"; the discriminator is `(xmax = 0)` on the upserted row —
      // a freshly INSERTed tuple has xmax 0, an ON CONFLICT DO UPDATE tuple carries the updating
      // transaction's xid (pg-only repo, standard PostgreSQL trick). Read defensively
      // (`rows[0]?.created === true`) so a fake client answering empty rows in unit suites
      // falls into the "updated" bucket instead of throwing.
      let departmentsCreatedCount = 0
      let departmentsUpdatedCount = 0
      for (const department of departments.values()) {
        const departmentUpsert = await client.query(
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
             updated_at = NOW()
           RETURNING (xmax = 0) AS created`,
          [
            integrationId,
            DEFAULT_PROVIDER,
            department.id,
            department.parentId,
            department.name,
            departmentPathMap.get(department.id) ?? department.name,
            department.order,
            JSON.stringify(
              mergeDeptManagerIntoRaw(
                department.source,
                resolveManagerListForDept(department.managerUserIds, priorDeptManagers.get(department.id)),
              ),
            ),
            syncTimestamp,
          ],
        )
        if (departmentUpsert.rows[0]?.created === true) departmentsCreatedCount += 1
        else departmentsUpdatedCount += 1
      }

      let accountsCreatedCount = 0
      let accountsUpdatedCount = 0
      const userList = Array.from(users.values())
      for (const user of userList) {
        const externalKey = normalizeText(user.unionId || user.openId || user.userId)
        const accountUpsert = await client.query(
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
             updated_at = NOW()
           RETURNING (xmax = 0) AS created`,
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
        if (accountUpsert.rows[0]?.created === true) accountsCreatedCount += 1
        else accountsUpdatedCount += 1
      }

      // R5, mirroring the DT-OPS-01 account sweep below: `AND is_active = true` makes this a
      // TRANSITION (departments that departed in THIS run), not a re-stamp of every
      // long-gone department on every sync — without it the per-run count would report the
      // same departed department forever. The resulting state is identical for already-
      // inactive rows (nothing reads directory_departments.updated_at); only the honest
      // count is new.
      const deactivatedDepartmentsResult = await client.query(
        `UPDATE directory_departments
         SET is_active = false, updated_at = NOW()
         WHERE integration_id = $1 AND last_seen_at < $2 AND is_active = true
         RETURNING id`,
        [integrationId, syncTimestamp],
      )
      const departmentsDeactivatedCount = deactivatedDepartmentsResult.rows.length
      // DT-OPS-01: `AND is_active = true` makes this a TRANSITION, not a re-stamp of the
      // whole backlog. Without it the deprovision executor re-processed every account ever
      // deactivated on every sync — audit spam, and it would stomp a reactivation.
      // RETURNING gives the executor exactly the accounts that departed in THIS run.
      const deactivatedAccountsResult = await client.query(
        `UPDATE directory_accounts
         SET is_active = false, updated_at = NOW()
         WHERE integration_id = $1 AND last_seen_at < $2 AND is_active = true
         RETURNING id::text AS id`,
        [integrationId, syncTimestamp],
      )
      const deactivatedAccountIds = (deactivatedAccountsResult.rows as Array<{ id: string }>).map((row) => row.id)

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

      await upsertDirectoryAccountDepartments(client, {
        users: users.values(),
        accountIdMap,
        departmentIdMap,
      })

      const {
        externalIdentityMap,
        scopedUnionIdentityMap,
        scopedOpenIdentityMap,
        emailMap,
        mobileMap,
        ambiguousEmailKeys,
        ambiguousMobileKeys,
      } = await loadMatchMaps(
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
      let autoAdmittedNoEmailCount = 0
      let autoAdmittedWithoutGrantCount = 0
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

        const identityMatch = resolveDirectoryIdentityMatch(
          {
            corpId: account.corp_id,
            externalKey: account.external_key,
            unionId: account.union_id,
            openId: account.open_id,
            email: account.email,
            mobile: account.mobile,
          },
          existing,
          { externalIdentityMap, scopedUnionIdentityMap, scopedOpenIdentityMap, emailMap, mobileMap, ambiguousEmailKeys, ambiguousMobileKeys },
        )

        if (identityMatch.matched !== 'already_linked') {
          if (identityMatch.matched === 'external_identity') {
            localUserId = identityMatch.localUserId
            linkStatus = 'linked'
            matchStrategy = 'external_identity'
          } else if (identityMatch.matched === 'email') {
            localUserId = identityMatch.localUserId
            linkStatus = 'pending'
            matchStrategy = 'email'
          } else if (identityMatch.matched === 'mobile') {
            localUserId = identityMatch.localUserId
            linkStatus = 'pending'
            matchStrategy = 'mobile'
          } else if (identityMatch.matched === 'ambiguous') {
            localUserId = null
            linkStatus = 'unmatched'
            matchStrategy = 'none'
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

            if (autoAdmission.inScope && directoryUser) {
              try {
                const cleanName = sanitizeDirectoryAdmissionName(account.name)
                const cleanEmail = account.email ? sanitizeDirectoryAdmissionEmail(account.email) : null
                const generatedUsername = cleanEmail
                  ? null
                  : buildDirectoryAutoAdmissionUsername({
                      id: account.id,
                      external_user_id: account.external_user_id,
                      union_id: account.union_id,
                      open_id: account.open_id,
                    })
                const cleanMobile = sanitizeDirectoryAdmissionMobile(account.mobile)
                const generatedPassword = generateDirectoryAdmissionTemporaryPassword()
                const passwordHash = await bcrypt.hash(generatedPassword, getBcryptSaltRounds())
                // DT-HARDEN-02: mirror assertDirectoryAccountCanEnableDingTalkGrant's
                // condition instead of hardcoding grant=true. A corp-scoped account
                // (corp_id set) without an openId cannot use DingTalk login and would
                // make the downstream bind throw — previously that threw AFTER the
                // users row was inserted (swallowed catch → committed orphan). Now such
                // an account is admitted with the grant OFF (directory binding still
                // happens), and the assertion is enforced before INSERT (see
                // createDirectoryAdmittedUserInTransaction) so no orphan can be created.
                const canGrantDingTalkLogin = resolveDirectoryAutoAdmissionCanGrantDingTalkLogin(account)
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
                  username: generatedUsername,
                  mobile: cleanMobile,
                  passwordHash,
                  mustChangePassword: true,
                  enableDingTalkGrant: canGrantDingTalkLogin,
                })
                let inviteToken: string | null = null
                if (cleanEmail) {
                  inviteToken = issueInviteToken({
                    userId: created.userId,
                    email: cleanEmail,
                    presetId: null,
                  })
                  autoAdmissionInvites.push({
                    userId: created.userId,
                    email: cleanEmail,
                    inviteToken,
                  })
                } else {
                  autoAdmittedNoEmailCount += 1
                  autoAdmissionOnboardingPackets.push({
                    userId: created.userId,
                    name: cleanName,
                    email: cleanEmail,
                    username: generatedUsername,
                    mobile: cleanMobile,
                    temporaryPassword: generatedPassword,
                    onboarding: buildOnboardingPacket({
                      email: cleanEmail,
                      accountLabel: resolveDirectoryAdmissionAccountLabel({
                        email: cleanEmail,
                        username: generatedUsername,
                        mobile: cleanMobile,
                        userId: created.userId,
                      }),
                      temporaryPassword: generatedPassword,
                      preset: null,
                      inviteToken,
                    }),
                  })
                }
                localUserId = created.userId
                linkStatus = 'linked'
                matchStrategy = 'auto_admit'
                autoAdmittedCount += 1
                if (!canGrantDingTalkLogin) autoAdmittedWithoutGrantCount += 1
                if (cleanEmail) emailMap.set(cleanEmail.toLowerCase(), created.userId)
                if (cleanMobile) mobileMap.set(cleanMobile, created.userId)
                if (cleanEmail) ambiguousEmailKeys.delete(cleanEmail.toLowerCase())
                if (cleanMobile) ambiguousMobileKeys.delete(cleanMobile)
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

      // DT-OPS-01: run after the link loop so the linked/unmatched state is final.
      // Default-off: this only counts what it WOULD do unless explicitly enabled.
      deprovisionOutcome = await applyDirectoryDeprovisionPolicies(client, {
        integrationId,
        deactivatedAccountIds,
        // The circuit breaker's input: how many accounts DingTalk actually returned. Zero
        // means the fetch is broken, not that the company evacuated.
        syncedAccountCount: users.size,
        integrationDefaultPolicy: integration.default_deprovision_policy,
        enabled: isDirectoryDeprovisionEnabled(),
      })

      // R5: per-run manager-binding snapshot. The live GET /manager-coverage endpoint
      // (#3914) answers "what is coverage NOW"; persisting the same numbers here answers
      // "what did THIS run leave it at", so admins can see the trend across runs. Runs
      // through the transaction client on purpose: it must see this run's (uncommitted)
      // final link state, and `getDirectoryManagerBindingCoverage`'s queryFn is injectable
      // for exactly this. Placed after the link loop, member-group projection and
      // deprovision so it is the end-of-run snapshot.
      const managerBindingCoverage = await getDirectoryManagerBindingCoverage(
        integrationId,
        (sql, params) => client.query(sql, params),
      )

      const stats = {
        departmentsSynced: departments.size,
        accountsSynced: users.size,
        // §7.7 sync-performance telemetry — external directory-pull call counts for THIS run.
        // `externalUserDetailCalls` is the N+1: compare it against `accountsSynced` (≈ equal
        // means one `user/get` per account). Makes the eventual `user/list` staging fix
        // provable via before/after on this number. Additive; all pre-existing keys kept.
        ...summarizeDirectorySyncApiCalls(apiCallCounters),
        // R5 per-run change summary — all additive; every pre-existing key above/below is kept.
        departmentsCreatedCount,
        departmentsUpdatedCount,
        departmentsDeactivatedCount,
        accountsCreatedCount,
        accountsUpdatedCount,
        accountsDeactivatedCount: deactivatedAccountIds.length,
        managerCount: managerBindingCoverage.managerCount,
        linkedManagerCount: managerBindingCoverage.linkedManagerCount,
        managerCoverage: managerBindingCoverage.coverage,
        durationMs: Date.now() - runStartedAtMs,
        deprovisionApplied: deprovisionOutcome.applied,
        deprovisionCandidateCount: deprovisionOutcome.candidateCount,
        deprovisionManualReviewCount: deprovisionOutcome.manualReviewCount,
        deprovisionGrantsDisabledCount: deprovisionOutcome.grantsDisabledCount,
        deprovisionUsersDeactivatedCount: deprovisionOutcome.usersDeactivatedCount,
        deprovisionAbortedReason: deprovisionOutcome.abortedReason,
        // Identities, not just a number: an operator deciding whether to flip
        // DIRECTORY_DEPROVISION_ENABLED needs to see WHO would lose access, and there is no
        // reactivation path if they guess wrong. Capped so a pathological run cannot bloat
        // the stats JSONB.
        deprovisionAffected: deprovisionOutcome.affected.slice(0, 100),
        deprovisionAffectedTruncated: deprovisionOutcome.affected.length > 100,
        linkedCount,
        pendingCount,
        unmatchedCount,
        autoAdmissionCandidateCount,
        autoAdmittedCount,
        autoAdmittedNoEmailCount,
        autoAdmittedWithoutGrantCount,
        autoAdmissionSkippedMissingEmailCount,
        autoAdmissionExcludedCount,
        autoAdmissionFailedCount,
        memberGroupsCreatedCount: memberGroupProjection.memberGroupsCreatedCount,
        memberGroupsSyncedCount: memberGroupProjection.memberGroupsSyncedCount,
        memberGroupMembershipsUpdatedCount: memberGroupProjection.memberGroupMembershipsUpdatedCount,
        memberGroupGovernedUserCount: memberGroupProjection.memberGroupGovernedUserCount,
        memberGroupDefaultRoleAssignmentsCount: memberGroupProjection.memberGroupDefaultRoleAssignmentsCount,
        memberGroupDefaultNamespaceAdmissionsCount: memberGroupProjection.memberGroupDefaultNamespaceAdmissionsCount,
        ...directoryDiagnosticStats,
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
      // The lease may have been reclaimed while this run was alive-but-silent (starved
      // heartbeat). Completing unconditionally would resurrect the reclaimed row AND
      // commit an apply that races the new claimant's — so the guard is on status, and
      // a miss aborts the whole transaction.
      const completion = await client.query(
        `UPDATE directory_sync_runs
         SET status = 'completed',
             finished_at = NOW(),
             stats = $2::jsonb,
             updated_at = NOW()
         WHERE id = $1
           AND status = 'running'
         RETURNING id`,
        [runId, JSON.stringify(stats)],
      )
      if (completion.rows.length === 0) {
        throw new DirectorySyncLeaseLostError(runId)
      }
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

    // DT-OPS-01: audit offboarding AFTER the transaction commits (mirrors the invite
    // ledger below) and only for effects that actually happened. A revoked grant or a
    // deactivated user must leave a trail — this is the access-closure record.
    if (deprovisionOutcome?.applied && deprovisionOutcome.affected.length > 0) {
      // Imported lazily on purpose. The audit stack binds a repository to the shared pg
      // pool when it loads, and directory-sync is imported by unit suites that mock
      // `db/pg` down to { query, transaction } — an eager import made them fail at module
      // load. That is a module-graph coupling, not a behavioural one, and the lazy form is
      // also the honest one: the audit stack is only needed once an offboarding took effect.
      const { auditLog } = await import('../audit/audit')

      for (const affected of deprovisionOutcome.affected) {
        // No try/catch: `auditLog` catches internally and never rejects (audit/audit.ts:22-40),
        // so a wrapper here would be dead code pretending to be a safety net. A lost audit
        // write surfaces as that module's own `warn`, which is the honest state of affairs.
        // The durable record of *who* triggered this lives in `meta.triggeredBy`, because
        // `audit.user_id` is numeric and our `users.id` is TEXT — an upstream limitation,
        // recorded here rather than papered over.
        await auditLog({
          actorId: triggeredBy,
          actorType: triggeredBy.startsWith('system:') ? 'system' : 'user',
          action: 'deprovision',
          resourceType: 'directory-account-link',
          resourceId: affected.directoryAccountId,
          meta: {
            integrationId,
            directoryAccountId: affected.directoryAccountId,
            localUserId: affected.localUserId,
            policy: affected.policy,
            grantDisabled: true,
            userDeactivated: affected.policy === 'mark_inactive',
            triggeredBy,
          },
        })
        // A deactivated or grant-revoked user must not keep cached permissions.
        invalidateUserPerms(affected.localUserId)
      }
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
      autoAdmissionOnboardingPackets,
    }
  } catch (error) {
    const message = readErrorMessage(error, 'Directory sync failed')
    await markSyncFailure(integrationId, runId, message)
    throw error
  } finally {
    clearInterval(heartbeat)
  }
}

/**
 * DT-OPS-02 — what a sync WOULD do, without doing it.
 *
 * Applying a sync is not a reversible act: `auto_for_scoped_departments` creates local
 * users on the spot, and the `last_seen_at` sweep deactivates directory accounts. There
 * was no way to look before leaping — the roadmap's "auto-admission can be safely reviewed
 * before apply".
 *
 * This pulls the DingTalk directory exactly as the sync does (so it consumes the same API
 * quota, and its numbers are the real ones) and then compares against the database
 * WITHOUT WRITING ANYTHING: no run row, no lease, no upsert, no user. `autoAdmissionCandidateCount`
 * walks the exact same `resolveDirectoryIdentityMatch` cascade apply uses (already-linked,
 * external-identity, unique-email, unique-mobile, ambiguous, THEN eligibility) instead of the
 * eligibility check alone, so preview no longer counts accounts that are already linked or
 * would merely be linked (not created).
 *
 * Same-batch duplicates: apply mutates its match maps as it auto-admits users within a
 * single run, so a second brand-new in-scope pulled account that shares an email/mobile/
 * external-identity with one already counted resolves matched:'email'/'mobile'/
 * 'external_identity' against the FIRST account's freshly-created user, not matched:'none'
 * again. Preview mirrors that below with a sentinel userId (`'preview-would-admit'`)
 * written into `identityMatchMaps` right after counting an in-scope candidate, using the
 * same normalizeText/normalizeMobileIdentifier keying `resolveDirectoryIdentityMatch`
 * itself uses — so the next iteration's cascade call sees exactly what apply's would see.
 *
 * Residual known gap (fail-safe, over-counts only): this cannot foresee an apply-side
 * creation FAILURE (e.g. `createDirectoryAdmittedUserInTransaction` throwing mid-run) —
 * apply's catch block skips its map mutation for a failed account, so a later same-batch
 * duplicate would still resolve against it as a candidate on the apply side too, while
 * preview (which cannot know a future apply run will fail) always mutates the maps. Preview
 * and apply only diverge here when apply itself fails partway through a run.
 */

/**
 * Placeholder written into `identityMatchMaps` in place of a real `created.userId` (preview
 * never creates anything). Only ever compared as a map VALUE by `matched-kind` branching —
 * never read back as a real user id or returned in any preview response field. Distinctive on
 * purpose so it is unmistakable in a debugger or log if that invariant is ever violated.
 */
const PREVIEW_ADMIT_SENTINEL_USER_ID = 'preview-would-admit'

export type DirectorySyncPreview = {
  integrationId: string
  integrationName: string
  departmentsSeen: number
  accountsSeen: number
  wouldCreateAccounts: number
  wouldDeactivateAccounts: number
  /** Deactivations that still hold a linked local user — the offboardings (see DT-OPS-01). */
  wouldDeactivateLinkedAccounts: number
  autoAdmissionMode: DirectoryAdmissionMode
  autoAdmissionCandidateCount: number
  autoAdmissionSkippedMissingEmailCount: number
  autoAdmissionExcludedCount: number
  sampledNewAccounts: Array<{ externalUserId: string; name: string }>
  sampledDeactivations: Array<{ externalUserId: string; name: string; linked: boolean }>
}

type ExistingAccountPreviewRow = {
  external_user_id: string
  name: string
  is_active: boolean
  linked: boolean
}

export async function previewDirectorySyncIntegration(integrationId: string): Promise<DirectorySyncPreview> {
  const integration = await getIntegrationRow(integrationId)
  if (!integration) throw new Error('Directory integration not found')

  // DT-OPS-02 / R3: refuse a preview while a real sync holds the lease for this
  // integration. Preview pulls the FULL DingTalk directory (same API quota `syncDirectoryIntegration`
  // consumes — see the doc-comment above) with no lease check at all; running one during an
  // in-flight sync doubles the shared quota consumption the lease exists to bound. This is a
  // READ-ONLY refusal: unlike apply, preview never calls `claimDirectorySyncRun` — it only asks
  // whether a run is currently `running` and, if so, declines before making any outbound call.
  const activeRunId = await findActiveDirectorySyncRunId(integrationId)
  if (activeRunId) throw new DirectorySyncInProgressError(activeRunId)

  const config = parseIntegrationConfig(integration)
  const departments = await fetchAllDepartments(config, integration.name)
  const users = await fetchAllUsers(config, departments)

  const existingResult = await query<ExistingAccountPreviewRow>(
    `SELECT a.external_user_id,
            a.name,
            a.is_active,
            (l.local_user_id IS NOT NULL AND l.link_status = 'linked') AS linked
       FROM directory_accounts a
       LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
      WHERE a.integration_id = $1`,
    [integrationId],
  )
  const existingByExternalId = new Map(existingResult.rows.map((row) => [row.external_user_id, row]))

  // Build the same match maps (external-identity / unique-email / unique-mobile / ambiguous)
  // `syncDirectoryIntegration` builds, from synthetic account rows shaped exactly like the
  // ones apply upserts (external_key = unionId||openId||userId, corp_id = integration.corp_id
  // — see apply lines ~2236/2262). `loadMatchMaps` only reads external_key/union_id/open_id/
  // email/mobile off each row, so the synthetic `id` is never consulted.
  const pulledAccountsForMatching = Array.from(users.values()).map((user) => ({
    id: user.userId,
    corp_id: integration.corp_id,
    external_user_id: user.userId,
    union_id: normalizeOptionalText(user.unionId),
    open_id: normalizeOptionalText(user.openId),
    external_key: normalizeText(user.unionId || user.openId || user.userId),
    name: user.name,
    email: normalizeOptionalText(user.email),
    mobile: normalizeOptionalText(user.mobile),
  }))
  const identityMatchMaps = await loadMatchMaps(pulledAccountsForMatching)

  const sampledNewAccounts: DirectorySyncPreview['sampledNewAccounts'] = []
  let wouldCreateAccounts = 0
  let autoAdmissionCandidateCount = 0
  let autoAdmissionSkippedMissingEmailCount = 0
  let autoAdmissionExcludedCount = 0

  for (const account of pulledAccountsForMatching) {
    const user = users.get(account.external_user_id)
    if (!user) continue

    if (!existingByExternalId.has(user.userId)) {
      wouldCreateAccounts += 1
      if (sampledNewAccounts.length < 10) sampledNewAccounts.push({ externalUserId: user.userId, name: user.name })
    }

    // Walk the exact cascade apply walks: only an account apply would reach the
    // auto-admission branch for ('none' matched — not already-linked, not identity/email/
    // mobile/ambiguous-matched) can possibly be an auto-admission candidate.
    const existingLink = existingByExternalId.get(user.userId)
    const identityMatch = resolveDirectoryIdentityMatch(
      {
        corpId: account.corp_id,
        externalKey: account.external_key,
        unionId: account.union_id,
        openId: account.open_id,
        email: account.email,
        mobile: account.mobile,
      },
      existingLink?.linked ? { local_user_id: 'linked', link_status: 'linked' } : null,
      identityMatchMaps,
    )
    if (identityMatch.matched !== 'none') continue

    const eligibility = evaluateDirectoryAutoAdmissionEligibility({
      admissionMode: config.admissionMode,
      admissionDepartmentIds: config.admissionDepartmentIds,
      excludeDepartmentIds: config.excludeDepartmentIds,
      userDepartmentIds: user.departmentIds,
      departments,
      email: account.email,
    })
    if (eligibility.excluded) autoAdmissionExcludedCount += 1
    // Mirror apply exactly: missingEmail only means "skipped" in the branch apply does NOT
    // create a user (apply creates a user for an in-scope account regardless of missing
    // email — it falls back to a generated username). Counting it whenever `missingEmail`
    // is true (independent of inScope) would over-count vs. apply here too.
    if (eligibility.inScope) {
      autoAdmissionCandidateCount += 1
      // Same-batch duplicate fix: mirror apply's post-admit map mutations (see the
      // `emailMap.set` / `mobileMap.set` / ambiguous-key deletes / identity-map sets right
      // after `createDirectoryAdmittedUserInTransaction` succeeds, above) onto
      // `identityMatchMaps` with a sentinel userId instead of a real one — preview writes
      // nothing, so there is no real created.userId to use, only a placeholder that proves
      // "an account was admitted here" to the next iteration's `resolveDirectoryIdentityMatch`
      // call. Keyed with the SAME normalizeText/normalizeMobileIdentifier helpers
      // `resolveDirectoryIdentityMatch` uses internally (lines ~1129-1130 above), so a later
      // pulled account in this same pull that shares this one's email/mobile/external-identity
      // resolves matched:'email'/'mobile'/'external_identity' against it — exactly as it would
      // resolve against the real user apply creates for this account — instead of independently
      // resolving matched:'none' and being double-counted.
      const emailKey = normalizeText(account.email).toLowerCase()
      const mobileKey = normalizeMobileIdentifier(account.mobile)
      if (emailKey) {
        identityMatchMaps.emailMap.set(emailKey, PREVIEW_ADMIT_SENTINEL_USER_ID)
        identityMatchMaps.ambiguousEmailKeys.delete(emailKey)
      }
      if (mobileKey) {
        identityMatchMaps.mobileMap.set(mobileKey, PREVIEW_ADMIT_SENTINEL_USER_ID)
        identityMatchMaps.ambiguousMobileKeys.delete(mobileKey)
      }
      identityMatchMaps.externalIdentityMap.set(account.external_key, PREVIEW_ADMIT_SENTINEL_USER_ID)
      const scopedOpenIdentityKey = buildScopedIdentityKey(account.corp_id, account.open_id)
      if (scopedOpenIdentityKey) identityMatchMaps.scopedOpenIdentityMap.set(scopedOpenIdentityKey, PREVIEW_ADMIT_SENTINEL_USER_ID)
      const scopedUnionIdentityKey = buildScopedIdentityKey(account.corp_id, account.union_id)
      if (scopedUnionIdentityKey) identityMatchMaps.scopedUnionIdentityMap.set(scopedUnionIdentityKey, PREVIEW_ADMIT_SENTINEL_USER_ID)
    } else if (eligibility.missingEmail) {
      autoAdmissionSkippedMissingEmailCount += 1
    }
  }

  const sampledDeactivations: DirectorySyncPreview['sampledDeactivations'] = []
  let wouldDeactivateAccounts = 0
  let wouldDeactivateLinkedAccounts = 0

  for (const row of existingResult.rows) {
    // Already inactive rows are not a *change*; only a live account vanishing is.
    if (!row.is_active || users.has(row.external_user_id)) continue
    wouldDeactivateAccounts += 1
    if (row.linked) wouldDeactivateLinkedAccounts += 1
    if (sampledDeactivations.length < 10) {
      sampledDeactivations.push({ externalUserId: row.external_user_id, name: row.name, linked: Boolean(row.linked) })
    }
  }

  return {
    integrationId,
    integrationName: integration.name,
    departmentsSeen: departments.size,
    accountsSeen: users.size,
    wouldCreateAccounts,
    wouldDeactivateAccounts,
    wouldDeactivateLinkedAccounts,
    autoAdmissionMode: config.admissionMode,
    autoAdmissionCandidateCount,
    autoAdmissionSkippedMissingEmailCount,
    autoAdmissionExcludedCount,
    sampledNewAccounts,
    sampledDeactivations,
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
    // Roadmap §7.8: report the next-run estimate in the integration's OWN configured
    // timezone (defaults to 'UTC' — byte-identical to the pre-§7.8 hardcoded literal for
    // every integration that has never set one), so this observation never disagrees with
    // what the scheduler actually runs (`directory-sync-scheduler.ts` resolves the same way).
    const parser = new SimpleCronExpression(cronExpression, resolveDirectoryScheduleTimezone(integration.schedule_timezone))
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
    scheduleTimezone: integration.schedule_timezone,
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

/**
 * DT-HARDEN-04: batch bind/unbind commit one account per transaction. A fail-fast loop
 * threw on the first bad item, so the caller never learned which items had already
 * COMMITTED — and the route, which wrote its audit entries only after the whole batch
 * returned, silently dropped the audit trail for every one of them. Compliance gap.
 *
 * Each item is now isolated: a failure is a per-item outcome, never a lost success.
 * Partial failure is a normal batch result, so callers can audit every success and
 * report exactly which items failed and why.
 */
export type DirectoryAccountBatchOutcome = {
  succeeded: DirectoryAccountMutationResult[]
  failed: Array<{ accountId: string; error: string }>
}

export async function batchUnbindDirectoryAccounts(
  directoryAccountIds: string[],
  input: DirectoryAccountUnbindInput,
): Promise<DirectoryAccountBatchOutcome> {
  const normalizedIds = Array.from(new Set(directoryAccountIds.map((item) => normalizeText(item)).filter(Boolean)))
  if (normalizedIds.length === 0) throw new Error('accountIds are required')

  const outcome: DirectoryAccountBatchOutcome = { succeeded: [], failed: [] }
  for (const directoryAccountId of normalizedIds) {
    try {
      outcome.succeeded.push(await unbindDirectoryAccount(directoryAccountId, input))
    } catch (error) {
      outcome.failed.push({
        accountId: directoryAccountId,
        error: readErrorMessage(error, 'Failed to unbind directory account'),
      })
    }
  }
  return outcome
}

export async function batchBindDirectoryAccounts(
  entries: DirectoryAccountBatchBindEntry[],
  input: { adminUserId: string },
): Promise<DirectoryAccountBatchOutcome> {
  const normalizedEntries = entries
    .map((entry) => ({
      accountId: normalizeText(entry.accountId),
      localUserRef: normalizeText(entry.localUserRef),
      enableDingTalkGrant: entry.enableDingTalkGrant !== false,
    }))
    .filter((entry) => entry.accountId.length > 0 && entry.localUserRef.length > 0)

  if (normalizedEntries.length === 0) throw new Error('bindings are required')

  // DT-HARDEN-04: per-item isolation — see DirectoryAccountBatchOutcome.
  const outcome: DirectoryAccountBatchOutcome = { succeeded: [], failed: [] }
  for (const entry of normalizedEntries) {
    try {
      outcome.succeeded.push(await bindDirectoryAccount(entry.accountId, {
        localUserRef: entry.localUserRef,
        adminUserId: input.adminUserId,
        enableDingTalkGrant: entry.enableDingTalkGrant,
      }))
    } catch (error) {
      outcome.failed.push({
        accountId: entry.accountId,
        error: readErrorMessage(error, 'Failed to bind directory account'),
      })
    }
  }
  return outcome
}

/**
 * P2-1 (post-#3972 review): "only admit pending items with no local user and no
 * recommendation candidate" is enforced ONLY in the Vue computed
 * (`selectedReviewAdmissionIds` in DirectoryManagementView.vue) — a direct POST to
 * batch-admit-users bypasses it entirely. This mirrors that rule at the minimum-safe
 * level for the server: reject an account that is already linked to a local user, or
 * whose email/mobile (case-insensitively — recommendations themselves are built from a
 * case-insensitive email match, see loadDirectoryReviewRecommendations) already maps to
 * an existing active user, instead of silently admitting a duplicate or overwriting an
 * existing link.
 */
async function assertDirectoryAccountEligibleForBatchAdmission(
  account: Pick<DirectoryBindingTargetAccountRow, 'id' | 'email' | 'mobile'>,
): Promise<void> {
  const linkResult = await query<{ link_status: string | null; local_user_id: string | null }>(
    `SELECT link_status, local_user_id
     FROM directory_account_links
     WHERE directory_account_id = $1::uuid
     LIMIT 1`,
    [account.id],
  )
  const link = linkResult.rows[0]
  if (link?.link_status === 'linked' && normalizeText(link.local_user_id)) {
    throw new Error('Directory account is already linked to a local user')
  }

  const normalizedEmail = normalizeText(account.email).toLowerCase()
  const normalizedMobile = normalizeText(account.mobile)
  if (!normalizedEmail && !normalizedMobile) return

  const matchResult = await query<{ id: string }>(
    `SELECT id
     FROM users
     WHERE COALESCE(is_active, TRUE) = TRUE
       AND (
         ($1::text <> '' AND lower(email) = $1::text)
         OR ($2::text <> '' AND mobile = $2::text)
       )
     LIMIT 1`,
    [normalizedEmail, normalizedMobile],
  )
  if (matchResult.rows.length > 0) {
    throw new Error('A local user with this email or mobile already exists; confirm the recommended binding instead of admitting a new account')
  }
}

export async function batchAdmitDirectoryAccountUsers(
  directoryAccountIds: string[],
  input: DirectoryAccountBatchAdmissionInput,
): Promise<DirectoryAccountBatchAdmissionOutcome> {
  const normalizedIds = Array.from(new Set(directoryAccountIds.map((item) => normalizeText(item)).filter(Boolean)))
  const normalizedAdminUserId = normalizeText(input.adminUserId)
  if (normalizedIds.length === 0) throw new Error('accountIds are required')
  if (!normalizedAdminUserId) throw new Error('adminUserId is required')

  const outcome: DirectoryAccountBatchAdmissionOutcome = { succeeded: [], failed: [] }
  for (const accountId of normalizedIds) {
    try {
      const account = await loadDirectoryBindingTargetAccount(accountId)
      if (!account) throw new Error('Directory account not found')
      await assertDirectoryAccountEligibleForBatchAdmission(account)
      const fallbackName = normalizeText(account.external_user_id) || account.id
      const admissionName = normalizeText(account.name).length >= 2 ? account.name : fallbackName
      outcome.succeeded.push(await admitDirectoryAccountUser(account.id, {
        adminUserId: normalizedAdminUserId,
        name: admissionName,
        email: account.email ?? undefined,
        username: account.email
          ? undefined
          : buildDirectoryAutoAdmissionUsername({
            id: account.id,
            external_user_id: account.external_user_id,
            union_id: account.union_id,
            open_id: account.open_id,
          }),
        mobile: account.mobile,
        enableDingTalkGrant: input.enableDingTalkGrant === true,
      }))
    } catch (error) {
      outcome.failed.push({
        accountId,
        error: readErrorMessage(error, 'Failed to create and bind local user for directory account'),
      })
    }
  }
  return outcome
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
  assertDirectoryAccountCanEnableDingTalkGrant(account, enableDingTalkGrant)

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
     WHERE provider = $1::text
       AND local_user_id <> $5::text
       AND (
         external_key = $2::text
         OR ($3::text IS NOT NULL AND provider_union_id = $3::text AND corp_id IS NOT DISTINCT FROM $4::text)
         OR ($6::text IS NOT NULL AND provider_open_id = $6::text AND corp_id IS NOT DISTINCT FROM $4::text)
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
     WHERE a.provider = $1::text
       AND l.local_user_id = $2::text
       AND l.link_status = 'linked'
       AND l.directory_account_id <> $3::uuid
     LIMIT 1`,
    [account.provider, localUser.id, normalizedAccountId],
  )
  if (conflictingLinkResult.rows.length > 0) {
    throw new Error('Local user is already linked to another DingTalk directory account')
  }

  const existingIdentityResult = await client.query(
    `SELECT id
     FROM user_external_identities
     WHERE provider = $1::text AND local_user_id = $2::text
     LIMIT 1`,
    [account.provider, localUser.id],
  )

  if (existingIdentityResult.rows.length > 0) {
    await client.query(
      `UPDATE user_external_identities
       SET external_key = $3::text,
           provider_union_id = $4::text,
           provider_open_id = $5::text,
           corp_id = $6::text,
           profile = $7::jsonb,
           bound_by = COALESCE(bound_by, $8::text),
           updated_at = NOW()
       WHERE provider = $1::text AND local_user_id = $2::text`,
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
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb, $8::text, NOW(), NOW())`,
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
       VALUES ($1::text, $2::text, TRUE, $3::text, NOW(), NOW())
       ON CONFLICT (provider, local_user_id)
       DO UPDATE SET enabled = TRUE, granted_by = EXCLUDED.granted_by, updated_at = NOW()`,
      [account.provider, localUser.id, normalizedAdminUserId],
    )
  }

  await client.query(
    `INSERT INTO directory_account_links (
       directory_account_id, local_user_id, link_status, match_strategy, reviewed_by, review_note, created_at, updated_at
     )
     VALUES ($1::uuid, $2::text, 'linked', 'manual_admin', $3::text, NULL, NOW(), NOW())
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
  // DT-HARDEN-02: assert grant feasibility BEFORE inserting the users row — the cheapest
  // and most common orphan cause (grant requested for an account that cannot hold one).
  // But this alone is not sufficient: applyDirectoryAccountBindInTransaction (called AFTER
  // the INSERT below) still throws when the account has no openId/unionId at all — even with
  // grant disabled — or when its identity is already bound to another local user. Those
  // throws, swallowed by the sync loop's catch, historically committed an orphan. The
  // SAVEPOINT around INSERT+bind (below) makes the whole admission all-or-nothing: a bind
  // that throws for ANY reason rolls the users row back, so the loop's swallow is safe.
  assertDirectoryAccountCanEnableDingTalkGrant(options.account, options.enableDingTalkGrant)
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
    // Case-insensitive on purpose: directory sync's own account↔user matching (see
    // loadDirectoryReviewRecommendations, LOWER(email) = ANY(...)) and AuthService's login
    // lookup (lower(email) = $1) both treat email identity as case-insensitive, but
    // AuthService.register stores the raw-case value and the `idx_users_email` unique index is
    // ALSO case-sensitive — so it does not backstop this at the DB layer. A case-sensitive
    // check here let a differently-cased admission (e.g. `alice@x.com` vs a stored
    // `Alice@x.com`) slip past and create a second `users` row for the same person. Matches
    // the users_email_lower_idx (lower(email)) index already in place for this exact lookup
    // shape.
    const existingUserResult = await client.query(
      `SELECT id
       FROM users
       WHERE lower(email) = lower($1::text)
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
       WHERE lower(username) = lower($1::text)
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
       WHERE mobile = $1::text
       LIMIT 1`,
      [options.mobile],
    )
    if (existingMobileResult.rows.length > 0) {
      throw new Error('User with this mobile already exists')
    }
  }

  // DT-HARDEN-02: INSERT + bind are one all-or-nothing unit. A bind throw after the INSERT
  // (missing openId/unionId, or an identity already bound to another local user) would
  // otherwise leave a committed orphan once the sync loop swallows the error — the exact
  // hazard this ticket exists to close, and the one the pre-INSERT assert above does not cover.
  await client.query('SAVEPOINT directory_admit_user')
  try {
    await client.query(
      `INSERT INTO users (id, email, username, name, mobile, password_hash, must_change_password, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::boolean, 'user', $8::jsonb, TRUE, FALSE, NOW(), NOW())`,
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
  } catch (error) {
    // Undo the users INSERT (and recover the transaction if the throw came from a failed
    // statement), then release, so the outer sync transaction stays usable for the next account.
    await client.query('ROLLBACK TO SAVEPOINT directory_admit_user')
    await client.query('RELEASE SAVEPOINT directory_admit_user')
    throw error
  }
  await client.query('RELEASE SAVEPOINT directory_admit_user')

  return { userId }
}

/**
 * DT-HARDEN-02: internals exposed only so the orphan-prevention invariant can be
 * asserted directly — "a grant that cannot be honored must throw BEFORE the users
 * row is inserted". The invariant is not observable through the exported surface
 * (the manual-admission path asserts earlier; the sync path now computes the grant
 * from openId presence), so without this seam a regression at the call site would
 * pass every test.
 */
export const __directorySyncInternalsForTests = {
  createDirectoryAdmittedUserInTransaction,
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
  const normalizedRef = ref.toLowerCase()
  const normalizedMobile = normalizeMobileIdentifier(ref)

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
        OR LOWER(email) = $2
        OR LOWER(username) = $2
        OR regexp_replace(mobile, '\\s+', '', 'g') = $3
     ORDER BY
       CASE
         WHEN id = $1 THEN 0
         WHEN LOWER(email) = $2 THEN 1
         WHEN LOWER(username) = $2 THEN 2
         WHEN regexp_replace(mobile, '\\s+', '', 'g') = $3 THEN 3
         ELSE 4
       END
     LIMIT 2`,
    [ref, normalizedRef, normalizedMobile],
  )

  const idMatch = result.rows.find((row) => row.id === ref)
  if (idMatch) return idMatch

  const distinctUserIds = new Set(result.rows.map((row) => row.id))
  if (distinctUserIds.size > 1) throw new Error('Local user reference is ambiguous')

  const emailMatches = result.rows.filter((row) => typeof row.email === 'string' && row.email.toLowerCase() === normalizedRef)
  if (emailMatches.length > 1) throw new Error('Local user reference is ambiguous')
  if (emailMatches.length === 1) return emailMatches[0]

  const usernameMatches = result.rows.filter((row) => typeof row.username === 'string' && row.username.toLowerCase() === normalizedRef)
  if (usernameMatches.length > 1) throw new Error('Local user reference is ambiguous')
  if (usernameMatches.length === 1) return usernameMatches[0]

  const mobileMatches = result.rows.filter((row) => typeof row.mobile === 'string' && normalizeMobileIdentifier(row.mobile) === normalizedMobile)
  if (mobileMatches.length > 1) throw new Error('Local user reference is ambiguous')
  return mobileMatches[0] ?? null
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

export async function listDirectoryIntegrationDepartments(
  integrationId: string,
): Promise<{ items: DirectoryDepartmentSummary[]; total: number }> {
  const normalizedIntegrationId = normalizeText(integrationId)
  if (!normalizedIntegrationId) throw new Error('integrationId is required')

  const result = await query<DirectoryDepartmentSummaryRow>(
    `SELECT
        d.id AS directory_department_id,
        d.integration_id,
        d.provider,
        d.external_department_id,
        d.external_parent_department_id,
        d.name,
        d.full_path,
        d.order_index,
        d.is_active,
        d.last_seen_at,
        d.updated_at,
        COUNT(DISTINCT ad.directory_account_id) FILTER (WHERE a.is_active = true) AS account_count,
        COUNT(DISTINCT ad.directory_account_id) FILTER (
          WHERE a.is_active = true
            AND l.local_user_id IS NOT NULL
            AND COALESCE(l.link_status, '') = 'linked'
        ) AS linked_account_count,
        COUNT(DISTINCT child.id) FILTER (WHERE child.is_active = true) AS child_count
     FROM directory_departments d
     LEFT JOIN directory_account_departments ad ON ad.directory_department_id = d.id
     LEFT JOIN directory_accounts a ON a.id = ad.directory_account_id
     LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
     LEFT JOIN directory_departments child
       ON child.integration_id = d.integration_id
      AND child.external_parent_department_id = d.external_department_id
     WHERE d.integration_id = $1
     GROUP BY
       d.id, d.integration_id, d.provider, d.external_department_id, d.external_parent_department_id,
       d.name, d.full_path, d.order_index, d.is_active, d.last_seen_at, d.updated_at
     ORDER BY d.is_active DESC, COALESCE(d.full_path, d.name) ASC, d.order_index ASC, d.external_department_id ASC`,
    [normalizedIntegrationId],
  )

  const items = result.rows.map(summarizeDirectoryDepartment)
  return {
    items,
    total: items.length,
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
  assertDirectoryAccountCanEnableDingTalkGrant(account, enableDingTalkGrant)

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
  assertDirectoryAccountCanEnableDingTalkGrant(account, enableDingTalkGrant)

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
