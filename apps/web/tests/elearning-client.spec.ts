import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  acknowledgeElearningWatchChallenge,
  assignElearningDirect,
  elearningPlaybackSourceUrl,
  ElearningApiError,
  getElearningCapabilities,
  isElearningV01Ready,
  isElearningLearnerReady,
  issueElearningPlaybackTicket,
  listMyElearningCourses,
  publishElearningCourse,
  sendElearningHeartbeat,
  saveElearningExamAnswers,
  startElearningExam,
  startElearningWatch,
  submitElearningExam,
  uploadElearningMedia,
} from '../src/services/elearning'
import {
  createElearningQuestionBank,
  ELEARNING_ASSESSMENT_XLSX_MIME,
  importElearningQuestionBankXlsx,
  isElearningAssessmentAdminReady,
  listElearningBankQuestions,
  listElearningQuestionBanks,
  publishElearningFixedPaper,
  publishElearningPaperExam,
} from '../src/services/elearningAssessmentAdmin'

const COURSE = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'
const VIDEO = '33333333-3333-4333-8333-333333333333'
const EXAM_ITEM = '44444444-4444-4444-8444-444444444444'
const EXAM = '55555555-5555-4555-8555-555555555555'
const MEDIA = '66666666-6666-4666-8666-666666666666'
const SESSION = '77777777-7777-4777-8777-777777777777'
const ATTEMPT = '88888888-8888-4888-8888-888888888888'
const Q1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const Q2 = '99999999-9999-4999-8999-999999999999'
const ASSIGNMENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const REQUEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CHALLENGE = 'abababab-abab-4bab-8bab-abababababab'
const CHALLENGE_OPTIONS = [
  { optionId: '10101010-1010-4010-8010-101010101010', label: '●1' },
  { optionId: '20202020-2020-4020-8020-202020202020', label: '▲2' },
  { optionId: '30303030-3030-4030-8030-303030303030', label: '■3' },
  { optionId: '40404040-4040-4040-8040-404040404040', label: '◆4' },
  { optionId: '50505050-5050-4050-8050-505050505050', label: '★5' },
  { optionId: '60606060-6060-4060-8060-606060606060', label: '♥6' },
] as const
const CHALLENGE_SELECTIONS = [
  CHALLENGE_OPTIONS[1].optionId,
  CHALLENGE_OPTIONS[4].optionId,
] as const
const BANK = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const PAPER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const SHA256 = 'ab'.repeat(32)
const CREATED_AT = '2026-08-26T00:00:00.000Z'
const NONCANONICAL_AT = '2026-08-26T00:00:00Z'
const IMPOSSIBLE_AT = '2026-02-31T00:00:00.000Z'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function lastCall(): { path: string; options: RequestInit } {
  const [path, options] = apiFetchMock.mock.calls.at(-1) ?? []
  return { path: String(path), options: (options ?? {}) as RequestInit }
}

function lastJson(): Record<string, unknown> {
  const { options } = lastCall()
  return JSON.parse(String(options.body ?? '{}')) as Record<string, unknown>
}

function assertNoIdentityOverrides(value: unknown): void {
  const blob = JSON.stringify(value)
  expect(blob).not.toMatch(/"orgId"|"actorId"|"userId"|"org"|"user"/)
}

function watchState(over: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    status: 'in_progress',
    lastSequence: 1,
    lastClientPositionMs: 0,
    effectiveMs: 0,
    maxPositionMs: 0,
    durationMs: 5000,
    creditedMs: 0,
    duplicate: false,
    ...over,
  }
}

function watchChallenge(over: Record<string, unknown> = {}) {
  return {
    challengeId: CHALLENGE,
    deadlineAt: CREATED_AT,
    ordinal: 2,
    status: 'challenged',
    promptVersion: 'symbol-number-v1',
    targets: [CHALLENGE_OPTIONS[1].label, CHALLENGE_OPTIONS[4].label],
    options: CHALLENGE_OPTIONS,
    ...over,
  }
}

function learnerCourse(over: Record<string, unknown> = {}) {
  return {
    courseId: COURSE,
    courseVersionId: VERSION,
    title: '示范课',
    access: { kind: 'assignment', required: true },
    assignment: { deadline: null, assignedAt: '2026-01-02T03:04:05.000Z' },
    video: {
      itemId: VIDEO,
      durationMs: 5000,
      status: 'not_started',
      effectiveMs: 0,
      maxPositionMs: 0,
      completedAt: null,
    },
    exam: { itemId: EXAM_ITEM, latestAttempt: null },
    completed: false,
    ...over,
  }
}

function latestAttempt(over: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT,
    attemptNo: 1,
    status: 'graded',
    autoScore: 10,
    totalScore: 10,
    passed: true,
    startedAt: CREATED_AT,
    submittedAt: CREATED_AT,
    gradedAt: CREATED_AT,
    ...over,
  }
}

