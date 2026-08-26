import { randomUUID } from 'node:crypto'

import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import {
  ELEARNING_FIXED_PAPER_ITEM_MAX,
  ElearningAssessmentCatalogError,
  publishElearningFixedPaper,
  type AppendElearningQuestionRevisionInput,
  type CreateElearningBankQuestionInput,
  type CreateElearningQuestionBankInput,
  type ElearningAssessmentCatalogDb,
  type PublishElearningFixedPaperInput,
} from '../../src/services/elearning-assessment-catalog'
import type { ElearningPilotRouteDeps } from '../../src/routes/elearning-pilot'
import { createElearningPilotRouter } from '../../src/routes/elearning-pilot'
import {
  ElearningPaperExamError,
  type PublishElearningPaperExamInput,
} from '../../src/services/elearning-paper-exam'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-assessment-admin-1'
const ACTOR = 'actor-assessment-admin-1'
const BANK_ID = '11111111-1111-4111-8111-111111111111'
const QUESTION_ID = '22222222-2222-4222-8222-222222222222'
const REVISION_ID = '33333333-3333-4333-8333-333333333333'
const PAPER_ID = '44444444-4444-4444-8444-444444444444'
const EXAM_ID = '55555555-5555-4555-8555-555555555555'

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSESSMENT_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv

const QUESTION = {
  questionType: 'single_choice' as const,
  prompt: 'Choose one',
  options: [
    { id: 'a', text: 'Alpha' },
    { id: 'b', text: 'Beta' },
  ],
  correctOptionIds: ['a'],
  points: 5,
  explanation: 'Admin-only explanation',
}

const EXAM_BODY = {
  paperId: PAPER_ID,
  title: 'Final exam',
  passScore: 4,
  maxAttempts: 2,
  windowStartsAt: null,
  windowEndsAt: null,
  durationSeconds: 600,
  shuffleQuestions: true,
  shuffleOptions: false,
  disclosurePolicy: 'correctness_after_submit' as const,
}

const pinned = usePinnedServer()
function serve(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

function dummyDb(): ElearningPilotRouteDeps['db'] {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (handler) =>
      handler({ query: async () => ({ rows: [], rowCount: 0 }) }),
  }
}

