/**
 * GET and PATCH /api/admin/directory/integration-capabilities/:integrationId: the order of answers, the
 * fixed sentences, the shape of the view, the closed body allowlist, the typed write answers and the
 * production wiring. The administrator check answers first; the switch, the path, the body and the data
 * come after it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { usePinnedServer } from '../utils/pinned-server'

const mocks = vi.hoisted(() => ({ isRbacAdmin: vi.fn(), query: vi.fn(), transaction: vi.fn(), audit: vi.fn(), logged: vi.fn() }))
vi.mock('../../src/rbac/service', () => ({ isAdmin: mocks.isRbacAdmin }))
vi.mock('../../src/db/pg', () => ({ pool: null, query: mocks.query, transaction: mocks.transaction }))
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
  CAPABILITIES_BUSY,
  CAPABILITIES_DISABLED,
  CAPABILITIES_INTERNAL,
  CAPABILITIES_INVALID_INPUT,
  CAPABILITIES_SCHEMA_UNAVAILABLE,
  CAPABILITIES_STALE,
  CAPABILITY_REFUSAL_SENTENCES,
  INTEGRATION_ID_INVALID,
  INTEGRATION_NOT_FOUND,
  adminDirectoryCapabilitiesRouter,
  createAdminDirectoryCapabilitiesRouter,
} from '../../src/routes/admin-directory-capabilities'
import { createDirectoryIntegrationCapabilitiesService, type CapabilitiesServiceDeps } from '../../src/integrations/directory-integration-capabilities-service'
import {
  CAPABILITY_REFUSAL_CODES,
  createDirectoryIntegrationCapabilitiesWriteService,
  type CapabilitiesWriteServiceDeps,
  type CapabilityEnableGates,
} from '../../src/integrations/directory-integration-capabilities-write-service'
import { isCapabilityImplementationAvailable } from '../../src/integrations/integration-capability-implementations'
import {
  resolveProviderCapabilityDescriptor,
  scopeFromValues,
  type ProviderCapabilityDescriptor,
} from '../../src/integrations/provider-capability-registry'
import { importSpecifiers } from '../helpers/import-edge-allowlist'

const SRC = path.resolve(__dirname, '..', '..', 'src')
const ROUTE_FILE = path.join(SRC, 'routes', 'admin-directory-capabilities.ts')
const SIBLING_FILE = path.join(SRC, 'routes', 'admin-directory.ts')
const BASE = '/api/admin/directory/integration-capabilities'
const ID = '11111111-1111-4111-8111-111111111111'
const SWITCH = 'DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED'
const CORP = 'ding-corp-secret-id'
const APP_KEY = 'ding-app-key-secret'
/** Two opaque markers carried by the scripted driver text: no answer and no log line may hold either. */
const DRIVER_CREDENTIAL_MARKER = 'driver-credential-marker-q7x2m9'
const DRIVER_ENDPOINT_MARKER = 'driver-endpoint-marker-k4t8w1'
const DRIVER_TEXT = `password=${DRIVER_CREDENTIAL_MARKER} host=${DRIVER_ENDPOINT_MARKER}`
/** Carried by every URI sent in a field outside the allowlist: no answer may echo it. */
const REFUSED_URI_MARKER = 'refused-uri-marker-z3n6v5'

type Actor = 'anonymous' | 'admin' | 'plain'
type Row = Record<string, unknown>
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

const CAPABILITY_NAMES = ['directory', 'login', 'notification'] as const

function storedState(enabled: ReadonlyArray<(typeof CAPABILITY_NAMES)[number]>, overrides: Row = {}): Row {
  const row: Row = {
    integration_id: ID, bound_provider: 'dingtalk', bound_org_id: 'default', revision: '2',
    created_by: 'admin-0', updated_by: 'admin-0', created_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-02T00:00:00Z'),
  }
  for (const name of CAPABILITY_NAMES) {
    row[`${name}_enabled`] = enabled.includes(name)
    row[`${name}_bound_tenant`] = enabled.includes(name) ? CORP : null
    row[`${name}_bound_app_scope`] = enabled.includes(name) ? APP_KEY : null
  }
  return { ...row, ...overrides }
}

/**
 * Answers every statement of the write: the reads as `answerWith` does, the capability row from
 * `state`, and the insert and update by returning the row they would store.
 */
function writeAnswers(options: { tables?: boolean; integration?: Row | null; state?: Row | null; fail?: (sql: string) => Error | null } = {}) {
  let state = options.state ?? null
  const rows = (list: Row[]) => ({ rows: list, rowCount: list.length })
  return async (sql: string, params?: unknown[]) => {
    const failure = options.fail?.(sql)
    if (failure) throw failure
    if (/to_regclass/.test(sql)) return rows([{ capabilities: options.tables ?? true, history: options.tables ?? true }])
    if (/^INSERT INTO directory_integration_capability_history\b/.test(sql)) return rows([])
    if (/^INSERT INTO directory_integration_capabilities\b/.test(sql)) {
      const [integrationId, provider, org, ...rest] = params ?? []
      const row: Row = {
        integration_id: integrationId, bound_provider: provider, bound_org_id: org, revision: '1',
        created_by: rest[9], updated_by: rest[9], created_at: new Date('2026-11-20T00:00:00Z'), updated_at: new Date('2026-11-20T00:00:00Z'),
      }
      CAPABILITY_NAMES.forEach((name, index) => {
        row[`${name}_enabled`] = rest[index * 3]
        row[`${name}_bound_tenant`] = rest[index * 3 + 1]
        row[`${name}_bound_app_scope`] = rest[index * 3 + 2]
      })
      state = row
      return rows([row])
    }
    if (/^UPDATE directory_integration_capabilities\b/.test(sql)) {
      if (!state) return rows([])
      const next: Row = { ...state, revision: String(Number(state.revision) + 1), updated_at: new Date('2026-11-20T00:00:00Z') }
      for (const name of CAPABILITY_NAMES) {
        if (!sql.includes(`${name}_enabled = false`)) continue
        next[`${name}_enabled`] = false
        next[`${name}_bound_tenant`] = null
        next[`${name}_bound_app_scope`] = null
      }
      state = next
      return rows([next])
    }
    if (/FROM directory_integration_capabilities\b/.test(sql)) return rows(state ? [state] : [])
    if (/FROM directory_integrations\b/.test(sql)) {
      const row = options.integration === undefined ? integration() : options.integration
      return rows(row ? [row] : [])
    }
    return rows([])
  }
}

