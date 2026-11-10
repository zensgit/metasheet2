import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/pg', () => ({ query: vi.fn(), transaction: vi.fn() }))

import { __directoryAdapterRegistryForTests, resolveDirectoryAdapter } from '../../src/directory/directory-adapter-registry'
import type { DirectoryDepartmentRecord } from '../../src/directory/directory-adapter'
import '../../src/directory/directory-sync'
import { createDirectorySyncApiCallCounters } from '../../src/directory/directory-sync-api-telemetry'
import {
  WECOM_DIRECTORY_ADAPTER_CAPABILITIES,
  computeWeComScopeDigest,
  createWeComDirectoryAdapter,
  wecomDirectoryAdapter,
  type WeComDirectoryConfig,
} from '../../src/directory/adapters/wecom-directory-adapter'
import {
  WeComMemberShapeViolationError,
  WeComPullTooLargeError,
  WeComRootDepartmentNotVisibleError,
} from '../../src/directory/adapters/wecom-directory-errors'
import {
  __resetWeComAppAccessTokenCacheForTests,
  observeWeComTransportRetries,
  WeComBusinessError,
  WeComIncompleteResponseError,
  WeComInvalidInputError,
  WeComRequestError,
  WeComTimeoutError,
} from '../../src/integrations/wecom/client'
import {
  WECOM_FIXTURE_AGENT_ID,
  WECOM_FIXTURE_CORP_ID,
  WECOM_FIXTURE_SECRET,
  abortError,
  agentPayload,
  baselineSpec,
  createWeComFetchStub,
  departmentsPayload,
  dept,
  errcodeReply,
  httpStatus,
  ok,
  person,
  usersPayload,
  type WeComStubSpec,
} from '../fixtures/directory/wecom/wecom-fixtures'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const realFetch = globalThis.fetch
const DIGEST_ROOT_ONLY = computeWeComScopeDigest({ allowPartyIds: [1], allowUserIds: [], allowTagIds: [] })

const CONFIG: WeComDirectoryConfig = {
  corpId: WECOM_FIXTURE_CORP_ID,
  corpSecret: WECOM_FIXTURE_SECRET,
  wecomAgentId: WECOM_FIXTURE_AGENT_ID,
  rootDepartmentId: '1',
  scopeDigestAcknowledged: DIGEST_ROOT_ONLY,
}

const noSleep = { sleep: async () => undefined, random: () => 0 }

function adapterFor(spec: WeComStubSpec) {
  const stub = createWeComFetchStub(spec)
  const adapter = createWeComDirectoryAdapter({ requestOptions: { fetchFn: stub.fetchFn, ...noSleep } })
  return { stub, adapter }
}

async function pull(spec: WeComStubSpec, config: WeComDirectoryConfig = CONFIG) {
  const { stub, adapter } = adapterFor(spec)
  const telemetry = { apiCalls: createDirectorySyncApiCallCounters() }
  const departments = await adapter.fetchDepartments(config, 'Acme', telemetry)
  const members = await adapter.fetchMembers(config, departments, telemetry)
  return { stub, adapter, departments, members, telemetry }
}

const caught = async (run: () => Promise<unknown>): Promise<any> => run().then(() => undefined, (error) => error)

function manyUsers(count: number, prefix: string, extra: Record<string, unknown> = {}): unknown[] {
  return Array.from({ length: count }, (_, index) => person(`${prefix}${index}`, { department: [2], main_department: 2, ...extra }))
}

const ENV_KEYS = ['WECOM_BASE_URL', 'WECOM_CORP_ID', 'WECOM_CORP_SECRET', 'WECOM_AGENT_ID'] as const
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  __resetWeComAppAccessTokenCacheForTests()
  globalThis.fetch = (() => { throw new Error('real network is not available in this test') }) as unknown as typeof fetch
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  globalThis.fetch = realFetch
  __directoryAdapterRegistryForTests.restore()
  vi.restoreAllMocks()
})

