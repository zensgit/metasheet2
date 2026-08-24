import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import { isElearningWatchSurfaceEnabled } from '../../src/elearning/feature-flags'
import { createElearningPilotRouter } from '../../src/routes/elearning-pilot'
import {
  ElearningDirectAssignmentError,
  type ElearningDirectAssignmentDb,
  type ElearningDirectAssignmentErrorCode,
  type ElearningDirectAssignmentResult,
  type AssignElearningDirectInput,
} from '../../src/services/elearning-direct-assignment'
import {
  ElearningWatchError,
  type ElearningWatchDb,
  type ElearningWatchErrorCode,
  type ElearningWatchState,
  type RecordElearningHeartbeatInput,
  type StartElearningWatchInput,
} from '../../src/services/elearning-watch-progress'
import { usePinnedServer } from '../utils/pinned-server'

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
  ELEARNING_MEDIA_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv

const FLAG_NAMES = [
  'ELEARNING_ENABLED',
  'ELEARNING_CONTENT_ENABLED',
  'ELEARNING_ASSIGNMENT_ENABLED',
  'ELEARNING_MEDIA_ENABLED',
] as const

const LOOKALIKES: Array<string | undefined> = [
  undefined, '', 'false', 'FALSE', '0', '1', 'yes', 'on', 'TRUE', 'True', ' true', 'true ',
]

const ORG = 'org-pilot-1'
const ACTOR = 'actor-pilot-1'
const TARGET = 'user-pilot-1'
const SOURCE = 'src-pilot-1'
const VERSION = '11111111-1111-4111-8111-111111111111'
const ITEM = '22222222-2222-4222-8222-222222222222'
const SESSION = '33333333-3333-4333-8333-333333333333'
const ASSIGNMENT_ID = '44444444-4444-4444-8444-444444444444'
const MEMBER_ID = '55555555-5555-4555-8555-555555555555'

const ASSIGN_BODY = {
  targetUserId: TARGET,
  courseVersionId: VERSION,
  sourceKey: SOURCE,
}

const WATCH_STATE: ElearningWatchState = {
  sessionId: SESSION,
  status: 'in_progress',
  lastSequence: 1,
  lastClientPositionMs: 1000,
  effectiveMs: 1000,
  maxPositionMs: 1000,
  durationMs: 10_000,
  creditedMs: 1000,
  duplicate: false,
}

const ASSIGN_RESULT: ElearningDirectAssignmentResult = {
  assignmentId: ASSIGNMENT_ID,
  memberId: MEMBER_ID,
  duplicate: false,
}

const ASSIGNMENT_ERRORS: Array<[ElearningDirectAssignmentErrorCode, number]> = [
  ['invalid_input', 400],
  ['not_found', 404],
  ['target_unavailable', 409],
  ['course_unavailable', 409],
  ['conflict', 409],
  ['unavailable', 503],
]

const WATCH_ERRORS: Array<[ElearningWatchErrorCode, number]> = [
  ['invalid_input', 400],
  ['not_found', 404],
  ['assignment_unavailable', 403],
  ['course_withdrawn', 409],
  ['unsupported_item', 400],
  ['unsupported_policy', 400],
  ['conflict', 409],
  ['sequence_gap', 409],
  ['session_inactive', 409],
  ['unavailable', 503],
]

const HEARTBEAT_BODY = { sequence: 1, positionMs: 1000, playing: true }

const pinned = usePinnedServer()
function serve(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

function dummyDb(): ElearningDirectAssignmentDb & ElearningWatchDb {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (handler) => handler({ query: async () => ({ rows: [], rowCount: 0 }) }),
  }
}

function assertValuesFree(body: unknown): void {
  const blob = JSON.stringify(body)
  expect(blob).not.toContain(ORG)
  expect(blob).not.toContain(ACTOR)
  expect(blob).not.toContain(TARGET)
  expect(blob).not.toContain(SOURCE)
  expect(blob).not.toContain(VERSION)
  expect(blob).not.toContain(ITEM)
  expect(blob).not.toContain(SESSION)
  expect(blob).not.toMatch(/host|secret|stack|at /i)
}

