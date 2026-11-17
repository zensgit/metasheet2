import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import {
  __resetWeComAppAccessTokenCacheForTests,
  __weComTokenCacheKeyForTests,
  classifyWeComErrcode,
  fetchWeComAppAccessToken,
  getWeComAgent,
  invalidateWeComAppAccessTokenCache,
  isValidWeComAgentId,
  isValidWeComCorpId,
  isValidWeComDepartmentId,
  isValidWeComUserId,
  listWeComDepartmentMembers,
  listWeComDepartments,
  observeWeComTransportRetries,
  readWeComBaseUrlFromEnv,
  WECOM_READ_CALL_DEADLINE_MS,
  WeComBusinessError,
  WeComIncompleteResponseError,
  WeComInvalidInputError,
  WeComRequestError,
  WeComTimeoutError,
  WeComTransportError,
  type WeComRequestOptions,
} from '../../src/integrations/wecom/client'
import {
  WECOM_FIXTURE_AGENT_ID,
  WECOM_FIXTURE_CORP_ID,
  WECOM_FIXTURE_SECRET,
  WECOM_FIXTURE_TOKEN,
  abortError,
  agentPayload,
  bodyFailWith,
  createWeComFetchStub,
  departmentsPayload,
  dept,
  errcodeReply,
  failWith,
  httpStatus,
  ok,
  person,
  rawBody,
  stalledBody,
  usersPayload,
} from '../fixtures/directory/wecom/wecom-fixtures'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = { corpId: WECOM_FIXTURE_CORP_ID, corpSecret: WECOM_FIXTURE_SECRET }
const realFetch = globalThis.fetch

interface TestClock {
  now: () => number
  advance: (ms: number) => void
  sleeps: number[]
  sleep: (ms: number) => Promise<void>
}

function createClock(): TestClock {
  let current = 0
  const sleeps: number[] = []
  return {
    now: () => current,
    advance: (ms) => { current += ms },
    sleeps,
    sleep: async (ms) => { sleeps.push(ms); current += ms },
  }
}

function seams(clock: TestClock, random = () => 0): WeComRequestOptions {
  return { now: clock.now, sleep: clock.sleep, random }
}

function loggedText(spies: Array<ReturnType<typeof vi.spyOn>>): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
}

function spyOnLogger() {
  return [
    vi.spyOn(Logger.prototype, 'warn'),
    vi.spyOn(Logger.prototype, 'info'),
    vi.spyOn(Logger.prototype, 'error'),
    vi.spyOn(Logger.prototype, 'debug'),
  ]
}