describe('WeCom directory adapter: baseline tenant (FX-01)', () => {
  it('builds the department model from one department/list call', async () => {
    const { departments, telemetry, stub } = await pull(baselineSpec())
    expect([...departments.keys()]).toEqual(['1', '2', '3', '4'])
    expect(departments.get('1')).toEqual({ id: '1', parentId: null, name: 'Acme', order: 0, source: { syntheticRoot: true, realRoot: true } })
    expect(departments.get('2')).toEqual({ id: '2', parentId: '1', name: 'Sales', order: 10, source: { parentid: 1, order: 10 } })
    expect(departments.get('3')).toEqual({ id: '3', parentId: '1', name: 'Support', order: 5, source: { parentid: 1, order: 5 } })
    expect(departments.get('4')).toEqual({ id: '4', parentId: '2', name: 'Sales East', order: 1, source: { parentid: 2, order: 1 } })
    for (const record of departments.values()) expect('managerUserIds' in record).toBe(false)
    expect(telemetry.apiCalls.departmentListCalls).toBe(1)
    expect(stub.count('departments')).toBe(1)
  })

  it('builds the member model with main_department first and the rest ascending', async () => {
    const { members } = await pull(baselineSpec())
    expect([...members.keys()]).toEqual(['root.admin', 'alice', 'bob', 'carol', 'erin', 'dave'])
    expect(members.get('alice')?.departmentIds).toEqual(['4', '2'])
    expect(members.get('bob')?.departmentIds).toEqual(['2'])
    expect(members.get('erin')?.departmentIds).toEqual(['2', '3'])
    expect(members.get('root.admin')?.departmentIds).toEqual(['1'])
    expect(members.get('alice')).toMatchObject({
      userId: 'alice', name: 'Alice', title: 'Rep', avatarUrl: 'https://img.example.test/a.png',
      source: { useridRaw: 'alice', position: 'Rep', order: [1, 2], is_leader_in_dept: [0, 1], main_department: 4 },
    })
    expect(members.get('root.admin')?.source).toEqual({
      useridRaw: 'Root.Admin', position: 'Admin', order: [0], is_leader_in_dept: [1], main_department: 1,
    })
    for (const member of members.values()) {
      expect(member.unionId).toBeUndefined()
      expect(member.openId).toBeUndefined()
      expect(member.providerStatus).toBeUndefined()
      expect(member.mobile).toBeUndefined()
      expect(member.email).toBeUndefined()
      expect(member.preserveContact).toEqual({ email: true, mobile: true })
    }
  })

  it('counts one department call and one member call per real department, in ascending order', async () => {
    const { telemetry, stub } = await pull(baselineSpec())
    expect(telemetry.apiCalls).toEqual({ departmentListCalls: 1, departmentDetailCalls: 0, userListPageCalls: 4, userDetailCalls: 0 })
    expect(stub.count('gettoken')).toBe(1)
    expect(stub.pathsOf('users')).toEqual(['1', '2', '3', '4'])
  })

  it('issues GET requests with exactly the documented query keys and no id on department/list', async () => {
    const { stub } = await pull(baselineSpec())
    for (const request of stub.requests) expect(request.method).toBe('GET')
    const keysOf = (route: string) => stub.requests.filter((request) => request.route === route).map((request) => Object.keys(request.query))
    expect(keysOf('gettoken')).toEqual([['corpid', 'corpsecret']])
    expect(keysOf('agent')).toEqual([['access_token', 'agentid'], ['access_token', 'agentid']])
    expect(keysOf('departments')).toEqual([['access_token']])
    expect(keysOf('users')).toEqual([['access_token', 'department_id'], ['access_token', 'department_id'], ['access_token', 'department_id'], ['access_token', 'department_id']])
    expect(stub.requests.filter((request) => request.route === 'agent').map((request) => request.query.agentid)).toEqual([WECOM_FIXTURE_AGENT_ID, WECOM_FIXTURE_AGENT_ID])
  })

  it('works without telemetry', async () => {
    const { adapter } = adapterFor(baselineSpec())
    const departments = await adapter.fetchDepartments(CONFIG, 'Acme')
    expect((await adapter.fetchMembers(CONFIG, departments)).size).toBe(6)
  })

  it('writes no approval-routing or ordering keys into any source', async () => {
    const { departments, members } = await pull({
      ...baselineSpec(),
      departments: ok(departmentsPayload([dept(1, 0), { ...dept(2, 1), department_leader: ['lead1'], name_en: 'Sales EN' }])),
      users: { '1': ok(usersPayload([person('u1', { is_leader_in_dept: [1], direct_leader: ['boss'] })])), '2': ok(usersPayload([])) },
    })
    const forbidden = ['leader_in_dept', 'dept_manager_userid_list', 'dept_order_list', 'deptOrderList', 'manager_userid_list']
    const keysOf = (value: Record<string, unknown>) => Object.keys(value)
    for (const record of [...departments.values(), ...members.values()]) {
      for (const key of forbidden) expect(keysOf(record.source)).not.toContain(key)
      expect(keysOf(record as unknown as Record<string, unknown>)).not.toContain('managerUserIds')
    }
    expect(departments.get('2')?.source).toEqual({ parentid: 1, name_en: 'Sales EN', department_leader: ['lead1'] })
    expect(members.get('u1')?.source).toMatchObject({ is_leader_in_dept: [1], direct_leader: ['boss'] })
  })

  it('keeps DingTalk-shaped approval keys out of the adapter source', () => {
    const text = fs.readFileSync(path.resolve(HERE, '../../src/directory/adapters/wecom-directory-adapter.ts'), 'utf8')
    expect(text).not.toMatch(/(?<!is_)leader_in_dept/)
    for (const token of ['dept_manager_userid_list', 'dept_order_list', 'deptOrderList', 'managerUserIds']) {
      expect(text).not.toContain(token)
    }
  })
})

