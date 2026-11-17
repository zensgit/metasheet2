/**
 * Feishu tenant tokens: minting, the cache and its key, single-flight, the refresh threshold, the
 * minimum mint interval, the verification bypass, and the client layer's one replay per call and
 * bounded re-mints per run. Mint requests go to a local server; time and waits are injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import { __feishuEndpointsForTests } from '../../src/integrations/feishu/endpoints'
import {
  FeishuBusinessError,
  FeishuCredentialError,
  FeishuIncompleteResponseError,
  isFeishuTokenInvalidCode,
  isFeishuTokenInvalidError,
} from '../../src/integrations/feishu/errors'
import {
  FEISHU_TOKEN_LIMITS,
  createFeishuTenantTokenService,
  createFeishuTokenRunBudget,
  type FeishuTenantTokenCredentials,
  type FeishuTenantTokenService,
} from '../../src/integrations/feishu/token'
import { requestFeishuJson } from '../../src/integrations/feishu/transport'
import {
  installNoExternalFetchGuard,
  startFeishuMockServer,
  type MockFeishuServer,
  type MockFeishuStep,
  type NoExternalFetchGuard,
} from '../helpers/feishu-mock-server'

const MINT = 'POST /oauth/v3/token'
const SECRET = 'fx-secret-value-0001-not-real'
const CREDS: FeishuTenantTokenCredentials = { connectionId: 'conn-fx-0001', appId: 'cli_fx_0001', appSecret: SECRET }

describe('Feishu tenant tokens', () => {
  let server: MockFeishuServer
  let guard: NoExternalFetchGuard
  let warnSpy: ReturnType<typeof vi.spyOn>
  let clock: number
  let sleeps: number[]
  let service: FeishuTenantTokenService

  /** One token per mint, in order, each valid for `expiresIn` seconds. */
  const tokens = (expiresIn = 7200, count = 20): MockFeishuStep[] =>
    Array.from({ length: count }, (_unused, index): MockFeishuStep => ({
      kind: 'json',
      body: { access_token: `t-fx-token-${index + 1}-abcdefghij`, expires_in: expiresIn, token_type: 'Bearer' },
    }))

  const build = (overrides: { sleep?: (ms: number) => Promise<void> } = {}): FeishuTenantTokenService =>
    createFeishuTenantTokenService({
      now: () => clock,
      sleep:
        overrides.sleep ??
        (async (ms: number) => {
          sleeps.push(ms)
          clock += ms
        }),
      random: () => 0.5,
      transport: { sleep: async () => false, random: () => 0, timeoutMs: 500 },
    })

  beforeEach(async () => {
    clock = 1_000_000
    sleeps = []
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined) as ReturnType<typeof vi.spyOn>
    server = await startFeishuMockServer()
    __feishuEndpointsForTests.replace(server.origins())
    guard = installNoExternalFetchGuard()
    service = build()
  })

  afterEach(async () => {
    guard.restore()
    __feishuEndpointsForTests.restore()
    await server.close()
    vi.restoreAllMocks()
    expect(guard.violations).toEqual([])
    expect(server.unscripted).toEqual([])
  })

  it('pins the token constants', () => {
    expect(FEISHU_TOKEN_LIMITS).toEqual({
      refreshFloorMs: 300_000,
      refreshFraction: 0.1,
      minMintIntervalMs: 5_000,
      mintJitterMaxMs: 1_000,
      maxRemintsPerRun: 3,
    })
  })

  describe('minting', () => {
    it('posts client credentials as a form and returns the token; credentials are scrubbed in the record', async () => {
      server.script(MINT, tokens())
      await expect(service.getToken(CREDS)).resolves.toBe('t-fx-token-1-abcdefghij')
      const [request] = server.requests
      expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded')
      expect(request.body).toBe('grant_type=client_credentials&client_id=cli_fx_0001&client_secret=<secret>')
    })

    it('refuses an answer without a token or without a positive lifetime', async () => {
      server.script(MINT, [
        { kind: 'json', body: { expires_in: 7200 } },
        { kind: 'json', body: { access_token: '', expires_in: 7200 } },
        { kind: 'json', body: { access_token: 't-fx-x-abcdefghij' } },
        { kind: 'json', body: { access_token: 't-fx-x-abcdefghij', expires_in: 0 } },
      ])
      for (let i = 0; i < 4; i++) {
        const mintOnly = build()
        await expect(mintOnly.mintFresh(CREDS)).rejects.toBeInstanceOf(FeishuIncompleteResponseError)
      }
    })

    it('surfaces the provider rejection as a business error that carries no secret in any text', async () => {
      server.script(MINT, [{ kind: 'json', status: 400, body: { code: 20002, error: 'invalid_client', error_description: SECRET } }])
      const error = (await service.getToken(CREDS).catch((caught: unknown) => caught)) as FeishuBusinessError
      expect(error).toBeInstanceOf(FeishuBusinessError)
      expect(error.code).toBe(20002)
      expect(JSON.stringify(error)).not.toContain(SECRET)
      expect(error.message).not.toContain(SECRET)
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(SECRET)
    })

    it('a failed mint is not cached; the next call mints again', async () => {
      server.script(MINT, [{ kind: 'json', status: 400, body: { code: 20002 } }, ...tokens()])
      await expect(service.getToken(CREDS)).rejects.toBeInstanceOf(FeishuBusinessError)
      await expect(service.getToken(CREDS)).resolves.toBe('t-fx-token-1-abcdefghij')
      expect(server.count(MINT)).toBe(2)
    })
  })

  describe('FX-T04 cache', () => {
    it('concurrent callers with the same key cause one mint and share the token', async () => {
      server.script(MINT, [{ kind: 'json', delayMs: 60, body: { access_token: 't-fx-shared-abcdefghij', expires_in: 7200 } }, ...tokens()])
      const results = await Promise.all(Array.from({ length: 6 }, () => service.getToken(CREDS)))
      expect(new Set(results)).toEqual(new Set(['t-fx-shared-abcdefghij']))
      expect(server.count(MINT)).toBe(1)
    })

    it('serves the cache until the remaining life falls below max(5 minutes, 10% of the lifetime)', async () => {
      // 7200 s lifetime: threshold max(300, 720) = 720 s
      server.script(MINT, tokens(7200))
      const first = await service.getToken(CREDS)
      clock += (7200 - 721) * 1000
      await expect(service.getToken(CREDS)).resolves.toBe(first)
      expect(server.count(MINT)).toBe(1)
      clock += 2 * 1000
      await expect(service.getToken(CREDS)).resolves.toBe('t-fx-token-2-abcdefghij')
      expect(server.count(MINT)).toBe(2)

      // 1000 s lifetime: threshold max(300, 100) = 300 s
      const small = build()
      server.script(MINT, tokens(1000))
      const issued = await small.getToken({ ...CREDS, connectionId: 'conn-fx-0002' })
      clock += (1000 - 301) * 1000
      await expect(small.getToken({ ...CREDS, connectionId: 'conn-fx-0002' })).resolves.toBe(issued)
      clock += 2 * 1000
      await expect(small.getToken({ ...CREDS, connectionId: 'conn-fx-0002' })).resolves.not.toBe(issued)
    })

    it('keys the cache by connection, application and secret fingerprint', async () => {
      server.script(MINT, tokens())
      const base = await service.getToken(CREDS)
      const rotated = await service.getToken({ ...CREDS, appSecret: `${SECRET}-rotated` })
      const otherApp = await service.getToken({ ...CREDS, appId: 'cli_fx_0002' })
      const otherConnection = await service.getToken({ ...CREDS, connectionId: 'conn-fx-0002' })
      expect(new Set([base, rotated, otherApp, otherConnection]).size).toBe(4)
      expect(server.count(MINT)).toBe(4)
      // same key again: served from the cache
      await expect(service.getToken({ ...CREDS, connectionId: 'conn-fx-0002' })).resolves.toBe(otherConnection)
      expect(server.count(MINT)).toBe(4)
    })

    it('a rotated secret never reuses the token of the old one, and the old entry is dropped', async () => {
      server.script(MINT, tokens())
      const old = await service.getToken(CREDS)
      const rotated = await service.getToken({ ...CREDS, appSecret: `${SECRET}-rotated` })
      expect(rotated).not.toBe(old)
      // the connection's old-fingerprint entry is gone: asking with the old secret mints again
      const again = await service.getToken(CREDS)
      expect(again).not.toBe(old)
      expect(server.count(MINT)).toBe(3)
    })

    it('a token-refused error evicts the token; the replay uses a new one', async () => {
      server.script(MINT, tokens())
      let seen: string[] = []
      const result = await service.withTenantToken(CREDS, async (token) => {
        seen.push(token)
        if (seen.length === 1) throw new FeishuBusinessError(99991663, 400, { code: 99991663 })
        return 'done'
      })
      expect(result).toBe('done')
      expect(seen).toEqual(['t-fx-token-1-abcdefghij', 't-fx-token-2-abcdefghij'])
      // the second token is now the cached one
      await expect(service.getToken(CREDS)).resolves.toBe('t-fx-token-2-abcdefghij')
      expect(server.count(MINT)).toBe(2)
    })

    it('eviction with a stale token leaves a newer cached token alone', async () => {
      server.script(MINT, tokens())
      const current = await service.getToken(CREDS)
      service.evict(CREDS, 't-fx-some-older-token-0000')
      await expect(service.getToken(CREDS)).resolves.toBe(current)
      service.evict(CREDS, current)
      await expect(service.getToken(CREDS)).resolves.not.toBe(current)
    })

    it('verification mints fresh and neither reads, writes, evicts nor joins the cache or a mint in progress', async () => {
      server.script(MINT, [
        { kind: 'json', body: { access_token: 't-fx-cached-abcdefghij', expires_in: 7200 } },
        { kind: 'json', body: { access_token: 't-fx-verify-abcdefghij', expires_in: 7200 } },
        { kind: 'json', delayMs: 80, body: { access_token: 't-fx-slow-abcdefghij', expires_in: 7200 } },
        { kind: 'json', body: { access_token: 't-fx-verify-two-abcdefghij', expires_in: 7200 } },
      ])
      const cached = await service.getToken(CREDS)
      const sleepsBefore = sleeps.length
      // not read: a fresh token even though a valid one is cached; no wait for the mint interval
      await expect(service.mintFresh(CREDS)).resolves.toEqual({ accessToken: 't-fx-verify-abcdefghij', expiresInSeconds: 7200 })
      expect(sleeps.length).toBe(sleepsBefore)
      // not written, not evicted: the cached token is still the first one
      await expect(service.getToken(CREDS)).resolves.toBe(cached)
      expect(server.count(MINT)).toBe(2)

      // not joined: a mint in progress for the key does not serve a verification
      service.evict(CREDS)
      const inProgress = service.getToken(CREDS)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const fresh = await service.mintFresh(CREDS)
      expect(fresh.accessToken).toBe('t-fx-verify-two-abcdefghij')
      await expect(inProgress).resolves.toBe('t-fx-slow-abcdefghij')
      expect(server.count(MINT)).toBe(4)
    })

    it('verification does not populate the cache', async () => {
      server.script(MINT, tokens())
      await service.mintFresh(CREDS)
      await service.getToken(CREDS)
      expect(server.count(MINT)).toBe(2)
    })
  })

  describe('FX-T11 minimum mint interval', () => {
    it('waits out the interval (plus the spread) before a re-mint and shares one mint among the waiters', async () => {
      const gates: Array<() => void> = []
      const waitingSleeps: number[] = []
      service = build({
        sleep: (ms: number) =>
          new Promise<void>((resolve) => {
            waitingSleeps.push(ms)
            gates.push(() => {
              clock += ms
              resolve()
            })
          }),
      })
      server.script(MINT, tokens())
      await service.getToken(CREDS) // first mint: no wait
      expect(waitingSleeps).toEqual([])
      service.evict(CREDS)
      clock += 1_000

      const waiters = [service.getToken(CREDS), service.getToken(CREDS), service.getToken(CREDS)]
      await new Promise((resolve) => setTimeout(resolve, 30))
      // inside the interval no second mint request exists yet
      expect(server.count(MINT)).toBe(1)
      // 5000 ms interval + trunc(0.5 * 1000) ms spread - 1000 ms already elapsed
      expect(waitingSleeps).toEqual([4_500])

      gates[0]()
      const results = await Promise.all(waiters)
      expect(new Set(results).size).toBe(1)
      expect(server.count(MINT)).toBe(2)
    })

    it('successive mints of one connection are at least the interval apart', async () => {
      server.script(MINT, tokens())
      const starts: number[] = []
      for (let i = 0; i < 4; i++) {
        await service.getToken(CREDS)
        starts.push(clock)
        service.evict(CREDS)
      }
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(FEISHU_TOKEN_LIMITS.minMintIntervalMs)
      }
    })

    it('a different connection has its own interval', async () => {
      server.script(MINT, tokens())
      await service.getToken(CREDS)
      await service.getToken({ ...CREDS, connectionId: 'conn-fx-0002' })
      expect(sleeps).toEqual([])
    })
  })

  describe('FX-T10 replay lives in the client layer', () => {
    const refused = (code = 99991663) => new FeishuBusinessError(code, 400, { code })

    it('a page that is refused once is replayed once with a new token and succeeds', async () => {
      server.script(MINT, tokens())
      const budget = createFeishuTokenRunBudget()
      let calls = 0
      await expect(
        service.withTenantToken(CREDS, async () => {
          calls += 1
          if (calls === 1) throw refused()
          return 'page'
        }, budget),
      ).resolves.toBe('page')
      expect(calls).toBe(2)
      expect(budget.remints).toBe(1)
    })

    it('a page that is still refused after its replay fails with that refusal, after exactly two calls', async () => {
      server.script(MINT, tokens())
      let calls = 0
      const error = await service
        .withTenantToken(CREDS, async () => {
          calls += 1
          throw refused()
        })
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(FeishuBusinessError)
      expect((error as FeishuBusinessError).code).toBe(99991663)
      expect(calls).toBe(2)
      expect(server.count(MINT)).toBe(2)
    })

    it('a run may re-mint three times in total; the fourth refusal is a credential error without a replay', async () => {
      server.script(MINT, tokens())
      const budget = createFeishuTokenRunBudget()
      const callsPerPage: number[] = []
      for (let page = 0; page < 4; page++) {
        let calls = 0
        const outcome = await service
          .withTenantToken(CREDS, async () => {
            calls += 1
            if (calls === 1) throw refused()
            return `page-${page}`
          }, budget)
          .catch((caught: unknown) => caught)
        callsPerPage.push(calls)
        if (page < 3) expect(outcome).toBe(`page-${page}`)
        else expect(outcome).toBeInstanceOf(FeishuCredentialError)
      }
      expect(callsPerPage).toEqual([2, 2, 2, 1])
      expect(budget.remints).toBe(3)
      expect(server.count(MINT)).toBe(4)
    })

    it('replays the same request: the same path and body, a different bearer token', async () => {
      server.script(MINT, tokens())
      server.script('POST /open-apis/probe', [
        { kind: 'json', status: 400, body: { code: 99991671 } },
        { kind: 'json', body: { code: 0, data: { page: 1 } } },
      ])
      const result = await service.withTenantToken(CREDS, (token) =>
        requestFeishuJson({
          url: `${server.origin}/open-apis/probe`,
          init: { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"page":1}' },
          kind: 'read',
          envelope: 'open_api',
          sleep: async () => false,
        }),
      )
      expect(result).toMatchObject({ code: 0 })
      const probes = server.requests.filter((request) => request.route === 'POST /open-apis/probe')
      expect(probes).toHaveLength(2)
      expect(probes[0].body).toBe(probes[1].body)
      expect(probes[0].path).toBe(probes[1].path)
    })

    it('errors that are not token refusals are not replayed', async () => {
      server.script(MINT, tokens())
      let calls = 0
      await expect(
        service.withTenantToken(CREDS, async () => {
          calls += 1
          throw new FeishuBusinessError(230013, 400, { code: 230013 })
        }),
      ).rejects.toMatchObject({ code: 230013 })
      expect(calls).toBe(1)
      expect(server.count(MINT)).toBe(1)
    })
  })

  describe('FX-T12 the token-refused code class', () => {
    for (const code of [99991661, 99991663, 99991664, 99991665, 99991671, 20013]) {
      it(`${code} evicts and replays once`, async () => {
        expect(isFeishuTokenInvalidCode(code)).toBe(true)
        expect(isFeishuTokenInvalidError(new FeishuBusinessError(code, 400, null))).toBe(true)
        server.script(MINT, tokens())
        let calls = 0
        await service.withTenantToken(CREDS, async () => {
          calls += 1
          if (calls === 1) throw new FeishuBusinessError(code, 400, { code })
          return 'ok'
        })
        expect(calls).toBe(2)
        expect(server.count(MINT)).toBe(2)
      })
    }

    for (const code of [4001, 10013, 20014, 99991668, 99991669, 99991677, 230013, 99991672]) {
      it(`${code} is an ordinary business error: no eviction, no replay`, async () => {
        expect(isFeishuTokenInvalidCode(code)).toBe(false)
        server.script(MINT, tokens())
        let calls = 0
        await expect(
          service.withTenantToken(CREDS, async () => {
            calls += 1
            throw new FeishuBusinessError(code, 400, { code })
          }),
        ).rejects.toMatchObject({ code })
        expect(calls).toBe(1)
        expect(server.count(MINT)).toBe(1)
      })
    }
  })
})
