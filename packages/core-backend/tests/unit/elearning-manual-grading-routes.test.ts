import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import {
  createElearningManualGradingRouter,
} from '../../src/routes/elearning-manual-grading'
import {
  ElearningManualGradingError,
  type ElearningManualGradeInput,
  type ElearningManualGradingDb,
} from '../../src/services/elearning-manual-grading'
import { ElearningAdminAccessError } from '../../src/services/elearning-admin-access'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-manual-route-1'
const ACTOR = 'actor-manual-route-1'
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111'
const QUESTION_REVISION_ID = '22222222-2222-4222-8222-222222222222'
const REQUEST_ID = '33333333-3333-4333-8333-333333333333'

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSESSMENT_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv

const BODY = {
  requestId: REQUEST_ID,
  questionRevisionId: QUESTION_REVISION_ID,
  score: 3,
  comment: 'Good explanation',
}

const RESULT = {
  attemptId: ATTEMPT_ID,
  questionRevisionId: QUESTION_REVISION_ID,
  score: 3,
  maxScore: 4,
  status: 'awaiting_manual' as const,
  gradedQuestions: 1,
  manualQuestions: 2,
  autoScore: 5,
  manualScore: 3,
  totalScore: 15,
  passed: null,
  duplicate: false,
}

const pinned = usePinnedServer()
function serve(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

function dummyDb(): ElearningManualGradingDb {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (handler) => handler({
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
  const calls: ElearningManualGradeInput[] = []
  let guardCalls = 0
  const router = createElearningManualGradingRouter({
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
    submitElearningManualGrade: async (_db, input) => {
      calls.push(input)
      if (over.error) throw over.error
      return {
        ...RESULT,
        comment: 'Good explanation',
        orgId: ORG,
      }
    },
  })
  const app = express()
  if (router) app.use(router)
  return {
    app,
    calls,
    get guardCalls() {
      return guardCalls
    },
  }
}

describe('e-learning manual-grading route', () => {
  test('flag OFF and runtime recheck return 404 before grade permission or service', async () => {
    const off = makeApp({
      env: {
        ...FLAG_ON,
        ELEARNING_ASSESSMENT_ENABLED: 'TRUE',
      } as unknown as NodeJS.ProcessEnv,
    })
    const offResponse = await serve(off.app)
      .post(`/api/elearning/assessment/attempts/${ATTEMPT_ID}/manual-grades`)
      .send(BODY)
    expect(offResponse.status).toBe(404)
    expect(offResponse.body).toEqual({})
    expect(off.guardCalls).toBe(0)
    expect(off.calls).toEqual([])

    const env = { ...FLAG_ON } as unknown as NodeJS.ProcessEnv
    const changed = makeApp({ env })
    env.ELEARNING_ASSESSMENT_ENABLED = 'false'
    const changedResponse = await serve(changed.app)
      .post(`/api/elearning/assessment/attempts/${ATTEMPT_ID}/manual-grades`)
      .send(BODY)
    expect(changedResponse.status).toBe(404)
    expect(changedResponse.body).toEqual({ error: 'not_found' })
    expect(changed.guardCalls).toBe(0)
    expect(changed.calls).toEqual([])
  })

  test('requires identity, authoritative org, and elearning grade permission in order', async () => {
    const anonymous = makeApp({ viewer: null })
    expect((await serve(anonymous.app)
      .post(`/api/elearning/assessment/attempts/${ATTEMPT_ID}/manual-grades`)
      .send(BODY)).status).toBe(401)
    expect(anonymous.guardCalls).toBe(0)

    const noOrg = makeApp({ org: null })
    const noOrgResponse = await serve(noOrg.app)
      .post(`/api/elearning/assessment/attempts/${ATTEMPT_ID}/manual-grades`)
      .send(BODY)
    expect(noOrgResponse.status).toBe(403)
    expect(noOrgResponse.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrg.guardCalls).toBe(0)

    const denied = makeApp({ hasGrade: false })
    const deniedResponse = await serve(denied.app)
      .post(`/api/elearning/assessment/attempts/${ATTEMPT_ID}/manual-grades`)
      .send(BODY)
    expect(deniedResponse.status).toBe(403)
    expect(denied.calls).toEqual([])
  })

  test('passes only the exact command and exposes a fixed values-free response', async () => {
    const mounted = makeApp({ globalAdmin: false })
    const response = await serve(mounted.app)
      .post(`/api/elearning/assessment/attempts/${ATTEMPT_ID}/manual-grades`)
      .send(BODY)
    expect(response.status).toBe(200)
    expect(response.body).toEqual(RESULT)
    expect(Object.keys(response.body)).toEqual(Object.keys(RESULT))
    expect(JSON.stringify(response.body)).not.toContain('Good explanation')
    expect(mounted.calls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      attemptId: ATTEMPT_ID,
      questionRevisionId: QUESTION_REVISION_ID,
      requestId: REQUEST_ID,
      score: 3,
      comment: 'Good explanation',
    }])
  })

  test('rejects malformed ids, unknown keys, missing/null-shape drift, and oversized JSON', async () => {
    const mounted = makeApp()
    const invalidBodies = [
      { ...BODY, extra: true },
      { ...BODY, requestId: 'bad' },
      { ...BODY, questionRevisionId: 'bad' },
      { ...BODY, score: Number.NaN },
      { ...BODY, score: 1.5 },
      { ...BODY, score: -1 },
      { ...BODY, comment: undefined },
      { ...BODY, comment: 'x'.repeat(4_001) },
      { ...BODY, comment: `${'x'.repeat(4_000)} ` },
    ]
    for (const body of invalidBodies) {
      const response = await serve(mounted.app)
        .post(`/api/elearning/assessment/attempts/${ATTEMPT_ID}/manual-grades`)
        .send(body)
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_input' })
    }
    const badPath = await serve(mounted.app)
      .post('/api/elearning/assessment/attempts/not-a-uuid/manual-grades')
      .send(BODY)
    expect(badPath.status).toBe(400)

    const large = await serve(mounted.app)
      .post(`/api/elearning/assessment/attempts/${ATTEMPT_ID}/manual-grades`)
      .send({ ...BODY, comment: 'x'.repeat(20_000) })
    expect(large.status).toBe(413)
    expect(large.body).toEqual({ error: 'payload_too_large' })
    expect(mounted.calls).toEqual([])
  })

  test.each([
    [new ElearningManualGradingError('invalid_input'), 400, 'invalid_input'],
    [new ElearningManualGradingError('not_found'), 404, 'not_found'],
    [new ElearningManualGradingError('conflict'), 409, 'conflict'],
    [new ElearningManualGradingError('unavailable'), 503, 'unavailable'],
    [new ElearningAdminAccessError('scope_required'), 403, 'scope_required'],
    [new ElearningAdminAccessError('target_out_of_scope'), 403, 'target_out_of_scope'],
  ] as const)('maps domain and management-scope errors without values', async (error, status, code) => {
    const mounted = makeApp({ error })
    const response = await serve(mounted.app)
      .post(`/api/elearning/assessment/attempts/${ATTEMPT_ID}/manual-grades`)
      .send(BODY)
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ error: code })
    expect(JSON.stringify(response.body)).not.toContain(ORG)
    expect(JSON.stringify(response.body)).not.toContain(ACTOR)
  })
})
