import { query } from '../../db/pg'
import { decryptStoredSecretValue, normalizeStoredSecretValue } from '../../security/encrypted-secrets'
import {
  fetchDingTalkAppAccessToken,
  sendDingTalkWorkNotification,
  type DingTalkMessageConfig,
  type DingTalkWorkNotificationResult,
  type DingTalkWorkNotificationRuntimeStatus,
} from './client'

const DEFAULT_PROVIDER = 'dingtalk'
const AGENT_ID_CONFIG_KEY = 'workNotificationAgentId'

type JsonRecord = Record<string, unknown>

type DirectoryIntegrationConfigRow = {
  id: string
  name: string
  status: string
  config: JsonRecord | string | null
  updated_at: string
}

export type DingTalkWorkNotificationRuntimeStatusWithStore =
  DingTalkWorkNotificationRuntimeStatus & {
    source: 'env' | 'directory_integration' | 'mixed' | 'missing'
    integration: {
      id: string
      name: string
      status: string
      updatedAt: string
    } | null
  }

export type DingTalkWorkNotificationAgentIdTestInput = {
  integrationId?: string
  agentId?: string
  recipientUserId?: string
  title?: string
  content?: string
}

export type DingTalkWorkNotificationAgentIdTestResult = {
  integration: {
    id: string
    name: string
    status: string
  }
  agentId: {
    configured: boolean
    length: number
    valuePrinted: false
    persisted: boolean
  }
  accessTokenVerified: boolean
  notificationSent: boolean
  notificationResult?: Pick<DingTalkWorkNotificationResult, 'taskId' | 'requestId'>
}

export type DingTalkWorkNotificationAgentIdSaveResult =
  DingTalkWorkNotificationAgentIdTestResult & {
    saved: boolean
    status: DingTalkWorkNotificationRuntimeStatusWithStore
  }

type StoredWorkNotificationConfig = {
  integrationId: string
  integrationName: string
  integrationStatus: string
  integrationUpdatedAt: string
  appKey: string
  appSecret: string
  agentId: string
  baseUrl?: string
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

function readStringEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

function readEnvStatus<const T extends readonly string[]>(
  keys: T,
): { configured: boolean; selectedKey: T[number] | null; value: string } {
  for (const key of keys) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return { configured: true, selectedKey: key, value: value.trim() }
    }
  }
  return { configured: false, selectedKey: null, value: '' }
}

function decryptStoredText(value: unknown): string {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  return decryptStoredSecretValue(normalized)
}

export function normalizeDingTalkWorkNotificationAgentId(value: unknown): string {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  if (!/^\d{1,32}$/.test(normalized)) {
    throw new Error('DingTalk Agent ID must be 1-32 numeric characters')
  }
  return normalized
}

function readAgentIdFromConfig(config: JsonRecord): string {
  return decryptStoredText(config[AGENT_ID_CONFIG_KEY] ?? config.agentId)
}