function buildApp(router: express.Router, json: Parameters<typeof express.json>[0] = { limit: '1kb' }): express.Express {
  const app = express()
  app.use(express.json(json))
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

type WriterOverrides = Partial<Pick<CapabilitiesWriteServiceDeps, 'resolveDescriptor' | 'isImplementationAvailable' | 'capabilityGates'>>

/** The write service over the same statement mock: one "transaction" is the handler run on that mock. */
function writerWith(options: { switchOn: boolean; query: ReturnType<typeof vi.fn> } & WriterOverrides) {
  const { switchOn, query, ...rest } = options
  return createDirectoryIntegrationCapabilitiesWriteService({
    isEnabled: () => switchOn,
    resolveDescriptor: resolveProviderCapabilityDescriptor,
    isImplementationAvailable: isCapabilityImplementationAvailable,
    readLoginRuntime: () => ({ available: false, requireGrant: false, autoLinkEmail: false, autoProvision: false }),
    isIntegrationScopedCredentialsEnabled: () => false,
    transaction: (work) => work({ query } as never),
    capabilityGates: {},
    audit: async (event) => {
      await mocks.audit(event)
    },
    ...rest,
  })
}

function routerWith(options: { switchOn: boolean; query: ReturnType<typeof vi.fn> } & WriterOverrides) {
  const { switchOn, query } = options
  return createAdminDirectoryCapabilitiesRouter({ service: serviceWith({ switchOn, query }), writer: writerWith(options) })
}

/** A provider registered only here, with every capability gated: the production registry has none. */
const ACME: ProviderCapabilityDescriptor = {
  provider: 'acme',
  governance: { directory: 'gated', login: 'gated', notification: 'gated' },
  scopeOf: (row) => scopeFromValues(row.corp_id, (row.config as { appKey?: string } | null)?.appKey ?? ''),
  enablePreconditions: async () => ({ ok: true }),
  secretConfigKeys: Object.freeze([]),
}
const withAcme: WriterOverrides = {
  resolveDescriptor: (provider) => (provider === 'acme' ? ACME : resolveProviderCapabilityDescriptor(provider)),
  isImplementationAvailable: (provider, capability) => provider === 'acme' || isCapabilityImplementationAvailable(provider, capability),
}

const patchBody = (expectedRevision: number, capabilities: Row) => ({ expectedRevision, capabilities })

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
  mocks.transaction.mockReset().mockImplementation(async (work: (client: { query: typeof mocks.query }) => Promise<unknown>) => work({ query: mocks.query }))
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
    pinned.setApp(buildApp(routerWith({ switchOn, query })))
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
      out[`${who}Patch`] = await snapshot(await request(pinned.url()).patch(`${BASE}/${ID}`).send(patchBody(0, { login: true })))
      out[`${who}PatchBadPath`] = await snapshot(await request(pinned.url()).patch(`${BASE}/not-a-uuid`).send(patchBody(0, { login: true })))
      out[`${who}PatchInvalidBody`] = await snapshot(await request(pinned.url()).patch(`${BASE}/${ID}`).send({ redirectUri: `urn:example:${REFUSED_URI_MARKER}`, capabilities: [] }))
      out[`${who}PatchMalformed`] = await snapshot(await request(pinned.url()).patch(`${BASE}/${ID}`).set('Content-Type', 'application/json').send('{"broken"'))
      out[`${who}PatchNullBody`] = await snapshot(await request(pinned.url()).patch(`${BASE}/${ID}`).set('Content-Type', 'application/json').send('null'))
      out[`${who}PatchOversize`] = await snapshot(await request(pinned.url()).patch(`${BASE}/${ID}`).set('Content-Type', 'application/json').send(JSON.stringify({ pad: 'x'.repeat(4096) })))
    }
    expect(query).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
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

  it('gives the same complete response to a PATCH with the switch on and off: valid, bad path, invalid body, malformed, null and oversize bodies', async () => {
    const off = await responses(false)
    const on = await responses(true)
    for (const who of ['anonymous', 'plain'] as const) {
      const gate = who === 'anonymous' ? 401 : 403
      for (const key of ['Patch', 'PatchBadPath', 'PatchInvalidBody']) {
        expect((off[`${who}${key}`] as { status: number }).status, `${who}${key}`).toBe(gate)
        expect(on[`${who}${key}`]).toEqual(off[`${who}${key}`])
      }
      // The body parser answers these before the route is reached, whoever the caller is.
      expect((off[`${who}PatchMalformed`] as { status: number }).status).toBe(400)
      expect((off[`${who}PatchNullBody`] as { status: number }).status).toBe(400)
      expect((off[`${who}PatchOversize`] as { status: number }).status).toBe(413)
    }
    expect(JSON.stringify(off)).not.toMatch(/DIRECTORY_CAPABILITIES_|CAPABILITY_|redirectUri/)
  })
})

