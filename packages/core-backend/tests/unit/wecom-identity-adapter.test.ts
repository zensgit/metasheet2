import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import { importSpecifiers } from '../helpers/import-edge-allowlist'
import {
  buildWeComExternalKey,
  createWeComIdentityAdapter,
  normalizeWeComLoginRedirectUri,
  normalizeWeComSubjectKey,
  WeComLoginStateError,
  WeComRedirectUriError,
  type WeComIdentityAdapter,
  type WeComIdentityResult,
} from '../../src/auth/external/wecom-identity-adapter'
import {
  __resetWeComAppAccessTokenCacheForTests,
  exchangeWeComLoginCode,
  getWeComMember,
  isValidWeComLoginCode,
  isWeComTokenStageError,
  observeWeComTransportRetries,
  WeComIncompleteResponseError,
  WeComInvalidInputError,
  type WeComRequestOptions,
} from '../../src/integrations/wecom/client'
import {
  WECOM_FIXTURE_AGENT_ID,
  WECOM_FIXTURE_CORP_ID,
  WECOM_FIXTURE_SECRET,
  WECOM_FIXTURE_TOKEN,
  abortError,
  createWeComFetchStub,
  errcodeReply,
  failWith,
  httpStatus,
  memberPayload,
  nonMemberPayload,
  ok,
  rawBody,
  userinfoPayload,
  type WeComStubResponder,
  type WeComStubSpec,
} from '../fixtures/directory/wecom/wecom-fixtures'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ADAPTER_SOURCE = path.resolve(HERE, '../../src/auth/external/wecom-identity-adapter.ts')
const REAL_FETCH = globalThis.fetch

const CONNECTION = { id: 'integration-1', corpId: WECOM_FIXTURE_CORP_ID, wecomAgentId: WECOM_FIXTURE_AGENT_ID }
const CREDENTIALS = { corpSecret: WECOM_FIXTURE_SECRET }
const TOKEN_CONFIG = { corpId: WECOM_FIXTURE_CORP_ID, corpSecret: WECOM_FIXTURE_SECRET }
const REDIRECT = 'https://app.example.test/auth/wecom/callback'
const CODE = 'fixture-login-code-canary'
const STATE = '0123456789abcdef0123456789abcdef'
const EXPECTED_URL =
  'https://login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp'
  + `&appid=${WECOM_FIXTURE_CORP_ID}&agentid=${WECOM_FIXTURE_AGENT_ID}`
  + '&redirect_uri=https%3A%2F%2Fapp.example.test%2Fauth%2Fwecom%2Fcallback'
  + `&state=${STATE}`

interface TestClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

function createClock(): TestClock {
  let current = 0
  return {
    now: () => current,
    sleep: async (ms) => { current += ms },
  }
}

function seams(clock: TestClock): WeComRequestOptions {
  return { now: clock.now, sleep: clock.sleep, random: () => 0 }
}

function loginSpec(over: WeComStubSpec = {}): WeComStubSpec {
  return { userinfo: ok(userinfoPayload()), member: ok(memberPayload()), ...over }
}

function setup(spec: WeComStubSpec, fetchWrapper?: (fetchFn: typeof fetch) => typeof fetch, baseUrl?: string) {
  const stub = createWeComFetchStub(spec)
  const fetchFn = fetchWrapper ? fetchWrapper(stub.fetchFn) : stub.fetchFn
  const requestOptions: WeComRequestOptions = { fetchFn, ...seams(createClock()) }
  const adapter = createWeComIdentityAdapter({ redirectUri: REDIRECT, requestOptions, baseUrl })
  return { stub, adapter, requestOptions }
}

/** Test-name prefix for an assertion that rests on a platform fact not yet confirmed against a real tenant. */
const assumes = (flag: boolean): string => (flag ? 'assumes: ' : '')

const exchange = (adapter: WeComIdentityAdapter, code = CODE) =>
  adapter.exchangeCode({ connection: CONNECTION, credentials: CREDENTIALS, code })

type FailedResult = Extract<WeComIdentityResult, { ok: false }>

function expectRejected(result: WeComIdentityResult, reason: string, adminReason?: string): void {
  expect(result.ok).toBe(false)
  const failed = result as FailedResult
  expect(failed.outcome).toBe('rejected')
  expect(failed.reason).toBe(reason)
  expect((failed as { adminReason?: string }).adminReason).toBe(adminReason)
}

function expectUnavailable(result: WeComIdentityResult, reason: string): void {
  expect(result.ok).toBe(false)
  const failed = result as FailedResult
  expect(failed.outcome).toBe('unavailable')
  expect(failed.reason).toBe(reason)
}

function spyOnOutput() {
  const noop = () => undefined
  return [
    vi.spyOn(Logger.prototype, 'warn'),
    vi.spyOn(Logger.prototype, 'info'),
    vi.spyOn(Logger.prototype, 'error'),
    vi.spyOn(Logger.prototype, 'debug'),
    vi.spyOn(console, 'log').mockImplementation(noop),
    vi.spyOn(console, 'info').mockImplementation(noop),
    vi.spyOn(console, 'warn').mockImplementation(noop),
    vi.spyOn(console, 'error').mockImplementation(noop),
    vi.spyOn(console, 'debug').mockImplementation(noop),
  ]
}

function outputText(spies: Array<ReturnType<typeof vi.spyOn>>): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const own: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(error)) own[key] = (error as unknown as Record<string, unknown>)[key]
  return `${error.name} ${error.message} ${JSON.stringify(own)}`
}

const FORBIDDEN = [
  CODE,
  WECOM_FIXTURE_TOKEN,
  'fixture-access-token-2',
  WECOM_FIXTURE_SECRET,
  'access_token',
  'corpsecret',
  'https://',
  'qyapi',
  'provider-text-that-must-not-leak',
  'fixture-openid-canary',
  'fixture-external-canary',
  'user-doc-ticket-canary',
]

