/**
 * B-2 adversarial review P3-1 (shutdown × in-flight initialize race).
 *
 * B-1's single-flight guard (`if (this.initializing) return this.initializing`) only covers
 * initialize() called concurrently with itself — that lifecycle is already locked in
 * `dingtalk-interactive-card-stream.test.ts` ("does not start twice when initialize is called
 * concurrently or after active"). It does not cover shutdown() racing an in-flight initialize():
 * `shutdown()` early-returns whenever `this.client` is still null
 * (`packages/core-backend/src/integrations/dingtalk/interactive-card-stream.ts:181-182`), which is
 * exactly the state while `initializeOnce()` is still awaiting the client factory / `start()`. If
 * that in-flight initialize later resolves successfully, it unconditionally sets `this.client` and
 * flips status to `active` — with no knowledge that shutdown() was ever called in the meantime.
 *
 * This file is intentionally NOT merged into `dingtalk-interactive-card-stream.test.ts` (a
 * different lane owns that file). It documents the desired lifecycle contract with a real,
 * runnable test and leaves it `.skip`ped rather than red, per this hardening pack's scope
 * (tests + docs only, zero runtime change).
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

  // KNOWN RACE — B-2 adversarial review finding P3-1 (/tmp/pr4058-review-claude-20260710.md).
  // Mutation-verified this test is red against the CURRENT implementation (deferred-start client,
  // shutdown() called while `initialize()` is still awaiting `start()`): shutdown() no-ops because
  // `this.client` is still null, then the in-flight initialize resolves and unconditionally
  // activates the client shutdown() never got a chance to close. Runtime fixes are out of scope
  // for this hardening pack (tests + docs only) — leaving this SKIPPED rather than silently
  // asserting the buggy behavior as if it were the contract. A real SDK adapter (B-3+) should make
  // shutdown() await any in-flight `this.initializing` before deciding there is nothing to close.
  it.skip('closes the client and does not end up active when shutdown() races an in-flight initialize()', async () => {
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

    // Desired lifecycle contract: a shutdown() that lands during an in-flight initialize() must
    // not leave a connected client behind, and the worker must not report itself active afterward.
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(initializeResult.state).not.toBe('active')
    expect(worker.getStatus().state).not.toBe('active')
    expect(shutdownResult.state).not.toBe('active')
  })
})
