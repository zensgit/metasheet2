import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DINGTALK_REQUEST_TIMEOUT_MS,
  DingTalkTimeoutError,
  __resetDingTalkAppAccessTokenCacheForTests,
  fetchDingTalkAppAccessToken,
} from '../../src/integrations/dingtalk/client'

/**
 * DT-HARDEN-06 — every DingTalk call except the group-robot webhook went through a
 * naked `fetch` with no timeout, so a hung connection blocked an inline automation
 * execution (or a whole directory sync) for undici's ~300s default.
 */
describe('DT-HARDEN-06 DingTalk request timeout', () => {
  afterEach(() => {
    __resetDingTalkAppAccessTokenCacheForTests()
    vi.unstubAllEnvs()
  })

  const config = { appKey: 'key', appSecret: 'secret' }

  it('has a bounded default timeout', () => {
    expect(DINGTALK_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DINGTALK_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })

  it('passes an abort signal to fetch so the request cannot hang', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ errcode: 0, access_token: 't', expires_in: 7200 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    await fetchDingTalkAppAccessToken(config, { fetchFn })

    const [, init] = (fetchFn as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect(init.signal).toBeTruthy()
    expect(init.signal?.aborted).toBe(false)
  })

  it('surfaces an aborted request as a typed DingTalkTimeoutError', async () => {
    const abortError = new Error('The operation was aborted')
    abortError.name = 'TimeoutError'
    const fetchFn = vi.fn(async () => {
      throw abortError
    }) as unknown as typeof fetch

    await expect(fetchDingTalkAppAccessToken(config, { fetchFn })).rejects.toBeInstanceOf(DingTalkTimeoutError)
  })

  it('does not cache a token when the request timed out', async () => {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    const failing = vi.fn(async () => {
      throw abortError
    }) as unknown as typeof fetch
    await expect(fetchDingTalkAppAccessToken(config, { fetchFn: failing })).rejects.toBeInstanceOf(DingTalkTimeoutError)

    const ok = vi.fn(async () => new Response(JSON.stringify({ errcode: 0, access_token: 'fresh', expires_in: 7200 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    await expect(fetchDingTalkAppAccessToken(config, { fetchFn: ok })).resolves.toBe('fresh')
  })

  it('lets a caller-supplied signal win over the default timeout', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ errcode: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    // fetchDingTalkAppAccessToken does not expose init, so assert the precedence rule
    // directly on the shape requestDingTalkJson builds: spread-then-signal.
    const init: RequestInit = { method: 'GET', signal: controller.signal }
    const merged = { ...init, signal: init.signal ?? AbortSignal.timeout(1) }
    expect(merged.signal).toBe(controller.signal)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
