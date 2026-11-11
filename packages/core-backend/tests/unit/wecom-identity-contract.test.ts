import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildWeComExternalKey,
  createWeComIdentityAdapter,
  normalizeWeComSubjectKey,
  WECOM_IDENTITY_ADAPTER_REV,
  WECOM_IDENTITY_ASSURANCE,
  type WeComIdentityResult,
} from '../../src/auth/external/wecom-identity-adapter'
import { SECURITY_ACTION_ASSURANCE_LEVELS } from '../../src/auth/external-login-assurance'
import { __resetWeComAppAccessTokenCacheForTests, type WeComRequestOptions } from '../../src/integrations/wecom/client'
import {
  WECOM_FIXTURE_AGENT_ID,
  WECOM_FIXTURE_CORP_ID,
  WECOM_FIXTURE_SECRET,
  createWeComFetchStub,
  errcodeReply,
  memberPayload,
  nonMemberPayload,
  ok,
  userinfoPayload,
  type WeComStubSpec,
} from '../fixtures/directory/wecom/wecom-fixtures'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ADAPTER_SOURCE = path.resolve(HERE, '../../src/auth/external/wecom-identity-adapter.ts')
const REAL_FETCH = globalThis.fetch

const CONNECTION = { id: 'integration-1', corpId: WECOM_FIXTURE_CORP_ID, wecomAgentId: WECOM_FIXTURE_AGENT_ID }
const CREDENTIALS = { corpSecret: WECOM_FIXTURE_SECRET }
const REDIRECT = 'https://app.example.test/auth/wecom/callback'
const CONTACT_CANARIES = [
  'fixture-name-canary',
  '13800000000',
  'canary@fixture.example.test',
  'canary.png',
  'fixture-position-canary',
  'department',
  'mobile',
  'email',
  'avatar',
]

function requestOptionsFor(spec: WeComStubSpec): WeComRequestOptions {
  return { fetchFn: createWeComFetchStub(spec).fetchFn, sleep: async () => undefined, random: () => 0 }
}

function resolve(spec: WeComStubSpec, adapterOptions: { allowLoopbackHttp?: boolean } = {}): Promise<WeComIdentityResult> {
  const adapter = createWeComIdentityAdapter({ redirectUri: REDIRECT, requestOptions: requestOptionsFor(spec), ...adapterOptions })
  return adapter.exchangeCode({ connection: CONNECTION, credentials: CREDENTIALS, code: 'fixture-login-code' })
}

