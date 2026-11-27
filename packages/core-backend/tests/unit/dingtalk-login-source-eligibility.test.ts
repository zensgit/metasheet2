import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DingTalkLoginSource } from '../../src/auth/dingtalk-login-source'

const mocks = vi.hoisted(() => ({ query: vi.fn(), empty: vi.fn(), scope: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ transaction: (work: (client: { query: typeof mocks.query }) => unknown) => work({ query: mocks.query }) }))
vi.mock('../../src/auth/strict-login-grant-store', () => ({
  lockEmptyConnectionLoginScope: mocks.empty,
  readConnectionLoginScope: mocks.scope,
}))
import { checkOrdinaryDingTalkSource, resolveDingTalkLoginSource } from '../../src/auth/dingtalk-login-source'

const env = { DINGTALK_CLIENT_ID: 'app-a', DINGTALK_CORP_ID: 'corp-a' }
const active = { id: 'connection-a', org_id: 'org-a', corp_id: 'corp-a', status: 'active' }
const source: DingTalkLoginSource = {
  connectionId: null, orgId: null, corpId: 'corp-a', appKey: 'app-a', configuredCorp: 'corp-a', explicit: false, strict: false,
}
const refused = { statusCode: 403, code: 'strict_connection', message: 'DingTalk login is not eligible for this source' }
const unavailable = { statusCode: 503, code: 'grant_state_unavailable', message: 'DingTalk login authorization is unavailable' }

function rows(value: unknown[]) {
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SET ') ? [] : value }))
}

beforeEach(() => {
  vi.resetAllMocks()
  rows([])
  mocks.empty.mockResolvedValue(true)
  mocks.scope.mockResolvedValue({ installation: 'installed', scope: null })
})
afterEach(() => { vi.unstubAllEnvs() })

for (const phase of ['selection', 'session'] as const) {
  describe(`DingTalk ${phase} eligibility`, () => {
    const run = () => phase === 'selection'
      ? resolveDingTalkLoginSource({}, env)
      : checkOrdinaryDingTalkSource({ query: mocks.query }, source)

    it.each(['paused', 'inactive', 'disabled', 'deactivated', 'Active', 'ACTIVE', '', ' active ', null, 1])('requires the active status (%s)', async status => {
      rows([{ ...active, status }])
      await expect(run()).rejects.toMatchObject(refused)
      expect(mocks.empty).not.toHaveBeenCalled()
      expect(mocks.scope).not.toHaveBeenCalled()
    })

    it.each([
      { org_id: '' }, { org_id: null }, { corp_id: '' }, { corp_id: null },
    ])('requires source fields (%j)', async fields => {
      rows([{ ...active, ...fields }])
      await expect(run()).rejects.toMatchObject(refused)
      expect(mocks.empty).not.toHaveBeenCalled()
    })

    it('accepts complete active source fields', async () => {
      rows([active])
      const result = await run()
      if (phase === 'selection') expect(result).toMatchObject({ connectionId: active.id, strict: false })
      else expect(result).toBeUndefined()
    })

    it('accepts empty scope with no configured connection', async () => {
      await run()
      expect(mocks.empty).toHaveBeenCalledOnce()
    })

    it('requires an empty scope for compatibility admission', async () => {
      mocks.empty.mockResolvedValue(false)
      await expect(run()).rejects.toMatchObject(refused)
    })

    it('uses a fixed response for source read failures', async () => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('SET ')) return { rows: [] }
        throw new Error('synthetic database detail')
      })
      await expect(run()).rejects.toMatchObject(unavailable)
      expect(mocks.empty).not.toHaveBeenCalled()
    })

    it('uses a fixed response for scope read failures', async () => {
      mocks.empty.mockRejectedValue(new Error('synthetic installation detail'))
      await expect(run()).rejects.toMatchObject(unavailable)
    })

    it('checks source eligibility before scope availability', async () => {
      rows([{ ...active, status: 'paused' }])
      mocks.empty.mockRejectedValue(new Error('synthetic installation detail'))
      mocks.scope.mockRejectedValue(new Error('synthetic installation detail'))
      await expect(run()).rejects.toMatchObject(refused)
      expect(mocks.empty).not.toHaveBeenCalled()
      expect(mocks.scope).not.toHaveBeenCalled()
    })
  })
}