beforeEach(() => {
  __resetWeComAppAccessTokenCacheForTests()
  globalThis.fetch = (() => { throw new Error('real network is not available in this test') }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('WeCom client read layer: closed-shape gates', () => {
  it('returns the whitelisted agent fields and drops extra fields', async () => {
    const stub = createWeComFetchStub({
      agent: ok(agentPayload({ parties: [3, 1, 3], users: [{ userid: 'Zed' }], tags: [9], extra: { user_doc_ticket: 'CANARY-TICKET', square_logo_url: 'x' } })),
    })
    const agent = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    expect(agent).toEqual({
      agentId: WECOM_FIXTURE_AGENT_ID,
      closed: false,
      redirectDomain: 'fixture.example.test',
      hasCustomizedPublishStatus: false,
      allowUserIds: ['Zed'],
      allowPartyIds: [3, 1, 3],
      allowTagIds: [9],
    })
    expect(JSON.stringify(agent)).not.toContain('CANARY-TICKET')
  })

  it('reports customized_publish_status by key presence, including a value of 0', async () => {
    const withZero = createWeComFetchStub({ agent: ok(agentPayload({ extra: { customized_publish_status: 0 } })) })
    expect((await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: withZero.fetchFn })).hasCustomizedPublishStatus).toBe(true)
    const without = createWeComFetchStub({ agent: ok(agentPayload()) })
    expect((await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: without.fetchFn })).hasCustomizedPublishStatus).toBe(false)
  })

  const agentFaults: Array<[string, (p: Record<string, unknown>) => void, string]> = [
    ['missing agentid', (p) => { delete p.agentid }, 'agent'],
    ['agentid as a string', (p) => { p.agentid = '1000002' }, 'agent'],
    ['missing close', (p) => { delete p.close }, 'agent'],
    ['redirect_domain of the wrong type', (p) => { p.redirect_domain = 5 }, 'agent'],
    ['missing allow_userinfos', (p) => { delete p.allow_userinfos }, 'agent_scope'],
    ['allow_userinfos.user is not an array', (p) => { p.allow_userinfos = { user: 'x' } }, 'agent_scope'],
    ['allow_userinfos.user entry without userid', (p) => { p.allow_userinfos = { user: [{}] } }, 'agent_scope'],
    ['missing allow_partys', (p) => { delete p.allow_partys }, 'agent_scope'],
    ['allow_partys.partyid is not an array', (p) => { p.allow_partys = { partyid: 1 } }, 'agent_scope'],
    ['allow_partys.partyid holds a string', (p) => { p.allow_partys = { partyid: ['1'] } }, 'agent_scope'],
    ['missing allow_tags', (p) => { delete p.allow_tags }, 'agent_scope'],
    ['allow_tags.tagid is not an array', (p) => { p.allow_tags = {} }, 'agent_scope'],
  ]
  for (const [name, mutate, location] of agentFaults) {
    it(`rejects an agent response with ${name}`, async () => {
      const payload = agentPayload()
      mutate(payload)
      const stub = createWeComFetchStub({ agent: ok(payload) })
      const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn }).catch((e) => e)
      expect(error).toBeInstanceOf(WeComIncompleteResponseError)
      expect(error.location).toBe(location)
      expect(stub.count('agent')).toBe(1)
    })
  }

  it('maps department entries and rejects shape faults with a location only', async () => {
    const stub = createWeComFetchStub({
      departments: ok(departmentsPayload([
        { id: 2, name: 'Sales', parentid: 1, order: 7, name_en: 'Sales EN', department_leader: ['lead1'], extra_field: 'dropped' },
        { id: 3, name: 'Support', parentid: 0 },
      ])),
    })
    const entries = await listWeComDepartments(CONFIG, { fetchFn: stub.fetchFn })
    expect(entries).toEqual([
      { id: 2, name: 'Sales', parentId: 1, order: 7, nameEn: 'Sales EN', departmentLeader: ['lead1'] },
      { id: 3, name: 'Support', parentId: 0 },
    ])

    const faults: Array<[unknown, string]> = [
      [{ errcode: 0 }, 'department_list'],
      [{ errcode: 0, department: 'x' }, 'department_list'],
      [{ errcode: 0, department: [null] }, 'department'],
      [{ errcode: 0, department: [{ name: 'a', parentid: 1 }] }, 'department'],
      [{ errcode: 0, department: [{ id: 0, name: 'a', parentid: 1 }] }, 'department'],
      [{ errcode: 0, department: [{ id: 2, name: 5, parentid: 1 }] }, 'department'],
      [{ errcode: 0, department: [{ id: 2, name: 'a', parentid: -1 }] }, 'department'],
      [{ errcode: 0, department: [{ id: 2, name: 'a', parentid: 1, order: 'x' }] }, 'department'],
      [{ errcode: 0, department: [{ id: 2, name: 'a', parentid: 1, department_leader: 'x' }] }, 'department'],
      [{ errcode: 0, department: [{ id: 12345678901, name: 'a', parentid: 1 }] }, 'department'],
      [{ errcode: 0, department: [{ id: 2, name: 'a', parentid: 12345678901 }] }, 'department'],
    ]
    for (const [body, location] of faults) {
      __resetWeComAppAccessTokenCacheForTests()
      const faulty = createWeComFetchStub({ departments: ok(body) })
      const error = await listWeComDepartments(CONFIG, { fetchFn: faulty.fetchFn }).catch((e) => e)
      expect(error).toBeInstanceOf(WeComIncompleteResponseError)
      expect(error.location).toBe(location)
    }
  })

  it('assumes: treats a missing userlist as incomplete and an empty userlist as empty', async () => {
    const missing = createWeComFetchStub({ users: ok({ errcode: 0, errmsg: 'ok' }) })
    const error = await listWeComDepartmentMembers(CONFIG, '2', { fetchFn: missing.fetchFn }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComIncompleteResponseError)
    expect(error.location).toBe('user_list')

    __resetWeComAppAccessTokenCacheForTests()
    const empty = createWeComFetchStub({ users: ok(usersPayload([])) })
    expect(await listWeComDepartmentMembers(CONFIG, '2', { fetchFn: empty.fetchFn })).toEqual([])

    __resetWeComAppAccessTokenCacheForTests()
    const wrongType = createWeComFetchStub({ users: ok(usersPayload({ not: 'an array' })) })
    const wrong = await listWeComDepartmentMembers(CONFIG, '2', { fetchFn: wrongType.fetchFn }).catch((e) => e)
    expect(wrong.location).toBe('user_list')
  })

  it('keeps only whitelisted member fields and tolerates extra ones', async () => {
    const stub = createWeComFetchStub({
      users: ok(usersPayload([
        person('Alice', {
          department: [2, 4], main_department: 4, position: 'Rep', avatar: 'https://img.example.test/a', mobile: ' 100 ', email: 'a@example.test',
          order: [1, 2], is_leader_in_dept: [0, 1], direct_leader: ['boss'],
          user_doc_ticket: 'CANARY-TICKET', address: 'CANARY-ADDRESS', qr_code: 'CANARY-QR', telephone: 'CANARY-TEL', external_position: 'x',
        }),
      ])),
    })
    const [member] = await listWeComDepartmentMembers(CONFIG, '2', { fetchFn: stub.fetchFn })
    expect(member).toEqual({
      userid: 'Alice', name: 'name-Alice', status: 1, department: [2, 4], mainDepartment: 4, position: 'Rep', avatar: 'https://img.example.test/a',
      mobile: ' 100 ', email: 'a@example.test', order: [1, 2], isLeaderInDept: [0, 1], directLeader: ['boss'],
    })
    expect(JSON.stringify(member)).not.toMatch(/CANARY/)
  })

  it('treats a null pass-through value as absent', async () => {
    const stub = createWeComFetchStub({ users: ok(usersPayload([person('a', { order: null, is_leader_in_dept: null, direct_leader: null })])) })
    const [member] = await listWeComDepartmentMembers(CONFIG, '2', { fetchFn: stub.fetchFn })
    expect(member).toEqual({ userid: 'a', name: 'name-a', status: 1 })
  })

  it('assumes: returns userids that violate the id rules unchanged for the caller to isolate', async () => {
    const stub = createWeComFetchStub({ users: ok(usersPayload([person('A/b'), person(''), person('x'.repeat(70))])) })
    const members = await listWeComDepartmentMembers(CONFIG, '2', { fetchFn: stub.fetchFn })
    expect(members.map((m) => m.userid)).toEqual(['A/b', '', 'x'.repeat(70)])
  })

  const memberFaults: Array<[string, unknown]> = [
    ['entry that is not an object', 'x'],
    ['entry without userid', { name: 'n' }],
    ['numeric userid', { userid: 5 }],
    ['department that is not an array', { userid: 'a', department: 2 }],
    ['department holding a string', { userid: 'a', department: ['2'] }],
    ['status that is not an integer', { userid: 'a', status: '1' }],
    ['mobile that is not a string', { userid: 'a', mobile: 5 }],
    ['main_department that is not an integer', { userid: 'a', main_department: 'x' }],
    ['order that is a string', { userid: 'a', order: '1,2' }],
    ['order holding a boolean', { userid: 'a', order: [true] }],
    ['is_leader_in_dept that is a string', { userid: 'a', is_leader_in_dept: '1,0' }],
    ['is_leader_in_dept holding booleans', { userid: 'a', is_leader_in_dept: [true, false] }],
    ['direct_leader holding a number', { userid: 'a', direct_leader: [5] }],
    ['direct_leader that is an object', { userid: 'a', direct_leader: { id: 'x' } }],
  ]
  for (const [name, entry] of memberFaults) {
    it(`rejects a member list with a ${name}`, async () => {
      const stub = createWeComFetchStub({ users: ok(usersPayload([entry])) })
      const error = await listWeComDepartmentMembers(CONFIG, '2', { fetchFn: stub.fetchFn }).catch((e) => e)
      expect(error).toBeInstanceOf(WeComIncompleteResponseError)
      expect(error.location).toBe('user')
    })
  }

  it('never puts response content into a shape error', async () => {
    const stub = createWeComFetchStub({ users: ok(usersPayload([{ userid: 'a', mobile: 'CANARY-VALUE-1', department: 'CANARY-VALUE-2' }])) })
    const error = await listWeComDepartmentMembers(CONFIG, '2', { fetchFn: stub.fetchFn }).catch((e) => e)
    expect(`${error.message} ${JSON.stringify(error)}`).not.toMatch(/CANARY/)
    expect(Object.keys(error).filter((key) => key !== 'name')).toEqual(['location'])
  })

  it('treats a non-object or non-JSON 2xx body as incomplete', async () => {
    for (const reply of [rawBody('<html>not json</html>'), ok([1, 2]), ok(null)]) {
      __resetWeComAppAccessTokenCacheForTests()
      const stub = createWeComFetchStub({ departments: reply })
      const error = await listWeComDepartments(CONFIG, { fetchFn: stub.fetchFn }).catch((e) => e)
      expect(error).toBeInstanceOf(WeComIncompleteResponseError)
      expect(error.location).toBe('response')
    }
  })

  it('treats a token response without access_token as incomplete', async () => {
    const stub = createWeComFetchStub({ token: ok({ errcode: 0, errmsg: 'ok' }) })
    const error = await listWeComDepartments(CONFIG, { fetchFn: stub.fetchFn }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComIncompleteResponseError)
    expect(error.location).toBe('token')
  })
})