describe('WeCom directory adapter: contract and registration', () => {
  it('pins the provider, the six capability fields and the shared retry observer', () => {
    const adapter = createWeComDirectoryAdapter()
    expect(adapter.provider).toBe('wecom')
    expect(adapter.capabilities).toEqual({
      contactFields: { email: 'needs_field_permission', mobile: 'needs_field_permission' },
      memberOpenId: 'unavailable',
      memberUnionId: 'unavailable',
      managerIds: false,
      primaryDepartmentSignal: false,
      diagnostics: false,
    })
    expect(adapter.capabilities).toBe(WECOM_DIRECTORY_ADAPTER_CAPABILITIES)
    expect(adapter.observeRetries).toBe(observeWeComTransportRetries)
    expect(typeof adapter.failureText).toBe('function')
    expect(adapter.sampleDiagnostics).toBeUndefined()
    expect(adapter.probeConnection).toBeUndefined()
  })

  it('is registered unconditionally as one shared instance', () => {
    expect(resolveDirectoryAdapter('wecom')).toBe(wecomDirectoryAdapter)
    expect(resolveDirectoryAdapter('dingtalk').provider).toBe('dingtalk')
  })

  it('can be swapped through the registry test seam', () => {
    const { adapter } = adapterFor(baselineSpec())
    __directoryAdapterRegistryForTests.replace(new Map([['wecom', adapter as never]]))
    expect(resolveDirectoryAdapter('wecom')).toBe(adapter)
    __directoryAdapterRegistryForTests.restore()
    expect(resolveDirectoryAdapter('wecom')).toBe(wecomDirectoryAdapter)
  })

  it('serves concurrent rounds from one instance without sharing state', async () => {
    const { adapter } = adapterFor(baselineSpec())
    const [first, second] = await Promise.all([0, 1].map(async () => {
      const departments = await adapter.fetchDepartments(CONFIG, 'Acme')
      return adapter.fetchMembers(CONFIG, departments)
    }))
    expect([...first.keys()]).toEqual([...second.keys()])
  })

  it('rejects an invalid root department id before any request', async () => {
    const { adapter, stub } = adapterFor(baselineSpec())
    const departments = new Map<string, DirectoryDepartmentRecord>()
    for (const call of [
      () => adapter.fetchDepartments({ ...CONFIG, rootDepartmentId: '1/2' }, 'Acme'),
      () => adapter.fetchMembers({ ...CONFIG, rootDepartmentId: 'x' }, departments),
    ]) {
      expect(await caught(call)).toBeInstanceOf(WeComInvalidInputError)
    }
    expect(stub.requests).toHaveLength(0)
  })
})

describe('WeCom directory adapter: contact fields (FX-02 to FX-05, FX-07)', () => {
  const withContacts = (overrides: Record<string, Record<string, unknown>>) => {
    const base = baselineSpec()
    return {
      ...base,
      users: {
        ...base.users,
        '2': ok(usersPayload([
          person('alice', { name: 'Alice', department: [2, 4], main_department: 4, ...(overrides.alice ?? {}) }),
          person('bob', { name: 'Bob', department: [2], main_department: 2, ...(overrides.bob ?? {}) }),
        ])),
      },
    }
  }

  it('adopts the values of a tenant that returns contacts and sets no flags (FX-02)', async () => {
    const { members } = await pull(withContacts({ alice: { mobile: '13800000001', email: 'alice@example.test' }, bob: { mobile: '13800000002', email: 'bob@example.test' } }))
    expect(members.get('alice')).toMatchObject({ mobile: '13800000001', email: 'alice@example.test' })
    expect(members.get('bob')).toMatchObject({ mobile: '13800000002', email: 'bob@example.test' })
    for (const member of members.values()) expect(member.preserveContact).toBeUndefined()
  })

  it('never repeats a contact value in the source (FX-02)', async () => {
    const base = withContacts({ alice: { mobile: '13800000001', email: 'alice@example.test', telephone: '010-1', biz_mail: 'a@corp.example.test' }, bob: { mobile: '13800000002', email: 'bob@example.test' } })
    const { members } = await pull({ ...base, users: { ...base.users, '4': ok(usersPayload([])) } })
    expect(members.get('alice')?.source).toEqual({ useridRaw: 'alice', main_department: 4 })
    expect(members.get('bob')?.source).toEqual({ useridRaw: 'bob', main_department: 2 })
    for (const member of members.values()) {
      expect(Object.keys(member.source)).not.toContain('mobile')
      expect(Object.keys(member.source)).not.toContain('email')
      expect(JSON.stringify(member.source)).not.toMatch(/13800000|example\.test|010-1/)
    }
  })

  it('observes per round: one value anywhere means no flag for anyone (FX-03)', async () => {
    const { members } = await pull(withContacts({ alice: { mobile: '13800000001', email: 'alice@example.test' } }))
    expect(members.get('alice')?.mobile).toBe('13800000001')
    expect(members.get('bob')?.mobile).toBeUndefined()
    expect(members.get('bob')?.email).toBeUndefined()
    for (const member of members.values()) expect(member.preserveContact).toBeUndefined()
  })

  it('flags only the field that no member carries', async () => {
    const { members } = await pull(withContacts({ alice: { email: 'alice@example.test' } }))
    for (const member of members.values()) expect(member.preserveContact).toEqual({ mobile: true })
  })

  it('flips the flags with the field permission across rounds (FX-04)', async () => {
    const base = baselineSpec()
    let round = 1
    const users = {
      ...base.users,
      '2': (() => ok(usersPayload([
        person('alice', { department: [2], main_department: 2, ...(round === 2 ? {} : { mobile: '13800000001', email: 'alice@example.test' }) }),
      ]))) as never,
    }
    const { adapter } = adapterFor({ ...base, users })
    const flagsOf = async () => {
      const departments = await adapter.fetchDepartments(CONFIG, 'Acme')
      const members = await adapter.fetchMembers(CONFIG, departments)
      return members.get('alice')?.preserveContact
    }
    round = 1
    expect(await flagsOf()).toBeUndefined()
    round = 2
    expect(await flagsOf()).toEqual({ email: true, mobile: true })
    round = 3
    expect(await flagsOf()).toBeUndefined()
  })

  it('assumes: treats a missing key, an empty string and blanks alike (FX-05)', async () => {
    const { members } = await pull(withContacts({ alice: { mobile: '', email: '' }, bob: { mobile: '   ' } }))
    for (const member of members.values()) {
      expect(member.mobile).toBeUndefined()
      expect(member.email).toBeUndefined()
      expect(member.preserveContact).toEqual({ email: true, mobile: true })
    }
  })

  it('returns exactly the pulled set and declares no absence guard (FX-07, adapter side)', async () => {
    const base = baselineSpec()
    const full = await pull(base)
    const shrunk = await pull({ ...base, users: { '1': ok(usersPayload([])), '2': ok(usersPayload([person('alice', { department: [2] })])), '3': ok(usersPayload([])), '4': ok(usersPayload([])) } })
    expect(full.members.size).toBe(6)
    expect([...shrunk.members.keys()]).toEqual(['alice'])
    expect('absenceGuard' in full.adapter.capabilities).toBe(false)
  })
})

