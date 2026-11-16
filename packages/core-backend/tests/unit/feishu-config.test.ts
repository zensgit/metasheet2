/**
 * Feishu connection configuration, scope anchor and typed identifiers.
 */
import { describe, expect, it } from 'vitest'
import {
  FEISHU_DEFAULT_PAGE_SIZE,
  assertFeishuIdForConnection,
  feishuIdRef,
  feishuScopeOf,
  parseFeishuConfig,
  resolveFeishuAppSecret,
} from '../../src/integrations/feishu/config'
import {
  FEISHU_BRANDS,
  FEISHU_ENDPOINTS,
  feishuEndpointUrl,
  isFeishuBrand,
} from '../../src/integrations/feishu/endpoints'
import { FeishuIdConnectionMismatchError, FeishuIdRefError } from '../../src/integrations/feishu/errors'

const VALID = { appId: 'cli_fx_0001', appSecret: 'enc:fixture', brand: 'feishu' }

describe('Feishu brand and endpoints', () => {
  it('the brand set is closed to feishu', () => {
    expect([...FEISHU_BRANDS]).toEqual(['feishu'])
    expect(isFeishuBrand('feishu')).toBe(true)
    for (const other of ['lark', 'Feishu', 'FEISHU', ' feishu', '', undefined, null, 1]) expect(isFeishuBrand(other)).toBe(false)
  })

  it('builds endpoint URLs from the frozen table', () => {
    expect(feishuEndpointUrl('feishu', FEISHU_ENDPOINTS.tenantAccessToken)).toBe('https://accounts.feishu.cn/oauth/v3/token')
    expect(feishuEndpointUrl('feishu', FEISHU_ENDPOINTS.tenantQuery)).toBe('https://open.feishu.cn/open-apis/tenant/v2/tenant/query')
    expect(Object.isFrozen(FEISHU_ENDPOINTS)).toBe(true)
  })
})