describe('WeCom client read layer: input validation before any request', () => {
  it('validates corpId (visible ASCII, no whitespace, at most 64)', () => {
    expect(isValidWeComCorpId('c'.repeat(64))).toBe(true)
    expect(isValidWeComCorpId('c'.repeat(65))).toBe(false)
    expect(isValidWeComCorpId('')).toBe(false)
    expect(isValidWeComCorpId('a b')).toBe(false)
    expect(isValidWeComCorpId('a\tb')).toBe(false)
    expect(isValidWeComCorpId('企业')).toBe(false)
    expect(isValidWeComCorpId(undefined)).toBe(false)
  })

  it('validates wecomAgentId at the 14, 15 and 16 digit boundaries', () => {
    expect(isValidWeComAgentId('1'.repeat(14))).toBe(true)
    expect(isValidWeComAgentId('1'.repeat(15))).toBe(true)
    expect(isValidWeComAgentId('1'.repeat(16))).toBe(false)
    for (const bad of ['0', '01', '', '1a', '-1', '1.5', ' 1']) expect(isValidWeComAgentId(bad)).toBe(false)
    expect(isValidWeComAgentId(1000002)).toBe(false)
  })

  it('assumes: validates userid with the creation rule', () => {
    for (const good of ['a', 'A1', 'zhang.san', 'a_b-c@d', `a${'b'.repeat(63)}`]) expect(isValidWeComUserId(good)).toBe(true)
    for (const bad of ['', '_a', '-a', '.a', 'a/b', 'Corp/user', 'a b', '中文', `a${'b'.repeat(64)}`]) expect(isValidWeComUserId(bad)).toBe(false)
  })

  it('validates departmentId as 1 to 10 digits', () => {
    for (const good of ['0', '1', '1234567890']) expect(isValidWeComDepartmentId(good)).toBe(true)
    for (const bad of ['', '12345678901', '1.5', '-1', '1 ', 'a', '1&x=2']) expect(isValidWeComDepartmentId(bad)).toBe(false)
  })

  it('rejects invalid inputs with zero requests', async () => {
    const stub = createWeComFetchStub({ agent: ok(agentPayload()), departments: ok(departmentsPayload([])), users: ok(usersPayload([])) })
    const options = { fetchFn: stub.fetchFn }
    const cases: Array<[string, () => Promise<any>, string]> = [
      ['corpId', () => getWeComAgent({ ...CONFIG, corpId: 'bad id' }, WECOM_FIXTURE_AGENT_ID, options), 'corpId'],
      ['empty corpSecret', () => listWeComDepartments({ ...CONFIG, corpSecret: '' }, options), 'corpSecret'],
      ['agent id', () => getWeComAgent(CONFIG, '0123', options), 'wecomAgentId'],
      ['department id', () => listWeComDepartmentMembers(CONFIG, '1&access_token=x', options), 'departmentId'],
    ]
    for (const [, run, field] of cases) {
      const error = await run().catch((e) => e)
      expect(error).toBeInstanceOf(WeComInvalidInputError)
      expect(error.field).toBe(field)
    }
    expect(stub.requests).toHaveLength(0)
  })

  it('percent-encodes every value placed in a query string', async () => {
    const urls: string[] = []
    const stub = createWeComFetchStub({ agent: ok(agentPayload()), token: ok({ errcode: 0, access_token: 'tok&en=1', expires_in: 7200 }) })
    const fetchFn = ((input: unknown, init?: RequestInit) => { urls.push(String(input)); return stub.fetchFn(input as string, init) }) as typeof fetch
    await getWeComAgent({ corpId: 'corp&x=1#y', corpSecret: 's &=?' }, WECOM_FIXTURE_AGENT_ID, { fetchFn })
    expect(urls[0]).toContain('corpid=corp%26x%3D1%23y&corpsecret=s%20%26%3D%3F')
    expect(urls[1]).toContain('access_token=tok%26en%3D1&agentid=1000002')
  })
})

