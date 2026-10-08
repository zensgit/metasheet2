import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import {
  createElearningContentRouter,
  ELEARNING_CONTENT_PUBLISH_JSON_LIMIT_BYTES,
  ELEARNING_CONTENT_REVISION_JSON_LIMIT_BYTES,
  type ElearningContentRouteDeps,
} from '../../src/routes/elearning-content'
import {
  ElearningContentCoursePublishError,
  type PublishElearningContentCourseInput,
} from '../../src/services/elearning-content-course-publish'
import {
  ElearningContentRevisionStoreError,
  type CreateElearningContentRevisionInput,
} from '../../src/services/elearning-content-revision-postgres'
import {
  ElearningOpenCompletionStoreError,
  type RecordElearningOpenCompletionInput,
} from '../../src/services/elearning-open-completion-postgres'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-content-route'
const ACTOR = 'actor-content-route'
const REQUEST = '11111111-1111-4111-8111-111111111111'
const REVISION = '22222222-2222-4222-8222-222222222222'
const ITEM = '33333333-3333-4333-8333-333333333333'
const COURSE = '44444444-4444-4444-8444-444444444444'
const VERSION = '55555555-5555-4555-8555-555555555555'
const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
} as NodeJS.ProcessEnv

const REVISION_BODY = {
  requestId: REQUEST,
  itemType: 'article',
  title: 'Safe article',
  articleHtml: '<p>safe</p>',
  externalUrl: null,
}
const REVISION_RESULT = {
  contentRevisionId: REVISION,
  itemType: 'article' as const,
  title: 'Safe article',
  articleHtml: '<p>safe</p>',
  externalUrl: null,
  contentDigest: 'a'.repeat(64),
}
const PUBLISH_BODY = {
  requestId: REQUEST,
  title: 'Content course',
  items: [{ itemType: 'article', contentRevisionId: REVISION }],
}
const PUBLISH_RESULT = {
  courseId: COURSE,
  courseVersionId: VERSION,
  status: 'published' as const,
  itemCount: 1,
  items: [{
    itemId: ITEM,
    itemType: 'article' as const,
    contentRevisionId: REVISION,
    position: 1,
  }],
}
const OPEN_RESULT = {
  itemId: ITEM,
  itemType: 'article' as const,
  title: 'Safe article',
  articleHtml: '<p>safe</p>',
  externalUrl: null,
  status: 'completed' as const,
  completedAt: '2026-08-29T12:00:00.000Z',
  assurance: 'server_open' as const,
}

const pinned = usePinnedServer()

function createDb(): ElearningContentRouteDeps['db'] {
  return {
    transaction: async (handler) => handler({
      query: async () => ({ rows: [], rowCount: 0 }),
    }),
  }
}