describe('DingTalk configured selection', () => {
  it.each([{}, { connectionId: active.id }, { corpId: active.corp_id }, { connectionId: active.id, corpId: active.corp_id }])('checks selected source eligibility (%j)', async selector => {
    rows([{ ...active, status: 'paused' }])
    await expect(async () => resolveDingTalkLoginSource(selector, env)).rejects.toMatchObject(refused)
  })

  it.each([
    [{ DINGTALK_CLIENT_ID: ' app-a ', DINGTALK_APP_KEY: 'other', DINGTALK_CORP_ID: ' corp-a ' }, ['app-a', 'corp-a']],
    [{ DINGTALK_CLIENT_ID: ' ', DINGTALK_APP_KEY: ' app-a ' }, ['app-a', null]],
  ] as const)('uses configured application values (%j)', async (config, expected) => {
    rows([active])
    const result = await resolveDingTalkLoginSource({}, config)
    expect(result).toMatchObject({ connectionId: active.id, appKey: expected[0], configuredCorp: expected[1] })
    expect(mocks.query.mock.calls[1][1]).toEqual(expected)
    expect(mocks.query.mock.calls[1][0].replace(/\s+/g, ' ').trim()).toBe(
      "SELECT id::text, org_id, corp_id, status FROM directory_integrations WHERE provider = 'dingtalk' AND config->>'appKey' = $1 AND ($2::text IS NULL OR corp_id = $2) ORDER BY id LIMIT 2",
    )
  })

  it.each([{ connectionId: 'different' }, { corpId: 'different' }])('requires matching selectors (%j)', async selector => {
    rows([active])
    await expect(async () => resolveDingTalkLoginSource(selector, env)).rejects.toMatchObject(refused)
  })

  it('keeps a request corporation separate from an unspecified configured corporation', async () => {
    rows([active])
    await resolveDingTalkLoginSource({ corpId: active.corp_id }, { DINGTALK_CLIENT_ID: 'app-a' })
    expect(mocks.query.mock.calls[1][1]).toEqual(['app-a', null])
  })

  it('preserves configuration admission with an empty application', async () => {
    rows([{ ...active, status: 'paused' }])
    expect(await resolveDingTalkLoginSource({}, {})).toMatchObject({ connectionId: null, appKey: '' })
  })

  it('retains connection scope classification', async () => {
    rows([active])
    mocks.scope.mockResolvedValue({ installation: 'installed', scope: { connectionId: active.id } })
    expect(await resolveDingTalkLoginSource({}, env)).toMatchObject({ connectionId: active.id, strict: true })
  })
})

describe('DingTalk session source checks', () => {
  it('uses the supplied client and captured application values', async () => {
    vi.stubEnv('DINGTALK_CLIENT_ID', 'other-app')
    vi.stubEnv('DINGTALK_CORP_ID', 'other-corp')
    const finalQuery = vi.fn().mockResolvedValue({ rows: [] })
    const client = { query: finalQuery }
    await checkOrdinaryDingTalkSource(client, source)
    expect(mocks.query).not.toHaveBeenCalled()
    expect(finalQuery).toHaveBeenCalledOnce()
    expect(finalQuery.mock.calls[0][1]).toEqual(['app-a', 'corp-a'])
    expect(finalQuery.mock.calls[0][0].replace(/\s+/g, ' ').trim()).toBe(
      "SELECT id::text, org_id, corp_id, status FROM directory_integrations WHERE provider = 'dingtalk' AND config->>'appKey' = $1 AND ($2::text IS NULL OR corp_id = $2) ORDER BY id LIMIT 2",
    )
    expect(finalQuery.mock.calls[0][0]).not.toMatch(/FOR (SHARE|UPDATE)/)
    expect(mocks.empty).toHaveBeenCalledWith(client)
    expect(finalQuery.mock.invocationCallOrder[0]).toBeLessThan(mocks.empty.mock.invocationCallOrder[0])
  })

  it('preserves configuration admission with an empty application', async () => {
    rows([{ ...active, status: 'paused' }])
    await checkOrdinaryDingTalkSource({ query: mocks.query }, { ...source, appKey: '' })
    expect(mocks.empty).toHaveBeenCalledOnce()
    expect(mocks.scope).not.toHaveBeenCalled()
  })

  it('retains locked verification for a selected connection', async () => {
    rows([{ id: active.id }])
    await checkOrdinaryDingTalkSource({ query: mocks.query }, { ...source, connectionId: active.id, orgId: active.org_id })
    expect(mocks.query).toHaveBeenCalledOnce()
    expect(mocks.query.mock.calls[0][0]).toContain('FOR SHARE')
    expect(mocks.query.mock.calls[0][0]).toContain("status = 'active'")
    expect(mocks.empty).not.toHaveBeenCalled()
  })

  it('requires a current connection', async () => {
    await expect(checkOrdinaryDingTalkSource({ query: mocks.query }, { ...source, connectionId: active.id })).rejects.toMatchObject(refused)
  })

  it('requires ordinary connection scope', async () => {
    await expect(checkOrdinaryDingTalkSource({ query: mocks.query }, { ...source, strict: true })).rejects.toMatchObject(refused)
    expect(mocks.query).not.toHaveBeenCalled()
  })
})