describe('WeCom client read layer: token cache', () => {
  const tokenCalls = (stub: ReturnType<typeof createWeComFetchStub>) => stub.count('gettoken')

  it('shares a token for the same corp, base URL and secret', async () => {
    const stub = createWeComFetchStub({ agent: ok(agentPayload()) })
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    expect(tokenCalls(stub)).toBe(1)
  })

  it('does not share a token between secrets of the same corp and base URL', async () => {
    const stub = createWeComFetchStub({ agent: ok(agentPayload()) })
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    await getWeComAgent({ ...CONFIG, corpSecret: 'another-secret' }, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    expect(tokenCalls(stub)).toBe(2)
  })

  it('does not share a token between base URLs', async () => {
    const stub = createWeComFetchStub({ agent: ok(agentPayload()) })
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    await getWeComAgent({ ...CONFIG, baseUrl: 'https://proxy.example.test' }, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    expect(tokenCalls(stub)).toBe(2)
  })

  it('shares one cache with the single-attempt token call', async () => {
    const stub = createWeComFetchStub({ agent: ok(agentPayload()) })
    expect(await fetchWeComAppAccessToken(CONFIG, { fetchFn: stub.fetchFn })).toBe(WECOM_FIXTURE_TOKEN)
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    expect(tokenCalls(stub)).toBe(1)
  })

  it('does not cache a failed token fetch', async () => {
    const stub = createWeComFetchStub({
      agent: ok(agentPayload()),
      token: (call) => (call === 1 ? errcodeReply(40013) : ok({ errcode: 0, access_token: 'tok-2', expires_in: 7200 })),
    })
    await expect(getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })).rejects.toBeInstanceOf(WeComBusinessError)
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    expect(tokenCalls(stub)).toBe(2)
  })

  it('coalesces concurrent token fetches under one key', async () => {
    const stub = createWeComFetchStub({ agent: ok(agentPayload()), departments: ok(departmentsPayload([dept(1, 0)])) })
    await Promise.all([
      getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn }),
      listWeComDepartments(CONFIG, { fetchFn: stub.fetchFn }),
    ])
    expect(tokenCalls(stub)).toBe(1)
  })

  it('shares one request between the single-attempt call and a read call running together', async () => {
    const stub = createWeComFetchStub({ agent: ok(agentPayload()) })
    const options = { fetchFn: stub.fetchFn }
    await Promise.all([
      fetchWeComAppAccessToken(CONFIG, options),
      getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, options),
    ])
    expect(tokenCalls(stub)).toBe(1)
    __resetWeComAppAccessTokenCacheForTests()
    const reverse = createWeComFetchStub({ agent: ok(agentPayload()) })
    await Promise.all([
      getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: reverse.fetchFn }),
      fetchWeComAppAccessToken(CONFIG, { fetchFn: reverse.fetchFn }),
    ])
    expect(tokenCalls(reverse)).toBe(1)
  })

  it('keeps each layer its own error shape when a token request is shared', async () => {
    const stub = createWeComFetchStub({ token: errcodeReply(40013, 'provider-token-text') })
    const [single, read] = await Promise.all([
      fetchWeComAppAccessToken(CONFIG, { fetchFn: stub.fetchFn }).catch((e) => e),
      listWeComDepartments(CONFIG, { fetchFn: stub.fetchFn }).catch((e) => e),
    ])
    expect(single.message).toBe('provider-token-text')
    expect(read).toBeInstanceOf(WeComBusinessError)
    expect(read.message).not.toContain('provider-token-text')
    expect(read.responseBody).toBeNull()
  })

  it('separates secrets of the same length that differ only in the last character', async () => {
    const first = { ...CONFIG, corpSecret: 'same-length-secret-0' }
    const second = { ...CONFIG, corpSecret: 'same-length-secret-1' }
    const secretsOf = (stub: ReturnType<typeof createWeComFetchStub>) => stub.requests.filter((r) => r.route === 'gettoken').length
    const sequential = createWeComFetchStub({ agent: ok(agentPayload()) })
    await getWeComAgent(first, WECOM_FIXTURE_AGENT_ID, { fetchFn: sequential.fetchFn })
    await getWeComAgent(second, WECOM_FIXTURE_AGENT_ID, { fetchFn: sequential.fetchFn })
    expect(secretsOf(sequential)).toBe(2)

    __resetWeComAppAccessTokenCacheForTests()
    const concurrent = createWeComFetchStub({ agent: ok(agentPayload()) })
    await Promise.all([
      getWeComAgent(first, WECOM_FIXTURE_AGENT_ID, { fetchFn: concurrent.fetchFn }),
      getWeComAgent(second, WECOM_FIXTURE_AGENT_ID, { fetchFn: concurrent.fetchFn }),
    ])
    expect(secretsOf(concurrent)).toBe(2)
  })

  it('builds a cache key from corp, base URL and a 16-hex fingerprint, never the secret', async () => {
    const key = __weComTokenCacheKeyForTests({ ...CONFIG, baseUrl: 'https://proxy.example.test/' })
    const fingerprint = createHash('sha256').update(WECOM_FIXTURE_SECRET).digest('hex').slice(0, 16)
    expect(key).toBe(`${WECOM_FIXTURE_CORP_ID}|https://proxy.example.test|${fingerprint}`)
    expect(key).not.toContain(WECOM_FIXTURE_SECRET)
    expect(key).not.toContain(WECOM_FIXTURE_SECRET.slice(0, 8))

    const keysSeen: string[] = []
    const originals = { set: Map.prototype.set, get: Map.prototype.get, delete: Map.prototype.delete }
    for (const method of ['set', 'get', 'delete'] as const) {
      vi.spyOn(Map.prototype, method).mockImplementation(function (this: Map<unknown, unknown>, ...args: unknown[]) {
        if (typeof args[0] === 'string') keysSeen.push(args[0])
        return (originals[method] as (...a: unknown[]) => unknown).apply(this, args)
      } as never)
    }
    const stub = createWeComFetchStub({ agent: ok(agentPayload()) })
    try {
      await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    } finally {
      vi.restoreAllMocks()
    }
    const cacheKeys = keysSeen.filter((seen) => seen.startsWith(`${WECOM_FIXTURE_CORP_ID}|`))
    expect(cacheKeys.length).toBeGreaterThan(0)
    for (const seen of cacheKeys) expect(seen).not.toContain(WECOM_FIXTURE_SECRET)
    expect(cacheKeys.every((seen) => seen.endsWith(`|${fingerprint}`))).toBe(true)
  })

  it('invalidates by the same key (corp, base URL and secret)', async () => {
    const stub = createWeComFetchStub({ agent: ok(agentPayload()) })
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    invalidateWeComAppAccessTokenCache({ ...CONFIG, corpSecret: 'a-different-secret' })
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    expect(tokenCalls(stub)).toBe(1)
    invalidateWeComAppAccessTokenCache(CONFIG)
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    expect(tokenCalls(stub)).toBe(2)
  })

  it('never exposes the secret fingerprint in logs or errors', async () => {
    const fingerprint = createHash('sha256').update(WECOM_FIXTURE_SECRET).digest('hex').slice(0, 16)
    const spies = spyOnLogger()
    const stub = createWeComFetchStub({ agent: errcodeReply(40013) })
    const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn }).catch((e) => e)
    expect(`${error.message} ${JSON.stringify(error)} ${loggedText(spies)}`).not.toContain(fingerprint)
  })
})

