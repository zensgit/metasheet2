/**
 * B-2 adversarial review P3-1 (shutdown × in-flight initialize race) — now FIXED.
 *
 * B-1's single-flight guard (`if (this.initializing) return this.initializing`) only covers
 * initialize() called concurrently with itself — that lifecycle is already locked in
 * `dingtalk-interactive-card-stream.test.ts` ("does not start twice when initialize is called
 * concurrently or after active"). It did not cover shutdown() racing an in-flight initialize():
 * `shutdown()` early-returned whenever `this.client` was still null — exactly the state while
 * `initializeOnce()` was still awaiting the client factory / `start()` — and the late-resolving
 * initialize then unconditionally activated a worker that was supposed to be dead.
 *
 * The fix (SDK-adapter slice): `shutdown()` latches `shutdownRequested`, and `initializeOnce()`
 * re-checks the latch after every await — closing the client it just created instead of going
 * active. The first test below was authored red against the pre-fix implementation on
 * `claude/dt-card-b2-p3-hardening` (kept `.skip`ped there because that pack was tests+docs only)
 * and is un-skipped here now that the runtime fix exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV,
  DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV,
  DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV,
  DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV,
  DingTalkInteractiveCardStreamWorker,
  type DingTalkInteractiveCardStreamClient,
  type DingTalkInteractiveCardStreamClientFactory,
} from '../../src/integrations/dingtalk/interactive-card-stream'

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() }
}

const activeEnv = env({
  [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
  [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
  [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
  [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: 'template-1',
})

describe('DingTalk interactive-card Stream worker lifecycle races (B-2 P3 hardening)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('closes the client and does not end up active when shutdown() races an in-flight initialize()', async () => {
    const log = logger()
    let resolveStart!: () => void
    const client: DingTalkInteractiveCardStreamClient = {
      start: vi.fn(() => new Promise<void>((resolve) => { resolveStart = resolve })),
      close: vi.fn(async () => {}),
    }
    const factory = vi.fn<DingTalkInteractiveCardStreamClientFactory>(async () => client)
    const worker = new DingTalkInteractiveCardStreamWorker({ logger: log, clientFactory: factory })

    // Kick off initialize(); it will be suspended awaiting client.start().
    const initializePromise = worker.initialize(activeEnv)
    await vi.waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))

    // shutdown() races in while initialize() is still in flight and the client is not yet assigned.
    const shutdownResult = await worker.shutdown()

    // Let the in-flight initialize complete.
    resolveStart()
    const initializeResult = await initializePromise

    // Lifecycle contract: a shutdown() that lands during an in-flight initialize() must not leave
    // a connected client behind, and the worker must not report itself active afterward.
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(initializeResult.state).not.toBe('active')
    expect(worker.getStatus().state).not.toBe('active')
    expect(shutdownResult.state).not.toBe('active')
  })

  it('never even starts the client when shutdown() lands while the factory is still in flight', async () => {
    const log = logger()
    const client: DingTalkInteractiveCardStreamClient = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }
    let resolveFactory!: (created: DingTalkInteractiveCardStreamClient) => void
    const factory = vi.fn<DingTalkInteractiveCardStreamClientFactory>(
      () => new Promise<DingTalkInteractiveCardStreamClient>((resolve) => { resolveFactory = resolve }),
    )
    const worker = new DingTalkInteractiveCardStreamWorker({ logger: log, clientFactory: factory })

    const initializePromise = worker.initialize(activeEnv)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1))

    await worker.shutdown()
    resolveFactory(client)
    const initializeResult = await initializePromise

    // The latch is observed before start(): the freshly created client is closed, never started.
    expect(client.start).not.toHaveBeenCalled()
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(initializeResult.state).not.toBe('active')
    expect(worker.getStatus().state).not.toBe('active')
  })

  it('allows a deliberate fresh initialize() after a raced shutdown (latch is per-lifecycle)', async () => {
    const log = logger()
    let resolveStart!: () => void
    const firstClient: DingTalkInteractiveCardStreamClient = {
      start: vi.fn(() => new Promise<void>((resolve) => { resolveStart = resolve })),
      close: vi.fn(async () => {}),
    }
    const secondClient: DingTalkInteractiveCardStreamClient = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }
    const factory = vi.fn<DingTalkInteractiveCardStreamClientFactory>(async () => firstClient)
    const worker = new DingTalkInteractiveCardStreamWorker({ logger: log, clientFactory: factory })

    const initializePromise = worker.initialize(activeEnv)
    await vi.waitFor(() => expect(firstClient.start).toHaveBeenCalledTimes(1))
    await worker.shutdown()
    resolveStart()
    const racedResult = await initializePromise
    expect(racedResult.state).not.toBe('active')

    factory.mockImplementation(async () => secondClient)
    await expect(worker.initialize(activeEnv)).resolves.toEqual({ state: 'active' })
    expect(secondClient.start).toHaveBeenCalledTimes(1)
    await expect(worker.shutdown()).resolves.toEqual({ state: 'disabled', reason: 'env_disabled' })
    expect(secondClient.close).toHaveBeenCalledTimes(1)
  })
})