describe('WeCom directory adapter: fault sequence (FX-10)', () => {
  const run = (spec: WeComStubSpec, config: WeComDirectoryConfig = CONFIG) => {
    const { adapter, stub } = adapterFor(spec)
    const result = (async () => {
      const departments = await adapter.fetchDepartments(config, 'Acme')
      return adapter.fetchMembers(config, departments)
    })()
    return { stub, result }
  }
  const usersCalledFor = (stub: ReturnType<typeof createWeComFetchStub>, id: string) => stub.pathsOf('users').filter((value) => value === id).length

  it('stops at an untrusted-IP token failure before any list call', async () => {
    const { stub, result } = run({ ...baselineSpec(), token: errcodeReply(60020) })
    const error = await caught(() => result)
    expect(error).toBeInstanceOf(WeComBusinessError)
    expect(error.errcode).toBe(60020)
    expect(stub.count('agent') + stub.count('departments') + stub.count('users')).toBe(0)
  })

  it('invalidates and refetches the token once on 42001 in the middle of a round', async () => {
    const base = baselineSpec()
    const { stub, result } = run({ ...base, users: { ...base.users, '2': ((call: number) => (call === 1 ? errcodeReply(42001) : base.users['2'])) as never } })
    expect((await result).size).toBe(6)
    expect(stub.count('gettoken')).toBe(2)
  })

  it('refuses the round when a refreshed token is invalid again (40014)', async () => {
    const base = baselineSpec()
    const { stub, result } = run({ ...base, users: { ...base.users, '2': errcodeReply(40014) } })
    const error = await caught(() => result)
    expect(error.errcode).toBe(40014)
    expect(stub.count('gettoken')).toBe(2)
  })

  it('makes exactly one call after 45009 and rejects the round', async () => {
    const base = baselineSpec()
    const { stub, result } = run({ ...base, users: { ...base.users, '3': errcodeReply(45009) } })
    const error = await caught(() => result)
    expect(error.errcode).toBe(45009)
    expect(usersCalledFor(stub, '3')).toBe(1)
    expect(usersCalledFor(stub, '4')).toBe(0)
  })

  for (const code of [45033, -1]) {
    it(`retries ${code} at most three times including the first, then rejects the round`, async () => {
      const base = baselineSpec()
      const { stub, result } = run({ ...base, users: { ...base.users, '3': errcodeReply(code) } })
      const error = await caught(() => result)
      expect(error).toBeInstanceOf(WeComBusinessError)
      expect(error.errcode).toBe(code)
      expect(usersCalledFor(stub, '3')).toBe(3)
    })

    it(`recovers when ${code} clears on the second attempt`, async () => {
      const base = baselineSpec()
      const { stub, result } = run({ ...base, users: { ...base.users, '3': ((call: number) => (call === 1 ? errcodeReply(code) : base.users['3'])) as never } })
      expect((await result).size).toBe(6)
      expect(usersCalledFor(stub, '3')).toBe(2)
    })
  }

  it('retries server errors and timeouts a bounded number of times and rejects typed', async () => {
    const base = baselineSpec()
    const server = run({ ...base, users: { ...base.users, '2': httpStatus(502) } })
    const serverError = await caught(() => server.result)
    expect(serverError).toBeInstanceOf(WeComRequestError)
    expect(usersCalledFor(server.stub, '2')).toBe(3)

    __resetWeComAppAccessTokenCacheForTests()
    const timeout = run({ ...base, users: { ...base.users, '2': { kind: 'throw', error: abortError() } } })
    expect(await caught(() => timeout.result)).toBeInstanceOf(WeComTimeoutError)
    expect(usersCalledFor(timeout.stub, '2')).toBe(3)
  })

  it('does not retry a non-2xx status that is not a server error', async () => {
    const base = baselineSpec()
    const { stub, result } = run({ ...base, users: { ...base.users, '2': httpStatus(404) } })
    const error = await caught(() => result)
    expect(error).toBeInstanceOf(WeComRequestError)
    expect(error.statusCode).toBe(404)
    expect(usersCalledFor(stub, '2')).toBe(1)
  })

  it('returns no partial map when any department fails', async () => {
    const base = baselineSpec()
    const { adapter } = adapterFor({ ...base, users: { ...base.users, '4': errcodeReply(48002) } })
    const departments = await adapter.fetchDepartments(CONFIG, 'Acme')
    const outcome = await adapter.fetchMembers(CONFIG, departments).then((value) => ({ value }), (error) => ({ error }))
    expect('value' in outcome).toBe(false)
    expect((outcome as { error: WeComBusinessError }).error.errcode).toBe(48002)
  })
})