function examStartResult(over: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT,
    attemptNo: 1,
    status: 'started',
    paper: paper(),
    answers: { [Q1]: [] },
    deadlineAt: CREATED_AT,
    duplicate: false,
    ...over,
  }
}

function playbackTicket(over: Record<string, unknown> = {}) {
  return {
    token: 'tok.en',
    expiresAt: CREATED_AT,
    ttlSeconds: 600,
    itemId: VIDEO,
    mediaId: MEDIA,
    ...over,
  }
}

function paper() {
  return {
    domain: 'elearning.exam.paper.v1',
    version: 1,
    questions: [{
      position: 1,
      questionRevisionId: Q1,
      questionType: 'single_choice',
      prompt: 'Pick one',
      options: [
        { id: 'a', text: 'alpha' },
        { id: 'b', text: 'beta' },
      ],
      points: 10,
    }],
  }
}

function mixedPaper() {
  return {
    domain: 'elearning.exam.paper.v1',
    version: 2,
    questions: [
      ...paper().questions,
      {
        position: 2,
        questionRevisionId: Q2,
        questionType: 'short_answer',
        prompt: 'Explain briefly',
        options: [],
        points: 10,
      },
    ],
  }
}

function capabilitiesDto(over: Record<string, unknown> = {}, flags: Record<string, unknown> = {}) {
  return {
    enabled: true,
    capabilities: {
      content: true,
      assignment: true,
      assessment: true,
      incentive: false,
      analytics: false,
      media: true,
      ...flags,
    },
    ...over,
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('elearning client transport', () => {
  it('uploads multipart with only the file field and no identity overrides', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(201, {
      id: MEDIA,
      status: 'ready',
      durationMs: 4500,
      sizeBytes: 12,
      sha256: SHA256,
    }))
    const file = new File([new Uint8Array([1, 2, 3])], 'demo.mp4', { type: 'video/mp4' })
    const result = await uploadElearningMedia(file)
    const { path, options } = lastCall()
    expect(path).toBe('/api/elearning/media')
    expect(options.method).toBe('POST')
    expect(options.body).toBeInstanceOf(FormData)
    expect([...(options.body as FormData).keys()]).toEqual(['file'])
    expect((options.body as FormData).get('file')).toBe(file)
    expect(JSON.stringify(options)).not.toMatch(/orgId|userId|actorId/)
    expect(result).toEqual({
      id: MEDIA,
      status: 'ready',
      durationMs: 4500,
      sizeBytes: 12,
      sha256: SHA256,
    })
  })

  it('publishes without org/user overrides and validates the public result', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(201, {
      courseId: COURSE,
      courseVersionId: VERSION,
      videoItemId: VIDEO,
      examItemId: EXAM_ITEM,
      examId: EXAM,
      status: 'published',
      questionCount: 1,
      totalScore: 10,
    }))
    const body = {
      requestId: REQUEST,
      title: '示范课',
      mediaId: MEDIA,
      passScore: 6,
      maxAttempts: 2,
      questions: [{
        questionType: 'single_choice' as const,
        prompt: 'Pick',
        options: [
          { id: 'a', text: 'alpha' },
          { id: 'b', text: 'beta' },
        ],
        correctOptionIds: ['a'],
        points: 10,
      }],
    }
    await publishElearningCourse(body)
    const { path, options } = lastCall()
    expect(path).toBe('/api/elearning/courses/publish')
    expect(options.method).toBe('POST')
    expect(lastJson()).toEqual(body)
    assertNoIdentityOverrides(lastJson())
  })

  it('assigns with optional deadline only and no identity overrides', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(201, {
      assignmentId: ASSIGNMENT,
      memberId: MEMBER,
      duplicate: false,
    }))
    await assignElearningDirect({
      targetUserId: 'user-1',
      courseVersionId: VERSION,
      sourceKey: REQUEST,
      deadline: '2026-08-25T12:00:00.000Z',
    })
    expect(lastCall().path).toBe('/api/elearning/assignments/direct')
    expect(lastJson()).toEqual({
      targetUserId: 'user-1',
      courseVersionId: VERSION,
      sourceKey: REQUEST,
      deadline: '2026-08-25T12:00:00.000Z',
    })
    assertNoIdentityOverrides(lastJson())
  })

  it('lists learner courses from GET /api/elearning/me/courses with the exact DTO', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { courses: [learnerCourse()] }))
    const result = await listMyElearningCourses()
    expect(lastCall().path).toBe('/api/elearning/me/courses')
    expect(lastCall().options.method).toBe('GET')
    expect(lastCall().options.body).toBeUndefined()
    expect(result.courses).toHaveLength(1)
    expect(result.courses[0]?.courseId).toBe(COURSE)
    expect(JSON.stringify(result)).not.toMatch(/answerKey|explanation|storageKey|storage_key|"correct"/)
  })

  it('accepts visible self-study without fabricating an assignment', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      courses: [learnerCourse({
        access: { kind: 'visibility', required: false },
        assignment: null,
      })],
    }))
    const result = await listMyElearningCourses()
    expect(result.courses[0]?.access).toEqual({ kind: 'visibility', required: false })
    expect(result.courses[0]?.assignment).toBeNull()
  })

  it('accepts an awaiting-manual latest attempt without fabricating a final score', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      courses: [learnerCourse({
        exam: {
          itemId: EXAM_ITEM,
          latestAttempt: {
            attemptId: ATTEMPT,
            attemptNo: 1,
            status: 'awaiting_manual',
            autoScore: 6,
            totalScore: null,
            passed: null,
            startedAt: '2026-01-04T05:06:07.000Z',
            submittedAt: '2026-01-04T05:16:07.000Z',
            gradedAt: null,
          },
        },
      })],
    }))
    const result = await listMyElearningCourses()
    expect(result.courses[0]?.exam.latestAttempt).toMatchObject({
      status: 'awaiting_manual',
      autoScore: 6,
      totalScore: null,
      passed: null,
    })
  })

  it('starts watch and playback ticket with empty JSON bodies', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(200, watchState()))
      .mockResolvedValueOnce(jsonResponse(200, {
        token: 'tok.en',
        expiresAt: '2026-08-25T12:10:00.000Z',
        ttlSeconds: 600,
        itemId: VIDEO,
        mediaId: MEDIA,
      }))
    await startElearningWatch(VIDEO)
    expect(lastCall().path).toBe(`/api/elearning/watch/items/${VIDEO}/start`)
    expect(lastJson()).toEqual({})
    assertNoIdentityOverrides(lastJson())
    await issueElearningPlaybackTicket(VIDEO)
    expect(lastCall().path).toBe(`/api/elearning/watch/items/${VIDEO}/playback-ticket`)
    expect(lastJson()).toEqual({})
  })

  it('accepts canonical timestamps across exam, attempt, video, assignment, and playback DTOs', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        courses: [learnerCourse({
          assignment: { deadline: CREATED_AT, assignedAt: CREATED_AT },
          video: {
            ...learnerCourse().video,
            status: 'completed',
            completedAt: CREATED_AT,
          },
          exam: {
            itemId: EXAM_ITEM,
            latestAttempt: latestAttempt(),
          },
        })],
      }))
      .mockResolvedValueOnce(jsonResponse(200, examStartResult()))
      .mockResolvedValueOnce(jsonResponse(200, playbackTicket()))

    await expect(listMyElearningCourses()).resolves.toMatchObject({
      courses: [{
        assignment: { deadline: CREATED_AT, assignedAt: CREATED_AT },
        video: { completedAt: CREATED_AT },
        exam: {
          latestAttempt: {
            startedAt: CREATED_AT,
            submittedAt: CREATED_AT,
            gradedAt: CREATED_AT,
          },
        },
      }],
    })
    await expect(startElearningExam(EXAM_ITEM)).resolves.toMatchObject({ deadlineAt: CREATED_AT })
    await expect(issueElearningPlaybackTicket(VIDEO)).resolves.toMatchObject({ expiresAt: CREATED_AT })
  })

  it.each([
    ['exam deadline', (bad: string) => ({
      body: examStartResult({ deadlineAt: bad }),
      request: () => startElearningExam(EXAM_ITEM),
    })],
    ['latest attempt start', (bad: string) => ({
      body: { courses: [learnerCourse({
        exam: {
          itemId: EXAM_ITEM,
          latestAttempt: latestAttempt({ startedAt: bad }),
        },
      })] },
      request: () => listMyElearningCourses(),
    })],
    ['latest attempt submit', (bad: string) => ({
      body: { courses: [learnerCourse({
        exam: {
          itemId: EXAM_ITEM,
          latestAttempt: latestAttempt({ submittedAt: bad }),
        },
      })] },
      request: () => listMyElearningCourses(),
    })],
    ['latest attempt grade', (bad: string) => ({
      body: { courses: [learnerCourse({
        exam: {
          itemId: EXAM_ITEM,
          latestAttempt: latestAttempt({ gradedAt: bad }),
        },
      })] },
      request: () => listMyElearningCourses(),
    })],
    ['video completion', (bad: string) => ({
      body: { courses: [learnerCourse({
        video: {
          ...learnerCourse().video,
          status: 'completed',
          completedAt: bad,
        },
      })] },
      request: () => listMyElearningCourses(),
    })],
    ['assignment deadline', (bad: string) => ({
      body: { courses: [learnerCourse({
        assignment: { deadline: bad, assignedAt: CREATED_AT },
      })] },
      request: () => listMyElearningCourses(),
    })],
    ['assignment creation', (bad: string) => ({
      body: { courses: [learnerCourse({
        assignment: { deadline: null, assignedAt: bad },
      })] },
      request: () => listMyElearningCourses(),
    })],
    ['playback expiry', (bad: string) => ({
      body: playbackTicket({ expiresAt: bad }),
      request: () => issueElearningPlaybackTicket(VIDEO),
    })],
  ])('rejects a noncanonical or impossible %s timestamp', async (_label, makeCase) => {
    for (const bad of [NONCANONICAL_AT, IMPOSSIBLE_AT]) {
      const { body, request } = makeCase(bad)
      apiFetchMock.mockResolvedValueOnce(jsonResponse(200, body))
      await expect(request()).rejects.toMatchObject({ code: 'invalid_response', status: 200 })
    }
  })

  it('sends heartbeat monotonic fields only', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, watchState({ lastSequence: 2, lastClientPositionMs: 1000 })))
    await sendElearningHeartbeat(SESSION, { sequence: 2, positionMs: 1000, playing: true })
    expect(lastCall().path).toBe(`/api/elearning/watch/sessions/${SESSION}/heartbeat`)
    expect(lastJson()).toEqual({ sequence: 2, positionMs: 1000, playing: true })
    assertNoIdentityOverrides(lastJson())
  })

  it('parses the closed challenge prompt and acks with ordered selections', async () => {
    const challenge = watchChallenge()
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(200, watchState({ challenge })))
      .mockResolvedValueOnce(jsonResponse(200, watchState({
        challenge: null,
        duplicate: false,
      })))
    await expect(sendElearningHeartbeat(SESSION, {
      sequence: 2,
      positionMs: 1000,
      playing: true,
    })).resolves.toMatchObject({ challenge })
    await expect(acknowledgeElearningWatchChallenge(
      SESSION,
      CHALLENGE,
      REQUEST,
      CHALLENGE_SELECTIONS,
    )).resolves.toMatchObject({ challenge: null })
    expect(lastCall().path).toBe(
      `/api/elearning/watch/sessions/${SESSION}/challenges/${CHALLENGE}/ack`,
    )
    expect(lastJson()).toEqual({ requestId: REQUEST, selections: CHALLENGE_SELECTIONS })
    assertNoIdentityOverrides(lastJson())
  })

  it.each([
    ['extra challenge key', { challenge: watchChallenge({ extra: true }) }],
    ['invalid challenge timestamp', { challenge: watchChallenge({ deadlineAt: IMPOSSIBLE_AT }) }],
    ['invalid challenge ordinal', { challenge: watchChallenge({ ordinal: 0 }) }],
    ['invalid challenge status', { challenge: watchChallenge({ status: 'unknown' }) }],
    ['unknown prompt version', { challenge: watchChallenge({ promptVersion: 'unknown' }) }],
    ['duplicate option id', { challenge: watchChallenge({ options: CHALLENGE_OPTIONS.map((option, index) => index === 5 ? { ...option, optionId: CHALLENGE_OPTIONS[0].optionId } : option) }) }],
    ['missing target option', { challenge: watchChallenge({ targets: ['☂9', CHALLENGE_OPTIONS[4].label] }) }],
    ['challenge on completed watch', { status: 'completed', challenge: watchChallenge() }],
  ])('rejects %s in a watch response', async (_label, over) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, watchState(over)))
    await expect(startElearningWatch(VIDEO)).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('starts an exam and submits answers without identity overrides', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        attemptId: ATTEMPT,
        attemptNo: 1,
        status: 'started',
        paper: paper(),
        answers: { [Q1]: [] },
        deadlineAt: '2026-08-26T09:30:00.000Z',
        duplicate: false,
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        attemptId: ATTEMPT,
        attemptNo: 1,
        status: 'graded',
        autoScore: 10,
        totalScore: 10,
        passed: true,
        duplicate: false,
      }))
    const started = await startElearningExam(EXAM_ITEM)
    expect(lastCall().path).toBe(`/api/elearning/exams/items/${EXAM_ITEM}/start`)
    expect(lastJson()).toEqual({})
    expect(started.paper.questions[0]).not.toHaveProperty('answerKey')
    expect(started.answers).toEqual({ [Q1]: [] })
    expect(started.deadlineAt).toBe('2026-08-26T09:30:00.000Z')
    expect(Object.keys(started)).toEqual([
      'attemptId',
      'attemptNo',
      'status',
      'paper',
      'answers',
      'deadlineAt',
      'duplicate',
    ])
    await submitElearningExam(ATTEMPT, { [Q1]: ['a'] })
    expect(lastCall().path).toBe(`/api/elearning/exams/attempts/${ATTEMPT}/submit`)
    expect(lastJson()).toEqual({ answers: { [Q1]: ['a'] } })
    assertNoIdentityOverrides(lastJson())
  })

  it('saves draft answers with PUT and parses the closed started DTO', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      paper: paper(),
      answers: { [Q1]: ['a'] },
      deadlineAt: null,
      duplicate: false,
    }))
    const saved = await saveElearningExamAnswers(ATTEMPT, { [Q1]: ['a'] })
    expect(lastCall().path).toBe(`/api/elearning/exams/attempts/${ATTEMPT}/answers`)
    expect(lastCall().options.method).toBe('PUT')
    expect(lastJson()).toEqual({ answers: { [Q1]: ['a'] } })
    assertNoIdentityOverrides(lastJson())
    expect(saved).toEqual({
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      paper: paper(),
      answers: { [Q1]: ['a'] },
      deadlineAt: null,
      duplicate: false,
    })
    expect(JSON.stringify(saved)).not.toMatch(/answerKey|explanation|storageKey|storage_key|"correct"/)
  })

  it('parses mixed-paper starts, string drafts, and awaiting-manual submits', async () => {
    const answers = { [Q1]: ['a'], [Q2]: 'manual answer' }
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        attemptId: ATTEMPT,
        attemptNo: 1,
        status: 'started',
        paper: mixedPaper(),
        answers,
        deadlineAt: null,
        duplicate: false,
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        attemptId: ATTEMPT,
        attemptNo: 1,
        status: 'started',
        paper: mixedPaper(),
        answers,
        deadlineAt: null,
        duplicate: true,
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        attemptId: ATTEMPT,
        attemptNo: 1,
        status: 'awaiting_manual',
        autoScore: 10,
        totalScore: 20,
        passed: null,
        duplicate: false,
      }))

    const started = await startElearningExam(EXAM_ITEM)
    expect(started.paper.version).toBe(2)
    expect(started.paper.questions[1]).toMatchObject({
      questionType: 'short_answer',
      options: [],
    })
    expect(started.answers).toEqual(answers)
    await expect(saveElearningExamAnswers(ATTEMPT, answers)).resolves.toMatchObject({
      answers,
      duplicate: true,
    })
    await expect(submitElearningExam(ATTEMPT, answers)).resolves.toEqual({
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'awaiting_manual',
      autoScore: 10,
      totalScore: 20,
      passed: null,
      duplicate: false,
    })
    expect(lastJson()).toEqual({ answers })
  })

  it('rejects cross-version papers and malformed short-answer response shapes', async () => {
    for (const responsePaper of [
      { ...mixedPaper(), version: 1 },
      { ...paper(), version: 2 },
      {
        ...mixedPaper(),
        questions: [
          mixedPaper().questions[0],
          { ...mixedPaper().questions[1], options: [{ id: 'x', text: 'invalid' }] },
        ],
      },
    ]) {
      apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
        attemptId: ATTEMPT,
        attemptNo: 1,
        status: 'started',
        paper: responsePaper,
        answers: { [Q1]: [], [Q2]: '' },
        deadlineAt: null,
        duplicate: false,
      }))
      await expect(startElearningExam(EXAM_ITEM)).rejects.toMatchObject({
        code: 'invalid_response',
        status: 200,
      })
    }
  })

  it('builds a same-origin playback source from the ticket token', () => {
    expect(elearningPlaybackSourceUrl('tok+en/1')).toBe(
      '/api/elearning/media/playback?token=tok%2Ben%2F1',
    )
  })

  it('lists assessment banks and accepts closed admin-only answer material', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        items: [{
          bankId: BANK,
          title: 'Safety bank',
          questionCount: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        }],
        page: 1,
        pageSize: 50,
        total: 1,
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        bank: { bankId: BANK, title: 'Safety bank' },
        items: [{
          questionId: COURSE,
          questionRevisionId: Q1,
          revision: 2,
          questionType: 'single_choice',
          prompt: 'Pick one',
          options: [
            { id: 'a', text: 'Alpha' },
            { id: 'b', text: 'Beta' },
          ],
          correctOptionIds: ['a'],
          points: 5,
          explanation: 'Admin answer explanation',
          createdAt: CREATED_AT,
        }],
        page: 1,
        pageSize: 100,
        total: 1,
      }))

    const banks = await listElearningQuestionBanks()
    expect(lastCall()).toMatchObject({
      path: '/api/elearning/assessment/question-banks?page=1&pageSize=50',
      options: { method: 'GET' },
    })
    expect(banks.items[0]).toEqual({
      bankId: BANK,
      title: 'Safety bank',
      questionCount: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })

    const questions = await listElearningBankQuestions(BANK)
    expect(lastCall()).toMatchObject({
      path: `/api/elearning/assessment/question-banks/${BANK}/questions?page=1&pageSize=100`,
      options: { method: 'GET' },
    })
    expect(questions.items[0]).toMatchObject({
      questionRevisionId: Q1,
      correctOptionIds: ['a'],
      explanation: 'Admin answer explanation',
    })
  })

  it('creates a bank and imports the raw XLSX body with the exact media type', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(201, { bankId: BANK }))
      .mockResolvedValueOnce(jsonResponse(201, { importedCount: 2 }))

    await createElearningQuestionBank('Safety bank')
    expect(lastCall().path).toBe('/api/elearning/assessment/question-banks')
    expect(lastCall().options.method).toBe('POST')
    expect(lastJson()).toEqual({ title: 'Safety bank' })
    assertNoIdentityOverrides(lastJson())

    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'questions.xlsx', {
      type: ELEARNING_ASSESSMENT_XLSX_MIME,
    })
    const imported = await importElearningQuestionBankXlsx(BANK, file)
    expect(lastCall().path).toBe(`/api/elearning/assessment/question-banks/${BANK}/import`)
    expect(lastCall().options.method).toBe('POST')
    expect(lastCall().options.body).toBe(file)
    expect(new Headers(lastCall().options.headers).get('Content-Type')).toBe(
      ELEARNING_ASSESSMENT_XLSX_MIME,
    )
    expect(imported).toEqual({ importedCount: 2 })
  })

  it('publishes a fixed paper and a paper exam with explicit nullable fields', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(201, {
        paperId: PAPER_ID,
        status: 'published',
        itemCount: 1,
        totalPoints: 5,
      }))
      .mockResolvedValueOnce(jsonResponse(201, {
        examId: EXAM,
        paperId: PAPER_ID,
        status: 'published',
        totalPoints: 5,
      }))

    await publishElearningFixedPaper({
      title: 'Safety paper',
      items: [{ questionRevisionId: Q1, points: 5 }],
    })
    expect(lastCall().path).toBe('/api/elearning/assessment/papers')
    expect(lastJson()).toEqual({
      title: 'Safety paper',
      items: [{ questionRevisionId: Q1, points: 5 }],
    })
    assertNoIdentityOverrides(lastJson())

    await publishElearningPaperExam({
      paperId: PAPER_ID,
      title: 'Safety exam',
      passScore: 3,
      maxAttempts: 2,
      windowStartsAt: null,
      windowEndsAt: null,
      durationSeconds: null,
      shuffleQuestions: true,
      shuffleOptions: false,
      disclosurePolicy: 'correctness_after_submit',
    })
    expect(lastCall().path).toBe('/api/elearning/assessment/exams')
    expect(lastJson()).toEqual({
      paperId: PAPER_ID,
      title: 'Safety exam',
      passScore: 3,
      maxAttempts: 2,
      windowStartsAt: null,
      windowEndsAt: null,
      durationSeconds: null,
      shuffleQuestions: true,
      shuffleOptions: false,
      disclosurePolicy: 'correctness_after_submit',
    })
    assertNoIdentityOverrides(lastJson())
  })

  it('derives assessment-admin readiness without requiring media or assignment', () => {
    expect(isElearningAssessmentAdminReady(capabilitiesDto({}, {
      assignment: false,
      media: false,
    }))).toBe(true)
    expect(isElearningAssessmentAdminReady(capabilitiesDto({}, {
      assessment: false,
    }))).toBe(false)
  })
})