function makeApp(
  over: {
    env?: NodeJS.ProcessEnv
    viewer?: string | null
    org?: string | null
    hasAdmin?: boolean
    catalogError?: ElearningAssessmentCatalogError
    examError?: ElearningPaperExamError
  } = {},
) {
  const bankCalls: CreateElearningQuestionBankInput[] = []
  const questionCalls: CreateElearningBankQuestionInput[] = []
  const revisionCalls: AppendElearningQuestionRevisionInput[] = []
  const paperCalls: PublishElearningFixedPaperInput[] = []
  const examCalls: PublishElearningPaperExamInput[] = []
  let adminCalls = 0

  const router = createElearningPilotRouter({
    db: dummyDb(),
    env: over.env ?? FLAG_ON,
    viewerId: () => (over.viewer === undefined ? ACTOR : over.viewer),
    orgId: () => (over.org === undefined ? ORG : over.org),
    adminGuard: (_req, res, next) => {
      adminCalls += 1
      if (over.hasAdmin === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    readGuard: (_req, _res, next) => next(),
    createElearningQuestionBank: async (_db, input) => {
      bankCalls.push(input)
      if (over.catalogError) throw over.catalogError
      return Object.assign({ bankId: BANK_ID }, { internalOwner: ACTOR })
    },
    createElearningBankQuestion: async (_db, input) => {
      questionCalls.push(input)
      if (over.catalogError) throw over.catalogError
      return Object.assign(
        { questionId: QUESTION_ID, questionRevisionId: REVISION_ID, revision: 1 },
        { correctOptionIds: ['a'] },
      )
    },
    appendElearningQuestionRevision: async (_db, input) => {
      revisionCalls.push(input)
      if (over.catalogError) throw over.catalogError
      return Object.assign(
        { questionId: QUESTION_ID, questionRevisionId: REVISION_ID, revision: 2 },
        { explanation: 'internal' },
      )
    },
    publishElearningFixedPaper: async (_db, input) => {
      paperCalls.push(input)
      if (over.catalogError) throw over.catalogError
      return Object.assign(
        { paperId: PAPER_ID, status: 'published' as const, itemCount: 1, totalPoints: 5 },
        { paperSnapshot: { answerKey: ['a'] } },
      )
    },
    publishElearningPaperExam: async (_db, input) => {
      examCalls.push(input)
      if (over.examError) throw over.examError
      return Object.assign(
        { examId: EXAM_ID, paperId: PAPER_ID, status: 'published' as const, totalPoints: 5 },
        { answerKey: ['a'] },
      )
    },
  })
  const app = express()
  if (router) app.use(router)
  return {
    app,
    bankCalls,
    questionCalls,
    revisionCalls,
    paperCalls,
    examCalls,
    get adminCalls() {
      return adminCalls
    },
  }
}

describe('e-learning assessment admin routes', () => {
  test('assessment flag OFF and runtime recheck return 404 before RBAC/service', async () => {
    const off = makeApp({
      env: {
        ...FLAG_ON,
        ELEARNING_ASSESSMENT_ENABLED: 'TRUE',
      } as unknown as NodeJS.ProcessEnv,
    })
    const offResponse = await serve(off.app)
      .post('/api/elearning/assessment/question-banks')
      .send({ title: 'Bank' })
    expect(offResponse.status).toBe(404)
    expect(offResponse.body).toEqual({})
    expect(off.adminCalls).toBe(0)
    expect(off.bankCalls).toEqual([])

    const env = { ...FLAG_ON } as unknown as NodeJS.ProcessEnv
    const changed = makeApp({ env })
    env.ELEARNING_ASSESSMENT_ENABLED = 'false'
    const changedResponse = await serve(changed.app)
      .post('/api/elearning/assessment/question-banks')
      .send({ title: 'Bank' })
    expect(changedResponse.status).toBe(404)
    expect(changedResponse.body).toEqual({ error: 'not_found' })
    expect(changed.adminCalls).toBe(0)
    expect(changed.bankCalls).toEqual([])
  })

  test('identity, authoritative org, and admin RBAC run before JSON/service', async () => {
    const unauthenticated = makeApp({ viewer: null })
    const unauthenticatedResponse = await serve(unauthenticated.app)
      .post('/api/elearning/assessment/question-banks')
      .set('content-type', 'application/json')
      .send('{')
    expect(unauthenticatedResponse.status).toBe(401)
    expect(unauthenticatedResponse.body).toEqual({ error: 'unauthenticated' })
    expect(unauthenticated.adminCalls).toBe(0)

    const noOrg = makeApp({ org: null })
    const noOrgResponse = await serve(noOrg.app)
      .post('/api/elearning/assessment/question-banks')
      .set('content-type', 'application/json')
      .send('{')
    expect(noOrgResponse.status).toBe(403)
    expect(noOrgResponse.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrg.adminCalls).toBe(0)

    const forbidden = makeApp({ hasAdmin: false })
    const forbiddenResponse = await serve(forbidden.app)
      .post('/api/elearning/assessment/question-banks')
      .set('content-type', 'application/json')
      .send('{')
    expect(forbiddenResponse.status).toBe(403)
    expect(forbiddenResponse.body).toEqual({ error: 'Insufficient permissions' })
    expect(forbidden.adminCalls).toBe(1)
    expect(forbidden.bankCalls).toEqual([])
  })

  test('mounts all five closed admin writes and injects org/actor', async () => {
    const testApp = makeApp()
    const bank = await serve(testApp.app)
      .post('/api/elearning/assessment/question-banks')
      .send({ title: 'Safety bank' })
    const question = await serve(testApp.app)
      .post(`/api/elearning/assessment/question-banks/${BANK_ID}/questions`)
      .send({ question: QUESTION })
    const revision = await serve(testApp.app)
      .post(`/api/elearning/assessment/questions/${QUESTION_ID}/revisions`)
      .send({ question: { ...QUESTION, prompt: 'Choose again' } })
    const paper = await serve(testApp.app)
      .post('/api/elearning/assessment/papers')
      .send({
        title: 'Safety paper',
        items: [{ questionRevisionId: REVISION_ID, points: 5 }],
      })
    const exam = await serve(testApp.app)
      .post('/api/elearning/assessment/exams')
      .send(EXAM_BODY)

    expect(bank.status).toBe(201)
    expect(bank.body).toEqual({ bankId: BANK_ID })
    expect(question.status).toBe(201)
    expect(question.body).toEqual({
      questionId: QUESTION_ID,
      questionRevisionId: REVISION_ID,
      revision: 1,
    })
    expect(revision.status).toBe(201)
    expect(revision.body).toEqual({
      questionId: QUESTION_ID,
      questionRevisionId: REVISION_ID,
      revision: 2,
    })
    expect(paper.status).toBe(201)
    expect(paper.body).toEqual({
      paperId: PAPER_ID,
      status: 'published',
      itemCount: 1,
      totalPoints: 5,
    })
    expect(exam.status).toBe(201)
    expect(exam.body).toEqual({
      examId: EXAM_ID,
      paperId: PAPER_ID,
      status: 'published',
      totalPoints: 5,
    })
    expect(testApp.bankCalls).toEqual([{ orgId: ORG, actorId: ACTOR, title: 'Safety bank' }])
    expect(testApp.questionCalls[0]).toMatchObject({ orgId: ORG, actorId: ACTOR, bankId: BANK_ID })
    expect(testApp.revisionCalls[0]).toMatchObject({ orgId: ORG, actorId: ACTOR, questionId: QUESTION_ID })
    expect(testApp.paperCalls[0]).toEqual({
      orgId: ORG,
      actorId: ACTOR,
      title: 'Safety paper',
      items: [{ questionRevisionId: REVISION_ID, points: 5 }],
    })
    expect(testApp.examCalls).toEqual([{ orgId: ORG, actorId: ACTOR, ...EXAM_BODY }])
    const responses = JSON.stringify([
      bank.body,
      question.body,
      revision.body,
      paper.body,
      exam.body,
    ])
    expect(responses).not.toMatch(/correctOptionIds|answerKey|explanation/)
  })

  test('rejects unknown top-level identity fields, bad ids, and oversized JSON before service', async () => {
    const testApp = makeApp()
    const arrayBody = await serve(testApp.app)
      .post('/api/elearning/assessment/question-banks')
      .send([])
    expect(arrayBody.status).toBe(400)
    expect(arrayBody.body).toEqual({ error: 'invalid_input' })

    const missingBody = await serve(testApp.app)
      .post('/api/elearning/assessment/question-banks')
    expect(missingBody.status).toBe(400)
    expect(missingBody.body).toEqual({ error: 'invalid_input' })

    const unknown = await serve(testApp.app)
      .post('/api/elearning/assessment/question-banks')
      .send({ title: 'Bank', orgId: 'client-org', actorId: 'client-actor' })
    expect(unknown.status).toBe(400)
    expect(unknown.body).toEqual({ error: 'invalid_input' })

    const badId = await serve(testApp.app)
      .post('/api/elearning/assessment/question-banks/not-a-uuid/questions')
      .send({ question: QUESTION })
    expect(badId.status).toBe(400)
    expect(badId.body).toEqual({ error: 'invalid_input' })

    const oversized = await serve(testApp.app)
      .post('/api/elearning/assessment/question-banks')
      .send({ title: 'x'.repeat(1024 * 1024 + 1) })
    expect(oversized.status).toBe(413)
    expect(oversized.body).toEqual({ error: 'payload_too_large' })
    expect(testApp.bankCalls).toEqual([])
    expect(testApp.questionCalls).toEqual([])
  })

  test.each([
    ['invalid_input', 400],
    ['not_found', 404],
    ['unavailable', 503],
  ] as const)('maps catalog %s without values', async (code, status) => {
    const testApp = makeApp({ catalogError: new ElearningAssessmentCatalogError(code) })
    const response = await serve(testApp.app)
      .post('/api/elearning/assessment/question-banks')
      .send({ title: 'Bank' })
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ error: code })
    expect(JSON.stringify(response.body)).not.toContain('Bank')
  })

  test.each([
    ['invalid_input', 400],
    ['not_found', 404],
    ['unavailable', 503],
  ] as const)('maps paper-exam %s without values', async (code, status) => {
    const testApp = makeApp({ examError: new ElearningPaperExamError(code) })
    const response = await serve(testApp.app)
      .post('/api/elearning/assessment/exams')
      .send(EXAM_BODY)
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ error: code })
    expect(JSON.stringify(response.body)).not.toContain(EXAM_BODY.title)
  })
})

