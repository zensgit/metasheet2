import {
  DingTalkBusinessError,
  DingTalkRequestError,
  fetchDingTalkAppAccessToken,
  isDingTalkOutcomeUnknown,
  sendDingTalkWorkNotification,
  type DingTalkMessageConfig,
  type DingTalkWorkNotificationInput,
  type DingTalkWorkNotificationResult,
} from '../integrations/dingtalk/client'
import { normalizeDingTalkWorkNotificationAgentId } from '../integrations/dingtalk/work-notification-settings'
import { decryptStoredSecretValue } from '../security/encrypted-secrets'

export type ElearningNotificationKind =
  | 'assignment_reminder'
  | 'training_available'
  | 'result_published'

export interface ElearningDingTalkNotificationInput {
  orgId: string
  recipientUserId: string
  kind: ElearningNotificationKind
}

export type ElearningDingTalkSendOutcome =
  | { outcome: 'sent' }
  | { outcome: 'outcome_unknown'; code: string }
  | { outcome: 'failed'; code: string }

export type ElearningDingTalkPreparationOutcome =
  | {
      outcome: 'prepared'
      send: (enabled?: () => boolean) => Promise<ElearningDingTalkSendOutcome>
    }
  | { outcome: 'retryable'; code: string }
  | { outcome: 'failed'; code: string }

export type ElearningDingTalkNotificationQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{
  rows: Array<Record<string, unknown>>
  rowCount: number | null
}>

type FetchAccessToken = (
  config: DingTalkMessageConfig,
) => Promise<string>

type SendWorkNotification = (
  accessToken: string,
  input: DingTalkWorkNotificationInput,
  config: DingTalkMessageConfig,
) => Promise<DingTalkWorkNotificationResult>

export interface ElearningDingTalkNotificationDeps {
  fetchAccessToken?: FetchAccessToken
  sendWorkNotification?: SendWorkNotification
}

type PreparedDestination = {
  integrationId: string
  dingtalkUserId: string
  messageConfig: DingTalkMessageConfig
}

type DestinationLookup =
  | { outcome: 'ready'; destination: PreparedDestination }
  | { outcome: 'failed'; code: string }

const NOTIFICATION_TITLE = 'MetaSheet 学习提醒'
const ASSIGNMENT_REMINDER_CONTENT =
  '你有待完成的学习任务，请前往 MetaSheet 学习中心查看。'
const TRAINING_AVAILABLE_CONTENT =
  '你有新的培训任务/报名课程，请前往 MetaSheet 学习中心查看。'
const RESULT_PUBLISHED_CONTENT =
  '考试成绩已公布，请登录学习中心查看成绩及通过情况。'

function notificationContent(kind: ElearningNotificationKind): string {
  switch (kind) {
    case 'assignment_reminder':
      return ASSIGNMENT_REMINDER_CONTENT
    case 'training_available':
      return TRAINING_AVAILABLE_CONTENT
    case 'result_published':
      return RESULT_PUBLISHED_CONTENT
  }
  const unreachable: never = kind
  return unreachable
}