describe('WeCom client read layer: retry set', () => {
  const reasonsOf = async (run: (options: WeComRequestOptions) => Promise<unknown>, options: WeComRequestOptions) => {
    const reasons: string[] = []
    const result = await observeWeComTransportRetries((event) => reasons.push(event.reason), () => run(options).catch((e) => e))
    return { reasons, result }
  }

  it('retries 45033 and -1 up to three attempts including the first', async () => {
    for (const code of [45033, -1]) {
      __resetWeComAppAccessTokenCacheForTests()
      const clock = createClock()
      const stub = createWeComFetchStub({ agent: (call) => (call < 3 ? errcodeReply(code) : ok(agentPayload())) })
      const { reasons, result } = await reasonsOf(
        (options) => getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, options),
        { fetchFn: stub.fetchFn, ...seams(clock) },
      )
      expect((result as { agentId: string }).agentId).toBe(WECOM_FIXTURE_AGENT_ID)
      expect(stub.count('agent')).toBe(3)
      expect(reasons).toEqual([`flow_control_errcode_${code}`, `flow_control_errcode_${code}`])
      expect(clock.sleeps).toHaveLength(2)
    }
  })

  it('stops after three attempts and throws the last typed error', async () => {
    const stub = createWeComFetchStub({ agent: errcodeReply(45033) })
    const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(createClock()) }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComBusinessError)
    expect(error.errcode).toBe(45033)
    expect(stub.count('agent')).toBe(3)
  })

  it('retries HTTP 5xx, network errors and timeouts', async () => {
    const cases: Array<[string, () => ReturnType<typeof httpStatus>, string]> = [
      ['http 5xx', () => httpStatus(503), 'http_5xx'],
      ['network error', () => failWith(new Error('socket hang up')), 'network_error'],
      ['timeout', () => failWith(abortError()), 'network_error'],
    ]
    for (const [, makeFailure, reason] of cases) {
      __resetWeComAppAccessTokenCacheForTests()
      const stub = createWeComFetchStub({ departments: (call) => (call === 1 ? makeFailure() : ok(departmentsPayload([dept(1, 0)]))) })
      const { reasons, result } = await reasonsOf(
        (options) => listWeComDepartments(CONFIG, options),
        { fetchFn: stub.fetchFn, ...seams(createClock()) },
      )
      expect(result).toHaveLength(1)
      expect(reasons).toEqual([reason])
      expect(stub.count('departments')).toBe(2)
    }
  })

  it('never retries 45009, at the request or at the token stage', async () => {
    const clock = createClock()
    const stub = createWeComFetchStub({ agent: errcodeReply(45009) })
    const { reasons, result } = await reasonsOf((options) => getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, options), { fetchFn: stub.fetchFn, ...seams(clock) })
    expect((result as WeComBusinessError).errcode).toBe(45009)
    expect(stub.count('agent')).toBe(1)
    expect(reasons).toEqual([])
    expect(clock.sleeps).toEqual([])

    __resetWeComAppAccessTokenCacheForTests()
    const atToken = createWeComFetchStub({ token: errcodeReply(45009), agent: ok(agentPayload()) })
    const tokenError = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: atToken.fetchFn, ...seams(createClock()) }).catch((e) => e)
    expect(tokenError.errcode).toBe(45009)
    expect(atToken.count('gettoken')).toBe(1)
    expect(atToken.count('agent')).toBe(0)
  })

  it('does not retry other business codes or non-5xx statuses', async () => {
    const replies = [errcodeReply(40013), errcodeReply(48002), errcodeReply(60020), httpStatus(400), httpStatus(404), httpStatus(429)]
    for (const reply of replies) {
      __resetWeComAppAccessTokenCacheForTests()
      const stub = createWeComFetchStub({ agent: reply })
      const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(createClock()) }).catch((e) => e)
      expect(error).toBeInstanceOf(error.errcode === undefined ? WeComRequestError : WeComBusinessError)
      expect(stub.count('agent')).toBe(1)
    }
  })

  it('invalidates and refetches the token exactly once on 42001 and on 40014', async () => {
    for (const code of [42001, 40014]) {
      __resetWeComAppAccessTokenCacheForTests()
      const stub = createWeComFetchStub({
        agent: (call) => (call === 1 ? errcodeReply(code) : ok(agentPayload())),
        token: (call) => ok({ errcode: 0, access_token: `tok-${call}`, expires_in: 7200 }),
      })
      const agent = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(createClock()) })
      expect(agent.agentId).toBe(WECOM_FIXTURE_AGENT_ID)
      expect(stub.count('gettoken')).toBe(2)
      expect(stub.count('agent')).toBe(2)
    }
  })

  it('refetches only once when the refreshed token is stale too', async () => {
    const stub = createWeComFetchStub({ agent: errcodeReply(42001) })
    const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(createClock()) }).catch((e) => e)
    expect(error.errcode).toBe(42001)
    expect(stub.count('gettoken')).toBe(2)
    expect(stub.count('agent')).toBe(2)
  })

  it('retries only inside the read layer: the single-attempt token call makes one request', async () => {
    const stub = createWeComFetchStub({ token: errcodeReply(45033) })
    await expect(fetchWeComAppAccessToken(CONFIG, { fetchFn: stub.fetchFn })).rejects.toBeInstanceOf(WeComBusinessError)
    expect(stub.count('gettoken')).toBe(1)
  })

  it('retries the token fetch of a read call within the same budget', async () => {
    const stub = createWeComFetchStub({
      agent: ok(agentPayload()),
      token: (call) => (call < 3 ? errcodeReply(-1) : ok({ errcode: 0, access_token: 't', expires_in: 7200 })),
    })
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(createClock()) })
    expect(stub.count('gettoken')).toBe(3)
  })

  it('draws full-jitter delays from the injected random source with a doubling ceiling', async () => {
    const clock = createClock()
    const stub = createWeComFetchStub({ agent: errcodeReply(45033) })
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(clock, () => 0.999) }).catch(() => undefined)
    expect(clock.sleeps).toEqual([249, 499])
  })

  it('swallows an observer that throws and keeps retrying', async () => {
    const stub = createWeComFetchStub({ agent: (call) => (call === 1 ? errcodeReply(-1) : ok(agentPayload())) })
    const agent = await observeWeComTransportRetries(
      () => { throw new Error('observer fault') },
      () => getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(createClock()) }),
    )
    expect(agent.agentId).toBe(WECOM_FIXTURE_AGENT_ID)
    expect(stub.count('agent')).toBe(2)
  })
})

describe('WeCom client read layer: total time limit', () => {
  it('uses a 12 second budget per client call', () => {
    expect(WECOM_READ_CALL_DEADLINE_MS).toBe(12_000)
  })

  it('bounds each attempt by min(single timeout, remaining) and rejects typed on exhaustion', async () => {
    const clock = createClock()
    const spies = spyOnLogger()
    const inner = createWeComFetchStub({ agent: failWith(abortError()) })
    let agentAttempts = 0
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/agent/get')) {
        agentAttempts += 1
        clock.advance(agentAttempts === 1 ? 10_000 : 2_000)
      }
      return inner.fetchFn(input as string, init)
    }) as typeof fetch
    const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn, timeoutMs: 10_000, ...seams(clock) }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComTimeoutError)
    expect(error.timeoutMs).toBe(WECOM_READ_CALL_DEADLINE_MS)
    const lines = JSON.stringify(spies[0].mock.calls)
    expect(lines).toContain('timed out after 10000ms')
    expect(lines).toContain('timed out after 2000ms')
  })

  it('shares one budget across the token fetch, the request and the refetch', async () => {
    const clock = createClock()
    const stub = createWeComFetchStub({
      agent: errcodeReply(42001),
      token: ok({ errcode: 0, access_token: 't', expires_in: 7200 }),
      onRequest: (request) => { clock.advance(request.route === 'gettoken' ? 6_000 : 4_000) },
    })
    const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(clock) }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComTimeoutError)
    expect(error.timeoutMs).toBe(WECOM_READ_CALL_DEADLINE_MS)
    expect(stub.count('agent')).toBe(1)
    expect(stub.count('gettoken')).toBe(2)
  })

  it('gives up instead of sleeping past the budget', async () => {
    const clock = createClock()
    const stub = createWeComFetchStub({
      agent: errcodeReply(45033),
      onRequest: (request) => { if (request.route === 'agent') clock.advance(11_900) },
    })
    const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(clock, () => 0.999) }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComTimeoutError)
    expect(error.timeoutMs).toBe(WECOM_READ_CALL_DEADLINE_MS)
    expect(clock.sleeps).toEqual([])
  })
})

