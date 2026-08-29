import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import { isElearningWatchSurfaceEnabled } from '../../src/elearning/feature-flags'
import { authenticate } from '../../src/middleware/auth'
import { createElearningPilotRuntime } from '../../src/services/elearning-pilot-runtime'
import type { ElearningCoursePublishDb } from '../../src/services/elearning-course-publish'
import type { ElearningDirectAssignmentDb } from '../../src/services/elearning-direct-assignment'
import type { ElearningExamDb } from '../../src/services/elearning-exam'
import type { ElearningLearnerCoursesQueryable } from '../../src/services/elearning-learner-courses'
import {
  ELEARNING_MEDIA_PLAYBACK_SECRET_ENV,
  type ElearningPlaybackDb,
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

const FLAG_NAMES = ['ELEARNING_ENABLED', 'ELEARNING_CONTENT_ENABLED'] as const

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
const REQUEST_ID = '88888888-8888-4888-8888-888888888888'
const EXAM_ITEM_ID = '99999999-9999-4999-8999-999999999999'
const PUBLISHED_EXAM_ID = 'abababab-abab-4aba-8aba-abababababab'

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
    questions: [
      {
        position: 1,
        questionRevisionId: Q1,
        questionType: 'single_choice' as const,
        prompt: 'Pick one',
        options: [
          { id: 'a', text: 'alpha' },
          { id: 'b', text: 'beta' },
        ],
        points: 10,
      },
    ],
  },
  answers: { [Q1]: [] },
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

const EXAM_REVIEW_RESULT = {
  attemptId: ATTEMPT,
  attemptNo: 1,
  status: 'graded' as const,
  disclosurePolicy: 'wrong_items_after_submit' as const,
  autoScore: 0,
  totalScore: 10,
  passed: false,
  questions: [
    {
      position: 1,
      questionRevisionId: Q1,
      questionType: 'single_choice' as const,
      prompt: 'Pick one',
      options: [
        { id: 'a', text: 'alpha' },
        { id: 'b', text: 'beta' },
      ],
      points: 10,
      selected: ['b'],
      correct: false,
      awarded: 0,
    },
  ],
}

const ANSWERS = { [Q1]: ['a'] }
const SUBMIT_BODY = { answers: ANSWERS }

const PUBLISH_BODY = {
  requestId: REQUEST_ID,
  title: 'Pilot course',
  mediaId: MEDIA,
  passScore: 10,
  maxAttempts: 3,
  questions: [
    {
      questionType: 'single_choice',
      prompt: 'Pick one',
      options: [
        { id: 'a', text: 'alpha' },
        { id: 'b', text: 'beta' },
      ],
      correctOptionIds: ['a'],
      points: 10,
    },
  ],
}

const PUBLISH_RESULT = {
  courseId: REQUEST_ID,
  courseVersionId: VERSION,
  videoItemId: ITEM,
  examItemId: EXAM_ITEM_ID,
  examId: PUBLISHED_EXAM_ID,
  status: 'published' as const,
  questionCount: 1,
  totalScore: 10,
}

const LEARNER_COURSES = [
  {
    courseId: REQUEST_ID,
    courseVersionId: VERSION,
    title: 'Pilot course',
    access: { kind: 'assignment' as const, required: true as const },
    assignment: {
      deadline: null,
      assignedAt: '2026-01-02T03:04:05.000Z',
    },
    video: {
      itemId: ITEM,
      durationMs: 10_000,
      status: 'not_started' as const,
      effectiveMs: 0,
      maxPositionMs: 0,
      completedAt: null,
    },
    exam: {
      itemId: EXAM_ITEM_ID,
      latestAttempt: null,
    },
    completed: false,
  },
]

const INDEX_SRC = join(__dirname, '../../src/index.ts')
const RUNTIME_SRC = join(
  __dirname,
  '../../src/services/elearning-pilot-runtime.ts',
)
const ROUTE_SRC = join(__dirname, '../../src/routes/elearning-pilot.ts')

