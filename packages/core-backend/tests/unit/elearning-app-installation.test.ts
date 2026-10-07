import express, { type RequestHandler } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createElearningAppInstallationRouter,
  requireElearningAppInstallation,
  requireElearningEnabled,
} from '../../src/routes/elearning-app-installation'
import { changeElearningAppInstallation, readElearningAppInstallation } from '../../src/services/elearning-app-installation'
import type { ElearningAdminAccessDb } from '../../src/services/elearning-admin-access'
import { poolManager } from '../../src/integration/db/connection-pool'
import { usePinnedServer } from '../utils/pinned-server'

// Only the real-assembly block at the bottom of this file authenticates through the production
// middleware; every other case injects its own `authenticate`, so this mock is inert for them.
const authServiceMocks = vi.hoisted(() => ({ verifyToken: vi.fn() }))
vi.mock('../../src/auth/AuthService', () => ({ authService: authServiceMocks }))

const pinned = usePinnedServer()

function database() {
  let state: { status: string; config_json: { notificationsEnabled: boolean } } | null = null
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM user_orgs')) return { rows: [{ user_id: 'admin' }], rowCount: 1 }
    if (sql.includes('INSERT INTO platform_app_instances')) {
      state ??= { status: 'inactive', config_json: { notificationsEnabled: false } }
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE platform_app_instances')) {
      if (!state) return { rows: [], rowCount: 0 }
      state = { status: params![2] as string, config_json: { notificationsEnabled: params![3] as boolean } }
      return { rows: [{ id: 'instance' }], rowCount: 1 }
    }
    return { rows: state ? [state] : [], rowCount: state ? 1 : 0 }
  })
  const db: ElearningAdminAccessDb = {
    query,
    transaction: (work) => work({ query }),
  }
  return { db, query }
}
const actor = { orgId: 'org-a', actorId: 'admin', isGlobalAdmin: true }

describe('organization-scoped app installation', () => {
  test('missing remains uninstalled; install is inactive and notifications OFF; reinstall never changes state', async () => {
    const { db } = database()
    expect(await readElearningAppInstallation(db, actor.orgId)).toEqual({ status: 'not-installed', notificationsEnabled: false })
    expect(await changeElearningAppInstallation(db, actor)).toEqual({ status: 'inactive', notificationsEnabled: false })
    const enabled = { enabled: true, notificationsEnabled: true }
    expect(await changeElearningAppInstallation(db, actor, enabled)).toEqual({ status: 'active', notificationsEnabled: true })
    expect(await changeElearningAppInstallation(db, actor)).toEqual({ status: 'active', notificationsEnabled: true })
    expect(await changeElearningAppInstallation(db, actor, { ...enabled, enabled: false })).toEqual({ status: 'inactive', notificationsEnabled: false })
  })

  test('cannot enable missing instance or mutate without administrator authority', async () => {
    const { db, query } = database()
    await expect(changeElearningAppInstallation(db, { ...actor, isGlobalAdmin: false })).rejects.toMatchObject({ code: 'forbidden' })
    expect(query).not.toHaveBeenCalled()
    await expect(changeElearningAppInstallation(db, actor, { enabled: true, notificationsEnabled: false })).rejects.toMatchObject({ code: 'not_installed' })
  })

  test('active membership is locked and both registry organization keys are checked', async () => {
    const { db, query } = database()
    await changeElearningAppInstallation(db, actor)
    expect(query.mock.calls[0]).toEqual([expect.stringMatching(/is_active = true FOR SHARE/), ['org-a', 'admin']])
    expect(query.mock.calls.at(-1)).toEqual([expect.stringContaining('tenant_id = $1 AND workspace_id = $1'), ['org-a']])
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(changeElearningAppInstallation(db, actor)).rejects.toMatchObject({ code: 'forbidden' })
  })

  test.each(['failed', 'ACTIVE', null])('corrupt stored status %s fails closed', async (status) => {
    const { db, query } = database()
    query.mockResolvedValueOnce({ rows: [{ status, config_json: { notificationsEnabled: false } }] as never[], rowCount: 1 })
    await expect(readElearningAppInstallation(db, 'org-a')).rejects.toMatchObject({ code: 'unavailable' })
  })
})

function http() {
  const { db, query } = database()
  const auth: RequestHandler = (req, res, next) => {
    if (!req.headers.authorization) { res.status(401).json({ error: 'unauthenticated' }); return }
    req.user = { id: 'admin', role: req.headers.authorization === 'admin' ? 'admin' : 'user' } as typeof req.user
    if (req.headers.authorization !== 'tenantless') req.authenticatedTenantId = 'org-a'
    next()
  }
  const app = express()
  app.use(createElearningAppInstallationRouter({ getDb: () => db, authenticate: auth, adminGuard: (_req, _res, next) => next() }))
  const business = vi.fn((_req, res) => res.json({ ok: true }))
  app.use('/api/elearning', auth, requireElearningAppInstallation({ getDb: () => db, env: { ELEARNING_ENABLED: 'true' } }))
  app.get('/api/elearning/me/courses', business)
  return { app, db, query, business }
}
const PATH = '/api/elearning-app/installation'

