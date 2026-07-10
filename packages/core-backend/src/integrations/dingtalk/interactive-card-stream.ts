/**
 * B-1 (DingTalk interactive approval cards): env-gated Stream worker skeleton.
 * B-3 adds the callback dispatch seam: events that carry a card-callback payload are handed to
 * the B-3 adapter (`interactive-card-callback.ts`), which funnels into the A-4 card-delivery
 * wrapper. Dispatch stays behind the SAME env gate — with the flag off (the default) no client
 * is ever created, so no callback can execute.
 *
 * This module stays import-side-effect-free: the production callback executor (db pool +
 * ApprovalProductService) is materialized lazily via dynamic import on the first callback event.
 */
import { Logger } from '../../core/logger'
import type { DingTalkApprovalCardCallbackResult } from './interactive-card-callback'

export const DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV = 'DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED'
export const DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV = 'DINGTALK_INTERACTIVE_CARD_CLIENT_ID'
export const DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV = 'DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET'
export const DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV = 'DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID'

export type DingTalkInteractiveCardStreamDisabledReason =
  | 'env_disabled'
  | 'missing_client_id'
  | 'missing_client_secret'
  | 'missing_template_id'

export type DingTalkInteractiveCardStreamConfig =
  | {
    enabled: false
    reason: DingTalkInteractiveCardStreamDisabledReason
    requirements: {
      clientId: boolean
      clientSecret: boolean
      templateId: boolean
    }
  }
  | {
    enabled: true
    clientId: string
    clientSecret: string
    templateId: string
    requirements: {
      clientId: true
      clientSecret: true
      templateId: true
    }
  }

export type DingTalkInteractiveCardStreamEvent = {
  /** Transport-level event type, values-free. B-3 owns semantic callback parsing. */
  eventType?: string
  /** Provider/card event id if present. Do not trust this as a business identifier. */
  eventId?: string
  /**
   * Raw card-callback payload (opaque transport data). It is parsed ONLY by the B-3 callback
   * adapter into the ratified `{outTrackId, action, operatorDingTalkUserId}` triple; the worker
   * never reads or logs it. Events without a payload are transport noise and are ignored.
   */
  payload?: unknown
}

/** B-3 dispatch seam: raw callback payload → typed outcome (see interactive-card-callback.ts). */
export type DingTalkInteractiveCardCallbackExecutor = (
  payload: unknown,
) => Promise<DingTalkApprovalCardCallbackResult>

export type DingTalkInteractiveCardStreamHandlers = {
  onEvent(event: DingTalkInteractiveCardStreamEvent): Promise<void>
}

export type DingTalkInteractiveCardStreamClient = {
  start(): Promise<void>
  close(): Promise<void>
}

export type DingTalkInteractiveCardStreamClientFactory = (
  config: Extract<DingTalkInteractiveCardStreamConfig, { enabled: true }>,
  handlers: DingTalkInteractiveCardStreamHandlers,
) => Promise<DingTalkInteractiveCardStreamClient> | DingTalkInteractiveCardStreamClient

export type DingTalkInteractiveCardStreamWorkerStatus =
  | { state: 'disabled'; reason: DingTalkInteractiveCardStreamDisabledReason }
  | { state: 'active' }
  | { state: 'failed'; reason: 'client_start_failed' | 'client_stop_failed' | 'sdk_unwired' }

function readEnv(env: NodeJS.ProcessEnv, key: string): string {
  return typeof env[key] === 'string' ? env[key]!.trim() : ''
}

function isEnabledFlag(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true'
}

