import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import {
  isElearningAssignmentSurfaceEnabled,
  isElearningContentSurfaceEnabled,
  isElearningExamSurfaceEnabled,
  isElearningWatchSurfaceEnabled,
} from '../../src/elearning/feature-flags'
import { createElearningPilotRouter } from '../../src/routes/elearning-pilot'
import {
  ElearningDirectAssignmentError,
  type ElearningDirectAssignmentDb,
  type ElearningDirectAssignmentErrorCode,
  type ElearningDirectAssignmentResult,
  type AssignElearningDirectInput,
} from '../../src/services/elearning-direct-assignment'
import {
  ElearningCoursePublishError,
  type ElearningCoursePublishDb,
  type ElearningCoursePublishErrorCode,
  type ElearningCoursePublishResult,
  type PublishElearningCourseInput,
} from '../../src/services/elearning-course-publish'
import {
  ElearningExamError,
  type ElearningExamDb,
  type ElearningExamErrorCode,
  type ElearningExamStartResult,
  type ElearningExamSubmitResult,
  type SaveElearningExamAnswersInput,
  type StartElearningExamInput,
  type SubmitElearningExamInput,
} from '../../src/services/elearning-exam'
import {
  ElearningLearnerCoursesError,
  type ElearningLearnerCourse,
  type ElearningLearnerCoursesErrorCode,
  type ElearningLearnerCoursesQueryable,
  type ListElearningLearnerCoursesInput,
} from '../../src/services/elearning-learner-courses'
import {
  ELEARNING_MEDIA_PLAYBACK_SECRET_ENV,
  ElearningPlaybackError,
  type ElearningMediaPlaybackTicket,
  type ElearningPlaybackDb,
  type ElearningPlaybackErrorCode,
  type IssueElearningMediaPlaybackInput,
} from '../../src/services/elearning-media-playback'
import {
  ElearningScopeError,
  type ElearningScopeDb,
  type SetElearningCourseScopeInput,
  type SetElearningCourseScopeResult,
} from '../../src/services/elearning-scope'
import {
  ElearningWatchError,
  type ElearningWatchDb,
  type ElearningWatchErrorCode,
  type ElearningWatchState,
  type RecordElearningHeartbeatInput,
  type StartElearningWatchInput,
} from '../../src/services/elearning-watch-progress'
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

const ORG = 'org-pilot-1'
const ACTOR = 'actor-pilot-1'
const TARGET = 'user-pilot-1'
const SOURCE = 'src-pilot-1'
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
const STORAGE_KEY = 'elearning-media/2026-08/secret-object-key.mp4'

const ASSIGN_BODY = {
  targetUserId: TARGET,
  courseVersionId: VERSION,
  sourceKey: SOURCE,
}

const SCOPE_BODY = {
  reason: 'initial visibility',
  rules: [{ subjectType: 'user', subjectRef: TARGET }],
}

