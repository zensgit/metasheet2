import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import { ElearningAdminAccessError } from '../../src/services/elearning-admin-access'
import {
  ElearningManualGradingReadError,
  type GetElearningManualGradingDetailInput,
  type ListElearningManualGradingQueueInput,
  type ElearningManualGradingReadDb,
} from '../../src/services/elearning-manual-grading-read'
import {
  createElearningManualGradingReadRouter,
} from '../../src/routes/elearning-manual-grading-read'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-manual-read-route-1'
const ACTOR = 'actor-manual-read-route-1'
const LEARNER = 'learner-manual-read-route-1'
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111'
const EXAM_ID = '22222222-2222-4222-8222-222222222222'
const COURSE_ID = '33333333-3333-4333-8333-333333333333'
const REVISION_ID = '44444444-4444-4444-8444-444444444444'

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSESSMENT_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv

const QUEUE_ITEM = {
  attemptId: ATTEMPT_ID,
  userId: LEARNER,
  examId: EXAM_ID,
  examTitle: 'Manual exam',
  courseId: COURSE_ID,
  courseTitle: 'Manual course v1',
  attemptNo: 1,
  submittedAt: '2026-08-27T01:00:00.000Z',
  autoScore: 5,
  manualScore: 0,
  paperMaxScore: 9,
  gradedQuestions: 0,
  manualQuestions: 1,
}

const DETAIL = {
  ...QUEUE_ITEM,
  status: 'awaiting_manual' as const,
  passScore: 6,
  questions: [{
    questionRevisionId: REVISION_ID,
    position: 2,
    prompt: 'Explain',
    points: 4,
    learnerAnswer: 'Learner answer',
    grade: null,
  }],
}

const pinned = usePinnedServer()
function serve(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

function dummyDb(): ElearningManualGradingReadDb {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (run) => run({
      query: async () => ({ rows: [], rowCount: 0 }),
    }),
  }
}