function makeApp(over: {
  env?: NodeJS.ProcessEnv
  viewer?: string | null
  org?: string | null
  adminAllowed?: boolean
  readAllowed?: boolean
  revisionError?: ElearningContentRevisionStoreError
  publishError?: ElearningContentCoursePublishError
  openError?: ElearningOpenCompletionStoreError
} = {}) {
  const revisionCalls: CreateElearningContentRevisionInput[] = []
  const publishCalls: PublishElearningContentCourseInput[] = []
  const openCalls: RecordElearningOpenCompletionInput[] = []
  const order: string[] = []
  const app = express()
  const router = createElearningContentRouter({
    db: createDb(),
    env: over.env ?? { ...FLAG_ON },
    viewerId: () => over.viewer === undefined ? ACTOR : over.viewer,
    orgId: () => over.org === undefined ? ORG : over.org,
    adminGuard: (_req, res, next) => {
      order.push('admin')
      if (over.adminAllowed === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    readGuard: (_req, res, next) => {
      order.push('read')
      if (over.readAllowed === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    storeElearningContentRevision: async (_db, input) => {
      order.push('revision')
      revisionCalls.push(input)
      if (over.revisionError) throw over.revisionError
      return REVISION_RESULT
    },
    publishElearningContentCourse: async (_db, input) => {
      order.push('publish')
      publishCalls.push(input)
      if (over.publishError) throw over.publishError
      return PUBLISH_RESULT
    },
    recordElearningOpenCompletion: async (_db, input) => {
      order.push('open')
      openCalls.push(input)
      if (over.openError) throw over.openError
      return OPEN_RESULT
    },
  })
  if (router) app.use(router)
  pinned.setApp(app)
  return {
    api: request(pinned.url()),
    order,
    revisionCalls,
    publishCalls,
    openCalls,
  }
}

describe('elearning content routes', () => {
  it('mounts only for exact master plus CONTENT true', async () => {
    for (const env of [
      {},
      { ELEARNING_ENABLED: 'true' },
      { ELEARNING_ENABLED: 'true', ELEARNING_CONTENT_ENABLED: 'TRUE' },
      { ELEARNING_ENABLED: ' true', ELEARNING_CONTENT_ENABLED: 'true' },
    ]) {
      const { api } = makeApp({ env: env as NodeJS.ProcessEnv })
      expect((await api.post('/api/elearning/admin/content-revisions').send(REVISION_BODY)).status)
        .toBe(404)
    }
  })

  it('derives org and actor on all three commands and returns closed results', async () => {
    const state = makeApp()
    const revision = await state.api
      .post('/api/elearning/admin/content-revisions?orgId=evil&actorId=evil')
      .send(REVISION_BODY)
    const publish = await state.api
      .post('/api/elearning/admin/courses/content/publish?orgId=evil&actorId=evil')
      .send(PUBLISH_BODY)
    const open = await state.api
      .post(`/api/elearning/me/course-items/${ITEM}/open?orgId=evil&userId=evil`)
      .send({ requestId: REQUEST })

    expect(revision.status).toBe(201)
    expect(revision.body).toEqual(REVISION_RESULT)
    expect(publish.status).toBe(201)
    expect(publish.body).toEqual(PUBLISH_RESULT)
    expect(open.status).toBe(200)
    expect(open.body).toEqual(OPEN_RESULT)
    expect(state.revisionCalls).toEqual([{ orgId: ORG, actorId: ACTOR, ...REVISION_BODY }])
    expect(state.publishCalls).toEqual([{ orgId: ORG, actorId: ACTOR, ...PUBLISH_BODY }])
    expect(state.openCalls).toEqual([{
      orgId: ORG,
      userId: ACTOR,
      requestId: REQUEST,
      itemId: ITEM,
    }])
    expect(state.order).toEqual(['admin', 'revision', 'admin', 'publish', 'read', 'open'])
    expect(JSON.stringify({ revision: revision.body, publish: publish.body, open: open.body }))
      .not.toMatch(/orgId|actorId|userId|eventId|requestId|serverReceivedAt/)
  })

  it('requires identity then org then RBAC before parsing or service calls', async () => {
    const anonymous = makeApp({ viewer: null })
    expect((await anonymous.api.post('/api/elearning/admin/content-revisions').send('{')).status)
      .toBe(401)
    expect(anonymous.order).toEqual([])
    expect(anonymous.revisionCalls).toEqual([])

    const noOrg = makeApp({ org: null })
    const noOrgResponse = await noOrg.api
      .post('/api/elearning/admin/content-revisions')
      .send('{')
    expect(noOrgResponse.status).toBe(403)
    expect(noOrgResponse.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrg.order).toEqual([])

    const denied = makeApp({ adminAllowed: false })
    expect((await denied.api.post('/api/elearning/admin/content-revisions').send('{')).status)
      .toBe(403)
    expect(denied.order).toEqual(['admin'])
    expect(denied.revisionCalls).toEqual([])
  })

  it('rejects client identity, event and time fields plus malformed item ids', async () => {
    const state = makeApp()
    const invalidRevision = await state.api
      .post('/api/elearning/admin/content-revisions')
      .send({ ...REVISION_BODY, actorId: 'evil' })
    const invalidPublish = await state.api
      .post('/api/elearning/admin/courses/content/publish')
      .send({ ...PUBLISH_BODY, orgId: 'evil' })
    const invalidOpen = await state.api
      .post(`/api/elearning/me/course-items/${ITEM}/open`)
      .send({ requestId: REQUEST, completedAt: '2000-01-01T00:00:00.000Z' })
    const invalidItem = await state.api
      .post('/api/elearning/me/course-items/not-a-uuid/open')
      .send({ requestId: REQUEST })

    for (const response of [invalidRevision, invalidPublish, invalidOpen, invalidItem]) {
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_input' })
    }
    expect(state.revisionCalls).toEqual([])
    expect(state.publishCalls).toEqual([])
    expect(state.openCalls).toEqual([])
  })

  it('keeps bounded JSON parsers aligned with content and ordered publish payloads', async () => {
    expect(ELEARNING_CONTENT_PUBLISH_JSON_LIMIT_BYTES).toBe(1024 * 1024)
    expect(ELEARNING_CONTENT_REVISION_JSON_LIMIT_BYTES).toBe(8 * 1024 * 1024)
    const state = makeApp()
    const overPublish = `{${' '.repeat(ELEARNING_CONTENT_PUBLISH_JSON_LIMIT_BYTES)}}`
    const response = await state.api
      .post('/api/elearning/admin/courses/content/publish')
      .set('content-type', 'application/json')
      .send(overPublish)
    expect(response.status).toBe(413)
    expect(response.body).toEqual({ error: 'payload_too_large' })
    expect(state.publishCalls).toEqual([])
    expect(state.order).toEqual(['admin'])
  })

  it('maps domain failures to values-free statuses without leaking causes', async () => {
    const revision = makeApp({
      revisionError: new ElearningContentRevisionStoreError('conflict'),
    })
    expect((await revision.api.post('/api/elearning/admin/content-revisions').send(REVISION_BODY)).body)
      .toEqual({ error: 'conflict' })

    const publish = makeApp({
      publishError: new ElearningContentCoursePublishError('reference_unavailable'),
    })
    const publishResponse = await publish.api
      .post('/api/elearning/admin/courses/content/publish')
      .send(PUBLISH_BODY)
    expect(publishResponse.status).toBe(409)
    expect(publishResponse.body).toEqual({ error: 'reference_unavailable' })

    const open = makeApp({
      openError: new ElearningOpenCompletionStoreError('course_withdrawn'),
    })
    const openResponse = await open.api
      .post(`/api/elearning/me/course-items/${ITEM}/open`)
      .send({ requestId: REQUEST })
    expect(openResponse.status).toBe(409)
    expect(openResponse.body).toEqual({ error: 'course_withdrawn' })
    expect(JSON.stringify([publishResponse.body, openResponse.body])).not.toMatch(
      /evil|storage|html|url|digest|actor|org/i,
    )
  })
})
