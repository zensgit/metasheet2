import * as bcrypt from 'bcryptjs'
import crypto from 'crypto'
import type { DingTalkIdentityProfile } from '../auth/dingtalk-auth'
import { auditLog } from '../audit/audit'
import { upsertUserExternalAuthGrant } from '../auth/external-auth-grants'
import { buildDingTalkExternalKey, findExternalIdentityByProviderAndKey, upsertExternalIdentity } from '../auth/external-identities'
import { validatePassword } from '../auth/password-policy'
import { Logger } from '../core/logger'
import { query, transaction } from '../db/pg'
import { SchedulerServiceImpl, SimpleCronExpression } from '../services/SchedulerService'
import { readDingTalkPermissionErrorDetails, readErrorMessage } from '../utils/error'

export type DirectoryProvider = 'dingtalk'
export const DIRECTORY_DEPROVISION_POLICY_ACTIONS = ['mark_inactive', 'disable_dingtalk_auth', 'disable_local_user'] as const
export type DirectoryDeprovisionPolicyAction = typeof DIRECTORY_DEPROVISION_POLICY_ACTIONS[number]
export type DirectoryDeprovisionPolicy = DirectoryDeprovisionPolicyAction[]
export type DirectoryLinkStatus = 'pending' | 'linked' | 'conflict' | 'ignored'
export type DirectoryMatchStrategy = 'external_identity' | 'email_exact' | 'mobile_exact' | 'manual' | null

type JsonRecord = Record<string, unknown>
type JsonArray = unknown[]

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
  last_sync_at: string | Date | null
  last_success_at: string | Date | null
  last_cursor: string | null
  last_error: string | null
  created_at: string | Date
  updated_at: string | Date
}

type DirectoryDepartmentRow = {
  id: string
  integration_id: string
  external_department_id: string
  external_parent_department_id: string | null
  name: string
  full_path: string | null
  order_index: number | null
  is_active: boolean
  raw: JsonRecord | string | null
  last_seen_at: string | Date | null
  created_at: string | Date
  updated_at: string | Date
}

type DirectoryAccountLinkRow = {
  id: string
  directory_account_id: string
  local_user_id: string | null
  link_status: string
  match_strategy: string | null
  reviewed_by: string | null
  review_note: string | null
  created_at: string | Date
  updated_at: string | Date
}

type DirectoryAccountBaseRow = {
  id: string
  integration_id: string
  provider: string
  corp_id: string
  external_user_id: string
  union_id: string | null
  open_id: string | null
  external_key: string | null
  name: string | null
  nick: string | null
  email: string | null
  mobile: string | null
  job_number: string | null
  title: string | null
  avatar_url: string | null
  is_active: boolean
  raw: JsonRecord | string | null
  last_seen_at: string | Date | null
  deprovision_policy_override: string | null
  created_at: string | Date
  updated_at: string | Date
}

type DirectoryAccountListRow = DirectoryAccountBaseRow & {
  link_status: string | null
  match_strategy: string | null
  local_user_id: string | null
  review_note: string | null
  linked_user_email: string | null
  linked_user_name: string | null
  linked_user_is_active: boolean | null
  dingtalk_auth_enabled: boolean | null
  is_bound: boolean | null
  department_names: string[] | null
}

type DirectoryLoginCaptureCandidateRow = DirectoryAccountBaseRow & {
  local_user_id: string | null
  link_status: string | null
}

type DirectorySyncRunRow = {
  id: string
  integration_id: string
  status: string
  started_at: string | Date
  finished_at: string | Date | null
  cursor_before: string | null
  cursor_after: string | null
  stats: JsonRecord | string | null
  error_message: string | null
  meta: JsonRecord | string | null
  created_at: string | Date
  updated_at: string | Date
}

type DirectoryTemplateCenterRow = {
  id: string
  integration_id: string
  team_templates: JsonRecord | string | null
  import_history: JsonArray | string | null
  import_presets: JsonRecord | string | null
  created_by: string | null
  updated_by: string | null
  created_at: string | Date
  updated_at: string | Date
}

type DirectoryTemplateCenterVersionRow = {
  id: string
  center_id: string
  integration_id: string
  snapshot: JsonRecord | string | null
  change_reason: string
  created_by: string | null
  created_at: string | Date
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
  acknowledged_at: string | Date | null
  acknowledged_by: string | null
  created_at: string | Date
  updated_at: string | Date
}

type UserRow = {
  id: string
  email: string
  mobile: string | null
  name: string | null
  is_active?: boolean
}

type DirectoryIntegrationConfig = {
  appKey: string
  appSecret: string
  rootDepartmentId: string
  tokenUrl: string
  departmentsUrl: string
  usersUrl: string
  userDetailUrl: string
  pageSize: number
  captureUnboundLogins: boolean
}

type DirectoryIntegrationRecord = {
  id: string
  orgId: string
  provider: DirectoryProvider
  name: string
  status: string
  corpId: string
  syncEnabled: boolean
  scheduleCron: string | null
  defaultDeprovisionPolicy: DirectoryDeprovisionPolicy
  config: {
    appKey: string
    rootDepartmentId: string
    tokenUrl: string
    departmentsUrl: string
    usersUrl: string
    userDetailUrl: string
    pageSize: number
    captureUnboundLogins: boolean
    hasAppSecret: boolean
  }
  lastSyncAt: string | null
  lastSuccessAt: string | null
  lastCursor: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

type DirectoryDepartmentRecord = {
  id: string
  integrationId: string
  externalDepartmentId: string
  externalParentDepartmentId: string | null
  name: string
  fullPath: string | null
  orderIndex: number | null
  isActive: boolean
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

type DirectoryLinkedUser = {
  id: string
  email: string
  name: string | null
  isActive: boolean
}

export type DirectoryAccountRecord = {
  id: string
  integrationId: string
  provider: DirectoryProvider
  corpId: string
  externalUserId: string
  unionId: string | null
  openId: string | null
  externalKey: string | null
  name: string | null
  nick: string | null
  email: string | null
  mobile: string | null
  jobNumber: string | null
  title: string | null
  avatarUrl: string | null
  isActive: boolean
  lastSeenAt: string | null
  linkStatus: DirectoryLinkStatus
  matchStrategy: DirectoryMatchStrategy
  linkedUser: DirectoryLinkedUser | null
  reviewNote: string | null
  dingtalkAuthEnabled: boolean
  isBound: boolean
  departmentNames: string[]
  deprovisionPolicyOverride: DirectoryDeprovisionPolicy | null
  effectiveDeprovisionPolicy: DirectoryDeprovisionPolicy
  raw?: JsonRecord
  createdAt: string
  updatedAt: string
}

export type DirectorySyncRunRecord = {
  id: string
  integrationId: string
  status: string
  startedAt: string
  finishedAt: string | null
  cursorBefore: string | null
  cursorAfter: string | null
  stats: JsonRecord
  errorMessage: string | null
  meta: JsonRecord
  createdAt: string
  updatedAt: string
}

export type DirectoryTemplateCenterRecord = {
  integrationId: string
  teamTemplates: JsonRecord
  importHistory: JsonArray
  importPresets: JsonRecord
  createdBy: string | null
  updatedBy: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type DirectoryTemplateCenterVersionRecord = {
  id: string
  centerId: string
  integrationId: string
  changeReason: string
  createdBy: string | null
  createdAt: string
  snapshotSummary: {
    outputModes: string[]
    teamTemplateCount: number
    importPresetCount: number
    importHistoryCount: number
  }
}

export type DirectoryTemplateGovernancePresetRecord = {
  outputMode: string
  id: string
  name: string
  tags: string[]
  favorite: boolean
  pinned: boolean
  useCount: number
  lastUsedAt: string | null
  ignoredFieldCount: number
  usageBucket: 'unused' | 'low' | 'high'
}

export type DirectoryTemplateGovernanceReportRecord = {
  integrationId: string
  generatedAt: string
  totals: {
    outputModes: number
    teamTemplates: number
    importPresets: number
    favorites: number
    pinned: number
    highFrequency: number
    lowFrequency: number
    unused: number
    distinctTags: number
  }
  tagSummary: Array<{
    tag: string
    count: number
  }>
  presets: DirectoryTemplateGovernancePresetRecord[]
}

export type DirectorySyncAlertRecord = {
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

export type DirectoryActivityResourceType =
  | 'directory-integration'
  | 'directory-account'
  | 'directory-sync-alert'
  | 'directory-template-center'

type DirectoryActivityRow = {
  id: string
  created_at: string | Date
  event_type: string
  event_category: string
  event_severity: string
  action: string
  resource_type: DirectoryActivityResourceType
  resource_id: string | null
  user_id: string | null
  user_name: string | null
  user_email: string | null
  action_details: JsonRecord | string | null
  error_code: string | null
  integration_id: string | null
  integration_name: string | null
  account_id: string | null
  account_name: string | null
  account_email: string | null
  account_external_user_id: string | null
}

export type DirectoryActivityRecord = {
  id: string
  createdAt: string
  eventType: string
  eventCategory: string
  eventSeverity: string
  action: string
  resourceType: DirectoryActivityResourceType
  resourceId: string | null
  actorUserId: string | null
  actorName: string | null
  actorEmail: string | null
  actionDetails: JsonRecord
  errorCode: string | null
  integrationId: string | null
  integrationName: string | null
  accountId: string | null
  accountName: string | null
  accountEmail: string | null
  accountExternalUserId: string | null
}

export type DirectoryActivitySummary = {
  total: number
  integrationActions: number
  accountActions: number
  syncActions: number
  alertActions: number
  templateActions: number
}

type DirectoryActivityListSummaryRow = DirectoryActivitySummary

type DirectoryActivityListOptions = {
  page: number
  pageSize: number
  q?: string | null
  action?: string | null
  resourceType?: DirectoryActivityResourceType | null
  accountId?: string | null
  from?: string | null
  to?: string | null
}

export type DirectoryActivityListResult = {
  total: number
  page: number
  pageSize: number
  pageCount: number
  hasNextPage: boolean
  hasPreviousPage: boolean
  summary: DirectoryActivitySummary
  items: DirectoryActivityRecord[]
}

export type DirectoryIntegrationOperationsStatusRecord = {
  integrationId: string
  syncEnabled: boolean
  scheduleCron: string | null
  nextRunAt: string | null
  lastRunStatus: string | null
  lastRunStartedAt: string | null
  lastRunFinishedAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  alertCount: number
  unacknowledgedAlertCount: number
  lastAlertAt: string | null
}

export type DirectoryTemplateCenterInput = {
  teamTemplates?: JsonRecord | null
  importHistory?: JsonArray | null
  importPresets?: JsonRecord | null
  changeReason?: string | null
}

export type DirectoryIntegrationInput = {
  orgId?: string
  name?: string
  corpId?: string
  status?: string
  syncEnabled?: boolean
  scheduleCron?: string | null
  defaultDeprovisionPolicy?: DirectoryDeprovisionPolicy | DirectoryDeprovisionPolicyAction
  appKey?: string
  appSecret?: string
  rootDepartmentId?: string
  tokenUrl?: string
  departmentsUrl?: string
  usersUrl?: string
  userDetailUrl?: string
  pageSize?: number
  captureUnboundLogins?: boolean
}

const DEFAULT_DIRECTORY_DEPROVISION_POLICY: DirectoryDeprovisionPolicy = ['mark_inactive']

type DirectoryAccountListOptions = {
  page: number
  pageSize: number
  q?: string | null
  linkStatus?: DirectoryLinkStatus | null
  isActive?: boolean | null
  matchStrategy?: DirectoryMatchStrategy | null
  dingtalkAuthEnabled?: boolean | null
  isBound?: boolean | null
  departmentId?: string | null
}

type DirectoryAccountListSummary = {
  linked: number
  pending: number
  conflict: number
  ignored: number
  active: number
  inactive: number
  dingtalkAuthEnabled: number
  dingtalkAuthDisabled: number
  bound: number
  unbound: number
}

type DirectoryAccountListResult = {
  total: number
  page: number
  pageSize: number
  pageCount: number
  hasNextPage: boolean
  hasPreviousPage: boolean
  summary: DirectoryAccountListSummary
  items: DirectoryAccountRecord[]
}

type RemoteDepartment = {
  externalDepartmentId: string
  externalParentDepartmentId: string | null
  name: string
  orderIndex: number | null
  fullPath: string
  raw: JsonRecord
}

type RemoteUserSummary = {
  externalUserId: string
  name: string | null
  nick: string | null
  unionId: string | null
  openId: string | null
  email: string | null
  mobile: string | null
  jobNumber: string | null
  title: string | null
  avatarUrl: string | null
  primaryDepartmentId: string | null
  departmentIds: string[]
  raw: JsonRecord
}

type RemoteUserProfile = RemoteUserSummary & {
  corpId: string
  externalKey: string | null
}

type DirectoryLoginCaptureResult = {
  integrationId: string
  accountId: string
  created: boolean
  linkStatus: DirectoryLinkStatus
}

type LinkResolution = {
  status: DirectoryLinkStatus
  matchStrategy: DirectoryMatchStrategy
  localUserId: string | null
  reviewNote: string | null
}

export class DirectorySyncError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeEmail(value: unknown): string | null {
  const text = normalizeText(value)
  return text ? text.toLowerCase() : null
}

function normalizeEmailDomain(value: unknown): string {
  const text = (normalizeText(value) || 'dingtalk.local').toLowerCase()
  const sanitized = text.replace(/[^a-z0-9.-]/g, '').replace(/^\.+|\.+$/g, '')
  return sanitized.length > 0 ? sanitized : 'dingtalk.local'
}

function normalizeMobile(value: unknown): string | null {
  const text = normalizeText(value)
  if (!text) return null
  const digits = text.replace(/\D/g, '')
  return digits.length > 0 ? digits : null
}

function normalizeOptionalUrl(value: unknown, fallback: string): string {
  return normalizeText(value) || fallback
}

function normalizePageSize(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(raw)) return 100
  const rounded = Math.trunc(raw)
  if (!Number.isFinite(rounded)) return 100
  return Math.min(Math.max(rounded, 1), 100)
}

function parseObject(value: unknown): JsonRecord {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as JsonRecord
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function encodeJsonString(value: string | null): string | null {
  return value === null ? null : JSON.stringify(value)
}

function buildDirectoryProvisioningEmail(account: Pick<DirectoryAccountBaseRow, 'external_user_id' | 'union_id' | 'open_id' | 'email'>): string {
  const direct = normalizeEmail(account.email)
  if (direct) return direct

  const domain = normalizeEmailDomain(process.env.DINGTALK_AUTO_PROVISION_EMAIL_DOMAIN)
  const base = String(account.external_user_id || account.union_id || account.open_id || crypto.randomUUID())
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
  const localPart = base.length > 0 ? base : `dingtalk-${crypto.randomUUID().slice(0, 8)}`
  return `${localPart}@${domain}`
}

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => normalizeText(entry)).filter((entry): entry is string => Boolean(entry))
}

function sanitizeName(value: unknown, fallback: string): string {
  const text = normalizeText(value)
  if (!text) return fallback
  return text.replace(/[<>'"&;]/g, '').slice(0, 100)
}

function normalizeDirectoryProvider(value: unknown): DirectoryProvider {
  return value === 'dingtalk' ? value : 'dingtalk'
}

function isDeprovisionPolicyAction(value: unknown): value is DirectoryDeprovisionPolicyAction {
  return typeof value === 'string'
    && (DIRECTORY_DEPROVISION_POLICY_ACTIONS as readonly string[]).includes(value)
}

function uniqueDeprovisionPolicies(items: DirectoryDeprovisionPolicyAction[]): DirectoryDeprovisionPolicy {
  return Array.from(new Set(items))
}

function parseDeprovisionPolicies(value: unknown): DirectoryDeprovisionPolicy | null {
  if (Array.isArray(value)) {
    return uniqueDeprovisionPolicies(value.filter(isDeprovisionPolicyAction))
  }

  if (isDeprovisionPolicyAction(value)) {
    return [value]
  }

  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return []

    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) {
        return uniqueDeprovisionPolicies(parsed.filter(isDeprovisionPolicyAction))
      }
    } catch {
      return null
    }
  }

  return null
}

function normalizeDeprovisionPolicy(
  value: unknown,
  fallback: DirectoryDeprovisionPolicy = DEFAULT_DIRECTORY_DEPROVISION_POLICY,
): DirectoryDeprovisionPolicy {
  const parsed = parseDeprovisionPolicies(value)
  if (parsed !== null) {
    return parsed
  }
  return [...fallback]
}

function serializeDeprovisionPolicies(
  value: unknown,
  fallback: DirectoryDeprovisionPolicy = DEFAULT_DIRECTORY_DEPROVISION_POLICY,
): string {
  return JSON.stringify(normalizeDeprovisionPolicy(value, fallback))
}

function normalizeLinkStatus(value: unknown, fallback: DirectoryLinkStatus = 'pending'): DirectoryLinkStatus {
  if (value === 'linked' || value === 'conflict' || value === 'ignored' || value === 'pending') {
    return value
  }
  return fallback
}

function normalizeMatchStrategy(value: unknown): DirectoryMatchStrategy {
  if (value === 'external_identity' || value === 'email_exact' || value === 'mobile_exact' || value === 'manual') {
    return value
  }
  return null
}

function normalizeBooleanFilter(value: unknown): boolean | null {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  const normalized = normalizeBooleanFilter(value)
  return normalized === null ? fallback : normalized
}

function ensureValidEmail(email: string): void {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    throw new DirectorySyncError(400, 'INVALID_EMAIL', 'Invalid email format')
  }
}