describe('WeCom client read layer: redaction', () => {
  const LEAK = 'LEAK-PROVIDER-TEXT-203.0.113.9'

  it('keeps provider text out of business and request errors', async () => {
    const spies = spyOnLogger()
    const business = createWeComFetchStub({ agent: errcodeReply(48002, LEAK) })
    const businessError = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: business.fetchFn }).catch((e) => e)
    expect(businessError).toBeInstanceOf(WeComBusinessError)
    expect(businessError.errcode).toBe(48002)
    expect(businessError.responseBody).toBeNull()

    __resetWeComAppAccessTokenCacheForTests()
    const status = createWeComFetchStub({ agent: httpStatus(403, { errmsg: LEAK }) })
    const statusError = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: status.fetchFn }).catch((e) => e)
    expect(statusError).toBeInstanceOf(WeComRequestError)
    expect(statusError.statusCode).toBe(403)
    expect(statusError.responseBody).toBeNull()

    for (const error of [businessError, statusError]) expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(LEAK)
    expect(loggedText(spies)).not.toContain(LEAK)
  })

  it('wraps a network failure in a fixed-message typed error', async () => {
    const spies = spyOnLogger()
    const stub = createWeComFetchStub({ agent: failWith(new Error(`connect ECONNREFUSED ${LEAK}`)) })
    const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(createClock()) }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComTransportError)
    expect(`${error.message} ${JSON.stringify(error)} ${loggedText(spies)}`).not.toContain(LEAK)
    expect(stub.count('agent')).toBe(3)
  })

  it('keeps URL, token, secret and provider text out of every logged line', async () => {
    const spies = spyOnLogger()
    const stub = createWeComFetchStub({
      agent: (call) => (call === 1 ? errcodeReply(45033, LEAK) : (call === 2 ? httpStatus(502, { errmsg: LEAK }) : ok(agentPayload()))),
    })
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(createClock()) })
    const text = loggedText(spies)
    for (const forbidden of [LEAK, WECOM_FIXTURE_TOKEN, WECOM_FIXTURE_SECRET, 'access_token', 'corpsecret', 'http://', 'https://', 'qyapi']) {
      expect(text).not.toContain(forbidden)
    }
    expect(text).toContain('errcode 45033')
  })

  it('masks credentials in recorded request snapshots', async () => {
    const stub = createWeComFetchStub({ agent: ok(agentPayload()) })
    await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    const snapshot = JSON.stringify(stub.requests)
    expect(snapshot).not.toContain(WECOM_FIXTURE_TOKEN)
    expect(snapshot).not.toContain(WECOM_FIXTURE_SECRET)
    expect(stub.requests[0].query.corpsecret).toBe('***')
    expect(stub.requests[1].query.access_token).toBe('***')
  })
})

describe('WeCom client read layer: defaults and mapping', () => {
  it('keeps the single-attempt path unchanged for callers that do not opt in', async () => {
    const business = createWeComFetchStub({ token: errcodeReply(40013, 'invalid secret text') })
    const businessError = await fetchWeComAppAccessToken(CONFIG, { fetchFn: business.fetchFn }).catch((e) => e)
    expect(businessError).toBeInstanceOf(WeComBusinessError)
    expect(businessError.message).toBe('invalid secret text')

    __resetWeComAppAccessTokenCacheForTests()
    const missingToken = createWeComFetchStub({ token: ok({ errcode: 0, errmsg: 'no token here' }) })
    const plain = await fetchWeComAppAccessToken(CONFIG, { fetchFn: missingToken.fetchFn }).catch((e) => e)
    expect(plain).toBeInstanceOf(Error)
    expect(plain).not.toBeInstanceOf(WeComIncompleteResponseError)
    expect(plain.message).toBe('no token here')

    __resetWeComAppAccessTokenCacheForTests()
    const raw = new Error('raw network failure')
    const network = createWeComFetchStub({ token: failWith(raw) })
    await expect(fetchWeComAppAccessToken(CONFIG, { fetchFn: network.fetchFn })).rejects.toBe(raw)
  })

  it('reads the base URL from the deployment environment at call time', () => {
    expect(readWeComBaseUrlFromEnv({})).toBeUndefined()
    expect(readWeComBaseUrlFromEnv({ WECOM_BASE_URL: '  ' })).toBeUndefined()
    expect(readWeComBaseUrlFromEnv({ WECOM_BASE_URL: ' https://proxy.example.test ' })).toBe('https://proxy.example.test')
  })

  it('maps error codes to categories through one function', () => {
    const table: Array<[number, string]> = [
      [42001, 'token_stale'], [40014, 'token_stale'], [45009, 'rate_limited'], [45033, 'busy'], [-1, 'busy'],
      [40013, 'config_fault'], [40056, 'config_fault'], [41001, 'config_fault'], [301002, 'config_fault'], [60020, 'config_fault'], [50001, 'config_fault'],
      [48001, 'permission_fault'], [48002, 'permission_fault'], [50002, 'scope_fault'], [60011, 'scope_fault'], [60123, 'scope_fault'],
      [40003, 'subject_invalid'], [60111, 'subject_invalid'], [46004, 'subject_invalid'], [40029, 'code_invalid'],
      [81013, 'recipient_invalid'], [82001, 'recipient_invalid'], [12345, 'other'],
    ]
    for (const [code, category] of table) expect(classifyWeComErrcode(code)).toBe(category)
  })
})