export function resolveDingTalkInteractiveCardStreamConfig(
  env: NodeJS.ProcessEnv = process.env,
): DingTalkInteractiveCardStreamConfig {
  const enabled = isEnabledFlag(readEnv(env, DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV))
  const clientId = readEnv(env, DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV)
  const clientSecret = readEnv(env, DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV)
  const templateId = readEnv(env, DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV)
  const requirements = {
    clientId: Boolean(clientId),
    clientSecret: Boolean(clientSecret),
    templateId: Boolean(templateId),
  }

  if (!enabled) return { enabled: false, reason: 'env_disabled', requirements }
  if (!clientId) return { enabled: false, reason: 'missing_client_id', requirements }
  if (!clientSecret) return { enabled: false, reason: 'missing_client_secret', requirements }
  if (!templateId) return { enabled: false, reason: 'missing_template_id', requirements }

  return {
    enabled: true,
    clientId,
    clientSecret,
    templateId,
    requirements: {
      clientId: true,
      clientSecret: true,
      templateId: true,
    },
  }
}

export const unwiredDingTalkInteractiveCardStreamClientFactory: DingTalkInteractiveCardStreamClientFactory = async () => {
  throw new Error('DINGTALK_INTERACTIVE_CARD_STREAM_SDK_UNWIRED')
}

/**
 * Values-free log line for a callback outcome: outcome/reason codes and ledger delivery ids only —
 * never operator ids, summaries, card payloads, or engine messages (lock §4 failure policy).
 */
function describeCallbackResult(result: DingTalkApprovalCardCallbackResult): string {
  switch (result.outcome) {
    case 'rejected':
      return `rejected:${result.reason}`
    case 'ignored_unsupported_action':
      return `ignored_unsupported_action out_track_id=${result.outTrackId}`
    case 'delivery_not_found':
      return `delivery_not_found out_track_id=${result.outTrackId}`
    case 'operator_unresolved':
      return `operator_unresolved:${result.reason} delivery=${result.deliveryId}`
    case 'link_secret_unavailable':
      return `link_secret_unavailable delivery=${result.deliveryId}`
    case 'executed':
      return `executed delivery=${result.deliveryId}`
    case 'stale':
      return `stale delivery=${result.deliveryId}`
    case 'engine_rejected':
      return `engine_rejected:${result.code} delivery=${result.deliveryId}`
    case 'wrapper_not_found':
      return `wrapper_not_found delivery=${result.deliveryId}`
  }
}

export class DingTalkInteractiveCardStreamWorker {
  private readonly logger: Pick<Logger, 'info' | 'warn'>
  private readonly clientFactory: DingTalkInteractiveCardStreamClientFactory
  private readonly callbackExecutor: DingTalkInteractiveCardCallbackExecutor | null
  private defaultCallbackExecutor: Promise<DingTalkInteractiveCardCallbackExecutor> | null = null
  private client: DingTalkInteractiveCardStreamClient | null = null
  private initializing: Promise<DingTalkInteractiveCardStreamWorkerStatus> | null = null
  private status: DingTalkInteractiveCardStreamWorkerStatus = { state: 'disabled', reason: 'env_disabled' }

  constructor(options: {
    logger?: Pick<Logger, 'info' | 'warn'>
    clientFactory?: DingTalkInteractiveCardStreamClientFactory
    /** B-3 dispatch override (tests). Omitted → the lazy production executor. */
    callbackExecutor?: DingTalkInteractiveCardCallbackExecutor
  } = {}) {
    this.logger = options.logger ?? new Logger('DingTalkInteractiveCardStreamWorker')
    this.clientFactory = options.clientFactory ?? unwiredDingTalkInteractiveCardStreamClientFactory
    this.callbackExecutor = options.callbackExecutor ?? null
  }

  getStatus(): DingTalkInteractiveCardStreamWorkerStatus {
    return this.status
  }

  async initialize(env: NodeJS.ProcessEnv = process.env): Promise<DingTalkInteractiveCardStreamWorkerStatus> {
    if (this.initializing) return this.initializing
    if (this.client && this.status.state === 'active') return this.status

    this.initializing = this.initializeOnce(env).finally(() => {
      this.initializing = null
    })
    return this.initializing
  }

