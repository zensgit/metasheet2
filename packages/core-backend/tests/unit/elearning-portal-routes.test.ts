import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningPortalRouter } from '../../src/routes/elearning-portal'
import {
  ElearningPortalSettingsError,
  type ElearningPortalSettings,
  type PublishElearningPortalSettingsInput,
} from '../../src/services/elearning-portal-settings'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-portal-route'
const ACTOR = 'actor-portal-route'
const REQUEST = '11111111-1111-4111-8111-111111111111'
const REVISION = '22222222-2222-4222-8222-222222222222'
const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
} as NodeJS.ProcessEnv
const SETTINGS: ElearningPortalSettings = {
  revisionId: REVISION,
  version: 2,
  siteName: 'MetaSheet Academy',
  tagline: 'Learn together',
  bannerUrl: '/assets/banner.png',
  navigation: [{ label: 'My courses', href: '/elearning' }],
  createdAt: '2026-08-30T01:02:03.456Z',
}
const BODY = {
  requestId: REQUEST,
  siteName: SETTINGS.siteName,
  tagline: SETTINGS.tagline,
  bannerUrl: SETTINGS.bannerUrl,
  navigation: SETTINGS.navigation,
}
const pinned = usePinnedServer()

function makeApp(over: {
  env?: NodeJS.ProcessEnv
  viewer?: string | null
  org?: string | null
  readAllowed?: boolean
  adminAllowed?: boolean
  readError?: ElearningPortalSettingsError
  publishError?: ElearningPortalSettingsError
} = {}) {
  const order: string[] = []
  const reads: string[] = []
  const publishes: PublishElearningPortalSettingsInput[] = []
  const router = createElearningPortalRouter({
    db: {
      query: async () => ({ rows: [], rowCount: 0 }),
      transaction: async (handler) => handler({
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
    },
    env: over.env ?? FLAG_ON,
    viewerId: () => over.viewer === undefined ? ACTOR : over.viewer,
    orgId: () => over.org === undefined ? ORG : over.org,
    readGuard: (_req, res, next) => {
      order.push('read-guard')
      if (over.readAllowed === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    adminGuard: (_req, res, next) => {
      order.push('admin-guard')
      if (over.adminAllowed === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    getActiveElearningPortalSettings: async (_db, orgId) => {
      order.push('read-service')
      reads.push(orgId)
      if (over.readError) throw over.readError
      return SETTINGS
    },
    publishElearningPortalSettings: async (_db, input) => {
      order.push('publish-service')
      publishes.push(input)
      if (over.publishError) throw over.publishError
      return { ...SETTINGS, duplicate: false }
    },
  })
  const app = express()
  if (router) app.use(router)
  pinned.setApp(app)
  return {
    mounted: router !== null,
    api: request(pinned.url()),
    order,
    reads,
    publishes,
  }
}

describe('e-learning portal routes', () => {
  it.each([
    {},
    { ELEARNING_ENABLED: 'true' },
    { ELEARNING_CONTENT_ENABLED: 'true' },
    { ELEARNING_ENABLED: 'true', ELEARNING_CONTENT_ENABLED: 'TRUE' },
    { ELEARNING_ENABLED: ' true', ELEARNING_CONTENT_ENABLED: 'true' },
  ])('does not mount unless master and content are exact true %#', (env) => {
    expect(makeApp({ env: env as NodeJS.ProcessEnv }).mounted).toBe(false)
  })

  it('derives organization and actor server-side and returns closed DTOs', async () => {
    const state = makeApp()
    const read = await state.api.get('/api/elearning/portal?orgId=evil')
    const publish = await state.api
      .put('/api/elearning/admin/portal?orgId=evil&actorId=evil')
      .send(BODY)

    expect(read.status).toBe(200)
    expect(read.body).toEqual(SETTINGS)
    expect(publish.status).toBe(200)
    expect(publish.body).toEqual({ ...SETTINGS, duplicate: false })
    expect(state.reads).toEqual([ORG])
    expect(state.publishes).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      ...BODY,
    }])
    expect(state.order).toEqual([
      'read-guard',
      'read-service',
      'admin-guard',
      'publish-service',
    ])
    expect(JSON.stringify({ read: read.body, publish: publish.body }))
      .not.toMatch(/orgId|actorId|requestId|requestHash/)
  })

  it('requires identity then organization then the correct RBAC guard', async () => {
    const anonymous = makeApp({ viewer: null })
    expect((await anonymous.api.get('/api/elearning/portal')).status).toBe(401)
    expect(anonymous.order).toEqual([])

    const noOrg = makeApp({ org: null })
    const noOrgResponse = await noOrg.api.get('/api/elearning/portal')
    expect(noOrgResponse.status).toBe(403)
    expect(noOrgResponse.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrg.order).toEqual([])

    const readDenied = makeApp({ readAllowed: false })
    expect((await readDenied.api.get('/api/elearning/portal')).status).toBe(403)
    expect(readDenied.order).toEqual(['read-guard'])
    expect(readDenied.reads).toEqual([])

    const adminDenied = makeApp({ adminAllowed: false })
    expect((await adminDenied.api.put('/api/elearning/admin/portal').send('{')).status)
      .toBe(403)
    expect(adminDenied.order).toEqual(['admin-guard'])
    expect(adminDenied.publishes).toEqual([])
  })

  it('rechecks the content flag on every request without calling guards or services', async () => {
    const env = { ...FLAG_ON }
    const state = makeApp({ env })
    env.ELEARNING_CONTENT_ENABLED = 'false'
    const read = await state.api.get('/api/elearning/portal')
    const publish = await state.api.put('/api/elearning/admin/portal').send(BODY)
    expect(read.status).toBe(404)
    expect(read.body).toEqual({ error: 'not_found' })
    expect(publish.status).toBe(404)
    expect(state.order).toEqual([])
    expect(state.reads).toEqual([])
    expect(state.publishes).toEqual([])
  })

  it('rejects malformed JSON and non-closed commands before service execution', async () => {
    const state = makeApp()
    const malformed = await state.api
      .put('/api/elearning/admin/portal')
      .set('content-type', 'application/json')
      .send('{')
    const extra = await state.api
      .put('/api/elearning/admin/portal')
      .send({ ...BODY, orgId: 'evil' })
    const missing = await state.api
      .put('/api/elearning/admin/portal')
      .send({ ...BODY, navigation: undefined })

    for (const response of [malformed, extra, missing]) {
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_input' })
    }
    expect(state.publishes).toEqual([])
    expect(state.order).toEqual(['admin-guard', 'admin-guard', 'admin-guard'])
  })

  it.each([
    ['invalid_input', 400],
    ['conflict', 409],
    ['unavailable', 503],
  ] as const)('maps %s to a values-free response', async (code, status) => {
    const state = makeApp({ publishError: new ElearningPortalSettingsError(code) })
    const response = await state.api.put('/api/elearning/admin/portal').send(BODY)
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ error: code })
    expect(JSON.stringify(response.body)).not.toMatch(/MetaSheet|portal-route|11111111/)
  })

  it('maps unexpected and read-store failures without leaking values', async () => {
    const read = await makeApp({
      readError: new ElearningPortalSettingsError('unavailable'),
    }).api.get('/api/elearning/portal')
    expect(read.status).toBe(503)
    expect(read.body).toEqual({ error: 'unavailable' })
  })
})