const SCOPE_RESULT: SetElearningCourseScopeResult = {
  courseId: REQUEST_ID,
  scopeId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
  revisionId: 'dededede-dede-4ede-8ede-dededededede',
  revision: 1,
  ruleIds: ['efefefef-efef-4fef-8fef-efefefefefef'],
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

const PLAYBACK_ERRORS: Array<[ElearningPlaybackErrorCode, number]> = [
  ['invalid_input', 400],
  ['not_found', 404],
  ['assignment_unavailable', 403],
  ['course_withdrawn', 409],
  ['unsupported_item', 400],
  ['unavailable', 503],
  ['invalid_token', 401],
  ['token_expired', 401],
  ['invalid_range', 400],
  ['unsatisfiable_range', 416],
]

const EXAM_ERRORS: Array<[ElearningExamErrorCode, number]> = [
  ['invalid_input', 400],
  ['not_found', 404],
  ['assignment_unavailable', 403],
  ['course_withdrawn', 409],
  ['unsupported_item', 400],
  ['prerequisite_incomplete', 409],
  ['max_attempts', 409],
  ['conflict', 409],
  ['unavailable', 503],
]

const PUBLISH_ERRORS: Array<[ElearningCoursePublishErrorCode, number]> = [
  ['invalid_input', 400],
  ['media_unavailable', 409],
  ['conflict', 409],
  ['unavailable', 503],
]

const LEARNER_ERRORS: Array<[ElearningLearnerCoursesErrorCode, number]> = [
  ['invalid_input', 400],
  ['unavailable', 503],
]

const HEARTBEAT_BODY = { sequence: 1, positionMs: 1000, playing: true }

const TICKET_RESULT: ElearningMediaPlaybackTicket = {
  token: 'playback.ticket.token',
  expiresAt: '2026-08-25T12:10:00.000Z',
  ttlSeconds: 600,
  itemId: ITEM,
  mediaId: MEDIA,
}

const EXAM_START_RESULT: ElearningExamStartResult = {
  attemptId: ATTEMPT,
  attemptNo: 1,
  status: 'started',
  paper: {
    domain: 'elearning.exam.paper.v1',
    version: 1,
    questions: [
      {
        position: 1,
        questionRevisionId: Q1,
        questionType: 'single_choice',
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

const EXAM_SUBMIT_RESULT: ElearningExamSubmitResult = {
  attemptId: ATTEMPT,
  attemptNo: 1,
  status: 'graded',
  autoScore: 10,
  totalScore: 10,
  passed: true,
  duplicate: false,
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

const PUBLISH_RESULT: ElearningCoursePublishResult = {
  courseId: REQUEST_ID,
  courseVersionId: VERSION,
  videoItemId: ITEM,
  examItemId: EXAM_ITEM_ID,
  examId: PUBLISHED_EXAM_ID,
  status: 'published',
  questionCount: 1,
  totalScore: 10,
}

const LEARNER_COURSES: ElearningLearnerCourse[] = [
  {
    courseId: REQUEST_ID,
    courseVersionId: VERSION,
    title: 'Pilot course',
    access: { kind: 'assignment', required: true },
    assignment: {
      deadline: null,
      assignedAt: '2026-01-02T03:04:05.000Z',
    },
    video: {
      itemId: ITEM,
      durationMs: 10_000,
      status: 'not_started',
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

const pinned = usePinnedServer()
function serve(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

function dummyDb(): ElearningDirectAssignmentDb &
  ElearningWatchDb &
  ElearningPlaybackDb &
  ElearningExamDb &
  ElearningCoursePublishDb &
  ElearningLearnerCoursesQueryable &
  ElearningScopeDb {
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
  expect(blob).not.toContain(ATTEMPT)
  expect(blob).not.toContain(PLAYBACK_SECRET)
  expect(blob).not.toContain(JWT_SECRET)
  expect(blob).not.toContain(STORAGE_KEY)
  expect(blob).not.toMatch(/storage_key|storageKey|answer_key|answerKey/)
  expect(blob).not.toMatch(/host|secret|stack|at /i)
}

function assertNoSecrets(body: unknown): void {
  const blob = JSON.stringify(body)
  expect(blob).not.toContain(PLAYBACK_SECRET)
  expect(blob).not.toContain(JWT_SECRET)
  expect(blob).not.toContain(STORAGE_KEY)
  expect(blob).not.toMatch(/storage_key|storageKey/)
  expect(blob).not.toMatch(/answer_key|answerKey/)
  expect(blob).not.toContain('explanation')
  expect(blob).not.toMatch(/"correct"/)
  expect(blob).not.toMatch(/paper_snapshot|sha256/)
}

function assertLearnerEnvelope(body: unknown, courses = LEARNER_COURSES): void {
  expect(body).toEqual({ courses })
  expect(Array.isArray(body)).toBe(false)
  expect(Object.keys(body as Record<string, unknown>)).toEqual(['courses'])
  assertNoSecrets(body)
}

function makeApp(
  over: {
    viewer?: string | null
    org?: string | null
    hasAdmin?: boolean
    hasRead?: boolean
    env?: NodeJS.ProcessEnv
    assignError?: unknown
    startError?: unknown
    heartbeatError?: unknown
    ticketError?: unknown
    examStartError?: unknown
    examSaveError?: unknown
    examSubmitError?: unknown
    publishError?: unknown
    learnerError?: unknown
    scopeError?: unknown
    assignResult?: ElearningDirectAssignmentResult
    startResult?: ElearningWatchState
    heartbeatResult?: ElearningWatchState
    ticketResult?: ElearningMediaPlaybackTicket
    examStartResult?: ElearningExamStartResult
    examSaveResult?: ElearningExamStartResult
    examSubmitResult?: ElearningExamSubmitResult
    publishResult?: ElearningCoursePublishResult
    learnerResult?: ElearningLearnerCourse[]
    scopeResult?: SetElearningCourseScopeResult
  } = {},
) {
  const assignCalls: AssignElearningDirectInput[] = []
  const startCalls: StartElearningWatchInput[] = []
  const heartbeatCalls: RecordElearningHeartbeatInput[] = []
  const ticketCalls: IssueElearningMediaPlaybackInput[] = []
  const examStartCalls: StartElearningExamInput[] = []
  const examSaveCalls: SaveElearningExamAnswersInput[] = []
  const examSubmitCalls: SubmitElearningExamInput[] = []
  const publishCalls: PublishElearningCourseInput[] = []
  const learnerCalls: ListElearningLearnerCoursesInput[] = []
  const scopeCalls: SetElearningCourseScopeInput[] = []
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
    issueElearningMediaPlaybackTicket: async (_db, input) => {
      ticketCalls.push(input)
      order.push('service')
      if (over.ticketError) throw over.ticketError
      return over.ticketResult ?? TICKET_RESULT
    },
    startElearningExam: async (_db, input) => {
      examStartCalls.push(input)
      order.push('service')
      if (over.examStartError) throw over.examStartError
      return over.examStartResult ?? EXAM_START_RESULT
    },
    saveElearningExamAnswers: async (_db, input) => {
      examSaveCalls.push(input)
      order.push('service')
      if (over.examSaveError) throw over.examSaveError
      return over.examSaveResult ?? { ...EXAM_START_RESULT, answers: ANSWERS }
    },
    submitElearningExam: async (_db, input) => {
      examSubmitCalls.push(input)
      order.push('service')
      if (over.examSubmitError) throw over.examSubmitError
      return over.examSubmitResult ?? EXAM_SUBMIT_RESULT
    },
    publishElearningCourse: async (_db, input) => {
      publishCalls.push(input)
      order.push('service')
      if (over.publishError) throw over.publishError
      return over.publishResult ?? PUBLISH_RESULT
    },
    listElearningLearnerCourses: async (_db, input) => {
      learnerCalls.push(input)
      order.push('service')
      if (over.learnerError) throw over.learnerError
      return over.learnerResult ?? LEARNER_COURSES
    },
    setElearningCourseScope: async (_db, input) => {
      scopeCalls.push(input)
      order.push('service')
      if (over.scopeError) throw over.scopeError
      return over.scopeResult ?? SCOPE_RESULT
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
    ticketCalls,
    examStartCalls,
    examSaveCalls,
    examSubmitCalls,
    publishCalls,
    learnerCalls,
    scopeCalls,
    order,
    get adminCalls() { return adminCalls },
    get readCalls() { return readCalls },
  }
}

describe('elearning routes (independent content/assignment/watch/exam gates)', () => {
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
    expect(
      createElearningPilotRouter({ ...deps, env: {} as NodeJS.ProcessEnv }),
    ).toBeNull()
    for (const flag of FLAG_NAMES) {
      for (const value of LOOKALIKES) {
        const env = {
          ...FLAG_ON,
          [flag]: value,
        } as unknown as NodeJS.ProcessEnv
        expect(createElearningPilotRouter({ ...deps, env })).toBeNull()
      }
    }
    expect(isElearningContentSurfaceEnabled(FLAG_ON)).toBe(true)
    expect(isElearningAssignmentSurfaceEnabled(FLAG_ON)).toBe(true)
    expect(
      isElearningWatchSurfaceEnabled({
        ...FLAG_ON,
        ELEARNING_ASSIGNMENT_ENABLED: 'false',
      } as NodeJS.ProcessEnv),
    ).toBe(true)
    expect(
      createElearningPilotRouter({
        ...deps,
        env: {
          ...FLAG_ON,
          ELEARNING_ASSESSMENT_ENABLED: 'false',
        } as unknown as NodeJS.ProcessEnv,
      }),
    ).not.toBeNull()
    expect(isElearningExamSurfaceEnabled(FLAG_ON)).toBe(false)
    expect(isElearningExamSurfaceEnabled(FLAG_EXAM_ON)).toBe(true)
    for (const value of LOOKALIKES) {
      const env = {
        ...FLAG_EXAM_ON,
        ELEARNING_ASSESSMENT_ENABLED: value,
      } as unknown as NodeJS.ProcessEnv
      expect(isElearningExamSurfaceEnabled(env)).toBe(false)
      expect(createElearningPilotRouter({ ...deps, env })).not.toBeNull()
    }
  })

  test('publish and learner-list lookalikes 404 before identity/RBAC/service', async () => {
    const noopGuard: express.RequestHandler = (_req, _res, next) => next()
    const deps = {
      db: dummyDb(),
      viewerId: () => ACTOR,
      orgId: () => ORG,
      adminGuard: noopGuard,
      readGuard: noopGuard,
    }
    const assessmentLookalikes = makeApp({
      env: FLAG_ON,
      viewer: null,
      org: null,
      hasAdmin: false,
      hasRead: false,
    })
    const publishOff = await serve(assessmentLookalikes.app)
      .post('/api/elearning/courses/publish')
      .send(PUBLISH_BODY)
    expect(publishOff.status).toBe(404)
    expect(publishOff.body).toEqual({ error: 'not_found' })
    expect(assessmentLookalikes.adminCalls).toBe(0)
    expect(assessmentLookalikes.publishCalls).toHaveLength(0)
    expect(assessmentLookalikes.order.includes('identity')).toBe(false)

    const learnerOff = await serve(assessmentLookalikes.app).get(
      '/api/elearning/me/courses',
    )
    expect(learnerOff.status).toBe(404)
    expect(learnerOff.body).toEqual({ error: 'not_found' })
    expect(assessmentLookalikes.readCalls).toBe(0)
    expect(assessmentLookalikes.learnerCalls).toHaveLength(0)

    for (const value of LOOKALIKES) {
      const env = {
        ...FLAG_EXAM_ON,
        ELEARNING_ASSESSMENT_ENABLED: value,
      } as unknown as NodeJS.ProcessEnv
      expect(isElearningExamSurfaceEnabled(env)).toBe(false)
      expect(createElearningPilotRouter({ ...deps, env })).not.toBeNull()
      const app = makeApp({
        env,
        viewer: null,
        org: null,
        hasAdmin: false,
        hasRead: false,
      })
      const publish = await serve(app.app)
        .post('/api/elearning/courses/publish')
        .send(PUBLISH_BODY)
      expect(publish.status).toBe(404)
      expect(publish.body).toEqual({ error: 'not_found' })
      expect(app.publishCalls).toHaveLength(0)
      expect(app.adminCalls).toBe(0)
      const learner = await serve(app.app).get('/api/elearning/me/courses')
      expect(learner.status).toBe(404)
      expect(learner.body).toEqual({ error: 'not_found' })
      expect(app.learnerCalls).toHaveLength(0)
      expect(app.readCalls).toBe(0)
    }

    for (const flag of FLAG_NAMES) {
      for (const value of LOOKALIKES) {
        const env = {
          ...FLAG_EXAM_ON,
          [flag]: value,
        } as unknown as NodeJS.ProcessEnv
        expect(createElearningPilotRouter({ ...deps, env })).toBeNull()
      }
    }
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
    const start = await serve(app.app)
      .post(`/api/elearning/watch/items/${ITEM}/start`)
      .send({})
    expect(start.status).toBe(200)
    expect(app.startCalls).toHaveLength(1)
    const beat = await serve(app.app)
      .post(`/api/elearning/watch/sessions/${SESSION}/heartbeat`)
      .send(HEARTBEAT_BODY)
    expect(beat.status).toBe(200)
    expect(app.heartbeatCalls).toHaveLength(1)
    const ticket = await serve(app.app)
      .post(`/api/elearning/watch/items/${ITEM}/playback-ticket`)
      .send({})
    expect(ticket.status).toBe(200)
    expect(app.ticketCalls).toHaveLength(1)

    const examEnv = { ...FLAG_EXAM_ON } as unknown as NodeJS.ProcessEnv
    const examApp = makeApp({ env: examEnv })
    examEnv.ELEARNING_ASSESSMENT_ENABLED = 'false'
    const examStart = await serve(examApp.app).post(`/api/elearning/exams/items/${ITEM}/start`).send({})
    expect(examStart.status).toBe(404)
    expect(examStart.body).toEqual({ error: 'not_found' })
    expect(examApp.examStartCalls).toHaveLength(0)
    expect(examApp.readCalls).toBe(0)
    const examSave = await serve(examApp.app)
      .put(`/api/elearning/exams/attempts/${ATTEMPT}/answers`)
      .send(SUBMIT_BODY)
    expect(examSave.status).toBe(404)
    expect(examSave.body).toEqual({ error: 'not_found' })
    expect(examApp.examSaveCalls).toHaveLength(0)
    const examSubmit = await serve(examApp.app)
      .post(`/api/elearning/exams/attempts/${ATTEMPT}/submit`)
      .send(SUBMIT_BODY)
    expect(examSubmit.status).toBe(404)
    expect(examSubmit.body).toEqual({ error: 'not_found' })
    expect(examApp.examSubmitCalls).toHaveLength(0)
    const examTicket = await serve(examApp.app)
      .post(`/api/elearning/watch/items/${ITEM}/playback-ticket`)
      .send({})
    expect(examTicket.status).toBe(200)
    expect(examApp.ticketCalls).toHaveLength(1)

    const publish = await serve(examApp.app).post('/api/elearning/courses/publish').send(PUBLISH_BODY)
    expect(publish.status).toBe(404)
    expect(publish.body).toEqual({ error: 'not_found' })
    expect(examApp.publishCalls).toHaveLength(0)
    expect(examApp.adminCalls).toBe(0)
    const learner = await serve(examApp.app).get('/api/elearning/me/courses')
    expect(learner.status).toBe(404)
    expect(learner.body).toEqual({ error: 'not_found' })
    expect(examApp.learnerCalls).toHaveLength(0)
  })

  test('scope revision is content-only, strict, admin-gated, and rechecks flags', async () => {
    const contentEnv = {
      ...FLAG_ON,
      ELEARNING_ASSIGNMENT_ENABLED: 'false',
      ELEARNING_MEDIA_ENABLED: 'false',
    } as unknown as NodeJS.ProcessEnv
    const app = makeApp({ env: contentEnv })
    const response = await serve(app.app)
      .put(
        `/api/elearning/courses/${REQUEST_ID}/scope?orgId=evil-org&actorId=evil-actor`,
      )
      .set('x-tenant-id', 'header-org')
      .send(SCOPE_BODY)
    expect(response.status).toBe(200)
    expect(response.body).toEqual(SCOPE_RESULT)
    expect(app.scopeCalls).toEqual([
      {
        orgId: ORG,
        actorId: ACTOR,
        courseId: REQUEST_ID,
        reason: SCOPE_BODY.reason,
        rules: SCOPE_BODY.rules,
      },
    ])
    expect(app.adminCalls).toBe(1)

    const watch = await serve(app.app)
      .post(`/api/elearning/watch/items/${ITEM}/start`)
      .send({})
    expect(watch.status).toBe(404)
    const assignment = await serve(app.app)
      .post('/api/elearning/assignments/direct')
      .send(ASSIGN_BODY)
    expect(assignment.status).toBe(404)

    const strict = makeApp({ env: contentEnv })
    for (const body of [
      { reason: SCOPE_BODY.reason },
      { rules: [] },
      { ...SCOPE_BODY, orgId: 'evil-org' },
      { ...SCOPE_BODY, actorId: 'evil-actor' },
      null,
      [],
    ]) {
      const invalidResponse = await serve(strict.app)
        .put(`/api/elearning/courses/${REQUEST_ID}/scope`)
        .send(body)
      expect(invalidResponse.status).toBe(400)
      expect(invalidResponse.body).toEqual({ error: 'invalid_input' })
    }
    expect(strict.scopeCalls).toHaveLength(0)

    const unsupported = makeApp({
      env: contentEnv,
      scopeError: new ElearningScopeError('unsupported_subject'),
    })
    const unsupportedResponse = await serve(unsupported.app)
      .put(`/api/elearning/courses/${REQUEST_ID}/scope`)
      .send({
        reason: 'department rule',
        rules: [{ subjectType: 'department', subjectRef: 'd1' }],
      })
    expect(unsupportedResponse.status).toBe(422)
    expect(unsupportedResponse.body).toEqual({ error: 'unsupported_subject' })

    contentEnv.ELEARNING_CONTENT_ENABLED = 'false'
    const disabled = await serve(app.app)
      .put(`/api/elearning/courses/${REQUEST_ID}/scope`)
      .send(SCOPE_BODY)
    expect(disabled.status).toBe(404)
    expect(app.scopeCalls).toHaveLength(1)
  })

  test('identity then org then RBAC occur before service calls', async () => {
    const anon = makeApp({
      viewer: null,
      org: null,
      hasAdmin: false,
      hasRead: false,
    })
    const anonAssign = await serve(anon.app)
      .post('/api/elearning/assignments/direct')
      .send(ASSIGN_BODY)
    expect(anonAssign.status).toBe(401)
    expect(anonAssign.body).toEqual({ error: 'unauthenticated' })
    expect(anon.adminCalls).toBe(0)
    expect(anon.readCalls).toBe(0)
    expect(anon.assignCalls).toHaveLength(0)
    expect(
      anon.order.filter(
        (step) => step === 'org' || step === 'rbac' || step === 'service',
      ),
    ).toEqual([])

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
    expect(
      deniedAssign.order.filter(
        (step) => step === 'identity' || step === 'org' || step === 'rbac',
      ),
    ).toEqual(['identity', 'org', 'rbac'])

    const deniedWatch = makeApp({ hasRead: false })
    const rbacWatch = await serve(deniedWatch.app).post(`/api/elearning/watch/items/${ITEM}/start`).send({})
    expect(rbacWatch.status).toBe(403)
    expect(deniedWatch.readCalls).toBe(1)
    expect(deniedWatch.adminCalls).toBe(0)
    expect(deniedWatch.startCalls).toHaveLength(0)
    expect(
      deniedWatch.order.filter(
        (step) => step === 'identity' || step === 'org' || step === 'rbac',
      ),
    ).toEqual(['identity', 'org', 'rbac'])

    const anonTicket = await serve(anon.app).post(`/api/elearning/watch/items/${ITEM}/playback-ticket`).send({})
    expect(anonTicket.status).toBe(401)
    expect(anon.ticketCalls).toHaveLength(0)

    const orgTicket = await serve(noOrg.app).post(`/api/elearning/watch/items/${ITEM}/playback-ticket`).send({})
    expect(orgTicket.status).toBe(403)
    expect(noOrg.ticketCalls).toHaveLength(0)

    const deniedTicket = makeApp({ hasRead: false })
    const rbacTicket = await serve(deniedTicket.app)
      .post(`/api/elearning/watch/items/${ITEM}/playback-ticket`)
      .send({})
    expect(rbacTicket.status).toBe(403)
    expect(deniedTicket.readCalls).toBe(1)
    expect(deniedTicket.ticketCalls).toHaveLength(0)

    const anonExam = makeApp({
      viewer: null,
      org: null,
      hasRead: false,
      env: FLAG_EXAM_ON,
    })
    const anonExamStart = await serve(anonExam.app)
      .post(`/api/elearning/exams/items/${ITEM}/start`)
      .send({})
    expect(anonExamStart.status).toBe(401)
    expect(anonExam.examStartCalls).toHaveLength(0)
    expect(anonExam.readCalls).toBe(0)
    const anonExamSave = await serve(anonExam.app)
      .put(`/api/elearning/exams/attempts/${ATTEMPT}/answers`)
      .send(SUBMIT_BODY)
    expect(anonExamSave.status).toBe(401)
    expect(anonExam.examSaveCalls).toHaveLength(0)
    const anonExamSubmit = await serve(anonExam.app)
      .post(`/api/elearning/exams/attempts/${ATTEMPT}/submit`)
      .send(SUBMIT_BODY)
    expect(anonExamSubmit.status).toBe(401)
    expect(anonExam.examSubmitCalls).toHaveLength(0)

    const noOrgExam = makeApp({ org: null, hasRead: false, env: FLAG_EXAM_ON })
    const orgExamStart = await serve(noOrgExam.app).post(`/api/elearning/exams/items/${ITEM}/start`).send({})
    expect(orgExamStart.status).toBe(403)
    expect(noOrgExam.readCalls).toBe(0)
    expect(noOrgExam.examStartCalls).toHaveLength(0)
    const orgExamSave = await serve(noOrgExam.app)
      .put(`/api/elearning/exams/attempts/${ATTEMPT}/answers`)
      .send(SUBMIT_BODY)
    expect(orgExamSave.status).toBe(403)
    expect(noOrgExam.examSaveCalls).toHaveLength(0)

    const deniedExam = makeApp({ hasRead: false, env: FLAG_EXAM_ON })
    const rbacExam = await serve(deniedExam.app).post(`/api/elearning/exams/items/${ITEM}/start`).send({})
    expect(rbacExam.status).toBe(403)
    expect(deniedExam.readCalls).toBe(1)
    expect(deniedExam.examStartCalls).toHaveLength(0)
    expect(
      deniedExam.order.filter(
        (step) => step === 'identity' || step === 'org' || step === 'rbac',
      ),
    ).toEqual(['identity', 'org', 'rbac'])

    const deniedExamSave = makeApp({ hasRead: false, env: FLAG_EXAM_ON })
    const rbacExamSave = await serve(deniedExamSave.app)
      .put(`/api/elearning/exams/attempts/${ATTEMPT}/answers`)
      .send(SUBMIT_BODY)
    expect(rbacExamSave.status).toBe(403)
    expect(deniedExamSave.readCalls).toBe(1)
    expect(deniedExamSave.examSaveCalls).toHaveLength(0)
    expect(
      deniedExamSave.order.filter(
        (step) => step === 'identity' || step === 'org' || step === 'rbac',
      ),
    ).toEqual(['identity', 'org', 'rbac'])

    const anonPublish = makeApp({
      viewer: null,
      org: null,
      hasAdmin: false,
      env: FLAG_EXAM_ON,
    })
    const anonPublishRes = await serve(anonPublish.app)
      .post('/api/elearning/courses/publish')
      .send(PUBLISH_BODY)
    expect(anonPublishRes.status).toBe(401)
    expect(anonPublishRes.body).toEqual({ error: 'unauthenticated' })
    expect(anonPublish.adminCalls).toBe(0)
    expect(anonPublish.readCalls).toBe(0)
    expect(anonPublish.publishCalls).toHaveLength(0)

    const noOrgPublish = makeApp({
      org: null,
      hasAdmin: false,
      env: FLAG_EXAM_ON,
    })
    const orgPublish = await serve(noOrgPublish.app)
      .post('/api/elearning/courses/publish')
      .send(PUBLISH_BODY)
    expect(orgPublish.status).toBe(403)
    expect(orgPublish.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrgPublish.adminCalls).toBe(0)
    expect(noOrgPublish.publishCalls).toHaveLength(0)

    const deniedPublish = makeApp({ hasAdmin: false, env: FLAG_EXAM_ON })
    const rbacPublish = await serve(deniedPublish.app)
      .post('/api/elearning/courses/publish')
      .send(PUBLISH_BODY)
    expect(rbacPublish.status).toBe(403)
    expect(deniedPublish.adminCalls).toBe(1)
    expect(deniedPublish.readCalls).toBe(0)
    expect(deniedPublish.publishCalls).toHaveLength(0)
    expect(
      deniedPublish.order.filter(
        (step) => step === 'identity' || step === 'org' || step === 'rbac',
      ),
    ).toEqual(['identity', 'org', 'rbac'])

    const anonLearner = makeApp({
      viewer: null,
      org: null,
      hasRead: false,
      env: FLAG_EXAM_ON,
    })
    const anonLearnerRes = await serve(anonLearner.app).get(
      '/api/elearning/me/courses',
    )
    expect(anonLearnerRes.status).toBe(401)
    expect(anonLearnerRes.body).toEqual({ error: 'unauthenticated' })
    expect(anonLearner.readCalls).toBe(0)
    expect(anonLearner.adminCalls).toBe(0)
    expect(anonLearner.learnerCalls).toHaveLength(0)

    const noOrgLearner = makeApp({
      org: null,
      hasRead: false,
      env: FLAG_EXAM_ON,
    })
    const orgLearner = await serve(noOrgLearner.app).get(
      '/api/elearning/me/courses',
    )
    expect(orgLearner.status).toBe(403)
    expect(orgLearner.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrgLearner.readCalls).toBe(0)
    expect(noOrgLearner.learnerCalls).toHaveLength(0)

    const deniedLearner = makeApp({ hasRead: false, env: FLAG_EXAM_ON })
    const rbacLearner = await serve(deniedLearner.app).get(
      '/api/elearning/me/courses',
    )
    expect(rbacLearner.status).toBe(403)
    expect(deniedLearner.readCalls).toBe(1)
    expect(deniedLearner.adminCalls).toBe(0)
    expect(deniedLearner.learnerCalls).toHaveLength(0)
    expect(
      deniedLearner.order.filter(
        (step) => step === 'identity' || step === 'org' || step === 'rbac',
      ),
    ).toEqual(['identity', 'org', 'rbac'])
  })

  test('happy assignment and watch calls use injected actor/org and ignore client overrides', async () => {
    const assignApp = makeApp()
    const assign = await serve(assignApp.app)
      .post(
        `/api/elearning/assignments/direct?orgId=evil-org&actorId=evil-actor&userId=${TARGET}`,
      )
      .set('x-user-id', 'header-user')
      .set('x-tenant-id', 'header-org')
      .send(ASSIGN_BODY)
    expect(assign.status).toBe(201)
    expect(assign.body).toEqual(ASSIGN_RESULT)
    expect(assignApp.assignCalls).toEqual([
      {
        orgId: ORG,
        actorId: ACTOR,
        targetUserId: TARGET,
        courseVersionId: VERSION,
        sourceKey: SOURCE,
        deadline: undefined,
      },
    ])
    expect(assignApp.adminCalls).toBe(1)
    expect(assignApp.readCalls).toBe(0)

    const withDeadline = makeApp()
    const deadlineRes = await serve(withDeadline.app)
      .post('/api/elearning/assignments/direct')
      .send({ ...ASSIGN_BODY, deadline: '2026-12-31T00:00:00.000Z' })
    expect(deadlineRes.status).toBe(201)
    expect(withDeadline.assignCalls[0]?.deadline).toBe(
      '2026-12-31T00:00:00.000Z',
    )

    const startApp = makeApp()
    const start = await serve(startApp.app)
      .post(
        `/api/elearning/watch/items/${ITEM}/start?userId=evil-user&orgId=evil-org`,
      )
      .set('x-user-id', 'header-user')
      .set('x-tenant-id', 'header-org')
      .send({})
    expect(start.status).toBe(200)
    expect(start.body).toEqual(WATCH_STATE)
    expect(startApp.startCalls).toEqual([
      { orgId: ORG, userId: ACTOR, itemId: ITEM },
    ])
    expect(startApp.readCalls).toBe(1)
    expect(startApp.adminCalls).toBe(0)

    const beatApp = makeApp()
    const beat = await serve(beatApp.app)
      .post(
        `/api/elearning/watch/sessions/${SESSION}/heartbeat?userId=evil-user&orgId=evil-org`,
      )
      .set('x-user-id', 'header-user')
      .send(HEARTBEAT_BODY)
    expect(beat.status).toBe(200)
    expect(beat.body).toEqual(WATCH_STATE)
    expect(beatApp.heartbeatCalls).toEqual([
      {
        sessionId: SESSION,
        orgId: ORG,
        userId: ACTOR,
        sequence: 1,
        positionMs: 1000,
        playing: true,
      },
    ])
    expect(beatApp.readCalls).toBe(1)
    expect(beatApp.adminCalls).toBe(0)

    const ticketApp = makeApp()
    const ticket = await serve(ticketApp.app)
      .post(
        `/api/elearning/watch/items/${ITEM}/playback-ticket?userId=evil-user&orgId=evil-org`,
      )
      .set('x-user-id', 'header-user')
      .set('x-tenant-id', 'header-org')
      .send({})
    expect(ticket.status).toBe(200)
    expect(ticket.body).toEqual(TICKET_RESULT)
    assertNoSecrets(ticket.body)
    expect(ticketApp.ticketCalls).toEqual([
      {
        orgId: ORG,
        userId: ACTOR,
        itemId: ITEM,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
      },
    ])
    expect(ticketApp.readCalls).toBe(1)
    expect(ticketApp.adminCalls).toBe(0)

    const examStartApp = makeApp({ env: FLAG_EXAM_ON })
    const examStart = await serve(examStartApp.app)
      .post(
        `/api/elearning/exams/items/${ITEM}/start?userId=evil-user&orgId=evil-org`,
      )
      .set('x-user-id', 'header-user')
      .send({})
    expect(examStart.status).toBe(200)
    expect(examStart.body).toEqual(EXAM_START_RESULT)
    assertNoSecrets(examStart.body)
    expect(examStartApp.examStartCalls).toEqual([
      { orgId: ORG, userId: ACTOR, itemId: ITEM },
    ])
    expect(examStartApp.readCalls).toBe(1)
    expect(examStartApp.adminCalls).toBe(0)

    const examSaveApp = makeApp({ env: FLAG_EXAM_ON })
    const examSave = await serve(examSaveApp.app)
      .put(
        `/api/elearning/exams/attempts/${ATTEMPT}/answers?userId=evil-user&orgId=evil-org`,
      )
      .set('x-user-id', 'header-user')
      .send(SUBMIT_BODY)
    expect(examSave.status).toBe(200)
    expect(examSave.body).toEqual({ ...EXAM_START_RESULT, answers: ANSWERS })
    assertNoSecrets(examSave.body)
    expect(examSaveApp.examSaveCalls).toEqual([
      {
        orgId: ORG,
        userId: ACTOR,
        attemptId: ATTEMPT,
        answers: ANSWERS,
      },
    ])
    expect(examSaveApp.readCalls).toBe(1)
    expect(examSaveApp.adminCalls).toBe(0)

    const examSubmitApp = makeApp({ env: FLAG_EXAM_ON })
    const examSubmit = await serve(examSubmitApp.app)
      .post(
        `/api/elearning/exams/attempts/${ATTEMPT}/submit?userId=evil-user&orgId=evil-org`,
      )
      .set('x-user-id', 'header-user')
      .send(SUBMIT_BODY)
    expect(examSubmit.status).toBe(200)
    expect(examSubmit.body).toEqual(EXAM_SUBMIT_RESULT)
    assertNoSecrets(examSubmit.body)
    expect(examSubmitApp.examSubmitCalls).toEqual([
      {
        orgId: ORG,
        userId: ACTOR,
        attemptId: ATTEMPT,
        answers: ANSWERS,
      },
    ])
    expect(examSubmitApp.readCalls).toBe(1)

    const publishApp = makeApp({ env: FLAG_EXAM_ON })
    const publish = await serve(publishApp.app)
      .post(
        `/api/elearning/courses/publish?orgId=evil-org&actorId=evil-actor&userId=evil-user`,
      )
      .set('x-user-id', 'header-user')
      .set('x-tenant-id', 'header-org')
      .send(PUBLISH_BODY)
    expect(publish.status).toBe(201)
    expect(publish.body).toEqual(PUBLISH_RESULT)
    assertNoSecrets(publish.body)
    expect(publishApp.publishCalls).toEqual([
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
    expect(publishApp.adminCalls).toBe(1)
    expect(publishApp.readCalls).toBe(0)

    const learnerApp = makeApp({ env: FLAG_EXAM_ON })
    const learner = await serve(learnerApp.app)
      .get(
        `/api/elearning/me/courses?orgId=evil-org&userId=evil-user&actorId=evil-actor`,
      )
      .set('x-user-id', 'header-user')
      .set('x-tenant-id', 'header-org')
    expect(learner.status).toBe(200)
    assertLearnerEnvelope(learner.body)
    expect(learnerApp.learnerCalls).toEqual([{ orgId: ORG, userId: ACTOR }])
    expect(learnerApp.readCalls).toBe(1)
    expect(learnerApp.adminCalls).toBe(0)
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

    const extraTicket = makeApp()
    for (const body of [
      { userId: 'evil-user' },
      { orgId: 'evil-org' },
      { itemId: ITEM },
      { token: 'x' },
      { extra: true },
    ]) {
      extraTicket.ticketCalls.length = 0
      const res = await serve(extraTicket.app)
        .post(`/api/elearning/watch/items/${ITEM}/playback-ticket`)
        .send(body)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_input' })
      assertValuesFree(res.body)
      expect(extraTicket.ticketCalls).toHaveLength(0)
    }

    const extraExam = makeApp({ env: FLAG_EXAM_ON })
    for (const body of [
      { userId: 'evil-user' },
      { orgId: 'evil-org' },
      { itemId: ITEM },
      { extra: true },
    ]) {
      extraExam.examStartCalls.length = 0
      const res = await serve(extraExam.app).post(`/api/elearning/exams/items/${ITEM}/start`).send(body)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_input' })
      assertValuesFree(res.body)
      expect(extraExam.examStartCalls).toHaveLength(0)
    }

    for (const body of [
      { answers: ANSWERS, orgId: 'evil-org' },
      { answers: ANSWERS, userId: 'evil-user' },
      { answers: ANSWERS, attemptId: ATTEMPT },
      { answers: ANSWERS, extra: 1 },
      { selected: ANSWERS },
      {},
    ]) {
      extraExam.examSaveCalls.length = 0
      extraExam.examSubmitCalls.length = 0
      const saveRes = await serve(extraExam.app)
        .put(`/api/elearning/exams/attempts/${ATTEMPT}/answers`)
        .send(body)
      expect(saveRes.status).toBe(400)
      expect(saveRes.body).toEqual({ error: 'invalid_input' })
      assertValuesFree(saveRes.body)
      expect(extraExam.examSaveCalls).toHaveLength(0)
      const res = await serve(extraExam.app)
        .post(`/api/elearning/exams/attempts/${ATTEMPT}/submit`)
        .send(body)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_input' })
      assertValuesFree(res.body)
      expect(extraExam.examSubmitCalls).toHaveLength(0)
    }
    const badAttempt = await serve(extraExam.app)
      .put('/api/elearning/exams/attempts/not-a-uuid/answers')
      .send(SUBMIT_BODY)
    expect(badAttempt.status).toBe(400)
    expect(badAttempt.body).toEqual({ error: 'invalid_input' })
    expect(extraExam.examSaveCalls).toHaveLength(0)

    const extraPublish = makeApp({ env: FLAG_EXAM_ON })
    for (const body of [
      { ...PUBLISH_BODY, orgId: 'evil-org' },
      { ...PUBLISH_BODY, actorId: 'evil-actor' },
      { ...PUBLISH_BODY, userId: 'evil-user' },
      { ...PUBLISH_BODY, extra: 1 },
      { ...PUBLISH_BODY, courseId: REQUEST_ID },
      [PUBLISH_BODY],
    ]) {
      extraPublish.publishCalls.length = 0
      const res = await serve(extraPublish.app).post('/api/elearning/courses/publish').send(body)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_input' })
      assertValuesFree(res.body)
      expect(extraPublish.publishCalls).toHaveLength(0)
    }
  })

  test('service-domain errors map to stable values-free status/body pairs', async () => {
    for (const [code, status] of ASSIGNMENT_ERRORS) {
      const app = makeApp({
        assignError: new ElearningDirectAssignmentError(code),
      })
      const res = await serve(app.app)
        .post('/api/elearning/assignments/direct')
        .send(ASSIGN_BODY)
      expect(res.status).toBe(status)
      expect(res.body).toEqual({ error: code })
      assertValuesFree(res.body)
      expect(app.assignCalls).toHaveLength(1)
    }
    const boom = makeApp({
      assignError: new Error('db host secret at /var/app'),
    })
    const boomRes = await serve(boom.app)
      .post('/api/elearning/assignments/direct')
      .send(ASSIGN_BODY)
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

      const beatApp = makeApp({
        heartbeatError: new ElearningWatchError(code),
      })
      const beatRes = await serve(beatApp.app)
        .post(`/api/elearning/watch/sessions/${SESSION}/heartbeat`)
        .send(HEARTBEAT_BODY)
      expect(beatRes.status).toBe(status)
      expect(beatRes.body).toEqual({ error: code })
      assertValuesFree(beatRes.body)
      expect(beatApp.heartbeatCalls).toHaveLength(1)
    }

    for (const [code, status] of PLAYBACK_ERRORS) {
      const ticketApp = makeApp({
        ticketError: new ElearningPlaybackError(code),
      })
      const ticketRes = await serve(ticketApp.app)
        .post(`/api/elearning/watch/items/${ITEM}/playback-ticket`)
        .send({})
      expect(ticketRes.status).toBe(status)
      expect(ticketRes.body).toEqual({ error: code })
      assertValuesFree(ticketRes.body)
      expect(ticketApp.ticketCalls).toHaveLength(1)
    }
    const ticketBoom = makeApp({
      ticketError: new Error('storage_key secret at /var/app'),
    })
    const ticketBoomRes = await serve(ticketBoom.app)
      .post(`/api/elearning/watch/items/${ITEM}/playback-ticket`)
      .send({})
    expect(ticketBoomRes.status).toBe(500)
    expect(ticketBoomRes.body).toEqual({ error: 'internal_error' })
    assertValuesFree(ticketBoomRes.body)

    for (const [code, status] of EXAM_ERRORS) {
      const startApp = makeApp({
        env: FLAG_EXAM_ON,
        examStartError: new ElearningExamError(code),
      })
      const startRes = await serve(startApp.app)
        .post(`/api/elearning/exams/items/${ITEM}/start`)
        .send({})
      expect(startRes.status).toBe(status)
      expect(startRes.body).toEqual({ error: code })
      assertValuesFree(startRes.body)
      expect(startApp.examStartCalls).toHaveLength(1)

      const saveApp = makeApp({
        env: FLAG_EXAM_ON,
        examSaveError: new ElearningExamError(code),
      })
      const saveRes = await serve(saveApp.app)
        .put(`/api/elearning/exams/attempts/${ATTEMPT}/answers`)
        .send(SUBMIT_BODY)
      expect(saveRes.status).toBe(status)
      expect(saveRes.body).toEqual({ error: code })
      assertValuesFree(saveRes.body)
      expect(saveApp.examSaveCalls).toHaveLength(1)

      const submitApp = makeApp({
        env: FLAG_EXAM_ON,
        examSubmitError: new ElearningExamError(code),
      })
      const submitRes = await serve(submitApp.app)
        .post(`/api/elearning/exams/attempts/${ATTEMPT}/submit`)
        .send(SUBMIT_BODY)
      expect(submitRes.status).toBe(status)
      expect(submitRes.body).toEqual({ error: code })
      assertValuesFree(submitRes.body)
      expect(submitApp.examSubmitCalls).toHaveLength(1)
    }

    for (const [code, status] of PUBLISH_ERRORS) {
      const app = makeApp({
        env: FLAG_EXAM_ON,
        publishError: new ElearningCoursePublishError(code),
      })
      const res = await serve(app.app)
        .post('/api/elearning/courses/publish')
        .send(PUBLISH_BODY)
      expect(res.status).toBe(status)
      expect(res.body).toEqual({ error: code })
      assertValuesFree(res.body)
      expect(app.publishCalls).toHaveLength(1)
    }
    const publishBoom = makeApp({
      env: FLAG_EXAM_ON,
      publishError: new Error('db host secret at /var/app'),
    })
    const publishBoomRes = await serve(publishBoom.app)
      .post('/api/elearning/courses/publish')
      .send(PUBLISH_BODY)
    expect(publishBoomRes.status).toBe(500)
    expect(publishBoomRes.body).toEqual({ error: 'internal_error' })
    assertValuesFree(publishBoomRes.body)
    expect(JSON.stringify(publishBoomRes.body)).not.toContain('db host secret')

    for (const [code, status] of LEARNER_ERRORS) {
      const app = makeApp({
        env: FLAG_EXAM_ON,
        learnerError: new ElearningLearnerCoursesError(code),
      })
      const res = await serve(app.app).get('/api/elearning/me/courses')
      expect(res.status).toBe(status)
      expect(res.body).toEqual({ error: code })
      assertValuesFree(res.body)
      expect(app.learnerCalls).toHaveLength(1)
    }
    const learnerBoom = makeApp({
      env: FLAG_EXAM_ON,
      learnerError: new Error('db host secret at /var/app'),
    })
    const learnerBoomRes = await serve(learnerBoom.app).get(
      '/api/elearning/me/courses',
    )
    expect(learnerBoomRes.status).toBe(500)
    expect(learnerBoomRes.body).toEqual({ error: 'internal_error' })
    assertValuesFree(learnerBoomRes.body)
    expect(JSON.stringify(learnerBoomRes.body)).not.toContain('db host secret')
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
    expect(
      denied.order.filter(
        (step) => step === 'identity' || step === 'org' || step === 'rbac',
      ),
    ).toEqual(['identity', 'org', 'rbac'])

    const hugeTicket = `{${' '.repeat(20 * 1024)}}`
    const deniedTicket = makeApp({ hasRead: false })
    const rbacTicket = await serve(deniedTicket.app)
      .post(`/api/elearning/watch/items/${ITEM}/playback-ticket`)
      .set('content-type', 'application/json')
      .send(hugeTicket)
    expect(rbacTicket.status).toBe(403)
    expect(deniedTicket.readCalls).toBe(1)
    expect(deniedTicket.ticketCalls).toHaveLength(0)
    expect(deniedTicket.order.includes('service')).toBe(false)

    const deniedExam = makeApp({ hasRead: false, env: FLAG_EXAM_ON })
    const rbacExam = await serve(deniedExam.app)
      .post(`/api/elearning/exams/items/${ITEM}/start`)
      .set('content-type', 'application/json')
      .send(hugeTicket)
    expect(rbacExam.status).toBe(403)
    expect(deniedExam.readCalls).toBe(1)
    expect(deniedExam.examStartCalls).toHaveLength(0)
    const rbacExamSave = await serve(deniedExam.app)
      .put(`/api/elearning/exams/attempts/${ATTEMPT}/answers`)
      .set('content-type', 'application/json')
      .send(hugeTicket)
    expect(rbacExamSave.status).toBe(403)
    expect(deniedExam.examSaveCalls).toHaveLength(0)

    const hugePublish = { ...PUBLISH_BODY, title: 'x'.repeat(20 * 1024) }
    const anonPublish = makeApp({
      viewer: null,
      org: null,
      hasAdmin: false,
      env: FLAG_EXAM_ON,
    })
    const anonPublishRes = await serve(anonPublish.app)
      .post('/api/elearning/courses/publish')
      .send(hugePublish)
    expect(anonPublishRes.status).toBe(401)
    expect(anonPublishRes.body).toEqual({ error: 'unauthenticated' })
    expect(anonPublish.adminCalls).toBe(0)
    expect(anonPublish.publishCalls).toHaveLength(0)
    expect(anonPublish.order.includes('org')).toBe(false)
    expect(anonPublish.order.includes('rbac')).toBe(false)
    expect(anonPublish.order.includes('service')).toBe(false)

    const noOrgPublish = makeApp({
      org: null,
      hasAdmin: false,
      env: FLAG_EXAM_ON,
    })
    const orgPublish = await serve(noOrgPublish.app)
      .post('/api/elearning/courses/publish')
      .send(hugePublish)
    expect(orgPublish.status).toBe(403)
    expect(orgPublish.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrgPublish.adminCalls).toBe(0)
    expect(noOrgPublish.publishCalls).toHaveLength(0)
    expect(noOrgPublish.order.includes('identity')).toBe(true)
    expect(noOrgPublish.order.includes('rbac')).toBe(false)

    const deniedPublish = makeApp({ hasAdmin: false, env: FLAG_EXAM_ON })
    const rbacPublish = await serve(deniedPublish.app)
      .post('/api/elearning/courses/publish')
      .send(hugePublish)
    expect(rbacPublish.status).toBe(403)
    expect(deniedPublish.adminCalls).toBe(1)
    expect(deniedPublish.readCalls).toBe(0)
    expect(deniedPublish.publishCalls).toHaveLength(0)
    expect(
      deniedPublish.order.filter(
        (step) => step === 'identity' || step === 'org' || step === 'rbac',
      ),
    ).toEqual(['identity', 'org', 'rbac'])
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
    expect(
      app.order.filter(
        (step) =>
          step === 'identity' ||
          step === 'org' ||
          step === 'rbac' ||
          step === 'service',
      ),
    ).toEqual(['identity', 'org', 'rbac'])

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

    const ticketApp = makeApp()
    ticketApp.app.use(express.json({ limit: '10mb' }))
    const ticket = await serve(ticketApp.app)
      .post(`/api/elearning/watch/items/${ITEM}/playback-ticket`)
      .set('content-type', 'application/json')
      .send(`{${' '.repeat(20 * 1024)}}`)
    expect(ticket.status).toBe(400)
    expect(ticket.body).toEqual({ error: 'invalid_input' })
    expect(ticketApp.ticketCalls).toHaveLength(0)
    expect(
      ticketApp.order.filter(
        (step) =>
          step === 'identity' ||
          step === 'org' ||
          step === 'rbac' ||
          step === 'service',
      ),
    ).toEqual(['identity', 'org', 'rbac'])

    const examApp = makeApp({ env: FLAG_EXAM_ON })
    examApp.app.use(express.json({ limit: '10mb' }))
    const examStart = await serve(examApp.app)
      .post(`/api/elearning/exams/items/${ITEM}/start`)
      .set('content-type', 'application/json')
      .send(`{${' '.repeat(20 * 1024)}}`)
    expect(examStart.status).toBe(400)
    expect(examStart.body).toEqual({ error: 'invalid_input' })
    expect(examApp.examStartCalls).toHaveLength(0)

    const hugeAnswers = { answers: { [Q1]: ['x'.repeat(20 * 1024)] } }
    const examSave = await serve(examApp.app)
      .put(`/api/elearning/exams/attempts/${ATTEMPT}/answers`)
      .send(hugeAnswers)
    expect(examSave.status).toBe(400)
    expect(examSave.body).toEqual({ error: 'invalid_input' })
    expect(examApp.examSaveCalls).toHaveLength(0)
    const examSubmit = await serve(examApp.app)
      .post(`/api/elearning/exams/attempts/${ATTEMPT}/submit`)
      .send(hugeAnswers)
    expect(examSubmit.status).toBe(400)
    expect(examSubmit.body).toEqual({ error: 'invalid_input' })
    expect(examApp.examSubmitCalls).toHaveLength(0)
  })

  test('assessment OFF 404s exam routes before identity/RBAC/service while watch ticket still works', async () => {
    const app = makeApp({ env: FLAG_ON, hasRead: false, viewer: null })
    const start = await serve(app.app).post(`/api/elearning/exams/items/${ITEM}/start`).send({})
    expect(start.status).toBe(404)
    expect(start.body).toEqual({ error: 'not_found' })
    expect(app.readCalls).toBe(0)
    expect(app.examStartCalls).toHaveLength(0)
    expect(app.order.includes('identity')).toBe(false)

    const ready = makeApp({ env: FLAG_ON })
    const ticket = await serve(ready.app).post(`/api/elearning/watch/items/${ITEM}/playback-ticket`).send({})
    expect(ticket.status).toBe(200)
    expect(ready.ticketCalls).toHaveLength(1)
    const exam = await serve(ready.app).post(`/api/elearning/exams/items/${ITEM}/start`).send({})
    expect(exam.status).toBe(404)
    expect(ready.examStartCalls).toHaveLength(0)
    const examSaveOff = await serve(ready.app)
      .put(`/api/elearning/exams/attempts/${ATTEMPT}/answers`)
      .send(SUBMIT_BODY)
    expect(examSaveOff.status).toBe(404)
    expect(ready.examSaveCalls).toHaveLength(0)
    const publish = await serve(ready.app).post('/api/elearning/courses/publish').send(PUBLISH_BODY)
    expect(publish.status).toBe(404)
    expect(ready.publishCalls).toHaveLength(0)
    const learner = await serve(ready.app).get('/api/elearning/me/courses')
    expect(learner.status).toBe(404)
    expect(ready.learnerCalls).toHaveLength(0)
  })

  test('publish 1 MiB parser reaches service under the cap; oversized/unknown do not; GET has no parser', async () => {
    const under = makeApp({ env: FLAG_EXAM_ON })
    under.app.use(express.json({ limit: '10mb' }))
    const underBody = { ...PUBLISH_BODY, title: 'x'.repeat(20 * 1024) }
    const underRes = await serve(under.app).post('/api/elearning/courses/publish').send(underBody)
    expect(underRes.status).toBe(201)
    expect(underRes.body).toEqual(PUBLISH_RESULT)
    expect(under.publishCalls).toEqual([
      {
        orgId: ORG,
        actorId: ACTOR,
        requestId: REQUEST_ID,
        title: underBody.title,
        mediaId: MEDIA,
        passScore: 10,
        maxAttempts: 3,
        questions: PUBLISH_BODY.questions,
      },
    ])
    expect(
      under.order.filter(
        (step) =>
          step === 'identity' ||
          step === 'org' ||
          step === 'rbac' ||
          step === 'service',
      ),
    ).toEqual(['identity', 'org', 'rbac', 'identity', 'org', 'service'])
    expect(under.adminCalls).toBe(1)
    expect(under.readCalls).toBe(0)

    const nearCap = makeApp({ env: FLAG_EXAM_ON })
    nearCap.app.use(express.json({ limit: '10mb' }))
    const nearJson = `{${' '.repeat(64 * 1024)}"requestId":"${REQUEST_ID}","title":"Pilot course","mediaId":"${MEDIA}","passScore":10,"maxAttempts":3,"questions":${JSON.stringify(PUBLISH_BODY.questions)}}`
    expect(Buffer.byteLength(nearJson)).toBeLessThan(1024 * 1024)
    expect(Buffer.byteLength(nearJson)).toBeGreaterThan(16 * 1024)
    const nearRes = await serve(nearCap.app)
      .post('/api/elearning/courses/publish')
      .set('content-type', 'application/json')
      .send(nearJson)
    expect(nearRes.status).toBe(201)
    expect(nearCap.publishCalls).toHaveLength(1)
    expect(nearCap.publishCalls[0]?.orgId).toBe(ORG)
    expect(nearCap.publishCalls[0]?.actorId).toBe(ACTOR)
    expect(nearCap.publishCalls[0]?.title).toBe('Pilot course')

    const over = makeApp({ env: FLAG_EXAM_ON })
    over.app.use(express.json({ limit: '10mb' }))
    const publishLimit = 1024 * 1024
    const overJson = `{${' '.repeat(publishLimit - 1)}}`
    expect(Buffer.byteLength(overJson)).toBe(publishLimit + 1)
    const overRes = await serve(over.app)
      .post('/api/elearning/courses/publish')
      .set('content-type', 'application/json')
      .send(overJson)
    expect(overRes.status).toBe(413)
    expect(overRes.body).toEqual({ error: 'payload_too_large' })
    assertValuesFree(overRes.body)
    expect(JSON.stringify(overRes.body)).not.toMatch(
      /too large|entity|limit|bytes/i,
    )
    expect(over.publishCalls).toHaveLength(0)
    expect(
      over.order.filter(
        (step) =>
          step === 'identity' ||
          step === 'org' ||
          step === 'rbac' ||
          step === 'service',
      ),
    ).toEqual(['identity', 'org', 'rbac'])

    const unknown = makeApp({ env: FLAG_EXAM_ON })
    const unknownRes = await serve(unknown.app)
      .post('/api/elearning/courses/publish')
      .send({ ...PUBLISH_BODY, orgId: 'evil-org', userId: 'evil-user' })
    expect(unknownRes.status).toBe(400)
    expect(unknownRes.body).toEqual({ error: 'invalid_input' })
    assertValuesFree(unknownRes.body)
    expect(unknown.publishCalls).toHaveLength(0)

    const learner = makeApp({ env: FLAG_EXAM_ON })
    learner.app.use(express.json({ limit: '10mb' }))
    const malformed = await serve(learner.app)
      .get('/api/elearning/me/courses?orgId=evil-org&userId=evil-user')
      .set('content-type', 'application/json')
      .send('{')
    expect(malformed.status).toBe(200)
    assertLearnerEnvelope(malformed.body)
    expect(learner.learnerCalls).toEqual([{ orgId: ORG, userId: ACTOR }])

    learner.learnerCalls.length = 0
    const ordinary = await serve(learner.app)
      .get('/api/elearning/me/courses')
      .set('content-type', 'application/json')
      .send('{"orgId":"evil-org","userId":"evil-user"}')
    expect(ordinary.status).toBe(200)
    assertLearnerEnvelope(ordinary.body)
    expect(learner.learnerCalls).toEqual([{ orgId: ORG, userId: ACTOR }])
    expect(learner.readCalls).toBe(2)
    expect(learner.adminCalls).toBe(0)
    expect(learner.order.includes('service')).toBe(true)

    const existing = makeApp({ env: FLAG_EXAM_ON })
    existing.app.use(express.json({ limit: '10mb' }))
    const assign = await serve(existing.app)
      .post('/api/elearning/assignments/direct')
      .send({ ...ASSIGN_BODY, sourceKey: 'x'.repeat(20 * 1024) })
    expect(assign.status).toBe(400)
    expect(existing.assignCalls).toHaveLength(0)
  })
})