test('HTTP requires authenticated authority and closed command; installed inactive cannot bypass business gate', async () => {
  const { app, business } = http()
  pinned.setApp(app)
  expect((await request(pinned.url()).post(PATH).send({})).status).toBe(401)
  expect((await request(pinned.url()).post(PATH).set('Authorization', 'tenantless').set('x-tenant-id', 'org-a').send({})).status).toBe(403)
  expect((await request(pinned.url()).post(PATH).set('Authorization', 'user').send({})).status).toBe(403)
  expect((await request(pinned.url()).post(PATH).set('Authorization', 'admin').send({ orgId: 'other' })).status).toBe(400)
  expect((await request(pinned.url()).post(PATH).set('Authorization', 'admin').send({})).body).toEqual({ status: 'inactive', notificationsEnabled: false, canManage: true })
  expect((await request(pinned.url()).get(PATH).set('Authorization', 'user')).body).toEqual({ status: 'inactive', notificationsEnabled: false, canManage: false })
  expect((await request(pinned.url()).get('/api/elearning/me/courses').set('Authorization', 'admin')).body).toEqual({ error: 'app_not_enabled' })
  expect(business).not.toHaveBeenCalled()
  expect((await request(pinned.url()).put(PATH).set('Authorization', 'admin').send({ enabled: 'true', notificationsEnabled: false })).status).toBe(400)
  expect((await request(pinned.url()).put(PATH).set('Authorization', 'admin').send({ enabled: true, notificationsEnabled: false })).status).toBe(200)
  expect((await request(pinned.url()).get('/api/elearning/me/courses').set('Authorization', 'admin')).body).toEqual({ ok: true })
  expect(business).toHaveBeenCalledTimes(1)
})

test('master OFF stays closed without querying installation', async () => {
  const { db, query } = database()
  const app = express()
  app.use(requireElearningAppInstallation({ getDb: () => db, env: {} }))
  pinned.setApp(app)
  expect((await request(pinned.url()).get('/')).status).toBe(404)
  expect(query).not.toHaveBeenCalled()
})

test('production admission covers pilot/plugin and signed playback; worker predicates precede LIMIT', () => {
  const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
  const index = source('src/index.ts')
  expect(index.indexOf("this.app.use('/api/elearning', authenticateElearningApp")).toBeLessThan(index.indexOf('this.app.use(elearningPilotRuntime.router)'))
  for (const file of ['../../plugins/plugin-elearning/lib/jobs.cjs', '../../plugins/plugin-elearning/lib/notification-worker.cjs']) {
    const text = source(file)
    expect(text.indexOf('FROM platform_app_instances app')).toBeGreaterThan(0)
    expect(text.indexOf('FROM platform_app_instances app')).toBeLessThan(text.indexOf('LIMIT $'))
    expect(text).toContain("app.status = 'active'")
  }
  expect(source('../../plugins/plugin-elearning/lib/notification-worker.cjs')).toContain("app.config_json->'notificationsEnabled' = 'true'::jsonb")
  expect(source('src/services/elearning-media-playback.ts')).toContain('app.tenant_id = i.org_id AND app.workspace_id = i.org_id')
})

/**
 * The installation surface while the 云课堂 master switch is off. Before this block the router was
 * mounted unconditionally (index.ts) and nothing in it read ELEARNING_ENABLED, so a global admin could
 * install and ACTIVATE the app while every /api/elearning/* route was unmounted. With the switch off,
 * every method now answers exactly what the business gate below answers for a switched-off feature
 * (`requireElearningAppInstallation`: 404 {"error":"feature_disabled"}) and touches no table.
 */
const OFF_SPELLINGS = [
  ['unset', undefined],
  ['empty', ''],
  ['TRUE', 'TRUE'],
  ['1', '1'],
  ['leading space', ' true'],
  ['trailing space', 'true '],
  ['false', 'false'],
] as const

function masterEnv(value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined ? {} : { ELEARNING_ENABLED: value }
}

function gatedHttp(env: NodeJS.ProcessEnv) {
  const { db, query } = database()
  const transaction = vi.spyOn(db, 'transaction')
  const auth: RequestHandler = (req, res, next) => {
    if (!req.headers.authorization) { res.status(401).json({ error: 'unauthenticated' }); return }
    req.user = { id: 'admin', role: req.headers.authorization === 'user' ? 'user' : 'admin' } as typeof req.user
    if (req.headers.authorization !== 'tenantless') req.authenticatedTenantId = 'org-a'
    next()
  }
  const app = express()
  app.use(createElearningAppInstallationRouter({
    getDb: () => db,
    authenticate: auth,
    adminGuard: (_req, _res, next) => next(),
    featureGate: requireElearningEnabled({ env }),
  }))
  return { app, query, transaction }
}