function makeApp(
  over: {
    env?: NodeJS.ProcessEnv
    viewer?: string | null
    org?: string | null
    hasGrade?: boolean
    globalAdmin?: boolean
    error?: Error
  } = {},
) {
  const listCalls: ListElearningManualGradingQueueInput[] = []
  const detailCalls: GetElearningManualGradingDetailInput[] = []
  let guardCalls = 0
  const router = createElearningManualGradingReadRouter({
    db: dummyDb(),
    env: over.env ?? FLAG_ON,
    viewerId: () => (over.viewer === undefined ? ACTOR : over.viewer),
    orgId: () => (over.org === undefined ? ORG : over.org),
    isGlobalAdmin: () => over.globalAdmin === true,
    gradeGuard: (_req, res, next) => {
      guardCalls += 1
      if (over.hasGrade === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    listElearningManualGradingQueue: async (_db, input) => {
      listCalls.push(input)
      if (over.error) throw over.error
      return {
        items: [{
          ...QUEUE_ITEM,
          paperSnapshot: { answerKey: { correct: ['secret'] } },
        }],
        page: input.page ?? 1,
        pageSize: input.pageSize ?? 20,
        hasMore: false,
      }
    },
    getElearningManualGradingDetail: async (_db, input) => {
      detailCalls.push(input)
      if (over.error) throw over.error
      return {
        ...DETAIL,
        answerKey: { correct: ['secret'] },
        requestId: '55555555-5555-4555-8555-555555555555',
      }
    },
  })
  const app = express()
  if (router) app.use(router)
  return {
    app,
    listCalls,
    detailCalls,
    get guardCalls() {
      return guardCalls
    },
  }
}

describe('e-learning manual-grading read routes', () => {
  test('flag OFF and runtime recheck return 404 before grade permission', async () => {
    const off = makeApp({
      env: {
        ...FLAG_ON,
        ELEARNING_ASSESSMENT_ENABLED: 'TRUE',
      } as unknown as NodeJS.ProcessEnv,
    })
    const offResponse = await serve(off.app)
      .get('/api/elearning/assessment/manual-grading/attempts')
    expect(offResponse.status).toBe(404)
    expect(off.guardCalls).toBe(0)

    const env = { ...FLAG_ON } as unknown as NodeJS.ProcessEnv
    const changed = makeApp({ env })
    env.ELEARNING_ASSESSMENT_ENABLED = 'false'
    const changedResponse = await serve(changed.app)
      .get('/api/elearning/assessment/manual-grading/attempts')
    expect(changedResponse.status).toBe(404)
    expect(changedResponse.body).toEqual({ error: 'not_found' })
    expect(changed.guardCalls).toBe(0)
  })

  test('requires identity, authoritative org, and grade permission in order', async () => {
    const anonymous = makeApp({ viewer: null })
    expect((await serve(anonymous.app)
      .get('/api/elearning/assessment/manual-grading/attempts')).status).toBe(401)
    expect(anonymous.guardCalls).toBe(0)

    const noOrg = makeApp({ org: null })
    const noOrgResponse = await serve(noOrg.app)
      .get('/api/elearning/assessment/manual-grading/attempts')
    expect(noOrgResponse.status).toBe(403)
    expect(noOrgResponse.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrg.guardCalls).toBe(0)

    const denied = makeApp({ hasGrade: false })
    const deniedResponse = await serve(denied.app)
      .get('/api/elearning/assessment/manual-grading/attempts')
    expect(deniedResponse.status).toBe(403)
    expect(denied.listCalls).toEqual([])
  })

  test('passes exact pagination and strips hidden queue fields', async () => {
    const mounted = makeApp({ globalAdmin: false })
    const response = await serve(mounted.app)
      .get('/api/elearning/assessment/manual-grading/attempts?page=2&pageSize=10')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      items: [QUEUE_ITEM],
      page: 2,
      pageSize: 10,
      hasMore: false,
    })
    expect(mounted.listCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      page: 2,
      pageSize: 10,
    }])
    expect(JSON.stringify(response.body)).not.toContain('answerKey')
    expect(JSON.stringify(response.body)).not.toContain('paperSnapshot')
  })

  test('returns a closed short-answer detail without service extras', async () => {
    const mounted = makeApp({ globalAdmin: true })
    const response = await serve(mounted.app)
      .get(`/api/elearning/assessment/manual-grading/attempts/${ATTEMPT_ID}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual(DETAIL)
    expect(mounted.detailCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      attemptId: ATTEMPT_ID,
    }])
    const serialized = JSON.stringify(response.body)
    expect(serialized).not.toContain('answerKey')
    expect(serialized).not.toContain('requestId')
  })

  test('rejects malformed and unknown pagination plus malformed attempt ids', async () => {
    const mounted = makeApp()
    for (const query of [
      '?page=0',
      '?page=1.5',
      '?page=10001',
      '?pageSize=0',
      '?pageSize=101',
      '?extra=1',
      '?page=1&page=2',
    ]) {
      const response = await serve(mounted.app)
        .get(`/api/elearning/assessment/manual-grading/attempts${query}`)
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_input' })
    }
    const badId = await serve(mounted.app)
      .get('/api/elearning/assessment/manual-grading/attempts/not-a-uuid')
    expect(badId.status).toBe(400)
    expect(mounted.listCalls).toEqual([])
    expect(mounted.detailCalls).toEqual([])
  })

  test.each([
    [new ElearningManualGradingReadError('invalid_input'), 400, 'invalid_input'],
    [new ElearningManualGradingReadError('not_found'), 404, 'not_found'],
    [new ElearningManualGradingReadError('unavailable'), 503, 'unavailable'],
    [new ElearningAdminAccessError('scope_required'), 403, 'scope_required'],
    [new ElearningAdminAccessError('target_out_of_scope'), 403, 'target_out_of_scope'],
  ] as const)('maps read and scope errors without values', async (error, status, code) => {
    const mounted = makeApp({ error })
    const listResponse = await serve(mounted.app)
      .get('/api/elearning/assessment/manual-grading/attempts')
    const detailResponse = await serve(mounted.app)
      .get(`/api/elearning/assessment/manual-grading/attempts/${ATTEMPT_ID}`)
    for (const response of [listResponse, detailResponse]) {
      expect(response.status).toBe(status)
      expect(response.body).toEqual({ error: code })
      expect(JSON.stringify(response.body)).not.toContain(ORG)
      expect(JSON.stringify(response.body)).not.toContain(ACTOR)
    }
  })
})
