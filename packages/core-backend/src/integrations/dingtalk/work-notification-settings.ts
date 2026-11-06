import { query } from '../../db/pg'
import { decryptStoredSecretValue, normalizeStoredSecretValue } from '../../security/encrypted-secrets'
import {
  fetchDingTalkAppAccessToken,
  sendDingTalkWorkNotification,
  type DingTalkMessageConfig,
  type DingTalkWorkNotificationResult,
  type DingTalkWorkNotificationRuntimeStatus,
} from './client'
import { DingTalkConfigValidationError, DingTalkMessageConfigError } from './config-validation-error'
import { isDingTalkIntegrationScopedCredentialsEnabled } from './integration-scoped-credentials-flag'

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
  /**
   * How the credentials of this test were put together: the PRE-SWITCH per-field rule (each of appKey /
   * appSecret / baseUrl env-then-stored, the Agent ID from the request or the row), which is not the rule the
   * integration-scoped send path applies. A passing test is therefore no evidence about that path — see
   * `integrationScopedEvidence` and work-notification-verify.ts.
   */
  credentialResolution: 'pre_switch_env_first'
  /** Always false here: this result never proves what the integration-scoped resolution would send with. */
  integrationScopedEvidence: false
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
    throw new DingTalkConfigValidationError('DingTalk Agent ID must be 1-32 numeric characters')
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

/** The env side of the work-notification credential tuple, each value already trimmed ('' = unset). */
export type DingTalkMessageEnvSnapshot = {
  appKey: string
  appSecret: string
  agentId: string
  baseUrl?: string
}

/** The integration-row side of the tuple, as loadStoredWorkNotificationConfig returns it ('' = not stored). */
export type DingTalkMessageTupleRow = Pick<
  StoredWorkNotificationConfig,
  'integrationId' | 'integrationStatus' | 'appKey' | 'appSecret' | 'agentId' | 'baseUrl'
>

export type DingTalkMessageTupleSource = 'env_override' | 'integration'

export type DingTalkMessageTupleResolution = {
  config: DingTalkMessageConfig
  source: DingTalkMessageTupleSource
}

/** Which env inputs were present (non-blank) when a tuple was resolved — presence only, never a value. */
export type DingTalkMessageEnvPresence = {
  appKey: boolean
  appSecret: boolean
  agentId: boolean
  baseUrl: boolean
}

/** The integration-scoped resolution plus the row's identity, for callers that report on it. */
export type DingTalkIntegrationScopedMessageTuple = DingTalkMessageTupleResolution & {
  integration: {
    id: string
    name: string
    status: string
    updatedAt: string
  }
  environment: DingTalkMessageEnvPresence
}

function readDingTalkMessageEnvSnapshot(): DingTalkMessageEnvSnapshot {
  return {
    appKey: readStringEnv('DINGTALK_APP_KEY', 'DINGTALK_CLIENT_ID'),
    appSecret: readStringEnv('DINGTALK_APP_SECRET', 'DINGTALK_CLIENT_SECRET'),
    agentId: readStringEnv('DINGTALK_AGENT_ID', 'DINGTALK_NOTIFY_AGENT_ID'),
    baseUrl: readStringEnv('DINGTALK_BASE_URL') || undefined,
  }
}

function missingTupleFields(config: { appKey: string; appSecret: string; agentId: string }): string[] {
  const missing: string[] = []
  if (!config.appKey) missing.push('appKey')
  if (!config.appSecret) missing.push('appSecret')
  if (!config.agentId) missing.push('agentId')
  return missing
}

const ENV_AGENT_ID_VARIABLES = 'DINGTALK_AGENT_ID or DINGTALK_NOTIFY_AGENT_ID'

/**
 * Switch ON only: the environment Agent ID, when it is the value that would be sent, must have the shape
 * the admin save path already enforces (normalizeDingTalkWorkNotificationAgentId: 1-32 digits). A
 * forgotten placeholder becomes a local typed failure instead of being sent to DingTalk as it is.
 * Returns the value unchanged when valid ('' stays '').
 */
function checkEnvAgentIdShape(envAgentId: string): string {
  if (!envAgentId) return ''
  try {
    return normalizeDingTalkWorkNotificationAgentId(envAgentId)
  } catch {
    throw new DingTalkMessageConfigError(
      'env_agent_id_invalid',
      `DingTalk Agent ID from the environment (${ENV_AGENT_ID_VARIABLES}) must be 1-32 numeric characters; it was not sent`,
    )
  }
}

