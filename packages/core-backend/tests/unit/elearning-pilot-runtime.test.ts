import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import { isElearningWatchSurfaceEnabled } from '../../src/elearning/feature-flags'
import { authenticate } from '../../src/middleware/auth'
import { createElearningPilotRuntime } from '../../src/services/elearning-pilot-runtime'
import type { ElearningDirectAssignmentDb } from '../../src/services/elearning-direct-assignment'
import type { ElearningExamDb } from '../../src/services/elearning-exam'
import {
  ELEARNING_MEDIA_PLAYBACK_SECRET_ENV,
  type ElearningPlaybackQueryable,
} from '../../src/services/elearning-media-playback'
import type { ElearningWatchDb } from '../../src/services/elearning-watch-progress'
import { usePinnedServer } from '../utils/pinned-server'

const PLAYBACK_SECRET = 'playback-signing-secret-min-32chars!'
const JWT_SECRET = 'jwt-secret-must-remain-unused-32b!!'

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
  ELEARNING_MEDIA_ENABLED: 'true',
  [ELEARNING_MEDIA_PLAYBACK_SECRET_ENV]: PLAYBACK_SECRET,
  JWT_SECRET,
} as unknown as NodeJS.ProcessEnv

const FLAG_EXAM_ON = {
  ...FLAG_ON,
  ELEARNING_ASSESSMENT_ENABLED: 'true',
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

const ORG = 'org-pilot-rt-1'
const ACTOR = 'actor-pilot-rt-1'
const TARGET = 'user-pilot-rt-1'
const SOURCE = 'src-pilot-rt-1'
const VERSION = '11111111-1111-4111-8111-111111111111'
const ITEM = '22222222-2222-4222-8222-222222222222'
const SESSION = '33333333-3333-4333-8333-333333333333'
const ASSIGNMENT_ID = '44444444-4444-4444-8444-444444444444'
const MEMBER_ID = '55555555-5555-4555-8555-555555555555'
const MEDIA = '66666666-6666-4666-8666-666666666666'
const ATTEMPT = '77777777-7777-4777-8777-777777777777'
const Q1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const ASSIGN_BODY = {
  targetUserId: TARGET,
  courseVersionId: VERSION,
  sourceKey: SOURCE,
}

const ASSIGN_RESULT = {
  assignmentId: ASSIGNMENT_ID,
  memberId: MEMBER_ID,
  duplicate: false,
}

const WATCH_STATE = {
  sessionId: SESSION,
  status: 'in_progress' as const,
  lastSequence: 1,
  lastClientPositionMs: 1000,
  effectiveMs: 1000,
  maxPositionMs: 1000,
  durationMs: 10_000,
  creditedMs: 1000,
  duplicate: false,
}

const TICKET_RESULT = {
  token: 'playback.ticket.token',
  expiresAt: '2026-08-25T12:10:00.000Z',
  ttlSeconds: 600,
  itemId: ITEM,
  mediaId: MEDIA,
}

const EXAM_START_RESULT = {
  attemptId: ATTEMPT,
  attemptNo: 1,
  status: 'started' as const,
  paper: {
    domain: 'elearning.exam.paper.v1' as const,
    version: 1 as const,
    questions: [{
      position: 1,
      questionRevisionId: Q1,
      questionType: 'single_choice' as const,
      prompt: 'Pick one',
      options: [
        { id: 'a', text: 'alpha' },
        { id: 'b', text: 'beta' },
      ],
      points: 10,
    }],
  },
  duplicate: false,
}

const EXAM_SUBMIT_RESULT = {
  attemptId: ATTEMPT,
  attemptNo: 1,
  status: 'graded' as const,
  autoScore: 10,
  totalScore: 10,
  passed: true,
  duplicate: false,
}

const ANSWERS = { [Q1]: ['a'] }
const SUBMIT_BODY = { answers: ANSWERS }

const INDEX_SRC = join(__dirname, '../../src/index.ts')
const RUNTIME_SRC = join(__dirname, '../../src/services/elearning-pilot-runtime.ts')

const pinned = usePinnedServer()
function serve(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

function dummyDb(
  onUse?: () => void,
): ElearningDirectAssignmentDb & ElearningWatchDb & ElearningPlaybackQueryable & ElearningExamDb {
  return {
    query: async () => {
      onUse?.()
      return { rows: [], rowCount: 0 }
    },
    transaction: async (handler) => {
      onUse?.()
      return handler({ query: async () => ({ rows: [], rowCount: 0 }) })
    },
  }
}

function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('elearning pilot runtime (flag-gated production wiring)', () => {
  test('flag OFF / lookalikes → factory returns null (no runtime)', () => {
    expect(isElearningWatchSurfaceEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(createElearningPilotRuntime({
      db: dummyDb(),
      env: {} as NodeJS.ProcessEnv,
    })).toBeNull()
    for (const flag of FLAG_NAMES) {
      for (const value of LOOKALIKES) {
        const env = { ...FLAG_ON, [flag]: value } as unknown as NodeJS.ProcessEnv
        expect(createElearningPilotRuntime({ db: dummyDb(), env })).toBeNull()
      }
    }
  })

  test('factory does not touch the DB handle', () => {
    let used = 0
    const runtime = createElearningPilotRuntime({
      db: dummyDb(() => { used += 1 }),
      env: FLAG_ON,
    })
    expect(runtime).not.toBeNull()
    expect(used).toBe(0)
  })

  test('defaults wrap authenticate on /api/elearning and use rbacGuard elearning admin|read', () => {
    const runtimeSrc = readFileSync(RUNTIME_SRC, 'utf8')
    expect(runtimeSrc).toMatch(/router\.use\(\s*['"]\/api\/elearning['"]\s*,\s*(opts\.authenticate\s*\?\?\s*)?authenticate\s*\)/)
    expect(runtimeSrc).toMatch(/rbacGuard\('elearning',\s*'admin'\)/)
    expect(runtimeSrc).toMatch(/rbacGuard\('elearning',\s*'read'\)/)
    expect(runtimeSrc).toMatch(/req\.authenticatedTenantId/)
    expect(runtimeSrc).toMatch(/req\.user/)
    expect(runtimeSrc).toMatch(/ELEARNING_MEDIA_PLAYBACK_SECRET_ENV|ELEARNING_MEDIA_PLAYBACK_SIGNING_SECRET/)
    expect(runtimeSrc).toMatch(/issueElearningMediaPlaybackTicket/)
    expect(runtimeSrc).toMatch(/startElearningExam/)
    expect(runtimeSrc).toMatch(/submitElearningExam/)
    expect(runtimeSrc).not.toMatch(/authorizeElearningMediaPlayback/)
    expect(runtimeSrc).not.toMatch(/getBootedElearningMediaRangeStore/)
    expect(runtimeSrc).not.toMatch(/pool\.query|db\.query/)

    const runtime = createElearningPilotRuntime({ db: dummyDb(), env: FLAG_ON })
    expect(runtime).not.toBeNull()
    const stack = (runtime!.router as unknown as { stack: Array<{ handle: unknown; regexp: RegExp }> }).stack
    expect(stack[0]?.handle).toBe(authenticate)
    expect(String(stack[0]?.regexp)).toMatch(/elearning/)
  })

  test('JWT identity then org then RBAC precede body parsing; actor/org ignore client overrides', async () => {
    const order: string[] = []
    const assignCalls: unknown[] = []
    const authenticateMw: express.RequestHandler = (req, res, next) => {
      order.push('jwt')
      if (req.headers['x-test-anon'] === '1') {
        res.status(401).json({ error: 'unauthenticated' })
        return
      }
      req.user = { id: ACTOR, tenantId: 'user-tenant-claim' }
      if (req.headers['x-test-no-org'] !== '1') {
        req.authenticatedTenantId = ORG
      }
      next()
    }
    const adminGuard: express.RequestHandler = (_req, res, next) => {
      order.push('rbac')
      if (_req.headers['x-test-deny'] === '1') {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    }
    const ticketCalls: unknown[] = []
    const examStartCalls: unknown[] = []
    const examSubmitCalls: unknown[] = []
    const runtime = createElearningPilotRuntime({
      db: dummyDb(),
      env: FLAG_EXAM_ON,
      authenticate: authenticateMw,
      adminGuard,
      readGuard: (_req, _res, next) => { order.push('rbac'); next() },
      assignElearningDirect: async (_db, input) => {
        assignCalls.push(input)
        order.push('service')
        return ASSIGN_RESULT
      },
      issueElearningMediaPlaybackTicket: async (_db, input) => {
        ticketCalls.push(input)
        order.push('service')
        return TICKET_RESULT
      },
      startElearningExam: async (_db, input) => {
        examStartCalls.push(input)
        order.push('service')
        return EXAM_START_RESULT
      },
      submitElearningExam: async (_db, input) => {
        examSubmitCalls.push(input)
        order.push('service')
        return EXAM_SUBMIT_RESULT
      },
    })
    expect(runtime).not.toBeNull()

    const app = express()
    app.use(runtime!.router)
    app.use(express.json({ limit: '10mb' }))

    const huge = { ...ASSIGN_BODY, sourceKey: 'x'.repeat(20 * 1024) }
    const anon = await serve(app)
      .post('/api/elearning/assignments/direct')
      .set('x-test-anon', '1')
      .send(huge)
    expect(anon.status).toBe(401)
    expect(anon.body).toEqual({ error: 'unauthenticated' })
    expect(assignCalls).toHaveLength(0)
    expect(order).toEqual(['jwt'])

    order.length = 0
    const noOrg = await serve(app)
      .post('/api/elearning/assignments/direct')
      .set('x-test-no-org', '1')
      .send(huge)
    expect(noOrg.status).toBe(403)
    expect(noOrg.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(assignCalls).toHaveLength(0)
    expect(order.includes('jwt')).toBe(true)
    expect(order.includes('rbac')).toBe(false)
    expect(order.includes('service')).toBe(false)

    order.length = 0
    const denied = await serve(app)
      .post('/api/elearning/assignments/direct')
      .set('x-test-deny', '1')
      .send(huge)
    expect(denied.status).toBe(403)
    expect(assignCalls).toHaveLength(0)
    expect(order).toEqual(['jwt', 'rbac'])

    order.length = 0
    const ok = await serve(app)
      .post(`/api/elearning/assignments/direct?orgId=evil-org&actorId=evil-actor`)
      .set('x-user-id', 'header-user')
      .set('x-tenant-id', 'header-org')
      .send(ASSIGN_BODY)
    expect(ok.status).toBe(201)
    expect(ok.body).toEqual(ASSIGN_RESULT)
    expect(assignCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      targetUserId: TARGET,
      courseVersionId: VERSION,
      sourceKey: SOURCE,
      deadline: undefined,
    }])
    expect(order).toEqual(['jwt', 'rbac', 'service'])

    order.length = 0
    const ticket = await serve(app)
      .post(`/api/elearning/watch/items/${ITEM}/playback-ticket?orgId=evil-org&userId=evil-user`)
      .send({})
    expect(ticket.status).toBe(200)
    expect(ticket.body).toEqual(TICKET_RESULT)
    expect(JSON.stringify(ticket.body)).not.toContain(PLAYBACK_SECRET)
    expect(JSON.stringify(ticket.body)).not.toContain(JWT_SECRET)
    expect(JSON.stringify(ticket.body)).not.toMatch(/storage_key|storageKey/)
    expect(ticketCalls).toEqual([{
      orgId: ORG,
      userId: ACTOR,
      itemId: ITEM,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
    }])
    expect(order).toEqual(['jwt', 'rbac', 'service'])

    order.length = 0
    const examStart = await serve(app)
      .post(`/api/elearning/exams/items/${ITEM}/start?orgId=evil-org&userId=evil-user`)
      .send({})
    expect(examStart.status).toBe(200)
    expect(examStart.body).toEqual(EXAM_START_RESULT)
    expect(JSON.stringify(examStart.body)).not.toMatch(/answer_key|answerKey|explanation|"correct"/)
    expect(examStartCalls).toEqual([{ orgId: ORG, userId: ACTOR, itemId: ITEM }])
    expect(order).toEqual(['jwt', 'rbac', 'service'])

    order.length = 0
    const examSubmit = await serve(app)
      .post(`/api/elearning/exams/attempts/${ATTEMPT}/submit`)
      .send(SUBMIT_BODY)
    expect(examSubmit.status).toBe(200)
    expect(examSubmit.body).toEqual(EXAM_SUBMIT_RESULT)
    expect(examSubmitCalls).toEqual([{
      orgId: ORG,
      userId: ACTOR,
      attemptId: ATTEMPT,
      answers: ANSWERS,
    }])
    expect(order).toEqual(['jwt', 'rbac', 'service'])
  })

  test('valid allowed-key body over 16 KiB is rejected before service even with a later 10 MB parser', async () => {
    const assignCalls: unknown[] = []
    const startCalls: unknown[] = []
    const heartbeatCalls: unknown[] = []
    const ticketCalls: unknown[] = []
    const examStartCalls: unknown[] = []
    const examSubmitCalls: unknown[] = []
    const order: string[] = []
    const authenticateMw: express.RequestHandler = (req, _res, next) => {
      order.push('jwt')
      req.user = { id: ACTOR }
      req.authenticatedTenantId = ORG
      next()
    }
    const runtime = createElearningPilotRuntime({
      db: dummyDb(),
      env: FLAG_EXAM_ON,
      authenticate: authenticateMw,
      adminGuard: (_req, _res, next) => { order.push('rbac'); next() },
      readGuard: (_req, _res, next) => { order.push('rbac'); next() },
      assignElearningDirect: async (_db, input) => {
        assignCalls.push(input)
        order.push('service')
        return ASSIGN_RESULT
      },
      startElearningWatch: async (_db, input) => {
        startCalls.push(input)
        order.push('service')
        return WATCH_STATE
      },
      recordElearningHeartbeat: async (_db, input) => {
        heartbeatCalls.push(input)
        order.push('service')
        return WATCH_STATE
      },
      issueElearningMediaPlaybackTicket: async (_db, input) => {
        ticketCalls.push(input)
        order.push('service')
        return TICKET_RESULT
      },
      startElearningExam: async (_db, input) => {
        examStartCalls.push(input)
        order.push('service')
        return EXAM_START_RESULT
      },
      submitElearningExam: async (_db, input) => {
        examSubmitCalls.push(input)
        order.push('service')
        return EXAM_SUBMIT_RESULT
      },
    })
    const app = express()
    app.use(runtime!.router)
    app.use(express.json({ limit: '10mb' }))

    const hugeAssign = { ...ASSIGN_BODY, sourceKey: 'x'.repeat(20 * 1024) }
    const assign = await serve(app).post('/api/elearning/assignments/direct').send(hugeAssign)
    expect(assign.status).toBe(400)
    expect(assign.body).toEqual({ error: 'invalid_input' })
    expect(assignCalls).toHaveLength(0)
    expect(order).toEqual(['jwt', 'rbac'])

    order.length = 0
    const hugeStart = `{${' '.repeat(20 * 1024)}}`
    const start = await serve(app)
      .post(`/api/elearning/watch/items/${ITEM}/start`)
      .set('content-type', 'application/json')
      .send(hugeStart)
    expect(start.status).toBe(400)
    expect(start.body).toEqual({ error: 'invalid_input' })
    expect(startCalls).toHaveLength(0)
    expect(order).toEqual(['jwt', 'rbac'])

    order.length = 0
    const hugeBeat = `{"sequence":1,"positionMs":${'1'.repeat(20 * 1024)},"playing":true}`
    const beat = await serve(app)
      .post(`/api/elearning/watch/sessions/${SESSION}/heartbeat`)
      .set('content-type', 'application/json')
      .send(hugeBeat)
    expect(beat.status).toBe(400)
    expect(beat.body).toEqual({ error: 'invalid_input' })
    expect(heartbeatCalls).toHaveLength(0)
    expect(order).toEqual(['jwt', 'rbac'])

    order.length = 0
    const hugeTicket = `{${' '.repeat(20 * 1024)}}`
    const ticket = await serve(app)
      .post(`/api/elearning/watch/items/${ITEM}/playback-ticket`)
      .set('content-type', 'application/json')
      .send(hugeTicket)
    expect(ticket.status).toBe(400)
    expect(ticket.body).toEqual({ error: 'invalid_input' })
    expect(ticketCalls).toHaveLength(0)
    expect(order).toEqual(['jwt', 'rbac'])

    order.length = 0
    const examStart = await serve(app)
      .post(`/api/elearning/exams/items/${ITEM}/start`)
      .set('content-type', 'application/json')
      .send(hugeTicket)
    expect(examStart.status).toBe(400)
    expect(examStart.body).toEqual({ error: 'invalid_input' })
    expect(examStartCalls).toHaveLength(0)
    expect(order).toEqual(['jwt', 'rbac'])

    order.length = 0
    const examSubmit = await serve(app)
      .post(`/api/elearning/exams/attempts/${ATTEMPT}/submit`)
      .send({ answers: { [Q1]: ['x'.repeat(20 * 1024)] } })
    expect(examSubmit.status).toBe(400)
    expect(examSubmit.body).toEqual({ error: 'invalid_input' })
    expect(examSubmitCalls).toHaveLength(0)
    expect(order).toEqual(['jwt', 'rbac'])
  })

  test('index.ts mounts the pilot runtime in setupMiddleware before the global 10 MB parser, not in start', () => {
    const raw = readFileSync(INDEX_SRC, 'utf8')
    const src = stripTsComments(raw)
    expect(src).toMatch(/createElearningPilotRuntime/)
    expect(src).toMatch(/this\.app\.use\(\s*elearningPilotRuntime\.router\s*\)/)
    expect(src).toMatch(/createElearningPilotRuntime\(\s*\{\s*db:\s*poolManager\.get\(\)\s*\}\s*\)/)

    const setupAt = src.search(/private\s+setupMiddleware\s*\(\s*\)\s*:\s*void\s*\{/)
    const setupEndAt = src.search(/private\s+installGlobalErrorHandler\s*\(\s*\)\s*:\s*void\s*\{/)
    const startAt = src.search(/async\s+start\s*\(\s*\)\s*:\s*Promise\s*<\s*void\s*>\s*\{/)
    expect(setupAt).toBeGreaterThanOrEqual(0)
    expect(setupEndAt).toBeGreaterThan(setupAt)
    expect(startAt).toBeGreaterThan(setupEndAt)

    const setupSrc = src.slice(setupAt, setupEndAt)
    const startSrc = src.slice(startAt)
    const createAt = setupSrc.search(/createElearningPilotRuntime/)
    const mountAt = setupSrc.search(/this\.app\.use\(\s*elearningPilotRuntime\.router\s*\)/)
    const jsonAt = setupSrc.search(/this\.app\.use\(\s*express\.json\(\s*\{\s*limit:\s*['"]10mb['"]\s*\}\s*\)\s*\)/)
    expect(createAt).toBeGreaterThanOrEqual(0)
    expect(mountAt).toBeGreaterThan(createAt)
    expect(jsonAt).toBeGreaterThan(mountAt)
    expect(setupSrc).toMatch(/if\s*\(\s*elearningPilotRuntime\s*\)/)
    expect(startSrc.includes('createElearningPilotRuntime')).toBe(false)
    expect(startSrc.includes('elearningPilotRuntime.router')).toBe(false)
  })

  test('exam flags OFF 404 the exam routes with no service call; watch ticket still issues', async () => {
    const examStartCalls: unknown[] = []
    const ticketCalls: unknown[] = []
    const authenticateMw: express.RequestHandler = (req, _res, next) => {
      req.user = { id: ACTOR }
      req.authenticatedTenantId = ORG
      next()
    }
    const runtime = createElearningPilotRuntime({
      db: dummyDb(),
      env: FLAG_ON,
      authenticate: authenticateMw,
      readGuard: (_req, _res, next) => next(),
      issueElearningMediaPlaybackTicket: async (_db, input) => {
        ticketCalls.push(input)
        return TICKET_RESULT
      },
      startElearningExam: async (_db, input) => {
        examStartCalls.push(input)
        return EXAM_START_RESULT
      },
    })
    const app = express()
    app.use(runtime!.router)

    const exam = await serve(app).post(`/api/elearning/exams/items/${ITEM}/start`).send({})
    expect(exam.status).toBe(404)
    expect(exam.body).toEqual({ error: 'not_found' })
    expect(examStartCalls).toHaveLength(0)

    const ticket = await serve(app).post(`/api/elearning/watch/items/${ITEM}/playback-ticket`).send({})
    expect(ticket.status).toBe(200)
    expect(ticket.body).toEqual(TICKET_RESULT)
    expect(JSON.stringify(ticket.body)).not.toContain(PLAYBACK_SECRET)
    expect(ticketCalls).toHaveLength(1)
    expect((ticketCalls[0] as { playbackSigningSecret: string }).playbackSigningSecret).toBe(PLAYBACK_SECRET)
  })
})
