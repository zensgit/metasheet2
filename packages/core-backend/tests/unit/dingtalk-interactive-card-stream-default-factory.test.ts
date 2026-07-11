/**
 * Import-discipline lock for the production default client factory (SDK-adapter slice).
 *
 * With the env flag OFF (the default), constructing + initializing the worker must have ZERO SDK
 * side effects: neither the adapter module (`interactive-card-stream-sdk.ts`) nor the
 * `dingtalk-stream` package may even be imported. With the flag ON, the default factory routes
 * through the adapter module exactly once (dynamic import inside the gated path only).
 *
 * Both modules are vi.mocked with load-counting factories; the counters can only move if a
 * dynamic import actually happens — this file itself never imports either statically.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV,
  DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV,
  DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV,
  DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV,
  DingTalkInteractiveCardStreamWorker,
} from '../../src/integrations/dingtalk/interactive-card-stream'

const loads = vi.hoisted(() => ({
  sdkPackage: 0,
  adapterModule: 0,
  createClient: vi.fn(),
}))

vi.mock('dingtalk-stream', () => {
  loads.sdkPackage += 1
  return {}
})

vi.mock('../../src/integrations/dingtalk/interactive-card-stream-sdk', () => {
  loads.adapterModule += 1
  return {
    createDingTalkInteractiveCardStreamSdkClient: (...args: unknown[]) => loads.createClient(...args),
  }
})

function logger() {
  return { info: vi.fn(), warn: vi.fn() }
}

describe('DingTalk interactive-card Stream default factory import discipline', () => {
  it('flag OFF (default): initialize() has zero SDK side effects — adapter and SDK never imported', async () => {
    const worker = new DingTalkInteractiveCardStreamWorker({ logger: logger() })

    await expect(worker.initialize({} as NodeJS.ProcessEnv)).resolves.toEqual({
      state: 'disabled',
      reason: 'env_disabled',
    })

    expect(loads.adapterModule).toBe(0)
    expect(loads.sdkPackage).toBe(0)
    expect(loads.createClient).not.toHaveBeenCalled()
  })

  it('flag ON: the default factory dynamically imports the SDK adapter and starts its client', async () => {
    const client = { start: vi.fn(async () => {}), close: vi.fn(async () => {}) }
    loads.createClient.mockResolvedValue(client)
    const worker = new DingTalkInteractiveCardStreamWorker({ logger: logger() })

    await expect(worker.initialize({
      [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
      [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
      [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
      [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: 'template-1',
    } as NodeJS.ProcessEnv)).resolves.toEqual({ state: 'active' })

    expect(loads.adapterModule).toBe(1)
    expect(loads.createClient).toHaveBeenCalledTimes(1)
    expect(loads.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, clientId: 'client-1', templateId: 'template-1' }),
      expect.objectContaining({ onEvent: expect.any(Function) }),
    )
    expect(client.start).toHaveBeenCalledTimes(1)
    // The mocked adapter never touches the real package.
    expect(loads.sdkPackage).toBe(0)

    await expect(worker.shutdown()).resolves.toEqual({ state: 'disabled', reason: 'env_disabled' })
    expect(client.close).toHaveBeenCalledTimes(1)
  })
})