/**
 * Integration-scoped resolution of the work-notification credential tuple (appKey, appSecret, agentId,
 * baseUrl) for ONE named integration. Pure: takes an env snapshot and the integration row, reads no
 * process.env and runs no query, so the decision table can be tested directly. On the send path it is
 * reached only while DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED is 'true' and the caller named an
 * integration; the admin verification route reaches it (through readDingTalkIntegrationScopedMessageTuple)
 * whatever the switch says.
 *
 *  - Missing row: typed failure (integration_not_found); nothing is sent on env credentials for an
 *    integration that does not exist.
 *  - Row not active: typed failure (integration_inactive), whichever source would have been used.
 *  - Same app (env appKey non-empty and equal to the row's appKey; the env side uses the message-side
 *    alias order, DINGTALK_APP_KEY before DINGTALK_CLIENT_ID): env overrides field by field, exactly the
 *    pre-switch per-field behaviour; an env Agent ID that is used must be 1-32 digits
 *    (env_agent_id_invalid); an incomplete result is a typed failure.
 *  - Otherwise: the row's own appKey / appSecret / workNotificationAgentId are used as a whole and must be
 *    complete (integration_tuple_incomplete otherwise). No field is borrowed from env.
 *  - baseUrl follows the chosen source: env-then-stored for the same-app case, stored-then-env for the
 *    integration case.
 * The failure text names the integration id, field names and sources only — never a value.
 */
export function resolveDingTalkMessageTuple(
  env: DingTalkMessageEnvSnapshot,
  row: DingTalkMessageTupleRow | null,
  integrationId: string,
): DingTalkMessageTupleResolution {
  if (!row) {
    throw new DingTalkMessageConfigError(
      'integration_not_found',
      `DingTalk directory integration ${integrationId} was not found; work-notification credentials were not resolved from the environment for it`,
    )
  }

  if (row.integrationStatus !== 'active') {
    throw new DingTalkMessageConfigError(
      'integration_inactive',
      `DingTalk directory integration ${row.integrationId} is not active; work-notification credentials were not resolved for it`,
    )
  }

  if (env.appKey && env.appKey === row.appKey) {
    const config: DingTalkMessageConfig = {
      appKey: env.appKey,
      appSecret: env.appSecret || row.appSecret,
      agentId: checkEnvAgentIdShape(env.agentId) || row.agentId,
      baseUrl: env.baseUrl || row.baseUrl || undefined,
    }
    const missing = missingTupleFields(config)
    if (missing.length > 0) {
      throw new DingTalkMessageConfigError(
        'integration_tuple_incomplete',
        `DingTalk directory integration ${row.integrationId} work-notification credentials are incomplete (missing: ${missing.join(', ')}) with the same-app environment override`,
      )
    }
    return { config, source: 'env_override' }
  }

  const config: DingTalkMessageConfig = {
    appKey: row.appKey,
    appSecret: row.appSecret,
    agentId: row.agentId,
    baseUrl: row.baseUrl || env.baseUrl || undefined,
  }
  const missing = missingTupleFields(config)
  if (missing.length > 0) {
    throw new DingTalkMessageConfigError(
      'integration_tuple_incomplete',
      `DingTalk directory integration ${row.integrationId} work-notification credentials are incomplete (missing: ${missing.join(', ')}); environment credentials of another app are not borrowed`,
    )
  }
  return { config, source: 'integration' }
}

/**
 * The ONE integration-scoped reader: the env snapshot, the named row, and resolveDingTalkMessageTuple over
 * them. It is the only branch the send path takes while the switch is ON and an integration is named
 * (readDingTalkMessageConfigFromRuntime below), and the admin verification route
 * (work-notification-verify.ts) calls this same export, so what it verifies is what that path would send
 * with. It does not read the switch itself: the decision whether the send path takes this branch is the
 * caller's, which is what lets an admin verify an integration before the switch is turned on.
 * Throws the resolver's typed DingTalkMessageConfigError (row missing / inactive / incomplete, malformed
 * env Agent ID); EncryptionMaterialError and driver errors from the row read pass through untouched.
 * The id must be non-blank: for a blank id the row loader falls back to the store's preferred row (the
 * pre-switch behaviour it shares), so both callers refuse a blank id before calling this — the send path
 * only calls it for a non-empty normalised id, the verification throws a typed error first.
 */