describe('elearning client fail-closed validation', () => {
  it('rejects extra nested admin-question keys but preserves the authoritative org error', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      bank: { bankId: BANK, title: 'Safety bank' },
      items: [{
        questionId: COURSE,
        questionRevisionId: Q1,
        revision: 1,
        questionType: 'single_choice',
        prompt: 'Pick one',
        options: [
          { id: 'a', text: 'Alpha', storageKey: 'secret' },
          { id: 'b', text: 'Beta' },
        ],
        correctOptionIds: ['a'],
        points: 5,
        explanation: null,
        createdAt: CREATED_AT,
      }],
      page: 1,
      pageSize: 100,
      total: 1,
    }))
    await expect(listElearningBankQuestions(BANK)).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      bank: { bankId: BANK, title: 'Safety bank' },
      items: [{
        questionId: COURSE,
        questionRevisionId: Q1,
        revision: 1,
        questionType: 'single_choice',
        prompt: 'Pick one',
        options: [
          { id: 'a', text: 'Alpha' },
          { id: 'a', text: 'Duplicate' },
        ],
        correctOptionIds: ['a'],
        points: 5,
        explanation: null,
        createdAt: CREATED_AT,
      }],
      page: 1,
      pageSize: 100,
      total: 1,
    }))
    await expect(listElearningBankQuestions(BANK)).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'ORG_CONTEXT_REQUIRED' }))
    await expect(listElearningQuestionBanks()).rejects.toMatchObject({
      code: 'ORG_CONTEXT_REQUIRED',
      status: 403,
    })
  })

  it('rejects extra keys, missing keys, and secret fields on the learner DTO', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      courses: [learnerCourse()],
      orgId: 'evil-org',
    }))
    await expect(listMyElearningCourses()).rejects.toMatchObject({
      name: 'ElearningApiError',
      code: 'invalid_response',
      status: 200,
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      courses: [learnerCourse({ answerKey: { correct: ['a'] } })],
    }))
    await expect(listMyElearningCourses()).rejects.toMatchObject({ code: 'invalid_response', status: 200 })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      courses: [learnerCourse({
        video: {
          itemId: VIDEO,
          durationMs: 5000,
          status: 'not_started',
          effectiveMs: 0,
          maxPositionMs: 0,
          completedAt: null,
          storageKey: 'elearning-media/secret.mp4',
        },
      })],
    }))
    await expect(listMyElearningCourses()).rejects.toMatchObject({ code: 'invalid_response', status: 200 })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      courses: [learnerCourse({
        exam: {
          itemId: EXAM_ITEM,
          latestAttempt: {
            attemptId: ATTEMPT,
            attemptNo: 1,
            status: 'graded',
            autoScore: 10,
            totalScore: 10,
            passed: true,
            startedAt: '2026-01-04T05:06:07.000Z',
            submittedAt: '2026-01-04T05:16:07.000Z',
            gradedAt: '2026-01-04T05:16:08.000Z',
            explanation: 'secret',
          },
        },
      })],
    }))
    await expect(listMyElearningCourses()).rejects.toMatchObject({ code: 'invalid_response', status: 200 })
  })

  it('rejects contradictory learner access and assignment shapes', async () => {
    for (const course of [
      learnerCourse({ access: { kind: 'visibility', required: true }, assignment: null }),
      learnerCourse({ access: { kind: 'visibility', required: false } }),
      learnerCourse({ access: { kind: 'assignment', required: true }, assignment: null }),
      learnerCourse({ access: { kind: 'assignment', required: false } }),
    ]) {
      apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { courses: [course] }))
      await expect(listMyElearningCourses()).rejects.toMatchObject({
        code: 'invalid_response',
        status: 200,
      })
    }
  })

  it('rejects exam start payloads that include answerKey/correct/explanation', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      paper: {
        ...paper(),
        questions: [{
          ...paper().questions[0],
          answerKey: { correct: ['a'] },
          explanation: 'nope',
        }],
      },
      answers: { [Q1]: [] },
      deadlineAt: null,
      duplicate: false,
    }))
    await expect(startElearningExam(EXAM_ITEM)).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('rejects start/save DTOs that omit answers, add extra keys, or leak secrets', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      paper: paper(),
      deadlineAt: null,
      duplicate: false,
    }))
    await expect(startElearningExam(EXAM_ITEM)).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      paper: paper(),
      answers: { [Q1]: ['a'] },
      deadlineAt: null,
      duplicate: false,
      explanation: 'secret',
    }))
    await expect(saveElearningExamAnswers(ATTEMPT, { [Q1]: ['a'] })).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      paper: paper(),
      answers: { [Q1]: ['a'], extra: ['b'] },
      deadlineAt: null,
      duplicate: false,
    }))
    await expect(startElearningExam(EXAM_ITEM)).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('rejects a missing or non-string exam deadline snapshot', async () => {
    for (const deadline of [undefined, 42]) {
      const payload: Record<string, unknown> = {
        attemptId: ATTEMPT,
        attemptNo: 1,
        status: 'started',
        paper: paper(),
        answers: { [Q1]: [] },
        duplicate: false,
      }
      if (deadline !== undefined) payload.deadlineAt = deadline
      apiFetchMock.mockResolvedValueOnce(jsonResponse(200, payload))
      await expect(startElearningExam(EXAM_ITEM)).rejects.toMatchObject({
        code: 'invalid_response',
        status: 200,
      })
    }
  })

  it('converts HTTP 201 rejected media metadata to a stable ElearningApiError', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(201, {
      id: MEDIA,
      status: 'rejected',
      durationMs: null,
      sizeBytes: 12,
      sha256: SHA256,
    }))
    const file = new File([new Uint8Array([1, 2, 3])], 'demo.mp4', { type: 'video/mp4' })
    const error = await uploadElearningMedia(file).catch((cause) => cause)
    expect(error).toBeInstanceOf(ElearningApiError)
    expect(error).toMatchObject({
      name: 'ElearningApiError',
      code: 'rejected',
      status: 201,
      message: 'rejected',
    })
    expect(JSON.stringify(error)).not.toMatch(/storageKey|storage_key|orgId|userId/)
  })

  it('rejects malformed 201 media upload shapes as invalid_response', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'demo.mp4', { type: 'video/mp4' })
    const rejectUpload = async (body: Record<string, unknown>) => {
      apiFetchMock.mockResolvedValueOnce(jsonResponse(201, body))
      return uploadElearningMedia(file).catch((cause) => cause as ElearningApiError)
    }

    await expect(rejectUpload({
      id: MEDIA,
      status: 'ready',
      durationMs: 4500,
      sizeBytes: 0,
      sha256: SHA256,
    })).resolves.toMatchObject({
      name: 'ElearningApiError',
      code: 'invalid_response',
      status: 201,
    })
    await expect(rejectUpload({
      id: MEDIA,
      status: 'ready',
      durationMs: null,
      sizeBytes: 12,
      sha256: SHA256,
    })).resolves.toMatchObject({
      name: 'ElearningApiError',
      code: 'invalid_response',
      status: 201,
    })
    await expect(rejectUpload({
      id: MEDIA,
      status: 'rejected',
      durationMs: 4500,
      sizeBytes: 12,
      sha256: SHA256,
    })).resolves.toMatchObject({
      name: 'ElearningApiError',
      code: 'invalid_response',
      status: 201,
    })
  })

  it('exposes only stable error code and status', async () => {
    apiFetchMock.mockImplementation(() => Promise.resolve(jsonResponse(409, {
      error: 'prerequisite_incomplete',
      message: 'user-1 at 10.0.0.1 failed',
      stack: 'Error: secret',
    })))
    const error = await startElearningExam(EXAM_ITEM).catch((cause) => cause)
    expect(error).toBeInstanceOf(ElearningApiError)
    const apiError = error as ElearningApiError
    expect(apiError.code).toBe('prerequisite_incomplete')
    expect(apiError.status).toBe(409)
    expect(apiError.message).toBe('prerequisite_incomplete')
    expect(JSON.stringify(apiError)).not.toMatch(/10\.0\.0\.1|user-1|stack|secret/)
  })

  it('accepts only a bounded lowercase error code and otherwise uses request_failed', async () => {
    const rejectCode = async (body: unknown) => {
      apiFetchMock.mockResolvedValueOnce(jsonResponse(400, body))
      return listMyElearningCourses().catch((cause) => cause as ElearningApiError)
    }

    await expect(rejectCode({ error: 'NOT_FOUND' })).resolves.toMatchObject({
      code: 'request_failed',
      status: 400,
    })
    await expect(rejectCode({ error: 'feature-disabled' })).resolves.toMatchObject({
      code: 'request_failed',
      status: 400,
    })
    await expect(rejectCode({ error: 'not found' })).resolves.toMatchObject({
      code: 'request_failed',
      status: 400,
    })
    await expect(rejectCode({ error: { code: 'invalid_input' } })).resolves.toMatchObject({
      code: 'request_failed',
      status: 400,
    })
    await expect(rejectCode({ error: `a${'b'.repeat(63)}` })).resolves.toMatchObject({
      code: 'request_failed',
      status: 400,
    })
    await expect(rejectCode({ error: 'target_unavailable' })).resolves.toMatchObject({
      code: 'target_unavailable',
      status: 400,
    })
    await expect(rejectCode({ error: 'a'.repeat(63) })).resolves.toMatchObject({
      code: 'a'.repeat(63),
      status: 400,
    })
  })
})