describe('WeCom directory adapter: member ids (FX-11)', () => {
  const specWith = (dept2: unknown[], dept3: unknown[] = []): WeComStubSpec => {
    const base = baselineSpec()
    return { ...base, users: { '1': ok(usersPayload([])), '2': ok(usersPayload(dept2)), '3': ok(usersPayload(dept3)), '4': ok(usersPayload([])) } }
  }

  it('uses lower(userid) as the id, merges the same person across cases, and keeps the original in the source', async () => {
    const { members } = await pull(specWith(
      [person('Zhang.San', { department: [2], main_department: 2 }), person('UPPER', { department: [2] })],
      [person('zhang.san', { department: [3], main_department: 3 })],
    ))
    expect([...members.keys()].sort()).toEqual(['upper', 'zhang.san'])
    expect([...members.keys()].every((key) => key === key.toLowerCase())).toBe(true)
    expect(members.get('zhang.san')?.source.useridRaw).toBe('Zhang.San')
    expect(members.get('zhang.san')?.departmentIds).toEqual(['2', '3'])
  })

  it('merges the first non-empty name and falls back to the id when none exists', async () => {
    const { members } = await pull(specWith(
      [person('a1', { name: '' }), person('a2', { name: '' })],
      [person('a1', { name: 'Named' })],
    ))
    expect(members.get('a1')?.name).toBe('Named')
    expect(members.get('a1')?.source.nameUnavailable).toBeUndefined()
    expect(members.get('a2')?.name).toBe('a2')
    expect(members.get('a2')?.source.nameUnavailable).toBe(true)
  })

  it('assumes: isolates ids that break the character rule and never lets a slash into a member id', async () => {
    const { members } = await pull(specWith([
      person('ok1'),
      person('Corp/zhang'),
      person('x'.repeat(65)),
      person('bad id'),
      person(''),
      person('_lead'),
      person('naïve'),
    ]))
    expect([...members.keys()]).toEqual(['ok1'])
    expect([...members.keys()].some((key) => key.includes('/'))).toBe(false)
  })

  it('passes with exactly ten isolated ids when the floor governs and refuses at eleven', async () => {
    const valid = manyUsers(100, 'valid')
    const bad = (count: number) => Array.from({ length: count }, (_, index) => person(`bad/${index}`))
    const passes = await pull(specWith([...valid, ...bad(10)]))
    expect(passes.members.size).toBe(100)
    const refused = await caught(() => pull(specWith([...valid, ...bad(11)])))
    expect(refused).toBeInstanceOf(WeComMemberShapeViolationError)
    expect(refused.count).toBe(11)
  })

  it('passes at two percent of the total and refuses above it', async () => {
    const valid = manyUsers(1000, 'valid')
    const bad = (count: number) => Array.from({ length: count }, (_, index) => person(`bad/${index}`))
    expect((await pull(specWith([...valid, ...bad(20)]))).members.size).toBe(1000)
    const refused = await caught(() => pull(specWith([...valid, ...bad(21)])))
    expect(refused).toBeInstanceOf(WeComMemberShapeViolationError)
    expect(refused.count).toBe(21)
  })

  it('counts one isolated id once however many departments list it', async () => {
    const valid = manyUsers(100, 'valid')
    const bad = Array.from({ length: 10 }, (_, index) => person(`bad/${index}`))
    const { members } = await pull(specWith([...valid, ...bad], bad))
    expect(members.size).toBe(100)
  })

  it('refuses the whole round instead of returning a partial map above the threshold', async () => {
    const bad = Array.from({ length: 50 }, (_, index) => person(`bad/${index}`))
    const { adapter } = adapterFor(specWith([person('ok1'), ...bad]))
    const departments = await adapter.fetchDepartments(CONFIG, 'Acme')
    expect(await caught(() => adapter.fetchMembers(CONFIG, departments))).toBeInstanceOf(WeComMemberShapeViolationError)
  })
})