export async function readDingTalkIntegrationScopedMessageTuple(
  integrationId: string,
): Promise<DingTalkIntegrationScopedMessageTuple> {
  const env = readDingTalkMessageEnvSnapshot()
  const stored = await loadStoredWorkNotificationConfig(integrationId)
  // Throws integration_not_found on a missing row, so `stored` is non-null past this line.
  const resolution = resolveDingTalkMessageTuple(env, stored, integrationId)
  return {
    ...resolution,
    integration: {
      id: stored.integrationId,
      name: stored.integrationName,
      status: stored.integrationStatus,
      updatedAt: stored.integrationUpdatedAt,
    },
    environment: {
      appKey: Boolean(env.appKey),
      appSecret: Boolean(env.appSecret),
      agentId: Boolean(env.agentId),
      baseUrl: Boolean(env.baseUrl),
    },
  }
}

/**
 * Injection seam for the switch-ON branch, so a test can pin that the branch calls the exported reader
 * (the one the verification route shares) rather than a private copy of its three lines. Production
 * callers pass nothing and get the default.
 */
export type DingTalkMessageConfigRuntimeDeps = {
  readScoped: (integrationId: string) => Promise<DingTalkIntegrationScopedMessageTuple>
}

export async function readDingTalkMessageConfigFromRuntime(
  integrationId?: string,
  deps: DingTalkMessageConfigRuntimeDeps = { readScoped: readDingTalkIntegrationScopedMessageTuple },
): Promise<DingTalkMessageConfig> {
  // Switch ON and an integration named: anchor the tuple to that integration (always reads the row).
  // Switch ON, no integration named: the pre-switch path below, after checking the shape of the env
  // Agent ID (on that path a non-empty env Agent ID is always the one sent).
  // Switch OFF: the pre-switch path below, unchanged.
  if (isDingTalkIntegrationScopedCredentialsEnabled()) {
    const scopedIntegrationId = normalizeText(integrationId)
    if (scopedIntegrationId) return (await deps.readScoped(scopedIntegrationId)).config
    checkEnvAgentIdShape(readStringEnv('DINGTALK_AGENT_ID', 'DINGTALK_NOTIFY_AGENT_ID'))
  }

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

/**
 * PRE-SWITCH rule, kept as it is (the admin test / save path of the Agent ID form and its ops helper):
 * a blank integrationId falls back to the preferred row, the request may override the stored Agent ID,
 * and appKey / appSecret / baseUrl are each env-then-stored with no same-app check and no status check.
 * None of that is the integration-scoped resolution (readDingTalkIntegrationScopedMessageTuple), so a
 * passing test here is NOT evidence that the credentials the switch-ON send path would use are accepted —
 * the result says so (`credentialResolution`, `integrationScopedEvidence: false`); the verification route
 * in work-notification-verify.ts is the check for that.
 */
export async function testDingTalkWorkNotificationAgentId(
  input: DingTalkWorkNotificationAgentIdTestInput,
): Promise<DingTalkWorkNotificationAgentIdTestResult> {
  const stored = await loadStoredWorkNotificationConfig(input.integrationId)
  if (!stored) throw new DingTalkConfigValidationError('DingTalk directory integration not found')

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

  if (!config.appKey) throw new DingTalkConfigValidationError('DingTalk appKey is required')
  if (!config.appSecret) throw new DingTalkConfigValidationError('DingTalk appSecret is required')
  if (!config.agentId) throw new DingTalkConfigValidationError('DingTalk Agent ID is required')

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
    credentialResolution: 'pre_switch_env_first',
    integrationScopedEvidence: false,
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

/**
 * Saves the Agent ID after the PRE-SWITCH test above (token only, no send): the same env-then-stored rule,
 * so "verified" in its result means the env-first tuple obtained a token — not that the integration-scoped
 * send path would (its result carries `integrationScopedEvidence: false` for that reason).
 */
export async function saveDingTalkWorkNotificationAgentId(
  input: DingTalkWorkNotificationAgentIdTestInput,
): Promise<DingTalkWorkNotificationAgentIdSaveResult> {
  const integrationId = normalizeText(input.integrationId)
  if (!integrationId) throw new DingTalkConfigValidationError('integrationId is required')
  const agentId = normalizeDingTalkWorkNotificationAgentId(input.agentId)
  if (!agentId) throw new DingTalkConfigValidationError('DingTalk Agent ID is required')

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
