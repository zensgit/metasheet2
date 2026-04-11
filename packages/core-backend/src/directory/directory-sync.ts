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

const logger = new Logger('DirectorySync')
const DEFAULT_ORG_ID = 'default'
const DEFAULT_PROVIDER = 'dingtalk'
const DEFAULT_ROOT_DEPARTMENT_ID = '1'
const DEFAULT_PAGE_SIZE = 50

type JsonRecord = Record<string, unknown>

type DirectoryIntegrationConfig = {
  appKey: string
  appSecret: string
  rootDepartmentId: string
  baseUrl?: string
  pageSize?: number
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

type DirectoryDepartmentRow = {
  id: string
  external_department_id: string
}

type DirectoryAccountRow = {
  id: string
  corp_id: string | null
  external_user_id: string
  union_id: string | null
  open_id: string | null
  external_key: string
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
  local_user_name: string | null
  department_paths: string[] | null
}

type DirectoryBindingUserRow = {
  id: string
  email: string
  name: string | null
  role: string
  is_active: boolean
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
  syncEnabled?: boolean
  scheduleCron?: string | null
  defaultDeprovisionPolicy?: string
  status?: string
}

export type DirectoryIntegrationTestResult = {
  corpId: string
  rootDepartmentId: string
  appKey: string
  departmentSampleCount: number
  sampledDepartments: Array<{ id: string; name: string }>
  userSampleCount: number
  sampledUsers: Array<{ userId: string; name: string }>
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
    name: string | null
  } | null
  departmentPaths: string[]
}

export type DirectoryAccountBindInput = {
  localUserRef: string
  adminUserId: string
  enableDingTalkGrant?: boolean
}

export type DirectoryAccountUnbindInput = {
  adminUserId: string
}

export type DirectoryAccountMutationResult = {
  account: DirectoryIntegrationAccountSummary
  previousLocalUser: {
    id: string
    email: string | null
    name: string | null
  } | null
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

function normalizePageSize(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_PAGE_SIZE
  return Math.min(Math.max(Math.trunc(numeric), 1), 100)
}

function parseIntegrationConfig(row: Pick<DirectoryIntegrationRow, 'config'>): DirectoryIntegrationConfig {
  const config = parseJsonRecord(row.config)
  const appKey = normalizeText(config.appKey)
  const appSecret = normalizeText(config.appSecret)
  const rootDepartmentId = normalizeText(config.rootDepartmentId) || DEFAULT_ROOT_DEPARTMENT_ID
  const baseUrl = normalizeOptionalText(config.baseUrl) ?? undefined
  const pageSize = normalizePageSize(config.pageSize)
  return { appKey, appSecret, rootDepartmentId, baseUrl, pageSize }
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

function normalizeIntegrationInput(
  input: DirectoryIntegrationInput,
  current?: DirectoryIntegrationConfig,
): DirectoryIntegrationInput & Required<Pick<DirectoryIntegrationInput, 'name' | 'corpId' | 'appKey' | 'appSecret' | 'rootDepartmentId' | 'defaultDeprovisionPolicy' | 'status'>> {
  const name = normalizeText(input.name)
  const corpId = normalizeText(input.corpId)
  const appKey = normalizeText(input.appKey)
  const appSecret = normalizeText(input.appSecret) || current?.appSecret || ''
  const rootDepartmentId = normalizeText(input.rootDepartmentId) || current?.rootDepartmentId || DEFAULT_ROOT_DEPARTMENT_ID
  const defaultDeprovisionPolicy = normalizeText(input.defaultDeprovisionPolicy) || 'mark_inactive'
  const status = normalizeText(input.status) || 'active'

  if (!name) throw new Error('Integration name is required')
  if (!corpId) throw new Error('corpId is required')
  if (!appKey) throw new Error('appKey is required')
  if (!appSecret) throw new Error('appSecret is required')

  return {
    ...input,
    name,
    corpId,
    appKey,
    appSecret,
    rootDepartmentId,
    baseUrl: normalizeOptionalText(input.baseUrl) ?? current?.baseUrl,
    pageSize: normalizePageSize(input.pageSize ?? current?.pageSize),
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
        appSecret: normalized.appSecret,
        rootDepartmentId: normalized.rootDepartmentId,
        baseUrl: normalized.baseUrl ?? null,
        pageSize: normalized.pageSize,
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
        appSecret: normalized.appSecret,
        rootDepartmentId: normalized.rootDepartmentId,
        baseUrl: normalized.baseUrl ?? null,
        pageSize: normalized.pageSize,
      }),
      Boolean(normalized.syncEnabled),
      normalized.scheduleCron,
      normalized.defaultDeprovisionPolicy,
    ],
  )

  return summarizeIntegration(result.rows[0])
}

