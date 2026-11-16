/**
 * POST /connection/verify of the Feishu admin router (config and token levels): the order of answers
 * (administrator, switch, body, row), the closed request body, the independent levels, the values-free
 * reports, and the production wiring. All Feishu traffic goes to a local server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { usePinnedServer } from '../utils/pinned-server'

const mocks = vi.hoisted(() => ({ isRbacAdmin: vi.fn(), query: vi.fn(), audit: vi.fn(), logged: vi.fn() }))
vi.mock('../../src/rbac/service', () => ({ isAdmin: mocks.isRbacAdmin }))
vi.mock('../../src/db/pg', () => ({ pool: null, query: mocks.query, transaction: vi.fn() }))
vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ query: vi.fn(), transaction: vi.fn(), getInternalPool: () => null }) },
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: mocks.audit }))
vi.mock('../../src/core/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/logger')>()),
  Logger: class {
    info(...args: unknown[]) { mocks.logged('info', ...args) }
    warn(...args: unknown[]) { mocks.logged('warn', ...args) }
    error(...args: unknown[]) { mocks.logged('error', ...args) }
    debug(...args: unknown[]) { mocks.logged('debug', ...args) }
  },
}))

import {
  FEISHU_CONNECTION_DISABLED,
  FEISHU_INTEGRATION_NOT_FOUND,
  FEISHU_PROVIDER_MISMATCH,
  FEISHU_VERIFY_INTERNAL,
  FEISHU_VERIFY_REQUEST_INVALID,
  adminDirectoryFeishuRouter,
  createAdminDirectoryFeishuRouter,
} from '../../src/routes/admin-directory-feishu'
import { __feishuEndpointsForTests } from '../../src/integrations/feishu/endpoints'
import {
  FEISHU_VERIFY_AVAILABLE_LEVELS,
  FEISHU_VERIFY_LEVELS,
  FEISHU_VERIFY_REQUEST_SENTENCES,
  FEISHU_VERIFY_SCOPE,
  type FeishuVerifyDeps,
  type FeishuVerifyIntegrationRow,
  type FeishuVerifyReport,
} from '../../src/integrations/feishu/verify'
import { createFeishuTenantTokenService } from '../../src/integrations/feishu/token'
import {
  installNoExternalFetchGuard,
  startFeishuMockServer,
  type MockFeishuServer,
  type MockFeishuStep,
  type NoExternalFetchGuard,
} from '../helpers/feishu-mock-server'

const BASE = '/api/admin/directory/feishu'
const ID = '22222222-2222-4222-8222-222222222222'
const TENANT = 'tk_fx_0001'
const APP_ID = 'cli_fx_0001'
const SECRET = 'fx-secret-value-0001-not-real'
const MINT = 'POST /oauth/v3/token'
const TENANT_QUERY = 'GET /open-apis/tenant/v2/tenant/query'
const SWITCH = 'DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED'
const MINTED = 't-fx-minted-token-abcdefghij'

type Actor = 'anonymous' | 'admin' | 'plain'
const pinned = usePinnedServer()
let actor: Actor = 'admin'

const decodeSecret = (stored: string) => stored.replace(/^enc:/, '')

function row(overrides: Partial<FeishuVerifyIntegrationRow> & { config?: unknown } = {}): FeishuVerifyIntegrationRow {
  return {
    id: ID,
    provider: 'feishu',
    corp_id: TENANT,
    config: { appId: APP_ID, appSecret: `enc:${SECRET}`, brand: 'feishu' },
    ...overrides,
  }
}

function buildApp(router: express.Router): express.Express {
  const app = express()
  app.use(express.json({ limit: '1kb' }))
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (actor === 'admin') req.user = { id: 'admin-1', role: 'admin' } as never
    else if (actor === 'plain') req.user = { id: 'user-1' } as never
    next()
  })
  app.use(BASE, router)
  app.use((error: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.status ?? 400).json({ ok: false, error: { code: 'BODY_REJECTED' } })
  })
  return app
}

const mint: MockFeishuStep = { kind: 'json', body: { access_token: MINTED, expires_in: 7200, token_type: 'Bearer' } }
const tenantOf = (key: unknown): MockFeishuStep => ({ kind: 'json', body: { code: 0, data: { tenant: { tenant_key: key, name: 'Fx Tenant' } } } })

describe('Feishu connection verify route', () => {
  let server: MockFeishuServer
  let guard: NoExternalFetchGuard
  let switchOn: boolean
  let isEnabled: ReturnType<typeof vi.fn>
  let readIntegration: ReturnType<typeof vi.fn>
  let seenAuthorization: string[]
  let verifyDeps: FeishuVerifyDeps
  let savedSwitch: string | undefined

  const post = (body: unknown) => request(pinned.url()).post(`${BASE}/connection/verify`).send(body as object)
  const verifyBody = (levels: string[]) => ({ integrationId: ID, levels })

  function useTokenService(timeoutMs = 400): void {
    verifyDeps.tokens = createFeishuTenantTokenService({
      transport: { sleep: async () => false, random: () => 0, timeoutMs },
    })
  }

  beforeEach(async () => {
    actor = 'admin'
    switchOn = true
    mocks.isRbacAdmin.mockReset().mockResolvedValue(false)
    mocks.query.mockReset()
    mocks.logged.mockReset()
    savedSwitch = process.env[SWITCH]
    delete process.env[SWITCH]
    server = await startFeishuMockServer()
    __feishuEndpointsForTests.replace(server.origins())
    guard = installNoExternalFetchGuard()
    seenAuthorization = []
    isEnabled = vi.fn(() => switchOn)
    readIntegration = vi.fn(async () => row())
    verifyDeps = {
      readIntegration: readIntegration as unknown as FeishuVerifyDeps['readIntegration'],
      decodeSecret,
      tokens: createFeishuTenantTokenService({ transport: { sleep: async () => false, random: () => 0, timeoutMs: 400 } }),
      fetchFn: ((url: string, init: RequestInit) => {
        seenAuthorization.push(String((init.headers as Record<string, string>)?.Authorization ?? ''))
        return globalThis.fetch(url, init)
      }) as typeof fetch,
    }
    pinned.setApp(buildApp(createAdminDirectoryFeishuRouter({ isEnabled: isEnabled as unknown as () => boolean, verify: verifyDeps })))
  })

  afterEach(async () => {
    guard.restore()
    __feishuEndpointsForTests.restore()
    await server.close()
    if (savedSwitch === undefined) delete process.env[SWITCH]
    else process.env[SWITCH] = savedSwitch
    expect(guard.violations).toEqual([])
    expect(server.unscripted).toEqual([])
  })

  describe('the order of answers', () => {
    it('answers an unauthenticated and a non-administrator caller before the switch, the body or any read', async () => {
      for (const who of ['anonymous', 'plain'] as const) {
        actor = who
        const response = await post({ unknown: 'x' })
        expect(response.status).toBe(who === 'anonymous' ? 401 : 403)
      }
      expect(isEnabled).not.toHaveBeenCalled()
      expect(readIntegration).not.toHaveBeenCalled()
      expect(server.count()).toBe(0)
    })

    it('switch off: 404 with the fixed sentence, whatever the body says; nothing is read or requested', async () => {
      switchOn = false
      for (const body of [verifyBody(['token']), { garbage: true }, undefined]) {
        const response = await post(body)
        expect(response.status).toBe(404)
        expect(response.body).toEqual({ ok: false, error: { code: FEISHU_CONNECTION_DISABLED.code, message: FEISHU_CONNECTION_DISABLED.sentence } })
      }
      expect(readIntegration).not.toHaveBeenCalled()
      expect(server.count()).toBe(0)
    })

    it('the body is validated before the row is read', async () => {
      const response = await post({ integrationId: 'not-a-uuid', levels: ['config'] })
      expect(response.status).toBe(400)
      expect(readIntegration).not.toHaveBeenCalled()
    })
  })

  describe('the request body is a closed whitelist', () => {
    const cases: Array<[string, unknown, keyof typeof FEISHU_VERIFY_REQUEST_SENTENCES]> = [
      ['an array', [], 'body_not_object'],
      ['no body (the parser yields an empty object)', undefined, 'integration_id_invalid'],
      ['an unknown key', { ...verifyBody(['config']), extra: 1 }, 'unknown_key'],
      ['a key spelled with another case', { ...verifyBody(['config']), IntegrationId: ID }, 'unknown_key'],
      ['a missing integration id', { levels: ['config'] }, 'integration_id_invalid'],
      ['an integration id that is not a UUID', { integrationId: 'abc', levels: ['config'] }, 'integration_id_invalid'],
      ['an integration id with surrounding space', { integrationId: ` ${ID}`, levels: ['config'] }, 'integration_id_invalid'],
      ['missing levels', { integrationId: ID }, 'levels_invalid'],
      ['empty levels', verifyBody([]), 'levels_invalid'],
      ['levels that are not a list', { integrationId: ID, levels: 'config' }, 'levels_invalid'],
      ['repeated levels', verifyBody(['config', 'config']), 'levels_invalid'],
      ['an unknown level', verifyBody(['ping']), 'levels_invalid'],
      ['a level spelled with another case', verifyBody(['Config']), 'levels_invalid'],
      ['a level with surrounding space', verifyBody([' config']), 'levels_invalid'],
      ['a non-string level', { integrationId: ID, levels: [1] }, 'levels_invalid'],
      ['the directory_read level (not available)', verifyBody(['config', 'directory_read']), 'level_unavailable'],
      ['the send level (not available)', verifyBody(['send']), 'level_unavailable'],
      ['a recipient', { ...verifyBody(['config']), recipient: { type: 'open_id', id: 'ou_fx_0001' } }, 'recipient_not_allowed'],
    ]
    for (const [name, body, issue] of cases) {
      it(`refuses ${name} with a fixed sentence and reads nothing`, async () => {
        const response = await post(body)
        expect(response.status).toBe(400)
        expect(response.body).toEqual({
          ok: false,
          error: { code: FEISHU_VERIFY_REQUEST_INVALID.code, message: FEISHU_VERIFY_REQUEST_SENTENCES[issue] },
        })
        expect(readIntegration).not.toHaveBeenCalled()
        expect(server.count()).toBe(0)
      })
    }

    it('does not echo any part of the request', async () => {
      const response = await post({ ...verifyBody(['config']), 'echo-me-please-key': 'echo-me-please-value' })
      expect(response.text).not.toContain('echo-me-please')
    })

    it('the level set is the four named levels and this build runs two of them', () => {
      expect([...FEISHU_VERIFY_LEVELS]).toEqual(['config', 'token', 'directory_read', 'send'])
      expect([...FEISHU_VERIFY_AVAILABLE_LEVELS]).toEqual(['config', 'token'])
    })
  })

  describe('the row', () => {
    it('a missing integration is 404 and nothing is requested', async () => {
      readIntegration.mockResolvedValue(null)
      const response = await post(verifyBody(['token']))
      expect(response.status).toBe(404)
      expect(response.body.error).toEqual({ code: FEISHU_INTEGRATION_NOT_FOUND.code, message: FEISHU_INTEGRATION_NOT_FOUND.sentence })
      expect(server.count()).toBe(0)
    })

    it('an integration of another provider is a typed 409 and nothing is requested', async () => {
      readIntegration.mockResolvedValue(row({ provider: 'dingtalk' }))
      const response = await post(verifyBody(['token']))
      expect(response.status).toBe(409)
      expect(response.body.error).toEqual({ code: FEISHU_PROVIDER_MISMATCH.code, message: FEISHU_PROVIDER_MISMATCH.sentence })
      expect(server.count()).toBe(0)
    })

    it('an unexpected failure is the fixed 500 and the log carries the class name only', async () => {
      readIntegration.mockRejectedValue(new Error('driver text host=db.internal password=hunter2'))
      const response = await post(verifyBody(['config']))
      expect(response.status).toBe(500)
      expect(response.body).toEqual({ ok: false, error: { code: FEISHU_VERIFY_INTERNAL.code, message: FEISHU_VERIFY_INTERNAL.sentence } })
      const logged = JSON.stringify(mocks.logged.mock.calls)
      expect(logged).toContain('Error')
      expect(logged).not.toContain('db.internal')
      expect(logged).not.toContain('hunter2')
    })
  })

  describe('config level', () => {
    it('reports a complete configuration without a request, as booleans and lengths only', async () => {
      const response = await post(verifyBody(['config']))
      expect(response.status).toBe(200)
      const report = response.body.data as FeishuVerifyReport
      expect(Object.keys(report.levels)).toEqual(['config'])
      expect(report.levels.config).toEqual({
        passed: true,
        issues: [],
        appId: { configured: true, length: APP_ID.length, valuePrinted: false },
        appSecret: { configured: true, readable: true, valuePrinted: false },
        brand: 'feishu',
        scope: FEISHU_VERIFY_SCOPE.config,
      })
      expect(server.count()).toBe(0)
      for (const leaked of [APP_ID, SECRET, TENANT, 'enc:']) expect(response.text).not.toContain(leaked)
    })

    it('reports each problem as a code', async () => {
      readIntegration.mockResolvedValue(row({ config: { appId: 'cli fx', appSecret: '', brand: 'lark', baseUrl: 'x' } }))
      const report = (await post(verifyBody(['config']))).body.data as FeishuVerifyReport
      expect(report.levels.config).toMatchObject({
        passed: false,
        issues: ['app_id_invalid', 'app_secret_missing', 'brand_invalid', 'base_url_forbidden'],
        appSecret: { configured: false, readable: null },
        brand: null,
      })
    })

    it('reports an unreadable secret and an unusable tenant key', async () => {
      verifyDeps.decodeSecret = () => {
        throw new Error('decoder failure text')
      }
      readIntegration.mockResolvedValue(row({ corp_id: 'tenant with space' }))
      const response = await post(verifyBody(['config']))
      expect(response.body.data.levels.config).toMatchObject({ passed: false, appSecret: { configured: true, readable: false } })
      expect(response.body.data.levels.config.issues).toEqual(['tenant_key_invalid', 'app_secret_unreadable'])
      expect(response.text).not.toContain('decoder failure text')
    })
  })

  describe('token level', () => {
    it('mints fresh, reads the enterprise information with that token and asserts the tenant', async () => {
      server.script(MINT, [mint])
      server.script(TENANT_QUERY, [tenantOf(TENANT)])
      const response = await post(verifyBody(['token']))
      expect(response.status).toBe(200)
      const report = response.body.data as FeishuVerifyReport
      expect(Object.keys(report.levels)).toEqual(['token'])
      expect(report.levels.token).toEqual({
        attempted: true,
        passed: true,
        cacheBypassed: true,
        accessToken: { verified: true, valuePrinted: false },
        tenantAsserted: true,
        tenantFailure: null,
        failure: null,
        scope: FEISHU_VERIFY_SCOPE.tokenTenant,
      })
      expect(seenAuthorization).toEqual([`Bearer ${MINTED}`])
      for (const leaked of [MINTED, SECRET, APP_ID, TENANT, 'Fx Tenant']) expect(response.text).not.toContain(leaked)
    })

    it('a tenant that differs fails the level with the fixed sentence', async () => {
      server.script(MINT, [mint])
      server.script(TENANT_QUERY, [tenantOf('tk_fx_other')])
      const report = (await post(verifyBody(['token']))).body.data as FeishuVerifyReport
      expect(report.levels.token).toMatchObject({
        passed: false,
        tenantAsserted: false,
        tenantFailure: 'tenant_mismatch',
        failure: { code: 'tenant_mismatch', message: 'The Feishu tenant does not match the configured tenant' },
        scope: FEISHU_VERIFY_SCOPE.token,
      })
    })

    it('a tenant query that cannot be read leaves the credentials verified and the tenant not asserted', async () => {
      server.script(MINT, [mint])
      server.script(TENANT_QUERY, [{ kind: 'json', status: 400, body: { code: 99991672, msg: 'scope text' } }])
      const response = await post(verifyBody(['token']))
      expect(response.body.data.levels.token).toMatchObject({
        passed: true,
        accessToken: { verified: true },
        tenantAsserted: false,
        tenantFailure: 'tenant_scope_unavailable',
        tenantProviderCode: 99991672,
        failure: null,
        scope: FEISHU_VERIFY_SCOPE.token,
      })
      expect(response.text).not.toContain('scope text')
    })

    it('a tenant answer without a tenant key is not an assertion', async () => {
      server.script(MINT, [mint])
      server.script(TENANT_QUERY, [{ kind: 'json', body: { code: 0, data: {} } }])
      const report = (await post(verifyBody(['token']))).body.data as FeishuVerifyReport
      expect(report.levels.token).toMatchObject({ passed: true, tenantAsserted: false, tenantFailure: 'tenant_response_invalid' })
    })

    const refusals: Array<[string, MockFeishuStep[], string, Record<string, unknown>]> = [
      [
        'a credential rejection',
        [{ kind: 'json', status: 400, body: { code: 20002, error: 'invalid_client', error_description: SECRET } }],
        'token_rejected',
        { providerCode: 20002, providerCodeKind: 'code', message: 'Access token was not obtained: Feishu rejected the request (code 20002)' },
      ],
      [
        'a server error that outlasts the retries',
        [
          { kind: 'json', status: 503, body: {} },
          { kind: 'json', status: 503, body: {} },
          { kind: 'json', status: 503, body: {} },
        ],
        'token_error_status',
        { providerCode: 503, providerCodeKind: 'http_status' },
      ],
      ['a success without a token', [{ kind: 'json', body: { expires_in: 7200 } }], 'token_incomplete_response', {}],
      ['an answer that is not JSON', [{ kind: 'raw', body: 'oops' }, { kind: 'raw', body: 'oops' }, { kind: 'raw', body: 'oops' }], 'token_malformed_response', {}],
      ['an answer that never comes', [{ kind: 'hang' }], 'token_timeout', { message: 'Access token was not obtained: Feishu did not answer in time' }],
      ['a dropped connection', [{ kind: 'reset' }, { kind: 'reset' }, { kind: 'reset' }], 'token_network_error', { message: 'Access token was not obtained' }],
    ]
    for (const [name, steps, code, extra] of refusals) {
      it(`${name}: failure ${code}, no tenant request, no value in the report`, async () => {
        useTokenService(150)
        server.script(MINT, steps)
        const response = await post(verifyBody(['token']))
        expect(response.status).toBe(200)
        expect(response.body.data.levels.token).toMatchObject({
          attempted: true,
          passed: false,
          cacheBypassed: true,
          accessToken: { verified: false },
          tenantAsserted: null,
          failure: { code, ...extra },
        })
        expect(server.count(TENANT_QUERY)).toBe(0)
        expect(response.text).not.toContain(SECRET)
        expect(response.text).not.toContain('invalid_client')
      }, 4_000)
    }

    it('an unusable configuration makes no request', async () => {
      readIntegration.mockResolvedValue(row({ config: { appId: APP_ID } }))
      const response = await post(verifyBody(['token']))
      expect(response.body.data.levels.token).toMatchObject({
        attempted: false,
        passed: false,
        cacheBypassed: null,
        tenantAsserted: null,
        failure: { code: 'config_unusable' },
      })
      expect(server.count()).toBe(0)
    })

    it('does not use the shared token cache: a cached token is not served and not replaced', async () => {
      server.script(MINT, [{ kind: 'json', body: { access_token: 't-fx-cached-abcdefghij', expires_in: 7200 } }, mint])
      server.script(TENANT_QUERY, [tenantOf(TENANT)])
      const service = createFeishuTenantTokenService({ transport: { sleep: async () => false, random: () => 0, timeoutMs: 400 } })
      verifyDeps.tokens = service
      const credentials = { connectionId: ID, appId: APP_ID, appSecret: SECRET }
      const cached = await service.getToken(credentials)
      await post(verifyBody(['token']))
      expect(seenAuthorization).toEqual([`Bearer ${MINTED}`])
      await expect(service.getToken(credentials)).resolves.toBe(cached)
      expect(server.count(MINT)).toBe(2)
    })
  })

  describe('levels are independent', () => {
    it('both levels are reported in the canonical order, each on its own evidence', async () => {
      readIntegration.mockResolvedValue(row({ config: { appId: APP_ID } }))
      const response = await post(verifyBody(['token', 'config']))
      expect(Object.keys(response.body.data.levels)).toEqual(['config', 'token'])
      expect(response.body.data.levels.config.passed).toBe(false)
      expect(response.body.data.levels.token.attempted).toBe(false)
    })

    it('a passing config level says nothing about Feishu accepting anything', async () => {
      const report = (await post(verifyBody(['config']))).body.data as FeishuVerifyReport
      expect(report.levels.config?.scope.doesNotProve).toContain('That Feishu accepts the credentials')
      expect(report.levels.token).toBeUndefined()
    })
  })

  describe('production wiring', () => {
    it('is bound to the switch, the connection row query, the stored-secret decoder and the shared token service', async () => {
      pinned.setApp(buildApp(adminDirectoryFeishuRouter()))
      // off by default, and only the exact literal turns it on
      for (const value of [undefined, '', '1', 'TRUE', ' true', 'true ']) {
        if (value === undefined) delete process.env[SWITCH]
        else process.env[SWITCH] = value
        expect((await post(verifyBody(['config']))).status).toBe(404)
      }
      expect(mocks.query).not.toHaveBeenCalled()

      process.env[SWITCH] = 'true'
      mocks.query.mockResolvedValueOnce({ rows: [{ id: ID, provider: 'dingtalk', corp_id: 'x', config: {} }], rowCount: 1 })
      const mismatch = await post(verifyBody(['config']))
      expect(mismatch.status).toBe(409)
      expect(mocks.query).toHaveBeenCalledTimes(1)
      expect(mocks.query.mock.calls[0][0]).toMatch(/FROM directory_integrations WHERE id = \$1/)
      expect(mocks.query.mock.calls[0][1]).toEqual([ID])

      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
      expect((await post(verifyBody(['config']))).status).toBe(404)
    })

    it('uses the application-wide stored-secret decoder and token service', () => {
      const source = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'routes', 'admin-directory-feishu.ts'), 'utf8')
      expect(source).toContain('decodeSecret: decryptStoredSecretValue')
      expect(source).toContain('tokens: feishuTenantTokens')
      expect(source).toContain('isEnabled: () => isDirectoryIntegrationCapabilitiesEnabled()')
    })
  })
})