describe('installation surface while ELEARNING_ENABLED is off', () => {
  test.each(OFF_SPELLINGS)('master %s: POST, PUT and GET answer 404 feature_disabled for every caller and issue no statement', async (_label, value) => {
    const { app, query, transaction } = gatedHttp(masterEnv(value))
    pinned.setApp(app)
    const refused = { error: 'feature_disabled' }

    // Soft, so that the statement assertions at the end are evaluated even when an answer is wrong.
    const post = await request(pinned.url()).post(PATH).set('Authorization', 'admin').send({})
    expect.soft([post.status, post.body]).toEqual([404, refused])
    const put = await request(pinned.url()).put(PATH).set('Authorization', 'admin').send({ enabled: true, notificationsEnabled: true })
    expect.soft([put.status, put.body]).toEqual([404, refused])
    // GET gives the same answer to every authenticated caller, so it cannot tell whether a row exists.
    for (const caller of ['admin', 'user', 'tenantless']) {
      const get = await request(pinned.url()).get(PATH).set('Authorization', caller)
      expect.soft([get.status, get.body]).toEqual([404, refused])
    }
    const tenantlessPost = await request(pinned.url()).post(PATH).set('Authorization', 'tenantless').send({})
    expect.soft([tenantlessPost.status, tenantlessPost.body]).toEqual([404, refused])
    // Authentication still comes first: an anonymous caller learns nothing about the switch.
    expect.soft((await request(pinned.url()).post(PATH).send({})).status).toBe(401)

    expect(query).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  test('the refusal is byte-for-byte the business gate\'s own switched-off answer', async () => {
    const business = express()
    business.use(requireElearningAppInstallation({ getDb: () => database().db, env: {} }))
    pinned.setApp(business)
    const reference = await request(pinned.url()).get('/api/elearning/me/courses')

    pinned.setApp(gatedHttp({}).app)
    const installation = await request(pinned.url()).post(PATH).set('Authorization', 'admin').send({})
    expect([installation.status, installation.body]).toEqual([reference.status, reference.body])
    expect(reference.status).toBe(404)
  })

  test('master exact true (positive control): install, enable and read work and write as before', async () => {
    const { app, query } = gatedHttp({ ELEARNING_ENABLED: 'true' })
    pinned.setApp(app)
    expect((await request(pinned.url()).post(PATH).set('Authorization', 'admin').send({})).body)
      .toEqual({ status: 'inactive', notificationsEnabled: false, canManage: true })
    expect((await request(pinned.url()).put(PATH).set('Authorization', 'admin').send({ enabled: true, notificationsEnabled: false })).body)
      .toEqual({ status: 'active', notificationsEnabled: false, canManage: true })
    expect((await request(pinned.url()).get(PATH).set('Authorization', 'user')).body)
      .toEqual({ status: 'active', notificationsEnabled: false, canManage: false })
    const statements = query.mock.calls.map(([sql]) => String(sql))
    expect(statements.some((sql) => sql.includes('INSERT INTO platform_app_instances'))).toBe(true)
    expect(statements.some((sql) => sql.includes('UPDATE platform_app_instances'))).toBe(true)
  })

  test('master exact true: the authority sequence of the ungated suite above is unchanged behind the gate', async () => {
    // Same requests, same expected answers as 'HTTP requires authenticated authority and closed
    // command; installed inactive cannot bypass business gate', with the production gate in front
    // and the switch on: authentication, tenant from the verified claim only (a raw x-tenant-id
    // header does not stand in for it), administrator authority, closed commands, business gate.
    const { db } = database()
    const auth: RequestHandler = (req, res, next) => {
      if (!req.headers.authorization) { res.status(401).json({ error: 'unauthenticated' }); return }
      req.user = { id: 'admin', role: req.headers.authorization === 'admin' ? 'admin' : 'user' } as typeof req.user
      if (req.headers.authorization !== 'tenantless') req.authenticatedTenantId = 'org-a'
      next()
    }
    const on = { ELEARNING_ENABLED: 'true' }
    const app = express()
    app.use(createElearningAppInstallationRouter({
      getDb: () => db, authenticate: auth, adminGuard: (_req, _res, next) => next(), featureGate: requireElearningEnabled({ env: on }),
    }))
    const business = vi.fn((_req, res) => res.json({ ok: true }))
    app.use('/api/elearning', auth, requireElearningAppInstallation({ getDb: () => db, env: on }))
    app.get('/api/elearning/me/courses', business)
    pinned.setApp(app)

    expect((await request(pinned.url()).post(PATH).send({})).status).toBe(401)
    expect((await request(pinned.url()).post(PATH).set('Authorization', 'tenantless').set('x-tenant-id', 'org-a').send({})).status).toBe(403)
    expect((await request(pinned.url()).post(PATH).set('Authorization', 'user').send({})).status).toBe(403)
    expect((await request(pinned.url()).post(PATH).set('Authorization', 'admin').send({ orgId: 'other' })).status).toBe(400)
    expect((await request(pinned.url()).post(PATH).set('Authorization', 'admin').send({})).body).toEqual({ status: 'inactive', notificationsEnabled: false, canManage: true })
    expect((await request(pinned.url()).get(PATH).set('Authorization', 'user')).body).toEqual({ status: 'inactive', notificationsEnabled: false, canManage: false })
    expect((await request(pinned.url()).get('/api/elearning/me/courses').set('Authorization', 'admin')).body).toEqual({ error: 'app_not_enabled' })
    expect(business).not.toHaveBeenCalled()
    expect((await request(pinned.url()).put(PATH).set('Authorization', 'admin').send({ enabled: 'true', notificationsEnabled: false })).status).toBe(400)
    expect((await request(pinned.url()).put(PATH).set('Authorization', 'admin').send({ enabled: true, notificationsEnabled: false })).status).toBe(200)
    expect((await request(pinned.url()).get('/api/elearning/me/courses').set('Authorization', 'admin')).body).toEqual({ ok: true })
    expect(business).toHaveBeenCalledTimes(1)
  })
})

/**
 * The same, through the REAL assembly: `new MetaSheetServer()` runs index.ts `setupMiddleware`, so
 * these requests go through the production mount, the production `authenticate`
 * (AuthService.verifyToken mocked above) and the production gate wiring. Dropping the gate from the
 * index.ts mount reddens the first case.
 */
describe('real app assembly: installation surface and the master switch', () => {
  const PATH_UNDER_TEST = '/api/elearning-app/installation'
  let savedMaster: string | undefined
  let hadMaster = false

  beforeEach(() => {
    hadMaster = Object.prototype.hasOwnProperty.call(process.env, 'ELEARNING_ENABLED')
    savedMaster = process.env.ELEARNING_ENABLED
    authServiceMocks.verifyToken.mockReset()
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.test',
      name: 'Admin',
      role: 'admin',
      permissions: ['*:*'],
      tenantId: 'org-a',
    })
  })

  afterEach(() => {
    if (hadMaster) process.env.ELEARNING_ENABLED = savedMaster
    else delete process.env.ELEARNING_ENABLED
    vi.restoreAllMocks()
  })

  async function realApp(master: string | undefined) {
    if (master === undefined) delete process.env.ELEARNING_ENABLED
    else process.env.ELEARNING_ENABLED = master
    const { MetaSheetServer } = await import('../../src/index')
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const app = (server as unknown as { app: Parameters<typeof pinned.setApp>[0] }).app
    pinned.setApp(app)
    return vi.spyOn(poolManager, 'get')
  }

  test('master unset: a global admin with a tenant claim cannot install, activate or probe; no pool is even asked for', async () => {
    const getPool = await realApp(undefined)
    const refused = { error: 'feature_disabled' }
    const auth = { Authorization: 'Bearer live-token' }

    const post = await request(pinned.url()).post(PATH_UNDER_TEST).set(auth).send({})
    expect.soft([post.status, post.body]).toEqual([404, refused])
    const put = await request(pinned.url()).put(PATH_UNDER_TEST).set(auth).send({ enabled: true, notificationsEnabled: true })
    expect.soft([put.status, put.body]).toEqual([404, refused])
    const get = await request(pinned.url()).get(PATH_UNDER_TEST).set(auth)
    expect.soft([get.status, get.body]).toEqual([404, refused])
    expect(getPool).not.toHaveBeenCalled()

    expect((await request(pinned.url()).post(PATH_UNDER_TEST).send({})).status).toBe(401)
  }, 120_000)

  test('master exact true (positive control): the same request passes the gate and reaches the router\'s own validation', async () => {
    const getPool = await realApp('true')
    const auth = { Authorization: 'Bearer live-token' }

    const post = await request(pinned.url()).post(PATH_UNDER_TEST).set(auth).send({ bogus: true })
    expect([post.status, post.body]).toEqual([400, { error: 'invalid_input' }])
    const put = await request(pinned.url()).put(PATH_UNDER_TEST).set(auth).send({ enabled: 'yes' })
    expect([put.status, put.body]).toEqual([400, { error: 'invalid_input' }])
    expect(getPool).not.toHaveBeenCalled()
  }, 120_000)
})