function makeApp(over: {
  viewer?: string | null
  org?: string | null
  hasAdmin?: boolean
  hasRead?: boolean
  env?: NodeJS.ProcessEnv
  assignError?: unknown
  startError?: unknown
  heartbeatError?: unknown
  assignResult?: ElearningDirectAssignmentResult
  startResult?: ElearningWatchState
  heartbeatResult?: ElearningWatchState
} = {}) {
  const assignCalls: AssignElearningDirectInput[] = []
  const startCalls: StartElearningWatchInput[] = []
  const heartbeatCalls: RecordElearningHeartbeatInput[] = []
  const order: string[] = []
  let adminCalls = 0
  let readCalls = 0
  const adminGuard: express.RequestHandler = (_req, res, next) => {
    adminCalls += 1
    order.push('rbac')
    if (over.hasAdmin === false) {
      res.status(403).json({ error: 'Insufficient permissions' })
      return
    }
    next()
  }
  const readGuard: express.RequestHandler = (_req, res, next) => {
    readCalls += 1
    order.push('rbac')
    if (over.hasRead === false) {
      res.status(403).json({ error: 'Insufficient permissions' })
      return
    }
    next()
  }
  const router = createElearningPilotRouter({
    db: dummyDb(),
    viewerId: () => {
      order.push('identity')
      return over.viewer === undefined ? ACTOR : over.viewer
    },
    orgId: () => {
      order.push('org')
      return over.org === undefined ? ORG : over.org
    },
    adminGuard,
    readGuard,
    env: over.env ?? FLAG_ON,
    assignElearningDirect: async (_db, input) => {
      assignCalls.push(input)
      order.push('service')
      if (over.assignError) throw over.assignError
      return over.assignResult ?? ASSIGN_RESULT
    },
    startElearningWatch: async (_db, input) => {
      startCalls.push(input)
      order.push('service')
      if (over.startError) throw over.startError
      return over.startResult ?? WATCH_STATE
    },
    recordElearningHeartbeat: async (_db, input) => {
      heartbeatCalls.push(input)
      order.push('service')
      if (over.heartbeatError) throw over.heartbeatError
      return over.heartbeatResult ?? WATCH_STATE
    },
  })
  const app = express()
  if (router) app.use(router)
  return {
    app,
    router,
    assignCalls,
    startCalls,
    heartbeatCalls,
    order,
    get adminCalls() { return adminCalls },
    get readCalls() { return readCalls },
  }
}

