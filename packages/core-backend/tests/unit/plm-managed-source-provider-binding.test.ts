import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import { HTTPAdapter } from '../../src/data-adapters/HTTPAdapter'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import {
  DEFAULT_ADAPTER_REGISTRY,
  MANAGED_PLM_SOURCE_PROVIDER_MISMATCH_CODE,
  MANAGED_PLM_SOURCE_PROVIDER_MISMATCH_MESSAGE,
} from '../../src/data-adapters/DataSourceManager'

// Guard-level checks only. Superclass connect and capability lookup are resolved spies, so a
// refusal is "inherited method not called" and an allowance is "inherited method called once".
// No HTTP client, token exchange, or network.

const SOURCE_B = 'https://b.example/plm'
const PLM_ENV_KEYS = [
  'PLM_BASE_URL',
  'PLM_URL',
  'PLM_API_MODE',
  'PLM_TENANT_ID',
  'PLM_ORG_ID',
  'PLM_USERNAME',
  'PLM_PASSWORD',
  'PLM_API_TOKEN',
  'PLM_AUTH_TOKEN',
  'PLM_TOKEN',
  'PLM_API_KEY',
  'PLM_KEY',
  'PLM_ITEM_TYPE',
] as const

const SUPERCLASS_CAPABILITIES = {
  available: true as const,
  manifest: {
    schema_version: 'v1',
    provider: 'yuantus-plm',
    advisory: true,
    features: {},
  },
}

const ManagedPlm = DEFAULT_ADAPTER_REGISTRY.plm
const savedEnv: Record<string, string | undefined> = {}
let connectSpy: MockInstance
let capabilitiesSpy: MockInstance

interface SourceInput {
  apiMode?: unknown
  url?: unknown
  baseURL?: unknown
  headers?: unknown
  tenantId?: unknown
  orgId?: unknown
}

function plmSource(input: SourceInput = {}): DataSourceConfig {
  const has = (key: keyof SourceInput) => Object.prototype.hasOwnProperty.call(input, key)
  const options: Record<string, unknown> = {}
  const apiMode = has('apiMode') ? input.apiMode : 'yuantus'
  if (apiMode !== undefined) options.apiMode = apiMode
  const tenantId = has('tenantId') ? input.tenantId : 'tenant-b'
  if (tenantId !== undefined) options.tenantId = tenantId
  const orgId = has('orgId') ? input.orgId : 'org-b'
  if (orgId !== undefined) options.orgId = orgId

  const connection: Record<string, unknown> = {}
  const url = has('url') ? input.url : SOURCE_B
  if (url !== undefined) connection.url = url
  if (has('baseURL') && input.baseURL !== undefined) connection.baseURL = input.baseURL
  if (has('headers')) {
    if (input.headers !== undefined) connection.headers = input.headers
  } else {
    connection.headers = { 'x-tenant-id': 'tenant-b', 'x-org-id': 'org-b' }
  }

  return {
    id: 'source-b',
    name: 'Source B',
    type: 'plm',
    connection,
    options,
  } as DataSourceConfig
}

function managed(config: DataSourceConfig) {
  return new ManagedPlm(config)
}

function yuantusEnv(url = SOURCE_B): void {
  process.env.PLM_BASE_URL = url
  process.env.PLM_API_MODE = 'yuantus'
}

async function expectRefused(adapter: {
  connect(): Promise<unknown>
  getIntegrationCapabilities(): Promise<unknown>
  getConfig(): DataSourceConfig
}): Promise<void> {
  const beforeUrl = adapter.getConfig().connection.url
  const beforeBase = adapter.getConfig().connection.baseURL
  const error = await adapter.connect().then(() => {
    throw new Error('connect was allowed')
  }, (caught: unknown) => caught)
  expect(error).toMatchObject({
    message: MANAGED_PLM_SOURCE_PROVIDER_MISMATCH_MESSAGE,
    code: MANAGED_PLM_SOURCE_PROVIDER_MISMATCH_CODE,
    status: 503,
  })
  const message = error instanceof Error ? error.message : ''
  expect(message).not.toContain('example')
  expect(message).not.toContain('tenant')
  expect(message).not.toContain('pw-')
  expect(connectSpy).not.toHaveBeenCalled()
  expect(adapter.getConfig().connection.url).toBe(beforeUrl)
  expect(adapter.getConfig().connection.baseURL).toBe(beforeBase)
  await expect(adapter.getIntegrationCapabilities()).resolves.toEqual({
    available: false,
    reason: 'unavailable',
  })
  expect(capabilitiesSpy).not.toHaveBeenCalled()
}

