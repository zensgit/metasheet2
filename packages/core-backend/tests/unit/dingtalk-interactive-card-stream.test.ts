import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV,
  DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV,
  DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV,
  DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID_ENV,
  DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV,
  DingTalkInteractiveCardStreamWorker,
  resolveDingTalkInteractiveCardStreamConfig,
  unwiredDingTalkInteractiveCardStreamClientFactory,
  type DingTalkInteractiveCardCallbackExecutor,
  type DingTalkInteractiveCardStreamClient,
  type DingTalkInteractiveCardStreamClientFactory,
  type DingTalkInteractiveCardStreamHandlers,
} from '../../src/integrations/dingtalk/interactive-card-stream'
import type { DingTalkApprovalCardCallbackResult } from '../../src/integrations/dingtalk/interactive-card-callback'

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
        // P1-2: absent DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID → '' (flag on but unbound);
        // the worker still enables, but the SEND path treats '' as "OA fallback for everyone".
        integrationId: '',
        requirements: {
          clientId: true,
          clientSecret: true,
          templateId: true,
        },
      })
    })

    it('P1-2: carries the bound Stream integration id (trimmed) when configured; enabling is independent of it', () => {
      const bound = resolveDingTalkInteractiveCardStreamConfig(env({
        [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
        [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: 'template-1',
        [DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID_ENV]: '  integration-corp-a  ',
      }))
      expect(bound).toMatchObject({ enabled: true, integrationId: 'integration-corp-a' })

      // A missing integration id does NOT disable the worker (it can still receive callbacks);
      // the cross-corp restriction is enforced only on the SEND path via integrationId === ''.
      const unbound = resolveDingTalkInteractiveCardStreamConfig(env({
        [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
        [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: 'template-1',
      }))
      expect(unbound).toMatchObject({ enabled: true, integrationId: '' })
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
      expect(log.info).toHaveBeenCalledWith('DingTalk interactive-card Stream event received (no card callback payload; ignored)')

      await expect(worker.shutdown()).resolves.toEqual({ state: 'disabled', reason: 'env_disabled' })
      expect(client.close).toHaveBeenCalledTimes(1)
    })

    it('classifies the unwired SDK seam separately from real client failures', async () => {
      // The default factory is now the real `dingtalk-stream` adapter (covered in
      // dingtalk-interactive-card-stream-default-factory.test.ts); the explicit unwired seam
      // keeps the honest `sdk_unwired` classification for SDK-less builds.
      const log = logger()
      const worker = new DingTalkInteractiveCardStreamWorker({
        logger: log,
        clientFactory: unwiredDingTalkInteractiveCardStreamClientFactory,
      })

      await expect(worker.initialize(env({
        [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
        [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: 'template-1',
      }))).resolves.toEqual({ state: 'failed', reason: 'sdk_unwired' })

      expect(log.warn).toHaveBeenCalledWith('DingTalk interactive-card Stream worker failed to start (sdk_unwired)')
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

    it('best-effort closes a half-started client when start fails', async () => {
      const log = logger()
      const client: DingTalkInteractiveCardStreamClient = {
        start: vi.fn(async () => {
          throw new Error('transport opened then failed with credential payload')
        }),
        close: vi.fn(async () => {}),
      }
      const factory = vi.fn<DingTalkInteractiveCardStreamClientFactory>(async () => client)
      const worker = new DingTalkInteractiveCardStreamWorker({ logger: log, clientFactory: factory })

      await expect(worker.initialize(env({
        [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
        [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: 'template-1',
      }))).resolves.toEqual({ state: 'failed', reason: 'client_start_failed' })

      expect(client.start).toHaveBeenCalledTimes(1)
      expect(client.close).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain('credential payload')
    })

    it('does not start twice when initialize is called concurrently or after active', async () => {
      const log = logger()
      let resolveStart!: () => void
      const client: DingTalkInteractiveCardStreamClient = {
        start: vi.fn(() => new Promise<void>((resolve) => { resolveStart = resolve })),
        close: vi.fn(async () => {}),
      }
      const factory = vi.fn<DingTalkInteractiveCardStreamClientFactory>(async () => client)
      const worker = new DingTalkInteractiveCardStreamWorker({ logger: log, clientFactory: factory })
      const activeEnv = env({
        [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
        [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
        [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: 'template-1',
      })

      const first = worker.initialize(activeEnv)
      const second = worker.initialize(activeEnv)
      await vi.waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
      resolveStart()
      await expect(first).resolves.toEqual({ state: 'active' })
      await expect(second).resolves.toEqual({ state: 'active' })
      await expect(worker.initialize(activeEnv)).resolves.toEqual({ state: 'active' })

      expect(factory).toHaveBeenCalledTimes(1)
      expect(client.start).toHaveBeenCalledTimes(1)
    })
  })

  // ── B-3: callback dispatch behind the SAME env gate (lock §B-3 step 8) ──────────────────────
  describe('B-3 callback dispatch', () => {
    const activeEnv = () => env({
      [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
      [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
      [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
      [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: 'template-1',
    })

    function activeWorker(executor: DingTalkInteractiveCardCallbackExecutor) {
      const log = logger()
      let handlers: DingTalkInteractiveCardStreamHandlers | null = null
      const client: DingTalkInteractiveCardStreamClient = {
        start: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }
      const factory = vi.fn<DingTalkInteractiveCardStreamClientFactory>(async (_config, h) => {
        handlers = h
        return client
      })
      const worker = new DingTalkInteractiveCardStreamWorker({ logger: log, clientFactory: factory, callbackExecutor: executor })
      return { log, worker, factory, handlers: () => handlers }
    }

    it('FLAG DEFAULT OFF: with an empty env no client starts and no callback can ever execute', async () => {
      const log = logger()
      const executor = vi.fn<DingTalkInteractiveCardCallbackExecutor>()
      const factory = vi.fn<DingTalkInteractiveCardStreamClientFactory>()
      const worker = new DingTalkInteractiveCardStreamWorker({ logger: log, clientFactory: factory, callbackExecutor: executor })

      await expect(worker.initialize(env())).resolves.toEqual({ state: 'disabled', reason: 'env_disabled' })
      expect(factory).not.toHaveBeenCalled()
      expect(executor).not.toHaveBeenCalled()
    })

    it('dispatches a payload-carrying event to the callback executor exactly once and logs values-free', async () => {
      const executor = vi.fn<DingTalkInteractiveCardCallbackExecutor>(async () => ({
        outcome: 'executed',
        deliveryId: 'd-1',
        summary: { approval: { title: 'SECRET_TITLE' } } as never,
      }))
      const { log, worker, factory, handlers } = activeWorker(executor)
      await expect(worker.initialize(activeEnv())).resolves.toEqual({ state: 'active' })
      expect(factory).toHaveBeenCalledTimes(1)

      const payload = { outTrackId: 'd-1', userId: 'dd_op', content: 'SECRET_FORM_VALUE' }
      await handlers()!.onEvent({ eventType: 'CARD_CALLBACK', payload })

      expect(executor).toHaveBeenCalledTimes(1)
      expect(executor).toHaveBeenCalledWith(payload)
      const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])
      expect(logged).toContain('executed delivery=d-1')
      expect(logged).not.toContain('SECRET_FORM_VALUE')
      expect(logged).not.toContain('SECRET_TITLE')
      expect(logged).not.toContain('dd_op')
    })

    it('payload-less transport events never touch the callback executor', async () => {
      const executor = vi.fn<DingTalkInteractiveCardCallbackExecutor>()
      const { log, worker, handlers } = activeWorker(executor)
      await worker.initialize(activeEnv())

      await handlers()!.onEvent({ eventType: 'ping', eventId: 'evt-2' })
      expect(executor).not.toHaveBeenCalled()
      expect(log.info).toHaveBeenCalledWith('DingTalk interactive-card Stream event received (no card callback payload; ignored)')
    })

    it('executor throw → values-free reason-code warn, never the error or payload', async () => {
      const executor = vi.fn<DingTalkInteractiveCardCallbackExecutor>(async () => {
        throw new Error('boom with SECRET_FORM_VALUE and credentials')
      })
      const { log, worker, handlers } = activeWorker(executor)
      await worker.initialize(activeEnv())

      await expect(handlers()!.onEvent({ payload: { outTrackId: 'x' } })).resolves.toBeUndefined()
      expect(log.warn).toHaveBeenCalledWith('DingTalk interactive-card callback failed (callback_handler_error)')
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain('SECRET_FORM_VALUE')
    })

    it('reports rejected/refusal outcomes as reason codes only', async () => {
      const outcomes: DingTalkApprovalCardCallbackResult[] = [
        { outcome: 'rejected', reason: 'out_track_id_not_uuid' },
        { outcome: 'ignored_unsupported_action', outTrackId: 'd-2' },
        { outcome: 'operator_unresolved', deliveryId: 'd-3', reason: 'unlinked' },
      ]
      const executor = vi.fn<DingTalkInteractiveCardCallbackExecutor>()
      outcomes.forEach((o) => executor.mockResolvedValueOnce(o))
      const { log, worker, handlers } = activeWorker(executor)
      await worker.initialize(activeEnv())

      for (let i = 0; i < outcomes.length; i += 1) {
        await handlers()!.onEvent({ payload: {} })
      }
      const logged = JSON.stringify(log.info.mock.calls)
      expect(logged).toContain('rejected:out_track_id_not_uuid')
      expect(logged).toContain('ignored_unsupported_action out_track_id=d-2')
      expect(logged).toContain('operator_unresolved:unlinked delivery=d-3')
    })
  })
})