describe('WeCom directory adapter: department anomalies (FX-12)', () => {
  const specFor = (departments: unknown[], users: WeComStubSpec['users'] = ok(usersPayload([]))): WeComStubSpec => ({
    ...baselineSpec(),
    departments: ok(departmentsPayload(departments)),
    users,
  })

  it('re-parents orphans and parentid 0 to the root and keeps the original', async () => {
    const { departments } = await pull(specFor([dept(1, 0), dept(2, 1), dept(9, 55), dept(8, 0), dept(7, 2)]))
    expect(departments.get('9')?.parentId).toBe('1')
    expect(departments.get('9')?.source.parentid).toBe(55)
    expect(departments.get('8')?.parentId).toBe('1')
    expect(departments.get('8')?.source.parentid).toBe(0)
    expect(departments.get('2')?.parentId).toBe('1')
    expect(departments.get('7')?.parentId).toBe('2')
  })

  it('rejects a cycle, a self-parent, a duplicate id and an empty list', async () => {
    const cycle = await caught(() => pull(specFor([dept(1, 0), dept(2, 3), dept(3, 2)])))
    expect(cycle).toBeInstanceOf(WeComIncompleteResponseError)
    expect(cycle.location).toBe('department_graph')
    expect((await caught(() => pull(specFor([dept(1, 0), dept(2, 2)])))).location).toBe('department_graph')
    expect((await caught(() => pull(specFor([dept(1, 0), dept(2, 1), dept(2, 1)])))).location).toBe('department_graph')
    expect((await caught(() => pull(specFor([])))).location).toBe('department_list')
  })

  it('synthesizes the root when the list lacks it and never lists its members', async () => {
    const { departments, stub } = await pull(specFor([dept(2, 1), dept(3, 1)], { '2': ok(usersPayload([])), '3': ok(usersPayload([])) }))
    expect(departments.get('1')?.source).toEqual({ syntheticRoot: true, realRoot: false })
    expect(departments.get('2')?.parentId).toBe('1')
    expect(stub.pathsOf('users')).toEqual(['2', '3'])
  })

  const subtree = [dept(1, 0), dept(7, 1), dept(8, 7), dept(9, 8), dept(5, 1), dept(6, 5)]

  it('keeps only the subtree of a root other than 1', async () => {
    const digest = DIGEST_ROOT_ONLY
    const config = { ...CONFIG, rootDepartmentId: '7', scopeDigestAcknowledged: digest }
    const { departments, stub } = await pull(specFor(subtree, { '7': ok(usersPayload([])), '8': ok(usersPayload([])), '9': ok(usersPayload([])) }), config)
    expect([...departments.keys()]).toEqual(['7', '8', '9'])
    expect(departments.get('7')).toEqual({ id: '7', parentId: null, name: 'Acme', order: 0, source: { syntheticRoot: true, realRoot: true } })
    expect(departments.get('8')?.parentId).toBe('7')
    expect(departments.get('9')?.parentId).toBe('8')
    expect(stub.pathsOf('users')).toEqual(['7', '8', '9'])
  })

  it('refuses the round when a root other than 1 is not in the list', async () => {
    const config = { ...CONFIG, rootDepartmentId: '7' }
    const error = await caught(() => pull(specFor([dept(1, 0), dept(2, 1)]), config))
    expect(error).toBeInstanceOf(WeComRootDepartmentNotVisibleError)
  })

  it('accepts 5000 departments and refuses 5001', async () => {
    const make = (count: number) => [dept(1, 0), ...Array.from({ length: count - 1 }, (_, index) => dept(index + 2, 1))]
    const adapterFrom = (count: number) => adapterFor(specFor(make(count))).adapter
    expect((await adapterFrom(5000).fetchDepartments(CONFIG, 'Acme')).size).toBe(5000)
    expect(await caught(() => adapterFrom(5001).fetchDepartments(CONFIG, 'Acme'))).toBeInstanceOf(WeComPullTooLargeError)
  })

  it('accepts 50000 distinct members and refuses 50001', async () => {
    const spec = (count: number): WeComStubSpec => ({ ...baselineSpec(), departments: ok(departmentsPayload([dept(1, 0), dept(2, 1)])), users: { '1': ok(usersPayload([])), '2': ok(usersPayload(manyUsers(count, 'm'))) } })
    const run = async (count: number) => {
      __resetWeComAppAccessTokenCacheForTests()
      const { adapter } = adapterFor(spec(count))
      const departments = await adapter.fetchDepartments(CONFIG, 'Acme')
      return adapter.fetchMembers(CONFIG, departments)
    }
    expect((await run(50_000)).size).toBe(50_000)
    expect(await caught(() => run(50_001))).toBeInstanceOf(WeComPullTooLargeError)
  })
})