beforeEach(() => {
  __resetWeComAppAccessTokenCacheForTests()
  globalThis.fetch = (() => { throw new Error('real network is not available in this test') }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = REAL_FETCH
  vi.restoreAllMocks()
})

describe('WeCom identity contract: assurance', () => {
  it('starts at unknown and pins the adapter revision', () => {
    expect(WECOM_IDENTITY_ASSURANCE).toBe('unknown')
    expect(Number.isInteger(WECOM_IDENTITY_ADAPTER_REV)).toBe(true)
    expect(WECOM_IDENTITY_ADAPTER_REV).toBe(1)
  })

  it('states the constant for every factory option combination, with no override path', () => {
    const requestOptionChoices: Array<WeComRequestOptions | undefined> = [undefined, {}, { timeoutMs: 1 }]
    for (const requestOptions of requestOptionChoices) {
      for (const allowLoopbackHttp of [undefined, true, false]) {
        const hostile = {
          redirectUri: REDIRECT,
          requestOptions,
          allowLoopbackHttp,
          assurance: 'external_platform_asserted',
          adapterRev: 99,
        }
        const adapter = createWeComIdentityAdapter(hostile)
        expect(adapter.assurance).toBe(WECOM_IDENTITY_ASSURANCE)
        expect(adapter.adapterRev).toBe(WECOM_IDENTITY_ADAPTER_REV)
      }
    }
  })

  it('leaves the shared assurance levels without an unknown level and without a runtime import', () => {
    expect([...SECURITY_ACTION_ASSURANCE_LEVELS]).toEqual(['local_password', 'external_platform_asserted'])
    const source = fs.readFileSync(ADAPTER_SOURCE, 'utf8')
    expect(source).not.toContain('external-login-assurance')
    expect(source).not.toMatch(/SECURITY_ACTION_/)
  })

  it('does not place the assurance or the revision on a resolved subject', async () => {
    const result = await resolve({ userinfo: ok(userinfoPayload()), member: ok(memberPayload()) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(JSON.stringify(result)).not.toMatch(/assurance|adapterRev|unknown/i)
  })
})

describe('WeCom identity contract: subject', () => {
  it('has exactly the eight subject fields with the configured scope', async () => {
    const result = await resolve({ userinfo: ok(userinfoPayload({}, 'Zhang.San')), member: ok(memberPayload('Zhang.San')) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result).sort()).toEqual(['ok', 'subject'])
    expect(Object.keys(result.subject).sort()).toEqual([
      'appScope',
      'connectionId',
      'memberVerification',
      'provider',
      'providerUserId',
      'subjectKey',
      'subjectType',
      'tenant',
    ])
    expect(result.subject.provider).toBe('wecom')
    expect(result.subject.subjectType).toBe('wecom_userid')
    expect(result.subject.tenant).toBe(CONNECTION.corpId)
    expect(result.subject.appScope).toBe(CONNECTION.wecomAgentId)
    expect(result.subject.connectionId).toBe(CONNECTION.id)
    expect(result.subject.memberVerification).toBe('online_verified')
    expect(result.subject.providerUserId).toBe('Zhang.San')
    expect(result.subject.subjectKey).toBe('zhang.san')
  })

  it('never carries the contact fields of the member record, in a subject or in any result', async () => {
    const specs: WeComStubSpec[] = [
      { userinfo: ok(userinfoPayload()), member: ok(memberPayload('Zhang.San', 1)) },
      { userinfo: ok(userinfoPayload()), member: ok(memberPayload('Zhang.San', 2)) },
      { userinfo: ok(userinfoPayload()), member: ok(memberPayload('Other.Person', 1)) },
      { userinfo: ok(userinfoPayload()), member: errcodeReply(60011) },
      { userinfo: ok(nonMemberPayload()), member: ok(memberPayload()) },
    ]
    for (const spec of specs) {
      const text = JSON.stringify(await resolve(spec))
      for (const canary of CONTACT_CANARIES) expect(text).not.toContain(canary)
    }
  })

  it('never turns an openid or external id into a subject', async () => {
    for (const payload of [nonMemberPayload(), { errcode: 0, openid: 'fixture-openid-canary' }, { errcode: 0, external_userid: 'fixture-external-canary' }]) {
      const result = await resolve({ userinfo: ok(payload), member: ok(memberPayload('fixture-openid-canary')) })
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toMatch(/canary/)
    }
  })
})

describe('WeCom identity contract: external key', () => {
  it('is the JSON array of corp id and lower-cased userid', () => {
    expect(buildWeComExternalKey('corpA', 'Zed')).toBe('["corpA","zed"]')
  })

  it('differs for the same userid in two corporations', () => {
    expect(buildWeComExternalKey('corpA', 'zhangsan')).not.toBe(buildWeComExternalKey('corpB', 'zhangsan'))
  })

  it('collapses case variants of one userid', () => {
    expect(buildWeComExternalKey('corpA', 'Zhang.San')).toBe(buildWeComExternalKey('corpA', 'zHANG.sAN'))
    expect(buildWeComExternalKey('corpA', 'Zhang.San')).toBe(JSON.stringify(['corpA', normalizeWeComSubjectKey('Zhang.San')]))
  })

  it('stays injective for corp ids holding a colon or a quote', () => {
    const keys = [
      buildWeComExternalKey('a:b', 'c'),
      buildWeComExternalKey('a', 'c'),
      buildWeComExternalKey('a:', 'bc'),
      buildWeComExternalKey('a"b', 'c'),
      buildWeComExternalKey('a","b', 'c'),
      buildWeComExternalKey('a\\', 'c'),
    ]
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(JSON.parse(key)).toHaveLength(2)
    expect(JSON.parse(buildWeComExternalKey('a","b', 'c'))).toEqual(['a","b', 'c'])
  })

  it('rejects an invalid userid or corp id', () => {
    expect(() => buildWeComExternalKey('corpA', 'corp/zhangsan')).toThrow()
    expect(() => buildWeComExternalKey('', 'zed')).toThrow()
    expect(() => buildWeComExternalKey('corp A', 'zed')).toThrow()
  })
})
