/**
 * GET /api/admin/directory/integration-capabilities/:integrationId: the order of answers, the fixed
 * sentences, the shape of the view and the production wiring. The administrator check answers first; the
 * switch, the path and the data come after it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
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
  CAPABILITIES_DISABLED,
  CAPABILITIES_INTERNAL,
  CAPABILITIES_SCHEMA_UNAVAILABLE,
  INTEGRATION_ID_INVALID,
  INTEGRATION_NOT_FOUND,
  adminDirectoryCapabilitiesRouter,
  createAdminDirectoryCapabilitiesRouter,
} from '../../src/routes/admin-directory-capabilities'
import { createDirectoryIntegrationCapabilitiesService, type CapabilitiesServiceDeps } from '../../src/integrations/directory-integration-capabilities-service'
import { isCapabilityImplementationAvailable } from '../../src/integrations/integration-capability-implementations'
import { resolveProviderCapabilityDescriptor } from '../../src/integrations/provider-capability-registry'

const SRC = path.resolve(__dirname, '..', '..', 'src')
const ROUTE_FILE = path.join(SRC, 'routes', 'admin-directory-capabilities.ts')
const SIBLING_FILE = path.join(SRC, 'routes', 'admin-directory.ts')
const BASE = '/api/admin/directory/integration-capabilities'
const ID = '11111111-1111-4111-8111-111111111111'
const SWITCH = 'DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED'
const CORP = 'ding-corp-secret-id'
const APP_KEY = 'ding-app-key-secret'

type Actor = 'anonymous' | 'admin' | 'plain'
const pinned = usePinnedServer()
let actor: Actor = 'admin'

function integration(overrides: Record<string, unknown> = {}) {
  return { id: ID, org_id: 'default', provider: 'dingtalk', status: 'active', corp_id: CORP, config: { appKey: APP_KEY }, sync_enabled: true, schedule_cron: null, ...overrides }
}

/** Answers the three read statements; `behaviour` replaces any of them. */
function answerWith(options: { tables?: boolean; integration?: Record<string, unknown> | null; fail?: (sql: string) => Error | null } = {}) {
  return async (sql: string) => {
    const failure = options.fail?.(sql)
    if (failure) throw failure
    if (/to_regclass/.test(sql)) return { rows: [{ capabilities: options.tables ?? true, history: options.tables ?? true }], rowCount: 1 }
    if (/FROM directory_integrations/.test(sql)) {
      const row = options.integration === undefined ? integration() : options.integration
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    return { rows: [], rowCount: 0 }
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

function serviceWith(overrides: Partial<CapabilitiesServiceDeps> & { switchOn: boolean; query: ReturnType<typeof vi.fn> }) {
  const { switchOn, query, ...rest } = overrides
  return createDirectoryIntegrationCapabilitiesService({
    executor: { query } as never,
    isEnabled: () => switchOn,
    resolveDescriptor: resolveProviderCapabilityDescriptor,
    isImplementationAvailable: isCapabilityImplementationAvailable,
    readLoginRuntime: () => ({ available: false, requireGrant: false, autoLinkEmail: false, autoProvision: false }),
    isIntegrationScopedCredentialsEnabled: () => false,
    ...rest,
  })
}

async function snapshot(response: request.Response): Promise<unknown> {
  const headers = { ...response.headers }
  delete headers.date
  return { status: response.status, body: response.body, text: response.text, headers }
}

let savedSwitch: string | undefined
beforeEach(() => {
  actor = 'admin'
  mocks.isRbacAdmin.mockReset().mockResolvedValue(false)
  mocks.query.mockReset()
  mocks.audit.mockReset()
  savedSwitch = process.env[SWITCH]
})
afterEach(() => {
  if (savedSwitch === undefined) delete process.env[SWITCH]
  else process.env[SWITCH] = savedSwitch
})

describe('before the administrator check', () => {
  async function responses(switchOn: boolean) {
    const query = vi.fn(answerWith())
    pinned.setApp(buildApp(createAdminDirectoryCapabilitiesRouter({ service: serviceWith({ switchOn, query }) })))
    const out: Record<string, unknown> = {}
    actor = 'anonymous'
    out.anonymous = await snapshot(await request(pinned.url()).get(`${BASE}/${ID}`))
    out.anonymousBadPath = await snapshot(await request(pinned.url()).get(`${BASE}/not-a-uuid`))
    actor = 'plain'
    out.plain = await snapshot(await request(pinned.url()).get(`${BASE}/${ID}`))
    out.plainBadPath = await snapshot(await request(pinned.url()).get(`${BASE}/not-a-uuid`))
    for (const who of ['anonymous', 'plain'] as const) {
      actor = who
      out[`${who}Malformed`] = await snapshot(await request(pinned.url()).get(`${BASE}/${ID}`).set('Content-Type', 'application/json').send('{"broken"'))
      out[`${who}Oversize`] = await snapshot(await request(pinned.url()).get(`${BASE}/${ID}`).set('Content-Type', 'application/json').send(JSON.stringify({ pad: 'x'.repeat(4096) })))
    }
    expect(query).not.toHaveBeenCalled()
    return out
  }

  it('gives the same complete response with the switch on and off, for anonymous and non-administrator callers, valid and invalid paths, malformed and oversize bodies', async () => {
    const off = await responses(false)
    const on = await responses(true)
    expect(on).toEqual(off)
    expect((off.anonymous as { status: number }).status).toBe(401)
    expect((off.plain as { status: number }).status).toBe(403)
    expect((off.anonymousMalformed as { status: number }).status).toBe(400)
    expect((off.plainOversize as { status: number }).status).toBe(413)
  })
})

describe('after the administrator check', () => {
  it('answers 404 with the fixed sentence while the switch is off, before looking at the path, and issues no statement', async () => {
    const query = vi.fn(answerWith())
    pinned.setApp(buildApp(createAdminDirectoryCapabilitiesRouter({ service: serviceWith({ switchOn: false, query }) })))
    for (const id of [ID, 'not-a-uuid']) {
      const response = await request(pinned.url()).get(`${BASE}/${id}`)
      expect(response.status).toBe(404)
      expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_DISABLED', message: 'Directory integration capabilities are not enabled' } })
    }
    expect(query).not.toHaveBeenCalled()
  })

  it('answers 400 for a path that is not a UUID, with the code and sentence of the sibling directory routes', async () => {
    const query = vi.fn(answerWith())
    pinned.setApp(buildApp(createAdminDirectoryCapabilitiesRouter({ service: serviceWith({ switchOn: true, query }) })))
    const response = await request(pinned.url()).get(`${BASE}/not-a-uuid`)
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_INTEGRATION_ID_INVALID', message: 'integrationId must be a UUID' } })
    expect(query).not.toHaveBeenCalled()
    const sibling = readFileSync(SIBLING_FILE, 'utf8')
    expect(sibling).toContain(`integrationId: { code: '${INTEGRATION_ID_INVALID.code}', message: '${INTEGRATION_ID_INVALID.sentence}' }`)
    expect(sibling).toContain(`jsonError(res, 404, '${INTEGRATION_NOT_FOUND.code}', '${INTEGRATION_NOT_FOUND.sentence}')`)
  })

  it('answers 404 DIRECTORY_NOT_FOUND for an integration that does not exist', async () => {
    const query = vi.fn(answerWith({ integration: null }))
    pinned.setApp(buildApp(createAdminDirectoryCapabilitiesRouter({ service: serviceWith({ switchOn: true, query }) })))
    const response = await request(pinned.url()).get(`${BASE}/${ID}`)
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_NOT_FOUND', message: 'Directory integration not found' } })
  })

  it('answers 503 when the capability tables are not present', async () => {
    const query = vi.fn(answerWith({ tables: false }))
    pinned.setApp(buildApp(createAdminDirectoryCapabilitiesRouter({ service: serviceWith({ switchOn: true, query }) })))
    const response = await request(pinned.url()).get(`${BASE}/${ID}`)
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_SCHEMA_UNAVAILABLE', message: 'Directory integration capabilities are unavailable' } })
  })

  it('answers every unexpected failure with the fixed sentence and never the driver text', async () => {
    const secret = 'password=hunter2 host=10.0.0.5'
    const failures: Array<(sql: string) => Error | null> = [
      (sql) => (/to_regclass/.test(sql) ? Object.assign(new Error(secret), { code: '57014' }) : null),
      (sql) => (/FROM directory_integrations/.test(sql) ? Object.assign(new Error(secret), { code: '40001' }) : null),
      (sql) => (/FROM directory_integrations/.test(sql) ? Object.assign(new Error(secret), { code: '55P03' }) : null),
      (sql) => (/FROM directory_integrations/.test(sql) ? new Error(secret) : null),
    ]
    for (const fail of failures) {
      const query = vi.fn(answerWith({ fail }))
      pinned.setApp(buildApp(createAdminDirectoryCapabilitiesRouter({ service: serviceWith({ switchOn: true, query }) })))
      const response = await request(pinned.url()).get(`${BASE}/${ID}`)
      expect(response.status).toBe(500)
      expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_INTERNAL', message: 'Directory integration capabilities request failed' } })
      expect(response.text).not.toContain('hunter2')
      expect(response.text).not.toContain('10.0.0.5')
    }
  })

  it('logs only the error class name and the five-character SQLSTATE on a failure', async () => {
    const secret = 'password=hunter2 host=10.0.0.5'
    const cases: Array<[Error, string]> = [
      [Object.assign(new Error(secret), { code: '57014' }), 'Error 57014'],
      [Object.assign(new TypeError(secret), { code: 'too-long-code' }), 'TypeError'],
      [Object.assign(new RangeError(secret), { code: 'ABCDEF' }), 'RangeError'],
      [Object.assign(new SyntaxError(secret), { code: 'ab012' }), 'SyntaxError'],
      [new Error(secret), 'Error'],
    ]
    for (const [failure, expected] of cases) {
      mocks.logged.mockClear()
      const query = vi.fn(answerWith({ fail: (sql) => (/FROM directory_integrations/.test(sql) ? failure : null) }))
      pinned.setApp(buildApp(createAdminDirectoryCapabilitiesRouter({ service: serviceWith({ switchOn: true, query }) })))
      const response = await request(pinned.url()).get(`${BASE}/${ID}`)
      expect(response.status).toBe(500)
      const lines = mocks.logged.mock.calls.map((call) => call.map(String).join(' '))
      expect(lines).toEqual([`error Directory integration capabilities read failed: ${expected}`])
    }
  })

  it('answers a stored value that cannot be shown with the fixed sentence', async () => {
    const query = vi.fn(async (sql: string) => {
      if (/to_regclass/.test(sql)) return { rows: [{ capabilities: true, history: true }], rowCount: 1 }
      if (/FROM directory_integrations/.test(sql)) return { rows: [integration()], rowCount: 1 }
      return { rows: [{ integration_id: ID, bound_provider: 'dingtalk', bound_org_id: 'default', revision: '9007199254740993', updated_at: new Date() }], rowCount: 1 }
    })
    pinned.setApp(buildApp(createAdminDirectoryCapabilitiesRouter({ service: serviceWith({ switchOn: true, query }) })))
    const response = await request(pinned.url()).get(`${BASE}/${ID}`)
    expect(response.status).toBe(500)
    expect(response.body.error.code).toBe('DIRECTORY_CAPABILITIES_INTERNAL')
  })

  it('answers 200 with the view in the success envelope, and writes no audit row', async () => {
    const query = vi.fn(answerWith())
    pinned.setApp(buildApp(createAdminDirectoryCapabilitiesRouter({ service: serviceWith({ switchOn: true, query }) })))
    const response = await request(pinned.url()).get(`${BASE}/${ID}`)
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(Object.keys(response.body.data).sort()).toEqual(['capabilities', 'integrationId', 'integrationStatus', 'provider', 'revision', 'updatedAt'])
    expect(Object.keys(response.body.data.capabilities).sort()).toEqual(['directory', 'login', 'notification'])
    expect(response.body.data.revision).toBe(0)
    expect(response.body.data.updatedAt).toBeNull()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('registers one GET and nothing else', () => {
    const router = createAdminDirectoryCapabilitiesRouter({ service: serviceWith({ switchOn: true, query: vi.fn() }) }) as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>
    }
    expect(router.stack.map((layer) => (layer.route ? `${Object.keys(layer.route.methods).join(',')} ${layer.route.path}` : 'layer'))).toEqual(['get /:integrationId'])
  })
})

describe('production router', () => {
  it('takes no argument and reads the switch on every request', async () => {
    expect(adminDirectoryCapabilitiesRouter.length).toBe(0)
    mocks.query.mockImplementation(answerWith())
    pinned.setApp(buildApp(adminDirectoryCapabilitiesRouter()))
    delete process.env[SWITCH]
    expect((await request(pinned.url()).get(`${BASE}/${ID}`)).status).toBe(404)
    for (const value of ['TRUE', '1', ' true', 'yes']) {
      process.env[SWITCH] = value
      expect((await request(pinned.url()).get(`${BASE}/${ID}`)).status).toBe(404)
    }
    expect(mocks.query).not.toHaveBeenCalled()
    process.env[SWITCH] = 'true'
    expect((await request(pinned.url()).get(`${BASE}/${ID}`)).status).toBe(200)
    process.env[SWITCH] = 'false'
    expect((await request(pinned.url()).get(`${BASE}/${ID}`)).status).toBe(404)
  })

  it('shows the production registry for a dingtalk integration and leaks no value of the row or the environment', async () => {
    const envNames = ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET', 'DINGTALK_REDIRECT_URI', 'DINGTALK_CORP_ID', 'DINGTALK_ALLOWED_CORP_IDS']
    const saved = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
    process.env.DINGTALK_CLIENT_ID = 'env-client-id-value'
    process.env.DINGTALK_CLIENT_SECRET = 'env-client-secret-value'
    process.env.DINGTALK_REDIRECT_URI = 'https://example.invalid/env-redirect'
    process.env.DINGTALK_CORP_ID = 'env-corp-value'
    process.env.DINGTALK_ALLOWED_CORP_IDS = 'env-corp-value,other-allowed-corp'
    try {
      process.env[SWITCH] = 'true'
      mocks.query.mockImplementation(answerWith())
      pinned.setApp(buildApp(adminDirectoryCapabilitiesRouter()))
      const response = await request(pinned.url()).get(`${BASE}/${ID}`)
      expect(response.status).toBe(200)
      const { capabilities } = response.body.data
      for (const capability of ['directory', 'login', 'notification']) {
        expect(capabilities[capability]).toMatchObject({ enabled: false, governance: 'legacy', effective: null, reason: 'governed_by_legacy_path' })
      }
      expect(capabilities.login.legacy).toEqual({ covers: 'oauth_scan_login_only', available: true, requireGrant: expect.any(Boolean), autoLinkEmail: expect.any(Boolean), autoProvision: expect.any(Boolean) })
      expect(Object.keys(capabilities.login.legacy).sort()).toEqual(['autoLinkEmail', 'autoProvision', 'available', 'covers', 'requireGrant'])
      for (const value of [CORP, APP_KEY, 'env-client-id-value', 'env-client-secret-value', 'example.invalid', 'env-corp-value', 'other-allowed-corp']) {
        expect(response.text).not.toContain(value)
      }
    } finally {
      for (const name of envNames) {
        if (saved[name] === undefined) delete process.env[name]
        else process.env[name] = saved[name]
      }
    }
  })

  it('shows an integration of an unregistered provider as not registered', async () => {
    process.env[SWITCH] = 'true'
    mocks.query.mockImplementation(answerWith({ integration: integration({ provider: 'local' }) }))
    pinned.setApp(buildApp(adminDirectoryCapabilitiesRouter()))
    const response = await request(pinned.url()).get(`${BASE}/${ID}`)
    expect(response.status).toBe(200)
    for (const capability of ['directory', 'login', 'notification']) {
      expect(response.body.data.capabilities[capability]).toEqual({
        enabled: false, governance: null, effective: null, reason: 'provider_not_registered', anchor: { bound: false, matchesCurrent: null },
      })
    }
  })
})

describe('handler structure', () => {
  const source = ts.createSourceFile(ROUTE_FILE, readFileSync(ROUTE_FILE, 'utf8'), ts.ScriptTarget.Latest, true)

  function getHandlerBody(): ts.Block {
    let body: ts.Block | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'get') {
        const handler = node.arguments[node.arguments.length - 1]
        if ((ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) && ts.isBlock(handler.body)) body = handler.body
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (!body) throw new Error('no GET handler found')
    return body
  }

  it('calls ensurePlatformAdmin first, outside the try block, and wraps every later statement in it', () => {
    const statements = getHandlerBody().statements
    expect(statements[0].getText(source)).toBe('const adminUserId = await ensurePlatformAdmin(req, res)')
    expect(statements[1].getText(source)).toBe('if (!adminUserId) return')
    expect(ts.isTryStatement(statements[2])).toBe(true)
    expect(statements).toHaveLength(3)
  })

  it('names no capability table and no environment variable', () => {
    const text = source.getFullText()
    expect(text).not.toMatch(/directory_integration_capabilit/)
    expect(text).not.toMatch(/process\.env/)
  })

  it('uses fixed sentences only', () => {
    expect(CAPABILITIES_DISABLED.code).toBe('DIRECTORY_CAPABILITIES_DISABLED')
    expect(CAPABILITIES_SCHEMA_UNAVAILABLE.code).toBe('DIRECTORY_CAPABILITIES_SCHEMA_UNAVAILABLE')
    expect(CAPABILITIES_INTERNAL.code).toBe('DIRECTORY_CAPABILITIES_INTERNAL')
  })
})
