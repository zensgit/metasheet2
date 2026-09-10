import express, { type RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElearningAppInstallationRouter, requireElearningAppInstallation } from '../../src/routes/elearning-app-installation'
import { changeElearningAppInstallation, readElearningAppInstallation } from '../../src/services/elearning-app-installation'
import type { ElearningAdminAccessDb } from '../../src/services/elearning-admin-access'
import { usePinnedServer } from '../utils/pinned-server'

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
