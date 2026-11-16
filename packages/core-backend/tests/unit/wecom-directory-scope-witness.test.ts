import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeWeComScopeDigest,
  createWeComDirectoryAdapter,
  type WeComDirectoryConfig,
} from '../../src/directory/adapters/wecom-directory-adapter'
import {
  WeComAppClosedError,
  WeComAppTypeUnsupportedError,
  WeComScopeChangedError,
  WeComScopeKindUnsupportedError,
  WeComScopeUnacknowledgedError,
} from '../../src/directory/adapters/wecom-directory-errors'
import {
  __resetWeComAppAccessTokenCacheForTests,
  WeComBusinessError,
  WeComIncompleteResponseError,
} from '../../src/integrations/wecom/client'
import {
  WECOM_FIXTURE_AGENT_ID,
  WECOM_FIXTURE_CORP_ID,
  WECOM_FIXTURE_SECRET,
  agentPayload,
  baselineSpec,
  createWeComFetchStub,
  errcodeReply,
  ok,
  type WeComStubSpec,
} from '../fixtures/directory/wecom/wecom-fixtures'

const realFetch = globalThis.fetch
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const digestOf = (parties: number[], users: string[] = [], tags: number[] = []) =>
  computeWeComScopeDigest({ allowPartyIds: parties, allowUserIds: users, allowTagIds: tags })
const ROOT_ONLY = digestOf([1])

const CONFIG: WeComDirectoryConfig = {
  corpId: WECOM_FIXTURE_CORP_ID,
  corpSecret: WECOM_FIXTURE_SECRET,
  wecomAgentId: WECOM_FIXTURE_AGENT_ID,
  rootDepartmentId: '1',
  scopeDigestAcknowledged: ROOT_ONLY,
}

function adapterFor(spec: WeComStubSpec) {
  const stub = createWeComFetchStub(spec)
  const adapter = createWeComDirectoryAdapter({ requestOptions: { fetchFn: stub.fetchFn, sleep: async () => undefined, random: () => 0 } })
  return { stub, adapter }
}

const caught = async (run: () => Promise<unknown>): Promise<any> => run().then(() => undefined, (error) => error)

/** Runs both fetch methods against the same agent behaviour; `members` reuses departments from a clean agent. */
async function runBoth(config: WeComDirectoryConfig, agent: WeComStubSpec['agent']) {
  const departments = await (async () => {
    const clean = adapterFor(baselineSpec())
    return clean.adapter.fetchDepartments({ ...CONFIG }, 'Acme')
  })()
  __resetWeComAppAccessTokenCacheForTests()
  const forDepartments = adapterFor({ ...baselineSpec(), agent })
  const departmentsError = await caught(() => forDepartments.adapter.fetchDepartments(config, 'Acme'))
  __resetWeComAppAccessTokenCacheForTests()
  const forMembers = adapterFor({ ...baselineSpec(), agent })
  const membersError = await caught(() => forMembers.adapter.fetchMembers(config, departments))
  return { departmentsError, membersError, forDepartments, forMembers }
}