const pinned = usePinnedServer()
function serve(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

function dummyDb(
  onUse?: () => void,
): ElearningDirectAssignmentDb &
  ElearningWatchDb &
  ElearningPlaybackDb &
  ElearningExamDb &
  ElearningCoursePublishDb &
  ElearningLearnerCoursesQueryable {
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
    expect(
      createElearningPilotRuntime({
        db: dummyDb(),
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toBeNull()
    for (const flag of FLAG_NAMES) {
      for (const value of LOOKALIKES) {
        const env = {
          ...FLAG_ON,
          [flag]: value,
        } as unknown as NodeJS.ProcessEnv
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

  test('defaults wrap authenticate on /api/elearning and use rbacGuard elearning admin plus learner-read any', () => {
    const runtimeSrc = readFileSync(RUNTIME_SRC, 'utf8')
    expect(runtimeSrc).toMatch(
      /router\.use\(\s*['"]\/api\/elearning['"]\s*,\s*(opts\.authenticate\s*\?\?\s*)?authenticate\s*\)/,
    )
    expect(runtimeSrc).toMatch(/rbacGuard\('elearning',\s*'admin'\)/)
    expect(runtimeSrc).toMatch(
      /rbacGuardAny\(\s*\[\s*'elearning:read'\s*,\s*'elearning:write'\s*,\s*'elearning:admin'\s*\]\s*\)/,
    )
    expect(runtimeSrc).toMatch(
      /rbacGuardAny\(\s*\[\s*'elearning:grade'\s*,\s*'elearning:admin'\s*\]\s*\)/,
    )
    expect(runtimeSrc).not.toMatch(
      /readGuard:\s*opts\.readGuard\s*\?\?\s*rbacGuard\('elearning',\s*'read'\)/,
    )
    expect(runtimeSrc).toMatch(/req\.authenticatedTenantId/)
    expect(runtimeSrc).toMatch(/req\.user/)
    expect(runtimeSrc).toMatch(
      /ELEARNING_MEDIA_PLAYBACK_SECRET_ENV|ELEARNING_MEDIA_PLAYBACK_SIGNING_SECRET/,
    )
    expect(runtimeSrc).toMatch(/issueElearningMediaPlaybackTicket/)
    expect(runtimeSrc).toMatch(/startElearningExam/)
    expect(runtimeSrc).toMatch(/submitElearningExam/)
    expect(runtimeSrc).toMatch(/getElearningExamReview/)
    expect(runtimeSrc).toMatch(/submitElearningManualGrade/)
    expect(runtimeSrc).toMatch(
      /submitElearningExam\(db,\s*input,\s*\{\s*env\s*\}\)/,
    )
    expect(runtimeSrc).toMatch(
      /submitElearningManualGrade\(db,\s*input,\s*\{\s*env\s*\}\)/,
    )
    expect(runtimeSrc).toMatch(/publishElearningCourse/)
    expect(runtimeSrc).toMatch(/listElearningLearnerCourses/)
    expect(runtimeSrc).toMatch(
      /opts\.publishElearningCourse\s*\?\?\s*publishElearningCourse/,
    )
    expect(runtimeSrc).toMatch(
      /opts\.listElearningLearnerCourses\s*\?\?\s*listElearningLearnerCourses/,
    )
    expect(runtimeSrc).not.toMatch(/authorizeElearningMediaPlayback/)
    expect(runtimeSrc).not.toMatch(/getBootedElearningMediaRangeStore/)
    expect(runtimeSrc).not.toMatch(/pool\.query|db\.query/)

    const runtime = createElearningPilotRuntime({ db: dummyDb(), env: FLAG_ON })
    expect(runtime).not.toBeNull()
    const stack = (runtime!.router as unknown as { stack: Array<{ handle: unknown; regexp: RegExp }> }).stack
    expect(stack[0]?.handle).toBe(authenticate)
    expect(String(stack[0]?.regexp)).toMatch(/elearning/)

    const routeSrc = readFileSync(ROUTE_SRC, 'utf8')
    expect(routeSrc).toMatch(/json\(\s*\{\s*limit:\s*16\s*\*\s*1024\s*\}\s*\)/)
    expect(routeSrc).toMatch(
      /json\(\s*\{\s*limit:\s*1024\s*\*\s*1024\s*\}\s*\)/,
    )
    expect(routeSrc).toMatch(/parseError\.status === 413|entity\.too\.large/)
    expect(routeSrc).toMatch(/payload_too_large/)
    expect(routeSrc).toMatch(/\/api\/elearning\/courses\/publish/)
    expect(routeSrc).toMatch(/\/api\/elearning\/me\/courses/)
    expect(routeSrc).toMatch(
      /res\.status\(\s*200\s*\)\.json\(\s*\{\s*courses:\s*result\s*\}\s*\)/,
    )
    expect(routeSrc).toMatch(/rbacGuard\('elearning',\s*'admin'\)|adminGuard/)
    expect(routeSrc).toMatch(
      /gate\(\s*deps\.adminGuard,\s*'exam',\s*parsePublishJson\s*\)/,
    )
    expect(routeSrc).toMatch(/gate\(\s*deps\.readGuard,\s*'exam',\s*null\s*\)/)
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
    const examReviewCalls: unknown[] = []
    const publishCalls: unknown[] = []
    const learnerCalls: unknown[] = []
    const runtime = createElearningPilotRuntime({
      db: dummyDb(),
      env: FLAG_EXAM_ON,
      authenticate: authenticateMw,
      adminGuard,
      writeGuard: adminGuard,
      readGuard: (_req, res, next) => {
        order.push('rbac')
        if (_req.headers['x-test-deny-read'] === '1') {
          res.status(403).json({ error: 'Insufficient permissions' })
          return
        }
        next()
      },
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
      getElearningExamReview: async (_db, input) => {
        examReviewCalls.push(input)
        order.push('service')
        return EXAM_REVIEW_RESULT
      },
      publishElearningCourse: async (_db, input) => {
        publishCalls.push(input)
        order.push('service')
        return PUBLISH_RESULT
      },
      listElearningLearnerCourses: async (_db, input) => {
        learnerCalls.push(input)
        order.push('service')
        return LEARNER_COURSES
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
      .post(
        `/api/elearning/assignments/direct?orgId=evil-org&actorId=evil-actor`,
      )
      .set('x-user-id', 'header-user')
      .set('x-tenant-id', 'header-org')
      .send(ASSIGN_BODY)
    expect(ok.status).toBe(201)
    expect(ok.body).toEqual(ASSIGN_RESULT)
    expect(assignCalls).toEqual([
      {
        orgId: ORG,
        actorId: ACTOR,
        isGlobalAdmin: false,
        targetUserId: TARGET,
        courseVersionId: VERSION,
        sourceKey: SOURCE,
        deadline: undefined,
      },
    ])
    expect(order).toEqual(['jwt', 'rbac', 'service'])

    order.length = 0
    const examReview = await serve(app)
      .get(
        `/api/elearning/exams/attempts/${ATTEMPT}/review?orgId=evil-org&userId=evil-user`,
      )
    expect(examReview.status).toBe(200)
    expect(examReview.body).toEqual(EXAM_REVIEW_RESULT)
    expect(JSON.stringify(examReview.body)).not.toMatch(
      /answer_key|answerKey|correctOptionIds|explanation|examId|passScore/,
    )
    expect(examReviewCalls).toEqual([
      { orgId: ORG, userId: ACTOR, attemptId: ATTEMPT },
    ])
    expect(order).toEqual(['jwt', 'rbac', 'service'])

    order.length = 0
    const ticket = await serve(app)
      .post(
        `/api/elearning/watch/items/${ITEM}/playback-ticket?orgId=evil-org&userId=evil-user`,
      )
      .send({})
    expect(ticket.status).toBe(200)
    expect(ticket.body).toEqual(TICKET_RESULT)
    expect(JSON.stringify(ticket.body)).not.toContain(PLAYBACK_SECRET)
    expect(JSON.stringify(ticket.body)).not.toContain(JWT_SECRET)
    expect(JSON.stringify(ticket.body)).not.toMatch(/storage_key|storageKey/)
    expect(ticketCalls).toEqual([
      {
        orgId: ORG,
        userId: ACTOR,
        itemId: ITEM,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
      },
    ])
    expect(order).toEqual(['jwt', 'rbac', 'service'])

    order.length = 0
    const examStart = await serve(app)
      .post(
        `/api/elearning/exams/items/${ITEM}/start?orgId=evil-org&userId=evil-user`,
      )
      .send({})
    expect(examStart.status).toBe(200)
    expect(examStart.body).toEqual(EXAM_START_RESULT)
    expect(JSON.stringify(examStart.body)).not.toMatch(
      /answer_key|answerKey|explanation|"correct"/,
    )
    expect(examStartCalls).toEqual([
      { orgId: ORG, userId: ACTOR, itemId: ITEM },
    ])
    expect(order).toEqual(['jwt', 'rbac', 'service'])

    order.length = 0
    const examSubmit = await serve(app)
      .post(`/api/elearning/exams/attempts/${ATTEMPT}/submit`)
      .send(SUBMIT_BODY)
    expect(examSubmit.status).toBe(200)
    expect(examSubmit.body).toEqual(EXAM_SUBMIT_RESULT)
    expect(examSubmitCalls).toEqual([
      {
        orgId: ORG,
        userId: ACTOR,
        attemptId: ATTEMPT,
        answers: ANSWERS,
      },
    ])
    expect(order).toEqual(['jwt', 'rbac', 'service'])

    order.length = 0
    const hugePublish = { ...PUBLISH_BODY, title: 'x'.repeat(20 * 1024) }
    const anonPublish = await serve(app)
      .post('/api/elearning/courses/publish')
      .set('x-test-anon', '1')
      .send(hugePublish)
    expect(anonPublish.status).toBe(401)
    expect(publishCalls).toHaveLength(0)
    expect(order).toEqual(['jwt'])

    order.length = 0
    const noOrgPublish = await serve(app)
      .post('/api/elearning/courses/publish')
      .set('x-test-no-org', '1')
      .send(hugePublish)
    expect(noOrgPublish.status).toBe(403)
    expect(noOrgPublish.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(publishCalls).toHaveLength(0)
    expect(order.includes('rbac')).toBe(false)

    order.length = 0
    const deniedPublish = await serve(app)
      .post('/api/elearning/courses/publish')
      .set('x-test-deny', '1')
      .send(hugePublish)
    expect(deniedPublish.status).toBe(403)
    expect(publishCalls).toHaveLength(0)
    expect(order).toEqual(['jwt', 'rbac'])

    order.length = 0
    const publish = await serve(app)
      .post(
        `/api/elearning/courses/publish?orgId=evil-org&actorId=evil-actor&userId=evil-user`,
      )
      .set('x-user-id', 'header-user')
      .set('x-tenant-id', 'header-org')
      .send(PUBLISH_BODY)
    expect(publish.status).toBe(201)
    expect(publish.body).toEqual(PUBLISH_RESULT)
    expect(JSON.stringify(publish.body)).not.toContain(PLAYBACK_SECRET)
    expect(publishCalls).toEqual([
      {
        orgId: ORG,
        actorId: ACTOR,
        requestId: REQUEST_ID,
        title: PUBLISH_BODY.title,
        mediaId: MEDIA,
        passScore: 10,
        maxAttempts: 3,
        questions: PUBLISH_BODY.questions,
      },
    ])
    expect(order).toEqual(['jwt', 'rbac', 'service'])

    order.length = 0
    const deniedLearner = await serve(app)
      .get('/api/elearning/me/courses')
      .set('x-test-deny-read', '1')
    expect(deniedLearner.status).toBe(403)
    expect(learnerCalls).toHaveLength(0)
    expect(order).toEqual(['jwt', 'rbac'])

    order.length = 0
    const learner = await serve(app)
      .get(`/api/elearning/me/courses?orgId=evil-org&userId=evil-user`)
      .set('x-user-id', 'header-user')
      .set('x-tenant-id', 'header-org')
    expect(learner.status).toBe(200)
    expect(learner.body).toEqual({ courses: LEARNER_COURSES })
    expect(Object.keys(learner.body)).toEqual(['courses'])
    expect(Array.isArray(learner.body)).toBe(false)
    expect(JSON.stringify(learner.body)).not.toContain(PLAYBACK_SECRET)
    expect(JSON.stringify(learner.body)).not.toContain(JWT_SECRET)
    expect(JSON.stringify(learner.body)).not.toMatch(
      /storage_key|storageKey|answer_key|answerKey|paper_snapshot|sha256/,
    )
    expect(JSON.stringify(learner.body)).not.toContain('explanation')
    expect(JSON.stringify(learner.body)).not.toMatch(/"correct"/)
    expect(learnerCalls).toEqual([{ orgId: ORG, userId: ACTOR }])
    expect(order).toEqual(['jwt', 'rbac', 'service'])
  })

  test('route-local JSON limits stay effective before the later 10 MB parser', async () => {
    const assignCalls: unknown[] = []
    const startCalls: unknown[] = []
    const heartbeatCalls: unknown[] = []
    const ticketCalls: unknown[] = []
    const examStartCalls: unknown[] = []
    const examSubmitCalls: unknown[] = []
    const publishCalls: unknown[] = []
    const learnerCalls: unknown[] = []
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
      adminGuard: (_req, _res, next) => {
        order.push('rbac')
        next()
      },
      writeGuard: (_req, _res, next) => {
        order.push('rbac')
        next()
      },
      readGuard: (_req, _res, next) => {
        order.push('rbac')
        next()
      },
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
      publishElearningCourse: async (_db, input) => {
        publishCalls.push(input)
        order.push('service')
        return PUBLISH_RESULT
      },
      listElearningLearnerCourses: async (_db, input) => {
        learnerCalls.push(input)
        order.push('service')
        return LEARNER_COURSES
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
      .send({ answers: { [Q1]: '字'.repeat(10_000) } })
    expect(examSubmit.status).toBe(200)
    expect(examSubmit.body).toEqual(EXAM_SUBMIT_RESULT)
    expect(examSubmitCalls).toHaveLength(1)
    expect(order).toEqual(['jwt', 'rbac', 'service'])

    order.length = 0
    const underPublish = await serve(app)
      .post('/api/elearning/courses/publish')
      .send({ ...PUBLISH_BODY, title: 'x'.repeat(20 * 1024) })
    expect(underPublish.status).toBe(201)
    expect(underPublish.body).toEqual(PUBLISH_RESULT)
    expect(publishCalls).toHaveLength(1)
    expect((publishCalls[0] as { orgId: string; actorId: string }).orgId).toBe(
      ORG,
    )
    expect(
      (publishCalls[0] as { orgId: string; actorId: string }).actorId,
    ).toBe(ACTOR)
    expect(order).toEqual(['jwt', 'rbac', 'service'])

    order.length = 0
    publishCalls.length = 0
    const nearPublish = `{${' '.repeat(64 * 1024)}"requestId":"${REQUEST_ID}","title":"Pilot course","mediaId":"${MEDIA}","passScore":10,"maxAttempts":3,"questions":${JSON.stringify(PUBLISH_BODY.questions)}}`
    expect(Buffer.byteLength(nearPublish)).toBeGreaterThan(16 * 1024)
    expect(Buffer.byteLength(nearPublish)).toBeLessThan(1024 * 1024)
    const nearRes = await serve(app)
      .post('/api/elearning/courses/publish')
      .set('content-type', 'application/json')
      .send(nearPublish)
    expect(nearRes.status).toBe(201)
    expect(publishCalls).toHaveLength(1)
    expect(order).toEqual(['jwt', 'rbac', 'service'])

    order.length = 0
    publishCalls.length = 0
    const publishLimit = 1024 * 1024
    const overJson = `{${' '.repeat(publishLimit - 1)}}`
    expect(Buffer.byteLength(overJson)).toBe(publishLimit + 1)
    const overPublish = await serve(app)
      .post('/api/elearning/courses/publish')
      .set('content-type', 'application/json')
      .send(overJson)
    expect(overPublish.status).toBe(413)
    expect(overPublish.body).toEqual({ error: 'payload_too_large' })
    expect(JSON.stringify(overPublish.body)).not.toContain(PLAYBACK_SECRET)
    expect(JSON.stringify(overPublish.body)).not.toMatch(
      /too large|entity|limit|bytes/i,
    )
    expect(publishCalls).toHaveLength(0)
    expect(order).toEqual(['jwt', 'rbac'])

    order.length = 0
    const learner = await serve(app)
      .get('/api/elearning/me/courses?orgId=evil-org&userId=evil-user')
      .set('content-type', 'application/json')
      .send('{')
    expect(learner.status).toBe(200)
    expect(learner.body).toEqual({ courses: LEARNER_COURSES })
    expect(Object.keys(learner.body)).toEqual(['courses'])
    expect(JSON.stringify(learner.body)).not.toMatch(
      /storage_key|storageKey|answer_key|answerKey|paper_snapshot/,
    )
    expect(learnerCalls).toEqual([{ orgId: ORG, userId: ACTOR }])
    expect(order).toEqual(['jwt', 'rbac', 'service'])
  })

  test('index.ts mounts the pilot runtime in setupMiddleware before the global 10 MB parser, not in start', () => {
    const raw = readFileSync(INDEX_SRC, 'utf8')
    const src = stripTsComments(raw)
    expect(src).toMatch(/createElearningPilotRuntime/)
    expect(src).toMatch(/this\.app\.use\(\s*elearningPilotRuntime\.router\s*\)/)
    expect(src).toMatch(
      /createElearningPilotRuntime\(\s*\{\s*db:\s*poolManager\.get\(\)\s*\}\s*\)/,
    )

    const setupAt = src.search(
      /private\s+setupMiddleware\s*\(\s*\)\s*:\s*void\s*\{/,
    )
    const setupEndAt = src.search(
      /private\s+installGlobalErrorHandler\s*\(\s*\)\s*:\s*void\s*\{/,
    )
    const startAt = src.search(
      /async\s+start\s*\(\s*\)\s*:\s*Promise\s*<\s*void\s*>\s*\{/,
    )
    expect(setupAt).toBeGreaterThanOrEqual(0)
    expect(setupEndAt).toBeGreaterThan(setupAt)
    expect(startAt).toBeGreaterThan(setupEndAt)

    const setupSrc = src.slice(setupAt, setupEndAt)
    const startSrc = src.slice(startAt)
    const createAt = setupSrc.search(/createElearningPilotRuntime/)
    const mountAt = setupSrc.search(
      /this\.app\.use\(\s*elearningPilotRuntime\.router\s*\)/,
    )
    const jsonAt = setupSrc.search(
      /this\.app\.use\(\s*express\.json\(\s*\{\s*limit:\s*['"]10mb['"]\s*\}\s*\)\s*\)/,
    )
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
    const publishCalls: unknown[] = []
    const learnerCalls: unknown[] = []
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
      adminGuard: (_req, _res, next) => next(),
      issueElearningMediaPlaybackTicket: async (_db, input) => {
        ticketCalls.push(input)
        return TICKET_RESULT
      },
      startElearningExam: async (_db, input) => {
        examStartCalls.push(input)
        return EXAM_START_RESULT
      },
      publishElearningCourse: async (_db, input) => {
        publishCalls.push(input)
        return PUBLISH_RESULT
      },
      listElearningLearnerCourses: async (_db, input) => {
        learnerCalls.push(input)
        return LEARNER_COURSES
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
    expect(
      (ticketCalls[0] as { playbackSigningSecret: string })
        .playbackSigningSecret,
    ).toBe(PLAYBACK_SECRET)

    const publish = await serve(app).post('/api/elearning/courses/publish').send(PUBLISH_BODY)
    expect(publish.status).toBe(404)
    expect(publish.body).toEqual({ error: 'not_found' })
    expect(publishCalls).toHaveLength(0)

    const learner = await serve(app).get('/api/elearning/me/courses')
    expect(learner.status).toBe(404)
    expect(learner.body).toEqual({ error: 'not_found' })
    expect(learnerCalls).toHaveLength(0)
  })
})