function validateScheduleCron(value: string | null): string | null {
  const cron = normalizeText(value)
  if (!cron) return null
  const expression = new SimpleCronExpression(cron, process.env.TZ || 'UTC')
  if (!expression.hasNext()) {
    throw new DirectorySyncError(400, 'DIRECTORY_CRON_INVALID', 'Invalid directory sync cron expression')
  }
  return cron
}

function assertPresent(value: string | null, status: number, code: string, message: string): string {
  if (!value) {
    throw new DirectorySyncError(status, code, message)
  }
  return value
}

function mapIntegrationConfig(value: unknown, existing?: DirectoryIntegrationConfig | null): DirectoryIntegrationConfig {
  const source = parseObject(value)
  return {
    appKey: normalizeText(source.appKey) || existing?.appKey || '',
    appSecret: normalizeText(source.appSecret) || existing?.appSecret || '',
    rootDepartmentId: normalizeText(source.rootDepartmentId) || existing?.rootDepartmentId || '1',
    tokenUrl: normalizeOptionalUrl(source.tokenUrl, existing?.tokenUrl || 'https://oapi.dingtalk.com/gettoken'),
    departmentsUrl: normalizeOptionalUrl(source.departmentsUrl, existing?.departmentsUrl || 'https://oapi.dingtalk.com/topapi/v2/department/listsub'),
    usersUrl: normalizeOptionalUrl(source.usersUrl, existing?.usersUrl || 'https://oapi.dingtalk.com/topapi/v2/user/list'),
    userDetailUrl: normalizeOptionalUrl(source.userDetailUrl, existing?.userDetailUrl || 'https://oapi.dingtalk.com/topapi/v2/user/get'),
    pageSize: normalizePageSize(source.pageSize ?? existing?.pageSize ?? 100),
    captureUnboundLogins: normalizeBoolean(source.captureUnboundLogins ?? source.capture_unbound_logins, existing?.captureUnboundLogins ?? true),
  }
}

function buildStoredConfig(input: DirectoryIntegrationInput, existing?: DirectoryIntegrationConfig | null): DirectoryIntegrationConfig {
  return mapIntegrationConfig({
    appKey: input.appKey,
    appSecret: input.appSecret,
    rootDepartmentId: input.rootDepartmentId,
    tokenUrl: input.tokenUrl,
    departmentsUrl: input.departmentsUrl,
    usersUrl: input.usersUrl,
    userDetailUrl: input.userDetailUrl,
    pageSize: input.pageSize,
    captureUnboundLogins: input.captureUnboundLogins,
  }, existing)
}

function maskIntegrationConfig(config: DirectoryIntegrationConfig) {
  return {
    appKey: config.appKey,
    rootDepartmentId: config.rootDepartmentId,
    tokenUrl: config.tokenUrl,
    departmentsUrl: config.departmentsUrl,
    usersUrl: config.usersUrl,
    userDetailUrl: config.userDetailUrl,
    pageSize: config.pageSize,
    captureUnboundLogins: config.captureUnboundLogins,
    hasAppSecret: config.appSecret.length > 0,
  }
}

function mapIntegration(row: DirectoryIntegrationRow): DirectoryIntegrationRecord {
  const config = mapIntegrationConfig(row.config)
  return {
    id: row.id,
    orgId: row.org_id,
    provider: normalizeDirectoryProvider(row.provider),
    name: row.name,
    status: row.status,
    corpId: row.corp_id,
    syncEnabled: row.sync_enabled === true,
    scheduleCron: normalizeText(row.schedule_cron),
    defaultDeprovisionPolicy: normalizeDeprovisionPolicy(row.default_deprovision_policy),
    config: maskIntegrationConfig(config),
    lastSyncAt: toIso(row.last_sync_at),
    lastSuccessAt: toIso(row.last_success_at),
    lastCursor: normalizeText(row.last_cursor),
    lastError: normalizeText(row.last_error),
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
  }
}

function mapDepartment(row: DirectoryDepartmentRow): DirectoryDepartmentRecord {
  return {
    id: row.id,
    integrationId: row.integration_id,
    externalDepartmentId: row.external_department_id,
    externalParentDepartmentId: normalizeText(row.external_parent_department_id),
    name: row.name,
    fullPath: normalizeText(row.full_path),
    orderIndex: typeof row.order_index === 'number' ? row.order_index : null,
    isActive: row.is_active === true,
    lastSeenAt: toIso(row.last_seen_at),
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
  }
}

function mapSyncRun(row: DirectorySyncRunRow): DirectorySyncRunRecord {
  return {
    id: row.id,
    integrationId: row.integration_id,
    status: row.status,
    startedAt: toIso(row.started_at) || new Date().toISOString(),
    finishedAt: toIso(row.finished_at),
    cursorBefore: normalizeText(row.cursor_before),
    cursorAfter: normalizeText(row.cursor_after),
    stats: parseObject(row.stats),
    errorMessage: normalizeText(row.error_message),
    meta: parseObject(row.meta),
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
  }
}

function parseJsonArray(value: unknown): JsonArray {
  if (Array.isArray(value)) {
    return value
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function normalizeTemplateCenterInput(input: DirectoryTemplateCenterInput | null | undefined): Required<DirectoryTemplateCenterInput> {
  return {
    teamTemplates: parseObject(input?.teamTemplates),
    importHistory: parseJsonArray(input?.importHistory),
    importPresets: parseObject(input?.importPresets),
    changeReason: normalizeText(input?.changeReason) || 'manual_update',
  }
}

function buildTemplateCenterSnapshot(center: DirectoryTemplateCenterInput | DirectoryTemplateCenterRecord): JsonRecord {
  const normalized = normalizeTemplateCenterInput(center)
  return {
    teamTemplates: normalized.teamTemplates,
    importHistory: normalized.importHistory,
    importPresets: normalized.importPresets,
  }
}

function countSnapshotTeamTemplates(snapshot: JsonRecord): number {
  return Object.keys(parseObject(snapshot.teamTemplates)).length
}

function countSnapshotImportPresets(snapshot: JsonRecord): number {
  return Object.values(parseObject(snapshot.importPresets))
    .filter((value) => Array.isArray(value))
    .reduce((total, value) => total + value.length, 0)
}

function countSnapshotImportHistory(snapshot: JsonRecord): number {
  return parseJsonArray(snapshot.importHistory).length
}

function mapTemplateCenter(row: DirectoryTemplateCenterRow | null, integrationId: string): DirectoryTemplateCenterRecord {
  return {
    integrationId,
    teamTemplates: row ? parseObject(row.team_templates) : {},
    importHistory: row ? parseJsonArray(row.import_history) : [],
    importPresets: row ? parseObject(row.import_presets) : {},
    createdBy: row?.created_by ?? null,
    updatedBy: row?.updated_by ?? null,
    createdAt: row ? toIso(row.created_at) : null,
    updatedAt: row ? toIso(row.updated_at) : null,
  }
}

function mapTemplateCenterVersion(row: DirectoryTemplateCenterVersionRow): DirectoryTemplateCenterVersionRecord {
  const snapshot = parseObject(row.snapshot)
  return {
    id: row.id,
    centerId: row.center_id,
    integrationId: row.integration_id,
    changeReason: row.change_reason,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    snapshotSummary: {
      outputModes: Array.from(new Set([
        ...Object.keys(parseObject(snapshot.teamTemplates)),
        ...Object.keys(parseObject(snapshot.importPresets)),
      ])).sort(),
      teamTemplateCount: countSnapshotTeamTemplates(snapshot),
      importPresetCount: countSnapshotImportPresets(snapshot),
      importHistoryCount: countSnapshotImportHistory(snapshot),
    },
  }
}

function mapDirectorySyncAlert(row: DirectorySyncAlertRow): DirectorySyncAlertRecord {
  return {
    id: row.id,
    integrationId: row.integration_id,
    runId: normalizeText(row.run_id),
    level: normalizeText(row.level) || 'error',
    code: normalizeText(row.code) || 'DIRECTORY_SYNC_ALERT',
    message: normalizeText(row.message) || 'Directory sync alert',
    details: parseObject(row.details),
    sentToWebhook: row.sent_to_webhook === true,
    acknowledgedAt: toIso(row.acknowledged_at),
    acknowledgedBy: normalizeText(row.acknowledged_by),
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
  }
}

function mapDirectoryActivity(row: DirectoryActivityRow): DirectoryActivityRecord {
  return {
    id: row.id,
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    eventType: row.event_type,
    eventCategory: row.event_category,
    eventSeverity: row.event_severity,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: normalizeText(row.resource_id),
    actorUserId: normalizeText(row.user_id),
    actorName: normalizeText(row.user_name),
    actorEmail: normalizeText(row.user_email),
    actionDetails: parseObject(row.action_details),
    errorCode: normalizeText(row.error_code),
    integrationId: normalizeText(row.integration_id),
    integrationName: normalizeText(row.integration_name),
    accountId: normalizeText(row.account_id),
    accountName: normalizeText(row.account_name),
    accountEmail: normalizeText(row.account_email),
    accountExternalUserId: normalizeText(row.account_external_user_id),
  }
}

function classifyTemplatePresetUsage(useCount: number): DirectoryTemplateGovernancePresetRecord['usageBucket'] {
  if (useCount <= 0) return 'unused'
  if (useCount <= 1) return 'low'
  return 'high'
}

function mapDirectoryAccount(row: DirectoryAccountListRow, defaultDeprovisionPolicy: DirectoryDeprovisionPolicy, detailDepartments: string[] = []): DirectoryAccountRecord {
  return {
    id: row.id,
    integrationId: row.integration_id,
    provider: normalizeDirectoryProvider(row.provider),
    corpId: row.corp_id,
    externalUserId: row.external_user_id,
    unionId: normalizeText(row.union_id),
    openId: normalizeText(row.open_id),
    externalKey: normalizeText(row.external_key),
    name: normalizeText(row.name),
    nick: normalizeText(row.nick),
    email: normalizeEmail(row.email),
    mobile: normalizeText(row.mobile),
    jobNumber: normalizeText(row.job_number),
    title: normalizeText(row.title),
    avatarUrl: normalizeText(row.avatar_url),
    isActive: row.is_active === true,
    lastSeenAt: toIso(row.last_seen_at),
    linkStatus: normalizeLinkStatus(row.link_status),
    matchStrategy: normalizeMatchStrategy(row.match_strategy),
    linkedUser: row.local_user_id
      ? {
          id: row.local_user_id,
          email: normalizeEmail(row.linked_user_email) || '',
          name: normalizeText(row.linked_user_name),
          isActive: row.linked_user_is_active === true,
        }
      : null,
    reviewNote: normalizeText(row.review_note),
    dingtalkAuthEnabled: row.dingtalk_auth_enabled === true,
    isBound: row.is_bound === true,
    departmentNames: detailDepartments.length > 0 ? detailDepartments : parseStringArray(row.department_names),
    deprovisionPolicyOverride: row.deprovision_policy_override
      ? normalizeDeprovisionPolicy(row.deprovision_policy_override, DEFAULT_DIRECTORY_DEPROVISION_POLICY)
      : null,
    effectiveDeprovisionPolicy: normalizeDeprovisionPolicy(row.deprovision_policy_override, defaultDeprovisionPolicy),
    raw: parseObject(row.raw),
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<JsonRecord> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => ({})) as JsonRecord
  if (!response.ok) {
    const message = readErrorMessage(payload, `HTTP ${response.status}`)
    const permissionDetails = readDingTalkPermissionErrorDetails(payload)
    if (permissionDetails) {
      throw new DirectorySyncError(502, 'DINGTALK_PERMISSION_REQUIRED', message, permissionDetails)
    }
    throw new Error(message)
  }
  if ((typeof payload.errcode === 'number' && payload.errcode !== 0) || (typeof payload.code === 'number' && payload.code !== 0)) {
    const message = readErrorMessage(payload, 'Remote API request failed')
    const permissionDetails = readDingTalkPermissionErrorDetails(payload)
    if (permissionDetails) {
      throw new DirectorySyncError(502, 'DINGTALK_PERMISSION_REQUIRED', message, permissionDetails)
    }
    throw new Error(message)
  }
  return payload
}

function buildQueryUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base)
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value)
  })
  return url.toString()
}