describe('WeCom client read layer: request shape', () => {
  const AGENT = WECOM_FIXTURE_AGENT_ID

  async function runAllThree(options: WeComRequestOptions & { baseUrl?: string }) {
    const { baseUrl, ...requestOptions } = options
    const config = { ...CONFIG, baseUrl }
    await getWeComAgent(config, AGENT, requestOptions)
    await listWeComDepartments(config, requestOptions)
    await listWeComDepartmentMembers(config, '7', requestOptions)
  }

  const stubAll = () => createWeComFetchStub({
    agent: ok(agentPayload()),
    departments: ok(departmentsPayload([dept(1, 0)])),
    users: ok(usersPayload([])),
  })

  it('issues GET with a JSON Accept header, no body and an abort signal on every request', async () => {
    const stub = stubAll()
    await runAllThree({ fetchFn: stub.fetchFn })
    expect(stub.requests.map((request) => request.route)).toEqual(['gettoken', 'agent', 'departments', 'users'])
    for (const request of stub.requests) {
      expect(request.method).toBe('GET')
      expect(request.headers.accept).toBe('application/json')
      expect(request.body).toBeUndefined()
      expect(request.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('sends exactly the documented query keys, and department/list carries no id', async () => {
    const stub = stubAll()
    await runAllThree({ fetchFn: stub.fetchFn })
    const keysOf = (route: string) => Object.keys(stub.requests.find((request) => request.route === route)?.query ?? {})
    expect(keysOf('gettoken')).toEqual(['corpid', 'corpsecret'])
    expect(keysOf('agent')).toEqual(['access_token', 'agentid'])
    expect(keysOf('departments')).toEqual(['access_token'])
    expect(keysOf('users')).toEqual(['access_token', 'department_id'])
    expect(stub.requests.find((request) => request.route === 'users')?.query.department_id).toBe('7')
  })

  it('sends every request to the origin of the configured base URL', async () => {
    const custom = stubAll()
    await runAllThree({ fetchFn: custom.fetchFn, baseUrl: 'https://gateway.example.test///' })
    expect(new Set(custom.requests.map((request) => request.origin))).toEqual(new Set(['https://gateway.example.test']))

    __resetWeComAppAccessTokenCacheForTests()
    const fallback = stubAll()
    await runAllThree({ fetchFn: fallback.fetchFn })
    expect(new Set(fallback.requests.map((request) => request.origin))).toEqual(new Set(['https://qyapi.weixin.qq.com']))
  })
})

describe('WeCom client read layer: abort signal and body reads', () => {
  const hangUntilAborted = (): { fetchFn: typeof fetch; aborts: number[] } => {
    const aborts: number[] = []
    const fetchFn = ((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      const startedAt = Date.now()
      init?.signal?.addEventListener('abort', () => {
        aborts.push(Date.now() - startedAt)
        reject(init.signal?.reason)
      }, { once: true })
    })) as unknown as typeof fetch
    return { fetchFn, aborts }
  }

  it('aborts a request that never answers through the attempt signal', async () => {
    const hung = hangUntilAborted()
    const error = await listWeComDepartments(CONFIG, { fetchFn: hung.fetchFn, timeoutMs: 25, ...seams(createClock()) }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComTimeoutError)
    expect(error.timeoutMs).toBe(25)
    expect(hung.aborts).toHaveLength(3)
    for (const elapsed of hung.aborts) expect(elapsed).toBeGreaterThanOrEqual(15)
  })

  it('caps the attempt signal at the remaining budget', async () => {
    const clock = createClock()
    const hung = hangUntilAborted()
    const fetchFn = ((input: unknown, init?: RequestInit) => {
      if (String(input).includes('/gettoken')) {
        clock.advance(WECOM_READ_CALL_DEADLINE_MS - 40)
        return Promise.resolve(new Response(JSON.stringify({ errcode: 0, access_token: WECOM_FIXTURE_TOKEN, expires_in: 7200 }), { status: 200 }))
      }
      return hung.fetchFn(input as string, init)
    }) as typeof fetch
    const startedAt = Date.now()
    const error = await listWeComDepartments(CONFIG, { fetchFn, timeoutMs: 4_000, ...seams(clock) }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComTimeoutError)
    expect(error.timeoutMs).toBe(40)
    expect(hung.aborts.length).toBeGreaterThan(0)
    for (const elapsed of hung.aborts) expect(elapsed).toBeLessThan(1_000)
    expect(Date.now() - startedAt).toBeLessThan(3_000)
  })

  it('reports a body that stalls after the headers as a timeout and retries it', async () => {
    const stub = createWeComFetchStub({ agent: stalledBody() })
    const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, timeoutMs: 30, ...seams(createClock()) }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComTimeoutError)
    expect(stub.count('agent')).toBe(3)
  })

  it('maps an abort while the body is read to a timeout and a reset body to a transport fault', async () => {
    const reasons: string[] = []
    const aborted = createWeComFetchStub({ agent: bodyFailWith(abortError()) })
    const timeout = await observeWeComTransportRetries((event) => reasons.push(event.reason), () => getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: aborted.fetchFn, ...seams(createClock()) }).catch((e) => e))
    expect(timeout).toBeInstanceOf(WeComTimeoutError)
    expect(aborted.count('agent')).toBe(3)
    expect(reasons).toEqual(['network_error', 'network_error'])

    __resetWeComAppAccessTokenCacheForTests()
    const reset = createWeComFetchStub({ agent: bodyFailWith(new TypeError('terminated')) })
    const transport = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: reset.fetchFn, ...seams(createClock()) }).catch((e) => e)
    expect(transport).toBeInstanceOf(WeComTransportError)
    expect(reset.count('agent')).toBe(3)
  })

  it('keeps a non-JSON body an incomplete response that is not retried', async () => {
    const stub = createWeComFetchStub({ agent: rawBody('<html>gateway</html>') })
    const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(createClock()) }).catch((e) => e)
    expect(error).toBeInstanceOf(WeComIncompleteResponseError)
    expect(error.location).toBe('response')
    expect(stub.count('agent')).toBe(1)
  })
})

describe('WeCom client read layer: token lifetime', () => {
  const T0 = 1_800_000_000_000

  async function gettokenCallsAfter(expiresIn: unknown, laterMs: number): Promise<number> {
    __resetWeComAppAccessTokenCacheForTests()
    const stub = createWeComFetchStub({
      agent: ok(agentPayload()),
      token: ok({ errcode: 0, access_token: 'lifetime-token', ...(expiresIn === undefined ? {} : { expires_in: expiresIn }) }),
    })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(T0)
    try {
      await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
      clock.mockReturnValue(T0 + laterMs)
      await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn })
    } finally {
      clock.mockRestore()
    }
    return stub.count('gettoken')
  }

  it('serves a 7200 second token until 120 seconds before it expires', async () => {
    expect(await gettokenCallsAfter(7200, 7_080_000 - 1)).toBe(1)
    expect(await gettokenCallsAfter(7200, 7_080_000)).toBe(2)
  })

  it('keeps a short-lived token for at least 30 seconds', async () => {
    expect(await gettokenCallsAfter(60, 30_000 - 1)).toBe(1)
    expect(await gettokenCallsAfter(60, 30_000)).toBe(2)
  })

  it('falls back to 3300 seconds when expires_in is missing or not a positive number', async () => {
    for (const expiresIn of [undefined, 0, -5, 'soon']) {
      expect(await gettokenCallsAfter(expiresIn, 3_300_000 - 1)).toBe(1)
      expect(await gettokenCallsAfter(expiresIn, 3_300_000)).toBe(2)
    }
  })
})

describe('WeCom client read layer: token stage statuses', () => {
  // The retried set is 45033, -1, HTTP 5xx, network errors and timeouts; the token stage uses the same set.
  const attempts = async (token: ReturnType<typeof ok>) => {
    __resetWeComAppAccessTokenCacheForTests()
    const stub = createWeComFetchStub({ token, agent: ok(agentPayload()) })
    const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, { fetchFn: stub.fetchFn, ...seams(createClock()) }).catch((e) => e)
    return { error, tokenCalls: stub.count('gettoken'), agentCalls: stub.count('agent') }
  }

  it('does not retry HTTP 408 or HTTP 429 when the token is requested', async () => {
    for (const status of [408, 429]) {
      const { error, tokenCalls, agentCalls } = await attempts(httpStatus(status))
      expect(error).toBeInstanceOf(WeComRequestError)
      expect(error.statusCode).toBe(status)
      expect(tokenCalls).toBe(1)
      expect(agentCalls).toBe(0)
    }
  })

  it('does not retry a malformed token response', async () => {
    const { error, tokenCalls } = await attempts(rawBody('<html>gateway</html>'))
    expect(error).toBeInstanceOf(WeComIncompleteResponseError)
    expect(error.location).toBe('response')
    expect(tokenCalls).toBe(1)
  })

  it('retries HTTP 5xx and 45033 when the token is requested', async () => {
    const serverError = await attempts(httpStatus(502))
    expect(serverError.tokenCalls).toBe(3)
    const busy = await attempts(errcodeReply(45033))
    expect(busy.tokenCalls).toBe(3)
  })
})

