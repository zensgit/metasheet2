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
import {
  searchElearningAssignees,
  type SearchElearningAssigneesInput,
} from '../../src/services/elearning-assignee-directory'
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
  assigneeRows?: Array<Record<string, unknown>>
} = {}) {
  const revisionCalls: CreateElearningContentRevisionInput[] = []
  const searchCalls: SearchElearningAssigneesInput[] = []
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
    searchElearningAssignees: async (_db, input) => {
      order.push('search')
      searchCalls.push(input)
      // Deliberately over-wide rows: the route must still answer id + name + email only.
      return { items: (over.assigneeRows ?? []) as never }
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
    searchCalls,
  }
}

interface CapturedQuery {
  sql: string
  params: unknown[]
}

function captureDb(rows: Array<Record<string, unknown>>): {
  db: ElearningContentRouteDeps['db']
  queries: CapturedQuery[]
} {
  const queries: CapturedQuery[] = []
  return {
    queries,
    db: {
      transaction: async (handler) => handler({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params })
          return { rows, rowCount: rows.length }
        },
      }),
    },
  }
}

describe('elearning assignee search (F13 picker)', () => {
  it('runs flags -> identity -> org -> adminGuard before the lookup', async () => {
    for (const env of [{}, { ELEARNING_ENABLED: 'true' }]) {
      const off = makeApp({ env: env as NodeJS.ProcessEnv })
      expect((await off.api.get('/api/elearning/admin/assignees?q=a')).status).toBe(404)
      expect(off.searchCalls).toEqual([])
    }

    const anonymous = makeApp({ viewer: null })
    expect((await anonymous.api.get('/api/elearning/admin/assignees?q=a')).status).toBe(401)
    expect(anonymous.order).toEqual([])
    expect(anonymous.searchCalls).toEqual([])

    const noOrg = makeApp({ org: null })
    const noOrgResponse = await noOrg.api.get('/api/elearning/admin/assignees?q=a')
    expect(noOrgResponse.status).toBe(403)
    expect(noOrgResponse.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrg.order).toEqual([])
    expect(noOrg.searchCalls).toEqual([])

    const denied = makeApp({ adminAllowed: false })
    expect((await denied.api.get('/api/elearning/admin/assignees?q=a')).status).toBe(403)
    expect(denied.order).toEqual(['admin'])
    expect(denied.searchCalls).toEqual([])

    // The learner read guard is not enough: a reader is never asked.
    const readerOnly = makeApp({ adminAllowed: false, readAllowed: true })
    expect((await readerOnly.api.get('/api/elearning/admin/assignees')).status).toBe(403)
    expect(readerOnly.order).not.toContain('read')
  })

  it('passes the JWT-bound org, the trimmed term and the limit, and answers id + name + email only', async () => {
    const state = makeApp({
      assigneeRows: [
        { id: 'user-1', name: 'Alice', email: 'alice@example.test', role: 'admin', is_admin: true, mobile: '1' },
        { id: 'user-2', name: null, email: null },
      ],
    })
    const response = await state.api.get('/api/elearning/admin/assignees?q=%20ali%20&limit=5')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      items: [
        { id: 'user-1', name: 'Alice', email: 'alice@example.test' },
        { id: 'user-2', name: null, email: null },
      ],
    })
    expect(state.searchCalls).toEqual([{ orgId: ORG, query: 'ali', limit: 5 }])
    expect(state.order).toEqual(['admin', 'search'])

    const empty = makeApp()
    expect((await empty.api.get('/api/elearning/admin/assignees')).status).toBe(200)
    expect(empty.searchCalls).toEqual([{ orgId: ORG, query: '', limit: 20 }])
  })

  it('rejects a client-supplied org or any other unknown / malformed query without calling the lookup', async () => {
    const state = makeApp()
    for (const path of [
      '/api/elearning/admin/assignees?q=a&orgId=evil',
      '/api/elearning/admin/assignees?q=a&tenantId=evil',
      '/api/elearning/admin/assignees?q=a&q=b',
      '/api/elearning/admin/assignees?q[]=a',
      '/api/elearning/admin/assignees?limit=0',
      '/api/elearning/admin/assignees?limit=51',
      '/api/elearning/admin/assignees?limit=5.5',
      '/api/elearning/admin/assignees?limit=abc',
      `/api/elearning/admin/assignees?q=${'x'.repeat(101)}`,
      '/api/elearning/admin/assignees?q=a%00b',
    ]) {
      const response = await state.api.get(path)
      expect(response.status, path).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_input' })
    }
    expect(state.searchCalls).toEqual([])
    expect((await state.api.get(`/api/elearning/admin/assignees?q=${'x'.repeat(100)}&limit=50`)).status)
      .toBe(200)
  })

  it('reads only active members of the given org, by name or email, with LIKE metacharacters escaped', async () => {
    const { db, queries } = captureDb([
      { id: 'user-1', name: 'Alice', email: 'alice@example.test' },
      { id: 'user-2', name: '  ', email: '' },
      { id: '', name: 'No id', email: 'x@example.test' },
      { id: null, name: 'Null id', email: null },
    ])
    const result = await searchElearningAssignees(db, {
      orgId: ORG,
      query: ' 50%_off\\ ',
      limit: 7,
    })
    expect(result).toEqual({
      items: [
        { id: 'user-1', name: 'Alice', email: 'alice@example.test' },
        { id: 'user-2', name: null, email: null },
      ],
    })
    expect(queries).toHaveLength(1)
    const [{ sql, params }] = queries
    expect(params).toEqual([
      ORG,
      '50%_off\\',
      '%50\\%\\_off\\\\%',
      7,
      ['%@placeholder.local', '%@migration-revert.local', '%@trusted-token.local'],
    ])
    const compact = sql.replace(/\s+/g, ' ')
    expect(compact).toContain('JOIN user_orgs membership ON membership.user_id = platform_user.id AND membership.org_id = $1 AND membership.is_active = TRUE')
    expect(compact).toContain('WHERE platform_user.is_active = TRUE')
    expect(compact).toContain("COALESCE(platform_user.name, '') ILIKE $3 ESCAPE '\\'")
    // Placeholder mailboxes are neither matched nor projected.
    expect(compact).toContain("( COALESCE(platform_user.email, '') ILIKE $3 ESCAPE '\\' AND NOT lower(COALESCE(platform_user.email, '')) LIKE ANY($5::text[]) )")
    expect(compact).toContain("CASE WHEN lower(COALESCE(platform_user.email, '')) LIKE ANY($5::text[]) THEN NULL ELSE platform_user.email END AS email")
    expect(compact).toContain('LIMIT $4')
    expect(compact).toMatch(/^\/\* elearning-assignee-directory:search \*\/ SELECT platform_user\.id, platform_user\.name, CASE WHEN /)
    expect(compact).toContain(' END AS email FROM users platform_user ')
    expect(compact).not.toMatch(/is_admin|mobile|department|last_login|password|role/i)
  })

  it('never returns a placeholder mailbox and clamps the limit even when called directly', async () => {
    const { db, queries } = captureDb([
      { id: 'dt-1', name: '钉钉用户', email: 'dingtalk_union123@placeholder.local' },
      { id: 'dt-2', name: null, email: 'DingTalk_Open9@PLACEHOLDER.LOCAL ' },
      { id: 'mig-1', name: 'Migrated', email: 'mig-1@migration-revert.local' },
      { id: 'tok-1', name: 'Token', email: 'tok-1@trusted-token.local' },
      { id: 'real-1', name: 'Real', email: 'real@placeholder.local.example.test' },
    ])
    const result = await searchElearningAssignees(db, { orgId: ORG, query: 'a', limit: 500 })
    expect(result.items).toEqual([
      { id: 'dt-1', name: '钉钉用户', email: null },
      { id: 'dt-2', name: null, email: null },
      { id: 'mig-1', name: 'Migrated', email: null },
      { id: 'tok-1', name: 'Token', email: null },
      { id: 'real-1', name: 'Real', email: 'real@placeholder.local.example.test' },
    ])
    expect(JSON.stringify(result)).not.toMatch(/placeholder\.local"|migration-revert|trusted-token|union123|Open9/i)
    expect(queries[0]?.params[3]).toBe(50)
    for (const [limit, expected] of [[0, 1], [-3, 1], [7.9, 7], [Number.NaN, 20]] as const) {
      const run = captureDb([])
      await searchElearningAssignees(run.db, { orgId: ORG, query: '', limit })
      expect(run.queries[0]?.params[3]).toBe(expected)
    }
  })
})

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