describe('after the administrator check', () => {
  it('answers 404 with the fixed sentence while the switch is off, before looking at the path, and issues no statement', async () => {
    const query = vi.fn(answerWith())
    pinned.setApp(buildApp(routerWith({ switchOn: false, query })))
    for (const id of [ID, 'not-a-uuid']) {
      const response = await request(pinned.url()).get(`${BASE}/${id}`)
      expect(response.status).toBe(404)
      expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_DISABLED', message: 'Directory integration capabilities are not enabled' } })
    }
    expect(query).not.toHaveBeenCalled()
  })

  it('answers 400 for a path that is not a UUID, with the code and sentence of the sibling directory routes', async () => {
    const query = vi.fn(answerWith())
    pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
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
    pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
    const response = await request(pinned.url()).get(`${BASE}/${ID}`)
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_NOT_FOUND', message: 'Directory integration not found' } })
  })

  it('answers 503 when the capability tables are not present', async () => {
    const query = vi.fn(answerWith({ tables: false }))
    pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
    const response = await request(pinned.url()).get(`${BASE}/${ID}`)
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_SCHEMA_UNAVAILABLE', message: 'Directory integration capabilities are unavailable' } })
  })

  it('answers every unexpected failure with the fixed sentence and never the driver text', async () => {
    const secret = DRIVER_TEXT
    const failures: Array<(sql: string) => Error | null> = [
      (sql) => (/to_regclass/.test(sql) ? Object.assign(new Error(secret), { code: '57014' }) : null),
      (sql) => (/FROM directory_integrations/.test(sql) ? Object.assign(new Error(secret), { code: '40001' }) : null),
      (sql) => (/FROM directory_integrations/.test(sql) ? Object.assign(new Error(secret), { code: '55P03' }) : null),
      (sql) => (/FROM directory_integrations/.test(sql) ? new Error(secret) : null),
    ]
    for (const fail of failures) {
      const query = vi.fn(answerWith({ fail }))
      pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
      const response = await request(pinned.url()).get(`${BASE}/${ID}`)
      expect(response.status).toBe(500)
      expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_INTERNAL', message: 'Directory integration capabilities request failed' } })
      expect(response.text).not.toContain(DRIVER_CREDENTIAL_MARKER)
      expect(response.text).not.toContain(DRIVER_ENDPOINT_MARKER)
    }
  })

  it('logs only the error class name and the five-character SQLSTATE on a failure', async () => {
    const secret = DRIVER_TEXT
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
      pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
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
    pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
    const response = await request(pinned.url()).get(`${BASE}/${ID}`)
    expect(response.status).toBe(500)
    expect(response.body.error.code).toBe('DIRECTORY_CAPABILITIES_INTERNAL')
  })

  it('answers 200 with the view in the success envelope, and writes no audit row', async () => {
    const query = vi.fn(answerWith())
    pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
    const response = await request(pinned.url()).get(`${BASE}/${ID}`)
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(Object.keys(response.body.data).sort()).toEqual(['capabilities', 'integrationId', 'integrationStatus', 'provider', 'revision', 'updatedAt'])
    expect(Object.keys(response.body.data.capabilities).sort()).toEqual(['directory', 'login', 'notification'])
    expect(response.body.data.revision).toBe(0)
    expect(response.body.data.updatedAt).toBeNull()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('registers one GET and one PATCH on the same path and nothing else', () => {
    const router = routerWith({ switchOn: true, query: vi.fn() }) as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>
    }
    expect(router.stack.map((layer) => (layer.route ? `${Object.keys(layer.route.methods).join(',')} ${layer.route.path}` : 'layer'))).toEqual([
      'get /:integrationId',
      'patch /:integrationId',
    ])
  })
})

describe('PATCH after the administrator check: switch, path, integration and body', () => {
  const send = (body: unknown, id = ID) => request(pinned.url()).patch(`${BASE}/${id}`).send(body as object)
  const sendRaw = (text: string, id = ID) => request(pinned.url()).patch(`${BASE}/${id}`).set('Content-Type', 'application/json').send(text)

  it('answers 404 with the fixed sentence while the switch is off, before the path and the body, and issues no statement', async () => {
    const query = vi.fn(writeAnswers())
    pinned.setApp(buildApp(routerWith({ switchOn: false, query })))
    for (const [id, body] of [[ID, patchBody(0, { login: true })], ['not-a-uuid', patchBody(0, { login: true })], [ID, { redirectUri: 'x' }], [ID, []]] as const) {
      const response = await send(body, id)
      expect(response.status).toBe(404)
      expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_DISABLED', message: 'Directory integration capabilities are not enabled' } })
    }
    expect(query).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('answers 400 for a path that is not a UUID before reading anything, whatever the body', async () => {
    const query = vi.fn(writeAnswers())
    pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
    for (const body of [patchBody(0, { login: true }), { callbackUrl: 'x' }]) {
      const response = await send(body, 'not-a-uuid')
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_INTEGRATION_ID_INVALID', message: 'integrationId must be a UUID' } })
    }
    expect(query).not.toHaveBeenCalled()
  })

  it('answers 503 when the capability tables are not present, and 404 DIRECTORY_NOT_FOUND for a missing integration, before judging the body', async () => {
    for (const body of [patchBody(0, { login: true }), { redirectUri: 'x' }]) {
      pinned.setApp(buildApp(routerWith({ switchOn: true, query: vi.fn(writeAnswers({ tables: false })) })))
      const unavailable = await send(body)
      expect(unavailable.status).toBe(503)
      expect(unavailable.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_SCHEMA_UNAVAILABLE', message: 'Directory integration capabilities are unavailable' } })

      pinned.setApp(buildApp(routerWith({ switchOn: true, query: vi.fn(writeAnswers({ integration: null })) })))
      const missing = await send(body)
      expect(missing.status).toBe(404)
      expect(missing.body).toEqual({ ok: false, error: { code: 'DIRECTORY_NOT_FOUND', message: 'Directory integration not found' } })
    }
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('answers 422 with field tokens only for a body outside the closed allowlist, and writes nothing', async () => {
    const query = vi.fn(writeAnswers())
    pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
    const unknown: Array<[string, string]> = [
      ['redirectUri', JSON.stringify({ ...patchBody(0, { login: true }), redirectUri: `urn:example:${REFUSED_URI_MARKER}:back` })],
      ['callbackUrl', JSON.stringify({ ...patchBody(0, { login: true }), callbackUrl: `urn:example:${REFUSED_URI_MARKER}:hook` })],
      ['__proto__', '{"expectedRevision":0,"capabilities":{"login":true},"__proto__":{"isAdmin":true}}'],
      ['constructor', '{"expectedRevision":0,"capabilities":{"login":true,"constructor":true}}'],
      ['caller-chosen-key', '{"expectedRevision":0,"capabilities":{"login":true},"caller-chosen-key":1}'],
    ]
    for (const [name, text] of unknown) {
      const response = await sendRaw(text)
      expect(response.status, name).toBe(422)
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'DIRECTORY_CAPABILITIES_INVALID_INPUT', message: 'The capability change request is not valid', details: { fields: ['unknown_field'] } },
      })
      expect(response.text).not.toContain(name)
      expect(response.text).not.toContain(REFUSED_URI_MARKER)
    }
    const array = await send([patchBody(0, { login: true })])
    expect(array.status).toBe(422)
    expect(array.body.error.details).toEqual({ fields: ['body'] })
    const empty = await request(pinned.url()).patch(`${BASE}/${ID}`)
    expect(empty.status).toBe(422)
    expect(empty.body.error.details).toEqual({ fields: ['expectedRevision', 'capabilities'] })
    const wrongValues = await send({ expectedRevision: '0', capabilities: { login: 'yes' } })
    expect(wrongValues.status).toBe(422)
    expect(wrongValues.body.error.details).toEqual({ fields: ['expectedRevision', 'capabilities.login'] })
    const noCapability = await send({ expectedRevision: 0, capabilities: {} })
    expect(noCapability.body.error.details).toEqual({ fields: ['capabilities'] })

    const statements = query.mock.calls.map((call) => String(call[0]))
    expect(statements.some((sql) => /^(INSERT|UPDATE)\b/.test(sql))).toBe(false)
    expect(statements.some((sql) => /FOR (SHARE|UPDATE)/.test(sql))).toBe(false)
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('answers 422 for a null body where the parser lets one through; the default parser refuses it before the route', async () => {
    const query = vi.fn(writeAnswers())
    pinned.setApp(buildApp(routerWith({ switchOn: true, query }), { limit: '1kb', strict: false }))
    const lax = await sendRaw('null')
    expect(lax.status).toBe(422)
    expect(lax.body.error).toMatchObject({ code: 'DIRECTORY_CAPABILITIES_INVALID_INPUT', details: { fields: ['body'] } })
    const text = await sendRaw('"login"')
    expect(text.status).toBe(422)
    expect(text.body.error.details).toEqual({ fields: ['body'] })

    pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
    const strict = await sendRaw('null')
    expect(strict.status).toBe(400)
    expect(strict.body.error.code).toBe('BODY_REJECTED')
  })
})

describe('PATCH answers', () => {
  const send = (body: unknown) => request(pinned.url()).patch(`${BASE}/${ID}`).send(body as object)

  it('refuses to turn on a capability the production registry governs as legacy, and one of an unregistered provider', async () => {
    const cases: Array<[Row, string, string]> = [
      [integration(), 'CAPABILITY_GOVERNED_BY_LEGACY_PATH', 'The capability is governed by the existing switches and configuration'],
      [integration({ provider: 'local' }), 'CAPABILITY_PROVIDER_NOT_REGISTERED', 'The provider of this integration is not registered for capabilities'],
      [integration({ provider: 'wecom' }), 'CAPABILITY_PROVIDER_NOT_REGISTERED', 'The provider of this integration is not registered for capabilities'],
    ]
    for (const [row, code, message] of cases) {
      for (const capability of CAPABILITY_NAMES) {
        mocks.audit.mockClear()
        const query = vi.fn(writeAnswers({ integration: row }))
        pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
        const response = await send(patchBody(0, { [capability]: true }))
        expect(response.status).toBe(409)
        expect(response.body).toEqual({ ok: false, error: { code, message, details: { capability } } })
        expect(query.mock.calls.some((call) => /^(INSERT|UPDATE)\b/.test(String(call[0])))).toBe(false)
        expect(mocks.audit).toHaveBeenCalledTimes(1)
        expect(mocks.audit).toHaveBeenCalledWith({
          actorId: 'admin-1', actorType: 'user', action: 'directory.integration.capabilities.refused',
          resourceType: 'directory-integration-capabilities', resourceId: ID,
          meta: { provider: row.provider, actorId: 'admin-1', code, capability },
        })
        expect(response.text).not.toContain(CORP)
        expect(response.text).not.toContain(APP_KEY)
      }
    }
  })

  it('turns a capability off for an unregistered provider, and answers with the view', async () => {
    const query = vi.fn(writeAnswers({ integration: integration({ provider: 'local' }), state: storedState(['login'], { bound_provider: 'local' }) }))
    pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
    const response = await send(patchBody(2, { login: false }))
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.data).toMatchObject({ integrationId: ID, provider: 'local', revision: 3 })
    expect(response.body.data.capabilities.login).toEqual({ enabled: false, governance: null, effective: null, reason: 'provider_not_registered', anchor: { bound: false, matchesCurrent: null } })
    const statements = query.mock.calls.map((call) => String(call[0]))
    expect(statements.filter((sql) => /^UPDATE directory_integration_capabilities\b/.test(sql))).toHaveLength(1)
    expect(statements.filter((sql) => /^INSERT INTO directory_integration_capability_history\b/.test(sql))).toHaveLength(1)
    expect(mocks.audit).toHaveBeenCalledTimes(1)
    expect(mocks.audit.mock.calls[0][0]).toMatchObject({ action: 'directory.integration.capabilities.update', meta: { fromRevision: 2, toRevision: 3, changed: ['login'], anchorRebound: [] } })
  })

  it('answers 200 with revision zero and creates no row when an integration without a row is asked to turn everything off', async () => {
    const query = vi.fn(writeAnswers())
    pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
    const response = await send(patchBody(0, { directory: false, login: false, notification: false }))
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({ revision: 0, updatedAt: null })
    expect(query.mock.calls.some((call) => /^(INSERT|UPDATE)\b/.test(String(call[0])))).toBe(false)
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('answers 409 DIRECTORY_CAPABILITIES_STALE for another revision, before any refusal, with no audit row', async () => {
    const cases: Array<[Row | null, number]> = [[null, 1], [storedState(['login']), 0], [storedState(['login']), 3]]
    for (const [state, expectedRevision] of cases) {
      for (const capabilities of [{ login: true }, { login: false }]) {
        const query = vi.fn(writeAnswers({ state }))
        pinned.setApp(buildApp(routerWith({ switchOn: true, query })))
        const response = await send(patchBody(expectedRevision, capabilities))
        expect(response.status).toBe(409)
        expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_STALE', message: 'The capability state has changed; reload before applying' } })
      }
    }
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('turns a gated capability on with an injected registry: the GET shape, a history row and a values-free audit record', async () => {
    const row = integration({ provider: 'acme' })
    const query = vi.fn(writeAnswers({ integration: row }))
    pinned.setApp(buildApp(routerWith({ switchOn: true, query, ...withAcme })))
    const response = await send(patchBody(0, { login: true, notification: true }))
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(Object.keys(response.body.data).sort()).toEqual(['capabilities', 'integrationId', 'integrationStatus', 'provider', 'revision', 'updatedAt'])
    expect(Object.keys(response.body.data.capabilities).sort()).toEqual(['directory', 'login', 'notification'])
    expect(response.body.data).toMatchObject({ integrationId: ID, provider: 'acme', integrationStatus: 'active', revision: 1 })
    expect(typeof response.body.data.updatedAt).toBe('string')
    expect(response.body.data.capabilities.login).toEqual({ enabled: true, governance: 'gated', effective: true, reason: null, anchor: { bound: true, matchesCurrent: true } })
    expect(response.body.data.capabilities.directory).toEqual({ enabled: false, governance: 'gated', effective: false, reason: 'not_enabled', anchor: { bound: false, matchesCurrent: null } })
    expect(response.text).not.toContain(CORP)
    expect(response.text).not.toContain(APP_KEY)

    const history = query.mock.calls.find((call) => /^INSERT INTO directory_integration_capability_history\b/.test(String(call[0])))
    expect(history?.[1]).toEqual([ID, 'acme', 1, 'admin-1', ['login', 'notification'], [], false, true, true])

    expect(mocks.audit).toHaveBeenCalledTimes(1)
    const event = mocks.audit.mock.calls[0][0] as { meta: Row }
    expect(event).toEqual({
      actorId: 'admin-1', actorType: 'user', action: 'directory.integration.capabilities.update',
      resourceType: 'directory-integration-capabilities', resourceId: ID,
      meta: {
        provider: 'acme', actorId: 'admin-1', fromRevision: 0, toRevision: 1, changed: ['login', 'notification'], anchorRebound: [],
        directoryEnabled: false, loginEnabled: true, notificationEnabled: true,
      },
    })
    expect(JSON.stringify(event)).not.toMatch(new RegExp(`${CORP}|${APP_KEY}|corp_id|appKey`))
  })

  it('answers a failed precondition and a failed gate with 409 CAPABILITY_PRECONDITION_FAILED and their own fixed code, and writes nothing', async () => {
    const row = integration({ provider: 'acme' })
    const refusingProvider: ProviderCapabilityDescriptor = { ...ACME, enablePreconditions: async () => ({ ok: false, code: 'IDENTITY_NOT_VERIFIED' }) }
    const gates: CapabilityEnableGates = { login: [async () => ({ ok: false, code: 'ROUTING_POLICY_REQUIRED' })] }
    const cases: Array<[WriterOverrides, string]> = [
      [{ ...withAcme, resolveDescriptor: () => refusingProvider }, 'IDENTITY_NOT_VERIFIED'],
      [{ ...withAcme, capabilityGates: gates }, 'ROUTING_POLICY_REQUIRED'],
      // Both fail: the provider's own precondition answers.
      [{ ...withAcme, resolveDescriptor: () => refusingProvider, capabilityGates: gates }, 'IDENTITY_NOT_VERIFIED'],
    ]
    for (const [overrides, reason] of cases) {
      mocks.audit.mockClear()
      const query = vi.fn(writeAnswers({ integration: row }))
      pinned.setApp(buildApp(routerWith({ switchOn: true, query, ...overrides })))
      const response = await send(patchBody(0, { login: true }))
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'CAPABILITY_PRECONDITION_FAILED', message: 'An enable precondition is not met', details: { capability: 'login', reason } },
      })
      expect(query.mock.calls.some((call) => /^(INSERT|UPDATE)\b/.test(String(call[0])))).toBe(false)
      expect(mocks.audit.mock.calls.map((call) => (call[0] as { action: string; meta: Row }).meta)).toEqual([
        { provider: 'acme', actorId: 'admin-1', code: 'CAPABILITY_PRECONDITION_FAILED', capability: 'login' },
      ])
    }
  })

  it('answers the remaining refusals with their code, fixed sentence and capability', async () => {
    const taken = Object.assign(new Error('duplicate key value'), { code: '23505', constraint: 'dic_login_scope_uniq' })
    const anchor = Object.assign(new Error('check violation'), { code: '23514', constraint: 'dic_login_anchor_chk' })
    const onInsert = (failure: Error) => (sql: string) => (/^INSERT INTO directory_integration_capabilities\b/.test(sql) ? failure : null)
    const cases: Array<[Parameters<typeof writeAnswers>[0], WriterOverrides, string]> = [
      [{ integration: integration({ provider: 'acme' }) }, { ...withAcme, isImplementationAvailable: () => false }, 'CAPABILITY_IMPLEMENTATION_MISSING'],
      [{ integration: integration({ provider: 'acme', status: 'inactive' }) }, withAcme, 'CAPABILITY_INTEGRATION_INACTIVE'],
      [{ integration: integration({ provider: 'acme', config: { appKey: 'two words' } }) }, withAcme, 'CAPABILITY_SCOPE_INCOMPLETE'],
      [{ integration: integration({ provider: 'acme' }), fail: onInsert(anchor) }, withAcme, 'CAPABILITY_SCOPE_INCOMPLETE'],
      [{ integration: integration({ provider: 'acme' }), fail: onInsert(taken) }, withAcme, 'CAPABILITY_LOGIN_SCOPE_TAKEN'],
      [{ integration: integration({ provider: 'acme' }) }, { ...withAcme, resolveDescriptor: () => ({ ...ACME, governance: { ...ACME.governance, login: 'unsupported' } }) }, 'CAPABILITY_UNSUPPORTED'],
    ]
    for (const [world, overrides, code] of cases) {
      const query = vi.fn(writeAnswers(world))
      pinned.setApp(buildApp(routerWith({ switchOn: true, query, ...overrides })))
      const response = await send(patchBody(0, { login: true }))
      expect(response.status, code).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: { code, message: CAPABILITY_REFUSAL_SENTENCES[code as keyof typeof CAPABILITY_REFUSAL_SENTENCES], details: { capability: 'login' } },
      })
      expect(response.text).not.toMatch(/duplicate key|check violation|two words/)
    }
  })

  it('answers 503 DIRECTORY_CAPABILITIES_BUSY for a lost lock race or an exhausted time bound, with no audit row', async () => {
    const secret = DRIVER_TEXT
    const places: RegExp[] = [/FROM directory_integrations\b/, /FROM directory_integration_capabilities\b/, /^INSERT INTO directory_integration_capabilities\b/, /^INSERT INTO directory_integration_capability_history\b/]
    for (const code of ['55P03', '40P01', '40001', '57014']) {
      for (const place of places) {
        const query = vi.fn(writeAnswers({ integration: integration({ provider: 'acme' }), fail: (sql) => (place.test(sql) ? Object.assign(new Error(secret), { code }) : null) }))
        pinned.setApp(buildApp(routerWith({ switchOn: true, query, ...withAcme })))
        const response = await send(patchBody(0, { login: true }))
        expect(response.status, `${code} ${place}`).toBe(503)
        expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_BUSY', message: 'Directory integration capabilities are busy; retry later' } })
        expect(response.text).not.toContain(DRIVER_CREDENTIAL_MARKER)
      }
    }
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('answers every other failure with the fixed 500 sentence and never the driver text, with no audit row', async () => {
    const secret = DRIVER_TEXT
    const onRowWrite = /^INSERT INTO directory_integration_capabilities\b/
    const failures: Array<[RegExp, Error]> = [
      [onRowWrite, Object.assign(new Error(secret), { code: '55000' })],
      [onRowWrite, Object.assign(new Error(secret), { code: '23503', constraint: 'dic_integration_org_fk' })],
      [onRowWrite, Object.assign(new Error(secret), { code: '23514', constraint: 'dic_row_shape_chk' })],
      [onRowWrite, Object.assign(new Error(secret), { code: '23514', constraint: 'dic_revision_chk' })],
      [onRowWrite, Object.assign(new Error(secret), { code: '23505', constraint: 'dic_pkey' })],
      [/^INSERT INTO directory_integration_capability_history\b/, Object.assign(new Error(secret), { code: '55000' })],
      [/FROM directory_integrations\b/, Object.assign(new Error(secret), { code: '42P01' })],
      [/to_regclass/, new Error(secret)],
      [/^SET TRANSACTION/, Object.assign(new Error(secret), { code: '25001' })],
    ]
    for (const [place, failure] of failures) {
      const query = vi.fn(writeAnswers({ integration: integration({ provider: 'acme' }), fail: (sql) => (place.test(sql) ? failure : null) }))
      pinned.setApp(buildApp(routerWith({ switchOn: true, query, ...withAcme })))
      const response = await send(patchBody(0, { login: true }))
      expect(response.status, String(place)).toBe(500)
      expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_INTERNAL', message: 'Directory integration capabilities request failed' } })
      expect(response.text).not.toContain(DRIVER_CREDENTIAL_MARKER)
      expect(response.text).not.toContain(DRIVER_ENDPOINT_MARKER)
    }
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('logs only the error class name and the five-character SQLSTATE when a write fails', async () => {
    const secret = DRIVER_TEXT
    const cases: Array<[Error, string]> = [
      [Object.assign(new Error(secret), { code: '55000' }), 'Error 55000'],
      [Object.assign(new TypeError(secret), { code: 'too-long-code' }), 'TypeError'],
      [new RangeError(secret), 'RangeError'],
    ]
    for (const [failure, expected] of cases) {
      mocks.logged.mockClear()
      const query = vi.fn(writeAnswers({ integration: integration({ provider: 'acme' }), fail: (sql) => (/^INSERT INTO directory_integration_capabilities\b/.test(sql) ? failure : null) }))
      pinned.setApp(buildApp(routerWith({ switchOn: true, query, ...withAcme })))
      const response = await send(patchBody(0, { login: true }))
      expect(response.status).toBe(500)
      const lines = mocks.logged.mock.calls.map((call) => call.map(String).join(' '))
      expect(lines).toEqual([`error Directory integration capabilities write failed: ${expected}`])
    }
  })

  it('does not let a failing audit write change the answer', async () => {
    mocks.audit.mockRejectedValue(new Error('audit store unavailable'))
    const query = vi.fn(writeAnswers({ integration: integration({ provider: 'acme' }) }))
    pinned.setApp(buildApp(routerWith({ switchOn: true, query, ...withAcme })))
    const response = await send(patchBody(0, { login: true }))
    expect(response.status).toBe(200)
    expect(response.body.data.revision).toBe(1)
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

  it('reads the switch on every PATCH and opens no transaction while it is off', async () => {
    mocks.query.mockImplementation(writeAnswers())
    pinned.setApp(buildApp(adminDirectoryCapabilitiesRouter()))
    const send = () => request(pinned.url()).patch(`${BASE}/${ID}`).send(patchBody(0, { login: false }))
    delete process.env[SWITCH]
    expect((await send()).status).toBe(404)
    for (const value of ['TRUE', '1', ' true', 'yes', 'false']) {
      process.env[SWITCH] = value
      const response = await send()
      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('DIRECTORY_CAPABILITIES_DISABLED')
    }
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    process.env[SWITCH] = 'true'
    expect((await send()).status).toBe(200)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    process.env[SWITCH] = 'false'
    expect((await send()).status).toBe(404)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
  })

  it('runs the write in one transaction of the database module and records refusals through the audit module', async () => {
    process.env[SWITCH] = 'true'
    mocks.query.mockImplementation(writeAnswers())
    pinned.setApp(buildApp(adminDirectoryCapabilitiesRouter()))
    const response = await request(pinned.url()).patch(`${BASE}/${ID}`).send(patchBody(0, { login: true }))
    expect(response.status).toBe(409)
    expect(response.body.error).toEqual({
      code: 'CAPABILITY_GOVERNED_BY_LEGACY_PATH',
      message: 'The capability is governed by the existing switches and configuration',
      details: { capability: 'login' },
    })
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(String(mocks.query.mock.calls[0][0])).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(mocks.audit).toHaveBeenCalledWith({
      actorId: 'admin-1', actorType: 'user', action: 'directory.integration.capabilities.refused',
      resourceType: 'directory-integration-capabilities', resourceId: ID,
      meta: { provider: 'dingtalk', actorId: 'admin-1', code: 'CAPABILITY_GOVERNED_BY_LEGACY_PATH', capability: 'login' },
    })
  })

  it('cannot turn any capability on: dingtalk is legacy and every other provider is unregistered, and nothing is written', async () => {
    process.env[SWITCH] = 'true'
    for (const [provider, code] of [['dingtalk', 'CAPABILITY_GOVERNED_BY_LEGACY_PATH'], ['local', 'CAPABILITY_PROVIDER_NOT_REGISTERED'], ['wecom', 'CAPABILITY_PROVIDER_NOT_REGISTERED'], ['feishu', 'CAPABILITY_PROVIDER_NOT_REGISTERED']]) {
      for (const capabilities of [{ directory: true }, { login: true }, { notification: true }, { directory: true, login: true, notification: true }, { directory: false, notification: true }]) {
        mocks.query.mockReset().mockImplementation(writeAnswers({ integration: integration({ provider }) }))
        pinned.setApp(buildApp(adminDirectoryCapabilitiesRouter()))
        const response = await request(pinned.url()).patch(`${BASE}/${ID}`).send(patchBody(0, capabilities))
        expect(response.status, `${provider} ${JSON.stringify(capabilities)}`).toBe(409)
        expect(response.body.error.code).toBe(code)
        expect(mocks.query.mock.calls.some((call) => /^(INSERT|UPDATE)\b/.test(String(call[0])))).toBe(false)
      }
      mocks.query.mockReset().mockImplementation(writeAnswers({ integration: integration({ provider }) }))
      const off = await request(pinned.url()).patch(`${BASE}/${ID}`).send(patchBody(0, { directory: false, login: false, notification: false }))
      expect(off.status).toBe(200)
      expect(off.body.data.revision).toBe(0)
      expect(mocks.query.mock.calls.some((call) => /^(INSERT|UPDATE)\b/.test(String(call[0])))).toBe(false)
    }
  })

  it('binds the frozen empty gate table, the production registry and implementation table, and accepts none of them from a caller', () => {
    const text = readFileSync(ROUTE_FILE, 'utf8')
    expect(text).toContain('capabilityGates: PRODUCTION_CAPABILITY_ENABLE_GATES,')
    expect(text.match(/capabilityGates/g)).toHaveLength(1)
    expect(text).toContain('resolveDescriptor: resolveProviderCapabilityDescriptor,')
    expect(text).toContain('isImplementationAvailable: isCapabilityImplementationAvailable,')
    expect(text).toContain('export function adminDirectoryCapabilitiesRouter(): Router {')
    const specifiers = importSpecifiers(text, ROUTE_FILE)
    expect(specifiers.filter((specifier) => /integration-capability-resolve|lifecycle/.test(specifier))).toEqual([])
    expect(specifiers).toContain('../integrations/directory-integration-capabilities-write-service')
  })
})

describe('handler structure', () => {
  const source = ts.createSourceFile(ROUTE_FILE, readFileSync(ROUTE_FILE, 'utf8'), ts.ScriptTarget.Latest, true)

  function handlerBodyOf(method: 'get' | 'patch'): ts.Block {
    let body: ts.Block | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === method) {
        const handler = node.arguments[node.arguments.length - 1]
        if ((ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) && ts.isBlock(handler.body)) body = handler.body
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (!body) throw new Error(`no ${method.toUpperCase()} handler found`)
    return body
  }

  function getHandlerBody(): ts.Block {
    return handlerBodyOf('get')
  }

  it('calls ensurePlatformAdmin first, outside the try block, and wraps every later statement in it', () => {
    const statements = getHandlerBody().statements
    expect(statements[0].getText(source)).toBe('const adminUserId = await ensurePlatformAdmin(req, res)')
    expect(statements[1].getText(source)).toBe('if (!adminUserId) return')
    expect(ts.isTryStatement(statements[2])).toBe(true)
    expect(statements).toHaveLength(3)
  })

  it('gives the PATCH handler the same structure: the administrator check first and outside the try block, everything else inside it', () => {
    const statements = handlerBodyOf('patch').statements
    expect(statements[0].getText(source)).toBe('const adminUserId = await ensurePlatformAdmin(req, res)')
    expect(statements[1].getText(source)).toBe('if (!adminUserId) return')
    expect(ts.isTryStatement(statements[2])).toBe(true)
    expect(statements).toHaveLength(3)
    const tried = (statements[2] as ts.TryStatement).tryBlock.getText(source)
    expect(tried.indexOf('deps.writer.isEnabled()')).toBeGreaterThan(-1)
    expect(tried.indexOf('deps.writer.isEnabled()')).toBeLessThan(tried.indexOf('UUID_SHAPE_RE.test(integrationId)'))
    expect(tried.indexOf('UUID_SHAPE_RE.test(integrationId)')).toBeLessThan(tried.indexOf('deps.writer.patch('))
    expect(tried).toContain('deps.writer.patch(integrationId, req.body as unknown, adminUserId)')
  })

  it('answers the same non-administrator refusal as the sibling directory routes, from the same gate', () => {
    const text = source.getFullText()
    expect(text).toContain("import { ensurePlatformAdmin } from './admin-directory'")
    expect(text.match(/await ensurePlatformAdmin\(req, res\)/g)).toHaveLength(2)
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

  it('has one fixed code and sentence for each write answer, and one sentence for each refusal code', () => {
    expect(CAPABILITIES_INVALID_INPUT).toEqual({ code: 'DIRECTORY_CAPABILITIES_INVALID_INPUT', sentence: 'The capability change request is not valid' })
    expect(CAPABILITIES_STALE).toEqual({ code: 'DIRECTORY_CAPABILITIES_STALE', sentence: 'The capability state has changed; reload before applying' })
    expect(CAPABILITIES_BUSY).toEqual({ code: 'DIRECTORY_CAPABILITIES_BUSY', sentence: 'Directory integration capabilities are busy; retry later' })
    expect(Object.keys(CAPABILITY_REFUSAL_SENTENCES).sort()).toEqual([...CAPABILITY_REFUSAL_CODES].sort())
    expect(Object.isFrozen(CAPABILITY_REFUSAL_SENTENCES)).toBe(true)
    for (const sentence of Object.values(CAPABILITY_REFUSAL_SENTENCES)) expect(sentence.length).toBeGreaterThan(10)
    expect(new Set(Object.values(CAPABILITY_REFUSAL_SENTENCES)).size).toBe(CAPABILITY_REFUSAL_CODES.length)
  })

  it('answers every 5xx of the write with a literal status and a constant, never with a value taken from the caught error', () => {
    const text = handlerBodyOf('patch').getText(source)
    const fiveHundreds = [...text.matchAll(/jsonError\(res, (5\d\d), ([A-Z_]+)\.code, ([A-Z_]+)\.sentence\)/g)].map((match) => `${match[1]} ${match[2]} ${match[3]}`)
    expect(fiveHundreds).toEqual([
      '503 CAPABILITIES_SCHEMA_UNAVAILABLE CAPABILITIES_SCHEMA_UNAVAILABLE',
      '503 CAPABILITIES_BUSY CAPABILITIES_BUSY',
      '500 CAPABILITIES_INTERNAL CAPABILITIES_INTERNAL',
    ])
    expect(text.match(/jsonError\(res, 5/g)).toHaveLength(3)
    expect(text).not.toMatch(/error\.(message|stack)|String\(error\)/)
  })
})