beforeEach(() => {
  __resetWeComAppAccessTokenCacheForTests()
  globalThis.fetch = (() => { throw new Error('real network is not available in this test') }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = REAL_FETCH
  vi.restoreAllMocks()
})

describe('WeCom identity adapter: authorization URL', () => {
  const adapter = createWeComIdentityAdapter({ redirectUri: REDIRECT })

  it('builds the exact URL with the parameters in a fixed order', () => {
    const url = adapter.buildAuthorizationUrl(CONNECTION, STATE)
    expect(url).toBe(EXPECTED_URL)
    expect([...new URL(url).searchParams.keys()]).toEqual(['login_type', 'appid', 'agentid', 'redirect_uri', 'state'])
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(REDIRECT)
  })

  it('carries no PKCE, language or redirect-type parameter', () => {
    const url = adapter.buildAuthorizationUrl(CONNECTION, STATE)
    for (const name of ['code_challenge', 'code_challenge_method', 'lang', 'redirect_type']) {
      expect(new URL(url).searchParams.has(name)).toBe(false)
    }
  })

  it('takes the redirect address from the deployment option and ignores one supplied with the connection', () => {
    const hostile = { ...CONNECTION, redirectUri: 'https://attacker.example.test/cb', redirect_uri: 'https://attacker.example.test/cb' }
    const url = adapter.buildAuthorizationUrl(hostile, STATE)
    expect(url).toBe(EXPECTED_URL)
    expect(url).not.toContain('attacker')
  })

  it('has no redirect address in the input of buildAuthorizationUrl', () => {
    const source = fs.readFileSync(ADAPTER_SOURCE, 'utf8')
    const declaration = source.match(/buildAuthorizationUrl\(connection: [^\n]*\): string/)
    expect(declaration).not.toBeNull()
    expect(declaration![0]).not.toMatch(/redirect/i)
  })

  for (const state of ['', STATE.slice(1), `${STATE}0`, STATE.toUpperCase(), 'g'.repeat(32), `${STATE.slice(0, 31)}&`, `${STATE.slice(0, 31)}\n`]) {
    it(`rejects the state ${JSON.stringify(state)}`, () => {
      expect(() => adapter.buildAuthorizationUrl(CONNECTION, state)).toThrow(WeComLoginStateError)
    })
  }

  it('accepts any 32-character lower-case hexadecimal state', () => {
    for (const state of ['a'.repeat(32), '0'.repeat(32), 'f0e1d2c3b4a5968778695a4b3c2d1e0f']) {
      expect(adapter.buildAuthorizationUrl(CONNECTION, state)).toContain(`&state=${state}`)
    }
  })

  it('rejects an invalid corp id or agent id before building any string', () => {
    for (const corpId of ['', 'has space', 'x'.repeat(65), 'é']) {
      expect(() => adapter.buildAuthorizationUrl({ ...CONNECTION, corpId }, STATE)).toThrow(WeComInvalidInputError)
    }
    for (const wecomAgentId of ['', '0', '01', 'abc', '1'.repeat(16), '10&agentid=2']) {
      expect(() => adapter.buildAuthorizationUrl({ ...CONNECTION, wecomAgentId }, STATE)).toThrow(WeComInvalidInputError)
    }
  })

  it('percent-encodes every value it places in the query', () => {
    const url = createWeComIdentityAdapter({ redirectUri: 'https://app.example.test/a%20b/cb' })
      .buildAuthorizationUrl({ ...CONNECTION, corpId: 'corp&x=1' }, STATE)
    expect(url).toContain('&appid=corp%26x%3D1&')
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp.example.test%2Fa%2520b%2Fcb&')
  })

  describe('redirect address validation', () => {
    const rejectedUris: Array<[string, unknown]> = [
      ['empty', ''],
      ['blank', '   '],
      ['not a string', undefined],
      ['relative', '/auth/wecom/callback'],
      ['plain http', 'http://app.example.test/cb'],
      ['userinfo', 'https://user:pass@app.example.test/cb'],
      ['user only', 'https://user@app.example.test/cb'],
      ['fragment', 'https://app.example.test/cb#frag'],
      ['empty fragment', 'https://app.example.test/cb#'],
      ['query', 'https://app.example.test/cb?x=1'],
      ['empty query', 'https://app.example.test/cb?'],
      ['surrounding space', ' https://app.example.test/cb'],
      ['other scheme', 'javascript:alert(1)'],
    ]
    for (const [name, value] of rejectedUris) {
      it(`rejects ${name}`, () => {
        expect(() => createWeComIdentityAdapter({ redirectUri: value as string })).toThrow(WeComRedirectUriError)
      })
    }

    it('does not echo the rejected value', () => {
      let thrown: unknown
      try {
        normalizeWeComLoginRedirectUri('https://user:secret-canary@app.example.test/cb')
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(WeComRedirectUriError)
      expect(describeError(thrown)).not.toContain('secret-canary')
    })

    it('normalises the host and a default port', () => {
      expect(normalizeWeComLoginRedirectUri('https://App.Example.TEST:443/cb')).toBe('https://app.example.test/cb')
      expect(normalizeWeComLoginRedirectUri('https://app.example.test:8443/cb')).toBe('https://app.example.test:8443/cb')
      expect(normalizeWeComLoginRedirectUri('https://app.example.test')).toBe('https://app.example.test/')
    })

    it('accepts an http loopback address only when a test injects it, and never another http host', () => {
      expect(() => createWeComIdentityAdapter({ redirectUri: 'http://127.0.0.1:8900/cb' })).toThrow(WeComRedirectUriError)
      for (const host of ['127.0.0.1:8900', 'localhost:8900', '[::1]:8900']) {
        const built = createWeComIdentityAdapter({ redirectUri: `http://${host}/cb`, allowLoopbackHttp: true })
        expect(new URL(built.buildAuthorizationUrl(CONNECTION, STATE)).searchParams.get('redirect_uri')).toBe(`http://${host}/cb`)
      }
      expect(() => createWeComIdentityAdapter({ redirectUri: 'http://app.example.test/cb', allowLoopbackHttp: true })).toThrow(WeComRedirectUriError)
    })
  })
})

describe('WeCom identity adapter: login-code exchange shapes', () => {
  it('resolves a member after one exchange and one online check', async () => {
    const { stub, adapter } = setup(loginSpec())
    const result = await exchange(adapter)
    expect(result).toEqual({
      ok: true,
      subject: {
        provider: 'wecom',
        connectionId: 'integration-1',
        tenant: WECOM_FIXTURE_CORP_ID,
        appScope: WECOM_FIXTURE_AGENT_ID,
        subjectType: 'wecom_userid',
        subjectKey: 'zhang.san',
        providerUserId: 'Zhang.San',
        memberVerification: 'online_verified',
      },
    })
    expect(stub.count('userinfo')).toBe(1)
    expect(stub.count('member')).toBe(1)
  })

  for (const [name, payload] of [
    ['openid and external_userid', nonMemberPayload()],
    ['openid only', { errcode: 0, openid: 'fixture-openid-canary' }],
    ['external_userid only', { errcode: 0, external_userid: 'fixture-external-canary' }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`rejects a non-member answer carrying ${name} without an online check and never returns the identifier`, async () => {
      const { stub, adapter } = setup({ userinfo: ok(payload) })
      const result = await exchange(adapter)
      expectRejected(result, 'subject_not_member')
      expect(stub.count('member')).toBe(0)
      expect(JSON.stringify(result)).not.toMatch(/canary/)
    })
  }

  it('reports the member and the non-member answers at the client without the openid value', async () => {
    const memberStub = createWeComFetchStub({ userinfo: ok(userinfoPayload()) })
    await expect(exchangeWeComLoginCode(TOKEN_CONFIG, CODE, { fetchFn: memberStub.fetchFn })).resolves.toEqual({ kind: 'member', userid: 'Zhang.San' })
    const otherStub = createWeComFetchStub({ userinfo: ok(nonMemberPayload()) })
    const other = await exchangeWeComLoginCode(TOKEN_CONFIG, CODE, { fetchFn: otherStub.fetchFn })
    expect(other).toEqual({ kind: 'non_member' })
    expect(JSON.stringify(other)).not.toMatch(/canary/)
  })

  const faults: Array<[string, WeComStubResponder]> = [
    ['neither userid nor openid', ok({ errcode: 0, errmsg: 'ok' })],
    ['a numeric userid', ok(userinfoPayload({ userid: 5 }))],
    ['an empty userid', ok(userinfoPayload({ userid: '' }))],
    ['an array userid', ok(userinfoPayload({ userid: ['Zhang.San'] }))],
    ['a numeric openid', ok({ errcode: 0, openid: 12 })],
    ['an empty openid', ok({ errcode: 0, openid: '' })],
    ['both userid and openid', ok(userinfoPayload({ openid: 'fixture-openid-canary' }))],
    ['both userid and external_userid', ok(userinfoPayload({ external_userid: 'fixture-external-canary' }))],
    ['no errcode', ok({ userid: 'Zhang.San' })],
    ['a non-numeric errcode', ok({ errcode: 'ok', userid: 'Zhang.San' })],
    ['a null errcode', ok({ errcode: null, userid: 'Zhang.San' })],
    ['an array body', ok([])],
    ['a null body', ok(null)],
    ['a body that is not JSON', rawBody('<html>gateway</html>')],
  ]
  for (const [name, responder] of faults) {
    it(`${assumes(name.startsWith('both userid'))}treats ${name} as an incomplete response and never as a pass`, async () => {
      const { stub, adapter } = setup({ userinfo: responder })
      expectUnavailable(await exchange(adapter), 'incomplete_response')
      expect(stub.count('userinfo')).toBe(1)
      expect(stub.count('member')).toBe(0)
      const error = await exchangeWeComLoginCode(TOKEN_CONFIG, CODE, { fetchFn: createWeComFetchStub({ userinfo: responder }).fetchFn }).catch((e) => e)
      expect(error).toBeInstanceOf(WeComIncompleteResponseError)
    })
  }

  it('drops extra fields of the exchange answer and never logs them', async () => {
    const spies = spyOnOutput()
    const { adapter } = setup(loginSpec({
      userinfo: ok(userinfoPayload({ user_doc_ticket: 'user-doc-ticket-canary', ticket: 'user-doc-ticket-canary', nested: { a: 1 } })),
    }))
    const result = await exchange(adapter)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('user-doc-ticket-canary')
    expect(outputText(spies)).not.toContain('user-doc-ticket-canary')
  })

  it('writes the code percent-encoded into the query and sends exactly one request per call', async () => {
    const raw: string[] = []
    const code = 'a+b/c=d&e%f'
    const { stub, adapter } = setup(loginSpec(), (fetchFn) => ((input: unknown, init?: RequestInit) => {
      raw.push(String(input))
      return fetchFn(input as Parameters<typeof fetch>[0], init)
    }) as typeof fetch)
    expect((await exchange(adapter, code)).ok).toBe(true)
    const login = raw.find((url) => url.includes('/auth/getuserinfo'))!
    expect(login).toContain('&code=a%2Bb%2Fc%3Dd%26e%25f')
    expect(new URL(login).searchParams.get('code')).toBe(code)
    expect(stub.count('userinfo')).toBe(1)
  })

  it('sends getuserinfo as a GET', async () => {
    const { stub, adapter } = setup(loginSpec())
    await exchange(adapter)
    for (const request of stub.requests) expect(request.method).toBe('GET')
  })
})

describe('WeCom identity adapter: code precheck', () => {
  const badCodes: Array<[string, string]> = [
    ['empty', ''],
    ['513 bytes', 'a'.repeat(513)],
    ['with a space', 'bad code'],
    ['with a tab', 'bad\tcode'],
    ['with a newline', 'bad\ncode'],
    ['non-ASCII', 'cödé'],
    ['control character', 'bad\u0001code'],
    ['non-string', null as unknown as string],
  ]
  for (const [name, code] of badCodes) {
    it(`rejects a code that is ${name} before any request`, async () => {
      const { stub, adapter } = setup(loginSpec())
      expectRejected(await exchange(adapter, code), 'code_invalid')
      expect(stub.requests).toHaveLength(0)
    })
  }

  it('accepts a 512-byte visible ASCII code', async () => {
    const { stub, adapter } = setup(loginSpec())
    expect((await exchange(adapter, 'a'.repeat(512))).ok).toBe(true)
    expect(stub.count('userinfo')).toBe(1)
  })

  it('validates the code with the client rule and raises a typed error at the client', async () => {
    expect(isValidWeComLoginCode('x'.repeat(512))).toBe(true)
    expect(isValidWeComLoginCode('x'.repeat(513))).toBe(false)
    expect(isValidWeComLoginCode('a b')).toBe(false)
    expect(isValidWeComLoginCode('')).toBe(false)
    const stub = createWeComFetchStub({})
    const error = await exchangeWeComLoginCode(TOKEN_CONFIG, 'a b', { fetchFn: stub.fetchFn }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComInvalidInputError)
    expect((error as WeComInvalidInputError).field).toBe('code')
    expect(stub.requests).toHaveLength(0)
  })
})

describe('WeCom identity adapter: userid rules', () => {
  const accepted: Array<[string, string]> = [
    ['Zhang.San', 'zhang.san'],
    ['MiXeD.Case', 'mixed.case'],
    ['a@b.c_d-e', 'a@b.c_d-e'],
    ['A', 'a'],
    ['x'.repeat(64), 'x'.repeat(64)],
  ]
  for (const [userid, key] of accepted) {
    it(`assumes: keeps ${userid.slice(0, 20)} as the provider id and lower-cases the key`, async () => {
      const { stub, adapter } = setup(loginSpec({ userinfo: ok(userinfoPayload({}, userid)), member: ok(memberPayload(userid)) }))
      const result = await exchange(adapter)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.subject.providerUserId).toBe(userid)
      expect(result.subject.subjectKey).toBe(key)
      expect(stub.requests.find((request) => request.route === 'member')!.query.userid).toBe(userid)
    })
  }

  for (const userid of ['corp/zhangsan', 'x'.repeat(65), 'bad char', '_lead', '-lead', '.lead', 'a/b', 'a;b', 'zhang\nsan']) {
    it(`assumes: rejects ${JSON.stringify(userid.slice(0, 20))} without an online check`, async () => {
      const { stub, adapter } = setup(loginSpec({ userinfo: ok(userinfoPayload({}, userid)) }))
      expectRejected(await exchange(adapter), 'subject_invalid')
      expect(stub.count('member')).toBe(0)
    })
  }

  it('denies an empty userid with no online check', async () => {
    const { stub, adapter } = setup(loginSpec({ userinfo: ok(userinfoPayload({ userid: '' })) }))
    expect((await exchange(adapter)).ok).toBe(false)
    expect(stub.count('member')).toBe(0)
  })

  it('assumes: normalises with the member-id rule', () => {
    expect(normalizeWeComSubjectKey('Zhang.San')).toBe('zhang.san')
    expect(() => normalizeWeComSubjectKey('corp/zhangsan')).toThrow(WeComInvalidInputError)
    expect(() => normalizeWeComSubjectKey('')).toThrow(WeComInvalidInputError)
  })

  it('rejects a userid the client would not send before any request', async () => {
    const stub = createWeComFetchStub({})
    const error = await getWeComMember(TOKEN_CONFIG, 'corp/zhangsan', { fetchFn: stub.fetchFn }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComInvalidInputError)
    expect((error as WeComInvalidInputError).field).toBe('userid')
    expect(stub.requests).toHaveLength(0)
  })
})

describe('WeCom identity adapter: online member check', () => {
  const denials: Array<[string, WeComStubResponder, string]> = [
    ['60111', errcodeReply(60111), 'subject_unknown'],
    ['46004', errcodeReply(46004), 'subject_unknown'],
    ['40003', errcodeReply(40003), 'subject_unknown'],
    ['60011', errcodeReply(60011), 'subject_out_of_scope'],
    ['50002', errcodeReply(50002), 'subject_out_of_scope'],
    ['60123', errcodeReply(60123), 'subject_out_of_scope'],
    ['status 2', ok(memberPayload('Zhang.San', 2)), 'subject_inactive'],
    ['status 4', ok(memberPayload('Zhang.San', 4)), 'subject_inactive'],
    ['status 5', ok(memberPayload('Zhang.San', 5)), 'subject_inactive'],
    ['status 0', ok(memberPayload('Zhang.San', 0)), 'subject_inactive'],
    ['status 3', ok(memberPayload('Zhang.San', 3)), 'subject_inactive'],
    ['a different echoed userid', ok(memberPayload('Someone.Else')), 'subject_unknown'],
    ['an unknown errcode', errcodeReply(99999), 'provider_error'],
    ['HTTP 403', httpStatus(403), 'provider_error'],
  ]
  const assumedDenials = new Set(['60011', '50002', '60123', 'a different echoed userid'])
  for (const [name, responder, reason] of denials) {
    it(`${assumes(assumedDenials.has(name))}denies with ${reason} on ${name} and returns no subject`, async () => {
      const { stub, adapter } = setup(loginSpec({ member: responder }))
      const result = await exchange(adapter)
      expectRejected(result, reason)
      expect(stub.count('userinfo')).toBe(1)
      expect(stub.count('member')).toBe(1)
      expect(JSON.stringify(result)).not.toContain('subject"')
    })
  }

  it('denies a config fault on the member check with its administrator reason', async () => {
    const { adapter } = setup(loginSpec({ member: errcodeReply(60020) }))
    expectRejected(await exchange(adapter), 'config_fault', 'trusted_ip')
  })

  it('assumes: passes status 1 when the echo differs only in case, keeping the provider case', async () => {
    const { adapter } = setup(loginSpec({ member: ok(memberPayload('zhang.SAN')) }))
    const result = await exchange(adapter)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.subject.providerUserId).toBe('Zhang.San')
  })

  const incomplete: Array<[string, WeComStubResponder]> = [
    ['a missing status', ok(memberPayload('Zhang.San', 1, { status: undefined }))],
    ['a string status', ok(memberPayload('Zhang.San', '1'))],
    ['a missing userid', ok({ errcode: 0, status: 1 })],
    ['no errcode', ok({ userid: 'Zhang.San', status: 1 })],
    ['a non-numeric errcode', ok({ errcode: 'ok', userid: 'Zhang.San', status: 1 })],
    ['an array body', ok([])],
    ['a body that is not JSON', rawBody('nope')],
  ]
  for (const [name, responder] of incomplete) {
    it(`is unavailable on ${name}`, async () => {
      const { adapter } = setup(loginSpec({ member: responder }))
      expectUnavailable(await exchange(adapter), 'incomplete_response')
    })
  }

  const transient: Array<[string, WeComStubResponder, string, number]> = [
    ['45033', errcodeReply(45033), 'busy', 3],
    ['errcode -1', errcodeReply(-1), 'busy', 3],
    ['HTTP 500', httpStatus(500), 'busy', 3],
    ['a timeout', failWith(abortError()), 'timeout', 3],
    ['a network failure', failWith(new Error('socket hang up')), 'transport', 3],
    ['45009', errcodeReply(45009), 'rate_limited', 1],
  ]
  for (const [name, responder, reason, calls] of transient) {
    it(`is unavailable after ${calls} attempt(s) on ${name}`, async () => {
      const { stub, adapter } = setup(loginSpec({ member: responder }))
      expectUnavailable(await exchange(adapter), reason)
      expect(stub.count('userinfo')).toBe(1)
      expect(stub.count('member')).toBe(calls)
    })
  }

  it('retries the member check with the bounded set and reports each retry', async () => {
    const reasons: string[] = []
    const { stub, adapter } = setup(loginSpec({ member: (call) => (call < 3 ? errcodeReply(45033) : ok(memberPayload())) }))
    const result = await observeWeComTransportRetries((event) => reasons.push(event.reason), () => exchange(adapter))
    expect(result.ok).toBe(true)
    expect(stub.count('member')).toBe(3)
    expect(reasons).toEqual(['flow_control_errcode_45033', 'flow_control_errcode_45033'])
  })

  it('refetches a stale token once for the member check without repeating the exchange', async () => {
    const { stub, adapter } = setup(loginSpec({ member: (call) => (call === 1 ? errcodeReply(42001) : ok(memberPayload())) }))
    expect((await exchange(adapter)).ok).toBe(true)
    expect(stub.count('gettoken')).toBe(2)
    expect(stub.count('userinfo')).toBe(1)
    expect(stub.count('member')).toBe(2)
  })

  it('never passes when the online check is not answered', async () => {
    for (const responder of [errcodeReply(60011), errcodeReply(60111), ok(memberPayload('Zhang.San', 2)), errcodeReply(45033), failWith(new Error('x'))]) {
      const { adapter } = setup(loginSpec({ member: responder }))
      expect((await exchange(adapter)).ok).toBe(false)
    }
  })

  it('returns only the userid and status of the member at the client', async () => {
    const stub = createWeComFetchStub({ member: ok(memberPayload('Zhang.San', 1, { extra: 'x' })) })
    const member = await getWeComMember(TOKEN_CONFIG, 'Zhang.San', { fetchFn: stub.fetchFn })
    expect(member).toEqual({ userid: 'Zhang.San', status: 1 })
  })
})

describe('WeCom identity adapter: stale token and single attempt', () => {
  function tokenTracking(spec: WeComStubSpec) {
    const userinfoTokens: string[] = []
    const stub = createWeComFetchStub({
      ...spec,
      token: (call) => ok({ errcode: 0, errmsg: 'ok', access_token: `fixture-access-token-${call}`, expires_in: 7200 }),
    })
    const fetchFn = ((input: unknown, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/cgi-bin/auth/getuserinfo') userinfoTokens.push(url.searchParams.get('access_token') ?? '')
      return stub.fetchFn(input as Parameters<typeof fetch>[0], init)
    }) as typeof fetch
    const adapter = createWeComIdentityAdapter({ redirectUri: REDIRECT, requestOptions: { fetchFn, ...seams(createClock()) } })
    return { stub, adapter, userinfoTokens }
  }

  for (const stale of [42001, 40014]) {
    it(`refetches the token once on ${stale} and exchanges again with the new token`, async () => {
      const { stub, adapter, userinfoTokens } = tokenTracking(loginSpec({
        userinfo: (call) => (call === 1 ? errcodeReply(stale) : ok(userinfoPayload())),
      }))
      expect((await exchange(adapter)).ok).toBe(true)
      expect(stub.count('gettoken')).toBe(2)
      expect(stub.count('userinfo')).toBe(2)
      expect(userinfoTokens).toEqual(['fixture-access-token-1', 'fixture-access-token-2'])
    })

    it(`stops after a second ${stale}`, async () => {
      const { stub, adapter } = tokenTracking(loginSpec({ userinfo: errcodeReply(stale) }))
      expectUnavailable(await exchange(adapter), 'token_unavailable')
      expect(stub.count('gettoken')).toBe(2)
      expect(stub.count('userinfo')).toBe(2)
    })
  }

  it('assumes: turns a consumed code after the refetch into a code rejection', async () => {
    const { stub, adapter } = tokenTracking(loginSpec({ userinfo: (call) => (call === 1 ? errcodeReply(42001) : errcodeReply(40029)) }))
    expectRejected(await exchange(adapter), 'code_invalid')
    expect(stub.count('userinfo')).toBe(2)
    expect(stub.count('member')).toBe(0)
  })

  const singleAttempt: Array<[string, WeComStubResponder]> = [
    ['45033', errcodeReply(45033)],
    ['errcode -1', errcodeReply(-1)],
    ['HTTP 500', httpStatus(500)],
    ['HTTP 502', httpStatus(502)],
    ['HTTP 408', httpStatus(408)],
    ['a timeout', failWith(abortError())],
    ['a network failure', failWith(new Error('socket hang up'))],
    ['45009', errcodeReply(45009)],
    ['40029', errcodeReply(40029)],
    ['60020', errcodeReply(60020)],
    ['50001', errcodeReply(50001)],
    ['48002', errcodeReply(48002)],
    ['an unknown errcode', errcodeReply(99999)],
    ['an incomplete body', ok({ errcode: 0 })],
  ]
  for (const [name, responder] of singleAttempt) {
    it(`calls getuserinfo exactly once on ${name}`, async () => {
      const { stub, adapter } = tokenTracking(loginSpec({ userinfo: responder }))
      expect((await exchange(adapter)).ok).toBe(false)
      expect(stub.count('userinfo')).toBe(1)
      expect(stub.count('gettoken')).toBe(1)
      expect(stub.count('member')).toBe(0)
    })
  }

  it('reports no retry for the exchange', async () => {
    const reasons: string[] = []
    const { adapter } = tokenTracking(loginSpec({ userinfo: errcodeReply(45033) }))
    await observeWeComTransportRetries((event) => reasons.push(event.reason), () => exchange(adapter))
    expect(reasons).toEqual([])
  })
})

describe('WeCom identity adapter: error mapping', () => {
  const exchangeOutcomes: Array<[string, WeComStubResponder, 'rejected' | 'unavailable', string, string?]> = [
    ['45009', errcodeReply(45009), 'unavailable', 'rate_limited'],
    ['45033', errcodeReply(45033), 'unavailable', 'busy'],
    ['errcode -1', errcodeReply(-1), 'unavailable', 'busy'],
    ['HTTP 500', httpStatus(500), 'unavailable', 'busy'],
    ['HTTP 429', httpStatus(429), 'unavailable', 'rate_limited'],
    ['HTTP 408', httpStatus(408), 'unavailable', 'busy'],
    ['a timeout', failWith(abortError()), 'unavailable', 'timeout'],
    ['a network failure', failWith(new Error('socket hang up')), 'unavailable', 'transport'],
    ['40013', errcodeReply(40013), 'rejected', 'config_fault', 'invalid_corp'],
    ['40056', errcodeReply(40056), 'rejected', 'config_fault', 'invalid_agent'],
    ['41001', errcodeReply(41001), 'rejected', 'config_fault', 'config_fault'],
    ['301002', errcodeReply(301002), 'rejected', 'config_fault', 'invalid_agent'],
    ['60020', errcodeReply(60020), 'rejected', 'config_fault', 'trusted_ip'],
    ['50001', errcodeReply(50001), 'rejected', 'config_fault', 'redirect_domain'],
    ['48001', errcodeReply(48001), 'rejected', 'permission_fault'],
    ['48002', errcodeReply(48002), 'rejected', 'permission_fault'],
    ['40029', errcodeReply(40029), 'rejected', 'code_invalid'],
    ['60011', errcodeReply(60011), 'rejected', 'subject_out_of_scope'],
    ['60111', errcodeReply(60111), 'rejected', 'subject_invalid'],
    ['an unknown errcode', errcodeReply(99999), 'rejected', 'provider_error'],
    ['HTTP 403', httpStatus(403), 'rejected', 'provider_error'],
  ]
  const assumedExchange = new Set(['HTTP 429', '60011'])
  for (const [name, responder, outcome, reason, adminReason] of exchangeOutcomes) {
    it(`${assumes(assumedExchange.has(name))}maps ${name} on getuserinfo to ${outcome} ${reason}`, async () => {
      const { adapter } = setup(loginSpec({ userinfo: responder }))
      const result = await exchange(adapter)
      if (outcome === 'rejected') expectRejected(result, reason, adminReason)
      else expectUnavailable(result, reason)
    })
  }

  const tokenOutcomes: Array<[string, WeComStubResponder, 'rejected' | 'unavailable', string, string?, number?]> = [
    ['HTTP 500', httpStatus(500), 'unavailable', 'token_unavailable', undefined, 3],
    ['a timeout', failWith(abortError()), 'unavailable', 'token_unavailable', undefined, 3],
    ['a network failure', failWith(new Error('socket hang up')), 'unavailable', 'token_unavailable', undefined, 3],
    ['45033', errcodeReply(45033), 'unavailable', 'token_unavailable', undefined, 3],
    ['45009', errcodeReply(45009), 'unavailable', 'token_unavailable', undefined, 1],
    ['HTTP 408', httpStatus(408), 'unavailable', 'token_unavailable', undefined, 1],
    ['HTTP 429', httpStatus(429), 'unavailable', 'token_unavailable', undefined, 1],
    ['HTTP 403', httpStatus(403), 'rejected', 'config_fault', 'config_fault', 1],
    ['HTTP 404', httpStatus(404), 'rejected', 'config_fault', 'config_fault', 1],
    ['a malformed token body', ok({ errcode: 0 }), 'unavailable', 'token_unavailable', undefined, 1],
    ['40013', errcodeReply(40013), 'rejected', 'config_fault', 'invalid_corp', 1],
    ['60020', errcodeReply(60020), 'rejected', 'config_fault', 'trusted_ip', 1],
    ['a refusal of the credentials (40001)', errcodeReply(40001), 'rejected', 'config_fault', 'config_fault', 1],
  ]
  for (const [name, responder, outcome, reason, adminReason, calls] of tokenOutcomes) {
    it(`maps ${name} on gettoken to ${outcome} ${reason} without exchanging the code`, async () => {
      const { stub, adapter } = setup(loginSpec({ token: responder }))
      const result = await exchange(adapter)
      if (outcome === 'rejected') expectRejected(result, reason, adminReason)
      else expectUnavailable(result, reason)
      expect(stub.count('gettoken')).toBe(calls)
      expect(stub.count('userinfo')).toBe(0)
    })
  }

  it('marks a failure by the stage it happened in', async () => {
    const tokenFailure = await exchangeWeComLoginCode(TOKEN_CONFIG, CODE, { fetchFn: createWeComFetchStub({ token: errcodeReply(40013) }).fetchFn, ...seams(createClock()) }).catch((e) => e)
    expect(isWeComTokenStageError(tokenFailure)).toBe(true)
    const requestFailure = await exchangeWeComLoginCode(TOKEN_CONFIG, CODE, { fetchFn: createWeComFetchStub({ userinfo: errcodeReply(40029) }).fetchFn, ...seams(createClock()) }).catch((e) => e)
    expect(isWeComTokenStageError(requestFailure)).toBe(false)
    expect(isWeComTokenStageError(new Error('x'))).toBe(false)
    expect(isWeComTokenStageError(undefined)).toBe(false)
  })

  it('rethrows a programmer-input fault instead of turning it into a result', async () => {
    const { adapter } = setup(loginSpec())
    await expect(adapter.exchangeCode({ connection: { ...CONNECTION, corpId: 'bad corp' }, credentials: CREDENTIALS, code: CODE })).rejects.toBeInstanceOf(WeComInvalidInputError)
    await expect(adapter.exchangeCode({ connection: { ...CONNECTION, wecomAgentId: '0' }, credentials: CREDENTIALS, code: CODE })).rejects.toBeInstanceOf(WeComInvalidInputError)
  })

  it('denies a connection without a secret as a configuration fault, before any request', async () => {
    for (const corpSecret of ['', undefined as unknown as string]) {
      const { stub, adapter } = setup(loginSpec())
      expectRejected(await adapter.exchangeCode({ connection: CONNECTION, credentials: { corpSecret }, code: CODE }), 'config_fault', 'config_fault')
      expect(stub.requests).toHaveLength(0)
    }
  })
})

describe('WeCom identity adapter: nothing leaves through errors, results or logs', () => {
  const scenarios: Array<[string, WeComStubSpec]> = [
    ['a member', loginSpec()],
    ['a non-member', { userinfo: ok(nonMemberPayload({ user_doc_ticket: 'user-doc-ticket-canary' })) }],
    ['both identifiers', loginSpec({ userinfo: ok(userinfoPayload({ openid: 'fixture-openid-canary' })) })],
    ['an invalid userid', loginSpec({ userinfo: ok(userinfoPayload({}, 'corp/zhangsan')) })],
    ['a stale token that stays stale', loginSpec({ userinfo: errcodeReply(42001) })],
    ['a stale token that recovers', loginSpec({ userinfo: (call) => (call === 1 ? errcodeReply(40014) : ok(userinfoPayload())) })],
    ['an invalid code', loginSpec({ userinfo: errcodeReply(40029) })],
    ['a config fault', loginSpec({ userinfo: errcodeReply(60020) })],
    ['a permission fault', loginSpec({ userinfo: errcodeReply(48002) })],
    ['a rate limit', loginSpec({ userinfo: errcodeReply(45009) })],
    ['a busy provider', loginSpec({ userinfo: errcodeReply(45033) })],
    ['a server error', loginSpec({ userinfo: httpStatus(500, { errmsg: 'provider-text-that-must-not-leak' }) })],
    ['an unreadable body', loginSpec({ userinfo: rawBody('provider-text-that-must-not-leak') })],
    ['a timeout', loginSpec({ userinfo: failWith(abortError()) })],
    ['a network failure echoing its URL', loginSpec({ userinfo: failWith(new Error('failed https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=fixture-access-token-1&code=fixture-login-code-canary')) })],
    ['a failing token request', loginSpec({ token: errcodeReply(40013) })],
    ['a token request echoing the secret', loginSpec({ token: failWith(new Error(`failed corpsecret=${WECOM_FIXTURE_SECRET}`)) })],
    ['an inactive member', loginSpec({ member: ok(memberPayload('Zhang.San', 2)) })],
    ['a member out of scope', loginSpec({ member: errcodeReply(60011) })],
    ['a member check that stays busy', loginSpec({ member: errcodeReply(45033) })],
    ['a member check echoing its URL', loginSpec({ member: failWith(new Error('failed https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=fixture-access-token-1')) })],
  ]
  for (const [name, spec] of scenarios) {
    it(`keeps ${name} free of the code, token, secret, URL and provider text`, async () => {
      const spies = spyOnOutput()
      const { adapter } = setup(spec)
      const result = await exchange(adapter).catch((e) => e)
      const text = `${describeError(result)} ${JSON.stringify(result)} ${outputText(spies)}`
      for (const forbidden of FORBIDDEN) expect(text).not.toContain(forbidden)
    })
  }

  for (const [name, spec] of scenarios) {
    it(`keeps the client errors of ${name} free of the same values`, async () => {
      const spies = spyOnOutput()
      const stub = createWeComFetchStub(spec)
      const options = { fetchFn: stub.fetchFn, ...seams(createClock()) }
      const login = await exchangeWeComLoginCode(TOKEN_CONFIG, CODE, options).catch((e) => e)
      const member = await getWeComMember(TOKEN_CONFIG, 'Zhang.San', options).catch((e) => e)
      const text = `${describeError(login)} ${JSON.stringify(login)} ${describeError(member)} ${JSON.stringify(member)} ${outputText(spies)}`
      for (const forbidden of FORBIDDEN) expect(text).not.toContain(forbidden)
    })
  }
})

describe('WeCom identity adapter: request addressing', () => {
  const recordRaw = (raw: string[]) => (fetchFn: typeof fetch) => ((input: unknown, init?: RequestInit) => {
    raw.push(String(input))
    return fetchFn(input as Parameters<typeof fetch>[0], init)
  }) as typeof fetch

  it('percent-encodes the access token and the userid of both calls', async () => {
    const raw: string[] = []
    const { adapter } = setup(
      loginSpec({
        token: ok({ errcode: 0, errmsg: 'ok', access_token: 'tok&en=1#x+y', expires_in: 7200 }),
        userinfo: ok(userinfoPayload({}, 'a@b.c')),
        member: ok(memberPayload('a@b.c')),
      }),
      recordRaw(raw),
    )
    expect((await exchange(adapter)).ok).toBe(true)
    const login = raw.find((url) => url.includes('/auth/getuserinfo'))!
    const member = raw.find((url) => url.includes('/user/get'))!
    expect(login).toContain('access_token=tok%26en%3D1%23x%2By&code=')
    expect(member).toContain('access_token=tok%26en%3D1%23x%2By&userid=a%40b.c')
    expect(new URL(member).searchParams.get('access_token')).toBe('tok&en=1#x+y')
  })

  it('sends every request to the origin fixed at construction, whatever the connection or credentials carry', async () => {
    const hostile = { baseUrl: 'https://attacker.example.test', base_url: 'https://attacker.example.test' }
    const { stub, adapter } = setup(loginSpec(), undefined, 'https://gateway.example.test/')
    const result = await adapter.exchangeCode({
      connection: { ...CONNECTION, ...hostile },
      credentials: { ...CREDENTIALS, ...hostile },
      code: CODE,
    })
    expect(result.ok).toBe(true)
    expect(stub.requests.map((request) => request.route)).toEqual(['gettoken', 'userinfo', 'member'])
    expect(new Set(stub.requests.map((request) => request.origin))).toEqual(new Set(['https://gateway.example.test']))
  })

  it('uses the default host when no base address is configured, whatever the credentials carry', async () => {
    const { stub, adapter } = setup(loginSpec())
    await adapter.exchangeCode({
      connection: CONNECTION,
      credentials: { ...CREDENTIALS, baseUrl: 'https://attacker.example.test' } as typeof CREDENTIALS,
      code: CODE,
    })
    expect(stub.requests).toHaveLength(3)
    expect(new Set(stub.requests.map((request) => request.origin))).toEqual(new Set(['https://qyapi.weixin.qq.com']))
  })

  it('does not share an app token between two base addresses', async () => {
    const first = setup(loginSpec(), undefined, 'https://gateway-a.example.test')
    const second = setup(loginSpec(), undefined, 'https://gateway-b.example.test')
    expect((await exchange(first.adapter)).ok).toBe(true)
    expect((await exchange(second.adapter)).ok).toBe(true)
    expect(first.stub.count('gettoken')).toBe(1)
    expect(second.stub.count('gettoken')).toBe(1)
  })
})

describe('WeCom identity adapter: failure stage after a stale token', () => {
  const refetchFails: Array<[string, WeComStubSpec]> = [
    ['the exchange', {
      userinfo: errcodeReply(42001),
      token: (call) => (call === 1 ? ok({ errcode: 0, errmsg: 'ok', access_token: WECOM_FIXTURE_TOKEN, expires_in: 7200 }) : httpStatus(500)),
    }],
    ['the member check', {
      userinfo: ok(userinfoPayload()),
      member: errcodeReply(42001),
      token: (call) => (call === 1 ? ok({ errcode: 0, errmsg: 'ok', access_token: WECOM_FIXTURE_TOKEN, expires_in: 7200 }) : httpStatus(500)),
    }],
  ]
  for (const [name, spec] of refetchFails) {
    it(`reports a failing token refetch for ${name} as token_unavailable`, async () => {
      const { stub, adapter } = setup(spec)
      expectUnavailable(await exchange(adapter), 'token_unavailable')
      expect(stub.count('userinfo')).toBe(1)
      expect(stub.count('gettoken')).toBeGreaterThan(1)
    })
  }

  it('marks the error of a failing refetch as token-stage at the client', async () => {
    const stub = createWeComFetchStub({
      userinfo: errcodeReply(42001),
      token: (call) => (call === 1 ? ok({ errcode: 0, errmsg: 'ok', access_token: WECOM_FIXTURE_TOKEN, expires_in: 7200 }) : httpStatus(500)),
    })
    const error = await exchangeWeComLoginCode(TOKEN_CONFIG, CODE, { fetchFn: stub.fetchFn, ...seams(createClock()) }).catch((e) => e)
    expect(isWeComTokenStageError(error)).toBe(true)
  })
})

describe('WeCom identity adapter: zero real network and source boundaries', () => {
  const source = () => fs.readFileSync(ADAPTER_SOURCE, 'utf8')

  it('fails typed when no fetch is injected and the global fetch is a throwing stub', async () => {
    const adapter = createWeComIdentityAdapter({ redirectUri: REDIRECT, requestOptions: seams(createClock()) })
    expectUnavailable(await exchange(adapter), 'token_unavailable')
  })

  it('holds no HTTP call, provider host, environment read, database or route import', () => {
    const text = source()
    expect(text).not.toMatch(/\bfetch\b/)
    expect(text).not.toContain('qyapi.weixin.qq.com')
    expect(text).not.toContain('process.env')
    expect(importSpecifiers(text, ADAPTER_SOURCE)).toEqual(['../../integrations/wecom/client'])
  })

  it('writes neither a message nor a stack of an error and logs nothing', () => {
    const text = source()
    expect(text).not.toMatch(/\.(message|stack)\s*=[^=]/)
    expect(text).not.toMatch(/logger|console\./i)
  })

  it('keeps the login host as a source constant, distinct from the API host', () => {
    expect(source()).toContain("'https://login.work.weixin.qq.com/wwlogin/sso/login'")
  })

  it('builds the external key as the JSON array of corp id and lower-cased userid', () => {
    expect(buildWeComExternalKey(WECOM_FIXTURE_CORP_ID, 'Zhang.San')).toBe(JSON.stringify([WECOM_FIXTURE_CORP_ID, 'zhang.san']))
  })
})