describe('WeCom client read layer: thrown errors carry no request values', () => {
  const LEAK = 'LEAK-PROVIDER-TEXT-203.0.113.9'
  const DECLARED = new Set(['stack', 'message', 'name', 'location', 'field', 'timeoutMs', 'errcode', 'statusCode', 'responseBody'])
  const FORBIDDEN = [LEAK, WECOM_FIXTURE_SECRET, WECOM_FIXTURE_TOKEN, 'corpsecret', 'access_token', 'https://', 'http://', 'qyapi']

  function expectValuesFree(error: any): void {
    expect(error).toBeInstanceOf(Error)
    expect(error.cause).toBeUndefined()
    expect(Object.getOwnPropertyNames(error).filter((name) => !DECLARED.has(name))).toEqual([])
    if ('responseBody' in error) expect(error.responseBody).toBeNull()
    const text = [error.message, error.stack, JSON.stringify(error), Object.getOwnPropertyNames(error).join(',')].join('\n')
    for (const forbidden of FORBIDDEN) expect(text).not.toContain(forbidden)
  }

  const echoUrlError = (input: unknown) => new TypeError(`Failed to parse URL from ${String(input)}`)

  const operations: Array<[string, (options: WeComRequestOptions) => Promise<unknown>]> = [
    ['agent', (options) => getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, options)],
    ['departments', (options) => listWeComDepartments(CONFIG, options)],
    ['users', (options) => listWeComDepartmentMembers(CONFIG, '2', options)],
  ]
  const faults: Array<[string, ReturnType<typeof ok>]> = [
    ['timeout', failWith(abortError())],
    ['5xx', httpStatus(503, { errmsg: LEAK })],
    ['business errcode', errcodeReply(48002, LEAK)],
    ['unreadable body', bodyFailWith(new TypeError(`terminated ${LEAK}`))],
    ['malformed body', rawBody(LEAK)],
    ['shape fault', ok({ errcode: 0, errmsg: LEAK, department: [null], userlist: [null], agentid: LEAK })],
  ]

  for (const [operationName, run] of operations) {
    for (const [faultName, fault] of faults) {
      it(`keeps ${operationName} values-free on ${faultName}`, async () => {
        const stub = createWeComFetchStub({ agent: fault, departments: fault, users: fault })
        const error = await run({ fetchFn: stub.fetchFn, ...seams(createClock()) }).catch((e) => e)
        expectValuesFree(error)
      })
    }

    it(`keeps ${operationName} values-free when the transport error echoes the request URL`, async () => {
      const stub = createWeComFetchStub({ agent: ok(agentPayload()), departments: ok(departmentsPayload([])), users: ok(usersPayload([])) })
      const fetchFn = ((input: unknown, init?: RequestInit) => {
        if (String(input).includes('/gettoken')) return stub.fetchFn(input as string, init)
        throw echoUrlError(input)
      }) as typeof fetch
      const error = await run({ fetchFn, ...seams(createClock()) }).catch((e) => e)
      expect(error).toBeInstanceOf(WeComTransportError)
      expectValuesFree(error)
    })

    it(`keeps ${operationName} values-free when the token request echoes its URL`, async () => {
      const fetchFn = ((input: unknown) => { throw echoUrlError(input) }) as typeof fetch
      const error = await run({ fetchFn, ...seams(createClock()) }).catch((e) => e)
      expect(error).toBeInstanceOf(WeComTransportError)
      expectValuesFree(error)
    })
  }

  it('keeps the logged lines free of the echoed URL as well', async () => {
    const spies = spyOnLogger()
    const fetchFn = ((input: unknown) => { throw echoUrlError(input) }) as typeof fetch
    await listWeComDepartments(CONFIG, { fetchFn, ...seams(createClock()) }).catch((e) => e)
    const text = loggedText(spies)
    for (const forbidden of FORBIDDEN) expect(text).not.toContain(forbidden)
  })
})

describe('WeCom client read layer: single request path', () => {
  const clientSource = () => fs.readFileSync(path.resolve(HERE, '../../src/integrations/wecom/client.ts'), 'utf8')

  it('has exactly one fetch call site', () => {
    const source = clientSource()
    expect(source.match(/\bfetch\)\(/g)).toHaveLength(1)
    expect(source.match(/(^|[^.\w])fetch\(/gm)).toBeNull()
  })

  it('reads the process environment only in the known places', () => {
    const lines = clientSource().split('\n').filter((line) => line.includes('process.env')).map((line) => line.trim())
    expect(lines).toEqual([
      'const raw = Number(process.env.WECOM_REQUEST_TIMEOUT_MS)',
      'export function readWeComMessageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WeComMessageConfig {',
      'env: NodeJS.ProcessEnv = process.env,',
      'export function readWeComBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {',
    ])
  })
})

describe('WeCom client read layer: zero real network', () => {
  it('has replaced the global fetch with a throwing stub', async () => {
    await expect(Promise.resolve().then(() => globalThis.fetch('https://example.test/'))).rejects.toThrow('real network is not available')
  })

  it('reaches the stubbed global fetch only when no fetchFn is injected, and fails typed', async () => {
    const error = await getWeComAgent(CONFIG, WECOM_FIXTURE_AGENT_ID, seams(createClock())).catch((e) => e)
    expect(error).toBeInstanceOf(WeComTransportError)
  })

  it('names the production host only as the default base URL in client.ts', () => {
    const root = path.resolve(HERE, '../../src')
    const hits: Array<{ file: string; lines: string[] }> = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx|js|cjs|mjs|json)$/.test(entry.name)) {
          const lines = fs.readFileSync(full, 'utf8').split('\n').filter((line) => line.includes('qyapi.weixin.qq.com'))
          if (lines.length > 0) hits.push({ file: path.relative(root, full), lines })
        }
      }
    }
    walk(root)
    expect(hits.map((hit) => hit.file)).toEqual(['integrations/wecom/client.ts'])
    expect(hits[0].lines).toHaveLength(1)
    expect(hits[0].lines[0]).toContain("'https://qyapi.weixin.qq.com'")
  })
})