function normalizeRequiredText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseConfig(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readSecret(value: unknown): string {
  const normalized = normalizeRequiredText(value)
  return normalized ? decryptStoredSecretValue(normalized).trim() : ''
}

function readPinnedMessageConfig(
  integrationConfig: Record<string, unknown>,
): DingTalkMessageConfig | null {
  const appKey = normalizeRequiredText(integrationConfig.appKey)
  const appSecret = readSecret(integrationConfig.appSecret)
  const baseUrl = normalizeRequiredText(integrationConfig.baseUrl) || undefined
  let agentId = ''

  try {
    agentId = normalizeDingTalkWorkNotificationAgentId(
      readSecret(
        integrationConfig.workNotificationAgentId
          ?? integrationConfig.agentId,
      ),
    )
  } catch {
    return null
  }

  if (!appKey || !appSecret || !agentId) return null
  return { appKey, appSecret, agentId, baseUrl }
}

async function lookupDestination(
  query: ElearningDingTalkNotificationQuery,
  orgId: string,
  recipientUserId: string,
): Promise<DestinationLookup> {
  const result = await query(
    `/* elearning-notification-dingtalk:recipient-config */
     SELECT integration.id AS integration_id,
            account.external_user_id AS dingtalk_user_id,
            integration.config AS integration_config
       FROM user_orgs membership
       JOIN users local_user
         ON local_user.id = membership.user_id
        AND local_user.is_active = TRUE
       JOIN directory_account_links link
         ON link.local_user_id = membership.user_id
        AND link.link_status = 'linked'
       JOIN directory_accounts account
         ON account.id = link.directory_account_id
        AND account.provider = 'dingtalk'
        AND account.is_active = TRUE
       JOIN directory_integrations integration
         ON integration.id = account.integration_id
        AND integration.org_id = membership.org_id
        AND integration.provider = 'dingtalk'
        AND integration.status = 'active'
      WHERE membership.org_id = $1
        AND membership.user_id = $2
        AND membership.is_active = TRUE
      LIMIT 2`,
    [orgId, recipientUserId],
  )
  if (result.rows.length === 0) {
    return { outcome: 'failed', code: 'RECIPIENT_IDENTITY_UNAVAILABLE' }
  }
  if (result.rows.length !== 1) {
    return { outcome: 'failed', code: 'RECIPIENT_IDENTITY_AMBIGUOUS' }
  }

  const row = result.rows[0]
  const integrationId = normalizeRequiredText(row.integration_id)
  const dingtalkUserId = normalizeRequiredText(row.dingtalk_user_id)
  const integrationConfig = parseConfig(row.integration_config)
  let messageConfig: DingTalkMessageConfig | null = null
  try {
    messageConfig = integrationConfig
      ? readPinnedMessageConfig(integrationConfig)
      : null
  } catch {
    messageConfig = null
  }
  if (!integrationId || !dingtalkUserId || !messageConfig) {
    return { outcome: 'failed', code: 'DINGTALK_CONFIG_UNAVAILABLE' }
  }
  return {
    outcome: 'ready',
    destination: { integrationId, dingtalkUserId, messageConfig },
  }
}

function isSameDestination(
  expected: PreparedDestination,
  actual: PreparedDestination,
): boolean {
  return expected.integrationId === actual.integrationId
    && expected.dingtalkUserId === actual.dingtalkUserId
    && expected.messageConfig.appKey === actual.messageConfig.appKey
    && expected.messageConfig.appSecret === actual.messageConfig.appSecret
    && expected.messageConfig.agentId === actual.messageConfig.agentId
    && expected.messageConfig.baseUrl === actual.messageConfig.baseUrl
}

function classifySendFailure(error: unknown): ElearningDingTalkSendOutcome {
  if (isDingTalkOutcomeUnknown(error)) {
    return {
      outcome: 'outcome_unknown',
      code: 'DINGTALK_SEND_OUTCOME_UNKNOWN',
    }
  }
  if (error instanceof DingTalkBusinessError) {
    return {
      outcome: 'failed',
      code: 'DINGTALK_SEND_REJECTED',
    }
  }
  if (error instanceof DingTalkRequestError && error.statusCode < 500) {
    return {
      outcome: 'failed',
      code: 'DINGTALK_SEND_REJECTED',
    }
  }
  return {
    outcome: 'outcome_unknown',
    code: 'DINGTALK_SEND_OUTCOME_UNKNOWN',
  }
}

export async function prepareElearningDingTalkNotification(
  query: ElearningDingTalkNotificationQuery,
  input: ElearningDingTalkNotificationInput,
  deps: ElearningDingTalkNotificationDeps = {},
): Promise<ElearningDingTalkPreparationOutcome> {
  const orgId = normalizeRequiredText(input?.orgId)
  const recipientUserId = normalizeRequiredText(input?.recipientUserId)
  if (
    !orgId
    || !recipientUserId
    || ![
      'assignment_reminder',
      'training_available',
      'result_published',
    ].includes(input?.kind)
  ) {
    return { outcome: 'failed', code: 'INVALID_INPUT' }
  }

  let initialLookup: DestinationLookup
  try {
    initialLookup = await lookupDestination(query, orgId, recipientUserId)
  } catch {
    return { outcome: 'retryable', code: 'DIRECTORY_UNAVAILABLE' }
  }
  if (initialLookup.outcome !== 'ready') {
    return initialLookup.code === 'DINGTALK_CONFIG_UNAVAILABLE'
      ? { outcome: 'retryable', code: initialLookup.code }
      : initialLookup
  }
  const destination = initialLookup.destination

  const fetchAccessToken = deps.fetchAccessToken ?? fetchDingTalkAppAccessToken
  let accessToken: string
  try {
    accessToken = await fetchAccessToken(destination.messageConfig)
  } catch {
    return { outcome: 'retryable', code: 'DINGTALK_TOKEN_UNAVAILABLE' }
  }
  if (!normalizeRequiredText(accessToken)) {
    return { outcome: 'retryable', code: 'DINGTALK_TOKEN_UNAVAILABLE' }
  }

  let postTokenLookup: DestinationLookup
  try {
    postTokenLookup = await lookupDestination(query, orgId, recipientUserId)
  } catch {
    return { outcome: 'retryable', code: 'DIRECTORY_UNAVAILABLE' }
  }
  if (
    postTokenLookup.outcome !== 'ready'
    || !isSameDestination(destination, postTokenLookup.destination)
  ) {
    return { outcome: 'failed', code: 'RECIPIENT_IDENTITY_CHANGED' }
  }

  const sendWorkNotification = deps.sendWorkNotification
    ?? sendDingTalkWorkNotification

  return {
    outcome: 'prepared',
    send: async (enabled = () => true) => {
      if (!enabled()) return { outcome: 'failed', code: 'NOTIFICATION_DISABLED' }
      let immediateLookup: DestinationLookup
      try {
        immediateLookup = await lookupDestination(query, orgId, recipientUserId)
      } catch {
        return { outcome: 'failed', code: 'DIRECTORY_REVALIDATION_UNAVAILABLE' }
      }
      if (
        immediateLookup.outcome !== 'ready'
        || !isSameDestination(destination, immediateLookup.destination)
      ) {
        return { outcome: 'failed', code: 'RECIPIENT_IDENTITY_CHANGED' }
      }
      if (!enabled()) return { outcome: 'failed', code: 'NOTIFICATION_DISABLED' }
      try {
        const result = await sendWorkNotification(
          accessToken,
          {
            userIds: [destination.dingtalkUserId],
            title: NOTIFICATION_TITLE,
            content: notificationContent(input.kind),
          },
          destination.messageConfig,
        )
        if (!normalizeRequiredText(result?.taskId)) {
          return {
            outcome: 'outcome_unknown',
            code: 'DINGTALK_SEND_RESPONSE_INVALID',
          }
        }
        return { outcome: 'sent' }
      } catch (error) {
        return classifySendFailure(error)
      }
    },
  }
}
