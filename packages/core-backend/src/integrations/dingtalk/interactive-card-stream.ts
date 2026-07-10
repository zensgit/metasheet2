/**
 * B-1 (DingTalk interactive approval cards): env-gated Stream worker skeleton.
 *
 * This slice deliberately does not execute approval actions. It establishes the
 * optional worker boundary and SDK adapter seam so B-2/B-3 can add send/callback
 * behavior without changing startup/shutdown discipline.
 */
import { Logger } from '../../core/logger'

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
}

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

export class DingTalkInteractiveCardStreamWorker {
  private readonly logger: Pick<Logger, 'info' | 'warn'>
  private readonly clientFactory: DingTalkInteractiveCardStreamClientFactory
  private client: DingTalkInteractiveCardStreamClient | null = null
  private initializing: Promise<DingTalkInteractiveCardStreamWorkerStatus> | null = null
  private status: DingTalkInteractiveCardStreamWorkerStatus = { state: 'disabled', reason: 'env_disabled' }

  constructor(options: {
    logger?: Pick<Logger, 'info' | 'warn'>
    clientFactory?: DingTalkInteractiveCardStreamClientFactory
  } = {}) {
    this.logger = options.logger ?? new Logger('DingTalkInteractiveCardStreamWorker')
    this.clientFactory = options.clientFactory ?? unwiredDingTalkInteractiveCardStreamClientFactory
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

  private async handleEvent(_event: DingTalkInteractiveCardStreamEvent): Promise<void> {
    // B-1 owns only the worker boundary. B-3 will parse callbacks and call the card-delivery wrapper.
    this.logger.info('DingTalk interactive-card Stream event received (ignored by B-1 skeleton)')
  }
}
