import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV,
  DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV,
  DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV,
  DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV,
  DingTalkInteractiveCardStreamWorker,
  resolveDingTalkInteractiveCardStreamConfig,
  type DingTalkInteractiveCardStreamClient,
  type DingTalkInteractiveCardStreamClientFactory,
  type DingTalkInteractiveCardStreamHandlers,
} from '../../src/integrations/dingtalk/interactive-card-stream'

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...overrides,
  } as NodeJS.ProcessEnv
}

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  }
}

describe('DingTalk interactive-card Stream worker (B-1)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  describe('resolveDingTalkInteractiveCardStreamConfig', () => {
    it('is disabled by default and reports requirements without reading secrets into logs', () => {
      const config = resolveDingTalkInteractiveCardStreamConfig(env())
      expect(config).toEqual({
        enabled: false,
        reason: 'env_disabled',
        requirements: {
          clientId: false,
          clientSecret: false,
          templateId: false,
        },
      })
    })

    it('requires explicit enable plus all three Stream settings', () => {
      expect(resolveDingTalkInteractiveCardStreamConfig(env({
        [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
      }))).toMatchObject({ enabled: false, reason: 'missing_client_id' })

      expect(resolveDingTalkInteractiveCardStreamConfig(env({
        [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: 'true',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
      }))).toMatchObject({ enabled: false, reason: 'missing_client_secret' })

      expect(resolveDingTalkInteractiveCardStreamConfig(env({
        [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
      }))).toMatchObject({ enabled: false, reason: 'missing_template_id' })
    })

    it('resolves active config only when the flag and all settings are present', () => {
      const config = resolveDingTalkInteractiveCardStreamConfig(env({
        [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: ' client-1 ',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: ' secret-1 ',
        [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: ' template-1 ',
      }))
      expect(config).toEqual({
        enabled: true,
        clientId: 'client-1',
        clientSecret: 'secret-1',
        templateId: 'template-1',
        requirements: {
          clientId: true,
          clientSecret: true,
          templateId: true,
        },
      })
    })
  })

  describe('DingTalkInteractiveCardStreamWorker', () => {
    it('does not call the Stream client factory when disabled', async () => {
      const log = logger()
      const factory = vi.fn<DingTalkInteractiveCardStreamClientFactory>()
      const worker = new DingTalkInteractiveCardStreamWorker({ logger: log, clientFactory: factory })

      await expect(worker.initialize(env())).resolves.toEqual({ state: 'disabled', reason: 'env_disabled' })
      expect(factory).not.toHaveBeenCalled()
      expect(log.info).toHaveBeenCalledWith('DingTalk interactive-card Stream worker disabled (env_disabled)')
    })

    it('starts the injected Stream client when fully configured and ignores events in B-1', async () => {
      const log = logger()
      const client: DingTalkInteractiveCardStreamClient = {
        start: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }
      let handlers: DingTalkInteractiveCardStreamHandlers | null = null
      const factory = vi.fn<DingTalkInteractiveCardStreamClientFactory>(async (_config, h) => {
        handlers = h
        return client
      })
      const worker = new DingTalkInteractiveCardStreamWorker({ logger: log, clientFactory: factory })

      await expect(worker.initialize(env({
        [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
        [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: 'template-1',
      }))).resolves.toEqual({ state: 'active' })

      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          clientId: 'client-1',
          clientSecret: 'secret-1',
          templateId: 'template-1',
        }),
        expect.objectContaining({ onEvent: expect.any(Function) }),
      )
      expect(client.start).toHaveBeenCalledTimes(1)

      await handlers?.onEvent({ eventType: 'approval-card-click', eventId: 'evt-1' })
      expect(log.info).toHaveBeenCalledWith('DingTalk interactive-card Stream event received (ignored by B-1 skeleton)')

      await expect(worker.shutdown()).resolves.toEqual({ state: 'disabled', reason: 'env_disabled' })
      expect(client.close).toHaveBeenCalledTimes(1)
    })

    it('fails closed and logs only a reason code when the client factory throws', async () => {
      const log = logger()
      const factory = vi.fn<DingTalkInteractiveCardStreamClientFactory>(async () => {
        throw new Error('secret-1 raw payload leaked by SDK')
      })
      const worker = new DingTalkInteractiveCardStreamWorker({ logger: log, clientFactory: factory })

      await expect(worker.initialize(env({
        [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
        [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: 'template-1',
      }))).resolves.toEqual({ state: 'failed', reason: 'client_start_failed' })

      expect(log.warn).toHaveBeenCalledWith('DingTalk interactive-card Stream worker failed to start (client_start_failed)')
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret-1')
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain('raw payload')
    })
  })
})