describe('elearning capabilities client', () => {
  it('GETs /api/elearning/capabilities and parses the exact DTO', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, capabilitiesDto()))
    const result = await getElearningCapabilities()
    expect(lastCall().path).toBe('/api/elearning/capabilities')
    expect(lastCall().options.method).toBe('GET')
    expect(lastCall().options.body).toBeUndefined()
    expect(result).toEqual({
      enabled: true,
      capabilities: {
        content: true,
        assignment: true,
        assessment: true,
        incentive: false,
        analytics: false,
        media: true,
      },
    })
    assertNoIdentityOverrides(lastCall())
    expect(isElearningV01Ready(result)).toBe(true)
  })

  it('rejects extra keys, missing keys, and non-boolean capability flags', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, capabilitiesDto({ orgId: 'evil-org' })))
    await expect(getElearningCapabilities()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, capabilitiesDto({}, { extra: false })))
    await expect(getElearningCapabilities()).rejects.toMatchObject({ code: 'invalid_response', status: 200 })

    const { media: _media, ...missingMedia } = capabilitiesDto().capabilities as Record<string, unknown>
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { enabled: true, capabilities: missingMedia }))
    await expect(getElearningCapabilities()).rejects.toMatchObject({ code: 'invalid_response', status: 200 })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, capabilitiesDto({}, { media: 'true' })))
    await expect(getElearningCapabilities()).rejects.toMatchObject({ code: 'invalid_response', status: 200 })
  })

  it('treats V0.1 readiness as enabled plus content/assignment/assessment/media only', () => {
    const parkedOff = capabilitiesDto() as {
      enabled: boolean
      capabilities: {
        content: boolean
        assignment: boolean
        assessment: boolean
        incentive: boolean
        analytics: boolean
        media: boolean
      }
    }
    expect(isElearningV01Ready(parkedOff)).toBe(true)
    expect(isElearningV01Ready(capabilitiesDto({ enabled: false }) as typeof parkedOff)).toBe(false)
    expect(isElearningV01Ready(capabilitiesDto({}, { media: false }) as typeof parkedOff)).toBe(false)
    expect(isElearningV01Ready(capabilitiesDto({}, { assignment: false, incentive: true, analytics: true }) as typeof parkedOff)).toBe(false)
    expect(isElearningV01Ready(capabilitiesDto({}, { incentive: true, analytics: true }) as typeof parkedOff)).toBe(true)
    expect(isElearningLearnerReady(parkedOff)).toBe(true)
    expect(isElearningLearnerReady(
      capabilitiesDto({}, { assignment: false }) as typeof parkedOff,
    )).toBe(true)
    expect(isElearningLearnerReady(
      capabilitiesDto({}, { assessment: false }) as typeof parkedOff,
    )).toBe(false)
  })
})