export async function testDirectoryIntegration(input: DirectoryIntegrationInput): Promise<DirectoryIntegrationTestResult> {
  const normalized = normalizeIntegrationInput(input)
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

  return {
    corpId: normalized.corpId,
    rootDepartmentId: normalized.rootDepartmentId,
    appKey: normalized.appKey,
    departmentSampleCount: departments.length,
    sampledDepartments: departments.slice(0, 5).map((department) => ({ id: department.id, name: department.name })),
    userSampleCount: users.length,
    sampledUsers: users.slice(0, 5).map((user) => ({ userId: user.userId, name: user.name })),
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
): Promise<{ integration: DirectoryIntegrationSummary; run: DirectorySyncRunSummary }> {
  const integration = await getIntegrationRow(integrationId)
  if (!integration) throw new Error('Directory integration not found')

  const config = parseIntegrationConfig(integration)
  const runResult = await query<DirectoryRunRow>(
    `INSERT INTO directory_sync_runs (
       integration_id, status, started_at, stats, meta, triggered_by, trigger_source, created_at, updated_at
     )
     VALUES ($1, 'running', NOW(), '{}'::jsonb, '{}'::jsonb, $2, 'manual', NOW(), NOW())
     RETURNING id, integration_id, status, started_at, finished_at, stats, error_message, triggered_by, trigger_source, created_at, updated_at`,
    [integrationId, triggeredBy],
  )
  const runId = runResult.rows[0].id

  try {
    const departments = await fetchAllDepartments(config, integration.name)
    const departmentPathMap = buildDepartmentPathMap(departments)
    const users = await fetchAllUsers(config, departments)
    const syncTimestamp = new Date().toISOString()

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
          `SELECT id, external_department_id
           FROM directory_departments
           WHERE integration_id = $1`,
          [integrationId],
        ),
        client.query(
          `SELECT id, corp_id, external_user_id, union_id, open_id, external_key, email, mobile
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
      for (const account of accountIdMap.values()) {
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
              localUserId = null
              linkStatus = 'unmatched'
              matchStrategy = 'none'
            }
          }
        }

        if (linkStatus === 'linked') linkedCount += 1
        else if (linkStatus === 'pending') pendingCount += 1
        else unmatchedCount += 1

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

      const stats = {
        departmentsSynced: departments.size,
        accountsSynced: users.size,
        linkedCount,
        pendingCount,
        unmatchedCount,
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

async function getDirectoryAccountSummary(accountId: string): Promise<DirectoryIntegrationAccountSummary | null> {
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
       u.id, u.email, u.name`,
    [accountId],
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
            name,
            COALESCE(role, 'user') AS role,
            COALESCE(is_active, TRUE) AS is_active
     FROM users
     WHERE id = $1 OR LOWER(email) = LOWER($1)
     ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END
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
         u.id, u.email, u.name
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

  const identityExternalKey = buildDingTalkIdentityExternalKey(account.corp_id, account.open_id, account.union_id)
  if (!identityExternalKey) {
    throw new Error('Directory account is missing DingTalk openId/unionId and cannot be pre-bound for DingTalk login')
  }

  const localUser = await resolveDirectoryBindingUser(normalizedLocalUserRef)
  if (!localUser) throw new Error('Local user not found')

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

  await transaction(async (client) => {
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

export async function unbindDirectoryAccount(
  directoryAccountId: string,
  input: DirectoryAccountUnbindInput,
): Promise<DirectoryAccountMutationResult> {
  const normalizedAccountId = normalizeText(directoryAccountId)
  const normalizedAdminUserId = normalizeText(input.adminUserId)

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
    }

    await client.query(
      `INSERT INTO directory_account_links (
         directory_account_id, local_user_id, link_status, match_strategy, reviewed_by, review_note, created_at, updated_at
       )
       VALUES ($1, NULL, 'unmatched', 'manual_unbind', $2, 'unbound by admin', NOW(), NOW())
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
