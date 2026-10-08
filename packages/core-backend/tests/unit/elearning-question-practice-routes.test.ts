import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningQuestionPracticeRouter } from '../../src/routes/elearning-question-practice'
import { ElearningPracticeError } from '../../src/services/elearning-question-practice'
import type {
  CreateElearningPracticeSetInput,
  StartElearningPracticeSessionInput,
  SubmitElearningPracticeAnswerInput,
} from '../../src/services/elearning-question-practice-postgres'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'practice-org'
const ACTOR = 'practice-user'
const REQUEST = '11111111-1111-4111-8111-111111111111'
const PAPER = '22222222-2222-4222-8222-222222222222'
const SET = '33333333-3333-4333-8333-333333333333'
const SESSION = '44444444-4444-4444-8444-444444444444'
const REVISION = '55555555-5555-4555-8555-555555555555'
const QUESTION = '66666666-6666-4666-8666-666666666666'
const ENABLED = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_ASSESSMENT_ENABLED: 'true',
} as NodeJS.ProcessEnv
const pinned = usePinnedServer()

function makeApp(over: {
  env?: NodeJS.ProcessEnv
  viewer?: string | null
  org?: string | null
  adminAllowed?: boolean
  readAllowed?: boolean
  error?: ElearningPracticeError
} = {}) {
  const creates: CreateElearningPracticeSetInput[] = []
  const starts: StartElearningPracticeSessionInput[] = []
  const answers: SubmitElearningPracticeAnswerInput[] = []
  const calls: string[] = []
  const router = createElearningQuestionPracticeRouter({
    db: {
      query: async () => ({ rows: [], rowCount: 0 }),
      transaction: async (handler) => handler({
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
    },
    env: over.env ?? ENABLED,
    viewerId: () => over.viewer === undefined ? ACTOR : over.viewer,
    orgId: () => over.org === undefined ? ORG : over.org,
    adminGuard: (_req, res, next) => {
      calls.push('admin')
      if (over.adminAllowed === false) return void res.status(403).json({ error: 'denied' })
      next()
    },
    readGuard: (_req, res, next) => {
      calls.push('read')
      if (over.readAllowed === false) return void res.status(403).json({ error: 'denied' })
      next()
    },
    createElearningPracticeSet: async (_db, input) => {
      calls.push('create')
      creates.push(input)
      if (over.error) throw over.error
      return {
        practiceSetId: SET,
        paperId: PAPER,
        title: 'Daily practice',
        status: 'active',
        createdAt: '2026-08-30T01:02:03.456Z',
        duplicate: false,
      }
    },
    listElearningPracticeSets: async () => {
      calls.push('list')
      if (over.error) throw over.error
      return []
    },
    startElearningPracticeSession: async (_db, input) => {
      calls.push('start')
      starts.push(input)
      if (over.error) throw over.error
      return {
        sessionId: SESSION,
        practiceSetId: SET,
        mode: 'sequential',
        questions: [{
          questionId: QUESTION,
          questionRevisionId: REVISION,
          questionType: 'single_choice',
          prompt: 'Question',
          options: [{ id: 'a', text: 'A' }],
          points: 1,
          position: 1,
        }],
        createdAt: '2026-08-30T01:02:03.456Z',
        duplicate: false,
      }
    },
    submitElearningPracticeAnswer: async (_db, input) => {
      calls.push('answer')
      answers.push(input)
      if (over.error) throw over.error
      return {
        answerId: REQUEST,
        sessionId: SESSION,
        questionRevisionId: REVISION,
        correct: false,
        wrongState: 'wrong',
        createdAt: '2026-08-30T01:03:03.456Z',
        duplicate: false,
      }
    },
    listElearningWrongQuestions: async () => {
      calls.push('wrong')
      if (over.error) throw over.error
      return { practiceSetId: SET, questions: [] }
    },
  })
  const app = express()
  if (router) app.use(router)
  pinned.setApp(app)
  return { api: request(pinned.url()), calls, creates, starts, answers, mounted: router !== null }
}

describe('e-learning question practice routes', () => {
  it.each([
    {},
    { ELEARNING_ENABLED: 'true' },
    { ELEARNING_ASSESSMENT_ENABLED: 'true' },
    { ELEARNING_ENABLED: 'true', ELEARNING_ASSESSMENT_ENABLED: 'TRUE' },
  ])('does not mount unless master and assessment are exact true %#', (env) => {
    expect(makeApp({ env: env as NodeJS.ProcessEnv }).mounted).toBe(false)
  })

  it('derives actor and organization server-side and returns closed shapes', async () => {
    const state = makeApp()
    const created = await state.api.post('/api/elearning/admin/practice-sets?orgId=evil').send({
      requestId: REQUEST,
      paperId: PAPER,
      title: 'Daily practice',
    })
    const started = await state.api.post('/api/elearning/me/practice-sessions').send({
      requestId: REQUEST,
      practiceSetId: SET,
      mode: 'sequential',
    })
    const answered = await state.api
      .post(`/api/elearning/me/practice-sessions/${SESSION}/answers`)
      .send({ requestId: REQUEST, questionRevisionId: REVISION, selectedOptionIds: ['b'] })

    expect(created.status).toBe(201)
    expect(started.status).toBe(201)
    expect(answered.status).toBe(200)
    expect(state.creates).toEqual([{ orgId: ORG, actorId: ACTOR, requestId: REQUEST,
      paperId: PAPER, title: 'Daily practice' }])
    expect(state.starts).toEqual([{ orgId: ORG, userId: ACTOR, requestId: REQUEST,
      practiceSetId: SET, mode: 'sequential' }])
    expect(state.answers).toEqual([{ orgId: ORG, userId: ACTOR, requestId: REQUEST,
      sessionId: SESSION, questionRevisionId: REVISION, selectedOptionIds: ['b'] }])
    expect(JSON.stringify(started.body)).not.toMatch(/answerKey|answer_key|explanation/)
  })

  it('requires identity, authoritative org, and the correct RBAC guard in order', async () => {
    const anonymous = makeApp({ viewer: null })
    expect((await anonymous.api.get('/api/elearning/me/practice-sets')).status).toBe(401)
    expect(anonymous.calls).toEqual([])
    const noOrg = makeApp({ org: null })
    expect((await noOrg.api.get('/api/elearning/me/practice-sets')).body)
      .toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    const denied = makeApp({ readAllowed: false })
    expect((await denied.api.get('/api/elearning/me/practice-sets')).status).toBe(403)
    expect(denied.calls).toEqual(['read'])
  })

  it('rejects malformed and extra command fields before service execution', async () => {
    const state = makeApp()
    const malformed = await state.api
      .post('/api/elearning/me/practice-sessions')
      .set('content-type', 'application/json')
      .send('{')
    const extra = await state.api.post('/api/elearning/me/practice-sessions').send({
      requestId: REQUEST,
      practiceSetId: SET,
      mode: 'sequential',
      orgId: 'evil',
    })
    expect(malformed.status).toBe(400)
    expect(extra.status).toBe(400)
    expect(state.starts).toEqual([])
  })

  it('rechecks flags on every request before guards or services', async () => {
    const env = { ...ENABLED }
    const state = makeApp({ env })
    env.ELEARNING_ASSESSMENT_ENABLED = 'false'
    const response = await state.api.get('/api/elearning/me/practice-sets')
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'not_found' })
    expect(state.calls).toEqual([])
  })

  it.each([
    ['disabled', 404],
    ['invalid_input', 400],
    ['not_found', 404],
    ['forbidden', 403],
    ['conflict', 409],
    ['unavailable', 503],
  ] as const)('maps values-free %s errors to %i', async (code, status) => {
    const state = makeApp({ error: new ElearningPracticeError(code) })
    const response = await state.api.get('/api/elearning/me/practice-sets')
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ error: code })
  })

  it('lists wrong questions only under the authenticated learner scope', async () => {
    const state = makeApp()
    const response = await state.api.get(
      `/api/elearning/me/practice-sets/${SET}/wrong-questions`,
    )
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ practiceSetId: SET, questions: [] })
    expect(state.calls).toEqual(['read', 'wrong'])
  })
})