export class DirectorySyncService {
  private readonly logger = new Logger('DirectorySyncService')
  private readonly scheduler = new SchedulerServiceImpl()
  private readonly inflight = new Set<string>()
  private scheduledJobNames = new Set<string>()
  private schedulesBootstrapped = false

  async initializeSchedules(): Promise<void> {
    if (this.schedulesBootstrapped) return
    await this.refreshSchedules()
    this.schedulesBootstrapped = true
  }

  async shutdown(): Promise<void> {
    this.scheduler.destroy()
    this.scheduledJobNames.clear()
    this.schedulesBootstrapped = false
  }

  async listIntegrations(orgId?: string | null): Promise<DirectoryIntegrationRecord[]> {
    const result = await query<DirectoryIntegrationRow>(
      `SELECT id, org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron,
              default_deprovision_policy, last_sync_at, last_success_at, last_cursor, last_error,
              created_at, updated_at
       FROM directory_integrations
       WHERE ($1::text IS NULL OR org_id = $1)
       ORDER BY created_at DESC`,
      [normalizeText(orgId)],
    )
    return result.rows.map(mapIntegration)
  }

  async getIntegration(integrationId: string): Promise<DirectoryIntegrationRecord | null> {
    const row = await this.getIntegrationRow(integrationId)
    return row ? mapIntegration(row) : null
  }

  async getTemplateCenter(integrationId: string): Promise<DirectoryTemplateCenterRecord> {
    const integration = await this.getIntegrationRow(integrationId)
    if (!integration) {
      throw new DirectorySyncError(404, 'DIRECTORY_INTEGRATION_NOT_FOUND', 'Directory integration not found')
    }
    const row = await this.getTemplateCenterRow(integrationId)
    return mapTemplateCenter(row, integrationId)
  }

  async saveTemplateCenter(integrationId: string, input: DirectoryTemplateCenterInput, actorId: string): Promise<DirectoryTemplateCenterRecord> {
    const integration = await this.getIntegrationRow(integrationId)
    if (!integration) {
      throw new DirectorySyncError(404, 'DIRECTORY_INTEGRATION_NOT_FOUND', 'Directory integration not found')
    }

    const next = normalizeTemplateCenterInput(input)
    const current = await this.getTemplateCenterRow(integrationId)
    const nextSnapshot = buildTemplateCenterSnapshot(next)
    const previousSnapshot = current ? buildTemplateCenterSnapshot(mapTemplateCenter(current, integrationId)) : buildTemplateCenterSnapshot({})
    const changed = JSON.stringify(previousSnapshot) !== JSON.stringify(nextSnapshot)
    let centerId = current?.id || ''

    if (!current) {
      centerId = crypto.randomUUID()
      await query(
        `INSERT INTO directory_template_centers (
           id, integration_id, team_templates, import_history, import_presets, created_by, updated_by, created_at, updated_at
         )
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $6, NOW(), NOW())`,
        [
          centerId,
          integrationId,
          JSON.stringify(next.teamTemplates),
          JSON.stringify(next.importHistory),
          JSON.stringify(next.importPresets),
          actorId,
        ],
      )
    } else {
      centerId = current.id
      await query(
        `UPDATE directory_template_centers
         SET team_templates = $2::jsonb,
             import_history = $3::jsonb,
             import_presets = $4::jsonb,
             updated_by = $5,
             updated_at = NOW()
         WHERE id = $1`,
        [
          centerId,
          JSON.stringify(next.teamTemplates),
          JSON.stringify(next.importHistory),
          JSON.stringify(next.importPresets),
          actorId,
        ],
      )
    }

    if (changed) {
      await this.insertTemplateCenterVersion(centerId, integrationId, nextSnapshot, next.changeReason, actorId)
      await auditLog({
        actorId,
        actorType: 'user',
        action: 'update',
        resourceType: 'directory-template-center',
        resourceId: integrationId,
        meta: {
          changeReason: next.changeReason,
          teamTemplateCount: countSnapshotTeamTemplates(nextSnapshot),
          importPresetCount: countSnapshotImportPresets(nextSnapshot),
          importHistoryCount: countSnapshotImportHistory(nextSnapshot),
        },
      })
    }

    return this.getTemplateCenter(integrationId)
  }

  async listTemplateCenterVersions(integrationId: string, limit = 10): Promise<DirectoryTemplateCenterVersionRecord[]> {
    const normalizedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 50) : 10
    const result = await query<DirectoryTemplateCenterVersionRow>(
      `SELECT id, center_id, integration_id, snapshot, change_reason, created_by, created_at
       FROM directory_template_center_versions
       WHERE integration_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [integrationId, normalizedLimit],
    )
    return result.rows.map(mapTemplateCenterVersion)
  }

  async restoreTemplateCenterVersion(integrationId: string, versionId: string, actorId: string): Promise<DirectoryTemplateCenterRecord> {
    const version = await query<DirectoryTemplateCenterVersionRow>(
      `SELECT id, center_id, integration_id, snapshot, change_reason, created_by, created_at
       FROM directory_template_center_versions
       WHERE integration_id = $1
         AND id = $2
       LIMIT 1`,
      [integrationId, versionId],
    )
    const row = version.rows[0]
    if (!row) {
      throw new DirectorySyncError(404, 'DIRECTORY_TEMPLATE_CENTER_VERSION_NOT_FOUND', 'Template center version not found')
    }
    const snapshot = parseObject(row.snapshot)
    return this.saveTemplateCenter(integrationId, {
      teamTemplates: parseObject(snapshot.teamTemplates),
      importHistory: parseJsonArray(snapshot.importHistory),
      importPresets: parseObject(snapshot.importPresets),
      changeReason: `restore:${versionId}`,
    }, actorId)
  }

  async buildTemplateGovernanceReport(integrationId: string): Promise<DirectoryTemplateGovernanceReportRecord> {
    const center = await this.getTemplateCenter(integrationId)
    const teamTemplates = parseObject(center.teamTemplates)
    const importPresets = parseObject(center.importPresets)
    const tagCounts = new Map<string, number>()
    const presets: DirectoryTemplateGovernancePresetRecord[] = []

    for (const [outputMode, value] of Object.entries(importPresets)) {
      if (!Array.isArray(value)) continue
      for (const entry of value) {
        const item = parseObject(entry)
        const tags = parseJsonArray(item.tags).map((tag) => normalizeText(tag)).filter((tag): tag is string => Boolean(tag))
        for (const tag of tags) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
        }
        const useCount = Number(item.useCount || 0)
        presets.push({
          outputMode,
          id: normalizeText(item.id) || '',
          name: normalizeText(item.name) || '未命名预设',
          tags,
          favorite: normalizeBoolean(item.favorite),
          pinned: normalizeBoolean(item.pinned),
          useCount,
          lastUsedAt: normalizeText(item.lastUsedAt),
          ignoredFieldCount: parseJsonArray(item.ignoredFieldKeys).length,
          usageBucket: classifyTemplatePresetUsage(useCount),
        })
      }
    }

    return {
      integrationId,
      generatedAt: new Date().toISOString(),
      totals: {
        outputModes: Array.from(new Set([
          ...Object.keys(teamTemplates),
          ...Object.keys(importPresets),
        ])).length,
        teamTemplates: Object.keys(teamTemplates).length,
        importPresets: presets.length,
        favorites: presets.filter((item) => item.favorite).length,
        pinned: presets.filter((item) => item.pinned).length,
        highFrequency: presets.filter((item) => item.usageBucket === 'high').length,
        lowFrequency: presets.filter((item) => item.usageBucket === 'low').length,
        unused: presets.filter((item) => item.usageBucket === 'unused').length,
        distinctTags: tagCounts.size,
      },
      tagSummary: Array.from(tagCounts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag, 'zh-CN')),
      presets: presets.sort((left, right) =>
        Number(right.pinned) - Number(left.pinned)
        || Number(right.favorite) - Number(left.favorite)
        || right.useCount - left.useCount
        || left.name.localeCompare(right.name, 'zh-CN')),
    }
  }

  async getIntegrationOperationsStatus(integrationId: string): Promise<DirectoryIntegrationOperationsStatusRecord> {
    const integration = await this.getIntegrationRow(integrationId)
    if (!integration) {
      throw new DirectorySyncError(404, 'DIRECTORY_INTEGRATION_NOT_FOUND', 'Directory integration not found')
    }

    const latestRun = await query<Pick<DirectorySyncRunRow, 'status' | 'started_at' | 'finished_at'>>(
      `SELECT status, started_at, finished_at
       FROM directory_sync_runs
       WHERE integration_id = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [integrationId],
    )
    const alertSummary = await query<{
      total: number
      unacknowledged: number
      last_alert_at: string | Date | null
    }>(
      `SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE acknowledged_at IS NULL)::int AS unacknowledged,
          MAX(created_at) AS last_alert_at
       FROM directory_sync_alerts
       WHERE integration_id = $1`,
      [integrationId],
    )