describe('elearning pilot routes (flag-gated assignment + watch)', () => {
  test('flag OFF / lookalikes → factory returns null (nothing registered)', () => {
    expect(isElearningWatchSurfaceEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    const noopGuard: express.RequestHandler = (_req, _res, next) => next()
    const deps = {
      db: dummyDb(),
      viewerId: () => ACTOR,
      orgId: () => ORG,
      adminGuard: noopGuard,
      readGuard: noopGuard,
    }
    expect(createElearningPilotRouter({ ...deps, env: {} as NodeJS.ProcessEnv })).toBeNull()
    for (const flag of FLAG_NAMES) {
      for (const value of LOOKALIKES) {
        const env = { ...FLAG_ON, [flag]: value } as unknown as NodeJS.ProcessEnv
        expect(createElearningPilotRouter({ ...deps, env })).toBeNull()
      }
    }
    expect(createElearningPilotRouter({
      ...deps,
      env: { ...FLAG_ON, ELEARNING_ASSESSMENT_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv,
    })).not.toBeNull()
  })

  test('handler rechecks flags after registration and refuses ready', async () => {
    const env = { ...FLAG_ON } as unknown as NodeJS.ProcessEnv
    const app = makeApp({ env })
    env.ELEARNING_ASSIGNMENT_ENABLED = 'false'
    const assign = await serve(app.app).post('/api/elearning/assignments/direct').send(ASSIGN_BODY)
    expect(assign.status).toBe(404)
    expect(assign.body).toEqual({ error: 'not_found' })
    expect(app.assignCalls).toHaveLength(0)
    expect(app.adminCalls).toBe(0)
    const start = await serve(app.app).post(`/api/elearning/watch/items/${ITEM}/start`).send({})
    expect(start.status).toBe(404)
    expect(start.body).toEqual({ error: 'not_found' })
    expect(app.startCalls).toHaveLength(0)
    const beat = await serve(app.app)
      .post(`/api/elearning/watch/sessions/${SESSION}/heartbeat`)
      .send(HEARTBEAT_BODY)
    expect(beat.status).toBe(404)
    expect(beat.body).toEqual({ error: 'not_found' })
    expect(app.heartbeatCalls).toHaveLength(0)
  })

  test('identity then org then RBAC occur before service calls', async () => {
    const anon = makeApp({ viewer: null, org: null, hasAdmin: false, hasRead: false })
    const anonAssign = await serve(anon.app).post('/api/elearning/assignments/direct').send(ASSIGN_BODY)
    expect(anonAssign.status).toBe(401)
    expect(anonAssign.body).toEqual({ error: 'unauthenticated' })
    expect(anon.adminCalls).toBe(0)
    expect(anon.readCalls).toBe(0)
    expect(anon.assignCalls).toHaveLength(0)
    expect(anon.order.filter((step) => step === 'org' || step === 'rbac' || step === 'service')).toEqual([])

    const anonStart = await serve(anon.app).post(`/api/elearning/watch/items/${ITEM}/start`).send({})
    expect(anonStart.status).toBe(401)
    expect(anonStart.body).toEqual({ error: 'unauthenticated' })
    expect(anon.startCalls).toHaveLength(0)
    expect(anon.readCalls).toBe(0)

    const noOrg = makeApp({ org: null, hasAdmin: false, hasRead: false })
    const orgAssign = await serve(noOrg.app).post('/api/elearning/assignments/direct').send(ASSIGN_BODY)
    expect(orgAssign.status).toBe(403)
    expect(orgAssign.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrg.adminCalls).toBe(0)
    expect(noOrg.assignCalls).toHaveLength(0)
    expect(noOrg.order.includes('identity')).toBe(true)
    expect(noOrg.order.includes('rbac')).toBe(false)

    const orgStart = await serve(noOrg.app).post(`/api/elearning/watch/items/${ITEM}/start`).send({})
    expect(orgStart.status).toBe(403)
    expect(orgStart.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrg.readCalls).toBe(0)
    expect(noOrg.startCalls).toHaveLength(0)

    const deniedAssign = makeApp({ hasAdmin: false })
    const rbacAssign = await serve(deniedAssign.app).post('/api/elearning/assignments/direct').send(ASSIGN_BODY)
    expect(rbacAssign.status).toBe(403)
    expect(deniedAssign.adminCalls).toBe(1)
    expect(deniedAssign.readCalls).toBe(0)
    expect(deniedAssign.assignCalls).toHaveLength(0)
    expect(deniedAssign.order.filter((step) => step === 'identity' || step === 'org' || step === 'rbac'))
      .toEqual(['identity', 'org', 'rbac'])

    const deniedWatch = makeApp({ hasRead: false })
    const rbacWatch = await serve(deniedWatch.app).post(`/api/elearning/watch/items/${ITEM}/start`).send({})
    expect(rbacWatch.status).toBe(403)
    expect(deniedWatch.readCalls).toBe(1)
    expect(deniedWatch.adminCalls).toBe(0)
    expect(deniedWatch.startCalls).toHaveLength(0)
    expect(deniedWatch.order.filter((step) => step === 'identity' || step === 'org' || step === 'rbac'))
      .toEqual(['identity', 'org', 'rbac'])
  })

  test('happy assignment and watch calls use injected actor/org and ignore client overrides', async () => {
    const assignApp = makeApp()
    const assign = await serve(assignApp.app)
      .post(`/api/elearning/assignments/direct?orgId=evil-org&actorId=evil-actor&userId=${TARGET}`)
      .set('x-user-id', 'header-user')
      .set('x-tenant-id', 'header-org')
      .send(ASSIGN_BODY)
    expect(assign.status).toBe(201)
    expect(assign.body).toEqual(ASSIGN_RESULT)
    expect(assignApp.assignCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      targetUserId: TARGET,
      courseVersionId: VERSION,
      sourceKey: SOURCE,
      deadline: undefined,
    }])
    expect(assignApp.adminCalls).toBe(1)
    expect(assignApp.readCalls).toBe(0)

    const withDeadline = makeApp()
    const deadlineRes = await serve(withDeadline.app)
      .post('/api/elearning/assignments/direct')
      .send({ ...ASSIGN_BODY, deadline: '2026-12-31T00:00:00.000Z' })
    expect(deadlineRes.status).toBe(201)
    expect(withDeadline.assignCalls[0]?.deadline).toBe('2026-12-31T00:00:00.000Z')

    const startApp = makeApp()
    const start = await serve(startApp.app)
      .post(`/api/elearning/watch/items/${ITEM}/start?userId=evil-user&orgId=evil-org`)
      .set('x-user-id', 'header-user')
      .set('x-tenant-id', 'header-org')
      .send({})
    expect(start.status).toBe(200)
    expect(start.body).toEqual(WATCH_STATE)
    expect(startApp.startCalls).toEqual([{ orgId: ORG, userId: ACTOR, itemId: ITEM }])
    expect(startApp.readCalls).toBe(1)
    expect(startApp.adminCalls).toBe(0)

    const beatApp = makeApp()
    const beat = await serve(beatApp.app)
      .post(`/api/elearning/watch/sessions/${SESSION}/heartbeat?userId=evil-user&orgId=evil-org`)
      .set('x-user-id', 'header-user')
      .send(HEARTBEAT_BODY)
    expect(beat.status).toBe(200)
    expect(beat.body).toEqual(WATCH_STATE)
    expect(beatApp.heartbeatCalls).toEqual([{
      sessionId: SESSION,
      orgId: ORG,
      userId: ACTOR,
      sequence: 1,
      positionMs: 1000,
      playing: true,
    }])
    expect(beatApp.readCalls).toBe(1)
    expect(beatApp.adminCalls).toBe(0)
  })

  test('strict JSON body and path reject unknown keys, missing fields, and bad types before services', async () => {
    const extraAssign = makeApp()
    for (const body of [
      { ...ASSIGN_BODY, orgId: 'evil-org' },
      { ...ASSIGN_BODY, actorId: 'evil-actor' },
      { ...ASSIGN_BODY, userId: TARGET },
      { ...ASSIGN_BODY, extra: 1 },
      { targetUserId: TARGET, courseVersionId: VERSION },
      { ...ASSIGN_BODY, courseVersionId: 'not-a-uuid' },
      { ...ASSIGN_BODY, targetUserId: ' ' },
      { ...ASSIGN_BODY, sourceKey: '' },
      { ...ASSIGN_BODY, deadline: 1 },
      { ...ASSIGN_BODY, deadline: { iso: '2026-12-31T00:00:00.000Z' } },
      [ASSIGN_BODY],
      TARGET,
    ]) {
      extraAssign.assignCalls.length = 0
      const res = await serve(extraAssign.app).post('/api/elearning/assignments/direct').send(body)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_input' })
      assertValuesFree(res.body)
      expect(extraAssign.assignCalls).toHaveLength(0)
    }

    const extraStart = makeApp()
    for (const body of [
      { userId: 'evil-user' },
      { orgId: 'evil-org' },
      { itemId: ITEM },
      { extra: true },
    ]) {
      extraStart.startCalls.length = 0
      const res = await serve(extraStart.app).post(`/api/elearning/watch/items/${ITEM}/start`).send(body)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_input' })
      assertValuesFree(res.body)
      expect(extraStart.startCalls).toHaveLength(0)
    }
    const badItem = await serve(extraStart.app).post('/api/elearning/watch/items/not-a-uuid/start').send({})
    expect(badItem.status).toBe(400)
    expect(badItem.body).toEqual({ error: 'invalid_input' })
    expect(extraStart.startCalls).toHaveLength(0)

    const extraBeat = makeApp()
    for (const body of [
      { ...HEARTBEAT_BODY, userId: 'evil-user' },
      { ...HEARTBEAT_BODY, orgId: 'evil-org' },
      { ...HEARTBEAT_BODY, sessionId: SESSION },
      { sequence: 1, positionMs: 1000 },
      { sequence: '1', positionMs: 1000, playing: true },
      { sequence: 1.5, positionMs: 1000, playing: true },
      { sequence: 0, positionMs: 1000, playing: true },
      { sequence: 1, positionMs: -1, playing: true },
      { sequence: 1, positionMs: 1000, playing: 'true' },
      { sequence: 1, positionMs: 1000, playing: 1 },
    ]) {
      extraBeat.heartbeatCalls.length = 0
      const res = await serve(extraBeat.app)
        .post(`/api/elearning/watch/sessions/${SESSION}/heartbeat`)
        .send(body)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_input' })
      assertValuesFree(res.body)
      expect(extraBeat.heartbeatCalls).toHaveLength(0)
    }
    const badSession = await serve(extraBeat.app)
      .post('/api/elearning/watch/sessions/not-a-uuid/heartbeat')
      .send(HEARTBEAT_BODY)
    expect(badSession.status).toBe(400)
    expect(badSession.body).toEqual({ error: 'invalid_input' })
    expect(extraBeat.heartbeatCalls).toHaveLength(0)
  })

  test('service-domain errors map to stable values-free status/body pairs', async () => {
    for (const [code, status] of ASSIGNMENT_ERRORS) {
      const app = makeApp({ assignError: new ElearningDirectAssignmentError(code) })
      const res = await serve(app.app).post('/api/elearning/assignments/direct').send(ASSIGN_BODY)
      expect(res.status).toBe(status)
      expect(res.body).toEqual({ error: code })
      assertValuesFree(res.body)
      expect(app.assignCalls).toHaveLength(1)
    }
    const boom = makeApp({ assignError: new Error('db host secret at /var/app') })
    const boomRes = await serve(boom.app).post('/api/elearning/assignments/direct').send(ASSIGN_BODY)
    expect(boomRes.status).toBe(500)
    expect(boomRes.body).toEqual({ error: 'internal_error' })
    assertValuesFree(boomRes.body)
    expect(JSON.stringify(boomRes.body)).not.toContain('db host secret')

    for (const [code, status] of WATCH_ERRORS) {
      const startApp = makeApp({ startError: new ElearningWatchError(code) })
      const startRes = await serve(startApp.app).post(`/api/elearning/watch/items/${ITEM}/start`).send({})
      expect(startRes.status).toBe(status)
      expect(startRes.body).toEqual({ error: code })
      assertValuesFree(startRes.body)
      expect(startApp.startCalls).toHaveLength(1)

      const beatApp = makeApp({ heartbeatError: new ElearningWatchError(code) })
      const beatRes = await serve(beatApp.app)
        .post(`/api/elearning/watch/sessions/${SESSION}/heartbeat`)
        .send(HEARTBEAT_BODY)
      expect(beatRes.status).toBe(status)
      expect(beatRes.body).toEqual({ error: code })
      assertValuesFree(beatRes.body)
      expect(beatApp.heartbeatCalls).toHaveLength(1)
    }
  })

  test('identity then org then RBAC precede body parsing on oversized JSON', async () => {
    const huge = { ...ASSIGN_BODY, sourceKey: 'x'.repeat(20 * 1024) }
    const anon = makeApp({ viewer: null, org: null, hasAdmin: false })
    const anonRes = await serve(anon.app).post('/api/elearning/assignments/direct').send(huge)
    expect(anonRes.status).toBe(401)
    expect(anonRes.body).toEqual({ error: 'unauthenticated' })
    expect(anon.adminCalls).toBe(0)
    expect(anon.assignCalls).toHaveLength(0)
    expect(anon.order.includes('org')).toBe(false)
    expect(anon.order.includes('rbac')).toBe(false)
    expect(anon.order.includes('service')).toBe(false)

    const noOrg = makeApp({ org: null, hasAdmin: false })
    const orgRes = await serve(noOrg.app).post('/api/elearning/assignments/direct').send(huge)
    expect(orgRes.status).toBe(403)
    expect(orgRes.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrg.adminCalls).toBe(0)
    expect(noOrg.assignCalls).toHaveLength(0)
    expect(noOrg.order.includes('identity')).toBe(true)
    expect(noOrg.order.includes('rbac')).toBe(false)

    const denied = makeApp({ hasAdmin: false })
    const rbacRes = await serve(denied.app).post('/api/elearning/assignments/direct').send(huge)
    expect(rbacRes.status).toBe(403)
    expect(denied.adminCalls).toBe(1)
    expect(denied.assignCalls).toHaveLength(0)
    expect(denied.order.filter((step) => step === 'identity' || step === 'org' || step === 'rbac'))
      .toEqual(['identity', 'org', 'rbac'])
  })

  test('valid allowed-key body over 16 KiB is rejected before service even with a later 10 MB parser', async () => {
    const app = makeApp()
    app.app.use(express.json({ limit: '10mb' }))
    const huge = { ...ASSIGN_BODY, sourceKey: 'x'.repeat(20 * 1024) }
    const res = await serve(app.app).post('/api/elearning/assignments/direct').send(huge)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_input' })
    assertValuesFree(res.body)
    expect(app.assignCalls).toHaveLength(0)
    expect(app.order.filter((step) => step === 'identity' || step === 'org' || step === 'rbac' || step === 'service'))
      .toEqual(['identity', 'org', 'rbac'])

    const startApp = makeApp()
    startApp.app.use(express.json({ limit: '10mb' }))
    const start = await serve(startApp.app)
      .post(`/api/elearning/watch/items/${ITEM}/start`)
      .set('content-type', 'application/json')
      .send(`{${' '.repeat(20 * 1024)}}`)
    expect(start.status).toBe(400)
    expect(start.body).toEqual({ error: 'invalid_input' })
    expect(startApp.startCalls).toHaveLength(0)
    expect(startApp.order.includes('service')).toBe(false)
  })
})
