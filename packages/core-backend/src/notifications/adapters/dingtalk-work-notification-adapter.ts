import {
  fetchDingTalkAppAccessToken,
  sendDingTalkWorkNotification,
  type DingTalkMessageConfig,
} from '../../integrations/dingtalk/client'
import { DingTalkMessageConfigError } from '../../integrations/dingtalk/config-validation-error'
import { readDingTalkIntegrationScopedMessageTuple } from '../../integrations/dingtalk/work-notification-settings'
import {
  isAllowedTaskDingTalkBaseUrl,
  TASK_DELIVERY_PREPARE_BUDGET_MS,
  TASK_DINGTALK_REQUEST_TIMEOUT_MS,
  type TaskDeliveryChannelResult,
} from '../../tasks/task-delivery-protocol'
import { providerResponseAcceptance } from '../delivery-outcome'
import { resolveProviderNotificationDescriptor } from '../provider-notification-registry'
import type { ResolvedTarget } from '../recipient-resolver'
import { sha256Hex } from '../witness'
import type { AdapterPrepareContext, AdapterPrepared, AdapterSendResult, NotificationAdapter } from './notification-adapter'

export interface DingTalkWorkNotificationAdapterOptions {
  /** Existing task-channel functions, supplied by the composition boundary without a service import. */
  normalizeBaseUrl(value: unknown): string
  classifySendError(error: unknown, sensitiveValues: readonly string[]): TaskDeliveryChannelResult
  readTuple?: typeof readDingTalkIntegrationScopedMessageTuple
  fetchAccessToken?: typeof fetchDingTalkAppAccessToken
  sendWorkNotification?: typeof sendDingTalkWorkNotification
}

type Config = DingTalkMessageConfig & { baseUrl: string }
type PrepareFailure = Extract<AdapterPrepared, { ok: false }>
const SEND_CODE = /^(?:dingtalk_send_(?:outcome_unknown|unclassified|response_invalid)|dingtalk_request_\d{3}|dingtalk_business_error_(?:-?\d+(?:\.\d+)?|unknown))$/

function unavailable(error: unknown): PrepareFailure {
  if (error instanceof DingTalkMessageConfigError
    && (error.code === 'integration_not_found' || error.code === 'integration_inactive')) {
    return { ok: false, retryable: false, skip: true, code: 'routed_target_capability_unavailable' }
  }
  return { ok: false, retryable: true, code: 'routed_credentials_unavailable' }
}

function sameTarget(first: ResolvedTarget, second: ResolvedTarget): boolean {
  return first.connectionId === second.connectionId && first.provider === second.provider
    && first.transport === second.transport && first.addressKind === second.addressKind
    && first.proofKind === second.proofKind && first.proofId === second.proofId
    && first.proofWitness === second.proofWitness && first.addressWitness === second.addressWitness
    && first.tenantAddressWitness === second.tenantAddressWitness
    && first.boundTenant === second.boundTenant && first.boundAppScope === second.boundAppScope
    && first.address.reveal() === second.address.reveal()
}

function sameConfig(first: Config, second: Config): boolean {
  return first.appKey === second.appKey && first.appSecret === second.appSecret
    && first.agentId === second.agentId && first.baseUrl === second.baseUrl
}

function sensitiveValues(accessToken: string, config: Config, address: string, message: { title: string; content: string }): string[] {
  const values = [accessToken, config.appKey, config.appSecret, config.agentId, address, message.title, message.content]
  for (const line of message.content.split('\n')) values.push(line.trim())
  for (const match of message.content.matchAll(/「([^」]*)」/g)) values.push(match[1])
  return [...new Set(values.filter((value) => value.length >= 2))].sort((a, b) => b.length - a.length)
}

function withinBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('notification prepare budget exceeded')), budgetMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

export class DingTalkWorkNotificationAdapter implements NotificationAdapter {
  readonly provider = 'dingtalk'
  readonly transport = 'work_notification'
  private readonly normalizeBaseUrl: DingTalkWorkNotificationAdapterOptions['normalizeBaseUrl']
  private readonly classifySendError: DingTalkWorkNotificationAdapterOptions['classifySendError']
  private readonly readTuple: typeof readDingTalkIntegrationScopedMessageTuple
  private readonly fetchAccessToken: typeof fetchDingTalkAppAccessToken
  private readonly sendWorkNotification: typeof sendDingTalkWorkNotification