describe('fixed-paper item limit', () => {
  test('accepts 200 items and rejects 201 before opening a transaction', async () => {
    expect(ELEARNING_FIXED_PAPER_ITEM_MAX).toBe(200)
    const revisionIds = Array.from(
      { length: ELEARNING_FIXED_PAPER_ITEM_MAX + 1 },
      () => randomUUID(),
    )
    const questionIds = revisionIds.map(() => randomUUID())
    let transactionCalls = 0
    const db: ElearningAssessmentCatalogDb = {
      transaction: async (handler) => {
        transactionCalls += 1
        return handler({
          query: async (sql) => {
            if (sql.includes('load-paper-revisions')) {
              return {
                rows: revisionIds.slice(0, ELEARNING_FIXED_PAPER_ITEM_MAX).map(
                  (id, index) => ({ id, question_id: questionIds[index] }),
                ),
                rowCount: ELEARNING_FIXED_PAPER_ITEM_MAX,
              }
            }
            if (sql.includes('publish-paper')) {
              return { rows: [{ id: PAPER_ID }], rowCount: 1 }
            }
            return { rows: [], rowCount: 1 }
          },
        })
      },
    }
    const makeInput = (count: number): PublishElearningFixedPaperInput => ({
      orgId: ORG,
      actorId: ACTOR,
      title: 'Bounded paper',
      items: revisionIds.slice(0, count).map((questionRevisionId) => ({
        questionRevisionId,
        points: 1,
      })),
    })

    await expect(
      publishElearningFixedPaper(db, makeInput(ELEARNING_FIXED_PAPER_ITEM_MAX)),
    ).resolves.toMatchObject({
      status: 'published',
      itemCount: ELEARNING_FIXED_PAPER_ITEM_MAX,
      totalPoints: ELEARNING_FIXED_PAPER_ITEM_MAX,
    })
    expect(transactionCalls).toBe(1)

    await expect(
      publishElearningFixedPaper(
        db,
        makeInput(ELEARNING_FIXED_PAPER_ITEM_MAX + 1),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(transactionCalls).toBe(1)
  })
})