async function expectAllowed(adapter: { connect(): Promise<unknown>; getIntegrationCapabilities(): Promise<unknown> }): Promise<void> {
  await expect(adapter.connect()).resolves.toBeUndefined()
  expect(connectSpy).toHaveBeenCalledTimes(1)
  await expect(adapter.getIntegrationCapabilities()).resolves.toEqual(SUPERCLASS_CAPABILITIES)
  expect(capabilitiesSpy).toHaveBeenCalledTimes(1)
}

describe('managed Yuantus source/provider binding', () => {
  beforeEach(() => {
    for (const key of PLM_ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    connectSpy = vi.spyOn(PLMAdapter.prototype, 'connect').mockResolvedValue(undefined)
    capabilitiesSpy = vi.spyOn(PLMAdapter.prototype, 'getIntegrationCapabilities').mockResolvedValue(SUPERCLASS_CAPABILITIES)
  })

  afterEach(() => {
    for (const key of PLM_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    vi.restoreAllMocks()
  })

  it('the registry plm class is the PLMAdapter subclass under test', () => {
    const adapter = managed(plmSource())
    expect(adapter).toBeInstanceOf(PLMAdapter)
    expect(Object.getPrototypeOf(adapter).constructor).toBe(ManagedPlm)
  })

  describe('explicit source refuses before superclass connect or capabilities', () => {
    const cases: Array<[string, () => DataSourceConfig]> = [
      ['origin A against source B', () => {
        yuantusEnv('https://a.example/plm')
        return plmSource()
      }],
      ['same-origin base path mismatch', () => {
        yuantusEnv('https://b.example/other')
        return plmSource()
      }],
      ['trailing path slash is a different base', () => {
        yuantusEnv(`${SOURCE_B}/`)
        return plmSource()
      }],
      ['global tenant conflicts', () => {
        yuantusEnv()
        process.env.PLM_TENANT_ID = 'tenant-a'
        return plmSource()
      }],
      ['global org conflicts', () => {
        yuantusEnv()
        process.env.PLM_ORG_ID = 'org-a'
        return plmSource()
      }],
      ['header aliases disagree', () => {
        yuantusEnv()
        return plmSource({
          headers: { 'x-tenant-id': 'tenant-b', 'X-Tenant-Id': 'tenant-a', 'x-org-id': 'org-b' },
        })
      }],
      ['header and option disagree', () => {
        yuantusEnv()
        return plmSource({ tenantId: 'tenant-a' })
      }],
      ['empty header alias is not ignored', () => {
        yuantusEnv()
        return plmSource({
          headers: { 'x-tenant-id': 'tenant-b', 'X-Tenant-Id': '', 'x-org-id': 'org-b' },
        })
      }],
      ['non-string option alias is not ignored', () => {
        yuantusEnv()
        return plmSource({ tenantId: 7 })
      }],
      ['whitespace-only scope is not accepted', () => {
        yuantusEnv()
        return plmSource({
          headers: { 'x-tenant-id': '   ', 'x-org-id': 'org-b' },
          tenantId: '   ',
        })
      }],
      ['missing org', () => {
        yuantusEnv()
        return plmSource({ headers: { 'x-tenant-id': 'tenant-b' }, orgId: undefined })
      }],
      ['malformed header container is not ignored', () => {
        yuantusEnv()
        return plmSource({ headers: null })
      }],
      ['login A with source headers B', () => {
        yuantusEnv()
        process.env.PLM_USERNAME = 'user-a'
        process.env.PLM_PASSWORD = 'pw-a'
        process.env.PLM_TENANT_ID = 'tenant-a'
        process.env.PLM_ORG_ID = 'org-a'
        return plmSource()
      }],
      ['username/password with no global login scope', () => {
        yuantusEnv()
        process.env.PLM_USERNAME = 'user-a'
        process.env.PLM_PASSWORD = 'pw-a'
        return plmSource()
      }],
      ['username/password with only tenant set', () => {
        yuantusEnv()
        process.env.PLM_USERNAME = 'user-b'
        process.env.PLM_PASSWORD = 'pw-b'
        process.env.PLM_TENANT_ID = 'tenant-b'
        return plmSource()
      }],
      ['explicit legacy mode', () => {
        yuantusEnv()
        process.env.PLM_API_MODE = 'legacy'
        process.env.PLM_TENANT_ID = 'tenant-b'
        process.env.PLM_ORG_ID = 'org-b'
        return plmSource()
      }],
      ['explicit v0 mode', () => {
        yuantusEnv()
        process.env.PLM_API_MODE = 'v0'
        return plmSource()
      }],
      ['unknown mode stays legacy without exact scope keys', () => {
        process.env.PLM_BASE_URL = SOURCE_B
        process.env.PLM_API_MODE = 'not-a-known-mode'
        return plmSource({
          headers: { 'X-Tenant-Id': 'tenant-b', 'X-Org-Id': 'org-b' },
          tenantId: undefined,
          orgId: undefined,
        })
      }],
      ['missing global URL', () => {
        process.env.PLM_API_MODE = 'yuantus'
        return plmSource()
      }],
      ['source has no URL', () => {
        yuantusEnv()
        return plmSource({ url: undefined })
      }],
      ['PLM_BASE_URL wins over a matching PLM_URL', () => {
        process.env.PLM_BASE_URL = 'https://a.example/plm'
        process.env.PLM_URL = SOURCE_B
        process.env.PLM_API_MODE = 'yuantus'
        return plmSource()
      }],
      ['url and baseURL disagree', () => {
        yuantusEnv()
        return plmSource({ baseURL: 'https://b.example/other' })
      }],
      ['userinfo URL', () => {
        const dirty = 'https://user:pw-secret@b.example/plm'
        process.env.PLM_BASE_URL = dirty
        process.env.PLM_API_MODE = 'yuantus'
        return plmSource({ url: dirty })
      }],
      ['query URL', () => {
        const dirty = 'https://b.example/plm?x=1'
        process.env.PLM_BASE_URL = dirty
        process.env.PLM_API_MODE = 'yuantus'
        return plmSource({ url: dirty })
      }],
      ['fragment URL', () => {
        const dirty = 'https://b.example/plm#frag'
        process.env.PLM_BASE_URL = dirty
        process.env.PLM_API_MODE = 'yuantus'
        return plmSource({ url: dirty })
      }],
      ['invalid URL', () => {
        process.env.PLM_BASE_URL = 'not a url'
        process.env.PLM_API_MODE = 'yuantus'
        return plmSource({ url: 'not a url' })
      }],
      ['non-http URL', () => {
        process.env.PLM_BASE_URL = 'ftp://b.example/plm'
        process.env.PLM_API_MODE = 'yuantus'
        return plmSource({ url: 'ftp://b.example/plm' })
      }],
      ['mixed-case Yuantus source is still bound', () => {
        yuantusEnv('https://a.example/plm')
        return plmSource({ apiMode: 'YuAnTuS' })
      }],
      ['source v1 with no global URL', () => {
        process.env.PLM_API_MODE = 'yuantus'
        return plmSource({ apiMode: 'v1' })
      }],
    ]

    it.each(cases)('%s', async (_name, build) => {
      await expectRefused(managed(build()))
    })
  })

  describe('matching explicit source calls superclass unchanged', () => {
    const cases: Array<[string, () => DataSourceConfig]> = [
      ['exact base, mode, and scope', () => {
        yuantusEnv()
        return plmSource()
      }],
      ['PLM_URL and v1 aliases with token-only scope', () => {
        process.env.PLM_URL = SOURCE_B
        process.env.PLM_API_MODE = 'v1'
        process.env.PLM_TOKEN = 'tok-b'
        return plmSource({ apiMode: 'Yuantus' })
      }],
      ['source v1 with V1 env mode', () => {
        process.env.PLM_URL = SOURCE_B
        process.env.PLM_API_MODE = 'V1'
        return plmSource({ apiMode: 'v1', url: undefined, baseURL: SOURCE_B })
      }],
      ['http base is accepted', () => {
        yuantusEnv('http://b.example/plm')
        return plmSource({ url: 'http://b.example/plm' })
      }],
      ['default https port canonicalizes', () => {
        yuantusEnv('https://b.example:443/plm')
        return plmSource()
      }],
      ['url and baseURL canonical-equal', () => {
        yuantusEnv()
        return plmSource({ baseURL: 'HTTPS://B.example/plm' })
      }],
      ['mixed-case headers agree with options', () => {
        yuantusEnv()
        return plmSource({
          headers: {
            'X-Tenant-Id': 'tenant-b',
            'x-tenant-id': 'tenant-b',
            'X-Org-Id': 'org-b',
            'x-org-id': 'org-b',
          },
        })
      }],
      ['options-only scope', () => {
        yuantusEnv()
        return plmSource({ headers: undefined })
      }],
      ['unknown mode resolves yuantus from option scope', () => {
        process.env.PLM_BASE_URL = SOURCE_B
        process.env.PLM_API_MODE = 'not-a-known-mode'
        return plmSource()
      }],
      ['untrimmed unknown mode is not treated as legacy', () => {
        process.env.PLM_BASE_URL = SOURCE_B
        process.env.PLM_API_MODE = ' legacy'
        return plmSource()
      }],
      ['login tenant and org explicitly match', () => {
        yuantusEnv()
        process.env.PLM_USERNAME = 'user-b'
        process.env.PLM_PASSWORD = 'pw-b'
        process.env.PLM_TENANT_ID = 'tenant-b'
        process.env.PLM_ORG_ID = 'org-b'
        return plmSource()
      }],
      ['present matching org and absent tenant without login', () => {
        yuantusEnv()
        process.env.PLM_ORG_ID = 'org-b'
        return plmSource()
      }],
      ['password without username does not force login scope', () => {
        yuantusEnv()
        process.env.PLM_PASSWORD = 'pw-b'
        return plmSource()
      }],
    ]

    it.each(cases)('%s', async (_name, build) => {
      await expectAllowed(managed(build()))
    })
  })

  describe('unbound legacy and default sources stay on the superclass', () => {
    const cases: Array<[string, () => DataSourceConfig]> = [
      ['legacy apiMode with a different global origin', () => {
        yuantusEnv('https://a.example/plm')
        process.env.PLM_API_MODE = 'legacy'
        return plmSource({ apiMode: 'legacy' })
      }],
      ['omitted apiMode and no URL', () => {
        return plmSource({
          apiMode: undefined,
          url: undefined,
          headers: undefined,
          tenantId: undefined,
          orgId: undefined,
        })
      }],
      ['spaced v1 is not an explicit yuantus source', () => {
        yuantusEnv('https://a.example/plm')
        return plmSource({ apiMode: 'v1 ' })
      }],
      ['v0 source mode is not bound', () => {
        yuantusEnv('https://a.example/plm')
        return plmSource({ apiMode: 'v0' })
      }],
      ['header scope without explicit apiMode is not bound', () => {
        yuantusEnv('https://a.example/other')
        return plmSource({ apiMode: undefined })
      }],
    ]

    it.each(cases)('%s', async (_name, build) => {
      await expectAllowed(managed(build()))
    })
  })

  describe('raw base and exact scope boundaries', () => {
    function sameBase(url: string): DataSourceConfig {
      process.env.PLM_BASE_URL = url
      process.env.PLM_API_MODE = 'yuantus'
      return plmSource({ url })
    }

    const refusals: Array<[string, () => DataSourceConfig]> = [
      ['env trailing space matches the parsed source base', () => {
        yuantusEnv(`${SOURCE_B} `)
        return plmSource()
      }],
      ['the same trailing space is on the source and the env', () => sameBase(`${SOURCE_B} `)],
      ['the same empty query delimiter is on the source and the env', () => sameBase(`${SOURCE_B}?`)],
      ['the same empty fragment delimiter is on the source and the env', () => sameBase(`${SOURCE_B}#`)],
      ['the same ASCII control is on the source and the env', () => sameBase('https://b.example/pl\u0001m')],
      ['the same DEL is on the source and the env', () => sameBase(`${SOURCE_B}\u007f`)],
      ['empty url is kept ahead of a valid baseURL', () => {
        yuantusEnv()
        return plmSource({ url: '', baseURL: SOURCE_B })
      }],
      ['null url is kept ahead of a valid baseURL', () => {
        yuantusEnv()
        return plmSource({ url: null, baseURL: SOURCE_B })
      }],
      ['empty baseURL is present beside a valid url', () => {
        yuantusEnv()
        return plmSource({ baseURL: '' })
      }],
      ['null baseURL is present beside a valid url', () => {
        yuantusEnv()
        return plmSource({ baseURL: null })
      }],
      ['empty tenant alias beside a valid peer', () => {
        yuantusEnv()
        return plmSource({
          headers: { 'x-tenant-id': 'tenant-b', 'X-Tenant-Id': '', 'x-org-id': 'org-b' },
        })
      }],
      ['the same padded tenant is not an exact token', () => {
        yuantusEnv()
        return plmSource({
          headers: { 'x-tenant-id': 'tenant-b ', 'x-org-id': 'org-b' },
          tenantId: 'tenant-b ',
        })
      }],
      ['the same control-bearing tenant is not an exact token', () => {
        yuantusEnv()
        return plmSource({
          headers: { 'x-tenant-id': 'tenant-b\u0001', 'x-org-id': 'org-b' },
          tenantId: 'tenant-b\u0001',
        })
      }],
      ['unicode normalization is not scope identity', () => {
        yuantusEnv()
        return plmSource({
          headers: { 'x-tenant-id': '\u00e9', 'X-Tenant-Id': 'e\u0301', 'x-org-id': 'org-b' },
          tenantId: undefined,
        })
      }],
    ]

    const allowances: Array<[string, () => DataSourceConfig]> = [
      ['percent-encoded question mark stays in the path', () => sameBase('https://b.example/plm%3Fkept')],
      ['percent-encoded number sign stays in the path', () => sameBase('https://b.example/plm%23kept')],
      ['a unicode tenant and org match as exact raw strings', () => {
        yuantusEnv()
        return plmSource({
          headers: { 'x-tenant-id': '租户-β', 'x-org-id': '组织-β' },
          tenantId: '租户-β',
          orgId: '组织-β',
        })
      }],
    ]

    it.each(refusals)('%s', async (_name, build) => {
      await expectRefused(managed(build()))
    })

    it.each(allowances)('%s', async (_name, build) => {
      await expectAllowed(managed(build()))
    })
  })

  it('capabilities and refresh refuse before a cached or mock superclass result, without connecting', async () => {
    process.env.PLM_API_MODE = 'yuantus'
    const adapter = managed(plmSource())
    await expect(adapter.getIntegrationCapabilities()).resolves.toEqual({
      available: false,
      reason: 'unavailable',
    })
    expect(capabilitiesSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
    await expect(adapter.refreshIntegrationCapabilities()).resolves.toBeUndefined()
    expect(capabilitiesSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('a matched source returns the superclass capability result and does not connect by itself', async () => {
    yuantusEnv()
    const adapter = managed(plmSource())
    await expect(adapter.getIntegrationCapabilities()).resolves.toBe(SUPERCLASS_CAPABILITIES)
    expect(capabilitiesSpy).toHaveBeenCalledTimes(1)
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('reconnect keeps the construction snapshot after superclass overwrites the live config', async () => {
    const mutated = 'https://a.example/global-a'
    yuantusEnv()
    connectSpy.mockImplementation(async function (this: PLMAdapter) {
      const config = this.getConfig()
      const connection = config.connection
      connection.url = mutated
      connection.baseURL = mutated
      const headers = connection.headers as Record<string, string>
      headers['x-tenant-id'] = 'tenant-a'
      headers['x-org-id'] = 'org-a'
      config.options!.apiMode = 'legacy'
      config.options!.tenantId = 'tenant-a'
      config.options!.orgId = 'org-a'
    })
    const adapter = managed(plmSource())

    await expect(adapter.connect()).resolves.toBeUndefined()
    expect(adapter.getConfig().connection.url).toBe(mutated)
    expect(adapter.getConfig().connection.baseURL).toBe(mutated)
    expect(adapter.getConfig().connection.headers).toMatchObject({ 'x-tenant-id': 'tenant-a', 'x-org-id': 'org-a' })
    expect(adapter.getConfig().options?.apiMode).toBe('legacy')
    expect(connectSpy).toHaveBeenCalledTimes(1)

    // Live config is now A/legacy while env and the declaration snapshot remain B/yuantus.
    await expect(adapter.connect()).resolves.toBeUndefined()
    expect(connectSpy).toHaveBeenCalledTimes(2)

    // Env now matches the overwritten live config. Comparing that config to itself would allow.
    process.env.PLM_BASE_URL = mutated
    const error = await adapter.connect().then(() => {
      throw new Error('reconnect was allowed')
    }, (caught: unknown) => caught)
    expect(error).toMatchObject({
      code: MANAGED_PLM_SOURCE_PROVIDER_MISMATCH_CODE,
      message: MANAGED_PLM_SOURCE_PROVIDER_MISMATCH_MESSAGE,
    })
    expect(connectSpy).toHaveBeenCalledTimes(2)
  })

  it('ordinary PLMAdapter configService precedence stays ahead of env and the source', async () => {
    connectSpy.mockRestore()
    capabilitiesSpy.mockRestore()
    const httpConnect = vi.spyOn(HTTPAdapter.prototype, 'connect').mockResolvedValue(undefined)
    const refresh = vi.spyOn(PLMAdapter.prototype, 'refreshIntegrationCapabilities').mockResolvedValue(undefined)
    const globalUrl = 'https://global-a.example/plm'
    process.env.PLM_BASE_URL = 'https://env.example/plm'
    process.env.PLM_TENANT_ID = 'tenant-env'
    process.env.PLM_ORG_ID = 'org-env'
    const get = vi.fn(async (key: string) => {
      if (key === 'plm.url') return globalUrl
      if (key === 'plm.tenantId') return 'tenant-a'
      if (key === 'plm.orgId') return 'org-a'
      if (key === 'plm.apiMode') return 'yuantus'
      return undefined
    })
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const adapter = new PLMAdapter({ get } as never, logger as never, plmSource({
      url: 'https://source-b.example/other',
      headers: undefined,
      tenantId: 'tenant-b',
      orgId: 'org-b',
      apiMode: 'yuantus',
    }))

    await adapter.connect()

    expect(adapter.getConfig().connection.url).toBe(globalUrl)
    expect(adapter.getConfig().connection.baseURL).toBe(globalUrl)
    expect(adapter.getEffectiveTenantId()).toBe('tenant-a')
    expect(adapter.getEffectiveOrgId()).toBe('org-a')
    expect(httpConnect).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