describe('parseFeishuConfig', () => {
  it('accepts a complete configuration and applies the defaults', () => {
    const parsed = parseFeishuConfig({ ...VALID, appId: '  cli_fx_0001  ', appSecret: '  enc:fixture ' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok === false) throw new Error('unreachable')
    expect(parsed.settings).toEqual({
      appId: 'cli_fx_0001',
      brand: 'feishu',
      rootDepartmentId: '0',
      pageSize: FEISHU_DEFAULT_PAGE_SIZE,
      storedAppSecret: 'enc:fixture',
    })
    expect(Object.isFrozen(parsed.settings)).toBe(true)
  })

  it('treats an absent brand as feishu and ignores unrelated keys', () => {
    const parsed = parseFeishuConfig({ appId: 'cli_fx_0001', appSecret: 'x', admissionMode: 'manual', excludeDepartmentIds: ['1'] })
    expect(parsed.ok).toBe(true)
  })

  const refusals: Array<[string, unknown, string]> = [
    ['not an object', 'text', 'config_not_object'],
    ['an array', [], 'config_not_object'],
    ['null', null, 'config_not_object'],
    ['a missing application id', { appSecret: 'x' }, 'app_id_invalid'],
    ['a blank application id', { appId: '   ', appSecret: 'x' }, 'app_id_invalid'],
    ['an application id with a space', { appId: 'cli fx', appSecret: 'x' }, 'app_id_invalid'],
    ['an application id with a control character', { appId: 'cli\u0007fx', appSecret: 'x' }, 'app_id_invalid'],
    ['a non-ASCII application id', { appId: 'cli_飞书', appSecret: 'x' }, 'app_id_invalid'],
    ['an application id of 129 characters', { appId: 'a'.repeat(129), appSecret: 'x' }, 'app_id_invalid'],
    ['a missing secret', { appId: 'cli_fx_0001' }, 'app_secret_missing'],
    ['a blank secret', { appId: 'cli_fx_0001', appSecret: '  ' }, 'app_secret_missing'],
    ['a non-string secret', { appId: 'cli_fx_0001', appSecret: 12 }, 'app_secret_missing'],
    ['another brand', { ...VALID, brand: 'lark' }, 'brand_invalid'],
    ['a brand in another case', { ...VALID, brand: 'Feishu' }, 'brand_invalid'],
    ['a null brand', { ...VALID, brand: null }, 'brand_invalid'],
    ['a root department other than 0', { ...VALID, rootDepartmentId: 'od-fx-0001' }, 'root_department_invalid'],
    ['a numeric root department', { ...VALID, rootDepartmentId: 0 }, 'root_department_invalid'],
    ['a page size of 0', { ...VALID, pageSize: 0 }, 'page_size_invalid'],
    ['a page size of 51', { ...VALID, pageSize: 51 }, 'page_size_invalid'],
    ['a fractional page size', { ...VALID, pageSize: 10.5 }, 'page_size_invalid'],
    ['a string page size', { ...VALID, pageSize: '10' }, 'page_size_invalid'],
  ]
  for (const [name, input, issue] of refusals) {
    it(`refuses ${name}`, () => {
      const parsed = parseFeishuConfig(input)
      expect(parsed.ok).toBe(false)
      if (parsed.ok === true) throw new Error('unreachable')
      expect(parsed.issues).toContain(issue)
    })
  }

  it('accepts page sizes 1 and 50', () => {
    expect(parseFeishuConfig({ ...VALID, pageSize: 1 }).ok).toBe(true)
    expect(parseFeishuConfig({ ...VALID, pageSize: 50 }).ok).toBe(true)
  })

  for (const key of ['baseUrl', 'base_url', 'BASEURL', 'apiBase', 'host', 'hostname', 'endpoint', 'openApiUrl', 'openApiHost', 'accountsUrl', 'accountsHost']) {
    it(`refuses a base-URL setting named ${key}`, () => {
      const parsed = parseFeishuConfig({ ...VALID, [key]: 'https://example.invalid' })
      expect(parsed.ok).toBe(false)
      if (parsed.ok === true) throw new Error('unreachable')
      expect(parsed.issues).toContain('base_url_forbidden')
    })
  }

  it('reports every issue at once', () => {
    const parsed = parseFeishuConfig({ brand: 'lark', pageSize: 0, baseUrl: 'x' })
    if (parsed.ok === true) throw new Error('unreachable')
    expect(parsed.issues).toEqual(['app_id_invalid', 'app_secret_missing', 'brand_invalid', 'base_url_forbidden', 'page_size_invalid'])
  })
})

describe('resolveFeishuAppSecret', () => {
  const settings = { storedAppSecret: 'enc:payload' }

  it('returns the decoded secret', () => {
    expect(resolveFeishuAppSecret(settings, (stored) => `plain(${stored})`)).toBe('plain(enc:payload)')
  })

  it('is null when the decoder throws or yields an empty value, without exposing the thrown text', () => {
    expect(
      resolveFeishuAppSecret(settings, () => {
        throw new Error('decoder failure with details')
      }),
    ).toBeNull()
    expect(resolveFeishuAppSecret(settings, () => '')).toBeNull()
  })
})

describe('feishuScopeOf', () => {
  it('is the tenant and the trimmed application id', () => {
    expect(feishuScopeOf({ corp_id: 'tk_fx_0001', config: { appId: '  cli_fx_0001 ' } })).toEqual({ tenant: 'tk_fx_0001', appScope: 'cli_fx_0001' })
  })

  it('is null for an unusable application id, tenant or configuration', () => {
    for (const row of [
      { corp_id: 'tk_fx_0001', config: { appId: '' } },
      { corp_id: 'tk_fx_0001', config: { appId: 'cli fx' } },
      { corp_id: 'tk_fx_0001', config: { appId: 'a'.repeat(129) } },
      { corp_id: 'tk_fx_0001', config: { appId: 12 } },
      { corp_id: 'tk_fx_0001', config: null },
      { corp_id: 'tk_fx_0001', config: [] },
      { corp_id: '', config: { appId: 'cli_fx_0001' } },
      { corp_id: 'tenant with space', config: { appId: 'cli_fx_0001' } },
    ]) {
      expect(feishuScopeOf(row as never)).toBeNull()
    }
  })
})

describe('FX-T06 typed identifiers', () => {
  const GOOD = { connectionId: 'conn-fx-0001', idType: 'open_id', value: 'ou_fx_0001' }

  it('builds a frozen typed reference for every known type', () => {
    for (const idType of ['open_id', 'union_id', 'user_id', 'open_department_id', 'department_id']) {
      const ref = feishuIdRef({ ...GOOD, idType })
      expect(ref).toEqual({ connectionId: 'conn-fx-0001', idType, value: 'ou_fx_0001' })
      expect(Object.isFrozen(ref)).toBe(true)
    }
  })

  const BAD: Array<[string, Record<string, unknown>]> = [
    ['an empty value', { ...GOOD, value: '' }],
    ['a value with a control character', { ...GOOD, value: 'ou_fx\u0000' }],
    ['a value with a newline', { ...GOOD, value: 'ou_fx\n1' }],
    ['a value with a space', { ...GOOD, value: 'ou fx' }],
    ['a non-ASCII value', { ...GOOD, value: 'ou_飞书' }],
    ['a value of 129 characters', { ...GOOD, value: 'o'.repeat(129) }],
    ['a non-string value', { ...GOOD, value: 12 }],
    ['a missing value', { connectionId: GOOD.connectionId, idType: GOOD.idType }],
    ['a missing connection', { idType: GOOD.idType, value: GOOD.value }],
    ['an empty connection', { ...GOOD, connectionId: '' }],
    ['a connection with a control character', { ...GOOD, connectionId: 'conn\u0001' }],
    ['a missing type', { connectionId: GOOD.connectionId, value: GOOD.value }],
    ['an unknown type', { ...GOOD, idType: 'email' }],
    ['a type in another case', { ...GOOD, idType: 'OPEN_ID' }],
  ]
  for (const [name, input] of BAD) {
    it(`refuses ${name}`, () => {
      expect(() => feishuIdRef(input)).toThrow(FeishuIdRefError)
    })
  }

  it('accepts a value of exactly 128 characters', () => {
    expect(feishuIdRef({ ...GOOD, value: 'o'.repeat(128) }).value).toHaveLength(128)
  })

  it('an identifier is only usable with the connection that issued it', () => {
    const ref = feishuIdRef(GOOD)
    expect(() => assertFeishuIdForConnection(ref, 'conn-fx-0001')).not.toThrow()
    const error = (() => {
      try {
        assertFeishuIdForConnection(ref, 'conn-fx-0002')
      } catch (caught) {
        return caught
      }
      return null
    })()
    expect(error).toBeInstanceOf(FeishuIdConnectionMismatchError)
    expect((error as FeishuIdConnectionMismatchError).code).toBe('FEISHU_ID_CONNECTION_MISMATCH')
    expect((error as Error).message).not.toContain('ou_fx_0001')
    expect((error as Error).message).not.toContain('conn-fx')
  })
})