describe('WeCom directory adapter: empty departments (FX-13)', () => {
  it('assumes: accepts an empty userlist', async () => {
    const base = baselineSpec()
    const { members } = await pull({ ...base, users: { ...base.users, '3': ok(usersPayload([])) } })
    expect(members.has('carol')).toBe(false)
    expect(members.has('alice')).toBe(true)
  })

  it('assumes: rejects a missing userlist key with an incomplete-response error and returns no map', async () => {
    const base = baselineSpec()
    const { adapter } = adapterFor({ ...base, users: { ...base.users, '3': ok({ errcode: 0, errmsg: 'ok' }) } })
    const departments = await adapter.fetchDepartments(CONFIG, 'Acme')
    const error = await caught(() => adapter.fetchMembers(CONFIG, departments))
    expect(error).toBeInstanceOf(WeComIncompleteResponseError)
    expect(error.location).toBe('user_list')
  })
})

describe('WeCom directory adapter: member status (FX-14)', () => {
  const statusSpec = (statuses: Array<[string, number]>): WeComStubSpec => {
    const base = baselineSpec()
    return {
      ...base,
      users: {
        '1': ok(usersPayload([])),
        '2': ok(usersPayload(statuses.map(([id, status]) => person(id, { status, department: [2], main_department: 2 })))),
        '3': ok(usersPayload([])),
        '4': ok(usersPayload([])),
      },
    }
  }

  it('assumes: does not return members that are disabled (2) or left the company (5)', async () => {
    const { members } = await pull(statusSpec([['active', 1], ['disabled', 2], ['inactive', 4], ['left', 5]]))
    expect([...members.keys()]).toEqual(['active', 'inactive'])
    for (const member of members.values()) expect(member.providerStatus).toBeUndefined()
  })

  it('assumes: returns the same shape when the response carries no such members', async () => {
    const withBoth = await pull(statusSpec([['active', 1], ['disabled', 2], ['inactive', 4], ['left', 5]]))
    const without = await pull(statusSpec([['active', 1], ['inactive', 4]]))
    expect(Object.fromEntries(withBoth.members)).toEqual(Object.fromEntries(without.members))
  })

  it('treats a member without a status as present', async () => {
    const base = baselineSpec()
    const { members } = await pull({ ...base, users: { '1': ok(usersPayload([{ userid: 'nostatus', name: 'N' }])), '2': ok(usersPayload([])), '3': ok(usersPayload([])), '4': ok(usersPayload([])) } })
    expect(members.has('nostatus')).toBe(true)
  })
})

describe('WeCom directory adapter: department order of a member', () => {
  const zed = () => ok(usersPayload([person('zed', { department: [10, 2, 9], main_department: 100, name: 'Zed' })]))
  const spec = (): WeComStubSpec => ({
    ...baselineSpec(),
    departments: ok(departmentsPayload([dept(1, 0), dept(2, 1), dept(9, 1), dept(10, 1), dept(100, 1)])),
    users: { '1': ok(usersPayload([])), '2': zed(), '9': zed(), '10': zed(), '100': ok(usersPayload([])) },
  })

  it('lists members of the departments in numeric order, not string order', async () => {
    const { stub } = await pull(spec())
    expect(stub.pathsOf('users')).toEqual(['1', '2', '9', '10', '100'])
  })

  it('orders the remaining department ids by numeric value', async () => {
    const { members } = await pull(spec())
    expect(members.get('zed')?.departmentIds).toEqual(['2', '9', '10'])
  })

  it('puts main_department first only when it is one of the departments of the member', async () => {
    const inside = await pull({
      ...spec(),
      users: { '1': ok(usersPayload([])), '2': ok(usersPayload([])), '9': ok(usersPayload([])), '10': ok(usersPayload([person('amy', { department: [2, 9, 10], main_department: 10 })])), '100': ok(usersPayload([])) },
    })
    expect(inside.members.get('amy')?.departmentIds).toEqual(['10', '2', '9'])
    const outside = await pull({
      ...spec(),
      users: { '1': ok(usersPayload([])), '2': ok(usersPayload([person('bea', { department: [2, 9], main_department: 100 })])), '9': ok(usersPayload([])), '10': ok(usersPayload([])), '100': ok(usersPayload([])) },
    })
    expect(outside.members.get('bea')?.departmentIds).toEqual(['2', '9'])
  })
})