  constructor(options: DingTalkWorkNotificationAdapterOptions) {
    this.normalizeBaseUrl = options.normalizeBaseUrl
    this.classifySendError = options.classifySendError
    this.readTuple = options.readTuple ?? readDingTalkIntegrationScopedMessageTuple
    this.fetchAccessToken = options.fetchAccessToken ?? fetchDingTalkAppAccessToken
    this.sendWorkNotification = options.sendWorkNotification ?? sendDingTalkWorkNotification
  }

  private async config(connectionId: string): Promise<Config> {
    const { config } = await this.readTuple(connectionId)
    return { ...config, baseUrl: this.normalizeBaseUrl(config.baseUrl) }
  }

  async fingerprint(connectionId: string): Promise<{ ok: true; value: string } | { ok: false; code: string }> {
    if (!connectionId.trim()) return { ok: false, code: 'routed_credentials_unavailable' }
    try {
      const config = await this.config(connectionId)
      if (!isAllowedTaskDingTalkBaseUrl(config.baseUrl)) return { ok: false, code: 'routed_base_url_rejected' }
      return {
        ok: true,
        value: sha256Hex('mx.notif.tuple.v1', {
          provider: this.provider, appKey: config.appKey, agentId: config.agentId,
          baseUrl: config.baseUrl, secret: config.appSecret,
        }),
      }
    } catch (error) {
      return { ok: false, code: unavailable(error).code }
    }
  }

  async prepare(context: AdapterPrepareContext): Promise<AdapterPrepared> {
    const startedAt = Date.now()
    const target = { ...context.target }
    if (!context.connectionId.trim() || target.connectionId !== context.connectionId
      || target.provider !== this.provider || target.transport !== this.transport) {
      return { ok: false, retryable: false, skip: true, code: 'routed_target_capability_unavailable' }
    }
    let config: Config
    try {
      config = await this.config(context.connectionId)
    } catch (error) {
      return unavailable(error)
    }
    if (!isAllowedTaskDingTalkBaseUrl(config.baseUrl)) {
      return { ok: false, retryable: false, code: 'routed_base_url_rejected' }
    }
    let accessToken: string
    try {
      const remainingMs = Math.min(context.budgetMs, TASK_DELIVERY_PREPARE_BUDGET_MS) - (Date.now() - startedAt)
      if (remainingMs <= 0) return unavailable(null)
      accessToken = (await withinBudget(this.fetchAccessToken(config, {
        timeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS, logUpstreamMessage: false,
      }), remainingMs)).trim()
      if (!accessToken) return unavailable(null)
    } catch {
      return unavailable(null)
    }
    try {
      const currentTarget = await context.reverify()
      const currentConfig = await this.config(context.connectionId)
      if (!currentTarget.ok || !sameTarget(target, currentTarget.target) || !sameConfig(config, currentConfig)) {
        return { ok: false, retryable: true, code: 'routed_destination_changed' }
      }
    } catch {
      return { ok: false, retryable: true, code: 'routed_destination_changed' }
    }
    const address = target.address.reveal()
    return {
      ok: true,
      send: async (message): Promise<AdapterSendResult> => {
        try {
          const response = await this.sendWorkNotification(accessToken, {
            userIds: [address], title: message.title, content: message.content,
          }, config, { timeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS, logUpstreamMessage: false })
          if (typeof response?.taskId !== 'string' || !response.taskId.trim()) {
            return { ok: false, retryable: false, outcomeUnknown: true, code: 'dingtalk_send_response_invalid' }
          }
          const descriptor = resolveProviderNotificationDescriptor(this.provider)!
          return providerResponseAcceptance(descriptor, response.raw)
        } catch (error) {
          const classified = this.classifySendError(error, sensitiveValues(accessToken, config, address, message))
          const code = classified.ok === true ? '' : classified.error.split(': ', 1)[0]
          if (classified.ok === true || code.length > 64 || !SEND_CODE.test(code)) {
            return { ok: false, retryable: false, outcomeUnknown: true, code: 'routed_send_unclassified' }
          }
          return {
            ok: false, retryable: classified.retryable, code,
            ...(classified.outcomeUnknown ? { outcomeUnknown: true } : {}),
          }
        }
      },
    }
  }
}