  private async initializeOnce(env: NodeJS.ProcessEnv): Promise<DingTalkInteractiveCardStreamWorkerStatus> {
    const config = resolveDingTalkInteractiveCardStreamConfig(env)
    if (config.enabled === false) {
      this.status = { state: 'disabled', reason: config.reason }
      this.logger.info(`DingTalk interactive-card Stream worker disabled (${config.reason})`)
      return this.status
    }

    let createdClient: DingTalkInteractiveCardStreamClient | null = null
    try {
      createdClient = await this.clientFactory(config, {
        onEvent: async (event) => {
          await this.handleEvent(event)
        },
      })
      await createdClient.start()
      this.client = createdClient
      this.status = { state: 'active' }
      this.logger.info('DingTalk interactive-card Stream worker started')
      return this.status
    } catch (error) {
      if (createdClient) {
        try {
          await createdClient.close()
        } catch {
          this.logger.warn('DingTalk interactive-card Stream worker failed to close half-started client (client_start_failed)')
        }
      }
      this.client = null
      const reason = error instanceof Error && error.message === 'DINGTALK_INTERACTIVE_CARD_STREAM_SDK_UNWIRED'
        ? 'sdk_unwired'
        : 'client_start_failed'
      this.status = { state: 'failed', reason }
      // Values-free: do not log SDK error messages because they may include transport payloads or credentials.
      this.logger.warn(`DingTalk interactive-card Stream worker failed to start (${reason})`)
      return this.status
    }
  }

  async shutdown(): Promise<DingTalkInteractiveCardStreamWorkerStatus> {
    if (!this.client) return this.status
    try {
      await this.client.close()
      this.client = null
      this.status = { state: 'disabled', reason: 'env_disabled' }
      this.logger.info('DingTalk interactive-card Stream worker shut down')
      return this.status
    } catch {
      this.status = { state: 'failed', reason: 'client_stop_failed' }
      this.logger.warn('DingTalk interactive-card Stream worker failed to stop (client_stop_failed)')
      return this.status
    }
  }

  private async handleEvent(event: DingTalkInteractiveCardStreamEvent): Promise<void> {
    // This handler is reachable ONLY through a started client, and a client exists ONLY when the
    // env gate resolved enabled — with the flag off (default) no callback can ever execute.
    if (event.payload === undefined) {
      this.logger.info('DingTalk interactive-card Stream event received (no card callback payload; ignored)')
      return
    }
    try {
      const executor = await this.resolveCallbackExecutor()
      const result = await executor(event.payload)
      this.logger.info(`DingTalk interactive-card callback handled (${describeCallbackResult(result)})`)
    } catch {
      // Values-free (lock §4 failure policy): reason code only — never the error message or the
      // payload, either of which may carry transport data or form values.
      this.logger.warn('DingTalk interactive-card callback failed (callback_handler_error)')
    }
  }

  /**
   * Injected executor if provided (tests); otherwise the production executor, materialized once
   * via dynamic import so this module keeps zero import side effects (no pool at load time).
   */
  private resolveCallbackExecutor(): Promise<DingTalkInteractiveCardCallbackExecutor> | DingTalkInteractiveCardCallbackExecutor {
    if (this.callbackExecutor) return this.callbackExecutor
    if (!this.defaultCallbackExecutor) {
      this.defaultCallbackExecutor = (async () => {
        const [{ executeDingTalkApprovalCardCallback }, { poolManager }, { ApprovalProductService }] = await Promise.all([
          import('./interactive-card-callback'),
          import('../../integration/db/connection-pool'),
          import('../../services/ApprovalProductService'),
        ])
        const deps = {
          query: (sql: string, params?: unknown[]) => poolManager.get().query(sql, params),
          approvals: new ApprovalProductService(),
        }
        return (payload: unknown) => executeDingTalkApprovalCardCallback(deps, payload)
      })()
    }
    return this.defaultCallbackExecutor
  }
}