describe('WeCom directory adapter: member departments outside the round', () => {
  const subtreeSpec = (users: WeComStubSpec['users']): WeComStubSpec => ({
    ...baselineSpec(),
    departments: ok(departmentsPayload([dept(1, 0), dept(7, 1), dept(8, 7), dept(5, 1)])),
    users,
  })
  const subtreeConfig = { ...CONFIG, rootDepartmentId: '7' }

  it('never lets a department of another branch or an unknown department lead', async () => {
    const { members, departments } = await pull(
      subtreeSpec({
        '7': ok(usersPayload([])),
        '8': ok(usersPayload([
          person('amy', { department: [5, 8] }),
          person('bea', { department: [8, 3], main_department: 5 }),
          person('cat', { department: [8, 7, 5], main_department: 7 }),
        ])),
      }),
      subtreeConfig,
    )
    expect([...departments.keys()]).toEqual(['7', '8'])
    expect(members.get('amy')?.departmentIds).toEqual(['8'])
    expect(members.get('bea')?.departmentIds).toEqual(['8'])
    expect(members.get('cat')?.departmentIds).toEqual(['7', '8'])
    for (const member of members.values()) {
      for (const id of member.departmentIds) expect(departments.has(id)).toBe(true)
    }
  })
})

describe('WeCom directory adapter: userid rules apply to the raw value', () => {
  const withVariants = (variants: string[]): WeComStubSpec => ({
    ...baselineSpec(),
    users: {
      '1': ok(usersPayload([])),
      '2': ok(usersPayload([
        ...manyUsers(120, 'valid'),
        person('alice', { department: [2], main_department: 2 }),
        person('key', { department: [2], main_department: 2 }),
        ...variants.map((userid) => person(userid, { department: [2], main_department: 2 })),
      ])),
      '3': ok(usersPayload([person('alice', { department: [3], main_department: 3 })])),
      '4': ok(usersPayload([])),
    },
  })

  it('isolates padded, newline-terminated and case-folding ids instead of merging them into a valid id', async () => {
    const { members } = await pull(withVariants([' alice', 'alice ', 'alice\n', 'alice ', 'Key', 'ａlice']))
    expect(members.size).toBe(122)
    expect(members.get('alice')?.departmentIds).toEqual(['2', '3'])
    expect(members.get('alice')?.source.useridRaw).toBe('alice')
    expect(members.get('key')?.source.useridRaw).toBe('key')
    for (const key of members.keys()) expect(key).toMatch(/^[a-z0-9][a-z0-9_@.-]*$/)
  })

  it('counts each such id toward the threshold', async () => {
    const variants = Array.from({ length: 11 }, (_, index) => `alice${'\n'.repeat(index + 1)}`)
    const refused = await caught(() => pull(withVariants(variants)))
    expect(refused).toBeInstanceOf(WeComMemberShapeViolationError)
    expect(refused.count).toBe(11)
    const tolerated = await pull(withVariants(variants.slice(0, 10)))
    expect(tolerated.members.get('alice')?.departmentIds).toEqual(['2', '3'])
  })

  it('accepts an upper-case id and merges it with its lower-case form', async () => {
    const { members } = await pull(withVariants(['Key']))
    expect(members.get('key')?.source.useridRaw).toBe('key')
    expect(members.size).toBe(122)
  })

  it('exposes only the count on a shape violation', async () => {
    const bad = Array.from({ length: 12 }, (_, index) => `bad/${index}`)
    const error = await caught(() => pull(withVariants(bad)))
    expect(error).toBeInstanceOf(WeComMemberShapeViolationError)
    expect(Object.keys(error).filter((key) => key !== 'name')).toEqual(['count'])
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain('bad/')
    expect(error.cause).toBeUndefined()
  })
})

describe('WeCom directory adapter: deployment environment', () => {
  it('sends every request to the deployment base URL', async () => {
    process.env.WECOM_BASE_URL = 'https://gateway.example.test/'
    const { stub } = await pull(baselineSpec())
    expect(stub.requests.length).toBeGreaterThan(0)
    expect(new Set(stub.requests.map((request) => request.origin))).toEqual(new Set(['https://gateway.example.test']))
  })

  it('uses the default host when no base URL is set', async () => {
    const { stub } = await pull(baselineSpec())
    expect(new Set(stub.requests.map((request) => request.origin))).toEqual(new Set(['https://qyapi.weixin.qq.com']))
  })

  it('takes credentials only from the configuration, never from WECOM_CORP_* variables', async () => {
    process.env.WECOM_CORP_ID = 'envcorp'
    process.env.WECOM_CORP_SECRET = 'env-secret'
    process.env.WECOM_AGENT_ID = '999'
    for (const [override, field] of [
      [{ corpSecret: '' }, 'corpSecret'],
      [{ corpId: '' }, 'corpId'],
      [{ wecomAgentId: '' }, 'wecomAgentId'],
    ] as const) {
      const { adapter, stub } = adapterFor(baselineSpec())
      const error = await caught(() => adapter.fetchDepartments({ ...CONFIG, ...override }, 'Acme'))
      expect(error).toBeInstanceOf(WeComInvalidInputError)
      expect(error.field).toBe(field)
      expect(stub.requests).toHaveLength(0)
    }
  })

  it('reads no environment variable in the adapter modules', () => {
    for (const file of ['wecom-directory-adapter.ts', 'wecom-directory-errors.ts']) {
      expect(fs.readFileSync(path.resolve(HERE, '../../src/directory/adapters', file), 'utf8')).not.toContain('process.env')
    }
  })
})