    return {
      integrationId,
      syncEnabled: integration.sync_enabled === true,
      scheduleCron: normalizeText(integration.schedule_cron),
      nextRunAt: this.calculateNextRunAt(normalizeText(integration.schedule_cron)),
      lastRunStatus: normalizeText(latestRun.rows[0]?.status),
      lastRunStartedAt: toIso(latestRun.rows[0]?.started_at),
      lastRunFinishedAt: toIso(latestRun.rows[0]?.finished_at),
      lastSuccessAt: toIso(integration.last_success_at),
      lastError: normalizeText(integration.last_error),
      alertCount: alertSummary.rows[0]?.total ?? 0,
      unacknowledgedAlertCount: alertSummary.rows[0]?.unacknowledged ?? 0,
      lastAlertAt: toIso(alertSummary.rows[0]?.last_alert_at),
    }
  }

  async listSyncAlerts(integrationId: string, limit = 20): Promise<DirectorySyncAlertRecord[]> {
    const normalizedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20
    const result = await query<DirectorySyncAlertRow>(
      `SELECT id, integration_id, run_id, level, code, message, details, sent_to_webhook,
              acknowledged_at, acknowledged_by, created_at, updated_at
       FROM directory_sync_alerts
       WHERE integration_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [integrationId, normalizedLimit],
    )
    return result.rows.map(mapDirectorySyncAlert)
  }

  async acknowledgeSyncAlert(integrationId: string, alertId: string, actorId: string): Promise<DirectorySyncAlertRecord> {
    const result = await query<DirectorySyncAlertRow>(
      `UPDATE directory_sync_alerts
       SET acknowledged_at = NOW(),
           acknowledged_by = $3,
           updated_at = NOW()
       WHERE integration_id = $1
         AND id = $2
       RETURNING id, integration_id, run_id, level, code, message, details, sent_to_webhook,
                 acknowledged_at, acknowledged_by, created_at, updated_at`,
      [integrationId, alertId, actorId],
    )
    const row = result.rows[0]
    if (!row) {
      throw new DirectorySyncError(404, 'DIRECTORY_SYNC_ALERT_NOT_FOUND', 'Directory sync alert not found')
    }

    await auditLog({
      actorId,
      actorType: 'user',
      action: 'acknowledge',
      resourceType: 'directory-sync-alert',
      resourceId: alertId,
      meta: {
        integrationId,
      },
    })

    return mapDirectorySyncAlert(row)
  }

  async createIntegration(input: DirectoryIntegrationInput, actorId: string): Promise<DirectoryIntegrationRecord> {
    const orgId = assertPresent(normalizeText(input.orgId), 400, 'ORG_ID_REQUIRED', 'orgId is required')
    const name = assertPresent(normalizeText(input.name), 400, 'NAME_REQUIRED', 'name is required')
    const corpId = assertPresent(normalizeText(input.corpId), 400, 'CORP_ID_REQUIRED', 'corpId is required')
    const config = buildStoredConfig(input)
    const scheduleCron = validateScheduleCron(normalizeText(input.scheduleCron))

    if (!config.appKey || !config.appSecret) {
      throw new DirectorySyncError(400, 'DINGTALK_CREDENTIALS_REQUIRED', 'appKey and appSecret are required')
    }

    const integrationId = crypto.randomUUID()
    await query(
      `INSERT INTO directory_integrations (
         id, org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron,
         default_deprovision_policy, created_at, updated_at
       )
       VALUES ($1, $2, 'dingtalk', $3, $4, $5, $6::jsonb, $7, $8, $9, NOW(), NOW())`,
      [
        integrationId,
        orgId,
        name,
        normalizeText(input.status) || 'active',
        corpId,
        JSON.stringify(config),
        input.syncEnabled === true,
        scheduleCron,
        serializeDeprovisionPolicies(input.defaultDeprovisionPolicy),
      ],
    )

    await auditLog({
      actorId,
      actorType: 'user',
      action: 'create',
      resourceType: 'directory-integration',
      resourceId: integrationId,
      meta: {
        orgId,
        provider: 'dingtalk',
        corpId,
        syncEnabled: input.syncEnabled === true,
        scheduleCron: normalizeText(input.scheduleCron),
        defaultDeprovisionPolicy: normalizeDeprovisionPolicy(input.defaultDeprovisionPolicy),
      },
    })

    await this.refreshSchedules()
    const saved = await this.getIntegration(integrationId)
    if (!saved) {
      throw new DirectorySyncError(500, 'DIRECTORY_INTEGRATION_CREATE_FAILED', 'Failed to load created integration')
    }
    return saved
  }

  async updateIntegration(integrationId: string, input: DirectoryIntegrationInput, actorId: string): Promise<DirectoryIntegrationRecord> {
    const current = await this.getIntegrationRow(integrationId)
    if (!current) {
      throw new DirectorySyncError(404, 'DIRECTORY_INTEGRATION_NOT_FOUND', 'Directory integration not found')
    }

    const currentConfig = mapIntegrationConfig(current.config)
    const nextConfig = buildStoredConfig(input, currentConfig)
    const scheduleCron = input.scheduleCron !== undefined
      ? validateScheduleCron(normalizeText(input.scheduleCron))
      : normalizeText(current.schedule_cron)

    await query(
      `UPDATE directory_integrations
       SET org_id = $2,
           name = $3,
           status = $4,
           corp_id = $5,
           config = $6::jsonb,
           sync_enabled = $7,
           schedule_cron = $8,
           default_deprovision_policy = $9,
           updated_at = NOW()
       WHERE id = $1`,
      [
        integrationId,
        normalizeText(input.orgId) || current.org_id,
        normalizeText(input.name) || current.name,
        normalizeText(input.status) || current.status,
        normalizeText(input.corpId) || current.corp_id,
        JSON.stringify(nextConfig),
        typeof input.syncEnabled === 'boolean' ? input.syncEnabled : current.sync_enabled,
        scheduleCron,
        serializeDeprovisionPolicies(
          input.defaultDeprovisionPolicy,
          normalizeDeprovisionPolicy(current.default_deprovision_policy),
        ),
      ],
    )

    await auditLog({
      actorId,
      actorType: 'user',
      action: 'update',
      resourceType: 'directory-integration',
      resourceId: integrationId,
      meta: {
        orgId: normalizeText(input.orgId) || current.org_id,
        corpId: normalizeText(input.corpId) || current.corp_id,
        syncEnabled: typeof input.syncEnabled === 'boolean' ? input.syncEnabled : current.sync_enabled,
        scheduleCron: input.scheduleCron !== undefined ? normalizeText(input.scheduleCron) : normalizeText(current.schedule_cron),
        defaultDeprovisionPolicy: normalizeDeprovisionPolicy(input.defaultDeprovisionPolicy, normalizeDeprovisionPolicy(current.default_deprovision_policy)),
      },
    })

    await this.refreshSchedules()
    const saved = await this.getIntegration(integrationId)
    if (!saved) {
      throw new DirectorySyncError(500, 'DIRECTORY_INTEGRATION_UPDATE_FAILED', 'Failed to load updated integration')
    }
    return saved
  }

  async captureUnboundLoginForReview(profile: DingTalkIdentityProfile): Promise<DirectoryLoginCaptureResult | null> {
    const corpId = normalizeText(profile.corpId)
    const profileUserId = normalizeText(profile.userId)
    const profileUnionId = normalizeText(profile.unionId)
    const profileOpenId = normalizeText(profile.openId)
    const profileExternalKey = profileUserId
      ? buildDingTalkExternalKey({
        corpId,
        userId: profileUserId,
        unionId: profileUnionId,
        openId: profileOpenId,
      })
      : null

    if (!corpId) {
      return null
    }

    const existingAccount = await query<DirectoryAccountBaseRow>(
      `SELECT id, integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key,
              name, nick, email, mobile, job_number, title, avatar_url, is_active, raw, last_seen_at,
              deprovision_policy_override, created_at, updated_at
       FROM directory_accounts
       WHERE provider = 'dingtalk'
         AND corp_id = $1
         AND (
           ($2::text IS NOT NULL AND external_key = $2)
           OR ($3::text IS NOT NULL AND external_user_id = $3)
           OR ($4::text IS NOT NULL AND union_id = $4)
           OR ($5::text IS NOT NULL AND open_id = $5)
         )
       ORDER BY CASE
         WHEN $2::text IS NOT NULL AND external_key = $2 THEN 0
         WHEN $3::text IS NOT NULL AND external_user_id = $3 THEN 1
         WHEN $4::text IS NOT NULL AND union_id = $4 AND external_user_id IS DISTINCT FROM $4 THEN 2
         WHEN $4::text IS NOT NULL AND union_id = $4 THEN 3
         WHEN $5::text IS NOT NULL AND open_id = $5 AND external_user_id IS DISTINCT FROM $5 THEN 4
       WHEN $5::text IS NOT NULL AND open_id = $5 THEN 5
         ELSE 6
       END,
       updated_at DESC
       LIMIT 1`,
      [corpId, profileExternalKey, profileUserId, profileUnionId, profileOpenId],
    )
    const existingAccountRow = existingAccount.rows[0]
    const existingExternalUserId = normalizeText(existingAccountRow?.external_user_id)
    const existingUnionId = normalizeText(existingAccountRow?.union_id)
    const existingOpenId = normalizeText(existingAccountRow?.open_id)
    const existingExternalKey = normalizeText(existingAccountRow?.external_key)

    const unionId = profileUnionId || existingUnionId
    const openId = profileOpenId || existingOpenId
    const externalUserId = profileUserId || existingExternalUserId || unionId || openId
    const externalKey = profileUserId
      ? profileExternalKey
      : existingExternalKey || buildDingTalkExternalKey({
        corpId,
        userId: existingExternalUserId,
        unionId,
        openId,
      })

    if (!externalUserId || !externalKey) {
      return null
    }

    let integrationId = normalizeText(existingAccountRow?.integration_id)
    if (!integrationId) {
      const integration = await this.findLoginCaptureIntegration(corpId)
      if (!integration) {
        return null
      }
      integrationId = integration.id
    }

    const capturedAt = new Date().toISOString()
    const rawPayload = {
      loginCapture: {
        source: 'dingtalk-auth-login',
        capturedAt,
        lastAttemptAt: capturedAt,
      },
      authProfile: {
        corpId,
        userId: profileUserId,
        unionId: profileUnionId,
        openId: profileOpenId,
        name: normalizeText(profile.name),
        nick: normalizeText(profile.nick),
        email: normalizeEmail(profile.email),
        mobile: normalizeText(profile.mobile),
        avatarUrl: normalizeText(profile.avatarUrl),
      },
    }

    const name = sanitizeName(profile.name, normalizeText(profile.nick) || normalizeText(existingAccountRow?.name) || externalUserId)
    const nick = sanitizeName(profile.nick, normalizeText(existingAccountRow?.nick) || name)
    const email = normalizeEmail(profile.email) || normalizeEmail(existingAccountRow?.email)
    const mobile = normalizeText(profile.mobile) || normalizeText(existingAccountRow?.mobile)
    const avatarUrl = normalizeText(profile.avatarUrl) || normalizeText(existingAccountRow?.avatar_url)

    let accountId = normalizeText(existingAccountRow?.id)
    const created = !accountId
    if (!accountId) {
      const inserted = await query<{ id: string }>(
        `INSERT INTO directory_accounts (
           id, integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key,
           name, nick, email, mobile, job_number, title, avatar_url, is_active, raw, last_seen_at,
           deprovision_policy_override, created_at, updated_at
         )
         VALUES ($1, $2, 'dingtalk', $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, NULL, $12, true, $13::jsonb, NOW(), NULL, NOW(), NOW())
         RETURNING id`,
        [
          crypto.randomUUID(),
          integrationId,
          corpId,
          externalUserId,
          unionId,
          openId,
          externalKey,
          name,
          nick,
          email,
          mobile,
          avatarUrl,
          JSON.stringify(rawPayload),
        ],
      )
      accountId = normalizeText(inserted.rows[0]?.id)
    } else {
      await query(
        `UPDATE directory_accounts
         SET corp_id = $2,
             external_user_id = $3,
             union_id = $4,
             open_id = $5,
             external_key = $6,
             name = $7,
             nick = $8,
             email = $9,
             mobile = $10,
             avatar_url = $11,
             is_active = true,
             raw = COALESCE(raw, '{}'::jsonb) || $12::jsonb,
             last_seen_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [
          accountId,
          corpId,
          externalUserId,
          unionId,
          openId,
          externalKey,
          name,
          nick,
          email,
          mobile,
          avatarUrl,
          JSON.stringify(rawPayload),
        ],
      )
    }

    if (!accountId) {
      throw new DirectorySyncError(500, 'DIRECTORY_ACCOUNT_CAPTURE_FAILED', 'Failed to capture DingTalk login candidate')
    }

    await this.cleanupDuplicateLoginCaptureAccounts(accountId, corpId, unionId, openId)

    let link = await this.reconcileAccountLink(accountId)
    if (link.status === 'pending') {
      link = await this.upsertLink(accountId, {
        status: 'pending',
        matchStrategy: null,
        localUserId: null,
        reviewNote: 'captured from DingTalk login; awaiting administrator review',
        reviewedBy: null,
      })
    }

    await auditLog({
      actorType: 'system',
      action: created ? 'capture-unbound-login' : 'refresh-unbound-login',
      resourceType: 'directory-account',
      resourceId: accountId,
      meta: {
        integrationId,
        provider: 'dingtalk',
        corpId,
        externalKey,
        linkStatus: link.status,
      },
    })

    return {
      integrationId,
      accountId,
      created,
      linkStatus: link.status,
    }
  }

  private async cleanupDuplicateLoginCaptureAccounts(
    primaryAccountId: string,
    corpId: string,
    unionId: string | null,
    openId: string | null,
  ): Promise<void> {
    if (!unionId && !openId) return

    const duplicates = await query<DirectoryLoginCaptureCandidateRow>(
      `SELECT a.id, a.integration_id, a.provider, a.corp_id, a.external_user_id, a.union_id, a.open_id, a.external_key,
              a.name, a.nick, a.email, a.mobile, a.job_number, a.title, a.avatar_url, a.is_active, a.raw, a.last_seen_at,
              a.deprovision_policy_override, a.created_at, a.updated_at,
              l.local_user_id, l.link_status
       FROM directory_accounts a
       LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
       WHERE a.provider = 'dingtalk'
         AND a.corp_id = $1
         AND a.id <> $2
         AND (
           ($3::text IS NOT NULL AND a.union_id = $3)
           OR ($4::text IS NOT NULL AND a.open_id = $4)
         )`,
      [corpId, primaryAccountId, unionId, openId],
    )

    const duplicateIds = duplicates.rows
      .filter((row) => !normalizeText(row.local_user_id) && normalizeLinkStatus(row.link_status, 'pending') === 'pending')
      .map((row) => row.id)

    if (duplicateIds.length === 0) return

    await query(
      `DELETE FROM directory_accounts
       WHERE id = ANY($1::uuid[])`,
      [duplicateIds],
    )

    for (const duplicateId of duplicateIds) {
      await auditLog({
        actorType: 'system',
        action: 'dedupe-unbound-login-capture',
        resourceType: 'directory-account',
        resourceId: duplicateId,
        meta: {
          primaryAccountId,
          corpId,
          unionId,
          openId,
        },
      })
    }
  }

  async testIntegration(integrationId: string, actorId: string): Promise<{ ok: true; corpId: string; departmentSampleCount: number }> {
    const integration = await this.getIntegrationRow(integrationId)
    if (!integration) {
      throw new DirectorySyncError(404, 'DIRECTORY_INTEGRATION_NOT_FOUND', 'Directory integration not found')
    }
    const config = mapIntegrationConfig(integration.config)
    if (!config.appKey || !config.appSecret) {
      throw new DirectorySyncError(400, 'DINGTALK_CREDENTIALS_REQUIRED', 'appKey and appSecret are required')
    }

    const accessToken = await this.fetchAccessToken(config)
    const departments = await this.fetchDepartmentChildren(config, accessToken, config.rootDepartmentId)

    await auditLog({
      actorId,
      actorType: 'user',
      action: 'test',
      resourceType: 'directory-integration',
      resourceId: integrationId,
      meta: {
        provider: 'dingtalk',
        corpId: integration.corp_id,
        departmentSampleCount: departments.length,
      },
    })

    return {
      ok: true,
      corpId: integration.corp_id,
      departmentSampleCount: departments.length,
    }
  }

  async listRuns(integrationId: string): Promise<DirectorySyncRunRecord[]> {
    const result = await query<DirectorySyncRunRow>(
      `SELECT id, integration_id, status, started_at, finished_at, cursor_before, cursor_after, stats, error_message, meta, created_at, updated_at
       FROM directory_sync_runs
       WHERE integration_id = $1
       ORDER BY started_at DESC`,
      [integrationId],
    )
    return result.rows.map(mapSyncRun)
  }

  async listActivity(integrationId: string, options: DirectoryActivityListOptions): Promise<DirectoryActivityListResult> {
    const integration = await this.getIntegrationRow(integrationId)
    if (!integration) {
      throw new DirectorySyncError(404, 'DIRECTORY_INTEGRATION_NOT_FOUND', 'Directory integration not found')
    }

    const page = Math.max(1, Math.trunc(options.page))
    const pageSize = normalizePageSize(options.pageSize)
    const q = normalizeText(options.q)
    const action = normalizeText(options.action)
    const resourceType = options.resourceType ?? null
    const accountId = normalizeText(options.accountId)
    const from = normalizeText(options.from)
    const to = normalizeText(options.to)
    const values: unknown[] = [
      [
        'directory-integration',
        'directory-account',
        'directory-sync-alert',
        'directory-template-center',
      ] satisfies DirectoryActivityResourceType[],
      integrationId,
    ]
    const where = [
      'al.resource_type = ANY($1::text[])',
      `(
        (al.resource_type IN ('directory-integration', 'directory-template-center') AND al.resource_id = $2)
        OR (al.resource_type = 'directory-account' AND da.integration_id = $2)
        OR (al.resource_type = 'directory-sync-alert' AND dsa.integration_id = $2)
        OR COALESCE(al.action_details->>'integrationId', '') = $2
      )`,
    ]

    if (action) {
      values.push(action)
      where.push(`al.action = $${values.length}`)
    }

    if (resourceType) {
      values.push(resourceType)
      where.push(`al.resource_type = $${values.length}`)
    }

    if (accountId) {
      values.push(accountId)
      where.push(`(
        (al.resource_type = 'directory-account' AND al.resource_id = $${values.length})
        OR COALESCE(al.action_details->>'accountId', '') = $${values.length}
      )`)
    }

    if (q) {
      values.push(`%${q}%`)
      where.push(`(
        COALESCE(al.resource_id, '') ILIKE $${values.length}
        OR COALESCE(al.action, '') ILIKE $${values.length}
        OR COALESCE(al.action_details::text, '') ILIKE $${values.length}
        OR COALESCE(al.user_email, '') ILIKE $${values.length}
        OR COALESCE(al.user_name, '') ILIKE $${values.length}
        OR COALESCE(da.name, '') ILIKE $${values.length}
        OR COALESCE(da.email, '') ILIKE $${values.length}
        OR COALESCE(di.name, '') ILIKE $${values.length}
      )`)
    }

    if (from) {
      values.push(from)
      where.push(`al.created_at >= $${values.length}`)
    }

    if (to) {
      values.push(to)
      where.push(`al.created_at <= $${values.length}`)
    }

    const joinedFrom = `
      FROM audit_logs al
      LEFT JOIN directory_accounts da
        ON al.resource_type = 'directory-account'
       AND da.id::text = al.resource_id
      LEFT JOIN directory_sync_alerts dsa
        ON al.resource_type = 'directory-sync-alert'
       AND dsa.id::text = al.resource_id
      LEFT JOIN directory_integrations di
        ON di.id = COALESCE(
          CASE WHEN al.resource_type IN ('directory-integration', 'directory-template-center') THEN al.resource_id END,
          da.integration_id,
          dsa.integration_id,
          NULLIF(al.action_details->>'integrationId', '')
        )
      WHERE ${where.join(' AND ')}
    `

    const summaryResult = await query<DirectoryActivityListSummaryRow & { total: number }>(
      `SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE al.resource_type = 'directory-integration')::int AS "integrationActions",
          COUNT(*) FILTER (WHERE al.resource_type = 'directory-account')::int AS "accountActions",
          COUNT(*) FILTER (WHERE al.resource_type = 'directory-sync-alert')::int AS "alertActions",
          COUNT(*) FILTER (WHERE al.resource_type = 'directory-template-center')::int AS "templateActions",
          COUNT(*) FILTER (WHERE al.action IN ('sync', 'schedule', 'test'))::int AS "syncActions"
       ${joinedFrom}`,
      values,
    )
    const summaryRow = summaryResult.rows[0]
    const total = summaryRow?.total ?? 0

    values.push(pageSize, (page - 1) * pageSize)
    const itemsResult = await query<DirectoryActivityRow>(
      `SELECT
          al.id::text AS id,
          al.created_at,
          al.event_type,
          al.event_category,
          al.event_severity,
          al.action,
          al.resource_type,
          al.resource_id,
          al.user_id::text AS user_id,
          al.user_name,
          al.user_email,
          al.action_details,
          al.error_code,
          COALESCE(
            di.id,
            NULLIF(al.action_details->>'integrationId', '')
          ) AS integration_id,
          di.name AS integration_name,
          COALESCE(da.id::text, NULLIF(al.action_details->>'accountId', '')) AS account_id,
          da.name AS account_name,
          da.email AS account_email,
          da.external_user_id AS account_external_user_id
       ${joinedFrom}
       ORDER BY al.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )

    return {
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      hasNextPage: page * pageSize < total,
      hasPreviousPage: page > 1,
      summary: {
        total,
        integrationActions: summaryRow?.integrationActions ?? 0,
        accountActions: summaryRow?.accountActions ?? 0,
        syncActions: summaryRow?.syncActions ?? 0,
        alertActions: summaryRow?.alertActions ?? 0,
        templateActions: summaryRow?.templateActions ?? 0,
      },
      items: itemsResult.rows.map(mapDirectoryActivity),
    }
  }

  async listDepartments(integrationId: string): Promise<DirectoryDepartmentRecord[]> {
    const result = await query<DirectoryDepartmentRow>(
      `SELECT id, integration_id, external_department_id, external_parent_department_id, name, full_path, order_index,
              is_active, raw, last_seen_at, created_at, updated_at
       FROM directory_departments
       WHERE integration_id = $1
       ORDER BY COALESCE(full_path, name) ASC, order_index ASC NULLS LAST, name ASC`,
      [integrationId],
    )
    return result.rows.map(mapDepartment)
  }

  async listAccounts(integrationId: string, options: DirectoryAccountListOptions): Promise<DirectoryAccountListResult> {
    const integration = await this.getIntegrationRow(integrationId)
    if (!integration) {
      throw new DirectorySyncError(404, 'DIRECTORY_INTEGRATION_NOT_FOUND', 'Directory integration not found')
    }

    const q = normalizeText(options.q)
    const linkStatus = options.linkStatus ? normalizeLinkStatus(options.linkStatus) : null
    const matchStrategy = options.matchStrategy ? normalizeMatchStrategy(options.matchStrategy) : null
    const isActive = normalizeBooleanFilter(options.isActive)
    const dingtalkAuthEnabled = normalizeBooleanFilter(options.dingtalkAuthEnabled)
    const isBound = normalizeBooleanFilter(options.isBound)
    const departmentId = normalizeText(options.departmentId)
    const page = Math.max(1, Math.trunc(options.page))
    const pageSize = normalizePageSize(options.pageSize)
    const values: unknown[] = [
      integrationId,
      q ? `%${q}%` : null,
      linkStatus,
      isActive,
      matchStrategy,
      dingtalkAuthEnabled,
      isBound,
      departmentId,
      pageSize,
      (page - 1) * pageSize,
    ]
    const isBoundSql = `EXISTS(
      SELECT 1
      FROM user_external_identities i
      WHERE i.provider = 'dingtalk'
        AND i.external_key = a.external_key
        AND i.local_user_id = l.local_user_id
    )`
    const sharedFromAndWhere = `
      FROM directory_accounts a
      LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
      LEFT JOIN user_external_auth_grants g ON g.local_user_id = l.local_user_id AND g.provider = 'dingtalk'
      WHERE a.integration_id = $1
        AND (
          $2::text IS NULL
          OR a.name ILIKE $2
          OR a.email ILIKE $2
          OR a.mobile ILIKE $2
          OR a.external_user_id ILIKE $2
          OR EXISTS(
            SELECT 1
            FROM directory_account_departments ad_search
            JOIN directory_departments d_search ON d_search.id = ad_search.directory_department_id
            WHERE ad_search.directory_account_id = a.id
              AND (d_search.name ILIKE $2 OR d_search.full_path ILIKE $2)
          )
        )
        AND ($3::text IS NULL OR COALESCE(l.link_status, 'pending') = $3)
        AND ($4::boolean IS NULL OR a.is_active = $4)
        AND ($5::text IS NULL OR COALESCE(l.match_strategy, '') = $5)
        AND ($6::boolean IS NULL OR COALESCE(g.enabled, false) = $6)
        AND ($7::boolean IS NULL OR ${isBoundSql} = $7)
        AND (
          $8::text IS NULL
          OR EXISTS(
            SELECT 1
            FROM directory_account_departments ad_filter
            JOIN directory_departments d_filter ON d_filter.id = ad_filter.directory_department_id
            WHERE ad_filter.directory_account_id = a.id
              AND (d_filter.id::text = $8 OR d_filter.external_department_id = $8)
          )
        )`

    const summaryResult = await query<DirectoryAccountListSummary & { total: number }>(
      `SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE COALESCE(l.link_status, 'pending') = 'linked')::int AS linked,
          COUNT(*) FILTER (WHERE COALESCE(l.link_status, 'pending') = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE COALESCE(l.link_status, 'pending') = 'conflict')::int AS conflict,
          COUNT(*) FILTER (WHERE COALESCE(l.link_status, 'pending') = 'ignored')::int AS ignored,
          COUNT(*) FILTER (WHERE a.is_active = true)::int AS active,
          COUNT(*) FILTER (WHERE a.is_active = false)::int AS inactive,
          COUNT(*) FILTER (WHERE COALESCE(g.enabled, false) = true)::int AS "dingtalkAuthEnabled",
          COUNT(*) FILTER (WHERE COALESCE(g.enabled, false) = false)::int AS "dingtalkAuthDisabled",
          COUNT(*) FILTER (WHERE ${isBoundSql})::int AS bound,
          COUNT(*) FILTER (WHERE NOT ${isBoundSql})::int AS unbound
       ${sharedFromAndWhere}`,
      values.slice(0, 8),
    )
    const summaryRow = summaryResult.rows[0]
    const total = summaryRow?.total ?? 0

    const listResult = await query<DirectoryAccountListRow>(
      `SELECT
          a.id,
          a.integration_id,
          a.provider,
          a.corp_id,
          a.external_user_id,
          a.union_id,
          a.open_id,
          a.external_key,
          a.name,
          a.nick,
          a.email,
          a.mobile,
          a.job_number,
          a.title,
          a.avatar_url,
          a.is_active,
          a.raw,
          a.last_seen_at,
          a.deprovision_policy_override,
          a.created_at,
          a.updated_at,
          l.link_status,
          l.match_strategy,
          l.local_user_id,
          l.review_note,
          u.email AS linked_user_email,
          u.name AS linked_user_name,
          u.is_active AS linked_user_is_active,
          g.enabled AS dingtalk_auth_enabled,
          ${isBoundSql} AS is_bound,
          COALESCE(array_remove(array_agg(DISTINCT d.name), NULL), ARRAY[]::text[]) AS department_names
       FROM directory_accounts a
       LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
       LEFT JOIN users u ON u.id = l.local_user_id
       LEFT JOIN user_external_auth_grants g ON g.local_user_id = l.local_user_id AND g.provider = 'dingtalk'
       LEFT JOIN directory_account_departments ad ON ad.directory_account_id = a.id
       LEFT JOIN directory_departments d ON d.id = ad.directory_department_id
       WHERE a.integration_id = $1
         AND (
           $2::text IS NULL
           OR a.name ILIKE $2
           OR a.email ILIKE $2
           OR a.mobile ILIKE $2
           OR a.external_user_id ILIKE $2
           OR EXISTS(
             SELECT 1
             FROM directory_account_departments ad_search
             JOIN directory_departments d_search ON d_search.id = ad_search.directory_department_id
             WHERE ad_search.directory_account_id = a.id
               AND (d_search.name ILIKE $2 OR d_search.full_path ILIKE $2)
           )
         )
         AND ($3::text IS NULL OR COALESCE(l.link_status, 'pending') = $3)
         AND ($4::boolean IS NULL OR a.is_active = $4)
         AND ($5::text IS NULL OR COALESCE(l.match_strategy, '') = $5)
         AND ($6::boolean IS NULL OR COALESCE(g.enabled, false) = $6)
         AND ($7::boolean IS NULL OR ${isBoundSql} = $7)
         AND (
           $8::text IS NULL
           OR EXISTS(
           SELECT 1
           FROM directory_account_departments ad_filter
           JOIN directory_departments d_filter ON d_filter.id = ad_filter.directory_department_id
           WHERE ad_filter.directory_account_id = a.id
               AND (d_filter.id::text = $8 OR d_filter.external_department_id = $8)
           )
         )
       GROUP BY a.id, l.link_status, l.match_strategy, l.local_user_id, l.review_note, u.email, u.name, u.is_active, g.enabled
       ORDER BY a.updated_at DESC, a.created_at DESC
       LIMIT $9 OFFSET $10`,
      values,
    )

    return {
      total,
      page,
      pageSize,
      pageCount: total > 0 ? Math.ceil(total / pageSize) : 1,
      hasNextPage: page * pageSize < total,
      hasPreviousPage: page > 1,
      summary: {
        linked: summaryRow?.linked ?? 0,
        pending: summaryRow?.pending ?? 0,
        conflict: summaryRow?.conflict ?? 0,
        ignored: summaryRow?.ignored ?? 0,
        active: summaryRow?.active ?? 0,
        inactive: summaryRow?.inactive ?? 0,
        dingtalkAuthEnabled: summaryRow?.dingtalkAuthEnabled ?? 0,
        dingtalkAuthDisabled: summaryRow?.dingtalkAuthDisabled ?? 0,
        bound: summaryRow?.bound ?? 0,
        unbound: summaryRow?.unbound ?? 0,
      },
      items: listResult.rows.map((row) => mapDirectoryAccount(row, normalizeDeprovisionPolicy(integration.default_deprovision_policy))),
    }
  }

  async getAccount(accountId: string): Promise<DirectoryAccountRecord> {
    const accountResult = await query<DirectoryAccountListRow & { default_deprovision_policy: string }>(
      `SELECT
          a.id,
          a.integration_id,
          a.provider,
          a.corp_id,
          a.external_user_id,
          a.union_id,
          a.open_id,
          a.external_key,
          a.name,
          a.nick,
          a.email,
          a.mobile,
          a.job_number,
          a.title,
          a.avatar_url,
          a.is_active,
          a.raw,
          a.last_seen_at,
          a.deprovision_policy_override,
          a.created_at,
          a.updated_at,
          l.link_status,
          l.match_strategy,
          l.local_user_id,
          l.review_note,
          u.email AS linked_user_email,
          u.name AS linked_user_name,
          u.is_active AS linked_user_is_active,
          g.enabled AS dingtalk_auth_enabled,
          EXISTS(
            SELECT 1
            FROM user_external_identities i
            WHERE i.provider = 'dingtalk'
              AND i.external_key = a.external_key
              AND i.local_user_id = l.local_user_id
          ) AS is_bound,
          ARRAY[]::text[] AS department_names,
          i.default_deprovision_policy
       FROM directory_accounts a
       JOIN directory_integrations i ON i.id = a.integration_id
       LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
       LEFT JOIN users u ON u.id = l.local_user_id
       LEFT JOIN user_external_auth_grants g ON g.local_user_id = l.local_user_id AND g.provider = 'dingtalk'
       WHERE a.id = $1
       LIMIT 1`,
      [accountId],
    )
    const row = accountResult.rows[0]
    if (!row) {
      throw new DirectorySyncError(404, 'DIRECTORY_ACCOUNT_NOT_FOUND', 'Directory account not found')
    }

    const departments = await query<{ name: string }>(
      `SELECT d.name
       FROM directory_account_departments ad
       JOIN directory_departments d ON d.id = ad.directory_department_id
       WHERE ad.directory_account_id = $1
       ORDER BY ad.is_primary DESC, COALESCE(d.full_path, d.name) ASC`,
      [accountId],
    )

    return mapDirectoryAccount(
      row,
      normalizeDeprovisionPolicy(row.default_deprovision_policy),
      departments.rows.map((item) => item.name),
    )
  }

  async syncIntegration(integrationId: string, actorId: string, options: { source?: 'manual' | 'scheduled' } = {}): Promise<DirectorySyncRunRecord> {
    const integration = await this.getIntegrationRow(integrationId)
    if (!integration) {
      throw new DirectorySyncError(404, 'DIRECTORY_INTEGRATION_NOT_FOUND', 'Directory integration not found')
    }

    const source = options.source || 'manual'
    if (this.inflight.has(integrationId)) {
      if (source === 'scheduled') {
        return this.createSkippedRun(integrationId, integration.last_cursor, actorId, 'sync already running')
      }
      throw new DirectorySyncError(409, 'DIRECTORY_SYNC_ALREADY_RUNNING', 'Directory sync is already running')
    }

    const runId = crypto.randomUUID()
    const cursorBefore = normalizeText(integration.last_cursor)
    const startedAt = new Date().toISOString()
    const config = mapIntegrationConfig(integration.config)

    this.inflight.add(integrationId)
    await query(
      `INSERT INTO directory_sync_runs (
         id, integration_id, status, started_at, cursor_before, stats, meta, created_at, updated_at
       )
       VALUES ($1, $2, 'running', NOW(), $3, $4::jsonb, $5::jsonb, NOW(), NOW())`,
      [
        runId,
        integrationId,
        encodeJsonString(cursorBefore),
        JSON.stringify({ departmentsFetched: 0, accountsFetched: 0, accountsInserted: 0, accountsUpdated: 0, linksMatched: 0, linksConflicted: 0, accountsDeactivated: 0 }),
        JSON.stringify({ source }),
      ],
    )

    try {
      const accessToken = await this.fetchAccessToken(config)
      const departments = await this.fetchAllDepartments(config, accessToken)
      const users = await this.fetchAllUsers(integration.corp_id, config, accessToken, departments)
      const stats = await this.persistSyncSnapshot(integrationId, integration.corp_id, departments, users)
      const cursorAfter = startedAt

      await query(
        `UPDATE directory_sync_runs
         SET status = 'success',
             finished_at = NOW(),
             cursor_after = $2,
             stats = $3::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [runId, encodeJsonString(cursorAfter), JSON.stringify(stats)],
      )
      await query(
        `UPDATE directory_integrations
         SET last_sync_at = NOW(),
             last_success_at = NOW(),
             last_cursor = $2,
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [integrationId, encodeJsonString(cursorAfter)],
      )

      await auditLog({
        actorId,
        actorType: 'user',
        action: source === 'scheduled' ? 'schedule' : 'sync',
        resourceType: 'directory-integration',
        resourceId: integrationId,
        meta: {
          provider: 'dingtalk',
          runId,
          source,
          stats,
        },
      })

      const run = await this.getRun(runId)
      if (!run) {
        throw new DirectorySyncError(500, 'DIRECTORY_SYNC_RUN_MISSING', 'Failed to load directory sync run')
      }
      return run
    } catch (error) {
      const message = readErrorMessage(error, 'Directory sync failed')
      await query(
        `UPDATE directory_sync_runs
         SET status = 'error',
             finished_at = NOW(),
             error_message = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [runId, message],
      )
      await query(
        `UPDATE directory_integrations
         SET last_sync_at = NOW(),
             last_error = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [integrationId, message],
      )
      try {
        await this.recordSyncAlert(
          integrationId,
          runId,
          source,
          error instanceof DirectorySyncError ? error.code : 'DIRECTORY_SYNC_FAILED',
          message,
          error instanceof DirectorySyncError ? parseObject(error.details) : {},
        )
      } catch (alertError) {
        this.logger.warn(`Failed to record directory sync alert for ${integrationId}`, alertError as Error)
      }
      throw error
    } finally {
      this.inflight.delete(integrationId)
    }
  }

  async linkExistingAccount(accountId: string, userId: string, actorId: string): Promise<DirectoryAccountRecord> {
    const account = await this.getAccountBase(accountId)
    const user = await this.getUserById(userId)
    if (!account || !user) {
      throw new DirectorySyncError(404, 'DIRECTORY_LINK_TARGET_NOT_FOUND', 'Directory account or local user not found')
    }

    await this.upsertLink(accountId, {
      status: 'linked',
      matchStrategy: 'manual',
      localUserId: userId,
      reviewNote: 'linked manually',
      reviewedBy: actorId,
    })

    await auditLog({
      actorId,
      actorType: 'user',
      action: 'link',
      resourceType: 'directory-account',
      resourceId: accountId,
      meta: {
        integrationId: account.integration_id,
        accountId,
        localUserId: userId,
        strategy: 'manual',
      },
    })

    return this.getAccount(accountId)
  }

  async autoLinkExistingAccountByEmail(accountId: string, actorId: string): Promise<DirectoryAccountRecord> {
    const account = await this.getAccountBase(accountId)
    if (!account) {
      throw new DirectorySyncError(404, 'DIRECTORY_ACCOUNT_NOT_FOUND', 'Directory account not found')
    }

    const email = normalizeEmail(account.email)
    if (!email) {
      throw new DirectorySyncError(400, 'DIRECTORY_EMAIL_REQUIRED', 'Directory account is missing a usable email address')
    }

    const user = await this.findUserByEmail(email)
    if (!user) {
      throw new DirectorySyncError(404, 'DIRECTORY_EMAIL_MATCH_NOT_FOUND', 'No unique MetaSheet user matches this email')
    }

    await this.upsertLink(accountId, {
      status: 'linked',
      matchStrategy: 'email_exact',
      localUserId: user.id,
      reviewNote: 'linked manually by exact email',
      reviewedBy: actorId,
    })

    await auditLog({
      actorId,
      actorType: 'user',
      action: 'link',
      resourceType: 'directory-account',
      resourceId: accountId,
      meta: {
        integrationId: account.integration_id,
        accountId,
        localUserId: user.id,
        strategy: 'email_exact',
        source: 'manual-auto-link',
      },
    })

    return this.getAccount(accountId)
  }

  async provisionUser(accountId: string, input: { email?: string; name?: string; password?: string; authorizeDingTalk?: boolean; isActive?: boolean }, actorId: string) {
    const account = await this.getAccountBase(accountId)
    if (!account) {
      throw new DirectorySyncError(404, 'DIRECTORY_ACCOUNT_NOT_FOUND', 'Directory account not found')
    }

    const email = normalizeEmail(input.email) || buildDirectoryProvisioningEmail(account)
    ensureValidEmail(email)

    const existing = await query<{ id: string }>('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email])
    if (existing.rows.length > 0) {
      throw new DirectorySyncError(409, 'USER_ALREADY_EXISTS', 'User with this email already exists')
    }

    const password = normalizeText(input.password) || `Dir-${crypto.randomBytes(8).toString('base64url')}9A`
    const passwordValidation = validatePassword(password)
    if (!passwordValidation.valid) {
      throw new DirectorySyncError(400, 'PASSWORD_POLICY_FAILED', 'Password does not meet requirements', {
        details: passwordValidation.errors,
      })
    }

    const userId = crypto.randomUUID()
    const passwordHash = await bcrypt.hash(password, Number(process.env.BCRYPT_SALT_ROUNDS || 10))
    const name = sanitizeName(input.name, account.name || account.email || email.split('@')[0] || 'DingTalk User')
    const isActive = input.isActive !== false
    const mobile = normalizeMobile(account.mobile)

    await query(
      `INSERT INTO users (id, email, mobile, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'user', '[]'::jsonb, $6, false, NOW(), NOW())`,
      [userId, email, mobile, name, passwordHash, isActive],
    )

    await this.upsertLink(accountId, {
      status: 'linked',
      matchStrategy: 'manual',
      localUserId: userId,
      reviewNote: 'provisioned from directory',
      reviewedBy: actorId,
    })

    if (input.authorizeDingTalk === true) {
      await upsertUserExternalAuthGrant({
        provider: 'dingtalk',
        userId,
        enabled: true,
        grantedBy: actorId,
      })
      await this.bindProvisionedDingTalkIdentity(account, userId, actorId)
    }

    await auditLog({
      actorId,
      actorType: 'user',
      action: 'provision',
      resourceType: 'directory-account',
      resourceId: accountId,
      meta: {
        integrationId: account.integration_id,
        accountId,
        localUserId: userId,
        email,
        authorizeDingTalk: input.authorizeDingTalk === true,
      },
    })

    return {
      user: await this.getUserById(userId),
      temporaryPassword: password,
      account: await this.getAccount(accountId),
    }
  }

  private async bindProvisionedDingTalkIdentity(account: DirectoryAccountBaseRow, userId: string, actorId: string): Promise<void> {
    const externalKey = normalizeText(account.external_key) || buildDingTalkExternalKey({
      corpId: account.corp_id,
      userId: account.external_user_id,
      unionId: account.union_id,
      openId: account.open_id,
    })
    if (!externalKey) {
      throw new DirectorySyncError(422, 'DINGTALK_IDENTITY_INCOMPLETE', 'Directory account is missing a stable DingTalk identity key')
    }

    const existing = await findExternalIdentityByProviderAndKey('dingtalk', externalKey)
    if (existing && existing.userId !== userId) {
      throw new DirectorySyncError(409, 'DINGTALK_ALREADY_BOUND', 'This DingTalk identity is already bound to another MetaSheet user')
    }

    await upsertExternalIdentity({
      provider: 'dingtalk',
      externalKey,
      providerUserId: account.external_user_id,
      providerUnionId: account.union_id,
      providerOpenId: account.open_id,
      corpId: account.corp_id,
      userId,
      profile: parseObject(account.raw),
      boundBy: actorId,
    })
  }

  async authorizeDingTalk(accountId: string, actorId: string, enabled = true): Promise<DirectoryAccountRecord> {
    const account = await this.getAccount(accountId)
    if (!account.linkedUser?.id) {
      throw new DirectorySyncError(400, 'DIRECTORY_LINK_REQUIRED', 'Link the directory account to a MetaSheet user first')
    }

    await upsertUserExternalAuthGrant({
      provider: 'dingtalk',
      userId: account.linkedUser.id,
      enabled,
      grantedBy: actorId,
    })

    await auditLog({
      actorId,
      actorType: 'user',
      action: enabled ? 'authorize' : 'revoke',
      resourceType: 'directory-account',
      resourceId: accountId,
      meta: {
        integrationId: account.integrationId,
        accountId,
        localUserId: account.linkedUser.id,
        provider: 'dingtalk',
        enabled,
      },
    })

    return this.getAccount(accountId)
  }

  async ignoreAccount(accountId: string, actorId: string): Promise<DirectoryAccountRecord> {
    const account = await this.getAccountBase(accountId)
    if (!account) {
      throw new DirectorySyncError(404, 'DIRECTORY_ACCOUNT_NOT_FOUND', 'Directory account not found')
    }

    await this.upsertLink(accountId, {
      status: 'ignored',
      matchStrategy: null,
      localUserId: null,
      reviewNote: 'ignored by administrator',
      reviewedBy: actorId,
    })

    await auditLog({
      actorId,
      actorType: 'user',
      action: 'ignore',
      resourceType: 'directory-account',
      resourceId: accountId,
      meta: {
        integrationId: account.integration_id,
        accountId,
      },
    })

    return this.getAccount(accountId)
  }

  async unlinkAccount(accountId: string, actorId: string): Promise<DirectoryAccountRecord> {
    const account = await this.getAccount(accountId)
    if (account.isBound) {
      throw new DirectorySyncError(409, 'DIRECTORY_ACCOUNT_BOUND_EXTERNALLY', 'Unbind the DingTalk identity before unlinking this directory account')
    }

    await this.upsertLink(accountId, {
      status: 'pending',
      matchStrategy: null,
      localUserId: null,
      reviewNote: 'link removed by administrator',
      reviewedBy: actorId,
    })

    await auditLog({
      actorId,
      actorType: 'user',
      action: 'unlink',
      resourceType: 'directory-account',
      resourceId: accountId,
      meta: {
        integrationId: account.integrationId,
        accountId,
      },
    })

    return this.getAccount(accountId)
  }

  async updateDeprovisionPolicy(accountId: string, policy: DirectoryDeprovisionPolicy | null, actorId: string): Promise<DirectoryAccountRecord> {
    const account = await this.getAccountBase(accountId)
    if (!account) {
      throw new DirectorySyncError(404, 'DIRECTORY_ACCOUNT_NOT_FOUND', 'Directory account not found')
    }

    await query(
      `UPDATE directory_accounts
       SET deprovision_policy_override = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, policy === null ? null : serializeDeprovisionPolicies(policy, [])],
    )

    await auditLog({
      actorId,
      actorType: 'user',
      action: 'update',
      resourceType: 'directory-account',
      resourceId: accountId,
      meta: {
        integrationId: account.integration_id,
        accountId,
        deprovisionPolicyOverride: policy,
      },
    })

    return this.getAccount(accountId)
  }

  private async getRun(runId: string): Promise<DirectorySyncRunRecord | null> {
    const result = await query<DirectorySyncRunRow>(
      `SELECT id, integration_id, status, started_at, finished_at, cursor_before, cursor_after, stats, error_message, meta, created_at, updated_at
       FROM directory_sync_runs
       WHERE id = $1
       LIMIT 1`,
      [runId],
    )
    const row = result.rows[0]
    return row ? mapSyncRun(row) : null
  }

  private async getIntegrationRow(integrationId: string): Promise<DirectoryIntegrationRow | null> {
    const result = await query<DirectoryIntegrationRow>(
      `SELECT id, org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron,
              default_deprovision_policy, last_sync_at, last_success_at, last_cursor, last_error,
              created_at, updated_at
       FROM directory_integrations
       WHERE id = $1
       LIMIT 1`,
      [integrationId],
    )
    return result.rows[0] ?? null
  }

  private async getTemplateCenterRow(integrationId: string): Promise<DirectoryTemplateCenterRow | null> {
    const result = await query<DirectoryTemplateCenterRow>(
      `SELECT id, integration_id, team_templates, import_history, import_presets,
              created_by, updated_by, created_at, updated_at
       FROM directory_template_centers
       WHERE integration_id = $1
       LIMIT 1`,
      [integrationId],
    )
    return result.rows[0] ?? null
  }

  private async insertTemplateCenterVersion(
    centerId: string,
    integrationId: string,
    snapshot: JsonRecord,
    changeReason: string,
    actorId: string | null,
  ): Promise<void> {
    await query(
      `INSERT INTO directory_template_center_versions (
         id, center_id, integration_id, snapshot, change_reason, created_by, created_at
       )
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())`,
      [
        crypto.randomUUID(),
        centerId,
        integrationId,
        JSON.stringify(snapshot),
        changeReason,
        actorId,
      ],
    )
  }

  private calculateNextRunAt(cronExpression: string | null): string | null {
    if (!cronExpression) return null
    try {
      const expression = new SimpleCronExpression(cronExpression, process.env.TZ || 'UTC')
      expression.reset(new Date())
      return expression.next()?.toISOString() ?? null
    } catch {
      return null
    }
  }

  private resolveDirectorySyncAlertWebhookUrl(): string | null {
    return normalizeText(process.env.DIRECTORY_SYNC_ALERT_WEBHOOK_URL)
      || normalizeText(process.env.ALERT_WEBHOOK_URL)
      || null
  }

  private async recordSyncAlert(
    integrationId: string,
    runId: string | null,
    source: 'manual' | 'scheduled',
    code: string,
    message: string,
    details: JsonRecord,
  ): Promise<void> {
    const webhookUrl = source === 'scheduled' ? this.resolveDirectorySyncAlertWebhookUrl() : null
    let sentToWebhook = false

    if (webhookUrl) {
      sentToWebhook = await this.sendSyncAlertWebhook(webhookUrl, {
        integrationId,
        runId,
        source,
        code,
        message,
        details,
        occurredAt: new Date().toISOString(),
      })
    }

    await query(
      `INSERT INTO directory_sync_alerts (
         id, integration_id, run_id, level, code, message, details, sent_to_webhook, created_at, updated_at
       )
       VALUES ($1, $2, $3, 'error', $4, $5, $6::jsonb, $7, NOW(), NOW())`,
      [
        crypto.randomUUID(),
        integrationId,
        runId,
        code,
        message,
        JSON.stringify({
          ...details,
          source,
        }),
        sentToWebhook,
      ],
    )
  }

  private async sendSyncAlertWebhook(webhookUrl: string, payload: JsonRecord): Promise<boolean> {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      return response.ok
    } catch (error) {
      this.logger.warn('Failed to send directory sync alert webhook', error as Error)
      return false
    }
  }

  private async findLoginCaptureIntegration(corpId: string): Promise<DirectoryIntegrationRow | null> {
    const result = await query<DirectoryIntegrationRow>(
      `SELECT id, org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron,
              default_deprovision_policy, last_sync_at, last_success_at, last_cursor, last_error,
              created_at, updated_at
       FROM directory_integrations
       WHERE provider = 'dingtalk'
         AND corp_id = $1
         AND status = 'active'
       ORDER BY sync_enabled DESC, updated_at DESC, created_at DESC`,
      [corpId],
    )

    for (const row of result.rows) {
      const config = mapIntegrationConfig(row.config)
      if (config.captureUnboundLogins) {
        return row
      }
    }
    return null
  }

  private async getUserById(userId: string): Promise<UserRow | null> {
    const result = await query<UserRow & { is_active: boolean }>(
      `SELECT id, email, mobile, name, is_active
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId],
    )
    const row = result.rows[0]
    return row
      ? {
          id: row.id,
          email: row.email,
          mobile: row.mobile,
          name: row.name,
          is_active: row.is_active,
        }
      : null
  }

  private async getAccountBase(accountId: string): Promise<DirectoryAccountBaseRow | null> {
    const result = await query<DirectoryAccountBaseRow>(
      `SELECT id, integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key,
              name, nick, email, mobile, job_number, title, avatar_url, is_active, raw, last_seen_at,
              deprovision_policy_override, created_at, updated_at
       FROM directory_accounts
       WHERE id = $1
       LIMIT 1`,
      [accountId],
    )
    return result.rows[0] ?? null
  }

  private async createSkippedRun(integrationId: string, cursorBefore: string | null, actorId: string, reason: string): Promise<DirectorySyncRunRecord> {
    const runId = crypto.randomUUID()
    await query(
      `INSERT INTO directory_sync_runs (
         id, integration_id, status, started_at, finished_at, cursor_before, stats, meta, error_message, created_at, updated_at
       )
       VALUES ($1, $2, 'skipped', NOW(), NOW(), $3, $4::jsonb, $5::jsonb, $6, NOW(), NOW())`,
      [
        runId,
        integrationId,
        encodeJsonString(cursorBefore),
        JSON.stringify({ skipped: true }),
        JSON.stringify({ source: 'scheduled' }),
        reason,
      ],
    )

    await auditLog({
      actorId,
      actorType: 'user',
      action: 'skip',
      resourceType: 'directory-integration',
      resourceId: integrationId,
      meta: {
        reason,
      },
    })

    const run = await this.getRun(runId)
    if (!run) {
      throw new DirectorySyncError(500, 'DIRECTORY_SYNC_SKIP_FAILED', 'Failed to record skipped sync run')
    }
    return run
  }

  private async fetchAccessToken(config: DirectoryIntegrationConfig): Promise<string> {
    const payload = await fetchJson(buildQueryUrl(config.tokenUrl, {
      appkey: config.appKey,
      appsecret: config.appSecret,
    }))

    const accessToken = normalizeText(payload.access_token) || normalizeText(payload.accessToken)
    if (!accessToken) {
      throw new DirectorySyncError(502, 'DINGTALK_TOKEN_MISSING', 'DingTalk did not return an access token')
    }
    return accessToken
  }

  private async fetchAllDepartments(config: DirectoryIntegrationConfig, accessToken: string): Promise<RemoteDepartment[]> {
    const rootDepartmentId = config.rootDepartmentId
    const queue: Array<{ deptId: string; parentPath: string }> = [{ deptId: rootDepartmentId, parentPath: '' }]
    const departments: RemoteDepartment[] = []
    const visited = new Set<string>()

    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) continue

      const children = await this.fetchDepartmentChildren(config, accessToken, current.deptId)
      for (const child of children) {
        if (visited.has(child.externalDepartmentId)) continue
        visited.add(child.externalDepartmentId)
        const fullPath = current.parentPath ? `${current.parentPath} / ${child.name}` : child.name
        const entry = {
          ...child,
          fullPath,
        }
        departments.push(entry)
        queue.push({
          deptId: child.externalDepartmentId,
          parentPath: fullPath,
        })
      }
    }

    return departments
  }

  private async fetchDepartmentChildren(config: DirectoryIntegrationConfig, accessToken: string, departmentId: string): Promise<RemoteDepartment[]> {
    const payload = await fetchJson(buildQueryUrl(config.departmentsUrl, {
      access_token: accessToken,
    }), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dept_id: Number(departmentId),
      }),
    })

    const result = parseObject(payload.result)
    const items = Array.isArray(result.list)
      ? result.list
      : Array.isArray(result.departments)
        ? result.departments
        : Array.isArray(payload.result)
          ? payload.result as unknown[]
          : []

    return items
      .map((item) => parseObject(item))
      .map((item) => {
        const externalDepartmentId = normalizeText(item.dept_id) || normalizeText(item.id)
        if (!externalDepartmentId) return null
        return {
          externalDepartmentId,
          externalParentDepartmentId: normalizeText(item.parent_id) || normalizeText(item.parentid),
          name: normalizeText(item.name) || `department-${externalDepartmentId}`,
          orderIndex: Number.isFinite(Number(item.order)) ? Number(item.order) : null,
          fullPath: '',
          raw: item,
        } satisfies RemoteDepartment
      })
      .filter((item): item is RemoteDepartment => Boolean(item))
  }

  private async fetchAllUsers(corpId: string, config: DirectoryIntegrationConfig, accessToken: string, departments: RemoteDepartment[]): Promise<RemoteUserProfile[]> {
    const departmentIds = Array.from(new Set([config.rootDepartmentId, ...departments.map((item) => item.externalDepartmentId)]))
    const summaries = new Map<string, RemoteUserSummary>()

    for (const departmentId of departmentIds) {
      let cursor = 0
      let hasMore = true
      while (hasMore) {
        const page = await this.fetchDepartmentUsers(config, accessToken, departmentId, cursor)
        for (const user of page.items) {
          const existing = summaries.get(user.externalUserId)
          summaries.set(user.externalUserId, existing
            ? {
                ...existing,
                departmentIds: Array.from(new Set([...existing.departmentIds, ...user.departmentIds])),
                primaryDepartmentId: existing.primaryDepartmentId || user.primaryDepartmentId,
                email: existing.email || user.email,
                mobile: existing.mobile || user.mobile,
                jobNumber: existing.jobNumber || user.jobNumber,
                title: existing.title || user.title,
                avatarUrl: existing.avatarUrl || user.avatarUrl,
                raw: {
                  ...existing.raw,
                  ...user.raw,
                },
              }
            : user)
        }
        cursor = page.nextCursor
        hasMore = page.hasMore
      }
    }

    const profiles: RemoteUserProfile[] = []
    for (const summary of summaries.values()) {
      try {
        const detail = await this.fetchUserDetail(config, accessToken, corpId, summary)
        profiles.push(detail)
      } catch (error) {
        this.logger.warn(`Failed to fetch DingTalk user detail for ${summary.externalUserId}`, error as Error)
        profiles.push({
          ...summary,
          corpId,
          externalKey: buildDingTalkExternalKey({
            corpId,
            userId: summary.externalUserId,
            unionId: summary.unionId,
            openId: summary.openId,
          }),
        })
      }
    }

    return profiles
  }

  private async fetchDepartmentUsers(config: DirectoryIntegrationConfig, accessToken: string, departmentId: string, cursor: number): Promise<{ items: RemoteUserSummary[]; nextCursor: number; hasMore: boolean }> {
    const payload = await fetchJson(buildQueryUrl(config.usersUrl, {
      access_token: accessToken,
    }), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dept_id: Number(departmentId),
        cursor,
        size: config.pageSize,
        contain_access_limit: false,
      }),
    })

    const result = parseObject(payload.result)
    const list = Array.isArray(result.list)
      ? result.list
      : Array.isArray(result.data_list)
        ? result.data_list
        : []

    const items = list
      .map((item) => parseObject(item))
      .map((item) => {
        const externalUserId = normalizeText(item.userid) || normalizeText(item.userid) || normalizeText(item.userId)
        if (!externalUserId) return null
        return {
          externalUserId,
          name: normalizeText(item.name),
          nick: normalizeText(item.nick) || normalizeText(item.name),
          unionId: normalizeText(item.unionid) || normalizeText(item.unionId),
          openId: normalizeText(item.openid) || normalizeText(item.openId),
          email: normalizeEmail(item.email),
          mobile: normalizeText(item.mobile),
          jobNumber: normalizeText(item.job_number) || normalizeText(item.jobNumber),
          title: normalizeText(item.title) || normalizeText(item.position),
          avatarUrl: normalizeText(item.avatar) || normalizeText(item.avatarUrl),
          primaryDepartmentId: departmentId,
          departmentIds: [departmentId],
          raw: item,
        } satisfies RemoteUserSummary
      })
      .filter((item): item is RemoteUserSummary => Boolean(item))

    return {
      items,
      nextCursor: Number(result.next_cursor || result.cursor || 0),
      hasMore: result.has_more === true || result.more === true,
    }
  }

  private async fetchUserDetail(config: DirectoryIntegrationConfig, accessToken: string, corpId: string, summary: RemoteUserSummary): Promise<RemoteUserProfile> {
    const payload = await fetchJson(buildQueryUrl(config.userDetailUrl, {
      access_token: accessToken,
    }), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userid: summary.externalUserId,
      }),
    })

    const result = parseObject(payload.result)
    const departmentIds = parseStringArray(result.dept_id_list).length > 0
      ? parseStringArray(result.dept_id_list)
      : Array.isArray(result.dept_id_list)
        ? result.dept_id_list.map((item) => String(item))
        : summary.departmentIds

    const externalKey = buildDingTalkExternalKey({
      corpId,
      userId: normalizeText(result.userid) || normalizeText(result.userid) || summary.externalUserId,
      unionId: normalizeText(result.unionid) || normalizeText(result.unionId) || summary.unionId,
      openId: normalizeText(result.openid) || normalizeText(result.openId) || summary.openId,
    })

    return {
      externalUserId: normalizeText(result.userid) || normalizeText(result.userid) || summary.externalUserId,
      corpId,
      unionId: normalizeText(result.unionid) || normalizeText(result.unionId) || summary.unionId,
      openId: normalizeText(result.openid) || normalizeText(result.openId) || summary.openId,
      name: normalizeText(result.name) || summary.name,
      nick: normalizeText(result.nick) || summary.nick || summary.name,
      email: normalizeEmail(result.email) || summary.email,
      mobile: normalizeText(result.mobile) || summary.mobile,
      jobNumber: normalizeText(result.job_number) || normalizeText(result.jobNumber) || summary.jobNumber,
      title: normalizeText(result.title) || normalizeText(result.position) || summary.title,
      avatarUrl: normalizeText(result.avatar) || normalizeText(result.avatarUrl) || summary.avatarUrl,
      primaryDepartmentId: normalizeText(result.dept_id) || summary.primaryDepartmentId,
      departmentIds,
      raw: {
        ...summary.raw,
        detail: result,
      },
      externalKey,
    }
  }

  private async persistSyncSnapshot(integrationId: string, corpId: string, departments: RemoteDepartment[], users: RemoteUserProfile[]) {
    const existingDepartments = await query<{ external_department_id: string }>(
      `SELECT external_department_id
       FROM directory_departments
       WHERE integration_id = $1`,
      [integrationId],
    )
    const existingAccounts = await query<{ external_user_id: string; is_active: boolean }>(
      `SELECT external_user_id, is_active
       FROM directory_accounts
       WHERE integration_id = $1`,
      [integrationId],
    )

    const existingDepartmentIds = new Set(existingDepartments.rows.map((row) => row.external_department_id))
    const existingAccountIds = new Set(existingAccounts.rows.map((row) => row.external_user_id))
    const activeExistingAccountIds = new Set(existingAccounts.rows.filter((row) => row.is_active === true).map((row) => row.external_user_id))

    const seenDepartmentIds = new Set<string>()
    const seenExternalUserIds = new Set<string>()
    const linkReconcileTargets: string[] = []
    const accountIdToDepartmentIds = new Map<string, string[]>()

    await transaction(async (client) => {
      for (const department of departments) {
        seenDepartmentIds.add(department.externalDepartmentId)
        await client.query(
          `INSERT INTO directory_departments (
             id, integration_id, external_department_id, external_parent_department_id, name, full_path, order_index,
             is_active, raw, last_seen_at, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb, NOW(), NOW(), NOW())
           ON CONFLICT (integration_id, external_department_id) DO UPDATE
           SET external_parent_department_id = EXCLUDED.external_parent_department_id,
               name = EXCLUDED.name,
               full_path = EXCLUDED.full_path,
               order_index = EXCLUDED.order_index,
               is_active = true,
               raw = EXCLUDED.raw,
               last_seen_at = NOW(),
               updated_at = NOW()`,
          [
            crypto.randomUUID(),
            integrationId,
            department.externalDepartmentId,
            department.externalParentDepartmentId,
            department.name,
            department.fullPath,
            department.orderIndex,
            JSON.stringify(department.raw),
          ],
        )
      }

      if (seenDepartmentIds.size > 0) {
        await client.query(
          `UPDATE directory_departments
           SET is_active = false,
               updated_at = NOW()
           WHERE integration_id = $1
             AND NOT (external_department_id = ANY($2::text[]))`,
          [integrationId, Array.from(seenDepartmentIds)],
        )
      } else {
        await client.query(
          `UPDATE directory_departments
           SET is_active = false,
               updated_at = NOW()
           WHERE integration_id = $1`,
          [integrationId],
        )
      }

      for (const user of users) {
        seenExternalUserIds.add(user.externalUserId)
        const accountResult = await client.query(
          `INSERT INTO directory_accounts (
             id, integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key, name, nick,
             email, mobile, job_number, title, avatar_url, is_active, raw, last_seen_at,
             deprovision_policy_override, created_at, updated_at
           )
           VALUES ($1, $2, 'dingtalk', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, $15::jsonb, NOW(), NULL, NOW(), NOW())
           ON CONFLICT (integration_id, external_user_id) DO UPDATE
           SET union_id = EXCLUDED.union_id,
               open_id = EXCLUDED.open_id,
               external_key = EXCLUDED.external_key,
               name = EXCLUDED.name,
               nick = EXCLUDED.nick,
               email = EXCLUDED.email,
               mobile = EXCLUDED.mobile,
               job_number = EXCLUDED.job_number,
               title = EXCLUDED.title,
               avatar_url = EXCLUDED.avatar_url,
               corp_id = EXCLUDED.corp_id,
               is_active = true,
               raw = EXCLUDED.raw,
               last_seen_at = NOW(),
               updated_at = NOW()
           RETURNING id`,
          [
            crypto.randomUUID(),
            integrationId,
            corpId,
            user.externalUserId,
            user.unionId,
            user.openId,
            user.externalKey,
            user.nick || user.name,
            user.name,
            user.email,
            user.mobile,
            user.jobNumber,
            user.title,
            user.avatarUrl,
            JSON.stringify(user.raw),
          ],
        )
        const accountId = accountResult.rows[0]?.id
        if (!accountId) continue
        linkReconcileTargets.push(accountId)
        accountIdToDepartmentIds.set(accountId, user.departmentIds)
      }

      const accountIds = Array.from(accountIdToDepartmentIds.keys())
      if (accountIds.length > 0) {
        await client.query(
          `DELETE FROM directory_account_departments
           WHERE directory_account_id = ANY($1::uuid[])`,
          [accountIds],
        )

        for (const [accountId, departmentIds] of accountIdToDepartmentIds.entries()) {
          let first = true
          for (const externalDepartmentId of departmentIds) {
            const departmentResult = await client.query(
              `SELECT id
               FROM directory_departments
               WHERE integration_id = $1 AND external_department_id = $2
               LIMIT 1`,
              [integrationId, externalDepartmentId],
            )
            const directoryDepartmentId = departmentResult.rows[0]?.id
            if (!directoryDepartmentId) continue
            await client.query(
              `INSERT INTO directory_account_departments (
                 directory_account_id, directory_department_id, is_primary, created_at
               )
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (directory_account_id, directory_department_id) DO UPDATE
               SET is_primary = EXCLUDED.is_primary`,
              [accountId, directoryDepartmentId, first],
            )
            first = false
          }
        }
      }

      if (seenExternalUserIds.size > 0) {
        await client.query(
          `UPDATE directory_accounts
           SET is_active = false,
               updated_at = NOW()
           WHERE integration_id = $1
             AND NOT (external_user_id = ANY($2::text[]))`,
          [integrationId, Array.from(seenExternalUserIds)],
        )
      } else {
        await client.query(
          `UPDATE directory_accounts
           SET is_active = false,
               updated_at = NOW()
           WHERE integration_id = $1`,
          [integrationId],
        )
      }
    })

    let linksMatched = 0
    let linksConflicted = 0
    for (const accountId of linkReconcileTargets) {
      const result = await this.reconcileAccountLink(accountId)
      if (result.status === 'linked') linksMatched += 1
      if (result.status === 'conflict') linksConflicted += 1
    }

    const deactivatedExternalIds = Array.from(activeExistingAccountIds).filter((externalUserId) => !seenExternalUserIds.has(externalUserId))
    if (deactivatedExternalIds.length > 0) {
      const deactivatedAccounts = await query<{ id: string }>(
        `SELECT id
         FROM directory_accounts
         WHERE integration_id = $1 AND external_user_id = ANY($2::text[])`,
        [integrationId, deactivatedExternalIds],
      )
      await this.applyDeprovisionPolicies(deactivatedAccounts.rows.map((row) => row.id))
    }

    return {
      departmentsFetched: departments.length,
      accountsFetched: users.length,
      accountsInserted: users.filter((user) => !existingAccountIds.has(user.externalUserId)).length,
      accountsUpdated: users.filter((user) => existingAccountIds.has(user.externalUserId)).length,
      linksMatched,
      linksConflicted,
      accountsDeactivated: deactivatedExternalIds.length,
      departmentsInserted: departments.filter((department) => !existingDepartmentIds.has(department.externalDepartmentId)).length,
      departmentsUpdated: departments.filter((department) => existingDepartmentIds.has(department.externalDepartmentId)).length,
    }
  }

  private async reconcileAccountLink(accountId: string): Promise<LinkResolution> {
    const account = await this.getAccountBase(accountId)
    if (!account) {
      throw new DirectorySyncError(404, 'DIRECTORY_ACCOUNT_NOT_FOUND', 'Directory account not found')
    }

    const linkResult = await query<DirectoryAccountLinkRow>(
      `SELECT id, directory_account_id, local_user_id, link_status, match_strategy, reviewed_by, review_note, created_at, updated_at
       FROM directory_account_links
       WHERE directory_account_id = $1
       LIMIT 1`,
      [accountId],
    )
    const existingLink = linkResult.rows[0] ?? null

    const externalIdentityMatch = account.external_key
      ? await findExternalIdentityByProviderAndKey('dingtalk', account.external_key)
      : null

    if (externalIdentityMatch) {
      const emailMatch = account.email ? await this.findUserByEmail(account.email) : null
      if (emailMatch && emailMatch.id !== externalIdentityMatch.userId) {
        return this.upsertLink(accountId, {
          status: 'conflict',
          matchStrategy: 'external_identity',
          localUserId: externalIdentityMatch.userId,
          reviewNote: `email conflict:${emailMatch.id}`,
          reviewedBy: null,
        })
      }

      return this.upsertLink(accountId, {
        status: 'linked',
        matchStrategy: 'external_identity',
        localUserId: externalIdentityMatch.userId,
        reviewNote: 'matched by bound DingTalk identity',
        reviewedBy: null,
      })
    }

    if (existingLink?.link_status === 'ignored') {
      return {
        status: 'ignored',
        matchStrategy: normalizeMatchStrategy(existingLink.match_strategy),
        localUserId: normalizeText(existingLink.local_user_id),
        reviewNote: normalizeText(existingLink.review_note),
      }
    }

    if (existingLink?.match_strategy === 'manual' && existingLink.local_user_id) {
      return {
        status: normalizeLinkStatus(existingLink.link_status, 'linked'),
        matchStrategy: 'manual',
        localUserId: existingLink.local_user_id,
        reviewNote: normalizeText(existingLink.review_note),
      }
    }

    const emailMatch = account.email ? await this.findUserByEmail(account.email) : null
    if (emailMatch) {
      return this.upsertLink(accountId, {
        status: 'linked',
        matchStrategy: 'email_exact',
        localUserId: emailMatch.id,
        reviewNote: 'matched by email',
        reviewedBy: null,
      })
    }

    const mobileMatch = account.mobile
      ? await this.findUserByMobile(account.mobile)
      : null
    if (mobileMatch) {
      return this.upsertLink(accountId, {
        status: 'linked',
        matchStrategy: 'mobile_exact',
        localUserId: mobileMatch.id,
        reviewNote: 'matched by mobile',
        reviewedBy: null,
      })
    }

    return this.upsertLink(accountId, {
      status: 'pending',
      matchStrategy: null,
      localUserId: null,
      reviewNote: 'awaiting manual review',
      reviewedBy: null,
    })
  }

  private async upsertLink(accountId: string, input: { status: DirectoryLinkStatus; matchStrategy: DirectoryMatchStrategy; localUserId: string | null; reviewNote: string | null; reviewedBy: string | null }): Promise<LinkResolution> {
    await query(
      `INSERT INTO directory_account_links (
         id, directory_account_id, local_user_id, link_status, match_strategy, reviewed_by, review_note, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (directory_account_id) DO UPDATE
       SET local_user_id = EXCLUDED.local_user_id,
           link_status = EXCLUDED.link_status,
           match_strategy = EXCLUDED.match_strategy,
           reviewed_by = COALESCE(EXCLUDED.reviewed_by, directory_account_links.reviewed_by),
           review_note = EXCLUDED.review_note,
           updated_at = NOW()`,
      [
        crypto.randomUUID(),
        accountId,
        input.localUserId,
        input.status,
        input.matchStrategy,
        input.reviewedBy,
        input.reviewNote,
      ],
    )

    return {
      status: input.status,
      matchStrategy: input.matchStrategy,
      localUserId: input.localUserId,
      reviewNote: input.reviewNote,
    }
  }

  private async findUserByEmail(email: string): Promise<UserRow | null> {
    const result = await query<UserRow>(
      `SELECT id, email, name
       FROM users
       WHERE LOWER(email) = LOWER($1)
       ORDER BY created_at ASC
       LIMIT 2`,
      [email],
    )
    if (result.rows.length !== 1) return null
    return result.rows[0]
  }

  private async findUserByMobile(mobile: string): Promise<UserRow | null> {
    const normalizedMobile = normalizeMobile(mobile)
    if (!normalizedMobile) return null

    const result = await query<UserRow>(
      `SELECT id, email, mobile, name
       FROM users
       WHERE mobile IS NOT NULL
         AND regexp_replace(mobile, '\\D', '', 'g') = $1
       ORDER BY created_at ASC
       LIMIT 2`,
      [normalizedMobile],
    )
    if (result.rows.length !== 1) return null
    return result.rows[0]
  }

  private async applyDeprovisionPolicies(accountIds: string[]): Promise<void> {
    if (accountIds.length === 0) return

    const affected = await query<{
      account_id: string
      local_user_id: string | null
      effective_policy: string
    }>(
      `SELECT
          a.id AS account_id,
          l.local_user_id,
          COALESCE(a.deprovision_policy_override, i.default_deprovision_policy) AS effective_policy
       FROM directory_accounts a
       JOIN directory_integrations i ON i.id = a.integration_id
       LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
       WHERE a.id = ANY($1::uuid[])`,
      [accountIds],
    )

    for (const row of affected.rows) {
      const userId = normalizeText(row.local_user_id)
      if (!userId) continue
      const policies = normalizeDeprovisionPolicy(row.effective_policy, [])

      if (policies.includes('disable_dingtalk_auth') || policies.includes('disable_local_user')) {
        await upsertUserExternalAuthGrant({
          provider: 'dingtalk',
          userId,
          enabled: false,
          grantedBy: null,
        })
      }

      if (policies.includes('disable_local_user')) {
        await query(
          `UPDATE users
           SET is_active = false,
               updated_at = NOW()
           WHERE id = $1`,
          [userId],
        )
      }
    }
  }

  private async refreshSchedules(): Promise<void> {
    const jobs = await this.scheduler.listJobs()
    const existingJobNames = jobs.map((job) => job.name).filter(Boolean)
    for (const name of existingJobNames) {
      if (name.startsWith('directory-sync:')) {
        await this.scheduler.unschedule(name)
      }
    }
    this.scheduledJobNames.clear()

    const result = await query<DirectoryIntegrationRow>(
      `SELECT id, org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron,
              default_deprovision_policy, last_sync_at, last_success_at, last_cursor, last_error,
              created_at, updated_at
       FROM directory_integrations
       WHERE sync_enabled = true
         AND schedule_cron IS NOT NULL
         AND provider = 'dingtalk'`,
    )

    for (const integration of result.rows) {
      const jobName = `directory-sync:${integration.id}`
      try {
        const cronExpression = validateScheduleCron(normalizeText(integration.schedule_cron))
        if (!cronExpression) continue

        await this.scheduler.schedule(jobName, cronExpression, async () => {
          try {
            await this.syncIntegration(integration.id, 'system', { source: 'scheduled' })
          } catch (error) {
            this.logger.error(`Scheduled directory sync failed for ${integration.id}`, error as Error)
          }
        }, {
          timezone: process.env.TZ || 'UTC',
        })
        this.scheduledJobNames.add(jobName)
      } catch (error) {
        this.logger.error(`Failed to register directory sync schedule for ${integration.id}`, error as Error)
        try {
          await this.recordSyncAlert(
            integration.id,
            null,
            'scheduled',
            error instanceof DirectorySyncError ? error.code : 'DIRECTORY_SCHEDULE_REGISTER_FAILED',
            readErrorMessage(error, 'Failed to register directory sync schedule'),
            {
              scheduleCron: normalizeText(integration.schedule_cron),
            },
          )
        } catch (alertError) {
          this.logger.warn(`Failed to record directory schedule alert for ${integration.id}`, alertError as Error)
        }
      }
    }
  }
}

export const directorySyncService = new DirectorySyncService()
