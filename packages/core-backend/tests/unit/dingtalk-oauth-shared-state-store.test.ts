import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DingTalkOAuthStateStoreUnavailableError,
  __resetDingTalkOAuthStateStoreForTests,
  generateState,
  isDingTalkOAuthSharedStateStoreRequired,
  validateState,
} from '../../src/auth/dingtalk-oauth'

/**
 * DT-OPS-05 — no Redis is configured in this suite, so the state store is the in-process
 * Map. That is exactly the situation the flag exists to reject: behind more than one
 * replica, a callback can land on a different instance than the launch, so a valid state
 * is rejected and a legitimate login fails; one-time-use is also only guaranteed per
 * process. A transient Redis outage degrades to the same place, silently.
 */
describe('DT-OPS-05 DingTalk OAuth shared state store requirement', () => {
  beforeEach(async () => {
    await __resetDingTalkOAuthStateStoreForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is off unless explicitly enabled', () => {
    expect(isDingTalkOAuthSharedStateStoreRequired()).toBe(false)
    vi.stubEnv('DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE', 'maybe')
    expect(isDingTalkOAuthSharedStateStoreRequired()).toBe(false)
    vi.stubEnv('DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE', 'true')
    expect(isDingTalkOAuthSharedStateStoreRequired()).toBe(true)
  })

  describe('default (single replica) — behavior unchanged', () => {
    it('falls back to the in-process store and round-trips a state', async () => {
      const state = await generateState({ redirectPath: '/inbox' })
      expect(state).toBeTruthy()
      await expect(validateState(state)).resolves.toMatchObject({ valid: true, redirectPath: '/inbox' })
    })

    it('still enforces one-time use within the process', async () => {
      const state = await generateState({})
      await expect(validateState(state)).resolves.toMatchObject({ valid: true })
      await expect(validateState(state)).resolves.toMatchObject({ valid: false })
    })
  })

  describe('with a shared store required and Redis unavailable', () => {
    beforeEach(() => {
      vi.stubEnv('DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE', 'true')
    })

    it('refuses to issue a state rather than writing it somewhere the other replicas cannot see', async () => {
      await expect(generateState({ redirectPath: '/inbox' }))
        .rejects.toBeInstanceOf(DingTalkOAuthStateStoreUnavailableError)
    })

    it('refuses to validate rather than silently consulting the per-process store', async () => {
      // Seed the in-process store the way the legacy path would have.
      vi.stubEnv('DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE', 'false')
      const state = await generateState({})
      vi.stubEnv('DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE', 'true')

      // The load-bearing assertion: the memory store is NOT consulted, so the login is
      // refused instead of succeeding on one replica and failing on the others.
      const result = await validateState(state)
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/temporarily unavailable/i)
    })

    it('reports a 503-shaped error for the launch path', async () => {
      const error = await generateState({}).catch((err) => err)
      expect(error).toBeInstanceOf(DingTalkOAuthStateStoreUnavailableError)
      expect((error as DingTalkOAuthStateStoreUnavailableError).statusCode).toBe(503)
      expect((error as DingTalkOAuthStateStoreUnavailableError).code).toBe('DINGTALK_STATE_STORE_UNAVAILABLE')
    })

    it('still rejects an empty state before touching any store', async () => {
      await expect(validateState('')).resolves.toMatchObject({ valid: false })
    })
  })
})