async function loadStoredWorkNotificationConfig(integrationId?: string): Promise<StoredWorkNotificationConfig | null> {
  const normalizedIntegrationId = normalizeText(integrationId)
  const result = normalizedIntegrationId
    ? await query<DirectoryIntegrationConfigRow>(
      `SELECT id, name, status, config, updated_at
       FROM directory_integrations
       WHERE id = $1 AND provider = $2
       LIMIT 1`,
      [normalizedIntegrationId, DEFAULT_PROVIDER],
    )
    : await query<DirectoryIntegrationConfigRow>(
      `SELECT id, name, status, config, updated_at
       FROM directory_integrations
       WHERE provider = $1
       ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
      [DEFAULT_PROVIDER],
    )

  const row = result.rows[0]
  if (!row) return null

  const config = parseJsonRecord(row.config)
  return {
    integrationId: row.id,
    integrationName: row.name,
    integrationStatus: row.status,
    integrationUpdatedAt: row.updated_at,
    appKey: normalizeText(config.appKey),
    appSecret: decryptStoredText(config.appSecret),
    agentId: readAgentIdFromConfig(config),
    baseUrl: normalizeText(config.baseUrl) || undefined,
  }
}

function buildSelectedKeyStatus(
  envStatus: { configured: boolean; selectedKey: string | null; value: string },
  storedConfigured: boolean,
  storedKey: string,
): { configured: boolean; selectedKey: string | null } {
  if (envStatus.configured) {
    return { configured: true, selectedKey: envStatus.selectedKey }
  }
  if (storedConfigured) {
    return { configured: true, selectedKey: storedKey }
  }
  return { configured: false, selectedKey: null }
}

export async function readDingTalkMessageConfigFromRuntime(integrationId?: string): Promise<DingTalkMessageConfig> {
  const envAppKey = readStringEnv('DINGTALK_APP_KEY', 'DINGTALK_CLIENT_ID')
  const envAppSecret = readStringEnv('DINGTALK_APP_SECRET', 'DINGTALK_CLIENT_SECRET')
  const envAgentId = readStringEnv('DINGTALK_AGENT_ID', 'DINGTALK_NOTIFY_AGENT_ID')
  const envBaseUrl = readStringEnv('DINGTALK_BASE_URL') || undefined

  if (envAppKey && envAppSecret && envAgentId) {
    return {
      appKey: envAppKey,
      appSecret: envAppSecret,
      agentId: envAgentId,
      baseUrl: envBaseUrl,
    }
  }

  const stored = await loadStoredWorkNotificationConfig(integrationId)
  const appKey = envAppKey || stored?.appKey || ''
  const appSecret = envAppSecret || stored?.appSecret || ''
  const agentId = envAgentId || stored?.agentId || ''
  const baseUrl = envBaseUrl || stored?.baseUrl || undefined

  if (!appKey) throw new Error('DINGTALK_APP_KEY or DINGTALK_CLIENT_ID is not configured')
  if (!appSecret) throw new Error('DINGTALK_APP_SECRET or DINGTALK_CLIENT_SECRET is not configured')
  if (!agentId) throw new Error('DINGTALK_AGENT_ID, DINGTALK_NOTIFY_AGENT_ID, or directory workNotificationAgentId is not configured')

  return {
    appKey,
    appSecret,
    agentId,
    baseUrl,
  }
}

export async function getDingTalkWorkNotificationRuntimeStatusFromStore(
  integrationId?: string,
): Promise<DingTalkWorkNotificationRuntimeStatusWithStore> {
  const stored = await loadStoredWorkNotificationConfig(integrationId)
  const appKeyEnv = readEnvStatus(['DINGTALK_APP_KEY', 'DINGTALK_CLIENT_ID'] as const)
  const appSecretEnv = readEnvStatus(['DINGTALK_APP_SECRET', 'DINGTALK_CLIENT_SECRET'] as const)
  const agentIdEnv = readEnvStatus(['DINGTALK_AGENT_ID', 'DINGTALK_NOTIFY_AGENT_ID'] as const)
  const baseUrlEnv = readEnvStatus(['DINGTALK_BASE_URL'] as const)

  const appKey = buildSelectedKeyStatus(
    appKeyEnv,
    Boolean(stored?.appKey),
    'directory_integrations.config.appKey',
  )
  const appSecret = buildSelectedKeyStatus(
    appSecretEnv,
    Boolean(stored?.appSecret),
    'directory_integrations.config.appSecret',
  )
  const agentId = buildSelectedKeyStatus(
    agentIdEnv,
    Boolean(stored?.agentId),
    'directory_integrations.config.workNotificationAgentId',
  )
  const baseUrl = buildSelectedKeyStatus(
    baseUrlEnv,
    Boolean(stored?.baseUrl),
    'directory_integrations.config.baseUrl',
  )
  const unavailableReason = !appKey.configured
    ? 'missing_app_key'
    : !appSecret.configured
      ? 'missing_app_secret'
      : !agentId.configured
        ? 'missing_agent_id'
        : null
  const envConfiguredCount = [appKeyEnv, appSecretEnv, agentIdEnv].filter((item) => item.configured).length
  const storedConfiguredCount = [
    Boolean(stored?.appKey),
    Boolean(stored?.appSecret),
    Boolean(stored?.agentId),
  ].filter(Boolean).length
  const source = envConfiguredCount >= 3
    ? 'env'
    : storedConfiguredCount > 0 && envConfiguredCount > 0
      ? 'mixed'
      : storedConfiguredCount > 0
        ? 'directory_integration'
        : 'missing'

  return {
    configured: unavailableReason === null,
    available: unavailableReason === null,
    unavailableReason,
    source,
    integration: stored
      ? {
          id: stored.integrationId,
          name: stored.integrationName,
          status: stored.integrationStatus,
          updatedAt: stored.integrationUpdatedAt,
        }
      : null,
    requirements: {
      appKey,
      appSecret,
      agentId,
      baseUrl,
    },
  }
}

function buildTestTitle(input: DingTalkWorkNotificationAgentIdTestInput): string {
  const title = normalizeText(input.title)
  return title || 'MetaSheet DingTalk work notification test'
}

function buildTestContent(input: DingTalkWorkNotificationAgentIdTestInput): string {
  const content = normalizeText(input.content)
  return content || 'This message verifies the configured DingTalk Agent ID.'
}

export async function testDingTalkWorkNotificationAgentId(
  input: DingTalkWorkNotificationAgentIdTestInput,
): Promise<DingTalkWorkNotificationAgentIdTestResult> {
  const stored = await loadStoredWorkNotificationConfig(input.integrationId)
  if (!stored) throw new Error('DingTalk directory integration not found')

  const suppliedAgentId = normalizeText(input.agentId)
  const agentId = suppliedAgentId
    ? normalizeDingTalkWorkNotificationAgentId(suppliedAgentId)
    : normalizeDingTalkWorkNotificationAgentId(stored.agentId)
  const config: DingTalkMessageConfig = {
    appKey: readStringEnv('DINGTALK_APP_KEY', 'DINGTALK_CLIENT_ID') || stored.appKey,
    appSecret: readStringEnv('DINGTALK_APP_SECRET', 'DINGTALK_CLIENT_SECRET') || stored.appSecret,
    agentId,
    baseUrl: readStringEnv('DINGTALK_BASE_URL') || stored.baseUrl,
  }

  if (!config.appKey) throw new Error('DingTalk appKey is required')
  if (!config.appSecret) throw new Error('DingTalk appSecret is required')
  if (!config.agentId) throw new Error('DingTalk Agent ID is required')

  const accessToken = await fetchDingTalkAppAccessToken(config)
  const recipientUserId = normalizeText(input.recipientUserId)
  let notificationResult: DingTalkWorkNotificationResult | undefined
  if (recipientUserId) {
    notificationResult = await sendDingTalkWorkNotification(
      accessToken,
      {
        userIds: [recipientUserId],
        title: buildTestTitle(input),
        content: buildTestContent(input),
      },
      config,
    )
  }

  return {
    integration: {
      id: stored.integrationId,
      name: stored.integrationName,
      status: stored.integrationStatus,
    },
    agentId: {
      configured: true,
      length: agentId.length,
      valuePrinted: false,
      persisted: !suppliedAgentId && Boolean(stored.agentId),
    },
    accessTokenVerified: true,
    notificationSent: Boolean(notificationResult),
    ...(notificationResult
      ? {
          notificationResult: {
            taskId: notificationResult.taskId,
            requestId: notificationResult.requestId,
          },
        }
      : {}),
  }
}

export async function saveDingTalkWorkNotificationAgentId(
  input: DingTalkWorkNotificationAgentIdTestInput,
): Promise<DingTalkWorkNotificationAgentIdSaveResult> {
  const integrationId = normalizeText(input.integrationId)
  if (!integrationId) throw new Error('integrationId is required')
  const agentId = normalizeDingTalkWorkNotificationAgentId(input.agentId)
  if (!agentId) throw new Error('DingTalk Agent ID is required')

  const testResult = await testDingTalkWorkNotificationAgentId({
    ...input,
    integrationId,
    agentId,
    recipientUserId: undefined,
  })

  await query(
    `UPDATE directory_integrations
     SET config = jsonb_set(
           COALESCE(config, '{}'::jsonb),
           '{workNotificationAgentId}',
           to_jsonb($2::text),
           true
         ),
         updated_at = NOW()
     WHERE id = $1 AND provider = $3`,
    [integrationId, normalizeStoredSecretValue(agentId), DEFAULT_PROVIDER],
  )

  const status = await getDingTalkWorkNotificationRuntimeStatusFromStore(integrationId)
  return {
    ...testResult,
    saved: true,
    status,
  }
}