beforeEach(() => {
  __resetWeComAppAccessTokenCacheForTests()
  globalThis.fetch = (() => { throw new Error('real network is not available in this test') }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('WeCom scope digest', () => {
  it('serializes [parties, lower-case users, tags] and hashes with SHA-256', () => {
    expect(ROOT_ONLY).toBe(sha256('[[1],[],[]]'))
    expect(digestOf([3, 1, 3], ['B', 'a'], [9, 2])).toBe(sha256('[[1,3],["a","b"],[2,9]]'))
    expect(ROOT_ONLY).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not depend on the order or duplication of its inputs', () => {
    expect(digestOf([2, 1, 2], ['x', 'y'], [5, 4])).toBe(digestOf([1, 2], ['y', 'x', 'X'], [4, 5, 5]))
  })

  it('sorts ids numerically, not as strings', () => {
    expect(digestOf([10, 9])).toBe(sha256('[[9,10],[],[]]'))
  })

  it('lower-cases userids and changes with every component', () => {
    expect(digestOf([1], ['ZED'])).toBe(digestOf([1], ['zed']))
    const all = new Set([ROOT_ONLY, digestOf([1, 2]), digestOf([1], ['zed']), digestOf([1], [], [3]), digestOf([2])])
    expect(all.size).toBe(5)
  })

  it('reads the nested allow_* shape of the agent response', async () => {
    const { adapter } = adapterFor({ ...baselineSpec(), agent: ok(agentPayload({ parties: [4, 1] })) })
    const config = { ...CONFIG, scopeDigestAcknowledged: digestOf([1, 4]) }
    expect((await adapter.fetchDepartments(config, 'Acme')).has('1')).toBe(true)
  })
})

describe('WeCom scope witness (FX-06, FX-08)', () => {
  it('refuses an unconfirmed scope before any list call', async () => {
    for (const acknowledged of [undefined, '']) {
      __resetWeComAppAccessTokenCacheForTests()
      const { departmentsError, membersError, forDepartments, forMembers } = await runBoth({ ...CONFIG, scopeDigestAcknowledged: acknowledged }, ok(agentPayload()))
      expect(departmentsError).toBeInstanceOf(WeComScopeUnacknowledgedError)
      expect(membersError).toBeInstanceOf(WeComScopeUnacknowledgedError)
      expect(forDepartments.stub.count('departments') + forMembers.stub.count('users')).toBe(0)
    }
  })

  it('refuses a scope that shrank, before any list call', async () => {
    const { departmentsError, membersError, forDepartments, forMembers } = await runBoth(
      { ...CONFIG, scopeDigestAcknowledged: digestOf([1, 2]) },
      ok(agentPayload({ parties: [1] })),
    )
    expect(departmentsError).toBeInstanceOf(WeComScopeChangedError)
    expect(membersError).toBeInstanceOf(WeComScopeChangedError)
    expect(forDepartments.stub.count('departments')).toBe(0)
    expect(forMembers.stub.count('users')).toBe(0)
  })

  it('refuses a scope that grew, before any list call', async () => {
    const { departmentsError, membersError, forDepartments, forMembers } = await runBoth(
      { ...CONFIG, scopeDigestAcknowledged: digestOf([1]) },
      ok(agentPayload({ parties: [1, 2] })),
    )
    expect(departmentsError).toBeInstanceOf(WeComScopeChangedError)
    expect(membersError).toBeInstanceOf(WeComScopeChangedError)
    expect(forDepartments.stub.count('departments')).toBe(0)
    expect(forMembers.stub.count('users')).toBe(0)
  })

  it('compares the confirmed digest exactly', async () => {
    const { departmentsError } = await runBoth({ ...CONFIG, scopeDigestAcknowledged: ROOT_ONLY.toUpperCase() }, ok(agentPayload()))
    expect(departmentsError).toBeInstanceOf(WeComScopeChangedError)
  })

  it('proceeds when the digest matches', async () => {
    const { adapter } = adapterFor(baselineSpec())
    const departments = await adapter.fetchDepartments(CONFIG, 'Acme')
    expect((await adapter.fetchMembers(CONFIG, departments)).size).toBe(6)
  })

  it('refuses when the scope changes between the department phase and the member phase', async () => {
    const { adapter, stub } = adapterFor({
      ...baselineSpec(),
      agent: (call) => ok(agentPayload({ parties: call === 1 ? [1] : [1, 2] })),
    })
    const departments = await adapter.fetchDepartments(CONFIG, 'Acme')
    const error = await caught(() => adapter.fetchMembers(CONFIG, departments))
    expect(error).toBeInstanceOf(WeComScopeChangedError)
    expect(stub.count('users')).toBe(0)
  })

  it('refuses when a department disappears from the member phase of the same round', async () => {
    for (const code of [50002, 60011, 60123]) {
      __resetWeComAppAccessTokenCacheForTests()
      const base = baselineSpec()
      const { adapter } = adapterFor({ ...base, users: { ...base.users, '3': errcodeReply(code) } })
      const departments = await adapter.fetchDepartments(CONFIG, 'Acme')
      expect(await caught(() => adapter.fetchMembers(CONFIG, departments))).toBeInstanceOf(WeComScopeChangedError)
    }
  })
})

describe('WeCom app faults (FX-09)', () => {
  it('refuses a disabled app in both phases', async () => {
    const { departmentsError, membersError, forDepartments } = await runBoth(CONFIG, ok(agentPayload({ close: 1 })))
    expect(departmentsError).toBeInstanceOf(WeComAppClosedError)
    expect(membersError).toBeInstanceOf(WeComAppClosedError)
    expect(forDepartments.stub.count('departments')).toBe(0)
  })

  it('refuses an app whose agentid differs from the configuration', async () => {
    const { departmentsError, membersError } = await runBoth(CONFIG, ok(agentPayload({ agentid: 1000003 })))
    for (const error of [departmentsError, membersError]) {
      expect(error).toBeInstanceOf(WeComIncompleteResponseError)
      expect(error.location).toBe('agent')
    }
  })

  it('refuses an app that carries customized_publish_status, whatever its value', async () => {
    for (const value of [0, 1, 3, null]) {
      __resetWeComAppAccessTokenCacheForTests()
      const { departmentsError, membersError } = await runBoth(CONFIG, ok(agentPayload({ extra: { customized_publish_status: value } })))
      expect(departmentsError).toBeInstanceOf(WeComAppTypeUnsupportedError)
      expect(membersError).toBeInstanceOf(WeComAppTypeUnsupportedError)
    }
  })

  it('checks the disabled state before the app type', async () => {
    const { departmentsError } = await runBoth(CONFIG, ok(agentPayload({ close: 1, extra: { customized_publish_status: 0 } })))
    expect(departmentsError).toBeInstanceOf(WeComAppClosedError)
  })

  it('surfaces agent/get permission and app errors as typed business errors', async () => {
    for (const code of [48002, 301002]) {
      __resetWeComAppAccessTokenCacheForTests()
      const { departmentsError, membersError } = await runBoth(CONFIG, errcodeReply(code))
      for (const error of [departmentsError, membersError]) {
        expect(error).toBeInstanceOf(WeComBusinessError)
        expect(error.errcode).toBe(code)
      }
    }
  })

  it('stops at the token stage when the token request fails first', async () => {
    const { adapter, stub } = adapterFor({ ...baselineSpec(), token: errcodeReply(40056) })
    const error = await caught(() => adapter.fetchDepartments(CONFIG, 'Acme'))
    expect(error).toBeInstanceOf(WeComBusinessError)
    expect(error.errcode).toBe(40056)
    expect(stub.count('agent')).toBe(0)
  })
})

describe('WeCom visible scope kinds (FX-21)', () => {
  const rejects = async (agent: Record<string, unknown>, acknowledged: string) => {
    const { departmentsError, membersError, forDepartments } = await runBoth({ ...CONFIG, scopeDigestAcknowledged: acknowledged }, ok(agent))
    expect(departmentsError).toBeInstanceOf(WeComScopeKindUnsupportedError)
    expect(membersError).toBeInstanceOf(WeComScopeKindUnsupportedError)
    expect(forDepartments.stub.count('departments')).toBe(0)
  }

  it('refuses a visible scope set by member, even when that exact scope was confirmed', async () => {
    await rejects(agentPayload({ users: [{ userid: 'zed' }] }), digestOf([1], ['zed']))
  })

  it('refuses a visible scope set by tag, even when that exact scope was confirmed', async () => {
    await rejects(agentPayload({ tags: [7] }), digestOf([1], [], [7]))
  })

  it('decides by the list being non-empty, not by the truthiness of its content', async () => {
    await rejects(agentPayload({ tags: [0] }), digestOf([1], [], [0]))
    await rejects(agentPayload({ users: [{ userid: '' }] }), digestOf([1], ['']))
  })

  it('accepts a department-only scope, and an empty party list is a scope like any other', async () => {
    const { adapter } = adapterFor({ ...baselineSpec(), agent: ok(agentPayload({ parties: [1, 2] })) })
    const config = { ...CONFIG, scopeDigestAcknowledged: digestOf([1, 2]) }
    expect((await adapter.fetchDepartments(config, 'Acme')).size).toBe(4)
    const { adapter: empty } = adapterFor({ ...baselineSpec(), agent: ok(agentPayload({ parties: [] })) })
    expect((await empty.fetchDepartments({ ...CONFIG, scopeDigestAcknowledged: digestOf([]) }, 'Acme')).size).toBe(4)
  })
})
